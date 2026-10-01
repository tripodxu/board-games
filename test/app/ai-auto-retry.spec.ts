/**
 * AI 调用失败后的**无人值守自动重试**（`src/app/loop.ts`）。
 *
 * 事故背景（2026-10-01）：用真 key 跑 4 局对比实验，第 1 局就停住了——生产 `/api/jev`
 * 限流是 30 次/分/IP，机机对局一个窗口打到 34 次被自己的 Worker 挡下；客户端旧写法
 * 4 次尝试熬不过 60 秒窗口，抛出的是「重试次数用尽」，于是 `aiStep` 判它不可重试、
 * 直接把机机对局 `setPaused(true)`。**机机对局与对比实验都没有人来点「重试」**，
 * 整轮实验就此报废。
 *
 * 现在：客户端给可重试错误打 `retryable` 标记，装配层据此自动退避重试（4s/12s/25s 三次），
 * 期间**不暂停**。这份用例就是钉住这两件事，以及「不可重试的错误仍然照旧暂停」。
 *
 * 计时技巧：请求桩回 `Retry-After: 0`，客户端 5 次尝试在毫秒级跑完（否则要真等 1+2+4+8 秒），
 * 于是「第一次失败已经发生」可以立刻断言；4 秒后的那次自动重试不在本用例的观察窗口内。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/app/boot.ts';
import { startGame } from '../../src/app/loop.ts';
import {
  fakeRenderer, mountAppHtml, seedStorage, settingsJson, storageOf, STORE_KEY, text, visible, waitUntil,
} from './fixture.ts';

/** 除 `/api/jev` 按给定状态码失败外，其余接口一律 200 空对象（避免降级路径干扰）。 */
function stubJev(status: number, headers: Record<string, string> = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', ((input: unknown): Promise<Response> => {
    const url = new URL(String(input), 'http://127.0.0.1/');
    calls.push(url.pathname);
    if (url.pathname === '/api/jev') {
      return Promise.resolve(new Response('{"error":"stub"}', { status, headers }));
    }
    return Promise.resolve(new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }) as typeof fetch);
  return calls;
}

function setValue(id: string, value: string): void {
  const el = document.getElementById(id) as (HTMLSelectElement | HTMLInputElement | null);
  if (!el) throw new Error('缺少 #' + id);
  el.value = value;
}

/** 起一局「机 vs 机 + 同源代理」对局（渠道与 key 在抽屉控件里，`startGame` 会先同步它）。 */
function startAiVsAi(): ReturnType<typeof boot> {
  const store = seedStorage({ [STORE_KEY]: settingsJson() });
  mountAppHtml();
  const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
  if (!ctx) throw new Error('boot() 返回 null');
  setValue('mode', 'ai-ai');
  setValue('channel', 'proxy');
  setValue('apiKey', 'stub-key');
  startGame(ctx);
  return ctx;
}

beforeEach(() => {
  mountAppHtml();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('装配层：AI 失败后的自动重试（无人值守）', () => {
  it('限流（429，可重试）：不暂停、进入自动重试、计数 +1，并留下可点的手动重试入口', async () => {
    const calls = stubJev(429, { 'Retry-After': '0' });
    const ctx = startAiVsAi();
    if (!ctx) throw new Error('boot() 返回 null');

    await waitUntil(() => ctx.aiAutoRetries > 0, 8000, '自动重试计数');

    expect(ctx.session.paused).toBe(false);
    expect(ctx.aiAutoRetries).toBe(1);
    expect(text('status')).toContain('自动重试');
    expect(text('status')).toContain('剩 2 次');
    expect(visible('retryBtn')).toBe(true);
    // 5 次尝试都打在同一个请求上（Retry-After: 0 让退避几乎不耗时）
    expect(calls.filter((p) => p === '/api/jev').length).toBe(5);
    // 显式放宽超时：默认 5 秒会先于 `waitUntil` 触发，会掩盖它那句「等的是什么」的诊断
  }, 15_000);

  it('鉴权失败（401，不可重试）：照旧立即交给用户，机机对局暂停（旧行为不变）', async () => {
    const calls = stubJev(401);
    const ctx = startAiVsAi();
    if (!ctx) throw new Error('boot() 返回 null');

    await waitUntil(() => visible('retryBtn'), 8000, '手动重试按钮');

    expect(text('status')).toContain('API Key 无效或缺失（401）');
    expect(text('status')).not.toContain('自动重试');
    expect(ctx.aiAutoRetries).toBe(0);
    expect(ctx.session.paused).toBe(true);
    expect(calls.filter((p) => p === '/api/jev').length).toBe(1);
  });
});
