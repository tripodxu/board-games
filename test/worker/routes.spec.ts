/**
 * 对局端点契约（计划 §5.1 / §5.4 / §5.5，`src/worker/routes/games.ts`）。
 *
 * 全部走 `SELF.fetch`（真 workerd + 真 D1 + 真中间件链），不直调 handler：
 * 限流、设备中间件、幂等外键这几条恰恰是「只有走完整链路才会暴露」的。
 * 每个用例前清空 `rate_limits`，否则同一文件里累计的请求会撞上 20/分的写限流。
 */
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

/** 一局 5 手的五子棋（黑先），字段与真实归档同构，但故意**不带** gameUid/winner/gameId。 */
function gomokuPayload(overrides: Record<string, unknown> = {}) {
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
      ai: { ch: 'jev', mdl: 'v9', conf: 0.8, p: 0.7, rank: 1, cands: 12, ms: 900, tv: 9 },
    })),
    meta: { code: '0.8.0', topK: 4, seed: 's42', aiMoves: 3, conf: 0.75, tactics: { vcf: 2 } },
    cal: [0.5, 0.6, 0.7],
    firstWin: true,
    ...overrides,
  };
}

function post(payload: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch('https://example.com/api/games', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

async function countGames(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM games').first<{ n: number }>();
  return row?.n ?? 0;
}

async function countMoves(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM game_moves').first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  // worker project 是 singleWorker 且**不做逐用例存储隔离**（vitest.config.ts），
  // 所以每个用例自己把库清干净：顺序无关、也不受其他 spec 文件影响。
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_moves'),
    env.DB.prepare('DELETE FROM games'),
    env.DB.prepare('DELETE FROM experiments'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM rate_limits'),
  ]);
});

describe('POST /api/games', () => {
  it('旧客户端（无 gameUid）也能落库，并返回 id/gameUid/dedup/path', async () => {
    const res = await post(gomokuPayload());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      id: number;
      gameUid: string;
      dedup: boolean;
      movesWritten: number;
      path: string;
    };
    expect(body.ok).toBe(true);
    expect(body.dedup).toBe(false);
    expect(body.movesWritten).toBe(5);
    // §5.4：旧客户端合成的 game_uid = sha1(exported|notation)[:16]
    expect(body.gameUid).toMatch(/^[0-9a-f]{16}$/);
    expect(body.path).toBe(`games/2026-10-02/gomoku-${body.gameUid.slice(0, 8)}.json`);

    const row = await env.DB.prepare(
      `SELECT game, game_id, day, mode, winner, end_reason, move_count, opening_prefix,
              payload_bytes, source, device_id, mock, first_win, code_version, tactics_hist
       FROM games WHERE id = ?`,
    )
      .bind(body.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      game: '五子棋',
      game_id: 'gomoku',
      day: '2026-10-02',
      winner: 'black',
      end_reason: '五连',
      move_count: 5,
      opening_prefix: 'h8,i9,h9,i10',
      source: 'worker',
      device_id: null,
      mock: 0,
      first_win: 1,
      code_version: '0.8.0',
    });
    // payload 由 insertGame 重新序列化：字节数必须与落库文本一致（不是原始请求体长度）
    expect(row?.payload_bytes).toBeGreaterThan(100);

    const moves = await env.DB.prepare('SELECT ply, side, notation, channel, model, tactics FROM game_moves WHERE game_id = ? ORDER BY ply')
      .bind(body.id)
      .all<{ ply: number; side: string; notation: string; channel: string; model: string; tactics: string | null }>();
    expect(moves.results.map((m) => m.side)).toEqual(['black', 'white', 'black', 'white', 'black']);
    expect(moves.results.map((m) => m.notation)).toEqual(['h8', 'i9', 'h9', 'i10', 'h10']);
    expect(moves.results[0]).toMatchObject({ channel: 'jev', model: 'v9', tactics: null });
  });

  it('带 X-Device-Id 时先建设备行（外键），并写入 games.device_id', async () => {
    const deviceId = 'test-device-0001';
    const res = await post(gomokuPayload({ exported: '2026-10-02T04:00:00.000Z' }), { 'x-device-id': deviceId });
    expect(res.status).toBe(200);

    const device = await env.DB.prepare('SELECT device_id, last_seen, ua FROM devices WHERE device_id = ?')
      .bind(deviceId)
      .first<{ device_id: string; last_seen: string; ua: string | null }>();
    expect(device?.device_id).toBe(deviceId);

    const game = await env.DB.prepare('SELECT device_id FROM games ORDER BY id DESC LIMIT 1').first<{ device_id: string }>();
    expect(game?.device_id).toBe(deviceId);
  });

  it('重传同一 payload 幂等：dedup=true、不新增行、不重复写手', async () => {
    const payload = gomokuPayload({ exported: '2026-10-02T05:00:00.000Z' });
    const first = (await (await post(payload)).json()) as { id: number; gameUid: string };
    const before = await countGames();

    const res = await post(payload);
    expect(res.status).toBe(200);
    const second = (await res.json()) as { dedup: boolean; id: number; gameUid: string; movesWritten: number };
    expect(second.dedup).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.gameUid).toBe(first.gameUid);
    expect(second.movesWritten).toBe(0);
    expect(await countGames()).toBe(before);

    const moves = await env.DB.prepare('SELECT COUNT(*) AS n FROM game_moves WHERE game_id = ?')
      .bind(first.id)
      .first<{ n: number }>();
    expect(moves?.n).toBe(5);
  });

  it('显式 gameUid 被采信（新前端路径）', async () => {
    const res = await post(
      gomokuPayload({ exported: '2026-10-02T06:00:00.000Z', gameUid: 'uid-from-client-1' }),
    );
    const body = (await res.json()) as { gameUid: string };
    expect(body.gameUid).toBe('uid-from-client-1');
  });

  it('校验失败给 4xx 且 code 明确', async () => {
    const badJson = await post('{not json');
    expect(badJson.status).toBe(400);
    expect((await badJson.json() as { code: string }).code).toBe('bad_request');

    const wrongFormat = await post(gomokuPayload({ format: 'other/v1' }));
    expect(wrongFormat.status).toBe(422);
    expect((await wrongFormat.json() as { code: string }).code).toBe('invalid_payload');

    const mismatch = await post(gomokuPayload({ notation: 'h8,i9,' }));
    expect(mismatch.status).toBe(422);

    const noExported = await post(gomokuPayload({ exported: undefined }));
    expect(noExported.status).toBe(422);

    const emptyMoves = await post(gomokuPayload({ moves: [], notation: '' }));
    expect(emptyMoves.status).toBe(422);

    // 非法设备标识：中间件在进业务前就挡掉
    const badDevice = await post(gomokuPayload(), { 'x-device-id': '有中文' });
    expect(badDevice.status).toBe(400);
    expect((await badDevice.json() as { code: string }).code).toBe('bad_request');
  });

  /* 413 之前只有 core 级断言（直调 parseGamePayload），这里补**真链路**那一条：
   * 限流 + 设备中间件 + 读体 + 校验 + 落库 全在链上，才谈得上「被拒 = 没写库」。
   * 刻意发一个**形状完全合法**的体：payload 就是上面那局 5 手棋，只把一个真实存在的
   * 字符串字段（experiment，归档里就有）撑到 600KB。发垃圾字节会走 400 bad_request，
   * 那这条用例就根本碰不到 413 分支了。 */
  it('超过 512KB 的合法 payload：413 payload_too_large 且一行都没写', async () => {
    const gamesBefore = await countGames();
    const movesBefore = await countMoves();

    const payload = gomokuPayload({ experiment: 'x'.repeat(600 * 1024) });
    const body = JSON.stringify(payload);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(512 * 1024);

    const res = await SELF.fetch('http://example.com/api/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Device-Id': 'test-device-413' },
      body,
    });

    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/json');
    const err = (await res.json()) as { error: string; code: string; requestId: string | null };
    expect(err.code).toBe('payload_too_large');
    // 上限值本身也钉住：524288 = 512*1024，静默放宽上限必须在这里红
    expect(err.error).toContain('524288');
    expect(typeof err.requestId).toBe('string');

    // 413 是「整条拒绝」，不是「写一半才发现太大」
    expect(await countGames()).toBe(gamesBefore);
    expect(await countMoves()).toBe(movesBefore);

    /* 反证夹具没坏：同一局棋（去掉那个超长字段）能正常入库 —— 说明上一条被拒是
     * 因为**体积**，不是因为形状。这条要是红了，红的是夹具而不是 413。 */
    const okRes = await post(gomokuPayload({ exported: '2026-10-07T00:00:00.000Z' }), { 'X-Device-Id': 'test-device-413' });
    expect(okRes.status).toBe(200);
    expect(await countGames()).toBe(gamesBefore + 1);
  });
});

describe('GET /api/games', () => {
  async function seed(n: number) {
    for (let i = 0; i < n; i++) {
      const notations = ['h8', 'i9', 'h9', `i${10 + i}`, `h${10 + i}`];
      const res = await post(
        gomokuPayload({
          exported: `2026-10-0${(i % 3) + 2}T0${i % 10}:00:00.000Z`,
          gameUid: `seed-uid-${i}`,
          notation: notations.join(',') + ',',
          moves: notations.map((notation, ply) => ({ ply: ply + 1, side: ply % 2 === 0 ? '白方' : '黑方', notation })),
        }),
      );
      expect(res.status).toBe(200);
    }
    await env.DB.prepare('DELETE FROM rate_limits').run(); // 种子写入会消耗写限流桶
  }

  it('keyset 翻页不重不漏，且带旧字段别名', async () => {
    await seed(5);
    const first = (await (await SELF.fetch('https://example.com/api/games?limit=2')).json()) as {
      ok: boolean;
      games: { id: number; day: string; name: string; path: string; size: number; gameUid: string }[];
      nextCursor: number | null;
    };
    expect(first.ok).toBe(true);
    expect(first.games).toHaveLength(2);
    expect(first.games[0].id).toBeGreaterThan(first.games[1].id); // 倒序
    expect(first.games[0].name).toMatch(/^gomoku-.+\.json$/);
    expect(first.games[0].path).toBe(`games/${first.games[0].day}/${first.games[0].name}`);
    expect(first.games[0].size).toBeGreaterThan(0);
    expect(first.games[0]).not.toHaveProperty('payload');

    const second = (await (
      await SELF.fetch(`https://example.com/api/games?limit=2&cursor=${first.nextCursor}`)
    ).json()) as { games: { id: number }[]; nextCursor: number | null };
    const ids = [...first.games.map((g) => g.id), ...second.games.map((g) => g.id)];
    expect(new Set(ids).size).toBe(4);

    const third = (await (
      await SELF.fetch(`https://example.com/api/games?limit=2&cursor=${second.nextCursor}`)
    ).json()) as { games: unknown[]; nextCursor: number | null };
    expect(third.games).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });

  it('支持 since / game 过滤，非法棋种 400', async () => {
    await seed(3);
    const since = (await (await SELF.fetch('https://example.com/api/games?since=2026-10-04')).json()) as {
      games: { day: string }[];
    };
    expect(since.games.length).toBeGreaterThan(0);
    expect(since.games.every((g) => g.day >= '2026-10-04')).toBe(true);

    const badGame = await SELF.fetch('https://example.com/api/games?game=not-a-game');
    expect(badGame.status).toBe(400);

    const badLimit = await SELF.fetch('https://example.com/api/games?limit=0');
    expect(badLimit.status).toBe(400);

    // 形状合法但日历上不存在的日期必须 400：否则它会静默退化成「不过滤」。
    for (const bad of ['2026-13-01', '2026-02-30', '2026-1-1']) {
      const res = await SELF.fetch(`https://example.com/api/games?since=${bad}`);
      expect(res.status, bad).toBe(400);
    }

    const meWithoutDevice = await SELF.fetch('https://example.com/api/games?device=me');
    expect(meWithoutDevice.status).toBe(400);
  });
});

describe('GET /api/games 详情', () => {
  it('/u/:gameUid 返回 payload 原文并补 gameUid，未知 uid 给 JSON 404', async () => {
    await post(gomokuPayload({ exported: '2026-10-05T00:00:00.000Z', slug: 'jev-vs-rapfi' }));
    await env.DB.prepare('DELETE FROM rate_limits').run();

    const missing = await SELF.fetch('https://example.com/api/games/u/0000000000000000');
    expect(missing.status).toBe(404);
    expect((await missing.json() as { code: string }).code).toBe('not_found');

    const list = (await (await SELF.fetch('https://example.com/api/games?limit=1')).json()) as {
      games: { gameUid: string; day: string; slug: string | null; name: string }[];
    };
    const target = list.games[0];
    const detail = await SELF.fetch(`https://example.com/api/games/u/${target.gameUid}`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get('x-game-uid')).toBe(target.gameUid);
    const body = (await detail.json()) as { gameUid: string; notation: string; moves: unknown[] };
    expect(body.gameUid).toBe(target.gameUid);
    expect(body.moves).toHaveLength(5);
    expect(body.notation).toBe('h8,i9,h9,i10,h10,');

    // 列表给出的 path 必须能被旧详情路由取回（同一个服务自己保证闭环）
    const byName = await SELF.fetch(`https://example.com/api/games/${target.day}/${target.name}`);
    expect(byName.status).toBe(200);
    expect((await byName.json() as { gameUid: string }).gameUid).toBe(target.gameUid);
  });

  it('/:day/:name 兼容带 .json 的旧文件名，未知给 JSON 404', async () => {
    await post(gomokuPayload({ exported: '2026-10-06T00:00:00.000Z', slug: 'legacy-name' }));
    await env.DB.prepare('DELETE FROM rate_limits').run();

    const list = (await (await SELF.fetch('https://example.com/api/games?limit=1')).json()) as {
      games: { name: string; day: string }[];
    };
    const { day, name } = list.games[0];
    expect(name.startsWith('legacy-name-')).toBe(true);

    const ok = await SELF.fetch(`https://example.com/api/games/${day}/${name}`);
    expect(ok.status).toBe(200);

    const bare = await SELF.fetch(`https://example.com/api/games/${day}/${name.replace(/\.json$/, '')}`);
    expect(bare.status).toBe(200);

    const missing = await SELF.fetch(`https://example.com/api/games/${day}/nope-00000000.json`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');

    const badDay = await SELF.fetch('https://example.com/api/games/notaday/x.json');
    expect(badDay.status).toBe(400);
  });
});

describe('GET /api/health', () => {
  it('报告 device 语义位', async () => {
    const without = (await (await SELF.fetch('https://example.com/api/health')).json()) as { device: boolean };
    expect(without.device).toBe(false);

    const withDevice = await (
      await SELF.fetch('https://example.com/api/health', { headers: { 'x-device-id': 'test-device-0002' } })
    ).json() as { device: boolean };
    expect(withDevice.device).toBe(true);
  });
});

describe('未知 /api/*', () => {
  /* 回归：请求 id 中间件曾经挂在 api 子应用上，而兜底 404 由 app 层处理 ——
   * 一条业务子路由都没命中的请求不经过子应用中间件，于是只有这一个分支返回
   * `requestId: null`（线上实测 /api/nope）。其余错误体都带 id，排障时对不上号。 */
  it('JSON 404 且带 requestId / X-Request-Id', async () => {
    const res = await SELF.fetch('https://example.com/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as { code: string; requestId: string | null };
    expect(body.code).toBe('not_found');
    expect(typeof body.requestId).toBe('string');
    expect((body.requestId ?? '').length).toBeGreaterThan(0);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });
});
