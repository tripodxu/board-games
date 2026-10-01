# src/ui —— 视图层（旧原生 JS 的 TS 移植）

> **迁移注记（2026-10-01 起）**：视图层的**唯一现役位置就是本目录 `src/ui/**`**；
> 旧的 `js/*.js`（`board.js`/`charts.js`/`app.js` 的 DOM 段）已随 P8 退役，只存在于 git 历史，
> 上表最后一列「旧实现来源」是**史料对照**，不是可改的活代码。
> 另外三点现状说明（**不改变下面的表结构**）：
> 1. 迁到 P7 之后新增了三个已存在的面板文件——`panels/replayer.ts`（棋谱回放）、
>    `panels/leaderboard.ts`（排行榜）、`panels/openings.ts`（开具体验）——本表的模块职责清单
>    尚未收录它们，`openings.ts` 的 `GAME_IDS` 属公共注册项（归编排者）。
> 2. 样式表现在只有一份：`styles/style.css`，由 `index.html:11` 的
>    `<link rel="stylesheet" href="/styles/style.css">` 引入，构建时经 Vite 打包进 `dist/client/assets/`；
>    旧的 `css/style.css` 已随 P8 删除，本目录不拥有它。
> 3. 本节以下内容全部仍然有效：契约（幂等策略、存储键名、DOM id）没有随迁移改变。

本目录是 `docs/plans/2026-10-01-workers-d1-rebuild.md` §6 里「视图层」那一列的全部零件：**只负责把 props 渲染成
DOM / SVG / canvas，并把用户操作通过 handlers 回调出去**。这里不持有棋盘交互态以外的业务状态，不读
`localStorage`（存储一律注入），不发网络请求，不 import `node:*`——装配（`src/app/**`）负责把
`src/core/**`（session / persist / registry / tactics-versions）接到这些零件上。

## 1. 模块职责

| 文件 | 行数 | 职责 | 旧实现来源 |
| --- | --- | --- | --- |
| `dom.ts` | 319 | 极小 DOM 工具：`el`/`svgEl`/`append`/`qs`/`qsa`/`byId`/`clear`/`replaceChildren`/`setText`/`toggleClass`/`setHidden`/`on`/`onOnce` + 展示格式化 `fmtPct`/`fmtNum`/`fmtSignedPct`/`fmtCost`/`fmtTokens`/`fmtLatency`/`fmtDateTime`/`fmtClock` | `js/app.js` 里散落的 `$()`/`el()`/`fmt*` |
| `board-render.ts` | 87 | 棋盘 canvas 渲染器：按 `engine.meta` 做 DPR setup，把 `draw/ resize/ destroy` 转发给引擎的 `draw()` | `js/app.js:479,497-499`、`js/board.js` |
| `charts.ts` | 392 | 纯 SVG 图表：趋势图（含十字线/浮动提示）、校准可靠性图、置信度环、概率条 | `js/charts.js` |
| `panels/options.ts` | 161 | 下拉选项表（渠道/战术/思考时长/topK）+ `fillSelect` + `sideAttribution`/`machinePairText` | `js/app.js` 顶部常量与 `machinePairText` |
| `panels/side-config.ts` | 171 | 双方覆盖的三控件（渠道/战术/思考），抽屉版与实验 A/B 版 | `js/app.js` 的 `renderSideCfg`/`renderExpSides` |
| `panels/settings.ts` | 289 | Jev 设置抽屉：动态重建 `#drawerBody`、按渠道显隐、探针输出、开合 | `js/app.js` 设置抽屉段 |
| `panels/experiment.ts` | 417 | 对比实验：状态机（`ExperimentState`）、A/B 档位、模式开关、速度、局数、状态与逐局结果 | `js/app.js:1139-1238,1875-1910` |
| `panels/experiment-report.ts` | 344 | 实验历史/战报：注入式历史存储（含两条内置种子）、累计统计、每轮卡片 | `js/app.js:1240-1392` |
| `panels/record-book.ts` | 233 | 战绩簿：注入式记录存储、五项统计、最近 12 局表格 | `js/app.js:1543-1626` |
| `panels/cockpit.ts` | 517 | 驾驶舱：回合徽标、duel 双方名、引擎灯、指标条、延迟火花、趋势面板、最新一手、评估条、花费 chip、走子流、账本 | `js/app.js` 驾驶舱段 |
| `panels/collapse.ts` | 137 | 侧栏折叠：`.panel.collapsible` 的 `.folded` 切换 + 展开时按需重绘 hook + 注入式持久化 | `js/app.js:204-313` |
| `panels/tabs.ts` | 146 | 侧栏页签：`play/exp/data` 三页切换、方向键循环、注入式持久化 | `js/app.js:204-313` |

## 2. 幂等策略（两类，文件头注里都写了）

- **重建子树（render-* 系列）**：`renderSettings` / `renderRecords` / `renderExpHistory` / `renderExperimentSides` /
  `renderSideSlotInto` / `renderLatestPanel` / `renderTrendPanel` / `feedCard` 等每次调用都先
  `replaceChildren`/`clear` 再重新生成节点。事件用 `on()` 直接绑在**新建的节点**上，所以不会重复绑定；
  重复调用只反映最新 props，不累加监听器。
- **就地更新（sync-* / apply-* / render*Status 系列）**：`syncMatchSettings` / `renderExpStatus` /
  `renderExpResults`(非空时也是重建结果区) / `applyFolded` / `renderModeSwitch` / `renderTurnBadge` /
  `renderChannelChip` / `renderSpark` 等只改既有节点的文本、`value`、class、`hidden`，不换节点。
- **只绑一次（init-* / bind-* 系列）**：`initFolds` / `initSideTabs` / `bindModeSwitch` / `bindMatchSettings` /
  `bindExperimentPanel` / `bindClearRecords` 用 `dom.onOnce()`（`WeakMap` 记账）保证同一元素同一事件只绑一次，
  重复调用安全——这是「装配可以随便重入」的前提。

## 3. 存储注入（`StorageLike`）

`src/core/persist.ts` 只有设置段（`STORE_KEY='jev_qiguan_settings_v2'`）。下列键**不在 core 的 persist 里**，
视图层按 `StorageLike`（`getItem/setItem/removeItem?`）形态注入，装配时把真 `window.localStorage` 传进来即可，
测试里传内存实现：

| 键 | 常量 | 工厂 |
| --- | --- | --- |
| `jev_qiguan_records_v1` | `record-book.ts: RECORDS_KEY` | `createRecordStore(storage)` |
| `jev-exp-history-v1` | `experiment-report.ts: EXP_HISTORY_KEY` | `createExpHistoryStore(storage)` |
| `jev_qiguan_panels_v1` | `collapse.ts: FOLD_KEY` | `createFoldStore(storage)` |
| `jev_qiguan_sidetab_v1` | `tabs.ts: SIDETAB_KEY` | `createSideTabStore(storage)` |

四个工厂的读写全部包在 `try/catch` 里：存储被禁用/写满/内容损坏时退回默认值或空列表，绝不抛给调用方。

## 4. DOM 契约（与 `index.html` 对齐）

视图层不自造 id 体系，全部沿用 `index.html` 里已存在的容器：

- 页签：`.side-tabs button[data-pane]`、`.side-pane#pane-play|pane-exp|pane-data`
- 折叠：`.panel.collapsible[data-panel]` 内的 `.panel-title` 与 `button.fold`
- 设置抽屉：`#settingsDrawer`、`#drawerMask`、`#drawerClose`、`#drawerBody`（内部动态生成 `#channel`、
  `#tacticsVersion`、`#rapfiThinkMs`、`#endpoint`、`#apiKey`、`#orKey`、`#probeBtn`、`#probeOut`、`#topK`、
  `#gameSync`、`#sideCfgBlack`、`#sideCfgWhite`），外加常驻的 `#channelChip`、`#modeHint`
- 双方覆盖：`#sideCfgBlack|#sideCfgWhite`（`#blackChannel|#blackTactics|#blackThinkMs`、`white…`）、
  实验 A/B：`#expSideA|#expSideB`（`#expChanA|#expTacA|#expThinkA`、`expChanB|…`）
- 对局/实验：`#mode`、`#side`、`#speed`、`#speedVal`、`#speedRow`、`#expGames`、`#expStatus`、
  `#expStartBtn`、`#expStopBtn`、`#expResults`、`.mode-switch button[data-mode]`
- 战报：`#expHistory`、`#expReportNote`；战绩簿：`#recordStats`（5 个 `.rs`）、`#records`、`#recordSummary`、`#clearRecords`
- 驾驶舱：`#turnBadge`、`#duelFirst/#duelSecond`、`#engineStatus/#engineModel`、`#emMoves/#emTokens/#emCost/#emFastest`、
  `#latSpark/#sparkNow`、`#trend/#trendNote`、`#latest/#latestNote`、`#evalBar/#evalFill`、`#costChip`、`#feed`、`#ledger`、`#rankCount`
- 图表容器：`#trend`（趋势）、校准图容器（`renderCalibrationChartInto`）、`.trend-tip`

`root` 参数（`UiRoot = HTMLElement | SVGElement | Document`）通常传面板容器；**但** `byId()` 系列
（`renderSideSlot`、`setDrawerOpen`、`renderChannelHint`、`renderChannelChip`、`initFolds`/`initSideTabs` 的默认 root）
走全局 `document`，因此测试夹具必须挂在真实 `document.body` 上。

### 4.1 例外：P7c 三个新面板的 DOM 契约（`replayer.ts` / `leaderboard.ts` / `openings.ts`）

上面 §4 的「复用 `index.html` 既有 id」是**老面板的契约**（`record-book.ts` / `cockpit.ts` /
`settings.ts` / `collapse.ts` / `tabs.ts` / `experiment*.ts` 等仍然照旧有效，不要改它们的写法）。
P7c 新增的三个面板**刻意不走**这套约定，它们的契约是：

1. **只吃 `props.root: HTMLElement`**（挂载点由装配层传进来），自身**不发** `document.getElementById`、
   不用 `byId`，也不假设自己已出现在 `index.html` 里——容器与 root 的关系完全由调用方决定
   （`replayer.ts:14-15,59`、`leaderboard.ts:10,22`、`openings.ts:16,46`）。
2. **渲染时会覆写 `root.className`**：回放器写 `'rp'`（`replayer.ts:290`）、排行榜写 `'lb'`
   （`leaderboard.ts:135`）、开具体验写 `'op'`（`openings.ts:169`）。因此**挂载点必须用 id 或
   `data-*` 定位、不能用 class 选择器**（class 会被冲掉），并且**调用方预先加在 root 上的其它
   class 会丢失**——需要额外 class 请写在内层节点上。
   回放器另有两条附加约定：它会在 root 上设 `tabindex="0"` / `role="group"` / `aria-label`
   （`replayer.ts:287-289`），并把 `keydown` 监听挂在 **root 本身**（`replayer.ts:318-335`），
   因为 happy-dom 实测派发在 root 上的按键**不会**冒泡到 `.rp-panel`。
3. **空态三态语义由面板自己负责**，装配层**不要**把 `null` 折成 `[]`：
   `null` = 「加载中…」、`[]` = 「暂无数据」、有数据 = 表格（`rows` 原样透传）
   —— 见 `leaderboard.ts:5,23,139-142` 与 `openings.ts:5,47,177-179`。
   `replayer.ts` 没有这个三态：它的 `info` / `moves` 都是必填（`replayer.ts:57-67`），
   老棋谱缺字段由面板显示「未知」。
4. 三者都仍是「重建子树」幂等（每次 render 先 `clear(props.root)` 再重建，事件绑在新建节点上），
   与 §2 的第二类策略一致——例外只在**挂载方式**，不在幂等策略。

## 5. 装配阶段的 TODO（留给 `src/app/**`）

1. `panels/cockpit.ts` 的 `CockpitProps` 引用了 `src/core/session.ts` 的 `SessionMeta/SessionMove/SessionMode/TrendMode`
   与 `src/core/view/board.ts` 的 `LatestItem`；装配时要保证 session 的实际实例形状与之一致。
2. `panels/experiment.ts` 的 `expInfoFor()` 返回 `SessionExportInfo`（`src/core/session.ts`）——装配时把它塞进
   `S.ui.expInfo` 的等价位置，用于「素材归属」文案。
3. 四条持久化键的注入（见 §3）与「落盘时机」（`saveGameRecord` 由 app 在终局时调用 `createRecordStore().save()`）。
4. 实验历史里的两条内置种子（`EXP_SEED`，旧 `js/app.js:1259-1275`）会在存储为空时落盘一次；若要「干净首发」，
   装配层需自行决定是否跳过。
5. 视图层**不**持有棋盘交互态以外的状态：`S.ui`（选中/悬停/提示）由 `board-render.ts` 的调用方传入 `BoardView.ui`。
