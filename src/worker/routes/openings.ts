/**
 * 开具体验路由（计划 §5.1 新增：`GET /api/openings`，把 `buildExperience()` 的本机扫描
 * 换成跨设备 SQL 聚合，喂给引擎的 `state.experience`）。
 *
 * 口径依据与对齐关系：
 *
 * 1. **SQL 形状对齐 §4.3 草案**（docs/plans/2026-10-01-workers-d1-rebuild.md:308-312）：
 *    `SELECT opening_prefix, COUNT(*) AS games, AVG(CASE WHEN winner='black' THEN 1.0 ELSE 0.0 END)
 *     AS black_win_rate FROM games WHERE game_id = ?1 AND mock = 0
 *     GROUP BY opening_prefix HAVING COUNT(*) >= 2 ORDER BY games DESC LIMIT 20;`
 *    ——分组键仍是 `opening_prefix` 整串（列注释就是「前 4 手，供 state.experience 注入查询」，
 *    migrations/0001_init.sql:36），`HAVING >= 2` 与 `LIMIT 20` 也照抄；本文件只把草案里
 *    缺失的 `white`/`draw` 计数补成显式三列，并把 `LIMIT` 参数化（默认 20、上限 100）。
 *
 * 2. **为什么滤镜掉 mock**：与 §4.3 草案一致（`mock = 0`）。旧 `js/app.js:375-391` 的
 *    `buildExperience()` 也显式跳过 `r.mock`——离线盘面演示不该污染真实开局统计。
 *
 * 3. **`opening` 精确查询模式的口径来自旧实现本身**：旧 `buildExperience()` 的匹配条件是
 *    `r.notas.length >= prefix.length && prefix.every((x, i) => r.notas[i] === x)`，
 *    即「本局的前 k 手恰好等于当前前缀」。SQL 侧用 `opening_prefix = ? OR instr(opening_prefix, ? || ',') = 1`
 *    复刻这个「字符串前缀 + 必须是完整一手」的语义（用 `instr` 而不是 `LIKE`，因为棋谱记号
 *    里可能出现 `_`/`%` 这类 LIKE 元字符，`instr` 只做字面匹配，不需要转义）。
 *    注意列只存前 4 手（`insertGame` 里 `moves.slice(0, 4)`，src/worker/db/games.ts），
 *    所以 `opening` 超过 4 手时必然查不到——这一条限制写在这里，不藏在调用方。
 *
 * 4. **`black_win_rate` 的分母是全部局（含和棋/未终局）**：这是 `AVG(CASE WHEN winner='black' THEN 1.0 ELSE 0.0 END)`
 *    的直接语义，也是 §4.3 草案写的；`js/app.js` 的 `first_player_win_rate: Math.round(fw/n*100)/100`
 *    同样是 `fw / 全部匹配局数`（n 是全部匹配局，不是已分胜负的局）。所以这里**不**改成
 *    `wins/(wins+losses)`——那会和旧前端算出的经验值对不上。四舍五入到 2 位也与旧实现一致。
 *
 * 5. **`plies` 是调用方给的前缀手数**（不是「本局下了几手」）：它只用于回显与限制，
 *    过滤完全交给字符串前缀比较。
 *
 * 6. **精确查询模式下额外给一条 `summary`**：分组键始终是 `opening_prefix` 整串（照抄草案），
 *    所以传 `opening=H8,H9` 时返回的 `openings` 是「以 H8,H9 开头的各个完整开局」若干行，
 *    **而不是**这一前缀的合并行。合并行单列在 `summary` 里（同一套 WHERE、去掉 GROUP BY/HAVING
 *    的纯聚合）。为什么必须单列：`HAVING COUNT(*) >= minGames` 会隐藏样本不足的分组，
 *    调用方若自己把 `openings` 各行相加就会漏算——`summary` 永远是全量匹配局的真值。
 *    `summary.games >= minGames` 顺手翻译成 `enough`，对应旧 `buildExperience()` 里
 *    「n < 2 就不注入 experience」那一步判断。
 */
import { Hono } from 'hono';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../db/index.ts';
import { GAME_IDS } from '../../shared/record-map.ts';
import { fail, invalid, parseDayParam, parseEnumParam, parseLimitParam } from '../lib/validate.ts';
import { deviceMiddleware } from '../middleware/device.ts';
import { rateLimit } from '../middleware/ratelimit.ts';
import type { AppEnv } from '../types.ts';

/** 对局模式：取值同 `migrations/0001_init.sql:29` 的列注释；`all` 表示不过滤（默认，贴合 §4.3）。 */
const MODES = ['all', 'ai-ai', 'human-ai', 'pvp'] as const;

/** `opening` 前缀串的长度上限（4 手记号，正常远低于此；挡住异常长的输入撑爆绑定参数）。 */
const MAX_OPENING_CHARS = 128;

/** SQL 聚合出的计数列（分组行与合并行共用；`blackWinRate` 在无样本时是 NULL）。 */
interface OpeningCounts {
  games: number;
  blackWins: number;
  whiteWins: number;
  draws: number;
  blackWinRate: number | null;
}

/** 一个分组（= 一个开局前缀）的统计行。数值列都是 SQL 侧聚合产物，JS 只做类型搬运。 */
interface OpeningRow extends OpeningCounts {
  opening: string;
}

/** 精确前缀的合并统计行（无 `opening` 列，其余同上）。 */
type OpeningSummaryRow = OpeningCounts;

/** 把 SQL 的 snake/camel 之别抹平，并统一把 NULL 胜率落成 0（无样本时 AVG 返回 NULL）。 */
function toPublicRow(row: OpeningCounts) {
  return {
    games: row.games,
    black_wins: row.blackWins,
    white_wins: row.whiteWins,
    draws: row.draws,
    black_win_rate: row.blackWinRate ?? 0,
  };
}

export const openingsRoute = new Hono<AppEnv>();

/**
 * 开具体验统计。
 *
 * 参数：
 * - `game`（**必填**）：棋种 id，必须在 `GAME_IDS` 里，否则 400；
 * - `opening`（可选）：要精确匹配的开局前缀（逗号分隔，如 `H8,H9`）；
 *   给了就只返回这一条聚合（0 或 1 行），用于运行期「当前前 k 手 → 跨设备胜率」；
 * - `mode`（可选）：`all`（默认）| `ai-ai` | `human-ai` | `pvp`；
 * - `since`（可选）：`YYYY-MM-DD`，按派生列 `day >= ?`；
 * - `min`（可选）：样本下限，默认 2（= 草案的 `HAVING COUNT(*) >= 2`）；
 * - `limit`（可选）：最多返回几个开局，默认 20（= 草案 `LIMIT 20`），上限 `MAX_LIST_LIMIT`。
 *
 * 只支持「下界」语义的一个隐藏收益：`min=1` 能拿到单局样本，但旧实现的注入门槛是 n ≥ 2，
 * 所以默认值保持 2，让「样本不足」这件事在 SQL 侧就消失，而不是让调用方每次自己判。
 */
openingsRoute.get('/', rateLimit('read'), deviceMiddleware, async (c) => {
  const game = c.req.query('game');
  if (game === undefined || game === '') {
    return fail(c, invalid('bad_request', 'game 是必填参数'));
  }
  if (!GAME_IDS.includes(game)) return fail(c, invalid('bad_request', `未知棋种：${game}`));

  const mode = parseEnumParam(c.req.query('mode'), MODES, 'all');
  if (!mode.ok) return fail(c, mode);

  const since = parseDayParam(c.req.query('since'));
  if (!since.ok) return fail(c, since);

  const minGames = parseLimitParam(c.req.query('min'), { max: MAX_LIST_LIMIT, fallback: 2 });
  if (!minGames.ok) return fail(c, minGames);

  const limit = parseLimitParam(c.req.query('limit'), {
    max: MAX_LIST_LIMIT,
    fallback: DEFAULT_LIST_LIMIT,
  });
  if (!limit.ok) return fail(c, limit);

  const opening = c.req.query('opening');
  if (opening !== undefined && opening !== '') {
    if (opening.length > MAX_OPENING_CHARS) {
      return fail(c, invalid('bad_request', `opening 不能超过 ${MAX_OPENING_CHARS} 个字符`));
    }
  } else if (opening === '') {
    return fail(c, invalid('bad_request', 'opening 不能为空字符串'));
  }
  const wanted = opening ? opening : null;

  /* 条件与绑定值一起按需拼（与 src/worker/db/stats.ts 的 buildFilter 同一手法）：
   * 不用 `?N IS NULL OR col = ?N`，那种写法会让 SQLite 放弃 idx_games_opening。 */
  const conditions = ["game_id = ?", "opening_prefix IS NOT NULL", "opening_prefix <> ''", 'mock = 0'];
  const binds: unknown[] = [game];
  if (mode.value !== 'all') {
    conditions.push('mode = ?');
    binds.push(mode.value);
  }
  if (since.value) {
    conditions.push('day >= ?');
    binds.push(since.value);
  }
  if (wanted) {
    /* 两次绑定同一个值：`opening_prefix = ?` 覆盖「本局正好只下了这些手」，
     * `instr(opening_prefix, ? || ',') = 1` 覆盖「本局在这些手之后还有后续」。 */
    conditions.push("(opening_prefix = ? OR instr(opening_prefix, ? || ',') = 1)");
    binds.push(wanted, wanted);
  }
  /* summary 用同一套条件重绑一次，所以在追加 minGames/limit 之前留一份条件绑定值。 */
  const filterBinds = [...binds];
  binds.push(minGames.value, limit.value);

  /* 全部分组/计数/求平均都在 SQL 侧完成（任务要求：禁止 SELECT * 回 JS 再算）。
   * `ROUND(AVG(...), 2)` 的 2 位小数对齐 js/app.js:375-391 的 `Math.round(fw/n*100)/100`。 */
  const result = await c.env.DB.prepare(
    `SELECT opening_prefix AS opening,
            COUNT(*) AS games,
            COALESCE(SUM(CASE WHEN winner = 'black' THEN 1 ELSE 0 END), 0) AS blackWins,
            COALESCE(SUM(CASE WHEN winner = 'white' THEN 1 ELSE 0 END), 0) AS whiteWins,
            COALESCE(SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END), 0) AS draws,
            ROUND(AVG(CASE WHEN winner = 'black' THEN 1.0 ELSE 0.0 END), 2) AS blackWinRate
       FROM games
      WHERE ${conditions.join(' AND ')}
      GROUP BY opening_prefix
     HAVING COUNT(*) >= ?
      ORDER BY games DESC, opening ASC
      LIMIT ?`,
  )
    .bind(...binds)
    .all<OpeningRow>();

  const openings = (result.results ?? []).map((row) => ({
    opening: row.opening,
    ...toPublicRow(row),
  }));

  /* 精确查询模式：同一套 WHERE 去掉 GROUP BY/HAVING 再聚合一次，得到「这一前缀的全量合并值」。
   * 不把 minGames/limit 塞进绑定，是因为这两个参数只约束 `openings` 分组，summary 要的是真值。 */
  let summary: (ReturnType<typeof toPublicRow> & { opening: string; plies: number; enough: boolean }) | null =
    null;
  if (wanted) {
    const agg = await c.env.DB.prepare(
      `SELECT COUNT(*) AS games,
              COALESCE(SUM(CASE WHEN winner = 'black' THEN 1 ELSE 0 END), 0) AS blackWins,
              COALESCE(SUM(CASE WHEN winner = 'white' THEN 1 ELSE 0 END), 0) AS whiteWins,
              COALESCE(SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END), 0) AS draws,
              ROUND(AVG(CASE WHEN winner = 'black' THEN 1.0 ELSE 0.0 END), 2) AS blackWinRate
         FROM games
        WHERE ${conditions.join(' AND ')}`,
    )
      .bind(...filterBinds)
      .first<OpeningSummaryRow>();
    const plies = wanted.split(',').length;
    const row = toPublicRow(agg ?? { games: 0, blackWins: 0, whiteWins: 0, draws: 0, blackWinRate: null });
    summary = { opening: wanted, plies, ...row, enough: row.games >= minGames.value };
  }

  /* 开局聚合不按设备过滤，过滤参数全在 URL 上 ⇒ 30s 浏览器缓存。 */
  c.header('Cache-Control', 'public, max-age=30');
  return c.json({
    ok: true,
    game,
    mode: mode.value,
    since: since.value,
    minGames: minGames.value,
    /* 只在精确查询模式下回报手数：列表模式下的键是「前 4 手整串」，手数由数据本身决定。 */
    plies: wanted ? wanted.split(',').length : null,
    opening: wanted,
    summary,
    openings,
  });
});

/* `draws` 的口径提醒（放这里而不是散在注释里）：`winner IS NULL` 同时涵盖「和棋」与
 * 「未终局/结果串解析失败」。旧口径用 `result` 子串判和棋（server.cjs:415-458 的 if/else-if），
 * 而 `winner` 列正是 `parseResult()` 的产物（src/shared/record-map.ts:244-251），
 * 在能解析的记录上两者一致；解析不了的旧记录在旧实现里三个计数都不进，在 winner 口径下
 * 会落进 draws——这是与旧实现唯一的口径差异，选择 winner 是因为它可索引且不用回表正则。 */
export const __drawsSemantics = 'winner IS NULL = 和棋或未终局';
