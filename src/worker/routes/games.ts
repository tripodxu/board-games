/**
 * 对局路由（§5.1）。
 *
 * 旧契约 → 新实现的三点差异，都是计划明确要求的：
 * 1. `POST /api/games` 的响应从 `{ok, path, dedup}` 变成 `{ok, id, gameUid, dedup, path}`：
 *    `id`/`gameUid` 供新前端做永久链接，`path` 仍是**展示用**的归档路径（D1 里没有文件了，
 *    但战绩簿/报告里出现的那个字符串保持不变，见 `archivePath`）。
 * 2. `GET /api/games` 不再硬编码「最近 7 天」、不再截断：`since` 显式给出起点，
 *    `cursor` 走 keyset（`id < cursor`），`limit ≤ 100`。条目里额外带上旧字段
 *    `day/name/path/size`，这样迁移期内还没改完的旧前端仍能读。
 * 3. 详情路由返回**payload 原文对象**（与旧 `handleGameGet` 直接吐文件内容一致），
 *    而不是包的 `{game:…}`；新增 `/u/:gameUid` 与旧 `/ :day/:name` 共用同一形状，
 *    只在 payload 里缺 `gameUid` 时补一个字段（新增字段不会破坏旧消费者）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { GAME_IDS } from '../../shared/record-map.ts';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  getGame,
  getGameByUidPrefix,
  insertGame,
  listGames,
  /* 数据层的是「落库 payload 原文 → 对象」；请求体校验同名函数在 lib/validate.ts，
   * 两者语义不同，这里用别名避免撞名。 */
  parseGamePayload as parseStoredPayload,
  touchDevice,
  type Game,
  type GameWithMoves,
} from '../db/index.ts';
import { errorBody, statusFor, type ApiErrorCode } from '../lib/http.ts';
import { toGameInput } from '../lib/record-input.ts';
import {
  fail,
  invalid,
  parseCursorParam,
  parseDayParam,
  parseGamePayload,
  parseLimitParam,
  readJsonBody,
} from '../lib/validate.ts';
import { deviceMiddleware } from '../middleware/device.ts';
import { rateLimit } from '../middleware/ratelimit.ts';
import type { AppEnv } from '../types.ts';

const NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;

/** 旧客户端的 `path` 字段只是展示串（战绩簿里出现过），这里按老规则合成一个稳定值。 */
function archivePath(game: Game): string {
  const stamp = game.gameUid.slice(0, 8);
  return `games/${game.day}/${game.slug || game.gameId}-${stamp}.json`;
}

/** 列表条目：新列 + 旧字段别名（`size` 就是 payload 字节数）。 */
function listItem(game: Game) {
  return {
    ...game,
    name: `${game.slug || game.gameId}-${game.gameUid.slice(0, 8)}.json`,
    path: archivePath(game),
    size: game.payloadBytes,
  };
}

/** 把数据层的异常翻译成 4xx；其余交给 onError（500）。 */
function bail(c: Context, err: unknown) {
  if (err instanceof RangeError) return fail(c, invalid('payload_too_large', err.message));
  if (err instanceof TypeError) return fail(c, invalid('invalid_payload', err.message));
  throw err;
}

export const gamesRoute = new Hono<AppEnv>();

gamesRoute.post('/', rateLimit('write'), deviceMiddleware, async (c) => {
  const body = await readJsonBody(c);
  if (!body.ok) return fail(c, body);
  const checked = parseGamePayload(body.value);
  if (!checked.ok) return fail(c, checked);

  const deviceId = c.get('deviceId');
  const bundle = await toGameInput(checked.value.payload, { deviceId, source: 'worker' });

  // 先建/刷新设备行：`games.device_id` 有外键，D1 强制约束，缺这一行会得到
  // SQLITE_CONSTRAINT_FOREIGNKEY（而不是一次正常写入）。
  if (deviceId) {
    await touchDevice(c.env.DB, { deviceId, ua: c.req.header('user-agent') ?? null });
  }

  try {
    const result = await insertGame(c.env.DB, bundle.input);
    if (bundle.warnings.length) console.warn(`[games] 映射告警 gameUid=${bundle.gameUid}`, bundle.warnings);
    return c.json({
      ok: true,
      id: result.game.id,
      gameUid: result.game.gameUid,
      dedup: result.dedup,
      movesWritten: result.movesWritten,
      path: archivePath(result.game),
      ...(bundle.warnings.length ? { warnings: bundle.warnings } : {}),
    });
  } catch (err) {
    return bail(c, err);
  }
});

gamesRoute.get('/', rateLimit('read'), deviceMiddleware, async (c) => {
  const limit = parseLimitParam(c.req.query('limit'), { max: MAX_LIST_LIMIT, fallback: DEFAULT_LIST_LIMIT });
  if (!limit.ok) return fail(c, limit);
  const cursor = parseCursorParam(c.req.query('cursor'));
  if (!cursor.ok) return fail(c, cursor);
  const since = parseDayParam(c.req.query('since'));
  if (!since.ok) return fail(c, since);
  const day = parseDayParam(c.req.query('day'));
  if (!day.ok) return fail(c, day);

  const gameId = c.req.query('game');
  if (gameId !== undefined && gameId !== '' && !GAME_IDS.includes(gameId)) {
    return fail(c, invalid('bad_request', `未知棋种：${gameId}`));
  }

  // 归属过滤：`device=me` 用请求头里的设备；显式给 id 则按那个 id 过滤（管理员/自查用）。
  const deviceParam = c.req.query('device');
  const filterDevice = deviceParam === 'me' ? c.get('deviceId') : (deviceParam || null);
  if (deviceParam === 'me' && !filterDevice) {
    return fail(c, invalid('bad_request', 'device=me 需要带上 X-Device-Id'));
  }

  const page = await listGames(c.env.DB, {
    limit: limit.value,
    cursor: cursor.value ?? undefined,
    sinceDay: since.value ?? undefined,
    day: day.value ?? undefined,
    gameId: gameId || undefined,
    deviceId: filterDevice ?? undefined,
    experimentTag: c.req.query('tag') || undefined,
  });

  return c.json({ ok: true, games: page.games.map(listItem), nextCursor: page.nextCursor });
});

/** 永久链接：`/u/<gameUid>`。必须注册在 `/:day/:name` 之前，否则会被当成 day='u'。 */
gamesRoute.get('/u/:gameUid', rateLimit('read'), deviceMiddleware, async (c) => {
  const gameUid = c.req.param('gameUid');
  if (!gameUid || gameUid.length > 64) return fail(c, invalid('bad_request', 'gameUid 不合法'));
  const found = await getGame(c.env.DB, { gameUid });
  if (!found) return fail(c, invalid('not_found', '棋谱不存在'));
  return detail(c, found);
});

/** 旧路径：`/api/games/<day>/<name>`（`name` 兼容带 `.json` 的旧文件名）。 */
gamesRoute.get('/:day/:name', rateLimit('read'), deviceMiddleware, async (c) => {
  const day = parseDayParam(c.req.param('day'));
  if (!day.ok) return fail(c, day);
  if (!day.value) return fail(c, invalid('bad_request', 'day 必须是 YYYY-MM-DD'));
  const name = c.req.param('name');
  if (!NAME_RE.test(name)) return fail(c, invalid('bad_request', '非法棋谱名'));

  const found = await resolveLegacyName(c, day.value, name);
  if (!found) return fail(c, invalid('not_found', '棋谱不存在'));
  return detail(c, found);
});

/**
 * 旧 URL 的 `name` 有三种合法来源，按「越精确越先试」的顺序解析：
 *  1. 真实 slug（`slug` 列有值的记录，如旧客户端带了 `slug` 字段）；
 *  2. 老文件名 `<slug>-<时间戳>.json` —— 去掉尾部那一段再按 slug 查；
 *  3. 新列表合成的 `<slug|gameId>-<game_uid 前 8 位>.json` —— 用 uid 前缀反查。
 * 三者都落空才 404：宁可 404 也不猜（猜错会把 A 局的链接指向 B 局）。
 */
async function resolveLegacyName(c: Context, day: string, name: string) {
  const stem = name.replace(/\.json$/i, '');
  const exact = await getGame(c.env.DB, { day, slug: stem });
  if (exact) return exact;

  const withoutStamp = stem.replace(/-[^-]+$/, '');
  if (withoutStamp && withoutStamp !== stem) {
    const bySlug = await getGame(c.env.DB, { day, slug: withoutStamp });
    if (bySlug) return bySlug;
  }

  const lastSegment = stem.slice(stem.lastIndexOf('-') + 1);
  if (lastSegment.length >= 8) {
    const byPrefix = await getGameByUidPrefix(c.env.DB, day, lastSegment);
    if (byPrefix) return byPrefix;
  }

  // 记录未命中：P4 导入的历史棋谱里 48/54 没有 slug，老文件名无法反查，
  // 这类深链要靠列表返回的 path 或 `/u/<gameUid>`（见路由头注）。
  console.warn(`[games] 旧路径未命中 day=${day} name=${name}`);
  return null;
}

/** 详情：吐出 payload 原文（形状与旧 `handleGameGet` 一致），必要时补 `gameUid`。 */
async function detail(c: Context, found: GameWithMoves) {
  let payload: unknown;
  try {
    payload = parseStoredPayload(found);
  } catch (err) {
    console.error(`[games] payload 损坏 gameUid=${found.gameUid}`, err);
    return c.json(errorBody('internal' as ApiErrorCode, '棋谱 payload 损坏', c.get('requestId')), statusFor('internal'));
  }

  c.header('X-Game-Uid', found.gameUid);
  c.header('X-Game-Day', found.day);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (!record.gameUid) record.gameUid = found.gameUid;
    return c.json(record);
  }
  return c.json({ gameUid: found.gameUid, payload });
}
