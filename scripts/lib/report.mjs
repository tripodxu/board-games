// report.mjs — 阶梯报告的纯函数核心（每次阶梯必出，见 docs/plans/2026-10-03-tactics-fidelity-and-elo-ladder.md §7）
//
// 为什么单独一层：报告要在「L2 的 300 局」这种规模上复算六件事 —— 能力表（BT Elo + bootstrap 区间 +
// Wilson）、Rapfi 思考时间曲线、成本表（战术层与模型往返分开，m07650/m08110 的必报项）、配对样本矩阵、
// 显著性说明、产物清单。这些全是**纯计算**，文件读写留在 CLI（scripts/experiment-report.mjs），
// 于是单测能拿合成 payload 直接钉住口径，不必造目录树。
//
// 第 4 节内另有一块**解释性**内容（`endReasons()` 收尾机制 + `layersByResult()` 接管层 × 结果）：
// 规则 11 要求「败局要解释、和棋可接受」，所以和棋是不是满盘和、输在哪些层必须写出来 ——
// 但它**不参与判强**（判强只看 §1/§4 的配对表），所以只作 §4 的子块，不打乱 §1–§6 编号。
//
// 口径纪律（与 batch-elo.mjs / batch-common.mjs 同一份）：
//   - 身份 = `渠道|战术档|思考ms`，**唯一实现仍走 `identityOf()`**，这里不另写一份；
//   - 成本只在**真的打了上游的那一侧**统计（`ai.ms` 是 number）—— Rapfi/mock 侧的 `ms` 是 null，
//     把 null 当 0 会把均值拉低（与「不许写 0 冒充缺失」同一条纪律）；
//   - 战术层耗时 `tacMs` 与模型往返 `ms` **分开列**，并同时给两种占比：
//     `战术 / 单手（= 往返 + 战术）` 与 `战术 / 往返`。C2 验收轮对外报的「占单手 48.6%」用的是后者 ——
//     报告里两个都印，避免读数歧义；
//   - 和棋记 0.5、区间一律并排印、样本 < MIN_GAMES 标注 —— 沿用 P0b/P5 已定纪律。

import { DEFAULT_ANCHOR, MIN_GAMES, formatRankTable, gameRecord, identityOf, rankTable, wilson } from './batch-elo.mjs';

export { DEFAULT_ANCHOR, MIN_GAMES };

/** 报告结构版本（JSON 产物用；改动口径时 +1）。 */
export const REPORT_VERSION = 1;

const BLACK_SIDE = '黑方';

/**
 * 一手棋的归属身份：`渠道|战术档|思考ms`。
 * 思考档从**棋谱 payload**取（`blackThink`/`whiteThink` 只在 rapfi 侧有值，见 record/export.ts 的 thinkMsOf），
 * 渠道与战术档从**逐手 meta** 取（`ai.ch`/`ai.tv`）—— 这正是归档/D1 的同一口径。
 */
export function moveIdentity(game, move) {
  const ai = (move && move.ai) || {};
  const think = move && move.side === BLACK_SIDE ? game.blackThink : game.whiteThink;
  return identityOf({ channel: ai.ch, tactics: ai.tv, thinkMs: think });
}

/** 只统计真打过上游的手：`ai.ms` 是 number（Rapfi/mock/人类侧是 null，缺失 ≠ 0）。 */
export function isUpstreamMove(move) {
  const ai = (move && move.ai) || {};
  return typeof ai.ms === 'number';
}

/** 分位数/均值（输入会被就地排序；空数组返回 null）。 */
export function quantiles(values) {
  const a = [...values].filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const sum = a.reduce((x, y) => x + y, 0);
  const at = (q) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
  return {
    n: a.length,
    mean: Math.round((sum / a.length) * 10) / 10,
    median: at(0.5),
    p90: at(0.9),
    max: a[a.length - 1],
    min: a[0],
  };
}

/**
 * 成本归因：逐手把 `ms`（模型往返）与 `tacMs`（战术层）按身份分开攒。
 * 返回 `{ byIdentity, total }`，两者形状都是 `{ moves, ms: number[], tac: number[], prov: {} }`。
 */
export function collectCost(games) {
  const byIdentity = new Map();
  const total = { moves: 0, ms: [], tac: [], prov: {} };
  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, { moves: 0, ms: [], tac: [], prov: {} });
    return map.get(key);
  };
  for (const g of games) {
    for (const m of g.moves || []) {
      if (!isUpstreamMove(m)) continue;
      const ai = m.ai || {};
      const id = moveIdentity(g, m);
      for (const b of [bucket(byIdentity, id), total]) {
        b.moves += 1;
        if (typeof ai.ms === 'number') b.ms.push(ai.ms);
        if (typeof ai.tacMs === 'number') b.tac.push(ai.tacMs);
        if (ai.prov) b.prov[ai.prov] = (b.prov[ai.prov] || 0) + 1;
      }
    }
  }
  return { byIdentity, total };
}

/** 把 `collectCost()` 的一个桶变成一行读数（含两种占比）。 */
export function costRow(identity, bucket) {
  const ms = quantiles(bucket.ms);
  const tac = quantiles(bucket.tac);
  const perMove = ms && tac ? Math.round((ms.mean + tac.mean) * 10) / 10 : null;
  return {
    identity,
    moves: bucket.moves,
    ms,
    tac,
    perMove,
    /* 战术占单手 = 战术 / (往返 + 战术)；战术/往返 = C2 验收轮对外报的那个比值 */
    shareOfMove: ms && tac && perMove ? Math.round((100 * tac.mean) / perMove * 10) / 10 : null,
    shareOfRoundTrip: ms && tac && ms.mean ? Math.round((100 * tac.mean) / ms.mean * 10) / 10 : null,
    prov: { ...bucket.prov },
  };
}

/**
 * 无序配对矩阵（配对样本口径）：每对身份一行，A 取字典序在前的一方，得分率是 **A 的视角**。
 * 这是「判跨档位有没有差」该看的那张表 —— BT Δ 的区间按局重采样、不利用配对结构。
 */
export function pairTable(records) {
  const pairs = new Map();
  for (const r of records) {
    if (r.black === r.white) continue;
    const a = r.black < r.white ? r.black : r.white;
    const b = a === r.black ? r.white : r.black;
    const key = a + ' vs ' + b;
    if (!pairs.has(key)) pairs.set(key, { a, b, games: 0, aWins: 0, draws: 0, bWins: 0, aHits: 0 });
    const row = pairs.get(key);
    const aScore = a === r.black ? r.blackScore : 1 - r.blackScore;
    row.games += 1;
    row.aHits += aScore;
    if (aScore === 1) row.aWins += 1;
    else if (aScore === 0.5) row.draws += 1;
    else row.bWins += 1;
  }
  return [...pairs.values()]
    .map((row) => ({
      ...row,
      aRate: row.games ? row.aHits / row.games : null,
      enough: row.games >= MIN_GAMES,
    }))
    .sort((x, y) => y.games - x.games || (x.a < y.a ? -1 : 1));
}

/** Rapfi「思考时间 → Elo」曲线点：只取 `rapfi|…|<ms>` 身份，按档升序。 */
export function rafiCurve(rows) {
  return rows
    .filter((r) => r.identity.startsWith('rapfi|'))
    .map((r) => {
      const m = /\|(\d+)$/.exec(r.identity);
      return { identity: r.identity, thinkMs: m ? Number(m[1]) : null, row: r };
    })
    .filter((p) => p.thinkMs != null)
    .sort((x, y) => x.thinkMs - y.thinkMs);
}

/**
 * 相邻两档的差（L4 曲线要读的就是这个）：ΔElo 与「两档 BT 区间是否重叠」。
 * 为什么把「重叠」也带上：ΔElo 的符号在小样本下会被噪声翻来翻去，区间重叠时**不许**说「这一档更强」
 * （与 §1/§4 同一条读数纪律）。
 */
export function curveDeltas(curve) {
  const out = [];
  for (let i = 1; i < curve.length; i += 1) {
    const prev = curve[i - 1].row;
    const cur = curve[i].row;
    const overlap = prev.btLo != null && prev.btHi != null && cur.btLo != null && cur.btHi != null
      ? prev.btLo <= cur.btHi && cur.btLo <= prev.btHi
      : null;
    out.push({
      fromMs: curve[i - 1].thinkMs,
      toMs: curve[i].thinkMs,
      delta: Number(cur.rating) - Number(prev.rating),
      overlap,
    });
  }
  return out;
}

/**
 * 开局分层表（§7 第 ④ 项）：按开局分组，每组给一张配对矩阵。
 * `openingOf(payload)` 由调用侧提供 —— 开局键在 `events.jsonl` 的 `game-start` 事件里，
 * 不在棋谱 payload 上（逐手 meta 只有 `opening: true` 标出「这几手是开局」）。
 * 没用开局库时返回空数组，报告里就写「本轮未启用开局库」。
 */
export function openingRows(games, openingOf) {
  const byOpening = new Map();
  for (const g of games) {
    const key = openingOf ? openingOf(g) : null;
    if (!key) continue;
    if (!byOpening.has(key)) byOpening.set(key, []);
    const rec = gameRecord(g);
    if (rec) byOpening.get(key).push(rec);
  }
  return [...byOpening.entries()]
    .map(([opening, recs]) => ({ opening, games: recs.length, pairs: pairTable(recs) }))
    .sort((a, b) => b.games - a.games || (a.opening < b.opening ? -1 : 1));
}

/**
 * 逐色格：同一格内**颜色固定**（黑方身份 vs 白方身份），因此排得掉先手优势。
 * 为什么单列（L3 第一晚实测教训）：60 局里黑方赢了 51 局（85%）、和棋 0 ⇒ 只看总比分会被「谁执黑」带跑。
 */
export function colorCells(records) {
  const cells = new Map();
  let blackWins = 0;
  let draws = 0;
  for (const r of records) {
    const key = `${r.black}\u0000${r.white}`;
    const c = cells.get(key) || { black: r.black, white: r.white, games: 0, blackWins: 0, whiteWins: 0, draws: 0 };
    c.games += 1;
    if (r.blackScore === 1) { c.blackWins += 1; blackWins += 1; } else if (r.blackScore === 0) { c.whiteWins += 1; } else { c.draws += 1; draws += 1; }
    cells.set(key, c);
  }
  return {
    cells: [...cells.values()].sort((a, b) => b.games - a.games || (a.black < b.black ? -1 : a.black > b.black ? 1 : a.white < b.white ? -1 : 1)),
    games: records.length,
    blackWins,
    draws,
  };
}

/** 同一身份在两种颜色下的战绩（先手优势有多大，一眼看得出来）。 */
export function colorSplit(records) {
  const map = new Map();
  const of = (id) => {
    if (!map.has(id)) map.set(id, { identity: id, blackGames: 0, blackWins: 0, whiteGames: 0, whiteWins: 0 });
    return map.get(id);
  };
  for (const r of records) {
    const b = of(r.black);
    b.blackGames += 1;
    if (r.blackScore === 1) b.blackWins += 1;
    const w = of(r.white);
    w.whiteGames += 1;
    if (r.blackScore === 0) w.whiteWins += 1;
  }
  return [...map.values()].sort((a, b) =>
    (b.blackGames + b.whiteGames) - (a.blackGames + a.whiteGames) || (a.identity < b.identity ? -1 : 1));
}

/**
 * 版本筛查判读（把阶梯计划 §7 的「筛查判读规则」机械化）：只决定**下一场跑什么**，
 * 不判谁更强（判强只看配对表与区间）。
 *
 * 只对版本身份（`official|v*`）生效，且必须是 3–5 个、两两都交过手 —— 否则返回 null（不是筛查形态）。
 * 三条判据（全过才算「有值得决赛的差距」）：
 *   ① 全序：两两点估计能排出一个无环全序（Copeland 赢场数排序，逐三元组查环）；
 *   ② 共同对手：直接比较的方向与该对共同对手上的间接比较方向一致；
 *   ③ 逐色格：不存在「换色翻面」（同一对里 A 执黑赢、执白输）。
 * 偏离原文的地方写在 `note` 里：计划 §7 的 ② 按「≥2 个共同对手」写，3 版筛查每对只有 1 个 ⇒ 退化。
 */
export function screenVersions(records, opts = {}) {
  const isVersion = (id) => typeof id === 'string' && /^official\|v[0-9]/.test(id);
  const versions = [...new Set(records.flatMap((r) => [r.black, r.white]))].filter(isVersion).sort();
  const maxVersions = opts.maxVersions == null ? 5 : opts.maxVersions;
  if (versions.length < 3 || versions.length > maxVersions) return null;

  const cells = new Map();
  for (const r of records) {
    const x = r.black;
    const y = r.white;
    if (!isVersion(x) || !isVersion(y) || x === y || !versions.includes(x) || !versions.includes(y)) continue;
    const a = x < y ? x : y;
    const b = a === x ? y : x;
    const key = a + '\u0000' + b;
    if (!cells.has(key)) {
      cells.set(key, {
        a, b, games: 0, scoreA: 0,
        asBlack: { games: 0, score: 0 }, asWhite: { games: 0, score: 0 },
      });
    }
    const c = cells.get(key);
    const aScore = a === x ? r.blackScore : 1 - r.blackScore;
    c.games += 1;
    c.scoreA += aScore;
    const side = a === x ? c.asBlack : c.asWhite;
    side.games += 1;
    side.score += aScore;
  }
  const pairs = [...cells.values()].map((c) => ({
    a: c.a, b: c.b, games: c.games, rateA: c.games ? c.scoreA / c.games : null,
    blackRate: c.asBlack.games ? c.asBlack.score / c.asBlack.games : null,
    blackGames: c.asBlack.games,
    whiteRate: c.asWhite.games ? c.asWhite.score / c.asWhite.games : null,
    whiteGames: c.asWhite.games,
  }));
  const need = (versions.length * (versions.length - 1)) / 2;
  const minPairGames = pairs.length ? Math.min(...pairs.map((p) => p.games)) : 0;
  const base = { versions, pairs, minPairGames, games: pairs.reduce((n, p) => n + p.games, 0) };

  /** x 对 y 的得分率（不分颜色）。 */
  const rateOf = (x, y) => {
    const p = pairs.find((q) => (q.a === x && q.b === y) || (q.a === y && q.b === x));
    if (!p || !p.games) return null;
    return p.a === x ? p.rateA : 1 - p.rateA;
  };
  /** x 对 y 的「执黑/执白」分色得分率（x 视角）。 */
  const colorOf = (x, y) => {
    const p = pairs.find((q) => (q.a === x && q.b === y) || (q.a === y && q.b === x));
    if (!p) return { black: null, white: null };
    return p.a === x ? { black: p.blackRate, white: p.whiteRate } : { black: p.whiteRate, white: p.blackRate };
  };

  if (pairs.length < need) {
    return {
      ...base, complete: false, order: null, consistent: null, cycles: [],
      indirect: [], colorFlips: [], verdict: 'run-l1',
      reasons: [`只凑齐 ${pairs.length}/${need} 对（版本之间没两两交过手）⇒ 筛查不成立`],
    };
  }

  /* ① 全序：Copeland 赢场数排序 + 逐三元组查环（点估计，和棋记 0.5）。 */
  const beats = (x, y) => {
    const r = rateOf(x, y);
    return r != null && r > 0.5;
  };
  const wins = new Map(versions.map((v) => [v, versions.filter((o) => o !== v && beats(v, o)).length]));
  const meanRate = (v) => {
    const rs = versions.filter((o) => o !== v).map((o) => rateOf(v, o)).filter((r) => r != null);
    return rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : 0;
  };
  const order = [...versions].sort((x, y) =>
    wins.get(y) - wins.get(x) || meanRate(y) - meanRate(x) || (x < y ? -1 : 1));
  const cycles = [];
  for (const x of versions) {
    for (const y of versions) {
      for (const z of versions) {
        if (!(x < y && y < z)) continue;
        if (beats(x, y) && beats(y, z) && beats(z, x)) cycles.push({ triple: [x, y, z], detail: `${x}>${y}>${z}>${x}（环）` });
      }
    }
  }
  const consistent = cycles.length === 0;

  /* ② 共同对手：直接比较方向 vs 经共同对手的间接比较方向。 */
  const indirect = [];
  for (const x of versions) {
    for (const y of versions) {
      if (!(x < y)) continue;
      const direct = rateOf(x, y) - 0.5;
      for (const z of versions) {
        if (z === x || z === y) continue;
        const xz = rateOf(x, z);
        const yz = rateOf(y, z);
        if (xz == null || yz == null) continue;
        const via = xz - yz;
        indirect.push({
          pair: [x, y], via: z, direct, viaDelta: via,
          agrees: direct === 0 || via === 0 ? null : (direct > 0) === (via > 0),
        });
      }
    }
  }
  const indirectBad = indirect.filter((i) => i.agrees === false);

  /* ③ 逐色格：同一对里「A 执黑赢、执白输」就是换色翻面。 */
  const colorFlips = [];
  for (const p of pairs) {
    if (p.blackRate == null || p.whiteRate == null) continue;
    const dBlack = p.blackRate - 0.5;
    const dWhite = p.whiteRate - 0.5;
    if (dBlack !== 0 && dWhite !== 0 && (dBlack > 0) !== (dWhite > 0)) {
      colorFlips.push({ pair: [p.a, p.b], asBlack: p.blackRate, asWhite: p.whiteRate, blackGames: p.blackGames, whiteGames: p.whiteGames });
    }
  }

  const reasons = [];
  if (!consistent) reasons.push(`点估计有环：${cycles.map((c) => c.detail).join('、')}`);
  if (indirectBad.length) {
    reasons.push('间接比较与直接比较不同向：' + indirectBad
      .map((i) => `${i.pair[0]} vs ${i.pair[1]}（直接 ${fmtSigned(i.direct)}，经 ${i.via} ${fmtSigned(i.viaDelta)}）`).join('、'));
  }
  if (colorFlips.length) {
    reasons.push('换色翻面：' + colorFlips
      .map((f) => `${f.pair[0]} vs ${f.pair[1]}（执黑 ${fmtPt(f.asBlack)}／执白 ${fmtPt(f.asWhite)}）`).join('、'));
  }
  const verdict = reasons.length === 0 ? 'pass' : 'run-l1';
  return {
    ...base,
    complete: true,
    order,
    consistent,
    cycles,
    indirect,
    colorFlips,
    verdict,
    finalPair: verdict === 'pass' ? [order[0], order[1]] : null,
    reasons: verdict === 'pass'
      ? ['三条判据全过 ⇒ 有值得决赛的差距（只补头部两版的配对）']
      : reasons,
    note: '计划 §7 的 ② 按「≥2 个共同对手」写；3 版筛查每对只有 1 个共同对手 ⇒ ② 退化为「间接与直接同向」。',
  };
}

/** 差值带符号的百分点写法（`+5.0pt` / `-5.0pt`）。 */
function fmtSigned(x) {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pt`;
}

/**
 * 收尾机制：把「这局是怎么结束的」摊开 —— 直接决定结论怎么读（规则 11：和棋可接受，但要说清来路）。
 * 为什么单列：vorder1 round-1 实测 5 局和棋**全部**是 225 手「棋盘已满」（不是协议和、不是认输），
 * 「双方都守住了」与「双方都不敢下」是两种故事，报告里不写清就会被读成后者。
 */
export function endReasons(games) {
  const reasons = new Map();
  const draws = [];
  const plies = [];
  let unscored = 0;
  for (const g of games) {
    const raw = g.endReason ?? g.reason;
    const reason = typeof raw === 'string' && raw.trim() ? raw.trim() : '未知';
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
    const n = (g.moves || []).length;
    plies.push(n);
    const rec = gameRecord(g);
    if (!rec) unscored += 1;
    else if (rec.blackScore === 0.5) draws.push(n);
  }
  return {
    reasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)),
    draws: { count: draws.length, plies: draws.sort((a, b) => a - b) },
    plies: quantiles(plies),
    unscored,
  };
}

/**
 * 接管层 × 局结果：每身份一行，层按开火次数降序，括号里是「该层开火的那几手所属局」的战绩（该身份视角）。
 * 这是**解释性**口径（规则 11 要求解释败局：输在哪些层、和局靠哪些层守住），**不参与判强** —— 判强只看 §1/§4。
 * 层的取法与 `scripts/lib/tactics-replay.mjs:52 recordedLayerOf()` 同源：`move.tactics || move.ai.tac`
 * （`ai.tv` 是**战术版本**，不是层 —— 第一版探针在这里踩过）。
 */
export function layersByResult(games) {
  const by = new Map();
  for (const g of games) {
    const rec = gameRecord(g);
    if (!rec) continue;
    const uid = rec.gameUid || '';
    for (const m of g.moves || []) {
      const ai = (m && m.ai) || {};
      const layer = typeof m.tactics === 'string' && m.tactics ? m.tactics
        : typeof ai.tac === 'string' && ai.tac ? ai.tac : null;
      if (!layer) continue;
      const id = moveIdentity(g, m);
      if (!by.has(id)) by.set(id, { identity: id, uids: new Set(), layers: new Map() });
      const row = by.get(id);
      row.uids.add(uid);
      const l = row.layers.get(layer) || { layer, total: 0, win: 0, draw: 0, loss: 0 };
      const score = m.side === BLACK_SIDE ? rec.blackScore : 1 - rec.blackScore;
      l.total += 1;
      if (score === 1) l.win += 1;
      else if (score === 0.5) l.draw += 1;
      else l.loss += 1;
      row.layers.set(layer, l);
    }
  }
  return [...by.values()]
    .map((r) => {
      const layers = [...r.layers.values()].sort((a, b) => b.total - a.total || (a.layer < b.layer ? -1 : 1));
      return { identity: r.identity, games: r.uids.size, moves: layers.reduce((n, l) => n + l.total, 0), layers };
    })
    .sort((a, b) => b.moves - a.moves || (a.identity < b.identity ? -1 : 1));
}

/** 显著性说明（CI 宽度与重叠、样本不足清单）。 */
export function significance(rows, pairs) {
  const withCi = rows.filter((r) => r.ci);
  const widths = withCi.map((r) => (r.halfPt == null ? 0 : r.halfPt * 2)).sort((a, b) => a - b);
  const thin = rows.filter((r) => !r.enough).map((r) => r.identity);
  const thinPairs = pairs.filter((p) => !p.enough).map((p) => `${p.a} vs ${p.b}（${p.games} 局）`);
  const overlapPairs = [];
  for (let i = 0; i < withCi.length; i += 1) {
    for (let j = i + 1; j < withCi.length; j += 1) {
      const a = withCi[i];
      const b = withCi[j];
      if (a.ci.lo <= b.ci.hi && b.ci.lo <= a.ci.hi) overlapPairs.push(`${a.identity} ↔ ${b.identity}`);
    }
  }
  return {
    widthMin: widths.length ? Math.round(widths[0] * 10) / 10 : null,
    widthMax: widths.length ? Math.round(widths[widths.length - 1] * 10) / 10 : null,
    thin,
    thinPairs,
    overlapCount: overlapPairs.length,
    overlapPairs,
  };
}

const fmtPt = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const fmtMs = (q) => (q == null ? '—' : `${q.mean}／${q.median}／${q.p90}／${q.max}`);

/**
 * 组装人读 markdown。`model` 由 CLI 组装：
 * `{batchId, generatedAt, dirs, rounds, games, rows, records, pairs, cost, prov, artifacts, anchor, seed, bootstrap}`。
 */
export function reportMarkdown(model) {
  const out = [];
  const { rows, pairs, cost } = model;
  const sig = significance(rows, pairs);
  out.push(`# 阶梯报告：${model.batchId}`);
  out.push('');
  out.push(`- 生成时间：${model.generatedAt}`);
  out.push(`- 输入：${model.dirs.map((d) => `\`${d}\``).join('、')}`);
  out.push(`- 规模：**${model.records.length} 局有胜负**（总 payload ${model.games.length} 局）／${model.rounds} 轮／${rows.length} 个身份`);
  out.push(`- 运行面：${model.runtime || '—'}`);
  out.push(`- BT：锚点 \`${model.anchor || DEFAULT_ANCHOR}\`（不在数据里时退化成均值居中）｜bootstrap ${model.bootstrap} 次｜seed ${model.seed}`);
  out.push('');
  out.push('> 读数纪律：Wilson 与 BT 区间都会印在点估计旁边。样本 < ' + MIN_GAMES + ' 局的身份会被标注；');
  out.push('> **区间重叠就不允许说「A 比 B 强」**，跨档位的结论一律看第 4 节的配对样本。');
  if (model.incomplete && model.incomplete.length) {
    out.push('>');
    out.push(`> ⚠ **有 ${model.incomplete.length} 轮仍在跑**（缺 \`round-summary.json\`）：` +
      model.incomplete.map((r) => `round-${r.round}（${r.games} 局已计入）`).join('、') +
      '。');
    out.push('> 这些局不能进结论（对手还没打完）；等该轮收尾后重出报告，或加 `--skip-incomplete` 只算已收尾的轮。');
  }
  if (model.skippedIncomplete && model.skippedIncomplete.length) {
    out.push('>');
    out.push('> 已按 `--skip-incomplete` 跳过仍在跑的轮：' +
      model.skippedIncomplete.map((r) => `round-${r.round}（${r.games} 局）`).join('、') + '。');
  }
  out.push('');

  out.push('## 1 能力表（BT Elo + bootstrap 95% CI + W/D/L + 得分率 + Wilson）');
  out.push('');
  out.push('```');
  out.push(formatRankTable(rows));
  out.push('```');
  out.push('');

  out.push('## 2 Rapfi「思考时间 → Elo」曲线');
  out.push('');
  const curve = rafiCurve(rows);
  if (curve.length === 0) {
    out.push('（本轮没有 rapfi 身份）');
  } else {
    out.push('| 思考档 | Elo | ΔElo（相对上一档） | BT Δ | 95% 区间(BT Δ) | 局数 | 胜/和/负 | 得分率 | Wilson 95% |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (let i = 0; i < curve.length; i += 1) {
      const p = curve[i];
      const r = p.row;
      const d = i === 0 ? null : curveDeltas(curve)[i - 1];
      out.push(`| ${p.thinkMs} ms | ${r.rating} | ${d == null ? '—' : (d.delta >= 0 ? '+' : '') + d.delta.toFixed(1)} | ` +
        `${r.btDelta == null ? '—' : r.btDelta} | ` +
        `${r.btLo == null ? '—' : `[${r.btLo}–${r.btHi}]`} | ${r.games} | ${r.w}/${r.d}/${r.l} | ` +
        `${fmtPt(r.rate)} | ${r.ci ? `[${fmtPt(r.ci.lo)}–${fmtPt(r.ci.hi)}]` : '—'} |`);
    }
    if (curve.length > 1) {
      const ds = curveDeltas(curve);
      const shown = ds.map((d) => `${d.fromMs}→${d.toMs}：${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)}` +
        `${d.overlap === true ? '（区间重叠）' : d.overlap === false ? '（区间不重叠）' : ''}`).join('、');
      const overlapN = ds.filter((d) => d.overlap === true).length;
      out.push('');
      out.push(`- 相邻档差：${shown}。`);
      out.push(`- 读数：ΔElo 是同一根 BT 标尺上的差；**相邻档区间重叠时不许说「这一档更强」** —— ` +
        `本曲线 ${ds.length} 对相邻档里有 **${overlapN} 对区间重叠**。`);
      const thin = curve.filter((p) => p.row.games < 50).map((p) => `${p.thinkMs} ms`);
      out.push(`- 每档样本：${curve.map((p) => `${p.thinkMs} ms ${p.row.games} 局`).join('、')}；` +
        `${thin.length ? `样本 < 50 局的档：${thin.join('、')}` : '没有样本 < 50 局的档'}。`);
    }
  }
  out.push('');

  out.push('## 3 成本表（战术层与模型往返分开，m07650/m08110 必报项）');
  out.push('');
  if (cost.rows.length === 0) {
    out.push('（本轮没有上游手：双方都不是 Jev 渠道）');
  } else {
    out.push('| 身份 | Jev 手数 | 模型往返 ms（均值／中位／p90／最差） | 战术层 ms（均值／中位／p90／最差） | 单手合计均值 | 战术占单手 | 战术/往返 | 提供方 |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of cost.rows) {
      const prov = Object.entries(r.prov).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
      out.push(`| ${r.identity} | ${r.moves} | ${fmtMs(r.ms)} | ${fmtMs(r.tac)} | ${r.perMove == null ? '—' : r.perMove} | ` +
        `${r.shareOfMove == null ? '—' : r.shareOfMove + '%'} | ${r.shareOfRoundTrip == null ? '—' : r.shareOfRoundTrip + '%'} | ${prov} |`);
    }
    out.push(`| **全轮合计** | ${cost.totalRow.moves} | ${fmtMs(cost.totalRow.ms)} | ${fmtMs(cost.totalRow.tac)} | ${cost.totalRow.perMove} | ` +
      `${cost.totalRow.shareOfMove}% | ${cost.totalRow.shareOfRoundTrip}% | ${Object.entries(cost.totalRow.prov).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'} |`);
    out.push('');
    out.push('> 「战术占单手」= 战术层均值 ÷（模型往返均值 + 战术层均值）；「战术/往返」是 C2 验收轮对外报的那个比值。');
    out.push('> 上游兜底手（`provider=backup`）单列在「提供方」列，**未计入主口径**。');
  }
  out.push('');

  out.push('## 4 配对样本矩阵（判「谁更强」只看这张表）');
  out.push('');
  out.push('| 对（A vs B） | 局数 | A 胜/和/负 | A 得分率 | Wilson 95% | 可判 |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const p of pairs) {
    const ci = wilson(p.aHits, p.games);
    out.push(`| ${p.a} vs ${p.b} | ${p.games} | ${p.aWins}/${p.draws}/${p.bWins} | ${fmtPt(p.aRate)} | ` +
      `${ci ? `[${fmtPt(ci.lo)}–${fmtPt(ci.hi)}]` : '—'} | ` +
      `${p.enough ? '✅' : `⚠ <${MIN_GAMES}`} |`);
  }
  out.push('');
  const cells = colorCells(model.records);
  out.push('逐色格（同一格内颜色固定 ⇒ 排掉先手优势；先手优势本身也要报）：');
  out.push('');
  out.push(`- 本轮黑方胜 ${cells.blackWins}/${cells.games}` +
    `（${cells.games ? ((cells.blackWins / cells.games) * 100).toFixed(1) : '—'}%）｜和棋 ${cells.draws}`);
  out.push('');
  out.push('| 局面格（黑方 vs 白方） | 局数 | 黑胜 | 白胜 | 和 |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const c of cells.cells) {
    out.push(`| ${c.black}（黑） vs ${c.white}（白） | ${c.games} | ${c.blackWins} | ${c.whiteWins} | ${c.draws} |`);
  }
  out.push('');
  out.push('按身份分开颜色（`执黑` 与 `执白` 两列都要看，只报总分会被先手优势带跑）：');
  out.push('');
  out.push('| 身份 | 总战绩 | 得分率 | 执黑 | 执白 |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const s of colorSplit(model.records)) {
    const total = s.blackGames + s.whiteGames;
    const wins = s.blackWins + s.whiteWins;
    out.push(`| ${s.identity} | ${wins}–${total - wins} | ${total ? ((wins / total) * 100).toFixed(1) : '—'}% | ` +
      `${s.blackWins}/${s.blackGames} | ${s.whiteWins}/${s.whiteGames} |`);
  }
  out.push('');
  /* 版本筛查判读（只对「3–5 个版本身份、两两都交过手」生效）：把计划 §7 的规则摊成三条判据，
     免得「要不要补 L1」靠肉眼在几张表之间来回看（n=20 的筛查本来就不许下强弱结论）。 */
  const screen = screenVersions(model.records);
  if (screen) {
    out.push('版本筛查判读（阶梯计划 §7 规则机械化；**只决定下一场跑什么**，不判谁更强）：');
    out.push('');
    if (!screen.complete) {
      out.push(`- ${screen.reasons[0]} ⇒ 判定：**筛查不成立**，按 §7 直接跑 L1。`);
    } else {
      const indirectBad = screen.indirect.filter((i) => i.agrees === false);
      out.push(`- 全序（点估计）：${screen.order.join(' > ')}｜判据 ① 全序${screen.consistent ? '无环 ✅' : `有环 ❌（${screen.cycles.map((c) => c.detail).join('、')}）`}`);
      out.push(`- 判据 ② 共同对手：` + (screen.indirect.length
        ? screen.indirect.map((i) => `${i.pair[0]} vs ${i.pair[1]} 直接 ${fmtSigned(i.direct)}／经 ${i.via} ${fmtSigned(i.viaDelta)}`).join('、') +
          ` ⇒ ${indirectBad.length ? `有 ${indirectBad.length} 处反向 ❌` : '全部同向 ✅'}`
        : '共同对手不足 ⚠'));
      out.push(`- 判据 ③ 逐色格：` + (screen.colorFlips.length
        ? screen.colorFlips.map((f) => `${f.pair[0]} vs ${f.pair[1]} 执黑 ${fmtPt(f.asBlack)}／执白 ${fmtPt(f.asWhite)}`).join('、') + ' ⇒ 换色翻面 ❌'
        : '无换色翻面 ✅'));
      out.push(`- 样本：最小配对 ${screen.minPairGames} 局／合计 ${screen.games} 局` +
        (screen.minPairGames < MIN_GAMES ? `（< ${MIN_GAMES} ⇒ 只作筛查，不能写进结论）` : ''));
      out.push(screen.verdict === 'pass'
        ? `- 判定：**有值得决赛的差距** ⇒ 只补决赛对 \`${screen.finalPair[0]} vs ${screen.finalPair[1]}\`（100–200 局配对），先不跑 L1。`
        : `- 判定：**筛查不成立** ⇒ 按 §7 直接跑 L1（L1 也回答不了「A 比 B 强」，它只给梯队相对位置）。`);
      if (screen.verdict !== 'pass') out.push(`  - 原因：${screen.reasons.join('；')}`);
      out.push(`- 口径提示：${screen.note}`);
    }
    out.push('');
  }
  if (!model.openings || model.openings.length === 0) {
    out.push('开局分层：**本轮未启用开局库**（`--openings` 未给）—— 对称性由「同一开局换色双跑」的偶数局保证，');
    out.push('每对内部的先后手已配平，但不控制具体开局形态。');
  } else {
    out.push('开局分层（检查开局是否偏向某一身份）：');
    out.push('');
    out.push('| 开局 | 局数 | 对 | 局数 | A 得分率 | Wilson 95% |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const o of model.openings) {
      for (const p of o.pairs) {
        const ci = wilson(p.aHits, p.games);
        out.push(`| \`${o.opening}\` | ${o.games} | ${p.a} vs ${p.b} | ${p.games} | ${fmtPt(p.aRate)} | ` +
          `${ci ? `[${fmtPt(ci.lo)}–${fmtPt(ci.hi)}]` : '—'} |`);
      }
    }
  }
  out.push('');
  if (model.games && model.games.length) {
    const ends = endReasons(model.games);
    out.push('收尾机制与接管层（**解释性口径**，不参与判强 —— 判强只看上面的配对表；规则 11 要求解释和棋与败局）：');
    out.push('');
    out.push(`- 收尾：${ends.reasons.map((r) => `${r.reason} ${r.count} 局`).join(' · ')}` +
      (ends.unscored ? `（${ends.unscored} 局无胜负，未计入）` : ''));
    if (ends.draws.count) {
      out.push(`- 和棋 ${ends.draws.count} 局的手数：${ends.draws.plies.join(' / ')}` +
        '（满盘和 = 双方都守住了，不是协议和）');
    }
    if (ends.plies) {
      out.push(`- 全局手数：均 ${ends.plies.mean} ／ 中位 ${ends.plies.median} ／ p90 ${ends.plies.p90} ／ 最长 ${ends.plies.max}`);
    }
    out.push('');
    const layerRows = layersByResult(model.games);
    if (layerRows.length) {
      out.push('| 身份 | 局数 | 接管手 | 接管层（开火次数；该层开火那几手的 胜/和/负） |');
      out.push('| --- | --- | --- | --- |');
      for (const r of layerRows) {
        const shown = r.layers.slice(0, 8).map((l) => `${l.layer} ${l.total}（${l.win}/${l.draw}/${l.loss}）`);
        const rest = r.layers.length > 8 ? ` · …共 ${r.layers.length} 层` : '';
        out.push(`| ${r.identity} | ${r.games} | ${r.moves} | ${shown.join(' · ')}${rest} |`);
      }
      out.push('');
      out.push('> 「接管手」= 战术层真的接了手的手数（`ai.tac` 非空），含攻击层与防守层；');
      out.push('> 同一层开火次数多不等于强 —— 它只说明这版**常在哪一层做决定**。');
    }
    out.push('');
  }

  out.push('## 5 显著性说明');
  out.push('');
  out.push(`- Wilson 区间宽度：最窄 ${sig.widthMin}pt ／ 最宽 ${sig.widthMax}pt`);
  out.push(`- 区间互相重叠的身份对：**${sig.overlapCount} 对**（重叠即不可判「更强」）`);
  if (sig.thin.length) out.push(`- 样本 < ${MIN_GAMES} 局的身份：${sig.thin.join('、')}`);
  if (sig.thinPairs.length) out.push(`- 样本 < ${MIN_GAMES} 局的配对：${sig.thinPairs.join('、')}`);
  if (model.incomplete && model.incomplete.length) {
    out.push(`- **未收尾的轮**：${model.incomplete.map((r) => `round-${r.round}（${r.games} 局）`).join('、')}` +
      ' —— 这几轮的比分只作进度参考，不参与「谁更强」的判断');
  }
  out.push('');

  out.push('## 6 产物清单');
  out.push('');
  out.push('| 文件 | 字节 | 行数 | sha256（前 12） |');
  out.push('| --- | --- | --- | --- |');
  for (const a of model.artifacts) {
    out.push(`| \`${a.path}\` | ${a.bytes} | ${a.lines == null ? '—' : a.lines} | \`${a.sha256}\` |`);
  }
  out.push('');
  return out.join('\n');
}
