/* experiment-report.spec.ts — 实验报告面板的对比口径（本次优化新增的部分）
 *
 * 覆盖 `expSideStats()` / `roundScore()` / `gameSide()` / `pct()` / `expAggregate()` 与
 * `renderExpHistory()` 的渲染结果。核心场景：**两侧都是 Jev 渠道、只有战术版本不同**
 * （`v8 vs v9`）——旧 `expTotals()` 的「Jev 渠道 / 其他」两桶会把双方合并成
 * 「Jev 3 胜 · 其他 0 胜」，本 spec 的第一条用例就把这个对照钉住。
 *
 * 断言方式：渲染后查 DOM（行数、data-key、数字格、条宽、注脚文案），不做源码字符串匹配。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expAggregate,
  expSideStats,
  expTotals,
  gameSide,
  pct,
  renderExpHistory,
  renderLatestGames,
  roundScore,
  type ExperimentEntry,
} from '../../src/ui/panels/experiment-report.ts';
import { loadLatestGames } from '../../src/app/records.ts';
import { cleanup, click, mount, need } from './helpers.ts';

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

  it('Rapfi 侧的惰性档位标签不进身份（2026-10-02 幻影身份事故）', () => {
    /* 事故现场：`exp-20261002094817` 那 12 局的白方是 Rapfi，可归档里白方战术档写的是
       实验脚本的旧默认值 `v9-vcf-sound`（Rapfi 根本不进 computeTactics）⇒ 分桶表冒出
       `rapfi|v9-vcf-sound|500` 这种并不存在的身份。修法：不过战术层的渠道不认档位。 */
    const phantom: ExperimentEntry = {
      tag: 'exp-rapfi-label',
      date: '2026-10-02T09:48:17.000Z',
      chanA: 'proxy',
      chanB: 'rapfi',
      tacA: 'v11-vct',
      tacB: 'v9-vcf-sound' /* 惰性：Rapfi 侧从不使用它 */,
      thinkB: 500,
      total: 2,
      games: [
        { no: 1, blackChan: 'proxy', whiteChan: 'rapfi', blackTac: 'v11-vct', whiteTac: 'v9-vcf-sound', whiteThink: 500, winnerChan: 'A' },
        { no: 2, blackChan: 'rapfi', whiteChan: 'proxy', blackTac: 'v9-vcf-sound', blackThink: 500, whiteTac: 'v11-vct', winnerChan: 'A' },
      ],
    };
    const rows = expSideStats([phantom]);
    expect(rows.map((r) => r.key).sort()).toEqual(['proxy|v11-vct|0', 'rapfi||500']);
    const rapfi = rows.find((r) => r.channel === 'rapfi')!;
    expect(rapfi.tactics).toBeNull();
    /* 展示名仍要带思考档：擦掉的是档位标签，不是 Rapfi(0.5s) 这个身份 */
    expect(rapfi.label).toBe('Rapfi(0.5s)');
    expect(rows.every((r) => !String(r.key).includes('v9-vcf-sound'))).toBe(true);
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
    /* 局 / 胜 / 和 / 战术（这轮没记战术层耗时 ⇒ —）/ 候选（这轮的种子棋盘没记候选点 ⇒ —） */
    expect(
      [...need(rows[0], 'v8 行').querySelectorAll('.exp-agg-num')].map((n) => n.textContent),
    ).toEqual(['4', '2', '1', '—', '—']);
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

  it('战术层平均耗时：按手加权，Rapfi 侧（null）不进样本', () => {
    /* m07650 的新口径：一局里记录每侧的战术层均值与样本手数；Rapfi/mock 不过战术层记 null。
       轮级兜底按局号奇偶取 tacA/tacB（gameSide 的一致性修正），所以 Rapfi 不会被安上 A 的档位。 */
    const entry: ExperimentEntry = {
      tag: 'exp-tac',
      date: '2026-10-02T06:00:00.000Z',
      chanA: 'proxy',
      chanB: 'rapfi',
      tacA: 'v11-vct',
      tacB: null,
      thinkA: 0,
      thinkB: 500,
      total: 2,
      games: [
        /* #1：A（proxy）执黑，两手均值 50ms；B 是 Rapfi，没过战术层 */
        { no: 1, blackChan: 'proxy', blackTac: 'v11-vct', whiteChan: 'rapfi', blackTacMs: 50, blackTacN: 2, winnerChan: 'A' },
        /* #2：A 换到白方，两手均值 150ms */
        { no: 2, blackChan: 'rapfi', whiteChan: 'proxy', whiteTac: 'v11-vct', whiteTacMs: 150, whiteTacN: 2, winnerChan: null },
      ],
    };
    const rows = expSideStats([entry]);
    /* 只有两个身份：A 与 Rapfi。修 gameSide 之前 B 执黑那局会多出 `rapfi|v11-vct|0` */
    expect(rows.length).toBe(2);
    const proxy = rows.find((r) => r.channel === 'proxy')!;
    const rapfi = rows.find((r) => r.channel === 'rapfi')!;
    /* 按手加权：(50×2 + 150×2) ÷ 4 手 = 100ms */
    expect(proxy.tacAvgMs).toBe(100);
    expect(proxy.tacMoves).toBe(4);
    /* Rapfi 刻意不过战术层：没有样本（不是 0），否则「Jev vs Rapfi」的均值会被拉低 */
    expect(rapfi.key).toBe('rapfi||500');
    expect(rapfi.tacAvgMs).toBeNull();
    expect(rapfi.tacMoves).toBe(0);

    const t = expTotals([entry]);
    expect(t.tacAvgMs).toBe(100);
    expect(t.tacMoves).toBe(4);

    const h = host();
    renderExpHistory([entry], h);
    expect(need(h.querySelector('#expReportNote')).textContent).toContain('战术层均值 100ms');
    expect(need(h.querySelector('.exp-total'), '.exp-total').textContent).toContain('战术层均值 100ms（4 手）');
    const rapfiRow = [...h.querySelectorAll('.exp-agg-row')].find(
      (r) => (r as HTMLElement).dataset.key === 'rapfi||500',
    )!;
    expect(need(rapfiRow, 'rapfi 行').querySelector('.exp-agg-tac')!.textContent).toBe('—');
    const proxyRow = [...h.querySelectorAll('.exp-agg-row')].find(
      (r) => (r as HTMLElement).dataset.key === 'proxy|v11-vct|0',
    )!;
    expect(need(proxyRow, 'proxy 行').querySelector('.exp-agg-tac')!.textContent).toBe('100ms');
  });

  it('候选点三数：按手加权分桶，非 Jev 身份记 —', () => {
    /* C0/m13627：`sent` = 交给 Jev 决定的点数（criteria 键数）、`graded` = 模型给了概率的合法点数、
       `labeled` = 其中带战术标签的点数。与战术层耗时同款口径：非 Jev 侧不过候选集 ⇒ 没有样本（不是 0）。 */
    const entry: ExperimentEntry = {
      tag: 'exp-cands',
      date: '2026-10-03T02:00:00.000Z',
      chanA: 'proxy',
      chanB: 'rapfi',
      tacA: 'v14-live3-fresh',
      tacB: null,
      thinkA: 0,
      thinkB: 1000,
      total: 2,
      games: [
        /* #1：A（proxy）执黑，两手 发 64 / 评 60 / 标 20；B 是 Rapfi，不过候选集 */
        { no: 1, blackChan: 'proxy', blackTac: 'v14-live3-fresh', whiteChan: 'rapfi',
          blackCands: { graded: 60, sent: 64, labeled: 20, n: 2 }, winnerChan: 'A' },
        /* #2：A 换到白方 */
        { no: 2, blackChan: 'rapfi', whiteChan: 'proxy', whiteTac: 'v14-live3-fresh',
          whiteCands: { graded: 50, sent: 62, labeled: 18, n: 2 }, winnerChan: null },
      ],
    };
    const t = expTotals([entry]);
    /* 按手加权：(64×2 + 62×2) ÷ 4 = 63、graded 55、labeled 19 */
    expect(t.candsSent).toBe(63);
    expect(t.candsGraded).toBe(55);
    expect(t.candsLabeled).toBe(19);
    expect(t.candsMoves).toBe(4);

    const rows = expSideStats([entry]);
    const proxy = rows.find((r) => r.channel === 'proxy')!;
    expect(proxy.candsSent).toBe(63);
    expect(proxy.candsGraded).toBe(55);
    expect(proxy.candsLabeled).toBe(19);
    /* Rapfi 刻意不过候选集：没有样本（不是 0） */
    const rapfi = rows.find((r) => r.channel === 'rapfi')!;
    expect(rapfi.key).toBe('rapfi||1000');
    expect(rapfi.candsSent).toBeNull();
    expect(rapfi.candsGraded).toBeNull();
    expect(rapfi.candsLabeled).toBeNull();

    const h = host();
    renderExpHistory([entry], h);
    expect(need(h.querySelector('#expReportNote')).textContent).toContain('候选点均值 发 63');
    expect(need(h.querySelector('.exp-total'), '.exp-total').textContent)
      .toContain('候选点均值 发 63 / 评 55 / 标 19（4 手）');
    const rapfiRow = [...h.querySelectorAll('.exp-agg-row')].find(
      (r) => (r as HTMLElement).dataset.key === 'rapfi||1000',
    )!;
    expect(need(rapfiRow, 'rapfi 行').querySelector('.exp-agg-cands')!.textContent).toBe('—');
    const proxyRow = [...h.querySelectorAll('.exp-agg-row')].find(
      (r) => (r as HTMLElement).dataset.key === 'proxy|v14-live3-fresh|0',
    )!;
    expect(need(proxyRow, 'proxy 行').querySelector('.exp-agg-cands')!.textContent).toBe('63/55/19');
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

/* ── 最新棋谱（#expLatestGames）─────────────────────────────────────────────
 * 报告面板原本只画实验轮次卡，归档里最新的一批机机对局**根本没挂 experiment tag**，
 * 永远进不了轮次卡 —— 这些用例钉住「按归档顺序列出最新 N 份 + 一键回放」这条新入口。
 */
function latestHost(): HTMLElement {
  return mount('<div id="expLatestGames"></div>');
}

/** 一行真实形状的归档条目（`src/app/records.ts` 的 `latestRow()` 吃它）。 */
function latestRow(uid: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gameUid: uid,
    day: '2026-10-01',
    createdAt: '2026-10-01T10:06:09.131Z',
    game: '五子棋',
    blackChannel: 'proxy',
    whiteChannel: 'proxy',
    blackTactics: 'v9-vcf-sound',
    whiteTactics: 'v9-vcf-sound',
    blackThink: 0,
    whiteThink: 0,
    moveCount: 20,
    result: '黑方获胜（五连）',
    ...over,
  };
}

describe('实验报告：最新棋谱（渲染器）', () => {
  it('列出每一行的时间/棋种/手数/双方归因，并带可点的「回放」', () => {
    const h = latestHost();
    const picked: string[] = [];
    renderLatestGames({
      root: h,
      rows: [
        {
          gameUid: 'c926dfea294974b2',
          when: '10-01 18:06',
          game: '五子棋',
          black: 'Jev(代理) v9-vcf-sound',
          white: 'Jev(代理) v9-vcf-sound',
          moves: 20,
          result: '黑方获胜（五连）',
        },
        {
          gameUid: 'aaaa111122223333',
          when: '09-30 12:00',
          game: '五子棋',
          black: 'Rapfi(3s)',
          white: 'Jev(代理) v8',
          moves: 181,
          result: '黑方获胜（认输）',
          tag: 'exp-20260930143522',
          no: 2,
        },
      ],
      handlers: { onReplay: (uid) => picked.push(uid) },
    });

    expect(h.querySelector('.exp-latest-head')!.textContent).toContain('最新棋谱');
    const rows = [...h.querySelectorAll('.exp-latest-row')];
    expect(rows.length).toBe(2);
    expect(rows.map((r) => (r as HTMLElement).dataset.uid)).toEqual(['c926dfea294974b2', 'aaaa111122223333']);

    const first = need(rows[0], '第一行');
    expect(first.querySelector('.exp-latest-when')!.textContent).toBe('10-01 18:06');
    expect(first.querySelector('.exp-latest-game')!.textContent).toBe('五子棋');
    expect(first.querySelector('.exp-latest-moves')!.textContent).toBe('20 手');
    expect([...first.querySelectorAll('.exp-latest-side')].map((s) => s.textContent))
      .toEqual(['Jev(代理) v9-vcf-sound(黑)', 'Jev(代理) v9-vcf-sound(白)']);
    expect(first.querySelector('.exp-latest-result')!.textContent).toBe('→ 黑方获胜（五连）');
    /* 没挂 experiment tag 的行不显示 tag 格（这正是「最新机机对局进不了轮次卡」的那批） */
    expect(first.querySelector('.exp-latest-tag')).toBeNull();

    const second = need(rows[1], '第二行');
    expect(second.querySelector('.exp-latest-tag')!.textContent).toBe('exp-20260930143522 #2');
    expect(second.querySelector('.exp-latest-moves')!.textContent).toBe('181 手');

    const btn = need(first.querySelector('.exp-latest-open'), '回放按钮') as HTMLElement;
    expect(btn.textContent).toBe('回放');
    click(btn);
    expect(picked).toEqual(['c926dfea294974b2']);
  });

  it('加载中与空归档是两种不同文案', () => {
    const h = latestHost();
    renderLatestGames({ root: h, rows: null });
    expect(h.querySelector('.hint')!.textContent).toBe('加载中…');
    expect(h.querySelectorAll('.exp-latest-row').length).toBe(0);

    renderLatestGames({ root: h, rows: [] });
    expect(h.querySelector('.hint')!.textContent).toContain('还没有棋谱');
    expect(h.querySelector('.exp-latest-row')).toBeNull();
  });

  it('没有 onReplay 回调时不渲染按钮（避免点了没反应的按钮）', () => {
    const h = latestHost();
    renderLatestGames({
      root: h,
      rows: [{
        gameUid: 'c926dfea294974b2',
        when: '10-01 18:06',
        game: '五子棋',
        black: 'A',
        white: 'B',
        moves: 20,
        result: '和棋',
      }],
    });
    expect(h.querySelectorAll('.exp-latest-row').length).toBe(1);
    expect(h.querySelector('.exp-latest-open')).toBeNull();
  });

  it('重画是幂等的：第二次渲染不会叠加上一轮的行', () => {
    const h = latestHost();
    const row = (uid: string) => ({
      gameUid: uid, when: '10-01 18:06', game: '五子棋',
      black: 'A', white: 'B', moves: 20, result: '和棋',
    });
    renderLatestGames({ root: h, rows: [row('u1'), row('u2')] });
    renderLatestGames({ root: h, rows: [row('u3')] });
    expect([...h.querySelectorAll('.exp-latest-row')].map((r) => (r as HTMLElement).dataset.uid)).toEqual(['u3']);
  });
});

/* ── 装配层的整形（latestRow / loadLatestGames）────────────────────────────
 * 这里不 mount 整个 app：直接用 `stubFetch` + 真实 `boot()` 太重，
 * `loadLatestGames()` 只依赖 `byId('expLatestGames')` 与 `client.listGames()`。
 */
describe('实验报告：最新棋谱（装配层取数与整形）', () => {
  it('listGames 的条目被整形为行：时间/棋种/归因/手数/tag#no，缺 uid 的行丢掉', async () => {
    document.body.innerHTML = '<div id="expLatestGames"></div>';
    const routes: Record<string, unknown> = {
      '/api/games': {
        ok: true,
        nextCursor: 'cur-2',
        games: [
          latestRow('uid-new'),
          latestRow('uid-tagged', { experimentTag: 'exp-20260930143522', expGameNo: 2, moveCount: 181 }),
          { day: '2026-09-29', game: '五子棋' }, /* 没有 gameUid（老条目）：丢弃 */
        ],
      },
    };
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      seen.push(path);
      const body = routes[path.split('?')[0]!] ?? {};
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    try {
      await loadLatestGames({} as never);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(seen).toEqual(['/api/games?limit=10']);
    const rows = [...document.querySelectorAll('.exp-latest-row')];
    expect(rows.length).toBe(2);
    expect(rows.map((r) => (r as HTMLElement).dataset.uid)).toEqual(['uid-new', 'uid-tagged']);
    /* 日期取自行里的 `day` 列（`10-01`），**时分是按本地时区渲染的** —— CI 跑在 UTC、
       本机是 UTC+8，所以这里按同一规则现算，别写死 `18:06`（那会让 CI 红）。 */
    const dt = new Date('2026-10-01T10:06:09.131Z');
    const p2 = (n: number): string => String(n).padStart(2, '0');
    expect(rows[0]!.querySelector('.exp-latest-when')!.textContent)
      .toBe('10-01 ' + p2(dt.getHours()) + ':' + p2(dt.getMinutes()));
    expect(rows[0]!.querySelector('.exp-latest-game')!.textContent).toBe('五子棋');
    expect(rows[0]!.querySelector('.exp-latest-moves')!.textContent).toBe('20 手');
    /* 走的是共用的 `sideAttribution()`：`v9-vcf-sound` 被压成注册表 id `v9` */
    expect(rows[0]!.querySelector('.exp-latest-side')!.textContent).toBe('Jev·v9(黑)');
    expect(rows[1]!.querySelector('.exp-latest-tag')!.textContent).toBe('exp-20260930143522 #2');
  });

  it('后端不可用时给「加载中…」而不是崩掉（离线降级路径）', async () => {
    document.body.innerHTML = '<div id="expLatestGames"></div>';
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    try {
      await loadLatestGames({} as never);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(document.querySelector('.hint')!.textContent).toBe('加载中…');
    expect(document.querySelector('.exp-latest-row')).toBeNull();
  });
});
