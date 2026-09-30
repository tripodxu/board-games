# 实验室改造设计：战术版本化 · 全局设置抽屉 · 自由对阵 · 鲜明命名

日期：2026-09-30 · 状态：已确认（用户拍板 5 项决策）· 关联：ADR-0009 / ADR-0010（随本文档新建）

## 1. 背景与目标

五子棋实验室（对比实验 / 战绩簿 / 校准实验室）已跑过两轮基线（`EXP_SEED`，[js/app.js](../js/app.js):833-858），下一阶段 P1 目标（.work/handoff.md）是建立 ≥24 局**可归因**基线。当前机制阻碍该目标，也影响日常使用，共 5 项诉求：

| # | 诉求 | 现状症结（锚点） |
|---|---|---|
| R1 | 全局设置收进右上角专属入口 | 设置散在右侧栏第三页签 `pane-settings`（index.html:239-349）；Rapfi 时长被 `ch !== 'rapfi'` 条件藏匿（js/app.js:65），用户「直接调用看不到」 |
| R2 | 黑白方自由选择引擎；ai-ai 不止「Jev vs Jev」 | ai-ai 双方共用同一 `effectiveChannel()`（js/app.js:88-100）；`#side`（index.html:253-255）在 ai-ai 下失效；只有实验面板能分方配渠道（index.html:315-332） |
| R3 | 战术分版本，可搭载 Jev 或随机算法对弈；证明每版进步 | 战术层硬编码无版本（js/jev-client.js:239 `computeTactics` + :488-539 接管链）；版本沿革只存在于 git 提交史 |
| R4 | 实验报告/棋谱命名鲜明（谁打谁、战术版本、Rapfi 时长） | 实验 tag 纯时间戳（js/app.js:769）；棋谱文件名 `gid-stamp.json`（server.js:328）；战绩簿行无对阵信息（js/app.js:1190-1202） |
| R5 | 棋盘下方罗列历代战术版本供参考调用 | 无任何版本沿革展示位；棋盘下方 controls 之后为空白（index.html:50-58） |
| R6 | 人机对局中可随时自由换边 | 「我方执子」`#side` 仅 `startGame` 开局时读取一次（js/app.js:408），对局中修改无效；且入口埋在侧栏设置页签，不可发现 |

## 2. 已确认决策（用户 2026-09-30 拍板）

1. 设置入口 = header 右上角**齿轮按钮 → 居中抽屉浮层**（不使用侧栏跳转）。
2. Rapfi 思考时长**黑白各自可覆盖**，默认继承全局值。
3. 战术版本**完全自由任选两档**对垒（不限定相邻档）。
4. 棋谱文件名服务端**加 slug 后缀**（`server.js` 与 Pages Function 同步改）。
5. 战术版本沿革 **8 档全保留**。

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
  id: 'v7-vcf-sound',            // UI/meta/文件名统一用此 id
  label: 'VCF + soundness 闸门',
  date: '2026-09-30',
  commit: 'a16fdd9',             // git 锚点
  summary: '双杀短路前检查守方反杀，杜绝伪胜链',
  layers: {                      // 接管链闸门（见 4.2）
    win: true, block: true, open4: true, threat: true, parry: true,
    parry3: true, parry4: true, vcf: true, vcfSound: true,
  },
}
```

8 档映射（全部来自 jev-client.js 真实提交史）：

| id | 来源提交 | 层级增量 |
|---|---|---|
| `v0-off` | – | 全 false（纯模型，对照基线） |
| `v1-facts` | 678b701 | 事实注入 + win/block |
| `v2-2ply` | e086742 | + threat/parry（2-ply 造杀/拆杀） |
| `v3-parry3` | d10fd1f | + parry3 预挡层 |
| `v4-safe-parry` | 87beda6 | + 拆杀点 3-ply 安全排序 |
| `v5-parry4` | 15996b1→f48d052 | + criteria/活四级 + parry4 |
| `v6-vcf` | 57a9508, 9cf4a88 | + VCF 攻防链搜索 |
| `v7-vcf-sound`（默认） | a16fdd9 | + vcfWin soundness 闸门 |

- 顺序即强度沿革；`default = 'v7-vcf-sound'`，**默认档行为必须与现状逐位一致**（回归保护）。
- 未知 id → 回落默认档 + `console.warn`，绝不静默改变行为。

### 4.2 decide() 的版本闸门（R3）

`js/jev-client.js` `decide()` 增加 `opts.tacticsVersion`：

- `computeTactics`（:239）与接管链（:488-539）逐层读闸门：`layers.win/block/open4/threat/parry/parry3/parry4/vcf/vcfSound`。
- `v0-off` 时 `attachFacts` 注入空战术（照常发请求、照常 topK 采样，唯一变量是战术层开关——与 random 渠道 :454-461 的「唯一变量是概率分布」设计同构）。
- Rapfi/mock 渠道无视战术版本（Rapfi 是完整搜索引擎，不经战术层，注释 :436-440 保持）。
- `meta` 增 `tacticsVersion`：随 `aiMoveMeta`/`aiGameMeta`（js/board.js）进入每手棋谱与战绩/实验 payload——这是「可归因基线」的数据基础。
- 搭载对象：Jev 渠道（proxy/openrouter/official/random）与 topK 全部可选版本；UI 层不禁止任何组合。

### 4.3 对阵配置泛化（R2）

- `S.sideConfig = { black: { channel, tactics, rapfiThinkMs }, white: { … } }`（js/app.js）。每个字段 `null` = 继承全局/默认。
- `effectiveChannelFor(side)`（:103-109）改读 `S.sideConfig`；`decide` 调用点（:518-527）按方传 `tacticsVersion` 与解析后的 `rapfiThinkMs`（覆盖值 ‖ 全局值）。**现有 `S.expChannels` 语义合并进此结构**，实验 `runExperimentGame`（:773-788）改为写 sideConfig + 交替黑旗标。
- UI（index.html 对局面板）：mode=ai-ai 时展开两块配置行（渠道 / 战术版本 / Rapfi 时长覆盖），模式文案「Jev vs Jev」→「引擎 vs 引擎」；human-ai 时第一块收起、保留人类方提示。实验面板 A/B 复用同一渲染函数 + 「自动交替执黑白」勾选（保留现状默认行为）。
- 人类方（human-ai）沿用 `#side`「我方执子」，不引入新概念。

#### 4.3.1 人机对局中即时换边（R6）

- index.html `.controls`（:50-58）增 `#swapSideBtn`「交换黑白」（title 说明即时生效）；human-ai 模式显示，ai-ai/pvp 隐藏或点击时 toast 提示仅人机可用。
- `js/app.js` 点击处理：`S.humanSide` 取反方 `engine.sides.find(s => s.id !== S.humanSide).id`；同步回填 `$('side').value`；刷新状态行/徽标；若轮到的新 AI 方且无 inflight，`setTimeout(aiStep, aiDelayMs())` 接管。
- 语义边界：**不重开对局、不动棋盘**，已落子棋谱归属不变（每手 meta.side 已记录）；`S.inflight` 中的决策按原方走完，落地后 `playMove` 的 `isAISide(S.st.turn)`（:476）自然把控制权翻给新 AI 方；换边不写入 localStorage（属当局设置，重开恢复 `#side` 选择值）。
- 换边后若原人类方刚走过去一手、此刻轮到对方（AI），AI 应立即响应——避免出现「双方都在等」的死等。

### 4.4 全局设置抽屉（R1）

- index.html header（:15-27）增齿轮按钮 `#settingsBtn`；正文新增居中抽屉 `#settingsDrawer`（`dialog` 语义用 `<div role="dialog" aria-modal="true">` + 原生 CSS 实现，零依赖），内容 = 渠道/Key/Base URL/topK/机机间隔/棋谱同步/后端状态块；Esc 与遮罩点击关闭，焦点圈进抽屉。
- `#rapfiThinkLabel` 去掉 index.html:270 的 `hidden` 初类与 js/app.js:65 的渠道绑定；抽屉内常显，提示文案随主渠道切换解释生效范围（「任一方为 Rapfi 时生效；对局内可逐方覆盖」）。
- 「模式/我方执子/战术选择」属对局设置，留在侧栏对局面板；全局与对局两类设置边界即「跨对局持久 vs 当局生效」。
- 保存机制不变（`saveSettings` :42-53 / STORE_KEY）；新增 `sideConfig` 同 key 存储，向后兼容旧 payload（缺省 = 继承）。

### 4.5 命名（R4）

- **战绩簿**：`saveGameRecord`（:1139-1168）增 `name`，形如 `jev·v7 vs rapfi·3s`（人类方/随机/演示同构生成）；`renderRecords`（:1190-1202）增「对阵」列；旧记录无 name 时按 mode+棋种回退渲染。
- **服务端 slug**：`server.js` `handleGamesPost`（:320-336）读 payload 可选 `slug`（客户端由 name 生成，`[a-z0-9-]` 小写化、截 40 字），文件名改 `gid-[slug-]stamp.json`；Pages Function（functions/）同款修改；无 slug 时保持旧格式。`NAME_RE`/`DAY_RE` 不变，slug 仅由服务端白名单字符集消毒后拼接。
- **实验报告**：`recordExperiment`（:892-908）增 `label`（`Jev(代理)·v7 vs Rapfi·3s` 式联名）、`tacticsA/tacticsB`、`rapfiMsA/rapfiMsB`；`renderExpHistory`/`expSummary`（:801-809）展示联名与版本；`EXP_SEED` 两条历史（:833-858）由格式化函数按同规则补算 label（无 tactics 字段 → 标注「版本未记」），不改动原始棋谱文件。
- **EXPORT 契约**：`buildGameExport`/`aiGameMeta` payload 增 `slug`/`name`/`tactics`/`rapfiThinkMs` 字段；`server.js` 的 `jev-qiguan-game/v1` 校验（:323）只新增可选字段，旧格式仍受理。

### 4.6 棋盘下方版本沿革条（R5）

- index.html controls（:50-58）之后增 `#tacticsStrip`：横向滑动列表，每卡 = 版本 id / 日期 / 一句话要点 / 来源 commit / 「当前」徽标（默认档）。
- `js/app.js` 从 `BG.tacticsVersions` 渲染（解耦：UI 不硬编码版本）；点击档位 = 把该版本设为下一局己方战术（与 4.3 的战术选择联动，是「调用」入口而非只读资料）。
- 棋盘类（go/chess 等非 deepTactics 引擎）显示统一提示「该版本为五子棋战术沿革，其他棋种当前仅 win/block 级生效」。

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

- 默认档 v7 = 现状行为；单测加「默认档与登记表闸门全开等价」断言。
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

1. **登记表单测**（test/run-tests.js）：8 档 id 唯一、layers 字段齐全、默认档存在、沿革顺序与 date 单调。
2. **行为回归**：合成反例（沿用 .work/jev-analysis/probe-vcf.js 手法）断言 v7 与现状一致；v6→v7 差异恰好落在 soundness 闸门点；v0-off 时接管链零触发。
3. **UI 冒烟**（离线 mock+random）：三种模式 × 双方异渠道/异版本/异时长矩阵跑通终局；**人机模式中局换边**（空窗期换 / AI 思考中换 / 连换两次）控制权正确翻转、不卡死；战绩与实验 label/slug 正确落 localStorage。
4. **服务端契约**：server.js 18 项 HTTP 用例补：slug 文件名生成、非法 slug 消毒、无 slug 兼容；Pages Function 单测同补。
5. 全绿后实跑 ≥4 局版本对垒（v7 vs v6、v7 vs random·v3）验证报告可读性与归因字段完整。

## 9. 文档与交付

- 新增 `docs/adr/0009-tactics-versioning.md`、`docs/adr/0010-settings-drawer-side-config.md`，更新 `docs/adr/README.md` 索引。
- `docs/status.md`：已知限制更新（R1/R2 症结移入「已解决」）、版本 v0.8；`docs/memory/MEMORY.md` 顶部追加本轮条目；`docs/jev-api.md`/`docs/architecture.md` 补 decide 新 opts 与 payload 新字段。
- `BG.codeVersion = '0.8.0'`。
- 提交拆分（便于回溯）：① 登记表+gating+测试 ② 抽屉+常显 ③ sideConfig+对阵 UI ④ 命名/slug ⑤ 沿革条 ⑥ 文档+bump。

## 10. 不在本次范围

- 战术层向 go/chess/xiangqi 的深度扩展（保持「deepTactics 引擎才跑 2-ply」现状）。
- Rapfi WASM 多线程化（ADR-0006 冻结问题单独立项）。
- 服务端跨对局统计聚合战术维度（payload 已带字段，留待后续）。
- AGENTS.md 既有硬规则的任何豁免。
