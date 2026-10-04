/**
 * `src/core/jev/client.ts` 的兜底切换（C2 / D-B2、D-B3、D-B5）。
 *
 * 触发条件三条（计划 §5 的验收口径）：**401/402/403**、**429 退避用尽**、**连续 3 次 5xx**。
 * 三条都要「先探活备用、探活过了才切」；探活不过就不切（切过去只是把同一个错换个文案），
 * 而且**没配兜底 key 时行为必须与加兜底之前逐字相同**——否则等于给所有老用户改了行为。
 *
 * 假时钟同 `jev-retry.spec.ts`：`sleep` 走真实 `setTimeout`，所以必须手动推进。
 * 夹具 `test/fixtures/jev/commandcode-systemone-2026-10-03.json` 是 2026-10-04 在 box 上
 * 用**我方真实三问**打真网关抓下来的一对请求/响应（见该文件 `capturedAt`）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decide } from '../../src/core/jev/client.ts';
import { getGame } from '../../src/core/registry.ts';
import type { ProviderSwitchInfo } from '../../src/core/jev/providers.ts';
import type { DecideOpts } from '../../src/core/tactics.ts';

const gomoku = getGame('gomoku');
if (!gomoku) throw new Error('注册表里没有 gomoku，夹具失效');

const PRIMARY_URL = 'https://api.typesafe.ai/v1/systemone';
const PRIMARY_PROBE = 'https://api.typesafe.ai/v1/models';
const BACKUP_URL = 'https://api.commandcode.ai/provider/v1/systemone';
const BACKUP_PROBE = 'https://api.commandcode.ai/provider/v1/models';

interface Fixture {
  capturedAt: string;
  endpoint: string;
  httpStatus: number;
  request: { model: string; state: Record<string, unknown>; questions: Record<string, { type: string }>; options: string[] };
  response: Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/jev/commandcode-systemone-2026-10-03.json', import.meta.url), 'utf8'),
) as Fixture;

/** 一局初始局面 + 一个合法着法。 */
function position(): { st: unknown; notation: string } {
  const st = gomoku!.newGame();
  const first = gomoku!.getLegalMoves(st)[0];
  if (!first) throw new Error('初始局面没有合法着法，夹具失效');
  return { st, notation: first.notation };
}

function okBody(notation: string): Record<string, unknown> {
  return {
    model: 'typesafe/jev',
    answers: { move: { probabilities: { [notation]: 1 }, confidence: 0.9 } },
    usage: { input_tokens: 12 },
  };
}

type Call = { url: string; method: string; body: unknown };

/**
 * 按 URL 分派的假 fetch：每个用例只描述「谁回什么」，调用序列由 `calls` 现读。
 * `handle` 返回 undefined 时按 500 处理（漏配的路径要在断言里显形，而不是静默成功）。
 */
function stubRouted(handle: (url: string, call: Call) => Response | undefined): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const call: Call = { url, method: (init?.method || 'GET').toUpperCase(), body: typeof raw === 'string' ? JSON.parse(raw) : undefined };
    calls.push(call);
    return handle(url, call) ?? new Response('{"error":"unhandled in stub"}', { status: 500 });
  }) as typeof fetch);
  return { calls };
}

const post = (n: number, body: unknown) => new Response(JSON.stringify(body), { status: n });
const err = (n: number, headers: Record<string, string> = {}) => new Response('{"error":"test"}', { status: n, headers });

async function settle<T>(p: Promise<T>, maxSeconds = 400): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  let out: { ok: true; value: T } | { ok: false; error: Error } | null = null;
  void p.then(
    (value) => { out = { ok: true, value }; },
    (error: Error) => { out = { ok: false, error }; },
  );
  for (let i = 0; i < maxSeconds && out === null; i++) await vi.advanceTimersByTimeAsync(1000);
  if (out === null) throw new Error(`假时钟推进 ${maxSeconds} 秒后仍未落定`);
  return out;
}

function run(st: unknown, opts: Record<string, unknown>): ReturnType<typeof decide> {
  return decide(gomoku!, st, 'black', { channel: 'official', apiKey: 'primary-key', tacticsVersion: 'v0-off', ...opts } as DecideOpts);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('jev 兜底：401（key/额度废了）', () => {
  it('主家 401 ⇒ 探活备用 ⇒ 切过去用备用模型名答完，并把切换事件交出来', async () => {
    const { st, notation } = position();
    const switches: ProviderSwitchInfo[] = [];
    const { calls } = stubRouted((url) => {
      if (url === PRIMARY_URL) return err(401);
      if (url === BACKUP_PROBE) return post(200, { data: [] });
      if (url === BACKUP_URL) return post(200, okBody(notation));
      return undefined;
    });

    const out = await settle(run(st, { backupApiKey: 'backup-key', onProviderSwitch: (i: ProviderSwitchInfo) => switches.push(i) }));
    if (!out.ok) throw out.error;

    expect(out.value.notation).toBe(notation);
    expect((out.value.meta as Record<string, unknown>).provider).toBe('backup');
    expect((out.value.meta as Record<string, unknown>).probSource).toBe('exact');

    /* 顺序：先主家 POST（401）⇒ 探活 GET ⇒ 备用 POST。没有多余的试探。 */
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${PRIMARY_URL}`,
      `GET ${BACKUP_PROBE}`,
      `POST ${BACKUP_URL}`,
    ]);
    /* 换家必须换模型名：主家那套 `jev-latest` 送给兜底网关是 400（C1 实测） */
    expect((calls[2]!.body as { model: string }).model).toBe('typesafe/jev');
    expect((calls[0]!.body as { model: string }).model).toBe('jev-latest');

    expect(switches.length).toBe(1);
    expect(switches[0]).toMatchObject({ from: 'primary', to: 'backup' });
    expect(switches[0]!.reason).toContain('401');
    expect(switches[0]!.probeStatus).toBe(200);
  });

  it('备用探活不过 ⇒ 不切、不碰备用端点，原样抛主家的错', async () => {
    const { st } = position();
    const switches: ProviderSwitchInfo[] = [];
    const { calls } = stubRouted((url) => {
      if (url === PRIMARY_URL) return err(401);
      if (url === BACKUP_PROBE) return err(503);
      return undefined;
    });

    const out = await settle(run(st, { backupApiKey: 'backup-key', onProviderSwitch: (i: ProviderSwitchInfo) => switches.push(i) }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('不该成功');
    expect(out.error.message).toContain('401');
    expect(calls.some((c) => c.url === BACKUP_URL)).toBe(false);
    expect(switches.length).toBe(1); /* 如实报「探活没过」，但不切 */
    expect(switches[0]!.reason).toContain('备用探活未通过');
    expect(switches[0]!.probeStatus).toBe(503);
  });

  it('没配 backupApiKey ⇒ 老行为逐字不变：只打一次主家，错误文案与加兜底之前相同', async () => {
    const { st } = position();
    const { calls } = stubRouted((url) => (url === PRIMARY_URL ? err(401) : undefined));

    const out = await settle(run(st, {}));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('不该成功');
    expect(out.error.message).toBe('API Key 无效或缺失（401）——若 key 确认无误（「测试连接」通过），可能是服务端瞬时故障，稍后点「重试」即可');
    expect((out.error as Error & { retryable?: boolean }).retryable).toBe(false);
    expect(calls.length).toBe(1);
  });
});

describe('jev 兜底：429（退避用尽）与 5xx（连续三次）', () => {
  it('主家连续 429（退避重试用尽）⇒ 切备用；重试阶梯仍是 5 次尝试', async () => {
    const { st, notation } = position();
    const { calls } = stubRouted((url) => {
      if (url === PRIMARY_URL) return err(429, { 'Retry-After': '1' });
      if (url === BACKUP_PROBE) return post(200, { data: [] });
      if (url === BACKUP_URL) return post(200, okBody(notation));
      return undefined;
    });

    const out = await settle(run(st, { backupApiKey: 'backup-key' }));
    if (!out.ok) throw out.error;

    const primaryCalls = calls.filter((c) => c.url === PRIMARY_URL);
    expect(primaryCalls.length).toBe(5); /* RATE_LIMIT_ATTEMPTS：1 + 4 次退避 */
    expect((out.value.meta as Record<string, unknown>).provider).toBe('backup');
    expect(out.value.notation).toBe(notation);
  });

  it('主家连续两次 5xx 还不切（可能只是抖动），第三次才切', async () => {
    const { st, notation } = position();
    let primaryHits = 0;
    const { calls } = stubRouted((url) => {
      if (url === PRIMARY_URL) {
        primaryHits++;
        /* 第 3 次才切：前两次必须是真失败，否则这个用例什么都没验证 */
        return err(503);
      }
      if (url === BACKUP_PROBE) return post(200, { data: [] });
      if (url === BACKUP_URL) return post(200, okBody(notation));
      return undefined;
    });

    const out = await settle(run(st, { backupApiKey: 'backup-key' }));
    if (!out.ok) throw out.error;
    expect(primaryHits).toBe(3);
    expect(calls.filter((c) => c.url === BACKUP_PROBE).length).toBe(1);
    expect((out.value.meta as Record<string, unknown>).provider).toBe('backup');
  });

  it('主家 400（请求本身有问题）不切：换家也一样会被拒，只会把失败原因搅浑', async () => {
    const { st } = position();
    const { calls } = stubRouted((url) => (url === PRIMARY_URL ? err(400) : undefined));

    const out = await settle(run(st, { backupApiKey: 'backup-key' }));
    expect(out.ok).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(PRIMARY_URL);
  });

  it("粘滞：`providerSticky='backup'` 时第一手就直接用备用（不再试主家）", async () => {
    const { st, notation } = position();
    const { calls } = stubRouted((url) => (url === BACKUP_URL ? post(200, okBody(notation)) : undefined));

    const out = await settle(run(st, { backupApiKey: 'backup-key', providerSticky: 'backup' }));
    if (!out.ok) throw out.error;
    expect(calls.map((c) => c.url)).toEqual([BACKUP_URL]);
    expect((out.value.meta as Record<string, unknown>).provider).toBe('backup');
  });
});

describe('离线夹具：钉住兜底网关的真实形状（C1 抓取）', () => {
  it('夹具是「我方三问 ⇒ 200 带逐点概率」那一对，且请求形状与我们发的一致', () => {
    expect(fixture.capturedAt.startsWith('2026-10-04')).toBe(true);
    expect(fixture.endpoint).toBe(BACKUP_URL);
    expect(fixture.httpStatus).toBe(200);

    /* 请求：model 用兜底的名字，三问的类型是 choice / noul / score，选项与 legal_moves 同集合 */
    expect(fixture.request.model).toBe('typesafe/jev');
    expect(Object.keys(fixture.request.questions).sort()).toEqual(['edge', 'move', 'position']);
    expect(fixture.request.questions.move!.type).toBe('choice');
    expect(fixture.request.questions.edge!.type).toBe('noul');
    expect(fixture.request.questions.position!.type).toBe('score');
    expect(fixture.request.options.length).toBe(6);

    /* 响应：我们真正读的是 answers.move.probabilities / confidence / edge / position / usage */
    const answers = fixture.response.answers as Record<string, Record<string, unknown>>;
    const probs = answers.move!.probabilities as Record<string, number>;
    expect(Object.keys(probs).length).toBe(6);
    for (const v of Object.values(probs)) expect(typeof v).toBe('number');
    expect(typeof answers.move!.confidence).toBe('number');
    expect(typeof answers.edge!.noul).toBe('number');
    expect(typeof answers.position!.score).toBe('number');
    expect(typeof (fixture.response.usage as Record<string, number>).input_tokens).toBe('number');
  });

  it('把夹具的真实响应体当兜底回执喂进去：六点概率全部被认成合法候选，标记 exact', async () => {
    const { st } = position();
    const legal = new Set(gomoku!.getLegalMoves(st).map((m) => m.notation));
    const probs = ((fixture.response.answers as Record<string, Record<string, unknown>>).move as { probabilities: Record<string, number> }).probabilities;
    for (const n of Object.keys(probs)) expect(legal.has(n)).toBe(true);

    const { calls } = stubRouted((url) => {
      if (url === PRIMARY_URL) return err(401);
      if (url === BACKUP_PROBE) return post(200, { data: [] });
      if (url === BACKUP_URL) return post(200, fixture.response);
      return undefined;
    });

    const out = await settle(run(st, { backupApiKey: 'backup-key' }));
    if (!out.ok) throw out.error;
    const meta = out.value.meta as Record<string, unknown>;
    expect(meta.provider).toBe('backup');
    expect(meta.probSource).toBe('exact');
    expect(meta.candidates).toBe(6); /* 六点全合法，没有因为形状差异被丢掉 */
    expect(meta.confidence).toBe(0.38);
    expect(calls.filter((c) => c.url === BACKUP_URL).length).toBe(1);
  });

  it('兜底只给 choice、不给逐点概率 ⇒ 标记 derived（候选点数这条指标在兜底手上不成立）', async () => {
    const { st, notation } = position();
    stubRouted((url) => {
      if (url === PRIMARY_URL) return err(401);
      if (url === BACKUP_PROBE) return post(200, { data: [] });
      if (url === BACKUP_URL) return post(200, { model: 'typesafe/jev', answers: { move: { type: 'choice', choice: notation } } });
      return undefined;
    });

    const out = await settle(run(st, { backupApiKey: 'backup-key' }));
    if (!out.ok) throw out.error;
    const meta = out.value.meta as Record<string, unknown>;
    expect(meta.provider).toBe('backup');
    expect(meta.probSource).toBe('derived');
    /* 绝不把「没给概率」伪装成候选点数：这里回退到首个合法着法，candidates 记 0 */
    expect(meta.candidates).toBe(0);
  });
});
