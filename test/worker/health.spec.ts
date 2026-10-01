/**
 * /api/health 契约（docs/plans/2026-10-01-workers-d1-rebuild.md §5）。
 * 这条用例同时验证三件事：workerd 能起、Hono 路由挂对、D1 迁移能落库。
 */
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

describe('GET /api/health', () => {
  it('返回服务标识、版本与 D1 状态', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as {
      ok: boolean;
      service: string;
      version: string;
      d1: boolean;
      schema: string | null;
      time: string;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('jev-qiguan-worker');
    expect(body.version).toBe('1.0.0');
    expect(body.d1).toBe(true);
    expect(body.schema).toBe('0001_init.sql');
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it('带上 X-Request-Id 回执', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('未命中路由', () => {
  it('/api/* 未实现时回 JSON 404 而不是 SPA 的 HTML', async () => {
    const res = await SELF.fetch('https://example.com/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');

    // 错误体形状（全 API 统一）：{ error: <人类可读消息>, code: <机器码>, requestId }
    const body = (await res.json()) as { error: string; code: string; requestId: string | null };
    expect(body.code).toBe('not_found');
    expect(typeof body.error).toBe('string');
  });
});

/**
 * `today` = 风险 R2（D1 免费额度 10 万写行/日）的对策：探活顺带报当日归档量。
 * worker project 是 `singleWorker: true`，**没有逐用例存储隔离**，所以这里自己清库。
 */
describe('GET /api/health → today（当日写入护栏）', () => {
  const day = new Date().toISOString().slice(0, 10);
  const utcNoon = `${day}T12:00:00.000Z`;

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM game_moves'),
      env.DB.prepare('DELETE FROM games'),
      env.DB.prepare('DELETE FROM experiments'),
      env.DB.prepare('DELETE FROM devices'),
      env.DB.prepare('DELETE FROM rate_limits'),
    ]);
  });

  async function readToday() {
    const res = await SELF.fetch('https://example.com/api/health');
    const body = (await res.json()) as {
      today: { day: string; games: number; moves: number; rows: number; rowBudget: number } | null;
    };
    return body.today;
  }

  it('空库时给出零值结构与免费额度上限', async () => {
    const today = await readToday();
    expect(today).not.toBeNull();
    expect(today!.day).toBe(day);
    expect(today!.games).toBe(0);
    expect(today!.moves).toBe(0);
    expect(today!.rows).toBe(0);
    expect(today!.rowBudget).toBe(100_000);
  });

  it('当天归档一局 5 手后，games/moves/rows 跟着涨（rows = 1 + 手数）', async () => {
    const notations = ['h8', 'i9', 'h9', 'i10', 'h10'];
    const payload = {
      format: 'jev-qiguan-game/v1',
      exported: utcNoon,
      game: '五子棋',
      gid: 'gomoku',
      result: '黑方 获胜（五连）',
      notation: notations.join(',') + ',',
      moves: notations.map((n, i) => ({ ply: i + 1, side: i % 2 === 0 ? '黑方' : '白方', notation: n })),
    };
    const posted = await SELF.fetch('https://example.com/api/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(posted.status).toBe(200);

    const today = await readToday();
    expect(today!.games).toBe(1);
    expect(today!.moves).toBe(5);
    expect(today!.rows).toBe(6);
  });

  it('历史归档不计入当天（护栏只关心今天写进去的行）', async () => {
    const notations = ['h8', 'i9', 'h9', 'i10', 'h10'];
    const posted = await SELF.fetch('https://example.com/api/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'jev-qiguan-game/v1',
        exported: '2026-09-30T03:04:05.000Z',
        game: '五子棋',
        gid: 'gomoku',
        result: '白方 获胜（五连）',
        notation: notations.join(',') + ',',
        moves: notations.map((n, i) => ({ ply: i + 1, side: i % 2 === 0 ? '黑方' : '白方', notation: n })),
      }),
    });
    expect(posted.status).toBe(200);
    const today = await readToday();
    expect(today!.games).toBe(0);
    expect(today!.rows).toBe(0);
  });
});
