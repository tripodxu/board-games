/* test/engines/util.test.mjs — 支持层回归（rng / clone / weighted / registry / 视图层）
 *
 * 覆盖旧 test/run-tests.cjs 中「棋谱导出 meta」「最新决策固定槽位」「对阵联名与 slug」
 * 「概率校准」四组用例，并补上纯函数层（rng/clone/weighted）此前没有的边界回归。
 */
import { suite, ok, eq, deepEq, near, throws } from './harness.mjs';

import { rng, setSeed, getSeed, rand, rnd, shuffle } from '../../src/core/rng.ts';
import { clone } from '../../src/core/clone.ts';
import { assert } from '../../src/core/assert.ts';
import { weightedPick } from '../../src/core/weighted.ts';
import { aiMoveMeta, aiGameMeta } from '../../src/core/meta.ts';
import { boardHTML, pct, SLOTS } from '../../src/core/view/board.ts';
import * as C from '../../src/core/view/calibration.ts';
import * as D from '../../src/core/view/duel.ts';
import { games, ids, getGame, gomoku, gomokuPro } from '../../src/core/registry.ts';

const S = suite();

/* ------------------------------------------------------------------ *
 * rng：可种子随机（旧 BG.setSeed / BG.util.rand / BG.util.rnd / shuffle）
 * ------------------------------------------------------------------ */
S.t('rng：同种子可复现、不同种子不同流', () => {
  const a = rng(42), b = rng(42), c = rng(43);
  for (let i = 0; i < 200; i++) eq(a(), b(), '同种子第 ' + i + ' 个随机数应一致');
  const a1 = [...Array(10)].map(() => a());
  const c1 = [...Array(10)].map(() => c());
  ok(JSON.stringify(a1) !== JSON.stringify(c1), '不同种子不应产生同一序列');
});

S.t('rng：rand 覆盖 [0,n) 且无越界', () => {
  setSeed(42);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = rand(7);
    ok(Number.isInteger(v) && v >= 0 && v < 7, 'rand(7) 越界: ' + v);
    seen.add(v);
  }
  eq(seen.size, 7, 'rand(7) 应覆盖 0..6');
});

S.t('rng：setSeed(null) 后回落到 Math.random 但不抛错', () => {
  setSeed(42);
  eq(getSeed(), 42, 'setSeed 后 getSeed 应回读种子');
  setSeed(null);
  eq(getSeed(), null, 'setSeed(null) 后种子应为 null');
  ok(rnd() >= 0 && rnd() < 1, '无种子时 rnd 仍应在 [0,1)');
  setSeed(42);
});

S.t('rng：shuffle 原地打乱且元素不丢不增', () => {
  setSeed(42);
  const src = Array.from({ length: 20 }, (_, i) => i);
  const a = src.slice();
  shuffle(a);
  eq(a.length, src.length, 'shuffle 不得改变长度');
  eq(a.slice().sort((x, y) => x - y).join(','), src.join(','), 'shuffle 不得丢/增元素');
  setSeed(42);
  const b = src.slice();
  shuffle(b);
  deepEq(b, a, '同种子 shuffle 应可复现');
});

/* ------------------------------------------------------------------ *
 * clone / assert
 * ------------------------------------------------------------------ */
S.t('clone：深拷贝、不共享引用、可 JSON 往返', () => {
  const st = { board: [[1, 0], [0, 2]], turn: 'black', nested: { a: [1, { b: 2 }] } };
  const c = clone(st);
  c.board[0][0] = 9;
  c.nested.a[1].b = 9;
  eq(st.board[0][0], 1, 'clone 后改副本不得影响原对象（数组）');
  eq(st.nested.a[1].b, 2, 'clone 后改副本不得影响原对象（深层对象）');
  deepEq(c.turn, 'black', 'clone 应保留标量字段');
});

S.t('assert：真值放行、假值抛错且带消息', () => {
  noThrowAssert();
  function noThrowAssert() { assert(true, '不该抛'); }
  throws(() => assert(false, '棋盘已满'), /棋盘已满/, 'assert(false) 应抛出带消息的错误');
  throws(() => assert(0, 'zero'), /zero/, 'assert(0) 应判假');
  throws(() => assert(null, 'null'), /null/, 'assert(null) 应判假');
});

/* ------------------------------------------------------------------ *
 * weightedPick：按权重抽取（真实渠道保持真随机，刻意不吃种子）
 * ------------------------------------------------------------------ */
S.t('weightedPick：权重区间、零权重不被选中、单元素兜底', () => {
  const items = ['a', 'b', 'c'];
  const hits = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 20000; i++) hits[weightedPick(items, [1, 0, 0])]++;
  eq(hits.b, 0, '零权重项不得被选中(b)');
  eq(hits.c, 0, '零权重项不得被选中(c)');
  eq(hits.a, 20000, '独占权重应恒选中 a');
  eq(weightedPick(['only'], [3]), 'only', '单元素应直接返回');
  const idx = weightedPick([10, 11, 12], [1, 1, 1]);
  ok(idx >= 10 && idx <= 12, '返回值应为数组元素本身: ' + idx);
});

S.t('weightedPick：权重含极小值/合计为 0 时不抛错且有兜底', () => {
  let v = null;
  for (let i = 0; i < 50; i++) v = weightedPick(['x', 'y'], [0, 0]);
  ok(v === 'x' || v === 'y', '全零权重应有兜底返回: ' + v);
  for (let i = 0; i < 50; i++) v = weightedPick(['x', 'y'], [1e-12, 1e-12]);
  ok(v === 'x' || v === 'y', '极小权重应正常返回: ' + v);
});

/* ------------------------------------------------------------------ *
 * 棋谱 meta（旧 run-tests.cjs 第 77–141 行）
 * ------------------------------------------------------------------ */
function aiM(notation, extra) {
  return Object.assign({
    byAI: true, channel: 'proxy', model: 'jev-latest', confidence: 0.6,
    candidates: 12, latencyMs: 800, costUsd: 0.00005, usage: { input_tokens: 1200 },
    top: [{ notation: 'H8', p: 0.4 }, { notation: 'G8', p: 0.25 }, { notation: 'H7', p: 0.1 }],
  }, extra);
}

S.t('meta：人走/null 不产 meta，实走首选归因 rank=1', () => {
  eq(aiMoveMeta('H8', { human: true }), null, '人走的手不该有 aiMoveMeta');
  eq(aiMoveMeta('H8', null), null, 'meta 缺失时 aiMoveMeta 应为 null');
  const m1 = aiMoveMeta('H8', aiM('H8'));
  ok(m1.rank === 1 && m1.p === 0.4 && m1.cands === 12 && m1.ms === 800, '首选手归因字段不对：' + JSON.stringify(m1));
  ok(m1.ch === 'proxy' && m1.mdl === 'jev-latest' && m1.conf === 0.6, '渠道/模型/置信度应透出');
});

S.t('meta：第 2 名 rank=2，未进榜 rank/p 为 null（不得填 0）', () => {
  const m2 = aiMoveMeta('G8', aiM('G8'));
  ok(m2.rank === 2 && m2.p === 0.25, '第 2 名归因不对：' + JSON.stringify(m2));
  const m3 = aiMoveMeta('A1', aiM('A1'));
  ok(m3.rank === null && m3.p === null, '未进榜手的 rank/p 应为 null：' + JSON.stringify(m3));
});

S.t('meta：缺字段的老/降级响应一律 null，且不抛错', () => {
  const m4 = aiMoveMeta('H8', { byAI: true, channel: 'mock' });
  ok(m4.conf === null && m4.ms === null && m4.cands === null && m4.rank === null && m4.p === null,
    '残缺 meta 应降级为 null 字段：' + JSON.stringify(m4));
});

S.t('meta：全局汇总（延迟/置信度/token/战术分布/成本）', () => {
  setSeed(null); /* 显式清种：本文件前面跑过 rng 用例，会留下 _seed */
  const items = [
    { meta: aiM('H8', { tactics: 'vcfAttack', latencyMs: 900, costUsd: 0.00005 }) },
    { meta: aiM('G8', { tactics: 'vcfAttack', latencyMs: 500, costUsd: 0.00005 }) },
    { meta: aiM('H7', { tactics: 'win', latencyMs: 700, costUsd: 0.00004, confidence: 0.8 }) },
    { meta: { human: true } },
  ];
  const gm = aiGameMeta(items, { topK: 3 });
  eq(gm.topK, 3, 'topK 应透出');
  eq(gm.seed, null, '未设种子时 seed 应为 null');
  eq(gm.aiMoves, 3, 'aiMoves 只数 AI 手：' + gm.aiMoves);
  ok(gm.latencyMs.avg === 700 && gm.latencyMs.max === 900, '延迟汇总不对：' + JSON.stringify(gm.latencyMs));
  eq(gm.conf, 0.667, '平均置信度应保留 3 位小数：' + gm.conf);
  eq(gm.tokens, 3600, 'token 合计不对：' + gm.tokens);
  ok(gm.tactics.vcfAttack === 2 && gm.tactics.win === 1, '战术分布不对：' + JSON.stringify(gm.tactics));
  ok(gm.costUsd > 0 && gm.costUsd < 0.001, '成本量级不对：' + gm.costUsd);
});

S.t('meta：空局不产假数字（latency null、conf null、tactics 空）', () => {
  const g0 = aiGameMeta([], { topK: 1 });
  ok(g0.aiMoves === 0 && g0.latencyMs === null && g0.conf === null, '空局 meta 不应有汇总值：' + JSON.stringify(g0));
  eq(Object.keys(g0.tactics).length, 0, '空局 tactics 应为空对象');
});

S.t('meta：种子可归因（setSeed 42/7 跟随）', () => {
  setSeed(42);
  eq(aiGameMeta([], {}).seed, 42, '已设种子时 meta.seed 应为该值');
  setSeed(7);
  eq(aiGameMeta([], {}).seed, 7, '换种子后 meta.seed 应跟随');
  setSeed(42);
});

S.t('meta：战术版本透出（tv 字段，每手可归源）', () => {
  const tv = aiMoveMeta('G8', aiM('G8', { tacticsVersion: 'v3-make2' }));
  ok(tv !== null && tv.tv === 'v3-make2', 'aiMoveMeta 应透出 tv=v3-make2：' + JSON.stringify(tv));
  const noTv = aiMoveMeta('G8', aiM('G8'));
  ok(noTv !== null && noTv.tv === null, '无 tacticsVersion 时 tv 应为 null：' + JSON.stringify(noTv));
});

/* ------------------------------------------------------------------ *
 * 最新决策固定槽位（旧 run-tests.cjs 第 143–206 行）
 * ------------------------------------------------------------------ */
S.t('latest：结构恒定 8 候选槽 / 3 指标槽 / 1 标题行 / 1 rest 行', () => {
  const m = (over) => Object.assign({
    notation: 'H8', sideName: '黑', noul: 0.612, score: 3.4, latencyMs: 820,
    candidates: 12, restProb: 0.18, confidence: 0.66, model: 'jev-latest',
    top: [
      { notation: 'H8', p: 0.18 }, { notation: 'H7', p: 0.12 }, { notation: 'I8', p: 0.08 },
      { notation: 'J8', p: 0.05 }, { notation: 'G8', p: 0.04 }, { notation: 'G7', p: 0.03 },
      { notation: 'I9', p: 0.02 }, { notation: 'J9', p: 0.01 },
    ],
  }, over);
  const h = (over) => ({ move: { notation: m(over).notation }, ply: 42, meta: m(over) });

  const none = boardHTML(null);
  eq(none.note.indexOf('尚无决策'), 0, '空状态标题应为「尚无决策」：' + none.note);
  eq(none.count, '', '空状态候选数徽标应为空串，实际 ' + JSON.stringify(none.count));

  const cases = [none, boardHTML(h()), boardHTML(h({ candidates: 3, top: [{ notation: 'H7', p: 0.5 }] }))];
  for (const c of cases) {
    eq((c.html.match(/rank-row/g) || []).length, 8, '候选槽应恒 8 个');
    eq((c.html.match(/class="big[" ]/g) || []).length, 3, '指标槽应恒 3 个');
    eq((c.html.match(/rank-rest/g) || []).length, 1, '「其余候选」行应恒在');
    eq((c.html.match(/latest-head/g) || []).length, 1, '标题行应恒 1 个');
  }
  eq(SLOTS, 8, 'SLOTS 常量应为 8');
});

S.t('latest：空槽计数（满样本 0 / 空状态 12 / 3 候选 8）', () => {
  const m = (over) => Object.assign({
    notation: 'H8', sideName: '黑', noul: 0.612, score: 3.4, latencyMs: 820,
    candidates: 12, restProb: 0.18, confidence: 0.66, model: 'jev-latest',
    top: Array.from({ length: 8 }, (_, i) => ({ notation: 'X' + i, p: 0.01 })),
  }, over);
  const h = (over) => ({ move: { notation: m(over).notation }, ply: 42, meta: m(over) });
  const empt = (s) => (s.match(/is-empty/g) || []).length;
  eq(empt(boardHTML(h()).html), 0, '满候选+全指标时不应有空槽');
  eq(empt(boardHTML(null).html), 12, '空状态空槽应 12 个（8 候选+3 指标+1 rest）');
  eq(empt(boardHTML(h({ candidates: 3, top: [{ notation: 'H7', p: 0.5 }] })).html), 8, '3 候选空槽应为 7+1=8');
});

S.t('latest：其余候选文案 + 候选不足时隐藏 rest 文字', () => {
  const full = boardHTML({
    move: { notation: 'H8' }, ply: 42, meta: {
      notation: 'H8', candidates: 12, restProb: 0.18, confidence: 0.66,
      top: [{ notation: 'H8', p: 0.18 }],
    },
  });
  eq(full.count, '12 个候选', '候选数徽标不对：' + full.count);
  ok(full.html.indexOf('其余 4 个候选合计 18.0%') >= 0, '12 候选的超额部分应显示「其余 4 个候选合计 18.0%」');
  const three = boardHTML({ move: { notation: 'H7' }, ply: 3, meta: { candidates: 3, top: [{ notation: 'H7', p: 0.5 }] } });
  ok(three.html.indexOf('其余') < 0, '候选不足 8 时 rest 行不得出现文字');
  ok(three.html.indexOf('rank-rest is-empty') >= 0, '无超额候选时 rest 应为空槽');
});

S.t('latest：实走着高亮 is-chosen 与缺指标降级', () => {
  const full = boardHTML({ move: { notation: 'H8' }, ply: 42, meta: { notation: 'H8', candidates: 2, top: [{ notation: 'H8', p: 0.18 }] } });
  ok(full.html.indexOf('is-chosen') >= 0, '实走着的行应有 is-chosen 高亮');
  const miss = boardHTML({ move: { notation: 'A1' }, ply: 42, meta: { notation: 'A1', top: [{ notation: 'H8', p: 0.18 }] } });
  ok(miss.html.indexOf('is-chosen') < 0, '实走不在榜上时不应有 is-chosen');
  const bare = boardHTML({ move: { notation: 'H8' }, ply: 7, meta: { notation: 'H8', top: [] } });
  ok(bare.html.indexOf('–') >= 0, '缺指标应显示占位 –');
  ok(bare.note.indexOf('第7手') >= 0, '标题缺字段时应降级为「第N手」：' + bare.note);
});

S.t('latest：百分比格式化位数（1 位/0 位）', () => {
  eq(pct(0.612), '61.2%', '默认 1 位小数');
  eq(pct(0.612, 0), '61%', '0 位小数应四舍五入');
  eq(pct(0.18), '18.0%', '0.18 应为 18.0%');
});

/* ------------------------------------------------------------------ *
 * 概率校准（旧 js/calibration.js selfTest）
 * ------------------------------------------------------------------ */
S.t('calibration：完美校准（两极 + 五五开）', () => {
  const A = C.metrics([{ p: 1, y: 1 }, { p: 0, y: 0 }, { p: 0.5, y: 0 }, { p: 0.5, y: 1 }]);
  near(A.brier, 0.125, 'A.brier 应为 0.125，实际 ' + A.brier);
  near(A.skill, 0.5, 'A.skill 应为 0.5，实际 ' + A.skill);
  near(A.ece, 0, 'A.ece 应为 0');
  near(A.mce, 0, 'A.mce 应为 0');
  near(A.overconfidence, 0, 'A.overconfidence 应为 0');
  near(A.baseRate, 0.5, 'A.baseRate 应为 0.5');
  near(A.sharpness, 0.5, 'A.sharpness 应为 0.5');
});

S.t('calibration：恒定 0.5 → 毫无信息量（skill=0）', () => {
  const B = C.metrics([{ p: 0.5, y: 0 }, { p: 0.5, y: 1 }, { p: 0.5, y: 1 }, { p: 0.5, y: 0 }]);
  near(B.brier, 0.25, 'B.brier 应为 0.25');
  near(B.skill, 0, 'B.skill 应为 0');
});

S.t('calibration：系统性过度自信 ece/mce=0.6', () => {
  const Cc = C.metrics(Array.from({ length: 10 }, (_, i) => ({ p: 0.9, y: i < 3 ? 1 : 0 })));
  near(Cc.brier, 0.57, 'C.brier 应为 0.57，实际 ' + Cc.brier);
  near(Cc.overconfidence, 0.6, 'C.overconfidence 应为 0.6');
  near(Cc.ece, 0.6, 'C.ece 应为 0.6');
  near(Cc.mce, 0.6, 'C.mce 应为 0.6');
});

S.t('calibration：完美预测 brier=0 / skill=1；混合样本 F', () => {
  const Dm = C.metrics([{ p: 1, y: 1 }, { p: 0, y: 0 }]);
  near(Dm.brier, 0, 'D.brier 应为 0');
  near(Dm.skill, 1, 'D.skill 应为 1');
  const F = C.metrics([{ p: 0.9, y: 0 }, ...Array.from({ length: 9 }, () => ({ p: 0.5, y: 1 }))]);
  near(F.ece, 0.54, 'F.ece 应为 0.54，实际 ' + F.ece);
  near(F.mce, 0.9, 'F.mce 应为 0.9');
  near(F.baseRate, 0.9, 'F.baseRate 应为 0.9');
  near(F.sharpness, 0.54, 'F.sharpness 应为 0.54');
  near(F.overconfidence, -0.36, 'F.overconfidence 应为 -0.36');
  near(F.brier, 0.306, 'F.brier 应为 0.306');
});

S.t('calibration：退化样本（全赢）skill=null 但指标有限；空样本 null', () => {
  const G = C.metrics([{ p: 0.7, y: 1 }, { p: 0.8, y: 1 }]);
  eq(G.skill, null, '全赢时 skill 应为 null');
  ok(isFinite(G.brier) && isFinite(G.ece), '退化样本的 brier/ece 必须有限');
  eq(C.metrics([]), null, '空样本应返回 null');
  eq(C.metrics(null), null, 'null 样本应返回 null');
});

S.t('calibration：分箱边界（p=1 落末箱、空箱 n=0）', () => {
  const bins = C.reliability([{ p: 1, y: 1 }, { p: 0, y: 0 }], 10);
  eq(bins.length, 10, '应返回 10 箱');
  eq(bins[9].n, 1, 'p=1 应落最后一箱');
  eq(bins[0].n, 1, 'p=0 应落第一箱');
  eq(bins[5].n, 0, '中间空箱 n 应为 0');
  ok(bins[5].conf === 0 && bins[5].acc === 0, '空箱 conf/acc 应为 0');
});

S.t('calibration：清洗规则（非有限 p、非 0/1 y 剔除，越界截断）', () => {
  const c = C.clean([{ p: 1.4, y: 1 }, { p: -0.2, y: 0 }, { p: NaN, y: 1 }, { p: 0.5, y: 2 }, { p: '0.3', y: 1 }, null]);
  eq(c.length, 3, '应保留 3 条合法样本，实际 ' + c.length);
  eq(c[0].p, 1, '越界 p 应截断到 1');
  eq(c[1].p, 0, '越界 p 应截断到 0');
  eq(c[2].p, 0.3, '字符串数字应可解析');
});

S.t('calibration：fromRecords 计数（和棋丢样本、演示局单列）', () => {
  const agg = C.fromRecords([
    { cal: [0.6, 0.7], firstWin: true },
    { cal: [0.4], firstWin: null },
    { mock: true },
  ]);
  eq(agg.games, 1, 'games 应只数有二元真值的局（和棋局与演示局都不计入），实际 ' + agg.games);
  eq(agg.draws, 1, 'draws 应为 1');
  eq(agg.samples.length, 2, 'samples 应只来自非和棋局');
  const dir = C.fromRecords([{ cal: [0.9], firstWin: true }, { cal: [0.2], firstWin: false }]);
  eq(dir.samples[0].y, 1, 'firstWin=true → y=1');
  eq(dir.samples[1].y, 0, 'firstWin=false → y=0');
  ok(dir.metrics !== null && dir.metrics.n === 2, 'fromRecords 应带 metrics');
  const skip = C.fromRecords([{ mock: true }, { mock: true }]);
  eq(skip.skippedDemo, 2, '演示局应计入 skippedDemo');
  eq(skip.games, 0, '演示局不得计入 games');
});

/* ------------------------------------------------------------------ *
 * 对阵联名与 slug（旧 run-tests.cjs 第 300–356 行）
 * ------------------------------------------------------------------ */
S.t('duel：展示名（人/演示/代理/随机/rapfi 时长）', () => {
  eq(D.sideLabel({ human: true }), '我', 'human 展示名应为 我');
  eq(D.sideLabel({ channel: 'mock' }), '演示', 'mock 展示名应为 演示');
  eq(D.sideLabel({ channel: 'proxy' }), 'Jev·v12', 'proxy 展示名应跟登记表末档（Jev·v12）');
  eq(D.sideLabel({ channel: 'random', tactics: 'v4-parry3' }), '随机·v4', '随机渠道也应带版本');
  eq(D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 3000 }), 'Rapfi(3s)', 'Rapfi 应带思考时长');
  eq(D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 500 }), 'Rapfi(0.5s)', '0.5s 档应显示 0.5s');
});

S.t('duel：联名 / 战绩簿 / 实验标签', () => {
  eq(D.duelLabel({ channel: 'proxy' }, { channel: 'rapfi', rapfiThinkMs: 5000 }), '黑 Jev·v12 vs 白 Rapfi(5s)',
    '联名格式不对：' + D.duelLabel({ channel: 'proxy' }, { channel: 'rapfi', rapfiThinkMs: 5000 }));
  eq(D.gameLabel('五子棋', 'human', { human: true }, { channel: 'proxy' }), '五子棋 · 人机 · 黑 我 vs 白 Jev·v12',
    '战绩簿名不对：' + D.gameLabel('五子棋', 'human', { human: true }, { channel: 'proxy' }));
  eq(D.expLabel({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' }, 4), 'Jev·v12 vs 随机·v3 ×4局',
    '实验标签不对：' + D.expLabel({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' }, 4));
  eq(D.gameLabel('围棋', 'ai-ai', { channel: 'proxy' }, { channel: 'mock' }), '围棋 · 机机 · 黑 Jev·v12 vs 白 演示',
    '机机模式文案不对');
  eq(D.gameLabel('象棋', 'pvp', { human: true }, { human: true }), '象棋 · 双人 · 黑 我 vs 白 我',
    '双人模式文案不对');
});

S.t('duel：slug 字符集/长度/路径注入防御', () => {
  const s = D.slug({ channel: 'random', tactics: 'v3-make2' }, { channel: 'proxy' });
  eq(s, 'ran-v3-vs-jev-v12', 'slug 不对：' + s);
  ok(!/[^a-z0-9_-]/.test(s) && s.length <= 24, 'slug 必须只含安全字符且 ≤24：' + s);
  const inject = D.slug({ channel: 'proxy', tactics: '../../etc/pa' }, { channel: 'mock' });
  ok(inject.indexOf('/') < 0 && inject.indexOf('.') < 0, '路径注入必须被清掉：' + inject);
  ok(D.slug({}, {}).length > 0, '空配置也应有兜底 slug');
  eq(D.slug({ human: true }, { channel: 'proxy', tactics: 'v0-off' }), 'me-vs-jev-v0',
    '人机局 slug 应为 me-vs-jev-v0');
  eq(D.duelLabel({ human: true }, { channel: 'proxy' }), '黑 我 vs 白 Jev·v12', '人机局联名应标「我」');
  eq(D.slug({ human: true }, { human: true }), 'me-vs-me', '双人局 slug 应为 me-vs-me');
  eq(D.sideSlug({ channel: 'rapfi', rapfiThinkMs: 2500 }), 'rapfi-2.5s', 'rapfi slug 应带时长');
});

/* ------------------------------------------------------------------ *
 * registry：注册表语义等价（旧 BG.games / BG.register）
 * ------------------------------------------------------------------ */
S.t('registry：七个棋种齐全且 id 顺序稳定', () => {
  deepEq(ids, ['gomoku', 'gomoku-pro', 'go', 'xiangqi', 'chess', 'checkers', 'cc'], '注册表 id 顺序应稳定');
  for (const id of ids) {
    const e = getGame(id);
    ok(!!e, 'getGame(' + id + ') 不应为空');
    eq(e.id, id, id + ' 的 engine.id 应与注册键一致');
    ok(e.sides.length >= 2, id + ' 应至少有双方');
    eq(e.sides.filter((s) => s.first).length, 1, id + ' 应恰有一方 first:true');
  }
  eq(getGame('nope'), undefined, '未知 id 应返回 undefined');
  eq(gomoku.id, 'gomoku', 'gomoku 导出应为非禁手版');
  eq(gomokuPro.id, 'gomoku-pro', 'gomokuPro 导出应为禁手版');
  eq(games['gomoku-pro'], gomokuPro, '注册表应挂同一对象');
});

export default S;
