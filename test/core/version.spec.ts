/* 版本号只有一个来源，但落在两个文件里 —— 这里把它钉住。
 *
 * 为什么需要这个 spec：前端版本是**构建期注入**的（`vite.config.ts` 读 `package.json` 的
 * `version` → `__APP_VERSION__` → `src/shared/version.ts` 的 `CODE_VERSION`），而 Worker
 * 的 `/api/health` 版本读的是**运行时绑定** `wrangler.jsonc` 的 `vars.APP_VERSION`。
 * 两处都要人手改，迁移期就漂过一次（前端 `0.3.0+sha` vs Worker `1.0.0`），于是有了这道闸：
 * 一旦两边不一致，这里立刻红，而不是等用户发现「棋谱写的版本和探活报的不是一个东西」。
 *
 * 注意 `wrangler.jsonc` 是 JSONC（带注释），所以不能直接 `JSON.parse`；只取一个字段，
 * 用正则比剥注释更稳（剥注释要处理字符串里的 `//`）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);

function readRoot(rel: string): string {
  return readFileSync(new URL(rel, ROOT), 'utf8');
}

const pkg = JSON.parse(readRoot('package.json')) as { name?: string; version?: string };
const wrangler = readRoot('wrangler.jsonc');
const appVersion = /"APP_VERSION"\s*:\s*"([^"]*)"/.exec(wrangler)?.[1] ?? null;

describe('版本号一致性', () => {
  it('package.json 的 version 是语义化版本', () => {
    expect(typeof pkg.version).toBe('string');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('wrangler.jsonc 声明了 vars.APP_VERSION', () => {
    expect(appVersion).not.toBeNull();
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('Worker 的 APP_VERSION 与前端注入的 package.json version 逐字相同', () => {
    /* 期望值也打出来：否则失败信息只有「'0.3.0' !== '1.0.0'」，看不出谁该改。 */
    expect({ packageJson: pkg.version, wranglerVars: appVersion }).toEqual({
      packageJson: pkg.version,
      wranglerVars: pkg.version,
    });
  });

  it('构建期注入用的是 package.json 的 version（vite define 没被改成别的来源）', () => {
    const viteConfig = readRoot('vite.config.ts');
    expect(viteConfig).toContain('__APP_VERSION__');
    expect(viteConfig).toContain('pkg.version');
  });
});
