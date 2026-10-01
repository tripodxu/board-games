# ADR-0014：战术层新增「活三真推演」两级（live3Attack / live3Defense），把 4 手内必胜从标签匹配升级为推演

- 状态：accepted（2026-10-02）
- 背景：2026-09-30 的 27 局 `proxy vs Rapfi` 归档里，proxy 战绩 **1 胜 5 和 21 负**。
  逐局复盘（`.work/analyze-rapfi.mjs` / `analyze-rapfi2.mjs`）得到两条硬数据：
  1. **只有 2/27 局**是被 7-ply 冲四链（VCF）将死的 —— 也就是说 v7/v8/v9 三代把力气
     花在 VCF 上，而那并不是主要输法；
  2. **27/27 局**都出现过「对手下一步就能造活三」（= 对手 4 手内必胜）的局面，
     首次可用手数中位数 **13**；其中 proxy 当时**有**能一次性拆掉该威胁的点的局，
     拆掉 13 局 / 漏掉 14 局。漏掉的 12 局集中在同一形态：proxy 执白、黑方第 6 手
     就能在反对角线（r+c=14）上造出**带空隙的四**，而 proxy 那一手走了毫不相干的静点。

- 根因（两层都失效，缺的是「真推演」而不是「再多一条标签」）：
  - `parry3` 层读的是模型返回的 `deny:live3` / `deny:open4` 标签，而
    `src/core/engines/gomoku.ts` 的 `labelPoint` → `liveThreeDir` **只认连续 `_XXX_`**：
    跳活三、斜线组合、带空隙的四（`_X_XX_` 一类）一个标签都打不出来。
    归档局面实测：那条线上的四点 `C13/D12/F10/G9` 的 criteria **全是 `null`**。
  - `parry` 层读的 `danger_points_opponent` 只是「活四制造点」= **2 手**必胜，
    覆盖不到 4 手才兑现的活三威胁（该局面 `danger_points_opponent` 为空）。
  - 结论：v9 在这种局面**必然**只能按模型概率走（实测走了静点，随后被慢杀）。

## 决定

1. **把「三」量化成阶梯，和 `fiveCompletions` 用同一把尺**（落子成五点计数），
   于是每一级都能用数字验证，不再依赖形状字符串：
   - **L1 五点** = 落子即五连；
   - **L2 活四制造点** = 落子后成五点 ≥ 2（2 手内必胜）——就是既有的
     `you:open4` / `chance_points_you` / `danger_points_opponent` 口径；
   - **L3 活三制造点** = 落子后 **L2 的个数 ≥ 2**（4 手内必胜：对手只能挡一个）。
     L3 是本篇要补的那一级，它天然覆盖跳活三、斜线组合与带空隙的四。
2. **引擎新增两个可选方法**（`src/core/types.ts`，实现只在 `gomoku.ts`）：
   ```ts
   live3Makers?(st: S, sideId: string): string[]
   live3Deny?(st: S, sideId: string, candNotations: string[]): Live3Deny   // { before, after, best: string[] }
   ```
   - 只用「邻域空点」（切比雪夫 ≤2，与 `candidates()` 同规则；L3 点必与己子相邻）；
   - 在 `clone(board)` 的拷贝上落子/撤销，不污染传入状态；
   - 禁手模式下黑方的禁手点不计入（与 `fiveCompletions` 的既有口径一致）；
   - `live3Deny` 先试「对手的 L3 点」，并用 `best+1` 截断比较 + `best===0` 立即返回，
     实测 28ms（`live3Makers` 9–20ms），而一次 Jev 调用约 1s，代价可忽略。
3. **战术层新增三个事实**：`live3_you` / `live3_opponent` / `live3_deny_points`，
   进 Jev 提示（`attachFacts` 追加英文说明），并被接管链消费。
4. **接管链插入两级**，位置在 `vcfDefense` 之后、`parry` 之前：
   ```
   win > block > open4 > threat > vcfAttack > vcfDefense > live3Attack > live3Defense > parry > parry3 > parry4
   ```
   于是「接管层数」口径从 9 级变 **11 级**（v10 档）。放在 VCF 之后是因为 VCF 是
   3–7 手的**强制**链（更近），放在 `parry` 之前是因为 parry 只看得见 2 手剑。
5. **闸门：只在对手没有 2 手杀时才动这两层**（`danger_points_opponent` 为空）。
   理由：对手 2 手剑时我们先抢 4 手剑会**输速度**；这种情况下 `parry` / `vcfDefense`
   去处理更短的威胁才是对的。攻击层额外要求自己真有 L3 点。
6. **登记表加 `v10-live3` 并设为 `CURRENT`**（机制只能逐版累加：v9 全开 + 两个新键），
   与 ADR-0009 的登记表规则一致；旧档行为逐位不变（v9 及以前不给这三个事实）。

## 代价与不做什么

- **只到 4 手**：5 手以上的织网（活二转活三、双二协同）仍不覆盖。
  ADR-0007 §5「不是完整 VCT」的定位不变 —— 本篇只是把它的下界从 2 手抬到 4 手。
- **`live3Deny` 报的是「能清零的点」而非全局最优**：它按候选序找点并提前退出，
  `best` 是并列最优里最先评估到的那个。接管链把它交给 `pickAmong`，因此模型概率
  覆盖到的并列点会被优先采用。
- **不引入随机性、不改采样**：命中后仍走原有 top-k 加权采样，只是候选集换成了战术点。
- **不碰 mock / rapfi 渠道**：它们本就不走战术层（`src/core/jev/client.ts` 的既有决定），
  「Rapfi vs Jev」的实验变量因此保持纯净。

## 验证

1. **归档实战局面**（`games/2026-09-30/gomoku-20260930025710.json` 前 5 手，轮白）：
   `live3Makers(black)=['F10','D12']`、`live3Makers(white)=[]`、
   `live3Deny(white)= { before: 2, after: 0, best: ['F10'] }`；同一局面 criteria 里
   `C13/D12/F10/G9` 全为 `null`（v9 盲区实证），`danger_points_opponent` 为空。
2. **决策级**（`test/engines/tactics.test.mjs` ⑤b，共 5 条）：v10 被
   `live3Defense` 接管走 F10（v9 同局面原样走模型偏好的静点）；抢攻夹具被
   `live3Attack` 接管；对手有 2 手杀时**让位**给 `vcfDefense`（不走 live3Attack）。
3. **成本实测**（225 手满盘归档棋谱）：`live3Deny` 真正干活的局面（对手 L3 点 2–6 个）单次
   20–133 ms、v10 档 `computeTactics` 总耗时 141–251 ms（同局面 v9 为 100–110 ms）；
   空点从 185 降到 35 时 v10 总耗时 139 → 13 ms。相对一次 Jev 调用（~1 s）可接受，
   且随空点减少快速回落，故**不加**早退/排序优化。
4. **离线复算**：27 局归档逐手重放，问「v10 会不会接管 / 接管的点是否就是归档实走」
   （见 `docs/plans/2026-10-02-tactics-v10-live3.md`）。
5. **真跑对照实验**：`v9-vcf-sound` vs `rapfi(0.5s)` 与 `v10-live3` vs `rapfi(0.5s)`
   各 4 局，同对手、同思考时长、黑白交替（见同一篇 plan 的执行记录）。

## 对既有 ADR 的处置

- **ADR-0007**（VCF 威胁空间搜索）与 **ADR-0008**（守方反杀闸门）的决定本体不变：
  VCF 段、优先级次序、soundness 闸门都保留；本篇只是**在它后面**加了两级更浅的推演。
- **ADR-0009**（版本登记表）规则不变：新增一版、rank 连续、机制单调、`CURRENT` 是末档；
  `MECHS` 由 12 键扩到 14 键（`live3Attack` / `live3Defense` 插在 `vcfDefense` 之后）。
- **教训**：把「活三」写成 `_XXX_` 形状匹配，等于把一个**深度概念（4 手内必胜）**
  编码成了一个**形状概念**。形状能覆盖的局面远少于深度，且失配时是静默的
  （标签为空、层不触发、没有任何报错）——27 局里 14 局就是这么输的。
  凡是「几条命」这类深度语义，都应该用「再走一步还能剩几个威胁点」的推演来定义。
