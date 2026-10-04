/**
 * scripts/lib/throttle.mjs — box 侧自限速 + 429 熔断（D12 / 计划 §3）
 *
 * 为什么需要它：实验面直连上游（`--upstream direct`）时**没有任何中间层替我们限流**
 * （业主 Worker 的 `JEV_RATE_LIMIT_PER_MIN` 只在走 Worker 时生效）。计划 D12 要求
 * box 自限速默认 30 req/min、单上游臂并发 1、429 退避熔断，否则一晚上几百局打出去
 * 就是一次自伤式限流风暴（账号级 429 会把后面整晚的轮次全部拖死）。
 *
 * 口径：
 *   - **滑窗**而不是固定窗口：第 i 次请求排在 `start + i * ceil(60000/perMinute)`，
 *     窗口内不会出现「前 29 次挤在第 1 秒、第 30 次再挤一次」的脉冲；
 *   - 并发 1 由 worker 天然满足（串行对局、一手里只有一个上游调用），这里只发令牌；
 *   - 熔断：连续 N 次 429 判定「上游已经不要我们了」⇒ `acquire()` 直接抛，让整轮早失败，
 *     而不是继续拿 429 刷满剩下的局（那些局只会产出 `status:'error'` 的垃圾 checkpoint）。
 *
 * 纯逻辑：时间与 sleep 都可注入，单测不动真时钟、不联网。
 */

/** 计划 D12 的默认值。 */
export const DEFAULT_PER_MINUTE = 30;
/** 连续多少次 429 就熔断（要能在一轮 20 局的规模内早失败，又不能一次抖动就放弃）。 */
export const MAX_CONSECUTIVE_429 = 5;
/** 直连上游时的限流对象（只有这两个主机需要令牌；SSH/桶上传等不该被拖慢）。 */
export const DIRECT_UPSTREAM_HOSTS = ['api.typesafe.ai', 'openrouter.ai'];

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 令牌桶（滑窗版）。返回对象的方法都是纯内存操作，`acquire()` 会 await 到该发车的时间。
 * `perMinute` 非正数直接抛：限速写成 0 很容易被误读成「不限速」，这里不许含糊。
 */
export function createThrottle({
  perMinute = DEFAULT_PER_MINUTE,
  now = () => Date.now(),
  sleep = realSleep,
  maxConsecutive429 = MAX_CONSECUTIVE_429,
} = {}) {
  if (!Number.isFinite(perMinute) || perMinute <= 0) {
    throw new Error(`rate-limit 必须是正数（每分钟请求数），收到 ${perMinute}`);
  }
  const intervalMs = Math.ceil(60000 / perMinute);
  let nextAt = 0;
  let issued = 0;
  let waitedMs = 0;
  let consecutive429 = 0;
  let tripped = false;
  let tripReason = null;

  const state = () => ({
    perMinute,
    intervalMs,
    issued,
    waitedMs,
    consecutive429,
    tripped,
    tripReason,
  });

  async function acquire() {
    if (tripped) throw new Error(`限流熔断已触发（${tripReason}）：请停下来查上游配额，不要继续刷`);
    const t = now();
    const at = Math.max(t, nextAt); // 时钟回拨时也不会把 nextAt 拖到过去
    nextAt = at + intervalMs;
    const wait = at - t;
    issued += 1;
    if (wait > 0) {
      waitedMs += wait;
      await sleep(wait);
    }
    return { waitedMs: wait, issued };
  }

  /** 429/529 时上报：连续计数到阈值就熔断（返回最新 state 供日志/测试断言）。 */
  function note429(retryAfterMs) {
    consecutive429 += 1;
    if (consecutive429 >= maxConsecutive429) {
      tripped = true;
      tripReason = `连续 ${consecutive429} 次 429（最近一次 Retry-After=${retryAfterMs == null ? 'n/a' : `${retryAfterMs}ms`}）`;
    }
    return state();
  }

  /** 一次成功就清零连续计数（偶发 429 不该累积成熔断）。 */
  function noteOk() {
    consecutive429 = 0;
    return state();
  }

  /** 人工恢复：编排器换了 key/等了一段之后再试时用（重置计数与发车时刻）。 */
  function reset() {
    consecutive429 = 0;
    tripped = false;
    tripReason = null;
    nextAt = 0;
    return state();
  }

  return { acquire, note429, noteOk, reset, state, intervalMs, perMinute };
}

/** 一行人类可读的限速摘要（起跑时打一次、轮末再打一次，便于事后从日志复算）。 */
export function formatThrottle(st) {
  const secs = (st.intervalMs / 1000).toFixed(1);
  const waited = (st.waitedMs / 1000).toFixed(1);
  const tail = st.tripped ? `｜**已熔断**：${st.tripReason}` : `｜连续 429 ${st.consecutive429}`;
  return `限速 ${st.perMinute}/min（每次发车间隔 ${secs}s）已发 ${st.issued} 次、累计等待 ${waited}s${tail}`;
}

/**
 * 给全局 `fetch` 套一层限速：只对 `hosts` 里的主机领令牌。
 *
 * 为什么要裹 fetch：`src/core/jev/client.ts` 直接调全局 fetch（`:117`、`:239`），
 * 没有注入点，且它的内部重试也不经过我们的循环。裹全局 fetch 才能做到「**每个真实上游请求**
 * 都领令牌」，而不是「每手领一次、重试白送」——后者在 429 风暴里会放大成倍请求。
 * 只在实验 worker 进程里生效，跑完 `uninstall()` 还原。
 */
export function installFetchThrottle(throttle, { hosts = DIRECT_UPSTREAM_HOSTS, fetchImpl = globalThis.fetch, onWait } = {}) {
  const allow = new Set((Array.isArray(hosts) ? hosts : [hosts]).map((h) => String(h).toLowerCase()));
  const orig = fetchImpl;                 // 真正发请求用的实现（可注入做单测）
  const previous = globalThis.fetch;      // 卸载时要还原的东西 —— **不是** orig（注入时两者不同）
  if (typeof orig !== 'function') throw new Error('installFetchThrottle：当前环境没有 fetch');
  let gated = 0;
  let passed = 0;

  const wrapped = async (input, init) => {
    let host = '';
    try {
      host = new URL(typeof input === 'string' ? input : input && input.url ? input.url : String(input)).hostname.toLowerCase();
    } catch (_) { /* 相对路径 / 非法 URL：不属于上游，直接放行 */ }
    if (allow.has(host)) {
      gated += 1;
      const { waitedMs } = await throttle.acquire();
      if (waitedMs > 0 && onWait) onWait(waitedMs);
    } else {
      passed += 1;
    }
    return orig(input, init);
  };

  globalThis.fetch = wrapped;
  return {
    stats: () => ({ gated, passed }),
    uninstall() {
      if (globalThis.fetch === wrapped) globalThis.fetch = previous;
      return { gated, passed };
    },
  };
}
