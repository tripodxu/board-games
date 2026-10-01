/* helpers.ts — test/ui 的共用夹具与事件驱动小工具
 *
 * 为什么单独一个文件：vitest 的 `ui` project（vitest.config.ts:39-45）没有 setupFiles，
 * 每个 spec 自建自清；但「挂一份 index.html 片段到真实 document.body」这件事每个 spec 都要做，
 * 而且**必须挂在真实 document 上**——`src/ui/**` 里的 `byId()` / `setDrawerOpen()` /
 * `renderSideSlot()` 都走全局 document（`byId(id, doc = document)`），挂在游离节点上会静默不渲染。
 *
 * 本文件不是 spec（`include` 只收 test/ui 下的 `*.spec.ts`），只被 spec import。
 */
import type { StorageLike } from '../../src/core/persist.ts';
import type { SelectEl } from '../../src/ui/dom.ts';

/** 断言并收窄：拿不到节点就让测试立刻失败（而不是 `!` 断言到运行时才炸）。 */
export function need<T>(value: T | null | undefined, what = 'node'): T {
  if (value === null || value === undefined) throw new Error('missing ' + what);
  return value;
}

/** 把一段 HTML 片段挂到 document.body，返回宿主节点（root 参数通常传它）。 */
export function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.className = 'test-fixture';
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

/** 清掉本用例挂上去的全部节点（afterEach 用）。 */
export function cleanup(): void {
  document.body.innerHTML = '';
}

/** 内存版 StorageLike（`src/core/persist.ts`），带 `map` 便于断言落盘内容。 */
export interface MemStorage {
  map: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memStorage(seed: Record<string, string> = {}): MemStorage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** 造一个只记账的 StorageLike（用于「只落盘一次」这类幂等断言）。 */
export function countingStorage(): { storage: StorageLike; writes: string[] } {
  const mem = memStorage();
  const writes: string[] = [];
  return {
    writes,
    storage: {
      getItem: (key) => mem.getItem(key),
      setItem: (key, value) => {
        writes.push(key);
        mem.setItem(key, value);
      },
      removeItem: (key) => {
        mem.removeItem(key);
      },
    },
  };
}

/** 派发冒泡的 click（面板里的委托监听挂在祖先上，必须 bubbles）。 */
export function click(node: Element | null | undefined): void {
  need(node, 'click target').dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** 派发冒泡的键盘事件（页签 ←/→ 用）。 */
export function keydown(node: Element | null | undefined, key: string): void {
  need(node, 'keydown target').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

/** 给 `<select>` 设值并派发 change。 */
export function select(sel: SelectEl | null | undefined, value: string): void {
  const el = need(sel, 'select');
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 给 `<input>` 设值并派发指定事件（默认 input，`#speed` 用）。 */
export function input(node: HTMLInputElement | null | undefined, value: string, type = 'input'): void {
  const el = need(node, 'input');
  el.value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
}
