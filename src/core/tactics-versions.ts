/* tactics-versions.ts — 战术层版本登记表（迁移自 js/tactics-versions.js）
 *
 * 为什么存在：战术层是 12 次提交逐层累加上线的，没有登记表就无法回答
 * 「这个版本为什么强/弱」，实验也无法按版本归因。机制键与 jev 接管链一一对应
 * （优先级从高到低）：
 *   win > block > open4 > threat > vcfAttack > vctAttack > vcfDefense > vctDefense > live3Attack > live3Defense > parry > parry3 > parry4
 * 附加键：safeSort = 拆杀点并存时 3-ply 试走挑最安全（v5, 87beda6）；
 *         vcfTry   = vcfDefense 链首占不住时逐点试干预（v8, 9cf4a88）；
 *         sound    = vcfWin 伪胜闸门（引擎侧 gomoku.defenderWinsFull，v9, a16fdd9）。
 *
 * 权威来源：git 历史（版本边界只认 commit 时间，git log %ci 为北京时间）× 棋谱数据。
 * 版本一版都不能少；v0-off 是数据驱动的基线（战术层上线前，暂无归档棋谱）。
 *
 * 纯数据 + 纯函数，无 DOM 依赖。版本号本身统一由 `src/shared/version.ts` 的
 * `CODE_VERSION` 提供（本模块 P7 起不再消费它：只在「代码版本 vs 棋谱声明」的
 * 比较里才需要，而那个比较随审计台账一起退役了）。
 */
import { assert } from './assert.ts';

export interface TacticsVersion {
  id: string;
  name: string;
  rank: number;
  commit: string;
  commitAt: string;
  date: string;
  mech: Record<string, boolean | undefined>;
  games: number;
  gamesVerified: number;
  note: string;
}

/* commitAt = git log %ci 实测（北京时间）。
   games         = **迁移前的冻结快照**：当时按文件名 stamp 落时间窗统计出来的局数
                   （合计 54 局）。P7 起不再重算它，也不再用它归因——保留只为读登记表时
                   能看见历史口径。
   gamesVerified = 有元数据实证（每手 ai.tv 或 meta.code）确实跑过本档的局数。
   这两个是两个口径，**不能混读**：v7 快照 4 局但实证 20 局；v9 快照 26 局但实证只有 4 局。
   当时「窗口」把线上 0.7.0 的 20 局算成了 v9 的战绩 —— 这正是时间窗口径被退役的原因。
   **现在判一局跑的是哪一版，只看数据自带的版本声明**：棋谱里的 `meta.code`
   （D1 的 `games.code_version` 列，导入时逐字落库）与每手 `ai.tv`。
   没有声明的局就是「未知」，不许再按文件名/落库时间猜（见 test/core/attribution.spec.ts）。 */
export const VERSIONS: TacticsVersion[] = [
  { id: 'v0-off', name: '无战术基线', rank: 0, commit: '678b701 之前', commitAt: '2026-09-29 14:21 前',
    date: '2026-09-29', mech: {}, games: 0, gamesVerified: 2,
    note: '基线：战术层上线前纯概率走子（92e38e6→1da4d8a 区间）。战术层上线前的对局未归档棋谱，games=0；此档仍须在表内——它是「战术层净贡献」归因的对照组。' },
  { id: 'v1-facts', name: '胜/挡', rank: 1, commit: '678b701', commitAt: '2026-09-29 14:21',
    date: '2026-09-29', mech: { win: true, block: true }, games: 0, gamesVerified: 0,
    note: '战术保险初版：自己一步能赢直接赢，对方一步能赢必须挡。无归档棋谱（新版实验设施补测对象）。' },
  { id: 'v2-open4', name: '活四级', rank: 2, commit: '15996b1', commitAt: '2026-09-29 16:08',
    date: '2026-09-29', mech: { win: true, block: true, open4: true }, games: 0, gamesVerified: 0,
    note: 'criteria 战术标签契约：引擎代读棋盘打标签，活三/活四识别不再靠模型猜。无归档棋谱。' },
  { id: 'v3-make2', name: '造杀/拆杀', rank: 3, commit: 'e086742', commitAt: '2026-09-29 16:39',
    date: '2026-09-29', mech: { win: true, block: true, open4: true, threat: true, parry: true }, games: 0, gamesVerified: 0,
    note: '2-ply 扩展（用户补丁）：threat 造杀点（自己两步胜）+ parry 拆杀点（对方双杀点）。无归档棋谱。' },
  { id: 'v4-parry3', name: '活三预挡', rank: 4, commit: 'd10fd1f', commitAt: '2026-09-29 17:11',
    date: '2026-09-29', mech: { win: true, block: true, open4: true, threat: true, parry: true, parry3: true }, games: 0, gamesVerified: 0,
    note: '败局复盘驱动：抢 deny:open4/deny:live3 标签点。与 v5 仅差 safeSort 内部排序，棋谱标签不可分——按落库时间归 v5 窗口（21 局）。' },
  { id: 'v5-safesort', name: '拆杀安全排序', rank: 5, commit: '87beda6', commitAt: '2026-09-29 17:41',
    date: '2026-09-29', mech: { win: true, block: true, open4: true, threat: true, parry: true, parry3: true, safeSort: true }, games: 21, gamesVerified: 0,
    note: '层数不变，parry 层内部升级：多 danger 并存时 3-ply 试走挑最安全的。9/29 17:51–19:28 落库 21 局（11 局人机/机机 + 10 局 exp-20260929105234/exp-20260929111222，proxy vs random），parry3 标签实证 ≥v4。' },
  { id: 'v6-parry4', name: '冲四预挡', rank: 6, commit: 'f48d052', commitAt: '2026-09-30 10:42',
    date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, parry: true, parry3: true, safeSort: true, parry4: true }, games: 0, gamesVerified: 0,
    note: 'deny:four 冲四预挡（Rapfi 复盘：放任冲四制造点会被连续单杀逼迫）；同期加入禁手模式 gomoku-pro。与 v7 相隔 1 分钟，无归档棋谱。' },
  { id: 'v7-vcf', name: 'VCF 攻防', rank: 7, commit: '57a9508', commitAt: '2026-09-30 10:43',
    date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true }, games: 4, gamesVerified: 20,
    note: 'VCF 威胁空间搜索接入：7 ply / 4000 节点，层数 5→9，vcfAttack/vcfDefense 插在 threat 与 parry 之间。exp-20260930025135（proxy vs rapfi，10:53–10:57 落库）4 局，vcfAttack/vcfDefense 标签实证。' },
  { id: 'v8-vcf-try', name: 'VCF 逐点试', rank: 8, commit: '9cf4a88', commitAt: '2026-09-30 11:41',
    date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true }, games: 3, gamesVerified: 3,
    note: '层数不变，vcfDefense 补丁：链首占不住时逐点试干预。两组数据要分开读：exp-20260930084500（proxy vs rapfi，16:46–16:54 落库）3 局=**窗口推定**，均无 meta；本轮 A/B 的 3 个 v8 阵营位（每手 ai.tv 实证，gamesVerified 指的就是它们）。' },
  { id: 'v9-vcf-sound', name: '防伪胜', rank: 9, commit: 'a16fdd9', commitAt: '2026-09-30 16:58',
    date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true }, games: 26, gamesVerified: 16,
    note: 'vcfWin soundness 修复：引擎层双杀短路前过守方反杀闸门（gomoku.defenderWinsFull）+ 棋谱归因 meta（codeVersion/aiMoveMeta/aiGameMeta）。**快照口径（已退役）**：当时 `games: 26` 是按文件名时间窗算出来的，新棋谱会持续落进本档窗口，所以只记到改表那一刻；实时局数看「棋谱归档」面板。**gamesVerified=4 才是真跑过本档的局**：3 局机机 A/B（jev-v8-vs-jev-v9 / jev-v9-vs-jev-v8 ×2）+ 1 局人机（jev-v9-vs-jev-v9），每手 ai.tv 实证。**当时「归组按时间窗、不按内容」是错的**：部署滞后期间落库的 20 局（meta.code=0.7.0）被窗口算进本档，实证却是 v7 档——P7 已删掉时间窗口径与滞后台账，归因只看 `meta.code` / 每手 `ai.tv`（D1 的 `code_version` 列）。**gamesVerified 4→16**：2026-10-02 的 v10 对照实验里有 12 局跑的是本档（tag exp-20261001174212 4 局 + exp-20261001181244 8 局，每手 `ai.tv` = v9-vcf-sound）。' },
  { id: 'v10-live3', name: '深活三攻防', rank: 10, commit: '8751070', commitAt: '2026-10-02 01:40',
    date: '2026-10-02', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, live3Attack: true, live3Defense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true }, games: 0, gamesVerified: 12,
    note: '4-ply 活三真推演（用户要求：分析第九版与搜索算法对弈的棋谱后优化）。引擎新增 `live3Makers` / `live3Deny`：把「活三制造点」从 labelPoint 的连续 XXX 模式匹配升级成与 fiveCompletions 同一把尺的推演——L2 活四制造点（落子后 ≥2 个成五点）之上再叠 L3（落子后 ≥2 个 L2，对手只能挡一个），跳活三 / 斜向组合 / 带空隙的四都能认出来；接管链插在 vcfDefense 与 parry 之间，攻击层要求对手没有 2 手剑（`danger_points_opponent` 为空）才抢。**依据（27 局 rapfi 归档复盘）**：rapfi 胜 21 局里只有 2 局是 7-ply VCF 链将死，但 27/27 局都出现过「对手能造活三」的局面；proxy 在首次可用手里拆掉 13 局 / 漏掉 14 局，漏的 12 局是执白在第 6 手放行黑方反对角线活三（黑三子 H8/E11/B14 同在 r+c=14 上，拆点 F10/D12 是跳活三，v9 的连续三模式认不出、parry3 的 deny:live3 标签也打不出来）。**对照实验（2026-10-02，rapfi@500ms，黑白交替，两臂各 12 局）**：本档 **6 胜 4 和 2 负（得分率 67%，执黑 4 胜 2 负 / 执白 2 胜 4 和 0 负）**，v9 同条件 **3 胜 0 和 9 负（25%）**；live3 两层在本档 12 局里接管 168 手（live3Attack 120 / live3Defense 48），v9 同批对手零接管；平均手数 55→98，4 局 225 手满盘和棋。**同门直连对照（2026-10-02，两侧同渠道同模型、唯一变量是战术档，12 局黑白交替，tag exp-20261002080446）**：本档 **3 胜 4 和 5 负（得分率 41.7% · 不败率 58.3%；执黑 3 胜 1 和 2 负 / 执白 0 胜 3 和 3 负）**，v11-vct 同条件 5 胜 4 和 3 负（不败率 75.0%）——v10 执白一胜未得，差距集中在白方。' },
  { id: 'v11-vct', name: '连续威胁搜索', rank: 11, commit: '638f844', commitAt: '2026-10-02 13:25',
    date: '2026-10-02', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vctAttack: true, vcfDefense: true, live3Attack: true, live3Defense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true }, games: 0, gamesVerified: 24,
    note: 'VCT（连续威胁搜索）：用户要求做第十一版。引擎新增 `vctWin`——把 vcfWin 的冲四链扩展成「冲四 + 活三逼迫」，攻方 5 手 / 每层 10 手 / 3000 节点 / 守方应手 >6 不当作逼迫手（三个上限由 586 个真实回合标定：与初版 14/6000/∞ 看见同样 55 手必胜链，平均 607→422ms、p90 2430→1636ms）。冲四＝守方唯一堵点（双四当场胜）；活三＝落子后**新造出** ≥2 个必胜点，守方应手不靠「堵端点」而是精确枚举（vctDefusers：落此点后攻方再无必胜点），并要求对手当下没有冲四可走（否则他反先一步成五）。**依据（v10 对照实验 12 局逐手离线复算，独立实现交叉核对）**：v10 臂 586 个代理回合里，7-ply 纯冲四有杀 22 手、11-ply 补出 2 手，而 VCT 42 手——**只有 VCT 看得见的 20 手分布在 7 局，其中 18 手连 11 ply 纯冲四也看不见**；这 20 手当时走的几乎全是启发式 `live3Attack`（与 VCT 首步不同），其中 2 局因此和棋（3cc54941 #20/#22、0661aa24 #92/#102/#104）、1 局负（7bfba6f2 #23/#25/#27）、4 局胜。v9 臂同口径只有 13 手（6 局）。**同期纠正的语义**：活三的两个端点互斥（守方堵一端，另一端即失效），所以「≥2 个必胜点＝4 手内必胜」只在两点互相独立时成立（实测「真双威胁」24 局 0 次）；活三的正确性质是**逼迫**，VCT 正是把这种逼迫串起来。接管链插在 vcfAttack 与 vcfDefense 之间（同属强制胜，排在防守之前）。**对照实验（2026-10-02，单臂 12 局 vs `rapfi@500ms`，黑白交替，tag exp-20261002055817，上线版本 `1.0.0+638f844`）**：本档 **10 胜 0 和 2 负（得分率 83.3%，执黑 5 胜 1 负 / 执白 5 胜 1 负）**，同条件 v10 6 胜 4 和 2 负（67%）、v9 3 胜 9 负（25%）⇒ 把 v10 的 4 局满盘和棋里的一部分转成了胜局。平均手数 **34**（逐局 27/36/27/32/33/57/34/24/39/32/29/38；v10 臂 98、v9 臂 55）——对局从「长和棋」变「短分胜负」，**12 局零和棋**。实证口径：`game_moves` 里 `v11-vct` **12 局 / 206 手**，与本轮 206 次上游调用逐一手数交叉一致（每手 `ai.tv` 实证），故 `gamesVerified = 12`。**同门直连对照（2026-10-02，两侧同渠道同模型，唯一变量是战术档，12 局黑白交替，tag exp-20261002080446）**：本档 **5 胜 4 和 3 负（得分率 58.3% · 不败率 75.0%；执黑 3 胜 3 和 0 负 / 执白 2 胜 1 和 3 负）**，v10 同条件 **3 胜 4 和 5 负（41.7% · 不败率 58.3%；执黑 3 胜 1 和 2 负 / 执白 0 胜 3 和 3 负）**——两侧执黑战绩相同，净胜来自白方；4 局和棋全是 225 手满盘（同门互攻不穿，对照打 Rapfi 的零和棋可见和棋率由对手强度决定），两侧 `parry4` 合计 160 手 ⇒ 下一版入口在「无强制胜时的防守与长线取势」。**计时轮（2026-10-02，再打一次 `rapfi@500ms`，tag exp-20261002094817，`tac_ms` 上线后首轮）**：本档 **9 胜 0 和 3 负（得分率 = 不败率 75.0%，12 局零和棋，平均 29 手）**，与上一轮同口径的 83.3% 同量级；**单步成本第一次被拆开**——`game_moves.ms` 均值 8730ms（最坏 43423ms）里，战术层 `tac_ms` 均值 **402ms** / 最坏 4474ms（175 手样本），即**战术层约占单步墙钟 4.6%**，其余是模型往返与重试等待；对手 Rapfi 的固定搜索预算是 500ms/手 ⇒ 本档的棋力增量不是靠更大的搜索预算换来的。逐手复盘：175 个 v11 回合里 72 手（41%）存在必胜链、69 手走了链首步、机会真丢 0 手；**3 局负局（#5/#6/#8）全程 0 次报出必胜链** ⇒ 输在「算不出强制胜」的局面。**gamesVerified 12→24** = 两轮对照实验各 12 局，每手 `ai.tv` 实证。' },
  { id: 'v12-vct-def', name: '连续威胁防守', rank: 12, commit: '（本版实现提交见 CHANGELOG [Unreleased]）', commitAt: '2026-10-02 21:00',
    date: '2026-10-02', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vctAttack: true, vcfDefense: true, vctDefense: true, live3Attack: true, live3Defense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true }, games: 0, gamesVerified: 0,
    note: '拆对手的连续威胁链（用户要求：根据所有已跑的实验整合出下一版战术优化，并先过一遍已有棋谱看回归风险）。引擎新增 `vctDefense`——v11 的 `vctWin` 只回答「我有没有必胜链」，防守侧仍只有 v9 的 `vcfDefense`（只验纯冲四链）；对手把链换成「活三逼迫 + 冲四收尾」，vcfDefense 就放行了。**依据（两轮 v11 vs `rapfi@500ms`、48 个「我方无杀而对手有链」的回合，逐手离线复算）**：实走拆掉 33 个、漏 15 个；漏的 15 个里只有 **2 个存在能拆的点却没走**——计时轮 `#8 f463acff` ply24 → **K9**（实走 I11/parry）、首轮 `#6` ply52 → **K8**（实走 G10/parry），其余 13 个连全盘候选都拆不掉（点无回头路，局面已输）。四种候选生成策略对照（只试链首 12/20 与 19/28；链首 + 链上各点同数；**加「链点的车氏 ≤2 邻域」13/20 与 21/28**；全部邻近空点按到链距离排序同样 13/20、22/28）⇒ 候选集取「链上各点 → 链点邻域 → 全部邻近空点（按到链距离升序）」、上限 12 个。判据比 vcfDefense 严：落子后对手**既无 VCF(7) 也无 VCT(9)**（外加「没有一手成五」兜底）。拆法不止一种时按 1-ply 取势排序（对手造四点 ×2 + 活三点更少者优先，模型候选优先）——实测有连拆六条链仍被穿透的局，随手拆一个常把主动权交回去。接管链插在 vcfDefense 与 live3Attack 之间（对手的强制胜比我们先手造活三快），闸门是「我方无 VCF/VCT 必胜链 且 vcfDefense 没找到拆点」，故只在「我方无杀而对手有链」的回合开火（实测占代理回合 ≤11%）。' },
];

/** 当前档位（最后一档）。 */
export const CURRENT = 'v12-vct-def';

const BY_ID: Record<string, TacticsVersion> = {};
VERSIONS.forEach((v) => { BY_ID[v.id] = v; });

/** 解析档位：falsy → 当前档；未知 id → 当前档（写错档号静默回退，联名/对局都不能因它崩）。 */
export function resolve(id?: string | null): TacticsVersion {
  if (id == null || id === '') return BY_ID[CURRENT]!;
  return BY_ID[String(id)] || BY_ID[CURRENT]!;
}

/* ---------- 已退役：文件名时间窗归版（WINDOWS / versionForFileStamp）----------
 * 旧口径：棋谱文件名一律 `<gid>-<stamp>.json`（stamp = body.exported 的 14 位 UTC 数字），
 * 于是用「stamp 落在 [本档 commitAt, 下一档 commitAt) 即归本档」推出这一局跑的是哪一版。
 * （v0-off 没有 commit，它是 v1 之前的全部时间，区间起点取 0。）
 *
 * 为什么删掉：这个口径把**落库时间**当成了**代码版本**。线上没重新部署时，棋谱照样
 * 按新窗口归组 —— 2026-09-30 就有 20 局的 `meta.code` 是 0.7.0，窗口却算成 v9。
 * 迁移后 D1 里已经有每局自己的版本声明（`games.code_version` / `games.tactics_version`，
 * 导入时逐字取自棋谱），归因不再需要推断，会猜错的那半边被彻底拿掉：
 * 没有声明的局显示「未知」，而不是给出一个看上去很确定的档位。
 * 数据层口径见 test/core/attribution.spec.ts（对导入后的库断言）。 */

/** 机制闸门：该版本没有的机制必须整条跳过（computeTactics 与接管链共用）。 */
export function allows(version: TacticsVersion | null | undefined, mech: string): boolean {
  return !!version && !!version.mech[mech];
}

/* ---------- 已退役：部署滞后台账（DEPLOY_LAG / auditCode）----------
 * 存在的理由：窗口归属说「stamp 落这一档」，`meta.code` 说「实际跑的是哪一版引擎」，
 * 部署滞后时两者不一致 —— 2026-09-30 就发生了 20 局（线上仍跑 0.7.0，新窗口算成 v9）。
 * 当时必须把这个不一致显式登记成台账（from=20260930090448 / until=20260930145559 /
 * games=20 / code=0.7.0），否则「按版本分类」的输入是脏的。
 *
 * 为什么删掉：台账是「用推断的档位当基准、把真实声明当异常」的补丁。迁移后
 * `games.code_version` 就是每局自己的声明（P4 导入逐字落库、p4 对账 0 差异），
 * 基准与声明合一，不再有「窗口 vs 实测」这对矛盾，也就不需要台账与审计函数。
 * 那 20 局的历史事实改由 test/core/attribution.spec.ts 钉在数据上断言。 */

/** 机制键（顺序即接管链顺序 + 三个附加键）。 */
export const MECHS: readonly string[] = Object.freeze(['win', 'block', 'open4', 'threat', 'vcfAttack', 'vctAttack', 'vcfDefense', 'vctDefense', 'live3Attack', 'live3Defense', 'parry', 'parry3', 'parry4', 'safeSort', 'vcfTry', 'sound']);

/** 全部档位 id（注册顺序）。 */
export function ids(): string[] {
  return VERSIONS.map((v) => v.id);
}

function U(cond: unknown, msg: string): void { assert(cond, msg); }

export function selfTest(): void {
  assert(VERSIONS.length === 13, '应登记 12 个战术版本 + 1 基线，实际 ' + VERSIONS.length);
  U(CURRENT === VERSIONS[VERSIONS.length - 1]!.id, '当前档必须是最后一档');
  VERSIONS.forEach((v, i) => {
    U(v.rank === i, v.id + ' rank 不连续');
    U(typeof v.commit === 'string' && v.commit.length > 0, v.id + ' 缺引入提交');
    U(typeof v.commitAt === 'string' && v.commitAt.length > 0, v.id + ' 缺引入时间');
    U(typeof v.note === 'string' && v.note.length > 0, v.id + ' 缺实战依据');
    U(Number.isInteger(v.games) && v.games >= 0, v.id + ' games 必须是非负整数');
    U(Number.isInteger(v.gamesVerified) && v.gamesVerified >= 0, v.id + ' gamesVerified 必须是非负整数');
  });
  for (let i = 1; i < VERSIONS.length; i++)
    for (const k of MECHS)
      if (VERSIONS[i - 1]!.mech[k]) U(!!VERSIONS[i]!.mech[k], VERSIONS[i]!.id + ' 丢了上级机制 ' + k);
  /* commitAt 是人读的版本边界（P7 起不再由它算时间窗）：必须可解析、不许空 */
  for (const v of VERSIONS)
    U(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v.commitAt || ''), v.id + ' 的 commitAt 应可解析');
}
