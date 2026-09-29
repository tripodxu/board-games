# AGENTS.md — 给所有协作 Agent 的入口规范

> 本文件是**任何 agent 进入本仓库后的第一份读物**。目标：让每个 agent 用最小阅读量
> 搞清楚「能改什么、怎么验、写完更新什么」，**不需要全量阅读项目**。
> 人类 Contributor 同样适用。详细协同协议见 [docs/agents/](docs/agents/README.md)。

---

## 1. 项目一句话

原生 HTML/JS 的六棋种对弈站（五子棋 / 围棋 9 路 / 象棋 / 国际象棋 / 西洋跳棋 / 中国跳棋），
由 TypeSafe「系统一模型」Jev 走子。**零框架、零构建、零第三方依赖**：双击 `index.html`
即玩（离线演示），`node server.js` 起本地后端（棋谱落盘 / 实验归档 / 跨对局统计），
部署形态见 [ADR-0005](docs/adr/0005-zero-dep-node-backend.md)。

## 2. 硬性规则（不可协商）

1. **禁止引入任何框架、构建步骤、第三方依赖**（无 npm install、无打包器、无 CDN）。
   新增代码只能是原生 ES5+ 兼容 JS，浏览器与 Node（自检）双端可加载。
2. **引擎与 UI 解耦**：`js/games/*.js` 是纯逻辑引擎，不碰 DOM、不碰 canvas 之外的东西；
   DOM/canvas 只在 `js/board.js`（绘制辅助）、`js/app.js`（对局循环）里出现。
3. **每个引擎必须实现统一接口并带 `selfTest()`**（契约见
   [docs/engine-interface.md](docs/engine-interface.md)）。新棋种未过自检 = 未完成。
4. **改完必须验证**：`node test/run-tests.js` 全绿，才允许声称"完成"。
   只改了单个引擎时也要跑全量（引擎间共享 `BG` 命名空间与 `jev-client`）。
5. **密钥永不入仓库**：API key 只进浏览器 localStorage / 请求头透传 / 服务端环境变量；
   发现误提交的 key 立即删除并轮换。
6. **Jev 请求保持"一次并行多问"结构**：`move`(choice) + `edge`(noul) + `position`(score) 三问一次发出，
   不要拆成串联推理链（Jev 的设计原则，见 [docs/jev-api.md](docs/jev-api.md)）。
7. **文档随代码更新**：改行为 → 更新 `docs/status.md`；踩坑/决策 → 在
   [docs/memory/MEMORY.md](docs/memory/MEMORY.md) **顶部**追加条目；结构性决策 → 补一篇 ADR。

## 3. 最小阅读路径（不要全量阅读）

| 任务类型 | 必读 | 代码 |
|---|---|---|
| 修某个棋种的规则 bug | engine-interface.md + status.md「已知限制」 | 只读 `js/games/<该引擎>.js` |
| 新增一个棋种 | engine-interface.md + agents/playbooks.md §1 | 参照 `js/games/gomoku.js` 模板 |
| 改 Jev 调用 / prompt / 渠道 | jev-api.md | `js/jev-client.js` + `functions/api/jev.js` |
| 改 UI / 交互 / 决策面板 | architecture.md | `index.html` + `css/style.css` + `js/app.js` |
| 改后端 / API / 持久化 | ADR-0005 + jev-api.md §3 | `server.js` + `js/api.js` + `test/server-tests.js`（动契约必须三处同步 + 双端测试） |
| 改部署 / 代理 | jev-api.md §渠道 | `server.js` / `functions/api/*.js` + `dev-proxy.py` |
| 接手别人没做完的任务 | agents/handoff.md + memory 最新 3 条 | handoff 里指名的文件 |

完整任务→阅读矩阵见 [docs/agents/reading-paths.md](docs/agents/reading-paths.md)。

## 4. 常用命令

```bash
node test/run-tests.js          # 唯一验收命令：引擎自检 + mock 集成 + 后端/Pages 契约测试
node server.js                  # 本地完整后端（静态托管 + API + 持久化）→ http://localhost:8788
python dev-proxy.py             # 本地最小备用：静态 + /api/jev → http://localhost:8788
# 浏览器打开 index.html?test=1   # 页面内运行全部引擎自检
```

环境要求：Node ≥ 18（自检 / 文档检查 / server.js）、Python ≥ 3.8（可选，仅 dev-proxy.py 需要）。**无需 npm install**（零依赖）。

## 5. 代码约定速查

- 全局命名空间 `BG`（`globalThis.BG`）：`BG.games`（引擎注册表）、`BG.util`、`BG.gfx`、
  `BG.jev`（客户端）、`BG.mock`（离线 AI）。新模块用 IIFE 挂到 `BG.*`，不写模块系统。
- 引擎 move 对象：`{ notation, desc, ...私有字段 }`，`notation` 是 Jev Choice 选项的键，必须唯一且稳定。
- state 一律 JSON 可克隆（`BG.util.clone` 用 JSON 深拷贝），不放函数/DOM 引用。
- Jev 的 `state` 与 `instructions` **一律英文**（官方口径：中文精度较低），坐标记法，见 ADR-0002。
- 注释、文档、commit message 用中文；代码标识符用英文。
- 可种子随机：`BG.setSeed(n)` / URL `?seed=42` 使 mock 与测试确定可复现；真实 Jev 渠道不受影响（`weightedPick` 不经 `rand`）。

## 6. 提交规范

Conventional Commits，scope 用引擎 id 或模块名：

```
feat(gomoku): 禁手提醒
fix(chess): 王翼易位后王车初始位标记未清除
docs(agents): 新增接力协议
chore: 初始化仓库与文档体系
```

一个 commit 只做一件事；跨多文件的行为变更必须带 `docs/` 更新。

## 7. 多 Agent 协作速查

- **接力**：按 [docs/agents/handoff.md](docs/agents/handoff.md) 写 `.work/handoff.md`（不入库），
  下一个 agent 从 handoff + memory 最新条目恢复上下文，禁止从头全量读代码。
- **并行**：按 [docs/agents/parallel-work.md](docs/agents/parallel-work.md) 划分文件所有权，
  两个 agent 不得同时改同一文件；公共文件（`app.js`/`board.js`/`jev-client.js`）默认归编排者。
- **角色**：见 [docs/agents/roles.md](docs/agents/roles.md)。
