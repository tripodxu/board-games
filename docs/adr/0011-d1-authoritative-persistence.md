# ADR-0011：D1 成为唯一权威持久化（GitHub-as-database 退役）

- 状态：accepted（2026-10-01）
- 取代：[ADR-0005](0005-zero-dep-node-backend.md) 的持久化部分；[ADR-0003](0003-byok-proxy.md)（BYOK）不受影响，继续有效
- 背景：此前棋谱与实验数据的「数据库」是 Git 仓库本身——`functions/api/games.js` 用
  `GAMES_GITHUB_TOKEN` 把每局棋谱 commit 进 `games/<日期>/`，实验归档读写
  `data/experiments.json`，`/api/stats` 用 1 次 git trees + ≤40 份 raw 拉取做聚合。
  由此产生的问题（全部有代码证据）：
  1. 持久化绑死 PAT，未配置即静默失败；
  2. `/api/stats` 受免费版 50 子请求限制，只能聚合最近 **40** 份（`truncated` 明示）；
  3. 无索引、无分页、无查询：列棋谱靠「最近 7 天目录」硬编码；
  4. 每局 = 一次 git commit（噪音、延迟、与部署耦合，`[skip ci]` 就是为此打的补丁）；
  5. 无法承载「按设备/按用户」的视图，实验历史换设备即丢；
  6. 归档按**文件名时间戳**归版，遇到部署滞后必然说谎（`DEPLOY_LAG` 台账是补丁）。

## 决定

1. **D1 数据库 `jev-qiguan` 是唯一权威持久化**；仓库 `games/` 冻结为历史归档，不再写入。
2. 数据模型五张表（完整 DDL 见 `migrations/0001_init.sql` 与计划 §4）：
   - `games`：可查询字段全部列化（棋种 id、胜负、终局裁决来源、双方渠道/战术档/思考时长、
     实验标签、代码版本、战术版本、成本与时延、`first_win` 校准真值），完整原始记录留在
     `payload` 列（保真导出/回放）；
   - `game_moves`：逐手明细（着法、保险标记、每手战术版本、模型/置信度/概率/名次/耗时）——
     把「每手归因」从 JSON 里解放出来，供 SQL 分析、回放器与开局库；
   - `experiments`：按 `tag` upsert，`tacA/tacB/thinkA/thinkB` 原样保留（同渠道 A/B 的
     唯一可分辨依据，历史上踩过）；
   - `devices`：匿名归属（见 ADR-0013）；
   - `rate_limits`：跨 isolate 的固定窗口限流（见 ADR-0013）。
3. **幂等写入**：`game_uid`（前端 `crypto.randomUUID()`）为对局身份，`dedup_key =
   sha1(exported|game_uid|notation)` 唯一索引；重复提交返回 `dedup:true` 而非 500/覆盖。
4. **一次性导入历史数据**：`scripts/import-archive.mjs` 把 54 份棋谱 + 6 轮实验灌库，
   `scripts/verify-parity.mjs` 与旧口径逐项对账（差值必须为 0）。
5. **容量护栏**：单行 `payload` > 512 KB 直接 413；单局写入 = 1 + 手数 行；
   `/api/stats` 改为 SQL 聚合（无截断），重聚合走缓存表（后续）。
6. **修掉身份缺陷**：旧棋谱的 `gid` 实为**棋种 id**（54 份棋谱去重后仅 1 个值），
   不能作为对局身份；新导出增加 `gameUid` 与结构化 `winner`/`endReason`/`gameId`，
   服务端对缺失字段做推导以兼容旧客户端。

## 后果

- 优点：统计不再截断；归档可分页/筛选/永久链接；实验与战绩跨设备统一；
  校准样本来源唯一；版本归因从「文件名时间窗猜测」升级为**列上的真实值**，
  `DEPLOY_LAG` 台账与 `auditCode` 的部署滞后猜测可以退役；
  为回放器、开具体验注入（SQL 化）、排行榜提供数据基础。
- 缺点：引入有状态服务（需备份策略：每日 `wrangler d1 export` + JSONL 导出）；
  受 D1 免费额度约束（10 万行写/日 ≈ 440 局/日；超限降级为只写主表）；
  多了一套 schema 迁移纪律（`migrations/` 只增不改）。
- 约束：`migrations/` 一旦应用到 remote 不得修改历史文件，只能追加新迁移；
  任何查询必须走索引并带 `LIMIT`（禁止全表扫）；`payload` 是保真副本，
  列化字段是派生——两者不一致时以 `payload` 为准并修列。

## 考虑过但放弃

- **KV**：无 SQL、无二级索引、无事务，统计与开具体验注入都要全量拉取，等于把
  「40 份截断」换成「KV 列表分页地狱」。
- **R2**：对象存储适合放棋谱原文件（与今天的 `games/` 同构），但不解决查询问题；
  留作 D1 存储逼近上限后的归档方案（届时新 ADR），本轮不引入额外绑定。
- **Durable Objects**：只有「实时对战/强一致协作」才需要，本轮无此需求。
- **保留 Git 双写（D1 + commit 进仓库）**：每局多一次外部 API 调用与去重/补偿逻辑，
  换来的只是 git 里的可审计副本——而 D1 的 `payload` 列已能完整导出，
  真要审计用 `npm run db:export` + JSONL 即可。
- **继续沿用 JSON 文件（server.js 那套）**：Workers 无文件系统；且文件方案在本项目
  已到瓶颈（无查询、无并发写、无归属）。
