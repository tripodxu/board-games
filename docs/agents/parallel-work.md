# 并行工作协议

> 适用场景：两个以上互不依赖的任务同时推进。**开工前先划所有权，划不干净就别并行**（改接力：
> [handoff.md](handoff.md)）。单文件热点与公共文件的归属见 §1、§3。

## 1. 文件所有权矩阵

| 文件 / 目录 | 默认 owner | 并行边界 |
|---|---|---|
| `src/core/engines/<某引擎>.ts` | 该棋种的 engine-dev | **天然并行**：一个棋种一个文件，七个引擎互不重叠（`gomoku` 与 `gomoku-pro` 同文件，属同一 owner） |
| `src/core/{registry,types}.ts`、`src/shared/record-map.ts` | **编排者**（公共契约文件） | 多引擎共写，必须串行；engine-dev 只写 handoff 提出需求。前两者是前后端/引擎共享的类型契约，`record-map.ts` 还挂着 D1 列映射与 `dedupSource`，改动要通知所有角色 |
| `index.html`、`styles/**`、`src/main.ts`、`package.json`、`vite.config.ts`、`tsconfig.json`、`.github/**` | **编排者独占** | 构建链与交付面（入口、样式、依赖、构建配置、CI）；任何子代理改它们之前**必须先拿到编排者的明确授权**，不能靠「顺手」 |
| `src/core/jev/**`、`src/core/tactics.ts`、`src/core/tactics-versions.ts`、`src/core/api/client.ts` | jev-dev 独占 | 与 engine-dev 的交界是「引擎的 `serializeForJev` 产出的 state 形状」——契约在 [../engine-interface.md](../engine-interface.md) §4，改契约要双方确认 |
| `src/ui/**` + `index.html` 的 id 约定 + `styles/**` 的具体规则 | ui-dev 独占 | 与 app-dev 的交界是 DOM 契约（`src/ui/README.md` §4 的 id 表）；**新增/删除 id 要改 `index.html`，那是编排者独占文件 → 走 handoff** |
| `src/app/**`、`src/core/{session,persist}.ts`、`src/core/record/**`、`src/core/view/**` | app-dev 独占 | 与 ui-dev 的交界是同一条 DOM 契约；与 jev-dev 的交界是 `decide()` 的返回 meta |
| `src/worker/**`、`migrations/**` | worker-dev 独占 | 与前端只通过 HTTP 契约相连：`src/worker/lib/http.ts` 的错误码表 + 各 route 的响应体 |
| `test/engines/**`、`test/tactics/**` | 对应实现者 | 一个引擎一个用例文件，互不重叠 |
| `test/worker/**` | worker-dev | 各 route 一个 spec；`test/worker/setup.ts` 是公共文件 |
| `test/ui/**`、`test/core/**` | 对应实现者 | 与实现文件同 owner |
| `test/fixtures/golden/**`、`test/parity/frozen.json` | **冻结只读（无 owner）** | 任何人不得改；确需重新生成见 [../../test/parity/README.md](../../test/parity/README.md) §7 |
| `test/parity/generate.mjs`、`exceptions.json` | 编排者 | 生成器与例外登记是「唯一闸门」，只允许编排者代表人类批准后动 |
| `test/engines/run.mjs` 的用例清单 | 编排者 | 新增棋种时要登记用例，属公共文件 |
| `docs/**`、`AGENTS.md`、`README.md`、`.gitignore` | 编排者 | 其他角色的文档更新写进 handoff，由编排者代改 |
| `.work/**` | 所有人可写自己的文件 | git 忽略，不入库；一个 agent 一个文件名，禁止互相覆盖 |

**跨边界需求**（我需要改一行别人的文件）：写进 `.work/handoff.md` 或 `.work/tasks.md`，由那个文件的
owner 或编排者代改。**不要自己动手**——这是并行工作的唯一硬边界。

## 2. 认领与通信

1. 开工前在 `.work/tasks.md`（不入库）登记一行：`任务 · 角色 · 文件清单 · 开始时间`。
2. 文件清单必须与 §1 的矩阵一致；**两个任务的文件清单不允许有任何交集**，有交集就是划错了。
3. 收工在同一个文件里补：`状态 · 验收命令 · 实际输出摘要 · 交给谁`。
4. 上下文传递只用两样东西：`.work/handoff.md` 与 [../memory/MEMORY.md](../memory/MEMORY.md) 顶部条目。
   口头（对话里）说的结论不算交接。

## 3. 热点文件纪律

以下文件在并行场景下最容易互相踩，各自只有一条纪律：

| 热点 | 纪律 |
|---|---|
| `src/app/loop.ts` | **同一时刻只允许一个 agent 改**。必须保留：`session.epoch` 自增 + 中断在途请求是同一个动作（悔棋走同一段逻辑）；在途决策记 `inflight` 快照，回调里比对 epoch 后才允许落子；换局/悔棋要清掉时钟句柄（否则定时器会在新局空转一次） |
| `src/core/registry.ts` | 只由编排者改；改完必须跑 `npm run test:engines`（注册顺序是契约：golden 与导入的 `gid` 都依赖 id 稳定） |
| `src/main.ts` | 只由编排者改；它是唯一入口（注入版本号 → `boot()`；启动异常写 `#backendState`） |
| `index.html` | **编排者独占**；ui-dev 只能通过 handoff 提需求。改任何 id 必须同步 `src/ui/README.md` §4 与对应的 `test/ui/*.spec.ts` |
| `src/worker/lib/http.ts` | 错误码表是**唯一**的 code ↔ 状态码映射；新增错误码要走 worker-dev 评审（前端按 `code` 分支） |
| `src/shared/record-map.ts` | 棋种中文名 ↔ id 的单一事实源；import 脚本、`/api/stats` 的 `byGame`、开具体验都依赖它 |
| `test/fixtures/golden/**`、`test/parity/frozen.json` | 冻结只读。红了先当「证据被篡改」处理，不是「测试挂了」 |

## 4. 提交粒度与合并

- 每个子任务**一个 commit**，Conventional Commits，scope 用引擎 id 或模块名
  （`feat(gomoku): …` / `fix(worker): …` / `docs(agents): …`）。
- 不允许「顺手重构」混进功能 commit；夹带无关改动是审查清单第 5 条。
- 合并后由编排者跑全量验收（`npm test` + `npm run check:docs` + `npm run typecheck`）再决定 push；
  **push 不会自动部署**（`.github/workflows/deploy.yml` 是 `workflow_dispatch` 手动触发）。
- 改了行为却只更新代码、不更新 [../status.md](../status.md) / memory：视为未完成，退回。

## 5. 冲突处理

| 冲突类型 | 处理 |
|---|---|
| **文件冲突**（两人改了同一文件） | 停手。确认谁的文件清单写错了；保留**正确 owner** 的版本，另一方改动重做成 handoff |
| **行为冲突**（两处改动各自正确但合起来不对） | 回到契约层判定：引擎侧看 [../engine-interface.md](../engine-interface.md)，前后端看 `src/worker/lib/http.ts` 与各 route 响应体，UI 看 `src/ui/README.md` §4。契约没写清楚 → 先补契约文档再改代码 |
| **测试冲突**（你的改动让别人的用例红了） | 默认动作是**修自己**；确实要改预期值时必须先证明旧行为是错的（最小反例），并按 [../../test/parity/README.md](../../test/parity/README.md) §7 登记例外 |
| **所有权冲突**（两人都认为该文件归自己） | 编排者裁决，并在本节补一行规则，避免下次再吵 |

## 6. 反模式

1. 直接改公共文件（注册表、入口、`record-map.ts`、别人的 route）——哪怕只加一行。
2. 夹带无关重构：借「顺便清理」之名改别人的文件。
3. 没跑验收就宣布完成（`npm test` / `npm run check:docs` 的真实输出才是证据）。
4. 在 `.work/` 之外建个人临时文件（仓库根目录的临时脚本、备份、导出的中间产物）。
5. 为了让自己这条用例变绿而放宽公共断言（金样封条、payload 上限、限流阈值）。
6. 用「我记着旧实现是这样」当依据——旧实现（`js/**`、`server.js`、`functions/`、`dev-proxy.py`、
   `legacy.html`、`css/**`）已在 2026-10-01 重构收尾时**删除**，活代码只在 `src/**`，
   行为基线在 `test/fixtures/golden/**`。
