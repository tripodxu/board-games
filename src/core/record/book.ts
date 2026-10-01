/* record/book.ts — 战绩簿（本机历史对局）的数据契约与纯函数
 * （迁移自 js/app.js:1543-1583 的 `loadRecords` / `saveGameRecord`，与 375-391 的 `buildExperience`）
 *
 * 为什么单独一个模块：战绩簿是**离线降级路径**的唯一数据源——没有后端时（计划 §6.5）
 * 校准实验室、先手胜率、开具体验注入全靠它。旧实现把 localStorage 读写与 DOM 重绘
 * （`renderRecords()`）缠在一起，这里只保留数据层：注入 `StorageLike`，不碰 DOM。
 *
 * 键名与旧实现逐字兼容：`jev_qiguan_records_v1`（js/app.js:8），保留最近 60 条
 * （旧实现 `all.slice(-60)`）。
 */
import { calSamples, exportSideCfg, MODE_LABELS } from './export.ts';
import { aiMovesOf, resultTextOf, type GameSession, type SessionMeta } from '../session.ts';
import { duelLabel, slug } from '../view/duel.ts';
import { rand } from '../rng.ts';
import type { StorageLike } from '../persist.ts';
import type { Engine, GameStatus } from '../types.ts';

/** 旧实现的战绩簿键（js/app.js:8）。**不要改**：改了就丢用户本机战绩。 */
export const RECORDS_KEY = 'jev_qiguan_records_v1';

/** 旧实现只留最近 60 条（js/app.js:1581 的 `all.slice(-60)`）。 */
export const RECORDS_KEEP = 60;

/** 战绩簿条目（旧 `saveGameRecord()` 构造的 `rec`，js/app.js:1558-1577）。 */
export interface RecordBookEntry {
  /** 会话 id（`Date.now() + rand(1000)`；同 id 覆盖，保证「终局→悔棋→再终局」只留一条） */
  id: string;
  /** 记账时间（epoch ms） */
  t: number;
  game: string;
  gid: string;
  slug: string;
  duel: string;
  mock: boolean;
  /** 中文模式名（人机 / 机机 / 双人） */
  mode: string;
  /** 胜负串（`resultText()`：黑方 / 白方 / 和棋 / 未终局） */
  winner: string;
  firstWin: boolean | null;
  reason: string;
  /** 'human' = 人手认输（不是引擎判出的胜负，统计时该单独看） */
  endBy: string;
  /** 棋谱记法序列：开具体验（先手胜率）的数据源 */
  notas: string[];
  /** 总手数 */
  moves: number;
  /** AI 手数 */
  aiMoves: number;
  /** AI 手平均时延（无样本为 0） */
  avgLat: number;
  /** 本局累计花费（USD） */
  cost: number;
  /** 校准样本（先手方视角逐手胜率预测） */
  cal: number[];
}

/** 开具体验（旧 `buildExperience()`，js/app.js:375-391）：注入 `state.experience`。
 *  同棋种、真实渠道的历史局里，与当前局面开局前 4 手相同的那部分，统计先手胜率。
 *  样本 <2 局不给（噪声），离线演示局从不参与。 */
export interface OpeningExperience {
  opening_plies: number;
  games: number;
  first_player_win_rate: number;
}

/** 读战绩簿（旧 `loadRecords()`，js/app.js:1544-1547）。内容损坏一律回退空表。 */
export function loadRecords(storage: StorageLike): RecordBookEntry[] {
  try {
    const v = JSON.parse(storage.getItem(RECORDS_KEY) || '[]');
    return Array.isArray(v) ? v as RecordBookEntry[] : [];
  } catch (_) {
    return [];
  }
}

/** 写战绩簿（旧 `saveGameRecord()` 的落盘部分）：只留最近 `RECORDS_KEEP` 条，静默失败。 */
export function saveRecords(storage: StorageLike, list: RecordBookEntry[]): void {
  try {
    storage.setItem(RECORDS_KEY, JSON.stringify((list || []).slice(-RECORDS_KEEP)));
  } catch (_) { /* ignore */ }
}

/** 按 id 覆盖或追加（旧 `saveGameRecord()` 的 `findIndex` 去重 + 截断，js/app.js:1578-1581）。 */
export function upsertRecord(list: RecordBookEntry[], entry: RecordBookEntry): RecordBookEntry[] {
  const all = (list || []).slice();
  const idx = all.findIndex((r) => r && r.id === entry.id);
  if (idx >= 0) all[idx] = entry; else all.push(entry);
  return all.slice(-RECORDS_KEEP);
}

/** 会话 id（旧 `Date.now() + '' + BG.util.rand(1000)`，js/app.js:1549）。 */
export function newSessionId(now: number = Date.now()): string {
  return String(now) + '' + String(rand(1000));
}

/** 旧 `saveGameRecord()` 开头的记账守卫（js/app.js:1549-1550）：**会就地改 session**。
 *  「终局 → 悔棋 → 再终局」只保留一条战绩：第一次生成 id，之后复用。 */
export function ensureSessionId(session: GameSession, now: number = Date.now()): string {
  if (!session.sessionRecorded) session.sessionId = newSessionId(now);
  session.sessionRecorded = true;
  return session.sessionId as string;
}

/** 战绩簿条目（旧 `saveGameRecord()` 的构造部分，js/app.js:1548-1577）。
 *  纯函数：不写盘、不改 session（记账守卫请先调 `ensureSessionId()`）。 */
export function buildRecordEntry(
  session: GameSession,
  engine: Engine,
  g: GameStatus,
  opts?: { id?: string; t?: number } | null,
): RecordBookEntry {
  const o = opts || {};
  const t = typeof o.t === 'number' ? o.t : Date.now();
  const items = aiMovesOf(session);
  const lats = items
    .map((h) => (h.meta as SessionMeta).latencyMs)
    .filter((x): x is number => !!x);
  /* 校准样本口径与同步 payload 完全一致（calSamples），这样后端聚合出来的统计
   * 和本机战绩簿永远对得上。 */
  const cs = calSamples(session, engine, g);
  /* 人类那一侧带 human 标记：战绩簿的 slug/duel 与棋谱导出共用同一口径 */
  const bCfg = exportSideCfg(session, engine, 'black');
  const wCfg = exportSideCfg(session, engine, 'white');
  return {
    id: o.id || session.sessionId || newSessionId(t),
    t,
    game: engine.name,
    gid: session.gameId,
    slug: slug(bCfg, wCfg),
    duel: duelLabel(bCfg, wCfg),
    mock: cs.mock,
    mode: MODE_LABELS[session.mode] || session.mode,
    winner: resultTextOf(engine, g),
    firstWin: cs.firstWin,
    reason: g.reason || '',
    endBy: (typeof g.by === 'string' ? g.by : ''),
    notas: session.history.map((h) => h.move.notation),
    moves: session.history.length,
    aiMoves: items.length,
    avgLat: lats.length ? Math.round(lats.reduce((s, x) => s + x, 0) / lats.length) : 0,
    cost: items.reduce((s, h) => s + (((h.meta as SessionMeta).costUsd as number) || 0), 0),
    cal: cs.cal,
  };
}

/** 旧 `buildExperience(gid)`（js/app.js:377-391）：样本 <2 局返回 null。 */
export function buildExperience(
  gid: string,
  history: { move: { notation: string } }[],
  records: RecordBookEntry[],
): OpeningExperience | null {
  const k = Math.min(4, history.length);
  if (!k) return null;
  const prefix = history.slice(0, k).map((h) => h.move.notation);
  let n = 0, fw = 0;
  for (const r of records || []) {
    if (!r || r.gid !== gid || r.mock || !Array.isArray(r.notas)) continue;
    if (r.notas.length >= prefix.length && prefix.every((x, i) => r.notas[i] === x)) {
      n++;
      if (r.firstWin === true) fw++;
    }
  }
  if (n < 2) return null;
  return { opening_plies: prefix.length, games: n, first_player_win_rate: Math.round(fw / n * 100) / 100 };
}
