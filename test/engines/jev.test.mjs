/* test/engines/jev.test.mjs — Jev 客户端回归（重试 / 401 / 回退 / topK / 自定义端点 / probe）
 *
 * 覆盖旧 test/run-tests.cjs 的 jevClientTests()：全部用 fetch 桩，不打真实网络。
 */
import { suite, ok, eq } from './harness.mjs';

import { games, getGame } from '../../src/core/registry.ts';
import { presetEndpoint, probe, decide } from '../../src/core/jev/index.ts';

const S = suite();
const gomoku = getGame('gomoku');

const mk = (status, obj) => new Response(JSON.stringify(obj), { status });
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

const OK_BODY = {
  model: 'jev-latest', usage: { input_tokens: 100, output_tokens: 0 },
  answers: { move: { probabilities: { ZZZ: 0.9 } } },
};

S.t('jev：429 退避重试一次后成功，非法选项回退 legal[0]', async () => {
  const e = gomoku, st = e.newGame();
  const legal = e.getLegalMoves(st);
  let calls = 0;
  const d1 = await withFetch(
    async () => (++calls === 1 ? mk(429, { error: 'slow down' }) : mk(200, OK_BODY)),
    () => decide(e, st, st.turn, { channel: 'proxy', topK: 3 }));
  eq(calls, 2, '429 后应重试一次，实际调用 ' + calls + ' 次');
  eq(d1.notation, legal[0].notation, '无合法选项应回退到 legal[0]');
  eq(JSON.stringify(d1.move), JSON.stringify(legal[0]), '回退返回的 move 应为 legal[0] 对象本身');
  eq(d1.meta.warning, '响应中无合法选项，已回退到首个合法着法', 'warning 文案不对：' + d1.meta.warning);
  eq(d1.meta.candidates, 0, '回退分支 candidates 应为 0');
  ok(Array.isArray(d1.meta.top) && d1.meta.top.length === 0, '回退分支 top 应为空数组');
});

S.t('jev：401 立即抛错、绝不重试', async () => {
  const e = gomoku, st = e.newGame();
  let calls = 0, err = null;
  try {
    await withFetch(async () => { calls++; return mk(401, { error: 'bad key' }); },
      () => decide(e, st, st.turn, { channel: 'proxy', topK: 1 }));
  } catch (e2) { err = e2; }
  ok(err && /401/.test(err.message), '401 应抛出含 401 的错误，实际：' + (err && err.message));
  eq(calls, 1, '401 不应重试，实际调用 ' + calls + ' 次');
});

S.t('jev：topK 端到端（topK=2 只在前 2 名抽样、topK=1 恒选最高）', async () => {
  const e = gomoku, st = e.newGame();
  const pickBody = { model: 'jev-latest', usage: { input_tokens: 100, output_tokens: 0 },
    answers: { move: { probabilities: { H8: 0.5, H9: 0.45, J8: 0.049, J9: 0.001 } } } };
  const seen = {};
  for (let i = 0; i < 200; i++) {
    const d = await withFetch(async () => mk(200, pickBody),
      () => decide(e, st, st.turn, { channel: 'proxy', topK: 2 }));
    seen[d.notation] = (seen[d.notation] || 0) + 1;
  }
  ok(!seen.J8 && !seen.J9, 'topK=2 时第 3、4 名不应被选，实际：' + JSON.stringify(seen));
  ok(seen.H8 && seen.H9, 'topK=2 应只在前 2 名中抽样，实际：' + JSON.stringify(seen));
  const argmax = await withFetch(async () => mk(200, pickBody),
    () => decide(e, st, st.turn, { channel: 'proxy', topK: 1 }));
  eq(argmax.notation, 'H8', 'topK=1 应恒选最高概率项 H8，实际：' + argmax.notation);
});

S.t('jev：自定义端点覆盖预设；预设无 key 拒绝、有 key 照发', async () => {
  const e = gomoku, st = e.newGame();
  const legal = e.getLegalMoves(st);
  let hitUrl = null;
  const spy = async (url) => { hitUrl = String(url); return mk(200, OK_BODY); };
  const d4 = await withFetch(spy, () => decide(e, st, st.turn, {
    channel: 'official', endpoint: 'http://127.0.0.1:9000/custom/systemone', topK: 1,
  }));
  eq(hitUrl, 'http://127.0.0.1:9000/custom/systemone', '自定义端点应覆盖预设，实际：' + hitUrl);
  eq(d4.notation, legal[0].notation, '自定义端点下非法响应同样应回退 legal[0]');
  let err = null;
  try {
    await withFetch(spy, () => decide(e, st, st.turn, { channel: 'official', topK: 1 }));
  } catch (e3) { err = e3; }
  ok(err && /API Key/.test(err.message), '预设官方端点无 key 仍应拒绝，实际：' + (err && err.message));
  await withFetch(spy, () => decide(e, st, st.turn, { channel: 'official', apiKey: 'k', topK: 1 }));
  eq(hitUrl, 'https://api.typesafe.ai/v1/systemone', '预设端点不受 opts.endpoint 缺省影响，实际：' + hitUrl);
  ok(typeof presetEndpoint('openrouter') === 'string' && /openrouter\.ai/.test(presetEndpoint('openrouter')),
    'presetEndpoint 应返回渠道预设地址');
});

S.t('jev：未知渠道抛错且不打网络', async () => {
  const e = gomoku, st = e.newGame();
  let calls = 0, err = null;
  try {
    await withFetch(async () => { calls++; return mk(200, OK_BODY); },
      () => decide(e, st, st.turn, { channel: 'nope', topK: 1 }));
  } catch (e2) { err = e2; }
  ok(err && /未知渠道/.test(err.message), '未知渠道应抛「未知渠道」，实际：' + (err && err.message));
  eq(calls, 0, '未知渠道不应发出请求');
});

S.t('jev：probe 六种判定（ok / auth / http / cors / network / shape / config / mock）', async () => {
  const probeBody = { model: 'jev-latest', answers: { probe: { noul: 0.5 } } };
  const doProbe = (impl) => withFetch(impl, () => probe({
    channel: 'official', apiKey: 'k', endpoint: 'https://x.example/v1/systemone',
  }));
  const reachOK = async () => new Response('ok');
  let sent = null;
  let pr = await doProbe(async (url, init) => {
    if (init && init.mode === 'no-cors') return reachOK();
    sent = JSON.parse(init.body);
    return mk(200, probeBody);
  });
  ok(pr.ok === true && pr.kind === 'ok' && typeof pr.latencyMs === 'number', 'probe 200+answers 应判 ok，实际：' + JSON.stringify(pr));
  ok(sent.model === 'jev-latest' && sent.questions.probe.type === 'noul' && sent.state,
    'probe 请求体必须含 state/model/questions（真实端点 422 教训），实际：' + JSON.stringify(sent));
  pr = await doProbe(async (url, init) => (init && init.mode === 'no-cors' ? reachOK() : mk(401, { error: 'bad key' })));
  ok(!pr.ok && pr.kind === 'auth', 'probe 401 应判 auth，实际：' + pr.kind);
  pr = await doProbe(async (url, init) => (init && init.mode === 'no-cors' ? reachOK() : mk(500, 'boom')));
  ok(!pr.ok && pr.kind === 'http' && pr.status === 500, 'probe 500 应判 http，实际：' + JSON.stringify(pr));
  pr = await doProbe(async (url, init) => {
    if (init && init.mode === 'no-cors') return reachOK();
    throw new TypeError('Failed to fetch');
  });
  ok(!pr.ok && pr.kind === 'cors', 'probe「可达但 POST 被 TypeError」应判 cors，实际：' + pr.kind);
  pr = await doProbe(async () => { throw new TypeError('getaddrinfo ENOTFOUND'); });
  ok(!pr.ok && pr.kind === 'network', 'probe「no-cors 也失败」应判 network，实际：' + pr.kind);
  pr = await doProbe(async (url, init) => (init && init.mode === 'no-cors' ? reachOK() : mk(200, { openai: true })));
  ok(!pr.ok && pr.kind === 'shape', 'probe 200 但无 answers 应判 shape，实际：' + pr.kind);
  pr = await probe({ channel: 'mock' });
  ok(pr.ok === true && pr.kind === 'mock', 'mock 渠道 probe 应直接 ok，实际：' + JSON.stringify(pr));
  pr = await probe({ channel: 'nope' });
  ok(!pr.ok && pr.kind === 'config', '未知渠道 probe 应判 config，实际：' + pr.kind);
});

export default S;
