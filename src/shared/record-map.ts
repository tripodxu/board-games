/**
 * 旧记录 → D1 行 的**单一事实源**（计划 §4.2、ADR-0011）。
 *
 * 为什么独立成模块：导入脚本（`scripts/import-archive.mjs`，Node）与 Worker 运行时
 * （`POST /api/games`，workerd）必须用同一套字段解析，否则新旧数据会长出两种口径。
 * 因此这里只有纯函数——无 IO、无 D1、**无 crypto**：哈希与当前时间由调用方注入
 * （Node 用 `node:crypto`，Worker 用 `crypto.subtle`，两者不能共用同步实现）。
 *
 * 保真原则：`payload` 存原始记录副本，所有列化字段都是**派生值**；两者冲突以 payload 为准。
 *
 * 实测口径（54 份真实棋谱 + 6 轮实验，2026-10-01 统计）：
 *  - `gid` 是**棋种 id**（54/54 = `gomoku`），不是对局身份 → 新模型引入 `game_uid`；
 *  - `notation` 是逗号连接的着法串（末尾带逗号），`moves[]` 才是结构化的逐手明细；
 *  - 逐手 `ai` 只有 `{ch,mdl,conf,p,rank,cands,ms,tv}`——**没有**每手战术标记，
 *    战术分布只存在于 `meta.tactics` 直方图 → `game_moves.tactics` 导入后恒为 NULL；
 *  - `cal` 是**数字数组**（非对象），`firstWin` 是布尔（33 份有 cal，26 份有二元真值）；
 *  - `result` 只有四种串：`黑方 获胜（五连）`/`白方 获胜（五连）`/`黑方 获胜（认输）`/`和棋（棋盘已满）`。
 */

/** 单行 payload 上限（计划 §4.4）：超限 413 拒绝，实测历史最大 68.7 KB。 */
export const PAYLOAD_MAX_BYTES = 512 * 1024;

export type Side = 'black' | 'white';

/** 棋种中文名（引擎 `name`）→ 引擎 id。注意围棋/象棋的名字里带空格，查表前统一去空白。 */
const GAME_NAME_TO_ID: Record<string, string> = {
  '五子棋': 'gomoku',
  '五子棋·禁手': 'gomoku-pro',
  '围棋': 'go',
  '象棋': 'xiangqi',
  '国际象棋': 'chess',
  '西洋跳棋': 'checkers',
  '中国跳棋': 'cc',
};
const GAME_ID_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(GAME_NAME_TO_ID).map(([name, id]) => [id, name]),
);
export const GAME_IDS: readonly string[] = Object.values(GAME_NAME_TO_ID);

/** 旧棋谱的 `mode` 是中文；新客户端可能直接发英文 id（幂等透传）。 */
const MODE_TO_ID: Record<string, string> = {
  '人机': 'human-ai',
  '机机': 'ai-ai',
  '双人': 'pvp',
  'human-ai': 'human-ai',
  'ai-ai': 'ai-ai',
  'pvp': 'pvp',
};

/** 着法串里的阵营标签 → 结构化阵营。未识别的（红方 / 下方（先手）…）原样保留，见 MoveRow.side。 */
const SIDE_TO_ID: Record<string, Side> = { '黑方': 'black', '白方': 'white', 'black': 'black', 'white': 'white' };

export type MoveAiMeta = {
  ch?: string | null;
  mdl?: string | null;
  conf?: number | null;
  p?: number | null;
  rank?: number | null;
  cands?: number | null;
  ms?: number | null;
  tv?: string | number | null;
  /** 新前端补的每手保险标记（win/block/vcfAttack…）；历史棋谱没有这个字段 */
  tac?: string | null;
};

export type PayloadMove = {
  ply?: number;
  side?: string;
  notation?: string;
  ai?: MoveAiMeta | null;
};

export type GameMeta = {
  code?: string;
  topK?: number;
  seed?: string | null;
  aiMoves?: number;
  costUsd?: number;
  tokens?: number;
  latencyMs?: { avg?: number; max?: number } | number | null;
  conf?: number;
  tactics?: Record<string, number>;
  tacticsVersion?: string | number | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

/** 棋谱 payload：旧客户端（`format: jev-qiguan-game/v1`）与新客户端字段的超集。 */
export type GamePayload = {
  format?: string;
  exported?: string;
  /** 新客户端：`crypto.randomUUID()`，同一局重传恒定 */
  gameUid?: string;
  /** 展示用中文名 */
  game?: string;
  /** 新客户端：引擎 id */
  gameId?: string;
  /** 旧字段：**棋种 id**（不是对局身份） */
  gid?: string;
  mode?: string;
  channel?: string | null;
  blackChannel?: string | null;
  whiteChannel?: string | null;
  blackTactics?: string | null;
  whiteTactics?: string | null;
  blackThink?: number | null;
  whiteThink?: number | null;
  experiment?: string | null;
  expGameNo?: number | null;
  result?: string | null;
  /** 新客户端：结构化胜负 */
  winner?: Side | null;
  endReason?: string | null;
  endBy?: string | null;
  notation?: string;
  moves?: PayloadMove[];
  meta?: GameMeta | null;
  cal?: number[] | null;
  firstWin?: boolean | null;
  mock?: boolean;
  slug?: string | null;
  duel?: string | null;
  deviceId?: string | null;
  [key: string]: unknown;
};

/** `games` 表的插入行（列名与 `migrations/0001_init.sql` 逐字一致）。 */
export type GameRow = {
  game_uid: string;
  dedup_key: string;
  created_at: string;
  day: string;
  game: string;
  game_id: string;
  mode: string | null;
  result: string | null;
  winner: Side | null;
  end_reason: string | null;
  end_by: string | null;
  move_count: number;
  notation: string;
  opening_prefix: string | null;
  slug: string | null;
  duel: string | null;
  black_channel: string | null;
  white_channel: string | null;
  black_tactics: string | null;
  white_tactics: string | null;
  black_think: number | null;
  white_think: number | null;
  experiment_tag: string | null;
  exp_game_no: number | null;
  code_version: string | null;
  tactics_version: string | null;
  top_k: number | null;
  seed: string | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_avg_ms: number | null;
  latency_max_ms: number | null;
  avg_conf: number | null;
  tactics_hist: string | null;
  mock: number;
  first_win: number | null;
  cal_json: string | null;
  device_id: string | null;
  source: string;
  payload: string;
  payload_bytes: number;
};

/** `game_moves` 表的一行。 */
export type MoveRow = {
  ply: number;
  /** 通常 black|white；非黑即白的棋种（象棋红方、跳棋上下方）保留原始标签 */
  side: string;
  notation: string;
  tactics: string | null;
  tactics_version: string | null;
  channel: string | null;
  model: string | null;
  confidence: number | null;
  prob: number | null;
  rank: number | null;
  ms: number | null;
  cands: number | null;
};

/** `experiments` 表的 upsert 行。 */
export type ExperimentRow = {
  tag: string;
  date: string;
  chan_a: string | null;
  chan_b: string | null;
  tac_a: string | null;
  tac_b: string | null;
  think_a: number | null;
  think_b: number | null;
  total: number | null;
  note: string | null;
  games_json: string;
  device_id: string | null;
};

export type ExperimentPayload = {
  tag: string;
  date?: string;
  chanA?: string | null;
  chanB?: string | null;
  tacA?: string | null;
  tacB?: string | null;
  thinkA?: number | null;
  thinkB?: number | null;
  total?: number | null;
  note?: string | null;
  games?: unknown[];
  deviceId?: string | null;
  [key: string]: unknown;
};

export type MappedGame = { row: GameRow; moves: MoveRow[]; warnings: string[] };

/** 中文名（或已归一化 id）→ 引擎 id；未知返回 `unknown`（计划 §4.2 的缺省处理）。 */
export function gameNameToId(name: string | null | undefined): string {
  if (typeof name !== 'string' || !name) return 'unknown';
  const key = name.replace(/\s+/g, '');
  return GAME_NAME_TO_ID[key] ?? (GAME_IDS.includes(name) ? name : 'unknown');
}

/** 引擎 id → 展示用中文名（无空格版本，避免 `围 棋` 这类排版空格进入数据）。 */
export function gameIdToName(id: string): string {
  return GAME_ID_TO_NAME[id] ?? id;
}

export function parseMode(mode: string | null | undefined): string | null {
  if (typeof mode !== 'string' || !mode) return null;
  return MODE_TO_ID[mode] ?? null;
}

/**
 * 解析中文结果串 → `{winner, endReason}`；解析失败返回两个 null（调用方记 warning，
 * 由导入脚本汇总成「待人工核对」清单）。
 */
export function parseResult(result: string | null | undefined): { winner: Side | null; endReason: string | null } {
  if (typeof result !== 'string' || !result) return { winner: null, endReason: null };
  const win = /^(黑方|白方)\s*获胜(?:（(.+?)）)?\s*$/.exec(result);
  if (win) return { winner: win[1] === '黑方' ? 'black' : 'white', endReason: win[2] ?? null };
  const draw = /^和棋(?:（(.+?)）)?\s*$/.exec(result);
  if (draw) return { winner: null, endReason: draw[1] ?? null };
  return { winner: null, endReason: null };
}

/** UTF-8 字节数。用 `TextEncoder`（workerd / Node / 浏览器三端都有），不依赖 Buffer。 */
export function measureBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 旧客户端没有 `gameUid`：服务端合成 `sha1(exported|notation).slice(0,16)`（计划 §4.2）。
 * 这里只给出**待哈希的原文**，实际哈希由调用方完成（Node/Worker 实现不同）。
 */
export function gameUidSource(payload: GamePayload): string {
  return `${str(payload.exported)}|${str(payload.notation)}`;
}

/** 去重键原文：`sha1(exported|gameUid|notation)`（计划 §5.4）。 */
export function dedupSource(payload: GamePayload, gameUid: string): string {
  return `${str(payload.exported)}|${gameUid}|${str(payload.notation)}`;
}

/** 保真副本的文本：导入时传原始文件内容，运行时不传则按 JSON 序列化。 */
function payloadText(payload: GamePayload, raw?: string): string {
  return typeof raw === 'string' ? raw : JSON.stringify(payload);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function boolToInt(v: unknown): number | null {
  return v === true ? 1 : v === false ? 0 : null;
}

/** `exported` → UTC 日；解析不出来时回落到调用方给的目录日期（导入时 = games/<日>/）。 */
function dayOf(createdAt: string, fallbackDay?: string | null): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(createdAt);
  if (m && !Number.isNaN(Date.parse(createdAt))) return m[1];
  return fallbackDay ?? '';
}

export type MapGameOptions = {
  /** 原始文件内容（导入时传，保证 payload 逐字节保真） */
  rawPayload?: string;
  /** 目录日期兜底（导入时 = `games/<day>/`） */
  fallbackDay?: string | null;
  /** `import` | `worker` */
  source?: string;
  /** 归属设备（历史导入为 null） */
  deviceId?: string | null;
};

/**
 * 棋谱 → `games` 行 + `game_moves` 行。
 *
 * 调用方必须先算好 `gameUid` 与 `dedupKey`（哈希是平台相关的异步 API）；
 * `payload` 里已带 `gameUid` 时可以直接用，老记录用 `sha1(gameUidSource)`。
 */
export function mapGameRecord(
  payload: GamePayload,
  ids: { gameUid: string; dedupKey: string },
  opts: MapGameOptions = {},
): MappedGame {
  const warnings: string[] = [];
  const moves = Array.isArray(payload.moves) ? payload.moves.filter((m) => m && typeof m.notation === 'string') : [];
  if (!moves.length) warnings.push('moves 为空：无法生成逐手明细');

  const text = payloadText(payload, opts.rawPayload);
  const bytes = measureBytes(text);
  if (bytes > PAYLOAD_MAX_BYTES) warnings.push(`payload ${bytes} B 超过上限 ${PAYLOAD_MAX_BYTES} B`);

  const parsed = parseResult(payload.result);
  if (payload.result && !parsed.winner && !parsed.endReason) warnings.push(`result 无法解析：${payload.result}`);
  const explicitWinner = payload.winner === 'black' || payload.winner === 'white' ? payload.winner : null;

  const mode = parseMode(payload.mode);
  if (payload.mode && !mode) warnings.push(`未知 mode：${payload.mode}`);

  const gameId = strOrNull(payload.gameId) ?? strOrNull(payload.gid) ?? gameNameToId(payload.game);
  if (gameId === 'unknown') warnings.push(`未知棋种：game=${str(payload.game)} gid=${str(payload.gid)}`);

  const createdAt = str(payload.exported);
  const meta = payload.meta ?? null;
  const lat = meta && typeof meta.latencyMs === 'object' && meta.latencyMs ? meta.latencyMs : null;
  const latNum = meta ? num(meta.latencyMs) : null;
  const notation = strOrNull(payload.notation) ?? moves.map((m) => m.notation).join(',');

  const row: GameRow = {
    game_uid: ids.gameUid,
    dedup_key: ids.dedupKey,
    created_at: createdAt,
    day: dayOf(createdAt, opts.fallbackDay),
    game: strOrNull(payload.game) ?? gameIdToName(gameId),
    game_id: gameId,
    mode,
    result: strOrNull(payload.result),
    winner: explicitWinner ?? parsed.winner,
    end_reason: strOrNull(payload.endReason) ?? parsed.endReason,
    end_by: strOrNull(payload.endBy),
    move_count: moves.length,
    notation,
    opening_prefix: moves.length ? moves.slice(0, 4).map((m) => m.notation).join(',') : null,
    slug: strOrNull(payload.slug),
    duel: strOrNull(payload.duel),
    black_channel: strOrNull(payload.blackChannel) ?? strOrNull(payload.channel),
    white_channel: strOrNull(payload.whiteChannel) ?? strOrNull(payload.channel),
    black_tactics: strOrNull(payload.blackTactics),
    white_tactics: strOrNull(payload.whiteTactics),
    black_think: num(payload.blackThink),
    white_think: num(payload.whiteThink),
    experiment_tag: strOrNull(payload.experiment),
    exp_game_no: num(payload.expGameNo),
    code_version: meta ? strOrNull(meta.code) : null,
    tactics_version: meta && meta.tacticsVersion != null ? String(meta.tacticsVersion) : null,
    top_k: meta ? num(meta.topK) : null,
    seed: meta ? strOrNull(meta.seed) : null,
    cost_usd: meta ? num(meta.costUsd) : null,
    tokens_in: meta ? num(meta.usage?.input_tokens) ?? num(meta.tokens) : null,
    tokens_out: meta ? num(meta.usage?.output_tokens) : null,
    latency_avg_ms: lat ? num(lat.avg) : latNum,
    latency_max_ms: lat ? num(lat.max) : null,
    avg_conf: meta ? num(meta.conf) : null,
    tactics_hist: meta && meta.tactics ? JSON.stringify(meta.tactics) : null,
    mock: payload.mock === true ? 1 : 0,
    first_win: boolToInt(payload.firstWin),
    cal_json: Array.isArray(payload.cal) ? JSON.stringify(payload.cal) : null,
    device_id: opts.deviceId ?? strOrNull(payload.deviceId),
    source: opts.source ?? 'worker',
    payload: text,
    payload_bytes: bytes,
  };

  const moveRows: MoveRow[] = moves.map((m, i) => {
    const ai = m.ai ?? null;
    const rawSide = str(m.side);
    return {
      ply: num(m.ply) ?? i + 1,
      side: SIDE_TO_ID[rawSide] ?? (rawSide || (i % 2 === 0 ? 'black' : 'white')),
      notation: m.notation as string,
      /* 每手战术标记历史上没进棋谱（只在 meta.tactics 直方图里）；新前端写在 ai.tac
       * （叶级兜底也认 move.tac），因此导入行为 NULL 属正常，不是丢数据。 */
      tactics: strOrNull(ai?.tac) ?? strOrNull((m as { tac?: unknown }).tac),
      tactics_version: ai && ai.tv != null ? String(ai.tv) : null,
      channel: ai ? strOrNull(ai.ch) : null,
      model: ai ? strOrNull(ai.mdl) : null,
      confidence: ai ? num(ai.conf) : null,
      prob: ai ? num(ai.p) : null,
      rank: ai ? num(ai.rank) : null,
      ms: ai ? num(ai.ms) : null,
      cands: ai ? num(ai.cands) : null,
    };
  });

  return { row, moves: moveRows, warnings };
}

/**
 * 实验轮 → `experiments` upsert 行（按 `tag` 幂等）。
 * `tac_a`/`tac_b`/`think_a`/`think_b` 必须原样保留：同渠道 A/B 的唯一可分辨依据
 * （历史踩坑：丢了这四项，报告分不清哪一轮是哪一档）。
 */
export function mapExperimentRecord(entry: ExperimentPayload, opts: { deviceId?: string | null; now?: string } = {}): ExperimentRow {
  const games = Array.isArray(entry.games) ? entry.games : [];
  const total = num(entry.total);
  return {
    tag: entry.tag,
    date: strOrNull(entry.date) ?? opts.now ?? '',
    chan_a: strOrNull(entry.chanA),
    chan_b: strOrNull(entry.chanB),
    tac_a: strOrNull(entry.tacA),
    tac_b: strOrNull(entry.tacB),
    think_a: num(entry.thinkA),
    think_b: num(entry.thinkB),
    total: total ?? games.length,
    note: strOrNull(entry.note),
    games_json: JSON.stringify(games),
    device_id: opts.deviceId ?? strOrNull(entry.deviceId),
  };
}
