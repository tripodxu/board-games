/**
 * `GET /api/export/games` 契约测试（计划 §5.1 末行 / §7 批量导出）。
 *
 * 走真中间件链（真 workerd + 真 D1）：`rateLimit('read') → deviceMiddleware → JSONL 流`。
 * 数据直接经 `insertGame` 落库（不经 HTTP），因为 120 局种子如果走 `POST /api/games`
 * 会先撞上写限流 20/分——那测的就是另一个中间件了。
 *
 * 覆盖点：
 *  - JSONL 形状：行数 == 库里局数、每行可 `JSON.parse`、`payload` 原文保真（可复原）；
 *  - 响应头：`application/x-ndjson; charset=utf-8` + `Content-Disposition: …jsonl`；
 *  - **跨页不重不漏**：每页 100（`MAX_LIST_LIMIT`），120 局必然翻页；
 *  - 过滤：`day`（精确）/ `since`（含当天，且行序倒序可以提前停）/ `game`（白名单）；
 *  - 边界：空结果 **200 + 空体**（不是 404 也不是 `[]`）；非法参数 400。
 *
 * ⚠️ 集成点：`SELF.fetch('…/api/export/games')` 的前提是编排者把 `exportRoute` 挂上
 * （`app.route('/api/export', exportRoute)` 或 `api.route('/export', exportRoute)`）。
 * `buildApp()` 同样兜住两种状态，见 `jev.spec.ts` 的同名说明。
 */
import { SELF, env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { app as indexApp } from '../../src/worker/index.ts';
import { exportRoute, exportFilename, parseExportParams } from '../../src/worker/routes/export.ts';
import { getGame, insertGame } from '../../src/worker/db/index.ts';
import type { GameInput, GameMoveInput } from '../../src/worker/db/index.ts';
import type { AppEnv } from '../../src/worker/types.ts';

const EXPORT_URL = 'https://example.com/api/export/games';

/** 每个用例从空库 + 空限流桶开始：读桶是 120/分，种子多的用例会靠近这个数。 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_moves'),
    env.DB.prepare('DELETE FROM games'),
    env.DB.prepare('DELETE FROM rate_limits'),
  ]);
});

/* `index.ts` 是否已经挂上 exportRoute（编排者的活）。挂了就必须用真 app，
 * 否则 `app.route()` 会因为路径重复而抛错——所以这个判断不是可选的优化。 */
const mounted = indexApp.routes.some((r) => r.path === '/api/export/games' && r.method === 'GET');

function buildApp(): Hono<AppEnv> {
  if (mounted) return indexApp;
  const app = new Hono<AppEnv>();
  app.route('/api/export', exportRoute);
  return app;
}

async function getExport(query = '', init: RequestInit = {}): Promise<Response> {
  const url = query ? `${EXPORT_URL}?${query}` : EXPORT_URL;
  if (mounted) return SELF.fetch(url, init);
  // `app.fetch()` 的类型里带同步重载，`Response` 也在其中；`await` 对两边都成立。
  return await buildApp().fetch(new Request(url, init), env);
}

/** 响应体按 JSONL 解析；顺手断言「没有空行、每行都能 parse」。 */
async function readJsonl(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  if (text === '') return [];
  const lines = text.split('\n');
  expect(lines.at(-1)).toBe(''); // 每行都以 \n 结尾
  const rows = lines.slice(0, -1).map((line) => {
    expect(line.length).toBeGreaterThan(0);
    return JSON.parse(line) as Record<string, unknown>;
  });
  return rows;
}

/** 只经 db 层落库（避开写限流）。`exported` 决定 `day`，用于过滤用例。 */
async function seedGame(opts: { uid: string; exported: string; gameId?: string; notation?: string }): Promise<void> {
  const gameId = opts.gameId ?? 'gomoku';
  const notation = opts.notation ?? 'h8,i9,h9,';
  const notations = notation.split(',').filter(Boolean);
  const moves: GameMoveInput[] = notations.map((notation, i) => ({
    notation,
    side: i % 2 === 0 ? '黑方' : '白方',
  }));
  const payload = {
    format: 'jev-qiguan-game/v1',
    exported: opts.exported,
    game: gameId === 'gomoku' ? '五子棋' : '围棋',
    gid: gameId,
    notation,
    moves: notations.map((notation, i) => ({ ply: i + 1, notation, side: i % 2 === 0 ? '黑方' : '白方' })),
  };
  const input: GameInput = {
    gameUid: opts.uid,
    createdAt: opts.exported,
    game: payload.game,
    gameId,
    notation,
    payload,
    moves,
  };
  await insertGame(env.DB, input);
}

describe('GET /api/export/games', () => {
  it('JSONL：一行一局、可 parse、payload 原文保真、响应头正确', async () => {
    await seedGame({ uid: 'uid-1', exported: '2026-10-02T03:04:05.000Z' });
    await seedGame({ uid: 'uid-2', exported: '2026-10-03T03:04:05.000Z', notation: 'q16,d4,q4,' });

    const res = await getExport();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="jev-games-all.jsonl"');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const rows = await readJsonl(res);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.gameUid).toBeTruthy();
      // 落库列 + payload 原文
      expect(typeof row.payload).toBe('string');
      expect(JSON.parse(row.payload as string)).toMatchObject({ format: 'jev-qiguan-game/v1' });
      expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // 导出顺序：id DESC（最新在前），与列表端点一致
    expect(rows[0].gameUid).toBe('uid-2');
    expect(rows[1].gameUid).toBe('uid-1');

    // payload 保真到可复原：原文里的 exported/notation 与种子里一致
    const first = JSON.parse(rows[1].payload as string) as { exported: string; notation: string };
    expect(first.exported).toBe('2026-10-02T03:04:05.000Z');
    expect(first.notation).toBe('h8,i9,h9,');
  });

  it('行内容与 getGame 逐字段一致（2026-10-06 改查询不改契约：listGameDetails == getGame）', async () => {
    /* 技术债 #3 销账后的回归钉子：导出从「列表 + 逐局 getGame（N+1）」换成
     * listGameDetails 批量页（每页 2 次往返），本用例保证两种取法的返回对象
     * 逐字段相同（含 payload 原文与逐手明细），消费方无感。 */
    await seedGame({ uid: 'uid-eq', exported: '2026-10-05T03:04:05.000Z', notation: 'h8,i9,h9,i8,j8,' });

    const res = await getExport();
    const rows = await readJsonl(res);
    expect(rows).toHaveLength(1);

    const detail = await getGame(env.DB, { gameUid: 'uid-eq' });
    expect(detail).not.toBeNull();
    expect(rows[0]).toEqual(detail as unknown as Record<string, unknown>);
  });

  it('空结果 → 200 + 空体（不是 404、不是 []）', async () => {
    const res = await getExport();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="jev-games-all.jsonl"');
    expect(await res.text()).toBe('');
  });

  it('120 局跨页导出：分行数正确、id 不重不漏（每页 100）', async () => {
    const total = 120;
    for (let i = 0; i < total; i++) {
      // 3 天轮转，日期字符串定长可直接比较
      const day = 2 + (i % 3);
      await seedGame({ uid: `uid-${i}`, exported: `2026-10-0${day}T03:04:05.000Z` });
    }

    const res = await getExport();
    const rows = await readJsonl(res);
    expect(rows).toHaveLength(total);
    const ids = rows.map((r) => r.gameUid as string);
    expect(new Set(ids).size).toBe(total); // 不重
    // 不重 + 行数相等 ⇒ 不漏。再钉一次「id 严格递减」以证明跨页顺序没被打乱
    for (let i = 1; i < rows.length; i++) {
      expect(Number(rows[i - 1].id)).toBeGreaterThan(Number(rows[i].id));
    }
  });

  it('day 过滤：只出当天，文件名带日期', async () => {
    await seedGame({ uid: 'uid-a', exported: '2026-10-02T03:00:00.000Z' });
    await seedGame({ uid: 'uid-b', exported: '2026-10-03T03:00:00.000Z' });

    const res = await getExport('day=2026-10-03');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="jev-games-2026-10-03.jsonl"');
    const rows = await readJsonl(res);
    expect(rows.map((r) => r.gameUid)).toEqual(['uid-b']);
    expect(rows[0].day).toBe('2026-10-03');
  });

  it('since 过滤：含当天及之后（含 = 闭区间）', async () => {
    await seedGame({ uid: 'uid-old', exported: '2026-10-02T03:00:00.000Z' });
    await seedGame({ uid: 'uid-mid', exported: '2026-10-04T03:00:00.000Z' });
    await seedGame({ uid: 'uid-new', exported: '2026-10-06T03:00:00.000Z' });

    const res = await getExport('since=2026-10-04');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="jev-games-2026-10-04.jsonl"');
    const rows = await readJsonl(res);
    expect(rows.map((r) => r.gameUid)).toEqual(['uid-new', 'uid-mid']);
    expect(rows.every((r) => (r.day as string) >= '2026-10-04')).toBe(true);
  });

  it('game 过滤：命中棋种 id，不匹配的淘汰；非法棋种 400', async () => {
    await seedGame({ uid: 'uid-gomoku', exported: '2026-10-02T03:00:00.000Z' });
    await seedGame({ uid: 'uid-go', exported: '2026-10-02T04:00:00.000Z', gameId: 'go', notation: 'q16,' });

    const rows = await readJsonl(await getExport('game=go'));
    expect(rows.map((r) => r.gameUid)).toEqual(['uid-go']);

    const bad = await getExport('game=not-a-game');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('bad_request');
  });

  it('非法参数 400：坏日期、day 与 since 同时给、坏设备号', async () => {
    expect((await getExport('day=2026-1-2')).status).toBe(400);
    expect((await getExport('since=notaday')).status).toBe(400);

    const conflict = await getExport('day=2026-10-02&since=2026-10-01');
    expect(conflict.status).toBe(400);
    expect(((await conflict.json()) as { error: string }).error).toContain('冲突');

    const badDevice = await getExport('', { headers: { 'x-device-id': '有中文' } });
    expect(badDevice.status).toBe(400);
  });

  it('全量导出时带合法 X-Device-Id 不改变结果（导出是全集，不按设备过滤）', async () => {
    await env.DB.prepare(
      `INSERT INTO devices (device_id, first_seen, last_seen, ua, label) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('device-001', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 'vitest', null)
      .run();
    await insertGame(env.DB, {
      gameUid: 'uid-with-device',
      createdAt: '2026-10-02T03:00:00.000Z',
      game: '五子棋',
      gameId: 'gomoku',
      notation: 'h8,',
      payload: { format: 'jev-qiguan-game/v1', exported: '2026-10-02T03:00:00.000Z', notation: 'h8,' },
      moves: [{ notation: 'h8', side: '黑方' }],
      deviceId: 'device-001',
    });

    const rows = await readJsonl(await getExport('', { headers: { 'x-device-id': 'device-001' } }));
    expect(rows).toHaveLength(1);
    expect(rows[0].deviceId).toBe('device-001');
  });
});

describe('parseExportParams / exportFilename（纯函数）', () => {
  const q = (params: Record<string, string>) => ({
    get: (name: string) => params[name],
  });

  it('缺省全为 null；给定值原样透传', () => {
    const empty = parseExportParams(q({}));
    expect(empty.ok && empty.value.day === null && empty.value.since === null && empty.value.gameId === null).toBe(
      true,
    );

    const filled = parseExportParams(q({ day: '2026-10-02', game: 'go' }));
    expect(filled.ok && filled.value.day === '2026-10-02' && filled.value.gameId === 'go').toBe(true);
    expect(filled.ok && exportFilename(filled.value)).toBe('jev-games-2026-10-02.jsonl');

    const since = parseExportParams(q({ since: '2026-10-01' }));
    expect(since.ok && exportFilename(since.value)).toBe('jev-games-2026-10-01.jsonl');
  });
});
