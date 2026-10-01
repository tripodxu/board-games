/* panels/tabs.ts — 侧栏页签（对局 / 实验 / 数据）
 *
 * 来源旧实现与行号：js/app.js:262-311（SIDETAB_KEY / SIDETAB_NAMES / activateSidePane /
 * initSideTabs）。DOM 契约：index.html 里 `.side-tabs button[data-pane]`（`aria-selected`）与
 * `.side-pane#pane-play|#pane-exp|#pane-data`（用 `hidden` 属性切换）。
 *
 * 风格：**不重建子树**——页签按钮与页容器都是 index.html 的静态节点，本模块只切 `active` /
 * `aria-selected` / `hidden`；事件用委托 + `onOnce`，重复 `initSideTabs()` 不会重复绑定。
 *
 * 刻意差异：
 *  1. **持久化注出**：旧实现直接读写 `localStorage[SIDETAB_KEY]`；这里 `createSideTabStore(storage)`
 *     收 `StorageLike`（`src/core/persist.ts`），装配层注入。本模块不 import localStorage。
 *  2. 旧 `activateSidePane(name, persist, runHooks)` 的两个布尔位改成选项对象
 *     `{ persist, runHooks, hooks, store, root }`，语义一一对应。
 *  3. 切页签后的补渲染钩子与折叠面板共用 `FoldHooks`（见 collapse.ts），不再直接引用 app 内部函数。
 *  4. 键盘 ←/→ 找不到 `document.activeElement` 对应的页签时保持旧行为（直接 return，不动焦点）。
 *  5. 旧注释强调的初始化陷阱保留：首次 `activateSidePane()` 必须 `runHooks:false`——引擎/会话尚未就绪，
 *     补渲染会抛 TypeError 中断整段初始化。
 */
import type { StorageLike } from '../../core/persist.ts';
import { onOnce, qs, qsa, type UiRoot } from '../dom.ts';
import type { FoldHooks } from './collapse.ts';

/** 侧栏页签的 localStorage 键（旧 `SIDETAB_KEY`，js/app.js:263）。 */
export const SIDETAB_KEY = 'jev_qiguan_sidetab_v1';

/** 三个页签名（旧 `SIDETAB_NAMES`，js/app.js:264）。 */
export const SIDETAB_NAMES: readonly string[] = ['play', 'exp', 'data'];

/** 存储缺失/非法时的默认页签（旧 `activateSidePane(… : 'play', …)`）。 */
export const SIDETAB_DEFAULT = 'play';

/** 页签持久化（`StorageLike` 由装配层注入）。 */
export interface SideTabStore {
  name(): string | null;
  save(name: string): void;
}

/** 旧 `localStorage.getItem/setItem(SIDETAB_KEY)`（js/app.js:279、294）。 */
export function createSideTabStore(storage: StorageLike): SideTabStore {
  return {
    name(): string | null {
      try {
        return storage.getItem(SIDETAB_KEY);
      } catch {
        return null;
      }
    },
    save(name: string): void {
      try {
        storage.setItem(SIDETAB_KEY, name);
      } catch {
        /* 与旧实现一样静默忽略 */
      }
    },
  };
}

/** 页签对应的页容器 id（旧 `'pane-' + name`）。 */
export function paneId(name: string): string {
  return 'pane-' + name;
}

export function paneEl(name: string, root?: UiRoot | null): HTMLElement | null {
  return qs<HTMLElement>(root ?? document, '#' + paneId(name));
}

/** 当前可见的页签名（`hidden` 为 false 的第一个 `.side-pane`）。 */
export function activeSidePane(root?: UiRoot | null): string | null {
  const pane = qsa<HTMLElement>(root ?? document, '.side-pane').find((p) => !p.hidden);
  return pane ? pane.id.replace(/^pane-/, '') : null;
}

export interface ActivateOptions {
  /** 写入存储（只有用户主动切换才为 true；初始化传 false） */
  persist?: boolean;
  /** 对目标页内已展开面板跑一次补渲染钩子（隐藏期间容器量宽为 0） */
  runHooks?: boolean;
  hooks?: FoldHooks;
  store?: SideTabStore | null;
  root?: UiRoot | null;
}

/** 旧 `activateSidePane(name, persist, runHooks)`（js/app.js:269-289）。 */
export function activateSidePane(name: string, opts: ActivateOptions = {}): void {
  const root = opts.root ?? document;
  qsa<HTMLElement>(root, '.side-tabs button[data-pane]').forEach((b) => {
    const on = b.dataset.pane === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  qsa<HTMLElement>(root, '.side-pane').forEach((p) => {
    p.hidden = p.id !== paneId(name);
  });
  if (opts.persist) opts.store?.save(name);
  if (!opts.runHooks) return;
  const pane = paneEl(name, root);
  if (!pane) return;
  qsa<HTMLElement>(pane, '.panel.collapsible:not(.folded)').forEach((sec) => {
    const id = sec.dataset.panel;
    if (id) opts.hooks?.[id]?.();
  });
}

function ownerDocumentOf(root: UiRoot): Document {
  return (root as Node).nodeType === 9 ? (root as Document) : (root as Element).ownerDocument ?? document;
}

export interface SideTabsInitOptions {
  hooks?: FoldHooks;
  store?: SideTabStore | null;
  root?: UiRoot | null;
}

/** 旧 `initSideTabs()`（js/app.js:290-311）：应用存储页签 + 点击委托 + ←/→ 循环。 */
export function initSideTabs(opts: SideTabsInitOptions = {}): void {
  const root = opts.root ?? document;
  const bar = qs<HTMLElement>(root, '.side-tabs');
  if (!bar) return;
  const saved = opts.store ? opts.store.name() : null;
  const initial = saved && SIDETAB_NAMES.includes(saved) ? saved : SIDETAB_DEFAULT;
  /* 初始化不补渲染：此时引擎/会话尚未就绪（旧注释，js/app.js:265-268） */
  activateSidePane(initial, { ...opts, persist: false, runHooks: false });
  onOnce(bar, 'click', (ev) => {
    const t = ev.target as Element | null;
    const b = t && typeof t.closest === 'function' ? (t.closest('button[data-pane]') as HTMLElement | null) : null;
    const name = b?.dataset.pane;
    if (!name) return;
    activateSidePane(name, { ...opts, persist: true, runHooks: true });
  });
  /* ←/→ 在页签间循环移动（WAI-ARIA tabs 惯例，旧注释） */
  onOnce(bar, 'keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const btns = qsa<HTMLElement>(bar, 'button[data-pane]');
    const i = btns.indexOf(ownerDocumentOf(root).activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : btns.length - 1;
    const next = btns[(i + step) % btns.length];
    if (!next) return;
    next.focus();
    const name = next.dataset.pane;
    if (name) activateSidePane(name, { ...opts, persist: true, runHooks: true });
  });
}
