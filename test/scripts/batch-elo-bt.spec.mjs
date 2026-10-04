// batch-elo-bt.spec.mjs — P5：Bradley–Terry 点估计 + bootstrap 区间
//
// 验收口径（计划 `2026-10-03-tactics-fidelity-and-elo-ladder` §6 P5 行，**已按实测订正**）：
//   计划原写「合成 200 局（真差 100 Elo）⇒ 点估计误差 < 25 Elo」。实测（`.work/p5-stats.mjs`，
//   3 身份轮转、40 个种子）该规模下平均绝对误差是 **27.9 / 35.6 Elo**（真差 100 / 200），
//   即原判据把「200 局能分辨多细」想得太乐观 —— 200 局、每对约 67 局，传递性拟合后仍有 ±30 Elo 量级的误差。
//   于是判据改成三条可复算的：**估计量无偏（|偏差| < 10）+ 平均绝对误差 < 45 + 误差随 n 单调下降**；
//   估计量与区间的**正确性**另用两身份干净情形对照理论 SE（经验 SD ≈ 理论 SE、覆盖率 ≥ 90%）。
//   ③ `rapfi||500` = 0 锚成立。
import { describe, it, expect } from 'vitest';
import {
  mulberry32, percentile, aggregateBt, fitBt, computeBt, bootstrapBt,
  rankTable, formatRankTable, DEFAULT_ANCHOR, BT_DEFAULTS,
} from '../../scripts/lib/batch-elo.mjs';

const rec = (black, white, blackScore) => ({ black, white, blackScore, tag: 'exp-t', gameUid: `${black}>${white}:${blackScore}`, exported: '', result: '', reason: '', plies: 10 });

/** P(黑胜)：模型本身（`simulate` 是「理想数据」，真实棋谱还有先后手与配对相关）。 */
const winProb = (blackDelta, whiteDelta) => 1 / (1 + Math.pow(10, (whiteDelta - blackDelta) / 400));

/** 两身份、逐局换色、真差 `gap` 的对局。 */
function headToHead(n, gap, seed) {
  const rand = mulberry32(seed);
  const recs = [];
  for (let k = 0; k < n; k += 1) {
    const aBlack = k % 2 === 0;
    const aWins = rand() < winProb(gap, 0);
    recs.push(rec(aBlack ? 'a' : 'b', aBlack ? 'b' : 'a', aBlack === aWins ? 1 : 0));
  }
  return recs;
}

/** 三身份轮转（每对局数均等、换色）——阶梯实验的形状。 */
function ladder(total, truth, seed) {
  const ids = Object.keys(truth);
  const rand = mulberry32(seed);
  const recs = [];
  for (let k = 0; k < total; k += 1) {
    const i = k % ids.length;
    const j = (i + 1 + (Math.floor(k / ids.length) % (ids.length - 1))) % ids.length;
    const flip = Math.floor(k / (ids.length * (ids.length - 1))) % 2 === 1;
    const black = flip ? ids[j] : ids[i];
    const white = flip ? ids[i] : ids[j];
    recs.push(rec(black, white, rand() < winProb(truth[black], truth[white]) ? 1 : 0));
  }
  return recs;
}

const meanAbs = (arr) => arr.reduce((s, v) => s + Math.abs(v), 0) / arr.length;
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
const sd = (arr) => Math.sqrt(arr.reduce((s, v) => s + (v - mean(arr)) ** 2, 0) / (arr.length - 1));

describe('mulberry32 / percentile', () => {
  it('同 seed 同序列、异 seed 异序列（bootstrap 要可复现）', () => {
    const a = mulberry32(42); const b = mulberry32(42); const c = mulberry32(43);
    const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual([c(), c(), c()]);
    for (const v of seqA) expect(v >= 0 && v < 1).toBe(true);
  });
  it('percentile 端点与插值', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
  });
});

describe('aggregateBt', () => {
  it('对局数按无向对计数、得分两侧各记一次', () => {
    const agg = aggregateBt([rec('a', 'b', 1), rec('b', 'a', 0.5), rec('a', 'b', 0)]);
    expect(agg.ids).toEqual(['a', 'b']);
    const pair = [...agg.pairs.values()];
    expect(pair).toHaveLength(1);
    expect(pair[0].n).toBe(3);
    expect(agg.points.get(0)).toBeCloseTo(1 + 0.5 + 0, 10); // a：1 胜 + 0.5 和 + 0 负
    expect(agg.points.get(1)).toBeCloseTo(0 + 0.5 + 1, 10);
    expect(agg.games.get(0)).toBe(3);
  });
  it('自己打自己不计（否则分母出现 p_i+p_i 的退化项）', () => {
    const agg = aggregateBt([rec('a', 'a', 1)]);
    expect(agg.pairs.size).toBe(0);
  });
});

describe('computeBt / fitBt', () => {
  it('全胜方高于全负方，且只有两名身份时两点相对 0 点对称', () => {
    const recs = Array.from({ length: 10 }, () => rec('a', 'b', 1));
    const bt = computeBt(recs, { anchor: 'a', bootstrap: 0 });
    expect(bt.deltas.get('a')).toBe(0); // 锚点严格 0
    expect(bt.deltas.get('b')).toBeLessThan(-300);
    expect(bt.converged).toBe(true);
  });
  it('全部和棋 ⇒ 两点都在 0 附近（先验把比例拉回 1:1）', () => {
    const recs = Array.from({ length: 20 }, () => rec('a', 'b', 0.5));
    const bt = computeBt(recs, { anchor: 'a', bootstrap: 0 });
    expect(Math.abs(bt.deltas.get('b'))).toBeLessThan(1);
  });
  it('全胜不会发散（ridge 先验把 MLE 从无穷远拉回来）', () => {
    const recs = Array.from({ length: 20 }, () => rec('a', 'b', 1));
    const bt = computeBt(recs, { anchor: 'a', bootstrap: 0 });
    expect(Number.isFinite(bt.deltas.get('b'))).toBe(true);
    expect(bt.deltas.get('b')).toBeLessThan(-500);
    expect(bt.deltas.get('b')).toBeGreaterThan(-1200);
  });
  it('锚点缺省是 rapfi||500；数据里没有它 ⇒ 退化成均值居中', () => {
    const recs = [...Array.from({ length: 12 }, () => rec('rapfi||500', 'proxy|v10-live3|0', 0)),
      ...Array.from({ length: 12 }, () => rec('proxy|v10-live3|0', 'rapfi||500', 1))];
    const withAnchor = computeBt(recs, { bootstrap: 0 });
    expect(withAnchor.anchor).toBe(DEFAULT_ANCHOR);
    expect(withAnchor.deltas.get(DEFAULT_ANCHOR)).toBe(0);
    expect(withAnchor.deltas.get('proxy|v10-live3|0')).toBeGreaterThan(0);
    const noAnchor = computeBt(recs, { anchor: '', bootstrap: 0 }); // 显式空串 ⇒ 不强加锚点
    expect(noAnchor.anchor).toBeNull();
    expect(Math.abs(mean([...noAnchor.deltas.values()]))).toBeLessThan(0.5); // 均值居中
  });
  it('空输入不炸', () => {
    const bt = computeBt([], { bootstrap: 0 });
    expect(bt.deltas.size).toBe(0);
    expect(bt.iterations).toBe(0);
  });
  it('ridge 先验强度可调；`ridge: undefined` 不得把默认值覆盖成 NaN', () => {
    expect(BT_DEFAULTS.ridge).toBe(0.5);
    const recs = Array.from({ length: 20 }, () => rec('a', 'b', 1));
    const weak = computeBt(recs, { anchor: 'a', ridge: 0.1, bootstrap: 0 });
    const strong = computeBt(recs, { anchor: 'a', ridge: 5, bootstrap: 0 });
    expect(strong.deltas.get('b')).toBeGreaterThan(weak.deltas.get('b')); // 先验越强 ⇒ 拉回 0
    const undef = fitBt(aggregateBt(recs), { anchor: 'a', ridge: undefined });
    expect(Number.isFinite(undef.deltas.get('b'))).toBe(true);
  });
});

describe('bootstrapBt', () => {
  it('验收①（估计量与区间的正确性）：两身份干净情形对齐理论 SE', () => {
    const N = 200; const GAP = 100;
    const p = winProb(GAP, 0);
    const theory = (400 / Math.LN10) * Math.sqrt(1 / (N * p * (1 - p)));
    const errs = []; const widths = []; let covered = 0;
    const SEEDS = 60;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const bt = bootstrapBt(headToHead(N, GAP, seed), { anchor: 'a', bootstrap: 300, seed: 5000 + seed });
      const s = bt.samples.get('b');
      errs.push(bt.point.deltas.get('b') + GAP); // 真值是 −GAP
      widths.push(s.hi - s.lo);
      if (s.lo <= -GAP && s.hi >= -GAP) covered += 1;
    }
    expect(Math.abs(mean(errs))).toBeLessThan(15); // 无偏
    expect(sd(errs)).toBeGreaterThan(theory * 0.8); // 经验 SD ≈ 理论 SE（±20%）
    expect(sd(errs)).toBeLessThan(theory * 1.2);
    expect(mean(widths)).toBeGreaterThan(theory * 1.96 * 2 * 0.75); // 区间宽度 ≈ 2×1.96×SE
    expect(mean(widths)).toBeLessThan(theory * 1.96 * 2 * 1.35);
    expect(covered / SEEDS).toBeGreaterThanOrEqual(0.9); // 覆盖率 ≥ 90%
  });

  it('验收②（阶梯形状）：200 局无偏、平均绝对误差 < 45 Elo；加大样本误差下降', () => {
    const truth = { a: 0, b: 100, c: 200 };
    const SEEDS = 24;
    const errAt = (total) => {
      const e = { b: [], c: [] };
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const bt = computeBt(ladder(total, truth, seed), { anchor: 'a', bootstrap: 0 });
        e.b.push(bt.deltas.get('b') - truth.b);
        e.c.push(bt.deltas.get('c') - truth.c);
      }
      return { b: e.b, c: e.c, all: [...e.b, ...e.c] };
    };
    const small = errAt(200);
    const big = errAt(800);
    expect(Math.abs(mean(small.all))).toBeLessThan(10); // 无偏
    expect(meanAbs(small.all)).toBeLessThan(45); // 200 局、真差 100/200 ⇒ 实测 ~32
    expect(meanAbs(big.all)).toBeLessThan(meanAbs(small.all)); // 误差随 n 下降
  });

  it('验收③：同 seed 逐字可复现；区间覆盖真值；宽度随 n 收窄', () => {
    const truth = { a: 0, b: 100, c: 200 };
    const recs = ladder(200, truth, 7);
    const bt = bootstrapBt(recs, { anchor: 'a', bootstrap: 200, seed: 5 });
    expect(bt.samples.get('b')).toEqual(bootstrapBt(recs, { anchor: 'a', bootstrap: 200, seed: 5 }).samples.get('b'));
    for (const id of ['b', 'c']) {
      const s = bt.samples.get(id);
      expect(s.lo).toBeLessThanOrEqual(truth[id]);
      expect(s.hi).toBeGreaterThanOrEqual(truth[id]);
    }
    const w = (r) => r.samples.get('c').hi - r.samples.get('c').lo;
    const small = bootstrapBt(ladder(100, truth, 11), { anchor: 'a', bootstrap: 200, seed: 9 });
    const big = bootstrapBt(ladder(800, truth, 11), { anchor: 'a', bootstrap: 200, seed: 9 });
    expect(w(small)).toBeGreaterThan(w(big));
  });

  it('--bootstrap 0 只算点估计（不重采样）', () => {
    const bt = bootstrapBt(ladder(60, { a: 0, b: 100 }, 3), { anchor: 'a', bootstrap: 0 });
    expect(bt.iterations).toBe(0);
    expect(bt.samples.size).toBe(0);
  });
});

describe('rankTable 的 BT 列', () => {
  const truth = { 'rapfi||500': 0, 'proxy|v10-live3|0': 100 };
  const recs = ladder(60, truth, 3);

  it('不给 opts.bt ⇒ 老报表逐字不变（行里没有 BT 字段）', () => {
    const rows = rankTable(recs, 16);
    expect(rows.every((r) => r.btDelta === undefined && r.btWidth === undefined)).toBe(true);
    expect(formatRankTable(rows)).not.toContain('BT Δ');
  });
  it('给 opts.bt ⇒ 每行带 Δ/区间/宽度，表头出现 BT Δ，锚点行 Δ=0', () => {
    const rows = rankTable(recs, 16, { bt: { bootstrap: 100, seed: 1 } });
    expect(formatRankTable(rows)).toContain('BT Δ');
    const anchorRow = rows.find((r) => r.identity === DEFAULT_ANCHOR);
    expect(anchorRow.btDelta).toBe(0);
    expect(anchorRow.btLo).toBeLessThanOrEqual(0);
    expect(anchorRow.btHi).toBeGreaterThanOrEqual(0);
    for (const r of rows) expect(r.btWidth).toBeGreaterThanOrEqual(0);
    expect(rows[0].identity).toBe('proxy|v10-live3|0'); // BT 排序：强的一方在前
  });
  it('报表脚注说明「按局 bootstrap 不利用配对结构」', () => {
    const rows = rankTable(recs, 16, { bt: { bootstrap: 50, seed: 1 } });
    expect(formatRankTable(rows)).toContain('配对');
  });
});
