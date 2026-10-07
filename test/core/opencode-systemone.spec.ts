/* opencode-systemone.spec.ts — OpenCode Zen 渠道的协议形状钉子
 *
 * 2026-10-07 实测：https://opencode.ai/zen/v1/systemone 免费返回与 TypeSafe 官方
 * **逐字段同构**的系统一应答（answers.{type,noul} + usage + cost）——Jev 的免费托管点。
 * 本 spec 用真夹具钉住两件事：
 *   ① 渠道表里 opencode 的三元组（endpoint/model/keyName）；
 *   ② 夹具应答的形状仍是系统一协议（漂移时先红）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANNELS, OPENCODE_MODEL, OPENCODE_UPSTREAM_URL } from '../../src/core/jev/client.ts';
import { DEFAULT_SETTINGS } from '../../src/core/persist.ts';

interface Fixture {
  capturedAt: string;
  source: string;
  request: { model: string; state: string; questions: Record<string, { type: string; instructions: string }> };
  response: { model: string; answers: Record<string, { type: string; noul: number }>; usage: { input_tokens: number; output_tokens: number }; cost: string };
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/jev/opencode-systemone-2026-10-07.json', import.meta.url), 'utf8'),
) as Fixture;

describe('OpenCode Zen 渠道（免费 Jev 托管点 · 默认渠道）', () => {
  it('CHANNELS.opencode：同源中转端点（浏览器直连被 CORS 拦）/ jev-1.13-free / 独立 keyName', () => {
    const cfg = CHANNELS.opencode;
    expect(cfg).toBeDefined();
    expect(cfg.endpoint).toBe('api/jev'); /* 浏览器默认走同源中转 */
    expect(cfg.model).toBe('jev-1.13-free');
    expect(cfg.keyName).toBe('opencode');
    /* Node/实验面直连真实端点（与 Worker 侧 OPENCODE_UPSTREAM_URL 同值） */
    expect(OPENCODE_UPSTREAM_URL).toBe('https://opencode.ai/zen/v1/systemone');
    expect(OPENCODE_MODEL).toBe('jev-1.13-free');
  });

  it('默认渠道 = opencode 免费档（2026-10-07 业主定：零配置可玩）', () => {
    expect(DEFAULT_SETTINGS.channel).toBe('opencode');
  });

  it('夹具应答仍是系统一协议形状（answers.{type,noul} + usage + cost）', () => {
    const a = fixture.response.answers.q1;
    expect(a.type).toBe('noul');
    expect(typeof a.noul).toBe('number');
    expect(fixture.response.usage.input_tokens).toBeGreaterThan(0);
    expect(fixture.response.cost).toBe('0');
    expect(fixture.request.model).toBe('jev-1.13-free');
  });
});
