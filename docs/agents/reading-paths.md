# 最小阅读路径矩阵

> 本文件是「**不让 agent 全量阅读项目**」的核心：按任务类型给出必读文档与代码文件。
> 原则：**先读文档后读代码；代码只读被指名的文件；用 grep 定位，不用通读。**

通用前置（任何任务都读，~2 分钟）：[../../AGENTS.md](../../AGENTS.md) 第 1–2 节 +
[docs/status.md](../status.md)。

## 任务 → 阅读矩阵

| # | 任务 | 必读文档 | 代码文件（只读这些） | 预计阅读量 |
|---|---|---|---|---|
| 1 | 修某个棋种的规则/渲染 bug | engine-interface.md §2–3 | `js/games/<id>.js`（单文件，≤450 行） | ~400 行 |
| 2 | 新增一个棋种 | engine-interface.md 全文 + playbooks §1 | 样板：`js/games/gomoku.js`；注册点：`app.js` 的 `GAME_ORDER`、`test/run-tests.js` 清单 | ~300 行 |
| 3 | 改 Jev 请求/prompt/序列化 | jev-api.md §1、§4 | `js/jev-client.js` + 目标引擎的 `serializeForJev`（grep 定位） | ~200 行 |
| 4 | 加/改渠道、代理、部署 | jev-api.md §2–3 + ADR-0003 | `functions/api/jev.js` 或 `dev-proxy.py`（二选一） | ~100 行 |
| 4b | 改后端 API / 持久化 | ADR-0005 + jev-api.md §3 | `server.js` + `js/api.js`；契约测试 `test/server-tests.js`（动契约三处同步：server.js、functions/api/*.js、双端测试） | ~600 行 |
| 5 | 改 UI/交互/决策面板 | architecture.md §2–3 | `index.html` + `js/app.js`（grep 函数名定位，勿通读） | 按需 |
| 6 | 改成本/token 统计口径 | jev-api.md §4 | `js/jev-client.js` 的 `costUsd` 一行 | ~10 行 |
| 7 | 接手进行中任务 | handoff.md + memory 最新 3 条 | handoff 中指名的文件 | 按 handoff |
| 8 | 审查别人的改动 | roles.md「审查者」+ 改动面对应的上面某行 | 本次 diff | 按 diff |
| 9 | 排查"着法非法/回退"类问题 | architecture.md §3、engine-interface.md §2 | `js/jev-client.js` 的 `decide()`（白名单过滤段） | ~60 行 |
| 10 | 写文档/记忆 | docs/README.md 维护规则 | 无 | — |

## 定位技巧（避免通读）

- 引擎接口入口：grep `BG.register(` → 直接看导出对象。
- Jev 请求形状：grep `serializeForJev` → 每个引擎一个。
- UI 行为：grep `function scheduleAI|function playMove|function undo` in `app.js`。
- 加载顺序：`index.html` 底部 script 标签 + `test/run-tests.js` 顶部清单（两份，都要看）。

## 明确禁止的读法

- ❌ 为了改一个引擎而读全部六个引擎。
- ❌ 为了改 prompt 而读 `app.js` 全文（~800 行）。
- ❌ 用 `learn-codebase` 式全量通读代替阅读路径——本项目文档就是为避免这个而写的。
