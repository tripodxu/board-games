/* client.ts — Jev 渠道客户端（迁移自 js/jev-client.js）
 *
 * 一条决策链的全部：渠道与鉴权（含 BYOK 头透传）→ 请求与重试 → 战术接管 → 概率采样。
 * 为什么集中在 core 而不是 UI：这条链决定了「同一局面走哪一步」，是实验可复现的核心，
 * 必须能在 Node 下无 DOM 直接跑（自检与金样都依赖它）。
 *
 * 与旧实现的唯一结构差异是**依赖注入点**（`setMock` / `opts.rapfi`）：旧实现读全局
 * `BG.mock` / `BG.rapfi`，新实现是模块，不能反向 import 造成循环。行为逐字不变。
 */
import { weightedPick } from '../weighted.ts';
import { rand } from '../rng.ts';
import {
  computeTactics, attachFacts, emptyTactics, mechOf,
  resolveVersion,
} from '../tactics.ts';
/* 接管链在 2026-10-03（P2）抽成纯函数：指纹冻结与 P3 回放都要在**无模型**下跑这条链。
 * 抽取是逐字搬运，行为逐字不变（对照证据：`.work/p2-ab-baseline.mjs` 450 行 0 差异）。 */
import { pickTakeover, TAKEOVER_LABEL } from '../takeover.ts';
import {
  PROVIDER_BACKUP,
  PROVIDER_HINT_HEADER,
  PROVIDER_PRIMARY,
  PROVIDER_SWITCH_HEADER,
  SERVER_FAILURE_LIMIT,
  classifyStatus,
  defaultProvider,
  newProviderStates,
  noteFailure,
  noteSuccess,
  providerOf,
  type ProviderConfig,
  type ProviderKeySource,
  type ProviderStates,
  type ProviderSwitchInfo,
} from './providers.ts';
import type { DecideOpts, DecideResult, TacticsReport } from '../tactics.ts';
import type { Engine, JevQuestion, JevSerialized, Move } from '../types.ts';

/* ------------------------------------------------------------------ *
 * 渠道表（端点为预设值，UI 占位符与真实请求共用）
 * ------------------------------------------------------------------ */

export interface ChannelConfig { endpoint: string; model: string; keyName: string | null }

export const CHANNELS: Record<string, ChannelConfig> = {
  official: { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', keyName: 'official' },
  openrouter: { endpoint: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13', keyName: 'openrouter' },
  proxy: { endpoint: 'api/jev', model: 'jev-latest', keyName: null },
};

/* 提供方表与切换策略在 core 里（`providers.ts`）：Worker 面与 box 直连面必须同一套判据。
 * 这里只用它做两件事——直连面自己切换、proxy 面把「本轮该用谁」提示给 Worker 并读回执。 */
export { PROVIDER_HINT_HEADER, PROVIDER_SWITCH_HEADER };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const REQUEST_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 10000;

/** 渠道预设端点（设置面板占位符用）。 */
export function presetEndpoint(channel: string): string {
  const cfg = CHANNELS[channel];
  return cfg ? cfg.endpoint : '';
}

/* ------------------------------------------------------------------ *
 * 依赖注入口（mock 渠道；rapfi 走 opts.rapfi）
 * ------------------------------------------------------------------ */

type MockDecide = (engine: Engine, st: unknown, side: string, legal: Move[], ser: JevSerialized) => Promise<DecideResult>;
type RapfiDecide = (engine: Engine, st: unknown, side: string, legal: Move[], ser: JevSerialized, opts: { thinkMs?: number }) => Promise<DecideResult>;

let mockDecide: MockDecide | null = null;

/** 注入 mock 渠道实现（由 jev/index.ts 装配；未注入时 mock 渠道报错而不是静默走随机）。 */
export function setMock(fn: MockDecide | null): void {
  mockDecide = fn;
}

function locationOrigin(): string | undefined {
  const l = (globalThis as { location?: { origin?: string } }).location;
  return l && typeof l.origin === 'string' ? l.origin : undefined;
}

/* ------------------------------------------------------------------ *
 * 请求与重试
 * ------------------------------------------------------------------ */

/** 传输层错误：带上状态码 / `Retry-After` / 「值不值得重试」，供重试循环与装配层共用。 */
interface JevHttpError extends Error {
  status?: number;
  detail?: string;
  /** 服务端给的 `Retry-After`（毫秒；只认整数秒写法，已限幅到 60s）。 */
  retryAfterMs?: number;
  /**
   * 值不值得再试一次：限流（429/529）与网络错误为 `true`，鉴权/格式错误为 `false`。
   * 装配层（`app/loop.ts`）据此决定「无人值守时要不要自动重试」，而不是去认文案。
   */
  retryable?: boolean;
}

/** `Retry-After` → 毫秒。只认「整数秒」；HTTP-date 写法与非法值一律返回 null（退回指数退避）。 */
function retryAfterMsOf(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, 60) * 1000;
}

/** 给错误打上 `retryable` 标记并原样返回（调用点写成 `throw markRetryable(new Error(…), true)`）。 */
function markRetryable<T extends Error>(err: T, retryable: boolean): T {
  (err as JevHttpError).retryable = retryable;
  return err;
}

/**
 * 造一个**保留状态码**的传输错误。
 *
 * 2026-10-04（C2）加：`markRetryable(new Error(…))` 的静态类型是 `Error`，状态码写不进去；
 * 而切换层必须按状态分类（401⇒换家、429 用尽⇒换家、5xx 连续 3 次⇒换家），
 * 只看文案猜状态是迟早会错的做法。
 */
function httpError(message: string, status: number | undefined, retryable: boolean, detail?: string): JevHttpError {
  const err = new Error(message) as JevHttpError;
  if (status !== undefined) err.status = status;
  if (detail !== undefined) err.detail = detail;
  err.retryable = retryable;
  return err;
}

/* ------------------------------------------------------------------ *
 * 提供方尝试（C2）：一个有 key 的「端点 + 模型 + 鉴权」三元组
 * ------------------------------------------------------------------ */

/**
 * 一次请求要用哪家、用哪把 key。
 *
 * `custom` = 自定义端点（自建网关）：沿用旧语义——不强制 key、也不做切换（我们不知道对面是谁）。
 */
interface ProviderAttempt {
  provider: ProviderConfig;
  apiKey: string;
  channel: string;
  custom: boolean;
}

/** 把渠道预设包成一个「合成提供方」（openrouter / proxy 这些不在兜底表里）。 */
function syntheticProvider(channel: string, id: string, label: string, url: string, model: string): ProviderConfig {
  return { id, label, url, model, keySource: 'official' as ProviderKeySource, kind: 'systemone', probeUrl: '' };
}

/**
 * 本次调用可用的提供方（按优先级）。**只有直连面（`official`）才在这里切换**：
 *  - `proxy`：切换是 Worker 的事，客户端只带「本局粘滞」提示头并读回执（见 `PROVIDER_HINT_HEADER`）；
 *  - `openrouter`：另一条渠道（模型 `typesafe/jev-1.13`），不在本计划的兜底链里，保持单提供方；
 *  - 自定义端点：单提供方（不知道对面是谁，不猜）。
 *
 * 备用 key（`opts.backupApiKey`，commandcode）没配就是老行为：单提供方、失败照旧抛。
 */
function attemptsFor(channel: string, opts: DecideOpts): ProviderAttempt[] {
  const cfg = CHANNELS[channel];
  if (!cfg) throw new Error('未知渠道: ' + channel);
  const customEndpoint = typeof opts.endpoint === 'string' && opts.endpoint.trim() ? opts.endpoint.trim() : '';
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';

  if (channel === 'proxy') {
    return [{
      provider: syntheticProvider(channel, PROVIDER_PRIMARY, '同源代理', customEndpoint || cfg.endpoint, cfg.model),
      apiKey, channel, custom: !!customEndpoint,
    }];
  }
  if (customEndpoint) {
    return [{
      provider: syntheticProvider(channel, 'custom', '自定义端点', customEndpoint, cfg.model),
      apiKey, channel, custom: true,
    }];
  }
  if (channel === 'official') {
    if (!apiKey) throw new Error('尚未填写该渠道的 API Key（右上「Jev 设置」）');
    const out: ProviderAttempt[] = [{ provider: defaultProvider(), apiKey, channel, custom: false }];
    const backupKey = typeof opts.backupApiKey === 'string' ? opts.backupApiKey.trim() : '';
    const backup = providerOf(PROVIDER_BACKUP);
    if (backupKey && backup) out.push({ provider: backup, apiKey: backupKey, channel, custom: false });
    return out;
  }
  if (cfg.keyName && !apiKey) throw new Error('尚未填写该渠道的 API Key（右上「Jev 设置」）');
  return [{ provider: syntheticProvider(channel, channel, channel, cfg.endpoint, cfg.model), apiKey, channel, custom: false }];
}

/** 单次请求（含 BYOK 头、超时与外部取消合并）。返回体与响应头（回执头要用）。 */
async function callRaw(
  attempt: ProviderAttempt,
  body: JevSerialized,
  opts: DecideOpts,
  extraHeaders: Record<string, string> = {},
): Promise<{ data: Record<string, unknown>; headers: Headers }> {
  const { channel, apiKey, custom } = attempt;
  const cfg = CHANNELS[channel];
  if (!cfg) throw new Error('未知渠道: ' + channel);
  const endpoint = attempt.provider.url;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (channel === 'proxy') {
    if (apiKey) headers['X-Api-Key'] = apiKey;
  } else if (cfg.keyName) {
    if (!apiKey && !custom) throw new Error('尚未填写该渠道的 API Key（右上「Jev 设置」）');
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    if (channel === 'openrouter') headers['HTTP-Referer'] = locationOrigin() || 'http://localhost';
  }
  const payload = { state: body.state, model: attempt.provider.model, questions: body.questions };

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) timeoutCtrl.abort();
    else opts.signal.addEventListener('abort', () => timeoutCtrl.abort(), { once: true });
  }
  try {
    const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: timeoutCtrl.signal });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 300); } catch (_) { /* ignore */ }
      const err = new Error('HTTP ' + resp.status + (detail ? '：' + detail : '')) as JevHttpError;
      err.status = resp.status;
      err.detail = detail;
      err.retryAfterMs = retryAfterMsOf(resp.headers.get('Retry-After')) ?? undefined;
      throw err;
    }
    return { data: await resp.json() as Record<string, unknown>, headers: resp.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** 网络错误的重试次数（与旧实现一致：4 次尝试）。 */
const NETWORK_ATTEMPTS = 4;
/**
 * 限流的重试次数（429/529）。比网络错误多，理由是窗口长度：服务端限流是 60 秒固定窗口，
 * 等一到两轮就能过，而这是**机机对局唯一的推进方式**——放弃一次就等于整局停摆。
 */
const RATE_LIMIT_ATTEMPTS = 5;
/**
 * 单次限流等待的上限。服务端可能让我们等满 60 秒，但无人值守的实验不能被一次等待卡住
 * 太久（等待期间页面上的思考计时是停的），所以截到 20 秒，靠多试几次把窗口熬过去。
 */
const MAX_RATE_LIMIT_BACKOFF_MS = 20000;

/**
 * 带退避重试的请求（**单一提供方**）：网络错误 4 次尝试；429/529 按 `Retry-After`
 * （缺省指数退避）重试 5 次；401 直接报鉴权失败。
 *
 * 2026-10-01 修：旧写法在 429 分支里**没有给 `lastErr` 赋值**，于是 5 次限流之后抛的是
 * `重试次数用尽`——排障时完全看不出「被限流了」，而真实原因（每 IP 30/分）恰恰是用户
 * 唯一能改的东西。现在每次失败都留下带状态码与等待策略的错误，并打上 `retryable`。
 *
 * C2 起只加两件事，**不改老路径的文案与次数**：① 抛错时保留 `status`（切换层要分类）；
 * ② 只有存在备用提供方（`hasBackup`）时，5xx 才在**同一提供方内**重试到
 * `SERVER_FAILURE_LIMIT` 次——「连续 3 次 5xx 才切」需要真的连续试，而没配兜底时
 * 单次 5xx 仍然立刻失败（老行为，别把一个抖动变成三倍等待）。
 */
async function callWithRetry(
  attempt: ProviderAttempt,
  body: JevSerialized,
  opts: DecideOpts,
  extraHeaders: Record<string, string> = {},
  hasBackup = false,
): Promise<{ data: Record<string, unknown>; headers: Headers }> {
  const channel = attempt.channel;
  let networkTries = 0;
  let rateLimitTries = 0;
  let serverTries = 0;
  for (;;) {
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');
    try {
      return await callRaw(attempt, body, opts, extraHeaders);
    } catch (e) {
      const err = e as JevHttpError;
      if (opts.signal && opts.signal.aborted) throw new Error('aborted');
      if (!err.status) {
        /* 网络错误：代理与直连的成因不同，提示也不同 */
        if (++networkTries >= NETWORK_ATTEMPTS) {
          throw markRetryable(new Error('网络错误：' + err.message + `（已尝试 ${networkTries} 次）` + (channel === 'proxy'
            ? '（同源 /api/jev 不可达：本地用 npm run dev 起 Worker，线上由 jevqipan.logicc.top 提供；接口不可用时自动退回离线演示）'
            : '（浏览器直连受 CORS 限制：官方 API 有来源白名单，仅 typesafe.ai 自有域可用；请改用「同源代理」渠道）')), true);
        }
        await sleep(800 * networkTries);
        continue;
      }
      if (err.status === 429 || err.status === 529) {
        if (++rateLimitTries >= RATE_LIMIT_ATTEMPTS) {
          throw httpError(`上游限流（HTTP ${err.status}）：已退避重试 ${rateLimitTries} 次仍未放行`
            + (err.detail ? '（' + err.detail.slice(0, 120) + '）' : ''), err.status, true);
        }
        if (opts.onRetry) opts.onRetry(err.status, rateLimitTries - 1);
        /* 服务端给了 `Retry-After` 就听它的（截到 20 秒）；没给才用指数退避 1/2/4/8 秒。 */
        const waitMs = Math.min(err.retryAfterMs ?? 1000 * Math.pow(2, rateLimitTries - 1), MAX_RATE_LIMIT_BACKOFF_MS);
        await sleep(waitMs);
        continue;
      }
      if (err.status === 401) {
        throw httpError('API Key 无效或缺失（401）——若 key 确认无误（「测试连接」通过），可能是服务端瞬时故障，稍后点「重试」即可', err.status, false);
      }
      if (hasBackup && err.status >= 500 && ++serverTries < SERVER_FAILURE_LIMIT) {
        /* 只为「连续 3 次 5xx ⇒ 切换」凑连续性：短退避、不打扰 UI 的 onRetry（那是限流的提示位） */
        await sleep(1000 * serverTries);
        continue;
      }
      throw httpError('API 错误 ' + err.status + '：' + (err.detail || ''), err.status, false, err.detail);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 兜底切换（C2）
 * ------------------------------------------------------------------ */

/** 切换前的探活（D-B2）：只判「网关 + key 活着」，不看模型清单（C1：清单不权威）。 */
async function probeProvider(
  attempt: ProviderAttempt,
  opts: DecideOpts,
): Promise<{ ok: boolean; status: number | null; ms: number }> {
  const url = attempt.provider.probeUrl;
  const started = Date.now();
  if (!url) return { ok: false, status: null, ms: 0 };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + attempt.apiKey },
      signal: ctrl.signal,
    });
    /* 200 = 活着；401/403 = key 不能用（切过去也没意义）；其余（含 4xx/5xx）= 不确定，按不可用处理。 */
    return { ok: resp.status === 200, status: resp.status, ms: Date.now() - started };
  } catch (_) {
    return { ok: false, status: null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** 上游应答 + 「这一手是谁答的」（进 `meta.provider`，D-B6）。 */
interface UpstreamAnswer {
  data: Record<string, unknown>;
  providerId: string;
  /** 切换事件（发生过才有）；调用侧据此落日志/事件流 */
  switchInfo: ProviderSwitchInfo | null;
}

/**
 * 请求上游，**必要时按提供方表兜底切换**。
 *
 * 为什么把切换放在重试阶梯之外：重试是「同一家再试一次」，切换是「换一家」。
 * 混在一个循环里会让「429 等 20 秒」和「401 立刻换」两种截然不同的处置互相污染。
 *
 * 粘滞（D-B2）：`opts.providerSticky` 指定的提供方**直接照办**；一旦切换，本局不再回切
 * ——调用侧把 `switchInfo.to` 存进自己的局内状态，下一手通过 `providerSticky` 传回来。
 */
/**
 * Worker 回报的切换原因：`<from>-><to>; <百分号编码的原因>`。
 * HTTP 头只能是 latin-1，中文原因直接写会炸，所以 Worker 端编码、这里解回来（解不开就用原文）。
 */
function decodeSwitchReason(raw: string): string {
  if (!raw) return '';
  const semi = raw.indexOf('; ');
  const encoded = semi >= 0 ? raw.slice(semi + 2) : raw;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

async function callWithFailover(channel: string, body: JevSerialized, opts: DecideOpts): Promise<UpstreamAnswer> {
  const attempts = attemptsFor(channel, opts);
  const first = attempts[0] as ProviderAttempt;
  const stickyId = typeof opts.providerSticky === 'string' ? opts.providerSticky : '';
  const sticky = stickyId ? attempts.find((a) => a.provider.id === stickyId) : undefined;
  /* 粘滞命中就固定用它（哪怕表里那个已被判死——本局已经押在它身上了） */
  const order: ProviderAttempt[] = sticky ? [sticky, ...attempts.filter((a) => a !== sticky)] : attempts;

  let states: ProviderStates = newProviderStates();
  let switchInfo: ProviderSwitchInfo | null = null;

  /* proxy 面：切换在 Worker 里做，客户端只带提示头 + 读回执（CORS 已 `Expose-Headers`）。
   * 探活耗时/状态只在 Worker 日志里（响应头塞不下结构化字段），所以这里 `probeMs/probeStatus` 记 null。 */
  if (channel === 'proxy') {
    const extra: Record<string, string> = {};
    if (stickyId) extra[PROVIDER_HINT_HEADER] = stickyId;
    const { data, headers } = await callWithRetry(first, body, opts, extra);
    const used = headers.get(PROVIDER_HINT_HEADER) || first.provider.id;
    const switchReason = decodeSwitchReason(headers.get(PROVIDER_SWITCH_HEADER) || '');
    if (used !== first.provider.id) {
      switchInfo = { from: first.provider.id, to: used, reason: switchReason || 'Worker 侧切换', probeMs: null, probeStatus: null };
      if (opts.onProviderSwitch) opts.onProviderSwitch(switchInfo);
    }
    return { data, providerId: used, switchInfo };
  }

  let lastErr: unknown = null;
  for (let i = 0; i < order.length; i++) {
    const attempt = order[i] as ProviderAttempt;
    const hasBackup = order.length > 1 && i < order.length - 1;
    try {
      const { data } = await callWithRetry(attempt, body, opts, {}, hasBackup || order.length > 1);
      states = noteSuccess(states, attempt.provider.id);
      return { data, providerId: attempt.provider.id, switchInfo };
    } catch (e) {
      lastErr = e;
      const err = e as JevHttpError;
      /* 只在「有下一家可换」时才做切换判定——没配兜底时一切照旧（错误原样抛） */
      if (!err.status || i >= order.length - 1) throw e;
      const cls = classifyStatus(err.status);
      if (!cls) throw e;
      /* 走到这里说明 `callWithRetry` 的重试阶梯已经结束：限流是退避次数用尽，5xx 是
       * 本家内部连试到 `SERVER_FAILURE_LIMIT`（`hasBackup` 时才会重试 5xx）。两种都算
       * 「用尽」，否则一次 5xx 在 `consecutive` 里只记到 1，永远等不到阈值。 */
      const exhausted = cls === 'rate-limit' || cls === 'server';
      const note = noteFailure(states, attempt.provider.id, cls, { status: err.status, exhausted });
      states = note.states;
      if (!note.switchAway) throw e;
      const next = order[i + 1] as ProviderAttempt;
      const probe = await probeProvider(next, opts);
      if (!probe.ok) {
        /* 备用探活不过：不切（切过去只是把同一个错换个文案）。如实抛主家的错。 */
        if (opts.onProviderSwitch) {
          opts.onProviderSwitch({
            from: attempt.provider.id, to: next.provider.id,
            reason: `${note.reason}；备用探活未通过${probe.status === null ? '' : `（HTTP ${probe.status}）`}`,
            probeMs: probe.ms, probeStatus: probe.status,
          });
        }
        throw e;
      }
      switchInfo = { from: attempt.provider.id, to: next.provider.id, reason: note.reason, probeMs: probe.ms, probeStatus: probe.status };
      if (opts.onProviderSwitch) opts.onProviderSwitch(switchInfo);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('上游调用失败：没有可用的提供方');
}

/* ------------------------------------------------------------------ *
 * 连通性探测（设置面板「测试连接」）
 * ------------------------------------------------------------------ */

export interface ProbeResult {
  ok: boolean;
  kind: string;
  message: string;
  latencyMs?: number;
  model?: string;
  status?: number;
}

/** 两段式探测：A 段 no-cors GET 判「网络是否通」，B 段最小 noul 请求区分 CORS 与网络错误。 */
export async function probe(opts: DecideOpts): Promise<ProbeResult> {
  const channel = opts.channel || 'official';
  if (channel === 'mock') return { ok: true, kind: 'mock', message: '离线演示：无需连接。' };
  const cfg = CHANNELS[channel];
  if (!cfg) return { ok: false, kind: 'config', message: '未知渠道：' + channel };
  const endpoint = opts.endpoint || cfg.endpoint;
  const t0 = Date.now();
  let reachable = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try { await fetch(endpoint, { mode: 'no-cors', signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    reachable = true;
  } catch (_) { /* 网络层就不通 */ }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (channel === 'proxy') {
    if (opts.apiKey) headers['X-Api-Key'] = opts.apiKey;
  } else if (cfg.keyName) {
    if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
    if (channel === 'openrouter') headers['HTTP-Referer'] = locationOrigin() || 'http://localhost';
  }
  const body = JSON.stringify({
    state: { probe: true },
    model: cfg.model,
    questions: { probe: { type: 'noul', instructions: 'Connectivity probe. Answer immediately.' } },
  });
  let resp: Response;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    resp = await fetch(endpoint, { method: 'POST', headers, body, signal: ctrl.signal });
  } catch (e) {
    const latencyMs = Date.now() - t0;
    if (!reachable) {
      return { ok: false, kind: 'network', latencyMs,
        message: '网络不可达：' + (e as Error).message + '。检查地址拼写与本机网络（代理渠道需要 Worker 在线：本地 npm run dev，线上 jevqipan.logicc.top）。' };
    }
    return { ok: false, kind: 'cors', latencyMs,
      message: '服务器可达，但浏览器跨域(CORS)被拦截：端点未返回 CORS 头。改用「同源代理」渠道，或让服务端加 Access-Control-Allow-Origin。' };
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - t0;
  if (resp.ok) {
    let data: Record<string, unknown> | null = null;
    try { data = await resp.json() as Record<string, unknown>; } catch (_) { /* 响应不是 JSON，按形状不符处理 */ }
    const modelName = data && typeof data.model === 'string' ? data.model : undefined;
    if (data && data.answers) {
      return { ok: true, kind: 'ok', latencyMs, model: modelName,
        message: '联通正常' + (modelName ? ' · ' + modelName : '') + ' · ' + latencyMs + 'ms，key 有效。' };
    }
    return { ok: false, kind: 'shape', latencyMs,
      message: '端点可达且鉴权通过，但响应不是 System One 结构（缺 answers）。确认地址是 /v1/systemone 同构端点。' };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, kind: 'auth', latencyMs,
      message: '服务器联通，但鉴权失败（' + resp.status + '）：key 无效或未授权，请核对后重填。' };
  }
  let detail = '';
  try { detail = (await resp.text()).slice(0, 200); } catch (_) { /* ignore */ }
  return { ok: false, kind: 'http', status: resp.status, latencyMs,
    message: '服务器联通，但返回 HTTP ' + resp.status + (detail ? '：' + detail : '') + '。确认端点路径是否正确（通常到 /v1/systemone 为止）。' };
}

/* ------------------------------------------------------------------ *
 * 决策
 * ------------------------------------------------------------------ */

/** 走一步棋：engine.serializeForJev 的产出交给 Jev，返回决策对象。
 *  opts: { channel, apiKey, endpoint?, topK, signal, onRetry, tacticsVersion, experience, rapfiThinkMs } */
export async function decide(engine: Engine, st: unknown, side: string, opts: DecideOpts): Promise<DecideResult> {
  const channel = opts.channel || 'official';
  /* 战术版本：整条事实/接管链都按它走；缺省/未知按当前档 */
  const ver = resolveVersion(opts.tacticsVersion);
  const M = ver.mech;
  const ser = engine.serializeForJev(st, side);
  const legal = engine.getLegalMoves(st);
  const byNotation = new Map<string, Move>(legal.map((m) => [m.notation, m]));
  const t0 = Date.now();

  if (channel === 'mock') {
    if (!mockDecide) throw new Error('mock 渠道未装配（应调用 jev/index.ts 的 decide）');
    return await mockDecide(engine, st, side, legal, ser);
  }

  if (channel === 'rapfi') {
    /* Rapfi 是完整搜索引擎（非 prompt 型），不走 Jev 战术层；
     * 与 mock 一样直接返回，保持「Rapfi vs Jev」实验变量纯净。 */
    const rapfi = opts.rapfi as RapfiDecide | undefined;
    if (!rapfi) throw new Error('rapfi 渠道未注入（opts.rapfi）');
    return await rapfi(engine, st, side, legal, ser, { thinkMs: opts.rapfiThinkMs });
  }

  /* 战术事实 + 对局经验注入 state，并同步指令语义 */
  let tactics: TacticsReport = emptyTactics();
  /* 战术层耗时（ms）：本手在「算战术事实 + 拆杀点安全排序」上花掉的时间，与上游调用分开记账。
   * 为什么要拆：`latencyMs` 是「战术 + 上游」的总和，而上游一次调用约 1s，战术层正常只有
   * 几毫秒到几十毫秒——想回答「这层保险值不值/会不会拖慢走子」，必须单独有这一个数。 */
  let tacticsMs = 0;
  /* 候选点记法：2-ply 外层只扫候选（省时间），取自序列化 questions.move.criteria 的键 */
  let cands: string[] | null = null;
  /* 候选点三数（C0 / m13627）——三个数回答三个不同问题，不合并：
   *   candsSent    = 战术层之后**交给 Jev 决定**的候选点数（= criteria 键数 = 请求里 options 长度，引擎上限 64）
   *   candsLabeled = 其中 `labelPoint` 给过战术标签的点数（criteria 的值非空）
   *   cands        = 模型**给了概率且合法**的点数，在下面按响应统计（历史口径，不动）
   * 二者可以差很多（模型可能对 40 个点只给 8 个概率），所以必须分开记。
   * 缺失一律写 null，不写 0：0 是「交了 0 个候选点」这个不存在的状态。 */
  let candsSent: number | null = null;
  let candsLabeled: number | null = null;
  try {
    const q = ser.questions as Record<string, JevQuestion> | undefined;
    const crit = q && q.move && q.move.criteria;
    if (crit && typeof crit === 'object') {
      const entries = Object.entries(crit as Record<string, unknown>);
      cands = entries.map(([n]) => n);
      candsSent = entries.length;
      candsLabeled = entries.filter(([, label]) => typeof label === 'string' && label.length > 0).length;
    }
  } catch (_) { /* 降级为全量 */ }
  { /* 块级作用域：tt 只是这一段的秒表，别漏到函数作用域里 */
    const tt = Date.now();
    try { tactics = computeTactics(engine, st, legal, cands, opts.tacticsVersion); } catch (_) { /* 任何引擎差异都降级为空战术 */ }
    tacticsMs += Date.now() - tt;
  }
  /* P1/D5：指令句按本档真有的机制过滤（同一解析路径；未知档号 = 空机制集 ⇒ 不注入任何机制句） */
  attachFacts(ser, tactics, opts.experience, { mech: mechOf(opts.tacticsVersion) });

  let answers: Record<string, unknown>, usage: Record<string, unknown>, costUsd: number, probs: Record<string, number>, conf: number | null, modelName: string | undefined;
  /* C2：这一手是谁答的 + 概率是不是真的逐点给的（D-B3/D-B6）。random 渠道没有人答，
   * 也没有概率图——它自己造均匀分布，所以两条都如实标注，别让它看起来像模型输出。 */
  let providerId = channel;
  let probSource: 'exact' | 'derived' = 'exact';
  if (channel === 'random') {
    /* 纯随机基线（对比实验用）：均匀概率、零启发式，照样走完整战术管线。
     * 与 mock 的区别：mock 直接返回不经过战术层；random 刻意走战术层，
     * 这样「随机+战术」 vs 「Jev+战术」的唯一变量就是概率分布的质量。 */
    answers = {}; usage = {};
    costUsd = 0; modelName = 'random-baseline';
    probs = {};
    legal.forEach((m) => { probs[m.notation] = 1; });
    conf = null;
    providerId = 'random';
    probSource = 'derived';
  } else {
    const out = await callWithFailover(channel, ser, opts);
    const data = out.data as { answers?: Record<string, unknown>; usage?: Record<string, unknown>; model?: string };
    providerId = out.providerId;
    answers = data.answers || {};
    usage = data.usage || {};
    costUsd = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) * 42 / 1e9; /* 输入 $42/十亿token，输出免费 */
    modelName = data.model;
    const ans = (answers.move || {}) as { probabilities?: Record<string, number>; confidence?: unknown };
    probs = ans.probabilities || {};
    conf = typeof ans.confidence === 'number' ? ans.confidence : null;
    /* D-B3：**响应里没有逐点概率**才算降级（备用网关某次只给 choice）。绝不把 `cands` 或
     * 均匀分布冒充成模型概率——那会让「候选点数」这条 C0 指标失去意义。 */
    probSource = Object.keys(probs).length > 0 ? 'exact' : 'derived';
  }
  const latencyMs = Date.now() - t0;

  /* 只保留合法着法的概率（响应理论上是选项子集） */
  const pairs = Object.entries(probs).filter(([k]) => byNotation.has(k));
  if (pairs.length === 0) {
    const fallback = legal[0] as Move;
    return {
      notation: fallback.notation, move: fallback,
      meta: { channel, model: modelName, latencyMs, tacticsMs, usage, costUsd, confidence: 0, top: [],
              candidates: 0, candsSent, candsLabeled,
              provider: providerId, probSource,
              warning: '响应中无合法选项，已回退到首个合法着法', noul: answers.edge, score: answers.position,
              tactics: null, tacticsVersion: ver.id },
    };
  }
  pairs.sort((a, b) => b[1] - a[1]);

  /* 战术保险：十五级接管——致胜点必走、对方致胜必挡、己方活四点必走（活四+对方无先手五
   * = 理论必胜：两处成五点防不胜防）。概率只是偏好，事实优先。
   * 活四点由引擎以 criteria 保留标签 "you:open4" 声明（engine-interface 契约）。
   * v13 起再加一道**压力闸门**：对手做四点比我们多时先削点（pressureGate），不抢活三。
   *
   * 2026-10-03（P2）：整条链搬进 `src/core/takeover.ts` 的 `pickTakeover()`——指纹冻结与
   * P3 回放都要在**无模型**下跑「事实 + 层 + 落点」，链留在 `decide()` 里就必须发一次请求。
   * 搬运逐字，分支顺序/闸门/兜底路径不变；这里只做入参装箱与三变量回填。 */
  const criteria = (): Record<string, unknown> => {
    const q = ser.questions as Record<string, JevQuestion> | undefined;
    const c = q && q.move && q.move.criteria;
    return c && typeof c === 'object' ? c as Record<string, unknown> : {};
  };
  const tk = pickTakeover({
    engine, st, tactics, mech: M, criteria: criteria(), legal, pairs, cands,
    topK: opts.topK as number | undefined,
    /* 3-ply 安全排序同属战术层，算进 tacticsMs（多 danger 时这是本层最大的一块） */
    onTime: (ms) => { tacticsMs += ms; },
  });
  let notation: string | null = tk.notation;
  const tacticUsed: string | null = tk.layer;
  const tacticBypassed = tk.bypassed;

  /* top-k 概率加权随机（随机度） */
  if (!notation) {
    if (channel === 'random') {
      /* 真随机基线：自由手均匀采样，与 topK 无关——否则 topK=1 会把均匀概率
       * 坍缩成「取第一顺位」，退化成顺序走子（已验证过的坑）。战术接管不受影响。 */
      notation = (legal[rand(legal.length)] as Move).notation;
    } else {
      const k = Math.max(1, (opts.topK as number | undefined) || 1);
      if (k === 1) {
        notation = pairs[0]![0];
      } else {
        const top = pairs.slice(0, k);
        notation = weightedPick(top.map((p) => p[0]), top.map((p) => p[1]));
      }
    }
  }

  return {
    notation,
    move: byNotation.get(notation) || engine.moveFromNotation(st, notation),
    meta: {
      channel, model: modelName, latencyMs, tacticsMs, usage, costUsd, confidence: conf,
      top: pairs.slice(0, 8).map(([n, p]) => ({ notation: n, p })),
      candidates: pairs.length, /* 合法候选总数（模型给了概率且合法的点数，历史口径不动） */
      candsSent, /* 交给 Jev 决定的候选点数（C0） */
      candsLabeled, /* 其中带战术标签的点数（C0） */
      provider: providerId, /* C2/D-B6：这一手是哪家答的（primary / backup / 渠道名） */
      probSource, /* C2/D-B3：exact = 响应真给了逐点概率；derived = 没给，别当模型概率用 */
      restProb: pairs.slice(8).reduce((s, x) => s + x[1], 0), /* 第 9 名以后的概率合计 */
      noul: answers.edge ? (answers.edge as Record<string, unknown>).noul : undefined,
      score: answers.position ? (answers.position as Record<string, unknown>).score : undefined,
      tactics: tacticUsed,
      tacticsVersion: ver.id,
      warning: tacticBypassed
        ? '战术保险接管：Jev 概率未覆盖' + (TAKEOVER_LABEL[tacticUsed || ''] || '战术点') + '，已直接执行'
        : undefined,
    },
  };
}
