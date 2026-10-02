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
  /** st.turn 须为 attackerId；无链返回 { win:false, first:null, line:[] }。 */
  vcfWin?(st: S, attackerId: string, maxPlies: number): VcfResult;
  /**
   * 活三制造点（L3）：落子后自己有 ≥2 个活四制造点＝4 手内必胜威胁（v10 战术层用）。
   * 覆盖 labelPoint 的连续三模式认不出的跳活三 / 斜向组合。返回记法列表，可能为空。
   */
  live3Makers?(st: S, sideId: string): string[];
  /**
   * 破活三：在候选记法里挑出让对手 L3 点最少的点（v10 战术层用）。
   * 对手的 L3 点本身优先试；after 为剩下多少，best 为并列最优（见实现注释）。
   */
  live3Deny?(st: S, sideId: string, candNotations: string[]): Live3Deny;
  /**
   * VCT（连续威胁搜索）：把 vcfWin 的冲四链扩展到「冲四 + 活三逼迫」（v11 战术层用）。
   * 守方应手精确枚举（冲四→唯一堵点；活三→真能拆掉全部必胜点的点），黑方禁手点不算应手。
   * 返回的 line 只含**攻击方**着法（守方应手不入 line，与 vcfWin 不同）。
   * opts 是搜索预算（缺省用引擎常量）：离线标定 / 实验用，线上走缺省。
   */
  vctWin?(st: S, attackerId: string, maxPlies?: number, opts?: VctOptions): VcfResult;

  /** 引擎私有方法（如 gomoku 的 candidates / serialize 用到的辅助）。 */
  [k: string]: unknown;
}
