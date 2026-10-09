/* tactics.ts — 战术事实推算与事实注入（迁移自 js/jev-client.js 的战术层）
 *
 * 战术层回答的问题是：**在概率之上再叠一层确定性事实**。Jev 只给概率分布，
 * 它可能把「一步致胜」判成 0.2；这里把「这一步直接赢」「对方下一步赢」「造双杀」
 * 「连续冲四将死链」这类**可判定事实**在引擎上穷举出来，交给 orchestrator 接管。
 *
 * 十三级保险（接管顺序，见 decide）：
 *   win → block → open4 → threat → vcfAttack → vctAttack → vcfDefense → vctDefense →
 *   live3Attack → live3Defense → parry → parry3 → parry4
 * 每一级都受**版本闸门**（tactics-versions.mech）约束：老版本没实现的层连算都不算，
 * 否则「v4 的行为」会随新代码漂移，实验就没法按版本归因。
 *
 * v13 的压力闸门（`pressureGate`）在 live3Attack **之前**插一层：对手的做四手数
 * （pressure_opponent）压过我们（pressure_you）时先走 `pressure_cut_points`（1-ply 模拟里
 * 让对手做四手数最小的点，削掉他的网），没有削点时才照旧抢活三——理由见 gomoku.ts 的
 * v13 注释与 ADR-0017。
 *
 * v14（`live3Fresh`）不动层数，只**纠偏** live3 两层的判据：制造点必须由这一手新造
 * （见 types.ts 的 Live3Options 与 docs/plans/2026-10-03-tactics-v14-fresh-live3.md）。
 *
 * 纯逻辑：只依赖 engine 接口 + 版本登记表；无 DOM、无网络。异步仅出现在 callRaw 一侧。
 */
import { weightedPick } from './weighted.ts';
import { ids, resolve } from './tactics-versions.ts';
import type { TacticsVersion } from './tactics-versions.ts';
import { DEFAULT_BUDGET, budgetOf } from './tactics-budget.ts';
import type { EngineBudget } from './tactics-budget.ts';
import type { ProviderSwitchInfo } from './jev/providers.ts';
import type { ProgressFn } from './jev/rapfi.ts';
import type { Engine, JevSerialized, Move } from './types.ts';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 解析后的战术版本：登记表记录 + 运行时缺省补齐（见 resolveVersion）。 */
interface ResolvedVersion {
  id: string;
  mech: Record<string, boolean>;
  budget: EngineBudget;
  /** VCF 的 soundness 闸门是否启用（v0–v8 历史为 false，v9 起为 true，见 §3 D4）。 */
  sound: boolean;
  /** 开局前几手不做战术（原 `computeTactics` 里的硬编码 4，P1 起随档位）。 */
  openingMin: number;
  /** 事实注入口径：`'mech'` = 只注入本档真有的机制句（当前口径），`'all'` = 不过滤（兼容位）。 */
  promptFacts: 'mech' | 'all';
}

/** 战术事实（字段名与旧实现逐字一致，直接进 state.tactics）。 */
export interface TacticsReport {
  winning_points_you: string[];
  winning_points_opponent: string[];
  chance_points_you: string[];
  danger_points_opponent: string[];
  vcf_win_you: string[];
  vcf_win_opponent: string[];
  /** v11：VCT（冲四链 + 活三逼迫，5 手攻击）算出的必胜首步（VCF 看不见时的更强搜索）。 */
  vct_win_you: string[];
  /** v12：对手的连续威胁链拆点（与 vcf_win_opponent 同语义：对手有链时我们该走的点）。 */
  vct_win_opponent: string[];
  /** v12：对手那条链本身（链首在前，供面板/取证；我们拆得掉时才可能非空）。 */
  vct_chain_opponent: string[];
  /** v10：己方活三制造点（4 手内必胜威胁，覆盖跳活三 / 斜向组合）。 */
  live3_you: string[];
  /** v10：对手的活三制造点。 */
  live3_opponent: string[];
  /** v10：破活三的落点（并列最优里最先评估到的，可能为空数组）。 */
  live3_deny_points: string[];
  /** v13：己方做四手数（邻域内落子即成冲四的空点数）——2 手的取势指标，不是必胜事实。 */
  pressure_you: number;
  /** v13：对手做四手数；大于 pressure_you 时压力闸门开火（先削点，不抢活三）。 */
  pressure_opponent: number;
  /** v13：削点（落子后对手做四手数最小的点，并列里自己做四手数更大者优先）。空 = 没得削。 */
  pressure_cut_points: string[];
}

/** 对局经验（跨设备开具体验；由 /api/openings 喂）。 */
export interface Experience {
  [k: string]: unknown;
}

/** decide 的选项（旧实现 opts 的超集，渠道键名保持不变）。 */
export interface DecideOpts {
  channel?: string;
  apiKey?: string;
  endpoint?: string;
  topK?: number;
  signal?: AbortSignal;
  tacticsVersion?: string;
  experience?: Experience;
  onRetry?: (status: number, attempt: number) => void;
  rapfiThinkMs?: number;
  /**
   * F1（2026-10-06）：Rapfi 渠道的加载进度回调——'script' 注入胶水 / 'wasm' 实例化 /
   * 'download' 带胶水自报的资产下载文本（约 11 MB，慢链路上此前是「看着在等 AI」）。
   * 只在 rapfi 渠道被消费，其余渠道忽略。
   */
  rapfiOnProgress?: ProgressFn;
  /**
   * C2：备用提供方（commandcode 网关）的 key。**不填 = 不启用兜底**，失败照旧抛——
   * 老行为逐字不变，兜底只能在明确配了第二把 key 的运行面上生效。
   */
  backupApiKey?: string;
  /**
   * C2：本局粘滞的提供方 id。切换一旦发生，调用侧把新的 id 存进本局状态、下一手传回来，
   * 于是「同一局内不再回切」（D-B2）——否则两家都不稳时会一手机一换，棋谱没法归因。
   */
  providerSticky?: string;
  /** C2：切换（含「备用探活未通过」）时的回调，供日志与事件流。 */
  onProviderSwitch?: (info: ProviderSwitchInfo) => void;
  [k: string]: unknown;
}

/** decide 的返回（meta 字段名与旧实现一致，供 meta.ts 归因）。 */
export interface DecideResult {
  notation: string;
  move: Move | null;
  meta: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * 常量与缓存
 * ------------------------------------------------------------------ */

/** 18 个机制键全开的桩版本（引擎没接战术登记表时的兜底）。 */
const ALL_MECH: Record<string, boolean> = {
  win: true, block: true, open4: true, threat: true,
  vcfAttack: true, vcfDefense: true, vctAttack: true, vctDefense: true, pressureGate: true,
  live3Attack: true, live3Defense: true, live3Fresh: true,
  parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true,
};

/** VCF 搜索深度（ply）。7 是 gomoku 上「够用且不卡」的实测值。 */
const VCF_PLIES = 7;

/** VCT 搜索深度（ply）：9 = 攻方 5 手，够覆盖实测里 2–5 手的「活三逼迫 + 冲四收尾」链。 */
const VCT_PLIES = 9;

/** 战术缓存的降级形态：无 WeakMap 时退化为不缓存。 */
interface TacCache { get(k: object): Map<string, TacticsReport> | undefined; set(k: object, v: Map<string, TacticsReport>): void }
const tacCache: TacCache | null = typeof WeakMap === 'function'
  ? new WeakMap<object, Map<string, TacticsReport>>() as unknown as TacCache
  : null;

/** 空战术（结构与 TacticsReport 一致）。 */
export function emptyTactics(): TacticsReport {
  return {
    winning_points_you: [], winning_points_opponent: [],
    chance_points_you: [], danger_points_opponent: [],
    vcf_win_you: [], vcf_win_opponent: [],
    vct_win_you: [], vct_win_opponent: [], vct_chain_opponent: [],
    live3_you: [], live3_opponent: [], live3_deny_points: [],
    pressure_you: 0, pressure_opponent: 0, pressure_cut_points: [],
  };
}

/** 换手（不改入参 state：拷贝一层后只改 turn，与 ADR-0004 的纯函数要求一致）。 */
function flipTurn<S>(st: S, sideId: string): S {
  return Object.assign({}, st as object, { turn: sideId }) as S;
}

/** 解析战术版本（P0/D2）：未知档号回落 **`v0-off`（空机制集）**，绝不回落「全开」。
 *
 *  过去 catch 后返回 `ALL_MECH`：一个写错的档号会让这一手跑满全部机制 —— 标签还写着
 *  那个错档号，既不是它、也不是当前档，实验数据直接失真。现在只允许「什么都不做」：
 *  宁可战术层空转（可观测、可解释），也不许悄悄变成别的档位。登记表本身不可用时同理。
 *
 *  P1（冻结层）起还带出该档的**预算 / sound / openingMin / promptFacts**：搜索上限不再从
 *  模块常量现取，而是随档位走 —— 否则今天调一次参，历史档位的行为就被静默改写。
 */
function resolveVersion(versionId?: string | null): ResolvedVersion {
  try {
    const v: TacticsVersion = resolve(versionId);
    if (v && v.id) {
      return {
        id: v.id,
        mech: (v.mech || {}) as Record<string, boolean>,
        budget: budgetOf(v.budget),
        sound: v.sound !== false,
        openingMin: typeof v.openingMin === 'number' && v.openingMin >= 0 ? v.openingMin : 4,
        promptFacts: v.promptFacts === 'all' ? 'all' : 'mech',
      };
    }
  } catch (_) { /* 未知档号 / 登记表不可用：按空机制集处理（见上） */ }
  return { id: ids()[0] || 'v0-off', mech: {}, budget: DEFAULT_BUDGET, sound: false, openingMin: 4, promptFacts: 'mech' };
}

/** 这一档的机制集（`attachFacts` 的调用方用它决定「哪些指令句该出现」）。 */
export function mechOf(versionId?: string | null): Record<string, boolean> {
  return resolveVersion(versionId).mech;
}

/* ------------------------------------------------------------------ *
 * 2-ply / 3-ply 事实推算
 * ------------------------------------------------------------------ */

/** 数 st2 中 sideId 的一步致胜点，到 limit 即停（2-ply 内层省时间用）。 */
function countWinningPoints(engine: Engine, st2: unknown, sideId: string, limit: number): number {
  let cnt = 0;
  const s = flipTurn(st2, sideId);
  let legal: Move[];
  try { legal = engine.getLegalMoves(s); } catch (_) { return 0; }
  for (const m of legal) {
    let g;
    try { g = engine.getStatus(engine.applyMove(s, m)); } catch (_) { continue; }
    if (g.over && g.winner === sideId) cnt++;
    if (cnt >= limit) break;
  }
  return cnt;
}

/** 造杀点：走这里之后自己有两个致胜点（对手只能挡一个）。
 *  forSelf=true 时还要求「对手没有一步致胜」，否则那不是造杀而是送死。 */
function threatMakers(engine: Engine, st: unknown, sideId: string, oppId: string | undefined, candNotations: string[], forSelf: boolean): string[] {
  const out: string[] = [];
  for (const n of candNotations) {
    let mv;
    try { mv = engine.moveFromNotation(st, n); } catch (_) { continue; }
    if (!mv) continue;
    let s2;
    try { s2 = engine.applyMove(flipTurn(st, sideId), mv); } catch (_) { continue; }
    if (countWinningPoints(engine, s2, sideId, 2) < 2) continue;
    if (forSelf && oppId && countWinningPoints(engine, s2, oppId, 1) > 0) continue;
    out.push(n);
  }
  return out;
}

/** 数走 p 之后对手还有几个逼杀着法（越小越安全）；失败返回 999（当作最坏情况）。 */
function countForcingReplies(engine: Engine, st: unknown, p: string, oppId: string, candNotations: string[]): number {
  let mv;
  try { mv = engine.moveFromNotation(st, p); } catch (_) { return 999; }
  if (!mv) return 999;
  let s2;
  try { s2 = engine.applyMove(st, mv); } catch (_) { return 999; }
  let cnt = 0;
  for (const n of candNotations) {
    if (n === p) continue;
    let q;
    try { q = engine.moveFromNotation(s2, n); } catch (_) { continue; }
    if (!q) continue;
    let s3;
    try { s3 = engine.applyMove(flipTurn(s2, oppId), q); } catch (_) { continue; }
    if (countWinningPoints(engine, s3, oppId, 1) >= 1) cnt++;
    if (cnt >= 10) break;
  }
  return cnt;
}

/** 3-ply 安全性：走 p 之后对手是否能维持攻击节奏（造出双杀）。true = 这个点不干净。 */
function allowsSustainedAttack(engine: Engine, st: unknown, p: string, oppId: string, myId: string, candNotations: string[]): boolean {
  let mv;
  try { mv = engine.moveFromNotation(st, p); } catch (_) { return false; }
  if (!mv) return false;
  let s2;
  try { s2 = engine.applyMove(st, mv); } catch (_) { return false; }
  let checked = 0;
  for (const q of candNotations) {
    if (q === p || checked >= 8) continue;
    let mq;
    try { mq = engine.moveFromNotation(s2, q); } catch (_) { continue; }
    if (!mq) continue;
    let s3;
    try { s3 = engine.applyMove(flipTurn(s2, oppId), mq); } catch (_) { continue; }
    /* 黑方这一步之后有几个致胜点？≥2 说明攻击节奏还在 */
    const wins: string[] = [];
    let legal3: Move[];
    try { legal3 = engine.getLegalMoves(flipTurn(s3, oppId)); } catch (_) { continue; }
    for (const m of legal3) {
      let g;
      try { g = engine.getStatus(engine.applyMove(flipTurn(s3, oppId), m)); } catch (_) { continue; }
      if (g.over && g.winner === oppId) wins.push(String(m.notation));
      if (wins.length >= 2) break;
    }
    if (wins.length === 0) continue;
    if (wins.length >= 2) return true;
    checked++;
    /* 只有一个致胜点：对手挡住后，攻击方是否还能再造杀？ */
    let mw;
    try { mw = engine.moveFromNotation(s3, wins[0]!); } catch (_) { continue; }
    if (!mw) continue;
    let s4;
    try { s4 = engine.applyMove(s3, mw); } catch (_) { continue; }
    if (threatMakers(engine, s4, oppId, myId, candNotations, false).length > 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 事实推算主入口
 * ------------------------------------------------------------------ */

/** 推算战术事实。legal 是当前合法着法，cands 是候选点记法（2-ply 只扫候选）。
 *  结果按 (state 对象, 版本 id) 缓存：同一局面会被 decide 与 pickSafestParry 反复问。 */
export function computeTactics(engine: Engine, st: unknown, legal: Move[], cands: string[] | null | undefined, versionId?: string | null): TacticsReport {
  const ver = resolveVersion(versionId);
  const M = ver.mech;
  const B = ver.budget;
  if (tacCache && st && typeof st === 'object') {
    const hit = tacCache.get(st as object)?.get(ver.id);
    if (hit) return hit;
  }
  const sm = st as { moveNum?: number; turn: string };
  /* 开局前几手没有战术可言（也避免把 2-ply 花在无意义的空盘上）。P1 起阈值随档位（默认 4）。 */
  if (typeof sm.moveNum === 'number' && sm.moveNum < ver.openingMin) return emptyTactics();

  const side = sm.turn;
  const win: string[] = [];
  if (M.win) {
    for (const m of legal) {
      let g;
      try { g = engine.getStatus(engine.applyMove(st, m)); } catch (_) { continue; }
      if (g.over && g.winner === side) win.push(m.notation);
    }
  }
  /* 必挡点：把 turn 掰到对手那边看他能不能一手赢 */
  const block: string[] = [];
  const oppSide = engine.sides && engine.sides.find((s) => s.id !== side);
  if (oppSide && M.block) {
    const stOpp = flipTurn(st, oppSide.id);
    let legalOpp: Move[];
    try { legalOpp = engine.getLegalMoves(stOpp); } catch (_) { legalOpp = []; }
    for (const m of legalOpp) {
      let g;
      try { g = engine.getStatus(engine.applyMove(stOpp, m)); } catch (_) { continue; }
      if (g.over && g.winner === oppSide.id) block.push(m.notation);
    }
  }
  const res: TacticsReport = {
    winning_points_you: win,
    winning_points_opponent: block,
    chance_points_you: [],
    danger_points_opponent: [],
    vcf_win_you: [],
    vcf_win_opponent: [],
    vct_win_you: [],
    vct_win_opponent: [],
    vct_chain_opponent: [],
    live3_you: [],
    live3_opponent: [],
    live3_deny_points: [],
    pressure_you: 0,
    pressure_opponent: 0,
    pressure_cut_points: [],
  };

  /* 2-ply 造杀/拆杀：只在「没有一步致胜」时才算（有致胜就不用看了） */
  if (engine.deepTactics && win.length === 0 && block.length === 0 && oppSide && (M.threat || M.parry)) {
    const candNotations = (cands && cands.length) ? cands : legal.map((m) => m.notation);
    res.chance_points_you = threatMakers(engine, st, side, oppSide.id, candNotations, true);
    res.danger_points_opponent = threatMakers(engine, st, oppSide.id, side, candNotations, false);
  }

  /* VCF（连续冲四将死链）：v7 起；v8 起对防守链逐点试干预；v9 起引擎侧有 soundness 闸门。
     P1 起深度/节点/展开数与 sound 都取自本档预算（v0–v8 的 sound=false = 历史语义）。 */
  if (engine.deepTactics && typeof engine.vcfWin === 'function' && win.length === 0 && block.length === 0 && oppSide && M.vcfAttack) {
    const vcfOpts = { sound: ver.sound, nodeLimit: B.vcfNodeLimit, movesMax: B.vcfMovesMax };
    try {
      if (M.vcfAttack) {
        const atk = engine.vcfWin(st, side, B.vcfPlies, vcfOpts);
        if (atk && atk.win && atk.first) res.vcf_win_you = [atk.first];
      }
    } catch (_) { /* 引擎差异一律 fail-soft：战术层不能把对局打断 */ }
  }

  /* VCT（连续威胁搜索）：v11 起。VCF 只搜冲四，实测两臂 24 局里 v10 有 20 手存在
     「先造活三逼迫、再用冲四收尾」的必胜链（连 11 ply 纯冲四也看不见），当时走的却是启发式
     活三点。这里在 VCF 无解时再跑一遍含活三的连续威胁搜索（攻方 5 手，见引擎 vctWin）。 */
  if (engine.deepTactics && typeof engine.vctWin === 'function' && win.length === 0 && block.length === 0
      && oppSide && M.vctAttack && res.vcf_win_you.length === 0) {
    try {
      const vct = engine.vctWin(st, side, B.vctPlies, { nodeLimit: B.vctNodeLimit, movesMax: B.vctMovesMax, defusersMax: B.vctDefusersMax });
      if (vct && vct.win && vct.first) res.vct_win_you = [vct.first];
    } catch (_) { /* 同上：引擎差异 fail-soft */ }
  }

  /* 连续威胁链的防守（v12）：v11 起只把对手的**纯冲四**链逐点试过（vcfDefense），对手把链换成
     「活三逼迫 + 冲四收尾」就放行了。实测两轮 v11 vs rapfi@500ms 共 48 个「我方无杀而对手有链」
     的回合：实走拆掉 33 个、漏 15 个，其中 2 个存在能拆的点却没走（计时轮 #8 ply24 → K9、
     首轮 #6 ply52 → K8）。这里在 VCF 守没找到点时再算一遍含活三的链，并对「链上各点 → 链点邻域
     → 全部邻近空点」逐一验「落子后对手既无 VCF 也无 VCT」（见引擎 vctDefense）。
     vctFirst（v14.1 起）的防线优先级纠偏见下：本闭括号内的事实计算抽成闭包，两个调用点共用。 */
  const computeVctDefense = (): void => {
    if (!(engine.deepTactics && typeof engine.vctDefense === 'function') || win.length > 0 || block.length > 0
        || !oppSide || !M.vctDefense || res.vcf_win_you.length > 0 || res.vct_win_you.length > 0) return;
    try {
      const candNotations = (cands && cands.length) ? cands : legal.map((m) => m.notation);
      const def = engine.vctDefense(st, side, B.vctPlies, {
        cands: candNotations,
        maxTry: B.vctDefMax,
        keep: B.vctDefKeep,
        vcfPlies: B.vcfDefPlies,
        pressureLimit: B.vctDefPressureLimit,
      });
      if (def) {
        if (def.chain.length) res.vct_chain_opponent = def.chain;
        if (def.points.length) res.vct_win_opponent = def.points;
      }
    } catch (_) { /* 同上：引擎差异 fail-soft */ }
  };
  /* vctFirst（v14.1 起）：vctDefense 是**判据更强**的防线（落子后对手 VCF+VCT 全无），
     vcfDefense 只验纯冲四链——旧序里前者被门在「后者没找到点」之后，于是「纯四可拆、
     混合链也能一并拆掉」的局面永远走弱防线：vorder1 两局实锤（29ced20c ply65 走 I10 弃 K10、
     3ba614a0 ply24 走 G8 弃 E6），纯四拆掉后对手的活三逼迫链残留，两手内成必败。
     vctFirst 把 vctDefense 提前为主防线，vcfDefense 降级为「vctDefense 没找到点」的兜底。
     v0–v14 不带此键 ⇒ 走原序，历史归因与回放逐字不变。 */
  if (M.vctFirst) computeVctDefense();

  /* vcfDefense（v7/v8）：对手**纯冲四**链的干预点（链条入口）。v8 补丁：链首占不住时，
     把整条链上的点逐个试（占住哪一点真的能破链）。
     vctFirst 时它是**兜底**：判据更强的 vctDefense（拆完对手 VCF+VCT 全无）没找到点才轮到它
     ——判据弱的不许抢在判据强的前面开火（vorder1 29ced20c ply65 / 3ba614a0 ply24 的教训）。 */
  if (engine.deepTactics && typeof engine.vcfWin === 'function' && win.length === 0 && block.length === 0
      && oppSide && M.vcfDefense && res.vcf_win_you.length === 0
      && !(M.vctFirst && res.vct_win_opponent.length)) {
    const vcfOpts = { sound: ver.sound, nodeLimit: B.vcfNodeLimit, movesMax: B.vcfMovesMax };
    try {
      const def = engine.vcfWin(flipTurn(st, oppSide.id), oppSide.id, B.vcfPlies, vcfOpts);
      if (def && def.win && def.first) {
        const cands2: string[] = [def.first];
        const seen = new Set(cands2);
        const pushCand = (n: string): void => { if (n && !seen.has(n)) { seen.add(n); cands2.push(n); } };
        if (M.vcfTry) def.line.forEach((n) => pushCand(n));
        for (const n of cands2) {
          let mv;
          try { mv = engine.moveFromNotation(st, n); } catch (_) { continue; }
          if (!mv) continue;
          let stAfter;
          try { stAfter = engine.applyMove(st, mv); } catch (_) { continue; }
          const recheck = engine.vcfWin(flipTurn(stAfter, oppSide.id), oppSide.id, B.vcfPlies, vcfOpts);
          if (!recheck || !recheck.win) { res.vcf_win_opponent = [n]; break; }
        }
      }
    } catch (_) { /* 引擎差异一律 fail-soft：战术层不能把对局打断 */ }
  }
  /* 旧序（v0–v14）：vcfDefense 没找到点时才算 vctDefense。vctFirst 走上面的提前口径，这里跳过。 */
  if (!M.vctFirst && res.vcf_win_opponent.length === 0) computeVctDefense();

  /* 压力（v13）：两侧的「做四手数」。不是必胜事实，而是取势对照——对手做四点比我们多时，
     我们先抢活三大概率只是送一个逼手，下一步就被他的网罩住（六轮 39 个这样的回合里，
     实走之后对手仍握双四威胁的有 37 个；改走削点，双四威胁降到 7 个）。闸门开火时才算削点：
     1-ply 模拟里挑「对手做四手数最小」的点，一个都削不动就返回空数组（client 侧不开火）。 */
  if (engine.deepTactics && typeof engine.fourPressure === 'function' && win.length === 0 && block.length === 0
      && oppSide && M.pressureGate) {
    try {
      res.pressure_you = engine.fourPressure(st, side, B.fourPressureLimit);
      res.pressure_opponent = engine.fourPressure(st, oppSide.id, B.fourPressureLimit);
      if (res.pressure_opponent > res.pressure_you && typeof engine.pressureCut === 'function') {
        /* 只把**模型候选**当前置优先序；不能像别处那样退回「全部合法着法」——那等于按行序盲试，
         * 会把真正有效的削点挤出候选上限（实测 `1be84659` ply24 的 C8 就在第 40 个之后）。 */
        const cut = engine.pressureCut(st, side, { cands: (cands && cands.length) ? cands : [], maxTry: B.pressureCutMax, keep: B.pressureCutKeep });
        if (cut && cut.points.length) res.pressure_cut_points = cut.points;
      }
    } catch (_) { /* 同上：引擎差异 fail-soft */ }
  }

  /* 4-ply 活三（v10）：v9 之前只有「活四制造点」（2-ply），跳活三/斜向组合全靠模型自己看，
     实测正是输给搜索算法的口子。这里用引擎的 live3Makers / live3Deny 真推演（4 手内必胜）。
     v14 起 `live3Fresh` 把判据纠偏成「制造点必须由这一手新造」：注入模型的事实与接管点不再
     被本方既有的活四制造点放大（实测虚报率 67.9%，见 Live3Options 与 v14 计划文档）。 */
  if (engine.deepTactics && typeof engine.live3Makers === 'function' && win.length === 0 && block.length === 0
      && oppSide && (M.live3Attack || M.live3Defense)) {
    try {
      const candNotations = (cands && cands.length) ? cands : legal.map((m) => m.notation);
      const l3opts = { fresh: M.live3Fresh === true, evalMax: B.live3DenyEvalMax };
      if (M.live3Defense) {
        res.live3_opponent = engine.live3Makers(st, oppSide.id, l3opts);
        if (res.live3_opponent.length && typeof engine.live3Deny === 'function') {
          const deny = engine.live3Deny(st, side, candNotations, l3opts);
          if (deny && deny.best && deny.best.length) res.live3_deny_points = deny.best;
        }
      }
      /* 抢攻层留到最后算：对手已有活三时我们的活三通常来不及（守卫逻辑在 client 侧判） */
      if (M.live3Attack) res.live3_you = engine.live3Makers(st, side, l3opts);
    } catch (_) { /* 同上：引擎差异 fail-soft */ }
  }

  if (tacCache && st && typeof st === 'object') {
    let byVer = tacCache.get(st as object);
    if (!byVer) { byVer = new Map<string, TacticsReport>(); tacCache.set(st as object, byVer); }
    byVer.set(ver.id, res);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * 事实注入：把 tactics / experience 塞进 state 并同步指令语义
 * ------------------------------------------------------------------ */

/** 把战术事实写进序列化结果的 state，并在 move 指令里追加一段语义说明。
 *  state 的三种形态（对象/字符串/数组）都要处理——旧契约允许引擎自选形态。
 *
 *  opts.mech（P1/D5）：给了就**只注入本档真有的机制句**（`M[key] === true`），不给则不过滤
 *  （兼容老调用方）。句序与句面**逐字不变**，当前档（机制全开）的输出因此与冻结前完全一致。 */
export function attachFacts(ser: JevSerialized, tactics: TacticsReport, experience?: Experience,
                            opts?: { mech?: Record<string, boolean> | null }): void {
  const facts: Record<string, unknown> = { tactics };
  if (experience) facts.experience = experience;
  if (ser.state && typeof ser.state === 'object' && !Array.isArray(ser.state)) {
    Object.assign(ser.state, facts);
  } else if (typeof ser.state === 'string') {
    try { ser.state = JSON.stringify(Object.assign(JSON.parse(ser.state), facts)); }
    catch (_) { ser.state += '\n' + JSON.stringify(facts); }
  } else if (Array.isArray(ser.state)) {
    ser.state.push(JSON.stringify(facts));
  }
  if (ser.questions && ser.questions.move && typeof ser.questions.move.instructions === 'string') {
    const M = opts && opts.mech ? opts.mech : null;
    const on = (k: string): boolean => !M || M[k] === true;
    let ins = '';
    if (on('win')) ins +=
      ' The state includes a `tactics` object: if `winning_points_you` is non-empty, playing one of those points wins immediately this turn. ';
    if (on('block')) ins +=
      'If `winning_points_opponent` is non-empty, the opponent would win there next turn unless stopped, so play one of those points unless you can win immediately. ';
    if (on('threat')) ins +=
      'If `chance_points_you` is non-empty, playing one creates two winning threats at once (the opponent can block at most one of them), winning within two moves — take it when there is no immediate win or block. ';
    if (on('vcfAttack')) ins +=
      'If `vcf_win_you` is non-empty, playing that point starts a forced sequence of consecutive fours leading to victory — take it when there is no immediate win, block, or double-threat above. ';
    if (on('vcfDefense')) ins +=
      'If `vcf_win_opponent` is non-empty, the opponent has such a forced sequence; playing that point disrupts it at its entry — prioritize it over quiet moves. ';
    if (on('vctAttack')) ins +=
      'If `vct_win_you` is non-empty, playing that point starts a forced threat sequence that mixes consecutive fours with forcing open threes and wins within five of your moves — take it when there is no immediate win, block, or double-threat above. ';
    if (on('vctDefense')) ins +=
      'If `vct_win_opponent` is non-empty, the opponent has such a mixed forced sequence; playing that point breaks the whole chain (it leaves the opponent with neither a four-chain nor a mixed one), so prefer it over your own open-three attacks. ';
    if (on('threat')) ins +=
      'If `danger_points_opponent` is non-empty, the opponent would create such a double threat next turn unless stopped, so block one of those points now (after handling any immediate win or block above). ';
    if (on('live3Defense')) ins +=
      'If `live3_opponent` is non-empty, the opponent has points that would create two open-four threats at once (winning within four moves even if you block one); `live3_deny_points` lists the moves that remove that threat — play one of them unless a more urgent item above applies. ';
    if (on('live3Attack')) ins +=
      'If `live3_you` is non-empty and the opponent has no equal or faster threat, playing one of those points creates a double open-four threat of your own, winning within four moves. ';
    if (on('pressureGate') && (tactics.pressure_you || tactics.pressure_opponent)) ins +=
      '`pressure_you` and `pressure_opponent` count how many points would immediately create a four for each side; when `pressure_opponent` is greater than `pressure_you`, the opponent is already weaving a net of fours while your own open-three attack would only be a forcing move — play `pressure_cut_points` instead (the point that leaves the opponent with the fewest four-making points), not `live3_you`. ';
    if (experience) ins +=
      'The state also includes `experience`: first_player_win_rate over past games reaching this same opening; weigh it when judging quiet moves. ';
    ser.questions.move.instructions += ins;
  }
}

/* ------------------------------------------------------------------ *
 * 供 jev/client.ts 复用的内部工具（导出以便测试单点验证）
 * ------------------------------------------------------------------ */

export { countWinningPoints, threatMakers, countForcingReplies, allowsSustainedAttack, flipTurn, resolveVersion, VCF_PLIES, VCT_PLIES, ALL_MECH, weightedPick };
