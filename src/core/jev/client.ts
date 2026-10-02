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
  computeTactics, attachFacts, emptyTactics,
  countForcingReplies, allowsSustainedAttack,
  resolveVersion,
} from '../tactics.ts';
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
  try {
    const q = ser.questions as Record<string, JevQuestion> | undefined;
    const crit = q && q.move && q.move.criteria;
    if (crit && typeof crit === 'object') cands = Object.keys(crit as Record<string, unknown>);
  } catch (_) { /* 降级为全量 */ }
  { /* 块级作用域：tt 只是这一段的秒表，别漏到函数作用域里 */
    const tt = Date.now();
    try { tactics = computeTactics(engine, st, legal, cands, opts.tacticsVersion); } catch (_) { /* 任何引擎差异都降级为空战术 */ }
    tacticsMs += Date.now() - tt;
  }
  attachFacts(ser, tactics, opts.experience);

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
              candidates: 0, warning: '响应中无合法选项，已回退到首个合法着法', noul: answers.edge, score: answers.position,
              tactics: null, tacticsVersion: ver.id },
    };
  }
  pairs.sort((a, b) => b[1] - a[1]);

  /* 战术保险：十三级接管——致胜点必走、对方致胜必挡、己方活四点必走（活四+对方无先手五
   * = 理论必胜：两处成五点防不胜防）。概率只是偏好，事实优先。
   * 活四点由引擎以 criteria 保留标签 "you:open4" 声明（engine-interface 契约）。
   * v13 起再加一道**压力闸门**：对手做四点比我们多时先削点（pressureGate），不抢活三。 */
  let notation: string | null = null;
  let tacticUsed: string | null = null;
  let tacticBypassed = false;
  /* 战术点中文名（接管提示用） */
  const tacticName = (): string => ({
    win: '致胜点', block: '必挡点', open4: '活四点', threat: '造杀点',
    vcfAttack: '连续冲四将死链', vcfDefense: '将死链干预点', vctAttack: '连续威胁链首步',
    vctDefense: '拆连续威胁链', pressureGate: '削对手做四点',
    live3Attack: '活三抢攻点', live3Defense: '拆活三点', parry: '拆杀点',
    parry3: '活三/活四预挡点', parry4: '冲四预挡点',
  } as Record<string, string>)[tacticUsed || ''] || '战术点';
  const pickAmong = (list: string[]): string | null => {
    const inPairs = pairs.filter(([n]) => list.indexOf(n) >= 0);
    const k2 = Math.max(1, (opts.topK as number | undefined) || 1);
    if (inPairs.length) {
      if (k2 > 1 && inPairs.length > 1) {
        return weightedPick(inPairs.map((p) => p[0]), inPairs.map((p) => p[1]));
      }
      return inPairs[0]![0];
    }
    tacticBypassed = true;
    const mv = engine.moveFromNotation(st, list[0] as string);
    return mv ? mv.notation : null;
  };
  /* 拆杀点安全性排序：多个 danger 并存时逐个试走，优先排除给对方持续攻击节奏的
   * 坏点（3-ply：对手 p → 我逼杀 q → 对手被迫堵 → 我仍有 danger），剩余再按逼杀数
   * 排序。单个点或非 deepTactics 引擎时回退到 pickAmong。 */
  const pickSafestParry = (list: string[]): string | null => {
    if (list.length <= 1) return pickAmong(list);
    const oppSide = engine.sides && engine.sides.find((s) => s.id !== (st as { turn: string }).turn);
    if (!oppSide || !engine.deepTactics) return pickAmong(list);
    const candNs = (cands && cands.length) ? cands : legal.map((m) => m.notation);
    const tt = Date.now();
    try {
      /* 第一轮：排除允许持续攻击的坏点 */
      const good = list.filter((p) => !allowsSustainedAttack(engine, st, p, oppSide.id, (st as { turn: string }).turn, candNs));
      const pool = good.length ? good : list;
      if (pool.length === 1) return pool[0] as string;
      /* 第二轮：按逼杀着法数排序，取最少 */
      let best: string | null = null, bestScore = Infinity;
      for (const p of pool) {
        const score = countForcingReplies(engine, st, p, oppSide.id, candNs);
        if (score < bestScore) { bestScore = score; best = p; }
      }
      if (best) return best;
    } catch (_) { /* 降级 */ } finally {
      /* 3-ply 安全排序同属战术层，算进 tacticsMs（多 danger 时这是本层最大的一块） */
      tacticsMs += Date.now() - tt;
    }
    return pickAmong(list);
  };
  /* 引擎标签层（open4 / parry3 / parry4）同样按版本闸门：版本没实现的层连
   * criteria 都不用扫，才能让老版本的战略行为可复现。 */
  const criteria = (): Record<string, unknown> => {
    const q = ser.questions as Record<string, JevQuestion> | undefined;
    const c = q && q.move && q.move.criteria;
    return c && typeof c === 'object' ? c as Record<string, unknown> : {};
  };
  const open4Points = M.open4 ? Object.entries(criteria())
    .filter(([n, v]) => typeof v === 'string' && /(^|\+)you:open4(\+|$)/.test(v) && byNotation.has(n))
    .map(([n]) => n) : [];
  /* 第四级（3-ply 预挡）：对手的 deny:open4/deny:live3 标签点 = 对方下回合可造活四/活三的
   * 制造点。放任不管会被迫逐手拆杀（实战败局：p20 白走闲着 E6，黑 E7 活三点 → 强制拆 →
   * J8 双杀 → 输）。win/block/open4/threat/parry 都无时抢先占掉，让对手造不成活三。
   * 第五级（Rapfi 实战复盘 2026-09-29 增补）：deny:four = 对方下回合可造冲四（单杀逼迫链
   * 起点）。Rapfi 对局显示：放任冲四制造点会被连续单杀逼迫 → 双杀收尾（4 局 3 次）。
   * 优先级 deny:open4/deny:live3 > deny:four（后者多为单杀，可被 block 层处理，但提前
   * 抢占能打断对方的连续逼杀节奏）。 */
  const parry3Points = M.parry3 ? Object.entries(criteria())
    .filter(([n, v]) => typeof v === 'string' && /(^|\+)deny:(open4|live3)(\+|$)/.test(v) && byNotation.has(n))
    .map(([n]) => n) : [];
  const parry4Points = M.parry4 ? Object.entries(criteria())
    .filter(([n, v]) => typeof v === 'string' && /(^|\+)deny:four(\+|$)/.test(v) && byNotation.has(n))
    .map(([n]) => n) : [];
  if (tactics.winning_points_you.length) {
    notation = pickAmong(tactics.winning_points_you);
    if (notation) tacticUsed = 'win';
  } else if (tactics.winning_points_opponent.length) {
    notation = pickAmong(tactics.winning_points_opponent);
    if (notation) tacticUsed = 'block';
  } else if (open4Points.length) {
    notation = pickAmong(open4Points);
    if (notation) tacticUsed = 'open4';
  } else if (tactics.chance_points_you.length) {
    notation = pickAmong(tactics.chance_points_you);
    if (notation) tacticUsed = 'threat';
  } else if (tactics.vcf_win_you.length) {
    /* VCF 进攻：连续冲四将死链的首步。排在 threat 之后（双杀两步胜更快）、
     * parry 之前（将死链是强制胜，比「对方下回合可能造双杀」更紧急）。 */
    notation = pickAmong(tactics.vcf_win_you);
    if (notation) tacticUsed = 'vcfAttack';
  } else if (tactics.vct_win_you.length) {
    /* v11 VCT 抢攻：VCF（纯冲四）看不见、但含「活三逼迫」的连续威胁链的首步。
     * 实测 24 局里 v10 有 20 手（7 局）存在这种算得清的必胜链，当时却走了启发式活三点，
     * 其中两局因此和棋。与 vcfAttack 同级（都是强制胜，排在防守之前）。 */
    notation = pickAmong(tactics.vct_win_you);
    if (notation) tacticUsed = 'vctAttack';
  } else if (tactics.vcf_win_opponent.length) {
    /* VCF 防守：对方将死链的干预点（链条入口）。将死是强制输，比 parry 的
     * 「潜在双杀」更紧急，故优先。 */
    notation = pickAmong(tactics.vcf_win_opponent);
    if (notation) tacticUsed = 'vcfDefense';
  } else if (tactics.vct_win_opponent.length) {
    /* v12 拆连续威胁链：对手的混合链（活三逼迫 + 冲四收尾）在 vcfDefense 只验纯冲四时会被放行。
     * 实测两轮 48 个「我方无杀而对手有链」的回合里漏 15 个，其中 2 个存在能拆的点却没走
     * （计时轮 #8 ply24 → K9、首轮 #6 ply52 → K8，两手实走都落在 parry 上）。
     * 排在 vcfDefense 之后（纯冲四链已有拆点时先按原路走）、live3Attack 之前
     * （对手的强制胜比我们先手造活三快）。 */
    notation = pickAmong(tactics.vct_win_opponent);
    if (notation) tacticUsed = 'vctDefense';
  } else if (M.pressureGate && tactics.pressure_cut_points.length
      && tactics.pressure_opponent > tactics.pressure_you
      && !tactics.danger_points_opponent.length) {
    /* v13 压力闸门：对手的「做四手数」压过我们时，先削点再谈进攻。ADR-0015 已证明活三不是杀
     * （两个 L2 点互斥，「4 手内必胜」不成立），它只是逼手；真正危险的是对手造四点密集
     * （双四威胁 = 2 手胜）。六轮实测 39 个「我们仍去抢活三而对手做四点已领先」的回合里，
     * 实走之后对手仍握双四威胁的有 37 个；改用 1-ply 削点（引擎 pressureCut）压对手做四手数，
     * 37/39 更优、0 手更差，平均 −1.87 个，双四威胁 37 → 7。削点为空时本层不开火，
     * 行为与 v12 完全一致；真强制胜早被上面的 vcfAttack / vctAttack 接管，故不漏杀。
     * 排在 live3Attack 之前（抢活三正是要拦的那一步）、live3Defense 之前（削点比破活三点更普适：
     * 它直接压对手的做四手数，而 live3_deny_points 在实测里经常为空）。
     * 与 live3Attack 同一条安全线：对手已有「危险点」时本层让位给 parry/safeSort（实测 p18 那类
     * 「双 danger 并存」的局面里，pressureCut 只认手数、不认对手下一步的杀，会挑出走子方偏好的
     * 危险点，所以必须显式挡住）。 */
    notation = pickAmong(tactics.pressure_cut_points);
    if (notation) tacticUsed = 'pressureGate';
  } else if (M.live3Attack && !tactics.danger_points_opponent.length && tactics.live3_you.length) {
    /* v10 活三抢攻：自己的 L3（落子后 ≥2 个活四制造点）＝ 4 手内必胜。排在 vcf 之后
     * （将死链是强制胜，更快），parry 之前（对手下回合的双杀还没成型时我们先手更划算）。
     * danger_points_opponent 非空时让位：对手下回合就能造活四（2 手胜），我们先手 4 手剑
     * 会输速度——那种局面交给下面的 parry 层。
     * v13 压力闸门（见上一分支）在入口处先接管：对手做四点领先且存在削点时不会走到这里。 */
    notation = pickAmong(tactics.live3_you);
    if (notation) tacticUsed = 'live3Attack';
  } else if (M.live3Defense && !tactics.danger_points_opponent.length && tactics.live3_deny_points.length) {
    /* v10 拆活三：对手有 L3 时走引擎算出的破点（让对手 L3 点数归零的那些点）。
     * 排在 parry3（模型自己的 deny:live3 标签）之前：标签只认连续 XXX，跳活三/斜向组合
     * 根本打不出标签，而实测 27 局 rapfi 归档里 14 局正是死在这种认不出的活三上。 */
    notation = pickAmong(tactics.live3_deny_points);
    if (notation) tacticUsed = 'live3Defense';
  } else if (M.safeSort && tactics.danger_points_opponent.length) {
    /* v5 起多 danger 并存时 3-ply 安全排序；v5 之前直接取概率最高者 */
    notation = pickSafestParry(tactics.danger_points_opponent);
    if (notation) tacticUsed = 'parry';
  } else if (tactics.danger_points_opponent.length) {
    notation = pickAmong(tactics.danger_points_opponent);
    if (notation) tacticUsed = 'parry';
  } else if (parry3Points.length) {
    notation = pickAmong(parry3Points);
    if (notation) tacticUsed = 'parry3';
  } else if (parry4Points.length) {
    notation = pickAmong(parry4Points);
    if (notation) tacticUsed = 'parry4';
  }

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
      candidates: pairs.length, /* 合法候选总数 */
      restProb: pairs.slice(8).reduce((s, x) => s + x[1], 0), /* 第 9 名以后的概率合计 */
      noul: answers.edge ? (answers.edge as Record<string, unknown>).noul : undefined,
      score: answers.position ? (answers.position as Record<string, unknown>).score : undefined,
      tactics: tacticUsed,
      tacticsVersion: ver.id,
      warning: tacticBypassed
        ? '战术保险接管：Jev 概率未覆盖' + tacticName() + '，已直接执行'
        : undefined,
    },
  };
}
