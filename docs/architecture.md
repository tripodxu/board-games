# 架构地图

> 本文件回答三个问题：**东西在哪**（文件职责表）、**数据怎么走**（请求流）、**哪些规矩不能破**（关键不变量）。
> 项目当前状态、已知限制与验收命令见 [status.md](status.md)；迁移的来龙去脉与各阶段执行记录见 [plans/2026-10-01-workers-d1-rebuild.md](plans/2026-10-01-workers-d1-rebuild.md)。
> 2026-10-01 之前这里是「纯静态站 + 三套后端（零构建、零依赖）」。那套形态已被取代，正式决策见 [ADR-0010](adr/0010-worker-static-assets-replaces-pages.md)、[ADR-0011](adr/0011-d1-authoritative-persistence.md)、[ADR-0012](adr/0012-vite-typescript-build-chain.md)、[ADR-0013](adr/0013-anonymous-device-identity-and-d1-ratelimit.md)。

## 1. 一句话与拓扑

**一句话**：浏览器加载 Vite 构建出的静态前端，所有 `/api/*` 请求进同一个 Cloudflare Worker（Hono），棋谱与实验结果落在 D1；没有常驻服务器、没有构建期后端、没有「每局一次 git commit」。

```
浏览器（Vite 产物；src/main.ts 是唯一 module 入口）
  │  GET /  GET /rapfi/*        → 静态资产，不进 Worker
  │  GET|POST /api/**           → 进 Worker
  ▼
Cloudflare 边缘 —— Worker `jev-qiguan`
  自定义域：jevqipan.logicc.top（custom_domain）
  ┌──────────────────────────────────────────────────────────────────────┐
  │ ① Workers Static Assets                                              │
  │    dist/client/**（Vite 构建产物，由 @cloudflare/vite-plugin 接管）    │
  │    · /rapfi/* 三件套 js + wasm + data（源在 public/rapfi/）           │
  │    · not_found_handling = single-page-application                     │
  │      ⇒ 未命中的路径回落 index.html（SPA），不返回 404                  │
  │                                                                      │
  │ ② Worker API（src/worker/index.ts，Hono）                             │
  │    assets.run_worker_first = ["/api/*"]                               │
  │      ⇒ /api/* 一定进 Worker；其余路径先走资产层，不被 Worker 抢        │
  │    /api/health   /api/games      /api/stats   /api/experiments        │
  │    /api/openings /api/leaderboard /api/jev    /api/export             │
  │      ├── D1 绑定 DB ──► 数据库 jev-qiguan（region WNAM）               │
  │      │                  database_id = f72390fe-a506-4a88-8db7-af7213657947 │
  │      └── Cron "17 3 * * *"（UTC 03:17）──► scheduled                  │
  │                                             └─► runDailyMaintenance() │
  └──────────────────────────────────────────────────────────────────────┘
```

拓扑与配置的锚点全在 [wrangler.jsonc](../wrangler.jsonc)：`name`/`main`（L12-13）、`assets` 与 `run_worker_first`（L24-27）、`routes` 自定义域（L31-36）、`triggers.crons`（L40-42）、`d1_databases`（L43-51）、`observability`（L52-54）、`vars.APP_VERSION`（L55-57）、`dev.port = 8787`（L58-60）。

### 为什么不是 Pages、不是本地 Node 后端

- **不是 Pages（ADR-0010）**：Pages 的 `/api/stats` 要靠子请求去读仓库里的棋谱文件，受 50 个子请求上限，只能聚合最近 40 份并在响应里带 `truncated` 自曝；聚合被迫写在边缘函数里而不是 SQL 里。Workers Static Assets 让**静态资产与 API 同源同域**，D1 承担聚合，且能挂 Cron。旧 Pages 项目 `jev-qiguan` 只作为只读回退保留（见 §9）。
- **不是本地 Node 后端（ADR-0011）**：`server.js` / `dev-proxy.py` 那套需要一个常驻进程、持久化是 JSON 文件、归档要 `GAMES_GITHUB_TOKEN` 去 push 仓库。D1 成为唯一权威存储之后，它们没有存在理由：本地开发由 `npm run dev` 提供（Vite + `@cloudflare/vite-plugin` 起的本地 workerd + 本地 D1），与线上同一份代码、同一套路由。

## 2. 文件职责表

### 2.1 顶层目录

| 路径 | 职责 |
| --- | --- |
| `src/worker/**` | 边缘后端：Hono 入口、8 条业务路由、中间件（requestId / 限流 / 设备）、D1 访问层、共享校验与上游转发 |
| `src/core/**` | 领域内核：七种棋的引擎、会话、战术层与版本闸门、本地持久化、棋谱导出、后端 API 客户端。**不碰 DOM，Node 可直接加载**（引擎自检就是这么跑的） |
| `src/ui/**` | 视图层：面板模块、图表、棋盘绘制、DOM 助手。只接收 props，不认识后端 |
| `src/app/**` | 装配层：把 `core` 与会话状态接到 `ui` 上（启动、对局循环、模式切换、面板装配、后端探活与降级） |
| `src/shared/**` | 前后端共享契约：[record-map.ts](../src/shared/record-map.ts)（旧棋谱字段解析口径）、[version.ts](../src/shared/version.ts)（版本串） |
| [src/main.ts](../src/main.ts) | 浏览器唯一入口：写 `data-code-version` → `boot()` → 兜住启动期异常（绝不白屏） |
| [index.html](../index.html) | 页面外壳：棋盘画布、页签容器、三个侧栏页签、唯一一个 `<script type="module">` |
| [migrations/](../migrations) | [0001_init.sql](../migrations/0001_init.sql)（六张业务表 + 索引）与 `import/*.sql`（历史 54 局 + 6 轮实验的导入产物） |
| [test/](../test) | 四层测试：引擎（纯 Node）、core/worker/ui/app（vitest 三个 project）、[fixtures/golden/](../test/fixtures/golden)（冻结金样） |
| [public/rapfi/](../public/rapfi) | Rapfi 引擎的 wasm 资产（`rapfi-single-simd128.js/.wasm/.data` + `COPYING.txt`/`NOTICE`）。Vite 的 `publicDir` 直出到 `dist/client/rapfi/*` |
| [styles/style.css](../styles/style.css) | 全站样式（月白/玄墨/朱砂）。唯一一份样式表，由 `index.html:11` 的 `<link rel="stylesheet" href="/styles/style.css">` 引入，经 Vite 打包进 `dist/client/assets/` |
| [games/](../games) | 旧实现的棋谱归档（54 局）。**冻结只读**，是金样与对账的源数据，不再写入 |
| [scripts/](../scripts) | 6 个零依赖脚本：文档校验、归档导入、新旧对账、备份校验、线上 HTTP 冒烟、真浏览器冒烟 |
| [.github/workflows/](../.github/workflows) | 三条流水线：`test.yml`（CI）、`deploy.yml`（手动部署）、`backup.yml`（每日 D1 导出） |
| [data/experiments.json](../data/experiments.json) | 旧实现的实验归档（已导入 D1），历史遗留 |
| `backups/export.sql`（`npm run db:export` 的产物，不入库） | 一次 D1 导出的快照（用于本地重放/备份校验判别力对照） |

> 上表里没有旧实现的任何一行：`js/**`、`functions/**`、`legacy.html`、`server.js`、`dev-proxy.py`、`css/**`、
> 旧测试 `test/{run-tests,server-tests,rapfi-tests}.js` 都已在 P8 删除（见 §9「旧实现已删除（P8）」），
> 现役代码只有 `src/**` + `migrations/**` + `scripts/**` + `test/**` + `styles/**`。

### 2.2 后端细分（`src/worker/**`）

| 文件 | 职责 |
| --- | --- |
| [index.ts](../src/worker/index.ts) | Hono 应用本体；注册 8 条路由、requestId 中间件、`/api/*` 的 JSON 404 兜底、`onError` 500；默认导出 `{ fetch, scheduled }`（具名导出 `app` 供测试自省路由表） |
| `routes/health.ts` | 探活：`SELECT 1` + 从 `d1_migrations` 读 schema。**刻意不限流**（CI 冒烟与运维探活入口，被限流会让监控误判） |
| `routes/games.ts` | 写一局（`POST`）、列棋谱（keyset 分页）、永久链接 `/u/:gameUid`、旧深链 `/:day/:name` |
| `routes/stats.ts` | 总览/各棋种/胜负/校准样本，三条 `GROUP BY` 全在 SQL 侧 |
| `routes/experiments.ts` | 实验轮归档的读写 |
| `routes/openings.ts` | 开局聚合，喂引擎的 `state.experience` |
| `routes/leaderboard.ts` | 渠道/设备/棋种榜（wins/losses/draws 摊平成列） |
| `routes/jev.ts` | Jev 上游代理（BYOK；无 key → 401） |
| `routes/export.ts` | `/api/export/games`：JSONL 全量导出（备份用） |
| `middleware/ratelimit.ts` | 基于 D1 `rate_limits` 表的固定窗口限流（三档） |
| `middleware/device.ts` | 校验 `X-Device-Id` 并放进 context；**不写设备行** |
| `db/*.ts` | D1 访问层：`games` / `stats` / `experiments` / `devices` / `ratelimit` |
| `lib/*.ts` | 校验（`validate`）、payload→输入映射（`record-input`）、错误体（`http`）、sha1（`hash`）、上游转发（`upstream`） |
| `maintenance.ts` | Cron 每日维护：当日汇总进 `stats_cache`、清理过期限流窗口 |

### 2.3 前端细分

| 路径 | 职责 |
| --- | --- |
| `src/core/engines/{gomoku,go,xiangqi,chess,checkers,chinese-checkers}.ts` | 七种棋（五子棋两档：`gomoku` / `gomoku-pro`）的规则与搜索，注册顺序即 [registry.ts](../src/core/registry.ts) 里的键顺序 |
| `src/core/jev/{client,rapfi,mock,index}.ts` | 渠道实现：官方 API / OpenRouter / 同源代理（`client.ts` 里的 `CHANNELS`）、Rapfi wasm、离线 mock，外加 `random` 基线 |
| `src/core/tactics*.ts` | 战术层（九级保险、VCF）与版本闸门 |
| `src/core/record/{export,sync,book}.ts` | 导出契约（`buildGameExport`）、上传队列（去重 + 退避）、本机战绩簿 |
| `src/core/api/client.ts` | 所有后端调用的唯一出口；无后端时全部返回 `null` 由装配层降级 |
| `src/ui/panels/*.ts` | 面板模块（驾驶舱、决策流、战绩簿、校准、战术沿革、设置抽屉、回放器、排行榜、开具体验） |
| `src/app/*.ts` | 装配层（`boot` 启动、`loop` 对局循环、`modes` 模式与实验、`panels` 面板装配、`backend` 探活降级、`bindings` DOM 绑定） |

## 3. 请求流

### 3.1 开一局 → 入库

1. **渠道选择**：`src/core/jev/client.ts` 的 `CHANNELS`（`official` / `openrouter` / `proxy`）+ `rapfi` + `mock` + `random`。对局循环在 `src/app/loop.ts`，模式与换边在 `src/app/modes.ts`。
2. **导出契约**：终局后 `src/core/record/export.ts` 的 `buildGameExport(session, engine, opts)` 生成 `format: "jev-qiguan-game/v1"` 的 payload（旧字段逐字保留，只增不改）。
3. **上传队列**：`src/core/record/sync.ts`。本地按 `gameUid|notation` 去重，待发队列上限 5 条，失败按 `min(60000, 1000·2^(n-1))` 退避，最多 3 次；账本存 localStorage 键 `jev_qiguan_sync_v1`。状态文案（`成功 · <文件名>` / `失败（HTTP n）` / `失败（无后端或网络异常）`）与旧实现逐字一致。
4. **`POST /api/games`** → Worker 侧中间件链：`rateLimit('write')`（20 次/分钟）→ `deviceMiddleware`（校验 `X-Device-Id`）→ 业务处理器。
5. **校验与映射**：`readJsonBody` → `parseGamePayload`（超过 512 KB 抛 `RangeError` → 413 `payload_too_large`；类型错抛 `TypeError` → 422 `invalid_payload`；其余异常交给 `onError` 变 500）→ `toGameInput(payload, { deviceId, source: 'worker' })`。
6. **落库**：`touchDevice()`（`games.device_id` 有外键，缺这行会得到 `SQLITE_CONSTRAINT_FOREIGNKEY`）→ `insertGame()`。`dedup_key` 与 `game_uid` 都是唯一键，SQL 里用 `ON CONFLICT DO NOTHING`；命中既有行时先按 `dedup_key` 找、再退到 `game_uid`（第二次提交可能换了导出时间戳）。
7. **响应**：`{ ok, id, gameUid, dedup, movesWritten, path }`。`path` 是旧深链形态 `games/<day>/<slug|gameId>-<gameUid 前 8 位>.json`，供 `GET /api/games/...` 取回。

> 归档搬运走的是同一个落库函数：`scripts/import-archive.mjs` 与 Worker 路由共用 `src/shared/record-map.ts` 的解析口径。**两处口径必须一致**，否则「重传一份归档棋谱」会悄悄产生第二行。唯一已知偏差是有意的：路由写入的 payload 传的是解析后对象、由 `insertGame` 重新序列化，字节不与原请求体逐一相同；导入脚本走 `rawPayload` 才保留逐字节原文。

### 3.2 读聚合（聚合在 SQL 侧）

| 入口 | 口径 |
| --- | --- |
| `GET /api/stats` | 总览 / 各棋种分布 / 胜负 / 校准样本，三条 `GROUP BY` 全在 D1 里算。`byGame` 的键是**中文棋种名**（`COALESCE(NULLIF(game,''), 'unknown')`）；校准样本条件是 `mock = 0 AND first_win IS NOT NULL AND json_type(cal_json) = 'array'`。参数 `scope=global\|device`、`game`、`since`。**响应里不再有 `truncated`**——旧 Pages 版「只读 40 个文件」的天花板随子请求一起消失了 |
| `GET /api/experiments` | 实验轮存档（可选 `tag` / `device` 过滤） |
| `GET /api/openings?game=` | 开局聚合：按 `opening_prefix`（前 4 手）分组，`HAVING COUNT(*) >= 2`，默认 `LIMIT 20`、上限 100；黑胜率分母含和棋（对齐旧 `buildExperience()` 的数值）。注意**只存了前 4 手**，查 5 手以上的开局必然落空 |
| `GET /api/leaderboard` | 渠道/设备/棋种榜。用 `CASE WHEN winner = side` 把胜负摊平成 `wins/losses/draws` 三列；`black_*` 与 `white_*` 用 `UNION ALL` 拆成两个「视角行」，白方渠道也上榜；胜率分母只算已分胜负（和棋单列）。迁移期导入的历史棋谱没有渠道字段，故 `COALESCE(channel, 'unknown')` |
| `GET /api/export/games` | JSONL 流式导出：每行 = 落库列 + `payload` 原文。空结果是 **200 + 0 字节**（不是 404、也不是 `[]`）。**不按设备过滤**——备份要的是全集 |

> 这一层的共同点：**没有 50 子请求截断，没有「最近 7 天」隐式窗口，没有分页上限**。列表接口的 `limit` 上限 100、游标是 keyset（`id < cursor`）而不是 offset；导出内部有游标循环，但对客户端是一个连续流。代价是 N+1 式读取（列表刻意不取 `payload`，导出对每局再取一次），上界由 `MAX_EXPORT_GAMES`（5000 局）兜住。

### 3.3 旧深链兼容与永久链接

- **永久链接 `GET /api/games/u/:gameUid`**：跨天稳定，响应头带 `X-Game-Uid` / `X-Game-Day`。这条路由**必须注册在 `/:day/:name` 之前**，否则 `u` 会被当成 `day`。
- **旧深链 `GET /api/games/:day/:name`**：`name` 允许带或不带 `.json`，按三步解析——① 用去掉后缀的词干当 `slug` 精确查；② 去掉末段 `-<stamp>` 再按 `slug` 查；③ 末段长度 ≥8 时按 `game_uid` 前缀查。**三步都落空就 404 并打日志，绝不猜**（猜错会把 A 局的链接指向 B 局）。
- 迁移期导入的 54 份历史棋谱里**有 48 份没有 `slug`**，这类深链只能靠列表返回的 `path` 或永久链接 `/api/games/u/<gameUid>` 访问。

### 3.4 中间件与错误约定

- **requestId**：注册在 `app` 而不是 `/api` 子应用上（否则 `/api/nope` 这类未命中路由的响应会退化成 `requestId: null`）。取值优先 `cf-ray`，响应头 `X-Request-Id` 一并回传，错误体里也带。
- **`/api/*` 未命中**：`app.all('/api/*')` 返回 **JSON 404**。这条不能省——SPA 兜底会把未知 API 变成 HTML 200。
- **未捕获异常**：`onError` 打日志（带 requestId）+ 统一 500 JSON，不泄漏堆栈。
- **错误体**：统一 `{ error: <文案>, code, requestId }`（`src/worker/lib/http.ts` 的 `errorBody`，错误码是白名单联合类型）。状态码集中在 `statusFor()` 里映射，避免同一个码在不同路由给出不同状态：未命中 404、参数错 400、未授权 401、payload 不合法 422、payload 过大 413、限流 429（带 `Retry-After` 与 `X-RateLimit-*`）、上游失败 502、其它 500。

## 4. 数据模型

**详细 DDL 见 [migrations/0001_init.sql](../migrations/0001_init.sql) 与[重构计划](plans/2026-10-01-workers-d1-rebuild.md)的 §4，本节只给用途与不变量。**

六张业务表（`backups/export.sql` 里还能看到第 7 张 `d1_migrations`，那是 wrangler 的迁移记账表，不是业务数据）：

| 表 | 用途 | 关键约束 |
| --- | --- | --- |
| `games` | 一局棋一行：既有列化的派生字段（day / game / mode / result / winner / move_count / opening_prefix / slug / 渠道与战术档 / 实验标签 / 版本 / 成本与延迟 / 设备 / 来源），也有 `payload` 与 `payload_bytes` | `game_uid` 与 `dedup_key` 各自唯一；`device_id` 外键指向 `devices`；`payload` 是保真副本，列化字段是派生值——两者不一致时以 `payload` 为准 |
| `game_moves` | 每手一行（供棋谱流水与逐手回放） | 主键 `(game_id, ply)`，`ON DELETE CASCADE`，`WITHOUT ROWID` |
| `devices` | 匿名设备（首次/最近出现时间、UA 摘要） | 主键 `device_id`。**写路由必须先 `touchDevice`**，否则外键约束直接拒 |
| `experiments` | 实验轮：A/B 渠道与战术档、思考时长、总局数、成员棋谱 | 主键 `tag`；`tac_a`/`tac_b` 是同渠道 A/B 的唯一可分辨依据，不能丢 |
| `rate_limits` | 限流计数：每个（桶，窗口起点）一行 | 主键 `(bucket, window_start)`，`WITHOUT ROWID` |
| `stats_cache` | 每日维护写进去的汇总与心跳（`daily:<YYYY-MM-DD>`） | 主键 `key` |

> 两个容易踩的点：① `migrations/0001_init.sql` **一旦应用到 remote 就不得修改**，只能追加 `0002_*.sql`；② 单行 payload 上限 512 KB（应用层校验），**历史归档实测最大只有 68.7 KB**。

## 5. 身份与限流（ADR-0013）

- **无账号体系**。浏览器生成一个匿名设备 id，以 `X-Device-Id` 头带上；格式非法直接 400。设备 id 只用于「我的局」`device=me` 与榜单分组，不是安全边界（可伪造，但数据本来就是公开的）。
- **限流三档**（每分钟，`src/worker/middleware/ratelimit.ts`）：`jev` 30、`write` 20、`read` 120。计数键是 `桶:客户端 IP`。
- **`/api/health` 不限流**——它是 CI 冒烟和运维探活入口。
- 实现是 D1 里的 `rate_limits` 表 + 固定窗口，**取代了旧实现那个「进程内 Map、跨 isolate 就失效」的限流**。已知代价：每次判定都要写一行（读接口的限流也消耗当天的写配额），窗口是秒对齐的固定窗口而非滑动窗口，边界上允许 2× 突发。
- 设备中间件**刻意不写设备行**：读接口每个 GET 都 upsert 一次会白烧 D1 的每日写配额；外键只要求「设备行先于棋谱行存在」，所以 upsert 只放在写路由。

## 6. 测试金字塔

| 命令 | 验什么 | 失败的典型原因 |
| --- | --- | --- |
| `npm run test:engines`（`node test/engines/run.mjs`） | 纯 Node：七个引擎的 `selfTest`、战术九级与 VCF soundness、**金样逐手差分**、54 局归档逐手重放 | 引擎规则被改动、战术层行为漂移、金样被改写（`test/parity/frozen.json` 是封条：集合 + 每个文件的 sha256 + 字节数，任何静默改写都会红） |
| `npx vitest run --project worker` | 真 workerd + 真 D1 跑 HTTP 契约、聚合与维护任务（迁移以绑定注入，`test/worker/setup.ts` 里 `applyD1Migrations`） | SQL 或响应契约写错；`singleWorker: true` ⇒ 所有用例共享同一个 D1 实例，**用例不自己清库就会互相污染** |
| `npx vitest run --project ui` | happy-dom 里的运行时断言（`test/ui/**` 视图层 + `test/app/**` 装配层） | DOM 契约漂移、装配层降级路径断。这一层**不做源码字符串匹配**——要断言真实运行行为 |
| `npx vitest run --project core` | 纯 node：字段映射、会话、战绩簿、上传队列，以及用 `node:sqlite` 重放 `migrations/**` 的归因用例 | 解析口径与导入脚本不一致。本地没有 `node:sqlite` 时该用例可跳过，CI 用 `REQUIRE_SQLITE=1` 强制硬失败 |
| `npm run test:tactics` | 战术层的独立回归（`test/tactics/run.mjs`） | 战术层改动未同步该套件 |
| `npm run smoke:live` | 真线上 HTTP 冒烟 29 项（列表、详情、旧深链、聚合、导出、401/400、去重与写入） | 契约漂移、D1 未绑定、限流误伤 |
| `npm run smoke:browser` | 真浏览器（CDP + 系统 Chrome）冒烟：页签渲染、棋盘初始绘制、渠道切换、开局后状态栏与像素变化、曲线切换、设置抽屉、全程无未捕获异常；`--offline` 再加 2 项验「无后端时降级为离线演示而不是白屏」 | SPA 兜底吞掉 API、canvas 未绘制、启动期抛异常 |
| `npm run verify:parity` | 新旧两套入口的对账（`--base` 旧 / `--candidate` 新），差值必须为 0 | 聚合口径或截断行为出现差异 |
| `npm run verify:backup` | 备份能否重建出可信的库；定时任务用 `--structural` 档（绝对计数不判失败，但孤儿行、手数与 `move_count` 不符、payload 与派生列漂移、冻结期内对不回 `games/**` 源文件这四类永远硬失败） | 迁移漏行、payload 被改写、冻结期数据被篡改 |

> 金样为什么这么重：`test/fixtures/golden/*.json` 是「重写引擎但不能改行为」的唯一硬证据。旧实现删除后生成器再也跑不起来，所以金样**冻结为只读文物**，由 `test/parity/frozen.json` 封条，断言写在 `test/engines/parity.test.mjs`。
> 浏览器冒烟与 happy-dom 单测互补：单测没有布局、没有 canvas 绘制、没有真实事件循环，`scripts/browser-smoke.mjs` 补的正是这段空隙。

## 7. 部署与运维

- **部署**：`npm run deploy` = `vite build && wrangler deploy`。构建产物由 `@cloudflare/vite-plugin` 输出，静态资产不需要在 `wrangler.jsonc` 里手写目录或绑定；`main` 指向 `src/worker/index.ts`。
- **流水线**（[.github/workflows/](../.github/workflows)）：
  - [test.yml](../.github/workflows/test.yml)：push/PR 触发，`typecheck` → `build` → 引擎测试 → 新旧测试 → 文档校验。
  - [deploy.yml](../.github/workflows/deploy.yml)：**只有手动触发**（`workflow_dispatch`，带一个 `run_migrations` 开关）。ADR-0010 把「push 即部署」换成了显式动作——静态资产与 D1 迁移一起自动跑的爆炸半径更大。
  - [backup.yml](../.github/workflows/backup.yml)：每天 UTC 04:23（错开 03:17 的维护 Cron）跑 `wrangler d1 export --remote` → `verify:backup --structural` → 上传 artifact（保留 30 天）。
- **D1 迁移**：本地 `npm run db:migrate:local`（`npm run dev` 的 `predev` 会自动跑；注意本地库文件名由 `database_id` 派生，换过 id 就等于换了一个空库，需重新迁移 + 重新导入）；远程 `npm run db:migrate:remote`。历史归档导入：`node scripts/import-archive.mjs --local|--remote`。
- **Cron**：`17 3 * * *`（UTC）。改 `triggers.crons` 后**必须重新 deploy 才生效**。首次真实执行在 2026-10-02T03:17Z，验证方式是查 `stats_cache` 里有没有 `daily:2026-10-02`，或 `wrangler tail` 看 `[maintenance]` 日志。本地无法用 `--test-scheduled` 预演——静态资产会先接管非 `/api/*` 路径，`/__scheduled` 拿回的是 SPA 兜底 HTML。
- **回滚**：代码用 `wrangler versions rollback` 回上一版本；数据用导出的 D1 快照恢复（`wrangler d1 export` 的产物）。强制前置是切流前先导出一份并留存（计划 §11）。旧的只读回退是 Pages 的 `https://jev-qiguan.pages.dev`。
- **成本护栏（免费额度）**：写 ≈ 10 万行/日，单局行数 = 1 + 手数 ⇒ **约 440 局/日**；读 ≈ 500 万行/日，一次全量导出最多 5000 局 ≈ 1 万行（**约 0.2%**）。单行 payload 上限 512 KB（历史最大实测 68.7 KB），列表上限 100 条，重聚合走 `stats_cache` 预热。限流判定本身每次一行写，也算在写配额里。

## 8. 关键不变量（改代码前先看）

1. `payload` 是保真副本，列化字段是派生值；两者不一致时**以 payload 为准**。
2. 写路由必须先 `touchDevice`——`games.device_id` 有外键。
3. `/api/*` 未命中的兜底必须返回 **JSON 404**，不能落到 SPA 兜底。
4. `/api/games/u/:gameUid` 必须注册在 `/:day/:name` 之前。
5. `migrations/0001_init.sql` 上过 remote 后不得修改，只能追加新文件。
6. 导出契约**只增不改**：新字段可以加，旧字段与旧文案逐字保留（旧消费方要能容忍缺省）。
7. `test/fixtures/golden/**` 只读；`test/parity/frozen.json` 是封条。
8. `src/core/**` 只用可擦除的 TypeScript 语法（禁 `enum` / `namespace`），且不依赖 DOM——引擎自检是 Node 直接加载它跑的。
9. `wrangler.jsonc` 的 `compatibility_date` 停在 `2026-08-22`：测试用的 workerd 只认到这天，上调会让测试运行器起不来。
10. `/api/export/games` 不按设备过滤（备份要全集）。
11. 静态资产不进 Worker：只有 `/api/*` 因为 `run_worker_first` 才进。

## 9. 旧实现已删除（P8）

**2026-10-01，旧实现从磁盘上删掉了**，现役代码只剩 `src/**`（前端 + Worker）、`migrations/**`、`scripts/**`、`test/**`、`styles/**`：

| 已删除 | 原来是什么 | 现在由谁承担 |
| --- | --- | --- |
| `js/**`（`app.js` / `board.js` / `charts.js` / `games/*.js` / `jev-client.js` / `api.js` / `mock-ai.js` / `rapfi.js` / `tactics-versions.js` / `latest-board.js` / `calibration.js` / `duel.js`） | 旧的原生 JS 前端，用 `BG.*` 全局命名空间互相拼接 | `src/core/**` + `src/ui/**` + `src/app/**`（TS 模块，见 §2.3）；全局命名空间 `BG` 不复存在 |
| `functions/**`（`api/{games,stats,experiments,health,jev,_github}.js`） | Cloudflare Pages Functions，每个文件一条 API | `src/worker/routes/*.ts`（Hono，8 条路由） |
| `server.js`、`dev-proxy.py` | 本地零依赖 Node 后端（棋谱落盘 JSON）+ 给浏览器直连官方 API 用的最小代理 | `npm run dev`（Vite + `@cloudflare/vite-plugin` 起的本地 workerd + 本地 D1，与线上同代码） |
| `legacy.html` | `server.js` 配套的旧页面 | `index.html` + `src/main.ts`（`?test=1` 自检入口在新前端保留） |
| `css/**` | 样式表（`css/style.css`） | [styles/style.css](../styles/style.css)，由 `index.html:11` 引入并经 Vite 打包 |
| `test/run-tests.js`、`test/server-tests.js`、`test/rapfi-tests.js` | 旧实现契约测试（`npm run test:legacy`） | `test/engines/**`（纯 Node）+ vitest 的 `worker` / `core` / `ui` 三个 project；`package.json` 的 `test` = `test:engines && test:new` |

### 迁移结论（只留对新读者有用的那几条）

- **为什么 `/api/stats` 不再有 `truncated`**：旧 Pages 版的聚合要挨个读仓库里的棋谱文件，受 50 个子请求上限，只能聚合最近 40 份并在响应里带 `truncated` 自曝。新实现把聚合搬进 D1 的 SQL 侧（三条 `GROUP BY`），全量算、没有截断，字段整个删掉。口径也随之变化：旧 40 份口径 16/16/8，全量 18/27/9。
- **为什么限流从 isolate 内存 Map 换成 D1 表**：旧 Pages Function 的计数存在 isolate 内存里，多实例各算各的，实际等于没限。现在按 `rate_limits` 表做固定窗口（ADR-0013），跨实例一致；代价是每次判定写一行，且固定窗口在边界允许 2× 突发。
- **为什么 `BG` 全局命名空间不存在了**：`BG.games` / `BG.jev` / `BG.api` 那套是零构建时代的模块系统（IIFE 挂 `globalThis`）。迁到 Vite/TypeScript 后一律走 ES module import，注册表是 [src/core/registry.ts](../src/core/registry.ts)。
- **为什么不再有「每局一次 git commit」**：旧实现的归档靠 `GAMES_GITHUB_TOKEN` 把棋谱 push 进仓库（GitHub-as-database）。现在棋谱直接落 D1，导出/备份走 `/api/export/games`（JSONL）与每日 D1 export；`/api/health` 里那个 `github` 字段也随之删除。
- **为什么前端版本不再靠手工 bump**：旧实现按文件名时间窗 + 手工改 `BG.codeVersion` 归因，忘改就归错版。现在 `vite.config.ts` 构建期注入 `package.json` 的 `version` + git short sha，归因只认数据自带的声明（见 §2.1 与 [src/shared/version.ts](../src/shared/version.ts)）。
- **`test/fixtures/golden/**` 为什么冻结**：金样是「重写引擎但不能改行为」的唯一硬证据，由 `test/parity/frozen.json` 的 sha256 封条守住。生成金样的 `test/parity/generate.mjs` 依赖旧实现（旧引擎自对弈），旧实现删掉之后它只能打印中文说明并 `exit 1`——所以 `npm run golden` **预期失败**，不是坏了。
- **`games/**` 是历史归档**，只读：54 局棋谱是金样、对账与归因用例的源数据，任何人都不该再往里写（说明见 [games/README.md](../games/README.md)）。
- **`https://jev-qiguan.pages.dev` 保留为只读回退**：它是旧口径的对照端（`npm run verify:parity` 的 `--base`），也是回滚时的逃生门；Pages 项目已断开 Git 集成，不再随 push 部署、也不再承接写入。
- **迁移完成后从哪里看历史**：[plans/2026-10-01-workers-d1-rebuild.md](plans/2026-10-01-workers-d1-rebuild.md) 的 P0–P8 执行记录（含每一步的实测数字与偏差裁决，以及「P5 收尾的有意行为变化」一节），以及 [docs/memory/MEMORY.md](memory/MEMORY.md) 的按日条目。
