/* panels/options.ts — 面板共用的「选项表 + 标签口径」（迁移自 js/app.js:931-1000 与 1290-1310）
 *
 * 为什么单独一个模块：旧实现把这些常量摊在 app.js 里，`renderSideCfg()`（js/app.js:947-967）、
 * `renderFoe()`（js/app.js:981-1000）、`renderExpHistory()`（js/app.js:1337-1392）各自重建
 * `<option>` 时都要用到，而且**文案必须逐字一致**（同一渠道在抽屉/机器对手/战报里叫法不同是
 * 有意设计：抽屉写「同源代理 /api/jev（推荐 · 转发你自己的 key）」，下拉覆盖写「Jev 模型」）。
 * 这里把三张表原样搬过来，避免各面板自己抄一份抄歪。
 *
 * 对应关系：
 *   THINK_OPTS / SIDE_CHANS / FOE_CHANS  ← js/app.js:932-934 逐字
 *   EXP_CHANS                            ← index.html:389-395 的静态 `<option>`（旧 JS 从不重建）
 *   DRAWER_CHANNEL_OPTS / RAPFI_THINK_OPTS / TOPK_OPTS ← index.html:440-490 静态文案
 *   CHANNEL_NAMES（抽屉芯片/机器对手提示） ← js/app.js:103
 *   CHAN_LABEL（战报归因）                ← js/app.js:1291
 *   sideAttribution()                    ← js/app.js:1293-1298
 *   战术版本选项                          ← js/app.js:948-953 fillTacticsSelect（`v.id + ' ' + v.name`）
 *
 * 刻意差异：
 *  1. 战术版本表**不从 core 直接 import**：由 props 注入 `readonly TacticsVersion[]`
 *     （旧实现读全局 `BG.tacticsVersions.VERSIONS`）。登记表加档位时 UI 零改动。
 *  2. 选项表是 `readonly` 常量，`fillSelect()` 只读不改。
 *  3. 不拼 HTML：`fillSelect()` 走 dom.ts 的 `el()`。
 *
 * 本模块不 import node:*，不碰 localStorage / fetch。
 */
import type { EffSide } from '../../core/persist.ts';
import type { TacticsVersion } from '../../core/tactics-versions.ts';
import { sideLabel } from '../../core/view/duel.ts';
import { el, replaceChildren, type SelectEl } from '../dom.ts';

/** `[值, 文案]`。空串值的选项表示「跟随」（旧实现用 `<option value="">`）。 */
export type Opt = readonly [value: string, label: string];

/** Rapfi 思考时长选项（旧 `THINK_OPTS`，js/app.js:932）。 */
export const THINK_OPTS: readonly Opt[] = [
  ['', '跟随'],
  ['500', '0.5s'],
  ['1000', '1s'],
  ['2000', '2s'],
  ['3000', '3s'],
  ['5000', '5s'],
  ['10000', '10s'],
];

/** 抽屉「双方覆盖」的渠道选项（旧 `SIDE_CHANS`，js/app.js:933）。 */
export const SIDE_CHANS: readonly Opt[] = [
  ['', '跟随全局'],
  ['proxy', 'Jev 模型'],
  ['openrouter', 'Jev·OpenRouter'],
  ['official', 'Jev·官方'],
  ['rapfi', 'Rapfi 引擎'],
  ['random', '随机+战术'],
  ['mock', '演示'],
];

/** 机器对手面板的渠道选项（旧 `FOE_CHANS`，js/app.js:934）。 */
export const FOE_CHANS: readonly Opt[] = [
  ['', '跟随全局'],
  ['proxy', 'Jev 模型（代理）'],
  ['openrouter', 'Jev · OpenRouter'],
  ['opencode', 'Jev · OpenCode（免费）'],
  ['opencode_local', 'Jev · OpenCode 本地中转（你的 IP · 最稳）'],
  ['jevrouter', 'Jev · 自建网关（多源路由 · 出口轮换）'],
  ['official', 'Jev · 官方 API'],
  ['rapfi', 'Rapfi 引擎'],
  ['random', '随机 + 战术'],
  ['mock', '离线演示'],
];

/** 对比实验 A/B 方的渠道选项（index.html:389-395 静态文案，**无「跟随全局」项**）。 */
export const EXP_CHANS: readonly Opt[] = [
  ['proxy', 'Jev(代理)+战术'],
  ['openrouter', 'Jev(OpenRouter)+战术'],
  ['opencode', 'Jev(OpenCode·免费)+战术'],
  ['opencode_local', 'Jev(OpenCode本地中转)+战术'],
  ['jevrouter', 'Jev(自建网关)+战术'],
  ['official', 'Jev(官方)+战术'],
  ['random', '纯随机+战术'],
  ['mock', '离线演示'],
  ['rapfi', 'Rapfi 本地引擎'],
];

/** 抽屉「接入渠道」选项（index.html:440-446 静态文案）。 */
export const DRAWER_CHANNEL_OPTS: readonly Opt[] = [
  ['proxy', '同源代理 /api/jev（推荐 · 转发你自己的 key）'],
  ['openrouter', 'OpenRouter（浏览器直连）'],
  ['opencode', 'OpenCode Zen（免费 · 浏览器直连）'],
  ['opencode_local', 'OpenCode 本地中转（你的 IP · 需先跑 local-relay.mjs）'],
  ['jevrouter', '自建 jev-router 网关（同源 /api/jev 转发你的 jv- key）'],
  ['official', '官方 API 直连（可能被 CORS 拦截）'],
  ['mock', '离线演示（无需 key）'],
  ['rapfi', 'Rapfi 本地引擎（首次下载模型）'],
];

/** 抽屉「Rapfi 思考时长」选项（index.html:463-470）。 */
export const RAPFI_THINK_OPTS: readonly Opt[] = [
  ['500', '0.5 秒（最弱 · 最快）'],
  ['1000', '1 秒'],
  ['2000', '2 秒'],
  ['3000', '3 秒（默认）'],
  ['5000', '5 秒'],
  ['10000', '10 秒（最强 · 最慢）'],
];

/** 抽屉「走棋随机度」选项（index.html:487-489）。 */
export const TOPK_OPTS: readonly Opt[] = [
  ['1', '最强手（不随机）'],
  ['3', '温和（top-3 加权）'],
  ['5', '狂野（top-5 加权）'],
];

/** 渠道显示名（旧 `CHANNEL_NAMES`，js/app.js:103）。 */
export const CHANNEL_NAMES: Record<string, string> = {
  official: '官方 API',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode（免费）',
  opencode_local: 'OpenCode 本地中转',
  jevrouter: '自建 jev-router 网关',
  proxy: '同源代理',
  mock: '离线演示',
  rapfi: 'Rapfi 本地',
};

/** 战报归因用的渠道简称（旧 `CHAN_LABEL`，js/app.js:1291）。 */
export const CHAN_LABEL: Record<string, string> = {
  proxy: 'Jev(代理)',
  openrouter: 'Jev(OpenRouter)',
  official: 'Jev(官方)',
  jevrouter: 'Jev(自建网关)',
  random: '纯随机',
  mock: '离线演示',
  rapfi: 'Rapfi',
};

/** 实验战报里算「Jev 渠道胜」的白名单（旧 `JEV_CHANS`，js/app.js:1245）。 */
export const JEV_CHANNELS: readonly string[] = ['proxy', 'openrouter', 'official', 'jevrouter'];

/** 战术档位选项：`<option value=v.id>v.id + ' ' + v.name</option>`（旧 `fillTacticsSelect`）。 */
export function tacticsOptions(versions: readonly TacticsVersion[]): Opt[] {
  return versions.map((v) => [v.id, v.id + ' ' + v.name] as Opt);
}

/** 重建一个 `<select>` 的选项并回填选中值（找不到就回落空串/首项）。 */
export function fillSelect(
  sel: SelectEl | null | undefined,
  options: readonly Opt[],
  value?: string | null,
): void {
  if (!sel) return;
  replaceChildren(sel, options.map(([v, label]) => el('option', { value: v, text: label })));
  sel.value = value ?? '';
  if (sel.selectedIndex < 0 && sel.options.length) {
    sel.value = sel.options[0]!.value;
  }
}

/** 单边归因文案（旧 `sideAttribution`，js/app.js:1293-1298）：老战报缺字段时的三级回落。
 *
 *  没有战术档时**不再硬译渠道名**（`proxy` → `Jev(代理)` 会让人以为它就是当前档）：Rapfi 侧
 *  仍走 `sideLabel()`，好把思考时长带上（`Rapfi(0.5s)`）——归档从 2026-10-02 起不再给
 *  不过战术层的渠道写档位标签，那侧 `tactics` 就是空，这里负责把展示补回原样。 */
export function sideAttribution(
  channel: string | null | undefined,
  tactics: string | null | undefined,
  rapfiThinkMs?: number | null,
): string {
  if (!channel) return '旧数据';
  if (!tactics) {
    if (channel === 'rapfi') return sideLabel({ channel: channel, rapfiThinkMs: rapfiThinkMs ?? 0 });
    return CHAN_LABEL[channel] || channel;
  }
  return sideLabel({ channel: channel, tactics: tactics, rapfiThinkMs: rapfiThinkMs ?? 0 });
}

/** 机机联名（旧 `machinePairText`，js/app.js:351-356）：只按双方生效配置直译，不叠人机/双人人称。 */
export function machinePairText(
  first: EffSide | null | undefined,
  second: EffSide | null | undefined,
): string {
  return [sideLabel(first ?? null), sideLabel(second ?? null)].join(' vs ');
}
