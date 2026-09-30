# 实验室改造设计：战术版本化 · 全局设置抽屉 · 自由对阵 · 鲜明命名

日期：2026-09-30 · 状态：已确认（用户拍板 5 项决策）· 关联：ADR-0009 / ADR-0010（随本文档新建）

## 1. 背景与目标

五子棋实验室（对比实验 / 战绩簿 / 校准实验室）已跑过两轮基线（`EXP_SEED`，[js/app.js:833-858](../../../js/app.js)），下一阶段 P1 目标（.work/handoff.md）是建立 ≥24 局**可归因**基线。当前机制阻碍该目标，也影响日常使用，共 5 项诉求：

| # | 诉求 | 现状症结（锚点） |
|---|---|---|
| R1 | 全局设置收进右上角专属入口 | 设置散在右侧栏第三页签 `pane-settings`（index.html:239-349）；Rapfi 时长被 `ch !== 'rapfi'` 条件藏匿（js/app.js:65），用户「直接调用看不到」 |
| R2 | 黑白方自由选择引擎；ai-ai 不止「Jev vs Jev」 | ai-ai 双方共用同一 `effectiveChannel()`（js/app.js:88-100）；`#side`（index.html:253-255）在 ai-ai 下失效；只有实验面板能分方配渠道（index.html:315-332） |
| R3 | 战术分版本，可搭载 Jev 或随机算法对弈；证明每版进步 | 战术层硬编码无版本（js/jev-client.js:239 `computeTactics` + :488-539 接管链）；版本沿革只存在于 git 提交史 |
| R4 | 实验报告/棋谱命名鲜明（谁打谁、战术版本、Rapfi 时长） | 实验 tag 纯时间戳（js/app.js:769）；棋谱文件名 `gid-stamp.json`（server.js:328）；战绩簿行无对阵信息（js/app.js:1190-1202） |
| R5 | 棋盘下方罗列历代战术版本供参考调用 | 无任何版本沿革展示位；棋盘下方 controls 之后为空白（index.html:50-58） |
| R6 | 人机对局中可随时自由换边 | 「我方执子」`#side` 仅 `startGame` 开局时读取一次（js/app.js:408），对局中修改无效；且入口埋在侧栏设置页签，不可发现 |
| R7 | 「最新决策」栏尺寸恒定，不忽大忽小 | `renderLatest`（js/app.js:1096-1132）槽位随每步数据变化：候选行 1~8 行不定、指标块 0~3 块不定、「其余 N 个候选」行 `candidates>8` 才出现、无决策时整句 `.feed-empty` → 面板高度每步跳动（用户 m00507 现场纠正：病灶是该栏目，不是棋盘） |

## 2. 已确认决策（用户 2026-09-30 拍板）

1. 设置入口 = header 右上角**齿轮按钮 → 居中抽屉浮层**（不使用侧栏跳转）。
2. Rapfi 思考时长**黑白各自可覆盖**，默认继承全局值。
3. 战术版本**完全自由任选两档**对垒（不限定相邻档）。
4. 棋谱文件名服务端**加 slug 后缀**（`server.js` 与 Pages Function 同步改）。
5. 战术版本沿革**全保留**——以 git 历史 × 棋谱数据为权威来源，9 个战术版本 + 1 个无战术基线共 10 档，一版不漏（用户 m00347/m00348 权威梯；含 commit 时间戳与归档棋谱局数双锚定）。
6. 「最新决策」候选榜改**固定槽位渲染**（新纯模块 `js/latest-board.js`）：head 恒 1 行 + 指标恒 3 槽 + 候选恒 8 槽 + 「其余候选」行恒在（空内容 `visibility:hidden` 保高度）+ 无决策走同一骨架；标题行说明文字 nowrap 省略号防折行。附带修正 `main` 网格列：侧栏列改视口定宽（切页签不影响棋盘列宽）+ `scrollbar-gutter: stable`。

## 3. 硬约束（来自 AGENTS.md / status.md，不可违背）

- 零依赖：禁框架、禁构建、禁第三方库；原生 JS + CSS。
- 引擎与 UI 解耦：战术/引擎逻辑不得 import DOM；UI 只通过登记表渲染。
- 每引擎 selfTest；任何改动后 `node test/run-tests.js` 必须全绿。
- 文档随代码更新：`docs/status.md`、`docs/memory/MEMORY.md` 顶部、新增 ADR。
- `BG.codeVersion` 手工维护，特性级变更 bump `0.7.0 → 0.8.0`（js/board.js）。
- Rapfi 单线程思考期间 UI 冻结（ADR-0006）：不改其调度模型，仅在文档/提示中明示时长代价。
- 服务端棋谱文件名须继续满足 `NAME_RE = /^[A-Za-z0-9_.-]+\.json$/`（server.js:41），slug 必须服务端再次消毒，不可信任客户端。

## 4. 架构设计

### 4.1 战术版本登记表（R3/R5 地基）

新建 `js/tactics-versions.js`，挂 `BG.tacticsVersions`：

```js
{
  id: 'v9-vcf-sound',              // UI/meta/文件名统一用此 id（CURRENT）
  name: '防伪胜',
  rank: 9,
  commit: 'a16fdd9',               // git 锚点
  commitAt: '2026-09-30 16:58',    // git show -s --format=%ci 实测
  date: '2026-09-30',
  mech: {                          // 机制闸门（见 4.2）；12 键，缺一即该版本没有此机制
    win: true, block: true, open4: true, threat: true,
    vcfAttack: true, vcfDefense: true,
    parry: true, parry3: true, parry4: true,
    safeSort: true, vcfTry: true, sound: true,
  },
  games: 0,                        // 归档棋谱归属局数（见下「棋谱归属」）
  note: 'vcfWin soundness 修复：双杀短路前过守方反杀闸门 + 棋谱归因 meta',
}
```

10 档映射（版本边界只认 git commit 时间；全部来自 jev-client.js 真实提交史，用户 m00347/m00348 权威梯校准，一版不漏）：

| id | 来源提交（北京时间，git 实测） | 接管层数 | 归档棋谱 |
|---|---|---|---|
| `v0-off`（对照基线） | `678b701` 之前（92e38e6→1da4d8a 区间） | 0 层（纯概率） | 0 局 |
| `v1-facts` | 678b701（09-29 14:21） | 2 层 win>block | 0 局 |
| `v2-open4` | 15996b1（16:08） | 3 层 +open4 | 0 局 |
| `v3-make2` | e086742（16:39） | 5 层 +threat+parry | 0 局 |
| `v4-parry3` | d10fd1f（17:11） | 6 层 +parry3 | 0 局 |
| `v5-safesort` | 87beda6（17:41） | 6 层不变，parry 内部升 safeSort | 21 局 |
| `v6-parry4` | f48d052（09-30 10:42） | 7 层 +parry4 | 0 局 |
| `v7-vcf` | 57a9508（10:43） | 9 层 +vcfAttack+vcfDefense | 4 局 |
| `v8-vcf-try` | 9cf4a88（11:41） | 9 层不变，vcfDefense 逐点试 | 3 局 |
| `v9-vcf-sound`（默认/当前） | a16fdd9（16:58） | 9 层不变，引擎层修伪胜 | 0 局 |

**棋谱归属（勿凭文件名时间戳直读）**：棋谱 `exported` 是 UTC ISO 落库时刻，换算北京时间后对照 git 梯级定窗口；另有更强证据——棋谱 `moves[]` 自带 `tactics` 标签，实证引擎触发过哪些机制（parry3 ⇒ ≥v4，parry4 ⇒ ≥v6，vcfAttack/vcfDefense ⇒ ≥v7）。合计 28 局 = games/ 现存全部棋谱；v4 与 v5 只差 safeSort 内部排序、棋谱标签不可分，21 局按落库时间归 v5 窗口。

- 顺序即强度沿革；`default = 'v9-vcf-sound'`，**默认档行为必须与现状逐位一致**（回归保护）。
- 未知 id → 回落默认档 + `console.warn`，绝不静默改变行为。
- 机制键 12 个（唯一来源=登记表，禁在别处散落字符串）：`win block open4 threat parry parry3 parry4 vcfAttack vcfDefense safeSort vcfTry sound`。其中 `vcfTry`（v8）是唯一有客户端行为差的闸门：VCF 防守候选 = `M.vcfTry ? [链首].concat(line) : [链首]`；`sound`（v9）是引擎侧修复（`gomoku.defenderWinsFull` 已在 a16fdd9 落库），客户端恒真，保留键位只为标明演进线。

### 4.2 decide() 的版本闸门（R3）

`js/jev-client.js` `decide()` 增加 `opts.tacticsVersion`：

- `computeTactics`（:239）与接管链（:548-579）逐层读闸门：`mech.win/block/open4/threat/parry/parry3/parry4/vcfAttack/vcfDefense`（`safeSort` 门控 parry 层内部的 3-ply 安全排序；`vcfTry` 门控 VCF 防守候选集）。
- `v0-off` 时 `attachFacts` 注入空战术（照常发请求、照常 topK 采样，唯一变量是战术层开关——与 random 渠道 :454-461 的「唯一变量是概率分布」设计同构）。
- Rapfi/mock 渠道无视战术版本（Rapfi 是完整搜索引擎，不经战术层，注释 :436-440 保持）。
- `meta` 增 `tacticsVersion`：随 `aiMoveMeta`/`aiGameMeta`（js/board.js）进入每手棋谱与战绩/实验 payload——这是「可归因基线」的数据基础。
- 搭载对象：Jev 渠道（proxy/openrouter/official/random）与 topK 全部可选版本；UI 层不禁止任何组合。

### 4.3 对阵配置泛化（R2）

- `S.sideConfig = { black: { channel, tactics, rapfiThinkMs }, white: { … } }`（js/app.js）。每个字段 `null` = 继承全局/默认。
- `effectiveChannelFor(side)`（:103-109）改读 `S.sideConfig`；`decide` 调用点（:518-527）按方传 `tacticsVersion` 与解析后的 `rapfiThinkMs`（覆盖值 ‖ 全局值）。**现有 `S.expChannels` 语义合并进此结构**，实验 `runExperimentGame`（:773-788）改为写 sideConfig + 交替黑旗标。
- UI（index.html 对局面板）：mode=ai-ai 时展开两块配置行（渠道 / 战术版本 / Rapfi 时长覆盖），模式文案「Jev vs Jev」→「引擎 vs 引擎」；human-ai 时第一块收起、保留人类方提示。实验面板 A/B 复用同一渲染函数 + 「自动交替执黑白」勾选（保留现状默认行为）。
- 人类方（human-ai）沿用 `#side`「我方执子」，不引入新概念。

#### 4.3.1 人机对局中换边重开（R6，用户已定语义）

「点一下重开一局并交换执子」：当前局**保留为独立棋谱记录**，新局以交换后的执子即时开局。

- index.html `.controls`（:50-58）增 `#swapBtn`「换边重开」；human-ai 模式常显，ai-ai/pvp 与实验进行中隐藏。
- 点击处理（js/app.js）：
  1. `EXP.running` 或模式非 human-ai → 忽略（按钮已隐藏，双保险）；
  2. 当前局有历史且未终局（`S.history.length && !S.engine.getStatus(S.st).over`）→ 以合成终局 `{over: true, winner: null, reason: '换边中断'}` 走 `finishGame`：**原棋谱照常记账**（战绩簿、棋谱导出、终局同步，一步不少，且都发生在新局 resetSession 之前——`uploadGameRecord` 同步快照 export，无竞态）；
  3. 已终局或无历史 → 跳过记账；
  4. `S.humanSide` 取反方，回填 `$('side').value`，调 `startGame()` 开新局；新人类方非先手时 AI 先走（复用 :422 逻辑）。
- `saveGameRecord`（:1139-1168）适配：`winner: null` 且 `reason === '换边中断'` 时渲染「未终局」而非「和棋」；战绩簿行不加 draw 样式；校准样本不受影响（无 winner → `firstWin` 为 null → 不计入，js/app.js:1181 `decided` 过滤天然成立）。
- 语义边界：**不中途翻面、不改已落子归属**；换边重开是「保存并重启」不是「续命」；属当局操作不写 localStorage，重开恢复 `#side` 值。

### 4.4 全局设置抽屉（R1）

- index.html header（:15-27）增齿轮按钮 `#settingsBtn`；正文新增居中抽屉 `#settingsDrawer`（`dialog` 语义用 `<div role="dialog" aria-modal="true">` + 原生 CSS 实现，零依赖），内容 = 渠道/Key/Base URL/topK/机机间隔/棋谱同步/后端状态块；Esc 与遮罩点击关闭，焦点圈进抽屉。
- `#rapfiThinkLabel` 去掉 index.html:270 的 `hidden` 初类与 js/app.js:65 的渠道绑定；抽屉内常显，提示文案随主渠道切换解释生效范围（「任一方为 Rapfi 时生效；对局内可逐方覆盖」）。
- 「模式/我方执子/战术选择」属对局设置，留在侧栏对局面板；全局与对局两类设置边界即「跨对局持久 vs 当局生效」。
- 保存机制不变（`saveSettings` :42-53 / STORE_KEY）；新增 `sideConfig` 同 key 存储，向后兼容旧 payload（缺省 = 继承）。

### 4.5 命名（R4）

- **战绩簿**：`saveGameRecord`（:1139-1168）增 `name`，形如 `jev·v9 vs rapfi·3s`（人类方/随机/演示同构生成）；`renderRecords`（:1190-1202）增「对阵」列；旧记录无 name 时按 mode+棋种回退渲染。
- **服务端 slug**：`server.js` `handleGamesPost`（:320-336）读 payload 可选 `slug`（客户端由 name 生成，`[a-z0-9-]` 小写化、截 40 字），文件名改 `gid-[slug-]stamp.json`；Pages Function（functions/）同款修改；无 slug 时保持旧格式。`NAME_RE`/`DAY_RE` 不变，slug 仅由服务端白名单字符集消毒后拼接。
- **实验报告**：`recordExperiment`（:892-908）增 `label`（`Jev(代理)·v9 vs Rapfi·3s` 式联名）、`tacticsA/tacticsB`、`rapfiMsA/rapfiMsB`；`renderExpHistory`/`expSummary`（:801-809）展示联名与版本；`EXP_SEED` 两条历史（:833-858）由格式化函数按同规则补算 label（无 tactics 字段 → 标注「版本未记」），不改动原始棋谱文件。
- **EXPORT 契约**：`buildGameExport`/`aiGameMeta` payload 增 `slug`/`name`/`tactics`/`rapfiThinkMs` 字段；`server.js` 的 `jev-qiguan-game/v1` 校验（:323）只新增可选字段，旧格式仍受理。

### 4.6 棋盘下方版本沿革条（R5）

- index.html controls（:50-58）之后增 `#tacticsStrip`：横向滑动列表，每卡 = 版本 id / 日期 / 一句话要点 / 来源 commit / 「当前」徽标（默认档）。
- `js/app.js` 从 `BG.tacticsVersions` 渲染（解耦：UI 不硬编码版本）；点击档位 = 把该版本设为下一局己方战术（与 4.3 的战术选择联动，是「调用」入口而非只读资料）。
- 棋盘类（go/chess 等非 deepTactics 引擎）显示统一提示「该版本为五子棋战术沿革，其他棋种当前仅 win/block 级生效」。

### 4.7 「最新决策」栏固定槽位（R7）

- 新建 `js/latest-board.js`，挂 `BG.latest`，唯一公开函数 `boardHTML(h)` 返回 `{ note, count, html }`（纯字符串拼装，零 DOM 依赖，可被 node 单测）。
- 恒定结构（契约）：`latest-head` 恒 1 行（无决策时骨架同构）+ `latest-bigs` 恒 3 槽（`优势/局势分/延迟`，缺指标给 `.big.is-empty` 显示 `–`）+ `rank-list` 恒 8 槽（缺候选给 `.rank-row.is-empty` 弱化虚线）+ `rank-rest` 行恒在（`candidates>8` 才有文字，否则 `.rank-rest.is-empty` + `visibility:hidden` 保高度）。
- `js/app.js renderLatest`（:1096-1132）收缩为薄封装：只写 `#latestNote` / `#rankCount` / `#latest.innerHTML`。
- `css/style.css:638-702` 区块补空槽样式与标题行防折行（`.panel-title .note { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0 }`，`h2`/`.rank-count` 不收缩）。
- 不变量含义：**面板高度与数据无关**，只随折叠/展开变化（折叠是用户主动操作）。

## 5. 数据流

```
侧栏对局设置 / 实验面板 / 版本沿革条
   → S.sideConfig + S.settings
   → scheduleAI()（app.js:506-527）按方组装 opts{channel, tacticsVersion, rapfiThinkMs}
   → BG.jev.decide（jev-client.js:425）版本闸门 → meta.tacticsVersion
   → playMove → 决策流/战绩簿(name) / buildGameExport(name+slug+tactics)
   → POST /api/games（server.js:320 / Pages Function）slug 文件名落盘
   → 实验报告 label 联名
```

## 6. 兼容与回退

- 默认档 `v9-vcf-sound` = 现状行为；单测加「默认档与登记表闸门全开等价」断言。
- 旧 localStorage settings/sideConfig 缺字段 → 继承默认；旧战绩/实验记录无 name/label → 渲染层回退。
- 旧棋谱文件（games/2026-09-2x/*.json）不动、不改名；新文件名多一段 slug，列表页按 `gid-` 前缀仍可解析。
- 换边为当局操作：不改写历史棋谱归属；战绩簿的 `winner`/`name` 按终局实际方渲染，不追溯。
- `BG.codeVersion` bump 至 `0.8.0`；棋谱 meta `codeVersion` 自动反映新版。

## 7. 错误处理与边界

- 未知 tacticsVersion：回落默认 + warn（JS 层）；服务端非法 slug：消毒为纯 `[a-z0-9-]`，仍非法则退化为无 slug 旧格式。
- 抽屉焦点圈进/ Esc 关闭；抽屉打开时不影响进行中的对局（设置即存即生效于**下一手**，与现状 decide 每手现读一致）。
- Rapfi 时长每方覆盖仅在对应方渠道=rapfi 时生效；非 rapfi 方显示「不适用」置灰（不隐藏，保持可见性）。
- 战术版本选择对 mock 渠道可见但注明「演示渠道固定弱启发式，版本不生效」。

## 8. 测试策略

1. **登记表单测**（test/run-tests.js）：10 档 id 唯一、mech 12 键齐全、默认档存在、rank 与沿革顺序单调、games 合计 = games/ 现存 28 局（防归属改错）。
2. **行为回归**：合成反例（沿用 .work/jev-analysis/probe-vcf.js 手法）断言 v9-vcf-sound 与现状一致；v8→v9 差异恰好落在 vcfTry 候选集与引擎 soundness 闸门点；v0-off 时接管链零触发。
3. **UI 冒烟**（离线 mock+random）：三种模式 × 双方异渠道/异版本/异时长矩阵跑通终局；**换边重开**（有历史时 → 原局记「未终局」且新局以对方执子开局、AI 先手时自动接管；终局后点 / 空局点均只开新局不产记录）；战绩与实验 label/slug 正确落 localStorage。
4. **服务端契约**：server.js 18 项 HTTP 用例补：slug 文件名生成、非法 slug 消毒、无 slug 兼容；Pages Function 单测同补。
5. 全绿后实跑 ≥4 局版本对垒（v9-vcf-sound vs v5-safesort、v9-vcf-sound vs random·v3）验证报告可读性与归因字段完整。

## 9. 文档与交付

- 新增 `docs/adr/0009-tactics-version-registry.md`、`docs/adr/0010-settings-drawer-side-config.md`，更新 `docs/adr/README.md` 索引。
- `docs/status.md`：已知限制更新（R1/R2 症结移入「已解决」）、版本 v0.8；`docs/memory/MEMORY.md` 顶部追加本轮条目；`docs/jev-api.md`/`docs/architecture.md` 补 decide 新 opts 与 payload 新字段。
- `BG.codeVersion = '0.8.0'`。
- 提交拆分（便于回溯）：① 登记表+gating+测试 ② 抽屉+常显 ③ sideConfig+对阵 UI ④ 命名/slug ⑤ 沿革条 ⑥ 文档+bump。

## 10. 不在本次范围

- 战术层向 go/chess/xiangqi 的深度扩展（保持「deepTactics 引擎才跑 2-ply」现状）。
- Rapfi WASM 多线程化（ADR-0006 冻结问题单独立项）。
- 服务端跨对局统计聚合战术维度（payload 已带字段，留待后续）。
- AGENTS.md 既有硬规则的任何豁免。
