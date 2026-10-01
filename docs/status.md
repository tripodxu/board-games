# 项目状态

> **每次行为变更后更新本节**（不写流水账）。最后更新：2026-10-01。

## 当前状态

**v1.0：Cloudflare Worker + D1 已上线，前端由 Vite/TypeScript 构建。** 入口是自定义域 <https://jevqipan.logicc.top>（`*.workers.dev` 不是入口）。旧形态「纯静态站 + 三套后端（零构建、零依赖）」已被取代，正式决策见 [ADR-0010](adr/0010-worker-static-assets-replaces-pages.md)～[ADR-0013](adr/0013-anonymous-device-identity-and-d1-ratelimit.md)；架构与数据流见 [architecture.md](architecture.md)；迁移全过程见 [plans/2026-10-01-workers-d1-rebuild.md](plans/2026-10-01-workers-d1-rebuild.md)。

| 面 | 状态 | 说明 |
| --- | --- | --- |
| 边缘后端 | ✅ 已上线 | Worker `jev-qiguan`（Hono）；8 条 API：`/api/health`、`/api/games`、`/api/stats`、`/api/experiments`、`/api/openings`、`/api/leaderboard`、`/api/jev`、`/api/export` |
| 静态资产 | ✅ 已上线 | Workers Static Assets，Vite 产物；`/api/*` 由 `run_worker_first` 保证进 Worker，其余回落 SPA 外壳 |
| 数据 | ✅ 已迁入 D1 | 数据库 `jev-qiguan`（WNAM），`database_id = f72390fe-a506-4a88-8db7-af7213657947`；见下「数据现状」 |
| 定时任务 | ✅ 已挂 | Cron `17 3 * * *`（UTC），首次真实执行为 2026-10-02T03:17Z |
| 棋种 | ✅ 七种 | 五子棋、五子棋·禁手、围棋（9 路）、象棋、国际象棋、西洋跳棋、中国跳棋；引擎在 `src/core/engines/`，注册顺序见 [registry.ts](../src/core/registry.ts) |
| 渠道 | ✅ 六个选项 | `official`、`openrouter`、`proxy`（同源 `/api/jev`）、`rapfi`、`mock`（离线演示）、`random`；定义见 `src/core/jev/client.ts` |
| 面板 | ✅ 已就绪 | 驾驶舱 / 决策流 / 战绩簿 / 校准实验室 / 战术沿革 / 设置抽屉 / 归档面板 / 回放器 / 排行榜 / 开具体验全部接线（`src/app/panels.ts` 的 `renderDataPanels` + `loadLeaderboardPanel` / `loadOpeningsPanel`，回放器由归档面板逐手驱动，归档面板首屏 50 份 + 「加载更多」按 keyset 游标追加） |
| 棋谱上传 | ✅ 已上线 | 终局后进上传队列（本地去重 + 退避重试），`POST /api/games` 落 D1；重复提交返回 `dedup: true` 且写 0 手 |
| 账号体系 | ⛔ 不做 | 匿名 `X-Device-Id`，无登录（ADR-0013） |
| 旧实现 | ✅ 已删除 | 2026-10-01（P8）：`js/**`、`functions/**`、`legacy.html`、`server.js`、`dev-proxy.py`、`css/**`（→ `styles/style.css`）、旧测试三件套 `test/{run-tests,server-tests,rapfi-tests}.js`。对照表见 [architecture.md](architecture.md) §9 |

> **版本口径已统一为单一来源**：`package.json` 的 `version` 与 [wrangler.jsonc](../wrangler.jsonc) 的 `vars.APP_VERSION` 现在都是 `1.0.0`，由 `test/core/version.spec.ts` 逐字钉住；前端写进棋谱的 `codeVersion` 形如 `1.0.0+<git short sha>`（`vite.config.ts` 构建期把 `APP_VERSION` + `BUILD_SHA` 注入 [src/shared/version.ts](../src/shared/version.ts)）。旧「按文件名时间窗归因 + 手工 bump `BG.codeVersion`」已退役。

## 数据现状

线上 D1 与导入产物一致（来源：计划 P4 执行记录，以及 [migrations/import/manifest.json](../migrations/import/manifest.json)）；
2026-10-01 下午起 D1 里多了**真跑出来**的 4 局（见下「真实验」一行），导入基线仍是 54 局 / 4379 手：

| 项 | 值 |
| --- | --- |
| 棋谱 | **58 局 / 5279 手** = 导入基线 54 局 / 4379 手（全部五子棋；日期 2026-09-29 与 2026-09-30）**+ 4 局真实验**（2026-10-01，各 225 手，tag `exp-20261001132645`，54 份归档源仍是 [games/](../games) 那 54 局） |
| 实验轮 | 7（导入 6 轮 + 2026-10-01 真跑的 `exp-20261001132645`） |
| payload 总量 | 845578 B（54 局导入部分；最大单局 68.7 KB，远低于 512 KB 上限） |
| 设备 | 0（历史导入与实验归档都不带设备 id；`device_id` 为 NULL） |
| 一致性 | `game_uid` 去重后 58、孤儿 `game_moves` 0 行 |

- **真实验（2026-10-01，proxy 渠道，4 局全和棋）**：`node scripts/experiment-run.mjs --games 4` 跑满
  A=`proxy/v9-vcf-sound` vs B=`proxy/v8-vcf-try`，902 次上游调用 / 输入 2586521 token / 输出 438798 token /
  约 $0.109 / 用时 1854 s，逐局落库 4 行（`tokens_in` 约 645K、`cost_usd` 约 $0.0272、`latency_avg_ms` 930–1056）。
  四局**全部 225 手「和棋（棋盘已满）」**：两个战术档在这套开局下都攻不穿对方，A/B 无胜负差。
  证据 `.work/experiment-run-2.json`（不入库）。同一批负载在旧 30/分 限流下会死在第 1 局，这次窗口峰值 34/分、**零 429**。

- 源归档 [games/](../games) **冻结只读**：它是金样、对账与归因用例的源数据，不再写入（说明见 [games/README.md](../games/README.md)）。
- 迁移期导入 SQL 在 [migrations/import/](../migrations/import)（`manifest.json` + `0001_games.sql`）。
- 一次线上导出的快照留在 `backups/export.sql`（`npm run db:export` 的产物，1.9 MB / 7 张表，含 wrangler 的 `d1_migrations` 记账表；`backups/` 不入库，需要时重新导出）。

## 已验证（验收证据）

- **对新旧两套入口对账**（计划 P4 执行记录）：`node scripts/verify-parity.mjs --base https://jev-qiguan.pages.dev --candidate https://jevqipan.logicc.top` → **差值 0**（54 局 / 五子棋 54 / 胜负 18-27-9 / 校准样本 26）。旧入口的截断口径仍是 40 份、胜负 16-16-8——差值 0 说明新侧不是靠「也多读一点」蒙对的。
- **线上 HTTP 冒烟**（计划 P4 执行记录）：`npm run smoke:live` **29 项全过**（列表不含 payload、永久链接与列表指向同一局、旧深链带/不带 `.json` 都 200、`/api/stats` 无 `truncated`、导出为 JSONL、无 key 的 `/api/jev` 401、非法设备与非法日期 400、重传归档棋谱 `dedup: true` 且写 0 手、新房写 5 手、写后总数 54 → 55）。冒烟写入的行已删除，D1 复原 54/4379/0。
  2026-10-01 下午起该脚本改为 **30 项**，且总量断言一律**相对基线**（`stats.byGame` 只断言键是中文棋种名，`/api/experiments` 断言轮次 ≥ 6，写入后断言「基线 + 1」）——真实验一多，写死 54/6/55 就会天天空红（实测 `58 → 59` 通过；负向对照把 `+1` 改成 `+2` → 恰好那一项红、退出码 1）。
- **引擎行为不变**（2026-10-01 实跑 `node test/engines/run.mjs`）：金样自对弈逐手一致 —— 五子棋 17 / 五子棋·禁手 15 / 围棋 89 / 象棋 600 / 国象 169 / 跳棋 103 / 中国跳棋 138；归档 **54 局 / 4379 手逐手一致**。唯一已知不一致是 `games/2026-09-30/jev-v9-vs-jev-v8-20260930153334.json`（归档记「黑方 获胜（认输）」，引擎判 `null`）——引擎不建模认输，属预期，只记录不阻断。
- **文档卫生**（2026-10-01 实跑 `npm run check:docs`）：41 个 md 的相对链接全部可解析，MEMORY 置顶正确，status 日期在 30 天内。
- 迁移各阶段的实测数字与偏差裁决见计划 P0–P8 执行记录（含本地导入 4440 changes、7 张表、线上部署版本号等）。

## 设计例外（有意保留，不是遗漏）

1. **装饰性发丝线保持低对比**：面板描边与分隔线用的 `--line` / `--line-strong` 是「月白」视觉世界的一部分，对比度低是有意的；功能性控件边界另用 `--line-ctl`（≥3:1，满足 WCAG 1.4.11）。不要为了「统一」把两者一起加深。
2. **侧栏存在 11px / 11.5px 正文**：战绩簿 7 列表格、指标标签、棋谱流水属于密集数据面板，提到 14px 需要重排并显著降低信息密度；正文高于 11px 的部分均已达标。
3. **`#promoBox` 用「明确边 + 中等投影」**：1px `--mo` 边（对白底 15.6:1）+ 28px 投影。自动检测器无法区分「明确边」与「发丝线」，不要按检测器的建议去改。

## 已知限制

### 已修复（旧限制 → 现在怎么做的）

| 旧限制 | 现在的做法 |
| --- | --- |
| `BG.codeVersion` 是手工常量，忘记 bump 就导致归因失效 | 构建期注入：`vite.config.ts` 用 `define` 注入 `__APP_VERSION__` / `__BUILD_SHA__`，[src/shared/version.ts](../src/shared/version.ts) 组成 `CODE_VERSION` |
| 归档按文件名 stamp + 时间窗口归版（说不准是哪版代码下的） | 归因只认数据自带的声明：`payload.meta.code` → `games.code_version`，每手 `ai.tv` → `tactics_version`；没有声明就是 `unknown`，不推断 |
| `/api/stats` 受 50 子请求限制，只聚合最近 40 份，响应里带 `truncated` | 聚合搬到 D1 的 SQL 侧（三条 `GROUP BY`），`truncated` 字段彻底删除；冒烟第 12 项专门断言它不存在 |
| 限流是 isolate 内存里的 Map，换个 isolate 就失效 | D1 的 `rate_limits` 表做固定窗口计数（ADR-0013） |
| 列棋谱硬编码「最近 7 天」 | `since` 显式参数 + keyset 游标（`id < cursor`，`limit ≤ 100`），不再有隐式窗口，也不再截断 |
| 归档面板只取第一页，`limit: 100` 之外看不到（即便服务端早就支持游标） | `src/app/records.ts` 按 `ARCHIVE_PAGE_SIZE = 50` 取首屏，底部「加载更多」带 `?cursor=` 追加下一页并在没有下一页时收掉按钮；失败时保留已载入的行并让按钮恢复可点（实测 54 局：50 → 54，`smoke:browser` 第 10 项守这条路） |
| 每局一次 git commit 归档，依赖 `GAMES_GITHUB_TOKEN` | 棋谱直接落 D1；导出/备份走 `/api/export/games`（JSONL）与每日 D1 export |
| 持久化是本地 JSON 文件，`server.js` 与 `dev-proxy.py` 还抢 8788 端口 | 本地 Node 后端已退役（ADR-0011）；`npm run dev` 起的是 Vite + 本地 workerd + 本地 D1，与线上同一套代码 |
| 实验归档只在本机 localStorage，换台机器就看不到 | `experiments` 表 + `/api/experiments`；离线时仍退化为本机战绩簿（有意，见下） |
| `?test=1` 校准自检夹具自相矛盾（`src/core/view/calibration.ts` 的 `selfTest` 期望值与样本对不上，面板必亮红） | 夹具按定义重算并补齐 F/G 两组：混合组期望改 `ece/mce = 0.54/0.9`、`brier = 0.306`，另加「全赢 → `skill=null` 但不许 NaN」的退化组；`test/app/boot.spec.ts` 断言 `?test=1` 面板**零失败** |
| `#expStopBtn`（「停止实验」）与 `#speedRow`（机机速度行）永不显示 | 根因是显隐写法只有一半：`index.html` 里被运行时开关的节点分 `class="hidden"`（对局按钮）与 `hidden` 属性（P6a 侧栏面板）两种，旧实现只切 class。`src/app/panels.ts` 的 `setVisible()` 现在两种一起切，`setHidden` 的调用点全部改走它 |
| `index.html` 外壳硬编码「黑方 Jev」，标题写「六种棋类」而实际七种 | 标题/描述改为「七种棋类对弈」；双方名改成由装配层写入的空槽（`#duelFirstName` / `#duelSecondName`，缺省文案「黑方」/「白方」），渠道名不再写进 HTML |
| 版本双源不一致（Worker `1.0.0` vs 前端 `0.3.0+sha`） | 两源都改 `package.json` 的 `version`（现 `1.0.0`），`test/core/version.spec.ts` 逐字比对两处并钉住 `vite.config.ts` 仍从 `pkg.version` 注入 |
| 样式表仍在 `css/`，与计划的 `styles/` 不符 | `css/style.css` → [styles/style.css](../styles/style.css)，`index.html:11` 改指 `/styles/style.css`，由 Vite 打包；`test/ui/layout-css.spec.ts` 同时探两侧，搬迁不用改测试 |
| **Rapfi 渠道在浏览器里从不走子（mock 渠道掩盖了它）** | 两个注入点都没人接线：`src/core/jev/rapfi.ts` 的 `setLoader()`/`setGlueUrl()` 浏览器侧从未调用，`src/core/jev/client.ts` 要求的 `opts.rapfi` 也没人注入。修法：新增 `src/app/rapfi-loader.ts`（`loadRapfiModule` + `installRapfiLoader`），`src/app/boot.ts` 启动时安装，`src/core/jev/index.ts` 的 `decide()` 默认补 `rapfi: decideRapfi`；`test/app/rapfi-loader.spec.ts` 7 例钉住（含端到端 `decide()`），线上 `--channel rapfi` 浏览器冒烟 14/14 |
| 实验报告只按「Jev 渠道 / 其他」两个桶对比：两侧都是 Jev 渠道时双方落进同一桶（报「Jev 6 胜 · 其他 0 胜」），没有胜率，和棋也没拆出来 | `src/ui/panels/experiment-report.ts` 改为按「渠道 · 战术版本 · 思考深度」分身份统计（`expSideStats()`），身份从局号奇偶推 A/B 执黑（`aIsBlack`），**得分率 =（胜 + 和 ÷ 2）÷ 局**、`dup` 局不计；累计区变成分桶表（局/胜/和/胜率条），每轮多一条 A/B 单轮得分率条。`test/ui/experiment-report.spec.ts` 5 例 + 两次负向对照（判据写反 / 和棋不算半分 → 各 2 例红） |
| **服务端实验战报从来没并进报告面板**（生产 6 轮实验，面板永远只显示本机种子的 2 轮） | Worker 的 `GET /api/experiments` 响应体是包装对象 `{experiments:[…]}`，P6 装配时按「客户端已解包」写成 `Array.isArray(r)` 判断 → 静默返回。修法：`src/core/api/client.ts` 的 `listExperiments()` 统一解包（兼容裸数组，其余形状 null），`src/app/backend.ts` 的注释与判据同步修正；`test/app/experiments-merge.spec.ts` 3 例钉住（含「同 tag 局数变多才覆盖」与坏形状不抛），`smoke:browser` 新增在线断言（实测本机种子 2 轮 → 面板 6 轮 / 38 局有效） |
| **报告面板只看得见早期实验**：轮次卡按 `experiment` tag 分组，而归档里最新的一批机机对局（`jev-v9-vs-jev-v9` 等）根本没挂 tag → 永远进不了卡片，6 轮实验全是 2026-09-29/30 的 | 报告面板顶部新增「最新棋谱」块：装配层取 `GET /api/games?limit=10`（`LATEST_GAMES_LIMIT`）整形为 `LatestGameRow[]`（时间/棋种/手数/双方归因/结果/可选 tag#局号，缺 `gameUid` 的行丢弃），`src/ui/panels/experiment-report.ts` 的 `renderLatestGames()` 渲染，每行「回放」直接调 `openReplayer()` 载进回放器；boot / 归档「刷新」/ 每轮实验结束三处都会重取。`test/ui/experiment-report.spec.ts` 6 例 + `test/app/latest-games.spec.ts` 3 例（含点回放真的走 `/api/games/u/:uid`），三组负向对照（去掉 uid 过滤 / 渲染改成 appendChild / null 与 `[]` 共用文案 → 各红） |
| **自家限流把整轮对比实验挡死在第 1 局**：`jev` 档 30 次/分/IP，机机对局一个 60 秒窗口打到 34 次；客户端旧写法 4 次尝试（1+2+4 秒）熬不过窗口，且**限流分支从不给 `lastErr` 赋值** → 抛出的文案是「重试次数用尽」，真实原因（被自己限流）完全看不出来；机机对局又没人点「重试」，于是整轮实验报废 | 传输层：`src/core/jev/client.ts` 的 `callWithRetry` 重写 —— 限流（429/529）独立计数 5 次、按 `Retry-After` 退避（截 20 秒）、每次都留带状态码的错误并打 `retryable` 标记（401/4xx 为 `false`）。装配层：`src/app/loop.ts` 的 `aiStep` 对 `retryable` 做自动退避重试（`AI_AUTO_RETRY_DELAYS_MS = [4000, 12000, 25000]`，期间**不暂停**），成功/手动重试/重开一局都清零额度。配置：`jev` 档改由 `vars.JEV_RATE_LIMIT_PER_MIN` 覆盖（生产 60，60×1440 ≈ 8.6 万 < 10 万行/日）。`test/core/jev-retry.spec.ts` 5 例 + `test/app/ai-auto-retry.spec.ts` 2 例；三组负向对照（不遵守 `Retry-After` / 尝试次数降回 4 / `retryable` 改 false / 关掉自动重试分支）各自红了对应用例 |
| **实验运行脚本会自欺**（`scripts/experiment-run.mjs`）：计量器按绝对路径 `/api/jev` 匹配，而代理端点是相对串 `api/jev`（`src/core/jev/client.ts:29`）→ 永远报「上游 0 次（错 0）」，恰好藏起唯一证据；失败时台账 `history[0]` 还是上一轮的 tag → 归档核对会拿旧数据当本轮成绩；页面停在「等人工重试」时无人可点 | 计量器同时认两种写法并记录 HTTP 状态序列（心跳里直接打出来）；开跑前记台账基线，跑完**只认基线之外的新条目**，没跑满就跳过归档核对；轮询中发现 `#retryBtn` 可见就代点并计数（`report.retryClicks`）；退出码新增 `done` 条件（未跑满一律非 0） |

| **`smoke:live` 把数据总量写死在断言里**：`stats.byGame === '{"五子棋":54}'`、`/api/experiments` 恰好 6 轮、写入后 `totalGames === 55` —— D1 现在是活的，真实验一多这三项就红（2026-10-01 真跑 4 局后实测 27/30） | 断言改成**相对基线**：`byGame` 只校验键都是七个中文棋种名且「五子棋」在册，轮次断言「≥ 6 且每轮有 tag」，写入后断言「跑前基线 + 1」（实测 `58 → 59`）。负向对照把 `+1` 改成 `+2` → 恰好那一项红、退出码 1；随后 30/30 通过 |

### 仍存在（2026-10-01 口径）

1. **引擎棋力**：对强搜索引擎的实战记录仍是 0-4（对弱/中对手 8-0-1）。迁移前后引擎逐手一致，这条没有变化。
2. **规则类未实现**：象棋长将/长捉判负、国象三次重复判和、中国跳棋「永堵营地门」都未实现；围棋只有 9 路。
3. **官方 API 浏览器直连不可行**（CORS 白名单），必须走同源 `/api/jev` 代理；未带 key 时返回 401。
4. **Jev 的概率判断仍可能出错**：「零幻觉」只保证输出结构体，不保证棋力判断正确。
5. **Rapfi 渠道**：单线程同步思考会阻塞 UI（思考中先 paint 一拍再同步跑完）；只支持五子棋；首次要下 10.7 MB 资产（`npm run smoke:browser -- --channel rapfi` 已能自动验完这条路，实测 14/14，等待窗口 90 s）。
6. **战术档闸门**只影响 Jev 三渠道与 `random` 基线，`mock` / `rapfi` 早退不受影响。
7. **`sideConfig` 是一份全局设置**（localStorage 键与旧实现逐字兼容），不按局快照；实验会借走并在结束后归还。
8. **沿革竖列与设置抽屉改的是全局默认档**，不影响已经开打的那一局。
9. **移动端触控未专门优化。**
10. **历史归档的 `tactics_version` 恒为 NULL**：54 份归档里 54/54 都没有每手 `ai.tv` 声明，因此历史只能按 `code_version` 归因（unknown 28 / 0.7.0 20 / 0.8.0 6，且 20+6 全部落在 2026-09-30）。新写入的局才有每手 `ai.tac`。`tactics-versions.ts` 里 `VERSIONS[].games` 是迁移前的冻结快照，不是实证数字。
11. **旧深链对历史棋谱大多无效**：54 份里有 48 份没有 `slug`，`/api/games/:day/:name` 解析不到，只能用列表返回的 `path` 或永久链接 `/api/games/u/<gameUid>`。
12. **`*.workers.dev` 不是入口**（wrangler 默认关闭；本机网络也无法直连），唯一入口是自定义域 `jevqipan.logicc.top`。
13. **本地无法用 `--test-scheduled` 预演 Cron**：静态资产会先接管非 `/api/*` 路径，`/__scheduled` 拿回的是 SPA 兜底 HTML（200），`stats_cache` 不会有行——这不是 cron 失败。
14. **备份靠 CI 每日导出**（UTC 04:23，artifact 保留 30 天）；Worker 侧做不到 D1 导出。本地 `npm run db:export` 需要本机网络能连上 Cloudflare。
15. **离线降级是有意设计**（D8）：没有后端时是离线演示（mock 渠道）+ 本机战绩簿，不是白屏也不是报错。
16. **限流的两个已知取舍**：每次判定写一行（读接口的限流也消耗当天写配额）；固定窗口边界允许 2× 突发。
17. **`node:sqlite` 缺失时**，重放迁移的归因用例会被跳过；CI 用 `REQUIRE_SQLITE=1` 强制硬失败。
18. **`npm run golden` 预期失败**：金样生成器 `test/parity/generate.mjs` 依赖旧实现（旧引擎自对弈），旧实现在 P8 删除后它只打印中文说明并 `exit 1`。这是**设计如此**——金样已冻结为只读文物（封条 `test/parity/frozen.json`），本来就不该再生成。
19. **`src/ui/README.md` 的模块职责表未收录 P7c 三个面板**（`panels/replayer.ts` / `leaderboard.ts` / `openings.ts` 只在 §4.1 单独说明；`openings.ts` 的 `GAME_IDS` 属公共注册项）。
20. **浏览器端不发送 `X-Device-Id`**：`src/core/api/client.ts` 的 `call()` 只设 `Content-Type`，所以 UI 归档的棋谱 `device_id` 为 NULL，「只看我的」（`?device=me`）只有冒烟脚本这条路走得通。写路由对 `deviceId` 缺失是容忍的（外键只在有值时成立），落库不会失败——这是**待决**而非缺陷：要么让客户端带设备头，要么承认归档是公共的并撤掉 `device=me`。
21. **`jev` 档限流仍会挡住极端场景**：60 次/分对「机机对局 + 对比实验」够用（实测约 31 次/分），但同一出口 IP 下同时跑多个实验、或一轮里双方都用最慢思考档，仍可能触顶；触顶时的表现是自动退避重试（最多 3 次，约 41 秒窗口），再失败就交给用户。
22. **`games.tokens_out` 是一列死数据**：一局汇总 `aiGameMeta()`（`src/core/meta.ts:62-82`）只累加 `usage.input_tokens` 进 `meta.tokens`，导出的 `meta` 里**没有**输出 token；而 `src/shared/record-map.ts:376` 读的是 `meta.usage?.output_tokens`（局级 meta 从来没这个字段）⇒ 该列恒为 NULL。实测真实验 4 局的 `tokens_in` 约 645K 全都落库，`tokens_out` 全为 0。影响仅限「输出 token 的分析口径」（计费按官方口径输出免费，成本列不受影响）；要修就是给 `AiGameMeta` 加 `tokensOut` 并在 `record-map` 里回落读取——属可选增强，未做。

## 验收命令表

命令行里的脚本全部来自 [package.json](../package.json)（`npm test` = 引擎套件 + vitest 三个 project，**不含 `test:tactics`**，要单独跑；实测 34 个测试文件 / 334 个用例）。

| 命令 | 验什么 | 什么时候跑 |
| --- | --- | --- |
| `npm test` | `test:engines` + `test:new`（vitest 三个 project 一次跑完） | 提交前的总闸 |
| `npm run test:engines` | 引擎自检、战术九级与 VCF、**金样逐手差分**、54 局归档逐手重放 | 改引擎 / 战术层后必跑；也是最省事的一次全量回归 |
| `npm run test:tactics` | 战术层独立回归（`test/tactics/run.mjs`） | 改战术层时 |
| `npm run test:worker` | 真 workerd + 真 D1 的 HTTP 契约与维护任务 | 改 `src/worker/**`、`migrations/**` 后 |
| `npm run test:ui` | happy-dom 下的视图层与装配层运行时断言 | 改 `src/ui/**`、`src/app/**`、`index.html` 后 |
| `npx vitest run --project core` | 纯 Node：字段映射、会话、战绩簿、上传队列、迁移重放归因、版本双源一致性 | 改 `src/core/**`、`src/shared/**` 后 |
| `npm run typecheck` | TypeScript 全量类型检查（无输出） | 提交前 |
| `npm run build` | Vite 生产构建（静态资产 + Worker 产物） | 部署前 / 排查产物问题 |
| `npm run dev` | Vite + 本地 Worker + 本地 D1（`predev` 先迁移本地库，但**不导数据**） | 日常开发；本地库要数据需再跑 `import:archive --local` |
| `npm run db:migrate:local` / `db:migrate:remote` | D1 迁移（本地 / 远程） | 新增 `migrations/*.sql` 后 |
| `npm run import:archive` | 把 `games/**` 与实验归档导入 D1（`--local` / `--remote`） | 需要重建库时（幂等：用 `dedup_key` 去重） |
| `npm run verify:parity` | 新旧两套入口按同一口径对账，差值必须为 0 | 切流前后、改聚合口径后 |
| `npm run verify:backup` | 备份可重建（`--structural` 是定时任务用的结构模式） | 拿到 D1 导出后 / 排查数据漂移 |
| `npm run db:export` | 从远程导出一份 SQL 快照到 `backups/` | 切流前、发布前后留底 |
| `npm run smoke:live` | 真线上 HTTP 冒烟 30 项 | 部署后（**会写一行再删掉，注意线上数据**） |
| `npm run smoke:browser` | 真浏览器（CDP）冒烟 14 项（含归档分页的游标追加、实验报告分桶表、最新棋谱一键回放、服务端战报并入）；`--offline` 下三项在线断言让位给 2 项降级断言（共 13 项），`--channel rapfi` 验 wasm 渠道 | 部署后、改前端入口后 |
| `node scripts/experiment-run.mjs --games N` | 用干净 profile 的真浏览器跑一轮 A/B 对比实验并留 JSON 证据：填渠道与 key（**只从 `JEV_API_KEY` 环境变量读**）→ 点「开始实验」→ 轮询心跳（局数、上游调用次数与 HTTP 状态序列）→ 回查 `GET /api/games?tag=` 确认每局都进了 D1；页面停在「等人工重试」时代点 `#retryBtn`（计数） | 改实验面板 / 渠道 / 重试逻辑后；**会真花上游配额**，日常不跑 |
| `npm run check:docs` | MEMORY 置顶、所有 md 相对链接可解析、status 日期在 30 天内 | 改任何 md 后（CI 里也跑） |
| `npm run deploy` | `vite build && wrangler deploy` | 发布（`deploy.yml` 同样只手动触发） |
| `npm run golden` | 重新生成金样 | **预期失败，别当成坏了**：金样已冻结为只读文物（封条 `test/parity/frozen.json`），生成器依赖的旧实现 `js/**` 在 P8 删除后它只打印中文说明并 `exit 1` |

## 下一步 / 未完成

按计划 §9（DoD）与 P8 的收尾清单，尚未完成的项：

1. **归档面板**已补「加载更多」分页（keyset 游标，首屏 50 份）；仍缺按 `code_version` 分组（现在按 `tactics_version` 分组，历史归档全是「未标注」）与按棋种/渠道/标签筛选（服务端 `?game=`/`?tag=`/`?since=` 都已支持，只是面板没给控件）。
2. **浏览器全流程回归**：计划附录 C 的 10 项手工清单里，页签/棋盘/渠道/开局/落子/AI 走子/曲线/抽屉/离线降级/Rapfi 首用懒加载/归档分页/实验报告分桶/最新棋谱一键回放/服务端战报并入已由 `smoke:browser` 自动覆盖（三种渠道全绿）；仍建议人工过一次七棋种各开一局、机机模式、换边重开、对比实验、人手认输、归档逐手回放。
3. **文档**：`README.md` / `docs/architecture.md` / `docs/status.md` / `docs/jev-api.md` / `AGENTS.md` / `docs/agents/**` / `src/ui/README.md` 均已收口，`docs/README.md` 的 ADR 索引已补 0008～0013；`npm run check:docs` 绿（41 个 md / 246 个链接）。

> 已完成（P8，2026-10-01）：旧实现删除（`js/**`、`functions/**`、`legacy.html`、`server.js`、`dev-proxy.py`、`css/**`、旧测试三件套 `test/{run-tests,server-tests,rapfi-tests}.js`）、样式搬到 `styles/style.css`、`package.json` 摘掉 `test:legacy`、`index.html` 去掉硬编码渠道名与「六种棋类」、三块数据面板接线、CI 移除旧实现契约步骤并加 `REQUIRE_SQLITE=1`、版本双源统一为 `1.0.0`、Rapfi 注入接线并上线（版本 `170c9d07-584b-48b4-8117-cf4ccef19cec`）。
> 待确认（不影响功能）：Cron `17 3 * * *` 的首次落库证据要等 2026-10-02T03:17Z 之后查 `stats_cache`。
> 已完成（2026-10-01 下午，目标书「新能力」收尾）：归档面板 keyset 分页（版本 `3a4934ee-28c5-4e7e-88c9-214da988b707`）、实验报告分桶对比口径（`29788ef6-747a-4b08-9f0e-4aaea906ee36`）、服务端实验战报并入修复（`18b2fcad-39f8-4974-8e83-952076d83fa8`）、报告顶部「最新棋谱」+ 一键回放（`128ed7db-1b9d-4b84-a3a2-6ae6c9b6a10d`，当前线上）；三渠道浏览器冒烟 mock/rapfi 各 14/14、离线 13/13。
> CI 已闭环：`test.yml` 提交 `88d7a9f`（run `36852997058`）五步全绿 —— 类型检查 / 构建 / 引擎与金样逐手差分（121 用例）/ vitest（真 workerd + 本地 D1）/ 文档校验。
> 前两次红都不是代码回归：第 55 个归档文件（旧站快照自动提交、D1 无对应，已删，归档口径恢复「等于 D1 的 54 局」）、以及两处链到被 `.gitignore` 忽略的 `backups/export.sql`（已改文本，并把「不许链到被忽略的产物」写进 `scripts/check-docs.mjs`）。
> 注意 `games/` 不是物理围栏：旧 `pages.dev` 快照仍持有 `GAMES_GITHUB_TOKEN`，还能往 `games/` 提交；护栏是 CI 里的归档断言（新增/改动即红）+ 事后删除。

## 路线图（候选，未承诺）

- **回放器体验**：逐手重放之上加「跳到关键手 / 双方耗时对照」。
- **开局库视图**：把 `/api/openings` 的聚合结果做成可浏览面板（现在只有接口）。
- **设备身份可迁移**：设置面板显示设备短码、支持粘贴恢复（设备 id 现在只在本机 localStorage，换浏览器等于换身份）。
- **规则补全**：象棋长将/长捉判负、国象三次重复判和、中国跳棋堵门判负、围棋 13/19 路。
- **明确不做**（计划 §13）：账号体系、实时对战（WebSocket/DO）、运维面板、多环境 D1、额外的 R2/KV/Queues 绑定、视觉重设计、改引擎规则。

## 技术债 / 注意点

1. ~~**版本口径不统一**~~ → **已修复（2026-10-01）**：`package.json` 与 `wrangler.jsonc` 的 `APP_VERSION` 都改成 `1.0.0`，`test/core/version.spec.ts` 逐字比对两处，并断言 `vite.config.ts` 仍从 `pkg.version` 注入 `__APP_VERSION__`。改版本号＝改一处（`package.json`）再改 `wrangler.jsonc`，忘了跑测试就会红。
2. ~~**旧文案残留**~~ → **已修复**：`src/core/jev/client.ts:117` 与 `:187` 的用户可见提示已改成「本地 `npm run dev` 起 Worker，线上由 `jevqipan.logicc.top` 提供」，不再提 `dev-proxy.py` / Cloudflare Pages。
3. **导出接口是 N+1**：每局要 2 次查询 / 2 行读取。想更省需要 `src/worker/db/games.ts` 提供一个「只取 payload」的查询。
4. **`compatibility_date` 停在 2026-08-22**：这是测试运行器内嵌 workerd 的上限，上调会让 vitest 起不来；升级 `@cloudflare/vitest-pool-workers` 时才能跟着提。
5. **`wrangler.jsonc` 改 `triggers.crons` 后必须重新部署**，否则线上还是旧的调度。
6. **本地 D1 库文件名由 `database_id` 派生**：换过 id（或改了名字）就等于换了一个空库，需要重跑迁移 + 导入，否则会看到 `no such table: games`。
7. **测试库共享**：worker 项目用 `singleWorker: true`，同一实例里的 D1 是共享状态，新用例必须自己清理数据。
8. **`npm run golden` 的失败是设计如此**（见「仍存在」第 18 条），别在 CI 里把它当回归。
9. **文档索引过期**：[docs/README.md](README.md) 的 ADR 列表只到 0007，缺 0008～0013。
