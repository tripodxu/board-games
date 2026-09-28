# 任务 Playbooks

> 常见任务的标准操作流程。每个 playbook：触发条件 → 必读 → 步骤 → 验收 → 文档更新。

## §1 新增一个棋种引擎

- **触发**：要加第七种棋。
- **必读**：engine-interface.md 全文；样板 `js/games/gomoku.js`（方格/交点类)；
  若为跳棋类参照 `js/games/checkers.js`。
- **步骤**：
  1. 复制样板改名为 `js/games/<id>.js`，替换：盘面数据结构、`getLegalMoves`、
     `applyMove`、`getStatus`、`moveFromNotation`、`serializeForJev`、`draw`、`humanClick`。
  2. `BG.register({ id, name, sides, ... })`，实现全部必需方法 + `selfTest()`。
  3. **公共文件交编排者**：`app.js` 的 `GAME_ORDER` 追加 id；`test/run-tests.js` 加载清单追加。
  4. selfTest 按 engine-interface.md §5 清单逐项写（含终局序列）。
- **验收**：`node test/run-tests.js` 全绿（新引擎自检 + 若加入集成对局则跑通终局）；
  浏览器切到新 tab 人机各下一步。
- **文档更新**：README「目录结构/玩法说明」、status.md 模块表 + 已验证 + 已知限制、
  memory 置顶一条（含该棋种的规则取舍）。

## §2 修某个棋种的规则 bug

- **触发**：自检失败 / 对弈中发现非法着法或误判终局。
- **必读**：engine-interface.md §2–3；status.md「已知限制」确认不是已登记的取舍。
- **步骤**：
  1. 在 `selfTest()` 里**先写一个失败断言复现 bug**（红）。
  2. 最小修复引擎逻辑（纯函数，勿动 UI）。
  3. 补边界断言（如"已占点不可再走"式），跑到全绿（绿）。
  4. 若修复揭示了规则取舍（如决定不做某变体），记入 status.md 已知限制。
- **验收**：`node test/run-tests.js` 全绿；`index.html?test=1` 浏览器自检通过。
- **文档更新**：memory 置顶（根因一句话 + 修复位置）；status.md 若影响限制清单。

## §3 调整 Jev prompt / state 序列化 / 采样

- **触发**：棋力不佳、token 超标、想改随机度行为。
- **必读**：jev-api.md；ADR-0002。
- **步骤**：
  1. 只动目标引擎的 `serializeForJev`（或 `jev-client.js` 的采样段）。
  2. 保持三问并行结构不变；选项仍 ≤255；state 仍英文。
  3. 用 mock 渠道验证全链路不死循环（集成对局覆盖 gomoku/cc/go；新引擎需临时加入）。
  4. 真实渠道改动：记录一次真实请求的 `latencyMs` 与 `usage.input_tokens`。
- **验收**：`node test/run-tests.js` 全绿；附成本/延迟前后对比。
- **文档更新**：jev-api.md（契约/成本若变）、memory 置顶（含实测数字）。

## §4 改 UI / 交互 / 决策面板

- **触发**：新控件、布局调整、图表变更。
- **必读**：architecture.md §2–3；grep 定位 `app.js` 目标函数（勿通读）。
- **步骤**：改 `index.html`/`css/style.css`/`js/app.js`（或 `charts.js`）；
  保留 `epoch` 防护与 `?test=1` 入口；设置项加进 `loadSettings/saveSettings`。
- **验收**：`python dev-proxy.py` 后浏览器手工验证三种模式各一步；
  `node test/run-tests.js` 不回归。
- **文档更新**：README 玩法说明（用户可见变化）、memory 置顶。

## §5 部署 / 代理变更

- **触发**：改 CF Pages Function、本地代理、部署文档。
- **必读**：jev-api.md §2–3；ADR-0003。
- **步骤**：改 `functions/api/jev.js` 或 `dev-proxy.py`；坚持 BYOK（不落 key、只认请求头）。
- **验收**：本地 `python dev-proxy.py` + 页面切「同源代理」真实走一步；
  Functions 用 `npx wrangler pages dev .` 验证。
- **文档更新**：README「快速开始」、memory 置顶。

## §6 发版 / 推送

- **触发**：一批任务完成，要 push 到远端。
- **步骤**：
  1. `node test/run-tests.js` 全绿（编排者执行）。
  2. 检查 `git status` 无 `.work/`、密钥、`__pycache__` 等误入（`.gitignore` 已覆盖）。
  3. Conventional Commits 逐个提交；`git push`。
  4. push 后在 memory 置顶一条记录本次推送内容与远端状态。
