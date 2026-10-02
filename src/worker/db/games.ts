/**
 * 对局数据访问（games / game_moves）。
 *
 * 为什么派生列在这里算：migrations/0001_init.sql 头注把 payload 定为「保真副本」、
 * 列化字段定为「派生」，落库就是唯一的派生点——`day` / `opening_prefix` /
 * `payload_bytes` / `move_count` / `dedup_key` 只在这里推导一次，导入脚本与
 * `/api/games` 路由都不重复实现，否则两边迟早漂移。
 *
 * 输入是「已归一好的行字段」（camelCase，与同名 snake_case 列一一对应）：旧棋谱 JSON 的
 * 字段解析属于 `src/shared/record-map.ts`（P4）。唯一的例外是 `side`——DDL 注释把
 * 「中文名落库时归一」的责任明确放在落库侧，所以这里容忍 `黑方`/`白方`（见 normalizeSide）。
 *
 * 前置条件（外键）：`games.device_id REFERENCES devices(device_id)`，而 D1 默认强制外键，
 * 所以带 `deviceId` 写入前必须已有该 devices 行——调用方（`/api/games` 路由）要先
 * `touchDevice`，否则会拿到 SQLITE_CONSTRAINT_FOREIGNKEY 而不是一次正常写入。
 * 本层不替调用方偷偷补一条设备行：device 的 first_seen 属于设备流程，不该被对局写入顺手编造。
 */

/** 单行 payload 上限（migrations/0001_init.sql 头注：512 KB 由应用层把关，不是 D1 的限制）。 */
export const MAX_PAYLOAD_BYTES = 512 * 1024;

/** 列表默认页大小；上限 100 是 ADR-0011 的「所有查询必须带 LIMIT」的具体取值。 */
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/** 一次 batch 里最多塞多少条逐手 INSERT（§4.4：手数多时分块，避免单条 batch 过长）。 */
const MOVES_PER_BATCH = 500;

/** 逐手明细的输入形状，字段与 game_moves 列一一对应。 */
export interface GameMoveInput {
  notation: string;
  /** 归一值 `black` / `white`；也接受旧记录里的 `黑方` / `白方`。 */
  side?: string | null;
  tactics?: string | null;
  tacticsVersion?: string | null;
  channel?: string | null;
  model?: string | null;
  confidence?: number | null;
  prob?: number | null;
  rank?: number | null;
  ms?: number | null;
  /** 战术层耗时（ms）；Rapfi/mock 不过战术层 ⇒ null（`0002_tactics_timing.sql`） */
  tacMs?: number | null;
  cands?: number | null;
}

/** 落库输入：column-aligned，未给出的可空列一律写 NULL。 */
export interface GameInput {
  gameUid: string;
  /** 导出时间（UTC ISO8601）；`day` 由它推导。 */
  createdAt: string;
  /** 棋种中文名，如「五子棋」。 */
  game: string;
  /** 棋种引擎 id，如 `gomoku`。 */
  gameId: string;
  /** 全部着法的逗号连接串（与导出记录的 notation 字段同构）。 */
  notation: string;
  /** 保真副本，这里负责 JSON 序列化（含 UTF-8 字节数计算）。 */
  payload: unknown;
  moves: readonly GameMoveInput[];
  /** 省略时按 `sha1(createdAt|gameUid|notation)` 生成，见 §5.4。 */
  dedupKey?: string;
  mode?: string | null;
  result?: string | null;
  winner?: string | null;
  endReason?: string | null;
  endBy?: string | null;
  slug?: string | null;
  duel?: string | null;
  blackChannel?: string | null;
  whiteChannel?: string | null;
  blackTactics?: string | null;
  whiteTactics?: string | null;
  blackThink?: number | null;
  whiteThink?: number | null;
  experimentTag?: string | null;
  expGameNo?: number | null;
  codeVersion?: string | null;
  tacticsVersion?: string | null;
  topK?: number | null;
  seed?: string | null;
  costUsd?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyAvgMs?: number | null;
  latencyMaxMs?: number | null;
  /** 战术层耗时汇总（只统计真过了战术层的手），见 `0002_tactics_timing.sql` */
  tacAvgMs?: number | null;
  tacMaxMs?: number | null;
  avgConf?: number | null;
  tacticsHist?: string | null;
  /** SQLite 没有布尔类型，落库时转 0/1。 */
  mock?: boolean;
  /** 先手是否获胜；和棋 / 换边中断为 null（校准样本靠它筛，见 stats.ts）。 */
  firstWin?: boolean | null;
  /** 逐手校准概率数组；非数组值也照存，由 stats 的 SQL 侧过滤。 */
  cal?: unknown;
  deviceId?: string | null;
  /** `worker`（默认）或 `import`。 */
  source?: string;
}

/** games 行（SQL 别名后的形状）：mock / firstWin 是 SQLite 的 0/1，领域对象里再转布尔。 */
export interface GameRow {
  id: number;
  gameUid: string;
  createdAt: string;
  day: string;
  game: string;
  gameId: string;
  mode: string | null;
  result: string | null;
  winner: string | null;
  endReason: string | null;
  endBy: string | null;
  moveCount: number;
  notation: string;
  openingPrefix: string | null;
  slug: string | null;
  duel: string | null;
  blackChannel: string | null;
  whiteChannel: string | null;
  blackTactics: string | null;
  whiteTactics: string | null;
  blackThink: number | null;
  whiteThink: number | null;
  experimentTag: string | null;
  expGameNo: number | null;
  codeVersion: string | null;
  tacticsVersion: string | null;
  topK: number | null;
  seed: string | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
  tacAvgMs: number | null;
  tacMaxMs: number | null;
  avgConf: number | null;
  tacticsHist: string | null;
  mock: number;
  firstWin: number | null;
  deviceId: string | null;
  source: string;
  payloadBytes: number;
  rowAt: string;
}

/** 领域对象：列表/详情共用的部分（不含 payload）。 */
export type Game = Omit<GameRow, 'mock' | 'firstWin'> & {
  mock: boolean;
  firstWin: boolean | null;
};

/** 详情：在摘要之上带回落库的 payload 原文（JSON 字符串），由调用方决定是否解析。 */
export type GameDetail = Game & { payload: string };

/** 详情 + 逐手明细（getGame 的返回形状）。 */
export type GameWithMoves = GameDetail & { moves: GameMove[] };

/** 逐手明细（game_moves 列直出，无布尔列故不需要二次转换）。 */
export interface GameMove {
  ply: number;
  side: string;
  notation: string;
  tactics: string | null;
  tacticsVersion: string | null;
  channel: string | null;
  model: string | null;
  confidence: number | null;
  prob: number | null;
  rank: number | null;
  ms: number | null;
  tacMs: number | null;
  cands: number | null;
}

/** 列表过滤条件：全部可选，给出即按 AND 叠加。 */
export interface ListGamesFilter {
  day?: string;
  /** 起始日期（含）：`day >= ?`。旧实现把「最近 7 天」硬编码在列表里，这里换成显式区间。 */
  sinceDay?: string;
  gameId?: string;
  deviceId?: string;
  experimentTag?: string;
  /** 上一页返回的 nextCursor（即上一页最后一行的 id）。 */
  cursor?: number;
  limit?: number;
}

/** 列表页：nextCursor 为 null 表示没有下一页。 */
export interface GamePage {
  games: Game[];
  nextCursor: number | null;
}

/** 幂等写入结果：dedup 为 true 表示命中既有行（未覆盖任何列）。 */
export interface InsertGameResult {
  game: Game;
  dedup: boolean;
  /** 本次真正写入的逐手行数：命中既有行且明细完整时为 0。 */
  movesWritten: number;
}

/**
 * games → 领域对象的列清单：列表与详情共用一份，避免两处 SELECT 漂移。
 * 刻意不含 `payload`（列表一次拉 100 行 payload 会白烧行读取配额，§4.4）
 * 与 `cal_json`（只有 stats 的校准样本需要，payload 里已有保真副本）。
 */
const GAME_COLUMNS = `id, game_uid AS gameUid, created_at AS createdAt, day, game, game_id AS gameId,
  mode, result, winner, end_reason AS endReason, end_by AS endBy, move_count AS moveCount,
  notation, opening_prefix AS openingPrefix, slug, duel,
  black_channel AS blackChannel, white_channel AS whiteChannel,
  black_tactics AS blackTactics, white_tactics AS whiteTactics,
  black_think AS blackThink, white_think AS whiteThink,
  experiment_tag AS experimentTag, exp_game_no AS expGameNo,
  code_version AS codeVersion, tactics_version AS tacticsVersion, top_k AS topK, seed,
  cost_usd AS costUsd, tokens_in AS tokensIn, tokens_out AS tokensOut,
  latency_avg_ms AS latencyAvgMs, latency_max_ms AS latencyMaxMs,
  tac_avg_ms AS tacAvgMs, tac_max_ms AS tacMaxMs, avg_conf AS avgConf,
  tactics_hist AS tacticsHist, mock, first_win AS firstWin,
  device_id AS deviceId, source, payload_bytes AS payloadBytes, row_at AS rowAt`;

const GAME_MOVE_COLUMNS = `ply, side, notation, tactics, tactics_version AS tacticsVersion,
  channel, model, confidence, prob, rank, ms, tac_ms AS tacMs, cands`;

const GAME_MOVE_INSERT = `INSERT INTO game_moves
  (game_id, ply, side, notation, tactics, tactics_version, channel, model, confidence, prob, rank, ms, cands, tac_ms)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`;

const GAME_INSERT = `INSERT INTO games
  (game_uid, dedup_key, created_at, day, game, game_id, mode, result, winner, end_reason, end_by,
   move_count, notation, opening_prefix, slug, duel, black_channel, white_channel,
   black_tactics, white_tactics, black_think, white_think, experiment_tag, exp_game_no,
   code_version, tactics_version, top_k, seed, cost_usd, tokens_in, tokens_out,
   latency_avg_ms, latency_max_ms, avg_conf, tactics_hist, mock, first_win, cal_json,
   device_id, source, payload, payload_bytes,
   -- 0002 追加列：ALTER TABLE 只能把列加在末尾，SQL 里也就放末尾，两边顺序好对照
   tac_avg_ms, tac_max_ms)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
   ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
   ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38,
   ?39, ?40, ?41, ?42, ?43, ?44)
  ON CONFLICT DO NOTHING
  RETURNING id`;

/** 行 → 领域对象：只有 SQLite 的 0/1/NULL 需要在这里翻译。 */
function toGame(row: GameRow): Game {
  return {
    ...row,
    mock: row.mock !== 0,
    firstWin: row.firstWin === null ? null : row.firstWin !== 0,
  };
}

/**
 * 解析详情里的 payload 原文。损坏的 payload 说明该行不是本层写进去的，
 * 属于数据事故，直接抛出比返回 undefined 更容易被发现。
 */
export function parseGamePayload(game: GameDetail): unknown {
  return JSON.parse(game.payload) as unknown;
}

/** DDL 注释要求中文方名落库前归一；两种写法都接受，认不出的原样保留以便暴露脏数据。 */
function normalizeSide(side: string | null | undefined): string {
  if (side === '黑方') return 'black';
  if (side === '白方') return 'white';
  return side ?? 'black';
}

/** 导出时间 → UTC 日期。用 Date.parse 而不是字符串截取，避免把带时区偏移的写法算错一天。 */
function utcDay(createdAt: string): string {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`createdAt 不是可解析的时间：${String(createdAt)}`);
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/** 前 4 手逗号连接（与导出记录的 notation 字段同分隔符，便于和前端 records 对齐）。 */
function openingPrefix(moves: readonly GameMoveInput[]): string | null {
  if (!moves.length) return null;
  return moves.slice(0, 4).map((m) => m.notation).join(',');
}

/** §5.4：旧客户端不带 gameUid 时服务端合成 sha1(exported|notation)，这里只是加上 uid 维度。 */
async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIST_LIMIT);
}

/** 单条逐手 INSERT；D1 的 PreparedStatement 只能由 Database 创建，所以 db 逐个透传。 */
function moveStatement(db: D1Database, gameId: number, ply: number, move: GameMoveInput): D1PreparedStatement {
  return db
    .prepare(GAME_MOVE_INSERT)
    .bind(
      gameId,
      ply,
      normalizeSide(move.side),
      move.notation,
      move.tactics ?? null,
      move.tacticsVersion ?? null,
      move.channel ?? null,
      move.model ?? null,
      move.confidence ?? null,
      move.prob ?? null,
      move.rank ?? null,
      move.ms ?? null,
      move.cands ?? null,
      move.tacMs ?? null,
    );
}

/** 分块写逐手明细，返回真正写入的行数。 */
async function writeMoves(
  db: D1Database,
  gameId: number,
  moves: readonly GameMoveInput[],
): Promise<number> {
  let written = 0;
  for (let start = 0; start < moves.length; start += MOVES_PER_BATCH) {
    const chunk = moves.slice(start, start + MOVES_PER_BATCH);
    const statements = chunk.map((move, offset) =>
      moveStatement(db, gameId, start + offset + 1, move),
    );
    await db.batch(statements);
    written += statements.length;
  }
  return written;
}

/**
 * 幂等写入一局。
 *
 * `ON CONFLICT DO NOTHING` 刻意不指定冲突目标：`dedup_key` 与 `game_uid` 都是唯一键，
 * 客户端重传时两者都可能撞上，任一唯一键冲突都应当退化成「返回既有行」而不是 500。
 */
export async function insertGame(db: D1Database, input: GameInput): Promise<InsertGameResult> {
  if (!input.gameUid) throw new TypeError('gameUid 不能为空');
  if (typeof input.notation !== 'string') throw new TypeError('notation 必须是字符串');
  if (input.payload === undefined) throw new TypeError('payload 不能是 undefined');

  const day = utcDay(input.createdAt);
  const payload = JSON.stringify(input.payload);
  const payloadBytes = new TextEncoder().encode(payload).length;
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    // 路由把 RangeError 映射成 413 payload_too_large（§4.4 护栏）；放在这里是为了
    // 不让超大行先落库再被 D1 的语句上限以看不懂的方式拒绝。
    throw new RangeError(`payload 超出上限：${payloadBytes} > ${MAX_PAYLOAD_BYTES} 字节`);
  }
  const dedupKey =
    input.dedupKey ?? (await sha1Hex(`${input.createdAt}|${input.gameUid}|${input.notation}`));

  const inserted = await db
    .prepare(GAME_INSERT)
    .bind(
      input.gameUid,
      dedupKey,
      input.createdAt,
      day,
      input.game,
      input.gameId,
      input.mode ?? null,
      input.result ?? null,
      input.winner ?? null,
      input.endReason ?? null,
      input.endBy ?? null,
      input.moves.length,
      input.notation,
      openingPrefix(input.moves),
      input.slug ?? null,
      input.duel ?? null,
      input.blackChannel ?? null,
      input.whiteChannel ?? null,
      input.blackTactics ?? null,
      input.whiteTactics ?? null,
      input.blackThink ?? null,
      input.whiteThink ?? null,
      input.experimentTag ?? null,
      input.expGameNo ?? null,
      input.codeVersion ?? null,
      input.tacticsVersion ?? null,
      input.topK ?? null,
      input.seed ?? null,
      input.costUsd ?? null,
      input.tokensIn ?? null,
      input.tokensOut ?? null,
      input.latencyAvgMs ?? null,
      input.latencyMaxMs ?? null,
      input.avgConf ?? null,
      input.tacticsHist ?? null,
      input.mock ? 1 : 0,
      input.firstWin === null || input.firstWin === undefined ? null : input.firstWin ? 1 : 0,
      input.cal === null || input.cal === undefined ? null : JSON.stringify(input.cal),
      input.deviceId ?? null,
      input.source ?? 'worker',
      payload,
      payloadBytes,
      input.tacAvgMs ?? null,
      input.tacMaxMs ?? null,
    )
    .first<{ id: number }>();

  if (inserted) {
    const movesWritten = await writeMoves(db, inserted.id, input.moves);
    const row = await requireGameById(db, inserted.id);
    return { game: toGame(row), dedup: false, movesWritten };
  }

  // 命中既有行：先按 dedup_key 找，再退到 game_uid（第二次提交可能换了导出时间戳，
  // 于是 dedup_key 变了但 game_uid 没变）。两条路径都走唯一索引。
  const existing =
    (await selectGameBy(db, 'dedup_key = ?', [dedupKey])) ?? (await selectGameBy(db, 'game_uid = ?', [input.gameUid]));
  if (!existing) {
    // ON CONFLICT 命中却没有既有行，说明唯一索引与本次绑定值不一致，属于真异常。
    throw new Error('幂等写入未命中唯一索引，但也没有既有行');
  }
  const movesWritten = await repairMoves(db, existing.id, input.moves);
  return { game: toGame(existing), dedup: true, movesWritten };
}

/**
 * 明细补齐：`game_moves` 与主行是两次写入（主行要先拿到自增 id），中途失败会留下
 * 「有主行、无明细」的残局，而按 dedup_key 幂等的重传本来永远不会再写明细，
 * 那局就永久缺手了。所以命中既有行且明细为空时补一次——只新增、绝不覆盖。
 */
async function repairMoves(
  db: D1Database,
  gameId: number,
  moves: readonly GameMoveInput[],
): Promise<number> {
  if (!moves.length) return 0;
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM game_moves WHERE game_id = ?')
    .bind(gameId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) > 0) return 0;
  return writeMoves(db, gameId, moves);
}

async function selectGameBy(
  db: D1Database,
  where: string,
  binds: unknown[],
): Promise<GameRow | null> {
  return db
    .prepare(`SELECT ${GAME_COLUMNS} FROM games WHERE ${where} LIMIT 1`)
    .bind(...binds)
    .first<GameRow>();
}

async function requireGameById(db: D1Database, id: number): Promise<GameRow> {
  const row = await selectGameBy(db, 'id = ?', [id]);
  if (!row) throw new Error(`插入后读不到游戏行：id=${id}`);
  return row;
}

/**
 * 列表：keyset 翻页（`id < cursor`）而不是 OFFSET——OFFSET 在深页要线性扫描，
 * 与 ADR-0011「查询必须走索引」冲突。WHERE 子句按给出的过滤条件动态拼装，
 * 未给出的条件不进 SQL，这样 `idx_games_day` / `idx_games_game` / `idx_games_device`
 * / `idx_games_tag` 才可能被选中（用 `?1 IS NULL OR day = ?1` 这类写法会让索引失效）。
 */
export async function listGames(db: D1Database, filter: ListGamesFilter = {}): Promise<GamePage> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (filter.day !== undefined) {
    clauses.push('day = ?');
    binds.push(filter.day);
  }
  if (filter.sinceDay !== undefined) {
    // 范围条件仍能走 idx_games_day（`day >= ?`），比 `substr(day,1,10) >= ?` 那种写法安全。
    clauses.push('day >= ?');
    binds.push(filter.sinceDay);
  }
  if (filter.gameId !== undefined) {
    clauses.push('game_id = ?');
    binds.push(filter.gameId);
  }
  if (filter.deviceId !== undefined) {
    clauses.push('device_id = ?');
    binds.push(filter.deviceId);
  }
  if (filter.experimentTag !== undefined) {
    clauses.push('experiment_tag = ?');
    binds.push(filter.experimentTag);
  }
  if (filter.cursor !== undefined) {
    clauses.push('id < ?');
    binds.push(filter.cursor);
  }
  const limit = resolveLimit(filter.limit);
  // 多取一行只用于判断「还有没有下一页」，返回前裁掉。
  binds.push(limit + 1);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT ${GAME_COLUMNS} FROM games ${where} ORDER BY id DESC LIMIT ?`)
    .bind(...binds)
    .all<GameRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    games: page.map(toGame),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

/** 详情定位：按 uid，或按旧 URL 的 day + slug。 */
export type GameRef = { gameUid: string } | { day: string; slug: string };

/**
 * 详情（含 payload 与逐手明细）。旧静态站的详情 URL 是
 * `/games/<day>/<slug>.json`，所以 slug 末尾的 `.json` 要容忍（P3 的兼容路由直接透传）。
 */
export async function getGame(db: D1Database, ref: GameRef): Promise<GameWithMoves | null> {
  const byUid = 'gameUid' in ref;
  const slug = byUid ? null : ref.slug.replace(/\.json$/i, '');
  const row = await db
    .prepare(
      `SELECT ${GAME_COLUMNS}, payload FROM games WHERE ${byUid ? 'game_uid = ?' : 'day = ? AND slug = ?'} LIMIT 1`,
    )
    .bind(...(byUid ? [ref.gameUid] : [ref.day, slug]))
    .first<GameRow & { payload: string }>();
  if (!row) return null;

  const moves = await db
    .prepare(`SELECT ${GAME_MOVE_COLUMNS} FROM game_moves WHERE game_id = ? ORDER BY ply ASC`)
    .bind(row.id)
    .all<GameMove>();
  return { ...toGame(row), payload: row.payload, moves: moves.results ?? [] };
}

/**
 * 按 `day` + `game_uid` **前缀**查详情。
 *
 * 为什么需要它：`GET /api/games` 返回的 `name` 是合成文件名
 * `<slug|gameId>-<game_uid 前 8 位>.json`（旧静态站的文件名规则就是这么来的），
 * 而旧详情 URL 只有 `day + name`，没有 uid。要保证「列表给出的 path 一定能被详情路由取回」，
 * 就得允许用这 8 位前缀反查。前缀重复的概率对 16 位十六进制 uid 是 1/2^32 量级，
 * 命中多行时取 id 最大的一行（列表也按 id 倒序，语义一致）。
 */
export async function getGameByUidPrefix(
  db: D1Database,
  day: string,
  prefix: string,
): Promise<GameWithMoves | null> {
  if (!prefix) return null;
  // LIKE 的通配符转义：uid 允许的字符集里没有 % 和 _，但前缀来自 URL，仍按字面处理更安全。
  const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const row = await db
    .prepare(
      `SELECT ${GAME_COLUMNS}, payload FROM games
       WHERE day = ? AND game_uid LIKE ? ESCAPE '\\'
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(day, `${escaped}%`)
    .first<GameRow & { payload: string }>();
  if (!row) return null;

  const moves = await db
    .prepare(`SELECT ${GAME_MOVE_COLUMNS} FROM game_moves WHERE game_id = ? ORDER BY ply ASC`)
    .bind(row.id)
    .all<GameMove>();
  return { ...toGame(row), payload: row.payload, moves: moves.results ?? [] };
}
