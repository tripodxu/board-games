#!/usr/bin/env node
/**
 * scripts/loss-report.mjs — 败局解释（AGENTS.md 规则 11）
 *
 * 回答一个问题：**「这批对局是怎么输的？」**
 * 形态（我方最后一手走的哪一层、怎么终局、手数分布）+ 追因（从哪一手起此后每一步都仍然必败）。
 * 归纳逻辑在 `scripts/lib/loss-report.mjs`（纯函数、有单测），这里只做读盘、回放、探针与打印。
 *
 * 用法（零依赖，纯 Node ≥22.18 直载 .ts）：
 *   node scripts/loss-report.mjs --batch l2n1                       # = --dir .work/remote/l2n1
 *   node scripts/loss-report.mjs --dir .work/remote/l2n1,.work/remote/vorder1
 *   node scripts/loss-report.mjs --dir .work/remote/rapfihi1 --max-games 20
 *   node scripts/loss-report.mjs --dir .work/remote/l2n1 --no-vcf    # 只出形态，不跑引擎
 *   node scripts/loss-report.mjs --dir .work/remote/l2n1 --json .work/loss.json --quiet
 *
 * 参数：
 *   --dir <paths>     旋转目录（逗号分隔多个根），每个根下找 `round-<i>/games/*.json`，退 `games/*.json`，再退 `*.json`
 *   --batch <id>      等价于 `--dir .work/remote/<id>`
 *   --ours <channel>  哪一侧算「我方」（默认 official）；两侧同渠道的对局要 `--mirror` 才收（两侧各出一个视角）
 *   --theirs <ch>     对手渠道（默认：我方之外那一侧，随便什么渠道）
 *   --tail <n>        只对我方最后 n 手做必败探针（默认全部我方手；n 越小越省，但不可逆点只能在窗口内找到）
 *   --plies <n>       追因用的 VCF 手数上限（默认 9；数字越大越慢、越能查到「早就必败」）
 *   --max-games <n>   最多收 n 个视角（按文件名排序；先探便宜）
 *   --no-vcf          不跑引擎，只出形态（秒级）
 *   --mirror          两侧同渠道的对局也收，两侧各出一个视角（局数 = 棋谱数 ×2）
 *   --show <n>        逐局明细最多打印 n 行（默认 0）
 *   --json <path>     把 shape + 逐局明细写成 JSON
 *   --quiet           不打印 markdown 正文，只打印一行小结
 *
 * 成本：`vcfWin(..., 9)` 一次约 5–50 ms ⇒ 一局败局约 60 次探针 ≈ 0.3–3 s；
 * L2 的 300 局（49 局败局）全量探针约 1–3 分钟。`--no-vcf` 与 `--tail` 是成本闸门。
 *
 * 输出口径见 `scripts/lib/loss-report.mjs` 头部：**追因只到 VCF 级**，`查不到` 不等于「没输在更早的地方」。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityOf } from './lib/batch-common.mjs';
import { fatalSuffix, formatLossMarkdown, lossShape } from './lib/loss-report.mjs';
import { parseRecord } from './lib/tactics-replay.mjs';

const COLOR = { black: '黑方', white: '白方' };
const SIDE_OF = { 黑方: 'black', 白方: 'white' };

/** 用法错误：带 exitCode，由外层 catch 落成进程退出码 2（与其它 CLI 一致）。 */
function die(message) {
  const err = new Error(message);
  err.exitCode = 2;
  throw err;
}

/** 归档里某一侧的显示名（黑方/白方）。 */
const sideName = (o, side) => (o.blackChannel === side ? 'black' : o.whiteChannel === side ? 'white' : null);
const otherSide = (side) => (side === 'black' ? 'white' : 'black');
const channelAt = (o, side) => (side === 'black' ? o.blackChannel : o.whiteChannel);
const tacticsAt = (o, side) => (side === 'black' ? o.blackTactics : o.whiteTactics);
const thinkAt = (o, side) => (side === 'black' ? o.blackThink : o.whiteThink);

/** 身份口径与阶梯报表完全一致：渠道|战术档|思考ms（走 identityOf）。 */
function identityFor(o, side) {
  return identityOf({ channel: channelAt(o, side), tactics: tacticsAt(o, side), thinkMs: thinkAt(o, side) });
}

/** 每个根下找棋谱：`round-<i>/games/*.json` → `games/*.json` → `*.json`。 */
function collectFiles(root) {
  if (!existsSync(root)) die(`目录不存在：${root}`);
  const out = [];
  const rounds = readdirSync(root).filter((d) => /^round-/.test(d) && statSync(join(root, d)).isDirectory()).sort();
  for (const r of rounds) {
    const gdir = join(root, r, 'games');
    if (!existsSync(gdir)) continue;
    for (const f of readdirSync(gdir).filter((x) => x.endsWith('.json')).sort()) out.push({ file: join(gdir, f), round: r });
  }
  if (out.length > 0) return out;
  const gdir = join(root, 'games');
  const dir = existsSync(gdir) ? gdir : root;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) out.push({ file: join(dir, f), round: null });
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const flag = (name, def) => {
    const i = argv.indexOf('--' + name);
    if (i < 0) return def;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
  };
  const has = (name) => argv.includes('--' + name);

  if (has('help') || has('h')) {
    // 文档头在 shebang 之后 ⇒ 先跳到第一个 `/**`，再逐行剥掉 ` * ` 前缀。
    const doc = readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0];
    console.log(doc.slice(doc.indexOf('/**') + 3).replace(/^\s*\*\s?/gm, '').trim());
    return 0;
  }

  const OURS = String(flag('ours', 'official'));
  const THEIRS = flag('theirs', null) ? String(flag('theirs', null)) : null;
  const BATCH = flag('batch', null) ? String(flag('batch', null)) : null;
  const DIR_ARG = flag('dir', null);
  if (DIR_ARG === true) die('--dir 需要一个目录，例如 --dir .work/remote/l2n1');
  const ROOTS = (DIR_ARG ? String(DIR_ARG) : BATCH ? `.work/remote/${BATCH}` : '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (ROOTS.length === 0) die('要么给 --dir <目录[,目录]>，要么给 --batch <批次 id>（例如 --batch l2n1）');
  const TAIL = flag('tail', null) ? Number(flag('tail', null)) : null;
  const PLIES = Number(flag('plies', 9));
  const MAX_GAMES = flag('max-games', null) ? Number(flag('max-games', null)) : Infinity;
  const NO_VCF = has('no-vcf');
  const MIRROR = has('mirror');
  const SHOW = Number(flag('show', 0));
  const QUIET = has('quiet');
  const JSON_ARG = flag('json', null);
  if (JSON_ARG === true) die('--json 需要一个输出路径，例如 --json .work/loss.json');
  const JSON_OUT = JSON_ARG ? String(JSON_ARG) : null;
  if (!Number.isFinite(PLIES) || PLIES <= 0) die('--plies 必须是正整数');
  if (TAIL !== null && (!Number.isFinite(TAIL) || TAIL <= 0)) die('--tail 必须是正整数');

  /**
   * 从一局的某一侧视角产出一行（`ours`/`theirs` 都是 'black'|'white'）。
   * 败局才跑引擎探针：逐手问「我方走完、真轮到对手」的局面里对手有没有 ≤PLIES 手 VCF 必杀。
   */
  function analyze({ o, file, round, ours, theirs }) {
    const moves = Array.isArray(o.moves) ? o.moves : [];
    const ourMoves = moves.filter((m) => SIDE_OF[m.side] === ours);
    const ourLast = ourMoves[ourMoves.length - 1];
    const result = o.winner === ours ? 'win' : o.winner === theirs ? 'loss' : 'draw';
    const row = {
      file, round,
      identity: identityFor(o, ours),
      opponent: identityFor(o, theirs),
      result,
      plies: moves.length,
      ourMoves: ourMoves.length,
      endReason: o.endReason || null,
      lastLayer: ourLast ? (ourLast.tactics || (ourLast.ai && ourLast.ai.tac) || null) : null,
      lastNotation: ourLast ? ourLast.notation : null,
      suffix: null,
    };
    if (NO_VCF || result !== 'loss') return row;

    let rec;
    try { rec = parseRecord(o, { file }); } catch (err) {
      console.error(`⚠ 读不出棋谱 ${file}：${err.message}`);
      skipped.bad++;
      return null;
    }
    const engine = rec.engine;
    let st = engine.newGame();
    const marks = [];
    for (const m of rec.moves) {
      const sideId = SIDE_OF[m.side];
      const mv = engine.moveFromNotation(st, m.notation);
      if (!mv) break;
      st = engine.applyMove(st, mv);
      if (sideId !== ours) continue;
      const layer = m.tactics || (m.ai && m.ai.tac) || null;
      // 探针点 = 我方走完、真轮到对手的局面（对手的 VCF 必杀才是真的必败）。
      // 注意 vcfWin 返回对象：必须取 .win === true（`!!` 恒真，见 MEMORY 2026-10-05）。
      let fatal = false;
      try { fatal = engine.vcfWin(st, theirs, PLIES).win === true; } catch { fatal = false; }
      marks.push({ ply: m.ply ?? marks.length * 2 + 1, layer, fatal });
    }
    const window = TAIL === null ? marks : marks.slice(-TAIL);
    const sfx = fatalSuffix(window.map((m) => m.fatal));
    row.suffix = {
      count: sfx.count,
      window: window.length,
      tail: TAIL,
      plies: sfx.start === null ? [] : window.slice(sfx.start).map((m) => ({ ply: m.ply, layer: m.layer })),
      marks: window.map((m) => `${m.ply}${m.fatal ? '✗' : '·'}`).join(' '),
    };
    probed++;
    if (!QUIET) process.stderr.write('.');
    return row;
  }

  const rows = [];
  const skipped = { noOurs: 0, noTheirs: 0, mirror: 0, bad: 0 };
  let probed = 0;
  for (const root of ROOTS) {
    if (rows.length >= MAX_GAMES) break;
    for (const { file, round } of collectFiles(root)) {
      if (rows.length >= MAX_GAMES) break;
      let o;
      try { o = JSON.parse(readFileSync(file, 'utf8')); } catch { skipped.bad++; continue; }
      const ours = sideName(o, OURS);
      if (!ours) { skipped.noOurs++; continue; }
      const bothOurs = channelAt(o, 'black') === OURS && channelAt(o, 'white') === OURS;
      if (bothOurs) {
        // 同门对局（两侧同渠道）：默认跳过；`--mirror` 时两侧各出一个视角（局数 = 棋谱数 ×2）。
        if (!MIRROR) { skipped.mirror++; continue; }
        for (const side of ['black', 'white']) {
          const row = analyze({ o, file, round, ours: side, theirs: otherSide(side) });
          if (row) rows.push(row);
        }
        continue;
      }
      const theirs = (THEIRS ? sideName(o, THEIRS) : null) || otherSide(ours);
      if (!channelAt(o, theirs)) { skipped.noTheirs++; continue; }
      const row = analyze({ o, file, round, ours, theirs });
      if (!row) continue;
      rows.push(row);
    }
  }
  if (probed > 0 && !QUIET) process.stderr.write('\n');

  const shape = lossShape(rows);
  const label = (BATCH || ROOTS.join(',')) + (MIRROR ? '（--mirror：两侧各出一个视角，局数 = 棋谱数 ×2）' : '');
  const md = formatLossMarkdown(shape, { label, plies: PLIES });
  const losses = rows.filter((r) => r.result === 'loss');

  if (QUIET) {
    console.log(`✓ ${shape.games} 局 = ${shape.w} 胜 / ${shape.d} 和 / ${shape.l} 负｜不败率 ` +
      `${shape.unbeatenRate == null ? '—' : (shape.unbeatenRate * 100).toFixed(1) + '%'}｜必败后缀 ` +
      `${shape.suffix.buckets[1]}/${shape.suffix.buckets[2]}/${shape.suffix.buckets[3]}/${shape.suffix.buckets['4+']}` +
      `/查不到 ${shape.suffix.none}｜不可逆点 ${shape.lostFrom.found} 局｜跳过 ${JSON.stringify(skipped)}`);
  } else {
    console.log(md);
    if (SHOW > 0) {
      console.log(`\n【逐局明细（前 ${SHOW} 局败局）】手数 | 最后一手 | 不可逆点 | 追因标记`);
      for (const r of losses.slice(0, SHOW)) {
        const tail = r.suffix && r.suffix.marks ? r.suffix.marks : '—';
        const at = r.suffix && r.suffix.plies.length ? r.suffix.plies[0].ply : '—';
        console.log(`${r.plies} | ${r.lastLayer || '—'} | ${at} | ${tail}`);
      }
    }
    if (Object.values(skipped).some((n) => n > 0)) console.log(`\n（跳过：${JSON.stringify(skipped)}）`);
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ version: 1, roots: ROOTS, ours: OURS, plies: PLIES, tail: TAIL, shape, skipped, games: rows }, null, 2));
    if (!QUIET) console.log(`\n✓ JSON 已写入 ${JSON_OUT}`);
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''));
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error('✗ ' + (err && err.message ? err.message : String(err)));
    process.exitCode = (err && err.exitCode) || 1;
  }
}
