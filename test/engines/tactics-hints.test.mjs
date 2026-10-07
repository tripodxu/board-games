/* tactics-hints.test.mjs — 战术模式提示的纯计算层（分层颜色标记）
 *
 * 测什么：
 *   ① 颜色表覆盖全部接管层；
 *   ② 机制门控（v0-off 全空 / v3 只有它拥有的层 / v16 全层）——「所有版本都这样可视化」的凭据；
 *   ③ 优先级去重（同一点在我方落点间只归最高层）与接管层标记（第一个有点的层）；
 *   ④ parry 的对手杀点（opp = 画环，与 block 的落点圆点可并存——语义不同）；
 *   ⑤ 开局前 4 手短路（与战术层 openingMin 同口径）；未知档位回落空机制集。
 * 夹具记法口径与 tactics.test.mjs 的 play() 一致。
 */
import { suite, ok, eq } from './harness.mjs';
import { getGame } from '../../src/core/registry.ts';
import { computeTacticHints, LAYER_COLORS } from '../../src/core/tactics-hints.ts';
import * as R from '../../src/core/tactics-versions.ts';
import { computeTactics } from '../../src/core/tactics.ts';
import { TAKEOVER_ORDER } from '../../src/core/takeover.ts';

const S = suite();
const gomoku = getGame('gomoku');

function play(e, seq) {
  let st = e.newGame();
  for (const n of seq) {
    const m = e.moveFromNotation(st, n);
    if (!m) throw new Error('夹具记法非法：' + n);
    st = e.applyMove(st, m);
  }
  return st;
}
const layersOf = (hint) => [...new Set(hint.marks.map((m) => m.layer))];
const marksOf = (hint, layer) => hint.marks.filter((m) => m.layer === layer).map((m) => m.notation);

S.t('hints：颜色表覆盖全部接管层（图例与棋盘圆点不会撞到缺色兜底）', () => {
  for (const layer of TAKEOVER_ORDER) ok(!!LAYER_COLORS[layer], '缺色：' + layer);
  eq(Object.keys(LAYER_COLORS).length, TAKEOVER_ORDER.length, '颜色表应与接管层一一对应');
});

S.t('hints：黑四连待成五 → win 层给成五点且为接管层（fire）', () => {
  /* 黑 H8/H9/H10/H11 四连（奇数手），白 I9/J10/K11/M13 散子；轮黑，H7/H12 一手成五 */
  const st = play(gomoku, ['H8', 'I9', 'H9', 'J10', 'H10', 'K11', 'H11', 'M13']);
  const hint = computeTacticHints(gomoku, st, 'v16-softgate');
  const winMarks = marksOf(hint, 'win');
  ok(winMarks.includes('H7') && winMarks.includes('H12'),
    'win 层应含成五点 H7/H12，实际：' + JSON.stringify(winMarks));
  const winLegend = hint.legend.find((l) => l.layer === 'win');
  ok(winLegend && winLegend.fire, 'win 应是接管层（第一个有点的层）');
  for (const m of hint.marks) {
    if (m.layer === 'win') ok(m.fire, 'win 层的标记都应带 fire');
    else ok(!m.fire, '非接管层不应带 fire：' + m.layer);
  }
});

S.t('hints：白四连待成五 → block 层给出占位挡点（v16）', () => {
  /* 白 H8/H9/H10/H11 四连；轮黑，H7/H12 是对手成五点 = 我方占位挡点 */
  const st = play(gomoku, ['I9', 'H8', 'K11', 'H9', 'M13', 'H10', 'O15', 'H11']);
  const hint = computeTacticHints(gomoku, st, 'v16-softgate');
  const blockMarks = marksOf(hint, 'block');
  ok(blockMarks.includes('H7') || blockMarks.includes('H12'),
    'block 层应含挡点 H7/H12，实际：' + JSON.stringify(blockMarks));
  ok(hint.legend.some((l) => l.layer === 'block' && l.fire), 'block 应是接管层');
});

S.t('hints：机制门控——v0-off 全空 / v3 不含 vctDefense / v16 有标记', () => {
  /* 黑活三 F8/G8/H8 + 白活三 G7/H7/I7：live3 两层 v10 起有、vctDefense v12 起有 */
  const st = play(gomoku, ['F8', 'G7', 'G8', 'H7', 'H8', 'I7', 'A1']);
  const off = computeTacticHints(gomoku, st, 'v0-off');
  eq(off.marks.length, 0, 'v0-off 空机制集应无任何标记');
  eq(off.legend.length, 0, 'v0-off 图例应为空');
  eq(off.version, 'v0-off', 'version 字段应回显实际生效档位');

  const v3 = computeTacticHints(gomoku, st, 'v3-make2');
  for (const layer of layersOf(v3)) {
    ok(['win', 'block', 'open4', 'threat', 'parry'].includes(layer),
      'v3 只应出现它拥有的层，实际混入：' + layer);
  }

  const v16 = computeTacticHints(gomoku, st, 'v16-softgate');
  ok(v16.marks.length > 0, 'v16 在该局面应有标记');
  ok(layersOf(v16).every((l) => TAKEOVER_ORDER.includes(l)), 'v16 的层都应是合法接管层');
});

S.t('hints：优先级去重——win 与 block 抢同一点时点归 win（TAKEOVER_ORDER 顺序）', () => {
  /* 黑 I12/J12/K12/L12 四连（成五点 H12/M12）+ 白 H9/H10/H11/H13 四连（成五点 H8/H12）：
   * H12 对双方都是成五点 ⇒ win（更高优先）认领 H12，block 只能拿 H8。 */
  const st = play(gomoku, ['I12', 'H9', 'J12', 'H10', 'K12', 'H11', 'L12', 'H13']);
  const hint = computeTacticHints(gomoku, st, 'v16-softgate');
  const winMarks = marksOf(hint, 'win');
  const blockMarks = marksOf(hint, 'block');
  ok(winMarks.includes('H12'), 'win 应认领共享成五点 H12，实际：' + JSON.stringify(winMarks));
  const overlap = winMarks.filter((n) => blockMarks.includes(n));
  eq(overlap.length, 0, '同一点不得同时出现在两个我方落点层：' + JSON.stringify(overlap));
  ok(hint.legend.find((l) => l.layer === 'win')?.fire, 'win 应先于 block 接管');
  const seen = new Set();
  for (const m of hint.marks.filter((x) => !x.opp)) {
    ok(!seen.has(m.notation), '我方落点标记重复：' + m.notation);
    seen.add(m.notation);
  }
});

S.t('hints：parry 的对手杀点画环（opp）——白活三的四制造点；open4 优先于 parry 接管', () => {
  /* 白活三 H9/H10/H11（两端开）：H8/H12 是对手的四制造点（danger）= parry 层画环；
   * 同时黑 C3/D3/E3 也是活三 ⇒ open4 层（更高优先）先接管。两层的标记同时可见。 */
  const st = play(gomoku, ['C3', 'H9', 'D3', 'H10', 'E3', 'H11']);
  const hint = computeTacticHints(gomoku, st, 'v16-softgate');
  const parryRings = hint.marks.filter((m) => m.layer === 'parry');
  eq(parryRings.map((m) => m.notation).sort().join(','), 'H12,H8',
    'parry 环应标在对手的四制造点 H8/H12');
  for (const m of parryRings) ok(m.opp, 'parry 标记应带 opp（画环）：' + m.notation);
  ok(hint.legend.find((l) => l.layer === 'open4')?.fire, 'open4 应先于 parry 接管');
  ok(!hint.legend.find((l) => l.layer === 'parry')?.fire, 'parry 不应是接管层');
});

S.t('hints：开局前 4 手短路（与战术层 openingMin 同口径）', () => {
  const st = play(gomoku, ['H8', 'I9', 'H9']);
  const hint = computeTacticHints(gomoku, st, 'v16-softgate');
  eq(hint.marks.length, 0, '前 4 手应无标记');
  eq(hint.legend.length, 0, '前 4 手图例应为空');
});

S.t('hints：未知档位回落空机制集（与 computeTactics 同口径，绝不静默变当前档）', () => {
  const st = play(gomoku, ['F8', 'G7', 'G8', 'H7', 'H8', 'I7', 'A1']);
  const bad = computeTacticHints(gomoku, st, 'v99-nope');
  eq(bad.marks.length, 0, '未知档位应无标记');
  eq(bad.version, 'v0-off', 'version 应回显 v0-off');
});

export default S;

S.t('hints：接管层 = 真实接管链（pickTakeover 同源）——与直接调用逐字一致', async () => {
  const { pickTakeover } = await import('../../src/core/takeover.ts');
  const check = (seq, versionId) => {
    const st = play(gomoku, seq);
    const hint = computeTacticHints(gomoku, st, versionId);
    const legal = gomoku.getLegalMoves(st);
    const crit = gomoku.serializeForJev(st, st.turn).questions.move.criteria || {};
    const takeover = pickTakeover({
      engine: gomoku, st, tactics: computeTactics(gomoku, st, legal, Object.keys(crit), versionId),
      mech: R.resolve(versionId).mech, criteria: crit, legal, pairs: [], cands: Object.keys(crit), topK: 1,
    });
    const fireLayers = [...new Set(hint.legend.filter((l) => l.fire).map((l) => l.layer))];
    if (takeover.layer) {
      eq(fireLayers.join(','), takeover.layer, '图例接管层应与真实接管链一致');
      ok(hint.marks.some((m) => m.layer === takeover.layer && m.notation === takeover.notation),
        `真实接管点 ${takeover.notation} 应在标记中（层 ${takeover.layer}）`);
    } else {
      eq(fireLayers.length, 0, '无接管时不应有 fire 层');
    }
  };
  /* 三类局面：我方四连（win）/ 白四连（block）/ 双活三（open4+parry 共存） */
  check(['H8', 'I9', 'H9', 'J10', 'H10', 'K11', 'H11', 'M13'], 'v16-softgate');
  check(['I9', 'H8', 'K11', 'H9', 'M13', 'H10', 'O15', 'H11'], 'v16-softgate');
  check(['F8', 'G7', 'G8', 'H7', 'H8', 'I7', 'A1'], 'v16-softgate');
  check(['F8', 'G7', 'G8', 'H7', 'H8', 'I7', 'A1'], 'v3-make2');
});

S.t('hints：每层封顶 12 点（MARKS_PER_LAYER 上限生效）', () => {
  /* 白四连的局面里 parry4 曾给出 12 个点：验证任何层的标记数都不超过 12 */
  const st = play(gomoku, ['I9', 'H8', 'K11', 'H9', 'M13', 'H10', 'O15', 'H11']);
  const hint = computeTacticHints(gomoku, st, 'v16-softgate');
  for (const l of hint.legend) ok(l.count <= 12, '层 ' + l.layer + ' 标记数超封顶：' + l.count);
});
