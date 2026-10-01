/**
 * 实验归档路由（计划 §5.1 的 `POST/GET /api/experiments`）。
 *
 * 口径依据与对齐关系（旧实现 → 本文件）：
 *
 * | 口径 | 旧实现 | 本文件 |
 * |---|---|---|
 * | 形状校验 | `functions/api/experiments.js:53`、`server.cjs:379`：`tag` 非空串 + `games` 必须是数组 | `tag` 非空串且 ≤64 字符；`games` **给出时**必须是数组（见下「刻意放宽」） |
 * | 落库 | 读整份 JSON → 过滤同 tag → push → 写回 | `db/experiments.ts` 的 `INSERT … ON CONFLICT(tag) DO UPDATE`（§4.1 的按 tag upsert） |
 * | 未知字段 | `chanA/chanB/total/note` 原样透传，`tacA/tacB/thinkA/thinkB` 仅类型对才收 | 同左，且经 `shared/record-map.ts` 的 `mapExperimentRecord`（与导入脚本同一份口径） |
 * | 响应字段名 | `tag, date, chanA, chanB, tacA, tacB, thinkA, thinkB, total, games, note` | **逐字相同**（camelCase）——见「字段命名依据」 |
 *
 * 字段命名依据（为什么是 camelCase 而且不能改名）：`js/app.js` 直接消费这些键——
 * `renderExpHistory()` 读 `e.games / e.chanA / e.chanB / e.tacA / e.tacB / e.thinkA /
 * e.thinkB / e.total / e.note / e.tag / e.date`（js/app.js:1309-1391），
 * `applyExperimentFields()` 读 `expTacA` 那一段用的是同一批名字（js/app.js:962-964）。
 * 数据库列是 snake_case（`chan_a`/`tac_a`…），`db/experiments.ts` 的 SELECT 已别名成
 * camelCase，本文件只做「行 → 旧归档条目」的还原，不再改一层名字。
 *
 * 刻意放宽的一处（`games` 缺失不再 422）：旧实现要求 `Array.isArray(body.games)`，
 * 前端每次都带 `games`，所以放宽不影响既有客户端，却能让「先建轮次、后补战报」的两段式
 * 调用成立（§5.1 的实验面板是边打边追加）。
 *
 * ⚠ 放宽必须配一次读回，否则会**清空**对局列表：`mapExperimentRecord` 把缺失的 `games`
 * 当成 `[]`、把缺失的 `total` 当成 `games.length`，而 `db` 层的 `COALESCE(?11, …)`
 * 只对 `NULL` 生效——`'[]'` 不是 NULL，会原样覆盖。所以本文件在 `games`/`total` 缺失时
 * 先读回既有行的对应列再喂给 repo（见下面的 `loadExisting`）。不这么做的话，
 * 「只改 note」的一次 POST 就会把整轮战报抹掉。
 *
 * 与旧实现的另一处差异（更安全的方向）：旧实现整条 entry 覆盖写回，前端漏传 `tacA`
 * 就会把它抹掉；这里交 `upsertExperiment` 的 COALESCE 语义（未给出即保留），
 * 理由见 db/experiments.ts 头注（tac_a/tac_b 是同渠道 A/B 的唯一可分辨依据）。
 * `date` 也走同一条 COALESCE（缺失则保留旧值，新建才用 `now`）。
 */
import { Hono } from 'hono';
import {
  DEFAULT_EXPERIMENT_LIMIT,
  MAX_EXPERIMENT_LIMIT,
  listExperiments,
  parseExperimentGames,
  touchDevice,
  upsertExperiment,
  type ExperimentRow,
} from '../db/index.ts';
import { errorBody, statusFor } from '../lib/http.ts';
import { toExperimentInput } from '../lib/record-input.ts';
import type { ExperimentPayload } from '../../shared/record-map.ts';
import { fail, invalid, parseDeviceId, parseLimitParam, readJsonBody } from '../lib/validate.ts';
import { deviceMiddleware } from '../middleware/device.ts';
import { rateLimit } from '../middleware/ratelimit.ts';
import type { AppEnv } from '../types.ts';

/** `tag` 上限：旧实现只要求非空，这里补一个长度上限，避免主键无限膨胀（列类型是 TEXT）。 */
const MAX_TAG_LENGTH = 64;

/** `upsertExperiment` 只认对象输入；非对象一律 400（`readJsonBody` 已挡掉语法错误）。 */
function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * 读回既有轮次里「客户端没给、但缺失就会被覆盖成默认值」的两列。
 *
 * 只查这两列（`games_json`、`total`）而不是整行：其它列在 `mapExperimentRecord` 里
 * 缺失会变成 `null`，由 `db` 层的 COALESCE 天然保留，不需要在这里兜。
 * tag 是主键，`first()` 命中不到就是新建，返回 null 让默认值生效。
 */
async function loadExisting(
  db: D1Database,
  tag: string,
): Promise<{ gamesJson: string; total: number | null; date: string } | null> {
  return db
    .prepare('SELECT games_json AS gamesJson, total, date FROM experiments WHERE tag = ?')
    .bind(tag)
    .first<{ gamesJson: string; total: number | null; date: string }>();
}

/**
 * 补齐「客户端没给、但直接交给 repo 就会被写成默认值」的三列。
 *
 * `mapExperimentRecord` 会对缺失的 `date`/`games`/`total` 分别代入 `opts.now` / `[]` /
 * `games.length`，三者都不是 NULL，所以 `db` 层的 `COALESCE(?n, experiments.col)` 拦不住
 * ——必须在路由层先读回旧值。只有在这三列确实缺失时才读库（前端每次都带全套字段，
 * 所以常见路径是零额外查询）。`games` 的坏 JSON 降级成空数组，与 `parseExperimentGames` 一致。
 * 读不到行（新 tag）时原样返回，让 `now`（date）与 repo 的默认值（games/total）生效。
 */
async function fillMissing(
  db: D1Database,
  tag: string,
  payload: ExperimentPayload,
): Promise<ExperimentPayload> {
  if (payload.games !== undefined && payload.total !== undefined && payload.date !== undefined) {
    return payload;
  }
  const existing = await loadExisting(db, tag);
  if (!existing) return payload;

  const filled: ExperimentPayload = { ...payload };
  if (payload.games === undefined) {
    let games: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(existing.gamesJson);
      if (Array.isArray(parsed)) games = parsed;
    } catch {
      games = [];
    }
    filled.games = games;
  }
  if (payload.total === undefined) filled.total = existing.total ?? undefined;
  if (payload.date === undefined) filled.date = existing.date;
  return filled;
}

/**
 * 行 → 旧归档条目。
 *
 * 只输出**旧实现确实会写进 data/experiments.json 的键**（server.cjs:382-397 的 entry 字面量），
 * 一个不多——多出来的键会被 `js/app.js:909-913` 的合并逻辑一起塞进 localStorage 归档，
 * 白白撑大前端持久化。`gamesJson` 是内部列，绝不外泄。
 *
 * `date` 兜底成空串而不是省略：旧条目里 `date` 永远存在（写入时取当时时间），
 * 省略会让 `list.sort(b.date.localeCompare)` 这类消费方拿到 undefined。
 */
function archiveEntry(row: ExperimentRow) {
  return {
    tag: row.tag,
    date: row.date ?? '',
    chanA: row.chanA,
    chanB: row.chanB,
    tacA: row.tacA,
    tacB: row.tacB,
    thinkA: row.thinkA,
    thinkB: row.thinkB,
    total: row.total,
    games: parseExperimentGames(row),
    note: row.note,
  };
}

export const experimentsRoute = new Hono<AppEnv>();

/**
 * 写入一轮实验（按 tag upsert）。
 *
 * 链序按 §5.2：限流 → 设备校验 → 校验 → repo。中间件顺序不能颠倒：
 * `deviceMiddleware` 要先把 `X-Device-Id` 验出来（非法直接 400），
 * 业务里才能安全地拿 `c.get('deviceId')` 去建设备行。
 */
experimentsRoute.post('/', rateLimit('write'), deviceMiddleware, async (c) => {
  const body = await readJsonBody(c);
  if (!body.ok) return fail(c, body);

  const record = asRecord(body.value);
  if (!record) return fail(c, invalid('bad_request', '请求体必须是 JSON 对象'));
  /* 形状校验手写在下面，不走 zod（§5.5）；这里的断言只是把「任意 JSON 对象」
   * 收窄到实验条目类型，字段是否存在仍由下面的运行时检查负责。 */
  const payload = record as ExperimentPayload;

  /* 旧的 422 是「实验数据不完整：tag 必须是非空字符串，games 必须为数组」；
   * 这里按 §5.5 的手写校验拆成更精确的消息，但错误码仍是 422 invalid_payload 那一类语义
   * ——注意 tag 的问题是**请求形状**问题，用 bad_request(400) 与 `/api/games` 的非法参数一致。 */
  const tag = typeof payload.tag === 'string' ? payload.tag.trim() : '';
  if (!tag) return fail(c, invalid('bad_request', 'tag 必须是非空字符串'));
  if (tag.length > MAX_TAG_LENGTH) {
    return fail(c, invalid('bad_request', `tag 不能超过 ${MAX_TAG_LENGTH} 个字符`));
  }
  if (payload.games !== undefined && payload.games !== null && !Array.isArray(payload.games)) {
    return fail(c, invalid('bad_request', 'games 必须是数组'));
  }

  const deviceId = c.get('deviceId');

  /* 先建/刷新设备行：`experiments.device_id` 虽然不是外键，但 `games.device_id` 是，
   * 而实验轮与棋谱共用同一个 deviceId；统一在写入口 touchDevice 一次，
   * 保证「先记实验、后传棋谱」的顺序下棋谱那一步也不会撞外键。 */
  if (deviceId) {
    await touchDevice(c.env.DB, { deviceId, ua: c.req.header('user-agent') ?? null });
  }

  /* `now` 显式给出：`mapExperimentRecord` 的 date 兜底是 `opts.now ?? ''`，
   * 不给的话缺 date 的旧客户端会落一个空串；旧实现是 `new Date().toISOString()`。
   * 注意这条兜底只对**新建**生效：已存在时 `db` 层用 COALESCE(?2, experiments.date) 保留旧值。 */
  const input = toExperimentInput(await fillMissing(c.env.DB, tag, payload), {
    deviceId,
    now: new Date().toISOString(),
  });
  const row = await upsertExperiment(c.env.DB, input);

  return c.json({ ok: true, tag: row.tag, date: row.date, total: row.total });
});

/**
 * 实验归档列表。
 *
 * 旧响应：`{ experiments: [...] }`（`functions/api/experiments.js:37`、`server.cjs:412`）。
 * 旧实现还会在「服务端没配 token」时附带 `reason` 字段——D1 没有这个失败态，故不保留。
 *
 * `limit` 走 `MAX_EXPERIMENT_LIMIT`（200，§4.1 的列表护栏），`device` 支持
 * `me`（用请求头里的设备）或显式 id；旧接口没有过滤参数，这里新增是 §5.1「支持 device 过滤」。
 */
experimentsRoute.get('/', rateLimit('read'), deviceMiddleware, async (c) => {
  const limit = parseLimitParam(c.req.query('limit'), {
    max: MAX_EXPERIMENT_LIMIT,
    fallback: DEFAULT_EXPERIMENT_LIMIT,
  });
  if (!limit.ok) return fail(c, limit);

  const deviceParam = c.req.query('device');
  let filterDevice: string | null = null;
  if (deviceParam === 'me') {
    filterDevice = c.get('deviceId');
    if (!filterDevice) return fail(c, invalid('bad_request', 'device=me 需要带上 X-Device-Id'));
  } else if (deviceParam !== undefined && deviceParam !== '') {
    const parsed = parseDeviceId(deviceParam);
    if (!parsed.ok) return fail(c, parsed);
    filterDevice = parsed.value;
  }

  const rows = await listExperiments(c.env.DB, limit.value);
  /* 归属过滤在 JS 侧做而不是传给 SQL：实验轮次天然只有几十条（旧仓库 6 轮），
   * 而 `listExperiments` 是 db 层已定型的公共接口（改动它超出本轮所有权）。
   * 一旦轮次上量（>200 条被 LIMIT 截断）就该把它下沉成 SQL 的 WHERE device_id = ?，
   * 这一点记在这里而不是默默留着。 */
  const filtered = filterDevice ? rows.filter((row) => row.deviceId === filterDevice) : rows;

  return c.json({ experiments: filtered.map(archiveEntry) });
});

/* 让类型检查器盯着 `errorBody/statusFor`：本文件当前走 `fail()` 统一出口，
 * 但 onError 之外的兜底（例如数据库异常要自己翻成 5xx）会用到它们。 */
export const __httpHelpers = { errorBody, statusFor };
