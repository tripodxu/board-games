/* takeover.ts — 战术接管链（从 src/core/jev/client.ts 抽出的纯函数，零行为变更）
 *
 * 为什么要有这个文件（2026-10-03，P2/D6）：接管链原本内嵌在 `decide()` 里，只有真发一次
 * 上游请求（或 `channel:'random'`）才能跑到。两件事都需要它在**无模型**时也能跑：
 *   ① 指纹冻结（`test/engines/fingerprint.mjs`）：逐档记录「层 + 落点」，改一处牵多档必须红灯；
 *   ② P3 回放（`scripts/tactics-replay.mjs`）：任意棋谱 × 任意档位问「这一手会不会不一样」。
 * 抽取是**逐字搬运**：分支顺序、闸门条件、兜底路径与 `pickAmong` 的 top-k 语义都不动，
 * 只把「读闭包变量」改成「读入参」。对照证据见 `.work/p2-ab-baseline.mjs`（抽取前后
 * 30 局面 × 15 档的 `{层, 落点}` 逐行相同）。
 *
 * 两条纪律：
 *   - **顺序即优先级**：`TAKEOVER_ORDER` 是权威顺序，新增层必须插进它并同步 `tactics-versions.ts`
 *     的机制表与本文档 §链条说明；层之间的相对顺序变了，历史棋谱的归因就变了。
 *   - **事实优先于概率**：模型概率只用来在「同一层的候选点之间」挑一个（`pickAmong`），
 *     层与落点由确定性事实决定；模型没覆盖到某个点时直接走该层第一个点（`bypassed`）。
 */
import { weightedPick } from './weighted.ts';
import { countForcingReplies, allowsSustainedAttack } from './tactics.ts';
import type { TacticsReport } from './tactics.ts';
import type { Engine, Move } from './types.ts';

/** 接管层顺序（与 `pickTakeover()` 的分支严格一一对应，供指纹/文档/审计引用）。 */
export const TAKEOVER_ORDER: readonly string[] = Object.freeze([
  'win', 'block', 'open4', 'threat', 'vcfAttack', 'vctAttack', 'vcfDefense', 'vctDefense',
  'pressureGate', 'live3Attack', 'live3Defense', 'parry', 'parry3', 'parry4',
]);

/** 接管层中文名（接管提示用）。 */
export const TAKEOVER_LABEL: Record<string, string> = Object.freeze({
  win: '致胜点', block: '必挡点', open4: '活四点', threat: '造杀点',
  vcfAttack: '连续冲四将死链', vcfDefense: '将死链干预点', vctAttack: '连续威胁链首步',
  vctDefense: '拆连续威胁链', pressureGate: '削对手做四点',
  live3Attack: '活三抢攻点', live3Defense: '拆活三点', parry: '拆杀点',
  parry3: '活三/活四预挡点', parry4: '冲四预挡点',
});

export interface TakeoverCtx {
  engine: Engine;
  /** 局面（只读 `turn` 与 `engine.sides`）。 */
  st: unknown;
  /** 战术事实（`computeTactics()` 的输出）。 */
  tactics: TacticsReport;
  /** 本档机制集（`resolveVersion()` / `mechOf()` 的 `mech`）。 */
  mech: Record<string, boolean>;
  /** 引擎给模型的候选标签（`open4` / `parry3` / `parry4` 三层从它里面扫）。 */
  criteria: Record<string, unknown>;
  /** 合法着法（兜底与 rank 用）。 */
  legal: Move[];
  /** 模型给出概率且合法的着法，按概率降序（层内挑选用）。 */
  pairs: [string, number][];
  /** 交给模型的候选点记法（3-ply 安全排序的候选集；缺省退全量合法着法）。 */
  cands?: string[] | null;
  /** 层内多候选时的采样策略（>1 走概率加权）。 */
  topK?: number;
  /** 3-ply 安全排序耗时回调（调用方把它记进 `tacticsMs`）。 */
  onTime?: (ms: number) => void;
}

export interface TakeoverResult {
  /** 接管的落点；null = 没有任何层接管（调用方回落到概率采样）。 */
  notation: string | null;
  /** 接管的层名（`TAKEOVER_ORDER` 之一）；null = 没有接管。 */
  layer: string | null;
  /** 该层第一个点不在模型概率里 ⇒ 直接执行（接管提示用）。 */
  bypassed: boolean;
}

/**
 * 跑一遍接管链，返回「层 + 落点」。
 *
 * 语义与抽取前逐字一致：先看强制胜（己方成五 / 对方成五 / 活四 / 造杀），再看待拆的强制胜
 * （VCF / VCT 攻防），然后是压力闸门、活三攻防、拆杀点与两个预挡层标签；一层都不开火时
 * 返回 `{notation:null, layer:null}`，由调用方按概率采样。
 */
export function pickTakeover(ctx: TakeoverCtx): TakeoverResult {
  const { engine, st, tactics, mech: M, criteria, legal, pairs } = ctx;
  const byNotation = new Set(legal.map((m) => m.notation));
  let notation: string | null = null;
  let layer: string | null = null;
  let bypassed = false;

  /** 层内挑选：优先模型给了概率的点（topK>1 时按概率加权随机），否则直接走层内第一个点。 */
  const pickAmong = (list: string[]): string | null => {
    const inPairs = pairs.filter(([n]) => list.indexOf(n) >= 0);
    const k2 = Math.max(1, ctx.topK || 1);
    if (inPairs.length) {
      if (k2 > 1 && inPairs.length > 1) {
        return weightedPick(inPairs.map((p) => p[0]), inPairs.map((p) => p[1]));
      }
      return inPairs[0]![0];
    }
    bypassed = true;
    const mv = engine.moveFromNotation(st, list[0] as string);
    return mv ? mv.notation : null;
  };

  /* 拆杀点安全性排序：多个 danger 并存时逐个试走，优先排除给对方持续攻击节奏的
   * 坏点（3-ply：对手 p → 我逼杀 q → 对手被迫堵 → 我仍有 danger），剩余再按逼杀数
   * 排序。单个点或非 deepTactics 引擎时回退到 pickAmong。 */
  const pickSafestParry = (list: string[]): string | null => {
    if (list.length <= 1) return pickAmong(list);
    const oppSide = engine.sides && engine.sides.find((s) => s.id !== (st as { turn: string }).turn);
    if (!oppSide || !engine.deepTactics) return pickAmong(list);
    const candNs = (ctx.cands && ctx.cands.length) ? ctx.cands : legal.map((m) => m.notation);
    const tt = Date.now();
    try {
      /* 第一轮：排除允许持续攻击的坏点 */
      const good = list.filter((p) => !allowsSustainedAttack(engine, st, p, oppSide.id, (st as { turn: string }).turn, candNs));
      const pool = good.length ? good : list;
      if (pool.length === 1) return pool[0] as string;
      /* 第二轮：按逼杀着法数排序，取最少 */
      let best: string | null = null, bestScore = Infinity;
      for (const p of pool) {
        const score = countForcingReplies(engine, st, p, oppSide.id, candNs);
        if (score < bestScore) { bestScore = score; best = p; }
      }
      if (best) return best;
    } catch (_) { /* 降级 */ } finally {
      /* 3-ply 安全排序同属战术层，算进 tacticsMs（多 danger 时这是本层最大的一块） */
      if (ctx.onTime) ctx.onTime(Date.now() - tt);
    }
    return pickAmong(list);
  };

  /* 引擎标签层（open4 / parry3 / parry4）同样按版本闸门：版本没实现的层连
   * criteria 都不用扫，才能让老版本的战略行为可复现。 */
  const open4Points = M.open4 ? Object.entries(criteria)
    .filter(([n, v]) => typeof v === 'string' && /(^|\+)you:open4(\+|$)/.test(v) && byNotation.has(n))
    .map(([n]) => n) : [];
  /* 第四级（3-ply 预挡）：对手的 deny:open4/deny:live3 标签点 = 对方下回合可造活四/活三的
   * 制造点。放任不管会被迫逐手拆杀（实战败局：p20 白走闲着 E6，黑 E7 活三点 → 强制拆 →
   * J8 双杀 → 输）。win/block/open4/threat/parry 都无时抢先占掉，让对手造不成活三。
   * 第五级（Rapfi 实战复盘 2026-09-29 增补）：deny:four = 对方下回合可造冲四（单杀逼迫链
   * 起点）。Rapfi 对局显示：放任冲四制造点会被连续单杀逼迫 → 双杀收尾（4 局 3 次）。
   * 优先级 deny:open4/deny:live3 > deny:four（后者多为单杀，可被 block 层处理，但提前
   * 抢占能打断对方的连续逼杀节奏）。 */
  const parry3Points = M.parry3 ? Object.entries(criteria)
    .filter(([n, v]) => typeof v === 'string' && /(^|\+)deny:(open4|live3)(\+|$)/.test(v) && byNotation.has(n))
    .map(([n]) => n) : [];
  const parry4Points = M.parry4 ? Object.entries(criteria)
    .filter(([n, v]) => typeof v === 'string' && /(^|\+)deny:four(\+|$)/.test(v) && byNotation.has(n))
    .map(([n]) => n) : [];

  if (tactics.winning_points_you.length) {
    notation = pickAmong(tactics.winning_points_you);
    if (notation) layer = 'win';
  } else if (tactics.winning_points_opponent.length) {
    notation = pickAmong(tactics.winning_points_opponent);
    if (notation) layer = 'block';
  } else if (open4Points.length) {
    notation = pickAmong(open4Points);
    if (notation) layer = 'open4';
  } else if (tactics.chance_points_you.length) {
    notation = pickAmong(tactics.chance_points_you);
    if (notation) layer = 'threat';
  } else if (tactics.vcf_win_you.length) {
    /* VCF 进攻：连续冲四将死链的首步。排在 threat 之后（双杀两步胜更快）、
     * parry 之前（将死链是强制胜，比「对方下回合可能造双杀」更紧急）。 */
    notation = pickAmong(tactics.vcf_win_you);
    if (notation) layer = 'vcfAttack';
  } else if (tactics.vct_win_you.length) {
    /* v11 VCT 抢攻：VCF（纯冲四）看不见、但含「活三逼迫」的连续威胁链的首步。
     * 实测 24 局里 v10 有 20 手（7 局）存在这种算得清的必胜链，当时却走了启发式活三点，
     * 其中两局因此和棋。与 vcfAttack 同级（都是强制胜，排在防守之前）。 */
    notation = pickAmong(tactics.vct_win_you);
    if (notation) layer = 'vctAttack';
  } else if (tactics.vcf_win_opponent.length) {
    /* VCF 防守：对方将死链的干预点（链条入口）。将死是强制输，比 parry 的
     * 「潜在双杀」更紧急，故优先。 */
    notation = pickAmong(tactics.vcf_win_opponent);
    if (notation) layer = 'vcfDefense';
  } else if (tactics.vct_win_opponent.length) {
    /* v12 拆连续威胁链：对手的混合链（活三逼迫 + 冲四收尾）在 vcfDefense 只验纯冲四时会被放行。
     * 实测两轮 48 个「我方无杀而对手有链」的回合里漏 15 个，其中 2 个存在能拆的点却没走
     * （计时轮 #8 ply24 → K9、首轮 #6 ply52 → K8，两手实走都落在 parry 上）。
     * 排在 vcfDefense 之后（纯冲四链已有拆点时先按原路走）、live3Attack 之前
     * （对手的强制胜比我们先手造活三快）。 */
    notation = pickAmong(tactics.vct_win_opponent);
    if (notation) layer = 'vctDefense';
  } else if (M.pressureGate && !M.softGate && tactics.pressure_cut_points.length
      && tactics.pressure_opponent > tactics.pressure_you
      && !tactics.danger_points_opponent.length) {
    /* v13 压力闸门：对手的「做四手数」压过我们时，先削点再谈进攻。ADR-0015 已证明活三不是杀
     * （两个 L2 点互斥，「4 手内必胜」不成立），它只是逼手；真正危险的是对手造四点密集
     * （双四威胁 = 2 手胜）。六轮实测 39 个「我们仍去抢活三而对手做四点已领先」的回合里，
     * 实走之后对手仍握双四威胁的有 37 个；改用 1-ply 削点（引擎 pressureCut）压对手做四手数，
     * 37/39 更优、0 手更差，平均 −1.87 个，双四威胁 37 → 7。削点为空时本层不开火，
     * 行为与 v12 完全一致；真强制胜早被上面的 vcfAttack / vctAttack 接管，故不漏杀。
     * 排在 live3Attack 之前（抢活三正是要拦的那一步）、live3Defense 之前（削点比破活三点更普适：
     * 它直接压对手的做四手数，而 live3_deny_points 在实测里经常为空）。
     * 与 live3Attack 同一条安全线：对手已有「危险点」时本层让位给 parry/safeSort（实测 p18 那类
     * 「双 danger 并存」的局面里，pressureCut 只认手数、不认对手下一步的杀，会挑出走子方偏好的
     * 危险点，所以必须显式挡住）。 */
    notation = pickAmong(tactics.pressure_cut_points);
    if (notation) layer = 'pressureGate';
  } else if (M.live3Attack && !tactics.danger_points_opponent.length && tactics.live3_you.length) {
    /* v10 活三抢攻：自己的 L3（落子后 ≥2 个活四制造点）＝ 4 手内必胜。排在 vcf 之后
     * （将死链是强制胜，更快），parry 之前（对手下回合的双杀还没成型时我们先手更划算）。
     * danger_points_opponent 非空时让位：对手下回合就能造活四（2 手胜），我们先手 4 手剑
     * 会输速度——那种局面交给下面的 parry 层。
     * v13 压力闸门（见上一分支）在入口处先接管：对手做四点领先且存在削点时不会走到这里。 */
    notation = pickAmong(tactics.live3_you);
    if (notation) layer = 'live3Attack';
  } else if (M.live3Defense && !tactics.danger_points_opponent.length && tactics.live3_deny_points.length) {
    /* v10 拆活三：对手有 L3 时走引擎算出的破点（让对手 L3 点数归零的那些点）。
     * 排在 parry3（模型自己的 deny:live3 标签）之前：标签只认连续 XXX，跳活三/斜向组合
     * 根本打不出标签，而实测 27 局 rapfi 归档里 14 局正是死在这种认不出的活三上。 */
    notation = pickAmong(tactics.live3_deny_points);
    if (notation) layer = 'live3Defense';
  } else if (M.safeSort && tactics.danger_points_opponent.length) {
    /* v5 起多 danger 并存时 3-ply 安全排序；v5 之前直接取概率最高者 */
    notation = pickSafestParry(tactics.danger_points_opponent);
    if (notation) layer = 'parry';
  } else if (tactics.danger_points_opponent.length) {
    notation = pickAmong(tactics.danger_points_opponent);
    if (notation) layer = 'parry';
  } else if (parry3Points.length) {
    notation = pickAmong(parry3Points);
    if (notation) layer = 'parry3';
  } else if (parry4Points.length) {
    notation = pickAmong(parry4Points);
    if (notation) layer = 'parry4';
  }

  return { notation, layer, bypassed };
}
