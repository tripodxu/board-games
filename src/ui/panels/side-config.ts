/* panels/side-config.ts — 「单边三控件」渲染器（渠道 / 战术档 / Rapfi 思考时长）
 *
 * 来源：js/app.js:947-967 `renderSideCfg()`（抽屉双方覆盖）+ js/app.js:968-980 `saveSideCfg()`
 *       的读值口径；实验 A/B 方的同形控件见 index.html:381-396（`#expSideA` / `#expSideB`）。
 *
 * 一个渲染器覆盖四处容器（旧实现是同一段代码写四遍的回填逻辑）：
 *   `#sideCfgBlack` / `#sideCfgWhite`（抽屉，class `side-cfg`，渠道表 SIDE_CHANS，带「跟随全局」项）
 *   `#expSideA`    / `#expSideB`   （实验面板，class `exp-side`，渠道表 EXP_CHANS，**无**跟随项）
 * DOM 契约不变：容器的 id 与 class、`.side-cfg-name` / `.exp-side-name`、以及三控件的 id
 * （`#blackChannel/#blackTactics/#blackThinkMs`、`#whiteChannel/…`、`#expChanA/#expTacA/#expThinkA`、
 * `#expChanB/…`）全部沿用 `index.html` 现有值，不新造 id 体系。
 *
 * 幂等风格：**重建子树**（容器内三个 `<label>` 每次重画）。后果与约定：
 *   - 监听绑在新建的 `<select>` 上，重建即自然解绑，重复 render 不会叠监听；
 *   - 但重建会丢掉「正在展开的下拉」与文本输入焦点 —— 本面板只有 select，可接受；
 *   - `#sideCfg*` 容器的 class 用 classList.add 补，不覆盖调用方加的类。
 *
 * 值形态：`SideConfig`（`src/core/persist.ts`）—— 空串 / 0 表示「跟随全局」，
 * 不复用 `EffSide`（那是 resolve 之后的最终值，语义不同）。战术档回填按旧口径走
 * `resolve(cfg.tactics).id`：空覆盖在界面上显示为「当前全局档位」（js/app.js:960-962）。
 *
 * 本模块不 import node:*，不碰 localStorage / fetch；数据全靠 props 注入。
 */
import type { SideConfig } from '../../core/persist.ts';
import type { TacticsVersion } from '../../core/tactics-versions.ts';
import { resolve } from '../../core/tactics-versions.ts';
import { byId, el, on, replaceChildren, type UiRoot, type SelectEl } from '../dom.ts';
import { EXP_CHANS, SIDE_CHANS, THINK_OPTS, tacticsOptions, fillSelect, type Opt } from './options.ts';

/** 四个槽位：抽屉的黑/白 + 实验的 A/B。 */
export type SideKey = 'black' | 'white' | 'A' | 'B';

/** 一个「单边」容器的全部静态描述。 */
export interface SideSlotSpec {
  key: SideKey;
  /** 容器 id（必须已存在于 index.html） */
  containerId: string;
  /** 容器 class（`side-cfg` / `exp-side`） */
  containerClass: string;
  /** 名称行 class（`side-cfg-name` / `exp-side-name`） */
  nameClass: string;
  /** 名称文案：黑方 / 白方 / A 方 / B 方 */
  name: string;
  /** 名称行前的小圆点（实验侧 `mo`/`zhu`；抽屉侧不给） */
  dotClass?: string;
  /** 字段 label 的 class（实验侧 `exp-field`；抽屉侧不给） */
  fieldClass?: string;
  channelId: string;
  tacticsId: string;
  thinkId: string;
  channelOpts: readonly Opt[];
  /** 战术档选项（由 `tacticsOptions(versions)` 生成） */
  tacticsOpts: readonly Opt[];
}

/** 抽屉双方覆盖的两个槽位（渠道表 = 旧 `SIDE_CHANS`）。 */
export function drawerSlots(versions: readonly TacticsVersion[]): { black: SideSlotSpec; white: SideSlotSpec } {
  const tacticsOpts = tacticsOptions(versions);
  const base = { containerClass: 'side-cfg', nameClass: 'side-cfg-name', channelOpts: SIDE_CHANS, tacticsOpts: tacticsOpts };
  return {
    black: { key: 'black', containerId: 'sideCfgBlack', name: '黑方', channelId: 'blackChannel', tacticsId: 'blackTactics', thinkId: 'blackThinkMs', ...base },
    white: { key: 'white', containerId: 'sideCfgWhite', name: '白方', channelId: 'whiteChannel', tacticsId: 'whiteTactics', thinkId: 'whiteThinkMs', ...base },
  };
}

/** 实验 A/B 方的两个槽位（渠道表 = `EXP_CHANS`，字段带 `exp-field` 类）。 */
export function experimentSlots(versions: readonly TacticsVersion[]): { A: SideSlotSpec; B: SideSlotSpec } {
  const tacticsOpts = tacticsOptions(versions);
  const base = {
    containerClass: 'exp-side', nameClass: 'exp-side-name', fieldClass: 'exp-field',
    channelOpts: EXP_CHANS, tacticsOpts: tacticsOpts,
  };
  return {
    A: { key: 'A', containerId: 'expSideA', name: 'A 方', dotClass: 'mo', channelId: 'expChanA', tacticsId: 'expTacA', thinkId: 'expThinkA', ...base },
    B: { key: 'B', containerId: 'expSideB', name: 'B 方', dotClass: 'zhu', channelId: 'expChanB', tacticsId: 'expTacB', thinkId: 'expThinkB', ...base },
  };
}

/** 把一个槽位画进指定容器（供测试直接喂任意容器；页面走 `renderSideSlot`）。 */
export function renderSideSlotInto(
  root: HTMLElement,
  spec: SideSlotSpec,
  value: SideConfig,
  onChange: (patch: Partial<SideConfig>) => void,
): void {
  for (const cls of spec.containerClass.split(' ')) {
    if (cls) root.classList.add(cls);
  }
  const nameRow = el('div', { class: spec.nameClass }, [
    spec.dotClass ? el('i', { class: 'dot ' + spec.dotClass }) : null,
    spec.name,
  ]);

  const field = (labelText: string, sel: SelectEl): HTMLElement =>
    el('label', spec.fieldClass ? { class: spec.fieldClass } : null, [labelText, sel]);

  const channelSel = el('select', { id: spec.channelId });
  fillSelect(channelSel, spec.channelOpts, value.channel);
  on(channelSel, 'change', () => onChange({ channel: channelSel.value }));

  const tacticsSel = el('select', { id: spec.tacticsId });
  fillSelect(tacticsSel, spec.tacticsOpts, resolve(value.tactics).id);
  on(tacticsSel, 'change', () => onChange({ tactics: resolve(tacticsSel.value).id }));

  const thinkSel = el('select', { id: spec.thinkId });
  fillSelect(thinkSel, THINK_OPTS, value.rapfiThinkMs ? String(value.rapfiThinkMs) : '');
  on(thinkSel, 'change', () => onChange({ rapfiThinkMs: Number(thinkSel.value) || 0 }));

  replaceChildren(root, [
    nameRow,
    field('渠道', channelSel),
    field('战术', tacticsSel),
    field('思考', thinkSel),
  ]);
}

/** 按容器 id 找槽位并渲染（找不到容器时静默跳过：面板可能不在当前页面）。 */
export function renderSideSlot(
  spec: SideSlotSpec,
  value: SideConfig,
  onChange: (patch: Partial<SideConfig>) => void,
): void {
  const root = byId<HTMLElement>(spec.containerId);
  if (!root) return;
  renderSideSlotInto(root, spec, value, onChange);
}

export interface SideConfigProps {
  versions: readonly TacticsVersion[];
  black: SideConfig;
  white: SideConfig;
}

export interface SideConfigHandlers {
  /** 任一控件变更；patch 只含被改的字段（空串 / 0 = 跟随全局） */
  onSideChange?: (side: 'black' | 'white', patch: Partial<SideConfig>) => void;
}

/** 抽屉「双方覆盖」：`#sideCfgBlack` + `#sideCfgWhite`。 */
export function renderSideConfig(
  _root: UiRoot,
  props: SideConfigProps,
  handlers: SideConfigHandlers = {},
): void {
  const slots = drawerSlots(props.versions);
  const emit = (side: 'black' | 'white') => (patch: Partial<SideConfig>) => handlers.onSideChange?.(side, patch);
  renderSideSlot(slots.black, props.black, emit('black'));
  renderSideSlot(slots.white, props.white, emit('white'));
}

export interface ExperimentSidesProps {
  versions: readonly TacticsVersion[];
  A: SideConfig;
  B: SideConfig;
}

export interface ExperimentSidesHandlers {
  onSideChange?: (side: 'A' | 'B', patch: Partial<SideConfig>) => void;
}

/** 实验面板 A/B 方：`#expSideA` + `#expSideB`。 */
export function renderExperimentSides(
  _root: UiRoot,
  props: ExperimentSidesProps,
  handlers: ExperimentSidesHandlers = {},
): void {
  const slots = experimentSlots(props.versions);
  const emit = (side: 'A' | 'B') => (patch: Partial<SideConfig>) => handlers.onSideChange?.(side, patch);
  renderSideSlot(slots.A, props.A, emit('A'));
  renderSideSlot(slots.B, props.B, emit('B'));
}
