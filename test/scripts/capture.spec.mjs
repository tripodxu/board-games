// test/scripts/capture.spec.mjs — 调用留存：鉴权头必须抹除、命中主机才记、写失败不抛（不联网）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installCallCapture, safeHeaders } from '../../scripts/lib/capture.mjs';

describe('safeHeaders', () => {
  it('抹除鉴权类头，保留其它头原值', () => {
    const h = safeHeaders({ headers: {
      Authorization: 'Bearer jv-secret',
      'X-Api-Key': 'sk-secret',
      Cookie: 'a=b',
      'Content-Type': 'application/json',
      'User-Agent': 'curl/8.5.0',
    } });
    expect(h).toEqual({ 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' });
    expect(JSON.stringify(h)).not.toMatch(/secret|jv-|Bearer/i);
  });
  it('数组 / Headers 形式都处理，大小写不敏感地抹敏感头', () => {
    expect(safeHeaders({ headers: [['authorization', 'x'], ['accept', 'y']] })).toEqual({ accept: 'y' });
    const out = safeHeaders({ headers: new Headers({ Authorization: 'x', 'X-Trace': 'y' }) });
    expect(out).not.toHaveProperty('authorization');
    expect(out['x-trace']).toBe('y');
  });
});

describe('installCallCapture', () => {
  let dir, file, cap;
  afterEach(() => { if (cap) cap.uninstall(); cap = null; if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } vi.restoreAllMocks(); });

  /** 注入一个假 fetch（capture 用 fetchImpl 调它），返回它、并让 globalThis.fetch 成为包装层。 */
  function harness({ hosts, responseBody = { answers: { move: { choice: 'H8' } } }, status = 200, throwOnCall = false } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'cap-'));
    file = join(dir, 'calls.jsonl');
    const fake = vi.fn(async () => {
      if (throwOnCall) throw new Error('network down');
      const bodyText = JSON.stringify(responseBody);
      return { ok: status < 400, status, clone() { return { text: async () => bodyText }; }, text: async () => bodyText };
    });
    cap = installCallCapture({ path: file, hosts, fetchImpl: fake });
    return fake;
  }
  const lines = () => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  it('命中主机的调用落盘：请求原文 + 响应，且不含鉴权头', async () => {
    harness({ hosts: ['api.typesafe.ai'] });
    await globalThis.fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { Authorization: 'Bearer SECRET', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-1.13.0', questions: { move: { type: 'choice' } } }),
    });
    const [rec] = lines();
    expect(rec.host).toBe('api.typesafe.ai');
    expect(rec.method).toBe('POST');
    expect(rec.body.model).toBe('jev-1.13.0');
    expect(rec.response.answers.move.choice).toBe('H8');
    expect(rec.status).toBe(200);
    expect(JSON.stringify(rec)).not.toMatch(/SECRET|Bearer/);   // 红线：key 不落盘
    expect(cap.stats()).toMatchObject({ captured: 1, errors: 0 });
  });

  it('不传 hosts ⇒ 记录一切；传 hosts ⇒ 非命中主机不写盘', async () => {
    harness({ hosts: ['api.typesafe.ai'] });
    await globalThis.fetch('https://evil.example/x', { method: 'GET' });
    expect(cap.stats()).toMatchObject({ captured: 0, passed: 1 });
    expect(() => lines()).toThrow();           // 未写任何行
  });

  it('不传 hosts 时对任意主机都记（official/网关共用一份配置）', async () => {
    harness({ hosts: undefined });
    await globalThis.fetch('http://172.18.0.4:8080/v1/systemone?leg=zen-o2a&strict=1', { method: 'POST', body: '{}' });
    expect(cap.stats().captured).toBe(1);
    expect(lines()[0].host).toBe('172.18.0.4');
  });

  it('fetch 抛错：记一行 error、原样上抛、计入 errors', async () => {
    const fake = harness({ hosts: ['h.io'], throwOnCall: true });
    void fake;
    await expect(globalThis.fetch('https://h.io/x', { method: 'GET' })).rejects.toThrow('network down');
    expect(cap.stats().errors).toBeGreaterThan(0);
    expect(lines()[0].error).toMatch(/network down/);
  });

  it('写盘失败（目录不存在）不抛给调用方，仅计 errors', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cap2-'));
    const fake = vi.fn(async () => ({ ok: true, status: 200, clone: () => ({ text: async () => '{}' }) }));
    cap = installCallCapture({ path: join(dir, 'no', 'such', 'calls.jsonl'), hosts: ['h.io'], fetchImpl: fake });
    const res = await globalThis.fetch('https://h.io/x', { method: 'GET' });
    expect(res.ok).toBe(true);
    expect(cap.stats().errors).toBeGreaterThan(0);
  });

  it('enabled=false ⇒ no-op，不替换 globalThis.fetch', () => {
    const before = globalThis.fetch;
    cap = installCallCapture({ path: '/x', enabled: false });
    expect(globalThis.fetch).toBe(before);
    expect(cap.stats().captured).toBe(0);
  });

  it('uninstall 还原到安装前的 fetch', () => {
    const orig = globalThis.fetch;
    harness({ hosts: [] });
    expect(globalThis.fetch).not.toBe(orig);
    cap.uninstall(); cap = null;
    expect(globalThis.fetch).toBe(orig);
  });
});
