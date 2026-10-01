# ADR-0005：零依赖 Node 后端（server.js）——项目从纯静态站变为「静态前端 + 后端」

- 状态：**已被 [ADR-0010](0010-worker-static-assets-replaces-pages.md) + [ADR-0011](0011-d1-authoritative-persistence.md) 取代**（2026-10-01：
  `server.js`/`dev-proxy.py`/`functions/` 三套实现退役，持久化由 D1 承接）
- 历史状态：accepted（2026-09-29）
- 背景：项目此前的"后端"只有两块 CF Pages Function（`/api/jev` 代理、`/api/games`
  经 GitHub API 提交棋谱），本地开发靠 `dev-proxy.py`。三个问题越来越疼：
  ① 棋谱同步绑死 GitHub token，本地/内网环境不可用；② 实验战报只存浏览器
  localStorage，换设备即丢；③ 校准实验室只能看到本机对局，样本量上不去。
  用户要求"重构成具有后端的项目"，但不能违背 ADR-0001（零框架/零构建/零依赖）。

## 决定

新增 `server.js`：**只用 Node 内置模块**（node:http / node:fs / node:path）的
本地/自托管后端，`node server.js` 即跑（默认 8788，`PORT` 可覆盖）。职责：

1. **静态托管**（替代双击 file:// 与 dev-proxy.py 的静态部分）；
2. **`POST /api/jev`**：与 CF Function 同契约的 TypeSafe 代理（BYOK，key 不落盘）；
3. **`POST /api/games` + `GET /api/games`**：棋谱落盘 `games/<日期>/`，
   `flag:'wx'` 原子写实现幂等（重传不覆盖、并发不互踩），文件名规则与 CF 端一致；
4. **`POST/GET /api/experiments`**：实验战报归档 `data/experiments.json`（按 tag upsert）；
5. **`GET /api/stats`**：跨对局聚合（按局 cal 记录，key = gid|着法串），
   让校准实验室拿到**全部已同步对局**的样本而非仅本机；
6. **`GET /api/health`**：前端据此区分"完整后端 / 静态托管或 Pages"。

前端新增 `js/api.js`（`BG.api` 客户端，全部方法失败返回 null 不抛），
`app.js` 启动时探活：有后端则棋谱落盘、实验归档、校准合并服务端样本；
无后端（file:// / 纯静态 / Pages）行为与今天完全一致——**降级路径即原路径**。

## 后果

- 优点：零依赖守住（无 npm install、无打包器）；本地一键获得完整后端；
  校准样本跨设备不丢；`data/` 进 .gitignore（运行时状态），`games/` 仍是项目数据；
  三处部署形态（server.js 自托管 / CF Pages / file://）共用同一套前端代码。
- 缺点：出现第二套服务端实现（server.js 与 functions/api/*.js 契约需保持一致，
  当前靠 `test/server-tests.js` 的 18 项 HTTP 契约测试兜底，Pages 侧另有单测）；
  持久化是本地 JSON 文件，不是数据库（对棋谱/战报的规模足够，换库是后续的事）。
- 约束：server.js 只准用内置模块；新增/修改 API 必须同步 `docs/jev-api.md` §3
  与两端测试；`js/api.js` 的任何方法不得抛异常（降级是设计的一部分）。

## 考虑过但放弃

- Express/Fastify + SQLite：直接违背 ADR-0001，且这点数据量用不上。
- 用 dev-proxy.py 扩成完整后端：Python 侧已有持久 TLS 代理的经验，但项目
  主语言是 JS（引擎与客户端同语言），同语言后端让契约漂移更容易被测试发现；
  dev-proxy.py 保留为最小备用路径。
- 引入数据库（lowdb/better-sqlite3）：第三方依赖违背 ADR-0001；JSON 文件 +
  原子写在"每天几十份棋谱"的规模下没有痛点。

## 补记（2026-09-29，同日落地，不改变原决定）

用户追问「是不是可以改成 Worker」。明确：Pages Functions 与独立 Worker 同运行时同 API，
但 `node:http`/`node:fs` 在 Workers 里不存在（`nodejs_compat` 也不放行），server.js 不可能
小改迁移——两套实现是编程模型差异，不是懒惰。据此把 server.js 独有的三个端点
（health/experiments/stats）移植为 `functions/api/*.js`，持久化全走 GitHub（棋谱进
`games/`、实验进 `data/experiments.json`、stats 用 trees + raw 聚合），零新增 CF 绑定。
免费版 50 子请求/次的约束落实为 stats 的 40 份上限 + 测试断言。自此本地与线上行为一致，
前端零分支。独立 Worker + wrangler 路线评估后放弃：会失去 push 即部署，并把 npm 工具链
引进仓库（违背 ADR-0001 的精神）。
