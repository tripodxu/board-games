# ADR-0007：VCF 威胁空间搜索（连续冲四将死链）接入 Jev 战术保险

- 状态：accepted（2026-09-30）
- 背景：Rapfi 基线实战（tag rapfi-base1，Jev 0-4）暴露统一败因——Rapfi 造
  3-4 步连续单杀逼迫链（VCF），Jev 的 2-ply 保险（chance/danger）看不见；
  一旦连续进入 block/拆杀，通常已失先手。parry3/parry4 是启发式预挡，
  覆盖不了真正的强制链。见 docs/memory/MEMORY.md「2026-09-29 · Jev vs
  Rapfi 实战 0-4」。

## 决定

1. **棋盘级搜索** `vcfWin(st, attackerId, maxPlies)`（`js/games/gomoku.js`，
   `gomoku`/`gomoku-pro` 共用工厂，纯逻辑不碰 DOM）：
   - 只搜索**逼迫着法**（落子后产生 ≥1 致胜点的空点）：2+ 致胜点即双杀判胜；
     唯一致胜点则假定守方被迫堵住后递归。返回 `{ win, first, line }`。
   - 边界：默认 7 ply、节点上限 4000、每层逼迫候选 ≤12（按致胜点数排序）、
     只扫攻击子切比雪夫距离 ≤3 的空点；致胜点只查过新落子的四线（新增致胜点
     必用新子，否则入口"双方无一步杀"前提即被违反）。
   - 禁手模式：黑攻击时禁手点不可走；黑防守时禁手堵点视为堵不住（攻方胜）；
     黑方致胜点须精确五连（长连不算赢）。
   - ~~理论依据见函数头注释：守方即时致胜点不可能因攻方落子新增（五连须同色），
     且入口要求双方无一步杀；守方反击造杀属 VCT 范畴，本搜索不覆盖。~~
     **勘误（2026-09-30）：此条已被证伪，见 [ADR-0008](0008-vcfwin-defender-counterkill-gate.md)。**
     错在只考虑了「攻方落子不帮守方造杀」，漏了「守方自己那手**被迫的堵点**能给它
     造四」：攻方造四 → 守方唯一应对是堵 → 堵完守方自己成活四 → 守方下一手直接成五，
     攻方后面的双杀永远兑现不了。已据此给 `search()` 加守方反杀闸门。
2. **接入** `BG.jev.computeTactics`（`js/jev-client.js`）：仅 1-ply（win/block）
   为空时跑。进攻 `vcf_win_you=[首步]`；无我方链时再算对方链，防守
   `vcf_win_opponent=[干预点]`（须为我方当前合法着法）。异常 fail-soft。
3. **防守必须"试走后复搜"**：对方可能有多条 VCF 根（实测 ⑨e：I9/E9 双链，
   占 I9 后黑走 E9 照样杀）。干预点试走后若对方仍有 VCF，则弃用该点、
   回落 parry/pickSafestParry 老路。不枚举全部根——单点验证失败即回落，
   宁可保守。
4. **优先级**：`win > block > open4 > threat > vcfAttack > vcfDefense >
   parry > parry3 > parry4`。将死链（强制）排在双杀预判（潜在）之前；
   threat（己方两步双杀）比 vcfAttack 更快兑现，故在前。`meta.tactics`
   新增 `vcfAttack` / `vcfDefense`，Jev instructions 同步声明语义。
5. **定位**：这是 VCF（连续冲四），不是完整 VCT（不含活三后多应对、反击造杀、
   安静织网），更不是完整局面估值。Rapfi 渠道保持独立对照，不替 Jev 走子。

## 验证

- 回归 ⑫a–⑫g（`test/run-tests.js`）：合成将死链（H7→I7→H4 活四双杀）
  攻防两侧接管、无 VCF 不误接管、maxPlies=1 不虚报、pro 模式禁手不误杀真链、
  rapfi-base1 g4 第 34 手实战（I14 破杀，旧 parry3 走 E12 没破掉）。
- rapfi-base1 四盘败局复盘：新层在 12 个 Jev 行棋点触发 vcfDefense；其中
  3 处（g3p41、g4p34/p36）实战着法破杀失败而 VCF 干预点经复搜确认破杀；
  另有 3 处终局前 3-5 手双方都破不掉（棋已输，VCF 非起死回生）。
- 性能：最稠密实战中盘（50 子）双向搜索 0–22ms，主线程可接受。
- ⑨d 复盘修正：VCF 发现黑以 E6 为入口的真将死链（E6→D5→D6→F6→E7 双杀
  C4+H10），原"parry3 应抢 E7"结论被更精确的 vcfDefense=E6 取代；
  后续黑 E7 时新层继续 vcfDefense=D6，防守连贯。

## 替代方案（已否决）

- 继续堆 parry5/parry6 启发式：边际收益递减，VCF 是结构性修复。
- 让 Rapfi 直接给出着法：违反"Rapfi 独立对照"定位（ADR-0006），且把
  Jev 降格为传声筒。
- 完整 VCT/alpha-beta 引擎：超出战术保险层定位（Jev 仍是决策主体），
  且浏览器主线程预算不允许。
