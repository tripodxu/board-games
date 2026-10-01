/* experiment-report.spec.ts — 实验报告面板的对比口径（本次优化新增的部分）
 *
 * 覆盖 `expSideStats()` / `roundScore()` / `gameSide()` / `pct()` / `expAggregate()` 与
 * `renderExpHistory()` 的渲染结果。核心场景：**两侧都是 Jev 渠道、只有战术版本不同**
 * （`v8 vs v9`）——旧 `expTotals()` 的「Jev 渠道 / 其他」两桶会把双方合并成
 * 「Jev 3 胜 · 其他 0 胜」，本 spec 的第一条用例就把这个对照钉住。
 *
 * 断言方式：渲染后查 DOM（行数、data-key、数字格、条宽、注脚文案），不做源码字符串匹配。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  expAggregate,
  expSideStats,
  expTotals,
  gameSide,
  pct,
  renderExpHistory,
  roundScore,
  type ExperimentEntry,
} from '../../src/ui/panels/experiment-report.ts';
import { cleanup, mount, need } from './helpers.ts';

afterEach(cleanup);

/** 两侧同为 Jev(代理)、只有战术版本不同的 4 局：奇数局 A 执黑，偶数局 A 执白。 */
const JEV_V8_VS_V9: ExperimentEntry = {
  tag: 'exp-v8-v9',
  date: '2026-10-01T10:00:00.000Z',
  chanA: 'proxy',
  chanB: 'proxy',
  tacA: 'v8',
  tacB: 'v9',
  total: 4,
  note: '同一渠道两个战术版本对比',
  games: [
    { no: 1, blackChan: 'proxy', whiteChan: 'proxy', blackTac: 'v8', whiteTac: 'v9', winnerChan: 'A' },
    { no: 2, blackChan: 'proxy', whiteChan: 'proxy', blackTac: 'v9', whiteTac: 'v8', winnerChan: 'A' },
    { no: 3, blackChan: 'proxy', whiteChan: 'proxy', blackTac: 'v8', whiteTac: 'v9', winnerChan: 'B' },
    { no: 4, blackChan: 'proxy', whiteChan: 'proxy', blackTac: 'v9', whiteTac: 'v8', winnerChan: null },
  ],
};

function host(): HTMLElement {
  return mount('<span id="expReportNote"></span><div id="expHistory"></div>');
}

describe('实验报告：按「渠道 · 战术版本」分桶的对比口径', () => {
  it('两侧同渠道时旧口径会合并，新口径分成两行', () => {
    /* 旧口径：三次胜利全算「Jev 渠道」——这正是本次换口径要解决的问题 */
    const old = expTotals([JEV_V8_VS_V9]);
    expect([old.jevWins, old.otherWins, old.draws, old.effective]).toEqual([3, 0, 1, 4]);

    const rows = expSideStats([JEV_V8_VS_V9]);
    expect(rows.map((r) => r.key)).toEqual(['proxy|v8|0', 'proxy|v9|0']);
    /* v8：2 胜 1 和 → (2 + 0.5) / 4；v9：1 胜 2 负 1 和 */
    expect(rows[0]).toMatchObject({ channel: 'proxy', tactics: 'v8', games: 4, wins: 2, draws: 1, losses: 1 });
    expect(rows[0]!.rate).toBeCloseTo(0.625, 10);
    expect(rows[1]).toMatchObject({ tactics: 'v9', games: 4, wins: 1, draws: 1, losses: 2 });
    expect(rows[1]!.rate).toBeCloseTo(0.375, 10);
  });

  it('A/B → 黑白的判据按局号奇偶，不按渠道名', () => {
    /* #2 里 A 执白且 winnerChan='A'：判据写反会把这一胜记到 v9 头上 */
    expect(gameSide(JEV_V8_VS_V9, JEV_V8_VS_V9.games[1]!, 'black').tactics).toBe('v9');
    expect(gameSide(JEV_V8_VS_V9, JEV_V8_VS_V9.games[1]!, 'white').tactics).toBe('v8');
    const s = roundScore(JEV_V8_VS_V9);
    expect([s.a, s.b, s.draws, s.effective]).toEqual([2, 1, 1, 4]);
    expect(s.aRate).toBeCloseTo(0.625, 10);
    expect(s.bRate).toBeCloseTo(0.375, 10);
    expect(pct(s.aRate)).toBe('62.5%');
    expect(pct(s.bRate)).toBe('37.5%');
  });

  it('重复局不计入任何口径；局内字段缺省时退到轮级字段', () => {
    const withDup: ExperimentEntry = {
      ...JEV_V8_VS_V9,
      games: [...JEV_V8_VS_V9.games, { no: 5, winnerChan: 'A', dup: true }],
    };
    const rows = expSideStats([withDup]);
    expect(rows.map((r) => r.games)).toEqual([4, 4]);
    expect(roundScore(withDup).effective).toBe(4);

    const thin: ExperimentEntry = {
      tag: 'exp-thin',
      date: '2026-10-01T11:00:00.000Z',
      chanA: 'proxy',
      chanB: 'rapfi',
      tacA: 'v8',
      tacB: null,
      thinkB: 3000,
      total: 1,
      games: [{ no: 1, winnerChan: 'B' }],
    };
    const id = gameSide(thin, thin.games[0]!, 'white');
    expect(id).toMatchObject({ channel: 'rapfi', tactics: null, thinkMs: 3000 });
    expect(gameSide(thin, thin.games[0]!, 'black')).toMatchObject({ channel: 'proxy', tactics: 'v8' });
    /* Rapfi 的思考时长进 key：3s 与 5s 是两个身份 */
    expect(id.key).toBe('rapfi||3000');
    expect(expSideStats([thin]).map((r) => r.key).sort()).toEqual(['proxy|v8|0', 'rapfi||3000']);
  });

  it('渲染：分桶表 + 单轮得分率条 + 注脚不再出现「Jev 渠道」', () => {
    const h = host();
    renderExpHistory([JEV_V8_VS_V9], h);

    const agg = expAggregate([JEV_V8_VS_V9]);
    expect(agg.querySelector('.exp-total')!.textContent).toContain('累计 1 轮 · 4 局有效对局');
    expect(agg.querySelector('.exp-total')!.textContent).toContain('和棋 1');

    const rows = [...h.querySelectorAll('.exp-agg-row')];
    expect(rows.length).toBe(2);
    expect(rows.map((r) => (r as HTMLElement).dataset.key)).toEqual(['proxy|v8|0', 'proxy|v9|0']);
    expect([...need(rows[0], 'v8 行').querySelectorAll('.exp-agg-num')].map((n) => n.textContent)).toEqual(['4', '2', '1']);
    expect(rows[0]!.querySelector('.exp-agg-rate b')!.textContent).toBe('62.5%');
    const bar = need(rows[0]!.querySelector('.exp-agg-bar i'), 'v8 条') as HTMLElement;
    expect(bar.style.width).toBe('62.5%');

    const note = need(h.querySelector('#expReportNote'));
    expect(note.textContent).toBe('1 轮实验 · 4 局有效');
    expect(note.textContent).not.toContain('Jev');

    /* 单轮卡片：A/B 得分率 + 和棋数进 meta，重复局行仍标出来 */
    const card = need(h.querySelector('.exp-card'), '.exp-card');
    expect([...card.querySelectorAll('.exp-bar-side')].map((s) => s.textContent)).toEqual(['A 62.5%', 'B 37.5%']);
    expect(card.querySelector('.exp-card-head .dim')!.textContent).toContain('4 局有效 · 和 1');
    expect(card.textContent).toContain('同一渠道两个战术版本对比');
  });

  it('空列表：只有空态提示，注脚清空', () => {
    const h = host();
    renderExpHistory([], h);
    expect(h.querySelector('.exp-agg')).toBeNull();
    expect(h.querySelectorAll('.exp-card').length).toBe(0);
    expect(h.querySelector('#expHistory')!.textContent).toContain('暂无实验记录');
    expect(need(h.querySelector('#expReportNote')).textContent).toBe('');
  });
});
