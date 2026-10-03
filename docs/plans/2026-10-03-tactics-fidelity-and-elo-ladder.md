# 计划：战术「任意版本可回溯」语义冻结 + 远端 Elo 能力阶梯

> 类型：**实施计划（未开工，等业主确认范围）**。状态：**📋 待批（2026-10-03 起草，同日按业主补充要求修订：并入卫生包五条 + 新增 G3 运行面独立）**。
> 触发：项目所有者要求（2026-10-03，逐字）：「参考 …/2026-10-03-tactics-coupling-audit.md，这些问题怎么办，我需要战术可以回溯到任意版本，我想要让机器在远端跑 elo 比较各版本的战术以及 rapfi@不同时间真正的能力，给出计划」。
> 补充要求（2026-10-03 同日，逐字）：「这些也要包含到计划里，可以让这个测试全在云端服务器上本地跑，不连接我自己的 cf worker，减少连接数，但我可以通过 ssh 来检验进度，最终将结果上传到桶中」⇒ ① 上一轮给的「建议打包（五条）」**并入本计划**（见 §3.1）；② 新增 **G3 运行面独立**（见 §1、§4、§6 P4/P4b）。
> 上游输入：耦合性审计 [2026-10-03-tactics-coupling-audit.md](2026-10-03-tactics-coupling-audit.md)（12 条耦合风险 + §4 两条静默回退坑 + §5 四类不按版本裁剪的漂移）、
> 远端批量设施 [2026-10-03-remote-batch-experiments.md](2026-10-03-remote-batch-experiments.md)（D1–D9 决策、§9 遗留）、
> 机制线收口决定 [2026-10-03-tactics-v14-fresh-live3.md](2026-10-03-tactics-v14-fresh-live3.md) §8。
> **本计划正是「机制线恢复」的前置条件**：收口时定的恢复门槛是「先有能分辨 5 pt 以内差异的口径」，而 5 pt 分辨率 = 配对开局 + 足够样本 + 可回溯的版本语义。

---

## 1. 目标（两条，都可验收）

**G1 战术可回溯到任意版本**——给定档位 id，能在 HEAD 上确定性地重放出「这一版的行为」，并能证明它没被后来的改动悄悄改掉。
可验收子项：① 档位 = **完整行为记录**（机制集 + 引擎预算 + soundness 闸门 + 开局短路阈值 + prompt 事实集 + 标签口径），不再依赖「HEAD 里那些写死的常量」；② 每个档位有**冻结指纹**，改任何共享代码导致老档决策变化 ⇒ 测试红灯；③ 未登记档号**报错**而不是静默回落；④ 对 v0–v13 做**考古**，逐档给出「当时到底是什么」与置信等级；⑤ 提供离线工具：拿任意历史棋谱 × 任意档位重放，逐手列出「这手会不会不一样」。

**G2 远端机器跑 Elo，比较各版战术与 `rapfi@不同思考时间` 的真实能力**——在同一根标尺上给出带置信区间的能力值与 Rapfi 的「思考时间 → 能力」曲线。
可验收子项：① 身份口径沿用 `渠道|战术档|思考ms`（不新造）；② **配对开局**（同开局换色双局）压掉开局方差；③ Bradley-Terry 评分 + bootstrap 置信区间 + 锚点固定；④ 阶梯产物**不写生产 D1**（只回传一行汇总），保护免费写额度与 `games` 表洁净；⑤ 报表同时给「能力」与「成本」（AGENTS.md 铁律 11 + m07650/m08110 的必报项），**只有置信区间不重叠才允许说「A 比 B 强」**。

**G3 运行面独立（2026-10-03 追加）**——整条实验面在远端服务器**本机离线跑完**，不连业主的 Cloudflare Worker、不写生产 D1、不依赖任何常驻服务；进度只用 SSH 就能看到；最终结果上传对象桶留档。
可验收子项：① 一次完整阶梯跑完后，业主 Worker 的请求日志/`experiments` 表**零新增**（唯一例外是显式 `--allow-production` 的手动动作）；② 跑动期间 `ssh <host> "cat <batch>/progress.json"` 能读到「第几轮/第几局/比分/已用时/预计剩余」，不依赖 HTTP 服务；③ 每轮结束把 `plan + JSONL + progress + report + elo` 上传桶（`ladders/<batchId>/`），断线重连可按桶内前缀续跑；④ 直连上游的调用**自限速**（默认 30 req/min、单上游臂并发 1），429 熔断退避。

**不追求**：逐字复现 rapfi 的节点级行为（时间限制搜索天然不可逐字，见 ADR-0019「后果」）；Glicko/TrueSkill；把战术层做得更强（机制线仍暂停，本计划只做「可回溯」与「能测量」）。

---

## 2. 现状硬事实（写计划前已核实）

| 事实 | 出处 |
|---|---|
| 登记表 **15 档**（`v0-off` + 14 个战术版本）、**18 个机制键**、`CURRENT = v14-live3-fresh` | `src/core/tactics-versions.ts` |
| `resolve()` 未知 id / 空 id ⇒ **静默回落 CURRENT**（坑 1，被测试固化为特性） | `src/core/tactics-versions.ts:95-99`；`test/engines/tactics.test.mjs:135`、`:439-460` |
| `resolveVersion()` catch ⇒ **ALL_MECH 全开**（等同 CURRENT 行为，坑 2） | `src/core/tactics.ts:125-131` |
| `sound` 是死键，`defenderWinsFull()` 在 VCF 里**无条件执行** ⇒ HEAD 上跑 v7/v8 也带 v9 闸门 | `src/core/engines/gomoku.ts:313`、`:277-288`；全 `src/core` grep `sound` 只命中登记表 |
| 12 个预算常量全部写死且从不经 opts 下传（`VCF_PLIES=7`、`VCT_PLIES=9`、`NODE_LIMIT=4000`、forcing 12、`VCT_NODE_LIMIT=3000`/`VCT_MOVES_MAX=10`/`VCT_DEFUSERS_MAX=6`、`VCT_DEF_MAX=12`/`VCT_DEF_KEEP=3`/`VCF_DEF_PLIES=7`、`PRESSURE_CUT_MAX=120`/`PRESSURE_CUT_KEEP=3`、`LIVE3_DENY_EVAL_MAX=24`），且缺省被调过（注释自证 14/6000/∞ → 10/3000/6） | `src/core/tactics.ts:96`/`:99`；`src/core/engines/gomoku.ts:210`/`:271`/`:438-444`/`:674-676`/`:781-782`/`:28` |
| `src/core/types.ts:161-203` 的引擎签名**已经支持**按版本传预算（`VcfOptions`/`VctOptions`/`VctDefenseOptions`/`Live3Options`），只是战术层没接 | `src/core/types.ts:161-203` |
| `attachFacts()` 无条件把**全部机制**的中英说明追加进指令 ⇒ 跑 v1 时模型收到的 prompt 比当年长（与 mech 门正交，任何开关修不掉） | `src/core/tactics.ts:412-428` |
| 开局一刀切 `moveNum < 4 ⇒ emptyTactics`，对所有版本生效 | `src/core/tactics.ts:243-246` |
| 每手 `tv`、每局 `tacticsVersion/blackTactics/whiteTactics`、`code_version`、`tac_ms` 已归档 ⇒ **归因链完整**；但回答不了「这版是不是当年的那版」 | `src/core/jev/client.ts:541-542`、`src/shared/record-map.ts:380`、`src/core/record/export.ts:62-64/216` |
| 直连上游可行且与 Worker 转发同构：上游端点硬编码 `https://api.typesafe.ai/v1/systemone`（`DEFAULT_UPSTREAM_URL`），鉴权 `Authorization: Bearer <apiKey>`，请求体白名单只留 `state`/`model`/`questions` | `src/worker/lib/upstream.ts:37`/`:137`、`src/worker/routes/jev.ts:77-83`；渠道表 `src/core/jev/client.ts:27-28` |
| 远端设施现状：`experiment-worker.mjs` 每局 POST 生产 D1；`batch-elo.mjs` 是 **K=16 顺序 Elo**（起分 1500、和棋 0.5、`MIN_GAMES=50` 只作标注），无置信区间、无锚点、无配对设计 | `scripts/experiment-worker.mjs:511`、`scripts/lib/batch-elo.mjs:93-133` |
| 已测的对手抬档阶梯（v14 vs rapfi）：1 s **9-1-2**、2 s **9-3-8**、3 s **15-1-4**、5 s **12-1-7** —— **非单调**，同档两轮差 17.5 pt > 档位之间的差 ⇒ 现有比分口径无法分辨 < 5 pt 的差异 | `docs/plans/2026-10-03-tactics-v14-fresh-live3.md` §6.6–§6.8、`…-v14-evidence.md` §4.5 |
| 单局成本实测锚点：proxy vs `rapfi@1000` ≈ **97 s/局**（12 局 1165 s）、`@2000` ≈ 173 s/局（20 局 3453 s）、`@3000` ≈ 104 s/局（20 局 2089 s）、`@5000` ≈ 145 s/局（20 局 2898 s）；`rapfi@500` 自对弈 ≈ 52 s/局（ADR-0019） | 各轮 `.work/exp-arm*.log`、ADR-0019 §5 |

**一句话诊断**：归因链已经能回答「是哪一档跑的」，但**回答不了「那一档当时是什么」**（§5 四类漂移）；能力测量又因为**开局运气 + 上游采样方差**而分辨不出 < 17 pt 的差异。本计划两半正对这两件事。

### 2.1 探针记录（2026-10-03，开工前两项探针已完成）

**探针 A：Rapfi 的确定性搜索预算（`INFO max_node <n>` 可用）** —— 结论：**有与墙钟无关的硬上限**，但**没有种子/随机性控制**。

- 选项清单的字符串表**不在** `public/rapfi/rapfi-single-simd128.js`（37,972 B，只有 Emscripten 锅炉代码），而在两处：`.data` 前 6713 B 是内嵌 `config.toml`（导出为 `.work/rapfi-config.toml`）；`.wasm` 里是长度前缀 token 池（`MAX_NODE`/`TOTALTIME`/`THREAD_NUM`/`START_DEPTH`/`STRENGTH`/`YXHASHCLEAR`/`YXSHOWINFO` 等）。
- 运行时 `INFO` 参数（每个都用**全新引擎实例**单独验证，名字大小写不敏感）：
  - **接受（静默）**：`timeout_turn`、`timeout_match`、`time_left`、`time_increment`、**`max_node`**、**`max_depth`**、`max_memory`、`thread_num`、`show_detail`、`hash_size`、`strength`、`checkmate`、`start_depth`、`thread_split_depth`
  - 接受但校验值：`search_type`（`ERROR Unknown search type: 0, must be one of [alphabeta, mcts]`）、`max_memory`（`ERROR Max memory too small, might exceeds memory limits`）
  - **拒绝**（`MESSAGE Unknown Info Parameter: X` + `ERROR Unknown command: <v>`）：**`seed`、`random`**、`max_hash_size`、`turn`、`seldepth`、`totalnodes`、`bestline`、`num_pv`、`speed`、`cau_factor`、`drawrate`、`swap`、`trace_search`、`traceboard`、`lang`、`reloadconfig` ⇒ **没有任何种子/随机性控制选项**（`BATCH_PAIRED` 若要靠引擎种子做配对，只能改用「固定节点预算 + 固定开局」这条路，见下）。
  - 陷阱：一次连发多参数时部分拒绝消息会被长流截断（清单以单实例逐参数验证为准）。
- **固定预算演示**（`.work/rapfi-budget.mjs MAX_NODE 200000 3`，固定局面、每轮全新引擎）：三轮 `move=3,11`、`Depth 26-25`、`Node 200K` **全同**，只有墙钟浮动（380/400/415 ms）。缩放：100K → Depth 23-23；1M → Depth 31-36；1K → Node 1021（小预算 ≤ ~2% 超调）。同实例重复同一 `BOARD`（先 `YXHASHCLEAR` → `MESSAGE Transposition table cleared.`）：着法与 Node 恒定，**第 2 次的 Depth 会因置换表命中变浅**（写报告时要注明）。
- **反例（墙钟不确定）**：`timeout_turn 1000` ×4 → Node `455K/344K/344K/344K`、Depth `29-28` vs `28-25` ⇒ 现有 `INFO timeout_turn <ms>` 口径**不可复现**。
- 上限**按手重置**（`timeout_turn 2000` + `max_node 20000` 连走 4 手 → 每手 Node 20K，42–53 ms/手）；`thread_num 4` 与 `1` 完全无差异（单线程 wasm 构建，无并行不确定性）；`max_depth 12` 同样生效（Node 1890 恒定）。
- 落地改动点：`src/core/jev/rapfi.ts:240` 现硬编码 `INFO timeout_turn <ms>`；节点数只能从 `INFO show_detail 1` 的 `MESSAGE` 行读；core 的 `parseMoveLine` 只认 `^\d+,\d+$`，**不会把 `MESSAGE` 行误判成着法**。
- 吞吐（本机 i7-12700H，单线程 wasm）：1000 ms 决策实测 wall `791/833/855/939 ms`、Node `299K/427K/437K/474K` ⇒ **平均 854 ms/手、409K 节点/手 ≈ 1.17 手/秒 ≈ 0.48M 节点/秒**；固定预算换算 **200K 节点 ≈ 380–415 ms、1M 节点 ≈ 1.8–2.0 s**。
- Caveat：每次 stdout 开头固定三行 `ERROR Unable to open model file: "model210901.bin"` / `Failed to load config: failed to load classic model file` / `Failed to load config, please check if config is correct.`（config.toml 的 classic model 不在包内，引擎改用 `.data` 里的 mix9svq NNUE）——**是否影响棋力基线未做对照**，P2 记录口径时照抄现象，不改包。

**探针 B：上游（`/systemone` 与 commandcode 同形）的采样可控性** —— 结论：**请求级不可控，`choice` 是唯一较可复现的信号**。

- 同一请求体连发 3 次：概率图**不是**逐字节一致（`F6` 0.02/0.02/0.03、`G8` 0.32/0.30/0.30、`confidence` 0.18/0.16/0.16），**top-1 稳定为 `G8`**。
- `temperature: 0.0`、`top_p: 1.0`、`seed: 12345`（以及三者同送）**一律 HTTP 200、无错误体、`usage` 不变（588 in / 97 out）、抖动照旧** ⇒ 参数被静默忽略，**不要做 `--model-params` 管线（那是 no-op）**。
- 请求形状硬约束：`questions.move.criteria` **必须是 record**（键 = 着法记法）；送数组 → 400 `Invalid input: expected record, received array`（`param: questions.move.criteria`）。只给顶层 `options` 而不给 `criteria` 时，模型会回标签词（如 `blocking`）而不是着法 ⇒ 现有 `src/core/engines/gomoku.ts:1080` 的 criteria-record 写法是对的，别动。
- 对 D9 配对设计的影响：**配对只能配「开局 + 局面」，不能配「同一次采样」**；报告里 `choice` 之外的概率差异一律当噪声（±1–2 pt 概率 / ±0.01–0.03 置信度），这也正是「同档两轮差 17.5 pt」的上游来源。

---

## 3. 决策表（D1–D14）

| # | 决策 | 理由 |
|---|---|---|
| **D1** | **档位 = 冻结参数记录**：`VERSIONS[i]` 增 `budget`（12 个常量）、`sound: boolean`、`openingMin: number`、`promptFacts: 'mech'`、`fidelity: 'exact' \| 'restored' \| 'approximate'`。传 `tacticsVersion` 即完全决定行为，不再读 HEAD 写死常量 | 审计 §5 的直接结论：不这么做，「回溯」永远是「像当年」而不是「是当年」 |
| **D2** | **两条静默回退都改成显式失败**：`resolve()` 未知 id **抛错**（错误信息附最接近的合法 id）；`resolveVersion()` catch 回落 **`v0-off`（空机制集）**，绝不回落全开 | 审计风险 1/2。A/B 实验的单变量假设不能被无声破坏；「贴 v7 标签跑 v13」是最贵的一类错误 |
| **D3** | 预算经 **opts** 下传（`VcfOptions`/`VctOptions`/`VctDefenseOptions`/`Live3Options` 已就绪），引擎缺省值**保持不变**（= 今天的常量），只有显式给值才覆盖 | 零行为变更地拿到可冻结性；线上路径与今日逐字一致（P1 用对照测试证明） |
| **D4** | `sound` 变**活键**：`computeTactics` 的 VCF 块按 `ver.sound` 传 `defenderWinsFull` 开关，v9 之前 = 关 | 审计风险 5；顺带把「v9 起才有 soundness 闸门」这个历史事实写进登记表 |
| **D5** | `attachFacts()` 按 `ver.mech` 生成事实句，**不再无条件全量追加** | 审计 §5 第 4 条：这是唯一「与机制门正交、任何开关都修不掉」的漂移源，也是老版本 prompt 复原的唯一途径 |
| **D6** | **冻结指纹**：从归档棋谱抽 N≈120 个局面（覆盖 15 档 × 早/中盘），每档记录 `{ply, 层, 落点, facts 摘要}` 为 `test/parity/tactics-fingerprints.json`；`version-freeze.test.mjs` 断言一致，重写需显式 `--write` 且 commit 里说明理由 | 把审计 §3.3「改一处牵多档」从人工审视变成红灯；这是「没被悄悄改掉」的唯一机械证据 |
| **D7** | 指纹只记**决策**（层 + 落点 + 事实），**不记耗时** | 搜索预算下的耗时天然抖动；记耗时会让测试变成 flaky，反而逼人放宽阈值 |
| **D8** | 对 v0–v13 做**考古**（逐 commit diff `gomoku.ts`/`tactics.ts` 的常量、门、prompt 逻辑），能确证的填进 `budget/sound/openingMin` 并标 `fidelity:'restored'`；不能确证的标 `fidelity:'approximate'` 并写明缺口 | 「回溯到任意版本」对老档只能靠考古；标不出置信度就等于在猜（违反项目「no data, no guessing」） |
| **D9** | 能力阶梯用**配对开局**：一本 K≥8 的 6–8 手开局库，同一开局**换色双跑**；身份口径沿用 `渠道\|战术档\|思考ms` | 消掉「谁拿到顺手开局」的方差——已证同档两轮差 17.5 pt，不配对就永远测不出 5 pt |
| **D10** | Elo 换 **Bradley-Terry（logistic MLE，迭代 200 次，锚 `rapfi\|\|500 = 0`）+ bootstrap 95% CI**；顺序 Elo 保留为兼容视图；**样本 < 100 局/身份只做筛选，不作结论** | 现有 K=16 顺序 Elo 依赖更新顺序、无区间、起分任意 ⇒ 不能作为「真实能力」的读数 |
| **D11** | 阶梯轮**不写生产 D1**：worker 加 `--store local`（落 box 上的 JSONL），`pull` 回本地算 Elo，只 POST **一行** `experiments` 汇总；`--origin` 未给时 submit 需显式 `--allow-production` | 620 局 × ~50 手 ≈ 3 万行 `game_moves` 会吃掉免费写额度的可观比例，且把研究数据混进站点棋谱；实验数据留在实验侧 |
| **D12** | **实验面零 CF 依赖**（G3）：worker 默认 `--store local`（JSONL）+ **`--upstream direct`**（直连 `https://api.typesafe.ai/v1/systemone`，`Authorization: Bearer <key>`，key 从 box `/root/.jev-key` 读、chmod 600）；**不连业主 Worker、不写 D1**；box 侧自限速（默认 30 req/min、单上游臂并发 1、429 退避熔断）；`--origin`/`--store d1` 只作显式逃生门 | 直连上游的协议与 Worker 转发**完全同构**（`src/worker/lib/upstream.ts:37/137`：同端点、同 `Bearer`、请求体只取 `state`/`model`/`questions`），所以离线跑不损失任何实验语义，却把「连接数」与「写额度」都降为零；代价是丢掉 Worker 的限流/重试 ⇒ 必须自限速（见 §8） |
| **D13** | **进度用文件 + SSH，不引入服务**：每局结束原子写 `progress.json`（`{batchId, round, gameNo, done, wdl, elapsedS, etaS, lastGameUid}`）并追加 `events.jsonl`；`experiment-batch.mjs status --watch` / `experiment-ladder.mjs status` 经 SSH 读这两份文件并打印表格 | 业主明确要求「可以通过 ssh 来检验进度」；文件是唯一不引入常驻进程、不占端口、断线仍可读的方案（box 只有 1.3 GiB 内存，不适合再挂服务） |
| **D14** | **产物上传对象桶**：新增 `scripts/lib/s3-put.mjs`（纯 Node `crypto` 实现 AWS SigV4，零依赖）+ `batch-bucket.mjs push\|pull`；桶凭据**只从环境变量**取（`BUCKET_ENDPOINT`/`BUCKET_NAME`/`BUCKET_ACCESS_KEY_ID`/`BUCKET_SECRET_ACCESS_KEY`），每轮/每阶梯结束把 `ladders/<batchId>/{plan.json, games.jsonl, progress.json, report.md, elo.json}` 传上去；上传失败**只告警不阻断**（本地留档仍在），支持 `pull` 按前缀续跑 | S3 兼容 API 覆盖 R2/S3/B2/MinIO；自实现 SigV4 约 180 行、无依赖、可单测（不引 `@aws-sdk/*`，否则违反铁律 2）；「最终结果上传桶」是业主的原话要求，也顺带解决「box 上的数据没人看得到」 |

### 3.1 卫生包（上一轮「建议的打包」五条，全部并入本计划）

| 优先级 | 动作 | 落在哪 | 体量 | 为什么 |
|---|---|---|---|---|
| P0 | `submit` 不给 `--origin` 时**必须**显式 `--allow-production` 才放行，否则 exit 2 | P0（与 D11 闸门同一处） | ~10 行 + 1 例测试 | 上一轮审查的 5 条残留里唯一「会污染生产库」的一条；默认安全比默认方便重要 |
| P0 | `--parallel` **仅双本地臂**（两侧都不是 `proxy`）放行，否则拒绝并说明冲突 | P0 | ~15 行 + 1 例测试 | 双 proxy 并行必踩上游限流、且共享上游延迟会污染对照；rapfi-vs-rapfi 才是它的合理用途（box 40 核，本地 CPU 不是瓶颈） |
| P1 | 三条历史 tag（`exp-20261003042812-rapfi1-r1` / `exp-20261003052056-smoke1-r1` / `exp-20261003052604-x1-r1`）回填 `device_id='ssh-batch'` | P0b（数据卫生，先 `pragma_table_info('games')` 确认列名） | 1 条 SQL + playbook 补一句 | 26 局 `device_id` 为 NULL 只能按 tag 认；回填后「哪些局是设施产物」一条 where 就能查（**只回填设备归属，不改 `code_version`**，不猜 sha） |
| P1 | 报表加 **Wilson 95% 区间** + 「样本 < 50 局」标注 | P5（`batch-elo.mjs` 报表 + `.work/` 脚本） | 报表侧，不动核心逻辑 | 20 局/对的 ±22 pt 必须印在数字旁边，否则报告读起来像「已证明」 |
| P2 | 文档写死口径：**只准聚合口径**（胜/和/负 + 不败率 + 接管直方图 + 成本三口径）；单局逐手对齐只允许在**同机同进程**内做 | P3（写进 `docs/agents/playbooks.md` §7 + 本计划 §7 报表） | 一段话 | Node rapfi 与浏览器归档不可逐字复现（ADR-0019「后果」），跨机逐手比对本就是伪证据 |

---

## 4. 架构：三层 + 一条隔离边界

```
① 冻结层（src/core，G1）
   tactics-versions.ts  档位记录 = mech + budget + sound + openingMin + promptFacts + fidelity
        │  ▲
        │  └── 指纹测试（test/parity/tactics-fingerprints.json）
        ▼
   tactics.ts  ──opts──▶  gomoku.ts（预算/闸门可关，缺省不变）
② 阶梯层（scripts/**，G2 + G3）
   experiment-ladder.mjs ──▶ experiment-worker.mjs --store local --openings --upstream direct
        │                         ├─ box: JSONL 归档（不碰 D1）
        │                         ├─ box: progress.json + events.jsonl ◀── ssh 读（G3 ②）
        │                         └─ 直连 https://api.typesafe.ai/v1/systemone（不经业主 Worker）
        ▼
   batch-elo.mjs（BT + bootstrap CI + Wilson）──▶ 能力表 / 思考时间曲线 / 成本表
        │
        └─▶ batch-bucket.mjs push ──▶ 对象桶 ladders/<batchId>/（G3 ③）
③ 回溯层（离线工具，G1 的证据面）
   tactics-replay.mjs  任意棋谱 × 任意档位 ⇒ 逐手「会不会不一样」
   --rev <sha>（P7 逃生门）老 commit 出 worktree 跑，逐字复现考古标不准的档
```

**隔离边界（D12）**：`②` 整层在远端 box 上自洽运行——不需要 CF 凭据、不需要 `wrangler`、不需要业主 Worker
（`①`/`③` 也只在本地/box 上跑测试与离线重放）。业主 Worker 与生产 D1 在阶梯期间**完全不被触碰**，
除非显式 `--allow-production`；实验数据只经「JSONL → 桶」这条链外流（业主可随时 `ssh cat` 或从桶取）。

---

## 5. 文件清单

**新增（`src/core` 只加纯逻辑，不碰 IO）**

| 文件 | 内容 | 体量 |
|---|---|---|
| `src/core/tactics-budget.ts` | `TacticsBudget` 类型 + 每档预算记录 + `DEFAULT_BUDGET`（= 今日常量，逐字） | ~90 行 |
| `test/engines/fingerprint.mjs` | 语料抽取（读 `.work` 归档或用冻结的 120 局面 fixture）+ `--write` 生成指纹 | ~160 行 |
| `test/parity/tactics-fingerprints.json` | 生成的冻结产物（15 档 × 120 局面） | 生成物 |
| `test/engines/version-freeze.test.mjs` | 断言指纹一致 + `fidelity` 字段完整性 | ~90 行 |
| `scripts/tactics-replay.mjs` | 离线重放：`--game <uid>` / `--tag <tag>` / `--all --tactics <id>`，输出逐手差异表 + 汇总 | ~220 行 |
| `scripts/experiment-ladder.mjs` | 阶梯编排：round-robin 计划、颜色对称、串行调度、断点续跑、汇总一行 | ~260 行 |
| `scripts/lib/openings.mjs` | 开局库生成（从归档决胜局取前 6–8 手，去重、对称归一）与校验 | ~120 行 |
| `scripts/lib/s3-put.mjs` | 纯 Node `crypto` 的 AWS SigV4 签名 + `putObject`/`listPrefix`/`getObject`（零依赖，S3 兼容：R2/S3/B2/MinIO） | ~180 行 |
| `scripts/batch-bucket.mjs` | `push <dir> --prefix ladders/<batchId>/` / `pull` / `ls`；凭据只读环境变量，缺失则明确报「未配置桶」并 exit 3（不静默跳过） | ~110 行 |
| `scripts/lib/progress.mjs` | `progress.json` 原子读写 + `events.jsonl` 追加 + `eta()` 估算（两端共用，含单测） | ~90 行 |
| `test/scripts/{s3-put,progress}.spec.mjs` | SigV4 用**已知向量**校验（固定时间戳/密钥 ⇒ 固定签名串）；progress 原子性与 ETA 单调 | ~120 行 |
| `scripts/lib/batch-elo.mjs`（扩写） | `computeBt()` + `bootstrapCI()` + 带区间的排行表 | +~140 行 |
| `test/scripts/{openings,ladder-plan,bt-elo}.spec.mjs` | 合成数据验证：已知强弱顺序、CI 宽度随 n 收窄、开局库对称归一 | ~200 行 |
| `docs/adr/0020-tactics-fidelity-freeze.md` | 决策：档位 = 冻结记录 + 指纹；两条回退坑改显式失败 | ~110 行 |
| `docs/plans/2026-10-04-tactics-archaeology.md` | 考古结果表（逐档：budget/sound/openingMin/prompt + 证据 commit + 置信度） | P3 产出 |

**改动**

| 文件 | 改动 |
|---|---|
| `src/core/tactics-versions.ts` | 记录增字段；`resolve()` 改抛错（留 `resolveLenient()` 给 UI 下拉兜底？**不**——UI 只送白名单值，见 P0）；`selfTest()` 增断言（预算字段齐全、`fidelity` 合法、单调继承不变） |
| `src/core/tactics.ts` | 读 `ver.budget`/`ver.sound`/`ver.openingMin`/`ver.promptFacts` 并下传；`resolveVersion` catch 回落 `v0-off` |
| `src/core/engines/gomoku.ts` | 5 处搜索方法接受预算 opts（缺省 = 今日常量）；`defenderWinsFull` 受 opts 开关 |
| `src/core/types.ts` | 预算选项字段补齐（`EngineBudget`），注释写清「缺省 = 历史常量」 |
| `scripts/experiment-worker.mjs` | `--openings <file>`、`--store local\|d1`、`--device-id`（阶梯默认 `ladder-<batch>`）、**`--upstream direct\|worker`（默认 direct，读 `/root/.jev-key`）**、**`--rate-limit <n>/min`（默认 30）**、每局写 `progress.json`/`events.jsonl`、上游 429 熔断退避 |
| `scripts/experiment-batch.mjs` | `ladder` 子命令；`--allow-production` 闸门（§3.1 第 1 条）；`--parallel` 仅双本地臂（第 2 条）；`status --watch`（经 SSH 读 `progress.json`，D13）；每轮结束调 `batch-bucket.mjs push`（可 `--no-upload`） |
| `test/engines/tactics.test.mjs` | 两处「固化为静默回落」的用例改为断言**抛错**；登记表字段断言补全 |
| `docs/{README.md,status.md,agents/playbooks.md,memory/MEMORY.md}` + `README.md` + `CHANGELOG.md` | 索引、口径、教训、数字随阶段回填 |

---

## 6. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 闸门收紧**（~120 行） | D2：`resolve()` 抛错 + `resolveVersion` 回落 `v0-off` + 三个入口（worker / `experiment-run.mjs` / UI 下拉）白名单校验，错误信息含最接近合法 id；**并入 §3.1 第 1、2 条**：`--allow-production` 闸门 + `--parallel` 仅双本地臂 | `npx vitest run` 全绿（改后的用例断言抛错）；手工跑 `--tacA v12-vct-de` ⇒ **exit 2 且打印候选**；`submit` 不给 `--origin` ⇒ exit 2 并提示 `--allow-production`；`--parallel` + 含 `proxy` 臂 ⇒ 拒绝并说明；UI 下拉仍能跑（值都在白名单里） |
| **P0b 数据卫生与报表口径**（~40 行 + 1 条 SQL + 文档） | §3.1 第 3–5 条：三条历史 tag 回填 `device_id='ssh-batch'`（先 `pragma_table_info('games')` 确认列名，**不动 `code_version`**）；`batch-elo.mjs` 报表加 **Wilson 95% 区间**与「样本 < 50」标注；`docs/agents/playbooks.md` §7 写入「只准聚合口径」段 | 回填后 `select count(*) from games where device_id='ssh-batch'` = 29（26 历史 + 本轮若已跑）；报表在 20 局/对上打印 `[±22 pt]` 警告；`check:docs` 绿 |
| **P1 冻结层**（~250 行） | D1/D3/D4/D5：`tactics-budget.ts` + 预算下传 + `sound` 活键 + `openingMin` + `attachFacts` 按 mech | **零行为变更对照**：15 档 × 120 局面，逐档落点/层与改前**逐字一致**（脚本比对，作为 P1 的证据）；`node test/engines/run.mjs` 142 例全绿 |
| **P2 指纹设施**（~250 行） | D6/D7 + `version-freeze.test.mjs` + CI 接线 | 首次 `--write` 生成基线；**故意改一处 `vcfWin` 预算试红**（证明测试有效，随后还原）；`npm test`、`npm run typecheck`、`check:docs` 全绿 |
| **P3 回放 + 考古**（~220 行 + 文档） | `tactics-replay.mjs`；逐 commit diff 填 `budget/sound/openingMin`/`fidelity`；产出考古文档 | 回放工具在 `exp-20261003082805` 上跑出「与实走一致率」并列出会变的手；考古表 14 档无空缺（每格要么有证据 commit，要么标 `approximate` + 缺口描述） |
| **P4 阶梯地基**（~200 行） | `openings.mjs` + worker `--openings`/`--store local` + **D13 进度文件**（`progress.json` + `events.jsonl` + `--store local` 时零网络写） | 合成开局库可复现；一局真跑（rapfi 自对弈，开局库前 6 手逐手一致）；JSONL 产物能被 `loadRecords` 读回；`ssh <host> cat progress.json` 在跑动中可读到 `{round, gameNo, done, wdl, etaS}` |
| **P4b 离线运行面 + 桶留档**（~290 行） | **D12**：worker `--upstream direct`（读 `/root/.jev-key`）+ `--rate-limit`（默认 30/min）+ 429 熔断；`experiment-batch.mjs status --watch` 经 SSH 出表格；**D14**：`s3-put.mjs` + `batch-bucket.mjs`，每轮结束上传 `ladders/<batchId>/` | ① **零 CF 触碰验收**：一整局真跑（proxy 直连 + rapfi）后，业主 Worker 的 `experiments`/`games` 行数**不变**，且 box 上无任何指向 `jevqipan.logicc.top` 的请求（`ss -tnp` 抽查 + 代码层 `--upstream direct` 断言）；② SigV4 已知向量单测通过；③ 刻意断桶（错凭据）⇒ 跑动**不中断**、日志告警、本地 JSONL 完整；④ `pull` 按前缀取回后 `elo` 可复算 |
| **P5 Elo 升级**（~200 行） | D10：`computeBt()` + `bootstrapCI()` + 报表（含 §3.1 第 4 条的 Wilson 区间） | 单测：合成 200 局（真实强弱差 100 Elo）⇒ 点估计误差 < 25 Elo、CI 覆盖真值；CI 宽度随 n 单调收窄；`rapfi\|\|500` = 0 锚成立 |
| **P6 阶梯编排**（~260 行） | D11/D12：round-robin + 颜色对称 + 串行调度 + 断点续跑 + 一行汇总 + 桶上传钩子 | dry-run 计划表（mock 臂）逐项对齐；`--allow-production` 闸门生效（无 `--origin` 时应拒绝）；`--parallel` 双 proxy 被拒；中断后 `pull` 桶前缀可续跑 |
| **P7 逃生门（可延后）**（~150 行） | `--rev <sha>`：box 上 `git worktree add` 老 commit + 特征适配驱动（老导出可能缺 `tacticsLabel`/`thinkMsOf` 等新符号） | 在某个考古 `approximate` 档上，`--rev` 版的落点与考古预算版的差异被量化；结论写回考古文档 |

**全阶段完成后的一轮真实验（G2 交付）**见 §7。

---

## 7. 阶梯实验设计（G2）

**身份（identity）** 建议集合：`proxy|v10-live3|0`、`proxy|v11-vct|0`、`proxy|v12-vct-def|0`、`proxy|v13-pressure-gate|0`、`proxy|v14-live3-fresh|0`、`rapfi||500`、`rapfi||1000`、`rapfi||2000`（8 个身份；`rapfi||5000` 视预算追加）。

⚠️ **`proxy` 臂在本计划里是「直连上游」**（D12：box 直接打 `https://api.typesafe.ai/v1/systemone`），**不是**业主 Worker 的 `/api/jev` 转发。两者协议同构（同端点、同 `Authorization: Bearer`、请求体同样只取 `state`/`model`/`questions`，见 `src/worker/lib/upstream.ts:37/137`），所以身份口径与历史轮次仍可比；差异只在**谁来做限流与重试**——历史轮次是 Worker，本计划是 box 侧自限速（§8 风险表已列）。

**三条阶梯**（可分别跑，也可合并成一次 round-robin）：

| 阶梯 | 对局 | 局数 | 估时（按 §2 锚点） | 回答什么 |
|---|---|---|---|---|
| **L3 Rapfi 自身思考时间曲线**（先跑，纯本地不耗上游） | `rapfi@500/1000/2000` 两两 + `@5000` 对 `@1000` | 6 对 × 20 = 120 局 | ~10 h（5000 档每局 ~8 min） | 「`rapfi@不同时间`真正的能力」——用户的直接问题 |
| **L2 各版对 Rapfi** | 5 版 × `rapfi@{500,1000,2000}` | 15 对 × 20 = 300 局 | ~9 h | 版本能力沿时间轴的位移；同一版本在不同对手强度下的表现 |
| **L1 版本内侧梯** | 5 版两两 | 10 对 × 20 = 200 局 | ~5 h（双 proxy 臂，上游双倍负载，需限速） | 版本之间谁更强（**预期差异最小，最需要配对开局与大样本**） |

**样本与分辨率（诚实口径）**：单对 20 局、p≈0.5 时得分率 95% CI ≈ ±22 pt；60 局 ≈ ±13 pt；200 局 ≈ ±7 pt。⇒ **Stage 1（20 局/对）只做筛选**；**Stage 2 只对决赛对（前 2–3 名 + 锚 + 一档高 Rapfi）做 100–200 局配对确认**，才允许写「A 比 B 强」。分辨率目标 = 5 pt ⇒ 200 局/对起步（这正是机制线恢复的门槛）。

**成本纪律**：① 单上游臂串行，轮次之间 30 s 冷却；② 双 proxy 臂（L1）把 `--games` 减半或拆两晚；③ 阶梯产物落 box JSONL，`pull` 回本地；④ 每轮报 `tac_ms` 三口径 + 单步墙钟 + 模型往返（m07650/m08110 的必报项照旧）；⑤ **直连上游自限速 30 req/min + 并发 1 + 429 退避熔断**（D12，替代 Worker 的限流）；⑥ 每轮结束 `batch-bucket.mjs push`（D14），上传失败只告警。

**运行面（G3，可被业主随时抽查）**：进度看 `ssh <host> "cat /root/ladder/<batchId>/progress.json"` 或 `experiment-batch.mjs status --watch`；日志 `ssh <host> "tail -f /root/ladder/<batchId>.log"`；产物在桶里 `ladders/<batchId>/`（`plan.json` / `games.jsonl` / `progress.json` / `report.md` / `elo.json`）。整轮跑动期间业主 Worker 与生产 D1 **零新增**（P4b 验收 ①）。

**报表（每次阶梯必出）**：① 能力表（BT Elo + bootstrap 95% CI + 局数 + W/D/L + 得分率 + 锚点说明 + **Wilson 区间**）；② Rapfi「思考时间 → Elo」曲线点；③ 成本表（每手 `tac_ms` 中位/均值/p90/最坏、单步墙钟、模型往返、战术层占比）；④ 开局库分层表（每个开局谁占优，检查开局是否偏向某一身份）；⑤ 差异显著性说明（CI 是否重叠；样本 < 50 局必须标注）；⑥ 产物清单（桶前缀 + 行数 + sha256，便于复核与续跑对齐）。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 指纹把**当下的 bug** 一起冻住 | P1 先做「零行为变更对照」，P2 生成基线前先跑 P0/P1；指纹只记决策不记耗时（D7）；`--write` 必须在 commit 消息里写明理由 |
| 预算下传改变线上行为 | P1 验收要求「缺省预算 ⇒ 15 档 × 120 局面逐字一致」；引擎缺省常量**一个都不改** |
| 考古无法确证（审计 §9 的中置信项） | 标 `fidelity:'approximate'` + 缺口描述；需要逐字时走 P7 `--rev` |
| 上游采样方差 > 版本差异 | 配对开局（D9）+ 大样本 + CI 门槛（D10）；L1 结论默认只能到「筛选」级别 |
| 双 proxy 臂把上游打爆 / 429 增多 | 串行 + 冷却；`retryable` 退避已有；必要时降级为「单 proxy 臂 + rapfi」并把 L1 拆两晚 |
| D1 写额度与棋谱洁净度 | D11：阶梯不写 D1，只一行汇总；`--allow-production` 闸门（承接上一轮「写入隔离没自动化」的 P1 建议） |
| 开局库太窄 ⇒ 所有身份趋同、区分度下降 | K≥8 且覆盖不同首手/不同形状；报表出「开局分层表」，若某开局对所有身份都是同一结果 ⇒ 换库 |
| 阶梯跑完发现口径又错（重蹈 17.5 pt 覆辙） | 先跑 L3 做**口径自检**：`rapfi@1000` vs `rapfi@500` 若测不出该有的差距，说明设计或方差控制有问题，先修口径再跑 L1/L2 |
| **直连上游丢掉 Worker 的限流/重试**（D12） | box 侧自实现：令牌桶 30 req/min + 单上游臂并发 1 + 429/5xx 指数退避（4 s/12 s/25 s，沿用 `src/app/loop.ts` 的档）+ 连续 3 次 429 ⇒ **熔断暂停本轮**并写进 `events.jsonl`；跑前先做 5 次探针确认额度与延迟 |
| **直连上游的协议随上游变动**（离线面与生产转发漂移） | 请求体白名单与 `src/worker/lib/upstream.ts` 共用同一段口径（P4b 单测：同一 state ⇒ 直连与 Worker 转发**逐字同体**）；上游改协议时两条路径同时红 |
| **box 上 key 的暴露面**（`/root/.jev-key`） | 沿用 ADR-0019：`chmod 600`、只从文件读、**永不进日志/URL/产物**（`events.jsonl` 只记 key 长度）；上传桶的产物里不含 key（P4b 验收里加一条 `grep -r 'apikey_'` 必须为空） |
| **桶凭据纪律与断桶** | 凭据只从环境变量取（D14），不入仓库、不写进 box 日志；刻意断桶时跑动不中断（P4b 验收 ③）；`ls`/`push` 失败重试 3 次后告警 |
| **box 出网不可达上游 / 桶**（未知，需探针） | P4b 第一步就做探针：`curl -sS -o /dev/null -w '%{http_code}' https://api.typesafe.ai/...`（带 key）与桶 endpoint 的 `HEAD`；不可达则本计划退回「经业主 Worker」并保留 `--allow-production` 闸门（G3 降级但不失败） |

---

## 9. 开放问题（需要探针，先问再写代码）

1. **proxy 是否接受采样参数**（temperature / top_p / seed）？若能冻结，跨轮方差会显著下降 ⇒ 加了 `--model-params` 后 L1 的 5 pt 目标可能用 100 局就能达到。探针：`scripts/probe-model-params.mjs`（只读，POST 两组参数比输出分布）。
2. **Rapfi 是否支持节点数预算**（`-nodes` 之类）？支持 ⇒ 可以额外出一条「等节点数」的公平对比，并让 `--rev` 逐字复现更可行。
3. **`games` 表是否有 `device_id` 列**（历史 26 局回填用）⇒ `pragma_table_info('games')`。
4. **L3 的 5000 ms 档要不要跑**：单局 ~8 min，20 局 ≈ 2.7 h，只为一个点；业主决定。
5. **`--rev` 逃生门值不值得做**（P7）：只有在「确实要拿老版本逐字数据下结论」时才值得；否则考古 + `approximate` 标注够用。
6. **桶是哪一个**（Cloudflare R2 / S3 / B2 / 自建 MinIO）与 endpoint、region、path-style vs virtual-host？决定 `BUCKET_ENDPOINT` 的默认写法与 `s3-put.mjs` 的默认寻址样式（两种样式都会实现，只需定默认）。
7. **box 出网是否可达上游与桶**（P4b 第一步的探针）：`api.typesafe.ai` 需带 key 探一次；桶 endpoint 做一次 `HEAD`。**不可达则 G3 降级**为「经业主 Worker + `--allow-production`」，其余不变。
8. **直连上游的额度是否与 Worker 共用同一 key 的配额**：若共用，30 req/min 的自限速要按「Worker 生产流量 + 阶梯流量」的合计来设；跑前先探 5 次看 `429` 与 `Retry-After`。

---

## 10. 明确不做

- 不新增运行时依赖、不引 UI 框架（AGENTS.md 铁律 1/2）；**桶上传不引 `@aws-sdk/*`、不依赖 box 上装 `rclone`**（自实现 SigV4，D14）。
- 不在 box 上装常驻服务/开端口做进度面板（D13：进度走文件 + SSH）。
- 不改战术机制、不动接管链顺序、不加新层（机制线仍暂停；本计划只让**已有**版本可回溯、可测量）。
- 不引 Glicko/TrueSkill/分时段 Elo（ADR-0019 D8 的取舍保持）。
- 不把阶梯数据灌进生产 D1 的 `game_moves`。
- 不追求 rapfi 逐字复现（时间限制搜索的固有属性）。
- 不在本计划里做「模型侧提示」与「配对样本的正式 v15 机制」（那是机制线恢复之后的事）。

---

## 11. 建议的第一晚（如果只批一半）

只做 **P0 闸门 + P3 回放工具**（~1 天）：先把「静默换档」这条最贵的错误堵死，并拿到「任意历史棋谱 × 任意档位」的差异表——这张表本身就是「战术能不能回溯」的第一个可检验答案。语义冻结（P1/P2）与阶梯（P4–P6）随后按周推进。

**如果只批「远端离线跑」这一半（G3）**：则做 **P4b 前置三件**（~0.5 天，都不依赖 P1/P2）：① 出网探针（§9 第 7 条）+ 直连上游单局真跑对照（同 state 与 Worker 转发逐字同体）；② `progress.json`/`events.jsonl` + `status --watch`（SSH 看进度）；③ `s3-put.mjs` + `batch-bucket.mjs`（含已知向量单测）。做完当晚就能用**现有** `experiment-run.mjs`/`experiment-worker.mjs` 把任意 A/B 实验搬成「零 CF 触碰 + SSH 可查 + 桶留档」，不必等语义冻结。

**两半的依赖关系**：G1（可回溯）是 G2（可信阶梯）的**前提**——不然跑出来的 Elo 表只是「HEAD 上五个像老版本的档位」的相对强弱；G3 与两者**正交**，可以先行或并行（上一条）。
