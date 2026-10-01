# 角色卡

> 每个角色卡 = **能改什么** + **必读什么** + **禁止什么** + **验收命令**。
> 并行开工前先按 [parallel-work.md](parallel-work.md) §1 划所有权；同一文件同一时刻只能有一个 owner。
> 公共文件（注册表、入口、文档）默认归编排者，实现者需要时写进 handoff 让编排者代改。

## 编排者 orchestrator

**职责**：拆任务、判协作形态、发所有权表、收口验收。**不写业务代码**（这是所有权仲裁有唯一裁决人的前提）。

- 可改：`docs/**`、`.work/**`（git 忽略，不入库）、`AGENTS.md`、`.gitignore`、`README.md`、
  以及被显式划为「公共文件」的代码（见下）。
- 公共文件（默认只有编排者能改）：`src/core/registry.ts`（引擎注册表）、`src/main.ts`（浏览器入口）、
  `src/shared/record-map.ts`（棋种 id ↔ 中文名映射）、`src/ui/panels/openings.ts` 的 `GAME_IDS`、
  `test/engines/run.mjs` 的用例清单、`test/fixtures/golden/**` 与 `test/parity/frozen.json`（**冻结只读**）。
- 必读：`AGENTS.md` → [../status.md](../status.md) → 本次任务涉及模块的阅读路径。
- 禁止：直接实现业务功能；为了让红变绿而放宽金样封条或跳过验收；在别人 owner 的文件上「顺手修一下」。
- 验收：`npm test` 全绿 + `npm run check:docs` 全绿 + `npm run typecheck` 通过，
  且改了行为时 [../status.md](../status.md) 与 [../memory/MEMORY.md](../memory/MEMORY.md) 已同步。

## 引擎实现者 engine-dev

**职责**：一个棋种一个 owner——规则、着法生成、裁判、`serializeForJev`、`selfTest`。

- 可改：`src/core/engines/<你的引擎>.ts`、`test/engines/<你的引擎>*.test.mjs`、
  `test/fixtures/golden/<你的引擎>.json`（**只在登记例外后**，且必须由编排者复核）。
- 必读：[../engine-interface.md](../engine-interface.md) → [playbooks.md](playbooks.md) §1/§2 →
  样板 `src/core/engines/gomoku.ts`（跳棋类读 `src/core/engines/checkers.ts` 与 `chinese-checkers.ts`）。
- 禁止：改 `src/ui/**`、`src/app/**`、`src/worker/**`；改 `src/core/types.ts` 的公共契约
  （需要时写 handoff）；直接改金样文件来「修复」差分失败。
- 验收：`npm run test:engines`（七个引擎自检 + 你那一棋种的金样逐手差分）+ `npm run typecheck`。
  新棋种还要按 [../engine-interface.md](../engine-interface.md) §6 走完注册等 7 步。

## Jev 集成者 jev-dev

**职责**：渠道、鉴权、提示词、战术注入、采样、成本口径。

- 可改：`src/core/jev/**`（`client.ts` / `mock.ts` / `rapfi.ts` / `index.ts`）、
  `src/core/tactics.ts`、`src/core/tactics-versions.ts`、`src/core/api/client.ts`、
  `src/worker/routes/jev.ts`、`src/worker/lib/upstream.ts`、`test/worker/jev.spec.ts`、
  `test/engines/jev.test.mjs`、`test/engines/rapfi.test.mjs`。
- 必读：[../jev-api.md](../jev-api.md) + [ADR-0002](../adr/0002-coordinate-notation-state.md) /
  [ADR-0003](../adr/0003-byok-proxy.md) / [ADR-0013](../adr/0013-anonymous-device-identity-and-d1-ratelimit.md)。
- 禁止：破坏 **BYOK**（key 只允许出现在 localStorage / 请求头 / 服务端环境变量，绝不入库、入日志、入 URL）；
  把三问并行拆成串联请求；让 Worker 侧做重试（一次点击变 N 次上游计费）。
- 验收：`npm run test:worker`（`/api/jev` 的 401/400/429/502 路径）+ `npm run test:engines`（战术层）。

## UI 开发者 ui-dev

**职责**：视图层——DOM/canvas 绘制、面板、图表、幂等重建与事件绑定。

- 可改：`src/ui/**`（含 `panels/**`、`charts.ts`、`board-render.ts`、`dom.ts`）、
  `test/ui/**`、`index.html` 的结构与 id 约定，以及样式表
  （**当前在 `styles/style.css`**，由 `index.html:11` 引入，Vite 打包；
  布局契约 `test/ui/layout-css.spec.ts` 会探测 `styles/` 与 `css/` 两个目录，
  但旧的 `css/` 已随重构删除，实际只会命中 `styles/`。继续拆分子样式表也无需改测试）。
- 必读：[../architecture.md](../architecture.md) → `src/ui/README.md`（模块职责、幂等策略、DOM 契约）→
  [playbooks.md](playbooks.md) §4。
- 禁止：改引擎与纯逻辑（`src/core/**`）；破坏 DOM 契约里的 id（`src/ui/README.md` §4 是与
  `index.html` 的接口）；把 `init-*` 绑定写成每次渲染都重绑（会叠加监听器）。
- 验收：`npm run test:ui` + `npm run typecheck`；
  UI 改动同时跑 `npm run smoke:browser` 更稳（真 Chrome over CDP）。

## 应用装配者 app-dev

**职责**：把引擎、UI、Jev、战绩簿接起来——对局循环、时钟、模式切换、对比实验、自检面板。

- 可改：`src/app/**`、`src/core/session.ts`、`src/core/persist.ts`、
  `src/core/record/{export,book,sync}.ts`、`src/core/view/**`、`test/core/**`（与纯逻辑有关的部分）。
- 必读：`src/app/loop.ts` 头注（epoch / inflight 的语义拆分）+ [../architecture.md](../architecture.md)。
- 禁止：绕开 `session.epoch` 做「换局后仍会回调」的定时器；在 UI 层直接调引擎；
  让「无后端降级」抛异常（`src/core/api/client.ts` 失败一律返回 `null`）。
- 验收：`npm run test:ui`（`vitest.config.ts` 的 ui project 同时收 `test/app/**`）+ `npm run typecheck`。

## Worker 开发者 worker-dev

**职责**：API 契约、D1 schema 与查询、限流、设备标识、cron 维护。

- 可改：`src/worker/**`、`migrations/**`、`test/worker/**`、`scripts/{import-archive,verify-parity,verify-backup,smoke-live}.mjs`。
- 必读：[../architecture.md](../architecture.md) → [ADR-0010](../adr/0010-worker-static-assets-replaces-pages.md) /
  [ADR-0011](../adr/0011-d1-authoritative-persistence.md) /
  [ADR-0013](../adr/0013-anonymous-device-identity-and-d1-ratelimit.md) → `src/worker/lib/http.ts`（错误码 ↔ 状态码）。
- 禁止：让 `/api/*` 的未命中回落到 SPA 兜底（必须 JSON 404）；改 `migrations/0001_init.sql` 的既有列
  （已上线的 schema 只能追加迁移）；把 payload 上限放宽到 512 KB 以上（D1 单行 2 MB 硬限）。
- 验收：`npm run test:worker` + `npm run typecheck`；
  动 schema 时本地 `npm run db:migrate:local` + `npm run import:archive -- --local` + `npm run verify:parity`。

## 审查者 reviewer

**职责**：只读审查，**只写** `.work/review.md`（不入库）。不修代码——发现问题写进报告与 handoff。

审查清单：

1. 是否违反 [AGENTS.md](../../AGENTS.md) §2 的硬性规则（尤其**不引 UI 框架**、`src/core` 无 DOM 依赖、
   引擎纯函数不改入参 state）。
2. 是否违反 BYOK：新增代码里有没有把 key 写进日志、URL、仓库或服务端存储。
3. 验收命令**是否真跑过**（`npm test` / `npm run check:docs` / 相关 `test:*`），
   以及报告里的结论是否与磁盘现状一致——不接受「应该能过」。
4. 文档是否同步：改行为 → [../status.md](../status.md)；踩坑/决策 → [../memory/MEMORY.md](../memory/MEMORY.md) 顶部；
   结构性决策 → 新 ADR。
5. 是否夹带无关改动（一次 commit 只做一件事）；是否触碰了别人 owner 的文件。
6. 是否改动了冻结物（`test/fixtures/golden/**`、`test/parity/frozen.json`）或悄悄放宽了断言。
