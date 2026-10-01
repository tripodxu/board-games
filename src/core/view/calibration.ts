/* view/calibration.ts — 概率校准（迁移自 js/calibration.js）
 *
 * 回答一个问题：**Jev 说的「70% 赢」到底可不可信**。
 * 只发布「定义即真值、无恒等式依赖」的指标（刻意不上 Murphy 的 BS = REL − RES + UNC
 * 三分式：该恒等式在分箱内预测值非常数时并不成立，对完美预测 p=y∈{0,1} 代入即证伪，
 * 需要额外的箱内方差修正项才严格）。
 */
import { assert } from '../assert.ts';

export interface Sample { p: number; y: number }
export interface Bin { lo: number; hi: number; n: number; conf: number; acc: number }

export interface Metrics {
  n: number;
  brier: number;
  ref: number;
  skill: number | null;
  ece: number;
  mce: number;
  baseRate: number;
  sharpness: number;
  overconfidence: number;
}

export interface RecordLike {
  cal?: number[] | null;
  firstWin?: boolean | null;
  mock?: boolean;
  [k: string]: unknown;
}

export interface FromRecordsResult {
  samples: Sample[];
  games: number;
  draws: number;
  skippedDemo: number;
  metrics: Metrics | null;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/** 清洗样本：p 必须是有限数（越界截断），y 必须是 0/1（缺数据与和棋一律剔除）。 */
export function clean(samples: { p?: unknown; y?: unknown }[] | null | undefined): Sample[] {
  const out: Sample[] = [];
  for (const s of samples || []) {
    if (!s) continue;
    const p = Number(s.p), y = s.y;
    if (typeof p !== 'number' || !isFinite(p)) continue;
    if (y !== 0 && y !== 1) continue;
    out.push({ p: clamp01(p), y: y as number });
  }
  return out;
}

/** 可靠性分箱：按预测值 p 等宽分箱。
 *  返回每箱 {lo, hi, n, conf(平均预测), acc(平均实测)}，空箱 n=0、conf=acc=0。
 *  p 恰为 1 时归入最后一箱（floor 会越界）。 */
export function reliability(raw: { p?: unknown; y?: unknown }[] | null | undefined, nBins?: number): Bin[] {
  const s = clean(raw);
  const bins = Math.max(2, (nBins as number) | 0 || 10);
  const out: Bin[] = [];
  const sumP: number[] = [];
  const sumY: number[] = [];
  for (let k = 0; k < bins; k++) {
    out.push({ lo: k / bins, hi: (k + 1) / bins, n: 0, conf: 0, acc: 0 });
    sumP.push(0);
    sumY.push(0);
  }
  for (const x of s) {
    let k = Math.floor(x.p * bins);
    if (k < 0) k = 0;
    if (k >= bins) k = bins - 1;
    const b = out[k]!;
    b.n++; sumP[k] = (sumP[k] as number) + x.p; sumY[k] = (sumY[k] as number) + x.y;
  }
  for (let k = 0; k < bins; k++) {
    const b = out[k]!;
    if (b.n) { b.conf = (sumP[k] as number) / b.n; b.acc = (sumY[k] as number) / b.n; }
  }
  return out;
}

/** 汇总指标。样本不足返回 null。
 *    brier          = mean((p−y)²)            越低越好；全猜 0.5 时 = 0.25
 *    skill          = 1 − brier / (p̄(1−p̄))   相对「恒定猜真实基准率」的技巧分
 *    ece / mce      = Σ(n_k/N)·|acc_k−conf_k| / 其最大
 *    overconfidence = mean(p) − p̄             >0 = Jev 平均比现实更乐观 */
export function metrics(raw: { p?: unknown; y?: unknown }[] | null | undefined): Metrics | null {
  const s = clean(raw);
  const n = s.length;
  if (!n) return null;
  let sq = 0, sumP = 0, sumY = 0;
  for (const x of s) { const d = x.p - x.y; sq += d * d; sumP += x.p; sumY += x.y; }
  const baseRate = sumY / n;          /* 实际先手方胜率 */
  const sharpness = sumP / n;         /* Jev 平均给出的胜率 */
  const brier = sq / n;
  const ref = baseRate * (1 - baseRate); /* 参考预报「恒定猜 baseRate」的 brier */
  let ece = 0, mce = 0;
  for (const b of reliability(s, 10)) {
    if (!b.n) continue;
    const gap = Math.abs(b.acc - b.conf);
    ece += (b.n / n) * gap;
    if (gap > mce) mce = gap;
  }
  return {
    n,
    brier,
    ref,
    skill: ref > 0 ? 1 - brier / ref : null, /* 基准率为 0 或 1 时参考预报无意义 */
    ece,
    mce,
    baseRate,
    sharpness,
    overconfidence: sharpness - baseRate,
  };
}

/** 从战绩簿汇总校准样本。
 *  记录里的 cal 是该局**非演示渠道**的 Jev 逐手给出的先手方胜率；
 *  离线演示的合成概率刻意不写入 cal —— 拿合成数据算校准等于自欺。
 *  firstWin 为 null（和棋）时该局没有二元真值，计入 draws 而不计入样本。
 *  入参允许出现 `null`/`undefined` 空洞（历史战绩簿里缺字段的格子），一律跳过。 */
export function fromRecords(records: readonly (RecordLike | null | undefined)[] | null | undefined): FromRecordsResult {
  const samples: Sample[] = [];
  let games = 0, draws = 0, skippedDemo = 0;
  for (const r of records || []) {
    if (!r) continue;
    const cal = r.cal;
    if (!cal || !cal.length) { if (r.mock) skippedDemo++; continue; }
    if (r.firstWin === null || r.firstWin === undefined) { draws++; continue; }
    const y = r.firstWin ? 1 : 0;
    games++;
    for (const p of cal) samples.push({ p, y });
  }
  return { samples, games, draws, skippedDemo, metrics: metrics(samples) };
}

export function selfTest(): void {
  const U = (c: unknown, m: string): void => { assert(c, m); };
  /* A：两极 + 五五开 → 完美校准（ece/mce = 0） */
  const A = metrics([{ p: 1, y: 1 }, { p: 0, y: 0 }, { p: 0.5, y: 0 }, { p: 0.5, y: 1 }])!;
  U(near(A.brier, 0.125), 'A.brier 应为 0.125，实际 ' + A.brier);
  U(near(A.skill as number, 0.5), 'A.skill 应为 0.5，实际 ' + A.skill);
  U(near(A.ece, 0) && near(A.mce, 0), 'A.ece/mce 应为 0');
  U(near(A.overconfidence, 0), 'A.overconfidence 应为 0');
  U(near(A.baseRate, 0.5) && near(A.sharpness, 0.5), 'A 基准率/锐度应为 0.5');
  /* B：恒定 0.5 → 毫无信息量（skill = 0） */
  const B = metrics([{ p: 0.5, y: 0 }, { p: 0.5, y: 1 }, { p: 0.5, y: 1 }, { p: 0.5, y: 0 }])!;
  U(near(B.brier, 0.25), 'B.brier 应为 0.25');
  U(near(B.skill as number, 0), 'B.skill 应为 0');
  /* C：系统性过度自信 → ece/mce = 0.6 */
  const C = metrics(Array.from({ length: 10 }, (_, i) => ({ p: 0.9, y: i < 3 ? 1 : 0 })))!;
  U(near(C.brier, 0.57), 'C.brier 应为 0.57，实际 ' + C.brier);
  U(near(C.overconfidence, 0.6), 'C.overconfidence 应为 0.6');
  U(near(C.ece, 0.6) && near(C.mce, 0.6), 'C.ece/mce 应为 0.6');
  /* D：完美预测 → brier 0、skill 1 */
  const D = metrics([{ p: 1, y: 1 }, { p: 0, y: 0 }])!;
  U(near(D.brier, 0) && near(D.skill as number, 1), 'D 完美预测 brier 0 / skill 1');
  /* F：混合（1 条 0.9 错 + 9 条 0.5 对） */
  const F = metrics([{ p: 0.9, y: 0 }, ...Array.from({ length: 9 }, () => ({ p: 0.5, y: 1 }))])!;
  U(near(F.ece, 0.54) && near(F.mce, 0.9), 'F.ece/mce 应为 0.54/0.9，实际 ' + F.ece + '/' + F.mce);
  U(near(F.baseRate, 0.9) && near(F.sharpness, 0.54) && near(F.overconfidence, -0.36),
    'F 基准率/锐度/过度自信应为 0.9/0.54/-0.36');
  U(near(F.brier, 0.306), 'F.brier 应为 0.306，实际 ' + F.brier);
  /* 退化：全赢 → 参考预报无意义，skill = null 但不许 NaN */
  const G = metrics([{ p: 0.7, y: 1 }, { p: 0.8, y: 1 }])!;
  U(G.skill === null, '全赢时 skill 应为 null');
  U(isFinite(G.brier) && isFinite(G.ece), '退化样本的 brier/ece 必须有限');
  /* 空样本 → null */
  U(metrics([]) === null && metrics(null) === null, '空样本 metrics 应为 null');
  /* 分箱：p=1 落最后一箱、p=0 落第一箱、空箱 n=0 */
  const bins = reliability([{ p: 1, y: 1 }, { p: 0, y: 0 }], 10);
  U(bins.length === 10, 'reliability 应返回 10 箱');
  U(bins[9]!.n === 1 && bins[0]!.n === 1, 'p=1/p=0 应落首末箱');
  U(bins[5]!.n === 0, '中间空箱 n 应为 0');
  /* fromRecords：和棋整局丢弃、演示局不计入（夹具照抄旧 `js/calibration.js:200-211` 的 5 条） */
  const agg = fromRecords([
    { cal: [0.9, 0.8], firstWin: true },
    { cal: [0.2], firstWin: false },
    { cal: [0.5, 0.5], firstWin: null }, /* 和棋：计 draws，不入样本 */
    { firstWin: true, mock: true }, /* 离线演示：没有 cal，计 skippedDemo */
    null,
  ]);
  U(agg.games === 2, 'fromRecords 应汇总 2 局有效对局，实际 ' + agg.games);
  U(agg.draws === 1, '和棋应计 1 局，实际 ' + agg.draws);
  U(agg.samples.length === 3 && agg.samples.every((x) => x.y === 0 || x.y === 1),
    '应产出 3 条 y∈{0,1} 样本，实际 ' + JSON.stringify({ s: agg.samples.length }));
  U(agg.skippedDemo === 1, '演示局计数不对：' + agg.skippedDemo);
  U(agg.metrics !== null && agg.metrics.n === 3, 'fromRecords 应带 metrics 且 n=3');
  /* 真值映射方向：firstWin=true → y=1，firstWin=false → y=0，不得搞反 */
  const dir = fromRecords([{ cal: [0.7, 0.8], firstWin: true }, { cal: [0.3], firstWin: false }]);
  U(dir.samples.length === 3 && dir.samples[0]!.y === 1 && dir.samples[1]!.y === 1 && dir.samples[2]!.y === 0,
    '真值映射方向错误：' + JSON.stringify(dir.samples));
  U(dir.metrics !== null && dir.metrics.n === 3, 'fromRecords 应带 metrics');
}

export const calibration = { clean, reliability, metrics, fromRecords, selfTest };
