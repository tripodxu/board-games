/**
 * Worker 入口（ADR-0010）。
 *
 * 路由约定：
 *  1. 具体业务路由（P3 逐步接入）注册在前；
 *  2. `/api/*` 的兜底处理器注册在后 —— **必须**返回 JSON 404，
 *     否则单页应用兜底会把未知 API 变成 HTML 200（历史坑，见 lib/http.ts）；
 *  3. 静态资源不经过本 Worker：`assets.run_worker_first = ["/api/*"]` 保证只有 API 进来。
 */
import { Hono } from 'hono';
import { experimentsRoute } from './routes/experiments.ts';
import { exportRoute } from './routes/export.ts';
import { gamesRoute } from './routes/games.ts';
import { healthRoute } from './routes/health.ts';
import { jevRoute } from './routes/jev.ts';
import { leaderboardRoute } from './routes/leaderboard.ts';
import { openingsRoute } from './routes/openings.ts';
import { statsRoute } from './routes/stats.ts';
import { errorBody, jsonNotFound } from './lib/http.ts';
import { runDailyMaintenance } from './maintenance.ts';
import type { AppEnv } from './types.ts';

export type { AppEnv };

const api = new Hono<AppEnv>();

api.route('/health', healthRoute);
api.route('/games', gamesRoute);
api.route('/stats', statsRoute);
api.route('/experiments', experimentsRoute);
api.route('/openings', openingsRoute);
api.route('/leaderboard', leaderboardRoute);
api.route('/jev', jevRoute);
api.route('/export', exportRoute);

const app = new Hono<AppEnv>();

/* Hono 应用本体**单独具名导出**：测试要拿它做 `routes` 自省（判断某条路由有没有挂上），
 * 直接 import 默认导出会拿到下面的 handler 对象。默认导出仍是部署入口。 */
export { app };

/* 请求 id：贯穿日志与错误体，便于按一次调用排障。
 *
 * 注册在 **app** 而不是 `api` 子应用上：`/api/*` 的兜底 404 由 app 层处理，业务路由
 * 一个都没命中时子应用中间件根本不会跑 —— 挂在子应用上会让这类响应带回
 * `requestId: null`（线上实测 `/api/nope` 就是这样，其余错误体都带 id，排障时对不上）。 */
app.use('*', async (c, next) => {
  const requestId =
    c.req.header('cf-ray') ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});

app.route('/api', api);

/* API 未命中：JSON 404（绝不能落到 SPA 兜底）。requestId 必须显式传进去：
 * `jsonNotFound` 的第二个参数缺省是 `undefined`，错误体会退化成 `requestId: null`。 */
app.all('/api/*', (c) => jsonNotFound(c, c.get('requestId')));

/* 未捕获异常：统一 JSON + requestId，不泄漏堆栈 */
app.onError((err, c) => {
  console.error(`[worker] unhandled requestId=${c.get('requestId')}`, err instanceof Error ? err.stack : String(err));
  return c.json(errorBody('internal', '服务端异常', c.get('requestId')), 500);
});

/* 入口从「直接导出 Hono 应用」改成显式 handler 对象：Cron Trigger（wrangler.jsonc 的
 * `triggers.crons`）指向的就是 `scheduled`。fetch 仍走同一个 app，行为不变。
 *
 * `fetch` 写成箭头转发而不是 `fetch: app.fetch`：Hono 的 fetch 虽已绑定实例，但显式转发
 * 不依赖它的实现细节，也让这里的三参数签名一眼可见。 */
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    /* 维护失败不能静默：日志留在 Cron 调用里（wrangler tail 可见），异常继续冒给平台。 */
    ctx.waitUntil(
      runDailyMaintenance(env).catch((err: unknown) => {
        console.error('[maintenance] 每日维护失败', err instanceof Error ? err.stack : String(err));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
