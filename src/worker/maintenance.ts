/**
 * 每日维护（Cron Trigger，计划 Q5 的默认答案）。
 *
 * 做三件事，都是「没人访问也必须发生」的：
 *  1. 清限流表：`rate_limits` 每 60s 窗口一行，按 `bucket:ip` 分槽，脏行会无限堆积。
 *     路由里那条 1% 概率的 `waitUntil` 清理只是兜底——低流量站点可能整天不触发，
 *     真正保证不涨的是这个定时任务。
 *  2. 落当日汇总：把总数与当日局数写进 `stats_cache`（key = `daily:<YYYY-MM-DD>`）。
 *     这张表在 0001_init.sql 里建好但一直没人用；先当「有 cron 就会更新的心跳 + 台账」，
 *     将来要缓存重聚合结果可以直接复用同一个 key 空间。
 *  3. 打一行日志：Cron 的返回值没人看，出问题时只能靠日志确认它真的跑过。
 *
 * 为什么不是「D1 导出快照」：Worker 里没有导出 D1 的能力（那是 wrangler 的活），
 * 计划 Q5 括号里的第三项在 Worker 侧做不到，备份仍走 `npm run db:export`（见 verify:backup）。
 *
 * 时间一律显式传入 `now`（默认 `Date.now()`），否则「今天」在测试里不可复现。
 */
import { pruneRateLimits, windowStartOf } from './db/index.ts';

/** 限流行保留时长：比最长窗口（60s）宽裕得多，只为清掉陈旧桶，不参与正确性。 */
export const RATE_LIMIT_RETENTION_SECONDS = 3600;

/** 汇总缓存的 key 前缀。 */
export const CACHE_KEY_PREFIX = 'daily:';

export interface MaintenanceResult {
  /** 运行时刻（ISO，UTC）。 */
  ranAt: string;
  /** 当日（UTC，`games.day` 同口径）。 */
  day: string;
  /** 被清掉的限流窗口行数。 */
  rateLimitsDeleted: number;
  games: number;
  moves: number;
  devices: number;
  experiments: number;
  /** 当日落库局数（`day` 当天）。 */
  gamesToday: number;
}

/** `SELECT COUNT(*) AS n` 的取值：拿不到就当 0，不让一行缺失炸掉整个 cron。 */
function countOf(result: D1Result<Record<string, unknown>> | undefined): number {
  const row = result?.results?.[0];
  const n = row ? row.n : 0;
  const value = typeof n === 'number' ? n : Number(n ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** `YYYY-MM-DD`（UTC）——与 `games.day` 的取值口径一致（导入侧取 `exported` 前 10 位）。 */
export function utcDayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * 跑一次每日维护。可注入 `now`，除此之外不读任何全局状态。
 *
 * 抛错策略：**不吞异常**——Cron 失败必须能在 `wrangler tail` 里看见。
 * 调用方（`scheduled`）负责把 promise 交给 `waitUntil`。
 */
export async function runDailyMaintenance(
  env: Env,
  opts: { now?: number } = {},
): Promise<MaintenanceResult> {
  const now = opts.now ?? Date.now();
  const ranAt = new Date(now).toISOString();
  const day = utcDayOf(now);

  /* 保留 1 小时：`before` 是 epoch 秒，`window_start < before` 命中主键前缀。 */
  const rateLimitsDeleted = await pruneRateLimits(
    env.DB,
    windowStartOf(now, RATE_LIMIT_RETENTION_SECONDS),
  );

  const [games, moves, devices, experiments, gamesToday] = await env.DB.batch<
    Record<string, unknown>
  >([
    env.DB.prepare('SELECT COUNT(*) AS n FROM games'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM game_moves'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM devices'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM experiments'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM games WHERE day = ?').bind(day),
  ]);

  const result: MaintenanceResult = {
    ranAt,
    day,
    rateLimitsDeleted,
    games: countOf(games),
    moves: countOf(moves),
    devices: countOf(devices),
    experiments: countOf(experiments),
    gamesToday: countOf(gamesToday),
  };

  /* 汇总写库：`ON CONFLICT DO UPDATE` 让重复运行（手动补跑、重试）覆盖而不是堆积。 */
  await env.DB.prepare(
    `INSERT INTO stats_cache(key, value, updated_at) VALUES(?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(`${CACHE_KEY_PREFIX}${day}`, JSON.stringify(result), ranAt)
    .run();

  console.log(
    `[maintenance] ${ranAt} day=${day} rateLimitsDeleted=${rateLimitsDeleted} ` +
      `games=${result.games} moves=${result.moves} devices=${result.devices} ` +
      `experiments=${result.experiments} gamesToday=${result.gamesToday}`,
  );

  return result;
}
