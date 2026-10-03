/* meta.ts — 走子元信息归因（迁移自 js/board.js 的 BG.util.aiMoveMeta / aiGameMeta）
 *
 * 为什么单独一个模块：这两支是「棋谱能不能被审计」的全部依据。
 *   aiMoveMeta  每手一行，把「这手是谁下的、概率多少、排第几、走时花了多久」钉在棋谱里；
 *   aiGameMeta  每局一行汇总，带 codeVersion / seed / 战术档，是版本归因的入口。
 * 纯函数、无 DOM、无时间戳（latency 由调用方给），因此可被自检与离线回放复用。
 */
import { getSeed } from './rng.ts';
import { CODE_VERSION } from '../shared/version.ts';
import type { Move } from './types.ts';

/** 每手元信息（全部字段可缺省：老棋谱里没有它们）。 */
export interface AiMoveMeta {
  ch: string | null;
  mdl: string | null;
  conf: number | null;
  p: number | null;
  rank: number | null;
  cands: number | null;
  ms: number | null;
  /** 战术层耗时（ms）：只在真有值时写出；Rapfi/mock 不过战术层、历史棋谱也没有 ⇒ 整个键省略 */
  tacMs?: number | null;
  /** 交给 Jev 决定的候选点数（= 请求里 criteria 键数，≤64）；缺失/非 Jev 侧 ⇒ 整个键省略（C0/m13627） */
  candsSent?: number | null;
  /** 其中带战术标签的点数；同上，只在真有值时写出（C0/m13627） */
  candsLabeled?: number | null;
  tv: string | null;
  [k: string]: unknown;
}

/** 候选点三数（C0/m13627）的均值与样本手数：一局、或一局里的某一侧。
 *  三个数回答三个不同问题：`graded` = 模型给了概率且合法的点数（历史口径 `cands`）、
 *  `sent` = 交给 Jev 决定的候选点数、`labeled` = 其中带战术标签的点数。 */
export interface CandsStat {
  graded: number | null;
  sent: number | null;
  labeled: number | null;
  /** 样本手数（以 `candsSent` 有值的手为准） */
  n: number;
}

export interface AiGameMeta {
  code: string | null;
  topK: number | null;
  seed: number | null;
  aiMoves: number;
  costUsd: number;
  tokens: number;
  latencyMs: { avg: number; max: number } | null;
  /** 战术层耗时汇总：只统计 `tacticsMs` 有值的那些手（即真过了战术层的）。
   *  没有任何样本时**整个键省略**（历史归档没有这个字段，往返一致性靠它）。 */
  tacticsMs?: { avg: number; max: number; n: number };
  /** 候选点三数汇总（C0/m13627）：样本 = 真过了 Jev 候选集的手；无样本时整个键省略。 */
  candStats?: CandsStat;
  conf: number | null;
  tactics: Record<string, number>;
}

/** 保留一位小数（候选点数是「每手几个点」这种量级，整数会丢掉有用信息）。 */
function r1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** 每手归因：非 AI 手或残缺元信息一律返回 null（宁可缺失，也不写半真半假的账）。
 *  入参形态与旧实现一致：直接传 decide 返回的 move（元信息就挂在这个对象上）。 */
export function aiMoveMeta(notation: string, m: Move | Record<string, unknown> | null | undefined): AiMoveMeta | null {
  if (!m || !m.byAI) return null;
  const meta = m as unknown as Record<string, unknown>;
  const top = Array.isArray(meta.top) ? (meta.top as { notation?: unknown; p?: unknown }[]) : [];
  const i = top.findIndex((t) => t && t.notation === notation);
  const hit = i >= 0 ? top[i] : null;
  let p: number | null = null;
  if (hit && typeof hit.p === 'number') p = hit.p;
  else if (i < 0 && typeof meta.p === 'number') p = meta.p;
  const out: AiMoveMeta = {
    ch: typeof meta.channel === 'string' ? meta.channel : null,
    mdl: typeof meta.model === 'string' ? meta.model : null,
    conf: typeof meta.confidence === 'number' ? meta.confidence : null,
    p,
    rank: i >= 0 ? i + 1 : null,
    cands: typeof meta.candidates === 'number' ? meta.candidates : null,
    ms: typeof meta.latencyMs === 'number' ? meta.latencyMs : null,
    tv: typeof meta.tacticsVersion === 'string' ? meta.tacticsVersion : null,
  };
  /* 战术层耗时（m07650）只在真有值时写出：Rapfi/mock 记 null（不是 0），历史棋谱没有这个键，
   * 而「归档反推再导出必须逐字段一致」的往返用例会抓出多写的 `tacMs: null`。 */
  if (typeof meta.tacticsMs === 'number') out.tacMs = meta.tacticsMs;
  /* 候选点三数（C0/m13627）同款纪律：只在是 number 时写出这两个键。
   * `cands` 是 0001 就有的列，历史口径不动；新两键回答「交给 Jev 几个点 / 其中战术层解释了几个」。 */
  if (typeof meta.candsSent === 'number') out.candsSent = meta.candsSent;
  if (typeof meta.candsLabeled === 'number') out.candsLabeled = meta.candsLabeled;
  return out;
}

/** 一局汇总：给 history（每项 = 一手棋谱记录，元信息在 `h.meta`）算版本、种子、成本、
 *  时延、置信度与战术分布。非 AI 手在函数内过滤（aiMoves 必须是「AI 手数」）。 */
export function aiGameMeta(history: { meta?: Move | Record<string, unknown> | null }[] | null | undefined, opts?: { topK?: number } | null): AiGameMeta {
  const o = opts || {};
  const items = (history || []).filter((h) => h && h.meta && (h.meta as Record<string, unknown>).byAI) as { meta: Record<string, unknown> }[];
  let cost = 0, tokens = 0, confSum = 0, confN = 0;
  let msSum = 0, msMax = 0, msN = 0;
  let tacSum = 0, tacMax = 0, tacN = 0;
  /* 候选点三数（C0/m13627）：只统计有值的手，缺的落进样本外（不许用 0 冒充）。 */
  let candGradedSum = 0, candGradedN = 0;
  let candSentSum = 0, candSentN = 0;
  let candLabeledSum = 0, candLabeledN = 0;
  const tactics: Record<string, number> = {};
  items.forEach((h) => {
    const meta = h.meta as unknown as Record<string, unknown>;
    cost += typeof meta.costUsd === 'number' ? meta.costUsd : 0;
    const usage = (meta.usage || {}) as Record<string, unknown>;
    tokens += typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    if (typeof meta.confidence === 'number') { confSum += meta.confidence; confN++; }
    if (typeof meta.latencyMs === 'number') { msSum += meta.latencyMs; msN++; if (meta.latencyMs > msMax) msMax = meta.latencyMs; }
    /* 战术层耗时：只有真跑过战术层的手才有值（Rapfi/mock 是 null）——把 null 排除在样本外，
     * 否则「Jev vs Rapfi」这种混合对局的平均值会被 Rapfi 侧拉低，看着像战术层变快了。 */
    if (typeof meta.tacticsMs === 'number') { tacSum += meta.tacticsMs; tacN++; if (meta.tacticsMs > tacMax) tacMax = meta.tacticsMs; }
    /* 候选点三数：`candidates` 是历史口径（模型给了概率的合法点数），`candsSent`/`candsLabeled`
     * 是 0003 之后才有的（交给 Jev 的点数 / 其中带战术标签的点数）。 */
    if (typeof meta.candidates === 'number') { candGradedSum += meta.candidates; candGradedN++; }
    if (typeof meta.candsSent === 'number') { candSentSum += meta.candsSent; candSentN++; }
    if (typeof meta.candsLabeled === 'number') { candLabeledSum += meta.candsLabeled; candLabeledN++; }
    if (meta.tactics) tactics[String(meta.tactics)] = (tactics[String(meta.tactics)] || 0) + 1;
  });
  const out: AiGameMeta = {
    code: CODE_VERSION || null,
    topK: typeof o.topK === 'number' ? o.topK : null,
    seed: typeof getSeed() === 'number' ? getSeed() : null,
    aiMoves: items.length,
    costUsd: Math.round(cost * 1e6) / 1e6,
    tokens,
    latencyMs: msN ? { avg: Math.round(msSum / msN), max: msMax } : null,
    conf: confN ? Math.round((confSum / confN) * 1000) / 1000 : null,
    tactics,
  };
  /* 战术层耗时只在真有样本时写出（口径同 `aiMoveMeta` 的 `tacMs`）：历史归档没有这个字段，
   * 「反推再导出必须逐字段一致」的往返用例要求没有样本时不多写这个键。 */
  if (tacN) out.tacticsMs = { avg: Math.round(tacSum / tacN), max: tacMax, n: tacN };
  /* 候选点三数（C0/m13627）：一局的均值，样本 = 「真过了 Jev 候选集的手」（`candsSent` 有值）。
   * 同款纪律：没有样本不写这个键。`graded`/`labeled` 可能与 `sent` 的样本数不同（历史手只有前者）。 */
  if (candSentN) {
    out.candStats = {
      graded: candGradedN ? r1(candGradedSum / candGradedN) : null,
      sent: r1(candSentSum / candSentN),
      labeled: candLabeledN ? r1(candLabeledSum / candLabeledN) : null,
      n: candSentN,
    };
  }
  return out;
}
