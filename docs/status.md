# 项目状态

> **每次行为变更后更新本节**（不写流水账）。最后更新：2026-10-05。

## 当前状态

**v1.0：Cloudflare Worker + D1 已上线，前端由 Vite/TypeScript 构建。** 入口是自定义域 <https://jevqipan.logicc.top>（`*.workers.dev` 不是入口）。旧形态「纯静态站 + 三套后端（零构建、零依赖）」已被取代，正式决策见 [ADR-0010](adr/0010-worker-static-assets-replaces-pages.md)～[ADR-0013](adr/0013-anonymous-device-identity-and-d1-ratelimit.md)；架构与数据流见 [architecture.md](architecture.md)；迁移全过程见 [plans/2026-10-01-workers-d1-rebuild.md](plans/2026-10-01-workers-d1-rebuild.md)。

| 面 | 状态 | 说明 |
| --- | --- | --- |
| 边缘后端 | ✅ 已上线 | Worker `jev-qiguan`（Hono）；8 条 API：`/api/health`、`/api/games`、`/api/stats`、`/api/experiments`、`/api/openings`、`/api/leaderboard`、`/api/jev`、`/api/export` |
| 静态资产 | ✅ 已上线 | Workers Static Assets，Vite 产物；`/api/*` 由 `run_worker_first` 保证进 Worker，其余回落 SPA 外壳 |
| 数据 | ✅ 已迁入 D1 | 数据库 `jev-qiguan`（WNAM），`database_id = f72390fe-a506-4a88-8db7-af7213657947`；见下「数据现状」 |
| 定时任务 | ✅ 已挂并已核验 | Cron `17 3 * * *`（UTC）；首次真实执行 `2026-10-02T03:17:56Z`，`stats_cache` 的 `daily:2026-10-02` 行报 `rateLimitsDeleted: 139 / games: 82 / moves: 7110 / experiments: 11` |
| 棋种 | ✅ 七种 | 五子棋、五子棋·禁手、围棋（9 路）、象棋、国际象棋、西洋跳棋、中国跳棋；引擎在 `src/core/engines/`，注册顺序见 [registry.ts](../src/core/registry.ts) |
| 实验设施 | ✅ 双路径 | 浏览器口径 `scripts/experiment-run.mjs`（CDP 真浏览器）；**SSH 远端批量口径 `scripts/experiment-batch.mjs`**（纯 Node 对弈回路 + 空闲主机 nohup worker + 文件 checkpoint 断点续跑 + Elo 子命令，[ADR-0019](adr/0019-remote-batch-experiments.md)）；**离线运行面缺省直连上游 + 本地 JSONL + 对象桶留档，不碰业主 Worker 与 D1**（[ADR-0021](adr/0021-standalone-experiment-plane.md)） |
| 渠道 | ✅ 六个选项 | `official`、`openrouter`、`proxy`（同源 `/api/jev`）、`rapfi`、`mock`（离线演示）、`random`；定义见 `src/core/jev/client.ts` |
| 面板 | ✅ 已就绪 | 驾驶舱 / 决策流 / 战绩簿 / 校准实验室 / 战术沿革 / 设置抽屉 / 归档面板 / 回放器 / 排行榜 / 开具体验全部接线（`src/app/panels.ts` 的 `renderDataPanels` + `loadLeaderboardPanel` / `loadOpeningsPanel`，回放器由归档面板逐手驱动，归档面板首屏 50 份 + 「加载更多」按 keyset 游标追加） |
| 棋谱上传 | ✅ 已上线 | 终局后进上传队列（本地去重 + 退避重试），`POST /api/games` 落 D1；重复提交返回 `dedup: true` 且写 0 手 |
| 账号体系 | ⛔ 不做 | 匿名 `X-Device-Id`，无登录（ADR-0013） |
| 旧实现 | ✅ 已删除 | 2026-10-01（P8）：`js/**`、`functions/**`、`legacy.html`、`server.js`、`dev-proxy.py`、`css/**`（→ `styles/style.css`）、旧测试三件套 `test/{run-tests,server-tests,rapfi-tests}.js`。对照表见 [architecture.md](architecture.md) §9 |

> **版本口径已统一为单一来源**：`package.json` 的 `version` 与 [wrangler.jsonc](../wrangler.jsonc) 的 `vars.APP_VERSION` 现在都是 `1.0.0`，由 `test/core/version.spec.ts` 逐字钉住；前端写进棋谱的 `codeVersion` 形如 `1.0.0+<git short sha>`（`vite.config.ts` 构建期把 `APP_VERSION` + `BUILD_SHA` 注入 [src/shared/version.ts](../src/shared/version.ts)）。旧「按文件名时间窗归因 + 手工 bump `BG.codeVersion`」已退役。

## 数据现状

线上 D1 与导入产物一致（来源：计划 P4 执行记录，以及 [migrations/import/manifest.json](../migrations/import/manifest.json)）；
2026-10-01 下午起 D1 里多了**真跑出来**的 4 局（见下「真实验」一行），2026-10-02 又加了战术 v10 对照实验的两臂 24 局、v11 单臂 12 局、v10 直连 v11 的同门 12 局、v11 的计时轮 12 局、v12 单臂 12 局，v12 对 `rapfi@1000ms` 与 `rapfi@2000ms` 各 12 局（同日傍晚，用来验证「按 m08704 抬高 Rapfi 思考档」这一档），以及 v13 对 `rapfi@1000ms` 的 12 局（外加一轮被打断的首轮 3 局，无实验行）；2026-10-03 又加了 v13 的 20 局档位复核两轮、v14 对 `rapfi@1000ms` 的 12 局，以及一次 2 局落库验证（确认固定思考档与 `code_version` 归因真的写进去了）；同日**远端批量口径合入 main**（[ADR-0019](adr/0019-remote-batch-experiments.md)，工具 `scripts/experiment-batch.mjs`）后又加了 3 轮 26 局（见下）。导入基线仍是 54 局 / 4379 手：

> ⚠️ **口径说明**：下表把**本仓库脚本跑出来的全部记录**算在一起，含远端批量那 26 局——它们由本仓的
> `scripts/experiment-worker.mjs` 在空闲主机上跑出、经 `/api/games` 归档，只是跑的当时
> `code_version = dev+nogit`（Node 直载无构建注入）、`device_id` 为 NULL，所以**不能与浏览器轮的
> `1.0.0+<sha>` 放在同一条归因链上**。2026-10-03 收口批起，worker 会带 `X-Device-Id: ssh-batch`
> 并把提交自报进 `meta.code`（`dev+nogit+<sha>`）⇒ 之后的远端轮次可按 `device_id='ssh-batch'` 单独筛出。
> **2026-10-03 P0b 数据卫生**：那 26 局已按 tag 回填 `device_id='ssh-batch'`（先补 `devices` 行，因为
> `games.device_id REFERENCES devices(device_id)`；**只改设备归属，`code_version` 仍是 `dev+nogit`**，不猜 sha）
> ⇒ 现在 `select count(*) from games where device_id='ssh-batch'` = **26**。注意 NULL `device_id` **不等于**
> 远端局（浏览器轮也不发 `X-Device-Id`，D1 里仍有 286 局为 NULL）：判设施产物要按 tag 或按 `ssh-batch`。
> 按 `experiment_tag` 过滤的分析不受影响；但「全局计数恰好 +N」这类断言会假红（`scripts/smoke-live.mjs` 已放宽为「至少 +1」）。

| 项 | 值 |
| --- | --- |
| 棋谱 | **310 局 / 19249 手** = 导入基线 54 局 / 4379 手（全部五子棋；日期 2026-09-29 与 2026-09-30）**+ 4 局 proxy-vs-proxy 真实验**（2026-10-01，各 225 手，tag `exp-20261001132645`）**+ 24 局 v10 对照实验**（2026-10-02，tag `exp-20261001174212` / `…174837` / `…181244` / `…182552`）**+ 12 局 v11 对照实验**（2026-10-02，408 手，tag `exp-20261002055817`）**+ 12 局 v10 直连 v11**（2026-10-02，1202 手，tag `exp-20261002080446`）**+ 12 局 v11 计时轮**（2026-10-02，347 手，tag `exp-20261002094817`）**+ 12 局 v12 对照实验**（2026-10-02，390 手，tag `exp-20261002115126`）**+ 12 局 v12 vs `rapfi@1000ms`**（2026-10-02，474 手，tag `exp-20261002121700`）**+ 12 局 v12 vs `rapfi@2000ms`**（2026-10-02，725 手，tag `exp-20261002123631`）**+ 12 局 v13 vs `rapfi@1000ms`**（2026-10-02，535 手，tag `exp-20261002160819`）**+ 3 局被打断的 v13 首轮**（2026-10-02，119 手，tag `exp-20261002154056`，**无 `experiments` 行**，不计入实验轮）**+ 20 局 v13 vs `rapfi@1000ms`**（2026-10-03，937 手，tag `exp-20261003003108`）**+ 20 局 v13 vs `rapfi@2000ms`**（2026-10-03，1193 手，tag `exp-20261003020720`）**+ 12 局 v14 vs `rapfi@1000ms`**（2026-10-03，629 手，tag `exp-20261003035953`）**+ 2 局落库验证**（2026-10-03，118 手，tag `exp-20261003044054`，用来确认 `black_think`/`white_think` 与 `code_version` 归因）**+ 20 局 v14 vs `rapfi@2000ms`**（2026-10-03，1518 手，tag `exp-20261003050139`，用时 3453s）**+ 12 局 SSH 远端 `rapfi@500ms` vs `random/v13`**（2026-10-03，600 手，tag `exp-20261003042812-rapfi1-r1`）**+ 2 局 SSH 远端 `proxy/v13` vs `random/v13` 真上游冒烟**（2026-10-03，107 手，tag `exp-20261003052056-smoke1-r1`）**+ 12 局 SSH 远端 `proxy/v13` vs `rapfi@500ms`**（2026-10-03，957 手，tag `exp-20261003052604-x1-r1`，含 2 局 225 手满盘和棋）**+ 20 局 v14 vs `rapfi@3000ms`**（2026-10-03，881 手，tag `exp-20261003075310`，用时 2089s）**+ 20 局 v14 vs `rapfi@5000ms`**（2026-10-03，990 手，tag `exp-20261003082805`，用时 2898s）**+ 1 局未挂 tag 的 9 手 proxy-vs-proxy 短局**（2026-10-03，uid `ad0ca92a`）；54 份归档源仍是 [games/](../games) 那 54 局 |
| 实验轮 | 28（导入 6 轮 + 2026-10-01 真跑的 `exp-20261001132645` + 2026-10-02 对照实验的 4 轮 + v11 单臂 `exp-20261002055817` + 直连 `exp-20261002080446` + 计时轮 `exp-20261002094817` + v12 单臂 `exp-20261002115126` + `rapfi@1s` 轮 `exp-20261002121700` + `rapfi@2s` 轮 `exp-20261002123631` + v13 `rapfi@1s` 轮 `exp-20261002160819` + 2026-10-03 的 20 局档位复核 `exp-20261003003108`（v13 vs `rapfi@1000ms`）与 `exp-20261003020720`（v13 vs `rapfi@2000ms`）+ v14 `rapfi@1s` 轮 `exp-20261003035953` + 落库验证轮 `exp-20261003044054`（2 局）+ v14 `rapfi@2s` 轮 `exp-20261003050139`（20 局）+ 远端批量三轮 `exp-20261003042812-rapfi1-r1` / `exp-20261003052056-smoke1-r1` / `exp-20261003052604-x1-r1` + v14 `rapfi@3s` 轮 `exp-20261003075310`（20 局）+ v14 `rapfi@5s` 轮 `exp-20261003082805`（20 局），均已补 `/api/experiments` 行；被打断的 `exp-20261002154056` 无行、只在棋谱里；本仓库的 distinct tag 是 29 个） |
| payload 总量 | 845578 B（54 局导入部分；最大单局 68.7 KB，远低于 512 KB 上限） |
| 设备 | **1**（`ssh-batch`，26 局历史远端局回填而来，见上「口径说明」；其余归档都不带设备 id，`device_id` 为 NULL。2026-10-03 收口批起远端 worker 自己带 `ssh-batch`，此后新跑的远端轮次会直接挂上这个设备行） |
| 一致性 | `game_uid` 去重后 310、孤儿 `game_moves` 0 行；`game_moves` 里 `v13-pressure-gate` 2282 手、`v14-live3-fresh` 3006 手、`v10-live3` 1186 手、`v11-vct` 983 手、`v9-vcf-sound` 1104 手、`v8-vcf-try` 765 手、`v12-vct-def` 800 手、`v0-off` 17 手、无声明 9106 手（= Rapfi/人类侧、历史导入与远端批量的 rapfi/random 侧），各组手数分别等于对应臂的 Jev 侧手数合计（与脚本统计交叉一致；九类相加 = 19249 手）。⚠️ 远端批量三轮（+1664 手）的 games JSON 是 trimmed 形式（moves 只有 ply/side/notation），其逐手明细只在 D1 `game_moves` 表里 |

- **真实验（2026-10-01，proxy 渠道，4 局全和棋）**：`node scripts/experiment-run.mjs --games 4` 跑满
  A=`proxy/v9-vcf-sound` vs B=`proxy/v8-vcf-try`，902 次上游调用 / 输入 2586521 token / 输出 438798 token /
  约 $0.109 / 用时 1854 s，逐局落库 4 行（`tokens_in` 约 645K、`cost_usd` 约 $0.0272、`latency_avg_ms` 930–1056）。
  四局**全部 225 手「和棋（棋盘已满）」**：两个战术档在这套开局下都攻不穿对方，A/B 无胜负差。
  证据 `.work/experiment-run-2.json`（不入库）。同一批负载在旧 30/分 限流下会死在第 1 局，这次窗口峰值 34/分、**零 429**。

- **战术 v10 对照实验（2026-10-02，A=proxy 战术档 vs B=`rapfi@500ms`，两臂各 12 局）**：
  `v10-live3` **6 胜 4 和 2 负（得分率 67%，执黑 4 胜 2 负 / 执白 2 胜 4 和 0 负）**，
  同条件 `v9-vcf-sound` **3 胜 0 和 9 负（25%）**；两臂平均手数 55 → 98。
  机制证据独立于局分：v10 的 live3 两层 12 局共接管 **168 手**（`live3Attack` 120 / `live3Defense` 48），
  v9 同批对手 **0 次**（它没有这一层）。**4 局探路曾给出「两臂差不多」的假象**（v9 2 胜 2 负 / v10 3 胜 1 负），
  补到 8 局后 v9 掉到 1 胜 7 负 —— 12 局/臂仍只够方向性结论。
  上游峰值 19 次/分（限 60）、全程 200 零 429；12 局里有 4 局 225 手满盘和棋（都是 v10 执白）⇒ 防守补上了、胜势还转不成胜。
  证据 `.work/exp-arm{1,2,3,4}-*.json` 与 `.work/arm-stats.mjs`（都不入库）。

- **战术 v11 对照实验（2026-10-02，A=proxy `v11-vct` vs B=`rapfi@500ms`，单臂 12 局）**：
  `v11-vct` **10 胜 0 和 2 负（得分率 83%，执黑 5 胜 1 负 / 执白 5 胜 1 负）**；
  同对手同开局的三臂是 **25%（v9）→ 67%（v10，含 4 和）→ 83%（v11，零和）**，平均手数 98 → **34**
  —— v10 那 4 局 225 手满盘和棋被转成了胜局。逐手机制证据：v11 侧 206 手（= 本轮 206 次上游调用），
  新层 `vctAttack` 接管 **62 手**（执黑 31 / 执白 31；v10 臂上此层不存在），v10 的活三两层降到 22 / 6 手。
  上游峰值 ~17 次/分（限 60），全程 200 零 429；用时 724 s。证据 `.work/exp-arm5-v11.json` 与
  `.work/exp-arm5-v11.log`，逐手复盘 `.work/v11-postmortem.mjs`（都不入库）。
  第一次尝试卡在 0/12：Rapfi 局中现抓 10 MB 引擎资产在本机链路上要 447 s（≈22 KB/s），
  抓失败抛出的 rejection 没人接住 ⇒ 工具链改为本地供给资产（`3bf480b`，被测行为不变）。

- **v10 直连 v11（2026-10-02，两侧同渠道同模型 `proxy`，唯一变量是战术档，12 局黑白交替）**：
  `v11-vct` **5 胜 4 和 3 负（得分率 58.3% · 不败率 75.0%；执黑 3 胜 3 和 0 负 / 执白 2 胜 1 和 3 负）**，
  `v10-live3` **3 胜 4 和 5 负（41.7% · 不败率 58.3%；执黑 3 胜 1 和 2 负 / 执白 0 胜 3 和 3 负）**。
  两侧执黑战绩几乎相同（都是 3 胜），**净胜来自白方**：v11 被让先时也能赢，v10 执白一胜未得。
  4 局和棋**全是 225 手满盘**，而 v11 的胜局都短（19 / 22 / 23 / 29 / 56 手）⇒ 同门对局的和棋来自
  「两侧都算不出强制胜」，不是 v11 的风格（对照它打 `rapfi@500ms` 的零和棋）。
  逐手接管：v11 侧 602 手里 `vctAttack` **15 手**（v10 侧此层不存在）、`parry4` 73、`live3Defense` 71；
  v10 侧 600 手里 `parry4` 87、`live3Defense` 78、`live3Attack` 25 —— 两侧 `parry4` 合计 **160 手**，
  被动挨打的回合远多于主动起链的回合，印证「入口在无强制胜时的防守与取势」。
  上游 1311 次调用（in 3,570,328 / out 595,344 tok），109 次状态 0 的传输错误全被重试成 200（≈8%）、零 429，
  用时 5540 s。证据 `.work/exp-v10-vs-v11.json`、`.work/exp-v10-vs-v11.log`、
  `.work/duel-v10-vs-v11.mjs`（按战术档分侧出报告，都不入库）。

- **战术 v11 计时轮（2026-10-02，A=proxy `v11-vct` vs B=`rapfi@500ms`，12 局，`tac_ms` 上线后首轮）**：
  `v11-vct` **9 胜 0 和 3 负（得分率 = 不败率 75.0%，12 局零和棋，平均 29 手）**，与上一轮同口径的 83%
  同量级（两负/三负的局面都算不出强制胜，见下）。**成本第一次被拆开**：本轮 347 手里 v11 侧 175 手有样本，
  `game_moves.ms` 均值 **8730 ms**（最坏 43423 ms，38 手 >5 s）中，战术层 `tac_ms` 均值 **402 ms** /
  最坏 4474 ms ⇒ **战术层约占单步墙钟 4.6%**，其余 95% 是模型往返与重试等待；**对手 Rapfi 的固定预算
  500 ms/手** ⇒ v11 的棋力增量不是靠更大的搜索预算换来的。逐手复盘（`.work/v11-postmortem.mjs --tag`）：
  175 个 v11 回合里 **72 手（41%）存在必胜链、69 手走了链首步、机会真丢 0 手**；**3 局负局全程 0 次报出必胜链**。
  上游 213 次调用、38 次状态 0 的传输错误全被重试成 200、零 429，用时 1966 s。证据
  `.work/exp-arm6-v11-tacms.json` / `.log`、`.work/postmortem-r6.log`（都不入库）。

- **战术 v12 对照实验（2026-10-02，A=proxy `v12-vct-def` vs B=`rapfi@500ms`，单臂 12 局，tag `exp-20261002115126`）**：
  `v12-vct-def` **12 胜 0 和 0 负（得分率 = 不败率 100%，执黑 6 胜 0 负 / 执白 6 胜 0 负，平均 33 手）**；
  同一对手同一开局的逐版曲线是 **25%（v9）→ 67%（v10）→ 83% / 75%（v11）→ 100%（v12）**，用时 689 s、
  上游 199 次调用（in 553,837 / out 108,369 tok，1 次状态 0 传输错误已重试、零 429）。
  **但必须如实标注：本版新增的 `vctDefense` 这一轮 0 次开火** —— 198 个 Jev 回合里我方有必胜链 78 手、
  对手有链的防守机会 42 手，实走 **42/42 全拆掉**（真救 0、拆不掉 0），全部由既有层
  （`vcfDefense` 15 / `block` 12 / `parry4` 3 …）完成 ⇒ 这个 12-0 是攻击层（`vctAttack` 38 + `vcfAttack` 28）
  与老防守层打出来的；`vctDefense` 的实证仍是离线回归扫描的 3 个真救（983 回合）与 `test/engines/tactics.test.mjs` ⑤d 夹具。
  **成本**：198 个样本里 `tac_ms` 中位 **241 ms** / 均值 **381 ms** / p90 896 ms / 最坏 **4161 ms**，
  单步墙钟中位 743 ms / 均值 1029 ms、扣掉战术层的模型往返中位 400 ms ⇒ **战术层占单步均值 37.0%**
  （占比远高于计时轮的 4.6%，原因是本轮上游极快而非战术层变慢：均值 402 → 381 ms）。Rapfi 仍是固定 500 ms/手。
  证据 `.work/exp-arm7-v12.json` / `.log`、`.work/arm-v12-report.mjs`、`.work/v12-round-postmortem.mjs`（都不入库）。

- **抬高 Rapfi 思考档后的两轮（2026-10-02，A 仍是 proxy `v12-vct-def`，同一开局面）**：
  `rapfi@1000ms`（tag `exp-20261002121700`）**10 胜 0 和 2 负（得分率 = 不败率 83.3%，执黑 6-0-0 / 执白 4-0-2，平均 40 手）**，
  用时 968 s、上游 239 次（in 680,605 / out 131,833 tok、零 HTTP 错），12 局 `code_version` 全为 `1.0.0+472e228`；
  `rapfi@2000ms`（tag `exp-20261002123631`）**7 胜 1 和 4 负（得分率 62.5% / 不败率 66.7%，执黑 4-0-2 / 执白 3-1-2，平均 60 手）**，
  用时 1750 s、上游 364 次（in 1,081,638 / out 196,012 tok、1 次状态 0 已重试、零 429）。
  ⇒ 同一开局的逐版曲线在 **500 ms 档**是 25%（v9）→ 67%（v10）→ 83% / 75%（v11）→ **100%（v12）**，**抬档后回落**为 83.3% → 62.5%，
  且 2 s 档首次出现 **225 手满盘和棋**（`321ef19d`，v10 时代那种「谁也没织穿」的形态在更强对手下回来了；那局 19 个防守机会全被拆掉，`vctDefense` 0 次）。
  **两轮的 `vctDefense` 各产生 1 次拆点**：1 s 轮它给了点但我们走了别的点（实走也把链拆掉了），2 s 轮实走**就是**它给的点（`实走即拆点 1`）且链确实被拆掉 ——
  但两轮 **真救都是 0**，即从未出现「不靠它就会输」的回合；两轮「拆不掉」合计 9 + 14 手，逐条都是**全盘没有拆点**（点无回头路）。
  **六局负局（1 s 轮的 `17726449` / `530ce77b`，2 s 轮的 `606b97f0` / `598212f7` / `faeb874a` / `4bca1573`）全程「我方有杀 0」**
  ⇒ 五轮 rapfi 对照是同一结构：**输在「算不出强制胜，且早晚被对手织成网」，不是漏防**；下一版的强度杠杆因此是**预防**
  （压力闸门：对手造四点数压过我们时别抢自己的活三），而不是继续加深 VCT —— 继续加深搜索也不符合「战术层不吃搜索」约束。
  **成本**（逐手，Jev 侧样本）：1 s 轮 n=239，`tac_ms` 中位 285 / 均值 695 / p90 1300 / 最坏 **6843 ms**，单步墙钟中位 967 / 均值 1347 ms
  ⇒ 战术层占单步均值 **51.6%**（逐手平均比例 36.9%）；2 s 轮 n=363，`tac_ms` 中位 257 / 均值 815 / p90 2910 / 最坏 **5362 ms**，
  单步墙钟中位 930 / 均值 1509 / p90 3604 / 最坏 **36206 ms** ⇒ 占单步均值 **54.0%**（逐手平均比例 38.5%，逐手超一半的 140 手）。
  对手是固定 1000 / 2000 ms 一手；**占比升高是因为对局变长、上游本身更快**（模型往返中位 425 / 403 ms），不是战术层变慢。
  证据 `.work/exp-arm8-v12-rapfi1000.json` / `.log`、`.work/exp-arm9-v12-rapfi2000.json` / `.log`、`.work/exp-arm8-stats.json`、`.work/exp-arm9-stats.json`（都不入库）。

- **战术 v13 `v13-pressure-gate`「压力闸门」（2026-10-03 对照实验已跑完：机制有效但不是瓶颈，保留不加码）**：
  六轮 rapfi 对照共 **1787 个 Jev 回合**的离线复算（`.work/v13-pressure-probe.mjs`）显示：归档标签 `live3Attack`
  的实走 **205 手（11.5%）**，其中 **39 手（19.0%）落子前对手的「做四点」数已超过我们**，
  而这 39 手实走之后**对手仍握双四威胁（≥2 个做四点）的 37 手**；改用「贴着对手做四点削」的点集，
  **37/39 更优、0 更差、平均 −1.87 个、双四威胁 37 → 7**。机制（[ADR-0017](adr/0017-pressure-gate.md)）：
  引擎新增 `fourPressure`（双方做四手数）与 `pressureCut`（1-ply 削点，候选序 = 模型候选 → 对手做四点
  车氏 ≤2 邻域 → 其余邻近空点，上限 120）；战术层产出 `pressure_you` / `pressure_opponent` /
  `pressure_cut_points`，接管链在 `vctDefense` 与 `live3Attack` 之间插 `pressureGate` 成**十四级**，
  开火四条 = 版本闸门 + 有削点 + 压力落后 + 对手无 danger 点。
   **对照实验**（tag `exp-20261002160819`，`rapfi@1000ms`，用时 3450 s，上游 335 次
   in 805,491 / out 148,874 tok、HTTP 错 66 次全重试成功、页面错误 0）：
   **9 胜 0 和 3 负（75.0% / 不败率 75.0%，执黑 4-0-2 / 执白 5-0-1，平均 45 手）**，
   对比 v12 同档 **10 胜 0 和 2 负（83.3%，平均 40 手）** ⇒ **一局之差在 12 局样本里是噪声，比分口径无效**。
   **决定性证据是接管标签 × 局结果的交叉表**（`.work/v13-vs-v12-turns.mjs`）：
   `vctAttack` / `open4` / `win` / `vcfAttack` 四个进攻类层在 **9 个胜局合计命中 79 手、
   3 个输局命中 0 手**，三局负局的「我方有杀」全为 0 ⇒ **输在「赢不了」而非「防不住」**，
   而 v13 是纯防守机制，结构上治不了。v13 自身开火 14 手（8 胜局 8 手 / 3 负局 6 手），
   把对手做四手数确实压下去了但**没有一手换来翻盘** ⇒ **保留、不再加码，下一版转向进攻侧**。
   进攻探针（`.work/v14-attack-probe.mjs`）排除漏杀：漏杀仅 2 手且都在终局、「有造杀点没走」= 0。
   **成本**：`tac_ms` 中位 230 / 均值 498 / p90 1027 / 最坏 6046 ms；
   ⚠️ 本轮重试多，模型往返均值 9595 ms 把「战术层占单步」稀释到 **4.9%**（v12 同档 51.6%）——
   **该占比不可跨轮比较**。
   **20 局档位复核（2026-10-03，用户要求各 20 轮）**：`rapfi@1000ms` 20 局
   （tag `exp-20261003003108`，937 手，484 次上游、99 次状态 0 错误全重试）
   **11 胜 1 和 8 负（57.5% / 不败率 60.0%，执黑 6-0-4 / 执白 5-1-4，平均 47 手）**；
   `rapfi@2000ms` 20 局（tag `exp-20261003020720`，1193 手，0 次传输错误、约 2 分钟/局）
   **13 胜 2 和 5 负（70.0% / 75.0%，执黑 8-0-2 / 执白 5-2-3，平均 60 手，两局 225 手和棋）**。
   本档同档合并（`.work/exp-v13-1000-pooled.json`，两个 1000ms 轮）＝ **32 局 20 胜 1 和 11 负（64.1%）**。
   ⚠️ **同档两轮差 17.5 个百分点（12 局 75.0% → 20 局 57.5%），大于两档之间的差**
   ⇒ 比分由上游采样方差主导，加局数分辨不出档位效应；能分辨的是机制层（见下方复盘）。
   两轮成本：`tac_ms` 中位 240 / 262、均值 661 / 685、最坏 5961 / 7090 ms（两轮一致）；
   战术层占单步 6.9% vs 59.7% —— **差的是上游**（往返均值 8854 vs 462 ms；前者有 99 次传输错误），**不可跨轮比较**。
   两轮逐手复盘（`.work/v12-round-postmortem.mjs`）：1000ms 轮 469 回合 / 我方有杀 82 / 防守机会 124 / 开火 1 / 拆掉 100 /
   **真救 0 / 拆不掉 24**；2000ms 轮 598 / 114 / 147 / 2 / 131 / **真救 0 / 拆不掉 16** ——
   **两轮 40 个「拆不掉」回合全是「全盘没有拆点」**（已经输了的局面）。
   证据 `.work/exp-arm11-v13-1000-20.json` / `.log`、`.work/exp-arm12-v13-2000-20.json` / `.log`、
   `.work/round1-report.log` / `.work/round2-report.log`、`.work/exp-arm11-v13-1000-20-stats.json` /
   `.work/exp-arm12-v13-2000-20-stats.json`（都不入库）。
  **回归扫描**（`.work/v13-cut-check.mjs`，三个 v12 回合共 **800 个 Jev 回合**）分层口径：
   条件满足 78 手（9.8%）→ 闸门真接管 26 手（3.3%）→ 真接管且改走 20 手（2.5%），
   改走率随对手变强而升（500 ms 档 5/7 → 1 s 档 6/6 → 2 s 档 9/13）；
   被更高层挡住 52 手（**优先级正确，不是漏杀**）；`pressureCut` 均值 **3.2 ms** / 中位 3.3 / 最坏 6.1 ms。
   **代价**：26 个真接管回合里我们自己的做四手数平均 **−1.92 个**、13 手让掉攻势 ——
   A/B 已回答「12 局里分不出胜负」，但代价真实存在。
   证据 `.work/exp-arm10-v13-rapfi1000.json` / `exp-arm10-v13-rapfi1000b.log`、
   `.work/exp-arm10-stats.json` / `exp-arm10-stats.log`、`.work/v13-postmortem.log`、
   `.work/v13-vs-v12-turns.log`、`.work/v14-attack-probe.log`、`.work/v13-cut-check.log`（都不入库）。

- **战术 v14 证据评审（2026-10-03，机制随后选定为 v14-live3-fresh）**：入口是「v13 判定输在赢不了」⇒ 转向进攻侧。
  16 个离线探针（只重放归档，无新对局）的稳健负结论：负局**全程没有强制胜链**（放宽预算后 111 回合
  仍 100% 无链，耗时均值反而 2093 ms）、**不是漏防**（必挡点漏防 0/15）、**不是漏杀**（漏杀 2 手全在终局
  实走 `win`）、**不是送活三**（负局 0.0%，抢活三被拆率胜 43.8% > 负 20.0%）、**不是赛跑口径**（两侧 0.0%）。
  两个领跑候选被否：`maxRun`「织网」被自己的准入判据否（负局占比 25.4% **低于**胜局 54.9%，方向相反）；
  「抢活三前先验对手应手」被本次审查的两个对照否（**16/16 的「必带链」负局回合在根局面对手就已经有链，
  且实走全是防守层、没有一手抢活三**；实走的 29 手活三在对手应手后出现链 = **0/29**）⇒
  下一版入口仍开放，第一个探针应是「对手链出现点 vs 我方形状里程碑」的对照。
  ⚠️ 负局只有 3 局 / 111 个 Jev 回合，`v14-shape-probe` 的「316/222 回合」是**双方手数**，与其余探针的
  Jev 回合口径不可互引。全文与证据清单见 [plans/2026-10-03-tactics-v14-evidence.md](plans/2026-10-03-tactics-v14-evidence.md)；
  证据 `.work/v14-*.log`、`.work/review-v14-control.log`、`.work/review-live3-gift.log`（都不入库）。

- **战术 v14 `v14-live3-fresh`（活三判据纠偏，2026-10-03，已上线 `b6c6921`，对照实验已完成）**：`live3After`
  自 v10 起漏了「新造」前提 ⇒ 本方已握 ≥2 个活四制造点时，**任何闲棋**都被判成「制造活三」。
  五轮 3864 个我方回合实测：引擎报点 18675 个里 **12676 个（67.9%）是幻影点**，整集皆假 16 回合（占非空 1.0%），
  纠正口径**零漏报**；用接管层标签分开「决策」与「事实」后：`live3Attack` 289 手 + `live3Defense` 122 手真接管
  **没有一手**落在幻影点上，78 手「实走落在幻影点」全部来自 `block`(36)/无接管(33)/`win`(9) ⇒
  **纠偏不改任何一手已发生的决策**，修的是 **212 手 / 5.5% 回合**给模型看的事实（其中 80 手模型自选、16 手整集皆假）。
  缺省口径不变（v0–v13 归因与回放逐字如一），成本中位 14 ms / 最坏 66 ms。
  **对照实验（2026-10-03，tag `exp-20261003035953`，单臂 12 局 vs `rapfi@1000ms`）**：**9 胜 1 和 2 负**
  （得分率 79.2% · 不败率 83.3%；执黑 5-0-1 / 执白 4-1-1），平均 52 手；两负在最前两局且**全程「我方有杀 0」**，
  防守机会里拆不掉的 3 / 6 手逐条都是「全盘没有拆点」⇒ 输在织网期（B 型长局）。战术层 `tac_ms`
  中位 **190** / 均值 **422** / 最坏 **6494 ms**，占单步均值 **46.2%**（Rapfi 固定 1000 ms/手，UI 上限 10 000 ms；
  占比不可跨轮比，v13 同档轮的 4.9% 差在上游的 66 次 HTTP 错）。**部署生效实证**：从归档记法独立重放 316 手，
  live3 两层接管 **60/60 落在纠正口径内**，事实面 **22 手 / 7.0%** 被修、点数 2481 → 972（幻影 60.8%）。
  计划与证据见 [plans/2026-10-03-tactics-v14-fresh-live3.md](plans/2026-10-03-tactics-v14-fresh-live3.md)、
  设计记录 [adr/0018-live3-fresh-correction.md](adr/0018-live3-fresh-correction.md)（修正 0014 的 L3 定义）。
  **抬高档位的第二轮（2026-10-03，tag `exp-20261003050139`，20 局 vs `rapfi@2000ms`，用时 3453 s、
  上游 760 次全 200 / HTTP 错 0）**：**9 胜 3 和 8 负（得分率 52.5% · 不败率 60.0%；执黑 5-3-2 / 执白 4-0-6）**，
  平均 76 手，三个和局全是 **225 ½手满盘互拆**；逐手接管 760 手 = 无接管 266 / `live3Attack` 99 / `block` 94 /
  `vcfDefense` 67 / `live3Defense` 66 / `vctAttack` 57 / `parry4` 34 / `pressureGate` 25 / `parry3` 17 /
  `open4` 9 / `win` 9 / `vcfAttack` 8 / `parry` 5 / `vctDefense` 4；`tac_ms` 中位 199 / 均值 627 / 最坏 6441 ms，
  占单步均值 53.3%。**规则 11 的败局交代**：760 回合我方有杀 74 / 防守机会 187 / 真救 0 / 拆不掉 **34 手逐条
  都是「全盘没有拆点」**；**8 个负局全部「我方有杀 0」**（同一失效模式）。链首现：胜局我方 9/9（13.6 ½手）、
  负局 3/8（74.7 ½手）、和局 0/3 而压力领先占比 66.4%。**档位抬到 2 s 后比分下降不等于变弱**（和局从 1 → 3、
  负局更长、失效模式相同），且 **跨档位比分同样不是曲线**（同档轮间方差 17.5 个百分点）。
  **抬档阶梯的第三、四轮（2026-10-03，同口径单臂各 20 局）**：`rapfi@3000ms`（tag `exp-20261003075310`，
  用时 2089 s、上游 443 次全 200 / 错 0）**15 胜 1 和 4 负（得分率 77.5% · 不败率 80.0%；执黑 8-0-2 / 执白 7-1-2）**，
  平均 44 手，接管 443 手 = 无接管 128 / `vctAttack` 94 / `live3Attack` 60 / `block` 32 / `vcfDefense` 31 /
  `live3Defense` 24 / `pressureGate` 18 / `win` 15 / `open4` 14 / `vcfAttack` 12 / `parry4` 8 / `parry3` 4 /
  `parry` 2 / `vctDefense` 1，`tac_ms` 中位 247 / 均值 647 / 最坏 5850 ms、占单步均值 54.9%；
  `rapfi@5000ms`（tag `exp-20261003082805`，用时 2898 s、上游 496 次全 200 / 错 0）**12 胜 1 和 7 负
  （得分率 62.5% · 不败率 65.0%；执黑 8-0-2 / 执白 4-1-5）**，平均 50 手，接管 496 手 = 无接管 118 /
  `live3Attack` 71 / `vcfDefense` 70 / `vctAttack` 63 / `block` 58 / `live3Defense` 34 / `vcfAttack` 16 /
  `pressureGate` 15 / `parry4` 13 / `win` 12 / `open4` 11 / `parry3` 8 / `parry` 4 / `vctDefense` 3，
  `tac_ms` 中位 225 / 均值 792 / 最坏 6762 ms、占单步均值 57.7%；两轮 `black_think` / `white_think` 在 Rapfi
  侧落库 3000 / 5000、`proxy` 侧 NULL。**两轮合计的规则 11 败局交代**：939 回合我方有杀 210 / 防守机会 254 /
  `vctDefense` 开火 3 / 真救 **0** / 拆不掉 **44 手逐条「全盘没有拆点」**；**11 个负局全部「我方有杀 0」**；
  两个和局各 225 ½手、防守机会 17 / 29 **全数拆掉**。链首现：3 s 档胜局 15/15（15.9 ½手）、负局 3/4（38.3）、
  和局 0/1（领先 59.0%）；5 s 档胜局 12/12（24.0）、**负局只 2/7（27.0）、压力领先占比 31.7%**（更靠近 A 型）、
  和局 1/1（101.0、领先 72.0%）⇒ **分型第五、六次复现，没有新失效模式**。
  **四档阶梯（1000 / 2000 / 3000 / 5000 ms）= 79.2% / 52.5% / 77.5% / 62.5%，非单调** ——
  **跨档位比分不是曲线第三次被实测确认**，同档轮间方差（17.5 pt）大于任何档位差 ⇒ 下一步只能上配对样本。

- **SSH 远端批量实验设施（2026-10-03 合入 main，ADR-0019）**：新工具 `scripts/experiment-batch.mjs`
  （本地编排 submit/resume/status/pull/elo，远端 worker 纯 Node 跑对弈回路、nohup 脱离 ssh、
  文件 checkpoint 支持 kill -9 续跑）在空闲主机 `qijia`（185.242.234.48）上完成两轮：
  - `rapfi@500ms` vs `random/v13` ×12（tag `exp-20261003042812-rapfi1-r1`，约 52s/局）：
    **各 6 胜 0 和 6 负**（黑方视角 4-0-2 与 4-0-2 镜像），Elo（K=16，身份 `rapfi|-|500`）
    **1503.1** vs（`random|v13-pressure-gate|0`）**1496.9** ⇒ 12 局内无差异，⚠<50 局只作相对参考。
  - `proxy/v13` vs `random/v13` ×2 真上游冒烟（tag `exp-20261003052056-smoke1-r1`）：
    2/2 归档成功（archivedId 269/270，GET `?tag=` 核对 verified=true），winner=black(41 手)/white(66 手)。
  - **Node rapfi 臂与浏览器同资产同输入逐手一致**（自对弈 12/12、重放归档局 12/12）；
    对浏览器归档逐手 85.9% 的残差经 Node↔Edge 双向重放定位为**浏览器运行时墙钟抖动**
    （不一致手上 Edge 与 Node 给出相同着法、都不等于归档）⇒ rapfi 臂绝对着法不可逐字复现，
    实验结论只认聚合口径。
  - 轮末补写 `/api/experiments` 行（形状对齐浏览器 `newEntryFromRun`），远端轮次计入「实验轮」统计；
    已跑的两轮（rapfi1/smoke1）已用一次性脚本补归档，GET `/api/experiments` 可见
    （`total` 12 / 2，games[] 按局黑白交替）。**数据卫生（2026-10-03 收口批）**：前三轮跑在修复之前
    ⇒ 那 26 局的 `device_id` 为 NULL、`code_version` 只写 `dev+nogit`；此后 worker 会带稳定的匿名身份
    `X-Device-Id: ssh-batch`（可用 `BATCH_DEVICE_ID` 覆盖，值域同 `DEVICE_ID_RE`）并把提交自报进
    `meta.code`（`dev+nogit+<sha>`）⇒ 远端轮次在 D1 里能单独筛出来（`device_id='ssh-batch'`）；
    要彻底隔离写入就换 `--origin` 指到另一个 Worker / D1。
  - **追加第三轮 x1**：`proxy/v13` vs `rapfi@500ms` ×12（tag `exp-20261003052604-x1-r1`），
    12/12 ok（约 100s/局，含 429 退避），**合并三轮 26 局**的 Elo（K=16，和棋 0.5）：
    `proxy|v13-pressure-gate|0` **1551.9**（14 局 10胜2和2负）> `rapfi|-|0` 1503.1（12 局 6-0-6）
    > `random|v13-pressure-gate|0` 1481.4（14 局 6-0-8）> `rapfi|-|500` 1463.6（12 局 2胜2和8负）
    ⇒ **proxy·v13 对 rapfi@500ms 合计 6 胜 2 和 4 负**（x1 12 局口径），全部 ⚠<50 局。
    x1 用的是补行能力上线前的旧代码 ⇒ experiments 行由 `.work/backfill-experiments.mjs` 事后补（HTTP 200）。
  - **Elo 丢和棋缺陷已修**：和棋在导出/D1 口径里**没有 `winner` 字段**（`result:"和棋（棋盘已满）"`，
    `record-map.ts:251-258` 的 `parseResult()` 给 `winner:null`），`batch-elo.mjs` 原先只认
    `winner==='draw'` ⇒ x1 两局 225 手满盘和棋被当「未终局」整局丢掉（Elo 只算 22/24 局、
    和棋列全 0）。改为按 result 串判和棋（与 parseResult 同形正则）——铁律 11 落实：胜/和/负同报。
  - 产物 `.work/remote/<batch>/`（plan/checkpoint/games/round-summary）不入库；工具自身
    **57 例单测**（`npm run test:scripts`，含 P0 两道闸门 7 例与 Wilson 区间 6 例）+ 全量 `npm test` **399 例 / 38 文件** / `tsc --noEmit` 干净。
  **合入时的审查（独立子代理，只读）**：设施方向与密钥纪律无问题、`src/**` 零改动、38 例单测真绿；
  但报了 5 条合并阻断项（`think=0` 越权写、`--rounds>1` 并发起 worker、续跑 skipped 计 0 + `resume` 缺 key 注入、
  `batchId` 同日撞车 + checkpoint 不比 tag、归档阶段无重试/超时/非幂等）⇒ **已在合入后同一批修掉**；
  整改细节与「轮次串行 / 续跑回读胜负 / 归档前落 pending+uid / `--origin` / 远端 `repoHead` 归因」等 3 条建议项见
  [2026-10-03-remote-batch-experiments.md](plans/2026-10-03-remote-batch-experiments.md) §P6 与
  [ADR-0019](adr/0019-remote-batch-experiments.md)「合入 main 后的整改」。

- **战术层耗时口径（2026-10-02 起）**：`game_moves.tac_ms` 与 `games.tac_avg_ms` / `tac_max_ms`
  单独记 `computeTactics` + `pickSafestParry` 的耗时（`game_moves.ms` 是「战术 + 上游」总耗时，
  两个口径不要混读）。**Rapfi / mock 不过战术层，记 NULL 而不是 0**，所以 `AVG(tac_ms)` 的样本天然只剩 Jev 侧；
  本列由追加迁移 [`migrations/0002_tactics_timing.sql`](../migrations/0002_tactics_timing.sql) 引入，
  已应用到本地与远程 D1。**前 13 轮实验都是旧产物、没有这一列**（那是实测值缺失，不是 0）；
  已有样本的是计时轮（v11 侧 175 手，战术层均值 402 ms / 最坏 4474 ms）与 v12 的三轮
  （500 ms 轮 198 手均值 381 / 最坏 4161、1 s 轮 239 手均值 695 / 最坏 6843、2 s 轮 363 手均值 815 / 最坏 5362 ms），报告面板的「战术」列与轮次注脚会给战术层均值，
  playbooks §7 有取证 SQL。
- **候选点三数口径（2026-10-03 起，C0）**：逐手 `game_moves.cands`（历史列：模型给了概率且合法的点数）、
  `cands_sent`（**交给 Jev 决定的点数** = criteria 键数）、`cands_labeled`（其中带战术标签的点数）；
  后两列由追加迁移 [`migrations/0003_move_cands.sql`](../migrations/0003_move_cands.sql) 引入。
  与 `tac_ms` 同纪律：**Rapfi / mock / 人类侧根本不过 Jev 候选集，记 NULL 而不是 0**（写 0 会把均值拉低），
  0003 之前的老归档也全是 NULL（**缺失 ≠ 0**）。游戏级汇总写在 payload 的 `meta.candStats`
  （`{graded, sent, labeled, n}`，无样本整键省略，保持往返一致性），报告面板给按手加权的「发 / 评 / 标」均值、
  分桶表新列「候选发评标」（非 Jev 身份 `—`）与轮次注脚「候选点均值 发 X」；实现与验证见
  [plans/2026-10-03-cands-metric-and-provider-failover.md](plans/2026-10-03-cands-metric-and-provider-failover.md) §4.1。
- 源归档 [games/](../games) **冻结只读**：它是金样、对账与归因用例的源数据，不再写入（说明见 [games/README.md](../games/README.md)）。
- 迁移期导入 SQL 在 [migrations/import/](../migrations/import)（`manifest.json` + `0001_games.sql`）。
- 一次线上导出的快照留在 `backups/export.sql`（`npm run db:export` 的产物，1.9 MB / 7 张表，含 wrangler 的 `d1_migrations` 记账表；`backups/` 不入库，需要时重新导出）。

## 已验证（验收证据）

- **报表新增「版本 × 共同对手」矩阵 = 版本排序的第二把尺子（2026-10-05）**：`scripts/lib/report.mjs` 的
  `versionMatrix()` / `versionMatrixBlock()`（印在 §4 配对表之后、逐色格之前）；行 = `official|v*`，列 = ≥2 个版本都打过的
  非版本对手（Rapfi 各档按思考时间升序在前；只被 1 个版本打过的对手单列一行），格 = **版本视角**得分率 + Wilson，
  末列 = 对上述对手的合并。判读**逐对看差值符号**：非零差值同号 ⇒ 判据 ② 通过；差值为 0 = 「并列档」（不给序、不算翻转）；
  全平 = 「不可分」；反向 = 点名翻转对与档位。初版按整条序字符串比对 ⇒ 各对手上可出场的版本集合不同（2 元序 vs 5 元序）
  会判出**假的不一致**，已改成逐对方向（教训入 MEMORY）。
  实测 `node scripts/experiment-report.mjs --dir .work/remote/l2n1,.work/remote/vorder1,.work/remote/rapfihi1 --out .work/merged-vm.md --json .work/merged-vm.json --quiet`
  ⇒ `✓ l2n1+vorder1+rapfihi1：460 局 / 10 身份 / 23 对｜兜底手 0 / 上游手 18649`；读数：唯一在**全部 5 个档位**同向的
  版本对是 `v11 > v10`（`@500` +2.5 → `@10000` +50.0 pt；100 局合并 75.5% vs 57.5%，Wilson 不重叠），
  `v12 > v13`（三个低档）、`v14 ≥ v13`（含一个并列档）方向一致，其余 8 对全部翻转 ⇒ **仍排不出全序**；
  单测 `test/scripts/report.spec.mjs` 加 5 例（累计 **43 例** / 656 行）。
- **合并报表的标题与默认产物名不再只剩第一批（2026-10-05）**：`--dir a,b` 合并多批时 `batchId` 原取 `dirs[0]`
  ⇒ 标题写成「阶梯报告：l2n1」、默认落盘 `.work/l2n1-report.md` 会**覆盖**单批报表。现在
  `scripts/experiment-report.mjs` 用 `dirs.map(path.basename).join('+')` ⇒ 实测
  `node scripts/experiment-report.mjs --dir .work/remote/l2n1,.work/remote/vorder1,.work/remote/rapfihi1 …`
  自报 `✓ l2n1+vorder1+rapfihi1：380 局 / 9 身份 / 19 对｜兜底手 0 / 上游手 16213`、标题 `# 阶梯报告：l2n1+vorder1+rapfihi1`；
  `test/scripts/report.spec.mjs` 新增 1 例钉住 `batchId` 与 `dirs`（该文件现 **561 行 / 37 例**）。
- **上游兜底在本机复现一次（2026-10-05，提交 `8c612b2`）**：`c2fb2` 的 box 验收之外，用**坏主 key + 真兜底 key**
  在开发机再跑一遍（两臂皆 `official`，本机没有 Rapfi 二进制）：
  `node scripts/experiment-worker.mjs --plan .work/c2e2-plan.json --store local --upstream direct --key-file .work/bad-key.txt --backup-key-file .work/cc-key.txt --expect-backup --rate-limit 30`
  ⇒ `2/2 局正常`；两局**第 1 手**即 `HTTP 401：key 或额度（不重试，直接切）` ⇒ 探活 `HTTP 200`（478/166 ms）
  ⇒ 切到 `backup`，game-2 收尾 `provider[backup:55]`、`events.jsonl` 两条 `kind:"provider"`，`--store local` 零 CF 触碰；
  报表同口径可辨（`--dir .work/remote/c2e2` ⇒ `兜底手 280 / 上游手 280`，逐身份提供方列全 `backup`、零 `primary`）。
  **运维要点**：直连路径的开关是**兜底 key 文件**（不是环境变量）——`resolveRunKey` 环境变量优先、其次 key 文件，
  缺兜底 key 时静默不切换（只有 `--expect-backup` 才退码 2）；阶梯的 `--key-file`/`--backup-key-file` 是**远端**路径
  （`launchRoundCommand` 在远端 shell `source`），本机复现只能直接跑 worker。
- **败局解释固化成工具（规则 11 可复算）（2026-10-05）**：新增 `scripts/lib/loss-report.mjs`（纯核：
  `fatalSuffix()` 取**最长必败后缀**、`lossShape()` 归纳形态与追因、`formatLossMarkdown()` 强制印边界句）
  + `scripts/loss-report.mjs`（CLI：`--dir/--batch/--ours/--theirs/--tail/--plies/--max-games/--no-vcf/--show/--json/--quiet`、
  `--mirror` 让同门对局两侧各出一个视角）+ `test/scripts/loss-report.spec.mjs`（**28 例**：纯核 21 + CLI 7 —— 退出码、`--mirror` 计数与跳过、`--max-games` 截断）。
  实测复算 L2：`node scripts/loss-report.mjs --batch l2n1` ⇒ 300 局 = 234/17/49、不败率 83.7%、
  ≤40 手短败 20/49、必败后缀 0/3/7/4 + 查不到 35、不可逆点 14/49（`--plies 9`；`--plies 7` 是 13/49）。
  实测复算 `vorder1`：`--mirror` ⇒ 120 个视角 = 31/58/31、不败率 74.2%、短败 16/31（51.6%）、
  **必杀后缀只有 3/31（9.7%，L2 是 28.6%）** —— 同门对局的败局更少能用「对手已成 VCF」解释。
  两条纪律入 MEMORY：**探针数字随窗口参数变（引用必须带 `--plies` 档位）**、`vcfWin()` 返回对象（`!!` 恒真）。
- **L2 败局解释：49 局败局的形态与追因（2026-10-05，规则 11 口径）**：一次性探针（不入库，`.work/loss-{analysis,horizon,point}.mjs`
  ⇒ `.work/loss-analysis.txt` / `loss-horizon3.txt` / `loss-point.txt`）。① 形态：**49 局败局最后一手全是 `block`、
  全部被对手五连终局**（无认输、无盘满而败）；手数三形态分明 —— 胜局均 29–39 手、**17 局和棋全是 225 手满盘**、
  败局 25–118 手（`v13@2000` 的 9 局败里 4 局 ≤38 手）。② 追因（逐手 `vcfWin(st, 对手, 7|9)`，`sound` 缺省健全）：
  **14/49 局**在我方最后 6 手里有 ≤9 手必杀后缀、**13/49 局**能定位不可逆点（21–92 手，均 59.4），
  **其余 35 局连 ≤9 手 VCF 都查不到** ⇒ **VCF 只解释 13/49**，剩下的要 VCT 级探针（列为下一步，不硬凑结论）；
  探针里能看到「VCF 出现又被堵掉」的局（`17· 19· 21· 23· 25✗ 27·`）⇒ 判据只能取「自此以后每步都仍必败」的最大后缀。
  ③ 五个版本的败局形态一致 ⇒ `v13@2000` 的 52.5% **只能记成速率差异**，不是新的失败模式。详见
  [plans/2026-10-04-l2-version-vs-rapfi.md](plans/2026-10-04-l2-version-vs-rapfi.md) §3.6 / §5 第 5 条。
- **版本排序筛查 `vorder1` 跑完：三版不可分（闭环）（2026-10-05）**：`--identities 'official:v13-pressure-gate:0,official:v11-vct:0,official:v14-live3-fresh:0' --games 20`
  ⇒ **3/3 轮 / 60 局 / 292 分钟 / 8014 个上游手全 `primary`（兜底 0、切换 0）**，W14-D29-L17（A 视角合计）。
  三对是 **v11 57.5% > v13 42.5%**、**v13 57.5% > v14 42.5%**、**v14 57.5% > v11 42.5%** ⇒ **闭环**，
  三个身份各 40 局**得分率全是 50.0%**、BT Elo 1487.4／1500／1512.6；和棋 29/60（48.3%）**全部是 225 手满盘和**。
  `screenVersions()` 三条判据全不中（① 有环 ② 三处反向 ③ `v11 vs v13` 执黑 75.0%／执白 40.0% 翻面）⇒
  判定「筛查不成立 ⇒ 按 §7 跑 L1」，而文档把算术摆开：L1 是 200 局 ≈15.5 h 而每对仍 20 局，**同样排不出名次** ⇒
  收敛为「A 接受不可分、把 box 时间投给 Rapfi 曲线（推荐）」或「B 只堆 `v11 vs v14` 100 局配对」。详见
  [plans/2026-10-05-vorder1-version-screening.md](plans/2026-10-05-vorder1-version-screening.md)。
  成本（m07650/m08110）：全轮 8014 手，模型往返 2047.5／1998／2043／18693 ms、战术层 413.3／279／766／18469 ms、
  单手合计 2460.8 ms、**战术占单手 16.8%**（L2 同两版是 26.8%／28.8% —— 同门对局是互守的阵地局面，重搜层开火少）。
  过棋谱回归（每轮抽样 2 局）：层一致 **155/155 = 100%**、接管落点 100/121 = 82.6%（与 L2 的 640/640、84.7% 同量级）。
- **报告第 4 节「按身份分开颜色」表改成「胜–和–负 + 得分率（与第 1 节同口径）」（2026-10-05）**：
  旧版印「总战绩 = 胜–非胜局」并把**胜率**标成「得分率」—— `vorder1` 实测把 v13 的 11 胜 18 和 11 负印成
  `11–29 / 27.5%`，而同一份报告第 1 节对同一身份的得分率是 50.0%（口径 =（胜 + 和/2）÷ 局数）。
  同一个词两个意思 + 把和棋算进「负」⇒ 和棋多的批次会被读成惨败。现在 `colorSplit()` 补 `blackDraws/whiteDraws`、
  表头写死 `胜–和–负 ｜ 得分率 ｜ 执黑 胜/局 ｜ 执白 胜/局`，单测钉住三行渲染。
  `scripts/lib/report.mjs` 现 **727 行**、`test/scripts/report.spec.mjs` **561 行 / 37 例**。

- **报告第 4 节新增「版本筛查判读」块：把 §7 的筛查规则机械化（2026-10-05）**：
  `scripts/lib/report.mjs` 新增 `screenVersions()`（`report.mjs` 现 718 行、`test/scripts/report.spec.mjs` 536 行 **36 例**），
  把「要不要补 L1」那条规则算成三句判据 + 一句判定印在配对表与逐色格之间：① 全序（Copeland 赢场数排序，逐三元组查环）；
  ② 共同对手一致性（直接比较 vs 经第三方的间接比较）；③ 逐色格是否换色翻面。全过 ⇒ `有值得决赛的差距 ⇒ 只补决赛对 X vs Y`，
  否则 ⇒ `筛查不成立 ⇒ 直接跑 L1`。只在**彼此真交过手**的 3–5 个 `official|v*` 身份上出现（整批只有「版本 vs Rapfi」
  的形态不印；混跑批次只按交过手的子集判 —— `l2n1` 真实 300 局复跑时抓到第一版会误印「只凑齐 0/10 对 ⇒ 直接跑 L1」）；
  判据 ② 在 3 版筛查里每对只有 1 个共同对手 ⇒ 退化为「间接与直接同向」，块内写了这条口径提示。
  真数据验证（`vorder1` 已拉回的 round-1 + 从 box 现拉的在跑 round-2，共 36 局 / 3 身份 / 2 对）：块正确渲染并写
  「只凑齐 2/3 对（版本之间没两两交过手）⇒ 筛查不成立，按 §7 直接跑 L1」——**单轮报表里这块不出现是正常的**
  （`vorder1` 三版分三轮跑，要等三轮齐了才读得出全序）。为什么机械化：n=20 的筛查本来就不许下强弱结论，
  三条判据靠肉眼在几张表之间来回看，迟早会滑向「先有结论再找证据」。
  同轮补的诚实护栏：第 1 节下方印一条「**得分率与胜负平是原始计数，对手集不同的身份之间不可横比**」（可比的只有
  `BT Δ` 与第 4 节配对样本）—— 触发它的是把 `l2n1` 与 `vorder1` 合成一份报告时的真实读数：`v12-vct-def` 84.2%（60 局全对 Rapfi）
  与 `v13-pressure-gate` 63.0%（100 局里 40 局在跟 v11/v14 打）并排看，很容易读成「v12 明显强于 v13」。
- **Rapfi 的节点预算：`INFO max_node <N>` 真的生效，「设不了」是误读（2026-10-04，计划 §9 第 2 条结案 + 改正）**：
  本机用**真引擎**跑一次性探针（同一份 `public/rapfi/rapfi-single-simd128.{js,wasm,data}`，**不抢 box 正在计时的
  Rapfi**）⇒ `INFO max_node N` 被静默接受且**按 N 单调生效**：同一 12 子中盘局面 + `INFO timeout_turn 3000` 实测
  `N=1 → 7ms／最深深度 0`、`100 → 3ms／8`、`1000 → 2ms／12`、`10000 → 26ms／19`、`100000 → 116ms／29`、
  `1000000 → 1087/1114ms／55`；`N=0`（不限）与 baseline 同为 `2631/2572ms／53`，着法全部同一手 `9,10`。
  合法参数名是 **`max_node` / `max_depth`**，而 `INFO nodes` / `INFO depth` 会被拒
  （`MESSAGE Unknown Info Parameter: NODES` / `…: DEPTH` + `ERROR Unknown command: <v>`）。
  ⇒ 同一天早先「节点数只能**读**（`show_detail 1` 的 `MESSAGE` 行）、不能**设** ⇒ 等节点数当不了控制变量」
  那条**作废**（它把阶梯计划 §2.1 探针 A 第 61 行读反了；探针 A 第 54/58/60 行早已实测 `max_node` 生效且
  固定预算可复现）。**未变的部分**：客户端仍只发 `INFO timeout_turn <ms>`（`src/core/jev/rapfi.ts:240`），
  在跑的阶梯按**时间档**计时 ⇒ **本轮不换协议**（换了等于换臂）；「等节点数」的公平对比技术上已可行，但要
  另开 preset + 给客户端加可选开关（规则 10：另开计划与 ADR 决定）。探针 `.work/rapfi-node-info-probe.mjs`、
  `.work/rapfi-maxnode-probe.mjs`（一次性，不入库，产物 `.work/rapfi-info-probe.json`、`.work/rapfi-maxnode-probe.json`）。
- **报告新增「收尾机制 + 接管层 × 结果」解释块（2026-10-04，`vorder1` round-1 之后）**：第 4 节内加
  `endReasons()`（收尾原因分布 + 和棋手数 + 全局手数分位）与 `layersByResult()`（每身份一行
  「接管层（开火次数；该层开火那几手的 胜/和/负）」）。这块是规则 11 的**解释性口径**（败局要解释、和棋可接受），
  **不参与判强**（判强只看 §1/§4），所以只作 §4 的子块、不打乱 §1–§6 编号。`vorder1` round-1 真数据读法：
  收尾 `五连 15 局 · 棋盘已满 5 局`，**和棋 5 局全是 225 手满盘**（不是协议和）；v11 `vctAttack 21（21/0/0）`、
  `open4 9（9/0/0）`（织出连续威胁就赢）、`live3Defense 123（29/69/25）`；v13 `block 46（4/7/35）`
  （被压着堵时 35/46 输）、`pressureGate 122（23/82/17）`（122 次里 82 次出现在和局）。层字段取
  `move.tactics || move.ai.tac`（**`ai.tv` 是战术版本，不是层**）。
- **采样参数探针：官方端点不接受任何冻结类字段（2026-10-04，计划 §9 第 1 条结案）**：新增只读探针
  `scripts/probe-model-params.mjs`（5 变体 × 4 次 + baseline × 10 次复现，`test/scripts/probe-model-params.spec.mjs` 19 例）。
  本机直连 `https://api.typesafe.ai/v1/systemone`，请求体 = 客户端真正发的 `{state, questions, model}` 三个字段
  （`src/core/jev/client.ts:208`）⇒ baseline **200**；`temperature: 0` / `seed: 1234` / 两者都给 / `top_p: 1`
  **四次全 400** `api_usage_error / Invalid request.` ⇒ **「冻结采样降方差」这条路关掉了**，5 pt 分辨率只能靠样本量，
  `--model-params` 开关不必做。附带读数：同一局面连打 10 次**着法 10/10 相同**（自报概率仍摆 ≤0.10，均 1262 ms）。
  产物 `.work/probe-model-params.json`、`.work/probe-model-params-repeat.json`。
- **报表的 Rapfi 曲线带「相邻档差 + 区间重叠」读数（2026-10-04，为 L4 铺路）**：第 2 节每行多一列
  **ΔElo（相对上一档）**，表下自动印相邻档差 + 重叠对数 + 每档样本；判据 = **相邻档 BT 区间重叠就不许说
  「这一档更强」**（与 §1/§4 同一条纪律）。纯函数 `curveDeltas()`（`scripts/lib/report.mjs` 523 行、
  `test/scripts/report.spec.mjs` 403 行 28 例）。`l2n1` 真数据复跑：500→1000 **不重叠**（+100.7）、
  1000→2000 **重叠**（+107.6）⇒「抬时间有收益」踏实、「每抬一档都更强」不能说。
- **`L4` 高思考档预设：把 Rapfi 曲线补到 UI 上限（2026-10-04，业主点名）**：业主原话「补 500ms，
  7000ms，到 10000ms」⇒ `scripts/lib/ladder.mjs` 新增 `RAPFI_HIGH_SPECS`（`@7000`/`@10000`，后者 = UI 上限）
  与预设 `L4`（`cross(VERSION_SPECS, RAPFI_HIGH_SPECS)` = **10 对 / 200 局**）；**只列 L2 没有的档**
  （`@500/@1000/@2000` 已各 100 局、分母配平），「两批右臂不重叠」由单测钉死（`test/scripts/ladder.spec.mjs` 55 例）。
  dry-run 实测：10 轮、逐轮 `@7000` ≈93 min / `@10000` ≈123 min、**合计 ≈18.0 h**；
  **2026-10-05 按 `l2n1` 真实手数复算 ⇒ ≈13–17 h**（口径见「下一步」② 与阶梯计划 §7 的校准条）。
  合并报表口径：一次读两批 —— `node scripts/experiment-report.mjs --dir .work/remote/l2n1,.work/remote/rapfihi1`（`--dir` 支持逗号分隔的多根，`gameUid` 全局去重、按身份聚合 ⇒ 5 档曲线一次出）。
- **上游兜底补上决策记录 ADR-0022（2026-10-04，文档轮）**：C2/C3 的代码早已落地
  （`src/core/jev/providers.ts` 311 行、`src/worker/lib/failover.ts` 159 行、`migrations/0004_move_provider.sql`），
  但决策只散在计划与本文里；现补 [ADR-0022](adr/0022-upstream-provider-failover.md)：**换三元组
  （端点/模型/key）不写协议适配器**、**同局粘滞、不回切**、**两条运行面各自处理「用尽」**
  （Worker 单请求语义 ⇒ 429/529 即视为用尽、5xx 本请求内重试到 3 次；直连面把重试阶梯的
  `exhausted` 传进 `noteFailure`）、**缺失 ≠ `primary`/`exact`**（0004 之前的老归档与 rapfi/mock/人类侧都是 NULL）、
  **默认关闭**（`JEV_FAILOVER=off` + 未配 `COMMANDCODE_API_KEY`）。同时把 C1 的事实基线写死：
  兜底网关响应与主网关**逐字段同构**（fixture 留档）、`GET /provider/v1/models` **不列** `typesafe/jev`、
  响应**无** `x-ratelimit-*`（额度只能靠状态码判）。`docs/adr/README.md` 索引已加行；
  计划 §7 里「是否单开 ADR」这条待办随之关闭（另两条仍然待业主：生产开不开兜底、生产 Worker 何时重部署）。

- **L2 阶梯跑完：5 个版本 × 3 档 Rapfi（2026-10-04，[L2 报告](plans/2026-10-04-l2-version-vs-rapfi.md)）**：
  `--ladder L2 --batch l2n1 --games 20` ⇒ **15/15 轮 / 300 局 / W234-D17-L49**（Jev 侧得分率 78.0%），
  零网络写、零 CF 触碰，墙钟 316.7 分钟、7440 个 Jev 手全部 `provider=primary`（切换 0 次、兜底手 0）。
  结果：① **Rapfi 曲线成立**（每档 100 局、分母配平）500/1000/2000 ms = Elo 1240.1/1340.8/1448.4、
  Rapfi 视角得分率 10.5%/20.5%/26.5%（Wilson [5.9–18.0]/[13.8–29.4]/[18.8–35.9]）⇒ **从 500 抬到 2000 确实更强**
  （区间不重叠），**500→1000 分不出来**（重叠）；② **版本之间不可排序**（每版 60 局、每对 20 局，Wilson 半宽 12–22 pt、
  12 对区间重叠）：v11 85.8% / v12 84.2% / v14 84.2% / v10 78.3% / v13 71.7%；③ **成本随机制单调变贵**：
  战术占单手 v10 22.3% → v11 36.7% → v12 36.8% → v13 37.9% → v14 38.7%（合计 35.6%，战术层均值 1006.7 ms、
  模型往返 1818.7 ms、单手合计 2825.4 ms，最差 `tac_ms` 13853 ms）；④ 先手优势在本批只有 48.7%（实力差盖过先手），
  逐色格照旧要报。**回归核对**：每轮抽样 2 局重放（30 局 / 1580 手 / 重放 640 手）⇒ **层一致率 640/640 = 100%**、
  接管落点一致 410/484 = 84.7%（P3 同口径 86.5%）、74 手会变但**全部同层** ⇒ 五个版本的接管判据与归档一致，无回归。
  证据：`.work/l2n1-report.md`（六节 + 逐色格）、`.work/remote/l2n1/round-{1..15}/`、`.work/l2-regress/round-*.json`。
- **链路抖动重试 + 重放棋种回退（2026-10-04，L2 收尾的两个工具坑）**：① box 的 22 端口链路**间歇性抽风**
  （`scp` 直接 `exit=1` 且无 stderr，手工跑同一命令行就成功；轮询里还见过一次 `ssh … port 22: Connection timed out`）
  —— 原来只重试一次，L2 收尾时「上传 round-1 plan 失败」把续跑掐死了两次，第 15 轮的 `scp -r` 也栽了一次。
  现在 `scripts/lib/ladder.mjs` 新增可注入 `sleep` 的 `retrySync(fn,{attempts,sleepMs,onRetry})` 与 `sleepSync`，
  CLI 的 `scp()` / 新增的 `sshRetry()` 一律 **3 次重试、间隔 2 s**；`sh()` 失败时打印 `exit=/signal=/code=/message`
  （静默失败最费时间）。**同一次续跑里 round-12 / round-13 的 plan 上传各失败一次、第二次重试成功** ⇒ 修复当场生效。
  `ssh` 的三处（读 tag / mkdir / 数行数）也走重试，因为它们原来**不报错只回退**，而回退的后果更坏
  （读 tag 失败会当「远端没 tag」换新 tag 把整轮重放；数行数失败会当「远端 0 行」把跑完的轮次再排一遍）。
  ② `scripts/lib/tactics-replay.mjs` 的棋种解析原来按 `slug → game → 默认`，而实验面归档的 `slug` 是**对阵描述**
  （`jev-v14-vs-rapfi-0-5s`）⇒ L2 的 300 局全被判「不认识的棋种」跳过；现在逐个候选试、认出就用，
  **且候选全认不出时仍然 throw**（一个坏 slug 不该判死，但也不能瞎兜底）；单测 `test/scripts/{ladder,tactics-replay}.spec.mjs` 覆盖
  （+6 例 `retrySync`、+3 例棋种回退）。**验证**：`npx tsc --noEmit` 0 错、`node test/engines/run.mjs` **153/153**、
  `npx vitest run` **50 文件 / 652 例**、`npm run check:docs` **62 md / 430 链接**、`node test/engines/fingerprint.mjs --check` 一致（210 行）。
- **第一晚 L3 跑完：Rapfi 三个思考档两两对打（2026-10-04，[L3 报告](plans/2026-10-04-l3-rapfi-think-time.md)）**：
  `--ladder L3 --batch l3n1 --games 20` ⇒ **3/3 轮 / 60 局 / W27-D0-L33**（A 侧口径），零上游调用、零 Worker 触碰，
  墙钟 493 s + 833 s + 700 s ≈ 34 分钟。结果：**`@2000` 相对 `@500` 在两个颜色格都占优（执黑 10:0、执白 3:0），
  `@500` 与 `@1000` 分不出来**（执黑 8 vs 7、执白 3 vs 2）—— 三对的 Wilson 区间全部重叠，没有一对「可判」。
  结构发现：**60 局里黑方赢 51 局（85.0%）、和棋 0** ⇒ 先手优势盖过档位差，报表此后必须给逐色格。
  证据：`.work/l3n1-report.md`（六节 + 逐色格）与 `.work/remote/l3n1/round-{1,2,3}/`（`games.jsonl` sha256 前 12
  `3eb808afac9b` / `6d9d9d81cc72` / `d57ca93bf172`）。
- **阶梯报告 CLI：六项必出报表可复算（ladder §7，2026-10-04）**：新增 `scripts/lib/report.mjs`（383 行纯函数）
  + `scripts/experiment-report.mjs`（285 行 CLI）；`--batch <id>` / `--dir <path[,path]>`（互斥）读
  `round-<i>/games.jsonl`（缺失才退回 `games/*.json`）+ `round-summary.json`（运行面与墙钟）+ `events.jsonl`
  （`game-start.opening` ⇒ 开局分层），写 `report.md`（缺省 `.work/<batch>-report.md`）与 `--json`。
  六节 = ① 能力表（内嵌 `formatRankTable`：BT Elo + bootstrap 95% CI + 局数 + W/D/L + 得分率 + 锚点 + Wilson + `⚠样本不足(<50)`）
  ② Rapfi「思考时间 → Elo」曲线 ③ 成本表（逐身份：Jev 手数 / 模型往返 ms（均值·中位·p90·最差）/ 战术层 ms / 单手合计 /
  **战术占单手** = `tac/(往返+tac)` 与 **战术/往返** = `tac/往返` 两个口径都印 ④ 配对样本矩阵（A 取字典序在前者 + Wilson；
  未用开局库时明写「本轮未启用开局库」）⑤ 显著性说明（区间重叠才算不可判；样本 < 50 必须标注）⑥ 产物清单（文件/字节/行数/sha256 前 12）。
  **口径**：逐手身份走 `identityOf()` 唯一实现（Rapfi 侧战术档留空、非 rapfi 侧思考档留空）；只有 `ai.ms` 是数字的手才算上游手
  （Rapfi 侧 `ms=null` 不是 0）；`provider=backup` 的兜底手单列在「提供方」列、**未计入主口径**。
  证据：① smoke（`.work/remote/c2fb2` 4 局）⇒ `✓ c2fb2：4 局 / 2 身份 / 1 对｜兜底手 55 / 上游手 55`，成本行
  `official|v14-live3-fresh|0 | 55 | 1691.6／1462／2639／3531 | 823／516／1773／2839 | 2514.6 | 32.7% | 48.7% | backup 55`
  （与 C2 手写脚本的 48.6% 同口径）；② `test/scripts/report.spec.mjs` 21 例（身份归属、`isUpstreamMove`、`quantiles`、
  `collectCost`/`costRow` 两种占比、`pairTable` 字典序与同身份排除、`rafiCurve` 排序、`openingRows`、`significance` 重叠判据、
  六节标题与兜底手/样本不足标注、**未收尾的轮两种读法**、**逐色格 `colorCells` 与分开颜色 `colorSplit`**、
  CLI 五条用法错 + 正常落盘）；③ `tsc --noEmit` 干净。
  **后来的读法纪律（同日）**：L3 跑到一半时发现 `--batch l3n1` 会把正在跑的 round-3 也读进来 ⇒ 「这轮跑完没有」的唯一本地凭据定为
  `round-summary.json`（worker 收尾才写）：缺它的轮默认照读，但报告头与第 5 节显著标出、收尾行告警；加 `--skip-incomplete` 才排除它
  （连同它的产物清单行）。半轮的比分不许进结论。
- **阶梯编排的进度轮询改本地（P6 修复，2026-10-04）**：第一晚 L3 出现「round-1 早已跑完，作业却停在 `started pid=…`」
  —— 真因是**编排进程意外死掉后，它起的那条 12h 远端等待循环 `ssh` 还活着并继承着 stdout 管道**，外层 `| Tee-Object`
  永远收不到 EOF。修法：`scripts/lib/ladder.mjs` 加 `parsePollOutput()`/`formatPollTick()`，`scripts/experiment-ladder.mjs`
  用**捕获式** `sshCapture()`（`timeout: 60s`，失败返回 null）+ 本地 `pollRound()` 每分钟问一次「pid 还在吗 + progress.json」，
  新增 `--poll <秒>`（缺省 60）与 `--quiet`。最坏情况从「泄漏一条 12h 子进程」降到「泄漏一条 ≤60s 的子进程」。
  证据：① 恢复跑打印 `续跑判定：1 轮跳过 / 2 轮要跑（远端行数快照：{"1":20}）` → `⏭️ round-1 跳过（远端已有 20/20 局）`
  → round-2 起跑并逐分钟打印 `⏳ round-2 7/20 局 · 215s · 均 30s/局 · W4-D0-L3`（2026-10-05 起该标签改为
  `近5局均 30s/局`：`meanGameS` 只取最近 `ETA_SAMPLES = 5` 局，读成整轮均时会算出错误的 ETA）；② `ladder.spec.mjs` 新增 6 例
  （`parsePollOutput` 四态、`formatPollTick` 三态与本地墙钟优先、`--poll 0`/`--cooldown -1` 两条闸门）。
- **上游兜底提供方：两个运行面共用一套切换判据（C2，2026-10-04）**：新增纯叶模块 `src/core/jev/providers.ts`
  （~300 行：提供方表 `primary`=TypeSafe `jev-latest` / `backup`=commandcode `typesafe/jev`、失败分类 `classifyStatus`
  （auth / rate-limit / server / client）、切换状态机 `noteFailure`/`noteSuccess`/`pickProvider`、两个响应头常量
  `X-Jev-Provider`/`X-Jev-Provider-Switch`）、`src/worker/lib/failover.ts`（~175 行，Worker 面同判据）与
  `src/core/jev/client.ts` 的 `callWithFailover`（直连面：局内粘滞、探活通过才切）。
  `decide()` 把 `provider`/`probSource` 写进逐手 meta（`src/core/meta.ts` 的 `prov`/`probs` + 局级 `providers`/`probSources`，
  沿用「有值才写」⇒ 黄金零漂移），归档 payload 因此能逐手读出「这一手谁答的」；脚本面加 `resolveBackupKey()`
  （`COMMANDCODE_API_KEY` → `/root/.cc-key`，取不到**不抛**）+ worker `--backup-key-file`/`--expect-backup`
  + `events.jsonl` 的 `provider` 事件。**生产路径默认关**：`wrangler.jsonc` 的 `vars.JEV_FAILOVER: "off"` 且不配
  `COMMANDCODE_API_KEY` 时 `providerAttempts()` 只返回主家一个尝试（客户端显式带 `X-Jev-Provider: backup` 时才走兜底）。
  证据：① **box 端到端真跑**（主 key 故意写坏 + 真兜底 key；`official|v14-live3-fresh|0` vs `rapfi||500` × 4 局，
  `--store local --upstream direct` 零 CF 触碰）：**4/4 局终局、W4-D0-L0**（27/26/25/30 手），每局第 1–2 手即
  `HTTP 401：key 或额度（不重试，直接切）` ⇒ 探活 `HTTP 200`（11–40 ms）⇒ 切兜底，之后局内粘滞不回切；
  逐手 `ai.prov='backup'`、`ai.probs='exact'`（55 手全部兜底，无一 `primary`、无一 `derived`），日志逐局 `provider[backup:14]`；
  ② 耗时与成本（m07650 / m08110 口径）：模型往返 mean **1692** / median **1462** / max **3531** ms，
  战术层 mean **823** / max **2839** ms（占单手 **48.6%**）；③ 单测覆盖三条触发与四类反向（401 立刻切、
  429 用尽后切、5xx 连试 3 次才切、探活不过不切、4xx 不切、网络错不切、无 backupKey 时老行为逐字不变）：
  `test/core/providers.spec.ts` 12 例、`test/core/jev-failover.spec.ts` 10 例、`test/worker/jev.spec.ts` +9 例；
  ④ 用**真实网关响应体**做离线夹具（`test/fixtures/jev/commandcode-systemone-2026-10-03.json`）钉住协议形状，
  漂移时单测先红；⑤ **顺带修掉 Hono 的隐性缺陷**：`c.header()` 的预备头在「直接 `return fetch()` 响应」这条路径上会丢
  ⇒ 旧实现的 `/api/jev` 成功响应其实没有 CORS 头（同源部署看不出来），现在成功路径自己拼 Response 并显式合并；
  ⑥ 全量验收：`tsc --noEmit` 干净、引擎 **153/153**、vitest **49 文件 / 617 例**、`check:docs` 60 md / 422 链接、指纹一致（210 行）。
  **只有真跑才露头的两处缺陷**（都由新增单测钉住）：切换事件回调引用了 `main` 作用域的 `outDir` ⇒ 每次切换整局变 error
  （`events.jsonl` 四条 `outDir is not defined`）；逐手统计把非上游侧记成 `unknown` ⇒ 日志 `provider[backup:19 unknown:18]`
  读不出「兜底了几手」（`countProvider` 现在只认非空字符串 id）。实施记录与回滚见
  [plans/2026-10-03-cands-metric-and-provider-failover.md](plans/2026-10-03-cands-metric-and-provider-failover.md) §4.2 与 §5。
- **上游归因落库与报表分桶**（2026-10-04，[候选点+兜底计划](plans/2026-10-03-cands-metric-and-provider-failover.md) C3）：
  「这一手是谁答的」从归档一路写进 D1 与报表。**落库**：新增 `migrations/0004_move_provider.sql`
  （`game_moves` 加 `provider` / `prob_source` 两列，已应用到本地与远程 D1），`src/shared/record-map.ts` 逐手取
  `ai.prov`/`ai.probs`（`strOrNull`：非空字符串才写），`src/worker/lib/record-input.ts` 显式搬运（不靠 camelize），
  `src/worker/db/games.ts` 的列清单/`VALUES (?1 … ?18)`/bind 三处同步。**口径**：`provider ∈ primary|backup|custom|random`、
  `prob_source ∈ exact|derived`；Rapfi/mock/人类侧与 0004 之前的老归档一律 **NULL**（缺失表示「当时还没这个口径」，
  **不冒充** `primary`/`exact`）。**报表**：累计行新增「上游兜底 N 手（未计入主口径 · 主口径 M 手 · primary … · backup …）」，
  轮注脚与逐身份的「候选发评标」tooltip 各有一处；`experiment-report.ts` 暴露 `FALLBACK_PROVIDER='backup'` 与
  `mergeProvs`/`provMovesOf`/`fmtProvs` 三个纯函数。证据：① 远程只读复核 `SELECT COUNT(*), SUM(provider IS NULL) … FROM game_moves`
  ⇒ **19298 手不变、两列全 NULL**（老归档零改写；D1 仍 312 局 / 19298 手）；② 单测：worker「上游提供方归因落库」三手
  （`backup`/`exact` 写值、Rapfi 侧 NULL、0004 前老归档形状 NULL）、ui「上游兜底手数」两局（`{primary:38, backup:4}`、
  Rapfi 身份空表、累计行与轮注脚文案）、core 映射 `provider`/`prob_source` 断言；③ 全量验收 `tsc` 0 错、引擎 153/153、
  vitest **49 文件 / 619 例**、`check:docs` 60 md / 422 链接、指纹一致（210 行）、`test/parity` 黄金零漂移。
  **遗留**：生产 Worker 尚未重新部署（`deploy.yml` 只留 `workflow_dispatch`）⇒ 生产棋谱要等一次手动部署才开始写这两列
  （列已就位，不会因缺列 insert 失败）；部署不改变任何默认行为（兜底仍 `off`）。
- **对新旧两套入口对账**（计划 P4 执行记录）：`node scripts/verify-parity.mjs --base https://jev-qiguan.pages.dev --candidate https://jevqipan.logicc.top` → **差值 0**（54 局 / 五子棋 54 / 胜负 18-27-9 / 校准样本 26）。旧入口的截断口径仍是 40 份、胜负 16-16-8——差值 0 说明新侧不是靠「也多读一点」蒙对的。
- **线上 HTTP 冒烟**（计划 P4 执行记录）：`npm run smoke:live` **29 项全过**（列表不含 payload、永久链接与列表指向同一局、旧深链带/不带 `.json` 都 200、`/api/stats` 无 `truncated`、导出为 JSONL、无 key 的 `/api/jev` 401、非法设备与非法日期 400、重传归档棋谱 `dedup: true` 且写 0 手、新房写 5 手、写后总数 54 → 55）。冒烟写入的行已删除，D1 复原 54/4379/0。
  2026-10-01 下午起该脚本改为 **30 项**，且总量断言一律**相对基线**（`stats.byGame` 只断言键是中文棋种名，`/api/experiments` 断言轮次 ≥ 6，写入后断言「基线 + 1」）——真实验一多，写死 54/6/55 就会天天空红（实测 `58 → 59` 通过；负向对照把 `+1` 改成 `+2` → 恰好那一项红、退出码 1）。
- **引擎行为不变**（2026-10-01 实跑 `node test/engines/run.mjs`）：金样自对弈逐手一致 —— 五子棋 17 / 五子棋·禁手 15 / 围棋 89 / 象棋 600 / 国象 169 / 跳棋 103 / 中国跳棋 138；归档 **54 局 / 4379 手逐手一致**。唯一已知不一致是 `games/2026-09-30/jev-v9-vs-jev-v8-20260930153334.json`（归档记「黑方 获胜（认输）」，引擎判 `null`）——引擎不建模认输，属预期，只记录不阻断。
- **文档卫生**（2026-10-01 实跑 `npm run check:docs`）：41 个 md 的相对链接全部可解析，MEMORY 置顶正确，status 日期在 30 天内。
- **静默换档已封死**（2026-10-03，[能力阶梯计划](plans/2026-10-03-tactics-fidelity-and-elo-ladder.md) P0/D2）：
  `src/core/tactics-versions.ts` 的 `resolve()` 过去对未知档号**静默回落到当前档**（`v14-live3-fresh`），
  「DOM 里写着 v12、实际跑 v14」这种单变量破坏谁都看不见 ⇒ 现在 `resolve()` 抛 `UnknownTacticsVersion`
  （消息含最接近的合法 id），展示/陈旧存档走新增的 `tryResolve()`；`src/core/tactics.ts` 的
  `resolveVersion()` 兜底从「全机制集」改成 **`v0-off` 空机制集**（宁可空转也不许悄悄变成别的档位）。
  三个入口各自核对白名单：`scripts/experiment-run.mjs`（`--tacA v12-vct-de` ⇒ 打印
  「最接近的合法档位：v12-vct-def」+ 15 档全列表、**exit 2**）、`scripts/lib/batch-common.mjs`
  `parseSpec()`（远端批量提交）、UI `startExperiment()`（toast「实验未启动：无法识别的战术档位」并拒绝启动，
  `test/app/experiment-start.spec.ts` 两例钉住拒绝与正对照）。陈旧 localStorage 在
  `src/core/persist.ts` 的 `loadSettings()` 边界就地净化（未知档号丢弃、侧配置清空），归档面板对
  登记表外的历史档位显示「登记表外的档位：X（原样显示）」而不是冒当前档。
- **实验面两条防污染闸门**（2026-10-03 同上）：`scripts/lib/batch-common.mjs` 新增
  `productionGate()`（不给 `--origin` 时必须显式 `--allow-production`，否则 exit 2）与
  `parallelGate()`（`--parallel` 只允许双本地臂，含 `official`/`openrouter`/`proxy` 任一侧即拒绝并点名），
  单元测试 7 例 + 三条手工验收（`submit` 无 origin / `--parallel` + proxy / `--tacA` 非法值）全部按预期 exit 2。
- **报表带上不确定度**（2026-10-03，P0b）：`scripts/lib/batch-elo.mjs` 新增 `wilson(hits, n, z=1.96)`
  （得分率的 Wilson 95% 区间），`rankTable()` 每行带 `rate/ci/halfPt`，`formatRankTable()` 印出
  「95% 区间(Wilson)」列并在样本 < 50 时追加 `±XX.Xpt ⚠` 与读数纪律注 —— **20 局/对的半宽 ≈ ±20 pt**
  （教科书那条 Wald 写法给 ±22 pt 且 0 胜/全胜会越界），同档轮间方差 17.5 pt > 档位差
  ⇒ 区间重叠就写「不可判」。
- **战术档位可冻结（P1 冻结层，2026-10-03）**：新增 `src/core/tactics-budget.ts`
  （`EngineBudget` 15 个上限 + `DEFAULT_BUDGET` 逐字冻结 + `BUDGET_KEYS` + `budgetOf()`（写错回默认 ⇒ 只能少看见）+ `sameBudget()`），
  15 条档位记录各带 `budget`/`sound`/`openingMin`/`promptFacts`/`fidelity`；`computeTactics` 按档把预算下传
  （`vcfWin` 的 `sound`/`nodeLimit`/`movesMax`、`live3Deny` 的 `evalMax`、`vctDefense` 的 `keep`/`vcfPlies`/`pressureLimit`、`pressureCut` 的 `keep`），
  `attachFacts()` 按 `mechOf(档位)` 逐句过滤（老档不再收到自己没有的机制句）。
  证据：① `.work/p1-fidelity-check.mjs` 在干净 HEAD `446f976` 取基线（15 档 × 120 真实归档局面 = 1800 行），改后复跑
  `.work/p1-fidelity-diff.mjs` ⇒ **`tac` 与 `ins` 全部 0 差异**（零行为变更）；② `.work/p1-mech-filter-probe.mjs`（40 局面）
  ⇒ v12–v14 文本 0 差异、v11 少 9600 字符、v10 19360、v7–v9 37560、v3–v6 51280、v1/v2 67520、v0 79200，丢的句子与机制表严格对应；
  ③ sound 正对照（哨兵局面缺省不报胜 / `sound:false` 报出 `F5→F6→E5` / 档位级 v7 报 `F5`、v9 不报，`nodeLimit:1` 搜不出）；
  ④ 引擎套件 **148 例**（+4）、vitest **38 文件 / 399 例**、`tsc --noEmit` 干净。
- **战术档位改动会亮红灯（P2 指纹设施，2026-10-03）**：接管链从 `src/core/jev/client.ts`（原 `:374-527`）抽成纯函数
  `src/core/takeover.ts`（`TAKEOVER_ORDER` 14 层权威顺序 + `TAKEOVER_LABEL` + `pickTakeover({engine, st, tactics, mech, criteria, legal, pairs, cands, topK, onTime})`），
  本文件 565 → 431 行；新增 `test/engines/fingerprint.mjs`（语料抽取 + `fingerprintOf()` 一趟链拿「事实 + 层 + 落点」+ `--write`/`--check` + 覆盖表）、
  `test/parity/tactics-fingerprints.json`（**14 局面 × 15 档 = 210 行，24.0 s**：归档抽样 10 个（早 4/中 4/晚 2）+ 具名夹具 4 个）、
  `test/engines/version-freeze.test.mjs`（5 例，已进 `test/engines/runner.mjs` 的 `ALL_MODULES`）。
  证据：① **抽取零行为变更**：`.work/p2-ab-baseline.mjs` 抽取前后各 30 局面 × 15 档 = 450 行，**差异 0 行**；
  ② **试红有效**：把 `DEFAULT_BUDGET.vcfNodeLimit` 由 4000 改成 1 ⇒ `⑭b` 报「决策指纹漂移 **32 处**」（v7…v14 的层从 `vcfDefense` 变 `parry`/`vctDefense`），还原后全绿；
  ③ 覆盖 **13/14 层**（缺 `threat`，结构性不可达：`you:open4` 标签判据与 `chance_points_you` 同源，且含 `threat` 的档都含 `open4` 而链里 `open4` 在前；
  取证 2225 个归档候选 + 双活三/双四合成局面全部 chance=0 或被 `open4` 接管）；④ `⑭d` 证指纹与 `decide()` 全链路同解；
  ⑤ 引擎套件 **153 例**（+5）、vitest **38 文件 / 399 例**、`tsc --noEmit` 干净、`check:docs` 58 md / 397 链接。语料规模是实测定的：120 局面要 ~9 分钟（早/中盘棋盘稀疏，v12–v14 三档各 ~1.2 s/局面），进不了 CI。决策记录 [ADR-0020](adr/0020-tactics-fidelity-freeze.md)。
- **阶梯编排：一条命令跑完一条 round-robin（P6，2026-10-04）**：
  新增纯核 `scripts/lib/ladder.mjs`（413 行）与 CLI `scripts/experiment-ladder.mjs`（435 行）+ `test/scripts/ladder.spec.mjs`（334 行 / 33 例）。
  阶梯**没有**做成 `experiment-batch.mjs` 的子命令：它要自己管「逐轮串行 → 等 pid → 拉该轮产物 → 推桶 → 冷却 → 下一轮」与续跑状态，
  塞进 submit 会让一个命令同时是「单批次提交器」和「多轮编排器」。三条口径写死在纯核的文件头：
  ① **颜色对称要求偶数局数**（worker 的 `sidesForGameSpec()` 让 A 奇数局执黑 + 开局库 `openingForNo()` 连续两局同开局换色；
  奇数会让最后一局既没有换色对手也没有配对开局 ⇒ `normalizeGames()` 直接拒绝，`--allow-odd` 才放行）；
  ② **身份口径 = 归档导出口径**（`rapfi:v14-live3-fresh:500` 的身份是 `rapfi||500`、`official:…:2000` 是 `official|…|0`，
  镜像 `tacticsLabel()`/`thinkMsOf()`）；③ **「跑完了」由远端 `games.jsonl` 行数判定**（本地 `ok` 但行数 `2/4` 会重跑，
  状态文件坏了也不重跑已完成的轮）。**L2 是笛卡尔积 15 对**（5 版 × 3 档 rapfi）而不是 8 个身份的 round-robin 28 对。
  证据：① dry-run 逐项对齐（`--games 2`）：L1 10 轮/20 局、L2 15 轮/30 局、`all --with-5000` 29 轮/58 局、自定义 2 身份 1 轮/2 局；
  ② **四道闸门真跑全过（exit 2 + 精确文案）**：未知预设、奇数局数、非法 `--batch`/`--store`/`--rate-limit`、
  `--store d1` 无 `--origin`、`--upstream worker` 无 `--origin`、`--parallel`（阶梯一律串行）、
  `experiment-batch.mjs submit --parallel` 双 proxy 臂被 `parallelGate` 点名拒绝；
  **缺省 `--store local --upstream direct`（零 CF 触碰）不再被「会写生产 D1」的闸门误拦**（本轮修掉的误拦）；
  ③ W/D/L 按**记录身份**判 A 执哪边（两臂同身份时才退回「奇数局 A 执黑」的位置推断 —— 缺行会让位置推断错位）；
  ④ dry-run 印 `≈` 墙钟（每局 60 手、上游臂 1.1 s/手、rapfi `think/2`）：L3 120 局 ≈2–3 h、L2 300 局 ≈7 h、L1 200 局 ≈11 h，
  并据此订正了计划 §7 里「L3 ~10 h」的粗估（起草时把两侧思考都算了一遍）；⑤ 全量验收：`tsc --noEmit` 干净、
  引擎 **153/153**、vitest **47 文件 / 584 例**、`check:docs` 60 md / 421 链接、指纹一致（210 行）。
  box 端到端真跑（小阶梯 + 中断续跑 + 桶前缀）见下一条 P6 验收记录。
- **阶梯编排的 box 端到端验收与四个续跑缺陷（P6，2026-10-04）**：
  在 `root@185.242.234.48:/root/board-games` 上用 `--store local --upstream direct`（零 CF 触碰）真跑，
  暴露并修掉四个**只有真跑才会露头**的缺陷（都由新增单测钉住，`ladder.spec.mjs` 33 → **38 例**）：
  ① 本地 `ladder.json` 沿用上一次计划形状（`--max-rounds 1`）⇒ 汇总打 `1/1 轮` 而实际跑了 3 轮
  ⇒ 新增 `stateMatchesLadder()`，形状不同就以本次计划重建；
  ② 续跑判据要求「本地 `ok` **且** 远端行数够」⇒ `p6val` round-3 远端其实跑完、只因一次 scp 拉产物失败就记 failed
  ⇒ 改成**远端 `games.jsonl` 行数为权威**（本地只记账），跳过时本地缺产物自动补拉一次；
  ③ worker 的 checkpoint **按 tag 命中**，而 CLI 续跑生成了新 tag ⇒ `p6kil` 的 4 局一轮被整轮重放、
  `games.jsonl` 变成 **7 行**、状态 `W3-D1-L3` ⇒ 新增 `withReusedTags()`（本地状态 tag → 远端 plan tag → 新 tag）
  与 `remoteTagsOf()`（只在本机缺 tag 或 `--force` 时问一次远端）；
  ④ 重复记录会被算进 W/D/L 与「跑完没有」⇒ `wdlOfGamesJsonl()` 按 `gameUid` 去重并给 `{lines, unique, counted, dupes}`，
  判据改用 `unique ≥ games`，重复时打 `⚠ 本轮 games.jsonl 有 N 条重复记录…`。
  另修：`--force` 会把旧产物挪到 `stale-round-N-<旧tag>/`（`staleCleanups()`；名字刻意不以 `round-` 开头，
  免得被行数扫描的通配扫到）、`applyRoundResult()` 把状态里的 `tag` 更新成本轮实际用的（否则 `--force` 后
  下次续跑又「沿用旧 tag」⇒ 又整轮重放）、`scp()` 加一次重试（瞬时失败真因**未证实**：三种路径写法实测都成功，
  故「盘符冒号」假设被否证，如实记录为「原因未定性 + 重试兜住」）。
  实测证据：`p6val` 三轮 ⇒ `续跑判定：3 轮跳过 / 0 轮要跑（{"1":2,"2":2,"3":2}）`、`⏳ round-3 跳过但本地缺产物，补拉一次…`、
  `3/3 轮正常｜6/6 局｜W2-D0-L4`；`p6kil2` 中途 `kill` 后同命令续跑 ⇒ worker 日志 `game-1 已完成（ok），跳过`、
  只补跑 2–4 局（23s/23s/59s）、最终 **4 行 / unique 4 / 无 dupes**；`--force` ⇒
  `⚠ round-1 旧产物挪到 stale-round-1-exp-20261004030619-p6kil2-r1/`、新 tag、4 行、状态 tag 同步；
  桶钩子在三次真跑里都走「缺凭据只告警」且 exit 0。CI：`15ba04d` 的 run `37170326312` success（2m1s）。
  说明：box 上每次 ssh/scp 握手 ≈18 s、rapfi 自对弈一局 18–25 s ⇒ 验收不能在局中靠「等 N 秒再杀」卡点，
  要在远端看守循环里 `kill`。
- **Elo 升级：Bradley–Terry 点估计 + Bootstrap 区间（P5，2026-10-04）**：
  `scripts/lib/batch-elo.mjs` 从 238 行扩到 **448 行**，新增 `aggregateBt()` / `fitBt()`（MM 迭代、`ridge` 先验 0.5、
  **显式零点**）/ `computeBt()` / `bootstrapBt()`（按局有放回重采样 + 每次重拟合，2.5–97.5% 分位）/ `mulberry32()`；
  `rankTable(records, K, { bt })` 只在开启 BT 时加 `BT Δ` 与 `95% 区间(BT Δ)` 两列（不开时行形状与老版本逐字一致，
  由单测钉死），Wilson 列保留；`scripts/experiment-batch.mjs elo` 增 `--anchor/--bootstrap/--seed/--no-bt`，
  报表印锚点/迭代收敛/`ridge`/重采样次数与宽度行。证据：① **估计量与区间的正确性对照理论**（两身份干净情形，
  60 种子 / bootstrap 300 / 真差 100）：n=50 理论 SE **51.2** vs 经验 SD **52.6**（平均区间宽 208、覆盖 57/60）、
  n=200 **25.6 / 25.8**（100、56/60）、n=800 **12.8 / 12.7**（49、55/60）⇒ 实现被独立验证（差 ≤2%、覆盖率 92–95%）；
  ② **计划的判据按实测订正**：三身份轮转、40 种子的实测显示「200 局 ⇒ 点估计误差 < 25 Elo」过于乐观 ——
  200 局（每对约 67 局）真差 100/200 时偏差 +4.4/+1.7、**平均绝对误差 27.9 / 35.6**、n=400 ⇒ 21.2/25.4、
  n=800 ⇒ 20.6/17.3，于是判据改成「\|偏差\| < 10 + 200 局平均绝对误差 < 45 + 误差随 n 单调下降」，
  并把「一次 200 局只能分辨 ~30 Elo」写进计划 §7；③ `rapfi\|\|500` = 0 锚成立，数据里没有锚时退化成均值居中
  并在报表里写明「无锚点」；④ 同 seed 逐字可复现、`--bootstrap 0` 只算点估计、`--no-bt` 与旧报表逐字一致；
  ⑤ 新增 `test/scripts/batch-elo-bt.spec.mjs`（**220 行 / 17 例 / 0.9 s**）；⑥ 全量验收：`tsc --noEmit` 干净、
  引擎 **153/153**、vitest **46 文件 / 546 例**、`check:docs` 60 md / 421 链接、指纹一致（210 行）。
  `rapfi\|\|500` 锚 + 「配对样本才判差」
  与 §7 的 5 pt 分辨率门槛一致：**BT 区间按局重采样、不利用配对结构 ⇒ 偏窄**，报表脚注已印这条纪律。
- **离线实验面：直连上游 + 本地 JSONL + 文件进度 + 对象桶留档（P4b，2026-10-04）**：
  新增 `scripts/lib/s3-put.mjs`（288 行：纯 Node `crypto` 自实现 AWS SigV4，覆盖 R2/S3/B2/MinIO 的
  path-style 与 virtual-host 两种寻址）、`scripts/lib/throttle.mjs`（148 行：滑窗自限速 + 连续 429 熔断，
  **裹全局 `fetch`** 只给上游主机领令牌 —— core 的 `client.ts` 直接调全局 fetch，包一层 client 会漏掉它自己的重试）、
  `scripts/lib/upstream.mjs`（89 行：运行面闸门 + key 解析：env 优先、`/root/.jev-key` 兜底）、
  `scripts/batch-bucket.mjs`（211 行：`push|pull|ls`，产物白名单，凭据只读环境变量、缺任一 exit 3，
  上传失败只告警不阻断）；`scripts/experiment-worker.mjs` 增 `--upstream direct|worker`（**缺省 direct**）/
  `--key-file`/`--rate-limit`（缺省 30/min）/`--origin`（显式逃生门），`scripts/experiment-batch.mjs` 的
  `submit` 透传并把 `upstream` 写进 plan、`status --watch` 用**纯 shell** 循环经 SSH 复读 `progress.json`。
  决策记录 [ADR-0021](adr/0021-standalone-experiment-plane.md)（为什么直连面复用现成 `official` 渠道而不是新造渠道、
  为什么进度载体是文件、为什么 SigV4 自己实现、身份串为什么从 `proxy|…` 变 `official|…`）。
  证据：① **四道闸门实跑全过（exit 2 + 精确文案）**：direct 面出现 `proxy` 臂（提示改写成 `official`，
  同一上游同一 Bearer）/ `--upstream worker` 无 `--origin` / `--store d1` 无 `--origin` / 缺 key（打 `KEY_HELP`）
  —— 缺 key 那条第一次跑是 `KEY_CHANNELS.has is not a function` 的 exit 1，已修 `includes`（这种错只在「缺 key」路径暴露）；
  ② **SigV4 用 AWS 官方已知向量逐字节钉死**：GET Object `f0e8bdb8…`、PUT Object `98ad7217…`、
  RFC 4231 HMAC 用例 1 `b0344c61…`（三条向量当场抓出三个真 bug：作用域日期忽略显式 `x-amz-date`、
  `canonicalUri` 吞前导斜杠、虚拟主机式 endpoint 已含桶名会静默拼成 `bucket.bucket.…`）；
  ③ **rapfi 真跑（`--store local --upstream direct`，2 局 27 s）**：两局前 6 手 = 开局库 `H8 E5 I8 B2 J8 G8`，
  `progress.json` 跑动中可读（`{total:2,done:2,wdl:{w:1,d:1,l:0},etaS:0,meanGameS:14}`）、`events.jsonl` 6 行
  （`round-start` 带 `upstream:'direct'`）、`games.jsonl` 能被 `loadRecords` 读回并按 `gameUid` 去重、
  日志打「store=local：未触碰业主 Worker」；④ **断桶不阻断**：错凭据下逐项告警、其余文件照传，`main` 缺凭据 exit 3
  （`--strict` 才升 1）；⑤ **box 出网探针**：`/root/.jev-key`（`-rw-------` 121 B）+ `Bearer` POST 上游 ⇒ **HTTP 422**
  （`questions` 空 ⇒ 鉴权已过）0.315 s，box `node -v` v24.9.0 —— 顺带查清**本机 Node 无外网**（代理 `127.0.0.1:10808`
  未运行时 `fetch` 直接 `ECONNREFUSED`）⇒ 直连面的**整局**验收只能在 box 上做；⑥ scripts 单测 **10 文件 / 187 例**、
  vitest 全量 **45 文件 / 529 例**、引擎套件 **153 例**、`tsc --noEmit` 干净、`check:docs` **60 md / 421 链接**、
  `node test/engines/fingerprint.mjs --check` 一致（210 行）；⑦ 一条口径：未终局记录（`maxPlies` 截断）在
  `progress.json` 里记和棋、在 `batch-elo.mjs` `gameRecord()` 被丢弃（「未终局不计入 Elo」），只有 `maxPlies < 225` 时两者不一致；
  ⑧ **box 整局直连验收通过**（`15ddfa8`，日志 `/root/ladder/p4b-box.log`）：`official:v14-live3-fresh:0` vs
  `rapfi:v14-live3-fresh:1000` 两局 118 s（`27 手 winner=black 26s` / `80 手 winner=和棋 89s`，后者是 `maxPlies` 截断），
  `已发 54 次、累计等待 17.6s｜连续 429 0`、`fetch:{gated:54,passed:0}`、key 走 `file:/root/.jev-key`，
  跑前后 `select count(*)` 都是 **games 312 / game_moves 19298 / experiments 28**（零 CF 触碰的硬证据）；
  取回的 `games.jsonl` 喂 `experiment-batch.mjs elo` 复算正确（`official|v14-live3-fresh|0` 1508 vs `rapfi||1000` 1492，
  80 手那局按「未终局不计入 Elo」被丢弃 ⇒ 样本 1 局）；⑨ 补一条守卫：手写 plan 缺 `tag` 原先会静默跑出无标签实验行
  （`progress.tag` 落成 `""`）⇒ worker 现在开局前 exit 2 要求补 `tag`。
- **远端阶梯的地基：配对开局 + 进度可查 + 默认不碰业主 Worker（P4 阶梯地基，2026-10-04）**：
  新增 `scripts/lib/openings.mjs`（269 行：从归档决胜局取前 N 手、8 变换对称归一、去重计数、
  `openingForNo()` 让**连续两局同一开局、换色双跑**、原子读写 + 形状校验）与 `scripts/lib/progress.mjs`
  （153 行：`progress.json` 原子写 + `events.jsonl` 追加 + `eta()` 只按已完赛局估，样本不足给 `null` 而不编数字）；
  `scripts/experiment-worker.mjs` 新增 `--openings`/`--store local|d1`（**缺省 local** ⇒ 默认不写生产 D1，
  老调用方在 plan 里显式写 `store:'d1'` 保持原行为）/`--device-id`；`scripts/lib/batch-elo.mjs` 的 `loadRecords()`
  学会读 `games.jsonl` 并按 `gameUid` 去重（单局 JSON 与 JSONL 同时存在只算一次）。
  证据（脚本 `.work/p4-build-openings.mjs`、`.work/p4-verify.mjs`，可复算）：① 归档 54 局 ⇒
  `source={games:54,used:45,dropped:9}` + 4 本开局（`H8 E5 I8 B2 J8 G8` 13× 等），同输入逐字节同输出；
  ② rapfi 自对弈真跑（`exp-20261004-p4smoke-r1`，2 局，同一开局换色）**前 6 手逐手等于开局库**，
  第 7 手起才有 `ai` 块且 `ch=rapfi`；③ `games.jsonl` 可被 `loadRecords` 读回 2 局、身份 `rapfi||500`；
  ④ 跑动中读到 `{total:2,done:1,gameNo:1,ply:50,wdl:{…},elapsedS:12,etaS:12}`（`ssh cat progress.json` 同形）；
  ⑤ `store=local` 轮次零网络写（实验行留在 `round-summary.json` 的 `experimentEntry`）；
  ⑥ scripts 单测 **6 文件 / 136 例**、vitest 全量 **41 文件 / 478 例**、引擎套件 **153 例**、`tsc --noEmit` 干净、
  `check:docs` **59 md / 411 链接**、`node test/engines/fingerprint.mjs --check` 一致（210 行）。**归档的两处坑**（P4 建库时当场踩到）：
  归档**没有 `winner` 字段**、只有中文 `result`（`"黑方 获胜（五连）"`/`"和棋（棋盘已满）"`），
  且布局是 `games/<day>/*.json` ⇒ 旧的「父目录名叫 `games`」闸门对归档一局都匹配不上，
  两条都已按「路径上任何一级目录叫 `games`」+ `winnerSideOf()` 修好（`loadRecords` 同步受益，P5 用归档算 Elo 才走得通）。
- **战术层可离线回溯（P3 回放 + 考古，2026-10-04）**：新增离线重放 `scripts/tactics-replay.mjs`（纯核 `scripts/lib/tactics-replay.mjs`，
  `--dir/--file/--game/--tag/--tactics/--sides/--limit/--max-games/--json/--show`；23 例单测在 `test/scripts/tactics-replay.spec.mjs`），
  并产出考古文档 [战术档位考古](plans/2026-10-04-tactics-archaeology.md)（267 行）。
  证据：① **验收（`exp-20261003082805`，v14 vs `rapfi@5000ms`，20 局 / 990 手 / 重放 496 手 / 282.2 s）**：
  **层一致率 496/496 = 100%**、**接管落点一致率 327/378 = 86.5%**、**会变 51 手且全是同层换点（0 处换层）**
  —— 归档没有整张模型概率表，重放刻意走「无模型」等权口径（`pairs = 合法着法等权`、`topK = 1`），
  所以「层」是与模型无关的确定性事实（强结论），「落点」在层内多解时依赖模型概率（86.5% 是下界）；
  ② **考古 14/14 档参数层可确证**：15 个预算键逐键、`sound`、`openingMin=4`、注入句集/句面/句序全部有 sha 证据，
  且逐键等于 P1 冻结值 ⇒ v1–v13 `fidelity` 由 `approximate` 升 **`restored`**、`v0-off` 留 `approximate`（档位表无 sha）、
  v14 保持 `exact`；③ 两条前序审计结论被否证（v11 上线预算即 10/3000/6，`14/6000/∞` 只在未入库的 `.work/vct-tune*.mjs`；
  prompt 漂移在 P1 后已修），并修正「预算冻结于 `446f976`」——`src/core/tactics-budget.ts` 仅由 `0b3a400` 创建；
  ④ `threat` 层逐层可达性复核写进考古文档 §6.1，标注「历史层，当前机制表下不可达」；
  ⑤ 引擎套件 **153 例**、vitest **39 文件 / 422 例**、`tsc --noEmit` 干净、`check:docs` **59 md / 407 链接**、
  `node test/engines/fingerprint.mjs --check` **指纹一致（210 行）**；⑥ 考古文档 §9 的「会变 51 手」逐层计数已用
  `--json` 复跑实测（`live3Attack` 21 · `live3Defense` 11 · `parry4` 7 · `open4` 3 · `vctDefense` 3 · `parry3` 3 ·
  `pressureGate` 2 · `block` 1，零跨层）。
- 迁移各阶段的实测数字与偏差裁决见计划 P0–P8 执行记录（含本地导入 4440 changes、7 张表、线上部署版本号等）。

## 设计例外（有意保留，不是遗漏）

1. **装饰性发丝线保持低对比**：面板描边与分隔线用的 `--line` / `--line-strong` 是「月白」视觉世界的一部分，对比度低是有意的；功能性控件边界另用 `--line-ctl`（≥3:1，满足 WCAG 1.4.11）。不要为了「统一」把两者一起加深。
2. **侧栏存在 11px / 11.5px 正文**：战绩簿 7 列表格、指标标签、棋谱流水属于密集数据面板，提到 14px 需要重排并显著降低信息密度；正文高于 11px 的部分均已达标。
3. **`#promoBox` 用「明确边 + 中等投影」**：1px `--mo` 边（对白底 15.6:1）+ 28px 投影。自动检测器无法区分「明确边」与「发丝线」，不要按检测器的建议去改。

## 已知限制

### 已修复（旧限制 → 现在怎么做的）

| 旧限制 | 现在的做法 |
| --- | --- |
| `BG.codeVersion` 是手工常量，忘记 bump 就导致归因失效 | 构建期注入：`vite.config.ts` 用 `define` 注入 `__APP_VERSION__` / `__BUILD_SHA__`，[src/shared/version.ts](../src/shared/version.ts) 组成 `CODE_VERSION` |
| 归档按文件名 stamp + 时间窗口归版（说不准是哪版代码下的） | 归因只认数据自带的声明：`payload.meta.code` → `games.code_version`，每手 `ai.tv` → `tactics_version`；没有声明就是 `unknown`，不推断 |
| `/api/stats` 受 50 子请求限制，只聚合最近 40 份，响应里带 `truncated` | 聚合搬到 D1 的 SQL 侧（三条 `GROUP BY`），`truncated` 字段彻底删除；冒烟第 12 项专门断言它不存在 |
| 限流是 isolate 内存里的 Map，换个 isolate 就失效 | D1 的 `rate_limits` 表做固定窗口计数（ADR-0013） |
| 列棋谱硬编码「最近 7 天」 | `since` 显式参数 + keyset 游标（`id < cursor`，`limit ≤ 100`），不再有隐式窗口，也不再截断 |
| 归档面板只取第一页，`limit: 100` 之外看不到（即便服务端早就支持游标） | `src/app/records.ts` 按 `ARCHIVE_PAGE_SIZE = 50` 取首屏，底部「加载更多」带 `?cursor=` 追加下一页并在没有下一页时收掉按钮；失败时保留已载入的行并让按钮恢复可点（实测 54 局：50 → 54，`smoke:browser` 第 10 项守这条路） |
| 每局一次 git commit 归档，依赖 `GAMES_GITHUB_TOKEN` | 棋谱直接落 D1；导出/备份走 `/api/export/games`（JSONL）与每日 D1 export |
| 持久化是本地 JSON 文件，`server.js` 与 `dev-proxy.py` 还抢 8788 端口 | 本地 Node 后端已退役（ADR-0011）；`npm run dev` 起的是 Vite + 本地 workerd + 本地 D1，与线上同一套代码 |
| 实验归档只在本机 localStorage，换台机器就看不到 | `experiments` 表 + `/api/experiments`；离线时仍退化为本机战绩簿（有意，见下） |
| `?test=1` 校准自检夹具自相矛盾（`src/core/view/calibration.ts` 的 `selfTest` 期望值与样本对不上，面板必亮红） | 夹具按定义重算并补齐 F/G 两组：混合组期望改 `ece/mce = 0.54/0.9`、`brier = 0.306`，另加「全赢 → `skill=null` 但不许 NaN」的退化组；`test/app/boot.spec.ts` 断言 `?test=1` 面板**零失败** |
| `#expStopBtn`（「停止实验」）与 `#speedRow`（机机速度行）永不显示 | 根因是显隐写法只有一半：`index.html` 里被运行时开关的节点分 `class="hidden"`（对局按钮）与 `hidden` 属性（P6a 侧栏面板）两种，旧实现只切 class。`src/app/panels.ts` 的 `setVisible()` 现在两种一起切，`setHidden` 的调用点全部改走它 |
| `index.html` 外壳硬编码「黑方 Jev」，标题写「六种棋类」而实际七种 | 标题/描述改为「七种棋类对弈」；双方名改成由装配层写入的空槽（`#duelFirstName` / `#duelSecondName`，缺省文案「黑方」/「白方」），渠道名不再写进 HTML |
| 版本双源不一致（Worker `1.0.0` vs 前端 `0.3.0+sha`） | 两源都改 `package.json` 的 `version`（现 `1.0.0`），`test/core/version.spec.ts` 逐字比对两处并钉住 `vite.config.ts` 仍从 `pkg.version` 注入 |
| 样式表仍在 `css/`，与计划的 `styles/` 不符 | `css/style.css` → [styles/style.css](../styles/style.css)，`index.html:11` 改指 `/styles/style.css`，由 Vite 打包；`test/ui/layout-css.spec.ts` 同时探两侧，搬迁不用改测试 |
| **Rapfi 渠道在浏览器里从不走子（mock 渠道掩盖了它）** | 两个注入点都没人接线：`src/core/jev/rapfi.ts` 的 `setLoader()`/`setGlueUrl()` 浏览器侧从未调用，`src/core/jev/client.ts` 要求的 `opts.rapfi` 也没人注入。修法：新增 `src/app/rapfi-loader.ts`（`loadRapfiModule` + `installRapfiLoader`），`src/app/boot.ts` 启动时安装，`src/core/jev/index.ts` 的 `decide()` 默认补 `rapfi: decideRapfi`；`test/app/rapfi-loader.spec.ts` 7 例钉住（含端到端 `decide()`），线上 `--channel rapfi` 浏览器冒烟 14/14 |
| 实验报告只按「Jev 渠道 / 其他」两个桶对比：两侧都是 Jev 渠道时双方落进同一桶（报「Jev 6 胜 · 其他 0 胜」），没有胜率，和棋也没拆出来 | `src/ui/panels/experiment-report.ts` 改为按「渠道 · 战术版本 · 思考深度」分身份统计（`expSideStats()`），身份从局号奇偶推 A/B 执黑（`aIsBlack`），**得分率 =（胜 + 和 ÷ 2）÷ 局**、`dup` 局不计；累计区变成分桶表（局/胜/和/胜率条），每轮多一条 A/B 单轮得分率条。`test/ui/experiment-report.spec.ts` 5 例 + 两次负向对照（判据写反 / 和棋不算半分 → 各 2 例红） |
| **服务端实验战报从来没并进报告面板**（生产 6 轮实验，面板永远只显示本机种子的 2 轮） | Worker 的 `GET /api/experiments` 响应体是包装对象 `{experiments:[…]}`，P6 装配时按「客户端已解包」写成 `Array.isArray(r)` 判断 → 静默返回。修法：`src/core/api/client.ts` 的 `listExperiments()` 统一解包（兼容裸数组，其余形状 null），`src/app/backend.ts` 的注释与判据同步修正；`test/app/experiments-merge.spec.ts` 3 例钉住（含「同 tag 局数变多才覆盖」与坏形状不抛），`smoke:browser` 新增在线断言（实测本机种子 2 轮 → 面板 6 轮 / 38 局有效） |
| **报告面板只看得见早期实验**：轮次卡按 `experiment` tag 分组，而归档里最新的一批机机对局（`jev-v9-vs-jev-v9` 等）根本没挂 tag → 永远进不了卡片，6 轮实验全是 2026-09-29/30 的 | 报告面板顶部新增「最新棋谱」块：装配层取 `GET /api/games?limit=10`（`LATEST_GAMES_LIMIT`）整形为 `LatestGameRow[]`（时间/棋种/手数/双方归因/结果/可选 tag#局号，缺 `gameUid` 的行丢弃），`src/ui/panels/experiment-report.ts` 的 `renderLatestGames()` 渲染，每行「回放」直接调 `openReplayer()` 载进回放器；boot / 归档「刷新」/ 每轮实验结束三处都会重取。`test/ui/experiment-report.spec.ts` 6 例 + `test/app/latest-games.spec.ts` 3 例（含点回放真的走 `/api/games/u/:uid`），三组负向对照（去掉 uid 过滤 / 渲染改成 appendChild / null 与 `[]` 共用文案 → 各红） |
| **自家限流把整轮对比实验挡死在第 1 局**：`jev` 档 30 次/分/IP，机机对局一个 60 秒窗口打到 34 次；客户端旧写法 4 次尝试（1+2+4 秒）熬不过窗口，且**限流分支从不给 `lastErr` 赋值** → 抛出的文案是「重试次数用尽」，真实原因（被自己限流）完全看不出来；机机对局又没人点「重试」，于是整轮实验报废 | 传输层：`src/core/jev/client.ts` 的 `callWithRetry` 重写 —— 限流（429/529）独立计数 5 次、按 `Retry-After` 退避（截 20 秒）、每次都留带状态码的错误并打 `retryable` 标记（401/4xx 为 `false`）。装配层：`src/app/loop.ts` 的 `aiStep` 对 `retryable` 做自动退避重试（`AI_AUTO_RETRY_DELAYS_MS = [4000, 12000, 25000]`，期间**不暂停**），成功/手动重试/重开一局都清零额度。配置：`jev` 档改由 `vars.JEV_RATE_LIMIT_PER_MIN` 覆盖（生产 60，60×1440 ≈ 8.6 万 < 10 万行/日）。`test/core/jev-retry.spec.ts` 5 例 + `test/app/ai-auto-retry.spec.ts` 2 例；三组负向对照（不遵守 `Retry-After` / 尝试次数降回 4 / `retryable` 改 false / 关掉自动重试分支）各自红了对应用例 |
| **实验运行脚本会自欺**（`scripts/experiment-run.mjs`）：计量器按绝对路径 `/api/jev` 匹配，而代理端点是相对串 `api/jev`（`src/core/jev/client.ts:29`）→ 永远报「上游 0 次（错 0）」，恰好藏起唯一证据；失败时台账 `history[0]` 还是上一轮的 tag → 归档核对会拿旧数据当本轮成绩；页面停在「等人工重试」时无人可点 | 计量器同时认两种写法并记录 HTTP 状态序列（心跳里直接打出来）；开跑前记台账基线，跑完**只认基线之外的新条目**，没跑满就跳过归档核对；轮询中发现 `#retryBtn` 可见就代点并计数（`report.retryClicks`）；退出码新增 `done` 条件（未跑满一律非 0） |

| **v9 对「带空隙的活三」完全失明**（27 局 rapfi 复盘的真正输法）：`src/core/engines/gomoku.ts` 的 `liveThreeDir` 只认连续 `_XXX_`（`labelPoint` 打出的 `you:live3` / `deny:live3` 因此漏掉跳活三与斜线组合），`danger_points_opponent` 又只到 2 手（只认「一步成五」），于是「对手 4 手内必胜（走活三 → 下一步造活四）」这类局面**没有任何保险层会触发**，v9 只能走静点等死 | v10 新增**真推演**的两级：`live3Makers(st, sideId)`（落子后己方有 ≥2 个活四制造点 = 4 手内必胜）与 `live3Deny(st, sideId, cands)`（拆掉对手全部活三制造点的点，先试对手的 L3 点、用 `best+1` 截断、最多评 24 个点）；战术层产出 `live3_you` / `live3_opponent` / `live3_deny_points`，接管链在 `vcfDefense` 后插入 `live3Attack` / `live3Defense` 成**十一级**（v11 起十二级），且**只在 `danger_points_opponent` 为空时才动**（对手有 2 手剑时抢 4 手剑会输速度，让给 `parry`）。依据实测：27 局里只有 2 局死于 VCF，27/27 局对手都能造活三，v9 拆 13 次漏 14 次，漏掉的 12 局是执白 ply#6 放行反对角线活三 F10/D12（该局面四点 criteria 全 `null`，旧标签体系确实无可用信息）。测试：`test/engines/tactics.test.mjs` 新增⑤b 五例（引擎层 / 战术事实 / 决策级接管 / 抢攻 / 让位），`test/engines/util.test.mjs` 与 `src/core/view/duel.ts` 的联名断言改为从登记表派生（不再写死 `Jev·v9`）。机制记录 [ADR-0014](adr/0014-live3-real-lookahead.md)。**对照实验结果**：`v10-live3` 6 胜 4 和 2 负（得分率 67%，执白 0 负）vs `v9-vcf-sound` 3 胜 9 负（25%），live3 两层 12 局接管 168 手、v9 同批对手 0 次（见上文「战术 v10 对照实验」）。 |
| **v10 用启发式活三点覆盖掉了算得清的必胜链**（v11 复盘的真正发现）：v10 的 `live3Attack` 只看「落子后盘面上有 ≥2 个活四制造点」，不区分这些点是本手新造的、也不追问「这一手是否已经进了一条强制胜链」。v10 臂 12 局复算：7-ply 纯冲四（VCF）看得见 **22 手**必杀，加到 11 ply **也只多 2 手**，而把活三当**逼迫手**纳入搜索（VCT）看得见 **42 手**，其中 **20 手分布在 7 局里是纯 VCF（哪怕 11 ply）完全看不见的**；这 20 手实走几乎全是 `live3Attack` 的启发式点（与 VCT 首步不同），7 局里包含 **2 局 225 手满盘和棋与 1 局败局** ⇒ v10 实验里「和棋偏多」至少一部分是漏杀 | v11 新增**连续威胁搜索**：引擎 `vctWin(st, attackerId, maxPlies)`（攻击方着法 = 冲四 ∪ **本手新造 ≥2 个活四制造点**的活三；守方按逼迫类型精确枚举应手 —— ≥2 成五点直接判胜、单成五点唯一应手、活三要求「守方当下没有造冲四的着法」并枚举全部 `vctDefusers`），战术层产出 `vct_win_you`、接管链在 `vcfAttack` 与 `vcfDefense` 之间插 `vctAttack` 成**十二级**（`VCT_PLIES = 9` = 5 手攻方着法）。夹具（归档局 `cf3d85f9…` 第 21 手）：`vcfWin(7)`/`vcfWin(11)` 均无杀，`vctWin(9)` = 胜 `L4>K7>J9>L10>I9`；黑走 `L4` 后白方邻域 **106 个应手全部仍在杀里**；同局面 v10 档实走 `K7`（`live3_you` 首选）、v11 档走 `L4`。测试：`test/engines/tactics.test.mjs` 新增⑤c 四例（引擎层 / 强制性 / 档位差异 / 决策级）。机制记录 [ADR-0015](adr/0015-vct-continuous-threats.md)。**对照实验结果**：`v11-vct` **10 胜 0 和 2 负（得分率 83%，执黑 5 胜 1 负 / 执白 5 胜 1 负）**，同条件 v10 6 胜 4 和 2 负（67%）、v9 3 胜 9 负（25%）；`vctAttack` 单层 12 局接管 62 手、v10 臂上此层 0 次；12 局零和棋、平均手数 34（见上文「战术 v11 对照实验」）。逐手复盘 206 个 v11 回合：**87 手存在必胜链、其中 84 手走了链首步**，3 手让给更高优先级的必胜层（`open4` ×2 / `vcfAttack` ×1，同为强制胜），**「机会真丢」0 手**；两负的两局（28 / 17 个 v11 回合）**一次都没报出必胜链** ⇒ 输在无强制胜可算的局面，下一版入口是防守与长线取势。 |

| **实验报告把 B 侧的战术档安到 A 侧身上**（战术层耗时用例暴露）：`src/ui/panels/experiment-report.ts` 的 `gameSide()` 在局内字段缺失时一律用轮级 `tacA` 兜底黑方，而 A 只在奇数局执黑 ⇒ B 执黑的那些局会给 B 侧安上 A 的战术版本，分桶表冒出 `rapfi\|v11-vct\|0` 这类幻影身份、把手数拆成两行 | 兜底改按局号奇偶：`const aIsBlack = ((g.no \|\| 1) - 1) % 2 === 0; const isA = (side === 'black') === aIsBlack;` 再按 `isA` 取 `chan / tac / think`；`test/ui/experiment-report.spec.ts` 的战术层用例断言「只出现两个身份」钉住（修前红在均值被拆成 50ms） |
| **归档给「不过战术层的渠道」也写上了战术档标签**（计时轮暴露，与上一条同源但更深一层）：Rapfi / mock / 人类侧压根不进 `computeTactics`（`src/core/jev/client.ts` 在 `channel === 'rapfi'` 处短路），可归档里的 `black_tactics` / `white_tactics` 照抄 A/B 配置 ⇒ `black_channel='rapfi'` 的行会带着 `v9-vcf-sound` 这种惰性标签，报表按「渠道\|战术\|思考」分组时冒出 `rapfi\|v9-vcf-sound\|500` 这种并不存在的身份（`scripts/experiment-run.mjs:60` 的旧默认值 `v9-vcf-sound` 是标签来源） | `src/core/view/duel.ts` 新增 `runsTactics()`（human / mock / rapfi ⇒ false）与 `tacticsLabel()`（不过战术层 ⇒ `''`，空串经 `strOrNull()` 落 NULL），`src/core/record/export.ts` 按**每侧真实渠道**（`bChan`/`wChan`，实验轮取 `exp.blackChannel`/`whiteChannel`）过滤档位；`src/ui/panels/experiment-report.ts` 的 `gameSide()` 与 `src/ui/panels/options.ts` 的 `sideAttribution()` 以渠道优先判身份（Rapfi 仍显示 `Rapfi(0.5s)`，只是不再带档位）；`experiment-run.mjs` 的 `tacB` 默认值改 `CURRENT` 并在日志里打出真实生效标签。测试：`test/core/record.spec.ts` 与 `test/ui/experiment-report.spec.ts` 各 1 例钉住（键只能是 `['proxy\|v11-vct\|0', 'rapfi\||500']`）；`src/core/view/duel.ts` 的 `selfTest()` 补 6 条断言 |
| **对手的「混合链」没有任何一层看得见**（v12 复盘的真正发现，v11 两轮 rapfi 对照 + 逐手离线复算）：`vcfDefense` 只验**纯冲四**链（`vcfWin`），对手把收尾换成「活三逼迫 + 冲四」，它就放行；计时轮 175 个 v11 回合里「我方无杀而对手有链」**20 手（11%）**，其中**实走之后对手仍有链的 8 手（40%）全部落在三局负局**，而 8 手里 **4 手的实走正是对手的链首点**——占掉链首并没有拆掉整条链。另据独立实现逐手压力轨迹：对手「造四点」个数在杀棋前 **4–6 手**开始爬升，我方那几手还在跑 `live3Attack`。 | v12 新增**连续威胁防守**：引擎 `vctDefense(st, defenderId, maxPlies?, opts?)` 先算对手的链（有 VCF(7) 用它，否则算含活三逼迫的 VCT(9)），再按「链上各点 → 链点车氏 ≤2 邻域 → 全部邻近空点（按到链距离升序）」枚举候选（上限 `VCT_DEF_MAX = 12`），判据是**落子后对手既无 VCF(7) 也无 VCT(9)**（比 `vcfDefense` 严一档），并列拆法按「模型候选优先 → 对手造四点 ×2 + 活三点更少者优先」保留 `VCT_DEF_KEEP = 3` 个；战术层产出 `vct_win_opponent` / `vct_chain_opponent`，接管链在 `vcfDefense` 与 `live3Attack` 之间插 `vctDefense` 成**十三级**。候选集是四策略对照选出来的（只试链首 12/20、链首+链上各点 12/20、**+链点邻域 13/20**、全部邻近空点 13/20；首轮 19/21/21/22）——第三档多抓到的就是那两手（计时轮 `#8 ply24 → K9`、首轮 `#6 ply52 → K8`）。夹具（归档局 `f463acff…` 第 24 手）：黑 `vcfWin(7).first = 'I11'`，白`vctDefense` 给 `K9`（走 `K9` 后黑 VCF/VCT 全灭；走链首 `I11` 后黑两样都还在）。测试：`test/engines/tactics.test.mjs` 新增⑤d 五例（引擎层 / 拆点 soundness / 档位差异 / 决策级 / 闸门）。机制记录 [ADR-0016](adr/0016-vct-defense.md)。 |
| **`smoke:live` 把数据总量写死在断言里**：`stats.byGame === '{"五子棋":54}'`、`/api/experiments` 恰好 6 轮、写入后 `totalGames === 55` —— D1 现在是活的，真实验一多这三项就红（2026-10-01 真跑 4 局后实测 27/30） | 断言改成**相对基线**：`byGame` 只校验键都是七个中文棋种名且「五子棋」在册，轮次断言「≥ 6 且每轮有 tag」，写入后断言「跑前基线 + 1」（实测 `58 → 59`）。负向对照把 `+1` 改成 `+2` → 恰好那一项红、退出码 1；随后 30/30 通过 |

### 仍存在（2026-10-01 口径）

1. **引擎棋力**：对强搜索引擎的实战记录仍是 0-4（对弱/中对手 8-0-1）。迁移前后引擎逐手一致，这条没有变化。
2. **规则类未实现**：象棋长将/长捉判负、国象三次重复判和、中国跳棋「永堵营地门」都未实现；围棋只有 9 路。
3. **官方 API 浏览器直连不可行**（CORS 白名单），必须走同源 `/api/jev` 代理；未带 key 时返回 401。
4. **Jev 的概率判断仍可能出错**：「零幻觉」只保证输出结构体，不保证棋力判断正确。
5. **Rapfi 渠道**：单线程同步思考会阻塞 UI（思考中先 paint 一拍再同步跑完）；只支持五子棋；**首次要下 10.7 MB 资产**，而这在慢链路上是个真陷阱：实测生产域 `rapfi-single-simd128.wasm` 1,161,393 B / 14.7 s、`rapfi-single-simd128.data` 10,037,111 B / **447.7 s**（≈22 KB/s）；Rapfi 是**局中首次用到才实例化**，抓取失败时 Emscripten 抛的 rejection 没人接住 ⇒ `inflight` 永久占位、AI 循环停摆（上游零调用、页面只有一句 `TypeError: network error`、主线程仍有响应，2026-10-02 实测两次）。**应用侧未加保护**——本轮只把 `smoke:browser` / `experiment-run` 改成由本地 `public/rapfi/` 供给资产（`3bf480b`），真实用户在不稳定链路上仍可能撞上这种「看着在等 AI」的假死。`npm run smoke:browser -- --channel rapfi` 能自动验完这条路（实测 14/14，等待窗口 90 s）。
6. **战术档闸门**只影响 Jev 三渠道与 `random` 基线，`mock` / `rapfi` 早退不受影响。
7. **`sideConfig` 是一份全局设置**（localStorage 键与旧实现逐字兼容），不按局快照；实验会借走并在结束后归还。
8. **沿革竖列与设置抽屉改的是全局默认档**，不影响已经开打的那一局。
9. **移动端触控未专门优化。**
10. **历史归档的 `tactics_version` 恒为 NULL**：54 份归档里 54/54 都没有每手 `ai.tv` 声明，因此历史只能按 `code_version` 归因（unknown 28 / 0.7.0 20 / 0.8.0 6，且 20+6 全部落在 2026-09-30）。新写入的局才有每手 `ai.tac`。`tactics-versions.ts` 里 `VERSIONS[].games` 是迁移前的冻结快照，不是实证数字。
11. **旧深链对历史棋谱大多无效**：54 份里有 48 份没有 `slug`，`/api/games/:day/:name` 解析不到，只能用列表返回的 `path` 或永久链接 `/api/games/u/<gameUid>`。
12. **`*.workers.dev` 不是入口**（wrangler 默认关闭；本机网络也无法直连），唯一入口是自定义域 `jevqipan.logicc.top`。
13. **本地无法用 `--test-scheduled` 预演 Cron**：静态资产会先接管非 `/api/*` 路径，`/__scheduled` 拿回的是 SPA 兜底 HTML（200），`stats_cache` 不会有行——这不是 cron 失败。
14. **备份靠 CI 每日导出**（UTC 04:23，artifact 保留 30 天）；Worker 侧做不到 D1 导出。本地 `npm run db:export` 需要本机网络能连上 Cloudflare。⚠️ **2026-10-04 实测：这条自动备份目前是坏的** —— `backup` 工作流 10-02 / 10-03 / 10-04 三次调度**全部失败**，日志停在 `In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable`，根因是**仓库里一个 secret 都没有**（`gh secret list` 为空）；`deploy.yml` 的 `workflow_dispatch` 部署同样依赖这两个 secret。补齐 `CLOUDFLARE_API_TOKEN`（需 D1:Read）+ `CLOUDFLARE_ACCOUNT_ID` 后重跑 `workflow_dispatch` 即可恢复；在那之前**没有新鲜备份**（本机 wrangler 的 OAuth token 也已过期且无法刷新，`backups/export.sql` 仍是迁移当天的旧快照：54 局 / 4379 手）。
15. **离线降级是有意设计**（D8）：没有后端时是离线演示（mock 渠道）+ 本机战绩簿，不是白屏也不是报错。
16. **限流的两个已知取舍**：每次判定写一行（读接口的限流也消耗当天写配额）；固定窗口边界允许 2× 突发。
17. **`node:sqlite` 缺失时**，重放迁移的归因用例会被跳过；CI 用 `REQUIRE_SQLITE=1` 强制硬失败。
18. **`npm run golden` 预期失败**：金样生成器 `test/parity/generate.mjs` 依赖旧实现（旧引擎自对弈），旧实现在 P8 删除后它只打印中文说明并 `exit 1`。这是**设计如此**——金样已冻结为只读文物（封条 `test/parity/frozen.json`），本来就不该再生成。
19. **`src/ui/README.md` 的模块职责表未收录 P7c 三个面板**（`panels/replayer.ts` / `leaderboard.ts` / `openings.ts` 只在 §4.1 单独说明；`openings.ts` 的 `GAME_IDS` 属公共注册项）。
20. **浏览器端不发送 `X-Device-Id`**：`src/core/api/client.ts` 的 `call()` 只设 `Content-Type`，所以 UI 归档的棋谱 `device_id` 为 NULL，「只看我的」（`?device=me`）只有冒烟脚本这条路走得通。写路由对 `deviceId` 缺失是容忍的（外键只在有值时成立），落库不会失败——这是**待决**而非缺陷：要么让客户端带设备头，要么承认归档是公共的并撤掉 `device=me`。
21. **`jev` 档限流仍会挡住极端场景**：60 次/分对「机机对局 + 对比实验」够用（2026-10-02 两臂串行实测窗口峰值 **19 次/分**，零 429；此前 proxy-vs-proxy 那轮是 34 次/分），但同一出口 IP 下**同时**跑多个实验、或一轮里双方都用最慢思考档，仍可能触顶；触顶时的表现是自动退避重试（最多 3 次，约 41 秒窗口），再失败就交给用户。
22. **`games.tokens_out` 是一列死数据**：一局汇总 `aiGameMeta()`（`src/core/meta.ts:62-82`）只累加 `usage.input_tokens` 进 `meta.tokens`，导出的 `meta` 里**没有**输出 token；而 `src/shared/record-map.ts:376` 读的是 `meta.usage?.output_tokens`（局级 meta 从来没这个字段）⇒ 该列恒为 NULL。实测真实验 4 局的 `tokens_in` 约 645K 全都落库，`tokens_out` 全为 0。影响仅限「输出 token 的分析口径」（计费按官方口径输出免费，成本列不受影响）；要修就是给 `AiGameMeta` 加 `tokensOut` 并在 `record-map` 里回落读取——属可选增强，未做。
23. **`v10-live3` 的推演边界**：只算到 4 手（对手 >4 手的杀仍要靠 Rapfi 或对方失误）；`live3Deny` 报的是「能拆掉对手全部活三制造点」的点，**不是全局最优**（并列时取评估顺序里最先出现的，且最多只评 24 个候选点，候选顺序 = 对手 L3 点在前、其余按模型候选表）；`live3Makers` / `live3Deny` 在禁手档里会跳过黑方的禁手点（黑走不得，可能因此少报一个 L3）。推出的点若不在模型概率榜内会被直接执行并在 `meta.warning` 标注「战术保险接管」（与其余保险层同规则）。对照实验暴露的两个边界：**和棋多**（12 局里 4 局 225 手满盘和棋、全是 v10 执白 ⇒ 守得住但滚不起胜势）、**攻击层接管偏多**（`live3Attack` 12 局 120 手，闸门只检查「对手没有 2 手剑」，未比较 L3 点与模型首选的价值差）。

24. **A/B 局的「记录级 `tacticsVersion`」只反映黑方档位**：`src/core/record/export.ts:207` 写的是 `tacticsVersion: bCfg.tactics`，所以两臂用不同档位时（例如 2026-10-02 的 v10 实验：rapfi 执黑、proxy 执白），归档记录的顶层版本是**黑方**的，`games.tactics_version` 与「棋谱归档」面板的分组键也跟着走 —— 8 局 v10 臂里有 4 局被分到 `v9-vcf-sound` 组。权威字段是 `blackTactics` / `whiteTactics` 与每手 `ai.tv`（本次结论全部按这两个口径取），修法要么让客户端在混合档位时写「双方档位」要么让面板改按 `blackTactics`+`whiteTactics` 分组——属待决，未做。

25. **`v11-vct` 的推演边界**：搜索宽度写死（`VCT_PLIES = 9` = 5 手攻方着法、每层最多 `VCT_MOVES_MAX = 10` 个攻击方着法、`VCT_NODE_LIMIT = 3000` 节点、守方应手多于 `VCT_DEFUSERS_MAX = 6` 就不当作逼迫手）⇒ 更长的混合链（>5 手）看不见，应手极多的活三会被保守跳过（宁可漏判也不谎报必胜）；三个上限由 586 个真实回合标定，`10/3000/6` 与初版 `14/6000/∞` 看见同样 55 手必胜链，平均 607→422ms、p90 2430→1636ms、最坏 8837→4506ms（换缺省常量后复测）（[ADR-0015](adr/0015-vct-continuous-threats.md)「代价与不做什么」）；**最坏 4.6s 的重推演是同步阻塞**（发生在少数深局面，中位仅 13ms；实战单回合最坏：第一轮 2623–2830ms、计时轮引擎侧 3458ms / 整层 `tac_ms` 4474ms），尚未做时间预算以外的异步化；**不做**独立的「双活三 / 双威胁」层（24 局 914 个 proxy 回合实测真双威胁 **0 次**，做了是死代码）；`vctWin` 仍**不建模认输与禁手判负以外的规则**（与其余层同）。**连同 v10 遗留的两条**（为保持 A/B 单变量本轮不动）：`live3After` 判的是「盘面上存在 ≥2 个活四制造点」而非「本手新造」（密集局面 `live3_you` 可达 123 点，`pickAmong` 退化成取模型全局首选），提示词里 `live3_you … winning within four moves` 的措辞只对「两个活四制造点互相独立」成立——见 [ADR-0015](adr/0015-vct-continuous-threats.md) 背景与「代价与不做什么」。

26. **每日备份的 CI 工作流从来没有真正跑通过**（2026-10-02 首次触发即失败，见下）：`.github/workflows/backup.yml`（UTC 04:23 导出 + `verify:backup --structural`）与 `deploy.yml` 的 `workflow_dispatch` 都需要仓库 Secrets `CLOUDFLARE_API_TOKEN`（D1:Read）与 `CLOUDFLARE_ACCOUNT_ID`，而 `gh secret list` 是**空的** ⇒ wrangler 在非交互环境直接报 `In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable`、步骤 exit 1。当前**没有任何自动备份在跑**（手动 `npm run db:export` 仍可用，本机走的是 OAuth）。修法：项目所有者去 Cloudflare 建一个有 D1:Read（部署另需 Workers Scripts:Edit）的 API Token，再 `gh secret set`；在补上之前，第 14 条「备份靠 CI 每日导出」**只是设计意图、不是现状**。**2026-10-04 已加护栏**：`backup.yml` / `deploy.yml` 在 `npm ci` 后第一步就检查这两个 secret，缺哪个直接 `::error::` 点名并退出（不再让 wrangler 报那句像网络问题的含糊错误，deploy 也不再有「构建跑完才炸」）；已用 `gh workflow run backup.yml` 实跑验证（run `37207801935`：第 5 步如期报 `仓库缺少 secret： CLOUDFLARE_API_TOKEN（D1:Read） CLOUDFLARE_ACCOUNT_ID`，后续步骤全 skip）。

27. **`v12-vct-def` 的边界与代价**：它只能救「已经算得出对手有链、且盘面上还存在能拆的点」的局面 —— 首轮 + 计时轮合计 48 个「我方无杀而对手有链」的回合里，实走拆掉 33、漏 15，**漏的 15 个里只有 2 个存在能拆的点却没走**，其余 **13 个全盘候选都拆不掉**（点无回头路，局面在那之前就输了）；真正的入口是「对手造四点数的爬升期」（杀棋前 4–6 手）**不要抢着走自己的活三**，那是下一版（压力闸门）的事。成本上它比 v11 多一层：最坏局面会叠最多 12 个候选点 × 2 次搜索（`vcfWin(7)` + `vctWin(9)`），与 `v11-vct` 那条「最坏 4.6s 同步阻塞」是同一类风险（见第 25 条），**实战已回填**：v12 对照实验 198 个样本里 `tac_ms` 均值 381 ms / 最坏 4161 ms（与 v11 同量级）。**开火率低是有意的**（只在 `vcfDefense` 没找到点时才算，实测占我方回合 ≤11%）——低到 v12 对 `rapfi@500ms` 那一轮 **0 次开火**（198 回合里 42 个防守机会全被既有层拆掉）；**抬高 Rapfi 思考档后两轮各命中 1 次**（1 s 轮给了点但没走、2 s 轮实走就是它且链被拆掉），但**五轮累计真救仍是 0**：从来没有出现「不靠它就会输」的回合，败局全是「我方有杀 0 + 全盘没有拆点」⇒ 本版机制的实战价值是「堵住最后那 1 个可救点」，真正的强度入口仍是压力闸门（下一版）。

28. **`v13-pressure-gate` 的代价（已量化、A/B 已判定）**：闸门真接管时会**用攻势换安全** —— 三个 v12 回合 800 个 Jev 回合的回归扫描里真接管 26 手，对手做四手数更优 14/26、平均 −1.08 个，**但我们自己的做四手数平均 −1.92 个、13/26 让掉了进攻**（典型案例：夹具 `e3e417e6` ply8 实走 `E9/live3Attack` 后我方做四 4 / 对手 2，削点 `D12` 后对手 0 / 我方 0）。**同口径 A/B 的答案（2026-10-03）**：`rapfi@1000ms` 12 局 9 胜 0 和 3 负（75.0%），v12 同档 10 胜 0 和 2 负（83.3%）—— 一局之差在 12 局样本里落在噪声内，**比分口径回答不了「划不划算」**；能回答的是接管标签 × 局结果交叉表：四个进攻类层在 9 个胜局命中 79 手、3 个负局 0 手，三局「我方有杀」全为 0 ⇒ 输在赢不了，本层是纯防守机制、结构上治不了 ⇒ **保留、不再加码**（代价结论：实测 3.2 ms/次，没有把胜局变成负局，但也没有把负局救回来）。**20 局档位复核（2026-10-03）**：`rapfi@1000ms` 20 局 11 胜 1 和 8 负（57.5%）、`rapfi@2000ms` 20 局 13 胜 2 和 5 负（70.0%），两轮合计 40 个「拆不掉」回合**全部是全盘无拆点**（`.work/round1-report.log` / `.work/round2-report.log`）⇒ 闸门的代价没有升级成新的败因，但也没有把败局救回来；`vctDefense` 两轮合计开火 3 次、**真救 0**，至今未被实战检验（见 [v14 证据评审](plans/2026-10-03-tactics-v14-evidence.md)）。另：`pressureCut` 是 1-ply 手数量，**不搜杀**，所以它必须由 `danger_points_opponent` 这条安全线兜住「对手下一步就有杀」的局面（p18 夹具抓到过反例），这条守卫是启发式，不是证明；`live3After` / `live3Deny` 的旧口径缺陷当时**有意未动**（保持 A/B 单变量），**随后由 v14 修正**（见上方 v14 条）。

29. **本机 wrangler 的 D1 读路径也失效了**（2026-10-04 实测，比第 26 条更近一步）：`node .work/wrangler-run.mjs d1 execute jev-qiguan --remote --json --command "SELECT name FROM pragma_table_info('games')"` ⇒ `A request to the Cloudflare API (/accounts/6f8cd3a216c8de232d829099778d7c53/d1/database/f72390fe-a506-4a88-8db7-af7213657947/query) failed.`，notes `The given account is not valid or is not authorized to access this service [code: 7403]`（`kind: APIError`、`accountTag 6f8cd3a216c8de232d829099778d7c53`），exit 1。也就是说本机既有 OAuth 已过期（第 14 条），又**没有可用的 API Token** ⇒ 从这台机器上既不能查也不能导出 D1；阶梯计划的 §9 第 3 条因此改成**按仓库迁移 + `docs/status.md` 记录结案**（结论：`games.device_id` 存在，回填 26 局已完成）。恢复要业主补凭据（`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`）或重新登录，属业主决定项。

## 验收命令表

命令行里的脚本全部来自 [package.json](../package.json)（`npm test` = 引擎套件 + vitest 四个 project，**不含 `test:tactics`**，要单独跑；实测引擎套件 **153 个用例** + vitest **52 个测试文件 / 730 个用例**（含 `scripts` project：`test/scripts/**` 15 文件 / 355 例））。

| 命令 | 验什么 | 什么时候跑 |
| --- | --- | --- |
| `npm test` | `test:engines` + `test:new`（vitest 四个 project 一次跑完：worker/core/ui/scripts） | 提交前的总闸 |
| `npm run test:engines` | 引擎自检、战术十五级与 VCF/VCT 攻防、压力闸门削点、活三新造口径、**金样逐手差分**、54 局归档逐手重放 | 改引擎 / 战术层后必跑；也是最省事的一次全量回归 |
| `npm run test:tactics` | 战术层独立回归（`test/tactics/run.mjs`） | 改战术层时 |
| `npm run test:worker` | 真 workerd + 真 D1 的 HTTP 契约与维护任务 | 改 `src/worker/**`、`migrations/**` 后 |
| `npm run test:ui` | happy-dom 下的视图层与装配层运行时断言 | 改 `src/ui/**`、`src/app/**`、`index.html` 后 |
| `npm run test:scripts` | 远端批量实验设施（`test/scripts/**`：spec 解析、编排计划、Elo 与续跑判定纯函数） | 改 `scripts/**` 后 |
| `npx vitest run --project core` | 纯 Node：字段映射、会话、战绩簿、上传队列、迁移重放归因、版本双源一致性 | 改 `src/core/**`、`src/shared/**` 后 |
| `npm run typecheck` | TypeScript 全量类型检查（无输出） | 提交前 |
| `npm run build` | Vite 生产构建（静态资产 + Worker 产物） | 部署前 / 排查产物问题 |
| `npm run dev` | Vite + 本地 Worker + 本地 D1（`predev` 先迁移本地库，但**不导数据**） | 日常开发；本地库要数据需再跑 `import:archive --local` |
| `npm run db:migrate:local` / `db:migrate:remote` | D1 迁移（本地 / 远程） | 新增 `migrations/*.sql` 后 |
| `npm run import:archive` | 把 `games/**` 与实验归档导入 D1（`--local` / `--remote`） | 需要重建库时（幂等：用 `dedup_key` 去重） |
| `npm run verify:parity` | 新旧两套入口按同一口径对账，差值必须为 0 | 切流前后、改聚合口径后 |
| `npm run verify:backup` | 备份可重建（`--structural` 是定时任务用的结构模式） | 拿到 D1 导出后 / 排查数据漂移 |
| `npm run db:export` | 从远程导出一份 SQL 快照到 `backups/` | 切流前、发布前后留底 |
| `npm run smoke:live` | 真线上 HTTP 冒烟 30 项 | 部署后（**会写一行再删掉，注意线上数据**） |
| `npm run smoke:browser` | 真浏览器（CDP）冒烟 14 项（含归档分页的游标追加、实验报告分桶表、最新棋谱一键回放、服务端战报并入）；`--offline` 下三项在线断言让位给 2 项降级断言（共 13 项），`--channel rapfi` 验 wasm 渠道 | 部署后、改前端入口后 |
| `node scripts/experiment-run.mjs --games N` | 用干净 profile 的真浏览器跑一轮 A/B 对比实验并留 JSON 证据：填渠道与 key（**只从 `JEV_API_KEY` 环境变量读**）→ 点「开始实验」→ 轮询心跳（局数、上游调用次数与 HTTP 状态序列）→ 回查 `GET /api/games?tag=` 确认每局都进了 D1；页面停在「等人工重试」时代点 `#retryBtn`（计数）；默认把 `/rapfi/*` 改由本地 `public/rapfi/` 供给资产（`--no-rapfi-local` 可关），规程与四条坑见 [agents/playbooks.md](agents/playbooks.md) §7 | 改实验面板 / 渠道 / 重试逻辑后；**会真花上游配额**，日常不跑 |
| `npm run check:docs` | MEMORY 置顶、所有 md 相对链接可解析、status 日期在 30 天内 | 改任何 md 后（CI 里也跑） |
| `npm run deploy` | `vite build && wrangler deploy` | 发布（`deploy.yml` 同样只手动触发） |
| `npm run golden` | 重新生成金样 | **预期失败，别当成坏了**：金样已冻结为只读文物（封条 `test/parity/frozen.json`），生成器依赖的旧实现 `js/**` 在 P8 删除后它只打印中文说明并 `exit 1` |

## 下一步 / 未完成

按计划 §9（DoD）与 P8 的收尾清单，尚未完成的项：

1. **归档面板**已补「加载更多」分页（keyset 游标，首屏 50 份）；仍缺按 `code_version` 分组（现在按 `tactics_version` 分组，历史归档全是「未标注」）与按棋种/渠道/标签筛选（服务端 `?game=`/`?tag=`/`?since=` 都已支持，只是面板没给控件）。
2. **浏览器全流程回归**：计划附录 C 的 10 项手工清单里，页签/棋盘/渠道/开局/落子/AI 走子/曲线/抽屉/离线降级/Rapfi 首用懒加载/归档分页/实验报告分桶/最新棋谱一键回放/服务端战报并入已由 `smoke:browser` 自动覆盖（三种渠道全绿）；仍建议人工过一次七棋种各开一局、机机模式、换边重开、对比实验、人手认输、归档逐手回放。
3. **文档**：`README.md` / `docs/architecture.md` / `docs/status.md` / `docs/jev-api.md` / `AGENTS.md` / `docs/agents/**` / `src/ui/README.md` 均已收口，两份 ADR 索引（[docs/README.md](README.md) 目录树与 [docs/adr/README.md](adr/README.md) 表）都已补到 0018；`npm run check:docs` 绿（52 个 md / 348 个链接）。
4. **下一版入口由两条方向约束决定**（2026-10-02，[AGENTS.md](../AGENTS.md) §2 规则 10–11）：v10/v11 的败局都出在「算不出强制胜」的局面，所以优先做**无强制胜时的防守与长线取势**——要求是简单规则、快而不依赖长思考；**不**把 VCT 挖得更深。同一批待决项里，`live3After` 的语义纠偏（判「本手新造」而非「盘面上存在」）属于允许的「减法/纠偏」，**已于 2026-10-03 作为 v14 上线**（`b6c6921`）。**仍未闭环**：A 型速败（≤35 ½手被速杀）的「早盘为什么织不起活三网」属进攻侧开局形状问题（`docs/plans/2026-10-03-tactics-v14-fresh-live3.md` §8），以及 B 型长局（≥50 ½手、压力领先却换不了杀）——后者的两负实测都是「全程我方有杀 0」。**2026-10-03 更新**：v14 已按 m08704 抬档复核——`rapfi@1000ms` 12 局 9-1-2、`rapfi@2000ms` 20 局 **9-3-8**（不败率 60.0%）；**A 型的机制线在规则 10 之下判定收口**（静默普查 §4.3：早盘 72–95% 回合双方都没有 `vcf7`/`vct9` 胜，制造点 1.38 vs 0.42–0.45 是唯一指征，要抬它必须做 2-ply 以上规划 ⇒ 明令不做），剩下的杠杆是**配对样本**（同开局双跑）、模型侧提示、继续抬档看鲁棒性。**2026-10-03 收口（项目所有者）**：继续抬档已跑完（3 s 15-1-4、5 s 12-1-7，四档比分非单调）⇒ **机制线暂停、不再开新机制**（v14 是最后一版），只留维护、数据卫生与配对样本设计；恢复条件是「先有能分辨 5 pt 以内差异的配对样本口径」（详见 [v14 计划](plans/2026-10-03-tactics-v14-fresh-live3.md) §8 末尾的收口引块）。

5. **两份新计划的推进状态**（2026-10-03 起，业主 m13862「两个计划一起开工，可以先进行探测」）：
   ① [候选点三数 + 上游兜底](plans/2026-10-03-cands-metric-and-provider-failover.md)：**C0 已完成并部署**
   （`cands_sent`/`cands_labeled` 逐手落库 + `migrations/0003_move_cands.sql` + 报表「候选发评标」列，
   部署版本 `88d7f1fb-1e9a-47fa-909d-14afc43f0594`），C1 探针已证明 commandcode 的 `/systemone` 与本协议同形
   ⇒ 兜底是「base URL + model + key」三元组直换；**C2 已完成并 box 验收**（`providers.ts` 表 + 两个运行面
   共用切换判据 + 离线夹具 + 逐手 `prov`/`probs` 归因；生产路径默认关，见上「已验证」条目）；
   **C3 已完成**（`migrations/0004_move_provider.sql` 两列已应用到本地与远程 D1 + 报表「上游兜底 N 手（未计入主口径）」一行 + worker/ui 单测；见上「已验证」条目）；
   **C4 已完成（2026-10-04，由 L2 阶梯轮覆盖：直连上游 7440 手全 `primary`、兜底 0 手，成本对照已出）**；
   唯一遗留是**生产 Worker 尚未重新部署**（列已就位，部署后生产棋谱才开始写这两列，属业主决定项）；
   ② [战术可回溯 + 远端 Elo 阶梯](plans/2026-10-03-tactics-fidelity-and-elo-ladder.md)：**P0 闸门收紧 ✅ 与
   P0b 数据卫生/报表口径 ✅、P1 冻结层 ✅、P2 指纹设施 ✅、P3 回放 + 考古 ✅、P4 阶梯地基 ✅、P4b 离线运行面 + 桶留档 ✅、
   P5 Elo 升级（BT + bootstrap 区间）✅、P6 阶梯编排 ✅（含 box 端到端真跑、中断续跑与 `--force` 重跑）
   已完成**（见上「已验证」条目；
   P3 产出 [考古文档](plans/2026-10-04-tactics-archaeology.md)：14/14 档参数层确证 + 回放层一致率 100%），
   **阶梯报告 CLI 已落地**（`scripts/experiment-report.mjs` + `scripts/lib/report.mjs`：§7 的六项必出报表一条命令复算，
   见上「已验证」条目）；**编排进度轮询已改本地**（`--poll`，修掉「作业停在被 kill 的 ssh 上永不结束」那类悬挂）；
   **第一晚 L3 已跑完**（`l3n1`：3/3 轮 60 局 W27-D0-L33、墙钟 ≈34 分钟、零上游调用；结论与限制见
   [L3 报告](plans/2026-10-04-l3-rapfi-think-time.md)，摘要见上「已验证」条目）；
   **L2 也已跑完**（`l2n1`：15/15 轮 300 局 W234-D17-L49、墙钟 316.7 分钟、7440 个 Jev 手全 `primary`；
   结论与限制见 [L2 报告](plans/2026-10-04-l2-version-vs-rapfi.md)，摘要见上「已验证」条目）⇒
   产物留 box、**暂不推对象桶**（业主 2026-10-04 决定：桶地址未定，需要时再拉/推）；
   **下一步（业主 2026-10-04 已定）**：① **版本排序筛查 `vorder1` 已跑完（2026-10-05 02:30）：三版不可分** ——
   `v13-pressure-gate` vs `v11-vct`、`v13` vs `v14-live3-fresh`、`v11` vs `v14-live3-fresh` 三对 × 20 局 = 60 局
   （双方都是上游臂，实测 292 分钟），结果是**闭环** v11>v13>v14>v11、三对全是 57.5%／42.5%、三个身份得分率全 50.0%
   ⇒ 见上「已验证」条目与 [vorder1 报告](plans/2026-10-05-vorder1-version-screening.md)。
   **待业主拍板二选一**：A（推荐）接受「不可分」，把 box 时间投给 Rapfi 曲线（L4 正在跑）；
   B 只挑 `v11 vs v14` 堆 100 局配对（≈7.7 h）；**不建议**跑完整 L1（200 局 ≈15.5 h，每对仍 20 局 ⇒ 同样排不出名次）。
   **L4 高思考档正在跑（2026-10-05 02:30 起）**：`rapfihi1` = 10 对 × 20 局 = 200 局（5 个版本 × `rapfi@7000`/`@10000`），
   逐轮自动 `scp` 回本机；截至 2026-10-05 09:05 已收尾 **6/10 轮**（round-7 在跑），每轮墙钟 50–70 分钟、零 CF 调用；
   读数与硬边界见 [L4 报告](plans/2026-10-05-rapfihi1-rapfi-high-think.md)（§3/§4 待收尾后填）。
   同时报表新增**「版本 × 共同对手」矩阵**（第二把尺子，见上「已验证」条目）：截至 460 局，唯一在 5 个档位全部同向的
   版本对是 `v11 > v10`（100 局合并 Wilson 不重叠），其余 8 对全部翻转 ⇒ 与 vorder1 的「三版不可分」同向，
   **A/B 决策的推荐项（A）证据更足**。
   筛查判读已**机械化进报告第 4 节**（2026-10-05，`screenVersions()`，见上「已验证」条目）；
   ② **Rapfi 抬时间已按业主 2026-10-04 的口径改成「直接补到上限」**（原话「补 500ms，7000ms，到 10000ms」）：
   跨过 `@5000` 不单独跑，改跑 **`L4`**（5 版 × `@7000`/`@10000` = 10 对 × 20 局 = 200 局，预设 `c68aba5`，
   `--ladder L4`）；dry-run 粗估 ≈18 h（按每局 60 手）；**2026-10-05 用 `l2n1` 的 300 局真实手数重估 ⇒ ≈13–17 h**
   （版本 vs Rapfi 的局：手数均 49.3 / 中位 33 / p90 75 / 最长 225，Rapfi 侧手数均 24.5、上游侧单手 ≈2.4 s
   ⇒ `@7000` 均 3.9 min/局、`@10000` 均 5.1 min/局；最慢单局 17.7 / 23.3 min，单轮最坏也在 3 h 内，
   `pollRound()` 的 12 h 上限安全）。早先按 `vorder1`（**双上游臂**、均 90.3 手）外推的「≈26–35 h」作废 ——
   错在把两种形态的手数混为一谈。
   编排链（`.work/chain-l4.ps1`，v2）**已于 2026-10-05 02:30 自动执行完**：`vorder1` 三轮收尾 ⇒ 出报表 ⇒
   同步 box 到 `0b3fd28` ⇒ 串行起 `rapfihi1`（L4，10 对 × 20 局 = 200 局，日志 `.work/rapfihi1-ladder.txt`）；
   **2026-10-05 改成 v2**：窗口从 6 h 放宽到 **14 h**（v1 的窗口会在 round-2 中途到期 —— 两个强版本互守，
   round-2 单局已涨到 ~7 min、12 局里 9 和），并新增**停滞判定**：连续 45 min 本地进度三元组不推进时，
   用一次短 ssh 探远端 `/logs/round-N.pid` —— 活着（长局正常）就继续等，**死了就报警退出 3、不自动起 L4**
   （否则会用半截对照解释 L4，且两个作业抢 CPU 会让 Rapfi 的墙钟时间档失真）；**实况（2026-10-05）**：
   round-1（v10 vs `rapfi@7000`）20 局收尾 **W6-D4-L10**、墙钟 69 min（≈3.5 min/局，与 L2 手数重估的 3.9 min/局 同量级），
   阶梯自报剩 9 轮 ≈9.4 h；round-1 的报表冒烟（`--dir .work/remote/rapfihi1`）与 `loss-report.mjs` 都对**新增的 `@7000` 身份**跑通
   （曲线表自动多出 `7000 ms` 一行、`ΔElo` 为空、`⚠ <50` 提示；败局解释 10 局 20% 可用 ≤9 手 VCF 解释）。
   结果文档：[rapfihi1 高思考档](plans/2026-10-05-rapfihi1-rapfi-high-think.md)（§3–§6 待 10 轮收尾后填）；
   `--with-5000` 仍留在 CLI 里，需要补那一点时随时能跑（L3 的 `@5000 vs @1000` 已有 20 局样本）；
   ③ **P7（可选逃生门：`--rev <sha>`）仍待业主定**；
   P5 已量出分辨率底线：一次 200 局的 BT 只能分辨 ~30 Elo（平均绝对误差 27.9/35.6），
   所以「A 比 B 强」仍只允许写在配对样本上；
   P4b 已把「零 CF 依赖」做成默认：不写 `--origin` 时既不连业主 Worker 也不写 D1，direct 面禁止 `proxy` 臂
   （[ADR-0021](adr/0021-standalone-experiment-plane.md)）。
   **仍待业主拍板（2026-10-05 复核过的短名单）**：① 版本排序 **A/B**（见上）；② **P7 `--rev`** 做不做；
   ③ **对象桶用哪个**（endpoint/region/寻址样式；box 无 rclone/aws ⇒ 纯 Node SigV4，CLI 已就绪等地址）；
   ④ **生产 Worker 是否重新部署 + 兜底是否进生产路径**（`vars.JEV_FAILOVER` 仍为 `"off"`，列已就位）。
   已闭环、不再作为待批项的：计划范围（P0–P7 全做）、「第一晚 L3 是否含 `rapfi@5000`」（业主 2026-10-04 改为
   直接补到上限 ⇒ 跨过 `@5000` 跑 L4）。

> 已完成（P8，2026-10-01）：旧实现删除（`js/**`、`functions/**`、`legacy.html`、`server.js`、`dev-proxy.py`、`css/**`、旧测试三件套 `test/{run-tests,server-tests,rapfi-tests}.js`）、样式搬到 `styles/style.css`、`package.json` 摘掉 `test:legacy`、`index.html` 去掉硬编码渠道名与「六种棋类」、三块数据面板接线、CI 移除旧实现契约步骤并加 `REQUIRE_SQLITE=1`、版本双源统一为 `1.0.0`、Rapfi 注入接线并上线（版本 `170c9d07-584b-48b4-8117-cf4ccef19cec`）。
> 已核验（2026-10-02）：Cron `17 3 * * *` 的首次落库 —— `stats_cache` 有且只有一行 `daily:2026-10-02`，`updated_at = 2026-10-02T03:17:56.373Z`（调度时刻），`value` 报 `rateLimitsDeleted: 139`、`games: 82`、`moves: 7110`、`experiments: 11`，与 D1 当时的行数一致 ⇒ 定时维护真实执行、口径正确。
> 已完成（2026-10-01 下午，目标书「新能力」收尾）：归档面板 keyset 分页（版本 `3a4934ee-28c5-4e7e-88c9-214da988b707`）、实验报告分桶对比口径（`29788ef6-747a-4b08-9f0e-4aaea906ee36`）、服务端实验战报并入修复（`18b2fcad-39f8-4974-8e83-952076d83fa8`）、报告顶部「最新棋谱」+ 一键回放（`128ed7db-1b9d-4b84-a3a2-6ae6c9b6a10d`）；三渠道浏览器冒烟 mock/rapfi 各 14/14、离线 13/13。
> 已完成（2026-10-02 凌晨）：限流可重试标记 + 装配层自动退避（`781316c8-1845-47a6-8f73-e0bf22decffb`）、战术 v10 `v10-live3`（`a8a9130f-f5d8-4ee7-94eb-62e6dfdab86a`，**当前线上**）与它的对照实验回填（提交 `8751070` / `c5762d2`）。
> CI 已闭环：`test.yml` 提交 `88d7a9f`（run `36852997058`）五步全绿 —— 类型检查 / 构建 / 引擎与金样逐手差分（121 用例）/ vitest（真 workerd + 本地 D1）/ 文档校验。
> 前两次红都不是代码回归：第 55 个归档文件（旧站快照自动提交、D1 无对应，已删，归档口径恢复「等于 D1 的 54 局」）、以及两处链到被 `.gitignore` 忽略的 `backups/export.sql`（已改文本，并把「不许链到被忽略的产物」写进 `scripts/check-docs.mjs`）。
> 注意 `games/` 不是物理围栏：旧 `pages.dev` 快照仍持有 `GAMES_GITHUB_TOKEN`，还能往 `games/` 提交；护栏是 CI 里的归档断言（新增/改动即红）+ 事后删除。

## 路线图（候选，未承诺）

- **回放器体验**：逐手重放之上加「跳到关键手 / 双方耗时对照」。
- **开局库视图**：把 `/api/openings` 的聚合结果做成可浏览面板（现在只有接口）。
- **设备身份可迁移**：设置面板显示设备短码、支持粘贴恢复（设备 id 现在只在本机 localStorage，换浏览器等于换身份）。
- **规则补全**：象棋长将/长捉判负、国象三次重复判和、中国跳棋堵门判负、围棋 13/19 路。
- **明确不做**（计划 §13）：账号体系、实时对战（WebSocket/DO）、运维面板、多环境 D1、额外的 R2/KV/Queues 绑定、视觉重设计、改引擎规则。

## 技术债 / 注意点

1. ~~**版本口径不统一**~~ → **已修复（2026-10-01）**：`package.json` 与 `wrangler.jsonc` 的 `APP_VERSION` 都改成 `1.0.0`，`test/core/version.spec.ts` 逐字比对两处，并断言 `vite.config.ts` 仍从 `pkg.version` 注入 `__APP_VERSION__`。改版本号＝改一处（`package.json`）再改 `wrangler.jsonc`，忘了跑测试就会红。
2. ~~**旧文案残留**~~ → **已修复**：`src/core/jev/client.ts:117` 与 `:187` 的用户可见提示已改成「本地 `npm run dev` 起 Worker，线上由 `jevqipan.logicc.top` 提供」，不再提 `dev-proxy.py` / Cloudflare Pages。
3. **导出接口是 N+1**：每局要 2 次查询 / 2 行读取。想更省需要 `src/worker/db/games.ts` 提供一个「只取 payload」的查询。
4. **`compatibility_date` 停在 2026-08-22**：这是测试运行器内嵌 workerd 的上限，上调会让 vitest 起不来；升级 `@cloudflare/vitest-pool-workers` 时才能跟着提。
5. **`wrangler.jsonc` 改 `triggers.crons` 后必须重新部署**，否则线上还是旧的调度。
6. **本地 D1 库文件名由 `database_id` 派生**：换过 id（或改了名字）就等于换了一个空库，需要重跑迁移 + 导入，否则会看到 `no such table: games`。
7. **测试库共享**：worker 项目用 `singleWorker: true`，同一实例里的 D1 是共享状态，新用例必须自己清理数据。
8. **`npm run golden` 的失败是设计如此**（见「仍存在」第 18 条），别在 CI 里把它当回归。
9. ~~**文档索引过期**~~ **已关闭（2026-10-02）**：[docs/README.md](README.md) 的目录树与 [docs/adr/README.md](adr/README.md) 的表格都已补到 0015，`npm run check:docs` 绿（45 个 md / 277 个链接）。注意它只校验链接可达，**不校验新 ADR 有没有登记进索引**——新增 ADR 时要自己补两处。
10. **Rapfi 的 10 MB 资产仍由页面在局中现抓**（慢链路上会假死，见「仍存在」第 5 条）：本轮只修了工具链（本地供给），应用侧的重试/报错面与预取都未做——这是一条**已知未闭环**的风险，不是已修项。
11. **在 DSH 里直接跑 wrangler 会被参数解析坑掉（2026-10-03 实测）**：DSH 的 `node` 跑在 Electron 里，yargs 的 `hideBin()` 判定成「打包版 Electron 应用」而多切片一位，报 `X [ERROR] Unknown arguments: remote, …\wrangler-dist\cli.js, d1, …`；直接 `node node_modules/wrangler/wrangler-dist/cli.js …` 又会因为 `require.main === module` 守卫静默什么都不做（exit 0、无输出）。绕行包装（`.work/wrangler-run.cjs`，不入库）：

    ```js
    process.defaultApp = true;                 // 让 yargs 按「非打包 Electron」取 argv
    const Module = require('module'), path = require('path');
    const cli = path.resolve(__dirname, '../node_modules/wrangler/wrangler-dist/cli.js');
    process.argv = [process.argv[0], cli, ...process.argv.slice(2)];
    Module._load(cli, null, true);             // isMain=true ⇒ cli.js 里 require.main === module 成立
    ```

    用法 `node .work/wrangler-run.cjs <args…>`（`npm run db:migrate:remote` 等脚本在当前环境同样受影响）。

