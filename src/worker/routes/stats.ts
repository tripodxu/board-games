/**
 * 统计路由（计划 §5.1 的 `GET /api/stats` 增强版）。
 *
 * 口径依据与对齐关系（旧实现 → 本文件）：
 *
 * | 口径 | 旧实现 | 本文件 |
 * |---|---|---|
 * | 总览 + 各棋种分布 + 胜负 | `server.cjs:415-458` 的 `handleStats()`（遍历整仓 JSON） | `db/stats.ts` 的 `getStats()`，三条 `GROUP BY` 全在 SQL 侧算 |
 * | 校准样本 | 同上：`rec.mock !== true && Array.isArray(rec.cal) && (rec.firstWin === true \|\| rec.firstWin === false)` | 同左语义翻译成 `mock = 0 AND first_win IS NOT NULL AND json_type(cal_json) = 'array'` |
 * | `byGame` 的键 | `rec.game \|\| 'unknown'`（棋种**中文名**：五子棋/象棋/…） | `COALESCE(NULLIF(game, ''), 'unknown')`——**中文名**，不要在这里翻成 game_id |
 * | `truncated` | 仅 Pages 版 `functions/api/stats.js` 有（`paths.length >= MAX_FILES`） | **彻底删除**（§5.1 明确去掉）：D1 用 SQL 聚合，没有「只读 40 个文件」这个天花板 |
 * | `experiments` 计数 | Pages 版从 data/experiments.json 读轮数 | D1 走 `/api/experiments`，不再塞进 stats |
 *
 * 关于 `ok`：任务书说「返回 getStats 结果原样」，这里额外补一个 `ok: true`
 * 再展开 StatsResult——因为 `js/api.js` 的 `json()` 包装把 `ok` 当作成功判据
 * （旧 `handleStats` 也返回 `{ok:true, …}`，只在 Pages 版被 `json()` 包掉）。
 * 除 `ok` 外不加任何字段：`{ok, totalGames, byGame, results, cal}` 就是全部响应体。
 */
import { Hono } from 'hono';
import { getStats, type StatsOptions } from '../db/index.ts';
import { GAME_IDS } from '../../shared/record-map.ts';
import { fail, invalid, parseDayParam, parseEnumParam } from '../lib/validate.ts';
import { deviceMiddleware } from '../middleware/device.ts';
import { rateLimit } from '../middleware/ratelimit.ts';
import type { AppEnv } from '../types.ts';

/** 统计口径的作用域，非此二者 → 400（§5.1「增强 scope=global|device」）。 */
const SCOPES = ['global', 'device'] as const;

export const statsRoute = new Hono<AppEnv>();

/**
 * 全局/单设备统计。
 *
 * 参数（全部可选）：
 * - `scope`：`global`（默认，全体设备）| `device`（只统计请求头 `X-Device-Id` 那一台）；
 * - `game`：棋种 **id**（gomoku/xiangqi/…，§4.1 的 `games.game_id`），非法 → 400；
 * - `since`：起始日 `YYYY-MM-DD`（含当天，比较的是派生列 `day`）。
 *
 * 为什么 `game` 收 id 而 `byGame` 吐中文名：两者本来就是不同层的东西——
 * URL 参数对齐 `GAME_IDS`（与 `/api/games` 的 `game` 参数同一套值，前端不用记中文），
 * 而 `byGame` 的键沿用旧响应（`renderStats` 直接把它当标题显示）。
 */
statsRoute.get('/', rateLimit('read'), deviceMiddleware, async (c) => {
  const scope = parseEnumParam(c.req.query('scope'), SCOPES, 'global');
  if (!scope.ok) return fail(c, scope);

  const game = c.req.query('game');
  if (game !== undefined && game !== '') {
    if (!GAME_IDS.includes(game)) {
      return fail(c, invalid('bad_request', `未知棋种：${game}`));
    }
  }

  const since = parseDayParam(c.req.query('since'));
  if (!since.ok) return fail(c, since);

  const deviceId = c.get('deviceId');
  if (scope.value === 'device' && !deviceId) {
    return fail(c, invalid('bad_request', 'scope=device 需要带上 X-Device-Id'));
  }

  /* 只把「确实要过滤」的条件放进 options：getStats 按需拼 WHERE，
   * 传 undefined 等于不加条件（而不是 `?1 IS NULL OR …` 那种会让索引失效的写法）。 */
  const options: StatsOptions = {};
  if (scope.value === 'device' && deviceId) options.deviceId = deviceId;
  if (game) options.gameId = game;
  if (since.value) options.sinceDay = since.value;

  const stats = await getStats(c.env.DB, options);

  return c.json({ ok: true, ...stats });
});

/* `invalid` 一并导出：本文件只用 `fail(c, invalid(...))` 这一条错误出口，
 * 留着引用可防止有人在 onError 兜底里另起一套错误体（§5.5 要求错误体形状唯一）。 */
export const __invalidHelper = invalid;
