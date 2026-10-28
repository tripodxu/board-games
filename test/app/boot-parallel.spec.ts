/* boot-parallel.spec.ts — 启动取数的并发契约（2026-10-28）
 *
 * 钉住一件事：**探活不能当闸门**。旧实现是
 *   `initBackend`（探活，8s 超时）→ 两路补数 → 三块面板取数，
 * 三轮串行瀑布；后端不在线/慢时，三块面板要等探活走完（最坏 8s）才开始请求。
 * 现在四路并发，探活只决定右上角那枚状态芯片。
 *
 * 这个测试的做法：让 `/api/health` **永远挂着**（模拟后端不可达），
 * 再断言三块面板的请求**照样发出**——串行时代这些请求根本不会被发出。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/app/boot.ts';
import {
  STORE_KEY,
  fakeRenderer,
  mountAppHtml,
  seedStorage,
  settingsJson,
  storageOf,
  waitUntil,
} from './fixture.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('启动取数并发（探活不再是闸门）', () => {
  it('探活挂着不动时，排行榜 / 开局库 / 最新棋谱照样发请求', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    const seen: string[] = [];

    vi.stubGlobal('fetch', (url: unknown) => {
      const u = String(url);
      seen.push(u);
      /* /api/health 永不 settle：模拟后端不可达 */
      if (u.indexOf('/api/health') >= 0) return new Promise(() => {});
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ok: true, games: [], rows: [], openings: [], totalGames: 0, byGame: {}, results: {}, cal: [],
        }),
      });
    });

    const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
    expect(ctx).not.toBeNull();

    /* 探活确实发出去了（且仍挂着的期间） */
    expect(seen.some((u) => u.indexOf('/api/health') >= 0)).toBe(true);

    /* 三块面板不等探活：各自把请求发出去了 */
    const hit = (frag: string): boolean => seen.some((u) => u.indexOf(frag) >= 0);
    await waitUntil(() => hit('/api/leaderboard'), 2000, '排行榜取数与探活并发');
    await waitUntil(() => hit('/api/openings'), 2000, '开局库取数与探活并发');
    await waitUntil(() => hit('/api/games'), 2000, '最新棋谱取数与探活并发');

    /* 且开局库请求仍带棋种与行数（并发化不能丢参数） */
    expect(seen.find((u) => u.indexOf('/api/openings') >= 0)).toMatch(/game=/);
  });

  it('探活失败（离线）时同样走降级，不阻塞面板', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: unknown) => {
      seen.push(String(url));
      return Promise.reject(new Error('offline'));
    });

    const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
    expect(ctx).not.toBeNull();

    const hit = (frag: string): boolean => seen.some((u) => u.indexOf(frag) >= 0);
    await waitUntil(() => hit('/api/leaderboard') && hit('/api/openings') && hit('/api/games'),
      2000, '离线下三块面板仍各自发过请求');
  });
});
