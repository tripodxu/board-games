# MEMORY.md — 项目记忆

> **约定：新条目一律追加在最上面（倒序），最新在最顶。** 一条一事，写事实与结论，
> 不写客套；带日期的条目格式 `## YYYY-MM-DD · 标题`。
> 本文件是项目级持久记忆（入库、工具无关）。各 agent 工具自己的记忆/指针

---

> **⛳ 置顶约束（不是条目，先于一切战术 / 实验工作）——2026-10-02 项目所有者定**
>
> 1. **不吃搜索**：能一眼看清的简单规则、快而不依赖长思考的才做；往**深搜 / 强评估函数**靠的不做。
>    已有搜索层只做减法或纠偏（收紧预算、修语义偏差），不加深。
> 2. **不唯胜率**：胜 / 和 / 负一起报，**不败率**与败局质量同等重要；**和棋可以接受、有时应该追求**。
>    「把和棋转成胜局」不是默认功绩，「负局不增加」才是及格线。
>
> 落地位置：[AGENTS.md](../../AGENTS.md) §2 硬性规则 10–11、[README.md](../../README.md) 首节、
> [agents/playbooks.md](../agents/playbooks.md) §0。背景（v10/v11 复盘：两局败局都出在「算不出强制胜」的局面，
> 而不是漏杀）见下方 2026-10-02 的 v11 条目「仍未闭环」。

---

---

## 2026-10-06 · v14-plus 的两条设计纪律：先画机制矩阵再谈「整合」；预算调参只能新开一档

- **「取其精华」前先画机制矩阵**：v14 已是全梯级超集（逐版叠加的 14 层链：v10 live3 两层 + v11 vctAttack +
  v12 vctDefense + v13 pressureGate + v14 live3Fresh）——「把各版本整合起来」类需求的真实空间在
  **减法与纠偏**，不在加机制；且比分分辨率（±20pt/20 局）决定了任何行为变更只能做**机制层验证**
  （指纹零漂移 + 双档重放逐手比对 + 历史夹具回归），别许诺比分收益。
- **预算冻结原则（ADR-0020）的合法调参路径只有「新开一档」**：budget 是每档身份的一部分，改老档 = 改历史。
  v14-plus 用 `{ ...DEFAULT_BUDGET, vctDefMax: 8, vctDefKeep: 2, pressureCutMax: 80 }` 显式覆写三键、
  其余逐键继承；fidelity 仍 exact——判据是 **mech 集相同 ⇒ attachFacts 句集逐字一致**，预算不在 prompt 里。
- 阶梯预设 `VERSION_SPECS` 是历史批次形状（被单测钉死：L1=10 对 / L2=15 对 / L4=10 对），**新档进实验
  用 `--identities` 显式指定，别往预设里加臂**（加臂 = 篡改 L1/L2/L4 的含义）。
- 硬约束备忘：登记表自检要求 commit 非空 ⇒ 新档先占位 `pending`、提交后回填真实 sha；
  **部署未提交的代码会让新棋谱的 `code_version` 挂错 sha** ——「先提交再部署」是归因纪律，不是流程洁癖。

---

## 2026-10-06 · 从 Windows 本机给远端 shell 传 POSIX 路径参数：MSYS 会改写（vplus1 启动失败复盘）

- 现象：阶梯在本机启动后远端 worker 秒死（pid 文件在、无 progress、无 checkpoint），远端 bash 报
  `[: C:/Program: binary operator expected`——命令行**显式**传的 `--key-file /root/.jev-key` 被
  Git Bash 的 MSYS 路径改写成了 `C:/Program Files/Git/root/.jev-key`（node 是 Windows 二进制，
  argv 进它之前已被转换），远端命令模板里的 `[ -f <keyFile> ]` 于是拿到带空格的 Windows 路径。
  脚本**内部默认值**（`/root/.jev-key`）不走 argv，所以历史轮次（不传这俩参数）从未触发。
- 修法：`MSYS2_ARG_CONV_EXCL="*"` 前缀，或干脆不传与默认值相同的参数。tag 沿用机制正常工作：
  重跑同命令复用 tag、checkpoint 逐局跳过，只补没跑的局。
- 附带口径：编排器轮询 ssh 连续失败（⚠ ×N）只说明**本地链路抖**，远端 nohup worker 不受影响；
  判 worker 死活要用 `ps -p <pid>` + progress.json，别把轮询失败当 worker 死亡。

---

## 2026-10-06 · 验证轮协议的沉淀：单变量 + 预注册判定 + 「挂起」状态

- v14-plus（35% vs 65%）与 v15（45% vs 55%）两轮配对验证的合并教训：**一次只改一个变量**，
  判定规则跑前写死（负局 ≤4 通过 / 5–6 挂起 / ≥7 永久关闭）——「挂起」是必要的第三态：
  同门 razor-edge 对局里，判据更强的防点会改变行棋轨迹，n=20 的翻转方向不可控，
  既不能判「更好」也不能判「有害」，只能挂起等分辨率。
- 「机制层达标」与「同门比分未转正」可以并存且都是真话：vctFirst 修的 6 处漏防是判据级事实
  （拆完对手 VCF+VCT 全无 vs 只拆纯四），但五子棋里「防得更全」≠「局面更好」——
  对手被清空武器后还能织新网，而占链点与占邻域点的行棋轨迹差异在同门局里足以翻转结果。
- 探针的竞速误报要过滤：进攻层手位（vctAttack/vcfAttack/win/open4）上的「漏防」标记，
  在我方自己有杀链时是**正确竞速**——判漏防必须限定在防御层手位上。

---

## 2026-10-06 · 败局逐手探针的纪律：判据弱的层不许排在判据强的层前面开火

- v14 输 v13 的 4 局里 2 局同一死法：vcfDefense（只验纯四链，判据弱）先开火拿走「只拆纯四」的点，
  vctDefense（拆完对手 VCF+VCT 全无，判据强）被「前者没找到点」的门挡住——**全拆点明明存在**
  （vorder1 29ced20c ply65 的 K10、3ba614a0 ply24 的 E6，都在对手链上）。教训：**接管链的排序就是
  优先级承诺**；给已有的层换更强判据、或新增相邻层时，必须审计它与相邻弱判据层的先后关系，
  否则强层永远轮不到——这比「漏加层」隐蔽得多，因为每层单独看都在正常工作。
- 口径三条：①「层一致率 100%」是同版本回放的口径，跨版本找差异要跑**双档重放逐手比对**
  （v13≡v14 零分岔直接排除了「v14 特有行为致败」）；② 逐手探针的「无拆点」要注明是
  「vctDefense 候选预算内没找到」还是「全盘不存在」，两者差一个枚举上限；③ loss-report 的必败后缀
  只用 VCF 判据，vctDefense 用 VCF+VCT——两者不一致时（suffix 起点 > 探针的「无拆点」起点），
  恰恰说明残留的是活三逼迫混合链，这本身就是线索而不是矛盾。

---

## 2026-10-06 · 优化轮三条教训：D1 写配额把索引也算进去、ADR 的「后果」节藏着未实现项、先用小资产测吞吐再判慢

- **D1 的「行写入」计数包含索引条目**：导入 624 局（37,425 逐手 + 624 局 + 32 轮 = 38,081 行）仪表盘报
  `rows_written_24h = 81,415`——差值正是主键/二级索引条目的写入。**估算写配额要按「行数 × (1 + 索引数)」算**，
  逐手表哪怕只有主键也是 ×2。免费档 10 万行/天，一次批量导入就可能触发 80% 警戒（按 UTC 日滚动重置）。
- **读 ADR 要连「后果/缺点」一节一起读**：ADR-0013 原文写着「仅写接口与 /api/jev 计数，**读接口不计数或采样**」，
  但实现一直对读接口全量写限流行（比 ADR 自己更严），单 IP 满速读可烧 17.3 万行写/日。「当时没做的取舍」
  不会出现在待办清单里，只在 ADR 的代价段落里——2026-10-06 优化轮把它兑现（read 桶放行）。
- **判「接口慢」先分离链路与服务端**：本机到 Cloudflare 的直连吞吐当天实测只有 ~58 KB/s（240 KB 资产 4.1 s），
  13 MB 的导出光传输就要 ~4 分钟——直接计时会把服务端优化冤判成超时。先 `curl` 一个同源静态资产测吞吐，
  再决定怎么量服务端耗时。另： workers.dev/assets 的 hash 会随部署变，拿旧 URL 测速会拿到 SPA 兜底页。

---

## 2026-10-06 · 生产部署 + 阶梯 624 局入 D1：三则可复用的教训

- 事实：业主批准的一次性收口——`npm run deploy` ⇒ 生产版本 `b2deae8b`（复验：线上包 `X-Jev-`/`commandcode`/`上游兜底` 字面量全出现，`smoke:live` 30/30）；
  阶梯五批 **624 局 / 37425 手 / 32 轮** 经 `.work/ladder-import.mjs`（一次性驱动）导入线上 D1，终态 **936 / 56723 / 60**（uid 无重复、孤儿 0、
  `provider`/`cands_sent` 各 21378 手）；快照重导 32.4 MB、`verify:backup --structural` 绿。
- 教训 ①（映射口径）：`gameUidSource()`（`record-map.ts:285`）只服务「老客户端没带 gameUid」的合成（`sha1(exported|notation)`）；
  **payload 自带 UUID 时必须优先取 payload 的**——否则同一局走导入与走 `/api/games` 会算出两对键，违反 AGENTS §5「同一对键」铁律。
  驱动里用「payload 自带 gameUid 的局 = 624/624」断言钉住。
- 教训 ②（列清单要跟迁移走）：`import-archive.mjs` 的 moveCols 停在 0002 之前（13 列，缺 tac_ms / cands_sent / cands_labeled / provider / prob_source）
  ——它是历史导入的产物，**不是「当前全列清单」**；再写导入要以 record-map 的 MoveRow 键为准逐列核对，否则新归因列静默变 NULL（自检也查不出来，
  因为内存 DDL 同样是旧的——这次连 0002–0004 的 DDL 一起灌进自检库才暴露得了）。
- 教训 ③（环境）：本机 socks5 代理（127.0.0.1:10808）不常在；**代理死 ≠ 没网**——清掉 `HTTP(S)_PROXY` 后直连 Cloudflare 可用
  （wrangler / D1 导出 / 线上 curl 全通）。大分片（2 MB）传输偶发 `fetch failed` ⇒ 每分片 3 次重试 + DO NOTHING 幂等续传即可收尾
  （第一次中断时 0001 分片已完整进库，重跑无害）。旧记录「本机 Node 无外网」是当时网络状态，不是永久事实。

---

## 2026-10-06 · D1 读路径恢复、新鲜快照落地；`verify:backup` 会被「空日期目录」误报

- 本机重新 OAuth 登录后 `wrangler d1 execute --remote` 与 `db:export` 恢复（此前 7403）⇒ 当天重导：`backups/export.sql` =
  **312 局 / 19298 手 / 28 轮 / 10.4 MB**，`verify:backup --structural` 绿（payload 逐字节一致、派生列零漂移）；
  旧迁移快照保留为 `export-2026-10-01-stale.sql`。2026-10-01 之后约 256 局「只在 D1 一处」的风险就此解除；
  **CI 自动备份仍坏**（`gh secret list` 同日复查仍为空），桶推送仍等 `BUCKET_*` 四元组。
- 坑：首次校验报 **28 局「payload 对不上源文件」**——全是 2026-10-01 的局，撞上 `games/2026-10-01/` 这个**空的残留目录壳**
  （源文件当年当旧快照自动提交删掉了，git 不跟踪空目录，目录壳留在本机）：校验器按「日期目录存在 ⇒ 找文件逐字节比对」
  （`scripts/verify-backup.mjs:75-76`），目录在而文件不在就报不一致。`rmdir` 空壳后复跑即绿，258 局全部正确归入「冻结期后新数据」。
- 教训：判「备份不可信」之前先分清失败走的是哪条判定路径——是**数据坏了**还是**参照物没了**；旁证是 CI 的全新 checkout
  没有空目录，同一份导出在 CI 上本来就会绿。`existsSync(dir)` 这种按目录存在性分流的结构对「目录壳残留」不免疫。

---

## 2026-10-06 · 业主三条拍板（版本排序 A / P7 关闭 / 桶定向）+ 一条口径修正：线上 Jev 是 BYOK，「线上无上游」是误报

- **三条拍板**：① 版本排序**选 A**——正式接受「v10–v14 不可分」（vorder1 闭环 + 第二把尺子 10 对 9 翻转双证据），不再堆配对局；
  ② **P7 `--rev` 逃生门关闭**——L2/L4 共 560 局无逐字复现老版本的需求，考古 `restored` 标注够用（阶梯计划 §9 第 5 条结案）；
  ③ **对象桶：用与现有实验数据同一只桶**（同 endpoint/同凭据）——`BUCKET_*` 四元组按铁律 7 不入仓库，
  注入运行环境（box/本机 env）后 `batch-bucket.mjs push` 即用；凭据到位后要把 box 上五批产物补推一次（阶梯计划 §9 第 6 条定向）。
- **口径修正（重要）**：2026-10-05 写的「生产 Worker 兜底未部署 ⇒ 线上 Jev 没有可用上游」**是误报**——
  线上 `/api/jev` 是 **BYOK**（业主口径：线上 Jev 仅支持用户自己提供 base url 和 api key，业主的 key 只用于实验面；
  代码侧 key 取值序 = 请求头 > env > 请求体、缺 key 401，`src/worker/routes/jev.ts:97`）⇒ 主 key 402 只影响**实验面**，
  不影响线上用户自带 key 的对弈。生产 Worker 停在 C0 的真实问题只剩「功能落后于 main」
  （无兜底代码、无逐手 `provider` 落库、报表无兜底分桶），重新部署仍待 secrets，紧迫性从「线上功能不可用」降为「功能落后」。
- 教训：把「业主 key 402」外推成「线上没有上游」之前，先核对**生产的 key 依赖面**——生产是 BYOK-only 这一条一直在
  `jev.ts` 的头注与 key 取值序里，当时只看了自己写的待批项措辞。

---

## 2026-10-05 · 主上游 key 额度耗尽会在真实实验里自己触发兜底：`round-10` 报 402 ⇒ 345 手走 backup

- 现场：`rapfihi1` 的 `round-10`（`v14-live3-fresh@10000`）第 10 局第 8 手，主上游回 **HTTP 402**（`auth` 类）⇒ 按 `src/core/jev/providers.ts` 的
  判据**立刻切**兜底（探活 HTTP 200 / 51 ms），此后该轮 11 条 `kind:"provider"` 事件、**345 手** `ai.prov='backup'`（占该轮 Jev 手 69%）。
  ⇒ 「跑长实验前先确认主 key 还活着」应进 checklist；402/401 也可能只是**额度**而非失效 —— 2026-10-05 13:15 本机独立复现确认是**账号级余额**
  （合法请求 ⇒ `402 billing_error: Your organization has no available TypeSafe API credits`；同一 key 空体打 ⇒ 422 说明认证通过），
  且 box key 与本地 key 不是同一串（sha256 前 12 位 `499b5d636bc6` vs `bbe6db022be4`）却都 402 ⇒ **换 key 绕不过，除非换账号或充值**。
- 直连面的开关是**兜底 key 文件**（`--backup-key-file` / box `/root/.cc-key`），不是环境变量；Worker 面才是 `vars.JEV_FAILOVER`。
  **兜底 key 缺失不报错**（= 静默不启用切换），只有 `--expect-backup` 才退码 2 ⇒ 想验证兜底必须带这个开关。
- 逐手归因在产物里可核：归档 payload `ai.prov` / `ai.probs`（`migrations/0004_move_provider.sql` 两列）+ `events.jsonl` 的 `kind:"provider"`；
  报表会印「上游兜底 N 手（未计入主口径）」。判据表：`auth`=401/402/403 **立刻切**；`rate-limit`=429/529 **重试用尽**后切；
  `server`=5xx 连续 3 次才切；其余 4xx 不切；网络错/超时**只重试不切**。

## 2026-10-05 · `levelPower()` 印的「要多少局」是**量级**不是边界：整数化 0.3 pt 就能翻面

- 它是估算（假设观测率=真实率、两档同 n），实现把 `rate × n` **四舍五入成整数手数**再套 Wilson ⇒ n 恰在临界时结论会翻。
  实例：`2000→7000` 印「约需 100 局/档」，而实测 100 局时两段区间仍**擦边重叠 0.3 pt**（73.5% 整数化成 74 手 ⇒ 下界 64.6%；实测 72 手 ⇒ 上界 64.4%）。
- 引用纪律：这个数只能说「加样本能买到什么分辨率」的量级；**判「分不分得开」永远看实测区间**（报表 §2 的 Wilson）。
  同理，跨档「不重叠」若只擦边（≤1 pt），补样本后翻面是常态 —— 不许当结论。

## 2026-10-05 · 改 `--games` 加量跑同一批次：tag 仍沿用、已跑的局由 checkpoint 跳过，不会重放

- **机制**（2026-10-05 逐行核过）：`scripts/lib/ladder.mjs:405-411 stateMatchesLadder()` 要求轮数/轮号/`label`/**`games`** 全同，
  所以 `--games 20 → 40` 会让本地 `ladder.json` 形状不符，`scripts/experiment-ladder.mjs:495-497` 会打印
  「以本次计划重建」；但 `withReusedTags()`（`scripts/lib/ladder.mjs:420-429`，在 CLI `:487` 的 `!force` 分支里**先于**形状重建执行）
  **只按轮号匹配** `oldState.rounds.find(x => x.round === r.round && x.tag)`，不要求 `games` 相同
  ⇒ tag 沿用 ⇒ `scripts/experiment-worker.mjs:328-339 ckptAction(prev, tag)` 对 `tag` 相同的局返回 `skip`
  ⇒ 前 20 局从 checkpoint 直接计入 summary（`:226` 注释：`ok` 与 `skipped` 都要计），只有第 21–40 局真跑。
- **前提与风险**：① 必须用**同一个 `--batch`**（换批次 = 换 tag = 整轮重放）；② 本地 `.work/remote/<批次>/ladder.json`
  不能丢（丢了就退到远端 `plans/round-N.json` 的 tag，再不行才新生成）；③ tag 若真的变了，`experiment-ladder.mjs:557-565`
  会把旧产物挪到 `stale-round-N-<旧tag>/`，否则 W/D/L 会把两次尝试相加；④ 形状变化是**全局的** —— `--games 40` 会让每轮都补 20 局，
  不能只挑高档那几轮（想只跑一段只能用 `--identities` 另开批次）。
- checkpoint 是**逐局一个文件**：`<plan.outDir>/checkpoint/round-<r>-game-<n>.json`。
- **实测（2026-10-05，本机 mock 双臂、零配额、不碰 box）**：`.work/topup-plan.json`（`tag exp-topup1-r1`、`outDir .work/remote/topup1/round-1`）
  先 `games: 2` 跑一遍（`games.jsonl` 2 行、2 个 checkpoint），再把 `games` 改成 `4` 用**同一个 tag** 重跑：
  worker 打 `game-1 已完成（ok），跳过` / `game-2 已完成（ok），跳过`，只真跑 game-3（12 手）/game-4（38 手）；
  收尾 `games.jsonl` **4 行 / 4 个不同 `gameUid`**（无重复），`round-summary.json` 的 `games[]` 依次是
  `skipped/skipped/ok/ok`（skipped 那两条**带着 plies 与 winner**，不是空壳）。⇒ 「同 tag 加量 = 只补新局」这条是实测过的，不只是读码结论。
  注意归档行里的局号字段叫 **`expGameNo`**（不是 `gameNo`），按 `gameNo` 过滤会得到空集。

## 2026-10-05 · 跨档/跨批合并值先比**组成**：出场的身份集合不同，落差里就混着组成差异

- **事实**：L4 跑到 7/10 轮时「`@7000` 比 `@2000` 掉 19.8 pt」是不可引用的 —— `@7000` 那一档（n=80）
  **缺 `v14-live3-fresh`**，而 v14 自己的三档是 95.0 / 82.5 / 75.0（最高的一版）；它一缺，高档的合并值被压低，
  落差里混的是「少了 v14」而不是纯档位效应。同理 `@10000`（n=60）还缺 v13、v14。
  ⇒ 纪律：把档位合并值连成曲线之前，先逐档列「出场的身份/版本集合」，集合不同就**只报单档值、不报档间 Δ**
  （`.work/l4-fill.mjs` 已内置这条检查，会自己打「⚠ 组成不一致」；**同一条检查 2026-10-05 起也进了正式报表** ——
  `scripts/lib/report.mjs` 的 `curveComposition()` 会让 §2 曲线自带这行，集合补齐后自动消失）。
- **擦边不重叠不是结论**：同一批里 `@2000` 73.5% [64.1–81.2] vs `@7000` 51.7% [39.3–63.8] 的上界/下界只差 **0.3 pt**
  ⇒ 当时判成「Wilson 不重叠」，样本从 60 涨到 80 局后立刻变回重叠。**差 1 pt 以内的区间边界不要写成「不重叠」**，
  至少同时报两个 n 下的读数，或直接等样本补齐。
- 一般化：任何「合并值」（跨档、跨版本、跨批次）都在悄悄做一次**加权**；只有当权重（组成）一致时，
  合并值之间的比较才等于要比较的那个变量。

## 2026-10-05 · 想知道线上停在哪一版：抓静态包 grep **功能字面量**（`/api/health` 的 `schema` 不是代码版本）

- **别读反的字段**：`GET /api/health` 的 `schema` 来自 `src/worker/routes/health.ts:46-49`
  `SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1` ⇒ 它只说明 **D1 迁移应用到了哪一版**，
  与 Worker / 前端代码新旧**无关**：线上报 `schema: "0004_move_provider.sql"` 时，代码完全可能是 0004 之前的构建。
- **可靠判据 = 生产构建产物里的字符串字面量**：`https://jevqipan.logicc.top/` 引用的 `assets/index-<hash>.js`
  是 `vite build` 的产物，**字符串字面量（版本 id、字段名、header 名、UI 文案）会原样保留**，
  注释与局部变量名会被压缩丢弃 ⇒ 只能拿字面量做判据。
- **实测（2026-10-05）**：该包 206,688 B，`v14-live3-fresh` 4 次 / `candsSent` 18 / `candsLabeled` 13 /
  `候选发评标` 2 在，而 `X-Jev-` / `commandcode` / `primary` / `backup`（C2）与 `上游兜底` / `未计入主口径`（C3）
  **全为 0** ⇒ 线上 = C0（`ffbcbf7`）之后、C2（`e70fcd1`）之前，**生产没有上游兜底**（主家 401 直接报错给用户）。
  同类事实：`gh run list --workflow=deploy.yml` **一条都没有**（`deploy.yml` 是 `workflow_dispatch`，
  按设计不随 push 跑）⇒ 线上历次都是本地 `npm run deploy` 推的，没有 CI 部署记录可查。
- **复验手法**：部署后重新抓线上包 grep `X-Jev-`，出现即说明含 C2；grep 版本 id 可确认战术档位。

## 2026-10-05 · `vcfWin()` 的入口前提是「双方无一步杀」：攻方已一手成五时它报 `false`，**永远报不出「隔 1 手」**

- **事实**：`engine.vcfWin(st, attackerId, plies)` 的逼迫着法生成器只收「落子后造出 ≥1 个**新**致胜点」的着法
  （`src/core/engines/gomoku.ts:258-279` + `winsAfter` `:222-254`：找**含新子的** 5 窗口里 4 子 + 1 空）——
  **直接成五那一手窗口已满、造不出新致胜点，被排除**；`:220-221` 的注释写明入口前提「双方无一步杀」。
- **最小复现**（`.work/vcf-precondition-check.mjs`）：黑 (7,4)(7,5)(7,6)(7,7) 一条四、轮到黑
  ⇒ `getLegalMoves` 里 D8/I8 两手成五（`getStatus().over`），而 `vcfWin(st,'black',9) = {win:false, first:null}`、
  `vctWin = {win:true, first:'D8', line:['D8']}`。
- **踩的坑**：拿裸 `vcfWin` 当「从哪一手起必败」的 oracle ⇒ 必败起点被系统性后推，且**h1 恒为 0**。
  L2 报告初版据此写的「VCF 只解释 13–14/49 局、查不到 35 局」是**下界产物**，不是「VCF 解释不了」；
  改用「一手成五 ∨ ≤plies 手 VCF」后同一批是 **49/49 局**（L2）+ **59/59 局**（高思考档）。
- **正确口径**：权威「一步成五」判据 = 遍历 `engine.getLegalMoves(st)` → `applyMove` → `getStatus().over && winner === side`
  （引擎对外**没有**暴露 `hasFivePoint`/`fiveCompletions`，只有 `vcfWin/vctWin/live3*/vctDefense/fourPressure/pressureCut`，
  `:1297-1316`）；要深度再用 `vctWin`（它每个节点先判 `fivePointOf`，所以认一手成五）。
- **同族事实**：`vctWin` 的**根节点**有闸门 `vctMoves(board, A, movesMax).length === 0 ⇒ {win:false}`（`:682-683`）
  ⇒ 「有一手成五但一个逼迫手都没有」的根局面也会漏判 —— 判「必败」永远要自己先补一手成五这一条。
  引擎自己在 `vctDefense()`（`:772-782`）就是这么写的：`let still = hasFivePoint(board, A); if (!still) { vcfWin… } if (!still) { vctWin… }`。
- **一般化**：把**判定类**接口当 oracle 前，先读它的入口前提与返回形状 —— 这类「前提不满足就静默 `false`」的漏判
  不会报错，只会让统计数字整体偏移一个方向（本仓已踩两次：`!!vcfWin(...)` 恒真、`vcfWin` 漏一手成五）。

## 2026-10-05 · 归档棋谱里的 `channel` 是 `'rapfi'`（不是 `'rapfi||500'`）；判定写错会静默丢掉 Rapfi 执黑的整半局

- **事实**：`games.jsonl` 每行的 `blackChannel`/`whiteChannel` 是**通道名**（`'official'` / `'rapfi'` / `'human'` / `'mock'`），
  档位在另一个字段（`blackThink`/`whiteThink`）；`'rapfi||500'` 那种形状是 `identityOf()` 拼出来的**身份串**，只出现在报表/分身层面。
  探针里写 `channel.startsWith('rapfi|')` ⇒ 恒 false ⇒ **Rapfi 执黑的 10/20 局被静默跳过**，
  第一版样本 202/420、每格 n 恰好 10（正确是 20）—— 这种「整齐减半」很容易被误读成「这一档只跑了 10 局」。
- **正确写法**：判定用 `id === 'rapfi' || id.startsWith('rapfi|')`（兼容两种口径），或直接照 `scripts/lib/batch-elo.mjs` 的
  `identityOf({ channel, tactics, thinkMs })` 先拼身份串再比；`scripts/lib/experiment-*.mjs` 侧同理。
- **同一条家族**：和棋在归档 payload 里**没有 `winner` 字段**（`undefined`）⇒ 当异常局丢掉会得出「全程零和棋」，
  权威口径是 `result` 串 `/^和棋(?:（(.+?)）)?\s*$/`（`scripts/lib/batch-elo.mjs:66-76`，与 `src/shared/record-map.ts` `parseResult()` 同形）。
- **一般化**：分析脚本的样本量出现「整齐的整数倍缩减」时，先怀疑**判定条件恒假**（往往是拿身份串去比通道名），
  而不是先怀疑数据缺失 —— 静默过滤比报错更难发现。

## 2026-10-05 · 「顺序一致」不能按整条序**字符串**比对：各对手上可出场的版本集合不同，会判出假的不一致

- **事实**：版本 × 共同对手矩阵的判读句初版拿「各对手上的点估计序」整串比（`orders.every(o => o.order.join(' > ') === head)`），
  实测 `l2n1 + vorder1 + rapfihi1`（460 局）印出「5 个共同对手里只有 1 个与『v11 > v10』同序」——
  可 `@10000` 那一档只有 v10/v11 两个版本出场（序是 2 元），`@2000` 有五版（序是 5 元），
  字符串永远不相等 ⇒ 报出的「不一致」是假的；`head0()` 在并列时按字典序取最小，选中的头部序也很任意。
- **修法**：改成**逐对看差值符号** —— 对在第 ≥2 个共同对手上都出场的版本对，取 `rate_x − rate_y`，
  非零差值同号 ⇒ 无翻转（`consistent=true`）；差值为 0 记「并列档」（那一档不给序，**不算翻转**）；
  全部并列 ⇒ 写「全平、不可分」。判读句里的差值要按**胜者方向**印（`b > a` 时把差值取反），
  否则会出现「写着 `v11 > v10`、差值却是 `-50.0pt`」的自相矛盾。
- **一般化**：比较「排序结论」时不要比字符串；比**成对的方向**（符号）。可用集合不同、元素数不同的两个序，
  字符串永远不等，但逐对方向完全可以一致 —— 这类「看起来在比较、其实在比格式」的判据，测出来的差异都是噪声。
- **同批落地**：`versionMatrix()` / `versionMatrixBlock()`（`scripts/lib/report.mjs`），
  单测 `test/scripts/report.spec.mjs` 加 5 例（现 43 例）；首次实测唯一在全部 5 档同向的版本对是 `v11 > v10`。

## 2026-10-05 · 合并多批的报表若沿用「第一个根」的名字，会覆盖单批产物、且标题漏掉其它批

- **事实**：`scripts/experiment-report.mjs` 原来 `batchId = batch || path.basename(dirs[0])`。
  `--dir .work/remote/l2n1,.work/remote/vorder1,.work/remote/rapfihi1` 于是自报 `l2n1`：
  ① 报告第一行写成 `# 阶梯报告：l2n1`（读者会以为只有一批）；② 不给 `--out` 时默认落盘
  `.work/l2n1-report.md`，**把单批报表覆盖掉**（`.work/` 里的报表是给业主看的产物，不是缓存）。
- **修法**：`batchId = batch || dirs.map((d) => path.basename(d)).filter(Boolean).join('+')`，
  实测 `✓ l2n1+vorder1+rapfihi1：380 局 / 9 身份 / 19 对`、标题 `# 阶梯报告：l2n1+vorder1+rapfihi1`；
  单测钉住 `model.batchId` 与 `model.dirs`（`test/scripts/report.spec.mjs` 现 37 例）。
- **一般化**：凡是「多输入合成一个产物」的命令行，默认输出名必须能唯一区分输入集合；
  只取第一个输入的名字 = 静默覆盖 + 误导性标题，两者都不会报错。

## 2026-10-05 · 门禁命令与 `git commit` 串在一条命令里、且只看输出尾部 ⇒ 门禁失败被吞掉，坏提交照样推上去

- **事实**：`npm run check:docs 2>&1 | Select-Object -Last 3` 只看尾部 3 行时，输出正好停在
  「✓ status 最后更新…／全部通过」和「**1 项未通过**」之间 —— 我把 `1 项未通过` 当成上一批的输出，
  照常 commit + push，推送后才发现 `docs\status.md` 里有一条死链（相对链接少了 `plans/` 前缀），
  CI run 直接红（`53ddf26`，已被 `e6f2f3a` 修掉）。
- **做法**：门禁与提交分成两条命令；或者在同一批里显式断言退出码（`if ($LASTEXITCODE -ne 0) { throw }`），
  并且 grep 失败标记（`✗|未通过|FAIL|error`）而不是只看尾部若干行。**「输出里没有失败字样」≠「门禁通过」**。
- **附带**：`docs/status.md` 里指向 `docs/plans/**` 的链接必须写 `plans/…`（`check:docs` 按相对路径解析）。

## 2026-10-05 · 探针的数字随**窗口参数**变：同一个「不可逆点」按 `--plies 7` 是 13/49、按 `--plies 9` 是 14/49

- **事实**：L2 败局追因的「不可逆点」（自此以后我方每一步都仍必败的最早一手）在 7 手 VCF 探针下是
  **13/49**（21–92 手、均 59.4），在 9 手探针下是 **14/49**（23–108 手、均 57.9）—— 手数上限越大，
  越能查到「早就必败」。两者都对，混在一句话里就是错的。
- **处置**：做成工具后**统一默认 9 手**（`scripts/loss-report.mjs`），老文档改引用时必须写清是哪一档
  （`--plies 7` / `--plies 9`）；报告里的追因行也把 `≤N 手 VCF` 的 N 印在句子里。
- **自查口径**：任何「X/N 局查得到」的探针结论，都要能回答「窗口/阈值是多少、把它调大一档会怎样」。
- **后注（同日）**：这里引用的 `13/49`、`14/49` 后来被证明**还叠着另一个错**（裸 `vcfWin` 漏判「对手已一手成五」）
  ⇒ 正确读数是 **49/49**；见本文件置顶的 `vcfWin()` 入口前提条目。窗口参数的教训本身仍然成立。

## 2026-10-05 · 引擎的判定函数返回**对象**不是布尔：`!!engine.vcfWin(...)` 恒真，探针会得出「49 局败局早就全死了」这种假结论

- **事实**：`vcfWin(st, attackerId, maxPlies, opts)` 返回 `{ win, first, line }`，**永远是真值**。
  我第一次写败局探针时用了 `win = !!engine.vcfWin(...)` ⇒ 49 局败局**每一局**的「我方最后 6 手」都被判成
  「对手已有 VCF 必杀」，还得出「不可逆点全在第 1–2 手」的荒谬分布（第 1 手盘上只有 1 颗子）。
  正确写法 `engine.vcfWin(...).win === true` 之后：只有 13–14/49 局有必杀后缀，不可逆点落在 21–92 手。
  （**后注（同日）**：这个 13–14/49 仍然偏低 —— 裸 `vcfWin` 另有「漏判对手已一手成五」的入口前提问题，
  正确读数是 49/49，见本文件置顶条目；`!!` 恒真这条教训不受影响。）
- **教训**：判定类 API 返回结构化结果时，`!!obj` / `if (obj)` 是**静默恒真**，比报错危险得多。
  写任何探针前先看一眼返回类型（`src/core/engines/gomoku.ts` 的 `VcfResult`、`vcfWin`/`vctWin` 都是这种）。
- 自查口径：探针结果如果**整齐得可疑**（全真/全假、分布退化到 1–2 手），先怀疑真值判断，再怀疑结论。

## 2026-10-05 · 同一个词在一份报告里不能有两个意思：「得分率」既是胜率又是得分率，和棋多的批次会被读成惨败

- **事实**：报告第 4 节「按身份分开颜色」表原来印两列 `总战绩 = 胜–非胜局` 与 `得分率 = 胜率`，
  而同一份报告第 1 节的「得分率」是 **（胜 + 和/2）÷ 局数**。`vorder1` 跑完拿真数据一看：
  v13 的 11 胜 18 和 11 负被印成 `11–29 ｜ 27.5%` —— 同一身份在第 1 节是 50.0%。
  和棋占 48.3% 的批次里，这两种口径能差一倍，而且「非胜局」写成「负」等于把 18 局和棋算成输。
- **修法**：`colorSplit()` 记 `blackDraws/whiteDraws`；表头写死 `胜–和–负 ｜ 得分率 ｜ 执黑 胜/局 ｜ 执白 胜/局`，
  得分率与第 1 节同口径；单测直接钉三行渲染（`report.spec.mjs` 36 例）。
- **教训**：报表里的**指标名**是契约。同一个词在两处含义不同，比算错更坏 —— 数字都对，读者还是会得出反向结论。
  自查口径：拿一个**和棋多、且和棋能左右观感**的真实批次跑一遍（这次是 `vorder1`：29/60 和棋）。

## 2026-10-05 · 新报表块要拿「形态不同」的真实批次各复跑一遍 —— 合成夹具盖不住形态判断

- **事实**：给报告第 4 节加「版本筛查判读」块（`screenVersions()`）时，单测 7 例全绿（含
  「非筛查形态返回 null」），但块只在 `vorder1`（3 版互相交过手）这种形态上**真跑过**。
  拿 `l2n1` 的 300 局真实数据复跑才暴露：`l2n1` 有 5 个 `official|v*` 身份，却是**全跟 Rapfi 交手**、
  版本之间一对都没排过 ⇒ 块照印，写「只凑齐 0/10 对（版本之间没两两交过手）⇒ 筛查不成立 ⇒ 按 §7 直接跑 L1」。
  这是误导：`l2n1` 根本不是筛查批次，而「直接跑 L1」是给「筛查跑过但判据不过」写的结论。
- **修法**（`813b56b`）：筛查对象**只算彼此真交过手的那几版**（版本 vs Rapfi 的对局不算），版本集合也从
  这些对局里取 —— 整批只有版本 vs Rapfi ⇒ `null`、整块不印；混跑批次（`l2n1` + `vorder1` 一起读）
  只按交过手的子集判，不会因为多出两版就写「只凑齐 3/10 对」。单测加「L2 形态 + 混跑」1 例（共 36 例）。
- **教训**：凡是**按数据形态决定印不印**的报表块，合成夹具只证明「我想到的形态是对的」；必须再拿
  **形态不同**的真实批次（这里是「5 版但只跟 Rapfi 打」）复跑一遍。这一次是靠「顺手拿 `l2n1` 复跑」抓到的，
  不是靠单测。

## 2026-10-05 · 链式夜跑看门狗：窗口按剩余工作量算，且必须能分辨「还在跑」与「编排死了」

- **背景**：`vorder1`（3 对 60 局）之后要自动串上 `rapfihi1`（L4，10 对 200 局）。第一版看门狗
  `.work/chain-l4.ps1` 用**固定 6 h 窗口**（按开工时刻算）+ 只看「本地 `ladder.json` 里有没有 `status=pending` 的轮」。
- **两个问题**：① 窗口会在中途到期 —— `vorder1` 的 round-2 单局已涨到 **~7 分钟**（两个强版本互相守和，12 局里 9 和），
  round-3 还没跑，6 h 根本不够；② 只看 pending 分不清「长局还在跑」与「编排已经死了」。后者若直接起 L4，
  等于用**半截的对照**去解释 L4，而且两个作业同时抢 CPU —— **Rapfi 的思考时间是墙钟，抢 CPU 会让时间档失真**
  （这也是阶梯拒绝 `--parallel` 的原因）。
- **v2 的做法**：窗口放到 **14 h**；游标仍是「pending 清零就开跑」；新增**停滞判定** —— 连续 **45 min**
  本地 `(pending 数, round-2 的 done, elapsedS)` 三元组没有推进时，用一次短 ssh 探远端 `/logs/round-N.pid`
  是否 `kill -0` 活着：活着就重置计时继续等（长局正常），死了就**报警退出 3、不自动起 L4**，交人工复核。
- **通用教训**：远端长跑作业的自动化衔接，判据要落在**产物/进度文件的推进**上（不是「等了多久」），
  并且必须区分「没推进」与「死了」；报错退出比自动开下一条更安全（代价只是一次人工复核）。

## 2026-10-04 · 只读代码得出的「不能设」结论，必须用真引擎验一遍（`INFO max_node` 其实能设）

- **踩的坑**：这天早些时候「只读代码」的勘察把 `src/core/jev/rapfi.ts:240`（只硬编码 `INFO timeout_turn <ms>`）
  加上阶梯计划第 61 行读成「节点预算设不了」，进而写下「**等节点数当不了控制变量**」。当天用真引擎探针**推翻**：
  `INFO max_node <N>` 被静默接受且**按 N 单调生效** —— 同一 12 子中盘局面 + `INFO timeout_turn 3000` 实测
  `N=1 → 7ms／最深深度 0`、`100 → 3ms／8`、`1000 → 2ms／12`、`10000 → 26ms／19`、`100000 → 116ms／29`、
  `1000000 → 1087/1114ms／55`；`N=0`（不限）与 baseline 同为 `2631/2572ms／53`，着法全部同一手 `9,10`。
- **参数名要对**：合法名是 **`max_node` / `max_depth`**；`INFO nodes` / `INFO depth` 会被拒
  （`MESSAGE Unknown Info Parameter: NODES` / `…: DEPTH` + `ERROR Unknown command: <v>`）⇒ 光看「`nodes` 被拒」
  很容易误判成「节点预算不存在」。节点数同时**可读**（`INFO show_detail 1` 的 `MESSAGE` 行）。
- **三条教训**：① **「客户端没用某能力」≠「引擎没有该能力」** —— 本次只证明客户端没发节点预算；
  ② 本仓可能**早就有探针记录**：阶梯计划 §2.1 探针 A 第 54/58/60 行早已实测「`max_node` 被静默接受、
  固定预算 Node 200K 三轮全同」⇒ 下这种否定结论前先读它（这次正是没读、与它冲突）；③ 探针要跑在**不抢计时资源**
  的时候 —— box 正在计 Rapfi 的墙钟，本机探针抢不到它的 CPU，但**同一台机上再起引擎就会**使时间档失真。
- **未变**：客户端仍只发 `INFO timeout_turn <ms>`，在跑的阶梯按**时间档**计时 ⇒ 本轮**不换协议**（换了等于换臂）；
  「等节点数」的公平对比技术上已可行（`max_node` + 固定开局 + 固定预算可逐字复现），但要另开 preset +
  给客户端加可选开关（规则 10：另开计划与 ADR 决定）。探针 `.work/rapfi-node-info-probe.mjs`、`.work/rapfi-maxnode-probe.mjs`。

## 2026-10-04 · 接管层在逐手记录里叫 `move.ai.tac` —— `ai.tv` 是**战术版本**（探针踩过）

- **现象**：写「按接管层统计战绩」的探针时第一版读 `move.ai.tv`，得到的是 `v14-live3-fresh` 这类**版本名**，
  直方图全是版本而不是层；换成 `move.ai.tac` 才拿到 `pressureGate` / `vcfDefense` / `live3Attack` 这些层。
- **口径**：层 = `move.tactics || move.ai.tac`（与 `scripts/lib/tactics-replay.mjs:52 recordedLayerOf()` 同源），
  逐手 `ai` 的字段是 `ch,mdl,conf,p,rank,cands,ms,tv,tacMs,candsSent,candsLabeled,prov,probs`（`tv`=版本、
  `tac`=层）；`ai.tac` **只有战术层真的接了手才有值** —— vorder1 round-1 里 902 手只有 447 手带层，
  所以「接管手数」不等于总局手数。
- **另一条**：阶梯**每局换色**（A/B 交替执黑），按 `side` 聚合等于**按先后手**聚合；要按版本聚合必须读每局
  `blackTactics`/`whiteTactics`（vorder1 round-1：黑方 11 胜 / 白方 4 胜 / 5 和 ⇒ 不分开就会被先手优势带跑）。
- **落地**：`scripts/lib/report.mjs` 的 `layersByResult()` + `endReasons()`（收尾原因、和棋手数、手数分位），
  印在报告第 4 节内、**不参与判强**；和棋是满盘和还是协议和由 `endReason` 一句话钉死。

---

## 2026-10-04 · 官方 systemone 端点对**多余顶层字段**直接 400（curl 夹具不是「客户端真发的体」）

- **现象**：拿 `test/fixtures/jev/commandcode-systemone-2026-10-03.json` 里的 `request` 原样 POST
  `https://api.typesafe.ai/v1/systemone`（只把 `model` 换成 `jev-latest`）⇒ **HTTP 400**
  `{"detail":{"error_type":"api_usage_error","message":"Invalid request."}}`，连「不带任何采样字段」的 baseline 都全败。
- **原因**：那份夹具是 **curl 捕获**的，顶层多了一个 `options` 数组；而客户端真正发的只有三个字段 ——
  `src/core/jev/client.ts:208`：`const payload = { state: body.state, model: attempt.provider.model, questions: body.questions };`。
  官方端点 schema 收得很紧，**多一个顶层字段就 400**（commandcode 兜底网关当时容忍了它 ⇒ 两边宽容度不同）。
- **顺带结案（计划 §9 第 1 条）**：`temperature: 0`、`seed: 1234`、两者都给、`top_p: 1` **四次全 400** ⇒
  上游**没有**冻结采样这条路，「靠冻结采样把 5 pt 分辨率做进 100 局」的想法不成立，**`--model-params` 开关不必做**。
- **通用教训**：① 探针/复现要以**客户端代码里的体**为准（`client.ts` 的 payload 三元组），别拿 curl 手写体当基准；
  ② 上游对未知字段是**硬拒**而不是忽略，凡是「加个字段试试」的改动都要先跑一次单请求看状态码。
- 探针：`scripts/probe-model-params.mjs`（只读，`--dry-run` 零请求；实测产物 `.work/probe-model-params.json`）。

---

## 2026-10-04 · 固定窗口限流的用例会在窗口边界上随机红（CI 实测一次）

- **现象**：`test/worker/jev.spec.ts` 的「桶满后 429 且带 Retry-After」在 CI 上红成
  `AssertionError: expected 400 to be 429`（本地跑同一份代码全绿，重跑就好）。
- **原因**：限流是 D1 **固定窗口**（`windowStartOf()` 按 60 s 向下取整）。用例用 60 次「形状不合法」的请求
  灌满桶，若这几十毫秒正好跨过窗口边界，计数被重置 ⇒ 「桶满后第一次」仍然是 400。概率 ≈ 灌桶耗时 / 60 s。
- **改法**：读首个响应的 `X-RateLimit-Reset`（窗口起始 epoch 秒），**按当前窗口判满** —— 窗没翻就 429，
  翻页了就继续灌（有界循环 `2×limit+5` 次）。断言不放松，只多印一行「窗口翻页 M 次」。
- **通用教训**：凡是「先灌满配额再断言被挡」的用例，都必须把**窗口/周期翻页**当成正常分支处理，
  否则它会以极低概率长期污染 CI，把真实红灯埋掉。

---

## 2026-10-04 · 批量文本替换绝不用 PowerShell `.Replace()` 拼数组（一次真事故）

- **事故**：给 `docs/plans/2026-10-03-tactics-fidelity-and-elo-ladder.md` 做长句替换时，把 `@(@('旧串','新串'))`
  hashtable 值写成数组，PowerShell 把参数**拍平成了两个字符串**，于是替换退化成「单字符串替换」——
  第一轮用**整段旧串**没命中，第二轮用**单个字 `做`** 命中，结果文件里 48 处 `做` 全被换成了 `曲`
  （「P7 起待曲」「曲考古」「机制线只曲」「靠引擎种子曲配对」）。`git diff` 才发现（48 insertions/48 deletions）。
- **处置**：`git checkout -- <file>` 回到上一个提交（残留的 9 处「曲」是合法的「曲线」，别再手改），
  再用 `edit` 工具把该改的三处一句句重做；`npm run check:docs` 不校验文字，**只有 `git diff` 能发现这种事**。
- **纪律**：① 改文件只用 `edit` 工具的精确长串；② 非要用 shell，必须 `-creplace` + 明确数组元素个数
  （`@($old,$new)` 且断言 `$pair.Count -eq 2`），且**先 `git diff --stat` 看改动行数对不对**；
  ③ 改完 `git diff` 逐段看一眼再提交。

---

## 2026-10-04 · 编排的「准备阶段」有 2–4 分钟，别把它当成启动失败

- **现象**：`experiment-ladder.mjs` 起来后先打计划表，然后远端**只有** `plans/`（3 份计划都已上传）、
  `logs/`（空）、`tags.txt`（空），**没有 `round-N/`、没有 `logs/round-N.log`、没有 `.pid`、没有 node 进程**
  —— 看上去像「启动失败」。实际是准备阶段还没走完：`ensureRemote`（mkdir）→ 逐轮 scp 上传全部计划 →
  逐轮 ssh 读 tag，**每趟 ssh 12–20 s**，合计 2–4 分钟。等它走完，`started pid=…` 才出现。
- **踩的坑**：当时误判成「编排的 launch ssh 坏了」，于是**手工又起了一个 worker**（同一条启动命令）——
  两个进程写同一个 `round-1/` 目录（同一个 plan、同一个 tag），`games.jsonl` 会被灌成两份。
  处置：`pkill -f experiment-worker` 两端全杀 → `rm -rf round-N lines.txt logs/round-N.*` → 重新起编排。
- **已加的护栏**：启动命令收敛到 `scripts/lib/ladder.mjs` 的 `launchRoundCommand()`（阶梯 + batch 三处共用），
  守卫放在**远端 shell** 里原子判断：`if [ -f <pid> ] && kill -0 "$(cat <pid>)"` ⇒ 只回
  `started pid=…（已在跑，不重复起）`，不再起第二个；否则 nohup 起并写 pid。本地先查再起是关不掉窗口的
  （中间隔着一次 12–20 s 的 ssh 握手）。编排自己也会在准备阶段先打印
  `准备中：建远端目录 → 上传 N 份计划 → 读 tag（…这期间远端没有 round-N/ 是正常的，别手动补启动）`。
- **同一类悬挂的第二处也修了**：`experiment-batch.mjs` 的串行等待原本是远端一条 ssh 守 12 h
  （`for i in $(seq 1 1440); do kill -0 …; sleep 30; done`），长命 ssh 继承 stdout 管道 —— 与阶梯第一晚 L3
  那次「作业永不结束」同根因。现在两处都走 `scripts/lib/ladder.mjs` 的 `pollRoundCommand()`
  ＋本地每分钟一次**捕获式**短 ssh（阶梯 `pollRound` / batch `waitRoundLocally`）。
- **有意留下的例外**：`experiment-batch.mjs status --watch` 仍是**一条前台远端循环 ssh**（D13：进度只有文件、
  没有常驻服务）—— 它是给人盯着看的交互命令，Ctrl-C 就结束，不参与编排判定，所以不改成轮询；
  但别把它塞进后台作业里等（那又会变成「本地进程死了、ssh 还挂着」的老问题）。

## 2026-10-04 · 这台 box 的链路会间歇性抽风：scp/ssh 都要三次重试

- **症状**：`scp` 直接 `exit=1` 且**没有任何 stderr**（最费时间的就是这种静默失败），同一条命令行手工跑、
  或换 `node -e` 的 `execFileSync` 跑就成功；轮询里还见过一次 `ssh: connect to host 185.242.234.48 port 22:
  Connection timed out`。频率约「几十次里挂一次」。
- **代价**：只重试一次时，L2 收尾的「上传 round-1 plan 失败」把整套续跑掐死两次（每次都要人重跑）；
  第 15 轮的 `scp -r` 也栽了一次 —— 远端 20/20 早已跑完，只有本地拉不回来。
- 已修：`scripts/lib/ladder.mjs` 的 `retrySync(fn,{attempts:3,sleepMs:2000,onRetry})`（`sleep` 可注入才测得了）
  + `sleepSync(ms)`，CLI 的 `scp()` 与 `sshRetry()` 统一用它；`sh()` 失败时打印 `exit=/signal=/code=/message`。
  修复当场生效：同一次续跑里 round-12、round-13 的 plan 上传各失败一次、第二次即成功。

## 2026-10-04 · 「不报错只回退」比报错更坏：ssh 读远端状态的三处都必须重试

- 阶梯编排里读远端的三处调用 —— `remoteTagsOf()`（读 tag）、`ensureRemote()`（`mkdir -p`）、
  `remoteLineCounts()`（数 `games.jsonl` 行数）—— 原来失败**不抛错，只当「远端没东西」**：
  读 tag 失败 ⇒ 以为远端没 tag ⇒ 换新 tag ⇒ **worker 的 checkpoint 按 tag 命中，整轮白重放**；
  数行数失败 ⇒ 以为远端 0 行 ⇒ **把已经跑完的轮次再排一遍**（一晚的机时）。
  所以这三处一律 `sshRetry(..., attempts=3)`。判据：凡是「失败后的回退路径会静默改变实验语义」的调用，
  都必须重试或直接报错，不能静默回退。

## 2026-10-04 · 实验面归档的 `slug` 是对阵描述，不是棋种

- `.work/remote/<batch>/round-N/games/*.json` 里 `slug` 形如 `jev-v14-vs-rapfi-0-5s`（对阵描述），
  而 `parseRecord()` 的棋种解析顺序原来是 `slug → game → 默认` ⇒ **L2 的 300 局全被判「不认识的棋种」跳过**。
- 已修：候选链 `[显式 gameId, slug, game, gid]` 逐个试、认出就用；**候选全认不出时仍然 throw**，
  只有「一个棋种字段都没写」才退默认 gomoku —— 一个坏 `slug` 不该判死整批，但也不能瞎兜底。

## 2026-10-04 · 远端目录要先建，否则 `tags.txt` 是两次假失败

- 阶梯编排的 `remoteTagsOf()` 会先在远端 `: > tags.txt` 再把它 scp 回来读；**这个调用发生在 `mkdir -p` 之前**
  时，新 `--batch` 首跑会打两行 `scp: <repo>/.work/remote/<id>/tags.txt: No such file or directory`
  （`scp()` 失败会重试一次 ⇒ 正好两次），然后**照常继续** —— 看着像错，其实是噪音，但会让人以为上传坏了。
- 已修：`scripts/experiment-ladder.mjs` 把远端 `mkdir -p <batch>/{plans,logs}` 提到 `remoteTagsOf()` 之前，
  用 `ensureRemote()` 记状态（只连一次 ssh，后面 `pushState`/上传 plan 复用）。
- 顺带记住这台 box 的握手成本：**每次 ssh/scp ≈12–20 s**，15 轮 ×（上传 plan + 拉产物 + 行数快照）里
  光是握手就是几分钟量级 —— 编排里「多连一次 ssh」是有代价的，能合并就合并。

---

## 2026-10-04 · 「这一轮跑完没有」只看 round-summary.json（缺它 = 还在跑）

- `round-<i>/games.jsonl` 是**逐局 append** 的，跑到一半也有内容；判「收尾」的唯一本地凭据是
  `round-<i>/round-summary.json`（worker 收尾才写）、辅助凭据是 `progress.json.done === total`。
- 因此 `scripts/experiment-report.mjs` 默认**照读半轮**但在报告头与第 5 节标注「有 N 轮仍在跑（X 局已计入）」、
  收尾行也告警；要排除就 `--skip-incomplete`（连产物清单行一起排除）。**半轮的比分不许进结论** ——
  阶梯设计里「每对偶数局 + 换色双跑」的对称性只在整轮跑完时才成立。
- 同理：看远端进度用 `progress.json`，看「这晚能不能出报告」用 `round-summary.json` 齐不齐。

---

## 2026-10-04 · 编排进程起的「长命子进程」会握着 stdout 管道，父进程一死作业就永不结束

- 现场：第一晚 L3 的 round-1 早跑完了（远端 `progress.json` 20/20），本地作业却一直 running、日志停在
  `▶ round-1 … started pid=280411`。`Get-CimInstance Win32_Process` 才看出真因：**编排 node 进程（父）已经没了，
  它起的那条 12 h 远端等待循环 `ssh` 还活着**，而 `execFileSync(..., {stdio:'inherit'})` 让这条 ssh 继承了 node 的
  stdout ⇒ 外层 `node … | Tee-Object -FilePath …` 的管道写端始终有人握着，PowerShell 永远等不到 EOF。
- 结论：**编排器不要用「一条 ssh 挂到天荒地老」来等待**。改成每分钟一次短 ssh + **捕获** stdout
  （`execFileSync('ssh', args, {encoding:'utf8', timeout:60000})`，失败返回 null 当一次抖动），顺带每分钟把远端
  `progress.json` 打成一行进度。最坏泄漏面从「一条 12 h 子进程」降到「一条 ≤60 s 子进程」。
- 排查口径：作业「running 但日志不动」时，先 `Get-CimInstance Win32_Process | ? CommandLine -match 'ssh'` 看有没有
  没人管的 ssh；Windows 上父进程死了子进程默认不跟着死（无进程组语义），所以「node 没了」不等于「什么都没在跑」。
- 另外两条实测：PowerShell `Tee-Object -FilePath` 有 ~1 分钟缓冲（文件 mtime 落后 ≠ 卡死）；
  `experiment-worker.mjs` 的 `games.jsonl` **只 append**（`:441/:793`）且 checkpoint 命中会跳过整局 ⇒ 重跑已完成的轮
  不会产生重复行（断点续跑判据「远端去重局数 ≥ 本轮局数」因此安全）。

## 2026-10-04 · 合成棋谱 fixture 必须按渠道给档位，否则凭空多出两个假身份

- 身份 = `渠道|战术档|思考ms`（`identityOf()`）：**Rapfi 侧战术档必须 null、Jev 侧思考档必须 null**。
  写报告单测时第一版给 `blackTactics='v14-live3-fresh'`/`whiteThink=500` 一股脑塞给两侧，
  于是 `rapfi` 执黑那局多出 `rapfi|v14-live3-fresh|0`、`official` 执白那局多出 `official||500`，
  报表里平白多出两个 1 局样本的假身份（断言直接炸）。
- 同理：`reportMarkdown` 的成本脚注文案改一个字就会挂 spec（`**未计入主口径**` 与 C3 报表/UI 同字），
  改文案要顺手改断言；`openingRows()` 内部的 `gameRecord()` 需要 `import`（漏了就是
  `ReferenceError: gameRecord is not defined`，报错位置在 lib 而不是 spec）。
- 块注释里别写 `round-*/`：`*/` 会提前闭合注释，报出来的是 `SyntaxError: Invalid regular expression flags`（`round-<i>` 才安全）。

## 2026-10-04 · 给归档/D1 加「逐手字段」要动四处，显式类型漏一处就编不过

- C3 加 `provider`/`prob_source` 的完整链条：① `migrations/000N_*.sql`（`ALTER TABLE … ADD COLUMN`，只能加在末尾）；
  ② `src/shared/record-map.ts` 的 `MoveRow` + 逐手映射，**并且 `MoveAiMeta` 要跟着加可选键**；
  ③ `src/worker/lib/record-input.ts` 的入参白名单（**显式搬运，不靠 camelize**）；
  ④ `src/worker/db/games.ts` 的 `GAME_MOVE_COLUMNS` / `GAME_MOVE_INSERT` 的 `VALUES (?N)` / bind 三处。
- 坑：`MoveAiMeta` 是**显式接口**，忘了加键时 `ai.prov` 直接 `TS2339`（`Property 'prov' does not exist`）而
  `GamePayload['moves']` 那种宽松索引签名看不出来 —— 报错位置在 `record-map.ts`，但根因是类型没跟着加。
- 纪律：新列一律 `?? null`，**非 Jev 侧与老归档写 NULL，不写 `primary`/`exact` 冒充**；迁移先应用再部署
  （`node .work/wrangler-run.mjs d1 migrations apply jev-qiguan --local|--remote`，本地 `npx wrangler` 在这台机器上
  只有这个入口能跑远程）；应用后用只读 SQL 复核老行零改写。

## 2026-10-04 · 报表加信息别拼进「另一个条件的三元 else 支」

- C3 第一版把「上游兜底 N 手」拼在「有候选样本 ? 有样本… : 该身份不过 Jev 候选集…」的 **else 支**里，
  于是 `official` 身份在这条夹具（没有候选样本）上，兜底手数被前一个条件整条吞掉 —— UI 单测直接抓到
  （`expected '该身份不过 Jev 候选集（Rapfi/mock），没有候选点样本' to contain '上游兜底 4 手（…）'`）。
- 纪律：**两件不同的事实就用两个独立表达式拼接**（`A + (cond ? B : '')`），不要嵌套进彼此的分支；
  UI 单测里同时钉「有兜底」与「无兜底」两种身份，才能暴露这类吞并。
- 附带：`styles/style.css` 的 `.exp-agg-head/.exp-agg-row` 是 7 列固定 `grid-template-columns`，**加列会打乱既有
  `.exp-agg-num` 位置断言** ⇒ 优先把新信息放进 tooltip/累计行，别动列数。

## 2026-10-04 · Hono：预备头只在 `c.json()/c.body()` 路径生效，直接 `return fetch` 响应会丢

- `c.header(k, v)` 写的是 Context 上的「预备头」，**只有走 `c.body()`/`c.json()` 这类路径时才合并进响应**。
  直接把一个 `fetch()` 的响应 `return` 出去时，`#res` 在 `compose` 首轮赋值时还是 `null`
  （`node_modules/hono/dist/context.js` 的 res setter 只在已存在时合并）⇒ 这些头**静默消失**，不报错。
- 后果实例：`/api/jev` 的 POST 成功路径一直 `return toPassthroughResponse(result)`，于是**成功响应没有 CORS 头**
  而错误路径（`c.json()`）有。同源部署永远看不出来，跨源调用才会炸。
- 纪律：凡是 `return` 外部响应对象的处理器，要**自己拼 `new Response(body, { headers })` 并显式合并**所有要带的头
  （透传头 + CORS + 自定义判据头），别指望 `c.header()` 兜底；单测里显式断言这些头。

## 2026-10-04 · 顶层函数的回调别引用调用方作用域；统计口径只认「有值的样本」

- `scripts/experiment-worker.mjs` 的 `playOne()` 是**顶层函数**，`decide()` 的 `onProviderSwitch` 回调里直接读了
  `main()` 作用域的 `outDir` ⇒ 真跑时每次切换都抛 `outDir is not defined`，`events.jsonl` 四条 error、**一局没跑成**。
  单测碰不到这条路径（回调只在真触发时走），只有 box 端到端真跑才露头。修法：调用方把 `outDir` 一起塞进 `dirs`。
- 逐手提供方统计原先把「没有 `meta.provider`」的 Rapfi 侧也记成 `unknown` ⇒ 日志 `provider[backup:19 unknown:18]`
  把「兜底了几手」淹掉。纪律：**统计只认真正的样本**（这里是「非空字符串 id」），缺值不编桶名。

## 2026-10-04 · P6 box 端到端：checkpoint 按 tag 命中、行数不是局数、ssh 握手 18 s

- **worker 的 checkpoint 是按 `tag` 命中的**（`ckptAction`：`prev.tag !== tag ⇒ tag-mismatch ⇒ 重跑本局`）。所以
  阶梯续跑**必须沿用原 tag**（`withReusedTags()`：本地状态 tag → 远端 plan tag → 新 tag），否则被中断的那一轮
  会整轮重放——实测 `p6kil`：4 局的一轮在 `games.jsonl` 里留下 **7 行**、状态记成 `W3-D1-L3`。
  `--force` 是唯一的例外（故意用新 tag 真重下），但它**必须先把旧产物挪到 `stale-round-N-<旧tag>/`**
  （`staleCleanups()`），否则新旧两次尝试会加在一起；且**状态里的 `tag` 要跟着本轮实际用的走**
  （`applyRoundResult` 原先只 `...r` 展开，`--force` 后状态仍留旧 tag ⇒ 下次续跑又「沿用旧 tag」⇒ 又整轮重放）。
- **行数不是局数**：`games.jsonl` 是追加写，重复跑过的轮会有重复记录。`wdlOfGamesJsonl()` 现在按
  `gameUid` 去重并给 `{lines, unique, counted, dupes}`，判「这轮跑完没有」用 `unique ≥ games`。
  **uid 去重只能抓住「同一局被恢复重放」**（resumeUid 保持同一个 uid）；换了 tag 的重放会生成**新的 uid**，
  这种只能靠上面的 stale 挪开来避免，不能指望去重。
- **「这轮跑没跑」以远端产物为权威**：本地 `ladder.json` 只是记账。原先判据要求「本地 ok **且** 远端行数够」，
  于是远端明明跑完、只因一次 `scp` 拉产物失败就把整轮记成 failed（`p6val` round-3）；现在行数够就跳过并
  **补拉一次**（`⏳ round-N 跳过但本地缺产物，补拉一次…`，补记 `durationMs: 0` 以免污染 ETA 样本）。
  同理，状态文件与本次计划形状不同（改过 `--games`/`--max-rounds`）时以本次计划重建：`stateMatchesLadder()`。
- **box 上每次 `ssh`/`scp` 握手 ≈18 s**（低配机器）⇒ 编排器的往返次数本身就是成本：远端 tag 只在
  「本地状态缺 tag」或 `--force` 时问一次；行数扫描用一次 ssh 写文件再 scp 回来（本机 ssh 抓管道会 EPERM）。
- **`scp` 的瞬时失败原因仍未定性**：`.work/p6-scp-probe.mjs` 实测反斜杠绝对 / 正斜杠绝对 / 仓库根相对
  三种写法**都成功**（各 ~18 s）⇒ 「Windows 盘符冒号被当成主机名」的假设**不成立**（`sh()` 用 `execFileSync`，
  无 shell，路径原样传参）。保留 `localScpPath()`（消歧义面）+ 一次重试；`.work/p6-kill-b.txt` 里真见过
  `（scp 第一次失败，重试一次…）`，所以这个瞬时失败是**真实存在**的——别把它写成「已定位」。
- 中断续跑的正解（实测 `p6kil2`）：一轮跑完 1 局时远端 `kill` ⇒ 同命令重跑 ⇒ `game-1 已完成（ok），跳过` +
  只补跑 2–4 局，最终 4 行 / `unique 4` / 无 dupes。**别用「等 N 秒再杀」的方式做这种验收**：box 上
  rapfi 自对弈一局只要 18–25 s，而一次 ssh 往返 18 s，杀点会飘；在**远端**写 `while [ 行数 < N ]; do sleep 2; done; kill …`
  这类看守循环才可复现。

---

## 2026-10-04 · P6 阶梯编排：独立 CLI 而不是 submit 子命令；「跑完了」看远端行数；用法错必须包进 try

- **做了什么**：纯核 `scripts/lib/ladder.mjs`（413 行）+ CLI `scripts/experiment-ladder.mjs`（435 行）+
  `test/scripts/ladder.spec.mjs`（334 行 / 33 例）。一条命令跑完一条 round-robin：`--ladder L1|L2|L3|all`
  或 `--identities a,b,c`，逐轮串行（起一轮 → 等 pid → 拉产物 → 推桶 → 冷却 → 下一轮），中断后重跑即续跑。
- **为什么独立 CLI**：阶梯要自己管「等待 → 拉取 → 续跑状态」，做成 `experiment-batch.mjs ladder` 会让
  submit 同时是「单批次提交器」和「多轮编排器」；拆开后 `submit` 保持单一职责，阶梯状态也能单独落 `ladder.json`。
- **口径①：身份必须按归档导出口径写**（不是 spec 文本）：`rapfi:v14-live3-fresh:500` 的身份是 **`rapfi||500`**
  （rapfi/mock 不过战术层 ⇒ 战术档留空），`official:v13-pressure-gate:2000` 是 `official|v13-pressure-gate|0`。
  报表/断点状态/与历史轮次对齐全靠这条；写错就会把同一身份算成两个。
- **口径②：偶数局数是颜色对称的前提**（A 奇数局执黑 + 开局库连续两局同开局换色）⇒ 奇数局数直接拒绝，
  `--allow-odd` 才放行；`buildLadder` 也必须走 `normalizeGames()` 闸门（首版漏了这一步，奇数被静默放行）。
- **口径③：「跑完了」= 远端 `games.jsonl` 行数 ≥ 局数**，不是本地状态说 ok —— 状态文件坏了/被删了也不该重跑
  已完成的轮次；反之本地 ok 但远端只有 `2/4` 局必须重跑。`wdlOfGamesJsonl()` 同理：A 执哪边优先看**记录身份**，
  拿不到线索才退回「奇数局 A 执黑」的位置推断（缺一行就会让位置推断错位）。
- **坑①：`--batch` 这类 sanitize 调用要包进 try**。`sanitizeBatchId()` 抛的 Error 没有 `exitCode`，
  直接冒到入口就变成 exit 1（运行时故障），而它其实是用法错（exit 2）。凡是「输入不合法」的 throw
  都要在 CLI 里转成 `die()`（exit 2）—— 否则验收脚本按 exit code 分流时会误判。
- **坑②：`parseArgs` 是「后者覆盖前者」**，所以测试里把 `--batch Bad` 写在 `...dry`（自带 `--batch dry1`）**之前**
  时会被静默覆盖，表现为「坏值竟然通过了」。写 CLI 单测要么把待测参数放最后，要么别复用带同名参数的数组。
- **坑③：`--store local --upstream direct` 是零 CF 触碰的缺省面**，不该被「会写生产 D1」的闸门拦；
  闸门条件要写成 `store === 'd1'` 才要 `--origin`/`--allow-production`。**另外 `--parallel` 在阶梯里一律拒绝**
  （串行 + 轮间冷却是成本纪律；要并行单批次请用 `submit --parallel`，那里只放行双本地臂）。
- **预计墙钟的锚点（别自己编）**：每局 60 手（归档 312 局 / 19298 手 ≈ 62；P4b box 两局 27 与 80 手）、
  上游臂 1.1 s/手（P4b box 实测 27 手 26 s / 80 手 89 s）、rapfi `think/2`（一手里只有执子那侧思考）
  ⇒ L3 120 局 ≈2–3 h、L2 300 局 ≈7 h、L1 200 局 ≈11 h。计划里「L3 ~10 h」是把两侧思考都算了一遍的粗估，已订正。

## 2026-10-04 · P5 Elo 升级：BT 只定到「加常数」、200 局只能分辨 ~30 Elo、判据要按实测订正

- **做了什么**：`scripts/lib/batch-elo.mjs` 238 → 448 行，把顺序迭代 Elo 换成 **Bradley–Terry**（`fitBt` MM 迭代、
  `ridge` 0.5 先验、显式零点）+ **bootstrap 区间**（按局重采样、2.5–97.5% 分位）；`rankTable(..., { bt })` 只在
  开启时加 `BT Δ`/`95% 区间(BT Δ)` 两列（不开时行形状逐字不变）；`experiment-batch.mjs elo` 加
  `--anchor`（缺省 `rapfi||500`）/`--bootstrap`/`--seed`/`--no-bt`。
- **口径①：BT 只定到「加一个常数」** ⇒ 必须显式选零点。数据里没有 `rapfi||500` 时退化成**均值居中**，
  报表会印「锚点 均值居中（无锚点：…）」并把 `anchor` 记成 `null` —— 看到这行就别拿这次 `BT Δ` 跟别的表比。
- **口径②：一次 200 局只能分辨 ~30 Elo。** 实测（三身份轮转、40 种子）：真差 100/200 Elo 时 200 局的
  平均绝对误差是 **27.9 / 35.6**（偏差 +4.4/+1.7），400 局 21.2/25.4，800 局 20.6/17.3。两身份干净情形
  反而与理论 SE 吻合（n=200 理论 25.6 vs 经验 25.8，覆盖率 56/60）⇒ **实现是对的，是人对样本量想得太乐观**。
  计划原判据「200 局误差 < 25 Elo」已订正为「\|偏差\| < 10 + 平均绝对误差 < 45 + 误差随 n 下降」。
  **教训：任何「N 局能分辨 X」的判据，先写个合成数据脚本量一遍再写进文档**（`.work/p5-stats.mjs`、
  `.work/p5-boot-diag.mjs` 就是这两把尺子）。
- **口径③：BT 区间按局重采样，不利用配对结构**（同一开局换色双跑的两局相关）⇒ 区间偏窄，
  判「跨档位是否有差」仍以**配对样本**为准；报表脚注已印这条。单局样本的区间会退化（`[139.8–139.8]`、宽 0）。
- **坑：`{ ...DEFAULTS, ...opts }` 里 `opts.ridge === undefined` 会把默认值覆盖成 `undefined`**，
  导致 bootstrap 每次重拟合都算出 NaN（区间全是 NaN）⇒ 逐字段取默认（`Number.isFinite(opts.x) ? opts.x : DEFAULT.x`）。

## 2026-10-04 · P4b 收尾：box 上跑通整局直连、plan 必填 `batchId`/`tag`、box 克隆是窄 refspec、查 D1 前先清代理

- **做了什么**：在 box（`ssh qijia`，185.242.234.48）上把离线运行面跑通整局 —— `official:v14-live3-fresh:0`
  vs `rapfi:v14-live3-fresh:1000` 两局 118 s（`27 手 winner=black 26s` / `80 手 winner=和棋 89s`，后者是 `maxPlies` 截断），
  `已发 54 次上游请求、累计等待 17.6 s、连续 429 = 0`，日志打「store=local：未触碰业主 Worker」。
  **零 CF 触碰的硬证据**：跑前跑后 `select count(*) from games/game_moves/experiments` 都是 **312 / 19298 / 28**。
- **坑① 手写 plan 必带 `batchId` 与 `tag`**：缺 `batchId` 直接抛 `batchId 需匹配 /^[a-z0-9][a-z0-9-]{0,15}$/（1-16 位小写字母/数字/中划线）`
  （调用栈 `sanitizeBatchId (batch-common.mjs:100)` ← `batchTag (batch-common.mjs:110)` ← `experiment-worker.mjs:409`，
  且报错信息里的值**是空的**，一眼看不出缺的是哪个键）；缺 `tag` 原先**不报错**、静默写出 `progress.tag = ""`
  和一行没有标签的实验记录 ⇒ 已加守卫：worker 开局前 `if (!plan.tag)` exit 2 并给出示例。
  **教训：编排器生成的 plan 有一批隐式必填键，手写 plan 要先照 `experiment-batch.mjs submit` 的产物抄一遍。**
- **坑② box 上的仓库克隆是窄 fetch refspec**（只有 `feat/ssh-batch-experiments`）⇒ `git checkout main` 报
  `error: pathspec 'main' did not match any file(s) known to git`。正确做法：`git fetch origin main:refs/remotes/origin/main`
  然后 `git checkout -B main origin/main`；随后 `npm ci --silent` 即可（box `node -v` v24.9.0、可用内存约 1.3 GiB）。
- **坑③ 本机查 D1 前必须先清代理**（否则 wrangler 报 `Proxy environment variables detected` 外加
  `Your auth token has expired … Cloudflare auth server could not be reached`，看着像登录过期，其实只是出口不通）：
  `$env:HTTPS_PROXY=''; $env:HTTP_PROXY=''; $env:ALL_PROXY=''; $env:NO_PROXY=''`。
- **验收证据的形态**：① 跑前后行数对照（不变 = 没碰生产）；② 产物取回后 `experiment-batch.mjs elo <dir>` 能复算
  （这次 `official|v14-live3-fresh|0` 1508 vs `rapfi||1000` 1492，80 手那局按「未终局不计入 Elo」被丢弃 ⇒ 样本 1 局）；
  ③ 日志里 `fetch:{gated:54,passed:0}` 证明限速只拦上游主机、其余请求放行。

---

## 2026-10-04 · P4b 离线实验面：本机 Node 没外网、SigV4 要用官方向量自证、`KEY_CHANNELS.has` 只在缺 key 时炸

- **做了什么（plan `2026-10-03-tactics-fidelity-and-elo-ladder` P4b，[ADR-0021](../adr/0021-standalone-experiment-plane.md)）**：
  ① [`scripts/lib/upstream.mjs`](../../scripts/lib/upstream.mjs)（89 行）：运行面闸门（direct 面禁 `proxy` 臂、`worker`/`d1` 必须显式 `--origin`）+ key 解析（`JEV_API_KEY` 优先、`--key-file` 缺省 `/root/.jev-key`）；
  ② [`scripts/lib/throttle.mjs`](../../scripts/lib/throttle.mjs)（148 行）：滑窗 30 req/min + 连续 5 次 429 熔断，`installFetchThrottle()` **裹全局 `fetch`**；
  ③ [`scripts/lib/s3-put.mjs`](../../scripts/lib/s3-put.mjs)（288 行）+ [`scripts/batch-bucket.mjs`](../../scripts/batch-bucket.mjs)（211 行）：纯 Node SigV4 与桶 CLI（`push|pull|ls`，凭据只读环境变量，缺任一 exit 3，上传失败只告警）；
  ④ worker 缺省 `--upstream direct`（不写 `--origin` 就机械地不碰业主 Worker 与 D1）。
- **坑① 直连面的真验收只能去 box 上做：本机 Node 没有外网**。`fetch` 直接 `ECONNREFUSED 127.0.0.1:10808`
  （代理进程没跑）⇒ `plan-direct.json` 在本地永远 exit 1，而同一个 plan 在 box 上能跑通。
  box 探针：`/root/.jev-key`（`-rw-------` 121 B）+ `Bearer` POST 上游 ⇒ **HTTP 422**（`questions` 空 ⇒ 鉴权已过，0.315 s）。
  **教训：判「网络不通」和「代码错」要看错误类型** —— 限速器日志照常打「已发 16 次、累计等待 6.3 s」，说明闸门与限速是好的，只有出口不通。
- **坑② 自实现 SigV4 必须拿 AWS 官方已知向量钉死，否则是自证**。三条向量当场抓出三个真 bug：
  (a) 作用域日期用 `now` 而**忽略了调用方显式给的 `x-amz-date` 头**（签名与头不一致）；
  (b) `canonicalUri()` **吞掉前导 `/`**（`ladders/…` 应为 `/ladders/…`，且要先把 URL 的 `pathname` `decodeURIComponent` 再逐段编码，否则 `test$file.text` 会二次编码成 `%2524`）；
  (c) 虚拟主机式寻址 + endpoint 已含桶名 ⇒ 拼成 `bucket.bucket.s3.amazonaws.com`（静默 403/404），现在直接抛错。
  另：`f4780e2d…`（20120215/us-east-1/iam 的签名密钥）**不要再往测试里写** —— 出处的 S3 API 文档页已 404，无法核对；换成 RFC 4231 用例 1 的 HMAC 常量（`b0344c61…`）钉参数顺序。
- **坑③ `KEY_CHANNELS.has(cfg.channel)`：数组没有 `has`，而这只在「缺 key」那条分支上炸**（正常有 key 的跑动永远看不到），
  验收闸门第一次跑就吃了一个 exit 1 + `TypeError`。**教训：闸门类代码必须真的跑一遍每条拒绝路径**（本案四道闸门各跑一次）。
- **口径① 身份串从 `proxy|…` 变 `official|…` 不是改名而是换渠道**：`proxy` 是相对端点 `api/jev` + `X-Api-Key`（绑定业主 Worker），
  `official` 才是绝对端点 + `Bearer`。两者协议同构、可比，但**不混在一张表里算 Elo**，报表要注明同源。
- **口径② 未终局记录两处不一致（不是 bug）**：`progress.json` 把 `winner === null` 记和棋，而 `batch-elo.mjs` `gameRecord()` 丢弃未终局
  （「未终局或超时截断，不计入 Elo」）⇒ 只有 `maxPlies < 225`（人为截断）时两者才会对不上；真满盘和棋（225 ½ 手）两边都算和。
- **测试技巧**：注入的假 `fetch` 返回的对象要像真 Response 一样带 `headers`（`putObject()` 会读 `resp.headers.get('etag')`），
  否则表现为「PUT 明明 200 却 `uploaded=0/failed=1`」；`installFetchThrottle().uninstall()` 要还原**注入前的** `globalThis.fetch`（不是还原成注入用的 mock）。

---

## 2026-10-04 · P4 阶梯地基：开局库 + 进度文件 + 默认 `--store local`；归档棋谱没有 `winner`

- **做了什么（plan `2026-10-03-tactics-fidelity-and-elo-ladder` P4）**：
  ① [`scripts/lib/openings.mjs`](../../scripts/lib/openings.mjs)（269 行）：开局库生成/校验/原子读写，
  `openingForNo()` = 每本开局连续两局、换色双跑（配对样本，分辨 5 pt 的前提）；
  ② [`scripts/lib/progress.mjs`](../../scripts/lib/progress.mjs)（153 行）：`progress.json` 原子写 + `events.jsonl` + `eta()`；
  ③ [`scripts/experiment-worker.mjs`](../../scripts/experiment-worker.mjs) 新增 `--openings`/`--store local|d1`（**缺省 local**）/`--device-id`，
  每局落进度与 `games.jsonl`；④ [`scripts/lib/batch-elo.mjs`](../../scripts/lib/batch-elo.mjs) 的 `loadRecords()` 会读 `games.jsonl` 并按 `gameUid` 去重。
- **坑①（最贵）归档棋谱的形状和 worker 产物不一样，判据写成注释里那种「看起来对」的就会静默读到 0 局**：
  归档（`games/<day>/*.json`）顶层是 `format,exported,game,gid,mode,channel,result,notation,moves` ——
  **没有 `winner` 字段**，胜负只在中文 `result`（`"黑方 获胜（五连）"` / `"白方 获胜（认输）"` / `"和棋（棋盘已满）"`），
  uid 叫 `gid`；而 `loadRecords`/`recordsFromDir` 原来的路径闸门是「**父目录**名叫 `games`」，
  对 `games/2026-09-29/` 这种布局**一局都匹配不上**（54 个归档文件全部漏掉）。
  当场症状是 `buildLibrary()` 抛 `拒绝写出不合法的开局库：库是空的（openings 为空数组）`。
  ⇒ 新增 `winnerSideOf()`（认 `winner` 与中文 `result` 两种口径），路径闸门改成
  「**路径上任何一级目录**叫 `games`」（`loadRecords` 同步改，P5 拿归档算 Elo 才走得通）。
  **教训：把归档当数据源前先打印 `records.length`** —— 「0 局」与「全是和棋」在下一步长得一模一样。
- **坑② `--store` 缺省改成 `local` 是有意为之的行为变更**：这是「实验面默认不碰业主 Worker」（G3/m13876）的落地，
  老调用方（`experiment-batch.mjs submit`）在 plan 里**显式写 `store:'d1'`** 才能保持旧行为 —— 已改，别再把缺省改回 d1。
- **坑③ 脚本落子的识别口径**：`aiMoveMeta()`（`src/core/meta.ts:67`）对非 AI 手返回 `null` ⇒
  导出里**没有 `ai` 块**。在 ai-ai 局里「没有 `ai` 块」⇔ 该手由开局库脚本落下（第 7 手起才有 `ch=rapfi`）。
  想给开局手加显式标记就得动 `src/core` 的导出与金样，目前选择「不加字段、写清口径」。
- **坑④ 单测抓到的口径 bug（最容易骗自己的那类）**：`outcomeForA` 起初只排除 `status==='error'`，
  于是断点续跑时 `skipped`（上一轮已归档的局）被算成**和棋**进了 W/D/L。规矩：**「没跑 ≠ 和棋」**，
  `skipped` 且没带回 `winner` ⇒ 不计入（`done` 仍含它）。
- **验收口径**：`--store local` 一局的产物 = `games/round-1-game-N.json` + `games.jsonl` + `progress.json` +
  `events.jsonl` + `round-summary.json`（实验行留在 `round-summary.json.experimentEntry`，「本会 POST 的行」不丢）。
  **「跑动中可读」要留真证据**：把 `pauseMs` 调大（本次 30000）在局间窗口里 `cat progress.json` ⇒
  读到 `done=1 / gameNo=1 / ply=50 / wdl{w0 d0 l1} / elapsedS=12 / etaS=12`；跑完再读只能证明「文件存在」，证明不了「跑动中可读」。
- 实测：归档 54 局 ⇒ `used=45`（9 局和棋按 `decisiveOnly` 丢）+ 4 本开局；rapfi 自对弈 2 局前 6 手逐手等于开局库
  （`H8 E5 I8 B2 J8 G8`）；`games.jsonl` 读回 2 局、身份 `rapfi||500`；scripts 单测 6 文件 / 136 例。

## 2026-10-04 · P3 回放 + 考古：层一致率 100%、14/14 档参数层确证、DSH 的 node 跑不了 wrangler

- **做了什么（plan `2026-10-03-tactics-fidelity-and-elo-ladder` P3）**：
  ① [`scripts/tactics-replay.mjs`](../../scripts/tactics-replay.mjs) + 纯核 [`scripts/lib/tactics-replay.mjs`](../../scripts/lib/tactics-replay.mjs)：
  拿任意历史棋谱 × 任意档位离线重放（`--dir/--file/--game/--tag/--tactics/--sides/--limit/--max-games/--json/--show`）；
  ② 考古文档 [docs/plans/2026-10-04-tactics-archaeology.md](../plans/2026-10-04-tactics-archaeology.md)（267 行）；
  ③ v1–v13 的 `fidelity` 升 `'restored'`（`v0-off` 留 `'approximate'`，v14 保持 `'exact'`）。
- **验收数字（`exp-20261003082805` = v14 vs `rapfi@5000ms`，20 局 / 990 手 / 重放 496 手 / 282.2 s）**：
  **层一致率 496/496 = 100%**、**接管落点一致率 327/378 = 86.5%**、**会变 51 手且全部是同层换点（0 处换层）**。
- **口径纪律（最容易读错的一条）**：归档只存实走那一点的 `confidence`/`prob`/`rank`，**没有整张模型概率表** ⇒
  重放只能走「无模型」等权口径（`pairs = 合法着法等权`、`topK = 1`）。所以**「层」才是强结论**（层由确定性事实决定，
  与模型无关），「落点」在层内多解时依赖模型概率，86.5% 是**下界**。以后引用这组数字时必须带上这句限定。
- **考古结论（参数层）**：v0–v13 的 15 个预算键逐键、`sound`、`openingMin=4`、注入句集合/句面/句序**全部有 sha 证据**，
  且逐键等于 P1 冻结值。两条前序审计结论被否证：v11 上线预算就是 `10/3000/6`（`14/6000/∞` 只存在于未入库的
  `.work/vct-tune*.mjs`）、prompt 漂移在 P1 后已修。另修正一条旧笔记：`src/core/tactics-budget.ts` **仅由 `0b3a400`(P1) 创建**，
  `446f976`(P0) 没碰过任何战术常量。
- **`promptFacts: 'mech'` 是正确冻结值，别改成 `'all'`**：当年是「无条件全注入」，但那时的句集**恰好等于**今天的 `'mech'`
  （句子与机制在同一 commit 成对增加，era 句面/句序在 HEAD 里 0 miss）；`open4/parry/parry3/parry4/safeSort/vcfTry/sound/live3Fresh`
  这 8 个 mech 键**历史任何时期都没有注入句**。改成 `'all'` 会把「当年还不存在的机制的句子」注入老档 —— 那才是漂移。
- **「改一处牵多档」的历史实证全部来自「新机制复用旧机制」，不是改值**：全时间值矩阵证明 12 个命名常量
  **没有一个在引入之后被改过数值**（`NODE_LIMIT=4000`/`slice(0,12)`/`VCF_PLIES=7` 自 `57a9508` 起恒定）。
  ⇒ 审计里那条「共享常量会互相牵动」的担心，真实形态是「新机制借用老常量」，而不是「改老常量影响老档」。
- **环境坑（本机 DSH 下跑 wrangler / D1 查询）**：DSH 的 `node` 是 **Electron 运行时**（`process.versions.electron` 有值）
  ⇒ ① `npx wrangler …` 报 `Unknown argument: …\node_modules\wrangler\wrangler-dist\cli.js`（argv 切片错）；
  ② 用 ESM `import()` 引 `wrangler-dist/cli.js` 只拿到导出表、CLI 主入口不跑（守卫 `if (typeof vitest === "undefined" && __require.main === module)`）；
  ③ `ELECTRON_RUN_AS_NODE=1` 自 spawn 也不行（wrangler 仍看得见 electron）。
  **解法：用真 Node** `C:\Program Files\nodejs\node.exe`（v22.21.0）跑 `node_modules\wrangler\wrangler-dist\cli.js`；
  `.work/wrangler-run.mjs` 已改成优先用它。D1 查询一律「先重定向到文件、再让 Node 读」（沙箱下 Node 的管道 stdio 会 EPERM）。
- **`--json` 的 D1 导出形状**：`[{results: [...], success, meta}]`（raw 里可能混 stderr）⇒ 折成重放输入的那一步
  （`.work/p3-dump.mjs`）是按「首个 `[` 到末个 `]`」切 JSON 再逐 chunk 取 `results`。

## 2026-10-03 · P2 指纹设施：接管链抽成纯函数 + 210 行决策指纹（改一处预算 = 红灯 32 处）

- **做了什么（plan `2026-10-03-tactics-fidelity-and-elo-ladder` D6/D7）**：
  ① 把内嵌在 `src/core/jev/client.ts`（原 `:374-527`）的接管链抽成 `src/core/takeover.ts` 纯函数
  `pickTakeover({engine, st, tactics, mech, criteria, legal, pairs, cands, topK, onTime})` → `{notation, layer, bypassed}`，
  另导出 `TAKEOVER_ORDER`（14 层权威顺序）与 `TAKEOVER_LABEL`（中文层名）；`client.ts` 565 → 431 行。
  ② `test/engines/fingerprint.mjs`：`fingerprintOf()` **一趟链**同时拿「事实摘要 `digest` + 接管层 + 落点」
  （先 `computeTactics` 再 `pickTakeover`，与 `decide()` 同序），`--write`/`--check` + 覆盖表。
  ③ `test/parity/tactics-fingerprints.json`：**14 局面 × 15 档 = 210 行**（归档抽样早 4/中 4/晚 2 + 具名夹具 win/open4/vcf/vct）。
  ④ `test/engines/version-freeze.test.mjs` 5 例，已进 `test/engines/runner.mjs` 的 `ALL_MODULES`。
- **为什么先做抽取**：指纹若走 `decide()` 会跑两遍链（成本翻倍），而 P3 的「任意棋谱 × 任意档位」回放本来就必须
  离线跑这条链 —— 抽取是两处的公共前置。抽取纪律：**先 dump 基线再抽**，抽完逐行比对。
- **证据**：① 抽取前后 `.work/p2-ab-baseline.mjs` 各 30 局面 × 15 档 = 450 行，**差异 0 行**；
  ② 基线生成 24.0 s（210 行）；③ **试红**：`DEFAULT_BUDGET.vcfNodeLimit` 4000 → 1 ⇒ `⑭b` 报「决策指纹漂移 **32 处**」
  （v7…v14 层从 `vcfDefense` 变 `parry`/`vctDefense`），还原后全绿；④ `⑭d` 证指纹与 `decide()` 同解；
  ⑤ 引擎套件 148 → **153 例**、vitest **38 文件 / 399 例**、`tsc` 干净、`check:docs` 58 md / 397 链接。
- **教训**：
  ① **语料规模必须按实测定，不能按直觉**：120 局面 ≈ 9 分钟（早/中盘棋盘稀疏、候选点多 ⇒ 搜索扇出大；
  晚盘密棋盘反而便宜），进不了 CI；最终 14 局面 24 s。逐档成本差 3 个数量级（v0–v2 ~1–2 ms，v12–v14 ~1.2 s）。
  ② **归档局面天然缺早段层**：`win/open4/vcfAttack/vctAttack` 在 ply 12–47 的局面里几乎遇不到（早被更靠前的层接管，
  或棋盘上根本没杀），必须补**具名夹具**（4 个夹具只花 2.8 s，换来 4 层覆盖）——「随机抽样」不等于「覆盖」。
  ③ **`threat` 层是死分支**（实测）：`you:open4` 标签判据与 `chance_points_you` 判据同源（走后 ≥2 个成五点），
  且含 `threat` 的档都含 `open4`、链里 `open4` 在前 ⇒ gomoku + 非空候选集下不可达。
  2225 个归档候选 + 双活三/双四合成局面全部 chance=0 或被 `open4` 接管。指纹断言因此写成
  「除 `threat` 外每层都必须被走到 + `missing` 恰为 `['threat']`」——**把「覆盖不到」变成显式事实，而不是含糊的缺口**。
  ④ `test/engines/*.test.mjs` 必须 `export default S`，否则 `runner.mjs` 的 `if (!s) continue` 会**静默跳过整个模块**
  （本次 0 例被跑过一轮，靠总数对不上才发现）；`MECHS` 是 `readonly string[]` 不是字典，断言用 `indexOf`。

## 2026-10-03 · P1 冻结层：档位自带预算，注入句按档裁剪（零行为变更对照 1800 行 0 差异）

- **做了什么（plan `2026-10-03-tactics-fidelity-and-elo-ladder` D1/D3/D4/D5）**：新增
  `src/core/tactics-budget.ts`（`EngineBudget` 15 个上限 + `DEFAULT_BUDGET` 逐字冻结 + `BUDGET_KEYS` +
  `budgetOf()` + `sameBudget()`）；15 条档位记录各增 `budget`/`sound`/`openingMin`/`promptFacts`/`fidelity`
  （统一 `FROZEN` 缺省，逐档只写 `sound`/`fidelity`）；预算经 opts 下到 `src/core/engines/gomoku.ts` 的五处
  （`vcfWin` 的 `sound`/`nodeLimit`/`movesMax`、`live3Deny` 的 `evalMax`、`vctDefense` 的
  `keep`/`vcfPlies`/`pressureLimit`、`pressureCut` 的 `keep`）；`attachFacts()` 增 `opts.mech` 逐句过滤，
  `src/core/jev/client.ts` 传 `mechOf(opts.tacticsVersion)`（与 `computeTactics` 同一解析路径）。
- **关键纪律**：① **缺省 = 历史常量**，引擎所有 opts 缺省时行为逐字不变；② 预算**只减不增**（AGENTS.md 规则 10），
  加新上限必须同步 `BUDGET_KEYS`；③ `budgetOf()` 对 0/负数/NaN **回落默认**——「预算写错的后果只能是少看见」；
  ④ `sound` 记的是**历史事实**（v0–v8 上线时没有闸门），不是「推荐值」，`selfTest()` 断言 `v.sound === (rank >= 9)`。
- **怎么证的（三段证据，脚本都在 gitignored `.work/`）**：① 基线与对照 —— `.work/p1-fidelity-check.mjs`
  在干净 HEAD `446f976` dump 15 档 × 120 真实归档局面（1800 行，`{tac, ins}`），改后同脚本复跑 +
  `.work/p1-fidelity-diff.mjs` ⇒ **`tac` 与 `ins` 全部 0 差异**（比预告更强：v7/v8 的 soundness 差异面在这 120
  个局面里没触发）；② 过滤量化 `.work/p1-mech-filter-probe.mjs`（40 局面）⇒ v12–v14 **0 差异**、v11 少 9600 字符、
  v10 19360、v7–v9 37560、v3–v6 51280、v1/v2 67520、v0 79200，丢的句子与机制表严格对应（v11 只丢
  `vct_win_opponent`、v0 12 句全丢）；③ sound 正对照（单测）——哨兵局面（守方堵点造四反杀）缺省不报胜、
  `sound:false` 报出 `F5→F6→E5`，档位级 v7 报 `F5` / v9 不报，`nodeLimit:1` 搜不出 ⇒ 预算与闸门真到了引擎。
- **教训 / 坑**：① 对照脚本的 `ins` 口径是**不带 `mech` 的旧调用**，它只能证明「句面逐字未改」，
  **过滤效果必须另立探针**（否则会误以为 D5 没生效）；② 归档 JSON 的 `game` 是中文显示名，引擎 id 在 **`gid`**，
  读错会得到「没有可回放的归档局面」；③ 测试里 `versionTag(undefined)` 必须仍显示当前档（宽容改造时先红过
  3 条 duel 用例）；④ 一次性批量改 15 条记录用脚本（`.work/p1-versions-patch.mjs`）比手改安全，
  但改完必须 `tsc` + `selfTest()` + 逐档抽查。
- **数字**：`node test/engines/run.mjs` **148/148**（原 144，+4 例 P1）；`npx vitest run` **38 文件 / 399 例**；
  `npx tsc --noEmit` 干净。**仍待 P2**：`test/parity/tactics-fingerprints.json` 指纹冻结 + 故意改预算试红。

## 2026-10-03 · P0/P0b 落地：静默换档封死 + 实验面两道防污染闸门 + 报表带 Wilson 区间

- **做了什么（P0，plan `2026-10-03-tactics-fidelity-and-elo-ladder` D2 + 卫生包①②）**：
  ① `src/core/tactics-versions.ts`：`resolve()` 对未知档号**抛 `UnknownTacticsVersion`**（新增私有
  `editDistance()` 莱文斯坦 + `nearestId()`；消息含最接近的合法 id），新增 `tryResolve()` 供展示用；
  `src/core/tactics.ts` 的 `resolveVersion()` 兜底由「全机制集」改成 **`v0-off` 空机制集**。
  ② 三个入口白名单校验：`scripts/experiment-run.mjs`（`--tacA v12-vct-de` ⇒ 打印最接近项 + 15 档全列表、
  exit 2）、`scripts/lib/batch-common.mjs parseSpec()`（错误含「最接近：…」）、UI `startExperiment()`
  （toast「实验未启动：无法识别的战术档位 A=…」并拒绝启动；`test/app/experiment-start.spec.ts` 2 例：
  拒绝 + 正对照）。③ `batch-common.mjs` 新增 `PRODUCTION_ORIGIN` / `productionGate()` / `parallelGate()`。
- **「边界严格、展示宽容」是这次的分诊原则**（23 处 `resolve()` 调用点逐个分诊）：下拉/沿革条回调这类
  「值只可能来自白名单」的地方保持严格；**展示与陈旧存档一律走 `tryResolve()`** ——
  `src/core/view/duel.ts versionTag()`（认不出照抄原串，空值仍按当前档）、`src/app/records.ts`（归档分组头
  显示「登记表外的档位：X（原样显示，未归档到沿革条）」）、`src/app/modes.ts:344/349`、
  `src/core/persist.ts loadSettings()`（**净化点**：未知 `tacticsVersion` 回落默认、`sideConfig.*.tactics`
  未知值就地清空）、`effSide()`（陈旧档号不许让开局路径崩）。
- **做了什么（P0b）**：① 三条历史远端 tag（`exp-20261003042812-rapfi1-r1` / `…052056-smoke1-r1` /
  `…052604-x1-r1`，共 26 局）回填 `device_id='ssh-batch'` —— **先补 `devices` 行**，因为
  `games.device_id REFERENCES devices(device_id)`，直接 update 会 `SQLITE_CONSTRAINT_FOREIGNKEY`；
  `code_version` 保持 `dev+nogit`（不猜 sha）。② `scripts/lib/batch-elo.mjs` 新增 `wilson(hits,n,z=1.96)`，
  `rankTable()` 带 `rate/ci/halfPt`，`formatRankTable()` 印区间列 + 样本 < 50 时 `±XX.Xpt ⚠` + 读数纪律注。
  ③ `docs/agents/playbooks.md` §7 新增第 12 条「报表只准聚合口径」，第 11 条补回填 SQL 与
  「NULL `device_id` ≠ 远端局」的提醒。
- **数字**：`resolve()` 严格化后 `npx vitest run` **38 文件 / 399 例**（+14：闸门 7 + Wilson 5 + UI 拒绝 2）、
  引擎自检 **144/144**、`npx tsc --noEmit` 0 错；`device_id='ssh-batch'` 计数 **26**（`code_version` 26 局仍是
  `dev+nogit`）；Wilson 20 局/对半宽 **±20.1 pt**（**教科书 Wald 写法给 ±22 pt 且 0 胜/全胜会越界** ——
  计划里原先写的 ±22 pt 即由此改成 ±20 pt）。
- **教训**：静默回落是「实验结论归因到错档位」这类事故的温床，而它平时**完全不可见**（报表照出数）；
  对策不是加日志，而是让非法值在边界上就**失败并指出最接近的合法值**。展示路径不能跟着严格化，
  否则归档里的历史档位、陈旧 localStorage 会把老数据变成崩溃源（`versionTag(undefined)` 曾让 3 条
  duel 引擎用例红：空值必须仍按当前档显示）。
- **顺带**：`devices` 表原本一行都没有（浏览器也不发 `X-Device-Id`），所以 D1 里 286 局 `device_id` 仍是 NULL
  —— 判「设施产物」要按 tag 或 `ssh-batch`，**别按 NULL 判**。

---

## 2026-10-03 · C0 落地：候选点三数（发 / 评 / 标）逐手入库 + 报表三列

- **做了什么**：`game_moves` 追加 `cands_sent`（**交给 Jev 决定的点数** = 请求 `criteria` 的键数）与
  `cands_labeled`（其中带战术标签的点数），`cands` 保持历史口径（模型给了概率且合法的点数）；
  迁移 `migrations/0003_move_cands.sql`（只加列）。游戏级汇总进 payload `meta.candStats`
  `{graded, sent, labeled, n}`（无样本整键省略）；报告分桶表加「候选发评标」列、累计行加
  「候选点均值 发 X / 评 Y / 标 Z（N 手）」、注脚加「候选点均值 发 X」。
- **口径纪律（沿用 `tac_ms` 那套，别改）**：Rapfi / mock / 人类侧**根本不过 Jev 候选集 ⇒ 记 NULL 而不是 0**；
  0003 之前的老归档也是 NULL（缺失 ≠ 0）。写 0 会把「发给模型几个点」的均值拉低，这是这一列唯一的坑。
- **验证**：`tsc` 0 错；引擎自检 144 例（+2）；vitest 37 文件 / 385 例（+3：worker 候选三数落库往返、
  ui 按手加权分桶与非 Jev 身份 `—`、core 老归档形状映射 null）；黄金零漂移。改动 15 文件 / +352 / −24。
- **教训**：候选数在客户端早就有了（`cands` 对 Jev 手 100% 有值：proxy 9724/9724），缺的一直是
  「交出去几个」；**先量出来再谈优化**，别凭感觉说「候选太多/太少」。
- 计划：`docs/plans/2026-10-03-cands-metric-and-provider-failover.md`（§4.1 实施记录）；C1 探针（commandcode
  `/systemone` 与本协议同形）已完成，C2 起待批。
- **环境坑（会再遇到）**：DSH 的 `node` 跑在 Electron 里，`npx wrangler …` 会被 yargs 的 `hideBin()` 误判成打包版
  Electron 而多切一位参数（`Unknown arguments: remote, …cli.js, d1, …`）；绕行包装 `.work/wrangler-run.cjs`
  （`process.defaultApp = true` + `Module._load(cli, null, true)`）在，`node .work/wrangler-run.cjs <args>` 可用；
  `npm run db:migrate:remote` 等脚本会踩同一个坑。远程 D1 已应用 `0003`（新列 2 / 历史非空 0 / 共 19298 手）。

## 2026-10-03 · 机制线收口：暂停新机制（v14 是最后一版），只留维护 + 数据卫生 + 配对样本设计

- **决定（项目所有者，2026-10-03）**：不再开新机制。理由两条，都是实测结论而非感觉：
  ① A 型速败的机制线已收口——静默普查量到早盘 72–95% 的回合双方都没有强制胜、74–86% 的静默回合
  我方连一个活三制造点都没有，要抬升只能做 2-ply 以上规划 = **规则 10 明令不做**；
  ② 抬档四档比分 79.2 / 52.5 / 77.5 / 62.5 非单调，**同档轮间方差 17.5 pt 大于任何档位差**
  ⇒ 就算写出新机制，现有实验口径也分辨不出收益。
- **恢复条件（写下来，避免下次凭感觉重开）**：先有**能分辨 5 个百分点以内差异的配对样本口径**
  （同开局双跑、双方各执黑），再谈新机制。收口说明落在 v14 计划 §8 末尾引块。
- **同批的数据卫生修复**（`scripts/experiment-worker.mjs`）：远端批量的两个 POST 现在带
  `X-Device-Id: ssh-batch`（`BATCH_DEVICE_ID` 可覆盖；限流键是 `kind:IP`，加头不改限流行为），
  `meta.code` 自报 `dev+nogit+<sha>`（`games.code_version` 读的就是 `meta.code`）。
  **教训**：Node 直载没有构建注入 ⇒ 不显式自报，D1 里就永远是 `dev+nogit`，「哪一版跑的」不可查；
  这类字段的闸门和值域（`DEVICE_ID_RE`）都在 worker 侧，工具侧照抄即可。
  已跑的 26 局（`…rapfi1-r1` / `…smoke1-r1` / `…x1-r1`）保持原状，只能按 tag 认；
  **要真正隔离写入必须换 `--origin` 指到独立 Worker + D1**（工具已支持，未自动化）。
- **清账**：三个已合并且已无用的 worktree 已删除（`.worktrees/review-batch`、`.worktrees/feat-ssh-batch-experiments`、
  以及未注册的 `.worktrees/feat` 目录），`git worktree list` 现在只剩主仓。
- 链接：[v14 计划 §8](../plans/2026-10-03-tactics-v14-fresh-live3.md)、
  [远端批量计划 §P7](../plans/2026-10-03-remote-batch-experiments.md)。

---

## 2026-10-03 · v14 抬档阶梯跑完（3 s 15-1-4、5 s 12-1-7）：四档比分非单调，「跨档位比分不是曲线」第三次成立

- **轮次事实**（同口径单臂各 20 局，`v14-live3-fresh` vs `rapfi`，上线版本 `1.0.0+fe43b16`）：
  `rapfi@3000ms` tag `exp-20261003075310`（用时 2089 s、上游 443 次全 200 / 错 0）**15 胜 1 和 4 负
  （得分率 77.5% · 不败率 80.0%）**；`rapfi@5000ms` tag `exp-20261003082805`（2898 s、496 次全 200 / 错 0）
  **12 胜 1 和 7 负（得分率 62.5% · 不败率 65.0%）**。两轮 `black_think`/`white_think` 在 Rapfi 侧落库
  3000 / 5000、`proxy` 侧 NULL（`c9a4db2` 的值域闸门继续生效）。
- **四档阶梯 = 79.2% / 52.5% / 77.5% / 62.5%（1000 / 2000 / 3000 / 5000 ms），非单调**：这是
  「**跨档位比分不是曲线**」第三次被实测确认（前两次：v13 两轮 20 局、v14 1 s→2 s）。同档轮间方差
  17.5 个百分点 **大于任何档位之间的差** ⇒ **抬档实验读不出机制收益**，继续加局数也不会收敛；
  下一步的首选是**配对样本**（同开局双跑），这条已写进 v14 计划 §8 第 4 条。
- **抬到 5 s 没有暴露新失效模式**（规则 11 口径）：两轮合计 939 个 Jev 回合，我方有杀 210 / 防守机会 254 /
  `vctDefense` 开火 3 / **真救 0** / 拆不掉 **44 手逐条「全盘没有拆点」**；**11 个负局全部「我方有杀 0」**
  （整局没织出自己的杀），两个和局各 225 ½手、防守机会 17 / 29 全数拆掉。链首现分型第五、六次复现：
  胜局我方链 100% 出现且早（15.9 / 24.0 ½手），负局要么晚到（38.3 / 27.0）要么不出现；5 s 档负局
  **只 2/7 出链、压力领先占比 31.7%**（3 s 档负局 43.0%）⇒ 对手更强时「还没织出网就被收掉」的比例上升。
- **成本（必报项，m07650 / m08110）**：3 s 轮 `tac_ms` 中位 247 / 均值 647 / 最坏 5850 ms、占单步均值 **54.9%**；
  5 s 轮中位 225 / 均值 792 / 最坏 6762 ms、占单步均值 **57.7%**（Rapfi 固定 3000 / 5000 ms，UI 上限 10 000 ms）。
  战术层量与档位无关（中位 225–247 ms 稳定），占比升高来自上游往返变慢。
- **纪律**：机制线（v14 之后的进攻侧）已按静默普查收口（v14 计划 §8 第 1 条）；本轮只做「抬档鲁棒性」，
  没有新增任何机制、没有改引擎。登记表 `v14-live3-fresh` 的 `gamesVerified` 12 → 20 → 20 → 20 ⇒ **72**。
- 链接：[v14 计划 §6.7 / §6.8](../plans/2026-10-03-tactics-v14-fresh-live3.md)、
  [v14 证据页 §4.5](../plans/2026-10-03-tactics-v14-evidence.md)。

---

## 2026-10-03 · `feat/ssh-batch-experiments` 合入 main：独立审查报 5 条阻断项，全部当批修掉

- **合入**：合并提交 `f4e4ce9`（父 `fe43b16` + `6997961`），19 文件 / +2149 行；`src/**` 零改动、零新增运行时依赖。
  冲突只有 5 个公共文档（`AGENTS.md` §4、`docs/README.md`、`docs/adr/README.md`、`docs/memory/MEMORY.md`、`docs/status.md`），
  代码与测试零冲突 —— 全部由编排者收口。**ADR 撞号**：分支的 `0018-remote-batch-experiments` 与 main 的
  `0018-live3-fresh-correction` 同名 ⇒ 前者改号 [ADR-0019](../adr/0019-remote-batch-experiments.md) 并同步全仓引用。
- **教训（审查抓到 5 条，都不用跑棋就能看出来）**：
  1. **新增写库路径必须复用既有值域闸门**：worker 曾无条件写 `black_think/white_think = thinkMs || 0`，
     把 `proxy` 侧写成「0 毫秒档」——一个不存在的身份。同一份口径已经写在 `src/core/record/export.ts` 的
     `thinkMsOf()` 里，工具侧照抄判据即可（`tacticsLabel()` 同理：`games[].blackTac` 直接写 plan 会造
     `rapfi|v13-pressure-gate` 幻影身份）。**任何「第二写入者」都要先问：这条字段的闸门在哪。**
  2. **文档写「串行」而代码并发**：`--rounds>1` 原先一口气 nohup 全部轮次，与自家闸门文案、计划、ADR 的
     「双上游必须串行（限流）」直接矛盾 ⇒ 改为「起一轮 → 轮询 pid 退出 → 再起下一轮」。
  3. **断点续跑必须回读胜负**：checkpoint 命中只带 `{status:'skipped'}` ⇒ 续跑轮的实验档案里这些局**凭空消失**
     （`total` 偏小甚至 0），而出口码还是 0（假绿）。修法 = 回读 `winner/plies/gameUid` 一并计入；
     `resume` 少了一段 key 注入 ⇒ 上游臂续跑必 exit 2（唯一容错手段失效）。
  4. **幂等键要能区分「同一批次」与「同一天」**：`batchId` 缺省只有日期、本地 plan 直接覆盖、checkpoint 只比状态
     不比 tag ⇒ 同日第二次 submit 会**一局不跑、exit 0，还 POST 一行 `total=0` 的实验档案**。
  5. **归档阶段也要有超时与幂等**：`POST /api/games` 原先无重试无超时、不受 `timeoutMin/stallMin` 覆盖（挂住即挂死）；
     续跑重跑会生成新 `gameUid` ⇒ `dedup_key` 变 ⇒ D1 里同轮同局两份棋谱都算数。修法 = 先落 `pending`+uid 再归档、
     续跑复用同一 uid、归档后按 uid 核对。
- **顺手归一**：`identityOf` 两处实现收敛为一处（`scripts/lib/batch-common.mjs`，空档留空 = `rapfi||500` 形状，
  与归档/报表桶键同形）；`pull` 不再先 `rm -rf` 本地目录；`scp` 不再把 SIGTERM 当成功；退避预算按**每一手**重置。
- **验收**：`npx tsc --noEmit` 0 错 · `node test/engines/run.mjs` **142 例** · `npx vitest run` **37 文件 / 382 例**
  （`test/scripts` 44 例，含新增的 `ckptAction()` 续跑判定）· `npm run check:docs` **55 md / 355 链接**。
- **未闭环**：远端批量的数据卫生（每批稳定 `X-Device-Id` / 按 tag 清账）与 `.worktrees/` 清理，等业主决定。

## 2026-10-03 · v14 抬档到 `rapfi@2000ms`：9 胜 3 和 8 负，和局变多、失效模式不变（跨档位比分不是曲线）

- **轮次事实**：tag `exp-20261003050139`，单臂 **20 局** vs `rapfi@2000ms`，用时 **3453 s**，
  上游 **760 次调用全 200 / HTTP 错 0**，`code_version = 1.0.0+d2f1b1d`。
  `black_think` / `white_think` = **2000** 只写在 Rapfi 侧（proxy 侧 NULL，各 10 局）⇒ 落库修复在 2 s 档同样成立。
- **战绩**：**9 胜 3 和 8 负（得分率 52.5% · 不败率 60.0%；执黑 5-3-2 / 执白 4-0-6）**，平均 76 手；
  三个和局全是 **225 ½手满盘互拆**。同版本 1 s 档是 12 局 9 胜 1 和 2 负（79.2%）⇒ **比分下降**。
- **为什么不是变弱**：① 和局 1 → 3；② 负局更长（负局链首现 **74.7** ½手 vs 胜局 **13.6**）；
  ③ 失效模式不变——760 回合里我方有杀 74、防守机会 187、**真救 0**，拆不掉的 **34 手逐条「全盘没有拆点」**，
  **8 个负局全部「我方有杀 0」**；④ 和局压力领先占比 66.4% ⇒ 我们压着对手但换不掉杀。
- **成本**：`tac_ms` 中位 **199** / 均值 **627** / p90 1955 / 最坏 **6441 ms**，单步墙钟均值 1176 ms
  ⇒ 占单步均值 **53.3%**（Rapfi 固定 2000 ms/手；占比不可跨轮比）。
- **纪律**：**跨档位比分不是曲线**，而且同档轮间方差实测 17.5 个百分点 ⇒ 抬档只说明「对手变强」，
  不能读成自己退步或进步；要判断机制收益必须用**配对样本**（同开局双跑）。
- **接管面（760 手）**：无接管 266 · `live3Attack` 99 · `block` 94 · `vcfDefense` 67 · `live3Defense` 66 ·
  `vctAttack` 57 · `parry4` 34 · `pressureGate` 25 · `parry3` 17 · `open4` 9 · `win` 9 · `vcfAttack` 8 ·
  `parry` 5 · `vctDefense` 4。
- 计划与读法：[plans/2026-10-03-tactics-v14-fresh-live3.md](../plans/2026-10-03-tactics-v14-fresh-live3.md) §6.6 / §7。

---

## 2026-10-03 · v14 `v14-live3-fresh` 上线：修的是给模型看的事实，不是棋力

- **机制**：`live3After` 自 v10 起漏了「本手新造」前提 ⇒ 本方已握 ≥2 个活四制造点时**任何闲棋**都算「制造活三」。
  v14 加可选基线（`l2Set` / `freshL2After`），`live3Makers` / `live3Deny` 收 `opts.fresh`，战术层按
  `M.live3Fresh` 传参；**缺省仍旧口径**，所以 v0–v13 的历史归因与回放逐字不变。不改层数、不加深搜索。
- **影响面（五轮 3864 个我方回合，独立实现复算）**：引擎报点 18675 → 假点 12676（**67.9%**）；整集全假 16 回合（占非空 1.0%）；
  真接管 `live3Attack` 289 手 + `live3Defense` 122 手**没有一手**落在幻影点（411/411 两套口径判据一致），
  78 手幻影实走全部来自 `block`/无接管/`win` ⇒ **一手决策都没改**，改的是 **212 手 / 5.5% 回合**注入模型的事实。
- **线上实证**：`b6c6921` 部署后对照轮 `exp-20261003035953`（12 局 vs `rapfi@1000ms`）**9 胜 1 和 2 负**
  （不败率 83.3%），从归档记法独立重放 316 手 ⇒ live3 两层接管 **60/60 落在纠正口径内**、事实面 22 手 / 7.0% 被修
  （点数 2481 → 972）。两负在最前两局且**全程「我方有杀 0」**、拆不掉的 7 手逐条「全盘没有拆点」⇒ 仍是 B 型长局。
- **口径纪律**：① 这是**纠偏不是杠杆**，12 局量级上强度不可分辨（与 v13 同档 9-0-3 差一局 < 同档轮间方差 17.5 个百分点）；
  ② 战术层**占比不可跨轮比**（本轮 46.2% vs v13 同档轮 4.9%，差在上游 66 次 HTTP 错）；③ 探针里
  **`live3Defense` 的正确性判据是「对手的点」**（`live3Attack` 才是自己的点）——写错过一次。

---

## 2026-10-03 · 冒烟与探针的两类假红：node 不走系统代理、同一个 D1 有第三方在写

- **坑 1（网络）**：`npm run smoke:live` 连续两次死在 `UND_ERR_CONNECT_TIMEOUT`（`104.21.58.114:443`／
  `172.67.159.102:443`，各 10 s），而同一分钟 `curl.exe` 与 `Invoke-RestMethod` 打同一个域都是 **200 / 0.95 s**。
  根因：本机系统代理 `127.0.0.1:10808`（注册表 `ProxyEnable=1`）只被 WinHTTP/curl 使用，
  **Node 的 undici 默认直连**，于是直连路线一抖就整体超时（也解释了此前偶发的 `UND_ERR_BODY_TIMEOUT`）。
  修法：跑 node 网络脚本前设 `$env:HTTPS_PROXY='http://127.0.0.1:10808'; $env:NODE_USE_ENV_PROXY='1'`
  （Node 24 起支持 `NODE_USE_ENV_PROXY`），实测 3/3 成功、单次约 300 ms ⇒ 冒烟 **30/30 全过**。
  Chrome 走系统代理，所以长跑实验与记分牌不受影响。
- **坑 2（并发写库）**：同一时间 `smoke:live` 的「写入后 totalGames 恰好 +1」红成 `233 → 235`。
  查 `/api/games`：另一个 Agent 的**批量对弈 worker 正在直连线上库**，每 ~30 s 落一局
  `random` vs `rapfi`（`code_version = dev+nogit`，tag `exp-20261003042812-rapfi1-r1`，**不建 `experiments` 行**），
  实测 12 局 1 轮（04:30:13–04:39:35Z）。这是 `feat/ssh-batch-experiments` 分支（`experiment-batch.mjs` /
  `experiment-worker.mjs`）在跑，属于并行 Agent 的正常行为，不是回归。
- **结论 / 纪律**：① 「全局计数恰好 +N」这类断言在多 Agent 并行下天然会假红，
  `scripts/smoke-live.mjs` 已放宽为「至少 +1（Δ 一并打印，>1 时标注『期间有其它写入』）」，
  「我们这一笔恰好一局」由 `?device=me` 与逐手保真断言把关；② `docs/status.md` 的「数据现状」
  **只统计本仓库脚本跑出来的部分**，第三方写入会让线上总数漂移 —— 分析一律**按 `experiment_tag` 过滤**，
  不看总数；③ 这类第三方棋谱的 `code_version = dev+nogit`，**不可用于版本归因**。

---

## 2026-10-03 · 固定思考档（`black_think`/`white_think`）长期未落库：成本对照只能翻轮次配置

- **症状**：AI-AI 对比实验的每一局，`games.black_think` / `white_think` 都是 NULL，而轮次表
  `experiments.think_a` / `think_b` 有值。写 v14 报告要做「战术层 vs Rapfi 固定档」对照时才发现——
  只能回头翻 `.work/exp-arm*.json` 的 `config.thinkB` 与展示名 `Rapfi(1s)`。
- **根因**：`src/core/record/export.ts` 的 `buildGameExport()` 从来不写这两个键（只写渠道与战术档），
  服务端 `src/shared/record-map.ts:375-376` 照 `payload.blackThink`/`whiteThink` 取 ⇒ 恒 NULL。
  `src/ui/panels/experiment.ts:150-151` 的 `expInfoFor()` 确实把两侧 `rapfiThinkMs` 写进了 `expInfo`，
  但那份快照只进轮次表与结果表，不进棋局 payload。
- **修法**：导出侧新增 `thinkMsOf(channel, …candidates)`——**只在 `channel === 'rapfi'` 且预算 > 0 时写**；
  `proxy` 的「思考时间」是模型往返、人类侧没有预算，写 0 会被报表读成「0 毫秒档」（与 2026-10-02
  `rapfi|v9-vcf-sound` 幻影身份同源）。取值优先轮次快照 `expInfo.*Think`，回落 `sideConfig.*.rapfiThinkMs`。
- **教训**：凡「报表要用、但只是配置派生」的字段，都要确认它**真的进了棋局 payload**；晚一轮就少一轮数据，
  而且事后只能靠工具脚本补救。同理可查的还有：`games.tactics_version` 只反映人机局的黑方（已知）。

---

## 2026-10-03 · 20 局档位复核：同档方差大于档位差，比分口径失效（要配对样本）

- **为什么做这一轮**：项目所有者要求把 v13 对 Rapfi 的两个档位各跑 20 局（m10573），用来检验
  「胜率逐版上升后抬 Rapfi 思考档」这条迭代前提（m08704）。
- **结果**：`rapfi@1000ms` 20 局（tag `exp-20261003003108`）**11 胜 1 和 8 负（57.5% / 不败率 60.0%，
  执黑 6-0-4 / 执白 5-1-4，平均 47 手）**；`rapfi@2000ms` 20 局（tag `exp-20261003020720`）
  **13 胜 2 和 5 负（70.0% / 75.0%，执黑 8-0-2 / 执白 5-2-3，平均 60 手，两局 225 手和棋）**。
  同档合并（两个 1000ms 轮）= **32 局 20 胜 1 和 11 负（64.1%）**。
- **结论一（最重要）：加局数分辨不出档位效应**。同一个 1000ms 档，12 局时 75.0%、20 局时 57.5%，
  **同档两轮差 17.5 个百分点 > 两档之间的差（12.5 个百分点）** ⇒ 比分由上游采样方差主导。
  要比档位必须用**配对样本**（同一批开局，两档各跑一遍），不是继续加局数。
- **结论二：「战术层占单步比例」跨轮不可比，必须同轮同分母**。两轮 `tac_ms` 中位 240 / 262 ms、
  均值 661 / 685 ms、最坏 5961 / 7090 ms（**两轮一致，机制层稳定**），但占比 6.9% vs 59.7%
  —— 差的是**上游**：1000ms 轮有 99 次状态 0 传输错误、模型往返均值 8854 ms；2000ms 轮 0 次错误、462 ms。
- **结论三：机制层的判定在 4 倍样本上复现**。两轮逐手复盘共 **1067 个 Jev 回合**：40 个「拆不掉」
  回合**全部是全盘没有拆点**（已经输了的局面）；`vctDefense` 两轮合计开火 3 次、**真救 0**；
  链首现分型仍是 A 型「速败被压」（我方链全程不出现、领先占比 13–18%）与 B 型「长局有压力收不了官」。
- **教训（流程）**：密钥不能「盲取第一把」——从浏览器 profile 里读到的 key 可能是失效历史值，
  整轮 401 白跑（连续代点重试 10 次、0 局完成）。改成**先实测探针再起跑**
  （`.work/print-key.mjs` 按候选序逐个 POST `/api/jev`，取第一把非 401 的，只打印长度与 sha8）。

## 2026-10-03 · SSH 远端批量对弈实验设施上线（ADR-0019）

- **做了什么**：新增 `scripts/experiment-worker.mjs`（纯 Node 对弈回路）+ `scripts/experiment-batch.mjs`
  （本地编排 submit/resume/status/pull/elo）+ `scripts/lib/batch-{common,elo}.mjs`（零依赖纯函数，29 例单测）。
  对弈回路 = `getGame('gomoku')` → `decide`/`applyMove` 循环 → `buildGameExport` → `POST /api/games`
  → GET `?tag=` 核对。目标机 `185.242.234.48`（alias `qijia`，2C/1.9GiB/45G，
  装了 Node 24.9.0）。kill -9 续跑已实测（checkpoint 跳过已完成局）。
- **踩坑（每条都花过时间，按复用价值排序）**：
  1. **`src/core/tactics-versions.ts` 的 `VERSIONS` 是数组不是 map** ⇒ `Object.keys(VERSIONS)` 得到
     `['0'..'13']`，用 `ids()`（返回 14 个 id 字符串）。`resolve(id)` 对未知档号**静默回落 CURRENT**
     （测试固化的"特性"）⇒ A/B 写错档号会静默变 v13 且事后不可检出，spec 解析层必须显式 throw。
  2. **OpenSSH 的 `scp` 没有 `-n` 选项**（`ssh` 才有）：把 `-n` 混进通用 `SSH_OPTS` 会让 plan 上传
     直接失败、远端 worker 秒崩。拆成 `SSH_OPTS` 与只给 ssh 用的 `SSH_LAUNCH_OPTS`。
  3. **ssh 会话会被 nohup 后台进程拖住**：`cmd & echo` 后 ssh 不返回（等后台进程结束）。
     实测 `nohup cmd >>log 2>&1 </dev/null & echo` ≈ 2.4 s 返回，`setsid cmd </dev/null >/dev/null 2>&1; echo`
     ≈ 10 s，`setsid cmd & echo` 不返回。用前者 + pid 落盘。
  4. **经 ssh_exec 内联 echo 写 authorized_keys 会改字符**（base64 差一位 ⇒ pubkey 认证静默失败）。
     正确做法：写本地 `.pub` → `ssh_upload` → 远端 `printf '%s\n' "$(cat …)" > authorized_keys`。
  5. **`rapfi-single-simd128.js` 在 Node 下的加载姿态**：UMD 尾部 `module.exports=Rapfi`，仓库
     `package.json type=module` 让 `.js` 走 ESM（直接 eval 撞 `ERR_AMBIGUOUS_MODULE_SYNTAX`）⇒
     复制成临时 `.cjs` + `createRequire` 加载；`locateFile` 指回 `public/rapfi/`。
     退出时胶水 `ha=(a,b)=>{process.exitCode=a; throw b}` 会把进程退出码置 1（teardown 噪声）
     ⇒ worker 末尾按 summary 显式设 `process.exitCode`。
  6. **`effectiveChannelOf` 没 apiKey 会把 `random` 兜底成 `mock`**（`src/core/persist.ts:158-173`）：
     归档 slug/duelLabel 显示"演示"，但结构化字段 `blackChannel=random` 仍正确 ⇒ worker 必须透传
     `session.settings.apiKey`（export 不带 settings，不泄密）。key 放远端 `/root/.jev-key`（chmod 600），
     worker 启动命令 `set -a; . /root/.jev-key; set +a` 注入；**本机 orchestrator 不需要持有 key**
     （一度写成本地预检，反被本机拦死）。
  7. **`GET /api/games` 列表项是 camelCase**（`gameUid` / `experimentTag`），数 `r.tag` 恒 0。
  8. **tag 撞车**：`exp-YYYYMMDDHHmmss` 秒级精度 + `experiments` upsert 覆盖 ⇒ batchTag 追加
     `-<batch>-r<i>`（≤64）。
  9. **Node 与浏览器跑 rapfi 的行为对齐结论**：同资产同输入**逐手一致**（自对弈 12/12、重放归档局 12/12）；
     对浏览器归档逐手复盘 85.9% 不一致的残差在 Node↔Edge 上给出**相同着法且都不等于归档**
     ⇒ 残差是浏览器运行时墙钟抖动，**rapfi 臂绝对着法不可逐字复现**，实验结论只认聚合口径。
     附带既有状态：`.data` 里没有 `model210901.bin`（39MB classic model），**Node 与 Edge 都报**
     `ERROR Unable to open model file` ⇒ 引擎跑缺省配置，这不是回归。
  10. **pwsh 工具管道捕获 ssh stdout 时可能挂起**（stdin 管道保持打开）：本机跑编排 CLI 用
      `cmd /c "node scripts\experiment-batch.mjs … < NUL > log 2>&1"` 包一层即可稳定返回。
   11. **和棋没有 `winner` 字段**：导出/D1 口径里和棋长这样——`result:"和棋（棋盘已满）"`、
       `winner` 根本不存在（`src/shared/record-map.ts:251-258` 的 `parseResult()` 对和棋返回
       `winner:null`；D1 `games.winner` 也是 NULL）⇒ `batch-elo.mjs` 原先只认 `winner==='draw'`，
       把 x1 两局 225 手满盘和棋当「未终局」整局丢掉（Elo 只算 22/24 局、和棋列全 0）。
       判和棋必须匹配 result 串 `/^和棋(?:（(.+?)）)?\s*$/`（与 parseResult 同形），
       endReason 从括号里取。这违反铁律 11「不唯胜率」——**和棋漏一局就是 Elo 偏一截**。
- **战果（截至 2026-10-03，K=16，和棋 0.5；合并 Elo 见 `.work/elo-remote.json`）**：
  `proxy|v13|0` 1551.9（14 局 10胜2和2负）、`rapfi|-|0` 1503.1（12 局 6-0-6）、
  `random|v13|0` 1481.4（14 局 6-0-8）、`rapfi|-|500` 1463.6（12 局 2胜2和8负）——
  即 **proxy·v13 对 rapfi@500ms 合计 6 胜 2 和 4 负**（x1 12 局口径），均 ⚠样本不足(<50)。
  三轮 26 局全部归档 verified：rapfi1 12 局 + smoke1 2 局 + x1 12 局（含 2 局 225 手满盘和棋）；
  三轮都已补 `/api/experiments` 行（x1 是旧代码跑的，用 `.work/backfill-experiments.mjs` 事后补，
  HTTP 200；此后的轮次由 worker 轮末自动补）。
- **运维事实**：box 上 `/usr/local/bin/{node,npm,npx}` 软链到 `/opt/node/bin`（非登录 shell 找不到 node）；
  仓库 public 可 https clone，但 **box 上没有 github key ⇒ 只能 https 拉、不能 ssh 推**；
  本机 `~/.ssh/id_ed25519` 已授权到 box。

---

## 2026-10-03 · v14 证据评审：16 个探针 + 2 个对照，两个领跑候选都被否掉（机制仍未选定）

- **为什么做这一轮**：v13 的 A/B 判定「这一轮输在赢不了、不是防不住」（见下一条），于是方向转到
  **进攻侧 / 无杀期的形状积累**。接力 agent 在 02:29–07:35 跑了 16 个离线探针（**只重放归档，
  没有新对局**），本次审查又补了两个对照实验来检验它的领跑候选。结论落成
  [plans/2026-10-03-tactics-v14-evidence.md](../plans/2026-10-03-tactics-v14-evidence.md)。
- **可以复用的负结论（5 条，不用重跑）**：① 负局**全程没有强制胜链** —— 放宽预算/判据后 111 个
  负局回合仍 **100% 无链**（放宽档耗时均值反而 2093 ms），胜局 158 回合里也有 48.7% 放宽后仍无链；
  ② **不是漏防**（负局「必挡点漏防」0/15）；③ **不是漏杀**（漏杀 2 手全在终局，实走就是 `win` 五连；
  「有造杀点没走」= 0）；④ **不是送活三**（负局送出 0.0%；抢活三被拆率 **胜 43.8% > 负 20.0%**，
  方向与「白送」假设相反；抢逼手后对手拿到链 0 手）；⑤ **不是赛跑口径**（整回合「输赛跑」两侧 0.0%
  ⇒ 该判据只能当优先级降级，不能当禁令）。
- **候选一 `maxRun`「织网 / 连+1」：被它自己的准入判据否掉** —— 负局占比 **25.4%（18/71）
  低于**胜局 **54.9%（39/71）**（要求相反），抬升量 1.17 vs 1.23 是噪声级，只有在强局才开火；
  「实走降了 maxRun」两侧都是 0/71 ⇒ **不做**。
- **候选二「抢活三前先验对手应手」（探针 `live3-counter`，负 47.1% vs 胜 18.5%）：被两个独立对照否掉** ——
  ① `.work/review-v14-control.mjs`：16 个「必带链」负局回合里，**根局面（我们还没落子）对手就已经有链
  = 16/16（100%）**，「我们落子后才出现链」= 0，而且这 16 手的实走**全是防守层**
  （`vcfDefense` 12 / `pressureGate` 2 / `parry` 1 / `vctDefense` 1，**没有一手抢活三**）
  ⇒ 该判据量到的是「对手本来就有链」，规则会在我们本来就没抢的回合开火；
  ② `.work/review-live3-gift.mjs`：对**实走的 29 手活三**逐手算三基线（根局面 / 我们落子后 /
  对手应手后抽样 8），**出现链 0/29**（负局 13 手与胜局 16 手全 0）⇒「抢活三 = 送链」在这轮
  一次都没发生。**⇒ 这条线也不作为 v14 机制。**
- **教训（值得写进规矩）**：判定「某手送出了威胁」必须带**根局面基线**（我们未落子那一刻的状态），
  只看「落子后」会把「对手本来就有链」记成我们的锅；同样，候选判据要在**实走确实是那一层**的回合上
  验证，否则规则会在根本没做那件事的回合上开火。
- **口径纪律**：`v14-shape-probe` 的「胜 316 / 负 222 回合」是**双方手数**（总 535 手），
  其余探针的「胜 158 / 负 111」才是 Jev 回合 —— 两套单元**不可互引**；负局只有 3 局
  （`d2c97ae4` / `895901dd` / `4cd6cc63`），任何「负 vs 胜」比例都是这 3 局的副本。
- **仍然开放**：病根还没定位到可实施的机制。下一轮的第一个探针应该是
  **「对手的强制胜链出现点 vs 我方形状（做四 / 活三 / 连）里程碑」的逐 ply 对照**，
  而不是再挑一个候选直接实现；若要做比例类结论，先把样本扩到 ≥ 50 局/档。
  进攻侧最大的已知坏件仍是 `live3After` / `live3Deny` 的旧口径缺陷（ADR-0015），
  改它会同时改 v10/v11/v12 三档行为 ⇒ 必须单独一版 + 单独 A/B。
- **本轮顺手修掉的登记/文档缺口**：v13 登记项 `gamesVerified: 0 → 12`（note 补 A/B 段，
  被打断的首轮 `exp-20261002154056` 3 局不计入）；`docs/README.md` 的 v13 行转 ✅、
  adr 树补 0017、plans 树补本篇；[ADR-0017](../adr/0017-pressure-gate.md) §5 第 5 条转「已完成」、
  第 4 条成本统一为 **3.2/3.3/6.1 ms**；`docs/status.md` 数据现状 → **169 局 / 11310 手 / 18 轮**、
  一致性补 `v13-pressure-gate` 15 局 328 手、第 28 条改「A/B 已判定」；删除仓库根 0 字节垃圾文件
  `console.log('ERR`。
- 证据（都不入库）：`.work/v14-*.mjs` / `.log`（16 个探针）、`.work/review-v14-control.log`、
  `.work/review-live3-gift.log`、`.work/review-v13-round.mjs`（v13 轮独立复算：9-0-3 / 269 手 /
  接管交叉表）、`.work/review-run-json.mjs`、`.work/review-check.mjs`。

---

## 2026-10-03 · v13 对照实验跑完：机制按设计工作，但它不是瓶颈；真正的瓶颈在进攻侧

- **实验**（tag `exp-20261002160819`，`rapfi@1000ms` 档，12 局黑白交替，与 v12 同开局同档）：
  **9 胜 0 和 3 负（75.0% / 不败率 75.0%，执黑 4-0-2 / 执白 5-0-1，平均 45 手）**，
  用时 3450 s，上游 335 次（in 805,491 / out 148,874 tok，HTTP 错 66 次**全部重试成功**、
  页面错误 0）。v12 同档是 **10 胜 0 和 2 负（83.3%）** ⇒ **一局之差落在 12 局样本的噪声内，
  比分口径在这轮是无效判据**，不能据此说 v13 变弱或有用。
- **决定性证据 —— 接管标签 × 局结果的交叉表**（`.work/v13-vs-v12-turns.mjs`）：
  四个「进攻 / 直接取胜」类层 `vctAttack` / `open4` / `win` / `vcfAttack`
  在 **9 个胜局合计命中 79 手，在 3 个输局命中 0 手**；三局负局的「我方有杀」也全是 0。
  ⇒ **这一轮输棋不是「防不住」，是「赢不了」** —— 而 v13 是纯防守机制，结构上治不了这个病。
- **v13 机制自己的账**：开火 14 手，落在 8 胜 / 0 和 / 6 负的局里（`#1(L)×1`、`#2(L)×3`、`#5(L)×2`、
  `#7(W)×4`、`#9(W)×1`、`#12(W)×3`）。逐手多数是干净压制（对手做四手数 2 → 0），
  也有一手对手 6 → 4 仍留双四（`d2c97ae4 ply27`，该局负）。
  **14 手把对手压力确实压下来了，但没有一手换来翻盘。** 旁证：v12 侧「该被改写」的那 5 手
  活三**全部在胜局里** ⇒ 闸门判据抓住的是「通常无害、偶尔让掉攻势」的手，不是坏的手。
- **判定：v13 保留但不加码**（不伤胜率、`pressureCut` 仅 3.2 ms），**下一版转向进攻侧**。
- **进攻探针（`.work/v14-attack-probe.mjs`）排除了一半可能**：
  轮级 **漏杀（有强制胜链却没走链首）只有 2 手且都在终局**（`ply46 实走 I6(win)` 这类，本就已赢），
  **「有造杀点没走」= 0** ⇒ **接管链没有漏掉已算出的牌**。
  「有活三可造却没造」18 手全部被更高层正确接管（`vcfDefense` / `pressureGate` / `vctDefense`），
  不是漏杀，是优先级。⇒ 负局的成因只能是**「进攻类层在负局压根没开火」**，
  下一步要查的是**形状真的不够**还是**开火判据太严**。
- **成本口径的坑（值得记住）**：本轮 66 次 HTTP 重试把模型往返均值抬到 9595 ms、
  单步墙钟 p90 42008 ms / 最坏 46296 ms，**战术层占比因此被稀释到 4.9%**（v12 同档是 51.6%）。
  战术层本身 `tac_ms` 中位 230 / 均值 498 / p90 1027 / 最坏 6046 ms。**跨轮比「战术层占单步比例」
  没有意义**，必须同轮同分母（本条是 2026-10-02 那条结论的延续，本轮再次验证）。
- **脚本层面的三个坑（都踩过）**：① 统计口径分层要写进注释（`meet` / `reach` / `changed` 混成一个
  计数会印出自相矛盾的输出）；② 逐轮小计与汇总是两套计数器，漏一个就印出全 0（本轮差点把错数字
  写进文档）；③ 分析脚本对线上 API 的 `fetch` 必须带重试 —— Cloudflare 边缘偶发
  `ConnectTimeoutError` / `ECONNRESET`，而复盘往往在实验跑完后才做，代价已付。已给
  `.work/arm-v12-report.mjs` 与 `.work/v12-round-postmortem.mjs` 加了 5 次退避重试。
- 证据（都不入库）：`.work/exp-arm10-v13-rapfi1000.json` / `exp-arm10-v13-rapfi1000b.log`（心跳+结算）、
  `.work/exp-arm10-stats.json` / `exp-arm10-stats.log`（战绩+接管直方图+成本）、
  `.work/v13-postmortem.log`（败局体检）、`.work/v13-vs-v12-turns.log`（交叉表）、
  `.work/v14-attack-probe.log`（进攻探针）。详见
  [plans/2026-10-02-tactics-v13-pressure-gate.md](../plans/2026-10-02-tactics-v13-pressure-gate.md) §6–§9。

---

## 2026-10-02 · v13 压力闸门：对手「做四点」压过我们时，先削点而不是抢自己的活三

- **为什么做这一版**：抬高 Rapfi 思考档那一轮给出的结论二（败局形态固定：**我方有杀 0 + 全盘没有拆点**）
  把下一版的方向指到了**预防**，并且点名了具体现象：对手的「造四点」数在杀棋前 4–6 手开始爬升，
  而我方那几手还在跑 `live3Attack`。这一版就是那个「压力闸门」（ADR-0016 结尾列为「不做，下一版再说」的那件事）。
- **证据（`.work/v13-pressure-probe.mjs`，六轮 rapfi 对照共 1787 个 Jev 回合逐手离线复算）**：
  归档标签 `live3Attack` 的实走 **205 手（11.5%）**，其中 **39 手（19.0%）落子前对手做四手数已超过我们**
  （胜 28 / 和 3 / 负 8）；这 39 手实走之后**对手仍握双四威胁（≥2 个做四点）的 37 手**；
  改用「贴着对手做四点削」的点集：**37/39 更优、0 更差、平均 −1.87 个，双四威胁 37 → 7**。
  语义依据沿用 ADR-0015：活三只是**逼手**不是杀（真双威胁实测 0 次），真强制胜早被 `vcfAttack` /
  `vctAttack` 接管 ⇒ 让位给削点**不会漏杀**。
- **第一版设计被自己推翻（值得记住的过程）**：「只拦不削」（压力落后就不走 `live3Attack`）在引擎真算下
  站不住 —— 25 个「抢活三而对手压力领先」的回合里只有 5 个真的落后，而这 5 个的 `live3_deny_points`
  **全为空**（引擎 `live3Deny` 的候选与判据都比独立实现严）⇒ 拦下来只会掉到 parry 系，探针里的 −1.87
  复现不了。**教训：离线探针的「理想点集」不等于既有层的输出，设计前必须用引擎真算复核一遍。**
- **机制**：引擎 `fourPressure`（双方做四手数，默认不早退）+ `pressureCut`（1-ply 削点：
  候选序 = 模型候选 → 对手做四点车氏 ≤2 邻域（近者先）→ 其余邻近空点，上限 120；判据 = 落子后对手
  做四手数**严格下降**，并列取己方做四手数更大者，保留 3 个）。战术层新增 `pressure_you` /
  `pressure_opponent` / `pressure_cut_points`，接管链在 `vctDefense` 与 `live3Attack` 之间插
  `pressureGate` 成**十四级**；开火四条 = 版本闸门 + 有削点 + 压力落后 + 对手无 2 手杀（`danger_points_opponent`）。
  **削点为空则不开火 ⇒ 没有削点的局面与 v12 逐字一致。**
- **两个 bug（都是「静默失效」型，值得复用）**：① **候选序**：`computeTactics` 的调用点若把「全部合法着法」
  当优先序传进去，削点搜索就退化成**行序盲试**，最优削点 `C8`（对手 6 → 4）被挤出候选上限 ⇒ 削点集恒为空，
  表现为「25 个落后回合 / 0 个削点」；修法是**候选为空就传空**，不要兜底成全部合法着法。② **只认手数不认杀**：
  p18 夹具（双 danger 并存）被抓到会挑危险点，修法是加 `danger_points_opponent` 这条与 `live3Attack` 同款的安全线。
- **回归扫描（回答「有没有回归降低能力的风险」）**：`.work/v13-cut-check.mjs` 把三个 v12 回合的
  **800 个 Jev 回合**逐手用 v13 重算。**2026-10-03 重跑时把口径拆成三层**（原版把「有机会开火」
  和「真会改走」混在一个 `fire` 计数里，读起来像自相矛盾）：
  - **条件满足 78 手（9.8%）** = 压力落后且引擎算出了削点（不等于会改走）；被更高层挡住 52 手
    （`vcfDefense` 40 / `parry4` 7 / `vcfAttack` 5 / `open4` 3 / `vctAttack` 3 / `vctDefense` 1 ——
    **优先级正确，不是漏杀**）。全部 78 手里对手做四手数 **更优 24 / 持平 54 / 更差 0**、平均 −0.69，
    双四威胁 **45 → 30**，我们自己的做四手数平均 −0.18；
  - **闸门真接管 26 手（3.3%）** = 前八层全空，**唯一真会改变行为**的样本。其中对手做四手数
    **更优 14 / 持平 12 / 更差 0**、平均 **−1.08**；**代价**是我们自己的做四手数平均 **−1.92 个**、
    13 手让掉攻势 ⇒ 「用攻势换安全」的取舍，划不划算只能由 A/B 回答；
  - **真接管且真改走 20 手（2.5%）**：改走率随对手变强而升（500 ms 档 5/7 → 1 s 档 6/6 →
    2 s 档 9/13）⇒ 这道闸门在越强的对手下越会真正介入。
  - 成本 `pressureCut` 均值 **3.2 ms** / 中位 3.3 / 最坏 6.1 ms（n=78；重跑时把计时从
    `Date.now()` 换成 `performance.now()`，消掉了毫秒级抖动，比首轮记的 4.0 / 9 ms 更准）。
  - ⚠️ **教训**：78 与 26 是两个不同样本，**两行的均值不可并列比较**（首轮文档把 −0.69 与 −1.92
    并排印在一句话里，正是这个坑）。
- **仍未闭环**：① 代价目前只有离线手数量，没有胜率（本版对照实验待跑）；② `live3After` / `live3Deny`
  的旧口径缺陷（ADR-0015）本轮**有意未动**，以保持 A/B 单变量；③ `danger_points_opponent` 是启发式安全线，
  不是「对手下一步必胜」的证明。机制记录见 [ADR-0017](../adr/0017-pressure-gate.md) 与
  [plans/2026-10-02-tactics-v13-pressure-gate.md](../plans/2026-10-02-tactics-v13-pressure-gate.md)。

---

## 2026-10-02 · 抬高 Rapfi 思考档（0.5s → 1s → 2s）：每一局败局都是「我方有杀 0 + 全盘没有拆点」

- **为什么抬**：m08704 要求「当胜率多版本稳步上升之后，提高 rapfi 的思考时间」。`rapfi@500ms` 档上
  v9 25% → v10 67% → v11 75~83% → v12 **12 胜 0 和 0 负**，曲线确实逐版稳步上升，于是同口径连跑两轮：
  `rapfi@1000ms`（tag `exp-20261002121700`）**10 胜 0 和 2 负（83.3%，执黑 6-0-0 / 执白 4-0-2，平均 40 手）**，
  `rapfi@2000ms`（tag `exp-20261002123631`）**7 胜 1 和 4 负（62.5% / 不败率 66.7%，执黑 4-0-2 / 执白 3-1-2，平均 60 手）**。
  2 s 档还首次出现 **225 手满盘和棋**——v10 时代「谁也没织穿」的形态在更强对手下回来了。
- **结论一：抬档换来了检验，但曲线回落**。`vctDefense` 在 500 ms 档 0 次开火，抬档后两轮各命中 1 次
  （1 s 轮它给了点我们走了别的点、实走也把链拆掉了；2 s 轮**实走就是它给的点**、链确实被拆掉）。
  但**三轮累计真救仍是 0**：从来没有出现「不靠它就会输」的回合。
- **结论二（可迁移的判据）：败局的形态是固定的**——**六局负局全程「我方有杀 0」**，
  两轮「拆不掉」合计 9 + 14 手**逐条都是「全盘没有拆点」**。也就是说：防线不是被漏掉的，
  是局面在对手的链出现之前就已经输了。⇒ 下一条强度杠杆只能是**预防**
  （压力闸门：对手「造四点」数压过我们时不要抢自己的 `live3Attack`，改走削他造四点数的点），
  **继续加深搜索既无收益，也违反置顶约束「不吃搜索」**。
- **结论三（成本，按 m07650 / m08110 单独记账）**：1 s 轮 `tac_ms` 中位 285 / 均值 695 / p90 1300 /
  最坏 6843 ms，单步墙钟中位 967 / 均值 1347 ms ⇒ 战术层占单步均值 **51.6%**；2 s 轮 `tac_ms` 中位 257 /
  均值 815 / p90 2910 / 最坏 5362 ms，单步中位 930 / 均值 1509 / p90 3604 / **最坏 36206 ms** ⇒ 占 **54.0%**。
  对手是固定 1000 / 2000 ms 一手；**占比升高是因为对局变长、上游本身更快**（模型往返中位 425 / 403 ms），
  不是战术层变慢（均值 381 → 695 → 815 ms 的上升来自更长的中后盘与更多开火候选）。
- **教训（口径）**：长局会把战术层的最坏值抬高（225 手那局本侧 112 手、战术层均值 958 ms / 最坏 4503 ms），
  报成本时务必**同轮同分母**（用本轮的 `ms` 做分母），不要跨轮比较占比。
- 复现命令：`node .work/arm-v12-report.mjs --tags <tag> --json .work/exp-armN-stats.json` 出战绩 / 接管直方图 /
  分位数；`node .work/v12-round-postmortem.mjs <tag>` 逐手回答「我方有杀 / 防守机会 / 开火 / 真救 / 拆不掉」。

---

## 2026-10-02 · v12 防守轮：进攻侧已经没漏杀，漏洞全在「对手的混合链没人拆」

- **为什么做这一版**：项目所有者要求「根据所有跑的有价值的实验整合出下一版本的战术优化，并过一下已有的棋谱信息（不一定要全量），看看优化是否有回归降低能力的风险，之后再与 rapfi 跑……」（m08704）。整合的结论是：**不要再去挖进攻**。
- **三条硬数据**（`.work/v12-defence-probe.mjs` / `.work/v12-turning-point.mjs` / `.work/v12-defuse-strategies.mjs`，逐手离线复算 v11 的三轮棋谱）：
  ① 进攻侧没有可见漏杀 —— 206 / 175 个 v11 回合里「有必胜链」87 / 72 手，走链首步 84 / 69 手，**「机会真丢」0 手**；输的局（两轮各 2 局、直连轮亦然）全是**一次都没报出链**的局面。
  ② 防守侧有洞 —— 计时轮 175 个回合里「我方无杀而对手有链」**20 手（11%）**，**实走后对手仍有链 8 手（40%），全部落在三局负局**；8 手里 **4 手的实走正是对手的链首点**（占掉链首 ≠ 拆掉链）。根因：`vcfDefense` 只验**纯冲四**链（`vcfWin`），对手换成「活三逼迫 + 冲四收尾」就放行。
  ③ 局面是更早输的 —— 三局负局的「点无回头路」在 ply17 / ply34 / ply26，**最后一口气**在 ply15（40 个候选里 2 个能拆）/ ply32（2/40）/ ply24（1/40），实走是 `B12/vcfDefense`、`G7/live3Attack`、`I11/parry`，**一次都没走那 1–2 个能拆的点**；对手「造四点」个数在杀棋前 **4–6 手**就开始爬升。
- **机制**：引擎新增 `vctDefense(st, defenderId, maxPlies?, opts?)`（`src/core/engines/gomoku.ts`）—— 先算对手的链（有 VCF(7) 用它，否则算含活三逼迫的 VCT(9)），候选按「链上各点 → 链点车氏 ≤2 邻域 → 全部邻近空点（按到链距离升序）」枚举，上限 `VCT_DEF_MAX = 12`；判据是**落子后对手既无 VCF(7) 也无 VCT(9)**（严于 `vcfDefense` 的「只验纯冲四链」）；并列拆法按「模型候选优先 → 对手造四点 ×2 + 活三点更少者优先」保留 `VCT_DEF_KEEP = 3` 个。战术层新增 `vct_win_opponent` / `vct_chain_opponent`，接管链在 `vcfDefense` 与 `live3Attack` 之间插 `vctDefense` 成**十三级**；闸门 = 我方无 VCF/VCT 必胜链且 `vcfDefense` 没找到拆点（实测开火率 ≤11%，不与任何必胜层抢）。
- **候选序是量出来的，不是拍的**：只试链首 12/20、链首+链上各点 12/20、**+链点邻域 13/20**（平均 7.8 点 / 19ms / 最坏 103ms）、全部邻近空点 13/20（15.2 点 / 25ms）。**第三档多抓到的两手**：计时轮 `#8 ply24 → K9`（实走 `I11/parry`）、首轮 `#6 ply52 → K8`（实走 `G10/parry`）。两轮合计 48 个「我方无杀而对手有链」的回合：实走拆掉 33、漏 15，**漏的 15 个里只有 2 个存在能拆的点**，其余 13 个全盘候选都拆不掉 —— 这是「这一版最多只能救 2 手」的诚实口径。
- **回归风险的答法**：用户要求「过一下已有棋谱看有没有回归」⇒ 用 `.work/v12-regression.mjs` 把已归档的三轮 proxy 棋谱逐手用 v12 重算，统计每个 v11 回合的「防守机会 / 老层已认领 / 开火 / 真救 / 本就拆掉 / 拆不掉」（闸门保证开火只发生在老层无解时，`我方有杀` 的回合数不变）。夹具回归用归档局 `f463acff-b01c-4ef6-815f-b4b607d8fb94` 第 24 手：黑 `vcfWin(7).first = 'I11'`，白 `vctDefense` 给 `K9`（走 `K9` 后黑 VCF/VCT 全灭；**走链首 `I11` 后黑两样都还在** —— 这就是当天实走那手的缺陷）。
- **测试**：`test/engines/tactics.test.mjs` 新增⑤d 五例（引擎层 / 拆点 soundness / 档位差异 / 决策级 / 闸门），登记表断言改 13 条 +`CURRENT`/层数对照 2/3/5/6/6/7/9/9/9/11/12/13；`node test/engines/run.mjs` **135 例**（金样仍 1131 手自对弈 + 54 局 4379 手逐手一致）、`npx vitest run` 34 文件 / 337 例、`npx tsc --noEmit` 0 错。
- **对照实验（2026-10-02，单臂 12 局 vs `rapfi@500ms`，黑白交替，tag `exp-20261002115126`，用时 689 s）**：**12 胜 0 和 0 负（得分率 = 不败率 100%，执黑 6 胜 0 负 / 执白 6 胜 0 负，平均 33 手）**，逐版曲线 **25%（v9）→ 67%（v10）→ 83%/75%（v11）→ 100%（v12）** ⇒ 按 m08704 的口径，下一轮应当抬高 Rapfi 思考档。**但本版新增的 `vctDefense` 这一轮 0 次开火**：198 个 Jev 回合里我方有必胜链 78 手、对手有链的防守机会 42 手，实走 **42/42 全拆掉**（真救 0、拆不掉 0），全部由既有层（`vcfDefense` 15 / `block` 12 / `parry4` 3 …）完成 —— 这个 12-0 是攻击层（`vctAttack` 38 + `vcfAttack` 28）与老防守层打出来的。**可迁移判据：闸门越保守，新机制越可能整轮拿不到实战检验**，「本轮没开火」必须在报告里如实标注（否则会把旧层的战功记到新机制头上）；要让新机制被检验，只能提高对手强度，不能靠自我说服。成本：`tac_ms` 中位 **241 ms** / 均值 **381 ms** / p90 896 ms / 最坏 **4161 ms**，单步墙钟均值 1029 ms ⇒ 战术层占 **37.0%**（远高于计时轮的 4.6%，是**上游变快**而不是战术层变慢：均值 402 → 381 ms）。
- **仍未闭环**：①**压力闸门**（对手造四点数压过我们时不要抢 `live3Attack`，改走削他造四点数的点）—— 证据在手，但它改变进攻选择，必须单独一版 + 单独 A/B；②13/15 的漏防是「点无回头路」，真正的入口在杀棋前 4–6 手；③最坏耗时会叠最多 12 点 × 2 次搜索，与 v11 的「最坏 4.6s 同步阻塞」同类，实战最坏 **4161 ms**（198 个样本，与 v11 同量级、未放大一个数量级）。机制记录见 [ADR-0016](../adr/0016-vct-defense.md) 与 [plans/2026-10-02-tactics-v12-vct-def.md](../plans/2026-10-02-tactics-v12-vct-def.md)。

## 2026-10-02 · 两个「静默失败」的教训：定时工作流从没跑通过、冒烟脚本会打错靶

- **每日备份的 CI 工作流从来没有跑通过**（`.github/workflows/backup.yml`，cron `23 4 * * *`）。2026-10-02 顺手 `gh run list --workflow=backup` 才发现只有一条记录：`36996349153` **failure**（33 s），报
  `In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.`
  根因：**`gh secret list` 是空的** —— `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 从未配置，`deploy.yml` 的 `workflow_dispatch` 同样认证不了。
  **可迁移判据：定时任务失败是静默的**——没人点的那条流水线，没人会看它的红灯。凡「靠 CI 兜底」的承诺（备份、导出、巡检）都要在落地当天用 `gh run list --workflow=<name>` 看过一次真绿，才算成立；否则它只是设计意图。已记入 `docs/status.md`「仍存在」第 26 条（修法：建 D1:Read 的 API Token 再 `gh secret set`）。
- **`smoke:browser` 默认目标会打错靶**：缺省 `http://localhost:8787/` 在本机被**别的**应用占着，脚本照样开页面、标题断言还能过，页签一个都查不到 ⇒ **2/13**，失败项全是 `no-*` 标识，看起来像产品回归。
  **可迁移判据：会「打开一个页面」的冒烟脚本必须先自证目标**。已在 `scripts/browser-smoke.mjs` 加前置断言：`fetch(new URL('api/health', URL_TARGET))` 必须返回 `service === 'jev-qiguan-worker'`，否则 `exit 1` 并提示 `--url`；同时修掉「分桶表按 `=== 3` 数格子」的过时断言（`tac_ms` 上线后每行多一格战术，共 4 格）并要求表里至少有一个 Jev 身份行。修后线上 **14/14**。



## 2026-10-02 · v11 计时轮：9 胜 0 和 3 负，战术层 402 ms ≈ 单步墙钟的 4.6%（外加 Rapfi 侧惰性档位标签的幻影身份）

- **为什么再打一轮**：上一轮（tag `exp-20261002055817`，83%）跑在 `tac_ms` 上线之前，`tac_ms` 全 NULL ⇒ 答不了「战术层到底占多少成本」。本轮与 C 臂**同对手同口径**（`v11-vct` vs `rapfi@500ms`，12 局黑白交替），唯一差别是带上了计时，命令 `node scripts/experiment-run.mjs --games 12 --chanA proxy --tacA v11-vct --chanB rapfi --thinkB 500`（tag `exp-20261002094817`，用时 1966 s，上游 213 次调用 / in 471,834 / out 94,723 tok，38 次状态 0 的传输错误全被 `callWithRetry` 重试成 200，零 429）。
- **结果**：`v11-vct` **9 胜 0 和 3 负（得分率 = 不败率 75.0%，12 局零和棋，平均 29 手）**，与上一轮 83% 同量级；三局负局是 #5（v11 执黑 24 手）、#6（执白 35 手）、#8（执白 27 手）。逐手接管：`vctAttack` 49 手（执黑 24 / 执白 25）、`live3Attack` 17、`vcfDefense` 13、`open4` 9、`win` 9、`vcfAttack` 5、`live3Defense` 4、`block` 4、`parry4` 2、`parry`/`parry3` 各 1。
- **成本对照（项目所有者 m08110 要的证据）**：本轮 347 手里 v11 侧 175 手有样本。`game_moves.ms` 均值 **8730 ms** / 最坏 43423 ms（38 手 >5 s）——**这个分母完全由上游决定**（同一战术档在不同轮里 1039 ms / 3487 ms / 8730–10084 ms，浮动来自模型与重试等待）；战术层 `tac_ms` 均值 **402 ms** / 最坏 4474 ms ⇒ **约占单步墙钟 4.6%**。对手 Rapfi 的固定搜索预算是 **500 ms/手**（UI 最高档 10 000 ms 本项目未采集）。**结论：v11 相对 v10/v9 的棋力增量不是靠更大的搜索预算换来的**——它的搜索预算是百毫秒量级且随局面伸缩。逐局 `tac_avg/max`：122/329、735/4474、562/1325、298/936、272/641、288/873、374/792、268/1027、402/960、680/3883、436/970、255/925。
- **逐手复盘**（`.work/v11-postmortem.mjs --tag exp-20261002094817`）：175 个 v11 回合里 **72 手（41%）存在必胜链、69 手走了链首步**，3 手让给更高优先级的 `open4`/`vcfAttack`（同为强制胜），**机会真丢 0 手**；引擎 `vctWin(9 ply)` 平均 79 ms / 最坏 3458 ms。**三局负局全程 0 次报出必胜链** ⇒ 与直连轮、上一轮结论一致：入口在「无强制胜时的防守与长线取势」，不是把 VCT 挖更深。
- **本轮抓出的真缺陷：归档给不过战术层的渠道写了战术档标签（幻影身份）**。Rapfi/mock/人类侧压根不进 `computeTactics`（`src/core/jev/client.ts` 在 `channel === 'rapfi'` 处短路），但归档的 `black_tactics`/`white_tactics` 照抄 A/B 配置 ⇒ Rapfi 侧带着实验脚本的旧默认值 `v9-vcf-sound`，报表按「渠道|战术|思考」分组时冒出 `rapfi|v9-vcf-sound|500` 这种并不存在的身份。修法（只动工具链与归档语义，未碰搜索）：`src/core/view/duel.ts` 新增 `runsTactics()` 与 `tacticsLabel()`（不过战术层 ⇒ 空串落 NULL），`src/core/record/export.ts` 按**每侧真实渠道**过滤档位，`src/ui/panels/experiment-report.ts` 与 `options.ts` 以渠道优先判身份（`Rapfi(0.5s)` 的展示保留），`scripts/experiment-run.mjs` 的 `tacB` 默认值改 `CURRENT` 并打印真实生效标签。**可迁移判据：判一侧的身份看 `*_channel`，别把 `*_tactics` 当对手的属性；`tac_ms` 为 NULL 的那一侧就是不过战术层的那一侧。**
- **数据落点**：D1 **118 局 / 9067 手 / 14 轮实验 / 0 设备**；`game_moves` 分组 = `v10-live3` 1186 手 / `v11-vct` 983 手 / `v9-vcf-sound` 1104 手 / `v8-vcf-try` 765 手 / `v0-off` 13 手 / 无声明 5016 手。证据 `.work/exp-arm6-v11-tacms.{json,log}`、`.work/postmortem-r6.log`（都不入库）；登记表 `v11-vct.gamesVerified` 12 → **24**；文档见 [plans/2026-10-02-tactics-v11-vct.md](../plans/2026-10-02-tactics-v11-vct.md) §6.2、[status.md](../status.md) 与 [agents/playbooks.md](../agents/playbooks.md) §7。

---

## 2026-10-02 · v10 直连 v11 同门对照：唯一变量是战术档，v11 不败率 75% vs 58.3%

- **怎么跑的**（这是本项目第一次「同渠道同模型、只换战术档」的单变量对照）：两侧都是 `proxy` / `jev-latest`，A=`v10-live3` 奇数局执黑，12 局黑白交替；`node scripts/experiment-run.mjs --games 12 --chanA proxy --tacA v10-live3 --chanB proxy --tacB v11-vct`（tag `exp-20261002080446`，用时 5540 s，上游 1311 次调用 / in 3,570,328 / out 595,344 tok，109 次状态 0 的传输错误全被 `callWithRetry` 重试成 200 ≈8%、**零 429**）。报告脚本 `.work/duel-v10-vs-v11.mjs` 按**战术档**（不是「proxy/其他」）分侧。
- **结果**：`v11-vct` **5 胜 4 和 3 负**（得分率 58.3% · **不败率 75.0%**；执黑 3 胜 3 和 0 负 / 执白 2 胜 1 和 3 负）；`v10-live3` **3 胜 4 和 5 负**（41.7% · **不败率 58.3%**；执黑 3 胜 1 和 2 负 / **执白 0 胜 3 和 3 负**）。
- **读法一：净胜来自白方**。两侧执黑都是 3 胜，差别全在执白 —— v11 被让先还能赢 2 局，v10 执白一胜未得。往后拆 A/B 战绩必须带**执黑执白拆分**，否则这个差别会被总分掩盖。
- **读法二：和棋的性质要看对手**。4 局和棋**全是 225 手满盘**（同门互攻不穿），而 v11 的胜局都短（19/22/23/29/56 手）、v10 的胜局偏长（31/57/65 手）；对照 v11 打 `rapfi@500ms` 的**零和棋** ⇒ 和棋率主要由**对手强度**决定，不能拿同门和棋判「这一版攻不动」。这与置顶约束第 2 条一致：和棋要报，但不能单独当缺点。
- **读法三：被动回合多于主动回合**。逐手接管（两侧各 ~600 手）：v11 侧 `vctAttack` **15 手**（v10 侧此层不存在）、`parry4` 73、`live3Defense` 71、`block` 32、`vcfDefense` 23、`parry3` 21、`live3Attack` 17、`open4` 5、`win` 5、`parry` 4、`vcfAttack` 3；v10 侧 `parry4` 87、`live3Defense` 78、`block` 37、`vcfDefense` 31、`live3Attack` 25、`parry3` 17、`parry` 5、`vcfAttack` 3、`open4` 3、`win` 3。两侧 `parry4` 合计 **160 手** —— 大量回合是在「对手已有活四」时才被迫应对，**下一版入口就在这个形态里**（无强制胜时的防守与长线取势），不是把 VCT 挖更深。
- **口径边界**：本轮跑在**部署 `tac_ms` 之前**（线上 bundle 还是 `1.0.0+27a18b2`），所以 12 局 `game_moves.tac_ms` 全 NULL = 实测值缺失、不是 0；战术层耗时样本自下一轮起才有。
- **数据落点**：D1 当时 **106 局 / 8720 手 / 13 轮实验 / 0 设备**（`v10-live3` 累计 1186 手、`v11-vct` 808 手）。证据 `.work/exp-v10-vs-v11.{json,log}` 与 `.work/duel-v10-vs-v11.mjs`（都不入库）；文档回填见 [plans/2026-10-02-tactics-v11-vct.md](../plans/2026-10-02-tactics-v11-vct.md) §6.1 与 [status.md](../status.md)「数据现状」。

---

## 2026-10-02 · 战术层耗时单独记账：`tac_ms`（口径、NULL 的两种含义、两处真缺陷）

- **用户要求**（逐字，m07650）：「跑实验的时候，要是jev+战术，之后的实验里，我还要统计一个战术层花费的平均时间」⇒ 「战术层平均耗时」进入**每轮 Jev 实验的必报口径**（与胜/和/负、不败率、逐手接管统计并列）。
- **为什么要新开一列**：`game_moves.ms` 记的是「**战术 + 上游**」总耗时——`src/core/jev/client.ts` 的 `t0` 在 `computeTactics` 之前、`latencyMs = Date.now() - t0` 在其后。上游一次调用约 1 s，战术层正常只有几毫秒到几十毫秒 ⇒ 用现成列永远答不出「这层保险贵不贵」，必须单独累加。
- **计两个点、相加即本手战术层耗时**：① `computeTactics(...)`（VCF / VCT / 活三事实）；② `pickSafestParry` 的 3-ply 安全排序（`allowsSustainedAttack` + `countForcingReplies`，多危险点时是本层最大的一块）。链路：源 meta `tacticsMs` → 归档短键 `ai.tacMs` → `game_moves.tac_ms` → 每局 `games.tac_avg_ms` / `tac_max_ms`。
- **Rapfi / mock 记 `null` 而不是 `0`**（刻意的）：这两个渠道**不过战术层**（`decide()` 在 `src/core/jev/client.ts` 里只对 Jev 渠道算战术，`random` 渠道走；Rapfi 是完整搜索引擎，短路是为了让「Rapfi vs Jev」的单变量对比干净）。记 0 会把混合对局（Jev vs Rapfi）的均值拉低、看起来像战术层变快了；记 null 后 `AVG(tac_ms)` 自动把它们排除在样本外，而 `COUNT(tac_ms)` 与 `COUNT(*)` 的差又能说明覆盖了多少手。数据侧三列都可为 NULL ⇒ **NULL 有两种含义：历史棋谱没有这个字段（12 轮旧实验全是这种），或该手不过战术层**。
- **迁移必须追加**：`migrations/0001_init.sql` 已上过 remote，不得修改 ⇒ 新列走 [`migrations/0002_tactics_timing.sql`](../../migrations/0002_tactics_timing.sql)（两条 `ALTER TABLE`），本地与远程都已应用。写入侧只是追加 `?43/?44` 与 `game_moves` 的 `?14`（**列追加在末尾**，既有占位符编号不动）。
- **真缺陷 1（往返一致性）**：`aiMoveMeta` / `aiGameMeta` 最初恒写 `tacMs: null` / `tacticsMs: null`，而历史归档没有这两个键 ⇒ `test/core/record.spec.ts` 的往返用例 6 例红（导出 → 反推 → 再导出不再逐字段一致）。修法：**只在有样本时才写这个键**（两个字段都改成可选），Rapfi/mock 与老棋谱都不写出，双路径自然落 NULL。
- **真缺陷 2（幻影身份）**：`src/ui/panels/experiment-report.ts` 的 `gameSide()` 在局内字段缺失时一律用轮级 `tacA` 兜底黑方，而 **A 只在奇数局执黑** ⇒ B 执黑的那些局会给 B 侧（例如 Rapfi）安上 A 的战术版本，分桶表冒出 `rapfi|v11-vct|0` 这种并不存在的身份，把本该并成一行的手数拆成两行。修法：按局号奇偶算 `aIsBlack` 再取 `chan / tac / think` 兜底；新用例断言「只出现两个身份」（修前红在均值被拆成 50ms）。
- **写用例时踩到的老坑（复现路径）**：给报告写 fixture 要同时给**局内** `blackTac/whiteTac` 与轮级 `tacA/tacB`，否则会撞上兜底路径 —— 这次正是靠它才把上面那个幻影身份挖出来。
- **判据**：以后要看「战术层贵不贵」，用 `SELECT COUNT(*) 局数, ROUND(AVG(tac_avg_ms)) 均值, MAX(tac_max_ms) 最坏 FROM games WHERE experiment_tag='<tag>'`；拆到每侧用 playbooks §7 第 6 条的 JOIN 版。**已跑过的 12 轮实验没有这一列**（实测值缺失 ≠ 0）。

---

## 2026-10-02 · 长跑实验的隐形杀手：Rapfi 的 10 MB 权重走慢链路（脚本改由本地供给资产）

- **症状**：12 局对照实验卡在第 1 局 **0/12** 原地不动 486 s（脚本按「8 分钟无进展」判据中止），报告里 `meter.calls = 1`（只有第一步 Jev 决策成功）、`pageErrors = ['未捕获异常：TypeError: network error']`；同一时间 `browser-smoke --channel rapfi` 也卡在「对手也落了子」的 90 s 等待上（13/14）。**主线程没被阻塞**（CDP 心跳每 30 s 都答得上）⇒ 不是 VCT 长算把页面冻住，而是 AI 循环停在了自己身上。
- **取证（别猜，量）**：直接量生产域上那两个资产 —— `rapfi-single-simd128.wasm` **1,161,393 B / 14.7 s**、`rapfi-single-simd128.data` **10,037,111 B / 447.7 s**（≈22 KB/s）。Rapfi 是**局中首次用到才实例化**，Emscripten 这才去抓这两个文件；抓失败时它抛的 `TypeError: network error` 在装配层没人接住 ⇒ `inflight` 永久占位，游戏再也走不下去。
- **修法（只动工具链，不动被测行为）**：`scripts/browser-smoke.mjs` 与 `scripts/experiment-run.mjs` 都用 CDP 的 `Fetch` 域把页面发出的 `/rapfi/*` 请求**改由本地 `public/rapfi/` 的同一份文件**答复（`Fetch.fulfillRequest` + base64，Content-Type 按扩展名给 `application/wasm` 等），`--no-rapfi-local` 可关。字节同源同内容（同一构建产物），变的只是「从哪来」。修后 `--channel rapfi` 的浏览器冒烟 **14/14**（日志里明写「本地 public/rapfi/ 供给 10.7 MB」）。
- **可迁移的判据**：无人值守长跑里「上游零调用 + 主线程有响应 + 页面只有一句网络错误」= 先去查**大资源加载**（wasm/权重/字体），不要先怀疑搜索算得慢。另一条：别让 rejection 悬空——它会把状态机卡在一个「看起来在等 AI」的假象里。

---

## 2026-10-02 · 战术 v11：把「活三」从启发式落点升级成逼迫手搜索（VCT），并标定搜索预算

- **用户要求**（逐字，m06208）：「暂不停用，且继续进行第11版的设置」——① 旧 `pages.dev` 项目**暂不停用**（悬置事项就此关闭）；② 继续做第十一版。
- **复盘从两条否证开始**（`.work/v11-analyze.mjs` / `.work/threat-audit.mjs`，24 局 914 个 proxy 回合）：① 「双活三（L4）」假设**否**——用现成 API 判定时 **97% 的回合**都「有 L4 机会」（判定无区分度），按「本手新造 ≥2 个互不依赖的必胜点」口径重算，**真双威胁 24 局 0 次**；② v10 的 `live3After` 语义缺陷坐实——它判的是「盘面上存在 ≥2 个活四制造点」而不是「本手新造」，盘上早就有活三时任何空格都算 L3（夹具局面 `live3Makers(black)` 报 **96** 点，独立实现 185 点；白方同局面只 5 点）⇒ 密集局面 `live3_you` 平均 11–12 点、最坏 123 点，`pickAmong` 退化成「取模型全局首选」，攻击层近乎空转。
- **转向 VCT 的量化理由**（`.work/vct-probe.mjs` 独立实现，24 局逐手）：v10 臂 586 个回合里 7-ply 纯冲四有杀 22 手、**11-ply 也只多 2 手**、VCT（冲四 + 活三逼迫）42 手 ⇒ **20 手分布在 7 局，是纯 VCF 无论如何看不见的**，其中 2 局和棋（`3cc54941`、`0661aa24`）、1 局负（`7bfba6f2`）、4 局胜；那 20 手实走几乎全是 `live3Attack` 的启发式点且与 VCT 首步不同 ⇒ **v10 用启发式活三覆盖掉了算得清的必胜链**。
- **v11 = `v11-vct`「连续威胁搜索」**：引擎新增 `vctWin(st, attackerId, maxPlies, opts?: VctOptions)`（`src/core/engines/gomoku.ts`），攻击方着法 = 冲四 ∪ 本手新造 ≥2 个活四制造点的活三；守方**精确枚举**应手（≥2 成五点直接判胜、单成五点唯一应手、活三先过「守方当下没有造冲四的着法」闸门再枚举全部 `vctDefusers`，黑方禁手点不算应手）；战术层新增事实 `vct_win_you`，接管链在 `vcfAttack` 与 `vcfDefense` 之间插 `vctAttack` 成**十二级**。
- **soundness 加固（本轮抓到的真缺陷）**：守方应手候选集原本取「距任意子切比雪夫 ≤2」的邻域——漏枚举一个能守住的应手就会把败局谎报成必胜；改成**全盘空点** `allEmpties`。夹具验证：黑走 `L4` 后白方**全盘 204 个应手全部仍输**（0 个守住，1132ms），邻域 106 个同样 0 个守住 ⇒ 那条 `L4>K7>J9>L10>I9` 是真强制胜。
- **搜索预算经 586 个真实回合标定**（`.work/vct-tune.mjs` + `.work/vct-tune3.mjs`；脚本第一次跑在 500 回合处被一次 `ECONNABORTED` 打断、20 分钟算力全废 ⇒ 改成归档 JSON 落盘缓存 + 每 4 局写进度、可续跑）：初版缺省 `14/6000/∞` 看见 55 手必胜链但平均 607ms / p90 2430ms / **最坏 8837ms**（同步阻塞）；`10/3000/6` **同样 55 手（丢 0、多 0）**、平均 422ms / 中位 12ms / p90 1636ms / 最坏 4506ms ⇒ 取这组。**中位数恒在 12ms**（多数回合被根节点闸门挡掉），瓶颈是节点预算而非宽度（`movesMax` 8/10/12/14 = 54/55/55/55 手），且三个上限只会「少看见」、不会谎报必胜。
- **测试**：引擎套件 **130 例全绿**（原 126，新增 ⑤c 四例，夹具 = 归档局 `cf3d85f9-6962-411a-958d-086eda0ebe09` 第 21 手）；`npm test` 34 文件 / 334 例；`npx tsc --noEmit` 0 错。顺手修掉测试助手 `nearReplies` 的**行列写反**（记法是「列字母+行号」，它把 `charCodeAt(0)` 当行号 ⇒ 实际筛的是转置点的邻域）。
- **对照实验（2026-10-02，`rapfi@500ms`，单臂 12 局，黑白交替，tag `exp-20261002055817`）**：`v11-vct` **10 胜 0 和 2 负**（得分率 **83.3%**，执黑 5 胜 1 负 / 执白 5 胜 1 负）——同对手同开局的三臂是 **25%（v9）→ 67%（v10，含 4 和）→ 83%（v11）**；**12 局零和棋**、平均手数 **34**（v10 臂 98、v9 臂 55）⇒ v10 那 4 局 225 手满盘和棋被转成了胜局，「防守补上了、胜势转不成胜」这个入口被堵上。逐手证据（`game_moves`）：v11 侧 206 手 = 本轮 206 次上游调用，新层 `vctAttack` 接管 **62 手**（执黑 31 / 执白 31；v10 臂上此层 0 次），v10 的活三两层从 168 手降到 28 手（22 / 6）。运行口径：12/12 跑满并归档、724 s、上游全 200 零 429、峰值 ~17 次/分（限 60）、in 556232 / out 113024 tok，12 局 `code_version` 全是 `1.0.0+638f844`。
- **第一次尝试 0/12 卡死，根因不在引擎**：报告里 `meter.calls = 1`（只有第一步 Jev 决策成功）、页面只有一句 `TypeError: network error`，而 CDP 心跳每 30 s 都答得上（主线程没被 VCT 长算冻住）。取证：Rapfi 是**局中首次用到才实例化**，本机链路上 `/rapfi/rapfi-single-simd128.wasm` 1.16 MB 要 14.7 s、`.data` **10.04 MB 要 447.7 s**（≈22 KB/s，直接 `Invoke-WebRequest` 实测）；Emscripten 抓失败抛的 rejection 没人接住 ⇒ 装配层 `inflight` 永久占位。修法只动工具链：两个脚本用 CDP `Fetch` 域把 `/rapfi/*` 用本地 `public/rapfi/` 的同名文件 `Fetch.fulfillRequest` 答复（`--no-rapfi-local` 可关），被测行为零改动（提交 `3bf480b`，CI `36971433730`）。**可迁移判据：上游零调用 + 主线程有响应 + 只有一句网络错误 ⇒ 先查大资源加载，不要怀疑搜索算得慢。**
- **逐手事后复盘**（`.work/v11-postmortem.mjs`，对 12 局 206 个 v11 回合重跑 `vctWin(st, 9)`）：**87 手（42%）局面存在必胜链，84 手实走走的就是链首步**；只有 3 手「有链却走了别的点」，且全是被更高优先级的必胜层接管（2 手 `open4`、1 手 `vcfAttack`），**下一手仍有杀、「机会真丢」0 手**，3 局最后都赢。两负的两局（#6 执白 57 手 / #7 执黑 34 手）在 28 / 17 个 v11 回合里**一次都没报出必胜链** ⇒ 输在「算不出强制胜」的局面，不是 VCT 漏杀或假阳性——**下一版的着力点在这里（防守/长线），不是把 VCT 挖更深**。局内 `vctWin` 成本平均 **≈78ms** / 最坏 **2623–2830ms**。
- **上线与回填**：实现提交 `638f844`（21 文件 +723/−68，CI `36968915244` 绿）、部署版本 `02a00024-74a4-480d-b539-c278e2c52e4b`、`npm run smoke:live` 30/30；登记表 `v11-vct` 的 `commit`/`commitAt` 从占位改成 `638f844` / `2026-10-02 13:25`、`gamesVerified` **0 → 12**（`test/engines/tactics.test.mjs:147` 同步改）。D1 现为 **94 局 / 7518 手 / 12 轮实验 / 0 设备**。
- **仍未闭环**：v10 原语语义与提示词措辞（保 A/B 单变量本轮不动）、`vctWin` 更深的链与**最坏 2.8 s 的同步阻塞**、两负局面「无强制胜时怎么赢」的防守/长线机制（见 `docs/plans/2026-10-02-tactics-v11-vct.md` §7）。

---

## 2026-10-02 · 战术 v10：把「活三」从形状匹配升级成真推演（v9 对带空隙的活三完全失明）

- **用户要求**（逐字，m05228）：「分析第九版与搜索算法对弈的棋谱，优化，给出第十版，并做实验，与思考时间最短的搜索算法比较，看是否有进步」——复盘 27 局 `jev` vs Rapfi 归档 → 出第十版 → 与 Rapfi 最短思考档（UI 最小 = **500ms**）做 A/B 对照实验。
- **复盘口径换过一次**：先按 VCF（7-ply 冲四链）扫 27 局，**只有 2 局**是被将死；接管层级直方图 `parry3 156 / vcfDefense 137 / block 133 / parry4 126 / vcfAttack 18 / parry 10 / open4 4 / win 4`（`threat` 一次没触发 ⇒ 全程被动防守），结果 11 黑胜 / 11 白胜 / 5 和。于是改按**活三**口径重扫（`.work/analyze-rapfi.mjs`、`.work/v9-live3-audit.mjs`）：**27/27 局**都出现过对手「能造活三」的局面，v9 实际拆掉 13 次、漏掉 14 次；漏的 12 局形态完全相同 —— **执白第 6 手放行反对角线上的活三制造点 F10/D12**。
- **根因（走查代码坐实）**：`src/core/engines/gomoku.ts` 的 `liveThreeDir` 只认连续 `_XXX_` 一种形状（跳活三、斜线组合、带空隙的四一律认不出），`labelPoint` 的 `you:live3` / `deny:live3` 因此**恒为空**；`danger_points_opponent` 又只到 2 手（只认「一步成五」）。在归档 ply#6 那个局面上实测：C13/D12/F10/G9 **四点标签全是 `null`**、`danger_points_opponent` 为空 ⇒ 九级接管链**没有任何一层会触发**，v9 只能走无意义的静点。**教训：把深度概念（4 手内必胜）编码成形状概念（`_XXX_`）会静默失配——形状匹配的分母是「想得到的形状」，推演的分母是棋盘。**
- **v10 机制 = 同一把尺的三级阶梯**（与 `fiveCompletions` 一致）：**L1 五点**（落子即五连）/ **L2 活四制造点**（落子后 `fiveCompletions ≥ 2`，2 手内必胜 = 既有 `you:open4`）/ **L3 活三制造点**（落子后存在 ≥2 个 L2，对手只能挡一个，4 手内必胜）。引擎新增可选方法 `live3Makers(st, sideId): string[]` 与 `live3Deny(st, sideId, candNotations): Live3Deny`（`{before, after, best}`，`best` = 并列最优里最先评估到的那批），候选集沿用「距任意棋子切比雪夫 ≤2」的邻域空点（L3 点必与己子相邻，可证），全程在 `clone(st.board)` 上落子/撤销；`live3Deny` 用「对手 L3 点优先 + `best+1` 截断 + `best===0` 即停 + 最多评 24 个点」控成本。实测该局面 `live3Makers(black)=['F10','D12']`（20ms）、`live3Deny(white)={before:2,after:0,best:['F10']}`（28ms），相对一次 Jev 调用（~1s）可忽略。
- **战术层与接管链**：`TacticsReport` 新增 `live3_you` / `live3_opponent` / `live3_deny_points`（facts 里同时给模型英文指令）；`ALL_MECH` 与 `MECHS` 变 14 键；接管链在 `vcfDefense` 后插 `live3Attack`（抢己方 L3）/ `live3Defense`（走 `live3_deny_points`）成**十一级**，**只在 `danger_points_opponent` 为空时才动**（对手有 2 手杀时抢 4 手剑会输速度，让位给 `parry`）；登记表加第 11 行 `v10-live3`（`rank 10`、机制单调递增）且 `CURRENT` 改指它，`index.html` 三处下拉加选项。
- **测试**：`test/engines/run.mjs` **126 例全绿**（原 121），金样逐手差分不变（自对弈 1131 手 + 归档 54 局 4379 手）；`test/engines/tactics.test.mjs` 新增⑤b 五例（引擎层推演 / 战术事实 / 决策级 `live3Defense` 接管 / 抢攻 `live3Attack` / 对手有 2 手杀时让位走 `vcfDefense`）；**顺手抓到一个写死期望**：`src/core/view/duel.ts` 的 `selfTest()` 里 `'Jev·v9'` 是硬编码的，换档就红（`?test=1` 面板 + `test/app/boot.spec.ts`）——改成从登记表派生 `versionTag()`，以后换档不会再假红。
- **设计记录**：[ADR-0014](../adr/0014-live3-real-lookahead.md)（含明确的「不做什么」：只到 4 手、`live3Deny` 报「能清零的点」而非全局最优、不改采样、不碰 `mock`/`rapfi` 渠道）。
- **对照实验（2026-10-02，`rapfi@500ms`，两臂各 12 局，黑白交替，串行）**：`v10-live3` **6 胜 4 和 2 负**（得分率 67%，执黑 4-2 / 执白 2 胜 4 和 0 负）vs `v9-vcf-sound` **3 胜 9 负**（25%）。**4 局探路会骗人**：先跑的 4 局是 v9 2 胜 2 负、v10 3 胜 1 负，看着「差不多」；补到 8 局后 v9 掉到 1 胜 7 负。逐手接管直方图（`.work/arm-stats.mjs`）给出独立的机制证据：v10 的 live3 两层 12 局共接管 **168 手**（`live3Attack` 120 / `live3Defense` 48），v9 同批对手 **0 次**；平均手数 55 → 98。**但 4 局 225 手满盘和棋全在 v10 执白时出现 ⇒ 防守补上了、胜势还没转成胜**（v11 的入口）。上线版本 `a8a9130f-f5d8-4ee7-94eb-62e6dfdab86a`；D1 现为 **82 局 / 7110 手 / 11 轮实验**，`game_moves` 里 `v10-live3` 586 手（= 两臂 v10 局的 proxy 手数合计，与脚本统计交叉一致）。
- **登记表回填**：`v10-live3.gamesVerified = 12`（`commit` 从占位改成 `8751070`、`commitAt` `2026-10-02 01:40`），`v9-vcf-sound.gamesVerified` **4 → 16**（新增的 12 局 v9 臂每手 `ai.tv = v9-vcf-sound`）——`games` 快照口径不动（v10 仍是 0，它是已退役的迁移前口径）。
- **顺带记档的语义坑**：记录级 `tacticsVersion` 写的是 `bCfg.tactics`（`src/core/record/export.ts:207`）⇒ **只反映黑方档位**；A/B 局里 rapfi 执黑的 4 局因此在 `games.tactics_version` 与「棋谱归档」面板里都算成 `v9-vcf-sound`。分析混合档位对局必须看 `blackTactics` / `whiteTactics` 与每手 `ai.tv`（rapfi 侧是 `rapfi/null`——它不走战术层，是既有决定）。已记入 `docs/status.md` 仍存在第 24 条，未修。

---

## 2026-10-01 · 真跑 4 局 proxy 对比实验：自家限流把整轮顶穿，而错误文案指向别处

- **用户要求**：给出 Jev API Key（`apikey_…`，96 字符，**只经环境变量 `JEV_API_KEY` 传入，绝不落盘/入库/进 URL**），并在三个选项里选了「**4 局：proxy(v9-vcf-sound) vs proxy(v8-vcf-try)**」。
- **第一次真跑（13:02）死在第 1 局**：状态栏一直 `⚠ AI 出错：重试次数用尽`、脚本心跳报「上游 0 次（错 0）」。**两个假象**：①「上游 0 次」是脚本自己的 bug（见下）；②「重试次数用尽」跟真实原因无关。
- **真根因（远程 D1 实证）**：`SELECT bucket, window_start, count FROM rate_limits …` 显示本机 IP 的 `jev:183.209.88.214` 桶在窗口 `1790859780` 记到 **34 次**（限额 30/分）、同窗口 `read:` 桶只有 2–22 次 ⇒ **是我们 Worker 自己的 `jev` 档挡下的**，不是上游。`callWithRetry` 的 429/529 分支只 `continue`、**从不给 `lastErr` 赋值**，跑满 4 次后抛「重试次数用尽」，真实原因完全不可见；而 `aiStep` 的 catch 只 `show('retryBtn')` + `setPaused`，**机机对局没人能点「重试」**⇒ 整轮报废。
- **两层修法**：传输层 `src/core/jev/client.ts` 的 `callWithRetry` 重写 —— 网络 4 次不变；429/529 独立计数 **5** 次、按 `Retry-After` 退避（`retryAfterMsOf()` 只认整数秒、限幅 60 s，`MAX_RATE_LIMIT_BACKOFF_MS = 20000`）、失败都留带状态码的错误并打 `retryable`（401/其他 4xx 为 `false`）。装配层 `src/app/loop.ts` 只对 `retryable` 自动退避重试（`AI_AUTO_RETRY_DELAYS_MS = [4000, 12000, 25000]`，**期间不暂停**），成功 / 手动重试 / `resetSession` 三处清零 `ctx.aiAutoRetries`。配置层 `vars.JEV_RATE_LIMIT_PER_MIN`（生产 **60**；60×1440 ≈ 8.6 万 < 10 万行/日），`limitsFor(env)` 只允许覆盖 `jev` 档。
- **测试**：`test/core/jev-retry.spec.ts` 5 例（假时钟 + 请求桩）、`test/app/ai-auto-retry.spec.ts` 2 例（真标记；**桩里回 `Retry-After: 0`** 才能让 5 次尝试毫秒级跑完）。**四组负向对照各自红对应用例**（去掉 `Retry-After` → `expected 2 to be 1`；尝试次数 5→4 → 文案不含「已退避重试 5 次」；耗尽分支 `retryable` 改 false → `expected false to be true`；关掉自动重试分支 → `Test timed out in 5000ms`）。`test/worker/jev.spec.ts` 的限额断言改成从响应头 `x-ratelimit-limit` 现读（写死 30 会随 `wrangler.jsonc` 变脆）。`npm test` → **34 文件 / 334 用例全绿**；上线版本 **`781316c8-1845-47a6-8f73-e0bf22decffb`**（绑定里首次出现 `env.JEV_RATE_LIMIT_PER_MIN ("60")`）。
- **第二次真跑（13:26:19 → 13:57:40，成功）**：`node scripts/experiment-run.mjs --games 4`，**1854 s / 902 次上游调用 / 输入 2586521 token / 输出 438798 token ≈ $0.109**，`retryClicks = 0`，状态序列**除 1 次 `0`（fetch 被拒）全是 200、零 429**。归档 4 行 tag `exp-20261001132645`，**四局全部 225 手「和棋（棋盘已满）」**（`v9-vcf-sound` vs `v8-vcf-try` 谁也攻不穿谁，A/B 无胜负差）；逐局 `tokens_in` ~645K、`cost_usd` ~$0.0272、`latency_avg_ms` 930–1056。D1 现为 **58 局 / 5279 手 / 7 轮实验 / 0 设备**（导入基线 54/4379/6 未变）。
- **同一批负载的对照**：旧 30/分 会死在第 1 局；这次窗口峰值 **34/分、零 429** —— 直接证明改对了地方（`SELECT max(count) FROM rate_limits WHERE bucket LIKE 'jev:%'`）。
- **脚本三处「会自欺」（都已修）**：① 计量器按绝对路径 `/api/jev` 匹配，而 `CHANNELS.proxy.endpoint` 是相对串 `'api/jev'`（`src/core/jev/client.ts:29`）⇒ 永远报「上游 0 次」，恰好藏住唯一证据；② 失败时读 `history[0].tag` 拿到的是**上一轮** tag（本轮没跑完写不进台账）⇒ 归档核对拿旧数据当本轮成绩；③ 页面停在「等人工重试」无人可点。修法：同时认两种写法 + 记录状态序列、开跑前记台账基线只认新条目、发现 `#retryBtn` 可见就代点并计数、退出码新增 `done` 条件。
- **`smoke:live` 把数据总量写死（已修）**：`byGame === '{"五子棋":54}'`、实验恰好 6 轮、写入后 `totalGames === 55` —— D1 是活的，真实验一多就红（实测 27/30）。改成相对基线（键合法 + 五子棋在册 / 轮次 ≥ 6 且每轮有 tag / 写入后「基线 + 1」，实测 `58 → 59`），负向对照把 `+1` 改成 `+2` → 恰好一项红、退出码 1；随后 **30/30**。
- **副作用证据（面板可见）**：`smoke:browser` 14/14，报告面板「**7 张卡片 · 7 轮实验 · 42 局有效**」（原 6 轮 / 38 局），归档分页「首屏 50 → 追加后 59 份」。
- **已知未修**：`games.tokens_out` 恒 NULL —— 一局汇总 `aiGameMeta()`（`src/core/meta.ts:62-82`）只累加 `usage.input_tokens` 进 `meta.tokens`，而 `src/shared/record-map.ts:376` 读 `meta.usage?.output_tokens`。计费口径输出免费，成本列不受影响；要修就是加 `AiGameMeta.tokensOut`。已记入 `docs/status.md` 仍存在第 22 条。

---

## 2026-10-01 · 报告面板顶部加「最新棋谱」：归档里最新一批机机对局以前永远看不见

- **用户要求**（逐字，m04005）：「就是说现在实验报告里面只有早期的机器对弈棋谱分析报告，要更新到最新」。问清后确认**范围 = 报告要显示归档棋谱里最新的那些对局**（不是「现在真跑新一轮实验」、也不是「只改排序」），渠道倾向 proxy（**Jev API Key 用户答应提供但还没给**，Worker 没有 secret、仓库无 `.dev.vars`）。
- **为什么面板停在早期**：轮次卡按 `games.experiment_tag` 分组，而归档里最新的一批机机对局**根本没挂 tag** —— 生产 D1 的 `id 54 jev-v9-vs-jev-v9`（20 手）、`id 53 jev-v9-vs-jev-v8`（181 手，黑方认输）、`id 50/49 jev-v0-vs-jev-v0`（13/14 手）全未挂 tag，而 6 轮实验的 tag 全是 2026-09-29/30 的。**列名坑**：查询得用 `experiment_tag`（`experiment` 不是列名，会报 `no such column`），`tactics_version` 在归档行里恒为 NULL（版本号在 `black_tactics`/`white_tactics`）。
- **做法**：`src/ui/panels/experiment-report.ts` 新增 `renderLatestGames({ root, rows, handlers })`（`rows === null` → 「加载中…」，`[]` → 「归档里还没有棋谱。」）+ `.exp-latest*` 样式；`src/app/records.ts` 新增 `LATEST_GAMES_LIMIT = 10`、`latestRow()`（缺 `gameUid` 的行**丢弃**，因为回放要 uid；`when`/`game` 复用 `archiveWhen()`/`archiveGameName()`；归因走共用的 `sideAttribution()`）与 `loadLatestGames(ctx)`（`listGames({ limit: 10 })`，异常 → `null`）；挂载点 `#expLatestGames` 在 `index.html` 的 `#body-expreport` 里、`#expHistory` 之**前**（面板覆写 `root.className`，所以只能用 id 定位）；三处接线 = boot、`#archiveReload`、每轮实验 `saveExperiment().then`（**注意 `experiment.ts` 需要新 import**，漏了会 `TS2304`）。
- **证据**：`test/ui/experiment-report.spec.ts` +6 例（渲染/空态两态/无回调不出按钮/重画幂等/装配层整形/离线降级）、`test/app/latest-games.spec.ts` 3 例（boot 后按归档序三行 + `?limit=10`、点「回放」真的走 `/api/games/u/uid-new` 并让回放器显示 `0/3`、离线停在「加载中…」）；**负向对照三组都真红**——去掉 uid 过滤 → 3 行（期望 2）、渲染改 `appendChild` → 幂等例红、`null` 与 `[]` 共用文案 → 空态例红；把 boot 里的调用 `if (false)` 掉 → app 三例全红。
- **实测**：`npx tsc --noEmit` 0；`npm test` **32 文件 / 327 用例全绿**；`npm run deploy` → 线上版本 **`128ed7db-1b9d-4b84-a3a2-6ae6c9b6a10d`**；三渠道浏览器冒烟 mock **14/14**、`--offline` **13/13**、`--channel rapfi` **14/14**，新项输出「最新 10 份（首份 09-30 23:34 · 五子棋 · 20 手 · Jev·v9(黑) → 白方 获胜（五连）），点「回放」后回放器 20 手、位置 0/20」。
- **测试环境的坑**：happy-dom 里 `canvas.getContext('2d')` 返回 null，所以 `drawReplayPosition()` 会在建 canvas 前安静 return —— 断言只能查 `.rp-board` 宿主，不能查 `.rp-board canvas`。
- **又一次「本机绿 ≠ CI 绿」（时间断言别写死时区）**：CI run `36863711165` 里 327 个用例只红这一条 —— `AssertionError: expected '10-01 10:06' to be '10-01 18:06'`：我把行里的 `when` 写死成本机（UTC+8）的 `18:06`，而 GitHub Actions 跑在 UTC。根因是口径本身分两截：`archiveWhen()`（`src/app/records.ts:48-58`）的**日期取自行里的 `day` 列**（时区无关），**时分来自 `new Date(iso).getHours()/getMinutes()`（本地时区）**。修法＝测试里按同一规则现算（`new Date('2026-10-01T10:06:09.131Z')` + `padStart(2,'0')`），并**用 `$env:TZ='UTC'` 在本地复现**（修前 CI 红、修后 `TZ=UTC npx vitest run --project ui test/ui/experiment-report.spec.ts` 11/11 通过）；随后 `3d80f96` → CI run `36864140364` 全绿。凡是断言格式化后的时间，都要先问「这是哪个时区的字符串」。

---

## 2026-10-01 · 实验报告改成「按渠道 · 战术版本」分桶，并顺手抓出「服务端战报从来没并进面板」

- **用户要求**（逐字，m03647「优化实验报告栏目」）：给的 5 个选项里只选了「按渠道/战术版本的分组统计 + 胜率」。所以只做口径；视觉分级 / note 折叠 / 窄屏 / 「查看该轮棋谱」联动都**没做**（别以为漏了）。
- **改前为什么错**：`expTotals()` 只分「Jev 渠道 / 其他」两桶 —— 实验真正要回答的问题恰是**两侧都是 Jev 渠道**（`v8 vs v9`），这时双方落进同一桶，面板报「Jev 6 胜 · 其他 0 胜」，且没有胜率、和棋没拆出来。
- **新口径**：`expSideStats(list)` 按身份（`channel | tactics | thinkMs`，局内字段优先、缺省退轮级 `e.chanA/tacA/thinkA`）分桶；A/B 谁执黑从局号推（`const aIsBlack = ((g.no || 1) - 1) % 2 === 0;`、`const winnerIsBlack = g.winnerChan === 'A' ? aIsBlack : !aIsBlack;`）；`dup` 局不计；**得分率 =（胜 + 和 ÷ 2）÷ 局**。累计区换成 `.exp-agg-row[data-key]` 分桶表（局/胜/和/胜率条），每轮卡片多一条 A/B 单轮得分率条（`.exp-bar-row`）；`#expReportNote` 改成「N 轮实验 · M 局有效」，**刻意不再出现「Jev 渠道」口径**。样式追加在 `styles/style.css` 的 `.exp-card-rows` 之后（`.exp-agg*` / `.exp-bar*`）。
- **顺手抓出的真缺陷（比本次需求更值钱）**：**生产 D1 有 6 轮实验，面板永远只显示本机种子 2 轮**。根因是契约漂移：Worker 的 `GET /api/experiments` 返回**包装体** `{experiments:[…]}`（旧实现 `js/app.js:841-857` 读 `r.experiments`），而 P6 装配时 `src/app/backend.ts` 假设客户端已解包、写成 `Array.isArray(r)` → 静默 return；`src/core/api/client.ts` 的 `listExperiments` 原样透传对象。修法：客户端 `listExperiments()` 统一解包（`Array.isArray(r) ? r : Array.isArray(r?.experiments) ? r.experiments : null`），backend 注释与判据对齐。**教训**：跨层契约（谁来解包）没有测试钉住时，两层「各自看起来对」的代码会静默丢数据；`test/app/experiments-merge.spec.ts` 3 例 + `smoke:browser` 第 12 项（在线断言轮次 > 种子两轮）现在钉住它。
- **证据**：`test/ui/experiment-report.spec.ts` 5 例（含「两侧同渠道必须分两行」）、`test/app/experiments-merge.spec.ts` 3 例；**负向对照三组都真红**——`aIsBlack` 写反 → 2 例红、`rate` 不算和棋半分 → 2 例红（`expected 0.5 to be close to 0.625`）、`listExperiments` 退回不解包 → 2 例红。`npm test` **31 文件 / 318 用例全绿**，`npx tsc --noEmit` 0，build client JS 182.11 kB(gz 66.61) / CSS 40.20 kB(gz 8.09)。
- **实测（生产，`https://jevqipan.logicc.top/`）**：三种渠道浏览器冒烟各 **13/13**（mock / `--offline` / `--channel rapfi`，EXIT=0）；面板从「2 轮 / 9 局」变成 **「6 轮实验 · 38 局有效」**，分桶首行「Jev(代理) 局/胜/和 36/12/6、胜率 41.7%」。上线版本 `29788ef6-…`（口径）→ **`18b2fcad-39f8-4974-8e83-952076d83fa8`**（战报并入，当前）。
- **测试夹具的坑**：`createExpHistoryStore()` 会把 `EXP_SEED`（2 轮 / 9 局有效）并进列表，凡断言「轮数」都要加上种子；而且不能用「轮数 ≥ 3」当等待条件（同步 seed 就够，`waitUntil` 假通过后请求还没发出，`vi.unstubAllGlobals()` 会让在途请求打真 fetch → `ECONNREFUSED 127.0.0.1:3000`）。正确做法是等**特定 tag 出现**再等 `calls.includes('/api/experiments')`。

---

## 2026-10-01 · 归档面板接线 keyset 分页（目标书里「分页」那一项的收尾）

- **背景**：服务端早就有 keyset 游标（`GET /api/games?cursor=…` → `src/worker/routes/games.ts:109,138` 返回 `{ ok, games, nextCursor }`），但 `src/app/records.ts` 只 `listGames({ limit: 100 })` 一次 —— 目标书「新能力（回放/**分页**/排行榜）」里的分页在 UI 侧一直没接线。
- **改法**：`ARCHIVE_PAGE_SIZE = 50` 取首屏；`loadMoreArchive(ctx)` 带 `?cursor=` 追加下一页；`renderArchive()` 把两页合并重画（所以新旧局并进同一个战术版本组）；没有下一页时按钮收掉；下一页失败保留已载入的行并把按钮从「读取中… disabled」恢复可点。按钮 `#archiveMoreBtn`（`.arc-more mini-btn`，样式 `styles/style.css:933-935`）。
- **关键坑（调试花掉的时间都在这）**：归档面板是**展开时补渲染**（`foldHooks().archive`，`src/app/bindings.ts:175-177`），`test/app/**` 里 `boot()` 之后不会自己取数 —— 用例必须点 `#archiveReload`（`src/app/bindings.ts:246-250`）走真实入口；第一版用例直接断言行数，三条全部 `waitUntil 超时`。
- **证据**：`test/app/data-panels.spec.ts` +3 例（首屏 `?limit=50` → 点「加载更多」→ `?limit=50&cursor=cur-2` → 三行仍归一组、按钮消失、note 含「3 份」；单页无按钮；第二页失败降级）；**负向对照**把 cursor 参数摘掉 → 2 例红；`npm test` 当时 29 文件 / 310 用例全绿（当天后续又加到 31 文件 / 318 用例）；生产实测 `smoke:browser` 第 10 项：「首屏 50 → 追加后 54 份，按钮已收掉，note『54 份 · 按战术版本分组』」（连同当天后加的两项，三渠道现各 13/13；`smoke:live` 30/30）。
- **顺手修掉的脚本缺陷**：`scripts/browser-smoke.mjs` 收尾的 `rmSync(PROFILE)` 在 Windows 上会因 Chrome 刚被 kill、句柄没释放而 `EPERM`，**把一次绿跑变成「无报告的崩溃 + exit 1」**（`--channel rapfi` 那次就是这样）；现在起手清旧 profile 与收尾删除都改成重试 + 兜底只提示，绝不让清理失败掩盖检查结果。线上版本 **`3a4934ee-28c5-4e7e-88c9-214da988b707`**。

---

## 2026-10-01 · P8 收尾上线：删掉旧实现、Rapfi 从不走子的真缺陷、以及「端到端断言才抓得到」的教训

- **收尾动作**：`git rm -r -f js functions legacy.html server.cjs dev-proxy.py test/run-tests.cjs test/server-tests.cjs test/rapfi-tests.cjs`（**注意**：仓库里旧实现的实际文件名是 `server.js`/`test/*.js`，之前那次 `→ .cjs` 只落在暂存区、没改过真实文件名，文档一律写 `.js`）；`css/style.css` → `styles/style.css`（**不拆** base/layout/panels：拆分会动层叠顺序、收益低）；`package.json` 摘掉 `test:legacy`；新建 `test/ui/index-shell.spec.ts` 守真实外壳（约 120 个必需 id、恰好 1 个 module 入口、禁旧路径与硬编码渠道名）。
- **Rapfi 渠道在浏览器里从不走子（本轮最值钱的发现）**：mock 渠道全程掩盖它；`smoke:browser --channel rapfi` 的状态栏正常显示「对手 Rapfi(3s)」，而对手永不落子。根因是**两个注入点都没人接线**：① `src/core/jev/rapfi.ts:181-183` 在 `_loader === null` 时直接抛「当前环境不支持动态加载 Rapfi 脚本（无 document）」，而 `setLoader()`/`setGlueUrl()` 在浏览器侧从未被调用（旧实现在 `js/rapfi.js` 里把这 20 行内联了，迁移时拆成 core 的注入点，**约定没落到装配层**）；② `src/core/jev/client.ts:237-242` 要求每次调用注入 `opts.rapfi`，而 `src/core/jev/index.ts` 只注入了 mock。修法：新建 `src/app/rapfi-loader.ts`（`RAPFI_GLUE_URL='/rapfi/rapfi-single-simd128.js'`、`loadRapfiModule`、`installRapfiLoader`），`src/app/boot.ts` 启动时安装，`index.ts` 的 `decide()` 默认补 `rapfi: decideRapfi`；`test/app/rapfi-loader.spec.ts` 7 例（含端到端 `decide()`）。**负向对照**：去掉 `index.ts` 的注入后该例红，报错正是线上症状「rapfi 渠道未注入（opts.rapfi）」。
- **教训（可复用）**：「探测按钮能加载引擎」≠「对局时对手会走子」——`src/app/modes.ts:161-166` 的探测路径自己 `await ensureLoaded()`，所以状态栏一切正常。凡是「core 提供注入点、装配层负责装」的约定，都必须有**一条走真实调用链的端到端断言**；本轮如果不是把「对手也落了子」变成 CDP 断言，这个缺陷会带着「Rapfi 已支持」的绿灯上线。
- **最终验收数字（2026-10-01 实跑）**：`npx tsc --noEmit` 0 error；`npm test` **29 文件 / 307 用例全绿**；`npm run build` client JS 175.65 kB(gz 64.3) / CSS 39.09 kB(gz 7.9) / worker ≈173 kB；`npm run check:docs` 41 md / 246 链接全绿；`npm run smoke:live` **30/30**；`smoke:browser` **mock 10/10、rapfi 10/10、离线 12/12**；`db:export` + `verify:backup` 重建整库 54 局 / 4379 手 / payload 845 578 B 逐字节一致。
- **上线版本**：`edccaaed-3997-4920-a862-d4a1f3fc4394`（首次全量切流）→ **`170c9d07-584b-48b4-8117-cf4ccef19cec`**（Rapfi 修复后）。回滚靠 `npx wrangler versions rollback`（已有 ≥4 个历史版本）。
- **只能事后确认的两件事**：① Cron `17 3 * * *` 已随部署注册，首次触发 2026-10-02T03:17Z，届时查 `stats_cache` 的 `daily:<UTC 日>` 行（本地查询返回 0 行属预期，见本文件另一条的「坑 5」）；② CI 首次 push 后实跑：**第 3 次（提交 `88d7a9f`，run `36852997058`）五步全绿**（类型检查 / 构建 / 引擎与金样 / vitest 真 workerd / 文档校验）。
- **CI 前两次红都不是代码回归（教训：本机绿 ≠ CI 绿）**：① 归档版本分布从 `6 ×0.8.0` 变 7 —— merge 把旧 `pages.dev` 快照自动提交的第 55 局（`games/2026-10-01/mock-vs-mock-20261001100609.json`，D1 无对应行）带了进来，处置是**删文件而不是改期望值**（封存集必须等于 D1 的 54 局）。顺带记一条**没被堵死的路**：旧 `pages.dev` 快照仍持有 `GAMES_GITHUB_TOKEN`，理论上还能往 `games/` 提交，护栏只有 CI 里的归档断言 + 事后删除。② `文档校验` 红在 `docs/architecture.md` 与 `docs/status.md` 链到 `../backups/export.sql` —— 那是 `npm run db:export` 的产物、在 `.gitignore` 里，**本机跑过一次导出所以绿，CI 里没有这个文件**。两类根因是同一族：**本机有而仓库里没有的东西**。已把这条规则写进 `scripts/check-docs.mjs`（链接指向被 `.gitignore` 忽略的路径也判失败，`git check-ignore -q` 判定，无 git 自动跳过），同时把行内代码 `` `...` `` 从链接扫描里排除以免正文举例误报；负向对照两次都真红。
- **浏览器冒烟脚本的两个经验（脚本自身的坑）**：① 判定「落子」不能用上墨像素**计数**（不透明棋盘从一开始就整块上墨，落子只改像素值不改计数），要用全 4 通道滚动哈希；且棋盘背景不透明 ⇒ 画布指纹必须拌 RGB。② CDP 拦网要用 `*://*/api/*` 并在 `Fetch.requestPaused` 里按 `new URL(url).pathname.startsWith('/api/')` 二次判定，否则连应用自己的 dev 源码模块 `/src/core/api/client.ts` 一起拦掉，离线测试会表现成「应用完全起不来」。③ 落子判定必须吃对象字段（`inkMove.ok`），早期把它当字符串接会让断言恒真变假绿。

---

## 2026-10-01 · Worker + D1 重构落地：真实数字，以及只在真机上才暴露的坑

- **落点**：D1 `jev-qiguan`（`database_id = f72390fe-a506-4a88-8db7-af7213657947`，WNAM；账号 `xd04040212@163.com`）→ 建表 16 条命令，导入 **54 局 / 4379 手 / 6 轮实验 / payload 合计 845 578 B / 孤儿行 0**；远程与本地逐项一致。Worker 部署在自定义域 **`https://jevqipan.logicc.top`**（账号里唯一 active 区域 `logicc.top` 的子域），`wrangler.jsonc` 用 `routes[].custom_domain = true`。版本 `cron` 触发器 `17 3 * * *` 随部署注册（`Deployed jev-qiguan triggers`）。
- **本机网络事实（决定了验收方式）**：`*.workers.dev` DNS 能解析但 TCP 443 连不通；`npx wrangler dev --remote` 的所有端点 25–40 s 超时（日志 `Error inside ProxyWorker … internal error`）。所以线上验证一律打自定义域，别把 workers.dev 写进文档示例。
- **口径对账可量化「迁移修好了什么」**：`npm run verify:parity` 同时算两个基线——全集 54 份（= 旧本地 `server.cjs` 口径）与线上截断 40 份（Pages 50 子请求预算，`functions/api/stats.js` 的 `MAX_FILES=40`），candidate 默认**直连本地 D1 库文件并真执行 `src/worker/db/stats.ts`**（用 `node:sqlite` 适配成 D1 子集）。结果 diff = 0；线上截断口径少的 14 局（40/54、`{五子棋:40}`、16/16/8）正是 P-2 要修的截断问题，新 `/api/stats` 一律全量、无 `truncated`。
- **备份必须真的能重建**：`npm run db:export` 第一版报 `The file was moved or deleted` —— 原因是 `backups/` 目录不存在（wrangler 不建目录）；`npm run verify:backup` 把导出 SQL 灌进内存 SQLite，逐局比对「payload sha1 == `games/<day>/` 里某个源文件」且 `game_moves` 行数 == `games.move_count`，通过即证明备份可完整重建。`backups/` 已进 `.gitignore`。
- **坑 1（本地 D1 库文件名由 `database_id` 派生）**：`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<sha256>.sqlite`，hash 来自 `database_id`。P4 把占位 UUID 换成真实 id 后，`npm run dev` 指向一个**新的空库**：`/api/health` 的 `schema: null`、`/api/games` → `{"error":"服务端异常"}`、`wrangler d1 execute --local` 报 `no such table: games`，而旧数据仍躺在旧 hash 的文件里。重跑 `db:migrate:local` + `node scripts/import-archive.mjs --local` 即恢复；旧文件要删掉，否则 `verify:parity`（自动挑 mtime 最新）可能落到旧库。已给 `npm run dev` 加 `predev` 钩子自动迁移，并写进 AGENTS.md §4。
- **坑 2（wrangler 不递归 migrations 子目录）**：分片 SQL 放在 `migrations/import/` 是安全的——`wrangler d1 migrations list` 只列 `0001_init.sql`。这是「导入 = 生成 SQL 分片」方案能成立的前提（D1 没有本地 socket，wrangler 是唯一执行入口）。
- **坑 3（生成 SQL 的两个真 bug）**：① `VALUES (${values.join(', ')})` 把多行元组包成了一个「行值」表达式 → 报 `54 values for 13 columns`；修法是让 valuesClause 自带行括号（多行 = `tuple.join(', ')`）。② 语句尾既在生成器又在渲染阶段加 `;` → 生成 `;;`，Python `execute()` 报 `You can only execute one statement at a time.`。定位手法值得复用：`sqlite3.complete_statement` 逐行累积切句 + `node:sqlite` 的 `DatabaseSync` 逐句 `exec` 报出具体第几条。
- **坑 4（兜底路由拿不到 requestId）**：requestId 中间件原来注册在 `api` 子应用上，而 `/api/*` 的 JSON 404 由 **app 层**处理——一条业务子路由都没命中的请求根本不经过子应用中间件，于是响应头有 id 而体内 `requestId: null`；`jsonNotFound(c)` 还漏传了第二个参数。修法：中间件移到 app 层（`app.use('*')` 放在 `app.route('/api', api)` 之前），兜底显式传 `c.get('requestId')`；回归用例断言 `x-request-id === body.requestId`。
- **坑 5（`/__scheduled` 被静态资产吃掉）**：开了 `assets.run_worker_first = ["/api/*"]` 后，非 `/api/*` 路径由 Workers Assets 接管，`curl '…/__scheduled?cron=*+*+*+*+*'` 返回的是 SPA 兜底 HTML（200），`stats_cache` 不会有心跳行——**别把这当成 cron 失败**。cron 的真实执行只能在部署后看（`stats_cache` 的 `daily:<日期>` 行或 `wrangler tail` 的 `[maintenance]` 日志）。
- **坑 6（vitest pool 没有逐用例存储隔离）**：`cloudflareTest({ singleWorker: true })` 下所有 worker spec 共享同一个 D1，任何新增 spec 都必须在 `beforeEach` 里自己清表，否则会看到上一个用例的数据（第一版就因此挂了两条）。
- **验收工具新增三件**（都零依赖）：`npm run smoke:live`（线上 HTTP 29 项，会写库，跑完要清 `smoke-%` 设备行）、`npm run verify:backup`（备份可重建性）、`npm run smoke:browser`（CDP 驱动系统 Chrome 的真浏览器端到端 9 项：页签渲染/棋盘绘制/渠道落盘/开始对局后状态栏与画布像素变化/曲线切换/设置抽屉/无未捕获异常）。**负向对照已验**：对「`src/main.ts` 仍是占位」的线上跑出 3/9，失败项正是页签未渲染与 canvas 300×150 空——说明它会真的失败而不是永远绿。

---

## 2026-09-30 · 「实验报告」面板要有产出：战报补齐 + 同渠道 A/B 归属修正

- 诉求（用户）：「实验报告那一栏要有产出」。查下来面板本身没坏——是**数据源缺**：面板读 `data/experiments.json`（服务端 `/api/experiments`）+ localStorage + app.js 里写死的 `EXP_SEED`，而 `games/` 里带 `experiment` 标签的 **6 轮里只有 2 轮有战报**。缺的 4 轮中 2 轮（`exp-20260929105234` / `exp-20260929111222`）只靠 `EXP_SEED` 才在面板露面，另 2 轮（`exp-20260930084500` / `exp-20260930143522`）完全不显示。
- **补齐**：`.work/exp-analysis/backfill-experiments.js` 由棋谱回溯生成 4 轮战报（A/B 按实验循环规则反推：`runExperimentGame` 里 `aBlack = (idx % 2 === 0)`，即 `expGameNo=1` 时 A 执黑），写进 `data/experiments.json` → **2 轮变 6 轮**；`EXP_SEED` 两条 note 也搬进归档（`.work/exp-analysis/migrate-seed-notes.js`），`EXP_SEED` 退回纯离线兜底。回溯时顺带按「着法串与更早一局完全相同」自动标 `dup`（`exp-20260929105234` 的 #1=#3，与 EXP_SEED 手工记的一致；不标的话面板有效局数会从 5 变 6）。
- **缺陷：同渠道 A/B 的胜负归属按渠道名比对**。`finishGame` 原来用 `winnerChan === EXP.chanA ? 'A' : 'B'`，而 A/B 同渠道时（`Jev·v8 vs Jev·v9` 都用 `proxy`）`winnerChan` 恒等于 `chanA`，**任何胜负都会被记成 A**。正好本轮新引入的就是这种同渠道不同档位的 A/B，等于把战报写坏。改为按「胜方是黑是白」+ 局号奇偶判定（`aIsBlack`/`winnerAB`）。现有归档里这轮是两局和棋（`winnerChan=null`）所以没被写坏，但护栏已加。
- **报告渲染**：卡片头改为 `roundSides(e)` 取 A/B 配置（轮级 `tacA/tacB` 优先，缺失时退到首局棋谱的 `blackTac/whiteTac`），并把 **tag 显示出来**（tag 是战报与 `games/` 棋谱互查的唯一锚，此前完全不显示）；胜方标签取「该局胜方所执那一侧」的实际配置，同渠道 A/B 才读得出 `Jev·v9 胜` 而不是 `Jev(代理)胜`。
- **服务端契约补字段**：`server.js` 与 `functions/api/experiments.js` 的 POST 归一化原来只留 `tag/date/chanA/chanB/total/games/note`，**把客户端发的 `tacA/tacB/thinkA/thinkB` 直接丢掉** → 归档后的战报读不出档位。现已保留（类型守卫 + `undefined` 省略，旧客户端形状不变）。契约文档同步 `docs/jev-api.md` §3。
- **护栏（新增自检组 `experimentArchiveTests`）**：① `games/` 里每个 `experiment` 标签都必须有战报（否则报告面板不显示它）；② `total`/`games.length` 与棋谱局数一致；③ 逐局 `winnerChan` 与「棋谱结果 + 局号奇偶」推出的一致；④ 轮级 A/B 配置等于首局棋谱；⑤ `dup` 必须标出。实测：删掉一轮战报 → 红并指名；篡改 `winnerChan` → 红并给出应为值。
- 验证手法：`.work/exp-analysis/exp-report-smoke.js`（vm 抽 `renderExpHistory` 原文 + 真实归档数据渲染，打印面板文本；6 轮 tag 全在、档位可读、重复局标出、合成同渠道 A/B 两局都正确显示 `Jev·v9胜`）。
- 已知小限制（未改）：累计行「Jev 渠道 X 胜 · 其他 Y 胜」对同渠道 A/B 轮无意义（两边都算 Jev），该轮的版本对照读卡片头的 `A : B` 即可。

---

## 2026-09-30 · pull 后全量归因盘点：窗口数会说谎，人机局被写成机机镜像局

- 触发：`git pull` 带进 6 份新棋谱（`jev-v8-vs-jev-v9-*` 等 slug 命名），要求「分析所有未分析的实验报告按版本分类」。盘点脚本留在 `.work/exp-analysis/`（`inventory.js` / `attribution.js` / `rounds.js` / `final.js`，`.work/` 不入库，可重跑复现）。
- **缺陷一：导出侧没给人类一方打 `human` 标记**。`duel.sideLabel/sideSlug` 早支持 `cfg.human`（输出「我/me」），但棋谱导出（`buildGameExport`）与战绩簿（`saveGameRecord`）都直接取 `effSide('black'|'white')`——纯渠道配置。于是 `mode=人机` 的局被写成 `jev-v0-vs-jev-v0` / `黑 Jev·v0 vs 白 Jev·v0`，**实测 3 份真棋谱**（`jev-v0-vs-jev-v0-20260930153642/153646`、`jev-v9-vs-jev-v9-20260930153451`，黑方是人类、着法无 `ai` 字段）这么撒过谎，而这批 slug 正是「按版本归因」的输入。修法：新增 `exportSideCfg(sideId)`，以 `isAISide(id)` 判定，人类侧补 `human:true`；导出与战绩簿两处共用。屏幕显示（上一条的 `sideLabelText`）早已按 `S.humanSide` 分流，**只有导出这条路径漏了**。
- **缺陷二：`games` 口径会骗人**。登记表用「文件名 stamp 落时间窗」归组，`v9.games` 记成 20，但这 20 份 `meta.code` 全是 `0.7.0`（线上没重新部署，实为 v7 档）；反过来 `v7.games=4` 而实证有 20。现拆成两个字段：`games`（窗口归属）+ `gamesVerified`（每手 `ai.tv`/`meta.code` 实证）。真实分布：v0-off 窗口 0/实证 2、v5 21/0、v7 4/**20**、v8 3/3、v9 26/**4**。沿革条**两个数恒同时显示**（`窗口 26 · 实证 4`）——不做「相等就合并成一个」的化简，因为 v8 的窗口 3 局与实证 3 局数量相同却是两批棋，合并就看不出这件事。
- **缺陷三：「认输」不分人判机判**。`认输` 唯一入口是人点 `#resignBtn`（`app.js`），但机机实验里这也被算成一局引擎胜负——实测 A/B 第 3 局是 181/225 手时人手认输收场，差点被当成「v9 打赢 v8」的证据。现 `st.result.by='human'`（引擎 `getStatus` 原样透传 `st.result`）→ 棋谱落 `endBy`，战绩簿与实验报告标「人判」。
- **护栏**：新增纯函数 `BG.tacticsVersions.auditCode(entries, opts)` + `DEPLOY_LAG` 台账（`from/until` = 14 位 stamp、`games:20`、`code:'0.7.0'`）。`archiveAttributionTests` 拿真实 `games/` 跑审计：要求 0 条未登记错配 **且** 台账条数与 `DEPLOY_LAG.games` 相符。**此前当前档只断言 `games >= 登记数`，这 20 局就是这么漏过去的**；已实测「注入一份伪造滞后棋谱 → 自检立即红，删掉即全绿」。
- **一条纠正**：登记表 v9 的 note 其实**早已写明**那 20 局是 0.7.0、反证部署滞后——文档没错，错的是 `games` 这个数字被当成「跑过这版的局数」读。修订记在 ADR-0009「修订（2026-09-30，pull 后归因校验）」。
- 另：`js/tactics-versions.js` 里「合计应等于 games/ 全部 28 局」的注释已过期（登记表合计 48，pull 后 `games/` 实为 54），已改为双口径说明。
- **未做的结论（留给实验设计）**：v8 vs v9 正面对照无机器判定胜负（2 局 225 手棋盘下满和棋 + 1 局人手认输），**样本不足以证明 soundness 修复带来棋力提升**；Jev vs Jev 镜像局高度趋和，要评版本差异应换 Rapfi 作锚。
- 验证手法：`.work/exp-analysis/export-attribution-smoke.js`（vm 抽 `app.js` 函数原文 + `new Function` 注入桩，14 断言覆盖 `exportSideCfg` 四种模式与 `endBy` 透传）。`node test/run-tests.js` 全绿。

---

## 2026-09-30 · 双方身份显示：写死的「Jev」不认 sideConfig（用户报障修复）

- 报障（m00135）：「机器对弈的时候应该要显示白棋是谁，黑棋是谁」。根因不是身份没算过，而是**五处文案写死 Jev**：对决面板 `#duelFirstName/#duelSecondName`（switchGame/bind 时写「黑方 Jev/白方 Jev」，只在切棋刷一次）、机机状态行 `'对局进行中 · Jev vs Jev'`、回合徽标 `' · 等待 Jev / 思考中'`、思考计时器、模式按钮静态 `'Jev vs Jev'`。抽屉把一侧配成 随机·v3 / Rapfi(5s) 后，这些屏全部不认账。
- 修法（js/app.js：sideName() 后新增三函数）：`sideLabelText(sideId)`（pvp→'玩家'；human-ai 且 sideId===S.humanSide→'我'；其余→`BG.duel.sideLabel(effSide(sideIdOf(sideId)))`）+ `machinePairText()`（两方 sideLabel 联名、**不叠人称**，供模式按钮/机机状态行，描述「将要对阵什么」）+ `renderSideNames()`（对决面板写 `side名 + ' ' + sideLabelText(sd.id)`，同步 `.mode-switch button[data-mode="ai-ai"]` 与 `#mode` option[value=ai-ai] 文案）。**六处调用**：startGame/saveSideCfg/saveFoe/applyModeUI/switchGame/bind——改覆盖/改机器方/切模式/切棋立即刷，不是只开局刷一次。
- **身份单一事实源 = effSide → duel.sideLabel**：effSide 本来就把 覆盖→全局→effectiveChannelOf 可用性回落 全串好，渲染层直接信任它，不再有第二份「我以为黑方是 Jev」的推断。附带行为（非 bug）：`effectiveChannelOf('proxy')` 无 key 仍返回 'proxy'，mock 回落只发生在 file:// 或无 key 的 official/openrouter。
- 纯显示改动不动 `BG.codeVersion`（v0.8.0 不变）；守卫落在 `test/run-tests.js` domContractTests 静态断言：app.js 必须有三个函数、`BG.duel.sideLabel(effSide(` 形态、`renderSideNames()` ≥7 次（定义+六调用）、禁 `'Jev vs Jev'/'等待 Jev'/'· Jev 思考中'/'黑方 Jev'` 字符串字面量、index.html 无 'Jev vs Jev'（静态占位同步改「机 vs 机」）。
- **静态断言要查单引号字符串形状，不能查裸文案**：注释里回顾这个 bug 时会写旧文案（如 app.js 状态行注释），裸正则会误报（本轮实测误报 3 次）；`'...'` 只命中代码里的字符串字面量。
- 可复用冒烟手法：`.work/ui-side-labels-smoke.js`（临时不入库）用 vm 抽 app.js 函数**原文**（按函数名截源码 + `new Function` 注入 `S/$/location/BG/document` 桩，S 是闭包常量故用 Proxy 转发到当前场景状态），18 断言覆盖：无 key 官方回落「演示 vs 演示」、有 key「Jev·v9 vs Jev·v9」、双方覆盖「黑方 随机·v3 vs 白方 Rapfi(5s)」、人机「我 vs Rapfi(3s)」、pvp「玩家」、象棋白先面板顺序（sides[0]=白方→写进 duelFirstName）。harness 坑：`Object.assign(S, over)` 会用 over.settings 整份覆盖默认 settings 丢 channel——要只合并不带 channel 的键。
- Open objectives: 用户浏览器人工核验对决面板/状态行/徽标三处文案（Rapfi 懒加载与 UI 阻塞 node 侧验不了真实对局，冒烟只到函数级）。

---

## 2026-09-30 · UX 收尾：机器对手直达面板 / 战术沿革竖列 / 棋谱按版本归档

- **用户四项诉求的落点**：① 模式按钮文案「人 vs Jev」→「人 vs 机器」；
  ② 人机模式机器方要能直接选 Jev/随机+战术/Rapfi + 思考时间——原先埋在设置抽屉
  「双方覆盖 · 白方」，现在对局页新增「机器对手」面板 `#foeChannel/#foeTactics/#foeThink`；
  ③ 战术沿革 chips 横条改普通竖列 `.tv-row`（用户明确说「就做成普通的 ui 列在下面」）；
  ④ 「棋谱归档」面板按战术版本分组列 `games/` 归档棋谱。
- **「机器对手」与抽屉「双方覆盖 · 白方」是同一份 `S.settings.sideConfig.white`**：
  面板是浅出口径（`renderFoe` 镜像），抽屉是深出口径（`renderSideCfg`），
  **任何一边保存都触发另一边重绘**（saveFoe→saveSettings→syncChannelUI→renderFoe 链条上
  闭环，不递归）。未改过时面板显示「跟随全局」，**当前生效配置写进 `#foeHint`**
  （`effSide('white')` 渠道·档位·思考），人 vs 人 模式三项 **disabled 而非 hidden**。
- **「跟随全局」必须写空串**：`resolve('')` 会收敛成 CURRENT，写成显式值后，
  以后改全局机器方就不跟着变了——`saveFoe` 里 `tactics: tac ? resolve(tac).id : ''`。
- **棋谱归版不看内容，看文件名 stamp**：28 份老棋谱全无 `meta.tactics`，但服务端存盘时
  用 `body.exported` 生成 `<gid>-<14位UTCstamp>.json`，`versionForFileStamp()` 按
  `[本档 commitAt, 下一档 commitAt)` 时间窗归组即可。**坑：stamp 必须带秒**
  （YYYYMMDDHHmmSS）——只给 12 位会让所有 stamp 数值上大于所有 from / 小于末档 to，
  全部误归 v9（实测 derived `{v9:28}`）；补秒后实测 `{v5:21, v7:4, v8:3}` 与登记表逐档吻合。
- **归位有单测兜底**：`archiveAttributionTests()` 直接走 `games/` 真目录，断言
  「登记表 `v.games` == 实测归属数」+ 三边界（v1 前→v0-off / 末档后→CURRENT / 无 stamp→null）。
  以后新加版本档必须在登记表写对 `commitAt`，否则立即红。
- **只 `listGames(100)` 拉一次列表，不逐份抓内容**（`BG.api.gameUrl` 纯拼 URL 供 `<a href>`），
  离线/无后端时面板降级给人话提示，不影响本机战绩簿。
- Open objectives: 无（四项诉求已实现并全绿，交用户人工核验布局与分区）。

---

## 2026-09-30 · 实验面板双卡重排 + 趋势芯片 bug（v0.8 后第一修）

- **`forEach((id) => id.classList.remove())` 是真事故源**：`id` 是字符串，
  `.classList` 为 undefined，TypeError 抛在 `renderAnalytics()` 之前——
  表现是「胜率/局势分/置信度点击毫无反应」且控制台才有错。修法是
  `(cid) => $(cid)`；已在 `domContractTests` 加双向静态断言（必须有
  `forEach((cid) => $(cid).classList.remove`，且禁止 `(id) => id.classList`）。
- **七个下拉一行 = 380px 侧栏里每个约 45px**，媒体查询 `max-width:560px` 按视口
  不按容器生效，窄侧栏永远挤扁。改成 `.exp-sides` 两列双卡（每方一张：渠道/战术/
  思考三行）+ `.exp-foot` 底部通栏（局数+开始/停止）+ `.exp-status-row` 独立状态行。
- **模式入口统一到 `applyModeUI()`**：`#mode` select 仍是状态源（startGame /
  runExperimentGame 读它），实验面板顶部按钮组只是它的镜像，
  `syncModeButtons()` 负责亮/灭 + `EXP.running` 期间禁用。
- **fillTacticsSelect/fillThinkSelect 一律先 `innerHTML=''`**，所以 index.html 里
  写死的 option 只是首屏占位，不会重复累积（改档位清单只需动登记表）。
- Open objectives: 无（本次为计划外的 UI 修复）。

---

## 2026-09-30 · 实验设施收尾：双方覆盖 sideConfig / 换边重开 / 沿革条 / slug 归档

- **`S.settings.sideConfig` 是这一版的枢纽**：黑白各自覆盖 渠道/战术/思考时长
  （空=继承全局），`effSide(side)` 统一归一（channel 过 `effectiveChannelOf`、
  tactics 过 `tacticsVersions.resolve`），人机与实验共用同一套，原来的双轨
  `S.expChannels` + `S.expTactics` 删除。实验开跑 `borrowSideCfg()` 借走 sideConfig、
  手动开局 `restoreSideCfg()` 归还——**mutate 全局 settings 再还原**这种模式要配
  renderSideCfg 重绘，否则抽屉显示与实际不一致。
- **换边重开（R6）三处判定必须走同一个 `resultText(g)`**：终局提示语、战绩簿胜方列、
  校准取样（`firstWin` 置 null 即被消费方剔除）。漂移的后果是战绩簿把「未终局」
  画成和棋、先手胜率被污染。`#swapBtn` 只在 `S.mode==='human-ai' && S.history.length>0`
  出现（`syncSwapBtn()`，playMove/undo/mode 变化/开局四处同步）。
- **slug 归档踩的坑**：`sanitizeGid(body.slug) || gid` **永远回退不到 gid**——
  `sanitizeGid` 内部 `return s || 'nogid'`，空串被兜底成 truthy 的 `'nogid'`。
  必须先净化再 `|| gid`（server.js 与 functions/api/games.js 同款）。
- **战绩簿联名不做第 8 列**：7 列网格在 1024px 加一列必溢出，改成棋种列下的
  10px 副行（`.rec-game i` + ellipsis + title 悬浮看全）。
- **改战术层必同步登记表**（含 `games` 局数），否则版本归因断裂；
  `tacticsRegistryTests` 有 ANCHORED 十档 / rank 连续 / MECHS 单调 / games 合计
  四道护栏，漏改立刻红。
- **app.js 静态断言会随实现演进过期**：这一轮就修了 4 条（`eff.tactics` 替
  `effectiveTacticsVersion`、`sideConfig` 替 `expTactics`、联名副行正则、
  跨行正则容许 `[\s\S]{0,80}`）。断言本文是「契约」，实现细化后要同步改，
  不要为了让它绿而把断言删掉。

---

## 2026-09-30 · 战术版本实验室：十档战术梯，让「哪版代码、哪层保险」第一次可复现

- **动机**：Jev+战术打 Rapfi 0-4 之后，收益最大的下一件事不是加机制，而是**把十档战术
  （v0 无战术 → v9 防伪胜）变成可复现变量**。此前强弱对比只能靠嘴：说不清一盘棋里的
  某个决策出自哪层保险、也无法让旧版逻辑重跑一遍。用户 m00348 明确「每一版都要有，
  不能遗漏」——于是按 git commit 时间线重建十档梯，commitAt 按 `git show %ci`（北京时间），
  实战局数归属 games/ 棋谱（中国跳棋 cohort 21/4/3），合计 28 局。
- **三个落点**：① `js/tactics-versions.js` 登记表（纯模块，`VERSIONS/CURRENT/MECHS/
  resolve/allows/ids/selfTest`）；② `js/jev-client.js` 版本闸门——`computeTactics` 加
  `versionId` 参数，`tacCache` 从 `WeakMap<st,res>` 改成 `WeakMap<st,Map<verId,res>>`
  **二级缓存**（同一 st 不同版本各存一份，混跑实验不互染），`decide` 按 `M.*` 键逐层
  开关，两处 meta 都写 `tacticsVersion`；③ UI——设置抽屉「战术版本」（只有 Jev 三渠道
  与 random 露出；mock 无战术层、rapfi 不经过它，控件隐藏）+ 实验面板 A/B 战术档 +
  棋谱导出 `tacticsVersion`/`blackTactics`/`whiteTactics` 与每手 `ai.tv`。
- **踩的坑**：① 计划文档里写「断言 `computeTactics(...).typeE8` 验证 open4 层」——
  **本库 computeTactics 从不产出 `type*` 字段**（`typeE8` 是引擎给 criteria 的标签，
  在 `ser.questions.move.criteria` 里，不在 tactics 里），只能改断言**决策级行为**
  （v1 下不得接管 open4、v2 下必须接管）。② 二级缓存必须先做，否则同 st 跨版本直接
  串味。③ `tacCache` 的 versionId 必须取 `resolve` 收敛后的 `ver.id`，不能取原始入参，
  否则 `''`/`'v99-nope'`/缺省会分裂成三个 key。
- **app.js 的测试路子**：app.js 是 DOM 闭包，Node 自检加载不了，`js/latest-board.js`
  之后的纯计算外移路线在这里到头了（都是 DOM 接线）。改用**静态源码断言**
  （`tacticsUiTests`：控件 id、十档 value 齐全、`resolve` 归一、decide 透传、实验两侧、
  棋谱导出版本字段）。保不住运行时行为，但「接线断了」这类回归从此有钉子。
- **codeVersion 0.7.0 → 0.8.0**（`js/board.js:28` 手工 bump）：归因从「哪版代码」升级为
  「哪版代码 × 哪档战术」两张维度。
- **事故**：用 write 全量覆盖 `docs/superpowers/plans/2026-09-30-tactics-lab.md`
  （1527 行计划文档）→ 只剩 19 行。教训写进 AGENTS 风格清单：**对超长文档只准 edit，
  不准 write**；要重写得先 `git show HEAD:<path>` 落盘再改。恢复命令就是
  `git checkout -- docs/superpowers/plans/2026-09-30-tactics-lab.md`。

## 2026-09-30 · vcfWin 伪胜（soundness）修复：game3 败因归因作废

- **推翻两条旧结论**（都写进了代码注释与 ADR，是本缺陷能活过一整轮实战复盘的原因）：
  ① `vcfWin` 函数头 + ADR-0007 §1 的「守方即时致胜点不可能因攻方落子新增（五连须同色），
  守方反击造杀属 VCT 范畴不覆盖」；② 上一条 memory 里「game3 的败因是白方防守反击造杀
  （VCT 范畴，不在本补丁范围）」。**两条都错**——这不是 VCT 深度问题，是 A 类实现 bug。
- **真机理**：攻方造四 → 守方唯一合法应对是堵 → **堵的那一手可能顺手给守方自己造出四**
  → 守方下一手直接成五 → 攻方后面的双杀永远兑现不了。`search()` 曾在
  `m.wins.length >= 2`（双杀）处直接返回胜，从不检查守方状态。
- **合成反例**（`test/run-tests.js` ⑫i，入口双方均无一步杀）：黑 F2,F3,F4 + G5,H5,G6；
  白 F1 + C6,D6,E6。旧引擎 `win=true line=F5,F6,E5`——黑 F5 成四 → 白堵 F6 →
  白 F6 与 C6,D6,E6 接成四（另一端 G6 被黑占，**唯一成五点 B6**）→ 黑 E5 双杀是假的；
  真实时序里白先走 B6 就成五了。⑫j 拿掉黑 G6 → 白堵完成**活四**（两端 B6/G6 = 2 个
  反杀点，攻方一步占不完）→ 该分支必无解。
- **实证**：`games/2026-09-30/gomoku-20260930025550.json`（Jev 执黑 19 手投子），
  第 36 手 black L14、第 38 手 black I11 都带 `tactics=vcfAttack`——正是探针判定的两条
  伪胜链。Jev 当时"在追一条不存在的杀"。
- **修复**（`js/games/gomoku.js`）：`search(pliesLeft, dWins)` 带守方即时致胜点参数，
  在双杀短路**之前**加闸门 `if (dWins.length && !(dWins.length===1 && 同点)) continue;`
  ——守方有反杀点时攻方这一手必须占掉它。递归传 `winsAfter(wr,wc,D)`（堵点后守方新致胜点
  只能过这一点，攻子进不了守方五连）；入口做一次全盘扫 `defenderWinsFull()`。
- **验证**：4 局 190 个决策点回放 `win=9/valid=7/FALSE=2` → `win=7/valid=7/FALSE=0`；
  151 点 A/B 基准只去掉那 2 条伪胜，7 条有效链全留，perCall 仍 0.38ms（零开销）；
  `025710` p18 `vcfDefense=E13`、`025550` p58 `vcfDefense=D9` 未退化。
  **反向验证**：把 HEAD 版引擎覆盖回工作区重跑全量，新用例如期红（不是恒真断言）。
- **ADR-0008**（新增，0007 已标注勘误）。教训写进 ADR：把**推论**写进 ADR「决定」段
  且不标注它依赖的前提 = 下一个 agent 会当既成事实照抄；注释比代码长寿，没人再验证它。

## 2026-09-30 · 棋谱导出 meta：让每盘棋能归因到"哪版代码、哪手是模型首选"

- 动机：修完 vcfWin 立刻遇到下一个瓶颈——**没法把败局归因**。棋谱只记记法序列和
  `tactics` 标签，看不出这手是模型首选（top-1）还是被采样/战术保险改写的，
  也看不出这盘跑的是哪版代码。下一轮实验（≥24 局分桶）没有这些就没法做对照。
- `js/board.js` 新增 `BG.codeVersion = '0.7.0'` + `BG._seed`（`setSeed` 记录种子）
  + `BG.util.aiMoveMeta(notation, meta)` + `BG.util.aiGameMeta(history, {topK})`。
  导出里每手带 `ai = {ch, mdl, conf, p, rank, cands, ms}`，顶层带
  `meta = {code, topK, seed, aiMoves, costUsd, tokens, latencyMs{avg,max}, conf, tactics}`。
- **刻意放 board.js 而不是 app.js**：`app.js` 是 DOM 闭包，`test/run-tests.js` 根本不加载它，
  写在那儿 = 没有回归护栏。纯计算下沉到无 DOM 依赖、测试已加载的 `BG.util`，
  `app.js` 只留调用——`docs/status.md` 技术债里已记成通用对策。
- 两个语义细节写测试时才发现，值得记住：① `rank`/`p` 在该手不在 top-8 里时**用 null
  不用 0**（0 会被误读成"模型给了这手 0 概率"，两回事）；② `aiGameMeta` 入参传整局
  history、函数内自己 `filter(byAI)`——我第一版信任调用方已过滤，`aiMoves` 把人走的手
  也数进去了，断言当场抓到。120 手 payload 33.8KB（2MB 上限的 1.6%）。

## 2026-09-30 · Rapfi 思考时长（强度）可调

- 用户问 Rapfi 能否调强度：可以，唯一旋钮是 Gomocup `INFO timeout_turn`（每步思考时长），
  时间越长搜索越深越强；Rapfi 无等级档位。
- 新增设置面板「Rapfi 思考时长」下拉（仅渠道=rapfi 时显示）：0.5/1/2/3（默认）/5/10 秒；
  存 localStorage（`rapfiThinkMs`），经 `BG.jev.decide` opts → `BG.rapfi.decide({thinkMs})` 穿透，
  机机/实验走同一条 decide 路径，同效。rapfi.js 内部仍钳制 500–60000ms。
- 10 秒档注意：WASM 单线程同步搜索，UI 会冻结约 10 秒（ADR-0006 已知局限）。

## 2026-09-30 · vcfDefense 多点干预重试（exp-20260930025135 复盘补丁）

- 实验 exp-20260930025135：Jev(proxy) vs Rapfi 4 局，Rapfi 4:0 全胜（黑白各两盘）。
  4 盘共 10 次"vcfDefense 发现对方 VCF 但放弃"（game4 ply18 / game2 ply42 / game1 ply69 等）。
- 根因（game4 ply18 白方已验证）：旧逻辑只试"占住将死链首步"，复搜发现对方还有链
  就直接放弃。但链上其他点可破杀——game4 的 7 步链 C13,A15,E13,F12,E14,C14,E12 中，
  E13/F12/E14/C14/E12 占任一点都能彻底杀死黑方 VCF。旧逻辑试 C13 失败就放弃，白走
  D13(parry3)，黑 E13 双重威胁（即时五连 F12 + 活四 E12）打死，白 25 手落败。
- 补丁（js/jev-client.js）：vcfDefense 改为先链首、再链条顺序逐点试干预，每点试走后
  复搜，首个"对方彻底无将死链"的点采用；全部失败才回落 parry。链首成功时行为与旧版一致。
- 回归 ⑫h：game4 前 17 手局面，白方 vcf_win_opponent 非空（旧代码为空）；mock 偏向
  D13 也被纠正到破杀点，tactics=vcfDefense。
- ~~game3 的败因是另一回事：黑 vcfAttack 链本身成立，但白方防守反击造杀（VCT 范畴，
  vcfWin 注释已声明为局限），不在本补丁范围，不硬造。~~
  **勘误（2026-09-30，见上方「vcfWin 伪胜（soundness）修复」条）**：此归因**错了**。
  game3 的黑 vcfAttack 链是**假的**——不是白方反击造杀，是 vcfWin 自己判错了。
  本条原话正是那个错误结论的源头，改动的动因也来自它。

## 2026-09-30 · VCF 威胁空间搜索上线（Jev 战术保险第六/七层）

- 新增 `vcfWin(st, attackerId, maxPlies)`（js/games/gomoku.js，gomoku/pro 共用）：
  连续冲四将死链搜索。只走逼迫着法（落子出致胜点），2+ 致胜点即双杀判胜，
  唯一则假定守方被迫堵后递归。默认 7 ply / 节点 4000 / 每层 ≤12 候选 /
  只扫攻击子距离 ≤3 空点；禁手模式黑攻禁走、黑堵禁手视为堵不住、黑致胜点须
  精确五连。~~**守方反击造杀属 VCT 范畴，不覆盖**~~
  **勘误（2026-09-30）：这句是错的，见上方 soundness 修复条 + ADR-0008。**
  守方**被迫堵的那一手**能给它自己造四（不是攻方落子给的），已用反杀闸门补上。
- jev-client.js 新增 vcfAttack / vcfDefense 层，优先级
  win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4；
  仅 1-ply 为空时跑，异常 fail-soft；meta.tactics 与 Jev instructions 同步语义。
- 防守核心规则「试走后复搜」：对方可能多条 VCF 根并存（⑨e：占 I9 后黑 E9
  照样杀），干预点试走后对方仍有 VCF 则弃用、回落 parry/pickSafestParry。
- 验证：回归 ⑫a–⑫g 全绿；rapfi-base1 四盘复盘——12 个触发点中 3 处
  （g3p41/g4p34/g4p36）实战着法没破杀、VCF 干预点经复搜确认破杀；
  终局前 3-5 手双方都破不掉的 3 处属棋已输，非 VCF 能救。
- 性能：最稠密实战中盘双向搜索 0–22ms。⑨d 复盘被 VCF 修正：
  黑真链入口是 E6（E6→D5→D6→F6→E7 双杀 C4+H10），vcfDefense=E6 取代
  原 parry3→E7 结论，后续黑 E7 时继续 vcfDefense=D6。
- 定位：VCF ≠ 完整 VCT ≠ 估值引擎；Rapfi 渠道保持独立对照。
- ADR-0007。

## 2026-09-29 · Jev vs Rapfi 实战 0-4 与 parry4 增补、gomoku-pro 禁手模式

- 4 局基线（tag rapfi-base1，原生 Rapfi 250615，2 线程/每手 5s，topK=3）：Jev+战术 0-4。
  g1 黑 26 手负（白 B6：双杀 B6/G6）；g2 白 37 手负（黑 L6-L10 列五：32 手 parry3 选 K10
  未挡 L8）；g3 黑 56 手负（白 J10-N14 斜五）；g4 白 43 手负（黑 G14-K14 横五）。
  统一模式：Rapfi 造双杀 → Jev 堵一 → Rapfi 从另一点击杀。
- 根因：2-ply 保险处理单双杀无虞，但看不见 3-4 步连续单杀逼迫链（VCF）与"双双杀"
  （两个独立双杀点并存，堵一必漏一）。parry3 只覆盖 deny:open4/deny:live3，
  漏掉 deny:four 制造点（g2 的 L8、smoke 局的 E10）。
- 增补 parry4（第五级，deny:four 预挡，优先级低于 parry3）：安静局面提前抢占对方
  冲四制造点，打断连续逼杀节奏。验证：g2 第 31 手复盘确认 parry4 逻辑生效，
  但因 K10 的 deny:live3 优先级更高仍选 K10——属启发式固有局限，非 bug。
  全量测试全绿。定位诚实化：Jev+战术对弱/中对手强（此前 8-0-1），对冠军级
  搜索引擎仍下风，深算差距非启发式补丁可弥合。
- gomoku-pro（五子棋·禁手）：与 gomoku 同文件工厂 createGomoku(forbidden 开关)，
  黑方三三/四四/长连禁手（落子即负）、黑仅精确五连胜、白无禁手；禁手点剔除出
  合法着法，Jev 序列化带 forbidden_points_black；已入 GAME_ORDER，大众模式不变。
  当前为连珠式禁手原型，未做 Swap2/RIF 开局协议，不可称完整赛事规则。
> （如 `.workbuddy/MEMORY.md`）只允许指向本文件，不得成为事实源。
> 沉淀规则见 [README.md](../README.md)「维护规则」。

---

## 2026-09-29 · Rapfi WASM 本地引擎接入（rapfi 渠道）

- 构建：Emscripten 6.0.10，Rapfi tag 250615，`NO_MULTI_THREADING=ON` + `NO_COMMAND_MODULES=ON`
  （Emscripten 强制）+ `USE_WASM_SIMD=ON`；产物 `rapfi/rapfi-single-simd128.{js,wasm,data}`。
- 两个构建坑：① `Networks/wasm_preloads.txt` 是 CRLF，CMake 的 `file(READ)` 会留下 `\r`
  污染虚拟 FS 路径，构建前转 LF；② tag 250615 单线程构建有编译错误
  （`searchthread.cpp` 的 `ThreadPool::waitForIdle` 用了多线程才有的 `th->thread` 成员），
  本地加 `#ifdef MULTI_THREADING` 守卫（单线程下该函数本就是空操作）。
- 数据包精简：只预加载 `config.toml` + freestyle 权重，`.data` 从 40MB 降到 9.6MB；
  权重缺失抛的是 `runtime_error`（不是 `UnsupportedEvaluatorError`），会残废整个 evaluator，
  但 freestyle 权重排第一且存在，实测无影响。
- 协议细节（源码级，非猜测）：`INFO rule 0`=无禁手；`BOARD` 颜色相对引擎（1=SELF 轮走方，
  2=OPPO），落子必须按 SELF/OPPO 交替且首子 SELF，否则引擎插 PASS 对齐会打乱轮走方；
  `config.toml` 的 `coord_conversion_mode=X_flipY` 输入输出同构，往返一致，取协议惯例
  x=列(0左) y=行(0顶) 与项目记法对齐。
- `js/rapfi.js`（`BG.rapfi`）：懒加载胶水脚本，`START 15`→`INFO rule 0`，每手
  `INFO timeout_turn`+整盘 `BOARD`；解析只认严格 `x,y` 行（引擎搜索日志走 `MESSAGE`，
  必须过滤）；无着法/非法着法抛错走现有错误路径；仅 `engine.id==='gomoku'`。
- 单线程 `sendCommand` 同步阻塞，思考期间 UI 冻结约 thinkMs（默认 3s）；后续应迁 Web Worker。
- 许可：引擎 GPLv3、权重 CC0，`rapfi/NOTICE` + `rapfi/COPYING.txt`；`js/rapfi.js` 自研 MIT。
- 冒烟（真实 WASM，Node）：START→OK、空盘 H8、四连 2ms 内走出制胜 H7、白方视角正常。

## 2026-09-29 · 侧栏页签化：右栏不再把页面撑长

- 痛点：右栏 8 个可折叠面板 + 驾驶舱 + 设置全堆在一列，页面总高被侧栏决定，观感差。
- 方案：面板按「对局（判断/对决/最新决策/决策流）/ 数据（实验报告/战绩簿/校准/棋谱）/
  设置」分三页签；`.side` 改 `position: sticky` + `max-height: 100vh` + 栏内独立滚动，
  页面总高回归由棋盘列决定。页签栏在栏内滚动时 sticky 吸顶，←/→ 可循环切换（ARIA tabs）。
- 关键复用：页签隐藏也是 `display:none`，图表零宽问题与折叠同理——`activateSidePane`
  切回时对已展开面板直接复用 `FOLD_HOOKS` 补一次全量渲染，没有引入第二套机制。
- 页签选择持久化在 `jev_qiguan_sidetab_v1`；折叠持久化键不变，老用户状态不受影响。
- ≤1080px 单列布局下 `.side` 回归 `position: static`（吸附在窄屏反而碍事）。
- 修正（同日）：初版把整列 `.side` 设为滚动容器，多面板展开时驾驶舱被挤出视口、
  且 flex 子项默认 `flex-shrink:1` 会压缩固定区。改为「驾驶舱 + 页签栏固定
  （`flex:0 0 auto`）、仅 `.side-pane` 滚动（`flex:1 1 auto; min-height:0`）」。
  教训：sticky 栏内做滚动时，滚动范围要限定在内容区，固定区必须显式禁 shrink。

## 2026-09-29 · CF Pages 补齐三端点：线上也获得完整后端（方案 1 落地）

- 用户问「可以部署到 cf 上吗」「是不是可以改成 worker」。结论：Pages Functions **就是**
  Worker（同运行时同 API），server.js 的 node:http/fs 在 Workers 里不存在（nodejs_compat
  也不放行），不可能小改迁移；但把三个独有端点移植成 Pages Functions 即可让线上获得
  与本地一致的完整体验。选定方案 1（保留 git 自动部署，不引入 wrangler/npm）。
- 新增 `functions/api/health.js`（零上游请求的探活，`github` 字段报 token 配置态）、
  `experiments.js`（读写仓库 `data/experiments.json`，按 tag upsert，`exp: <tag> [skip ci]`）、
  `stats.js`（聚合）。持久化全部走 GitHub（复用 games.js 的写路径），**零新增绑定**：
  不引 KV/D1/R2，数据天然版本化。三文件共用 `functions/api/_github.js`（下划线前缀
  不对应路由的共享模块，Pages/Wrangler 的 ESM import 是标准行为）。
- **免费版 50 子请求/次 是 stats 的硬约束**（已查证）：设计成 1 次 trees + ≤40 份 raw
  （raw.githubusercontent.com 走 CDN 不计 API 配额）+ 1 次 contents = 42，测试里直接断言
  ≤42。截断时 `truncated: true`，前端显示「40+ 份」不冒充全量（本地 server.js 仍是 400 份）。
- **Pages 的 SPA 兜底坑**：未匹配的 `/api/*` 返回 index.html + 200（线上实测）。前端
  `BG.api` 靠 JSON 解析抛错被 catch 成 null 来降级——行为正确但是隐式的，已在 jev-api.md 写明。
- 测试：`pagesApiTests` 用「剥 import/export + 源码拼接」加载模块（_github.js 定义内联进
  同一作用域，模拟 Wrangler 打包），stub fetch 按 URL 路由模拟 GitHub。踩了两个自己的坑：
  withStub 多行 route 少写一个 `]`（第二个参数被吃进路由数组，SyntaxError 定位到几十行外）；
  以及断言本身写错（3 份里只有 1 份既非 mock 又有二元真值，cal.games 应为 1）。
- 聚合口径与 server.js handleStats 逐字一致（byGame/results/cal.records），前端按
  gid|着法串去重合并，本地与线上样本可互换。

## 2026-09-29 · 后端化（ADR-0005）：server.js 零依赖 Node 后端 + 前端全量打磨

- 用户要求「重构成具有后端的项目」，但不能违背 ADR-0001（零框架/零构建/零依赖）。
  解法：`server.js` 只用 node:http/fs/path，`node server.js`（默认 8788）一个命令得到
  静态托管 + `/api/jev` 代理 + `/api/games` 落盘 + `/api/experiments` 归档 +
  `/api/stats` 聚合 + `/api/health`。棋谱文件名规则与 CF 端逐字对齐（gid 清洗截断 24、
  `games/<exported 日期>/<gid>-<stamp>.json`），`flag:'wx'` 原子写实现幂等。
- **降级路径即原路径**：`js/api.js`（BG.api）全部方法失败返回 null 不抛；`app.js` 启动
  `initBackend()` 探活，live（server.js）才做服务端合并，deploy（file:///纯静态/Pages）
  行为与后端化之前逐字节一致。头部「后端」chip + 设置面板「数据存储」块显示三态读数
  （jev-qiguan-server v1.0.0 / 棋谱份数 / 最近同步结果）。
- 后端对产品最实质的增强：**校准实验室双源合并**。`buildGameExport()` 补 `cal/firstWin/mock`
  字段（与 saveGameRecord 同口径，抽出 `calSamples()` 单一事实源），`/api/stats` 按局返回
  `cal.records`（key = gid|着法串），前端与本机战绩簿按 key 去重合并——换设备、清缓存
  不再把校准数据清零。mock 标记口径改为「本局无任何真实渠道着法」：对比实验一方 mock
  一方 Jev 时，Jev 半局的样本仍然有效。
- 测试：`test/server-tests.js` 18 项 HTTP 契约（临时目录 + listen(0)，不碰仓库数据），
  由 run-tests.js require 进唯一验收命令；`serverTests(log)` 的 log 注入让输出顺序与
  引擎用例一致（否则后端用例会插到最前面）。
- 前端打磨（impeccable polish 模式，保留月白/玄墨/朱砂体系）：修了一个真 bug——
  **`.mono` 数据字工具类没有基类规则**（app.js 挂 21 处，字体从未换成等宽），「等宽数据字」
  这个体系组成实际是死的；补基类 + `font-variant-numeric: tabular-nums`。
  另：caret-color 主题化、`#tabs` 纳入主题滚动条、`＋/－` 与 `⚗`  Unicode 字形换成自绘 SVG
  （craft-floor 拒绝项）、棋谱面板空态、probe 加载态、窄屏头部 chip 裁切修复
  （420px 实测品牌副标题 255px 宽，芯片行改确定性换行）、engine-metrics 窄屏两列。
  impeccable detect 复跑：零新增违规（仅存量 4 项文档化例外）。
- 实测（CDP 驱动真实点击，非仅静态截图）：mock 渠道自动打完 19 手终局 → 0.5s 内棋谱
  落盘 → 设置块显示 `jev-qiguan-server v1.0.0 · 22 份`、「最近同步 · 成功」；
  file:// 回落「无本地后端」，对局/导出/记录不受影响。
- 坑：本机有多个历史遗留 dev-proxy.py 实例占着 8788（Windows SO_REUSEADDR 允许多监听
  共存，新连接落点不确定），验证时换 PORT=8790；server.js 的 EADDRINUSE 文案已指向换端口。

## 2026-09-29 · 对比实验面板 + random 纯随机基线渠道（Jev vs 随机，8:0:1）

- 动机：要回答「Jev+战术到底比纯随机强多少」，需要可重复的机机 A/B 连跑。实现（`app.js`）：
  实验面板选 A/B 渠道 + 局数（1–20），`startExperiment()` 起跑，**自动交替执黑白**（偶数局 A 执黑），
  终局 2.5s 自动开下一局；`effectiveChannelFor(side)` 让同局黑白走不同渠道（平时回落 `effectiveChannel()`）；
  手动开局不清 `expChannels`（`startGame` 里 `EXP.running` 守卫）。
- **random 基线渠道**（`jev-client.js`）：均匀概率、零启发式、`model='random-baseline'`、成本 0，
  但**刻意走完整战术管线**——这样「随机+战术 vs Jev+战术」的唯一变量就是概率分布质量。
  两个坑：① 自由手原先被 topK=1 坍缩成「取第一顺位」，退化成顺序走子（A1→B1→C1…，实测两盘
  棋谱完全相同）——改为 `legal[BG.util.rand(len)]` 真随机均匀采样，与 topK 无关；战术接管不受影响。
  ② mock 渠道不走战术层，random 走，两者语义不同别再混。
- **实验报告面板**：`localStorage`（`jev-exp-history-v1`）归档每轮战报 + 内置两轮真实实验种子
  （`EXP_SEED`），`loadExpHistory` 按 tag 合并：缺失或局数偏少（某局棋谱是部署后才同步到的）自动补齐，
  再按日期倒序。重复局标 `dup` 不计入有效统计。
- 结论（有效 9 局）：Jev(代理)+战术 **8 胜 0 负 1 和**；基线 9 局进攻性战术（threat/open4/win）
  **触发 0 次**，65+ 次战术触发全是防守——纯随机只会被堵，造不出双杀。次轮 #4 下满 225 手和棋：
  双方都是纯防守节奏。样本仍小（同棋种同配置），结论方向可用、数值别当统计显著性。
- 趋势图兜底（同批）：random 着法不再进 Jev 判断序列（`meta.channel !== 'random'`）；
  三芯片永不为空——局势分缺失用胜率×10、置信度缺失用首选概率。

## 2026-09-29 · 棋谱自动同步进仓库 games/（对比实验的数据底座）

- 动机：复盘分析需要真实对局数据，手动导出上传太慢。链路：终局 `uploadGameRecord()` POST
  `/api/games` → CF Pages Function（`functions/api/games.js`）用 GitHub API commit 进仓库
  `games/<YYYY-MM-DD>/<gid>-<stamp>.json`。GET `/api/games` 列出最近 7 天棋谱。
- 关键决策：**提交信息带 `[skip ci]`**——Pages 的 git 集成会把任何 push 当部署触发，
  棋谱数据提交不触发构建，否则对局一多就把构建队列淹了（加之前 Pages 白构建了 20+ 次）。
- 密钥：CF Pages 环境变量 `GAMES_GITHUB_TOKEN`（fine-grained PAT，只给本仓库 Contents 读写）。
  **未配置时 500 + 客户端静默失败**（只 console 记录）——同步是增强不是对局依赖，这条降级路径必须有。
  限流同 jev.js 做法（POST 20 次/分/IP）；payload 校验 `format === 'jev-qiguan-game/v1'`。
- 开关：设置面板「终局自动同步棋谱」（`settings.gameSync`，默认开），存 localStorage。
- 教训：`exportGame` 的 payload 构造抽成了 `buildGameExport()` 复用；实验局额外带
  `blackChannel/whiteChannel/experiment/expGameNo` 字段，否则归档后分不清哪局是谁走的。

## 2026-09-29 · 拆杀点安全性排序：3-ply 排除持续攻击（parry 第二判）

- 用户实战败局复盘（白 Jev 负，`jev-gomoku-202609290924.json`）第 18 手：danger=[I9,E9] 两个双杀
  制造点并存，实战走 I9（Jev 偏好）→ 黑 E9 单杀逼杀 → 白被迫 D9 → 黑 H12 对角成四 → 白只堵一端
  → 黑 D8 获胜。根因：**I9 只是 E9 的其中一个致胜点，堵它不解决问题**。
- 修复（`jev-client.js`，`deepTactics` 引擎生效）：多个 danger 并存时 `pickSafestParry` 两轮排序——
  ① `allowsSustainedAttack`：白走 p 后黑有逼杀 q（走出后恰 1 个致胜点）→ 白被迫堵 → 黑**仍有
  danger 点** ⇒ p 给了黑持续攻击节奏，排除；② 剩余点按 `countForcingReplies`（p 走后黑的逼杀
  着法数）取最少。单点或非 deepTactics 引擎回退 `pickAmong`。外层 64 候选、逼杀 q 只看前 8 个、
  逼杀数数到 10 即停——深度换时间的边界写死在代码里。
- 回归用例 ⑨e：钉住本局 p18（mock 概率偏向 I9 0.9 仍被接管到 E9，`meta.tactics='parry'`）；
  用例 ⑩/⑪ 同批钉住 random 渠道（一步杀必堵、自由手真随机）。
- 认知沉淀：**「堵哪个点」和「挡不挡」是两个问题**——2-ply 只回答后者；多个独立制造点并存时，
  点的选择要看 3-ply（堵完对手还有没有杀）。保险层到此为止，更深仍靠模型。

## 2026-09-29 · 实战败局复盘（jev-gomoku-202609290843.json）：parry3 预挡层

- 用户导出的真实败局（白 Jev 负，黑 H6-I7-J8-K9-L10 对角五连）。逐点复盘确认：保险层全程正常
  （p14/16/18/22/24 五次 parry、p26 block 全部正确），败因是**第 20 手 danger 为空的自由手走了
  闲着 E6**——黑 F8 已埋 E7 活三点（win-in-3），白 H10 后 E7 升级为开放四点被强制拆，黑 J8 枢纽
  成双杀（p24 danger = K7,K9,G11 三个独立造杀点）→ 数学上已死。
- 关键认知：**2-ply 保险保证 win-in-2 以内不犯错；这局输在 win-in-3（对手活三制造点）的先手权**。
  E7 在 p20 只是 deny:live3 标签（引擎早算出来了），但保险层没有对应动作，模型也没优先选它。
- 修复：第四级接管 parry3——win/block/open4/threat/parry 全无时，抢占 criteria 里带
  deny:open4/deny:live3 标签的点（对手的活三/活四制造点），让「对手造不成活三」成为机械保证。
  代价：Jev 会偏防守（进攻层优先级都在前面，有 2 步杀仍先走杀）；回归用例 ⑨d 钉住本局 p20
  （mock 偏向 E6 仍被接管到 E7/H10）。
- 复盘方法沉淀：导出 JSON → replay 逐点打印各级战术列表（本次发现 p24 danger 有 3 个独立点
  = 已死的机械标志；p20 danger 空 = 自由手才是败因）。「danger 列表 ≥2 个独立点」可作为
  已死判定，后续可做成局面评估的一部分。

## 2026-09-29 · 战术保险扩展到 2-ply：造杀/拆杀点（threat/parry）

- 用户实战复盘（白 Jev 输）：第 24 手前黑已有 F7,F8,F9 开放三连，1-ply 双方无致胜点（旧保险不触发），
  Jev 走 E8 未堵 F6/F10；黑 F10 成四后白 F6 只堵一端，黑 F11 获胜。
- 复盘发现第 24 手白已输定：黑有两个独立杀招——F 三连，与 E8 暗藏的双杀
  （黑走 E8 → 对角四连 E8,F9,G10,H11 + 横四 D8,E8,F8,G8,H8，致胜点 D7/D8/I12 三个），白只能堵其一。
  教训：单一威胁局面必须当场拆掉，不能等威胁成双。
- 实现（jev-client.js，引擎通用；gomoku 声明 `deepTactics: true` 开启）：
  `threatMakers` 找"走出后己方有 ≥2 个一步致胜点"的候选着法——己方造杀点（chance_points_you，
  两步必胜，带护栏：走出后对方不能反手有致胜点）、对方造杀点（danger_points_opponent，必须现在拆）。
  只在 1-ply 无战术时跑，外层只扫 64 候选点，内层数到 2 即停；中盘约 0.6s（node）。
- 保险优先级：win > block > open4 > threat > parry（open4 为后合入的活四层，语义是 threat 的
  精确子集，排在前因判定最严格、meta 更具体）；meta.tactics 新增 threat/parry，UI 决策卡片显示
  「保险·造杀/拆杀」；state.tactics 与 move 指令同步声明新字段语义。
- 回归测试⑨/⑨b/⑨c：干净单三连拆杀（白必走 F6/F10，mock 概率偏向 H8 仍被接管）、己方造杀、
  用户实战残局 danger 完备性（含隐蔽的 E8/I12，注释写明该局面已输定、保险救不回）。
- 局限：多重独立威胁的已输局面保险也救不回；2-ply 只看一层双杀，更深的杀法仍靠模型。
  后续价值：收集真实错局做分层回归，而不是只测一步题。

## 2026-09-29 · 五子棋提示词：斜线 few-shot 具象示例修复对角误读

- 真实 API A/B 验证（jev-1.13.0，黑对角四连 F6,G7,H8,I9、白 J10 封一端，胜点 E5，每组 3 次重复，
  纯 prompt 对比、不带 tactics 注入以隔离指令效果）：
  旧指令 P(E5)≈0.02~0.03、恒错选 H9；仅在清单里"点名四个方向"无改善（≈0.02）；
  加具体斜线示例（"F6,G7,H8,I9 对角四连→胜点是延续该斜线的 E5，不是附近的 J9/E6"）后
  P(E5)→0.76~0.81，三次全选对。
- 结论：Jev 的斜线盲不是"不知道要查斜线"，而是模式识别失败——抽象指令无效，具象 few-shot 示例有效。
  已写入 `gomoku.js` move 指令（含"双方棋子同样适用"泛化句），注释留了验证数据。
- 泛化抽查：白方 O 子对角四连 D4,E5,F6,G7（胜点 C3/H8），三次全选对 H8（P≈0.27~0.30）。
- 兜底关系不变：一步成五/被成五仍由战术保险（computeTactics）确定性接管；示例修的是模型自身读盘能力。
- `node test/run-tests.js` 全绿（含提示词断言：scan in order / cell by cell / board_ascii 关键词保留）。

## 2026-09-29 · 活三识别：criteria 战术标签 + 第三级接管

- 用户实测反馈「活三无法识别」——字符画+清单仍不够：活三/活四是**模式识别**，恰是模型最弱环。
  解法沿用已验证的路子再推一层：引擎代读棋盘，`labelPoint` 用真实推演给每个候选点打战术标签
  写进 `criteria`（API 本就为选项提供说明字段）：you:open4/four/live3、deny:*、block:five、
  组合 `+` 连接，静点 null 不耗 token。模型从「发现模式」降为「比较标签」——它擅长的。
- **第三级接管**：活四点（you:open4）+ 对方无先手五 = 理论必胜（两处成五点防不胜防），保险
  扩为三级 win → block → open4，`meta.tactics='open4'`、决策流标「保险·活四」。真实 API 实测：
  黑活三 vs 白活三局面，Jev 拿到标签后概率质量全落在 8 个战术点上，接管后走出必胜的 I8。
- **窗口扫描的坑**：活三判定最初用「窗口内是否存在延伸成活四的点」，F5 的对角窗口恰扫到 8 行
  的黑活四点（与 F5 无关）导致大面积误标 you:live3。修正为沿方向精确判定（连续三子+两边界空
  +延伸成活四）。教训：模式判定的搜索窗口必须与「该点参与该线」绑定。
- 跳三（X.XX 型）暂不识别（连续 run 判定的已知边界），笔记留待后续；冲四/跳四经
  fiveCompletions 精确覆盖不受影响。

## 2026-09-29 · 五子棋提示词四板斧（ASCII 棋盘/刚性清单/防幻觉）

- 用户给的四板斧打法全部落地在 `gomoku.js` serializeForJev：① `board_ascii` 裁剪字符棋盘
  （有子区域外扩 2 格，X/O/小写末手，空盘裁天元 5×5）——模型读字符画远比坐标列表准；
  ② move 指令改为五步刚性扫描清单（成五点→挡成五→活三活四→挡活三→多威胁择优），替代空话；
  ③ **analysis 文本问实测不被 API 支持**（同 payload 不带 200/带上 400 api_usage_error 单变量对照，
  且 API 契约只有 choice/noul/score）——且并行结构下 analysis 也不会反哺 move（串联链被规则 6 禁），
  「先分析后作答」只能折叠进 move 指令，已照做；④ 防幻觉：凡声称成五/成四必须逐格报整条线，
  核对不过即弃。
- 真实验证：四连局面 G8/L8 = 0.87/0.11（保险 win），中盘给出围绕战场的合理分布。
- **上游 401 会阵发性误报**：key 有效却连续 401 数十秒到几分钟（当天实测两轮），probe/choice
  「形状相关」是撞窗口假象——同一个 payload 十分钟后全 200。401 保持不重试，但文案改为提示
  「key 无误时可能是瞬时故障」。
- 教训：写测试断言前先看清自己造的局面——我断言「末手 K8 小写 k」，实际棋序末手是白 G5，
  棋盘输出是对的、断言是错的。

## 2026-09-29 · 规则摘要进 state（六引擎 rules 字段）

- 追查「Jev 拿到什么」时确认：对手落点一直在（双方棋子坐标 + last_move），但**规则只有 game 字段
  一行简介**，细节全靠模型预训练——而贴 5.5、强制跳吃、升王即停这类本项目口径与教科书未必一致。
- 修复：六引擎 `serializeForJev` 各加 `state.rules`（2 句英文：胜负条件 + 特殊规则/参数），
  每手随局面重发。写作纪律：**与引擎实现严格一致**，不是照搬教科书（如 chess 的 50 回合/子力不足
  判和、checkers 的升王即停都按本项目实现写）。engine-interface.md §4 硬约束新增第 6 条，
  run-tests 加契约断言（缺失或 <40 字符即红），新引擎作者躲得掉这个坑。
- 用户决策：只补规则摘要，**没加** move_history（行棋顺序）——局面完全决定状态的棋种里它是冗余信息，
  token 成本却随局数线性涨；等校准实验室有数据再评估。

## 2026-09-29 · Jev 强度：战术事实注入 + 战术保险 + 经验累计

- 用户反馈「Jev 很蠢」。根因：state 只给裸坐标，模型要从坐标列表自己算五连——空间推理正是它最弱的。
  修复不是改 prompt 措辞（概念性指令它本来就读得懂），而是**把算得清的事实算好喂进去**：
  `decide()` 统一给 `serializeForJev` 产出做后处理（六棋种通用，mock 不动）：
  ① `state.tactics`：用引擎自身 applyMove/getStatus 模拟推双方一步致胜点（翻 st.turn 扫对方着法）；
  ② `state.experience`：真实渠道历史局相同开局前 4 手的先手胜率（战绩簿新增 `notas` 字段做数据源）。
- **战术保险**：解析概率后致胜点必走/对方致胜必挡（榜内按概率加权、榜外直接执行并标 warning），
  `meta.tactics = win|block|null` 透出到决策流卡片（「保险·致胜/拦截」）。概率是偏好，事实优先。
- 实测（真实 API + 黑四连局面）：注入后 Jev 把 G8/L8 两致胜点概率打到 0.91/0.09——**模型确实
  读懂并使用了注入事实**；保险层确认 win、无接管。
- 两个坑：① `moveFromNotation(st, n)` 是双参契约，漏传 st 在 gomoku 炸 parseN（测试红了一遍才抓到）；
  ② 测试棋序要留意交替手数奇偶——7 手后轮白，黑四连要凑 8 手且白子散开不造威胁。
- 经验注入的诚实边界：样本 <2 局不给、离线演示局从不参与、和棋不计入胜率分子。变强没有走
  「改概率/改 topK」的捷径——那是伪装，注入事实 + 兜底接管才是模型能力边界内的合法手段。

## 2026-09-29 · 部署改为 git 自动集成（推送即部署）

- **jev-qiguan 项目已连 GitHub（tripodxu/board-games）：push 到 main 即自动部署**，
  构建命令留空、构建输出目录 = 仓库根目录 `/`，`functions/` 由 Pages 自动识别，无需任何配置。
  即「改完 → node test/run-tests.js 全绿 → commit → push」就是完整发布流程。
- wrangler 直传流程（更新 `.work/deploy-staging` + `wrangler pages deploy`）降级为备用手段，
  仅在 git 集成失效时救急（见下方「部署上线」条目）。
- 验证部署是否生效：`curl -s https://jev-qiguan.pages.dev/ | grep <新特性标记>`
  （本次用「测试连接」），或 `npx wrangler pages deployment list --project-name=jev-qiguan`。

## 2026-09-29 · 侧栏折叠一屏化（UI 打磨轮）

- 用户痛点：右侧分析栏 9 个面板全展开约 2 屏。方案：**驾驶舱常开 + 7 个面板可折叠 + 状态持久化**
  （`jev_qiguan_panels_v1`），密度同步收紧（side gap 16→10、panel padding 16/18→12/15、
  趋势图 viewBox H 196→158、空态块 34→14px）。1920×1000（≈真实浏览器 chrome 后的 1080p）
  下全部分析面板一屏可见；棋谱/设置两个低频抽屉贴边是有意取舍——再挤破坏间距节奏。
- **默认态要有内容**：首访全折叠（第一版截图验证时抓到）会让首屏没有任何分析内容，改为默认展开
  「Jev 判断」，localStorage 有存储则完全尊重用户。存储区分「从未存过」与「显式清空」靠 raw===null。
- **折叠期间 display:none 的面板，图表量宽为 0**：展开时必须补渲染（FOLD_HOOKS → 各 render* 全量
  重建函数，恰好都是无状态重建，直接调用即可）。iframe wrapper 真实点击折叠钮验证了这条路径。
- 折叠时标题行里指向面板内部的实体控件（曲线切换、清空）一并隐藏；note/计数保留作「瞥视」。
  折叠钮是自绘 SVG chevron（craft-floor 禁 Unicode 字形当图标），展开动效 0.18s transform/opacity
  且尊重 prefers-reduced-motion（不违反「动效收敛为落子」的既定取舍——一次性状态过渡非装饰循环）。
- 验收：截图三视口（1920×1080 / 全展开 3450 / 1366×768）+ impeccable detect **零新增违规**
  （仅存量 4 项：渐变误报、11px 例外×2、promoBox 例外）+ 全量测试/DOM 台/文档检查全绿。

## 2026-09-29 · 部署上线（Jev 接入轮之四）

- **https://jev-qiguan.pages.dev** 已上线（CF Pages 项目 `jev-qiguan`，账户 xd04040212@163.com，
  production branch=main，直传部署非 git 集成）。线上验证三连：静态页 200；`/api/jev` 无 key → 401 中文提示；
  带 key → 真实响应 `jev-1.13.0`（noul 0.73，279 token）。
- **重部署流程**（直传模式下文档即部署脚本）：更新 `.work/deploy-staging/`（只含 index.html、
  package.json、README.md、LICENSE、css/、js/、functions/，排除 .git/.work/docs/test 等）→
  `npx wrangler pages deploy .work/deploy-staging --project-name=jev-qiguan --branch=main --commit-dirty=true`。
  staging 目录在 .work（不入库），改动站点文件后必须重拷再部署。
- 访客「只填 key」已可用（BYOK）；要「打开即玩」需在 CF 控制台给项目设环境变量
  `TYPESAFE_API_KEY`（Pages 项目环境变量仅 dash 可设，wrangler 无对应命令），花费走站长账户。

## 2026-09-29 · CORS 白名单实测定论 + file:// 自动落演示（Jev 接入轮之三）

- 用户诉求「只提交 apikey 就能用，不要自行跑代理」。实测给出硬结论：官方 API 带 **CORS 来源
  白名单**——`OPTIONS` 预检带 `Origin: https://console.typesafe.ai` 放行（回显 ACAO），
  `example.com` 与 `null`（file://）一律 400 "Disallowed CORS origin"；官方文档无配置入口。
  **结论：浏览器只填 key 直连官方在任何第三方站点都不可行，同源转发无法省略**——这不是实现选择，
  是服务端白名单 + 浏览器同源策略的双重约束。
- 体验修顺（代码侧能做的都做了）：`effectiveChannel()` 在 `file://` 下 proxy 渠道自动落演示
  （此前双击打开默认 proxy 渠道，第一手棋必报 Failed to fetch——用户实际撞到的就是这个，不是
  官方 API 的 CORS）；proxy 渠道网络错误提示改为「本地 dev-proxy / 线上部署」双向指引；
  渠道 hint 更新为白名单实测结论；「填 key 即玩」的正解收敛为：**部署一次 CF Pages
  （`npx wrangler pages deploy .`），访客填 key 即玩；设 `TYPESAFE_API_KEY` 环境变量则打开即玩**。
- probe 的 cors 判定文案同步改准确（「官方有来源白名单」而非泛泛的「加 CORS 头」——后者用户做不了）。

## 2026-09-29 · 连通性探测「测试连接」（Jev 接入轮之二）

- 用户实测撞上「Failed to fetch（若为浏览器跨域受限…）」后才开局失败，要求开局前能先探测。
  新增 `BG.jev.probe()`（两段式）：A 段 `no-cors` GET 只判「网络层可达」；B 段按真实契约发最小
  `noul` 请求。fetch 层 CORS 拦截与断网同为 TypeError，靠 A 段结果区分——这是浏览器端唯一能做的分诊。
- **mock 单测抓不到请求体形状，真实端点会**：首版 probe 漏发 `model` 字段，单测全绿，真实端点
  422 拒绝（`body.model required`）。教训：凡「按契约构造请求」的代码，单测必须断言请求体本身
  （已补：state/model/questions 三字段齐全）。probe 体必须与正式请求同构。
- 实测矩阵（用户提供的真 key，env 传入未入库）：官方直连 probe ok（`jev-1.13.0`，~1.9s）——
  **官方端点真实可达**，浏览器直连的 Failed to fetch 就是 CORS；假 key → 401 判 auth；
  dev-proxy 代理渠道 probe ok + 真实 `decide()` 走子 H8（447ms，$0.000024）全链路通；
  不存在域名 → network（~11s，两段各 10s 超时叠加，感知偏慢可接受）。
- probe 的 kind：ok/network/cors/auth/http/shape/mock/config，判定表在 jev-api.md §2.1。

## 2026-09-29 · 自定义 Base URL（Jev 接入开放化）

- 用户痛点：三个真实渠道的 endpoint 全部硬编码在 `jev-client.js`，自建/兼容网关接不进来。
  改为「渠道 = 预设 + 可覆盖」：设置面板每个真实渠道都有「接口地址」输入框，placeholder 即预设，
  留空用预设；自定义值按渠道分别存 localStorage（`settings.endpoints`）。客户端新增
  `BG.jev.presetEndpoint(ch)` 与 `decide` 的 `opts.endpoint`。
- 语义决策：**端点自定义 ⇒ 渠道明确可用**——`effectiveChannel()` 不再因未填 key 回落 mock，
  客户端也不强制 key（自建网关可匿名）；有 key 照发 Bearer / X-Api-Key。预设端点行为一概不变
  （official/openrouter 无 key 仍拒绝），旧用例零改动全过。
- 陷阱：渠道切换时输入框里还是旧渠道的地址。`saveSettings` 若按「select 当前值」归档，会把旧端点
  复制到新渠道名下——归档（`stashEndpoint(prev)`）必须发生在改写 `S.settings.channel` **之前**。
- model 名不随端点走：仍取渠道预设。要换模型是另一个需求，别顺手混进来。
- 新增回归（run-tests.js 用例④）：自定义端点覆盖预设 + 匿名放行 + 预设端点不受影响 + presetEndpoint 出口。

## 2026-09-29 · 前端打磨（迭代 04·前端轮）

- 方向由 `impeccable` 技能流程定：用户选**「精修 + 更有张力」**——保留月白/玄墨/朱砂体系与全部
  内容交互，不换视觉世界，只加大对比与编排。`craft-floor` 的 Verify/Refuse 两节作为底线。
- **Phase 0 先量再改是本轮有效的原因**。全部结论先变成数字：`--ink-mute` 在四档底色上只有
  3.32~3.74:1（全档未达 4.5:1，而它承载 22 处 9~10.5px 小字）；控件边界 1.51:1（未达
  WCAG 1.4.11 的 3:1）；22 处字号 <11px。凭感觉只会写成「看起来有点淡」，无法验收。
- **选择器与 HTML 不匹配的静默失效**：`.feed { max-height; overflow-y }` 整条规则从未生效，
  因为容器是 `<div id="feed">` 而 CSS 写的是 `.feed`。表现是侧栏随对局无限长——**看不出是 bug，
  只会觉得「布局有点怪」**。同类死代码还有 `.stats`/`.stat`、`.engine-panel.live` + `seal-breathe`。
- **自己引入的违规要自己抓**：上一轮（校准实验室）我加了 `.cal-hero { border-left: 3px }`，
  本轮被 craft-floor 拒绝项点名。改为底色 + 数值配色承担层级。
- **detect 必须改完再跑**（技能要求），它因此抓到了计划外的三件事：`--zhu-hi` 上白字仅
  3.87:1（渐变端点上的文字，Phase 0 的前景/背景配对扫描扫不到）；5 处 `transition: width/height`
  逐帧重排；「发丝线 + 宽投影」模板化签名 3 处。
- **教训：渐变上的文字自动检查盯不住**。detect 报 `#ffffff on #ffffff 1.0:1` 是它解析不了
  `linear-gradient()` 的误报，但逐处人工核算后发现**它同时漏报了真问题**（3.87:1 那处）。
  结论：渐变端点要么人工核算并写注释，要么别把文字放在渐变上。
- **减法也是张力**：删掉两处无限循环装饰动画（`pulse` / `seal-breathe`），把唯一保留的编排
  时刻定为「落子」——曲线一次性描线 + 末点单次外扩，两者共用同一 `--ease`，读起来是一个动作。
  描线进度用 `pathLength="1"` 归一化，不必猜路径长度。
- 残留 3 项有意例外（含 detect 的 1 项误报）已写入 `docs/status.md`「设计例外」。
- 详见 [../plans/2026-09-29-iteration-04-frontend-polish.md](../plans/2026-09-29-iteration-04-frontend-polish.md)。

## 2026-09-29 · 校准实验室（迭代 03·创意轮）

- 新增 `js/calibration.js`（纯函数、零 DOM、Node 可加载）：把 Jev 逐手的胜率预测与对局真实
  胜负放同一把尺子上量。指标 `brier` / `skill` / `ece` / `mce` / `overconfidence` + 可靠性分箱图。
- **主动放弃了一个"看起来更权威"的公式**：Murphy 的 `BS = REL − RES + UNC` 三分式。
  推导时用完美预测 `p=y∈{0,1}` 代入即证伪（公式给 0.25、真值 0）——该恒等式在「分箱内预测值
  非常数」时不成立，需要额外的箱内方差修正项才严格。**不发布自己证明不了的分解**，
  改用「定义即真值」的 brier + 技巧分 + ECE。
- 技巧分定义 `1 − brier/(p̄(1−p̄))`：分母是「恒定猜真实基准率」这一参考预报的 brier，
  因此恒定义良好（`p̄∈{0,1}` 退化时返回 `null` 而非 Infinity/NaN，面板显示「—」）。
- **本特性真正的洞察（夹具实测，非文案）**：恒猜 0.5 的预测器 `ece` 也是 0（从不说谎），
  但 `skill` 是 0；校准良好的预测器 `ece` 同为 0 而 `skill` 0.5。**ece 单独使用会骗人**，
  所以面板把技巧分与校准误差并排给出。夹具 A/B 在 `js/calibration.js` selfTest 里。
- 数据取舍：**离线演示的合成概率不写入 `cal`**（`saveGameRecord` 过滤 `meta.mock`），
  拿合成数据算校准等于自欺；**和棋不入样本**（二元事件无真值，记 0.5 会同时污染 brier 与 ece）。
- 诚实性约束写进实现：同一局内各手共享同一真值 `y`，样本按「局」强相关，
  有效样本量接近局数而非手数——面板同时显示「N 局 / M 手」并明写此 caveat。
- 验证：11 个变异（skill 取倒数/ECE 漏乘权重/过度自信反向/真值方向反/和棋未剔除/p=1 越界…）
  **全部被夹具捕获**；一次性 DOM 台端到端 21 项全过，含「真跑一局离线演示后 cal 仍为空」。
- 教训沉淀：写夹具时要**先想「什么变异会逃逸」**——最初夹具全在「单箱或零偏差」情形下，
  `ECE 漏乘 n_k/N` 这个变异能悄悄通过，补了夹具 F（两箱、样本量不等、都错）才杀掉它。
- 详见 [../plans/2026-09-29-iteration-03-calibration-lab.md](../plans/2026-09-29-iteration-03-calibration-lab.md)。

## 2026-09-29 · 悔棋回路修复（迭代 02·优化轮）

- 修掉两个确证缺陷（走查 + 最小 DOM 桩红/绿验证，非猜测）：
  ① **悔棋后 AI 回合永不续弈**——`undo()` 没有任何 `setTimeout(aiStep, …)`；当被作废的那次
    决策恰好在途（epoch++ 后其结果被丢弃）时没有任何新调度，对局永久卡死，而界面仍显示
    「等待 Jev」。② **终局后悔棋状态条残留「终局 · … 获胜」**——`finishGame` 写过状态条并隐藏过
    暂停/单步，`undo()` 从不复位。
- 顺带清掉两处开销：决策流改**增量插入**（此前每手 `innerHTML=''` 重建最多 40 张卡，
  cc 一局 138 手 ≈ 5.5k 张卡 / 5 万+ DOM 节点，O(n²)）；`history` 去掉 `prev` 全量 state 快照，
  改**只存记法、悔棋按记法重放**（`applyMove` 纯函数，快照从不被改；`prev` 全仓库只有悔棋一处读它）。
- 关键决策：还原路径依赖「记法往返」这一既有硬契约（engine-interface.md §2），因此在
  `test/run-tests.js` 的 `playOut` 里加了**整盘记法重放等价断言**——一次覆盖 gomoku/cc/go。
  已用变异实验证明该断言有鉴别力（篡改 `moveFromNotation` → 立刻发散），不是永真断言。
- 反思/遗留：① **`app.js` 的 UI 行为至今无自动化回归护栏**，`run-tests.js` 只覆盖引擎与
  Jev 客户端；本轮靠一次性 DOM 桩验证（不入库）。后续若要长期护栏，值得把它做成正式测试。
  ② 发现一个**未修的既存不一致**（下轮候选）：`effectiveChannel()` 只对 official/openrouter
  在无 key 时回落 mock，**proxy 无 key 仍返回 proxy** → 纯静态托管（无 functions/）且未填 key 时
  会收到 401，而不是 README 承诺的「自动进入离线演示模式」。
- 计划与验证证据：[../plans/2026-09-29-iteration-02-play-loop.md](../plans/2026-09-29-iteration-02-play-loop.md)。

## 2026-09-28 · 仓库硬化完成（已合并 main 并推送，CI 首次全绿）

- 新增：LICENSE(MIT) / .gitattributes / .editorconfig / package.json（零依赖，npm test 即验收）/ CI / CHANGELOG / scripts/check-docs.mjs；gh 仓库元数据（description + 8 topics）。
- 硬化：Pages Function 每 IP 每分钟滑动窗口限流（默认 30，`RATE_LIMIT_PER_MIN` 非法值回退 30——防 'abc'→NaN 静默失效与 ''→0 全量锁死）；jev-client 与 Pages Function 单测（429 重试/401 即抛/非法着法回退/topK 端到端回归/401/422/限流/上游转发）；mock 种子化（?seed=42）。
- 验收：npm test + npm run check:docs 双绿；CI 三步 success（[run 36451454165](https://github.com/tripodxu/board-games/actions/runs/36451454165)）；最终整体审查 Ready to merge: Yes。
- 执行方式：subagent-driven-development——每任务 fresh subagent 实现 + 规范审查 + 质量审查双阶段，共 24 个 commit；三处审查发现的问题（topK 哨兵惰性、限流配置 fail-open、复现断言摘要相撞盲区）均由变异实验实证后修复。
- 已知后续（Minor，不阻塞）：① 限流配置容错的回退路径（'abc'/'0'/'-5'）无直接单测护栏（当前仅测 limit='2'）；② docs/jev-api.md「同一 seed 每盘完全一样」措辞待澄清——mock 不经 weightedPick、真实渠道不经 seed，两者都不受 ?seed 影响。
- 详见 docs/superpowers/plans/2026-09-28-board-games-hardening.md。

## 2026-09-28 · mock 种子化落地

- `BG.setSeed/rng`（mulberry32，逐字抄 jev-piano rng-shim）+ `BG.util.rnd()`；`?seed=42` 复现演示。
- 替换点共 10 处（mock-ai 3 + 六引擎 7）；`weightedPick` 不经 `rand`，真实渠道自动不受影响——这是无需拆代码路径的天然隔离点。
- 集成测试改为同 seed 两次 playOut 断言一致（全棋谱比对，防摘要相撞漏报）；`BG_FAST` 现由 run-tests.js 默认设置（`BG_SLOW=1` 可覆盖）。

## 2026-09-28 · 仓库硬化：限流/CI/种子化（见 docs/superpowers/plans/2026-09-28-board-games-hardening.md）

- Pages Function 加每 IP 每分钟滑动窗口限流（默认 30，范本逐字抄 jev-piano/src/worker.js:6-19）；429 文案用中文与 401 保持一致。
- 更正一个此前的误判：`jev-client.js:127` 的 `opts.topK | 0 || 1` 解析为 `(opts.topK|0)||1`，行为正确（2→2、4→4），**不是 bug**；已加回归测试防止被误改成 `topK|1`（那才会强制奇数）。
- `decide()` 的 warning 文案由「已随机回退」改为「已回退到首个合法着法」——回退目标是 `legal[0]`，确定性。
- mock 链路种子化（?seed=42）：只动 `BG.util.rand` + 10 处 `Math.random`→`BG.util.rnd()`；`weightedPick`（真实渠道 top-k 采样）不经过 rand，自动保持真随机。

## 2026-09-28 · 文档体系重建 + 仓库初始化并推送远端

- 远端：`git@github.com:tripodxu/board-games.git`（SSH，账号 tripodxu，已验证可用）。
- 建立规范：`AGENTS.md`（agent 入口）+ `docs/`（status/architecture/engine-interface/jev-api/
  adr×4/agents×6/plans）+ `docs/memory/MEMORY.md`（本文件，最新在上）。
- `.gitignore` 重点：`__pycache__/`（本机已存在，切勿提交）、`.workbuddy/`、`.claude/`、
  `.zcode/`、`.work/`、密钥类（`.env`/`.dev.vars`，只提交 `.example`）。
- 多 agent 协同设计：六引擎文件互为天然并行边界；`app.js`/`jev-client.js`/`test/run-tests.js`
  是热点公共文件，默认归编排者；接力用 `.work/handoff.md`（不入库）+ memory 置顶沉淀。
- 本地指针文件 `.workbuddy/MEMORY.md`（gitignore）指向本文件，供本机 agent 快速定位。

## 2026-09-28 · MVP 完成度与验收口径

- 六引擎全部完成并通过 selfTest：象棋开局 44 着法 + 照面/绝杀/困毙；国际象棋
  perft(1/2/3) = 20/400/8902 + 易位/吃过路兵/升变；西洋跳棋开局 7 着法、强制连跳、
  升王即停；围棋提子/禁自杀/劫/双停数子（贴 5.5）；中国跳棋连跳链与营地规则；
  五子棋候选预筛 ≤64。
- 集成测试：mock 渠道 gomoku/cc/go 三盘机机完整对局终局（`BG_FAST=1` 跳过模拟延迟）。
- 唯一验收命令：`node test/run-tests.js`；浏览器侧 `index.html?test=1`。

## 2026-09-27 · Jev 接入的关键结论（选型记忆）

- Choice 选项上限 255 → 围棋只做 9 路（13 路需预筛策略，见 status.md 路线图）。
- 官方 API 浏览器直连会被 CORS 拦 → 必须保留同源代理渠道（BYOK 转发，ADR-0003）；
  OpenRouter 直连最稳。
- 中文精度较低 → state/instructions 一律英文坐标记法（ADR-0002）。
- 成本：输入 $42/百万 token，输出免费；单步 0.5–1.5K token ≈ $0.00005，一局 < $0.05。
- Jev 确定性输出会导致机机对弈每盘一样 → top-k 加权采样是机机模式必备。
- 深度调研原文在仓库外：`../jev_model_memory.md`（父目录 jev_games，不随本仓库走）。

## 2026-09-28 · 实现期踩坑记录

- `dev-proxy.py` 用持久 TLS 连接转发，实测每手省 ~0.45s 握手开销。
- `app.js` 用 `epoch` 计数器丢弃过期异步回调（切棋种/重开时旧 Jev 结果必须作废）——
  改 AI 调度逻辑时这是最容易被破坏的不变量。
- 加载顺序是硬编码两份：`index.html` script 标签 + `test/run-tests.js` 清单；
  新增 JS 文件两处都要加，漏一处 = 自检 silently 少测一个引擎。
- `BG.util.clone` 是 JSON 深拷贝 → 引擎 state 里禁止放函数/undefined/DOM 引用。
