/**
 * scripts/lib/tactics-replay.mjs — 任意棋谱 × 任意战术档位的离线重放核（零依赖、纯函数）
 *
 * 为什么是纯核：CLI（`scripts/tactics-replay.mjs`）只负责找文件、打印表格与退出码，
 * 可检验的判定逻辑全在这里，由 `test/scripts/tactics-replay.spec.mjs` 用合成棋谱钉住。
 *
 * ── 重放语义（这是本工具唯一需要小心的地方，写清楚免得被误读）────────────────────
 * 真做一手要两个输入：① 确定性事实（战术层：`computeTactics`）；② 模型给出的逐点概率
 * （`decide()` 里 `pairs` 的来源）。**归档里没有②**（D1 只存了实走那一点的
 * `confidence`/`prob`/`rank`，没有整张概率表），所以重放刻意用「无模型」口径：
 *   - `pairs` = 全部合法着法、概率同为 1（与 `decide(channel:'random')` 同口径，
 *     稳定排序后顺序 = `legal` 顺序）；
 *   - 于是「重放落点」= **该档接管链在平坦模型下的首选点**，不是「模型会怎么选」。
 * 据此，与实走的对照分三层看，别混着读：
 *   - **层一致率**：重放算出的接管层 vs 归档里那手的战术标记（`move.tactics`/`ai.tac`）。
 *     这是本工具最强的结论——层由确定性事实决定，与模型无关。
 *   - **落点一致率**：重放首选点 vs 实走点。**有接管的手**才说明问题；没有接管的手
 *     （层为 null）本来就该由模型决定，落点不同是预期，不算「会变」。
 *   - **会变的手**（`changed`）= 层不同（含「记录有接管而重放不接管 / 反之」）或
 *     「层相同但有接管且落点不同」。这是给人看的差异清单。
 *
 * ── 不做的事 ────────────────────────────────────────────────────────────────
 *   - 不碰网络、不读 D1：输入只能是本地棋谱 JSON（归档 `games/**` 或 D1 导出的同形状文件）；
 *   - 不猜模型概率（见上）；要逐字复现某档的「当时行为」走 P7 的 `--rev <sha>` 掉 worktree。
 */
import { getGame, ids as gameIds, games } from '../../src/core/registry.ts';
import { computeTactics, emptyTactics, mechOf } from '../../src/core/tactics.ts';
import { pickTakeover } from '../../src/core/takeover.ts';
import { CURRENT, ids as versionIds } from '../../src/core/tactics-versions.ts';

/** 全部合法档号（回放前的白名单；未知档号必须报错，绝不静默回落 CURRENT）。 */
export const TACTICS_IDS = versionIds();

/** 会真跑战术层的渠道判据：与 `src/core/view/duel.ts:runsTactics()` 同源（mock/rapfi/人类侧不进战术层）。 */
export function runsTacticsChannel(channel) {
  const ch = String(channel || '');
  return ch !== '' && ch !== 'mock' && ch !== 'rapfi';
}

/** 记法 → 行棋方 id：归档里写中文「黑方/白方」，新导出按引擎 id 写。 */
export function sideIdOf(engine, label) {
  const l = String(label || '').trim();
  const sides = engine.sides || [];
  for (const s of sides) {
    if (l === s.id || l === s.name) return s.id;
  }
  if (l === 'black' || l === '白方' || l === 'white') return l === 'white' || l === '白方' ? 'white' : 'black';
  return null;
}

/** 一手记录里的战术标记（老实现写 `move.tactics`，新导出写 `ai.tac`；都没有则 null）。 */
export function recordedLayerOf(move) {
  if (!move) return null;
  const direct = move.tactics;
  if (typeof direct === 'string' && direct) return direct;
  const ai = move.ai;
  if (ai && typeof ai.tac === 'string' && ai.tac) return ai.tac;
  return null;
}

/** 该手记录里带的档号（`ai.tv`；老归档没有整手档号，只有局级 `tacticsVersion`）。 */
export function recordedVersionOf(move, record) {
  const tv = move && move.ai && move.ai.tv;
  if (typeof tv === 'string' && tv) return tv;
  const gt = record && record.tacticsVersion;
  return typeof gt === 'string' && gt ? gt : null;
}

/** 这一手属于哪一侧的渠道（逐手 channel → 局级 black/whiteChannel → 局级 channel）。 */
export function channelOfPly(record, move, sideId) {
  const perMove = move && (move.channel || (move.ai && move.ai.channel));
  if (typeof perMove === 'string' && perMove) return perMove;
  const side = sideId === 'black' ? record.blackChannel : record.whiteChannel;
  if (typeof side === 'string' && side) return side;
  return typeof record.channel === 'string' ? record.channel : null;
}

/** 棋种解析：先按引擎 id，再按显示名（老归档写的是「五子棋」这种名字）。 */
function resolveEngine(idOrName) {
  const key = String(idOrName || '');
  const direct = getGame(key);
  if (direct) return direct;
  for (const id of gameIds) {
    const g = games[id];
    if (g && (g.name === key || g.id === key)) return g;
  }
  return undefined;
}

/** 校验并规整一份棋谱（不认识就 throw，不做静默兜底）。 */
export function parseRecord(raw, opts) {
  const o = opts || {};
  if (!raw || typeof raw !== 'object') throw new Error('棋谱不是对象：' + (o.file || '?'));
  const moves = raw.moves;
  if (!Array.isArray(moves) || !moves.length) throw new Error('棋谱没有 moves 数组：' + (o.file || '?'));
  // 棋种解析顺序：显式给的 → slug → 显示名 → 默认 gomoku。
  // 实验面归档的 `slug` 是「对阵描述」（例如 jev-v14-vs-rapfi-0-5s），不是棋种；老归档又可能
  // 只写显示名（「五子棋」）。逐个试，别让一个不认识的 slug 把整局判死（L2 的 300 局全栽在这）。
  const candidates = [o.gameId, raw.slug, raw.game, raw.gid]
    .filter((x) => typeof x === 'string' && x.trim());
  let engine;
  for (const c of candidates) {
    engine = resolveEngine(c);
    if (engine) break;
  }
  if (!engine && candidates.length === 0) engine = resolveEngine('gomoku'); // 一个棋种字段都没写才用默认
  if (!engine) throw new Error(`不认识的棋种 "${candidates[0] || '?'}"（${o.file || '?'}）——归档里的 game/gid 得是引擎 id 或显示名`);
  const uid = raw.gameUid || raw.uid || raw.gid || null;
  return { engine, uid, tag: raw.experimentTag || raw.experiment || null, raw, moves };
}

/**
 * 重放一局。
 *
 * @param {{engine: import('../../src/core/types.ts').Engine, raw: object, moves: object[]}} rec `parseRecord()` 的产物
 * @param {{tactics?: string, sides?: 'auto'|'both'|'black'|'white', limit?: number, onProgress?: (r: object) => void}} opts
 * @returns {{rows: object[], summary: object, costMs: number}}
 */
export function replayGame(rec, opts) {
  const o = opts || {};
  const engine = rec.engine;
  const forced = o.tactics ? String(o.tactics) : null;
  if (forced && !TACTICS_IDS.includes(forced)) {
    throw new Error(`未知战术档 "${forced}"，合法值：${TACTICS_IDS.join(', ')}`);
  }
  const sides = o.sides || 'auto';
  if (!['auto', 'both', 'black', 'white'].includes(sides)) throw new Error(`--sides 只能是 auto/both/black/white：${sides}`);
  const limit = Number.isFinite(Number(o.limit)) && Number(o.limit) > 0 ? Math.trunc(Number(o.limit)) : Infinity;

  const rows = [];
  const notes = [];
  let unknownChannelNoted = false;
  let st = engine.newGame();
  let replayed = 0;
  let costMs = 0;
  const hasLayerField = rec.moves.some((m) => recordedLayerOf(m) !== null || (m && m.tactics !== undefined));

  for (let i = 0; i < rec.moves.length; i++) {
    const m = rec.moves[i];
    if (!m || typeof m.notation !== 'string' || !m.notation) { notes.push(`第 ${i + 1} 手没有 notation，停止`); break; }
    const sideId = sideIdOf(engine, m.side) || (st.turn === engine.sides[0].id ? engine.sides[0].id : st.turn);
    if (st.turn !== sideId) {
      notes.push(`ply ${m.ply ?? i + 1}：记谱方 ${sideId} 与盘面轮次 ${st.turn} 不一致（棋谱与棋种对不上？）`);
    }
    const channel = channelOfPly(rec.raw, m, sideId);
    const wantSide = sides === 'both' || sides === 'auto' || sides === sideId;
    /* 渠道**未知**（棋谱没写）与「已知不过战术层」（mock/rapfi）是两件事：
       前者按「会跑」重放并留一条 note，否则整局会静默重放出 0 手、汇总全空。 */
    const chKnown = typeof channel === 'string' && channel !== '';
    if (!chKnown && wantSide && !unknownChannelNoted) {
      unknownChannelNoted = true;
      notes.push('棋谱没写渠道 ⇒ 按「会跑战术层」重放（若那侧其实是 rapfi/mock，用 --sides 排除）');
    }
    const runs = wantSide && (chKnown ? runsTacticsChannel(channel) : true);
    const recordedLayer = recordedLayerOf(m);
    const recordedVersion = recordedVersionOf(m, rec.raw);
    const perMoveV = m && m.ai && m.ai.tv;
    const versionId = forced || recordedVersion || CURRENT;
    /** 档号来源：forced（--tactics）/ move（逐手 ai.tv）/ game（局级 tacticsVersion）/ current（**推断**）。 */
    const vSource = forced ? 'forced' : (perMoveV ? 'move' : (rec.raw.tacticsVersion ? 'game' : 'current'));

    if (!runs) {
      rows.push({
        ply: m.ply ?? i + 1, side: sideId, ran: false, skip: !wantSide ? `--sides=${sides}` : `渠道 ${channel || '?'} 不过战术层`,
        v: versionId, layer: null, notation: null, recordedLayer, recordedNotation: m.notation,
      });
    } else if (replayed >= limit) {
      rows.push({
        ply: m.ply ?? i + 1, side: sideId, ran: false, skip: `--limit ${limit}`,
        v: versionId, layer: null, notation: null, recordedLayer, recordedNotation: m.notation,
      });
    } else {
      const t0 = Date.now();
      const ser = engine.serializeForJev(st, st.turn);
      const crit = ((ser.questions || {}).move || {}).criteria || {};
      const cands = Object.keys(crit);
      const legal = engine.getLegalMoves(st);
      let tactics;
      try {
        tactics = computeTactics(engine, st, legal, cands, versionId);
      } catch (err) {
        tactics = emptyTactics();
        notes.push(`ply ${m.ply ?? i + 1}：computeTactics 抛错，按空战术重放（${String(err && err.message || err)}）`);
      }
      let tookMs = 0;
      const tk = pickTakeover({
        engine, st, tactics, mech: mechOf(versionId), criteria: crit,
        legal, pairs: legal.map((mv) => [mv.notation, 1]), cands, topK: 1,
        onTime: (ms) => { tookMs += ms; },
      });
      const ms = Date.now() - t0;
      costMs += ms;
      replayed++;
      rows.push({
        ply: m.ply ?? i + 1, side: sideId, ran: true, v: versionId, vSource,
        layer: tk.layer, notation: tk.layer ? tk.notation : null,
        bypassed: tk.bypassed, cands: cands.length, ms, tacticMs: tookMs,
        recordedLayer, recordedNotation: m.notation,
      });
      if (o.onProgress) o.onProgress(rows[rows.length - 1]);
    }

    const mv = engine.moveFromNotation(st, m.notation);
    if (!mv) { notes.push(`ply ${m.ply ?? i + 1}：非法着法 ${m.notation}，停止重放`); break; }
    st = engine.applyMove(st, mv);
  }
  return { rows, summary: summarize(rows, { hasLayerField, replayed, costMs, notes }), costMs, notes };
}

/** 汇总一批重放行（跨局累计时把 rows 直接 concat 再调它）。 */
export function summarize(rows, extra) {
  const e = extra || {};
  const replayedRows = rows.filter((r) => r.ran);
  const withLayer = replayedRows.filter((r) => r.layer);
  const layerCmp = e.hasLayerField ? replayedRows : [];
  const sameLayer = layerCmp.filter((r) => (r.layer || null) === (r.recordedLayer || null));
  const sameMoveOnTakeover = withLayer.filter((r) => r.notation === r.recordedNotation);
  const changed = replayedRows.filter((r) => {
    if (e.hasLayerField && (r.layer || null) !== (r.recordedLayer || null)) return true;
    return r.layer && r.notation !== r.recordedNotation;
  });
  const layers = {};
  for (const r of replayedRows) layers[r.layer || '(不接管)'] = (layers[r.layer || '(不接管)'] || 0) + 1;
  const recLayers = {};
  for (const r of replayedRows) if (r.recordedLayer) recLayers[r.recordedLayer] = (recLayers[r.recordedLayer] || 0) + 1;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    moves: rows.length,
    replayed: replayedRows.length,
    skipped: rows.length - replayedRows.length,
    layerFieldKnown: !!e.hasLayerField,
    layerCompared: layerCmp.length,
    layerSame: sameLayer.length,
    layerSameRate: pct(sameLayer.length, layerCmp.length),
    takeoverMoves: withLayer.length,
    takeoverMoveSame: sameMoveOnTakeover.length,
    takeoverMoveSameRate: pct(sameMoveOnTakeover.length, withLayer.length),
    changed: changed.length,
    changedRows: changed.map((r) => ({ ply: r.ply, side: r.side, v: r.v, layer: r.layer, was: r.recordedLayer, notation: r.notation, played: r.recordedNotation })),
    /** 档号是**推断**出来的行数（归档没记档号 ⇒ 用了 CURRENT）：这些行的「层」不可当历史结论读。 */
    versionInferred: replayedRows.filter((r) => r.vSource === 'current').length,
    layers,
    recordedLayers: recLayers,
    costMs: e.costMs || 0,
    notes: e.notes || [],
  };
}

/** 合并多局汇总（跨局报「与实走一致率」）。 */
export function mergeSummaries(summaries) {
  const all = Object.assign({}, ...summaries.map(() => ({})));
  const sum = (k) => summaries.reduce((a, s) => a + (Number(s[k]) || 0), 0);
  const layers = {};
  const recordedLayers = {};
  const changedRows = [];
  const notes = [];
  let layerFieldKnown = false;
  for (const s of summaries) {
    for (const [k, v] of Object.entries(s.layers || {})) layers[k] = (layers[k] || 0) + v;
    for (const [k, v] of Object.entries(s.recordedLayers || {})) recordedLayers[k] = (recordedLayers[k] || 0) + v;
    for (const r of s.changedRows || []) changedRows.push(r);
    for (const n of s.notes || []) notes.push(n);
    if (s.layerFieldKnown) layerFieldKnown = true;
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const layerCompared = layerFieldKnown ? sum('layerCompared') : 0;
  const takeoverMoves = sum('takeoverMoves');
  all.games = summaries.length;
  all.moves = sum('moves');
  all.replayed = sum('replayed');
  all.skipped = sum('skipped');
  all.layerFieldKnown = layerFieldKnown;
  all.layerCompared = layerCompared;
  all.layerSame = sum('layerSame');
  all.layerSameRate = pct(all.layerSame, layerCompared);
  all.takeoverMoves = takeoverMoves;
  all.takeoverMoveSame = sum('takeoverMoveSame');
  all.takeoverMoveSameRate = pct(all.takeoverMoveSame, takeoverMoves);
  all.changed = sum('changed');
  all.changedRows = changedRows;
  all.versionInferred = sum('versionInferred');
  all.layers = layers;
  all.recordedLayers = recordedLayers;
  all.costMs = sum('costMs');
  all.notes = notes;
  return all;
}
