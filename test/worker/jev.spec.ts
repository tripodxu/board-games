/**
 * `POST /api/jev` 契约测试（计划 §5.1 / §5.3 / §5.5）。
 *
 * 两条线分开测，各测各的：
 *  1. **上游转发逻辑**（`lib/upstream.ts`）：注入假 `fetcher` 做单测。请求头逐字节断言
 *     （`Authorization: Bearer <key>` / `Content-Type: application/json`）、请求体白名单、
 *     响应头白名单、流式透传、超时、网络错误、客户端中止。**不发真实外网请求**。
 *  2. **路由链路**（形状校验 + 限流 + 状态码）：走完整中间件链（真 workerd + 真 D1）。
 *
 * ── 这份测试为什么不碰网络（重要） ──────────────────────────────────────────
 * 本池的 `vitest.config.ts` 没有配出网拦截，`cloudflare:test` 也不再导出 `fetchMock`
 * （v4 已移除，见 `node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts`），
 * 所以**从测试进程无法替换 workerd 里的全局 `fetch`**。后果：任何通过校验的 `/api/jev`
 * 请求都会真的去连 `api.typesafe.ai`（`sc-test` 这种假 key 只会换回一个 401）。
 * 那种用例会慢、会 flaky、还会掩盖真正的失败原因，于是这里的路由用例**一律用「过不了
 * 形状校验」的请求体**——它在调上游之前就返回 400，但**照样消耗限流桶**，
 * 所以限流仍然是被真中间件真 D1 检验的。
 *
 * 由此留下的唯一缺口：`上游连不上 → 502` 这条链路没有端到端覆盖（旧
 * `functions/api/jev.js` 正是在这里会漏成 500）。本文件用 `statusFor` 单测钉住
 * 「502 这个数字」加代码走查兜住它，需要真跑请见报告里那条手工 curl。
 *
 * ⚠️ 集成点：`SELF.fetch('…/api/jev')` 只有在 `src/worker/index.ts` 里
 * `api.route('/jev', jevRoute)` 之后才通。本文件用 `buildApp()` 兜住两种状态
 * （挂了就用真 app，没挂就临时装一个），免得「编排者还没接线」把这份测试变成一片红。
 * 走真 app 时是端到端的 `SELF.fetch`，兜底时用 `app.fetch(request, env)`——同一个
 * Hono 应用对象、同一套中间件、同一个 D1 绑定，差别只在最外层 `app.route('/api', api)`。
 */
import { SELF, env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { app as indexApp } from '../../src/worker/index.ts';
import { jevRoute, parseJevRequest, providerAttempts } from '../../src/worker/routes/jev.ts';
import { statusFor } from '../../src/worker/lib/http.ts';
import { callUpstreamWithFailover, type UpstreamAttempt } from '../../src/worker/lib/failover.ts';
import { PROVIDER_BACKUP, PROVIDER_PRIMARY, providerOf } from '../../src/core/jev/providers.ts';
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UPSTREAM_URL,
  callUpstream,
  passthroughHeaders,
  toPassthroughResponse,
  upstreamFailureMessage,
} from '../../src/worker/lib/upstream.ts';
import type { AppEnv } from '../../src/worker/types.ts';

const JEV_URL = 'https://example.com/api/jev';

/**
 * 每个用例前清空限流桶：jev 桶是 30/分，同一文件的用例累计起来必然撞。
 *
 * 这个请求体是**故意过不了形状校验**的，用来在不接触上游的前提下走完整条链路并消耗桶
 * ——原因见文件头注。为什么不是 `{state:{}, questions:3}`：key 的检查在 `questions`
 * 之前，缺 key 会先撞出 401；这里带上一个假 key，才会走到 `questions` 那步拿到 400。
 */
const TICKET_ONLY: Record<string, unknown> = { apiKey: 'not-a-real-key', state: {}, questions: 3 };

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM rate_limits').run();
});

/* ────────────────────────── 1. 上游转发（注入假 fetcher） ────────────────────────── */

type FetchCall = { url: string; init: RequestInit };

/** 记录调用参数的假 fetcher；`respond` 决定返回什么（或抛什么）。 */
function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  fetcher: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('lib/upstream.ts（注入假 fetcher，不碰网络）', () => {
  it('请求头/请求体与旧实现逐字一致，且不透传多余字段', async () => {
    const { fetcher, calls } = fakeFetch(
      () => new Response(JSON.stringify({ model: 'jev-latest', answers: {} }), { status: 200 }),
    );

    const result = await callUpstream({
      apiKey: 'sk-test-123',
      body: { state: { board: 'x' }, model: DEFAULT_MODEL, questions: { move: 1 } },
      fetcher,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DEFAULT_UPSTREAM_URL); // 与旧实现同端点

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-123'); // 旧实现就是 'Bearer ' + KEY
    expect(headers['Content-Type']).toBe('application/json');
    // 不能有任何额外头（旧实现只有这两个）
    expect(Object.keys(headers).sort()).toEqual(['Authorization', 'Content-Type']);

    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      state: { board: 'x' },
      model: 'jev-latest',
      questions: { move: 1 },
    });
  });

  it('上游 4xx/5xx 原样透传状态码（不是 502）', async () => {
    for (const status of [400, 401, 422, 429, 500, 529]) {
      const { fetcher } = fakeFetch(
        () =>
          new Response('upstream says no', {
            status,
            headers: { 'content-type': 'application/json', 'retry-after': '7' },
          }),
      );
      const result = await callUpstream({ apiKey: 'k', body: {}, fetcher });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(status);

      const response = toPassthroughResponse(result);
      expect(response.status).toBe(status);
      expect(response.headers.get('retry-after')).toBe('7');
      expect(await response.text()).toBe('upstream says no');
    }
  });

  it('流式响应不缓冲：拿到的 body 就是上游那条可读流', async () => {
    const chunk = new TextEncoder().encode('data: {"delta":"h8"}\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const { fetcher } = fakeFetch(
      () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );

    const result = await callUpstream({ apiKey: 'k', body: {}, fetcher });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).not.toBeNull();

    const response = toPassthroughResponse(result);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    // 逐块读出，内容与上游写入的完全一致（没有被 JSON 化或重新分块）
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: {"delta":"h8"}\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('超时：按注入的 timeoutMs 中止，返回 kind=timeout 且不泄漏 key', async () => {
    // 假 fetcher 老老实实等信号——模拟「上游不响应」
    const { fetcher } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    const result = await callUpstream({ apiKey: 'sk-secret', body: {}, timeoutMs: 30, fetcher });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('timeout');
    expect(result.errorName).toBe('AbortError');
    // 失败对象里只有分类信息，没有任何原文（原文可能带 URL/头）
    expect(JSON.stringify(result)).not.toContain('sk-secret');
    expect(upstreamFailureMessage(result.kind, 30)).toContain('上游请求超时');
    // 默认超时与旧实现三处一致
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('网络错误：kind=network，文案不泄漏内部信息', async () => {
    const { fetcher } = fakeFetch(() => {
      throw new TypeError('Network connection lost');
    });
    const result = await callUpstream({ apiKey: 'sk-secret', body: {}, fetcher });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('network');
    expect(result.errorName).toBe('TypeError');
    expect(upstreamFailureMessage(result.kind)).toContain('上游请求失败');
    expect(upstreamFailureMessage(result.kind)).not.toContain('TypeError');
  });

  it('客户端中止：kind=aborted（与超时分开，日志里是两件事）', async () => {
    const outer = new AbortController();
    const { fetcher } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          (call.init.signal as AbortSignal).addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    const pending = callUpstream({ apiKey: 'k', body: {}, timeoutMs: 5_000, signal: outer.signal, fetcher });
    outer.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('aborted');
  });

  it('空 key 不发请求', async () => {
    const { fetcher, calls } = fakeFetch(() => new Response('{}'));
    const result = await callUpstream({ apiKey: '   ', body: {}, fetcher });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('响应头白名单：不搬运 content-encoding（否则下游会二次解压）', () => {
    const from = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'set-cookie': 'a=b',
      'x-internal': 'secret',
    });
    const headers = passthroughHeaders(from);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('content-encoding')).toBeNull();
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.get('x-internal')).toBeNull();
    // 上游没给 content-type 时回落 JSON（旧实现写死的值）
    expect(passthroughHeaders(new Headers()).get('content-type')).toBe('application/json');
  });

  it('鉴权头不会从上游回传到客户端（白名单顺带堵住）', async () => {
    /* 上游若在响应里回显 `Authorization` / `X-Api-Key`（匿名 401 有时会带上原请求信息），
     * 白名单策略天然把它挡在外面。这是「任何路径都不得把 Authorization 交出去」的回归钉子。 */
    const { fetcher } = fakeFetch(
      () =>
        new Response('{}', {
          status: 401,
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer sk-secret',
            'x-api-key': 'sk-secret',
          },
        }),
    );

    const result = await callUpstream({ apiKey: 'sk-secret', body: {}, fetcher });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const response = toPassthroughResponse(result);
    expect(response.status).toBe(401); // 状态码仍原样透传
    expect(response.headers.get('authorization')).toBeNull();
    expect(response.headers.get('x-api-key')).toBeNull();
    expect(JSON.stringify([...response.headers])).not.toContain('sk-secret');
  });
});

/* ────────────────────────── 1b. 兜底切换（C2，注入假 fetcher） ────────────────────────── */

describe('lib/failover.ts（注入假 fetcher，不碰网络）', () => {
  const primary = providerOf(PROVIDER_PRIMARY)!;
  const backup = providerOf(PROVIDER_BACKUP)!;
  const body = { state: {}, model: 'jev-latest', questions: { move: {} } };

  /** 两个提供方按优先级排好；兜底的 body 与路由里一样覆盖 model。 */
  function attempts(): UpstreamAttempt[] {
    return [
      { provider: primary, apiKey: 'primary-key' },
      { provider: backup, apiKey: 'backup-key', body: { ...body, model: backup.model } },
    ];
  }

  it('401 ⇒ 探活备用 ⇒ 换家，并且**换家就换模型名**', async () => {
    const { fetcher, calls } = fakeFetch((call) => {
      if (call.url === primary.url) return new Response('{"error":"bad key"}', { status: 401 });
      if (call.url === backup.probeUrl) return new Response('{"data":[]}', { status: 200 });
      if (call.url === backup.url) return new Response('{"model":"typesafe/jev","answers":{}}', { status: 200 });
      return new Response('{}', { status: 500 });
    });

    const out = await callUpstreamWithFailover({ attempts: attempts(), body, fetcher });
    expect(out.providerId).toBe('backup');
    expect(out.upstreamCalls).toBe(2); /* 主家一次 + 兜底一次；探活不算上游业务调用 */
    expect(calls.map((c) => c.url)).toEqual([primary.url, backup.probeUrl, backup.url]);
    const sent = JSON.parse(String(calls[2].init.body)) as { model: string };
    expect(sent.model).toBe('typesafe/jev');
    expect(out.switchInfo).toMatchObject({ from: 'primary', to: 'backup', probeStatus: 200 });
    expect(out.switchInfo?.reason).toContain('401');
  });

  it('备用探活不过 ⇒ 不切，把主家的原响应透传出去（只在 switchInfo 里如实记一笔）', async () => {
    const { fetcher, calls } = fakeFetch((call) => {
      if (call.url === primary.url) return new Response('{"error":"bad key"}', { status: 401 });
      return new Response('{"error":"probe down"}', { status: 503 });
    });

    const out = await callUpstreamWithFailover({ attempts: attempts(), body, fetcher });
    expect(out.providerId).toBe('primary');
    expect(out.result.ok && out.result.status).toBe(401); /* 主家的错误原样交出去 */
    expect(calls.some((c) => c.url === backup.url)).toBe(false); /* 没碰兜底的业务端点 */
    expect(out.switchInfo?.reason).toContain('备用探活未通过');
    expect(out.switchInfo?.probeStatus).toBe(503);
  });

  it('429 在 Worker 面一次即切（每请求独立，没有跨请求的退避计数可数）', async () => {
    const { fetcher, calls } = fakeFetch((call) => {
      if (call.url === primary.url) return new Response('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '3' } });
      if (call.url === backup.probeUrl) return new Response('{"data":[]}', { status: 200 });
      return new Response('{"answers":{}}', { status: 200 });
    });

    const out = await callUpstreamWithFailover({ attempts: attempts(), body, fetcher });
    expect(out.providerId).toBe('backup');
    expect(calls.filter((c) => c.url === primary.url).length).toBe(1);
    expect(out.switchInfo?.reason).toContain('429');
  });

  it('5xx 先在本家连试到阈值才切（一次抖动不该把备用也搭进去）', async () => {
    let primaryHits = 0;
    const { fetcher, calls } = fakeFetch((call) => {
      if (call.url === primary.url) {
        primaryHits++;
        return new Response('{"error":"boom"}', { status: 503 });
      }
      if (call.url === backup.probeUrl) return new Response('{"data":[]}', { status: 200 });
      return new Response('{"answers":{}}', { status: 200 });
    });

    const out = await callUpstreamWithFailover({ attempts: attempts(), body, fetcher });
    expect(primaryHits).toBe(3); /* 三次都在主家内部，第三次才决定换家 */
    expect(out.providerId).toBe('backup');
    expect(calls[calls.length - 1].url).toBe(backup.url);
    expect(out.switchInfo?.reason).toContain('503');

    /* 只有一家时没有「连续」可言：一次 5xx 就原样交出去 */
    let solo = 0;
    const alone = await callUpstreamWithFailover({
      attempts: [{ provider: primary, apiKey: 'k' }],
      body,
      fetcher: fakeFetch(() => {
        solo++;
        return new Response('{"error":"boom"}', { status: 503 });
      }).fetcher,
    });
    expect(solo).toBe(1);
    expect(alone.result.ok && alone.result.status).toBe(503);
  });

  it('4xx（请求本身有问题）不切；网络错/超时也不切', async () => {
    const bad = await callUpstreamWithFailover({
      attempts: attempts(),
      body,
      fetcher: fakeFetch((call) => (call.url === primary.url ? new Response('{"error":"bad"}', { status: 400 }) : new Response('{}', { status: 200 }))).fetcher,
    });
    expect(bad.providerId).toBe('primary');
    expect(bad.switchInfo).toBeNull();

    const { fetcher, calls } = fakeFetch((call) => {
      if (call.url === primary.url) throw new Error('socket hang up');
      return new Response('{}', { status: 200 });
    });
    const net = await callUpstreamWithFailover({ attempts: attempts(), body, fetcher, timeoutMs: 50 });
    expect(net.result.ok).toBe(false);
    expect(net.providerId).toBe('primary');
    expect(net.switchInfo).toBeNull();
    expect(calls.length).toBe(1); /* 网络错不换家：换过去只会把失败原因搅浑 */
  });

  it('只有一家时退化成原样转发：不探活、不换家、不加头', async () => {
    const { fetcher, calls } = fakeFetch(() => new Response('{"error":"bad key"}', { status: 401 }));
    const out = await callUpstreamWithFailover({ attempts: [{ provider: primary, apiKey: 'k' }], body, fetcher });
    expect(out.providerId).toBe('primary');
    expect(out.switchInfo).toBeNull();
    expect(calls.length).toBe(1);
  });
});

describe('providerAttempts（路由的上游策略，纯函数）', () => {
  const envOff = { JEV_FAILOVER: 'off' };

  it('没有兜底 key ⇒ 永远只有一个尝试（行为与加兜底之前逐字相同）', () => {
    const list = providerAttempts(envOff, null, 'byok', { state: {}, model: 'jev-latest', questions: {} });
    expect(list.length).toBe(1);
    expect(list[0].provider.id).toBe('primary');
    expect(list[0].apiKey).toBe('byok');
    expect(list[0].body).toBeUndefined();
  });

  it('默认关（JEV_FAILOVER 非 on）⇒ 只有显式提示头才带兜底', () => {
    const env = { COMMANDCODE_API_KEY: 'cc-key', JEV_FAILOVER: 'off' };
    const args = { state: {}, model: 'jev-latest', questions: {} } as const;
    expect(providerAttempts(env, null, 'byok', { ...args }).length).toBe(1);
    expect(providerAttempts(env, 'primary', 'byok', { ...args }).length).toBe(1);

    const hinted = providerAttempts(env, 'backup', 'byok', { ...args });
    expect(hinted.length).toBe(2);
    expect(hinted[1].provider.id).toBe('backup');
    expect(hinted[1].apiKey).toBe('cc-key');
    /* 兜底的 body 必须换成它认得的模型名，其余字段与主家一致 */
    expect(hinted[1].body).toEqual({ state: {}, model: 'typesafe/jev', questions: {} });
    expect(hinted[0].body).toBeUndefined();
  });

  it('JEV_FAILOVER=on ⇒ 自动带上兜底（大小写与空白都容忍）', () => {
    for (const flag of ['on', 'ON', ' on ']) {
      const list = providerAttempts({ COMMANDCODE_API_KEY: 'cc', JEV_FAILOVER: flag }, null, 'byok', { state: {}, model: 'jev-latest', questions: {} });
      expect(list.length).toBe(2);
    }
    /* key 只有空白等于没配 */
    const blank = providerAttempts({ COMMANDCODE_API_KEY: '   ', JEV_FAILOVER: 'on' }, null, 'byok', { state: {}, model: 'jev-latest', questions: {} });
    expect(blank.length).toBe(1);
  });
});

/* ────────────────────────── 2. 形状校验（纯函数） ────────────────────────── */

describe('parseJevRequest', () => {
  const okBody = { state: { turn: 1 }, questions: { move: {} } };

  it('key 优先级：请求头 > env > 请求体（旧实现前两段，新增第三段）', () => {
    const header = parseJevRequest(
      { ...okBody, apiKey: 'from-body' },
      { headerKey: 'from-header', envKey: 'from-env' },
    );
    expect(header.ok && header.value.apiKey === 'from-header' && header.value.keySource === 'header').toBe(true);

    const fromEnv = parseJevRequest({ ...okBody, apiKey: 'from-body' }, { headerKey: null, envKey: 'from-env' });
    expect(fromEnv.ok && fromEnv.value.apiKey === 'from-env' && fromEnv.value.keySource === 'env').toBe(true);

    const fromBody = parseJevRequest({ ...okBody, apiKey: ' from-body ' }, { headerKey: null });
    // 顺手 trim：设置面板粘进来的 key 常带空白，旧实现不 trim 会白挨一个上游 401
    expect(fromBody.ok && fromBody.value.apiKey === 'from-body' && fromBody.value.keySource === 'body').toBe(true);
  });

  it('缺 key → unauthorized / 缺 state / questions 形状不对 → bad_request', () => {
    const noKey = parseJevRequest(okBody, { headerKey: null });
    expect(!noKey.ok && noKey.code === 'unauthorized' && noKey.message.includes('API Key')).toBe(true);

    const noState = parseJevRequest({ questions: {} }, { headerKey: 'k' });
    expect(!noState.ok && noState.code === 'bad_request').toBe(true);

    for (const questions of [undefined, null, 'move', 3]) {
      const bad = parseJevRequest({ state: {}, questions }, { headerKey: 'k' });
      expect(!bad.ok && bad.code === 'bad_request').toBe(true);
    }

    for (const raw of [null, 'x', 42, []]) {
      const bad = parseJevRequest(raw, { headerKey: 'k' });
      expect(!bad.ok && bad.code === 'bad_request').toBe(true);
    }
  });

  it('model 缺省 jev-latest（旧实现同值），非字符串回落缺省', () => {
    const value = (model: unknown) => {
      const parsed = parseJevRequest({ ...okBody, model }, { headerKey: 'k' });
      expect(parsed.ok).toBe(true);
      return parsed.ok ? parsed.value.body.model : '';
    };
    expect(value(undefined)).toBe('jev-latest');
    expect(value('')).toBe('jev-latest');
    expect(value('jev-pro')).toBe('jev-pro');
  });
});

/* ────────────────────────── 3. 路由链路 ────────────────────────── */

/** `index.ts` 是否已经把 jevRoute 挂上（编排者的活）；没挂就用临时 app 兜底。 */
const mountedOnIndex = indexApp.routes.some((r) => r.path === '/api/jev' && r.method === 'POST');

function buildApp(): Hono<AppEnv> {
  if (mountedOnIndex) return indexApp;
  const app = new Hono<AppEnv>();
  app.route('/api/jev', jevRoute);
  return app;
}

/** 走真 app 时用 `SELF.fetch`（端到端），兜底时用 `app.fetch(request, env)`（同一套中间件）。 */
async function postJev(payload: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  };
  if (mountedOnIndex) return SELF.fetch(JEV_URL, init);
  // `app.fetch()` 的类型里带同步重载，`Response` 也在其中；`await` 对两边都成立。
  return await buildApp().fetch(new Request(JEV_URL, init), env);
}

async function requestJev(init: RequestInit): Promise<Response> {
  if (mountedOnIndex) return SELF.fetch(JEV_URL, init);
  return await buildApp().fetch(new Request(JEV_URL, init), env);
}

describe('POST /api/jev（真中间件链 + 真 D1）', () => {
  it('缺 apiKey → 401 unauthorized，且 code/文案明确', async () => {
    const res = await postJev({ state: {}, questions: { move: {} } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code: string; requestId: string };
    expect(body.code).toBe('unauthorized');
    expect(body.error).toContain('未提供 API Key');
    expect(body.error).toContain('Jev 设置');
  });

  it('非法 JSON → 400（旧 Pages 版是 422，计划 §5.5 定为 400）', async () => {
    const res = await postJev('{not json');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('bad_request');
    expect(body.error).toContain('JSON');
  });

  it('空体 / 缺 state / 非法 questions → 400', async () => {
    expect((await postJev('')).status).toBe(400);

    const noState = await postJev({ apiKey: 'k', questions: {} });
    expect(noState.status).toBe(400);
    expect(((await noState.json()) as { error: string }).error).toContain('state');

    const badQuestions = await postJev({ apiKey: 'k', state: {} });
    expect(badQuestions.status).toBe(400);
    expect(((await badQuestions.json()) as { error: string }).error).toContain('questions');
  });

  it('限流：桶满后 429 且带 Retry-After（限额从响应头现读）', async () => {
    /* 用「过不了形状校验」的请求体：它在调上游之前就返回 400，所以这段循环不接触网络，
     * 但每次都会消耗桶——限流是 D1 固定窗口，挡在桶满后的第一次。
     *
     * 限额**不写死** 30：`wrangler.jsonc` 的 `JEV_RATE_LIMIT_PER_MIN` 可调（2026-10-01 起
     * 生产是 60，因为 30 会被产品自带的机机对局顶穿），写死数字会让这份用例随配置变脆。
     * 读服务端自己广告的 `X-RateLimit-Limit` 才是在测「桶真的会满」这件事本身。 */
    const first = await postJev(TICKET_ONLY);
    expect(first.status).toBe(400);
    const limit = Number(first.headers.get('x-ratelimit-limit'));
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBeGreaterThan(0);
    expect(Number(first.headers.get('x-ratelimit-remaining'))).toBe(limit - 1);

    for (let i = 1; i < limit; i++) {
      const res = await postJev(TICKET_ONLY);
      expect(res.status).toBe(400);
    }

    const limited = await postJev(TICKET_ONLY);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { code: string; requestId: string | null };
    expect(body.code).toBe('rate_limited');
    expect(body.requestId === null || typeof body.requestId === 'string').toBe(true);
    expect(Number(limited.headers.get('x-ratelimit-remaining'))).toBe(0);

    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    // 固定窗口是 60s，所以剩余秒数不超过 60 且为正
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('OPTIONS 预检在限流之前处理（204 + CORS 头，不占桶）', async () => {
    const res = await requestJev({ method: 'OPTIONS', headers: { origin: 'https://example.com' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
    expect(res.headers.get('access-control-allow-headers')).toContain('X-Api-Key');

    // 预检不该消耗限流桶：紧接着打几次 POST 仍然不该 429（且剩余额度没有因预检减少）
    const first = await postJev(TICKET_ONLY);
    const limit = Number(first.headers.get('x-ratelimit-limit'));
    expect(Number(first.headers.get('x-ratelimit-remaining'))).toBe(limit - 1);
    for (let i = 0; i < 4; i++) {
      const post = await postJev(TICKET_ONLY);
      expect(post.status).toBe(400);
    }
  });

  it('`upstream_error` 的映射是 502（链路里唯一没端到端覆盖的一段）', () => {
    /* 为什么只能这样测：见文件头注「这份测试为什么不碰网络」。这里钉住的是**数字**——
     * 502 而不是 500，这正是旧 `functions/api/jev.js` 缺 try/catch 时漏掉的那个语义。
     * 路由那侧的代码走查：`if (!result.ok) return fail(c, invalid('upstream_error', …))`
     * 与 `fail`/`statusFor` 共用同一张表，所以这张表对了，502 就成立。 */
    expect(statusFor('upstream_error')).toBe(502);
    expect(statusFor('rate_limited')).toBe(429);
    expect(statusFor('bad_request')).toBe(400);
    expect(statusFor('unauthorized')).toBe(401);
    expect(statusFor('internal')).toBe(500);
  });
});
