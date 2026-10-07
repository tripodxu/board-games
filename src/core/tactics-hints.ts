/* tactics-hints.ts — 战术模式提示（棋盘分层颜色标记）的纯计算层。
 *
 * 业主需求：「使用模式识别给出的待选位置，每一级用不同的颜色标出来，展示战术模式识别的能力，
 * 开放给使用者作为提示」。本模块把接管链各层的**待选点集**（全部来自 computeTactics 的既有事实，
 * 零新增搜索）按 TAKEOVER_ORDER 优先级整理成带颜色的标记与图例：
 *   - 机制门控（mechOf）天然实现「v1–v16 都这样」：切到 v3 只见它的 5 层、v16 见全部 14 层；
 *   - 同一点只归最高优先层（与接管链「先到先得」同构）；
 *   - 第一个有点的层 = 「接管」层（真实接管还会做层内挑选，这里只标层，是近似但不撒谎）。
 *
 * 纯逻辑、零 DOM：颜色表与标记结构都可被引擎 draw 与 DOM 图例两端消费。
 */
import { TAKEOVER_LABEL, TAKEOVER_ORDER } from './takeover.ts';
import { computeTactics, mechOf, resolveVersion } from './tactics.ts';
import type { Engine } from './types.ts';

/** 每个接管层的标记色（图例与棋盘圆点共用；hsl 手挑的 14 个可分辨色相）。 */
export const LAYER_COLORS: Record<string, string> = Object.freeze({
  win: '#e53935',          // 红 · 我方一步成五
  block: '#fb8c00',        // 橙 · 对手成五点的占位挡点
  open4: '#fdd835',        // 黄 · 我方活四点
  threat: '#9e9d24',       // 橄榄 · 2-ply 造杀点
  vcfAttack: '#7cb342',    // 草绿 · 连续冲四将死链
  vctAttack: '#2e7d32',    // 深绿 · 连续威胁链首步
  vcfDefense: '#00897b',   // 青 · 将死链干预点
  vctDefense: '#1e88e5',   // 蓝 · 拆连续威胁链
  pressureGate: '#5e35b1', // 紫 · 削对手做四点
  live3Attack: '#8e24aa',  // 紫红 · 活三抢攻点
  live3Defense: '#d81b60', // 玫红 · 拆活三点
  parry: '#5c6bc0',        // 靛 · 对手杀点（画环）
  parry3: '#00acc1',       // 淡青 · 活三/活四预挡点
  parry4: '#795548',       // 棕 · 冲四预挡点
});

/** 棋盘上的一个标记：候选点 + 归属层 + 是否对手威胁点（画环）+ 是否接管层。 */
export interface TacticMark {
  notation: string;
  layer: string;
  /** true = 对手的威胁点（如 parry 的杀点），画圆环；false = 我方可走的待选点，画实心圆。 */
  opp: boolean;
  /** 归属层是否为「接管」层（第一个有点的层）。 */
  fire: boolean;
}

/** 图例条目（DOM 图例的渲染数据）。 */
export interface TacticLegendItem {
  layer: string;
  label: string;
  color: string;
  count: number;
  fire: boolean;
}

export interface TacticHint {
  /** 实际生效的档位 id（图例标题用）。 */
  version: string;
  marks: TacticMark[];
  legend: TacticLegendItem[];
}

/** 单层最多画多少个点（live3_you 这类集合可能很大，兜住画布可读性）。 */
const MARKS_PER_LAYER = 12;

/**
 * 计算当前局面的分层提示。与接管链同源不同责：接管链挑**一个**点落子，
 * 这里把**每层会考虑的点**都摊开给使用者看。
 *
 * `versionId` 传当前侧配置的战术档（空 = 当前档；未知 = 空机制集，与 computeTactics 同口径）。
 * 开局前 `openingMin`（默认 4）手内 computeTactics 返回空报告 ⇒ marks 为空（图例隐藏）。
 */
export function computeTacticHints(engine: Engine, st: unknown, versionId?: string | null): TacticHint {
  const ver = resolveVersion(versionId);
  /* 开局短路（与 computeTactics 的 openingMin 同口径）：前 4 手无战术事实，标记与图例全空。
     必须在这里挡住——open4/parry3/parry4 的点来自 criteria 标签，不吃 computeTactics 的短路。 */
  const moveNum = (st as { moveNum?: number }).moveNum ?? 0;
  if (moveNum < ver.openingMin) return { version: ver.id, marks: [], legend: [] };
  const mech = mechOf(ver.id);
  const legal = engine.getLegalMoves(st);
  /* criteria 与接管链同源：serializeForJev 的候选标签（open4/parry3/parry4 三层从这里扫） */
  let criteria: Record<string, unknown> = {};
  try {
    const ser = engine.serializeForJev(st, (st as { turn?: string }).turn || engine.sides[0]?.id || '');
    criteria = (ser?.questions?.move?.criteria ?? {}) as Record<string, unknown>;
  } catch { /* 序列化失败 = 无候选标签，其余层照常 */ }
  const cands = Object.keys(criteria);
  const report = computeTactics(engine, st, legal, cands, ver.id);
  const danger = report.danger_points_opponent ?? [];

  /* 每层的点集与侧别；条件与 pickTakeover 的分支一致（这里只读事实，不做任何落子决策）。 */
  const byLabel = (needle: string): string[] =>
    Object.entries(criteria)
      .filter(([, v]) => typeof v === 'string' && String(v).includes(needle))
      .map(([n]) => n);
  const sets: { layer: string; points: string[]; opp: boolean }[] = [];
  const push = (layer: string, points: string[] | null | undefined, opp = false): void => {
    if (!mech[layer]) return;
    const list = (points ?? []).filter((x) => typeof x === 'string' && x);
    if (list.length) sets.push({ layer, points: list, opp });
  };
  push('win', report.winning_points_you);
  push('block', report.winning_points_opponent);
  push('open4', byLabel('you:open4'));
  push('threat', report.chance_points_you);
  push('vcfAttack', report.vcf_win_you);
  push('vctAttack', report.vct_win_you);
  push('vcfDefense', report.vcf_win_opponent);
  push('vctDefense', report.vct_win_opponent);
  if ((report.pressure_opponent ?? 0) > (report.pressure_you ?? 0) && !danger.length) {
    push('pressureGate', report.pressure_cut_points);
  }
  if (!danger.length) push('live3Attack', report.live3_you);
  if (!danger.length) push('live3Defense', report.live3_deny_points);
  push('parry', danger, true);
  if (!danger.length) {
    push('parry3', byLabel('deny:open4').concat(byLabel('deny:live3')));
    push('parry4', byLabel('deny:four'));
  }

  /* 按优先级去重 + 封顶；第一个有点的层 = 接管层。
   * 去重只在**我方落点（实心）**之间进行——parry 的对手杀点（圆环）语义不同
   * （「这里是对手杀点」与「block 层会占这里」可以同时成立），绕过点去重。 */
  const claimed = new Set<string>();
  const marks: TacticMark[] = [];
  const legend: TacticLegendItem[] = [];
  let fireLayer: string | null = null;
  /* sets 已按 TAKEOVER_ORDER 推入；再显式排序一次防未来插入顺序漂移 */
  sets.sort((x, y) => TAKEOVER_ORDER.indexOf(x.layer) - TAKEOVER_ORDER.indexOf(y.layer));
  for (const s of sets) {
    let count = 0;
    for (const n of s.points) {
      if (count >= MARKS_PER_LAYER) break;
      if (!s.opp) {
        if (claimed.has(n)) continue;
        claimed.add(n);
      }
      count += 1;
      marks.push({ notation: n, layer: s.layer, opp: s.opp, fire: false });
    }
    if (count > 0) {
      if (!fireLayer) fireLayer = s.layer;
      legend.push({ layer: s.layer, label: TAKEOVER_LABEL[s.layer] ?? s.layer, color: LAYER_COLORS[s.layer] ?? '#8a939e', count, fire: false });
    }
  }
  if (fireLayer) {
    for (const m of marks) if (m.layer === fireLayer) m.fire = true;
    for (const l of legend) l.fire = l.layer === fireLayer;
  }
  return { version: ver.id, marks, legend };
}
