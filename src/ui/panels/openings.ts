/* panels/openings.ts — 开具体验（前缀统计；计划 §7 P7 第 3 条；喂 `GET /api/openings?game=`）
 *
 * 职责边界：**presentational only**。不做网络请求、不读 localStorage、不 import `node:*`；
 * `rows` / `game` / `limit` 与三个 handlers 全部由调用方注入。`rows` 三态：
 *   `null` → 「加载中…」；`[]` → 「暂无数据」；非空 → 前缀行列表。
 *
 * 口径（与 `src/shared/record-map.ts` 一致）：
 *  - 前缀是**逗号连接的着法串**，字段名有 `prefix`（新）与 `opening_prefix`（旧）两种，都要认；
 *  - `black_win_rate` 服务端可能给 0..1 的比例，也可能给 0..100 的百分数，**两种都要显示正确**
 *    （>1 视为百分数，≤1 视为比例），最终一律走 `fmtPct`；
 *  - 棋种中文名映射复用 shared 层的纯函数 `gameIdToName`（它不碰 DOM/IO，可以安全 import）。
 *
 * 幂等策略（与 `record-book.ts` / `cockpit.ts` 一致）：**重建子树**；事件绑在新建节点上，
 * 重复 render 不叠加监听。
 *
 * DOM 契约：**不自造必须预先存在于 `index.html` 的容器**；一切都挂在 `props.root` 内部。
 */
import type { OpeningRow } from '../../core/api/client.ts';
import { gameIdToName } from '../../shared/record-map.ts';
import { clear, el, fmtPct, type DomChild, type SelectEl } from '../dom.ts';
import { fillSelect, type Opt } from './options.ts';

/** 棋种筛选的七个 id（`record-map.ts` 的 `GAME_IDS` 同序：五子棋 → 中国跳棋）。 */
export const GAME_IDS: readonly string[] = ['gomoku', 'gomoku-pro', 'go', 'xiangqi', 'chess', 'checkers', 'cc'];

/** 行数下拉的候选值。 */
export const LIMIT_OPTIONS: readonly number[] = [5, 10, 20, 50];

/** 行数缺省 / 非法值回落（旧式容错：任何非候选值一律回落它）。 */
export const LIMIT_DEFAULT = 10;

/** 前缀缺省占位。 */
const EMPTY_PREFIX = '（空）';

export interface OpeningHandlers {
  /** 点击/回车某一行（前缀原文，未加工） */
  onSelect?(prefix: string): void;
  /** 行数变化（已归一为 LIMIT_OPTIONS 之一） */
  onLimitChange?(limit: number): void;
  /** 棋种筛选变化（选项值来自 GAME_IDS） */
  onGameChange?(game: string): void;
}

export interface OpeningProps {
  /** 挂载点：由调用方传入 */
  root: HTMLElement;
  /** 三态：null = 加载中；[] = 暂无数据；非空 = 行列表 */
  rows: OpeningRow[] | null;
  /** 当前棋种（服务端一律带 `?game=`）；有值时显示棋种筛选 */
  game?: string | null;
  /** 当前行数上限；非法值回落 LIMIT_DEFAULT */
  limit?: number;
  handlers?: OpeningHandlers;
}

/** 非空字符串（数字也当有值），否则 null。 */
function textOf(v: unknown): string | null {
  if (v === null || v === undefined || v === false || v === '') return null;
  return String(v);
}

/** `misc` 字段取数：接受 number 与数字字符串，其它 → null。 */
function numOf(v: unknown): number | null {
  const s = textOf(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 前缀：`prefix ?? opening_prefix ?? '（空）'`（`''` 也算缺值 → 占位）。 */
export function prefixOf(row: OpeningRow): string {
  return textOf(row.prefix) ?? textOf(row.opening_prefix) ?? EMPTY_PREFIX;
}

/**
 * 黑方胜率归一到 0..1：**>1 视为百分数**（服务端给 47 = 47%），**≤1 视为比例**（0.47）。
 * 缺失/非数字 → null（显示 `–`，条宽 0）。
 */
export function blackWinRate(raw: unknown): number | null {
  const n = numOf(raw);
  if (n === null) return null;
  const v = n > 1 ? n / 100 : n;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 行数归一：候选表里没有的值（含 NaN/负数/0/空）一律回落 LIMIT_DEFAULT。 */
export function clampLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : numOf(value);
  return n !== null && LIMIT_OPTIONS.includes(n) ? n : LIMIT_DEFAULT;
}

/** 一行：前缀 | 场次 | 黑方胜率 + 胜率条。 */
function rowOf(row: OpeningRow, onPick: (prefix: string) => void): HTMLElement {
  const prefix = prefixOf(row);
  const games = numOf(row.games) ?? 0;
  const rate = blackWinRate(row.black_win_rate);
  return el(
    'div',
    {
      class: 'op-row',
      tabindex: '0',
      dataset: { prefix },
      onclick: () => onPick(prefix),
      onkeydown: (ev: Event) => {
        const key = (ev as KeyboardEvent).key;
        if (key !== 'Enter' && key !== ' ') return;
        ev.preventDefault();
        onPick(prefix);
      },
    },
    [
      el('span', { class: 'op-prefix mono', text: prefix, title: prefix }),
      el('span', { class: 'op-games mono', text: games + ' 场' }),
      el('span', { class: 'op-rate mono', text: fmtPct(rate) }),
      el('span', { class: 'op-bar' }, [el('i', { style: { width: Math.round((rate ?? 0) * 100) + '%' } })]),
    ],
  );
}

/** 表头（与 `.op-row` 的四列一一对应）。 */
function headRow(): HTMLElement {
  return el('div', { class: 'op-row op-head' }, [
    el('span', { class: 'op-prefix', text: '开局前缀' }),
    el('span', { class: 'op-games mono', text: '场次' }),
    el('span', { class: 'op-rate mono', text: '黑方胜率' }),
    el('span', { class: 'op-bar' }),
  ]);
}

/** 行数下拉（选项来自 LIMIT_OPTIONS，选中值已归一）。
 *
 *  选中值用 `options.ts` 的 `fillSelect()` 回填（与 settings/experiment 面板同一口径），
 *  **不**在 `el('option', {selected})` 上写：`applyAttrs` 对 `selected: false` 走的是
 *  「跳过」分支，单选下拉的初始选中态在 happy-dom 下不可靠。 */
function limitSelect(limit: number, onLimit: (limit: number) => void): HTMLElement {
  const sel = el('select', {
    class: 'op-limit',
    'aria-label': '显示行数',
    onchange: (ev: Event) => {
      const raw = (ev.target as SelectEl | null)?.value ?? '';
      onLimit(clampLimit(raw));
    },
  });
  fillSelect(sel, LIMIT_OPTIONS.map((n): Opt => [String(n), n + ' 条']), String(limit));
  return el('label', { class: 'op-field' }, [el('span', { class: 'op-k', text: '行数' }), sel]);
}

/** 棋种筛选（仅在 `props.game` 有值时出现）。 */
function gameSelect(game: string, onGame: (game: string) => void): HTMLElement {
  const sel = el('select', {
    class: 'op-game',
    'aria-label': '棋种筛选',
    onchange: (ev: Event) => {
      const v = (ev.target as SelectEl | null)?.value ?? '';
      if (v) onGame(v);
    },
  });
  fillSelect(sel, GAME_IDS.map((id): Opt => [id, gameIdToName(id)]), game);
  return el('label', { class: 'op-field' }, [el('span', { class: 'op-k', text: '棋种' }), sel]);
}

/** 开具体验整体渲染（幂等）。 */
export function renderOpenings(props: OpeningProps): void {
  const root = props.root;
  const handlers = props.handlers ?? {};
  const limit = clampLimit(props.limit);
  const game = textOf(props.game);

  root.className = 'op';
  clear(root);

  const tools: DomChild[] = [limitSelect(limit, (n) => handlers.onLimitChange?.(n))];
  if (game) tools.push(gameSelect(game, (g) => handlers.onGameChange?.(g)));

  const body: DomChild[] = [];
  if (props.rows === null) {
    body.push(el('div', { class: 'op-empty', text: '加载中…' }));
  } else if (!props.rows.length) {
    body.push(el('div', { class: 'op-empty', text: '暂无数据' }));
  } else {
    body.push(headRow());
    body.push(...props.rows.map((row) => rowOf(row, (p) => handlers.onSelect?.(p))));
  }

  root.appendChild(el('div', { class: 'op-panel' }, [el('div', { class: 'op-toolbar' }, tools), ...body]));
}
