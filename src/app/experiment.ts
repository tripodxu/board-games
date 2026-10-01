/* experiment.ts — 对比实验 A/B 编排（旧 js/app.js:1138-1238 的「对比实验」段）
 *
 * 旧实现把编排状态放在闭包常量 `EXP` 里，并且**直接改 `S.settings.sideConfig`** 来给
 * 每一局装配置（`S.settings.sideConfig = {black: mk(A), white: mk(B)}`）。新架构保留这个
 * 做法（`effSide()` 即取即用，人机与实验共用同一套双方配置），但补了两件事：
 *   1. 开跑前 `borrowSideCfg()` 快照、结束后由 `startGame()` 的 `restoreSideCfg()` 还原
 *      （旧实现也有，只是散在 loop 与 modes 两处）；
 *   2. 「下一局」的 setTimeout 句柄存在 `ctx.expTimer`，与 AI 走子的 `ctx.aiTimer` 分开——
 *      旧实现两者共用一个匿名 timeout 池，悔棋/换局时 `resetSession` 不碰实验推进，
 *      这里显式区分，避免 loop 的 `cancelAIStep()` 顺手掐掉实验连跑。
 *
 * 「A/B 归属」只看**胜方是黑是白 + 局号奇偶**，绝不按渠道名比对（旧实现注释里的教训，
 * js/app.js:572-574）：A/B 同渠道时（Jev·v8 vs Jev·v9）按渠道比会把战报写坏。
 */
import { saveExperiment } from '../core/api/client.ts';
import { sideAttribution } from '../ui/panels/options.ts';
import {
  beginRun,
  endRun,
  expSummary,
  expTag,
  mkSide,
  planGame,
  pushResult,
  readExperimentConfig,
  renderExpResults,
  renderExpStatus,
  renderModeSwitch,
  syncMatchSettings,
  winnerSideOf,
} from '../ui/panels/experiment.ts';
import { createExpHistoryStore, newEntryFromRun, recordExperiment as recordExperimentEntry, renderExpHistory } from '../ui/panels/experiment-report.ts';
import { byId, clear } from '../ui/dom.ts';
import type { SelectEl } from '../ui/dom.ts';
import type { GameStatus } from '../core/types.ts';
import { refreshServerExperiments } from './backend.ts';
import type { AppCtx } from './ctx.ts';
import { startGame } from './loop.ts';
import { borrowSideCfg, modeValue, syncFoeEnabled } from './modes.ts';
import { setStatus, toast } from './panels.ts';

/** 实验推进的间隔（旧 `setTimeout(…, 2500)`，js/app.js:590）。 */
export const EXP_NEXT_DELAY_MS = 2500;

/** 某一侧的归因一行（旧 `lbl`，js/app.js:1186）。 */
function sideLbl(ctx: AppCtx, who: 'A' | 'B'): string {
  const cfg = mkSide(ctx.exp, who);
  return sideAttribution(cfg.channel, cfg.tactics, cfg.rapfiThinkMs);
}

/** 实验面板重画（配置草稿 + 对局设置 + 状态 + 结果）。 */
export function renderExperimentPanelView(ctx: AppCtx): void {
  renderModeSwitch(modeValue(ctx), ctx.exp.running);
  renderExpStatus(ctx.exp);
  renderExpResults(ctx.exp);
}

/** 旧 `renderExpHistory()`：实验战报从本机归档读，不在服务端往返。 */
export function renderExpHistoryPanel(ctx: AppCtx): void {
  renderExpHistory(createExpHistoryStore(ctx.storage).list());
}

/** 旧 `startExperiment()`（js/app.js:1150-1165）。 */
export function startExperiment(ctx: AppCtx): void {
  const state = ctx.exp;
  if (state.running) return;
  borrowSideCfg(ctx); // 借走 sideConfig，跑完还原用户抽屉里的配置
  beginRun(state, readExperimentConfig(), expTag());
  clear(byId('expResults'));
  renderModeSwitch('ai-ai', true);
  syncFoeEnabled(ctx);
  runExperimentGame(ctx);
}

/**
 * 旧 `runExperimentGame()`（js/app.js:1166-1189）：装这一局的双方配置并开跑。
 * `planGame()` 返回 null（未在跑 / 已跑满）时直接收尾。
 */
export function runExperimentGame(ctx: AppCtx): void {
  const state = ctx.exp;
  const plan = planGame(state);
  if (!plan) {
    finishExperiment(ctx);
    return;
  }

  /* 直接写 sideConfig：人机与实验共用同一套双方配置，effSide 即取即用 */
  ctx.settings.sideConfig = { black: plan.blackCfg, white: plan.whiteCfg };
  ctx.session.expInfo = plan.expInfo;

  const modeEl = byId<SelectEl>('mode');
  if (modeEl) modeEl.value = 'ai-ai';
  renderModeSwitch('ai-ai', true);
  syncMatchSettings({
    mode: 'ai-ai',
    side: ctx.session.humanSide || '',
    speed: ctx.settings.speed,
    locked: true,
  });

  startGame(ctx, { preserveSideCfg: true }); // preserveSideCfg: 实验期间不清 expInfo、不还原快照

  setStatus('实验 ' + plan.gameNo + '/' + state.total + '：' +
    sideLbl(ctx, plan.black) + '（黑） vs ' + sideLbl(ctx, plan.white) + '（白）', false);
  renderExpStatus(state);
}

/** 旧 `stopExperiment()`（js/app.js:1190-1195）：只停跑，`sideConfig` 保留（复盘时联名仍要能还原）。 */
export function stopExperiment(ctx: AppCtx): void {
  cancelExpTimer(ctx);
  endRun(ctx.exp);
  ctx.session.expInfo = null;
  renderModeSwitch(modeValue(ctx), false);
  renderExpStatus(ctx.exp);
  syncFoeEnabled(ctx);
  toast('实验已停止', false);
}

/** 旧 `finishExperiment()`（js/app.js:1196-1201）。 */
export function finishExperiment(ctx: AppCtx): void {
  cancelExpTimer(ctx);
  endRun(ctx.exp);
  ctx.session.expInfo = null;
  renderModeSwitch(modeValue(ctx), false);
  renderExpStatus(ctx.exp);
  renderExpResults(ctx.exp);
  syncFoeEnabled(ctx);
  recordExperimentRun(ctx);
  toast('实验完成：' + expSummary(ctx.exp), false);
}

/** 取消「下一局」的调度（换局/悔棋不该碰它，但停止/收尾必须碰）。 */
export function cancelExpTimer(ctx: AppCtx): void {
  if (ctx.expTimer != null) {
    clearTimeout(ctx.expTimer);
    ctx.expTimer = null;
  }
}

/**
 * 终局钩子（旧 `finishGame()` 里的 `if (EXP.running) {…}`，js/app.js:568-591）。
 * 由 `loop.finishGame()` 经 `ctx.onGameEnd` 调用。
 */
export function onExperimentGameEnd(ctx: AppCtx, g: GameStatus): void {
  const state = ctx.exp;
  if (!state.running) return;
  const info = ctx.session.expInfo;
  /* A/B 归属必须在 pushResult()（会自增 idx）之前算：它依赖当前局号 */
  const winnerChan = winnerSideOf(state.idx + 1, g.winner ?? null, ctx.engine.sides[0].id);
  pushResult(state, {
    blackChan: info ? info.blackChannel : '',
    whiteChan: info ? info.whiteChannel : '',
    blackTac: info ? info.blackTactics : null,
    whiteTac: info ? info.whiteTactics : null,
    blackThink: info ? info.blackThink : 0,
    whiteThink: info ? info.whiteThink : 0,
    winner: g.winner ?? null,
    winnerChan,
    /* 人判认输：这一分不是引擎打出来的，实验报告要能标出来 */
    by: g.by == null ? null : String(g.by),
  });
  renderExpStatus(state);
  renderExpResults(state);

  cancelExpTimer(ctx);
  ctx.expTimer = setTimeout(() => {
    ctx.expTimer = null;
    if (ctx.exp.running) runExperimentGame(ctx);
  }, EXP_NEXT_DELAY_MS);
}

/** 旧 `recordExperiment()`（js/app.js:1307-1330）：本地归档 + 上报服务端。 */
export function recordExperimentRun(ctx: AppCtx): void {
  const store = createExpHistoryStore(ctx.storage);
  const entry = newEntryFromRun(ctx.exp);
  recordExperimentEntry(store, entry);
  renderExpHistory(store.list());
  void saveExperiment(entry).then((r) => {
    /* `saveExperiment` 的返回体是 `unknown | null`（client.ts:150），这里只关心 ok。 */
    const resp = r as { ok?: boolean } | null;
    if (resp && resp.ok) void refreshServerExperiments(ctx);
  });
}
