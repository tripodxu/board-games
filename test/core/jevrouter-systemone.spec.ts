/* jevrouter-systemone.spec.ts — 自建 jev-router 网关渠道的形状钉子
 *
 * 2026-10-08 实测（探针跑在网关所在的那台 VPS 上，key 不出机器）：
 *   · 端点 `https://jev.logicc.top/v1/systemone` + `jv-` key ⇒ 200，1.19 s，
 *     回执头 `x-jev-leg: zen-o2a`，`cost:"0"`，move 选了夹具里那条 `you:four+deny:live3`；
 *   · 错误 key ⇒ 401 `{"error":"invalid key"}` ⇒ **匿名不可用**，这正是 allowAnonymous: false 的依据；
 *   · 顶层 `instructions` ⇒ 400 ⇒ 我们的客户端（instructions 只挂在各 question 里）天然安全；
 *   · `score.criteria` 必须是**数组**、`choice.criteria` 必须是**以选项为键的对象**
 *     ——与各引擎现有的构造一致，不需改协议层。
 *
 * 本 spec 钉三件事：
 *   ① 渠道表里 jevrouter 的三元组与两个常量（与 Worker 侧成对的常量必须同值）；
 *   ② `authHeaderFor()`：浏览器走同源中转发 X-Api-Key、Node 直连发 Bearer ——这是
 *      「opencode 在浏览器里静默丢 key」那个 bug 的正解，必须有回归钉子；
 *   ③ 换 provider 分支：jevrouter 不进官方那条 primary/backup 兜底链。
 */
import { describe, expect, it } from 'vitest';
import {
  CHANNELS,
  JEV_ROUTER_MODEL,
  JEV_ROUTER_RELAY_PATH,
  JEV_ROUTER_UPSTREAM_URL,
  authHeaderFor,
} from '../../src/core/jev/client.ts';

describe('自建 jev-router 网关渠道（多源路由 · 出口轮换）', () => {
  it('CHANNELS.jevrouter：同源中转端点 / jev-1.13 / 独立 keyName', () => {
    const cfg = CHANNELS.jevrouter;
    expect(cfg).toBeDefined();
    expect(cfg.endpoint).toBe(JEV_ROUTER_RELAY_PATH);
    expect(cfg.endpoint).toBe('api/jev'); /* 浏览器默认走同源中转（网关没有 CORS 头） */
    expect(cfg.model).toBe('jev-1.13');
    expect(cfg.keyName).toBe('jevrouter');
    /* Node/实验面直连真实端点（与 Worker 侧 JEV_ROUTER_UPSTREAM_URL 必须同值） */
    expect(JEV_ROUTER_UPSTREAM_URL).toBe('https://jev.logicc.top/v1/systemone');
    expect(JEV_ROUTER_MODEL).toBe('jev-1.13');
  });

  it('authHeaderFor：相对路径与本机中转 = relay（X-Api-Key），真实上游 = bearer', () => {
    /* 同源中转：Worker 只读 X-Api-Key，从不读 Authorization。 */
    expect(authHeaderFor('api/jev')).toBe('relay');
    expect(authHeaderFor('/api/jev')).toBe('relay');
    expect(authHeaderFor('http://127.0.0.1:8420/api/jev')).toBe('relay');
    expect(authHeaderFor('http://localhost:8420/api/jev')).toBe('relay');
    /* 直连上游：Bearer。 */
    expect(authHeaderFor(JEV_ROUTER_UPSTREAM_URL)).toBe('bearer');
    expect(authHeaderFor(CHANNELS.official.endpoint)).toBe('bearer');
    expect(authHeaderFor(CHANNELS.openrouter.endpoint)).toBe('bearer');
    /* 空端点按直连处理（拿不到就是没有中转）。 */
    expect(authHeaderFor('')).toBe('bearer');
  });
});