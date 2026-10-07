/**
 * `POST /api/jev` —— BYOK 转发（ADR-0003 / ADR-0013）。
 *
 * 契约与旧实现逐字对齐的细节写在 `lib/upstream.ts` 的头注（端点/头/体/超时/错误映射），
 * 这里只写**路由层**自己的取舍。
 *
 * ── 旧行为 → 新行为 ───────────────────────────────────────────────────────
 *
 * | 项 | 旧实现（`functions/api/jev.js`、`server.cjs`） | 新行为 | 等价？ |
 * |---|---|---|---|
 * | 限流 | `functions/api/jev.js` 用 isolate 内存 Map（多实例各算各的，等于没限）；`server.cjs` 60/分；Pages 线上默认 **30/分**（`RATE_LIMIT_PER_MIN`） | D1 固定窗口 **30/分/IP**（`middleware/ratelimit.ts` 的 `jev` 桶，与线上现值一致） | ⬆️ 跨实例一致（这是计划 §5.3 明确要改的） |
 * | 429 响应体 | `{error: '请求过于频繁，请稍后再试（每 IP 每分钟 30 次）'}`，无 `code`、无 `Retry-After` | 统一错误体 `{error, code:'rate_limited', requestId}` + `Retry-After` 头 | ⬆️ 形状统一（计划 §5.5） |
 * | 缺 key | **401** `未提供 API Key：请在页面「Jev 设置」中填写你自己的 TypeSafe key` | **401**，同一句话，外加 `code:'unauthorized'` + requestId | ✅（状态码语义不变，码与状态码对齐） |
 * | key 取值序 | 请求头 `X-Api-Key` > `env.TYPESAFE_API_KEY` | 同序；再补「请求体 `apiKey`」（新客户端 P5 的写法，放最后，不影响旧客户端） | ✅ 向后兼容 |
 * | 非法 JSON | **422** `invalid JSON body` | **400** `bad_request`（请求体不是合法 JSON） | ⚠️ **故意改**：计划 §5.5 定「请求体格式错 = 400」，422 留给「格式对但内容不合法」的 `invalid_payload`；前端只按 `resp.ok` 分流，不受影响 |
 * | 请求体字段 | 只取 `state` / `model`（缺省 `jev-latest`）/ `questions`，其余丢弃 | 逐字相同（白名单在 `lib/upstream.ts`） | ✅ |
 * | 上游非 2xx | 原样透传状态码与响应体 | 逐字相同（额外补 `Retry-After` 传递） | ✅ |
 * | 上游不可达/超时 | `functions/api/jev.js`：未捕获异常 → **500**（Pages 把它变成 500，语义错）；`server.cjs`：**502** | **502** `upstream_error`（显式 catch，不让它落到 `onError`） | ⬆️ 修正 Pages 版 |
 * | CORS | Pages Function 没写 CORS 头（同源代理不需要）；`functions/api/_github.js` 另说 | 仅本路由加 `Access-Control-Allow-Origin`：回显 `Origin`，**不回显凭证头**（BYOK 语义：key 在请求体/头里，不靠浏览器凭证） | ➕ 计划 §5.2「cors 仅 /api/jev 需要」 |
 *
 * ── 为什么用 `req.text()` 而不是 `lib/validate.ts` 的 `readJsonBody` ────────
 * `readJsonBody` 把「体为空 / 非法 JSON / 读失败」都收敛成 `bad_request`，而本路由要按旧契约
 * 把消息说清楚（前端设置面板直接展示 `error` 文案，用户要能看出「是 JSON 写坏了」还是「没填 key」）。
 * 形状校验集中在 `parseJevRequest`，它是本文件唯一的校验点。
 *
 * ── 为什么 `c.req.raw.signal` 要传给上游 ────────────────────────────────────
 * 前端「切棋种/重开」会 abort 在途请求（`js/jev-client.js` 的 `opts.signal`）。不把这个信号
 * 传下去，Worker 仍会替一个已经没人等的请求烧完上游额度——BYOK 是用户自己付费，这点更值得省。
 *
 * ── 兜底提供方（C2，plan 2026-10-03-cands-metric-and-provider-failover）────────
 * 主家仍是 TypeSafe 官方；只有 `env.COMMANDCODE_API_KEY` 配了、且（`env.JEV_FAILOVER==='on'`
 * 或客户端显式 `X-Jev-Provider: backup`）时才把 commandcode 加进候选。切换判据在
 * `lib/failover.ts`（与浏览器直连面共用 `core/jev/providers.ts` 的分类）。响应加两个头：
 * `X-Jev-Provider`（这一手谁答的）与切换时的 `X-Jev-Provider-Switch`（原因，百分号编码）。
 * 默认 `JEV_FAILOVER: "off"` + 没配 secret ⇒ 没有任何行为变化（见 §7 未决项）。
 */
import { Hono } from 'hono';
import {
  PROVIDER_BACKUP,
  PROVIDER_HINT_HEADER,
  PROVIDER_SWITCH_HEADER,
  defaultProvider,
  providerOf,
} from '../../core/jev/providers.ts';
import { callUpstreamWithFailover, type UpstreamAttempt } from '../lib/failover.ts';
import { rateLimit } from '../middleware/ratelimit.ts';
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  OPENCODE_UPSTREAM_URL,
  callUpstream,
  toPassthroughResponse,
  upstreamFailureMessage,
} from '../lib/upstream.ts';

/** OpenCode Zen 免费托管档的 model 名（客户端 CHANNELS.opencode 与它必须一致）。 */
export const OPENCODE_MODEL = 'jev-1.13-free';
import { fail, invalid, type Parsed } from '../lib/validate.ts';
import type { AppEnv } from '../types.ts';

export const jevRoute = new Hono<AppEnv>();

/* ---------- 形状校验 ---------- */

export interface JevRequest {
  /** 上游请求体：只有这三个字段（白名单，见 upstream.ts）。 */
  body: { state: unknown; model: string; questions: unknown };
  /** 已按优先级取好的 key。opencode 渠道（匿名免费档）允许为空串。 */
  apiKey: string;
  /** key 来自哪儿——只用于日志（**不记值**），排障时能分辨「用户没填」还是「env 没配」。 */
  keySource: 'header' | 'env' | 'body' | 'anonymous';
  /** 上游端点覆盖（opencode 渠道指向 OpenCode Zen；缺省 = TypeSafe 官方）。 */
  upstreamUrl?: string;
  /** opencode 免费档允许匿名（无 key 也放行）。 */
  allowAnonymous: boolean;
}

/** 旧实现里 `questions` 是对象（`{move, edge, position}`）；数组也放行（上游报 422 比我们猜更准）。 */
function isQuestions(value: unknown): boolean {
  return Array.isArray(value) || (typeof value === 'object' && value !== null);
}

/**
 * 请求体 → 上游调用参数。
 *
 * 错误码选择：体不是 JSON / 体不是对象 / 缺 `state` / `questions` 形状不对 → `bad_request`(400)；
 * 缺 key → `unauthorized`(401)。旧实现是「状态码 401 + 靠文案里的『API Key』判定」，新实现让
 * **错误码自己承载语义**，路由层不再做字符串匹配（`lib/http.ts` 为此新增了 `unauthorized`，
 * 计划 §5.5 的错误码表只列了错误体形状、没有穷举码，属兼容扩展）。
 */
export function parseJevRequest(
  raw: unknown,
  opts: { headerKey: string | null; envKey?: string },
): Parsed<JevRequest> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid('bad_request', '请求体必须是 JSON 对象');
  }
  const body = raw as Record<string, unknown>;

  /* key 优先级 = 旧实现的「请求头 > env」，再补「请求体 apiKey」。三处都 trim：
   * 设置面板粘贴 key 常带首尾空白/换行，旧实现不 trim，会把「带空格的 key」原样发出去
   * 换来一个上游 401——这里顺手修掉，用户侧表现是「粘贴即用」。 */
  const headerKey = opts.headerKey?.trim() ?? '';
  const envKey = opts.envKey?.trim() ?? '';
  const bodyKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const apiKey = headerKey || envKey || bodyKey;
  const keySource: JevRequest['keySource'] = headerKey ? 'header' : envKey ? 'env' : bodyKey ? 'body' : 'anonymous';
  /* opencode 免费托管档（model = jev-1.13-free）：匿名可用（实测无 key 也 200），
     有 key（使用者自己的）走自己的限额。其余 model 维持「缺 key → 401」的原语义。 */
  const isOpencode = body.model === OPENCODE_MODEL;
  if (!apiKey && !isOpencode) {
    return invalid('unauthorized', '未提供 API Key：请在页面「Jev 设置」中填写你自己的 TypeSafe key');
  }

  if (body.state === undefined || body.state === null) {
    return invalid('bad_request', '请求体缺少 state（局面描述）');
  }
  if (!isQuestions(body.questions)) {
    return invalid('bad_request', '请求体缺少 questions（三问并行：move/edge/position）');
  }

  return {
    ok: true,
    value: {
      // model 缺省值与旧实现一致（'jev-latest'）。非字符串/空串当没给
      // ——旧实现 `body.model || 'jev-latest'` 的意图；0 本来也不是合法 model 名。
      body: {
        state: body.state,
        model: typeof body.model === 'string' && body.model.trim() ? body.model : DEFAULT_MODEL,
        questions: body.questions,
      },
      apiKey,
      keySource,
      upstreamUrl: isOpencode ? OPENCODE_UPSTREAM_URL : undefined,
      allowAnonymous: isOpencode,
    },
  };
}

/* ---------- CORS（只在本路由） ---------- */

interface CorsTarget {
  req: { header: (name: string) => string | undefined };
  header: (name: string, value: string) => void;
}

/**
 * 回显 `Origin` 而不是写 `*`：本路由会带 `X-Api-Key`（自定义头），写 `*` 在部分浏览器/网关
 * 组合下会被当成「不允许自定义头」导致预检失败。不回显 `Access-Control-Allow-Credentials`
 * ——BYOK 不依赖 Cookie，开了只会放大风险面。
 */
function applyCors(c: CorsTarget): void {
  const origin = c.req.header('origin');
  if (!origin) return;
  for (const [name, value] of Object.entries(corsHeaders(origin))) c.header(name, value);
}

/**
 * CORS 头集中在这里，是因为**成功路径要自己拼 Response**（透传上游流 + 加提供方头），
 * 而 `c.header()` 设的「预备头」只在 `c.body()/c.json()` 这类路径上会被带上——
 * 直接把 `fetch()` 的响应 return 出去时会被丢掉（Hono 的 `res` setter 只在已存在 `#res` 时合并）。
 * 旧实现里 POST 成功响应因此**没有** CORS 头：同源部署看不出来，跨源就抓瞎。顺手修掉。
 */
function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // `X-Jev-Provider` 是客户端用来做「局内粘滞」的提示头（C2 / D-B2）
    'Access-Control-Allow-Headers': `Content-Type, X-Api-Key, ${PROVIDER_HINT_HEADER}`,
    // 自定义响应头默认不暴露给跨源 JS：不回这两个头，客户端读不到「这一手是谁答的」
    'Access-Control-Expose-Headers': `${PROVIDER_HINT_HEADER}, ${PROVIDER_SWITCH_HEADER}`,
    'Access-Control-Max-Age': '86400',
  };
}

/* ---------- 兜底提供方（C2） ---------- */

/**
 * 本请求要按什么顺序试哪些提供方。
 *
 * - 主家永远是 TypeSafe 官方（BYOK key + 客户端指定的 `model`，向后兼容）；
 * - 兜底只在**两个条件同时满足**时加入：`env.COMMANDCODE_API_KEY` 有值，且
 *   （`env.JEV_FAILOVER === 'on'` 自动切 **或** 客户端显式带 `X-Jev-Provider: backup`）。
 *   显式那一路是「切换已经发生、本局粘滞在兜底上」——此时兜底是唯一选择，仍需 key 存在。
 * - 没有兜底时 `attempts.length === 1`，`callUpstreamWithFailover` 退化成原来的单次转发。
 *
 * 导出只为单测：路由本身没法在 workerd 里换掉全局 `fetch`（见 `test/worker/jev.spec.ts` 头注），
 * 所以「什么条件下才带兜底」这条策略必须能脱离网络被钉住。
 */
export function providerAttempts(
  env: { COMMANDCODE_API_KEY?: string; JEV_FAILOVER?: string },
  hint: string | null,
  apiKey: string,
  body: { state: unknown; model: string; questions: unknown },
): UpstreamAttempt[] {
  const primary = defaultProvider();
  const attempts: UpstreamAttempt[] = [{ provider: primary, apiKey }];
  const backupKey = env.COMMANDCODE_API_KEY?.trim() ?? '';
  if (!backupKey) return attempts;
  const auto = (env.JEV_FAILOVER ?? '').trim().toLowerCase() === 'on';
  if (!auto && hint !== PROVIDER_BACKUP) return attempts;
  const backup = providerOf(PROVIDER_BACKUP);
  if (!backup) return attempts;
  /* 换家就得换模型名：兜底网关只认 `typesafe/jev`（主家那套 `jev-latest` 送过去是 400） */
  attempts.push({ provider: backup, apiKey: backupKey, body: { ...body, model: backup.model } });
  return attempts;
}

/**
 * 切换原因要进响应头，而 HTTP 头只能是 latin-1：中文原因（`TypeSafe 官方 HTTP 401`）直接写会炸，
 * 所以百分号编码，客户端读的时候解码（`decodeURIComponent`，失败就退回原文）。
 */
function encodeSwitchReason(info: { from: string; to: string; reason: string }): string {
  return `${info.from}->${info.to}; ${encodeURIComponent(info.reason)}`;
}

/* ---------- 路由 ---------- */

/* 预检：必须在 `rateLimit` 之前挂 —— OPTIONS 不消耗上游额度，也不该占限流桶。 */
jevRoute.options('/', (c) => {
  applyCors(c);
  return c.body(null, 204);
});

jevRoute.post('/', rateLimit('jev'), async (c) => {
  applyCors(c);

  const requestId = c.get('requestId');
  const startedAt = Date.now();

  /* 1) 读原始文本（刻意不用 `readJsonBody`：要把「空体」与「非法 JSON」分开说明，见头注） */
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return fail(c, invalid('bad_request', '读取请求体失败'));
  }
  if (!text.trim()) {
    return fail(c, invalid('bad_request', '请求体不能为空'));
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return fail(c, invalid('bad_request', '请求体不是合法 JSON'));
  }

  /* 2) 形状校验（含 key 优先级）。缺 key → `unauthorized`(401)，其余 400（§5.5）。 */
  const parsed = parseJevRequest(raw, {
    headerKey: c.req.header('x-api-key') ?? null,
    envKey: c.env.TYPESAFE_API_KEY,
  });
  if (!parsed.ok) return fail(c, parsed);
  const { body, apiKey, keySource } = parsed.value;

  /* 2.5) opencode 免费托管档短路：model = jev-1.13-free ⇒ 直连 OpenCode Zen（不进兜底状态机）。
   *    匿名免费档（无 key）可用；带了使用者自己的 key 就带上（走自己的限额）。
   *    失败直接映射 upstream_error（免费档无兜底语义——备胎还是免费的它自己）。 */
  if (parsed.value.upstreamUrl) {
    const startedOpenCode = Date.now();
    const result = await callUpstream({
      apiKey,
      allowAnonymous: parsed.value.allowAnonymous,
      url: parsed.value.upstreamUrl,
      body,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal: c.req.raw.signal,
      fetcher: (...args) => fetch(...args),
    });
    const elapsedMs = Date.now() - startedOpenCode;
    if (result.ok) {
      const response = toPassthroughResponse(result);
      response.headers.set('X-Jev-Upstream', 'opencode');
      console.log(`[jev] opencode requestId=${c.get('requestId')} ms=${elapsedMs} anonymous=${!apiKey}`);
      return response;
    }
    return fail(c, invalid('upstream_error', upstreamFailureMessage(result.kind)));
  }

  /* 3) 转发。`fetcher` 传全局 fetch（生产路径）；`signal` 传客户端信号（客户端断开即中止）。
   *    `providerAttempts` 决定要不要带兜底（C2）：没配 `COMMANDCODE_API_KEY` 时只有一个尝试，
   *    行为与加兜底之前逐字相同。 */
  const attempts = providerAttempts(c.env, c.req.header(PROVIDER_HINT_HEADER) ?? null, apiKey, body);
  const outcome = await callUpstreamWithFailover({
    attempts,
    body,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    signal: c.req.raw.signal,
    fetcher: (...args) => fetch(...args),
  });
  const result = outcome.result;

  const elapsedMs = Date.now() - startedAt;

  if (!result.ok) {
    /* 客户端自己走的（切棋种/重开）：连接已断，响应多半没人收，用非标准的 499 与真 502 区分。
     * 日志只记 kind/errorName/keySource，**不记 key、不记请求体**（请求体里有局面与用户 key）。 */
    if (result.kind === 'aborted') {
      console.warn(`[jev] aborted requestId=${requestId} kind=${result.kind} ms=${elapsedMs}`);
      /* `new Response` 而不是 `c.json(…, 499)`：499 不在 Hono 的 `ContentfulStatusCode`
       * 联合里（它不是标准状态码，编译期会被拒），而这里就是想用非标准值把「客户端自己
       * 走了」与真 502 分开。运行时行为与 `c.json` 一致。 */
      return new Response(JSON.stringify({ error: upstreamFailureMessage(result.kind, DEFAULT_TIMEOUT_MS) }), {
        status: 499,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error(
      `[jev] upstream failed requestId=${requestId} kind=${result.kind} error=${result.errorName} keySource=${keySource} ms=${elapsedMs}`,
    );
    return fail(c, invalid('upstream_error', upstreamFailureMessage(result.kind, DEFAULT_TIMEOUT_MS)));
  }

  /* 4) 原样透传（含流式：`toPassthroughResponse` 不读 body）。429/529 交给客户端退避
   *    （docs/jev-api.md §1）——服务端再重试会把一次用户点击变成 N 次上游计费。
   *
   *    提供方头（C2）：`X-Jev-Provider` 告诉客户端这一手是谁答的（归因 + 局内粘滞），
   *    发生切换时多一个 `X-Jev-Provider-Switch`。响应是新建的，所以 CORS 头要在这里补
   *    ——`applyCors(c)` 设的预备头在「直接 return fetch 响应」这条路径上会被丢掉（见 `corsHeaders`）。 */
  console.log(
    `[jev] status=${result.status} requestId=${requestId} keySource=${keySource} provider=${outcome.providerId}` +
      `${outcome.switchInfo ? ` switch=${outcome.switchInfo.from}->${outcome.switchInfo.to}` : ''}` +
      ` upstreamCalls=${outcome.upstreamCalls} ms=${elapsedMs}`,
  );

  const passthrough = toPassthroughResponse(result);
  const headers = new Headers(passthrough.headers);
  const origin = c.req.header('origin');
  if (origin) for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  headers.set(PROVIDER_HINT_HEADER, outcome.providerId);
  if (outcome.switchInfo) headers.set(PROVIDER_SWITCH_HEADER, encodeSwitchReason(outcome.switchInfo));
  return new Response(passthrough.body, { status: passthrough.status, statusText: passthrough.statusText, headers });
});
