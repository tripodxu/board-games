/* leaderboard.spec.ts — 排行榜的运行时断言
 *
 * 断言方式：渲染后查真实 DOM、派发真实事件（click/keydown），不做源码字符串匹配。
 * 重点覆盖：三态（加载中/空/非空）、排序口径与**不改入参**、胜率两种量纲、点击与回车回调参数、
 * 重复 render 的幂等（不翻倍/不重复触发）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LeaderboardRow } from '../../src/core/api/client.ts';
import {
  renderLeaderboard,
  sortLeaderboard,
  winRateOf,
} from '../../src/ui/panels/leaderboard.ts';
import { cleanup, click, keydown, mount, need } from './helpers.ts';

const R_A: LeaderboardRow = { channel: 'proxy', tactics: 'v3', wins: 30, games: 60, win_rate: 0.5 };
const R_B: LeaderboardRow = { channel: 'rapfi', tactics: 'v1', wins: 8, games: 20, win_rate: 0.4 };
/** 无档位 + 胜率由 wins/games 现算（量纲 = 百分数分支在其它用例覆盖） */
const R_C: LeaderboardRow = { channel: 'mock', wins: 3, games: 20 };
/** 服务端直接给百分数（0–100 量纲） */
const R_D: LeaderboardRow = { channel: 'official', tactics: 'v2', wins: 5, games: 10, win_rate: 47 };
const ALL = [R_B, R_A, R_C, R_D];

/* 挂载点：面板会覆写 root.className，所以用 mount() 自己造宿主 div 并把它的返回值当 root。 */
let HOST: HTMLElement;

function rootOf(): HTMLElement {
  if (!HOST || !HOST.isConnected) HOST = mount('');
  return HOST;
}

function rows(): HTMLElement[] {
  return Array.from(rootOf().querySelectorAll<HTMLElement>('.lb-row'));
}

function dataRows(): HTMLElement[] {
  return Array.from(rootOf().querySelectorAll<HTMLElement>('.lb-row:not(.lb-head)'));
}

function cell(row: HTMLElement, cls: string): string {
  return need(row.querySelector('.' + cls)).textContent ?? '';
}

afterEach(cleanup);

describe('renderLeaderboard —— 三态', () => {
  it('rows=null → 加载中…（没有表头与行）', () => {
    renderLeaderboard({ root: rootOf(), rows: null });
    expect(need(rootOf().querySelector('.lb-empty')).textContent).toBe('加载中…');
    expect(rows().length).toBe(0);
  });

  it('rows=[] → 暂无数据', () => {
    renderLeaderboard({ root: rootOf(), rows: [] });
    expect(need(rootOf().querySelector('.lb-empty')).textContent).toBe('暂无数据');
    expect(rows().length).toBe(0);
  });

  it('非空 → 表头 + 四行；五列结构对齐', () => {
    renderLeaderboard({ root: rootOf(), rows: ALL });
    expect(need(rootOf().querySelector('.lb-head'))).toBe(rows()[0]);
    expect(rows().length).toBe(5);
    expect(rows().map((r) => r.children.length)).toEqual([5, 5, 5, 5, 5]);
    dataRows().forEach((r) => {
      expect(r.getAttribute('tabindex')).toBe('0');
      expect(need(r.querySelector('.lb-bar i')).getAttribute('style')).toMatch(/^width:\d+%$/);
    });
  });
});

describe('renderLeaderboard —— 排序口径', () => {
  it('games 降序，同场次按 win_rate 降序', () => {
    renderLeaderboard({ root: rootOf(), rows: ALL });
    /* ALL = [rapfi 20/0.4, proxy 60/0.5, mock 20/0.15, official 10/0.47]
     * → games 降序 [proxy 60] → 同场次 20 的两行按胜率 [rapfi 0.4] → [mock 0.15] → [official 10] */
    expect(dataRows().map((r) => cell(r, 'lb-channel'))).toEqual(['proxy', 'rapfi', 'mock', 'official']);
    expect(dataRows().map((r) => cell(r, 'lb-record'))).toEqual(['30/60', '8/20', '3/20', '5/10']);
    expect(dataRows().map((r) => cell(r, 'lb-rate'))).toEqual(['50%', '40%', '15%', '47%']);
  });

  it('sortLeaderboard 不改入参，返回新数组', () => {
    const input = [...ALL];
    const snapshot = input.map((r) => r.channel);
    const out = sortLeaderboard(input);

    expect(input.map((r) => r.channel)).toEqual(snapshot);
    expect(input[0]).toBe(R_B);
    expect(out).not.toBe(input);
    expect(out.map((r) => r.channel)).toEqual(['proxy', 'rapfi', 'mock', 'official']);

    /* 极端入参也要稳定：缺 games / 非数字 games 不抛异常 */
    expect(sortLeaderboard([])).toEqual([]);
    expect(sortLeaderboard([{ channel: 'x' }, { channel: 'y', games: 1 }]).map((r) => r.channel)).toEqual(['y', 'x']);
  });
});

describe('renderLeaderboard —— 胜率两种量纲', () => {
  it('0.5 与 47(=47%) 都显示正确', () => {
    expect(winRateOf(R_A)).toBe(0.5);
    expect(winRateOf(R_D)).toBeCloseTo(0.47, 10);
    renderLeaderboard({ root: rootOf(), rows: [R_A, R_D] });
    expect(dataRows().map((r) => cell(r, 'lb-rate'))).toEqual(['50%', '47%']);
    expect(dataRows().map((r) => need(r.querySelector('.lb-bar i')).getAttribute('style')))
      .toEqual(['width:50%', 'width:47%']);
  });

  it('win_rate 缺失时用 wins/games 现算；档位缺省显示 —', () => {
    renderLeaderboard({ root: rootOf(), rows: [R_C] });
    const row = dataRows()[0]!;
    expect(cell(row, 'lb-rate')).toBe('15%');
    expect(cell(row, 'lb-tactics')).toBe('—');
    expect(need(row.querySelector('.lb-bar i')).getAttribute('style')).toBe('width:15%');
  });

  it('胜率缺数据 → – 与 width:0%（不抛异常）', () => {
    renderLeaderboard({ root: rootOf(), rows: [{ channel: 'ghost' }, { channel: 'zero', wins: 1, games: 0 }] });
    expect(dataRows().map((r) => cell(r, 'lb-rate'))).toEqual(['–', '–']);
    expect(need(dataRows()[0]!.querySelector('.lb-bar i')).getAttribute('style')).toBe('width:0%');
    expect(winRateOf({ channel: 'zero', wins: 1, games: 0 })).toBeNull();
  });
});

describe('renderLeaderboard —— 选中回调', () => {
  it('点击与回车都触发 onSelect，参数是行的两个字段', () => {
    const seen: { channel?: string; tactics?: string }[] = [];
    renderLeaderboard({ root: rootOf(), rows: ALL, handlers: { onSelect: (row) => seen.push(row) } });

    click(dataRows()[0]);
    expect(seen).toEqual([{ channel: 'proxy', tactics: 'v3' }]);

    /* 排序后的第 3 行是 mock（无 tactics 字段）→ onSelect 收到 undefined */
    keydown(dataRows()[2], 'Enter');
    expect(seen[1]).toEqual({ channel: 'mock', tactics: undefined });

    /* 空格同样算激活；其它键不算 */
    keydown(dataRows()[1], ' ');
    keydown(dataRows()[1], 'a');
    expect(seen.length).toBe(3);
    expect(seen[2]).toEqual({ channel: 'rapfi', tactics: 'v1' });
  });
});

describe('renderLeaderboard —— 幂等', () => {
  it('连渲两次：DOM 不翻倍、监听不重复触发', () => {
    const seen: { channel?: string }[] = [];
    const props = { root: rootOf(), rows: ALL, handlers: { onSelect: (row: { channel?: string }) => seen.push(row) } };
    renderLeaderboard(props);
    renderLeaderboard(props);

    expect(rootOf().querySelectorAll('.lb-panel').length).toBe(1);
    expect(rootOf().querySelectorAll('.lb-head').length).toBe(1);
    expect(rows().length).toBe(5);

    click(dataRows()[0]);
    expect(seen.length).toBe(1);

    /* 换一份数据再渲，仍然只有一份结构 */
    renderLeaderboard({ root: rootOf(), rows: [R_C] });
    expect(rows().length).toBe(2);
    expect(dataRows().length).toBe(1);
    expect(rootOf().querySelectorAll('.lb-empty').length).toBe(0);
  });
});
