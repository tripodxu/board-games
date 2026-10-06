/**
 * 聚合端点契约（计划 §4.3 派生 SQL / §5.1 路由表 / §5.5 校验与错误码）：
 * `/api/stats`、`/api/openings`、`/api/leaderboard`、`/api/experiments`。
 *
 * ## 怎么打到真链路
 *
 * 用例一律经过真 workerd + 真 D1 + 真中间件（限流、设备校验、Hono 链），
 * 而不是直调 handler —— 「限流桶 / X-Device-Id 校验 / SQL 聚合」这几条恰恰只有走完整链路才暴露。
 *
 * 入口选择是自适应的（`resolveDriver()`）：
 *  - `src/worker/index.ts` 挂上了这四个路由 → 所有请求走 `SELF.fetch`（真入口，端到端）；
 *  - 还没挂（本文件写作时 `index.ts` 只挂了 health/games，挂载由编排者负责）→ 用一个**同构的**
 *    本地 Hono 应用把四个 route 挂到同样的 `/api/...` 路径上，仍然在 workerd 里、仍然经真中间件，
 *    并用真 D1 binding（`env`）注入 `c.env`。
 * 这样本文件在「挂载前」是绿的、在「挂载后」自动升级成端到端，不需要改一行测试。
 *
 * ## 种子数据
 *
 * 全部用 `env.DB` 直插（表结构与 migrations/0001_init.sql 对齐），7 局覆盖：
 * mock / 和棋(winner NULL) / 认输 / first_win 三态 / 坏 cal_json / 无 opening_prefix /
 * 渠道与战术档的两侧组合 / 两台设备。每个用例前整表清空（含 rate_limits，否则同一文件
 * 累计的读请求会撞上 120/分）。
 */
import { SELF, env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorBody, jsonNotFound } from '../../src/worker/lib/http.ts';
import { experimentsRoute } from '../../src/worker/routes/experiments.ts';
import { leaderboardRoute } from '../../src/worker/routes/leaderboard.ts';
import { openingsRoute } from '../../src/worker/routes/openings.ts';
import { statsRoute } from '../../src/worker/routes/stats.ts';
import type { AppEnv } from '../../src/worker/types.ts';

/* ------------------------------------------------------------------ 驱动 */

/** 与 `src/worker/index.ts` 的挂载方式逐字同构：同一个 /api 前缀、同一份 requestId 中间件。 */
const api = new Hono<AppEnv>();
api.use('*', async (c, next) => {
  const requestId =
    c.req.header('cf-ray') ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});
api.route('/experiments', experimentsRoute);
api.route('/stats', statsRoute);
api.route('/openings', openingsRoute);
api.route('/leaderboard', leaderboardRoute);

const localApp = new Hono<AppEnv>();
localApp.route('/api', api);
localApp.all('/api/*', (c) => jsonNotFound(c));
localApp.onError((err, c) => {
  console.error('[spec] unhandled', err instanceof Error ? err.stack : String(err));
  return c.json(errorBody('internal', '服务端异常', c.get('requestId')), 500);
});

let useRealEntry = false;

/** `SELF.fetch` 打不打得通由编排者是否挂载决定；结果只在这里判一次。 */
beforeAll(async () => {
  const probe = await SELF.fetch('https://example.com/api/stats');
  useRealEntry = probe.status !== 404;
});

async function call(path: string, init?: RequestInit): Promise<Response> {
  const url = `https://example.com${path}`;
  if (useRealEntry) return SELF.fetch(url, init);
  // Hono 的 request() 在类型上可能是同步返回（无 await 的中间件链），统一 await 掉两种形态
  return await localApp.request(url, init, env as AppEnv['Bindings']);
}

async function getJson<T>(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await call(path, { headers });
  return { status: res.status, body: (await res.json()) as T };
}

function postJson(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

/* -------------------------------------------------------------- 种子数据 */

const DEV_ALPHA = 'dev-alpha-0001';
const DEV_BETA = 'dev-beta-0002';

interface SeedGame {
  uid: string;
  day: string;
  game: string;
  gameId: string;
  mode: string | null;
  winner: string | null;
  result: string;
  firstWin: number | null;
  mock: number;
  /** 故意允许坏 JSON：`not-an-array` 用来验证 SQL 侧 `json_valid` 守卫 */
  calJson: string | null;
  opening: string | null;
  notation: string;
  device: string | null;
  blackChannel?: string | null;
  whiteChannel?: string | null;
  blackTactics?: string | null;
  whiteTactics?: string | null;
}

const SEEDS: SeedGame[] = [
  {
    // 黑胜 + 有 first_win + 有 cal：进校准样本，也进开局与渠道榜
    uid: 'g1',
    day: '2025-01-01',
    game: '五子棋',
    gameId: 'gomoku',
    mode: 'ai-ai',
    winner: 'black',
    result: '黑方 获胜（五连）',
    firstWin: 1,
    mock: 0,
    calJson: '[1,2,3]',
    opening: 'H8,H9,I8,I9',
    notation: 'H8,H9,I8,I9,J8',
    device: DEV_ALPHA,
    blackChannel: 'proxy',
    blackTactics: 'aggressive',
    whiteChannel: 'openrouter',
    whiteTactics: 'defensive',
  },
  {
    // mock=1：计入 totalGames/byGame/results，但不进 cal、不进开局榜、不进渠道榜
    uid: 'g2',
    day: '2025-01-02',
    game: '五子棋',
    gameId: 'gomoku',
    mode: 'ai-ai',
    winner: 'black',
    result: '黑方 获胜（认输）',
    firstWin: 1,
    mock: 1,
    calJson: '[9]',
    opening: 'H8,H9,I8,I9',
    notation: 'H8,H9,I8,I9',
    device: DEV_ALPHA,
    blackChannel: 'proxy',
    blackTactics: 'aggressive',
    whiteChannel: null,
    whiteTactics: null,
  },
  {
    // 和棋：winner IS NULL，但 result 里有「和棋」→ 旧口径（result 子串）判 draw；
    // first_win 为 NULL → 不进校准样本，但进开局胜率的分母
    uid: 'g3',
    day: '2025-01-03',
    game: '五子棋',
    gameId: 'gomoku',
    mode: 'ai-ai',
    winner: null,
    result: '和棋（重复局面）',
    firstWin: null,
    mock: 0,
    calJson: '[7]',
    opening: 'H8,H9,I8,J8',
    notation: 'H8,H9,I8,J8',
    device: DEV_ALPHA,
    blackChannel: 'openrouter',
    blackTactics: 'aggressive',
    whiteChannel: 'openrouter',
    whiteTactics: 'aggressive',
  },
  {
    // 人机 + 白胜 + first_win=0：mode 过滤与「首手方输」的样本
    uid: 'g4',
    day: '2025-01-04',
    game: '五子棋',
    gameId: 'gomoku',
    mode: 'human-ai',
    winner: 'white',
    result: '白方 获胜（认输）',
    firstWin: 0,
    mock: 0,
    calJson: '[4]',
    opening: 'H8,H10,I8,I10',
    notation: 'H8,H10,I8,I10',
    device: DEV_BETA,
    blackChannel: 'official',
    blackTactics: 'balanced',
    whiteChannel: 'proxy',
    whiteTactics: 'aggressive',
  },
  {
    // 象棋 + 「黑方 获胜（认输）」且非 mock：认输必须算黑胜（验收项 ③）
    uid: 'g5',
    day: '2025-01-05',
    game: '象棋',
    gameId: 'xiangqi',
    mode: 'ai-ai',
    winner: 'black',
    result: '黑方 获胜（认输）',
    firstWin: 1,
    mock: 0,
    calJson: '[]',
    opening: 'H2,E2',
    notation: 'H2,E2',
    device: DEV_ALPHA,
    blackChannel: 'proxy',
    blackTactics: 'balanced',
    whiteChannel: null,
    whiteTactics: null,
  },
  {
    // 国际象棋 + 坏 cal_json + 没有 opening_prefix（白方渠道为空 → 榜单兜 unknown）
    uid: 'g6',
    day: '2025-01-06',
    game: '国际象棋',
    gameId: 'chess',
    mode: 'pvp',
    winner: 'white',
    result: '白方 获胜（投子）',
    firstWin: null,
    mock: 0,
    calJson: 'not-an-array',
    opening: null,
    notation: '',
    device: DEV_BETA,
    blackChannel: null,
    blackTactics: null,
    whiteChannel: null,
    whiteTactics: null,
  },
  {
    // 与 g1 同开局、结果相反：让 'H8,H9,I8,I9' 凑到 HAVING >= 2，胜率正好 0.5
    uid: 'g7',
    day: '2025-01-07',
    game: '五子棋',
    gameId: 'gomoku',
    mode: 'ai-ai',
    winner: 'white',
    result: '白方 获胜（五连）',
    firstWin: 0,
    mock: 0,
    calJson: '[]',
    opening: 'H8,H9,I8,I9',
    notation: 'H8,H9,I8,I9',
    device: DEV_BETA,
    blackChannel: 'proxy',
    blackTactics: 'aggressive',
    whiteChannel: 'official',
    whiteTactics: 'balanced',
  },
];

async function seed(): Promise<void> {
  for (const device of [DEV_ALPHA, DEV_BETA]) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO devices (device_id, first_seen, last_seen) VALUES (?, ?, ?)',
    )
      .bind(device, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
      .run();
  }
  for (const g of SEEDS) {
    await env.DB.prepare(
      `INSERT INTO games
         (game_uid, dedup_key, created_at, day, game, game_id, mode, result, winner,
          move_count, notation, opening_prefix, black_channel, white_channel,
          black_tactics, white_tactics, mock, first_win, cal_json, device_id,
          payload, payload_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 2)`,
    )
      .bind(
        g.uid,
        `dedup-${g.uid}`,
        `${g.day}T00:00:00.000Z`,
        g.day,
        g.game,
        g.gameId,
        g.mode,
        g.result,
        g.winner,
        g.notation ? g.notation.split(',').length : 0,
        g.notation,
        g.opening,
        g.blackChannel ?? null,
        g.whiteChannel ?? null,
        g.blackTactics ?? null,
        g.whiteTactics ?? null,
        g.mock,
        g.firstWin,
        g.calJson,
        g.device,
      )
      .run();
  }
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_moves'),
    env.DB.prepare('DELETE FROM games'),
    env.DB.prepare('DELETE FROM experiments'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM rate_limits'),
  ]);
  await seed();
});

/* ------------------------------------------------------------------ 类型 */

interface StatsBody {
  ok: boolean;
  totalGames: number;
  byGame: Record<string, number>;
  results: { black: number; white: number; draw: number };
  cal: { games: number; records: { key: string; firstWin: boolean; cal: unknown[] }[] };
}

interface OpeningRow {
  opening: string;
  games: number;
  black_wins: number;
  white_wins: number;
  draws: number;
  black_win_rate: number;
}

interface OpeningSummary {
  opening: string;
  plies: number;
  games: number;
  black_wins: number;
  white_wins: number;
  draws: number;
  black_win_rate: number;
  enough: boolean;
}

interface OpeningsBody {
  ok: boolean;
  game: string;
  mode: string;
  plies: number | null;
  minGames: number;
  opening: string | null;
  summary: OpeningSummary | null;
  openings: OpeningRow[];
}

interface BoardRow {
  game: string;
  channel: string | null;
  tactics: string | null;
  device: string | null;
  side: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number | null;
}

interface BoardBody {
  ok: boolean;
  group: string;
  channel: string | null;
  device: string | null;
  rows: BoardRow[];
}

interface ExperimentEntry {
  tag: string;
  date: string;
  chanA: string | null;
  chanB: string | null;
  tacA: string | null;
  tacB: string | null;
  thinkA: number | null;
  thinkB: number | null;
  total: number;
  games: unknown[];
  note: string | null;
}

/* ------------------------------------------------------------ 挂载检查 */

describe('路由挂载（src/worker/index.ts）', () => {
  /* 这条用例保证「验收要求用 SELF.fetch 打全流程」这件事**当下真的成立**：
   * 四个路由一旦被编排者漏挂/改名，它立刻红，而不是悄悄退化成上面的自适应驱动。 */
  it('四个聚合路由都由真入口 /api/* 提供服务', async () => {
    const paths = [
      '/api/stats',
      '/api/experiments',
      '/api/openings?game=gomoku',
      '/api/leaderboard',
    ];
    for (const path of paths) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status, `${path} 未挂载或报错`).toBe(200);
    }
  });
});

/* ------------------------------------------------------------ /api/stats */

describe('GET /api/stats', () => {
  it('全局口径：mock 计入总数与胜负，但不进校准样本', async () => {
    const { status, body } = await getJson<StatsBody>('/api/stats');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    // 7 局全算（含 1 局 mock）：mock 只影响校准样本，不影响总量与胜负分布
    expect(body.totalGames).toBe(7);
    // byGame 的键是棋种**中文名**（旧响应口径），不是 game_id
    expect(body.byGame).toEqual({ 五子棋: 5, 象棋: 1, 国际象棋: 1 });
    // 黑胜 = g1 + g2(mock) + g5(认输)，白胜 = g4 + g6 + g7，和棋 = g3
    expect(body.results).toEqual({ black: 3, white: 3, draw: 1 });

    // 校准样本：mock 排除（g2）、first_win NULL 排除（g3/g6）、坏 cal_json 排除（g6）
    expect(body.cal.games).toBe(4);
    expect(body.cal.records.map((r) => r.key)).toEqual([
      'gomoku|H8,H9,I8,I9',
      'xiangqi|H2,E2',
      'gomoku|H8,H10,I8,I10',
      'gomoku|H8,H9,I8,I9,J8',
    ]);
    expect(body.cal.records.every((r) => Array.isArray(r.cal))).toBe(true);
    expect(body.cal.records.some((r) => r.key.startsWith('gomoku|H8,H9,I8,I9') && !r.firstWin)).toBe(true);
  });

  it('响应里绝不出现 truncated（§5.1 明确删除），也没有 Pages 版的 experiments 计数', async () => {
    const { body } = await getJson<Record<string, unknown>>('/api/stats');
    expect('truncated' in body).toBe(false);
    expect('experiments' in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['byGame', 'cal', 'ok', 'results', 'totalGames']);
  });

  it('scope=device 只看该设备的局', async () => {
    const { status, body } = await getJson<StatsBody>('/api/stats?scope=device', {
      'x-device-id': DEV_ALPHA,
    });
    expect(status).toBe(200);
    // alpha：g1、g2、g3、g5
    expect(body.totalGames).toBe(4);
    expect(body.byGame).toEqual({ 五子棋: 3, 象棋: 1 });
    expect(body.results).toEqual({ black: 3, white: 0, draw: 1 });
    expect(body.cal.games).toBe(2); // g1、g5（g2 mock、g3 first_win NULL）
  });

  it('game 与 since 过滤在 SQL 侧生效', async () => {
    const byGame = await getJson<StatsBody>('/api/stats?game=gomoku');
    expect(byGame.body.totalGames).toBe(5);
    expect(byGame.body.byGame).toEqual({ 五子棋: 5 });
    expect(byGame.body.results).toEqual({ black: 2, white: 2, draw: 1 });

    const since = await getJson<StatsBody>('/api/stats?since=2025-01-05');
    expect(since.body.totalGames).toBe(3); // g5、g6、g7
    expect(since.body.results).toEqual({ black: 1, white: 2, draw: 0 });

    const both = await getJson<StatsBody>('/api/stats?game=xiangqi&scope=device', {
      'x-device-id': DEV_ALPHA,
    });
    expect(both.body.totalGames).toBe(1);
    expect(both.body.byGame).toEqual({ 象棋: 1 });
  });

  it('空库返回全零而不是报错', async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM game_moves'), env.DB.prepare('DELETE FROM games')]);
    const { status, body } = await getJson<StatsBody>('/api/stats');
    expect(status).toBe(200);
    expect(body.totalGames).toBe(0);
    expect(body.byGame).toEqual({});
    expect(body.results).toEqual({ black: 0, white: 0, draw: 0 });
    expect(body.cal).toEqual({ games: 0, records: [] });
  });
});

/* --------------------------------------------------------- /api/openings */

describe('GET /api/openings', () => {
  it('按 opening_prefix 聚合并应用 HAVING >= min（§4.3 草案口径）', async () => {
    const { status, body } = await getJson<OpeningsBody>('/api/openings?game=gomoku');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.game).toBe('gomoku');
    expect(body.minGames).toBe(2);
    expect(body.plies).toBe(null);
    // 列表模式没有合并行（没有指定前缀就没有「合并」这回事）
    expect(body.summary).toBe(null);

    // mock 局（g2）与只打过 1 局的 'H8,H9,I8,J8' 都被 HAVING/WHERE 挡掉
    expect(body.openings).toEqual([
      {
        opening: 'H8,H9,I8,I9',
        games: 2,
        black_wins: 1,
        white_wins: 1,
        draws: 0,
        black_win_rate: 0.5,
      },
    ]);
  });

  it('min=1 放开样本下限，胜率分母含和棋（与 buildExperience 的 fw/n 一致）', async () => {
    const { body } = await getJson<OpeningsBody>('/api/openings?game=gomoku&min=1');
    expect(body.openings.map((o) => [o.opening, o.games])).toEqual([
      ['H8,H9,I8,I9', 2],
      ['H8,H10,I8,I10', 1],
      ['H8,H9,I8,J8', 1],
    ]);
    // 排序：games DESC, opening ASC —— 'H8,H10…' < 'H8,H9,I8,J8'（'1' < '9'）
    const drawOnly = body.openings.find((o) => o.opening === 'H8,H9,I8,J8');
    expect(drawOnly).toEqual({
      opening: 'H8,H9,I8,J8',
      games: 1,
      black_wins: 0,
      white_wins: 0,
      draws: 1,
      black_win_rate: 0,
    });
  });

  it('opening 前缀精确匹配：只按「整手」对齐，不吃字符串前缀的亏', async () => {
    // 精确到 4 手：mock 的 g2 不计入 → 2 局
    const full = await getJson<OpeningsBody>('/api/openings?game=gomoku&opening=H8,H9,I8,I9&min=1');
    expect(full.body.plies).toBe(4);
    expect(full.body.opening).toBe('H8,H9,I8,I9');
    expect(full.body.openings).toEqual([
      {
        opening: 'H8,H9,I8,I9',
        games: 2,
        black_wins: 1,
        white_wins: 1,
        draws: 0,
        black_win_rate: 0.5,
      },
    ]);
    expect(full.body.summary).toEqual({
      opening: 'H8,H9,I8,I9',
      plies: 4,
      games: 2,
      black_wins: 1,
      white_wins: 1,
      draws: 0,
      black_win_rate: 0.5,
      enough: true,
    });

    // 只给 2 手：分组键仍是 4 手整串 → 两行；合并值在 summary 里（g1/g3/g7 三局，1/3 ≈ 0.33）
    const short = await getJson<OpeningsBody>('/api/openings?game=gomoku&opening=H8,H9&min=1');
    expect(short.body.plies).toBe(2);
    expect(short.body.openings.map((o) => [o.opening, o.games])).toEqual([
      ['H8,H9,I8,I9', 2],
      ['H8,H9,I8,J8', 1],
    ]);
    expect(short.body.summary).toEqual({
      opening: 'H8,H9',
      plies: 2,
      games: 3,
      black_wins: 1,
      white_wins: 1,
      draws: 1,
      black_win_rate: 0.33,
      enough: true,
    });

    // 默认 min=2 时 summary 仍要给全量真值：'H8,H9,I8,J8' 只有 1 局会被 HAVING 挡掉，
    // 调用方若把 openings 各行相加就会得到 2 而不是 3 —— 这正是 summary 存在的理由
    const gated = await getJson<OpeningsBody>('/api/openings?game=gomoku&opening=H8,H9');
    expect(gated.body.openings.map((o) => o.opening)).toEqual(['H8,H9,I8,I9']);
    expect(gated.body.summary?.games).toBe(3);

    // 'H8,H1' 不是 'H8,H10' 的整手前缀（否则会把 H8,H10,… 误算进来）
    const partial = await getJson<OpeningsBody>('/api/openings?game=gomoku&opening=H8,H1&min=1');
    expect(partial.body.openings).toEqual([]);
    expect(partial.body.summary).toEqual({
      opening: 'H8,H1',
      plies: 2,
      games: 0,
      black_wins: 0,
      white_wins: 0,
      draws: 0,
      black_win_rate: 0,
      enough: false,
    });

    // 列只存前 4 手：查 4 手以上的前缀必然空（summary.enough=false 让调用方知道「别注入」）
    const tooDeep = await getJson<OpeningsBody>(
      '/api/openings?game=gomoku&opening=H8,H9,I8,I9,J8&min=1',
    );
    expect(tooDeep.body.openings).toEqual([]);
    expect(tooDeep.body.summary?.games).toBe(0);
    expect(tooDeep.body.summary?.enough).toBe(false);
  });

  it('mode 过滤与 since 时间窗', async () => {
    const human = await getJson<OpeningsBody>('/api/openings?game=gomoku&mode=human-ai&min=1');
    expect(human.body.mode).toBe('human-ai');
    expect(human.body.openings).toEqual([
      {
        opening: 'H8,H10,I8,I10',
        games: 1,
        black_wins: 0,
        white_wins: 1,
        draws: 0,
        black_win_rate: 0,
      },
    ]);

    const since = await getJson<OpeningsBody>('/api/openings?game=gomoku&since=2025-01-07&min=1');
    expect(since.body.openings.map((o) => o.opening)).toEqual(['H8,H9,I8,I9']);

    // 没记 opening_prefix 的局（g6）不会被当成空开局
    const chess = await getJson<OpeningsBody>('/api/openings?game=chess&min=1');
    expect(chess.body.openings).toEqual([]);
  });
});

/* ------------------------------------------------------ /api/leaderboard */

describe('GET /api/leaderboard', () => {
  it('默认按渠道 × 战术档 × 执子方聚合，mock 不计入', async () => {
    const { status, body } = await getJson<BoardBody>('/api/leaderboard');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.group).toBe('channel');
    // 6 局非 mock × 2 侧 = 12 条视角行，合并成 11 个分组（和棋那局两侧同组键只差 side）
    expect(body.rows).toHaveLength(11);

    // g1 黑胜 + g7 黑败（g2 同渠道同档但是 mock，必须不计入）→ 2 局 1 胜 1 负
    expect(body.rows[0]).toEqual({
      game: 'gomoku',
      channel: 'proxy',
      tactics: 'aggressive',
      device: null,
      side: 'black',
      games: 2,
      wins: 1,
      losses: 1,
      draws: 0,
      win_rate: 0.5,
    });

    // 胜负列摊平后：每一行都满足 games = wins + losses + draws
    for (const row of body.rows) {
      expect(row.games).toBe(row.wins + row.losses + row.draws);
    }
    // 和棋行胜率为 null（分母 0）而不是 NaN/0
    const onlyDraws = body.rows.filter((r) => r.draws === r.games);
    expect(onlyDraws.length).toBe(2); // g3 的黑白两个视角
    expect(onlyDraws.every((r) => r.win_rate === null)).toBe(true);
  });

  it('渠道为 NULL 的历史局兜成 unknown 一行，不会整局消失', async () => {
    // 迁移期导入的棋谱没有渠道字段（games/*.json 实测无 blackChan/whiteChan）
    const { body } = await getJson<BoardBody>('/api/leaderboard');
    const unknown = body.rows.filter((r) => r.channel === 'unknown');
    expect(unknown.map((r) => `${r.game}|${r.side}`).sort()).toEqual([
      'chess|black',
      'chess|white',
      'xiangqi|white',
    ]);
    expect(body.rows.some((r) => r.channel === null)).toBe(false);

    // 回传展示名 unknown 应拿回同一批行（NULL 的展示名与过滤值闭环）
    const filtered = await getJson<BoardBody>('/api/leaderboard?channel=unknown');
    expect(filtered.body.rows.map((r) => `${r.game}|${r.side}`)).toEqual(
      unknown.map((r) => `${r.game}|${r.side}`),
    );
    expect(filtered.body.rows.every((r) => r.channel === 'unknown')).toBe(true);
  });

  it('channel 过滤是「视角行级」的：只回该渠道自己那一侧', async () => {
    const proxy = await getJson<BoardBody>('/api/leaderboard?channel=proxy');
    // g1(黑)、g4(白)、g5(黑)、g7(黑) 四局里有 proxy 一侧，但只回 proxy 的行
    expect(proxy.body.rows.map((r) => `${r.game}|${r.channel}|${r.side}`)).toEqual([
      'gomoku|proxy|black',
      'gomoku|proxy|white',
      'xiangqi|proxy|black',
    ]);
    expect(proxy.body.rows.every((r) => r.channel === 'proxy')).toBe(true);
    expect(proxy.body.channel).toBe('proxy');
  });

  it('game / since 过滤', async () => {
    const chess = await getJson<BoardBody>('/api/leaderboard?game=chess');
    // 排序是 wins DESC，白方（g6 赢）在前；这里只关心两侧都在、且被 game 过滤到只剩国际象棋
    expect(chess.body.rows.map((r) => r.side).sort()).toEqual(['black', 'white']);
    expect(chess.body.rows.every((r) => r.game === 'chess')).toBe(true);

    const since = await getJson<BoardBody>('/api/leaderboard?since=2025-01-06');
    expect(since.body.rows.every((r) => r.game === 'chess' || r.game === 'gomoku')).toBe(true);
    expect(since.body.rows.some((r) => r.game === 'xiangqi')).toBe(false);
  });

  it('group=device 按设备聚合，且设备过滤走 device=me', async () => {
    const byDevice = await getJson<BoardBody>('/api/leaderboard?group=device');
    expect(byDevice.body.group).toBe('device');
    expect(byDevice.body.rows).toHaveLength(8);
    // alpha 的 g2 是 mock：不作过滤的话这里会是 3 局
    const alphaBlack = byDevice.body.rows.find((r) => r.device === DEV_ALPHA && r.side === 'black' && r.game === 'gomoku');
    expect(alphaBlack).toEqual({
      game: 'gomoku',
      channel: null,
      tactics: null,
      device: DEV_ALPHA,
      side: 'black',
      games: 2,
      wins: 1,
      losses: 0,
      draws: 1,
      win_rate: 1,
    });

    const mine = await getJson<BoardBody>('/api/leaderboard?group=device&device=me', {
      'x-device-id': DEV_ALPHA,
    });
    expect(mine.body.rows).toHaveLength(4);
    expect(mine.body.rows.every((r) => r.device === DEV_ALPHA)).toBe(true);
    // 未参与分组的维度显式落 null，而不是 undefined
    expect(mine.body.rows.every((r) => r.channel === null && r.tactics === null)).toBe(true);
  });

  it('group=game 只按棋种聚合胜率（对阵胜率口径：和棋不进分母）', async () => {
    const { body } = await getJson<BoardBody>('/api/leaderboard?group=game');
    expect(body.rows).toHaveLength(6);
    const gomokuBlack = body.rows.find((r) => r.game === 'gomoku' && r.side === 'black');
    // g1 胜、g4 负、g7 负、g3 和 → 4 局 1 胜 2 负 1 和，胜率 1/3
    expect(gomokuBlack).toEqual({
      game: 'gomoku',
      channel: null,
      tactics: null,
      device: null,
      side: 'black',
      games: 4,
      wins: 1,
      losses: 2,
      draws: 1,
      win_rate: 0.333,
    });
  });

  it('min 抬高样本门槛', async () => {
    const { body } = await getJson<BoardBody>('/api/leaderboard?group=game&min=4');
    // 两个分组都是 4 局，白方 2 胜（g4/g7）排在黑方 1 胜之前（ORDER BY wins DESC）
    expect(body.rows.map((r) => `${r.game}|${r.side}`)).toEqual(['gomoku|white', 'gomoku|black']);
  });
});

/* ----------------------------------------------------- /api/experiments */

describe('GET/POST /api/experiments', () => {
  const ENTRY = {
    tag: 'exp-2025-02-01',
    date: '2025-02-01T00:00:00.000Z',
    chanA: 'proxy',
    chanB: 'openrouter',
    tacA: 'aggressive',
    tacB: 'defensive',
    thinkA: 5,
    thinkB: 7,
    total: 2,
    games: [{ gid: 'gomoku', result: '黑方 获胜（五连）' }],
    note: '第一轮',
  };

  it('POST 落库并回 {ok, tag, date, total}，GET 保留旧响应字段名', async () => {
    const res = await postJson('/api/experiments', ENTRY, { 'x-device-id': DEV_ALPHA });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { ok: boolean; tag: string; date: string; total: number };
    expect(created).toEqual({
      ok: true,
      tag: ENTRY.tag,
      date: ENTRY.date,
      total: 2,
    });

    // 设备行被 touch（POST 里的 touchDevice），棋谱外键因此不会撞
    const device = await env.DB.prepare('SELECT device_id FROM devices WHERE device_id = ?')
      .bind(DEV_ALPHA)
      .first<{ device_id: string }>();
    expect(device?.device_id).toBe(DEV_ALPHA);

    const { status, body } = await getJson<{ experiments: ExperimentEntry[] }>('/api/experiments');
    expect(status).toBe(200);
    expect(body.experiments).toHaveLength(1);
    const entry = body.experiments[0];
    // 键集合逐字对齐旧归档条目：多一个键就会污染前端 localStorage 归档
    expect(Object.keys(entry).sort()).toEqual([
      'chanA',
      'chanB',
      'date',
      'games',
      'note',
      'tacA',
      'tacB',
      'tag',
      'thinkA',
      'thinkB',
      'total',
    ]);
    expect(entry).toEqual(ENTRY);
  });

  it('同 tag 再 POST：只补元数据时保留 games 与 total（不覆盖成 []/0）', async () => {
    await postJson('/api/experiments', ENTRY, { 'x-device-id': DEV_ALPHA });
    // 前端「先建轮次、后补战报」的两段式调用：第二次只改 note
    const res = await postJson('/api/experiments', { tag: ENTRY.tag, note: '改过备注' }, {
      'x-device-id': DEV_ALPHA,
    });
    expect(res.status).toBe(200);

    const { body } = await getJson<{ experiments: ExperimentEntry[] }>('/api/experiments');
    expect(body.experiments).toHaveLength(1); // 同 tag 是 upsert，不是新行
    expect(body.experiments[0].note).toBe('改过备注');
    expect(body.experiments[0].games).toEqual(ENTRY.games);
    expect(body.experiments[0].total).toBe(2);
    expect(body.experiments[0].tacA).toBe('aggressive'); // 未给出即保留
    expect(body.experiments[0].date).toBe(ENTRY.date); // date 未被新 POST 的 now 覆盖
  });

  it('非法形状一律 400 且 code=bad_request', async () => {
    const cases: [string, unknown, Record<string, string>?][] = [
      ['tag 缺失', { games: [] }],
      ['tag 是空白串', { tag: '   ', games: [] }],
      ['tag 超长', { tag: 'x'.repeat(65), games: [] }],
      ['games 不是数组', { tag: 'ok-tag', games: 'nope' }],
      ['请求体不是对象', [1, 2, 3]],
    ];
    for (const [label, payload, headers] of cases) {
      const res = await postJson('/api/experiments', payload, headers);
      const body = (await res.json()) as { code: string; error: string; requestId: string };
      expect(res.status, label).toBe(400);
      expect(body.code, label).toBe('bad_request');
      expect(typeof body.requestId, label).toBe('string');
    }
  });

  it('device=me 过滤需要请求头，limit 上限 200', async () => {
    await postJson('/api/experiments', ENTRY, { 'x-device-id': DEV_ALPHA });
    await postJson('/api/experiments', { ...ENTRY, tag: 'exp-b', total: 1, games: [] }, {
      'x-device-id': DEV_BETA,
    });

    const mine = await getJson<{ experiments: ExperimentEntry[] }>('/api/experiments?device=me', {
      'x-device-id': DEV_BETA,
    });
    expect(mine.body.experiments.map((e) => e.tag)).toEqual(['exp-b']);

    const noHeader = await getJson<{ code: string }>('/api/experiments?device=me');
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.code).toBe('bad_request');

    const limited = await getJson<{ experiments: ExperimentEntry[] }>('/api/experiments?limit=1');
    expect(limited.body.experiments).toHaveLength(1);
  });
});

/* ------------------------------------------------------ 参数与错误分支 */

describe('参数校验（§5.5 手写校验）', () => {
  it('stats：非法 game / 非法 scope / 非法 since 都是 400', async () => {
    for (const path of [
      '/api/stats?game=nope',
      '/api/stats?scope=weird',
      '/api/stats?since=2025/01/01',
    ]) {
      const { status, body } = await getJson<{ code: string; error: string }>(path);
      expect(status, path).toBe(400);
      expect(body.code, path).toBe('bad_request');
      expect(body.error.length, path).toBeGreaterThan(0);
    }

    // stats 没有 limit 参数：未知查询参数被忽略而不是报错（前端多带参数不该把接口打成 400）
    const lenient = await getJson<StatsBody>('/api/stats?limit=0&foo=bar');
    expect(lenient.status).toBe(200);
    expect(lenient.body.totalGames).toBe(7);
  });

  it('stats：scope=device 缺 X-Device-Id、或 X-Device-Id 非法都是 400', async () => {
    const missing = await getJson<{ code: string; error: string }>('/api/stats?scope=device');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('bad_request');
    expect(missing.body.error).toContain('X-Device-Id');

    const bad = await getJson<{ code: string }>('/api/stats?scope=device', { 'x-device-id': 'bad!' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('bad_request');

    // 匿名（没带 header）走默认 scope=global 是允许的（ADR-0013 身份可选）
    const anon = await getJson<StatsBody>('/api/stats');
    expect(anon.status).toBe(200);
  });

  it('openings：game 必填且在 GAME_IDS 内，min/limit 必须是正整数', async () => {
    for (const path of [
      '/api/openings',
      '/api/openings?game=nope',
      '/api/openings?game=gomoku&min=0',
      '/api/openings?game=gomoku&limit=-1',
      '/api/openings?game=gomoku&mode=nope',
      '/api/openings?game=gomoku&since=20250101',
      '/api/openings?game=gomoku&opening=',
    ]) {
      const { status, body } = await getJson<{ code: string }>(path);
      expect(status, path).toBe(400);
      expect(body.code, path).toBe('bad_request');
    }
    // limit 超过上限是**截断**而不是报错（parseLimitParam 的既定语义）
    const { status, body } = await getJson<OpeningsBody>('/api/openings?game=gomoku&limit=9999');
    expect(status).toBe(200);
    expect(body.openings.length).toBeLessThanOrEqual(100);
  });

  it('leaderboard：非法 group / 非法 device 参数', async () => {
    const group = await getJson<{ code: string }>('/api/leaderboard?group=nope');
    expect(group.status).toBe(400);
    expect(group.body.code).toBe('bad_request');

    const me = await getJson<{ code: string; error: string }>('/api/leaderboard?device=me');
    expect(me.status).toBe(400);
    expect(me.body.code).toBe('bad_request');
    expect(me.body.error).toContain('X-Device-Id');

    const bad = await getJson<{ code: string }>('/api/leaderboard?device=short');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('bad_request');
  });

  it('读接口不限流（ADR-0013 口径）：桶满也不 429、不写 rate_limits、无 X-RateLimit 头', async () => {
    /* 2026-10-06 起 read 桶整体放行（原实现每次读请求写一行 rate_limits，单 IP 满速
     * 就能烧穿免费档 10 万行写/日；ADR-0013「后果」节原文预留读接口不计数）。
     * 预插一行满桶计数，验证：请求照常 200、无 X-RateLimit-* 头、计数行原样未动。 */
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 60);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO rate_limits (bucket, window_start, count) VALUES (?, ?, ?)',
    )
      .bind('read:local', windowStart, 120)
      .run();

    const res = await call('/api/stats');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBeNull();
    expect(res.headers.get('retry-after')).toBeNull();
    const row = await env.DB.prepare(
      'SELECT count AS n FROM rate_limits WHERE bucket = ?',
    )
      .bind('read:local')
      .first<{ n: number }>();
    expect(row?.n).toBe(120);
  });
});
