# 并行协作规则

> 场景：多个 agent 同时推进互不依赖的子任务。核心问题只有一个：
> **两个 agent 不能同时写同一个文件。**

## 1. 文件所有权矩阵

编排者在开工前发布下表（按任务裁剪），agent 只写自己拥有的文件：

| 文件 | 默认 owner | 备注 |
|---|---|---|
| `js/games/gomoku.js` `go.js` `xiangqi.js` `chess.js` `checkers.js` `chinese-checkers.js` | 各自任务的 engine-dev | **天然并行边界**：六个引擎文件互相无引用，可同时开工（注意 `gomoku.js` 一个文件注册两个引擎：`gomoku` 与 `gomoku-pro`，共七个引擎） |
| `js/jev-client.js` `js/mock-ai.js` `js/rapfi.js` `functions/api/jev.js` `dev-proxy.py` | jev-dev（同一时刻一个） | 改渠道/重试/成本/本地引擎时独占 |
| `index.html` `css/style.css` `js/app.js` `js/charts.js` | ui-dev（同一时刻一个） | `app.js` 是热点文件，见 §3 |
| `test/run-tests.js` | 编排者 | 加载清单是公共资源 |
| `docs/**` `AGENTS.md` `.gitignore` | 编排者 | 实现者可在自己 commit 里附带 docs 小修，但不得重构文档 |
| `README.md` | 编排者 | 对外口径统一收口 |

**跨边界需求**：engine-dev 需要改 `app.js`（如新棋种要注册）→ 写进 handoff/tasks，
由编排者或 ui-dev 代改，**不自己动手**。

## 2. 认领与通信

- 开工前在 `.work/tasks.md` 登记：`任务 · 角色 · 文件清单 · 开始时间`。
- 发现要改的文件已被认领 → 停止，找编排者协调，禁止"先改了再说"。
- 每天/每轮结束，各 agent 把进展写回 `.work/tasks.md` 与 handoff。

## 3. 热点文件纪律（app.js）

`js/app.js` 是对局循环 + 全部 UI 编排的单文件，最容易被并行改崩。规则：

1. 同一时刻只允许一个 agent 改 `app.js`；其他人需要它配合时提需求。
2. 改 `app.js` 必须保留：`epoch` 竞态防护、`?test=1` 自检入口、设置持久化结构
   （`loadSettings/saveSettings` 的键名）。
3. 改完必须浏览器验证一种模式（人机/机机/人人至少其一覆盖到改动点）。

## 4. 提交粒度与合并

- 每个子任务一个 commit（Conventional Commits，见 AGENTS.md §6），
  **不允许把多个 agent 的工作混在一个 commit**。
- 引擎类并行改动之间**理论上零冲突**（文件不相交 + 只共用 `BG.register` 注册表），
  按到达顺序合并即可；真出现冲突（如都改了 `GAME_ORDER`）由编排者解。
- 合并后必须由编排者跑一次全量 `node test/run-tests.js` 再 push。

## 5. 冲突处理

1. **文件冲突**（两人改了同一文件）：保留双方 diff，交编排者手动合并；禁止 force push。
2. **行为冲突**（两个改动语义互斥，如一个让 Jev 默认 argmax、一个默认 top-3）：
   升级为决策，写 ADR 或 memory 条目后由编排者裁决。
3. **测试冲突**（合并后自检红）：谁合并谁负责定位；定位到具体子任务则退回原 agent，
   并在 handoff 里写明失败输出。

## 6. 反模式（禁止）

- ❌ 为了"省事"直接改公共文件（`app.js`/`board.js`/`jev-client.js`/`test/run-tests.js`）。
- ❌ 并行任务里夹带无关重构（"顺手优化"是并行协作的头号事故源）。
- ❌ 未跑验收命令就标记任务完成。
- ❌ 在 `.work/` 之外创建个人临时文件（临时产物一律进 `.work/`，已 gitignore）。
