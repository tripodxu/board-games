# 战术版本耦合性审计报告：14 档战术档位之间到底有没有牵连？

> 类型：**审计报告（只读调查，不改代码、不占战术轮换计数）**。执行者：编排代理 + 3 个只读调研子代理。
> 触发：项目所有者要求（2026-10-03，paraphrased）：「建新 worktree；①确认战术版本之间是否有耦合牵连；②建 SSH 远程批量实验工具……先给出你的计划」。本文件是 ① 的答案，② 见同目录 [2026-10-03-remote-batch-experiments.md](2026-10-03-remote-batch-experiments.md)。
> 结论速览：**有耦合，且分三层**——状态层（低）、机制层（高）、复现层（最高）。「同进程并行跑不同版本做对比」是安全的；「在 HEAD 上逐字复现老版本」是不安全的。详见 §2–§5。

---

## 1. 结论先行（三句话）

1. **同进程并行对比不同版本：安全。** 战术缓存 `tacCache` 按 `(state 对象, ver.id)` 双键分键（`src/core/tactics.ts:103-105`，测试固化于 `test/engines/tactics.test.mjs:391`），引擎单例无状态（`src/core/registry.ts:16-18`），`tacticsMs` 是 per-call 局部计时（`src/core/jev/client.ts:313-317`）。唯一的共享可变状态是全局 RNG（`src/core/rng.ts:25-27`），且只影响 `random`/`mock` 两臂——真实 Jev 臂走 `weightedPick`，刻意不过 `rand()`（`src/core/weighted.ts`）。
2. **版本之间有真实的机制级依赖：改一处牵多档。** v11 读 v7 的 `vcf_win_you` 才开火（`src/core/tactics.ts:325`）、v12 要求三字段全空（`:338-340`）、v13 与 live3Attack 读 `danger_points_opponent`（`src/core/jev/client.ts:471`/`:485`）；v7/v8/v11/v12 四档共用引擎同一棵 `vcfWin` 搜索。**改引擎搜索 = 静默改四档。**
3. **「在 HEAD 上跑 v7/v11 复现当年实验」做不到逐字复现：** soundness 闸门无条件执行（`sound` 键是死键，`src/core/engines/gomoku.ts:313`）、预算常量全写死且历史缺省被调过（`src/core/engines/gomoku.ts:438-441` 自证）、prompt 指令文本不按版本裁剪（`src/core/tactics.ts:412-428`）。加上两条静默回退坑（写错档号不报错、直接按 v13 跑），**A/B 实验的「单变量」假设有两处会被无声破坏**。

---

## 2. 状态层：哪些可变状态跨版本共享？（会不会串味）

只有 3 处可变共享状态，逐一定级：

| 状态 | 位置 | 分级 | 说明 |
|---|---|---|---|
| 战术缓存 `tacCache` | `src/core/tactics.ts:103-105` | **安全** | `WeakMap<object, Map<string, TacticsReport>>` 双键：state 对象 → `ver.id` → report。写入前有版本门（`:387-391` `if (ver.id !== tacticsVersion) return…`）。同进程先跑 v9 再跑 v13 不串味，代价只是同 state 最多驻留 14 档 |
| 全局 RNG | `src/core/rng.ts:25-27`（`setSeed` 重绑进程级随机流，`:30-33`） | **高（唯一实测污染源）** | 并行两臂互相 `setSeed` 会改对方随机流；且 `meta.seed` 记的是「最后一次 setSeed」而非开局面值（`src/core/meta.ts:93`），归档 seed 与实际随机流脱钩。**只影响 random/mock 臂**（`src/core/jev/client.ts:519`、`src/core/jev/mock.ts:44-53`）；真实 Jev 臂不受影响 |
| mockDecide 注入点 | `src/core/jev/client.ts:49-54` | 无实质影响 | 跨版本共享，但 mock 渠道根本不进战术层（`:287-290`），与版本无关 |

**引擎单例无状态**（state 全在 `st`，七个战术方法同挂一个实例，`src/core/engines/gomoku.ts:1267-1286`），所有预算常量是闭包级常量（见 §5）——并行安全。

---

## 3. 机制层：层与层之间的依赖（改一版牵连谁）

**接管链**是 `src/core/jev/client.ts:433-512` 一条单文件单序的 if/else：`win > block > open4 > threat > vcfAttack > vctAttack > vcfDefense > vctDefense > pressureGate > live3Attack > live3Defense > parry > parry3 > parry4`。

### 3.1 向上依赖（高层机制读低层输出字段）

| 高层 | 依赖 | 代码 | 后果 |
|---|---|---|---|
| v11 `vctAttack` | v7 的 `vcf_win_you` 必须为空 | `src/core/tactics.ts:325` `if (M.vctAttack && res.vcf_win_you.length === 0)` | 改 v7/vcfWin 的开火 ⇒ v11 整层被开/关 |
| v12 `vctDefense` | `vcf_win_you`/`vct_win_you`/`vcf_win_opponent` 三字段全空 | `src/core/tactics.ts:338-340` → `:343` | 任一上游字段变化即改 v12 |
| v13 `pressureGate` + live3Attack | `danger_points_opponent.length === 0`（v3 起 2-ply 产出） | `src/core/jev/client.ts:471`/`:485`；产出在 `src/core/tactics.ts:287-291` | 改 2-ply ⇒ v13 与 live3Attack 同时改 |

### 3.2 引擎内部依赖（共用搜索方法）

- `src/core/engines/gomoku.ts:700`（vctDefense 先 `vcfWin`）→ `:705`（再 `vctWin`）→ `:744-753`（逐点 probe 后验 hasFivePoint→vcfWin→vctWin）。
- `src/core/engines/gomoku.ts:846-855`：`pressureCut` 并列比较用 `fourMakeCount`；pressure 数字来自 `fourPressure`（`src/core/tactics.ts:357-358`）。
- 标签层：`src/core/tactics.ts:412-428` attachFacts → `labelPoint` 的 criteria 名 → client.ts 三条正则 `/(^|\+)you:open4(\+|$)/`、`/(^|\+)deny:(open4|live3)(\+|$)/`、`/(^|\+)deny:four(\+|$)/`。**改标签命名 = v2/v5/v6 全乱。**

### 3.3 牵连矩阵（改 X 会动到谁）

| 改动 | 牵连 | 严重度 |
|---|---|---|
| `gomoku.vcfWin`（NODE_LIMIT/forcing 上限/soundness 闸门） | v7、v8（vcfTry）、v11（经 `vcf_win_you`）、v12（引擎内 re-probe） | **高** |
| `vctWin` 预算 | v11、v12 | 高 |
| `threatMakers`/2-ply | v3 起，并间接改 v13 与 live3Attack 开火条件 | 高 |
| `labelPoint`/criteria 命名 | v2/v5/v6（open4/parry3/parry4） | 高 |
| `fourPressure`/`fourMakeCount` | v13（数字 + 削点决策） | 中 |
| 接管链插新层但漏写 mech 门 | **新层以下全部老版本** | 高（未来风险） |

**现有防线**：`src/core/tactics-versions.ts:150-152` 的 selfTest 单调性断言（上级机制不许丢）+ 决策级回归（`test/engines/tactics.test.mjs:391-460`、`:675-774`）。这两条是「新层静默改老版本」的唯一自动防线，新层插入必须人工审视引用 `danger_points_opponent` 的守卫。

---

## 4. 闸门机制与两条静默回退坑（对实验最致命）

1. **坑 1（已知且被测试固化为「特性」）**：`src/core/tactics-versions.ts:95-99`
   ```ts
   if (id == null || id === '') return BY_ID[CURRENT]!;
   return BY_ID[String(id)] || BY_ID[CURRENT]!;
   ```
   写错档号（如 `--tacA v12-vct-de` 拼错）→ **不报错，直接按 v13-pressure-gate 跑**。测试 `test/engines/tactics.test.mjs:135`、`:439-460` 固化了这个行为。归因上「记的是真相」：meta 记 resolve 后的 `ver.id`（`src/core/jev/client.ts:542`），归档不会谎报；**但配置里的错档号被全链路静默归一**（`src/core/persist.ts:184`、`src/core/record/export.ts:216` 都基于已 resolve 的 id）⇒ A/B 实验单变量被破坏且事后不可检出。
2. **坑 2（更隐蔽）**：`src/core/tactics.ts:125-131` resolveVersion 的 catch 分支
   ```ts
   } catch (e) {
     return { id: versionId || 'unregistered', mech: ALL_MECH };
   }
   ```
   登记表 import/resolve 失败时**十七键全开 = 行为等同 v13**，而 id 记的是传入原文 ⇒ 「贴 v7 标签跑 v13 行为」可能。
3. `allows()` 本身纯净（`src/core/tactics-versions.ts:114-116` 纯查表），语义兜底只集中在 `resolve()` 一处——「老版本可复现」恰恰依赖这个静默回退被当成特性。
4. 已知粒度瑕疵（低危）：`src/core/tactics.ts:287-291` 2-ply 块级门 `if (st.moveNum >= 4 && (M.threat || M.parry))` 让 `chance_points_you`/`danger_points_opponent` 共用一个门；当前无害（v1/v2 两键皆无，v3 起皆有），未来「只有 parry」的版本会漏字段。

---

## 5. 复现层：不 checkout 老 commit，能复现老版本吗？

**答案：能复现「机制层集合」，不能逐字复现老版本行为。** HEAD 的 mech 门覆盖全部 14 层，传 `tacticsVersion` 即可关层；但以下四类代码**不按版本裁剪且已随后续 commit 漂移**：

1. **`sound` 键是死键，soundness 闸门无条件执行**：`sound` 只在 `src/core/tactics-versions.ts:130` 出现，`computeTactics`/`decide` 从未消费；而 `src/core/engines/gomoku.ts:313`
   ```ts
   const line = search(maxPlies, defenderWinsFull());
   ```
   277-288 的 `defenderWinsFull`（v9 才有的 soundness 闸门）无条件调用 ⇒ **在 HEAD 上跑 v7/v8 实际带着 v9 的闸门，关不掉。**
2. **预算常量全部写死，tactics 调用点从不传 opts**：`VCF_PLIES = 7`（`src/core/tactics.ts:96`）、`VCT_PLIES = 9`（`:99`）、`NODE_LIMIT = 4000`（`src/core/engines/gomoku.ts:210`，引擎内部局部 const，根本不是参数）、forcing 上限 12（`:271`）、`VCT_NODE_LIMIT=3000/VCT_MOVES_MAX=10/VCT_DEFUSERS_MAX=6`（`:442-444`）、`VCT_DEF_MAX=12/VCT_DEF_KEEP=3/VCF_DEF_PLIES=7`（`:674-676`）、`PRESSURE_CUT_MAX=120/PRESSURE_CUT_KEEP=3`（`:781-782`）、`LIVE3_DENY_EVAL_MAX=24`（`:28`）。`src/core/types.ts:161-199` 的签名支持按版本给预算，**战术层没接**。关键证据：`src/core/engines/gomoku.ts:438-441` 注释自证缺省从 14/6000/∞ 调成 10/3000/6 ⇒ 「55 手可见集丢 0、多 0，走子相同但耗时不同」⇒ **v11 的原始实验与今天重跑的「v11」预算不同**（中置信：未逐个 diff 各版本 commit）。
3. **开局短路一刀切**：`src/core/tactics.ts:243-246` moveNum<4 直接返回 emptyTactics，对所有版本生效。
4. **prompt 文本不按版本裁剪（隐性污染）**：`src/core/tactics.ts:412-428` attachFacts 无条件把全部机制的中英说明段追加进 move 指令 ⇒ 今天跑 v1，Jev 收到的指令比 v1 当年长一截，模型输入漂移，**且与 mech 门正交，任何开关都修不掉**。

---

## 6. 归因链：怎么知道是哪一版跑的？

完整链：每手 `src/core/jev/client.ts:541-542`
```ts
tactics: tacticUsed,
tacticsVersion: ver.id,
```
→ `src/core/meta.ts:61`（`tv`）→ `src/shared/record-map.ts:380`（D1 每手一列 `tactics_version`）→ 局级 `src/core/record/export.ts:62-64/216`（`tacticsVersion/blackTactics/whiteTactics`）。

**重要值语义**（`src/core/record/export.ts:17-19`，commit 67c3671）：这三个档位字段**只在「这一侧真的会跑战术层」的渠道上才写**，rapfi/mock/人类侧写空串（D1 落 NULL）——「档位非空」本身就编码了「这侧过了战术层」。局级还有 `code = CODE_VERSION`（`src/core/meta.ts:91`，`APP_VERSION+BUILD_SHA`）、`tacticsMs` 汇总（`:103`）。
tag（`exp-YYYYMMDDHHmmss`）是 join 键不是版本归因，版本归因看 tacA/tacB + 每手 tv。
**完整度评估**：tv 每手记录 + 每局固定档（`src/app/loop.ts:291`）⇒ 足以回答「这局/这手是哪版跑的」；因 §5，**无法回答「这版是不是当年的那版」**。

---

## 7. 耦合风险清单（12 项）

| # | 风险点 | 牵连版本 | 严重度 | 建议隔离手段 |
|---|---|---|---|---|
| 1 | `resolve()` 未知/写错档号静默回退 CURRENT（`tactics-versions.ts:95-99`） | 全部：A/B 任一臂写错即静默换档，单变量破坏且事后不可检出 | **高** | 实验入口用 VERSIONS 白名单校验，未知值**报错**而不是回落 |
| 2 | `resolveVersion` catch → ALL_MECH 全开（`tactics.ts:125-131`） | 全部：贴老档标签跑 v13 行为 | **高** | catch 改 throw 或回落 v0-off（空 mech），绝不回落全开 |
| 3 | 接管链单文件单序，新层漏写 mech 门即改所有老版本决策 | 新层以下全部 | **高（未来）** | 保持 selfTest 单调断言 + 决策级回归；新层插入位置人工审视 `danger_points_opponent` 守卫 |
| 4 | 改 `gomoku.vcfWin`（搜索/预算/闸门） | v7/v8/v11/v12 四档 | **高** | 引擎改动前后跑 `test/engines/tactics.test.mjs` 全档决策级回归；批量实验报告同时报各档 |
| 5 | `sound` 死键 + `defenderWinsFull` 无条件（`gomoku.ts:313`） | v0–v8 想复现「无闸门」时不可得 | 中 | computeTactics 的 VCF 块按 `M.sound` 传引擎 opts，把闸门做成可关 |
| 6 | 预算常量写死且历史缺省调过（`gomoku.ts:438-441`） | v7–v13 跨时间对比不可比 | 中 | tactics-versions 表加 budget 字段，经 opts 下传（types.ts 已支持） |
| 7 | attachFacts prompt 不按版本裁剪（`tactics.ts:412-428`） | v0–v12 prompt 漂移，mech 开关修不掉 | 中 | attachFacts 按 `ver.mech` 生成句子集 |
| 8 | expTag 秒精度碰撞（`src/ui/panels/experiment.ts:116-118`） | 并行实验同 tag ⇒ worker 侧实验行按 tag 关联可能覆盖/合并 | 中 | tag 加随机/序号后缀（≤64 字符）；批量工具已计入计划 D5 |
| 9 | 全局 RNG setSeed 互相覆盖 + meta.seed 记最后值（`rng.ts:30-33`） | random/mock 臂并行 | 中 | 长期改 per-session RNG 实例；批量工具每局 setSeed 后立即快照开局值进局 meta |
| 10 | 实验运行期 sideConfig 被实验臂覆写（`src/app/experiment.ts:90`） | 同 ctx 双实验 | 中（已有 startRun 互锁部分缓解，`src/app/experiment.ts:71`） | 保留互锁；并行一律分进程（远程批量工具天然分进程） |
| 11 | 2-ply 块级门字段不单独门（`tactics.ts:287-291`） | 未来版本 | 低 | 字段级门（chance/danger 各按各的 mech） |
| 12 | moveNum<4 一刀切（`tactics.ts:243-246`） | 全部 | 低 | 记录在案；逐版复现需核对各 commit 阈值 |

---

## 8. 对「远程批量实验工具」的直接约束（已带入计划）

1. CLI 档位校验：`--tacA/--tacB` 必须在 `src/core/tactics-versions.ts` 的 VERSIONS 白名单内，**未知值直接 exit 2 报错**（堵坑 1）；不引入新的静默回退路径（堵坑 2）。
2. 每局记录 `code_version` + 自造 tag（`exp-YYYYMMDDHHmmss-<batch>-r<i>` 后缀防撞，≤64 字符），跨时间对比不引用旧数字（§5 的必然结论）。
3. 并行模型：同一 worker 进程内串行跑轮次；`random`/`mock` 臂的 seed 每局显式 `setSeed(局号派生)` 并快照开局值（`src/core/rng.ts` 注释「并行对局不要共享全局 RNG」，`src/core/rng.ts:10`）。
4. Elo 的身份口径直接用 `channel|tactics|thinkMs` 三元组（与站点 `expSideStats` 一致，`src/ui/panels/experiment-report.ts:316-359`），`tacticsLabel()` 把非 Jev 侧归一为 null —— 身份三元组必须原样复用，别自造（playbooks.md:161-165 的前车之鉴：把 `*_tactics` 当对手属性读出「幻影身份」）。

---

## 9. 置信度与未覆盖部分

- **高置信**（直读代码 + 测试固化）：§2 状态清单与 tacCache 分键；§3 字段依赖链与正则标签层；§4 两条回退路径；§6 归因链；§5 的死键与写死常量（grep 全 src/core 证实 `sound` 仅在 tactics-versions.ts:130 命中）。
- **中置信**：`src/core/engines/gomoku.ts:438-441` 的标定史推断「v11 当年预算 ≠ HEAD」——注释原文支持，未逐个 diff 版本 commit；「各版本老 prompt 文本/开局阈值不同」是基于 HEAD 无条件代码的推断而非提交级比对。
- **未覆盖/留给后续**：`src/app/panels.ts:322-346` side-config 面板全文；`src/worker/db/experiments.ts` 的 upsert/tag 唯一性细节（坑 8 的实际后果）；`src/core/engines/gomoku.ts:890-1258` 非战术方法；`.work/` 下历史探针脚本；各版本 commit 级 diff（要逐字复现老版本时才做，见 §5）。
- **本报告未做任何代码修改、未跑实验**；所有行号为调查时 HEAD（dd8f657）行号。
