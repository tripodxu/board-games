# 计划：候选点数可观测（`cands` 家族）+ 上游 key 用尽自动兜底（commandcode 网关）

- 状态：🚧 实施中（2026-10-03；**C0 已完成**，见 §4.1 与 §5；C1 探针已完成；**C2 已完成**，见 §4.2 与 §5；**C3 已完成**，见 §4.3 与 §5；C4 随下一次实验）
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
| commandcode 的**模型清单不权威** | `GET …/provider/v1/models`（带 key）→ 200，85 个模型，**不含 `typesafe/jev`**；可同一 key 却能用 `typesafe/jev` 调通 `/systemone`（下一行）⇒ 清单不能用来判断可用性 |
| **`/provider/v1/systemone` 与我方协议同形**（C1 实测，2026-10-03） | 请求 `{"model":"typesafe/jev","state":{…},"questions":{"move":{type:"choice",instructions,criteria},"edge":{type:"noul"},"position":{type:"score",criteria:[…]}},"options":[…]}` → **200**：`{"model":"typesafe/jev","answers":{"move":{"type":"choice","choice":"H8","confidence":0.21,"probabilities":{"F6":0.13,"H8":0.48,"E5":0.39}},"edge":{"type":"noul","noul":0.61},"position":{"type":"score","score":2.45,"confidence":0.13,"legend":{…},"probabilities":{…}}},"usage":{"input_tokens":377,"output_tokens":42}}` |
| 非 systemone 路径**不接受** Jev 模型 | `POST …/provider/v1/chat/completions` + `model=jev-latest` / `systemone` / `typesafe/jev-latest` → 400 `{"error":{"message":"Model \"…\" is not supported on this endpoint.","type":"invalid_request_error","param":"model","code":"unsupported_model"}}`；同端点用清单内模型（`deepseek/deepseek-v4-pro`）→ 200（chat 形状，带 `reasoning`） |
| 网关**不提供限流/配额线索** | 响应头只有 `cf-ray` / `server-timing` / `x-trace-id` / `x-powered-by: Hono` / `access-control-allow-origin: *`，无 `x-ratelimit-*`、无配额字段 ⇒ 429/402 只能被动分类处理 |
| `position.criteria` 必须是**数组** | 送对象会 400 `Invalid input: expected array, received object`（`param: questions.position.criteria`）；我方 `SCORE_LEVELS`（`src/core/engines/gomoku.ts:964`）本来就是数组，天然相符 |

**结论**：G-A 是「把请求侧已有的数记下来 + 报表消费」，不是新机制；G-B 是**近乎直换**——同一套 `state`/`questions`/`options` 请求、同一套 `answers.*.probabilities` 响应，**不需要协议适配器**，切换 = 「base URL + model `typesafe/jev` + key」三元组替换（`src/worker/lib/upstream.ts:63-64` 的 `url?` 覆盖口子现成）。真正要写的只有 provider 表、失败分类与局内粘滞。

### 2.1 C1 探针记录（已完成，2026-10-03）

- 探针脚本：`.work/cc-probe.mjs`（清单与错误分类）、`.work/cc-probe2.mjs`（用**我方真实形状**的三问打 `/systemone`）、`.work/cc-probe3.mjs`（响应头/配额线索）；key 从 `.work/cc-key.txt` 读、不打印、不入库（`.work/` 已 gitignore）。
- 复现命令（key 以文件注入，不写进命令行）：
  `POST https://api.commandcode.ai/provider/v1/systemone`，头 `Authorization: Bearer <CMD_API_KEY>` + `Content-Type: application/json`，体 `{"model":"typesafe/jev","state":…,"questions":{…}}`。
- 实测延迟：最小示例 3.2–4.9 s（121 B）；我方三问 1.4 s（510 B）；三轮共 3 次调用**全部 200，无 429**。
- ⚠️ 未覆盖：真实一局（~1.2K 输入 token × 40+ 手）下的**配额与并发**未知；`usage` 里同样有 `input_tokens`/`output_tokens`（成本口径不变）。

### 2.2 C1b 采样可控性探针（已完成，2026-10-03；详细版见阶梯计划 §2.1 探针 B）

- 同一请求体连发 3 次，概率图**不逐字节一致**（抖动 0.01–0.03），**top-1 稳定**；`temperature: 0.0` / `top_p: 1.0` / `seed: 12345`（及三者同送）一律 **200、`usage` 不变、抖动照旧** ⇒ 参数被静默忽略。
- 对 G-B 的含义：**兜底提供方不提供任何可复现性保证**，`provider` 分桶比分时要连带说明「备用桶本身有 ±1–2 pt 概率抖动」；也因此 `probSource='derived'`（无逐点概率时的降级）必须有独立标记，不能与主提供方混桶比。
- 请求形状约束（主/备两路共用）：`questions.move.criteria` **必须是 record**（键=着法记法），送数组 → 400 `Invalid input: expected record, received array`；只给顶层 `options` 时模型会回标签词而不是着法。C2 的离线夹具要**照抄真实响应形状**（`{"model","answers":{"move","edge","position"},"usage"}`），别自己发明。
- 探针脚本 `.work/probe-sampling.mjs`、`.work/probe-shape.mjs`（gitignored；跑一次约 1.3K tokens，用完可删以免继续计费）。

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
- **D-A5 三键一起上，但留退路**：用户 2026-10-03 拍板「三个一起记」（D-A1 全量）。若 C0 实现中预算超支，退路是先只落 `candsSent`（用户原话要的就是「由 Jev 决定的候选点有几个」），但**任何时候都不动 `cands` 的历史语义**。

### B 部分（兜底提供方）

- **D-B1 直换三元组，不写协议适配器**（C1 实测协议同形）：新增纯模块 `src/core/jev/providers.ts` —— `PROVIDERS` 每项 `{ id, label, url, model, keySource, kind: 'systemone' }`（`primary` = TypeSafe 原端点 + `jev-latest`；`backup` = `https://api.commandcode.ai/provider/v1/systemone` + `typesafe/jev`）+ 纯函数 `pickProvider(failures, stickyId)`。fetch 仍留在调用侧（Worker `src/worker/lib/upstream.ts`、box/Node 直连路径），`src/core/**` 保持纯函数、不碰 `fetch`。**保留 `kind: 'openai-chat'` 的设计位但不实现**——只有将来接一个非 systemone 网关时才需要适配器。
- **D-B2 触发与粘滞**：401/402/403（key/额度）、429 且 `Retry-After` 重试用尽、5xx 连续 3 次 ⇒ 切换；切换前用备用 key 打一次 `GET /provider/v1/models` 探活；**同一局内粘滞**，不回切（避免抖动把一局棋切成两半）；切换事件进 `events.jsonl`（box）/ worker 日志。
- **D-B3 降级要诚实**：备用网关若某次不返回逐点概率 → `probSource='derived'`、`cands=null`，只在 `provider` 列标记；报表按 `provider` 分桶并标注「兜底手 N 手，未计入主口径」。绝不把 `cands` 填成 `candsSent` 或 1。
- **D-B4 密钥纪律**：Worker 侧 `env.COMMANDCODE_API_KEY`（secret）；box 侧 `chmod 600` 文件（与 `/root/.jev-key` 同款）；**不写日志、不进 URL、不入库**。用户 2026-10-03 明确选择**不轮换**（视为测试 key）；因此该 key 只允许出现在 box 侧 600 文件与本机 `.work/cc-key.txt`（已 gitignore）里，仓库内任何文件都不得出现。
- **D-B5 默认兜底模型**：`typesafe/jev`（用户 2026-10-03 拍板「使用jev」，C1 已实测该 model 在 `/systemone` 可用），可用 `COMMANDCODE_MODEL` 覆盖；清单里那 85 个 chat 模型与本计划无关（`/chat/completions` 那条路不采用）。
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

> 上表是**起草时的估算**。实施结果与此有偏差，以 §4.1/§4.2/§4.3 为准：`provider`/`prob_source` 最后单独落
> `migrations/0004_move_provider.sql`（0003 当时已应用到远程，不再改历史迁移）；`src/worker/lib/upstream.ts`
> 的改动落在新增的 `src/worker/lib/failover.ts` + `routes/jev.ts` 的 `providerAttempts()`。
| `src/core/jev/providers.ts`（新） | provider 表 + 失败分类 + 粘滞选择（**无协议适配**；`kind: 'openai-chat'` 只留空位不实现） | ~110 行 |
| `src/worker/lib/upstream.ts` + `src/worker/routes/jev.ts` | 依 provider 表选端点（url/model/key 三元组）、失败分类映射、切换粘滞状态与时序归因 | ~80 行 |
| `src/ui/panels/experiment-report.ts` | `SideStat` 加候选均值、`expAggregate` 加列、`ExperimentEntry` 透传 | ~60 行 |
| `test/engines/*`（自检） + `test/ui/experiment-report.spec.ts` + `test/scripts/*`（provider 表纯单测、SigV4 无关） | 覆盖 A1/A4 与 D-B1/D-B3 | ~140 行 |
| 文档 | 本计划 + `docs/status.md` 口径行 + `README.md` 数据/命令 + `CHANGELOG.md` + `docs/memory/MEMORY.md`；B 部分是否单开 `docs/adr/0020-provider-failover.md` 待批 | ~60 行 |

### 4.1 C0 实施记录（2026-10-03，已完成）

改动体量：15 文件 / +352 / −24，另新增 `migrations/0003_move_cands.sql`。落地口径与 §3 A 部分一致（三数一起记、非 Jev 侧 NULL、老归档 NULL）：

| 落点 | 实际实现 |
| --- | --- |
| `migrations/0003_move_cands.sql` | `cands_sent INTEGER` + `cands_labeled INTEGER` 两列；注释写明 NULL 两义（0003 之前的老归档；Rapfi/mock/人类侧根本不过 Jev 候选集——**写 0 会把均值拉低**）与一句按轮 SQL 范例 |
| `src/core/jev/client.ts` | `cands = entries.map(([n]) => n)`、`candsSent = entries.length`、`candsLabeled = entries.filter(([, label]) => typeof label === 'string' && label.length > 0).length`；两个返回点（回退分支 `candidates: 0`、主分支 `candidates: pairs.length`）都带三键；`cands` 历史口径不动 |
| `src/core/meta.ts` | `AiMoveMeta` 两可选键（「是 number 才写」）；新增 `CandsStat { graded, sent, labeled, n }` 与 `AiGameMeta.candStats`，`aiGameMeta()` 按手累加（无样本整键省略） |
| `src/shared/record-map.ts` | `MoveRow.cands_sent/cands_labeled` + `ai ? num(ai.candsSent) : null` |
| `src/worker/lib/record-input.ts` · `src/worker/db/games.ts` | 入参白名单；`GAME_MOVE_COLUMNS` 加两列、`GAME_MOVE_INSERT` 扩到 `?15, ?16`、bind 追加 `?? null` |
| `src/app/experiment.ts` · `src/ui/panels/experiment.ts` · `src/ui/panels/experiment-report.ts` · `styles/style.css:1066` | `sideTactics()` → `sideStats()`（一次 `aiGameMeta` 同取耗时与候选）；`ExpResult`/`ExpHistoryGame` 透传 `blackCands`/`whiteCands`；`ExpTotals` + `SideStat` 三个按手加权均值与新列「候选发评标」（非 Jev 身份 `—`）；累计行「候选点均值 发 X / 评 Y / 标 Z（N 手）」 |

验证：`npx tsc --noEmit` 0 错；`node test/engines/run.mjs` **144 例**（原 142 + 2，含 `candStats` 均值 `sent=63 / graded=51.7 / labeled=19 / n=2`）；`npx vitest run` **37 文件 / 385 例**（原 382；新增 worker「候选点三数落库」（第一手 58/64/21、第二手 Rapfi 三列全 NULL）与 ui「候选点三数：按手加权分桶，非 Jev 身份记 —」（63/55/19，`rapfi||1000` 行 `—`））；`test/parity` 黄金零漂移（未动引擎与既有键）。

### 4.2 C2 实施记录（2026-10-04，已完成）

改动体量：18 文件 / +1809 / −41（三个提交：`e70fcd1` 主体、`9a0c709` 与 `56bed31` 两个 box 真跑才会露头的缺陷修复）。落地口径与 §3 B 部分一致（三元组切换、局内粘滞、探活、逐手归属、默认关）：

| 落点 | 实际实现 |
| --- | --- |
| `src/core/jev/providers.ts`（新，~300 行） | 提供方表（`primary` = TypeSafe `jev-latest`、`backup` = commandcode `typesafe/jev`）、失败分类 `classifyStatus`（auth/rate-limit/server/client）、切换状态机 `noteSuccess`/`noteFailure`/`pickProvider`（粘滞优先、判死不复活、全死回落主家）、`formatProviderSwitch`、两个头常量 `X-Jev-Provider`/`X-Jev-Provider-Switch`。**纯叶模块、无 import**：Worker 面为了两个头常量 import 整个 `client.ts` 会把战术链拉进包 |
| `src/core/jev/client.ts` | `attemptsFor`/`callRaw`/`callWithRetry`/`probeProvider`/`callWithFailover`；`httpError()` 让错误带上状态码（切换层必须按状态分类，而 `markRetryable` 的静态类型是 `Error`）；`decide()` 把 `provider`/`probSource` 写进 meta（D-B6：`channel` 不动）；`decodeSwitchReason` 解 Worker 回执头 |
| `src/worker/lib/failover.ts`（新，~175 行） | Worker 面同一套判据，但**每请求独立、无跨请求计数** ⇒ 429/529 一次即视为用尽；5xx 先在本家连试到 `SERVER_FAILURE_LIMIT` 才切；探活不过**不切**（切过去只是把同一个错换个文案） |
| `src/worker/routes/jev.ts` · `src/worker/env.ts` | `providerAttempts()` 依 `env.COMMANDCODE_API_KEY` + `env.JEV_FAILOVER`（默认 off）或客户端显式 `X-Jev-Provider: backup` 决定是否带兜底；成功响应回 `X-Jev-Provider`（+ 切换时 `X-Jev-Provider-Switch`，中文原因百分号编码——HTTP 头只认 latin-1）；`wrangler.jsonc` 增 `vars.JEV_FAILOVER: "off"` |
| `src/core/meta.ts` | 逐手 `prov`/`probs`、局级 `providers`/`probSources`，沿用「有值才写」纪律 ⇒ `test/parity` 黄金零漂移 |
| `scripts/lib/upstream.mjs` · `scripts/experiment-worker.mjs` · `scripts/lib/ladder.mjs` · `scripts/experiment-ladder.mjs` | `resolveBackupKey`（`COMMANDCODE_API_KEY` → `/root/.cc-key`，取不到**不抛**）；worker 增 `--backup-key-file`/`--expect-backup`，逐手计数进 `result.providers`，切换写日志 + `events.jsonl` 的 `provider` 事件；阶梯把两个新参数写进每轮 plan |

**顺带修掉的隐性缺陷（C2 之外，但同一次改动暴露）**：Hono 的 `c.header()` 预备头在「直接 return `fetch()` 响应」这条路径上会被丢掉（`node_modules/hono/dist/context.js:111-125` 的 res setter 只在 `#res` 已存在时合并）⇒ 旧实现的 POST 成功响应其实**没有 CORS 头**，同源部署看不出来、跨源就抓瞎；现在成功路径自己拼 Response 并显式合并。

验证：① `npx tsc --noEmit` 0 错；`node test/engines/run.mjs` **153/153**；`npx vitest run` **49 文件 / 617 例**；`check:docs` 60 md / 422 链接；指纹一致（210 行）。② 单测覆盖三条触发与反向不触发：`test/core/providers.spec.ts` 12 例（分类矩阵、状态生命周期、粘滞、全死回落）、`test/core/jev-failover.spec.ts` 10 例（401/429 用尽/5xx×3 三条触发、探活失败不切、无 backupKey 时老行为逐字不变、夹具形状）、`test/worker/jev.spec.ts` **+9 例**（`callUpstreamWithFailover` 六条 + `providerAttempts` 三条）。③ **离线夹具**：2026-10-04 在 box 上用我方真实三问打真网关抓的请求/响应对落 `test/fixtures/jev/commandcode-systemone-2026-10-03.json`（3152 B，`move.probabilities` 六点、`edge.noul 0.61`、`position.score 2.51`），协议漂移时单测先红。④ **box 端到端验收见 §5 C2 行**。

### 4.3 C3 实施记录（2026-10-04，已完成）

改动体量：11 文件（10 改 + 新增 `migrations/0004_move_provider.sql`）/ +221 / −18（代码与单测侧，文档回填另计）。口径与 §3 B2/B3 一致：**逐手**记「谁答的 + 概率是不是模型给的」，报表把兜底手从主口径里单列出来：

| 落点 | 实际实现 |
| --- | --- |
| `migrations/0004_move_provider.sql`（新） | `ALTER TABLE game_moves ADD COLUMN provider TEXT;` + `prob_source TEXT;`，列注释列全四个 profile id（`primary`/`backup`/`custom`/`random`）与两个概率来源（`exact`/`derived`），并写明「Rapfi/mock/人类侧与 0004 之前的老归档一律 NULL——缺失表示当时还没这个口径，**不表示** primary/exact」 |
| `src/shared/record-map.ts` | `MoveAiMeta` 补 `prov`/`probs` 两个可选键（**漏了这一步 tsc 会直接报 TS2339**，见「坑」）；`MoveRow` 补 `provider`/`prob_source`；映射沿用 `strOrNull`（非空字符串才算，`ai ? … : null`） |
| `src/worker/lib/record-input.ts` · `src/worker/db/games.ts` | 入参白名单显式搬运 `provider`/`probSource`（不能靠 camelize）；`GAME_MOVE_COLUMNS` 加 `provider, prob_source AS probSource`；`GAME_MOVE_INSERT` 扩到 `?17, ?18`；bind 追加 `?? null` |
| `src/app/experiment.ts` | `sideStats()` 一次 `aiGameMeta()` 多取一个 `providers`（`g.providers ?? null`）；`onExperimentGameEnd()` 透传 `blackProv`/`whiteProv` |
| `src/ui/panels/experiment.ts` · `experiment-report.ts` | `ExpResult`/`ExpHistoryGame` 透传 `blackProv`/`whiteProv`；`ExpTotals.providers`/`fallbackMoves` 与 `SideStat.providers`/`fallbackMoves`（`mergeProvs` 只认正整数、`provMovesOf` 给分母）；累计行新增**「上游兜底 N 手（未计入主口径 · 主口径 M 手 · primary … · backup …）」**，轮注脚多一行「上游兜底 N 手（未计入主口径）」，逐身份的兜底手数进「候选发评标」格 tooltip |

**坑（写在这里，MEMORY 也记了）**：① 报表里兜底手数与候选点样本是**两件事**——第一版把兜底后缀拼在「有候选样本」那个三元表达式的 else 支里，于是「这一手是谁答的」被前一个条件整条吞掉（UI 单测直接抓到）；② `MetaMove` 这类**显式类型**必须跟着加键，否则映射代码编不过（TS2339），而宽松的 `GamePayload['moves']` 看不出来。

验证：① `npx tsc --noEmit` 0 错；`node test/engines/run.mjs` **153/153**；`npx vitest run` **49 文件 / 619 例**（原 617，+1 worker +1 ui）；`npm run check:docs` 60 md / 422 链接；`node test/engines/fingerprint.mjs --check` 210 行一致；`test/parity` 黄金零漂移（只加列，没有新归档键进黄金）。② 新单测：worker「上游提供方归因落库」三手（`backup`/`exact` 写值、Rapfi 侧 NULL、0004 前老归档形状 NULL）、ui「上游兜底手数」两局（`{primary: 38, backup: 4}`、Rapfi 身份空表、累计行与轮注脚文案、tooltip 有/无兜底）。③ **迁移已应用到本地与远程 D1**（`node .work/wrangler-run.mjs d1 migrations apply jev-qiguan --local` / `--remote`，各 3 条语句）；远程只读复核：`game_moves` **19298 手不变、provider/prob_source 全为 NULL**（老归档 0 改写）。④ 生产 Worker **尚未重新部署**（`deploy.yml` 刻意只留 `workflow_dispatch`）：部署后生产棋谱才会开始写这两列，属业主决定项（见 §7）。

---

## 5 阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **C0**（✅ 已完成 2026-10-03） | A 部分：三数落库 + D1 迁移 + 报表列 + 测试 | ✅ `tsc` 0 错；引擎自检 144 例 + vitest 37 文件 / 385 例全绿；黄金零漂移；D1 新列对 Jev 手非空、对 Rapfi 手与老归档 NULL（`test/worker/routes.spec.ts` 往返用例钉住）；报表新列与累计行见 §4.1 |
| **C1**（✅ 已完成 2026-10-03） | 只读探针：端点、协议同形、逐点概率、配额线索 | 结论见 §2.1 表与探针记录（`/systemone` + `typesafe/jev` → 200，`answers.move.probabilities` 存在；`/chat/completions` 不接受 Jev 模型；无限流头） |
| **C2**（✅ 已完成 2026-10-04） | B 部分：`providers.ts` + Worker 接线 + Node/box 直连路径共用同一策略 | ✅ 实现见 §4.2。**box 端到端真跑（坏主 key + 真兜底 key）**：`official\|v14-live3-fresh\|0 vs rapfi\|\|500` × 4 局（`--store local --upstream direct`，零 CF 触碰），**4/4 局全部终局**、比分 `W4-D0-L0`（27/26/25/30 手，A 奇数局执黑、偶数局执白各胜两局）；每局第 1–2 手即 `HTTP 401：key 或额度（不重试，直接切）` ⇒ 探活 `HTTP 200`（11–40 ms）⇒ 切到 `backup`，之后**局内粘滞不再回切**；**逐手可辨**：`games/*.json` 每手 `ai.prov='backup'`、`ai.probs='exact'`（55 手全部 `backup`，无一 `primary`、无一 `derived`），`events.jsonl` 四条 `kind:"provider"` 事件（`from/to/reason/probeStatus/probeMs`），日志 `provider[backup:14]` 逐局一行。**单测覆盖三条触发**：401（`providers.spec.ts` + `jev-failover.spec.ts` + worker 六条）、429 用尽（直连面 5 次重试后切、Worker 面一次即切）、5xx×3（`SERVER_FAILURE_LIMIT`），外加「探活不过不切」「无 backupKey 时老行为逐字不变」「4xx 不切」「网络错不切」四类反向用例。**测试期额外发现并修掉两处**（见 §4.2 与「回滚」）：切换事件回调 `outDir` 未定义（每次切换整局变 error）、逐手统计把 rapfi 侧记成 `unknown`。切换手成本记录（m07650/m08110 口径）：模型往返 mean 1692 / median 1462 / max 3531 ms，战术层 mean 823 / max 2839 ms（占单手 48.6%） |
| **C3**（✅ 已完成 2026-10-04） | 归因与报表：`provider`/`prob_source` 落库 + 报表分桶 + 文档 | ✅ 实现见 §4.3。**落库**：`migrations/0004_move_provider.sql` 两列已应用到本地与远程 D1（各 3 条语句），逐手写 `provider`/`prob_source`，非 Jev 侧与老归档写 NULL（远程复核：19298 手全 NULL、计数不变 ⇒ 老数据零改写）。**报表分桶**：累计行给出**「上游兜底 N 手（未计入主口径 · 主口径 M 手 · primary … · backup …）」**，轮注脚与逐身份 tooltip 各有一处；`FALLBACK_PROVIDER='backup'`、`mergeProvs`/`provMovesOf`/`fmtProvs` 三个纯函数可单测。**护栏**：worker 往返用例钉住「Jev 手有值 / Rapfi 手 NULL / 0004 前老归档 NULL」，ui 用例钉住逐侧合并与「未计入主口径」文案，`test/parity` 黄金零漂移。**验证**：`tsc` 0 错、引擎 153/153、vitest **49 文件 / 619 例**、`check:docs` 60 md / 422 链接、指纹 210 行一致。**未做**：生产 Worker 尚未重新部署（`provider` 列在生产要等一次 `workflow_dispatch` 部署才开始写入，见 §7） |
| **C4**（随下一次实验） | 与 G-B2 合并跑（直连上游 + 兜底），并报战术层耗时与成本对照 | 见 [fidelity-and-elo-ladder](2026-10-03-tactics-fidelity-and-elo-ladder.md) §7 报表第 ①②⑥ 项 |

**回滚**：C0、C2、C3 各自独立可回滚（迁移只加列、不改既有列；C3 的报表行只在 `fallbackMoves` 非 0 时出现，回滚 = 不再部署新 Worker，已写入的 `provider` 值留着不影响任何口径；provider 表可由环境变量停用——生产路径的兜底本来就没开，`vars.JEV_FAILOVER: "off"` **且**不配 `COMMANDCODE_API_KEY` 时 `providerAttempts()` 只返回主家一个尝试，直连面的错误文案与尝试次数由单测逐字钉住；唯一的非对称处是 Worker 成功响应现在自带 CORS 头，那是修 bug 不是行为开关）。

---

## 6 风险

| 风险 | 处置 |
| --- | --- |
| 第三网关条款/零留存未知（棋局不是隐私数据，但要说明） | 文档写明数据去向；如用户要求，兜底只用于实验面、不进生产默认路径 |
| 备用网关某次不返回逐点概率，或将来协议漂移 | D-B3：如实标 `derived` + 报表分桶；`providers.ts` 单测用**离线夹具**（C1 的真实响应体）钉住形状，漂移时单测先红 |
| 网关**配额/并发未知**（响应头无线索） | 保守串行 + 429 退避；先在实验面小样本试跑，再决定是否给生产路径开兜底 |
| 切换抖动导致一局被切碎 | D-B2 局内粘滞 + 探活 + 事件日志 |
| 新列让 `test/parity` 黄金 diff 失败 | 「是 number 才写」纪律 + 老归档零键；黄金用例显式覆盖 |
| box 直连备用网关不通 | 与 G3 同一降级路径（经业主 Worker + `--allow-production`），或只用 Worker 侧兜底 |
| token 已进会话记录（用户选择不轮换） | 只在 box 600 文件与本机 `.work/cc-key.txt`（gitignore）留存；仓库/日志/URL 一律不出现；`git grep` 抽查作为收尾动作 |

---

## 7 拍板记录（2026-10-03）与仍开放项

已拍板：

1. **口径** → 三个一起记（`cands` + `candsSent` + `candsLabeled`），见 D-A1/D-A5。
2. **B 的形态** → 保概率契约；C1 实测证明**不需要适配器**（协议同形），直接按 D-B1 的三元组切换。
3. **兜底模型** → 用 Jev 本体（`typesafe/jev`，走 `/provider/v1/systemone`），见 D-B5。
4. **token** → 不轮换（视为测试 key），见 D-B4 的留存纪律。

仍开放（不阻塞 C0）：

- **兜底是否进生产路径**：C2 已把两个运行面都接好，但**默认关**（`vars.JEV_FAILOVER: "off"` + 未配
  `COMMANDCODE_API_KEY` ⇒ 只走主家）。要不要给生产打开，取决于网关配额（§2.1 未覆盖项）与业主对第三方路径的接受度；
  打开只是一条 `wrangler secret put` + 一个变量，随时可回滚。
- **是否单开 ADR（编号会是 0022，0020/0021 已占）**：若兜底进生产路径则开，否则只在本计划与 `status.md` 记录。
- **生产 Worker 何时重新部署**：`deploy.yml` 只有 `workflow_dispatch`（ADR-0010），所以 C2/C3 的代码至今只活在实验面与本机；远程 D1 的 `provider`/`prob_source` 两列已就位，但**生产棋谱要等一次手动部署才会开始写这两列**。
  部署本身不改变任何默认行为（兜底仍 `off`、报表只在有兜底手时才多一行），属业主决定项。

---

## 8 与其他计划的关系

- 与 [fidelity-and-elo-ladder](2026-10-03-tactics-fidelity-and-elo-ladder.md)：**正交**。那边的 P5 报表直接消费本计划的三个计数；那边的 P4b「离线运行面」复用本计划的 provider 表（直连上游 + 兜底是同一层）。
- 与 v14/机制线：无交集（本计划不碰战术语义，不改 `src/core/tactics.ts` 的裁决路径）。
- 与 `m07650`/`m08110` 的成本口径：本计划新增的「候选点数」是**第三个独立维度**（耗时 / 候选数 / 胜负），报表里三者并列，仍不混算。
