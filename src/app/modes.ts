/* modes.ts — 设置 / 渠道 / 双方覆盖 / 棋种切换（旧 js/app.js 的「设置」「双方覆盖 +
 * 实验 A/B 档位」「页签与会话」三段）
 *
 * 对应关系（计划 §6.3）：
 *   - 设置（旧 js/app.js:20-323）          → `loadSettingsUI()` / `syncSettingsFromDrawer()` /
 *                                             `syncChannelUI()` / `runProbe()`
 *   - 双方覆盖 + 实验 A/B 档位（旧 :931-1033）→ `renderSideCfg()` / `renderFoe()` /
 *                                             `syncFoeEnabled()` / `saveSideCfg()` / `saveFoe()`
 *   - 页签与会话（旧 :427-469）            → `buildTabs()` / `switchGame()`
 *
 * 与新架构的分工（本文件最重要的设计决定）：
 *   旧实现把「设置」同时存在 `S.settings` 与抽屉 DOM 两处，靠 `saveSettings()` 每次从输入框
 *   读回来才发现用户改动。新架构里 `src/ui/panels/settings.ts` 是**幂等重画 + `onPatch` 回调**，
 *   抽屉里每次改动都即时回到 `ctx.settings`，不存在「DOM 改了设置没改」的窗口。因此：
 *     - `syncSettingsFromDrawer()` 只作兜底保留（也是旧 `saveSettings()` 的直译），
 *       读输入框前先 `stashEndpoint(旧渠道)`，语义与旧实现逐字一致；
 *     - `syncChannelUI()` 不再逐个 toggle 标签 `hidden`（那是 `renderSettings` 按
 *       `channelVisibility()` 一次画全的职责），只负责「重画抽屉 + 渠道芯片 + 渠道提示 +
 *       镜像机器对手面板」。
 *
 * 本文件不 import node:*，不碰 fetch；localStorage 经 `ctx.storage` 注入。
 * 刻意**不** import `./loop.ts`：`switchGame()` 需要的 `resetSession` 由调用方作为参数传入，
 * 这样 loop → modes 单向依赖，避免模块环。
 */
import { VERSIONS, resolve, tryResolve } from '../core/tactics-versions.ts';
import { effectiveChannelOf, isValidMode, stashEndpoint } from '../core/persist.ts';
import type { AppMode, SideConfig } from '../core/persist.ts';
import { getGame } from '../core/registry.ts';
import { probe as jevProbe, presetEndpoint } from '../core/jev/index.ts';
import { ensureLoaded as rapfiEnsureLoaded } from '../core/jev/rapfi.ts';
import { sideLabel } from '../core/view/duel.ts';
import { CHANNEL_NAMES, FOE_CHANS, THINK_OPTS, fillSelect, tacticsOptions } from '../ui/panels/options.ts';
import {
  closeSettingsDrawer,
  openSettingsDrawer,
  renderChannelChip,
  renderChannelHint,
  renderSettings,
  setProbeOut,
} from '../ui/panels/settings.ts';
import { renderExperimentSides, renderSideConfig } from '../ui/panels/side-config.ts';
import { renderModeSwitch, syncMatchSettings } from '../ui/panels/experiment.ts';
import { byId, qsa, setText } from '../ui/dom.ts';
import type { SelectEl } from '../ui/dom.ts';
import { effFor, persistSettings, setSideCfg, sideCfgOf, sideNameOf } from './ctx.ts';
import type { AppCtx, SideSlot } from './ctx.ts';
import {
  loadOpeningsPanel,
  renderSideNames,
  renderTacticsStrip,
  setVisibleById,
  toast,
  refreshTacticHints,
} from './panels.ts';

/** 棋种顺序（旧 `GAME_ORDER`，js/app.js:11）：`#tabs` 与自检都按它遍历。 */
export const GAME_ORDER: readonly string[] = Object.freeze([
  'gomoku', 'gomoku-pro', 'go', 'xiangqi', 'chess', 'checkers', 'cc',
]);

/* ---------- 设置（旧 :21-73） ---------- */

/** 旧 `loadSettings()`：把持久化设置回填到界面（localStorage 读取已由 `core/persist.ts` 完成）。 */
export function loadSettingsUI(ctx: AppCtx): void {
  const s = ctx.settings;
  if (!s.endpoints) s.endpoints = {};
  const channelSel = byId<SelectEl>('channel');
  if (channelSel && s.channel) channelSel.value = s.channel;
  const modeSel = byId<SelectEl>('mode');
  if (modeSel && isValidMode(s.mode)) modeSel.value = s.mode;
  const speedEl = byId<HTMLInputElement>('speed');
  if (speedEl) speedEl.value = String(s.speed);
  setText(byId('speedVal'), ((150 + s.speed * 150) / 1000) + 's');
  syncChannelUI(ctx);
}

/**
 * 旧 `saveSettings()`（js/app.js:58-73）：从抽屉输入框回读一遍并落盘。
 * `stashEndpoint` 必须在改写 channel **之前**调用，否则端点会串到新渠道名下。
 */
export function syncSettingsFromDrawer(ctx: AppCtx): void {
  const s = ctx.settings;
  const endpointEl = byId<HTMLInputElement>('endpoint');
  const endpoint = endpointEl ? endpointEl.value.trim() : '';
  const channelEl = byId<SelectEl>('channel');
  if (channelEl && channelEl.value) {
    stashEndpoint(s, s.channel, endpoint);
    s.channel = channelEl.value;
  }
  const apiKeyEl = byId<HTMLInputElement>('apiKey');
  if (apiKeyEl) s.apiKey = apiKeyEl.value.trim();
  const orKeyEl = byId<HTMLInputElement>('orKey');
  if (orKeyEl) s.orKey = orKeyEl.value.trim();
  const topKEl = byId<SelectEl>('topK');
  if (topKEl) s.topK = parseInt(topKEl.value, 10) || s.topK;
  const rapfiEl = byId<SelectEl>('rapfiThinkMs');
  if (rapfiEl) s.rapfiThinkMs = parseInt(rapfiEl.value, 10) || 3000;
  const syncBox = byId<HTMLInputElement>('gameSync');
  if (syncBox) s.gameSync = syncBox.checked;
  const hintBox = byId<HTMLInputElement>('tacticHints');
  if (hintBox) s.hints = hintBox.checked;
  const modeEl = byId<SelectEl>('mode');
  if (modeEl && isValidMode(modeEl.value)) s.mode = modeEl.value;
  const tacEl = byId<SelectEl>('tacticsVersion');
  if (tacEl) s.tacticsVersion = resolve(tacEl.value).id;
  persistSettings(ctx);
}

/** 抽屉正文重画（`renderSettings` 的 props + handlers）。 */
export function renderSettingsPanel(ctx: AppCtx): void {
  renderSettings(undefined, {
    settings: ctx.settings,
    versions: VERSIONS,
    black: sideCfgOf(ctx, 'black'),
    white: sideCfgOf(ctx, 'white'),
    endpointPlaceholder: presetEndpoint(ctx.settings.channel) || '',
    probeText: ctx.probeText,
    probeState: ctx.probeState ?? undefined,
  }, {
    onPatch: (patch) => {
      Object.assign(ctx.settings, patch);
      persistSettings(ctx);
      syncChannelUI(ctx);
      refreshTacticHints(ctx);
    },
    onEndpointChange: (channel, value) => {
      stashEndpoint(ctx.settings, channel, value);
      persistSettings(ctx);
    },
    onProbe: () => { void runProbe(ctx); },
    onSideChange: (side, patch) => saveSideCfg(ctx, side, patch),
  });
}

/**
 * 旧 `syncChannelUI()`（js/app.js:105-133）的等价物：重画抽屉 → 芯片 → 渠道提示 → 机器对手面板。
 * 各标签显隐、`#endpoint.placeholder`、`#probeRow` 都由 `renderSettings` 按渠道一次画全。
 */
export function syncChannelUI(ctx: AppCtx): void {
  if (!ctx.settings.endpoints) ctx.settings.endpoints = {};
  renderSettingsPanel(ctx);
  const ch = ctx.settings.channel;
  renderChannelChip(ch, effectiveChannelOf(ctx.settings, ch));
  renderChannelHint(ch);
  renderFoe(ctx);
}

/* ---------- 连通性探测（旧 :159-202） ---------- */

/** 同时写 DOM 与 ctx 镜像，避免后续重画抽屉时把探测结果擦掉。 */
function setProbe(ctx: AppCtx, text: string, state: 'pending' | 'ok' | 'fail' | null): void {
  ctx.probeText = text;
  ctx.probeState = state;
  setProbeOut(text, state ?? undefined);
}

/** 旧 `runProbe()`：直接读输入框当前值——测的就是眼前这套配置，不依赖是否已保存。 */
export async function runProbe(ctx: AppCtx): Promise<void> {
  if (ctx.probing) return;
  const channelEl = byId<SelectEl>('channel');
  const ch = channelEl && channelEl.value ? channelEl.value : ctx.settings.channel;
  if (ch === 'mock') return;
  const btn = byId<HTMLButtonElement>('probeBtn');

  if (ch === 'rapfi') {
    ctx.probing = true;
    if (btn) btn.disabled = true;
    setProbe(ctx, '加载 Rapfi 引擎中…（首次约 10–40MB）', 'pending');
    try {
      await rapfiEnsureLoaded();
      setProbe(ctx, '✓ Rapfi 本地引擎就绪', 'ok');
    } catch (e) {
      setProbe(ctx, '✗ ' + (e instanceof Error ? e.message : String(e)), 'fail');
    } finally {
      if (btn) btn.disabled = false;
      ctx.probing = false;
    }
    return;
  }

  ctx.probing = true;
  if (btn) btn.disabled = true;
  setProbe(ctx, '探测中…（最长 10 秒）', 'pending');
  const readValue = (id: string): string => {
    const node = byId<HTMLInputElement>(id);
    return node ? node.value.trim() : '';
  };
  const apiKey = ch === 'openrouter' ? readValue('orKey') : readValue('apiKey');
  const endpoint = readValue('endpoint');
  try {
    const r = await jevProbe({ channel: ch, apiKey, endpoint });
    setProbe(ctx, (r.ok ? '✓ ' : '✗ ') + r.message, r.ok ? 'ok' : 'fail');
  } finally {
    if (btn) btn.disabled = false;
    ctx.probing = false;
  }
}

/* ---------- 模式（旧 :1875-1895） ---------- */

/** `#mode` 当前值（形状不合法时回落到会话值，再兜底人机）。 */
export function modeValue(ctx: AppCtx): AppMode {
  const el = byId<SelectEl>('mode');
  if (el && isValidMode(el.value)) return el.value;
  return isValidMode(ctx.session.mode) ? ctx.session.mode : 'human-ai';
}

/**
 * 旧 `applyModeUI()`（js/app.js:1875-1885）：模式切换的两种入口（select / 按钮组）共用一条路径。
 */
export function applyModeUI(ctx: AppCtx): void {
  syncSettingsFromDrawer(ctx);
  const mode = modeValue(ctx);
  ctx.session.mode = mode;
  const aiAi = mode === 'ai-ai';
  setVisibleById('pauseBtn', aiAi);
  setVisibleById('stepBtn', aiAi);
  syncMatchSettings({
    mode,
    side: ctx.session.humanSide || defaultHumanSideId(ctx),
    speed: ctx.settings.speed,
    locked: ctx.exp.running,
  });
  renderModeSwitch(mode, ctx.exp.running);
  syncFoeEnabled(ctx);
  renderSideNames(ctx);
}

/* ---------- 双方覆盖（旧 :931-1033） ---------- */

/**
 * 旧 `borrowSideCfg()`（js/app.js:95-104）：实验开跑前把用户自己的双方覆盖存进快照。
 * 快照挂在 `ctx.sideCfgSnapshot`（不是模块级变量），这样测试里能并存多个 ctx。
 */
export function borrowSideCfg(ctx: AppCtx): void {
  ctx.sideCfgSnapshot = JSON.parse(JSON.stringify(ctx.settings.sideConfig || {}));
}

/** 旧 `restoreSideCfg()`：把实验借走的 sideConfig 还回去并重画双方覆盖面板。 */
export function restoreSideCfg(ctx: AppCtx): void {
  if (!ctx.sideCfgSnapshot) return;
  ctx.settings.sideConfig = ctx.sideCfgSnapshot;
  ctx.sideCfgSnapshot = null;
  renderSideCfg(ctx);
}

/** 默认人类侧 = 引擎先手方。 */
export function defaultHumanSideId(ctx: AppCtx): string {
  const first = ctx.engine.sides[0];
  return first ? first.id : '';
}

/** 机器对手侧 id：人机模式下是「非人类」那一侧，其余模式退化为 sides[1]。 */
export function machineFoeSideId(ctx: AppCtx): string {
  const sides = ctx.engine.sides;
  if (ctx.session.mode === 'human-ai') {
    const human = ctx.session.humanSide || defaultHumanSideId(ctx);
    const foe = sides.filter((sd) => sd.id !== human)[0];
    if (foe) return foe.id;
  }
  return sides[1] ? sides[1].id : (sides[0] ? sides[0].id : '');
}

/** 抽屉里的双方覆盖（`#sideCfgBlack` / `#sideCfgWhite`）。 */
export function renderSideCfg(ctx: AppCtx): void {
  renderSideConfig(document, {
    versions: VERSIONS,
    black: sideCfgOf(ctx, 'black'),
    white: sideCfgOf(ctx, 'white'),
  }, {
    onSideChange: (side, patch) => saveSideCfg(ctx, side, patch),
  });
}

/** 实验面板的 A/B 档位（`#expSideA` / `#expSideB`）。 */
export function renderExpSides(ctx: AppCtx): void {
  renderExperimentSides(document, {
    versions: VERSIONS,
    A: expSideCfg(ctx, 'A'),
    B: expSideCfg(ctx, 'B'),
  }, {
    onSideChange: (side, patch) => saveExpSide(ctx, side, patch),
  });
}

/** 旧 `EXP.tacA/tacB/thinkA/thinkB` 的 SideConfig 视图（A/B 面板与全局设置共用一套控件）。 */
export function expSideCfg(ctx: AppCtx, side: 'A' | 'B'): SideConfig {
  const e = ctx.exp;
  return {
    channel: side === 'A' ? e.chanA : e.chanB,
    tactics: side === 'A' ? e.tacA : e.tacB,
    rapfiThinkMs: side === 'A' ? e.thinkA : e.thinkB,
  };
}

/** A/B 档位改动：写回 `ctx.exp`（不是 settings，也绝不落盘——实验配置不入 localStorage）。 */
export function saveExpSide(ctx: AppCtx, side: 'A' | 'B', patch: Partial<SideConfig>): void {
  const cur = expSideCfg(ctx, side);
  const next: SideConfig = {
    channel: patch.channel ?? cur.channel,
    tactics: patch.tactics ?? cur.tactics,
    rapfiThinkMs: patch.rapfiThinkMs ?? cur.rapfiThinkMs,
  };
  if (side === 'A') {
    ctx.exp.chanA = next.channel;
    ctx.exp.tacA = next.tactics;
    ctx.exp.thinkA = next.rapfiThinkMs;
  } else {
    ctx.exp.chanB = next.channel;
    ctx.exp.tacB = next.tactics;
    ctx.exp.thinkB = next.rapfiThinkMs;
  }
}

/** 旧 `saveSideCfg()`（js/app.js:1000-1014）：任一侧改动即写 sideConfig 并保存。 */
export function saveSideCfg(ctx: AppCtx, side: SideSlot, patch: Partial<SideConfig>): void {
  setSideCfg(ctx, side, patch);
  persistSettings(ctx);
  syncChannelUI(ctx);
  renderSideNames(ctx);
}

/** 旧 `saveFoe()`：机器对手面板三项任一改动即写白方覆盖（与抽屉同一份配置）。 */
export function saveFoe(ctx: AppCtx, patch: Partial<SideConfig>): void {
  const cur = sideCfgOf(ctx, 'white');
  setSideCfg(ctx, 'white', {
    channel: patch.channel ?? cur.channel,
    tactics: patch.tactics ?? cur.tactics,
    rapfiThinkMs: patch.rapfiThinkMs ?? cur.rapfiThinkMs,
  });
  persistSettings(ctx);
  syncChannelUI(ctx);
  renderSideNames(ctx);
}

/** 旧 `renderFoe()`（js/app.js:1016-1033）：机器对手面板（`#foeChannel/#foeTactics/#foeThink`）。 */
export function renderFoe(ctx: AppCtx): void {
  const chSel = byId<SelectEl>('foeChannel');
  const tacSel = byId<SelectEl>('foeTactics');
  const thinkSel = byId<SelectEl>('foeThink');
  const cfg = sideCfgOf(ctx, 'white');
  if (chSel) fillSelect(chSel, FOE_CHANS, cfg.channel || '');
  if (tacSel) {
    /* 旧实现「首次追加「跟随全局」」——这里每次都重建，效果等价且幂等 */
    const opts: [string, string][] = [['', '跟随全局']];
    for (const o of tacticsOptions(VERSIONS)) opts.push([o[0], o[1]]);
    /* 草稿里的档位可能来自旧会话：展示路径用宽容解析，认不出就回落「跟随全局」（P0/D2） */
    fillSelect(tacSel, opts, tryResolve(cfg.tactics)?.id ?? '');
  }
  if (thinkSel) fillSelect(thinkSel, THINK_OPTS, cfg.rapfiThinkMs ? String(cfg.rapfiThinkMs) : '');

  const eff = effFor(ctx, machineFoeSideId(ctx));
  const tv = tryResolve(eff.tactics);
  setText(byId('foeHint'),
    '当前生效：' + (CHANNEL_NAMES[eff.channel] || eff.channel) + ' · ' +
    (tv ? tv.id + ' ' + tv.name : String(eff.tactics || '—')) +
    (eff.rapfiThinkMs ? ' · ' + (eff.rapfiThinkMs / 1000) + 's' : '') +
    '。留空 = 跟随全局设置；改动只影响机器方，不动你自己的引擎。' +
    'Rapfi 思考期间界面会短暂卡住（ADR-0006）。');
  syncFoeEnabled(ctx);
}

/** 旧 `syncFoeEnabled()`（js/app.js:1030-1033 段）：人人对战没有机器方。 */
export function syncFoeEnabled(ctx: AppCtx): void {
  const off = modeValue(ctx) === 'pvp';
  for (const id of ['foeChannel', 'foeTactics', 'foeThink']) {
    const node = byId<HTMLElement>(id);
    if (node) (node as unknown as { disabled: boolean }).disabled = off;
  }
  setText(byId('foeNote'), off ? '人人对战不适用' : '人机模式下生效');
}

/* ---------- 战术沿革条（旧 :1094-1136 的点击入口） ---------- */

/** 重画战术沿革条（点击回调固定在 `pickTactics`）。 */
export function renderTacticsStripPanel(ctx: AppCtx): void {
  renderTacticsStrip(ctx, (id) => pickTactics(ctx, id));
}

/** 旧 `renderTacticsStrip()` 里 `data-ver` 按钮的点击：设为全局默认档位。 */
export function pickTactics(ctx: AppCtx, id: string): void {
  const v = resolve(id);
  ctx.settings.tacticsVersion = v.id;
  persistSettings(ctx);
  renderTacticsStripPanel(ctx);
  toast('默认战术档位 → ' + v.id + ' ' + v.name, false);
}

/* ---------- 页签与会话（旧 :428-469） ---------- */

/** 旧 `buildTabs()`：`#tabs` 由棋种注册表生成；切棋种前对「已下 ≥6 手」的对局要确认。 */
export function buildTabs(ctx: AppCtx, onSwitch: (gid: string) => void): void {
  const nav = byId<HTMLElement>('tabs');
  if (!nav) return;
  nav.replaceChildren();
  GAME_ORDER.forEach((gid) => {
    const g = getGame(gid);
    if (!g) return;
    const b = document.createElement('button');
    b.textContent = g.name;
    b.dataset.gid = gid;
    const on = gid === ctx.session.gameId;
    b.className = on ? 'active' : '';
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', () => {
      if (gid === ctx.session.gameId) return;
      /* 对局进行中切棋需确认，避免误触丢弃真实对局 */
      const confirmFn = (globalThis as { confirm?: (m: string) => boolean }).confirm;
      if (ctx.session.history.length >= 6 && confirmFn &&
        !confirmFn('当前已下 ' + ctx.session.history.length + ' 手，切换棋种将丢弃本局，确定？')) return;
      onSwitch(gid);
    });
    nav.appendChild(b);
  });
}

/** `#tabs` 的选中态（切棋种后重画）。 */
export function syncTabs(ctx: AppCtx): void {
  for (const b of qsa<HTMLButtonElement>(document, '#tabs button')) {
    const on = b.dataset.gid === ctx.session.gameId;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

/**
 * 旧 `switchGame(gid)`（js/app.js:449-469）：换引擎 + 重填 `#side` + 重画 + 重开一局。
 * `reset` 由调用方注入 `loop.resetSession`（避免 loop ↔ modes 模块环）。
 */
export function switchGame(ctx: AppCtx, gid: string, reset: (ctx: AppCtx) => void): void {
  const engine = getGame(gid);
  if (!engine) return;
  ctx.engine = engine;
  ctx.session.gameId = gid;
  syncTabs(ctx);
  setText(byId('gameName'), engine.name);
  const sideSel = byId<SelectEl>('side');
  if (sideSel) {
    sideSel.replaceChildren();
    engine.sides.forEach((sd) => {
      const o = document.createElement('option');
      o.value = sd.id;
      o.textContent = sd.name;
      sideSel.appendChild(o);
    });
  }
  setText(byId('legendFirst'), engine.sides[0] ? engine.sides[0].name : '');
  setText(byId('legendSecond'), engine.sides[1] ? engine.sides[1].name : '');
  ctx.session.humanSide = defaultHumanSideId(ctx);
  if (sideSel && ctx.session.humanSide) sideSel.value = ctx.session.humanSide;
  ctx.ui = {};
  renderSideNames(ctx);
  renderSideCfg(ctx);
  renderFoe(ctx);
  renderTacticsStripPanel(ctx);
  reset(ctx);
  refreshTacticHints(ctx);
  /* 开局库按棋种筛选（服务端一律要求 `?game=`）：换棋种后跟着换筛选并重取。 */
  if (ctx.openingsGame !== gid) {
    ctx.openingsGame = gid;
    void loadOpeningsPanel(ctx);
  }
}

/* ---------- 抽屉（旧 :324-... 的 openDrawer/closeDrawer） ---------- */

/** 旧 `openDrawer()`：抽屉正文每次打开都重画一次，保证显示的是当前设置。 */
export function openDrawer(ctx: AppCtx): void {
  renderSettingsPanel(ctx);
  openSettingsDrawer();
}

/** 旧 `closeDrawer()`。 */
export function closeDrawer(): void {
  closeSettingsDrawer();
}

/** 侧位标签（`#foeHint` 之外的零散展示点共用）。 */
export function sideLabelFor(ctx: AppCtx, sideId: string): string {
  return sideNameOf(ctx, sideId) + ' ' + sideLabel(effFor(ctx, sideId));
}
