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
//   - **P5 起另给 Bradley–Terry 点估计 + bootstrap 区间**（`computeBt` / `bootstrapBt`）：
//     顺序迭代的读数依赖局序，而阶梯实验要比的是跨档位的差 ⇒ 报表以 BT Δ 为主列
//     （锚点缺省 `rapfi||500`，它自己恒为 0），顺序 Elo 作为老口径并排保留。
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

/** 开局前 4 手（与 D1 `games.opening_prefix` 同口径：逗号连接；不足 4 手 = null）。
 *  配对分析（report 的 pairBlocks）靠它识别「同开局 + 换色」的成对局。 */
function openingPrefixOf(g) {
  const parts = [];
  const ms = Array.isArray(g.moves) ? g.moves : [];
  for (const m of ms) {
    if (parts.length >= 4) break;
    if (m && typeof m.notation === 'string' && m.notation) parts.push(m.notation);
  }
  if (parts.length < 4 && typeof g.notation === 'string' && g.notation) {
    for (const n of g.notation.split(',')) {
      if (parts.length >= 4) break;
      if (n) parts.push(n);
    }
  }
  return parts.length === 4 ? parts.join(',') : null;
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
    opening: openingPrefixOf(g),
  };
}

/**
 * 读一个目录（或目录数组）下的棋谱，按 exported/tag 稳定排序。两种布局都认：
 *   - `<任意层级>/games/*.json`：worker 的产物布局是 round-i/games/，
 *     这样 round-summary.json / elo.json / plans/plan.json 都不会被当成棋谱；
 *   - `<任意层级>/games.jsonl`（或 `games/*.jsonl`）：**D11 的 `--store local` 产物**，
 *     每行一局（形状与 `games/*.json` 的 payload 逐字相同，只是攒在一个文件里）。
 *     坏行跳过（和坏 JSON 同处置）：JSONL 是追加写的，`kill -9` 可能留半行。
 */
export function loadRecords(dirOrDirs) {
  const dirs = Array.isArray(dirOrDirs) ? dirOrDirs : [dirOrDirs];
  const files = [];
  const jsonls = [];
  /* 「棋谱 JSON」= 路径上**任何一级目录**叫 `games`。两种布局都覆盖：
     worker 的 `round-i/games/*.json`，以及归档的 `games/<day>/*.json`
     （早先只认「父目录名叫 games」，归档 `games/2026-10-01/x.json` 会被全部漏掉）。 */
  const inGamesDir = (p) => p.split(path.sep).slice(0, -1).includes('games');
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.json$/i.test(name) && inGamesDir(p)) files.push(p);
        else if (/\.jsonl$/i.test(name) && (name === 'games.jsonl' || inGamesDir(p))) jsonls.push(p);
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
  for (const f of jsonls) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let json = null;
      try { json = JSON.parse(s); } catch { continue; }
      const rec = gameRecord(json);
      if (rec) recs.push(rec);
    }
  }
  /* 同一局可能同时出现在 `games/*.json` 与 `games.jsonl` 里（本地故意存两份：前者方便单局排查，
     后者是 D11 的「一个文件好上传」形态）⇒ 按 gameUid 去重，否则同一局会被算两次 Elo。
     没有 gameUid 的老记录退化成「同 exported + 同身份 + 同手数 + 同结果」当同一局。 */
  const seen = new Set();
  const uniq = [];
  for (const r of recs) {
    const key = r.gameUid || `${r.exported}|${r.black}|${r.white}|${r.plies}|${r.result}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  uniq.sort((a, b) => (a.exported || a.tag).localeCompare(b.exported || b.tag) || (a.gameUid || '').localeCompare(b.gameUid || ''));
  return uniq;
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

/* ---------------- Bradley–Terry（P5）：比顺序 Elo 更稳的点估计 + bootstrap 区间 ----------------
 *
 * 为什么顺序 Elo 不够：`computeElo` 是**时间序**迭代（K=16 逐局更新），最终读数依赖局序与谁先跑，
 * 且身份多、局数少时同一批棋谱换个顺序能差出十几 Elo；而」阶梯实验要比的是**跨档位**的差，
 * 需要的是一个只依赖「谁跟谁打了多少局、拿到多少分」的点估计。
 *
 * 模型：P(i 胜 j) = 1 / (1 + 10^((Δj − Δi)/400))，和棋按 0.5 分（与 Wilson 的 `hits` 同口径）。
 * 拟合：MM（minorization–maximization，Hunter 2004）迭代 `p_i ← (W_i + ridge/2) / (Σ_j n_ij/(p_i+p_j) + ridge)`，
 * 其中 W_i 是 i 的总得分、n_ij 是 i–j 的局数；`ridge` 是 Gamma 先验的强度（默认 0.5），
 * **它不是装饰**：全胜/全负的身份 MLE 在无穷远处，没有先验时 p_i 会一路发散（20 战全胜 ⇒ 有限但很大的数）。
 *
 * 尺度：BT 只能定到「加一个常数」（p 乘一个因子），所以必须选零点。约定
 *   ① `anchor` 给了且数据里有 ⇒ 该身份 Δ = 1500、其他人 Δ 为相对它的差；
 *   ② 没给 anchor ⇒ 按所有身份的**均值居中**（Δ 之和为 0），并在报表里写明用了哪种。
 * 这与 `computeElo` 的 1500 起点兼容：`rating = 1500 + Δ`。
 */

/** BT 拟合的默认参数（`ridge` 见上；`iterations` 是 MM 上限）。 */
export const BT_DEFAULTS = Object.freeze({ iterations: 500, tol: 1e-9, ridge: 0.5 });

/** 阶梯实验的固定基线身份：给了就用它当 0 点，报表里跨轮可比。 */
export const DEFAULT_ANCHOR = 'rapfi||500';

/** 确定性 PRNG（bootstrap 要可复现：同样的输入 + 同样的 seed ⇒ 同样的区间）。 */
export function mulberry32(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把棋谱聚合成 BT 的充分统计量：{ids, pairs（无向对局数）, points（总得分）, games}。 */
export function aggregateBt(records) {
  const ids = [];
  const index = new Map();
  const idOf = (name) => {
    if (!index.has(name)) { index.set(name, ids.length); ids.push(name); }
    return index.get(name);
  };
  const pairs = new Map(); // `${min}|${max}` → {i, j, n}
  const points = new Map(); // id → 总得分（胜 1 / 和 0.5 / 负 0）
  const games = new Map();
  const bump = (m, k, d) => m.set(k, (m.get(k) || 0) + d);
  for (const r of records) {
    const i = idOf(r.black);
    const j = idOf(r.white);
    if (i === j) continue; // 自己打自己（不该有）不计，免得分母出现 p_i+p_i 的退化项
    const lo = Math.min(i, j); const hi = Math.max(i, j);
    const key = lo + '|' + hi;
    if (!pairs.has(key)) pairs.set(key, { i: lo, j: hi, n: 0 });
    pairs.get(key).n += 1;
    bump(points, i, r.blackScore);
    bump(points, j, 1 - r.blackScore);
    bump(games, i, 1);
    bump(games, j, 1);
  }
  return { ids, pairs, points, games };
}

/**
 * MM 拟合。返回 `{deltas: Map<id, Δ>, iterations, converged, maxDelta, anchor, prior}`。
 * `agg` 来自 `aggregateBt()`；`anchor` 不在数据里时退化成均值居中并把 `anchor` 记成 null。
 */
export function fitBt(agg, opts = {}) {
  /* `{...BT_DEFAULTS, ...opts}` 不够：调用方传 `ridge: undefined` 会把默认值覆盖成 undefined ⇒ 全程 NaN
     （bootstrap 一路 `opts.ridge` 透传时就踩过）。逐个字段取默认。 */
  const iterations = Number.isFinite(opts.iterations) ? opts.iterations : BT_DEFAULTS.iterations;
  const tol = Number.isFinite(opts.tol) ? opts.tol : BT_DEFAULTS.tol;
  const ridge = Number.isFinite(opts.ridge) ? opts.ridge : BT_DEFAULTS.ridge;
  const n = agg.ids.length;
  const deltas = new Map();
  const anchorWanted = opts.anchor || null;
  const anchor = anchorWanted && agg.ids.includes(anchorWanted) ? anchorWanted : null;
  if (n === 0) return { deltas, iterations: 0, converged: true, maxDelta: 0, anchor: null, prior: ridge };
  const p = new Array(n).fill(1);
  const denom = new Array(n).fill(0);
  let used = 0;
  let maxDelta = 0;
  let converged = false;
  for (let it = 1; it <= iterations; it += 1) {
    used = it;
    denom.fill(ridge);
    for (const { i, j, n: cnt } of agg.pairs.values()) {
      denom[i] += cnt / (p[i] + p[j]);
      denom[j] += cnt / (p[i] + p[j]);
    }
    let worst = 0;
    const next = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const w = (agg.points.get(i) || 0) + ridge / 2;
      const v = w / denom[i];
      next[i] = v;
      worst = Math.max(worst, Math.abs(Math.log(v / p[i])));
    }
    for (let i = 0; i < n; i += 1) p[i] = next[i];
    maxDelta = worst;
    if (worst < tol) { converged = true; break; }
  }
  /* p → Δ（Elo 尺度）；再按 anchor / 均值定零点 */
  const raw = p.map((v) => 400 * Math.log10(v));
  let shift;
  if (anchor) {
    shift = raw[agg.ids.indexOf(anchor)];
  } else {
    shift = raw.reduce((s, v) => s + v, 0) / n;
  }
  for (let i = 0; i < n; i += 1) deltas.set(agg.ids[i], Math.round((raw[i] - shift) * 10) / 10);
  if (anchor) deltas.set(anchor, 0); // 锚点严格 0（浮点误差也不许冒出来）
  return { deltas, iterations: used, converged, maxDelta, anchor, prior: ridge };
}

/**
 * BT 点估计。`opts.anchor` 缺省取 `DEFAULT_ANCHOR`（数据里有 `rapfi||500` 就用它当 0 点，
 * 否则均值居中）；返回值里的 `rating` 是 1500 基准（= 1500 + Δ），与顺序 Elo 同表可读。
 */
export function computeBt(records, opts = {}) {
  const wanted = opts.anchor === undefined ? DEFAULT_ANCHOR : opts.anchor;
  const agg = aggregateBt(records);
  const fit = fitBt(agg, { ...opts, anchor: wanted });
  const rating = new Map();
  for (const [id, d] of fit.deltas) rating.set(id, Math.round((1500 + d) * 10) / 10);
  return { ...fit, rating, games: agg.games, ids: agg.ids };
}

/** 百分位（对已排序数组，线性插值）。 */
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 局级 bootstrap 区间（percentile 法）：按**局**有放回重采样，每次重新拟合 BT，取 2.5%/97.5% 分位。
 * 为什么按局：一局的胜负是这里唯一的随机单位；**注意它不利用配对结构**（同一开局换色双跑的两局
 * 是相关的，按局重采样会把区间估得偏窄）——所以配对比分仍要单独看，这条只用来给「跨档位差」一个量级。
 */
export function bootstrapBt(records, opts = {}) {
  const iterations = opts.bootstrap === undefined ? 400 : Number(opts.bootstrap);
  const seed = opts.seed === undefined ? 20261004 : Number(opts.seed);
  const wanted = opts.anchor === undefined ? DEFAULT_ANCHOR : opts.anchor;
  const point = computeBt(records, opts);
  if (!Number.isFinite(iterations) || iterations <= 0 || records.length === 0) {
    return { point, samples: new Map(), iterations: 0, seed, anchor: point.anchor };
  }
  const rand = mulberry32(seed);
  const draws = new Map(); // id → 排序后的 Δ 数组
  for (const id of point.ids) draws.set(id, []);
  for (let b = 0; b < iterations; b += 1) {
    const sample = new Array(records.length);
    for (let k = 0; k < records.length; k += 1) sample[k] = records[Math.floor(rand() * records.length)];
    const fit = fitBt(aggregateBt(sample), {
      anchor: wanted, ridge: opts.ridge, iterations: Math.min(opts.iterations || BT_DEFAULTS.iterations, 200), tol: 1e-7,
    });
    for (const [id, d] of fit.deltas) {
      const arr = draws.get(id);
      if (arr) arr.push(d);
    }
  }
  const samples = new Map();
  for (const [id, arr] of draws) {
    if (arr.length === 0) { samples.set(id, null); continue; }
    arr.sort((a, b) => a - b);
    samples.set(id, {
      lo: Math.round(percentile(arr, 0.025) * 10) / 10,
      hi: Math.round(percentile(arr, 0.975) * 10) / 10,
      median: Math.round(percentile(arr, 0.5) * 10) / 10,
      draws: arr.length,
      /* 出现率 < 80% 说明这个身份在重采样里经常缺席（局数太少）⇒ 区间不可读 */
      coverage: arr.length / iterations,
    });
  }
  return { point, samples, iterations, seed, anchor: point.anchor };
}

/** 排行行：Elo + 总局数 + 胜/和/负 + 得分率 + Wilson 95% 区间 + 样本不足标注。 */
export function rankTable(records, K = 16, opts = {}) {
  const { rating, games } = computeElo(records, K);
  /* P5：给了 opts.bt 就一并算 BT 点估计 + bootstrap 区间（缺省不算，保持老调用方逐字不变）。 */
  const bt = opts.bt ? bootstrapBt(records, opts.bt) : null;
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
    const btDelta = bt ? bt.point.deltas.get(id) : null;
    const btSample = bt ? bt.samples.get(id) : null;
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
      /* BT 三件套只在 `opts.bt` 打开时出现（关掉时行形状与老版本逐字一致）：
         相对锚点的 Δ（锚点本人是 0）、bootstrap 区间、区间宽度（Elo 点）。 */
      ...(bt ? {
        btDelta,
        btLo: btSample ? btSample.lo : null,
        btHi: btSample ? btSample.hi : null,
        btWidth: btSample ? Math.round((btSample.hi - btSample.lo) * 10) / 10 : null,
        btDraws: btSample ? btSample.draws : 0,
      } : {}),
    };
  }).sort((a, b) => (bt
    ? (b.btDelta - a.btDelta) || b.games - a.games
    : b.rating - a.rating || b.games - a.games));
}

/** 人读报表（页宽 96）。区间与样本量并排印：小样本先看 ±XX.Xpt，再看点估计。 */
export function formatRankTable(rows) {
  const lines = [];
  const warn = rows.some((r) => !r.enough);
  const withBt = rows.some((r) => r.btDelta != null);
  lines.push(
    '身份（渠道|战术档|思考ms）'.padEnd(40) + 'Elo'.padStart(7) +
    (withBt ? 'BT Δ'.padStart(8) + '95% 区间(BT Δ)'.padStart(19) : '') +
    '局数'.padStart(6) +
    '胜'.padStart(5) + '和'.padStart(5) + '负'.padStart(5) + '得分率'.padStart(8) +
    '95% 区间(Wilson)'.padStart(19) + (warn ? '  ⚠样本不足(<' + MIN_GAMES + ')' : ''),
  );
  for (const r of rows) {
    const rate = ((r.w + r.d * 0.5) / r.games * 100).toFixed(1) + '%';
    const ci = r.ci
      ? '[' + (r.ci.lo * 100).toFixed(1) + '–' + (r.ci.hi * 100).toFixed(1) + ']'
      : '—';
    const btCols = withBt
      ? String(r.btDelta == null ? '—' : r.btDelta).padStart(8) +
        (r.btLo == null ? '—' : '[' + r.btLo + '–' + r.btHi + ']').padStart(19)
      : '';
    lines.push(
      r.identity.padEnd(40) +
      String(r.rating).padStart(7) + btCols +
      String(r.games).padStart(6) + String(r.w).padStart(5) + String(r.d).padStart(5) + String(r.l).padStart(5) +
      rate.padStart(8) + ci.padStart(19) +
      (r.enough ? '' : '  ±' + (r.halfPt == null ? '?' : r.halfPt.toFixed(1)) + 'pt ⚠'),
    );
  }
  if (warn) {
    lines.push('注：样本 < ' + MIN_GAMES + " 局时得分率的 Wilson 95% 区间半宽常在 ±15～±25 pt —— " +
      '区间大面积重叠就不能读作「更强」；跨档位比分不是曲线，要判机制收益得上配对样本。');
  }
  if (withBt) {
    lines.push('注：BT Δ 是 Bradley–Terry 点估计（和棋记 0.5，`ridge` 先验 0.5），区间是**按局** bootstrap 的 2.5%–97.5% 分位；' +
      '它不利用配对结构（同一开局换色双跑的两局相关）⇒ 区间偏窄，判「跨档位是否有差」仍要看配对样本。');
  }
  return lines.join('\n');
}
