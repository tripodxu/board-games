# ADR-0004：棋种引擎统一接口 + selfTest 自检

- 状态：accepted（2026-09-28）
- 背景：六种棋规则差异巨大，但对弈循环/UI/决策面板完全相同。需要让"加新棋种"
  变成 localized 的工作，且任何 agent 不改 UI 就能加棋。

## 决定

每个引擎是独立 IIFE 文件，`BG.register()` 自我注册，实现统一接口：
`newGame / getLegalMoves / applyMove / getStatus / moveFromNotation / serializeForJev /
draw / humanClick`，可选 `passMove / mockPick`，**必须**带 `selfTest()`。
`app.js` 只通过接口与引擎交互；`GAME_ORDER` 决定 tab 顺序。
`test/run-tests.js` 用 Node `eval` 加载全部引擎跑 selfTest，并跑 mock 机机集成对局。

## 后果

- 优点：新棋种 = 一个新文件 + 两行注册（`GAME_ORDER`、测试清单）；
  引擎是纯函数集合，可在 Node 无 DOM 自检；测试零框架；
  agent 可以只读一个引擎文件就完成单棋种修改（并行协作的文件边界天然成立）。
- 缺点：接口靠约定而非类型系统，签名漂移只能靠 review + selfTest 兜底；
  `eval` 加载让测试无法享受模块缓存/源码映射（可接受）。
- 约束：引擎禁止碰 DOM/canvas 之外的东西；`applyMove` 等必须纯函数；
  move 的 `notation` 必须唯一稳定（它是 Jev Choice 的键）。

## 考虑过但放弃

- TypeScript + 接口定义：违背 ADR-0001 零构建；接口文档（docs/engine-interface.md）
  + selfTest 已提供同等保障。
- 继承基类：六种棋的规则/渲染差异远大于共性，组合优于继承。
- 现成棋类库（chess.js 等）：只覆盖个别棋种，引入依赖违背 ADR-0001，
  且失去"每个合法着法=一个 Choice 选项"所需的统一着法枚举。
