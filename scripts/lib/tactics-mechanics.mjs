/**
 * scripts/lib/tactics-mechanics.mjs — 机制层读数 + 功效预检门（S0①②，纯函数核、零依赖）
 *
 * 为什么要有它：2026-10-07 元结论说「各层触发阈值都是在同族版本自生成轨迹上标定的 ⇒ 轨迹改写型
 * 优化撞墙」，没被否证的方向是**非轨迹型变量**（模型侧提示工程、开局库、思考档、输出级随机性）。
 * 这类变量**不动任何层阈值**，所以「它到底改变了多少局面」不必跑对局，可以在一套**固定局面集**
 * 上离线数出来。本文件就是那个计数器，口径与 `scripts/lib/tactics-replay.mjs` 完全一致：
 * 无模型平坦口径（`pairs` = 全部合法着法、概率同为 1）、`topK=1` ⇒ 得到的是
 * 「该档接管链在平坦模型下的首选点」，不是「模型会怎么选」。
 *
 * 三种读数：
 *   ① rankCensus   —— 自由手/接管手拆分 + 实走 rank 分布（回答「掷骰子影响多少手」）
 *   ② repeatStats  —— 自报概率分布 vs 实测重复性（回答「模型到底有多确定」）
 *   ③ diffVersions —— 两档在同一局面集上的落点/提示面分歧率 + 功效判决（S0② 预检门）
 *
 * 不做的事：不碰网络、不读 D1；输入只能是本地 JSONL（归档 `games/**`、实验批次的
 * `games.jsonl`、官方基准语料）。所有判定逻辑都在这里，`test/scripts/tactics-mechanics.spec.mjs`
 * 用合成数据钉住。
 */
import { getGame, ids as gameIds, games } from '../../src/core/registry.ts';
import { computeTactics, emptyTactics, mechOf } from '../../src/core/tactics.ts';
import { pickTakeover } from '../../src/core/takeover.ts';
import { allIds as allVersionIds } from '../../src/core/tactics-versions.ts';
import { channelOfPly, recordedLayerOf, runsTacticsChannel, sideIdOf } from './tactics-replay.mjs';

/** 全部合法档号（含 v15/v16/v17 旧别名，历史棋谱的 ai.tv 存的就是旧字符串）。 */
export const TACTICS_IDS = allVersionIds();

/** 五子棋·自由规则引擎。官方基准语料的 `state` 里没有 `forbidden_points_black` ⇒ 自由规则。 */
/** quietShape 会抹掉的「捧场」词（与 src/core/engines/gomoku.ts:1102-1103 的 stripPraise 同源）。 */
export const PRAISE_WORDS = ['you:four', 'you:live3'];

export function gomokuEngine() {
  const g = getGame('gomoku');
  if (!g) throw new Error('registry 里没有 gomoku 引擎');
  return g;
}

/** 棋种解析：先按引擎 id，再按显示名（归档可能写「五子棋」这种名字）。 */
export function resolveEngine(idOrName) {
  const key = String(idOrName || '');
  const direct = getGame(key);
  if (direct) return direct;
  for (const id of gameIds) {
    const g = games[id];
    if (g && (g.name === key || g.id === key)) return g;
  }
  return undefined;
}

/* ────────────────────────────── 通用小工具 ────────────────────────────── */

/** rank 分桶：1/2/3 单列，>3 归 '4+'，缺失归 'null'。 */
export function bucketRank(rank) {
  if (rank === null || rank === undefined || rank === '') return 'null';
  const n = Number(rank);
  if (!Number.isFinite(n)) return 'null';
  return n <= 3 ? String(Math.trunc(n)) : '4+';
}

/** 归一化一张概率表（非法值当 0；总和为 0 时返回空）。 */
export function normProbs(probs) {
  const out = {};
  let sum = 0;
  for (const [k, v] of Object.entries(probs || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) { out[k] = n; sum += n; }
  }
  if (!(sum > 0)) return {};
  for (const k of Object.keys(out)) out[k] /= sum;
  return out;
}

/** Σp²（集中度）、有效选择数 1/Σp²、香农熵（bit）。 */
export function concentration(probs) {
  const p = normProbs(probs);
  let sumP2 = 0, H = 0;
  for (const v of Object.values(p)) {
    sumP2 += v * v;
    H -= v * Math.log2(v);
  }
  return { sumP2, effectiveN: sumP2 > 0 ? 1 / sumP2 : null, entropyBits: H, n: Object.keys(p).length };
}

/** 按概率表排序取前 k（并列时按记法字典序，保证可复现）。 */
export function topOf(probs, k) {
  return Object.entries(normProbs(probs))
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, k);
}

/** 若真按这张分布独立抽 n 次，n 次全一致的概率 = Σ p_i^n。 */
export function expectedUnanimous(probs, n) {
  let s = 0;
  for (const v of Object.values(normProbs(probs))) s += Math.pow(v, n);
  return s;
}

/** 均值。 */
export function mean(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

/* ───────────────────────── ① 自由手 / 接管手与 rank ───────────────────────── */

/**
 * 逐手口径的机制层普查（详见 docs/plans/2026-10-16-v14-v15-stall-next-steps.md §二.1）。
 *
 * 判定「我方」的三条与 tactics-replay 同源：
 *   - 该手所属渠道过战术层（`runsTacticsChannel`；棋谱没写渠道 ⇒ 按「会跑」处理并记数）；
 *   - 该手带模型记账（`move.ai`）——rapfi / human / mock 侧没有 `ai`，直接排除；
 *   - 「接管手」= `move.tactics` 或 `ai.tac` 非空；「自由手」= 其余。
 *
 * @param {object[]} gameRecords 棋谱数组（每局含 `moves`）
 * @returns {object} 纯数据读数
 */
export function rankCensus(gameRecords) {
  const acc = {
    games: gameRecords.length, plies: 0, ours: 0, takeover: 0, free: 0,
    skippedNoAi: 0, skippedChannel: 0, unknownChannel: 0,
    freeRanks: {}, takeoverRanks: {}, layers: {}, channels: {},
    pFree: [], pTac: [], freeBySide: {}, tacBySide: {},
  };
  const bump = (obj, key) => { const k = String(key); obj[k] = (obj[k] || 0) + 1; };
  for (const rec of gameRecords) {
    const moves = (rec && rec.moves) || [];
    for (const m of moves) {
      acc.plies++;
      if (!m || typeof m !== 'object') continue;
      const sideId = sideIdOf(resolveEngine(rec.game || rec.gid || rec.slug || 'gomoku') || gomokuEngine(), m.side) || null;
      const ch = channelOfPly(rec, m, sideId);
      const chKnown = typeof ch === 'string' && ch !== '';
      const runs = chKnown ? runsTacticsChannel(ch) : true;
      if (!chKnown) acc.unknownChannel++;
      if (!runs) { acc.skippedChannel++; continue; }
      const ai = m.ai && typeof m.ai === 'object' ? m.ai : null;
      if (!ai) { acc.skippedNoAi++; continue; }
      acc.ours++;
      bump(acc.channels, ch || '(未写渠道)');
      if (sideId) bump(ai.tac || m.tactics ? acc.tacBySide : acc.freeBySide, sideId);
      const layer = recordedLayerOf(m);
      const rank = bucketRank(ai.rank);
      if (layer) {
        acc.takeover++;
        bump(acc.takeoverRanks, rank);
        bump(acc.layers, layer);
        if (Number.isFinite(Number(ai.p))) acc.pTac.push(Number(ai.p));
      } else {
        acc.free++;
        bump(acc.freeRanks, rank);
        if (Number.isFinite(Number(ai.p))) acc.pFree.push(Number(ai.p));
      }
    }
  }
  const share = (n) => (acc.ours ? n / acc.ours : 0);
  return {
    ...acc,
    takeoverShare: share(acc.takeover),
    freeShare: share(acc.free),
    rankShareFree: distShare(acc.freeRanks, acc.free),
    rankShareTac: distShare(acc.takeoverRanks, acc.takeover),
    pMeanFree: mean(acc.pFree),
    pMeanTac: mean(acc.pTac),
  };
}

/** 把计数表转成占比表。 */
export function distShare(counts, total) {
  const out = {};
  for (const [k, v] of Object.entries(counts || {})) out[k] = total ? v / total : 0;
  return out;
}

/** 多局 census 合并（跨批次累计）。 */
export function mergeCensus(list) {
  const out = rankCensus([]);
  for (const c of list) {
    if (!c) continue;
    out.games += c.games; out.plies += c.plies; out.ours += c.ours;
    out.takeover += c.takeover; out.free += c.free;
    out.skippedNoAi += c.skippedNoAi; out.skippedChannel += c.skippedChannel; out.unknownChannel += c.unknownChannel;
    for (const k of ['freeRanks', 'takeoverRanks', 'layers', 'channels', 'freeBySide', 'tacBySide']) {
      for (const [kk, vv] of Object.entries(c[k] || {})) out[k][kk] = (out[k][kk] || 0) + vv;
    }
    out.pFree.push(...(c.pFree || [])); out.pTac.push(...(c.pTac || []));
  }
  out.takeoverShare = out.ours ? out.takeover / out.ours : 0;
  out.freeShare = out.ours ? out.free / out.ours : 0;
  out.rankShareFree = distShare(out.freeRanks, out.free);
  out.rankShareTac = distShare(out.takeoverRanks, out.takeover);
  out.pMeanFree = mean(out.pFree); out.pMeanTac = mean(out.pTac);
  return out;
}

/* ───────────────────── ② 自报概率分布 vs 实测重复性 ───────────────────── */

/**
 * 同一局面的 k 次独立调用：**比的是「自报概率说了什么」与「实际重复性是多少」**。
 *
 * 三个数最要紧：
 *   - `sumP2`（自报分布的集中度）⇒ 有效选择数 `1/Σp²`；
 *   - `expectedUnanimous` = Σp_i^k ⇒ 若模型真按自报分布抽样，k 次全一致的概率；
 *   - `unanimous` / `modeShare`（实测）⇒ 与上一条比，就知道自报概率偏平了多少倍。
 *
 * @param {object[]} records 每行含 `calls`（数组，元素 `{choice, probs}`）与 `mean`（概率均值表）
 */
export function repeatStats(records, opts) {
  const o = opts || {};
  const rows = [];
  for (const r of records || []) {
    const calls = Array.isArray(r && r.calls) ? r.calls.filter((c) => c && typeof c === 'object') : [];
    if (!calls.length) continue;
    /* 原始表（含 0 概率的候选点）用来数「候选点个数」；归一化表用来算集中度。 */
    const rawMean = r.mean && Object.keys(r.mean).length ? r.mean : averageProbs(calls);
    const meanProbs = normProbs(rawMean);
    if (!Object.keys(meanProbs).length) continue;
    const choices = calls.map((c) => (typeof c.choice === 'string' ? c.choice : null));
    const counts = {};
    for (const c of choices) if (c) counts[c] = (counts[c] || 0) + 1;
    const k = choices.length;
    const modeCount = Math.max(0, ...Object.values(counts));
    const conc = concentration(meanProbs);
    const argmax = topOf(meanProbs, 1)[0] ? topOf(meanProbs, 1)[0][0] : null;
    rows.push({
      id: r.id ?? null, label: r.label ?? null, ply: r.ply ?? null,
      k, unanimous: Object.keys(counts).length === 1, modeShare: k ? modeCount / k : 0,
      sumP2: conc.sumP2, effectiveN: conc.effectiveN, entropyBits: conc.entropyBits,
      cands: Object.keys(rawMean).length,
      p1: topOf(meanProbs, 1)[0] ? topOf(meanProbs, 1)[0][1] : 0,
      top3: Object.values(meanProbs).sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0),
      expectedUnanimous: expectedUnanimous(meanProbs, k),
      argmax, agreesWithMean: choices.filter((c) => c === argmax).length,
      meanProbs,
      /* 逐次调用的概率表（重采样稳定性要用）；缺 probs 的调用是 null。 */
      callProbs: calls.map((c) => (c.probs && Object.keys(c.probs).length ? normProbs(c.probs) : null)),
    });
  }
  const summary = {
    positions: rows.length,
    meanCands: mean(rows.map((r) => r.cands)),
    p1Mean: mean(rows.map((r) => r.p1)),
    top3Mean: mean(rows.map((r) => r.top3)),
    sumP2Mean: mean(rows.map((r) => r.sumP2)),
    effectiveNMean: mean(rows.map((r) => r.effectiveN)),
    entropyMean: mean(rows.map((r) => r.entropyBits)),
    observedUnanimous: rows.length ? rows.filter((r) => r.unanimous).length / rows.length : 0,
    expectedUnanimous: mean(rows.map((r) => r.expectedUnanimous)),
    modeShareMean: mean(rows.map((r) => r.modeShare)),
    callAgreementMean: mean(rows.map((r) => (r.k ? r.agreesWithMean / r.k : 0))),
  };
  /* 「有效选择数」按**聚合口径**报（1 / 平均 Σp²），与计划里已登记的 8.6 同口径；
     逐局面 1/Σp² 的均值是另一个数（Jensen 不等式 ⇒ 更大，16.7），容易误读，只作附注。 */
  summary.effectiveNAggregate = summary.sumP2Mean > 0 ? 1 / summary.sumP2Mean : null;
  summary.determinismGap = (summary.expectedUnanimous > 0)
    ? summary.observedUnanimous / summary.expectedUnanimous : null;
  summary.resample = o.resample === false ? null : resampleAgreement(rows);
  return { summary, rows };
}

/** k 次调用概率的算术均值（缺 probs 的调用跳过）。 */
export function averageProbs(calls) {
  const out = {};
  let n = 0;
  for (const c of calls) {
    const p = c && c.probs && typeof c.probs === 'object' ? c.probs : null;
    if (!p) continue;
    n++;
    for (const [k, v] of Object.entries(p)) {
      const num = Number(v);
      if (Number.isFinite(num)) out[k] = (out[k] || 0) + num;
    }
  }
  if (!n) return {};
  for (const k of Object.keys(out)) out[k] /= n;
  return out;
}

/**
 * 多采样聚合的稳定性：**N 次调用平均后的 argmax** 与「全部 k 次的 argmax」的一致率。
 * 对每个 N 枚举全部 C(k,N) 个子集（k=6 时最多 20 个），所以 N=k 恒为 100%。
 */
export function resampleAgreement(rows, maxN) {
  const k = rows.length ? Math.max(...rows.map((r) => r.k)) : 0;
  const kmax = Math.min(maxN || k, k);
  const out = {};
  for (let n = 1; n <= kmax; n++) {
    let hit = 0, tot = 0, flat = 0;
    for (const r of rows) {
      const probsList = (r.callProbs || []).filter((p) => p && Object.keys(p).length);
      if (probsList.length < n) continue;
      const base = r.argmax;
      for (const combo of combinations(probsList.length, n)) {
        const probs = averageProbs(combo.map((i) => ({ probs: probsList[i] })));
        if (!Object.keys(probs).length) continue;
        const top = topOf(probs, 2);
        tot++;
        if (top[0] && top[0][0] === base) hit++;
        if (top.length === 2 && top[0][1] - top[1][1] < 0.03) flat++;
      }
    }
    out[n] = { agreement: tot ? hit / tot : null, pairs: tot, flatTop2: tot ? flat / tot : 0 };
  }
  return out;
}

/** 组合枚举（n ≤ 10 用得上；纯整数，避免依赖）。 */
export function combinations(n, k) {
  const out = [];
  const cur = [];
  const walk = (start) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < n; i++) { cur.push(i); walk(i + 1); cur.pop(); }
  };
  walk(0);
  return out;
}

/* ───────────────────── ③ 局面重建（官方基准语料 → 引擎状态） ───────────────────── */

/**
 * 用 `state.black_stones` / `white_stones`（交替）逐手重放，重建引擎状态。
 * 之后校验轮次与手数对得上；对不上就 throw（**绝不静默兜底**：错的重建会让分歧率全错）。
 */
export function rebuildState(engine, state) {
  if (!state || typeof state !== 'object') throw new Error('state 不是对象');
  const blacks = Array.isArray(state.black_stones) ? state.black_stones : [];
  const whites = Array.isArray(state.white_stones) ? state.white_stones : [];
  const seq = [];
  for (let i = 0; i < Math.max(blacks.length, whites.length); i++) {
    if (i < blacks.length) seq.push(blacks[i]);
    if (i < whites.length) seq.push(whites[i]);
  }
  /* 语料里的 black_stones / white_stones **不保证是时间序**（实测 500 行里 316 行的
     last_move 与交替拼接的末位不符），但 `last_move` 是权威的「最后一手」。棋盘只由棋子集合
     决定、与落子顺序无关，唯一吃顺序的是 `st.last`（决定 board_ascii 里的小写标记，
     也可能被战术层读到）——所以把 last_move 那枚棋子挪到序列末尾即可精确复现。 */
  let st = engine.newGame();
  for (const nota of seq) {
    const mv = engine.moveFromNotation(st, String(nota));
    if (!mv) throw new Error(`重建失败：${nota} 在第 ${st.moveNum} 手后非法`);
    st = engine.applyMove(st, mv);
  }
  const side = sideIdOf(engine, state.you_play);
  if (side && st.turn !== side) throw new Error(`重建失败：轮次 ${st.turn} ≠ you_play ${state.you_play}`);
  /* 保真：语料里的 `last_move` 是权威的「最后一手」，但黑白子列表**内部顺序不保证是时间序**
     （实测 500 行里 316 行与交替拼接的末位不符）⇒ 不能靠重排落子序列去凑，那会打乱黑白交替、
     把整盘串色（踩过）。棋子颜色只由交替决定，所以正确做法是重放完再**覆写 st.last**：
     board_ascii 的小写标记与序列化里的 last_move 都取自它。 */
  const lastMove = typeof state.last_move === 'string' ? state.last_move.trim() : '';
  if (lastMove && !/^none\b/i.test(lastMove)) {
    const m = /^(black|white)\s+([A-Za-z]\d{1,2})$/.exec(lastMove);
    if (!m) throw new Error(`重建失败：last_move "${lastMove}" 解析不出「颜色 坐标」`);
    const sideName = m[1].toLowerCase();
    const note = m[2].toUpperCase();
    const c = note.charCodeAt(0) - 65;
    const r = Number(note.slice(1)) - 1;
    const p = (r >= 0 && r < 15 && c >= 0 && c < 15) ? st.board[r][c] : 0;
    const want = sideName === 'black' ? 1 : 2;
    if (p !== want) throw new Error(`重建失败：last_move ${lastMove} 处不是该色棋子（board=${p}）`);
    st.last = { notation: note, r, c, side: sideName };
  }
  const mn = Number(state.move_number);
  if (Number.isFinite(mn) && st.moveNum + 1 !== mn) throw new Error(`重建失败：手数 ${st.moveNum + 1} ≠ move_number ${mn}`);
  return st;
}

/* ───────────────── ④ 单档决策（与 tactics-replay 同口径）+ 两档分歧 ───────────────── */

/**
 * 在某局面上算「该档接管链在平坦模型下的首选点」。
 * @returns {{layer: string|null, notation: string|null, crit: object, instructions: string, cands: string[], ms: number}}
 */
export function versionDecision(engine, st, side, versionId, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const M = mechOf(versionId);
  /* 与 src/core/jev/client.ts:649 同源：quietShape 必须透传给引擎，否则 v15 的 criteria 会多出
     you:four/you:live3（旧 tactics-replay 就没传，是它的保真缺口）。 */
  const ser = engine.serializeForJev(st, side, M.quietShape === true ? { quietShape: true } : undefined);
  const q = (ser.questions || {}).move || {};
  const crit = q.criteria || {};
  const instructions = typeof q.instructions === 'string' ? q.instructions : '';
  const cands = Object.keys(crit);
  const legal = o.legal || engine.getLegalMoves(st);
  let tactics;
  try { tactics = computeTactics(engine, st, legal, cands, versionId); }
  catch (err) { tactics = emptyTactics(); }
  const tk = pickTakeover({
    engine, st, tactics, mech: M, criteria: crit,
    legal, pairs: legal.map((mv) => [mv.notation, 1]), cands, topK: 1,
  });
  return { layer: tk.layer || null, notation: tk.layer ? tk.notation : null, crit, instructions, cands, ms: Date.now() - t0 };
}

/** 两张 criteria 表的差异（只比非空标签，空/缺省等价）。 */
export function criteriaDiff(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const x = (a && a[k]) || null, y = (b && b[k]) || null;
    if (x !== y) out.push({ point: k, a: x, b: y });
  }
  return out;
}

/**
 * S0② 功效预检门：同一批固定局面，两档逐局面比「接管层 + 落点」与「提示面（criteria）」。
 *
 * 三类判定（与 docs/plans/2026-10-16-v14-v15-stall-next-steps.md §五 S0② 一致）：
 *   - **决策分歧**：接管层不同（含「一档接管、另一档不接管」）或同层但落点不同 ⇒ 真的会换手；
 *   - **提示面分歧**：决策相同，但 criteria / instructions 文本不同 ⇒ 只改模型看到的信息；
 *   - **总改变**：两者之一。
 *
 * @param {object[]} rows 语料行（含 `state`，`state.you_play` 决定行棋方）
 * @param {{engine?: object, a: string, b: string, limit?: number, verify?: boolean, onProgress?: Function}} opts
 */
export function diffVersions(rows, opts) {
  const o = opts || {};
  const engine = o.engine || gomokuEngine();
  const limit = Number.isFinite(Number(o.limit)) && Number(o.limit) > 0 ? Math.trunc(Number(o.limit)) : Infinity;
  const out = {
    a: o.a, b: o.b, positions: 0, compared: 0,
    decisionChanged: 0, criteriaOnlyChanged: 0, totalChanged: 0, instructionChanged: 0,
    takeoverAOnly: 0, takeoverBOnly: 0, bothTakeoverDifferent: 0,
    kindCounts: { freeToFree: 0, takeoverToTakeover: 0, takeoverToFree: 0, freeToTakeover: 0 },
    details: [], mismatches: [], fidelity: { checked: 0, boardOk: 0, criteriaOk: 0, quietShapeArtefacts: 0 },
    ms: 0,
  };
  let seen = 0;
  for (const row of rows || []) {
    out.positions++;
    if (seen >= limit) continue;
    seen++;
    let st;
    try { st = rebuildState(engine, row.state); }
    catch (err) { out.mismatches.push({ id: row.id ?? null, why: String((err && err.message) || err) }); continue; }
    const side = sideIdOf(engine, row.state.you_play) || String(row.state.you_play || '');
    const da = versionDecision(engine, st, side, o.a);
    const db = versionDecision(engine, st, side, o.b);
    out.ms += da.ms + db.ms;
    /* 保真自检：用**该行自己那一档**（`label`）重算，board_ascii 与 criteria 必须逐字等于语料记录。
       这一条是「分歧率可信」的前提——重建错一个子，后面全是错的。 */
    if (o.verify !== false && row.label) {
      const self = versionDecision(engine, st, side, row.label);
      out.fidelity.checked++;
      const boardOk = self.crit && row.state.board_ascii
        ? (engine.serializeForJev(st, side, undefined).state.board_ascii === row.state.board_ascii) : null;
      if (boardOk) out.fidelity.boardOk++;
      const recCrit = row.criteria || {};
      const cd = criteriaDiff(self.crit, recCrit);
      const criteriaOk = cd.length === 0 && Object.keys(self.crit).length === Object.keys(recCrit).length;
      if (criteriaOk) out.fidelity.criteriaOk++;
      else {
        /* 语料采集口径差异（**预期，不是重建错**）：语料里 v15 行的 criteria 是**没过 quietShape**
           的原始标签（实测 150 行里 22 行含 you:four/you:live3），而该档真正发出的是抹过 praise 的
           版本 ⇒ 逐字比对必然差这 22 行。只要差异**全部**是「我方 null、语料是 praise 词」，
           就归到 quietShapeArtefacts，不计入 mismatches。 */
        const allPraiseStripped = cd.length > 0 && cd.every((x) => {
          const mineV = x.a, recV = x.b;
          return (mineV === null || mineV === '') && typeof recV === 'string' && recV.split('+').every((p) => PRAISE_WORDS.includes(p));
        });
        if (allPraiseStripped) out.fidelity.quietShapeArtefacts = (out.fidelity.quietShapeArtefacts || 0) + 1;
        else out.mismatches.push({ id: row.id ?? null, why: 'criteria 与语料记录不一致', label: row.label, diff: cd.slice(0, 4) });
      }
    }
    const critD = criteriaDiff(da.crit, db.crit);
    const instrD = da.instructions !== db.instructions;
    const sameLayer = da.layer === db.layer;
    const decision = !sameLayer || (!!da.layer && da.notation !== db.notation);
    if (decision) out.decisionChanged++;
    else if (critD.length || instrD) out.criteriaOnlyChanged++;
    if (critD.length || instrD || decision) out.totalChanged++;
    if (instrD) out.instructionChanged++;
    if (da.layer && !db.layer) out.takeoverAOnly++;
    if (!da.layer && db.layer) out.takeoverBOnly++;
    if (da.layer && db.layer && da.notation !== db.notation) out.bothTakeoverDifferent++;
    out.kindCounts[da.layer ? (db.layer ? 'takeoverToTakeover' : 'takeoverToFree') : (db.layer ? 'freeToTakeover' : 'freeToFree')]++;
    if (decision || critD.length || instrD) {
      out.details.push({
        id: row.id ?? null, ply: row.ply ?? null, side, label: row.label ?? null,
        decision, layerA: da.layer, layerB: db.layer, notaA: da.notation, notaB: db.notation,
        critPoints: critD.length, critDiff: critD.slice(0, 6), instructionChanged: instrD,
      });
    }
    if (o.onProgress) o.onProgress(out.compared + 1, out.positions);
    out.compared++;
  }
  const rate = (n) => (out.compared ? n / out.compared : 0);
  out.decisionRate = rate(out.decisionChanged);
  out.criteriaOnlyRate = rate(out.criteriaOnlyChanged);
  out.totalRate = rate(out.totalChanged);
  out.verdict = verdictFor(out.totalRate, out.decisionRate, out.criteriaOnlyRate,
    { changed: out.criteriaOnlyChanged, positions: out.compared });
  return out;
}

/**
 * 三条阈值的判决（人话）。阈值形状由计划写死：
 *   <2% ⇒ 行为等价、结案；2–5% ⇒ 需要 ≥400 对；>5% ⇒ 120 局可判。
 * 判据取**总改变率**（提示面改了也算改了模型输入）；同时给出决策分歧率的独立读数。
 */
export function verdictFor(totalRate, decisionRate, criteriaOnlyRate, counts) {
  const r = Number.isFinite(totalRate) ? totalRate : 0;
  const d = Number.isFinite(decisionRate) ? decisionRate : 0;
  const c = Number.isFinite(criteriaOnlyRate) ? criteriaOnlyRate : 0;
  if (r < 0.02) {
    return { key: 'equivalent', rate: r, decisionRate: d,
      text: `总改变率 ${(r * 100).toFixed(2)}% < 2% ⇒ **判行为等价**：按计划结案，不开批次（省下 120–400 局）` };
  }
  /* 战术层零改变、只有提示面变 ⇒ 离线门**判不了**：这不再是「战术改动」，而是「模型输入改动」，
     该问的问题变成「模型认不认这几个词」。别拿它去开 120 局批次（那是拿对局去测 prompt 敏感度）。 */
  if (d === 0) {
    return { key: 'model-side', rate: r, decisionRate: d, criteriaOnlyRate: c,
      text: `决策分歧率 0.00%、只有提示面变 ${(c * 100).toFixed(2)}% ⇒ **改动全部落在模型输入面**（战术层逐层逐点不变）：离线门判不了它，` +
        `但也**不必**开 120 局批次——只需模型探针：拿会变的 ${(counts && counts.changed) || Math.round(c * ((counts && counts.positions) || 0))} 个局面各问一次两版 criteria` +
        `（${2 * ((counts && counts.changed) || 0)} 次调用），量 top-1 变化率` };
  }
  if (r <= 0.05) {
    return { key: 'underpowered', rate: r, decisionRate: d,
      text: `总改变率 ${(r * 100).toFixed(2)}% ∈ [2%,5%] ⇒ **120 局无功效**，要判就得 ≥400 对（约 ${Math.ceil(400 / 2)} 局 ×2 臂）` };
  }
  return { key: 'judgeable', rate: r, decisionRate: d,
    text: `总改变率 ${(r * 100).toFixed(2)}% > 5% ⇒ **120 局可判**（决策分歧率 ${(d * 100).toFixed(2)}% 是真换手比例）` };
}

/* ───────────────────────────────── 展示 ───────────────────────────────── */

/** 百分比字符串（默认一位小数）。 */
export function pct(x, digits) {
  if (!Number.isFinite(x)) return '—';
  return (x * 100).toFixed(digits === undefined ? 1 : digits) + '%';
}

/** 数字（默认两位小数，null → —）。 */
export function num2(x, digits) {
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(digits === undefined ? 2 : digits);
}
