# 远端对照实验全流程：启动 → 看进度 → 读战绩 → 取数据

> 这篇讲**SSH 远端批量对弈**这条路的完整操作闭环（ADR-0019 建的地基 + ADR-0021 的离线运行面 +
> ADR-0024 的 jevrouter 网关）。浏览器那条老路（真 Chrome + CDP）见
> [agents/playbooks.md](agents/playbooks.md) §7。
> 两条路的**判读纪律完全共用** playbooks §7 第 8–12 条，本文只补远端这条路特有的部分。

---

## 0. 三十秒速查

| 我要做… | 命令 |
|---|---|
| 起一轮实验 | `node scripts/experiment-batch.mjs submit --a <spec> --b <spec> --games N --batch <名> --store local --upstream direct --allow-production` |
| 看跑到第几局 | `node scripts/experiment-batch.mjs status --watch --batch <名>` |
| 看战绩报告 | `node scripts/experiment-report.mjs --batch <名>` |
| 看败局怎么输的 | `node scripts/loss-report.mjs --batch <名> --ours <我方渠道>` |
| 把数据拉回本地 | `node scripts/experiment-batch.mjs pull --batch <名>` |
| 算 Elo / BT | `node scripts/experiment-batch.mjs elo .work/remote/<名>` |
| 断了要续跑 | `node scripts/experiment-batch.mjs resume --batch <名> --round 1` |
| 查这批的**腿成分**（吃了多少 lfree，见 §1.3b） | 按 §2.3a 的一行 `node -e` 现算，输出 `渠道:模型 手数` 排行 |

`<名>` = batch id；产物落在本地 `.work/remote/<名>/`、远端 `/root/board-games/.work/remote/<名>/`。

---

## 1. 启动实验

### 1.1 对阵描述符（spec）

格式固定是 `渠道:战术档:思考ms`，**空字段要留空位**：

| 臂 | spec | 含义 |
|---|---|---|
| Jev 走网关 + 某战术档 | `jevrouter:v14-plus:0` | 思考档恒为 `0`（Jev 的「思考时间」是模型往返，不是配置） |
| Jev 走同源中转 | `proxy:v14-live3-fresh:0` | 浏览器口径 |
| Rapfi 本地引擎 | `rapfi::10000` | 战术档留空（它不过战术层）、第三段是思考预算毫秒 |
| 离线演示 / 基线 | `mock::0` / `random:v14-plus:0` | 零上游、零花费 |

`思考ms` 对 Jev 渠道无效；对 `rapfi` 是它每手的思考预算（UI 上限 10000）。

### 1.2 完整命令

```bash
node scripts/experiment-batch.mjs submit \
  --batch vplus-r10s \
  --a "jevrouter:v14-plus:0" \
  --b "rapfi::10000" \
  --games 120 \
  --pause 2500 \
  --seed 20261012 \
  --store local \
  --upstream direct \
  --allow-production \
  --host 185.242.234.48 \
  --user root
```

常用选项：

| 选项 | 缺省 | 说明 |
|---|---|---|
| `--games N` | 12 | 本轮局数。**偶数 = 颜色对称**（自动黑白交替） |
| `--rounds N` | 1 | 多轮**串行**（起一轮 → 等它退出 → 再起下一轮）。限流口径要求 concurrency=1 |
| `--pause ms` | 2500 | 每手之间的额外停顿 |
| `--seed N` | — | 固定随机源，保证可复现 |
| `--max-plies` | 225 | 手数上限，打满判和棋。**直接决定单局时长**（见 §4.3） |
| `--store local\|d1` | `d1` | `local` = 只落远端 `games.jsonl`，零网络写 |
| `--upstream direct\|worker` | `direct` | `direct` = box 直连上游、零 CF 触碰 |
| `--rate-limit N` | 30 | 上游请求/分，连续 5 次 429 熔断 |
| `--router-key-file` | `/root/.jev-router-key` | jevrouter 臂的 key 文件 |
| `--router-endpoint` | 空（回落 `JEV_ROUTER_UPSTREAM_URL`） | jevrouter 臂端点覆盖；填内网直连 `http://172.18.0.4:8080/v1/systemone` 绕开 Cloudflare 边缘（边缘间歇 502；内网实测快 ~1.8 倍、0 失败）。**只影响实验运行面，不碰生产** |
| `--key-file` | `/root/.jev-key` | **official 臂的 key 文件**：box 上默认文件装的其实是 `jv-` 网关 key，跑 official 臂必须显式指 `/root/.jev-official-key`，否则形状闸门开局即 exit 2 |
| `--capture` | 关 | 每次上游调用（请求原文 + 响应）逐行追加写 `<outDir>/calls.jsonl`；鉴权头按前缀抹除、绝不落盘（规则 7）。rapfi 臂走本地 WASM 不发请求 ⇒ 文件里只有 Jev 臂调用 |

### 1.3 两道 P0 闸门（拦污染，不许绕）

1. **不给 `--origin` 时必须显式 `--allow-production`**，否则 `exit 2`。它提醒你「默认口径是写生产 D1」。
   想彻底不碰生产库，就 `--store local`（此时 `--origin` 不会被访问，但闸门仍要求显式确认）。
2. **`--parallel` 只对双本地臂放行**：任一侧是 `official`/`openrouter`/`proxy`/`jevrouter` 就拒绝——
   并行会撞限流，且共享的上游延迟会污染对照。

### 1.3b 臂渠道与跨轮可比性（2026-10-14/15 实测后新增，重要）

**跨轮比分只有在同一执行模型上才可比。** 受控实测（
[experiments/free-vs-official-2026-10-14.md](experiments/free-vs-official-2026-10-14.md) 与
[experiments/lfree-vs-official-2026-10-14.md](experiments/lfree-vs-official-2026-10-14.md)）：
网关三条腿里 `zen-o2a`（回 `jev-1.13-free`）**≡ 官方 API**（500 局面众数一致 95.0% = 噪声地板、TV 0.027、
McNemar p=0.16）；`lfree-1`/`lfree-2`（回 `jev-1.13`）**显著偏离官方**（61.0%/62.0%、TV 0.236，
z≈29、p<10⁻¹⁵；两腿互检 91.2% ⇒ 是另一稳定部署而非噪声）。

操作含义：**official 臂（`--upstream direct`，key 在 `/root/.jev-official-key`）与锁 `zen-o2a` 的
jevrouter 臂都可当作「真 Jev」**；默认路由的腿混合**随时间漂移、不可预测**（实测各批 free 占比 1%–99.8%）——凡网关批次跨轮对比前先查 `ai.mdl`
混合（各批次占比见 lfree-vs-official 报告第七节污染地图；`experiment-report` 暂不输出该列）。
**批内两臂共享路由 ⇒ 头对头对照不受影响**。另注意**命名反直觉**：带 `-free` 后缀的腿才是官方克隆。

⚠️ **Git Bash 两个坑**（2026-10-15 探针实录，详见
[plans/2026-10-14-official-rerun.md](plans/2026-10-14-official-rerun.md) 第十节）：
① 所有带远端绝对路径的 submit 前加 `MSYS_NO_PATHCONV=1`，否则 `--key-file /root/...` 被改写成
`C:/Program Files/Git/root/...`；② `--dry-run` 也会真启动远端 worker（秒退、留残目录），
之后同批次名真跑前要先删两端目录（M4 同名拦截）。

### 1.3c 锁腿规程（2026-10-16 跑通，要「官方克隆那条腿」时就用它）

想用 jevrouter 臂、但**把腿锁死在 `zen-o2a`（≡ 官方 API）**，靠端点参数而不是靠 key 文件：

```bash
node scripts/experiment-batch.mjs submit \
  --a "jevrouter:v14.3:0" --b "rapfi::10000" \
  --router-endpoint 'http://172.18.0.4:8080/v1/systemone?leg=zen-o2a&strict=1' \
  --games 120 --seed 20261012 --store local --capture \
  --allow-production --host 185.242.234.48 --user root
```

- `--router-endpoint` 会写进 worker 的 `JEV_ROUTER_ENDPOINT` 环境变量
  （提交侧注入见 [lib/ladder.mjs](../scripts/lib/ladder.mjs)，worker 侧读取见
  [experiment-worker.mjs](../scripts/experiment-worker.mjs)）。**端点里带 query 也是合法的**。
- `?leg=zen-o2a` = 锁官方克隆腿；`strict=1` = 锁定后不再多源回退（回退就会把 lfree 混进来）。
- 公网端点 `https://jev.logicc.top/v1/systemone?leg=zen-o2a&strict=1` 同样能锁，
  但内网直连更快（边缘间歇 502），长跑优先内网。
- **验证锁没锁住，看两处**：响应头 `x-jev-leg: zen-o2a`；以及 §2.3a 的腿成分扫描（应 100% `jev-1.13-free`）。
- ⚠️ 命名反直觉：**`-free` 才是官方克隆**（§1.3b）。锁 `zen-o2a` 就是锁 `jev-1.13-free`；
  想要 lfree 那条腿得锁 `leg=lfree-1` / `lfree-2`——**默认不加参数 = 多源随机轮换 = 不可比**。
- 正式长跑前先起 **2 局探针批**（换批次名）验证腿纯度与零 400，再起正式批；探针批目录留着作事故记录。

### 1.4 key 前置条件

远端两个 key 文件，**缺任一会在开局前 `exit 2`，日志可见**：

```
/root/.jev-key          TypeSafe 官方臂
/root/.jev-router-key   jevrouter 网关臂（jv- 开头）
```

⚠️ **两个必须知道的坑**：

- **box 就是网关所在的 VPS**。那台机器的 `/root/.jev-key` 历史上装的就是 `jv-` 网关 key。
  所以 `official` 臂和 `jevrouter` 臂**必须分开放**，否则会把 `jv-` key 当 TypeSafe key 发出去。
- **`keyShapeProblem()` 形状闸门**会校验：`jevrouter` 臂的 key 必须 `jv-` 开头、`official` 臂的必须不是。
  放错文件**不会**立刻报错，而是变成整轮 401、每局十几分钟才失败一次——所以闸门放在开局前，
  反向用例实测 `exit 2` 并点名成因。**改动 key 路径后先跑一次反向用例验证闸门还活着。**

key 只从远端文件注入，**本机不需要持有**。批量 CLI 启动时会在 stderr 刷一行
`source` 裸 key 的 `command not found`——**这是表象，不是故障**：key 文件是裸值不是 `export` 语句，
worker 运行期直接从文件读（启动日志会印 `key 来源：jevrouter←file:/root/.jev-router-key`）。
⚠️ 但这个 `source` 报错**会把完整 key 打到本地终端**，别反复触发；日志与仓库本身不含 key。

### 1.5 启动阶段的重试（别再被链路抖动掐死）

`submit` 在起跑前会先远端 `mkdir`、再逐个 `scp` 上传 plan。box 的 22 端口链路**间歇性抽风**：
`scp` 直接 `exit=1`、没有任何 stderr，同一命令手工跑就成功。**这两步现在都包了 `retrySync`**
（mkdir 4 次 / 每个 plan 5 次，间隔 2 秒），重试时打 `⚠ round-N plan 上传第 i 次重试…` ——
看到这行是**正常现象，不是故障**；修之前它会把整次启动掐死（`✗ 上传 round-N plan 失败`）。

`status` / `pull` 里的 `scp` 仍是裸调用：瞬时 `✗ scp 拉取失败` 同样属链路抖动（本地旧副本保持不动），
重跑一次即可。要看**不掺抖动**的真实进度，优先直连：

```bash
ssh root@185.242.234.48 'cat /root/board-games/.work/remote/<名>/round-1/progress.json'
ssh root@185.242.234.48 'wc -l < /root/board-games/.work/remote/<名>/round-1/games.jsonl'
```

---

## 2. 看进度：跑到第几步了

### 2.1 实时盯（不落本地）

```bash
node scripts/experiment-batch.mjs status --watch --batch vplus-r10s
# 每 30 秒 cat 远端 progress.json 原文；--interval 30 --iterations N（0 = 一直看）
```

`progress.json` 字段：

```json
{ "total": 120, "done": 12, "gameNo": 13, "ply": 53,
  "wdl": { "w": 9, "d": 1, "l": 2 },
  "elapsedS": 2000, "etaS": 7150, "meanGameS": 66 }
```

### 2.2 一次性快照

```bash
node scripts/experiment-batch.mjs status --batch vplus-r10s   # 顺带把产物拉到本地
```

### 2.3 判断「跑完没有」——用行数，不用 grep

**关键事实**：`games.jsonl` **只收录已完成的局**，每行一条终局记录（`winner`/`result`/`moves`…），
**没有 `status` 字段**；跑挂的局只进 `checkpoint/`。

```bash
ssh root@185.242.234.48 'wc -l < /root/board-games/.work/remote/vplus-r10s/round-1/games.jsonl'
```

| 文件 | 装什么 |
|---|---|
| `round-<i>/games.jsonl` | **已完成**的局（每行一条）⇒ 完成度 = 行数 |
| `round-<i>/checkpoint/` | 每局状态（`ok`/`error`）与断点，续跑靠它跳过已完成局 |
| `round-<i>/progress.json` | 进度快照（见 §2.1） |
| `round-<i>/round-summary.json` | **worker 正常收尾才写**；缺它 = 这轮没跑完 |

> ⚠️ 别写 `grep '"status":"ok"' games.jsonl`——那个字段不存在，永远 0 命中，会让你误判「一局没跑」。

### 2.3a 腿成分体检：这批到底吃了多少 lfree（跨轮对比前的必查项）

每局展开文件 `round-1/games/round-1-game-N.json` 的**每一手**都带 `moves[].ai`，
其中 `ai.ch` = 渠道、`ai.mdl` = 实际回话的模型、`ai.ms` = 耗时（是 number 才算真打上游）。
腿成分 = 对**全批所有手**统计 `ch:mdl` 的分布。**官方直连臂全是 `jev-1.13`；锁 `zen-o2a` 腿全是
`jev-1.13-free`；网关多源混路由会两种都有 ⇒ 那批不可跨轮比**（§1.3b）。

```bash
# 本地已 pull 时（d= 换成远端路径就是远端现算）：
node -e "const fs=require('fs'),c={},d=process.argv[1];for(const f of fs.readdirSync(d)){const g=JSON.parse(fs.readFileSync(d+'/'+f));for(const m of g.moves||[]){const a=m.ai||{};if(!a.mdl)continue;const k=a.ch+':'+a.mdl;c[k]=(c[k]||0)+1}}console.log(Object.entries(c).sort((x,y)=>y[1]-x[1]))" .work/remote/<名>/round-1/games
```

实读例子：`[["jevrouter:jev-1.13-free",12345], ["rapfi:…",…]]` = 100% 官方克隆；
一旦出现 `jev-1.13`（**无 `-free`**）的行就是 lfree 腿，**占比 > 0 必须在报告里注明，
且禁止与官方直连批比比分**。同一命令对历史批次批量扫，就得到「污染地图」。

### 2.4 断点续跑

worker 被 kill / 断网后，重入同一个 plan：checkpoint 里 `ok` 的局跳过，`error` 的局复用同一
`gameUid` 重跑（幂等，不产生重复行）。

```bash
node scripts/experiment-batch.mjs resume --batch vplus-r10s --round 1
```

### 2.5 ⚠️ `round-summary.json` 存在 ≠ 这一轮跑完了

`round-summary.json` 是**单轮账本，每轮整体重写**，不是累计战绩。worker 把 120 个**槽位**跑完就写它并退出，
哪怕其中一半是 `error` —— 从此 `status` 认为该轮结束，**不会再提示缺口**。

vplus-r10s 实测：10:31 写下 summary 时 120 个槽位里只有 66 个 `ok`、54 个 `error`，缺口被静默吞了，
靠人工监督续跑才在 11:15 上游恢复后补到 120。

| 要问的问题 | 看哪个文件 |
| --- | --- |
| 累计跑成多少局 | **`round-1/games.jsonl` 的行数** |
| 这一轮发生了什么 | `round-1/events.jsonl`（含 `game-skip` / `round-end`） |
| 轮内记账 | `round-1/round-summary.json`（**会覆盖，只反映最后一轮 pass**） |

另外，`round-summary.json` 里 `games[].status` 出现 `skipped` 是正常的——上一轮已完成的局这轮跳过。
它的体积会随「完整 `ok` 记录 → 短存根」而大幅缩小（实测 314 B/条 → 121 B/条，66 条省 12.4 KB），
**体积变小不等于丢数据**：存根带 `gameUid`，完整棋谱始终在 `games.jsonl`。

---

## 3. 上游挂掉时的自动续跑（长跑必备）

**上游 502/530 时 worker 不会崩**——它会把剩下的局逐局秒判 `error`，然后**退出码 0 正常退出**，
日志末行印 `worker 完：63/158 局正常`。**只看这一行会误判成正常结束。**

所以长跑要挂监督循环：worker 不在且行数没满 → 重入同一个 plan。模板见
[scripts/ 旁的 §6 示例](#6-监督脚本模板)（vplus2 与 vplus-r10s 实测有效，能扛住中途断供）。

判「该不该续跑」的两个条件缺一不可：

- `alive`（worker 进程在不在）
- `done`（`games.jsonl` 行数，**按行数不是 grep status**）

两个都满足「worker 没了 + 没跑满」才重拉，否则会反复重拉一个已跑完的 batch。

⚠️ **同一台 box 上不要并行跑两个 worker 批次**（2026-10-15 补，ADR-0025）：
`--parallel` 闸门只管双臂并行，**拦不住「两个批次并行」**——2 核 box 上两进程各吃 82% CPU，
rapfi 的固定墙钟预算（`timeout_turn` ms）被饿、搜索节点减半 ⇒ 对手真实变弱、批间对比单向污染。
多批次必须串行：前一批满员后再 submit 下一批（box 侧看护脚本可代劳等待，如 `off-serial-guard.sh` 的模式）。

⚠️ **监督脚本自己也会先到期**：`MAX_ITER` 轮 × 60 秒就是它的寿命（vplus-r10s 那个是 400 轮 ≈ 6.7 小时，
实验跑到第 7 小时时它先退了，**worker 还活着、实验照跑**）。**看到 `[sup] 达到迭代上限，退出` 不等于实验结束**，
仍要看 `games.jsonl` 行数。长跑就把 `MAX_ITER` 放大到实验时长的 2–3 倍。

⚠️ **别用 `pgrep -f "supervise.sh" | pkill` 预清理**：`-f` 匹配完整命令行，**会匹配到你自己那条启动它的
ssh 命令并把它自己杀掉**（实测：输出断在半句、根本没启动）。直接启动，再 `ps` 验证只有一个实例。

⚠️ **手动起过 worker 之后又挂看护 = 两个 worker（2026-10-16 实测踩中）**：看护的存活检测是
`pgrep -f "experiment-worker.mjs --plan $PLAN"`（**绝对 plan 路径**），手动那条若用相对路径启动就匹配不上
⇒ 看护判定「worker 死了」⇒ **再拉一个**，2 核 box 上双进程并行（ADR-0025 明令禁止，且违反
[plans/2026-10-14-official-rerun.md](plans/2026-10-14-official-rerun.md) 的串行纪律）。
**自检纪律：worker 与看护都起来之后，`ssh … 'ps -ef | grep -c "[e]xperiment-worker"'` 必须是 1**，
不是 1 就全停重来（**只用显式 PID 杀，别用 `pkill -f`**，见上一条）。

### 3.1 ⚠️ 连通性探针会骗人：判上游好坏要看真实对局

vplus-r10s 第 65–120 槽位被同一个错误打废：

```
API 错误 400：the model uses an upstream protocol that opencode2api does not expose
```

而**同一时刻**用仓库那套连通性探针（单问 `noul`）打网关，**3/3 全部 HTTP 200 正常返回**。
真实对局（move/edge/position 三问）流量却 100% 被拒——网关多源路由轮换，轮到 `opencode2api` 就挂，
探针恰好都轮到了能用的源。

| 想知道的 | 该看 |
| --- | --- |
| 上游坏没坏 | `round-1/events.jsonl` 里真实对局的 `status`，**不是**探针 |
| 上游恢复了没 | 某局 `ply` 是否持续上涨（如 56 → 115 → 148）＝ 真的在逐手往返 |

**速败判据**：一局 `durationMs` ≈ 60000 且 `plies` 为空 = 撞上游 400，不是棋局。
恢复后的第一局可能很慢（ply 100+、十几分钟），那是在真下棋，别误判成又挂了。

---

## 4. 读战绩

### 4.1 一步出报告（能力 + 成本 + 判读结论）

```bash
node scripts/experiment-report.mjs --batch vplus-r10s
# → .work/vplus-r10s-report.md ；--json 另出机器可读数字（含 records 与四块判读结论）
```

报告含胜/和/负、不败率、Wilson 区间、接管直方图、成本三口径（`tac_ms` / 单步墙钟 `ms` / 上游 token）、
开局分层、Elo，以及四块判读结论（`versionMatrix` / `curveComposition` / `levelTable` / `levelPower`）。

**成本只算真打上游的手**（`ai.ms` 是 number）；Rapfi/mock 侧是 null，缺失不记 0。
`tac_ms` 为 NULL 的那一侧就是不过战术层的那一侧。

### 4.2 败局解释（规则 11 必做）

```bash
node scripts/loss-report.mjs --batch vplus-r10s --ours jevrouter
```

回答「这批是怎么输的」：我方最后一手走的哪一层、怎么终局、手数分布 + 从哪一手起此后每步仍必败。

> ⚠️ **`--ours <channel>` 缺省是 `official`**。跑 `jevrouter` / `proxy` 臂时忘了给，
> 会被判成「每一局都找不到我方」而**静默返回 0 局**（输出末尾的 `跳过：{"noOurs":13}` 就是征兆），
> 不是报错。两个字段含义不同：「我方」按**渠道**认（`blackChannel`/`whiteChannel`），
> 别拿战术档当身份（playbooks §7 第 7 条）。

vplus2 那轮用它证明了 122 局败局里 **P0 送杀/P1 漏挡/P2 漏胜/P3 漏链/P4 压力恶化 全为 0**。

### 4.3 判读纪律（务必先读 playbooks §7 第 8/11/12 条）

- **样本 < 50 局不出结论**。同档轮间方差实测 17.5 pt > 档位之间的差 ⇒ 跨档位比分不是曲线。
- **区间重叠就写「不可判」**；擦边不重叠（差 < 1 pt）不算结论（L4 实测 0.3 pt 在样本 60→80 后翻回重叠）。
- **每轮必报胜 / 和 / 负 + 不败率**，并单独交代败局（§4.2）。规则 11：「负局不增加」是及格线。
- **满盘和棋会稀释胜负信号**：`--max-plies 225` 打满判和。和棋可接受，不是缺陷。

> **节奏预期**：`rapfi@10000` 单局时长方差大——快的 26 手 ~66s，225 手满盘和棋能到 900s。
> 头几局别用来估 ETA（容易被一个满盘和棋带偏 3 倍）；看 `progress.json` 的 `meanGameS` 滚动均值。

---

## 5. 取数据

### 5.1 拉回本地

```bash
node scripts/experiment-batch.mjs pull --batch vplus-r10s
# → .work/remote/vplus-r10s/   （先拉临时目录再整体替换，失败不动本地旧副本）
```

拉到的是 `round-<i>/` 全部产物：`games.jsonl`（逐局终局记录）、`games/*.json`（逐局展开）、
`checkpoint/`、`progress.json`、`round-summary.json`、`events.jsonl`。

⚠️ **两个坑**（vplus-r10s 收口时各踩一次）：

1. **`pull` 的 scp 没有重试**（§1.5 只给 `submit` 的上传路径包了 `retrySync`）。链路抽风时它连挂两次。
   兜底：自己 `scp` 并重试——
   ```bash
   scp -r -o BatchMode=yes -o ConnectTimeout=15 \
     root@<host>:/root/board-games/.work/remote/<名>/round-1/games .work/staging
   ```
2. **`experiment-report.mjs` 读 `games.jsonl`，而 `loss-report.mjs` 读 `round-<i>/games/*.json`——
   两个工具读的不是同一个源。** 只拉到 `games.jsonl` 时，`loss-report` **不会报错**，会按「本地已有的那些
   逐局文件」出报告（我一度拿到 50 局的盘点，与报告的 120 局对不上才发现）。

   ⇒ **收口第一件事**核对两个数一致：

   ```bash
   wc -l < .work/remote/<名>/round-1/games.jsonl
   ls .work/remote/<名>/round-1/games/*.json | wc -l
   ```

### 5.2 算 Elo / BT

```bash
node scripts/experiment-batch.mjs elo .work/remote/vplus-r10s --bootstrap 400
```

顺序 Elo + BT（Δ 点估计 + bootstrap 区间）。锚点缺省 `rapfi||500`；`--no-bt` 退回纯顺序迭代。

### 5.3 下游分析入口

拉回来的 `games.jsonl` / `games/*.json` 是所有离线分析的输入。**只允许聚合口径**——
胜/和/负、不败率、Wilson 区间、接管直方直、成本、Elo、开局分层。
**禁止**跨机逐手对齐、逐手复算核对（ADR-0019「后果」：Node rapfi 与浏览器推理路径不同，
逐手比对不可复现，拿它当证据就是伪证据）。单局逐手对齐只允许同机同进程做。

---

## 6. 监督脚本模板

长跑（尤其过夜的）挂这个，源文件放远端 batch 目录、`setsid nohup` 起：

```bash
#!/usr/bin/env bash
# 事实一：上游挂掉 worker 不会崩，只会把剩余局秒判 error、退出码 0。
# 事实二：games.jsonl 只收录已完成的局（无 status 字段），完成判据 = 行数，不能 grep status。
DIR=/root/board-games/.work/remote/<batch>
PLAN=$DIR/plans/round-1.json
LOG=$DIR/logs/round-1.log
F=$DIR/round-1/games.jsonl
GAMES=<局数>
for i in $(seq 1 400); do
  total=$(wc -l < "$F" 2>/dev/null || echo 0); total=${total:-0}
  alive=$(pgrep -f "experiment-worker.mjs --plan $PLAN" >/dev/null && echo 1 || echo 0)
  echo "[sup$i] done=$total/$GAMES alive=$alive $(date -u +%H:%M:%S)"
  [ "$total" -ge "$GAMES" ] && { echo "[sup] 全部完成，监督退出"; exit 0; }
  if [ "$alive" = "0" ]; then
    echo "[sup] worker 已退出，重入 plan 续跑"
    cd /root/board-games
    setsid nohup node scripts/experiment-worker.mjs --plan "$PLAN" >> "$LOG" 2>&1 &
    sleep 20
  fi
  sleep 60
done
```

起它（脱离 ssh）：

```bash
cd /root/board-games/.work/remote/<batch>
setsid nohup bash supervise.sh >> logs/supervise.log 2>&1 &
echo $! > logs/supervise.pid
```

> 监督脚本只重建「worker 不在且没跑满」——**不要**用 `grep -c '"status":"ok"'` 判完成（字段不存在），
> 也**不要**在 `|| echo 0` 上叠 `grep -c`（0 匹配时 grep 已打印 `0` 又返回码 1，会拼成 `"0\n0"` 让整数比较报错）。

---

## 7. 跑完之后

1. `pull` 拉回 → `experiment-report` 出报告 → `loss-report` 解释败局。
2. **跑 §2.3a 的腿成分体检**（跨轮比分的批必做；> 0 lfree 就写进报告的限制条件）。
3. 结论写进 [status.md](status.md)（**胜/和/负 + 不败率 + 败局交代**）与对应 plan/ADR。
4. 踩坑/运维教训追加到 [memory/MEMORY.md](memory/MEMORY.md) **顶部**。
5. 若改过战术层，同步 [../src/core/tactics-versions.ts](../src/core/tactics-versions.ts) 版本表。

## 相关

- [agents/playbooks.md](agents/playbooks.md) §7–§8 —— 浏览器实验路 + 判读纪律（本文共用）
- [adr/0019-remote-batch-experiments.md](adr/0019-remote-batch-experiments.md) —— 远端批量地基决策
- [adr/0021-standalone-experiment-plane.md](adr/0021-standalone-experiment-plane.md) —— 离线运行面（直连上游 + 本地 JSONL）
- [adr/0024-jevrouter-gateway-channel.md](adr/0024-jevrouter-gateway-channel.md) —— jevrouter 网关渠道（BYOK / 形状闸门）
- [adr/0025-channel-equivalence-and-comparability.md](adr/0025-channel-equivalence-and-comparability.md) —— 渠道等价性（§1.3b 的依据）与「必须串行」纪律（§3）