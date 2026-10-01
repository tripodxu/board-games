/* experiments-merge.spec.ts — 服务端实验战报并进本机归档（`refreshServerExperiments`）
 *
 * 为什么要单独钉这一条：Worker 的 `GET /api/experiments` 响应体是**包装对象**
 * `{experiments:[…]}`，而 P6 装配时按「客户端已解包」写成 `Array.isArray(r)` 判断，
 * 于是服务端 6 轮实验在生产上**永远没出现在报告面板里**（面板只显示 localStorage 里
 * 的种子两轮）。这个缺陷躲过了所有单测与 HTTP 冒烟——只有真浏览器里的端到端断言能看见。
 *
 * 这里用真标记 + 桩 `fetch`（返回包装体）跑一遍 boot → 断言「本机归档里真的多了服务端轮次」
 * 且面板按新口径把这些轮次分桶渲染。
 *
 * 注意 `createExpHistoryStore()` 会把 `EXP_SEED`（两轮 / 9 局有效）并进本地列表，所以
 * 「几轮实验」的期望值 = 本机夹具 + 种子两轮 + 服务端轮次；`EXP_SEED` 改动会让这几条用例红，
 * 那是刻意的（报告口径依赖它）。
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

/** 实验归档的 localStorage 键（字面量：键名被改错时测试要失败，而不是跟着一起改）。 */
const EXP_KEY = 'jev-exp-history-v1';
/** `EXP_SEED` 的两轮合计有效局数（种子在 `src/ui/panels/experiment-report.ts`）。 */
const SEED_EFFECTIVE = 9;

function bootCtx(store: Map<string, string>): AppCtx {
  const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
  if (!ctx) throw new Error('boot() 返回 null');
  return ctx;
}

/** 本机已有的一轮（1 局，A 胜）。 */
function localRound(): Record<string, unknown> {
  return {
    tag: 'local-1',
    date: '2026-09-20T10:00:00.000Z',
    chanA: 'proxy',
    chanB: 'random',
    tacA: 'v8-vcf-try',
    tacB: '',
    thinkA: 0,
    thinkB: 0,
    total: 1,
    games: [{ no: 1, winnerChan: 'A' }],
  };
}

/** 服务端的两轮：一轮两侧同渠道不同战术档（本机没有的组合），一轮 Rapfi vs 随机（含 1 和棋）。 */
function serverRounds(): Record<string, unknown>[] {
  return [
    {
      tag: 'srv-1',
      date: '2026-09-28T09:00:00.000Z',
      chanA: 'proxy',
      chanB: 'proxy',
      tacA: 'v8-vcf-try',
      tacB: 'v9-vcf-sound',
      thinkA: 0,
      thinkB: 0,
      total: 2,
      games: [{ no: 1, winnerChan: 'A' }, { no: 2, winnerChan: 'B' }],
    },
    {
      tag: 'srv-2',
      date: '2026-09-29T12:30:00.000Z',
      chanA: 'rapfi',
      chanB: 'random',
      tacA: '',
      tacB: '',
      thinkA: 3000,
      thinkB: 0,
      total: 1,
      games: [{ no: 1, winnerChan: null }],
    },
  ];
}

function savedRounds(store: Map<string, string>): Array<Record<string, unknown>> {
  return JSON.parse(store.get(EXP_KEY) ?? '[]') as Array<Record<string, unknown>>;
}

function tags(store: Map<string, string>): string[] {
  return savedRounds(store).map((e) => String(e.tag));
}

function aggKeys(): string[] {
  return [...document.querySelectorAll('#expHistory .exp-agg-row')]
    .map((r) => r.getAttribute('data-key') ?? '');
}

function note(): string {
  return document.getElementById('expReportNote')?.textContent ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('实验报告：服务端战报并入本机归档', () => {
  it('包装体 {experiments:[…]} 会被解包并合并，面板按渠道·战术分桶', async () => {
    mountAppHtml();
    const store = seedStorage({
      [STORE_KEY]: settingsJson(),
      [EXP_KEY]: JSON.stringify([localRound()]),
    });
    const calls = stubFetch({
      '/api/health': { ok: true, service: 'jev-qiguan-worker', d1: true },
      '/api/experiments': { experiments: serverRounds() },
    });

    bootCtx(store);
    await waitUntil(() => tags(store).includes('srv-2'), 4000, '服务端轮次并入本机归档');
    await waitUntil(() => calls.includes('/api/experiments'), 2000, '真的请求了实验台账');

    /* 本机 1 轮 + 种子 2 轮 + 服务端 2 轮；按日期倒序，最新的是服务端那轮 */
    expect(tags(store)).toHaveLength(5);
    expect(tags(store)[0]).toBe('srv-2');
    expect(note()).toBe(`5 轮实验 · ${1 + 2 + 1 + SEED_EFFECTIVE} 局有效`);

    /* 服务端才有的「两侧同渠道不同战术档」必须作为两个身份出现（本轮优化的核心场景） */
    const keys = aggKeys();
    expect(keys).toContain('proxy|v8-vcf-try|0');
    expect(keys).toContain('proxy|v9-vcf-sound|0');
    expect(keys).toContain('rapfi||3000');
    expect(keys).toContain('random||0');
    /* 每轮一张卡片：五个轮次都要渲染出来 */
    expect(document.querySelectorAll('#expHistory .exp-card').length).toBe(5);
  });

  it('同 tag 的合并规则照旧：局数变多才覆盖，局数更少不往回退', async () => {
    mountAppHtml();
    const local = localRound();
    local.games = [{ no: 1, winnerChan: 'A' }, { no: 2, winnerChan: 'B' }]; /* 本机 2 局 */
    const store = seedStorage({
      [STORE_KEY]: settingsJson(),
      [EXP_KEY]: JSON.stringify([local]),
    });
    const calls = stubFetch({
      '/api/health': { ok: true },
      '/api/experiments': {
        experiments: [
          { ...localRound(), games: [{ no: 1, winnerChan: 'A' }] }, /* 更少：忽略 */
          { tag: 'srv-9', date: '2026-09-30T09:00:00.000Z', chanA: 'mock', chanB: 'mock', total: 1, games: [{ no: 1, winnerChan: 'A', dup: true }] },
        ],
      },
    });

    bootCtx(store);
    await waitUntil(() => tags(store).includes('srv-9'), 4000, '新 tag 追加');
    await waitUntil(() => calls.includes('/api/experiments'), 2000, '真的请求了实验台账');

    /* 本机 1 轮 + 种子 2 轮 + 服务端 1 轮；本机那轮仍是 2 局（没被服务端的 1 局覆盖） */
    expect(tags(store)).toHaveLength(4);
    const kept = savedRounds(store).find((e) => e.tag === 'local-1');
    expect((kept?.games as unknown[] | undefined)?.length).toBe(2);
    /* 唯一的服务端新轮次只有一局、且是 dup → 不计入有效局 */
    expect(note()).toBe(`4 轮实验 · ${2 + SEED_EFFECTIVE} 局有效`);
  });

  it('响应体被换回裸数组也照收（兼容分支）；坏形状不合并也不抛', async () => {
    mountAppHtml();
    const store = seedStorage({
      [STORE_KEY]: settingsJson(),
      [EXP_KEY]: JSON.stringify([localRound()]),
    });
    const calls = stubFetch({
      '/api/health': { ok: true },
      '/api/experiments': serverRounds(), /* 裸数组 */
    });

    bootCtx(store);
    await waitUntil(() => tags(store).includes('srv-2'), 4000, '裸数组也要能合并');
    expect(calls).toContain('/api/experiments');
    expect(tags(store)).toHaveLength(5);

    /* 坏形状：既不是数组也不是 {experiments:[…]} → 原样保留，不抛异常 */
    document.body.innerHTML = '';
    const store2 = seedStorage({
      [STORE_KEY]: settingsJson(),
      [EXP_KEY]: JSON.stringify([localRound()]),
    });
    vi.unstubAllGlobals();
    const calls2 = stubFetch({ '/api/health': { ok: true }, '/api/experiments': { ok: true, experiments: 'nope' } });
    mountAppHtml();
    bootCtx(store2);
    await waitUntil(() => calls2.includes('/api/experiments'), 4000, '坏形状也要真的请求到');
    /* 既没解包出数组、也没抛异常：本机 1 轮 + 种子 2 轮，一个不多一个不少 */
    expect([...tags(store2)].sort())
      .toEqual(['local-1', 'exp-20260929105234', 'exp-20260929111222'].sort());
    expect(note()).toBe(`3 轮实验 · ${1 + SEED_EFFECTIVE} 局有效`);
  });
});
