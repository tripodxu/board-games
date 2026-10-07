/* local-relay.spec.mjs — 本地中转脚本的行为钉子（真实 HTTP 子进程 + 本地假上游）
 *
 * 覆盖：
 *   ① 预检（OPTIONS）：CORS 头齐全 + PNA 应答（Chrome https→本机的预检要求）；
 *   ② POST /api/jev 转发：带 key 时带 Authorization、匿名时不带；上游应答原样透传；
 *   ③ 防开放代理：model ≠ jev-1.13-free 一律 400（脚本不发往任何非白名单模型）；
 *   ④ GET /health 形状；未知路径 404；
 *   ⑤ 渠道清单含 opencode_local（客户端与脚本端点对齐的凭据）。
 * 出网隔离：脚本支持 UPSTREAM_URL 环境变量覆盖（默认真实端点）——spec 把它指到
 * 本地起的假上游，全部断言不出网。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', '..', 'scripts', 'local-relay.mjs');
const PORT = 18420;
const FAKE_UPSTREAM_PORT = 18421;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = 'jev-1.13-free';

/** 假上游：记录每个请求（头/体），按规则回 200 或 429。 */
const seen = [];
let upstreamStatus = 200;
const fakeUpstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const payload = upstreamStatus === 200
      ? JSON.stringify({ model: MODEL, answers: { move: { probabilities: { H8: 1 } }, confidence: 0.9 }, usage: { input_tokens: 10 }, cost: '0' })
      : JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' } });
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    res.end(payload);
  });
});

let relay;
beforeAll(async () => {
  await new Promise((r) => fakeUpstream.listen(FAKE_UPSTREAM_PORT, '127.0.0.1', r));
  relay = spawn(process.execPath, [SCRIPT, '--port', String(PORT)], {
    env: { ...process.env, UPSTREAM_URL: `http://127.0.0.1:${FAKE_UPSTREAM_PORT}/v1/systemone` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /* 等 relay 就绪（health 探测，最多 5s） */
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    await delay(100);
  }
  throw new Error('relay 未在 5s 内就绪');
});
afterAll(async () => {
  relay?.kill();
  fakeUpstream.close();
  await delay(50);
});

const preflight = async () => fetch(`${BASE}/api/jev`, {
  method: 'OPTIONS',
  headers: {
    'Origin': 'https://jevqipan.logicc.top',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type, x-api-key',
    'Access-Control-Request-Private-Network': 'true',
  },
});

describe('local-relay（本机中转：用户 IP + CORS + 防开放代理）', () => {
  it('health：形状与白名单自描述', async () => {
    const r = await fetch(`${BASE}/health`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.relay).toBe('opencode-local');
    expect(j.model).toBe(MODEL);
    expect(j.upstream).toBe(`http://127.0.0.1:${FAKE_UPSTREAM_PORT}/v1/systemone`); /* 如实回显 UPSTREAM_URL 覆盖 */
  });

  it('预检：ACAO/ACAH/ACAM 齐全 + PNA 应答（Chrome https→本机的预检要求）', async () => {
    const r = await preflight();
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-methods')).toContain('POST');
    expect(r.headers.get('access-control-allow-headers')).toContain('x-api-key');
    expect(r.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('匿名转发：请求到假上游、不带 Authorization、应答原样透传', async () => {
    seen.length = 0;
    const r = await fetch(`${BASE}/api/jev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: { turn: 1 }, questions: { move: {} } }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.answers.move.probabilities.H8).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/v1/systemone');
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it('带 key 转发：X-Api-Key 转成上游 Authorization: Bearer', async () => {
    seen.length = 0;
    await fetch(`${BASE}/api/jev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'oc_sk_user' },
      body: JSON.stringify({ model: MODEL, state: { turn: 1 }, questions: { move: {} } }),
    });
    expect(seen[0].headers.authorization).toBe('Bearer oc_sk_user');
  });

  it('上游 429 原样透传（含 FreeUsageLimitError 体，供客户端文案分支）', async () => {
    upstreamStatus = 429;
    try {
      const r = await fetch(`${BASE}/api/jev`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, state: { turn: 1 }, questions: { move: {} } }),
      });
      expect(r.status).toBe(429);
      const j = await r.json();
      expect(j.error.type).toBe('FreeUsageLimitError');
    } finally { upstreamStatus = 200; }
  });

  it('防开放代理：model ≠ jev-1.13-free 一律 400（不触上游）', async () => {
    seen.length = 0;
    const r = await fetch(`${BASE}/api/jev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet', state: {}, questions: { move: {} } }),
    });
    expect(r.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('未知路径 404', async () => {
    const r = await fetch(`${BASE}/nope`);
    expect(r.status).toBe(404);
  });

  it('渠道清单含 opencode_local 且端点与脚本默认端口对齐', async () => {
    const { CHANNELS } = await import('../../src/core/jev/client.ts');
    expect(CHANNELS.opencode_local).toMatchObject({
      endpoint: `http://127.0.0.1:${PORT}/api/jev`.replace(String(PORT), '8420'),
      model: MODEL,
      keyName: null,
    });
  });
});
