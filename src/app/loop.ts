/* loop.ts — 对局主循环（旧 js/app.js 的「开始/结束」「走子」「悔棋」三段）
 *
 * 对应关系（计划 §6.3）：
 *   - 开始/结束（旧 js/app.js:502-600）→ `startGame()` / `resetSession()` / `finishGame()`
 *   - 走子（旧 js/app.js:602-705）      → `playMove()` / `aiStep()` / `scheduleDecision()`
 *   - 悔棋（旧 js/app.js:1806-1866）    → `undo()` / `rebuildState()`
 *
 * 三处刻意与旧实现不同（报告「与旧实现不同的决定」逐条列出）：
 *  1. 旧 `S.epoch` 同时兼职「请求代次」和「在途标记」（`S.inflight = ++S.epoch`）。
 *     这里 `inflight` 单独持有发起时的 epoch 快照，`session.epoch` 只在换局/悔棋时自增；
 *     语义分开后 `busy`（思考中）判定不再依赖「epoch 恰好等于 inflight」这种巧合。
 *  2. 旧实现用裸 `setTimeout(aiStep, …)`，换局后回调仍会空转一次（靠 epoch 挡掉）。
 *     这里所有调度都经 `scheduleAIStep()`，`resetSession()/undo()/finishGame()` 显式取消。
 *  3. 引擎实例由 `ctx.engine` 持有（换棋种时由 `switchGame` 换掉），不像旧实现那样
 *     每次从 `BG.games[gid]` 现取——同一份注册表，等价。
 *
 * 本文件不 import node:*；网络只经 `ctx.sync`（内部走 `core/api/client.ts`）。
 */
import { isAISide, randomGameUid, resultTextOf } from '../core/session.ts';
import type { SessionMeta, SessionMove } from '../core/session.ts';
import type { GameStatus, Move } from '../core/types.ts';
import { decide } from '../core/jev/index.ts';
import { buildExperience, buildRecordEntry, ensureSessionId, loadRecords, saveRecords, upsertRecord } from '../core/record/book.ts';
import { buildGameExport } from '../core/record/export.ts';
import type { Experience } from '../core/tactics.ts';
import { sideLabel } from '../core/view/duel.ts';
import { machinePairText } from '../ui/panels/options.ts';
import { clone } from '../core/clone.ts';
import { isValidMode, effectiveChannelOf } from '../core/persist.ts';
import { byId, setText } from '../ui/dom.ts';
import type { SelectEl } from '../ui/dom.ts';
import { aiDelayMs, cancelAIStep, scheduleAIStep, startThinkClock, stopThinkClock } from './clock.ts';
import { effFor, sideNameOf } from './ctx.ts';
import type { AppCtx } from './ctx.ts';
import { renderBackend } from './backend.ts';
import {
  applyModeUI,
  restoreSideCfg,
  renderTacticsStripPanel,
  syncChannelUI,
  syncSettingsFromDrawer,
} from './modes.ts';
import {
  prependFeedPanel,
  renderAnalytics,
  renderCockpitPanel,
  renderEngineStatus,
  renderFeedPanel,
  renderLedgerPanel,
  appendLedgerPanel,
  renderRecordsPanel,
  renderSideNames,
  renderTurn,
  setStatus,
  setVisibleById,
  syncSwapBtn,
  toast,
} from './panels.ts';

/* ---------- 小工具 ---------- */

/**
 * AI 走子失败后的自动重试节奏（毫秒）。三次分别等 4/12/25 秒，合计约 41 秒——
 * 够熬过一次 30/分 限流窗口（服务端 429 会带 `Retry-After`，客户端内部还会再退避 5 次），
 * 又不至于让用户对着「出错」看几分钟。用完三次才落回手动「重试」按钮。
 */
export const AI_AUTO_RETRY_DELAYS_MS: readonly number[] = [4000, 12000, 25000];

/** 绘制失败只告警一次（画布环境坏了不该刷屏）。 */
let drawFailed = false;

/** 隐藏一个节点（不存在时静默）。 */
function hide(id: string): void {
  setVisibleById(id, false);
}

/** 显示一个节点（不存在时静默）。 */
function show(id: string): void {
  setVisibleById(id, true);
}

/** 当前该走子的一方是否 AI。 */
export function isTurnAI(ctx: AppCtx): boolean {
  const st = ctx.session.st;
  if (!st) return false;
  const turn = ctx.engine.getStatus(st).turn;
  return !!turn && isAISide(ctx.session, turn);
}

/** 状态行文案（旧 `inGameStatus()`，js/app.js:1820-1832）。 */
export function inGameStatus(ctx: AppCtx): string {
  const session = ctx.session;
  const sides = ctx.engine.sides;
  if (session.mode === 'ai-ai') {
    const first = effFor(ctx, sides[0].id);
    const second = sides[1] ? effFor(ctx, sides[1].id) : first;
    return '对局进行中 · ' + machinePairText(first, second);
  }
  if (session.mode === 'human-ai') {
    const human = session.humanSide || sides[0].id;
    const foe = sides.filter((sd) => sd.id !== human)[0] || sides[0];
    return '对局进行中 · 你执' + sideNameOf(ctx, human) + ' · 对手 ' + sideLabel(effFor(ctx, foe.id));
  }
  return '对局进行中 · 双人对弈';
}

/* ---------- 重画 ---------- */

/** 把当前引擎状态推给画布（旧 `redraw()`，js/app.js:592-597）。
 *  绘制失败只丢一帧：画布拿不到 2D 上下文（老 webview / 无 canvas 实现的环境）时
 *  不得让对局循环跟着崩掉（D8 降级而非报错）。 */
export function redraw(ctx: AppCtx): void {
  if (ctx.renderer) {
    try {
      ctx.renderer.draw({ engine: ctx.engine, state: ctx.session.st, ui: ctx.ui });
    } catch (e) {
      if (!drawFailed) {
        drawFailed = true;
        console.warn('[jev-qiguan] 棋盘绘制失败，后续帧仍会尝试', e);
      }
    }
  }
  renderTurn(ctx);
}

/* ---------- 换局 ---------- */

/**
 * 旧 `resetSession()`（js/app.js:556-598）：清空对局、复位所有运行时句柄与按钮态。
 * epoch 自增 + 中断在途请求是**同一个动作**——悔棋走的是同一段逻辑。
 */
export function resetSession(ctx: AppCtx): void {
  const session = ctx.session;
  session.epoch++;
  cancelAIStep(ctx);
  if (ctx.abortController) {
    ctx.abortController.abort();
    ctx.abortController = null;
  }
  ctx.inflight = null;
  ctx.aiAutoRetries = 0;
  stopThinkClock(ctx);
  session.paused = false;
  session.sessionRecorded = false;
  session.sessionId = null;
  session.result = null;
  session.endedAt = null;
  session.startedAt = Date.now();
  session.gameUid = randomGameUid();
  session.st = ctx.engine.newGame();
  session.history = [];
  ctx.ui = {};

  const meta = ctx.engine.meta;
  if (ctx.renderer && meta) ctx.renderer.resize(meta.w, meta.h);

  hide('promoBox');
  hide('retryBtn');
  hide('pauseBtn');
  hide('stepBtn');
  setVisibleById('passBtn', !!ctx.engine.supportsPass);
  setVisibleById('resignBtn', !!ctx.engine.supportsResign);
  setText(byId('pauseBtn'), '暂停');
  setText(byId('costChip'), '$0.00000');
  renderLedgerPanel(ctx);
  setStatus('已就绪：选择模式后点「开始对局」。', false);
  renderEngineStatus('idle', '待命');
  renderAnalytics(ctx);
  renderCockpitPanel(ctx);
  renderFeedPanel(ctx);
  redraw(ctx);
  syncSwapBtn(ctx);
}

/* ---------- 开始一局 ---------- */

/**
 * 旧 `startGame()`（js/app.js:502-530）。
 * @param opts.preserveSideCfg 实验编排调用时置 true：`expInfo` 由编排层填写，这里不覆盖。
 */
export function startGame(ctx: AppCtx, opts?: { preserveSideCfg?: boolean }): void {
  const session = ctx.session;
  syncSettingsFromDrawer(ctx);

  const modeEl = byId<SelectEl>('mode');
  if (modeEl && isValidMode(modeEl.value)) session.mode = modeEl.value;
  const sideEl = byId<SelectEl>('side');
  if (sideEl && sideEl.value) session.humanSide = sideEl.value;
  if (!opts || !opts.preserveSideCfg) {
    /* 手动开局还原：实验借用的 sideConfig 在这里还回去（旧 js/app.js:507-510） */
    session.expInfo = null;
    restoreSideCfg(ctx);
  }

  session.paused = false;
  resetSession(ctx);

  /* 渠道被降级成离线演示时提醒一次——旧实现只在 startGame 里提示（js/app.js:513-516） */
  const eff = effectiveChannelOf(ctx.settings, ctx.settings.channel);
  if (eff === 'mock' && ctx.settings.channel !== 'mock') {
    toast('自动进入离线演示（未填 key，或后端不可用）。接真实 Jev：填好 key 并保证 Worker 在线（本地 npm run dev，线上 jevqipan.logicc.top）', false);
  }

  applyModeUI(ctx);
  syncChannelUI(ctx);
  renderTacticsStripPanel(ctx);
  syncSwapBtn(ctx);
  renderSideNames(ctx);
  setStatus(inGameStatus(ctx), false);

  if (isTurnAI(ctx)) scheduleAIStep(ctx, () => aiStep(ctx), aiDelayMs(ctx));
}

/* ---------- 走子 ---------- */

/**
 * 旧 `playMove(move, meta)`（js/app.js:602-640）。返回是否真的落子。
 */
export function playMove(ctx: AppCtx, move: Move | null | undefined, meta: SessionMeta | null): boolean {
  const session = ctx.session;
  const st = session.st;
  if (!move || !st) return false;
  const before = ctx.engine.getStatus(st);
  if (before.over) return false;

  const h: SessionMove = {
    ply: session.history.length + 1,
    side: before.turn || '',
    move,
    meta: meta || null,
  };
  session.history.push(h);
  session.st = ctx.engine.applyMove(st, move);

  /* F3：棋谱面板增量追加（此前每手全量重建 + 每行一次滚动写，225 手的局是 O(n²)）。
   * 第一手仍走全量重建——要把「对局开始后…」的空态占位清掉。 */
  if (session.history.length === 1) renderLedgerPanel(ctx);
  else appendLedgerPanel(ctx, h);
  redraw(ctx);
  renderAnalytics(ctx);
  renderCockpitPanel(ctx);
  if (meta && meta.byAI) prependFeedPanel(ctx, h);
  syncSwapBtn(ctx);

  const g = ctx.engine.getStatus(session.st);
  if (g.over) {
    finishGame(ctx, g);
    return true;
  }
  if (isTurnAI(ctx)) scheduleAIStep(ctx, () => aiStep(ctx), aiDelayMs(ctx));
  return true;
}

/** 旧 `aiStep()`（js/app.js:660-668）：一次只允许一个在途决策。 */
export function aiStep(ctx: AppCtx): void {
  const session = ctx.session;
  const st = session.st;
  if (!st) return;
  if (ctx.inflight != null) return;
  if (ctx.engine.getStatus(st).over) return;
  if (session.mode === 'ai-ai' && session.paused) return;
  void scheduleDecision(ctx);
}

/** 旧 `scheduleAI()`（js/app.js:642-658）：发起一次 AI 决策并落子。 */
export async function scheduleDecision(ctx: AppCtx): Promise<void> {
  const session = ctx.session;
  const st = session.st;
  if (!st) return;
  if (ctx.inflight != null) return;
  const g0 = ctx.engine.getStatus(st);
  if (g0.over) return;

  const myEpoch = session.epoch;
  ctx.inflight = myEpoch;
  const aborter = new AbortController();
  ctx.abortController = aborter;

  const side = g0.turn || '';
  startThinkClock(ctx, side);
  renderEngineStatus('thinking', '推理中');

  const eff = effFor(ctx, side);
  const cfg = ctx.settings;
  const apiKey = eff.channel === 'openrouter' ? cfg.orKey : cfg.apiKey;
  const endpoint = (cfg.endpoints && cfg.endpoints[eff.channel]) || '';

  try {
    const decision = await decide(ctx.engine, st, side, {
      channel: eff.channel,
      apiKey,
      endpoint,
      topK: cfg.topK,
      rapfiThinkMs: eff.rapfiThinkMs,
      tacticsVersion: eff.tactics,
      signal: aborter.signal,
      rapfiOnProgress: (stage, detail) => {
        /* F1：Rapfi 资产下载进度（此前 11 MB 下载期间界面只有一个「推理中」+秒数）。 */
        if (stage === 'download' && detail) setStatus(`⏬ ${detail}`, false);
        else if (stage === 'script') setStatus('⏬ 正在加载 Rapfi 引擎脚本…', false);
        else if (stage === 'wasm') setStatus('⏬ 正在下载 Rapfi 引擎资产（约 11 MB，仅首次）…', false);
      },
      experience: (buildExperience(ctx.session.gameId, ctx.session.history, ctx.records) ?? undefined) as Experience | undefined,
      onRetry: (code: number | string) => toast('限流(' + code + ')，退避重试中…', false),
    });
    if (myEpoch !== session.epoch) return;
    if (!decision || !decision.move) {
      setStatus('⚠ AI 没给出可用着法', true);
      toast('AI 未返回可走着法', true);
      show('retryBtn');
      return;
    }
    const meta = (decision.meta || {}) as SessionMeta;
    meta.byAI = true;
    meta.side = side;
    meta.sideName = sideNameOf(ctx, side);
    hide('retryBtn');
    ctx.aiAutoRetries = 0;
    playMove(ctx, decision.move, meta);
  } catch (e) {
    if (myEpoch !== session.epoch) return;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'aborted') return;
    /* 可重试失败（限流/网络）自动退避重试：机机对局与对比实验都是无人值守的，
     * 一次 429 就停摆会让整轮实验报废（真实事故：30/分 的限流把 4 局实验卡死在第 1 局）。
     * 只对客户端打了 `retryable` 标记的错误重试，鉴权/格式错误仍然立刻交给用户。 */
    const retryable = Boolean((e as { retryable?: boolean }).retryable);
    if (retryable && ctx.aiAutoRetries < AI_AUTO_RETRY_DELAYS_MS.length) {
      const delay = AI_AUTO_RETRY_DELAYS_MS[ctx.aiAutoRetries] as number;
      ctx.aiAutoRetries += 1;
      const left = AI_AUTO_RETRY_DELAYS_MS.length - ctx.aiAutoRetries;
      setStatus(`⚠ AI 出错：${msg} · ${Math.round(delay / 1000)} 秒后自动重试（第 ${ctx.aiAutoRetries} 次，剩 ${left} 次）`, true);
      toast(`Jev 调用失败：${msg} · 自动重试中…`, false);
      show('retryBtn');
      scheduleAIStep(ctx, () => aiStep(ctx), delay);
      return;
    }
    setStatus('⚠ AI 出错：' + msg, true);
    toast('Jev 调用失败：' + msg, true);
    show('retryBtn');
    // 机机模式没人能救场，自动停下来等用户处理（旧实现行为）
    if (session.mode === 'ai-ai') setPaused(ctx, true);
  } finally {
    stopThinkClock(ctx);
    if (ctx.abortController === aborter) ctx.abortController = null;
    if (ctx.inflight === myEpoch) ctx.inflight = null;
    const st2 = ctx.session.st;
    const g = st2 ? ctx.engine.getStatus(st2) : null;
    renderTurn(ctx);
    renderEngineStatus(g && g.over ? 'idle' : 'running', g && g.over ? '已终局' : '对局中');
  }
}

/** 旧 `setPaused(p)`（js/app.js:670-680）：暂停/继续，继续时机机模式立刻续跑。 */
export function setPaused(ctx: AppCtx, p: boolean): void {
  ctx.session.paused = p;
  setText(byId('pauseBtn'), p ? '继续' : '暂停');
  if (!p && ctx.session.mode === 'ai-ai' && isTurnAI(ctx) && ctx.inflight == null) {
    scheduleAIStep(ctx, () => aiStep(ctx), 250);
  }
}

/** 旧 `#stepBtn`（js/app.js:1922）：暂停中单步推进一步 AI。 */
export function stepOnce(ctx: AppCtx): void {
  if (ctx.session.paused && isTurnAI(ctx) && ctx.inflight == null) {
    scheduleAIStep(ctx, () => aiStep(ctx), 0);
  }
}

/** 旧 `#retryBtn`（js/app.js:1914-1920）：AI 出错后手动重试。 */
export function retryAI(ctx: AppCtx): void {
  hide('retryBtn');
  ctx.aiAutoRetries = 0; /* 手动了就重新给满自动重试额度 */
  setPaused(ctx, false);
  setStatus(inGameStatus(ctx), false);
  aiStep(ctx);
}

/** 旧 `#passBtn`（js/app.js:1923-1927）：只有引擎支持停着且轮到人类时才可用。 */
export function passTurn(ctx: AppCtx): void {
  const session = ctx.session;
  const st = session.st;
  if (!st || ctx.inflight != null) return;
  if (typeof ctx.engine.passMove !== 'function') return;
  if (isTurnAI(ctx)) return;
  const pm = ctx.engine.passMove(st) as Move | undefined;
  if (pm) playMove(ctx, pm, { human: true });
}

/** 旧 `#resignBtn`（js/app.js:1928-1934）：人类认输，`by:'human'` 供实验报告标「人判」。 */
export function resign(ctx: AppCtx): void {
  const session = ctx.session;
  const st = session.st;
  if (!st || ctx.inflight != null) return;
  const g0 = ctx.engine.getStatus(st);
  if (g0.over) return;
  const loser = g0.turn || '';
  const opp = ctx.engine.sides.filter((sd) => sd.id !== loser)[0];
  /* 引擎的 getStatus 一律先看 `st.result`（七个引擎都如此），所以「认输」就是
     往克隆出来的状态上盖一个终局判定——与旧实现逐字一致。 */
  const next = clone(st) as { result?: unknown };
  next.result = { over: true, winner: opp ? opp.id : null, reason: '认输', by: 'human' };
  session.st = next;
  redraw(ctx);
  finishGame(ctx, ctx.engine.getStatus(next));
}

/* ---------- 终局 ---------- */

/** 旧 `finishGame(g)`（js/app.js:531-555）：写状态行 + 记账 + 同步 + 通知实验编排。 */
export function finishGame(ctx: AppCtx, g: GameStatus): void {
  const session = ctx.session;
  cancelAIStep(ctx);
  session.endedAt = Date.now();
  session.result = {
    text: resultTextOf(ctx.engine, g),
    over: true,
    winner: g.winner ?? null,
    reason: g.reason || '',
    endBy: g.by == null ? null : String(g.by),
  };

  const txt = g.winner
    ? sideNameOf(ctx, g.winner) + ' 获胜' + (g.reason ? '（' + g.reason + '）' : '')
    : g.reason === '换边中断'
      ? '未终局（' + g.reason + '）'
      : '和棋：' + (g.reason || '');
  setStatus('终局 · ' + txt, true);
  toast(txt, false);

  hide('pauseBtn');
  hide('stepBtn');
  hide('retryBtn');
  hide('promoBox');
  renderEngineStatus('idle', '已终局');
  renderTurn(ctx);

  saveGameRecord(ctx, g);
  void uploadGameRecord(ctx, g);
  if (ctx.onGameEnd) ctx.onGameEnd(g);
}

/* ---------- 记账与同步 ---------- */

/** 旧 `saveGameRecord(g)`（js/app.js:1548-1582）：本机战绩簿落 localStorage。 */
export function saveGameRecord(ctx: AppCtx, g: GameStatus): void {
  const id = ensureSessionId(ctx.session);
  const rec = buildRecordEntry(ctx.session, ctx.engine, g, { id });
  ctx.records = upsertRecord(loadRecords(ctx.storage), rec);
  saveRecords(ctx.storage, ctx.records);
  renderRecordsPanel(ctx);
}

/** 旧 `uploadGameRecord()`（js/app.js:805-837）：终局后把棋谱推进同步队列。 */
export async function uploadGameRecord(ctx: AppCtx, g: GameStatus): Promise<void> {
  void g;
  if (!ctx.settings.gameSync || !ctx.session.history.length) return;
  const record = buildGameExport(ctx.session, ctx.engine);
  const res = await ctx.sync.sync(record);
  if (res && !res.skipped) ctx.backend.lastSync = { ok: !!res.ok, text: res.text };
  renderBackend(ctx);
}

/* ---------- 悔棋 ---------- */

/** 旧 `rebuildState(n)`（js/app.js:1806-1818）：从头重放前 n 手。 */
export function rebuildState(ctx: AppCtx, n: number): unknown {
  let st = ctx.engine.newGame();
  for (let i = 0; i < n; i++) {
    const h = ctx.session.history[i];
    const notation = h ? h.move.notation : '';
    const mv = notation ? ctx.engine.moveFromNotation(st, notation) : null;
    if (!mv) {
      console.warn('悔棋重放失败于第 ' + (i + 1) + ' 手：' + notation);
      return ctx.engine.newGame();
    }
    st = ctx.engine.applyMove(st, mv);
  }
  return st;
}

/** 旧 `undo()`（js/app.js:1840-1866）：人机模式一次退两手（自己 + 对手）。 */
export function undo(ctx: AppCtx): void {
  const session = ctx.session;
  if (!session.history.length) return;
  session.epoch++;
  cancelAIStep(ctx);
  if (ctx.abortController) {
    ctx.abortController.abort();
    ctx.abortController = null;
  }
  ctx.inflight = null;
  stopThinkClock(ctx);

  const last = session.history[session.history.length - 1];
  const steps = session.mode === 'human-ai' && last && last.meta && last.meta.byAI
    ? Math.min(2, session.history.length)
    : 1;
  for (let i = 0; i < steps; i++) session.history.pop();
  session.st = rebuildState(ctx, session.history.length);
  session.paused = false;

  setText(byId('pauseBtn'), '暂停');
  if (session.mode === 'ai-ai') show('pauseBtn');
  hide('stepBtn');
  hide('retryBtn');
  setStatus(session.history.length ? inGameStatus(ctx) : '已就绪：选择模式后点「开始对局」。', false);

  renderLedgerPanel(ctx);
  renderAnalytics(ctx);
  renderCockpitPanel(ctx);
  renderFeedPanel(ctx);
  redraw(ctx);
  syncSwapBtn(ctx);

  if (session.history.length && isTurnAI(ctx)) scheduleAIStep(ctx, () => aiStep(ctx), aiDelayMs(ctx));
}

/* ---------- 换边重开 ---------- */

/** 旧 `swapSidesAndRestart()`（js/app.js:686-704）：把未终局的对局记成「未终局」再换边。 */
export function swapSidesAndRestart(ctx: AppCtx): void {
  const session = ctx.session;
  if (session.mode !== 'human-ai') return;
  const st = session.st;
  if (session.history.length && st && !ctx.engine.getStatus(st).over) {
    finishGame(ctx, { over: true, winner: null, reason: '换边中断' });
  }
  const human = session.humanSide || ctx.engine.sides[0].id;
  const other = ctx.engine.sides.filter((sd) => sd.id !== human)[0] || ctx.engine.sides[0];
  session.humanSide = other.id;
  const sideEl = byId<SelectEl>('side');
  if (sideEl) sideEl.value = other.id;
  startGame(ctx);
}
