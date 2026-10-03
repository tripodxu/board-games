# ADR-0019：SSH 远端批量对弈实验设施（纯 Node 对弈回路 + 本地编排器）

- 状态：accepted（2026-10-03）
- 背景：浏览器实验链（`scripts/experiment-run.mjs`，CDP 真浏览器）单局 3–22 分钟、
  12 局一轮约 3450 s，且独占本机——想同时跑多组对照只能排队。需求（m00002）：
  **把批量实验搬迁到空闲 SSH 主机上跑，双方/强度/战术/间隔可自由选，时间允许时自动算 Elo**。
  先做了两份前置文档：`docs/plans/2026-10-03-tactics-coupling-audit.md`（版本耦合性审计，
  回答"并行跑不同版本是否安全"）与 `docs/plans/2026-10-03-remote-batch-experiments.md`（本 ADR 的实施计划）。

## 事实基线（写代码前逐条验证）

1. **对弈回路可以完全脱浏览器**：`decide` / `getGame` / `createSession` / `buildGameExport`
   全部可被纯 Node `import`（`src/core/jev/index.ts:20`、`src/core/registry.ts:44`）。
   探针 `.work/probe-node-game.mjs` 在 Node 跑完整五子棋：v13 档 26 手白胜、v0 档 80 手白胜。
2. **rapfi 臂也可以在 Node 跑**：`public/rapfi/rapfi-single-simd128.js` 是 UMD，复制成 `.cjs`
   后用 `createRequire` 加载即可（`.mjs` 直接 eval 会撞 `ERR_AMBIGUOUS_MODULE_SYNTAX`）。
   Node 与浏览器**同资产同输入逐手一致**（见「验证」§4），强度可比。
3. **浏览器实验器的三个生态依赖**（面板 DOM、rapfi `<script>` 注入、localStorage 簿）
   全部可替换为等价物：状态机=文件 checkpoint、rapfi=Node loader、簿=棋盘 JSON 文件。
4. **目标机约束**：`185.242.234.48`（alias `qijia`）Ubuntu 22.04、2×Xeon E5-2698 v4、
   **可用内存仅 1.3 GiB、无 node/npm/浏览器** ⇒ 装 Chrome 跑 CDP 实验器不可行
   （内存不够、`experiment-run.mjs` 也缺 `--no-sandbox`）。
5. **限流与配额**：线上 jev 30 次/分/IP、D1 免费 10 万写/日 ⇒ 双上游臂必须串行；
   单轮 12 局 ≈ 62 行 D1 写，远低于配额。

## 决定

1. **远端执行 = 新写纯 Node 对弈回路**（`scripts/experiment-worker.mjs`），不改造 `experiment-run.mjs`、
   不在远端装浏览器。worker 只依赖 `src/core` 的公开导出 + `fetch`（Node ≥ 22.18，与仓库一致）。
2. **本地编排器 `scripts/experiment-batch.mjs`**（子命令 submit / resume / status / pull / elo），
   经 ssh/scp 驱动远端；远端 worker 用 `nohup … </dev/null &` 脱离 ssh 会话（实测比 setsid 快 4 倍：
   ~2.4 s vs ~10 s 返回）。
3. **断点续跑 = 文件 checkpoint**：每局一文件（`checkpoint/round-<r>-game-<n>.json`），
   `status ∈ {ok, ok-dry, skipped}` 即跳过 ⇒ kill -9 后 `resume --batch X` 接着跑，
   不重复花上游配额。
4. **对局规格 spec 字符串**：`渠道[:战术档[:思考ms]]`（如 `rapfi:v12-vct-def:1000`）。
   **未知渠道/档位/非整数 ms 直接抛错**——`resolve()` 对未知档号是**静默回落 CURRENT**
   （`src/core/tactics-versions.ts:96-99`，测试固化的"特性"），A/B 写错档号会静默变成 v13，
   因此解析层必须显式校验。
5. **种子与可复现**：每局 `setSeed(deriveSeed(seed, gameNo))`（`src/core/rng.ts:30`）；
   但 rapfi 臂的**绝对着法受引擎墙钟影响不可逐字复现**（见「验证」§4），
   因此实验结论只认聚合口径（胜/和/负 + 不败率），不认单局复盘。
6. **并发口径**：双上游臂强制 1；单上游臂可 2–3；submit 打印速率预算，
   > 40 次/分需 `--force`。
7. **Elo = 自研小模块** `scripts/lib/batch-elo.mjs`：身份口径 `渠道|战术档|思考ms`
   （空归 `-`，防止 `rapfi:1000` 与 `rapfi:2000` 混档；快来的 mock/rapfi 不写战术档）；
   顺序迭代 K=16、和棋 0.5、< 50 局标注 ⚠ 样本不足。**不引 Glicko**（样本量不支持，
   且和棋在五子棋里多是"棋盘已满"而非"势均"）。
8. **测试接线**：`test/scripts/**/*.spec.mjs` 进 vitest 第 4 个 project（`scripts`），
   `npm test` 自动覆盖（`test:new` 已含全部 project）。
9. **凭证纪律**（AGENTS.md 铁律 7）：key 只从环境变量读；远端放 `/root/.jev-key`（chmod 600、
   仓库外），worker 启动命令 `set -a; . /root/.jev-key; set +a` 注入 ⇒ key 不进 argv/日志/仓库。

## 代价与不做什么

- **不做** `experiment-run.mjs` 改造：浏览器链是线上同款回放路径，归档口径必须与历史一致，
  新工具另起一条路、只向同一 D1 归档（`POST /api/games` + GET 核对）。
- **不装 Chrome/CDP**：目标机内存 1.3 GiB 不够；且 `--no-sandbox` 缺位。
- **不做** systemd / daemon：`nohup` + pid 文件 + `resume` 足够，运维面最小。
- **不做** gomoku 以外棋种、Glicko-2、战术层修复、worker 端改动（本 ADR 只加工具）。
- **接受**：Node 与浏览器跑同一归档局时**逐字复盘不一致**（墙钟），
  判据改为"Node↔Edge 命令流重放一致"（见「验证」§4）。

## 验证

1. **单测**：`test/scripts/` 29 例（batch-common 20 + batch-elo 9）全过，
   覆盖 spec 解析拒绝静默回落、tag 生成（秒级 batch 前缀）、Elo 顺序迭代、
   `games/` 目录过滤（防 round-summary 被当棋谱）、< 50 局标注。
2. **dry-run 全绿**：本机 mock vs random ×4、rapfi::500 vs random ×2 全 ok-dry，
   产物字段（归因链 `channel|tv|think`）与浏览器归档同构。
3. **kill -9 续跑**（box，batch kk1，×6 dry-run）：跑到 3/6 时 `kill -9`，
   `resume` 后 1–3 skipped、4–6 续跑，6/6 完成。
4. **rapfi 强度 gate**（Node vs Edge，同资产同输入）：
   - Node 侧复现自对弈命令流 **12/12 一致**；重放浏览器归档局 `66a7fbaf`
     （v12 黑 vs rapfi 白）也 **12/12 一致**。
   - 对归档局 `exp-20261002115126` 逐手比对 165/192=85.9% 不一致的**残差定位**：
     Node 与 Edge 报相同的 `ERROR Unable to open model file: "model210901.bin"`
     （`.data` 里本就没有 39 MB classic model，**两端共有的既有状态**），
     引擎跑缺省配置；不一致手（ply8/ply12）上 Edge 与 Node 给出**相同着法、都不等于归档**
     ⇒ 残差是浏览器运行时的墙钟抖动，不是 Node 退化。
   - **判据**：Node rapfi 臂与历史浏览器 rapfi 臂强度可比（同资产、同输入、同行为）。
5. **真归档闭环**：submit `--a rapfi::500 --b random:v13-pressure-gate:0 --games 12`
   ⇒ 12/12 ok，checkpoint `verified=true`（POST /api/games 后 GET `?tag=` 按 `gameUid`
   核对，camelCase）。
6. **归因修正**（跑第一轮真归档时发现）：worker 不透传 `session.settings.apiKey` 时
   `effectiveChannelOf`（`src/core/persist.ts:158-173`）把 `random` 兜底成 `mock`，
   归档 slug 显示 "mock-vs-rapfi"（结构化字段仍正确）⇒ playOne 透传 key 修复；
   另补 `blackThink/whiteThink`（`export.ts` 的 GameRecord 不含 think 字段，
   浏览器上传也不带，D1 `black_think` 恒 null ⇒ 不同思考档不可分辨）。
7. **全量**：`npm test` 375 例 / 37 文件全过（含 x1 追加轮后修复的 Elo 和棋口径）；
   `npx tsc --noEmit` 0 错；`npm run check:docs` 通过。

## 追加轮与一个口径修正（x1 后）

- **x1 轮**：`proxy:v13-pressure-gate` vs `rapfi@500ms` ×12 ⇒ 12/12 ok（含 2 局 225 手满盘和棋）。
  合并 rapfi1/smoke1/x1 三轮 26 局：`proxy|v13|0` **1551.9**（10胜2和2负）>
  `rapfi|-|0` 1503.1（6-0-6）> `random|v13|0` 1481.4（6-0-8）> `rapfi|-|500` 1463.6（2胜2和8负）
  ⇒ proxy·v13 对 rapfi@500ms 合计 **6 胜 2 和 4 负**，全部 ⚠<50 局。
- **Elo 和棋口径修正**：和棋在导出/D1 里**没有 `winner` 字段**（`result:"和棋（棋盘已满）"`，
  `record-map.ts:251-258` 对和棋给 `winner:null`）⇒ 只认 `winner==='draw'` 会把和棋当未终局丢掉
  （x1 一度只算 22/24 局）。改为按 result 串识别（与 `parseResult()` 同形正则）——
  否则「不唯胜率」在工具侧就破了。

## 合入 main 后的整改（2026-10-03，独立审查驱动）

分支把「浏览器侧的四条坑」搬到了远端，但设施自身在**归档与续跑**这两条路径上留了五处真缺陷（审查结论：不建议原样合并）。
它们不是新决定，而是把已有决定落实到代码里，因此记在这里做**修订记录**（细节与改动清单见
[计划 §P6](../plans/2026-10-03-remote-batch-experiments.md)）：

- **思考档写值域闸门**（与 ADR 口径一致）：`black_think`/`white_think` 只认 `rapfi` 侧且 > 0，其余留空（D1 落 NULL），
  复用 `src/core/record/export.ts` 的 `thinkMsOf()`——否则 `proxy` 会以「0 毫秒档」这种不存在的身份进库。
- **档位标签过 `tacticsLabel()` 闸门**：`games[].blackTac/whiteTac` 不再直接写 plan 里的原始档位，
  免得 rapfi/mock 侧造出 `rapfi|v13-pressure-gate` 这类幻影身份（与 2026-10-02 的 `rapfi|v9-vcf-sound` 同类）。
- **轮次串行**：`--rounds>1` 起一轮 → 等 pid 退出 → 再起下一轮（D6「双上游必须串行」的落地；
  原先一口气 nohup 全部轮次，等于把上游速率与 D1 写入按轮数翻倍）。
- **续跑语义**：checkpoint 命中要**回读 winner/plies/gameUid** 并计入实验档案；`resume` 与 submit 同样注入 key；
  batchId 缺省带时分秒、同名批次直接拒绝、checkpoint 的 tag 失配即重跑（防「一局不跑却 POST 一行 total=0 的档案」）。
- **归档阶段护栏**：POST 带 30 s 超时 + 3 次退避；归档前先把 `pending`+`gameUid` 落进 checkpoint，
  续跑复用同一 uid（`dedup_key` 不变 ⇒ D1 不会出现同轮同局两份棋谱）；归档后按 uid 核对；写文件改原子替换。

## 后果

- 实验产能：本机可并行发起多组对照，box 顺序执行；12 局 rapfi 轮 ~52 s/局。
- 新踩坑固化进 `docs/memory/MEMORY.md`（spec 静默回落、scp 不吃 `-n`、
  ssh 会话被 nohup 拖住的解法、`.data` 无 classic model 的报错是既有状态、
  pwsh 工具跑 ssh 要 `cmd /c … < NUL` 防 stdin 挂起）。
- 遗留：Elo 样本 < 50 局仅作相对参考。远端轮次**已补 `/api/experiments` 行**
  （worker 轮末 POST，形状对齐浏览器 `newEntryFromRun()`；`X-Device-Id` 不带即匿名；
  上线前跑完的三轮 rapfi1/smoke1/x1 用一次性脚本补归档，`GET /api/experiments` 可见 `total` 12 / 2 / 12）。
  仍不进统计的是 dry-run 局与 experiments 行的战术层耗时字段（worker 不统计 per-side tac_ms，
  落样本外）。
