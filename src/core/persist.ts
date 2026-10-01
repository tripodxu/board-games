/* persist.ts — 设置读写（迁移自 js/app.js 的「设置」段，js/app.js:20-202 的纯逻辑部分）
 *
 * 为什么单独一个模块：旧实现把「读盘 → 合并默认值 → 回填 DOM → 渠道可用性回落」全缠在
 * 一个 `loadSettings()` 里（js/app.js:20-51 既读 localStorage 又写 `#channel` 输入框），
 * 既不能单测，也没法在 Node 里跑。这里只保留**纯逻辑**：
 *   - 读盘：合并默认值、补键、归一化（与旧实现逐字等价）；
 *   - 写盘：只做 JSON 序列化 + 异常吞掉（隐私模式 / 配额满不能把对局弄崩）；
 *   - 渠道解析：`effectiveChannelOf` / `effSide`（旧实现唯一的 DOM 依赖是
 *     `location.protocol === 'file:'`，这里改成注入 `isFile`，默认 false）。
 * DOM 回填（旧 `syncChannelUI()`）与探活（旧 `runProbe()`）留在 `src/ui/**`。
 *
 * 键名与旧 localStorage 逐字兼容（`jev_qiguan_settings_v2`）：迁移不能丢用户设置。
 * 另注：旧实现**没有**「画像 / profile / deviceId」持久化（js/ 下 grep 零命中），
 * 因此本模块不提供 loadProfile/saveProfile；设备标识在 P7 由 Worker 侧下发。
 */
import { CURRENT, resolve } from './tactics-versions.ts';

/** 旧实现的设置键（js/app.js:7）。**不要改**：改了就丢用户现有设置。 */
export const STORE_KEY = 'jev_qiguan_settings_v2';

/** 迁移基准版本（旧实现在 js/app.js:42 硬编码 'v9-vcf-sound'，这里跟登记表联动）。 */
export const DEFAULT_TACTICS_VERSION = CURRENT;

/** 注入式存储：浏览器传 `localStorage`，Node 测试传内存桩。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** 对局模式（js/app.js 的 `#mode` 三个合法取值）。 */
export type AppMode = 'human-ai' | 'ai-ai' | 'pvp';
export const MODE_VALUES: readonly AppMode[] = ['human-ai', 'ai-ai', 'pvp'];

/** 单边覆盖（旧 `sideConfig[side]`，经 `mk()` 归一后的形态）。 */
export interface SideConfig {
  /** 渠道覆盖；空串 = 回落全局 */
  channel: string;
  /** 战术档覆盖；空串 = 回落全局 */
  tactics: string;
  /** Rapfi 思考时长覆盖；0 = 回落全局 */
  rapfiThinkMs: number;
}

/** 设置对象：字段与旧 `S.settings`（js/app.js:17）逐字一致。 */
export interface Settings {
  channel: string;
  apiKey: string;
  orKey: string;
  topK: number;
  speed: number;
  /** 自定义端点（各渠道一条；mock/rapfi 不入账） */
  endpoints: Record<string, string>;
  gameSync: boolean;
  rapfiThinkMs: number;
  tacticsVersion: string;
  /** 旧实现在这里可能是任意串（只守 DOM 不守值），见 isValidMode */
  mode: string;
  sideConfig: Record<string, SideConfig>;
}

/** 单边最终配置（旧 `effSide()` 的返回）。 */
export interface EffSide {
  channel: string;
  tactics: string;
  rapfiThinkMs: number;
}

/** 旧 `S.settings` 的初始值（js/app.js:17）——sideConfig 用归一后的空值形态。 */
export const DEFAULT_SETTINGS: Settings = {
  channel: 'proxy',
  apiKey: '',
  orKey: '',
  topK: 3,
  speed: 6,
  endpoints: {},
  gameSync: true,
  rapfiThinkMs: 3000,
  tacticsVersion: DEFAULT_TACTICS_VERSION,
  mode: 'human-ai',
  sideConfig: {
    black: { channel: '', tactics: '', rapfiThinkMs: 0 },
    white: { channel: '', tactics: '', rapfiThinkMs: 0 },
  },
};

/** 旧 `mk()`（js/app.js:47）：把任意形态的单边配置压成三字段，缺失一律补空/0。 */
export function normalizeSideConfig(s: unknown): SideConfig {
  const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
  return {
    channel: (o.channel as string) || '',
    tactics: (o.tactics as string) || '',
    rapfiThinkMs: +(o.rapfiThinkMs as number) || 0,
  };
}

/** 深拷贝一份默认设置：`loadSettings` 要往返回值上写，不能污染模块级常量。 */
function freshDefaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    endpoints: {},
    sideConfig: {
      black: normalizeSideConfig(DEFAULT_SETTINGS.sideConfig.black),
      white: normalizeSideConfig(DEFAULT_SETTINGS.sideConfig.white),
    },
  };
}

/** 读设置（旧 `loadSettings()` 的纯逻辑部分，js/app.js:20-51）。
 *
 *  逐字语义：浅合并（`Object.assign`）覆盖默认值 → `endpoints` 缺失补 `{}`
 *  → `tacticsVersion` 缺失补当前档 → `sideConfig` 双方各自归一化。
 *  存储损坏（JSON 解析失败、`getItem` 抛异常）一律静默回退默认值。
 *  旧实现在这里还顺手回填了 DOM 输入框（`$('channel').value = ...`）与 mode 白名单，
 *  那部分属 UI 层：`isValidMode()` 留给 `src/ui/**` 复刻同一个白名单。
 */
export function loadSettings(storage: StorageLike): Settings {
  const s = freshDefaults();
  try {
    const raw = storage.getItem(STORE_KEY);
    if (raw) Object.assign(s, JSON.parse(raw));
    if (!s.endpoints) s.endpoints = {};
  } catch (_) { /* 存储不可用/内容损坏：按默认值继续 */ }
  if (!s.tacticsVersion) s.tacticsVersion = DEFAULT_TACTICS_VERSION;
  const sc = (s.sideConfig || {}) as Record<string, unknown>;
  s.sideConfig = {
    black: normalizeSideConfig(sc.black),
    white: normalizeSideConfig(sc.white),
  };
  return s;
}

/** 写设置（旧 `saveSettings()` 的落盘部分，js/app.js:70-72）。静默失败：写不进去也不能崩。 */
export function saveSettings(storage: StorageLike, s: Settings): void {
  try {
    storage.setItem(STORE_KEY, JSON.stringify(s));
  } catch (_) { /* ignore */ }
}

/** 归档当前渠道的自定义端点（旧 `stashEndpoint()`，js/app.js:52-56）。
 *
 *  必须在「改写 channel 之前」调用，否则会把新渠道的端点存到旧渠道名下。
 *  mock / rapfi / 空渠道不入账（它们没有自定义端点）。就地改并入参对象并返回它。
 */
export function stashEndpoint(settings: Settings, channel: string | null | undefined, value: string): Settings {
  if (channel === 'mock' || channel === 'rapfi' || !channel) return settings;
  if (!settings.endpoints) settings.endpoints = {};
  settings.endpoints[channel] = String(value == null ? '' : value).trim();
  return settings;
}

/** 渠道可用性回落（旧 `effectiveChannelOf()`，js/app.js:142-157）。
 *
 *  顺序即语义：mock/rapfi 原样；`file://` 下同源代理不可用 → 演示；
 *  配了自定义端点视为可用；proxy 是同源默认；官方/OpenRouter 没填 key → 演示。
 *  旧实现直接读 `location.protocol`，这里注入 `isFile`（Node 侧恒 false）。
 */
export function effectiveChannelOf(
  settings: Settings,
  channel: string | null | undefined,
  opts?: { isFile?: boolean } | null,
): string {
  const ch = channel || '';
  const isFile = !!(opts && opts.isFile);
  if (ch === 'mock') return 'mock';
  if (ch === 'rapfi') return 'rapfi';
  if (ch === 'proxy' && isFile) return 'mock';
  if (settings.endpoints && settings.endpoints[ch]) return ch;
  if (ch === 'proxy') return 'proxy';
  const key = ch === 'openrouter' ? settings.orKey : settings.apiKey;
  if (!key) return 'mock';
  return ch;
}

/** 单边最终配置（旧 `effSide()`，js/app.js:82-89）：sideConfig 覆盖优先，空值回落全局。 */
export function effSide(
  settings: Settings,
  side: string,
  opts?: { isFile?: boolean } | null,
): EffSide {
  const cfg = (settings.sideConfig && settings.sideConfig[side]) || normalizeSideConfig(null);
  return {
    channel: effectiveChannelOf(settings, cfg.channel || settings.channel, opts),
    tactics: resolve(cfg.tactics || settings.tacticsVersion).id,
    rapfiThinkMs: +(cfg.rapfiThinkMs || settings.rapfiThinkMs) || settings.rapfiThinkMs,
  };
}

/** 旧 `mode` 白名单（js/app.js:36-38 的回填守卫，注释：「非法值一律回退人机」）。 */
export function isValidMode(v: unknown): v is AppMode {
  return typeof v === 'string' && (MODE_VALUES as readonly string[]).indexOf(v) >= 0;
}
