/**
 * 实验归档数据访问（experiments）。
 *
 * 与旧 `functions/api/experiments.js` 的语义差别只有一处、而且是刻意的：旧实现把整个
 * entry 覆盖写回，前端少传一个字段就把 `tacA` 抹成 undefined；而 `tac_a`/`tac_b` 是
 * 「同渠道 A/B 到底差在哪」的唯一依据（chan_a/chan_b 相同，只有战术不同），丢了就再也
 * 读不出档位。所以这里统一成 **「未给出（undefined/null）即保留旧值，给出即覆盖」**，
 * 用 upsert 的 SET 子句在 SQL 侧完成，避免读-改-写竞态。
 */

/** 默认/最大返回条数：实验轮次天然很少，但仍按 ADR-0011 给 LIMIT 封顶。 */
export const DEFAULT_EXPERIMENT_LIMIT = 50;
export const MAX_EXPERIMENT_LIMIT = 200;

/** upsert 输入：字段与 experiments 列一一对应，未给出的可空列保持既有值。 */
export interface ExperimentInput {
  tag: string;
  /** 不传由 SQLite 补当前 UTC ISO8601（与旧接口 `payload.date || new Date().toISOString()` 等价）。 */
  date?: string | null;
  chanA?: string | null;
  chanB?: string | null;
  tacA?: string | null;
  tacB?: string | null;
  thinkA?: number | null;
  thinkB?: number | null;
  total?: number | null;
  note?: string | null;
  /** 本轮的对局引用数组；不传则保留既有的 games_json（新建时落 '[]'）。 */
  games?: unknown[] | null;
  deviceId?: string | null;
}

/** experiments 行（SQL 别名后的形状）。games_json 以原文返回，解析见 parseExperimentGames。 */
export interface ExperimentRow {
  tag: string;
  date: string;
  chanA: string | null;
  chanB: string | null;
  tacA: string | null;
  tacB: string | null;
  thinkA: number | null;
  thinkB: number | null;
  total: number | null;
  note: string | null;
  gamesJson: string;
  deviceId: string | null;
  updatedAt: string;
}

const EXPERIMENT_COLUMNS = `tag, date, chan_a AS chanA, chan_b AS chanB, tac_a AS tacA, tac_b AS tacB,
  think_a AS thinkA, think_b AS thinkB, total, note, games_json AS gamesJson,
  device_id AS deviceId, updated_at AS updatedAt`;

/**
 * VALUES 用 COALESCE 兜住 NOT NULL / 默认值（只有全新插入才需要的缺省），
 * DO UPDATE 用裸参数兜住「未给出即保留」——两者必须用同一批编号参数的不同写法，
 * 才能保证一次 upsert 同时满足「新建有默认值」和「更新不抹字段」。
 *
 * ⚠️ 「未给出即保留」只在调用方**真的传 NULL** 时才成立。`mapExperimentRecord` 会把缺失的
 * `date`/`games`/`total` 分别兜成 `opts.now`/`[]`/`games.length`（都非 NULL），所以走映射层的
 * 请求如果只传 `{tag, note}`，这里会把既有 `games_json` / `total` / `date` 覆盖掉。
 * 兜底目前落在路由层（`routes/experiments.ts` 的 `fillMissing`：先读旧行再补字段）；
 * 若日后新增调用方，**必须**同样补齐，或把这一步下沉到本层。
 */
const EXPERIMENT_UPSERT = `INSERT INTO experiments
  (tag, date, chan_a, chan_b, tac_a, tac_b, think_a, think_b, total, note, games_json, device_id, updated_at)
  VALUES (?1, COALESCE(?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          COALESCE(?11, '[]'), ?12, datetime('now'))
  ON CONFLICT(tag) DO UPDATE SET
    date = COALESCE(?2, experiments.date),
    chan_a = COALESCE(?3, experiments.chan_a),
    chan_b = COALESCE(?4, experiments.chan_b),
    tac_a = COALESCE(?5, experiments.tac_a),
    tac_b = COALESCE(?6, experiments.tac_b),
    think_a = COALESCE(?7, experiments.think_a),
    think_b = COALESCE(?8, experiments.think_b),
    total = COALESCE(?9, experiments.total),
    note = COALESCE(?10, experiments.note),
    games_json = COALESCE(?11, experiments.games_json),
    device_id = COALESCE(?12, experiments.device_id),
    updated_at = datetime('now')
  RETURNING ${EXPERIMENT_COLUMNS}`;

/**
 * 解析本轮对局引用。旧接口对 games 缺失就是当空数组处理，所以坏数据同样退化成 []
 * 而不是抛错——实验面板少显示一行，好过整个 /api/experiments 500。
 */
export function parseExperimentGames(row: ExperimentRow): unknown[] {
  try {
    const parsed: unknown = JSON.parse(row.gamesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 写入一轮实验，返回落库后的完整行（含首次插入与更新两条路径的合并结果）。 */
export async function upsertExperiment(
  db: D1Database,
  input: ExperimentInput,
): Promise<ExperimentRow> {
  if (typeof input.tag !== 'string' || !input.tag) {
    throw new TypeError('experiment tag 必须是非空字符串');
  }
  const row = await db
    .prepare(EXPERIMENT_UPSERT)
    .bind(
      input.tag,
      input.date ?? null,
      input.chanA ?? null,
      input.chanB ?? null,
      input.tacA ?? null,
      input.tacB ?? null,
      input.thinkA ?? null,
      input.thinkB ?? null,
      input.total ?? null,
      input.note ?? null,
      input.games === null || input.games === undefined ? null : JSON.stringify(input.games),
      input.deviceId ?? null,
    )
    .first<ExperimentRow>();
  if (!row) throw new Error(`upsert 实验后读不到行：tag=${input.tag}`);
  return row;
}

/** 列表：date 倒序（与旧接口一致），tag 兜底排序保证同一天内顺序稳定。 */
export async function listExperiments(
  db: D1Database,
  limit: number = DEFAULT_EXPERIMENT_LIMIT,
): Promise<ExperimentRow[]> {
  const size = Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), MAX_EXPERIMENT_LIMIT)
    : DEFAULT_EXPERIMENT_LIMIT;
  const result = await db
    .prepare(`SELECT ${EXPERIMENT_COLUMNS} FROM experiments ORDER BY date DESC, tag DESC LIMIT ?`)
    .bind(size)
    .all<ExperimentRow>();
  return result.results ?? [];
}
