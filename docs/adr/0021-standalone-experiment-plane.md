# ADR-0021：离线实验面（默认直连上游 + 本地 JSONL + 文件进度 + 对象桶留档）

- 状态：accepted（2026-10-04）
- 背景：ADR-0019 把批量对弈搬到 SSH 主机后，跑动仍**经过业主的 Cloudflare Worker**
  （`proxy` 渠道 → `/api/jev`），于是①每手都占业主 Worker 的连接数与 D1 写入额度，
  ②研究数据（数百局 × 数十手的 `game_moves`）混进站点棋谱表，③业主只能靠浏览器或
  远端 `cat` 看进度。业主原话（m13536）：「可以让这个测试全在云端服务器上本地跑，
  **不连接我自己的 cf worker，减少连接数**，但我可以通过 ssh 来检验进度，最终将结果
  上传到桶中」；m13876 再次强调「最终可以使云服务器跑 elo 大量数据，不消耗太多
  cfworker 资源」。计划：`docs/plans/2026-10-03-tactics-fidelity-and-elo-ladder.md`
  §3 D11–D14、§6 P4b。

## 事实基线（写代码前逐条验证）

1. **直连上游与 Worker 转发协议同构**：端点同为 `https://api.typesafe.ai/v1/systemone`、
   鉴权同为 `Authorization: Bearer <key>`、请求体白名单同样只取 `state`/`model`/`questions`
   （`src/worker/lib/upstream.ts:37`/`:137`）。差异只在**谁做限流与重试**。
2. **`proxy` 渠道天然绑定业主 Worker**：渠道表里它是**相对端点** `api/jev` 且只发
   `X-Api-Key`（`src/core/jev/client.ts:31`、`:98-106`），拿不到绝对地址就发不出去；
   `official` 是绝对端点 + `Bearer`（`src/core/jev/client.ts:29`）。
3. **box 出网可达**（2026-10-04 探针）：`/root/.jev-key`（`-rw-------` 121 B）+ `Bearer`
   POST 上游 ⇒ HTTP 422（`questions` 为空，**鉴权已过**）、延迟 0.315 s；box `node -v`
   v24.9.0、可用内存 1336 MiB。
4. **box 上没有 rclone/aws**，也不适合挂常驻服务（可用内存 1.3 GiB）⇒ 留档与进度都得
   用「一次性进程 + 文件」实现。
5. **本机（开发机）Node 无外网**：代理 `127.0.0.1:10808` 未运行时 `fetch` 直接
   `ECONNREFUSED` ⇒ **直连面的真验收只能在 box 上做**，本机只能做闸门与单测。

## 决定

1. **运行面默认「直连上游 + 本地落盘」**：`experiment-worker.mjs` 的 `DEFAULTS` 取
   `upstream: 'direct'`、`store: 'local'`。机械保证：不出现 `--origin` 时既不会连业主
   Worker 也不会写 D1；`--upstream worker` 与 `--store d1` 都必须**显式**给 `--origin`，
   否则 exit 2（闸门在 `scripts/lib/upstream.mjs` `upstreamGate()`）。
2. **直连面用现成的 `official` 渠道，不为实验面新造渠道**。理由：`official` 已经就是
   「绝对端点 + Bearer」，再造一个 `direct` 渠道等于把同一协议复制两份（铁律 10：战术/
   设施层只减不增）；代价是身份串从历史轮次的 `proxy|…` 变成 `official|…` ⇒ 二者
   **协议同构、可比但不等同**（限流方不同），因此**不与历史 `proxy|…` 轮次混表算 Elo**，
   只在结论里注明同源。direct 面出现 `proxy` 臂时直接 exit 2 并给出改写提示。
   - **替代方案 A**：给 `proxy` 渠道加绝对端点覆盖。否决——`proxy` 语义是「经业主 Worker」，
     让它能直连会让「到底走没走 Worker」变成靠参数记忆，闸门就失效了。
   - **替代方案 B**：新增 `direct` 渠道。否决——新渠道会渗进 UI 下拉、限流表、文档与存档
     校验（`resolve()` 白名单），收益只是名字好听。
3. **key 只从环境变量或文件读，永不进日志/产物**：`JEV_API_KEY` 优先，其次 `--key-file`
   （缺省 `/root/.jev-key`）；`parseKeyFile()` 认裸 key / `KEY=value` / `export …` /
   `Bearer …`；产物与 `events.jsonl` 只记 `keySource`（`env:JEV_API_KEY` / `file:<path>`）。
   缺 key 时非 dry-run 直接 exit 2 并打 `KEY_HELP`。
4. **限流与熔断自己实现，挂在全局 `fetch` 上**：`scripts/lib/throttle.mjs` 用滑窗发车
   （缺省 30 req/min、`intervalMs = ceil(60000/perMinute)`），`installFetchThrottle()`
   只给上游主机（`DIRECT_UPSTREAM_HOSTS`）领令牌。**必须裹全局 `fetch` 而不是包一层
   client**：`src/core/jev/client.ts` 直接调全局 `fetch`（`:117`/`:239`），它自己的重试
   （`:179` `opts.onRetry`）也绕不过去 ⇒ 只有裹 fetch 才能保证「每个真实上游请求都领
   令牌」。连续 5 次 429 ⇒ 熔断（`acquire()` 抛错），计数写进 `summary.throttle` 与
   `events.jsonl`。
5. **进度 = 两份文件 + SSH，不引常驻服务**（D13）：每局原子写 `progress.json`（`.tmp` +
   rename），另追加 `events.jsonl`；`experiment-batch.mjs status --watch` 生成**纯 shell**
   远端循环反复 `cat progress.json`（远端非交互 shell 未必有 `node` 在 PATH，而这份文件
   本身是给人看的）。理由：box 只有 1.3 GiB 内存，挂服务不值当；文件是「进程崩了也还在」
   的最小机制。
6. **留档 = 纯 Node SigV4 直传对象桶**（D14）：`scripts/lib/s3-put.mjs`（零依赖，`crypto`
   自实现 AWS SigV4，覆盖 R2/S3/B2/MinIO 的 path-style 与 virtual-host 两种寻址）+
   `scripts/batch-bucket.mjs push|pull|ls`。凭据**只从环境变量**取
   （`BUCKET_ENDPOINT`/`BUCKET_NAME`/`BUCKET_ACCESS_KEY_ID`/`BUCKET_SECRET_ACCESS_KEY`），
   缺任一 ⇒ exit 3（不静默跳过）；上传失败**只告警不阻断**（`--strict` 才升 exit 1），
   因为本地 JSONL 才是唯一权威副本。不引 `@aws-sdk/*`（铁律 2），不要求 box 装 rclone。
   - **替代方案**：用 box 上现成的 `rclone`/`aws`。否决——box 上没有，且引入「跑动依赖
     外部二进制 + 凭据要落在 box 配置里」的暴露面。

## 后果

- **业主 Worker 与生产 D1 在阶梯跑动期间零新增**；研究数据留在 box 本地 JSONL，`pull`
  回本地算 Elo，桶里留一份可分发的副本。业主随时可 `ssh cat progress.json` 看进度。
- 代价：Worker 的限流/重试保护没有了 ⇒ 必须自限速（30 req/min、串行、熔断），并承担
  「上游改协议时两条路径不会同时红」的风险（缓解：直连面的请求体构造仍复用 core 的
  `serializeForJev`，与 Worker 转发同源）。
- 代价：身份串与历史轮次不同名（`official|…` vs `proxy|…`）⇒ 报表不能混算，需要人工
  注明「同源可比」。
- 本机没有外网 ⇒ 直连面的**整局**验收属于 box 侧动作，本机只能跑闸门与单测（已写进
  P4b 验收与计划 §9）。

## 验证（P4b 实测，2026-10-04）

`scripts/lib/{s3-put,throttle,upstream}.mjs` + `scripts/batch-bucket.mjs` 共 51 例单测：
SigV4 用 **AWS 官方已知向量**逐字节校验（GET `f0e8bdb8…` / PUT `98ad7217…`，另加
RFC 4231 HMAC 用例 1）；限速器用假时钟钉「三次请求等待 [2000,2000] ms」；闸门四路
（direct 禁 proxy 臂 / worker 无 origin / d1 无 origin / 缺 key）全部 exit 2 且文案精确；
`pushArtifacts` 在错凭据下逐项告警、其余照传。rapfi 真跑（`--store local --upstream
direct`）2 局：`progress.json` 跑动中可读、`games.jsonl` 可被 `loadRecords` 读回并按
`gameUid` 去重、日志打「store=local：未触碰业主 Worker」。
