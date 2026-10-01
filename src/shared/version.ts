/**
 * 版本常量（ADR-0012 §7）：构建期注入，退役「手工 bump codeVersion 忘记就归因失效」。
 *
 * - `APP_VERSION`：package.json 的 version（Vite define 注入）
 * - `BUILD_SHA`  ：git short sha（Vite define 注入；无 git 时为 'nogit'）
 *
 * Node 侧（引擎自检）直接加载本文件时两个常量都未注入，回落到 'dev' / 'nogit'，
 * 因此 `typeof` 判断必须保留（`typeof 未声明标识符` 是唯一安全的探测方式）。
 */
declare const __APP_VERSION__: string | undefined;
declare const __BUILD_SHA__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const BUILD_SHA: string = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'nogit';

/** 棋谱归因用的代码版本串：一局棋属于哪一版代码，看它 */
export const CODE_VERSION = `${APP_VERSION}+${BUILD_SHA}`;
