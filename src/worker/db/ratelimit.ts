/**
 * D1 固定窗口限流（rate_limits）。ADR-0013：迁移后不再用 Pages Functions 的
 * 内存计数（多实例各算各的，等于没限），改为 D1 单行计数。
 *
 * 为什么必须是「一条 SQL」：先 SELECT 再 UPDATE/INSERT 的读-改-写在并发下会互相踩，
 * 把限额放大成 N 倍。`INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` 让
 * 「自增 + 取回自增后的值」在 SQLite 的单语句事务内原子完成，判定用的是这条语句
 * 自己返回的 count，而不是之前读到的快照。
 *
 * 窗口按秒对齐（60s 窗口 → window_start = floor(now/60)*60），所以同一窗口内的所有
 * 请求命中主键 (bucket, window_start) 的同一行，跨窗口自动落到新行、无需清理即可重置。
 */

/** 限流判定结果。resetAt 是窗口结束时刻（epoch 秒，与 window_start 同单位）。 */
export interface RateLimitResult {
  allowed: boolean;
  /** 本窗口内累计请求数（含本次）。 */
  count: number;
  limit: number;
  remaining: number;
  resetAt: number;
}

const HIT_SQL = `INSERT INTO rate_limits(bucket, window_start, count) VALUES(?1, ?2, 1)
  ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
  RETURNING count`;

/** 本窗口起始（epoch 秒）。向下取整而不是从进程启动计时，才能让多实例共享同一窗口。 */
export function windowStartOf(nowMs: number, windowSeconds: number): number {
  const seconds = Math.floor(nowMs / 1000);
  return Math.floor(seconds / windowSeconds) * windowSeconds;
}

/**
 * 记一次请求并判定是否放行。
 *
 * `now` 可注入是为了让跨窗口行为可测——真实调用点一律用默认值。
 */
export async function hitRateLimit(
  db: D1Database,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  if (typeof bucket !== 'string' || !bucket) throw new TypeError('bucket 必须是非空字符串');
  if (!Number.isFinite(limit) || limit < 1) throw new RangeError(`limit 必须为正数：${limit}`);
  if (!Number.isFinite(windowSeconds) || windowSeconds < 1) {
    throw new RangeError(`windowSeconds 必须为正数：${windowSeconds}`);
  }
  const windowStart = windowStartOf(now, windowSeconds);
  const row = await db
    .prepare(HIT_SQL)
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  if (!row) throw new Error(`限流计数未返回行：bucket=${bucket}`);
  const count = row.count;
  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt: windowStart + windowSeconds,
  };
}

/**
 * 清理过期窗口行。ADR-0013 把触发时机（1% 概率、ctx.waitUntil 异步）留给路由，
 * 这里只负责删除：`window_start < before` 是主键前缀条件，走 WITHOUT ROWID 表的主键索引。
 * 返回删除行数，便于路由侧按需记录。
 */
export async function pruneRateLimits(db: D1Database, before: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(before)
    .run();
  return result.meta.changes ?? 0;
}
