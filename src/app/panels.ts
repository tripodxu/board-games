/* panels.ts — 面板渲染的装配薄层（P6b）
 *
 * 这一层只做三件事，别的都不做：
 *   1. 把 `AppCtx`（会话 + 设置 + 后端状态 + 本机战绩簿）**切成面板要的 props**；
 *   2. 把面板渲染函数按旧 `js/app.js` 的调用点串起来（`renderAnalytics/renderCockpit/
 *      renderFeed/renderLatest/renderRecords/renderCalibration/renderTacticsStrip`）；
 *   3. 提供两件 UI 层的通用副作用：`setStatus()` 与 `toast()`（旧 js/app.js:313-322、391-394）。
 *
 * 为什么单独一层：`src/ui/panels/*` 刻意「不 import session 实例、不碰 localStorage/fetch」
 * （见 cockpit.ts 头注），而 `src/app/loop.ts` 又需要一次性把「整屏重画」做掉。
 * 把 props 装配集中在这里，loop / bindings / experiment 三处都调同一份，
 * 避免同一段 props 逻辑被抄三遍后漂移。
 *
 * 校准实验室（旧 js/app.js:1626-1729）是**唯一**没有独立 `src/ui/panels/` 模块的面板，
 * 因此它的 DOM 由本文件的 `renderCalibrationPanel()` 直接产出（口径逐字对照旧实现，
 * 含 `.cal-empty` 的自绘 SVG 与四档技巧分文案）。
 *
 * 本文件不 import node:*，不碰 fetch；localStorage 经 `ctx.storage` 注入。
 */
import type { SideInfo } from '../ui/panels/cockpit.ts';
import {
  appendLedgerLine,
  prependFeed,
  renderCockpit,
  renderDuelNames,
  renderEngineLight,
  renderFeed,
  renderTrendPanel,
  renderTurnBadge,
  rebuildLedger,
} from '../ui/panels/cockpit.ts';
import type { CockpitProps } from '../ui/panels/cockpit.ts';
import { renderRecords } from '../ui/panels/record-book.ts';
import { renderReplayer, replayerInfoOf } from '../ui/panels/replayer.ts';
import type { ReplayerMove } from '../ui/panels/replayer.ts';
import { renderLeaderboard } from '../ui/panels/leaderboard.ts';
import { renderOpenings } from '../ui/panels/openings.ts';
import type { LeaderboardRow, OpeningRow } from '../core/api/client.ts';
import {
  gameUrl,
  getGameByUid,
  leaderboard as fetchLeaderboard,
  openings as fetchOpenings,
} from '../core/api/client.ts';
import { createBoardRenderer } from '../ui/board-render.ts';
import { applyFolded } from '../ui/panels/collapse.ts';
import type { UiState } from '../core/types.ts';
import { renderCalibrationView } from '../ui/panels/calibration.ts';
import { renderTacticsStripView } from '../ui/panels/tactics-strip.ts';
import { loadRecords } from '../core/record/book.ts';
import { getGame } from '../core/registry.ts';
import { VERSIONS, CURRENT, resolve } from '../core/tactics-versions.ts';
import { calibration } from '../core/view/calibration.ts';
import type { Metrics } from '../core/view/calibration.ts';
import { byId, el, setHidden, setText } from '../ui/dom.ts';
import { effFor, effBySideId } from './ctx.ts';
import type { TacticHint } from '../core/tactics-hints.ts';
import { runTacticHintsAsync } from './tactics-client.ts';
import type { AppCtx, ReplayViewState } from './ctx.ts';
import type { SessionMove } from '../core/session.ts';

/* ---------- props 装配 ---------- */

/** 把会话切成 `CockpitProps`（趋势/驾驶舱/决策流/回合徽标共用）。 */
export function cockpitProps(ctx: AppCtx): CockpitProps {
  const session = ctx.session;
  const st = session.st;
  const g = st ? ctx.engine.getStatus(st) : null;
  const sides: SideInfo[] = ctx.engine.sides.map((sd) => ({ id: sd.id, name: sd.name }));
  return {
    moves: session.history as readonly SessionMove[],
    sides,
    mode: session.mode,
    humanSide: session.humanSide,
    trendMode: session.trendMode,
    turn: st && !g?.over ? (g?.turn ?? null) : (g?.turn ?? null),
    over: !!g?.over,
    busy: ctx.inflight != null,
    effBySide: effBySideId(ctx),
  };
}

/* ---------- 状态行 / 吐司 ---------- */

/** 旧 `setStatus(txt, over)`（js/app.js:391-394）。 */
export function setStatus(text: string, over: boolean): void {
  const node = byId<HTMLElement>('status');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('over', over);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 统一的显隐开关。
 *
 * `index.html` 里被运行时开关的节点分两种写法：浮层/对局按钮用 `class="hidden"`
 * （`#promoBox`/`#retryBtn`/`#passBtn`/`#resignBtn`/`#pauseBtn`/`#stepBtn`/`#swapBtn`/`#testPanel`/`#toast`），
 * P6a 的侧栏面板按 `hidden` 属性（`#speedRow`/`#expStartBtn`/侧栏页签）。旧实现全部用
 * `classList.toggle('hidden', ...)`——所以只切属性的写法会让 `#pauseBtn`、`#resignBtn` 这类
 * 「初始就带 class="hidden"」的按钮永远看不见。这里两种一起切，两边都不会漏。
 */
export function setVisible(node: Element | null | undefined, visible: boolean): void {
  if (!node) return;
  node.classList.toggle('hidden', !visible);
  setHidden(node, !visible);
}

/** `setVisible` 的按 id 版本（节点不存在时静默，和旧实现一致）。 */
export function setVisibleById(id: string, visible: boolean): void {
  setVisible(byId<HTMLElement>(id), visible);
}

/** 旧 `toast(msg, isErr)`（js/app.js:313-322）：错误 6000ms，普通 2600ms。 */
export function toast(msg: string, isErr = false): void {
  const node = byId<HTMLElement>('toast');
  if (!node) return;
  node.textContent = msg;
  node.classList.toggle('err', !!isErr);
  node.classList.remove('hidden');
  if (toastTimer != null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    node.classList.add('hidden');
  }, isErr ? 6000 : 2600);
}

/* ---------- 逐块重画 ---------- */

/** 旧 `updateTurnBadge()`。 */
export function renderTurn(ctx: AppCtx): void {
  renderTurnBadge(cockpitProps(ctx));
}

/** 旧 `renderSideNames()`（写 `#duelFirstName`/`#duelSecondName`）。 */
export function renderSideNames(ctx: AppCtx): void {
  renderDuelNames(cockpitProps(ctx));
}

/** 旧 `renderAnalytics()`：趋势曲线 + 局势条 + 花费芯片。 */
export function renderAnalytics(ctx: AppCtx): void {
  renderTrendPanel(cockpitProps(ctx));
}

/** 旧 `renderCockpit()`：引擎指标 + 延迟柱 + 双方对比 + 最近一手。 */
export function renderCockpitPanel(ctx: AppCtx): void {
  renderCockpit(cockpitProps(ctx));
}

/** 旧 `renderFeed()`。 */
export function renderFeedPanel(ctx: AppCtx): void {
  renderFeed(cockpitProps(ctx));
}

/** 旧 `prependFeed(h)`（只在新 AI 手落下时增量插入）。 */
export function prependFeedPanel(ctx: AppCtx, h: SessionMove): void {
  void ctx;
  prependFeed(h);
}

/** 旧 `appendLedgerLine(h)`。 */
export function appendLedgerPanel(ctx: AppCtx, h: SessionMove): void {
  void ctx;
  appendLedgerLine(h);
}

/** 旧 `rebuildLedger()`。 */
export function renderLedgerPanel(ctx: AppCtx): void {
  rebuildLedger(ctx.session.history as readonly SessionMove[]);
}

/** 旧 `setEngineStatus(state, label)`。 */
export function renderEngineStatus(state: 'idle' | 'running' | 'thinking', label?: string): void {
  renderEngineLight(state, label);
}

/** 旧 `syncSwapBtn()`（js/app.js:600 段）：只有人机模式且已走过子时才给「换边重开」。 */
export function syncSwapBtn(ctx: AppCtx): void {
  const showSwap = ctx.session.mode === 'human-ai' && ctx.session.history.length > 0;
  const node = byId<HTMLElement>('swapBtn');
  setVisible(node, showSwap);
}

/** 旧 `setTrendMode(mode)`：写会话字段 + 芯片选中态 + 重画趋势。 */
export function renderTrendChipsActive(ctx: AppCtx): void {
  // 芯片选中态由 renderTrendPanel 内部按 props.trendMode 写，避免两处各写一遍。
  renderAnalytics(ctx);
}

/** 旧 `renderRecords()`：战绩簿表 + 顺带刷新校准实验室。 */
export function renderRecordsPanel(ctx: AppCtx): void {
  ctx.records = loadRecords(ctx.storage);
  renderRecords({ records: ctx.records });
  renderCalibrationPanel(ctx);
}

/* ---------- 校准实验室（旧 js/app.js:1626-1729） ---------- */

interface MergedCalibration {
  samples: { p: number; y: number }[];
  games: number;
  draws: number;
  skippedDemo: number;
  serverGames: number;
  metrics: Metrics | null;
}

/**
 * 旧 `mergeCalibration(local, stats)`（js/app.js:1639-1666）：把后端 `/api/stats` 的
 * 按局记录并进本机样本，按 `gid|着法串` 去重、保留本机记录。
 * 后端不可用时 `ctx.backend.stats` 为 null，这里原样返回本机结果。
 */
export function mergeCalibration(ctx: AppCtx, serverRecords: unknown): MergedCalibration {
  const local = calibration.fromRecords(ctx.records as unknown as Parameters<typeof calibration.fromRecords>[0]);
  const base: MergedCalibration = { ...local, serverGames: 0 };
  if (!Array.isArray(serverRecords) || !serverRecords.length) return base;

  const seen = new Set<string>();
  for (const r of ctx.records) {
    if (r && r.gid && Array.isArray(r.notas)) seen.add(r.gid + '|' + r.notas.join(','));
  }
  const extra: { p: number; y: number }[] = [];
  let serverGames = 0;
  for (const raw of serverRecords) {
    const rec = (raw ?? {}) as Record<string, unknown>;
    const key = typeof rec.key === 'string' ? rec.key : '';
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    if (rec.firstWin !== true && rec.firstWin !== false) continue;
    if (!Array.isArray(rec.cal) || !rec.cal.length) continue;
    serverGames++;
    const y = rec.firstWin ? 1 : 0;
    for (const p of rec.cal) if (typeof p === 'number') extra.push({ p, y });
  }
  if (!extra.length) return base;
  const samples = base.samples.concat(extra);
  return { ...base, samples, games: base.games + serverGames, serverGames, metrics: calibration.metrics(samples) };
}

/** 旧 `renderCalibration()`：`#calBody` 整段重建 + `#calCount` 计数。 */
export function renderCalibrationPanel(ctx: AppCtx): void {
  const box = byId<HTMLElement>('calBody');
  if (!box) return;
  const stats = ctx.backend.stats as { cal?: { records?: unknown } } | null;
  const agg = mergeCalibration(ctx, stats && stats.cal ? stats.cal.records : null);
  renderCalibrationView({
    root: box,
    countEl: byId('calCount'),
    games: agg.games,
    serverGames: agg.serverGames,
    draws: agg.draws,
    skippedDemo: agg.skippedDemo,
    samples: agg.samples,
    metrics: agg.metrics,
  });
}

/* ---------- 战术沿革条（旧 js/app.js:1094-1136） ---------- */

/**
 * 旧 `renderTacticsStrip()`：10 档登记表原样竖列，点击设为全局默认档位。
 * 只写 `settings.tacticsVersion`——双方覆盖（sideConfig）是显式指定，不受默认档变化影响。
 */
export function renderTacticsStrip(ctx: AppCtx, onPick: (id: string) => void): void {
  const box = byId<HTMLElement>('tacticsListBody');
  if (!box) return;
  const inUse = [effFor(ctx, ctx.engine.sides[0].id).tactics, effFor(ctx, ctx.engine.sides[1].id).tactics];
  renderTacticsStripView({
    root: box,
    versions: VERSIONS,
    currentVersion: ctx.settings.tacticsVersion,
    latestId: CURRENT,
    inUseIds: inUse,
    onPick: (id) => {
      ctx.settings.tacticsVersion = resolve(id).id;
      onPick(id);
    },
  });
}

/* ---------- 整屏重画 ---------- */

/** 一次把「会随对局变化」的面板全部重画（旧 resetSession/playMove 的调用点合集）。 */
export function renderAll(ctx: AppCtx, onPickTactics: (id: string) => void): void {
  renderAnalytics(ctx);
  renderCockpitPanel(ctx);
  renderFeedPanel(ctx);
  renderRecordsPanel(ctx);
  renderTacticsStrip(ctx, onPickTactics);
}

/* ---------- P7c 三块数据面板：回放器 / 排行榜 / 开局库 ----------
 *
 * 这三块面板（`ui/panels/{replayer,leaderboard,openings}.ts`）**只吃 props**，自己不查任何 id，
 * 所有取数、状态与 id 定位都在这里做：
 *   - 回放器：payload 由 `client.getGameByUid(uid)` 取（返回原文），逐手整形在这里，
 *             `ply` 是 **1-based**（数组下标 +1）；面板无内部状态，`onPlyChange` 写回 ctx 后重渲。
 *   - 排行榜：`client.leaderboard()` 无后端时返回 `null`，**原样透传**（面板自己区分
 *             「加载中…」/「暂无数据」）。
 *   - 开局库：服务端一律要求 `?game=`，`onGameChange` / `onLimitChange` 写回 ctx 后重新取数。
 */

/** 非空字符串（数字也当有值），否则 null。 */
function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === false || v === '') return null;
  return String(v);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

/** payload 原文 → `ReplayerMove[]`（`ply` 1-based；`ai` 只透传，面板目前不渲染它）。 */
export function replayerMovesOf(payload: unknown): ReplayerMove[] {
  const moves = isObj(payload) && Array.isArray(payload.moves) ? payload.moves : [];
  return moves.map((raw, i) => {
    const m = isObj(raw) ? raw : {};
    return {
      ply: i + 1,
      side: String(m.side ?? ''),
      notation: String(m.notation ?? ''),
      ai: isObj(m.ai) ? (m.ai as ReplayerMove['ai']) : null,
    };
  });
}

/**
 * 回放棋盘（F2，2026-10-06 增量化）：此前每次改手数都「从第 0 手重放 + 新建 canvas/renderer」，
 * 225 手的局拖一次滑杆 ≈ 225 次全量重放（O(N²)）。现在按 `replayerUid` 缓存一份视图：
 *  - `states[p]`：第 p 手之后的局面快照，**增量推进**（只算一次，向前走一手只 applyMove 一次）；
 *  - canvas + renderer 复用（重画而非重建 2D 上下文；重设 canvas 尺寸自带清屏）；
 *  - 滑杆/键盘的 ply 变化在装配层用 rAF 合帧（见 renderReplayerPanel），一次拖动只渲染最后一格。
 * 没有 2D 上下文（happy-dom / 老浏览器）时静默留空，不抛异常、不阻塞面板其余部分。
 */
/** 回放棋谱对应的引擎：优先按 payload 声明的 gameId 从注册表取（历史归档含围棋/象棋等六种棋），缺省回落当前引擎。 */
function replayEngineOf(ctx: AppCtx): AppCtx['engine'] {
  const info = replayerInfoOf(ctx.replayerPayload, { gameUid: ctx.replayerUid });
  return (info.game ? getGame(info.game) : undefined) ?? ctx.engine;
}

/** 按 uid + 棋种取（或重置）回放视图缓存：换棋谱或换棋种即重建快照数组。 */
function replayViewOf(ctx: AppCtx, engine: AppCtx['engine']): ReplayViewState {
  const uid = ctx.replayerUid;
  if (!ctx.replayView || ctx.replayView.uid !== uid || ctx.replayView.gameId !== engine.id) {
    ctx.replayView = { uid, gameId: engine.id, states: [], canvas: null, renderer: null };
  }
  return ctx.replayView;
}

/** 局面快照增量推进：保证 `states[p]` = 应用前 p 手之后的局面（非法着法处冻结，与旧重放语义一致）。 */
function replayStatesOf(engine: AppCtx['engine'], moves: ReplayerMove[], view: ReplayViewState): unknown[] {
  const states = view.states;
  if (states.length === 0) states.push(engine.newGame() as unknown);
  for (let i = states.length; i <= moves.length; i += 1) {
    const prev = states[i - 1] as unknown;
    const notation = moves[i - 1]?.notation;
    const mv = notation ? engine.moveFromNotation(prev, notation) : null;
    states.push(mv ? (engine.applyMove(prev, mv) as unknown) : prev);
  }
  return states;
}

function drawReplayPosition(ctx: AppCtx, host: HTMLElement, moves: ReplayerMove[], ply: number): void {
  const engine = replayEngineOf(ctx);
  if (typeof engine.draw !== 'function') return;
  try {
    const view = replayViewOf(ctx, engine);
    const states = replayStatesOf(engine, moves, view);
    const st = states[Math.min(ply, states.length - 1)] as unknown;
    const meta = engine.meta;
    const w = meta && Number.isFinite(meta.w) ? meta.w : 0;
    const h = meta && Number.isFinite(meta.h) ? meta.h : 0;
    if (!view.canvas) {
      const canvas = document.createElement('canvas');
      /* 没有 2D 上下文（happy-dom / 老浏览器）就安静跳过：面板其余部分照常可用。
       * 刻意不缓存 canvas——缓存了也画不了，还会让后续尝试变成死循环空转。 */
      if (typeof canvas.getContext !== 'function' || !canvas.getContext('2d')) return;
      view.canvas = canvas;
      view.renderer = createBoardRenderer(canvas);
    }
    const canvas = view.canvas;
    canvas.width = w;
    canvas.height = h;
    view.renderer?.resize(w, h);
    host.replaceChildren(canvas);
    view.renderer?.draw({ engine, state: st, ui: {} });
  } catch (e: unknown) {
    console.warn('[jev-qiguan] 回放画面渲染跳过', e);
  }
}

/** 重画回放器（payload 为空时面板显示「未知」+ 0/0，不抛异常）。 */
export function renderReplayerPanel(ctx: AppCtx): void {
  const root = byId<HTMLElement>('replayerPanel');
  if (!root) return;
  const moves = replayerMovesOf(ctx.replayerPayload);
  renderReplayer({
    root,
    info: replayerInfoOf(ctx.replayerPayload, { gameUid: ctx.replayerUid }),
    moves,
    ply: ctx.replayerPly,
    /* 没有棋谱时不建画布：空态只显示「未知 0/0」，没必要为一个不存在的局面开 2D 上下文。 */
    renderBoard: ctx.replayerPayload
      ? (host, ply) => drawReplayPosition(ctx, host, moves, ply)
      : undefined,
    handlers: {
      onPlyChange: (ply) => {
        ctx.replayerPly = ply;
        /* rAF 合帧：滑杆每格都触发 oninput，逐帧只渲染最终值（老浏览器退回 16ms 定时器）。 */
        if (ctx.replayRaf) return;
        const schedule = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
        ctx.replayRaf = schedule(() => {
          ctx.replayRaf = 0;
          renderReplayerPanel(ctx);
        });
      },
      onShare: (uid) => {
        void shareGameUid(uid);
      },
    },
  });
}

/** 分享：优先 `navigator.clipboard`（要 https/localhost），失败退回 toast 里的完整链接。 */
async function shareGameUid(uid: string): Promise<void> {
  const link = gameUrl('u/' + encodeURIComponent(uid));
  const nav = globalThis.navigator as Navigator | undefined;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(link);
      toast('棋谱链接已复制：' + link);
      return;
    } catch (_) { /* 剪贴板被拒 → 退回提示 */ }
  }
  toast('棋谱链接：' + link);
}

/** 选中一份棋谱并载入回放器（`GET /api/games/u/:gameUid` 失败时只提示，不清空已有画面）。 */
export async function openReplayer(ctx: AppCtx, gameUid: string): Promise<void> {
  const uid = String(gameUid || '');
  if (!uid) return;
  ctx.replayerUid = uid;
  ctx.replayerPayload = null;
  ctx.replayerPly = 0;
  /* 数据面板首访是收起的：从归档里点「回放」时顺手展开，否则用户看不见任何变化
     （只切视觉与 aria，不写折叠清单——下次启动仍按用户自己的折叠偏好来）。 */
  applyFolded('replayer', false);
  renderReplayerPanel(ctx);
  let payload: unknown = null;
  try {
    payload = await getGameByUid(uid);
  } catch (_) {
    payload = null;
  }
  if (ctx.replayerUid !== uid) return; /* 竞态：期间又点了别的棋谱，丢弃这次结果 */
  ctx.replayerPayload = payload ?? null;
  renderReplayerPanel(ctx);
  if (!payload) toast('读取棋谱失败：' + uid, true);
}

/** 重画排行榜（`null` = 加载中；`[]` = 暂无数据；**原样透传客户端返回值**）。 */
export function renderLeaderboardPanel(ctx: AppCtx, rows: LeaderboardRow[] | null): void {
  const root = byId<HTMLElement>('leaderboardPanel');
  if (!root) return;
  renderLeaderboard({
    root,
    rows,
    handlers: {
      onSelect: (row) => {
        toast('渠道 ' + (row.channel || '—') + ' · 档位 ' + (row.tactics || '—'));
      },
    },
  });
}

/** 取排行榜并重画。无后端时客户端返回 `null` → 面板停在「加载中…」（三态由面板定义）。 */
export async function loadLeaderboardPanel(ctx: AppCtx): Promise<void> {
  let raw: Awaited<ReturnType<typeof fetchLeaderboard>> = null;
  try {
    raw = await fetchLeaderboard({});
  } catch (_) {
    raw = null;
  }
  const rows = Array.isArray(raw) ? raw : (isObj(raw) && Array.isArray(raw.rows) ? raw.rows : raw === null ? null : []);
  renderLeaderboardPanel(ctx, rows);
}

/** 重画开局库（`null` = 加载中；`[]` = 暂无数据；`game`/`limit` 由 ctx 给）。 */
export function renderOpeningsPanel(ctx: AppCtx, rows: OpeningRow[] | null): void {
  const root = byId<HTMLElement>('openingsPanel');
  if (!root) return;
  renderOpenings({
    root,
    rows,
    game: ctx.openingsGame,
    limit: ctx.openingsLimit,
    handlers: {
      onGameChange: (game) => {
        ctx.openingsGame = game;
        void loadOpeningsPanel(ctx);
      },
      onLimitChange: (limit) => {
        ctx.openingsLimit = limit;
        void loadOpeningsPanel(ctx);
      },
      onSelect: (prefix) => {
        toast('开局前缀：' + prefix);
      },
    },
  });
}

/** 取开局库并重画（服务端一律要求 `?game=`；先摆「加载中…」再取数）。 */
export async function loadOpeningsPanel(ctx: AppCtx): Promise<void> {
  renderOpeningsPanel(ctx, null);
  let raw: Awaited<ReturnType<typeof fetchOpenings>> = null;
  try {
    raw = await fetchOpenings({ game: ctx.openingsGame, limit: ctx.openingsLimit });
  } catch (_) {
    raw = null;
  }
  const rows = Array.isArray(raw) ? raw
    : (isObj(raw) && Array.isArray(raw.openings) ? raw.openings : raw === null ? null : []);
  renderOpeningsPanel(ctx, rows);
}

/** 首屏：三块数据面板摆出空态（回放器「未知」+ 0/0，另两块「加载中…」），不发请求。 */
export function renderDataPanels(ctx: AppCtx): void {
  renderReplayerPanel(ctx);
  renderLeaderboardPanel(ctx, null);
  renderOpeningsPanel(ctx, null);
}

/** 「刷新」按钮：三块数据面板一起重画并取数（取数失败各自降级，不抛错）。 */
export function refreshDataPanels(ctx: AppCtx): void {
  renderReplayerPanel(ctx);
  void loadLeaderboardPanel(ctx);
  void loadOpeningsPanel(ctx);
}

/* ---------- 战术模式提示（tactics-hints 的装配侧） ---------- */

/** 图例渲染：棋盘顶部的分层 chips（色点 + 层名 ×计数 + 接管徽标）；无提示/关闭/非五子棋时隐藏。
 *  同时同步棋盘头部的「提示」一键开关状态（与设置抽屉的 hints 是同一设置的两个入口）。 */
export function renderTacticLegend(ctx: AppCtx): void {
  const root = byId<HTMLElement>('tacticLegend');
  if (!root) return;
  const hint = ctx.tacticHint;
  const btn = byId<HTMLButtonElement>('hintBtn');
  const usable = !!ctx.engine.deepTactics;
  if (btn) {
    btn.disabled = !usable;
    btn.classList.toggle('is-on', usable && !!ctx.settings.hints);
    btn.setAttribute('aria-pressed', String(usable && !!ctx.settings.hints));
    btn.title = usable ? '战术模式提示（按层颜色标出各接管层的待选点）' : '战术提示仅五子棋可用';
  }
  if (!ctx.settings.hints || !usable || !hint || !hint.legend.length) {
    setHidden(root, true);
    root.replaceChildren();
    return;
  }
  const chips = hint.legend.map((l) => el('span', { class: 'tl-chip' + (l.fire ? ' is-fire' : '') }, [
    el('i', { style: { background: l.color } }),
    `${l.label} ×${l.count}`,
    l.fire ? el('b', { class: 'tl-fire', text: '接管' }) : null,
  ]));
  chips.unshift(el('span', { class: 'tl-chip tl-title', text: `战术提示 · ${hint.version}` }));
  root.replaceChildren(...chips);
  setHidden(root, false);
}

/**
 * 重算当前局面的分层提示（缓存键 = gameUid|手数|行棋方|档位|开关）。
 * 计算走 setTimeout(0)（computeTactics 中位几百 ms，让触发它的那次绘制先行）；
 * AI 思考中（inflight）跳过，机机观战零卡顿。只改 `ctx.ui.tacticMarks` 与图例，
 * 是否真的画出来由 gomoku 的 draw 消费（其他引擎不读该字段）。
 */
export function refreshTacticHints(ctx: AppCtx): void {
  const st = ctx.session.st as { turn?: string; moveNum?: number } | null;
  const eligible = !!ctx.settings.hints && !!ctx.engine.deepTactics && !!st && !ctx.engine.getStatus(ctx.session.st).over;
  let key = 'off';
  let versionId: string | null = null;
  if (eligible) {
    const status = ctx.engine.getStatus(ctx.session.st);
    const side = status.turn || '';
    versionId = effFor(ctx, side).tactics;
    key = `${ctx.session.gameUid}|${st?.moveNum ?? 0}|${side}|${versionId}`;
  }
  if (ctx.tacticHintKey === key) {
    renderTacticLegend(ctx);
    return;
  }
  ctx.tacticHintKey = key;
  if (!eligible || !versionId) {
    ctx.tacticHint = null;
    ctx.ui.tacticMarks = null;
    renderTacticLegend(ctx);
    if (ctx.renderer) { try { ctx.renderer.draw({ engine: ctx.engine, state: ctx.session.st, ui: ctx.ui }); } catch { /* ignore */ } }
    return;
  }
  const stSnapshot = ctx.session.st;
  const engSnapshot = ctx.engine;
  const verSnapshot = versionId;
  void runTacticHintsAsync(engSnapshot, stSnapshot, verSnapshot).then(
    (hint) => {
      if (ctx.tacticHintKey !== key) return;
      ctx.tacticHint = hint;
      ctx.ui.tacticMarks = hint ? hint.marks : null;
      renderTacticLegend(ctx);
      if (ctx.renderer) { try { ctx.renderer.draw({ engine: ctx.engine, state: ctx.session.st, ui: ctx.ui }); } catch { /* ignore */ } }
    },
    () => {
      if (ctx.tacticHintKey !== key) return;
      ctx.tacticHint = null;
      ctx.ui.tacticMarks = null;
      renderTacticLegend(ctx);
    },
  );
}
