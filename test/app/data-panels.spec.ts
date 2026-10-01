/* data-panels.spec.ts — P7c 三块数据面板（回放器 / 排行榜 / 开局库）在装配层的接线
 *
 * 三块面板本身只吃 props（它们自己的用例在 `test/ui/**`），这里测的是**装配层**：
 * 谁去取数、取到的东西怎么整形、`onPlyChange` / `onLimitChange` / `onGameChange` 写回哪、
 * 离线时降级成什么样。全部是运行时行为：灌真标记 → `boot()` → 桩 `fetch` → 查 DOM 与 ctx。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/app/boot.ts';
import type { AppCtx } from '../../src/app/ctx.ts';
import { resetSession } from '../../src/app/loop.ts';
import { switchGame } from '../../src/app/modes.ts';
import { openReplayer } from '../../src/app/panels.ts';
import {
  STORE_KEY,
  fakeRenderer,
  mountAppHtml,
  seedStorage,
  settingsJson,
  storageOf,
  waitUntil,
} from './fixture.ts';

/**
 * 路由式 `fetch` 桩：按 pathname 命中；值是对象就直接当 JSON 返回，是函数就按 URL 现算。
 * 返回**每次请求的 path+search 列表**（断言「带没带 ?game= / ?limit=」用）。
 */
function stubFetch(routes: Record<string, unknown>): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: unknown): Promise<Response> => {
    const url = new URL(String(input), 'http://127.0.0.1/');
    calls.push(url.pathname + url.search);
    const hit = routes[url.pathname];
    if (hit === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    const body = typeof hit === 'function' ? (hit as (u: URL) => unknown)(url) : hit;
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  });
  return calls;
}

/** 一份最简 export payload（两段记法 + 逐手 ai 元数据）。 */
function payloadOf(): Record<string, unknown> {
  return {
    format: 'jev-qiguan-game/v1',
    gameUid: 'uid-abc12345',
    gameId: 'gomoku',
    game: '五子棋',
    mode: 'human-ai',
    result: '黑方胜',
    day: '2026-08-22',
    exported: '2026-08-22T10:00:00.000Z',
    notation: 'h8,i9,h9',
    moves: [
      { notation: 'h8', side: 'black', ai: null },
      { notation: 'i9', side: 'white', ai: { ch: 'mock', conf: 0.5, ms: 12, tv: 'v9-vcf-sound' } },
      { notation: 'h9', side: 'black', ai: null },
    ],
  };
}

/** boot + 拿到非空 ctx（省掉每个用例的重复判空）。 */
function bootCtx(store: Map<string, string>): AppCtx {
  const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
  if (!ctx) throw new Error('boot() 返回 null');
  return ctx;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('P7c 数据面板接线', () => {
  it('离线启动：三块面板都挂在 index.html 的容器上，回放器停在「未知 0/0」', () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));

    bootCtx(store);

    const rp = document.getElementById('replayerPanel');
    expect(rp).not.toBeNull();
    expect(rp?.className).toBe('rp'); /* 面板覆写了挂载点的 class */
    expect(rp?.textContent).toContain('未知');
    expect(rp?.querySelector('.rp-pos')?.textContent).toBe('0/0');
    /* 没有 gameUid → 不出现「分享」按钮 */
    expect(rp?.querySelector('.rp-share')).toBeNull();

    const lb = document.getElementById('leaderboardPanel');
    const op = document.getElementById('openingsPanel');
    expect(lb?.className).toBe('lb');
    expect(op?.className).toBe('op');
    /* 无后端时客户端返回 null，面板按「加载中…」渲染（三态由面板自己定义） */
    expect(lb?.textContent).toContain('加载中…');
    expect(op?.textContent).toContain('加载中…');
  });

  it('排行榜 / 开局库取数成功后按行渲染，开局库请求一定带 ?game= 与 ?limit=', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    const calls = stubFetch({
      '/api/health': { ok: true, service: 'jev-qiguan-worker', d1: true },
      '/api/leaderboard': { ok: true, rows: [{ channel: 'jev', tactics: 'v9-vcf-sound', wins: 3, games: 4 }] },
      '/api/openings': (u: URL) => ({
        ok: true,
        openings: [{ prefix: 'h8,i9', games: Number(u.searchParams.get('limit')), black_win_rate: 50 }],
      }),
    });

    bootCtx(store);

    await waitUntil(
      () => !!document.querySelector('#leaderboardPanel .lb-row:not(.lb-head)'),
      2000,
      '排行榜行渲染',
    );
    await waitUntil(
      () => !!document.querySelector('#openingsPanel .op-row:not(.op-head)'),
      2000,
      '开局库行渲染',
    );

    const lbRow = document.querySelector('#leaderboardPanel .lb-row:not(.lb-head)');
    expect(lbRow?.querySelector('.lb-channel')?.textContent).toBe('jev');
    expect(lbRow?.querySelector('.lb-record')?.textContent).toBe('3/4');

    const opRow = document.querySelector('#openingsPanel .op-row:not(.op-head)');
    expect(opRow?.querySelector('.op-prefix')?.textContent).toBe('h8,i9');
    expect(opRow?.querySelector('.op-games')?.textContent).toBe('10 场');

    /* 服务端一律要求 `?game=`；首屏棋种是 gomoku，limit 默认 10 */
    expect(calls).toContain('/api/openings?game=gomoku&limit=10');
    expect(calls.some((c) => c.startsWith('/api/leaderboard'))).toBe(true);
  });

  it('改「行数」下拉与换棋种都会重新取数（写回 ctx.openings*）', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    const calls = stubFetch({
      '/api/health': { ok: true, service: 'jev-qiguan-worker', d1: true },
      '/api/openings': { ok: true, openings: [] },
    });
    const ctx = bootCtx(store);
    await waitUntil(() => calls.some((c) => c.startsWith('/api/openings')), 2000, '开局库首取');

    const sel = document.querySelector('#openingsPanel select.op-limit') as
      { value: string; dispatchEvent(e: Event): boolean } | null;
    expect(sel).not.toBeNull();
    if (sel) {
      sel.value = '50';
      sel.dispatchEvent(new Event('change'));
    }
    await waitUntil(() => calls.includes('/api/openings?game=gomoku&limit=50'), 2000, '行数变更后重取');
    expect(ctx.openingsLimit).toBe(50);

    switchGame(ctx, 'chess', resetSession);
    await waitUntil(() => calls.includes('/api/openings?game=chess&limit=50'), 2000, '换棋种后重取');
    expect(ctx.openingsGame).toBe('chess');
  });

  it('回放器：载入棋谱 → 顺手展开面板 → 「下一手」改 ctx.replayerPly 并重画', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    stubFetch({
      '/api/health': { ok: true },
      '/api/games/u/uid-abc12345': payloadOf(),
    });
    const ctx = bootCtx(store);

    /* 面板首访是收起的：载入棋谱会顺手展开（只切视觉与 aria，不写折叠清单） */
    const section = document.getElementById('replayerPanel')?.closest('section.panel');
    expect(section?.classList.contains('folded')).toBe(true);

    await openReplayer(ctx, 'uid-abc12345');

    expect(section?.classList.contains('folded')).toBe(false);
    expect(section?.querySelector('button.fold')?.getAttribute('aria-expanded')).toBe('true');
    expect(ctx.replayerPly).toBe(0);

    const rp = document.getElementById('replayerPanel');
    expect(rp?.querySelectorAll('.rp-move').length).toBe(3);
    expect(rp?.querySelector('.rp-pos')?.textContent).toBe('0/3');
    expect(rp?.querySelector('.rp-share')).not.toBeNull();
    /* 头部元信息取自 payload 原文（棋种 / 模式 / 结果） */
    expect(rp?.textContent).toContain('五子棋');
    expect(rp?.textContent).toContain('人机');

    /* 控制条「下一手」：装配层的 onPlyChange 写回 ctx 后重画 */
    const next = rp?.querySelector('button[title="下一手"]') as
      { dispatchEvent(e: Event): boolean } | null;
    expect(next).not.toBeNull();
    next?.dispatchEvent(new Event('click'));

    expect(ctx.replayerPly).toBe(1);
    const after = document.getElementById('replayerPanel');
    expect(after?.querySelector('.rp-pos')?.textContent).toBe('1/3');
    expect(after?.querySelector('.rp-move.is-cur')?.getAttribute('data-ply')).toBe('1');

    /* 键盘 ←/→ 也走同一条 onPlyChange（监听挂在面板 root 上） */
    after?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(ctx.replayerPly).toBe(2);
    expect(document.getElementById('replayerPanel')?.querySelector('.rp-pos')?.textContent).toBe('2/3');
  });

  it('回放器：取不到棋谱时不炸，只提示并保持空态', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    stubFetch({ '/api/health': { ok: true } }); /* /api/games/u/… 落到 404 → 客户端返回 null */
    const ctx = bootCtx(store);

    await expect(openReplayer(ctx, 'uid-missing')).resolves.toBeUndefined();

    const rp = document.getElementById('replayerPanel');
    expect(rp?.querySelectorAll('.rp-move').length).toBe(0);
    expect(rp?.querySelector('.rp-pos')?.textContent).toBe('0/0');
    const toastNode = document.getElementById('toast');
    expect(toastNode?.textContent).toContain('读取棋谱失败');
    expect(toastNode?.classList.contains('err')).toBe(true);
    expect(toastNode?.classList.contains('hidden')).toBe(false);
  });
});
