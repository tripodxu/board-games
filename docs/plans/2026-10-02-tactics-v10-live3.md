# 计划与执行记录：战术 v10 `v10-live3`（活三真推演）与 Rapfi 0.5s 对照实验

> 状态：**代码与测试已完成并验收；对照实验进行中**。开始 2026-10-02。
> 机制决策见 [ADR-0014](../adr/0014-live3-real-lookahead.md)；本文记「怎么做的、凭什么说对了、
> 还差什么」，与 [2026-10-01-workers-d1-rebuild.md](2026-10-01-workers-d1-rebuild.md) 同一体例。

## 1. 目标（用户原话）

> 「分析第九版与搜索算法对弈的棋谱，优化，给出第十版，并做实验，与思考时间最短的搜索算法比较，看是否有进步」（m05228）

拆成三件可验收的事：

1. **复盘**：拿归档里 `jev`（战术九级 v9）对 Rapfi 的 27 局做逐手体检，找出**输法**（不是「哪一手看起来怪」）。
2. **优化**：给出第十版战术（登记表第 11 行 `v10-live3`），机制变化必须能用数字说清「修掉了哪一类输法」。
3. **实验**：与**思考时间最短**的搜索算法对弈 —— UI 里 Rapfi 档位最小是 **500ms**（`#rapfiThink` 的 `500` 档），
   两臂同对手同开局：A 臂 `v9-vcf-sound` vs `rapfi@500ms`，B 臂 `v10-live3` vs `rapfi@500ms`，各 4 局、黑白交替。

## 2. 复盘：两次口径，第二次才找到真输法

### 2.1 第一轮（VCF 口径）：结论是「VCF 不是主因」

- 27 局里**只有 2 局**是被 7-ply 冲四链将死。
- 接管层级直方图：`parry3 156 / vcfDefense 137 / block 133 / parry4 126 / vcfAttack 18 / parry 10 / open4 4 / win 4`，
  **`threat` 一次都没触发** ⇒ 全程被对手牵着走，进攻层从不主动。
- 结果分布 11 黑胜 / 11 白胜 / 5 和（Rapfi 至少在该思考档下没有碾压）。

### 2.2 第二轮（活三口径）：同一类局面反复出现

- **27/27 局**都出现过「对手能造活三」的局面（中位出现手数 13）。
- v9 拆掉 13 次、漏掉 14 次；漏掉的里面 **12 局形态完全相同**：v9 执白、第 6 手（ply#6），
  对手在**反对角线**上已经摆出三子，v9 放行了活三制造点 `F10` / `D12`。

### 2.3 走查代码：为什么九级保险全部沉默

- `src/core/engines/gomoku.ts` 的 `liveThreeDir` 只认**连续** `_XXX_` 一种形状 ⇒ `labelPoint` 打出的
  `you:live3` / `deny:live3` 对跳活三、斜线组合、带空隙的四**恒为空** ⇒ `parry3` 层永不触发。
- `danger_points_opponent`（2-ply）只认「一步成五」⇒ 对手「活三 → 活四」这条 4 手杀路上没有任何保险层。
- 归档 ply#6 局面实测：`C13 / D12 / F10 / G9` 四点 `criteria` 全是 `null`，`danger_points_opponent` 为空
  ⇒ 九级接管链**零触发**，v9 只能走无意义的静点。

> **教训（已进 ADR-0014）**：把**深度概念**（4 手内必胜）编码成**形状概念**（`_XXX_`）会静默失配 ——
> 形状匹配的分母是「实现者想得到的形状」，推演的分母是棋盘本身。

## 3. 设计：同一把尺的三级阶梯

| 级 | 定义 | 含义 |
| --- | --- | --- |
| L1 五点 | 落子即成五 | 立刻赢 |
| L2 活四制造点 | 落子后 `fiveCompletions ≥ 2` | 两个成五点，对手挡不住 = **2 手内必胜**（等于既有 `you:open4`） |
| L3 活三制造点 | 落子后存在 **≥2 个 L2** | 对手只能挡一个 = **4 手内必胜**（v9 认不出的那一层） |

- 引擎新增**可选**方法：`live3Makers(st, sideId): string[]`、`live3Deny(st, sideId, candNotations): Live3Deny`
  （`{ before, after, best }`）。候选集沿用「距任意棋子切比雪夫 ≤2」的邻域空点（L3 点必与己子相邻，可证），
  全程在 `clone(st.board)` 上落子 / 撤销，不动调用方状态。
- 成本控制：`live3Deny` 先试「对手的 L3 点」（占掉最直接），用 `best+1` 截断比较、`best === 0` 立刻收工、
  最多评 24 个候选点（`LIVE3_DENY_EVAL_MAX`）。
- 战术层新增事实 `live3_you` / `live3_opponent` / `live3_deny_points`（同时进 facts 的英文指令），
  接管链在 `vcfDefense` 之后插入 `live3Attack` / `live3Defense`，**十一级**：
  `win > block > open4 > threat > vcfAttack > vcfDefense > live3Attack > live3Defense > parry > parry3 > parry4`。
- **闸门**：两级都只在 `danger_points_opponent` 为空时才动 —— 对手有 2 手杀时抢 4 手剑会**输速度**，让位给 `parry`。
- `parry3` 保留：标签命中时它更便宜，新两级是补盲而不是替换。

## 4. 实施清单（全部已落盘）

| 文件 | 改动 |
| --- | --- |
| `src/core/types.ts` | 新增 `Live3Deny`；`Engine` 上加两个可选方法签名 |
| `src/core/engines/gomoku.ts` | `nearEmpties` / `openFourAfter` / `live3After` / `live3Count` / `live3Makers` / `live3Deny`，并注册进返回对象 |
| `src/core/tactics.ts` | `TacticsReport` 三字段、`ALL_MECH` 14 键、VCF 段之后的 4-ply 段（fail-soft）、facts 三句 |
| `src/core/jev/client.ts` | 接管链插 `live3Attack` / `live3Defense` 两个 `else if`（含让位闸门） |
| `src/core/tactics-versions.ts` | 第 11 行 `v10-live3`、`CURRENT` 改指、`MECHS` 14 键、`selfTest` 断言 11 |
| `index.html` | 三处战术下拉（实验 A / 实验 B / 全局）加 v10 选项并设为 `selected` |
| `src/ui/panels/experiment.ts`、`src/core/view/duel.ts` | 注释与联名断言改为从登记表派生（不再写死 `Jev·v9`） |
| `test/engines/tactics.test.mjs`、`test/engines/util.test.mjs` | 登记表数字、层数对照（11 级）、allows 闸门、新增⑤b 五例；duel 期望值随档位 |

## 5. 验证证据

- **引擎层（归档实战局面 `L3_SEQ = H8/H7/E11/H9/B14`，轮白）**：
  `live3Makers(black) = ['F10','D12']`（20ms）、`live3Makers(white) = []`（9ms）、
  `live3Deny(white, 全候选) = { before: 2, after: 0, best: ['F10'] }`（28ms）；相对一次 Jev 调用（~1s）可忽略。
- **战术事实对照**：`v9-vcf-sound` → 三个字段全空；`v10-live3` → `live3_opponent ["F10","D12"]`、
  `live3_deny_points ["F10"]`、`live3_you []`。
- **决策级**：`random` 渠道 + v10 → `F10 / live3Defense`（防守局面）、`F10 / live3Attack`（抢攻局面），
  v9 两者都不接管；对手已有 2 手杀时 v10 让位给 `vcfDefense`（污染夹具用例）。
- **回归**：`node test/engines/run.mjs` **126 例全绿**（原 121），金样逐手差分不变（自对弈 1131 手 + 归档 54 局 4379 手）；
  `npx tsc --noEmit` 干净；`npm test` 中唯一红（`src/core/view/duel.ts` 写死 `Jev·v9`）已修，复跑 5/5 绿。
- **满盘成本实测**（`.work/v10-timing.mjs` + `.work/v10-timing2.mjs`，用归档里唯一的 225 手满盘棋谱
  `games/2026-09-29/gomoku-20260929101223.json`）：空点 185 → 35 时，v10 档 `computeTactics` 为
  **139 / 119 / 89 / 50 / 13 ms**（同局面 v9 为 107 / 87 / 64 / 38 / 11 ms ⇒ 新增的 live3 段约 +30ms）；
  **`live3Deny` 真正干活的局面**（ply 8–22，对手 L3 点 2–6 个）：`live3Deny` 单次 20–133ms、
  v10 档总耗时 **141–251ms**（v9 同局面 100–110ms）。最坏 251ms 相对一次 Jev 调用（~1s）可接受，
  且随空点减少迅速回落（ply 190 时 v10 总耗时 13ms）。**结论：不需要早退优化，§8 第一条暂缓。**
- **离线复算**（`.work/v10-replay3.mjs`，重放 27 局 rapfi 归档的每个 proxy 回合，只看 live3 层、跳过 v9 已有更高优先级
  接管的回合，51 秒跑完）：**27/27 局**都出现 v10 能接管的局面，共 **423 手**（`live3Attack` 215 / `live3Defense` 208），
  其中 **320 手（76%）归档实走的是别的点**；**26/27 局**至少有一手「该拆活三却拆了别处」（这类回合共 139 手）。
  执白的 13 局首手全是 `ply#6 live3Defense → F10`（拆前 2 个 L3 点 → 拆后 0），归档实走 H9 / H10 / F7 / I6，
  与 §2.2 认定的输法完全对上；执黑的 14 局首手是 `ply#5 live3Attack → H6`，与归档实走**相同** ——
  这一手 v9 本来就走对了，说明新层不是「见到活三就抢攻」。
- 复算口径的教训：第一版脚本每回合调 `serializeForJev` + 完整 `computeTactics`（含 VCF 搜索），27 局 20 分钟都跑不完
  ⇒ 改成「候选点本地算切比雪夫 ≤2 邻域 + 只看 live3 层 + 用归档该手的 `tactics` 字段排除更高优先级层」。
  产物 `.work/v10-replay.json`。

## 6. 对照实验

- **顺序**：提交 + push（`8751070`，CI `36901167357` 五步全绿）→ `npm run deploy`（版本 `a8a9130f-f5d8-4ee7-94eb-62e6dfdab86a`）
  → 再跑两臂。浏览器加载的是**已部署 bundle**，所以必须先部署（本机 dev 与生产不同源，跑 dev 会白跑）。
- **两臂串行**（`jev` 档限流按出口 IP 60 次/分，并行会互相顶穿）；先用 4 局探路，再补 8 局把样本放到 12 局：

  ```bash
  # 探路（4 局）
  node scripts/experiment-run.mjs --games 4 --chanA proxy --chanB rapfi \
    --tacA v9-vcf-sound --thinkB 500 --out .work/exp-arm1-v9.json
  node scripts/experiment-run.mjs --games 4 --chanA proxy --chanB rapfi \
    --tacA v10-live3 --thinkB 500 --out .work/exp-arm2-v10.json
  # 扩样（8 局）
  node scripts/experiment-run.mjs --games 8 --chanA proxy --chanB rapfi \
    --tacA v9-vcf-sound --thinkB 500 --out .work/exp-arm3-v9-8.json
  node scripts/experiment-run.mjs --games 8 --chanA proxy --chanB rapfi \
    --tacA v10-live3 --thinkB 500 --out .work/exp-arm4-v10-8.json
  ```

- **变量唯一**：对手（Rapfi 500ms，`rapfi.ts:224` 的 `Math.max(500, …)` 就是最短档）、开局、黑白交替
  （A 侧奇数局执黑）全同；Rapfi 侧不走战术层（既有决定），所以差异只可能来自 proxy 的战术档。
- **口径**：局分（胜/和/负）、手数、逐手上游调用与 token、归档 uid、**proxy 每手的接管战术直方图**
  （`.work/arm-stats.mjs` 从 `/api/games?tag=…` + `/api/games/u/<uid>` 汇总）。
- 样本量的实话：12 局/臂仍不足以做统计显著性判断，只能给**方向性证据**；机制层的证据（接管次数、离线复算）
  与局分一起看才成立。

| 臂 | 档位 | 对手 | 局数 | 结果 | 得分率 | 执黑 / 执白 | 平均手数 | tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | `v9-vcf-sound` | `rapfi@500ms` | 12（4+8） | **3 胜 0 和 9 负** | 25% | 1胜0和5负 / 2胜0和4负 | 55 | `exp-20261001174212` + `exp-20261001181244` |
| B | `v10-live3` | `rapfi@500ms` | 12（4+8） | **6 胜 4 和 2 负** | 67% | 4胜0和2负 / 2胜4和0负 | 98 | `exp-20261001174837` + `exp-20261001182552` |

**探路会骗人（样本量的教训）**：先跑的 4 局里 A=2 胜 2 负、B=3 胜 1 负，看起来只差一局；
补到 8 局后 A 掉到 1 胜 7 负、B 是 3 胜 4 和 1 负。**4 局那个「差不多」纯属运气**，
12 局/臂才给出方向性结论（仍不足以谈统计显著性）。

**机制层证据（与局分独立）**：

- 逐手接管直方图（`.work/arm-stats.mjs`）：B 臂 12 局里 live3 两层接管 **168 手**（`live3Attack` 120 /
  `live3Defense` 48），A 臂同批对手下这两个键**出现 0 次**（v9 没有该层）；B 臂「（无接管）」223 手 /
  proxy 总手数 586 手（与 D1 `SELECT COUNT(*) FROM game_moves WHERE tactics_version='v10-live3'` = 586 一致），
  A 臂是 151 / 328 手。
- 胜负结构变了：v10 执白 **2 胜 4 和 0 负**（4 局是 225 手满盘和棋），v9 执白 2 胜 4 负；
  平均手数 55 → 98（不再十几手就被打穿）。
- 上游用量（脚本计量器）：A 臂 328 次调用 / B 臂 586 次，**全程 200，零 429**
  （D1 `rate_limits` 里 `jev` 桶峰值 19 次/分，远低于 60）。
- 存档：8 局 v10 局里 4 局是和棋（棋盘满 225 手），说明**防守修好了、进攻还不够**——
  这正是下一版（L4 递归阶梯 / 抢先手）的入口。

## 7. 仍未闭环

1. **`live3Deny` 的候选顺序依赖模型概率表**：榜外的点只按 `oppMakers` 顺序补，理论上可能漏掉更优的拆点
   （已由 `LIVE3_DENY_EVAL_MAX` 与「对手 L3 点优先」兜住大半）。
2. **只到 4 手**：>4 手的杀仍要靠 Rapfi 或对手失误；`v11` 若要继续，方向是「L4 = ≥2 个 L3」的递归阶梯（成本会指数上升，需先做预算）。
3. **和棋多、胜势转不成胜**：12 局里 4 局满盘和棋（都是 v10 执白），说明拿到先手后没有把优势滚起来；
   候选方向是「L3 抢攻后仍按模型概率表退回」（当前 `pickAmong` 只在 L3 点里挑），需要先复盘这 4 局满盘棋谱。
4. **`live3Attack` 接管 120 手是否偏多**：攻击层闸门只看「对手没有 2 手剑」，未比较 L3 与模型首选的价值差；
   若出现「为抢活三而放弃更好点」的局，就该给攻击层加代价门槛（已有归档可复核）。

## 8. 下一步候选（未承诺）

- ~~满盘成本实测~~ 已做完（§5）：单步最大 251ms，未触发优化阈值（200ms 早退策略暂不需要）。
- ~~`docs/status.md` 第 21 条（`jev` 限流极端场景）复核~~ 已复核：两臂串行期间 `rate_limits` 的 `jev` 桶峰值
  **19 次/分**（限 60），全程零 429 —— 第 21 条可以降级成「仅在并行多实验时才可能触顶」。
- **复盘那 4 局满盘和棋**：v10 执白 4 局都在 225 手走满，说明防守住了但没能翻盘；先出「为什么没有胜势」的复盘口径（例如每 20 手的 L3 机会数与模型首选一致率），再决定是否做 L4。
- **攻击层的代价门槛**：用归档比对「L3 抢攻点」与「模型首选点」的后续胜率代理指标（如 2-ply danger 数），给 `live3Attack` 加一个可关的开关，再做 A/B。
- **把 v10 装进默认开局**：`src/core/persist.ts:22` 的 `DEFAULT_TACTICS_VERSION = CURRENT` 已自动跟到 v10，
  但老用户的 localStorage 里仍存着 `v9-vcf-sound`（档位是粘性的）—— 是否要在设置里提示「有新档位」值得单独决定。
