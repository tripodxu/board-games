/**
 * Vitest 配置（ADR-0012）：三个 project 各管一段。
 *
 *  - `worker`：在真 workerd + 本地 D1 上跑（@cloudflare/vitest-pool-workers v4 插件式 API）。
 *              SQL 语义、绑定行为与生产一致——这是「SQL 写错上线才发现」的防线。
 *  - `ui`    ：happy-dom 环境，跑对局循环与面板的运行时行为测试
 *              （取代原先读源码文本做字符串匹配的 DOM 契约断言）。
 *  - `core`  ：纯 Node 环境，跑 src/core 的纯逻辑单测（引擎自检另走 node test/run-tests.mjs）。
 *  - `scripts`：纯 Node 环境，跑 scripts/ 下工具链（scripts/lib、CLI/worker 的纯函数）的单测。
 */
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// 用 async 配置函数而不是顶层 await：两种情况都能跑（配置文件被按 CJS 打包时 TLA 会直接报错，
// package.json 现已是 "type": "module"，保留 async 形式更稳）。
export default defineConfig(async () => {
  // 迁移在测试里按文件顺序重放，测试库因此永远等于 migrations/ 的当前状态。
  const migrations = await readD1Migrations('./migrations');

  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              // 单 worker 实例：D1 是共享状态，测试用例自行清理，避免并行写冲突
              singleWorker: true,
              // 迁移文件以绑定形式注入，setup.ts 里 applyD1Migrations 落库
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: 'worker',
            include: ['test/worker/**/*.spec.ts'],
            setupFiles: ['./test/worker/setup.ts'],
            testTimeout: 20_000,
          },
        },
        {
          test: {
            name: 'ui',
            environment: 'happy-dom',
            // `test/ui` = 视图层（面板/棋盘/图表）断言；`test/app` = 装配层（对局循环、
            // 模式编排、降级路径）断言。两者同环境，分开只是为了让所有权边界一眼可见。
            include: ['test/ui/**/*.spec.ts', 'test/app/**/*.spec.ts'],
          },
        },
        {
          test: {
            name: 'core',
            environment: 'node',
            include: ['test/core/**/*.spec.ts'],
          },
        },
        {
          test: {
            name: 'scripts',
            environment: 'node',
            // 工具链单测：scripts/lib 纯函数 + worker 的 mock 冒烟（不打线上）
            include: ['test/scripts/**/*.spec.mjs'],
          },
        },
      ],
    },
  };
});
