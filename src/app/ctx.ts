/* ctx.ts — 装配层共享上下文（P6b，取代旧 `js/app.js` 的闭包 `S`）
 *
 * 为什么单独一个 ctx 而不是模块级单例：旧实现在 IIFE 里放了两个可变单例
 * （`S` 会话/运行时句柄、`BACKEND` 后端状态，js/app.js:13 与 :839）；新架构把
 * 「会话数据」交给 `src/core/session.ts` 的 `GameSession`（纯数据，无运行时句柄），
 * 把「运行时句柄」（渲染器、AbortController、思考计时器、in-flight 标记）与
 * 「跨模块单例」（同步队列、后端状态、实验状态、战绩簿缓存）留在装配层。
 * 这些字段必须被 loop / modes / panels / experiment / bindings 共同读写，
 * 所以集中成一个显式传入的 `AppCtx`，**不做隐式全局**——测试里可以造第二个 ctx。
 *
 * 刻意与旧实现不同的地方（逐条）：
 *  1. 旧 `S.ui`（棋盘交互态）现在归装配层持有并在 `redraw()` 时传给渲染器
 *     （`src/core/session.ts` 头注第 2 条：引擎实例按 gameId 从 registry 取回，
 *     交互态不进会话模型）。
 *  2. `ctx.engine` 每次换棋种都重新从 `registry.getGame()` 取；旧实现是
 *     `S.engine = games[gid]`（同一份注册表，等价）。
 *  3. 旧的 `S.aborter` 现在拆成 `abortController`（传输层中断）+ `inflight`
 *     （epoch 竞态防护，值就是发起时的 `session.epoch`）。两者语义不同，
 *     旧实现用同一个 `S.epoch` 字段兼职，这里显式分开。
 *  4. 不再有 `isFile` 分支：ADR-0010/D8 已放弃 `file://` 双击即玩，
 *     因此所有 `effSide()/effectiveChannelOf()` 调用都不传 `{isFile:true}`。
 *
 * 本文件不 import node:*，不碰 localStorage / fetch。
 */
import type { Engine, GameStatus, UiState } from '../core/types.ts';
import type { GameSession } from '../core/session.ts';
import type { EffSide, Settings, StorageLike, SideConfig } from '../core/persist.ts';
import { effSide, saveSettings } from '../core/persist.ts';
import type { TacticHint } from '../core/tactics-hints.ts';
import { ensureLoaded } from '../core/jev/rapfi.ts';
import type { BoardRenderer } from '../ui/board-render.ts';
import type { ProbeState } from '../ui/panels/settings.ts';
import type { SyncQueue } from '../core/record/sync.ts';
import type { ExperimentState } from '../ui/panels/experiment.ts';
import { LIMIT_DEFAULT as OPENINGS_LIMIT_DEFAULT } from '../ui/panels/openings.ts';
import type { RecordBookEntry } from '../core/record/book.ts';

/** 用 `typeof` 反查 API 客户端的返回类型，避免硬编码接口名（`client.ts` 未导出全部别名）。 */
type Api = typeof import('../core/api/client.ts').api;
export type BackendHealth = Awaited<ReturnType<Api['health']>>;
export type BackendStats = Awaited<ReturnType<Api['stats']>>;
export type GameListResult = Awaited<ReturnType<Api['listGames']>>;
export type SaveGameResult = Awaited<ReturnType<Api['saveGame']>>;

/** 双方覆盖的槽位：按 `engine.sides` 的**侧位序**（不按先手），与旧 `sideIdOf()` 同口径。 */
export type SideSlot = 'black' | 'white';

export interface SyncState {
  ok: boolean;
  text: string;
}

/** 后端状态（旧 `BACKEND`，js/app.js:839）。 */
export interface BackendState {
  mode: 'pending' | 'live' | 'deploy';
  health: BackendHealth | null;
  stats: BackendStats | null;
  lastSync: SyncState | null;
}

/** 计时器句柄类型：DOM 环境下 `setTimeout` 返回 number，不用 NodeJS.Timeout。 */
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface AppCtx {
  /** 当前棋种引擎（registry.getGame(gameId)） */
  engine: Engine;
  /** 会话模型（旧 `S` 的数据面） */
  session: GameSession;
  /** 棋盘交互态（旧 `S.ui`；引擎私有，换局即清空） */
  ui: UiState;
  /** 战术模式提示（panels.refreshTacticHints 的缓存；null = 当前无提示） */
  tacticHint?: TacticHint | null;
  /** 提示缓存键（gameUid|手数|行棋方|档位；变更才重算） */
  tacticHintKey?: string;
  /** 活动设置对象：`session.settings` 与它**同引用**，保证导出/记账读到的永远是最新值 */
  settings: Settings;
  /** 设置持久化后端（localStorage 或测试用的内存桩） */
  storage: StorageLike;
  /** 棋盘渲染器；`#board` 不存在时为 null（测试夹具可以只挂面板 DOM） */
  renderer: BoardRenderer | null;
  /** 当前在途请求的中断句柄（旧 `S.aborter`） */
  abortController: AbortController | null;
  /** 在途决策的 epoch；非 null 即「思考中」（旧 `S.inflight`） */
  inflight: number | null;
  /**
   * 当前这一手已经自动重试了几次（只对**可重试**失败计数：限流/网络）。
   * 为什么需要它：机机对局无人值守，一次限流就停摆等于整轮实验报废，
   * 所以 `loop.aiStep` 会自己退避重试；这个计数决定什么时候放弃并交回「重试」按钮。
   * 每次成功落子/换局都清零。
   */
  aiAutoRetries: number;
  /** 思考计时器（旧 `startThinkClock` 的 interval） */
  thinkTimer: TimerHandle | null;
  /** 本次思考的起始时刻（ms） */
  thinkStart: number;
  /** 测试连接互斥（旧 `probing`） */
  probing: boolean;
  /** AI 走子调度句柄（旧 `setTimeout(aiStep, …)`，用于换局/悔棋时取消） */
  aiTimer: TimerHandle | null;
  /** 实验编排的「下一局」调度句柄（**独立于 aiTimer**：换局不能顺手取消实验推进） */
  expTimer: TimerHandle | null;
  /** 实验期间借用 sideConfig 前的快照（旧 `SIDE_CFG_SNAPSHOT`，js/app.js:95-104） */
  sideCfgSnapshot: Settings['sideConfig'] | null;
  /** `#probeOut` 文案与三态（旧 `runProbe()` 直接写 DOM，这里留一份以便重画抽屉时不丢） */
  probeText: string;
  probeState: ProbeState | null;
  /** 棋谱自动同步队列（core/record/sync.ts） */
  sync: SyncQueue;
  /** 后端状态（旧 `BACKEND`） */
  backend: BackendState;
  /** 对比实验运行状态（ui/panels/experiment.ts 的状态机） */
  exp: ExperimentState;
  /** 战绩簿本机缓存（loadRecords 的结果，写回后同步更新） */
  records: RecordBookEntry[];
  /** 终局钩子：实验编排在 bindings 里挂上（避免 loop ↔ experiment 循环 import） */
  onGameEnd: ((g: GameStatus) => void) | null;
  /** 回放器：当前棋谱的 `gameUid`（null = 还没选棋谱，面板显示「未知」+ 0/0） */
  replayerUid: string | null;
  /** 回放器：`client.getGameByUid()` 拿到的 payload 原文 */
  replayerPayload: unknown;
  /** 回放器：当前手（0 = 初始局面，1..n = 第 N 手之后；1-based） */
  replayerPly: number;
  /** 开局库：当前棋种筛选（服务端一律要求 `?game=`） */
  openingsGame: string;
  /** 开局库：行数上限（ui/panels/openings.ts 的 LIMIT_OPTIONS 之一） */
  openingsLimit: number;
}

export interface CreateCtxOpts {
  engine: Engine;
  session: GameSession;
  settings: Settings;
  storage: StorageLike;
  sync: SyncQueue;
  exp: ExperimentState;
  records?: RecordBookEntry[];
  renderer?: BoardRenderer | null;
}

export function createCtx(opts: CreateCtxOpts): AppCtx {
  // 同引用：旧实现里 `S.settings` 就是唯一那份对象，这里保持一致。
  opts.session.settings = opts.settings;
  return {
    engine: opts.engine,
    session: opts.session,
    ui: {},
    settings: opts.settings,
    storage: opts.storage,
    renderer: opts.renderer ?? null,
    abortController: null,
    inflight: null,
    aiAutoRetries: 0,
    thinkTimer: null,
    thinkStart: 0,
    probing: false,
    aiTimer: null,
    expTimer: null,
    sideCfgSnapshot: null,
    probeText: '',
    probeState: null,
    sync: opts.sync,
    backend: { mode: 'pending', health: null, stats: null, lastSync: null },
    exp: opts.exp,
    records: opts.records ?? [],
    onGameEnd: null,
    replayerUid: null,
    replayerPayload: null,
    replayerPly: 0,
    openingsGame: opts.engine.id,
    openingsLimit: OPENINGS_LIMIT_DEFAULT,
  };
}

/* ---------- 侧位 / 有效渠道 ---------- */

/**
 * 旧 `sideIdOf(side)`（js/app.js:53-55）：`engine.sides[1].id === side ? 'white' : 'black'`。
 * 按**侧位序**判黑白，不按先手——象棋的 red 是先手但仍是 sides[0]，映射到 black 槽位。
 */
export function sideSlotOf(engine: Engine, sideId: string): SideSlot {
  const second = engine.sides[1];
  return second && second.id === sideId ? 'white' : 'black';
}

/** 旧 `effSide(side)`（js/app.js:46-52）：把侧位解析成生效渠道/战术档/思考时长。 */
export function effFor(ctx: AppCtx, sideId: string): EffSide {
  return effSide(ctx.settings, sideSlotOf(ctx.engine, sideId));
}

/** 生效渠道按 side id 建索引（`CockpitProps.effBySide` 用）。 */
export function effBySideId(ctx: AppCtx): Record<string, EffSide> {
  const out: Record<string, EffSide> = {};
  for (const sd of ctx.engine.sides) out[sd.id] = effFor(ctx, sd.id);
  return out;
}

/** 取一方覆盖配置（缺省给空串/0 = 跟随全局）。 */
export function sideCfgOf(ctx: AppCtx, slot: SideSlot): SideConfig {
  const raw = ctx.settings.sideConfig ? ctx.settings.sideConfig[slot] : null;
  return raw ? raw : { channel: '', tactics: '', rapfiThinkMs: 0 };
}

/** 写回一方覆盖配置（旧 `saveSideCfg()` / `saveFoe()` 的公共段）。 */
export function setSideCfg(ctx: AppCtx, slot: SideSlot, patch: Partial<SideConfig>): void {
  const cur = sideCfgOf(ctx, slot);
  const next: SideConfig = {
    channel: patch.channel ?? cur.channel,
    tactics: patch.tactics ?? cur.tactics,
    rapfiThinkMs: patch.rapfiThinkMs ?? cur.rapfiThinkMs,
  };
  if (!ctx.settings.sideConfig) ctx.settings.sideConfig = {};
  ctx.settings.sideConfig[slot] = next;
  /* F1（2026-10-06）：用户**显式**切到 rapfi 渠道时后台预取引擎资产（约 11 MB），
   * 把「局中第一次轮到 rapfi 才现抓」的等待提前到设置时。只在真切换且当前是五子棋时
   * 触发（rapfi 只支持五子棋；不在 boot 时预取——不能替移动用户偷偷下 10 MB）。
   * 失败静默：正式走子时 ensureLoaded 会再试并把错误交给用户（现在失败可重试）。 */
  if (next.channel === 'rapfi' && cur.channel !== 'rapfi' && ctx.engine.id === 'gomoku') {
    void ensureLoaded().catch(() => {});
  }
}

/** 落盘设置（旧 `saveSettings()` 的最后一步；`stashEndpoint` 由调用方在此之前完成）。 */
export function persistSettings(ctx: AppCtx): void {
  saveSettings(ctx.storage, ctx.settings);
}

/** 侧位显示名（象棋是 红/黑，跳棋是 下/上……一律取引擎口径）。 */
export function sideNameOf(ctx: AppCtx, sideId: string): string {
  const sd = ctx.engine.sides.find((x) => x.id === sideId);
  return sd ? sd.name : sideId;
}

/** 人类侧 id（`humanSide` 可能为 null：机机/双人模式）。 */
export function humanSideId(ctx: AppCtx): string | null {
  return ctx.session.humanSide ?? null;
}
