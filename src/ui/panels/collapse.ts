/* panels/collapse.ts — 侧栏面板折叠（一屏放下：驾驶舱常开，其余面板可收起）
 *
 * 来源旧实现与行号：js/app.js:204-260（FOLD_KEY / FOLD_HOOKS / loadFoldOpen / saveFoldOpen /
 * applyFolded / toggleFold / initFolds）。DOM 契约：index.html 里 `.panel.collapsible[data-panel]`
 * > `.panel-title` + `button.fold`（`aria-expanded`）。
 *
 * 风格：**不重建子树**——折叠面板的内容归各自的 render 模块，本模块只切 `.folded` / `aria-expanded`
 * 并对存储与补渲染钩子负责；事件一律 `onOnce`，重复 `initFolds()` 不会重复绑定。
 *
 * 刻意差异：
 *  1. **持久化注出**：旧实现直接读写 `localStorage[FOLD_KEY]`；这里 `createFoldStore(storage)` 收
 *     `StorageLike`（`src/core/persist.ts`），装配层注入。本模块不 import localStorage。
 *  2. **钩子注出**：旧 `FOLD_HOOKS` 直接引 app 内部的 renderAnalytics/renderCockpit/…；这里由调用方
 *     以 `FoldHooks`（`{ [panelId]: () => void }`）传入，`FOLD_HOOK_IDS` 记录旧实现的七个键。
 *  3. `initFolds()` 跳过没有 `data-panel` 的区块（旧实现会把 `undefined` 拼进选择器）。
 *  4. 存储里不是数组的合法 JSON（如 `{}`）按空清单处理（旧实现 `JSON.parse(raw) || []` 会把它当清单用）。
 */
import type { StorageLike } from '../../core/persist.ts';
import { onOnce, qs, qsa, type UiRoot } from '../dom.ts';

/** 折叠状态的 localStorage 键（旧 `FOLD_KEY`，js/app.js:205）。 */
export const FOLD_KEY = 'jev_qiguan_panels_v1';

/** 首访默认展开的面板（旧 `loadFoldOpen()` 无存储时返回，js/app.js:219）。 */
export const FOLD_DEFAULT_OPEN: readonly string[] = ['trend', 'expreport'];

/** 存储损坏时的兜底展开清单（旧 catch 分支，js/app.js:221）。 */
export const FOLD_FALLBACK_OPEN: readonly string[] = ['trend'];

/** 旧 `FOLD_HOOKS` 的键（展开后需要补一次全量渲染的面板）。 */
export const FOLD_HOOK_IDS: readonly string[] = ['trend', 'duel', 'latest', 'feed', 'records', 'cal', 'archive'];

/** 面板 id → 展开补渲染回调。 */
export type FoldHooks = Readonly<Record<string, (() => void) | undefined>>;

/** 折叠清单读写（`StorageLike` 由装配层注入）。 */
export interface FoldStore {
  /** 当前展开清单（含首访默认与损坏兜底） */
  open(): string[];
  save(open: readonly string[]): void;
}

/** 旧 `loadFoldOpen()` + `saveFoldOpen()`（js/app.js:216-225）。 */
export function createFoldStore(
  storage: StorageLike,
  defaults: readonly string[] = FOLD_DEFAULT_OPEN,
): FoldStore {
  return {
    open(): string[] {
      try {
        const raw = storage.getItem(FOLD_KEY);
        if (raw === null) return [...defaults];
        const v: unknown = JSON.parse(raw);
        return Array.isArray(v) ? (v as string[]) : [];
      } catch {
        return [...FOLD_FALLBACK_OPEN];
      }
    },
    save(open: readonly string[]): void {
      try {
        storage.setItem(FOLD_KEY, JSON.stringify(open));
      } catch {
        /* 与旧实现一样静默忽略 */
      }
    },
  };
}

/** 旧 `document.querySelector('.panel.collapsible[data-panel="'+pid+'"]')`。 */
export function foldSection(pid: string, root?: UiRoot | null): HTMLElement | null {
  return qs<HTMLElement>(root ?? document, `.panel.collapsible[data-panel="${pid}"]`);
}

/** 旧 `applyFolded()`（js/app.js:226-232）。 */
export function applyFolded(pid: string, folded: boolean, root?: UiRoot | null): void {
  const sec = foldSection(pid, root);
  if (!sec) return;
  sec.classList.toggle('folded', folded);
  const btn = sec.querySelector('button.fold');
  if (btn) btn.setAttribute('aria-expanded', String(!folded));
}

/** 旧 `toggleFold()` 里 `.panel.collapsible:not(.folded)` → `dataset.panel` 的收集。 */
export function openPanelIds(root?: UiRoot | null): string[] {
  return qsa<HTMLElement>(root ?? document, '.panel.collapsible:not(.folded)')
    .map((s) => s.dataset.panel)
    .filter((id): id is string => !!id);
}

export function isFolded(pid: string, root?: UiRoot | null): boolean {
  return !!foldSection(pid, root)?.classList.contains('folded');
}

export interface FoldOptions {
  root?: UiRoot | null;
  /** 展开后补渲染的钩子（旧 FOLD_HOOKS） */
  hooks?: FoldHooks;
  /** 折叠清单存储；不给则不落盘 */
  store?: FoldStore | null;
}

/** 旧 `toggleFold()`（js/app.js:233-246）：返回本次是否收起。 */
export function toggleFold(pid: string, opts: FoldOptions = {}): boolean {
  const sec = foldSection(pid, opts.root);
  if (!sec) return false;
  const willFold = !sec.classList.contains('folded');
  applyFolded(pid, willFold, opts.root);
  /* 以 DOM 当前状态为准收集展开清单，避免与存储漂移（旧注释） */
  const open = openPanelIds(opts.root);
  if (!willFold) opts.hooks?.[pid]?.();
  opts.store?.save(open);
  return willFold;
}

export interface FoldInitOptions extends FoldOptions {
  /** 展开清单存储；不给则按 `FOLD_DEFAULT_OPEN` 应用 */
  store?: FoldStore | null;
}

/** 旧 `initFolds()`（js/app.js:247-260）：应用存储状态 + 绑标题/按钮（onOnce，可重复调用）。 */
export function initFolds(opts: FoldInitOptions = {}): void {
  const root = opts.root ?? document;
  const open = opts.store ? opts.store.open() : [...FOLD_DEFAULT_OPEN];
  qsa<HTMLElement>(root, '.panel.collapsible').forEach((sec) => {
    const pid = sec.dataset.panel;
    if (!pid) return;
    applyFolded(pid, !open.includes(pid), root);
    onOnce(sec.querySelector('.panel-title'), 'click', (ev) => {
      /* 标题行内的实体控件（清空/曲线切换等）不触发折叠（旧注释） */
      const t = ev.target as Element | null;
      if (t && typeof t.closest === 'function' && t.closest('button, select, input, a, label')) return;
      toggleFold(pid, opts);
    });
    const btn = sec.querySelector('button.fold');
    if (btn) onOnce(btn, 'click', () => toggleFold(pid, opts));
  });
}
