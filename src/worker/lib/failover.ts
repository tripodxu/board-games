/**
 * Worker 侧的上游兜底切换（C2 / plan 2026-10-03-cands-metric-and-provider-failover）。
 *
 * 与浏览器直连面的分工：
 *   - **直连面**（`src/core/jev/client.ts`）自己跑重试阶梯，所以「429 用尽」是它自己数出来的；
 *   - **Worker 面**（本文件）**每个请求都是独立的一次**，没有跨请求的计数可数——所以这里的判据是
 *     「这一次响应本身是否说明主家已经不能用了」：401/402/403 直接切（key/额度废了，再试也没用）、
 *     429/529 直接切（主家正在限流，客户端再退避重试也只会撞同一堵墙）、连续 3 次 5xx 才切
 *     （单次 5xx 可能只是抖动，切过去反而把备用也搭进去）。
 *
 * 为什么切换策略放在 core（`src/core/jev/providers.ts`）：两个运行面必须用**同一套**判据，
 * 否则「实验面能兜底、生产面兜不住」这种差异会直接污染实验结论。本文件只负责把那份纯逻辑
 * 接到 `callUpstream` 上（注入 `fetcher`，因此能在单测里逐条钉住切换与不切换）。
 *
 * 安全口径（D-B4）：这里经手两把 key，但**只传不记**——日志只写提供方 id 与状态码，
 * 从不写 key、不写 `Authorization`。
 */
import {
  SERVER_FAILURE_LIMIT,
  classifyStatus,
  isSwitchable,
  providerOf,
  type ProviderConfig,
  type ProviderSwitchInfo,
} from '../../core/jev/providers.ts';
import {
  DEFAULT_TIMEOUT_MS,
  callUpstream,
  type UpstreamResult,
} from './upstream.ts';

/** 探活超时：与浏览器直连面同值（`PROBE_TIMEOUT_MS`）。 */
export const PROBE_TIMEOUT_MS = 10_000;

export interface UpstreamAttempt {
  provider: ProviderConfig;
  /** 这一家要用的 key（主家通常是访客 BYOK，兜底是 `env.COMMANDCODE_API_KEY`）。 */
  apiKey: string;
  /**
   * 覆盖请求体。只有兜底需要它：主家用客户端给的 `model`（向后兼容，客户端可能指定别的模型），
   * 兜底网关只认自己的 `provider.model`（`typesafe/jev`）——同一个 `body` 发两家必然有一家 400。
   */
  body?: Record<string, unknown>;
}

export interface FailoverCall {
  /** 按优先级排好的提供方（至少一个）。只有一个时本模块退化成「原样转发」。 */
  attempts: UpstreamAttempt[];
  body: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetcher: typeof fetch;
}

export interface FailoverOutcome {
  result: UpstreamResult;
  /** 最终把这次请求交给谁（进响应头 `X-Jev-Provider`）。 */
  providerId: string;
  /** 发生过切换才有；`reason` 是给人看的中文。 */
  switchInfo: ProviderSwitchInfo | null;
  /** 一共打了上游几次（含 5xx 重试），供日志与成本核算。 */
  upstreamCalls: number;
}

/** 探活：`GET provider.probeUrl`，只判「网关 + key 活着」（清单不权威，见 providers.ts 头注）。 */
async function probeProvider(
  attempt: UpstreamAttempt,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number | null; ms: number }> {
  const url = attempt.provider.probeUrl;
  const started = Date.now();
  if (!url || !attempt.apiKey) return { ok: false, status: null, ms: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const resp = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${attempt.apiKey}` }, signal: controller.signal });
    return { ok: resp.status === 200, status: resp.status, ms: Date.now() - started };
  } catch {
    return { ok: false, status: null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 转发一次，必要时按提供方表兜底。
 *
 * 只在这三种情况下换家（且必须还有下一家）：
 *   ① `auth`（401/402/403）：key 废了或额度没了；
 *   ② `rate-limit`（429/529）：主家正在限流——Worker 面无跨请求计数，一次即视为用尽；
 *   ③ `server`（5xx）**连续** `SERVER_FAILURE_LIMIT` 次。
 * 其余（4xx 客户端错、网络错/超时）不换：改请求也不会变对，换家只会把失败原因搅浑。
 */
export async function callUpstreamWithFailover(call: FailoverCall): Promise<FailoverOutcome> {
  const attempts = call.attempts.length ? call.attempts : [];
  if (!attempts.length) throw new Error('callUpstreamWithFailover 需要至少一个提供方');
  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let upstreamCalls = 0;
  let switchInfo: ProviderSwitchInfo | null = null;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i] as UpstreamAttempt;
    const hasNext = i < attempts.length - 1;
    let serverTries = 0;
    for (;;) {
      upstreamCalls++;
      const result = await callUpstream({
        apiKey: attempt.apiKey,
        body: attempt.body ?? call.body,
        url: attempt.provider.url,
        timeoutMs,
        signal: call.signal,
        fetcher: call.fetcher,
      });
      if (!result.ok) return { result, providerId: attempt.provider.id, switchInfo, upstreamCalls };
      const cls = classifyStatus(result.status);
      if (!cls) return { result, providerId: attempt.provider.id, switchInfo, upstreamCalls };
      if (!hasNext) return { result, providerId: attempt.provider.id, switchInfo, upstreamCalls };
      /* 5xx 先在本家重试到阈值（不能拿一次抖动当「上游故障」） */
      if (cls === 'server' && ++serverTries < SERVER_FAILURE_LIMIT) continue;
      if (!isSwitchable(cls)) return { result, providerId: attempt.provider.id, switchInfo, upstreamCalls };

      const next = attempts[i + 1] as UpstreamAttempt;
      const probe = await probeProvider(next, call.fetcher, call.signal);
      if (!probe.ok) {
        /* 备用探活不过：**不切**，把主家的原响应透传给客户端（切过去只是把同一个错换个文案） */
        return {
          result,
          providerId: attempt.provider.id,
          switchInfo: {
            from: attempt.provider.id,
            to: next.provider.id,
            reason: `${providerOf(attempt.provider.id)?.label ?? attempt.provider.id} HTTP ${result.status}；备用探活未通过`,
            probeMs: probe.ms,
            probeStatus: probe.status,
          },
          upstreamCalls,
        };
      }
      switchInfo = {
        from: attempt.provider.id,
        to: next.provider.id,
        reason: `${providerOf(attempt.provider.id)?.label ?? attempt.provider.id} HTTP ${result.status}`,
        probeMs: probe.ms,
        probeStatus: probe.status,
      };
      break; // 换家重试：外层 for 推进到下一家
    }
  }
  /* 不会走到：循环里每一家都会 return 或 break 到下一家，最后一家必定 return。 */
  throw new Error('callUpstreamWithFailover 未收敛');
}
