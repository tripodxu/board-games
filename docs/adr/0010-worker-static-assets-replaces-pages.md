# ADR-0010：独立 Cloudflare Worker + Static Assets 取代 CF Pages（并退役 server.js / dev-proxy.py）

- 状态：accepted（2026-10-01）
- 取代：[ADR-0005](0005-zero-dep-node-backend.md)（零依赖 Node 后端）被本篇 + [ADR-0011](0011-d1-authoritative-persistence.md) 完全取代
- 背景：项目此前同时维护三套服务端实现——CF Pages Functions（`functions/api/*.js`）、
  零依赖 Node 后端（`server.js`）、Python 最小备用（`dev-proxy.py`）。ADR-0005 自己就把
  「两套实现契约需保持一致」列为缺点，并用 570 行 `test/server-tests.js` 兜底。
  实际的疼点在部署形态：Pages Functions 与 Pages 项目强绑定，未知 `/api/*` 会被 SPA 兜底
  成 `index.html + 200`（前端只能靠 JSON 解析失败来识别），函数无法直接使用 D1 之外
  的 Worker 能力（cron、versions 回滚、observability），且「本地与线上同运行时」做不到。

## 决定

1. **单一 Worker** `jev-qiguan`：入口 `src/worker/index.ts`，框架 Hono + TypeScript。
2. **静态资产由同一 Worker 托管**：`assets` 绑定指向 Vite 产物，`run_worker_first = ["/api/*"]`
   保证 API 一定进 Worker；Hono 未命中时必须**显式返回 JSON 404**（不允许 SPA 兜底吞掉）。
3. **删除 `functions/`**：Pages Functions 的全部职责由 Worker 路由承接（见 ADR-0011）。
4. **删除 `server.js` 与 `dev-proxy.py`**：本地开发统一 `vite dev`
   （`@cloudflare/vite-plugin`，单进程内跑 workerd + 本地 D1 绑定），
   静态预览用 `npm run preview`（无 API 时走离线降级路径）。
5. **部署双通道**：GitHub Actions（push `main` → `wrangler d1 migrations apply --remote` →
   `wrangler deploy`）+ 本地手动 `npm run deploy`；密钥由 `wrangler secret` 管理。
6. **Pages 项目 `jev-qiguan` 保留只读**作为回退，不再部署、不再接收新数据。

## 后果

- 优点：一套实现、URL 契约唯一、本地与线上同为 workerd（差异只剩绑定）；
  D1 / cron / observability / `wrangler versions` 回滚全部可用；
  子请求预算不再需要为「用 GitHub 当数据库」精打细算（ADR-0011）。
- 缺点：失去 Pages 的「push 即自动构建部署」隐式性（由 Actions 显式补回）；
  引入 npm 工具链（记录于 ADR-0012）；本地体验从「双击 index.html」变为 `npm run dev`。
- 约束：任何 `/api/*` 契约改动必须三处同步——`docs/jev-api.md` §3、
  `src/worker/routes/**`、`test/worker/**`；`assets` 配置改动必须实测
  `/api/nonexistent` 返回 JSON 404 而不是 HTML。

## 考虑过但放弃

- **Pages + D1 绑定（改动最小）**：Pages Functions 同样支持 D1，但它的运行时打包、
  路由与本地 D1 调试仍要 wrangler；且 Pages 的 SPA 兜底会把未知 `/api/*` 变成
  `index.html + 200`，这个坑要么绕要么忍。留两套心智不如一次到位。
- **保留 `server.js` 作为离线/内网零依赖后端**：正是 ADR-0005 自认的缺点来源。
  其独有价值（断网可用、内网自托管）由两条现成路径覆盖：`vite preview` + 离线降级、
  以及 Worker 本身（公网）。同时维护 `node:http/fs` 与 Workers 两种编程模型不划算。
- **双轨并行部署（Pages 继续同步）**：要同时产出并验证两套前端产物与两套后端，
  成本高于收益。「Pages 保留只读」已达到同样的回退目的（见本计划 §11 回滚表）。

## 补记（P1 spike 结论，2026-10-01 填写）

- 静态资产接线最终采用：**A1 `@cloudflare/vite-plugin`**（附录 A 的 A1）。
- 实测依据：
  - `npx vite build` 一次产出两侧：`dist/client/`（前端：index.html 27.68 kB、
    assets/index-*.css 33.55 kB、assets/index-*.js 1.29 kB）与 `dist/jev_qiguan/`
    （Worker bundle index.js 58.30 kB + wrangler.json）——前端产物目录由插件决定，
    因此 `wrangler.jsonc` **只声明 assets 行为**（`not_found_handling` +
    `run_worker_first: ["/api/*"]`），不写 `directory`/`binding`。手写两份配置（A2）
    的价值只剩「少一个插件依赖」，抵不过产物路径漂移的风险。
  - `/api/*` 一定进 Worker：已由 `test/worker/health.spec.ts` 断言——未实现的
    `/api/does-not-exist` 返回 JSON 404（`{error, code:'not_found', requestId}`），
    而不是 SPA 兜底的 `index.html + 200`。
  - D1 绑定可用性：`test/worker/setup.ts` 对 `env.DB` 跑 `applyD1Migrations` 后，
    `/api/health` 返回 `d1: true` 且 `schema: "0001_init.sql"`，真 workerd + 真 D1 全绿。
  - 本地 HMR 与 `/rapfi/*.data` 的 Content-Type：**尚未实测**，挪到 P5 的 Rapfi 资产
    验收项（风险 R4 不变）。
- 附带约束（执行期发现，详见计划 §7「P1 执行记录」）：`compatibility_date` 受测试池
  内嵌 workerd 限制取 `2026-08-22`；`vitest.config.ts` 的迁移注入走
  `readD1Migrations('./migrations')` + `miniflare.bindings.TEST_MIGRATIONS`。

