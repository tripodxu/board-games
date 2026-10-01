/* test/engines/harness.mjs — 零依赖微型断言库
 *
 * 为什么不引 vitest：引擎与战术自检必须能在 `node test/engines/run.mjs` 下裸跑，
 * 不依赖任何测试框架或构建步骤（Node 24 直接加载 .ts）。
 * 断言失败会带上「用例名 + 期望 + 实际」，让差分回归能一眼定位到具体一手。
 */

/** 断言失败（带用例上下文）。 */
export class AssertError extends Error {}

function fail(msg, extra) {
  const e = new AssertError(extra ? msg + '\n      ' + extra : msg);
  if (Error.captureStackTrace) Error.captureStackTrace(e, fail);
  throw e;
}

/** 真值断言（不接收"差不多"）。 */
export function ok(cond, msg, extra) {
  if (!cond) fail(msg, extra);
}

/** 严格相等。 */
export function eq(actual, expected, msg) {
  if (actual !== expected) {
    fail(msg, '期望: ' + show(expected) + '\n      实际: ' + show(actual));
  }
}

/** 深度相等（JSON 规范化比较，够用于纯数据状态）。 */
export function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) fail(msg, '期望: ' + show(b) + '\n      实际: ' + show(a));
}

/** 数值近似（浮点汇总指标用）。 */
export function near(actual, expected, msg, eps) {
  const e = eps === undefined ? 1e-9 : eps;
  if (!(Math.abs(actual - expected) < e)) {
    fail(msg, '期望: ' + show(expected) + ' (±' + e + ')\n      实际: ' + show(actual));
  }
}

/** 不抛错。 */
export function noThrow(fn, msg) {
  try { fn(); } catch (e) { fail(msg, '抛出了: ' + (e && e.message)); }
}

/** 抛错且消息匹配（正则或子串）。 */
export function throws(fn, re, msg) {
  let e = null;
  try { fn(); } catch (err) { e = err; }
  if (!e) fail(msg, '期望抛错，但没有抛');
  const s = String(e && e.message);
  const hit = re instanceof RegExp ? re.test(s) : s.indexOf(String(re)) >= 0;
  if (!hit) fail(msg, '抛错消息不匹配 ' + show(re) + '\n      实际: ' + show(s));
}

function show(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 400 ? s.slice(0, 400) + '…' : s;
}

/** 用例收集器：所有断言都在 `t(name, fn)` 里。 */
export function suite() {
  const cases = [];
  return {
    cases,
    /** 注册一个用例（支持 async）。 */
    t(name, fn) { cases.push({ name, fn }); },
    /** 逐个跑；返回 {passed, failed, failures[]}。 */
    async run(filter) {
      const failures = [];
      let passed = 0;
      for (const c of cases) {
        if (filter && c.name.indexOf(filter) < 0) continue;
        try {
          await c.fn();
          passed++;
        } catch (e) {
          failures.push({ name: c.name, error: e });
        }
      }
      return { passed, failed: failures.length, failures };
    },
  };
}

/** 确定性伪随机数发生器（夹具用；不依赖被测库的种子）。 */
export function lcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
