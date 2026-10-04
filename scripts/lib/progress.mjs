/**
 * scripts/lib/progress.mjs — 远端跑动的进度文件（D13，纯函数 + 两份文件的原子读写）
 *
 * 为什么不用服务：box 只有 1.3 GiB 内存，不适合再挂常驻进程；而业主明确要求
 * 「可以通过 ssh 来检验进度」。文件是唯一**不占端口、断线仍可读、kill -9 不留半截**的方案。
 *
 * 两份产物（都在 `<outDir>/`）：
 *   progress.json  最新一次快照（**原子**：先写 `.tmp` 再 rename）⇒ `ssh <host> cat …` 随时可读
 *   events.jsonl   只追加的事件流（每局开始/结束、每次重试、每条告警）⇒ `tail -f` 看流水
 *
 * 口径纪律：
 *   - W/D/L 是**相对 A 臂**的（A 在奇数局执黑，见 batch-common.sidesForGameSpec）；
 *     和棋不计进 W/L，单列 d —— 与项目「不唯胜率」的规则 11 一致。
 *   - `etaS` 只用**真跑完成**的局做样本（跳过 `skipped`/`error`：前者耗时是 0，后者是异常值），
 *     取最近 `ETA_SAMPLES` 局的平均值 × 剩余局数；样本不足时给 `null`，不编数字。
 *   - `done` 含 `ok`/`ok-dry`/`skipped`（断点续跑时 skipped 的局也是「已处理」）；
 *     它和 `wdl` 的分母不同，读数时别混。
 *
 * 本文件是纯逻辑 + fs，**不 import 任何 src/core**（worker 与 CLI 共用，测试直接调纯函数）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** ETA 用最近多少局的耗时做样本。 */
export const ETA_SAMPLES = 5;

/** 已被处理（不会再跑）的局状态。 */
export const SETTLED = ['ok', 'ok-dry', 'skipped'];

export function progressPath(dir) { return path.join(dir, 'progress.json'); }
export function eventsPath(dir) { return path.join(dir, 'events.jsonl'); }

/** 新建一份跑动状态（worker 起跑时建，之后每局 patch）。纯函数。 */
export function newState({ batchId, round, tag, total, startedAtMs }) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`total 必须是 ≥1 的整数：${total}`);
  return {
    batchId: String(batchId ?? ''),
    round: Number(round),
    tag: String(tag ?? ''),
    total,
    startedAtMs: Number(startedAtMs) || Date.now(),
    games: [],
  };
}

/**
 * 记一局的结果进状态（纯函数，返回新对象，不改入参）。
 * `entry`：`{ gameNo, status, durationMs, winner, gameUid, plies, aBlack, error }`。
 * `skipped` 的局没有耗时（不算 ETA 样本）；`error` 记进 events 但不计入 wdl。
 */
export function recordGame(state, entry) {
  const games = state.games.filter((g) => g.gameNo !== entry.gameNo);
  games.push({
    gameNo: entry.gameNo,
    status: entry.status,
    durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : null,
    winner: entry.winner ?? null,
    gameUid: entry.gameUid ?? null,
    plies: Number.isFinite(entry.plies) ? entry.plies : null,
    aBlack: Boolean(entry.aBlack),
    error: entry.error ? String(entry.error) : null,
  });
  games.sort((a, b) => a.gameNo - b.gameNo);
  return { ...state, games };
}

/**
 * 一局相对 A 臂的胜负：`w` 胜 / `d` 和 / `l` 负；**没有结果信息给 null**。
 * 口径：`error` 一定没结果；`skipped`（断点续跑时上轮已归档的局）只有在 checkpoint 里
 * 带回了 `winner` 时才算，否则不进 wdl —— 把「没跑」当成「和棋」是最容易骗到自己的错法。
 */
export function outcomeForA(g) {
  if (g.status === 'error') return null;
  if (g.winner == null) return g.status === 'skipped' ? null : 'd';
  const aSide = g.aBlack ? 'black' : 'white';
  return g.winner === aSide ? 'w' : 'l';
}

/**
 * 快照（纯函数）：把状态压成 `progress.json` 的形状。
 * `current` 可选 `{ gameNo, ply }`，让长时间的对局中也能看出「跑到第几手」。
 */
export function snapshot(state, { nowMs = Date.now(), current = null } = {}) {
  const settled = state.games.filter((g) => SETTLED.includes(g.status));
  const wdl = { w: 0, d: 0, l: 0 };
  for (const g of state.games) {
    const o = outcomeForA(g);
    if (o) wdl[o] += 1;
  }
  const durations = state.games
    .filter((g) => g.status === 'ok' || g.status === 'ok-dry')
    .map((g) => g.durationMs)
    .filter((d) => Number.isFinite(d) && d > 0)
    .slice(-ETA_SAMPLES);
  const remaining = Math.max(0, state.total - settled.length);
  const meanMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const last = state.games.length ? state.games[state.games.length - 1] : null;
  return {
    batchId: state.batchId,
    round: state.round,
    tag: state.tag,
    total: state.total,
    done: settled.length,
    gameNo: current?.gameNo ?? last?.gameNo ?? null,
    ply: current?.ply ?? null,
    wdl,
    elapsedS: Math.max(0, Math.round((nowMs - state.startedAtMs) / 1000)),
    /* 样本不足 ⇒ null（宁可不给，也不编一个假 ETA）；四舍五入到秒。 */
    etaS: meanMs == null || remaining === 0 ? (remaining === 0 ? 0 : null) : Math.round((meanMs * remaining) / 1000),
    meanGameS: meanMs == null ? null : Math.round(meanMs / 1000),
    lastGameUid: last?.gameUid ?? null,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/* ---------- IO（原子写 / 追加） ---------- */

export function readProgress(dir) {
  const file = progressPath(dir);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 原子写 progress.json：`kill -9` 只可能留下 `.tmp`，读侧永远看到完整 JSON。 */
export function writeProgress(dir, snap) {
  fs.mkdirSync(dir, { recursive: true });
  const file = progressPath(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

/** 追加一条事件（JSONL）。失败只告警不抛：进度是辅助产物，不该拖垮跑动。 */
export function appendEvent(dir, event) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventsPath(dir), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
    return true;
  } catch (err) {
    process.stderr.write(`events.jsonl 写入失败（不影响跑动）：${err && err.message || err}\n`);
    return false;
  }
}

/** 一行进度摘要（CLI/日志共用，形状固定方便 grep）。 */
export function formatProgress(snap) {
  if (!snap) return '(无 progress.json)';
  const eta = snap.etaS == null ? '?' : `${snap.etaS}s`;
  const ply = snap.ply == null ? '' : ` ply=${snap.ply}`;
  return `r${snap.round} ${snap.done}/${snap.total} W${snap.wdl.w}-D${snap.wdl.d}-L${snap.wdl.l}` +
    ` game=${snap.gameNo ?? '-'}${ply} 已跑 ${snap.elapsedS}s ETA ${eta}`;
}
