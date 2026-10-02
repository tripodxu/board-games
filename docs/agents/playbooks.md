# Playbooks：常见任务的固定套路

> 每一步都给出「做完怎么验」。**验收命令没跑过就不算做完**（[README.md](README.md) 黄金法则 4）。
> 迁移期用的旧验收命令（`node test/run-tests.js` 与 `npm run test:legacy`）**已随旧实现删除**，
> 替代品见各节：引擎/战术/金样走 `npm run test:engines`，其余走 `npm run test:new` 的分 project。

## 1. 新增一个棋种引擎

1. 读 [../engine-interface.md](../engine-interface.md) §1/§2/§6（注册方式、方法契约、7 步接线清单）。
2. 复制样板建文件：
   - 落子类（棋盘格线、连珠判定）→ 抄 `src/core/engines/gomoku.ts`；
   - 吃子/连跳类 → 抄 `src/core/engines/checkers.ts`（含 `chinese-checkers.ts` 的连跳链处理）；
   - 走子规则复杂类（王/车/马/炮、易位、过路兵）→ 抄 `src/core/engines/chess.ts` 或 `xiangqi.ts`；
   - 含提子/劫/数子 → `src/core/engines/go.ts`。
   导出 `create<Name>(id, name, …)` 工厂（一文件两变体如 `gomoku`/`gomoku-pro` 用第三参区分）。
3. 实现必需方法：`newGame` / `getLegalMoves` / `applyMove`（**纯函数，不改入参 state**）/
   `getStatus` / `moveFromNotation`（**双参契约，漏传 `st` 会在解析期炸**）/ `serializeForJev` / `selfTest`；
   按需要实现可选能力：`draw` / `humanClick`（渲染）、`passMove` / `mockPick` / `vcfWin`，
   以及 `supportsPass` / `supportsResign` / `deepTactics` 标记。
4. **公共文件交给编排者改**（不要自己动）：
   - `src/core/registry.ts`：`games` 增加键（**键顺序即注册顺序**，会影响首页棋种下拉与 `ids`）、
     必要时补 `export const <id>Pro`；
   - `src/shared/record-map.ts`：`GAME_NAME_TO_ID` / `GAME_ID_TO_NAME` 增加中文名 ↔ id；
   - `src/ui/panels/openings.ts`：`GAME_IDS` 增加 id；
   - `test/engines/run.mjs` 的用例清单。
5. 补测试：在 `test/engines/` 增加用例文件（沿用一个引擎一个文件的约定），
   `selfTest()` 至少覆盖 [../engine-interface.md](../engine-interface.md) §5 的六类断言
   （初始局面合法着法非空、记法往返、非法输入返回 null、标志性规则各一条、终局可达、
   重引擎 perft 计数如国际象棋 `perft(1/2/3)=20/400/8902`）。
6. 生成差分金样：**只有旧纯静态实现还在盘上时才可能**——`npm run golden`
   （`test/parity/generate.mjs`）拿旧实现逐手跑同一颗种子，产出「新旧零差异」的证据。
   2026-10-01 重构收尾把 `js/**` **删除**之后，生成器已无对照物：它只打印中文说明并 `exit 1`（**属预期**）。
   所以新增棋种的金样只能**从零建立**（直接由新引擎 `selfTest` + mock 自对弈产出），
   并在 PR 里写清「这不是新旧差分，而是新基线」，同时按
   [../../test/parity/README.md](../../test/parity/README.md) §2 的产物表登记、§7 走例外登记。
7. 验收：`npm run test:engines` + `npm run typecheck`；
   再更新 [../status.md](../status.md)「已验证」、[../memory/MEMORY.md](../memory/MEMORY.md) 顶部一条、
   commit 用 `feat(<id>): …`。

## 2. 修一个规则 bug

1. **先复现**：在 `test/engines/` 或 `test/core/` 写一条**会失败的**断言
   （报错信息里带局面、着法、期望值），先看它红。
2. 最小修复：只改 `src/core/engines/<id>.ts` 里对应的一段规则，不做「顺手重构」。
3. 补边界：同一规则的反例也要有用例（例如禁手：既验「该判的判了」，也验「不该判的没判」）。
4. 记取舍：为什么这么判（规则来源、与既有行为的关系）写进 commit message；
   影响对外行为的写进 [../status.md](../status.md)「已知限制」。
5. 验收：`npm run test:engines`（**金样差分必须仍然全绿**——如果它红了，说明你改的是行为而不是 bug，
   走 [../../test/parity/README.md](../../test/parity/README.md) §7 例外登记，不要改金样文件）。

## 3. 调整 Jev 请求 / prompt / 采样

1. 读 [../jev-api.md](../jev-api.md) §1（上游契约）与 §2（渠道）。
2. 改 `src/core/jev/client.ts`（请求组装、退避、成本、十二级战术接管）或
   某引擎的 `serializeForJev`（state 形状、`questions`/`criteria` 标签、`board_ascii` 之类的事实注入）。
3. **不要拆三问**：`move`(choice) + `edge`(noul) + `position`(score) 必须一次并行发出
   （[AGENTS.md](../../AGENTS.md) §2 硬性规则 6）。
4. 涉及战术注入时同步 `src/core/tactics.ts` 与 `src/core/tactics-versions.ts`，
   并在决定面板能看到 `meta.tactics` / `meta.tacticsVersion`。
5. 验收：`npm run test:worker`（代理路径的错误码与限流）+ `npm run test:engines`（战术层与
   `serializeForJev` 契约断言）；改 prompt 后建议真跑一局并在 [../status.md](../status.md) 记观察结论。
6. **BYOK 红线**：key 只允许出现在 localStorage / 请求头 / 服务端环境变量；
   任何日志、URL、响应体里出现 key 值都是 bug。

## 4. 改 UI / 交互 / 决策面板

1. 读 `src/ui/README.md`：§1 模块职责、§2 幂等策略（`render-*` 重建子树 / `sync-*` 就地更新 /
   `init-*`+`bind-*` 只绑一次，用 `dom.onOnce()` 的 WeakMap）、§3 存储注入、§4 DOM 契约。
2. 归一化路径：新面板放 `src/ui/panels/<name>.ts`，通过 `src/app/panels.ts` 装配进对局循环；
   需要新 DOM 时先在 `index.html` 加结构，再同步 §4 的表。
3. **别破坏三样东西**：
   - `?test=1` 自检入口（`src/app/boot.ts:191` 读 `location.search` → `src/app/self-test.ts` 的 `runTests`，
     面板靠 `#testPanel` + 逐字保留的 `hidden` 语义）；
   - 存储键名（`jev_qiguan_records_v1` / `jev-exp-history-v1` / `jev_qiguan_panels_v1` /
     `jev_qiguan_sidetab_v1`）——换键名等于清空所有人的本地数据；
   - `session.epoch` 竞态防护（主动权在 `src/app/loop.ts`，UI 只通过装配层回调）。
4. 新的设置项要同时接进 `src/core/persist.ts` 的 `loadSettings()`/`saveSettings()`
   与设置面板（并按渠道处理 `endpoints` 这种 map 型字段）。
5. 验收：`npm run test:ui` + `npm run typecheck`；改动涉及布局/滚动条时
   `test/ui/layout-css.spec.ts` 会兜住（它按 `styles/` → `css/` 顺序探测样式目录，
   而 `css/` 已随重构删除，实际只会命中 `styles/style.css`；
   它会把目录下所有 `.css` 拼起来断言，所以拆分子样式表不用改测试）。
   真机验证：`npm run smoke:browser`（真 Chrome over CDP，`--offline` 验无后端降级）。

## 5. 改部署 / 代理 / cron

1. 读 `wrangler.jsonc`（每行都有取舍注释）+ [../adr/0010-worker-static-assets-replaces-pages.md](../adr/0010-worker-static-assets-replaces-pages.md)。
2. 改配置后注意：
   - `assets.run_worker_first = ["/api/*"]` 不能去掉，否则未命中的 `/api/*` 会被 SPA 兜底
     变成 `index.html + 200`；
   - `compatibility_date` 刻意停在 `2026-08-22`（测试运行器内嵌的 workerd 只认到这一天），
     抬它要同时确认 `@cloudflare/vitest-pool-workers` 已升级；
   - **改 `triggers.crons` 必须重新 deploy 才生效**。
3. 代理相关改动（`src/worker/routes/jev.ts`、`src/worker/lib/upstream.ts`）坚持 BYOK：
   Worker 只转发与限流，不落 key、不重试。
4. 验收：`npm run test:worker`；本地 `npm run dev` 起真 workerd 手测；
   线上冒烟 `npm run smoke:live`（默认打 https://jevqipan.logicc.top）。

## 6. 发版 / 推送

1. 编排者跑全量：`npm run typecheck` → `npm test` → `npm run check:docs`。
2. 更新 [../status.md](../status.md) 的「最后更新：YYYY-MM-DD」与 [../memory/MEMORY.md](../memory/MEMORY.md) 顶部条目
   （`check:docs` 会校验 memory 首条日期不早于第二条、status 日期不超过 30 天）。
3. 提交：Conventional Commits，注释/文档/commit message 用中文，代码标识符用英文；
   一个 commit 只做一件事。
4. 部署是**手动**的：`.github/workflows/deploy.yml` 走 `workflow_dispatch`
   （可选先对远程 D1 应用迁移）；本地部署用 `npm run deploy`（需 `CLOUDFLARE_API_TOKEN`）。
   **push 不会自动部署**，也**不会**让旧站 `jev-qiguan.pages.dev` 变新——它是迁移前的只读旧站。
5. 发版后可选核对：`npm run smoke:live`（HTTP 冒烟）、`npm run verify:backup`（备份校验）、
   `npm run db:export`（导出远程库到 `backups/`）。
