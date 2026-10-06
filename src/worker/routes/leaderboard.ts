/**
 * 榜单路由（计划 §5.1 新增：`GET /api/leaderboard`，「渠道/战术档/对阵胜率榜」）。
 *
 * 口径依据与对齐关系：
 *
 * 1. **对齐 §4.3 草案**（docs/plans/2026-10-01-workers-d1-rebuild.md:314-316）：
 *    `SELECT black_channel AS channel, black_tactics AS tactics, winner, COUNT(*)
 *     FROM games WHERE mock = 0 GROUP BY 1,2,3;`
 *    草案只统计**黑方**一列、且把 `winner` 当分组键（于是「黑胜/白胜/和棋」是三行）。
 *    本文件把它改造成两种等价但更好用的形式，改动点逐条落在下面注释里：
 *    - 用 `CASE WHEN winner = side` 把 `winner` 的三个取值**摊平成 wins/losses/draws 三列**
 *      （一个渠道一行，而不是三行；前端做榜不需要再自己 pivot）；
 *    - `black_*` / `white_*` 两列用 `UNION ALL` 拆成两个「视角行」，再按 `side` 分组：
 *      白方的渠道/战术档因此也能上榜（这是 §5.1「渠道/战术档/对阵胜率榜」的原意），
 *      而草案只有黑方，会漏掉白方渠道。
 *    仍然保留草案的三个维度：棋种（`game_id`）、渠道（`channel`）、战术档（`tactics`）。
 *
 * 2. **`mock = 0`** 与草案一致：离线演示局不进榜。
 *
 * 3. **NULL 渠道不能把整局丢掉**：迁移期导入的 54 份历史棋谱**没有** `blackChan/whiteChan`
 *    字段（实测 games/*.json 只有 game/mode/firstWin/mock/…），落库后渠道列全是 NULL。
 *    所以这里 `COALESCE(channel, 'unknown')` 兜成 `unknown` 一行而不是 `WHERE channel IS NOT NULL`
 *    ——否则整个历史库在榜上是空的。`tactics` 保留 NULL 原样（战术档为空的含义是「没记录」，
 *    与「记录成 unknown 档」是两件事，不宜合并）。
 *
 * 4. **胜率分母只算已分胜负的局**（`wins / (wins + losses)`，用 `NULLIF` 防 0 除）：
 *    这与 `js/app.js` 的战绩簿口径一致（和棋既不算赢也不算输），也与 §5.1「对阵胜率」
 *    的直觉一致；`draws` 单独给一列，调用方想按「含和棋」算可以自己合。
 *    注意这与 `/api/openings` 的 `black_win_rate` **不同**（那边分母含和棋，见 openings.ts 头注 4），
 *    两处不一样是刻意的：开局经验要复刻旧 `buildExperience()` 的数值，榜单是新增展示口径。
 *
 * 5. **三档分组维度**（`group` 参数，默认 `channel`）：`channel` 走草案的渠道 × 战术档，
 *    `device` 走设备维度（任务要求的「按设备聚合」），`game` 只看棋种合计。
 *    三种模式共用一条 SQL，只换分组表达式（表达式全部来自下面的白名单常量，
 *    绝不把查询参数拼进 SQL）。`side` 永远在分组键里：一个渠道在「执黑」「执白」下的
 *    胜率本就不同，混在一起会把两面互相抵消掉，还让 `games` 双计。
 *
 * 6. **`channel` 过滤是「视角行级」的**（在 `side_rows` 的 `chan` 上过滤，而不是在 `raw` 里
 *    按 `black_channel/white_channel` 过滤整局）：`?channel=proxy` 只返回 proxy 自己那一侧的行。
 *    若按整局过滤，proxy 的对家行（`official`/`openrouter`/`unknown`）会一起冒出来，
 *    让「渠道榜 + 渠道过滤」变成对局列表而不是榜单。`device` 过滤则保持整局级
 *    （同一局的 `device_id` 两侧相同，两种写法等价）。
 *    特殊值 `unknown` 映射成 `chan IS NULL`：榜单里 NULL 渠道被展示成 `unknown`（见第 3 条），
 *    这样把响应里的 `channel` 值原样回传就能拿到同一批行，闭环不骗人。
 */
import { Hono } from 'hono';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../db/index.ts';
import { GAME_IDS } from '../../shared/record-map.ts';
import { fail, invalid, parseDayParam, parseDeviceId, parseEnumParam, parseLimitParam } from '../lib/validate.ts';
import { deviceMiddleware } from '../middleware/device.ts';
import { rateLimit } from '../middleware/ratelimit.ts';
import type { AppEnv } from '../types.ts';

/** 榜单维度白名单：`dims` 进 SELECT，`by` 进 GROUP BY（两者必须一一对应）。 */
const GROUP_MODES = {
  channel: {
    dims: ["game_id AS game", "COALESCE(chan, 'unknown') AS channel", 'tactics AS tactics'],
    by: ['game_id', "COALESCE(chan, 'unknown')", 'tactics'],
    order: ['channel ASC', 'tactics ASC'],
  },
  device: {
    dims: ["game_id AS game", "COALESCE(device_id, 'unknown') AS device"],
    by: ['game_id', "COALESCE(device_id, 'unknown')"],
    order: ['device ASC'],
  },
  game: {
    dims: ["game_id AS game"],
    by: ['game_id'],
    order: [],
  },
} as const;

const GROUPS = ['channel', 'device', 'game'] as const;
type GroupMode = (typeof GROUPS)[number];

/** 一个榜单分组（某个渠道/设备在某一侧、某一棋种下的战绩），全部由 SQL 聚合得出。 */
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
  winRate: number | null;
}

export const leaderboardRoute = new Hono<AppEnv>();

/**
 * 渠道 / 战术档 / 设备 / 棋种的战绩榜。
 *
 * 参数（全部可选）：
 * - `group`：`channel`（默认）| `device` | `game`；
 * - `game`：棋种 id，非法 400；
 * - `channel`：只看某个渠道（如 `proxy`/`openrouter`/`official`，js/app.js:1242 的 `JEV_CHANS`）；
 * - `device`：`me`（用请求头里的设备）或显式 id；
 * - `since`：`YYYY-MM-DD`；
 * - `min`：样本下限，默认 1（草案没有 `HAVING`，默认不筛；给 2 以上才变成「至少打过 N 局的档位」）；
 * - `limit`：最多几行，默认 20，上限 `MAX_LIST_LIMIT`。
 *
 * `since` 走派生列 `day`（UTC 日期，`games.day`），与 `/api/games`、`/api/stats` 同一套时间窗。
 */
leaderboardRoute.get('/', rateLimit('read'), deviceMiddleware, async (c) => {
  const group = parseEnumParam<GroupMode>(c.req.query('group'), GROUPS, 'channel');
  if (!group.ok) return fail(c, group);

  const game = c.req.query('game');
  if (game !== undefined && game !== '' && !GAME_IDS.includes(game)) {
    return fail(c, invalid('bad_request', `未知棋种：${game}`));
  }

  const since = parseDayParam(c.req.query('since'));
  if (!since.ok) return fail(c, since);

  const minGames = parseLimitParam(c.req.query('min'), { max: MAX_LIST_LIMIT, fallback: 1 });
  if (!minGames.ok) return fail(c, minGames);

  const limit = parseLimitParam(c.req.query('limit'), {
    max: MAX_LIST_LIMIT,
    fallback: DEFAULT_LIST_LIMIT,
  });
  if (!limit.ok) return fail(c, limit);

  const channel = c.req.query('channel');
  if (channel !== undefined && channel === '') {
    return fail(c, invalid('bad_request', 'channel 不能为空字符串'));
  }

  const deviceParam = c.req.query('device');
  let deviceFilter: string | null = null;
  if (deviceParam === 'me') {
    deviceFilter = c.get('deviceId');
    if (!deviceFilter) return fail(c, invalid('bad_request', 'device=me 需要带上 X-Device-Id'));
  } else if (deviceParam !== undefined && deviceParam !== '') {
    const parsed = parseDeviceId(deviceParam);
    if (!parsed.ok) return fail(c, parsed);
    deviceFilter = parsed.value;
  }

  /* 过滤条件只写一份，放在 `raw` 里，两个视角行从同一份结果里 UNIONS ALL 出来。 */
  const conditions = ['mock = 0'];
  const binds: unknown[] = [];
  if (game) {
    conditions.push('game_id = ?');
    binds.push(game);
  }
  if (since.value) {
    conditions.push('day >= ?');
    binds.push(since.value);
  }
  if (deviceFilter) {
    conditions.push('device_id = ?');
    binds.push(deviceFilter);
  }

  /* 渠道过滤落在视角行上（见文件头注 6）：`unknown` 是 NULL 的展示名，映射回 `IS NULL`。 */
  const sideConditions: string[] = [];
  if (channel) {
    if (channel === 'unknown') {
      sideConditions.push('chan IS NULL');
    } else {
      sideConditions.push('chan = ?');
      binds.push(channel);
    }
  }

  const meta = GROUP_MODES[group.value];
  const groupBy = [...meta.by, 'side'].join(', ');
  const orderBy = ['wins DESC', 'games DESC', 'game ASC', ...meta.order, 'side ASC'].join(', ');

  /* 绑定值顺序必须与 SQL 文本里占位符出现的顺序一致：raw 的条件 → 外层 WHERE → HAVING → LIMIT。 */
  binds.push(minGames.value, limit.value);

  /* 全部聚合（计数、胜负拆分、胜率）都在 SQL 侧完成，JS 只搬运标量。
   * `NULLIF(wins + losses, 0)` 保证「只有和棋」的分组胜率是 NULL 而不是除零错误。 */
  const result = await c.env.DB.prepare(
    `WITH raw AS (
       SELECT game_id, device_id, winner,
              black_channel AS bchan, white_channel AS wchan,
              black_tactics AS btac,  white_tactics AS wtac
         FROM games
        WHERE ${conditions.join(' AND ')}
     ),
     side_rows AS (
       SELECT game_id, device_id, winner, 'black' AS side, bchan AS chan, btac AS tactics FROM raw
       UNION ALL
       SELECT game_id, device_id, winner, 'white' AS side, wchan AS chan, wtac AS tactics FROM raw
     )
     SELECT ${meta.dims.join(', ')}, side,
            COUNT(*) AS games,
            COALESCE(SUM(CASE WHEN winner = side THEN 1 ELSE 0 END), 0) AS wins,
            COALESCE(SUM(CASE WHEN winner IS NOT NULL AND winner <> side THEN 1 ELSE 0 END), 0) AS losses,
            COALESCE(SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END), 0) AS draws,
            ROUND(SUM(CASE WHEN winner = side THEN 1.0 ELSE 0.0 END)
                  / NULLIF(SUM(CASE WHEN winner IS NOT NULL THEN 1 ELSE 0 END), 0), 3) AS winRate
       FROM side_rows
      WHERE ${sideConditions.length ? sideConditions.join(' AND ') : '1 = 1'}
      GROUP BY ${groupBy}
     HAVING COUNT(*) >= ?
      ORDER BY ${orderBy}
      LIMIT ?`,
  )
    .bind(...binds)
    .all<BoardRow>();

  const rows = (result.results ?? []).map((row) => ({
    game: row.game,
    /* 未参与本次分组的维度显式落 null：前端拿到 undefined 会渲染成 "undefined"，
     * 而不是「这一维没参与聚合」。 */
    channel: group.value === 'channel' ? row.channel : null,
    tactics: group.value === 'channel' ? (row.tactics ?? null) : null,
    device: group.value === 'device' ? row.device : null,
    side: row.side,
    games: row.games,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    win_rate: row.winRate ?? null,
  }));

  /* global（无 device 过滤）30s 浏览器缓存；device=me 的过滤值在 X-Device-Id 头里，必须 no-store。 */
  c.header('Cache-Control', deviceParam === 'me' ? 'no-store' : 'public, max-age=30');
  return c.json({
    ok: true,
    group: group.value,
    game: game ?? null,
    channel: channel ?? null,
    device: deviceFilter,
    since: since.value,
    minGames: minGames.value,
    rows,
  });
});
