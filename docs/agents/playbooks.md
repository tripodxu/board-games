# Playbooks：常见任务的固定套路

> 每一步都给出「做完怎么验」。**验收命令没跑过就不算做完**（[README.md](README.md) 黄金法则 4）。
> 迁移期用的旧验收命令（`node test/run-tests.js` 与 `npm run test:legacy`）**已随旧实现删除**，
> 替代品见各节：引擎/战术/金样走 `npm run test:engines`，其余走 `npm run test:new` 的分 project。

## 0. 动手前的两条筛子（2026-10-02 起，先读这条再选下面的套路）

项目所有者定的两条方向约束，**任何战术 / 策略 / 评估 / 棋力改动都要先过筛**：

1. **不吃搜索**——能一眼看清的简单规则、快而不依赖长思考的才做；往**深搜 / 强评估函数**靠的不做。
   现有搜索层只做减法或纠偏，不加深。如果一个方案的卖点是「搜得更深/更久」，那它出局。
2. **不唯胜率**——实验报告必须给 **胜 / 和 / 负 + 不败率**，并说明败局是怎么输的；
   **和棋可以接受、有时应该追求**，「负局不增加」优先于「多赢一局」。

细则见 [../../AGENTS.md](../../AGENTS.md) §2 硬性规则 10–11（面向读者的版本在 [../../README.md](../../README.md) 首节）；
出处是 2026-10-02 的 v10/v11 复盘：两局败局都出在「算不出强制胜」的局面，而不是漏杀——所以下一步该做的是
**无强制胜时的防守与长线取势**，而不是把已有的搜索挖得更深。

## 1. 新增一个棋种引擎

1. 读 [../engine-interface.md](../engine-interface.md) §1/§2/§6（注册方式、方法契约、7 步接线清单）。
2. 复制样板建文件：
   - 落子类（棋盘格线、连珠判定）→ 抄 `src/core/engines/gomoku.ts`；
   - 吃子/连跳类 → 抄 `src/core/engines/checkers.ts`（含 `chinese-checkers.ts` 的连跳链处理）；
   - 走子规则复杂类（王/车/马/炮、易位、过路兵）→ 抄 `src/core/engines/chess.ts` 或 `xiangqi.ts`；
   - 含提子/劫/数子 → `src/core/engines/go.ts`。
   导出 `create<Name>(id, name, …)` 工厂（一文件两变体如 `gomoku`/`gomoku-pro` 用第三参区分）。
3. 实现必需方法：`newGame` / `getLegalMoves` / `applyMove`（**纯函数，不改入参 state**）/
   `getStatus` / `moveFromNotation`（**双参契约，漏传 `st` 会在解析期炸**）/ `serializeForJev` / `selfTest`；
   按需要实现可选能力：`draw` / `humanClick`（渲染）、`passMove` / `mockPick` / `vcfWin`，
   以及 `supportsPass` / `supportsResign` / `deepTactics` 标记。
4. **公共文件交给编排者改**（不要自己动）：
   - `src/core/registry.ts`：`games` 增加键（**键顺序即注册顺序**，会影响首页棋种下拉与 `ids`）、
     必要时补 `export const <id>Pro`；
   - `src/shared/record-map.ts`：`GAME_NAME_TO_ID` / `GAME_ID_TO_NAME` 增加中文名 ↔ id；
   - `src/ui/panels/openings.ts`：`GAME_IDS` 增加 id；
   - `test/engines/run.mjs` 的用例清单。
5. 补测试：在 `test/engines/` 增加用例文件（沿用一个引擎一个文件的约定），
   `selfTest()` 至少覆盖 [../engine-interface.md](../engine-interface.md) §5 的六类断言
   （初始局面合法着法非空、记法往返、非法输入返回 null、标志性规则各一条、终局可达、
   重引擎 perft 计数如国际象棋 `perft(1/2/3)=20/400/8902`）。
6. 生成差分金样：**只有旧纯静态实现还在盘上时才可能**——`npm run golden`
   （`test/parity/generate.mjs`）拿旧实现逐手跑同一颗种子，产出「新旧零差异」的证据。
   2026-10-01 重构收尾把 `js/**` **删除**之后，生成器已无对照物：它只打印中文说明并 `exit 1`（**属预期**）。
   所以新增棋种的金样只能**从零建立**（直接由新引擎 `selfTest` + mock 自对弈产出），
   并在 PR 里写清「这不是新旧差分，而是新基线」，同时按
   [../../test/parity/README.md](../../test/parity/README.md) §2 的产物表登记、§7 走例外登记。
7. 验收：`npm run test:engines` + `npm run typecheck`；
   再更新 [../status.md](../status.md)「已验证」、[../memory/MEMORY.md](../memory/MEMORY.md) 顶部一条、
   commit 用 `feat(<id>): …`。

## 2. 修一个规则 bug

1. **先复现**：在 `test/engines/` 或 `test/core/` 写一条**会失败的**断言
   （报错信息里带局面、着法、期望值），先看它红。
2. 最小修复：只改 `src/core/engines/<id>.ts` 里对应的一段规则，不做「顺手重构」。
3. 补边界：同一规则的反例也要有用例（例如禁手：既验「该判的判了」，也验「不该判的没判」）。
4. 记取舍：为什么这么判（规则来源、与既有行为的关系）写进 commit message；
   影响对外行为的写进 [../status.md](../status.md)「已知限制」。
5. 验收：`npm run test:engines`（**金样差分必须仍然全绿**——如果它红了，说明你改的是行为而不是 bug，
   走 [../../test/parity/README.md](../../test/parity/README.md) §7 例外登记，不要改金样文件）。

## 3. 调整 Jev 请求 / prompt / 采样

1. 读 [../jev-api.md](../jev-api.md) §1（上游契约）与 §2（渠道）。
2. 改 `src/core/jev/client.ts`（请求组装、退避、成本、十四级战术接管）或
   某引擎的 `serializeForJev`（state 形状、`questions`/`criteria` 标签、`board_ascii` 之类的事实注入）。
3. **不要拆三问**：`move`(choice) + `edge`(noul) + `position`(score) 必须一次并行发出
   （[AGENTS.md](../../AGENTS.md) §2 硬性规则 6）。
4. 涉及战术注入时同步 `src/core/tactics.ts` 与 `src/core/tactics-versions.ts`，
   并在决定面板能看到 `meta.tactics` / `meta.tacticsVersion`。
5. 验收：`npm run test:worker`（代理路径的错误码与限流）+ `npm run test:engines`（战术层与
   `serializeForJev` 契约断言）；改 prompt 后建议真跑一局并在 [../status.md](../status.md) 记观察结论。
6. **BYOK 红线**：key 只允许出现在 localStorage / 请求头 / 服务端环境变量；
   任何日志、URL、响应体里出现 key 值都是 bug。

## 4. 改 UI / 交互 / 决策面板

1. 读 `src/ui/README.md`：§1 模块职责、§2 幂等策略（`render-*` 重建子树 / `sync-*` 就地更新 /
   `init-*`+`bind-*` 只绑一次，用 `dom.onOnce()` 的 WeakMap）、§3 存储注入、§4 DOM 契约。
2. 归一化路径：新面板放 `src/ui/panels/<name>.ts`，通过 `src/app/panels.ts` 装配进对局循环；
   需要新 DOM 时先在 `index.html` 加结构，再同步 §4 的表。
3. **别破坏三样东西**：
   - `?test=1` 自检入口（`src/app/boot.ts:191` 读 `location.search` → `src/app/self-test.ts` 的 `runTests`，
     面板靠 `#testPanel` + 逐字保留的 `hidden` 语义）；
   - 存储键名（`jev_qiguan_records_v1` / `jev-exp-history-v1` / `jev_qiguan_panels_v1` /
     `jev_qiguan_sidetab_v1`）——换键名等于清空所有人的本地数据；
   - `session.epoch` 竞态防护（主动权在 `src/app/loop.ts`，UI 只通过装配层回调）。
4. 新的设置项要同时接进 `src/core/persist.ts` 的 `loadSettings()`/`saveSettings()`
   与设置面板（并按渠道处理 `endpoints` 这种 map 型字段）。
5. 验收：`npm run test:ui` + `npm run typecheck`；改动涉及布局/滚动条时
   `test/ui/layout-css.spec.ts` 会兜住（它按 `styles/` → `css/` 顺序探测样式目录，
   而 `css/` 已随重构删除，实际只会命中 `styles/style.css`；
   它会把目录下所有 `.css` 拼起来断言，所以拆分子样式表不用改测试）。
   真机验证：`npm run smoke:browser`（真 Chrome over CDP，`--offline` 验无后端降级）。

## 5. 改部署 / 代理 / cron

1. 读 `wrangler.jsonc`（每行都有取舍注释）+ [../adr/0010-worker-static-assets-replaces-pages.md](../adr/0010-worker-static-assets-replaces-pages.md)。
2. 改配置后注意：
   - `assets.run_worker_first = ["/api/*"]` 不能去掉，否则未命中的 `/api/*` 会被 SPA 兜底
     变成 `index.html + 200`；
   - `compatibility_date` 刻意停在 `2026-08-22`（测试运行器内嵌的 workerd 只认到这一天），
     抬它要同时确认 `@cloudflare/vitest-pool-workers` 已升级；
   - **改 `triggers.crons` 必须重新 deploy 才生效**。
3. 代理相关改动（`src/worker/routes/jev.ts`、`src/worker/lib/upstream.ts`）坚持 BYOK：
   Worker 只转发与限流，不落 key、不重试。
4. 验收：`npm run test:worker`；本地 `npm run dev` 起真 workerd 手测；
   线上冒烟 `npm run smoke:live`（默认打 https://jevqipan.logicc.top）。

## 6. 发版 / 推送

1. 编排者跑全量：`npm run typecheck` → `npm test` → `npm run check:docs`。
2. 更新 [../status.md](../status.md) 的「最后更新：YYYY-MM-DD」与 [../memory/MEMORY.md](../memory/MEMORY.md) 顶部条目
   （`check:docs` 会校验 memory 首条日期不早于第二条、status 日期不超过 30 天）。
3. 提交：Conventional Commits，注释/文档/commit message 用中文，代码标识符用英文；
   一个 commit 只做一件事。
4. 部署是**手动**的：`.github/workflows/deploy.yml` 走 `workflow_dispatch`
   （可选先对远程 D1 应用迁移）；本地部署用 `npm run deploy`（需 `CLOUDFLARE_API_TOKEN`）。
   **push 不会自动部署**，也**不会**让旧站 `jev-qiguan.pages.dev` 变新——它是迁移前的只读旧站。
5. 发版后可选核对：`npm run smoke:live`（HTTP 冒烟）、`npm run verify:backup`（备份校验）、
   `npm run db:export`（导出远程库到 `backups/`）。
6. **仓库 secret 是自动备份与 `workflow_dispatch` 部署的前置**：`CLOUDFLARE_API_TOKEN`（D1:Read 即可导出）
   与 `CLOUDFLARE_ACCOUNT_ID` 必须存在于仓库 Settings → Secrets and variables → Actions。
   用 `gh secret list` 一秒核对；**空的话 `backup.yml` 每晚必红**（2026-10-02～04 连挂三晚就是这么来的，
   日志只会说 `In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN…`）。
   `backup.yml` 现在第一步就会把缺哪个 secret 明确报出来。

## 7. 跑对照实验（长跑无人值守）

脚本是 [scripts/experiment-run.mjs](../../scripts/experiment-run.mjs)（零依赖 CDP + 系统 Chrome/干净 profile）。
典型一轮：

```bash
$env:JEV_API_KEY = '<key>'    # 只从环境变量读；脚本只打印长度，不落盘
node scripts/experiment-run.mjs --games 12 --chanA proxy --tacA v14-live3-fresh \
     --chanB rapfi --thinkB 500 --port 9450 --timeout-min 180 --stall-min 10 \
     --out .work/exp-<臂名>.json
```

1. **先确认 Rapfi 资产走本地供给**（日志里应有「本地 public/rapfi/ 供给 … MB」）。线上 `.wasm` + `.data`
   合计 11.2 MB，本机链路实测 **447 s** ⇒ 让页面现抓会把实验卡在第 1 局（症状：上游只有 1 次调用、
   页面一句 `TypeError: network error`、主线程仍有响应）。`--no-rapfi-local` 只在专门验慢链路时才用。
2. **日志时间戳是 UTC**（本地 = +8），别把 `08:04` 当成早上八点；判断进展看「上游调用次数」，
   不要看页面决策流水（它最多 40 行就满了）。
3. **认本轮只认「台账基线之外的新 tag」+ 归档行数**：基线可能在服务端合并落地之前读到，
   凭「最新一条」会把上一轮当成这一轮。
4. **两臂都用 Jev 时不要并行**：同一出口 IP 共享 60 次/分的 `jev` 限流，必须串行；单局时长差别很大
   （12 局里最快的 22 手约 3 分钟，最长的一局 225 手满盘和棋跑了 22 分钟），`--timeout-min` 要留够。
5. 跑完三件事：`--out` 的 JSON（逐局结果 + 上游计量 + 页面错误）、`GET /api/games?tag=<tag>&limit=100`
   （确认每局都归档）、逐手证据用
   `npx wrangler d1 execute jev-qiguan --remote --command "SELECT mv.side, mv.tactics, COUNT(*) FROM game_moves mv JOIN games g ON g.id = mv.game_id WHERE g.experiment_tag='<tag>' GROUP BY mv.side, mv.tactics"`。
   ⚠️ **连表必须写 `g.id = mv.game_id`**：`games.game_id` 是**引擎 id 文本**（全是 `gomoku`），
   数值主键是 `games.id`；`game_moves.game_id` 引用的是后者。写成 `g.game_id = mv.game_id`
   会静默返回 0 行（不报错），很容易把「查不到」误读成「没有数据」。
6. **战术层耗时是必报项**（只要那一臂是 `proxy` 渠道）：
   `SELECT COUNT(*) AS 局数, ROUND(AVG(tac_avg_ms)) AS 战术层均值, MAX(tac_max_ms) AS 战术层最坏 FROM games WHERE experiment_tag='<tag>'`；
   拆到每一侧用
   `SELECT mv.side, mv.tactics_version, COUNT(mv.tac_ms) AS 有样本手, COUNT(*) AS 总手, ROUND(AVG(mv.tac_ms)) AS 本手均值, MAX(mv.tac_ms) AS 本手最坏 FROM game_moves mv JOIN games g ON g.id = mv.game_id WHERE g.experiment_tag='<tag>' GROUP BY mv.side, mv.tactics_version`。
   **`tac_ms` 为 NULL 不是 0**：Rapfi / mock 侧刻意不过战术层，所以 `AVG` 的样本天然只剩 Jev 侧；
   要判断覆盖面就看「有样本手」与「总手」的差。列与口径见 [../architecture.md](../architecture.md) §4。
   **读成本时把两个口径分开**：`game_moves.ms` 是「战术 + 上游（含重试等待）」的**单步墙钟**，
   随上游快慢在 1 s～10 s 之间浮动（同一臂不同轮实测 1.0 s / 3.5 s / 10.1 s），
   `tac_ms` 才是战术层本身（实测均值 **402 ms** / 最坏 4474 ms）；报「战术层占单步比例」时要用同一轮的 `ms` 做分母。
   **对手的固定档从 2026-10-03 起落库**：`games.black_think` / `white_think` 只在该侧渠道是 `rapfi`
   且预算 > 0 时写（毫秒，`src/core/record/export.ts:thinkMsOf()`）；`proxy` 侧留 NULL（它的「思考时间」
   是模型往返，不是配置）。更早的轮次这两列是 NULL，要报「Rapfi 固定档」只能回头翻
   `.work/exp-arm*.json` 的 `config.thinkB` 与展示名 `Rapfi(1s)`；UI 侧上限 10 000 ms 来自
   `index.html` 的 `#expThinkA/B` 选项。
7. **战术档标签只在 Jev 渠道有意义**：`games.black_tactics` / `white_tactics` 与 `game_moves.tactics_version`
   只描述**真正跑战术层的那一侧**（`proxy` 等 Jev 渠道）。Rapfi / mock / 人类的档位标签一律为空（NULL），
   因为它们压根不进 `computeTactics`——2026-10-02 计时轮就因为实验脚本的旧默认值给 Rapfi 侧写上了
   `v9-vcf-sound`，报表里冒出 `rapfi|v9-vcf-sound|500` 这种并不存在的身份。**判一侧的身份要看 `*_channel`，
   别把 `*_tactics` 当对手的属性**；同理 `tac_ms` 为 NULL 的那一侧就是不过战术层的那一侧。
8. 结果写进 [../status.md](../status.md)「数据现状」与对应 plan/ADR，**同时报胜 / 和 / 负与不败率**，
   并单独交代败局是怎么输的（§0 的两条筛子）。
9. **思考档阶梯（m08704 的执行口径）**：某一档的胜率**逐版稳步上升**之后才抬对手的思考时间
   （已跑：`rapfi@500ms` → `@1000ms` → `@2000ms`），每档同口径、同开局、同 12 局黑白交替
   （2026-10-03 两轮起改 20 局：v13 与 v14 在 1000/2000 ms 各 20 局）。
   抬档后**曲线回落是正常的**（v12 实测 100% → 83.3% → 62.5%；v14 实测 1 s 轮 9-1-2 → 2 s 轮 9-3-8），
   它的用处是把新机制逼到开火：`vctDefense` 在 500 ms 档 0 次开火，抬档后两轮各命中 1 次。
   **判读纪律**：同档轮间方差实测 17.5 个百分点 > 档位之间的差 ⇒ **跨档位比分不是曲线**，
   抬档只读作「对手变强」；要判断机制收益必须上**配对样本**（同开局双跑）。**报占比时用同一轮的 `ms` 做分母**，
   并把「模型往返」与「战术层」分列（`tac_ms` 是必报项，见第 6 条）。
10. **败局体检三步**（判定「漏防」还是「早就输了」）：`node .work/v12-round-postmortem.mjs <tag>` →
    ① 看负局是不是**全程「我方有杀 0」**；② 看「拆不掉」的手是不是逐条都标「全盘没有拆点」；
    ③ 只有「有拆点却没走」（真救 > 0）才算漏防，那才是防守层的活儿；否则问题在**更早的织网期**，
    该动的是进攻选择（例如压力闸门），不是再加一层防守。
11. **两条会让冒烟/探针假红的环境坑（2026-10-03 实测）**：
    ① **node 的 `fetch` 不走系统代理**。本机系统代理是 `127.0.0.1:10808`（注册表 `ProxyEnable=1`）——
    PowerShell 的 `Invoke-RestMethod` 与 `curl.exe` 走它，而 Node 的 undici 直连 Cloudflare IP，
    于是 `npm run smoke:live` 与 `.work/*.mjs` 探针会**偶发** `UND_ERR_CONNECT_TIMEOUT`（同一分钟 curl 却是 200）。
    跑 node 网络脚本前先设 `$env:HTTPS_PROXY='http://127.0.0.1:10808'; $env:NODE_USE_ENV_PROXY='1'`
    （Node 24 起支持后者；实测 3/3 成功、单次约 300 ms）。Chrome 走系统代理，所以长跑实验不受影响。
    ② **同一个 D1 里混着不同写入者**：SSH 远端批量设施（`scripts/experiment-batch.mjs`，ADR-0019）
    在空闲主机上直连线上库落 `random`/`rapfi` 批次，tag 形如 `exp-20261003042812-rapfi1-r1`。
    它有 `experiments` 行，但 2026-10-03 修复之前跑的 26 局：`code_version` 只写 `dev+nogit`
    （Node 直载没有构建注入）、`device_id` 为 NULL ⇒ **不能与浏览器轮的 `1.0.0+<sha>` 放同一条归因链**。
    此后 worker 会带 `X-Device-Id: ssh-batch`（可 `BATCH_DEVICE_ID` 覆盖）并把提交自报进 `meta.code`
    （`dev+nogit+<sha>`）：**要单独筛远端轮次用 `device_id='ssh-batch'`**，或用
    `code_version LIKE 'dev+nogit+%'`。
    那 26 局已于 2026-10-03 按 tag 回填 `device_id='ssh-batch'`（P0b 数据卫生，`device_id` 是唯一改动，
    **`code_version` 保持 `dev+nogit` 不动**——不猜 sha）：回填前先补 `devices` 行，因为
    `games.device_id REFERENCES devices(device_id)`，直接 update 会撞 `SQLITE_CONSTRAINT_FOREIGNKEY`：
    ```sql
    insert into devices (device_id, first_seen, last_seen, label, ua)
      values ('ssh-batch', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              'SSH 远端批量对弈（ADR-0019）', 'scripts/experiment-worker.mjs')
      on conflict(device_id) do nothing;
    update games set device_id='ssh-batch' where device_id is null and experiment_tag in
      ('exp-20261003042812-rapfi1-r1','exp-20261003052056-smoke1-r1','exp-20261003052604-x1-r1');
    select count(*) from games where device_id='ssh-batch';   -- 期望 26（+ 此后新跑的远端局）
    ```
    注意 `devices` 里本来一行都没有（浏览器轮也不写 `X-Device-Id`），所以 `device_id` 为 NULL **不等于**
    「远端局」：只有这三个 tag 是设施产物，按 tag 认、别按 NULL 认。
    **按 `experiment_tag` 过滤的分析不受影响**；`scripts/smoke-live.mjs` 已把「全局计数恰好 +1」的
    断言放宽为「至少 +1」。
12. **报表只准聚合口径（P0b / §3.1 第 5 条，2026-10-03 起写死）**：
    ① **允许的**：胜 / 和 / 负、不败率、得分率 + **Wilson 95% 区间**、接管直方图（`tactics_hist` 计数）、
    成本三口径（`tac_ms` 中位/均值/最坏、单步墙钟 `ms`、上游 token/美元）、开局分层、Elo（`batch-elo.mjs`）。
    ② **不允许的**：跨机「逐手对齐」、把某一局的第 k 手两边摆在一起比、用 Node 侧复算去核对浏览器归档的
    单步耗时。原因见 ADR-0019「后果」：Node rapfi 与浏览器归档的推理路径/浮点/时机都不同，
    **逐手比对不可复现，拿它当证据就是伪证据**；单局逐手对齐只允许在**同机同进程**内做（引擎自检、
    `.work/` 的同进程探针）。
    ③ **每个数都要带样本量与区间**：样本 < 50 局时 `formatRankTable()` 印 `±XX.Xpt ⚠`
    （20 局/对 ≈ ±20 pt），同档轮间方差实测 17.5 pt > 档位之间的差 ⇒ **跨档位比分不是曲线**，
    一句「这一档更强」在没有配对样本（同开局双跑）之前不成立。区间重叠就写「不可判」。

## 8. 远端阶梯作业（在 box 上本地跑 Elo 大数据，不碰业主 Worker）

对应口径（业主 m13876）：「最终可以使云服务器跑 elo 大量数据，不消耗太多 cfworker 资源」。

```bash
# 1) 先同步 box —— clone 的 refspec 很窄，普通 `git fetch origin main` 不会更新 origin/main
ssh myserver 'cd /root/board-games && git fetch origin main:refs/remotes/origin/main -q && git checkout -B main origin/main -q && git log --oneline -1'
# 2) 起一条阶梯（缺省串行、轮间冷却 30 s、产物留 box、上游直连）
node scripts/experiment-ladder.mjs --ladder L2 --batch <id> --games 20 --poll 60
```

1. **一次只跑一条**：Rapfi 的思考时间是**墙钟**，两条并行会互相抢 CPU ⇒ 时间档失真
   （`--parallel` 被直接拒跑；不同天先跑完 `vorder1` 再起 `rapfihi1` 也是同一个理由）。
2. **准备阶段 2–4 分钟是正常的**（建目录 → 上传全部计划 → 逐轮读 tag，每趟 ssh 12–20 s）：这期间远端
   只有 `plans/`、没有 `round-N/`，**别当启动失败手工补启动**（2026-10-04 双写事故就是这么来的；
   现在远端有 pid 守卫，但手工起的 worker 绕开编排照样双写）。
3. **进度看本地**：`--poll 60` 每分钟一次**捕获式**短 ssh（长命 ssh 会继承 stdout 管道，
   编排一死作业就永不结束）；`--quiet` 只留轮首行。SSH 侧 `status --watch` 仍是有意保留的前台循环，
   Ctrl-C 结束、**别塞进后台作业**。
4. **零 CF 依赖是默认**：`--store local` + `--upstream direct` ⇒ 不写 D1、不连 Worker
   （日志会打「store=local：未触碰业主 Worker」）；只有 `--store d1` 才需要 `--origin` + `--allow-production`。
   要给「没碰生产」留证据就比对跑前跑后的 D1 行数（本机 D1 读路径 2026-10-04 起失效，
   见 [../status.md](../status.md) 已知限制第 29 条）。
5. **key 走文件**：box 上 `/root/.jev-key`（official）+ `/root/.cc-key`（commandcode 兜底）；
   只有 `--expect-backup` 才要求兜底 key 存在；日志只报来源（`official←file:/root/.jev-key`），不打印 key。
6. **规模与时长**看阶梯计划 §7 的四条阶梯表；`--games` 必须偶数（`--allow-odd` 才放行）；
   `--max-rounds N` 是**截断本次编排**，不是「先跑 N 轮、之后再续」。
7. **产物与拉回**：box `<batch>/{ladder.json,lines.txt,plans/,logs/,round-N/{games.jsonl,progress.json,
   round-summary.json,events.jsonl,games/,checkpoint/}}`；`node scripts/experiment-batch.mjs pull --batch <id>`
   （位置参数会被忽略，必须写 `--batch`）；桶推送是可选（缺凭据只告警、不阻断）。
8. **报表**：`node scripts/experiment-report.mjs --batch <id> --out .work/<id>-report.md --json .work/<id>-report.json`；
   多批合并用 `--dir a,b`（`gameUid` 全局去重、按身份聚合）；**未收尾的轮**默认读入并在报告头标注
   （收尾凭据 = `round-summary.json`），要排除就加 `--skip-incomplete`。
9. **败局解释（规则 11，必报项）**：`node scripts/loss-report.mjs --batch <id>`（形态 + 追因一次出；
   同门对局加 `--mirror`，两侧各出一个视角 ⇒ 局数 = 棋谱 ×2）；只想要形态加 `--no-vcf`（秒级），
   要控成本用 `--tail`/`--plies`。**追因数字必须带档报**（`--plies 7` 与 `--plies 9` 的「不可逆点」
   是 13/49 与 14/49），且报告里要连边界句一起抄：「VCF 只解释 found/l，查不到 ≠ 没输在更早的地方」。
10. **回读纪律**：n=20 的单对半宽 ≈ ±20 pt ⇒ 不许据此排版本名次；只有配对样本到 100–200 局才能写
    「A 比 B 强」。战术层耗时与成本对照是**必报项**（第 6 条 + 阶梯计划 §7 的六项报表）。

