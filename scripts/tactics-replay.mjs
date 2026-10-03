#!/usr/bin/env node
/**
 * scripts/tactics-replay.mjs — 任意棋谱 × 任意战术档位的离线重放（P3）
 *
 * 回答一个问题：**「这手棋换一档（或换回原档重算）会不会不一样？」**
 * 逐手给出「重放层 + 重放落点」对照归档里的「记录层 + 实走点」，并列出会变的手。
 *
 * 用法（零依赖，纯 Node ≥22.18 直载 .ts）：
 *   node scripts/tactics-replay.mjs --dir games                      # 归档全部棋谱 × 各自记录的档
 *   node scripts/tactics-replay.mjs --dir .work/p3-games --tag exp-20261003082805 --tactics v14-live3-fresh
 *   node scripts/tactics-replay.mjs --file games/2026-09-29/gomoku-20260929095122.json --tactics v9-vcf-sound
 *   node scripts/tactics-replay.mjs --dir .work/p3-games --json .work/p3-replay.json --show 40
 *
 * 参数：
 *   --dir <path>       棋谱目录（递归找 *.json）；默认 games
 *   --file <path>      单个棋谱文件（与 --dir 互斥）
 *   --tag <substr>     只重放 experimentTag 或文件名含该子串的棋谱（如 exp-20261003082805）
 *   --game <uid>       只重放 gameUid/uid/gid 等于它的棋谱
 *   --tactics <id>     强制档位（缺省 = 逐手记录的 ai.tv，再退局级 tacticsVersion，再退 CURRENT）
 *   --sides <mode>     auto（默认，按渠道判）| both | black | white
 *   --limit <n>        最多重放 n 手（成本闸门；一个局面一档约 0.05–1.2 s，见下）
 *   --max-games <n>    最多处理 n 局
 *   --json <path>      把逐行结果与汇总写成 JSON
 *   --show <n>         会变的手最多打印 n 行（默认 20）
 *   --quiet            只打印每局一行与汇总
 *
 * 成本（实测，`test/engines/fingerprint.mjs` 同口径）：便宜档 1–90 ms/手，v12–v14 约 1.2 s/手
 * ⇒ 一轮 20 局 400 手用 v14 重放约 8 分钟。这就是 `--limit` 存在的原因。
 *
 * 输出口径见 `scripts/lib/tactics-replay.mjs` 头部注释：**层一致率**是最强结论（与模型无关），
 * **落点一致率只在有接管的手上有意义**，「会变的手」是给人看的差异清单。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT } from '../src/core/tactics-versions.ts';
import { TACTICS_IDS, parseRecord, replayGame, mergeSummaries } from './lib/tactics-replay.mjs';

function flag(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const has = (name) => process.argv.includes('--' + name);

if (has('help') || has('h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
  process.exit(0);
}

const DIR = String(flag('dir', has('file') ? '' : 'games'));
const FILE = flag('file', null) ? String(flag('file', null)) : null;
const TAG = flag('tag', null) ? String(flag('tag', null)) : null;
const GAME = flag('game', null) ? String(flag('game', null)) : null;
const TACTICS = flag('tactics', null) ? String(flag('tactics', null)) : null;
const SIDES = String(flag('sides', 'auto'));
const LIMIT = flag('limit', null) ? Number(flag('limit', null)) : undefined;
const MAX_GAMES = flag('max-games', null) ? Number(flag('max-games', null)) : Infinity;
const JSON_ARG = flag('json', null);
if (JSON_ARG === true) { console.error('--json 需要一个输出路径，例如 --json .work/replay.json'); process.exit(2); }
const JSON_OUT = JSON_ARG ? String(JSON_ARG) : null;
const SHOW = Number(flag('show', 20));
const QUIET = has('quiet');

if (TACTICS && !TACTICS_IDS.includes(TACTICS)) {
  console.error(`未知战术档 "${TACTICS}"，合法值：${TACTICS_IDS.join(', ')}`);
  process.exit(2);
}
if (Number.isFinite(LIMIT) && LIMIT <= 0) { console.error('--limit 必须是正整数'); process.exit(2); }

/** 递归收集 *.json（跳过大目录噪音）。 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

let files;
if (FILE) files = [FILE];
else {
  try {
    files = walk(DIR);
  } catch (err) {
    console.error(`读不到目录 ${DIR}：${String(err && err.message || err)}`);
    process.exit(2);
  }
}
files.sort();
if (TAG) files = files.filter((f) => f.includes(TAG));

console.log(`tactics-replay：${files.length} 个候选棋谱（dir=${FILE ? '-' : DIR}${TAG ? ' tag~' + TAG : ''}` +
  `${TACTICS ? ' tactics=' + TACTICS : ' tactics=逐手记录'}）\n`);

const summaries = [];
const perGame = [];
let parsed = 0;
let skippedFiles = 0;
const t0 = Date.now();

for (const f of files) {
  if (parsed >= MAX_GAMES) break;
  let rec;
  try {
    rec = parseRecord(JSON.parse(readFileSync(f, 'utf8')), { file: f });
  } catch (err) {
    if (!QUIET) console.log(`  ✗ ${f}：${String(err && err.message || err)}`);
    skippedFiles++;
    continue;
  }
  if (GAME && rec.uid !== GAME) continue;
  if (TAG && rec.tag && !String(rec.tag).includes(TAG)) continue;
  parsed++;
  const r = replayGame(rec, { tactics: TACTICS, sides: SIDES, limit: LIMIT });
  const s = r.summary;
  summaries.push(s);
  perGame.push({ file: f, uid: rec.uid, tag: rec.tag, summary: s, rows: r.rows });
  console.log(`  ✔ ${f}${rec.uid ? ' (' + rec.uid + ')' : ''}：重放 ${s.replayed}/${s.moves} 手` +
    `｜层一致 ${s.layerFieldKnown ? s.layerSame + '/' + s.layerCompared + '（' + (s.layerSameRate ?? '-') + '%）' : '（无记录层）'}` +
    `｜接管落点一致 ${s.takeoverMoveSame}/${s.takeoverMoves}` +
    `｜会变 ${s.changed} 手｜${(s.costMs / 1000).toFixed(1)}s`);
  for (const n of s.notes) console.log(`     ⚠ ${n}`);
}

const total = mergeSummaries(summaries);
const wall = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n── 汇总（${total.games} 局 / ${total.moves} 手，重放 ${total.replayed} 手，用时 ${wall}s）──`);
console.log(`  层一致率：${total.layerFieldKnown
  ? `${total.layerSame}/${total.layerCompared} = ${total.layerSameRate}%（层由确定性事实决定，与模型无关）`
  : '归档里没有逐手战术标记（老棋谱），本项不适用'}`);
console.log(`  接管落点一致率：${total.takeoverMoveSame}/${total.takeoverMoves}` +
  `${total.takeoverMoves ? ' = ' + total.takeoverMoveSameRate + '%' : ''}（只在有接管的手上有意义）`);
console.log(`  会变的手：${total.changed} 手；重放层分布：${fmtHist(total.layers)}`);
if (total.layerFieldKnown) console.log(`  记录层分布：${fmtHist(total.recordedLayers)}`);
console.log(`  战术层耗时合计 ${(total.costMs / 1000).toFixed(1)}s（重放口径，不含模型）`);
if (total.versionInferred) {
  console.log(`  ⚠ 其中 ${total.versionInferred} 手用的是**推断**档号（归档没记档号 ⇒ 取 CURRENT=${CURRENT}）：` +
    '这些行的「层」不能当历史结论读，要按当时档位跑请用 --tactics 指定。');
}
if (skippedFiles) console.log(`  跳过的文件：${skippedFiles}（不是棋谱或不认识的棋种）`);

if (total.changedRows.length) {
  console.log(`\n── 会变的手（最多 ${SHOW} 行，共 ${total.changedRows.length}）──`);
  console.log('  ply  侧   档位                    重放层 → 记录层        重放点 → 实走点');
  for (const r of total.changedRows.slice(0, SHOW)) {
    console.log(`  ${String(r.ply).padEnd(4)} ${String(r.side).padEnd(5)} ${String(r.v).padEnd(22)} ` +
      `${String(r.layer ?? '(不接管)').padEnd(12)} → ${String(r.was ?? '(无)').padEnd(12)} ` +
      `${String(r.notation ?? '-').padEnd(5)} → ${r.played}`);
  }
  if (total.changedRows.length > SHOW) console.log(`  …还有 ${total.changedRows.length - SHOW} 行（--show 调大或看 --json）`);
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    generator: 'scripts/tactics-replay.mjs',
    dir: FILE || DIR, tag: TAG, forcedTactics: TACTICS, sides: SIDES, limit: LIMIT ?? null,
    current: CURRENT, wallMs: Date.now() - t0, total, games: perGame,
  }, null, 1));
  console.log(`\n已写 ${JSON_OUT}`);
}

function fmtHist(h) {
  const ks = Object.keys(h || {});
  if (!ks.length) return '（空）';
  return ks.sort((a, b) => h[b] - h[a]).map((k) => `${k}×${h[k]}`).join(' · ');
}
