# ADR-0009：战术版本登记表 + 机制闸门 + 棋谱归因（实验设施三件套）

- 状态：accepted（2026-09-30）
- 背景：战术保险从 v1 到 v9 一共 9 次提交累加上线（`678b701` → `a16fdd9`），
  每一次只加一两层机制，代码侧没有「现在跑的是哪一版战术」的概念。后果是
  **实验不可归因**：一盘棋下输了，说不清是模型问题还是某一版战术引入的问题；
  旧棋谱更没有版本字段，连复盘时对照代码都做不到。v9（soundness 修复，
  ADR-0008）之后，同一条接管链上实际并存 10 种可复现行为（9 档 + 无战术基线），
  继续靠「读 git log 猜」已经不可接受。

## 决定

1. **`js/tactics-versions.js` 战术版本登记表（纯函数，零依赖）**：10 个条目，
   每条含 `id / name / rank / commit / commitAt / date / mech / games / gamesVerified / note`。
   权威来源 = **git 历史 × 棋谱数据双锚定**（用户要求「每一版都要有，不能遗漏」）：
   版本边界只认 commit 时间（`git show -s --format=%ci`），归档局数由棋谱
   `exported`（UTC → 北京时间）对照时间梯级 + `moves[].tactics` 标签实证得出
   （parry3 ⇒ ≥v4、parry4 ⇒ ≥v6、vcfAttack/vcfDefense ⇒ ≥v7）。
   `resolve(id)` 归一（空/未知 → `CURRENT`）、`allows(ver, mech)` 闸门查询。

2. **`js/duel.js` 对阵联名（纯函数）**：`sideLabel / duelLabel / gameLabel / expLabel /
   slug`。slug（如 `jev-v9-vs-ran-v3`）同时进三处：战绩簿展示、实验汇总、
   **服务端棋谱文件名**（`server.js` 与 `functions/api/games.js` 两端，slug 缺省
   回退 gid，脏字符消毒）——git log 与磁盘文件都能直读对阵。

3. **版本闸门落在 `js/jev-client.js` 接管链**：每一级先查 `ver.mech.xxx`，
   该版本没有的机制整条跳过（不是降级为低优先级——是**不存在**）。
   `decide()` 按 `opts.tacticsVersion` 解析档位并写入 `meta.tacticsVersion`；
   `BG.util.aiMoveMeta` 增 `tv` 字段，`BG.codeVersion` bump 0.7.0 → 0.8.0。
   mock/rapfi 渠道在 `decide()` 内早退，不经过战术层——闸门只对 Jev 渠道与
   random 渠道（对照组）可见。

4. **`S.settings.sideConfig` 双方自由配置**：黑白各自覆盖 渠道/战术/思考时长，
   空 = 继承全局。人机与实验共用同一套（替代原 `S.expChannels` 双轨），
   实验开跑时借走 sideConfig、手动开局时归还。
   棋盘下方**战术沿革条**把 10 枚版本做成可点击 chip：点击只改全局默认档，
   不动显式指定的覆盖。

5. **换边重开（R6）= 换边重开 semantics**：原局按 `winner:null + reason:'换边中断'`
   记「未终局」（照常记账/导出/同步），随后交换我方执子重开。不写 localStorage、
   不伪造终局；未终局的 `firstWin` 置 null，分胜负统计与校准取样一律剔除。

## 备选方案（已否决）

| 备选 | 否决理由 |
|---|---|
| 用 git tag 标版本（`tactics-v9`） | 标签不进棋谱 meta：棋谱归档在 Pages/本地，回溯时照样要对 git；且 tag 会被 force-move 改史 |
| 每个实验开一个分支 | 跨分支 diff 噪音淹没主线；合并冲突集中在同一个战术文件上；实验数据仍要跨分支找 |
| 版本号写死在 `jev-client.js` 常量里 | 每加一版战术都要改客户端 + 改测试，登记表与实现两处漂移 |
| 沿革条点击直接改 sideConfig | 「默认档」与「显式覆盖」两个语义混用，用户以为改了覆盖，其实只改了缺省 |

## 后果

- 每局多一次 `resolve()` 与一次二级缓存查询（`jev-client` 的 tacCache：
  state → Map(verId → res)），实测可忽略；缓存 key 必须用**收敛后的 id**，
  否则同一档位的不同脏 id 会重复计算。
- 旧棋谱无 `slug`：服务端回退 gid，`games/` 旧文件名仍可 GET（NAME_RE 未动）。
- 旧 `localStorage` 无 `tacticsVersion`/`sideConfig`：`loadSettings` 自动补齐默认值。
- 12 个机制键只能由登记表定义处增删；新加战术层必须同步登记表 + `games` 数，
  否则版本归因断裂（`tacticsRegistryTests` 有合计局数与 rank 连续两道护栏）。

## 修订（2026-09-30，pull 后归因校验）

一次 `git pull` 带进 6 份新棋谱后做全量归因盘点，发现**登记表的「局数」口径会骗人**，
以及**导出侧把人类一方写成了 Jev**。两处都改动归因输入，故在此补记。

### 修正一：`games` 是窗口数，不是「跑过这版的局数」→ 增 `gamesVerified`

原设计只用「文件名 stamp 落时间窗」归组，并在 note 里记录了部署滞后。问题在于
`games` 这个**数字**仍被当作版本战绩读：20 份 `meta.code=0.7.0` 的棋谱（线上没重新
部署，实际是 v7 档）stamp 全落在 v9 窗口，于是 `v9.games` 写成了 20，
`v9.gamesVerified` 其实只有 4（本轮 A/B 的 3 局机机 + 1 局人机）。
反方向同样成立：`v7.games=4` 而 `v7.gamesVerified=20`。

- 两个口径都是真话，但**不能混读**：`games` = 窗口归属，`gamesVerified` = 有
  每手 `ai.tv` 或 `meta.code` 实证。战术沿革条与登记表 note 同时展示两者。
- 新增 `DEPLOY_LAG` 台账（起止 stamp + 局数 + code）与纯函数
  `auditCode(entries, opts)`：给 `[{name, code}]` 返回「窗口 vs 实际 code」错配条目，
  按 stamp 是否落在台账窗口内分 `knownLag`（历史债，计数可见）/ 未登记（回归，自检红）。
- `archiveAttributionTests` 用真实 `games/` 跑 `auditCode`：既要求 0 条未登记错配，
  也要求台账条数与 `DEPLOY_LAG.games` 相符。**此前当前档只断言 `games >= 登记数`，
  这 20 局就是这么漏过去的**；已实测「注入一份伪造滞后棋谱 → 自检立即红」。

### 修正二：导出侧没给人类一方打 `human` 标记 → `exportSideCfg`

`duel.SideLabel/sideSlug` 早就支持 `cfg.human`（输出「我 / me」），但棋谱导出与战绩簿
都直接取 `effSide('black'|'white')`（纯渠道配置，不带 human）。后果：人机局被写成
`jev-v0-vs-jev-v0` / `黑 Jev·v0 vs 白 Jev·v0` 这种**机机镜像局**，随后被当成
「v0-off 基线对照组」读——而归因链路的输入正是这个 slug。实测 3 份真棋谱这么撒过谎。

- 新增 `exportSideCfg(sideId)`：以 `isAISide(id)` 判定，人类那一侧补 `human: true`；
  棋谱导出与战绩簿两处共用。屏幕显示（`sideLabelText`）早已按 `S.humanSide` 分流，
  现在导出这条路径口径一致。
- 双人局两侧都标 `human` → `me-vs-me`；真机机局行为不变（`jev-v9-vs-jev-v8`）。

### 修正三：「认输」不分人判机判 → `endBy`

`认输` 目前唯一入口是人手点 `#resignBtn`（`app.js`），但在机机实验里这也算一局
「引擎胜负」——实测 A/B 第 3 局就是 181/225 手时人手认输收场，差点被当成
v9 打赢 v8 的证据。现在 `st.result.by='human'` 经引擎 `getStatus` 原样透传，
棋谱落 `endBy`，战绩簿与实验报告标「人判」。

### 修正四：实验报告的 A/B 归属与战报归档

「实验报告」面板读 `data/experiments.json`（服务端）/ localStorage / `EXP_SEED`，
而 `games/` 里 6 轮实验只有 2 轮有战报，其中 2 轮甚至只靠写死的 `EXP_SEED` 才露面。

- **战报必须与棋谱同源**：由棋谱回溯补齐到 6 轮；`EXP_SEED` 降级为纯离线兜底。
  新增 `experimentArchiveTests` 钉死「每个 `experiment` 标签都必须有战报」，防再脱钩。
- **A/B 归属不能按渠道名比对**：`finishGame` 原来用 `winnerChan === EXP.chanA`，
  而本轮新引入的同渠道 A/B（`Jev·v8 vs Jev·v9` 都用 `proxy`）会让任何胜负都落入 A。
  改为按「胜方是黑是白」+ 局号奇偶判定（实验循环 `expGameNo=1` 时 A 执黑）。
  这条与修正一同源：**归因只能认「实际发生了什么」，不能认「配置看起来是什么」**。
- **轮级档位字段必须随战报落库**：`server.js` / `functions/api/experiments.js` 的 POST
  归一化曾把 `tacA/tacB/thinkA/thinkB` 丢掉，导致归档后读不出跑的是哪一版；
  现保留（`undefined` 省略，旧客户端形状不变），契约记在 `docs/jev-api.md` §3。
