/* session.ts — 会话（对局进行态）的显式类型与纯构造器
 *
 * 本类型是 `js/app.js` 闭包 `S`（js/app.js:11-18）的显式化。旧实现把对局状态摊在一个
 * 模块级对象里、由 UI 直接读写，于是「棋谱导出」这种纯逻辑也得闭包读 `S`（无法单测，
 * 计划 §6.3 点名的正是这一处）。P6 起改为显式的 `GameSession` 值：由 `app/loop.ts` 持有，
 * 传给纯函数（如 `record/export.ts` 的 `buildGameExport`）。
 *
 * 字段名与归档 payload 的对应关系见 `src/shared/record-map.ts`：单手的 `ai` 用归档短键
 * （`ch/mdl/conf/p/rank/cands/ms/tv/tac`），因此导出时**不需要再翻译一遍**。
 * 本文件只放类型与纯构造器：不碰 DOM、不做 IO、不 import node:*。
 *
 * 与旧 `S` 的差异（有意，逐条在此登记）：
 *  1. `engine` / `ctx` / `aborter` / `inflight` / 思考计时器**不进 session**——它们是运行时
 *     句柄（含函数、AbortController），JSON 克隆不了。棋种靠 `gameId` 从注册表
 *     （`registry.ts` 的 `getGame`）取回引擎实例。
 *  2. `ui`（棋盘交互态：选中格、连跳前缀等）不进 session，属 `src/ui/**`。
 *  3. `epoch` 保留（旧实现用它识别「期间已重开/悔棋」的过期决策）。
 *  4. 新增 `startedAt` / `endedAt` / `result` / `gameUid`：旧实现从不缓存终局判定
 *     （每次 `engine.getStatus(st)` 现算），也没有开始时间与对局身份；新代码在终局时把
 *     判定快照写进 `result`，让归档 / 战绩簿 / 同步共用同一份口径。
 */
import type { Move } from './types.ts';
import type { AiMoveMeta } from './meta.ts';
import { DEFAULT_SETTINGS, type Settings } from './persist.ts';
import { rand } from './rng.ts';

/** 对局模式（旧 `S.mode`，取值即 js/app.js 的 `#mode` 三个 option）。 */
export type SessionMode = 'human-ai' | 'ai-ai' | 'pvp';

/** 驾驶舱走势芯片的三种口径（旧 `S.trendMode`，js/app.js:1965-1967）。 */
export type TrendMode = 'win' | 'score' | 'conf';

/** 归档短键 + 每手战术标记 `tac`（新前端补的字段，见 record-map.ts 的 `MoveAiMeta`）。 */
export interface SessionAiMeta extends AiMoveMeta {
  /** 每手战术保险标记（win / block / vcfAttack…）；历史棋谱没有这一位 */
  tac?: string | null;
}

/** 单手的 AI 决策元信息：`DecideResult['meta']` 加上 js/app.js:675-677 补的三位。
 *  字段名沿用旧实现的长键（与归档短键的对应关系由 `meta.ts` 的 `aiMoveMeta()` 负责）。 */
export interface SessionMeta {
  /** true = 这一手是 AI 下的（旧 `aiItems()` 的筛选依据） */
  byAI?: boolean;
  /** 走子前的轮走方 id（旧实现手写补上） */
  side?: string;
  /** 该方显示名（旧实现手写补上，用于决策流/战绩簿） */
  sideName?: string;
  channel?: string;
  model?: string | null;
  latencyMs?: number;
  /** 战术层耗时（ms，与 latencyMs 分开记账：latencyMs = 战术 + 上游）。
   *  Rapfi/mock 渠道不过战术层，记 null（不是 0）——统计平均时自动落进样本外；老棋谱没有这个字段。 */
  tacticsMs?: number | null;
  confidence?: number | null;
  candidates?: number;
  restProb?: number;
  costUsd?: number;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  top?: { notation: string; p: number }[];
  /** 先手方视角胜率（校准样本的来源，只有真实渠道才有） */
  noul?: number;
  score?: number;
  /** true = 离线演示/随机基线：不进校准样本 */
  mock?: boolean;
  /** 本手战术接管名（win / block / …） */
  tactics?: string | null;
  tacticsVersion?: string | null;
  warning?: string;
  [k: string]: unknown;
}

/** 一手棋谱记录（旧 `S.history` 的一项，js/app.js:608）。
 *  旧实现只留「记法 + 展示元数据」，不留 prev 全量 state 快照（见 rebuildState 注释）。 */
export interface SessionMove<M extends Move = Move> {
  /** 1 起的手数 */
  ply: number;
  /** 走子**前**的轮走方 id（旧 `h.side = S.st.turn`） */
  side: string;
  /** 引擎 move 对象（`{notation, desc, ...}`）；`notation` 是唯一稳定身份 */
  move: M;
  /** AI 决策元信息；人类走子为 null */
  meta: SessionMeta | null;
  /** 归档短键视图。缺省时由 `record/export.ts` 用 `meta.ts` 的 `aiMoveMeta()` 现算
   *  （与旧实现行为一致）；预填则导出时不再翻译。 */
  ai?: SessionAiMeta;
}

/** 实验局归属信息（旧 `S.expInfo`，js/app.js:1177-1182）。非实验局为 null。 */
export interface SessionExportInfo {
  tag: string;
  /** 本轮实验内的局号，1 起（决定 A/B 执黑） */
  gameNo: number;
  blackChannel: string;
  whiteChannel: string;
  blackTactics: string;
  whiteTactics: string;
  blackThink: number;
  whiteThink: number;
}

/** 终局判定快照（**新字段**：旧实现每次 `engine.getStatus()` 现算，不缓存）。 */
export interface SessionResult {
  /** 归档用的中文串，与旧 `buildGameExport()` 拼法一致 */
  text: string;
  over: boolean;
  winner: string | null;
  reason: string;
  /** 'human' = 人手认输（不是引擎判出的胜负，统计时要单独看） */
  endBy: string | null;
}

/** 对局会话（旧 `S` 的对局相关字段）。JSON 可克隆：没有函数、没有 DOM、没有引擎实例。 */
export interface GameSession<S = unknown, M extends Move = Move> {
  /** 棋种 id（旧 `S.gameId`）；引擎实例靠它从 `registry.ts` 取 */
  gameId: string;
  /** 对局身份（新字段）：`crypto.randomUUID()`，同一局重传恒定（D1 去重键的来源） */
  gameUid: string | null;
  /** 引擎 state（旧 `S.st`）；纯 JSON 数据 */
  st: S | null;
  /** 逐手记录（旧 `S.history`） */
  history: SessionMove<M>[];
  /** 对局模式（旧 `S.mode`） */
  mode: SessionMode;
  /** 人机模式下人类执的一方（旧 `S.humanSide`）；机机/双人为 null */
  humanSide: string | null;
  /** 会话代际：重开/悔棋/换边就 +1，用来作废在途的 AI 决策（旧 `S.epoch`） */
  epoch: number;
  /** 机机模式暂停（旧 `S.paused`） */
  paused: boolean;
  /** 驾驶舱走势口径（旧 `S.trendMode`） */
  trendMode: TrendMode;
  /** 本局是否已记过战绩（旧 `S.sessionRecorded`：终局后悔棋再终局只保留一条） */
  sessionRecorded: boolean;
  /** 战绩簿条目 id（旧 `S.sessionId`，惰性生成） */
  sessionId: string | null;
  /** 设置（旧 `S.settings`）；读写见 `persist.ts` */
  settings: Settings;
  /** 实验归属（旧 `S.expInfo`） */
  expInfo: SessionExportInfo | null;
  /** 开始时间（epoch ms；**新字段**，旧实现只在记账时取 `Date.now()`） */
  startedAt: number | null;
  /** 结束时间（epoch ms；**新字段**） */
  endedAt: number | null;
  /** 终局判定快照（**新字段**，见 SessionResult 注释） */
  result: SessionResult | null;
}

/** `createSession()` 的入参：都给默认值，只 `gameId` 必填。 */
export interface CreateSessionOpts {
  gameId: string;
  gameUid?: string | null;
  mode?: SessionMode;
  humanSide?: string | null;
  settings?: Settings | null;
  trendMode?: TrendMode;
  epoch?: number;
  startedAt?: number | null;
}

/** 设置深拷贝（session 与调用方不共享同一个 settings 对象）。 */
function cloneSettings(s: Settings): Settings {
  return {
    ...s,
    endpoints: { ...(s.endpoints || {}) },
    sideConfig: JSON.parse(JSON.stringify(s.sideConfig || {})) as Settings['sideConfig'],
  };
}

/** 纯构造：不读盘、不碰 DOM、不生成身份（`gameUid` 由调用方给，见 randomGameUid）。 */
export function createSession<S = unknown, M extends Move = Move>(opts: CreateSessionOpts): GameSession<S, M> {
  return {
    gameId: opts.gameId,
    gameUid: opts.gameUid ?? null,
    st: null,
    history: [],
    mode: opts.mode ?? 'human-ai',
    humanSide: opts.humanSide ?? null,
    epoch: opts.epoch ?? 0,
    paused: false,
    trendMode: opts.trendMode ?? 'win',
    sessionRecorded: false,
    sessionId: null,
    settings: cloneSettings(opts.settings || DEFAULT_SETTINGS),
    expInfo: null,
    startedAt: opts.startedAt ?? null,
    endedAt: null,
    result: null,
  };
}

/** 对局身份（旧实现没有；新契约用它做 D1 去重，见 record-map.ts 的 `gameUid`）。
 *  优先 `crypto.randomUUID()`，环境不支持时退化为「时间戳 + 可种子随机数」。 */
export function randomGameUid(now: number = Date.now()): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return String(now) + '-' + String(rand(1e9));
}

/** 旧 `aiItems()`（js/app.js:1543 段）：只取 AI 下的手。 */
export function aiMovesOf<M extends Move>(session: GameSession<unknown, M>): SessionMove<M>[] {
  return session.history.filter((h) => !!(h.meta && h.meta.byAI));
}

/** 旧 `isAISide()`（js/app.js 的走子段）：该方是否由 AI 执子。 */
export function isAISide(session: GameSession, sideId: string): boolean {
  if (session.mode === 'ai-ai') return true;
  if (session.mode === 'pvp') return false;
  return sideId !== session.humanSide;
}

/** 旧 `sideName()`：引擎 `sides` 里查显示名，查不到原样返回 id。 */
export function sideNameOf(engine: { sides?: { id: string; name: string }[] } | null | undefined, sideId: string): string {
  const sides = (engine && engine.sides) || [];
  const s = sides.find((x) => x.id === sideId);
  return s ? s.name : sideId;
}

/** 旧 `resultText()`：战绩簿里的胜负串（和棋 / 未终局分开）。 */
export function resultTextOf(engine: { sides?: { id: string; name: string }[] } | null | undefined, g: { winner?: string | null; reason?: string | null } | null | undefined): string {
  if (g && g.winner) return sideNameOf(engine, g.winner);
  return (g && g.reason === '换边中断') ? '未终局' : '和棋';
}
