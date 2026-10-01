/**
 * Worker 绑定与环境变量类型（ADR-0010 / ADR-0011）。
 *
 * `wrangler.jsonc` 是唯一事实源；改绑定后跑 `npm run cf-typegen` 可重新生成
 * `worker-configuration.d.ts`，本文件只声明本项目实际用到的字段。
 */
export interface Env {
  /** D1：唯一权威持久化（ADR-0011） */
  DB: D1Database;
  /** 构建期注入的版本号（wrangler.jsonc 的 vars.APP_VERSION） */
  APP_VERSION: string;
  /** 站长兜底 key（访客自带 key 时不用；永不落盘、永不记日志）——ADR-0003 */
  TYPESAFE_API_KEY?: string;
  /**
   * `/api/jev` 的限流（次/分/IP，固定窗口）。缺省 30（`middleware/ratelimit.ts` 的 `RATE_LIMITS.jev`），
   * 生产设 60：机机对局的自然节奏（实测一个 60 秒窗口 34 次）会顶到 30，把整轮对比实验卡死。
   * 上限受 D1 免费额度约束——每个被计数的请求是一次写，60/分 ≈ 8.6 万写/日 < 10 万/日。
   */
  JEV_RATE_LIMIT_PER_MIN?: string;
}
