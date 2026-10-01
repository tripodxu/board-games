/**
 * Worker 的 Hono 环境类型。
 *
 * 单独成文件是为了让「路由/中间件/入口」共用同一份 `Variables`：
 * 用 `as never` 到处强转（P1 骨架里的临时写法）会让 `c.get('deviceId')` 在拼错时静默变 null。
 */
import type { Env } from './env.ts';

export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** 每个请求一个 id（`cf-ray` 或本地合成），错误体与日志共用。 */
    requestId: string;
    /** 校验通过的 `X-Device-Id`；未提供或格式不合法时为 null（匿名身份可选，ADR-0013）。 */
    deviceId: string | null;
  };
};
