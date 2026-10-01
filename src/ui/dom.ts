/* dom.ts — 极小 DOM 工具（零框架、零依赖）
 *
 * 来源：js/app.js 全文零散使用的 `$ = (id) => document.getElementById(id)`（js/app.js:5）
 *       与 createElement / innerHTML 拼串写法（js/app.js:1499-1508、1584-1623 等），
 *       以及 js/charts.js:8-13 的 SVG 元素工厂 `function svg(tag, attrs)`。
 * 职责：元素创建（HTML + SVG）、查询、清空/替换子树、文本、class/hidden 开关、
 *       事件绑定，以及展示层格式化（百分比/数字/成本/token/延迟/时间）。
 *
 * 刻意差异（相对旧实现，逐条）：
 *  1. **不用 innerHTML 拼串**：`el()` 的 children 支持字符串/数字/节点/嵌套数组，文本走
 *     textContent。旧实现每次渲染都重写 innerHTML，浏览器要重新解析整段 HTML。
 *  2. **事件写在 attrs 里**（`onclick` / `oninput` / `onchange` / `onkeydown`），由 el() 统一
 *     addEventListener —— 配合各面板「重建子树」式幂等渲染，监听随旧节点一起被丢弃，
 *     不会重复绑定（这正是旧实现 `initFolds()`/`renderFoe()` 反复重建时的隐患）。
 *  3. 表单控件的**当前值**（`value` / `checked` / `selected`）走属性赋值而不是 setAttribute：
 *     `setAttribute('value')` 只改 defaultValue，对已经渲染过的 input 不生效。
 *  4. 静态节点（面板标题、按钮等不在重建范围内的元素）用 `onOnce()` 绑定，WeakMap 记账，
 *     重复 render 不会叠加监听 —— 旧实现靠「只 init 一次」的约定，新代码靠机制。
 *  5. 格式化口径逐字照搬旧实现：fmtPct = 旧 `PCT`（js/app.js:1633）、fmtCost（js/app.js:394-398）、
 *     fmtTokens（js/app.js:1475 内联）、fmtLatency（js/app.js:1617）、
 *     fmtDateTime = 旧 `fmtExpDate`（js/app.js:1300-1305）、fmtClock（js/app.js:1606）。
 *
 *  6. **不依赖被污染的全局类型**：`tsconfig.json` 的 include 带上了 `worker-configuration.d.ts`
 *     （Cloudflare runtime 内联类型），它重声明了部分 DOM 接口，实测全局 `HTMLSelectElement`
 *     不是 `HTMLElement` 子类型、`HTMLElement` 也不能赋给 `ParentNode`。视图层统一改用本地
 *     `SelectEl` / `TagMap` / `UiRoot`，全模块只有 `el()` 内一处受控断言。
 *
 * 本模块不 import node:*，不碰 localStorage / fetch / location，可在 happy-dom 下直接回归。
 */

/** SVG 命名空间常量（js/charts.js:9 的逐字照搬）。 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export type AttrScalar = string | number | boolean | null | undefined;

/** 子节点：字符串/数字自动变文本节点，false/null/undefined 跳过，数组递归展平。 */
export type DomChild = Node | string | number | false | null | undefined | readonly DomChild[];

/** `el()` / `svgEl()` 的属性包。`on*` 键为事件监听，`dataset` 展开成 `data-*`。 */
export interface Attrs {
  class?: string;
  id?: string;
  /** 文本内容（等价 textContent，避免拼 innerHTML） */
  text?: string;
  /** 展开为 `data-<k>`；值 false/null/undefined 跳过，true 写空串 */
  dataset?: Record<string, AttrScalar>;
  /** 展开为内联 style 字符串；值 null/undefined/false/'' 跳过 */
  style?: Record<string, AttrScalar>;
  value?: AttrScalar;
  checked?: boolean;
  selected?: boolean;
  disabled?: boolean;
  [k: string]: unknown;
}

/** `<select>` 的最小结构契约。
 *
 *  为什么不直接用全局 `HTMLSelectElement`：本仓库 tsconfig 的 `include` 带上了
 *  `worker-configuration.d.ts`（Cloudflare runtime 内联类型），它重声明了部分 DOM 全局接口，
 *  实测 `[HTMLSelectElement] extends [HTMLElement]` 为 **false**（`HTMLElementTagNameMap['select']`
 *  同样如此），直接使用会在所有「传 HTMLElement / Element」的位置报 TS2344 / TS2322。
 *  视图层只需要 `.value`，故用这个本地契约代替。 */
export interface SelectOptionEl {
  value: string;
  text: string;
  selected: boolean;
}

export interface SelectEl extends HTMLElement {
  value: string;
  selectedIndex: number;
  readonly options: { readonly length: number; [index: number]: SelectOptionEl };
}

/** `el()` 的标签→元素类型表：除 `select` 外逐字沿用 lib.dom 的 `HTMLElementTagNameMap`。 */
export type TagMap = Omit<HTMLElementTagNameMap, 'select'> & { select: SelectEl };

/** 面板 root 的可用类型。
 *
 *  不用 lib.dom 的 `ParentNode`：本仓库实测 `HTMLElement` 不能赋给 `ParentNode`（TS2322，
 *  同样是 worker-configuration.d.ts 的重复声明导致），而 `Document` 可以。这个联合覆盖
 *  「能查（querySelector）、能挂（appendChild）」的实际用法。 */
export type UiRoot = HTMLElement | SVGElement | Document;

function styleText(style: Record<string, AttrScalar> | null | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  for (const k of Object.keys(style)) {
    const v = style[k];
    if (v === null || v === undefined || v === false || v === '') continue;
    parts.push(k + ':' + String(v));
  }
  return parts.join(';');
}

function applyAttrs(node: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  const form = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (key === 'class' || key === 'id') {
      if (v !== null && v !== undefined && v !== false) node.setAttribute(key, String(v));
      continue;
    }
    if (key === 'text') {
      node.textContent = v === null || v === undefined ? '' : String(v);
      continue;
    }
    if (key === 'dataset') {
      const d = v as Record<string, AttrScalar> | null | undefined;
      if (d) {
        for (const k of Object.keys(d)) {
          const dv = d[k];
          if (dv === null || dv === undefined || dv === false) continue;
          node.setAttribute('data-' + k, dv === true ? '' : String(dv));
        }
      }
      continue;
    }
    if (key === 'style') {
      const s = styleText(v as Record<string, AttrScalar> | null | undefined);
      if (s) node.setAttribute('style', s);
      continue;
    }
    if (key === 'value' || key === 'checked' || key === 'selected') {
      if (key in form && v !== undefined) form[key] = key === 'value' ? String(v) : !!v;
      continue;
    }
    if (/^on[a-z]+$/.test(key)) {
      if (typeof v === 'function') node.addEventListener(key.slice(2), v as EventListener);
      continue;
    }
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(key, v === true ? '' : String(v));
  }
}

/** 追加子节点（递归展平数组；字符串/数字变文本节点）。 */
export function append(parent: Node | null | undefined, children: DomChild): void {
  if (!parent) return;
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (const c of children) append(parent, c);
    return;
  }
  if (typeof children === 'string' || typeof children === 'number') {
    const doc = parent.nodeType === 9 ? (parent as Document) : (parent.ownerDocument ?? document);
    parent.appendChild(doc.createTextNode(String(children)));
    return;
  }
  parent.appendChild(children as Node);
}

/** 建 HTML 元素。`attrs.on*` 绑事件，`attrs.dataset` 展开 data-*。
 *  `select` 走本地 `SelectEl` / `TagMap`（见其注释）：这里的 `as unknown as` 是**受控断言**，
 *  只为绕开被 `worker-configuration.d.ts` 污染的 `HTMLElementTagNameMap['select']`，全模块仅此一处。 */
export function el<K extends keyof TagMap>(
  tag: K,
  attrs?: Attrs | null,
  children?: DomChild,
): TagMap[K] {
  const node = document.createElement(tag) as unknown as TagMap[K];
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

/** 建 SVG 元素（js/charts.js:9 的 `document.createElementNS` 口径）。 */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  children?: DomChild,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

/** querySelector（root 为空返回 null，省掉调用方的空判）。 */
export function qs<T extends Element = HTMLElement>(root: UiRoot | null | undefined, sel: string): T | null {
  if (!root) return null;
  return root.querySelector<T>(sel);
}

/** querySelectorAll → 真数组。 */
export function qsa<T extends Element = HTMLElement>(root: UiRoot | null | undefined, sel: string): T[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<T>(sel));
}

/** getElementById（旧 `$()`；id 不存在返回 null，与旧实现一致）。 */
export function byId<T extends HTMLElement = HTMLElement>(id: string, doc: Document = document): T | null {
  return doc.getElementById(id) as T | null;
}

/** 清空子树。 */
export function clear(node: Element | null | undefined): void {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 清空后写入新子树（幂等渲染的主力）。 */
export function replaceChildren(node: Element | null | undefined, children: DomChild): void {
  if (!node) return;
  clear(node);
  append(node, children);
}

/** 写文本（节点缺失静默跳过：面板可能不在当前页面）。 */
export function setText(node: Element | null | undefined, text: string): void {
  if (node) node.textContent = text;
}

/** class 开关；省略 on 即取反（对应旧 `classList.toggle`）。返回最终是否带该类。 */
export function toggleClass(node: Element | null | undefined, cls: string, on?: boolean): boolean {
  if (!node) return false;
  return on === undefined ? node.classList.toggle(cls) : node.classList.toggle(cls, on);
}

/** 显隐开关：`hidden` 属性与 `hidden` class **一起**切。
 *
 *  `index.html` 里被运行时开关的节点两种写法都有：浮层与对局按钮初始是 `class="hidden"`
 *  （`#expStopBtn`、`#speedRow`、`#pauseBtn`、`#promoBox` …），P6a 的侧栏面板按 `hidden` 属性。
 *  只切一种会让另一种永远停在初始态（`#expStopBtn`「停止实验」、机机模式的 `#speedRow`
 *  就是这么坏的），所以这里两种一起切——与 `src/app/panels.ts` 的 `setVisible` 同口径。 */
export function setHidden(node: Element | null | undefined, hidden: boolean): void {
  if (!node) return;
  node.classList.toggle('hidden', hidden);
  if (hidden) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}

/** 是否隐藏（等价 `el.hidden`，但对 SVG 也成立）。 */
export function isHidden(node: Element | null | undefined): boolean {
  return !!node && node.hasAttribute('hidden');
}

/** 无条件绑定事件（重建子树时用；节点是新的，不会叠加）。 */
export function on(
  node: EventTarget | null | undefined,
  type: string,
  fn: (ev: Event) => void,
): void {
  if (node) node.addEventListener(type, fn as EventListener);
}

const boundKeys = new WeakMap<EventTarget, Set<string>>();

/** 只绑一次（静态节点用；同节点同事件类型重复调用会被忽略）。 */
export function onOnce(
  node: EventTarget | null | undefined,
  type: string,
  fn: (ev: Event) => void,
): void {
  if (!node) return;
  let keys = boundKeys.get(node);
  if (!keys) {
    keys = new Set<string>();
    boundKeys.set(node, keys);
  }
  if (keys.has(type)) return;
  keys.add(type);
  node.addEventListener(type, fn as EventListener);
}

/* ---------- 展示层格式化（口径照搬旧实现，不做「顺手改进」） ---------- */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 旧 `PCT(v, d=0)`（js/app.js:1633）：0..1 → 百分数。非有限值给 `–`。 */
export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  return (v * 100).toFixed(digits) + '%';
}

/** 定点小数；非有限值给 `–`。 */
export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  return v.toFixed(digits);
}

/** 旧校准面板的 `SIGNED`（js/app.js:1634）：0..1 分数带正负号，正数补 `+`。 */
export function fmtSignedPct(v: number | null | undefined, digits = 0): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  return (v > 0 ? '+' : '') + (v * 100).toFixed(digits);
}

/** 旧 `fmtCost`（js/app.js:394-398）：0 → `$0`；极小值 → `<$0.00001`；否则 5 位小数。 */
export function fmtCost(c: number | null | undefined): string {
  const v = typeof c === 'number' && Number.isFinite(c) ? c : 0;
  if (!v) return '$0';
  if (v < 0.000005) return '<$0.00001';
  return '$' + v.toFixed(5);
}

/** 旧驾驶舱内联口径（js/app.js:1475）：≥1000 用 `x.xk`，否则原样。 */
export function fmtTokens(n: number | null | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
}

/** 旧战绩簿内联口径（js/app.js:1617）：`Nms` 或 `–`。 */
export function fmtLatency(ms: number | null | undefined): string {
  return ms ? Math.round(ms) + 'ms' : '–';
}

/** 旧 `fmtExpDate`（js/app.js:1300-1305）：`YYYY-MM-DD HH:mm`，不可解析给空串。 */
export function fmtDateTime(iso: string | null | undefined): string {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

/** 旧战绩簿时间列（js/app.js:1605-1606）：`M/D HH:mm`（月不补零）。 */
export function fmtClock(t: number | string | Date): string {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}
