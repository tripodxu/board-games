// report.spec.mjs — 阶梯报告的纯函数核心 + CLI（ladder 计划 §7 的六项口径）
//
// 测什么：身份归属（黑/白两侧的思考档不同）、成本只在真打了上游的手上算（Rapfi 侧 ms=null 不记 0）、
// 两种占比（战术占单手 / 战术比往返 —— C2 对外报的是后者）、配对矩阵的 A 视角与字典序、
// Rapfi 曲线排序、开局分层（没开局库时为空）、显著性（区间重叠才算不可判）、
// markdown 六节齐全 + 兜底手单列，以及 CLI 的用法错闸门。
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ANCHOR, MIN_GAMES, REPORT_VERSION,
  collectCost, colorCells, colorSplit, costByLevel, costByLevelBlock, costRow, endReasons, isUpstreamMove, layersByResult, moveIdentity,
  openingRows, pairTable, quantiles, screenVersions, versionMatrix, versionMatrixBlock,
  rafiCurve, reportMarkdown, significance, curveComposition, curveDeltas, levelPower, levelTable, levelTableBlock,
} from '../../scripts/lib/report.mjs';
import { reportMain } from '../../scripts/experiment-report.mjs';

/** 合成一局：只按渠道给该有的档位 —— Rapfi 侧战术档留空、Jev 侧思考档留空（与归档导出口径一致）。 */
const game = ({ black = 'official', white = 'rapfi', blackTac = 'v14-live3-fresh', whiteTac = 'v14-live3-fresh',
  blackThink = 500, whiteThink = 500, moves = [], winner = 'black', uid = '', endReason = null } = {}) => ({
  format: 1, gameUid: uid, blackChannel: black, whiteChannel: white,
  blackTactics: black === 'rapfi' ? null : blackTac,
  whiteTactics: white === 'rapfi' ? null : whiteTac,
  blackThink: black === 'rapfi' ? blackThink : null,
  whiteThink: white === 'rapfi' ? whiteThink : null,
  winner, endReason: endReason === null ? undefined : endReason,
  result: winner === 'blue' ? '和棋（盘面满）' : winner === 'black' ? '黑方 获胜（五连）' : '白方 获胜（五连）',
  moves,
});
const jevMove = (ply, side, { ms = 1000, tacMs = 500, prov = 'primary', tv = 'v14-live3-fresh', ch = 'official', tac = null } = {}) =>
  ({ ply, side, notation: 'H8', ai: { ch, tv, ms, tacMs, prov, probs: 'exact', tac } });
const rafiMove = (ply, side) => ({ ply, side, notation: 'E11', ai: { ch: 'rapfi', ms: null, tv: null } });

describe('身份归属 / 上游手判定', () => {
  const g = game();
  it('黑侧 Jev 手 = 渠道|战术档|思考档（非 rapfi 的思考档留空）', () => {
    expect(moveIdentity(g, jevMove(1, '黑方'))).toBe('official|v14-live3-fresh|0');
  });
  it('白侧 Rapfi 手用 whiteThink 当思考档、战术档留空', () => {
    expect(moveIdentity(g, rafiMove(2, '白方'))).toBe('rapfi||500');
  });
  it('只有 ai.ms 是 number 才算上游手（Rapfi 侧 null 不是 0）', () => {
    expect(isUpstreamMove(jevMove(1, '黑方'))).toBe(true);
    expect(isUpstreamMove(rafiMove(2, '白方'))).toBe(false);
    expect(isUpstreamMove({ ply: 3, side: '黑方' })).toBe(false);
  });
});

describe('quantiles / collectCost / costRow', () => {
  it('quantiles 给均值/中位/p90/最差，空数组是 null', () => {
    expect(quantiles([])).toBeNull();
    expect(quantiles([100, 200, 300, 400])).toEqual({ n: 4, mean: 250, median: 200, p90: 400, max: 400, min: 100 });
    expect(quantiles([1, Number.NaN, 'x', 3])).toEqual({ n: 2, mean: 2, median: 1, p90: 3, max: 3, min: 1 });
  });
  it('成本按身份分开攒，Rapfi 手不进桶', () => {
    const games = [
      game({ uid: 'a', moves: [jevMove(1, '黑方', { ms: 1000, tacMs: 400 }), rafiMove(2, '白方'),
        jevMove(3, '黑方', { ms: 2000, tacMs: 600, prov: 'backup' })] }),
      game({ uid: 'b', black: 'official', moves: [jevMove(1, '黑方', { ms: 3000, tacMs: 800 })] }),
    ];
    const { byIdentity, total } = collectCost(games);
    expect([...byIdentity.keys()]).toEqual(['official|v14-live3-fresh|0']);
    const b = byIdentity.get('official|v14-live3-fresh|0');
    expect(b.moves).toBe(3);
    expect(b.ms).toEqual([1000, 2000, 3000]);
    expect(b.tac).toEqual([400, 600, 800]);
    expect(b.prov).toEqual({ primary: 2, backup: 1 });
    expect(total.moves).toBe(3);
  });
  it('costRow 同时给两种占比：战术占单手 = tac/(往返+tac)，战术/往返 = tac/往返', () => {
    const row = costRow('x', { moves: 2, ms: [1000, 1000], tac: [1000, 1000], prov: {} });
    expect(row.perMove).toBe(2000);
    expect(row.shareOfMove).toBe(50);
    expect(row.shareOfRoundTrip).toBe(100);
    expect(costRow('y', { moves: 0, ms: [], tac: [], prov: {} }).ms).toBeNull();
  });
});

describe('costByLevel / costByLevelBlock（成本按 Rapfi 固定预算切开）', () => {
  /* 四局里只有两局「版本 vs Rapfi」有档位：@500 与 @7000；另两局必须被排除
     （版本互殴没档位、Rapfi 互殴双方都是 rapfi），Rapfi vs mock 那种「有档位但一手上游都没打」也不进表。 */
  const games = [
    game({ uid: 'l500', whiteThink: 500, moves: [jevMove(1, '黑方', { ms: 1000, tacMs: 500 }), rafiMove(2, '白方'),
      jevMove(3, '黑方', { ms: 2000, tacMs: 700, prov: 'backup' }), rafiMove(4, '白方')] }),
    game({ uid: 'l7000a', whiteThink: 7000, moves: [jevMove(1, '黑方', { ms: 3000, tacMs: 999 })] }),
    game({ uid: 'l7000b', black: 'rapfi', white: 'official', blackThink: 7000, moves: [rafiMove(1, '黑方'),
      jevMove(2, '白方', { ms: 4000, tacMs: 1000 })] }),
    game({ uid: 'mirror', black: 'official', white: 'official', moves: [jevMove(1, '黑方'), jevMove(2, '白方')] }),
    game({ uid: 'rafi-rafi', black: 'rapfi', white: 'rapfi', blackThink: 1000, whiteThink: 1000,
      moves: [rafiMove(1, '黑方'), rafiMove(2, '白方')] }),
    game({ uid: 'rafi-mock', black: 'rapfi', white: 'mock', blackThink: 9000, moves: [rafiMove(1, '黑方')] }),
    /* 同档混进「Rapfi vs mock」（有档位、零上游手）⇒ 局数不许把它算进来（成本分母不能说大） */
    game({ uid: 'rafi-mock7000', black: 'rapfi', white: 'mock', blackThink: 7000, moves: [rafiMove(1, '黑方')] }),
  ];
  it('按档位归集上游手：没有 Rapfi / 双方都是 Rapfi 的对局都排除，零上游手的档位与局数都排除', () => {
    const { levels, total } = costByLevel(games);
    expect(levels.map((l) => l.thinkMs)).toEqual([500, 7000]);
    /* @7000 有三局落在该档，只有两局真打了上游（第三局是 Rapfi vs mock）⇒ 局数 2 */
    expect(levels.map((l) => l.games)).toEqual([1, 2]);
    expect(levels.map((l) => l.row.moves)).toEqual([2, 2]);
    /* 往返均值 ÷ 该档固定预算 —— Rapfi 逐手耗时没有落盘，只能说「占预算」 */
    /* 中位数是「下中位」（quantiles() 既有口径：偶数个取较小的那个） */
    expect(levels[0].row.ms).toMatchObject({ n: 2, mean: 1500, median: 1000, p90: 2000, max: 2000 });
    expect(levels[0].row.tac).toMatchObject({ mean: 600, median: 500, max: 700 });
    expect(levels[0].shareOfBudget).toBe(300);
    expect(levels[1].row.ms).toMatchObject({ mean: 3500, median: 3000, max: 4000 });
    expect(levels[1].row.shareOfRoundTrip).toBe(28.6);
    expect(levels[1].shareOfBudget).toBe(50);
    expect(total.moves).toBe(4);
    expect(total.prov).toEqual({ primary: 3, backup: 1 });
  });
  it('块渲染：表 + 全轮合计 + 「Rapfi 实际耗时没有落盘」的口径句；没有上游手就不印', () => {
    const md = costByLevelBlock({ games });
    const text = md.join('\n');
    expect(text).toContain('**逐档成本（与 Rapfi 固定预算同框，m08110）**');
    expect(text).toContain('| `rapfi||500` | 1 | 2 | 1500／1000／2000／2000 | 600／500／700／700 | 2100 | 28.6% | 300% |');
    expect(text).toContain('| `rapfi||7000` | 2 | 2 | 3500／3000／4000／4000 |');
    expect(text).toContain('所以只能说预算，不能说「Rapfi 实际用了 X ms」');
    expect(text).toContain('> 全轮合计：Jev 手 4｜');
    /* 有档位但一手上游都没打（Rapfi vs mock 那种）⇒ 该档被 `moves > 0` 过滤掉，块不出现 */
    expect(costByLevelBlock({ games: [game({ uid: 'x', moves: [rafiMove(1, '白方'), rafiMove(2, '黑方')] })] })).toEqual([]);
    expect(costByLevelBlock({})).toEqual([]);
  });
});

describe('pairTable / rafiCurve / openingRows / significance', () => {
  const recs = [
    { black: 'A', white: 'B', blackScore: 1 },   // A 胜
    { black: 'B', white: 'A', blackScore: 0 },   // A 胜（执白）
    { black: 'A', white: 'B', blackScore: 0.5 }, // 和
  ];
  it('配对矩阵 A 取字典序在前者，得分率是 A 的视角', () => {
    const [p] = pairTable(recs);
    expect(p).toMatchObject({ a: 'A', b: 'B', games: 3, aWins: 2, draws: 1, bWins: 0 });
    expect(p.aHits).toBe(2.5);
    expect(p.aRate).toBeCloseTo(2.5 / 3, 10);
    expect(p.enough).toBe(3 >= MIN_GAMES);
  });
  it('同身份对局不计入配对矩阵', () => {
    expect(pairTable([{ black: 'A', white: 'A', blackScore: 1 }])).toEqual([]);
  });
  it('Rapfi 曲线只取 rapfi 身份并按思考档升序', () => {
    const rows = [
      { identity: 'rapfi||2000' }, { identity: 'official|v14-live3-fresh|0' },
      { identity: 'rapfi||500' }, { identity: 'rapfi|v14-live3-fresh|1000' },
    ];
    expect(rafiCurve(rows).map((p) => p.thinkMs)).toEqual([500, 1000, 2000]);
    expect(rafiCurve(rows)[0].identity).toBe('rapfi||500');
  });
  it('相邻档差：给 ΔElo 并判两档 BT 区间是否重叠（重叠就不许说更强）', () => {
    const rows = [
      { identity: 'rapfi||500', rating: 1480, btLo: -20, btHi: 20 },
      { identity: 'rapfi||2000', rating: 1520, btLo: 10, btHi: 40 },  // 与上一档重叠
      { identity: 'rapfi||10000', rating: 1560, btLo: 60, btHi: 90 }, // 与上一档不重叠
    ];
    const ds = curveDeltas(rafiCurve(rows));
    expect(ds.map((d) => [d.fromMs, d.toMs, Number(d.delta.toFixed(1))]))
      .toEqual([[500, 2000, 40], [2000, 10000, 40]]);
    expect(ds.map((d) => d.overlap)).toEqual([true, false]);
    expect(curveDeltas(rafiCurve([{ identity: 'rapfi||500', rating: 1500 }]))).toEqual([]);
    expect(curveDeltas(rafiCurve([{ identity: 'rapfi||500', rating: 1500 },
      { identity: 'rapfi||1000', rating: 1510 }]))[0].overlap).toBeNull(); // 缺 btLo/btHi ⇒ 不判
  });
  it('曲线组成：逐档对手集 + 一致性（同身份镜像局不算对手）', () => {
    const comp = curveComposition([
      { black: 'rapfi||500', white: 'official|v14-live3-fresh|0', blackScore: 1 },
      { black: 'official|v11-vct|0', white: 'rapfi||500', blackScore: 0 },
      { black: 'rapfi||500', white: 'rapfi||500', blackScore: 1 },       // 镜像：不计入对手集
      { black: 'official|v14-live3-fresh|0', white: 'official|v11-vct|0', blackScore: 1 }, // 与 Rapfi 无关
    ]);
    expect(comp.levels).toHaveLength(1);
    expect(comp.levels[0]).toMatchObject({ identity: 'rapfi||500', thinkMs: 500, games: 2 });
    expect(comp.levels[0].opps).toEqual(['official|v11-vct|0', 'official|v14-live3-fresh|0']);
    expect(comp.consistent).toBe(true);   // 只有一档 ⇒ 谈不上不一致
    const two = curveComposition([
      { black: 'rapfi||500', white: 'official|v14-live3-fresh|0', blackScore: 1 },
      { black: 'rapfi||7000', white: 'official|v11-vct|0', blackScore: 1 },
    ]);
    expect(two.levels.map((l) => l.thinkMs)).toEqual([500, 7000]);
    expect(two.consistent).toBe(false);
    expect(curveComposition([])).toEqual({ levels: [], consistent: true });
  });
  it('逐档合并（版本视角）：只收版本 vs Rapfi，换色取反、和棋半分', () => {
    const t = levelTable([
      { black: 'rapfi||500', white: 'official|v10-live3|0', blackScore: 0 },   // Rapfi 执黑负 ⇒ 版本胜
      { black: 'official|v10-live3|0', white: 'rapfi||500', blackScore: 1 },   // 换色后版本仍胜
      { black: 'rapfi||500', white: 'official|v11-vct|0', blackScore: 0.5 },   // 和
      { black: 'official|v10-live3|0', white: 'rapfi||1000', blackScore: 0 },  // 版本执黑负 ⇒ @1000 记负
      { black: 'official|v10-live3|0', white: 'official|v11-vct|0', blackScore: 1 }, // 版本互殴：没有档位
      { black: 'rapfi||500', white: 'rapfi||1000', blackScore: 1 },            // Rapfi 互殴：没有版本侧
      { black: 'rapfi||500', white: 'mock||500', blackScore: 1 },              // 对手不是我们的版本
    ]);
    expect(t.levels.map((l) => l.thinkMs)).toEqual([500, 1000]);
    expect(t.levels[0]).toMatchObject({ identity: 'rapfi||500', games: 3, w: 2, d: 1, l: 0, hits: 2.5 });
    expect(t.levels[0].rate).toBeCloseTo(2.5 / 3, 10);
    expect(t.levels[0].rapfiRate).toBeCloseTo(0.5 / 3, 10);       // Rapfi 侧 = 1 − 版本侧
    expect(t.levels[0].opps).toEqual([{ id: 'official|v10-live3|0', games: 2 }, { id: 'official|v11-vct|0', games: 1 }]);
    expect(t.levels[0].ci.lo).toBeLessThan(t.levels[0].rate);
    expect(t.levels[1]).toMatchObject({ games: 1, w: 0, d: 0, l: 1, rate: 0, rapfiRate: 1 });
    expect(levelTable([])).toEqual({ levels: [], deltas: [], consistent: true });
  });
  it('逐档合并：相邻档差 + Wilson 重叠 + 组成一致性（各档「对手 × 局数」不同就不许连曲线）', () => {
    /* n=1 时 Wilson 区间宽到几乎覆盖 0–1（100% 的下界约 20.7%），所以要 10 局才谈得上「不重叠」。 */
    const rep = (level, n, blackScore) => Array.from({ length: n },
      () => ({ black: `rapfi||${level}`, white: 'official|v10-live3|0', blackScore }));
    const same = levelTable([...rep(500, 10, 0), ...rep(1000, 10, 1)]);   // @500 版本全胜、@1000 全负
    expect(same.consistent).toBe(true);                            // 组成相同 ⇒ 可读成档位效应
    expect(same.levels.map((l) => [l.thinkMs, l.games, l.rate])).toEqual([[500, 10, 1], [1000, 10, 0]]);
    expect(same.deltas).toHaveLength(1);
    expect(same.deltas[0]).toMatchObject({ fromMs: 500, toMs: 1000 });
    expect(same.deltas[0].delta).toBeCloseTo(-1, 10);              // 100% → 0%
    expect(same.deltas[0].overlap).toBe(false);                    // 10 局全胜 vs 10 局全负 ⇒ 区间不重叠
    const skew = levelTable([
      { black: 'rapfi||500', white: 'official|v10-live3|0', blackScore: 0 },
      { black: 'rapfi||500', white: 'official|v11-vct|0', blackScore: 0 },
      { black: 'rapfi||7000', white: 'official|v10-live3|0', blackScore: 0 },   // @7000 缺 v11 ⇒ 组成不同
    ]);
    expect(skew.consistent).toBe(false);
    expect(skew.levels[1].opps).toEqual([{ id: 'official|v10-live3|0', games: 1 }]);
  });
  it('levelPower：给「要多少局/档」的量级（按观测率估算，扫描到 cap 就报 null）', () => {
    const lv = (level, n, rate) => ({ thinkMs: level, games: n, rate });
    /* 100% vs 0%：10 局就分得开 */
    const far = levelPower([lv(500, 10, 1), lv(1000, 10, 0)]);
    expect(far).toHaveLength(1);
    expect(far[0]).toMatchObject({ fromMs: 500, toMs: 1000, needN: 10, atTarget: true });
    /* L4 实测形状：73.5%（100 局）vs 53.8%（80 局） ⇒ 每档 ~95 局就够 */
    const l4 = levelPower([lv(2000, 100, 0.735), lv(7000, 80, 0.538)]);
    expect(l4[0].needN).toBeGreaterThan(80);
    expect(l4[0].needN).toBeLessThan(120);
    expect(l4[0].atTarget).toBe(true);            // 目标 200 局/档够
    /* 差得少 ⇒ 扫到 cap 也分不开（1 pt 的差约需 3.8 万局/档，远超 cap） */
    const close = levelPower([lv(1000, 100, 0.51), lv(2000, 100, 0.5)]);
    expect(close[0].needN).toBeNull();
    expect(close[0].atTarget).toBe(false);
    expect(levelPower([lv(500, 10, 1)])).toEqual([]);
  });
  it('逐档合并块：表 + 相邻档读数 + 组成两态（一致打 ✓、不一致印 ⚠）', () => {
    const even = levelTableBlock({ records: [
      { black: 'rapfi||500', white: 'official|v10-live3|0', blackScore: 0 },
      { black: 'rapfi||1000', white: 'official|v10-live3|0', blackScore: 0 },
    ] });
    const md = even.join('\n');
    expect(md).toContain('**逐档合并（版本视角）**');
    expect(md).toContain('| 500 ms | 1 | 1–0–0 | 100.0% |');
    expect(md).toContain('- 相邻档（版本侧）：500 → 1000 +0.0pt');
    expect(md).toContain('✓ 组成一致');
    expect(md).toContain('要分开相邻档要多少局（**按观测率估算**，不是检验）');
    expect(md).toContain('500 → 1000 约需 **>20000 局/档（当前落差下基本分不开）**');   // 两档同为 100% ⇒ 分不开
    const skewed = levelTableBlock({ records: [
      { black: 'rapfi||500', white: 'official|v10-live3|0', blackScore: 0 },
      { black: 'rapfi||7000', white: 'official|v11-vct|0', blackScore: 0 },
    ] }).join('\n');
    expect(skewed).toContain('⚠ **各档组成不同 ⇒ 此刻不许把档位合并值连成一条曲线**');
    expect(skewed).toContain('本表组成不一致 ⇒ 这些 n 基于被污染的落差，只当量级看');
    expect(levelTableBlock({ records: [] })).toEqual([]);
  });
  it('开局分层按 events 给的开局键分组；没有键就是空（= 报告写「未启用开局库」）', () => {
    const g1 = game({ uid: '1' });
    const g2 = game({ uid: '2' });
    const g3 = game({ uid: '3' });
    expect(openingRows([g1, g2], () => null)).toEqual([]);
    const rows = openingRows([g1, g2, g3], (g) => (g === g3 ? 'B2' : 'A1'));
    expect(rows.map((r) => [r.opening, r.games])).toEqual([['A1', 2], ['B2', 1]]);
    expect(rows[0].pairs[0]).toMatchObject({ games: 2 });
  });
  it('显著性：区间重叠的身份对才算「不可判」，样本 <50 单列出来', () => {
    const rows = [
      { identity: 'a', ci: { lo: 0.2, hi: 0.6 }, halfPt: 20, enough: true },
      { identity: 'b', ci: { lo: 0.5, hi: 0.9 }, halfPt: 20, enough: true },
      { identity: 'c', ci: { lo: 0.95, hi: 1 }, halfPt: 2.5, enough: false },
    ];
    const s = significance(rows, [{ a: 'a', b: 'b', games: 4, enough: false }]);
    expect(s.overlapCount).toBe(1);            // a↔b 重叠；c 不相交
    expect(s.overlapPairs).toEqual(['a ↔ b']);
    expect(s.thin).toEqual(['c']);
    expect(s.thinPairs).toEqual(['a vs b（4 局）']);
    expect(s.widthMin).toBe(5);
    expect(s.widthMax).toBe(40);
  });
});

describe('reportMarkdown：六节齐全', () => {
  const base = () => {
    const games = [
      game({ uid: 'a', moves: [jevMove(1, '黑方', { prov: 'backup' }), rafiMove(2, '白方')] }),
      game({ uid: 'b', black: 'rapfi', white: 'official', moves: [rafiMove(1, '黑方'),
        jevMove(2, '白方', { ms: 2000, tacMs: 250, prov: 'primary' })] }),
    ];
    const records = [
      { black: 'official|v14-live3-fresh|0', white: 'rapfi||500', blackScore: 1 },
      { black: 'rapfi||500', white: 'official|v14-live3-fresh|0', blackScore: 0 },
    ];
    const rows = [
      { identity: 'official|v14-live3-fresh|0', rating: 1510, games: 2, w: 2, d: 0, l: 0, rate: 1,
        ci: { lo: 0.34, hi: 1 }, halfPt: 33, enough: false, btDelta: 30, btLo: 10, btHi: 50, btWidth: 40, btDraws: 3 },
      { identity: 'rapfi||500', rating: 1490, games: 2, w: 0, d: 0, l: 2, rate: 0,
        ci: { lo: 0, hi: 0.66 }, halfPt: 33, enough: false, btDelta: 0, btLo: 0, btHi: 0, btWidth: 0, btDraws: 3 },
    ];
    const pairs = pairTable(records);
    const cost = collectCost(games);
    return {
      version: REPORT_VERSION, batchId: 't1', generatedAt: '2026-10-04T00:00:00Z', dirs: ['.work/remote/t1'],
      rounds: 1, games, records, rows, pairs, openings: [],
      cost: { rows: [...cost.byIdentity.entries()].map(([id, b]) => costRow(id, b)), totalRow: costRow('全轮合计', cost.total) },
      runtime: 'store=local upstream=direct repoHead=abc123', artifacts: [{ path: 'round-1/games.jsonl', bytes: 10, lines: 2, sha256: 'deadbeefcafe' }],
      anchor: DEFAULT_ANCHOR, bootstrap: 100, seed: 7, tags: ['exp-1'],
    };
  };
  it('六节标题齐全，且把兜底手与读数纪律印出来', () => {
    const md = reportMarkdown(base());
    for (const h of ['# 阶梯报告：t1', '## 1 能力表', '## 2 Rapfi「思考时间 → Elo」曲线',
      '## 3 成本表', '## 4 配对样本矩阵', '## 5 显著性说明', '## 6 产物清单']) {
      expect(md).toContain(h);
    }
    expect(md).toContain('backup 1');                     // 兜底手在成本表里单列
    expect(md).toContain('本轮未启用开局库');               // openings 为空时的说明
    expect(md).toContain('deadbeefcafe');                 // 产物 sha256 前 12 位
    expect(md).toContain('⚠ <50');                        // 样本不足标注
    expect(md).toContain('对手集不同的身份之间**不可横比**'); // §1：得分率是原始计数，不能跨对手集比较
    expect(md).toContain('未计入主口径');                   // 兜底手不计入主口径
  });
  it('曲线 ≥2 档时印相邻档差与「区间重叠」读数', () => {
    const m = base();
    m.rows = [
      { identity: 'rapfi||500', rating: 1480, games: 60, w: 20, d: 5, l: 35, rate: 0.375,
        ci: { lo: 0.26, hi: 0.5 }, halfPt: 12, enough: true, btDelta: -20, btLo: -50, btHi: 10, btWidth: 60, btDraws: 5 },
      { identity: 'rapfi||2000', rating: 1520, games: 60, w: 25, d: 6, l: 29, rate: 0.467,
        ci: { lo: 0.34, hi: 0.6 }, halfPt: 13, enough: true, btDelta: 20, btLo: -5, btHi: 55, btWidth: 60, btDraws: 6 },
    ];
    const md = reportMarkdown(m);
    expect(md).toContain('相邻档差：500→2000：+40.0（区间重叠）');
    expect(md).toContain('1 对区间重叠');
    expect(md).toContain('每档样本：500 ms 60 局、2000 ms 60 局；没有样本 < 50 局的档');
    expect(md).not.toContain('各档对手集不同'); // base() 只有一档对手 ⇒ 组成一致
  });
  it('各档对手集不同时印组成警告（档位差里混着「对手换了」，L4 实测）', () => {
    const m = base();
    m.rows = [
      { identity: 'rapfi||500', rating: 1480, games: 4, w: 2, d: 0, l: 2, rate: 0.5,
        ci: { lo: 0.15, hi: 0.85 }, halfPt: 35, enough: false, btDelta: 0, btLo: -30, btHi: 30, btWidth: 60, btDraws: 2 },
      { identity: 'rapfi||7000', rating: 1520, games: 2, w: 0, d: 1, l: 1, rate: 0.25,
        ci: { lo: 0.03, hi: 0.65 }, halfPt: 35, enough: false, btDelta: 40, btLo: 0, btHi: 80, btWidth: 80, btDraws: 2 },
    ];
    m.records = [
      { black: 'official|v14-live3-fresh|0', white: 'rapfi||500', blackScore: 1 },
      { black: 'rapfi||500', white: 'official|v14-live3-fresh|0', blackScore: 0 },
      { black: 'official|v11-vct|0', white: 'rapfi||500', blackScore: 1 },
      { black: 'rapfi||500', white: 'official|v11-vct|0', blackScore: 0 },
      { black: 'official|v11-vct|0', white: 'rapfi||7000', blackScore: 1 },   // v14 这一档还没跑到
      { black: 'rapfi||7000', white: 'official|v11-vct|0', blackScore: 0.5 },
    ];
    const md = reportMarkdown(m);
    expect(md).toContain('各档对手集不同');
    expect(md).toContain('500 ms（4 局）打过 2 个对手：official|v11-vct|0、official|v14-live3-fresh|0');
    expect(md).toContain('7000 ms（2 局）打过 1 个对手：official|v11-vct|0');
    expect(md).toContain('不等于**档位效应');
  });
  it('开局分层非空时印每个开局的配对行', () => {
    const m = base();
    m.openings = openingRows(m.games, (g) => (g.gameUid === 'a' ? 'A1' : 'B2'));
    const md = reportMarkdown(m);
    expect(md).toContain('| `A1` |');
    expect(md).not.toContain('本轮未启用开局库');
  });
});

describe('逐色格 / 分开颜色（L3 第一晚的教训：先手优势 85%，只看总分会被带跑）', () => {
  const recs = [
    { black: 'rapfi||500', white: 'rapfi||1000', blackScore: 1 },
    { black: 'rapfi||1000', white: 'rapfi||500', blackScore: 0 },   // 换色后 1000 输
    { black: 'rapfi||2000', white: 'rapfi||500', blackScore: 1 },
    { black: 'rapfi||500', white: 'rapfi||2000', blackScore: 0.5 }, // 和棋
  ];
  it('colorCells 按「黑身份 vs 白身份」成格，并单独报先手优势与和棋', () => {
    const { cells, games, blackWins, draws } = colorCells(recs);
    expect(games).toBe(4);
    expect(blackWins).toBe(2);
    expect(draws).toBe(1);
    const key = (b, w) => cells.find((c) => c.black === b && c.white === w);
    expect(key('rapfi||500', 'rapfi||1000')).toMatchObject({ games: 1, blackWins: 1, whiteWins: 0 });
    expect(key('rapfi||1000', 'rapfi||500')).toMatchObject({ games: 1, blackWins: 0, whiteWins: 1 });
    expect(key('rapfi||500', 'rapfi||2000')).toMatchObject({ games: 1, draws: 1 });
    expect(cells.map((c) => c.games)).toEqual([1, 1, 1, 1]);
  });
  it('colorSplit 把同一身份的执黑/执白战绩分开', () => {
    const rows = colorSplit(recs);
    const of = (id) => rows.find((r) => r.identity === id);
    expect(of('rapfi||500')).toMatchObject({ blackGames: 2, blackWins: 1, blackDraws: 1, whiteGames: 2, whiteWins: 1, whiteDraws: 0 });
    expect(of('rapfi||1000')).toMatchObject({ blackGames: 1, blackWins: 0, whiteGames: 1, whiteWins: 0 });
    expect(of('rapfi||2000')).toMatchObject({ blackGames: 1, blackWins: 1, whiteGames: 1, whiteWins: 0, whiteDraws: 1 });
  });
  it('markdown 第 4 节印出逐色格两张表与先手优势行', () => {
    const md = reportMarkdown({
      batchId: 't1', generatedAt: '2026-10-04T00:00:00Z', dirs: ['d'], rounds: 1,
      games: [], records: recs, rows: [], pairs: pairTable(recs), openings: [],
      cost: { rows: [], totalRow: costRow('全轮合计', collectCost([]).total) },
      runtime: '', artifacts: [], anchor: DEFAULT_ANCHOR, bootstrap: 0, seed: 1, tags: [],
    });
    expect(md).toContain('逐色格（同一格内颜色固定');
    expect(md).toContain('本轮黑方胜 2/4（50.0%）｜和棋 1');
    expect(md).toContain('| rapfi||500（黑） vs rapfi||1000（白） | 1 | 1 | 0 | 0 |');
    expect(md).toContain('按身份分开颜色');
    // 「胜–和–负」三列 + 得分率（与第 1 节同口径 =（胜 + 和/2）÷ 局数）：
    // 旧版把「非胜局」写成「负」、又把胜率标成得分率 ⇒ 和棋多的批次会被读成惨败。
    expect(md).toContain('| rapfi||500 | 2–1–1 | 62.5% | 1/2 | 1/2 |');
    expect(md).toContain('| rapfi||1000 | 0–0–2 | 0.0% | 0/1 | 0/1 |');
    expect(md).toContain('| rapfi||2000 | 1–1–0 | 75.0% | 1/1 | 0/1 |');
  });
});

describe('版本筛查判读（阶梯计划 §7 规则机械化：只决定下一场跑什么）', () => {
  /** 一对里 A 先执黑 10 局、再执白 10 局（阶梯每局换色，所以必须是这种形状）。 */
  const pair = (a, b, { blackWins = 5, blackDraws = 0, whiteWins = 5, whiteDraws = 0 } = {}) => {
    const out = [];
    const N = 10;
    for (let i = 0; i < N; i += 1) {
      const score = i < blackWins ? 1 : i < blackWins + blackDraws ? 0.5 : 0;
      out.push({ black: a, white: b, blackScore: score });
    }
    for (let i = 0; i < N; i += 1) {
      /* A 执白：A 得 `whiteWins/whiteDraws` ⇒ 黑方（b）得分是它的补 */
      const aScore = i < whiteWins ? 1 : i < whiteWins + whiteDraws ? 0.5 : 0;
      out.push({ black: b, white: a, blackScore: 1 - aScore });
    }
    return out;
  };
  const V13 = 'official|v13-pressure-gate|0';
  const V11 = 'official|v11-vct|0';
  const V14 = 'official|v14-live3-fresh|0';

  it('非筛查形态返回 null：Rapfi 对局、只有 2 版、超过 5 版', () => {
    expect(screenVersions([{ black: 'rapfi||500', white: 'rapfi||1000', blackScore: 1 }])).toBeNull();
    expect(screenVersions(pair(V13, V11))).toBeNull();
    const six = ['v10', 'v11', 'v12', 'v13', 'v14', 'v15'].map((v) => `official|${v}|0`);
    expect(screenVersions(six.flatMap((v, i) => (i ? pair(six[0], v) : [])))).toBeNull();
  });

  it('只跟 Rapfi 交过手的版本（L2 形态）不算筛查对象 ⇒ null；混跑时只按交过手的子集判', () => {
    const V10 = 'official|v10-live3|0';
    const l2 = [...pair(V10, 'rapfi||500'), ...pair(V11, 'rapfi||1000'), ...pair(V13, 'rapfi||2000')];
    expect(screenVersions(l2)).toBeNull();
    const s = screenVersions([...l2,
      ...pair(V13, V11, { blackWins: 7, whiteWins: 6 }),
      ...pair(V13, V14, { blackWins: 7, whiteWins: 5 }),
      ...pair(V11, V14, { blackWins: 5, whiteWins: 4 }),
    ]);
    expect(s.versions).toEqual([V11, V13, V14]);   // 只跟 Rapfi 交过手的 v10 不进筛查
    expect(s.games).toBe(60);                      // 版本 vs Rapfi 的对局不计入筛查局数
    expect(s.verdict).toBe('pass');
  });

  it('三对全过 ⇒ 全序 + 判据全绿 + verdict=pass（头部两版是决赛对）', () => {
    const recs = [
      ...pair(V13, V11, { blackWins: 7, whiteWins: 6 }),   // v13 0.65
      ...pair(V13, V14, { blackWins: 7, whiteWins: 5 }),   // v13 0.60
      ...pair(V11, V14, { blackWins: 5, whiteWins: 4 }),   // v11 0.45 ⇒ v14 0.55
    ];
    const s = screenVersions(recs);
    expect(s.complete).toBe(true);
    expect(s.order).toEqual([V13, V14, V11]);
    expect(s.consistent).toBe(true);
    expect(s.indirect.every((i) => i.agrees !== false)).toBe(true);
    expect(s.colorFlips).toEqual([]);
    expect(s.games).toBe(60);
    expect(s.minPairGames).toBe(20);
    expect(s.verdict).toBe('pass');
    expect(s.finalPair).toEqual([V13, V14]);
  });

  it('点估计成环 ⇒ 判据 ① 不过（run-l1）', () => {
    const recs = [
      ...pair(V11, V13, { blackWins: 7, whiteWins: 7 }),   // v11 0.70
      ...pair(V13, V14, { blackWins: 7, whiteWins: 7 }),   // v13 0.70
      ...pair(V14, V11, { blackWins: 7, whiteWins: 7 }),   // v14 0.70
    ];
    const s = screenVersions(recs);
    expect(s.consistent).toBe(false);
    expect(s.cycles.length).toBe(1);
    expect(s.verdict).toBe('run-l1');
    expect(s.reasons.join('｜')).toMatch(/环/);
  });

  it('判据 ②：共同对手方向与直接比较相反 ⇒ 抓出来（直接比较本身仍是无环的）', () => {
    const recs = [
      ...pair(V13, V11, { blackWins: 6, whiteWins: 6 }),   // 直接 v13 0.60（+10pt）
      ...pair(V11, V14, { blackWins: 6, whiteWins: 5 }),   // v11 0.55；v13 对 v14 也是 0.55 ⇒ 间接 −5pt
      ...pair(V13, V14, { blackWins: 6, whiteWins: 5 }),   // v13 0.55
    ];
    const s = screenVersions(recs);
    expect(s.consistent).toBe(true);
    const bad = s.indirect.filter((i) => i.agrees === false);
    expect(bad.map((i) => i.pair)).toEqual([[V11, V14]]);
    expect(bad[0].via).toBe(V13);
    expect(s.verdict).toBe('run-l1');
    expect(s.reasons.join('｜')).toMatch(/间接比较与直接比较不同向/);
  });

  it('判据 ③：A 执黑赢、执白输 ⇒ 换色翻面', () => {
    const recs = [
      ...pair(V13, V11, { blackWins: 8, whiteWins: 2 }),   // v13 执黑 80%／执白 20% ⇒ 落到 a=V11 视角就是 80%/20% 反着
      ...pair(V13, V14, { blackWins: 7, whiteWins: 6 }),
      ...pair(V11, V14, { blackWins: 5, whiteWins: 4 }),
    ];
    const s = screenVersions(recs);
    expect(s.colorFlips).toHaveLength(1);
    expect(s.colorFlips[0]).toMatchObject({ pair: [V11, V13], asBlack: 0.8, asWhite: 0.2 });
    expect(s.verdict).toBe('run-l1');
    expect(s.reasons.join('｜')).toMatch(/换色翻面/);
  });

  it('只凑齐 2/3 对 ⇒ complete=false，按 §7 直接跑 L1', () => {
    const s = screenVersions([...pair(V13, V11), ...pair(V13, V14)]);
    expect(s.complete).toBe(false);
    expect(s.verdict).toBe('run-l1');
    expect(s.reasons[0]).toMatch(/只凑齐 2\/3 对/);
  });

  it('markdown 第 4 节印筛查判读块；不是筛查形态就不出现', () => {
    const model = (recs) => ({
      batchId: 't1', generatedAt: '2026-10-05T00:00:00Z', dirs: ['d'], rounds: 3,
      games: [], records: recs, rows: [], pairs: pairTable(recs), openings: [],
      cost: { rows: [], totalRow: costRow('全轮合计', collectCost([]).total) },
      runtime: '', artifacts: [], anchor: DEFAULT_ANCHOR, bootstrap: 0, seed: 1, tags: [],
    });
    const recs = [
      ...pair(V13, V11, { blackWins: 7, whiteWins: 6 }),
      ...pair(V13, V14, { blackWins: 7, whiteWins: 5 }),
      ...pair(V11, V14, { blackWins: 5, whiteWins: 4 }),
    ];
    const md = reportMarkdown(model(recs));
    expect(md).toContain('版本筛查判读（阶梯计划 §7 规则机械化');
    expect(md).toContain(`- 全序（点估计）：${V13} > ${V14} > ${V11}`);
    expect(md).toContain('判据 ① 全序无环 ✅');
    expect(md).toContain('判据 ② 共同对手');
    expect(md).toContain('判据 ③ 逐色格：无换色翻面 ✅');
    expect(md).toContain('（< 50 ⇒ 只作筛查，不能写进结论）');
    expect(md).toContain(`**有值得决赛的差距** ⇒ 只补决赛对 \`${V13} vs ${V14}\``);
    expect(reportMarkdown(model([{ black: 'rapfi||500', white: 'rapfi||1000', blackScore: 1 }])))
      .not.toContain('版本筛查判读');
  });
});

describe('版本 × 共同对手矩阵（第二把尺子：同一版本分别去打同样的对手；不改变任何结论的强度）', () => {
  /** 合成一个格子：`wins/draws/losses` 是**版本视角**，并让版本逐局换色（覆盖「执白取 1 − blackScore」这支）。 */
  const cell = (version, opponent, { wins = 0, draws = 0, losses = 0 } = {}) => {
    const scores = [...Array(wins).fill(1), ...Array(draws).fill(0.5), ...Array(losses).fill(0)];
    return scores.map((s, i) => (i % 2 === 0
      ? { black: version, white: opponent, blackScore: s }
      : { black: opponent, white: version, blackScore: 1 - s }));
  };
  const V10 = 'official|v10-live3|0';
  const V11 = 'official|v11-vct|0';
  const V12 = 'official|v12-vct-def|0';
  const V13 = 'official|v13-pressure-gate|0';

  it('版本视角成立（执白也算自己赢）、列只留共同对手、单版本打过的对手另列', () => {
    const m = versionMatrix([
      ...cell(V11, 'rapfi||2000', { wins: 4 }),
      ...cell(V10, 'rapfi||2000', { wins: 3, losses: 1 }),
      ...cell(V11, 'rapfi||500', { wins: 2, losses: 2 }),   // 只有 v11 打过 ⇒ 不是共同对手
    ]);
    expect(m.versions).toEqual([V10, V11]);
    expect(m.opponents).toEqual(['rapfi||2000']);
    expect(m.skipped).toEqual(['rapfi||500']);
    const v11 = m.matrix.find((r) => r.version === V11);
    expect(v11.cells[0]).toMatchObject({ games: 4, wins: 4, draws: 0, losses: 0, rate: 1 });
    expect(v11.cells[0].ci.lo).toBeGreaterThan(0.5);        // 执白的 2 局也算成胜
    expect(v11.total).toMatchObject({ games: 4, rate: 1 });
    expect(m.matrix.find((r) => r.version === V10).total.rate).toBeCloseTo(0.75, 10);
  });

  it('版本 <2 / 没有共同对手 ⇒ null（这块不印）', () => {
    expect(versionMatrix(cell(V11, 'rapfi||2000', { wins: 2 }))).toBeNull();
    expect(versionMatrix([...cell(V11, 'rapfi||2000', { wins: 1 }), ...cell(V10, 'rapfi||500', { wins: 1 })]))
      .toBeNull();
  });

  it('判据 ②：一对版本在 ≥2 个共同对手上同向 ⇒ consistent=true；只有 1 个共同对手 ⇒ null（无从检验）', () => {
    const two = versionMatrix([
      ...cell(V11, 'rapfi||2000', { wins: 4 }),
      ...cell(V10, 'rapfi||2000', { wins: 2, losses: 2 }),
      ...cell(V11, 'rapfi||7000', { wins: 3, losses: 1 }),
      ...cell(V10, 'rapfi||7000', { wins: 1, losses: 3 }),
    ]);
    expect(two.consistent).toBe(true);
    expect(two.pairDirs).toHaveLength(1);
    expect(two.pairDirs[0]).toMatchObject({ a: V10, b: V11, flip: false });
    expect(two.pairDirs[0].dirs.map((d) => d.d)).toEqual([-0.5, -0.5]);
    const one = versionMatrix([
      ...cell(V11, 'rapfi||2000', { wins: 4 }),
      ...cell(V10, 'rapfi||2000', { wins: 2, losses: 2 }),
    ]);
    expect(one.consistent).toBeNull();
    expect(one.pairDirs).toEqual([]);
  });

  it('判据 ② 不通过：两个共同对手上方向相反 ⇒ 点名翻转对与档位', () => {
    const m = versionMatrix([
      ...cell(V12, 'rapfi||500', { wins: 4 }),
      ...cell(V13, 'rapfi||500', { wins: 2, losses: 2 }),
      ...cell(V12, 'rapfi||2000', { wins: 1, losses: 3 }),
      ...cell(V13, 'rapfi||2000', { wins: 3, losses: 1 }),
    ]);
    expect(m.consistent).toBe(false);
    expect(m.flips).toHaveLength(1);
    expect(m.flips[0].dirs.map((d) => [d.opponent, d.d])).toEqual([['rapfi||500', 0.5], ['rapfi||2000', -0.5]]);
  });

  it('列序：Rapfi 档按思考时间升序在前；块里印表格 + 逐档序 + 判读句', () => {
    const recs = [
      ...cell(V11, 'rapfi||10000', { wins: 4 }),
      ...cell(V10, 'rapfi||10000', { wins: 2, losses: 2 }),
      ...cell(V11, 'rapfi||7000', { wins: 4 }),
      ...cell(V10, 'rapfi||7000', { wins: 2, losses: 2 }),
    ];
    expect(versionMatrix(recs).opponents).toEqual(['rapfi||7000', 'rapfi||10000']);
    const block = versionMatrixBlock({ records: recs }).join('\n');
    expect(block).toContain('第二把尺子');
    expect(block).toContain('| 版本 | rapfi||7000 | rapfi||10000 | 合并（对上述对手） |');
    expect(block).toContain(`- ${V11} > ${V10}｜2 个共同对手：@7000 +50.0pt、@10000 +50.0pt`);
    expect(block).toContain('判据 ② 通过');
    expect(versionMatrixBlock({ records: cell(V11, 'rapfi||2000', { wins: 2 }) })).toEqual([]);
  });

  it('全平的一对：判据 ② 通过但写成「不可分」，不假装有序', () => {
    const block = versionMatrixBlock({ records: [
      ...cell(V11, 'rapfi||2000', { wins: 2, losses: 2 }),
      ...cell(V10, 'rapfi||2000', { wins: 2, losses: 2 }),
      ...cell(V11, 'rapfi||7000', { wins: 2, losses: 2 }),
      ...cell(V10, 'rapfi||7000', { wins: 2, losses: 2 }),
    ] }).join('\n');
    expect(block).toContain(`${V10} vs ${V11}`);
    expect(block).toContain('**全平、不可分**');
    expect(block).not.toContain(`${V11} > ${V10}`);
  });
});

describe('收尾机制 / 接管层 × 结果（解释性和棋与败局，规则 11；不参与判强）', () => {
  /** 两局：一局五连（黑胜）、一局满盘和；接管层写 `ai.tac`（`ai.tv` 是版本，别拿错）。 */
  const withEnds = () => [
    game({ uid: 'a', winner: 'black', endReason: '五连',
      moves: [jevMove(1, '黑方', { tac: 'pressureGate' }), rafiMove(2, '白方'), jevMove(3, '黑方', { tac: 'vcfDefense' })] }),
    game({ uid: 'b', winner: 'blue', endReason: '棋盘已满',
      moves: [jevMove(1, '黑方', { tac: 'pressureGate' }), rafiMove(2, '白方')] }),
  ];
  it('endReasons：收尾原因降序、和棋手数、手数分位', () => {
    const e = endReasons(withEnds());
    expect(e.reasons).toEqual([{ reason: '五连', count: 1 }, { reason: '棋盘已满', count: 1 }]);
    expect(e.draws).toEqual({ count: 1, plies: [2] });
    expect(e.plies).toMatchObject({ n: 2, mean: 2.5, median: 2, p90: 3, max: 3 });
    expect(e.unscored).toBe(0);
  });
  it('缺 endReason 记「未知」；无胜负的局算 unscored（不计和棋）', () => {
    const e = endReasons([
      game({ uid: 'x', winner: 'blue', moves: [] }),
      { gameUid: 'y', blackChannel: 'official', whiteChannel: 'rapfi', result: '进行中', moves: [] },
    ]);
    expect(e.reasons).toEqual([{ reason: '未知', count: 2 }]);
    expect(e.draws.count).toBe(1);
    expect(e.unscored).toBe(1);
  });
  it('layersByResult：层按开火次数降序，战绩取该身份视角（和棋 0.5）', () => {
    const rows = layersByResult(withEnds());
    expect(rows.map((r) => r.identity)).toEqual(['official|v14-live3-fresh|0']);
    expect(rows[0]).toMatchObject({ games: 2, moves: 3 });
    expect(rows[0].layers).toEqual([
      { layer: 'pressureGate', total: 2, win: 1, draw: 1, loss: 0 },
      { layer: 'vcfDefense', total: 1, win: 1, draw: 0, loss: 0 },
    ]);
  });
  it('layersByResult：只算战术层真的接了手的那几手（`ai.tac` 为空的手不进表）', () => {
    const rows = layersByResult([game({ uid: 'a', moves: [jevMove(1, '黑方'), jevMove(3, '黑方', { tac: 'win' })] })]);
    expect(rows[0]).toMatchObject({ moves: 1 });
    expect(rows[0].layers.map((l) => l.layer)).toEqual(['win']);
  });
  it('markdown 第 4 节：给了 games 才印收尾机制与接管层表，没给就整块不出现', () => {
    const model = (games) => ({
      batchId: 't1', generatedAt: '2026-10-04T00:00:00Z', dirs: ['d'], rounds: 1,
      games, records: [], rows: [], pairs: [], openings: [],
      cost: { rows: [], totalRow: costRow('全轮合计', collectCost([]).total) },
      runtime: '', artifacts: [], anchor: DEFAULT_ANCHOR, bootstrap: 0, seed: 1, tags: [],
    });
    const md = reportMarkdown(model(withEnds()));
    expect(md).toContain('收尾机制与接管层');
    expect(md).toContain('- 收尾：五连 1 局 · 棋盘已满 1 局');
    expect(md).toContain('- 和棋 1 局的手数：2（满盘和');
    expect(md).toContain('| official|v14-live3-fresh|0 | 2 | 3 | pressureGate 2（1/1/0） · vcfDefense 1（1/0/0） |');
    expect(md).toContain('> 「接管手」= 战术层真的接了手的手数');
    const bare = reportMarkdown(model([]));   // 没读到棋谱（空轮）时整块不出现
    expect(bare).not.toContain('收尾机制与接管层');
    expect(bare).toContain('## 5 显著性说明');
  });
});

describe('CLI：闸门与落盘', () => {
  const tmpBatch = (payloads) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-'));
    fs.mkdirSync(path.join(root, 'round-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'round-1', 'games.jsonl'), payloads.map((p) => JSON.stringify(p)).join('\n') + '\n');
    return root;
  };
  it('缺 --batch/--dir、二者并用、--json 缺路径、目录不存在都是用法错（exit 2）', async () => {
    await expect(reportMain([])).rejects.toMatchObject({ exitCode: 2 });
    await expect(reportMain(['--batch', 'x', '--dir', 'y'])).rejects.toThrow(/互斥/);
    await expect(reportMain(['--batch', 'x', '--json'])).rejects.toMatchObject({ exitCode: 2 });
    await expect(reportMain(['--dir', path.join(os.tmpdir(), 'no-such-dir-xyz')]))
      .rejects.toThrow(/目录不存在/);
    await expect(reportMain(['--batch', 'x', '--bootstrap', '-1'])).rejects.toThrow(/--bootstrap/);
  });
  it('正常一轮：写 markdown + JSON，退出 0，JSON 里带 rows/pairs/cost', async () => {
    const root = tmpBatch([
      game({ uid: 'a', moves: [jevMove(1, '黑方'), rafiMove(2, '白方')] }),
      game({ uid: 'b', black: 'rapfi', white: 'official', moves: [rafiMove(1, '黑方'), jevMove(2, '白方')] }),
    ]);
    const out = path.join(root, 'report.md');
    const json = path.join(root, 'report.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(reportMain(['--dir', root, '--out', out, '--json', json, '--bootstrap', '50'])).resolves.toBe(0);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    const md = fs.readFileSync(out, 'utf8');
    expect(md).toContain('# 阶梯报告：');
    expect(md).toContain('## 6 产物清单');
    const model = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(model.records).toHaveLength(2);
    expect(model.rows.map((r) => r.identity).sort()).toEqual(['official|v14-live3-fresh|0', 'rapfi||500']);
    expect(model.cost.totalRow.moves).toBe(2);
    // 判读结论也进 JSON：matrix 只有 1 个版本时为 null，但键必须在（下游不该靠 `in` 试探）
    expect(model).toHaveProperty('versionMatrix', null);
    expect(model.curveComposition.levels.map((l) => l.identity)).toEqual(['rapfi||500']);
    expect(model.levelTable.levels.map((l) => l.thinkMs)).toEqual([500]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('JSON 里的 versionMatrix / curveComposition 能直接点名结论（markdown 只写数量）', async () => {
    // 动机：报表 §4 只写「另有 N 对版本方向一致」，要点名得从 records 重算 —— 于是把两块结论写进 JSON。
    const vs = (uid, tac, ms, vWins) => game({
      uid, black: 'official', blackTac: tac, white: 'rapfi', whiteThink: ms,
      winner: vWins ? 'black' : 'white', moves: [jevMove(1, '黑方'), rafiMove(2, '白方')],
    });
    const root = tmpBatch([
      vs('a', 'v11-vct', 500, true), vs('b', 'v14-live3-fresh', 500, false),
      vs('c', 'v11-vct', 2000, true), vs('d', 'v14-live3-fresh', 2000, false),
    ]);
    const json = path.join(root, 'named.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(reportMain(['--dir', root, '--out', '-', '--json', json, '--no-bt'])).resolves.toBe(0);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    const model = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(model.versionMatrix.opponents).toEqual(['rapfi||500', 'rapfi||2000']);
    expect(model.versionMatrix.consistent).toBe(true);
    expect(model.versionMatrix.pairDirs[0]).toMatchObject({
      a: 'official|v11-vct|0', b: 'official|v14-live3-fresh|0', flip: false, flat: false,
    });
    expect(model.versionMatrix.pairDirs[0].dirs.map((d) => [d.opponent, d.d]))
      .toEqual([['rapfi||500', 1], ['rapfi||2000', 1]]);
    expect(model.curveComposition).toMatchObject({ consistent: true });
    expect(model.curveComposition.levels.map((l) => l.thinkMs)).toEqual([500, 2000]);
    // 逐档合并：v11 两档全胜、v14 两档全负 ⇒ 两档合并值都是 50%，且两档组成相同
    expect(model.levelTable.levels.map((l) => [l.thinkMs, l.games, l.w, l.l, l.rate]))
      .toEqual([[500, 2, 1, 1, 0.5], [2000, 2, 1, 1, 0.5]]);
    expect(model.levelTable.consistent).toBe(true);
    expect(model.levelPower).toHaveLength(1);        // @500 与 @2000 同为 50% ⇒ 分不开
    expect(model.levelPower[0]).toMatchObject({ fromMs: 500, toMs: 2000, needN: null, atTarget: false });
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('多根合并（--dir a,b）：batchId 与标题带上每一批（默认产物名不许只剩第一批）', async () => {
    // 事故背景：`--dir l2n1,vorder1` 若 batchId 取 dirs[0]，标题会写成「阶梯报告：l2n1」、
    // 默认落盘 `.work/l2n1-report.md` 会**覆盖**单批报表 —— 合并批次必须自报家门。
    const a = tmpBatch([game({ uid: 'a', moves: [jevMove(1, '黑方')] })]);
    const b = tmpBatch([game({ uid: 'b', black: 'rapfi', white: 'official', moves: [rafiMove(1, '黑方')] })]);
    const json = path.join(a, 'multi.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(reportMain(['--dir', `${a},${b}`, '--out', '-', '--json', json, '--no-bt'])).resolves.toBe(0);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    const model = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(model.batchId).toBe(`${path.basename(a)}+${path.basename(b)}`);
    expect(model.dirs).toHaveLength(2);
    expect(model.records.map((r) => r.gameUid).sort()).toEqual(['a', 'b']);
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });
  it('空目录（没有 round-*）是读不到棋谱的用法错，不是崩溃', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-empty-'));
    await expect(reportMain(['--dir', root])).rejects.toThrow(/没读到棋谱/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('未收尾的轮（缺 round-summary.json）', () => {
  /** 两轮：round-1 已收尾（有 round-summary.json）、round-2 还在跑（2 局已落盘）。 */
  const twoRounds = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-part-'));
    const write = (no, payloads, settled) => {
      const d = path.join(root, `round-${no}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'games.jsonl'), payloads.map((p) => JSON.stringify(p)).join('\n') + '\n');
      if (settled) {
        fs.writeFileSync(path.join(d, 'round-summary.json'),
          JSON.stringify({ store: 'local', upstream: 'direct', tag: `exp-r${no}` }) + '\n');
      }
    };
    write(1, [game({ uid: 'a', moves: [jevMove(1, '黑方')] })], true);
    write(2, [game({ uid: 'b', moves: [jevMove(1, '黑方')] }), game({ uid: 'c', moves: [jevMove(1, '黑方')] })], false);
    return root;
  };
  /** 跑 CLI 并吞掉两边输出（errLines 收 stderr 的行，用来断言收尾告警）。 */
  const run = async (argv, errLines) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation((s) => { errLines.push(String(s)); });
    try { return await reportMain(argv); } finally { log.mockRestore(); err.mockRestore(); }
  };
  it('默认照读，但在报告头与 §5 标出「仍在跑」，收尾行也告警', async () => {
    const root = twoRounds();
    const out = path.join(root, 'r.md');
    const errLines = [];
    await expect(run(['--dir', root, '--out', out, '--no-bt'], errLines)).resolves.toBe(0);
    const md = fs.readFileSync(out, 'utf8');
    expect(md).toContain('有 1 轮仍在跑');
    expect(md).toContain('round-2（2 局已计入）');
    expect(md).toContain('- **未收尾的轮**：round-2（2 局）');
    expect(md).toContain('round-2/games.jsonl');                 // 默认照读 ⇒ 仍在产物清单里
    expect(md).not.toContain('已按 `--skip-incomplete`');
    expect(errLines.join('\n')).toContain('⚠ 含未收尾的轮：round-2（2 局）');
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('--skip-incomplete：这些局与它们的产物行都不进报告', async () => {
    const root = twoRounds();
    const out = path.join(root, 'r.md');
    const json = path.join(root, 'r.json');
    const errLines = [];
    await expect(run(['--dir', root, '--out', out, '--json', json, '--no-bt', '--skip-incomplete'], errLines))
      .resolves.toBe(0);
    const md = fs.readFileSync(out, 'utf8');
    expect(md).toContain('已按 `--skip-incomplete` 跳过仍在跑的轮：round-2（2 局）');
    expect(md).not.toContain('有 1 轮仍在跑');
    expect(md).not.toContain('- **未收尾的轮**');
    expect(md).not.toContain('round-2/games.jsonl');
    expect(md).toContain('1 局有胜负');
    const model = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(model.records).toHaveLength(1);
    expect(model.skippedIncomplete).toEqual([{ round: 2, games: 2 }]);
    expect(errLines.join('\n')).toContain('已跳过未收尾的轮：round-2（2 局）');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
