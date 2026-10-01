/**
 * 每日维护（Cron）契约，`src/worker/maintenance.ts` + 入口的 `scheduled`。
 *
 * 为什么不通过 `SELF.scheduled()` 触发：那要依赖 vitest pool 对 scheduled 事件的支持，
 * 而真正会「悄悄坏掉」的是**接线**——`index.ts` 的 `scheduled` 有没有把 promise 交给
 * `waitUntil`、crons 有没有配。所以这里直接在 Node 侧构造一个假 `ExecutionContext`
 * 调入口的 `scheduled`，再把捕获到的 promise await 掉。
 *
 * worker project 不做逐用例存储隔离（`singleWorker: true`），每个用例自己清库。
 */
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker/index.ts';
import {
  CACHE_KEY_PREFIX,
  RATE_LIMIT_RETENTION_SECONDS,
  runDailyMaintenance,
  utcDayOf,
} from '../../src/worker/maintenance.ts';

/** 一局 5 手的五子棋；`exported` 固定，好让「当日局数」可断言。 */
function gomokuPayload() {
  const notations = ['h8', 'i9', 'h9', 'i10', 'h10'];
  return {
    format: 'jev-qiguan-game/v1',
    exported: '2026-10-02T03:04:05.000Z',
    game: '五子棋',
    gid: 'gomoku',
    mode: '人机',
    channel: 'proxy',
    result: '黑方 获胜（五连）',
    notation: 'h8,i9,h9,i10,h10,',
    moves: notations.map((notation, i) => ({
      ply: i + 1,
      side: i % 2 === 0 ? '黑方' : '白方',
      notation,
    })),
    meta: { code: '0.8.0' },
  };
}

/** 用真链路写一局（顺带建 devices 行），别手搓 INSERT——列太多，漏一列就报 FK/NOT NULL。 */
async function seedGame(deviceId: string): Promise<void> {
  const res = await SELF.fetch('https://example.com/api/games', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Device-Id': deviceId },
    body: JSON.stringify(gomokuPayload()),
  });
  expect(res.status).toBe(200);
}

async function cacheRow(key: string): Promise<{ value: string; updated_at: string } | null> {
  return env.DB.prepare('SELECT value, updated_at FROM stats_cache WHERE key = ?')
    .bind(key)
    .first<{ value: string; updated_at: string }>();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_moves'),
    env.DB.prepare('DELETE FROM games'),
    env.DB.prepare('DELETE FROM experiments'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM rate_limits'),
    env.DB.prepare('DELETE FROM stats_cache'),
  ]);
});

describe('utcDayOf', () => {
  it('按 UTC 取日期，且与 games.day 同口径', () => {
    expect(utcDayOf(Date.parse('2026-10-02T00:00:00.000Z'))).toBe('2026-10-02');
    expect(utcDayOf(Date.parse('2026-10-02T23:59:59.999Z'))).toBe('2026-10-02');
    // 跨天边界：早 1 毫秒就是前一天，不能用本地时区
    expect(utcDayOf(Date.parse('2026-10-02T00:00:00.000Z') - 1)).toBe('2026-10-01');
  });
});

describe('runDailyMaintenance', () => {
  const NOW = Date.parse('2026-10-02T12:00:00.000Z');

  it('清掉保留期外的限流窗口行，保留当前窗口', async () => {
    const nowSec = Math.floor(NOW / 1000);
    const stale = nowSec - RATE_LIMIT_RETENTION_SECONDS * 2;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO rate_limits(bucket, window_start, count) VALUES(?,?,?)').bind(
        'read:1.1.1.1',
        stale,
        7,
      ),
      env.DB.prepare('INSERT INTO rate_limits(bucket, window_start, count) VALUES(?,?,?)').bind(
        'write:2.2.2.2',
        nowSec,
        3,
      ),
    ]);

    const result = await runDailyMaintenance(env, { now: NOW });
    expect(result.rateLimitsDeleted).toBe(1);

    const left = await env.DB.prepare('SELECT bucket, window_start FROM rate_limits').all<{
      bucket: string;
      window_start: number;
    }>();
    expect(left.results).toHaveLength(1);
    expect(left.results[0]!.bucket).toBe('write:2.2.2.2');
  });

  it('统计总数/当日局数并把汇总写进 stats_cache', async () => {
    await seedGame('maint-device-0001');
    const result = await runDailyMaintenance(env, { now: NOW });

    expect(result.day).toBe('2026-10-02');
    expect(result.ranAt).toBe('2026-10-02T12:00:00.000Z');
    expect(result.games).toBe(1);
    expect(result.moves).toBe(5);
    expect(result.devices).toBe(1);
    expect(result.experiments).toBe(0);
    // 棋谱的 exported 是 2026-10-02，与注入的 now 同一天
    expect(result.gamesToday).toBe(1);

    const row = await cacheRow(`${CACHE_KEY_PREFIX}2026-10-02`);
    expect(row).not.toBeNull();
    expect(row!.updated_at).toBe('2026-10-02T12:00:00.000Z');
    expect(JSON.parse(row!.value)).toMatchObject({ games: 1, moves: 5, devices: 1, gamesToday: 1 });
  });

  it('重复运行幂等：计数不变、缓存覆盖不堆积、限流清理退化为 0', async () => {
    await seedGame('maint-device-0002');
    const first = await runDailyMaintenance(env, { now: NOW });
    const second = await runDailyMaintenance(env, { now: NOW + 60_000 });

    expect(second.games).toBe(first.games);
    expect(second.moves).toBe(first.moves);
    expect(second.rateLimitsDeleted).toBe(0);

    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM stats_cache').first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const row = await cacheRow(`${CACHE_KEY_PREFIX}2026-10-02`);
    expect(row!.updated_at).toBe('2026-10-02T12:01:00.000Z');
  });

  it('空库不炸：全 0、仍写心跳行', async () => {
    const result = await runDailyMaintenance(env, { now: NOW });
    expect(result).toMatchObject({
      games: 0,
      moves: 0,
      devices: 0,
      experiments: 0,
      gamesToday: 0,
      rateLimitsDeleted: 0,
    });
    expect(await cacheRow(`${CACHE_KEY_PREFIX}2026-10-02`)).not.toBeNull();
  });
});

describe('入口接线', () => {
  it('导出 handler 对象：fetch 转发 Hono，scheduled 把维护交给 waitUntil', async () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');

    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    worker.scheduled({ scheduledTime: Date.now(), cron: '17 3 * * *' } as ScheduledController, env, ctx);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);

    // 真跑到了维护：缓存里出现今天的心跳行
    const key = `${CACHE_KEY_PREFIX}${utcDayOf(Date.now())}`;
    expect(await cacheRow(key)).not.toBeNull();
  });
});
