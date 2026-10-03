// batch-elo.mjs — 批量实验产物的身份归一 + Elo 顺序迭代（纯函数，零依赖）
//
// 为什么单独一个文件：elo 要从远端拉回来的棋谱 JSON 里算，输入全是
// buildGameExport 的产物（黑/白渠道、战术档、思考 ms、胜者），必须能在
// 本地（甚至 test/scripts 单测里）不碰网络地复算。
//
// 口径（D8）：
//   - 身份 = channel|tactics|thinkMs（战术档空 = '-'；mock 臂不过战术层，
//     thinkMs 对非 rapfi 臂无意义，统一记 0）。这个三元组来自
//     persist.ts 的 SideConfig，与实验面板的 duelLabel 同源。
//   - 顺序迭代（按时间序逐局更新），K=16，和棋记 0.5。
//   - <MIN_GAMES 局的身份只展示不计 ranking 标注（本版不做 Glicko）。
//   - 只统计 buildGameExport 里 result/winner 完整的局；dry-run 局也统计
//     （mock/random 臂的冒烟同样有胜负，可用于验证链路）。

import fs from 'node:fs';
import path from 'node:path';

/** 少于这个局数的身份在排行里标注「样本不足」。 */
export const MIN_GAMES = 50;

/** 身份归一：渠道/战术档/思考 ms 三元组。空战术档归 '-'，thinkMs 缺省 0。 */
export function identityOf(side) {
  const channel = String(side.channel || '').trim() || '-';
  const tactics = String(side.tactics || '').trim() || '-';
  const think = Number.isFinite(Number(side.thinkMs)) ? Math.trunc(Number(side.thinkMs)) : 0;
  return channel + '|' + tactics + '|' + think;
}

/** 从一个棋谱 export JSON 提取一局记录（黑/白身份 + 黑方得分）。 */
export function gameRecord(exportJson) {
  const g = typeof exportJson === 'string' ? JSON.parse(exportJson) : exportJson;
  const result = String(g.result || '');
  const winner = String(g.winner || '');
  let score = null; // 黑方得分
  if (winner === 'black') score = 1;
  else if (winner === 'white') score = 0;
  else if (winner === 'draw') score = 0.5;
  // winner 缺失/空/未知 ⇒ 未终局或超时截断，不是和棋，不计入 Elo
  if (score === null) return null;
  // 没有 identity 线索的 JSON 不当棋谱（多一层保险，正常布局下 visit 不到）
  if (!g.blackChannel || !g.whiteChannel) return null;
  return {
    tag: g.experiment || g.tag || '',
    gameUid: g.gameUid || g.game_uid || '',
    exported: g.exported || '',
    black: identityOf({ channel: g.blackChannel, tactics: g.blackTactics, thinkMs: g.blackThink }),
    white: identityOf({ channel: g.whiteChannel, tactics: g.whiteTactics, thinkMs: g.whiteThink }),
    blackScore: score,
    result,
    reason: g.endReason || g.end_reason || '',
    plies: Array.isArray(g.moves) ? g.moves.length : 0,
  };
}

/**
 * 读一个目录（或目录数组）下的棋谱 JSON，按 exported/tag 稳定排序。
 * 只收 `<任意层级>/games/*.json`：worker 的产物布局是 round-i/games/，
 * 这样 round-summary.json / elo.json / plans/plan.json 都不会被当成棋谱。
 */
export function loadRecords(dirOrDirs) {
  const dirs = Array.isArray(dirOrDirs) ? dirOrDirs : [dirOrDirs];
  const files = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.json$/i.test(name) && path.basename(d) === 'games') files.push(p);
      }
    };
    walk(dir);
  }
  const recs = [];
  for (const f of files) {
    let json = null;
    try { json = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const rec = gameRecord(json);
    if (rec) recs.push(rec);
  }
  recs.sort((a, b) => (a.exported || a.tag).localeCompare(b.exported || b.tag) || (a.gameUid || '').localeCompare(b.gameUid || ''));
  return recs;
}

/**
 * 顺序 Elo 迭代。K=16，和棋 0.5；同一局内双方同时更新。
 * 返回 { rating: Map<id,elo>, games: Map<id,局数>, matrix: Map<'a>b', {w,d,l,games}> }。
 */
export function computeElo(records, K = 16) {
  const rating = new Map();
  const games = new Map();
  const matrix = new Map();
  const seen = (id) => { if (!rating.has(id)) { rating.set(id, 1500); games.set(id, 0); } };
  for (const r of records) {
    seen(r.black); seen(r.white);
    const ra = rating.get(r.black);
    const rb = rating.get(r.white);
    const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    rating.set(r.black, ra + K * (r.blackScore - ea));
    rating.set(r.white, rb + K * (1 - r.blackScore - (1 - ea)));
    games.set(r.black, games.get(r.black) + 1);
    games.set(r.white, games.get(r.white) + 1);
    const key = r.black + '>>' + r.white;
    if (!matrix.has(key)) matrix.set(key, { black: r.black, white: r.white, w: 0, d: 0, l: 0, games: 0 });
    const m = matrix.get(key);
    m.games += 1;
    if (r.blackScore === 1) m.w += 1;
    else if (r.blackScore === 0.5) m.d += 1;
    else m.l += 1;
  }
  return { rating, games, matrix, k: K };
}

/** 排行行：Elo + 总局数 + 胜/和/负 + 样本不足标注。 */
export function rankTable(records, K = 16) {
  const { rating, games } = computeElo(records, K);
  const sides = new Map(); // id -> {w,d,l}
  for (const r of records) {
    if (!sides.has(r.black)) sides.set(r.black, { w: 0, d: 0, l: 0 });
    if (!sides.has(r.white)) sides.set(r.white, { w: 0, d: 0, l: 0 });
    const b = sides.get(r.black); const w = sides.get(r.white);
    if (r.blackScore === 1) { b.w += 1; w.l += 1; } else if (r.blackScore === 0.5) { b.d += 1; w.d += 1; } else { b.l += 1; w.w += 1; }
  }
  return [...games.keys()].map((id) => {
    const s = sides.get(id);
    const n = games.get(id);
    return { identity: id, rating: Math.round(rating.get(id) * 10) / 10, games: n, ...s, enough: n >= MIN_GAMES };
  }).sort((a, b) => b.rating - a.rating || b.games - a.games);
}

/** 人读报表（页宽 96）。 */
export function formatRankTable(rows) {
  const lines = [];
  lines.push('身份（渠道|战术档|思考ms）'.padEnd(40) + 'Elo'.padStart(7) + '局数'.padStart(6) + '胜'.padStart(5) + '和'.padStart(5) + '负'.padStart(5) + '得分率'.padStart(8) + (rows.some((r) => !r.enough) ? '  ⚠样本不足(<' + MIN_GAMES + ')' : ''));
  for (const r of rows) {
    const rate = ((r.w + r.d * 0.5) / r.games * 100).toFixed(1) + '%';
    lines.push(
      r.identity.padEnd(40) +
      String(r.rating).padStart(7) +
      String(r.games).padStart(6) + String(r.w).padStart(5) + String(r.d).padStart(5) + String(r.l).padStart(5) +
      rate.padStart(8) +
      (r.enough ? '' : '  ⚠'),
    );
  }
  return lines.join('\n');
}
