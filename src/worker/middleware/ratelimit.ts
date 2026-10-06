/**
 * 限流中间件（§5.3）：D1 固定窗口，取代旧实现里「isolate 内存 Map」（多实例下等于没有限流）。
 *
 * 计数键 = `kind:IP`。IP 取 `cf-connecting-ip`；本地 `wrangler dev` / 单测里没有这个头，
 * 回落成 `local`（此时所有本机请求共用一个桶——这正是本地想看到的行为：能触发 429）。
 *
 * 已知取舍（2026-10-06 起）：D1 的 `RETURNING count` 每次请求一次**写**。`read` 桶因此
 * **整体放行、不写库**——ADR-0013「后果」节原文预留「仅写接口与 /api/jev 计数，读接口
 * 不计数或采样」，旧实现对读接口也全量计数比 ADR 更严，且单 IP 满速读就能烧掉 17.3 万
 * 行写/日（免费档 10 万）。`jev` / `write` 两桶语义一字不动（含 429 与 Retry-After）。
 * 窗口是秒对齐的固定窗口（非滑动），允许边界处 2× 突发。
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

/**
 * §5.3 的三个桶：外部转发最贵（30/分），写入次之（20/分），读最宽（120/分）。
 * `read` 只作为「名义规则」保留（文档与测试引用它），中间件对它直接放行、不计数。
 */
export const RATE_LIMITS: Record<RateLimitKind, Rule> = {
  jev: { limit: 30, windowSeconds: 60 },
  write: { limit: 20, windowSeconds: 60 },
  read: { limit: 120, windowSeconds: 60 },
};

/**
 * 生效限额。只有 `jev` 桶可被 `env.JEV_RATE_LIMIT_PER_MIN` 覆盖，其余固定。
 *
 * 为什么 `jev` 需要可调（2026-10-01 的真实事故）：两方都是 Jev 的机机对局是**产品自带功能**
 * （对比实验），它的自然节奏实测能到 34 次/60 秒，正好顶穿 30——于是第 4 局还没开始就被自己的
 * 限流挡下，而客户端的表现是「重试次数用尽」（见 `src/core/jev/client.ts` 的注释）。生产值调成
 * 60 后仍有 1.7× 余量，同时把最坏情况的 D1 写量压在免费额度内（60/分 × 1440 = 8.6 万 < 10 万/日）。
 */
export function limitsFor(env: { JEV_RATE_LIMIT_PER_MIN?: string } | undefined): Record<RateLimitKind, Rule> {
  const raw = Number(env?.JEV_RATE_LIMIT_PER_MIN);
  if (!Number.isFinite(raw) || raw < 1) return RATE_LIMITS;
  return { ...RATE_LIMITS, jev: { ...RATE_LIMITS.jev, limit: Math.floor(raw) } };
}

/** 清理概率：限流表只增不减，用 1% 的请求顺手删掉 1 小时前的窗口（§5.3）。 */
const PRUNE_PROBABILITY = 0.01;
const PRUNE_RETENTION_SECONDS = 3600;

export function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

export function rateLimit(kind: RateLimitKind) {
  return createMiddleware<AppEnv>(async (c, next) => {
    /* 读桶放行（ADR-0013 原文口径）：不写 rate_limits、不给 X-RateLimit-* 头、不 429。
     * 读请求的 D1 成本只剩查询本身；防滥用交给 Cloudflare 边缘与 D1 的读取配额。 */
    if (kind === 'read') {
      await next();
      return;
    }

    const rule = limitsFor(c.env)[kind];
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
