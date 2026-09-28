# 棋类对弈项目实施计划（board-games）

> 状态：✅ **已完成**（2026-09-28 收尾归档）。本计划从 `.zcode/plans/` 迁移入库，
> 保留作为决策上下文；实际完成情况以 [../status.md](../status.md) 为准。

## 目标

在 `board-games/` 新建轻量级棋类对弈项目：**五子棋、围棋、象棋、国际象棋、中国跳棋、西洋跳棋**
共 6 种（跳棋两种都要）。支持 **人 vs Jev、Jev vs Jev、人 vs 人**。纯静态 HTML/JS，
无构建、无框架、无第三方依赖，可直接双击打开，也可原样部署到 CF Pages 静态博客。

## 技术要点（已按官方 skill + docs.typesafe.ai 确认）

- **Jev 调用契约**：`POST https://api.typesafe.ai/v1/systemone`，Bearer 认证，
  `model: "jev-latest"`；走棋 = 一个 **Choice** 问题（每个合法着法 = 一个选项，≤255 个），
  同一次调用并行附加 Noul（局势优劣）与 Score（0–10 局势分）问题；响应含选中项、
  概率分布、confidence。429/529 指数退避重试。
- **state 序列化**：官方文档明确 Jev 仅收文本、中文精度较低 → 棋局一律用**坐标记法**
  （如 `B:H8,I9; W:I8; last:W I8`）组织成 JSON state，说明文字用英文。
- **围棋特例**：9×9 直接枚举合法点；候选 >255 时按"邻近棋子+星位+随机补齐"预筛（13 路暂缓）。
- **Jev 确定性对局会重复** → top-k 概率加权采样开关（argmax / top-3 / top-5），机机必备。
- **key 与渠道**：默认官方 API key，存浏览器 localStorage；设置页可切 OpenRouter / 同源代理。
  附 CF Pages Functions 代理文件（`functions/api/jev.js`），BYOK 透传。
- **离线演示模式**：无 key 时自动启用内置启发式 mock AI（带合成概率分布）。

## 文件结构（实际交付）

```
board-games/
  index.html            # 单页：游戏选择 tab + 棋盘 + 对局面板 + 设置
  css/style.css
  js/
    jev-client.js       # 四渠道封装 + 重试 + usage/耗时统计
    mock-ai.js          # 离线演示 AI
    board.js            # canvas 通用渲染/交互 + BG 命名空间
    charts.js           # 决策图表
    app.js              # 对局循环、三种模式、悔棋、采样设置、决策可视化、对局记录
    games/
      gomoku.js  go.js  xiangqi.js
      chess.js  checkers.js  chinese-checkers.js
  functions/api/jev.js  # CF Pages Function 代理（BYOK）
  dev-proxy.py          # 本地静态+代理二合一
  test/run-tests.js     # Node 自检：node test/run-tests.js
```

每个游戏引擎统一接口：`newGame / getLegalMoves / applyMove / getStatus / moveFromNotation /
serializeForJev / draw / humanClick`，可选 `passMove / mockPick`，必带 `selfTest`。

## UI

单页 tab 切换 6 种棋。对局面板：模式与执子选择、走子记录、**Jev 决策可视化**
（每步 top-3 概率条、confidence、耗时、token 用量与成本估算）、悔棋/重开；
Jev vs Jev 模式带速度滑杆、暂停/单步。

## 实施顺序（已按此执行）

1. **骨架 + 五子棋跑通**：index.html/board.js/app.js + gomoku.js + mock-ai，三种模式全链路可玩。
2. **接真实 Jev**：jev-client.js 对官方 API，五子棋真实人机/机机对弈调通（含决策可视化、错误处理）。
3. **其余棋种**：chess.js → xiangqi.js → checkers.js → chinese-checkers.js → go.js（规则引擎工作量从重到轻）。
4. **收尾**：CF Pages Function 代理、README、各引擎自检全绿、file:// 直开与
   `python dev-proxy.py` 双验证。

## 成本预估（实测口径）

每步 state 约 0.5–1.5K token，官方定价输入 $42/百万 token → 单步约 $0.00005–0.0001，
一整局 < $0.05，Jev vs Jev 连续挂机也无压力。
