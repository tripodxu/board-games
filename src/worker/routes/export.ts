/**
 * `GET /api/export/games` —— JSONL 批量导出（计划 §5.1 末行、§7 批量导出）。
 *
 * 用途：备份与迁移对账（`wrangler d1 export` 之外的第二份可读快照），以及「导出后可完整重建库」。
 *
 * ── 为什么是 JSONL 而不是一个大 JSON 数组 ─────────────────────────────────
 * 一个 5 万局的数组要先把所有行读进内存再序列化，Worker 的内存上限下必然炸；JSONL 可以
 * **边读边写**，用不上的局（`since` 之前的）当场丢掉，客户端也能流式落盘。
 *
 * ── 旧行为 → 新行为 ───────────────────────────────────────────────────────
 *
 * | 项 | 旧实现 | 新行为 | 等价？ |
 * |---|---|---|---|
 * | 导出端点 | **没有**（数据在 git 仓库里 = 天然有一份） | 新增本端点（计划 §5.1/§7） | ➕ 新能力（D5 之后 D1 是唯一权威，必须能导出） |
 * | 行内容 | 仓库里的 `games/<day>/<slug>.json` 原文（`JSON.stringify(body, null, 2)`） | 每行一个 JSON 对象：**落库列 + `payload` 原文**。`payload` 是 `insertGame` 存进去的保真副本，所以「导出 → 重新导入」可复原；缩进被去掉（JSONL 每行必须单行） | ⚠️ 内容等价、空白不等价 |
 * | 空结果 | 旧 `GET /api/games` 空目录返回 `{ok:true, games:[]}` | **200 + 空体**（0 字节，不是 404、也不是 `[]`）：JSONL 的「零行」就是零字节，客户端 `split('\n')` 天然得到空数组 | ➕ 语义明确 |
 * | 权限 | 旧静态站所有棋谱都在公开 git 仓库里 | **公开**（D4 明确匿名 + 全站公共数据；计划 §13.3 不做权限）。限流 120/分/IP 是唯一闸门 | ✅ 威胁模型不变 |
 * | 翻页 | 旧 `GET /api/games` 硬编码「最近 7 天目录」，无游标 | 内部 keyset 游标循环（`listGames` 每页 `MAX_LIST_LIMIT`），对客户端是**一个连续流**，没有分页参数 | ✅ 计划 §5.1「不再 7 天窗口、不再截断」 |
 *
 * ── 跟踪 `deviceMiddleware` 但不按设备过滤 ─────────────────────────────────
 * 链是 `rateLimit('read') → deviceMiddleware`（计划 §5.2 的顺序）。中间件负责校验
 * `X-Device-Id` 格式（非法直接 400），但**导出不按设备过滤**——备份要的是全集；
 * 想只看自己的设备，用 `GET /api/games?device=`（另有路由）。
 *
 * ── 查询成本（2026-10-06 优化后） ─────────────────────────────────────────
 * 旧实现是 N+1：`listGames` 刻意不取 payload，每局再串行 `getGame`（2 条 SQL，
 * 其中 moves 导出用不到却照样读）——936 局 ≈ 1882 次串行往返 / ~5.9 万行读取。
 * 现在 `db/games.ts` 提供 `listGameDetails`（技术债 #3 销账）：**每页固定 2 次往返**
 * （主行+payload 一条、整页逐手明细 `IN` 一条），返回行与 getGame 逐字段同构。
 * 页大小 `PAYLOAD_PAGE_LIMIT = 25`：payload 均值 ~13 KB（阶梯导入后），25 行把单页
 * 响应压在 D1 单查询限额内（最坏 25 × 45 KB ≈ 1.1 MB）；936 局 ≈ 38 页 ≈ 76 次往返。
 * 单次导出的上界仍由 `MAX_EXPORT_GAMES` 兜住；行读取 ≈ 局数 + 逐手数（真实成本），
 * 对比免费版每日 500 万行读取配额可忽略。
 */
import { Hono } from 'hono';
import { listGameDetails } from '../db/index.ts';
import { deviceMiddleware } from '../middleware/device.ts';
import { rateLimit } from '../middleware/ratelimit.ts';
import { GAME_IDS } from '../../shared/record-map.ts';
import { fail, invalid, parseDayParam, parseEnumParam } from '../lib/validate.ts';
import type { Parsed } from '../lib/validate.ts';
import type { AppEnv } from '../types.ts';

export const exportRoute = new Hono<AppEnv>();

/**
 * 单次导出的硬上限：5000 局。
 *
 * 依据（都是可算的，不是拍的）：
 *  - 规模：仓库历史归档 54 局、单日实测最多 33 局（计划 §2.3）。5000 局 ≈ 150 天满产，
 *    远超任何一次「备份/对账」的合理范围；再大就该用 `wrangler d1 export`（流式、无上限）。
 *  - 行读取：5000 × 2 ≈ 1 万行，占免费版每日 500 万行读取配额的 0.2%（§4.4）。
 *  - 时长：5000 局的 D1 往返 + JSON 序列化远小于 Workers 的响应时长上限；
 *    而 Workers **CPU** 限制不约束 I/O 等待，序列化每行只占几微秒。
 *  - 响应体：5000 × 中位 7.2 KB ≈ 36 MB，正是「必须流式」的量级——本端点不缓冲，
 *    所以内存占用与总量无关（这也是选 JSONL 的另一个原因）。
 * 触发上限时响应仍会正常结束，只是少了更早的局；截断只记在日志里（原因见文件末尾注释）。
 */
export const MAX_EXPORT_GAMES = 5000;

/**
 * 每页拉取的局数：按 **payload 体积**而不是行数定的——payload 均值 ~13 KB、最坏 ~45 KB
 * （阶梯导入后），25 行把单页响应压在 D1 单查询限额内，同时 936 局只要 ~38 页。
 * 刻意不复用 `MAX_LIST_LIMIT`（100）：那是给「不含 payload 的列表行」定的上限，
 * 两个口径不该共用一个常量。
 */
const PAYLOAD_PAGE_LIMIT = 25;

export interface ExportGamesParams {
  /** 精确到某一天（UTC）。 */
  day: string | null;
  /** 起始日（含当天），等价于 `day >= since`。 */
  since: string | null;
  /** 棋种引擎 id（`gomoku` / `go` / …），经 `GAME_IDS` 白名单校验。 */
  gameId: string | null;
}

/**
 * 查询参数校验。全部走 `lib/validate.ts`，错误码统一 `bad_request`。
 *
 * `day` 与 `since` 同时给出直接拒绝：两者语义冲突（一个精确、一个范围），
 * 让调用方选一个，比悄悄忽略其中一个更可预测。
 */
export function parseExportParams(query: { get: (name: string) => string | undefined }): Parsed<ExportGamesParams> {
  const day = parseDayParam(query.get('day'));
  if (!day.ok) return day;
  const since = parseDayParam(query.get('since'));
  if (!since.ok) return since;
  /* `''` 是「没给 game」的哨兵：`parseEnumParam` 的 fallback 只用于「raw 为空」的分支，
   * 给了非法值它已经在上面返回 `bad_request` 了。用 `GAME_IDS` 而不是自建列表，
   * 是为了和 `shared/record-map.ts` 的棋种表保持单一事实源。 */
  const game = parseEnumParam(query.get('game'), GAME_IDS, '');
  if (!game.ok) return game;

  if (day.value && since.value) {
    return invalid('bad_request', 'day 与 since 语义冲突，请只给其中一个');
  }
  return { ok: true, value: { day: day.value, since: since.value, gameId: game.value || null } };
}

/** 下载文件名：`jev-games-<day|since|all>.jsonl`（任务书逐字要求的形状）。 */
export function exportFilename(params: ExportGamesParams): string {
  return `jev-games-${params.day ?? params.since ?? 'all'}.jsonl`;
}

/**
 * 分页循环 + 逐行产出（每页 2 次 D1 往返：主行+payload、整页逐手明细）。
 *
 * 三个终止条件：
 *  1. `nextCursor === null`（`listGameDetails` 用它表示没有下一页）；
 *  2. 达到 `max` 局硬上限（置 `truncated`，见 `MAX_EXPORT_GAMES` 的注释）；
 *  3. `signal.aborted`（客户端断开——多数情况下查询已经抛错，这里是兜底，
 *     保证循环能退出、流能被正常收掉）。
 *
 * **提前 return 的依据**：`since` 过滤下，行按 `id DESC` 输出，而 `games.id` 是自增的
 * （`created_at` 与 id 同向递增，历史导入也是按时间序批插）。一旦遇到早于 `since` 的局，
 * 后面的只会更早，所以直接停——否则「只导最近一天」会白扫完整个表。
 */
async function writeJsonl(
  controller: ReadableStreamDefaultController<Uint8Array>,
  opts: { db: D1Database; params: ExportGamesParams; max: number; signal: AbortSignal },
): Promise<{ exported: number; truncated: boolean }> {
  const encoder = new TextEncoder();
  let cursor: number | undefined;
  let exported = 0;

  for (;;) {
    const page = await listGameDetails(opts.db, {
      day: opts.params.day ?? undefined,
      gameId: opts.params.gameId ?? undefined,
      cursor,
      limit: PAYLOAD_PAGE_LIMIT,
    });

    for (const game of page.games) {
      if (opts.signal.aborted) return { exported, truncated: false };
      // `since` 是定长字符串，字典序即日期序，不需要转 Date。
      if (opts.params.since && game.day < opts.params.since) return { exported, truncated: false };
      if (exported >= opts.max) return { exported, truncated: true };

      controller.enqueue(encoder.encode(`${JSON.stringify(game)}\n`));
      exported += 1;
    }

    if (page.nextCursor === null) return { exported, truncated: false };
    cursor = page.nextCursor;
  }
}

exportRoute.get('/games', rateLimit('read'), deviceMiddleware, async (c) => {
  const parsed = parseExportParams({ get: (name) => c.req.query(name) });
  if (!parsed.ok) return fail(c, parsed);
  const params = parsed.value;

  const db = c.env.DB;
  const signal = c.req.raw.signal;
  const requestId = c.get('requestId');

  /* 条数/截断只能在流跑完后知道，而那时响应头早已发出（见文件末尾注释），
   * 所以这里接住结果，只用于日志。 */
  let progress = { exported: 0, truncated: false };

  const stream = new ReadableStream<Uint8Array>({
    /** 返回的 Promise 会被 await：流在第一次写之前不会对客户端可见（首字节因此不早于第一页）。 */
    async start(controller) {
      try {
        progress = await writeJsonl(controller, { db, params, max: MAX_EXPORT_GAMES, signal });
        controller.close();
      } catch (error) {
        /* 客户端断开多半在这里表现为异常（workerd 把取消信号抛进 await 点）：
         * 那不是服务端故障，静默收流即可，免得每次中断的下载都在日志里报一条错误。 */
        if (signal.aborted) {
          controller.close();
          return;
        }
        controller.error(error);
      } finally {
        console.log(
          `[export] requestId=${requestId} exported=${progress.exported} truncated=${progress.truncated} ` +
            `day=${params.day ?? '-'} since=${params.since ?? '-'} game=${params.gameId ?? '-'}`,
        );
      }
    },
  });

  /* 直接构造 Response 而不是 `c.body(stream, 200)`：Hono 的 `Data` 把流窄化成
   * `Uint8Array<ArrayBuffer>`，而 `ReadableStream<Uint8Array>` 的 buffer 是
   * `ArrayBufferLike`，赋值会报 TS2322（运行时本来就一样）。`new Response` 的
   * `BodyInit` 接受任意 `ReadableStream`，且**不会**缓冲——流式转发要的正是这个。
   * 头必须在这里一次给全：流一开始写，响应头就固定了。 */
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(params)}"`,
      'Cache-Control': 'no-store',
    },
  });
});

export default exportRoute;

/* ── 关于「响应里没带 X-Export-Count / X-Export-Truncated」 ───────────────────
 * 试过的两种做法都不成立：
 *  1. 先跑完分页、算出总数再设头 → 就变成「先缓冲整个响应」，与 JSONL 流式的初衷相反；
 *  2. 流的尾部落一行 `{"__meta":{...}}` → 破坏「每行一局」的契约（调用方要按局解析），
 *     而且重新导入时会多出一条脏行。
 * 所以：条数 = 行数（客户端自己数），截断只在**日志**里体现（Worker 可观测性收集，
 * 计划 §5.6）。要强一致的对账请用 `wrangler d1 export`。
 */
