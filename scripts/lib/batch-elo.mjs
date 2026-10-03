// batch-elo.mjs — 批量实验产物的身份归一 + Elo 顺序迭代（纯函数，零依赖）
//
// 为什么单独一个文件：elo 要从远端拉回来的棋谱 JSON 里算，输入全是
// buildGameExport 的产物（黑/白渠道、战术档、思考 ms、胜者），必须能在
// 本地（甚至 test/scripts 单测里）不碰网络地复算。
//
// 口径（D8）：
//   - 身份 = channel|tactics|thinkMs，**唯一实现在 batch-common.mjs**（与归档/报表的
//     `渠道|战术|思考` 桶键同一形状，空战术档留空而不是 '-'：`rapfi||500`）。
//     早先这里另有一份把空档写成 '-' 的实现 ⇒ 同一个配置两处口径（合入审查的中清单项）。
//     mock 臂不过战术层、thinkMs 对非 rapfi 臂无意义，都自然落到空串/0。
//   - 顺序迭代（按时间序逐局更新），K=16，和棋记 0.5。
//   - <MIN_GAMES 局的身份只展示不计 ranking 标注（本版不做 Glicko）。
//   - 只统计 buildGameExport 里 result/winner 完整的局；dry-run 局也统计
//     （mock/random 臂的冒烟同样有胜负，可用于验证链路）。

import fs from 'node:fs';
import path from 'node:path';

import { identityOf } from './batch-common.mjs';

export { identityOf };

/** 少于这个局数的身份在排行里标注「样本不足」。 */
export const MIN_GAMES = 50;

/** 报表用的置信水平（95% ⇒ z = 1.96）。 */
export const Z95 = 1.96;

/**
 * 得分率的 **Wilson 95% 区间**（P0b / §3.1 第 4 条）。
 *
 * 为什么不用教科书那个 `p ± 1.96·√(p(1-p)/n)`：小样本 + 极端比例（0 胜、全胜）时它会算出
 * 越界区间甚至宽度 0——而阶梯实验恰恰经常只有 12～20 局、还常出现 9-1-2 这种偏斜。
 * Wilson 是「得分率这个二项比例的区间估计」的标准解，天然落在 [0,1] 内、n 小的时候自动变宽。
 *
 * 读数纪律（写进报表的原因）：**20 局/对的半宽约 ±20 pt**（Wilson；教科书那条 Wald 写法给
 * ±22 pt 且极端比例会越界），即 50% 与 70% 的区间大面积重叠 ——
 * 「这一档更强」在 20 局规模上根本不可判。区间必须与点估计并排出现，否则报告读起来像「已证明」。
 * 和棋记 0.5（`hits = w + d/2`），与 `rankTable` 的得分率同口径。
 */
export function wilson(hits, n, z = Z95) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return {
    p,
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
    /* 半宽（比例）：报表里印成 ±XX.X pt —— 它就是「这个数能分辨多大的差」 */
    half,
    n,
    z,
  };
}

/** 从一个棋谱 export JSON 提取一局记录（黑/白身份 + 黑方得分）。 */
export function gameRecord(exportJson) {
  const g = typeof exportJson === 'string' ? JSON.parse(exportJson) : exportJson;
  const result = String(g.result || '');
  const winner = String(g.winner || '');
  const draw = /^和棋(?:（(.+?)）)?\s*$/.exec(result); // 与 record-map.ts:255 parseResult() 同形
  let score = null; // 黑方得分
  if (winner === 'black') score = 1;
  else if (winner === 'white') score = 0;
  /* 和棋的 winner 在导出/D1 口径里就是 null（record-map.ts 的 parseResult() 对「和棋」返回
     winner:null，D1 games.winner 也是 NULL），只能靠 result 串识别。漏了它会把和棋当未终局
     整局丢掉——AGENTS.md 铁律 11 要求胜/和/负同报，「把和棋变胜局」不算功绩。 */
  else if (winner === 'draw' || draw) score = 0.5;
  // winner 缺失/空/未知且 result 不是和棋 ⇒ 未终局或超时截断，不计入 Elo
  if (score === null) return null;
  // 没有 identity 线索的 JSON 不当棋谱（多一层保险，正常布局下 visit 不到）
  if (!g.blackChannel || !g.whiteChannel) return null;
  return {
    tag: g.experiment || g.tag || '',
    gameUid: g.gameUid || g.game_uid || '',
    exported: g.exported || '',
    black: identityOf({ channel: g.blackChannel, tactics: g.blackTactics, thinkMs: g.blackThink }),
    white: identityOf({ channel: g.whiteChannel, tactics: g.whiteTactics, thinkMs: g.whiteThink }),
    blackScore: score,
    result,
    /* 和棋的 endReason 从 result 串的括号里取（parseResult() 的口径），导出缺 endReason 时兜底 */
    reason: g.endReason || g.end_reason || (draw && draw[1]) || '',
    plies: Array.isArray(g.moves) ? g.moves.length : 0,
  };
}

/**
 * 读一个目录（或目录数组）下的棋谱 JSON，按 exported/tag 稳定排序。
 * 只收 `<任意层级>/games/*.json`：worker 的产物布局是 round-i/games/，
 * 这样 round-summary.json / elo.json / plans/plan.json 都不会被当成棋谱。
 */
export function loadRecords(dirOrDirs) {
  const dirs = Array.isArray(dirOrDirs) ? dirOrDirs : [dirOrDirs];
  const files = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.json$/i.test(name) && path.basename(d) === 'games') files.push(p);
      }
    };
    walk(dir);
  }
  const recs = [];
  for (const f of files) {
    let json = null;
    try { json = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const rec = gameRecord(json);
    if (rec) recs.push(rec);
  }
  recs.sort((a, b) => (a.exported || a.tag).localeCompare(b.exported || b.tag) || (a.gameUid || '').localeCompare(b.gameUid || ''));
  return recs;
}

/**
 * 顺序 Elo 迭代。K=16，和棋 0.5；同一局内双方同时更新。
 * 返回 { rating: Map<id,elo>, games: Map<id,局数>, matrix: Map<'a>b', {w,d,l,games}> }。
 */
export function computeElo(records, K = 16) {
  const rating = new Map();
  const games = new Map();
  const matrix = new Map();
  const seen = (id) => { if (!rating.has(id)) { rating.set(id, 1500); games.set(id, 0); } };
  for (const r of records) {
    seen(r.black); seen(r.white);
    const ra = rating.get(r.black);
    const rb = rating.get(r.white);
    const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    rating.set(r.black, ra + K * (r.blackScore - ea));
    rating.set(r.white, rb + K * (1 - r.blackScore - (1 - ea)));
    games.set(r.black, games.get(r.black) + 1);
    games.set(r.white, games.get(r.white) + 1);
    const key = r.black + '>>' + r.white;
    if (!matrix.has(key)) matrix.set(key, { black: r.black, white: r.white, w: 0, d: 0, l: 0, games: 0 });
    const m = matrix.get(key);
    m.games += 1;
    if (r.blackScore === 1) m.w += 1;
    else if (r.blackScore === 0.5) m.d += 1;
    else m.l += 1;
  }
  return { rating, games, matrix, k: K };
}

/** 排行行：Elo + 总局数 + 胜/和/负 + 得分率 + Wilson 95% 区间 + 样本不足标注。 */
export function rankTable(records, K = 16) {
  const { rating, games } = computeElo(records, K);
  const sides = new Map(); // id -> {w,d,l}
  for (const r of records) {
    if (!sides.has(r.black)) sides.set(r.black, { w: 0, d: 0, l: 0 });
    if (!sides.has(r.white)) sides.set(r.white, { w: 0, d: 0, l: 0 });
    const b = sides.get(r.black); const w = sides.get(r.white);
    if (r.blackScore === 1) { b.w += 1; w.l += 1; } else if (r.blackScore === 0.5) { b.d += 1; w.d += 1; } else { b.l += 1; w.w += 1; }
  }
  return [...games.keys()].map((id) => {
    const s = sides.get(id);
    const n = games.get(id);
    /* 得分率 = (胜 + 和/2) / 局数，与 formatRankTable 打印的那个数同口径 */
    const ci = wilson(s.w + s.d * 0.5, n);
    return {
      identity: id,
      rating: Math.round(rating.get(id) * 10) / 10,
      games: n,
      ...s,
      rate: ci ? ci.p : null,
      ci,
      /* 半宽的百分点（报表里的 ±XX.Xpt）：n=20 时约 22 ⇒ 直接看去能不能分辨差异 */
      halfPt: ci ? Math.round(ci.half * 1000) / 10 : null,
      enough: n >= MIN_GAMES,
    };
  }).sort((a, b) => b.rating - a.rating || b.games - a.games);
}

/** 人读报表（页宽 96）。区间与样本量并排印：小样本先看 ±XX.Xpt，再看点估计。 */
export function formatRankTable(rows) {
  const lines = [];
  const warn = rows.some((r) => !r.enough);
  lines.push(
    '身份（渠道|战术档|思考ms）'.padEnd(40) + 'Elo'.padStart(7) + '局数'.padStart(6) +
    '胜'.padStart(5) + '和'.padStart(5) + '负'.padStart(5) + '得分率'.padStart(8) +
    '95% 区间(Wilson)'.padStart(19) + (warn ? '  ⚠样本不足(<' + MIN_GAMES + ')' : ''),
  );
  for (const r of rows) {
    const rate = ((r.w + r.d * 0.5) / r.games * 100).toFixed(1) + '%';
    const ci = r.ci
      ? '[' + (r.ci.lo * 100).toFixed(1) + '–' + (r.ci.hi * 100).toFixed(1) + ']'
      : '—';
    lines.push(
      r.identity.padEnd(40) +
      String(r.rating).padStart(7) +
      String(r.games).padStart(6) + String(r.w).padStart(5) + String(r.d).padStart(5) + String(r.l).padStart(5) +
      rate.padStart(8) + ci.padStart(19) +
      (r.enough ? '' : '  ±' + (r.halfPt == null ? '?' : r.halfPt.toFixed(1)) + 'pt ⚠'),
    );
  }
  if (warn) {
    lines.push('注：样本 < ' + MIN_GAMES + " 局时得分率的 Wilson 95% 区间半宽常在 ±15～±25 pt —— " +
      '区间大面积重叠就不能读作「更强」；跨档位比分不是曲线，要判机制收益得上配对样本。');
  }
  return lines.join('\n');
}
