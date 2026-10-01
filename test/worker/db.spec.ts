/**
 * D1 数据访问层测试：跑在真 workerd + 真 D1 上（pool-workers），setup.ts 已重放
 * migrations/0001_init.sql。
 *
 * 为什么一个文件全测完：这些用例共享同一个库实例（每个测试文件一份隔离存储），
 * beforeEach 里整表清空比拆文件更省时间，也让「跨表一致性」（幂等写入 + 逐手明细 +
 * 级联删除）能在同一个事务上下文里断言。
 *
 * 这里所有 SQL 都真实执行过——包括 stats 的四段聚合、限流那条 upsert、
 * experiments 的 RETURNING 别名与 devices 的 MAX(last_seen)。
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PAYLOAD_BYTES,
  getDevice,
  getGame,
  getStats,
  hitRateLimit,
  insertGame,
  listExperiments,
  listGames,
  parseExperimentGames,
  parseGamePayload,
  pruneRateLimits,
  touchDevice,
  upsertExperiment,
  windowStartOf,
} from '../../src/worker/db/index.ts';
import type { GameInput, GameMoveInput, GameRef } from '../../src/worker/db/index.ts';

/** 每个用例从空库开始：同一文件的用例共享一个 D1 实例。 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_moves'),
    env.DB.prepare('DELETE FROM games'),
    env.DB.prepare('DELETE FROM experiments'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM rate_limits'),
  ]);
});

async function countRows(
  table: 'games' | 'game_moves' | 'experiments' | 'devices' | 'rate_limits',
): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

function move(notation: string, extra: Partial<GameMoveInput> = {}): GameMoveInput {
  return { notation, side: '黑方', ...extra };
}

/** 与 `src/shared/record-map.ts`（P4）产出的形状一致的最小输入。 */
function gameInput(overrides: Partial<GameInput> = {}): GameInput {
  return {
    gameUid: 'uid-A',
    createdAt: '2026-09-30T02:53:50.731Z',
    game: '五子棋',
    gameId: 'gomoku',
    notation: 'H8,H7,I8',
    payload: { format: 'jev-qiguan-game/v1', moves: [{ notation: 'H8' }] },
    moves: [move('H8'), move('H7', { side: '白方' }), move('I8')],
    ...overrides,
  };
}

/**
 * `games.device_id` 有外键指向 `devices(device_id)`，而 D1 默认强制外键，
 * 所以「某设备提交的对局」必须先有设备行——这正是路由必须先 touchDevice 的原因。
 * fixture 显式建行，免得这条真实约束被测试悄悄绕过去。
 */
async function seedDevices(...deviceIds: string[]): Promise<void> {
  for (const deviceId of deviceIds) {
    await touchDevice(env.DB, { deviceId, at: '2026-09-01T00:00:00.000Z' });
  }
}

async function mustGetGame(ref: GameRef) {
  const game = await getGame(env.DB, ref);
  if (!game) throw new Error(`详情未命中：${JSON.stringify(ref)}`);
  return game;
}

async function moveRows(): Promise<{ ply: number; side: string; notation: string }[]> {
  const result = await env.DB.prepare(
    'SELECT ply, side, notation FROM game_moves ORDER BY game_id ASC, ply ASC',
  ).all<{ ply: number; side: string; notation: string }>();
  return result.results ?? [];
}

describe('insertGame：派生列与幂等', () => {
  it('新局落库时派生 day / opening_prefix / payload_bytes / move_count 并写逐手明细', async () => {
    const input = gameInput({
      // UTC 已是 9-30，本地是 10-01（东八区）：day 必须按 UTC 取，否则跨日归属会错
      createdAt: '2026-09-30T23:30:00.000Z',
      payload: { format: 'jev-qiguan-game/v1', note: '中文载荷' },
      moves: [move('H8'), move('H7', { side: '白方' }), move('I8'), move('G8'), move('H9')],
      deviceId: 'dev-1',
    });
    await seedDevices('dev-1'); // device_id 外键要求设备行先存在
    const result = await insertGame(env.DB, input);

    expect(result.dedup).toBe(false);
    expect(result.movesWritten).toBe(5);
    expect(result.game.day).toBe('2026-09-30');
    expect(result.game.openingPrefix).toBe('H8,H7,I8,G8'); // 只取前 4 手
    expect(result.game.moveCount).toBe(5);
    expect(result.game.notation).toBe(input.notation);
    expect(result.game.source).toBe('worker');
    // payload_bytes 是 UTF-8 字节数，中文载荷下必然大于字符数
    const serialized = JSON.stringify(input.payload);
    expect(result.game.payloadBytes).toBe(new TextEncoder().encode(serialized).length);
    expect(result.game.payloadBytes).toBeGreaterThan(serialized.length);

    // 逐手明细：ply 从 1 递增，中文方名落库前归一
    expect(await moveRows()).toEqual([
      { ply: 1, side: 'black', notation: 'H8' },
      { ply: 2, side: 'white', notation: 'H7' },
      { ply: 3, side: 'black', notation: 'I8' },
      { ply: 4, side: 'black', notation: 'G8' },
      { ply: 5, side: 'black', notation: 'H9' },
    ]);

    const detail = await mustGetGame({ gameUid: 'uid-A' });
    expect(parseGamePayload(detail)).toEqual(input.payload); // payload 保真回放
    expect(detail.moves).toHaveLength(5);
    expect(detail.moves[0]?.side).toBe('black');
  });

  it('0 手时 opening_prefix 为 NULL，不足 4 手时取实际长度', async () => {
    const empty = await insertGame(env.DB, gameInput({ gameUid: 'uid-empty', moves: [] }));
    expect(empty.game.openingPrefix).toBeNull();
    expect(empty.game.moveCount).toBe(0);
    expect(empty.movesWritten).toBe(0);
    expect(await countRows('game_moves')).toBe(0);

    const short = await insertGame(env.DB, gameInput({ gameUid: 'uid-short' }));
    expect(short.game.openingPrefix).toBe('H8,H7,I8');
  });

  it('手数超过单批上限时分块写明细，ply 仍连续', async () => {
    // 500 是 MOVES_PER_BATCH：长棋（围棋 300+ 手）会跨批，逐手 ply 与主行 move_count 必须对得上
    const many = Array.from({ length: 501 }, (_, i) => move(`M${i}`, { side: i % 2 === 0 ? '黑方' : '白方' }));
    const input = gameInput({
      gameUid: 'uid-long',
      notation: many.map((m) => m.notation).join(','),
      moves: many,
    });
    const result = await insertGame(env.DB, input);
    expect(result.movesWritten).toBe(501);
    expect(result.game.moveCount).toBe(501);

    const agg = await env.DB.prepare(
      'SELECT COUNT(*) AS n, MIN(ply) AS lo, MAX(ply) AS hi FROM game_moves',
    ).first<{ n: number; lo: number; hi: number }>();
    expect(agg).toEqual({ n: 501, lo: 1, hi: 501 });
  });

  it('dedup_key 缺省时由 sha1(createdAt|gameUid|notation) 生成，且重传命中同一行', async () => {
    const input = gameInput();
    const first = await insertGame(env.DB, input);
    const stored = await env.DB.prepare('SELECT dedup_key AS k FROM games WHERE game_uid = ?')
      .bind('uid-A')
      .first<{ k: string }>();
    const expected = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(`${input.createdAt}|${input.gameUid}|${input.notation}`),
    );
    const expectedHex = Array.from(new Uint8Array(expected))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(stored?.k).toBe(expectedHex);
    expect(stored?.k).toMatch(/^[0-9a-f]{40}$/);

    const again = await insertGame(env.DB, input);
    expect(again.dedup).toBe(true);
    expect(again.game.id).toBe(first.game.id);
    expect(await countRows('games')).toBe(1);
  });

  it('同 dedup_key 第二次提交：返回既有行，不覆盖 payload 与派生列', async () => {
    const first = await insertGame(
      env.DB,
      gameInput({ dedupKey: 'dedup-1', mock: false, firstWin: true, payload: { v: 1 } }),
    );

    const second = await insertGame(
      env.DB,
      gameInput({
        // 同一个 dedup_key，但换了 uid / payload / 手数：都不得生效
        gameUid: 'uid-B',
        dedupKey: 'dedup-1',
        mock: true,
        firstWin: false,
        payload: { v: 2, extra: 'x'.repeat(64) },
        moves: [move('A1'), move('A2'), move('A3'), move('A4'), move('A5')],
      }),
    );

    expect(second.dedup).toBe(true);
    expect(second.game.id).toBe(first.game.id);
    expect(second.game.gameUid).toBe('uid-A'); // 先按 dedup_key 命中，game_uid 不动
    expect(second.game.payloadBytes).toBe(first.game.payloadBytes);
    expect(second.game.moveCount).toBe(first.game.moveCount);
    expect(second.game.openingPrefix).toBe(first.game.openingPrefix);
    expect(second.game.mock).toBe(false);
    expect(second.game.firstWin).toBe(true);
    expect(second.movesWritten).toBe(0);
    expect(await countRows('games')).toBe(1);
    expect(await countRows('game_moves')).toBe(3);
    expect(parseGamePayload(await mustGetGame({ gameUid: 'uid-A' }))).toEqual({ v: 1 });
  });

  it('同一 game_uid 换了导出时间戳（dedup_key 随之变）仍不重复插入，退到 game_uid 命中', async () => {
    const input = gameInput({ gameUid: 'uid-re', notation: 'H8', moves: [move('H8')] });
    const first = await insertGame(env.DB, input);
    expect(first.dedup).toBe(false);

    const again = await insertGame(
      env.DB,
      gameInput({
        gameUid: 'uid-re',
        createdAt: '2026-10-02T02:53:50.731Z', // 重新导出 → dedup_key 变了，但 game_uid 没变
        notation: 'H8',
        payload: { v: 2 },
        moves: [move('H8')],
      }),
    );
    expect(again.dedup).toBe(true);
    expect(again.game.id).toBe(first.game.id);
    expect(again.game.createdAt).toBe('2026-09-30T02:53:50.731Z'); // 既有行不被覆盖
    expect(again.game.day).toBe('2026-09-30');
    expect(again.movesWritten).toBe(0);
    expect(await countRows('games')).toBe(1);
    expect(parseGamePayload(await mustGetGame({ gameUid: 'uid-re' }))).toEqual(input.payload);
  });

  it('命中既有行但明细缺失时补写明细，主行仍不被覆盖', async () => {
    const input = gameInput({ dedupKey: 'dedup-repair' });
    const first = await insertGame(env.DB, input);
    await env.DB.prepare('DELETE FROM game_moves WHERE game_id = ?').bind(first.game.id).run();

    const second = await insertGame(env.DB, { ...input, payload: { changed: true } });
    expect(second.dedup).toBe(true);
    expect(second.movesWritten).toBe(3);
    expect(await countRows('game_moves')).toBe(3);
    expect(parseGamePayload(await mustGetGame({ gameUid: 'uid-A' }))).toEqual(input.payload);
  });

  it('不变量：createdAt 不可解析报 TypeError，payload 超限报 RangeError', async () => {
    await expect(insertGame(env.DB, gameInput({ createdAt: '不是时间' }))).rejects.toThrow(
      TypeError,
    );
    await expect(
      insertGame(
        env.DB,
        gameInput({ gameUid: 'uid-big', payload: { blob: 'a'.repeat(MAX_PAYLOAD_BYTES + 1) } }),
      ),
    ).rejects.toThrow(RangeError);
    expect(await countRows('games')).toBe(0);
  });
});

describe('game_moves 级联', () => {
  it('删除对局行时逐手明细随外键级联删除', async () => {
    const { game } = await insertGame(env.DB, gameInput());
    expect(await countRows('game_moves')).toBe(3);

    await env.DB.prepare('DELETE FROM games WHERE id = ?').bind(game.id).run();
    expect(await countRows('games')).toBe(0);
    expect(await countRows('game_moves')).toBe(0);
  });
});

describe('getGame 详情定位', () => {
  it('按 game_uid 或 day+slug 取详情（容忍 .json 后缀），未知引用返回 null', async () => {
    await insertGame(env.DB, gameInput({ slug: 'gomoku-20260930025350' }));

    const byUid = await mustGetGame({ gameUid: 'uid-A' });
    const bySlug = await mustGetGame({ day: '2026-09-30', slug: 'gomoku-20260930025350.json' });
    expect(bySlug.id).toBe(byUid.id);
    expect(bySlug.payload).toBe(byUid.payload);

    expect(await getGame(env.DB, { gameUid: 'uid-不存在' })).toBeNull();
    expect(await getGame(env.DB, { day: '2026-09-30', slug: '不存在' })).toBeNull();
    expect(await getGame(env.DB, { day: '2026-09-29', slug: 'gomoku-20260930025350' })).toBeNull();
  });
});

describe('listGames 过滤与游标分页', () => {
  /** 5 局覆盖 day / 棋种 / 设备 / 实验标签四个维度。 */
  async function seed(): Promise<void> {
    const rows: Partial<GameInput>[] = [
      { gameUid: 'g1', createdAt: '2026-09-29T10:00:00.000Z', deviceId: 'dev-1', experimentTag: 'exp-a' },
      { gameUid: 'g2', createdAt: '2026-09-30T10:00:00.000Z', deviceId: 'dev-1', experimentTag: 'exp-a' },
      { gameUid: 'g3', createdAt: '2026-09-30T11:00:00.000Z', deviceId: 'dev-2', experimentTag: 'exp-b' },
      { gameUid: 'g4', createdAt: '2026-10-01T10:00:00.000Z', game: '围棋', gameId: 'go', deviceId: 'dev-1' },
      { gameUid: 'g5', createdAt: '2026-10-01T11:00:00.000Z', deviceId: 'dev-3', experimentTag: 'exp-a' },
    ];
    await seedDevices('dev-1', 'dev-2', 'dev-3'); // device_id 外键要求设备行先存在
    for (const row of rows) {
      await insertGame(env.DB, gameInput({ ...row, notation: `H8,${row.gameUid}`, moves: [move('H8')] }));
    }
  }

  const uids = (page: { games: { gameUid: string }[] }) => page.games.map((g) => g.gameUid);

  it('默认按 id 倒序返回全部，且列表不含 payload', async () => {
    await seed();
    const page = await listGames(env.DB);
    expect(uids(page)).toEqual(['g5', 'g4', 'g3', 'g2', 'g1']);
    expect(page.nextCursor).toBeNull();
    expect(page.games[0]).not.toHaveProperty('payload');
    expect(page.games[0]?.openingPrefix).toBe('H8');
  });

  it('单条件过滤：day / gameId / deviceId / experimentTag', async () => {
    await seed();
    expect(uids(await listGames(env.DB, { day: '2026-09-30' }))).toEqual(['g3', 'g2']);
    expect(uids(await listGames(env.DB, { gameId: 'go' }))).toEqual(['g4']);
    expect(uids(await listGames(env.DB, { deviceId: 'dev-1' }))).toEqual(['g4', 'g2', 'g1']);
    expect(uids(await listGames(env.DB, { experimentTag: 'exp-a' }))).toEqual(['g5', 'g2', 'g1']);
  });

  it('多条件按 AND 叠加，且 limit 上限之外不会报错', async () => {
    await seed();
    expect(
      uids(
        await listGames(env.DB, {
          day: '2026-10-01',
          gameId: 'gomoku',
          deviceId: 'dev-3',
          experimentTag: 'exp-a',
        }),
      ),
    ).toEqual(['g5']);
    expect(uids(await listGames(env.DB, { day: '2026-10-01', gameId: 'gomoku', deviceId: 'dev-1' }))).toEqual([]);
    expect((await listGames(env.DB, { limit: 999 })).games).toHaveLength(5);
  });

  it('游标翻页不重不漏，末页 nextCursor 为 null', async () => {
    await seed();
    const first = await listGames(env.DB, { limit: 2 });
    expect(uids(first)).toEqual(['g5', 'g4']);
    expect(first.nextCursor).toBe(first.games[1]?.id);

    const second = await listGames(env.DB, { limit: 2, cursor: first.nextCursor ?? 0 });
    expect(uids(second)).toEqual(['g3', 'g2']);
    expect(second.nextCursor).toBe(second.games[1]?.id);

    const third = await listGames(env.DB, { limit: 2, cursor: second.nextCursor ?? 0 });
    expect(uids(third)).toEqual(['g1']);
    expect(third.nextCursor).toBeNull();

    // 游标可与过滤条件组合
    const filtered = await listGames(env.DB, { experimentTag: 'exp-a', limit: 1 });
    expect(uids(filtered)).toEqual(['g5']);
    expect(uids(await listGames(env.DB, { experimentTag: 'exp-a', limit: 1, cursor: filtered.nextCursor ?? 0 }))).toEqual(['g2']);
  });
});

describe('getStats：旧口径对齐 + SQL 侧聚合', () => {
  /**
   * 6 局样本，刻意覆盖口径的每个分支：
   * s1 黑胜（有效样本）/ s2 白胜（有效样本）/ s3 和棋（first_win 为 NULL，不入样本）
   * s4 mock 局（仍计入总数与胜负分布，但不入样本）/ s5 cal 不是数组 / s6 result 为空
   */
  async function seed(): Promise<void> {
    await seedDevices('dev-s', 'dev-other'); // device_id 外键要求设备行先存在
    await insertGame(env.DB, gameInput({
      gameUid: 's1', createdAt: '2026-09-29T10:00:00.000Z', deviceId: 'dev-s',
      notation: 'H8,H7,I8', result: '黑方 获胜（五连）', mock: false, firstWin: true, cal: [0.6, 0.7],
    }));
    await insertGame(env.DB, gameInput({
      gameUid: 's2', createdAt: '2026-09-30T10:00:00.000Z', deviceId: 'dev-s',
      notation: 'H8,H7,I7', result: '白方 获胜（五连）', mock: false, firstWin: false, cal: [0.4],
    }));
    await insertGame(env.DB, gameInput({
      gameUid: 's3', createdAt: '2026-09-30T11:00:00.000Z', deviceId: 'dev-s',
      notation: 'H8,H7,I9', result: '和棋', mock: false, firstWin: null, cal: [0.5],
    }));
    await insertGame(env.DB, gameInput({
      gameUid: 's4', createdAt: '2026-10-01T10:00:00.000Z', deviceId: 'dev-other',
      notation: 'H8,H7,I10', result: '黑方 获胜', mock: true, firstWin: true, cal: [0.9],
    }));
    await insertGame(env.DB, gameInput({
      gameUid: 's5', createdAt: '2026-10-01T11:00:00.000Z', deviceId: 'dev-s',
      game: '围棋', gameId: 'go', notation: 'D4,Q16', result: '白方 认输',
      mock: false, firstWin: true, cal: { 不是: '数组' },
    }));
    await insertGame(env.DB, gameInput({
      gameUid: 's6', createdAt: '2026-10-01T12:00:00.000Z', deviceId: 'dev-s',
      game: '围棋', gameId: 'go', notation: 'D4,Q17', result: '',
      mock: false, firstWin: true, // cal 不给 → cal_json 为 NULL
    }));
  }

  it('全局口径：total/byGame/results 计入 mock，样本只收 mock=0 且 first_win 有真值且 cal 是数组', async () => {
    await seed();
    const stats = await getStats(env.DB);

    expect(stats.totalGames).toBe(6); // 含 mock 局（旧实现不筛 mock）
    expect(stats.byGame).toEqual({ 五子棋: 4, 围棋: 2 }); // 键是棋种中文名
    expect(stats.results).toEqual({ black: 2, white: 2, draw: 1 }); // s4 算黑胜，s6 三项都不计

    expect(stats.cal.games).toBe(2);
    // key 前缀是**棋种 id**（game_id 列）不是 game_uid：这样才与旧实现的 `gid|notation`
    // 以及前端 `r.gid + '|' + r.notas.join(',')` 的去重键对得上（见 stats.ts 头注）。
    expect(stats.cal.records.map((r) => r.key)).toEqual(['gomoku|H8,H7,I7', 'gomoku|H8,H7,I8']);
    expect(stats.cal.records.map((r) => r.firstWin)).toEqual([false, true]);
    expect(stats.cal.records[1]?.cal).toEqual([0.6, 0.7]);
    // mock 局（s4）、first_win 为 NULL 的和棋（s3）、cal 非数组（s5）、cal 为 NULL（s6）都不在样本里
    expect(stats.cal.records.some((r) => r.key.startsWith('gomoku|H8,H7,I10'))).toBe(false);
  });

  it('过滤条件：deviceId / gameId / sinceDay 各自收窄，且过滤同样作用于样本', async () => {
    await seed();
    const byDevice = await getStats(env.DB, { deviceId: 'dev-s' });
    expect(byDevice.totalGames).toBe(5);
    expect(byDevice.byGame).toEqual({ 五子棋: 3, 围棋: 2 });
    expect(byDevice.results).toEqual({ black: 1, white: 2, draw: 1 });
    expect(byDevice.cal.games).toBe(2);

    const byGame = await getStats(env.DB, { gameId: 'go' });
    expect(byGame.totalGames).toBe(2);
    expect(byGame.byGame).toEqual({ 围棋: 2 });
    expect(byGame.results).toEqual({ black: 0, white: 1, draw: 0 });
    expect(byGame.cal.records).toEqual([]);

    const bySince = await getStats(env.DB, { sinceDay: '2026-10-01' });
    expect(bySince.totalGames).toBe(3);
    expect(bySince.results).toEqual({ black: 1, white: 1, draw: 0 });
    expect(bySince.cal.games).toBe(0);

    const combined = await getStats(env.DB, { deviceId: 'dev-s', gameId: 'gomoku', sinceDay: '2026-09-30' });
    expect(combined.totalGames).toBe(2);
    expect(combined.cal.records.map((r) => r.key)).toEqual(['gomoku|H8,H7,I7']);
  });

  it('空结果为 0 与 {}（SUM/COUNT 的 NULL 已被兜住），棋种名缺失归入 unknown', async () => {
    const empty = await getStats(env.DB);
    expect(empty).toEqual({
      totalGames: 0,
      byGame: {},
      results: { black: 0, white: 0, draw: 0 },
      cal: { games: 0, records: [] },
    });

    await insertGame(env.DB, gameInput({ gameUid: 'anon', game: '' }));
    const stats = await getStats(env.DB, { deviceId: 'none' });
    expect(stats.totalGames).toBe(0); // 过滤掉所有行，仍不抛错

    const all = await getStats(env.DB);
    expect(all.byGame).toEqual({ unknown: 1 });
  });
});

describe('devices', () => {
  it('touchDevice：首次插入、last_seen 单调前进、label/ua 不被 NULL 覆盖', async () => {
    const first = await touchDevice(env.DB, {
      deviceId: 'dev-x',
      at: '2026-09-30T10:00:00.000Z',
      ua: 'UA-1',
      label: '我的电脑',
    });
    expect(first).toEqual({
      deviceId: 'dev-x',
      firstSeen: '2026-09-30T10:00:00.000Z',
      lastSeen: '2026-09-30T10:00:00.000Z',
      label: '我的电脑',
      ua: 'UA-1',
    });

    const second = await touchDevice(env.DB, {
      deviceId: 'dev-x',
      at: '2026-10-01T10:00:00.000Z',
      ua: 'UA-2',
    });
    expect(second.firstSeen).toBe('2026-09-30T10:00:00.000Z'); // 首次时间不回写
    expect(second.lastSeen).toBe('2026-10-01T10:00:00.000Z');
    expect(second.label).toBe('我的电脑'); // 未给出 → 保留
    expect(second.ua).toBe('UA-2'); // 给出 → 覆盖

    const stale = await touchDevice(env.DB, { deviceId: 'dev-x', at: '2026-09-29T00:00:00.000Z' });
    expect(stale.lastSeen).toBe('2026-10-01T10:00:00.000Z'); // 乱序旧请求不让 last_seen 倒退
    expect(stale.ua).toBe('UA-2');

    expect(await getDevice(env.DB, 'dev-x')).toEqual(stale);
    expect(await getDevice(env.DB, '不存在')).toBeNull();
    expect(await countRows('devices')).toBe(1);
  });

  it('at 缺省时用当前时间，first_seen 与 last_seen 一致', async () => {
    const row = await touchDevice(env.DB, { deviceId: 'dev-y' });
    expect(Number.isFinite(Date.parse(row.firstSeen))).toBe(true);
    expect(row.lastSeen).toBe(row.firstSeen);
    expect(row.label).toBeNull();
  });
});

describe('ratelimit：固定窗口单一原子 SQL', () => {
  const WINDOW_MS = 60_000;
  const t0 = 1_700_000_000_000; // 固定时刻：跨窗口行为不能依赖真实时钟

  it('窗口内累加、超限 allowed=false、跨窗口自动重置', async () => {
    const bucket = 'write:1.2.3.4';
    const start = windowStartOf(t0, 60);
    const resetAt = start + 60;
    const endMs = resetAt * 1000; // 本窗口结束时刻（t0 落在窗口内，不一定是窗口起点）
    expect(start % 60).toBe(0); // 窗口起点按秒对齐

    const r1 = await hitRateLimit(env.DB, bucket, 3, 60, t0);
    expect(r1).toEqual({ allowed: true, count: 1, limit: 3, remaining: 2, resetAt });

    expect(await hitRateLimit(env.DB, bucket, 3, 60, t0)).toMatchObject({ allowed: true, count: 2, remaining: 1 });
    expect(await hitRateLimit(env.DB, bucket, 3, 60, t0)).toMatchObject({ allowed: true, count: 3, remaining: 0 });
    const over = await hitRateLimit(env.DB, bucket, 3, 60, t0);
    expect(over).toMatchObject({ allowed: false, count: 4, remaining: 0, resetAt });
    expect(await countRows('rate_limits')).toBe(1); // 同窗口只有一行

    // 窗口最后一毫秒仍累计，跨过窗口边界即落到新行
    expect(await hitRateLimit(env.DB, bucket, 3, 60, endMs - 1)).toMatchObject({ count: 5, allowed: false });
    const next = await hitRateLimit(env.DB, bucket, 3, 60, endMs);
    expect(next).toMatchObject({ allowed: true, count: 1, remaining: 2 });
    expect(next.resetAt).toBe(resetAt + 60);
    expect(await countRows('rate_limits')).toBe(2);

    // 不同 bucket 互不影响（键是 bucket + window_start）
    expect(await hitRateLimit(env.DB, 'read:1.2.3.4', 3, 60, t0)).toMatchObject({ count: 1, allowed: true });
    expect(await countRows('rate_limits')).toBe(3);
  });

  it('参数护栏与过期窗口清理', async () => {
    await expect(hitRateLimit(env.DB, '', 3, 60, t0)).rejects.toThrow(TypeError);
    await expect(hitRateLimit(env.DB, 'b', 0, 60, t0)).rejects.toThrow(RangeError);
    await expect(hitRateLimit(env.DB, 'b', 3, 0, t0)).rejects.toThrow(RangeError);

    await hitRateLimit(env.DB, 'old', 3, 60, t0);
    await hitRateLimit(env.DB, 'new', 3, 60, t0 + WINDOW_MS * 10);
    expect(await pruneRateLimits(env.DB, windowStartOf(t0, 60) + 60)).toBe(1);
    expect(await countRows('rate_limits')).toBe(1);
    expect(await pruneRateLimits(env.DB, 0)).toBe(0);
  });
});

describe('experiments：upsert 保留档位字段', () => {
  it('新建补 date 与空 games；更新时未给出的字段保留旧值', async () => {
    const created = await upsertExperiment(env.DB, {
      tag: 'exp-1',
      chanA: 'jev',
      chanB: 'rapfi',
      tacA: 'free',
      thinkA: 0.5,
      total: 9,
      note: '第一轮',
      games: [{ slug: 'a' }],
    });
    expect(created.tag).toBe('exp-1');
    expect(Number.isFinite(Date.parse(created.date))).toBe(true); // date 缺省由 SQLite 补
    expect(created.gamesJson).toBe('[{"slug":"a"}]');
    expect(created.tacA).toBe('free');
    expect(created.updatedAt).toBeTruthy();

    // 第二次提交刻意不带 tacA/thinkA/note/games：这些"丢了就读不出档位"的字段必须留下
    const updated = await upsertExperiment(env.DB, {
      tag: 'exp-1',
      date: '2026-10-01T00:00:00.000Z',
      chanA: 'jev',
      chanB: 'rapfi',
      total: 12,
    });
    expect(updated.date).toBe('2026-10-01T00:00:00.000Z');
    expect(updated.total).toBe(12);
    expect(updated.tacA).toBe('free');
    expect(updated.thinkA).toBe(0.5);
    expect(updated.note).toBe('第一轮');
    expect(updated.gamesJson).toBe('[{"slug":"a"}]');
    expect(updated.tag).toBe('exp-1');
    expect(await countRows('experiments')).toBe(1); // tag 是主键，不会插出第二行

    const replaced = await upsertExperiment(env.DB, {
      tag: 'exp-1',
      tacB: 'block',
      games: [{ slug: 'b' }, { slug: 'c' }],
    });
    expect(parseExperimentGames(replaced)).toEqual([{ slug: 'b' }, { slug: 'c' }]); // 给出即覆盖
    expect(replaced.tacA).toBe('free');
    expect(replaced.tacB).toBe('block');
    expect(replaced.date).toBe('2026-10-01T00:00:00.000Z');
    expect(replaced.total).toBe(12);
  });

  it('listExperiments 按 date 倒序并受 limit 约束；坏 games_json 退化成空数组', async () => {
    // 用「相对现在的未来时刻」而不是写死日期：date 缺省那条走 SQLite 的 now，
    // 写死过去的时间会让排序断言依赖跑测试的真实时钟。
    const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    await upsertExperiment(env.DB, { tag: 'a', date: soon(30) });
    await upsertExperiment(env.DB, { tag: 'b', date: soon(32) });
    await upsertExperiment(env.DB, { tag: 'c', date: soon(31) });
    const auto = await upsertExperiment(env.DB, { tag: 'd' }); // date 走 SQLite 默认值
    expect(Number.isFinite(Date.parse(auto.date))).toBe(true);

    expect((await listExperiments(env.DB)).map((r) => r.tag)).toEqual(['b', 'c', 'a', 'd']);
    expect((await listExperiments(env.DB, 2)).map((r) => r.tag)).toEqual(['b', 'c']);
    expect((await listExperiments(env.DB, 0)).length).toBe(1); // limit 下限被夹到 1

    expect(parseExperimentGames({ ...auto, gamesJson: '不是 JSON' })).toEqual([]);
    expect(parseExperimentGames({ ...auto, gamesJson: '{"a":1}' })).toEqual([]);
    expect(parseExperimentGames(auto)).toEqual([]); // 新建时 games 缺省 → '[]'
  });

  it('tag 为空时报 TypeError', async () => {
    await expect(upsertExperiment(env.DB, { tag: '' })).rejects.toThrow(TypeError);
    expect(await countRows('experiments')).toBe(0);
  });
});
