/**
 * 跨对局统计（SQL 侧聚合）。
 *
 * 口径与旧实现（`functions/api/stats.js`、`server.cjs` 的 handleStats）逐项对齐——
 * 迁移不是改口径的时机，附录 B 的对账要求 results 与 cal.records 逐项相等：
 *
 * 1. `totalGames` / `byGame` / `results` **不筛 mock**：旧实现只在校准样本那一步看 mock，
 *    离线演示局照样计入对局总数与胜负分布（前端的本机战绩簿另有 skippedDemo 口径，那是
 *    另一套数，不要混）。
 * 2. `byGame` 以**棋种中文名**为键（旧实现取 `rec.game`），缺名退化成 `unknown`。
 * 3. `results` 用 `result` 文本按「黑方 → 白方 → 和棋」的优先级判定，因此
 *    「黑方 认输」这类串仍算黑方；`result` 为空或不含这三个词的（未终局、换边中断）
 *    三项都不计。刻意不用 `games.winner` 列：那里的 NULL 表示和棋，
 *    「未终局」会被算成和棋，与旧口径不一致。
 * 4. 校准样本只收 `mock = 0` 且 `first_win` 为二元真值（NULL 排除）且 `cal_json`
 *    是 JSON 数组的行——三条都是旧实现 `Array.isArray(cal) && (firstWin === true || false)`
 *    的等价条件。
 *
 * 为什么聚合必须整段下推到 SQL：旧 Pages 版把最近 40 份棋谱拉进函数里循环累加
 * （50 子请求上限直接决定了样本量），线上数字随对局增长而失真。这里 COUNT/GROUP BY/SUM
 * 全在 D1 执行，返回的只有聚合结果；唯一按行返回的是校准样本本身——它要逐手参与
 * 前端校准计算，本来就搬不进聚合。
 */

/** 校准样本一次最多返回多少局（§4.3 草案取值）：再多也不该让一次 /api/stats 拖回上兆数据。 */
export const CAL_SAMPLE_LIMIT = 500;

/** 过滤条件：全部可选，对应 §5.1 的 scope=device / game / since。都不给即全局（旧口径）。 */
export interface StatsOptions {
  deviceId?: string;
  gameId?: string;
  /** 含当天：`day >= sinceDay`（day 是 UTC YYYY-MM-DD，字典序即时间序）。 */
  sinceDay?: string;
}

/** 校准样本：一条二元真值 + 该局逐手概率，key 与前端战绩簿去重口径同构。 */
export interface CalRecord {
  key: string;
  firstWin: boolean;
  cal: unknown[];
}

export interface StatsResult {
  totalGames: number;
  byGame: Record<string, number>;
  results: { black: number; white: number; draw: number };
  cal: { games: number; records: CalRecord[] };
}

interface Filter {
  conditions: string[];
  binds: string[];
}

/**
 * 过滤条件按需拼接，而不是写成 `(?1 IS NULL OR device_id = ?1)`：后者在 SQLite 里
 * 会让 device_id/day 上的索引失效（优化器无法在 prepare 阶段判断分支），
 * ADR-0011 明确要求查询必须能走索引。
 */
function buildFilter(options: StatsOptions): Filter {
  const conditions: string[] = [];
  const binds: string[] = [];
  if (options.deviceId) {
    conditions.push('device_id = ?');
    binds.push(options.deviceId);
  }
  if (options.gameId) {
    conditions.push('game_id = ?');
    binds.push(options.gameId);
  }
  if (options.sinceDay) {
    conditions.push('day >= ?');
    binds.push(options.sinceDay);
  }
  return { conditions, binds };
}

function whereOf(conditions: string[]): string {
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}

interface TotalRow {
  total: number;
}

interface ByGameRow {
  name: string;
  n: number;
}

interface ResultsRow {
  black: number;
  white: number;
  draw: number;
}

interface CalRow {
  gameId: string;
  notation: string;
  firstWin: number;
  calJson: string;
}

/**
 * 跨对局聚合。四段统计各一条 SQL，互不依赖，调用方若要并行只能靠 `db.batch`，
 * 这里保持顺序 await——D1 同一 binding 上的并发收益很小，可读性更值钱。
 */
export async function getStats(
  db: D1Database,
  options: StatsOptions = {},
): Promise<StatsResult> {
  const filter = buildFilter(options);
  const where = whereOf(filter.conditions);

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM games ${where}`)
    .bind(...filter.binds)
    .first<TotalRow>();

  const byGameRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(game, ''), 'unknown') AS name, COUNT(*) AS n
         FROM games ${where} GROUP BY name ORDER BY n DESC, name ASC`,
    )
    .bind(...filter.binds)
    .all<ByGameRow>();

  // 三个 SUM 里的 NOT LIKE 条件是为了复刻旧实现的 if / else-if 优先级：
  // 只要串里出现「黑方」就记黑方，同一行不会再被白方/和棋重复计数。
  const resultsRow = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN result LIKE '%黑方%' THEN 1 ELSE 0 END), 0) AS black,
         COALESCE(SUM(CASE WHEN result NOT LIKE '%黑方%' AND result LIKE '%白方%' THEN 1 ELSE 0 END), 0) AS white,
         COALESCE(SUM(CASE WHEN result NOT LIKE '%黑方%' AND result NOT LIKE '%白方%'
                            AND result LIKE '%和棋%' THEN 1 ELSE 0 END), 0) AS draw
       FROM games ${where}`,
    )
    .bind(...filter.binds)
    .first<ResultsRow>();

  // json_type 对坏 JSON 会直接报 "malformed JSON" 而整条语句失败，所以必须先过
  // json_valid；用 CASE 而不是 AND，是因为 SQLite 不保证 AND 的短路求值。
  const calConditions = [
    ...filter.conditions,
    'mock = 0',
    'first_win IS NOT NULL',
    "CASE WHEN json_valid(cal_json) THEN json_type(cal_json) = 'array' ELSE 0 END",
  ];
  const calRows = await db
    .prepare(
      `SELECT game_id AS gameId, notation, first_win AS firstWin, cal_json AS calJson
         FROM games ${whereOf(calConditions)} ORDER BY id DESC LIMIT ${CAL_SAMPLE_LIMIT}`,
    )
    .bind(...filter.binds)
    .all<CalRow>();

  const byGame: Record<string, number> = {};
  for (const row of byGameRows.results ?? []) byGame[row.name] = row.n;

  const records: CalRecord[] = [];
  for (const row of calRows.results ?? []) {
    const parsed: unknown = JSON.parse(row.calJson);
    // SQL 侧已保证是数组，这里只是把类型收窄；万一 schema 被人改过也不会污染样本。
    if (!Array.isArray(parsed)) continue;
    // key 与旧实现 `gid + '|' + notation` 同构：旧 gid 即棋种 id，所以用 game_id 还原，
    // 前端战绩簿的 `gid|notas.join(',')` 因此能直接对上、不重复计入。
    records.push({
      key: `${row.gameId}|${row.notation}`,
      firstWin: row.firstWin !== 0,
      cal: parsed,
    });
  }

  return {
    totalGames: totalRow?.total ?? 0,
    byGame,
    results: {
      black: resultsRow?.black ?? 0,
      white: resultsRow?.white ?? 0,
      draw: resultsRow?.draw ?? 0,
    },
    // games 取返回样本条数（旧实现同样如此）：LIMIT 只截断样本，不去虚报一个没读到的总数。
    cal: { games: records.length, records },
  };
}
