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
- **离线复算**（`.work/v10-replay.mjs`，逐局重放 27 局 rapfi 归档，用真引擎 + 真 v10 战术判断「会不会接管、接管的点是不是归档实走的那一手」）：
  结果见 §6 表（跑完回填）。

## 6. 对照实验（进行中）

- **顺序**：提交 + push → CI 五步 → `npm run deploy` → 再跑两臂（浏览器加载的是**已部署 bundle**，所以必须先部署）。
- **两臂串行**（`jev` 档限流按出口 IP 60 次/分，并行会互相顶穿）：

  ```bash
  # A 臂（基线 v9）
  node scripts/experiment-run.mjs --games 4 --chanA proxy --chanB rapfi \
    --tacA v9-vcf-sound --thinkB 500 --out .work/exp-arm1-v9.json
  # B 臂（v10）
  node scripts/experiment-run.mjs --games 4 --chanA proxy --chanB rapfi \
    --tacA v10-live3 --thinkB 500 --out .work/exp-arm2-v10.json
  ```

- **变量唯一**：对手（Rapfi 500ms）、局数、黑白交替（A 侧奇数局执黑）全同；Rapfi 侧不走战术层（既有决定），
  所以差异只可能来自 proxy 的战术档。
- **口径**：局分（胜/和/负）、平均手数、逐手上游调用与 token、归档 uid；
  补充证据用离线复算的「接管次数 / 命中率」。

| 臂 | 档位 | 对手 | 局数 | 结果 | 平均手数 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| A | `v9-vcf-sound` | `rapfi@500ms` | 待跑 | 待填 | 待填 | 基线 |
| B | `v10-live3` | `rapfi@500ms` | 待跑 | 待填 | 待填 | 新机制 |

## 7. 仍未闭环

1. **对照实验未跑**（本文 §6 的两臂），以及离线复算的最终数字（§5 末条）。
2. **`live3Deny` 的候选顺序依赖模型概率表**：榜外的点只按 `oppMakers` 顺序补，理论上可能漏掉更优的拆点
   （已由 `LIVE3_DENY_EVAL_MAX` 与「对手 L3 点优先」兜住大半）。
3. **只到 4 手**：>4 手的杀仍要靠 Rapfi 或对手失误；`v11` 若要继续，方向是「L4 = ≥2 个 L3」的递归阶梯（成本会指数上升，需先做预算）。
4. **登记表的 `games` / `gamesVerified` 仍是 0**：归档里还没有 v10 的局（本次两臂跑完即可回填）。

## 8. 下一步候选（未承诺）

- ~~满盘成本实测~~ 已做完（§5）：单步最大 251ms，未触发优化阈值（200ms 早退策略暂不需要）。
- `docs/status.md` 仍存在第 21 条（`jev` 限流极端场景）在两臂串行跑完后复核一次实际峰值。
