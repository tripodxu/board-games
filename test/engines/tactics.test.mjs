/* test/engines/tactics.test.mjs — 战术版本登记表 + 保险接管链（v12 起十三级，v13 起十四级）+ VCF soundness 回归
 *
 * 覆盖旧 test/run-tests.cjs 中的：
 *   - tacticsRegistryTests()（版本登记表、rank/机制单调、层数对照、机制闸门 allows）
 *     —— 时间窗归版（versionForFileStamp）与滞后台账（DEPLOY_LAG/auditCode）已在 P7 退役，
 *     归因改由 test/core/attribution.spec.ts 对「导入后的 D1 库」断言，不放这里。
 *   - ⑥c/⑦/⑧/⑨/⑨b/⑨c/⑩/⑪/⑫a–⑫j（战术事实、接管链、经验注入、VCF 真链与伪胜）
 *   - ⑬a–⑬g（版本闸门：同一局面按档给出不同事实与接管行为）
 *   - ⑤b（v10 活三：引擎层真推演 + 两档事实对照 + 决策级抢/拆活三 + 让位给更短的杀）
 *   - ⑤c（v11 VCT：引擎层连续威胁搜索 + 与纯 VCF 的可见性对照 + 决策级抢链首）
 *   - ⑤d（v12 拆连续威胁链：引擎层 vctDefense + 与 vcfDefense 的可见性对照 + 决策级拆链）
 *   - ⑤e（v13 压力闸门：引擎层 pressureCut + 落后才开火 + 按档事实对照 + 决策级削点）
 */
import { suite, ok, eq, deepEq, near } from './harness.mjs';

import { games, getGame } from '../../src/core/registry.ts';
import { setSeed } from '../../src/core/rng.ts';
import { computeTactics, emptyTactics, attachFacts, mechOf } from '../../src/core/tactics.ts';
import { BUDGET_KEYS, DEFAULT_BUDGET, budgetOf, sameBudget } from '../../src/core/tactics-budget.ts';
import * as R from '../../src/core/tactics-versions.ts';
import { decide } from '../../src/core/jev/index.ts';

const S = suite();
const gomoku = getGame('gomoku');
const gomokuPro = getGame('gomoku-pro');

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */
const mk = (status, obj) => new Response(JSON.stringify(obj), { status });
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const repliesWith = (probs, extra) => async (url, init) => mk(200, Object.assign({
  model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
  answers: { move: { probabilities: probs } },
}, extra));

/** 按记法序列摆出一个局面。 */
function play(e, seq) {
  let st = e.newGame();
  for (const n of seq) {
    const m = e.moveFromNotation(st, n);
    if (!m) throw new Error('夹具记法非法：' + n);
    st = e.applyMove(st, m);
  }
  return st;
}
const critOf = (e, st, side) => Object.keys(e.serializeForJev(st, side || st.turn).questions.move.criteria || {});
const tacOf = (e, st, versionId) => computeTactics(e, st, e.getLegalMoves(st), critOf(e, st), versionId);

/* ⑫a 基准局面：黑 E7 F7 G7 H5 H6，白 D7 A1 A2 A3 B1，黑走；真链 H7→I7→H4 */
const VCF_SEQ = ['E7', 'D7', 'F7', 'A1', 'G7', 'A2', 'H5', 'A3', 'H6', 'B1'];
/* ⑥c/⑦ 局面：黑活三 F8 G8 H8 vs 白活三 G7 H7 I7，黑行棋；G8 是致胜点 */
const SWAP_SEQ = ['F8', 'G7', 'G8', 'H7', 'H8', 'I7'];

/* ------------------------------------------------------------------ *
 * ① 版本登记表（git 历史 × 棋谱数据双锚定：13 个战术版本 + 1 数据驱动基线）
 * ------------------------------------------------------------------ */
S.t('版本登记表：当前档 / 版本齐全 / rank 连续', () => {
  eq(R.CURRENT, 'v14-plus', '当前档应为 v14-plus（整合收紧：v14 全机制 + 防守侧预算三键收紧）');
  const ANCHORED = ['v1-facts', 'v2-open4', 'v3-make2', 'v4-parry3', 'v5-safesort',
    'v6-parry4', 'v7-vcf', 'v8-vcf-try', 'v9-vcf-sound', 'v10-live3', 'v11-vct', 'v12-vct-def', 'v13-pressure-gate', 'v14-live3-fresh', 'v14-plus'];
  for (const id of ANCHORED) ok(R.VERSIONS.some((v) => v.id === id), '登记表漏版本 ' + id);
  eq(R.VERSIONS.length, 16, '应为 15 个战术版本 + 1 基线');
  eq(R.VERSIONS[0].id, 'v0-off', 'rank 0 应为无战术基线');
  R.VERSIONS.forEach((v, i) => eq(v.rank, i, v.id + ' rank 应为 ' + i));
  eq(R.VERSIONS[R.VERSIONS.length - 1].id, R.CURRENT, 'CURRENT 应是末档（最新档）');
});

S.t('版本登记表：机制集合沿梯级单调不减', () => {
  for (let i = 1; i < R.VERSIONS.length; i++) {
    const prev = R.VERSIONS[i - 1].mech, cur = R.VERSIONS[i].mech;
    for (const k of R.MECHS) {
      if (prev[k]) ok(cur[k], R.VERSIONS[i].id + ' 丢了上级机制 ' + k);
    }
  }
});

S.t('版本登记表：十五级层数对照（2/3/5/6/6/7/9/9/9/11/12/13/14/14/14）', () => {
  const LAYERS = {
    'v0-off': 0, 'v1-facts': 2, 'v2-open4': 3, 'v3-make2': 5, 'v4-parry3': 6,
    'v5-safesort': 6, 'v6-parry4': 7, 'v7-vcf': 9, 'v8-vcf-try': 9, 'v9-vcf-sound': 9,
    'v10-live3': 11, 'v11-vct': 12, 'v12-vct-def': 13, 'v13-pressure-gate': 14,
    /* v14 不加层：层数不变，只纠偏 live3 两层的判据 */
    'v14-live3-fresh': 14,
    /* v14-plus 不加层：机制同 v14，只收紧防守侧预算（vctDefMax/vctDefKeep/pressureCutMax） */
    'v14-plus': 14,
  };
  const TIER = ['win', 'block', 'open4', 'threat', 'vcfAttack', 'vctAttack', 'vcfDefense', 'vctDefense',
    'pressureGate', 'live3Attack', 'live3Defense', 'parry', 'parry3', 'parry4'];
  for (const v of R.VERSIONS) {
    const got = TIER.filter((k) => v.mech[k]).length;
    eq(got, LAYERS[v.id], v.id + ' 接管层数应为 ' + LAYERS[v.id] + '，实际 ' + got);
  }
});

S.t('版本登记表：棋谱归属（窗口严格一致，当前档只兜底）', () => {
  eq(R.resolve('v0-off').games, 0, 'v0 应无归档棋谱');
  eq(R.resolve('v1-facts').games, 0, 'v1 应无归档棋谱');
  eq(R.resolve('v5-safesort').games, 21, 'v5 窗口应归档 21 局（9/29 17:51–19:28，parry3 标签实证）');
  eq(R.resolve('v7-vcf').games, 4, 'v7 应归档 4 局（exp-20260930025135，vcf 标签实证）');
  eq(R.resolve('v8-vcf-try').games, 3, 'v8 应归档 3 局（线上旧引擎）');
  ok(R.resolve('v9-vcf-sound').games >= 26, 'v9 档应登记 26 局窗口棋谱（快照口径已退役；当前档 v14-live3-fresh 的实证局数看 gamesVerified）');
  const total = R.VERSIONS.reduce((a, v) => a + v.games, 0);
  ok(total >= 54, 'games 字段合计应不少于 games/ 当前 54 局，实际 ' + total);
  /* gamesVerified 与 games 是两个口径：前者是「有元数据实证确实跑过本档」的局数 */
  eq(R.resolve('v0-off').gamesVerified, 2, 'v0 有 2 局实证');
  eq(R.resolve('v5-safesort').gamesVerified, 0, 'v5 窗口局无本档实证');
  eq(R.resolve('v7-vcf').gamesVerified, 20, 'v7 实证 20 局（线上 0.7.0 滞后局）');
  eq(R.resolve('v9-vcf-sound').gamesVerified, 16, 'v9 实证 16 局');
  for (const v of R.VERSIONS) {
    ok(Number.isInteger(v.gamesVerified) && v.gamesVerified >= 0, v.id + ' 必须有非负整数 gamesVerified');
    ok(Number.isInteger(v.games) && v.games >= 0, v.id + ' 必须有非负整数 games');
  }
});

S.t('版本登记表：resolve 严格（P0/D2）与 allows 闸门', () => {
  eq(R.resolve('').id, R.CURRENT, '空 id 应回退当前档');
  eq(R.resolve(null).id, R.CURRENT, 'null 应回退当前档');
  /* P0/D2：未知档号**抛错**，绝不静默回落 —— 否则「贴 v12 标签跑 v14」的实验数据没人看得出来 */
  let threw = null;
  try { R.resolve('v99-nope'); } catch (e) { threw = e; }
  ok(threw instanceof Error, '未知 id 应抛错（不再是回退当前档）');
  ok(/v99-nope/.test(threw.message), '错误信息应含原 id：' + threw.message);
  ok(/v\d+-/.test(threw.message), '错误信息应含最接近的合法档位：' + threw.message);
  eq(R.nearestId('v12-vct-de'), 'v12-vct-def', 'typo 应指向 v12-vct-def（P0 验收用例）');
  eq(R.nearestId(''), null, '空串没有「最接近」');
  eq(R.tryResolve('v99-nope'), null, 'tryResolve 对未知 id 返回 null（展示路径用）');
  eq(R.tryResolve('v4-parry3').id, 'v4-parry3', 'tryResolve 对已知 id 正常返回');
  eq(R.tryResolve(''), null, 'tryResolve 对空值返回 null（由调用方决定怎么显示）');
  eq(R.resolve('v4-parry3').id, 'v4-parry3', '已知 id 应原样返回');
  ok(R.allows(R.resolve('v1-facts'), 'win'), 'v1 应有 win 层');
  ok(!R.allows(R.resolve('v1-facts'), 'open4'), 'v1 不应有 open4 层');
  ok(!R.allows(R.resolve('v0-off'), 'win'), 'v0-off 应无 win 层');
  ok(R.allows(R.resolve('v7-vcf'), 'vcfDefense'), 'v7 应有 vcfDefense 层');
  ok(R.allows(R.resolve('v8-vcf-try'), 'vcfTry'), 'vcfTry 应仅 v8 起有');
  ok(!R.allows(R.resolve('v7-vcf'), 'vcfTry'), 'v7 不应有 vcfTry');
  ok(R.allows(R.resolve('v9-vcf-sound'), 'sound'), 'sound 应仅 v9 起有');
  ok(!R.allows(R.resolve('v8-vcf-try'), 'sound'), 'v8 不应有 sound');
  ok(R.allows(R.resolve('v10-live3'), 'live3Defense'), 'live3Defense 应仅 v10 起有');
  ok(!R.allows(R.resolve('v9-vcf-sound'), 'live3Attack'), 'v9 不应有 live3Attack');
  ok(R.allows(R.resolve('v10-live3'), 'sound'), 'v10 应继承 v9 的 sound 层');
  ok(R.allows(R.resolve('v11-vct'), 'vctAttack'), 'vctAttack 应仅 v11 起有');
  ok(!R.allows(R.resolve('v10-live3'), 'vctAttack'), 'v10 不应有 vctAttack');
  ok(R.allows(R.resolve('v11-vct'), 'live3Defense'), 'v11 应继承 v10 的 live3Defense 层');
  ok(R.allows(R.resolve('v12-vct-def'), 'vctDefense'), 'vctDefense 应仅 v12 起有');
  ok(!R.allows(R.resolve('v11-vct'), 'vctDefense'), 'v11 不应有 vctDefense（A/B 必须是单变量）');
  ok(R.allows(R.resolve('v12-vct-def'), 'vctAttack'), 'v12 应继承 v11 的 vctAttack 层');
  ok(R.allows(R.resolve('v12-vct-def'), 'live3Defense'), 'v12 应继承 v10 的 live3Defense 层');
  const v0 = R.VERSIONS[0];
  for (const k of R.MECHS) ok(!v0.mech[k], 'v0-off 的 ' + k + ' 应为关');
});

/* ------------------------------------------------------------------ *
 * ①b P1 冻结层（预算表 + sound 历史语义 + openingMin / 指令按机制过滤）
 * ------------------------------------------------------------------ */
S.t('P1 冻结层：15 档预算齐全、缺省即历史常量、写错只会更保守', () => {
  eq(BUDGET_KEYS.length, 15, '预算字段应为 15 个（BUDGET_KEYS 是冻结顺序的唯一来源）');
  for (const v of R.VERSIONS)
    for (const k of BUDGET_KEYS)
      ok(typeof v.budget[k] === 'number' && v.budget[k] > 0, v.id + ' 缺预算 ' + k);
  eq(sameBudget(budgetOf(), DEFAULT_BUDGET), true, 'budgetOf() 应逐字等于 DEFAULT_BUDGET');
  eq(budgetOf({ vcfPlies: 3 }).vcfPlies, 3, '给了正数就用给的');
  eq(budgetOf({ vcfPlies: 0 }).vcfPlies, DEFAULT_BUDGET.vcfPlies, '0 不是「关掉」而是写错 ⇒ 回落默认');
  eq(budgetOf({ vcfNodeLimit: -5 }).vcfNodeLimit, DEFAULT_BUDGET.vcfNodeLimit, '负数回落默认');
  eq(budgetOf({ vctNodeLimit: NaN }).vctNodeLimit, DEFAULT_BUDGET.vctNodeLimit, 'NaN 回落默认');
  eq(sameBudget(DEFAULT_BUDGET, budgetOf({ live3DenyEvalMax: 25 })), false, '一个字段不同就不算同预算');
  /* 冻结常量 = 今日常量逐字：要改它们只能新开一档，所以这里逐字钉死（改这里等于改历史） */
  const FROZEN_EXPECT = {
    vcfPlies: 7, vcfNodeLimit: 4000, vcfMovesMax: 12,
    vctPlies: 9, vctNodeLimit: 3000, vctMovesMax: 10, vctDefusersMax: 6,
    vctDefMax: 12, vctDefKeep: 3, vcfDefPlies: 7, vctDefPressureLimit: 3,
    live3DenyEvalMax: 24, pressureCutMax: 120, pressureCutKeep: 3, fourPressureLimit: 99,
  };
  for (const k of BUDGET_KEYS) eq(DEFAULT_BUDGET[k], FROZEN_EXPECT[k], 'DEFAULT_BUDGET.' + k + ' 必须等于冻结当天的常量');
});

S.t('P1 冻结层：sound 记历史事实（v9 起才有闸门）/ fidelity / openingMin / 注入口径', () => {
  eq(R.resolve('v8-vcf-try').sound, false, 'v8 上线时没有 soundness 闸门（历史事实，不是「推荐值」）');
  eq(R.resolve('v9-vcf-sound').sound, true, 'v9 起有 soundness 闸门');
  for (const v of R.VERSIONS) {
    eq(v.sound, v.rank >= 9, v.id + ' 的 sound 应与「v9 才有闸门」一致');
    eq(v.openingMin, 4, v.id + ' 的开局短路应仍是 4 手');
    eq(v.promptFacts, 'mech', v.id + ' 的注入口径应为 mech（只注入本档真有的机制句）');
  }
  eq(R.resolve('v14-live3-fresh').fidelity, 'exact', 'v14 就是冻结当天那一版 ⇒ exact');
  eq(R.resolve('v14-plus').fidelity, 'exact', 'v14-plus 与 v14 同 mech ⇒ attachFacts 句集逐字一致，新登记即 exact');
  /* v14-plus 的三键收紧：预算冻结原则下「调参只能新开一档」的唯一合法路径 */
  const bPlus = R.resolve('v14-plus').budget, b14 = R.resolve('v14-live3-fresh').budget;
  eq(bPlus.vctDefMax, 8, 'v14-plus 的 vctDefMax 应收紧到 8（12→8，最坏搜索 26→18 次）');
  eq(bPlus.vctDefKeep, 2, 'v14-plus 的 vctDefKeep 应收紧到 2（3→2）');
  eq(bPlus.pressureCutMax, 80, 'v14-plus 的 pressureCutMax 应收紧到 80（120→80）');
  for (const k of Object.keys(b14)) {
    if (k === 'vctDefMax' || k === 'vctDefKeep' || k === 'pressureCutMax') continue;
    eq(bPlus[k], b14[k], 'v14-plus 除三键收紧外其余预算应与 v14 逐键一致：' + k);
  }
  /* P3 考古（docs/plans/2026-10-04-tactics-archaeology.md）：v1–v13 的四项参数全部有 git 证据 ⇒ restored；
     v0-off 的档位表没有 sha、参数无证据 ⇒ 只能 approximate（不猜）。口径 = 参数层，不等于 exact。 */
  eq(R.resolve('v13-pressure-gate').fidelity, 'restored', 'P3 考古确证过参数的历史档应是 restored');
  eq(R.resolve('v5-safesort').fidelity, 'restored', 'v1–v13 同批升 restored（含 js 时代的档）');
  eq(R.resolve('v0-off').fidelity, 'approximate', 'v0-off 无 sha、参数缺证据 ⇒ 留在 approximate');
  const restored = R.VERSIONS.filter((v) => v.fidelity === 'restored').map((v) => v.id);
  eq(restored.length, 13, 'restored 应恰好是 v1–v13 十三档，实际 ' + restored.join(','));
});

S.t('P1 冻结层：预算与 sound 真的下到引擎（vcfWin 正对照）', () => {
  /* 正对照局面（同 ⑫i）：守方堵点造四反杀 —— sound 闸门开着不许报胜，关掉就该报出那条链 */
  const syn2 = gomoku.newGame();
  [[1, 5, 1], [2, 5, 1], [3, 5, 1], [4, 6, 1], [4, 7, 1], [5, 6, 1],
    [0, 5, 2], [5, 2, 2], [5, 3, 2], [5, 4, 2]].forEach(([r, c, p]) => { syn2.board[r][c] = p; });
  syn2.moveNum = 12;
  const gated = gomoku.vcfWin(syn2, 'black', 7);
  ok(!gated.win, '缺省（sound=true）不得报出不健全链，实际：' + JSON.stringify(gated));
  const unsound = gomoku.vcfWin(syn2, 'black', 7, { sound: false });
  ok(unsound.win && unsound.first === 'F5', 'sound=false 应恢复 v7/v8 的历史语义（报出 F5 链），实际：' + JSON.stringify(unsound));
  ok(!gomoku.vcfWin(syn2, 'black', 7, { nodeLimit: 1 }).win, 'nodeLimit 关到 1 应搜不出链 ⇒ 预算真的下到了引擎');
  const st = play(gomoku, VCF_SEQ);
  const full = gomoku.vcfWin(st, 'black', 7, { sound: true, nodeLimit: 4000, movesMax: 12 });
  ok(full.win && full.first === 'H7', '显式给默认预算必须与缺省同解，实际：' + JSON.stringify(full));
  /* 档位级（computeTactics）：v7 无闸门 ⇒ 报出 F5；v9 有闸门 ⇒ 不报。这是「按档下传」的端到端证据 */
  const t7 = tacOf(gomoku, syn2, 'v7-vcf');
  const t9 = tacOf(gomoku, syn2, 'v9-vcf-sound');
  ok(t7.vcf_win_you.indexOf('F5') >= 0, 'v7 应报出 F5（无闸门），实际：' + JSON.stringify(t7.vcf_win_you));
  ok(t9.vcf_win_you.indexOf('F5') < 0, 'v9 不应报出 F5（有闸门），实际：' + JSON.stringify(t9.vcf_win_you));
});

S.t('P1 冻结层：机制句按档过滤，当前档逐字不变（D5）', () => {
  const st = play(gomoku, VCF_SEQ);
  const tac = tacOf(gomoku, st, R.CURRENT);
  ok(tac.vcf_win_you.length > 0, '夹具局面应真有 VCF 杀，否则这条测不出过滤');
  const a = gomoku.serializeForJev(st, st.turn);
  const b = gomoku.serializeForJev(st, st.turn);
  attachFacts(a, tac);                                        /* 老调用方：不过滤 */
  attachFacts(b, tac, undefined, { mech: mechOf(R.CURRENT) });
  eq(b.questions.move.instructions, a.questions.move.instructions, '当前档（机制全开）的指令必须逐字不变');
  ok(/vcf_win_you/.test(b.questions.move.instructions), '当前档应注入 VCF 进攻句');
  const c = gomoku.serializeForJev(st, st.turn);
  attachFacts(c, tac, undefined, { mech: mechOf('v1-facts') });
  ok(/winning_points_you/.test(c.questions.move.instructions), 'v1 应有 win 句');
  ok(!/vcf_win_you/.test(c.questions.move.instructions), 'v1 不该有 VCF 句（那时还没这一层）');
  ok(!/live3_/.test(c.questions.move.instructions), 'v1 不该有活三句');
  /* 未知档号 = 空机制集 = 不注入任何机制句（P0 的严格 resolve 与 P1 的过滤合起来的效果） */
  const d = gomoku.serializeForJev(st, st.turn);
  attachFacts(d, tac, undefined, { mech: mechOf('v99-nope') });
  ok(!/winning_points_you|vcf_win_you|live3_you|pressure_cut_points/.test(d.questions.move.instructions),
    '未知档号不得注入任何机制句，实际：' + d.questions.move.instructions);
});

S.t('版本登记表：games 与 gamesVerified 是两个独立口径（快照 vs 实证）', () => {
  /* `games` 是迁移前的冻结快照（按文件名时间窗统计），`gamesVerified` 是有元数据实证的局数。
     两者不能互相推导 —— v7 快照 4 局 / 实证 20 局，v9 快照 26 局 / 实证 16 局。
     时间窗口径本身已退役（见 src/core/tactics-versions.ts 的「已退役」注释），这里只钉住
     这两个数字不会被顺手改掉：它们读登记表时是历史的全部依据。 */
  const snap = R.VERSIONS.reduce((s, v) => s + (v.games || 0), 0);
  eq(snap, 54, '快照合计应等于 games/ 全量 54 局');
  eq(R.resolve('v7-vcf').games, 4, 'v7 快照 4 局（窗口口径）');
  eq(R.resolve('v9-vcf-sound').games, 26, 'v9 快照 26 局（窗口口径）');
  eq(R.resolve('v9-vcf-sound').gamesVerified, 16, 'v9 实证 16 局（4 局旧实证 + 2026-10-02 对照实验的 v9 臂 12 局，每手 ai.tv）');
  eq(R.resolve('v10-live3').gamesVerified, 12, 'v10 实证 12 局（对照实验两臂 4+8，每手 ai.tv = v10-live3）');
  eq(R.resolve('v11-vct').gamesVerified, 24, 'v11 实证 24 局（两轮对照实验各 12 局：exp-20261002055817 + exp-20261002094817，每手 ai.tv = v11-vct）');
  eq(R.resolve('v12-vct-def').gamesVerified, 36, 'v12 实证 36 局（三轮单臂对照实验各 12 局：exp-20261002115126 + exp-20261002121700 + exp-20261002123631，每手 ai.tv = v12-vct-def）');
  eq(R.resolve('v13-pressure-gate').gamesVerified, 52, 'v13 实证 52 局（exp-20261002160819 单臂 12 局 + 20 局档位复核 exp-20261003003108 / exp-20261003020720；另 3 局属被打断的首轮 exp-20261002154056，无实验行、不计入）');
  eq(R.resolve('v14-live3-fresh').gamesVerified, 72, 'v14 实证 72 局（exp-20261003035953 单臂 12 局 @1000ms + exp-20261003050139 单臂 20 局 @2000ms + 抬档阶梯 exp-20261003075310 单臂 20 局 @3000ms + exp-20261003082805 单臂 20 局 @5000ms，每手 ai.tv = v14-live3-fresh）');
  eq(R.resolve('v7-vcf').gamesVerified, 20, 'v7 实证 20 局（线上 0.7.0 的 20 局）');
  eq(R.resolve('v9-vcf-sound').gamesVerified === R.resolve('v9-vcf-sound').games, false,
    '快照与实证必须可区分：相等就说明其中一个口径被写坏了');
});

/* ------------------------------------------------------------------ *
 * ② 战术事实（1-ply 标签 + 2-ply 造杀/拆杀）
 * ------------------------------------------------------------------ */
S.t('战术事实：活四/必挡标签（you:open4 / deny:open4 / 静点 null）', () => {
  const st = play(gomoku, SWAP_SEQ);
  const crit = gomoku.serializeForJev(st, st.turn).questions.move.criteria;
  ok(/you:open4/.test(crit['I8']), '黑 I8 应标 you:open4（F8-I8 四、E8/J8 两成五点），实际：' + crit['I8']);
  ok(/deny:open4/.test(crit['F7']), 'F7 应标 deny:open4（白占即活四），实际：' + crit['F7']);
  ok(/deny:open4/.test(crit['J7']), 'J7 应标 deny:open4，实际：' + crit['J7']);
  const quiet = Object.entries(crit).filter(([, v]) => v === null);
  ok(quiet.length >= 1, '应存在无标签的静点候选');
});

S.t('战术事实：必胜点与拆杀点（⑦ / ⑨ / ⑨b / ⑨c）', () => {
  /* ⑦ 黑有两个致胜点（G8 成活四…），1-ply 层应给出 */
  const stx = play(gomoku, ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5']);
  const tacX = tacOf(gomoku, stx);
  eq(tacX.winning_points_you.length, 2, 'state.tactics 应含 2 个致胜点，实际：' + JSON.stringify(tacX.winning_points_you));
  /* ⑨ 白方面对黑开放三连：1-ply 无战术，2-ply 拆杀点 F6/F10 */
  const st9 = play(gomoku, ['F7', 'A1', 'F8', 'A2', 'F9']);
  eq(st9.turn, 'white', '⑨ 应轮白走');
  const tac9 = tacOf(gomoku, st9);
  ok(tac9.winning_points_you.length === 0 && tac9.winning_points_opponent.length === 0, '⑨ 该局面 1-ply 应无战术');
  ok(tac9.danger_points_opponent.indexOf('F6') >= 0 && tac9.danger_points_opponent.indexOf('F10') >= 0,
    '黑开放三连的拆杀点应含 F6/F10，实际：' + JSON.stringify(tac9.danger_points_opponent));
  /* ⑨b 己方开放三连：造杀点 F6/F10 */
  const st9b = play(gomoku, ['F7', 'A1', 'F8', 'B2', 'F9', 'C3']);
  eq(st9b.turn, 'black', '⑨b 应轮黑走');
  const tac9b = tacOf(gomoku, st9b);
  ok(tac9b.chance_points_you.indexOf('F6') >= 0 && tac9b.chance_points_you.indexOf('F10') >= 0,
    '己方开放三连的造杀点应含 F6/F10，实际：' + JSON.stringify(tac9b.chance_points_you));
  /* ⑨c 实战残局：黑除 F 三连外 E8 还藏双杀 → danger 应含 E8/F6/F10/I12 */
  const st9c = play(gomoku, ['H8', 'H7', 'G8', 'I8', 'G9', 'G7', 'I7', 'J6', 'H9', 'I9', 'I10', 'H10',
    'F7', 'E6', 'G10', 'J11', 'G11', 'G12', 'H11', 'E11', 'F9', 'E9', 'F8']);
  const tac9c = tacOf(gomoku, st9c);
  for (const n of ['E8', 'F6', 'F10', 'I12']) {
    ok(tac9c.danger_points_opponent.indexOf(n) >= 0,
      '实战残局拆杀点应含 ' + n + '，实际：' + JSON.stringify(tac9c.danger_points_opponent));
  }
});

S.t('战术事实：开局前 4 手不算战术（moveNum<4 短路）', () => {
  const st = play(gomoku, ['H8', 'H7', 'I8']);
  const tac = tacOf(gomoku, st);
  deepEq(tac, emptyTactics(), 'moveNum<4 应返回空战术：' + JSON.stringify(tac));
});

/* ------------------------------------------------------------------ *
 * ③ VCF 威胁空间搜索（真链 / 伪胜 / 深度不足 / 禁手模式）
 * ------------------------------------------------------------------ */
S.t('VCF：真将死链（首步 H7，7 ply）', () => {
  const st = play(gomoku, VCF_SEQ);
  eq(st.turn, 'black', '⑫a 应轮黑走');
  const v = gomoku.vcfWin(st, 'black', 7);
  ok(v.win && v.first === 'H7', '黑应有 VCF 将死链（首步 H7），实际：' + JSON.stringify(v));
  ok(v.line.length >= 3 && v.line[0] === 'H7', 'line 应从 H7 起且至少 3 手');
});

S.t('VCF：深度不足不虚报（maxPlies=1）', () => {
  const st = play(gomoku, VCF_SEQ);
  const v = gomoku.vcfWin(st, 'black', 1);
  ok(!v.win, 'maxPlies=1 不应虚报将死，实际：' + JSON.stringify(v));
  eq(v.first, null, '未判胜时 first 应为 null');
});

S.t('VCF：禁手模式（gomoku-pro）同局面真链不被误杀', () => {
  ok(!!gomokuPro && typeof gomokuPro.vcfWin === 'function', 'gomoku-pro 应暴露 vcfWin');
  const st = play(gomokuPro, VCF_SEQ);
  const v = gomokuPro.vcfWin(st, 'black', 7);
  ok(v.win && v.first === 'H7', 'pro 模式黑也应有 VCF 将死链（首步 H7），实际：' + JSON.stringify(v));
});

S.t('VCF soundness：守方堵点造四反杀时不得判攻方胜（⑫i）', () => {
  const syn2 = gomoku.newGame();
  [[1, 5, 1], [2, 5, 1], [3, 5, 1], [4, 6, 1], [4, 7, 1], [5, 6, 1],
    [0, 5, 2], [5, 2, 2], [5, 3, 2], [5, 4, 2]].forEach(([r, c, p]) => { syn2.board[r][c] = p; });
  syn2.moveNum = 12;
  const v = gomoku.vcfWin(syn2, 'black', 7);
  ok(!v.win && v.first === null, '守方堵点造四反杀时不应判攻方胜（伪胜回归），实际：' + JSON.stringify(v));
  /* soundness 的另一半：真链不能被误杀 */
  const vw = gomoku.vcfWin(Object.assign({}, syn2, { turn: 'white' }), 'white', 7);
  ok(vw.win && vw.first === 'B6', '白 B6 是根节点双四，应判真胜（soundness 闸门不得误杀），实际：' + JSON.stringify(vw));
  const vA = gomoku.vcfWin(play(gomoku, VCF_SEQ), 'black', 7);
  ok(vA.win, '真将死链不应被 soundness 闸门误杀，实际：' + JSON.stringify(vA));
});

S.t('VCF soundness：守方 2 个即时致胜点必无解（⑫j）', () => {
  const syn3 = gomoku.newGame();
  [[1, 5, 1], [2, 5, 1], [3, 5, 1], [4, 6, 1], [4, 7, 1],
    [0, 5, 2], [5, 2, 2], [5, 3, 2], [5, 4, 2]].forEach(([r, c, p]) => { syn3.board[r][c] = p; });
  syn3.moveNum = 12;
  const v = gomoku.vcfWin(syn3, 'black', 7);
  ok(!v.win && v.first === null, '守方堵点成活四（2 个成五点）时应判无解，实际：' + JSON.stringify(v));
});

S.t('VCF：开局无链时不误判', () => {
  const st = play(gomoku, ['H8', 'H7', 'J8']);
  const tac = tacOf(gomoku, st);
  ok(tac.vcf_win_you.length === 0 && tac.vcf_win_opponent.length === 0,
    '开局无 VCF 时两字段应为空，实际：' + JSON.stringify([tac.vcf_win_you, tac.vcf_win_opponent]));
});

/* ------------------------------------------------------------------ *
 * ④ 接管链（十三级）与经验/事实注入
 * ------------------------------------------------------------------ */
S.t('接管链：第三级活四点接管（概率偏向 G6）', async () => {
  const st = play(gomoku, SWAP_SEQ);
  const d = await withFetch(repliesWith({ G6: 0.9 }), () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1 }));
  ok((d.notation === 'E8' || d.notation === 'I8') && d.meta.tactics === 'open4',
    '活四点应被第三级接管，实际：' + d.notation + '/' + d.meta.tactics);
});

S.t('接管链：致胜点接管 + state.tactics/指令注入（⑦⑧）', async () => {
  const stx = play(gomoku, ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5']);
  let sent = null;
  const d = await withFetch(async (url, init) => {
    sent = JSON.parse(init.body);
    return mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
      answers: { move: { probabilities: { G7: 0.9, G8: 0.05 } } } });
  }, () => decide(gomoku, stx, stx.turn, { channel: 'proxy', topK: 1 }));
  ok(d.notation === 'G8' && d.meta.tactics === 'win', '致胜点应被保险接管，实际：' + d.notation + '/' + d.meta.tactics);
  ok(sent.state.tactics && sent.state.tactics.winning_points_you.length === 2,
    'state 应注入 tactics，实际：' + JSON.stringify(sent.state.tactics));
  ok(/winning_points_you/.test(sent.questions.move.instructions), '指令应声明 tactics 语义');
  ok(!/experience/.test(sent.questions.move.instructions), '无经验时指令不应提 experience');
  /* ⑧ 经验注入 */
  let sent8 = null;
  const st0 = gomoku.newGame();
  await withFetch(async (url, init) => {
    sent8 = JSON.parse(init.body);
    return mk(200, { model: 'jev-latest', usage: { input_tokens: 1 }, answers: { move: { probabilities: {} } } });
  }, () => decide(gomoku, st0, st0.turn, { channel: 'proxy', topK: 1,
    experience: { opening_plies: 2, games: 3, first_player_win_rate: 0.67 } }));
  ok(sent8.state.experience && sent8.state.experience.games === 3,
    'state 应注入 experience，实际：' + JSON.stringify(sent8.state.experience));
  ok(/experience/.test(sent8.questions.move.instructions), '有经验时指令应声明其语义');
  ok(/first_player_win_rate/.test(sent8.questions.move.instructions), '指令应说明经验字段含义');
});

S.t('接管链：开放三连拆杀（parry / vcfDefense；v14-plus 的 vctFirst 下 vctDefense 也是保险拆杀）', async () => {
  const st9 = play(gomoku, ['F7', 'A1', 'F8', 'A2', 'F9']);
  let sent = null;
  const d = await withFetch(async (url, init) => {
    sent = JSON.parse(init.body);
    return mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
      answers: { move: { probabilities: { H8: 0.85, F6: 0.05 } } } });
  }, () => decide(gomoku, st9, st9.turn, { channel: 'proxy', topK: 1 }));
  /* vctFirst（v14-plus）：vctDefense 的判据（拆完对手 VCF+VCT 全无）严格强于 vcfDefense，
   * 它在开放三连上开火仍是「保险拆杀」，且拆杀点集合不变（F6/F10 同为合法拆点）。 */
  const layers = ['parry', 'vcfDefense'];
  if (R.resolve().mech.vctFirst) layers.push('vctDefense');
  ok((d.notation === 'F6' || d.notation === 'F10') && layers.includes(d.meta.tactics),
    '开放三连必须被保险拆杀，实际：' + d.notation + '/' + d.meta.tactics);
  ok(sent.state.tactics.danger_points_opponent.length >= 2, 'state.tactics 应含拆杀点');
  ok(/danger_points_opponent/.test(sent.questions.move.instructions), '指令应声明拆杀语义');
});

S.t('接管链：VCF 进攻接管（⑫b）与防守接管（⑫c）', async () => {
  const stA = play(gomoku, VCF_SEQ);
  const tacA = tacOf(gomoku, stA);
  ok(tacA.vcf_win_you.indexOf('H7') >= 0, 'vcf_win_you 应含 H7，实际：' + JSON.stringify(tacA.vcf_win_you));
  const dB = await withFetch(repliesWith({ E8: 0.9, H7: 0.05 }),
    () => decide(gomoku, stA, stA.turn, { channel: 'proxy', topK: 1 }));
  ok(dB.notation === 'H7' && dB.meta.tactics === 'vcfAttack',
    'Jev 偏向 E8 也应被 vcfAttack 接管到 H7，实际：' + dB.notation + '/' + dB.meta.tactics);

  const stC = play(gomoku, VCF_SEQ.concat(['O1']));
  eq(stC.turn, 'white', '⑫c 应轮白走');
  /* 旧序守卫钉在 v14（vctFirst 缺省关）：vcfDefense 先开火的历史语义必须继续成立 */
  const tacC = tacOf(gomoku, stC, 'v14-live3-fresh');
  ok(tacC.vcf_win_opponent.indexOf('H7') >= 0, 'vcf_win_opponent 应含 H7 干预点，实际：' + JSON.stringify(tacC.vcf_win_opponent));
  const dC = await withFetch(repliesWith({ A4: 0.9 }), () => decide(gomoku, stC, stC.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v14-live3-fresh' }));
  ok(dC.notation === 'H7' && dC.meta.tactics === 'vcfDefense',
    '白方面对黑 VCF 应提前抢占 H7，实际：' + dC.notation + '/' + dC.meta.tactics);
  /* v14-plus（vctFirst）：vctDefense 找到全拆点时优先、vcfDefense 兜底不开火 */
  const tacC2 = tacOf(gomoku, stC, 'v14-plus');
  ok(tacC2.vct_win_opponent.length >= 1 && tacC2.vcf_win_opponent.length === 0,
    'v14-plus 应由 vctDefense 主防（vct_win_opponent 非空、vcf 兜底不开火），实际：'
      + JSON.stringify(tacC2.vct_win_opponent) + '/' + JSON.stringify(tacC2.vcf_win_opponent));
  const dC2 = await withFetch(repliesWith({ A4: 0.9 }), () => decide(gomoku, stC, stC.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v14-plus' }));
  ok(dC2.notation === tacC2.vct_win_opponent[0] && dC2.meta.tactics === 'vctDefense',
    'v14-plus 应走 vctDefense 的全拆点，实际：' + dC2.notation + '/' + dC2.meta.tactics);
});

/* ------------------------------------------------------------------ *
 * ④b 实战败局回归（旧 test/run-tests.cjs ⑨d/⑨e）
 *
 * 这两局是真实对局里「明明有唯一正确手、Jev 却选了另一手所以输掉」的复现，
 * 断言内容与期望值照抄旧套件，一个数都没改；只按新接口改写调用方式
 * （旧：computeTactics(e, st, e.getLegalMoves(st), 版本表中的档位 id 列表)；
 *   新：tacOf(e, st) —— 内部走同一族的 computeTactics + 档位判定）。
 * 它们守的是战术层的**优先级排序**，不是单个函数：
 *   p20：vcfDefense（抢占对手将死链入口）必须压过 parry3（消三）；
 *   p18：两个 danger 并存时的安全排序（选完还能挡住后续击的才安全）。
 * 旧套件删除后，这两条排序语义就没有别的守卫了。
 * ------------------------------------------------------------------ */
S.t('实战败局：p20 自由手应被 vcfDefense 预占 E6（破黑将死链入口）', async () => {
  const e = gomoku;
  const st9d = play(e, ['H8', 'H7', 'G8', 'I8', 'G6', 'G7', 'I7', 'I6', 'H6', 'G5', 'F7', 'H5', 'G9', 'J6',
    'H9', 'I10', 'I9', 'F9', 'F8']);
  eq(st9d.turn, 'white', 'p20 应轮白走；若这里就红了，说明夹具记法在迁移后失效了');

  /* 旧序守卫钉在 v14（vctFirst 缺省关）——本条守的是「vcfDefense 压过 parry3」的历史排序 */
  const tac9d = tacOf(e, st9d, 'v14-live3-fresh');
  eq(tac9d.danger_points_opponent.length, 0,
    'p20 的 2-ply danger 应为空（败因是 3-ply 深度），实际：' + JSON.stringify(tac9d.danger_points_opponent));
  ok(tac9d.vcf_win_opponent.indexOf('E6') >= 0,
    'p20 黑方 VCF 入口应为 E6，实际：' + JSON.stringify(tac9d.vcf_win_opponent));

  const d9d = await withFetch(repliesWith({ E6: 0.9 }), () => decide(e, st9d, st9d.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v14-live3-fresh' }));
  ok(d9d.notation === 'E6' && d9d.meta.tactics === 'vcfDefense',
    'p20 自由手应被 vcfDefense 预占 E6（破黑将死链入口），实际：' + d9d.notation + '/' + d9d.meta.tactics);
  /* v14-plus（vctFirst）：同位置主防线换成 vctDefense 的全拆点（若存在），兜底语义不变 */
  const tac9dP = tacOf(e, st9d, 'v14-plus');
  ok(tac9dP.vct_win_opponent.length >= 1 ? tac9dP.vcf_win_opponent.length === 0 : tac9dP.vcf_win_opponent.indexOf('E6') >= 0,
    'v14-plus 要么 vctDefense 主防（vcf 兜底不开火）、要么无全拆点时回退 vcfDefense 的 E6，实际：'
      + JSON.stringify(tac9dP.vct_win_opponent) + '/' + JSON.stringify(tac9dP.vcf_win_opponent));
});

S.t('实战败局：p18 双 danger 并存应安全排序选 E9（Jev 偏向 I9 也应纠正）', async () => {
  const e = gomoku;
  const st9e = play(e, ['H8', 'H7', 'G8', 'I8', 'H9', 'F7', 'G9', 'G7', 'I7', 'J6', 'F10', 'E11', 'G10', 'H10',
    'G11', 'G12', 'F9']);
  eq(st9e.turn, 'white', 'p18 应轮白走；若这里就红了，说明夹具记法在迁移后失效了');

  const tac9e = tacOf(e, st9e);
  ok(tac9e.danger_points_opponent.indexOf('I9') >= 0 && tac9e.danger_points_opponent.indexOf('E9') >= 0,
    'p18 danger 应含 I9,E9，实际：' + JSON.stringify(tac9e.danger_points_opponent));

  const d9e = await withFetch(repliesWith({ I9: 0.9, E9: 0.1 }), () => decide(e, st9e, st9e.turn, { channel: 'proxy', topK: 1 }));
  ok(d9e.notation === 'E9' && d9e.meta.tactics === 'parry',
    'p18 双 danger 并存应安全排序选 E9（Jev 偏向 I9 也应纠正），实际：' + d9e.notation + '/' + d9e.meta.tactics);
});

S.t('接管链：⑫e 实战局面 p34 纠正到 I14', async () => {
  const st = play(gomoku, ['H8', 'G7', 'H7', 'H6', 'F8', 'G8', 'G6', 'I8', 'F7', 'H5', 'F9', 'F6', 'G5', 'G9', 'G10',
    'E8', 'H11', 'H10', 'I12', 'J13', 'F11', 'F10', 'G12', 'G11', 'H13', 'E10', 'G14', 'J11', 'E9', 'I10',
    'I9', 'H12', 'J14']);
  eq(st.turn, 'white', '⑫e 应轮白走');
  const tac = tacOf(gomoku, st, 'v14-live3-fresh');
  ok(tac.vcf_win_opponent.indexOf('I14') >= 0, 'vcf_win_opponent 应含 I14，实际：' + JSON.stringify(tac.vcf_win_opponent));
  const d = await withFetch(repliesWith({ E12: 0.9, I14: 0.05 }), () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v14-live3-fresh' }));
  ok(d.notation === 'I14' && d.meta.tactics === 'vcfDefense',
    'p34 实战 E12 没破杀，应被 vcfDefense 纠正到 I14，实际：' + d.notation + '/' + d.meta.tactics);
  /* v14-plus（vctFirst）：同位置主防线为 vctDefense（全拆点），兜底语义不变 */
  const tacP = tacOf(gomoku, st, 'v14-plus');
  ok(tacP.vct_win_opponent.length >= 1 ? tacP.vcf_win_opponent.length === 0 : tacP.vcf_win_opponent.indexOf('I14') >= 0,
    'v14-plus 要么 vctDefense 主防（vcf 兜底不开火）、要么无全拆点时回退 vcfDefense 的 I14，实际：'
      + JSON.stringify(tacP.vct_win_opponent) + '/' + JSON.stringify(tacP.vcf_win_opponent));
  const dP34 = await withFetch(repliesWith({ E12: 0.9, I14: 0.05 }), () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v14-plus' }));
  ok(dP34.notation === (tacP.vct_win_opponent[0] ?? 'I14') && (tacP.vct_win_opponent.length ? dP34.meta.tactics === 'vctDefense' : dP34.meta.tactics === 'vcfDefense'),
    'v14-plus 应走主防线的点，实际：' + dP34.notation + '/' + dP34.meta.tactics);
});

/* ------------------------------------------------------------------ *
 * ⑤ 版本闸门（同一局面按档给出不同事实/接管行为，⑬a–⑬g）
 * ------------------------------------------------------------------ */
S.t('版本闸门：v0-off 全空（含 win/block），且缓存按版本分键', () => {
  const stx = play(gomoku, ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5']);
  const v9 = tacOf(gomoku, stx);
  ok(v9.winning_points_you.length > 0, '当前档应有致胜点（前置条件）');
  const v0 = tacOf(gomoku, stx, 'v0-off');
  ok(Object.keys(v0).every((k) => (Array.isArray(v0[k]) ? v0[k].length === 0 : v0[k] === 0)),
    'v0-off 应无任何战术（含 win/block 与 v13 的压力计数），实际：' + JSON.stringify(v0));
});

S.t('版本闸门：v2 无 2-ply、v3 有造杀点', () => {
  const st9b = play(gomoku, ['F7', 'A1', 'F8', 'B2', 'F9', 'C3']);
  const crit = critOf(gomoku, st9b);
  const v2 = computeTactics(gomoku, st9b, gomoku.getLegalMoves(st9b), crit, 'v2-open4');
  ok(v2.chance_points_you.length === 0 && v2.danger_points_opponent.length === 0,
    'v2-open4 未实现 2-ply，造杀/拆杀必须为空，实际：' + JSON.stringify(v2));
  const v3 = computeTactics(gomoku, st9b, gomoku.getLegalMoves(st9b), crit, 'v3-make2');
  ok(v3.chance_points_you.indexOf('F6') >= 0 && v3.chance_points_you.indexOf('F10') >= 0,
    'v3-make2 应认出黑活三的造杀点 F6/F10，实际：' + JSON.stringify(v3.chance_points_you));
});

S.t('版本闸门：v1 不接管活四点、v2 接管', async () => {
  const st = play(gomoku, SWAP_SEQ);
  const d1 = await withFetch(repliesWith({ G6: 0.9 }),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v1-facts' }));
  ok(d1.meta.tactics !== 'open4' && d1.meta.tacticsVersion === 'v1-facts',
    'v1-facts 无 open4 层，不应接管到活四点，实际：' + d1.notation + '/' + d1.meta.tactics);
  const d2 = await withFetch(repliesWith({ G6: 0.9 }),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v2-open4' }));
  ok(d2.meta.tactics === 'open4' && (d2.notation === 'E8' || d2.notation === 'I8'),
    'v2-open4 应接管到活四点，实际：' + d2.notation + '/' + d2.meta.tactics);
});

S.t('版本闸门：vcfTry 边界（v7 只试链首 → 放弃；v8 逐点试 → 采用）', () => {
  const st12h = play(gomoku, ['H8', 'H7', 'E11', 'H9', 'B14', 'H10', 'A14', 'H11', 'C15', 'H12',
    'H13', 'I13', 'G11', 'I11', 'D12', 'F10', 'D14']);
  eq(st12h.turn, 'white', '⑫h 应轮白走');
  const crit = critOf(gomoku, st12h);
  const legal = gomoku.getLegalMoves(st12h);
  const tacAny = computeTactics(gomoku, st12h, legal, crit);
  ok(tacAny.vcf_win_opponent.length > 0,
    'vcf_win_opponent 不应为空（链上多点可破杀），实际：' + JSON.stringify(tacAny.vcf_win_opponent));
  const v7 = computeTactics(gomoku, st12h, legal, crit, 'v7-vcf');
  ok(v7.vcf_win_opponent.length === 0,
    'v7-vcf 只试链首仍被杀时应放弃 vcfDefense，实际：' + JSON.stringify(v7.vcf_win_opponent));
  const v8 = computeTactics(gomoku, st12h, legal, crit, 'v8-vcf-try');
  eq(v8.vcf_win_opponent.length, 1, 'v8-vcf-try 逐点试应恰好采用一个破杀点，实际：' + JSON.stringify(v8.vcf_win_opponent));
});

S.t('版本闸门：决策级 v8 接管 / v7 不接管 / 缺省与未知收敛当前档', async () => {
  const st12h = play(gomoku, ['H8', 'H7', 'E11', 'H9', 'B14', 'H10', 'A14', 'H11', 'C15', 'H12',
    'H13', 'I13', 'G11', 'I11', 'D12', 'F10', 'D14']);
  const probs = { D13: 0.9, E13: 0.05 };
  const d8 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st12h, st12h.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v8-vcf-try' }));
  ok(d8.meta.tactics === 'vcfDefense' && d8.meta.tacticsVersion === 'v8-vcf-try',
    'v8 下应接管 vcfDefense 且 meta.tacticsVersion 记录版本，实际：' + d8.meta.tactics + '/' + d8.meta.tacticsVersion);
  const d7 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st12h, st12h.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v7-vcf' }));
  ok(d7.meta.tactics !== 'vcfDefense' && d7.meta.tacticsVersion === 'v7-vcf',
    'v7 下 vcfDefense 为空不得接管（可回落其它层），实际：' + d7.meta.tactics + '/' + d7.meta.tacticsVersion);
  /* 缺省 id 收敛到当前档；**未知 id 收敛到 v0-off（空机制集）**，绝不回落全开（P0/D2） */
  const stx = play(gomoku, ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5']);
  const crit = critOf(gomoku, stx);
  const legal = gomoku.getLegalMoves(stx);
  const cur = computeTactics(gomoku, stx, legal, crit, R.CURRENT);
  const def = computeTactics(gomoku, stx, legal, crit);
  const off = computeTactics(gomoku, stx, legal, crit, 'v0-off');
  const bogus = computeTactics(gomoku, stx, legal, crit, 'v99-nope');
  eq(JSON.stringify(def), JSON.stringify(cur), '缺省 tacticsVersion 必须按当前档跑（' + R.CURRENT + '）');
  ok(JSON.stringify(off) !== JSON.stringify(cur), 'v0-off 与当前档的输出应有差异（否则下一条断言没有区分力）');
  eq(JSON.stringify(bogus), JSON.stringify(off), '未知 tacticsVersion 必须收敛到 v0-off（空机制集），不得回落全开');
});

/* ------------------------------------------------------------------ *
 * ⑤b v10 活三（4-ply 真推演）
 *
 * 定义阶梯（与 labelPoint 的 fiveCompletions 同一把尺）：
 *   L1 五点 = 落子即五连；
 *   L2 活四制造点 = 落子后 ≥2 个五点（2 手内必胜，= you:open4 / chance / danger）；
 *   L3 活三制造点 = 落子后 ≥2 个 L2（4 手内必胜，对手只能挡一个）。
 *
 * 依据 2026-09-30 rapfi 归档 27 局复盘：27/27 局都出现对手能造活三，proxy 拆 13 漏 14；
 * 漏的 12 局是 proxy 执白在 ply#6 放行黑方反对角线上的**带空隙的四**（F10/D12）。
 * v9 的 parry3 靠模型返回的 deny:live3 标签，而 labelPoint 只认连续 `_XXX_`，
 * 跳活三 / 斜线组合 / 带空隙的四一律打不出标签 —— 本层是真推演，不看标签。
 * ------------------------------------------------------------------ */
/* 归档 games/2026-09-30/gomoku-20260930025710.json 前 5 手，轮白 */
const L3_SEQ = ['H8', 'H7', 'E11', 'H9', 'B14'];
/* 同形三子换成白方（黑方四角散点，互不成线）→ 轮白抢攻 */
const L3_ATK_SEQ = ['A1', 'H8', 'O1', 'E11', 'A15', 'B14', 'O15'];

S.t('v10 活三：引擎层真推演（归档 ply#6 局面）', () => {
  const st = play(gomoku, L3_SEQ);
  eq(st.turn, 'white', 'ply#6 应轮白走；若这里就红了，说明夹具记法失效');
  deepEq(gomoku.live3Makers(st, 'black'), ['F10', 'D12'],
    '黑方活三制造点应为 F10/D12，实际：' + JSON.stringify(gomoku.live3Makers(st, 'black')));
  deepEq(gomoku.live3Makers(st, 'white'), [], '白方此时没有活三制造点');
  const deny = gomoku.live3Deny(st, 'white', gomoku.getLegalMoves(st).map((m) => m.notation));
  eq(deny.before, 2, '拆之前黑方应有 2 个活三制造点');
  eq(deny.after, 0, '拆点应把黑方活三制造点清零');
  deepEq(deny.best, ['F10'], '并列最优点应为 F10');
  /* v9 盲区证据：这条线上的四点一个标签都没有，parry3 因此打不出来 */
  const crit = gomoku.serializeForJev(st, 'white').questions.move.criteria;
  for (const n of ['C13', 'D12', 'F10', 'G9']) {
    eq(crit[n], null, n + ' 不该有标签（v9 就靠这个标签，实际：' + crit[n] + '）');
  }
});

S.t('v10 活三：战术事实按档给（v9 三个字段全空 / v10 报出对手点与拆点）', () => {
  const st = play(gomoku, L3_SEQ);
  const v9 = tacOf(gomoku, st, 'v9-vcf-sound');
  deepEq(v9.live3_opponent, [], 'v9 不应有 4-ply 事实');
  deepEq(v9.live3_deny_points, [], 'v9 不应有 4-ply 事实');
  deepEq(v9.live3_you, [], 'v9 不应有 4-ply 事实');
  const v10 = tacOf(gomoku, st, 'v10-live3');
  deepEq(v10.live3_opponent, ['F10', 'D12'], 'v10 应报出对手活三制造点');
  deepEq(v10.live3_deny_points, ['F10'], 'v10 应给出拆点');
  deepEq(v10.live3_you, [], '白方自己没有活三制造点');
  eq(v10.danger_points_opponent.length, 0, '该局面没有 2-ply danger（v9 的 parry 层因此也不触发）');
});

S.t('v10 活三：决策级拆活三（live3Defense 纠正静点偏好，v9 不接管）', async () => {
  const st = play(gomoku, L3_SEQ);
  const probs = { J10: 0.9, F10: 0.05 };
  const d10 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v10-live3' }));
  ok(d10.notation === 'F10' && d10.meta.tactics === 'live3Defense',
    'v10 应被 live3Defense 接管走 F10，实际：' + d10.notation + '/' + d10.meta.tactics);
  ok(d10.meta.tacticsVersion === 'v10-live3', 'meta.tacticsVersion 应记录 v10-live3，实际：' + d10.meta.tacticsVersion);
  const d9 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v9-vcf-sound' }));
  ok(d9.meta.tactics !== 'live3Defense', 'v9 不该有这一层，实际：' + d9.notation + '/' + d9.meta.tactics);
  eq(d9.notation, 'J10', 'v9 档下应原样走模型偏好（这正是 9/30 的输法）');
});

S.t('v10 活三：决策级抢活三（live3Attack 抢占 4 手必杀点）', async () => {
  const st = play(gomoku, L3_ATK_SEQ);
  eq(st.turn, 'white', '抢攻夹具应轮白走');
  deepEq(gomoku.live3Makers(st, 'white'), ['F10'],
    '白方活三制造点应为 F10，实际：' + JSON.stringify(gomoku.live3Makers(st, 'white')));
  const probs = { H1: 0.9 };
  const d10 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v10-live3' }));
  ok(d10.notation === 'F10' && d10.meta.tactics === 'live3Attack',
    'v10 应被 live3Attack 接管走 F10，实际：' + d10.notation + '/' + d10.meta.tactics);
  const d9 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v9-vcf-sound' }));
  ok(d9.meta.tactics !== 'live3Attack' && d9.notation === 'H1',
    'v9 不该有这一层，实际：' + d9.notation + '/' + d9.meta.tactics);
});

S.t('v10 活三：抢攻层让位给更短的杀（对手 2 手杀优先）', async () => {
  /* 黑方散点恰好自己摆出 D1 的活四制造点：白方虽有活三制造点，但 4 手剑比对手的 2 手剑慢 */
  const st = play(gomoku, ['A1', 'H8', 'C1', 'E11', 'E1', 'B14', 'G1']);
  const tac = tacOf(gomoku, st, 'v10-live3');
  ok(tac.live3_you.length > 0, '夹具前提：白方应有活三制造点，实际：' + JSON.stringify(tac.live3_you));
  ok(tac.danger_points_opponent.length > 0,
    '夹具前提：黑方应有 2 手杀，实际：' + JSON.stringify(tac.danger_points_opponent));
  const d = await withFetch(repliesWith({ J10: 0.9 }),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v10-live3' }));
  ok(d.meta.tactics !== 'live3Attack', '对手有 2 手杀时不该抢 4 手剑，实际：' + d.notation + '/' + d.meta.tactics);
  eq(d.notation, 'D1', '应走 vcfDefense/parry 的 D1，实际：' + d.notation + '/' + d.meta.tactics);
});

/* ------------------------------------------------------------------ *
 * ⑤c v11 VCT（连续威胁搜索：冲四链 + 活三逼迫）
 *
 * 依据（v10 对照实验 12 局逐手离线复算，独立实现交叉核对）：
 *   7-ply 纯冲四有杀 22 手、11-ply 补出 2 手，而 VCT 42 手；**只有 VCT 看得见的 20 手
 *   分布在 7 局**，其中 18 手连 11 ply 纯冲四也看不见 —— 当时走的几乎全是启发式
 *   live3Attack 点（2 局因此和棋、1 局负）。夹具即其中一手。
 *
 * 夹具 = 归档局 cf3d85f9-6962-411a-958d-086eda0ebe09（v10 臂，proxy 执黑 vs rapfi@500ms，
 * 31 手黑胜）前 20 手，轮黑走：第 21 手实走 K7/live3Attack，而 VCT 的必胜链首步是 L4。
 * ------------------------------------------------------------------ */
const VCT_SEQ = ['H8', 'E11', 'G8', 'B14', 'F8', 'E8', 'J8', 'I8', 'I7', 'A15',
  'K9', 'H6', 'J6', 'G9', 'J7', 'J5', 'H7', 'D12', 'C13', 'G7'];

/**
 * 邻域（切比雪夫 ≤2）内的合法着法：防守方「有意义的」应手集合。
 * 用着法自带的 r/c（别从记法里反解：记法是「列字母 + 行号」，反解容易把行列写反）。
 * 引擎内部的 VCT 已经是**全盘**枚举应手，这里只是抽样子集，成本低。
 */
function nearReplies(e, st) {
  const b = st.board, N = b.length;
  return e.getLegalMoves(st).filter((m) => {
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const rr = m.r + dr, cc = m.c + dc;
      if (rr >= 0 && rr < N && cc >= 0 && cc < N && b[rr][cc] !== 0) return true;
    }
    return false;
  });
}

S.t('v11 VCT：引擎层连续威胁搜索（纯冲四看不见，加深度也补不出来）', () => {
  const st = play(gomoku, VCT_SEQ);
  eq(st.turn, 'black', '夹具应轮黑走；若这里就红了，说明夹具记法失效');
  ok(!gomoku.vcfWin(st, 'black', 7).win, '7-ply 纯冲四不该有杀（这正是 v10 的盲区）');
  ok(!gomoku.vcfWin(st, 'black', 11).win, '11-ply 纯冲四也不该有杀（必须换机制，不是加深度）');
  const vct = gomoku.vctWin(st, 'black', 9);
  ok(vct.win, 'VCT 应找到必胜链');
  eq(vct.first, 'L4', 'VCT 必胜链首步应为 L4（实走 K7 是启发式活三点）');
  eq(vct.line.length, 5, '链长应为 5 手攻方着法，实际：' + vct.line.join('>'));
});

S.t('v11 VCT：链首是强制手（白方任一近邻应手都仍在杀里）', () => {
  const st = play(gomoku, VCT_SEQ);
  const first = gomoku.vctWin(st, 'black', 9).first;
  const stA = gomoku.applyMove(st, gomoku.moveFromNotation(st, first));
  const replies = nearReplies(gomoku, stA);
  ok(replies.length >= 50, '夹具前提：邻域应手应足够多，实际 ' + replies.length);
  const fails = [];
  for (const m of replies) {
    const r = gomoku.vctWin(gomoku.applyMove(stA, m), 'black', 7);
    if (!r.win) fails.push(m.notation);
  }
  eq(fails.length, 0, '黑走 ' + first + ' 后白方任一近邻应手都该还在杀里，守住的应手：' + fails.join(','));
});

S.t('v11 VCT：战术事实按档给（v10 只有启发式活三点，v11 报出必胜链首步）', () => {
  const st = play(gomoku, VCT_SEQ);
  const v10 = tacOf(gomoku, st, 'v10-live3');
  deepEq(v10.vct_win_you, [], 'v10 不应有 VCT 层');
  deepEq(v10.live3_you, ['K7', 'M11'], 'v10 只有启发式活三点（K7 正是实走的那手）');
  const v11 = tacOf(gomoku, st, 'v11-vct');
  deepEq(v11.vct_win_you, ['L4'], 'v11 应报出必胜链首步 L4');
  deepEq(v11.live3_you, ['K7', 'M11'], 'v11 仍保留 v10 的活三点事实（机制单调不减）');
  eq(v11.vcf_win_you.length, 0, '该局面纯 VCF 无解（VCT 补的就是这一格）');
});

S.t('v11 VCT：决策级抢链首（v10 被 live3Attack 带偏到 K7，v11 走 L4）', async () => {
  const st = play(gomoku, VCT_SEQ);
  const probs = { K7: 0.9, L4: 0.02 };   /* 模型偏好正是实走的那手 K7 */
  const d11 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v11-vct' }));
  ok(d11.notation === 'L4' && d11.meta.tactics === 'vctAttack',
    'v11 应被 vctAttack 接管走 L4，实际：' + d11.notation + '/' + d11.meta.tactics);
  eq(d11.meta.tacticsVersion, 'v11-vct', 'meta.tacticsVersion 应记录 v11-vct');
  const d10 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v10-live3' }));
  ok(d10.notation === 'K7' && d10.meta.tactics === 'live3Attack',
    'v10 档应照旧走启发式活三点 K7（这就是漏掉必胜链的那一手），实际：' + d10.notation + '/' + d10.meta.tactics);
});

/* ------------------------------------------------------------------ *
 * ⑤d v12 拆连续威胁链（`vctDefense`：对手把链换成混合链，vcfDefense 就放行）
 *
 * 依据（两轮 v11 vs `rapfi@500ms` 共 48 个「我方无杀而对手有链」的回合，逐手离线复算）：
 *   实走拆掉 33 个、漏 15 个；漏的 15 个里只有 **2 个存在能拆的点却没走** —— 夹具即其一，
 *   另一个是首轮 `#6` ply52 → K8（实走 G10/parry）。四种候选生成策略对照后取
 *   「链上各点 → 链点车氏 ≤2 邻域 → 全部邻近空点（按到链距离升序）」、上限 12 个。
 *
 * 夹具 = 归档局 f463acff-b01c-4ef6-815f-b4b607d8fb94（计时轮 tag exp-20261002094817，
 *   rapfi 执黑 vs proxy/v11 执白，27 手黑胜）前 23 手，轮白走：第 24 手实走 I11/parry ——
 *   对手的 VCF 链首正是 I11，**占掉它却没有拆掉整条链**（黑方仍有杀），而 K9 才是真拆点。
 * ------------------------------------------------------------------ */
const DEF_SEQ = ['H8', 'H7', 'E11', 'H6', 'B14', 'F10', 'A15', 'C13', 'F15', 'H9',
  'G15', 'E15', 'J12', 'H11', 'L12', 'K12', 'I13', 'K11', 'L13', 'K10', 'K13', 'J13', 'L14'];

S.t('v12 拆链：引擎层 vctDefense（对手链首挡不住，链点邻域里的 K9 才拆得掉）', () => {
  const st = play(gomoku, DEF_SEQ);
  eq(st.turn, 'white', '夹具应轮白走；若这里就红了，说明夹具记法失效');
  const opp = gomoku.vcfWin(st, 'black', 7);
  ok(opp.win, '对手（黑）当下就该有必胜链（夹具前提）');
  eq(opp.first, 'I11', '对手链首应为 I11（实走的那一手）');
  const def = gomoku.vctDefense(st, 'white', 9);
  ok(def.points.indexOf('K9') >= 0, '拆点应含 K9，实际：' + JSON.stringify(def.points));
  eq(def.chain[0], 'I11', '返回的链首应是对手链首 I11');
  ok(def.tried <= 12, '候选点上限 12（VCT_DEF_MAX），实际试了 ' + def.tried);
  /* 反例：占掉对手链首不是拆 —— 这正是 vcfDefense 之外还要 vctDefense 的原因 */
  const stI = gomoku.applyMove(st, gomoku.moveFromNotation(st, 'I11'));
  ok(gomoku.vcfWin(stI, 'black', 7).win, '只占链首 I11 之后对手仍应有杀（实走那手的缺陷）');
});

S.t('v12 拆链：拆点必须真拆（走后对手既无 VCF 也无 VCT）', () => {
  const st = play(gomoku, DEF_SEQ);
  const def = gomoku.vctDefense(st, 'white', 9);
  ok(def.points.length >= 1, '夹具前提：应至少有一个拆点');
  const bad = [];
  for (const p of def.points) {
    const stA = gomoku.applyMove(st, gomoku.moveFromNotation(st, p));
    if (gomoku.vcfWin(stA, 'black', 7).win || gomoku.vctWin(stA, 'black', 9).win) bad.push(p);
  }
  eq(bad.length, 0, '拆点走后对手不该再有任何连续威胁链，漏掉的：' + bad.join(','));
});

S.t('v12 拆链：战术事实按档给（v11 只有 parry 层的拆杀点，v12 报出真拆点）', () => {
  const st = play(gomoku, DEF_SEQ);
  const v11 = tacOf(gomoku, st, 'v11-vct');
  deepEq(v11.vct_win_opponent, [], 'v11 不应有 vctDefense 层');
  deepEq(v11.vcf_win_opponent, [], 'v11 的 vcfDefense 在该局面找不到拆点（放行的就是这一格）');
  ok(v11.danger_points_opponent.indexOf('I11') >= 0, 'v11 只把 I11 当普通拆杀点（parry）');
  const v12 = tacOf(gomoku, st, 'v12-vct-def');
  deepEq(v12.vct_win_opponent, ['K9'], 'v12 应报出真拆点 K9');
  deepEq(v12.vct_chain_opponent, ['I11'], 'v12 应同时报出对手那条链');
  deepEq(v12.live3_you, v11.live3_you, 'v12 仍保留 v10/v11 的全部事实（机制单调不减）');
});

S.t('v12 拆链：决策级接管（v11 走链首 I11/parry，v12 走真拆点 K9/vctDefense）', async () => {
  const st = play(gomoku, DEF_SEQ);
  const probs = { I11: 0.6, K9: 0.05 };   /* 模型偏好正是实走的那手 I11 */
  const d12 = await withFetch(repliesWith(probs), () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v12-vct-def' }));
  ok(d12.notation === 'K9' && d12.meta.tactics === 'vctDefense',
    'v12 应被 vctDefense 接管走 K9，实际：' + d12.notation + '/' + d12.meta.tactics);
  eq(d12.meta.tacticsVersion, 'v12-vct-def', 'meta.tacticsVersion 应记录 v12-vct-def');
  const d11 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v11-vct' }));
  ok(d11.notation === 'I11' && d11.meta.tactics === 'parry',
    'v11 档应照旧走链首 I11/parry（这就是放行对手的那一手），实际：' + d11.notation + '/' + d11.meta.tactics);
  /* v14-plus（vctDefMax 12→8）：K9 必须仍在收紧后的候选预算内被找到 —— 预算减法不该伤到已知可救点 */
  const dP = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v14-plus' }));
  ok(dP.notation === 'K9' && dP.meta.tactics === 'vctDefense',
    'v14-plus 在该夹具仍应被 vctDefense 接管走 K9，实际：' + dP.notation + '/' + dP.meta.tactics);
});

/* ------------------------------------------------------------------ *
 * ⑤e v14-plus 防线优先级纠偏（vctFirst）：真局夹具
 *    取自 vorder1 v13-vs-v14 的两局败局（.work/v14loss-probe.mjs 逐手探针实锤）：
 *    vcfDefense（只验纯冲四，判据弱）排在 vctDefense（拆完对手 VCF+VCT 全无，判据强）之前，
 *    「纯四可拆、混合链也能一并拆」的局面永远走弱防线 → 对手活三逼迫链残留 → 两手内必败。
 * ------------------------------------------------------------------ */
S.t('v14-plus 防线纠偏：真局 29ced20c ply65 —— v14 走 I10/vcfDefense（纯四拆、VCT 残留），v14-plus 走 K10/vctDefense（全拆）', async () => {
  /* vorder1 exp-20261004133730 局 29ced20c 的前 64 手（ply65 轮 v14 执黑；实走 I10 后 ply67 起全盘无拆点、ply69 成必败） */
  const SEQ64 = ['H8', 'H7', 'H6', 'G7', 'F7', 'G6', 'G5', 'F5', 'E4', 'F4', 'I8', 'G8', 'G9', 'I6', 'J5', 'I7', 'J7', 'K6', 'F9', 'H9', 'J6', 'J4', 'F3', 'J8', 'D5', 'G2', 'F8', 'F10', 'E7', 'D6', 'F6', 'H4', 'C9', 'D8', 'B7', 'C6', 'C7', 'D7', 'G4', 'E9', 'D9', 'C8', 'E6', 'E5', 'G3', 'H10', 'G11', 'B3', 'H3', 'E3', 'G10', 'I3', 'K5', 'H5', 'I4', 'G12', 'H11', 'I12', 'I11', 'F11', 'H12', 'J11', 'K9', 'J10'];
  const st = play(gomoku, SEQ64);
  const t14 = tacOf(gomoku, st, 'v14-live3-fresh');
  deepEq(t14.vcf_win_opponent, ['I10'], 'v14 应由 vcfDefense 给出只拆纯四的 I10（旧序：判据弱的先开火）');
  deepEq(t14.vct_win_opponent, [], 'v14 的 vctDefense 被「vcfDefense 没找到点」门住——全拆点 K10 对它不可见');
  const tP = tacOf(gomoku, st, 'v14-plus');
  deepEq(tP.vct_win_opponent, ['K10'], 'v14-plus（vctFirst）应由 vctDefense 给出全拆点 K10');
  deepEq(tP.vcf_win_opponent, [], 'v14-plus 的 vcfDefense 是兜底：vctDefense 有点时不应开火');
  /* 决策级：模型偏好恰是旧的弱防点，vctFirst 也要纠过来 */
  const probs = { I10: 0.6, K10: 0.05 };
  const d14 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v14-live3-fresh' }));
  ok(d14.notation === 'I10' && d14.meta.tactics === 'vcfDefense',
    'v14 应照旧走 I10/vcfDefense，实际：' + d14.notation + '/' + d14.meta.tactics);
  const dPP = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v14-plus' }));
  ok(dPP.notation === 'K10' && dPP.meta.tactics === 'vctDefense',
    'v14-plus 应走 K10/vctDefense，实际：' + dPP.notation + '/' + dPP.meta.tactics);
});

S.t('v14-plus 防线纠偏：真局 3ba614a0 ply24 —— 单点纯四链 G8（v14）vs 全拆点 E6（v14-plus）', () => {
  /* vorder1 局 3ba614a0 的前 23 手（ply24 轮 v14 执白；实走 G8 后 ply26 起全盘无拆点、ply32 成必败） */
  const SEQ23 = ['H8', 'H7', 'H6', 'G6', 'F5', 'G7', 'F7', 'G5', 'G4', 'H3', 'G9', 'I7', 'J7', 'F6', 'H4', 'F4', 'H9', 'I8', 'J9', 'I9', 'I6', 'H5', 'I10'];
  const st = play(gomoku, SEQ23);
  const t14 = tacOf(gomoku, st, 'v14-live3-fresh');
  deepEq(t14.vcf_win_opponent, ['G8'], 'v14 走 G8（拆纯四，对手 VCT 残留）');
  const tP = tacOf(gomoku, st, 'v14-plus');
  deepEq(tP.vct_win_opponent, ['E6'], 'v14-plus 走 E6（连混合链一起拆）');
  deepEq(tP.vcf_win_opponent, [], '兜底不开火');
});

S.t('v12 拆链：我方有必胜链时不进防守层（闸门：先赢再说）', () => {
  const stVcf = play(gomoku, VCF_SEQ);
  const t = tacOf(gomoku, stVcf);   /* 缺省 = 当前档 v12 */
  ok(t.vcf_win_you.length >= 1, '该局面我方应有 VCF 必胜链（夹具前提）');
  deepEq(t.vct_win_opponent, [], '我方有必胜链时不该再去算对手的链（白算一遍的成本）');
  deepEq(t.vct_chain_opponent, [], '同上：链也不该报');
});

/* ------------------------------------------------------------------ *
 * ⑤e v13 压力闸门（`pressureGate`：对手的做四点已经超过我们时，先削掉他的做四点）
 *
 * 依据（六轮 rapfi 对照共 1787 个 Jev 回合逐手离线复算）：`live3Attack` 实走 205 手（11.5%），
 *   其中 39 手落子前对手「做四手数」已超过我们；改用「贴着对手做四点削」的点集，
 *   37/39 能把对手做四手数压低（平均 −1.87 个），双四威胁 37 手 → 7 手，0 手更差。
 *   语义依据：ADR-0015 已修正「活三＝4 手内必胜」的旧口径（活三只是逼手），真强制胜由
 *   vcf/vct 层先接管 ⇒ 让位给削点漏杀风险为零。
 *
 * 夹具 = 归档局 e3e417e6-1f3c-4f52-baa3-3234ddd0159c（v12 单臂 tag exp-20261002115126，
 *   rapfi 执黑 vs proxy/v12 执白，白方五连胜）前 7 手，轮白走：第 8 手实走 E9/live3Attack，
 *   当时对手（黑）已有 2 个做四点、我们 0 个；v13 改走 D12（把对手压到 0）。
 *   ⚠️ 这是**有代价**的一手：走 E9 我们自己的做四手数是 4，走 D12 是 0 —— 用攻势换安全，
 *   实测代价见 plan v13 §6 与 ADR-0017 的「代价」条目。
 * ------------------------------------------------------------------ */
const P13_SEQ = ['H8', 'G7', 'E11', 'G11', 'B14', 'F10', 'A15'];

S.t('v13 削点：引擎层 pressureCut（贴着对手做四点找点，且走后对手手数真的降）', () => {
  const st = play(gomoku, P13_SEQ);
  eq(st.turn, 'white', '夹具应轮白走；若这里就红了，说明夹具记法失效');
  eq(gomoku.fourPressure(st, 'white'), 0, '夹具前提：我们（白）当下没有做四点');
  eq(gomoku.fourPressure(st, 'black'), 2, '夹具前提：对手（黑）当下有 2 个做四点');
  const cut = gomoku.pressureCut(st, 'white', { cands: [] });
  ok(cut.points.indexOf('D12') >= 0, '削点应含 D12，实际：' + JSON.stringify(cut.points));
  eq(cut.before.opponent, 2, '落子前对手做四手数应为 2');
  eq(cut.after.opponent, 0, '削点走后对手做四手数应降到 0');
  const after = gomoku.applyMove(st, gomoku.moveFromNotation(st, cut.points[0]));
  eq(gomoku.fourPressure(after, 'black'), cut.after.opponent, 'after.opponent 必须与真落子后的对手手数一致');
  ok(cut.tried <= 120, '候选上限 120（PRESSURE_CUT_MAX），实际试了 ' + cut.tried);
  /* 反例：实走的那一手 E9 没削到对手（对手仍是 2），反而是自己涨到 4 —— 这正是闸门存在的理由 */
  const stE9 = gomoku.applyMove(st, gomoku.moveFromNotation(st, 'E9'));
  eq(gomoku.fourPressure(stE9, 'black'), 2, '实走 E9 之后对手做四手数不变（没削到）');
});

S.t('v13 削点：不是压力落后就不给削点（闸门只在落后时开火）', () => {
  /* 同一局面换到前 6 手（轮黑）：黑 2 个做四点、白 0 个 ⇒ 对黑而言「不落后」，不该报削点 */
  const st = play(gomoku, P13_SEQ.slice(0, 6));
  eq(st.turn, 'black', '前 6 手后应轮黑走');
  const t = tacOf(gomoku, st, 'v13-pressure-gate');
  ok(t.pressure_you >= t.pressure_opponent, '夹具前提：黑（走子方）当下不落后，实际 ' + t.pressure_you + '/' + t.pressure_opponent);
  deepEq(t.pressure_cut_points, [], '不落后时不该算削点（省成本，也避免无谓让攻势）');
});

S.t('v13 削点：战术事实按档给（v12 只会抢活三，v13 报出削点）', () => {
  const st = play(gomoku, P13_SEQ);
  const v12 = tacOf(gomoku, st, 'v12-vct-def');
  deepEq(v12.pressure_cut_points, [], 'v12 不该有 pressureGate 层');
  ok(v12.live3_you.length >= 1, 'v12 在该局面本来要抢活三，实际：' + JSON.stringify(v12.live3_you));
  const v13 = tacOf(gomoku, st, 'v13-pressure-gate');
  eq(v13.pressure_you, 0, 'v13 应报出我方做四手数 0');
  eq(v13.pressure_opponent, 2, 'v13 应报出对手做四手数 2');
  deepEq(v13.pressure_cut_points, ['D12', 'C13'], 'v13 应报出削点 D12/C13');
  deepEq(v13.live3_you, v12.live3_you, 'v13 仍保留 v10/v11 的全部事实（机制单调不减）');
});

S.t('v13 削点：决策级接管（v12 走活三 E9/live3Attack，v13 走削点 D12/pressureGate）', async () => {
  const st = play(gomoku, P13_SEQ);
  const probs = { E9: 0.6, H12: 0.2, D12: 0.05 };   /* 模型偏好正是实走的 E9 */
  const d13 = await withFetch(repliesWith(probs), () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v13-pressure-gate' }));
  ok(d13.notation === 'D12' && d13.meta.tactics === 'pressureGate',
    'v13 应被 pressureGate 接管走 D12，实际：' + d13.notation + '/' + d13.meta.tactics);
  eq(d13.meta.tacticsVersion, 'v13-pressure-gate', 'meta.tacticsVersion 应记录 v13-pressure-gate');
  const d12 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v12-vct-def' }));
  ok(d12.notation === 'E9' && d12.meta.tactics === 'live3Attack',
    'v12 档应照旧抢活三 E9，实际：' + d12.notation + '/' + d12.meta.tactics);
});

/* ------------------------------------------------------------------ *
 * ⑤f v14 活三判据纠偏（`live3Fresh`：制造点必须由这一手新造）
 * ------------------------------------------------------------------ */
/* 夹具 A：黑活三 D1/E1/F1 两端皆空（⇒ 落子前就已有 2 个活四制造点），白远处三散子。
 * 旧口径下「落子后仍存在 ≥2 个活四制造点」恒真 ⇒ 连 D3 这种与三条毫不相干的闲棋都算制造点。 */
const FRESH_SEQ = ['D1', 'A15', 'E1', 'B15', 'F1', 'C15'];
/* 夹具 C：黑两条开放二 D1/E1 与 H8/I8，白散子 —— 落子前没有任何活四制造点（baseline 为空），
 * 纠正口径必须与旧口径逐字一致（对照组）。 */
const FRESH_CTRL_SEQ = ['D1', 'A15', 'E1', 'C15', 'H8', 'A13', 'I8', 'C13'];

S.t('v14 活三纠偏：已有活三时，旧口径把闲棋也判成制造点', () => {
  const st = play(gomoku, FRESH_SEQ);
  const old = gomoku.live3Makers(st, 'black');
  const fresh = gomoku.live3Makers(st, 'black', { fresh: true });
  ok(old.length >= 20, '旧口径应把大量邻近空点判成制造点，实际 ' + old.length);
  ok(old.indexOf('B1') >= 0, '旧口径应含活三端点 B1（这一手确实能成活四）');
  ok(old.indexOf('D3') >= 0, '旧口径应把与三条无关的闲棋 D3 也算进来（幻影点）');
  eq(fresh.length, 0, '纠正口径下这一手什么都没新造 ⇒ 应为空集，实际 ' + JSON.stringify(fresh));
  deepEq(gomoku.live3Makers(st, 'black', { fresh: false }), old,
    '显式 fresh:false 必须与缺省逐字一致（v0–v13 的历史归因与回放不能变）');
});

S.t('v14 活三纠偏：事实层按档给（旧档 28 个幻影点，v14 报空，真威胁不变）', () => {
  const st = play(gomoku, FRESH_SEQ);
  const v13 = tacOf(gomoku, st, 'v13-pressure-gate');
  const v14 = tacOf(gomoku, st, 'v14-live3-fresh');
  ok(v13.live3_you.length >= 20, 'v13 档应照旧报出全部幻影点，实际 ' + v13.live3_you.length);
  ok(v13.live3_you.indexOf('D3') >= 0, 'v13 档的 live3_you 应含幻影点 D3');
  eq(v14.live3_you.length, 0, 'v14 档的 live3_you 应为空（模型不再收到幻影事实），实际 ' + JSON.stringify(v14.live3_you));
  deepEq(v14.vcf_win_you, v13.vcf_win_you, '纠偏只动 live3 判据：真威胁事实必须逐字不变');
  deepEq(v14.vcf_win_you, ['C1'], '本局面黑有真 VCF 胜点 C1（v13/v14 都应报出）');
});

S.t('v14 活三纠偏：真制造点上结果逐字不变（对照组 · 双活三局面）', async () => {
  const st = play(gomoku, FRESH_CTRL_SEQ);
  const old = gomoku.live3Makers(st, 'black');
  deepEq(gomoku.live3Makers(st, 'black', { fresh: true }), old,
    '落子前没有活四制造点（baseline 为空）时，纠正口径必须与旧口径逐字一致');
  deepEq(old, ['C1', 'F1', 'G8', 'J8'], '本局面真制造点应是 C1/F1/G8/J8');
  deepEq(tacOf(gomoku, st, 'v14-live3-fresh').live3_you, old, 'v14 档在这类局面上不该改变任何点');
  const probs = { C1: 0.6, F1: 0.2, H12: 0.1 };
  const d13 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v13-pressure-gate' }));
  const d14 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v14-live3-fresh' }));
  ok(d13.notation === 'C1' && d13.meta.tactics === 'live3Attack',
    'v13 档应由 live3Attack 接管走 C1，实际：' + d13.notation + '/' + d13.meta.tactics);
  ok(d14.notation === 'C1' && d14.meta.tactics === 'live3Attack',
    'v14 档在真制造点上必须照旧接管走 C1（纠偏不是削弱），实际：' + d14.notation + '/' + d14.meta.tactics);
  eq(d14.meta.tacticsVersion, 'v14-live3-fresh', 'meta.tacticsVersion 应记录 v14-live3-fresh');
});

/* ------------------------------------------------------------------ *
 * ⑥ 渠道与契约
 * ------------------------------------------------------------------ */
S.t('契约：random 渠道不吃种子但必须只走合法着法（20 次≥3 种）', async () => {
  setSeed(42);
  const st = gomoku.newGame();
  const legal = new Set(gomoku.getLegalMoves(st).map((m) => m.notation));
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const d = await decide(gomoku, st, st.turn, { channel: 'random', topK: 1 });
    ok(legal.has(d.notation), 'random 渠道给出了非法着法 ' + d.notation);
    eq(d.meta.channel, 'random', 'meta.channel 应为 random');
    eq(d.meta.model, 'random-baseline', 'random 渠道模型名应为 random-baseline');
    eq(d.meta.confidence, null, 'random 渠道无置信度');
    seen.add(d.notation);
  }
  ok(seen.size >= 3, 'random 渠道自由手应真随机（20 次≥3 种），实际只见：' + [...seen].join(','));
});

S.t('契约：mock 渠道 meta 字段（离线演示可归因）', async () => {
  setSeed(42);
  const st = gomoku.newGame();
  const d = await decide(gomoku, st, st.turn, { channel: 'mock', topK: 3 });
  eq(d.meta.channel, 'mock', 'meta.channel 应为 mock');
  eq(d.meta.mock, true, 'mock 渠道应标 mock:true');
  eq(d.meta.costUsd, 0, 'mock 渠道成本应为 0');
  ok(typeof d.meta.confidence === 'number' && d.meta.confidence <= 0.97, 'mock 置信度应有上限 0.97');
  ok(Array.isArray(d.meta.top) && d.meta.top.length === 3, 'topK=3 应给 3 个候选');
  near(d.meta.top[0].p, d.meta.confidence - 0.05, 'mock 首选概率应与置信度自洽', 1e-9);
});

export default S;
