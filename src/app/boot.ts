/* boot.ts — 应用装配与启动（旧 `js/app.js`:2048-2065 的 `DOMContentLoaded` 段）
 *
 * 为什么单独一个模块而不是直接写在 `main.ts` 里：`main.ts` 是**有副作用的页面入口**
 * （import 即启动），测试没法在受控夹具上跑启动路径。这里把启动拆成纯函数
 * `boot(opts)`——测试可以先摆好 DOM 与内存 storage，再 `boot({storage})` 拿到 ctx 断言；
 * 真正的自动启动只有 `main.ts` 那 6 行。
 *
 * 旧启动顺序（逐字对照，`js/app.js`:2049-2064）：
 *   buildTabs → loadSettings → renderSideCfg → renderFoe → renderTacticsStrip → initFolds
 *   → initSideTabs → bind → syncModeButtons → switchGame('gomoku') → renderRecords
 *   → #speedVal 回填 → initBackend（不阻塞首屏）→ ?test=1 时 runTests
 * 顺序有语义：`initFolds`/`initSideTabs` 必须在面板已有初值后跑（它们会按存储应用折叠态），
 * `switchGame` 在 `bind` 之后（它会重置会话，早跑会被随后的 reset 冲掉）。
 *
 * 本文件不 import node:*；网络只经 `backend.initBackend` → `core/api/client.ts`。
 */
import type { StorageLike } from '../core/persist.ts';
import { isValidMode, loadSettings } from '../core/persist.ts';
import { getGame } from '../core/registry.ts';
import { createSession, randomGameUid } from '../core/session.ts';
import { loadRecords } from '../core/record/book.ts';
import { createSyncQueue, postViaSaveGame } from '../core/record/sync.ts';
import { saveGame } from '../core/api/client.ts';
import { createBoardRenderer } from '../ui/board-render.ts';
import type { BoardRenderer } from '../ui/board-render.ts';
import { createFoldStore, FOLD_DEFAULT_OPEN, initFolds } from '../ui/panels/collapse.ts';
import { createExperimentState, renderModeSwitch, syncMatchSettings } from '../ui/panels/experiment.ts';
import { createSideTabStore, initSideTabs } from '../ui/panels/tabs.ts';
import { byId } from '../ui/dom.ts';
import { initBackend } from './backend.ts';
import { bindAll, foldHooks } from './bindings.ts';
import { loadLatestGames } from './records.ts';
import { installRapfiLoader } from './rapfi-loader.ts';
import type { AppCtx } from './ctx.ts';
import { createCtx } from './ctx.ts';
import { resetSession } from './loop.ts';
import {
  buildTabs,
  loadSettingsUI,
  renderFoe,
  renderSideCfg,
  renderTacticsStripPanel,
  modeValue,
  switchGame,
} from './modes.ts';
import {
  loadLeaderboardPanel,
  loadOpeningsPanel,
  renderDataPanels,
  renderRecordsPanel,
} from './panels.ts';
import { runTests } from './self-test.ts';

/** 首屏棋种（旧实现硬编码 `switchGame('gomoku')`）。 */
export const START_GAME = 'gomoku';

export interface BootOptions {
  /** 设置/折叠态/页签/战绩簿的存储后端；不给则自动挑 localStorage，不可用时退化为内存桩。 */
  storage?: StorageLike;
  /** 首屏棋种；不给用 `START_GAME`。 */
  gameId?: string;
  /** 后端探活注入（测试用内存桩，避免真发请求）。返回后若是 live 会补发同步队列。 */
  initBackendFn?: (ctx: AppCtx) => Promise<void> | void;
  /** 是否跑自检面板（旧 `?test=1`）。默认读 `location.search`。 */
  selfTest?: boolean;
  /** 棋盘渲染器注入。不给则按 `#board` 自动建（没有 canvas 时留 null，`redraw()` 会跳过绘制）。 */
  renderer?: BoardRenderer | null;
}

/** localStorage 不可用时的内存桩（Safari 隐私模式 / 沙箱 iframe）。 */
export function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      m.set(k, String(v));
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
  };
}

/** 取存储后端：localStorage 可读可写就用它，否则内存桩（**绝不抛**，D8 降级而非报错）。 */
export function pickStorage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
      const probe = '__jev_probe__';
      ls.setItem(probe, '1');
      if (typeof ls.removeItem === 'function') ls.removeItem(probe);
      return ls;
    }
  } catch (_e) {
    /* 隐私模式/被策略禁用：走内存桩 */
  }
  return memoryStorage();
}

/**
 * 装配并启动。返回 ctx 供调用方（测试/调试）继续驱动；注册表里没有可用引擎时返回 null。
 */
export function boot(opts: BootOptions = {}): AppCtx | null {
  const storage = opts.storage ?? pickStorage();
  const settings = loadSettings(storage);

  const startId = opts.gameId ?? START_GAME;
  const engine = getGame(startId) ?? getGame('gomoku');
  if (!engine) return null;

  /* 会话初值：`mode` 走旧实现的 DOM 白名单口径（非法值回落 human-ai），
     `humanSide` 先给第一侧，稍后 `switchGame()` 会用 `defaultHumanSideId()` 重算。 */
  const session = createSession({
    gameId: engine.id,
    gameUid: randomGameUid(),
    mode: isValidMode(settings.mode) ? settings.mode : 'human-ai',
    humanSide: engine.sides[0] ? engine.sides[0].id : null,
    settings,
  });

  /* 同步队列：`enabled` 闭包读的是 `settings` 这个**活对象**（与 ctx.settings 同引用），
     所以「棋谱同步」勾选框一改就生效，不需要重建队列。 */
  const sync = createSyncQueue({
    storage,
    /* `saveGame` 的返回体 `ok` 是可选的，且 `id` 可能是 number（老后端）；
       `postViaSaveGame` 要的是 `SyncHttpResponse`（`ok` 必填、`id` 为 string），
       所以在适配器外面再收一次口。 */
    post: postViaSaveGame(async (payload) => {
      const r = await saveGame(payload);
      if (!r) return null;
      return {
        ok: !!r.ok,
        id: r.id == null ? undefined : String(r.id),
        gameUid: r.gameUid,
        dedup: r.dedup,
        path: r.path,
      };
    }),
    enabled: () => settings.gameSync !== false,
  });

  const canvas = byId<HTMLCanvasElement>('board');
  const ctx = createCtx({
    engine,
    session,
    settings,
    storage,
    sync,
    exp: createExperimentState(),
    records: loadRecords(storage),
    renderer: opts.renderer !== undefined ? opts.renderer : canvas ? createBoardRenderer(canvas) : null,
  });

  /* ---- 以下顺序＝旧启动顺序 ---- */
  /* Rapfi 渠道的胶水脚本注入：core 不能碰 DOM，装配层必须显式装（P8 补齐 P6 拆层时漏掉的一段；
     漏装时 Rapfi 渠道的对手会以「当前环境不支持动态加载 Rapfi 脚本（无 document）」静默不走子）。 */
  installRapfiLoader();
  buildTabs(ctx, (gid: string) => switchGame(ctx, gid, resetSession));
  loadSettingsUI(ctx);
  renderSideCfg(ctx);
  renderFoe(ctx);
  renderTacticsStripPanel(ctx);

  const hooks = foldHooks(ctx);
  initFolds({ store: createFoldStore(storage, FOLD_DEFAULT_OPEN), hooks });
  initSideTabs({ store: createSideTabStore(storage), hooks });
  bindAll(ctx);

  /* 旧 `syncModeButtons()`：只同步按钮组选中态，不动 `#pauseBtn/#stepBtn` 的显隐
     （那两个由 `startGame()` 控制）。 */
  renderModeSwitch(modeValue(ctx), false, document);

  switchGame(ctx, engine.id, resetSession);
  renderRecordsPanel(ctx);
  /* P7c 三块数据面板（回放器 / 排行榜 / 开局库）：先摆出「未知 / 加载中…」三态；
     实际取数在 `initBackend` 之后（离线时各自降级，不阻塞首屏）。 */
  renderDataPanels(ctx);
  /* `#speedVal` 回填 + `#speedRow` 显隐（等价放在 `switchGame` 之后：`#side` 的 option
     这时才建好，`#side.value` 才落得下去）。 */
  syncMatchSettings(
    { mode: modeValue(ctx), side: ctx.session.humanSide ?? '', speed: ctx.settings.speed },
    document,
  );

  const backendFn = opts.initBackendFn ?? initBackend;
  void Promise.resolve(backendFn(ctx)).then(() => {
    /* 后端在线时补发上次失败积压的棋谱（队列按指数退避，不到点的会自己跳过）。 */
    if (ctx.backend.mode === 'live') void ctx.sync.flush();
    /* 排行榜 / 开局库取数（离线时客户端返回 null → 面板停在「加载中…」，不报错）。 */
    void loadLeaderboardPanel(ctx);
    void loadOpeningsPanel(ctx);
    /* 实验报告顶部的「最新棋谱」：归档最新一页（离线时同上下载失败 → 「加载中…」）。 */
    void loadLatestGames(ctx);
  }).catch((e: unknown) => {
    console.warn('[jev-qiguan] 后端探活失败（按离线降级继续）', e);
  });

  const wantTest = opts.selfTest ??
    ((globalThis as { location?: { search?: string } }).location?.search ?? '').indexOf('test=1') >= 0;
  if (wantTest) runTests();

  return ctx;
}
