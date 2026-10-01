# Jev 棋馆 · 七种棋类对弈

七种棋类对弈站（五子棋 / 五子棋·禁手 / 围棋 9 路 / 象棋 / 国际象棋 / 西洋跳棋 / 中国跳棋），
由 TypeSafe「系统一模型」[Jev](https://typesafe.ai) 走子，另有 Rapfi WASM 本地引擎渠道。
**浏览器端 Vite + TypeScript（零 UI 框架，无 React/Vue/Svelte）**，
**服务端一个 Cloudflare Worker + D1**（棋谱与实验归档、跨对局统计、排行榜、开具体验、JSONL 导出）。
无后端时自动降级：对局照常，战绩簿落 localStorage。密钥（BYOK）只存在你自己的浏览器里。

迁移背景见 [docs/plans/2026-10-01-workers-d1-rebuild.md](docs/plans/2026-10-01-workers-d1-rebuild.md)
与 [ADR-0010](docs/adr/0010-worker-static-assets-replaces-pages.md)–[ADR-0013](docs/adr/0013-anonymous-device-identity-and-d1-ratelimit.md)：
本站原先是一个「原生 HTML/JS 零构建静态站 + 三套后端（`server.js` / Pages Functions / `dev-proxy.py`）
+ 用 GitHub 当数据库」的实现，2026-10-01 起重构为现在这套架构。

## 在线地址与后端实体

| 地址 | 说明 |
|---|---|
| **https://jevqipan.logicc.top** | 现行站点（Cloudflare Worker `jev-qiguan` + D1，自定义域；`*.workers.dev` **未启用**，只有这个域能访问） |
| https://jev-qiguan.pages.dev | **迁移前的只读旧站**（Cloudflare Pages 静态托管，保留作回退；已断开 Git 集成、不再接收 push 部署、不再写入数据） |

后端实体（改配置 / 排障时对照）：

| 实体 | 值 |
|---|---|
| Worker | `jev-qiguan`（`wrangler.jsonc` 的 `name`；静态资产与 `/api/*` 同源同域） |
| D1 数据库 | `jev-qiguan`，id `f72390fe-a506-4a88-8db7-af7213657947`（**唯一权威持久化**，ADR-0011） |
| 定时任务 | cron `17 3 * * *` → `runDailyMaintenance()`：清过期限流行、聚合五张表、写 `stats_cache`（key `daily:<UTC 日>`） |
| 版本 | `package.json` 与 `wrangler.jsonc` 的 `APP_VERSION` **必须一致**（现均 `1.0.0`，`test/core/version.spec.ts` 守）；前端 `CODE_VERSION = APP_VERSION+BUILD_SHA` 由 `vite.config.ts` 构建期注入 |

## 架构一页纸

```
浏览器（原生 DOM + TS，零 UI 框架）
  index.html ── 唯一 <script type="module"> → src/main.ts → boot()
  src/ui/**   无状态面板（只吃 props，渲染时覆写 root.className）
  src/core/** 纯逻辑：七引擎 / Jev 客户端 / 战术 / 会话 / 棋谱导出（可被纯 Node 直载）
  src/app/**  唯一的装配层（AppCtx）
        │  fetch /api/*（失败一律返回 null ⇒ 降级，不抛）
        ▼
单个 Cloudflare Worker（Hono）+ Workers Static Assets + D1
  src/worker/routes/**   8 个路由：/health /games /stats /experiments /openings /leaderboard /jev /export
  src/worker/middleware/ device（匿名 X-Device-Id）、ratelimit（D1 固定窗口）
  src/worker/db/**       D1 访问层      src/worker/lib/**  校验 / 上游 / 哈希 / 记录映射
  src/worker/maintenance.ts             cron 每日维护
        │
        ▼
D1：games / game_moves / experiments / devices / rate_limits / stats_cache（+ d1_migrations）
```

- 静态资产与 API **同源同域**，没有 CORS 配置负担（只有 `/api/jev` 的 BYOK 转发刻意加 CORS）。
- 取代了旧的三套并行实现（Cloudflare Pages + Pages Functions + 本地零依赖 Node 后端），见 ADR-0010 / ADR-0011。
- 详细拓扑、数据模型、测试金字塔见 [docs/architecture.md](docs/architecture.md)。

## 本地开发

环境要求：**Node ≥ 22.18**（类型剥离直载 `.ts`）+ npm。

```bash
npm ci
npm run dev          # vite dev：单进程起 Worker + 前端 + 本地 D1 → http://localhost:8787
```

- `npm run dev` 带 `predev` 钩子，自动跑 `db:migrate:local`（**只建表，不导数据**）。
- 端口被占会自动顺延，实际端口看启动日志（`vite.config.ts` 里 `port: 8787`，`strictPort: false`）。
- 想在本地看到那 54 局历史归档，手动跑一次 `node scripts/import-archive.mjs --local`。
- 本地库文件由 `wrangler.jsonc` 的 `database_id` 派生
  （`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`）：**换过 `database_id` 就等于换了一个空库**，
  此时重跑 `db:migrate:local` + `import-archive.mjs --local`，并删掉旧 hash 的 `.sqlite`。
- 「无后端降级」自测：`npm run build && npm run preview` 看纯静态产物（AI 走 mock，战绩簿落 localStorage）。
  注意**不再支持 `file://` 双击 `index.html`**——Vite 产物是 ES module + 绝对路径，必须经 HTTP 提供。

> 旧实现（2026-10-01 前）的 `node server.js` / `python dev-proxy.py` / 双击 `index.html` 即玩
> 三种本地起法已随 `js/`、`server.js`、`dev-proxy.py`、`functions/` 一并退役，仅存于 git 历史。

## 目录结构

```
index.html                 唯一 HTML 入口（一个 <script type="module" src="/src/main.ts">）
vite.config.ts             前端构建 + @cloudflare/vite-plugin（单进程起 Worker）
wrangler.jsonc             Worker 名 / D1 绑定 / 静态资产 / cron / 自定义域
tsconfig.json              相对路径 + 显式 .ts 扩展名（allowImportingTsExtensions）
worker-configuration.d.ts  wrangler types 生成的环境类型
src/
  main.ts                  浏览器入口（注入版本号 → boot()）
  shared/                  前后端共用：棋种 id ↔ 中文名映射、版本号
  core/                    纯逻辑，无 DOM 依赖、可被 Node 直载
    engines/               七个引擎：gomoku / gomoku-pro / go / xiangqi / chess / checkers / chinese-checkers
    registry.ts            引擎注册表（games / ids / getGame / register）
    jev/                   Jev 客户端、离线 mock、Rapfi WASM 接入
    tactics.ts             战术推算（一步致胜 / 造杀点 / VCF）+ tactics-versions.ts 战术档
    api/client.ts          后端客户端（探不到后端一律返回 null，即降级）
    record/                棋谱导出 / 战绩簿 / 自动同步
    view/                  落盘展示用的纯字符串渲染（最新一手、对比、校准）
    persist.ts rng.ts clone.ts assert.ts weighted.ts types.ts session.ts meta.ts gfx.ts
  ui/                      视图层（DOM/canvas）：board-render / charts / panels/*（见 src/ui/README.md）
  app/                     对局装配：boot / loop / modes / clock / experiment / records / bindings / self-test
  worker/                  Cloudflare Worker
    index.ts               Hono 应用装配（requestId → 路由 → JSON 404 兜底 → onError）
    routes/                health / games / stats / experiments / openings / leaderboard / jev / export
    middleware/            device（X-Device-Id）、ratelimit（D1 固定窗口）
    db/                    D1 访问层：games / experiments / devices / ratelimit / stats
    lib/                   validate（手写校验）/ upstream（Jev 上游）/ hash / http / record-input
    maintenance.ts         cron 每日维护（清限流行 + 写 stats_cache 汇总）
migrations/                0001_init.sql（D1 schema）+ import/（54 局导入 SQL 与 manifest）
public/rapfi/              Rapfi WASM 引擎资产（Static Assets 托管）
games/                     冻结的历史归档（54 份棋谱，只读；权威数据已导入 D1）
test/
  engines/                 引擎自检 + 战术 + 金样差分（纯 Node，node test/engines/run.mjs）
  tactics/                 战术层单测入口（node test/tactics/run.mjs）
  fixtures/golden/         差分金样（7 棋种 / 5510 手，冻结只读）
  parity/                  金样生成器、封条 frozen.json、例外登记
  worker/                  Worker + D1（vitest + 真 workerd）
  ui/ core/ app/           UI / 纯逻辑 / 装配层单测（vitest：ui project 收 test/ui/** 与 test/app/**，core project 收 test/core/**）
scripts/                   import-archive / verify-parity / verify-backup / check-docs / smoke-live / browser-smoke
docs/                      文档体系入口见 docs/README.md
AGENTS.md                  协作 Agent 与人类 Contributor 的入口规范
```

## 每个引擎实现统一接口

契约全文见 [docs/engine-interface.md](docs/engine-interface.md)，类型定义在 `src/core/types.ts`：

```ts
newGame()                             // 新建初始局面
getLegalMoves(st)                     // 合法着法（顺序稳定，是契约的一部分）
applyMove(st, move)                   // 纯函数：返回新 state，不改入参
getStatus(st)                         // { over, turn, winner?, reason? }
moveFromNotation(st, notation)        // 记法 → move（回放/金样比对用）
serializeForJev(st, side)             // 产出 { state, questions, options }
selfTest()                            // 自检，抛异常即失败
// 可选：draw / humanClick（渲染）、passMove / mockPick / vcfWin（能力）
```

## 常用命令

```bash
# 开发与构建
npm ci                   # 按 package-lock.json 原样安装（CI 同款）
npm run dev              # vite dev（Worker + 前端 + 本地 D1，默认 8787）
npm run build            # vite build → dist/（静态资产 + Worker 包一起出）
npm run preview          # 预览构建产物（无后端降级自测）
npm run deploy           # 构建 + wrangler deploy（需 CLOUDFLARE_API_TOKEN）
npm run typecheck        # tsc --noEmit

# 测试（npm test 是最省事的总闸）
npm test                 # test:engines + test:new（= 28 个文件 / 300 用例；**不含 test:tactics**）
npm run test:engines     # 纯 Node：七引擎 selfTest + 战术 + 54 局金样逐手差分
npm run test:tactics     # 战术层单测（要单独跑）
npm run test:new         # vitest 全部 project
npm run test:worker      # Worker/D1（真 workerd + 本地 D1；每个 spec 自己清表）
npm run test:ui          # 视图层 / 装配层单测（happy-dom）

# 数据库
npm run db:migrate:local     # 本地 D1 应用 migrations/
npm run db:migrate:remote    # 远程 D1 应用 migrations/
npm run import:archive       # 导入 games/ 历史归档（--local 或 --remote）
npm run verify:parity        # 逐手比对新旧实现（本地库，差值必须为 0）
npm run db:export            # 远程 D1 导出 SQL 到 backups/
npm run verify:backup        # 校验导出备份可重建

# 冒烟与文档
npm run smoke:live       # 线上 HTTP 冒烟（默认打 https://jevqipan.logicc.top，会写一行再删）
npm run smoke:browser    # 真浏览器端到端冒烟（CDP + 系统 Chrome/Edge；--offline 验降级，含归档分页、实验报告分桶与最新棋谱）
npm run check:docs       # 文档护栏：memory 置顶、相对链接、status 日期
npm run golden           # 重新生成金样——**预期失败**：金样已冻结，生成器依赖的旧实现已删除
```

## 部署

发布只有一个手动入口，不接 push 触发（旧 Pages 站的 Git 集成已断开）：

1. `npm run typecheck && npm test`（或让 CI 先跑 `.github/workflows/test.yml`）。
2. 需要动 schema 时先 `npm run db:migrate:remote`（迁移是追加式的，别改已应用的 `migrations/*.sql`）。
3. `npm run deploy`（= `npm run build` + `wrangler deploy`），需要 `CLOUDFLARE_API_TOKEN`（本地用 `wrangler login`）。
4. 部署后自检：`npm run smoke:live`（30 项 HTTP 断言）+ `npm run smoke:browser`（14 项浏览器断言：页签/棋盘/渠道/落子/AI 走子/曲线/抽屉/归档分页/实验报告分桶/最新棋谱一键回放/服务端战报并入/无异常）。
5. 发布前后留底：`npm run db:export`；备份可信度用 `npm run verify:backup` 验。

CI 三个工作流：`test.yml`（typecheck → build → test:engines → test:new → check:docs，`REQUIRE_SQLITE=1` 强制真 SQLite）、
`deploy.yml`（**手动 `workflow_dispatch`**）、`backup.yml`（每日导出 D1 并校验，带 `--structural`）。

发布前必须知道的两条：**`games/` 是冻结的历史归档**（2026-10-01 起只读，权威数据在 D1，别再往里写文件）；
**旧 Pages 站只读**，别在它上面做任何"修复"。

## 成本与容量护栏（D1 免费额度）

- 计费口径：**写 ≈ 10 万行/日、读 ≈ 500 万行/日**（Cloudflare D1 免费档）。
- 单局行数 = 1（`games`）+ 手数（`game_moves`），平均 ≈ 81 手 ⇒ **约 440 局/日**才碰到写上限；
  限流判定本身每次也写一行 `rate_limits`，算在同一份写配额里。
- 读侧很宽松：一次全量导出上限 5000 局 ≈ 1 万行（**约 0.2%** 的日读额度），列表接口默认 20 条、硬上限 100 条（`DEFAULT_LIST_LIMIT` / `MAX_LIST_LIMIT`）。
- 单行 `payload` 上限 **512 KB**（`MAX_PAYLOAD_BYTES`，历史最大实测 68.7 KB；超了返回 **413 `payload_too_large`**）；统计聚合读 `stats_cache` 预热行，不实时扫全表。
- 结论：**个人/小圈子用量远低于免费档**，真正的护栏是上面这几条硬上限（写在 `src/worker/lib/validate.ts` 与 `src/worker/db/games.ts` 里）。
- Jev 侧成本另算，见下面「成本参考」（BYOK，花的是你自己的 key）。

## 玩法说明

1. **模式**：人机（你执黑）、机机（Jev 自对弈，看决策）、双人同屏。
   棋种下拉含七项：五子棋、五子棋·禁手、围棋、象棋、国际象棋、西洋跳棋、中国跳棋。
2. **走棋**：点交叉点/格子落子；`passMove` 类棋种（围棋）有「停一手」按钮。
3. **棋谱导出**：对局结束或中途可导出 JSON（`format: jev-qiguan-game/v1`），落盘/分享皆可。
4. **棋谱自动同步**：有后端时自动 `POST /api/games`，响应含 `gameUid` / `dedup` / `movesWritten`；
   同一棋谱重复提交由 `dedup_key` 去重（`dedup: true`）。
5. **决策面板**：每手显示 Jev 概率前 8 名、置信度、`edge` 胜率、`position` 局势分、
   token 与成本、耗时；战术保险接管时标注接管原因。
6. **强度机制（九级战术保险）**：`win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4`，
   详见 [docs/jev-api.md](docs/jev-api.md) §2.2。
7. **校准实验室**：固定局面的胜率标定与复盘（`src/core/view/calibration.ts`）。
8. **对比实验**：同一开局跑多局 A/B（渠道/战术档/思考深度可分别设），结果归档到 `/api/experiments`
   并按 tag upsert。
9. **实验报告的分桶对比**：按「渠道 · 战术版本 · 思考深度」拆成独立身份统计局/胜/和/得分率
   （和棋按半分），两侧同渠道时不再并成一桶；每轮另给 A/B 单轮得分率条。
10. **最新棋谱**：实验报告顶部列出归档里最新的 10 局（新 → 旧，含**没挂实验 tag 的机机对局**——
   以前这些局永远进不了轮次卡），每行带时间/棋种/手数/双方归因与结果，一键送进回放器。
11. **随机度**：`topK` 滑杆控制采样（1 = 最强手，k>1 = 前 k 名概率加权随机）。
12. **棋谱回放**：每局有永久链接 `/api/games/u/<gameUid>`，面板里可逐步回放（前进/后退/到底）。
13. **排行榜**：`/api/leaderboard` 按设备与战术档聚合；**开具体验**：`/api/openings` 给出常见开局的先手胜率与样例局。
14. **归档分页**：归档面板首屏一页 50 份，底部「加载更多」按服务端 keyset 游标（`GET /api/games?cursor=…`）追加，翻完自动收掉按钮。
15. **数据导出**：`/api/export/games` 流式 NDJSON（一行一局），走内部游标翻页，对客户端是一个连续流。
16. **自检入口**：URL 加 `?test=1` 显示浏览器内自检面板（七个引擎逐个 `selfTest()` + 跨模块自检）。

## Jev 走棋原理

Jev 每次决策收到**一次并行三问**（不拆成串联推理链）：

- `move`（Choice）——合法着法概率分布 + 置信度；
- `edge`（Noul）——当前局面己方胜率；
- `position`（Score）——0–10 局势分。

因此 prompt 质量就是棋力上限：本站会注入真实推演出的战术事实（一步致胜点、造杀点、
VCF 将死链，见 [docs/jev-api.md](docs/jev-api.md) §2.2），五子棋另附裁剪过的
`state.board_ascii` 字符画棋盘（该字段名就叫 `board_ascii`）。

**成本参考**：官方定价输入 $42 / 百万 token、输出免费；`costUsd = usage.input_tokens * 42 / 1e9`。
单步 state 约 0.5–1.5K token（≈ $0.00005/步），一整局不到 5 美分。

## 渠道与密钥（BYOK）

| 渠道 | 说明 |
|---|---|
| `official` | TypeSafe 官方 API。**浏览器直连会被 CORS 白名单拦下**（2026-09-29 实测），浏览器侧需走同源代理 |
| `openrouter` | OpenRouter 上的 `typesafe/jev-1.13`，允许 CORS，唯一可浏览器直连的远程渠道 |
| `proxy` | 本站 Worker 的 `/api/jev`：**只做转发与限流，不落 key**；key 经 `X-Api-Key` 请求头透传（BYOK） |
| `rapfi` | 本地 WASM 引擎（Gomocup 协议，仅五子棋/禁手） |
| `mock` | 离线演示，无需 key |
| `random` | 纯随机基线，仅对比实验面板可选 |

- key 只存浏览器 localStorage，或经请求头一次性透传；**永不进仓库、不进服务端存储、不进日志、不进 URL**。
- 设置面板里每个渠道可填自定义「接口地址」（留空 = 用预设）。
- 「测试连接」做两段式连通性探测，区分网络 / CORS / 鉴权 / 端点形状四类故障。

## 开发与多 Agent 协作

- 入口规范：[AGENTS.md](AGENTS.md)；协作协议：[docs/agents/README.md](docs/agents/README.md)。
- 角色分工：[docs/agents/roles.md](docs/agents/roles.md)；任务→阅读矩阵：[docs/agents/reading-paths.md](docs/agents/reading-paths.md)；
  playbook：[docs/agents/playbooks.md](docs/agents/playbooks.md)；并行所有权：[docs/agents/parallel-work.md](docs/agents/parallel-work.md)。
- 完成定义 = 验收命令通过（`npm test` + `npm run check:docs`）+ 文档同步 + [docs/memory/MEMORY.md](docs/memory/MEMORY.md) 顶部追加一条。
- 提交规范：Conventional Commits；注释、文档、commit message 用中文，代码标识符用英文。

## 已验证与已知限制

**已验证**（`npm run test:engines` 每次跑）：七引擎 `selfTest()`；国际象棋 `perft(1/2/3) = 20/400/8902`；
象棋开局 44 着法；西洋跳棋开局 7 着法；围棋提子 / 禁自杀 / 劫 / 双停一手数子（贴 5.5）；
中国跳棋连跳链；五子棋禁手（三三 / 四四 / 长连 / 精确五连，白方豁免）；
以及**与旧实现逐手零差异**——7 棋种自对弈 + 54 局历史棋谱，合计 5510 手，
金样见 [test/parity/README.md](test/parity/README.md)。线上数据核对：54 局 / 4379 手 / 6 轮实验，
`sum(payload_bytes) = 845578`。

**已知限制**：

- 象棋未实现长将 / 长捉判负；围棋只有 9 路盘；国际象棋未判三次重复和棋。
- 中国跳棋未禁止「永堵营地门」变体。
- 引擎不建模「认输」（那是应用层裁决）：归档里 1 局记为「黑方 获胜（认输）」的历史记录与引擎判定不一致，属已知差异。
- Jev 的概率判断仍可能出错——提示词里的「零幻觉」只承诺**输出结构**符合契约，
  不承诺棋理正确；战术保险（九级接管）就是为了兜住这类错误。
- 官方性能与价格数字（$42/百万输入 token 等）为厂商口径与作者实测混合，非长期承诺。
- 匿名设备标识（`X-Device-Id`）只用于「只看我的」与限流，不是账号体系；换浏览器/清 localStorage 即丢失归属。
- **金样与归档都已冻结**：`test/fixtures/golden/**` 与 `games/**` 只读（前者由 `test/parity/frozen.json` 的 sha256 封条守住，
  后者 2026-10-01 起不再接收写入）。因此 **`npm run golden` 预期失败**（生成器依赖的旧实现 `js/**` 已随 P8 删除，
  它只打印中文说明并 `exit 1`）——看到它红不是坏了。
- 统计口径与旧站不同：`/api/stats` 现在是 SQL 侧全量聚合，**没有 `truncated` 字段**（旧 40 份口径 16/16/8 → 全量 18/27/9）。
