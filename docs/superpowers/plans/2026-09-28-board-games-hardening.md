# board-games 仓库硬化实施计划（repo hardening）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 board-games 补齐仓库规范（LICENSE / .gitattributes / package.json / CI / CHANGELOG / 仓库元数据）、代码健壮性（Pages Function 限流 + jev-client 回归测试）、可复现性（mock 种子化）与文档机制（check-docs 脚本）——不引入任何运行时依赖，不改变真实 Jev 渠道行为。

**Architecture:** 全部改动遵循仓库既有约定：零框架、零构建、零第三方依赖；新实现逐字复制兄弟项目 jev-piano 的已验证范本（滑动窗口限流器、mulberry32）；测试继续走 `test/run-tests.js` 的 eval 加载范式，不引测试框架；commit message 用中文 Conventional Commits（遵循本仓库 AGENTS.md §6，此处**不**沿用 jev-piano 的英文 commit 惯例）。

**Tech Stack:** 原生 JS（浏览器 + Node ≥18 双端可加载）、Cloudflare Pages Functions、Python ≥3.8（可选，仅 dev-proxy.py）。`package.json` 不含任何 dependencies/devDependencies。

---

## Phase 0: 已核实事实（4 个 discovery subagent 实证，2026-09-28）

| # | 事实 | 证据 |
|---|---|---|
| F1 | **`js/jev-client.js:127` 的 `opts.topK \| 0 \|\| 1` 不是 bug**。`\|` 优先级高于 `\|\|`，实际解析为 `(opts.topK\|0)\|\|1`：取整 + 0/NaN 兜底 1 + 外层 `Math.max(1,…)`。实跑验证 topK=2→2、4→4、2.7→2、NaN→1 全部正确 | 逐行对照实证（`(topK\|0)\|\|1` 列与真实表达式逐行一致；`topK\|1` 列在 2/4/2.7 处分道扬镳） |
| F2 | `callWithRetry`（`js/jev-client.js:60-85`）：最多 4 次尝试；429/529 退避 `1000·2^attempt` = 1000/2000/4000/8000ms；网络错误退避 `800·(attempt+1)`；401（line 81）同步立即抛错不重试；全 429 时抛「重试次数用尽」 | 源码逐字 + 行号 |
| F3 | `decide()` 回退分支（`js/jev-client.js:115-122`）：当响应概率中**无任何合法选项**时回退到 `legal[0]`（确定性），并置 `meta.warning`。但 warning 文案是「已**随机**回退」，与行为不符 | 源码逐字 + 端到端 PoC（喂 `{ZZZ:0.9}` → 返回 legal[0]） |
| F4 | Node v24.9.0，`globalThis.fetch/Response/Request/Headers` 原生可用；`fetch(` 全 `js/` 仅 `jev-client.js:49` 一处 | 实跑 `node --version`、`typeof` 检查、全目录 grep |
| F5 | `BG.jev` 只在 `test/run-tests.js:38` eval 后才存在；新增 jev-client 单测需自行 eval（幂等，IIFE 只重挂 `BG.jev`） | `test/run-tests.js:10-21,37-38` |
| F6 | `run-tests.js` 自身**不设置** `BG_FAST`；`mock-ai.js:8` 读 `process.env.BG_FAST`。不带该环境变量跑 `node test/run-tests.js` 时，mock 集成每步 sleep 320–800ms（约 241 步，合计 2 分钟以上） | `test/run-tests.js` 全文 + `js/mock-ai.js:8,13` |
| F7 | 限流范本（jev-piano `src/worker.js:6-19,33-35`）：`Map<ip, number[]>` 滑动窗口、`60_000`ms、`hits.size > 10_000` 清空、IP 取 `CF-Connecting-IP ?? 'unknown'`、限额 `Number(env.RATE_LIMIT_PER_MIN ?? 30)`、超限 429。Pages Function 差异：`request→context.request`、`env→context.env`，其余逐字可搬 | 两侧源码逐字对照 |
| F8 | **不能给根 `package.json` 加 `"type": "module"`**——`test/run-tests.js` 是 CommonJS（`require`），会直接崩。也**不能** `import()` Pages Function（无 package.json 时 `.js` 按 CJS 解析，`export` 语法 SyntaxError）；测试用 `new Function(剥掉 export 的源码 + '; return onRequestPost;')` 加载，模块状态（`hits` Map）只创建一次 | Node 模块规则 + 全仓 glob 无 package.json |
| F9 | 种子随机范本：`jev-piano/test/rng-shim.mjs` 的 mulberry32（10 行，逐字可抄）+ `composer.js:55` 的 `(seed ^ 0x9e3779b9) >>> 0` 异或混淆。**关键隔离点**：`BG.util.weightedPick`（`board.js:22`）直接调 `Math.random()`，不经 `BG.util.rand` → 只种子化 `BG.util.rand` 即可让 mock 链路全确定，真实 Jev 渠道的 top-k 采样自动保持真随机 | 两侧源码逐字 |
| F10 | mock 路径共 10 处直接随机：`mock-ai.js:21,44,45`（`Math.random()`）、`gomoku.js:203`、`chess.js:354`、`xiangqi.js:314`、`checkers.js:271`、`chinese-checkers.js:268`、`go.js:272,280`（引擎 mockPick 抖动）；`app.js:775` 是唯一的 URL 参数解析点（`location.search.indexOf('test=1')`）；`BG.util.shuffle` 是死代码；`serializeForJev` 已完全确定（gomoku 候选预筛无随机） | 全目录 grep 17 处命中逐处开原文确认 |

### Allowed APIs（允许使用/复制）

- `jev-piano/src/worker.js:6-19` 限流器、`jev-piano/test/rng-shim.mjs:2-10` mulberry32：逐字复制后按 F7/F9 做最小改写
- Node 原生：`fetch / Response / Request / Headers / AbortController`（Node ≥18 均可用，本机 v24 实证）
- `gh` CLI：已登录 tripodxu，scopes 含 `repo`、`workflow`（`gh repo edit` 可用）
- 既有约定：`BG.util.assert` 写断言、`test/run-tests.js` 的 `results` 数组 + `failed` 计数模式

### Anti-pattern 禁令（出现即打回）

1. **禁止把 `js/jev-client.js:127` 改成 `opts.topK | 1`**（F1：那才会引入"强制奇数"真 bug）。本计划对该行只加回归测试，不改代码。
2. 禁止给根 `package.json` 加 `"type": "module"` 或任何 dependencies（F8 + AGENTS.md §2.1）。
3. 禁止种子化 `BG.util.weightedPick` 或 `js/jev-client.js:132`（真实渠道必须保持真随机，F9）。
4. 禁止引测试框架/miniflare/wrangler 到运行时或测试（零依赖红线；Pages Function 用 `new Function` 加载，F8）。
5. 禁止英文 commit message（本仓库 AGENTS.md §6 规定中文；jev-piano 的英文惯例不适用）。
6. 禁止在引擎里传第 4 个 `rng` 参数改 `mockPick` 契约——用 `BG.util.rnd()` 内部接缝，签名不变（`docs/engine-interface.md:47`）。

---

## Phase 1: 仓库规范（编排者单人直做，7 个任务，互不依赖可连续提交）

### Task 1: 添加 .editorconfig

**Files:**
- Create: `.editorconfig`

- [ ] **Step 1: 写入文件（逐字复制 jev-piano `.editorconfig`）**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false

[*.py]
indent_size = 4

[*.toml]
indent_size = 2
```

- [ ] **Step 2: 提交**

```bash
git add .editorconfig
git commit -m "chore: 添加 .editorconfig（UTF-8/LF/2 空格，与 jev-piano 一致）"
```

### Task 2: 添加 .gitattributes 并规范化行尾

**Files:**
- Create: `.gitattributes`

- [ ] **Step 1: 写入文件**

```gitattributes
* text=auto eol=lf
```

- [ ] **Step 2: 重规范化并检查**

Run: `git add --renormalize . && git status --short`
Expected: 仓库 blob 本就是 LF（init 时 warning 已证实），预期**只有 `.gitattributes` 一个新文件**；若出现全文件变更，说明历史 blob 是 CRLF，属预期内的一次性重写，继续下一步。

- [ ] **Step 3: 提交**

```bash
git add .gitattributes
git commit -m "chore: 添加 .gitattributes（eol=lf），规范化行尾避免跨平台 diff 噪音"
```

### Task 3: 添加 MIT LICENSE

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: 写入文件（版权行按个人仓库先例用 GitHub 用户名，见 jev-piano hardening 计划 Task 3）**

```text
MIT License

Copyright (c) 2026 tripodxu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: 提交**

```bash
git add LICENSE
git commit -m "chore: 添加 MIT LICENSE"
```

### Task 4: 添加 package.json（零依赖，仅脚本与元数据）

**Files:**
- Create: `package.json`

- [ ] **Step 1: 写入文件**

```json
{
  "name": "board-games",
  "version": "0.1.0",
  "private": true,
  "description": "Jev 棋馆：六种棋类对弈，TypeSafe 系统一模型 Jev 走子。零框架零构建纯静态，双击即玩。",
  "scripts": {
    "test": "node test/run-tests.js",
    "check:docs": "node scripts/check-docs.mjs"
  },
  "engines": {
    "node": ">=18"
  }
}
```

注意：**无** `"type": "module"`（F8：会破坏 CJS 版 `run-tests.js`）；**无** dependencies/devDependencies。

- [ ] **Step 2: 验证 npm test 等价于原命令**

Run: `npm test`
Expected: 与 `node test/run-tests.js` 相同的输出（六引擎 ✓ + 三盘集成 ✓ + 「全部测试通过」）

- [ ] **Step 3: 提交**

```bash
git add package.json
git commit -m "chore: 添加 package.json（零依赖，npm test 映射唯一验收命令）"
```

### Task 5: 添加 GitHub Actions CI

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: 写入文件（生态内首个 CI；语法检查不含 `functions/api/jev.js`——它是 ESM `export` 语法，CJS 下 `node --check` 必红，其语法由 Task 11 的单测间接验证）**

```yaml
name: test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: 语法检查
        run: |
          node --check js/board.js
          node --check js/app.js
          node --check js/jev-client.js
          node --check js/mock-ai.js
          node --check js/charts.js
          for f in js/games/*.js; do node --check "$f"; done
          node --check test/run-tests.js
      - name: 引擎自检与集成对局
        run: npm test
      - name: 文档校验
        run: npm run check:docs
```

- [ ] **Step 2: 本地预演 CI 的三步**

Run:
```bash
node --check js/board.js && node --check js/app.js && node --check js/jev-client.js && node --check js/mock-ai.js && node --check js/charts.js && for f in js/games/*.js; do node --check "$f"; done && node --check test/run-tests.js && echo SYNTAX_OK
```
Expected: `SYNTAX_OK`（此时 `npm run check:docs` 会因 `scripts/check-docs.mjs` 不存在而失败——Task 17 创建后恢复；本步先只验证语法检查）

- [ ] **Step 3: 提交（先不 push）**

```bash
git add .github/workflows/test.yml
git commit -m "ci: push/PR 跑语法检查 + 引擎自检 + 文档校验（零依赖，无需 npm install）"
```

注：此时 `npm run check:docs` 会因 `scripts/check-docs.mjs` 尚不存在而失败，CI 的「文档校验」步在 Task 17 完成后才首次全绿。为避免中间出现红色构建，本计划所有 commit 统一在 Phase 5 Step 5 一次性 `git push`，之后用 `gh run list` 验收。

### Task 6: 添加 CHANGELOG

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: 写入文件（Keep a Changelog 格式；0.1.0 为追记，内容与 docs/status.md 对齐）**

```markdown
# CHANGELOG

本项目可感知的变更历史。版本语义：0.x 期间 minor 反映功能交付，patch 反映修复。
日常记录另见 [docs/memory/MEMORY.md](docs/memory/MEMORY.md)（新条目置顶）。

## [0.1.0] - 2026-09-28

### Added
- 六个棋种引擎：五子棋（15×15）、围棋（9×9，中国规则贴 5.5）、象棋、国际象棋、西洋跳棋、中国跳棋；统一接口 + selfTest
- 三种对弈模式：人机（可选执子）、机机（速度滑杆/暂停/单步）、人人
- Jev 接入四渠道：官方 API / OpenRouter / 同源代理 / 离线演示；429/529 指数退避；top-k 概率加权采样
- Jev 决策面板：top-3 概率条、置信度、局势判断（Noul/Score）、延迟、token 与成本累计
- CF Pages Functions BYOK 代理（functions/api/jev.js）与本地 dev-proxy.py
- 自检体系：node test/run-tests.js 与 index.html?test=1
- 文档体系：AGENTS.md、docs/（架构/引擎接口/Jev API/ADR/计划/多 agent 协同/记忆）
```

- [ ] **Step 2: 提交**

```bash
git add CHANGELOG.md
git commit -m "docs: 添加 CHANGELOG（追记 0.1.0）"
```

### Task 7: 设置 GitHub 仓库元数据

**Files:** 无（远端设置）

- [ ] **Step 1: 执行**

```bash
gh repo edit tripodxu/board-games --description "Jev 棋馆：六种棋类对弈，TypeSafe 系统一模型 Jev 走子。零框架零构建纯静态，双击即玩。" --add-topic jev --add-topic typesafe --add-topic board-games --add-topic gomoku --add-topic go --add-topic xiangqi --add-topic chess --add-topic static-site
```

- [ ] **Step 2: 验证**

Run: `gh repo view tripodxu/board-games --json description,repositoryTopics,licenseInfo`
Expected: description 非空、topics 含上述标签、licenseInfo 为 MIT（Task 3 推送后 GitHub 自动识别）

---

## Phase 2: 代码健壮性（Task 8 编排者；Task 9-12 可派 jev-dev 角色）

### Task 8: run-tests.js 默认跳过 mock 延迟

**Files:**
- Modify: `test/run-tests.js`（在第 8 行 `const ROOT = ...` 之前插入）

- [ ] **Step 1: 在文件头部的 require 之后、ROOT 定义之前插入**

```js
/* mock AI 的模拟延迟对自检无意义：默认跳过（BG_SLOW=1 可覆盖为真实延迟） */
if (!process.env.BG_SLOW) process.env.BG_FAST = '1';
```

- [ ] **Step 2: 验证提速**

Run: `Measure-Command { node test/run-tests.js }`（PowerShell）或 `time node test/run-tests.js`
Expected: 总耗时从约 2 分钟降到数秒内；输出仍为「全部测试通过」

- [ ] **Step 3: 提交**

```bash
git add test/run-tests.js
git commit -m "test: 自检默认跳过 mock 模拟延迟（BG_SLOW=1 可覆盖），验收从约 2 分钟降到数秒"
```

### Task 9: jev-client 单元测试（stub fetch：429 重试 / 401 即抛 / 非法着法回退 / topK 回归）

**Files:**
- Modify: `js/jev-client.js:120`（改 warning 文案）
- Modify: `test/run-tests.js`（新增 `jevClientTests()` 并接入执行链）
- Test: `test/run-tests.js`

- [ ] **Step 1: 先写失败测试——在 `integration()` 定义之后插入新函数**

```js
/* 单元：jev-client 的重试 / 401 / 非法着法回退 / topK 解析回归 */
async function jevClientTests() {
  eval(fs.readFileSync(path.join(ROOT, 'js/jev-client.js'), 'utf8')); // 挂 BG.jev（幂等）
  const e = globalThis.BG.games.gomoku;
  const st = e.newGame();
  const legal = e.getLegalMoves(st);
  const realFetch = globalThis.fetch;
  const mk = (status, obj) => new Response(JSON.stringify(obj), { status });
  const withFetch = async (impl, fn) => {
    globalThis.fetch = impl;
    try { return await fn(); } finally { globalThis.fetch = realFetch; }
  };
  /* 响应里只给非法选项 ZZZ → 命中回退分支 */
  const okBody = { model: 'jev-latest', usage: { input_tokens: 100, output_tokens: 0 },
    answers: { move: { probabilities: { ZZZ: 0.9 } } } };

  /* ① 429 → 200：退避重试一次后成功，且落入合法着法回退（真实 sleep 约 1s，可接受） */
  let calls = 0;
  const d1 = await withFetch(
    async () => (++calls === 1 ? mk(429, { error: 'slow down' }) : mk(200, okBody)),
    () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 3 })
  );
  BG.util.assert(calls === 2, '429 后应重试一次，实际调用 ' + calls + ' 次');
  BG.util.assert(d1.notation === legal[0].notation, '无合法选项应回退到 legal[0]');
  BG.util.assert(d1.meta.warning === '响应中无合法选项，已回退到首个合法着法', 'warning 文案应为更新后的版本，实际：' + d1.meta.warning);

  /* ② 401：立即抛错，绝不重试 */
  calls = 0;
  let err = null;
  try {
    await withFetch(
      async () => { calls++; return mk(401, { error: 'bad key' }); },
      () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 1 })
    );
  } catch (e2) { err = e2; }
  BG.util.assert(err && /401/.test(err.message), '401 应抛出含 401 的错误，实际：' + (err && err.message));
  BG.util.assert(calls === 1, '401 不应重试，实际调用 ' + calls + ' 次');

  /* ③ topK 解析回归（F1）：偶数必须保持偶数，防止被误"修"成 topK|1 */
  const parseTopK = (v) => Math.max(1, v | 0 || 1);
  BG.util.assert(parseTopK(2) === 2, 'topK=2 应解析为 2');
  BG.util.assert(parseTopK(4) === 4, 'topK=4 应解析为 4');
  BG.util.assert(parseTopK(undefined) === 1, 'topK 缺失应兜底为 1');
}
```

- [ ] **Step 2: 运行，确认按预期失败**

Run: `node test/run-tests.js`
Expected: FAIL，报 `warning 文案应为更新后的版本，实际：响应中无合法选项，已随机回退`（①的断言先红；②③此刻已绿也无妨）

- [ ] **Step 3: 修改 warning 文案（行为不变，只修正"随机"这个错误描述）**

`js/jev-client.js:120`：

```js
              candidates: 0, warning: '响应中无合法选项，已回退到首个合法着法', noul: answers.edge, score: answers.position },
```

（同时 grep 确认没有别处依赖旧文案：`grep -rn "已随机回退" js/ docs/` 预期零命中）

- [ ] **Step 4: 接入执行链（在现有 `.catch(...)` 与 `.finally(...)` 之间插入，保证串行、避免与集成对局争用 globalThis.fetch）**

```js
integration()
  .catch((e) => { failed++; results.push('✗ 集成测试: ' + e.message); })
  .then(() => jevClientTests())
  .catch((e) => { failed++; results.push('✗ jev-client 单元测试: ' + e.message); })
  .finally(() => {
```

- [ ] **Step 5: 运行，确认全绿**

Run: `node test/run-tests.js`
Expected: 六引擎 ✓ + 三盘集成 ✓ + 「全部测试通过」（新增用例无单独输出行即通过；失败会以 `✗ jev-client 单元测试: ...` 出现）

- [ ] **Step 6: 提交**

```bash
git add js/jev-client.js test/run-tests.js
git commit -m "test(jev-client): 补 429 重试/401 即抛/非法着法回退/topK 解析回归单测；修正回退 warning 文案（legal[0] 是确定性回退，非随机）"
```

### Task 10: Pages Function 限流（逐字范本改写）

**Files:**
- Modify: `functions/api/jev.js`

- [ ] **Step 1: 在文件头部注释之后、`export async function onRequestPost` 之前插入限流器（逐字复制 jev-piano `src/worker.js:6-19`，仅改注释中的 Workers→Pages）**

```js
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/** 滑动窗口限流。Pages isolate 内存计数：单实例精确，多实例为尽力而为的下限保护。 */
const hits = new Map();
function rateLimited(ip, limit) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  const blocked = arr.length >= limit;
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 10_000) hits.clear(); // 内存护栏：清空后重新累计，误伤可接受
  return blocked;
}
```

- [ ] **Step 2: 在 `onRequestPost` 开头、取 KEY 之前插入限流检查（超限直接返回，不消耗上游配额）**

```js
export async function onRequestPost(context) {
  const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const limit = Number(context.env.RATE_LIMIT_PER_MIN ?? 30);
  if (rateLimited(ip, limit)) {
    return json({ error: '请求过于频繁，请稍后再试（每 IP 每分钟 ' + limit + ' 次）' }, 429);
  }
  const KEY = context.request.headers.get('X-Api-Key')
```

（429 文案用中文，与本函数既有 401 中文提示保持一致；范本的英文文案不沿用。`RATE_LIMIT_PER_MIN` 未配置时默认 30。）

- [ ] **Step 3: 本地语法自检（用临时 .mjs 副本绕开 CJS 限制）**

Run:
```bash
cp functions/api/jev.js functions/api/jev.tmp-check.mjs && node --check functions/api/jev.tmp-check.mjs && rm functions/api/jev.tmp-check.mjs && echo OK
```
Expected: `OK`

- [ ] **Step 4: 提交**

```bash
git add functions/api/jev.js
git commit -m "feat(proxy): Pages Function 加每 IP 每分钟滑动窗口限流（默认 30，RATE_LIMIT_PER_MIN 可配），范本同 jev-piano"
```

### Task 11: Pages Function 单元测试（new Function 加载 + stub fetch）

**Files:**
- Modify: `test/run-tests.js`（新增 `pagesFunctionTests()` 并接入执行链）
- Test: `test/run-tests.js`

- [ ] **Step 1: 写测试（在 `jevClientTests` 之后插入）**

```js
/* 单元：Pages Function 的 401 / 422 / 限流 / 正常转发 */
async function pagesFunctionTests() {
  /* 无 package.json 时不能 import()；剥掉 export 后用 new Function 加载。
     hits Map 是模块状态：load() 只调用一次，跨用例共享计数。 */
  const src = fs.readFileSync(path.join(ROOT, 'functions/api/jev.js'), 'utf8')
    .replace(/export\s+async\s+function\s+onRequestPost/, 'async function onRequestPost');
  const onRequestPost = new Function(src + '\nreturn onRequestPost;')();

  const mkReq = (body, headers) => new Request('http://local/api/jev', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body,
  });
  const validBody = JSON.stringify({ state: { game: 'test' }, questions: { move: { type: 'choice' } } });

  /* ① 无 key → 401（IP 9.9.9.1，独立计数） */
  let r = await onRequestPost({ request: mkReq(validBody, { 'CF-Connecting-IP': '9.9.9.1' }), env: {} });
  BG.util.assert(r.status === 401, '无 key 应 401，实际 ' + r.status);

  /* ② 坏 JSON → 422（IP 9.9.9.2） */
  r = await onRequestPost({ request: mkReq('not-json', { 'CF-Connecting-IP': '9.9.9.2', 'X-Api-Key': 'k' }), env: {} });
  BG.util.assert(r.status === 422, '坏 JSON 应 422，实际 ' + r.status);

  /* ③+④ 限流与转发：limit=2，同一 IP 第 3 次 429（IP 9.9.9.3 计数全新） */
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const ctx = { env: { RATE_LIMIT_PER_MIN: '2' } };
    const req = () => ({ request: mkReq(validBody, { 'CF-Connecting-IP': '9.9.9.3', 'X-Api-Key': 'k' }), env: ctx.env });
    r = await onRequestPost(req()); BG.util.assert(r.status === 200, '第 1 次应 200，实际 ' + r.status);
    r = await onRequestPost(req()); BG.util.assert(r.status === 200, '第 2 次应 200，实际 ' + r.status);
    r = await onRequestPost(req()); BG.util.assert(r.status === 429, '第 3 次应 429，实际 ' + r.status);
    BG.util.assert(captured && captured.url === 'https://api.typesafe.ai/v1/systemone', '上游 URL 不对：' + (captured && captured.url));
    BG.util.assert(captured.init.headers.Authorization === 'Bearer k', 'Authorization 头不对');
    const sent = JSON.parse(captured.init.body);
    BG.util.assert(sent.model === 'jev-latest' && sent.state && sent.questions, '转发体缺字段');
  } finally {
    globalThis.fetch = realFetch;
  }
}
```

- [ ] **Step 2: 接入执行链**

```js
  .then(() => jevClientTests())
  .catch((e) => { failed++; results.push('✗ jev-client 单元测试: ' + e.message); })
  .then(() => pagesFunctionTests())
  .catch((e) => { failed++; results.push('✗ Pages Function 单元测试: ' + e.message); })
  .finally(() => {
```

- [ ] **Step 3: 运行确认全绿**

Run: `node test/run-tests.js`
Expected: 「全部测试通过」；若失败会打印 `✗ Pages Function 单元测试: ...`

- [ ] **Step 4: 提交**

```bash
git add test/run-tests.js
git commit -m "test(proxy): Pages Function 单测——401/422/限流 429/上游转发（new Function 加载 + stub fetch，零依赖）"
```

### Task 12: 限流的文档同步

**Files:**
- Modify: `docs/jev-api.md`（§2 表格的 proxy 行末追加限流说明）
- Modify: `README.md`（方式三第 3 条后追加一条）
- Modify: `docs/memory/MEMORY.md`（顶部插入新条目）
- Modify: `docs/status.md`（「当前状态」部署行补限流）

- [ ] **Step 1: `docs/jev-api.md` §2 proxy 行末尾追加**

```markdown
| `proxy` | 同源 `api/jev` | `jev-latest` | 请求头 `X-Api-Key` 透传（BYOK）；服务端 env `TYPESAFE_API_KEY` 仅作站长兜底 | CF Pages Function 或 `dev-proxy.py`；**Pages 侧有每 IP 每分钟滑动窗口限流（默认 30，`RATE_LIMIT_PER_MIN` 可配），超限 429** |
```

- [ ] **Step 2: `README.md`「方式三」第 3 条后插入第 4 条（原第 4 条顺延为第 5 条）**

```markdown
4. **限流**：代理带每 IP 每分钟 30 次的滑动窗口限流（isolate 内存，多实例为尽力而为），超限返回 429；可用 CF 环境变量 `RATE_LIMIT_PER_MIN` 调整。
```

- [ ] **Step 3: `docs/status.md` 的部署行修改为**

```markdown
| 部署 | ✅ | CF Pages Functions（BYOK + 每 IP 限流）+ dev-proxy.py；原样静态托管即可 |
```

- [ ] **Step 4: `docs/memory/MEMORY.md` 顶部（`---` 之后、首条 `##` 之前）插入**

```markdown
## 2026-09-28 · 仓库硬化：限流/CI/种子化（见 docs/superpowers/plans/2026-09-28-board-games-hardening.md）

- Pages Function 加每 IP 每分钟滑动窗口限流（默认 30，范本逐字抄 jev-piano/src/worker.js:6-19）；429 文案用中文与 401 保持一致。
- 更正一个此前的误判：`jev-client.js:127` 的 `opts.topK | 0 || 1` 解析为 `(opts.topK|0)||1`，行为正确（2→2、4→4），**不是 bug**；已加回归测试防止被误改成 `topK|1`（那才会强制奇数）。
- `decide()` 的 warning 文案由「已随机回退」改为「已回退到首个合法着法」——回退目标是 `legal[0]`，确定性。
- mock 链路种子化（?seed=42）：只动 `BG.util.rand` + 10 处 `Math.random`→`BG.util.rnd()`；`weightedPick`（真实渠道 top-k 采样）不经过 rand，自动保持真随机。
```

- [ ] **Step 5: 修正 ADR-0003 的 typo**

`docs/adr/0003-byok-proxy.md` 中「规模极小，暂不接受册」→「规模极小，暂不接纳该风险」（`grep -n "不接受册" docs/adr/` 改后应零命中）。

- [ ] **Step 6: 提交**

```bash
git add docs/jev-api.md README.md docs/status.md docs/memory/MEMORY.md docs/adr/0003-byok-proxy.md
git commit -m "docs: 同步限流说明与种子化记忆（jev-api/README/status/memory），修正 ADR-0003 typo"
```

---

## Phase 3: 可复现性（mock 种子化，3 个任务，顺序执行）

### Task 13: board.js 增加可种子随机源

**Files:**
- Modify: `js/board.js`（`BG.util` 定义处，line 8-32 区域）

- [ ] **Step 1: 在 `BG.util = {` 之前插入种子随机基础设施**

```js
  /* 可种子随机（mulberry32，与 jev-piano/test/rng-shim.mjs 同实现）。
     BG.setSeed(n) 后 BG.util.rand/rnd 变为确定性；未设置时仍走 Math.random。
     注意 BG.util.weightedPick 不经过 rand——真实 Jev 渠道的 top-k 采样
     保持真随机，不受 seed 影响（见 docs/jev-api.md §6）。 */
  BG.rng = function (seed) {
    let a = (seed ^ 0x9e3779b9) >>> 0; // 异或混淆：避免相邻 seed 产生相邻随机流
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  BG._rng = null;
  BG.setSeed = function (seed) { BG._rng = BG.rng(seed); };
```

- [ ] **Step 2: 改 `BG.util.rand` 并新增 `BG.util.rnd`（其余不动）**

```js
  BG.util = {
    clone: (o) => JSON.parse(JSON.stringify(o)),
    rand: (n) => Math.floor((BG._rng || Math.random)() * n),
    rnd: () => (BG._rng || Math.random)(),
    shuffle(a) {
```

- [ ] **Step 3: 在 board.js 末尾（`BG.eventXY` 定义之后）追加 URL seed 解析**

```js
  /* ?seed=42：复现演示。Node 侧由测试显式 BG.setSeed()，不依赖这里。 */
  if (typeof location !== 'undefined' && location.search) {
    const seedMatch = /[?&]seed=(\d+)/.exec(location.search);
    if (seedMatch) BG.setSeed(parseInt(seedMatch[1], 10));
  }
```

- [ ] **Step 4: 验证 Node 侧可用**

Run: `node -e "globalThis.window=globalThis; globalThis.location={search:'',origin:'http://localhost'}; eval(require('fs').readFileSync('js/board.js','utf8')); BG.setSeed(42); const a=[BG.util.rand(1000),BG.util.rnd()]; BG.setSeed(42); const b=[BG.util.rand(1000),BG.util.rnd()]; console.log(JSON.stringify(a)===JSON.stringify(b), a[0], b[0]);"`
Expected: `true <相同数字> <相同数字>`

- [ ] **Step 5: 提交**

```bash
git add js/board.js
git commit -m "feat(util): BG.util 增加可种子随机（mulberry32 + setSeed/rnd），?seed= 可复现演示；weightedPick 不走 rand，真实渠道不受影响"
```

### Task 14: mock 路径 10 处 Math.random 切换为 BG.util.rnd()

**Files:**
- Modify: `js/mock-ai.js:21,44,45`
- Modify: `js/games/gomoku.js:203`、`js/games/chess.js:354`、`js/games/xiangqi.js:314`、`js/games/checkers.js:271`、`js/games/chinese-checkers.js:268`、`js/games/go.js:272`、`js/games/go.js:280`

- [ ] **Step 1: 逐处把 `Math.random()` 替换为 `BG.util.rnd()`（表达式其余部分不变）**

示例（`js/games/gomoku.js:203`，已核实逐字原文）：

```js
      s: -(Math.abs(mv.r - 7) + Math.abs(mv.c - 7)) + BG.util.rnd() * 3,
```

其余 9 处同样只替换 `Math.random()` → `BG.util.rnd()`（`js/mock-ai.js` 的 3 处分别在合成概率 `chosenP`、合成 `noul`、合成 `score` 三行；6 个引擎各 1–2 处均在 `mockPick` 函数内）。

- [ ] **Step 2: 验证替换完整且不越界**

Run: `grep -rn "Math.random" js/`
Expected: 只剩两处——`js/board.js`（`BG._rng || Math.random` 兜底，2 处）与 `js/jev-client.js:132`（真实渠道 top-k 采样，**必须保留**）。`js/games/` 与 `js/mock-ai.js` 零命中。

- [ ] **Step 3: 运行现有测试确认无回归**

Run: `node test/run-tests.js`
Expected: 「全部测试通过」

- [ ] **Step 4: 提交**

```bash
git add js/mock-ai.js js/games/
git commit -m "refactor(mock): mock 链路 10 处 Math.random 切换为 BG.util.rnd()，使演示与集成测试可种子复现"
```

### Task 15: 集成测试确定性复现断言

**Files:**
- Modify: `test/run-tests.js`（重构 `integration()`：抽出 `playOut(gid)`，同 seed 跑两次断言一致）

- [ ] **Step 1: 将现有 `integration()` 整体替换为以下版本**

```js
/* 集成：mock AI 机机对弈完整一盘；同 seed 两次结果必须完全一致 */
async function playOut(gid) {
  BG.setSeed(42); // 每个棋种从同一 seed 起跑，保证可复现
  const e = globalThis.BG.games[gid];
  let st = e.newGame();
  let plies = 0;
  while (!e.getStatus(st).over && plies < 600) {
    const d = await globalThis.BG.jev.decide(e, st, st.turn, { channel: 'mock', topK: 3 });
    if (!d.move || !e.getLegalMoves(st).some((m) => m.notation === d.move.notation)) {
      throw new Error(gid + ' 第 ' + plies + ' 步返回非法着法 ' + d.notation);
    }
    st = e.applyMove(st, d.move);
    plies++;
  }
  const g = e.getStatus(st);
  if (!g.over) throw new Error(gid + ' ' + plies + ' 步未终局（疑似死循环）');
  return e.name + '：' + plies + ' 步终局，胜者=' + (g.winner || '和') + '，' + g.reason;
}

async function integration() {
  eval(fs.readFileSync(path.join(ROOT, 'js/mock-ai.js'), 'utf8'));
  eval(fs.readFileSync(path.join(ROOT, 'js/jev-client.js'), 'utf8'));
  for (const gid of ['gomoku', 'cc', 'go']) {
    const summary = await playOut(gid);
    results.push('✓ 集成 ' + summary);
    const again = await playOut(gid);
    BG.util.assert(summary === again, gid + ' 同 seed 复现失败：' + summary + ' ≠ ' + again);
    results.push('✓ 复现 ' + gid + '（seed=42 两次一致）');
  }
}
```

- [ ] **Step 2: 运行，确认复现行出现**

Run: `node test/run-tests.js`
Expected: 每个棋种两行输出——`✓ 集成 …` 与 `✓ 复现 <gid>（seed=42 两次一致）`，末尾「全部测试通过」

- [ ] **Step 3: 反向验证断言有效（临时破坏后恢复）**

Run: `node -e "const s=require('fs').readFileSync('test/run-tests.js','utf8'); require('fs').writeFileSync('test/run-tests.js', s.replace('BG.setSeed(42); // 每个棋种从同一 seed 起跑，保证可复现','/* 临时注释掉 seed */'));" && node test/run-tests.js; git checkout -- test/run-tests.js`
Expected: 中间一次运行报 `✗ 集成测试: <gid> 同 seed 复现失败…`（证明断言真实生效），随后工作区恢复

- [ ] **Step 4: 提交**

```bash
git add test/run-tests.js
git commit -m "test: 集成对局增加同 seed 确定性复现断言（seed=42 两次结果必须一致）"
```

### Task 16: 种子化的文档同步

**Files:**
- Modify: `docs/jev-api.md` §6
- Modify: `docs/architecture.md`（BG.util 描述行）
- Modify: `docs/engine-interface.md:86`（修正超前于实现的描述）
- Modify: `AGENTS.md` §5
- Modify: `docs/status.md`
- Modify: `docs/memory/MEMORY.md`（顶部）

- [ ] **Step 1: `docs/jev-api.md` §6 末尾追加**

```markdown

**可复现性**：`BG.util.rand/rnd` 支持种子（`?seed=42` 或 Node 侧 `BG.setSeed(42)`），
仅影响 mock/演示与测试链路；真实渠道的 top-k 采样走 `weightedPick`（不经 rand），保持真随机。
```

- [ ] **Step 2: `docs/architecture.md` 中 `BG.util` 的描述行补充**

将该文件中描述 `BG.util`（clone/shuffle/weightedPick/assert）的那一行改为：

```markdown
| `js/board.js` | 131 | `BG` 命名空间、`BG.util`（clone/rnd/rand/shuffle/weightedPick/assert，rand/rnd 可种子化）、`BG.gfx`（HiDPI canvas、网格/星位/棋子/圆片/文字/高亮）、`BG.eventXY` | ✅ 无 DOM 依赖 |
```

- [ ] **Step 3: `docs/engine-interface.md` §4 第 2 条中“+ 随机补齐”改为与实现一致的说法**

```markdown
2. **Choice 选项 ≤ 255**（Jev 上限）。超出必须预筛：邻近已有棋子 + 按价值排序截断
   （参照 `gomoku.js` 的 `candidates(st, 64)`；当前实现为确定性截断，无随机补齐）。
```

- [ ] **Step 4: `AGENTS.md` §5 末尾追加一条**

```markdown
- 可种子随机：`BG.setSeed(n)` / URL `?seed=42` 使 mock 与测试确定可复现；真实 Jev 渠道不受影响（`weightedPick` 不经 `rand`）。
```

- [ ] **Step 5: `docs/status.md`「技术债 / 注意点」追加一条**

```markdown
- mock 与引擎启发式已全部经 `BG.util.rnd()`（可种子）；`Math.random` 仅剩 `board.js` 兜底与 `jev-client.js` 真实渠道采样两处，属预期。
```

- [ ] **Step 6: `docs/memory/MEMORY.md` 顶部追加**

```markdown
## 2026-09-28 · mock 种子化落地

- `BG.setSeed/rng`（mulberry32，逐字抄 jev-piano rng-shim）+ `BG.util.rnd()`；`?seed=42` 复现演示。
- 替换点共 10 处（mock-ai 3 + 六引擎 7）；`weightedPick` 不经 `rand`，真实渠道自动不受影响——这是无需拆代码路径的天然隔离点。
- 集成测试改为同 seed 两次 playOut 断言一致；`BG_FAST` 现由 run-tests.js 默认设置（`BG_SLOW=1` 可覆盖）。
```

- [ ] **Step 7: 提交**

```bash
git add docs/jev-api.md docs/architecture.md docs/engine-interface.md AGENTS.md docs/status.md docs/memory/MEMORY.md
git commit -m "docs: 同步种子化说明（jev-api/architecture/engine-interface/AGENTS/status/memory）"
```

---

## Phase 4: 文档机制（2 个任务）

### Task 17: 文档卫生检查脚本

**Files:**
- Create: `scripts/check-docs.mjs`

- [ ] **Step 1: 写入脚本（零依赖；.mjs 扩展名使其在无 type:module 的 package.json 下仍是 ESM）**

```js
// scripts/check-docs.mjs — 文档卫生检查（零依赖）
// 1) docs/memory/MEMORY.md 首条日期必须 ≥ 第二条（新条目置顶）
// 2) 所有 markdown 相对链接可解析
// 3) docs/status.md 的「最后更新」不超过 30 天
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const fail = (msg) => { bad++; console.log('✗ ' + msg); };
const ok = (msg) => console.log('✓ ' + msg);

/* 1) memory 置顶 */
const mem = readFileSync(join(ROOT, 'docs/memory/MEMORY.md'), 'utf8');
const dates = [...mem.matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
if (dates.length < 2) fail('MEMORY.md 至少需要 2 条带日期条目');
else if (dates[0] < dates[1]) fail(`MEMORY.md 首条 ${dates[0]} 早于第二条 ${dates[1]}（新条目必须置顶）`);
else ok(`memory 置顶正确（${dates[0]} ≥ ${dates[1]}）`);

/* 2) 相对链接 */
const mdFiles = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.md')) mdFiles.push(p);
  }
})(ROOT);
let links = 0;
for (const f of mdFiles) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/\]\(([^)#]+?)(#[^)]*)?\)/g)) {
    const target = m[1].trim();
    if (/^(https?:|mailto:)/.test(target)) continue;
    links++;
    if (!existsSync(resolve(dirname(f), decodeURIComponent(target)))) {
      fail(`${f.slice(ROOT.length + 1)} 死链: ${target}`);
    }
  }
}
ok(`检查 ${mdFiles.length} 个 md / ${links} 个相对链接`);

/* 3) status 时效 */
const st = readFileSync(join(ROOT, 'docs/status.md'), 'utf8');
const upd = /最后更新：(\d{4}-\d{2}-\d{2})/.exec(st);
if (!upd) fail('docs/status.md 缺少「最后更新：YYYY-MM-DD」');
else {
  const days = (Date.now() - new Date(upd[1] + 'T00:00:00+08:00').getTime()) / 86400000;
  if (days > 30) fail(`docs/status.md 最后更新 ${upd[1]} 已 ${Math.floor(days)} 天`);
  else ok(`status 最后更新 ${upd[1]}（${Math.floor(days)} 天内）`);
}

console.log(bad ? `\n${bad} 项未通过` : '\n全部通过');
process.exit(bad ? 1 : 0);
```

- [ ] **Step 2: 运行**

Run: `npm run check:docs`
Expected: 「全部通过」（三项 ✓）

- [ ] **Step 3: 验证它能抓到违规（临时把 memory 首两条日期对调后恢复）**

Run: `node -e "const fs=require('fs');const p='docs/memory/MEMORY.md';let s=fs.readFileSync(p,'utf8');const m=[...s.matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)];s=s.replace(m[0][0],'## 2099-01-01').replace(m[1][0],'## 2098-01-01');fs.writeFileSync(p,s);" && npm run check:docs; git checkout -- docs/memory/MEMORY.md`
Expected: 中间一次运行退出码 1 且报 `MEMORY.md 首条 ... 早于第二条 ...`，随后恢复

> 注：上面的临时对调写法如与文件实际内容不符导致 check 通过，属验证手法问题而非脚本问题；以脚本对“乱序日期”报错为准，可手工构造最小样例复核。

- [ ] **Step 4: 提交**

```bash
git add scripts/check-docs.mjs
git commit -m "chore: 添加文档卫生检查（memory 置顶/相对链接/status 时效），接入 CI 与 npm run check:docs"
```

### Task 18: AGENTS.md 补充环境要求

**Files:**
- Modify: `AGENTS.md` §4

- [ ] **Step 1: 在「常用命令」代码块之后追加一行**

```markdown
环境要求：Node ≥ 18（跑自检与文档检查）、Python ≥ 3.8（可选，仅 dev-proxy.py 需要）。**无需 npm install**（零依赖）。
```

- [ ] **Step 2: 提交**

```bash
git add AGENTS.md
git commit -m "docs(agents): 补充环境要求（Node≥18 / Python≥3.8，无需 npm install）"
```

---

## Phase 5: 最终验收（编排者执行）

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 六引擎 ✓ + 每棋种「集成 + 复现」两行 + 「全部测试通过」

- [ ] **Step 2: 文档检查**

Run: `npm run check:docs`
Expected: 「全部通过」（三项 ✓）

- [ ] **Step 3: 反模式 grep 验收**

Run:
```bash
grep -n "topK | 1" js/jev-client.js; grep -rn "Math.random" js/games/ js/mock-ai.js; grep -c "rateLimited" functions/api/jev.js; grep -n "eol=lf" .gitattributes; grep -n '"type": "module"' package.json; git status --short
```
Expected: 第 1 条零命中（topK 未被误改）；第 2 条零命中（mock 路径无 Math.random）；第 3 条 ≥2；第 4 条 1 条；第 5 条零命中；第 6 条空输出（工作区干净）

- [ ] **Step 4: CI 验收**

Run: `gh run list --limit 3`
Expected: 最新 run（本计划最后一个 commit）为 success，三个 job step 全绿

- [ ] **Step 5: 推送与记忆归档**

```bash
git push
```

然后在 `docs/memory/MEMORY.md` 顶部追加一条（日期为实施日）：

```markdown
## <实施日> · 仓库硬化完成

- 新增：LICENSE(MIT) / .gitattributes / .editorconfig / package.json(零依赖) / CI / CHANGELOG / scripts/check-docs.mjs。
- 硬化：Pages Function 每 IP 限流（默认 30）；jev-client 与 Pages Function 单测（429/401/回退/422/转发）；mock 种子化（?seed=42）。
- 验收：npm test + npm run check:docs 全绿，CI success；详见 docs/superpowers/plans/2026-09-28-board-games-hardening.md。
```

```bash
git add docs/memory/MEMORY.md
git commit -m "docs: 记忆置顶记录仓库硬化完成"
git push
```

---

## 范围外：独立功能项（各自需要单独计划，不在本计划内）

按 writing-plans 的范围检查，以下每项都是独立子系统，应各自走 brainstorming → make-plan 产出单独计划，本计划只登记关键设计问题：

| 功能 | 关键设计问题 | 建议优先级 |
|---|---|---|
| 移动端响应式 | 面板改单列后 canvas 尺寸策略；触控热区是否放大；`eventXY` 已支持逻辑坐标换算，主要是 CSS | P1 |
| 围棋 13 路 | 候选预筛策略（Choice ≤255）；`serializeForJev` 的 state 体积增长；UI 棋盘尺寸 | P2 |
| 象棋长将/长捉判负 | state 需维护局面历史（JSON 可克隆约束 + token 增长）；判负标准取舍 | P3 |
| 国际象棋三次重复判和 | 同上的局面历史；与现有 perft 自检的衔接 | P3 |
| 中国跳棋堵门变体 | 先查标准规则再决定是否实现 | P4 |
| `app.js` 拆分（~800 行） | 先拆「对局记录/统计」到 `js/records.js`；注意闭包共享的 `S` 状态对象需显式传参；两处加载清单同步 | P2（随功能演进触发） |
