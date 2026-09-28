# MEMORY.md — 项目记忆

> **约定：新条目一律追加在最上面（倒序），最新在最顶。** 一条一事，写事实与结论，
> 不写客套；带日期的条目格式 `## YYYY-MM-DD · 标题`。
> 本文件是项目级持久记忆（入库、工具无关）。各 agent 工具自己的记忆/指针
> （如 `.workbuddy/MEMORY.md`）只允许指向本文件，不得成为事实源。
> 沉淀规则见 [README.md](../README.md)「维护规则」。

---

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
