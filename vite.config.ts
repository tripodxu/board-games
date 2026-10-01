/**
 * Vite 配置（ADR-0012）。
 *
 * 开发：`npm run dev` —— @cloudflare/vite-plugin 在 workerd 里跑 Worker（含 D1 绑定），
 *       前端走 Vite HMR，两者同一进程同一端口。
 * 构建：`npm run build` —— 产物由插件分流（client 资源 + worker bundle），
 *       `wrangler deploy` 读取插件生成的部署重定向配置。
 *
 * 注意：vitest 用独立的 vitest.config.ts（本文件的 cloudflare 插件不参与测试运行）。
 */
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** 构建期版本注入（ADR-0012 §7）：package.json version + git short sha */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'nogit'; // 无 git 环境（CI 的 shallow clone / 打包分发）不阻断构建
  }
}

export default defineConfig({
  plugins: [cloudflare()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(gitSha()),
  },
  build: {
    // Worker 环境下不需要 sourcemap 的体积开销（排障用 observability 日志）
    sourcemap: false,
    // rapfi/ 有 9.57 MB 的 .data，属静态资产（public/），不计入 chunk 警告阈值
    chunkSizeWarningLimit: 2048,
  },
  server: {
    port: 8787,
    strictPort: false,
  },
});
