# ADR-0024：接入自建 jev-router 网关作为第四条 Jev 渠道（强制 BYOK）

- **状态**：accepted
- **日期**：2026-10-08
- **相关**：[ADR-0003](0003-byok-proxy.md)（代理只做 BYOK 转发）、[ADR-0022](0022-upstream-provider-failover.md)（换三元组不写适配器）、[ADR-0019](0019-remote-batch-experiments.md)（SSH 远端批量）、[ADR-0021](0021-standalone-experiment-plane.md)（直连运行面）

## 背景

站点现有的免费 Jev 来源是 OpenCode Zen（渠道 `opencode`）。2026-10-07 的鉴别实验钉死了它的天花板：
免费档限流**按请求方出口 IP 计**，而浏览器侧所有请求都被 Cloudflare Worker 中转，全站共享 Worker
出口 IP 池 ⇒ 经中转的 `opencode`（带不带 key）都撞同一堵墙（6/6 全 429 `FreeUsageLimitError`）。
当时给出的业主自用解是「本地 dev + 自己的 key」，浏览器直连被 CORS 永久挡死。

同时，`E:\mimo\opencodeproxy` 那套自建设施里已经跑着一个专给本项目用的**网关**：`jev-router`
（`https://jev.logicc.top/v1/systemone`）。它的存在动机恰恰就是上面这堵墙——它把请求按腿分流到
多个上游（zen-o2a / lfree-1 / lfree-2），失败时自动换腿重试，且出口 IP 会轮换。

## 决策

新增渠道 `jevrouter`，与 `opencode` 并列（不是替换——`opencode` 仍是零配置默认档）：

| 项 | 值 |
|---|---|
| 浏览器端点 | 同源 `api/jev`（网关无 CORS 头，浏览器直连不可行） |
| Node / 实验面端点 | `https://jev.logicc.top/v1/systemone` |
| model | `jev-1.13`（网关按腿归一化：zen 腿强制 `jev-1.13-free`，lfree 腿强制 `jev-1.13`；对外只暴露 `jev-1.13`） |
| key | **强制**，存设置抽屉的 `orKey` 输入框，label「jev-router Key（jv- 开头 · 必填）」 |
| 鉴权 | 浏览器 → 同源 `/api/jev` 发 `X-Api-Key`；Worker/Node → 网关发 `Authorization: Bearer` |
| User-Agent | 显式带 `curl/8.5.0`（`logicc.top` 全域开了浏览器完整性检查，库默认 UA 会被 403 code 1010） |

三条配套改动：

1. **`authHeaderFor(endpoint)` 取代「按渠道名选头」**（`src/core/jev/client.ts`）。判据取**解析后的端点**：
   相对路径或本机回环 = 中转面（`X-Api-Key`），真实 http(s) 域名 = 直连面（`Bearer`）。
   这修掉了 `opencode` 的一个既存 bug：老实现按渠道名发头，而 Worker 的 `parseJevRequest`
   **从不读 `Authorization`** ⇒ 浏览器里用户填的 OpenCode Key 被静默丢弃、永远走匿名池。
   改成按端点判之后 `opencode` 与 `jevrouter` 两边都对，且不再依赖「渠道名恰好对应一种形态」。
   「要不要输入框」（`keyName`）与「key 是否必填」（`KEY_REQUIRED_CHANNELS`）也拆成两个字段——
   `opencode` 要显示输入框但 key 可选，`jevrouter` 两者都是。

2. **实验面给它独立的一份 key**（`scripts/lib/upstream.mjs`）。批量对弈机（`185.242.234.48`）
   **就是 jev-router 所在的 VPS**，那台机器的 `/root/.jev-key` 里装的就是网关的 `jv-` key
   （实测首三字符 `jv-`）。若沿用同一个默认路径，`official` 臂会把 `jv-` key 当 TypeSafe key 发出去，
   且没法在同一台机器上同时跑两个上游臂。故新增 `/root/.jev-router-key` 与 `JEV_ROUTER_KEY`，
   并加一道 `keyShapeProblem()` **形状闸门**：`jevrouter` 臂的 key 必须以 `jv-` 开头、
   `official` 臂的必须不是——放错文件不会立刻报错，而是变成整轮 401（每局十几分钟才失败一次），
   所以在开局前用前缀形状拦一道，exit 2。

3. **Worker 侧按 model 分流**（`src/worker/routes/jev.ts`）。`DIRECT_UPSTREAMS` 表把
   `jev-1.13` 映射到网关、`jev-1.13-free` 映射到 OpenCode，两者都**不进兜底状态机**（网关自己换腿）。
   与 `opencode` 的唯一实质差别是 `allowAnonymous: false`：实测空 key ⇒ 401 `{"error":"invalid key"}`。

### 「用户端仍需自己准备 api key」怎么落到代码里

- 服务端**没有任何共享 key**：Worker 不带 `env.JEV_ROUTER_KEY`，匿名请求直接 401（有测试钉住
  「401 且 fetch 一次都不发生」）。用户填的 `jv-` key 只在浏览器 localStorage 与请求头里过一手。
- 设置抽屉的 hint 明写「必须填你自己的 jv- 网关 key，服务端不代持、不共享」。
- 实验面同样要显式给 key（`JEV_ROUTER_KEY` 或那个文件），缺 key 时开局前 exit 2 并打
  `ROUTER_KEY_HELP`（点名环境变量与路径，并提醒别和 TypeSafe 臂那份混了）。

## 验证证据（2026-10-08）

探针跑在网关所在的那台 VPS 上（key 不出机器）：
`POST /v1/systemone` 带 `jv-` key ⇒ **200 / 1.19 s**，回执头 `x-jev-leg: zen-o2a`，`cost:"0"`，
move 选中夹具里那条 `you:four+deny:live3`（说明引擎算出的 criteria 被网关照单执行）。
错 key ⇒ 401 `invalid key`；顶层 `instructions` ⇒ 400（我们的客户端只把 instructions 挂在各 question 里，天然安全）。

box 上真跑一轮（`jevrouter:v14-live3-fresh:0` vs `rapfi::500` × 2 局，`--upstream direct --store local`）：
**2/2 局终局**，`W2-D0-L0`（23 手 / 104 手），逐手归属可辨（`ai.ch=jevrouter` 共 64 手、
`ai.mdl=jev-1.13-free`、`ai.prov=primary`、`ai.tv=v14-live3-fresh`），模型往返 median 522–874 ms。
零 CF 触碰（store=local）。形状闸门反向用例：`official` 臂指向 `jv-` 文件 ⇒ **exit 2** 并点名成因。

## 代价与不做什么

- **不做**把网关 key 做成 Worker 环境变量做成「匿名免费服务」——那是把自家 key 借给所有人，
  且网关的免费腿本身就有配额。
- **不做**给 `jevrouter` 接兜底提供方链：网关自己会按腿切换，Worker 再套一层切换只会掩盖
  「网关在换腿」这个信息（回执头 `x-jev-leg` 就是为此保留的）。
- **不改**默认渠道：默认仍是 `opencode`（零配置可玩）。`jevrouter` 是显式 opt-in。
- 渠道清单里 `jevrouter` 归入 `UPSTREAM_CHANNELS`，因此也进配额估算与 `--parallel` 闸门
  （并行撞限流 + 共享上游延迟会污染对照）。

## 替代方案（未采纳）

- **把 `opencode` 默认档直接换成 `jevrouter`**：会打破「零配置可玩」——用户不填 key 就完全不能走子。
- **用 opencodeproxy 那台的出网代理直接打 OpenCode**：绕不开「出口 IP 决定配额」这堵墙，
  且把一个长期实验设施变成产品运行依赖。
- **让网关接匿名**：实测 401，且等于把自己的配额敞开。