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
  /**
   * 兜底提供方的 key（commandcode，C2 / D-B4）。**默认不配**——没配时 `/api/jev` 的行为与
   * 加兜底之前逐字相同（只打 TypeSafe 主家）。配置方式：`wrangler secret put COMMANDCODE_API_KEY`。
   * 永不记日志、不进 URL、不入库。
   */
  COMMANDCODE_API_KEY?: string;
  /**
   * 是否让 `/api/jev` **自动**启用兜底切换（C2 / D-B2）。合法值 `"on"`；缺省/其它值 = 关。
   *
   * 关着也仍可用兜底：客户端显式带 `X-Jev-Provider: backup` 时（切换已发生后，局内粘滞）只用兜底。
   * 之所以默认关：切到第三方网关会改变「这一手是谁答的」，生产路径要不要这么干由业主拍板
   * （计划 §7 未决项），实验面不受影响（box 直连不经过本 Worker）。
   */
  JEV_FAILOVER?: string;
}
