# 计划：候选点数可观测（`cands` 家族）+ 上游 key 用尽自动兜底（commandcode 网关）

- 状态：📋 待批（2026-10-03）
- 来源：用户 2026-10-03（m13627）
- 引块（逐字，含用户贴的第三方 token，按密钥纪律不入库、不写文档）：

  > 最好还要多加一个参数，经过战术层，由jev决定的候选点有几个，要是key用完了，使用
  > `https://api.commandcode.ai/provider/v1` `user_6…`（token 见会话，**不落盘**）调用 jev 模型
  > 先列计划

- 前置阅读：[2026-10-03-tactics-fidelity-and-elo-ladder.md](2026-10-03-tactics-fidelity-and-elo-ladder.md)（G2/G3：远端 Elo 阶梯 + 离线运行面）、[2026-10-03-tactics-coupling-audit.md](2026-10-03-tactics-coupling-audit.md)

---

## 1 目标

**G-A 候选点数可观测**：一局棋的每一手都能回答「这一手，战术层把多少个候选点交给了 Jev、其中多少个带战术标签、模型实际给概率的又有几个」，并进入报表与 UI。

可验收子项：

1. A1 归档里逐手有「发给 Jev 的候选点数」和「带战术标签的候选点数」两个整数（可为 null，但**不允许写 0 冒充缺失**）。
2. A2 D1 里能按轮/按版本 SQL 出这三个数的均值与分布，且**历史行不被改写**（老局这两列为 NULL）。
3. A3 实验报表按手给出三数均值 + 桶分布 + 「模型评分率 = `cands / candsSent`」，与既有的战术层耗时列并列。
4. A4 引擎自检与 UI 单测覆盖新字段；`test/parity` 黄金对比零漂移（老归档不许因为新键而失败）。

**G-B key 用尽可续跑**：主上游（TypeSafe）返回鉴权/额度类错误时，自动切到备用网关（commandcode）继续同一局，不中断实验，且**逐手记明是谁答的**。

可验收子项：

1. B1 故意用坏主 key 跑 4 局：4 局全部正常终局，归档里前几手 `provider=typesafe`、之后 `provider=commandcode`，切换事件有日志。
2. B2 报表能按 `provider` 分桶，兜底手不混进主口径（要么单列，要么剔除并标注样本数）。
3. B3 备用网关拿不到逐点概率时，落 `probSource='derived'` 且 `cands=null`，**不伪造概率**。
4. B4 密钥只从 Worker secret / box 侧 chmod 600 文件读；仓库、日志、URL 里都不出现。

**不追求**：不做多网关负载均衡/竞价；不做「无概率也能算 cands」的猜测；不改战术层语义（本计划与 v14 冻结线正交）。

---

## 2 现状硬事实（已核实，不猜）

| 事实 | 证据 |
| --- | --- |
| `cands` 参数**早已存在**，语义是「**模型给了概率且落在我方合法着法里**的候选点数」 | `src/core/jev/client.ts:336` 取 `answers.move.probabilities` → `:343 const pairs = Object.entries(probs).filter(([k]) => byNotation.has(k));` → `:537 candidates: pairs.length, /* 合法候选总数 */` |
| 该值在真实 Jev 手上**100% 有值**（不是空） | D1：`proxy` 9724/9724 非空、`random` 353/353；按 `code_version` 分组最新 `1.0.0+fe43b16` 939 手 avg 58 / max 64；`rapfi` 7143 与 `channel IS NULL` 2078 全空（这两类本不过候选集，符合设计） |
| 分布偏满：**60–64 桶占 77.1%**（7493/9724），50–59 = 549、30–49 = 795、10–29 = 569、1–9 = 318 | 同上 SQL 分桶 |
| 「发给 Jev 的候选点数」**没有落库**，但它就在请求里且客户端已经拿到 | `src/core/engines/gomoku.ts:1076-1081 serializeForJev()`：`const cand = candidates(st, 64);` + `criteria[m.notation] = labelPoint(...) || null;`，返回体还有 `options: notations`（`:1149`）；客户端从 `criteria` 键反推（`src/core/jev/client.ts:306-311`），同一变量 `:315` 喂给 `computeTactics` |
| 候选集上限 **64**，**战术层只标注/接管、不裁剪候选集** | `src/core/engines/gomoku.ts:895 candidates(st, cap?)`、`:1233 assert(candidates(st, 64).length <= 64, '候选 ≤64')`；`src/core/tactics.ts` 只产出「接管/标签」，无裁剪路径 |
| 落库链路**已通、零 schema 改动**（`cands` 一列本来就有） | `src/core/meta.ts:44-67 aiMoveMeta()` `:59 cands: typeof meta.candidates === 'number' ? … : null` → `src/core/record/export.ts:206` → `src/shared/record-map.ts:59/:193/:419` → `src/worker/lib/record-input.ts:52` → `src/worker/db/games.ts:226/:229/:318`；`migrations/0001_init.sql` 的 `game_moves` 建表已含 `cands INTEGER` |
| 但**报表与 UI 的实验面板都没消费它** | `scripts/` 全目录 grep 无 `cands` 命中；`src/ui/panels/experiment-report.ts` 的 `SideStat`/`expAggregate` 只有胜和负与 `tacAvgMs`；唯一消费点是逐手视图 `src/core/view/board.ts:87-101`（「N 个候选」） |
| 我方上游协议是**自研形状**，不是 chat/completions | 请求体白名单 `state`/`model`/`questions`（`src/worker/routes/jev.ts:101-105`）；响应按 `answers.move.probabilities` 解析；`state` 里是 `board_ascii`/`legal_moves` 等（`src/core/engines/gomoku.ts:1082-1094`） |
| 现有三个渠道与端点 | `src/core/jev/client.ts:26-30 CHANNELS`：`official` → `https://api.typesafe.ai/v1/systemone`（model `jev-latest`）、`openrouter` → `https://openrouter.ai/api/v1/systemone`（`typesafe/jev-1.13`）、`proxy` → 同源 `api/jev` |
| Worker 转发层**已为换端留了口子** | `src/worker/lib/upstream.ts:37 DEFAULT_UPSTREAM_URL`、`:46 DEFAULT_TIMEOUT_MS = 30_000`、`:49 DEFAULT_MODEL = 'jev-latest'`、`:56 UpstreamFailureKind = 'timeout'|'aborted'|'network'`、`:63-64 UpstreamCall.url?` 可覆盖、`:71-72 fetcher` 可注入；key 优先级 `X-Api-Key` > `env.TYPESAFE_API_KEY` > 请求体（`src/worker/routes/jev.ts:80-84`） |
| commandcode **不是** Jev 的可直换端点 | `GET https://api.commandcode.ai/provider/v1` → 404 `{"success":false,…,"cause":"GET https://api.commandcode.ai/provider/v1 is not a registered API route"}`；`GET …/provider/v1/models` → 200，OpenAI 风格清单 ~85 个模型，`supported_endpoints` 只有 `/chat/completions`、`/responses`、`/messages`，**没有任何 `systemone` / `jev-*` 条目** |

**结论**：G-A 是「把请求侧已有的数记下来 + 报表消费」，不是新机制；G-B 不是换 URL，而是**加一层协议适配**（把我们的三问请求映射成 chat 补全，再把回复映射回逐点概率形状）。

---

## 3 决策

### A 部分（候选点数）

- **D-A1 三个计数分开记，不许混为一个**：
  - `cands`（保持原义，**不改历史口径**）= 模型给概率且合法的点数；
  - `candsSent`（新）= 发给 Jev 的候选点数（`= criteria 键数 = options.length`，≤64）；
  - `candsLabeled`（新）= 其中 `labelPoint` 非空的点数（即「战术层标注过的」）。
  > 理由：三者回答三个不同问题（模型评了多少 / 交出去多少 / 战术层解释了多少）。合成一个数就再也拆不开；且 `cands` 已被历史数据固化，动它等于改写历史。
- **D-A2 缺失写 null，不写 0**：沿用 `src/core/meta.ts:65 tacMs` 的同款写法（只在 `typeof … === 'number'` 时写出），并把同一纪律复制到 `candsSent`/`candsLabeled`。非 Jev 侧（rapfi/人类）三列全 NULL，与 `thinkMsOf` 闸门同理。
- **D-A3 归档短键 + D1 列名**：归档 JSON 用 `candsSent`/`candsLabeled`（与既有 `cands` 同风格，不做缩写）；D1 用 `cands_sent`/`cands_labeled`，落在 `migrations/0003_move_cands.sql`（现有迁移只到 `0002_tactics_timing.sql`）。
- **D-A4 报表口径**：逐手三数 → 按轮/按身份聚合 mean / median / min–max + 五个桶（1–9 / 10–29 / 30–49 / 50–59 / 60–64）+ 「模型评分率 = `cands/candsSent`」。UI 侧在 `expSideStats`/`expAggregate` 增一列「候选」（均值），逐手细节仍归 `src/core/view/board.ts`。
- **D-A5 `candsLabeled` 允许缺省**：它只对真过战术层的侧有意义（`channel === 'rapfi'` 之外）；首版可以只落 `candsSent`，`candsLabeled` 与 D-A1 一起上，但如果实现成本超预算，**先落 `candsSent`**（用户原话要的是「由 Jev 决定的候选点有几个」）。

### B 部分（兜底提供方）

- **D-B1 走适配器，不换 URL**：新增纯模块 `src/core/jev/providers.ts`（`PROVIDERS` 表 + `buildRequest()` + `parseReply()`），`mode: 'jev' | 'openai-chat'`；fetch 仍留在调用侧（Worker `src/worker/lib/upstream.ts`、box/Node 直连路径），保持 `src/core/**` 纯函数、无 `fetch`。
- **D-B2 触发与粘滞**：401/402/403（key/额度）、429 且 `Retry-After` 重试用尽、5xx 连续 3 次 ⇒ 切换；切换前用备用 key 打一次 `GET /provider/v1/models` 探活；**同一局内粘滞**，不回切（避免抖动把一局棋切成两半）；切换事件进 `events.jsonl`（box）/ worker 日志。
- **D-B3 降级要诚实**：适配器拿不到逐点概率时 → `probSource='derived'`、`cands=null`，只在 `provider` 列标记；报表按 `provider` 分桶并标注「兜底手 N 手，未计入主口径」。绝不把 `cands` 填成 `candsSent` 或 1。
- **D-B4 密钥纪律**：Worker 侧 `env.COMMANDCODE_API_KEY`（secret）；box 侧 `chmod 600` 文件（与 `/root/.jev-key` 同款）；**不写日志、不进 URL、不入库**。⚠️ 用户已在会话里贴出该 token ⇒ 建议本轮收尾时轮换一次。
- **D-B5 默认兜底模型**：`deepseek/deepseek-v4-pro`（清单里 1M 上下文、支持 `/chat/completions` 的通用模型），可用 `COMMANDCODE_MODEL` 覆盖；**这是待拍板项**（另有 `gpt-6-sol`/`claude-sonnet-5-5` 等，但后者走 `/messages`，适配器要写两套）。
- **D-B6 归属**：不改 `channel`（仍记 `proxy`/`official`，那是「走哪条渠道」），新增逐手 `provider` 字段回答「这一手是谁答的」；两者独立，报表同时可见。

---

## 4 文件清单

| 文件 | 动作 | 估量 |
| --- | --- | --- |
| `src/core/jev/client.ts` | 在 response meta 里加 `candsSent`/`candsLabeled`/`probSource`（`cands` 不动） | ~25 行 |
| `src/core/meta.ts` | `aiMoveMeta()` 三键按「是 number 才写」落归档 | ~10 行 |
| `src/shared/record-map.ts` | 类型与映射（`ai ? num(ai.candsSent) : null` 同款） | ~15 行 |
| `src/worker/lib/record-input.ts` + `src/worker/db/games.ts` | 入参白名单 + 列名（INSERT/SELECT 各一处） | ~12 行 |
| `migrations/0003_move_cands.sql` | `ALTER TABLE game_moves ADD COLUMN cands_sent INTEGER;` …（两条）+ `provider`/`prob_source` 两列（B 部分） | ~8 行 |
| `src/core/jev/providers.ts`（新） | provider 表 + `buildRequest()` + `parseReply()`（含 chat 适配与 JSON 契约解析） | ~180 行 |
| `src/worker/lib/upstream.ts` + `src/worker/routes/jev.ts` | 依 provider 表选端点、失败分类映射、切换粘滞状态与时序归因 | ~70 行 |
| `src/ui/panels/experiment-report.ts` | `SideStat` 加候选均值、`expAggregate` 加列、`ExperimentEntry` 透传 | ~60 行 |
| `test/engines/*`（自检） + `test/ui/experiment-report.spec.ts` + `test/scripts/*`（provider 表纯单测、SigV4 无关） | 覆盖 A1/A4 与 D-B1/D-B3 | ~140 行 |
| 文档 | 本计划 + `docs/status.md` 口径行 + `README.md` 数据/命令 + `CHANGELOG.md` + `docs/memory/MEMORY.md`；B 部分是否单开 `docs/adr/0020-provider-failover.md` 待批 | ~60 行 |

---

## 5 阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **C0**（~0.5 天） | A 部分：三数落库 + D1 迁移 + 报表列 + 测试 | `tsc` 0 错；引擎自检 + vitest 全绿；`test/parity` 黄金零漂移；D1 新列在下一局非空、老局仍 NULL |
| **C1**（~0.5 小时，只读探针） | 用备用 token 打一次最小 chat 请求，确认鉴权头形状、JSON 结构化输出是否被遵守、能否按候选点给分 | 三条结论各带一条原始响应片段（不猜） |
| **C2**（~1 天） | B 部分：`providers.ts` + Worker 接线 + Node/box 直连路径共用同一策略 | 坏主 key 跑 4 局全部终局；`provider` 逐手可辨；切换有日志；单测覆盖 401/429/5xx 三条触发 |
| **C3**（~0.5 天） | 归因与报表：`provider`/`prob_source` 落库 + 报表分桶 + 文档 | 报表能给出「兜底手 N 手 + 未计入主口径」一行；status 口径更新 |
| **C4**（随下一次实验） | 与 G-B2 合并跑（直连上游 + 兜底），并报战术层耗时与成本对照 | 见 [fidelity-and-elo-ladder](2026-10-03-tactics-fidelity-and-elo-ladder.md) §7 报表第 ①②⑥ 项 |

**回滚**：C0 与 C2 各自独立可回滚（迁移只加列、不改既有列；provider 表可由环境变量停用）。

---

## 6 风险

| 风险 | 处置 |
| --- | --- |
| 第三网关条款/零留存未知（棋局不是隐私数据，但要说明） | 文档写明数据去向；如用户要求，兜底只用于实验面、不进生产默认路径 |
| 适配器把概率丢了 ⇒ 主指标断档 | D-B3：如实标 `derived` + 报表分桶，宁可样本少也不混口径 |
| 切换抖动导致一局被切碎 | D-B2 局内粘滞 + 探活 + 事件日志 |
| 新列让 `test/parity` 黄金 diff 失败 | 「是 number 才写」纪律 + 老归档零键；黄金用例显式覆盖 |
| box 直连备用网关不通 | 与 G3 同一降级路径（经业主 Worker + `--allow-production`），或只用 Worker 侧兜底 |
| 用户贴出的 token 已外泄 | 建议轮换；轮换后只更新 box/Worker secret，不动代码 |

---

## 7 待拍板

1. **口径**：三数（`cands` / `candsSent` / `candsLabeled`）一起上，还是先只上 `candsSent`？（D-A5 给了「先 `candsSent`」的退路）
2. **B 的形态**：适配器保概率契约（D-B1，~1 天）还是另立 `commandcode` 渠道丢概率（~2 小时，但 `cands` 断档、实验口径要分渠道）？
3. **兜底模型**：默认 `deepseek/deepseek-v4-pro` 是否可以？（清单里没有 systemone 系模型，必须选一个通用模型）
4. **token 轮换**：现在就换，还是等接线完成再换？

---

## 8 与其他计划的关系

- 与 [fidelity-and-elo-ladder](2026-10-03-tactics-fidelity-and-elo-ladder.md)：**正交**。那边的 P5 报表直接消费本计划的三个计数；那边的 P4b「离线运行面」复用本计划的 provider 表（直连上游 + 兜底是同一层）。
- 与 v14/机制线：无交集（本计划不碰战术语义，不改 `src/core/tactics.ts` 的裁决路径）。
- 与 `m07650`/`m08110` 的成本口径：本计划新增的「候选点数」是**第三个独立维度**（耗时 / 候选数 / 胜负），报表里三者并列，仍不混算。
