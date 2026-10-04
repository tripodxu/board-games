// report.mjs — 阶梯报告的纯函数核心（每次阶梯必出，见 docs/plans/2026-10-03-tactics-fidelity-and-elo-ladder.md §7）
//
// 为什么单独一层：报告要在「L2 的 300 局」这种规模上复算六件事 —— 能力表（BT Elo + bootstrap 区间 +
// Wilson）、Rapfi 思考时间曲线、成本表（战术层与模型往返分开，m07650/m08110 的必报项）、配对样本矩阵、
// 显著性说明、产物清单。这些全是**纯计算**，文件读写留在 CLI（scripts/experiment-report.mjs），
// 于是单测能拿合成 payload 直接钉住口径，不必造目录树。
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
    out.push('| 思考档 | Elo | BT Δ | 95% 区间(BT Δ) | 局数 | 胜/和/负 | 得分率 | Wilson 95% |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const p of curve) {
      const r = p.row;
      out.push(`| ${p.thinkMs} ms | ${r.rating} | ${r.btDelta == null ? '—' : r.btDelta} | ` +
        `${r.btLo == null ? '—' : `[${r.btLo}–${r.btHi}]`} | ${r.games} | ${r.w}/${r.d}/${r.l} | ` +
        `${fmtPt(r.rate)} | ${r.ci ? `[${fmtPt(r.ci.lo)}–${fmtPt(r.ci.hi)}]` : '—'} |`);
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
