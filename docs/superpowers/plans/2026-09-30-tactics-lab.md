# 战术版本登记 + 联名对比实验室 Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (if NOT already implemented in this session) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 jev-client 已在线跑通的 9 级战术阶梯固化为可复现、可归因、可对比的实验设施：战术版本登记表（git 历史 × 棋谱数据双锚定，一版不漏）+ 版本闸门接管链 + 双方自由配置（渠道/战术/时长）+ 联名棋谱归档 + 换边重开 + UI 尺寸稳定化（「最新决策」栏固定槽位 + 侧栏宽度稳定）+ 侧栏改「对局/实验/数据」三页签（全局设置进右上角抽屉）。

**Architecture:** 新增三个零依赖纯模块——`js/tactics-versions.js`（9 档战术版本 + 1 无战术基线登记表：机制键 + 引入提交/时间 + 归档棋谱数 + 实战依据）、`js/duel.js`（联名/slug 纯函数）与 `js/latest-board.js`（「最新决策」候选榜固定槽位视图模型：结构恒定，面板不随每步数据跳高）。`js/jev-client.js` 的接管链每级加机制闸门（`ver.mech.xxx`），旧版本没有的机制整条跳过；`decide()` 按 `opts.tacticsVersion` 解析档位并写入 `meta.tacticsVersion`。`js/app.js` 用 `S.settings.sideConfig`（黑白各自覆盖 渠道/战术/时长，空=继承全局）替代 `S.expChannels`，实验与人机共用同一套配置。归档链路 `buildGameExport → server.js POST /api/games → functions/api/games.js` 增加 `slug` 字段（`jev-v9-vs-rapfi-3s`），两端文件名用 slug，让战绩簿/实验名自描述。

**Tech Stack:** 原生 ES2019+ JavaScript（无框架/无构建/零第三方依赖）、Node 18+（`node test/run-tests.js`）、Express 风格自建 `server.js`、Cloudflare Pages Functions。测试：`test/run-tests.js` + `test/server-tests.js` + `test/rapfi-tests.js`。

**Spec:** `docs/superpowers/specs/2026-09-30-lab-redesign-design.md`（已提交 c05779f，含 R1–R6 全部决策）。

---

## File Structure

| 文件 | 责任 | 本计划动作 |
|---|---|---|
| `js/tactics-versions.js` | 新生：战术版本登记表 + 机制闸门 + selfTest | 新建（P1） |
| `js/duel.js` | 新生：联名/战绩簿名/实验标签/slug + selfTest | 新建（P1） |
| `js/latest-board.js` | 新生：「最新决策」候选榜固定槽位视图模型 + selfTest | 新建（P0） |
| `js/jev-client.js` | Jev 战术管线 + 接管链 | 版本闸门 + `meta.tacticsVersion`（P2） |
| `js/app.js` | UI 状态机 | sideConfig / 换边重开 / 实验面板 / 战绩簿列 / drawer / 沿革条（P3/P4/P5） |
| `js/board.js` | codeVersion + meta 汇总 | `aiMoveMeta` 加 `tv` 字段（P2）；`BG.codeVersion` 0.8.0（P6） |
| `index.html` | 页面结构 | 三页签改名 + 抽屉 + swapBtn + 沿革条 + exp/config 控件（P3/P4/P5） |
| `css/style.css` | 样式 | 尺寸稳定化（固定槽位 + 侧栏宽度）+ 抽屉 + 双方覆盖 + 沿革条（P0/P3/P4/P5） |
| `test/run-tests.js` | 测试 | 登记表/联名/闸门/DOM 契约测试（P1/P2/P3/P4） |
| `test/server-tests.js` | 测试 | slug 文件名 + 回退 gid（P4） |
| `server.js` / `functions/api/games.js` | 归档 | slug 文件名（P4） |
| `docs/` | 文档 | status/MEMORY/ADR-0009（P6） |

---

## Coding Standards（本计划硬约束）

- **零第三方依赖**：只用原生 JS + Node 内置。不得引入框架/构建/包。
- **每个新模块必须 `selfTest()`**，并在 `test/run-tests.js` 注册调用（对齐 `BG.calibration.selfTest()` 惯例）。
- **纯函数模块禁止碰 DOM**（`tactics-versions.js` / `duel.js` / `latest-board.js` 用 `(typeof window !== 'undefined' && window.BG) || globalThis.BG` 挂载，只返回字符串/数据）。
- **禁 `as any`/魔法字符串散落**：机制键只用登记表定义的 12 个：`win block open4 threat parry parry3 parry4 vcfAttack vcfDefense safeSort vcfTry sound`。
- **测试先行**：每个任务先写失败测试并实跑确认失败信息，再实现。
- **每任务一个 commit**，信息用中文 Conventional Commits。
- **`node test/run-tests.js` 全绿是唯一出口判据**；文档随代码更新（AGENTS.md 最高权威）。

---

## Phase 0：UI 尺寸稳定化（独立小修，先落地）

### Task 0.1：消除「最新决策」栏忽大忽小——固定槽位渲染（纯视图模型 + 单测）

**Files:**
- Create: `js/latest-board.js`（固定槽位 HTML 生成器，纯函数零依赖）
- Modify: `js/app.js:1096-1132`（`renderLatest` 改为调用 `BG.latest.boardHTML`）
- Modify: `css/style.css:638-702`（空槽/空指标样式 + 标题行说明防折行）
- Modify: `test/run-tests.js`（新增 `latestBoardTests()` + 在 `index.html` script 顺序处登记）

**根因（用户 m00507 现场纠正，勿再误诊为棋盘）**：病灶在 `js/app.js:1096 renderLatest`——它的输出结构随每步数据变化：候选行 `m.top` 1~8 行不定、指标块 `.latest-bigs` 0~3 块不定、「其余 N 个候选合计」行 `candidates>8` 才出现、无决策时整段替换成一句 `.feed-empty`。于是每走一步面板高度就跳一截（棋步间候选数/指标数不同），看起来就是「最新决策这个栏目忽大忽小」。

**修法（契约）：渲染结构恒定**——标题行恒 1 行 + 指标行恒 3 槽（缺指标显示 `–`）+ 候选行恒 `LATEST_SLOTS`(8) 槽（缺候选显示空槽弱化）+ 「其余候选」行恒在（无内容时 `visibility:hidden` 保高度）+ 无决策时也走同一条骨架（首绘即终高，不跳变）。

- [x] **Step 1: 写失败测试（最新决策固定槽位契约）**

 在 `test/run-tests.js` 新增函数（放在 `jevClientTests()` 之后；模块加载见 Step 3）：

 ```js
 /* 单元：最新决策候选榜固定槽位契约（R UI）
  * 病灶：renderLatest 槽位随每步数据变化（候选 1~8 行、指标 0~3 块、
  * 「其余候选」行时有时无、无决策时整句空话）→ 面板高度每步跳动。
  * 契约：结构恒定——head 恒 1 行 + 指标恒 3 槽 + 候选恒 8 槽 + rest 行恒在。 */
 function latestBoardTests() {
   const e = { move: { notation: 'H8' }, ply: 12, meta: { byAI: true, sideName: '黑方', mock: false,
     model: 'gpt-4o-mini', confidence: 0.62, noul: 0.71, score: 3.4, latencyMs: 820,
     candidates: 20, restProb: 0.18,
     top: [{ notation: 'H8', p: 0.31 }, { notation: 'I9', p: 0.22 }, { notation: 'G7', p: 0.12 }] } };
   /* 无决策（骨架） */
   const html0 = BG.latest.boardHTML(null).html;
   /* 候选 3 + 指标齐 */
   const html3 = BG.latest.boardHTML(e).html;
   /* 候选 8（满槽，无 rest） */
   const e8 = { move: e.move, ply: e.ply, meta: Object.assign({}, e.meta, {
     candidates: 8, restProb: 0,
     top: ['H8','H9','I8','I9','G7','G8','J7','J8'].map((s, i) => ({ notation: s, p: (0.2 - i * 0.02) })) }) };
   const html8 = BG.latest.boardHTML(e8).html;

   const count = (h, re) => (h.match(re) || []).length;
   [html0, html3, html8].forEach((h, i) => {
     BG.util.assert(count(h, /<div class="latest-head"/g) === 1, 'head 行应恒 1 行，样本' + i);
     BG.util.assert(count(h, /<div class="big/g) === 3, '指标应恒 3 槽，样本' + i);
     BG.util.assert(count(h, /<div class="rank-row/g) === 8, '候选应恒 8 槽，样本' + i);
     BG.util.assert(count(h, /<div class="rank-rest/g) === 1, '「其余候选」行应恒在，样本' + i);
   });

   /* 空数据 = 全空槽骨架 */
   BG.util.assert(count(html0, /rank-row is-empty/g) === 8, '无决策时应为 8 个空候选槽');
   BG.util.assert(count(html0, /big is-empty/g) === 3, '无决策时应为 3 个空指标槽');
   BG.util.assert(/rank-rest is-empty/.test(html0), '无 rest 内容时 rest 行应为空占位（保留高度）');
   BG.util.assert(/尚无决策/.test(BG.latest.boardHTML(null).note), '无决策时标题注记应为「尚无决策」');

   /* 半槽：3 实 5 空，落选槽不塌陷 */
   BG.util.assert(count(html3, /rank-row is-empty/g) === 5, '候选 3 个时应补 5 个空槽');
   BG.util.assert(count(html3, /big is-empty/g) === 0, '指标齐全时不应有空指标槽');
   BG.util.assert(/其余 12 个候选合计 18\.0%/.test(html3), 'candidates=20 应给出其余 12 个合计 18.0%');
   BG.util.assert(/<div class="rank-row is-chosen">/.test(html3), '选中候选行应标 is-chosen');

   /* 满槽：8 实 0 空，rest 行为空占位 */
   BG.util.assert(count(html8, /rank-row is-empty/g) === 0, '候选 8 个时不应有空槽');
   BG.util.assert(/rank-rest is-empty/.test(html8), 'candidates=8 时 rest 行应为空占位');

   /* 自检入口与 app.js 解耦：模块自带 selfTest */
   BG.latest.selfTest();
 }
 ```

 在 `main()` 里注册（放在 `pagesApiTests()` 之前）：

 ```js
   latestBoardTests();
   results.push('✓ 最新决策固定槽位契约（结构恒定，面板不跳高）');
 ```

- [x] **Step 2: 实跑确认失败**

 Run: `node test/run-tests.js`
 Expected: FAIL，报 `BG.latest is not defined`（js/latest-board.js 尚未创建）。

- [x] **Step 3: 实现（先补模块加载，再写模块与接线）**

 3a. `test/run-tests.js:13-25` 的模块加载数组（在 `'js/board.js',` 之后插入一行；Phase 1 再往同一数组插 `'js/tactics-versions.js'` 与 `'js/duel.js'`）：

 ```js
   'js/board.js',
   'js/latest-board.js',
 ```

 3b. Create `js/latest-board.js`：

 ```js
 /* 最新决策候选榜：固定槽位渲染（视图模型，纯函数零依赖）
  * 病灶：槽位随每步数据变化（候选 1~8 行、指标 0~3 块、rest 行时有时无、
  * 无决策时整句空话）→ 面板高度每步跳动（「最新决策忽大忽小」）。
  * 契约：结构恒定——head 恒 1 行 + 指标恒 3 槽 + 候选恒 LATEST_SLOTS 槽
  *      + rest 行恒在（空内容 visibility:hidden 保高度）+ 无决策走同一骨架。
  * 惰性求值友好：只做字符串拼装，不碰 DOM/localStorage。
  */
 (function () {
   const BG = (typeof window !== 'undefined' && window.BG) || globalThis.BG;
   if (!BG) throw new Error('latest-board.js 必须在 board.js 之后加载');

   const SLOTS = 8; /* 候选榜固定槽位数（= 原实现最多展示的行数） */

   function pct(x, digits) { return (x * 100).toFixed(digits || 1) + '%'; }

   /* h = 历史项 { move, ply, meta }；null = 尚无决策 */
   function boardHTML(h) {
     const m = (h && h.meta) || {};
     const empty = !h;

     /* 标题行：手数 · 方 · 模型（恒 1 行，长模型名由 CSS 省略号截断） */
     const note = empty ? '尚无决策'
       : '第' + h.ply + '手 · ' + (m.sideName || '') + (m.mock ? ' · 演示' : ' · Jev' + (m.model ? ' ' + m.model : ''));

     /* 指标行：恒 3 槽，缺指标给空槽（–） */
     const big = function (k, v) {
       return v === undefined || v === null || v === ''
         ? '<div class="big is-empty"><span class="k">' + k + '</span><b class="mono">–</b></div>'
         : '<div class="big"><span class="k">' + k + '</span><b class="mono">' + v + '</b></div>';
     };
     const bigs = '<div class="latest-bigs">' +
       big((m.sideName || '') + '优势', typeof m.noul === 'number' ? pct(m.noul, 0) : '') +
       big('局势分', typeof m.score === 'number' ? m.score.toFixed(1) : '') +
       big('延迟', m.latencyMs ? m.latencyMs + 'ms' : '') +
       '</div>';

     /* 候选行：恒 SLOTS 槽，缺候选给空槽（弱化虚线） */
     const top = Array.isArray(m.top) ? m.top : [];
     let rows = '';
     for (let i = 0; i < SLOTS; i++) {
       const t = top[i];
       if (!t) {
         rows += '<div class="rank-row is-empty"><span class="no mono">' + (i + 1) + '</span>' +
           '<span class="k mono">–</span><span class="bar"><i></i></span>' +
           '<span class="p mono">–</span></div>';
         continue;
       }
       rows += '<div class="rank-row' + (t.notation === h.move.notation ? ' is-chosen' : '') + '">' +
         '<span class="no mono">' + (i + 1) + '</span>' +
         '<span class="k mono">' + t.notation + '</span>' +
         '<span class="bar"><i style="transform:scaleX(' + (Math.max(2, Math.round((t.p || 0) * 100)) / 100).toFixed(3) + ')"></i></span>' +
         '<span class="p mono">' + pct(t.p || 0) + '</span></div>';
     }

     /* rest 行：恒在；无内容时隐藏文字但保留高度（visibility，不塌陷） */
     const hasRest = !empty && m.candidates > SLOTS;
     const rest = hasRest
       ? '<div class="rank-rest">其余 ' + (m.candidates - SLOTS) + ' 个候选合计 ' + pct(m.restProb || 0) + '</div>'
       : '<div class="rank-rest is-empty">&nbsp;</div>';

     const head = empty
       ? '<div class="latest-head"><span class="mv mono">–</span>' +
         '<span class="conf"><i></i></span><span class="conf-num mono">–</span></div>'
       : '<div class="latest-head"><span class="mv mono">' + h.move.notation + '</span>' +
         '<span class="conf"><i style="transform:scaleX(' +
         (typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)).toFixed(3) : 0) + ')"></i></span>' +
         '<span class="conf-num mono">' + (typeof m.confidence === 'number' ? pct(m.confidence, 0) : '–') + '</span></div>';

     /* 计数徽标：候选数（无数据时给空串，徽标本身不占高度） */
     const count = empty ? '' : (m.candidates ? m.candidates + ' 个候选' : '');
     return { note: note, count: count, html: head + bigs + '<div class="rank-list">' + rows + rest + '</div>' };
   }

   const api = {
     SLOTS: SLOTS,
     boardHTML: function (h) { return boardHTML(h); },
     selfTest: function () {
       const r = boardHTML(null);
       if ((r.html.match(/rank-row/g) || []).length !== SLOTS) throw new Error('latest-board: 空骨架候选槽 != ' + SLOTS);
       if ((r.html.match(/class="big"/g) || []).length !== 3) throw new Error('latest-board: 空骨架指标槽 != 3');
     },
   };
   BG.latest = api;
 })();
 ```

 3c. `js/app.js:1096-1132` 的 `renderLatest` 改为薄封装（保留 note/count 的 DOM 写入）：

 ```js
   function renderLatest(h) {
     const box = $('latest');
     const v = BG.latest.boardHTML(h);
     $('latestNote').textContent = v.note;
     $('rankCount').textContent = v.count;
     box.innerHTML = v.html;
   }
 ```

 3d. `index.html` script 区：在 `js/app.js`（:370）之前插入一行：

 ```html
   <script src="js/latest-board.js"></script>
 ```

 3e. `css/style.css:638-702` 区块末尾追加：

 ```css
 /* ---------- 固定槽位（面板高度恒定，不随每步候选数/指标数跳动） ---------- */
 .latest-bigs .big.is-empty { border-style: dashed; }
 .latest-bigs .big.is-empty b { color: var(--ink-mute); }
 .rank-row.is-empty .no,
 .rank-row.is-empty .k,
 .rank-row.is-empty .p { color: var(--line-strong); }
 .rank-row.is-empty .bar { opacity: .35; }
 .rank-rest.is-empty { visibility: hidden; }
 /* 标题行说明文字不折行：长模型名不得把标题撑成两行（保持 head 恒 1 行） */
 .panel-title .note { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
 .panel-title h2, .panel-title .rank-count { flex: 0 0 auto; }
 ```

- [x] **Step 4: 实跑确认通过 + 人工核查**

 Run: `node test/run-tests.js` → 全绿。
 人工核查（Chrome DevTools，1280×800）：
 1. 开一局（渠道 mock 或 proxy），连走 ≥6 步，每次 AI 落子后用 DevTools 记录 `#body-latest .panel` 的 `getBoundingClientRect().height`——**每步必须完全相等**（此前会随候选数/指标数差 0~5 行）。
 2. 开局前（尚无决策）与第一步后的面板高度也必须相等（骨架首绘即终高）。
 3. 切到候选数很多的局面（中盘 candidates>8）与残局（candidates 少）对比——高度仍相等，仅内容不同；「其余候选」行只在 >8 时有字。
 4. 把窗口收到 900px 宽：标题行仍单行，说明文字以省略号收尾，不被挤成两行。

- [x] **Step 5: Commit**

 ```bash
 git add js/latest-board.js js/app.js css/style.css test/run-tests.js index.html
 git commit -m "fix(ui): 最新决策候选榜改固定槽位渲染——结构恒定，面板不再随每步数据忽大忽小"
 ```

---

### Task 0.2：宽度稳定化（附带修正）——侧栏列改视口定宽 + scrollbar-gutter

**Files:**
- Modify: `css/style.css:69`（html 规则，加 `scrollbar-gutter: stable`）
- Modify: `css/style.css:176-178`（main 网格轨道）
- Modify: `test/run-tests.js`（新增布局契约静态断言）

**定位（附带修正，非用户主诉）**：用户主诉是 Task 0.1 的面板高度跳动；但同一类病灶在横轴也存在——`main { grid-template-columns: minmax(430px, auto) minmax(380px, 490px) }` 中第一列 `auto`=剩余空间，侧栏第二列是内容相关的 `minmax(380px,490px)`，对局/实验/数据三页签 max-content 宽度不同 → 切页签侧栏宽度变 → 棋盘列宽变 → `#board{max-width:100%}`（style.css:250）重新缩放。修法：侧栏列改为只随视口变化（切页签不再影响），并为根元素预留滚动条槽。两步合起来才是完整的「尺寸稳定化」。

- [x] **Step 1: 写失败测试（布局契约）**

在 `test/run-tests.js` 的 `layoutContractTests()` 新函数中：

```js
/* 单元：UI 布局稳定化契约（R UI）
 * 病灶：main 第一列 auto=剩余空间，侧栏 minmax(380px,490px) 随页签内容宽度变化
 * → 切页签棋盘被 #board{max-width:100%} 重新缩放（忽大忽小）。
 * 契约：侧栏列只随视口变化 + 根元素预留滚动条槽。 */
function layoutContractTests() {
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  const main = css.match(/main\s*\{[^}]*\}/);
  BG.util.assert(main, '应能抽到 main 规则块');
  BG.util.assert(
    /grid-template-columns:\s*minmax\(430px,\s*1fr\)\s+clamp\(380px,\s*31vw,\s*430px\)/.test(main[0]),
    'main 应为「内容无关棋盘列 + 视口相关定宽侧栏」，实际：' + main[0].replace(/\s+/g, ' ')
  );
  BG.util.assert(/scrollbar-gutter:\s*stable/.test(css),
    'html 应预留滚动条槽（滚动条出现/消失不得引起棋盘宽度跳变）');
}
```

在 `main()` 里注册（放在 `pagesApiTests()` 之前）：

```js
  layoutContractTests();
  results.push('✓ 布局稳定化契约（侧栏定宽 + scrollbar-gutter）');
```

- [x] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL，报 `main 应为「内容无关棋盘列 + 视口相关定宽侧栏」`（当前 178 行是 `minmax(430px, auto) minmax(380px, 490px)`）。

- [x] **Step 3: 实现**

`css/style.css:69`（html 规则内新增一行）：

```css
  scrollbar-gutter: stable;
```

`css/style.css:178`：

```css
  grid-template-columns: minmax(430px, 1fr) clamp(380px, 31vw, 430px);
```

- [x] **Step 4: 实跑确认通过 + 人工核查**

Run: `node test/run-tests.js` → 全绿。
人工核查（Playwright/Chrome DevTools，1280×800 与 1024×700 各做一次）：
1. 反复点击侧栏页签 对局↔数据↔实验，记录器格线像素宽（`#board` 的 `getBoundingClientRect().width`）——三次页签下必须完全相等。
2. 让页面出现/消失纵向滚动条（在 console 里 `document.body.style.height='3000px'` 切换）——棋盘宽不得跳变。
3. 窗口从 1280 拖到 1120——棋盘不得小于 430px 列（小屏走 1080px 断点堆叠，允许变小但不允许抖动）。

- [x] **Step 5: Commit**

```bash
git add css/style.css test/run-tests.js
git commit -m "style(ui): 宽度稳定化——侧栏列改视口定宽 + scrollbar-gutter，切页签棋盘宽度不再变"
```

---

## Phase 1：战术版本登记表 + 对阵联名（纯模块，零 DOM）

### Task 1.1：`js/tactics-versions.js`——战术版本登记表（git 历史 × 棋谱数据双锚定）

**Files:**
- Create: `js/tactics-versions.js`
- Modify: `test/run-tests.js`（注册 + 单测）

**登记表权威来源（用户 m00347/m00348 拍板 + git show -s 实测时间 + 棋谱数据实证，全部对齐）：**

版本边界只认 **git commit 时间**（本地提交，`git log %ci` 为北京时间）。棋谱归属双证据：① `games/<date>/<gid>-<stamp>.json` 的 `exported` 字段（UTC ISO）= 落库时刻，换算北京时间后看落入哪一版窗口；② **棋谱 `moves[]` 自带 `tactics` 标签**——引擎当时实际触发了哪些接管层可逐个实证（parry3 ⇒ ≥v4，parry4 ⇒ ≥v6，vcfAttack/vcfDefense ⇒ ≥v7）。9 个战术版本一个都不能少，另加 1 行数据驱动的基线（`v0-off`：战术层上线前，尚无归档棋谱）。

| id | 接管层数 | commit（北京时间，git 实测） | 归档棋谱（games 字段） |
|---|---|---|---|
| `v0-off` 基线 | 0 层（纯概率） | `678b701` 之前（92e38e6→1da4d8a 区间） | 0 局（战术层上线前的对局未归档） |
| `v1-facts` | 2 层 win>block | `678b701` 2026-09-29 14:21 | 0 局 |
| `v2-open4` | 3 层 +open4 | `15996b1` 09-29 16:08 | 0 局 |
| `v3-make2` | 5 层 +threat+parry | `e086742` 09-29 16:39 | 0 局 |
| `v4-parry3` | 6 层 +parry3 | `d10fd1f` 09-29 17:11 | 0 局（标签与 v5 不可分，21 局按时间归 v5 窗口） |
| `v5-safesort` | 6 层不变，parry 内部升 safeSort | `87beda6` 09-29 17:41 | **21 局**（9/29 17:51–19:28 落库；parry3 标签实证 ≥v4） |
| `v6-parry4` | 7 层 +parry4 | `f48d052` 09-30 10:42 | 0 局 |
| `v7-vcf` | 9 层 +vcfAttack+vcfDefense（插在 threat 与 parry 之间） | `57a9508` 09-30 10:43 | **4 局**（exp-20260930025135，proxy vs rapfi，10:53–10:57；vcf 标签实证） |
| `v8-vcf-try` | 9 层不变，vcfDefense 链首占不住逐点试 | `9cf4a88` 09-30 11:41 | **3 局**（exp-20260930084500 线上旧引擎，16:46–16:54，均无 meta） |
| `v9-vcf-sound` **当前** | 9 层不变，引擎层修伪胜 + 归因 meta | `a16fdd9` 09-30 16:58 | 0 局（刚修完，待新实验设施补测） |

合计 28 局 = games/ 现有全部棋谱。v1–v4/v6/v9 无归档对局——这正是新版实验设施要补的空白（spec R6：先建 ≥24 局可归因基线）。

机制键 12 个：`win block open4 threat parry parry3 parry4 vcfAttack vcfDefense safeSort vcfTry sound`。
优先级顺序（用户 m00302）= `win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4`，与 `js/jev-client.js:548-579` 接管链一致；v7 把 VCF 两级插在 threat 与 parry 之间，层数 5→9。

- [x] **Step 1: 写失败测试**

```js
/* 单元：战术版本登记表（git 历史 × 棋谱数据双锚定：9 个战术版本 + 1 数据驱动基线） */
function tacticsRegistryTests() {
  const R = globalThis.BG.tacticsVersions;
  BG.util.assert(R, 'BG.tacticsVersions 应存在（需先 eval js/tactics-versions.js）');
  BG.util.assert(R.CURRENT === 'v9-vcf-sound', '当前档应为 v9-vcf-sound（a16fdd9），实际 ' + R.CURRENT);
  const ANCHORED = ['v1-facts', 'v2-open4', 'v3-make2', 'v4-parry3', 'v5-safesort',
    'v6-parry4', 'v7-vcf', 'v8-vcf-try', 'v9-vcf-sound'];
  for (const id of ANCHORED)
    BG.util.assert(R.VERSIONS.some((v) => v.id === id), '登记表漏版本 ' + id + '（git 历史每一版都必须有）');
  BG.util.assert(R.VERSIONS.length === 10, '应为 9 战术版本 + 1 基线，实际 ' + R.VERSIONS.length);
  BG.util.assert(R.VERSIONS[0].id === 'v0-off', 'rank 0 应为无战术基线（战术层上线前）');
  /* rank 从 0 连续 */
  R.VERSIONS.forEach((v, i) => BG.util.assert(v.rank === i, v.id + ' rank 应为 ' + i));
  /* 机制集合沿梯级单调不减（老版本的机制不能被新版本丢掉） */
  const MECHS = R.MECHS; // 12 个机制键，见 js/tactics-versions.js
  for (let i = 1; i < R.VERSIONS.length; i++) {
    const prev = R.VERSIONS[i - 1].mech, cur = R.VERSIONS[i].mech;
    for (const k of MECHS)
      if (prev[k]) BG.util.assert(cur[k], R.VERSIONS[i].id + ' 丢了上级机制 ' + k);
  }
  /* 层数对照用户 m00348 权威表：2/3/5/6/6/7/9/9/9（基线 0） */
  const LAYERS = { 'v0-off': 0, 'v1-facts': 2, 'v2-open4': 3, 'v3-make2': 5, 'v4-parry3': 6,
    'v5-safesort': 6, 'v6-parry4': 7, 'v7-vcf': 9, 'v8-vcf-try': 9, 'v9-vcf-sound': 9 };
  const TIER = ['win', 'block', 'open4', 'threat', 'vcfAttack', 'vcfDefense', 'parry', 'parry3', 'parry4'];
  for (const v of R.VERSIONS)
    BG.util.assert(TIER.filter((k) => v.mech[k]).length === LAYERS[v.id],
      v.id + ' 接管层数应为 ' + LAYERS[v.id] + '，实际 ' + TIER.filter((k) => v.mech[k]).length);
  /* 棋谱归属（棋谱 exported 落库时刻换算北京时间 + moves[].tactics 标签实证；防改错） */
  BG.util.assert(R.resolve('v0-off').games === 0 && R.resolve('v1-facts').games === 0, 'v0/v1 应无归档棋谱');
  BG.util.assert(R.resolve('v5-safesort').games === 21, 'v5 窗口应归档 21 局（9/29 17:51–19:28，parry3 标签实证）');
  BG.util.assert(R.resolve('v7-vcf').games === 4, 'v7 应归档 4 局（exp-20260930025135，vcf 标签实证）');
  BG.util.assert(R.resolve('v8-vcf-try').games === 3, 'v8 应归档 3 局（线上旧引擎）');
  BG.util.assert(R.resolve('v9-vcf-sound').games === 0, 'v9 刚修完应无归档棋谱');
  BG.util.assert(R.VERSIONS.reduce((a, v) => a + v.games, 0) === 28, 'games 字段合计应等于 games/ 现有 28 局');
  /* 解析：空→当前档；未知 id→当前档（写错档号静默回退，不抛错） */
  BG.util.assert(R.resolve(null).id === R.CURRENT && R.resolve('').id === R.CURRENT, '空 id 应回退当前档');
  BG.util.assert(R.resolve('v10-nope').id === R.CURRENT, '未知 id 应回退当前档，实际 ' + R.resolve('v10-nope').id);
  BG.util.assert(R.resolve('v3-make2').id === 'v3-make2', '已知 id 应原样返回');
  /* 闸门 */
  BG.util.assert(R.allows(R.resolve('v1-facts'), 'win') === true, 'v1 应有 win');
  BG.util.assert(R.allows(R.resolve('v1-facts'), 'open4') === false, 'v1 不应有 open4');
  BG.util.assert(R.allows(R.resolve('v0-off'), 'win') === false, 'v0 无任何机制');
  BG.util.assert(R.allows(R.resolve('v7-vcf'), 'vcfDefense') === true, 'v7 应有 vcfDefense');
  BG.util.assert(R.allows(R.resolve('v7-vcf'), 'vcfTry') === false && R.allows(R.resolve('v8-vcf-try'), 'vcfTry') === true,
    'vcfTry（逐点试干预）应是 v8 才有');
  BG.util.assert(R.allows(R.resolve('v8-vcf-try'), 'sound') === false && R.allows(R.resolve('v9-vcf-sound'), 'sound') === true,
    'sound（引擎伪胜闸门）应是 v9 才有');
  const V0 = R.resolve('v0-off');
  BG.util.assert(!MECHS.some((k) => V0.mech[k]), 'v0-off 必须全 false（纯概率基线）');
  /* selfTest 自带登记表自检（页面内「战术沿革条」渲染失败时会在控制台报） */
  R.selfTest();
}
```

在 `test/run-tests.js:13-25` 的模块加载数组（Phase 0 已插入 `'js/latest-board.js'`）再补两行：

```js
  'js/latest-board.js',
  'js/tactics-versions.js',
  'js/duel.js',
```

在 `main()` 测试段注册：

```js
  tacticsRegistryTests();
  results.push('✓ 战术版本登记表（9 档机制阶梯 + 基线）');
```

- [x] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL，`BG.tacticsVersions 应存在`。

- [x] **Step 3: 实现 `js/tactics-versions.js`**

```js
/* tactics-versions.js — 战术层版本登记表（复现与对比实验的唯一事实来源）
 *
 * 为什么存在：战术层是 9 次提交逐层累加上线的，没有登记表就无法回答
 * 「这个版本为什么强/弱」，实验也无法按版本归因。机制键与 jev-client 接管链一一对应
 * （优先级从高到低，用户 m00302）：
 *   win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4
 * 附加键：safeSort = 拆杀点并存时 3-ply 试走挑最安全（v5, 87beda6）；
 *         vcfTry   = vcfDefense 链首占不住时逐点试干预（v8, 9cf4a88）；
 *         sound    = vcfWin 伪胜闸门（引擎侧 gomoku.defenderWinsFull，v9, a16fdd9）。
 *
 * 权威来源：git 历史（版本边界只认 commit 时间，git log %ci 为北京时间）× 棋谱数据
 * （棋谱 exported 落库时刻换算北京时间定窗口，moves[].tactics 标签实证机制下限：
 *  parry3 ⇒ ≥v4，parry4 ⇒ ≥v6，vcfAttack/vcfDefense ⇒ ≥v7）。
 * 版本一版都不能少；v0-off 是数据驱动的基线（战术层上线前，暂无归档棋谱）。
 *
 * 纯数据 + 纯函数，无 DOM 依赖；eval 进 window(BG) 或 Node 全局 BG（test/run-tests.js）。
 */
(function () {
  const BG = (typeof window !== 'undefined' && window.BG) || globalThis.BG;
  if (!BG || !BG.util) throw new Error('tactics-versions.js 必须在 board.js 之后加载');

  /* commitAt = git log %ci 实测（北京时间）；games = 归档棋谱局数（合计应等于 games/ 全部 28 局）。 */
  const VERSIONS = [
    { id: 'v0-off', name: '无战术基线', rank: 0, commit: '678b701 之前', commitAt: '2026-09-29 14:21 前',
      date: '2026-09-29', mech: {}, games: 0,
      note: '基线：战术层上线前纯概率走子（92e38e6→1da4d8a 区间）。战术层上线前的对局未归档棋谱，games=0；此档仍须在表内——它是「战术层净贡献」归因的对照组。' },
    { id: 'v1-facts', name: '胜/挡', rank: 1, commit: '678b701', commitAt: '2026-09-29 14:21',
      date: '2026-09-29', mech: { win: true, block: true }, games: 0,
      note: '战术保险初版：自己一步能赢直接赢，对方一步能赢必须挡。无归档棋谱（新版实验设施补测对象）。' },
    { id: 'v2-open4', name: '活四级', rank: 2, commit: '15996b1', commitAt: '2026-09-29 16:08',
      date: '2026-09-29', mech: { win: true, block: true, open4: true }, games: 0,
      note: 'criteria 战术标签契约：引擎代读棋盘打标签，活三/活四识别不再靠模型猜。无归档棋谱。' },
    { id: 'v3-make2', name: '造杀/拆杀', rank: 3, commit: 'e086742', commitAt: '2026-09-29 16:39',
      date: '2026-09-29', mech: { win: true, block: true, open4: true, threat: true, parry: true }, games: 0,
      note: '2-ply 扩展（用户补丁）：threat 造杀点（自己两步胜）+ parry 拆杀点（对方双杀点）。无归档棋谱。' },
    { id: 'v4-parry3', name: '活三预挡', rank: 4, commit: 'd10fd1f', commitAt: '2026-09-29 17:11',
      date: '2026-09-29', mech: { win: true, block: true, open4: true, threat: true, parry: true, parry3: true }, games: 0,
      note: '败局复盘驱动：抢 deny:open4/deny:live3 标签点。与 v5 仅差 safeSort 内部排序，棋谱标签不可分——按落库时间归 v5 窗口（21 局）。' },
    { id: 'v5-safesort', name: '拆杀安全排序', rank: 5, commit: '87beda6', commitAt: '2026-09-29 17:41',
      date: '2026-09-29', mech: { win: true, block: true, open4: true, threat: true, parry: true, parry3: true, safeSort: true }, games: 21,
      note: '层数不变，parry 层内部升级：多 danger 并存时 3-ply 试走挑最安全的。9/29 17:51–19:28 落库 21 局（11 局人机/机机 + 10 局 exp-20260929105234/exp-20260929111222，proxy vs random），parry3 标签实证 ≥v4。' },
    { id: 'v6-parry4', name: '冲四预挡', rank: 6, commit: 'f48d052', commitAt: '2026-09-30 10:42',
      date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, parry: true, parry3: true, safeSort: true, parry4: true }, games: 0,
      note: 'deny:four 冲四预挡（Rapfi 复盘：放任冲四制造点会被连续单杀逼迫）；同期加入禁手模式 gomoku-pro。与 v7 相隔 1 分钟，无归档棋谱。' },
    { id: 'v7-vcf', name: 'VCF 攻防', rank: 7, commit: '57a9508', commitAt: '2026-09-30 10:43',
      date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true }, games: 4,
      note: 'VCF 威胁空间搜索接入：7 ply / 4000 节点，层数 5→9，vcfAttack/vcfDefense 插在 threat 与 parry 之间。exp-20260930025135（proxy vs rapfi，10:53–10:57 落库）4 局，vcfAttack/vcfDefense 标签实证。' },
    { id: 'v8-vcf-try', name: 'VCF 逐点试', rank: 8, commit: '9cf4a88', commitAt: '2026-09-30 11:41',
      date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true }, games: 3,
      note: '层数不变，vcfDefense 补丁：链首占不住时逐点试干预。exp-20260930084500（proxy vs rapfi，16:46–16:54 落库）3 局=线上旧引擎，均无 meta，反证部署版本停滞在此档。' },
    { id: 'v9-vcf-sound', name: '防伪胜（当前）', rank: 9, commit: 'a16fdd9', commitAt: '2026-09-30 16:58',
      date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true }, games: 0,
      note: 'vcfWin soundness 修复：引擎层双杀短路前过守方反杀闸门（gomoku.defenderWinsFull）+ 棋谱归因 meta（codeVersion/aiMoveMeta/aiGameMeta）。当前档，待新实验设施补测。' },
  ];
  const CURRENT = 'v9-vcf-sound';
  const BY_ID = {};
  VERSIONS.forEach((v) => { BY_ID[v.id] = v; });

  /** 解析档位：falsy → 当前档；未知 id → 当前档（写错档号静默回退，联名/对局都不能因它崩）。 */
  function resolve(id) {
    if (id == null || id === '') return BY_ID[CURRENT];
    return BY_ID[String(id)] || BY_ID[CURRENT];
  }
  /** 机制闸门：该版本没有的机制必须整条跳过（computeTactics 与接管链共用）。 */
  function allows(version, mech) {
    return !!version && !!version.mech[mech];
  }

  function selfTest() {
    const U = BG.util.assert;
    const MECHS = ['win', 'block', 'open4', 'threat', 'vcfAttack', 'vcfDefense', 'parry', 'parry3', 'parry4', 'safeSort', 'vcfTry', 'sound'];
    U(VERSIONS.length === 10, '应登记 9 个战术版本 + 1 基线，实际 ' + VERSIONS.length);
    U(CURRENT === VERSIONS[VERSIONS.length - 1].id, '当前档必须是最后一档');
    VERSIONS.forEach((v, i) => {
      U(v.rank === i, v.id + ' rank 不连续');
      U(typeof v.commit === 'string' && v.commit.length > 0, v.id + ' 缺引入提交');
      U(typeof v.commitAt === 'string' && v.commitAt.length > 0, v.id + ' 缺引入时间');
      U(typeof v.note === 'string' && v.note.length > 0, v.id + ' 缺实战依据');
      U(Number.isInteger(v.games) && v.games >= 0, v.id + ' games 必须是非负整数');
    });
    for (let i = 1; i < VERSIONS.length; i++)
      for (const k of MECHS)
        if (VERSIONS[i - 1].mech[k]) U(!!VERSIONS[i].mech[k], VERSIONS[i].id + ' 丢了上级机制 ' + k);
  }

  BG.tacticsVersions = { VERSIONS, CURRENT, MECHS: Object.freeze(['win', 'block', 'open4', 'threat', 'vcfAttack', 'vcfDefense', 'parry', 'parry3', 'parry4', 'safeSort', 'vcfTry', 'sound']), resolve, allows, ids: () => VERSIONS.map((v) => v.id), selfTest };
})();
```

- [x] **Step 4: 实跑确认通过**

Run: `node test/run-tests.js` → `✓ 战术版本登记表（9 档机制阶梯 + 基线）`。

- [x] **Step 5: Commit**

```bash
git add js/tactics-versions.js test/run-tests.js
git commit -m "feat(tactics): 战术版本登记表——9 档机制阶梯 + 基线（git 历史 × 棋谱归属）"
```

### Task 1.2：`js/duel.js`——对阵联名与棋谱 slug

**Files:**
- Create: `js/duel.js`
- Modify: `test/run-tests.js`（注册 + 单测）

- [x] **Step 1: 写失败测试**

```js
/* 单元：对阵联名与棋谱 slug（战绩簿 / 实验报告 / 服务端文件名共用同一套命名） */
function duelTests() {
  const D = globalThis.BG.duel;
  BG.util.assert(D, 'BG.duel 应存在（需先 eval js/duel.js）');
  const gomoku = globalThis.BG.games.gomoku;
  const J = (t) => gomoku ? gomoku.name : '五子棋';
  /* 单边展示名 */
  BG.util.assert(D.sideLabel({ human: true }) === '我', '人类侧应显示「我」');
  BG.util.assert(D.sideLabel({ channel: 'mock' }) === '演示', 'mock 应显示「演示」');
  BG.util.assert(D.sideLabel({ channel: 'proxy' }) === 'Jev·v9', 'Jev 渠道应带战术版本短号，实际 ' + D.sideLabel({ channel: 'proxy' }));
  BG.util.assert(D.sideLabel({ channel: 'random', tactics: 'v4-parry3' }) === '随机·v4', '随机渠道也应带版本，实际 ' + D.sideLabel({ channel: 'random', tactics: 'v4-parry3' }));
  BG.util.assert(D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 3000 }) === 'Rapfi(3s)', 'Rapfi 应带思考时长，实际 ' + D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 3000 }));
  BG.util.assert(D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 500 }) === 'Rapfi(0.5s)', '0.5s 档应显示 0.5s，实际 ' + D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 500 }));
  /* 联名 / 战绩簿 / 实验标签 */
  BG.util.assert(D.duelLabel({ channel: 'proxy' }, { channel: 'rapfi', rapfiThinkMs: 5000 }) === '黑 Jev·v9 vs 白 Rapfi(5s)',
    '联名格式不对：' + D.duelLabel({ channel: 'proxy' }, { channel: 'rapfi', rapfiThinkMs: 5000 }));
  BG.util.assert(D.gameLabel('五子棋', 'human', { human: true }, { channel: 'proxy' }) === '五子棋 · 人机 · 黑 我 vs 白 Jev·v9',
    '战绩簿名不对：' + D.gameLabel('五子棋', 'human', { human: true }, { channel: 'proxy' }));
  BG.util.assert(D.expLabel({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' }, 4) === 'Jev·v9 vs 随机·v3 ×4局',
    '实验标签不对：' + D.expLabel({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' }, 4));
  /* slug：小写、只留 [a-z0-9-]、压连续分隔符、注入字符必须被清掉、≤24 */
  const s = D.slug({ channel: 'random', tactics: 'v3-make2' }, { channel: 'proxy' });
  BG.util.assert(s === 'ran-v3-vs-jev-v9', 'slug 不对：' + s);
  BG.util.assert(!/[^a-z0-9_-]/.test(s) && s.length <= 24, 'slug 必须只含安全字符且 ≤24：' + s);
  const inject = D.slug({ channel: 'proxy', tactics: '../../etc/pa' }, { channel: 'mock' });
  BG.util.assert(inject.indexOf('/') < 0 && inject.indexOf('.') < 0, '路径注入必须被清掉：' + inject);
  /* 空配置不得产出空 slug */
  BG.util.assert(D.slug({}, {}).length > 0, '空配置也应有兜底 slug');
}
```

注册：

```js
  duelTests();
  results.push('✓ 对阵联名与棋谱 slug');
```

- [x] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL，`BG.duel 应存在`。

- [x] **Step 3: 实现 `js/duel.js`**

```js
/* duel.js — 战绩簿显示名、实验联名、棋谱文件名 slug（纯函数）
 *
 * 一套命名三处共用：战绩簿列（app.renderRecords）、实验报告（BG.jev-lab 结果），
 * 以及落库文件名（server.js / functions/api/games.js 的 slug 字段）。
 * 人看到的联名与文件名可互相推导，才可能事后归因某一盘棋是谁的什么版本。
 *
 * 依赖 js/tactics-versions.js（取版本短号）。无 DOM 依赖。
 */
(function () {
  const BG = (typeof window !== 'undefined' && window.BG) || globalThis.BG;
  if (!BG || !BG.tacticsVersions) throw new Error('duel.js 必须先加载 js/tactics-versions.js');

  /* 渠道 → 中文短名。Jev 三渠道（proxy/openrouter/official）同一个模型，联名一律 Jev。 */
  const CH_SHORT = { proxy: 'Jev', openrouter: 'Jev', official: 'Jev', mock: '演示', rapfi: 'Rapfi', random: '随机' };
  /* 渠道 → 英文短名（slug 专用：中文在文件名里折叠成 - 会丢失语义，random 要能认出来） */
  const CH_EN = { proxy: 'jev', openrouter: 'jev', official: 'jev', mock: 'mock', rapfi: 'rapfi', random: 'ran' };

  /** 版本短号：v9-vcf-sound → v9；未知档位原样透出（便于发现登记表漏项）。 */
  function versionTag(id) {
    const v = BG.tacticsVersions.resolve(id);
    const m = /^v(\d+)/.exec(v.id);
    return m ? 'v' + m[1] : v.id;
  }

  /** 单边配置 → 展示名。cfg = { channel, tactics?, rapfiThinkMs?, human? }
   *  - human → 我；mock → 演示（不经过战术层，标版本无意义）
   *  - Jev/random → 带战术版本短号（实验室可读性就在这一位）
   *  - rapfi → 带思考时长秒数（WASM 单线程，时长是它的关键参数） */
  function sideLabel(cfg) {
    const c = cfg || {};
    if (c.human) return '我';
    const ch = c.channel || 'mock';
    if (ch === 'rapfi') return 'Rapfi(' + (Math.round((c.rapfiThinkMs || 3000) / 100) / 10) + 's)';
    if (ch === 'mock') return '演示';
    if (ch === 'random') return '随机·' + versionTag(c.tactics);
    return (CH_SHORT[ch] || ch) + '·' + versionTag(c.tactics);
  }

  /** 单边配置 → slug 段（英文）。e.g. {channel:'random',tactics:'v3-make2'} → ran-v3 */
  function sideSlug(cfg) {
    const c = cfg || {};
    if (c.human) return 'me';
    const ch = c.channel || 'mock';
    const en = CH_EN[ch] || String(ch).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (ch === 'mock') return en;
    if (ch === 'rapfi') return 'rapfi-' + (Math.round((c.rapfiThinkMs || 3000) / 100) / 10) + 's';
    return en + '-' + versionTag(c.tactics);
  }

  /** 联名：黑 Jev·v9 vs 白 Rapfi(3s) */
  function duelLabel(blackCfg, whiteCfg) {
    return '黑 ' + sideLabel(blackCfg) + ' vs 白 ' + sideLabel(whiteCfg);
  }

  /** 战绩簿一行名：五子棋 · 人机 · 黑 我 vs 白 Jev·v9 */
  function gameLabel(gameName, mode, blackCfg, whiteCfg) {
    const modeTxt = mode === 'ai-ai' ? '机机' : mode === 'pvp' ? '双人' : '人机';
    return gameName + ' · ' + modeTxt + ' · ' + duelLabel(blackCfg, whiteCfg);
  }

  /** 实验标签：Jev·v9 vs 随机·v3 ×4局（交换先后各 2 局） */
  function expLabel(blackCfg, whiteCfg, games) {
    return sideLabel(blackCfg) + ' vs ' + sideLabel(whiteCfg) + ' ×' + (games || 4) + '局';
  }

  /** 棋谱文件名 slug：小写、非 [a-z0-9] 折叠成 -、去首尾 -、截 24（与 server.sanitizeGid 对齐）。
   *  e.g. 黑 随机·v3 vs 白 Jev·v9 → ran-v3-vs-jev-v9 */
  function slug(blackCfg, whiteCfg) {
    const raw = (sideSlug(blackCfg) + '-vs-' + sideSlug(whiteCfg)).toLowerCase();
    const s = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (s || 'nogid').slice(0, 24);
  }

  function selfTest() {
    const U = BG.util.assert;
    U(sideLabel({ human: true }) === '我', 'human → 我');
    U(sideLabel({ channel: 'mock' }) === '演示', 'mock → 演示');
    U(sideLabel({ channel: 'rapfi', rapfiThinkMs: 3000 }) === 'Rapfi(3s)', 'rapfi 3s');
    U(sideLabel({ channel: 'rapfi', rapfiThinkMs: 500 }) === 'Rapfi(0.5s)', 'rapfi 0.5s');
    U(sideLabel({ channel: 'proxy' }) === 'Jev·v9', 'Jev 默认档');
    U(sideLabel({ channel: 'random', tactics: 'v4-parry3' }) === '随机·v4', 'random 带版本');
    const inj = slug({ channel: 'proxy', tactics: '../../etc/pa' }, { channel: 'mock' });
    U(inj.indexOf('/') < 0 && inj.indexOf('.') < 0, 'slug 必须清掉路径字符：' + inj);
    U(slug({}, {}).length > 0, '空配置兜底 slug');
  }

  BG.duel = { CH_SHORT, CH_EN, sideLabel, sideSlug, duelLabel, gameLabel, expLabel, slug, selfTest };
})();
```

- [x] **Step 4: 实跑确认通过 + 页面内自检挂载**

Run: `node test/run-tests.js` → 全绿。
在 `js/app.js` 的自检面板（:1554-1572 那段）里补两行（与 `BG.calibration.selfTest()` 同款）：

```js
      if (BG.tacticsVersions) { BG.tacticsVersions.selfTest(); panel.innerHTML += '<span class="ok">✓ 战术登记表</span><br>'; }
      if (BG.duel) { BG.duel.selfTest(); panel.innerHTML += '<span class="ok">✓ 对阵联名</span><br>'; }
```

- [x] **Step 5: Commit**

```bash
git add js/duel.js test/run-tests.js js/app.js
git commit -m "feat(lab): 对阵联名与棋谱 slug——战绩簿/实验/文件名同一套命名（js/duel.js）"
```

---

## Phase 2：jev-client 版本闸门 + meta.tacticsVersion

### Task 2.1：接管链每级加机制闸门；decide 记档位

**Files:**
- Modify: `js/jev-client.js:239-317`（computeTactics 加 `version` 形参 + 分层闸门）
- Modify: `js/jev-client.js:425-609`（decide：解析档位、接管链闸门、meta）
- Modify: `js/board.js:59-77`（aiMoveMeta 加 `tv` 字段）
- Modify: `test/run-tests.js`（闸门归因测试 + meta 字段测试）

**关键改法（其余代码一律不动）：**

`computeTactics(engine, st, legal, cands, version)`——第 5 形参 `version`；旧的四参调用（现有测试）传 `undefined` → `resolve()` 回退当前档，行为不变：

```js
  function computeTactics(engine, st, legal, cands, version) {
    const ver = BG.tacticsVersions.resolve(version);
    const M = ver.mech;
    const out = emptyTactics();
    if (!(M.win || M.block || M.threat || M.parry || M.vcfAttack || M.vcfDefense)) return out; // v0-off：纯概率
    /* 其下各层用 M 包住： */
    // if (M.win) { ...原 win 扫描... }
    // if (M.block) { ...原 block 扫描... }
    // if ((M.threat || M.parry) && engine.deepTactics && win.length === 0 && block.length === 0 && oppSide) { ...原 2-ply... }
    // if (engine.deepTactics && engine.vcfWin && (M.vcfAttack || M.vcfDefense)) { ...原 VCF 双向... }
  }
```

`decide()` 接管链（目标代码，:548-579 改写为此形态；点集扫描同样加闸门，旧版本连扫描都不做）：

```js
      const ver = BG.tacticsVersions.resolve(opts.tacticsVersion);
      const M = ver.mech;
      const tactics = computeTactics(engine, st, legal, cands, ver);
      /* 候选点扫描只在机制上线时进行（省算力 + 保持历史版本语义） */
      const open4Points = M.open4 ? openFourPoints(engine, ser) : [];
      const parry3Pts = M.parry3 ? parryThreePoints(engine, ser) : [];
      const parry4Pts = M.parry4 ? parryFourPoints(engine, ser) : [];
      let notation = null;
      let reason = '';
      if (M.win && tactics.winning_points_you.length) { notation = pickAmong(tactics.winning_points_you); reason = 'win'; }
      else if (M.block && tactics.winning_points_opponent.length) { notation = pickAmong(tactics.winning_points_opponent); reason = 'block'; }
      else if (M.open4 && open4Points.length) { notation = pickAmong(open4Points); reason = 'open4'; }
      else if (M.threat && tactics.chance_points_you.length) { notation = pickAmong(tactics.chance_points_you); reason = 'threat'; }
      else if (M.vcfAttack && tactics.vcf_win_you.length) { notation = pickAmong(tactics.vcf_win_you); reason = 'vcfAttack'; }
      else if (M.vcfDefense && tactics.vcf_win_opponent.length) { notation = pickAmong(tactics.vcf_win_opponent); reason = 'vcfDefense'; }
      else if (M.parry && tactics.danger_points_opponent.length) {
        notation = M.safeSort ? pickSafestParry(engine, ser, st, tactics.danger_points_opponent)
                             : pickAmong(tactics.danger_points_opponent);
        reason = 'parry';
      }
      else if (M.parry3 && parry3Pts.length) { notation = pickAmong(parry3Pts); reason = 'parry3'; }
      else if (M.parry4 && parry4Pts.length) { notation = pickAmong(parry4Pts); reason = 'parry4'; }
```

decide 的 `meta`（:598-609）新增字段：`tacticsVersion: ver.id`。

`js/board.js` `aiMoveMeta(notation, m)` 新增：`tv: m && m.tacticsVersion != null ? String(m.tacticsVersion) : null`（放在 `tactics` 字段旁）。

- [x] **Step 1: 写失败测试（版本闸门归因 + meta 透传）**

在 `jevClientTests()` 末尾追加（复用已建好的 `withFetch` / `mk` / `e`）：

```js
  /* ⑩ 战术版本闸门：同一局面，v0-off 纯概率、v1-facts 只胜/挡、v2-open4 才有活四级、
     v6 无 VCF（沿旧预挡）、v7 才走 VCF 干预。meta.tacticsVersion 必须如实记录档位。 */
  const probA9 = { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { A9: 0.9 } } } };
  const decideV = (st, ver, body) => withFetch(async (url, init) => mk(200, body || probA9),
    () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: ver }));

  /* stx：黑四连（H8/I8/J8/K8 都在）轮黑走，G8/L8 致胜点（⑥ 局面） */
  const dOff = await decideV(stx, 'v0-off');
  BG.util.assert(dOff.notation === 'A9', 'v0-off 不应有战术接管，实际：' + dOff.notation + '/' + dOff.meta.tactics);
  BG.util.assert(dOff.meta.tactics == null && dOff.meta.tacticsVersion === 'v0-off',
    'v0-off 应无战术标签且记档 v0-off，实际：' + dOff.meta.tactics + '/' + dOff.meta.tacticsVersion);
  const dWin = await decideV(stx, 'v1-facts');
  BG.util.assert((dWin.notation === 'G8' || dWin.notation === 'L8') && dWin.meta.tactics === 'win',
    'v1-facts 必须接管致胜点，实际：' + dWin.notation + '/' + dWin.meta.tactics);
  BG.util.assert(dWin.meta.tacticsVersion === 'v1-facts', 'meta 应记 v1-facts，实际 ' + dWin.meta.tacticsVersion);

  /* stl（⑥c 局面）：黑活三、I8 活四点；v1-facts 无 open4 → 不接管；v2-open4 → 接管 */
  const dNo4 = await decideV(stl, 'v1-facts');
  BG.util.assert(dNo4.meta.tactics !== 'open4' && (dNo4.notation === 'G6' || true),
    'v1-facts 不该有 open4 接管，实际：' + dNo4.meta.tactics);
  const d4 = await decideV(stl, 'v2-open4');
  BG.util.assert((d4.notation === 'E8' || d4.notation === 'I8') && d4.meta.tactics === 'open4',
    'v2-open4 必须接管活四点，实际：' + d4.notation + '/' + d4.meta.tactics);

  /* st9b：黑开放三连 F7/F8/F9 轮黑走，F6/F10 造杀点；v2 造杀未上线 → 不接管 */
  const dNoThr = await decideV(st9b, 'v2-open4');
  BG.util.assert(dNoThr.meta.tactics !== 'threat', 'v2-open4 不该有造杀接管，实际：' + dNoThr.meta.tactics);
  const dThr = await decideV(st9b, 'v3-make2');
  BG.util.assert((dThr.notation === 'F6' || dThr.notation === 'F10') && dThr.meta.tactics === 'threat',
    'v3-make2 必须接管造杀点，实际：' + dThr.notation + '/' + dThr.meta.tactics);

  /* st9d：vcfDefense 优先于 parry3（VCF 发现黑有真将死链 E6→D5→D6→F6→E7）。
     v6-parry4（无 VCF）→ 只能 parry3；v7-vcf → 接管到 E6。 */
  const dV6 = await decideV(st9d, 'v6-parry4');
  BG.util.assert((dV6.notation === 'E7' || dV6.notation === 'H10') && dV6.meta.tactics === 'parry3',
    'v6 无 VCF 时应 parry3 预挡，实际：' + dV6.notation + '/' + dV6.meta.tactics);
  const dV7 = await decideV(st9d, 'v7-vcf');
  BG.util.assert(dV7.notation === 'E6' && dV7.meta.tactics === 'vcfDefense',
    'v7 应被 VCF 将死链接管到 E6，实际：' + dV7.notation + '/' + dV7.meta.tactics);

  /* 档位写错 → 静默回退当前档（对局不能因一个错档号崩） */
  const dBad = await decideV(stx, 'v9-nope');
  BG.util.assert(dBad.meta.tacticsVersion === 'v9-vcf-sound' && dBad.meta.tactics === 'win',
    '未知档号应回退当前档，实际：' + dBad.meta.tacticsVersion + '/' + dBad.meta.tactics);

  /* aiMoveMeta 应透传 tv 字段（导出的每着手记都能看到版本） */
  const meta1 = BG.util.aiMoveMeta('H8', { move: {}, tactics: 'win', tacticsVersion: 'v3-make2', latencyMs: 12 });
  BG.util.assert(meta1.tv === 'v3-make2', 'aiMoveMeta 应记 tv=v3-make2，实际：' + meta1.tv);
  const meta0 = BG.util.aiMoveMeta('H8', { move: {} });
  BG.util.assert(meta0.tv === null, '无档位时 tv 应为 null，实际：' + meta0.tv);
```

- [x] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL，`v0-off 不应有战术接管`（当前 decide 无条件走全接管链，v0-off 也会 G8/L8）。

- [x] **Step 3: 实现**

按上文「关键改法」逐处改写 `js/jev-client.js`。注意：
- `computeTactics` 现有 return 点（win/block 早退分支 :249-268 是扫描不是 return）只包 `if (M.win)` / `if (M.block)`；函数结尾的汇总 return 保持。
- VCF 块现有的 `if (atk) {...} if (def) {...}` 分别用 `M.vcfAttack` / `M.vcfDefense` 包住。
- **vcfTry 闸门（v8 行为）**：在 `def` 分支里，防守候选点的构造由 `候选 = [链首点]` 改为 `const 候选 = M.vcfTry ? [链首点].concat(line) : [链首点];`——v7 只占链首（占不住就放弃、落到 parry3），v8 起链上逐点试干预。此行为差由 `tacticsRegistryTests` 的 `vcfTry` 档位断言守住（v7 false / v8 true）。
- 接管链中现有局部函数名 `open4Points/parry3Points/parry4Points` 与上面目标代码里的 `open4Points` 冲突——改为目标代码中的 `open4Points/parry3Pts/parry4Pts`（内层箭头函数定义上移为具名函数 `openFourPoints/parryThreePoints/parryFourPoints`，原逻辑一行不改）。

- [x] **Step 4: 实跑确认通过**

Run: `node test/run-tests.js` → 全绿（注意 ⑥/⑥d/⑦/⑨ 等旧断言仍须通过——它们走默认档=CURRENT，行为不变）。

- [x] **Step 5: Commit**

```bash
git add js/jev-client.js js/board.js test/run-tests.js
git commit -m "feat(jev): 接管链按战术版本闸门接管，decide 记 meta.tacticsVersion、着记记 tv"
```

---

## Phase 3：全局设置抽屉 + 侧栏三页签「对局/实验/数据」+ Rapfi 时长常显

### Task 3.1：右上角设置抽屉，全局设置从侧栏搬迁，Rapfi 思考时长常显

**Files:**
- Modify: `index.html:15-27`（header 加齿轮按钮）、`index.html:239-350`（pane-settings → pane-exp，设置块搬进抽屉）
- Create: `index.html` 抽屉 markup（放在 toast 容器之前）
- Modify: `css/style.css`（.gear-btn / .drawer / .drawer-mask / .side-cfg 样式）
- Modify: `js/app.js`（抽屉开关 + Esc/mask 关闭 + 移除 :65 的 hidden toggle）
- Modify: `test/run-tests.js`（DOM 契约：新 id 齐全、全文档无重复 id）

**搬迁映射（DOM 节点整体移动，id 全部保持不变，JS 引用无需改）：**

| 控件（id） | 去向 |
|---|---|
| `mode` / `side` / `speedRow` / `expChanA` / `expChanB` / `expGames` / `expStartBtn` / `expStopBtn` / `modeHint` | `pane-exp`（原 `pane-settings`） |
| `channel` / `rapfiThinkMs` + `rapfiThinkLabel` / `endpoint` / `apiKey` / `orKey` / `probeRow` / `probeOut` / `topK` | 抽屉「引擎与连接」 |
| `gameSync` | 抽屉「引擎与连接」 |
| `backendBlock` | `pane-data`（ledger 面板之前） |

**抽屉 markup（新增，ID 唯一）：**

```html
<button id="settingsGear" class="gear-btn" type="button" aria-haspopup="dialog" aria-controls="settingsDrawer" title="全局设置（引擎与连接）">
  <span aria-hidden="true">⚙</span><span class="gear-txt">设置</span>
</button>
...
<div id="drawerMask" class="drawer-mask hidden" role="presentation"></div>
<aside id="settingsDrawer" class="drawer hidden" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">
  <div class="drawer-head">
    <h2 id="drawerTitle">全局设置</h2>
    <button id="drawerClose" class="mini-btn" type="button">关闭</button>
  </div>
  <div class="drawer-body" id="drawerBody"><!-- 见映射表从 pane-settings 迁入 --></div>
</aside>
```

- [x] **Step 1: 写失败测试（DOM 契约）**

```js
/* 单元：DOM 契约——R3/R5/R6 新控件必须存在且全文档 id 唯一 */
function domContractTests() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ids = [];
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.push(m[1]);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  BG.util.assert(dup.length === 0, 'index.html 存在重复 id：' + dup.join(','));
  const need = ['settingsGear', 'settingsDrawer', 'drawerMask', 'drawerClose', 'drawerBody',
    'tacticsStrip', 'swapBtn', 'expChanA', 'expChanB', 'mode', 'side', 'speedRow', 'rapfiThinkMs'];
  for (const id of need)
    BG.util.assert(html.indexOf('id="' + id + '"') >= 0, 'index.html 缺控件 #' + id);
  /* 三页签契约：对局/实验/数据（实验必须独立成栏，不复刻设置嵌套） */
  for (const p of ['play', 'exp', 'data'])
    BG.util.assert(html.indexOf('data-pane="' + p + '"') >= 0, '侧栏应含页签 ' + p);
  BG.util.assert(html.indexOf('id="pane-exp"') >= 0, '应有独立 pane-exp');
  BG.util.assert(html.indexOf('id="pane-settings"') < 0, 'pane-settings 应改名为 pane-exp（设置已搬迁）');
  /* Rapfi 时长控件常驻抽屉：不得再被 hidden 条件隐藏 */
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  BG.util.assert(!/rapfiThinkLabel'\)\.classList\.toggle\('hidden'/.test(app),
    'rapfiThinkLabel 不应再按渠道隐藏（抽屉内常显）');
}
```

注册：

```js
  domContractTests();
  results.push('✓ DOM 契约（抽屉/三页签/沿革条控件齐全且 id 唯一）');
```

- [x] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL，`index.html 缺控件 #settingsGear`（并可能报 `rapfiThinkLabel 不应再按渠道隐藏`）。

- [x] **Step 3: 实现**

1. `index.html` header（:15-27）加 `settingsGear` 按钮（放 `head-spacer` 之后、三个 chip 之前）。
2. 新建抽屉 markup（toast 之前）；把映射表控件整段搬入，保持 id 与 `class` 不变；`rapfiThinkLabel` 的 class 去掉 `hidden`。
3. `pane-settings` → `pane-exp`（`id` 与 `class="side-pane"`、对应 tab 按钮 `data-pane="exp"` 文案改「实验」）。
4. `backendBlock` 移入 `pane-data`。
5. `js/app.js:65` 删除 `$('rapfiThinkLabel').classList.toggle('hidden', ch !== 'rapfi');` 一行。
6. `js/app.js` 新增（挂在 bind 区或其后）：

```js
  /* 全局设置抽屉：右上角齿轮开关，Esc / 点遮罩关闭 */
  function openDrawer() {
    $('settingsDrawer').classList.remove('hidden');
    $('drawerMask').classList.remove('hidden');
  }
  function closeDrawer() {
    $('settingsDrawer').classList.add('hidden');
    $('drawerMask').classList.add('hidden');
  }
```
   绑定：`$('settingsGear').addEventListener('click', openDrawer);`、`$('drawerClose').addEventListener('click', closeDrawer);`、`$('drawerMask').addEventListener('click', closeDrawer);`、`document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });`
7. `css/style.css` 追加：

```css
/* ---------- 全局设置抽屉 ---------- */
.gear-btn {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--line-strong); border-radius: 999px;
  background: var(--bg2); color: var(--ink-dim);
  font: inherit; font-size: 12px; padding: 5px 12px; cursor: pointer;
}
.gear-btn:hover { color: var(--zhu); border-color: rgba(194, 64, 42, .45); }
.drawer-mask { position: fixed; inset: 0; background: rgba(23, 27, 33, .34); z-index: 40; }
.drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 41;
  width: min(430px, 92vw); background: var(--bg1);
  border-left: 1px solid var(--line);
  box-shadow: -18px 0 44px rgba(23, 27, 33, .14);
  display: flex; flex-direction: column;
}
.drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
.drawer-head h2 { font-family: var(--font-display); font-size: 16px; letter-spacing: 2px; margin: 0; }
.drawer-body { overflow-y: auto; padding: 14px 16px 28px; }
```

- [x] **Step 4: 实跑确认通过 + 人工核查**

Run: `node test/run-tests.js` → 全绿。
人工核查：齿轮开抽屉/Esc/遮罩关闭；Rapfi 下拉在抽屉常显（不再随主渠道隐藏）；页签「实验」含模式/我方执子/机机间隔/实验面板；`backendBlock` 在数据栏；`localStorage` 里旧 key（无 `tacticsVersion`/`sideConfig`）刷新后自动补齐不报错。

- [x] **Step 5: Commit**

```bash
git add index.html css/style.css js/app.js test/run-tests.js
git commit -m "feat(ui): 全局设置进右上角抽屉（Rapfi 时长常显）+ 侧栏改对局/实验/数据三页签"
```

---

## Phase 4：双方自由配置 + 换边重开 + 联名/slug 归档

### Task 4.1：`sideConfig`——黑白各自覆盖渠道/战术/时长（人机与实验共用）

**Files:**
- Modify: `js/app.js:17`（settings 默认）、`:21-35`（loadSettings 补齐旧数据）、`:88-109`（effectiveChannel* 重构）、`:517-527`（scheduleAI 传档位）、`:584-616`（buildGameExport）、`:763-788`（实验）、`:1139-1202`（renderRecords）、`:1449-1533`（bind）
- Modify: `index.html`（抽屉内「双方覆盖」+ 实验面板版本/时长选择）
- Modify: `css/style.css`（.side-cfg）
- Modify: `test/run-tests.js`（配置解析/联名回归；Node 侧不测 DOM，用纯函数断言 effSide 语义）

- [ ] **Step 1: 写失败测试**

```js
/* 单元：双方配置归一化 + 联名端到端（零依赖纯逻辑，复刻 app.effSide 的语义） */
function sideConfigTests() {
  const R = globalThis.BG.tacticsVersions, D = globalThis.BG.duel;
  /* 缺省继承：空覆盖 → 全局值 */
  const eff = (side, settings, sideConfig) => {
    const c = (sideConfig && sideConfig[side]) || {};
    return {
      channel: c.channel || settings.channel,
      tactics: R.resolve(c.tactics || settings.tacticsVersion).id,
      rapfiThinkMs: c.rapfiThinkMs || settings.rapfiThinkMs,
    };
  };
  const base = { channel: 'proxy', tacticsVersion: 'v9-vcf-sound', rapfiThinkMs: 3000 };
  const inherit = eff('black', base, { black: {}, white: {} });
  BG.util.assert(inherit.channel === 'proxy' && inherit.tactics === 'v9-vcf-sound' && inherit.rapfiThinkMs === 3000,
    '空覆盖应继承全局，实际：' + JSON.stringify(inherit));
  const over = eff('white', base, { white: { channel: 'rapfi', tactics: 'v3-make2', rapfiThinkMs: 500 } });
  BG.util.assert(over.channel === 'rapfi' && over.tactics === 'v3-make2' && over.rapfiThinkMs === 500,
    '覆盖应生效，实际：' + JSON.stringify(over));
  BG.util.assert(eff('black', base, { white: { channel: 'rapfi' } }).channel === 'proxy', '不得串到另一边');
  /* 写错档号回退当前档（不抛错） */
  BG.util.assert(eff('black', base, { black: { tactics: 'v77' } }).tactics === 'v9-vcf-sound', '错档号应回退当前档');
  /* 联名端到端：人机（我 vs Jev·v9）与实验（Jev·v9 vs 随机·v3） */
  const humanDuel = D.gameLabel('五子棋', 'human-ai', { human: true, channel: 'proxy' }, { channel: 'proxy' });
  BG.util.assert(humanDuel === '五子棋 · 人机 · 黑 我 vs 白 Jev·v9', '人机联名不对：' + humanDuel);
  const expDuel = D.expLabel({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' }, 4);
  BG.util.assert(expDuel === 'Jev·v9 vs 随机·v3 ×4局', '实验联名不对：' + expDuel);
  const s = D.slug({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' });
  BG.util.assert(s === 'jev-v9-vs-ran-v3', '实验 slug 不对：' + s);
}
```

（该测试在本 Task 先落地；`app.js` 的 `effSide` 必须与 `eff` 语义一致——实现时把 `effSide` 写成调同一套解析。）

- [ ] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL，`空覆盖应继承全局`（R.resolve 存在但断言先于 app.effSide 存在——先以测试钉死契约；确认失败信息正确后进入实现）。

> 说明：本任务测试的是「契约本身」，不 import app.js（app.js 依赖 DOM）。实现时必须让 `js/app.js` 的 `effSide()` 与测试中的 `eff()` 逐字同义，否则 Phase 5 集成时人机/实验会与登记表脱节。

- [ ] **Step 3: 实现 `js/app.js`**

1. `:17` settings 默认新增：

```js
    tacticsVersion: 'v9-vcf-sound',
    sideConfig: { black: {}, white: {} },
```

2. `:21-35` loadSettings 末尾补齐（旧 localStorage 无这两键）：

```js
    if (!S.settings.tacticsVersion) S.settings.tacticsVersion = 'v9-vcf-sound';
    const mk = (s) => ({ channel: (s && s.channel) || '', tactics: (s && s.tactics) || '', rapfiThinkMs: +(s && s.rapfiThinkMs) || 0 });
    const sc = S.settings.sideConfig || {};
    S.settings.sideConfig = { black: mk(sc.black), white: mk(sc.white) };
```

3. `:88-109` 重构（把渠道解析从 settings 提为「任一渠道字符串」，双方配置才有落点）：

```js
  /* 渠道字符串 → 实际渠道（mock/rapfi/random 直通；Jev 三渠道回退 mock 时给出提示由 UI 管） */
  function effectiveChannelOf(ch) { /* 原 effectiveChannel() 的函数体，参数由 S.settings.channel 改为入参 ch */ }
  function effSide(side) {
    const cfg = (S.settings.sideConfig && S.settings.sideConfig[side]) || {};
    return {
      channel: effectiveChannelOf(cfg.channel || S.settings.channel),
      tactics: BG.tacticsVersions.resolve(cfg.tactics || S.settings.tacticsVersion).id,
      rapfiThinkMs: +(cfg.rapfiThinkMs || S.settings.rapfiThinkMs) || S.settings.rapfiThinkMs,
    };
  }
  /* side = 引擎 sides 的 id；按引擎顺序归一为 'black'|'white'（与先后手无关，禁手指纹不掺频道） */
  function sideIdOf(side) { return S.engine.sides[1].id === side ? 'white' : 'black'; }
  function effectiveChannelFor(side) { return effSide(sideIdOf(side)).channel; }
```

4. `:517-527` scheduleAI 的 decide opts：

```js
        const eff = effSide(sideIdOf(side));
        const out = await BG.jev.decide(S.engine, S.state, side, {
          channel: eff.channel,
          tacticsVersion: eff.tactics,
          rapfiThinkMs: eff.rapfiThinkMs,
          topK: S.settings.topK, endpoint: ..., apiKey: ..., seed: ..., experience: ...,
        });
```

5. `index.html` 抽屉「双方覆盖」区（`drawerBody` 末尾追加）：

```html
<div class="drawer-sub">双方覆盖（留空 = 跟随上方全局设置）</div>
<div class="side-cfg" id="sideCfgBlack">
  <div class="side-cfg-name">黑方</div>
  <label>渠道<select id="blackChannel"><option value="">跟随全局</option></select></label>
  <label>战术<select id="blackTactics"></select></label>
  <label>思考<select id="blackThinkMs"><option value="">跟随</option></select></label>
</div>
<div class="side-cfg" id="sideCfgWhite">
  <div class="side-cfg-name">白方</div>
  <label>渠道<select id="whiteChannel"><option value="">跟随全局</option></select></label>
  <label>战术<select id="whiteTactics"></select></label>
  <label>思考<select id="whiteThinkMs"><option value="">跟随</option></select></label>
</div>
```

   实验面板（`pane-exp` 内）新增两套（供 A/B Quick pick；与上面覆盖区共用同一 `sideConfig`，实验开始/换边时写入）：

```html
<div class="exp-row"><span>A 黑先</span>
  <select id="expTacA"></select><select id="expThinkA"></select></div>
<div class="exp-row"><span>B 白先</span>
  <select id="expTacB"></select><select id="expThinkB"></select></div>
```

6. `js/app.js` 新增渲染/读写：

```js
  /* 抽屉双方覆盖 + 实验面板 A/B 选择：选项一律从 BG.tacticsVersions 登记表生成（新增档位零改 UI） */
  const THINK_OPTS = [['', '跟随'], ['500', '0.5s'], ['1000', '1s'], ['2000', '2s'], ['3000', '3s'], ['5000', '5s'], ['10000', '10s']];
  function fillTacticsSelect(sel) {
    sel.innerHTML = '';
    for (const v of BG.tacticsVersions.VERSIONS)
      sel.insertAdjacentHTML('beforeend', '<option value="' + v.id + '">' + v.id + ' ' + v.name + '</option>');
  }
  function fillThinkSelect(sel) {
    sel.innerHTML = '';
    for (const [val, txt] of THINK_OPTS) sel.insertAdjacentHTML('beforeend', '<option value="' + val + '">' + txt + '</option>');
  }
  function renderSideCfg() {
    const chans = [['', '跟随全局'], ['proxy', 'Jev 模型'], ['openrouter', 'Jev·OpenRouter'], ['official', 'Jev·官方'], ['rapfi', 'Rapfi 引擎'], ['random', '随机+战术'], ['mock', '演示']];
    for (const side of ['black', 'white']) {
      const c = $(side + 'Channel');
      if (!c) continue;
      c.innerHTML = chans.map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('');
      fillTacticsSelect($(side + 'Tactics'));
      fillThinkSelect($(side + 'ThinkMs'));
      const cfg = S.settings.sideConfig[side] || {};
      c.value = cfg.channel || '';
      $(side + 'Tactics').value = BG.tacticsVersions.resolve(cfg.tactics).id;
      $(side + 'ThinkMs').value = String(cfg.rapfiThinkMs || '');
    }
    for (const side of ['A', 'B']) { fillTacticsSelect($('expTac' + side)); fillThinkSelect($('expThink' + side)); }
  }
  function saveSideCfg() {
    for (const side of ['black', 'white']) {
      S.settings.sideConfig[side] = {
        channel: $(side + 'Channel').value,
        tactics: $(side + 'Tactics').value,
        rapfiThinkMs: +($(side + 'ThinkMs').value) || 0,
      };
    }
    saveSettings();
    syncChannelUI();
  }
```

   绑定（bind 区）：`['black', 'white'].forEach((s) => { $(s + 'Channel').onchange = saveSideCfg; $(s + 'Tactics').onchange = saveSideCfg; $(s + 'ThinkMs').onchange = saveSideCfg; });`，并在 `switchGame`/`loadSettings` 之后调用 `renderSideCfg()`。

7. 实验（`:763-788`）改为写 `sideConfig`（删掉 `S.expChannels` 分支）：

```js
    function runExperimentGame(gameNo) {
      const sides = gameNo % 2 === 0 ? ['A', 'B'] : ['B', 'A']; // 交换先后各半，消除先手偏置
      const tacA = $('expTacA').value, tacB = $('expTacB').value;
      const thinkA = +$('expThinkA').value || 0, thinkB = +$('expThinkB').value || 0;
      const mkCfg = (chan, tac, think) => ({ channel: chan, tactics: tac, rapfiThinkMs: think });
      S.settings.sideConfig = {
        black: mkCfg(sides[0] === 'A' ? $('expChanA').value : $('expChanB').value, sides[0] === 'A' ? tacA : tacB, sides[0] === 'A' ? thinkA : thinkB),
        white: mkCfg(sides[1] === 'A' ? $('expChanA').value : $('expChanB').value, sides[1] === 'A' ? tacA : tacB, sides[1] === 'A' ? thinkA : thinkB),
      };
      ...
    }
```

8. `buildGameExport`（:584-616）增加联名字段：

```js
    const bCfg = effSide('black'), wCfg = effSide('white');
    return {
      format: 'jev-qiguan-game/v1',
      game: S.engine.name, gid: GID,
      slug: BG.duel.slug(bCfg, wCfg),
      duel: BG.duel.duelLabel(bCfg, wCfg),
      blackChannel: bCfg.channel, whiteChannel: wCfg.channel,
      blackTactics: bCfg.tactics, whiteTactics: wCfg.tactics,
      ...
```

9. `renderRecords`（:1170-1202）每行加「对阵」列（`r.duel || '（旧棋谱无联名）'`）；表头加 `<th>对阵</th>`；`recordExperiment` 的 label 用 `BG.duel.expLabel(bCfg, wCfg, games)`。

10. `css/style.css` 追加 `.side-cfg/.side-cfg-name/.drawer-sub/.exp-row`（三列网格、12px 小字、可对齐）：

```css
.drawer-sub { margin: 18px 0 8px; font-size: 12.5px; color: var(--ink-dim); letter-spacing: .04em; }
.side-cfg { display: grid; grid-template-columns: 34px 1fr; gap: 6px 8px; align-items: center; margin-bottom: 10px; }
.side-cfg-name { font-size: 12.5px; color: var(--zhu); font-weight: 700; }
.side-cfg label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-dim); grid-column: span 2; }
.side-cfg select { flex: 1 1 auto; min-width: 0; }
```

- [ ] **Step 4: 实跑确认通过 + 人工核查**

Run: `node test/run-tests.js` → 全绿。
人工核查：抽屉改「白方渠道=rapfi、战术=v3-make2、思考=5s」→ 人机局白方确实由 Rapfi 以 5s/档走子且 `meta.tacticsVersion='v3-make2'`；导出棋谱 JSON 含 `slug`/`duel`/`blackTactics`/`whiteTactics`；战绩簿新列显示联名；实验面板选 A/B 版本后 4 局交换先后。

- [ ] **Step 5: Commit**

```bash
git add js/app.js index.html css/style.css test/run-tests.js
git commit -m "feat(lab): 黑白双方独立配置（渠道/战术版本/思考时长），人机与实验共用 sideConfig"
```

### Task 4.2：换边重开（R6）+ 未终局记账

**Files:**
- Modify: `index.html:50-58`（controls 加 `#swapBtn`）
- Modify: `js/app.js`（`swapSidesAndRestart` + `finishGame({winner:null})` 终局渲染 + bind）
- Modify: `js/app.js` calibrate 取样（:568-582，确认 `winner:null` 不计入先手胜率）
- Modify: `test/run-tests.js`（换边中断棋谱记录的渲染契约——用纯函数复刻判定）

- [ ] **Step 1: 写失败测试**

```js
/* 单元：换边中断的终局语义（winner:null + reason:'换边中断' = 未终局，不是和棋） */
function swapRestartTests() {
  const resOf = (winner, reason) => ({
    winner, reason,
    text: winner ? (winner === 'black' ? '黑胜' : '白胜') : (reason === '换边中断' ? '未终局' : '和棋'),
    isDraw: !winner && reason !== '换边中断',
  });
  const r = resOf(null, '换边中断');
  BG.util.assert(r.text === '未终局' && r.isDraw === false, '换边中断应记未终局，实际：' + r.text);
  BG.util.assert(resOf(null, '棋盘已满').text === '和棋' && resOf(null, '棋盘已满').isDraw === true, '真和棋不得被误判为未终局');
  BG.util.assert(resOf('black', '五连').text === '黑胜', '正常胜负文案');
  /* 校准：未终局不得进入先手胜率统计 */
  const firstWin = (games) => {
    const done = games.filter((g) => g.result && g.result.winner);
    const w = done.filter((g) => g.result.winner === g.sides[0]).length; // 简化：先手指纹由调用方给
    return done.length ? w / done.length : null;
  };
  BG.util.assert(firstWin([{ result: { winner: null, reason: '换边中断' } }]) === null, '未终局不得计入校准');
  BG.util.assert(firstWin([{ result: { winner: 'black' } }, { result: { winner: null, reason: '换边中断' } }]) === 1, '未终局应被剔除');
}
```

- [ ] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL（当前无 `换边中断` reason 的处理路径，文案走「和棋」分支）。

- [ ] **Step 3: 实现**

1. `index.html:50-58` controls 内追加：

```html
<button id="swapBtn" class="mini-btn" type="button" title="重开一局并交换我方执子（原局记「未终局」）">换边重开</button>
```

2. `js/app.js` 新增：

```js
  /* R6 换边重开：原局记「未终局」照常记账/导出/同步（都在新局 resetSession 之前），
   * 随后交换我方执子重开。语义见 spec §4.3.1：不写 localStorage、不伪造终局。 */
  function swapSidesAndRestart() {
    if (S.mode !== 'human-ai') return;
    if (S.history.length && !S.over) finishGame({ winner: null, reason: '换边中断' });
    const other = S.engine.sides[1].id;
    S.humanSide = (S.humanSide === other) ? S.engine.sides[0].id : other;
    const sel = $('side'); if (sel) sel.value = S.humanSide;
    startGame();
  }
```

3. `saveGameRecord`/`renderRecords`（:1139-1202）终局文案：

```js
    const resTxt = r.result && r.result.winner ? (r.result.winner === 'black' ? '黑胜' : '白胜')
      : (r.result && r.result.reason === '换边中断' ? '未终局' : '和棋');
```
   行样式：仅 `isDraw` 时加 draw 类；「未终局」不加。
4. `calSamples`（:568-582）：先手胜率统计只取 `result.winner` 非空的样本（`未终局` 剔除）。
5. 显隐：`syncChannelUI()` 或 `startGame` 后按 `S.mode === 'human-ai' && S.history.length > 0` 控制 `#swapBtn` 的 `hidden`（空局无需换边）。bind：`$('swapBtn').addEventListener('click', swapSidesAndRestart);`

- [ ] **Step 4: 实跑确认通过 + 人工核查**

Run: `node test/run-tests.js` → 全绿。
人工核查：人机下几手点「换边重开」→ 出现终局提示「未终局」、战绩簿多一行未终局（不同色）、新局我方执子已交换且棋盘清空；校准面板先手胜率不变。

- [ ] **Step 5: Commit**

```bash
git add js/app.js index.html test/run-tests.js
git commit -m "feat(lab): 换边重开——原局记未终局、新局交换执子（spec §4.3.1）"
```

### Task 4.3：联名 slug 归档（server.js + Pages Function）

**Files:**
- Modify: `server.js:320-342`（handleGamesPost 用 slug 作文件名，回退 gid）
- Modify: `functions/api/games.js:58-63`
- Modify: `test/server-tests.js`（slug / 回退 / 消毒 三例）

- [ ] **Step 1: 写失败测试**

在 `test/server-tests.js` 既有棋谱 POST 用例附近追加：

```js
  /* R4：slug 联名归档——文件名用 slug；无 slug 回退 gid；脏字符被 sanitizeGid 清掉 */
  const r1 = await postJson('/api/games', Object.assign(baseGame(), { gid: 'gomoku', slug: 'jev-v9-vs-rapfi-3s', exported: '2026-09-30T12:00:00Z' }));
  assert(r1.status === 200 && /jev-v9-vs-rapfi-3s-\d{8}T\d{6}\.json$/.test(r1.body.path), '文件名应为 <slug>-<stamp>.json，实际：' + JSON.stringify(r1.body));
  const r2 = await postJson('/api/games', Object.assign(baseGame(), { gid: 'gomoku', exported: '2026-09-30T12:00:01Z' }));
  assert(r2.status === 200 && /gomoku-\d{8}T\d{6}\.json$/.test(r2.body.path), '无 slug 应回退 gid，实际：' + JSON.stringify(r2.body));
  const r3 = await postJson('/api/games', Object.assign(baseGame(), { gid: 'gomoku', slug: '../../etc/pa', exported: '2026-09-30T12:00:02Z' }));
  assert(r3.status === 200 && r3.body.path.indexOf('/etc/') < 0 && /[a-zA-Z0-9_-]+-\d{8}T\d{6}\.json$/.test(r3.body.path), '脏 slug 必须被消毒：' + JSON.stringify(r3.body));
```

> 注：`baseGame()`/`postJson()` 用文件里既有的 helper；临时 gamesDir 已在 fixture 中。stamp 格式以 `dayAndStamp` 实际输出为准（`iso.slice(0,19).replace(/[-:T]/g,'')` → `20260930T120000`）。

- [ ] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL，`文件名应为 <slug>-<stamp>.json`（当前忽略 `body.slug`）。

- [ ] **Step 3: 实现**

`server.js:328`：

```js
    const gid = sanitizeGid(body.gid);
    const slug = sanitizeGid(body.slug) || gid; // R4：出战联名（jev-v9-vs-rapfi-3s）；无 slug 回退 gid，兼容旧客户端
    const fileName = slug + '-' + stamp + '.json';
```

`functions/api/games.js:62`：

```js
  const gid = String(body.gid || 'nogid').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  const slug = (String(body.slug || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)) || gid;
  const path = `games/${ymd}/${slug}-${stamp}.json`;
```

commit message 里的 `gid` 改 `slug`（:69），便于 git log 直读对阵。

- [ ] **Step 4: 实跑确认通过**

Run: `node test/run-tests.js` → 全绿。
人工核查：本地 `node server.js` 起服务，前端导出一盘并同步 → `games/<今天>/jev-v9-vs-ran-v3-<stamp>.json` 生成，内容含 `slug`/`duel`。

- [ ] **Step 5: Commit**

```bash
git add server.js functions/api/games.js test/server-tests.js
git commit -m "feat(games): 棋谱文件名改用联名 slug（无 slug 回退 gid，脏字符消毒）"
```

---

## Phase 5：棋盘下方「战术沿革条」

### Task 5.1：10 枚版本条（9 档 + 基线）+ 点击设为默认档位

**Files:**
- Modify: `index.html`（board-card controls 之后加 `#tacticsStrip`）
- Modify: `js/app.js`（`renderTacticsStrip()` + 点击切换 + 调用点）
- Modify: `css/style.css`（.tactics-strip / .tv-chip / .tv-chip.cur / .tv-chip.used）
- Modify: `test/run-tests.js`（domContractTests 已含 `tacticsStrip`，本任务补渲染逻辑纯函数测试）

- [ ] **Step 1: 写失败测试**

```js
/* 单元：战术沿革条的渲染数据（当前档高亮、在用档标出、点击改默认档只写 settings） */
function tacticsStripTests() {
  const R = globalThis.BG.tacticsVersions;
  const render = (settings, inUse) => R.VERSIONS.map((v) => ({
    id: v.id, cur: settings.tacticsVersion === v.id, used: inUse.indexOf(v.id) >= 0,
  }));
  const chips = render({ tacticsVersion: 'v4-parry3' }, ['v9-vcf-sound', 'v4-parry3']);
  BG.util.assert(chips.length === 10, '应渲染 10 枚（9 档战术版本 + 无战术基线），实际 ' + chips.length);
  BG.util.assert(chips.filter((c) => c.cur).length === 1 && chips.find((c) => c.cur).id === 'v4-parry3', '当前档应唯一高亮');
  BG.util.assert(chips.filter((c) => c.used).length === 2, '在用档应被标出');
  /* 点击只改全局默认档，不得顺手改动双方覆盖 */
  const next = (s, id) => Object.assign({}, s, { tacticsVersion: id });
  const after = next({ tacticsVersion: 'v4-parry3', sideConfig: { black: { tactics: 'v1-facts' } } }, 'v6-parry4');
  BG.util.assert(after.tacticsVersion === 'v6-parry4' && after.sideConfig.black.tactics === 'v1-facts', '点沿革条不得改覆盖配置');
}
```

- [ ] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL，`应渲染 10 枚（9 档战术版本 + 无战术基线）`（render 函数尚未定义——测试先钉契约）。

- [ ] **Step 3: 实现**

1. `index.html`：`.controls` 之后、`.status-strip` 之前：

```html
<section class="tactics-strip" id="tacticsStrip" aria-label="战术版本沿革（点击设为默认战术档位）">
  <span class="tactics-strip-label">战术沿革</span>
</section>
```

2. `js/app.js`：

```js
  /* 战术沿革条：9 档战术版本 + 1 无战术基线；引入提交/时间 + 实战依据（title 悬浮看 note）；
   * 点击设为全局默认档。只改 S.settings.tacticsVersion，不动 sideConfig 覆盖（覆盖显式指定者不受影响）。 */
  function renderTacticsStrip() {
    const box = $('tacticsStrip');
    if (!box || !BG.tacticsVersions) return;
    box.querySelectorAll('.tv-chip').forEach((n) => n.remove());
    const inUse = [effSide('black').tactics, effSide('white').tactics];
    for (const v of BG.tacticsVersions.VERSIONS) {
      const cur = S.settings.tacticsVersion === v.id;
      const used = inUse.indexOf(v.id) >= 0;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tv-chip' + (cur ? ' cur' : '') + (used ? ' used' : '');
      el.dataset.ver = v.id;
      el.title = v.name + '（' + v.commit + '，' + v.date + '）\n' + v.note;
      el.textContent = v.id.replace(/^v(\d+).*/, (m, n) => 'v' + n) + (v.id === BG.tacticsVersions.CURRENT ? '·今' : '');
      el.addEventListener('click', () => {
        S.settings.tacticsVersion = v.id;
        saveSettings();
        renderTacticsStrip();
        toast('默认战术档位 → ' + v.id + ' ' + v.name);
      });
      box.appendChild(el);
    }
  }
```

   在 `loadSettings` 之后与 `renderSideCfg()` 一起调用；`switchGame`/`startGame` 后刷新一次（`used` 态随双方配置变）。
3. `css/style.css`：

```css
/* ---------- 战术沿革条 ---------- */
.tactics-strip { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.tactics-strip-label { font-size: 11px; color: var(--ink-dim); letter-spacing: .12em; margin-right: 2px; }
.tv-chip {
  font: inherit; font-family: var(--font-mono); font-size: 11px; line-height: 1;
  padding: 4px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg2); color: var(--ink-dim);
}
.tv-chip:hover { border-color: var(--line-strong); color: var(--ink); }
.tv-chip.used { border-color: rgba(194, 64, 42, .45); color: var(--zhu); }
.tv-chip.cur { background: var(--zhu); border-color: var(--zhu); color: #fff; font-weight: 700; }
```

- [ ] **Step 4: 实跑确认通过 + 人工核查**

Run: `node test/run-tests.js` → 全绿。
人工核查：沿革条 10 枚（v0 基线 + v1–v9）、当前档实心、在用档描边；点击 `v3-make2` → toast 提示、默认档变更、新对局（无覆盖侧）落到 v3；页签切到数据再回来条不变。

- [ ] **Step 5: Commit**

```bash
git add index.html js/app.js css/style.css test/run-tests.js
git commit -m "feat(ui): 棋盘下方战术沿革条——9 档战术版本 + 基线可见可切（版本即实验变量）"
```

---

## Phase 6：文档同步 + codeVersion 0.8.0 + 终验

### Task 6.1：ADR-0009 + status.md + MEMORY.md + codeVersion

**Files:**
- Create: `docs/adr/0009-tactics-version-registry.md`
- Modify: `docs/status.md`、`docs/memory/MEMORY.md`（顶部）
- Modify: `js/board.js:28`（`BG.codeVersion='0.7.0'` → `'0.8.0'`）
- Modify: `test/run-tests.js`（若已有 codeVersion 断言则同步期望——当前仅断言非空，无需改）

- [ ] **Step 1: 写失败测试（版本号闸门）**

在 `test/run-tests.js` 的 meta 单元段（:63-129 附近）补一行，把 codeVersion 钉成 `0.8.0`：

```js
  BG.util.assert(BG.codeVersion === '0.8.0', 'codeVersion 应随本计划升到 0.8.0，实际 ' + BG.codeVersion);
```

- [ ] **Step 2: 实跑确认失败**

Run: `node test/run-tests.js`
Expected: FAIL，`codeVersion 应随本计划升到 0.8.0，实际 0.7.0`。

- [ ] **Step 3: 实现**

1. `js/board.js:28` → `BG.codeVersion = '0.8.0';`
2. ADR-0009（新建）必含：背景（战术层 9 次提交累加上线→无法归因）、决策（登记表 + 机制闸门 + `meta.tacticsVersion` + 联名 slug）、备选（把版本写进 git tag / 分支 per 实验——否决理由：标签不进棋谱 meta，跨分支 diff 噪音）、后果（对决增加一次 resolve 调用；旧棋谱无 slug 由服务端回退 gid 兼容）。
3. `docs/status.md`：版本 v0.8；新增已知限制：① 战术版本闸门只影响 Jev 渠道（mock/rapfi 早退不经战术层——mock 自检用、rapfi 引擎自带战术）② `sideConfig` 是单值非按局持久，刷新即回全局默认 ③ 沿革条点击改的是全局默认档，实验中改不影响已开局的双方覆盖；删掉「Rapfi 时长不可调」类旧条目（已不成立）。
4. `docs/memory/MEMORY.md` 顶部加一段：本期实验设施三件套（`js/tactics-versions.js` 登记表 / `js/duel.js` 联名 / `effSide` 双方配置）+ 一句「改战术层必同步登记表，否则版本归因断裂」。
5. 各 Phase 已带的文案更新保持；本任务做全文校对（grep `0.7.0`、`S.expChannels`、`pane-settings` 应无残留）。

- [ ] **Step 4: 实跑全量验证**

Run: `node test/run-tests.js`
Expected: 全绿（七引擎 selfTest + 校准 + 登记表 + 联名 + 闸门 + DOM/布局契约 + 集成 + server 契约 + Pages + Rapfi）。
人工终验清单：① 人机换边重开全流程；② 抽屉改白方为 Rapfi(5s) 生效；③ 实验 4 局交换先后、结果联名正确；④ 导出棋谱含 slug/duel/blackTactics/whiteTactics/tv；⑤ 切页签棋盘宽度不变；⑥ 连走 ≥6 步，「最新决策」面板每步高度完全相等（DevTools 量 `#body-latest` 所在面板 height）；⑦ 沿革条点击切档生效。

- [ ] **Step 5: Commit**

```bash
git add docs/ js/board.js test/run-tests.js
git commit -m "docs: ADR-0009 战术版本登记表 + status/MEMORY 同步 + codeVersion 0.8.0"
```

---

## Integration Checklist（合并前必跑）

- [ ] `node test/run-tests.js` 全绿
- [ ] `git grep -n "S.expChannels\|pane-settings\|0\.7\.0"` 无残留（历史棋谱 games/ 内的旧 JSON 除外）
- [ ] 页面在 1280×800 / 1024×700 无横向滚动条；棋盘点击命中正常（`BG.eventXY` 按 rect 换算，CSS 缩放不影响）
- [ ] 关掉网络后：Jev 渠道走 mock 降级不得让沿革条/抽屉报错（纯前端逻辑）
- [ ] 旧 `localStorage`（无 `tacticsVersion`/`sideConfig`）刷新后自动补齐
- [ ] `games/` 旧文件名（`gomoku-<stamp>.json`）仍可被 `GET /api/games/:day/:name` 读取（NAME_RE 未动）

## Manual Verification（每个 UI 任务重复一次）

1. 布局：反复切 对局/实验/数据 三页签，`#board` 宽度三处一致（DevTools 量像素）。
2. 「最新决策」：连走 ≥6 步，面板高度每步完全相等；开局前与第一步后也相等（骨架首绘即终高）。
3. 抽屉：齿轮开 / Esc 关 / 遮罩关；Rapfi 时长常显。
4. 换边重开：原局记未终局、新局执子交换、校准不变。
5. 实验：A/B 版本 ×4 局交换先后，导出联名与 slug 一致。
6. 沿革条：点击切默认档，覆盖侧不受影响。

## Notes / 已完成决策的回执

- **登记表的权威来源 = git 历史 × 棋谱数据（用户 m00347/m00348）**：版本边界只认 commit 时间（`git show -s --format=%ci` 实测），9 个战术版本一版都不能少——v1-facts(678b701) → v2-open4(15996b1) → v3-make2(e086742) → v4-parry3(d10fd1f) → v5-safesort(87beda6) → v6-parry4(f48d052) → v7-vcf(57a9508) → v8-vcf-try(9cf4a88) → v9-vcf-sound(a16fdd9)。v0-off 是数据驱动的基线档（战术层上线前，`92e38e6→1da4d8a` 区间）：该区间未归档棋谱（games=0），它存在的意义是给「战术层净贡献」留对照组，由新版实验设施用 random 渠道补测。
- **棋谱归属（实测方法，勿凭文件名时间戳直读）**：棋谱 `exported` 是 UTC ISO 的落库时刻，换算北京时间（+8）后对照本地 git 梯级；另有更强证据——棋谱 `moves[]` 自带 `tactics` 标签，直接实证引擎触发过哪些机制（parry3 ⇒ ≥v4，parry4 ⇒ ≥v6，vcfAttack/vcfDefense ⇒ ≥v7）。结论：v5 21 局（9/29 17:51–19:28 落库，11 局人机/机机 + exp-20260929105234/exp-20260929111222 共 10 局 proxy-vs-random）、v7 4 局（exp-20260930025135 proxy-vs-rapfi）、v8 3 局（exp-20260930084500 线上旧引擎，无 meta）；v0–v4/v6/v9 为 0 局，合计 28 局。`games` 数变化时改登记表 + 同步 `tacticsRegistryTests` 断言（含合计 28 的护栏）。
- v4 与 v5 棋谱标签不可分（只差 parry 内部 safeSort 排序），21 局按落库时间归 v5 窗口；如日后复盘证明线上部署滞后，只需把 21 改到 v4 并同步断言。
- 9 级优先级顺序（用户 m00302）与接管链一致：win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4；v7 把 VCF 攻防两级插在 threat 与 parry 之间（5→9 层）。
- `sound` 键（v9）：引擎侧伪胜修复已在 `a16fdd9` 落库（`gomoku.defenderWinsFull`），客户端不再单独闸门；保留键位标明演进线，恒真。`vcfTry` 键（v8）是唯一有客户端行为差的机制闸门：防守候选 = `M.vcfTry ? [链首].concat(line) : [链首]`。
- mock/rapfi 渠道在 `decide()` 内早退，不经过战术层——版本闸门只对 Jev 渠道与 random 渠道可见（random 走完整管线，是「战术层净贡献」归因对照组）。
- Rapfi 单线程思考期间 UI 冻结（ADR-0006）：时长上限仍 10s；10s 档冻结线性放大，实验面板默认 3s。

## Open Questions

（无——spec 决策已全覆盖；执行中如遇 spec 未覆盖的新决策点，停下问用户再改 spec。）
