/* panels/settings.ts — 「全局设置」抽屉（index.html:431-509 的 `#settingsDrawer`）
 *
 * 来源旧实现：
 *   - 抽屉开合 / 遮罩     js/app.js:324-334（`openDrawer()` / `closeDrawer()`）
 *   - 按渠道切显隐 + 芯片 js/app.js:105-133（`syncChannelUI()`）+ js/app.js:103 `CHANNEL_NAMES`
 *   - 连接探测输出        js/app.js:135-176（`runProbe()`：`#probeOut` 的 class = pending/ok/fail）
 *   - 双方覆盖三控件      委托 `panels/side-config.ts`（js/app.js:947-980）
 *
 * 幂等风格：**重建子树** —— 每次 `renderSettings()` 把 `#drawerBody` 整段重画。
 *   后果：`#channel/#tacticsVersion/#rapfiThinkMs/#endpoint/#apiKey/#orKey/#topK/#gameSync` 这些
 *   控件的**节点身份会变**（旧实现是静态节点 + 只改属性）。因此：
 *     * 监听绑在新建节点上，重复 render 不叠监听（这正是旧 `syncChannelUI()` 反复改同一批静态节点时
 *       需要小心的地方）；
 *     * 任何持有这些节点引用的外部代码（app 层）必须在每次 render 后重新查询，不要缓存节点；
 *     * `#settingsDrawer` / `#drawerMask` / `#drawerHead` / `#drawerTitle` / `#drawerClose` 是**静态**节点，
 *       本模块不重建它们，只做显隐与 `onOnce` 绑事件（所以开合状态不会被 render 冲掉）。
 *
 * 刻意差异（相对旧实现）：
 *   1. 旧 `#tacticsVersion` 的 10 个 `<option>` 是 index.html:450-459 的**手写静态标签**
 *      （写的是短号，如「v0 无战术（基线）」）；这里改由 `VERSIONS` 生成（`tacticsOptions()`），
 *      与双方覆盖/实验面板的战术下拉**同一口径**（「v0-off 无战术基线」）。id、顺序、选中值不变，
 *      只有 v0 一项的括号写法与短号有可见差异 —— 若装配阶段要求像素级还原静态标签，改回静态即可。
 *   2. `#endpoint` 的写回不是标量字段：`Settings.endpoints` 是按渠道分桶的 map，所以端点走独立的
 *      `onEndpointChange(channel, value)`，而不是 `onPatch({ endpoints })`（避免 UI 组装整张 map）。
 *   3. `#apiKeyLabel` 的文案在重建时直接算好（旧实现是改静态 label 的第一个文本节点）。
 *   4. 旧 `saveSettings()` 把读控件、stash 端点、落 localStorage 混在一起；这里只发 patch，
 *      持久化归 `src/core/persist.ts`（`loadSettings/saveSettings/stashEndpoint`）+ app 层。
 *
 * 本模块不 import node:*，不碰 localStorage / fetch / location（`opts.isFile` 之类的判定在 app 层做好后
 * 用 props 传进来）；数据全靠 props 注入。
 */
import type { Settings, SideConfig } from '../../core/persist.ts';
import type { TacticsVersion } from '../../core/tactics-versions.ts';
import { resolve } from '../../core/tactics-versions.ts';
import { byId, el, on, onOnce, qs, replaceChildren, type UiRoot } from '../dom.ts';
import {
  CHANNEL_NAMES,
  DRAWER_CHANNEL_OPTS,
  RAPFI_THINK_OPTS,
  TOPK_OPTS,
  fillSelect,
  tacticsOptions,
} from './options.ts';
import { renderSideConfig, type SideConfigHandlers } from './side-config.ts';

/** 探测输出的三态（旧 `runProbe()` 写的 class）。 */
export type ProbeState = 'pending' | 'ok' | 'fail';

/** 每个渠道的 `#modeHint` 文案（js/app.js:122-128 逐字）。 */
export const CHANNEL_HINTS: Record<string, string> = {
  proxy: '推荐。代理只做同源转发（绕开浏览器跨域）：本地用 npm run dev 起 Worker（Vite + Worker + 本地 D1 一体），线上由 jevqipan.logicc.top 提供同源 /api/jev。你的 key 经请求头透传，服务端不存。',
  official: '实测官方 API 有来源白名单（仅 typesafe.ai 自有域可用），浏览器直连必被拦。官方 key 请改走「同源代理」：本地 npm run dev 或线上站点里填 key，效果等同直连。',
  openrouter: '唯一可浏览器直连的渠道（OpenRouter 允许跨域），但需要的是 OpenRouter key（openrouter.ai 申请），不是 TypeSafe key。',
  mock: '离线演示：内置简单启发式 AI 与合成概率，无需 key。后端不可用时也自动落到这里。',
  rapfi: '本地引擎：浏览器内运行的 Rapfi（Gomocup 协议），首次使用下载模型（约 10–40MB），之后纯本地走子，无需 key。',
};

/** 渠道提示文案（未知渠道给空串，与旧实现一致）。 */
export function channelHint(channel: string): string {
  return CHANNEL_HINTS[channel] ?? '';
}

/** `#apiKeyLabel` 的标题文案（js/app.js:110-112：proxy 走透传说明，其余（official）走官方说明）。 */
export function apiKeyLabelText(channel: string): string {
  return channel === 'proxy'
    ? 'TypeSafe API Key（经代理透传，仅存本机）'
    : '官方 API Key（仅存本机）';
}

/** 抽屉内各行的显示规则（js/app.js:107-121 的 hidden 判定，逐条照搬）。true = 显示。 */
export interface ChannelVisibility {
  apiKeyLabel: boolean;
  apiKeyLabelText: string;
  orKeyLabel: boolean;
  endpointLabel: boolean;
  tacticsVersionLabel: boolean;
  /** `#probeRow`（mock 渠道没有可探测的远端） */
  probeRow: boolean;
}

/** 渠道 → 抽屉可见性矩阵（纯函数，便于 app 层与测试直接断言）。 */
export function channelVisibility(channel: string): ChannelVisibility {
  return {
    apiKeyLabel: channel === 'official' || channel === 'proxy',
    apiKeyLabelText: apiKeyLabelText(channel),
    orKeyLabel: channel === 'openrouter',
    endpointLabel: channel !== 'mock' && channel !== 'rapfi',
    tacticsVersionLabel: channel === 'proxy' || channel === 'openrouter' || channel === 'official' || channel === 'random',
    probeRow: channel !== 'mock',
  };
}

export interface SettingsPanelProps {
  settings: Settings;
  versions: readonly TacticsVersion[];
  /** 双方覆盖（抽屉底部；`SideConfig` 空串/0 = 跟随全局） */
  black: SideConfig;
  white: SideConfig;
  /** `#endpoint` 的 placeholder —— 旧 `BG.jev.presetEndpoint(channel)`，由 app 层注入 */
  endpointPlaceholder?: string;
  /** `#probeOut` 文案（旧 `runProbe()` 的三态输出） */
  probeText?: string;
  probeState?: ProbeState;
}

export interface SettingsPanelHandlers {
  /** 标量设置变更（channel/apiKey/orKey/topK/gameSync/rapfiThinkMs/tacticsVersion…） */
  onPatch: (patch: Partial<Settings>) => void;
  /** 端点变更：`Settings.endpoints` 是按渠道分桶的 map，故单列（见文件头「刻意差异 2」） */
  onEndpointChange?: (channel: string, value: string) => void;
  /** 点「测试连接」 */
  onProbe?: () => void;
  onSideChange?: SideConfigHandlers['onSideChange'];
}

function classOf(visible: boolean): string | undefined {
  return visible ? undefined : 'hidden';
}

function probeClass(state: ProbeState | undefined): string | undefined {
  return state ? state : undefined;
}

/** 抽屉正文容器：优先在 root 内找 `#drawerBody`，否则退回整篇文档。 */
function drawerBodyOf(root: UiRoot | undefined, doc: Document): HTMLElement | null {
  return qs<HTMLElement>(root ?? doc, '#drawerBody') ?? byId<HTMLElement>('drawerBody', doc);
}

function docOf(root: UiRoot | undefined): Document {
  if (root && (root as Node).nodeType === 9) return root as Document;
  const owner = root ? (root as Node).ownerDocument : null;
  return owner ?? document;
}

/**
 * 渲染抽屉正文（幂等；重建 `#drawerBody` 子树）。
 * 静态的 `#settingsDrawer`/`#drawerMask`/`#drawerClose` 只在此处做一次 `onOnce` 绑定（开合）。
 */
export function renderSettings(
  root: UiRoot | undefined,
  props: SettingsPanelProps,
  handlers: SettingsPanelHandlers,
): void {
  const doc = docOf(root);
  const body = drawerBodyOf(root, doc);
  if (!body) return;

  const s = props.settings;
  const vis = channelVisibility(s.channel);

  const channelSel = el('select', { id: 'channel' });
  fillSelect(channelSel, DRAWER_CHANNEL_OPTS, s.channel);
  on(channelSel, 'change', () => handlers.onPatch({ channel: channelSel.value }));

  const tacticsSel = el('select', { id: 'tacticsVersion' });
  fillSelect(tacticsSel, tacticsOptions(props.versions), resolve(s.tacticsVersion).id);
  on(tacticsSel, 'change', () => handlers.onPatch({ tacticsVersion: resolve(tacticsSel.value).id }));

  const rapfiSel = el('select', { id: 'rapfiThinkMs' });
  fillSelect(rapfiSel, RAPFI_THINK_OPTS, String(s.rapfiThinkMs));
  on(rapfiSel, 'change', () => handlers.onPatch({ rapfiThinkMs: Number(rapfiSel.value) || 0 }));

  const endpointInput = el('input', {
    id: 'endpoint',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: props.endpointPlaceholder ?? '',
    value: s.endpoints[s.channel] ?? '',
  });
  on(endpointInput, 'change', () => {
    handlers.onEndpointChange?.(s.channel, endpointInput.value.trim());
  });

  const apiKeyInput = el('input', {
    id: 'apiKey',
    type: 'password',
    placeholder: 'apikey_...',
    autocomplete: 'off',
    value: s.apiKey,
  });
  on(apiKeyInput, 'change', () => handlers.onPatch({ apiKey: apiKeyInput.value.trim() }));

  const orKeyInput = el('input', {
    id: 'orKey',
    type: 'password',
    placeholder: 'sk-or-...',
    autocomplete: 'off',
    value: s.orKey,
  });
  on(orKeyInput, 'change', () => handlers.onPatch({ orKey: orKeyInput.value.trim() }));

  const probeBtn = el('button', { id: 'probeBtn', type: 'button', text: '测试连接' });
  on(probeBtn, 'click', () => handlers.onProbe?.());

  const topKSel = el('select', { id: 'topK' });
  fillSelect(topKSel, TOPK_OPTS, String(s.topK));
  on(topKSel, 'change', () => handlers.onPatch({ topK: Number(topKSel.value) || 3 }));

  const syncBox = el('input', { id: 'gameSync', type: 'checkbox', checked: !!s.gameSync });
  on(syncBox, 'change', () => handlers.onPatch({ gameSync: syncBox.checked }));

  replaceChildren(body, [
    el('div', { class: 'drawer-sub', text: '引擎与连接' }),
    el('label', null, ['接入渠道', channelSel]),
    el('label', { id: 'tacticsVersionLabel', class: classOf(vis.tacticsVersionLabel) }, [
      '战术版本（实验室：棋谱归因/复现的唯一凭据）',
      tacticsSel,
    ]),
    el('label', { id: 'rapfiThinkLabel' }, ['Rapfi 思考时长（强度 · 越长越强）', rapfiSel]),
    el('label', { id: 'endpointLabel', class: classOf(vis.endpointLabel) }, [
      '接口地址 Base URL（留空用预设，可填自建/兼容端点）',
      endpointInput,
    ]),
    el('label', { id: 'apiKeyLabel', class: classOf(vis.apiKeyLabel) }, [vis.apiKeyLabelText, apiKeyInput]),
    el('label', { id: 'orKeyLabel', class: classOf(vis.orKeyLabel) }, ['OpenRouter Key（仅存本机）', orKeyInput]),
    el('div', { id: 'probeRow', class: classOf(vis.probeRow) }, [
      probeBtn,
      el('div', {
        id: 'probeOut',
        'aria-live': 'polite',
        class: probeClass(props.probeState),
        text: props.probeText ?? '',
      }),
    ]),
    el('label', null, ['走棋随机度', topKSel]),
    el('label', { class: 'check-row' }, [syncBox, ' 终局自动同步棋谱（供复盘分析）']),
    el('div', { class: 'hint', text: '设置保存在本机 localStorage；渠道/key 只进本机，不随棋谱上传。' }),
    el('div', { class: 'drawer-sub', text: '双方覆盖（留空 = 跟随上方全局设置）' }),
    el('div', { id: 'sideCfgBlack', class: 'side-cfg' }),
    el('div', { id: 'sideCfgWhite', class: 'side-cfg' }),
    el('div', { class: 'hint', text: '覆盖只影响「哪一方怎么走」，不改变全局默认；实验跑完自动还原回这里配的值。' }),
  ]);

  renderSideConfig(doc, { versions: props.versions, black: props.black, white: props.white }, {
    onSideChange: handlers.onSideChange,
  });

  bindDrawerChrome(doc);
}

/** 静态抽屉外壳的事件只绑一次（`#drawerClose` 关闭、`#drawerMask` 点击关闭）。 */
function bindDrawerChrome(doc: Document): void {
  onOnce(byId<HTMLElement>('drawerClose', doc), 'click', () => setDrawerOpen(false, doc));
  onOnce(byId<HTMLElement>('drawerMask', doc), 'click', () => setDrawerOpen(false, doc));
}

/** 开合抽屉（旧 `openDrawer()` / `closeDrawer()` 只切 `hidden`）。 */
export function setDrawerOpen(open: boolean, doc: Document = document): void {
  const drawer = byId<HTMLElement>('settingsDrawer', doc);
  const mask = byId<HTMLElement>('drawerMask', doc);
  if (drawer) drawer.classList.toggle('hidden', !open);
  if (mask) mask.classList.toggle('hidden', !open);
}

export function isDrawerOpen(doc: Document = document): boolean {
  const drawer = byId<HTMLElement>('settingsDrawer', doc);
  return !!drawer && !drawer.classList.contains('hidden');
}

export function openSettingsDrawer(doc: Document = document): void {
  setDrawerOpen(true, doc);
}

export function closeSettingsDrawer(doc: Document = document): void {
  setDrawerOpen(false, doc);
}

/** 就地更新探测输出（不重建抽屉；app 层探活过程中用）。 */
export function setProbeOut(text: string, state?: ProbeState, doc: Document = document): void {
  const out = byId<HTMLElement>('probeOut', doc);
  if (!out) return;
  out.textContent = text;
  out.className = state ?? '';
}

/** 写 `#modeHint`（旧 `syncChannelUI()` 末尾那段）。 */
export function renderChannelHint(channel: string, root: UiRoot | undefined = document): void {
  const node = qs<HTMLElement>(root ?? document, '#modeHint');
  if (node) node.textContent = channelHint(channel);
}

/** 写头部渠道芯片（旧 `updateChannelChip()`：生效渠道被降级成 mock 时补「 · 演示」）。 */
export function renderChannelChip(channel: string, effective: string, root: UiRoot | undefined = document): void {
  const node = qs<HTMLElement>(root ?? document, '#channelChip');
  if (!node) return;
  const name = CHANNEL_NAMES[channel] ?? channel;
  node.textContent = effective === 'mock' && channel !== 'mock' ? name + ' · 演示' : name;
}
