# ADR-0020：战术档位 = 冻结记录 + 决策指纹（改一处共享代码必须亮红灯）

- 状态：accepted（2026-10-03）
- 背景：[耦合性审计](../plans/2026-10-03-tactics-coupling-audit.md) 证明战术档位之间有三层耦合，
  其中机制层是「改一处牵多档」：

  - v11 读 v7 的 `vcf_win_you` 才开火、v12 要求三个上游字段全空、v13 与 `live3Attack` 读 `danger_points_opponent`；
    v7/v8/v11/v12 四档共用引擎同一棵 `vcfWin` 搜索 ⇒ **改引擎搜索 = 静默改四档**。
  - 当时「在 HEAD 上跑 v7/v11 复现当年实验」做不到逐字复现：soundness 闸门无条件执行（`sound` 是死键）、
    搜索预算常量全写死、prompt 指令文本不按版本裁剪。
  - 另有两处静默回退：写错档号不报错（按当前档跑）、`resolveVersion` 兜底给全机制集。
  - 结果：A/B 实验的「单变量」假设会被**无声**破坏，而归因错误只能靠人工审视发现。

## 决定

1. **档位 = 完整行为记录**：`src/core/tactics-versions.ts` 的每条记录自带
   `budget`（15 个搜索上限）/ `sound` / `openingMin` / `promptFacts` / `fidelity`，
   不再依赖「HEAD 里那些写死的常量」。统一缺省放在 `FROZEN` 常量里，逐档只写偏离项。
2. **预算集中登记、只减不增**：新增 `src/core/tactics-budget.ts` 的 `EngineBudget` + `DEFAULT_BUDGET`（逐字冻结当日常量）
   + `BUDGET_KEYS` + `budgetOf()`（非数字/非正数一律回落默认 ⇒ **预算写错的后果只能是少看见**）+ `sameBudget()`；
   引擎侧只把预算接成 **opts**，缺省值保持历史常量不变（`VcfOptions`/`VctDefenseOptions`/`PressureCutOptions`/`Live3Options`）。
3. **未知档号显式失败**：`resolve()` 抛 `UnknownTacticsVersion`（消息含最接近的合法 id），
   展示/陈旧存档走 `tryResolve()`；`resolveVersion()` 的兜底从「全机制集」改成 `v0-off` 空机制集
   （宁可战术层空转，也不许悄悄变成别的档位）。
4. **接管链抽成纯函数**：`src/core/takeover.ts` 导出 `TAKEOVER_ORDER`（14 层权威顺序）、`TAKEOVER_LABEL`、
   `pickTakeover({engine, st, tactics, mech, criteria, legal, pairs, cands, topK, onTime})` → `{notation, layer, bypassed}`；
   `src/core/jev/client.ts` 只负责把模型概率/档位/耗时记账接上去。理由：① 指纹要**一趟链**同时拿「事实 + 层 + 落点」；
   ② 离线回放（P3）本来就必须跑这条链；③ 层顺序成为可引用的单一事实，而不是散在 150 行 `if/else` 里。
5. **决策指纹冻结**：`test/engines/fingerprint.mjs` 从归档棋谱抽语料 + 具名夹具，逐局面 × 逐档记录
   `{层, 落点, 15 个事实点数摘要, 事实 digest}` 到 `test/parity/tactics-fingerprints.json`；
   `test/engines/version-freeze.test.mjs` 逐行重放比对，**重写只能显式 `--write` 且必须在 commit 里写明理由**。
6. **只记决策、不记耗时**（D7）：搜索预算下的耗时天然抖动，记它会让测试 flaky，反而逼人放宽阈值。
7. **覆盖表是断言的一部分**：`⑭c` 要求「除 `threat` 外每一层都必须被这组语料走到」且
   `coverage.missing` 恰为 `['threat']` —— 覆盖退化要显式看到，而不是靠人记得。
8. **老档置信度必须自报**：`fidelity ∈ {exact, restored, approximate}`；当前档必须 `exact`，
   考古不能确证的标 `approximate`（不猜）。

## 代价与不做什么

- **语料规模按实测收缩**：原计划 N≈120 局面 × 15 档 ≈ 9 分钟（早/中盘棋盘稀疏、候选点多 ⇒ 搜索扇出大；
  晚盘密棋盘反而便宜），进不了 CI。定为**归档 10 个局面（早 4/中 4/晚 2）+ 4 个具名夹具 = 14 局面 × 15 档 = 210 行，24.0 s**。
- **不做**：不把耗时纳入指纹；不为老档编造精确预算（标 `approximate`）；不为指纹引入新依赖或新 project；
  不因为指纹存在就停止人工审视机制层牵连（指纹只保证「冻结那天的决策没变」）。
- **一处已知且显式的缺口**：`threat` 层实测不可达 —— `you:open4` 标签判据（走后 ≥2 个成五点，
  `src/core/engines/gomoku.ts:1063-1064`）与 `chance_points_you` 判据（`src/core/tactics.ts:202`）同源，
  且凡含 `threat` 的档（v3 起）都含 `open4`、链里 `open4` 在前 ⇒ 只有「候选集扫不到 open4 点却算得出 chance 点」
  才可能开火。取证：2225 个归档候选 + 双活三/双四合成局面全部 chance=0 或层被 `open4` 接管
  （`.work/p2-threat-probe2.mjs`）。因此指纹把 `threat` 写进 `missing` 并断言其**恰为**唯一缺口，
  而不是假装覆盖到了。

## 验证（全部实测）

| 项 | 数字 |
| --- | --- |
| 接管链抽取零行为变更 | 30 局面 × 15 档 = **450 行决策面，差异 0 行**（`.work/p2-ab-baseline.mjs` 抽取前后各 dump 一次） |
| 基线指纹生成 | 14 局面 × 15 档 = **210 行 / 24.0 s**；层覆盖 **13/14**（缺 `threat`） |
| 红灯有效性 | `DEFAULT_BUDGET.vcfNodeLimit` 4000 → 1 ⇒ 报「决策指纹漂移 **32 处**」（v7…v14 的层从 `vcfDefense` 变 `parry`/`vctDefense`），还原后立刻全绿 |
| 与线上决策同解 | `⑭d`：语料中一个 mid 局面 × 15 档，指纹与 `decide(channel:'random')` 的层/落点逐档一致 |
| 与 P1 预算下传的分工 | 指纹冻「决策」，P1 的零行为变更对照冻「同一档位的文本与事实」；两者互补 |
| 套件 | 引擎套件 **153 例**（+5）、vitest **38 文件 / 399 例**、`tsc --noEmit` 干净、`check:docs` 58 md / 397 链接 |

## 后果

- 加档、改机制表、改任何被多档共用的引擎预算 ⇒ `version-freeze` 红灯，**必须**在 commit 里解释
  「哪一档、哪一类事实、为什么变」，再用 `--write` 重写指纹。
- 考古（P3）只需逐档填 `budget/sound/openingMin/fidelity` 与证据 commit；填完重写一次指纹即成基线。
- 未登记档号不再可能被静默当成当前档跑（P0），因此「实验归因到错档位」这一类错误被堵死。
