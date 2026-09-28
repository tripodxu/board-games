'use strict';
/* jev-client.js — TypeSafe Jev（系统一模型）调用封装
 *
 * 契约（docs.typesafe.ai/api.md）：
 *   POST {endpoint}   Authorization: Bearer <key>
 *   body: { state, model, questions }   questions: { key: {type, instructions, criteria} }
 *   resp: { model, answers: { key: {...} }, usage: { input_tokens, output_tokens } }
 *   429/529 → 指数退避重试；401 → key 无效
 *
 * 渠道：
 *   official   → https://api.typesafe.ai/v1/systemone     model: jev-latest
 *   openrouter → https://openrouter.ai/api/v1/systemone   model: typesafe/jev-1.13（体格式与官方一致）
 *   proxy      → 同源 api/jev（CF Pages Function / dev-proxy.py），体格式同官方，key 在服务端
 *   mock       → 离线演示（见 mock-ai.js）
 */
(function () {
  const CHANNELS = {
    official:   { endpoint: 'https://api.typesafe.ai/v1/systemone',    model: 'jev-latest',        keyName: 'official' },
    openrouter: { endpoint: 'https://openrouter.ai/api/v1/systemone',  model: 'typesafe/jev-1.13', keyName: 'openrouter' },
    proxy:      { endpoint: 'api/jev',                                 model: 'jev-latest',        keyName: null },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const REQUEST_TIMEOUT_MS = 30000;

  async function callRaw(channel, body, apiKey, signal) {
    const cfg = CHANNELS[channel];
    if (!cfg) throw new Error('未知渠道: ' + channel);
    const headers = { 'Content-Type': 'application/json' };
    if (channel === 'proxy') {
      /* BYOK：代理只做 CORS 转发，key 由用户自己的 localStorage 随头透传 */
      if (apiKey) headers['X-Api-Key'] = apiKey;
    } else if (cfg.keyName) {
      if (!apiKey) throw new Error('尚未填写该渠道的 API Key（右上「Jev 设置」）');
      headers['Authorization'] = 'Bearer ' + apiKey;
      if (channel === 'openrouter') headers['HTTP-Referer'] = location.origin || 'http://localhost';
    }
    const payload = { state: body.state, model: cfg.model, questions: body.questions };
    /* 超时 + 外部中止合并：30s 无响应视为超时（可重试） */
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS);
    const onOuterAbort = () => timeoutCtrl.abort();
    if (signal) {
      if (signal.aborted) timeoutCtrl.abort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      return await fetch(cfg.endpoint, {
        method: 'POST', headers, signal: timeoutCtrl.signal,
        body: JSON.stringify(payload),
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  /* 带重试的请求：429/529 与网络/超时错误退避重试；外部中止立即终止 */
  async function callWithRetry(channel, body, apiKey, signal, onRetry) {
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal && signal.aborted) throw new Error('aborted');
      let resp;
      try {
        resp = await callRaw(channel, body, apiKey, signal);
      } catch (e) {
        if (signal && signal.aborted) throw new Error('aborted');
        lastErr = new Error('网络错误：' + e.message + '（若为浏览器跨域受限，请改用「同源代理」渠道）');
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (resp.ok) return resp.json();
      if (resp.status === 429 || resp.status === 529) {
        onRetry && onRetry(resp.status, attempt);
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      let detail = '';
      try { detail = (await resp.text()).slice(0, 300); } catch (_) { /* ignore */ }
      if (resp.status === 401) throw new Error('API Key 无效或缺失（401）');
      throw new Error('API 错误 ' + resp.status + '：' + detail);
    }
    throw lastErr || new Error('重试次数用尽');
  }

  const JevClient = {
    /* 走一步棋：engine.serializeForJev 的产出交给 Jev，返回决策对象
     * opts: { channel, apiKey, topK, signal, onRetry }
     * 返回 { notation, move, meta }
     */
    async decide(engine, st, side, opts) {
      const channel = opts.channel || 'official';
      const ser = engine.serializeForJev(st, side);
      const legal = engine.getLegalMoves(st);
      const byNotation = new Map(legal.map((m) => [m.notation, m]));
      const t0 = Date.now();

      if (channel === 'mock') {
        return BG.mock.decide(engine, st, side, legal, ser);
      }

      const data = await callWithRetry(channel, ser, opts.apiKey, opts.signal, opts.onRetry);
      const latencyMs = Date.now() - t0;
      const answers = data.answers || {};
      const usage = data.usage || {};
      const costUsd = (usage.input_tokens || 0) * 42 / 1e9; // 输入 $42/十亿token ≈ $42/百万，输出免费

      const ans = answers.move || {};
      let probs = ans.probabilities || {};
      let conf = typeof ans.confidence === 'number' ? ans.confidence : null;

      /* 只保留合法着法的概率（响应理论上是选项子集） */
      const pairs = Object.entries(probs).filter(([k]) => byNotation.has(k));
      if (pairs.length === 0) {
        const fallback = legal[0];
        return {
          notation: fallback.notation, move: fallback,
          meta: { channel, model: data.model, latencyMs, usage, costUsd, confidence: 0, top: [],
                  candidates: 0, warning: '响应中无合法选项，已回退到首个合法着法', noul: answers.edge, score: answers.position },
        };
      }
      pairs.sort((a, b) => b[1] - a[1]);

      /* top-k 概率加权随机（随机度） */
      let notation;
      const k = Math.max(1, opts.topK | 0 || 1);
      if (k === 1) {
        notation = pairs[0][0];
      } else {
        const top = pairs.slice(0, k);
        notation = BG.util.weightedPick(top.map((p) => p[0]), top.map((p) => p[1]));
      }

      return {
        notation,
        move: byNotation.get(notation),
        meta: {
          channel, model: data.model, latencyMs, usage, costUsd, confidence: conf,
          top: pairs.slice(0, 8).map(([n, p]) => ({ notation: n, p })),
          candidates: pairs.length, // 合法候选总数
          restProb: pairs.slice(8).reduce((s, x) => s + x[1], 0), // 第 9 名以后的概率合计
          noul: answers.edge ? answers.edge.noul : undefined,
          score: answers.position ? answers.position.score : undefined,
        },
      };
    },
  };

  BG.jev = JevClient;
})();
