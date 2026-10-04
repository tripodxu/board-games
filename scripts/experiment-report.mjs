#!/usr/bin/env node
/**
 * scripts/experiment-report.mjs — 阶梯报告（每次阶梯必出，六项口径见 ladder 计划 §7）
 *
 * 回答一个问题：**「这一晚跑出来的数据，能力与成本各是多少，能不能下结论？」**
 * 把拉回来的 `<batch>/round-<i>/` 产物直接变成一份 markdown（+ 可选 JSON），不再手写一次性脚本。
 *
 * 用法（零依赖，纯 Node ≥22.18）：
 *   node scripts/experiment-report.mjs --batch l3n1                 # 读 .work/remote/l3n1，写 .work/l3n1-report.md
 *   node scripts/experiment-report.mjs --dir .work/remote/l2n1 --json .work/l2n1-report.json
 *   node scripts/experiment-report.mjs --dir a,b --quiet --no-bt
 *
 * 参数：
 *   --batch <id>        批次名（决定默认目录 .work/remote/<id> 与默认输出，与 --dir 互斥）
 *   --dir <path[,path]> 产物根目录（可多个，逗号分隔）
 *   --out <path>        markdown 落盘路径（缺省 .work/<batch>-report.md；`-` 表示不落盘）
 *   --json <path>       另写一份机器可读 JSON（同一次报告的全部数字）
 *   --anchor <identity> BT 零点（缺省 rapfi||500；不在数据里时退化成均值居中）
 *   --bootstrap <n>     BT bootstrap 次数（缺省 400；0 = 只算点估计）
 *   --seed <n>          bootstrap 种子（缺省 20261004，同种子逐字可复现）
 *   --no-bt             不算 BT（只出顺序迭代的老排行）
 *   --skip-incomplete   跳过仍在跑的轮（缺 `round-summary.json` 的那些）
 *   --quiet             不把 markdown 打到 stdout（仍落盘）
 *
 * 读什么：`<dir>/round-<i>/games.jsonl`（`--store local` 的产物；没有时退回 `round-<i>/games/*.json`）、
 * `round-summary.json`（逐局 W/D/L、providers、throttle、墙钟）、`events.jsonl`（开局键）。
 * 成本只在**真打了上游**的手上算（`ai.ms` 是 number）—— Rapfi/mock 侧是 null，缺失不记 0。
 * 「这轮跑完没有」只看 `round-summary.json`（worker 收尾才写）：缺它的轮默认照读但在报告头显著标注，
 * 加 `--skip-incomplete` 才真的不看它 —— 半轮的比分不许进结论。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { DEFAULT_ANCHOR, gameRecord, rankTable } from './lib/batch-elo.mjs';
import { REPORT_VERSION, collectCost, costRow, openingRows, pairTable, reportMarkdown } from './lib/report.mjs';

/** 用法错/读不到数据：抛 `{exitCode}`，由入口转成 exit code（可被单测直接断言，不杀测试进程）。 */
function die(msg, code = 2) {
  const err = new Error(msg);
  err.exitCode = code;
  throw err;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
      out[key] = next; i++;
    } else out._.push(a);
  }
  return out;
}

const USAGE = '用法：node scripts/experiment-report.mjs --batch <id> ｜ --dir <path[,path]> ' +
  '[--out <md|->] [--json <path>] [--anchor <identity>] [--bootstrap <n>] [--seed <n>] [--no-bt] ' +
  '[--skip-incomplete] [--quiet]';

/** 一轮的产物根：`round-<i>`（按轮号排序）。 */
function roundDirs(dir) {
  return fs.readdirSync(dir)
    .filter((n) => /^round-\d+$/.test(n) && fs.statSync(path.join(dir, n)).isDirectory())
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
    .map((n) => path.join(dir, n));
}

function jsonlLines(file) {
  const out = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { bad += 1; }
  }
  return { out, bad };
}

export async function reportMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
    return 0;
  }
  const posix = (p) => path.relative(process.cwd(), p).split(path.sep).join('/');

  const batch = args.batch === true ? '' : args.batch || null;
  const dirArg = args.dir === true ? '' : args.dir || null;
  if (batch && dirArg) die('--batch 与 --dir 互斥（--batch 只是 --dir .work/remote/<id> 的简写）');
  if (!batch && !dirArg) die(`要给 --batch <id> 或 --dir <path>\n${USAGE}`);
  const dirs = dirArg
    ? dirArg.split(',').map((d) => path.resolve(d.trim())).filter(Boolean)
    : [path.resolve('.work/remote', batch)];
  if (dirs.length === 0) die(USAGE);
  const batchId = batch || path.basename(dirs[0]);

  if (args.json === true) die('--json 需要一个输出路径，例如 --json .work/l3n1-report.json');
  const jsonOut = args.json ? path.resolve(String(args.json)) : null;
  if (args.out === true) die('--out 需要一个输出路径（或 `-` 表示不落盘）');
  const out = args.out === undefined ? path.resolve('.work', `${batchId}-report.md`) : String(args.out);

  const anchor = args.anchor === true ? DEFAULT_ANCHOR : args.anchor ? String(args.anchor) : DEFAULT_ANCHOR;
  const bootstrap = args.bootstrap === undefined || args.bootstrap === true ? 400 : Number(args.bootstrap);
  const seed = args.seed === undefined || args.seed === true ? 20261004 : Number(args.seed);
  if (!Number.isFinite(bootstrap) || bootstrap < 0) die('--bootstrap 需要 ≥0 的整数');
  if (!Number.isFinite(seed)) die('--seed 需要数字');
  const noBt = Boolean(args['no-bt']);
  const quiet = Boolean(args.quiet);
  const skipIncomplete = Boolean(args['skip-incomplete']);

  const missing = dirs.filter((d) => !fs.existsSync(d));
  if (missing.length) {
    die(`目录不存在：${missing.map(posix).join('、')}\n` +
      '提示：阶梯产物在 box 上，先 `node scripts/experiment-batch.mjs pull --batch <id>` 拉回 .work/remote/<id>');
  }

  /* 逐轮读 payload：优先 games.jsonl（`--store local` 的权威产物），没有才退回 games/*.json。
     两种布局都存在时**不要都读**（同一局会被算两次 —— gameUid 去重是第二道保险）。
     开局键在 `events.jsonl` 的 `game-start` 事件里（棋谱 payload 上没有），按轮内局号对回来。 */
  const payloads = [];
  const seenUid = new Set();
  const openingOf = new Map();
  const summaries = [];
  const artifacts = [];
  const incomplete = [];
  const skippedIncomplete = [];
  let badLines = 0;
  for (const dir of dirs) {
    for (const rd of roundDirs(dir)) {
      const roundNo = Number(path.basename(rd).slice(6));
      /* 「这轮跑完没有」的本地凭据只有一个：worker 收尾才写 round-summary.json。
         缺它就是本轮还在跑 —— 默认照读但显著标注（报告头 + §5），--skip-incomplete 才真的不看。 */
      const settled = fs.existsSync(path.join(rd, 'round-summary.json'));
      const jsonl = path.join(rd, 'games.jsonl');
      let got = [];
      if (fs.existsSync(jsonl)) {
        const { out: rows, bad } = jsonlLines(jsonl);
        got = rows;
        badLines += bad;
        artifacts.push({ path: posix(jsonl), file: jsonl, lines: rows.length });
      } else {
        const gamesDir = path.join(rd, 'games');
        if (fs.existsSync(gamesDir)) {
          for (const f of fs.readdirSync(gamesDir).filter((n) => /\.json$/i.test(n)).sort()) {
            try { got.push(JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8'))); } catch { badLines += 1; }
          }
          artifacts.push({ path: posix(gamesDir), file: null, lines: got.length });
        }
      }
      if (!settled && got.length > 0) {
        if (skipIncomplete) {
          skippedIncomplete.push({ round: roundNo, games: got.length });
          for (let k = artifacts.length - 1; k >= 0; k -= 1) {
            if (artifacts[k].path.startsWith(`${posix(rd)}/`)) artifacts.splice(k, 1);
          }
          continue;
        }
        incomplete.push({ round: roundNo, games: got.length });
      }
      const eventsFile = path.join(rd, 'events.jsonl');
      const openingByNo = new Map();
      if (fs.existsSync(eventsFile)) {
        for (const e of jsonlLines(eventsFile).out) {
          if (e && e.kind === 'game-start' && e.opening) openingByNo.set(e.gameNo, e.opening);
        }
      }
      for (const g of got) {
        const uid = g.gameUid || g.uid || g.gid || '';
        if (uid && seenUid.has(uid)) continue;
        if (uid) seenUid.add(uid);
        const no = g.expGameNo || g.exp_game_no;
        if (no != null && openingByNo.has(no)) openingOf.set(g, openingByNo.get(no));
        payloads.push(g);
      }
      for (const name of ['round-summary.json', 'progress.json']) {
        const f = path.join(rd, name);
        if (fs.existsSync(f)) {
          artifacts.push({ path: posix(f), file: f, lines: null });
          if (name === 'round-summary.json') {
            try { summaries.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { badLines += 1; }
          }
        }
      }
    }
  }

  if (payloads.length === 0) {
    die(`没读到棋谱：${dirs.map(posix).join('、')} 下没有 round-<i>/games.jsonl（或 round-<i>/games/*.json）`);
  }

  /* 产物清单：行数 + sha256 前 12 位（复核与续跑对齐用，§7 第 ⑥ 项）。 */
  for (const a of artifacts) {
    if (!a.file) { a.bytes = null; a.sha256 = '—'; delete a.file; continue; }
    const buf = fs.readFileSync(a.file);
    a.bytes = buf.length;
    a.sha256 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    delete a.file;
  }

  const records = payloads.map((g) => gameRecord(g)).filter(Boolean);
  if (records.length === 0) die('棋谱里没有一局有胜负（winner/result 缺失或未终局）');

  const btOpts = noBt ? null : { anchor, bootstrap, seed };
  const rows = rankTable(records, 16, btOpts ? { bt: btOpts } : {});
  const pairs = pairTable(records);
  const openings = openingRows(payloads, (g) => openingOf.get(g) || null);
  const cost = collectCost(payloads);
  const costRows = [...cost.byIdentity.entries()]
    .map(([id, b]) => costRow(id, b))
    .sort((a, b) => b.moves - a.moves || (a.identity < b.identity ? -1 : 1));

  const runtimeBits = [];
  const seen = new Set();
  for (const s of summaries) {
    const key = `${s.store}/${s.upstream}/${s.repoHead || '?'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runtimeBits.push(`store=${s.store} upstream=${s.upstream} repoHead=${s.repoHead || '?'}`);
  }
  const tags = summaries.map((s) => s.tag).filter(Boolean);
  const totalGames = summaries.reduce((n, s) => n + (s.games ? s.games.length : 0), 0);
  const totalWallS = summaries.reduce((n, s) => n + (s.progress ? s.progress.elapsedS || 0 : 0), 0);

  const model = {
    version: REPORT_VERSION,
    batchId,
    generatedAt: new Date().toISOString(),
    dirs: dirs.map((d) => posix(d) || d),
    rounds: summaries.length || roundDirs(dirs[0]).length,
    games: payloads,
    records,
    rows,
    pairs,
    openings,
    cost: { rows: costRows, totalRow: costRow('全轮合计', cost.total) },
    runtime: runtimeBits.join('｜') + (totalGames ? `｜${totalGames} 局／墙钟 ${(totalWallS / 60).toFixed(1)} 分钟` : ''),
    artifacts: artifacts.sort((a, b) => (a.path < b.path ? -1 : 1)),
    incomplete,
    skippedIncomplete,
    anchor,
    bootstrap: noBt ? 0 : bootstrap,
    seed,
    tags,
  };

  const md = reportMarkdown(model);
  if (out !== '-') {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md);
  }
  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify({ ...model, games: undefined, records }, null, 2) + '\n');
  }

  if (!quiet) console.log(md);
  /* 收尾一行走 stderr：stdout 可能被 `> report.md` 重定向，读数提示不该跟着跑。 */
  console.error(`\n✓ ${batchId}：${records.length} 局 / ${rows.length} 身份 / ${pairs.length} 对` +
    (badLines ? `（跳过 ${badLines} 行坏 JSON）` : '') +
    `｜兜底手 ${cost.total.prov.backup || 0} / 上游手 ${cost.total.moves}` +
    (incomplete.length && !skipIncomplete
      ? `\n  ⚠ 含未收尾的轮：${incomplete.map((r) => `round-${r.round}（${r.games} 局）`).join('、')}（要排除就加 --skip-incomplete）`
      : '') +
    (skippedIncomplete.length
      ? `\n  已跳过未收尾的轮：${skippedIncomplete.map((r) => `round-${r.round}（${r.games} 局）`).join('、')}`
      : '') +
    (out !== '-' ? `\n  已写 ${posix(out)}` : '') +
    (jsonOut ? ` + ${posix(jsonOut)}` : ''));
  return 0;
}

/* 直接调用入口（被单测 import 时不执行）。 */
const invoked = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''));
if (invoked) {
  try {
    process.exitCode = await reportMain();
  } catch (err) {
    console.error('✗ ' + ((err && err.message) || err));
    process.exitCode = (err && err.exitCode) || 1;
  }
}
