/* latest-games.spec.ts — 实验报告顶部「最新棋谱」（`#expLatestGames`）的装配层接线
 *
 * 背景（用户 2026-10-01）：报告面板原本只有 2026-09-29/30 那 6 轮实验卡片，而归档里最新
 * 的一批机机对局**根本没挂 experiment tag**（如 `jev-v9-vs-jev-v9`），永远进不了轮次卡 ——
 * 面板看上去停在早期实验上。装配层因此在 boot / 刷新 / 每轮实验结束后各取一次
 * `GET /api/games?limit=10` 并渲染到报告面板顶部。
 *
 * 这里测的是**接线**（谁取数、取了怎么整形、点「回放」调到哪、离线降级成什么），
 * 渲染细节的用例在 `test/ui/experiment-report.spec.ts`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/app/boot.ts';
import type { AppCtx } from '../../src/app/ctx.ts';
import {
  STORE_KEY,
  fakeRenderer,
  mountAppHtml,
  seedStorage,
  settingsJson,
  storageOf,
  stubFetch,
  waitUntil,
} from './fixture.ts';

/** 归档条目（`src/worker/routes/games.ts:56-63` 的 `listItem()` 形状）。 */
function archiveRow(uid: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gameUid: uid,
    day: '2026-10-01',
    createdAt: '2026-10-01T10:06:09.131Z',
    game: '五子棋',
    gameId: 'gomoku',
    blackChannel: 'proxy',
    whiteChannel: 'proxy',
    blackTactics: 'v9-vcf-sound',
    whiteTactics: 'v9-vcf-sound',
    blackThink: 0,
    whiteThink: 0,
    moveCount: 20,
    result: '黑方获胜（五连）',
    name: uid.slice(0, 8) + '.json',
    path: 'games/2026-10-01/' + uid.slice(0, 8) + '.json',
    size: 900,
    ...over,
  };
}

/** 回放器要吃的 export payload（三段记法）。 */
function payloadOf(uid: string): Record<string, unknown> {
  return {
    format: 'jev-qiguan-game/v1',
    gameUid: uid,
    gameId: 'gomoku',
    game: '五子棋',
    mode: 'human-ai',
    result: '黑方获胜（五连）',
    day: '2026-10-01',
    exported: '2026-10-01T10:06:09.131Z',
    notation: 'h8,i9,h9',
    moves: [
      { notation: 'h8', side: 'black', ai: null },
      { notation: 'i9', side: 'white', ai: { ch: 'mock', conf: 0.5, ms: 12, tv: 'v9-vcf-sound' } },
      { notation: 'h9', side: 'black', ai: null },
    ],
  };
}

function bootCtx(store: Map<string, string>): AppCtx {
  const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
  if (!ctx) throw new Error('boot() 返回 null');
  return ctx;
}

function rowsText(): string[] {
  return [...document.querySelectorAll('#expLatestGames .exp-latest-row')]
    .map((r) => (r as HTMLElement).textContent || '');
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('实验报告「最新棋谱」接线', () => {
  it('boot 后按归档顺序列出最新一页（未挂 tag 的机机对局也在内）', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    const calls = stubFetch({
      '/api/games': {
        ok: true,
        nextCursor: 'cur-2',
        games: [
          archiveRow('uid-new', { moveCount: 20 }),
          archiveRow('uid-tagged', { experimentTag: 'exp-20260930143522', expGameNo: 2, moveCount: 181 }),
          archiveRow('uid-old', { day: '2026-09-29', createdAt: '2026-09-29T08:00:00.000Z', moveCount: 13 }),
        ],
      },
    });

    bootCtx(store);
    await waitUntil(
      () => document.querySelectorAll('#expLatestGames .exp-latest-row').length === 3,
      4000,
      '最新棋谱三行',
    );

    /* 只取最新一页，且条数就是 LATEST_GAMES_LIMIT = 10 */
    expect(calls).toContain('/api/games?limit=10');
    const uids = [...document.querySelectorAll('#expLatestGames .exp-latest-row')]
      .map((r) => (r as HTMLElement).dataset.uid);
    expect(uids).toEqual(['uid-new', 'uid-tagged', 'uid-old']);

    const texts = rowsText();
    expect(texts[0]).toContain('10-01');
    expect(texts[0]).toContain('五子棋');
    expect(texts[0]).toContain('20 手');
    expect(texts[0]).toContain('Jev·v9');       /* 归因走 sideAttribution() */
    expect(texts[0]).toContain('黑方获胜（五连）');
    expect(texts[1]).toContain('exp-20260930143522 #2');
  });

  it('点「回放」把该局载进回放器面板（走 /api/games/u/:uid）', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    const calls = stubFetch({
      '/api/games': { ok: true, nextCursor: null, games: [archiveRow('uid-new')] },
      '/api/games/u/uid-new': payloadOf('uid-new'),
    });

    bootCtx(store);
    await waitUntil(
      () => document.querySelectorAll('#expLatestGames .exp-latest-row').length === 1,
      4000,
      '最新棋谱一行',
    );

    const btn = document.querySelector('#expLatestGames .exp-latest-open') as HTMLElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('回放');
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await waitUntil(
      () => document.querySelector('#replayerPanel .rp-pos')?.textContent === '0/3',
      4000,
      '回放器载入三段记法',
    );
    expect(calls).toContain('/api/games/u/uid-new');
    const rp = document.getElementById('replayerPanel');
    expect(rp?.className).toBe('rp');
    expect(rp?.textContent).toContain('五子棋');
    /* 逐手列表按 payload 的三段记法铺开 */
    expect([...rp!.querySelectorAll('.rp-move')].map((m) => m.querySelector('.rp-notation')?.textContent))
      .toEqual(['h8', 'i9', 'h9']);
    /* 画布宿主已就位（happy-dom 没有 2D 上下文，`drawReplayPosition` 会安静跳过建 canvas） */
    expect(rp?.querySelector('.rp-board')).not.toBeNull();
  });

  it('离线：面板停在「加载中…」而不是抛异常或清空', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));

    bootCtx(store);
    await waitUntil(
      () => (document.getElementById('expLatestGames')?.textContent || '').includes('加载中'),
      4000,
      '最新棋谱空态',
    );
    expect(document.querySelectorAll('#expLatestGames .exp-latest-row').length).toBe(0);
    expect(document.querySelector('#expLatestGames .exp-latest')).not.toBeNull();
  });
});
