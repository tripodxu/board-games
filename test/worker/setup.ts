/**
 * worker project 的测试前置：把 migrations/ 重放到隔离的本地 D1。
 * 每个测试文件拿到一个干净的库（pool-workers 提供逐文件存储隔离）。
 */
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
