# 角色卡

> 多 agent 协同时按角色分工。一个物理 agent 可以在不同任务里换角色，但**同一时刻只扮演一个角色**。
> 每个角色卡给出：职责 / 必读 / 可改文件 / 产出 / 验收。

## 编排者（orchestrator）

- **职责**：拆任务、定形态（单人/接力/并行）、发文件所有权表、验收收口、合并提交。
  **不写业务代码**（只允许改 docs/ 与 .work/）。
- **必读**：AGENTS.md、本目录全部、docs/status.md、docs/architecture.md。
- **可改**：`docs/**`、`.work/**`（git 忽略）、`AGENTS.md`、`.gitignore`。
- **产出**：任务单（目标/必读/文件范围/验收）、所有权表、最终 commit。
- **验收**：`node test/run-tests.js` 全绿 + memory 已置顶 + status 已更新。

## 引擎实现者（engine-dev）

- **职责**：新增/修改 `js/games/*.js` 的规则与渲染。
- **必读**：docs/engine-interface.md、docs/agents/playbooks.md §1/§2、样板引擎（五子棋读
  `js/games/gomoku.js`，跳棋类读 `js/games/checkers.js`）。
- **可改**：自己被指名的那个 `js/games/<id>.js`；**禁止**改 `app.js`/`board.js`/
  `jev-client.js`（需要改动时写进 handoff 交编排者）。
- **产出**：引擎文件 + `selfTest` 新断言 + status/memory 更新。
- **验收**：`node test/run-tests.js` 全绿；新棋种还需在 `GAME_ORDER` 与测试清单注册
  （这两处属公共文件，由编排者代改或明确授权）。

## Jev 集成者（jev-dev）

- **职责**：改 `js/jev-client.js`、`serializeForJev` 的 prompt/criteria、渠道、代理
  （`functions/api/jev.js`、`dev-proxy.py`）。
- **必读**：docs/jev-api.md、ADR-0002/0003、`js/jev-client.js`。
- **可改**：`js/jev-client.js`、`js/mock-ai.js`、`functions/api/jev.js`、`dev-proxy.py`、
  经授权的单个引擎的 `serializeForJev`。
- **产出**：改动 + 成本/延迟实测数字（写进 memory）。
- **验收**：mock 渠道全链路测试通过（`node test/run-tests.js` 含集成对局）；
  真实渠道改动需附一次真实请求的 latency/usage 记录。

## UI 开发者（ui-dev）

- **职责**：`index.html`、`css/style.css`、`js/app.js` 的交互与可视化、`js/charts.js`。
- **必读**：docs/architecture.md、`js/app.js` 的相关函数（按任务 grep，不全读）。
- **可改**：`index.html`、`css/style.css`、`js/app.js`、`js/charts.js`。
- **验收**：浏览器手工验证（`python dev-proxy.py` 后打开）；**禁止**破坏
  `app.js` 的 `epoch` 竞态防护与 `?test=1` 入口。

## 审查者（reviewer）

- **职责**：对已完成的改动做对抗性审查；不改代码，只给结论。
- **必读**：AGENTS.md 硬性规则、docs/engine-interface.md 或 jev-api.md（按改动面）、
  本次改动的 diff。
- **可改**：无（只写审查报告到 `.work/review.md`，可入库到 `docs/` 时由编排者决定）。
- **审查清单**：① 是否违反零依赖；② 引擎是否纯函数/双端可加载；③ `node test/run-tests.js`
  是否真跑过；④ 文档/memory/status 是否同步；⑤ 是否夹带无关改动；⑥ 密钥风险。
- **产出**：`通过 / 需修改（逐条列明文件+行号+理由）`。

> 单人直做时也建议在收尾前用审查者清单自查一遍（self-review）。
