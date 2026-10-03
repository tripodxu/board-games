# CHANGELOG

本项目可感知的变更历史。版本语义：1.0.0 起遵循语义化版本（minor 加功能、patch 修缺陷）；
0.x 期间 minor 反映功能交付，patch 反映修复。
日常记录另见 [docs/memory/MEMORY.md](docs/memory/MEMORY.md)（新条目置顶）。

## [Unreleased]

### 修复

- **战术档位不再静默换档（P0/D2，plan `2026-10-03-tactics-fidelity-and-elo-ladder`）**：
  `src/core/tactics-versions.ts` 的 `resolve()` 过去对未知档号**静默回落到当前档**——
  「下拉里写着 v12、实际跑 v14」这种单变量破坏谁都看不见，实验结论会归因到错档位。
  现在 `resolve()` 抛 `UnknownTacticsVersion`（消息含**最接近的合法 id**，用莱文斯坦距离算，
  同距离取登记表靠前），展示/陈旧存档改用新增的 `tryResolve()`；`src/core/tactics.ts` 的
  `resolveVersion()` 兜底从「全机制集」改成 **`v0-off` 空机制集**（宁可战术层空转，也不许悄悄变成别的档位）。
  三个入口各自核对白名单：`scripts/experiment-run.mjs`（`--tacA v12-vct-de` ⇒ 打印
  「最接近的合法档位：v12-vct-def」+ 15 档全列表、**exit 2**）、远端批量 `parseSpec()`、
  UI `startExperiment()`（toast「实验未启动：无法识别的战术档位 A=…」并拒绝启动）。
  展示面一律宽容：`src/core/view/duel.ts` 的 `versionTag()` 认不出就照抄原串（不再冒充当前档）、
  归档面板对登记表外的历史值显示「登记表外的档位：X（原样显示）」、`src/core/persist.ts`
  在 `loadSettings()` 边界就地净化陈旧 localStorage（未知档号丢弃、侧配置清空）。
- **实验面两条防污染闸门（P0，卫生包①②）**：`scripts/lib/batch-common.mjs` 新增
  `productionGate()`（`submit` 不给 `--origin` 时必须显式 `--allow-production`，否则 exit 2 并提示
  「更推荐 --origin 指向独立 Worker + 独立 D1」）与 `parallelGate()`（`--parallel` 只允许双本地臂，
  含 `official`/`openrouter`/`proxy` 任一侧即拒绝并点名 `A=…/B=…`、说明会撞限流且污染对照）。

### 新增

- **实验报表带上不确定度（P0b）**：`scripts/lib/batch-elo.mjs` 新增 `wilson(hits, n, z=1.96)`
  （得分率的 Wilson 95% 区间），`rankTable()` 每行带 `rate/ci/halfPt`，`formatRankTable()` 印
  「95% 区间(Wilson)」列并在样本 < 50 局时追加 `±XX.Xpt ⚠` 与读数纪律注：**20 局/对半宽 ≈ ±20 pt**
  （教科书那条 Wald 写法给 ±22 pt，且 0 胜/全胜会越界），同档轮间方差 17.5 pt > 档位差
  ⇒ 区间重叠就写「不可判」。口径写死在 [docs/agents/playbooks.md](docs/agents/playbooks.md) §7 第 12 条
  （只准聚合口径；单局逐手对齐只允许同机同进程内做）。

- **候选点三数可观测（C0，plan `2026-10-03-cands-metric-and-provider-failover`）**：以前只有 `game_moves.cands`
  （模型给了概率且合法的点数），看不出**战术层到底把几个点交给了 Jev**。现在逐手同时记三数：
  `cands_sent`（交给 Jev 决定的点数 = 请求 `criteria` 的键数）、`cands_labeled`（其中带战术标签的点数）、
  `cands`（历史口径不动），由追加迁移 [`migrations/0003_move_cands.sql`](migrations/0003_move_cands.sql) 引入。
  纪律与 `tac_ms` 相同：**Rapfi / mock / 人类侧不过 Jev 候选集 ⇒ 记 NULL 而不是 0**（否则均值被拉低），
  0003 之前的老归档也全为 NULL（缺失 ≠ 0）。游戏级汇总写进 payload 的 `meta.candStats`
  （`{graded, sent, labeled, n}`，无样本整键省略），实验报告的分桶表新增「候选发评标」列、
  累计行给「候选点均值 发 X / 评 Y / 标 Z（N 手）」、轮次注脚给「候选点均值 发 X」。
  验证：`tsc` 0 错、引擎自检 **144 例**、vitest **37 文件 / 385 例**（新增 worker「候选点三数落库」与
  ui「按手加权分桶，非 Jev 身份记 —」两例）、黄金零漂移；实现记录见计划 §4.1。

- **战术 v14 `v14-live3-fresh`（活三判据纠偏：制造点必须由这一手新造）**：`live3After` 自 v10 上线起
  只要求「落子后本方存在 ≥2 个活四制造点（L2）」，**没要求这些点由这一手新造** ⇒ 本方已握 ≥2 个制造点时，
  **任何一步闲棋**都被判成「制造活三」，再叠上 `live3Deny` 的 best 就成了一条无据的接管面。
  五轮 rapfi 对照共 **3864 个我方回合**逐回合独立复算（`.work/v14-live3-correct-scan.mjs`）：
  引擎口径非空 1648 回合（42.7%），其中**整集全假 16 回合**；引擎报点 18675 个里
  **12676 个（67.9%）是幻影点**；纠正口径**零漏报**（引擎集恒为超集）。用接管层标签把「决策」与
  「事实」拆开后（`.work/v14-live3-tac-scan.mjs`）：`live3Attack` 真接管 289 手 + `live3Defense` 122 手，
  **没有一手落在幻影点上**（411/411 在两套口径下判据一致），78 手「实走落在幻影点」全部来自
  `block`(36) / 无接管(33) / `win`(9) ⇒ **纠偏不改任何一手已发生的决策**，修的是
  **212 手 / 5.5% 回合**注入模型的 `live3_you` / `live3_opponent` / `live3_deny_points` 从 68% 幻影变真话。
  引擎侧加可选基线（`l2Set` / `freshL2After`），`live3Makers` / `live3Deny` 收 `opts.fresh`，战术层按
  `M.live3Fresh` 传参；**缺省仍旧口径** ⇒ v0–v13 的历史归因与回放逐字不变，`pressureOf`（`vctDefense`
  并列拆法的排序启发式）刻意不动。成本：纠正口径单回合中位 **14 ms** / p90 24 ms / 最坏 66 ms
  （对照一次 Jev 往返约 1 s）⇒ 符合规则 10「远小于一次 Jev 调用」。
  **对照实验（2026-10-03，单臂 12 局 vs `rapfi@1000ms`，tag `exp-20261003035953`，版本 `1.0.0+b6c6921`，
  用时 1165 s、上游 316 次调用全 200 / HTTP 错 0）**：**9 胜 1 和 2 负（得分率 79.2% · 不败率 83.3%；
  执黑 5-0-1 / 执白 4-1-1）**，平均 52 手；两负在最前两局且**全程「我方有杀 0」**，防守机会里拆不掉的
  3 / 6 手逐条都是「全盘没有拆点」⇒ 输在更早的织网期（B 型长局）。战术层 `tac_ms` 中位 **190 ms** /
  均值 **422 ms** / p90 878 ms / 最坏 6494 ms，单步墙钟均值 913 ms ⇒ 占单步均值 **46.2%**
  （Rapfi 固定 1000 ms/手；**占比不可跨轮比**：v13 同档轮的 4.9% 差在上游的 66 次 HTTP 错）。
  **部署生效实证**（`.work/v14-deploy-verify.mjs`，从归档记法独立重放 316 手，不复用引擎内部函数）：
  live3 两层接管 **60 手 · 60/60 落在纠正口径内**，事实面 **22 手 / 7.0%** 被修、点数 2481 → 972
  （幻影 60.8%）。**如实说明**：这是纠偏、不是棋力杠杆——12 局量级上强度不可分辨
  （与 v13 同档的 9 胜 0 和 3 负差一局，而同档轮间方差实测 17.5 个百分点）；
  计划 [docs/plans/2026-10-03-tactics-v14-fresh-live3.md](docs/plans/2026-10-03-tactics-v14-fresh-live3.md)、
  ADR [0018](docs/adr/0018-live3-fresh-correction.md)（修正 ADR-0014 的 L3 定义）。
  **抬高档位的第二轮（2026-10-03，单臂 20 局 vs `rapfi@2000ms`，tag `exp-20261003050139`，
  用时 3453 s、上游 760 次调用全 200 / HTTP 错 0，Rapfi 侧 `black_think`/`white_think` = 2000 已落库）**：
  **9 胜 3 和 8 负（得分率 52.5% · 不败率 60.0%；执黑 5-3-2 / 执白 4-0-6）**，平均 76 手，
  三个和局全是 **225 ½手满盘互拆**。逐手接管 760 手 = 无接管 266 / `live3Attack` 99 / `block` 94 /
  `vcfDefense` 67 / `live3Defense` 66 / `vctAttack` 57 / `parry4` 34 / `pressureGate` 25 / `parry3` 17 /
  `open4` 9 / `win` 9 / `vcfAttack` 8 / `parry` 5 / `vctDefense` 4。成本：`tac_ms` 中位 **199** /
  均值 **627** / p90 1955 / 最坏 6441 ms，单步墙钟均值 1176 ms ⇒ 占单步均值 **53.3%**（Rapfi 固定 2000 ms/手）。
  **规则 11 的败局交代**：760 回合里我方有杀 74、防守机会 187、真救 0，**拆不掉的 34 手逐条都是
  「全盘没有拆点」**；**8 个负局全部「我方有杀 0」**（与 1 s 轮同一种失效模式，不是新回归）。
  链首现：胜局我方链首现 9/9（13.6 ½手）、负局 3/8（74.7 ½手）、和局 0/3（压力领先占比 66.4%）。
  **读法**：档位从 1 s 抬到 2 s 后比分下降（79.2% → 52.5%）不等于棋力退步——和局 1 → 3、负局更长、
  失效模式不变；**跨档位比分同样不是曲线**（同档轮间方差实测 17.5 个百分点）。
  **抬高档位的第三、四轮（2026-10-03，同口径单臂各 20 局）**：`rapfi@3000ms`（tag `exp-20261003075310`，
  用时 2089 s、上游 443 次全 200 / 错 0，Rapfi 侧 `black_think`/`white_think` = 3000 已落库）
  **15 胜 1 和 4 负（得分率 77.5% · 不败率 80.0%；执黑 8-0-2 / 执白 7-1-2）**，平均 44 手，
  接管 443 手 = 无接管 128 / `vctAttack` 94 / `live3Attack` 60 / `block` 32 / `vcfDefense` 31 /
  `live3Defense` 24 / `pressureGate` 18 / `win` 15 / `open4` 14 / `vcfAttack` 12 / `parry4` 8 / `parry3` 4 /
  `parry` 2 / `vctDefense` 1，`tac_ms` 中位 **247** / 均值 **647** / 最坏 5850 ms、占单步均值 **54.9%**；
  `rapfi@5000ms`（tag `exp-20261003082805`，用时 2898 s、上游 496 次全 200 / 错 0，Rapfi 侧思考档 = 5000）
  **12 胜 1 和 7 负（得分率 62.5% · 不败率 65.0%；执黑 8-0-2 / 执白 4-1-5）**，平均 50 手，
  接管 496 手 = 无接管 118 / `live3Attack` 71 / `vcfDefense` 70 / `vctAttack` 63 / `block` 58 /
  `live3Defense` 34 / `vcfAttack` 16 / `pressureGate` 15 / `parry4` 13 / `win` 12 / `open4` 11 / `parry3` 8 /
  `parry` 4 / `vctDefense` 3，`tac_ms` 中位 **225** / 均值 **792** / 最坏 6762 ms、占单步均值 **57.7%**。
  **规则 11 的败局交代（两轮合计 40 局）**：939 回合里我方有杀 210、防守机会 254、`vctDefense` 开火 3、
  **真救 0**、**拆不掉的 44 手逐条都是「全盘没有拆点」**；**11 个负局全部「我方有杀 0」**；
  两个和局各 225 ½手、防守机会 17 / 29 **全数拆掉**（互相拆干净，不是被压死）。链首现：3 s 档胜局
  15/15（15.9 ½手）/ 负局 3/4（38.3）/ 和局 0/1（领先 59.0%）；5 s 档胜局 12/12（24.0）/
  **负局只 2/7（27.0）、压力领先占比 31.7%**（更靠近 A 型）/ 和局 1/1（101.0、领先 72.0%）。
  **四档阶梯 1000 / 2000 / 3000 / 5000 ms = 79.2% / 52.5% / 77.5% / 62.5%，非单调**：
  「跨档位比分不是曲线」第三次被实测确认，同档轮间方差（17.5 pt）大于任何档位差 ⇒ 下一步只能上配对样本。
  文档回填见 `docs/status.md` 与 [docs/plans/2026-10-02-tactics-v13-pressure-gate.md](docs/plans/2026-10-02-tactics-v13-pressure-gate.md)。

- **SSH 远端批量对弈实验设施（2026-10-03 合入 main，ADR-0019）**：`feat/ssh-batch-experiments` 分支
  （19 文件 / +2149 行）合并进 main，`src/**` 零改动、零新增运行时依赖（只用 `node:` 内置 + 仓内 `.ts` 直载），
  `package.json` 只加 `test:scripts`，`vitest.config.ts` 新增第 4 个 project `scripts`。构成：
  `scripts/experiment-batch.mjs`（本地编排 `submit / resume / status / pull / elo`，plan 落
  `.work/remote/<batch>/`）、`scripts/experiment-worker.mjs`（远端纯 Node 对弈回路：`setSeed` →
  `createSession(ai-ai)` → `decide` → `applyMove` → `buildGameExport` → 落盘 → `POST /api/games` →
  `GET ?tag=` 核对 → checkpoint）、`scripts/lib/batch-common.mjs`（spec/批次 id/预算纯函数）、
  `scripts/lib/batch-elo.mjs`（K=16 自研 Elo，身份 = `渠道|档位|思考ms`）、`scripts/lib/rapfi-node-loader.mjs`
  （Node 侧 rapfi 胶水，与浏览器同一协议代码路径）、`scripts/rapfi-parity-probe.mjs`（P4 强度 gate：
  浏览器归档 vs Node rapfi 逐手一致率，默认门槛 0.99）。远端在空闲主机 `qijia`（185.242.234.48）跑三轮
  26 局，`proxy|v13-pressure-gate|0` Elo **1551.9**（14 局 10 胜 2 和 2 负）> `rapfi|-|0` 1503.1
  > `random|v13|0` 1481.4 > `rapfi|-|500` 1463.6（全部 ⚠<50 局）；Node rapfi 臂与浏览器同资产同输入
  自对弈 12/12、重放归档 12/12 一致，残差经双向重放定位为**浏览器墙钟抖动** ⇒ 只认聚合口径。
  **合入时的独立只读审查**（子代理）报了 5 条合并阻断项，合入后同一批修掉：① `black_think`/`white_think`
  只在该侧 `rapfi` 且 >0 时写（复用 `thinkMsOf()`，否则 `proxy` 会以「0 毫秒档」这种不存在的身份进库）；
  ② `--rounds>1` 改为**起一轮 → 等 pid 退出 → 再起下一轮**（与「双上游必须串行」的闸门一致）；
  ③ 续跑 checkpoint **回读 winner/plies/gameUid** 并计入实验档案、`resume` 补 key 注入；
  ④ `batchId` 缺省带时分秒 + 同名即拒 + checkpoint 的 tag 失配就重跑（防「一局不跑却 POST `total=0`」）；
  ⑤ 归档 30 s 超时 + 3 次退避、**归档前先落 `pending`+`gameUid`、续跑复用同一 uid**（`dedup_key` 不变 ⇒
  D1 不会出现同轮同局两份棋谱）、归档后按 uid 核对、`writeJson` 改原子替换。建议项同批：`--origin`
  （不再硬编码生产域）、远端 `repoHead` 写进档案 `note`（Node 直载 `code_version` 恒为 `dev+nogit`）、
  `games[].blackTac/whiteTac` 过 `tacticsLabel()` 闸门（原先会造 `rapfi|v13-pressure-gate` 幻影身份）；
  另有 `identityOf` 收敛为单一实现、`pull` 不再先删本地、`scp` 不再把 SIGTERM 当成功、退避预算按手重置、
  `smokeTest()` 改真断言等。`test/scripts` **44 例**（原 38 例，新增 `ckptAction` 续跑判定）。
  文档：计划 [docs/plans/2026-10-03-remote-batch-experiments.md](docs/plans/2026-10-03-remote-batch-experiments.md) §P6、
  耦合审计 [docs/plans/2026-10-03-tactics-coupling-audit.md](docs/plans/2026-10-03-tactics-coupling-audit.md)（快照口径注）、
  [ADR-0019](docs/adr/0019-remote-batch-experiments.md)（原 0018 与 live3 纠偏撞号，已改号并同步全部引用）。
  遗留：远端批量的数据卫生（稳定 `X-Device-Id` / 清账）待业主决定。

- **战术 v13 `v13-pressure-gate`「压力闸门」（十四级保险）**：对手的「做四点」数压过我们时，
  先削他的点，而不是抢自己的活三。三条硬数据（`.work/v13-pressure-probe.mjs`，六轮 rapfi 对照
  共 **1787 个 Jev 回合**逐手离线复算）：归档标签 `live3Attack` 的实走 **205 手（11.5%）**，
  其中 **39 手（19.0%）落子前对手做四手数已超过我们**（胜 28 / 和 3 / 负 8），而这 39 手实走之后
  **对手仍握双四威胁（≥2 个做四点）的有 37 手**；改用「贴着对手做四点削」的点集，
  **37/39 更优、0 更差、平均 −1.87 个，双四威胁 37 → 7**。语义依据沿用 ADR-0015：活三只是**逼手**
  不是杀，而我方真强制胜早被 `vcfAttack` / `vctAttack` 接管 ⇒ 让位给削点不会漏杀。
  第一版「只拦不削」被推翻：25 个「抢活三而对手压力领先」的回合里 5 个确实落后，但这 5 个的
  `live3_deny_points` **全为空**（引擎 `live3Deny` 判据更严）⇒ 拦下来只会掉到 parry 系，削不到压力。
  引擎新增 `fourPressure(st, sideId, limit?)`（做四手数，默认不早退）与 `pressureCut(st, sideId, opts?)`
  （1-ply 削点搜索：候选序 = 模型候选 → 对手做四点车氏 ≤2 邻域（近者先）→ 其余邻近空点，
  上限 `PRESSURE_CUT_MAX = 120`，判据是**落子后对手做四手数严格下降**，并列取己方做四手数更大者，
  保留 `PRESSURE_CUT_KEEP = 3` 个）。候选序是硬要求：行序盲试会把 `1be84659` ply24 的最优削点 `C8`
  （对手 6 → 4）挤出候选上限，削点集变空集。战术层新增 `pressure_you` / `pressure_opponent` /
  `pressure_cut_points`，`ALL_MECH` 17 键；接管链在 `vctDefense` 与 `live3Attack` 之间插入
  `pressureGate` 成为**十四级**；开火四条 = 版本闸门 + 有削点 + 压力落后 + 对手无 2 手杀
  （`danger_points_opponent`，p18 夹具抓到过「只认手数、不认对手下一步的杀」的反例）。
  **削点为空则本层不开火 ⇒ 没有削点的局面与 v12 逐字一致。**
  **回归风险扫描**（`.work/v13-cut-check.mjs`，三个 v12 回合共 **800 个 Jev 回合**，口径分三层：
  条件满足 = 压力落后且算出削点 / 闸门真接管 = 前八层全空 / 真接管且改走 = 削点首选 ≠ 实走）：
  条件满足 **78 手（9.8%）**→ 真接管 **26 手（3.3%）**→ **真接管且改走 20 手（2.5%）**，
  改走率随对手变强而升（500 ms 档 5/7 → 1 s 档 6/6 → 2 s 档 9/13）；
  被更高层挡住 52 手（`vcfDefense` 40 / `parry4` 7 / `vcfAttack` 5 / `open4` 3 / `vctAttack` 3 /
  `vctDefense` 1 —— 优先级正确，不是漏杀）；`pressureCut` 单次均值 **3.2 ms** / 中位 3.3 / 最坏 6.1 ms。
  **代价**：26 个真接管回合里我们自己的做四手数平均 **−1.92 个**、13 手让掉攻势 —— 有意的取舍。
  **对照实验（2026-10-03 已跑完）**：tag `exp-20261002160819`，`rapfi@1000ms` 档，
  **9 胜 0 和 3 负（75.0% / 不败率 75.0%，执黑 4-0-2 / 执白 5-0-1，平均 45 手）**，
  对比 v12 同档 **10 胜 0 和 2 负（83.3%，平均 40 手）** ⇒ **一局之差在 12 局样本里是噪声**。
  **决定性证据是接管标签 × 局结果的交叉表**（`.work/v13-vs-v12-turns.mjs`）：
  `vctAttack` / `open4` / `win` / `vcfAttack` 四个进攻类层在 **9 个胜局合计命中 79 手、
  3 个输局命中 0 手**，三局负局的「我方有杀」全为 0 ⇒ **输在「赢不了」而非「防不住」**。
  v13 自身开火 14 手（8 胜局 8 / 3 负局 6），确实把对手做四手数压下去了，
  但**没有一手换来翻盘**（v12 侧「该被改写」的那 5 手活三**全部在胜局里**）
  ⇒ **判定：v13 机制有效但不是当前瓶颈，保留、不再加码，下一版转向进攻侧**。
  进攻探针（`.work/v14-attack-probe.mjs`）已排除漏杀（漏杀仅 2 手且都在终局、「有造杀点没走」= 0）。
  **20 局档位复核（2026-10-03，项目所有者要求各 20 轮）**：`rapfi@1000ms` 20 局
  （tag `exp-20261003003108`）**11 胜 1 和 8 负（57.5% / 不败率 60.0%）**、`rapfi@2000ms` 20 局
  （tag `exp-20261003020720`）**13 胜 2 和 5 负（70.0% / 75.0%）**；本档两个 1000ms 轮合并
  = **32 局 20 胜 1 和 11 负（64.1%）**。⚠️ **同档两轮差 17.5 个百分点，大于两档之间的差**
  ⇒ 比分由上游采样方差主导（1000ms 轮有 99 次状态 0 传输错误、往返均值 8854 ms；2000ms 轮 0 次错误、
  462 ms），**加局数分辨不出档位效应，需要配对样本**。机制层的两轮复盘（1067 个回合）：
  两轮 40 个「拆不掉」回合**全部是全盘没有拆点**，`vctDefense` 两轮合计开火 3 次、**真救 0**。
  设计取舍见 [ADR-0017](docs/adr/0017-pressure-gate.md)。
- **战术 v12 `v12-vct-def`「连续威胁防守」（十三级保险）**：把对手的**混合链**也纳入防守。
  v11 的三轮实验复盘（`.work/v12-defence-probe.mjs`，逐手离线复算）给出三条硬数据：进攻侧
  **「机会真丢」0 手**（206 / 175 / 602 个回合一致），输的局全是「算不出强制胜」；真正的漏洞在
  防守侧 —— 计时轮 175 个 v11 回合里「我方无杀而对手有链」**20 手（11%）**，其中**实走之后对手
  仍有链的 8 手（40%）全部落在三局负局**，而 8 手里 **4 手的实走正是对手的链首点**：占掉链首
  并没有拆掉整条链，因为 `vcfDefense` 只验**纯冲四**链，对手换成「活三逼迫 + 冲四收尾」就放行。
  引擎新增可选方法 `vctDefense(st, defenderId, maxPlies, opts)`：先算对手的链（有 VCF(7) 用它，
  否则算含活三逼迫的 VCT(9)），再按「链上各点 → 链点车氏 ≤2 邻域 → 全部邻近空点（按到链距离
  升序）」枚举候选（上限 `VCT_DEF_MAX = 12`），判据是**落子后对手既无 VCF(7) 也无 VCT(9)**
  （比 `vcfDefense` 严一档），并列拆法按「模型候选优先 → 对手造四点 ×2 + 活三点更少者优先」
  保留 `VCT_DEF_KEEP = 3` 个。候选序由四策略对照选出：只试链首 12/20、链首+链上各点 12/20、
  **+链点邻域 13/20**、全部邻近空点 13/20（首轮同序 19/21/21/22），第三档多抓到的那两手就是
  计时轮 `#8 ply24 → K9` 与首轮 `#6 ply52 → K8`。战术层新增事实 `vct_win_opponent` /
  `vct_chain_opponent`，接管链在 `vcfDefense` 与 `live3Attack` 之间插入 `vctDefense` 成为**十三级**；
  闸门要求「我方没有 VCF/VCT 必胜链、`vcfDefense` 也没找到拆点」，实测开火率 ≤11%。
  设计取舍见 [ADR-0016](docs/adr/0016-vct-defense.md)。**对照实验（2026-10-02，单臂 12 局 vs
  `rapfi@500ms`，tag `exp-20261002115126`）：12 胜 0 和 0 负（得分率 = 不败率 100%，执黑 6-0-0 /
  执白 6-0-0，平均 33 手）**，逐版曲线 25%（v9）→ 67%（v10）→ 83%/75%（v11）→ 100%（v12）；
  **但本版新增的 `vctDefense` 这一轮 0 次开火**（198 个回合里 42 个防守机会全被既有层拆掉），
  它的实证目前只有离线回归扫描的 3 个真救与夹具用例，实战验证要等抬高 Rapfi 思考档的下一轮。
  实测成本：`tac_ms` 中位 241 ms / 均值 381 ms / 最坏 4161 ms，战术层占单步墙钟均值 37.0%
  （本轮上游极快所致，均值与 v11 计时轮的 402 ms 同量级）。
  **抬高 Rapfi 思考档后的两轮（按 m08704，同口径单臂 12 局）**：`rapfi@1000ms`（tag
  `exp-20261002121700`）**10 胜 0 和 2 负（83.3%，执黑 6-0-0 / 执白 4-0-2，平均 40 手）**，
  `tac_ms` 中位 285 / 均值 695 / 最坏 6843 ms、占单步均值 51.6%；`rapfi@2000ms`（tag
  `exp-20261002123631`）**7 胜 1 和 4 负（62.5% / 不败率 66.7%，执黑 4-0-2 / 执白 3-1-2，平均 60 手）**，
  并首次出现 225 手满盘和棋，`tac_ms` 中位 257 / 均值 815 / 最坏 5362 ms、占单步均值 54.0%。
  ⇒ 500 ms 档的逐版上升曲线（25% → 67% → 75~83% → 100%）**抬档后回落**（83.3% → 62.5%）；
  `vctDefense` 两轮各命中 1 次（1 s 轮给了点没走、2 s 轮实走就是它且链被拆掉），但**三轮累计真救 0**、
  拆不掉 9 + 14 手逐条都是「全盘没有拆点」、**六局负局全程「我方有杀 0」** ⇒ 继续加深搜索不是出路
  （也不符合「战术层不吃搜索」），下一版的杠杆是压力闸门（对手造四点数压过我们时别抢自己的活三）。
- **战术层耗时单独记账（`tac_ms` / `tac_avg_ms` / `tac_max_ms`）**：`game_moves.ms` 记的是
  **「战术 + 上游」总耗时**（`src/core/jev/client.ts` 的 `t0` 在 `computeTactics` 之前），
  所以「这层保险到底贵不贵」在此之前**没有数据可答**。现在把两个计时点单独累加成本手战术层耗时：
  `computeTactics(...)`（VCF / VCT / 活三事实）与 `pickSafestParry` 的 3-ply 安全排序
  （`allowsSustainedAttack` + `countForcingReplies`，多危险点时是本层最大一块）。
  链路：源 meta `tacticsMs` → 归档短键 `ai.tacMs` → 每手 `game_moves.tac_ms`
  → 每局 `games.tac_avg_ms` / `tac_max_ms`（`aiGameMeta().tacticsMs = {avg,max,n}`，只统计有值的手）。
  **Rapfi / mock 记 null 而不是 0**：这两个渠道刻意不过战术层（保持「Rapfi vs Jev」变量纯净），
  记 0 会把混合对局的平均值拉低、看起来像战术层变快了；记 null 后 `AVG(tac_ms)` 自动把它们排除在样本外，
  而 `COUNT(tac_ms)` 与 `COUNT(*)` 的差又能看出覆盖了多少手。实验报告面板据此多一列「战术」
  （按手加权、无样本显示 `—`），轮次注脚写「战术层均值 Xms」，决策卡与趋势图也显示本手战术耗时。
  迁移是**追加**的 [`migrations/0002_tactics_timing.sql`](migrations/0002_tactics_timing.sql)
  （0001 已上 remote 不得改），三列都可为 NULL，历史棋谱与 Rapfi/mock 侧保持 NULL。
- **战术 v11 `v11-vct`「连续威胁搜索」（十二级保险）**：把「活三」从**启发式落点**升级为**逼迫手搜索**。
  v10 的 `live3Attack` 只看「落子后盘面上有 ≥2 个活四制造点」，既不区分这些点是不是本手新造的、
  也不追问这一手是否已经进了一条强制胜链。拿 v10 臂 12 局逐手离线复算（独立实现交叉核对）得到的口径是：
  7-ply 纯冲四（VCF）看得见 **22 手**必杀，加深度到 11 ply **也只多 2 手**，而把活三当逼迫手纳入搜索
  （VCT）看得见 **42 手**，其中 **20 手分布在 7 局里是纯 VCF 完全看不见的**（18 手连 11 ply 也看不见）；
  这 20 手实走几乎全是 `live3Attack` 的启发式点，7 局里包含 **2 局 225 手满盘和棋与 1 局败局**。
  引擎新增可选方法 `vctWin(st, attackerId, maxPlies, opts)`：攻击方着法 = 冲四 ∪ **本手新造 ≥2 个
  活四制造点**的活三；守方按逼迫类型**精确**枚举应手（≥2 成五点直接判胜、单成五点唯一应手、
  活三要求「守方当下没有造冲四的着法」并枚举全部 `vctDefusers`），黑方禁手点不算应手。
  战术层新增事实 `vct_win_you`，接管链在 `vcfAttack` 与 `vcfDefense` 之间插入 `vctAttack` 成为**十二级**。
  搜索预算按 586 个真实回合标定为 `VCT_MOVES_MAX = 10` / `VCT_NODE_LIMIT = 3000` /
  `VCT_DEFUSERS_MAX = 6`（与初版 `14/6000/∞` 看见同样 55 手必胜链，平均 607→422ms、p90 2430→1636ms、
  最坏 8837→4506ms；三个上限都只会「少看见」、不会谎报必胜）。
  设计取舍、代价与不做什么见 [ADR-0015](docs/adr/0015-vct-continuous-threats.md)。
  **对照实验（2026-10-02，`rapfi@500ms`，单臂 12 局，黑白交替）**：`v11-vct` **10 胜 0 和 2 负（得分率 83%，
  执黑 5 胜 1 负 / 执白 5 胜 1 负）**，同条件 `v10-live3` 6 胜 4 和 2 负（67%）、`v9-vcf-sound` 3 胜 9 负（25%）；
  `vctAttack` 单层 12 局接管 **62 手**（v10 臂上此层不存在），v10 的活三两层由 168 手降到 28 手；
  **12 局零和棋、平均手数 34**（v10 臂 98、v9 臂 55）⇒ v10 的 4 局满盘和棋被转成了胜局
  （登记表 `v11-vct.gamesVerified` 当时记 12，两轮合计后为 **24**）。逐手事后复盘：206 个回合里 87 手存在必胜链、84 手走了链首步，
  3 手让给更高优先级的 `open4` / `vcfAttack`（同为强制胜，机会没丢）。
  **同门直连对照（2026-10-02，两侧同渠道同模型，唯一变量是战术档，12 局）**：`v11-vct` **5 胜 4 和 3 负**
  （得分率 58.3% · **不败率 75.0%**；执黑 3 胜 3 和 0 负 / 执白 2 胜 1 和 3 负），`v10-live3` 3 胜 4 和 5 负
  （41.7% · 不败率 58.3%；执黑 3 胜 1 和 2 负 / **执白 0 胜 3 和 3 负**）—— 两侧执黑战绩相同，净胜来自**白方**。
  4 局和棋全是 225 手满盘（同门互攻不穿），而 v11 的胜局都短（19–56 手）；对照本轮打 Rapfi 的**零和棋**可见
  和棋率由对手强度决定。逐手接管两侧各约 600 手，`parry4` 合计 **160 手** ⇒ 被动挨打多于主动起链，
  下一版入口在「无强制胜时的防守与长线取势」。证据 `.work/duel-v10-vs-v11.mjs`（按战术档分侧出报告）。
  **计时轮（2026-10-02，`tac_ms` 上线后首轮，再打一次 `rapfi@500ms`）**：`v11-vct` **9 胜 0 和 3 负**
  （得分率 = 不败率 **75.0%**，12 局零和棋、平均 29 手）；**成本第一次被拆开**——347 手里 v11 侧 175 手有样本，
  `game_moves.ms` 均值 8730 ms（最坏 43423 ms）中战术层 `tac_ms` 均值 **402 ms** / 最坏 4474 ms，
  **约占单步墙钟 4.6%**，其余是模型往返与重试等待；对手 Rapfi 的固定预算是 **500 ms/手** ⇒
  v11 的棋力增量不是靠更大的搜索预算换来的。逐手复盘 175 个回合：72 手（41%）存在必胜链、69 手走了链首步、
  机会真丢 0 手，**3 局负局全程 0 次报出必胜链**（登记表 `v11-vct.gamesVerified` 12 → **24**）。
- **战术 v10 `v10-live3`「深活三攻防」（十一级保险）**：把「活三」从**形状匹配**升级为**真推演**。
  旧标签体系（`src/core/engines/gomoku.ts` 的 `liveThreeDir`）只认连续 `_XXX_`——跳活三、斜线组合与带空隙的四
  一律认不出（`deny:live3` 标签恒空），而 2-ply 的 `danger_points_opponent` 只认「一步成五」；
  27 局 Rapfi 复盘的实测口径是：**只有 2 局**死于 7-ply VCF，而 **27/27 局**都出现过对手能造活三的局面，
  v9 拆 13 次、漏 14 次，漏掉的 12 局全是执白第 6 手放行反对角线活三（该局面四个关键点标签全是 `null`，
  旧机制确实无信息可用）。新机制用与 `fiveCompletions` 同一把尺分三级推演：**L1 五点**（落子即五连）/
  **L2 活四制造点**（落子后有 ≥2 个成五点，2 手内必胜）/ **L3 活三制造点**（落子后有 ≥2 个 L2，4 手内必胜）。
  引擎新增可选方法 `live3Makers(st, sideId)` 与 `live3Deny(st, sideId, cands)`，战术层新增事实
  `live3_you` / `live3_opponent` / `live3_deny_points`，接管链在 `vcfDefense` 之后插入
  `live3Attack`（抢己方 L3）/ `live3Defense`（拆掉对手全部 L3 制造点）成为**十一级**；
  两级都**只在 `danger_points_opponent` 为空时才动**（对手有 2 手剑时抢 4 手剑会输速度，让给 `parry`）。
  设计取舍、代价与不做什么见 [ADR-0014](docs/adr/0014-live3-real-lookahead.md)。
  **对照实验（Rapfi 500ms，两臂各 12 局，黑白交替）**：`v10-live3` **6 胜 4 和 2 负（得分率 67%，执白 0 负）**，
  同条件 `v9-vcf-sound` **3 胜 9 负（25%）**；live3 两层在 v10 的 12 局里接管 168 手（抢攻 120 / 拆点 48），
  v9 同批对手一次都没触发（它没有这一层）。平均手数 55 → 98，但 12 局里有 4 局是 225 手满盘和棋
  ⇒ 防守补上了、胜势还转不成胜（登记表 `v10-live3.gamesVerified = 12`，`v9.gamesVerified` 相应 4 → 16）。
- **归档面板分页**：首屏一页 50 份，底部「加载更多」按服务端 keyset 游标（`GET /api/games?cursor=…`）追加下一页，
  两页合并重画（新旧局并进同一个战术版本组）；翻完自动收掉按钮，取下一页失败时保留已载入的行并让按钮恢复可点。
- **实验报告的分桶对比**：累计区从「Jev 渠道 / 其他」两个桶改成按「渠道 · 战术版本 · 思考深度」分身份统计
  （局 / 胜 / 和 / 得分率 + 胜率条），**两侧同渠道时不再并成一桶**；得分率按和棋半分计算（`(胜 + 和 ÷ 2) ÷ 局`），
  重复局不计；每轮卡片另给一条 A/B 单轮得分率条。`#expReportNote` 的口径同步改为「N 轮实验 · M 局有效」。
- **报告顶部的「最新棋谱」**：实验报告面板在轮次卡之上列出**归档里最新的 10 局**（新 → 旧）——
  以前只有挂了 `experiment` tag 的局才进得了轮次卡，最新一批机机对局（如 `jev-v9-vs-jev-v9`）看不见。
  每行给时间 / 棋种 / 手数 / 双方归因（渠道 · 战术版本 · 思考深度）/ 结果 / 可选 `tag#局号`，
  右侧「回放」直接送进回放器面板；boot、归档「刷新」、每轮实验结束三处都会重取。
- `npm run smoke:browser` 断言扩到 **14 项**：新增「对手也落了子（AI 走子链路）」「归档分页游标追加」
  「实验报告分桶表」「最新棋谱一键回放」「服务端战报并入」（`--offline` 下三项在线断言让位给 2 项降级断言，共 13 项）。

- **`jev` 档限流可配**：新增 `vars.JEV_RATE_LIMIT_PER_MIN`（生产 60），默认仍是 30。理由见下条修复：30/分 会被产品
  自带的机机对局与对比实验在一个 60 秒窗口内顶穿；60×1440 ≈ 8.6 万次仍在免费额度（10 万行写/日）之内。
- **`node scripts/experiment-run.mjs`**：用干净 profile 的真浏览器跑一轮 A/B 对比实验并留 JSON 证据——
  填渠道与 key（只从 `JEV_API_KEY` 读）、点「开始实验」、轮询心跳（局数 / 上游调用次数与 **HTTP 状态序列** /
  token），结束后回查 `GET /api/games?tag=` 确认每局都进了 D1；页面停在「等人工重试」时代点 `#retryBtn` 并计数。

### 修复

- **远端批量的数据卫生（2026-10-03 收口批）**：`scripts/experiment-worker.mjs` 的两个 POST
  （`/api/games`、`/api/experiments`）现在都带 `X-Device-Id: ssh-batch`（可用 `BATCH_DEVICE_ID` 覆盖），
  并把提交自报进 `meta.code`（`dev+nogit+<sha>`，`codeOf()` 缓存 `repoHead()`）——
  此前远端轮次落库是 `code_version = dev+nogit`、`device_id` 为 NULL，D1 里认不出是哪一版、哪台机器跑的，
  只能按 tag 认。修完可按 `device_id='ssh-batch'` 或 `code_version LIKE 'dev+nogit+%'` 一条 SQL 筛出。
  限流键是 `kind:IP` 而非设备，加这个头不改限流行为。已跑过的 26 局保持原状（只能按 tag 认）。
  `test/scripts/experiment-entry.spec.mjs` 加设备 id 值域断言（`scripts` project 44 → 45 例）。
- **AI-AI 轮的固定思考档从来没落库**（2026-10-03 写实验报告时发现）：对比实验的每一局，
  `games.black_think` / `white_think` 都是 NULL——棋局 payload 里压根没有这两个键（`buildGameExport()`
  只写渠道与战术档），只有轮次表的 `think_a` / `think_b` 有值 ⇒ 报告的「成本对照」只能回头翻
  `.work/exp-arm*.json` 的 `config.thinkB`。修法：导出时按侧写固定档，**只认 `rapfi` 且预算 > 0**
  （`thinkMsOf()`；`proxy` 的「思考时间」是模型往返、人类侧没有预算，留 NULL——写 0 会在报表里变成
  「0 毫秒档」这种不存在的身份，与下面那类幻影身份同源），取值优先轮次快照
  `expInfo.blackThink/whiteThink`、回落侧配置 `sideConfig.*.rapfiThinkMs`。新增
  `test/core/record.spec.ts` 用例（rapfi 侧落值 / proxy 侧缺省），口径写进
  [docs/architecture.md](docs/architecture.md) §4 与 [docs/agents/playbooks.md](docs/agents/playbooks.md) §7。
- **`smoke:browser` 会「打错靶」且分桶表断言过时**（2026-10-02 实战踩到）：缺省目标 `http://localhost:8787/`
  在本机被**别的应用**占着，脚本照样开页面、拿标题断言通过，其余页签全查不到 ⇒ **2/13**，失败项全是 `no-*`
  标识，极易被误读成产品回归。另：`tac_ms` 上线后分桶表每行多了「战术」格（Rapfi 侧显示 `—`，共 4 格），
  而断言仍按 `=== 3` 数格子 ⇒ 线上真跑时红一项。修法（只动工具链）：①开跑前**目标自证** ——
  `fetch(new URL('api/health', URL_TARGET))` 必须返回 `service === 'jev-qiguan-worker'`，否则直接 `exit 1`
  并提示用 `--url` 指到正确部署；②断言改 `nums.length >= 3`，且要求表里**至少有一个 Jev 身份行**
  （防止「只剩 Rapfi 一行」被判通过），行标签一并收进返回值。修后 `--url https://jevqipan.logicc.top` **14/14**
  （首行输出 `目标自证：jev-qiguan-worker 1.0.0 · schema 0002_tactics_timing.sql`）。
- **归档给「不过战术层的渠道」也写了战术档标签**（计时轮暴露，与下一条同源但更深一层）：
  Rapfi / mock / 人类侧压根不进 `computeTactics`（`src/core/jev/client.ts` 在 `channel === 'rapfi'` 处短路），
  归档里的 `black_tactics` / `white_tactics` 却照抄 A/B 配置 ⇒ `black_channel='rapfi'` 的行带着
  `v9-vcf-sound` 这种**惰性标签**（`scripts/experiment-run.mjs` 的 `tacB` 旧默认值），
  报表按「渠道|战术|思考」分组时冒出 `rapfi|v9-vcf-sound|500` 这种并不存在的身份。
  修法：`src/core/view/duel.ts` 新增 `runsTactics()`（human / mock / rapfi ⇒ false）与
  `tacticsLabel()`（不过战术层 ⇒ 空串，经 `strOrNull()` 落 NULL）；`src/core/record/export.ts`
  按**每侧真实渠道**（`bChan`/`wChan`，实验轮取 `exp.blackChannel`/`whiteChannel`）过滤档位；
  `src/ui/panels/experiment-report.ts` 与 `src/ui/panels/options.ts` 以渠道优先判身份
  （Rapfi 仍显示 `Rapfi(0.5s)`，只是不再带档位）；`experiment-run.mjs` 的 `tacB` 默认值改 `CURRENT`
  并在日志里打出真实生效标签。只动工具链与归档语义，**未碰搜索**。
  测试：`test/core/record.spec.ts` 与 `test/ui/experiment-report.spec.ts` 各 1 例钉住
  （身份键只能是 `['proxy|v11-vct|0', 'rapfi||500']`），`src/core/view/duel.ts` 的 `selfTest()` 补 6 条断言。
- **实验报告把 B 侧的战术档安到 A 侧身上**（写战术层耗时用例时才暴露）：`src/ui/panels/experiment-report.ts`
  的 `gameSide()` 在局内字段缺失时一律用轮级 `tacA` 兜底黑方，而 **A 只在奇数局执黑** ——
  于是 B 执黑的那些局（例如 A=Jev、B=Rapfi）会给 Rapfi 安上 A 的战术版本，分桶表里冒出
  `rapfi|v11-vct|0` 这种并不存在的身份，把本来该并成一行的手数拆成两行。
  修法：先按局号奇偶算 `const aIsBlack = ((g.no || 1) - 1) % 2 === 0; const isA = (side === 'black') === aIsBlack;`
  再按 `isA` 取 `chan / tac / think` 兜底；`test/ui/experiment-report.spec.ts` 的战术层用例
  断言「只出现两个身份」把它钉住（修前该用例红在均值被拆成 50ms）。
- **战术层看不见「带空隙的活三」**（根因与修法见上条 v10）：`labelPoint` 打出的 `you:live3` / `deny:live3`
  只覆盖连续 `_XXX_`，于是 `parry3` 层对跳活三、斜线组合与带空隙的四从不触发，`danger_points_opponent`
  又只到 2 手——对手「活三 → 活四」的 4 手杀路上没有任何保险层。现在由 `live3Attack` / `live3Defense`
  两级真推演兜住（`parry3` 保留：标签命中时它仍然更快）。`test/engines/tactics.test.mjs` 新增 5 例
  （引擎层推演、战术事实、决策级接管、抢攻、对手有 2 手杀时让位），`test/engines/util.test.mjs` 与
  `src/core/view/duel.ts` 的联名断言改为从登记表派生，不再写死 `Jev·v9`。
- **自家限流把整轮对比实验挡死在第 1 局**：`jev` 档 30 次/分/IP，而机机对局一个窗口能打到 34 次；
  客户端旧写法只做 4 次尝试（1+2+4 秒）熬不过 60 秒窗口，**且限流分支从不给 `lastErr` 赋值**，
  于是抛出的文案是「重试次数用尽」——真实原因（被自己限流）在界面上完全看不出来；机机对局又没人点「重试」，
  整轮实验就此报废。现在分两层：
  `src/core/jev/client.ts` 的 `callWithRetry` 把限流独立计数（5 次、按 `Retry-After` 退避、截 20 秒），
  每次失败都留带状态码的错误并打 `retryable` 标记；`src/app/loop.ts` 的 `aiStep` 只对 `retryable` 自动退避重试
  （4s / 12s / 25s 三次，期间**不暂停**），成功 / 手动重试 / 重开一局都清零额度。
  `test/core/jev-retry.spec.ts` 5 例 + `test/app/ai-auto-retry.spec.ts` 2 例钉住（含三组负向对照）。
  **2026-10-02 补一条同类自欺**：台账基线可能在**服务端合并落地之前**读到，于是本轮的新 tag 会被误判成旧轮次
  （v11 首跑把 `exp-20261001182552` 当成了本轮）；判本轮只认「基线之外的新 tag」，并且必须与
  `GET /api/games?tag=` 的归档行数对上。
- **实验运行脚本会自欺**：计量器只认绝对路径 `/api/jev`，而代理端点是相对串 `api/jev` → 永远报「上游 0 次」，
  恰好藏起唯一的证据；失败时台账 `history[0]` 是上一轮的 tag → 归档核对拿旧数据当本轮成绩。
  现在两种写法都认并记录状态码序列；开跑前记台账基线，跑完只认新增条目，没跑满就跳过归档核对。
- **`smoke:live` 把数据总量写死在断言里**：`stats.byGame` 等于 `{"五子棋":54}`、实验恰好 6 轮、
  写入后 `totalGames` 等于 55 —— D1 是活的，真实验一多这三项就红（2026-10-01 真跑 4 局后实测 27/30）。
  现在一律**相对基线**：`byGame` 只校验键都是七个中文棋种名且「五子棋」在册，轮次断言「≥ 6 且每轮有 tag」，
  写入后断言「跑前基线 + 1」（实测 `58 → 59`）。
- **服务端实验战报从来没并进报告面板**：Worker 的 `GET /api/experiments` 返回包装体 `{experiments:[…]}`，
  而装配层按「客户端已解包」判断 → 静默丢弃，生产 D1 里 6 轮实验在面板上永远只显示本机种子的 2 轮。
  现在 `src/core/api/client.ts` 的 `listExperiments()` 统一解包（兼容裸数组），`test/app/experiments-merge.spec.ts` 3 例 +
  浏览器冒烟第 12 项钉住它。
- `scripts/browser-smoke.mjs` 收尾清理临时 Chrome profile 在 Windows 上偶发 `EPERM`，
  会把一次绿跑变成「无报告的崩溃 + exit 1」；现在起手清理与收尾删除都带重试，失败只提示、不影响检查结果。
- **长跑实验被 Rapfi 的 10 MB 引擎资产卡死**（`3bf480b`）：12 局对照实验第一次跑到 **0/12** 原地不动 486 s，
  报告里只有 `meter.calls = 1` 和一句 `TypeError: network error`；同一时间 `smoke:browser --channel rapfi`
  也停在「对手也落了子」的等待上（13/14）。取证：生产域 `rapfi-single-simd128.wasm` 1,161,393 B / 14.7 s、
  `rapfi-single-simd128.data` **10,037,111 B / 447.7 s**（≈22 KB/s），而 Rapfi 是**局中首次用到才实例化**，
  Emscripten 抓这两个文件失败时抛的 rejection 在装配层没人接住 ⇒ `inflight` 永久占位、AI 循环再也不走子
  （主线程有响应、CDP 心跳每 30 s 正常 ⇒ 不是搜索算得慢）。修法**只动工具链**：`scripts/browser-smoke.mjs`
  与 `scripts/experiment-run.mjs` 用 CDP `Fetch` 域把页面发出的 `/rapfi/*` 改由本地 `public/rapfi/` 的同一份文件
  `Fetch.fulfillRequest` 答复（base64，按扩展名给 `application/wasm` 等 Content-Type，`--no-rapfi-local` 可关），
  字节与线上同源同内容、**被测行为不变**。修后 `smoke:browser --channel rapfi` **14/14**、12 局实验跑满。
  **应用侧未加保护**：慢链路上「局中现抓 10.7 MB 资产」的失败模式仍在（见 [status.md](docs/status.md)「仍存在」第 5 条）。

### 文档与约定

- **战术 v14 证据评审：负结论与对照复算立项**（2026-10-03）：v13 的 A/B 判定「输在赢不了」之后，
  16 个离线探针（只重放 tag `exp-20261002160819` 的归档，无新对局）把进攻侧的假设筛了一遍，
  本次审查又补了两个对照实验，结论落成
  [docs/plans/2026-10-03-tactics-v14-evidence.md](docs/plans/2026-10-03-tactics-v14-evidence.md)。
  **稳健负结论**：负局全程没有强制胜链（放宽预算后 111 个回合仍 100% 无链，放宽档耗时均值反而
  2093 ms）、不是漏防（必挡点漏防 0/15）、不是漏杀（漏杀 2 手全在终局实走 `win`）、不是送活三
  （负局 0.0%，抢活三被拆率胜 43.8% > 负 20.0%）、不是赛跑口径（两侧 0.0%）。
  **两个候选被否**：`maxRun`「织网 / 连+1」被自己的准入判据否掉（负局占比 25.4% **低于**胜局 54.9%，
  方向与假设相反）；「抢活三前先验对手应手」（探针 `live3-counter`，负 47.1% vs 胜 18.5%）被两个独立
  对照否掉 —— `.work/review-v14-control.mjs` 显示 16 个「必带链」负局回合里**根局面（我们未落子）
  对手就已有链 = 16/16**，且这 16 手实走全是防守层（`vcfDefense` 12 / `pressureGate` 2 / `parry` 1 /
  `vctDefense` 1，**没有一手抢活三**）；`.work/review-live3-gift.mjs` 对实走的 29 手活三算三基线
  （根局面 / 落子后 / 对手应手后抽样 8）**出现链 0/29** ⇒ 「抢活三 = 送链」在这轮一次都没发生。
  **口径纪律**：`v14-shape-probe` 的「316/222 回合」是双方手数，与其他探针的 Jev 回合（胜 158 / 负 111）
  不可互引；负局只有 3 局，任何「负 vs 胜」比例都是这 3 局的副本。
  同步修掉的登记/文档缺口：v13 登记项 `gamesVerified: 12` + note 补 A/B 段、`docs/README.md` 的
  v13 行转 ✅ 并补 0017 与本篇、ADR-0017 §5 成本改 3.2/3.3/6.1 ms 且第 5 条转「已完成」、
  `docs/status.md` 数据现状改 169 局 / 11310 手 / 18 轮并补 `v13-pressure-gate` 分组与第 28 条判定。
- **两条方向约束写进最显著之处**（`cbcc371`）：项目所有者 2026-10-02 定下 —— **①不吃搜索**（能一眼看清的
  简单规则、快而不依赖长思考的才做；往深搜 / 强评估函数靠的不做，已有搜索层只做减法或纠偏）、
  **②不唯胜率**（胜 / 和 / 负一起报，不败率与败局质量同等重要；和棋可以接受、有时应该追求，
  「负局不增加」优先于「多赢一局」）。落点：[AGENTS.md](AGENTS.md) §2 硬性规则 10–11、[README.md](README.md) 首节、
  [docs/memory/MEMORY.md](docs/memory/MEMORY.md) 顶部置顶约束块、[docs/agents/playbooks.md](docs/agents/playbooks.md) §0；
  长跑实验的固定规程补在 playbooks §7。

## [1.0.0] — 2026-10-01

### Worker + D1 全面重构（架构轮，ADR-0010 ～ ADR-0013）

一次性把「原生 HTML/JS + 三套后端 + GitHub 当数据库」换成
**一个 Cloudflare Worker（Static Assets + Hono API）+ D1**。计划与逐阶段执行记录见
[docs/plans/2026-10-01-workers-d1-rebuild.md](docs/plans/2026-10-01-workers-d1-rebuild.md)。

- **后端合并**：`server.js`、`functions/api/*.js`、`dev-proxy.py` 三套实现退役，统一为
  `src/worker/**`（8 条路由：health / games / stats / experiments / openings / leaderboard /
  jev / export）。本地开发只剩 `npm run dev`（Vite + Worker 插件，D1 走本地 SQLite）。
  线上入口 `https://jevqipan.logicc.top`（自定义域；`workers.dev` 未开）。
- **持久化迁 D1**：`games` / `game_moves` / `experiments` / `devices` / `rate_limits` /
  `stats_cache` 六张表 + `d1_migrations`。仓库里 54 份历史棋谱（4379 手、0.81 MB）
  经 `npm run import:archive` 一次性导入，`payload` 逐字节保真（`verify:parity` 逐局 sha1 对账
  diff = 0），此后 D1 是唯一权威，`games/` 冻结只读。
  `games.gid` 历来是**棋种 id**（54 份全是 `gomoku`），新模型引入 `game_uid` 作对局身份，
  `dedup_key = sha1(exported|gameUid|notation)` 保证重传幂等。
- **统计口径修好**：旧 `/api/stats` 受 Pages 50 子请求限制只聚合最近 40 份并返回
  `truncated`；现在全部在 SQL 侧聚合，**全量且无截断**（对账：40 份截断口径 16/16/8 vs
  全量 18/27/9）。列棋谱不再硬编码最近 7 天（keyset 游标 + `since`/`day`/`game`/`device`/`tag` 过滤）。
- **身份与限流**：匿名 `X-Device-Id`（无登录）落 `devices` 表，写路由先 `touchDevice` 满足外键；
  限流从「isolate 内存 Map」（跨实例必然失效）改为 D1 固定窗口（jev 30 / 写 20 / 读 120 每分钟）。
  每局从「一次 git commit」变成一次 `INSERT`。
- **前端迁 Vite + TypeScript**（无 UI 框架）：`src/core`（引擎/战术/会话/持久化/归档，纯逻辑）、
  `src/ui`（棋盘渲染、图表、13 个面板）、`src/app`（装配层：对局循环、渠道、实验编排）、
  `src/worker`。版本号构建期注入（`package.json` version + `git rev-parse --short HEAD`），
  归因不再靠文件名时间窗猜（那套口径会给 28 局凭空造出档位，已退役）。
- **新增能力**：棋谱回放器（`/api/games/u/<gameUid>` 永久链接 + 分享）、排行榜
  （`/api/leaderboard`）、开具体验（`/api/openings`）、JSONL 全量导出（`/api/export/games`）、
  每日维护 Cron（`17 3 * * *`：清限流表 + 写 `stats_cache` 当日汇总）、
  `/api/health` 的当日写入护栏（`today.rows` / `rowBudget`）。
- **运维**：`.github/workflows/backup.yml` 每日 `23 4 * * *` 导出 D1 快照为 artifact（保留 30 天）
  并用 `verify:backup` 校验可重建；`.github/workflows/test.yml` 跑 typecheck + build + 三层测试。
  `docs/status.md`、`docs/architecture.md` 等文档全量重写。
- **验收工具**（都可重复跑）：`npm run verify:parity`（新旧口径逐项对账）、
  `npm run smoke:live`（线上 HTTP 30 项）、`npm run smoke:browser`（真 Chrome + CDP 9 项，
  `--offline` 时 11 项，验无后端降级）、`npm test`（引擎自检 + 金样逐手差分 + 旧契约 + vitest）。
- **已知行为差异**：引擎不建模「认输」，1 局归档记「黑方获胜（认输）」而引擎判 `null`（预期，
  见 `test/parity/exceptions.json` 与 `test/engines/run.mjs` 输出）。

### 实验报告面板（战报补齐 + 同渠道 A/B 归属修正）

- **补齐实验战报归档**：`games/` 里带 `experiment` 标签的 6 轮实验，`data/experiments.json`
  只归档了 2 轮——其余 4 轮只有棋谱（其中 2 轮仅靠 `app.js` 里写死的 `EXP_SEED` 才在
  「实验报告」面板露面，另 2 轮完全不显示）。由棋谱回溯补齐 4 轮，归档 2 轮 → **6 轮**；
  `EXP_SEED` 的两条复盘 note 一并搬进归档，`EXP_SEED` 退回纯离线兜底。
  回溯时按「着法串与更早一局完全相同」自动标 `dup`（`exp-20260929105234` 的 #1=#3）。
- **修复：同渠道 A/B 的胜负全被记成 A**。`finishGame` 原来按渠道名比对判定 A/B
  （`winnerChan === EXP.chanA`），而 `Jev·v8 vs Jev·v9` 这类对照两边都是 `proxy`，
  于是任何胜负都落入 A。改为按「胜方是黑是白」+ 局号奇偶判定（`expGameNo=1` 时 A 执黑）。
- **报告卡片可读性**：显示轮级 A/B 档位联名与 **tag**（tag 是与 `games/` 棋谱互查的唯一锚，
  此前不显示）；老战报缺 `tacA/tacB` 时退到首局棋谱的档位；胜方标签取「该局胜方所执那一侧」
  的配置，同渠道 A/B 才读得出 `Jev·v9 胜` 而不是读不出胜负的 `Jev(代理)胜`。
- **修复：服务端归档丢掉档位字段**。`server.js` 与 `functions/api/experiments.js` 的 POST
  归一化只保留 `tag/date/chanA/chanB/total/games/note`，把客户端发的 `tacA/tacB/thinkA/thinkB`
  丢了 → 归档后的战报读不出跑的是哪一版。现已保留（`undefined` 省略，旧客户端形状不变）。
- **新增自检组 `experimentArchiveTests`**：每个 `experiment` 标签都必须有战报、局数一致、
  逐局 A/B 归属与棋谱结果一致、轮级 A/B 配置等于首局棋谱、`dup` 必须标出。

### 实验归因（pull 后全量盘点修正，ADR-0009 修订）

- **修复：人机/双人局被写成机机镜像局**。`duel.sideLabel/sideSlug` 一直支持 `human`
  标记（输出「我 / me」），但棋谱导出与战绩簿直接取 `effSide()`（纯渠道配置），
  于是 `mode=人机` 的局落成 `jev-v0-vs-jev-v0` / `黑 Jev·v0 vs 白 Jev·v0`，
  而这批 slug 正是「按战术版本归因」的输入。实测 3 份真棋谱受污染。
  新增 `exportSideCfg(sideId)`（按 `isAISide` 判定，人类侧补 `human:true`），
  导出与战绩簿共用；人机局现落 `me-vs-jev-v0`，双人局落 `me-vs-me`，真机机局不变。
- **新增：`gamesVerified` 与窗口局数 `games` 双口径**。版本归组只看文件名 stamp 时间窗，
  线上部署滞后时会说谎——20 份 `meta.code=0.7.0` 的棋谱（实为 v7 档）stamp 落在 v9 窗口，
  导致 `v9.games=20` 被当成「v9 战绩」。现拆为 `games`（窗口归属）+
  `gamesVerified`（每手 `ai.tv`/`meta.code` 实证）：v7 是 4/20、v9 是 26/4。
  战术沿革条两个数恒同时显示（`窗口 26 · 实证 4`），不做「相等就合并」的化简——
  v8 的窗口 3 局与实证 3 局数量相同却是两批棋。
- **新增：`DEPLOY_LAG` 台账 + `auditCode()` 归因红线**。纯函数审计「窗口归属 vs 实际
  code」，按 stamp 分流历史债与回归；`archiveAttributionTests` 对真实 `games/` 断言
  「0 条未登记错配 + 台账条数相符」。此前当前档只断言 `games >= 登记数`，这类污染抓不到
  （已验证：注入一份伪造滞后棋谱 → 自检红）。
- **新增：`endBy` 终局裁决来源**。「认输」唯一入口是人点按钮，机机实验里这属于人判；
  棋谱现落 `endBy:'human'`，战绩簿与实验报告标「人判」，不再混进引擎版本胜率。
- 修正 `js/tactics-versions.js` 过期注释（「合计应等于 games/ 全部 28 局」；实为 54）。

### Jev 强度

- **vcfWin 伪胜（soundness）修复**：攻方造四后守方被迫堵的那一手可能顺手给守方自己造出四，
  守方下一手直接成五——此时攻方后面的双杀永远兑现不了，旧引擎却判攻方必胜
  （`search()` 在双杀处直接返回胜，从不检查守方状态）。搜索新增守方反杀闸门：
  守方有即时致胜点时攻方这一手必须占掉它（活四两端 = 2 个反杀点则一步占不完，无解）。
  4 局棋谱 190 个决策点回放：伪胜 2→0，7 条有效链全部保留，耗时零增长。
  **同时撤回 ADR-0007 的「守方反击造杀属 VCT 范畴，不覆盖」论断**（ADR-0008）。
  这修正了此前把 `20260930025550` 局失利记为「VCT 范畴」的错误归因——那是 A 类实现 bug。

- **parry3 预挡层（实战败局驱动）**：导出败局复盘定位败着（第 20 手自由手未抢 E7 活三点），
  战术保险加第四级——无即时战术时抢占对手的活三/活四制造点（deny:open4/live3 标签），
  「对手造不成活三」成为机械保证；回归用例 ⑨d 钉住本局。
- **战术保险扩展到 2-ply（造杀/拆杀）**：引擎声明 `deepTactics` 后，1-ply 无战术时扫描
  「走出后己方有 ≥2 个一步致胜点」的造杀点（chance_points_you，护栏：对方不能反手成五）与
  对方造杀点（danger_points_opponent，必须现在拆）；保险优先级 win > block > open4 > threat > parry，
  决策卡片标「保险·造杀/拆杀」。源自用户实战复盘：开放三连不拆、双杀成形即败。
- **五子棋 criteria 战术标签 + 第三级接管**：引擎真实推演给每个候选点打战术标签（you:open4/four/live3、
  deny:*、block:five，组合 + 连接），模型从「发现模式」降为「比较标签」；活四点 + 对方无先手五
  = 理论必胜，战术保险扩为三级接管（决策流标「保险·活四」）。真实 API 实测走出必胜的 I8。
- **五子棋提示词四板斧**：`state.board_ascii` 裁剪字符棋盘（模型读字符画远比坐标列表准）、
  move 指令改为五步刚性扫描清单、防幻觉逐格核对；analysis 文本问实测不被 API 支持（400），
  按 fallback 折叠进指令。真实 API 验证：四连局面致胜点概率 0.87/0.11。
- **规则摘要进 state**：六引擎 `state.rules` 每手携带 2 句英文规则摘要（胜负条件 + 本项目口径的
  特殊规则/参数），契约测试断言必填。
- **战术事实注入 + 战术保险**：客户端推算双方「一步致胜点」注入局面（`state.tactics`），
  指令同步声明语义；解析概率后致胜必走、对方致胜必挡（决策流标注「保险·致胜/拦截」）。
  真实 API 实测：注入后模型把致胜点概率打到 0.91/0.09。
- **对局经验累计**：真实渠道对局的棋谱写入战绩簿，相同开局前 4 手的历史先手胜率注入后续对局
  （`state.experience`）；样本 <2 局不注入，离线演示局从不参与。

### 前端

- **棋谱一键导出**：棋谱面板「导出」按钮下载当前对局 JSON（`jev-qiguan-game/v1`：记法序列 +
  双方每手含战术保险标记 + 结果/渠道等元数据），为后续导入回放预留格式；悔棋自动跟随，空局拦截。
  **附归因 meta**：顶层记代码版本 / topK / 种子 / AI 手数 / 成本 / token / 延迟 / 平均置信度 /
  战术保险使用直方图；每个 AI 着法记 `{ch, mdl, conf, p, rank, cands, ms}`，
  `rank` 是实走这手在模型 top-8 里的名次（1 = 模型首选）——据此可区分「模型真这么想的」
  与「被采样/战术保险改写的」。这让「把这盘输归因到哪一版代码、哪一手」成为可能。
- **侧栏折叠一屏化**：7 个分析面板可折叠收起（Jev 驾驶舱常开，首访默认展开「Jev 判断」），
  折叠状态持久化；面板密度收紧、趋势图收薄。桌面端（含浏览器 chrome）一屏放下全部分析内容；
  展开时自动补渲染，图表不会因折叠期间量宽为零而破图。

### Jev 接入

- **各渠道可自定义 Base URL**：设置面板每个真实渠道新增「接口地址」输入框，预填该渠道预设值，
  留空用预设。自定义端点不强制 key（自建网关可匿名），且不再因未填 key 回落离线演示；
  预设端点行为不变。地址按渠道分别记忆（`settings.endpoints`）。
- **「测试连接」连通性探测**：开局前一键分诊——网络不通 / 跨域(CORS)拦截 / key 无效 /
  端点不兼容六种判定直接给出原因与建议（两段式探测，`BG.jev.probe`）。
- **直连结论实测定案**：官方 API 带 CORS 来源白名单（实测仅 typesafe.ai 自有域名），
  浏览器直连不可行，「填 key 即玩」的正解是部署一次 CF Pages（自带同源代理）。
  双击 `file://` 打开时自动落离线演示，不再第一手报错；渠道提示与错误指引同步更新。

## [0.3.0] - 2026-09-29

### 前端打磨（可访问性与工艺底线）

先量再改——全部结论先变成数字，再动手：

- **修复 `--ink-mute` 小字对比度**：原 `#7C8590` 在四档底色上只有 3.32~3.74:1（未达 WCAG AA 的
  4.5:1），而它承载 22 处 9~10.5px 小字。改 `#656E79` → 最低 4.60:1。
- **修复控件边界对比度**：新增 `--line-ctl: #828FA3`（≥3:1，WCAG 1.4.11）。输入框/下拉的填充
  与面板同为白色，边框是唯一识别线索，原先只有 1.51:1。装饰性发丝线刻意保持低对比不变。
- **22 处字号低于 11px 全部提到 11px**（最低原为 9px，含图表坐标轴）。
- **修复 `.feed` 规则整条失效**：CSS 写 `.feed` 而 HTML 容器是 `<div id="feed">`，导致决策流
  没有高度上限也没有滚动条，侧栏随对局无限长。容器补上 class。
- **5 处 `transition: width/height` 改为 `transform: scaleX/scaleY`**，避免逐帧重排；
  曲线描线进度用 `pathLength="1"` 归一化，不必猜路径长度。
- **焦点环、滚动条统一主题化**（`:where()` 保持零特异度；WebKit 伪元素 + Firefox 标准属性）。
- 清理死代码：`.stats` / `.stat`、`.engine-panel.live` + `seal-breathe`（从未被触发）。

### 视觉张力（用户选定「精修 + 更有张力」）

- 收敛为一个被编排的动效时刻「**落子**」：曲线一次性描线 + 末点单次外扩，共用同一条 `--ease`。
  删掉两处无限循环装饰动画（`pulse` / `seal-breathe`）。
- 拉开排版尺度差：品牌标题 23px→27px 并收紧字距，面板标题 16px→17.5px、字距 2.5px→1.2px。
- 移除 craft-floor 拒绝项：`.cal-hero` 的 3px 彩色左边条（上一轮自己引入的）、
  用 Unicode 字形「弈」「衡」顶替图标系统（改为自绘 SVG，画的是「本该出现的曲线」与「失准」本身）。
- 两个浮层按「二选一」处理「发丝线 + 宽投影」签名：`#promoBox` 保留明确边、`#testPanel` / `#toast` 只靠投影。

### Fixed

- **`button.primary` / `.brand-mark` / `.seal` 的白字在渐变上端只有 3.87:1**（`--zhu-hi: #D95840`），
  未达 AA。改 `#C94C36` → 4.59:1。此项由 `impeccable detect` 在改动完成后抓出，原计划未覆盖：
  渐变端点上的文字无法被前景/背景配对扫描发现。

### Notes

- 三项**有意保留的例外**（含 1 项检测器误报）记录在 `docs/status.md`「设计例外」：
  装饰性发丝线刻意低对比、侧栏 11px 密集数据正文、`#promoBox` 的明确边 + 中等投影。
  改样式前先读那节，不要为了「统一」把它们一起改掉。
- `impeccable detect` 报的 `#ffffff on #ffffff 1.0:1` 是它解析不了 `linear-gradient()` 的误报；
  三处白字已逐处人工核算，真实最低对比 4.59:1。

## [0.2.0] - 2026-09-29

### Added
- **校准实验室**：把 Jev 逐手给出的胜率预测与对局真实胜负放在一起量。
  输出 Brier 分、技巧分（相对「恒猜平均胜率」的参考预报）、校准误差、最大箱偏差、
  过度自信度（平均预测 − 实际胜率），并绘制可靠性图（横轴「Jev 说的胜率」、
  纵轴「实际兑现」，落点贴对角线＝校准良好）。
- `js/calibration.js` 纯数学模块（零 DOM、可在 Node 与浏览器两端自检）；
  `index.html?test=1` 现在也会跑它的自检。
- 迭代计划文档 `docs/plans/2026-09-29-iteration-03-calibration-lab.md`

### Notes
- 校准数据只统计**真实渠道**的对局：离线演示的胜率是本地合成的，不参与统计；
  和棋局无二元真值，也不计入。样本按「局」强相关，面板同时显示局数与手数。
- 校准误差（ECE）单独看会骗人——恒猜 50% 的预测器 ECE 也是 0。
  因此面板把「技巧分」与「校准误差」并排给出。

## [0.1.1] - 2026-09-29

### Fixed
- 悔棋后 Jev 回合不再卡死：此前在 Jev 思考途中悔棋会让对局永久停摆（界面却显示「等待 Jev」）
- 终局后点悔棋，状态条不再残留「终局 · … 获胜」，暂停/单步/重试按钮同步复位

### Changed
- 决策流改为增量插入新卡片（此前每手重建最多 40 张卡，长对局下是 O(n²) 的重复渲染）
- 对局历史只保留记法而非每手全量局面快照，悔棋时按记法重放还原

### Added
- 集成对局新增「整盘记法重放等价」断言，为悔棋还原路径提供回归护栏
- 迭代计划文档 `docs/plans/2026-09-29-iteration-02-play-loop.md`

## [0.1.0] - 2026-09-28

### Added
- 六个棋种引擎：五子棋（15×15）、围棋（9×9，中国规则贴 5.5）、象棋、国际象棋、西洋跳棋、中国跳棋；统一接口 + selfTest
- 三种对弈模式：人机（可选执子）、机机（速度滑杆/暂停/单步）、人人
- Jev 接入四渠道：官方 API / OpenRouter / 同源代理 / 离线演示；429/529 指数退避；top-k 概率加权采样
- Jev 决策面板：top-3 概率条、置信度、局势判断（Noul/Score）、延迟、token 与成本累计
- CF Pages Functions BYOK 代理（functions/api/jev.js）与本地 dev-proxy.py
- 自检体系：node test/run-tests.js 与 index.html?test=1
- 文档体系：AGENTS.md、docs/（架构/引擎接口/Jev API/ADR/计划/多 agent 协同/记忆）
