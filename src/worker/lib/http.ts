/**
 * API 响应与错误约定（ADR-0010 §5.5）。
 *
 * 关键约束：`/api/*` 的未命中**必须**返回 JSON 404——CF Pages 的 SPA 兜底会把
 * 未知 API 变成 `index.html + 200`，前端只能靠 JSON 解析失败来兜（历史坑）。
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ApiErrorCode =
  | 'not_found'
  | 'bad_request'
  | 'unauthorized'
  | 'invalid_payload'
  | 'payload_too_large'
  | 'rate_limited'
  | 'upstream_error'
  | 'internal';

export function errorBody(code: ApiErrorCode, message: string, requestId?: string) {
  return { error: message, code, requestId: requestId ?? null };
}

/**
 * 错误码 → HTTP 状态（§5.5：4xx 不重试、5xx 可重试）。
 * 集中在这里而不是各路由自己写 `c.json(..., 400)`，避免同一个码在不同路由给出不同状态。
 * 返回类型必须是 `ContentfulStatusCode`（Hono 的 `c.json` 只接受带实体的状态码，
 * 否则 `c.json(body, statusFor(code))` 在类型层就报 no overload）。
 */
export function statusFor(code: ApiErrorCode): ContentfulStatusCode {
  switch (code) {
    case 'not_found':
      return 404;
    case 'bad_request':
      return 400;
    case 'unauthorized':
      return 401;
    case 'invalid_payload':
      return 422;
    case 'payload_too_large':
      return 413;
    case 'rate_limited':
      return 429;
    case 'upstream_error':
      return 502;
    default:
      return 500;
  }
}

export function jsonNotFound(c: Context, requestId?: string) {
  return c.json(errorBody('not_found', '接口不存在', requestId), 404);
}
