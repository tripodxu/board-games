# 架构地图

> 目的：让 agent 不读代码就能定位"这事归哪个文件管"。读完后按
> [agents/reading-paths.md](agents/reading-paths.md) 只打开需要的文件。

## 1. 总体形态

```
index.html ──加载──▶ css/style.css
      └──加载──▶ js/board.js            （BG 命名空间 + 工具 + canvas 绘制）
                 js/charts.js           （决策图表）
                 js/calibration.js      （校准数学：纯函数，无 DOM）
                 js/games/*.js          （六个纯逻辑引擎，自我注册到 BG.games）
                 js/mock-ai.js          （离线演示 AI → BG.mock）
                 js/jev-client.js       （Jev 调用封装 → BG.jev）
                 js/app.js              （对局循环 / 模式 / 可视化 / 记录）
```

加载顺序即依赖顺序：`board.js` 必须在任何引擎之前；`jev-client.js`、`mock-ai.js` 在
`app.js` 之前。**新增 JS 文件必须同步改 `index.html` 的 script 标签和
`test/run-tests.js` 的加载清单**（两处都是硬编码顺序）。

## 2. 文件职责表

| 文件 | 行数量级 | 职责 | 能否在 Node 运行 |
|---|---|---|---|
| `index.html` | ~300 | 单页结构：tab 栏、棋盘容器、对局面板、Jev 设置、记录/动态区 | ❌ DOM |
| `css/style.css` | ~800 | 全部样式（亮色拟物风） | ❌ |
| `js/board.js` | ~150 | `BG` 命名空间、`BG.util`（clone/rnd/rand/shuffle/weightedPick/assert，rand/rnd 可种子化）、`BG.gfx`（HiDPI canvas、网格/星位/棋子/圆片/文字/高亮）、`BG.eventXY` | ✅ 无 DOM 依赖 |
| `js/games/gomoku.js` | 234 | 五子棋 15×15：五连判定、禁点不考虑、候选点预筛(≤64) | ✅ |
| `js/games/go.js` | ~330 | 围棋 9×9：提子/禁自杀/劫/双停数子(贴5.5) | ✅ |
| `js/games/xiangqi.js` | ~370 | 象棋 9×10：全部走子规则、照面、将军/绝杀/困毙 | ✅ |
| `js/games/chess.js` | ~440 | 国际象棋：易位/吃过路兵/升变/将杀逼和、perft 自检 | ✅ |
| `js/games/checkers.js` | ~320 | 西洋跳棋 8×8 英式：强制跳吃、连跳、升王即停 | ✅ |
| `js/games/chinese-checkers.js` | ~310 | 中国跳棋六角星 121 格：连跳递归、先抵对营 | ✅ |
| `js/mock-ai.js` | 51 | 离线 AI：优先 `engine.mockPick`，否则加权随机；合成概率分布 | ✅ |
| `js/jev-client.js` | 151 | 四渠道封装、429/529 指数退避、30s 超时、top-k 加权采样、成本统计 | ⚠️ 需 fetch |
| `js/charts.js` | ~300 | 概率条/局势曲线/可靠性图等 SVG 图表 | ⚠️ 需 canvas/DOM |
| `js/calibration.js` | ~190 | **校准实验室数学**（brier/skill/ece/mce/过度自信/可靠性分箱）：纯函数、零 DOM、Node 可加载 | ✅ |
| `js/app.js` | ~800 | **对局循环与全部 UI 编排**：`GAME_ORDER`、模式/执子、悔棋、暂停/单步、速度滑杆、决策面板、对局记录(localStorage)、`?test=1` 自检入口 | ❌ DOM |
| `functions/api/jev.js` | 37 | CF Pages Function：BYOK CORS 转发 | ❌ Workers 运行时 |
| `dev-proxy.py` | 95 | 本地静态托管 + `/api/jev` 转发（持久 TLS 连接） | Python 3 |
| `test/run-tests.js` | 66 | Node 自检：eval 加载引擎跑 `selfTest()` + mock 机机集成对局 | ✅ |

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

- `node test/run-tests.js`：eval 加载 `board.js` + `calibration.js` + 六引擎 → 逐引擎 `selfTest()`
  与校准数学自检；再 eval `mock-ai.js` + `jev-client.js` 跑 gomoku/cc/go 三盘 mock 机机集成对局。
- `index.html?test=1`：浏览器内同样本自检（六引擎 + 校准数学）。
- 环境变量 `BG_FAST=1` 让 mock AI 跳过模拟延迟（Node 集成测试内部已默认）。
- **任何引擎改动后这两个入口都必须通过**，这是唯一的验收标准（无测试框架，不引入）。
