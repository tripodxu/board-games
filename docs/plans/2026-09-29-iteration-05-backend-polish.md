# 迭代 05 · 后端化 + 前端全量打磨（2026-09-29）

- 状态：✅ 已完成
- 类型：后端化（架构轮，不占优化/创意/前端轮换的计数——它是其他轮次的地基）
- 触发：用户要求「调用 frontend-design / ui-ux-pro-max / impeccable / taste-skill 等
  前端设计 skill，全量打磨前端，重构成具有后端的项目」。

## 目标与验收

1. 项目具有真正的后端（本地可跑、持久化、可自托管），且**不违背 ADR-0001**。
2. 前端全量打磨：保留月白/玄墨/朱砂体系（refinement-preserve），修缺陷、补状态、
   统一浏览器表面；impeccable detect 零新增违规。
3. `node test/run-tests.js` 全绿（含后端契约测试）。

## 执行摘要

### A. 后端（ADR-0005）

- 新增 `server.js`（~590 行，零依赖 Node）：静态托管 + `/api/jev`（BYOK 代理，30s 超时）+
  `/api/games`（落盘 `games/<日期>/`，`flag:'wx'` 幂等原子写，文件名规则与 CF 端一致）+
  `/api/experiments`（`data/experiments.json` 按 tag upsert）+ `/api/stats`（跨对局聚合，
  按局 cal 记录）+ `/api/health`。滑动窗口限流（jev 60/分、其余 120/分）。
- 新增 `test/server-tests.js`：18 项 HTTP 契约测试，临时目录 + `listen(0)`，
  由 `run-tests.js` require 进唯一验收命令。
- 新增 `js/api.js`（`BG.api`）：同源客户端，失败一律 null；`app.js` 启动探活分三态。
- `.gitignore` 增加 `data/`（后端运行时状态；`games/` 仍是入库数据）。

### B. 前端接入

- `buildGameExport()` 补 `cal/firstWin/mock`（与战绩簿同口径，`calSamples()` 单一事实源）。
- 头部「后端」chip（已连接/无本地后端）+ 设置面板「数据存储」块
  （服务名/棋谱份数/实验轮数/最近同步结果）。
- 校准实验室双源合并：本机战绩簿 + 服务端 `cal.records`，按 gid|着法串去重。
- 实验战报双端归档（localStorage + 服务端，按 tag 合并）。

### C. 前端打磨（impeccable polish，craft-floor 为底线）

| 项 | 性质 | 内容 |
|---|---|---|
| `.mono` 无基类 | **真 bug** | 21 处挂载、字体从未切换；补基类 + tabular-nums |
| 窄屏 chip 裁切 | **真 bug** | 420px 实测品牌副标题 255px；改确定性换行（head-spacer 收起） |
| `＋/－``⚗` 字形 | 拒绝项 | 换自绘 SVG（chevron /  flask），与折叠钮同一笔法 |
| 浏览器表面 | 补齐 | caret-color、`#tabs` 主题滚动条 |
| 空态/加载态 | 补齐 | 棋谱面板空局文案、probe pending 态 |
| engine-metrics | 响应式 | ≤640px 两列，避免「最快/最慢」折行 |

detect 复跑：零新增违规（仅存量 4 项文档化例外：11px 侧栏小字 ×4、promoBox 边+投影、
渐变解析误报）。

## 验证证据

- `node test/run-tests.js`：全绿（六引擎 + 校准 + 集成 ×3 + jev-client + Pages +
  server-tests 18 项）。
- `npm run check:docs`：全绿。
- CDP 驱动真实点击（一次性验证台，未入库）：mock 渠道 19 手终局 → 棋谱 0.5s 内落盘 →
  设置块 `jev-qiguan-server v1.0.0 · 22 份`、「最近同步 · 成功」；file:// 回落
  「无本地后端」，对局/导出/记录不受影响。
- 截图四张（首屏/终局/设置/窄屏）存 `.work/`（不入库）。

## 遗留 / 后续候选

- `server.js` 与 `functions/api/*.js` 是两套实现，契约靠双端测试兜底；合并为同源需要
  新的运行时抽象（不值得，先这样）。
- 棋谱回放器：后端已能按局读取，前端差逐手重放面板（路线图已列）。
- 持久化是 JSON 文件；规模上来再换存储（届时新 ADR）。

## 追加：CF Pages 三端点移植（同日 · 方案 1）

用户确认走「Pages Functions 移植」后补齐线上后端（原计划只做到本地）：

- 新增 `functions/api/health.js` / `experiments.js` / `stats.js` + 共享 `_github.js`；
  持久化全走 GitHub（实验归档 `data/experiments.json`，stats 用 trees + raw 聚合），
  零新增 CF 绑定（不引 KV/D1/R2）。
- 硬约束：Workers 免费版 50 子请求/次 → stats 上限 40 份（1 trees + 40 raw + 1 contents = 42），
  截断时 `truncated: true`，前端显示「40+ 份」。
- 前端两处诚实化：`health.github === false` 时提示 token 未配置；stats 截断显示 `+`。
- 测试：`pagesApiTests`（stub fetch 模拟 GitHub，含 42 子请求预算断言与 45 份截断场景）。
- 明确不做：server.js 上 Workers（node:http/fs 不存在）；独立 Worker + wrangler
  （失去 push 即部署 + 引入 npm 工具链）。
