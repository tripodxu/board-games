# ADR-0026：内置免费渠道 `builtin`——Worker 持 secret 代发网关（推翻 0024 的「不做服务端共享 key」）

- **状态**：accepted
- **日期**：2026-11-01
- **相关**：[ADR-0024](0024-jevrouter-gateway-channel.md)（jevrouter 渠道；其「代价与不做什么」第一条被本篇推翻）、[ADR-0025](0025-channel-equivalence-and-comparability.md)（渠道等价性纪律——lfree 腿 ≠ 官方）、[ADR-0013](0013-anonymous-device-identity-and-d1-ratelimit.md)（D1 按 IP 限流）、[ADR-0003](0003-byok-proxy.md)（BYOK 语义）

## 背景

ADR-0024 接入自建 jev-router 网关时显式决策「**不做**把网关 key 做成 Worker 环境变量做成匿名免费
服务——那是把自家 key 借给所有人，且网关的免费腿本身就有配额」。2026-11-01 业主重新拍板：
**就是要做内置免费渠道**——访客零配置、无需填任何 key 即可对弈，网关 key 由 Worker 以 secret
持有（`wrangler secret put JEV_BUILTIN_API_KEY`，不明文进仓库/前端/日志）。默认渠道随之从
`opencode` 切到 `builtin`（老用户 localStorage 存档不受影响）。

动机：`opencode` 免费档按出口 IP 限流且全站共享 Worker 出口池（ADR-0024 的老问题），而自家
网关多腿轮换、配额自持，更适合当「开箱即玩」的默认档。

## 决策

1. **渠道 `builtin`**：`CHANNELS.builtin = { endpoint: 'api/jev', model: JEV_ROUTER_MODEL('jev-1.13'), keyName: null }`。
   与 `jevrouter` **共用同一个 model 哨兵与同一网关 URL**——网关收到的请求与 BYOK jevrouter
   逐字相同，零上游兼容风险；两条渠道的唯一分叉是 **key 来源**。
2. **鉴权三态**（`src/worker/routes/jev.ts` 的 `parseJevRequest`）：网关腿（model `jev-1.13`）的
   key 取值序为 **header > body > 服务端 secret**；都没有 ⇒ 401（现行为）。`TYPESAFE_API_KEY`
   （官方上游的站长兜底，ADR-0003）**不参与网关腿**——错家的 key 发过去只会 401，还可能把官方
   额度漏到别的上游。命中 secret 时 `keySource: 'builtin'`，响应头 `X-Jev-Upstream: builtin`
   （区别于 BYOK 的 `jevrouter`），日志只记来源不记值。
3. **吊销即删 secret**：`wrangler secret delete JEV_BUILTIN_API_KEY` 后匿名请求回到 401，
   与 ADR-0024 的 BYOK 语义完全一致——功能开关就是 secret 本身，没有额外的 flag。
4. **前端免 key 白名单**：`effectiveChannelOf` 对 `builtin`/`opencode`/`opencode_local` 不因缺 key
   回落 mock；`builtin` 在 `file://` 下与 `proxy` 同样回落（同源中转不可达）。顺带修复一个
   2026-10-07 起的现存回归：默认渠道 `opencode` 一直被该函数静默降级成 mock（它读 `apiKey`
   而 opencode 的 key 存 `orKey`），零配置访客实际在玩假 AI——本次一并修正，`jevrouter`
   也改读 `orKey`（与 `loop.ts` 的选取口径对齐）。
5. **仅浏览器面**：Node/实验面拿不到 Worker secret，`attemptsFor('builtin')` 在无 `location`
   环境下显式报错；`builtin` **不进** `EXP_CHANS` / 实验面对比臂。

## 缓解措施（对「把自家 key 借给所有人」的回应）

- **按 IP 限流**：走既有 `jev` 桶（D1 固定窗口，30/分缺省、生产 60/分，ADR-0013）。
- **key 不落盘不记日志不回显**：只在出站请求头过一手（纪律同 ADR-0003/0022）。
- **出站仍受网关自身约束**：网关多腿轮换 + 换腿重试 + 配额自持，Worker 侧不重试
  （429/529 交客户端退避，docs/jev-api.md §1）。
- **回执可归因**：`X-Jev-Upstream: builtin` 让每手棋能区分「烧的是访客 key 还是内置额度」。
- **可随时吊销**：删 secret 即回到 ADR-0024 语义。

## 代价与不做什么

- **不进实验面**：网关默认轮询命中 lfree 腿（ADR-0025 实测与官方一致率 ~61%，是另一个模型），
  `builtin` 只是对弈便利渠道，**不得**用于跨轮对比实验；要实验用 `official` 或锁腿网关。
- **不做独立的匿名限流桶**（未决项）：沿用 `jev` 桶意味着内置流与 BYOK 流共享每 IP 配额；
  若日后出现滥用再拆（需要中间件在 parse 前窥探 model，复杂度另议）。
- **不做** `builtin` 的 Node/实验面直连形态——secret 只在 Worker 里，客户端面无从携带。
- **不改** `jevrouter` 渠道的 BYOK 语义：访客自带 key 的请求优先于 secret，行为与 0024 逐字一致。
- **不追溯** 0024 文档：其「不做」条款由本篇显式推翻（ADR 索引标注），原文保留不改历史。

## 实现

- Worker：`src/worker/env.ts`（`JEV_BUILTIN_API_KEY?`）、`src/worker/routes/jev.ts`
  （`parseJevRequest` 的 `builtinKey` 注入与 keySource、短路段回执头）。
- core：`src/core/jev/client.ts`（`CHANNELS.builtin` + `attemptsFor` 分支）、
  `src/core/persist.ts`（`DEFAULT_SETTINGS.channel`、`effectiveChannelOf` 白名单）。
- UI：`src/ui/panels/options.ts`（`DRAWER_CHANNEL_OPTS`/`SIDE_CHANS`/`FOE_CHANS`/`CHANNEL_NAMES`/
  `CHAN_LABEL`/`JEV_CHANNELS`）、`src/ui/panels/settings.ts`（`CHANNEL_HINTS` + 显隐）、
  `index.html`（静态 `<option>` 副本同步）。
- 测试：`test/worker/jev.spec.ts`（parse 三态 + 路由出站头）、`test/core/builtin-systemone.spec.ts`
  （形状钉子）、`test/core/session.spec.ts` + `test/core/opencode-systemone.spec.ts`
  （免 key 不降级 + 默认渠道钉子）、`test/ui/settings-drawer.spec.ts`（显隐矩阵）。
