// test/scripts/throttle.spec.mjs — 自限速 + 429 熔断（不动真时钟、不联网）
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PER_MINUTE,
  DIRECT_UPSTREAM_HOSTS,
  MAX_CONSECUTIVE_429,
  createThrottle,
  formatThrottle,
  installFetchThrottle,
} from '../../scripts/lib/throttle.mjs';

/** 假时钟：sleep 推进时间，于是「发车间隔」可被逐次断言。 */
function fakeClock() {
  let t = 0;
  const waits = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms) => { waits.push(ms); t += ms; },
    at: () => t,
  };
}

describe('createThrottle', () => {
  it('默认 30/min ⇒ 每次发车间隔 2s；三次请求总耗时 = 2×间隔', async () => {
    const c = fakeClock();
    const th = createThrottle({ now: c.now, sleep: c.sleep });
    expect(th.perMinute).toBe(DEFAULT_PER_MINUTE);
    expect(th.intervalMs).toBe(2000);
    await th.acquire();
    await th.acquire();
    await th.acquire();
    expect(c.waits).toEqual([2000, 2000]); // 第一次不必等（wait=0 时不调 sleep，免得空转一圈）
    expect(th.state()).toMatchObject({ issued: 3, waitedMs: 4000, consecutive429: 0, tripped: false });
    expect(c.at()).toBe(4000);
  });

  it('不限速写成 0 是不允许的（0 很容易被读成「不限速」，这里直接抛）', () => {
    expect(() => createThrottle({ perMinute: 0 })).toThrow(/正数/);
    expect(() => createThrottle({ perMinute: -1 })).toThrow(/正数/);
    expect(() => createThrottle({ perMinute: Number.NaN })).toThrow(/正数/);
  });

  it('时钟回拨也不会把发车时刻拖到过去（不会连发）', async () => {
    let t = 10000;
    const waits = [];
    const th = createThrottle({ perMinute: 60, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
    await th.acquire(); // nextAt = 11000
    t = 1000;           // 回拨 9 秒
    await th.acquire();
    expect(waits).toEqual([10000]); // 仍然等到 11000，而不是「因为现在是 1000 就立刻发」
    expect(t).toBe(11000);
  });

  it('连续 429 到阈值就熔断，之后 acquire 直接抛（不再刷垃圾局）', async () => {
    const c = fakeClock();
    const th = createThrottle({ now: c.now, sleep: c.sleep });
    for (let i = 1; i < MAX_CONSECUTIVE_429; i++) {
      expect(th.note429(1000).tripped).toBe(false);
    }
    const st = th.note429(1000);
    expect(st.tripped).toBe(true);
    expect(st.tripReason).toMatch(/连续 5 次 429/);
    expect(st.tripReason).toMatch(/Retry-After=1000ms/);
    await expect(th.acquire()).rejects.toThrow(/熔断/);
  });

  it('一次成功就清零连续计数（偶发 429 不该累积成熔断）', async () => {
    const c = fakeClock();
    const th = createThrottle({ now: c.now, sleep: c.sleep });
    for (let i = 0; i < MAX_CONSECUTIVE_429 - 1; i++) th.note429();
    th.noteOk();
    for (let i = 0; i < MAX_CONSECUTIVE_429 - 1; i++) th.note429();
    expect(th.state().tripped).toBe(false);
    await expect(th.acquire()).resolves.toBeTruthy();
  });

  it('reset() 是人工恢复通道（换 key 之后能接着跑）', async () => {
    const c = fakeClock();
    const th = createThrottle({ now: c.now, sleep: c.sleep });
    for (let i = 0; i < MAX_CONSECUTIVE_429; i++) th.note429();
    expect(th.state().tripped).toBe(true);
    th.reset();
    expect(th.state()).toMatchObject({ tripped: false, consecutive429: 0, tripReason: null });
    await expect(th.acquire()).resolves.toBeTruthy();
  });

  it('formatThrottle 一行里能读出速率/已发/等待/熔断', () => {
    const c = fakeClock();
    const th = createThrottle({ perMinute: 60, now: c.now, sleep: c.sleep });
    expect(formatThrottle(th.state())).toBe('限速 60/min（每次发车间隔 1.0s）已发 0 次、累计等待 0.0s｜连续 429 0');
    for (let i = 0; i < MAX_CONSECUTIVE_429; i++) th.note429(500);
    expect(formatThrottle(th.state())).toMatch(/已熔断/);
  });
});

describe('installFetchThrottle', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('只给上游主机领令牌；别的请求直接放行；uninstall 还原全局 fetch', async () => {
    const c = fakeClock();
    const th = createThrottle({ now: c.now, sleep: c.sleep });
    const seen = [];
    const fakeFetch = vi.fn(async (url) => { seen.push(String(url)); return { ok: true, status: 200 }; });
    const gate = installFetchThrottle(th, { fetchImpl: fakeFetch });
    expect(globalThis.fetch).not.toBe(origFetch);

    await globalThis.fetch(`https://${DIRECT_UPSTREAM_HOSTS[0]}/v1/systemone`, { method: 'POST' });
    await globalThis.fetch('https://example.invalid/other');
    await globalThis.fetch(`https://${DIRECT_UPSTREAM_HOSTS[0]}/v1/systemone`, { method: 'POST' });

    expect(gate.stats()).toEqual({ gated: 2, passed: 1 });
    expect(th.state().issued).toBe(2);
    expect(c.waits).toEqual([2000]); // 第二个上游请求等到下一班车；非上游那次不领令牌
    expect(seen).toHaveLength(3);

    const stats = gate.uninstall();
    expect(stats).toEqual({ gated: 2, passed: 1 });
    expect(globalThis.fetch).toBe(origFetch);
  });

  it('主机名大小写不敏感；相对路径（浏览器式）不领令牌也不报错', async () => {
    const c = fakeClock();
    const th = createThrottle({ now: c.now, sleep: c.sleep });
    const fakeFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const gate = installFetchThrottle(th, { fetchImpl: fakeFetch, hosts: 'Api.TypeSafe.AI' });
    await globalThis.fetch('https://api.typesafe.ai/v1/systemone');
    await globalThis.fetch('/api/games?tag=x');
    expect(gate.stats()).toEqual({ gated: 1, passed: 1 });
    gate.uninstall();
  });

  it('没有 fetch 的环境直接抛（免得静默不限速）', () => {
    const th = createThrottle();
    expect(() => installFetchThrottle(th, { fetchImpl: null })).toThrow(/没有 fetch/);
  });
});
