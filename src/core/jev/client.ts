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

/** 单次请求（含 BYOK 头、超时与外部取消合并）。 */
async function callRaw(channel: string, body: JevSerialized, opts: DecideOpts): Promise<Record<string, unknown>> {
  const cfg = CHANNELS[channel];
  if (!cfg) throw new Error('未知渠道: ' + channel);
  const endpoint = opts.endpoint || cfg.endpoint;
  const custom = !!opts.endpoint; /* 自定义端点：兼容自建网关，不强制 key */
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (channel === 'proxy') {
    if (opts.apiKey) headers['X-Api-Key'] = opts.apiKey;
  } else if (cfg.keyName) {
    if (!opts.apiKey && !custom) throw new Error('尚未填写该渠道的 API Key（右上「Jev 设置」）');
    if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
    if (channel === 'openrouter') headers['HTTP-Referer'] = locationOrigin() || 'http://localhost';
  }
  const payload = { state: body.state, model: cfg.model, questions: body.questions };

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
    return await resp.json() as Record<string, unknown>;
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
 * 带退避重试的请求：网络错误 4 次尝试；429/529 按 `Retry-After`（缺省指数退避）重试 5 次；
 * 401 直接报鉴权失败。
 *
 * 2026-10-01 修：旧写法在 429 分支里**没有给 `lastErr` 赋值**，于是 5 次限流之后抛的是
 * `重试次数用尽`——排障时完全看不出「被限流了」，而真实原因（每 IP 30/分）恰恰是用户
 * 唯一能改的东西。现在每次失败都留下带状态码与等待策略的错误，并打上 `retryable`。
 */
async function callWithRetry(channel: string, body: JevSerialized, opts: DecideOpts): Promise<Record<string, unknown>> {
  let networkTries = 0;
  let rateLimitTries = 0;
  for (;;) {
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');
    try {
      return await callRaw(channel, body, opts);
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
          throw markRetryable(new Error(`上游限流（HTTP ${err.status}）：已退避重试 ${rateLimitTries} 次仍未放行`
            + (err.detail ? '（' + err.detail.slice(0, 120) + '）' : '')), true);
        }
        if (opts.onRetry) opts.onRetry(err.status, rateLimitTries - 1);
        /* 服务端给了 `Retry-After` 就听它的（截到 20 秒）；没给才用指数退避 1/2/4/8 秒。 */
        const waitMs = Math.min(err.retryAfterMs ?? 1000 * Math.pow(2, rateLimitTries - 1), MAX_RATE_LIMIT_BACKOFF_MS);
        await sleep(waitMs);
        continue;
      }
      if (err.status === 401) {
        throw markRetryable(new Error('API Key 无效或缺失（401）——若 key 确认无误（「测试连接」通过），可能是服务端瞬时故障，稍后点「重试」即可'), false);
      }
      throw markRetryable(new Error('API 错误 ' + err.status + '：' + (err.detail || '')), false);
    }
  }
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
  if (channel === 'random') {
    /* 纯随机基线（对比实验用）：均匀概率、零启发式，照样走完整战术管线。
     * 与 mock 的区别：mock 直接返回不经过战术层；random 刻意走战术层，
     * 这样「随机+战术」 vs 「Jev+战术」的唯一变量就是概率分布的质量。 */
    answers = {}; usage = {};
    costUsd = 0; modelName = 'random-baseline';
    probs = {};
    legal.forEach((m) => { probs[m.notation] = 1; });
    conf = null;
  } else {
    const data = await callWithRetry(channel, ser, opts) as { answers?: Record<string, unknown>; usage?: Record<string, unknown>; model?: string };
    answers = data.answers || {};
    usage = data.usage || {};
    costUsd = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) * 42 / 1e9; /* 输入 $42/十亿token，输出免费 */
    modelName = data.model;
    const ans = (answers.move || {}) as { probabilities?: Record<string, number>; confidence?: unknown };
    probs = ans.probabilities || {};
    conf = typeof ans.confidence === 'number' ? ans.confidence : null;
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
