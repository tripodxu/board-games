/* tactics-versions.ts — 战术层版本登记表（迁移自 js/tactics-versions.js）
 *
 * 为什么存在：战术层是 9 次提交逐层累加上线的，没有登记表就无法回答
 * 「这个版本为什么强/弱」，实验也无法按版本归因。机制键与 jev 接管链一一对应
 * （优先级从高到低）：
 *   win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4
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
  { id: 'v9-vcf-sound', name: '防伪胜（当前）', rank: 9, commit: 'a16fdd9', commitAt: '2026-09-30 16:58',
    date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true }, games: 26, gamesVerified: 4,
    note: 'vcfWin soundness 修复：引擎层双杀短路前过守方反杀闸门（gomoku.defenderWinsFull）+ 棋谱归因 meta（codeVersion/aiMoveMeta/aiGameMeta）。**快照口径（已退役）**：当时 `games: 26` 是按文件名时间窗算出来的，新棋谱会持续落进本档窗口，所以只记到改表那一刻；实时局数看「棋谱归档」面板。**gamesVerified=4 才是真跑过本档的局**：3 局机机 A/B（jev-v8-vs-jev-v9 / jev-v9-vs-jev-v8 ×2）+ 1 局人机（jev-v9-vs-jev-v9），每手 ai.tv 实证。**当时「归组按时间窗、不按内容」是错的**：部署滞后期间落库的 20 局（meta.code=0.7.0）被窗口算进本档，实证却是 v7 档——P7 已删掉时间窗口径与滞后台账，归因只看 `meta.code` / 每手 `ai.tv`（D1 的 `code_version` 列）。' },
];

/** 当前档位（最后一档）。 */
export const CURRENT = 'v9-vcf-sound';

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
export const MECHS: readonly string[] = Object.freeze(['win', 'block', 'open4', 'threat', 'vcfAttack', 'vcfDefense', 'parry', 'parry3', 'parry4', 'safeSort', 'vcfTry', 'sound']);

/** 全部档位 id（注册顺序）。 */
export function ids(): string[] {
  return VERSIONS.map((v) => v.id);
}

function U(cond: unknown, msg: string): void { assert(cond, msg); }

export function selfTest(): void {
  assert(VERSIONS.length === 10, '应登记 9 个战术版本 + 1 基线，实际 ' + VERSIONS.length);
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
