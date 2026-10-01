# 阅读路径：任务 → 最少必读 → 直接下手改哪

> **按表读，不要全量读。** 本仓库的 `src/**` 加测试有上百个文件；下面每一行给出的都是
> 「不做多余阅读也能把这件事改对」的最小集合。
> 通用前置（每次都要读）：[AGENTS.md](../../AGENTS.md) §1–§2 + [../status.md](../status.md) 的「已知限制」。

## 任务矩阵

| # | 任务类型 | 必读 | 直接下手改 |
|---|---|---|---|
| 1 | 修某个棋种的规则/渲染 bug | [../engine-interface.md](../engine-interface.md) + [../status.md](../status.md)「已知限制」 | `src/core/engines/<该引擎>.ts`（渲染在 `draw`/`humanClick` 里） |
| 2 | 新增一个棋种 | [../engine-interface.md](../engine-interface.md) §1/§6 + [playbooks.md](playbooks.md) §1 | 新建 `src/core/engines/<id>.ts`，再按 §6 的 7 步接线（**注册表等公共文件归编排者**） |
| 2b | 移植 / 重写某个纯逻辑模块 | [../architecture.md](../architecture.md) + `src/core/types.ts` | `src/core/**`；差分护栏见 [../../test/parity/README.md](../../test/parity/README.md) |
| 3 | 改 Jev 请求 / prompt / 采样 / 战术注入 | [../jev-api.md](../jev-api.md) §1–§2 | `src/core/jev/client.ts`；五子棋 prompt 在 `src/core/engines/gomoku.ts` 的 `serializeForJev`，战术在 `src/core/tactics.ts` |
| 4 | 加/改渠道或代理 | [../jev-api.md](../jev-api.md) §2/§3 + [ADR-0003](../adr/0003-byok-proxy.md) | 渠道预设 `src/core/jev/client.ts` 的 `CHANNELS`；代理 `src/worker/routes/jev.ts` + `src/worker/lib/upstream.ts` |
| 4b | 改后端 API / 持久化 | [ADR-0010](../adr/0010-worker-static-assets-replaces-pages.md) / [ADR-0011](../adr/0011-d1-authoritative-persistence.md) + [../architecture.md](../architecture.md) | `src/worker/routes/**` + `src/worker/db/**` + `migrations/**`；**错误码↔状态码只有一处**：`src/worker/lib/http.ts` |
| 5 | 改 UI / 交互 / 决策面板 | [../architecture.md](../architecture.md) + `src/ui/README.md`（幂等策略 + DOM 契约） | `src/ui/**` + `src/app/bindings.ts` + `index.html`；样式在 `styles/style.css` |
| 5b | 改对局循环 / 模式切换 / 实验编排 | `src/app/loop.ts` 头注（`epoch` 与 `inflight` 的语义拆分）+ [../architecture.md](../architecture.md) | `src/app/**` |
| 6 | 改成本口径 | [../jev-api.md](../jev-api.md) §4 | `src/core/jev/client.ts` 里按 `usage.input_tokens * 42 / 1e9` 累计的那一行；改完同步 README「成本参考」 |
| 7 | 接手别人没做完的任务 | [handoff.md](handoff.md) + [../memory/MEMORY.md](../memory/MEMORY.md) 最新 3 条 | handoff 里指名的文件（不要顺手改别的） |
| 8 | 审查一个改动 | [roles.md](roles.md) §审查者 + `git diff` | 只写 `.work/review.md` |
| 9 | 排查「非法着法」类 bug | `src/core/jev/client.ts` 里过滤非合法着法的段（不合法就回退 `legal[0]` 并置 `warning`） | 先判断是模型问题还是合法着法集合问题；后者去任务 1 |
| 10 | 写/改文档 | [../README.md](../README.md) + 对应模块的 README | `docs/**`；改完必须 `npm run check:docs` |
| 11 | 动部署 / cron / 环境变量 | `wrangler.jsonc`（含每行的取舍注释）+ [ADR-0010](../adr/0010-worker-static-assets-replaces-pages.md) | `.github/workflows/deploy.yml`（**手动触发**，不随 push 自动部署） |

## 定位技巧（不想读完整个文件时）

- 找引擎注册顺序与 id 清单：`src/core/registry.ts` 的 `games` / `ids`（键顺序即注册顺序）；
  棋种中文名的单一事实源是 `src/shared/record-map.ts` 的 `GAME_NAME_TO_ID`。
- 找「新增棋种要动哪几处」：`grep -rn "gomoku-pro" src test` —— 所有需要同步登记的地方都会露出来。
- 找 Jev 请求长什么样：`grep -rn "serializeForJev" src/core/engines`（每个引擎各一份），
  通用后处理在 `src/core/jev/client.ts` 的 `decide()`。
- 找对局主循环：`src/app/loop.ts`（`aiStep` / 走子 / 悔棋都在这里，`session.epoch` 是并发护栏）。
- 找 API 契约：`src/worker/routes/**` 的路由声明 + `src/worker/lib/http.ts` 的错误码表；
  请求体校验在 `src/worker/lib/validate.ts`，落库映射在 `src/worker/lib/record-input.ts`。
- 找 DOM 契约：`index.html` 的 id ↔ `src/ui/README.md` §4 的表格（两边必须同时改）。
- 找测试入口：`npm test` 的三段（`test/engines/run.mjs` 纯 Node、`vitest --project worker`、ui/core project）。

## 明确不要做的事

- **不要全量读 `src/**`**：先按上表定位，再只读命中文件的头注——本仓库的头注写得比代码还细
  （旧行为 → 新行为的对照表大多在文件头）。
- **不要凭记忆猜旧实现**：`js/**`、`server.js`、`functions/`、`dev-proxy.py`、`legacy.html`、`css/**`
  是**已删除**的旧纯静态实现（2026-10-01 重构收尾时删除，现在只在 git 历史里），活代码只在 `src/**`。
  真要对照旧行为，读 git 历史或 [../plans/2026-10-01-workers-d1-rebuild.md](../plans/2026-10-01-workers-d1-rebuild.md)
  的迁移对照表，**不要去找这些路径**——它们已经不在磁盘上了。
- **不要为了让测试变绿而改测试的期望值**：金样（`test/fixtures/golden/**`）与封条
  （`test/parity/frozen.json`）是冻结物，改它们等于毁掉「新旧零差异」的唯一证据；
  确实要改行为走 [../../test/parity/README.md](../../test/parity/README.md) §7 的例外登记。
