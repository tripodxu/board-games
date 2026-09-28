# Jev 棋馆（board-games）

六种棋类对弈，由 TypeSafe 的「系统一模型」**Jev** 走子：五子棋、围棋（9 路）、象棋、国际象棋、西洋跳棋、中国跳棋。

支持 **人 vs Jev**、**Jev vs Jev**、**人 vs 人** 三种模式。纯静态 HTML/JS，无框架、无构建、无第三方依赖，双击即玩，也可原样部署到 Cloudflare Pages 等静态托管。

## 文档导航

| 我是… | 读这里 |
|---|---|
| 玩家 | 本页即可 |
| 开发者 / Contributor | [AGENTS.md](AGENTS.md)（入口规范）→ [docs/README.md](docs/README.md)（文档地图） |
| AI Agent（第一次进本仓库） | [AGENTS.md](AGENTS.md) 第 2–3 节：硬性规则 + 最小阅读路径，**不需要通读代码** |
| 多 Agent 协同 / 接力任务 | [docs/agents/](docs/agents/README.md)（角色 / 阅读路径 / handoff / 并行规则 / playbooks） |
| 想了解项目当前状态 | [docs/status.md](docs/status.md) |
| 项目记忆（新条目在最上） | [docs/memory/MEMORY.md](docs/memory/MEMORY.md) |

## 快速开始

### 方式一：直接打开（离线演示 / 浏览器直连）

双击 `index.html` 即可。默认未填 key 时自动进入**离线演示模式**（内置简单启发式 AI + 合成概率），完整体验三种模式与决策面板。

要接真实 Jev：右侧「Jev 设置」→ 选渠道并填 key（只存浏览器 localStorage）：

| 渠道 | key | 说明 |
|---|---|---|
| 官方 API | [console.typesafe.ai](https://console.typesafe.ai) 的 key | 浏览器直连 `api.typesafe.ai`；若跨域(CORS)受限请改用其他渠道 |
| OpenRouter | [openrouter.ai](https://openrouter.ai/settings/keys) 的 key | 与官方接口同构（`/api/v1/systemone`），浏览器直连最稳 |
| 同源代理 | 无需填 | key 放服务端（见下） |

### 方式二：本地代理（绕过 CORS）

```bash
# 可选：设置环境变量作为本机兜底 key（不设也行，访客各自填 key）
set TYPESAFE_API_KEY=ts-xxxx     (Windows)
export TYPESAFE_API_KEY=ts-xxxx  (macOS/Linux)
python dev-proxy.py              # http://localhost:8788
```

打开后渠道选「同源代理」。仅标准库，无依赖。

### 方式三：部署到 Cloudflare Pages（静态博客可直接挂）

1. 把本目录推到 GitHub 仓库，CF Pages 连接仓库构建（无构建命令，输出目录 = 根目录）。
2. 仓库已含 `functions/api/jev.js`（Pages Functions），线上自动获得 `/api/jev` 代理。**无需配置任何环境变量。**
3. **BYOK（自带 key）设计**：代理只做 CORS 转发——访客在页面设置里填自己的 TypeSafe key，随 `X-Api-Key` 请求头透传，服务端不存任何 key，花费走访客自己的账户。未填 key 的访客会收到明确的 401 提示。
4. 本地调试 Functions：`npx wrangler pages dev .`。

> 也可以删掉 `functions/` 目录：那时「同源代理」不可用，访客走 OpenRouter 渠道（同样 BYOK、浏览器直连）。

## 玩法说明

- **模式**：人机（选执子）、机机（带速度滑杆 / 暂停 / 单步）、人人。
- **走棋**：点击棋盘落子/走子；西洋跳棋连跳需逐格点选；围棋有「停一手」，双方连续停一手即数子终局（中国规则，贴 5.5）；各棋均可认输、悔棋。
- **Jev 决策面板**：每步显示 top-3 候选概率条、置信度、局势判断（Noul/Score）、延迟、token 与成本累计。
- **随机度**：Jev 每步从概率最高的 k 个候选里加权抽签（最强手 / top-3 / top-5）。机机对弈建议「温和」，避免每盘一模一样。
- **URL 加 `?test=1`**：右上角运行全部引擎自检。

## Jev 走棋原理

每一步把局面序列化成**坐标记法**的 `state`（如五子棋 `black_stones: ["H8","I9"]`，国象 `e2e4` 记法），发一次 System One 请求：

- `move`：**Choice** 问题——每个合法着法是一个选项（≤255），返回各选项概率分布，按随机度采样执行；
- `edge`：**Noul** 问题——当前是否占优；
- `position`：**Score** 问题——0–10 局势分。

三个问题对同一 state 并行评估，一次调用完成。响应结构体直接被代码消费，无文本解析。

成本参考：官方定价输入 $42/百万 token（输出免费），单步约 0.5–1.5K token ≈ **$0.00005/步**，一整局不到 5 美分。

## 目录结构

```
board-games/
├── index.html              # 单页入口
├── css/style.css
├── js/
│   ├── board.js            # 命名空间 + 绘图/工具
│   ├── jev-client.js       # Jev API 封装（官方/OpenRouter/代理，429/529 退避重试）
│   ├── mock-ai.js          # 离线演示 AI
│   ├── app.js              # 对局循环、模式、决策可视化
│   └── games/              # 六个规则引擎（统一接口 + selfTest）
│       ├── gomoku.js  go.js  xiangqi.js
│       └── chess.js  checkers.js  chinese-checkers.js
├── functions/api/jev.js    # CF Pages Functions 代理（可选）
├── dev-proxy.py            # 本地静态+代理二合一（可选）
├── test/run-tests.js       # Node 自检：node test/run-tests.js
├── AGENTS.md               # Agent 入口规范（硬性规则 + 最小阅读路径）
└── docs/                   # 架构/接口/ADR/计划/多 agent 协同/记忆（见 docs/README.md）
```

每个引擎实现统一接口：`newGame / getLegalMoves / applyMove / getStatus / moveFromNotation / serializeForJev / draw / humanClick`，可选 `mockPick / passMove / selfTest`。加新棋种只需新增一个引擎文件并在 `app.js` 的 `GAME_ORDER` 注册（完整清单见 [docs/engine-interface.md](docs/engine-interface.md)）。

## 开发与多 Agent 协作

本项目为多 agent 协同设计，**任何 agent 都不需要全量阅读代码库**：

- 入口读 [AGENTS.md](AGENTS.md)：硬性规则（零依赖/纯函数引擎/验收命令）+ 任务→最小阅读路径表。
- 协同协议在 [docs/agents/](docs/agents/README.md)：角色分工、文件所有权（六引擎是天然并行边界）、
  `.work/handoff.md` 接力模板、常见任务 playbook（新棋种/修 bug/改 prompt/部署）。
- 持久记忆在 [docs/memory/MEMORY.md](docs/memory/MEMORY.md)：**新条目置顶**，与 agent 工具无关，随仓库走。

```bash
node test/run-tests.js     # 唯一验收命令：六引擎 selfTest + mock 机机集成对局
```

## 已验证与已知限制

- 引擎自检（`node test/run-tests.js`）：国际象棋 perft(1/2/3) = 20/400/8902；象棋开局 44 着法 + 照面/绝杀/困毙；西洋跳棋开局 7 着法、强制连跳、升王即停；围棋提子/禁自杀/劫/双停一手数子；中国跳棋连跳链与营地规则；含 mock 机机完整对局集成测试。
- **未实现**：象棋长将/长捉判负；围棋 13 路大盘（Choice 选项 ≤255 需候选预筛，9 路不需要）；国际象棋三次重复局面判和。
- 中国跳棋未禁止"永堵对方营地门"的变体规则；机机模式下若双方僵持可用悔棋或重开。
- Jev 概率判断可能出错（「零幻觉」仅指输出结构），胜负以棋盘为准；官方性能数字为厂商口径。

> 完整状态、路线图与技术债见 [docs/status.md](docs/status.md)。
