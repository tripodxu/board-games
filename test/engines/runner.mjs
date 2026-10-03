/* test/engines/runner.mjs — 用例装载与运行（供 run.mjs / test/tactics/run.mjs 共用）
 *
 * 只做三件事：动态装载模块、按过滤词跑用例、汇总失败。
 * 库代码不调用 process.exit —— 退出码由调用方决定。
 */
/* mock AI 的模拟延迟对自检无意义：默认跳过（BG_SLOW=1 可覆盖为真实延迟）。
 * 与旧 test/run-tests.cjs:8 同一开关——它同时影响随机流：
 * js/mock-ai.js 的 sleep 里含 BG.util.rand(480)，FAST 关掉会多消耗一个随机数。 */
if (!process.env.BG_SLOW) process.env.BG_FAST = '1';

/** 全部用例模块（顺序 = 旧 test/run-tests.cjs 的加载顺序）。 */
export const ALL_MODULES = [
  './util.test.mjs',
  './engines.test.mjs',
  './rapfi.test.mjs',
  './tactics.test.mjs',
  './jev.test.mjs',
  './archive.test.mjs',
  './version-freeze.test.mjs',
  './parity.test.mjs',
];

/** 战术实验室用例模块（计划 §6.4 的 `test/tactics/`）。 */
export const TACTICS_MODULES = ['./tactics.test.mjs', './jev.test.mjs'];

/**
 * 跑一组用例模块。
 * @param {{modules?: string[], base?: string, filter?: string, listOnly?: boolean, quiet?: boolean}} opts
 *        `base` 是模块相对路径的解析基准（默认本文件所在目录）。
 * @returns {Promise<{passed:number, failures:Array<{name:string,error:any}>, names:string[]}>}
 */
export async function runSuites(opts) {
  const o = opts || {};
  const modules = o.modules || ALL_MODULES;
  const base = o.base || import.meta.url;
  const filter = o.filter || '';
  const names = [];
  const failures = [];
  let passed = 0;

  for (const rel of modules) {
    let mod;
    try {
      mod = await import(new URL(rel, base).href);
    } catch (e) {
      failures.push({ name: rel + '（加载失败）', error: e });
      continue;
    }
    const s = mod.default;
    if (!s) continue;
    if (o.listOnly) {
      for (const c of s.cases) names.push(c.name);
      continue;
    }
    const r = await s.run(filter);
    passed += r.passed;
    for (const f of r.failures) failures.push(f);
  }
  return { passed, failures, names };
}

/** 打印结果并返回进程退出码（0 = 全绿）。 */
export function report(res, label, listOnly) {
  if (listOnly) {
    for (const n of res.names) console.log(n);
    return 0;
  }
  const total = res.passed + res.failures.length;
  if (res.failures.length) {
    console.log('✗ 失败 ' + res.failures.length + ' / ' + total + ' 个用例\n');
    for (const f of res.failures) {
      console.log('✗ ' + f.name);
      console.log('    ' + String(f.error && f.error.message).split('\n').join('\n    '));
      if (f.error && f.error.stack && !(f.error.name === 'AssertError')) {
        const line = String(f.error.stack).split('\n').slice(1, 4).join('\n');
        console.log('    ' + line.split('\n').join('\n    '));
      }
      console.log('');
    }
    return 1;
  }
  console.log('✓ 全部 ' + total + ' 个用例通过（' + (label || '引擎自检 + 战术/版本 + 金样差分') + '）');
  return 0;
}
