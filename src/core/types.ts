/* types.ts — 引擎与决策的公共类型（迁移自 docs/engine-interface.md 的契约描述）
 *
 * 移植原则：**只加类型，不改行为**。旧实现是鸭子类型 + `BG.games[id]` 注册表，
 * 这里把它写成泛型接口 Engine<S>，字段名与运行时完全一致（多出来的类型参数
 * 在类型剥离后不留痕迹）。
 *
 * 三个刻意的宽松点，都是为了让旧实现的写法原样成立：
 *   1. `turn` 是 string 而非联合类型——旧代码到处 `st.turn === 'black'` 比较，
 *      也到处直接赋值 `st.turn = side`，联合类型会把等价代码变成编译错误；
 *   2. 有索引签名——各引擎状态还带 r/c/from/to/promoted 等私有字段，
 *      serializeForJev 注入的 tactics/experience 也走同一对象；
 *   3. 可选方法用 `?`，因为六个引擎并非都实现 passMove/mockPick/vcfWin。
 */
import type { Canvas2D, Gfx } from './gfx.ts';

/** 一步棋。notation 是 Jev Choice 的键：全局唯一、稳定、短。 */
export interface Move {
  notation: string;
  desc?: string | null;
  /** 引擎私有字段（r/c/from/to/captured/promoted…）。 */
  [k: string]: unknown;
}

/** getStatus 的返回：终局判定。over:false 时至少给 turn。 */
export interface GameStatus {
  over: boolean;
  turn?: string;
  winner?: string | null;
  reason?: string;
  [k: string]: unknown;
}

/** 引擎给 UI 的静态元信息（画布逻辑尺寸）。 */
export interface EngineMeta {
  w: number;
  h: number;
  [k: string]: unknown;
}

/** 一方的声明（先手方 first:true）。 */
export interface Side {
  id: string;
  name: string;
  first?: boolean;
  [k: string]: unknown;
}

/** serializeForJev 的产出：三问一次并行发出。 */
export interface JevQuestion {
  type: string;
  instructions: string;
  criteria?: unknown;
  options?: unknown;
  [k: string]: unknown;
}

/** Jev 请求体。state 允许是对象/字符串/数组三种形态（attachFacts 三种都处理）。 */
export interface JevSerialized {
  state: Record<string, unknown> | string | unknown[];
  questions: Record<string, JevQuestion> & { move: JevQuestion };
  options?: unknown;
  [k: string]: unknown;
}

/** 生成引擎专用的 UI 交互态（multi-step 连跳等）；跨手保持，可放函数。 */
export interface UiState {
  [k: string]: unknown;
}

/** orchestrator 传给引擎的决策上下文（旧实现是 { channel: {...}, ... }）。 */
export interface PickConfig {
  [k: string]: unknown;
}

/** 连续冲四将死链（VCF）的搜索结果。 */
export interface VcfResult {
  win: boolean;
  first: string | null;
  line: string[];
}

/** 破活三（4-ply 威胁）扫描结果：before/after 是对手活三制造点数，best 是并列最优点。 */
export interface Live3Deny {
  before: number;
  after: number;
  best: string[];
}

/**
 * 活三判据选项（v14 纠偏）。
 * 缺省 / `fresh: false` = 旧口径：只要「落子后本方存在 ≥2 个活四制造点」就算活三制造点——
 * 本方本来就有活四制造点时，一步闲棋也会被判成「制造活三」，实测虚报率 67.9%。
 * `fresh: true` = 纠偏口径：只数**这一手新造**的活四制造点（落子后新增 ≥2 个），
 * 也就是「活三制造点必须由这一手造出来」。
 * 实测口径（五轮 76 局 / 我方 3864 回合，`.work/v14-live3-tac-scan.log`）：旧口径报出的点
 * 67.9% 是幻影；但 `live3Attack` 289 手、`live3Defense` 122 手真接管**没有一手**落在幻影点上
 * （纠偏后 411/411 仍被认），78 手「实走落在幻影点」全部来自 `block`/`win`/模型自选 ⇒
 * **纠偏改变的是注入模型的事实**（212 手 / 占我方回合 5.5% 的 `live3_*` 描述失真，其中 16 手
 * 整集皆假），不是接管决策。见 docs/plans/2026-10-03-tactics-v14-fresh-live3.md。
 */
export interface Live3Options {
  fresh?: boolean;
  /** 破活三搜索里最多评估几个候选点（默认 24，见 LIVE3_DENY_EVAL_MAX）。 */
  evalMax?: number;
}

/**
 * VCF（连续冲四）搜索预算（P1 冻结层引入，缺省 = 历史常量）：
 *   sound     是否启用 soundness 闸门（默认 true = 今天的口径；false = v7/v8 的旧语义，
 *             守方手握即时致胜点时也照样报「将死链」，即历史上那批不健全的链）
 *   nodeLimit 节点上限（默认 4000）
 *   movesMax  每层最多展开几个逼迫着法（默认 12）
 * 三个都只影响「看见多少」，缺省时逐字等于冻结前的行为。
 */
export interface VcfOptions {
  sound?: boolean;
  nodeLimit?: number;
  movesMax?: number;
}

/**
 * VCT 搜索预算（可选项，缺省走引擎常量）。供离线标定与实验扫描用：
 *   movesMax   每层最多展开几个攻击方着法（默认 10）
 *   nodeLimit  节点上限（默认 3000）
 *   defusersMax 活三逼迫时，守方应手多于这个数就不当作逼迫手（默认 6；传 Infinity 表示不限）
 * 三个上限都只会让搜索「少看见」、不会让它谎报必胜；缺省值由 .work/vct-tune*.mjs 在
 * 586 个真实回合上标定（10/3000/6 与 14/6000/∞ 看见同样 55 手，但 p90 从 2430ms 降到 1647ms）。
 */
export interface VctOptions {
  movesMax?: number;
  nodeLimit?: number;
  defusersMax?: number;
}

/** 拆连续威胁链（v12）的结果：kind/chain 是对手那条链（链首在前），points 是能拆掉整条链的点。
 *  `tried` 是实际试过的候选点数（用于成本复盘）；`points` 为空 = 拆不掉（或对手本来没有链）。 */
export interface VctDefenseResult {
  kind: 'vcf' | 'vct' | '';
  chain: string[];
  points: string[];
  tried: number;
}

/** 拆链搜索的输入：cands 是模型候选点（并列拆法里优先），maxTry 是候选点数上限（默认 12）。
 *  keep 是凑够几个可用点就收工（默认 3）；vcfPlies/pressureLimit 是内部复验 VCF 的深度与
 *  并列取势的压力早退阈值（默认 7 / 3）——都由 P1 的 per-version 预算下传，缺省等于历史常量。 */
export interface VctDefenseOptions {
  cands?: string[];
  maxTry?: number;
  keep?: number;
  vcfPlies?: number;
  pressureLimit?: number;
}

/** 削点搜索（v13）的结果：points 是「落子后对手做四手数最小」的点（并列取前几个）；
 *  before/after 是双方做四手数的对照（after 是走 points[0] 之后的盘面），tried 是实际试过的候选数。
 *  points 为空 = 没有一个候选能把对手的做四手数压低（此时行为与 v12 完全一致）。 */
export interface PressureCutResult {
  points: string[];
  before: { you: number; opponent: number };
  after: { you: number; opponent: number };
  tried: number;
}

/** 削点搜索的输入：cands 是模型候选点（先试），maxTry 是候选点数上限（默认 120）。
 *  keep 是并列最优里最多留几个点（默认 3），由 P1 的 per-version 预算下传。 */
export interface PressureCutOptions {
  cands?: string[];
  maxTry?: number;
  keep?: number;
}

/** 引擎统一接口（docs/engine-interface.md §2）。 */
export interface Engine<S = any> {
  id: string;
  name: string;
  sides: Side[];
  meta?: EngineMeta;
  supportsPass?: boolean;
  supportsResign?: boolean;
  /** 候选点是无色差空点集（如 gomoku 落子点）时声明：Jev 层可跑 2-ply 造杀扫描。 */
  deepTactics?: boolean;

  newGame(): S;
  getLegalMoves(st: S): Move[];
  applyMove(st: S, move: Move): S;
  getStatus(st: S): GameStatus;
  moveFromNotation(st: S, notation: string): Move | null;
  serializeForJev(st: S, side: string): JevSerialized;
  selfTest(): void;

  /* 渲染与交互（调用时才会碰到 gfx；模块加载期零 DOM 访问） */
  draw?(ctx: Canvas2D, st: S, ui: UiState): void;
  humanClick?(st: S, ui: UiState, x: number, y: number): Move | null;

  /* 可选能力 */
  passMove?(st: S): Move | { notation: string; [k: string]: unknown };
  mockPick?(st: S, moves: Move[], side: string, cfg?: PickConfig): Move | null | undefined;
  /** st.turn 须为 attackerId；无链返回 { win:false, first:null, line:[] }。
   *  opts（P1）：sound=false 关掉 soundness 闸门（v7/v8 旧语义），nodeLimit/movesMax 收放搜索面。 */
  vcfWin?(st: S, attackerId: string, maxPlies: number, opts?: VcfOptions): VcfResult;
  /**
   * 活三制造点（L3）：落子后自己有 ≥2 个活四制造点＝4 手内必胜威胁（v10 战术层用）。
   * 覆盖 labelPoint 的连续三模式认不出的跳活三 / 斜向组合。返回记法列表，可能为空。
   * opts.fresh（v14）＝只认「这一手新造」的活四制造点，缺省为旧口径（见 Live3Options）。
   */
  live3Makers?(st: S, sideId: string, opts?: Live3Options): string[];
  /**
   * 破活三：在候选记法里挑出让对手 L3 点最少的点（v10 战术层用）。
   * 对手的 L3 点本身优先试；after 为剩下多少，best 为并列最优（见实现注释）。
   * opts.fresh（v14）＝两侧判据都换成「新造」口径（见 Live3Options）。
   */
  live3Deny?(st: S, sideId: string, candNotations: string[], opts?: Live3Options): Live3Deny;
  /**
   * VCT（连续威胁搜索）：把 vcfWin 的冲四链扩展到「冲四 + 活三逼迫」（v11 战术层用）。
   * 守方应手精确枚举（冲四→唯一堵点；活三→真能拆掉全部必胜点的点），黑方禁手点不算应手。
   * 返回的 line 只含**攻击方**着法（守方应手不入 line，与 vcfWin 不同）。
   * opts 是搜索预算（缺省用引擎常量）：离线标定 / 实验用，线上走缺省。
   */
  vctWin?(st: S, attackerId: string, maxPlies?: number, opts?: VctOptions): VcfResult;
  /**
   * 拆对手的连续威胁链（v12 战术层用）：先看对手有没有 VCF 链，没有再看含活三逼迫的 VCT 链；
   * 有链就在「链上各点 → 链点邻域 → 全部邻近空点（按到链距离升序）」里逐点试，
   * 判据是落子后对手**既无 VCF 也无 VCT**（比 vcfDefense 只验纯冲四严）。
   * 返回 points 是能拆的落点（模型候选优先、对手压力小者优先），空 = 拆不掉。
   */
  vctDefense?(st: S, defenderId: string, maxPlies?: number, opts?: VctDefenseOptions): VctDefenseResult;

  /**
   * 某一方当前的「做四手数」（v13 压力闸门用）：车氏邻域内落子即成冲四的空点数量。
   * 高 = 该方造四点的手段多（网正在织）。闸门比较两侧数量，对手更多时先拆不抢。
   * 默认不早退（limit 省略 = 精确计数），因为早退会让两侧同时触顶而误判成「不落后」。
   */
  fourPressure?(st: S, sideId: string, limit?: number): number;

  /**
   * 削点搜索（v13 压力闸门用）：在候选点上做 1-ply 模拟，找「落子后对手做四手数最小」的点
   * （并列时取自己做四手数更大者，让出主动权最少）。只在对手压力压过我们时才调用。
   * 返回 points 为空 = 没有候选能压低对手的做四手数 ⇒ 调用方保持原行为（最小回归面）。
   */
  pressureCut?(st: S, sideId: string, opts?: PressureCutOptions): PressureCutResult;

  /** 引擎私有方法（如 gomoku 的 candidates / serialize 用到的辅助）。 */
  [k: string]: unknown;
}
