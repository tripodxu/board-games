/* openings.spec.ts — 开具体验（前缀统计）的运行时断言
 *
 * 断言方式：渲染后查真实 DOM、派发真实事件（click/keydown/change），不做源码字符串匹配。
 * 重点覆盖：三态（加载中/空/非空）、前缀字段回落、black_win_rate 两种量纲、行数归一（非法值回落 10）、
 * 棋种筛选的有无与选项、点击/回车回调参数、重复 render 的幂等（不翻倍/不重复触发）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpeningRow } from '../../src/core/api/client.ts';
import type { SelectEl } from '../../src/ui/dom.ts';
import {
  GAME_IDS,
  LIMIT_DEFAULT,
  LIMIT_OPTIONS,
  blackWinRate,
  clampLimit,
  prefixOf,
  renderOpenings,
} from '../../src/ui/panels/openings.ts';
import { cleanup, click, keydown, mount, need, select } from './helpers.ts';

/** 新字段 prefix，胜率是 0–1 比例 */
const O_RATIO: OpeningRow = { prefix: 'H8,I9,G7', games: 12, black_win_rate: 0.5 };
/** 旧字段 opening_prefix，胜率是 0–100 百分数 */
const O_PCT: OpeningRow = { opening_prefix: 'H8,I9', games: 4, black_win_rate: 75 };
/** 两个字段都缺 → 占位；胜率缺 → – */
const O_EMPTY: OpeningRow = { games: 1 };
const ALL = [O_PCT, O_EMPTY, O_RATIO];

/* 挂载点：面板会覆写 root.className，所以用 mount() 自己造宿主 div 并把它的返回值当 root。 */
let HOST: HTMLElement;

function rootOf(): HTMLElement {
  if (!HOST || !HOST.isConnected) HOST = mount('');
  return HOST;
}

function rows(): HTMLElement[] {
  return Array.from(rootOf().querySelectorAll<HTMLElement>('.op-row:not(.op-head)'));
}

/* 下拉元素用 dom.ts 的 `SelectEl` 而不是 `HTMLSelectElement`：仓库里
 * `worker-configuration.d.ts` 会污染 DOM 全局类型，`HTMLSelectElement` 与 `Element` 已经不兼容
 * （`remove()` 的返回类型冲突），`querySelector<HTMLSelectElement>` 会直接报 TS2344。 */
function limitSel(): SelectEl {
  return need(rootOf().querySelector<HTMLElement>('.op-limit')) as SelectEl;
}

function gameSel(): SelectEl {
  return need(rootOf().querySelector<HTMLElement>('.op-game')) as SelectEl;
}

function cell(row: HTMLElement, cls: string): string {
  return need(row.querySelector('.' + cls)).textContent ?? '';
}

afterEach(cleanup);

describe('renderOpenings —— 三态', () => {
  it('rows=null → 加载中…；rows=[] → 暂无数据', () => {
    renderOpenings({ root: rootOf(), rows: null });
    expect(need(rootOf().querySelector('.op-empty')).textContent).toBe('加载中…');
    expect(rows().length).toBe(0);

    renderOpenings({ root: rootOf(), rows: [] });
    expect(need(rootOf().querySelector('.op-empty')).textContent).toBe('暂无数据');
    expect(rootOf().querySelectorAll('.op-empty').length).toBe(1);
    expect(rows().length).toBe(0);
  });

  it('非空 → 表头 + 三行，四列结构对齐', () => {
    renderOpenings({ root: rootOf(), rows: ALL });
    expect(need(rootOf().querySelector('.op-head'))).toBe(rootOf().querySelectorAll('.op-row')[0]);
    expect(rows().length).toBe(3);
    rows().forEach((r) => {
      expect(r.children.length).toBe(4);
      expect(r.getAttribute('tabindex')).toBe('0');
      expect(need(r.querySelector('.op-bar i')).getAttribute('style')).toMatch(/^width:\d+%$/);
    });
  });
});

describe('renderOpenings —— 行文本与前缀回落', () => {
  it('prefix ?? opening_prefix ?? （空）', () => {
    renderOpenings({ root: rootOf(), rows: ALL });
    expect(rows().map((r) => cell(r, 'op-prefix'))).toEqual(['H8,I9', '（空）', 'H8,I9,G7']);
    expect(rows().map((r) => cell(r, 'op-games'))).toEqual(['4 场', '1 场', '12 场']);
    expect(prefixOf({ prefix: '', opening_prefix: 'A1' })).toBe('A1');
    expect(prefixOf({})).toBe('（空）');
  });
});

describe('renderOpenings —— 黑方胜率两种量纲', () => {
  it('0.5 与 75(=75%) 都显示正确（含条宽）', () => {
    expect(blackWinRate(0.5)).toBe(0.5);
    expect(blackWinRate(75)).toBeCloseTo(0.75, 10);
    renderOpenings({ root: rootOf(), rows: ALL });
    expect(rows().map((r) => cell(r, 'op-rate'))).toEqual(['75%', '–', '50%']);
    expect(rows().map((r) => need(r.querySelector('.op-bar i')).getAttribute('style')))
      .toEqual(['width:75%', 'width:0%', 'width:50%']);
  });

  it('越界与非法值被夹住，不抛异常', () => {
    expect(blackWinRate(-1)).toBe(0);
    expect(blackWinRate(500)).toBe(1);
    expect(blackWinRate(undefined)).toBeNull();
    expect(blackWinRate('abc')).toBeNull();
    /* 数字字符串也认（D1 个别驱动把聚合值出成字符串） */
    expect(blackWinRate('25')).toBe(0.25);
  });
});

describe('renderOpenings —— 行数下拉', () => {
  it('四个候选值，非法/空值回落 LIMIT_DEFAULT', () => {
    renderOpenings({ root: rootOf(), rows: ALL, limit: 20 });
    const opts = Array.from(limitSel().querySelectorAll('option'));
    expect(opts.map((o) => o.getAttribute('value'))).toEqual(LIMIT_OPTIONS.map(String));
    expect(limitSel().value).toBe('20');
    expect(LIMIT_DEFAULT).toBe(10);
    expect(clampLimit('7')).toBe(10);
    expect(clampLimit('')).toBe(10);
    expect(clampLimit(0)).toBe(10);
    expect(clampLimit('-5')).toBe(10);
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(50)).toBe(50);

    renderOpenings({ root: rootOf(), rows: ALL, limit: 7 });
    expect(limitSel().value).toBe('10');
  });

  it('change 出参已归一（选 7 不存在 → 回调收 10）', () => {
    const seen: number[] = [];
    renderOpenings({ root: rootOf(), rows: ALL, handlers: { onLimitChange: (n) => seen.push(n) } });
    select(limitSel(), '5');
    expect(seen).toEqual([5]);
    select(limitSel(), '7');
    expect(seen).toEqual([5, 10]);
  });
});

describe('renderOpenings —— 棋种筛选', () => {
  it('game 有值时出现，选项是七个棋种 id + 中文名', () => {
    renderOpenings({ root: rootOf(), rows: ALL, game: 'xiangqi' });
    const sel = gameSel();
    expect(Array.from(sel.querySelectorAll('option')).map((o) => o.getAttribute('value'))).toEqual([...GAME_IDS]);
    expect(Array.from(sel.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      '五子棋', '五子棋·禁手', '围棋', '象棋', '国际象棋', '西洋跳棋', '中国跳棋',
    ]);
    expect(sel.value).toBe('xiangqi');

    renderOpenings({ root: rootOf(), rows: ALL });
    expect(rootOf().querySelector('.op-game')).toBeNull();
  });

  it('change → onGameChange(棋种 id)', () => {
    const seen: string[] = [];
    renderOpenings({ root: rootOf(), rows: ALL, game: 'gomoku', handlers: { onGameChange: (g) => seen.push(g) } });
    select(gameSel(), 'cc');
    expect(seen).toEqual(['cc']);
  });
});

describe('renderOpenings —— 选中回调', () => {
  it('点击与回车都触发 onSelect(前缀原文)', () => {
    const seen: string[] = [];
    renderOpenings({ root: rootOf(), rows: ALL, handlers: { onSelect: (p) => seen.push(p) } });

    click(rows()[0]);
    expect(seen).toEqual(['H8,I9']);
    keydown(rows()[2], 'Enter');
    expect(seen).toEqual(['H8,I9', 'H8,I9,G7']);
    keydown(rows()[1], ' ');
    expect(seen).toEqual(['H8,I9', 'H8,I9,G7', '（空）']);
    keydown(rows()[1], 'a');
    expect(seen.length).toBe(3);
  });
});

describe('renderOpenings —— 幂等', () => {
  it('连渲两次：DOM 不翻倍、监听不重复触发', () => {
    const seen: string[] = [];
    const props = { root: rootOf(), rows: ALL, game: 'gomoku', limit: 5, handlers: { onSelect: (p: string) => seen.push(p) } };
    renderOpenings(props);
    renderOpenings(props);

    expect(rootOf().querySelectorAll('.op-panel').length).toBe(1);
    expect(rootOf().querySelectorAll('.op-head').length).toBe(1);
    expect(rootOf().querySelectorAll('.op-row').length).toBe(4);
    expect(rootOf().querySelectorAll('.op-limit').length).toBe(1);
    expect(rootOf().querySelectorAll('.op-game').length).toBe(1);
    expect(limitSel().value).toBe('5');

    click(rows()[0]);
    expect(seen.length).toBe(1);

    /* 换成空态再渲：旧结构被清干净 */
    renderOpenings({ root: rootOf(), rows: [] });
    expect(rootOf().querySelectorAll('.op-row').length).toBe(0);
    expect(need(rootOf().querySelector('.op-empty')).textContent).toBe('暂无数据');
  });
});
