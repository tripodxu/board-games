/**
 * scripts/lib/loss-report.mjs — 败局解释的纯函数层（AGENTS.md 规则 11）
 *
 * 回答「这批对局是怎么输的」，分两件事：
 *   ① **形态**：我方最后一手走的哪一层、怎么终局、手数分布（短败 / 磨死 / 满盘和）；
 *   ② **追因**：我方最后 N 手里，从哪一手起「此后我方的每一步都仍然必败」= 不可逆点。
 *
 * 引擎不在这里：必败判定由调用方注入（逐手回调 `fatal(ply)`），这一层只做归纳，因此零 IO、
 * 纯函数、可直接单测。CLI 见 `scripts/loss-report.mjs`。
 *
 * **口径提醒**（踩过的坑，见 docs/memory/MEMORY.md 2026-10-05）：
 * `engine.vcfWin()` / `engine.vctWin()` 返回 `{win,first,line}` **对象**，`!!x` 恒真 ——
 * 注入方必须写 `engine.vcfWin(st, 对手方, plies).win === true`。
 *
 * **必败判据 = 一手成五（权威）∨ ≤plies 手 VCF**：裸 `vcfWin()` 漏判一手成五（入口前提是
 * 「双方无一步杀」，`src/core/engines/gomoku.ts:220`）⇒ 只用它会把必败起点后推、且**永远报不出 h1**。
 * 注入方先走 `getLegalMoves → applyMove → getStatus`，判据来源记在 `suffix.cause`（`'w1'|'vcf'`）。
 *
 * 追因只到 **VCF 级**（在一手成五之后）：`none` 那一档不等于「没输在更早的地方」，
 * 只等于「一手成五与 ≤plies 手 VCF 都查不到」，想要更长的链要 VCT 级探针。报告里必须把这条边界和数字一起印出来。
 */

import { quantiles } from './report.mjs';

/** 短败阈值：≤ 这一手数的败局算「很快就输了」（L2 实测 v13@2000 的 9 局败里 4 局 ≤38 手）。 */
export const SHORT_LOSS_PLIES = 40;

/**
 * 最长必败后缀：`flags[i]` = 「我方第 i 手走完之后，此后每一步都仍是必败」。
 *
 * 从最后一手往前扫，连续为真的一段就是后缀。返回 `{ start, count, at }`：
 *   - `count` = 后缀长度（1 = 最后一手走完就已经必败 = 突然崩；≥4 = 早就死了，后面只是拖延）；
 *   - `at` = 后缀第一手的位置（`count === 0` 时为 null）。
 *
 * 判定必须取**最大后缀**：探针里能看到「对手已成 VCF → 被我们堵掉 → 换个方式输」的局，
 * 只看「某一手之前有没有必杀」会把这种局误判成「早就必败」。
 */
export function fatalSuffix(flags) {
  const a = Array.isArray(flags) ? flags : [];
  let start = a.length;
  for (let i = a.length - 1; i >= 0; i--) {
    if (!a[i]) break;
    start = i;
  }
  return { start: start === a.length ? null : start, count: a.length - start, at: start };
}

/** 手数/子项计数：把 `[[key, n]]` 按次数降序（次数相同按 key 升序）。 */
function tally(map) {
  return [...map.entries()].sort((x, y) => (y[1] - x[1]) || String(x[0]).localeCompare(String(y[0])));
}

function bump(map, key) {
  const k = key == null || key === '' ? '(无)' : String(key);
  map.set(k, (map.get(k) || 0) + 1);
}

/** 手数统计（复用报告层同一份分位数实现，口径不另写）。 */
export function plyStats(games) {
  return quantiles(games.map((g) => g.plies));
}

/**
 * 归纳一批**已按我方视角归一化**的对局（CLI 产出这一形状；单测直接构造）。
 *
 * 每局：`{ identity, opponent, result: 'win'|'draw'|'loss', plies, endReason,
 *          lastLayer, suffix: {count, at, plies: [{ply, layer}]} | null }`
 * 其中 `suffix` 只对败局有意义（`--no-vcf` 时为 null）。
 *
 * 返回形状见文件头；`byIdentity` 是同样的归纳按身份再切一刀（版本之间对比形态用）。
 */
export function lossShape(games, opts = {}) {
  const rows = Array.isArray(games) ? games : [];
  const shortPlies = opts.shortPlies ?? SHORT_LOSS_PLIES;
  const wins = rows.filter((g) => g.result === 'win');
  const draws = rows.filter((g) => g.result === 'draw');
  const losses = rows.filter((g) => g.result === 'loss');

  const lastLayers = new Map();
  const endReasons = new Map();
  const lossEndReasons = new Map();
  const drawEndReasons = new Map();
  const suffixBuckets = { 1: 0, 2: 0, 3: 0, '4+': 0 };
  let suffixNone = 0;
  let suffixKnown = 0;
  const lostFromPlies = [];
  const lostFromLayers = new Map();
  const lostFromCause = { w1: 0, vcf: 0 };

  for (const g of losses) {
    bump(lastLayers, g.lastLayer);
    bump(lossEndReasons, g.endReason);
    if (g.suffix) {
      suffixKnown++;
      const c = g.suffix.count || 0;
      if (c === 0) suffixNone++;
      else if (c <= 3) suffixBuckets[c]++;
      else suffixBuckets['4+']++;
      if (c > 0 && g.suffix.plies && g.suffix.plies.length > 0) {
        const first = g.suffix.plies[0];
        if (first && Number.isFinite(first.ply)) lostFromPlies.push(first.ply);
        bump(lostFromLayers, first && first.layer);
        if (g.suffix.cause === 'w1') lostFromCause.w1++;
        else if (g.suffix.cause === 'vcf') lostFromCause.vcf++;
      }
    }
  }
  for (const g of draws) bump(drawEndReasons, g.endReason);
  for (const g of rows) bump(endReasons, g.endReason);

  const byIdentity = new Map();
  for (const g of rows) {
    const key = g.identity || '(未知)';
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(g);
  }

  const sub = (list) => {
    const w = list.filter((g) => g.result === 'win').length;
    const d = list.filter((g) => g.result === 'draw').length;
    const l = list.filter((g) => g.result === 'loss').length;
    const ls = list.filter((g) => g.result === 'loss');
    const lsuffix = { 1: 0, 2: 0, 3: 0, '4+': 0, none: 0, known: 0 };
    const layers = new Map();
    for (const g of ls) {
      bump(layers, g.lastLayer);
      if (!g.suffix) continue;
      lsuffix.known++;
      const c = g.suffix.count || 0;
      if (c === 0) lsuffix.none++;
      else if (c <= 3) lsuffix[c]++;
      else lsuffix['4+']++;
    }
    return {
      games: list.length,
      w,
      d,
      l,
      unbeatenRate: list.length ? (w + d) / list.length : null,
      lossPlies: plyStats(ls),
      lossLastLayers: tally(layers),
      lossSuffix: lsuffix,
    };
  };

  return {
    games: rows.length,
    w: wins.length,
    d: draws.length,
    l: losses.length,
    unbeatenRate: rows.length ? (wins.length + draws.length) / rows.length : null,
    plies: plyStats(rows),
    win: { n: wins.length, plies: plyStats(wins) },
    draw: { n: draws.length, plies: plyStats(draws), endReasons: tally(drawEndReasons) },
    loss: { n: losses.length, plies: plyStats(losses), short: losses.filter((g) => g.plies <= shortPlies).length, shortPlies },
    lossLastLayers: tally(lastLayers),
    lossEndReasons: tally(lossEndReasons),
    endReasons: tally(endReasons),
    suffix: { known: suffixKnown, none: suffixNone, buckets: suffixBuckets },
    lostFrom: {
      found: lostFromPlies.length,
      plies: quantiles(lostFromPlies),
      layers: tally(lostFromLayers),
      cause: lostFromCause,
    },
    byIdentity: [...byIdentity.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([identity, list]) => ({ identity, ...sub(list) })),
  };
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const num = (x, unit = '') => (x == null ? '—' : `${x}${unit}`);
const statLine = (s) => (s == null ? '—' : `均 ${s.mean} / 中位 ${s.median} / 最短 ${s.min} / 最长 ${s.max}`);
const listLine = (pairs, fmt = (k, n) => `${k} ${n}`) => (pairs.length ? pairs.map(([k, n]) => fmt(k, n)).join('、') : '—');

/**
 * 把 `lossShape()` 的结果写成可直接贴进结果文档的 markdown（规则 11 的一节）。
 *
 * `opts.label` 写进小标题（例如「L2 300 局」）；`opts.plies` = 追因用的 VCF 手数上限；
 * `opts.note` 追加一句自定义边界说明。**边界句一定会印**：VCF 只解释 found/l。
 */
export function formatLossMarkdown(shape, opts = {}) {
  const label = opts.label ? `${opts.label}：` : '';
  const plies = opts.plies ?? 9;
  const s = shape;
  const L = [];
  L.push(`### 败局解释（规则 11）${label}`);
  L.push('');
  L.push(`- **盘点**：${s.games} 局 = ${s.w} 胜 / ${s.d} 和 / ${s.l} 负，**不败率 ${pct(s.unbeatenRate)}**。`);
  L.push(`- **手数三形态**：胜局 ${statLine(s.win.plies)}；和局 ${statLine(s.draw.plies)}；败局 ${statLine(s.loss.plies)}。`);
  if (s.loss.n > 0) {
    L.push(`  败局里 **≤${s.loss.shortPlies} 手的短败 ${s.loss.short} 局**（${pct(s.loss.short / s.loss.n)}）—— 败因常常不在终盘。`);
  }
  L.push(`- **败局形态**：最后一手走的层 ${listLine(s.lossLastLayers)}；终局方式 ${listLine(s.lossEndReasons)}。`);
  if (s.draw.n > 0) {
    L.push(`- **和棋形态**：终局方式 ${listLine(s.draw.endReasons)}。`);
  }
  const tailTotal = s.suffix.buckets[1] + s.suffix.buckets[2] + s.suffix.buckets[3] + s.suffix.buckets['4+'];
  if (s.suffix.known > 0) {
    L.push(`- **追因（逐手问对手：一手成五 ∨ ≤${plies} 手 VCF，只统计败局）**：${s.suffix.known} 局探过 —— ` +
      `最后一手前就有必杀 ${s.suffix.buckets[1]} 局、隔 2 手 ${s.suffix.buckets[2]} 局、隔 3 手 ${s.suffix.buckets[3]} 局、` +
      `**早就必败（≥4 手）${s.suffix.buckets['4+']} 局**、**一手成五与 ≤${plies} 手 VCF 都查不到 ${s.suffix.none} 局**` +
      (tailTotal ? `（有必杀后缀合计 ${tailTotal}/${s.suffix.known} = ${pct(tailTotal / s.suffix.known)}）` : '') + '。');
    L.push(`- **不可逆点**：${s.lostFrom.found}/${s.loss.n} 局能定位（取「自此以后我方每一步都仍必败」的最大后缀），` +
      `落在 ${num(s.lostFrom.plies && s.lostFrom.plies.min)}–${num(s.lostFrom.plies && s.lostFrom.plies.max)} 手` +
      (s.lostFrom.plies ? `（均 ${s.lostFrom.plies.mean} 手）` : '') + `；那一刻我方走的层 ${listLine(s.lostFrom.layers)}；` +
      `起点判据：**一手成五 ${s.lostFrom.cause.w1} 局** / 需 ≤${plies} 手 VCF 链 ${s.lostFrom.cause.vcf} 局。`);
  }
  L.push(`- **边界**：追因（一手成五 ∨ ≤${plies} 手 VCF）只解释 ${s.lostFrom.found}/${s.loss.n} 局；` +
    `「查不到」只等于这两条都没有（更长的 VCT 链要另写探针），不能读成「没输在更早的地方」。` +
    (opts.note ? ` ${opts.note}` : ''));
  L.push('');
  if (s.byIdentity.length > 1) {
    L.push('| 身份 | 局 | 胜–和–负 | 不败率 | 败局手数（均/中位） | 败局最后一手 | 必杀后缀（1/2/3/4+/查不到） |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of s.byIdentity) {
      const lp = r.lossPlies ? `${r.lossPlies.mean}/${r.lossPlies.median}` : '—';
      const sf = r.lossSuffix.known
        ? `${r.lossSuffix[1]}/${r.lossSuffix[2]}/${r.lossSuffix[3]}/${r.lossSuffix['4+']}/${r.lossSuffix.none}`
        : '—';
      L.push(`| \`${r.identity}\` | ${r.games} | ${r.w}–${r.d}–${r.l} | ${pct(r.unbeatenRate)} | ${lp} | ` +
        `${listLine(r.lossLastLayers)} | ${sf} |`);
    }
    L.push('');
  }
  return L.join('\n');
}
