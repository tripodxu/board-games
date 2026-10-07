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
import { CHANNELS } from '../../src/core/jev/client.ts';

interface Fixture {
  capturedAt: string;
  source: string;
  request: { model: string; state: string; questions: Record<string, { type: string; instructions: string }> };
  response: { model: string; answers: Record<string, { type: string; noul: number }>; usage: { input_tokens: number; output_tokens: number }; cost: string };
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/jev/opencode-systemone-2026-10-07.json', import.meta.url), 'utf8'),
) as Fixture;

describe('OpenCode Zen 渠道（免费 Jev 托管点）', () => {
  it('CHANNELS.opencode 三元组：systemone 端点 / jev-1.13-free / 独立 keyName', () => {
    const cfg = CHANNELS.opencode;
    expect(cfg).toBeDefined();
    expect(cfg.endpoint).toBe('https://opencode.ai/zen/v1/systemone');
    expect(cfg.model).toBe('jev-1.13-free');
    expect(cfg.keyName).toBe('opencode');
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
