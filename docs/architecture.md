# 架构地图

> 目的：让 agent 不读代码就能定位"这事归哪个文件管"。读完后按
> [agents/reading-paths.md](agents/reading-paths.md) 只打开需要的文件。

## 1. 总体形态

```
index.html ──加载──▶ css/style.css
      └──加载──▶ js/board.js            （BG 命名空间 + 工具 + canvas 绘制）
                 js/charts.js           （决策图表）
                 js/calibration.js      （校准数学：纯函数，无 DOM）
                 js/games/*.js          （七个纯逻辑引擎，自我注册到 BG.games；
                                         gomoku.js 一文件两引擎：gomoku / gomoku-pro）
                 js/mock-ai.js          （离线演示 AI → BG.mock）
                 js/jev-client.js       （Jev 调用封装 → BG.jev）
                 js/api.js              （后端 API 客户端 → BG.api，失败一律降级为 null）
                 js/rapfi.js            （Rapfi WASM 协议客户端 → BG.rapfi，懒加载）
                 js/app.js              （对局循环 / 模式 / 可视化 / 记录 / 实验 / 后端探活）

后端（三种形态，前端 URL 契约一致，见 ADR-0005）：
      server.js                ← node server.js：静态托管 + API + 本地持久化（完整后端）
      functions/api/*.js       ← CF Pages Functions（Workers 运行时）：
                                   jev.js 代理 / games.js 棋谱进仓库 /
                                   health+experiments+stats 契约对齐三端点（持久化走 GitHub）
                                   _github.js 为共享模块（下划线前缀，不对应路由）
      dev-proxy.py             ← 本地最小备用（静态 + /api/jev）

本地引擎资产（ADR-0006）：rapfi/ 预编译 WASM 产物约 10.8MB，仅 rapfi 渠道按需下载。
```

加载顺序即依赖顺序：`board.js` 必须在任何引擎之前；`jev-client.js`、`mock-ai.js` 在
`app.js` 之前。**新增 JS 文件必须同步改 `index.html` 的 script 标签和
`test/run-tests.js` 的加载清单**（两处都是硬编码顺序）。

## 2. 文件职责表

| 文件 | 行数量级 | 职责 | 能否在 Node 运行 |
|---|---|---|---|
| `index.html` | ~330 | 单页结构：tab 栏、棋盘容器、对局面板、Jev 设置、实验面板、实验报告、记录/动态区 | ❌ DOM |
| `css/style.css` | ~960 | 全部样式（亮色拟物风） | ❌ |
| `js/board.js` | ~150 | `BG` 命名空间、`BG.util`（clone/rnd/rand/shuffle/weightedPick/assert，rand/rnd 可种子化）、`BG.gfx`（HiDPI canvas、网格/星位/棋子/圆片/文字/高亮）、`BG.eventXY` | ✅ 无 DOM 依赖 |
| `js/games/gomoku.js` | ~990 | 一个文件两个引擎（工厂 `createGomoku(id, name, forbidden)`）：五子棋 15×15 无禁手 + 五子棋·禁手（黑方三三/四四/长连禁手）；五连判定、候选预筛(≤64)、criteria 战术标签、deepTactics、vcfWin 威胁空间搜索 | ✅ |
| `js/games/go.js` | ~330 | 围棋 9×9：提子/禁自杀/劫/双停数子(贴5.5) | ✅ |
| `js/games/xiangqi.js` | ~355 | 象棋 9×10：全部走子规则、照面、将军/绝杀/困毙 | ✅ |
| `js/games/chess.js` | ~430 | 国际象棋：易位/吃过路兵/升变/将杀逼和，perft 自检 | ✅ |
| `js/games/checkers.js` | ~315 | 西洋跳棋 8×8 英式：强制跳吃、连跳、升王即停 | ✅ |
| `js/games/chinese-checkers.js` | ~310 | 中国跳棋六角星 121 格：连跳递归、先抵对营 | ✅ |
| `js/mock-ai.js` | 51 | 离线 AI：优先 `engine.mockPick`，否则加权随机；合成概率分布 | ✅ |
| `js/jev-client.js` | ~600 | 渠道封装（含 `random` 基线与 `rapfi` 本地引擎分发）、429/529 指数退避、30s 超时、top-k 加权采样、成本统计、战术事实注入与九级战术保险（win/block/open4/threat/vcfAttack/vcfDefense/parry/parry3/parry4） | ⚠️ 需 fetch |
| `js/api.js` | ~65 | **后端 API 客户端**（`BG.api`：health/games/experiments/stats）：同源 `/api/*`，失败一律返回 null 不抛——降级是设计的一部分（ADR-0005） | ✅ 无 DOM 依赖 |
| `js/rapfi.js` | ~255 | **Rapfi 本地引擎客户端**（`BG.rapfi`，Gomocup 协议）：懒加载 `rapfi/` WASM、`decide` 直接走引擎不经过 Jev 战术层；16 项协议单测（stub Module） | ✅ 无 DOM 依赖 |
| `js/charts.js` | ~250 | 概率条/局势曲线/可靠性图等 SVG 图表 | ⚠️ 需 canvas/DOM |
| `js/calibration.js` | ~220 | **校准实验室数学**（brier/skill/ece/mce/过度自信/可靠性分箱）：纯函数、零 DOM、Node 可加载 | ✅ |
| `js/app.js` | ~1580 | **对局循环与全部 UI 编排**：`GAME_ORDER`（七个引擎）、模式/执子、悔棋、暂停/单步、速度滑杆、决策面板、对局记录(localStorage)、棋谱导出/自动同步、对比实验连跑（≤50 局）、实验报告归档、后端探活与双源校准合并、rapfi 懒加载探测、`?test=1` 自检入口 | ❌ DOM |
| `server.js` | ~590 | **零依赖 Node 后端**（node:http/fs/path，CommonJS）：静态托管 + `/api/jev` 代理 + `/api/games` 落盘（幂等原子写）+ `/api/experiments` 归档 + `/api/stats` 聚合 + `/api/health`；`createServer(opts)` 可测试 | ❌ Node 运行时 |
| `functions/api/jev.js` | ~57 | CF Pages Function：BYOK CORS 转发 | ❌ Workers 运行时 |
| `functions/api/games.js` | ~105 | CF Pages Function：终局棋谱 POST → GitHub API commit 进仓库 `games/<日期>/`；GET 列最近 7 天棋谱 | ❌ Workers 运行时 |
| `functions/api/_github.js` | ~75 | Pages Functions 共享模块：GitHub API 客户端 + 限流 + base64（下划线前缀不对应路由） | ❌ Workers 运行时 |
| `functions/api/health.js` | ~20 | CF Pages Function：`/api/health` 探活（零上游请求，`github` 字段报 token 配置态） | ❌ Workers 运行时 |
| `functions/api/experiments.js` | ~85 | CF Pages Function：实验战报归档（读写仓库 `data/experiments.json`，按 tag upsert，`[skip ci]`） | ❌ Workers 运行时 |
| `functions/api/stats.js` | ~95 | CF Pages Function：跨对局聚合（trees + ≤40 份 raw + contents ≤42 子请求；口径与 server.js 一致） | ❌ Workers 运行时 |
| `dev-proxy.py` | 95 | 本地最小备用：静态托管 + `/api/jev` 转发（持久 TLS 连接） | Python 3 |
| `rapfi/` | ~11MB | Rapfi 预编译 WASM 产物（`.js/.wasm/.data` + COPYING/NOTICE，GPLv3 引擎 + CC0 权重），仅 `rapfi` 渠道按需下载（ADR-0006） | ❌ Workers/Node 均可（WASM） |
| `test/run-tests.js` | ~570 | Node 自检：eval 加载引擎跑 `selfTest()` + 战术保险回归 + mock 机机集成对局 + Pages/server 双端契约测试 | ✅ |
| `test/server-tests.js` | ~570 | server.js 的 18 项 HTTP 契约测试（临时目录 + ephemeral port，不碰仓库数据） | ✅ |
| `test/rapfi-tests.js` | ~310 | `js/rapfi.js` 协议层 16 项单测（stub Module：坐标往返/棋盘命令/着色翻转/着法解析） | ✅ |

## 3. 对局数据流（一步棋的完整生命周期）

```
人点击 canvas ──▶ app.js: humanClick(st, ui, x, y) ──▶ move
                                                        │
AI 回合 ──▶ app.js: scheduleAI() ──▶ BG.jev.decide(engine, st, side, opts)
                                       │  engine.serializeForJev(st, side)  ← 三问一次并行
                                       │  fetch(渠道) / BG.mock.decide
                                       ▼
                                    decision { notation, move, meta }
                                                        │
                          app.js: playMove(move, meta) ─┘（epoch 校验防竞态）
                                       │
                          engine.applyMove(st, move) ──▶ 新 state（纯函数，返回新对象）
                                       │
                          app.js: redraw() ──▶ engine.draw(ctx, st, ui)
                                       │
                          engine.getStatus(st).over ──▶ app.js: finishGame() 记录存档
                                       │
                          ├─▶ uploadGameRecord()：POST /api/games（开关 gameSync 可关）
                                       │     → server.js：落盘 games/<日期>/（幂等）
                                       │     → CF Pages：GitHub API commit（[skip ci]）
                                       │     → 纯静态/file://：失败降级，「最近同步」显示结果
                                       └─▶ 实验连跑中（EXP.running）：2.5s 后自动开下一局（交替黑白）

启动时另有一次性探活：app.js: initBackend() → GET /api/health
  → live（server.js）：实验列表并入本地、/api/stats 的按局 cal 记录并入校准实验室
  → deploy（Pages/纯静态）：全部回落 localStorage，行为与后端化之前一致
```

**关键不变量：**

- `applyMove` / `getLegalMoves` / `getStatus` / `serializeForJev` 是**纯函数**：
  不修改入参 state，返回新 state。引擎之间不得共享可变状态。
- `app.js` 用 `epoch` 计数器丢弃过期异步回调（切棋种/重开时旧请求结果必须被忽略），
  改 AI 调度逻辑时**必须保留这个防护**。
- Jev 返回的着法在 `jev-client.decide()` 内用 `getLegalMoves()` 白名单过滤，
  非法选项回退到 `legal[0]` 并打 `warning`。

## 4. state 序列化约定（Jev 侧）

每个引擎的 `serializeForJev(st, side)` 返回统一形状：

```js
{
  state: { /* 英文键值、坐标记法的局面描述，含 legal_moves 列表 */ },
  questions: {
    move:     { type: 'choice', instructions, criteria, options: [...notation] }, // ≤255 选项
    edge:     { type: 'noul',   instructions, criteria },
    position: { type: 'score',  instructions, criteria },                          // 0–10
  },
  options: [...notation],   // choice 选项与 state.legal_moves 一致
}
```

`BG.jev.decide()` 只消费 `answers.move.probabilities / confidence`、`answers.edge.noul`、
`answers.position.score` 与 `usage`。**改这里必须同步 `docs/jev-api.md`。**

## 5. 自检体系

- `node test/run-tests.js`：eval 加载 `board.js` + `calibration.js` + `api.js` + 七引擎 →
  逐引擎 `selfTest()` 与校准数学自检；再 eval `mock-ai.js` + `jev-client.js` 跑
  gomoku/cc/go 三盘 mock 机机集成对局 + jev-client 单元回归；然后 require
  `test/server-tests.js` 打 server.js 的 18 项 HTTP 契约测试（临时目录 + ephemeral port）、
  require `test/rapfi-tests.js` 打 Rapfi 协议层 16 项单测（stub Module）。
- `index.html?test=1`：浏览器内同样本自检（七引擎 + 校准数学）。
- 环境变量 `BG_FAST=1` 让 mock AI 跳过模拟延迟（Node 集成测试内部已默认）。
- **任何引擎改动后这两个入口都必须通过**，这是唯一的验收标准（无测试框架，不引入）。
- **任何后端契约改动必须同步**：`docs/jev-api.md` §3 + server.js 与
  functions/api/*.js 两端 + `test/server-tests.js`（Node 侧）+
  `test/run-tests.js` 的 pagesApiTests（Pages 侧）。
- **任何引擎接口/渠道/tactics 契约改动必须同步**：`docs/engine-interface.md` 与
  `docs/jev-api.md` §2/§2.2/§5（渠道与战术级是这两篇的契约面）。
