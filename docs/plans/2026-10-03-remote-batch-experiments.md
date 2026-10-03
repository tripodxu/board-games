# 计划与执行记录：SSH 远程批量实验工具（纯 Node 对弈回路 + Elo 自动排名）

> 类型：**工具/架构轮**（新增脚本与测试接线，不改 `src/core`、`src/ui`、`src/app`、worker 行为；`tactics-versions.ts` 只读白名单引用）。状态：**✅ 已完成（2026-10-03；P0–P5 全部执行并留痕 §8，x1 追加轮仍在 box 上跑，见 §8）**。
> 触发：项目所有者要求（2026-10-03，paraphrased）：「建新 worktree；②建一个批量实验工具，跑在空闲的 SSH 主机上——现在实验太费时间，要解放本机；自由选择比拼双方（渠道/思考档强度/战术档）、等待时间；时间允许时自动跑 Elo 排名。先给出你的计划。」
> 工作分支：`feat/ssh-batch-experiments`（worktree `.worktrees/feat-ssh-batch-experiments`，HEAD `dd8f657`，基线 `npm test` 337 全过）。
> 配套审计：同目录 [2026-10-03-tactics-coupling-audit.md](2026-10-03-tactics-coupling-audit.md)（需求①的答案；本计划 D2/D4 直接消费它的结论）。
> 架构决策落档：[ADR-0019](../adr/0019-remote-batch-experiments.md)；踩坑备忘见 [MEMORY.md](../memory/MEMORY.md) 2026-10-03 置顶条目。

---

## 1. 目标（4 条）

1. **把对照实验搬到空闲 SSH 主机**（已探明：`qijia` = 185.242.234.48，2 核 / 1.9GiB 内存 / 45G 空闲，出口到 jevqipan.logicc.top 0.31s，**无 Node、无 Chrome**），本机关机/干别的事都不影响长跑。
2. **自由配置对阵双方**：`--spec 渠道[:战术档][:思考ms]` ×2（含 rapfi/mock/random/official/openrouter/proxy），局数、并发、超时（`--timeout-min`）、停顿（`--stall-min`/`--pause-ms`）、总时长预算（`--budget-hours`）。
3. **每轮实验归档闭环**：本地产物 + 线上 `GET /api/games?tag=` 核对（口径与 `scripts/experiment-run.mjs` 完全一致），断点续跑、失败隔离。
4. **时间允许时自动 Elo 排名**：按 `channel|tactics|thinkMs` 身份池化多轮结果，出 W-D-L / 得分率 / 不败率 / Elo / 黑白拆分，样本 <50 局/档明确标注「噪声内」（官方口径 ≥50 局/档，2026-10-02 计划:127、:213）。

---

## 2. 关键事实（写计划前实测/调研得出，均有出处）

| 事实 | 证据 |
|---|---|
| **对弈内核可完全脱浏览器**：`decide(engine,st,side,opts)` 是纯函数式入口，Node 直载 `.ts` 即可跑 | AGENTS.md 硬性规则 4（L41-43）；`test/engines/jev.test.mjs:29-31` 已实证；**本计划作者实测**：纯 Node 跑完整五子棋 v13-pressure-gate 26 手白胜 / v0-off 80 手白胜（探针 `.work/probe-node-game.mjs`） |
| **rapfi WASM 在 Node 可跑**：胶水 `require()` 后 162ms 实例化，`START 15`→`OK`，`BOARD/DONE`→`7,7` | 本计划作者实测（探针 `.work/probe-rapfi-node2.mjs`）；但日志报 `Unable to open model file: "model210901.bin"` → Failed to load config，`END` 触发 Emscripten `ExitStatus` ⇒ **强度可能退化，必须验证后才能开 rapfi 臂**（D7） |
| 浏览器独占职责只有三件：面板 DOM 状态机、rapfi 的 `document.createElement` 注入、localStorage 簿（可换 JSON 文件） | `src/app/rapfi-loader.ts:41-67`；`src/ui/panels/experiment.ts:357-369`；`src/ui/panels/experiment-report.ts:14-17`（`createExpHistoryStore(storage)` 已注出） |
| Node ≥22.18 是 import `src/core/**` 的前提；box 上无 Node | `package.json:32-34`（`engines.node`）；ssh 探测 |
| **`JEV_API_KEY` 只从环境变量读、不落盘不打印**；任一臂 ∈ {proxy, official, openrouter} 时必需 | `scripts/experiment-run.mjs:78-102`；AGENTS.md L48-50 |
| **不连 D1**，打线上 `/api/*` 即可；`jev` 桶限流 30（默认）/60（生产）次/分/IP，`write` 20/分 | `src/worker/middleware/ratelimit.ts:24-26`；`src/worker/env.ts:15-17`；playbooks.md:144 |
| **两臂都用 Jev 不可并行**（共享 60 次/分）；单局 3–22 分钟，12 局一轮历史 3450s | playbooks.md:142-145 |
| 每局字段足够算 Elo（`winner: 'black'\|'white'\|null`、`black/white_channel`、`black/white_think`、`experiment_tag`）；全仓 **0 个 Elo 实现** | `src/shared/record-map.ts:354-399`；子代理全仓 grep 0 命中 |
| tag 秒级精度会撞（`exp-YYYYMMDDHHmmss`），同 tag 的 `POST /api/experiments` 按 tag upsert 有覆盖风险 | `src/ui/panels/experiment.ts:116-118`；`src/worker/routes/experiments.ts:150-191` |
| D1 免费额度 10 万写/日，每局 = 1 + N 手写 | `src/worker/env.ts:16-17` |
| 战术档写错档号会被 `resolve()` 静默归一成 v13（单变量被破坏且事后不可检出） | `src/core/tactics-versions.ts:95-99`；审计报告 §4 坑 1 |
| github 仓库 `git@github.com:tripodxu/board-games.git` 为 **public**，box 可直接 https clone（实测 `git ls-remote` → `11f0efc`） | 本计划作者实测 |
| box sshd 当前 `PubkeyAuthentication no`、`PasswordAuthentication yes`，`/root/.ssh/authorized_keys` 空 | ssh 探测 |

---

## 3. 决策表（D1–D9，执行期不再变更）

| # | 决策 | 备选（否） | 理由 |
|---|---|---|---|
| D1 | **远程执行路径 = 纯 Node**（新脚本 Node 直载 `src/core`），浏览器路径保持原样不动 | 在 box 上装 Chrome 复用 `experiment-run.mjs` | ① box 只有 1.9GiB 内存，装 Chrome 亏且 Linux root 还缺 `--no-sandbox`（脚本 129-144 行没这个 flag）；② 对弈是上游 IO 密集型（每手等 Jev 1–10s），瓶颈是限流与配额不是 CPU；③ Node 回路天然并行多局、可断点续跑、seed 可控；④ `decide/buildGameExport/expTag/sidesForGame/winnerSideOf` 全部可 import。浏览器路径留给人工交互，不迁 |
| D2 | **新工具 = `scripts/experiment-batch.mjs` 单文件 CLI**（零运行时依赖），子命令：`submit` / `status` / `pull` / `elo` | 引 commander 等；或拆多文件 | AGENTS.md L37 零依赖原则；`experiment-run.mjs` 已是「顶层副作用单文件不能 import」的形态，新文件保持同风格，`elo` 与 loader 等纯函数放 `scripts/lib/batch-*.mjs` 便于单测 |
| D3 | **编排模型 = 本地编排器 → SSH/SCP → box 上 detached worker**：submit 推计划 JSON 并 `nohup` 起 worker（写 `.work/remote/` 日志+pid+checkpoint），本地轮询 status、pull 拉结果 | systemd 常驻 / tmux 手工 / box 自己轮询队列 | nohup+文件型 checkpoint 最抗 SSH 断连；断网不杀任务、恢复只读文件；无需 box 上常驻守护进程 |
| D4 | **一轮 = 12 局、黑白交替、局间隔 2500ms、tag 唯一**（`exp-YYYYMMDDHHmmss-<batch>-r<i>`，≤64 字符） | 自定义局数/随机 tag | 12 局是历史口径（playbooks.md:169「同口径、同开局、同 12 局黑白交替」）；`sidesForGame` 已保证 A 奇数局执黑（`src/ui/panels/experiment.ts:128-138`），直接复用；tag 后缀堵秒级撞车（事实表） |
| D5 | **每局显式 `setSeed(局号派生)` 并快照开局 seed 进局 meta** | 全局一次性 setSeed | 全局 RNG 是唯一进程级污染源（审计 §2）；真实 Jev 臂不过 RNG，random/mock 臂靠局号派生保证可复现且互不覆盖 |
| D6 | **并发策略**：两臂皆 Jev 时强制 `--parallel 1`；B 臂 ∈ {rapfi, mock, random}（无上游调用）时允许 `--parallel 2..3`，submit 时打印估算上游速率（Jev 侧手数/轮均墙钟），>40 次/分自动降 1 并警告 | 无脑并行 | playbooks 坑④（60 次/分/IP）；`write` 20/分也要留头；D1 免费额度 10 万写/日在 submit 时一并估算 |
| D7 | **rapfi 臂分两级**：先用 Node loader 跑通协议（已实测 OK），**强度验证过关**（Node vs 浏览器同局面走法一致率 ≥99%，或 Node-rapfi 对已知 12 局录像逐手比对）前默认只允许 mock/random/Jev 臂 | 直接信任 Node loader | 实测 `.data` 模型预载报错 ⇒ 强度可能退化，而 rapfi@1000ms 是三档阶梯基线之一，强度错了整个台阶错 |
| D8 | **Elo = 身份 `channel\|tactics\|thinkMs` 池化 + 顺序迭代 Elo（K=16，胜 1/和 0.5/负 0）+ 黑白平衡校验 + <50 局/档标注** | Glicko/Bradley-Terry MLE/分时段 Elo | 顺序 Elo 与既有 `expSideStats` 分桶口径无缝（`src/ui/panels/experiment-report.ts:316-359`，`tacticsLabel()` 归一）；Glicko/不确定度留给下轮，先把 W-D-L+不败率+Elo 出对 |
| D9 | **测试接线**：新增 `test/scripts/**/*.spec.mjs` + vitest 第 4 project `scripts`（node env）+ `npm run test:scripts`，并入 `npm test` | 只在脚本里塞自测不进 CI | 批量工具的错误（档位白名单、Elo 计算、tag 生成）必须回归；`vitest.config.ts`/`package.json` 属编排者独占文件，本计划显式授权自己改 |

---

## 4. 架构

```
本机（Windows，开发机）                          box（qijia，185.242.234.48）
scripts/experiment-batch.mjs submit   --ssh-->   ~/board-games/（github public clone）
  校验 spec/tactics 白名单/并发预算                  scripts/experiment-worker.mjs（nohup）
  → .work/remote/batch-<id>/plan.json              ├─ round i：12 局对弈回路（Node 直载 src/core）
  scp plan + git pull                            │   每手 decide(engine,st,turn,{channel,apiKey:
                                                  │            tacticsVersion,topK,rapfiThinkMs})
status（ssh 读 checkpoint+日志尾）        <-----    │   每局 buildGameExport → POST /api/games（线上）
pull（scp 拉 .work/remote 产物）          <-----    │   每轮 GET /api/games?tag= 核对归档
elo（本地算，或 --from-api 直接拉线上）             └─ checkpoint：round-<i>.json {tag,exitCode,ok}
```

对弈回路（worker 内）逐局：`getGame('gomoku')`（仅五子棋，战术层只覆盖五子棋）→ `setSeed(派生)` → `newGame` → 循环 `decide`/`applyMove` 直到 `getStatus().over`（或 `--max-plies` 截断）→ `buildGameExport` 产出与线上归档一致的 payload → `POST /api/games`（原样 fetch + 绝对 origin，绕开 `src/core/api/client.ts` 的相对路径假设）→ 局间隔 `--pause-ms`。每局记：gameUid（randomUUID，幂等键同产品口径）、tag、expGameNo、黑白臂、每手 meta（含 `tacticsVersion`）。

限流：客户端自带 5 次退避听 `Retry-After`（`src/core/jev/client.ts:131-142`，历史坑③的修复），worker 只加轮次间节流与 429 时的等待。

---

## 5. 文件清单（全部在 feat 分支，`src/**` 零改动）

| 文件 | 动作 | 内容 |
|---|---|---|
| `scripts/experiment-batch.mjs` | 新增 | 编排 CLI：`submit/status/pull/elo`；spec 解析与校验（渠道∈CHANNELS、档位∈VERSIONS 白名单**报错不回退**、thinkMs 数值）、并发与写配额估算、tag 生成、ssh/scp 驱动（用系统 `ssh`/`scp`，key auth） |
| `scripts/experiment-worker.mjs` | 新增 | box 上执行器：读 plan.json → 串行轮次 → 对弈回路 → 归档 → checkpoint → 断点续跑（round json ok 或 tag 已归档满则跳过） |
| `scripts/lib/rapfi-node-loader.mjs` | 新增 | rapfi 的 Node `RapfiLoader`：读 `public/rapfi/` 三件套（11,274,785 B）→ `createRequire` 胶水 → `locateFile` 本地路径 → stdout handler → 捕 `ExitStatus`；强度自检模式 `--selftest` |
| `scripts/lib/batch-elo.mjs` | 新增 | Elo 池化计算（身份归一、W-D-L、得分率、不败率、Elo K=16、黑白拆分、样本标注）；输入 = 本地 batch 产物或 `--from-api` 拉 `/api/games?tag=` |
| `test/scripts/batch.spec.mjs` | 新增 | 单测：spec 解析与档位白名单（错档 exit 2）、tag 格式与唯一性、sidesForGame/黑交替、Elo 合成棋谱（已知排序+和棋 0.5+身份归一）、checkpoint 跳过逻辑 |
| `test/scripts/worker-dry.spec.mjs` | 新增 | mock 渠道端到端：1 局完整对弈→export payload 结构断言（不打线上） |
| `vitest.config.ts` | 改 | 加 project `scripts`（`environment:'node'`, `include:['test/scripts/**/*.spec.mjs']`） |
| `package.json` | 改 | `"test:scripts": "vitest run --project scripts"`，并入 `test`；`"exp:batch": "node scripts/experiment-batch.mjs"` |
| `docs/agents/playbooks.md` §7 | 改 | 增补「远程批量口径」小节（key env、UTC 日志、并发预算、断点续跑、D1 写配额、rapfi Node 臂前提） |
| `docs/status.md` | 改 | 实验记录流水格式不变，加一行工具说明；「最后更新」改 2026-10-03 |
| `docs/memory/MEMORY.md` | 改 | 置顶一条：远程批量实验的架构决策 + 踩坑（tag 后缀、写配额、rapfi Node 强度验证前提） |
| `docs/adr/0019-remote-batch-experiments.md` + 两处索引 | 新增 | 结构性决策（D1 纯 Node 路径 vs 浏览器路径），手工补 `docs/adr/README.md` 与 `docs/README.md` 索引（status.md:320-321 记的债，自己别再欠） |
| `AGENTS.md` §4 常用命令 | 改 | 加一行 `node scripts/experiment-batch.mjs submit …` |

---

## 6. 阶段与验收（P0 可先做，P1 起逐阶段 commit）

**P0 · bootstrap box（约 30 分钟，命令留痕进本文档 §8）**
- 装 Node 24.9.0（与本机同版本）：nodejs.org tarball → `/opt/node`，`/etc/profile.d/node.sh` 加 PATH；
- pubkey auth：本地 `id_ed25519.pub` 写入 `/root/.ssh/authorized_keys`，改 `PubkeyAuthentication yes` 并 `systemctl reload ssh`（**保留 PasswordAuthentication yes 兜底**）；
- `git clone https://github.com/tripodxu/board-games.git ~/board-games` → `git checkout feat/ssh-batch-experiments` → `node -e` 冒烟 import `src/core/registry.ts`；
- `JEV_API_KEY` 落 `/root/.config/jev-batch.env`（chmod 600，worker 启动时 source；**不入仓库、不打印、不进命令行**——命令行会进 `ps`/`/proc`）。
- 验收：box 上 `node -e "import('./src/core/registry.ts').then(m=>m.ids)"` 打印七棋种 id。

**P1 · 对弈回路（官方/proxy/openrouter/mock/random 臂）**
- worker + 对弈回路 + 归档 POST + tag/白名单/seed 快照；`--dry-run` 模式不 POST。
- 验收：box 上 mock 渠道 12 局端到端跑完（**零上游成本**），产物 12 条 export payload、结构断言全过；`npm run test:scripts` 绿；本地 `npm test` + `npm run typecheck` 仍全绿。

**P2 · 编排层（submit/status/pull/checkpoint/并发）**
- 验收：本机 submit 1 轮 `mock vs mock --games 4`，写 `.work/remote/` 全套；kill -9 worker 后重启，checkpoint 跳过已完成局；`--parallel 2` 的速率估算打印正确。

**P3 · 真上游小闭环 + Elo**
- 验收：**2 局 `official(v13) vs rapfi(浏览器口径)`**（先只做浏览器侧对照用现有 `experiment-run.mjs` 跑同规格 2 局，比对 Node 侧走法一致率，D7 的验证数据）→ 通过后开放 rapfi Node 臂；`elo` 子命令对多轮产物出表，<50 局标注生效。

**P4 · rapfi Node 臂 + 强度验证（D7 gate））**
- 验收：Node-rapfi 与浏览器 rapfi 在同一批 12 局归档上逐手一致率 ≥99%（不同步的只允许时间截断差异）；不一致则标记 rapfi 臂「仅协议自检用」，不参与正式实验。

**P5 · 文档与收口**：§5 表中文档项全落；`npm run check:docs` 绿；`npm test` 337+ 全绿；commit 拆成：`feat(scripts): 远程批量实验工具` / `test(scripts): …` / `docs(plans): 计划与远程执行留痕` / `docs(adr): 0018 …`。

---

## 7. 风险与缓解（历史四坑的继承关系 + 远程新风险）

| 风险 | 缓解 |
|---|---|
| 历史坑①计量器路径（CDP 专属） | 不适用：Node 路径没有计量器，meter 用 decide 返回的 `meta` 自累积 |
| 历史坑②history[0] 旧 tag | 不适用：本地产物即唯一事实源；核对一律 `GET /api/games?tag=` 差集 |
| 历史坑③4 次尝试熬不过 60 秒限流 | 客户端已修（5 次退避听 Retry-After）；worker 再加轮次级 429 等待 + submit 速率预检（D6） |
| 历史坑④rapfi 10MB 慢链 448s | Node 路径**从本地盘读公共文件**，无网络下载 ⇒ 该坑天然消除（但这依赖公共文件随仓库 clone 到 box，P0 已含） |
| SSH 断网 / 本机关机 | worker nohup detached + 文件型 checkpoint；submit/status/pull 都是幂等短命令 |
| tag 撞车被 upsert 覆盖 | `exp-…-<batch>-r<i>` 后缀 + ≤64 字符（D4） |
| D1 写配额 10 万/日 | submit 时按 `1+N手/局 × 局数` 估算并打印；超 8 万警告需确认 |
| rapfi 强度退化（实测 `.data` 报错） | D7/P4 gate，未过不开放 rapfi 臂 |
| 上游配额真金白银 | mock/random 臂零上游；真上游轮默认只跑必要局数；`--budget-hours` 到点停 |
| `--timeout-min` 不够（单局最长 22 分钟） | 默认 180 分钟/轮（历史 3450s 的 3 倍余量），`--stall-min` 默认 15 分钟无进展即熔断该轮 |
| 日志时区 | 全部 UTC（与 playbooks 一致），文件头注明 |

---

## 8. 执行记录（2026-10-03，全部回填）

### P0 远程地基（已完成）
```
[P0.1-3] node v24.9.0 → /opt/node + /etc/profile.d/node.sh；另补 /usr/local/bin/{node,npm,npx} 软链
         （非登录 shell 找不到 node）
[P0.4-5] PubkeyAuthentication yes + authorized_keys。坑：经 ssh_exec 内联 echo 写入会把 base64 改一位
         ⇒ 改本机 .pub → ssh_upload → 远端 printf 落盘（见 MEMORY 2026-10-03 条目）
[P0.6] clone https://github.com/tripodxu/board-games.git -b feat/ssh-batch-experiments → dd8f657，
         之后每轮 git pull 跟进（box 无 github key，只能 https 拉）
[P0.7] node -e "import('./src/core/registry.ts')…" 通过（七棋种）
[P0.8] key 方案改为 /root/.jev-key（chmod 600，仓库外），worker 启动命令 set -a; . /root/.jev-key; set +a 注入
```

### P1 对弈回路（已完成）
- worker + `scripts/lib/batch-common.mjs`（20 例单测）+ vitest 第 4 project `scripts`。
- 验收：本机 dry-run mock vs random ×4（22/21/23/11 手全 ok-dry，71s）、rapfi::500 vs random ×2 ok-dry；
  产物字段与浏览器归档同构（每手 meta 带渠道与 `ai.tv`）。
- 坑（均已修）：`VERSIONS` 是数组 ⇒ 用 `ids()`；`.mjs` 禁 TS `as` 断言；ROOT 路径；
  estimateBudget 是位置参不是对象；`args._` 已去掉子命令。

### P2 编排层（已完成）
- `scripts/experiment-batch.mjs` submit/resume/status/pull/elo + `scripts/lib/batch-elo.mjs`（9 例）。
- 验收：box 上 dry-run e2e（36s/轮）；**kill -9 续跑实测通过**（kk1：跑到 3/6 时 kill -9，
  resume 后 1-3 skipped、4-6 续跑，6/6 完成）。
- 坑（均已修）：scp 不吃 `-n`（拆 SSH_OPTS/SSH_LAUNCH_OPTS）；ssh 被 nohup 拖住
  （`nohup … </dev/null & echo` ≈2.4s vs setsid ≈10s）；目录名 checkpoint 单数；pull 前先删本地同名目录。

### P3 真上游小闭环（已完成，验收口径有修正）
- **实际执行**：`--a proxy:v13-pressure-gate:0 --b random:v13-pressure-gate:0 --games 2`（dryRun=false，
  tag `exp-20261003052056-smoke1-r1`）⇒ 2/2 ok（41 手 winner=black / 66 手 winner=white），
  checkpoint `archivedId=269/270`、**verified=true**（POST 成功 + GET `?tag=` 按 `gameUid` 核对）。
- **与计划原文的偏差**：原计划写「2 局 official(v13) vs rapfi（浏览器口径）」——box 上无浏览器，
  「浏览器侧对照」改为已完成的离线程查（b12：Node↔Edge 命令流 12/12 一致），真上游闭环改由
  proxy 臂承担（proxy 与 official 走同一条 decide 上游路径，差别只在 endpoint/key）。
- 过程中修掉三个归因缺陷（settings.apiKey 透传 / camelCase 归档核对 / blackThink·whiteThink 补写），
  详见 MEMORY 2026-10-03 条目。

### P4 rapfi Node 臂 + 强度 gate（已完成，判据按证据修正）
- **gate 判据修正**：原判据「对浏览器归档逐手 ≥99%」**不可达**——Node↔Edge 命令流重放 12/12 一致，
  但对归档逐手 165/192=85.9%，且不一致手上 Edge 给出与 Node **相同**的着法（都不等于归档）
  ⇒ 残差是浏览器运行时墙钟抖动（Eval 0 平局多重），不是 Node 退化。修正为
  **「Node↔Edge 命令流一致 + Node 自身可复现」**，并在 ADR-0019「验证」§4 记录完整证据链。
- **12 局正式实验**：`--a rapfi::500 --b random:v13-pressure-gate:0 --games 12`（tag `exp-20261003042812-rapfi1-r1`）
  ⇒ 12/12 ok、约 52s/局、checkpoint 全 verified=true。
- **追加一轮（Elo 样本）**：`--a proxy:v13-pressure-gate:0 --b rapfi::500 --games 12`
  （tag `exp-20261003052604-x1-r1`，落到 plan 里 b 归一成 `rapfi:v13-pressure-gate:500`——
  rapfi 不走战术层，档位标签只是臂上下文，与站点历史行同 convention）⇒ **12/12 ok**
  （约 100s/局，含 429 退避；2 局 225 手满盘和棋），全部 verified=true。
  **合并三轮 26 局** Elo（K=16，和棋 0.5）：`proxy|v13-pressure-gate|0` 1551.9（10胜2和2负）
  > `rapfi|-|0` 1503.1（6-0-6）> `random|v13-pressure-gate|0` 1481.4（6-0-8）> `rapfi|-|500` 1463.6（2胜2和8负）
  ⇒ **proxy·v13 对 rapfi@500ms 合计 6 胜 2 和 4 负**，全部 ⚠<50 局。
  x1 用补行能力上线前的旧代码跑 ⇒ experiments 行由 `.work/backfill-experiments.mjs` 事后补（HTTP 200）。
- **和棋判定缺陷（铁律 11）**：x1 合并 Elo 时发现 `batch-elo.mjs` 只认 `winner==='draw'`，
  而真实导出的和棋**没有 `winner` 字段**（`result:"和棋（棋盘已满）"`；`record-map.ts:251-258`
  `parseResult()` 对和棋给 `winner:null`，D1 `games.winner` 亦 NULL）⇒ 两局和棋被当未终局丢掉、
  Elo 只算 22/24 局。修法：按 result 串 `/^和棋(?:（(.+?)）)?\s*$/` 判和棋（与 parseResult 同形，
  endReason 取括号内容），新增 2 例单测钉住。

### P5 文档收口（✅ 2026-10-03 完成）
- 计划本篇执行记录、ADR-0019、`docs/README.md` 索引（adr 0019 + 两个 plans 行）、AGENTS.md §4 命令、
  MEMORY.md 置顶条目、status.md 数据现状。
- commit 拆分：feat(scripts) P1 / fix(scripts) P2 收尾 / feat(scripts) P4 rapfi loader+probe /
  fix(scripts) 三处归因修正 / fix(scripts) key 预检改提示 / docs(adr) 0018（`0e7e9fb` 8 文件 +241/−18）/ docs(plans) 两篇。
- 终验（`0e7e9fb`）：`npm test` **366 例 / 36 文件全过** + `npm run typecheck` 干净 + `npm run check:docs` 全部通过（memory 置顶、53 个 md / 330 链接、status 时效 0 天）。
- **追加闭环（`experiments` 统计行）**：worker 轮末 POST `/api/experiments`
  （`experimentEntryFrom()` 纯函数 + 429 退避两次；入口加 `import.meta.url` 守卫让 worker 可被单测 import），
  新增 `test/scripts/experiment-entry.spec.mjs` 7 例（臂口径/局口径/只收 ok/null 耗时/date ISO）；
  rapfi1 与 smoke1 两轮用 `.work/backfill-experiments.mjs` 补归档并 GET 验证；status/ADR/§9 同步更新。
- **追加闭环 2（Elo 和棋口径，铁律 11）**：`batch-elo.mjs` 的 `gameRecord()` 原先只认
  `winner==='black'/'white'/'draw'`，而**和棋在导出/D1 口径里没有 `winner` 字段**
  （`result:"和棋（棋盘已满）"`）⇒ x1 两局满盘和棋被丢。改为按 result 串识别和棋（与
  `record-map.ts` 的 `parseResult()` 同形正则），`reason` 兜底取括号里的「棋盘已满」；
  新增/改写 3 例单测（和棋按 result 计 0.5、未终局不计入、winner 缺失但 result 是和棋也计）。
  `npm run test:scripts` 38 例通过。教训：**Elo 每个「丢局」原因都要单独论证**，
  和棋漏算会让两个臂的 Elo 同时偏移且方向取决于对局构成。
- 终验（追加闭环后重跑）：`npm test` **375 例 / 37 文件全过** + `npm run typecheck` 干净。
- ⏱️ **两个终验数字的时序**：`366 例 / 36 文件`（`0e7e9fb`）→ `375 例 / 37 文件`（追加 Elo 和棋口径 + 入口守卫后）。
  两者不是矛盾，是同一天两次快照；合入 main 后（v14 已在树上）总数变成 **382 例 / 37 文件**——
  多出的例数与文件来自 `scripts` project 自身（37 文件含本分支新增的 3 个 spec），v14 只加引擎层用例。

### P6 合入 main + 审查整改（✅ 2026-10-03，由编排者收口）

- **合入**：`git merge --no-ff origin/feat/ssh-batch-experiments` ⇒ 合并提交 `f4e4ce9`（父 `fe43b16` + `6997961`）。
  5 个公共文档冲突（`AGENTS.md` §4、`docs/README.md`、`docs/adr/README.md`、`docs/memory/MEMORY.md`、`docs/status.md`）由编排者收口；
  代码与测试零冲突。**ADR 改号**：分支的 `0018-remote-batch-experiments.md` 与 main 的 `0018-live3-fresh-correction.md` 撞号 ⇒ 前者改为
  [ADR-0019](../adr/0019-remote-batch-experiments.md) 并同步全部引用。
- **独立只读审查**（子代理，先把分支拉到 `.worktrees/review-batch` 复核）：方向、密钥纪律、`src/**` 零改动、38 例单测真绿都过；
  报 **5 条合并阻断项（M1–M5）+ 3 条建议（H1–H3）+ 12 条可后续**。整改全部落在合入后的同一批 commit 里：
  1. **M1 思考档越权写 0**：worker 曾无条件写 `blackThink/whiteThink = thinkMs || 0`，会回退 main 的 `thinkMsOf()` 闸门
     （只有 `rapfi` 侧且 > 0 才写）⇒ 改为只在 `rapfi` 侧写，其余留空（D1 落 NULL）。
  2. **M2 多轮并发**：`--rounds>1` 原先一口气 nohup 全部轮次，与「限流口径下串行」的闸门文案自相矛盾 ⇒ 改为**起一轮 → 轮询 pid 退出 → 再起下一轮**。
  3. **M3 续跑语义**：checkpoint 命中只带 `{status:'skipped'}` ⇒ 续跑轮的实验档案里这些局凭空消失（`total` 偏小甚至 0）；
    改为**回读 winner/plies/gameUid**；`resume` 补上与 submit 相同的 key 注入（原先上游臂续跑必 exit 2）。
  4. **M4 同日撞车**：`batchId` 缺省只到日期、本地 plan 直接覆盖、checkpoint 只比状态不比 tag ⇒ 同日第二次 submit 会「一局不跑、exit 0、还 POST 一行实验档案」；
     改为 batchId 带时分秒 + 本地同名即 `die` + checkpoint 的 tag 失配就重跑。
  5. **M5 归档阶段无护栏**：`apiPostGame` 无重试/无超时、归档不受 `timeoutMin/stallMin` 覆盖、续跑会生成新 `gameUid`（D1 里同轮同局两份棋谱都算数）⇒
     30 s 超时 + 3 次退避、**先在 checkpoint 落 `pending` + gameUid 再归档**、续跑复用同一 uid、归档后按 uid 核对（退避重查 3 次）；`writeJson` 改原子写（`.tmp` + rename）。
  6. **H1** 加 `--origin`（不再硬编码生产域，配合独立 Worker/D1 可彻底隔离）；**H2** 记录远端 `repoHead` 并写进实验档案 `note`（Node 直载 `code_version` 恒为 `dev+nogit`）；
     **H3** 归档行的 `games[].blackTac/whiteTac` 改走 `tacticsLabel()` 闸门（原先会造 `rapfi|v13-pressure-gate` 这类幻影身份）。
  7. **中清单**里一并修的：`resume`/`scp` 不再把 SIGTERM 当成功、`pull/status` 改「先拉暂存目录再整目录替换」（scp 失败不再删本地唯一副本）、
     退避预算按**每一手**重置（原先整局共享）、`identityOf` 收敛为 `batch-common.mjs` **唯一实现**（空档留空 `rapfi||500`，与归档/报表桶键同形）、
     `parseSpec` 移入 try（坏 plan 走 exit 2 而非未捕获异常）、归档核对不再用 `byTag >= gameNo` 计数启发式、`rapfi-parity-probe.mjs` 的
     `g`→`game` 未定义变量、`rapfi-node-loader.mjs` 的 `smokeTest()` 从「收进空数组」改成**真断言**并在探针开局前跑、`--max-plies/--topk/--timeout-min/--stall-min` 可覆盖。
  - 新增/改写单测：`ckptAction()`（纯函数：已完成跳过并带回胜负、tag 失配重跑、pending 复用 uid）+ 实验档案的档位/思考档闸门与 skipped 计入 ⇒ `test/scripts` **44 例**（原 38 例）。
  - 全量验收：`npx tsc --noEmit` 0 错；`node test/engines/run.mjs` **142 例**；`npx vitest run` **37 文件 / 382 例**；`npm run check:docs` **55 md / 355 链接**。
- **数据卫生**：远端三轮 26 局（`exp-20261003042812-rapfi1-r1` / `exp-20261003052056-smoke1-r1` / `exp-20261003052604-x1-r1`）
  已进生产 D1，`code_version='dev+nogit'`、`device_id` NULL、tag 形如 `exp-<ts>-<batch>-r<i>` 可与浏览器轮区分；
  审查结论是**不需要紧急隔离**（无结构破坏）。M1–M5 落地后若要更干净，可换 `--origin` 指向独立 Worker+D1，
  并给每批一个稳定 `X-Device-Id`（`batch-<batchId>`）便于一条 SQL 过滤。

## 9. 未闭环 / 遗留

- **Elo 样本 < 50 局/档**：官方口径下所有身份都标 ⚠；三轮合并后总样本 26 局/档，仍属噪声内，
  只可作相对参考，不可作结论。
- **Node rapfi vs 浏览器归档不可逐字复现**：墙钟属性，聚合口径（胜/和/负 + 不败率）不受影响；
  若要单局复盘对齐，需要浏览器侧固定随机源（超出本计划范围）。
- ~~`experiments` 统计表行仍只由浏览器实验器写~~ ✅ **已闭环（2026-10-03 追加）**：worker 轮末
  POST `/api/experiments`（形状对齐 `newEntryFromRun`，429 退避两次；失败不坏出口码）。
  上线前已跑完的 rapfi1/smoke1 两轮用一次性脚本 `.work/backfill-experiments.mjs` 补归档
  （HTTP 200，`GET /api/experiments?limit=200` 可见，`total` 12 / 2）。
- `--parallel 2..3` 未实装（当前每轮串行起 1 个 worker、局内串行）；单上游臂场景够用，
  双上游臂必须串行（限流）。
- `.work/` 产物（plan/日志/checkpoint/games）留在本机与 box，入库只含结论数字。

## 10. 明确不做（本轮范围外）

- 五子棋以外棋种（战术层只覆盖五子棋，`tactics_version` 归因只对它有意义）。
- 浏览器路径改造（`--no-sandbox`/`--port` 参数化留给真要并行浏览器时再做）。
- Glicko/TrueSkill/分时段 Elo（D8 已说明取舍）。
- 战术层任何行为修复（坑 1/2/5/6/7 的修复是独立轮次，本计划只做「工具侧白名单校验」这一层防护）。
- `src/worker/**`、D1 schema、部署改动。

## 10. 回滚

纯新增文件 + `vitest.config.ts`/`package.json`/文档的增量修改，全在 `feat/ssh-batch-experiments` 分支；回滚 = revert 该分支相关 commit 或删除新增文件，主分支与产品路径零影响。
