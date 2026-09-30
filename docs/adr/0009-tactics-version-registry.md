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
   每条含 `id / name / rank / commit / commitAt / date / mech / games / note`。
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
