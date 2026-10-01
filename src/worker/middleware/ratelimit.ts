/**
 * 限流中间件（§5.3）：D1 固定窗口，取代旧实现里「isolate 内存 Map」（多实例下等于没有限流）。
 *
 * 计数键 = `kind:IP`。IP 取 `cf-connecting-ip`；本地 `wrangler dev` / 单测里没有这个头，
 * 回落成 `local`（此时所有本机请求共用一个桶——这正是本地想看到的行为：能触发 429）。
 *
 * 已知取舍：D1 的 `RETURNING count` 每次请求一次**写**，所以读接口的限流也会消耗写配额。
 * 这是「跨实例一致」必须付的代价；窗口是秒对齐的固定窗口（非滑动），允许边界处 2× 突发。
 */
import { createMiddleware } from 'hono/factory';
import { hitRateLimit, pruneRateLimits, windowStartOf } from '../db/index.ts';
import { errorBody, statusFor } from '../lib/http.ts';
import type { AppEnv } from '../types.ts';

export type RateLimitKind = 'jev' | 'write' | 'read';

interface Rule {
  limit: number;
  windowSeconds: number;
}

/** §5.3 的三个桶：外部转发最贵（30/分），写入次之（20/分），读最宽（120/分）。 */
export const RATE_LIMITS: Record<RateLimitKind, Rule> = {
  jev: { limit: 30, windowSeconds: 60 },
  write: { limit: 20, windowSeconds: 60 },
  read: { limit: 120, windowSeconds: 60 },
};

/** 清理概率：限流表只增不减，用 1% 的请求顺手删掉 1 小时前的窗口（§5.3）。 */
const PRUNE_PROBABILITY = 0.01;
const PRUNE_RETENTION_SECONDS = 3600;

export function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

export function rateLimit(kind: RateLimitKind) {
  const rule = RATE_LIMITS[kind];
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = `${kind}:${clientIp(c)}`;
    const now = Date.now();
    const result = await hitRateLimit(c.env.DB, key, rule.limit, rule.windowSeconds, now);

    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.resetAt));

    if (Math.random() < PRUNE_PROBABILITY) {
      const before = windowStartOf(now, rule.windowSeconds) - PRUNE_RETENTION_SECONDS;
      try {
        c.executionCtx.waitUntil(pruneRateLimits(c.env.DB, before));
      } catch {
        /* 没有 ExecutionContext 的调用场景（直调 handler 的单测）忽略：清理只是优化 */
      }
    }

    if (!result.allowed) {
      const retryAfter = Math.max(1, result.resetAt - Math.floor(now / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json(
        errorBody('rate_limited', `请求过于频繁，请 ${retryAfter} 秒后重试`, c.get('requestId')),
        statusFor('rate_limited'),
      );
    }

    await next();
  });
}
