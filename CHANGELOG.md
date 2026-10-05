# CHANGELOG

本项目可感知的变更历史。版本语义：1.0.0 起遵循语义化版本（minor 加功能、patch 修缺陷）；
0.x 期间 minor 反映功能交付，patch 反映修复。
日常记录另见 [docs/memory/MEMORY.md](docs/memory/MEMORY.md)（新条目置顶）。

## [Unreleased]

### 新增

- **报表 §3 再印「逐档成本（与 Rapfi 固定预算同框）」表（2026-10-05）**：`scripts/lib/report.mjs` 加
  `costByLevel(games)` / `costByLevelBlock(model)`。第 3 节原来的成本表按**身份**排，而阶梯批次里每个档位是不同轮
  ⇒ 全轮合计会把低档短局与高档长局混在一起。新块按档位切：`局数 / Jev 手数 / 模型往返与战术层（均值／中位／p90／最差）/
  单手合计均值 / 战术占单手 / 往返均值占预算`，末列 = 模型往返均值 ÷ 该档 `INFO timeout_turn <ms>`（UI 上限 10000 ms）。
  归集只收「一侧 Rapfi、另一侧版本」的对局（版本互殴无档位、Rapfi 互殴双方都是 rapfi），档位识别直接读 payload 的
  `blackChannel`/`blackThink`（`channel` 就是 `'rapfi'`，`startsWith('rapfi|')` 恒假 ⇒ 静默漏掉 Rapfi 执黑半局）；
  零上游手的档位（Rapfi vs mock）不进表。**口径边界**：Rapfi 逐手实际耗时没有落盘（`ai.ms` 为 `null`）⇒ 只能说「占预算」。
  实测 500 局：战术占单手 `@500` 29.8% → `@10000` 39.0%，往返均值占预算 **367.1% → 14.2%**。
  形状复跑：三批合并有块，`vorder1`/`l3n1`/`c2e2` 都 0 命中。`--json` 变**四块**判读结论（`+costByLevel`）。
  单测 +2 例（`test/scripts/report.spec.mjs` 累计 **51 例 / 836 行**）。
- **报表 §2 再印「逐档合并（版本视角）」表（2026-10-05）**：`scripts/lib/report.mjs` 加 `levelTable(records)` /
  `levelTableBlock(model)`。§2 曲线上每行是 `rapfi||<ms>` 自己的得分（方向易读反），这张表把同一个 Rapfi 档位的全部对局
  合成**版本侧**一个数：只收「一侧 `rapfi||<ms>`、另一侧 `official|…`」的对局（版本互殴无档位、Rapfi 互殴无版本侧，
  都不进表），每档印 `局数 / 版本侧 胜–和–负 / 得分率 / Wilson / Rapfi 侧得分率 / 对手集（逐对手局数）` + 相邻档差 +
  重叠计数 + 组成两态。**组成一致性把每对手局数一起比**（某版只跑一半局数同样带偏合并值）。与独立探针
  `.work/l4-fill.mjs` 各算一遍**逐位一致**（5 档 89.5/79.5/73.5/53.8/39.2%；相邻档差 −10.0/−6.0/−19.8/−14.6 pt
  且四对全部 Wilson 重叠）⇒ L4 报告 §3.3 以后从报表抄。`--json` 由两块判读结论变**三块**
  （`versionMatrix` / `curveComposition` / `levelTable`）。形状复跑：`l2n1` 有块，`vorder1`/`c2e2`/`l3n1` 都 0 命中。
  单测 +3 例（`test/scripts/report.spec.mjs` 累计 **49 例 / 792 行**；**n=1 时 Wilson 必然重叠** ⇒ 造「不重叠」要 10 局/档）。
- **报表 §2 曲线自动印「各档对手组成」警告（2026-10-05）**：`scripts/lib/report.mjs` 加 `curveComposition(records)`
  （逐档 `rapfi|…` 的对手集与局数、同身份镜像局不计入；`consistent = 集合去重后 ≤1`），`reportMarkdown()` 第 2 节
  在「每档样本」之后按需印「⚠ 各档对手集不同 ⇒ 档间差里混着组成差异」+ 逐档点名「N 局打过 M 个对手」。
  触发它的是 L4 实测：`@7000`（80 局）缺 `v14-live3-fresh`、`@10000`（60 局）缺 `v13`/`v14`
  ⇒ `2000 → 7000` 的 −19.8 pt 混着「少了 v14」；60 局时 `63.8% vs 64.1%` 的 0.3 pt 擦边不重叠在 80 局后翻回重叠
  ⇒ **擦边不重叠不算结论**。同批把 `versionMatrix` / `curveComposition` 两块判读结论写进 `--json`
  （markdown 只写「另有 N 对方向一致」的数量，点名读 `pairDirs`）。实测 500 局：10 对里 8 对翻转，
  仅 `v11 > v10`（五档同向）与 `v14 ≥ v13`（含一个并列档）方向一致。单测 +3 例（`test/scripts/report.spec.mjs` 累计 46 例）。
- **报表新增「版本 × 共同对手」矩阵：版本排序的第二把尺子（2026-10-05）**：`scripts/lib/report.mjs` 加
  `versionMatrix()` / `versionMatrixBlock()`，印在 §4 配对表之后、逐色格之前。行 = `official|v*` 版本，
  列 = **至少 2 个版本都打过**的非版本对手（Rapfi 各档按思考时间升序在前；只被 1 个版本打过的对手单列一行），
  格 = **版本视角**得分率（`(胜+和/2)/局数`）+ 独立 Wilson，末列 = 对上述对手的合并。判读**逐对看差值符号**：
  非零差值同号 ⇒ 判据 ② 通过（`a > b` + 逐档差值，按胜者方向印）；差值为 0 记「并列档」（不给序、不算翻转）；
  全平 ⇒ 写「不可分」；方向相反 ⇒ 点名翻转对与档位。**为什么**：vorder1 那类版本互殴只有 3 对 × 20 局且成环，
  而「同一版本分别去打同样的 Rapfi 档位」天然是共同对手，档位越多越硬。**初版按整条序字符串比对**，
  各对手可出场版本集合不同（2 元序 vs 5 元序）⇒ 判出假的不一致，已改成逐对方向（教训入 MEMORY）。
  首次实测（`l2n1`+`vorder1`+`rapfihi1` 前 5 轮，460 局）：唯一在**全部 5 档**同向的版本对是 `v11 > v10`
  （`@500` +2.5 → `@10000` +50.0 pt；100 局合并 75.5% `[66.2–82.9]` vs 57.5% `[47.7–66.7]`，Wilson 不重叠）；
  `v12 > v13`（三个低档）、`v14 ≥ v13`（含并列档）方向一致，其余 8 对全部翻转 ⇒ **仍排不出全序**。
- **合并批次报表自报家门：`--dir a,b` 的标题与默认产物名不再只剩第一批（2026-10-05）**：
  `scripts/experiment-report.mjs` 的 `batchId` 原取 `dirs[0]` ⇒ 三批合并的标题写成「阶梯报告：l2n1」、
  默认落盘 `.work/l2n1-report.md` 会**覆盖**单批报表。现在 `batchId` = 各根 basename 用 `+` 连接；
  实测 `✓ l2n1+vorder1+rapfihi1：380 局 / 9 身份 / 19 对｜兜底手 0 / 上游手 16213`、
  标题 `# 阶梯报告：l2n1+vorder1+rapfihi1`；`test/scripts/report.spec.mjs` 累计 **37 例**（新增 1 例钉住多根）。
- **败局解释固化成工具：`scripts/loss-report.mjs`（规则 11 可复算）（2026-10-05）**：纯核
  `scripts/lib/loss-report.mjs`（`fatalSuffix()` 取**最长必败后缀** —— 「VCF 出现又被堵掉」的局不能算早就必败；
  `lossShape()` 出形态与追因；`formatLossMarkdown()` **强制印边界句**「VCF 只解释 found/l」）+ CLI
  （`--dir/--batch/--ours/--theirs/--tail/--plies/--max-games/--no-vcf/--show/--json/--quiet`；
  `--mirror` 让同门对局两侧各出一个视角 ⇒ 局数 = 棋谱 ×2，口径写在标题里）+ **28 例**单测（纯核 21 + CLI 7）。
  实测复算：L2 `--batch l2n1` ⇒ 300 局 = 234/17/49、必败后缀 0/3/7/4 + 查不到 35、不可逆点 14/49（`--plies 9`）；
  `vorder1 --mirror` ⇒ 120 视角 = 31/58/31、短败 16/31、**必杀后缀只有 3/31（9.7%）**。
  > **⚠ 追因数字同日被修正**：本条的「必败后缀/不可逆点」用的是裸 `vcfWin()`，它漏判「对手已一手成五」
  > ⇒ 那些数字是**下界**（正确读数：L2 `0/12/23/14 + 查不到 0`、不可逆点 49/49；`vorder1` 31/31）。见本节「败局追因判据」条。
  两条纪律入 MEMORY：探针数字随窗口参数变（引用必须带 `--plies` 档位）、`vcfWin()` 返回对象（`!!` 恒真）。
- **L2 败局解释：49 局败局的形态与追因（2026-10-05，规则 11）**：49 局败局**最后一手全是 `block`、全部被五连终局**
  （无认输、无盘满而败）；手数三形态分明 —— 胜局均 29–39 手、**和局 17 局全 225 手满盘**、败局 25–118 手
  （`v13@2000` 的 9 局败里 4 局 ≤38 手）。逐手 VCF 探针（`opts.sound` 缺省 = 健全链）：**14/49 局**在我方最后 6 手里
  有 ≤9 手必杀后缀、**13/49 局**能定位不可逆点（21–92 手，均 59.4），其余 35 局连 ≤9 手 VCF 都查不到
  ⇒ **VCF 只解释 13/49**（**下界，同日修正为 49/49**，见本节「败局追因判据」条），剩下的要 VCT 级探针。五个版本的败局形态一致 ⇒ `v13@2000` 的 52.5% 只能记成速率差异，
  不是新的失败模式。探针一次性、不入库；见 [docs/plans/2026-10-04-l2-version-vs-rapfi.md](docs/plans/2026-10-04-l2-version-vs-rapfi.md) §3.6。
- **`vorder1` 版本排序筛查结果落档：三版不可分（2026-10-05）**：3 对 × 20 局 = 60 局（双方都是上游臂，
  292 分钟、8014 个上游手全 `primary`）。三对得分率全是 **57.5%／42.5%** 且**成闭环**（v11>v13>v14>v11），
  三个身份各 40 局**得分率全 50.0%**；和棋 29/60（48.3%）**全部是 225 手满盘和**；回归重放层一致 **155/155 = 100%**、
  接管落点 100/121 = 82.6%。报告第 4 节的 `screenVersions()` 三条判据全不中 ⇒ 「筛查不成立 ⇒ 跑 L1」，
  而新文档把算术摆开（L1 200 局 ≈15.5 h、每对仍 20 局）⇒ 收敛为「接受不可分（推荐）」或「只堆 `v11 vs v14` 100 局」。
  详见 [docs/plans/2026-10-05-vorder1-version-screening.md](docs/plans/2026-10-05-vorder1-version-screening.md)。

### 修复

- **败局追因判据：裸 `vcfWin()` 漏判「对手已一手成五」，`13–14/49` 是下界（2026-10-05）**：
  `vcfWin()` 的入口前提是「双方无一步杀」（`src/core/engines/gomoku.ts:220`）—— 逼迫着法生成器只收
  「落子后造出**新**致胜点」的着法（`winsAfter` 找含新子的 5 窗口里 4 子 + 1 空），**直接成五那一手窗口已满、
  被排除** ⇒ 攻方已能一手成五时它报 `false`，**永远报不出「隔 1 手」**。最小复现
  `.work/vcf-precondition-check.mjs`：黑 (7,4)–(7,7) 一条四、轮到黑 ⇒ `vcfWin(st,'black',9) = {win:false, first:null}`，
  `vctWin = {win:true, first:'D8'}`（`vctWin` 每个节点先判 `fivePointOf` 所以认）。
  `scripts/loss-report.mjs` 的逐手判据改成 **一手成五（权威 = `getLegalMoves → applyMove → getStatus().over &&
  winner === side`）∨ `vcfWin(...).win === true`**，判据来源记进 `suffix.cause`、报表印「起点判据 一手成五 N / VCF M」；
  纯核 `loss-report.mjs` 加 `lostFrom.cause` 聚合，markdown 的追因/不可逆点/边界三行按新口径改写。
  单测加 4 例（含 CLI 回归钉子：夹具是真棋形 —— 白 B1–E1 活四，我 7 手没堵、9 手堵一头 ⇒
  后缀必须是 **2** `1· 3· 5· 7✗ 9✚` 而不是裸 vcfWin 给的 1），合计 **30 例**。
  复算：L2 `49/49` 局能定位必败起点（旧：`13–14/49`、查不到 35）、`rapfihi1` r1–r7 `66/66` 局；
  结论从「VCF 只解释 27%」改成「**败局全部在最后一手之前就已必败，且那一刻多在防守层**」。
  同批一次性 VCT 级探针（108 局败局）另测：VCT 起点更早的有 29/108，均深 2.12 → 2.56 手（窗口放宽复跑 2.62）。
- **报告第 4 节「按身份分开颜色」表：口径写错（2026-10-05）**：旧版列是「总战绩 = 胜–非胜局」+「得分率 = 胜率」，
  而同一份报告第 1 节的「得分率」是（胜 + 和/2）÷ 局数 ⇒ **同一个词两个意思**，还把和棋算进「负」：
  `vorder1` 实测把 v13 的 11 胜 18 和 11 负印成 `11–29 / 27.5%`（真值 50.0%），和棋多的批次会被直接读成惨败。
  现在 `colorSplit()` 记 `blackDraws/whiteDraws`，表头写死 `胜–和–负 ｜ 得分率 ｜ 执黑 胜/局 ｜ 执白 胜/局`，
  得分率与第 1 节同口径；单测钉住三行渲染（`report.spec.mjs` 36 例全绿）。
- **`--dry-run` 印的启动命令与真跑不是同一条（2026-10-05）**：`experiment-ladder.mjs` 的 dry-run 预览还在手写
  老命令串（`exec nohup node scripts/experiment-worker.mjs --plan …`），而真跑早就换成了
  `launchRoundCommand()`（远端原子 pid 守卫 + 日志/pid 落同一处）。dry-run 是拿来看「今晚到底会执行什么」的，
  印一条不会执行的命令等于骗人 ⇒ 预览改成直接调 `launchRoundCommand()`，与真跑逐字同源；单测加 1 例钉住
  （守卫在启动之前、日志 `>> …/logs/round-N.log 2>&1 < /dev/null`、`echo $! > …/round-N.pid`、不再出现 `exec nohup`）。
- **L4 的墙钟估算改正：≈13–17 h（不是 ≈26–35 h）（2026-10-05，用 `l2n1` 300 局真实手数重算）**：早先拿
  `vorder1`（**双上游臂**、手数均 90.3）的手数分布去外推「版本 vs Rapfi」的 L4，得到 ≈26–35 h —— 形态不同，
  结论作废。正确锚点是 `l2n1` 自己的 300 局：手数 **均 49.3 ／ 中位 33 ／ p90 75 ／ 最长 225**、Rapfi 侧手数
  **均 24.5**、上游侧单手 ≈2.4 s ⇒ 每局 ≈ `Rapfi手数 × think + 上游手数 × 2.4s`：`@7000` 均 3.9 min、
  `@10000` 均 5.1 min（最慢单局 17.7 / 23.3 min）⇒ 单轮 20 局 ≈1.3 / 1.7 h，**整条 L4 ≈13–17 h**，与 dry-run
  的 18.0 h 相符；`pollRound()` 的单轮 12 h 上限安全。
- **Rapfi 节点预算的结论改正（2026-10-04 真引擎复现探针）**：阶梯计划 §9 第 2 条里那句
  「节点数只能读、不能设 ⇒ 等节点数当不了控制变量」**作废**。本机用真引擎复现（一次性探针
  `.work/rapfi-node-info-probe.mjs` + `.work/rapfi-maxnode-probe.mjs`，都不入库）证实：**`INFO max_node <N>`
  是真正的节点预算、按 N 单调生效** —— 同一 12 子中盘局面 + `INFO timeout_turn 3000` 实测
  `N=1 → 7ms／最深深度 0`、`100 → 3ms／8`、`1000 → 2ms／12`、`10000 → 26ms／19`、`100000 → 116ms／29`、
  `1000000 → 1087/1114ms／55`，`N=0`（不限）与 baseline 都是 `2631/2572ms／53`；而 `INFO nodes` /
  `INFO depth` 这两个名字**不合法**（`MESSAGE Unknown Info Parameter: NODES` / `…: DEPTH`）
  ⇒ 正确参数名是 `max_node` / `max_depth`。这与本仓 §2.1「探针 A」早已实测的结论（第 54/58/60 行）一致，
  是那次「只读代码」的勘察把第 61 行读反了。**结论未变的部分**：客户端不发节点预算
  （`src/core/jev/rapfi.ts:240` 只发 `INFO timeout_turn <ms>`）、在跑的阶梯按时间档计时、本轮**不动协议**；
  「等节点数」的公平对比技术上已可行，但要另开 preset + 可选开关（规则 10，另开计划/ADR 决定）。
- **限流用例不再在固定窗口边界上随机红（2026-10-04，CI run 37212423985 实测）**：`test/worker/jev.spec.ts`
  的「桶满后 429」用例灌满 60 次请求时若正好跨过 60 s 固定窗口边界，计数会重置 ⇒ 那一次仍是 400
  （`AssertionError: expected 400 to be 429`，本地几乎复现不出来，概率 ≈ 灌桶耗时/60 s）。现在读首个响应的
  `X-RateLimit-Reset`（窗口起始 epoch 秒），**翻页了就接着灌**（有界循环 2×limit+5 次），窗没翻的那一次必然 429；
  断言一条没放松，失败时多打「灌了 N 次仍未满（窗口翻页 M 次）」。
- **`--max-rounds N` 现在会当场说清它是「截断本次编排」**：以前只静默 `ladder.rounds.slice(0, n)`，
  容易被读成「先跑 N 轮、之后接着跑」——实际被截掉的轮次**不在这次状态里**，续跑要另起一次。
  现在打印「⚠ --max-rounds N：本次只编排前 N 轮（共 M 局）—— 被截掉的轮次不在这次状态里」+ 一句提醒，单测 1 例。
- **batch 的串行等待也改本地轮询（同一类「作业永不结束」）**：`experiment-batch.mjs` 的串行分支原先是
  远端 `for i in $(seq 1 1440); do kill -0 …; sleep 30; done` 一条 ssh 守 12 h，**与阶梯第一晚 L3 的悬挂
  同一个根因**（长命 ssh 继承 stdout 管道，编排意外死掉后外层 `| Tee-Object` 永远等不到 EOF）。
  现在改成本地 `waitRoundLocally()`：每分钟一次**捕获式**短 ssh（`pollRoundCommand()` 探针 → `parsePollOutput()`），
  到 12 h 上限只提示「先 `status` 复核」，不当作失败；探针与阶梯共用同一份实现（单测见 `test/scripts/ladder.spec.mjs`）。
- **同一轮被两个 worker 双写：启动命令收敛到一处并加 pid 守卫（版本排序筛查开局发现）**：
  编排的准备阶段要连好几趟 ssh（建目录 → 上传全部计划 → 逐轮读 tag，**每趟 12–20 s，合计 2–4 分钟**），
  这段时间远端只有 `plans/`、没有 `round-N/`、没有 `.pid`，看着像「启动失败」；当时据此又手工起了一个
  worker，两个进程写同一个 `round-1/`（同 plan、同 tag），`games.jsonl` 会被灌成两份。
  现在三处启动（阶梯 + batch `submit`/`resume`）统一走 `scripts/lib/ladder.mjs` 的
  `launchRoundCommand({repo,keyFile,planPath,logPath,pidPath})`，守卫放在**远端 shell** 里原子判断：
  `if [ -f <pid> ] && kill -0 "$(cat <pid>)"` ⇒ 只回 `started pid=…（已在跑，不重复起）`；
  编排同时先打印「准备中…这期间远端没有 `round-N/` 是正常的，别手动补启动」。
  单测 3 例（`test/scripts/ladder.spec.mjs`，共 49 例）。
- **链路抖动会把整晚掐死：`scp`/`ssh` 一律三次重试（L2 收尾发现）**：box 的 22 端口链路会**间歇性抽风** ——
  `scp` 直接 `exit=1` 且**没有任何 stderr**，同一条命令行手工跑、或换 `node -e` 的 `execFileSync` 跑就成功
  （轮询里还见过一次 `ssh: connect to host … port 22: Connection timed out`）。原来只重试一次，
  L2 收尾时「上传 round-1 plan 失败」把续跑连续掐死两次，第 15 轮的 `scp -r` 也栽了一次
  （那轮远端 20/20 已跑完，只剩本地拉不回来）。现在 `scripts/lib/ladder.mjs` 新增可注入 `sleep` 的
  `retrySync(fn,{attempts,sleepMs,onRetry})` 与 `sleepSync(ms)`，CLI 的 `scp()` 与新增的 `sshRetry()`
  统一 **3 次重试、间隔 2 s**，失败时打印 `exit=/signal=/code=/message`（静默失败最费时间）。
  `ssh` 的三处（`mkdir -p` / 读 tag / 数行数）也必须重试：它们原来**不报错只回退**，而回退的后果更坏 ——
  读 tag 失败会当「远端没 tag」换新 tag 把整轮重放（worker 的 checkpoint 按 tag 命中），
  数行数失败会当「远端 0 行」把跑完的轮次再排一遍。修复当场生效：同一次续跑里 round-12 与 round-13
  的 plan 上传各失败一次、第二次重试成功。单测 6 例（`test/scripts/ladder.spec.mjs`）。
- **重放工具把实验面归档全判成「不认识的棋种」（L2 首次过棋谱时发现）**：`scripts/lib/tactics-replay.mjs`
  的棋种解析顺序是 `slug → game → 默认`，而实验面归档的 `slug` 是**对阵描述**（`jev-v14-vs-rapfi-0-5s`）
  ⇒ L2 的 300 局全部被跳过，回归核对直接跑不出数。现在按 `[显式 gameId, slug, game, gid]` 逐个候选试、
  认出就用；**候选全都认不出时仍然 throw**（一个坏 `slug` 不该判死整批，但也不能瞎兜底成 gomoku），
  只有「一个棋种字段都没写」才退默认。单测 3 例。
- **阶梯编排先建远端目录再读 tag（L2 首跑发现）**：`remoteTagsOf()` 会先在远端 `: > tags.txt` 再 scp 回来，
  而这一步排在 `mkdir -p` 之前 ⇒ 新 `--batch` 首跑必然打两行
  `scp: …/tags.txt: No such file or directory`（`scp()` 失败重试一次）再照常继续 —— 不是故障，是噪音，
  但会让人误判上传坏了。现在 `mkdir -p <batch>/{plans,logs}` 提到最前（`ensureRemote()` 只连一次，后面复用）。
  经验写进 `docs/memory/MEMORY.md`：这台 box 每次 ssh/scp 握手 ≈12–20 s，编排里「多连一次」是有代价的。
- **阶梯编排的等待改成「本地轮询」，修掉一类「作业永远不结束」的悬挂（P6 修复）**：原先起完一轮后，编排进程会挂一条
  远端 `for i in $(seq 1 1440); do …; sleep 30; done` 的 ssh 等满 12 h。**那条 ssh 继承了编排进程的 stdout 管道**，
  所以编排进程一旦意外死掉（第一晚 L3 真的发生了：node 消失、ssh 还在），外层 `| Tee-Object` 就永远收不到 EOF，
  作业一直显示 running、日志停在 `started pid=…`，而远端那轮早就跑完了。现在改成 `sshCapture()`（`execFileSync` +
  `encoding:'utf8'` + `timeout: 60s`，**捕获 stdout 而不是继承**）每分钟问一次「pid 还在吗 + `progress.json`」，
  最坏只泄漏一条 ≤60 s 的子进程；顺带把远端进度打成一行 `⏳ round-N d/total 局 · 秒 · 均 Xs/局 · W-D-L`，
  阶梯日志本身就是进度面板。新增 `--poll <秒>`（缺省 60）与 `--quiet`。纯函数 `parsePollOutput()`/`formatPollTick()`
  在 `scripts/lib/ladder.mjs`，单测 6 例。
- **`/api/jev` 的成功响应其实没有 CORS 头（C2 期间发现）**：Hono 的 `c.header()` 写的是「预备头」，
  只在 `c.body()`/`c.json()` 这类路径上合并进响应；**直接把 `fetch()` 的响应 `return` 出去时会被丢掉**
  （`hono/dist/context.js` 的 res setter 只在 `#res` 已存在时合并，而 `compose` 首轮赋值时它还是 null）。
  同源部署看不出来，跨源调用就是抓瞎。现在路由自己拼 `new Response(...)`：透传头 + CORS 头 + `X-Jev-Provider`
  （+ 切换时的 `X-Jev-Provider-Switch`）显式合并，`Access-Control-Allow-Headers` 也补上了 `X-Jev-Provider`。
- **实验运行面的两处缺陷（只有 box 真跑才露头，C2 验收轮抓到）**：① 兜底切换的回调里引用了 `main`
  作用域的 `outDir`，而 `playOne()` 是顶层函数 ⇒ **每次切换整局变 error**（`events.jsonl` 四条
  `"error":"outDir is not defined"`），改成把 `outDir` 一起塞进 `dirs`；② 逐手提供方统计把非上游侧
  （Rapfi 的 `meta.provider === undefined`）也记成 `unknown` ⇒ 日志 `provider[backup:19 unknown:18]`
  读不出「兜底了几手」，`countProvider()` 现在只认非空字符串 id 并导出供单测。
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

- **第 1 节下方补一条「得分率不可跨身份横比」的警告（2026-10-05）**：能力表里可比的是 `BT Δ`（按对手强度配平）
  与第 4 节的配对样本；`得分率 / 胜和负` 是**原始计数**，对手集不同的身份之间不可横比。触发它的真实读数：
  把 `l2n1`（300 局、每版只跟 Rapfi 打）与 `vorder1`（版本互打）合成一份报告时，
  `official|v12-vct-def|0` 是 84.2%（60 局全对 Rapfi）、`official|v13-pressure-gate|0` 是 63.0%（100 局里 40 局在跟 v11/v14 打）
  —— 并排看很容易读成「v12 明显强于 v13」。单测钉住这行文字（`test/scripts/report.spec.mjs` 36 例）。
- **阶梯报告第 4 节新增「版本筛查判读」（2026-10-05，把计划 §7 的筛查规则机械化）**：
  `scripts/lib/report.mjs` 加 `screenVersions()` —— 把「跑完筛查要不要补 L1」那三条判据（① 两两点估计能排无环全序；
  ② 直接比较与经共同对手的间接比较同向；③ 逐色格不换色翻面）算出来印在配对表与逐色格之间，并给一句判定
  （`有值得决赛的差距 ⇒ 只补决赛对 X vs Y` / `筛查不成立 ⇒ 直接跑 L1`）。只在**彼此真交过手**的 3–5 个 `official|v*`
  身份上出现：`l2n1`（5 版但全都只跟 Rapfi 交过手）第一版实现会误印「只凑齐 0/10 对 ⇒ 直接跑 L1」，
  真实 300 局复跑时抓到 ⇒ 现在这种形态整块不印，混跑批次（`l2n1` + `vorder1` 一起读）也只按交过手的子集判。
  判据 ② 在 3 版筛查里每对只有 1 个共同对手 ⇒ 退化为「间接与直接同向」，块内写明。
  真数据验证（`vorder1` 的 round-1 + 从 box 现拉的半轮 round-2，36 局 / 3 身份 / 2 对）：块正确写「只凑齐 2/3 对
  ⇒ 筛查不成立」——**单轮报表里这块不出现是正常的**（三版分三轮跑，要三轮齐了才读得出全序）。
  单测 +8 例（`test/scripts/report.spec.mjs` 共 36 例）。
- **阶梯报告新增「收尾机制 + 接管层 × 结果」解释块（2026-10-04，`vorder1` round-1 之后）**：
  `scripts/lib/report.mjs` 加两个纯函数 —— `endReasons()`（收尾原因分布 + 和棋手数 + 全局手数分位）与
  `layersByResult()`（每身份一行「接管层（开火次数；该层开火那几手的 胜/和/负）」），印在第 4 节内、
  第 5 节之前。规则 11 要求「败局要解释、和棋可接受」，这块就是那份解释；但它**不参与判强**
  （判强只看 §1/§4），所以只作 §4 的子块，不打乱 §1–§6 编号。层的取法与
  `scripts/lib/tactics-replay.mjs:52 recordedLayerOf()` 同源：`move.tactics || move.ai.tac`
  （**`ai.tv` 是战术版本，不是层**）。真数据实测（`vorder1` round-1，20 局）：收尾 `五连 15 局 ·
  棋盘已满 5 局`，和棋 5 局全是 225 手满盘；v11 `vctAttack 21（21/0/0）`、`open4 9（9/0/0）`；
  v13 `block 46（4/7/35）`、`pressureGate 122（23/82/17）`。单测 +5 例（`test/scripts/report.spec.mjs`
  共 28 例；2026-10-05 加筛查块后同文件共 36 例）。
- **运维手册新增「§8 远端阶梯作业」**（`docs/agents/playbooks.md`）：把「在 box 上本地跑 Elo 大数据、
  不碰业主 Worker」的完整套路钉成一节 —— box 同步要用显式 refspec（普通 `git fetch origin main` 不会
  更新 `origin/main`）、准备阶段 2–4 分钟别当启动失败、一次只跑一条（Rapfi 计的是墙钟）、
  零 CF 依赖是默认、key 走 `/root/.jev-key` + `/root/.cc-key`、产物布局与 `pull --batch`、
  报表 `--dir` 多根与未收尾轮的读法、以及「n=20 不许排版本名次」的回读纪律。

- **阶梯计划 §9 又结掉两条开放问题（2026-10-04，只读勘察，没起引擎、没连线上）**：
  ③ **`games.device_id` 有**（`migrations/0001_init.sql:61` 的列 + `:70` 的索引），P0b 的
  「三条历史 tag 回填 `device_id='ssh-batch'`」**已完成**（26 局，`code_version` 仍 `dev+nogit`，
  见 `docs/status.md:35-38`）⇒ 该条**按仓库迁移与 status 记录结案**，不再是线上待查项（本机
  `wrangler d1 execute --remote` 已因凭据失效报 `code: 7403`，见 status 已知限制新增第 29 条）。
  ② **Rapfi 的节点预算（该条 2026-10-04 当天即被复现探针改正，见顶部修复条）**：本仓这侧是 WASM +
  Gomocup 风格协议，客户端只发 `START 15` / `INFO rule 0` / `INFO timeout_turn <ms>`（`src/core/jev/rapfi.ts:195`、`:240`）
  ⇒ **客户端当前确实不发节点预算**；但「节点数只能**读**（`INFO show_detail 1` 的 `MESSAGE` 行）、不能**设**」
  是**误读** —— `INFO max_node N` / `INFO max_depth N` 都被静默接受且实测生效（§2.1 探针 A），
  要坐实这一点的那次真引擎探针已于 2026-10-04 在本机跑完（见顶部修复条与计划 §9 第 2 条结案）。

- **采样参数探针 `scripts/probe-model-params.mjs`（只读，2026-10-04）**：拿真实夹具请求体按变体表重复 POST，
  回答「上游认不认 `temperature` / `top_p` / `seed`」，印出每个变体的 HTTP 状态、答案是否逐字复现、
  自报概率的最大摆幅与耗时；`--dry-run` 零请求、key 永不入产物。实测结论：**官方端点对多余顶层字段直接
  400 `api_usage_error / Invalid request.`**，四个冻结变体全败（baseline 200）⇒ 计划 §9 第 1 条结案：
  方差只能靠样本量压。单测 19 例（计划与归组、读数三态、请求体投影、key 优先级、执行器与 CLI 端到端）。

- **报表的 Rapfi 曲线带「相邻档差 + 区间重叠」读数（2026-10-04，为 L4 铺路）**：L4 要读的就是「思考时间抬到
  10 s 还涨不涨」，原来的曲线表只有逐档点值，Δ 得手算。现在第 2 节每行多一列 **ΔElo（相对上一档）**，
  表下自动印「相邻档差：500→1000：+100.7（区间不重叠）、1000→2000：+107.6（区间重叠）」、
  「N 对相邻档里有 M 对区间重叠」与每档样本行；判据与 §1/§4 同一条纪律 —— **相邻档 BT 区间重叠就不许说
  「这一档更强」**。纯函数 `curveDeltas()`（`scripts/lib/report.mjs`），单测 2 例（`test/scripts/report.spec.mjs`
  共 23 例）。用 `l2n1` 真数据复跑：500→1000 不重叠、1000→2000 重叠 ⇒「抬时间有收益」踏实、
  「每抬一档都更强」不能说。
- **阶梯新增 `L4`：Rapfi 高思考档（@7000/@10000 ms，到 UI 上限）（2026-10-04）**：业主原话「补 500ms，
  7000ms，到 10000ms」⇒ `scripts/lib/ladder.mjs` 加 `RAPFI_HIGH_SPECS` 与预设 `L4`
  （`cross(VERSION_SPECS, RAPFI_HIGH_SPECS)` = 10 对 / 200 局，dry-run ≈18.0 h）。**只列 L2 没跑的档**
  （`@500/@1000/@2000` 已各 100 局），单测钉死「两批右臂不重叠」；`all` 的对数 28 → **38**（+5000 = 39）。
  曲线报表一次读两批：`experiment-report.mjs --dir .work/remote/l2n1,.work/remote/rapfihi1`（多根 + 按身份聚合）。
- **上游兜底补上决策记录 [ADR-0022](docs/adr/0022-upstream-provider-failover.md)（2026-10-04）**：
  C2/C3 的代码早已进 main（`src/core/jev/providers.ts`、`src/worker/lib/failover.ts`、
  `migrations/0004_move_provider.sql`），但「为什么这样兜底」只散在计划里。ADR 写死五条：
  换三元组不写协议适配器、同局粘滞不回切、两条运行面各自处理「用尽」（Worker 是单请求语义 ⇒
  429/529 即用尽，直连面把重试阶梯的 `exhausted` 传进 `noteFailure`）、`provider`/`prob_source`
  缺失 **≠** `primary`/`exact`、Worker 侧默认关闭（`JEV_FAILOVER=off`）；并留下 C1 的事实基线
  （兜底网关响应逐字段同构、`/provider/v1/models` 不列 `typesafe/jev`、无 `x-ratelimit-*`）。
- **L2 阶梯结果落档：5 个版本 × 3 档 Rapfi，300 局（2026-10-04）**：新增
  [docs/plans/2026-10-04-l2-version-vs-rapfi.md](docs/plans/2026-10-04-l2-version-vs-rapfi.md)。
  `--ladder L2 --batch l2n1 --games 20` ⇒ 15/15 轮 / 300 局 / **W234-D17-L49**（Jev 侧 78.0%），
  零网络写、零 CF 触碰，墙钟 316.7 分钟、7440 个 Jev 手全 `provider=primary`（切换 0 次、兜底 0 手）。
  两条可用的结论：① **Rapfi「思考时间 → 强度」曲线成立** —— 每档 100 局、分母配平，
  `rapfi||500/1000/2000` = Elo 1240.1 / 1340.8 / 1448.4，Rapfi 视角得分率 10.5% / 20.5% / 26.5%
  （Wilson [5.9–18.0] / [13.8–29.4] / [18.8–35.9]）⇒ 从 500 抬到 2000 **确实更强**（区间不重叠），
  500→1000 分不出来；② **五个版本之间不可排序**（每版 60 局、每对 20 局，Wilson 半宽 12–22 pt、
  12 对区间重叠）：v11 85.8% / v12 84.2% / v14 84.2% / v10 78.3% / v13 71.7%；
  ③ **成本随机制单调变贵**：战术占单手 v10 22.3% → v11 36.7% → v12 36.8% → v13 37.9% → v14 38.7%
  （合计 35.6%：战术层均值 1006.7 ms、模型往返 1818.7 ms、单手合计 2825.4 ms）。回归核对：每轮抽样
  2 局重放（30 局 / 1580 手）⇒ **层一致率 640/640 = 100%**、接管落点 410/484 = 84.7%、74 手会变但**全部同层**。
  产物留 box（业主决定暂不推对象桶）：`.work/remote/l2n1/round-{1..15}/`、`.work/l2n1-report.md`、
  `.work/l2-regress/round-*.json`。
- **阶梯报告 CLI：计划 §7 的「六项必出报表」一条命令复算（plan `2026-10-03-tactics-fidelity-and-elo-ladder`）**：
  `node scripts/experiment-report.mjs --batch <batchId> [--json <path>]`（或 `--dir <path[,path]>`）读
  `round-<i>/games.jsonl` + `round-summary.json` + `events.jsonl`，产出 `report.md`：① 能力表（BT Elo + bootstrap
  95% CI + 局数 + W/D/L + 得分率 + 锚点 + Wilson + `⚠样本不足(<50)`，直接内嵌既有 `formatRankTable()`，**不改它的形状**）
  ② Rapfi「思考时间 → Elo」曲线 ③ 成本表（逐身份 Jev 手数 / 模型往返 ms（均值·中位·p90·最差）/ 战术层 ms / 单手合计 /
  **战术占单手** 与 **战术/往返** 两个口径都印，m07650 + m08110 的必报项）④ 配对样本矩阵（A 取字典序在前者 + Wilson）
  ⑤ 差异显著性说明（区间重叠才算不可判；样本 < 50 必标注）⑥ 产物清单（文件/字节/行数/sha256 前 12）。纯函数在
  `scripts/lib/report.mjs`（`moveIdentity`/`isUpstreamMove`/`quantiles`/`collectCost`/`costRow`/`pairTable`/`rafiCurve`/
  `openingRows`/`significance`/`reportMarkdown`），单测 `test/scripts/report.spec.mjs` 18 例。口径：逐手身份走
  `identityOf()` 唯一实现（Rapfi 侧战术档留空、Jev 侧思考档留空）；只有 `ai.ms` 是数字的手才算上游手（Rapfi 侧
  `ms=null` 不是 0）；`provider=backup` 的兜底手单列「提供方」列并明写**未计入主口径**（C3 口径）。
  同日补的读法纪律：**「这轮跑完没有」只看 `round-summary.json`（worker 收尾才写）** —— 缺它的轮默认照读但在报告头与
  第 5 节显著标出、收尾行告警，`--skip-incomplete` 才真的不看它（半轮的比分不许进结论）。
- **上游归因落库与报表分桶（C3，plan `2026-10-03-cands-metric-and-provider-failover`）**：「这一手是谁答的」
  现在从归档一路写进 D1 与实验报表。新增 `migrations/0004_move_provider.sql`（`game_moves` 加 `provider` /
  `prob_source` 两列，**已应用到本地与远程 D1**，远程老数据 19298 手零改写）；`src/shared/record-map.ts` 逐手取
  `ai.prov`/`ai.probs`（`strOrNull`：非空字符串才写），`src/worker/lib/record-input.ts` 显式搬运、`src/worker/db/games.ts`
  的列清单/`VALUES (… ?17, ?18)`/bind 三处同步。口径：`provider ∈ primary|backup|custom|random`、
  `prob_source ∈ exact|derived`；**Rapfi/mock/人类侧与 0004 之前的老归档一律 NULL**（缺失表示「当时还没这个口径」，
  不冒充 `primary`/`exact`）。报表累计行新增「上游兜底 N 手（未计入主口径 · 主口径 M 手 · primary … · backup …）」一行，
  轮注脚与逐身份 tooltip 各有一处；`experiment-report.ts` 暴露 `FALLBACK_PROVIDER='backup'` 与
  `mergeProvs`/`provMovesOf`/`fmtProvs` 三个纯函数。单测：worker 往返三手（Jev 手写值 / Rapfi 手 NULL / 老归档 NULL）、
  ui 两局（`{primary:38, backup:4}`、Rapfi 身份空表、文案与 tooltip）。**遗留**：生产 Worker 尚未重新部署
  （`deploy.yml` 只留 `workflow_dispatch`）⇒ 生产棋谱要等一次手动部署才开始写这两列，列已就位不会 insert 失败。
- **上游兜底提供方：两个运行面共用一套切换判据（C2，plan `2026-10-03-cands-metric-and-provider-failover`）**：
  新增纯叶模块 `src/core/jev/providers.ts`（提供方表 `primary`=TypeSafe `jev-latest`、`backup`=commandcode
  `typesafe/jev`；失败分类 `classifyStatus` 按状态码分 auth / rate-limit / server / client；状态机
  `noteFailure`/`noteSuccess`/`pickProvider`；响应头常量），`src/worker/lib/failover.ts` 让 Worker 面用**同一套判据**
  （差别只有一处：Worker 每请求独立、没有跨请求计数 ⇒ 429/529 一次即视为用尽），浏览器直连面走
  `client.ts` 的 `callWithFailover`（局内粘滞、备用**探活通过才切**、失败原因回调给上层）。
  `decide()` 把「这一手谁答的」写进 meta（`provider`/`probSource` → 归档逐手 `prov`/`probs`、局级
  `providers`/`probSources`），`X-Jev-Provider`/`X-Jev-Provider-Switch` 两个响应头把 Worker 侧的决定带回浏览器。
  实验面：`resolveBackupKey()`（`COMMANDCODE_API_KEY` → `/root/.cc-key`，拿不到不报错）+ worker
  `--backup-key-file`/`--expect-backup` + `events.jsonl` 的 `provider` 事件 + 逐手 `provider[…]` 日志。
  **生产路径默认关**：`vars.JEV_FAILOVER: "off"` 且未配 `COMMANDCODE_API_KEY` 时只走主家（客户端显式要求才用兜底）。
  box 端到端验收（主 key 故意写坏）4/4 局终局、55 手全部由兜底答出、逐手可辨；协议形状用真实网关响应体做离线夹具钉住。
- **阶梯编排：一条命令跑完一条 round-robin（P6，plan `2026-10-03-tactics-fidelity-and-elo-ladder`）**：
  新增纯核 `scripts/lib/ladder.mjs`（468 行）与 CLI `scripts/experiment-ladder.mjs`（556 行）+
  `test/scripts/ladder.spec.mjs`（400 行 / 38 例）。`--ladder L1|L2|L3|all` 或 `--identities a,b,c` 二选一，
  逐轮生成与 `submit` 同形状的 plan，**串行**执行（起一轮 → 等 pid → 拉该轮产物 → 推桶 → 冷却 → 下一轮），
  中断后重跑同一命令即续跑。三条口径写死在纯核里：① **偶数局数**（颜色对称：worker 让 A 奇数局执黑、
  开局库连续两局同开局换色，奇数会让最后一局没有换色对手 ⇒ 直接拒绝，`--allow-odd` 才放行）；
  ② **身份 = 归档导出口径**（`rapfi:v14-live3-fresh:500` → `rapfi||500`，rapfi/mock 的战术档留空）；
  ③ **「跑完了」看远端 `games.jsonl` 去重后的局数**（远端产物是权威、本地状态只记账；行数不足会重跑，状态文件坏了不重跑已完成的轮，
  跳过时本地缺产物会补拉一次；同一局按 `gameUid` 去重并自报 `dupes`）。配套：**续跑沿用旧 tag**（worker 的 checkpoint 按 tag 命中，
  换 tag 会整轮重放）、**`--force` 先把旧产物挪到 `stale-round-N-<旧tag>/`** 再从头重下。
  **为什么独立 CLI 而不是 `experiment-batch.mjs ladder` 子命令**：阶梯要自己管等待/拉取/续跑状态，
  塞进 submit 会让一个命令同时是「单批次提交器」和「多轮编排器」。**本轮还修掉一处误拦**：
  缺省 `--store local --upstream direct`（零 CF 触碰）原先会被「会写生产 D1」的闸门拦死，现在只有 `--store d1`
  才要 `--origin`/`--allow-production`。dry-run 表逐行印 `# / 对阵 / 局数 / 开局 / ≈墙钟`（每局 60 手、
  上游臂 1.1 s/手、rapfi `think/2`；据此把计划里「L3 ~10 h」的粗估订正为 ≈2–3 h —— 起草时把两侧思考都算了一遍）。
  验收：dry-run 逐项对齐（L1 10 轮/20 局、L2 15 轮/30 局、`all --with-5000` 29 轮/58 局）、
  四道闸门 exit 2（未知预设/奇数局/非法参数/`--store d1` 无 origin/`--upstream worker` 无 origin/`--parallel`）、
  `submit --parallel` 双 proxy 臂被点名拒绝、全量验收 `tsc` 干净 + 引擎 153/153 + vitest 47 文件 / 584 例 +
  `check:docs` 60 md / 421 链接 + 指纹 210 行一致。
- **阶梯的 box 端到端验收：四个只有真跑才会露头的续跑缺陷（P6 收尾，2026-10-04）**：
  在 box（`root@185.242.234.48`）上用 `--store local --upstream direct`（零 CF 触碰）真跑，修掉四个缺陷并把单测
  从 33 例扩到 **38 例**：① 本地 `ladder.json` 沿用上一次计划形状（`--max-rounds 1`）⇒ 汇总打 `1/1 轮` 而实际跑了 3 轮
  ⇒ 新增 `stateMatchesLadder()`（形状不同以本次计划重建）；② 续跑判据要求「本地 `ok` **且** 远端行数够」⇒ 远端跑完、
  只因一次 `scp` 失败就记 failed ⇒ 改成**远端行数为权威** + 跳过时补拉；③ worker checkpoint **按 tag 命中**，
  而续跑生成了新 tag ⇒ `p6kil` 的 4 局一轮被整轮重放、`games.jsonl` 变成 7 行、状态 `W3-D1-L3`
  ⇒ 新增 `withReusedTags()`/`remoteTagsOf()`；④ 重复记录被算进 W/D/L ⇒ `wdlOfGamesJsonl()` 按 `gameUid` 去重
  （`{lines, unique, counted, dupes}`），判据改 `unique ≥ games`。另修 `--force` 的旧产物挪开
  （`staleCleanups()`/`staleDirName()`）、`applyRoundResult()` 同步状态里的 `tag`、`scp()` 一次重试。
  实测：`p6val` ⇒ `3 轮跳过 / 0 轮要跑（{"1":2,"2":2,"3":2}）` + 补拉 round-3 ⇒ `3/3 轮正常｜6/6 局｜W2-D0-L4`；
  `p6kil2` 中途 `kill` 后同命令续跑 ⇒ worker `game-1 已完成（ok），跳过`、补跑 2–4 局 ⇒ 4 行 / unique 4 / 无 dupes；
  `--force` ⇒ 旧产物挪到 `stale-round-1-exp-20261004030619-p6kil2-r1/`、新 tag、4 行、状态 tag 同步。
  `scp` 瞬时失败的真因**未证实**（三种路径写法实测都成功，「盘符冒号」假设被否证）——如实记为「原因未定性 + 重试兜住」。
- **Elo 从「顺序迭代」升级为 Bradley–Terry + Bootstrap 区间（P5，plan `2026-10-03-tactics-fidelity-and-elo-ladder`）**：
  `scripts/lib/batch-elo.mjs`（238 → 448 行）新增 `aggregateBt()` / `fitBt()`（MM 迭代、`ridge` 先验 0.5、
  **显式零点**）/ `computeBt()` / `bootstrapBt()`（按局有放回重采样 + 每次重拟合，取 2.5–97.5% 分位）/ `mulberry32()`；
  `rankTable(records, K, { bt })` 开启 BT 时多出 `BT Δ` 与 `95% 区间(BT Δ)` 两列（不开时行形状逐字不变），
  Wilson 列与「样本 < 50」标注保留；`scripts/experiment-batch.mjs elo` 增 `--anchor`（缺省 `rapfi||500`）/
  `--bootstrap`（缺省 400）/`--seed`（缺省 20261004）/`--no-bt`，并在报表下印锚点、MM 迭代收敛情况、
  `ridge` 先验、重采样次数与区间宽度行。**为什么换**：顺序 Elo 的读数依赖局序、没有零点也没有区间，
  跨轮次读出来的「位移」无法与噪声区分。**这次也订正了一条过度乐观的判据**：计划原先写「合成 200 局
  （真差 100 Elo）⇒ 点估计误差 < 25 Elo」，实测（三身份轮转、40 种子）200 局时平均绝对误差是
  **27.9 / 35.6 Elo**（真差 100 / 200），400 局 21.2/25.4、800 局 20.6/17.3；而两身份干净情形与理论 SE
  吻合（n=200 理论 25.6 vs 经验 25.8，覆盖率 56/60）⇒ 估计量本身是对的，是「200 局能分辨多细」想错了。
  新判据：\|偏差\| < 10 + 200 局平均绝对误差 < 45 + 误差随 n 单调下降；计划 §7 写明「一次 200 局只能分辨
  ~30 Elo，不要用 `BT Δ` 的小数位讲 10 Elo 的进步」。测试 `test/scripts/batch-elo-bt.spec.mjs`（17 例 / 0.9 s）。
- **离线实验面：默认直连上游、零 CF 依赖（P4b，plan `2026-10-03-tactics-fidelity-and-elo-ladder`，[ADR-0021](docs/adr/0021-standalone-experiment-plane.md)）**：
  远端批量实验过去每手都经业主 Cloudflare Worker（`proxy` 渠道 → `/api/jev`），既占连接数与 D1 写入额度，
  又把研究数据混进站点棋谱。现在**运行面默认不碰业主设施**：`scripts/experiment-worker.mjs` 的
  `--upstream` 缺省 `direct`（直连 `https://api.typesafe.ai/v1/systemone`、`Authorization: Bearer`，key 优先取
  `JEV_API_KEY`、其次读 `--key-file`（缺省 `/root/.jev-key`）），`--store` 缺省 `local`（只落本地 JSONL）；
  不给 `--origin` 时 `--upstream worker` 与 `--store d1` 一律 exit 2，direct 面出现 `proxy` 臂也 exit 2
  （提示改写成 `official`——同一上游、同一 Bearer；身份串因此从 `proxy|…` 变 `official|…`，二者可比但**不混表算 Elo**）。
  限流与熔断自实现：新增 `scripts/lib/throttle.mjs`（滑窗 30 req/min + 连续 5 次 429 熔断；**裹全局 `fetch`**
  ——core 的 `client.ts` 直接调全局 fetch，包一层 client 会漏掉它自己的重试）与 `scripts/lib/upstream.mjs`
  （运行面闸门 + key 解析：认裸 key / `KEY=value` / `export` / `Bearer`；key 值永不进日志与产物，只记 `keySource`）。
  留档用纯 Node SigV4：新增 `scripts/lib/s3-put.mjs`（零依赖 `crypto` 实现，path-style 与 virtual-host 两种寻址，
  用 AWS 官方 GET/PUT 已知向量逐字节校验）+ `scripts/batch-bucket.mjs push|pull|ls`（产物白名单、凭据只读环境变量、
  缺任一 exit 3、上传失败只告警不阻断，`--strict` 才升 1）。进度仍走文件 + SSH：`experiment-batch.mjs status --watch`
  用纯 shell 循环复读 `progress.json`（远端非交互 shell 未必有 `node`，而这份文件本身是给人看的）。
  验收在 box 上跑通整局：`official:v14-live3-fresh:0` vs `rapfi:v14-live3-fresh:1000` 两局 118 s、54 次上游请求、零 429，
  跑前跑后 D1 行数 `games 312 / game_moves 19298 / experiments 28` 一字不变（零 CF 触碰的硬证据），
  取回的 `games.jsonl` 可直接 `experiment-batch.mjs elo` 复算。另补一条守卫：手写 plan 缺 `tag` 原先会静默跑出
  没有标签的实验行（`progress.tag` 落成 `""`）⇒ worker 现在开局前 exit 2 要求补 `tag`。
- **远端阶梯的地基：配对开局 + 进度可查 + 默认不碰业主 Worker（P4 阶梯地基，plan `2026-10-03-tactics-fidelity-and-elo-ladder`）**：
  新增 `scripts/lib/openings.mjs`（开局库：归档决胜局取前 N 手、8 变换对称归一、去重计数、原子读写、
  `openingForNo()` 让**连续两局同一开局、换色双跑** —— 配对样本是分辨 5 pt 差异的前提）与
  `scripts/lib/progress.mjs`（`progress.json` 原子写 + `events.jsonl` 追加 + `eta()` 估算，
  `etaS` 只按已完赛局取最近 5 局均值，样本不足给 `null` 而不编数字；`skipped` 不计入 W/D/L ——「没跑 ≠ 和棋」）。
  `scripts/experiment-worker.mjs` 新增 `--openings <file>`、`--store local|d1`（**缺省 `local`** ⇒ 默认不写生产 D1，
  老调用方在 plan 里显式写 `store:'d1'` 保持原行为）、`--device-id <id>`，每局落
  `progress.json`/`events.jsonl`，并把每局 payload 追加进 `games.jsonl`（`--store local` 的唯一产物）；
  `scripts/lib/batch-elo.mjs` 的 `loadRecords()` 学会读 `games.jsonl` 并按 `gameUid` 去重。
  实测（脚本 `.work/p4-build-openings.mjs`、`.work/p4-verify.mjs`）：归档 54 局 ⇒ 45 局决胜用、4 本开局，
  rapfi 自对弈 2 局**前 6 手逐手等于开局库**、`games.jsonl` 可被 `loadRecords` 读回 2 局（身份 `rapfi||500`）、
  跑动中可读到 `{done,gameNo,ply,wdl,elapsedS,etaS}`、`store=local` 轮次零网络写（实验行留在 `round-summary.json`）。
  顺带修掉归档两处坑：归档**没有 `winner` 字段**（只有中文 `result`）⇒ 新增 `winnerSideOf()`；
  归档布局是 `games/<day>/*.json` ⇒ 路径闸门改成「路径上任何一级目录叫 `games`」（`loadRecords` 同步受益）。
- **战术层可离线回溯（P3 回放 + 考古，plan `2026-10-03-tactics-fidelity-and-elo-ladder`）**：新增离线重放工具
  [`scripts/tactics-replay.mjs`](scripts/tactics-replay.mjs)（纯核 [`scripts/lib/tactics-replay.mjs`](scripts/lib/tactics-replay.mjs)），
  拿**任意历史棋谱 × 任意档位**重放：`--dir/--file/--game <uid>/--tag <tag>/--tactics <id>/--sides/--limit/--max-games/--json/--show`。
  语义刻意写成「无模型」口径（归档只存实走那一点的概率、没有整张概率表 ⇒ `pairs = 合法着法等权`、`topK = 1`，与
  `decide(channel:'random')` 同源），因此给出三个判据：**层一致率**（与模型无关的强结论）、**接管落点一致率**（层内多解，
  受模型概率影响）、**会变的手**（层不同，或层相同而落点不同）；逐行记 `vSource ∈ forced|move|game|current`，
  档号是推断出来的行会在汇总里印 ⚠ 提示（不许当历史结论读）。23 例单测在
  [`test/scripts/tactics-replay.spec.mjs`](test/scripts/tactics-replay.spec.mjs)。
  **验收（`exp-20261003082805`，v14 vs `rapfi@5000ms`，20 局 / 990 手 / 重放 496 手 / 282.2 s）**：
  层一致 **496/496 = 100%**、接管落点一致 **327/378 = 86.5%**、会变 **51 手且全是同层换点（0 处换层）** ⇒
  「战术层能不能回溯」第一次有了可检验答案：**层逐手可复现，落点在 86.5%–100% 之间**。
  配套考古文档 [docs/plans/2026-10-04-tactics-archaeology.md](docs/plans/2026-10-04-tactics-archaeology.md)（267 行）：
  **14/14 档的 `budget`（15 键逐键）/`sound`/`openingMin`/`promptFacts` 全部有 git 证据且逐键等于 P1 冻结值**
  ⇒ v1–v13 的 `fidelity` 由 `'approximate'` 升 **`'restored'`**（`v0-off` 档位表无 sha ⇒ 留 `'approximate'`，v14 保持 `'exact'`）；
  同时**否证**前序审计两条（v11 上线预算即 10/3000/6，`14/6000/∞` 只存在于未入库的 `.work/vct-tune*.mjs`；
  prompt 漂移在 P1 后已修）并修正「预算冻结于 `446f976`」（`src/core/tactics-budget.ts` 仅由 `0b3a400` 创建）。
  另补**逐层可达性复核**（考古文档 §6.1）：`threat` 标注「历史层，当前机制表下不可达」，其余 13 层均有指纹覆盖证据。
- **战术档位改动会亮红灯（P2 指纹设施，plan `2026-10-03-tactics-fidelity-and-elo-ladder`）**：接管链原本内嵌在
  [`src/core/jev/client.ts`](src/core/jev/client.ts) 的 `decide()` 里（原 `:374-527`），现在抽成纯函数
  [`src/core/takeover.ts`](src/core/takeover.ts)：`TAKEOVER_ORDER`（14 层权威顺序）+ `TAKEOVER_LABEL`（中文层名）+
  `pickTakeover({engine, st, tactics, mech, criteria, legal, pairs, cands, topK, onTime})` → `{notation, layer, bypassed}`
  （`client.ts` 565 → 431 行；抽取零行为变更：30 局面 × 15 档 = 450 行决策面**差异 0 行**）。
  新增 [`test/engines/fingerprint.mjs`](test/engines/fingerprint.mjs)（语料抽取 + `fingerprintOf()` 一趟链拿「事实 + 层 + 落点」+
  `--write`/`--check` + 覆盖表）、[`test/parity/tactics-fingerprints.json`](test/parity/tactics-fingerprints.json)
  （**14 局面 × 15 档 = 210 行**：归档抽样早 4/中 4/晚 2 + 具名夹具 4 个；生成 24.0 s）与
  [`test/engines/version-freeze.test.mjs`](test/engines/version-freeze.test.mjs)（5 例：形状 / 逐行重放 / 覆盖与必须覆盖层 /
  与 `decide()` 全链路同解 / 冻结字段完整；已进 `test/engines/runner.mjs` 的 `ALL_MODULES`）。
  **红灯有效**：把 `DEFAULT_BUDGET.vcfNodeLimit` 由 4000 改成 1 ⇒ `⑭b` 报「决策指纹漂移 **32 处**」（v7…v14 的层
  从 `vcfDefense` 变 `parry`/`vctDefense`），还原后立刻全绿 —— 审计 §3.3 的「改一处牵多档」从人工审视变成机械红灯。
  语料规模按实测收缩（原计划 N≈120 ⇒ 约 9 分钟，进不了 CI；早/中盘棋盘稀疏，v12–v14 三档各 ~1.2 s/局面）；
  覆盖 13/14 层，唯一走不到的 `threat` 是**结构性**的：`you:open4` 标签判据（走后 ≥2 个成五点，
  `src/core/engines/gomoku.ts:1063-1064`）与 `chance_points_you` 判据（`src/core/tactics.ts:202`）同源，且凡含
  `threat` 的档（v3 起）都含 `open4`、链里 `open4` 在前 ⇒ 只有「候选集扫不到 open4 点却算得出 chance 点」才可能开火
  （取证：2225 个归档候选 + 双活三/双四合成局面全部 chance=0 或被 `open4` 接管）。引擎套件 **153 例**（+5）。
  决策记录：[ADR-0020](docs/adr/0020-tactics-fidelity-freeze.md)。
- **战术档位可冻结（P1 冻结层，plan `2026-10-03-tactics-fidelity-and-elo-ladder`）**：新增
  [`src/core/tactics-budget.ts`](src/core/tactics-budget.ts) —— `EngineBudget`（15 个搜索上限）+ `DEFAULT_BUDGET`
  （= 冻结当天的常量，逐字）+ `BUDGET_KEYS` + `budgetOf()`（写错/非正数一律回落默认 ⇒ **预算写错的后果只能是少看见**）
  + `sameBudget()`。15 条档位记录各增 `budget`/`sound`/`openingMin`/`promptFacts`/`fidelity`（统一缺省常量 `FROZEN`，
  逐档只写偏离项），`selfTest()` 增断言（15 个预算字段齐全且为正、`sound === (rank >= 9)` 记历史事实、`fidelity` 合法）。
  `computeTactics` 按档下传预算：`vcfWin`（`sound`/`nodeLimit`/`movesMax`）、`live3Deny`（`evalMax`）、
  `vctDefense`（`keep`/`vcfPlies`/`pressureLimit`）、`pressureCut`（`keep`）、开局短路改读 `openingMin`；
  `attachFacts()` 增 `opts.mech` **逐句过滤**（句面逐字不变，老档不再收到自己没有的机制句），
  `src/core/jev/client.ts` 用新增的 `mechOf(opts.tacticsVersion)` 走同一解析路径。
  **零行为变更证据**：基线取自干净 HEAD `446f976`（15 档 × 120 真实归档局面 = 1800 行），改后复跑同一脚本
  ⇒ `tac` 与 `ins` **全部 0 差异**；过滤效果量化（40 局面）：v12–v14 文本 0 差异、v11 少 9600 字符、
  v10 19360、v7–v9 37560、v3–v6 51280、v1/v2 67520、v0 79200；sound 正对照：哨兵局面缺省不报胜、
  `sound:false` 报出 `F5→F6→E5`，档位级 v7 报 `F5`、v9 不报。引擎套件 **148 例**（+4）、vitest **38 文件 / 399 例**。
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
