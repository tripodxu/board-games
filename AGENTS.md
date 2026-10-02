# AGENTS.md — 给所有协作 Agent 的入口规范

> 本文件是**任何 agent 进入本仓库后的第一份读物**。目标：让每个 agent 用最小阅读量
> 搞清楚「能改什么、怎么验、写完更新什么」，**不需要全量阅读项目**。
> 人类 Contributor 同样适用。详细协同协议见 [docs/agents/](docs/agents/README.md)。

> **2026-10-01 完成 Cloudflare Worker + D1 + Vite/TypeScript 重构**：旧纯静态实现
> （`js/`、`functions/`、`legacy.html`、`server.js`、`dev-proxy.py`、`css/`）**已全部删除**，
> 样式迁到 `styles/style.css`。历史决策见 [ADR-0001](docs/adr/0001-pure-static-no-build.md)、
> [0005](docs/adr/0005-zero-dep-node-backend.md)、[0006](docs/adr/0006-rapfi-wasm-opponent.md)
> （三篇均已被取代）与本轮 [ADR-0010](docs/adr/0010-worker-static-assets-replaces-pages.md)–[0013](docs/adr/0013-anonymous-device-identity-and-d1-ratelimit.md)；
> 迁移过程与实测数字见 [docs/plans/2026-10-01-workers-d1-rebuild.md](docs/plans/2026-10-01-workers-d1-rebuild.md)。

---

## 1. 项目一句话

原生 DOM + TypeScript 的七棋种对弈站（五子棋 / 五子棋·禁手 / 围棋 9 路 / 象棋 / 国际象棋 / 西洋跳棋 / 中国跳棋），
由 TypeSafe「系统一模型」Jev 走子，另有 Rapfi WASM 本地引擎渠道与离线演示渠道。
**前端零框架**（无 React/Vue/Svelte，Vite 只做构建与开发服务器），后端是**单个 Cloudflare Worker**
（[Hono](https://hono.dev/) + D1 + Workers Static Assets），静态资产与 `/api/*` 同源同域，
部署形态见 [ADR-0010](docs/adr/0010-worker-static-assets-replaces-pages.md)。

- **本地开发**：`npm run dev` 一条命令起「Vite + 本地 workerd + 本地 D1」→ `http://localhost:8787`。
- **数据**：D1（`jev-qiguan`）是唯一权威持久化（[ADR-0011](docs/adr/0011-d1-authoritative-persistence.md)）；
  仓库里的 `games/**` 与 `data/experiments.json` 是**已冻结只读的历史归档**，只供金样与对账。
- **离线降级仍在，但形态变了**：没有后端时页面照常开局，走**离线演示渠道**（`mock`，本地启发式走子），
  战绩写进浏览器 localStorage 的**战绩簿**（键 `jev_qiguan_records_v1`，留最近 60 条）——
  校准实验室、先手胜率、开具体验注入全靠它。**`file://` 双击即玩已放弃**（ADR-0010 决策 D8），
  离线指的是「不打 `/api/*`」，不是「不经过 HTTP 服务器」。

## 2. 硬性规则（不可协商）

1. **不引 UI 框架**：没有 React/Vue/Svelte，视图就是模块化 TS + 原生 DOM（`src/ui/**` 只接收 props）。
   构建链本身是允许的——[ADR-0012](docs/adr/0012-vite-typescript-build-chain.md) 定下 Vite + TypeScript，
   旧「零构建」教条已退役。
2. **不新增运行时依赖**：`hono` 是**唯一**的 `dependencies` 条目。前端、`src/core/**`、脚本一律零依赖；
   要引依赖先在 commit message 里说明理由，否则用标准库解决。
3. **`src/core/**` 与 `src/ui/**` 不许直接碰 IO**：不 `import 'node:*'`、不直接 `fetch` / 读写 `localStorage` /
   碰 DOM——存储走注入的 `StorageLike`，网络走 `src/core/api/client.ts` 或渠道客户端的 `fetch` 参数。
4. **内核必须能被纯 Node 直接加载**：`src/core/**` 只用**可擦除语法**（`erasableSyntaxOnly`：禁 `enum` /
   `namespace` / 构造函数参数属性），这样 `node test/engines/run.mjs`、`test/tactics/run.mjs` 才能不带构建
   直接 import `.ts`。引擎与 UI 解耦，DOM/canvas 只出现在 `src/ui/**` 与 `src/app/**`。
5. **每个引擎必须实现统一接口并带 `selfTest()`**（契约见
   [docs/engine-interface.md](docs/engine-interface.md)）。新棋种未过自检 = 未完成。
6. **改完必须验证**：`npm test` 全绿 + `npm run typecheck` 干净，才允许声称"完成"。
   只改了单个引擎时也要跑全量（引擎间共享注册表与战术层状态）。
7. **密钥永不入仓库、不进日志、不进 URL**：API key 只进浏览器 localStorage / 请求头（`Authorization`）
   / 服务端环境变量（`wrangler secret`）；BYOK 转发在 `src/worker/routes/jev.ts`，key 只在请求头里过一手。
   发现误提交的 key 立即删除并轮换。
8. **Jev 请求保持"一次并行多问"结构**：`move`(choice) + `edge`(noul) + `position`(score) 三问一次发出，
   不要拆成串联推理链（Jev 的设计原则，见 [docs/jev-api.md](docs/jev-api.md)）。
9. **文档随代码更新**：改行为 → 更新 `docs/status.md`；踩坑/决策 → 在
   [docs/memory/MEMORY.md](docs/memory/MEMORY.md) **顶部**追加条目；结构性决策 → 补一篇 ADR。
10. **战术层「不吃搜索」（2026-10-02 项目所有者定，先于一切棋力优化）**：战术/策略类补丁优先走
    「一眼看得懂的简单规则 + 快而不依赖长思考」，**不往深搜 / 大节点预算 / 强评估函数的方向加码**——
    那个方向即便能提胜率也不做：本项目的立意是「大模型出主意 + 一层确定性保险」，
    不是再写一个传统搜索引擎。要动已有搜索层，只做**减法或纠偏**（收紧预算、修语义偏差），不做加深；
    新机制上线前先能回答两问：规则能否一句话说清、单步成本量级是否远小于一次 Jev 调用。
    背景与两次否证复盘见 [docs/memory/MEMORY.md](docs/memory/MEMORY.md) 置顶约束、
    [docs/plans/2026-10-02-tactics-v11-vct.md](docs/plans/2026-10-02-tactics-v11-vct.md) §7。
11. **不唯胜率（同日定）**：对照实验一律同时报 **胜 / 和 / 负** 与**不败率**，并单独交代**败局是怎么输的**；
    **和棋是可以接受、有时应该追求的结果**——「把和棋变成胜局」不算默认功绩，「负局不增加」才是及格线。
    评估改动先问「这会不会让局面更容易输」，而不是「能不能多赢一局」。

## 3. 最小阅读路径（不要全量阅读）

| 任务类型 | 必读 | 代码 |
|---|---|---|
| 修某个棋种的规则 bug | engine-interface.md + status.md「已知限制」 | 只读 `src/core/engines/<该引擎>.ts` |
| 新增一个棋种 | engine-interface.md + agents/playbooks.md §1 | 参照 `src/core/engines/gomoku.ts` 模板 + `src/core/registry.ts` 注册 |
| 改 Jev 调用 / prompt / 渠道 | jev-api.md | `src/core/jev/client.ts` + `src/worker/routes/jev.ts`（BYOK 转发） |
| 改 UI / 交互 / 决策面板 | architecture.md §2.3 | `src/app/bindings.ts` + `src/ui/panels/**` + `src/ui/dom.ts` |
| 改后端 / API / 持久化 | ADR-0011 + architecture.md §3–§4 | `src/worker/routes/**` + `src/worker/db/**` + `migrations/**`（动契约要同步 `src/core/types.ts` 与 `src/shared/record-map.ts`） |
| 改数据模型 / 归档字段 | migrations/0001_init.sql + architecture.md §4 | `src/shared/record-map.ts` + `src/worker/lib/record-input.ts`（**两处口径必须一致**） |
| 改样式 / 页面外壳 | architecture.md §2.1 | `index.html` + `styles/style.css` |
| 改部署 / 代理 / 定时任务 | architecture.md §7 + wrangler.jsonc | `.github/workflows/**` + `src/worker/maintenance.ts` |
| 改测试 | architecture.md §6 + test/parity/README.md | 各 `test/**` 分层（引擎纯 Node / worker 真 D1 / ui+app happy-dom） |
| 接手别人没做完的任务 | agents/handoff.md + memory 最新 3 条 | handoff 里指名的文件 |

完整任务→阅读矩阵见 [docs/agents/reading-paths.md](docs/agents/reading-paths.md)。

## 4. 常用命令

```bash
npm run dev                     # vite dev：单进程起 Worker + 前端 + 本地 D1 绑定 → http://localhost:8787（端口被占会自动顺延，看启动日志）
npm test                        # 唯一验收命令：test:engines（src/core 自检 + 战术 + 金样逐手差分）→ test:new（vitest 全 project）
npm run typecheck               # tsc --noEmit（提交前必须干净）
npm run test:engines            # 只跑纯 Node 层：七引擎 selfTest + 战术十一级与 VCF + 金样逐手差分（7 局自对弈 + games/ 归档 54 局）
npm run test:tactics            # 只跑战术层回归（node test/tactics/run.mjs）
npm run test:new                # vitest 全部 project；也可细分 test:worker（真 workerd + 真 D1）/ test:ui（happy-dom）
npm run check:docs              # 文档自检：memory 置顶、md 相对链接可解析、status 时效
npm run db:migrate:local        # 本地 D1 应用 migrations/（npm run dev 的 predev 会自动跑）
npm run import:archive -- --local   # 把 54 局历史归档导入本地 D1（--remote 打线上，慎用）
npm run db:export               # 线上 D1 全量导出到 backups/export.sql（备份第一步）
npm run verify:backup           # 校验备份能否重建出可信的库（CI 用 --structural 档）
npm run build                   # vite build（静态资产 + Worker 包一起出）
npm run deploy                  # = build + wrangler deploy（需 CLOUDFLARE_API_TOKEN；线上域 https://jevqipan.logicc.top）
npm run smoke:live              # 线上 HTTP 冒烟（可 --url 换目标；需要网络，未授权时别跑）
npm run smoke:browser           # 真浏览器端到端冒烟（CDP + 系统 Chrome/Edge，零依赖；--url/--channel/--headful/--offline）
npm run golden                  # 重新生成金样：**已冻结**，旧实现删除后该命令只打印中文说明并 exit 1（属预期）
npm run cf-typegen              # 重新生成 worker-configuration.d.ts（改 wrangler.jsonc 后跑）
```

本地 D1 的库文件名由 `wrangler.jsonc` 里的 `database_id` 派生（`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`）：
**换过 `database_id`（例如把占位 UUID 换成真实 id）后，`npm run dev` 会指向一个新的空库**，`/api/games` 会 500
（`no such table: games`）而旧数据仍躺在旧文件里。此时重跑 `npm run db:migrate:local` +
`npm run import:archive -- --local`，并删掉旧 hash 的 `.sqlite`（否则 `verify:parity` 自动挑
mtime 最新的库时可能落到旧的那份）。`vite dev` 与 `wrangler d1 execute --local` 用的是同一个库。
`npm run dev` 带 `predev` 钩子会自动跑 `db:migrate:local`（只建表，不导数据）；本地要看到 54 局归档
得手动跑一次 `npm run import:archive -- --local`。

环境要求：Node ≥ 22.18（**类型剥离直载 `.ts`** 是纯 Node 测试层的前提）、npm。
`compatibility_date` 停在 `2026-08-22` 是**刻意的**：vitest 用的 workerd 只认到这天，上调会让
`test:worker` 起不来。

**文档自检**：改完任何 `.md`（尤其 `docs/**`、`AGENTS.md`）跑一次 `npm run check:docs`，
它查四件事——`docs/memory/MEMORY.md` 新条目是否置顶、所有 md 的相对链接是否还能解析、
**链接是否指向被 `.gitignore` 忽略的产物**（如 `backups/export.sql`：本机有、CI 没有 → 本地绿 CI 红）、
`docs/status.md` 的「最后更新」是否在 30 天内。**删除或重命名文件后忘了改链接，它会直接红。**
注意它只校验相对链接，**不校验行内代码里的路径**（行内代码里的 `[x](../y)` 也不算链接）——
所以正文里提到的路径要自己保证真实存在。

## 5. 代码约定速查

- **没有全局命名空间**：旧实现的 `globalThis.BG.*`（`BG.games` / `BG.jev` / `BG.api` / `BG.mock` / `BG.rapfi`）
  已随旧实现一起删除。现在**模块导入即用**：`import { getGame } from '../core/registry.ts'`；
  浏览器里的入口只有 `src/main.ts` → `boot()`，没有挂到 `window` 的单例。
- **`AppCtx`**（`src/app/ctx.ts`）：装配层的共享上下文，取代旧闭包的 `S`。它持有**运行时句柄**
  （`engine` / `renderer` / `abortController` / `inflight` / 各类定时器 / `sync` 队列 / `backend` 状态 /
  `exp` 状态 / 战绩簿缓存），由 `loop` / `modes` / `panels` / `experiment` / `bindings` 共同读写，
  **显式传参、不做隐式全局**（测试里可以造第二个 ctx）。侧位工具函数都在这里：`sideSlotOf` / `effFor` / `setSideCfg`。
- **`GameSession`**（`src/core/session.ts`）：对局**数据面**（棋种、双方、手数、`epoch`、`settings` 引用、
  `startedAt` / `endedAt` / `result` / `gameUid`）。纯数据、JSON 可克隆，**不放运行时句柄与 DOM**——
  所以导出（`buildGameExport`）能直接吃它、能被单测覆盖。改玩法逻辑前先想清楚该动 ctx 还是 session。
- **`gameUid` 与 `dedup_key`**（幂等写入的两个键）：`gameUid` 由前端 `randomUUID()` 在开局时生成、
  随 payload 上报；老客户端没带时服务端合成 `sha1(exported|notation)` 前 16 位。
  `dedup_key` 一律是 `sha1(exported|gameUid|notation)`（`src/shared/record-map.ts` 的 `dedupSource`）。
  两列都是 UNIQUE，落库用 `ON CONFLICT DO NOTHING`，命中既有行时先按 `dedup_key` 找、再退到 `game_uid`
  （重传可能换了导出时间戳）。**同一局无论走 `/api/games` 还是导入脚本，都必须算出同一对键**。
- **`code_version` 与 `tactics_version`**：前者是 `APP_VERSION+BUILD_SHA`（`vite.config.ts` 构建期注入到
  `src/shared/version.ts`，Node 直载时回落 `dev`/`nogit`），记在每局 meta 里做版本归因；
  后者是战术档版本号（`src/core/tactics-versions.ts` 的闸门 + 每手 `ai.tv`），
  **改动战术层就要同步版本表**，否则历史棋谱的战术归因会对不上。
- **渠道与降级**：`src/core/jev/client.ts` 的 `CHANNELS` = `official`（TypeSafe 官方）/ `openrouter`
  / `proxy`（同源 `api/jev` BYOK 转发，key 只在请求头里过一手）；另有 `rapfi`（WASM 本地引擎）、
  `mock`（离线演示）、`random`（基线，刻意走战术层）。无 key / 无后端时**降级而不是报错**：
  走 mock 或 Rapfi + 战绩簿，`src/core/api/client.ts` 里所有后端调用失败一律返回 `null` 由装配层接手。
- **`X-Device-Id`**：没有账号体系。浏览器生成匿名设备 id 并带在请求头里（格式非法 → 400），
  只用于「我的局」与榜单分组，**不是安全边界**。写路由先 `touchDevice` 再写棋谱（外键要求）；
  读接口**刻意不 upsert**（会白烧 D1 的每日写配额）。详见 [ADR-0013](docs/adr/0013-anonymous-device-identity-and-d1-ratelimit.md)。
- **引擎 move 对象**：`{ notation, desc, ...私有字段 }`，`notation` 是 Jev Choice 选项的键，必须唯一且稳定。
- **state 一律 JSON 可克隆**（`src/core/clone.ts` 深拷贝），不放函数/DOM 引用。
- **Jev 的 `state` 与 `instructions` 一律英文**（官方口径：中文精度较低），坐标记法，见 ADR-0002。
- **注释、文档、commit message 用中文；代码标识符用英文。**
- **可复现随机**：`src/core/rng.ts` 的 `setSeed(n)` / `getSeed()` 让 mock 与引擎测试确定可复现
  （测试层统一 `setSeed(42)`，金样就是这么生成的）；**真实 Jev 渠道不受 seed 影响**——
  `weightedPick`（`src/core/weighted.ts`）刻意不过 `rand()`，改这一点会让渠道行为与旧实现分叉。
  浏览器侧目前**没有** `?seed=` 入口（旧的 URL 种子已随旧实现退役）。

## 6. 提交规范

Conventional Commits，scope 用引擎 id 或模块名：

```
feat(gomoku): 禁手提醒
fix(chess): 王翼易位后王车初始位标记未清除
docs(agents): 新增接力协议
chore: 初始化仓库与文档体系
```

一个 commit 只做一件事；跨多文件的行为变更必须带 `docs/` 更新。

## 7. 多 Agent 协作速查

- **接力**：按 [docs/agents/handoff.md](docs/agents/handoff.md) 写 `.work/handoff.md`（不入库），
  下一个 agent 从 handoff + memory 最新条目恢复上下文，禁止从头全量读代码。
- **并行**：按 [docs/agents/parallel-work.md](docs/agents/parallel-work.md) 划分文件所有权，
  两个 agent 不得同时改同一文件。**公共/共享文件默认归编排者独占**：`index.html`、`styles/**`、
  `src/main.ts`、`package.json`、`vite.config.ts`、`tsconfig.json`、`.github/**`——
  子代理动它们之前必须拿到明确授权。**公共契约**（改了要通知所有人）：
  `src/shared/record-map.ts` + `src/core/types.ts`。
- **角色**：见 [docs/agents/roles.md](docs/agents/roles.md)。
