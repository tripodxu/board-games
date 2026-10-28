# performance.md — 性能基线与优化台账

> 2026-10-28 全仓审计（渲染 / 网络 / 计算内存三路并行静态审计 + 本地实测）后建立。
> **原则：只记可复现的数字与「已做 / 待做」结论，不记感觉。**
> 复现命令见文末「验收口径」。

## 一、结论（先看这一句）

**瓶颈高度集中，不是「到处都慢」**——三处：

1. **战术计算同步阻塞主线程**（最痛）：一次 AI 落子，主线程冻结 0.2–4.6 秒
2. **首屏单包 + 取数串行瀑布**：客户端 JS 269 KB（gzip 98 KB），启动走 3 个 RTT
3. **每手重复全量重绘**：一次落子触发 2 次 canvas 全量重绘 + 2 次 `renderTurn` + 趋势 SVG 整棵重建

## 二、实测基线（2026-10-28）

| 指标 | 实测值 | 来源 |
|---|---|---|
| 客户端 JS | 原始 **276 KB** ｜ gzip **101.5 KB**（同一轮审计的初测为 269 KB / 98.2 KB，收口重测略增，**未设 CI 基线**） | `dist/client/assets/index-*.js` |
| CSS | 46.1 KB ｜ gzip 9.6 KB | 同上 |
| `index.html` | 34.2 KB（内联 SVG 图标为主） | 同上 |
| `computeTactics`（大众模式，随机中局 40 手） | 中位 **199 ms** ｜ 平均 565 ms ｜ 最坏 **3836 ms** | `npm run bench:tactics` |
| `computeTactics`（**禁手模式**，同口径） | 中位 312 ms ｜ 平均 **101.7 s** ｜ 最坏 **744.9 s** | 同上 |
| `serializeForJev` | 大众 1.9 ms ｜ 禁手 **71 ms**（禁手全盘扫描，约 37×） | 同上 |
| VCT 搜索（**真实语料** 586 回合标定） | 平均 **444 ms** ｜ p90 **1647 ms** ｜ 最坏 **4586 ms** | `src/core/engines/gomoku.ts` 头部注释 |

> 基准用随机盘面，**比真实对局更乱**（威胁点更多），数字偏悲观，用于看量级与尾部；
> 真实体验参照最后一行真语料标定。

## 三、已落地

### P0-2 回退 canvas 上的 CSS `filter`（2026-10-28）

- **原因**：canvas 带 `filter` 时，浏览器无法把位图直接送上屏，每次 `draw()` 之后都要对整块
  （560×560×DPR）再跑一遍滤镜管线——等于把棋盘重绘成本再乘一遍，且暗色主题 100% 命中。
- **改法**：暗色压光做进**绘制层换颜色**。
  - `src/core/gfx.ts` 新增 `GfxPalette` + `setGfxTheme()` / `gfxTheme()`：`clear` 用 `palette.board`、
    `intersections` / `cells` 用 `palette.line`
  - `src/ui/board-theme.ts`（新）读 `prefers-color-scheme` 并订阅 change；`src/app/boot.ts` 里
    `watchBoardTheme(() => redraw(ctx))`
  - 删除 `--board-filter` 令牌与 `#board` / `.rp-board` 上的 `filter`
- **取值口径**：暗色 = 浅色做 `brightness(.92) saturate(.95)` 的等价结果
  （`#FAFBFD→#E6E8EA`、`#3A4048→#353B42`）。**只压亮度不换色系**——棋盘若换深色底，黑子会糊掉。
- 契约测试：`test/ui/board-theme.spec.ts`（4 例）

### P0-3 探活不再当首屏闸门（2026-10-28）

- **原因**：旧流程 `initBackend`（探活 8 s 超时）→ 两路补数 → 三块面板，三轮串行瀑布；
  后端不在线时要等满 8 s 才降级，三块面板跟着一起拖住。
- **改法**：`src/core/api/client.ts` 新增 `CallOpts.timeoutMs`，`health()` 单独 **2 s**
  （`PROBE_TIMEOUT_MS`，其余仍 8 s）；`src/app/boot.ts` 把探活与三块面板取数**四路并发**
  （三块面板离线时各自降级为 `null → 「加载中…」`，都不依赖 `ctx.backend.mode`）。
- 契约测试：`test/app/boot-parallel.spec.ts`（2 例：让 `/api/health` 永不 settle，
  断言三块面板请求照样发出——串行时代根本不会发）

### P0-4 棋谱面板全量重建是**真 bug**，不是纯性能问题（2026-10-28 收口修复）

- **原因**：`src/ui/panels/cockpit.ts` 的 `rebuildLedger()` 把 `#ledger` 自己当查询根传给
  `appendLedgerLine()` ⇒ 后者内部 `qs(ledger, '#ledger')` 查的是**后代**、恒为 `null` ⇒
  **清空后一行也填不回来**。触发面很宽：每局第一手（`loop.playMove` 里 `history.length === 1`
  走全量重建）、悔棋、换局、切禁手规则（`loop.ts:166 / 513` 的 `renderLedgerPanel`）。
  症状：棋谱面板第一手后空白（第二手起只从第 2 手开始显示），悔棋/换局后整列清空。
- **改法**：抽出纯构造 `ledgerRow()`，`append` 与 `rebuild` 共用；重建用 `DocumentFragment`
  批量 append 并在循环外只写一次 `scrollTop`（顺带消掉「每行一次强制同步布局」）。
- 契约测试：`test/ui/ledger-panel.spec.ts`（4 例：3 手重建含首手 / 空历史只留空态 / 幂等 /
  增量追加）。**负向对照**：把 `cockpit.ts` 还原成旧实现后 4 例里 3 例红，修复后全绿。

## 四、待做台账

### P1（结构性收益）

| # | 问题 | 证据 | 改法 |
|---|---|---|---|
| 1-1 | 首屏单包，5 个已退役引擎仍随首屏下载 | `vite.config.ts` 无 `manualChunks`/`target`；`src/core/registry.ts:7-12` 静态 import 全部 7 个引擎。源码：gomoku 67.9 KB 保留，另 5 个共 77 KB；`tactics-versions.ts` 67.6 / `jev/client.ts` 42.8 / `charts.ts` 16.6 KB 同在关键路径 | `registry` 改按需 `await import()`；报告/回放/校准面板懒加载；加 `manualChunks` + `build.target` |
| 1-2 | 每手重复全量重绘（2× canvas + 2× renderTurn + 趋势 SVG 重建） | `src/app/loop.ts:241,246,353`；`src/ui/charts.ts:145-263`；底图每帧重算且 `gfx.intersections` 是 30 次独立 stroke（`src/core/gfx.ts`） | 底图烘到离屏 canvas 后 `drawImage`；落子→算提示→**只画一次**（dirty flag + rAF）；趋势图复用 `<svg>` 只更新 `d` |
| 1-3 | 盘面数据结构与临时数组（根因级） | `type Board = number[][]`（`gomoku.ts:36`）+ `clone()` 走 JSON 往返（`src/core/clone.ts:10-12`）；`nearEmpties` 每次 225×25 = 5625 次取值（`gomoku.ts:337-352`），搜索每节点重算 | `Int8Array(225)` + `new Int8Array(src)` 拷贝；候选写预分配 `Int32Array` + 长度游标；`Uint8Array(225)` 做 visited。**风险高**：必须靠 172 例引擎测试 + 金样差分守门，单独立项 |
| 1-4 | 禁手模式组合爆炸（实测最坏 745 s） | `gomoku.ts:896-907` 每空点跑 `forbidKind`；`src/core/tactics.ts:214-227` `threatMakers` 对每个候选跑一次 `countWinningPoints`（内部再全盘 `applyMove + getStatus`） | 候选集收到 ≤64；致胜点改引擎侧线表 O(方向数) 判定（不走 `applyMove+getStatus`）；按 (盘面 hash, side) 缓存 |
| 1-5 | 战术层同步跑在主线程 | `src/app/panels.ts:677`（`setTimeout(0)` 只让出一帧）；`src/core/tactics-hints.ts:70-158`；`src/app/loop.ts:246` | 复用 `src/app/rapfi-worker.ts` 的 Worker 范式；**过渡版**先做防抖 + 可取消 + AI 思考中跳过 |

### P2（清理与防劣化）

| # | 问题 | 证据 | 改法 |
|---|---|---|---|
| 2-2 | `/api/stats` 单次回传最多 500 局逐手校准样本 | `src/worker/db/stats.ts:26,142-146`；`src/app/panels.ts:217-242` | 拆端点：轻总览 + 校准直方图服务端算 |
| 2-3 | 实验历史 localStorage 无上限增长（对照战绩簿有 `RECORDS_KEEP=60`） | `src/ui/panels/experiment-report.ts:796-798,152-168` | 加 `EXP_HISTORY_KEEP`（如 30 轮） |
| 2-4 | 回放视图把整局每个局面快照全留内存（226 份 15×15 嵌套数组 ≈ 数 MB） | `src/app/panels.ts:409-439` | 存记法序列 + 游标，或只缓存当前 ply ±K 窗口 |
| 2-5 | 图表 `mousemove` 未节流，每次事件 2× `getBoundingClientRect` + 重建 tooltip | `src/ui/charts.ts:236-253` | 缓存 rect，更新放 rAF，tooltip 复用节点 |
| 2-6 | Rapfi 10.7 MB 资产首次使用才拉；每次建会话再 `.slice()` 复制两份（峰值 ~33 MB） | `src/app/rapfi-worker.ts:76,91-105,246-247` | 切渠道时后台预取写 Cache API；会话复用同一份 buffer |
| 2-7 | 终局同步长任务：战绩簿全量 parse/stringify ×3 + 全表重建 + 校准重算 | `src/app/loop.ts:450-456`；`src/app/panels.ts:190-194,245` | 挪到 idle；校准图只在展开时算 |
| 2-8 | 思考计时器 100 ms `setInterval` 改带动画节点的 `textContent` | `src/app/clock.ts:23-27` | 250–500 ms 或仅可见时更新 |
| 2-9 | `chunkSizeWarningLimit: 2048` + `sourcemap: false` 掩盖体积回归 | `vite.config.ts` | 阈值回 500–600 KB + CI 基线；`sourcemap: 'hidden'` |
| 2-10 | API 层无重试、无 ETag、无 in-flight 去重；面板每次展开重复拉取 | `src/core/api/client.ts:60-82`；`src/app/bindings.ts:179-190,257-262` | GET 一次短退避重试 + TTL 缓存 + 请求去重 |

## 五、已经做对的（不要重复优化）

- **无轮询**：唯一 `setInterval` 是思考计时器，不产生网络（`src/app/clock.ts`）
- **AI 侧重试策略完整**：网络 4 次、429/529 按 `Retry-After` 封顶 20 s、401 不重试（`src/core/jev/client.ts:348,363-413`）
- **棋谱 / 决策流已增量**：`appendLedgerPanel` / `prependFeedPanel`（`src/app/loop.ts:239-244`）
- **resize / 回放滑杆已 rAF 合帧**（`src/app/bindings.ts:326-335`；`src/app/panels.ts:490-499`）
- **事件无泄漏**：`onOnce` + `WeakMap` 去重（`src/ui/dom.ts:248-265`）
- **CSS 动画只动 transform/opacity**，带 `prefers-reduced-motion` 降级
- **后端健康**：无 N+1（整页 `WHERE game_id IN (...)`）、聚合全在 SQL、LIMIT + keyset 游标、索引齐全
- **DOM 层统一 `el()` / `textContent`**，无 innerHTML 拼串（仅 3 处残留）

## 六、验收口径（都可复现）

| 维度 | 怎么量 | 现状 → 目标 |
|---|---|---|
| 主线程 | Chrome Performance 录一次「AI 落子」，看 Long Task | 199 ms–4.6 s → **< 50 ms** |
| 计算 | `npm run bench:tactics`（`BENCH_PLY` / `BENCH_RUNS` 可调） | 记录中位 / 最坏 |
| 体积 | `dist/client/assets` 的 gzip / brotli 字节数进 CI 基线 | 98.2 KB gzip（未设基线） |
| 首屏 | 三块面板数据到达时间 | 原受 8 s 探活闸门支配 → 现已并发 |

改战术层或引擎数据结构前后，各跑一次 `npm run bench:tactics`，用数字判断「快了多少」。

**跑法提醒**：默认口径是 `BENCH_PLY=40`、`BENCH_RUNS=9`，且**禁手那一档的单次调用本身就能到几百秒**
（见 §二 基线表）——所以默认全量是「泡杯茶」级别，不是秒级检查。日常改动先用小样本看量级与尾部：

```bash
BENCH_PLY=8 BENCH_RUNS=3 npm run bench:tactics      # 十几秒到几分钟，够看出有没有量级变化
```

（PowerShell 用 `$env:BENCH_PLY=8; $env:BENCH_RUNS=3; npm run bench:tactics`。）
**别拿小样本的绝对数当基线**——§二 的数字是默认口径跑的，两者不可直接比。
