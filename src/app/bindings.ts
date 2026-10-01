/* bindings.ts — 事件接线（旧 `js/app.js` 的「事件绑定」段，js/app.js:1872-2016）
 *
 * 三层分工（P6a 已把「只绑一次」做成 `src/ui/dom.ts` 的 `onOnce()`）：
 *   1. **静态节点**（`#startBtn`/`#undoBtn`/`#board`…）由本文件绑，元素级处理器走 `onOnce`，
 *      重复装配不叠加监听器；
 *   2. **面板内部动态节点**由 `src/ui/panels/*` 在重建子树时自己绑（`renderSettings` /
 *      `renderSideSlotInto` / `renderRecords`），装配层只提供 handlers；
 *   3. **跨模块转交**（对局设置、模式按钮、实验启停、趋势芯片、清空战绩簿）走 ui 的
 *      `bind*`，避免同一元素被两处重复绑定。
 *
 * 旧 `js/board.js:211-217` 的 `BG.eventXY()` 没有进新架构（`js/**` 已在 P8 删除，旧实现只留在
 * `docs/architecture.md` 与 ADR 的历史记述里），这里按同一口径重新实现：逻辑尺寸取
 * `src/core/gfx.ts` 的 `setup()` 写在 canvas 上的 `_logicalW/_logicalH`（DPR 与 CSS 缩放都在那里处理过），
 * 读不到时退回 `engine.meta`。
 *
 * 本文件不 import node:*；网络只经 `ctx.sync` / `core/api/client.ts`。
 */
import { byId, el, on, onOnce, replaceChildren, setHidden } from '../ui/dom.ts';
import type { SelectEl } from '../ui/dom.ts';
import type { Move } from '../core/types.ts';
import type { FoldHooks } from '../ui/panels/collapse.ts';
import { RECORDS_KEY } from '../core/record/book.ts';
import { buildGameExport } from '../core/record/export.ts';
import { bindTrendChips } from '../ui/panels/cockpit.ts';
import { bindClearRecords } from '../ui/panels/record-book.ts';
import { bindExperimentPanel, bindMatchSettings, bindModeSwitch } from '../ui/panels/experiment.ts';
import { loadGameArchive } from './records.ts';
import {
  isTurnAI,
  passTurn,
  playMove,
  redraw,
  resign,
  retryAI,
  setPaused,
  startGame,
  stepOnce,
  swapSidesAndRestart,
  undo,
} from './loop.ts';
import {
  applyModeUI,
  closeDrawer,
  openDrawer,
  renderExpSides,
  renderFoe,
  runProbe,
  saveExpSide,
  saveFoe,
  syncSettingsFromDrawer,
} from './modes.ts';
import {
  loadLeaderboardPanel,
  loadOpeningsPanel,
  refreshDataPanels,
  renderAnalytics,
  renderCalibrationPanel,
  renderCockpitPanel,
  renderFeedPanel,
  renderReplayerPanel,
  renderRecordsPanel,
  setVisible,
  toast,
} from './panels.ts';
import {
  onExperimentGameEnd,
  renderExpHistoryPanel,
  renderExperimentPanelView,
  startExperiment,
  stopExperiment,
} from './experiment.ts';
import type { AppCtx } from './ctx.ts';

/* ---------- 棋盘坐标与交互（旧 js/board.js:211-217 + js/app.js:1981-2014） ---------- */

/** canvas 事件坐标 → 逻辑坐标（旧 `BG.eventXY`）。 */
export function eventXY(
  canvas: HTMLCanvasElement,
  ev: { clientX: number; clientY: number },
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const logical = canvas as unknown as { _logicalW?: number; _logicalH?: number };
  const w = logical._logicalW || rect.width || 1;
  const h = logical._logicalH || rect.height || 1;
  const rw = rect.width || w;
  const rh = rect.height || h;
  return {
    x: (ev.clientX - rect.left) * (w / rw),
    y: (ev.clientY - rect.top) * (h / rh),
  };
}

/** 升变候选框（旧 `showPromo(pc)`，js/app.js:2000-2014）。 */
export function showPromo(ctx: AppCtx, pc: { from: string; to: string }): void {
  const box = byId<HTMLElement>('promoBox');
  if (!box) return;
  const names: Record<string, string> = { Q: '后', R: '车', B: '象', N: '马' };
  const buttons = ['Q', 'R', 'B', 'N'].map((p) =>
    el('button', {
      type: 'button',
      onclick: () => {
        setVisible(box, false);
        const st = ctx.session.st;
        if (st == null) return;
        const mv = ctx.engine.moveFromNotation(st, pc.from + pc.to + '=' + p) as Move | null;
        if (mv) playMove(ctx, mv, { human: true });
      },
    }, names[p] ?? p),
  );
  replaceChildren(box, [el('div', { class: 't' }, '选择升变的棋子'), ...buttons]);
  setVisible(box, true);
}

/** `#board` 点击（旧 js/app.js:1981-1991）：人类走子 → 升变 → 落子。 */
export function onBoardClick(ctx: AppCtx, ev: { clientX: number; clientY: number }): void {
  const canvas = byId<HTMLCanvasElement>('board');
  const st = ctx.session.st;
  if (!canvas || st == null) return;
  if (ctx.inflight != null) return;
  if (ctx.engine.getStatus(st).over) return;
  if (isTurnAI(ctx)) return;
  if (typeof ctx.engine.humanClick !== 'function') return;
  const { x, y } = eventXY(canvas, ev);
  const r = ctx.engine.humanClick(st, ctx.ui, x, y) as
    | (Move & { promoChoice?: { from: string; to: string } })
    | null
    | undefined;
  if (!r) return;
  if (r.promoChoice) {
    showPromo(ctx, r.promoChoice);
    return;
  }
  playMove(ctx, r, { human: true });
}

/* ---------- 棋谱导出（旧 js/app.js:790-803） ---------- */

/** 旧 `exportGame()`：纯下载动作；payload 由 `core/record/export.ts` 生成。 */
export function exportGame(ctx: AppCtx): void {
  if (!ctx.session.history.length) {
    toast('还没有棋步可导出', true);
    return;
  }
  const data = buildGameExport(ctx.session, ctx.engine);
  const name = 'jev-' + ctx.session.gameId + '-' +
    new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.json';
  /* 非浏览器环境（老 webview / 测试桩）可能没有 Blob URL —— 旧实现会直接抛，
     这里退回「只提示文件名」，绝不让导出把页面炸掉（D8：降级而非报错）。 */
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    toast('当前环境不支持文件下载：' + name, true);
    return;
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
  toast('棋谱已导出 ' + name);
}

/* ---------- 折叠钩子（旧 FOLD_HOOKS，js/app.js:333-341） ---------- */

/** 展开面板时的补渲染钩子（隐藏期间容器量宽为 0，图表/画布必须展开后重画）。 */
export function foldHooks(ctx: AppCtx): FoldHooks {
  return {
    trend: () => renderAnalytics(ctx),
    duel: () => renderCockpitPanel(ctx),
    latest: () => renderCockpitPanel(ctx),
    feed: () => renderFeedPanel(ctx),
    records: () => renderRecordsPanel(ctx),
    cal: () => renderCalibrationPanel(ctx),
    archive: () => {
      void loadGameArchive(ctx);
    },
    replayer: () => renderReplayerPanel(ctx),
    leaderboard: () => {
      void loadLeaderboardPanel(ctx);
    },
    openings: () => {
      void loadOpeningsPanel(ctx);
    },
  };
}

/* ---------- 机器对手面板（旧 js/app.js:1016-1033 的读侧） ---------- */

/** 读机器对手面板三项（旧 `saveFoe()`：一次读全，任一控件变更即整份写回白方覆盖）。 */
function readFoePatch(): { channel: string; tactics: string; rapfiThinkMs: number } {
  const ch = byId<SelectEl>('foeChannel');
  const tac = byId<SelectEl>('foeTactics');
  const think = byId<SelectEl>('foeThink');
  return {
    channel: ch ? ch.value : '',
    tactics: tac ? tac.value : '',
    rapfiThinkMs: think ? (parseInt(think.value, 10) || 0) : 0,
  };
}

/* ---------- 总装 ---------- */

/** 旧 `bind()`（js/app.js:1896-1997）的等价物。可重复调用（元素级走 `onOnce`）。 */
export function bindAll(ctx: AppCtx): void {
  /* 对局按钮组 */
  onOnce(byId('startBtn'), 'click', () => startGame(ctx));
  onOnce(byId('undoBtn'), 'click', () => undo(ctx));
  onOnce(byId('pauseBtn'), 'click', () => setPaused(ctx, !ctx.session.paused));
  onOnce(byId('retryBtn'), 'click', () => retryAI(ctx));
  onOnce(byId('stepBtn'), 'click', () => stepOnce(ctx));
  onOnce(byId('passBtn'), 'click', () => passTurn(ctx));
  onOnce(byId('resignBtn'), 'click', () => resign(ctx));
  onOnce(byId('swapBtn'), 'click', () => swapSidesAndRestart(ctx));
  onOnce(byId('exportGame'), 'click', () => exportGame(ctx));

  /* 对局设置：`#mode` / `#side` / `#speed`（ui 侧 onOnce 绑定，这里只给处理器）。
     旧实现 `#mode.onchange = applyModeUI`、`#speed.oninput = 写 #speedVal + saveSettings`；
     `#side` 没有实时处理器（值在 `startGame()` 才被读走）——保持等价，不给它附加行为。 */
  bindMatchSettings({
    onModeChange: () => applyModeUI(ctx),
    onSpeedChange: () => syncSettingsFromDrawer(ctx),
  }, document);

  /* 模式按钮组：`#mode` 是状态源，按钮只是另一个入口（实验跑动中锁定并静默忽略） */
  bindModeSwitch((mode) => {
    const modeEl = byId<SelectEl>('mode');
    if (modeEl) modeEl.value = mode;
    applyModeUI(ctx);
  }, document, () => ctx.exp.running);

  /* 机器对手面板：三项任一改动即整份写回白方覆盖，并刷新面板文案 */
  for (const id of ['foeChannel', 'foeTactics', 'foeThink']) {
    onOnce(byId(id), 'change', () => {
      saveFoe(ctx, readFoePatch());
      renderFoe(ctx);
    });
  }

  /* 测试连接：抽屉正文里的 `#probeBtn` 由 renderSettings 重建时自绑 onProbe，
     这里兜底绑一次（静态夹具里也可能有这个 id） */
  onOnce(byId('probeBtn'), 'click', () => {
    void runProbe(ctx);
  });

  /* 归档重载（顺带刷新 P7c 的排行榜 / 开局库：三块数据面板共用这个「刷新」入口） */
  onOnce(byId('archiveReload'), 'click', () => {
    void loadGameArchive(ctx);
    refreshDataPanels(ctx);
  });

  /* 趋势芯片（胜率 / 形势分 / 置信度） */
  bindTrendChips((mode) => {
    ctx.session.trendMode = mode;
    renderAnalytics(ctx);
  });

  /* 战绩簿：清空本机记录（旧 `#clearRecords`） */
  bindClearRecords(() => {
    try {
      ctx.storage.removeItem?.(RECORDS_KEY);
    } catch (_e) {
      /* 存储被禁用：忽略，与旧实现一致 */
    }
    renderRecordsPanel(ctx);
    toast('战绩簿已清空');
  });

  /* 实验面板：启停 + 局数 + A/B 档位 */
  bindExperimentPanel({
    onStart: () => startExperiment(ctx),
    onStop: () => stopExperiment(ctx),
    onGamesChange: () => renderExperimentPanelView(ctx),
    onSideChange: (side, patch) => {
      saveExpSide(ctx, side, patch);
      renderExpSides(ctx);
    },
  }, document);
  /* 终局 → 实验编排收局（旧 `finishGame()` 里的 `if (EXP.running) {…}`） */
  ctx.onGameEnd = (g) => onExperimentGameEnd(ctx, g);
  renderExpSides(ctx);
  renderExpHistoryPanel(ctx);

  /* 设置抽屉：齿轮开；遮罩/关闭按钮由 renderSettings 自绑 */
  onOnce(byId('settingsGear'), 'click', () => openDrawer(ctx));

  /* 棋盘 */
  onOnce(byId('board'), 'click', (ev) => onBoardClick(ctx, ev as MouseEvent));

  /* 文档/窗口级：Esc 关抽屉（旧 js/app.js:1979）、可见性/焦点/尺寸变化后强制重绘
     （旧 js/app.js:1995-1997：内嵌 webview 会在页签隐藏期间丢弃 canvas 表面）。
     这四个用 `on()` 而非 `onOnce`：`document`/`globalThis` 是**跨 ctx 共享**的宿主对象，
     onOnce 会让第二个 ctx 静默失去重绘；重复装配的后果只是多一次幂等重画。 */
  on(document, 'keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Escape') closeDrawer();
  });
  on(document, 'visibilitychange', () => {
    if (!document.hidden) redraw(ctx);
  });
  on(globalThis as unknown as EventTarget, 'focus', () => redraw(ctx));
  on(globalThis as unknown as EventTarget, 'resize', () => redraw(ctx));
}
