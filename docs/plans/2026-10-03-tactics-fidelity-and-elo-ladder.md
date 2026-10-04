# 计划：战术「任意版本可回溯」语义冻结 + 远端 Elo 能力阶梯

> 类型：**实施计划**。状态：**🚧 实施中（2026-10-03 起草，同日按业主补充要求修订；业主 m13862「两个计划一起开工，可以先进行探测」⇒ 开工；P0 闸门收紧 ✅ / P0b 数据卫生与报表口径 ✅ / P1 冻结层 ✅ / P2 指纹设施 ✅ / P3 回放 + 考古 ✅ / P4 阶梯地基 ✅ / P4b 离线运行面 + 桶留档 ✅ / P5 Elo 升级 ✅ / P6 阶梯编排 ✅（含 box 端到端真跑、中断续跑与 `--force` 重跑）；**第一次真交付：`l3n1` 60 局 ✅ + `l2n1` 300 局 ✅（§7 的报表六项已实出，两份结果文档见 §7 末表）**；P7 起待做）**。
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
- 落地改动点：`src/core/jev/rapfi.ts:240` 现硬编码 `INFO timeout_turn <ms>`；节点数可从 `INFO show_detail 1` 的 `MESSAGE` 行**读**、也可用 `INFO max_node <n>` **设**（§2.1 探针 A 与 §9 第 2 条结案均已实测；**客户端目前两者都没用**）；core 的 `parseMoveLine` 只认 `^\d+,\d+$`，**不会把 `MESSAGE` 行误判成着法**。
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
| **D1** | **档位 = 冻结参数记录**：`VERSIONS[i]` 增 `budget`（15 个常量）、`sound: boolean`、`openingMin: number`、`promptFacts: 'mech'`、`fidelity: 'exact' \| 'restored' \| 'approximate'`。传 `tacticsVersion` 即完全决定行为，不再读 HEAD 写死常量 | 审计 §5 的直接结论：不这么做，「回溯」永远是「像当年」而不是「是当年」 |
| **D2** | **两条静默回退都改成显式失败**：`resolve()` 未知 id **抛错**（错误信息附最接近的合法 id）；`resolveVersion()` catch 回落 **`v0-off`（空机制集）**，绝不回落全开 | 审计风险 1/2。A/B 实验的单变量假设不能被无声破坏；「贴 v7 标签跑 v13」是最贵的一类错误 |
| **D3** | 预算经 **opts** 下传（`VcfOptions`/`VctOptions`/`VctDefenseOptions`/`Live3Options`/`PressureCutOptions`），引擎缺省值**保持不变**（= 今天的常量），只有显式给值才覆盖 | 零行为变更地拿到可冻结性；线上路径与今日逐字一致（**P1 已证**：15 档 × 120 真实局面逐字节 0 差异） |
| **D4** | `sound` 变**活键**：`computeTactics` 的 VCF 块按 `ver.sound` 传 `defenderWinsFull` 开关，v9 之前 = 关 | 审计风险 5；顺带把「v9 起才有 soundness 闸门」这个历史事实写进登记表。**P1 已证**：哨兵局面（守方堵点造四反杀）缺省不报胜、`sound:false` 报出 `F5→F6→E5`；档位级 v7 报 `F5`、v9 不报（`test/engines/tactics.test.mjs`） |
| **D5** | `attachFacts()` 按 `ver.mech` 生成事实句，**不再无条件全量追加** | 审计 §5 第 4 条：这是唯一「与机制门正交、任何开关都修不掉」的漂移源，也是老版本 prompt 复原的唯一途径。**P1 已证**：40 局面 × 15 档，v12–v14 文本 0 差异，越早的档少掉的句子越多（v0 每局丢 12 句 / v11 只丢 `vct_win_opponent`），且丢的句子与该档机制表严格对应 |
| **D6** | **冻结指纹**：从归档棋谱抽若干个局面（覆盖 15 档 × 早/中/晚），每档记录 `{ply, 层, 落点, facts 摘要}` 为 `test/parity/tactics-fingerprints.json`；`version-freeze.test.mjs` 断言一致，重写需显式 `--write` 且 commit 里说明理由 | 把审计 §3.3「改一处牵多档」从人工审视变成红灯；这是「没被悄悄改掉」的唯一机械证据。**P2 已做**：语料按实测成本从「N≈120」收缩为 **10 归档局面（早 4/中 4/晚 2）+ 4 具名夹具 = 14 局面 × 15 档 = 210 行**（早/中盘越稀疏越贵：120 局面 ≈ 9 分钟，进不了 CI；实测 24.0 s）；夹具专补归档走不到的 `win/open4/vcfAttack/vctAttack` ⇒ 覆盖 **13/14 层**，唯一走不到的 `threat` 是**结构性**的（见 §8 末行） |
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
| P1 | ✅ **已做（P0b，2026-10-03）** 三条历史 tag（`exp-20261003042812-rapfi1-r1` / `exp-20261003052056-smoke1-r1` / `exp-20261003052604-x1-r1`）回填 `device_id='ssh-batch'` | P0b（数据卫生） | 1 条 SQL + playbook 补一句 | 26 局 `device_id` 为 NULL 只能按 tag 认；回填后「哪些局是设施产物」一条 where 就能查（**只回填设备归属，不改 `code_version`**，不猜 sha）。实测：先补 `devices` 行（`games.device_id REFERENCES devices(device_id)`，否则 `SQLITE_CONSTRAINT_FOREIGNKEY`）→ `update … where device_id is null and experiment_tag in (…)` → `count(*) where device_id='ssh-batch'` = **26**，26 局的 `code_version` 仍是 `dev+nogit` |
| P1 | ✅ **已做（P0b，2026-10-03）** 报表加 **Wilson 95% 区间** + 「样本 < 50 局」标注 | P0b（`scripts/lib/batch-elo.mjs`） | 报表侧，不动核心逻辑 | 20 局/对的半宽 **±20 pt**（Wilson；教科书那条 Wald 写法给 ±22 pt 且 0 胜/全胜会越界）必须印在数字旁边，否则报告读起来像「已证明」 |
| P2 | ✅ **已做（P0b，2026-10-03）** 文档写死口径：**只准聚合口径**（胜/和/负 + 不败率 + 接管直方图 + 成本三口径）；单局逐手对齐只允许在**同机同进程**内做 | `docs/agents/playbooks.md` §7 第 12 条 | 一段话 | Node rapfi 与浏览器归档不可逐字复现（ADR-0019「后果」），跨机逐手比对本就是伪证据 |

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
| `src/core/tactics-budget.ts` | `EngineBudget` 接口（15 个上限字段）+ `DEFAULT_BUDGET`（= 今日常量，逐字冻结）+ `BUDGET_KEYS`（冻结顺序）+ `budgetOf()`（写错只会回落默认 ⇒ 只能少看见）+ `sameBudget()` | ~90 行 |
| `test/engines/fingerprint.mjs` | ✅ **已做**：语料抽取（归档抽样 `BUCKETS` 早 4/中 4/晚 2 + 具名夹具 `SYNTHETIC_POSITIONS` 4 个）+ `fingerprintOf()`（一趟链拿「事实 + 层 + 落点」）+ `--write`/`--check` + 覆盖表 | 304 行（实测） |
| `test/parity/tactics-fingerprints.json` | ✅ **已生成**：14 局面 × 15 档 = 210 行（15 档 × `TAKEOVER_ORDER` 14 层覆盖 13 层 + `digest` + 15 个事实点数） | 生成物 88.9 KB |
| `test/engines/version-freeze.test.mjs` | ✅ **已做**：5 例（形状/逐行重放/覆盖与必须覆盖层/与 `decide()` 同解/冻结字段完整），已进 `test/engines/runner.mjs:12-20` 的 `ALL_MODULES` | 117 行（实测） |
| `scripts/tactics-replay.mjs` | ✅ **已做**：离线重放 `--dir/--file/--game <uid>/--tag <tag>/--tactics <id>/--sides/--limit/--max-games/--json/--show`（纯核在 `scripts/lib/tactics-replay.mjs`；`--all` 由「不给 `--tactics`」表达）；26 例单测（2026-10-04 加 3 例：实验面归档的 `slug` 是对阵描述 ⇒ 棋种回退链） | 纯核 287 行 + CLI（实测） |
| `scripts/experiment-ladder.mjs` | ✅ **已做**：阶梯 CLI —— `--ladder L1\|L2\|L3\|all` / `--identities a,b,c`（二选一）、`--with-5000`、`--games`（必须偶数，`--allow-odd` 才放行）、`--openings`、`--store local\|d1`（缺省 local）、`--upstream direct\|worker`（缺省 direct）、`--rate-limit/--key-file/--origin/--allow-production`、`--cooldown`（缺省 30 s 轮间冷却）、`--max-rounds N`（**只编排前 N 轮**：当场打印「被截掉的轮次不在这次状态里，要跑全量就另起一次」——它不是「先跑 N 轮再接着跑」）、`--dry-run/--force`、`--no-upload/--prefix`；**串行**跑法（起一轮 → 等 pid → 拉该轮产物 → 桶 push → 冷却 → 下一轮），断点续跑判据 = **远端 `games.jsonl` 去重后的局数 ≥ 局数**（本地状态只记账），跳过时本地缺产物会补拉；`--force` 用新 tag 并把旧产物挪到 `stale-round-N-<旧tag>/`；`--parallel` 一律拒绝。**2026-10-04 修**：等待改**本地轮询**（`--poll <秒>`，缺省 60；`--quiet` 静音进度行）—— 原来是远端 `for i in $(seq 1 1440); … sleep 30; done` 一条 ssh 挂 12 h，**那条 ssh 继承 stdout 管道，编排进程一旦意外死掉，外层 `\| Tee-Object` 永远等不到 EOF，作业就假装还在跑**（第一晚 L3 round-1 实测踩到）；现在每分钟一次**捕获式**短 ssh（`timeout 60s`），并顺手把远端 `progress.json` 打成 `⏳ round-N d/total 局 · 秒 · 均 Xs/局 · W-D-L` | 672 行（实测；2026-10-04 加 `scp()` 与 `sshRetry()` 的三次重试 + `sh()` 的失败诊断 + 启动阶段的「准备中…」说明，见 L2 收尾与 vorder1 开局） |
| `scripts/lib/ladder.mjs` | ✅ **已做**（P6 纯核）：身份口径 `identityOfSpec()`（镜像归档导出：rapfi/mock 战术档留空）、`roundRobin()`/`crossPairs()`/`pairsForPreset()`（L2 是**笛卡尔积 15 对**，不是 8 身份的 28 对）、`pairsForAll()`、`parseIdentityList()`、`normalizeGames()`（奇数拒绝）、`buildLadder()`（显式 `now`、逐轮 plan 与 submit 同形状）、`formatRoundLine()`/`formatLadderTable()`/`estimateRoundSeconds()`（预计墙钟，锚点实测）、断点状态 `resumeDecisions()`/`summarizeLadder()`/`stateMatchesLadder()`/`withReusedTags()`/`staleCleanups()`/`staleDirName()`/`readLadderState()`/`writeLadderState()`/`writePlans()`；**2026-10-04 加** `parsePollOutput()`/`formatPollTick()`（本地轮询一次回值的解析与一行进度，见 `experiment-ladder.mjs` 行的悬挂说明）；**2026-10-04 加** `launchRoundCommand({repo,keyFile,planPath,logPath,pidPath})` —— 三处启动（阶梯 + batch `submit`/`resume`）共用的启动 shell，守卫在远端原子判断「pid 还活着就不重复起」；`pollRoundCommand({pidPath,progressPath})` —— 本地轮询共用的一次探针（`alive`/`done` + `progress.json` 原文） | 591 行 + **55 例**单测（实测；2026-10-04 加 `sleepSync()`/`retrySync()` 与 6 例、`launchRoundCommand()`/`pollRoundCommand()` 与 6 例、`--max-rounds` 截断提示 1 例、`L4` 高思考档预设 1 例；2026-10-05 加「dry-run 印的启动命令与真跑同一条」1 例） |
| `scripts/lib/report.mjs` | ✅ **已做**（2026-10-04，§7 报表口径的纯函数核）：`REPORT_VERSION`、`moveIdentity()`（走 `identityOf()` 唯一实现）、`isUpstreamMove()`（只有 `ai.ms` 是数字才算上游手）、`quantiles()`、`collectCost()`/`costRow()`（两种占比：`shareOfMove`、`shareOfRoundTrip`）、`pairTable()`（A 取字典序在前者）、`rafiCurve()`、`curveDeltas()`（相邻档 ΔElo + 两档 BT 区间是否重叠 —— L4 读曲线的判据）、`openingRows()`、`significance()`（区间重叠才算不可判）、`colorCells()`/`colorSplit()`（逐色格与分开颜色 —— L3 第一晚教训：先手优势 85%，只报总分会被带跑）、`screenVersions()`（把 §7 的「筛查判读规则」机械化：全序无环 + 共同对手同向 + 不换色翻面）、`reportMarkdown()`（六节 + 未收尾轮标注 + 逐色格两张表 + 版本筛查判读块 + 曲线 Δ 与重叠读数） | 714 行（实测） |
| `scripts/experiment-report.mjs` | ✅ **已做**（2026-10-04）：`--batch <id>` / `--dir <path[,path]>`（互斥）、`--out <md\|->`、`--json <path>`、`--anchor/--bootstrap/--seed/--no-bt/--quiet/--skip-incomplete`；读 `round-<i>/games.jsonl`（缺失才退回 `games/*.json`）+ `round-summary.json` + `events.jsonl`（开局分层）；缺 `round-summary.json` 的轮标注「仍在跑」（`--skip-incomplete` 才排除）；产物清单算 sha256 前 12 位；用法错一律 exit 2（缺目录的提示语带 `experiment-batch.mjs pull`） | 285 行（实测） |
| `test/scripts/report.spec.mjs` | ✅ **已做**（2026-10-04，23 例）：身份归属/上游手判定/`quantiles`/成本两占比/配对矩阵视角与同身份排除/Rapfi 曲线排序/**相邻档差与区间重叠**/开局分层/显著性/六节标题与兜底手与样本不足标注**未收尾的轮两种读法**/**逐色格与分开颜色**/CLI 五条用法错与正常落盘 | 344 行（实测） |
| `scripts/lib/openings.mjs` | ✅ **已做**：开局库生成（归档决胜局取前 `plies` 手、8 变换对称归一、去重计数、原子读写、`openingForNo()` 连续两局同一开局换色）；额外补了两件归档必需的：**决胜方口径 `winnerSideOf()`**（归档没有 `winner` 字段、只有中文 `result`）与**路径闸门放宽到「路径上任何一级目录叫 `games`」**（归档布局是 `games/<day>/*.json`） | 269 行 + 33 例单测（实测） |
| `scripts/lib/s3-put.mjs` | ✅ **已做**：纯 Node `crypto` 的 AWS SigV4 签名 + `putObject`/`getObject`/`listPrefix`（零依赖，S3 兼容：R2/S3/B2/MinIO）；**用 AWS 官方三个已知向量逐字节钉死**（GET Object 签名 `f0e8bdb8…`、PUT Object 签名 `98ad7217…`、RFC 4231 HMAC 用例 1） | 288 行 + 17 例单测（实测） |
| `scripts/lib/throttle.mjs` | ✅ **已做**：自限速（滑窗发车，缺省 30 req/min）+ 连续 429 熔断（缺省 5 次）+ `installFetchThrottle()` 裹全局 fetch（只给上游主机领令牌）；时间与 `sleep` 可注入 ⇒ 单测不真等 | 148 行 + 10 例单测（实测） |
| `scripts/lib/upstream.mjs` | ✅ **已做**：运行面闸门（direct 不许 proxy 臂 / worker 与 d1 必须显式 `--origin`）+ key 解析（env 优先、`/root/.jev-key` 兜底、`parseKeyFile()` 认五种写法） | 89 行 + 14 例单测（实测） |
| `scripts/batch-bucket.mjs` | ✅ **已做**：`push <dir> --prefix ladders/<batchId>/` / `pull` / `ls`；产物白名单（`games.jsonl`/`elo.json`/`report.md`/`round-<i>/*`），凭据只读环境变量，缺失明确报「未配置桶」并 **exit 3**（不静默跳过）；上传失败**只告警不阻断**（`--strict` 才升 exit 1） | 211 行 + 10 例单测（实测） |
| `docs/adr/0021-standalone-experiment-plane.md` | ✅ **已写**：实验面默认直连上游 + 本地 JSONL + 文件进度 + 对象桶留档，为什么用现成 `official` 渠道而不是新造 `direct` 渠道、为什么进度用文件不用常驻服务、为什么 SigV4 自己实现 | P4b 产出 |
| `scripts/lib/progress.mjs` | ✅ **已做**：`progress.json` 原子读写 + `events.jsonl` 追加 + `eta()` 估算（只用已完赛局、最近 5 局均值，样本不足给 `null` 而不编数字）；`done` 含 `skipped`，但 `skipped` 且无 winner **不计入 W/D/L**（「没跑 ≠ 和棋」，见单测） | 153 行 + 22 例单测（实测） |
| `test/scripts/{s3-put,progress}.spec.mjs` | 两个 ✅ **已做**：`progress.spec.mjs`（22 例：原子性与 ETA 单调、`outcomeForA` 五态、坏文件/坏目录不抛）；`s3-put.spec.mjs`（17 例：SigV4 **已知向量**固定时间戳/密钥 ⇒ 固定签名串、编码与规范化、端点与寻址、三个动作注入 fetch 不联网）。另新增 `throttle.spec.mjs`（10 例）/`upstream.spec.mjs`（14 例）/`batch-bucket.spec.mjs`（10 例） | progress 211 行 + s3-put 255 行（实测） |
| `scripts/lib/batch-elo.mjs`（扩写） | ✅ **已做**：`aggregateBt()` / `fitBt()`（MM 迭代 + `ridge` 先验 + 显式零点）/ `computeBt()` / `bootstrapBt()`（按局重采样，2.5–97.5% 分位）/ `percentile()` / `mulberry32()`；`rankTable(records, K, { bt })` 只在开启 BT 时加 `btDelta/btLo/btHi/btWidth/btDraws`（不开时行形状逐字不变）；`formatRankTable()` 加 `BT Δ` 与 `95% 区间(BT Δ)` 两列 + 脚注 | 448 行（原 238，+210 实测） |
| `test/scripts/{openings,ladder-plan,bt-elo}.spec.mjs` | 合成数据验证：已知强弱顺序、CI 宽度随 n 收窄、开局库对称归一。✅ `batch-elo-bt.spec.mjs` **已做**（17 例 / 0.9 s）：两身份干净情形对齐理论 SE（经验 SD ≈ 理论 SE ±20%、平均区间宽 ≈ 2×1.96×SE、覆盖率 ≥ 90%）、三身份阶梯 200 局无偏且平均绝对误差 < 45 Elo、误差随 n 下降、`rapfi\|\|500` 锚 = 0、同 seed 逐字可复现、`bootstrap: 0` 退化、老报表形状不变；✅ `ladder.spec.mjs` **已做**（**46 例**，2026-10-04 加 12 例：本地轮询解析四态 + 一行进度三态与本机墙钟优先 + `--poll`/`--cooldown` 闸门 + `sleepSync()`/`retrySync()` 六例）：身份/对数/偶数闸门/计划字段/断点矩阵/ETA/预计墙钟 + CLI 四道闸门与 W/D/L 口径（含 uid 去重、tag 沿用、旧产物挪开） | 220 行 + 475 行（实测） |
| `docs/adr/0020-tactics-fidelity-freeze.md` | ✅ **已写**：决策「档位 = 冻结记录 + 指纹」、未知档号显式失败、接管链抽纯函数、只记决策不记耗时、覆盖表是断言的一部分、`threat` 不可达作为显式缺口 | 实测口径 |
| `docs/plans/2026-10-04-tactics-archaeology.md` | ✅ **已写**（267 行）：考古结果表（逐档：budget/sound/openingMin/prompt + 证据 commit + 置信度）、`promptFacts` 专项结论、共享常量时间线、缺口、P7 复现清单、`threat` 可达性复核、P3 回放验收 | P3 产出 |

**改动**

| 文件 | 改动 |
|---|---|
| `src/core/tactics-versions.ts` | ✅ 已完成：记录增 `budget`/`sound`/`openingMin`/`promptFacts`/`fidelity`（统一缺省常量 `FROZEN`，逐档只写偏离项）；`resolve()` 抛错 + `tryResolve()` 给展示面（P0）；`selfTest()` 增断言（15 个预算字段齐全且为正、`sound === (rank >= 9)` 的历史事实、`fidelity` 合法、单调继承不变） |
| `src/core/tactics.ts` | ✅ 已完成：`resolveVersion()` 返回 `{id, mech, budget, sound, openingMin, promptFacts}` 并下传；`mechOf()` 给注入面同一解析路径；`attachFacts()` 增 `opts.mech` 逐句过滤（句面逐字不变） |
| `src/core/engines/gomoku.ts` | ✅ 已完成：`vcfWin`（`sound`/`nodeLimit`/`movesMax`）、`live3Deny`（`evalMax`）、`vctDefense`（`keep`/`vcfPlies`/`pressureLimit`）、`pressureCut`（`keep`）接受 opts，缺省 = 今日常量 |
| `src/core/types.ts` | ✅ 已完成：新增 `VcfOptions`；`Live3Options`/`VctDefenseOptions`/`PressureCutOptions` 补齐字段，注释写清「缺省 = 历史常量」 |
| `src/core/jev/client.ts` | ✅ 已完成：`attachFacts(ser, tactics, experience, { mech: mechOf(opts.tacticsVersion) })` —— 与 `computeTactics` 同一解析路径；**P2 已做**：内嵌的接管链（原 `:374-527`）抽成 `takeover.ts` 的纯函数 `pickTakeover()`，本文件 565 → 431 行，决策面 450 行 0 差异 |
| `src/core/takeover.ts` | ✅ **已做（P2）**：`TAKEOVER_ORDER`（14 层权威顺序）+ `TAKEOVER_LABEL`（中文层名）+ `pickTakeover({engine, st, tactics, mech, criteria, legal, pairs, cands, topK, onTime})` → `{notation, layer, bypassed}`；锁层逻辑逐字搬运（`pickAmong`/`pickSafestParry`/三个 criteria 点集/十四条 `if-else if`），耗时经 `onTime` 回调记账 | 226 行（实测） |
| `scripts/experiment-worker.mjs` | ✅ **P4 + P4b 已做**：`--openings <file>`、`--store local\|d1`（缺省 **local** ⇒ 默认不写生产 D1；老调用方在 plan 里显式写 `store:'d1'` 保持原行为）、`--device-id <id>`、每局写 `progress.json`/`events.jsonl`、`games.jsonl` 追加（`--store local` 的唯一产物）；**P4b**：`--upstream direct\|worker`（默认 direct）、`--key-file <path>`（默认 `/root/.jev-key`）、`--rate-limit <n>/min`（默认 30）、`--origin` 显式逃生门、自限速裹全局 fetch、连续 5 次 429 熔断、轮末记 `summary.throttle` |
| `scripts/experiment-batch.mjs` | `--store d1\|local` ✅ **已做**（`submit` 缺省 d1 并写进 plan）；**P4b 已做**：`--upstream direct\|worker`（缺省 direct）+ `--rate-limit` + `--key-file` 写进 plan、`status --watch`（经 SSH 读 `progress.json`，纯 shell 循环，D13）；**P5 已做**：`elo` 子命令加 `--anchor/--bootstrap/--seed/--no-bt` + BT 汇总行与区间宽度行 + `--json` 里的 `bt` 块；**P6 已做**（形式改了）：阶梯**没有**做成这里的 `ladder` 子命令，而是独立 CLI `scripts/experiment-ladder.mjs` —— 阶梯要自己管「逐轮串行 + 等待 + 拉产物 + 续跑状态」，塞进 submit 会让它同时是「单批次提交器」和「多轮编排器」；**仍未做**：每轮结束自动调 `batch-bucket.mjs push`（阶梯 CLI 已接线，`submit` 那条仍等桶地址确定）。已在 §3.1 完成的：`--allow-production` 闸门（第 1 条）、`--parallel` 仅双本地臂（第 2 条）；**2026-10-04 加**：串行等待改**本地轮询**（`waitRoundLocally()`，每分钟一次捕获式短 ssh + `parsePollOutput`）—— 原来那条远端 `for i in $(seq 1 1440); … sleep 30; done` 长命 ssh 继承 stdout 管道，编排意外死掉会让外层永远等不到 EOF（与阶梯同一个悬挂）；启动走 §5 的 `launchRoundCommand()`（pid 守卫） | 488 行（实测）
| `test/engines/tactics.test.mjs` | 两处「固化为静默回落」的用例改为断言**抛错**；登记表字段断言补全 |
| `docs/{README.md,status.md,agents/playbooks.md,memory/MEMORY.md}` + `README.md` + `CHANGELOG.md` | 索引、口径、教训、数字随阶段回填 |

---

## 6. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 闸门收紧** ✅ **已完成（2026-10-03）**（~120 行） | D2：`resolve()` 抛错 + `resolveVersion` 回落 `v0-off` + 三个入口（脚本 / UI 下拉 / 远端批量 `parseSpec`）白名单校验，错误信息含最接近合法 id；**并入 §3.1 第 1、2 条**：`--allow-production` 闸门 + `--parallel` 仅双本地臂 | 实测全过：① `node test/engines/run.mjs` **144/144**；② `npx vitest run` **38 文件 / 399 例**（+14：两道闸门 7 例 + Wilson 5 例 + UI 拒绝启动 2 例）；③ `--tacA v12-vct-de` ⇒ 打印「最接近的合法档位：v12-vct-def」+ 15 档全列表、**exit 2**；④ `submit` 不给 `--origin` ⇒ exit 2 并提示 `--allow-production`；⑤ `--parallel` + 含 `proxy` 臂 ⇒ 点名 `A=proxy` 拒绝；⑥ UI 下拉值都在白名单时照常开跑（`test/app/experiment-start.spec.ts` 正对照）。**「边界严格、展示宽容」**：`resolve()` 只在白名单来源处调用，展示/陈旧存档走 `tryResolve()`（`src/core/view/duel.ts` `versionTag`、`src/app/records.ts` 归档分组头、`src/core/persist.ts` `loadSettings()` 就地净化） |
| **P0b 数据卫生与报表口径** ✅ **已完成（2026-10-03）**（~40 行 + 3 条 SQL + 文档） | §3.1 第 3–5 条 | 实测全过：① 三条历史 tag 回填前先补 `devices` 行（`games.device_id REFERENCES devices(device_id)`）⇒ `update … where device_id is null and experiment_tag in (…)` ⇒ `select count(*) from games where device_id='ssh-batch'` = **26**，26 局 `code_version` 仍为 `dev+nogit`（未猜 sha）；② `wilson()` 落 `scripts/lib/batch-elo.mjs`，20 局/对半宽 **±20.1 pt**，`formatRankTable()` 每行印 `95% 区间(Wilson)` 列 + 样本 < 50 时印 `±XX.Xpt ⚠` 与读数纪律注（用例把 ±20 pt 钉死）；③ `docs/agents/playbooks.md` §7 新增第 12 条「报表只准聚合口径」+ 第 11 条补齐回填 SQL；④ `npm run check:docs` 绿 |
| **P1 冻结层** ✅ **已完成（2026-10-03）**（~250 行） | D1/D3/D4/D5：`tactics-budget.ts` + 预算下传 + `sound` 活键 + `openingMin` + `attachFacts` 按 mech | 实测全过：① **零行为变更对照** `.work/p1-fidelity-check.mjs` + `.work/p1-fidelity-diff.mjs`，基线取自干净 HEAD `446f976`、改后同脚本复跑：**15 档 × 120 真实归档局面 = 1800 行，`tac` 与 `ins` 全部 0 差异**（比预告更强 —— v7/v8 的 soundness 差异面在这 120 个局面里没有触发；该口径的 `ins` 是不带 `mech` 的旧调用，只证明「句面逐字未改」）；② **过滤效果** `.work/p1-mech-filter-probe.mjs`（40 局面）：v12/v13/v14 文本 **0 差异**，v11 少 9600 字符、v10 19360、v7–v9 37560、v3–v6 51280、v1/v2 67520、v0 79200，丢掉的句子与该档机制表严格对应（v11 只丢 `vct_win_opponent`、v0 12 句全丢）；③ **sound 正对照**（`test/engines/tactics.test.mjs`）：哨兵局面缺省不报胜、`sound:false` 报出 `F5→F6→E5`，档位级 v7 报 `F5` / v9 不报，`nodeLimit:1` 搜不出 ⇒ 预算与闸门真下到引擎；④ `node test/engines/run.mjs` **148/148**（原 144，+4 例 P1）；⑤ `npx vitest run` **38 文件 / 399 例**；⑥ `npx tsc --noEmit` 干净 |
| **P2 指纹设施** ✅ **已完成（2026-10-03）**（实测：`takeover.ts` 226 行 + `fingerprint.mjs` 304 行 + `version-freeze.test.mjs` 117 行 + 指纹产物 88.9 KB） | D6/D7 + `version-freeze.test.mjs` + CI 接线；**外加一步计划外但必需的抽取**：把内嵌在 `client.ts` 的接管链抽成 `src/core/takeover.ts` 的纯函数（否则指纹要跑两遍链、P3 回放也无处落脚） | 实测全过：① **抽取零行为变更**：`.work/p2-ab-baseline.mjs` 抽取前后各 dump 30 局面 × 15 档 = 450 行，**差异 0 行**；② 首次 `--write` 基线 = **14 局面 × 15 档 = 210 行，24.0 s**（语料从计划的 N≈120 收缩：实测 120 局面 ≈ 9 分钟，进不了 CI）；③ **层覆盖 13/14**，唯一缺口 `threat` 是结构性的（§7 第 9 条），断言写成「除 `threat` 外每层都必须被走到」+「`coverage.missing` 必须恰好等于 `['threat']`」；④ **故意改一处预算试红**：`DEFAULT_BUDGET.vcfNodeLimit` 4000 → 1 ⇒ `⑭b` 报 **决策指纹漂移 32 处**（v7…v14 的层从 `vcfDefense` 变 `parry`/`vctDefense`），还原后立刻全绿 —— 「改一处牵多档」从此是红灯；⑤ `node test/engines/run.mjs` **153/153**（+5 例）；⑥ `npx vitest run` **38 文件 / 399 例**；⑦ `npx tsc --noEmit` 干净；⑧ `npm run check:docs` **58 md / 397 链接**；⑨ `⑭d` 另证指纹与 `decide()` 全链路同解（语料里一个 mid 局面 × 15 档逐档对照层与落点） |
| **P3 回放 + 考古** ✅ **已完成（2026-10-04）**（实测：`scripts/lib/tactics-replay.mjs` 265 行纯核 + `scripts/tactics-replay.mjs` CLI + `test/scripts/tactics-replay.spec.mjs` 23 例 + 考古文档 267 行） | `tactics-replay.mjs`；逐 commit diff 填 `budget/sound/openingMin`/`fidelity`；产出考古文档 `docs/plans/2026-10-04-tactics-archaeology.md` | 实测全过：① **回放验收**（`exp-20261003082805`，v14 vs `rapfi@5000ms`，20 局 / 990 手 / 重放 496 手 / 282.2 s）：**层一致率 496/496 = 100%**、**接管落点一致率 327/378 = 86.5%**、**会变 51 手且全是同层换点**（口径：归档无整张概率表 ⇒ 重放走「无模型」等权口径，故层一致是强结论、落点一致是下界；逐层实测 `live3Attack` 21 · `live3Defense` 11 · `parry4` 7 · `open4` 3 · `vctDefense` 3 · `parry3` 3 · `pressureGate` 2 · `block` 1，零跨层）；② **考古 14/14 档参数层确证**（15 个预算键逐键 + `sound` + `openingMin=4` + 注入句集/句面/句序全部有 sha 证据，且逐键等于 P1 冻结值）⇒ v1–v13 `fidelity` 升 `'restored'`、v0 留 `'approximate'`、v14 保持 `'exact'`；③ 顺带**否证**前序审计两条（v11 上线预算即 10/3000/6、prompt 漂移在 P1 后已修）并修正「冻结于 446f976」（`tactics-budget.ts` 仅由 `0b3a400` 创建）；④ `threat` 层标注「历史层，当前机制表下不可达」（考古文档 §6.1）；⑤ `node test/engines/run.mjs` **153/153**、`npx vitest run` **39 文件 / 422 例**、`npx tsc --noEmit` 干净、`npm run check:docs` **59 md / 407 链接**、`node test/engines/fingerprint.mjs --check` 一致（210 行） |
| **P4 阶梯地基** ✅ **已完成（2026-10-04）**（实测：`scripts/lib/openings.mjs` 269 行 + `scripts/lib/progress.mjs` 153 行 + 55 例新单测 + worker 接线） | `openings.mjs` + worker `--openings`/`--store local` + **D13 进度文件**（`progress.json` + `events.jsonl` + `--store local` 时零网络写） | 实测全过（证据脚本 `.work/p4-build-openings.mjs` / `.work/p4-verify.mjs`，全部可复算）：① **开局库可复现**：归档 54 局 → `buildLibrary(records,{plies:6,limit:4})` 得 `source={games:54,used:45,dropped:9}`（9 局和棋按 `decisiveOnly` 丢）+ 4 本开局（`H8 E5 I8 B2 J8 G8` 13× · `H8 H7 G7 F6 G6 G5` 9× · `H8 H7 E11 H6 B14 H9` 7× · `A1 B2 B1 C1 D1 D2` 3×）；单测另钉「同输入 ⇒ 逐字节同输出」；② **一局真跑（rapfi 自对弈 `rapfi@500`，`--store local`）**：`exp-20261004-p4smoke-r1` 2 局（同一开局换色双跑），**两局前 6 手逐手等于开局库** `H8 E5 I8 B2 J8 G8`，第 7 手起才有 `ai` 块且 `ch=rapfi`（脚本落子的识别口径：`aiMoveMeta()` 对非 AI 手返回 null ⇒ 导出无 `ai` 键）；③ **JSONL 能被 `loadRecords` 读回**：`games.jsonl` 2 行 ⇒ 读回 2 局、身份 `rapfi||500` 对 `rapfi||500`（战术档不让 rapfi 臂沾上）、单局 JSON 与 JSONL 同局只算一次；④ **跑动中可读**：`exp-20261004-p4watch2-r1` 在第 1 局完、第 2 局未起时读到 `{total:2,done:1,gameNo:1,ply:50,wdl:{w:0,d:0,l:1},elapsedS:12,etaS:12}`（`ssh cat` 同形）；⑤ **零网络写**：`store=local` 轮次只落 `games/*.json` + `games.jsonl` + `progress.json` + `events.jsonl` + `round-summary.json`，日志打「store=local：未触碰业主 Worker」，实验行留在 `round-summary.json` 的 `experimentEntry`；⑥ `npx vitest run --project scripts` **6 文件 / 136 例**、全量 `npx vitest run` **41 文件 / 478 例**、`node test/engines/run.mjs` **153/153**、`npx tsc --noEmit` 干净、`npm run check:docs` **59 md / 411 链接**、`node test/engines/fingerprint.mjs --check` 一致（210 行） |
| **P4b 离线运行面 + 桶留档** ✅ **已完成（2026-10-04）**（实测：`scripts/lib/s3-put.mjs` 288 行 + `scripts/lib/throttle.mjs` 148 行 + `scripts/lib/upstream.mjs` 89 行 + `scripts/batch-bucket.mjs` 211 行 + 51 例新单测 + worker/batch 接线 + ADR-0021） | **D12**：worker `--upstream direct`（读 `/root/.jev-key`）+ `--rate-limit`（默认 30/min）+ 429 熔断；`experiment-batch.mjs status --watch` 经 SSH 出表格；**D14**：`s3-put.mjs` + `batch-bucket.mjs`，每轮结束上传 `ladders/<batchId>/` | 实测：① **四道闸门真跑全过（exit 2 + 精确文案）**：direct 面出现 `proxy` 臂 ⇒ 提示改写成 `official`（同一上游同一 Bearer）；`--upstream worker` 无 `--origin` ⇒ 拒绝；`--store d1` 无 `--origin` ⇒ 拒绝；缺 key ⇒ 打 `KEY_HELP` 并拒绝（该路径第一次跑是 `KEY_CHANNELS.has is not a function` 的 exit 1，已修 `includes`）；② **SigV4 已知向量单测通过**：AWS 官方 GET/PUT 两条签名（`f0e8bdb8…` / `98ad7217…`）逐字节相等 + RFC 4231 HMAC 用例 1；③ **rapfi 真跑（`--store local --upstream direct`）**：2 局 27 s，两局前 6 手 = 开局库 `H8 E5 I8 B2 J8 G8`，`progress.json` 跑动中可读（`{total:2,done:2,wdl:{w:1,d:1,l:0},etaS:0,meanGameS:14}`），`events.jsonl` 6 行（`round-start` 带 `upstream:'direct'`），`games.jsonl` 能被 `loadRecords` 读回并按 `gameUid` 去重，日志打「store=local：未触碰业主 Worker」；④ **断桶不阻断**：错凭据下 `pushArtifacts` 逐项告警、其余文件照传、`main` 缺凭据 exit 3（`--strict` 才升 1），单测钉死；⑤ **box 出网探针（D12 第一步）通过**：`/root/.jev-key`（`-rw-------` 121 B）+ `Authorization: Bearer` POST `https://api.typesafe.ai/v1/systemone` ⇒ **HTTP 422**（`questions` 空，鉴权已过）0.315 s；box `node -v` v24.9.0；**本机 Node 无外网**（代理 `127.0.0.1:10808` 未运行 ⇒ `ECONNREFUSED`）⇒ 真打上游的**整局**直连验收落在 box 上（做法与结果见 §9 第 7 条）；⑥ 全量验收：`node test/engines/run.mjs` **153/153**、`npx vitest run` **45 文件 / 529 例**、`npx tsc --noEmit` 干净、`npm run check:docs` **60 md / 421 链接**、`node test/engines/fingerprint.mjs --check` 一致（210 行）；⑦ 顺带查清一条口径：未终局记录（`maxPlies` 截断）在 `progress.json` 里记和棋、但在 `batch-elo.mjs` `gameRecord()` 被丢弃（「未终局不计入 Elo」），只有 `maxPlies < 225` 时两者才不一致；⑧ **box 整局直连验收通过**（`15ddfa8` 上跑，日志 `/root/ladder/p4b-box.log`）：`official:v14-live3-fresh:0` vs `rapfi:v14-live3-fresh:1000` 共 2 局 118 s —— `game-1 ok 27 手 winner=black 26s`、`game-2 ok 80 手 winner=和棋 89s`（80 手是 `maxPlies` 截断），`限速轮末：已发 54 次、累计等待 17.6s｜连续 429 0｜上游请求 54 次`、`fetch:{gated:54,passed:0}`、`key 来源：official←file:/root/.jev-key`、日志打「store=local：未触碰业主 Worker」；**零 CF 触碰的硬证据**：跑前后 `select count(*) from games/game_moves/experiments` 都是 **312 / 19298 / 28**（不变）；产物取回后 `experiment-batch.mjs elo` 复算正确（身份 `official\|v14-live3-fresh\|0` 1508 vs `rapfi\|\|1000` 1492，80 手那局按「未终局不计入 Elo」被丢弃 ⇒ 样本 1 局）；⑨ 顺带补一条守卫：手写 plan 缺 `tag` 原先会静默跑出没有标签的实验行（`progress.tag` 落成 `""`）⇒ `scripts/experiment-worker.mjs` 现在开局前 exit 2 要求补 `tag` |
| **P5 Elo 升级** ✅ **已完成（2026-10-04）**（实测：`scripts/lib/batch-elo.mjs` 238 → **448 行**、`test/scripts/batch-elo-bt.spec.mjs` **220 行 / 17 例 / 0.9 s**、`experiment-batch.mjs elo` 加 `--anchor/--bootstrap/--seed/--no-bt`） | D10：`aggregateBt()` + `fitBt()`（MM 迭代、`ridge` 先验 0.5、显式零点）+ `computeBt()` + `bootstrapBt()`（按局重采样）+ 排行表 `BT Δ` 与 `95% 区间(BT Δ)` 两列，Wilson 列保留（§3.1 第 4 条） | 实测（判据**已按实测订正**）：① **估计量与区间的正确性**（两身份干净情形对照理论，`.work/p5-boot-diag.mjs`：60 种子 / bootstrap 300 / 真差 100）：n=50 理论 SE **51.2** vs 经验 SD **52.6**、平均区间宽 208、覆盖 57/60；n=200：**25.6 / 25.8**、100、56/60；n=800：**12.8 / 12.7**、49、55/60 ⇒ 经验 SD 与理论 SE 差 ≤2%、覆盖率 92–95%，**实现被独立验证**；② **阶梯形状**（三身份轮转、40 种子、`.work/p5-stats.mjs`）：200 局（每对约 67 局）真差 100/200 时偏差 **+4.4 / +1.7**、SD 32.2/43.8、**平均绝对误差 27.9 / 35.6**、区间宽 144/151、覆盖 39/40；n=400 ⇒ 21.2/25.4；n=800 ⇒ **20.6 / 17.3** ⇒ 误差随 n 下降；③ **计划原判据「200 局点估计误差 < 25 Elo」过于乐观，已改成三条可复算的**：\|偏差\| < 10 + 200 局平均绝对误差 < 45（实测约 32）+ 误差随 n 单调下降；④ `rapfi\|\|500` = 0 锚成立（数据里没有它时退化成均值居中并记 `anchor: null`，报表印「均值居中（无锚点：…）」）；⑤ 同 seed 逐字可复现、`--bootstrap 0` 只算点估计、`--no-bt` 与旧报表逐字一致；⑥ CI 宽度随 n 单调收窄（100 → 800 局对比由单测钉死）。**单局样本的区间会退化**（`[139.8–139.8]`、宽度 0：每次重采样都是同一局），读数时要看 `局数` 列。⑦ 全量验收：`npx tsc --noEmit` 干净、`node test/engines/run.mjs` **153/153**、`npx vitest run` **46 文件 / 546 例**、`npm run check:docs` **60 md / 421 链接**、`node test/engines/fingerprint.mjs --check` 一致（210 行） |
| **P6 阶梯编排** ✅ **已完成（2026-10-04）**（实测：`scripts/lib/ladder.mjs` 468 行 + `scripts/experiment-ladder.mjs` 556 行 + `test/scripts/ladder.spec.mjs` 400 行 / 38 例；阶梯改为**独立 CLI** 而不是 `experiment-batch.mjs` 的子命令，理由见 §5 表） | D11/D12：round-robin + 颜色对称 + 串行调度 + 断点续跑 + 一行汇总 + 桶上传钩子 | 实测：① **dry-run 计划表逐项对齐**（`--games 2`）：`L1` 10 轮 / 20 局、`L2` 15 轮 / 30 局、`all --with-5000` 29 轮 / 58 局、`--identities 'rapfi::500,rapfi::1000'` 1 轮 / 2 局；表格逐行印 `# / 对阵 / 局数 / 开局 / ≈预计`，并印运行面（直连上游零 CF）、存储（`store=local` 只落远端 JSONL）、对称性（偶数局 ⇒ 同开局换色）、远端拓扑与每轮的 `scp`/`ssh` 命令预览；② **四道闸门真跑全过（exit 2 + 精确文案）**：`--ladder L9` ⇒ `未知阶梯预设 "L9"，合法值：L1, L2, L3（或 all）`；`--games 3` ⇒ `必须是偶数`（`--allow-odd` 才放行）；`--store d1` 无 `--origin` ⇒ `未给 --origin：这会写生产 D1（https://jevqipan.logicc.top）…`（**缺省 `--store local --upstream direct` 的零 CF 跑动不被这条闸门拦** —— 这是本阶段修掉的一处误拦）；`--upstream worker` 无 `--origin` ⇒ 拒绝；`--parallel` ⇒ `阶梯不并行…`；`experiment-batch.mjs submit --parallel --a proxy:… --b proxy:…` ⇒ `--parallel 只允许双本地臂（两侧都不是 official/openrouter/proxy）：当前 A=proxy B=proxy…`；③ **断点续跑判据 = 远端 `games.jsonl` 去重后的局数 ≥ 本轮局数**（**远端产物是权威，本地状态只记账**：状态文件丢了/形状换了都不重跑已完成的轮；行数不足 ⇒ 重跑；行数未知（ssh 不通）⇒ 不跳过；跳过时本地缺产物会自动补拉一次）。配套三条：**同一局按 `gameUid` 去重**（重复记录自报 `⚠ 本轮 games.jsonl 有 N 条重复记录`，判据也按去重后的数）、**续跑沿用旧 tag**（`withReusedTags()`：本地状态 tag → 远端 plan tag → 新 tag；worker 的 checkpoint 按 tag 命中，换 tag 会把整轮重放——实测 `p6kil` 因此留下 7 行）、**`--force` 先把旧产物挪到 `stale-round-N-<旧tag>/`**（`staleCleanups()`/`staleDirName()`；不以 `round-` 开头，免得被行数扫描的 `round-*` 通配扫到），且状态里的 `tag` 要跟着本轮实际用的走；④ W/D/L 按**记录身份**判 A 执哪边（两臂同身份时才退回「奇数局 A 执黑」的位置推断 —— 某一局缺行会让位置推断错位）；⑤ 预计墙钟锚点实测（每局 60 手、上游臂 1.1 s/手、rapfi `think/2`）：L3 60 局 ≈1.2 h、L2 300 局 ≈7 h、L1 200 局 ≈11 h（模型是排序用的粗估，不写进报表）；⑥ 全量验收：`npx tsc --noEmit` 干净、`node test/engines/run.mjs` **153/153**、`npx vitest run` **47 文件 / 584 例**、`npm run check:docs` **60 md / 421 链接**、`node test/engines/fingerprint.mjs --check` 一致（210 行）；⑦ **box 端到端真跑**（`root@185.242.234.48:/root/board-games`，`--store local --upstream direct`，零 CF 触碰）：`p6val` 三轮（rapfi 500/1000/2000 × 2 局）—— round-1 `W0-D0-L2 65s`、round-2 `W1-D0-L1 95s`、round-3 远端其实跑完（`round-summary.json` 齐全）但一次 `scp` 拉产物失败被记 failed；修完后重跑：`续跑判定：3 轮跳过 / 0 轮要跑（{"1":2,"2":2,"3":2}）` + `⏳ round-3 跳过但本地缺产物，补拉一次…` ⇒ `阶梯 p6val 结束：3/3 轮正常｜6/6 局｜W2-D0-L4`；⑧ **中断续跑（`p6kil2`）**：一轮跑完 1 局时在远端 `kill`，同命令重跑 ⇒ 日志 `（1 轮沿用已有 tag…）` + worker `game-1 已完成（ok），跳过` + games 2–4（23s/23s/59s）⇒ 最终 `games.jsonl` **4 行**（不是 7 行）、`unique 4`、无 dupes、`[1] ✅ 4 局 W2-D0-L2 154s`；⑨ **`--force` 重跑**：`⚠ round-1 旧产物挪到 stale-round-1-exp-20261004030619-p6kil2-r1/（tag 变了：… ⇒ 本轮从头重下）`，新 tag `exp-20261004031957-p6kil2-r1`、`round-1/games.jsonl` 4 行、本地状态 tag 同步成新 tag；⑩ 桶钩子在第 ⑦⑧⑨ 三次真跑里都走「缺凭据只告警」路径（`⚠ 桶凭据缺失，跳过上传`）且 CLI 仍 exit 0。⑪ **最大规模真跑 = L2 的 15 轮 / 300 局**（2026-10-04，`l2n1`）：`--ladder L2 --games 20 --poll 60`，15/15 轮正常、300/300 局、W234-D17-L49、墙钟 316.7 分钟、7440 个上游手全部 `primary`（切换 0 次）、零 429；中途 round-15 的 `scp -r` 栽了一次、续跑又两次死在「上传 plan」（见下面的注）⇒ 修完 `retrySync` 后同一次续跑里 round-12/13 各失败一次第二次即成功，并把 round-15 本地缺的产物补拉回来。**注**：scp 的瞬时失败在 P6 时**未定性**——`.work/p6-scp-probe.mjs` 实测反斜杠绝对 / 正斜杠绝对 / 仓库根相对三种写法**都成功**（各 ~18 s），故「盘符冒号」假设被否证；保留 `localScpPath()`（消除歧义面）；L2 收尾又拿到两条新证据（手工跑同一命令行必成、轮询里见过 `ssh … port 22: Connection timed out`）⇒ 定性为**链路间歇性抖动**，处置从「一次重试」升级为 **`scp`/`ssh` 一律三次重试（`retrySync`，2 s 间隔）+ `sh()` 打印 exit/signal/code**；单测 6 例。CI：`15ba04d` 的 run **`37170326312` success**（2m1s） |
| **P7 逃生门（可延后）**（~150 行） | `--rev <sha>`：box 上 `git worktree add` 老 commit + 特征适配驱动（老导出可能缺 `tacticsLabel`/`thinkMsOf` 等新符号） | 在某个考古 `approximate` 档上，`--rev` 版的落点与考古预算版的差异被量化；结论写回考古文档 |

**全阶段完成后的一轮真实验（G2 交付）**见 §7。

---

## 7. 阶梯实验设计（G2）

**身份（identity）** 建议集合：`official|v10-live3|0`、`official|v11-vct|0`、`official|v12-vct-def|0`、`official|v13-pressure-gate|0`、`official|v14-live3-fresh|0`、`rapfi||500`、`rapfi||1000`、`rapfi||2000`（8 个身份；`rapfi||5000` 视预算追加）。

⚠️ **上游臂（`official`）在本计划里是「直连上游」**（D12：box 直接打 `https://api.typesafe.ai/v1/systemone`），**不是**业主 Worker 的 `/api/jev` 转发。两者协议同构（同端点、同 `Authorization: Bearer`、请求体同样只取 `state`/`model`/`questions`，见 `src/worker/lib/upstream.ts:37/137`），所以身份口径与历史轮次仍可比；差异只在**谁来做限流与重试**——历史轮次是 Worker，本计划是 box 侧自限速（§8 风险表已列）。

📌 **为什么身份写成 `official|…` 而不是历史轮次的 `proxy|…`**：`proxy` 渠道在代码里是**相对端点** `api/jev` 且只发 `X-Api-Key`（`src/core/jev/client.ts:31`），它天然依赖业主 Worker；直连上游必须换成 `official`（绝对端点 + `Bearer`）。两个身份**协议同构、可比但不等同**（限流/重试方不同），所以 P4b 起阶梯报表一律标 `official|v14-live3-fresh|0` 这类写法，**不与历史 `proxy|…` 轮次混在一张表里算 Elo**，只在结论里注明同源。

**四条阶梯**（可分别跑，也可合并成一次 round-robin）：

| 阶梯 | 对局 | 局数 | 估时（按 §2 锚点） | 回答什么 |
|---|---|---|---|---|
| **L3 Rapfi 自身思考时间曲线**（先跑，纯本地不耗上游） | `rapfi@500/1000/2000` 两两 + `@5000` 对 `@1000` | 6 对 × 20 = 120 局 | ~2–3 h | 「`rapfi@不同时间`真正的能力」——用户的直接问题 |
| **L2 各版对 Rapfi** | 5 版 × `rapfi@{500,1000,2000}` | 15 对 × 20 = 300 局 | ~7 h（实测 316.7 min） | 版本能力沿时间轴的位移；同一版本在不同对手强度下的表现 |
| **L1 版本内侧梯** | 5 版两两 | 10 对 × 20 = 200 局 | ~11 h（双上游臂，上游双倍负载，需限速） | 版本之间谁更强（**预期差异最小，最需要配对开局与大样本**） |
| **L4 各版对 Rapfi 高思考档**（2026-10-04 业主新增：把曲线补到 UI 上限） | 5 版 × `rapfi@{7000,10000}` | 10 对 × 20 = 200 局 | ~18 h（dry-run 实测：`@7000` ≈93 min/轮、`@10000` ≈123 min/轮） | 「抬到 UI 上限的 10 s 后，搜索还继续变强吗；各版本的相对位置会不会翻」 |

> **L4 的口径**：业主 2026-10-04 原话「补 500ms，7000ms，到 10000ms」——`@500/@1000/@2000` 已由 L2 各覆盖 100 局
> （分母配平），所以 L4 **只补 L2 没有的两档**（`@7000`/`@10000`，后者 = UI 上限）；做曲线报表时一次读两批：
> `node scripts/experiment-report.mjs --dir .work/remote/l2n1,.work/remote/rapfihi1`（`--dir` 支持逗号分隔的多根，
> `gameUid` 全局去重、按身份聚合 ⇒ 5 档曲线一次出）。
> 两批**不重叠**这一条由单测钉死（`test/scripts/ladder.spec.mjs`），避免「同一对同一档跑两遍还当新样本」。

**样本与分辨率（诚实口径）**：单对 20 局、p≈0.5 时得分率 95% CI ≈ ±22 pt；60 局 ≈ ±13 pt；200 局 ≈ ±7 pt。⇒ **Stage 1（20 局/对）只做筛选**；**Stage 2 只对决赛对（前 2–3 名 + 锚 + 一档高 Rapfi）做 100–200 局配对确认**，才允许写「A 比 B 强」。分辨率目标 = 5 pt ⇒ 200 局/对起步（这正是机制线恢复的门槛）。

**估时口径（P6 之后以 CLI 为准，上表是起草时的粗估）**：`experiment-ladder.mjs` 的 dry-run 会逐轮印 `≈` 墙钟，模型 = **每局 60 手**（归档 312 局 / 19298 手 ≈ 62；P4b box 验收两局 27 与 80 手）× 每手成本，其中**上游臂 1.1 s/手**（P4b box 实测 27 手 26 s、80 手 89 s，含模型往返 + 战术层）、**rapfi 每手 ≈ think/2**（一手里只有执子那一侧思考）。照这个模型：L3 的 120 局 ≈ **2–3 h**（不是 10 h —— 起草时把「两侧各思考一次」算重了）、L2 的 300 局 ≈ 7 h（上游臂占一半手数）、L1 的 200 局 ≈ 11 h（双上游臂，最贵的一条）。这个数字只用来排序「今晚先跑哪条」，**不进报表**；真跑出来的墙钟以 `progress.json` 的 `meanGameS`/`etaS` 为准。

📌 **60 手/局 是下界，别拿它当承诺（2026-10-04 实测校准）**：`vorder1` round-1（双上游臂）20 局的真实手数分布是 **均 90.3 ／ 中位 39 ／ p90 225 ／ 最长 225**，其中 **5 局打满 225 手**（`--max-plies` 上限）——双上游臂之间会出长局，dry-run 的 `≈` 因此偏乐观；但**别把这个分布外推到「版本 vs Rapfi」**（那是两回事：双上游臂没有 Rapfi 在中间把局面掐断）。
📌 **L4 的墙钟要用 L2 自己的 300 局重估（2026-10-05 实测）**：`l2n1` 300 局（全是版本 vs Rapfi）手数 **均 49.3 ／ 中位 33 ／ p90 75 ／ 最长 225**，Rapfi 侧手数/局 **均 24.5**，上游侧单手 ≈2.4–2.55 s（同一份报表的成本表）⇒ 每局 `Rapfi手数 × think + 上游手数 × 2.4s`：
`@7000` 均 **3.9 min/局**（中位 2.5 / p90 5.9 / 最慢 17.7）、`@10000` 均 **5.1 min/局**（中位 3.3 / p90 7.8 / 最慢 23.3）
⇒ 单轮 20 局 ≈ **1.3 h / 1.7 h**（按 p90 逐局累加 2.0 h / 2.6 h），10 轮合计 **≈13–17 h**，与 dry-run 的 18.0 h 相符。
**早先按 `vorder1` 手数外推出来的「≈26–35 h」作废**（错在把双上游臂的均 90 手当成了版本 vs Rapfi 的手数）。
`pollRound()` 的单轮 12 h 上限安全（最坏的轮也在 3 h 内）。跑之前仍先看 `progress.json` 的 `meanGameS`。

**BT 估计量的分辨率（P5 实测，别把 Elo 差值读细）**：P5 用合成数据量过传递性拟合的误差 —— 三身份轮转、**200 局（每对约 67 局）时真差 100 / 200 Elo 的平均绝对误差是 27.9 / 35.6 Elo**，400 局降到 21.2/25.4，800 局 20.6/17.3；两身份干净情形才与理论 SE 吻合（n=200 时 SE ≈ 25.6）。⇒ **一次 200 局的阶梯只能分辨 ~30 Elo 量级的档位差，不要用 `BT Δ` 的小数位去讲 10 Elo 的进步**；`BT Δ` 的 bootstrap 区间按局重采样、不利用配对结构（同一开局换色双跑两局相关）⇒ 区间偏窄，判「跨档位是否有差」仍以配对样本为准（报表脚注已印这条）。

**成本纪律**：① 单上游臂串行，轮次之间 30 s 冷却；② 双上游臂（L1）把 `--games` 减半或拆两晚；③ 阶梯产物落 box JSONL，`pull` 回本地；④ 每轮报 `tac_ms` 三口径 + 单步墙钟 + 模型往返（m07650/m08110 的必报项照旧）；⑤ **直连上游自限速 30 req/min + 并发 1 + 429 退避熔断**（D12，替代 Worker 的限流）；⑥ 每轮结束 `batch-bucket.mjs push`（D14），上传失败只告警。

**运行面（G3，可被业主随时抽查）**：进度看 `ssh <host> "cat /root/ladder/<batchId>/progress.json"` 或 `experiment-batch.mjs status --watch`；日志 `ssh <host> "tail -f /root/ladder/<batchId>.log"`；产物在桶里 `ladders/<batchId>/`（`plan.json` / `games.jsonl` / `progress.json` / `report.md` / `elo.json`）。整轮跑动期间业主 Worker 与生产 D1 **零新增**（P4b 验收 ①）。**2026-10-04 起**：编排进程自己每分钟把远端进度打成一行（`⏳ round-N d/total 局 · 秒 · 均 Xs/局 · W-D-L`，来自 `pollRound()` 的捕获式 ssh）⇒ 不必再去远端 `cat`，阶梯日志本身就是进度面板。

**报表（每次阶梯必出）**：① 能力表（BT Elo + bootstrap 95% CI + 局数 + W/D/L + 得分率 + 锚点说明 + **Wilson 区间**）；② Rapfi「思考时间 → Elo」曲线点（2026-10-04 起每行带 **ΔElo（相对上一档）**，表下印相邻档差 + **区间重叠对数** + 每档样本 —— L4 要读的就是「抬到 10 s 还涨不涨」）；③ 成本表（每手 `tac_ms` 中位/均值/p90/最坏、单步墙钟、模型往返、战术层占比）；④ 开局库分层表（每个开局谁占优，检查开局是否偏向某一身份）；⑤ 差异显著性说明（CI 是否重叠；样本 < 50 局必须标注）；⑥ 产物清单（桶前缀 + 行数 + sha256，便于复核与续跑对齐）。

✅ **已实现为一条命令（2026-10-04，第一晚 L3 之前落地）**：`node scripts/experiment-report.mjs --batch <batchId> [--json <path>]` —— 读 `<batchId>/round-<i>/games.jsonl` + `round-summary.json` + `events.jsonl`，写 `report.md`（缺省 `.work/<batchId>-report.md`）与可选 JSON；纯函数在 `scripts/lib/report.mjs`（`moveIdentity`/`isUpstreamMove`/`quantiles`/`collectCost`/`costRow`/`pairTable`/`rafiCurve`/`curveDeltas`/`openingRows`/`significance`/`colorCells`/`colorSplit`/`endReasons`/`layersByResult`/`screenVersions`/`reportMarkdown`），单测 `test/scripts/report.spec.mjs` 36 例。落地时的口径决定：
① **成本表的两个占比都印**（`战术占单手 = tac/(往返+tac)` 与 `战术/往返 = tac/往返`）—— C2 验收轮对外报的 48.6% 是后者，只印一个迟早会被读串；
② **上游兜底手（`provider=backup`）单列在「提供方」列、明写「未计入主口径」**（C3 的报表口径一路带到这里）；
③ **不改 `formatRankTable()` 的形状**（第 1 节直接内嵌它）—— 老报表逐字不变（P5 的纪律），新信息只加在头部/脚注/新表。
④ **第 4 节必须同时给「逐色格」与「分开颜色」两张表**（2026-10-04 第一晚 L3 后加）：60 局里黑方赢了 51 局（85.0%）、和棋 0 ⇒ 先手优势比思考档位差大得多，只报总分（W/D/L）会被「谁执黑」带跑。逐色格 = 「黑身份 vs 白身份」成格（格内颜色固定），分开颜色 = 每个身份的 `执黑 x/y`、`执白 x/y`。先手优势本身也印成一行（`本轮黑方胜 51/60（85.0%）｜和棋 0`）。见 `docs/plans/2026-10-04-l3-rapfi-think-time.md` §4。
⑤ **第 4 节内另有一块「收尾机制 + 接管层 × 结果」的解释性内容**（2026-10-04，`vorder1` round-1 后加）：`endReasons()` 印收尾原因分布、和棋的手数（`棋盘已满` 的 225 手满盘和 ≠ 协议和）、全局手数分位；`layersByResult()` 每身份一行「接管层（开火次数；该层开火那几手的 胜/和/负）」。规则 11 要求「败局要解释、和棋可接受」，这块就是那份解释 —— 但它**不参与判强**（判强只看 §1/§4），所以只作 §4 的子块，不打乱 §1–§6 编号（多处文档引用这些编号）。层的取法与 `scripts/lib/tactics-replay.mjs:52 recordedLayerOf()` 同源：`move.tactics || move.ai.tac`（**`ai.tv` 是战术版本，不是层**）。`vorder1` round-1 实测读法（20 局）：v11 的 `vctAttack 21（21/0/0）`、`open4 9（9/0/0）` = 织出连续威胁就赢；v13 的 `block 46（4/7/35）` = 被压着堵时 35/46 输；5 局和棋全部是 225 手满盘。
⑥ **第 4 节印「版本筛查判读」块**（2026-10-05 加，`screenVersions()`）：把 §7 那条「要不要补 L1」的机械规则直接算出来印在配对表与逐色格之间 —— 全序（Copeland 赢场数，逐三元组查环）、共同对手一致性（直接比较 vs 经第三方的间接比较）、换色翻面，以及一句判定（`有值得决赛的差距 ⇒ 只补决赛对 X vs Y` / `筛查不成立 ⇒ 直接跑 L1`）。只在**彼此真交过手**的 3–5 个 `official|v*` 身份上出现（整批只有「版本 vs Rapfi」的形态不印；混跑批次只按交过手的子集判，见 §7 判读规则第 ③ 条实测）；判据 ② 在 3 版筛查里每对只有 1 个共同对手，所以退化为「间接与直接同向」，块里写了这条口径提示。为什么机械化：n=20 的筛查本来就不许下强弱结论，三条判据靠肉眼在几张表之间来回看，迟早会滑向「先有结论再找证据」。
复算示例（`.work/remote/c2fb2` 4 局）：`official|v14-live3-fresh|0 | 55 手 | 往返 1691.6／1462／2639／3531 ms | 战术 823／516／1773／2839 ms | 单手 2514.6 ms | 占单手 32.7% | 战术/往返 48.7% | backup 55`。

后续补的一条读法纪律（2026-10-04，L3 跑到一半时发现）：**「这轮跑完没有」的本地凭据只有 `round-summary.json`（worker 收尾才写）**。缺它的轮默认照读，但报告头与第 5 节会显著标出「有 N 轮仍在跑（X 局已计入）」、收尾行也告警；要把它排除就加 `--skip-incomplete`（这些局与它们的产物行都不进报告）—— 半轮的比分不许进结论。

**已出的两份阶梯报表（2026-10-04，本计划 §7 的第一次真交付）**：

| 批次 | 命令 | 规模 | 结论（详见各自文档） |
|---|---|---|---|
| `l3n1` | `--ladder L3 --batch l3n1 --games 20` | 3 轮 / 60 局 / 34 分钟 / 零上游 | [L3 报告](2026-10-04-l3-rapfi-think-time.md)：`@2000` 在两个颜色格都占优，`@500` 与 `@1000` 分不出；60 局黑方胜 51（85.0%）⇒ 先手优势盖过档位差 |
| `l2n1` | `--ladder L2 --batch l2n1 --games 20` | 15 轮 / 300 局 / 316.7 分钟 / 7440 上游手全 `primary` | [L2 报告](2026-10-04-l2-version-vs-rapfi.md)：**Rapfi 曲线成立**（500/1000/2000 = Elo 1240.1/1340.8/1448.4，500→2000 区间不重叠）；**5 个版本之间不可排序**（12 对区间重叠）；成本随机制单调变贵（战术占单手 22.3%→38.7%）；回归核对层一致 640/640 |

⇒ 对后续的硬性影响：**动作项 ①「版本排序」必须单独跑一条**（§9 第 9 条），② Rapfi 可以再抬一档（§9 第 4 条），③ 报告的逐色格与成本两占比已被两份报表实测用到，不再算「可选」。

**第三份（业主 2026-10-04 批准，正在跑）**：`vorder1` —— `--identities 'official:v13-pressure-gate:0,official:v11-vct:0,official:v14-live3-fresh:0' --games 20`，
3 对 × 20 局 = 60 局、**双方都是上游臂**（每手都要走 Jev，实测 ≈4h；产物留 box、暂不推桶）。
先做筛查而不是直接上 L1 的理由：L2 已量出 200 局才分辨 ~30 Elo，L1 那 200 局同样回答不了「A 比 B 强」，
但 60 局足以看出三版之间**有没有值得决赛的差距**；跑完再决定要不要补 L1。

**筛查判读规则（把「要不要补 L1」写成机械规则，报表一到照着读）**：

- 材料：报告第 1 节（只有 2 身份时算法退化成直接比分）、第 3 节逐对 W/D/L + Wilson、第 4 节逐色格、第 5 节成本。
- 前提：单对 20 局的半宽 ≈ ±20 pt（§1 已量）⇒ **单对区间重叠不是「没差」的证据**，只说明这一对没分辨出来。
  所以判读按「三对一起看」，三条同时满足才算「有值得决赛的差距」：
  ① 三对的点估计能排出**全序**（例如 v11 > v13 > v14）；
  ② 这个全序在**两个共同对手**上方向一致（v13 对 v11 与对 v14 指向同一侧，而不是一对一错）；
  ③ 逐色格不出现「换色就翻面」（执黑/执白的胜场符号相反是**先手优势**，不是版本差）。
- 三条全中 ⇒ **只补决赛对**（把最强的两版跑到 100–200 局配对，按 §1 的分辨率口径），**不跑整条 L1**；
  任一条不中 ⇒ **直接跑 L1**（10 对 × 20 = 200 局，≈11 h），并在结论里写明「L1 也回答不了 A 比 B 强」——
  它的用途是给出五版的两两区间图，供后面挑决赛对。
- **高和棋形态另判**：本轮 round-2 前 8 局是 `W2-D6-L0`（过半和棋）。和棋 ≥1/3 时比分口径天然难分辨，
  按规则 11 改读「不败率 + 败局解释」，结论就写「这几版在当前开局库下不可分」，不硬排先后。
- **2026-10-05 起这条规则已机械化**（`screenVersions()`，见 §7 报表口径 ⑥）：报告第 4 节直接印三条判据的结果与
  一句判定，人工只做复核。实测三点：① 三版筛查要求「三对全齐」，`vorder1` 分三轮跑 ⇒ **单轮的报表里这一块不出现
  （或写「只凑齐 N/3 对」）是正常的**，要等三轮齐了再读；② 判据 ② 在只有 3 版时每对只有 1 个共同对手
  ⇒ 退化成「间接比较与直接比较同向」，等 L1（5 版、每对 2 个共同对手）才恢复成原文口径；
  ③ **筛查对象只算彼此真交过手的那几版** —— `l2n1`（5 版但全都只跟 Rapfi 交过手）第一版实现会误印
  「只凑齐 0/10 对 ⇒ 直接跑 L1」（真实 300 局复跑时抓到），现在这种形态整块不印；混跑批次
  （`l2n1` + `vorder1` 一起读）也只按交过手的子集判。

**第四份（业主 2026-10-04 定，排第三份之后）**：`rapfihi1` —— `--ladder L4 --batch rapfihi1 --games 20`，
10 对 × 20 局 = 200 局（5 版 × `rapfi@{7000,10000}`）、按 L2 真实手数重估 **≈13–17 h**（见上一条校准）、产物留 box。
业主当轮的原话是「补 500ms，7000ms，到 10000ms」：`@500/@1000/@2000` 已由 `l2n1` 各覆盖 100 局，
所以这条只补高思考档；**与 `vorder1` 串行不并行**（box 上 Rapfi 的思考时间是墙钟，两个作业同时跑会互相抢 CPU ⇒ 时间档失真）。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| **一整层其实是死分支，而我们以为它在工作**（P2 现场发现，**P3 已结案**） | 已证一例：接管链的 `threat` 层在 gomoku + 非空候选集下**不可达** —— `you:open4` 标签判据（走后 ≥2 个成五点，`src/core/engines/gomoku.ts:1063-1064`）与 `chance_points_you` 判据（`src/core/tactics.ts:202`）同源，且凡含 `threat` 的档（v3 起）都含 `open4`、链里 `open4` 在前 ⇒ 只有「候选集扫不到 open4 点却算得出 chance 点」才可能开火。取证：2225 个归档候选 + 双活三/双四合成局面全部 chance=0 或层被 `open4` 接管（`.work/p2-threat-probe2.mjs`）。缓解：指纹的覆盖表断言「除 `threat` 外每层都必须被走到」并把 `missing` 精确钉成 `['threat']`（⑭c）；**P3 已对 14 层逐层复核可达性并写进考古文档 §6.1**，`threat` 标注「历史层，当前机制表下不可达」（考古表仍按「当年该档含此机制」记录，但不得拿它归因强度差异） |
| 指纹把**当下的 bug** 一起冻住 | P1 先做「零行为变更对照」，P2 生成基线前先跑 P0/P1；指纹只记决策不记耗时（D7）；`--write` 必须在 commit 消息里写明理由 |
| 预算下传改变线上行为 | P1 验收要求「缺省预算 ⇒ 15 档 × 120 局面逐字一致」；引擎缺省常量**一个都不改** |
| 考古无法确证（审计 §9 的中置信项） | 标 `fidelity:'approximate'` + 缺口描述；需要逐字时走 P7 `--rev` |
| 上游采样方差 > 版本差异 | 配对开局（D9）+ 大样本 + CI 门槛（D10）；L1 结论默认只能到「筛选」级别 |
| 双上游臂把上游打爆 / 429 增多 | 串行 + 冷却；`retryable` 退避已有；必要时降级为「单上游臂 + rapfi」并把 L1 拆两晚 |
| D1 写额度与棋谱洁净度 | D11：阶梯不写 D1，只一行汇总；`--allow-production` 闸门（承接上一轮「写入隔离没自动化」的 P1 建议） |
| 开局库太窄 ⇒ 所有身份趋同、区分度下降 | K≥8 且覆盖不同首手/不同形状；报表出「开局分层表」，若某开局对所有身份都是同一结果 ⇒ 换库 |
| 阶梯跑完发现口径又错（重蹈 17.5 pt 覆辙） | 先跑 L3 做**口径自检**：`rapfi@1000` vs `rapfi@500` 若测不出该有的差距，说明设计或方差控制有问题，先修口径再跑 L1/L2 |
| **直连上游丢掉 Worker 的限流/重试**（D12） | ✅ **已实现**（P4b）：`scripts/lib/throttle.mjs` 滑窗自限速（缺省 30 req/min）+ `installFetchThrottle()` 裹全局 fetch（只给上游主机领令牌，`src/core/jev/client.ts` 内部重试也照领）+ 连续 **5** 次 429 ⇒ 熔断（`acquire()` 抛 `限流熔断已触发…`，`summary.throttle`/`events.jsonl` 记数）；退避档沿用 `src/app/loop.ts` 的 4 s/12 s/25 s；跑前先做探针确认额度与延迟 |
| **直连上游的协议随上游变动**（离线面与生产转发漂移） | 请求体白名单与 `src/worker/lib/upstream.ts` 共用同一段口径（P4b 单测：同一 state ⇒ 直连与 Worker 转发**逐字同体**）；上游改协议时两条路径同时红 |
| **box 上 key 的暴露面**（`/root/.jev-key`） | 沿用 ADR-0019：`chmod 600`、只从文件读、**永不进日志/URL/产物**（`events.jsonl` 只记 key 长度）；上传桶的产物里不含 key（P4b 验收里加一条 `grep -r 'apikey_'` 必须为空） |
| **桶凭据纪律与断桶** | 凭据只从环境变量取（D14），不入仓库、不写进 box 日志；刻意断桶时跑动不中断（P4b 验收 ③）；`ls`/`push` 失败重试 3 次后告警 |
| **box 出网不可达上游 / 桶**（上游那半 ✅ **已跑通整局**；桶那半仍待桶地址） | **P4b 探针 + 整局验收均已跑（2026-10-04）**：① 探针 `curl -X POST https://api.typesafe.ai/v1/systemone -H "Authorization: Bearer $(cat /root/.jev-key…)"` ⇒ **HTTP 422**（`questions` 空 ⇒ 鉴权已过）0.315 s，**上游可达**；② 整局 `official:v14-live3-fresh:0` vs `rapfi:v14-live3-fresh:1000` 2 局 118 s、54 次上游请求、零 429、`store=local` 未触碰业主 Worker（跑前跑后 D1 行数 312/19298/28 不变）；桶 endpoint 的 `HEAD` 仍待第 6 条定桶后补；若桶不可达 ⇒ 只影响留档，本地 JSONL 与 SSH 进度不受影响（上传失败只告警，D14） |

---

## 9. 开放问题（需要探针，先问再写代码）

1. **proxy 是否接受采样参数**（temperature / top_p / seed）？若能冻结，跨轮方差会显著下降 ⇒ 加了 `--model-params` 后 L1 的 5 pt 目标可能用 100 局就能达到。探针：`scripts/probe-model-params.mjs`（只读，POST 两组参数比输出分布）。**2026-10-04 已答「不接受」（本机直连官方端点实测，产物 `.work/probe-model-params.json`）**：夹具请求体（`test/fixtures/jev/commandcode-systemone-2026-10-03.json` 的 `request`，投影成客户端真正发的 `{state, questions, model}` 三个字段）原样 ⇒ 200；加 `temperature: 0`、`seed: 1234`、两者都给、`top_p: 1` ⇒ **四次全 400 `api_usage_error / Invalid request.`**（330–1200 ms）⇒ **这条方差捷径关掉了**，5 pt 分辨率只能靠样本量（或降低提示侧抖动），`--model-params` 这个开关不必做。附带读数：同一局面 baseline 连打 10 次**着法 10/10 都是 `H8`**（自报概率仍在摆：`H8` 0.10、`E5` 0.10、其余 ≤0.03，均 1262 ms）⇒ 该局面的**选择**是稳的（它是 `you:four` 的强着，算上界；模棱两可的局面另说），但**概率分布**不冻结，别把 `probabilities` 当逐字可复现的读数。
2. **（✅ 已结案 2026-10-04）Rapfi 是否支持节点数预算**（`-nodes` 之类）？支持 ⇒ 可以额外出一条「等节点数」的公平对比，并让 `--rev` 逐字复现更可行。**2026-10-04 结案（本机复现探针，真引擎，不抢 box 正在计时的 Rapfi）**：
   - ① `INFO max_node <N>` 是**真正的节点预算**：静默接受且**按 N 单调生效** —— 同一 12 子中盘局面 + `INFO timeout_turn 3000` 实测 `N=1 → 7ms／最深深度 0`、`100 → 3ms／8`、`1000 → 2ms／12`、`10000 → 26ms／19`、`100000 → 116ms／29`、`1000000 → 1087/1114ms／55`；`N=0`（不限）与 baseline 都是 `2631/2572ms／53`。着法在全部变体里都是同一手 `9,10`（该局面早定）。
   - ② **参数名必须是 `max_node` / `max_depth`**：`INFO nodes 100000` 与 `INFO depth 12` 都被拒（`MESSAGE Unknown Info Parameter: NODES` / `…: DEPTH` + `ERROR Unknown command: 100000` / `…: 12`）。⇒ 先前那条「节点数只能读、不能设」的判断**是错的**（它与本文件第 50–62 行探针 A 直接冲突）：节点数**可读**（`INFO show_detail 1` 的 `MESSAGE` 行）**又可设**。
   - ③ 仍然成立的部分：客户端现在**不发**节点预算（`src/core/jev/rapfi.ts:240` 只硬编码 `INFO timeout_turn <ms>`），在跑的阶梯全部按**时间档**计时 ⇒ **不换协议**（换了等于换臂，已跑的轮作废）。
   - ④ 「等节点数」的公平对比**技术上已可行**（`INFO max_node N` + 固定开局 + 固定预算 ⇒ 可逐字复现），但要作为**独立 preset 单跑**，并需给客户端加一个可选 `INFO max_node` 开关 —— 属机制/协议变更，按规则 10 另开计划与 ADR 决定，**本轮不做**。
   - ⑤ 与 §2.1 探针 A 的关系：本条**不是新发现，而是改正**。探针 A 当时已经实测「`max_node` 被静默接受 + 固定预算可复现」（§2.1 第 54/58/60 行），但本条第 2026-10-04 那次「只读代码」的勘察把第 61 行「客户端不发节点预算」读成了「节点数设不了」，进而下了「等节点数当不了控制变量」的结论 —— 那句**作废**，以探针 A 与本条实测为准。今天重跑还顺带确认了两点：`INFO nodes` / `INFO depth` 这两个名字**不合法**（必须写 `max_node` / `max_depth`）；三条 `ERROR Unable to open model file: "model210901.bin"` 等启动告警**不是**本次探针引入的新现象，§2.1 第 63 行已记录（config.toml 的 classic model 不在包内，引擎改用 `.data` 里的 mix9svq NNUE，是否影响棋力基线未做对照）。
   - 探针（一次性，不入库）：`.work/rapfi-node-info-probe.mjs` + `.work/rapfi-info-probe.json`（5 变体：baseline / `show_detail 1` / `nodes` / `max_node` / `depth`）、`.work/rapfi-maxnode-probe.mjs` + `.work/rapfi-maxnode-probe.json`（`max_node` 单调扫描）。
3. ✅ **`games` 表是否有 `device_id` 列**（历史 26 局回填用）—— **有，且回填已做完**（按仓库迁移 + `docs/status.md` 记录结案，没走线上查询）：列定义在 `migrations/0001_init.sql:61` `device_id TEXT REFERENCES devices(device_id)`，配套索引 `migrations/0001_init.sql:70` `CREATE INDEX idx_games_device ON games(device_id, day DESC)`（同文件 `:108` 的 `device_id TEXT` 是另一张表的列）。P0b 的回填顺序是「先补 `devices` 行（否则撞外键）⇒ `update … where device_id is null and experiment_tag in (…)`」⇒ `select count(*) from games where device_id='ssh-batch'` = **26**，这 26 局的 `code_version` 仍是 `dev+nogit`（不猜 sha），细节见 `docs/status.md:35-38`；注意 NULL `device_id` **不等于**远端局（浏览器轮也不发 `X-Device-Id`，D1 里仍有 286 局为 NULL，判设施产物要按 tag 或按 `ssh-batch`）。**为什么不再查一次**：2026-10-04 本机 `wrangler d1 execute --remote` 已失效（`code: 7403 The given account is not valid or is not authorized to access this service`，`accountTag 6f8cd3a216c8de232d829099778d7c53`），本机 D1 读路径要等业主补凭据/重登，不阻塞本条。
4. **L3 的 5000 ms 档要不要跑**：单局 ~8 min，20 局 ≈ 2.7 h，只为一个点；业主决定。**2026-10-04 现状**：第一晚 L3（`l3n1`）在**不含 5000** 的三档上跑完 60 局，`@2000` 相对 `@500` 可见方向；CLI 已备 `--with-5000`（多出 `rapfi@5000 vs @1000` 一对 = +20 局 ≈ 1 h）。**业主 2026-10-04 的最新口径是把曲线直接补到上限**（「补 500ms，7000ms，到 10000ms」）⇒ 先跑 `L4`（`@7000`/`@10000`），`@5000` 这一档被跨过、不单独跑（`@7000` 已覆盖它到 UI 上限之间的区间）。
5. **`--rev` 逃生门值不值得做**（P7）：只有在「确实要拿老版本逐字数据下结论」时才值得；否则考古 + `approximate` 标注够用。**2026-10-04 补充**：L2 的 300 局没有暴露任何「必须逐字复现老版本」的需求（回归核对层一致 640/640）⇒ 这条的优先级没有上升，仍待业主定。
6. **桶是哪一个**（Cloudflare R2 / S3 / B2 / 自建 MinIO）与 endpoint、region、path-style vs virtual-host？决定 `BUCKET_ENDPOINT` 的默认写法与 `s3-put.mjs` 的默认寻址样式（两种样式都会实现，只需定默认）。
7. ✅ **box 出网是否可达上游与桶**（P4b 第一步的探针）：**上游已答「可达」且已跑通整局**（2026-10-04，见 §6 P4b 行第 ⑧ 条与 §8 风险表该行；`/root/.jev-key` + `Bearer` POST ⇒ HTTP 422 = 鉴权通过、延迟 0.315 s；box `node -v` v24.9.0、可用内存 1336 MiB；`official:v14-live3-fresh:0` vs `rapfi:v14-live3-fresh:1000` 两局 118 s、54 次上游请求、零 429，跑前跑后 D1 行数 312/19298/28 不变）。**桶那半待第 6 条定桶后补 `HEAD`**。若桶不可达 ⇒ 只降级留档（本地 JSONL + SSH 进度照常）。
8. **直连上游的额度是否与 Worker 共用同一 key 的配额**：若共用，30 req/min 的自限速要按「Worker 生产流量 + 阶梯流量」的合计来设；跑前先探 5 次看 `429` 与 `Retry-After`。**2026-10-04 实测**：L2 的 7440 个上游手（`--rate-limit 30`）**零 429、零切换**，说明 30/min 的档位与生产流量共存是安全的；但「是否共用配额」本身仍未直接验证（生产那晚几乎无流量）。
9. **版本排序要单独跑哪一条**（L2 结论带来的新问题）：**2026-10-04 第一步已定并开跑** —— 业主批准三对筛查 `vorder1`（60 局，见 §7 第三份）；跑完再看要不要补 L1。业主同一轮把「Rapfi 抬时间」的方向也定了（`L4`，见 §7 第四份）。原始候选：L2 里 5 个版本各 60 局、12 对区间重叠 ⇒ 不可排序。两个候选：① **L1**（5 版两两 10 对 × 20 = 200 局，双上游臂、≈11 h，按 §7 分辨率只能分辨 ~30 Elo）；② **三对筛查**（v11 vs v13、v11 vs v14、v13 vs v14，3 对 × 20 = 60 局，≈1.5 h，先看有没有值得决赛的差）。按 §7「Stage 1 筛选 / Stage 2 决赛」的纪律，先跑 ② 更划算；要写「A 比 B 强」则决赛对必须 100–200 局配对。

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

