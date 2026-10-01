# ADR-0012：引入 Vite + TypeScript 构建链（部分取代 ADR-0001）

- 状态：accepted（2026-10-01）
- 取代：[ADR-0001](0001-pure-static-no-build.md) 的**技术部分**（零框架/零构建/零依赖）；
  ADR-0001 中「引擎可被 Node 直载做自检」「不引入 UI 框架」两条精神在本篇延续
- 背景：项目此前是「原生 HTML/JS + 16 个 `<script>` 标签 + `BG` 全局命名空间」，
  零构建、双击即玩。代价在规模上来后集中爆发：
  `js/app.js` 2065 行单文件承担全部 UI 编排；`jev-client.js` 34 KB 里传输层与战术层
  纠缠（战术逻辑无法单测）；`test/run-tests.js` 108 KB 里有约 30 组「读源码文本做字符串
  匹配」的 DOM 契约断言（status.md 自认「UI 行为无自动化回归护栏」）；
  本次数据层重构（Worker + D1）还需要类型化的 API 契约与模块边界。

## 决定

1. **前端引入 Vite（构建/开发服务器）+ TypeScript**；`index.html` 从 16 个脚本标签
   收敛为单一 `<script type="module" src="/src/main.ts">`。
2. **不引入 UI 框架**（React/Vue/Svelte 一律不用）：DOM 与 canvas 仍是原生代码，
   视觉体系（月白/玄墨/朱砂）与「设计例外」三项不变。
3. **模块结构**：`src/core/**`（纯逻辑，零 DOM，Node 可直载）、`src/ui/**`（DOM 层）、
   `src/app/**`（对局编排）、`src/worker/**`（服务端）、`src/shared/**`（前后端共用映射）。
   `BG` 全局命名空间退役，改为具名 ES 模块导出。
4. **引擎保持可被 Node 直载**：`tsconfig` 开 `erasableSyntaxOnly`（禁 `enum`/`namespace`/
   构造器参数属性），Node ≥ 22.18 直接剥离类型运行 `.ts`——**引擎自检继续用纯 Node，
   不引入测试框架**（vitest 只覆盖 Worker/D1/UI）。
5. **差分金样是迁移的安全带**：在旧实现删除前，用 54 份真实棋谱逐手重放生成金样
   （`test/fixtures/golden/`），新引擎必须逐位一致；允许的例外必须登记理由
   （沿用 ADR-0008 的纪律：宁可少报，不可错报）。
6. **本地引擎资产**（Rapfi 10.7 MB WASM）放 `public/`，由构建原样拷贝、保持懒加载。
7. **`codeVersion` 改为构建期注入**（`package.json` version + git short sha），
   退役「手工 bump 忘记就归因失效」的历史限制。

## 后果

- 优点：类型检查覆盖前后端契约；模块边界让战术层/导出层可单测；
  HMR 提升开发效率；`app.js` 的 20 个段落可按边界拆成模块；
  源码文本断言可以换成真正的运行时测试（happy-dom）。
- 缺点：**失去 `file://` 双击即玩**（module + 绝对路径在 file:// 下必然失败）；
  引入 `npm install` 前置；构建产物成为唯一部署形态；仓库多了一层 `dist/` 概念
  （已 gitignore）。
- 约束：`src/core/**` 不得 import DOM/`window`/canvas（用 ESLint 规则 + 代码评审守）；
  引擎的 `selfTest()` 契约（ADR-0004）逐字保留；新增核心模块必须同时出现在
  引擎自检与 Vite 构建两条路径上。

## 考虑过但放弃

- **继续用原生 JS + IIFE**：本次要动的数据层（类型化 API 契约）与 UI 拆解
  （2065 行闭包）在没有模块与类型的情况下无法安全推进；`BG` 命名空间已经把
  「加载顺序即依赖顺序」变成硬编码清单（`index.html` + `test/run-tests.js` 两处），
  每加一个文件都要两处同步——这个成本已经付了太久。
- **只迁后端、前端保持原生**：能省一半风险，但会留下「后端 TS + 前端 eval 加载」
  的双语言夹缝，且数据层契约（`gameUid`/分页/设备标识）仍要在无类型的 `app.js`
  里手工对齐——正是最容易出错的地方。
- **引入 React/Vue**：视觉与交互（canvas 棋盘、密集数据面板）不需要虚拟 DOM；
  引入框架等于重画整个前端，与本轮「重构数据层与模块边界、视觉零漂移」的目标冲突。
- **用 tsc 产出 JS 再跑自检**：多一步构建且让「引擎纯逻辑」多一层间接；
  `erasableSyntaxOnly` + Node 原生类型剥离已经够用。
