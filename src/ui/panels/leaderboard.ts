/* panels/leaderboard.ts — 排行榜（计划 §7 P7 第 2 条；喂 `GET /api/leaderboard`）
 *
 * 职责边界：**presentational only**。不做网络请求、不读 localStorage、不 import `node:*`；
 * 数据（`rows`）与事件（`handlers`）全部由调用方注入。空态与加载态由 `rows` 的三态表达：
 *   `null` → 「加载中…」；`[]` → 「暂无数据」；非空 → 行列表。
 *
 * 幂等策略（与 `record-book.ts` / `cockpit.ts` 一致）：**重建子树**。每次 render（连同 `onSelect`
 * 变化）都 `clear(props.root)` 后重建，事件用 `on()` 绑在新建节点上，重复 render 不叠加监听。
 *
 * DOM 契约：**不自造必须预先存在于 `index.html` 的容器**；一切都挂在 `props.root` 内部。
 */
import type { LeaderboardRow } from '../../core/api/client.ts';
import { clear, el, fmtPct, type DomChild } from '../dom.ts';

export interface LeaderboardHandlers {
  /** 点击/回车某一行（参数是原始行的两个字段，不做加工） */
  onSelect?(row: { channel?: string; tactics?: string }): void;
}

export interface LeaderboardProps {
  /** 挂载点：由调用方传入 */
  root: HTMLElement;
  /** 三态：null = 加载中；[] = 暂无数据；非空 = 行列表 */
  rows: LeaderboardRow[] | null;
  handlers?: LeaderboardHandlers;
}

/** 档位缺省占位。 */
const NO_TACTICS = '—';

/** 非空字符串（数字也当有值），否则 null。 */
function textOf(v: unknown): string | null {
  if (v === null || v === undefined || v === false || v === '') return null;
  return String(v);
}

/** 服务端字段是 `misc`：数字可能缺失/是字符串（D1 直出的 SUM 在个别驱动下是字符串）。 */
function numOf(v: unknown): number | null {
  const s = textOf(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 胜率归一到 0..1。
 *
 * 两种量纲都认：**>1 视为百分数**（服务端直接给 47 表示 47%），**≤1 视为比例**（0.47）。
 * 行内 `win_rate` 优先；缺失时用 `wins / games` 现算。都拿不到 → null（显示 `–`，条宽 0）。
 */
export function winRateOf(row: LeaderboardRow): number | null {
  const raw = numOf(row.win_rate);
  if (raw !== null) {
    const v = raw > 1 ? raw / 100 : raw;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  const wins = numOf(row.wins);
  const games = numOf(row.games);
  if (wins === null || !games || games <= 0) return null;
  const v = wins / games;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 胜率条的百分比宽度（0..100 的整数）；无数据 0。 */
function barWidthPct(rate: number | null): number {
  return Math.round((rate ?? 0) * 100);
}

/**
 * 排序：`games` 降序 → 同场次按 `win_rate` 降序（缺值当 -1，排在有值之后）。
 *
 * **不就地修改传入数组**（`[...rows]` 先复制）；`Array.prototype.sort` 自 ES2019 起稳定，
 * 因此全等行保留注入顺序。
 */
export function sortLeaderboard(rows: readonly LeaderboardRow[]): LeaderboardRow[] {
  return [...rows].sort((a, b) => {
    const ga = numOf(a.games) ?? -1;
    const gb = numOf(b.games) ?? -1;
    if (ga !== gb) return gb - ga;
    return (winRateOf(b) ?? -1) - (winRateOf(a) ?? -1);
  });
}

/** 一行：渠道 | 档位 | 胜/总 | 胜率 + 胜率条。 */
function rowOf(row: LeaderboardRow, onPick: (row: LeaderboardRow) => void): HTMLElement {
  const channel = textOf(row.channel);
  const tactics = textOf(row.tactics);
  const rate = winRateOf(row);
  const games = numOf(row.games);
  const wins = numOf(row.wins);
  const line = el(
    'div',
    {
      class: 'lb-row',
      tabindex: '0',
      dataset: { channel: channel ?? '', tactics: tactics ?? '' },
      onclick: () => onPick(row),
      onkeydown: (ev: Event) => {
        const key = (ev as KeyboardEvent).key;
        if (key !== 'Enter' && key !== ' ') return;
        ev.preventDefault();
        onPick(row);
      },
    },
    [
      el('span', { class: 'lb-channel', text: channel ?? '未知渠道' }),
      el('span', { class: 'lb-tactics', text: tactics ?? NO_TACTICS }),
      el('span', { class: 'lb-record mono', text: (wins ?? 0) + '/' + (games ?? 0) }),
      el('span', { class: 'lb-rate mono', text: fmtPct(rate) }),
      el('span', { class: 'lb-bar' }, [el('i', { style: { width: barWidthPct(rate) + '%' } })]),
    ],
  );
  return line;
}

/** 表头（与 `.lb-row` 的五列一一对应，保证 grid 模板不会错位）。 */
function headRow(): HTMLElement {
  return el('div', { class: 'lb-row lb-head' }, [
    el('span', { class: 'lb-channel', text: '渠道' }),
    el('span', { class: 'lb-tactics', text: '档位' }),
    el('span', { class: 'lb-record mono', text: '胜/总' }),
    el('span', { class: 'lb-rate mono', text: '胜率' }),
    el('span', { class: 'lb-bar' }),
  ]);
}

function emptyState(text: string): HTMLElement {
  return el('div', { class: 'lb-empty', text });
}

/** 排行榜整体渲染（幂等）。 */
export function renderLeaderboard(props: LeaderboardProps): void {
  const root = props.root;
  const onSelect = props.handlers?.onSelect;
  root.className = 'lb';
  clear(root);

  const rows: DomChild[] = [];
  if (props.rows === null) {
    rows.push(emptyState('加载中…'));
  } else if (!props.rows.length) {
    rows.push(emptyState('暂无数据'));
  } else {
    const sorted = sortLeaderboard(props.rows);
    rows.push(headRow());
    rows.push(
      ...sorted.map((row) =>
        rowOf(row, (r) => onSelect?.({ channel: textOf(r.channel) ?? undefined, tactics: textOf(r.tactics) ?? undefined })),
      ),
    );
  }

  root.appendChild(el('div', { class: 'lb-panel' }, rows));
}
