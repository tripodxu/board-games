# 战术档位考古：14 档历史行为参数对照 git 历史

- 落成自 P3（计划 [`docs/plans/2026-10-03-tactics-fidelity-and-elo-ladder.md`](2026-10-03-tactics-fidelity-and-elo-ladder.md) §5/§6）的考古子任务；原始草稿 `.work/p3-archaeology-draft.md`（gitignored），本文件是它的正式版。
- 仓库：`E:\mimo\temp\ttemp\jev_games\board-games`；基线 HEAD = `e706e17`（2026-10-04 02:55:14 +0800，共 203 commit）。
- 范围：`v0-off` … `v13-pressure-gate` 共 14 档（`v14-live3-fresh` 已是 `fidelity: 'exact'`，不在本文件范围）。
- 本文件只确证**参数层**（15 个预算键 / sound 闸门 / 开局短路阈值 / 注入句集合与句面），方法全部可复算；**未**逐档 diff 机制实现体的演化（见 §6 缺口 1）。
- **落到代码**：按本文件结论，v1–v13 的 `fidelity` 由 `'approximate'` 升 `'restored'`、v0-off 留 `'approximate'`、v14-live3-fresh 继续 `'exact'`（见 `src/core/tactics-versions.ts`）。口径 = **参数层已逐条核对**；「机制实现体逐字等价」仍欠 §7 的 P7 `--rev` 复跑，所以 `restored` 不等于 `exact`。
- **配套工具**：`scripts/tactics-replay.mjs`（离线重放任意棋谱 × 任意档位）＋ P3 验收结果见 §9。

---

## 0. 一句话结论

**14 / 14 档的 `budget`（15 键逐键）、`sound`、`openingMin`、`promptFacts` 四项「当年值」全部能用 git 历史确证，且全部等于 P1 冻结进 `DEFAULT_BUDGET` / `FROZEN` 的值：预算键一个不差、sound 与 v9 闸门引入 commit 严格对应、openingMin 恒为 4、prompt 语义当年就等价于 `'mech'`（不是 `'all'`，且句面/句序逐字未变）。**

⇒ 建议：14 档 `fidelity` 由 `'approximate'` 升 `'restored'`（口径 = 参数层已逐条核对；`v14` 继续 `'exact'`）。**0 档**因参数缺证据必须留 `'approximate'`；但 14 档都还欠一层「机制实现体逐字等价」复核（§6 缺口 1），若项目对 `'restored'` 的定义包含「行为逐字可复现」，则升级前应先做 §7 的 P7 worktree 复跑。

顺带**否证**两条前序审计结论（`docs/plans/2026-10-03-tactics-coupling-audit.md`，commit `d199f5a`，写在 P1 之前）：
1. 审计第 109 行「v11 的原始实验与今天重跑的『v11』预算不同」（中置信）——**否证**：v11 的引入 commit `638f844` 里 VCT 预算就是 `10/3000/6`，`14/6000/∞` 只出现在同 commit 注释记述的开发期标定脚本里（`.work/vct-tune*.mjs`，未入库）。
2. 审计风险 7「attachFacts prompt 不按版本裁剪 ⇒ v0–v12 prompt 漂移」——**在 P1 后已不成立**：P1（`0b3a400`）加了 `opts.mech` 门，且实证该门对 14 档的输出**逐字等于**当年输出（§2 方法 C）。该风险描述的是 P1 之前的状态，属已修复项。

---

## 1. 方法与可证伪性依据（每格证据的底座）

- **方法 A（硬编码 ⇒ 变更必留痕）**：P1 之前，战术层调用点从不给引擎传预算 opts（`src/core/tactics.ts:297/301/314`（v13 era 行号）等一律裸调），15 个常量全部是文件内 `const`。⇒「动过该文件的 commit 集合」就是对「该常量值有没有被改过」的**完整**证据集。
- **方法 B（全时间值矩阵，本稿最硬的证据）**：遍历所有曾改动这 5 个文件的 commit（`js/jev-client.js`、`js/games/gomoku.js`、`src/core/tactics.ts`、`src/core/engines/gomoku.ts`、`src/core/jev/client.ts`），逐 commit 抽取 12 个命名常量的字面值与 `moveNum < N`：**没有任何常量在其引入 commit 之后改过数值**（原始矩阵见 §8）。P1（`0b3a400`）只把它们搬进 `src/core/tactics-budget.ts`（该文件仅此一次提交），值不变，并把调用点改成读 `ver.budget`。
- **方法 C（注入句逐字性证明）**：把每一档 era 文件里的长字符串字面量（含反引号字段名者）抽出、空白归一，逐条在 HEAD `src/core/tactics.ts` 里做子串匹配：**v0–v13 各 era 共 3/3/5/5/5/5/7/7/7/9/10/11/12 条，全部 0 miss**；且 era 的句序 = HEAD 句序在该 era 句集上的限制（`win > block > chance > vcfAtk > vcfDef > vctAtk > vctDef > danger > live3Def > live3Atk > pressure > exp`）。⇒ P1 的 `'mech'` 门对老档产出的指令段与当年**逐字、逐序相同**。
- **方法 D（调用方闸门不变）**：VCF 入口前置条件 `win.length === 0 && block.length === 0` 自 v7 起未变：`js/jev-client.js:285`（`57a9508`）→ `src/core/tactics.ts:265`（`8751070`）→ `:272`（`638f844`）→ `:278`（`472e228`）→ `:294`（`10762a6`）→ `:297`（`b6c6921`）→ HEAD `src/core/tactics.ts:336`；唯一增量是 P1 加的机制门 `(M.vcfAttack || M.vcfDefense)`。
- **时代分界**：v1–v9 的战术层在 `js/jev-client.js` + `js/games/gomoku.js`（两文件由初始化 commit `92e38e6`，2026-09-28 22:21 建立）；`89d7e44`（2026-10-01 18:51「feat!: 全面迁移到 Cloudflare Worker + D1」）建立 `src/core/tactics.ts` / `src/core/engines/gomoku.ts` / `src/core/jev/client.ts`，v10 起在新路径。迁移只搬运未改值（方法 B）。
- **修正一处早前笔记**：`src/core/tactics-budget.ts` 仅由 `0b3a400`（P1，2026-10-04 02:07:58）创建；`446f976`（P0，2026-10-04 01:09:41）**没有**触及任何战术常量，「DEFAULT_BUDGET 冻结于 446f976」的说法不成立。

---

## 2. 主表（14 档）

约定：`TODAY` = 今天的 `DEFAULT_BUDGET`（`src/core/tactics-budget.ts:56-72`）。「未参与」= 该键对应的机制在这一档还不存在（不是值不同）。全部证据可由 `git show <sha>:<file>` 复算。

| 档位 | 引入 commit | 引入日期 | budget 与今天 DEFAULT_BUDGET 的差异（逐键） | sound（当年值 + 证据） | openingMin（当年值 + 证据） | prompt 语义（当年 + 证据） | 建议 fidelity | 证据 commit | 缺口 |
|---|---|---|---|---|---|---|---|---|---|
| `v0-off` | 表内写「678b701 之前」，无 sha | 2026-09-29 13:50（=`678b701^`） | **15 键全部未参与**：战术层尚不存在（`computeTactics` / 开局短路 / `attachFacts` 首现于 `678b701`，`js/jev-client.js:117`、`:123`、`:152`） | 无闸门可言（`vcfWin` 首现 `57a9508`） | 不存在（无短路代码；`< 4` 首现 `678b701:123`） | 无注入（0 句；`attachFacts` 尚不存在） | `restored`（参数层） | `7d9ce9c`(=`678b701^`), `92e38e6`, `678b701` | 档位表无 sha；本稿给出可复现 rev `7d9ce9c` |
| `v1-facts` | `678b701` | 2026-09-29 14:21:52 | **15 键全部未参与**（当年无任何搜索/预算） | `false`（当年无 `vcfWin` 可调，也就无 sound 概念） | **4**：`js/jev-client.js:123 if (typeof st.moveNum === 'number' && st.moveNum < 4)` | **`'mech'`**：era 句集 = win + block + experience（`js/jev-client.js:152 function attachFacts(ser, tactics, experience)`；无裁剪，但当时全仓库只有这 2 句机制句） | `restored` | `678b701`, `89d7e44`, `0b3a400` | 无（逻辑层见 §6-1） |
| `v2-open4` | `15996b1` | 2026-09-29 16:08:53 | 同 v1（open4 层不消费任何预算键：它是 `criteria` 标签 + 接管级，无搜索上限） | `false`（同上） | **4**（同 v1，未被改） | **`'mech'`**：era 句集与 v1 相同（open4 至今**从未**有注入句 ⇒ HEAD 的 mech 门里也没有 open4 键，两边一致） | `restored` | `15996b1`, `0b3a400` | 无 |
| `v3-make2` | `e086742` | 2026-09-29 16:39:50 | 同 v1（threat/parry 2-ply 层无预算键，深度写死） | `false` | **4** | **`'mech'`**：era 句集 = win + block + chance(`chance_points_you`) + danger(`danger_points_opponent`) | `restored` | `e086742`, `0b3a400` | 无 |
| `v4-parry3` | `d10fd1f` | 2026-09-29 17:11:17 | 同 v1（parry3 无预算键、无注入句） | `false` | **4** | **`'mech'`**：era 句集同 v3（parry3 至今无注入句 ⇒ mech 门里也无 parry3） | `restored` | `d10fd1f`, `0b3a400` | 无 |
| `v5-safesort` | `87beda6` | 2026-09-29 17:41:46 | 同 v1（safeSort 的 3-ply/4-ply 排查深度是流程写死、**无命名常量**，故不进 budget 表） | `false` | **4** | **`'mech'`**：era 句集同 v3 | `restored` | `87beda6`, `0b3a400` | 无 |
| `v6-parry4` | `f48d052` | 2026-09-30 10:42:19 | 同 v1（parry4 无预算键、无注入句；该 commit 主要引入禁手模式 gomoku-pro） | `false` | **4** | **`'mech'`**：era 句集同 v3 | `restored` | `f48d052`, `0b3a400` | 无 |
| `v7-vcf` | `57a9508` | 2026-09-30 10:43:06 | **3 键参与，逐键 = TODAY**：`vcfPlies=7`（`js/jev-client.js:284 const VCF_PLIES = 7;`）、`vcfNodeLimit=4000`（`js/games/gomoku.js:174 const NODE_LIMIT = 4000;`）、`vcfMovesMax=12`（`:235 return out.slice(0, 12);`）；其余 12 键未参与（VCT/活三/压力机制尚未引入） | **`false`（无闸门）**：`js/games/gomoku.js:169 function vcfWin(st, attackerId, maxPlies)`（3 参、**无 sound 参数**；a16fdd9 的 diff 里也搜不到 `sound` 一词）。当年的「等价但更弱」的检查不在引擎里，而是**调用方前置条件**：`js/jev-client.js:285 … && win.length === 0 && block.length === 0`，且 v7 自己在 `js/games/gomoku.js:160-164` 写明了这个依赖与局限（「唯一的例外是防守反击造杀，属 VCT 范畴，本搜索不覆盖」）——这正是 v9 补的洞 | **4**（`js/jev-client.js:245`，与 `678b701:123` 同值） | **`'mech'`**：era 句集 = 前述 4 句 + `vcf_win_you` + `vcf_win_opponent`（共 6 句） | `restored` | `57a9508`, `89d7e44`, `0b3a400` | 无 |
| `v8-vcf-try` | `9cf4a88` | 2026-09-30 11:41:31 | **同 v7，无任何差异**：该 commit 只改 `js/jev-client.js`（`js/jev-client.js | 28 +++++++++++++++++++++-------`，另附 docs 与 `test/run-tests.js`），把「链首占不住时只试 `def.first`」换成逐点试（`const cands = []; const seen = new Set(); const pushCand = (n) => …`），仍 3 参调用 `engine.vcfWin(…, VCF_PLIES)`；未新增/未修改任何常量 | **`false`（同 v7）** | **4** | **`'mech'`**：era 句集同 v7（6 句） | `restored` | `9cf4a88`, `0b3a400` | 无 |
| `v9-vcf-sound` | `a16fdd9` | 2026-09-30 16:58:57 | **同 v7，无任何差异**：该 commit **未引入任何预算常量**（diff 只加 `defenderWinsFull()` 与 `search()` 的第 2 参），`NODE_LIMIT=4000` / `slice(0,12)` / `VCF_PLIES=7` 逐字未改 | **`true`（闸门引入档，无条件执行）**：`js/games/gomoku.js:241 function defenderWinsFull()`、`:271 const sub = search(pliesLeft - 2, winsAfter(wr, wc, D));`、`:279 const line = search(maxPlies, defenderWinsFull());`。当年**没有开关**（`vcfWin` 仍 3 参）；闸门本身**也不受任何预算约束**（全盘扫守方子，无 node/limit 上限）⇒ 这解释了为什么 P1 只能把 soundness 建成布尔 `sound` 而不是某个预算键 | **4** | **`'mech'`**：era 句集词条同 v7（6 句；sound 层至今无注入句） | `restored` | `a16fdd9`, `89d7e44`, `0b3a400` | 无 |
| `v10-live3` | `8751070` | 2026-10-02 01:40:34 | **4 键参与**（= v7 的 3 键 + `live3DenyEvalMax=24`）：`src/core/engines/gomoku.ts:28 const LIVE3_DENY_EVAL_MAX = 24;`，era 调用点 `src/core/tactics.ts:302 const deny = engine.live3Deny(st, side, candNotations);`（**不传 opts** ⇒ 取默认 24；HEAD fallback `src/core/engines/gomoku.ts:414`）；VCT/压力键未参与 | `true`（继承 v9 闸门，无条件） | **4** | **`'mech'`**：era 句集 = 前述 6 句 + `live3_opponent` + `live3_you`（共 8 句） | `restored` | `8751070`, `0b3a400` | 无 |
| `v11-vct` | `638f844` | 2026-10-02 13:25:56 | **8 键参与，逐键 = TODAY**：前述 4 键 + `vctPlies=9`（era 调用 `src/core/tactics.ts:306 const vct = engine.vctWin(st, side, VCT_PLIES);`）+ `vctNodeLimit=3000` / `vctMovesMax=10` / `vctDefusersMax=6`（`src/core/engines/gomoku.ts:467-469`，HEAD fallback `:634-636`）。**引入 commit 自证标定**：`638f844:src/core/engines/gomoku.ts` 注释「缺省 14/6000/∞ 能看见 55 手必胜链，但平均 607ms / p90 2430ms / 最坏 8837ms；10/3000/6 同样 55 手（丢 0、多 0），平均 444ms / p90 1647ms / 最坏 4586ms ⇒ 取这组」 | `true` | **4** | **`'mech'`**：era 句集 = 前述 8 句 + `vct_win_you`（共 9 句） | `restored` | `638f844`, `0b3a400` | 无；另见 §0 对审计「v11 预算不同」的否证 |
| `v12-vct-def` | `472e228` | 2026-10-02 19:48:57 | **12 键参与，逐键 = TODAY**：前述 8 键 + `vctDefMax=12` / `vctDefKeep=3`（`src/core/engines/gomoku.ts:699-700`，HEAD fallback `:764` / `:726`）+ `vcfDefPlies=7`（`:701`，HEAD fallback `:725`）+ `vctDefPressureLimit=3`（era 字面量 `:754 const pressure = still ? 0 : pressureOf(board, A, 3);`；HEAD `:727 const pressureLimit = opts?.pressureLimit && opts.pressureLimit > 0 ? opts.pressureLimit : 3;`、`:783`）。era 调用点 `src/core/tactics.ts:327 const def = engine.vctDefense(st, side, VCT_PLIES, { cands: candNotations });`（**不传** `maxTry/keep/vcfPlies/pressureLimit` ⇒ 全取默认，与 TODAY 同值） | `true` | **4** | **`'mech'`**：era 句集 = 前述 9 句 + `vct_win_opponent`（共 10 句） | `restored` | `472e228`, `0b3a400` | 无 |
| `v13-pressure-gate` | `10762a6` | 2026-10-02 23:15:46 | **15 键全部参与，逐键 = TODAY**：前述 12 键 + `pressureCutMax=120` / `pressureCutKeep=3`（`src/core/engines/gomoku.ts:781-782`，HEAD fallback `:857-858`；era 调用 `src/core/tactics.ts:363 const cut = engine.pressureCut(st, side, { cands: … });` 不传 ⇒ 默认 120/3）+ `fourPressureLimit=99`（`src/core/engines/gomoku.ts:777 function fourPressure(st: GomokuState, sideId: string, limit?: number)`，`:778 … limit && limit > 0 ? limit : 99`；era 调用 `src/core/tactics.ts:358-359 engine.fourPressure(st, side)` 不传 limit ⇒ 99）。client 侧接线亦确证：`10762a6:src/core/jev/client.ts` 有 `else if (tactics.vct_win_opponent.length) … tacticUsed = 'vctDefense'` 与 `else if (M.pressureGate && tactics.pressure_cut_points.length …` | `true` | **4** | **`'mech'`**：era 句集 = 前述 10 句 + pressure 句（`pressure_you` / `pressure_cut_points`，且带数据条件 `(tactics.pressure_you || tactics.pressure_opponent)`）（共 11 句 + experience） | `restored` | `10762a6`, `0b3a400` | 无 |

**逐档小结（可证伪陈述）**：对每个参与的键，「当年值 = 今天的值」的依据都是「方法 B 的全时间值矩阵：该常量在引入 commit 的字面值 = 其后每个触及该文件的 commit 里的字面值（直到 P1 搬进 `tactics-budget.ts` 且值不变）」，而不是「现在看起来一样」。

---

## 3. 关于 `promptFacts` 的专项结论（本任务点名要特别小心的一条）

问题：P1 之前 `attachFacts` 无条件注入句子，P1 才加按档裁剪 ⇒ 老档当年是不是 `'all'` 语义？

**答：不是。当年的无条件注入 ≡ 今天的 `'mech'`，原因是「句子与机制在同一 commit 里成对增加」**：

| 档 | era 文件 | era 机制句集（逐条在 HEAD 中逐字命中，0 miss） | 该档 mech 里**有句子**的键 | 是否一致 |
|---|---|---|---|---|
| v1 | `js/jev-client.js` | win, block, experience | win, block | ✓ |
| v2 | 同上 | 同 v1 | win, block（open4 从无句子） | ✓ |
| v3–v6 | 同上 | win, block, chance, danger | win, block, threat（chance+danger 两句同属 `threat` 键） | ✓ |
| v7–v9 | 同上 | 上述 4 句 + vcf_win_you, vcf_win_opponent | + vcfAttack, vcfDefense（sound/vcfTry 无句子） | ✓ |
| v10 | `src/core/tactics.ts` | 上述 6 句 + live3_opponent, live3_you | + live3Defense, live3Attack | ✓ |
| v11 | 同上 | 上述 8 句 + vct_win_you | + vctAttack | ✓ |
| v12 | 同上 | 上述 9 句 + vct_win_opponent | + vctDefense | ✓ |
| v13 | 同上 | 上述 10 句 + pressure 句 | + pressureGate | ✓ |

（句数核对：era 长字面量条数 3/3/5/5/5/5/7/7/7/9/10/11/12 ↔ HEAD 门数 12（含 experience）；`open4`/`parry`/`parry3`/`parry4`/`safeSort`/`vcfTry`/`sound`/`live3Fresh` 这 8 个 mech 键**在历史任何时期都没有注入句**，HEAD 的 mech 门里同样没有它们 ⇒ 门的有无不影响这些键。）

因此：`promptFacts: 'mech'` 对 14 档是**正确**的冻结值；若改成 `'all'`，反而会把「当年还不存在的机制的句子」注入给老档——那才是审计风险 7 描述的漂移形态（P1 之前的状态）。

---

## 4. 共享常量演化时间线（本考古最有价值的产出）

**总结论：15 个预算键中没有任何一个在引入后被改过值；「改一处牵多档」的历史实证全部来自「新机制复用旧机制」，而不是「改值」。**

| 常量（TODAY） | 消费者（HEAD 位置） | 首次引入 = 首次参与的档 | 之后被改过值？ | 牵连档 |
|---|---|---|---|---|
| `VCF_PLIES = 7` | `src/core/tactics.ts:340/344/357`（`vcfWin` 第 3 参） | `57a9508`（v7，`js/jev-client.js:284`） | **无**（矩阵 v7→HEAD 恒 7） | v7–v14 |
| `NODE_LIMIT = 4000` | `src/core/engines/gomoku.ts:214`（fallback `:215`） | `57a9508`（v7，`js/games/gomoku.js:174`） | **无**（`638f844` 另建了 VCT 自己的同名局部常量，未动 vcf 的） | v7–v14 |
| `forcing slice(0, 12)` | `src/core/engines/gomoku.ts:216/278` | `57a9508`（v7，`js/games/gomoku.js:235`） | **无** | v7–v14 |
| `LIVE3_DENY_EVAL_MAX = 24` | `src/core/engines/gomoku.ts:28`（fallback `:414`） | `8751070`（v10） | **无** | v10–v14 |
| `VCT_PLIES = 9` | `src/core/tactics.ts:371` | `638f844`（v11） | **无** | v11–v14 |
| `VCT_NODE_LIMIT / VCT_MOVES_MAX / VCT_DEFUSERS_MAX = 3000/10/6` | `src/core/engines/gomoku.ts:467-469`（fallback `:634-636`） | `638f844`（v11） | **无**（引入 commit 注释记录了 14/6000/∞ → 10/3000/6 的开发期标定，但 14/6000/∞ 从未进入任何已提交代码） | v11–v14 |
| `VCT_DEF_MAX / VCT_DEF_KEEP = 12/3` | `src/core/engines/gomoku.ts:699-700`（fallback `:764`/`:726`） | `472e228`（v12） | **无** | v12–v14 |
| `VCF_DEF_PLIES = 7` | `src/core/engines/gomoku.ts:701`（fallback `:725`） | `472e228`（v12） | **无**（同名 vcf 常量走的是另一条 `VCF_PLIES`） | v12–v14 |
| `vctDefPressureLimit = 3`（era 字面量 `pressureOf(board, A, 3)`） | `src/core/engines/gomoku.ts:727/783` | `472e228`（v12） | **无** | v12–v14 |
| `PRESSURE_CUT_MAX / PRESSURE_CUT_KEEP = 120/3` | `src/core/engines/gomoku.ts:810-811`（fallback `:857-858`） | `10762a6`（v13） | **无** | v13–v14 |
| `fourPressureLimit = 99`（`limit && limit > 0 ? limit : 99`） | `src/core/engines/gomoku.ts:778` | `10762a6`（v13） | **无** | v13–v14 |
| `openingMin = 4`（era `moveNum < 4`） | `src/core/tactics.ts:285`（`sm.moveNum < ver.openingMin`） | `678b701`（v1，`js/jev-client.js:123`） | **无**（阈值自 v1 起从未改） | v1–v14 |
| **soundness 闸门（不属于 budget 的「键」）** | `src/core/engines/gomoku.ts:282-295`（`defenderWinsFull`）、`:304`（递归内的门）、`:320`（入口 `search(maxPlies, sound ? defenderWinsFull() : [])`） | `a16fdd9`（v9，`js/games/gomoku.js:241/271/279`） | 逻辑未被改；**P1 才加开关**（`opts?.sound`，`0b3a400` 是唯一同时引入 `VcfOptions` 与 `opts?.sound` 的 commit） | 语义上 v9–v14 |
| 注入句集（`attachFacts`） | `src/core/tactics.ts:456-498`（P1 门 `:469-470`） | `678b701` 起逐档 +1~2 句 | 句面/句序**逐字未变**（方法 C） | v1–v14 |

**三条最重要的牵连点（给审计报告的核心结论）**：
1. **`vcfWin` 是 v7 以来唯一被 4 档共享的搜索核心**（v7/v8 直用、v11 的 VCT 与 v12 的 vctDefense 在引擎内复用同一函数与其常量）：改 `NODE_LIMIT`/`slice(0,12)`/`VCF_PLIES` 会同时改 v7–v14 的 4 档战术输出。历史上这个风险**没有触发**（值从未改），但 P1 之前也**无法**按档收紧 —— P1 之后才可以把 `ver.budget.vcfNodeLimit` 等经 opts 下传（HEAD `src/core/tactics.ts:337`）。
2. **`a16fdd9`(v9) 是唯一「只改语义、不加常量」的档**：闸门本身无预算上限、当年无开关 ⇒ 在 P1 之前，任何在 HEAD 上跑 v7/v8 的复现都凭空带着 v9 的闸门，且不可能关掉；P1 把 `sound` 变成活键（`tactics.ts:337 const vcfOpts = { sound: ver.sound, … }`）后，v7/v8 的 `sound:false` 在结构上**逐字等于**当年的 `search(pliesLeft - 2)` / `search(maxPlies)`（HEAD `gomoku.ts:312` 与 `:320` 的 `sound ? … : []` 分支）。
3. **`678b701`(v1) 引入的开局短路是唯一「从来没变过」的跨档开关**（恒 4），因此它对 14 档的横向比较**不构成混杂**：所有档在同一手数阈值下被截断。真正的横切漂移只有注入句（P1 已修）与 sound 闸门（P1 已激活）两项。

---

## 5. 建议的 `fidelity` 变更

| 档 | 现值 | 建议 | 依据 |
|---|---|---|---|
| v0-off … v13-pressure-gate（14 档） | `approximate` | **`restored`** | 本稿 §2/§3 的逐档确证（参数层 15 键 + sound + openingMin + 注入句/句面/句序全部与历史一致），证据可复算 |
| v14-live3-fresh | `exact` | 不变 | 已在 P2 冻结 |

若项目把 `'restored'` 定义为「行为逐字可复现」（含机制实现体），则本稿只能支撑 `'restored'`（参数层）；升级前建议先做 §7 的 P7 复跑，或把 `fidelity` 的语义在 `tactics-versions.ts` 的注释里明确成「参数层已核对」。

---

## 6. 做不到确证的档 + 缺口

**没有任何一档因「参数」缺证据而降级**；以下是本稿**未覆盖**的部分，逐条写明缺什么、P7 该怎么补：

1. **机制实现体（非参数）的跨档演化未逐档 diff** —— 本稿证明的是常量值、调用形态、注入句与调用方闸门。共享函数体本身在后续 commit 里是否改动，只做了 spot check：
   - `b6c6921`(v14) 给 live3 加 `fresh`：diff 里 `live3After(..., before?: Set<number>)` 的新分支写作 `if (before && before.has(qr * N + qc)) continue;`（**仅在提供基线时生效**），`live3Count(..., fresh?)` 同理；commit message 自证「缺省与 `fresh:false` 逐字等于旧口径 ⇒ v0–v13 的历史归因、归档回放、金样差分不变」，并有测试用例⑤f「对照组逐字不变」。⇒ 判定 backward-compatible（**置信度：高，但依据是 commit 自证 + 结构性阅读，非逐局面差分**）。
   - 未核对：`vcfWin` 递归体在 v9 之后、`threatMakers`/`parry` 系列在 v3–v6 之后、`vctWin` 内部的 `fiveCompletions`/`winPointsAfter` 等辅助函数在 v11 之后是否被改过。补法：`git log -L` 或 `git diff <vN>..<vN+1> -- src/core/engines/gomoku.ts`（见 §7 的 rev 对）。
2. **mech 表本身是 P1 时期重建的登记表**（`src/core/tactics-versions.ts`，18 键），不是历史文件；本稿只抽查了三处分支存在性：v7 的 `client.ts` 有 `vcfAttack`/`vcfDefense`、v11 的只有 `vctAttack`（无 vctDefense/pressureGate）、v13 的含 `vctDefense` + `pressureGate`。未逐档全量核对 14 档 mech 集与当年接管链的一致性。补法：对每个引入 commit 抽出接管链分支清单（`tacticUsed = '…'` 集合）与 `M.<key>` 门清单，与登记表 diff。
3. **`v0-off` 无 sha**：档位表写「678b701 之前」。本稿给出可复现 rev = `7d9ce9c`（=`678b701^`，2026-09-29 13:50:47，`feat: Jev 接入开放化与侧栏一屏化`）；更早的初始提交为 `92e38e6`（2026-09-28 22:21）。
4. **v1–v9 处于 js 时代**（`js/jev-client.js` + `js/games/gomoku.js`），迁移提交 `89d7e44` 之后才有 `src/core/*` 与 vitest 体系。P7 若用 HEAD 的测试入口跑 v1–v9 的 `--rev` worktree，会因缺少当时的运行方式而失败。补法：见 §7 的「harness」列。js 时代已有自己的测试脚本：`9cf4a88` 的 stat 显示该 commit 同时改了 `test/run-tests.js`（`js/jev-client.js | 28 …`、`test/run-tests.js | 18 …`）⇒ P7 在 v7/v8 一类 rev 上应优先用当时的 `test/run-tests.js`，而不是 HEAD 的 vitest 入口。
5. **「档位当年实际跑的实验」与「引入 commit 的代码」等同的假设**：档位表的 `games` / `gamesVerified` 表明部分档跑过真实对局，但没有证据显示实验期用过非默认参数。由于 P1 之前预算**不可传**（方法 A），唯一可传的是 `topK` / `tacticsVersion` / `experience`，故该假设对预算/sound/openingMin 无影响；对 prompt 的影响由 §3 排除。⇒ 记录在案，无缺口。
6. **`.work/vct-tune*.mjs` 未入库**（`.work/` 被 gitignore），v11 开发期标定的原始数据无 git 证据；本稿只能引用 `638f844` 的注释文本（已逐字摘录于 §2 的 v11 行）。若审计需要该标定本身的可复算性，需另找当时的运行产物，本稿不主张。

### 6.1 层层可达性复核（计划 §7 第 9 条要求）

接管链 14 层（`src/core/takeover.ts` 的 `TAKEOVER_ORDER`，顺序即优先级）逐层核一遍「在当前机制表下还有没有可能被走到」。依据是 P2 指纹的覆盖表（14 局面 × 15 档 = 210 行，`node test/engines/fingerprint.mjs` 的 coverage）与两个专项探针：

| 层 | 可达性 | 证据 |
|---|---|---|
| `win` | ✅ | 指纹夹具 `win-8`（第 9 手成五） |
| `block` | ✅ | 指纹 coverage 28 次（最高频层之一） |
| `open4` | ✅ | 夹具 `swap-6`/`fresh-6`；coverage 亦多次 |
| `threat` | ❌ **历史层，当前机制表下不可达** | 见下 |
| `vcfAttack` | ✅ | 夹具 `vcf-10` |
| `vctAttack` | ✅ | 夹具 `vct-20` |
| `vcfDefense` | ✅ | coverage 16 次 |
| `vctDefense` | ✅ | coverage 3 次（v12 起才有该层） |
| `pressureGate` | ✅ | coverage 6 次（v13 起才有该层） |
| `live3Attack` | ✅ | coverage 21 次 |
| `live3Defense` | ✅ | coverage 5 次 |
| `parry` | ✅ | coverage 4 次 |
| `parry3` | ✅ | coverage 27 次 |
| `parry4` | ✅ | coverage 8 次 |

`threat` 不可达是**结构性**的，不是采样不足：① 凡含 `threat` 的档（v3 起）都含 `open4`，而链里 `open4` 排在 `threat` 之前；② 两层的判据同源 —— `threat` 的入口条件是 `chance_points_you` 非空，即 `countWinningPoints(…, 2) >= 2`（`src/core/tactics.ts:202`），而 `you:open4` 标签的判据是 `fiveCompletions(mine, me, r, c) >= 2`（`src/core/engines/gomoku.ts:1063-1064`），前者是后者的子集。⇒ 要 `threat` 开火，必须出现「候选集扫不到 open4 点、却算得出 chance 点」的局面。取证：2225 个归档候选 + 5 个双活三合成局面 + 1 个精确构造的双四局面（`.work/p2-threat-probe2.mjs`，ply12，实测 H7 的标签是 `you:open4`）——全部 `chance=0` 或已被 `open4` 接管。P2 的指纹断言已把这件事钉住：覆盖表里除 `threat` 外每层都必须被走到，且 `coverage.missing` 必须恰好等于 `['threat']`（`test/engines/version-freeze.test.mjs` 的 ⑭c）。

**读法**：`threat` 在考古表（§2）里仍按「当年该档含此机制」记录（v3 引入时它确实被写进接管链），但**当前机制表下它是死分支**，v3–v14 的强度差异不能归因到它身上。

---

## 7. P7 复现清单（`--rev <sha>` worktree + 复跑）

| 档 | rev（引入 commit） | 时代文件布局 | 该 rev 下要逐字核对的锚点 | harness 备注 |
|---|---|---|---|---|
| v0-off | `7d9ce9c`（或 `92e38e6`） | js | 无战术层（`attachFacts`/`moveNum <` 均不存在） | 纯 js 前端 |
| v1-facts | `678b701` | js | `js/jev-client.js:123`（`moveNum < 4`）、`:152`（`attachFacts`） | 纯 js 前端 |
| v2-open4 | `15996b1` | js | 同 v1 + `criteria` 标签引入 | 纯 js 前端 |
| v3-make2 | `e086742` | js | 同 v1 + 2-ply 块门 `js/jev-client.js:197`（`win.length === 0 && block.length === 0`） | 纯 js 前端 |
| v4-parry3 | `d10fd1f` | js | + parry3 分支 | 纯 js 前端 |
| v5-safesort | `87beda6` | js | + `pickSafestParry` / `allowsSustainedAttack`（深度写死，无常量） | 纯 js 前端 |
| v6-parry4 | `f48d052` | js | + parry4 分支与禁手模式 | 纯 js 前端 |
| v7-vcf | `57a9508` | js | `js/jev-client.js:245/284/285/287/292/298`、`js/games/gomoku.js:169/174/235` | 纯 js 前端 |
| v8-vcf-try | `9cf4a88` | js | 同上（只差 `pushCand` 逐点试） | 纯 js 前端 |
| v9-vcf-sound | `a16fdd9` | js | `js/games/gomoku.js:241/271/279`（闸门）、无新增常量 | 纯 js 前端 |
| v10-live3 | `8751070` | ts（`src/core/*`） | `src/core/engines/gomoku.ts:28`、`src/core/tactics.ts:302`（`live3Deny` 不传 opts） | 迁移后 web 端 |
| v11-vct | `638f844` | ts | `src/core/engines/gomoku.ts:467-469` + 标定注释、`src/core/tactics.ts:306` | 迁移后 web 端 |
| v12-vct-def | `472e228` | ts | `src/core/engines/gomoku.ts:699-701/754`、`src/core/tactics.ts:327` | 迁移后 web 端 |
| v13-pressure-gate | `10762a6` | ts | `src/core/engines/gomoku.ts:777-782`、`src/core/tactics.ts:358-363`、`src/core/jev/client.ts` 的 vctDefense/pressureGate 分支 | 迁移后 web 端 |
| （v14，已 exact） | `b6c6921` | ts | `live3Fresh` 的 backward-compat 分支 | 迁移后 web 端 |

复跑对照口径建议：同一局面集（含 v7/v8 的 sound=false 反例局面、v10 的活三幻影局面、v13 的压力闸门局面）在两个 rev 上输出 `tactics` 报告与 `tacticUsed`，逐手比对；参数层若与 §2 一致，差异应只可能来自 §6-1 的实现体演化。

---

## 8. 附：全时间值矩阵（方法 B 的原始输出，压缩为等价陈述）

对「所有曾改动 `js/jev-client.js` / `js/games/gomoku.js` / `src/core/tactics.ts` / `src/core/engines/gomoku.ts` / `src/core/jev/client.ts` 的 commit」逐一提取常量字面值，得到的窗口序列（省略与前一窗口相同的部分）：

- `678b701` … `e748599`（v1–v5 期间，含 `1c4738f`、`1da4d8a`、`0a8416f`、`2e22991` 等非档位提交）：仅有 `openingMin=4`。
- `57a9508`（v7）起：`+ NODE_LIMIT=4000 VCF_PLIES=7`（`9cf4a88`、`1b18d05`、`a16fdd9`、`fd04897`、`89d7e44`、`13d81da` 全部沿用同值）。
- `8751070`（v10）：`+ LIVE3_DENY_EVAL_MAX=24`。
- `638f844`（v11）：`+ VCT_NODE_LIMIT=3000 VCT_MOVES_MAX=10 VCT_DEFUSERS_MAX=6 VCT_PLIES=9`（`c16c9f9` 沿用同值）。
- `472e228`（v12）：`+ VCT_DEF_MAX=12 VCT_DEF_KEEP=3 VCF_DEF_PLIES=7`。
- `10762a6`（v13）：`+ PRESSURE_CUT_MAX=120 PRESSURE_CUT_KEEP=3`。
- `b6c6921`（v14）→ `ffbcbf7` → `446f976` → `0b3a400`：值逐字不变；`0b3a400`（P1）起这些字面量在 `src/core/tactics-budget.ts` 里以同名常量重新落位（`DEFAULT_BUDGET`），`openingMin` 改由 `ver.openingMin` 提供。
- **窗口内从未出现「同名字面量换值」的行**（这是「当年值 = 今天的值」的形式化依据）。

复算命令（任选其一，均只读）：

```
git log --format='%h %ci %s' -- js/jev-client.js js/games/gomoku.js src/core/tactics.ts src/core/engines/gomoku.ts src/core/jev/client.ts
git log -S 'NODE_LIMIT' --oneline -- js/games/gomoku.js src/core/engines/gomoku.ts
git show 57a9508:js/games/gomoku.js | Select-String 'NODE_LIMIT|slice\(0, 12\)|function vcfWin'
git show a16fdd9 -- js/games/gomoku.js        # 只看 +defenderWinsFull / search 第 2 参
git show 638f844:src/core/engines/gomoku.ts | Select-String '14/6000|VCT_NODE_LIMIT|VCT_MOVES_MAX|VCT_DEFUSERS_MAX'
```

---

### 附：本稿引用到的关键 sha 一览

| sha | 日期 | 说明 |
|---|---|---|
| `92e38e6` | 2026-09-28 22:21 | 初始化仓库（`js/jev-client.js`、`js/games/gomoku.js` 诞生） |
| `7d9ce9c` | 2026-09-29 13:50 | = `678b701^`，v0-off 的可复现 rev |
| `678b701` | 2026-09-29 14:21 | v1：战术层 + `attachFacts` + `moveNum < 4` |
| `15996b1` | 2026-09-29 16:08 | v2：criteria 标签 / 活四级 |
| `e086742` | 2026-09-29 16:39 | v3：2-ply 造杀拆杀 |
| `d10fd1f` | 2026-09-29 17:11 | v4：parry3 |
| `87beda6` | 2026-09-29 17:41 | v5：safeSort |
| `f48d052` | 2026-09-30 10:42 | v6：parry4 + 禁手模式 |
| `57a9508` | 2026-09-30 10:43 | v7：VCF（引入 `NODE_LIMIT`/`slice(0,12)`/`VCF_PLIES`） |
| `9cf4a88` | 2026-09-30 11:41 | v8：VCF 逐点试（无常量变化） |
| `a16fdd9` | 2026-09-30 16:58 | v9：`defenderWinsFull` soundness 闸门（无常量变化） |
| `89d7e44` | 2026-10-01 18:51 | 全面迁移 Cloudflare Worker + D1（建立 `src/core/*`，只搬运不改值） |
| `8751070` | 2026-10-02 01:40 | v10：live3（`LIVE3_DENY_EVAL_MAX=24`） |
| `638f844` | 2026-10-02 13:25 | v11：VCT（3000/10/6、`VCT_PLIES=9`） |
| `472e228` | 2026-10-02 19:48 | v12：vctDefense（12/3/7、`pressureOf(...,3)`） |
| `10762a6` | 2026-10-02 23:15 | v13：pressureGate（120/3、`fourPressure` 默认 99） |
| `b6c6921` | 2026-10-03 11:58 | v14：live3Fresh（backward-compatible） |
| `d199f5a` | 2026-10-03 | 前序耦合审计报告（本稿否证其第 109 行与风险 7 的「P1 后仍存在」读法） |
| `446f976` | 2026-10-04 01:09 | P0 闸门收紧 + 数据卫生（**未触及战术常量**） |
| `0b3a400` | 2026-10-04 02:07 | P1 冻结层：创建 `src/core/tactics-budget.ts`、`sound` 活键、`attachFacts` 按档裁剪 |
| `e706e17` | 2026-10-04 02:55 | 本稿基线 HEAD |

---

## 9. P3 验收：离线重放 `exp-20261003082805`（v14 vs `rapfi@5000ms`，20 局）

**数据**：那一轮是第一次把 Rapfi 抬到 5000ms（20 局，jev 侧隔局换边，战绩 12 胜 7 负 1 和，唯一和棋是 g18 的 225 手满盘）。归档里 `games.tactics_version` 为 NULL，但 jev 侧每一手都带 `tactics_version` ⇒ 重放按逐手档号（`vSource = move`，**不是推断**）。
取数与重放命令（可复算）：

```bash
# 1) 从 D1 导出该轮（只读）
node .work/wrangler-run.mjs d1 execute jev-qiguan --remote --json --command "SELECT id, game_uid, game_id, game, tactics_version, black_channel, white_channel, black_tactics, white_tactics, black_think, white_think, result, winner, end_reason, move_count, exp_game_no, code_version FROM games WHERE experiment_tag='exp-20261003082805' ORDER BY exp_game_no" > .work/p3-round-games.json
node .work/wrangler-run.mjs d1 execute jev-qiguan --remote --json --command "SELECT g.exp_game_no AS n, m.game_id, m.ply, m.side, m.notation, m.tactics, m.tactics_version, m.channel, m.model, m.ms, m.tac_ms, m.cands, m.cands_sent, m.cands_labeled FROM game_moves m JOIN games g ON g.id = m.game_id WHERE g.experiment_tag='exp-20261003082805' ORDER BY g.exp_game_no, m.ply" > .work/p3-round-moves.json
node .work/p3-dump.mjs          # 折成 .work/p3-games/g01..g20.json（parseRecord 直接吃）
# 2) 重放
node scripts/tactics-replay.mjs --dir .work/p3-games --show 40
#    要复算「会变 51 手」的逐层计数，就把逐行结果写成 JSON 再读 total.changedRows：
node scripts/tactics-replay.mjs --dir .work/p3-games --json .work/p3-replay.json > /dev/null
```

**结果**（20 局 / 990 手 / 重放 496 手 / 战术层合计 282.2 s）：

| 判据 | 结果 | 读法 |
|---|---|---|
| **层一致率** | **496 / 496 = 100%** | 强结论：层由确定性事实决定，与模型无关 |
| **接管落点一致率** | **327 / 378 = 86.5%** | 弱结论：同层内的选点受模型概率影响（归档没有整张概率表） |
| **会变的手** | **51 手** | **全部是同层换点，没有一处换层** |

层分布（重放 = 记录，逐层相同）：不接管 118 · `live3Attack` 71 · `vcfDefense` 70 · `vctAttack` 63 · `block` 58 · `live3Defense` 34 · `vcfAttack` 16 · `pressureGate` 15 · `parry4` 13 · `win` 12 · `open4` 11 · `parry3` 8 · `parry` 4 · `vctDefense` 3。

**口径说明（防止误读）**：归档只存下实走那一点的 `confidence`/`prob`/`rank`，**没有整张模型概率表** ⇒ 重放刻意走「无模型」口径（`pairs = 合法着法等权`、`topK = 1`，与 `decide(channel:'random')` 同口径）。所以：

- 「层」是可离线重建的确定性事实 ⇒ 100% 一致是**「这一版战术层在这盘棋上会怎么分层」的逐手复现证明**；
- 「落点」在层内多解时依赖模型给的候选与概率 ⇒ 86.5% 是**下界**（把真实概率表喂回去只会更接近）。51 处差异**全部同层（零跨层）**，逐层实测计数：`live3Attack` 21 处、`live3Defense` 11 处、`parry4` 7 处、`open4` 3 处、`vctDefense` 3 处、`parry3` 3 处、`pressureGate` 2 处、`block` 1 处，其余 6 层 0 处（复算：`node scripts/tactics-replay.mjs --dir .work/p3-games --json .work/p3-replay.json` 后读 `total.changedRows`）。典型是 `live3Attack F8 → I8`（开局第 5 手两侧对称点的几何序差异）；
- 因此 P3 的验收结论是：**战术层可回溯（层 100% 逐手复现），落点复现受上游模型概率影响而在 86.5%–100% 之间**。
