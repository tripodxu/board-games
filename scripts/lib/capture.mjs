/* capture.mjs — 把每一次上游调用原样留存到 JSONL（官方 API 复现/审计用）
 *
 * 为什么要有它：业主在 v15/v14-plus 重测中要求「所有调用的官方数据和结果都要保存下来」——
 * 现有产物只落了逐手决策（ai.choice/probs 摘要）与终局，**没有请求原文**。有了请求+响应原文，
 * 任何一次调用都能脱离渠道独立复现（对齐官方基准的留存理念），也是渠道判别/争议的物证。
 *
 * 红线（AGENTS 规则 7：密钥永不入仓库/日志）：
 *   - **绝不写 Authorization / x-api-key 等鉴权头**（连前缀都不记）；
 *   - 请求体、响应体是模型输入输出（棋局文本），不含 key，可存；
 *   - 文件只落在 box 的 .work/ 下（gitignored），不入库。
 *
 * 设计：与 installFetchThrottle 同样的「包 globalThis.fetch」方式——client.ts 直接调全局 fetch、
 * 无注入点，只有包全局才能做到「每个真实请求都记」。按 host 过滤（默认只记上游主机）。
 * 每调用一行 JSON 追加写（崩了不丢，可 tail -f 观察），响应体用 clone 读、不影响调用方消费。
 */
import { appendFileSync } from 'node:fs';

/** 需要抹掉的敏感头（大小写不敏感）。只按前缀判定，绝不落原值。 */
const SENSITIVE_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'openai-organization'];

/** 从 init.headers 里挑出非敏感头（值原样保留，用于复现 UA/Content-Type 等）。 */
export function safeHeaders(init) {
  const out = {};
  const h = init && init.headers;
  if (!h) return out;
  const entries = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of entries) {
    if (SENSITIVE_HEADERS.includes(String(k).toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** 解析请求体（JSON 字符串或对象）为对象；解析失败则原样存截断字符串。 */
function parseBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return { _raw: body.slice(0, 4000) }; }
  }
  if (typeof body === 'object' && 'text' in body) return null;   // 流式：不尝试读（避免消费调用方的流）
  return body;
}

function hostOf(input) {
  try {
    const u = new URL(typeof input === 'string' ? input : (input && input.url) || String(input));
    return u.hostname.toLowerCase();
  } catch { return ''; }
}

/**
 * 包 globalThis.fetch，把命中 hosts 的调用逐次追加写到 path。
 * 返回 { stats(), uninstall() }。enabled=false 时整个是 no-op（便于 --capture 关着时零开销）。
 */
export function installCallCapture({ path, hosts, fetchImpl = globalThis.fetch, enabled = true, onError = () => {} } = {}) {
  if (!enabled || !path) return { stats: () => ({ captured: 0, passed: 0, errors: 0 }), uninstall() {} };
  const allow = hosts ? new Set((Array.isArray(hosts) ? hosts : [hosts]).map((h) => String(h).toLowerCase())) : null;
  const orig = fetchImpl;                 // 真正发请求的实现（可注入做单测）
  const previous = globalThis.fetch;      // 卸载时还原的东西 —— 注入时与 orig 不同
  let captured = 0, passed = 0, errors = 0, seq = 0;
  const wantAll = !allow;   // 不传 hosts ⇒ 记录一切（渠道无关，便于同一份配置对 official/网关都适用）

  const wrapped = async (input, init) => {
    const host = hostOf(input);
    const mine = wantAll || (allow && allow.has(host));
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!mine) { passed += 1; return orig(input, init); }

    const bodyObj = parseBody(init && init.body);
    const req = { seq: ++seq, t: new Date().toISOString(), method: (init && init.method) || 'GET', url, host, headers: safeHeaders(init), body: bodyObj };
    const t0 = Date.now();
    let res;
    try {
      res = await orig(input, init);
    } catch (e) {
      errors += 1;
      line({ ...req, ms: Date.now() - t0, error: String((e && e.message) || e) });
      throw e;
    }
    // 读一份副本，返回原响应给调用方（不消费它的流）
    const status = res.status;
    let respJson = null, respText = null;
    try {
      const clone = res.clone();
      respText = await clone.text();
      try { respJson = JSON.parse(respText); } catch { respText = respText.slice(0, 2000); }
    } catch (e) { onError(e); }
    captured += 1;
    line({ ...req, ms: Date.now() - t0, status, response: respJson != null ? respJson : respText });
    return res;
  };

  function line(obj) {
    try { appendFileSync(path, JSON.stringify(obj) + '\n'); }
    catch (e) { errors += 1; onError(e); }   // 写失败绝不拖垮对局
  }

  globalThis.fetch = wrapped;
  return {
    stats: () => ({ captured, passed, errors }),
    uninstall() { if (globalThis.fetch === wrapped) globalThis.fetch = previous; },
  };
}
