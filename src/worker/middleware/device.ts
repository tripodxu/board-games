/**
 * 匿名设备中间件（ADR-0013）。
 *
 * 只做两件事：把 `X-Device-Id` 校验后放进 `c.get('deviceId')`，不合法直接 400。
 *
 * 为什么不在这里 `touchDevice`：读接口（列表/统计/棋谱详情）也不带写语义，
 * 每个 GET 都写一行会白烧 D1 的每日 10 万行写配额；而 `games.device_id` 的外键
 * 只要求**写在设备行之前**，所以真正的 upsert 放在写路由里（`POST /api/games`、
 * `POST /api/experiments`）。代价是「只读用户的 last_seen 不刷新」，这是有意取舍。
 */
import { createMiddleware } from 'hono/factory';
import { errorBody, statusFor } from '../lib/http.ts';
import { parseDeviceId } from '../lib/validate.ts';
import type { AppEnv } from '../types.ts';

export const deviceMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const parsed = parseDeviceId(c.req.header('X-Device-Id'));
  if (!parsed.ok) {
    return c.json(errorBody(parsed.code, parsed.message, c.get('requestId')), statusFor(parsed.code));
  }
  c.set('deviceId', parsed.value);
  await next();
});
