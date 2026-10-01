/**
 * 上游转发（`POST /api/jev` → TypeSafe System One）。
 *
 * 为什么单独成文件且必须注入 `fetcher`：这条路径是唯一一个**不能靠真 D1 测**的逻辑
 * （真发请求会烧额度、还会让测试依赖外网），把它写成纯函数 + 注入 fetcher，
 * 请求头/请求体/超时/错误映射就都能在单测里逐字节断言。
 *
 * ── 与旧实现的对齐（逐项：旧行为 → 新行为） ───────────────────────────────
 *
 * | 项 | 旧实现 | 新行为 | 等价？ |
 * |---|---|---|---|
 * | 端点 | `functions/api/jev.js`、`server.cjs` 都硬编码 `https://api.typesafe.ai/v1/systemone` | `DEFAULT_UPSTREAM_URL` 同值；可经 `call.url` 覆盖（本仓库暂无调用点覆盖，留给自建网关） | ✅ |
 * | 鉴权头 | `Authorization: 'Bearer ' + KEY` | 逐字相同 | ✅ |
 * | Content-Type | `application/json` | 逐字相同 | ✅ |
 * | key 来源 | 请求头 `X-Api-Key` > `env.TYPESAFE_API_KEY`（BYOK，服务端不存访客 key） | 与旧实现同序，但**提取动作留在路由**（见下）；本模块只接收已定好的 key | ✅ |
 * | 请求体字段 | `{ state, model: body.model \|\| 'jev-latest', questions }` —— **白名单透传** | 逐字相同 | ✅ |
 * | 是否透传 `messages`/`temperature`/`stream` | **不透传**（Jev 契约只有「三问一次并行」的 `state/model/questions`，`docs/jev-api.md` §1 是硬约束） | 同样不透传，且在路由层显式丢弃 | ✅ |
 * | 超时 | 浏览器 `js/jev-client.js` 30s（`AbortController` + `setTimeout`）；`server.cjs` 30s | 30s（`DEFAULT_TIMEOUT_MS`），由本模块自己的 `AbortController` + `setTimeout` 实现 | ✅ |
 * | 超时后 | 客户端把 AbortError 当「网络错误」退避重试；`server.cjs` 把 AbortError 映射成 **502** `上游请求失败：请求超时（30s）` | 网络/超时 → `upstream_error`（502），文案同源 | ✅ |
 * | 上游非 2xx | 两者都**原样透传状态码与响应体**（401/429/529 由客户端按自己的语义处理：401 不重试、429/529 退避） | 同样原样透传（含 `Retry-After`）；只有**连不上/超时**才 502 | ✅ |
 * | 响应体 | `functions/api/jev.js` 直接返回 `upstream.body` 流；`server.cjs` 先 `text()` 再发（非流式，因为 Node 端要拿长度） | **透传流**（新实现以 Pages Function 为对齐基准：Workers 是流式运行时，缓冲整包会把大响应顶到内存上限） | ✅（以 Pages 版为准） |
 * | 响应头 | 只有 `Content-Type: application/json`（旧 Pages 版硬编码，会把 SSE 的 `text/event-stream` 写成 JSON） | 上游 `Content-Type` 原样；SSE 因此天然可用的（本模块不缓冲流，见 `toPassthroughResponse`） | ⬆️ 修正 |
 * | 密钥泄漏 | 无日志/无错误体回显 | 同上：`error`/`reason` 只含错误**类名**（`AbortError`/`TypeError`），绝不含 key 或 `Authorization`；本文件不 import 任何 logger | ✅ |
 *
 * ── 为什么「兼容层字段」不在这里兜底 ──────────────────────────────────────
 * 任务书说「缺 apiKey/messages → invalid('bad_request', …)」，但旧实现的两套语义是：
 *  - 旧 `functions/api/jev.js`：key 来自 **`X-Api-Key` 请求头**（没有就从 env 兜底），
 *    请求体里根本没有 `apiKey` 字段；缺 key → **401**（不是 400/422）；
 *  - 旧 `server.cjs`：同序取值，缺 key → 401 `未提供 API Key：…`。
 * 新客户端（P5 迁移后）把 key 放请求体 `apiKey`，所以本模块**三条来源都收**，优先序取旧实现的
 * 「请求头 > env」，再补上「请求体」这条新路径（放最后，不改变旧客户端行为）。判定与错误码
 * （401 语义 → 新错误体 `code`）留在路由，本模块只在**没拿到 key** 时返回 `kind:'network'`
 * ——但正常路径不会走到那里，因为路由已经先挡了。
 */

/** 与旧实现同值：`functions/api/jev.js` / `server.cjs` / `js/jev-client.js` 都是这个端点。 */
export const DEFAULT_UPSTREAM_URL = 'https://api.typesafe.ai/v1/systemone';

/**
 * 超时：30s，与旧实现三处（浏览器 30s、Node 30s）完全一致。
 *
 * 为什么不是 Workers 上惯用的更短值：Jev 一次三问并行，实测单步 0.5–1.5K token 输入、
 * 首字节常在 2–10s；压到 10s 会在上游抖动时把本来能成的请求判死。而 Workers 的 CPU 限制
 * （免费 10 ms）**不限制 I/O 等待**，30s 的挂起不消耗 CPU 时间——旧值可以直接搬。
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 旧实现里 `body.model` 缺省就是 `'jev-latest'`（两套服务端 + 浏览器客户端三处同值）。 */
export const DEFAULT_MODEL = 'jev-latest';

/**
 * 转发失败的原因分类。刻意用**类名**而不是原始 message：
 * `fetch` 抛出的 message 在某些实现里会带上请求 URL（含 query 参数）甚至头信息，
 * 直接把 message 拼进错误体会是一个不必要的泄漏面。排障靠 `kind` + 日志里的 requestId。
 */
export type UpstreamFailureKind = 'timeout' | 'aborted' | 'network';

export interface UpstreamCall {
  /** 已确定的 key（路由按 请求头 > env > 请求体 的顺序取好）。为空即返回 `kind:'network'`。 */
  apiKey: string;
  /** 上游请求体：`state` / `model` / `questions` 三字段白名单，其余客户端字段一律不进上游。 */
  body: Record<string, unknown>;
  /** 覆盖端点（默认 `DEFAULT_UPSTREAM_URL`）。 */
  url?: string;
  timeoutMs?: number;
  /**
   * 调用方的中止信号：生产传 `c.req.raw.signal`（客户端断开/Gateway 超时后不必继续烧上游额度）。
   * 与内部超时控制器合并——两者任一触发都会 abort，但**判定分开**（见 `abortKind`）。
   */
  signal?: AbortSignal;
  /** 注入点：生产传全局 `fetch`；测试传假函数。**不要**在模块里直接引用全局 fetch。 */
  fetcher: typeof fetch;
}

export interface UpstreamSuccess {
  ok: true;
  status: number;
  /** 上游响应头（只读，构造 `Response` 时用 `passthroughHeaders` 过滤）。 */
  headers: Headers;
  /** 上游响应体流；`null` 表示无体（如 204）。 */
  body: ReadableStream<Uint8Array> | null;
}

export interface UpstreamFailure {
  ok: false;
  kind: UpstreamFailureKind;
  /** 已剔除敏感信息的原始错误类名，仅供日志。 */
  errorName: string;
}

export type UpstreamResult = UpstreamSuccess | UpstreamFailure;

/** 白名单响应头：旧 Pages 版把上游头全丢了，只写死 Content-Type，这里补回真正有用的几个。 */
const PASSTHROUGH_HEADERS = ['content-type', 'cache-control', 'retry-after'] as const;

/**
 * 转发一次 `POST {url}`。
 *
 * 不抛异常：失败以 `{ok:false}` 返回，让路由统一走 `fail(c, invalid('upstream_error', …))`
 * ——抛异常会落到 `app.onError` 变成 500，把「上游的错」写成「我们的错」。
 */
export async function callUpstream(call: UpstreamCall): Promise<UpstreamResult> {
  const url = call.url && call.url.trim() ? call.url.trim() : DEFAULT_UPSTREAM_URL;
  const timeoutMs =
    typeof call.timeoutMs === 'number' && Number.isFinite(call.timeoutMs) && call.timeoutMs > 0
      ? call.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const apiKey = typeof call.apiKey === 'string' ? call.apiKey.trim() : '';
  if (!apiKey) {
    // 正常路径不会到：路由已把「没 key」映射成 401。这里只是不让空 key 发出去。
    return { ok: false, kind: 'network', errorName: 'MissingApiKey' };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  /* 外部信号合并（旧浏览器实现同款做法：先查已 aborted，再挂一次性监听）。
   * 不要求 `AbortSignal.any`：它在 workerd 上可用，但显式合并更便于单测构造。 */
  const outer = call.signal;
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    /* `fetcher(...)` 而不是 `fetcher.call(globalThis, …)`：注入点常常是个箭头函数，
     * 直接调用即可避免 `Illegal invocation` 之类的 this 绑定问题。 */
    const response = await call.fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(call.body),
      signal: controller.signal,
    });
    /* 只在这里取 body 流引用，不读它的内容：一旦开始 await body，流式就没了。 */
    return { ok: true, status: response.status, headers: response.headers, body: response.body };
  } catch (error) {
    /* 判定顺序很重要：外部中止优先于超时——两者都会置 signal.aborted，
     * 但「客户端已经走了」和「上游太慢」在日志里是两件事。 */
    const kind: UpstreamFailureKind = outer?.aborted ? 'aborted' : timedOut ? 'timeout' : 'network';
    const errorName = error instanceof Error ? error.name : typeof error;
    return { ok: false, kind, errorName };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/** `kind` → 面向用户的中文文案（对齐 `server.cjs`：超时单独说明，其余并入「上游请求失败」）。 */
export function upstreamFailureMessage(kind: UpstreamFailureKind, timeoutMs: number = DEFAULT_TIMEOUT_MS): string {
  switch (kind) {
    case 'timeout':
      return `上游请求超时（${Math.round(timeoutMs / 1000)}s）：TypeSafe 未在时限内响应，请稍后重试`;
    case 'aborted':
      return '请求已取消：客户端中止了连接';
    default:
      return '上游请求失败：无法连接 TypeSafe 接口，请检查网络后重试';
  }
}

/**
 * 上游响应 → 透传响应。
 *
 * 为什么必须新建 `Response` 而不是 `new Response(up.body, upstream)`：上游的 `Response`
 * 可能带 `Content-Encoding: gzip` 之类的头，而 workerd 交出来的 body 已是**解压后的
 * 字节流**；照搬头会导致下游再解压一次（经典「乱码 body」坑）。所以只白名单透传
 * `content-type` / `cache-control` / `retry-after`（后者是 429/529 退避的依据）。
 *
 * 流式：body 原样挂上去，**不缓冲**。所以上游返回 `text/event-stream` 时，本函数产出的
 * 就是 SSE 响应（只在 Cloudflare 边缘链路上可能被重新分块，不会改变事件边界）。
 */
export function toPassthroughResponse(upstream: UpstreamSuccess): Response {
  const headers = passthroughHeaders(upstream.headers);
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** 白名单提取响应头；上游没给 `content-type` 时回落 JSON（旧实现写死的值）。 */
export function passthroughHeaders(from: Headers): Headers {
  const headers = new Headers();
  for (const name of PASSTHROUGH_HEADERS) {
    const value = from.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('content-type')) headers.set('Content-Type', 'application/json');
  return headers;
}
