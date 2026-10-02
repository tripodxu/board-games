/**
 * 请求体 → 数据层输入（P3 的适配层）。
 *
 * 分工：
 * - `shared/record-map.ts` 负责**旧记录字段的全部解析口径**（棋种名↔id、模式、result 解析、
 *   逐手 ai 字段、meta 展开、cal、day 回落…），并且已在 54 份真实棋谱上跑过；
 * - `db/games.ts` 负责**落库派生**（day/opening_prefix/payload_bytes/move_count）；
 * - 本文件只做「envelope 差异」的搬运：`GamePayload` → `GameInput`。
 *
 * 为什么不直接在路由里拼 `GameInput`：那份口径必须与 `scripts/import-archive.mjs` 完全一致
 * （同一个 payload 无论走导入还是走 `/api/games` 都必须得到同一个 game_uid/dedup_key/day），
 * 任何一份重复实现都会在「重传归档棋谱」时悄悄产生第二行。
 *
 * 已知偏差（有意）：路由写入的 `payload` 传的是**解析后的对象**，由 `insertGame` 重新
 * `JSON.stringify`，所以字节与原请求体不必然相同（字段顺序/空白会被归一）；导入脚本走
 * `rawPayload` 才保留逐字节原文。`row.payload_bytes` 随之按归一后的文本计算。
 */
import {
  dedupSource,
  gameUidSource,
  mapExperimentRecord,
  mapGameRecord,
  type ExperimentPayload,
  type GamePayload,
  type GameRow as MappedGameRow,
  type MoveRow,
} from '../../shared/record-map.ts';
import type { ExperimentInput, GameInput, GameMoveInput } from '../db/index.ts';
import { sha1Hex, synthGameUid } from './hash.ts';

export interface GameInputBundle {
  input: GameInput;
  warnings: string[];
  gameUid: string;
  dedupKey: string;
}

/** 逐手行 → 数据层输入（列名一一对应，只有列名风格不同）。 */
export function moveRowToInput(move: MoveRow): GameMoveInput {
  return {
    notation: move.notation,
    side: move.side,
    tactics: move.tactics,
    tacticsVersion: move.tactics_version,
    channel: move.channel,
    model: move.model,
    confidence: move.confidence,
    prob: move.prob,
    rank: move.rank,
    ms: move.ms,
    tacMs: move.tac_ms,
    cands: move.cands,
  };
}

/**
 * 对局 payload → `GameInput`。
 *
 * `gameUid` 解析顺序：payload.gameUid → 服务端合成的 `sha1(exported|notation)[:16]`；
 * `dedupKey` 一律走 `shared/record-map.ts` 的 `dedupSource`（= `exported|gameUid|notation`），
 * 与导入脚本同一个函数，所以「归档棋谱被客户端重传」会命中已有行而不是新增一局。
 */
export async function toGameInput(
  payload: GamePayload,
  opts: { deviceId?: string | null; source?: string; fallbackDay?: string | null } = {},
): Promise<GameInputBundle> {
  const providedUid = typeof payload.gameUid === 'string' ? payload.gameUid.trim() : '';
  const gameUid = providedUid || (await synthGameUid(gameUidSource(payload)));
  const dedupKey = await sha1Hex(dedupSource(payload, gameUid));

  const { row, moves, warnings } = mapGameRecord(
    payload,
    { gameUid, dedupKey },
    {
      fallbackDay: opts.fallbackDay ?? null,
      source: opts.source ?? 'worker',
      deviceId: opts.deviceId ?? null,
    },
  );

  return {
    input: {
      ...gameRowToInput(row),
      payload,
      moves: moves.map(moveRowToInput),
    },
    warnings,
    gameUid,
    dedupKey,
  };
}

/** 映射行的 snake_case → 数据层的 camelCase（显式列出，避免泛型 camelize 把新列悄悄漏掉）。 */
function gameRowToInput(row: MappedGameRow): Omit<GameInput, 'payload' | 'moves'> {
  return {
    gameUid: row.game_uid,
    dedupKey: row.dedup_key,
    createdAt: row.created_at,
    game: row.game,
    gameId: row.game_id,
    notation: row.notation,
    mode: row.mode,
    result: row.result,
    winner: row.winner,
    endReason: row.end_reason,
    endBy: row.end_by,
    slug: row.slug,
    duel: row.duel,
    blackChannel: row.black_channel,
    whiteChannel: row.white_channel,
    blackTactics: row.black_tactics,
    whiteTactics: row.white_tactics,
    blackThink: row.black_think,
    whiteThink: row.white_think,
    experimentTag: row.experiment_tag,
    expGameNo: row.exp_game_no,
    codeVersion: row.code_version,
    tacticsVersion: row.tactics_version,
    topK: row.top_k,
    seed: row.seed,
    costUsd: row.cost_usd,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    latencyAvgMs: row.latency_avg_ms,
    latencyMaxMs: row.latency_max_ms,
    tacAvgMs: row.tac_avg_ms,
    tacMaxMs: row.tac_max_ms,
    avgConf: row.avg_conf,
    tacticsHist: row.tactics_hist,
    mock: row.mock !== 0,
    firstWin: row.first_win === null ? null : row.first_win !== 0,
    cal: parseCalJson(row.cal_json),
    deviceId: row.device_id,
    source: row.source,
  };
}

/** `cal_json` 是映射层给的字符串；坏 JSON 视为没有校准数据（stats 侧同样会过滤掉）。 */
function parseCalJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 实验轮次 payload → `ExperimentInput`（db 层负责 `games` 的 JSON 序列化）。 */
export function toExperimentInput(
  payload: ExperimentPayload,
  opts: { deviceId?: string | null; now?: string } = {},
): ExperimentInput {
  const row = mapExperimentRecord(payload, { deviceId: opts.deviceId ?? null, now: opts.now });
  return {
    tag: row.tag,
    date: row.date,
    chanA: row.chan_a,
    chanB: row.chan_b,
    tacA: row.tac_a,
    tacB: row.tac_b,
    thinkA: row.think_a,
    thinkB: row.think_b,
    total: row.total,
    note: row.note,
    games: parseGamesJson(row.games_json),
    deviceId: row.device_id,
  };
}

function parseGamesJson(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
