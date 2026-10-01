/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * 1) 让 TS 认识 `cloudflare:test`（pool-workers 的类型入口在 `./types` 子路径，
 *    不在包根的 types 字段里，所以只能这样引）。
 * 2) 声明 pool-workers 注入的额外绑定（wrangler.jsonc 里没有，只在测试期存在），
 *    与 worker-configuration.d.ts 的 `Cloudflare.Env` 合并。
 *
 * 本文件必须是**全局脚本**（无顶层 import/export），否则下面的 namespace 声明
 * 会变成模块局部声明，合并不进 Cloudflare.Env。
 */
declare namespace Cloudflare {
  interface Env {
    /** vitest.config.ts 里由 readD1Migrations('./migrations') 注入 */
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
  }
}
