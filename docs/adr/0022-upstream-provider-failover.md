# ADR-0022：上游提供方兜底（换三元组 + 同局粘滞 + 逐手 `provider` 归属）

- 状态：accepted（2026-10-04；Worker 侧默认关闭，`JEV_FAILOVER=off`）
- 背景：业主 2026-10-03 提出（m13627，原话）「最好还要多加一个参数，经过战术层，由 jev 决定的
  候选点有几个，**要是 key 用完了**，使用 https://api.commandcode.ai/provider/v1 …调用 jev 模型」。
  候选点数那半（C0/C3/C4）是纯记账，风险低；这半的问题是**上游会因额度/故障整体不可用**，
  而一次长跑（数百局 × 数十手）死在中途的代价远大于多接一个提供方。计划的 B 部分决策见
  `docs/plans/2026-10-03-cands-metric-and-provider-failover.md` §3 D-B1–D-B6。

## 事实基线（写代码前逐条实测）

1. **兜底网关与主网关协议同形**（C1 探针，2026-10-03）：
   `POST https://api.commandcode.ai/provider/v1/systemone` + `Authorization: Bearer <key>` +
   `{"model":"typesafe/jev","state":…,"questions":{…}}` ⇒ HTTP 200 且响应
   **逐字段与主网关同构**（`fixture`：`test/fixtures/jev/commandcode-systemone-2026-10-03.json`）。
   非 `systemone` 的路径对 Jev 模型一律 400 `unsupported_model`；`GET /provider/v1/models`
   **不列** `typesafe/jev`；响应**没有** `x-ratelimit-*` 头 ⇒ 额度只能靠状态码判。
2. **差异只有三元组**：端点基址、`model`、key 三样不同，请求体/响应体不用动 ⇒ 不需要协议适配器。
3. **两条运行面各有各的重试阶梯**：`src/core/jev/client.ts` `callWithRetry()` 自己会重试
   网络 4 次、429/529 五次（`Retry-After` 上限 20 s）、5xx 达阈值时退避一次；
   Worker 面走 `src/worker/lib/upstream.ts`，每次请求都是新的（**没有跨请求计数器**）。
4. **`position.criteria` 必须是数组**（C1 踩到即 422）；`cands` 的历史口径已被归档数据固化。

## 决定

1. **判定逻辑集中在纯模块 `src/core/jev/providers.ts`**（叶子模块，**零 import**）：
   `PROVIDERS` 两项 `primary`（`https://api.typesafe.ai/v1/systemone` + `jev-latest`，`keySource:'official'`）
   与 `backup`（`https://api.commandcode.ai/provider/v1/systemone` + `typesafe/jev`，`keySource:'commandcode'`）；
   `classifyStatus(status)` 把状态码归成 `auth`（401/402/403）/ `rate-limit`（429/529）/
   `server`（≥500）/ `client`（其他 ≥400）/ `null`（2xx–3xx）；
   `noteSuccess()`/`noteFailure(states,id,cls,{status,exhausted})`/`pickProvider(states,stickyId)`。
   fetch 仍留在调用侧（`src/core/**` 不碰 IO，铁律 3）。
2. **换的是三元组，不写协议适配器**（D-B1）。保留 `kind: 'openai-chat'` 设计位但**不实现**——
   只有将来接非 systemone 网关才需要。**替代方案**：给每个提供方写适配器。否决——C1 已实测同构，
   适配器只会多一层「把概率契约改坏」的机会。
3. **切换触发与粘滞**（D-B2）：`auth` ⇒ 立刻换；`rate-limit` ⇒ 只在**本家重试阶梯已用尽**
   （`exhausted`）时换；`server` ⇒ 连续 `SERVER_FAILURE_LIMIT = 3` 次（或本家用尽）换；
   `client` ⇒ **永不换**（那是我们请求写错了，换家也一样错）。切换前用备用 key 打一次
   `GET <probeUrl>` 探活（`PROBE_TIMEOUT_MS = 10_000`，Worker 面同值）：探活通过才切并记
   `ProviderSwitchInfo {from,to,reason,probeMs,probeStatus}`；**探活失败仍要记账但抛原始错误**
   （不许把「探活也挂了」伪装成成功）。**同一局内粘滞**，不回切（避免抖动把一局棋切成两半）。
4. **两面共享判定、各自处理「用尽」**：Worker 面（`src/worker/lib/failover.ts`）是**单请求**语义 ⇒
   429/529 一律视为用尽，5xx 在本请求内重试到 `SERVER_FAILURE_LIMIT` 再切；直连面
   （`src/core/jev/client.ts` `callWithFailover()`）已有重试阶梯 ⇒ 用 `const exhausted = cls === 'rate-limit' || cls === 'server'`
   把「本家已试过」传进 `noteFailure`。**替代方案**：在 Worker 里做跨请求计数器（Durable Object / KV）。
   否决——为一个默认关闭的兜底路径引入有状态组件，成本远超收益。
5. **归属独立于渠道**（D-B6）：`channel` 仍答「走哪条渠道」（`proxy`/`official`），新增逐手
   `provider` 答「这一手是谁答的」（`primary`/`backup`/`custom`/`random`），两者正交。
   `prob_source` 答「概率是上游给的还是我们推的」：`exact`（有逐点概率）/ `derived`（没有 ⇒
   `cands=null`，**绝不把 `cands` 填成 `candsSent` 或 1**，D-B3）。
6. **落库与归档**：`migrations/0004_move_provider.sql` 给 `game_moves` 加
   `provider TEXT` + `prob_source TEXT`；归档 JSON 用 `prov`/`probs` 短键（与 `cands` 同风格）。
   **缺失 ≠ `primary`/`exact`**：列注释写明 rapfi/mock/人类侧与 0004 之前的老归档都是 NULL。
7. **密钥纪律**（D-B4）：Worker 侧 `env.COMMANDCODE_API_KEY`（secret，**默认不配 ⇒ 不启用兜底**）、
   box 侧 `chmod 600` 的 `/root/.cc-key`；不写日志、不进 URL、不入库。业主 2026-10-03 明确
   **不轮换**（视为测试 key）⇒ 该 key 只允许出现在 box 的 600 文件与本机 `.work/cc-key.txt`
   （已 gitignore），仓库内任何文件都不得出现。
8. **默认关闭 + 显式开关**：`src/worker/env.ts` 的 `JEV_FAILOVER`（`wrangler.jsonc` 里 `"off"`）；
   proxy 面还能用 `X-Jev-Provider`（请求头提示）与 `X-Jev-Provider-Switch`（切换原因回执）观察，
   但**只有 `JEV_FAILOVER` 打开才真的会换家**。理由：生产路径的行为变更要业主点头（见「后果」）。

## 后果

- 上游额度耗尽/单家 5xx 时，长跑可以在**同一局内**换到备用网关继续，切换事件逐手可查
  （`provider` + `prob_source` + `events.jsonl`/Worker 日志）；报表可按 `provider` 分桶并标注
  「兜底手 N 手，未计入主口径」。
- 代价：多一条会真实花钱/耗额度的出网路径（缓解：默认关闭 + 探活 + 同局粘滞 + 不回切）。
- 代价：`provider`/`prob_source` 是新列 ⇒ 0004 之前的老归档读出来是 NULL；任何「按 provider 统计」
  的报表都必须把 NULL 单列一类，不能默认归到 `primary`。
- 尚未做（待业主点头）：生产 Worker 重新部署 + `wrangler secret put COMMANDCODE_API_KEY` +
  打开 `JEV_FAILOVER`；直连面已在 box 侧具备完整能力（`--backup-key-file /root/.cc-key`、
  `--expect-backup`）。

## 验证

- 单测：`test/core/providers.spec.ts`（12 例：状态码分类、粘滞优先、全死回落到默认、
  切换文案）、`test/core/jev-failover.spec.ts`（10 例：假时钟驱动，覆盖 401 立即换 /
  429 用尽才换 / 5xx 达阈值换 / 探活失败抛原始错 / 单家时 5xx 直接返回 / 粘滞 `providerSticky='backup'`）、
  `test/worker/jev.spec.ts`（含 9 例兜底与 `providerAttempts` 导出用例——导出理由写在注释里：
  workerd 里换不掉全局 `fetch`）。
- 真实网关：C1 探针的原始响应留档为 fixture（逐字段同构，见上「事实基线」1）。
- 端到端：`vorder1`（2026-10-04）每局日志均 `provider[primary:N]`、**切换 0 次** ⇒ 默认路径未被扰动；
  备用路径的真跑验收在补齐 `COMMANDCODE_API_KEY` 后单独做。
