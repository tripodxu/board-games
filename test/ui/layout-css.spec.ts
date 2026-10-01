/**
 * 布局稳定化契约（自旧套件 `test/run-tests.cjs:212-222` 的 `layoutContractTests` 移植）。
 *
 * 病灶：`main` 第一列若写成 `auto`（吃掉剩余空间），侧栏 `minmax(380px,490px)` 就会随页签内容
 * 宽度变化，切页签时棋盘被 `#board{max-width:100%}` 重新缩放 —— 棋盘宽度忽大忽小。
 * 契约因此是两条：① 侧栏列只随**视口**变化；② 根元素预留滚动条槽（滚动条出现/消失不得引起跳变）。
 *
 * P8 已把样式搬进 `styles/`（旧路径 `css/style.css` 随旧实现删除），这里自动探测目录并
 * **拼接目录下所有 `.css`**：契约可能落在 `styles/layout.css`、`scrollbar-gutter` 可能落在
 * `styles/base.css`。旧套件删除后（P8），这两条断言的唯一执行点就是本文件。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** 棋盘列（内容无关）+ 侧栏列（视口相关定宽）。 */
const GRID_CONTRACT = /grid-template-columns:\s*minmax\(430px,\s*1fr\)\s+clamp\(380px,\s*31vw,\s*430px\)/;

interface StyleSource {
  /** 相对仓库根，例如 `styles` 或迁移期的 `css`。 */
  dir: string;
  files: string[];
  css: string;
}

function loadStyles(): StyleSource {
  for (const dir of ['styles', 'css']) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    const files = readdirSync(abs)
      .filter((name) => name.endsWith('.css'))
      .sort();
    if (files.length === 0) continue;
    return {
      dir,
      files,
      css: files.map((name) => readFileSync(join(abs, name), 'utf8')).join('\n'),
    };
  }
  throw new Error('未找到样式目录（styles/ 或 css/）');
}

describe('布局稳定化契约', () => {
  const src = loadStyles();

  it('扫到的是真样式表，而不是空目录', () => {
    expect(src.files.length, `${src.dir}/ 下应有 .css 文件`).toBeGreaterThan(0);
    expect(src.css.length, `${src.dir}/ 拼接后的样式应像一张真样式表`).toBeGreaterThan(2000);
  });

  it('main 为「内容无关棋盘列 + 视口相关定宽侧栏」', () => {
    const main = src.css.match(/main\s*\{[^}]*\}/);
    expect(main, '应能抽到 main 规则块').not.toBeNull();
    expect(
      GRID_CONTRACT.test(main![0]),
      `main 应写成 minmax(430px, 1fr) clamp(380px, 31vw, 430px)，实际：${main![0].replace(/\s+/g, ' ')}`,
    ).toBe(true);
  });

  it('根元素预留滚动条槽（scrollbar-gutter: stable）', () => {
    expect(
      /scrollbar-gutter:\s*stable/.test(src.css),
      'html 应预留滚动条槽：滚动条出现/消失不得引起棋盘宽度跳变',
    ).toBe(true);
  });
});
