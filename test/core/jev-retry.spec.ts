/**
 * `src/core/jev/client.ts` 的重试与退避（**这份用例是补的**）。
 *
 * 为什么此前没有：该文件的行为金样来自引擎自对弈（`test/engines/**`）与浏览器冒烟，
 * 两者都不制造 429，于是「限流分支」在两套测试里都是空白。2026-10-01 用真 key 跑 4 局
 * 对比实验时它现了原形：生产 `/api/jev` 限流 30/分/IP，机机对局一个窗口就打到 34 次，
 * 客户端 4 次尝试（1+2+4 秒）熬不过一个 60 秒窗口，最后抛出的却是 `重试次数用尽`
 * ——因为限流分支压根没给 `lastErr` 赋值，真实原因（被限流）完全看不出来。
 *
 * 这里钉住四件事：
 *  1. `Retry-After` 真的被遵守（不是固定指数退避）；
 *  2. 限流耗尽后的**文案带着状态码**，并且错误被标记成「可重试」，
 *     装配层（`src/app/loop.ts`）据此自动重试；
 *  3. 401 不重试、不等待，且 `retryable === false`；
 *  4. 网络错误仍然 4 次尝试（与旧实现一致）。
 *
 * 假时钟：`sleep` 走真实 `setTimeout`，所以必须 `useFakeTimers` + 手动推进，
 * 否则每个用例要真的等几十秒。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decide } from '../../src/core/jev/client.ts';
import { getGame } from '../../src/core/registry.ts';
import type { DecideOpts } from '../../src/core/tactics.ts';

const gomoku = getGame('gomoku');
if (!gomoku) throw new Error('注册表里没有 gomoku，夹具失效');

/** 一局初始局面 + 一个合法着法（响应里给出它的概率，决策就落在它上面）。 */
function fixture(): { st: unknown; notation: string } {
  const st = gomoku!.newGame();
  const legal = gomoku!.getLegalMoves(st);
  const first = legal[0];
  if (!first) throw new Error('初始局面没有合法着法，夹具失效');
  return { st, notation: first.notation };
}

function okBody(notation: string): Record<string, unknown> {
  return {
    model: 'fake-model',
    answers: { move: { probabilities: { [notation]: 1 }, confidence: 0.9 } },
    usage: { input_tokens: 12 },
  };
}

function httpError(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{"error":"test"}', { status, headers });
}

/** 记录每次请求，并按脚本依次作答（脚本用完后重复最后一项）。 */
function stubFetch(script: Array<() => Response | Promise<Response>>): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', (async () => {
    const step = script[Math.min(state.calls, script.length - 1)] as () => Response | Promise<Response>;
    state.calls++;
    return await step();
  }) as typeof fetch);
  return state;
}

/** 推进假时钟直到 promise 落定（返回拒绝值而不是抛出，便于断言消息）。 */
async function settle<T>(p: Promise<T>, maxSeconds = 300): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  let out: { ok: true; value: T } | { ok: false; error: Error } | null = null;
  void p.then(
    (value) => { out = { ok: true, value }; },
    (error: Error) => { out = { ok: false, error }; },
  );
  for (let i = 0; i < maxSeconds && out === null; i++) await vi.advanceTimersByTimeAsync(1000);
  if (out === null) throw new Error(`假时钟推进 ${maxSeconds} 秒后仍未落定`);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('jev 客户端：限流退避与错误标记', () => {
  it('遵守 Retry-After：429 之后先等满服务端要求的秒数再重试，然后成功', async () => {
    const { st, notation } = fixture();
    const state = stubFetch([
      () => httpError(429, { 'Retry-After': '3' }),
      () => new Response(JSON.stringify(okBody(notation)), { status: 200 }),
    ]);

    const each: number[] = [];
    const pending = decide(gomoku!, st, 'black', {
      channel: 'proxy',
      apiKey: 'k',
      tacticsVersion: 'v0-off',
      onRetry: (code, attempt) => each.push(Number(code)),
    } as DecideOpts);

    // 第 1 次请求立刻发生
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toBe(1);

    // 服务端要 3 秒：2.9 秒时还没发第二次
    await vi.advanceTimersByTimeAsync(2900);
    expect(state.calls).toBe(1);

    // 到 3 秒才发第二次
    await vi.advanceTimersByTimeAsync(200);
    expect(state.calls).toBe(2);

    const res = await settle(pending);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.notation).toBe(notation);
      expect(res.value.meta.channel).toBe('proxy');
    }
    // onRetry 收到的是上游状态码（UI 的「限流(429)，退避重试中…」就靠它）
    expect(each).toEqual([429]);
  });

  it('限流耗尽：文案带状态码、标记为可重试，且不再出现「重试次数用尽」', async () => {
    const { st } = fixture();
    const state = stubFetch([() => httpError(429, { 'Retry-After': '1' })]);

    const attempts: number[] = [];
    const res = await settle(decide(gomoku!, st, 'black', {
      channel: 'proxy',
      apiKey: 'k',
      tacticsVersion: 'v0-off',
      onRetry: (_code, attempt) => attempts.push(attempt),
    } as DecideOpts));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain('上游限流（HTTP 429）');
      expect(res.error.message).toContain('已退避重试 5 次');
      expect(res.error.message).not.toContain('重试次数用尽');
      expect((res.error as Error & { retryable?: boolean }).retryable).toBe(true);
    }
    // 5 次请求全部发生，退避 4 次（第 5 次失败后直接抛）
    expect(state.calls).toBe(5);
    expect(attempts).toEqual([0, 1, 2, 3]);
  });

  it('529（上游过载）与 429 走同一条退避路', async () => {
    const { st, notation } = fixture();
    const state = stubFetch([
      () => httpError(529, { 'Retry-After': '2' }),
      () => new Response(JSON.stringify(okBody(notation)), { status: 200 }),
    ]);

    const res = await settle(decide(gomoku!, st, 'black', { channel: 'proxy', apiKey: 'k', tacticsVersion: 'v0-off' } as DecideOpts));
    expect(res.ok).toBe(true);
    expect(state.calls).toBe(2);
  });

  it('401 立刻失败：不重试、不等退避，且标记为不可重试', async () => {
    const { st } = fixture();
    const state = stubFetch([() => httpError(401)]);

    const res = await settle(decide(gomoku!, st, 'black', { channel: 'proxy', apiKey: 'bad', tacticsVersion: 'v0-off' } as DecideOpts));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain('API Key 无效或缺失（401）');
      expect((res.error as Error & { retryable?: boolean }).retryable).toBe(false);
    }
    expect(state.calls).toBe(1);
  });

  it('网络错误：仍然 4 次尝试（与旧实现一致），文案含「已尝试 4 次」并标记可重试', async () => {
    const { st } = fixture();
    let calls = 0;
    vi.stubGlobal('fetch', (async () => {
      calls++;
      throw new TypeError('fetch failed');
    }) as typeof fetch);

    const res = await settle(decide(gomoku!, st, 'black', { channel: 'proxy', apiKey: 'k', tacticsVersion: 'v0-off' } as DecideOpts));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain('网络错误');
      expect(res.error.message).toContain('已尝试 4 次');
      expect((res.error as Error & { retryable?: boolean }).retryable).toBe(true);
    }
    expect(calls).toBe(4);
  });
});
