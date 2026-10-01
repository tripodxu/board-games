# ADR-0001：纯静态、零框架、零构建、零依赖

- 状态：**部分被 [ADR-0012](0012-vite-typescript-build-chain.md) 取代**（2026-10-01：零框架/零构建/零依赖的技术部分终止，
  改为 Vite + TypeScript + Hono；「引擎可被 Node 直载」「不引入 UI 框架」两条精神延续）
- 历史状态：accepted（2026-09-28）
- 背景：项目要同时满足三个场景——双击即玩（file://）、贴进静态博客/CF Pages 原样部署、
  以及任何 agent 能低成本读懂改懂。

## 决定

原生 HTML/CSS/JS（ES5+ 兼容），不用任何框架、打包器、CDN、npm 依赖。
Python 仅用于可选的本地代理（`dev-proxy.py`，标准库）。

## 后果

- 优点：零安装零构建；`git clone` 即可运行；静态托管零配置；代码即产物，review 成本低；
  引擎可被 Node `eval` 加载做自检（测试不需要框架）。
- 缺点：无模块系统，靠 IIFE + `BG` 命名空间 + script 标签顺序；无类型检查；
  大文件只能靠人工约定拆分（`app.js` 已 ~800 行，见 status.md 技术债）。
- 约束：新增 JS 文件必须同步 `index.html` 与 `test/run-tests.js` 的加载清单；
  浏览器与 Node 双端可加载（`board.js` 不依赖 DOM）。

## 考虑过但放弃

- Vite + 框架：违背"双击即玩/原样部署"，引入构建链与依赖更新负担。
- ES modules（`<script type=module>`）：`file://` 下被 CORS 拦，直接破坏双击即玩。
- npm 测试框架（vitest/jest）：引擎自检用 `selfTest()` + Node 脚本已足够，
  引入框架的成本大于收益。
