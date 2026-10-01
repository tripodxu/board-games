/* record-book.spec.ts — 战绩簿的运行时断言
 *
 * 覆盖 `renderRecords()` / `renderRecordStats()` / `recordRow()` / `recordHeader()` /
 * `computeStats()` / `createRecordStore()` / `bindClearRecords()`（旧 js/app.js:1543-1624 的
 * `loadRecords/saveGameRecord/renderRecords`）。
 *
 * 断言方式：渲染后查 DOM（统计块、行结构、单元格文案、摘要）与行为（store 落盘/去重/上限/清空、
 * 清空按钮回调次数），不做源码字符串匹配。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  RECORDS_KEY,
  RECORDS_MAX,
  RECORDS_ROWS,
  bindClearRecords,
  computeStats,
  createRecordStore,
  recordHeader,
  recordRow,
  renderRecords,
  type GameRecord,
} from '../../src/ui/panels/record-book.ts';
import { cleanup, click, memStorage, mount, need } from './helpers.ts';

const HTML = `
  <div id="recordStats"></div>
  <div id="records"></div>
  <div id="recordSummary"></div>
  <button id="clearRecords" type="button">清空</button>
`;

/* 用本地时间构造时间戳：`.rec-time` 走 getMonth/getDate/getHours，用 UTC 会和时区耦合 */
const R1: GameRecord = {
  id: 'g1', t: new Date(2026, 8, 29, 11, 5).getTime(), game: '五子棋 禁手', mode: '人机',
  winner: '黑胜', firstWin: true, moves: 31, avgLat: 812, cost: 0.00123, duel: 'Jev vs Rapfi',
};
const R2: GameRecord = {
  id: 'g2', t: new Date(2026, 8, 29, 12, 6).getTime(), game: '五子棋', mode: '机机',
  winner: '和棋', firstWin: null, moves: 225, avgLat: 0, cost: 0, endBy: 'human',
};
const R3: GameRecord = {
  id: 'g3', t: new Date(2026, 8, 30, 5, 7).getTime(), game: '围棋', mode: '人机',
  winner: '白胜', firstWin: false, moves: 120, avgLat: 1000, cost: 0.5, reason: '认输',
};

function dataRows(body: HTMLElement): HTMLElement[] {
  return Array.from(body.querySelectorAll<HTMLElement>('#records .rec-row')).slice(1);
}

function metas(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('.rec-meta')).map((n) => n.textContent ?? '');
}

afterEach(cleanup);

describe('renderRecords —— 空态与非空态', () => {
  it('空态写提示、清空列表、摘要回默认', () => {
    const body = mount(HTML);
    renderRecords({ records: [] }, body);

    const stats = need(body.querySelector('#recordStats'));
    expect(stats.querySelectorAll('.rs').length).toBe(0);
    expect(need(stats.querySelector('.feed-empty')).textContent).toBe('还没有历史对局，打完一局自动记账。');
    expect(need(body.querySelector('#records')).children.length).toBe(0);
    expect(need(body.querySelector('#recordSummary')).textContent).toBe('本机历史对局');
  });

  it('非空态：表头 + 最近局倒序 + 五个统计块 + 摘要', () => {
    const body = mount(HTML);
    renderRecords({ records: [R1, R2, R3] }, body);

    const head = need(body.querySelector('#records .rec-head'));
    expect(head.children.length).toBe(7);
    expect(Array.from(head.children).map((c) => c.textContent)).toEqual([
      '时间', '棋种', '模式', '胜方', '手数', '延迟', '花费',
    ]);

    const rows = dataRows(body);
    expect(rows.length).toBe(3);
    expect(recordHeader().children.length).toBe(7);
    rows.forEach((row) => expect(row.children.length).toBe(7));

    /* 倒序：最新的 R3 在最上 */
    expect(need(rows[0]!.querySelector('.rec-game')).textContent).toBe('围棋');
    expect(need(rows[2]!.querySelector('.rec-game')).textContent).toContain('五子棋禁手');

    const stats = Array.from(body.querySelectorAll<HTMLElement>('#recordStats .rs'));
    expect(stats.length).toBe(5);
    expect(stats.map((s) => s.querySelector('b')!.textContent)).toEqual(['3', '2', '50%', '$0.5012', '906ms']);
    expect(stats.map((s) => s.querySelector('span')!.textContent)).toEqual([
      '总局', '分胜负', '先手胜率', '累计花费', '均延迟',
    ]);

    expect(need(body.querySelector('#recordSummary')).textContent).toBe('本机最近 3 局');
  });

  it('每行七格的口径：时间/棋种+duel/模式/胜方补注/手数/延迟/花费', () => {
    const body = mount(HTML);
    renderRecords({ records: [R1, R2, R3] }, body);
    const rows = dataRows(body);
    const [latest, draw, oldest] = [rows[0]!, rows[1]!, rows[2]!];

    /* R3：认输不补注 */
    expect(need(latest.querySelector('.rec-time')).textContent).toBe('9/30 05:07');
    expect(need(latest.querySelector('.rec-mode')).textContent).toBe('人机');
    expect(need(latest.querySelector('.rec-winner')).textContent).toBe('白胜');
    expect(latest.querySelector('.rec-winner i')).toBeNull();
    expect(metas(latest)).toEqual(['120手', '1000ms', '$0.50000']);

    /* R2：和棋 → .draw；endBy=human 且无 reason → 「人判」；延迟/花费无值 → '–' */
    expect(draw.classList.contains('draw')).toBe(true);
    const drawWinner = need(draw.querySelector('.rec-winner'));
    expect(drawWinner.textContent).toContain('和棋');
    expect(need(drawWinner.querySelector('i')).textContent).toBe('人判');
    expect(need(draw.querySelector('.rec-time')).textContent).toBe('9/29 12:06');
    expect(metas(draw)).toEqual(['225手', '–', '–']);

    /* R1：有 duel → `.rec-game` 内补 <i>；延迟/花费有值 */
    expect(oldest.classList.contains('draw')).toBe(false);
    expect(need(oldest.querySelector('.rec-time')).textContent).toBe('9/29 11:05');
    const duel = need(oldest.querySelector('.rec-game i'));
    expect(duel.textContent).toBe('Jev vs Rapfi');
    expect(duel.getAttribute('title')).toBe('Jev vs Rapfi');
    expect(metas(oldest)).toEqual(['31手', '812ms', '$0.00123']);
  });

  it('只渲染最近 RECORDS_ROWS 局，且重复 render 不叠行', () => {
    const body = mount(HTML);
    const many: GameRecord[] = Array.from({ length: 14 }, (_, i) => ({
      id: 'g' + i, t: new Date(2026, 8, 1, 0, i).getTime(), game: '五子棋', mode: '人机',
      winner: '黑胜', firstWin: true, moves: i, avgLat: 100, cost: 0,
    }));
    renderRecords({ records: many }, body);
    expect(RECORDS_ROWS).toBe(12);
    const rows = dataRows(body);
    expect(rows.length).toBe(RECORDS_ROWS);
    expect(need(rows[0]!.querySelector('.rec-game')).textContent).toBe('五子棋');
    expect(metas(rows[0]!)[0]).toBe('13手');
    expect(metas(rows[RECORDS_ROWS - 1]!)[0]).toBe('2手');

    renderRecords({ records: many }, body);
    expect(dataRows(body).length).toBe(RECORDS_ROWS);
    expect(body.querySelectorAll('#records .rec-head').length).toBe(1);
  });

  it('recordRow / computeStats 是纯函数（可直接调用）', () => {
    const row = recordRow({ ...R1, reason: '五连' });
    expect(row.children.length).toBe(7);
    expect(need(row.querySelector('.rec-winner i')).textContent).toBe('五连');
    expect(computeStats([R1, R2, R3])).toEqual({
      total: 3, decided: 2, firstWinRate: 0.5, cost: 0.50123, avgLat: 906,
    });
    expect(computeStats([])).toEqual({ total: 0, decided: 0, firstWinRate: null, cost: 0, avgLat: null });
  });
});

describe('createRecordStore —— 落盘口径', () => {
  it('save 同 id 覆盖、按 RECORDS_MAX 截断、clear 清空', () => {
    const mem = memStorage();
    const store = createRecordStore(mem);
    expect(store.all()).toEqual([]);

    store.save(R1);
    store.save(R1);
    expect(store.all().length).toBe(1);
    store.save({ ...R1, winner: '和棋' });
    expect(store.all().length).toBe(1);
    expect(store.all()[0]!.winner).toBe('和棋');
    expect(JSON.parse(need(mem.map.get(RECORDS_KEY)))[0].id).toBe('g1');

    for (let i = 0; i < RECORDS_MAX + 1; i++) {
      store.save({ id: 'n' + i, t: i, game: '五子棋', winner: '黑胜' });
    }
    const all = store.all();
    expect(all.length).toBe(RECORDS_MAX);
    expect(all.some((r) => r.id === 'g1')).toBe(false);
    expect(all.length).toBeLessThanOrEqual(RECORDS_MAX);

    store.clear();
    expect(store.all()).toEqual([]);
    expect(mem.map.has(RECORDS_KEY)).toBe(false);
  });

  it('存储损坏或非数组时按空账本处理', () => {
    expect(createRecordStore(memStorage({ [RECORDS_KEY]: '{oops' })).all()).toEqual([]);
    expect(createRecordStore(memStorage({ [RECORDS_KEY]: '{"a":1}' })).all()).toEqual([]);
    expect(createRecordStore(memStorage({ [RECORDS_KEY]: JSON.stringify([R1]) })).all().length).toBe(1);
  });

  it('bindClearRecords 只绑一次（两次点击 = 两次回调）', () => {
    const body = mount(HTML);
    let calls = 0;
    bindClearRecords(() => calls++, body);
    bindClearRecords(() => calls++, body);
    click(need(body.querySelector('#clearRecords')));
    click(need(body.querySelector('#clearRecords')));
    expect(calls).toBe(2);
  });
});
