/* builtin-systemone.spec.ts — 内置免费渠道（ADR-0026）的形状钉子
 *
 * 2026-11-01 起：Worker 持服务端 jv- secret（`JEV_BUILTIN_API_KEY`），访客**无需填 key**
 * 匿名经同源 /api/jev 打自建网关。本 spec 钉住三件事：
 *   ① CHANNELS.builtin 三元组（同源中转 / 无 key 输入框）；
 *   ② model 哨兵与 jevrouter 成对——Worker 按 model 认腿，两边漂移即红；
 *   ③ 默认渠道 = builtin（2026-11-01 业主定），免 key 不被降级成 mock。
 */
import { describe, expect, it } from 'vitest';
import { CHANNELS, JEV_ROUTER_MODEL, JEV_ROUTER_UPSTREAM_URL } from '../../src/core/jev/client.ts';
import { DEFAULT_SETTINGS, effectiveChannelOf } from '../../src/core/persist.ts';

describe('内置免费渠道（Worker 持钥转发自建网关 · 默认渠道）', () => {
  it('CHANNELS.builtin：同源中转端点 / 与 jevrouter 同 model / 无 key 输入框', () => {
    const cfg = CHANNELS.builtin;
    expect(cfg).toBeDefined();
    expect(cfg.endpoint).toBe('api/jev'); /* 浏览器走同源中转（网关不返 CORS 头，直连会被拦） */
    expect(cfg.keyName).toBeNull();       /* 免 key：凭据在 Worker 的 secret 里 */
  });

  it('model 哨兵与 jevrouter 成对（勿单改一边）', () => {
    expect(CHANNELS.builtin.model).toBe(JEV_ROUTER_MODEL);
    expect(CHANNELS.builtin.model).toBe('jev-1.13');
    /* 上游就是 ADR-0024 的自建网关（与 jevrouter 同一 URL，钉在这里防漂移） */
    expect(JEV_ROUTER_UPSTREAM_URL).toBe('https://jev.logicc.top/v1/systemone');
  });

  it('默认渠道 = builtin（2026-11-01 业主定），且免 key 不被降级', () => {
    expect(DEFAULT_SETTINGS.channel).toBe('builtin');
    const base = { ...DEFAULT_SETTINGS, endpoints: {} };
    expect(effectiveChannelOf(base, 'builtin')).toBe('builtin');
  });
});
