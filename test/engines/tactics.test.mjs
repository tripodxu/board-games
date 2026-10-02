/* test/engines/tactics.test.mjs — 战术版本登记表 + 保险接管链（v11 起十二级）+ VCF soundness 回归
 *
 * 覆盖旧 test/run-tests.cjs 中的：
 *   - tacticsRegistryTests()（版本登记表、rank/机制单调、层数对照、机制闸门 allows）
 *     —— 时间窗归版（versionForFileStamp）与滞后台账（DEPLOY_LAG/auditCode）已在 P7 退役，
 *     归因改由 test/core/attribution.spec.ts 对「导入后的 D1 库」断言，不放这里。
 *   - ⑥c/⑦/⑧/⑨/⑨b/⑨c/⑩/⑪/⑫a–⑫j（战术事实、接管链、经验注入、VCF 真链与伪胜）
 *   - ⑬a–⑬g（版本闸门：同一局面按档给出不同事实与接管行为）
 *   - ⑤b（v10 活三：引擎层真推演 + 两档事实对照 + 决策级抢/拆活三 + 让位给更短的杀）
 *   - ⑤c（v11 VCT：引擎层连续威胁搜索 + 与纯 VCF 的可见性对照 + 决策级抢链首）
 */
import { suite, ok, eq, deepEq, near } from './harness.mjs';

import { games, getGame } from '../../src/core/registry.ts';
import { setSeed } from '../../src/core/rng.ts';
import { computeTactics, emptyTactics } from '../../src/core/tactics.ts';
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
 * ① 版本登记表（git 历史 × 棋谱数据双锚定：11 个战术版本 + 1 数据驱动基线）
 * ------------------------------------------------------------------ */
S.t('版本登记表：当前档 / 版本齐全 / rank 连续', () => {
  eq(R.CURRENT, 'v11-vct', '当前档应为 v11-vct（连续威胁搜索）');
  const ANCHORED = ['v1-facts', 'v2-open4', 'v3-make2', 'v4-parry3', 'v5-safesort',
    'v6-parry4', 'v7-vcf', 'v8-vcf-try', 'v9-vcf-sound', 'v10-live3', 'v11-vct'];
  for (const id of ANCHORED) ok(R.VERSIONS.some((v) => v.id === id), '登记表漏版本 ' + id);
  eq(R.VERSIONS.length, 12, '应为 11 个战术版本 + 1 基线');
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

S.t('版本登记表：十一级层数对照（2/3/5/6/6/7/9/9/9/11/12）', () => {
  const LAYERS = {
    'v0-off': 0, 'v1-facts': 2, 'v2-open4': 3, 'v3-make2': 5, 'v4-parry3': 6,
    'v5-safesort': 6, 'v6-parry4': 7, 'v7-vcf': 9, 'v8-vcf-try': 9, 'v9-vcf-sound': 9,
    'v10-live3': 11, 'v11-vct': 12,
  };
  const TIER = ['win', 'block', 'open4', 'threat', 'vcfAttack', 'vctAttack', 'vcfDefense',
    'live3Attack', 'live3Defense', 'parry', 'parry3', 'parry4'];
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
  ok(R.resolve('v9-vcf-sound').games >= 26, 'v9 档应登记 26 局窗口棋谱（快照口径已退役；当前档 v11-vct 的实证局数看 gamesVerified）');
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

S.t('版本登记表：resolve 回退与 allows 闸门', () => {
  eq(R.resolve('').id, R.CURRENT, '空 id 应回退当前档');
  eq(R.resolve(null).id, R.CURRENT, 'null 应回退当前档');
  eq(R.resolve('v99-nope').id, R.CURRENT, '未知 id 应回退当前档');
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
  const v0 = R.VERSIONS[0];
  for (const k of R.MECHS) ok(!v0.mech[k], 'v0-off 的 ' + k + ' 应为关');
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
  eq(R.resolve('v11-vct').gamesVerified, 12, 'v11 实证 12 局（2026-10-02 对照实验单臂 12 局，每手 ai.tv = v11-vct）');
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
 * ④ 接管链（十一级）与经验/事实注入
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

S.t('接管链：开放三连拆杀（parry 或 vcfDefense）', async () => {
  const st9 = play(gomoku, ['F7', 'A1', 'F8', 'A2', 'F9']);
  let sent = null;
  const d = await withFetch(async (url, init) => {
    sent = JSON.parse(init.body);
    return mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
      answers: { move: { probabilities: { H8: 0.85, F6: 0.05 } } } });
  }, () => decide(gomoku, st9, st9.turn, { channel: 'proxy', topK: 1 }));
  ok((d.notation === 'F6' || d.notation === 'F10') && (d.meta.tactics === 'parry' || d.meta.tactics === 'vcfDefense'),
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
  const tacC = tacOf(gomoku, stC);
  ok(tacC.vcf_win_opponent.indexOf('H7') >= 0, 'vcf_win_opponent 应含 H7 干预点，实际：' + JSON.stringify(tacC.vcf_win_opponent));
  const dC = await withFetch(repliesWith({ A4: 0.9 }), () => decide(gomoku, stC, stC.turn, { channel: 'proxy', topK: 1 }));
  ok(dC.notation === 'H7' && dC.meta.tactics === 'vcfDefense',
    '白方面对黑 VCF 应提前抢占 H7，实际：' + dC.notation + '/' + dC.meta.tactics);
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

  const tac9d = tacOf(e, st9d);
  eq(tac9d.danger_points_opponent.length, 0,
    'p20 的 2-ply danger 应为空（败因是 3-ply 深度），实际：' + JSON.stringify(tac9d.danger_points_opponent));
  ok(tac9d.vcf_win_opponent.indexOf('E6') >= 0,
    'p20 黑方 VCF 入口应为 E6，实际：' + JSON.stringify(tac9d.vcf_win_opponent));

  const d9d = await withFetch(repliesWith({ E6: 0.9 }), () => decide(e, st9d, st9d.turn, { channel: 'proxy', topK: 1 }));
  ok(d9d.notation === 'E6' && d9d.meta.tactics === 'vcfDefense',
    'p20 自由手应被 vcfDefense 预占 E6（破黑将死链入口），实际：' + d9d.notation + '/' + d9d.meta.tactics);
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
  const tac = tacOf(gomoku, st);
  ok(tac.vcf_win_opponent.indexOf('I14') >= 0, 'vcf_win_opponent 应含 I14，实际：' + JSON.stringify(tac.vcf_win_opponent));
  const d = await withFetch(repliesWith({ E12: 0.9, I14: 0.05 }), () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1 }));
  ok(d.notation === 'I14' && d.meta.tactics === 'vcfDefense',
    'p34 实战 E12 没破杀，应被 vcfDefense 纠正到 I14，实际：' + d.notation + '/' + d.meta.tactics);
});

/* ------------------------------------------------------------------ *
 * ⑤ 版本闸门（同一局面按档给出不同事实/接管行为，⑬a–⑬g）
 * ------------------------------------------------------------------ */
S.t('版本闸门：v0-off 全空（含 win/block），且缓存按版本分键', () => {
  const stx = play(gomoku, ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5']);
  const v9 = tacOf(gomoku, stx);
  ok(v9.winning_points_you.length > 0, '当前档应有致胜点（前置条件）');
  const v0 = tacOf(gomoku, stx, 'v0-off');
  ok(Object.keys(v0).every((k) => Array.isArray(v0[k]) && v0[k].length === 0),
    'v0-off 应无任何战术（含 win/block），实际：' + JSON.stringify(v0));
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
  /* 缺省/未知 id 都收敛到当前档（老调用方零感知） */
  const stx = play(gomoku, ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5']);
  const crit = critOf(gomoku, stx);
  const legal = gomoku.getLegalMoves(stx);
  const cur = computeTactics(gomoku, stx, legal, crit, R.CURRENT);
  const def = computeTactics(gomoku, stx, legal, crit);
  const bogus = computeTactics(gomoku, stx, legal, crit, 'v99-nope');
  eq(JSON.stringify(def), JSON.stringify(cur), '缺省 tacticsVersion 必须按当前档跑（' + R.CURRENT + '）');
  eq(JSON.stringify(bogus), JSON.stringify(cur), '未知 tacticsVersion 必须按当前档跑');
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
  const d11 = await withFetch(repliesWith(probs), () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1 }));
  ok(d11.notation === 'L4' && d11.meta.tactics === 'vctAttack',
    'v11 应被 vctAttack 接管走 L4，实际：' + d11.notation + '/' + d11.meta.tactics);
  eq(d11.meta.tacticsVersion, 'v11-vct', 'meta.tacticsVersion 应记录 v11-vct');
  const d10 = await withFetch(repliesWith(probs),
    () => decide(gomoku, st, st.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v10-live3' }));
  ok(d10.notation === 'K7' && d10.meta.tactics === 'live3Attack',
    'v10 档应照旧走启发式活三点 K7（这就是漏掉必胜链的那一手），实际：' + d10.notation + '/' + d10.meta.tactics);
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
