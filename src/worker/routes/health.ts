/**
 * `GET /api/health` —— 探活（不消耗上游额度）。
 *
 * 返回 D1 连通性与当前迁移版本（`schema`），供前端「后端」chip 与 CI 冒烟使用。
 * 与旧 Pages 版 `/api/health` 的差异：去掉 `github` 字段（GitHub-as-database 退役），
 * 新增 `d1` / `schema` / `device` 语义位以及 `today`（当日写入量护栏，见下）。
 *
 * `today` 是风险 R2 的对策「`/api/health` 暴露当日写入计数」的落地：D1 免费额度按
 * **写入行数**计（10 万行/日），一局约占 `1 + 手数` 行，超限当天就写不进去了。
 * 口径说明（别当成精确值）：统计的是 `games.day = 今天(UTC)` 的归档量，而 `day` 取自
 * 棋谱自带的 `exported` 日期（客户端给的时间戳），因此它是「今天归档的对局」而非
 * 「今天这一刻写入的行」——作为一个量级护栏足够，做精确计费口径需要在写入路径上加
 * 计数器表，那会给每次落库再加一次写，不值得（详见计划 R2）。
 */
import { Hono } from 'hono';
import { deviceMiddleware } from '../middleware/device.ts';
import type { AppEnv } from '../types.ts';

export const healthRoute = new Hono<AppEnv>();

/** D1 免费版每日写入行数上限（Cloudflare 2026-10 现行值）。 */
export const D1_FREE_ROWS_PER_DAY = 100_000;

interface DbProbe {
  d1: boolean;
  schema: string | null;
}

/** 当日写入量护栏：`rows` = 主表 1 行 + 每手 1 行的估算值。 */
export interface TodayUsage {
  day: string;
  games: number;
  moves: number;
  rows: number;
  rowBudget: number;
}

export async function probeDb(db: D1Database): Promise<DbProbe> {
  try {
    await db.prepare('SELECT 1 AS ok').first();
  } catch {
    return { d1: false, schema: null };
  }
  let schema: string | null = null;
  try {
    const row = await db
      .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
      .first<{ name: string }>();
    schema = row?.name ?? null;
  } catch {
    // 迁移尚未应用：d1_migrations 表不存在，不算故障
  }
  return { d1: true, schema };
}

/* 当日归档量：走 `idx_games_day`（`WHERE day = ?` 是索引前缀），不做全表扫描。
 * 任何异常都返回 null —— 探活接口不能因为这条附加统计而变红。 */
export async function probeToday(db: D1Database, now: Date = new Date()): Promise<TodayUsage | null> {
  const day = now.toISOString().slice(0, 10);
  try {
    const row = await db
      .prepare('SELECT COUNT(*) AS games, COALESCE(SUM(move_count), 0) AS moves FROM games WHERE day = ?')
      .bind(day)
      .first<{ games: number; moves: number }>();
    if (!row) return null;
    const games = Number(row.games) || 0;
    const moves = Number(row.moves) || 0;
    return { day, games, moves, rows: games + moves, rowBudget: D1_FREE_ROWS_PER_DAY };
  } catch {
    return null;
  }
}

/* 带 deviceMiddleware：探活请求也顺手校验 `X-Device-Id`（非法即 400），
 * 这样前端在开局前就能发现「设备标识写坏了」，而不是等到第一次提交棋谱。
 * 注意 health 不限流：它是 CI 冒烟与运维探活入口，被限流会让监控误判。 */
healthRoute.get('/', deviceMiddleware, async (c) => {
  const probe = await probeDb(c.env.DB);
  const today = probe.d1 ? await probeToday(c.env.DB) : null;
  return c.json({
    ok: true,
    service: 'jev-qiguan-worker',
    version: c.env.APP_VERSION ?? 'unknown',
    d1: probe.d1,
    schema: probe.schema,
    device: c.get('deviceId') !== null,
    today,
    time: new Date().toISOString(),
  });
});
