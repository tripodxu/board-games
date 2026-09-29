'use strict';
/* Node 自检：加载 board.js + 六个引擎，运行各引擎 selfTest()。用法：node test/run-tests.js */
const fs = require('fs');
const path = require('path');

/* mock AI 的模拟延迟对自检无意义：默认跳过（BG_SLOW=1 可覆盖为真实延迟） */
if (!process.env.BG_SLOW) process.env.BG_FAST = '1';

globalThis.window = globalThis;
globalThis.location = { search: '', origin: 'http://localhost' };

const ROOT = path.join(__dirname, '..');
[
  'js/board.js',
  'js/calibration.js',
  'js/games/gomoku.js',
  'js/games/chess.js',
  'js/games/xiangqi.js',
  'js/games/checkers.js',
  'js/games/chinese-checkers.js',
  'js/games/go.js',
].forEach((f) => {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  eval(code);
});

let failed = 0;
const results = [];
for (const [id, eng] of Object.entries(globalThis.BG.games)) {
  try {
    eng.selfTest();
    results.push('✓ ' + eng.name + ' (' + id + ')');
  } catch (e) {
    failed++;
    results.push('✗ ' + eng.name + ' (' + id + '): ' + e.message);
  }
}

/* 单元：校准实验室的数学（解析夹具，见 js/calibration.js selfTest 注释） */
try {
  globalThis.BG.calibration.selfTest();
  results.push('✓ 校准实验室（brier/skill/ece/过度自信）');
} catch (e) {
  failed++;
  results.push('✗ 校准实验室: ' + e.message);
}

/* 集成：mock AI 机机对弈完整一盘；同 seed 两次结果必须完全一致 */
async function playOut(gid) {
  BG.setSeed(42); // 每个棋种从同一 seed 起跑，保证可复现
  const e = globalThis.BG.games[gid];
  let st = e.newGame();
  let plies = 0;
  const notations = [];
  while (!e.getStatus(st).over && plies < 600) {
    const d = await globalThis.BG.jev.decide(e, st, st.turn, { channel: 'mock', topK: 3 });
    if (!d.move || !e.getLegalMoves(st).some((m) => m.notation === d.move.notation)) {
      throw new Error(gid + ' 第 ' + plies + ' 步返回非法着法 ' + d.notation);
    }
    st = e.applyMove(st, d.move);
    notations.push(d.move.notation);
    plies++;
  }
  const g = e.getStatus(st);
  if (!g.over) throw new Error(gid + ' ' + plies + ' 步未终局（疑似死循环）');

  /* 记法重放护栏：app.js 的悔棋已改为「history 只存记法 + 从 newGame 重放」，
   * 因此「整盘只用 notation 走一遍」必须得到与逐步 applyMove 完全一致的终局状态。
   * 这是该改动唯一但关键的正确性前提（依据：docs/engine-interface.md §2 记法往返硬契约）。
   * 任何引擎的 notation 不可逆，这里会立刻红——那说明引擎违约，应改引擎而非回退方案。 */
  let replay = e.newGame();
  for (const n of notations) {
    const m = e.moveFromNotation(replay, n);
    if (!m) throw new Error(gid + ' 记法重放失败于 ' + n + '（moveFromNotation 返回 null）');
    replay = e.applyMove(replay, m);
  }
  BG.util.assert(
    JSON.stringify(replay) === JSON.stringify(st),
    gid + ' 记法重放后的终局状态与逐步下棋不一致（悔棋还原会出错）');
  BG.util.assert(
    JSON.stringify(e.getStatus(replay)) === JSON.stringify(g),
    gid + ' 记法重放后的终局判定与原对局不一致');

  return e.name + '：' + plies + ' 步终局，胜者=' + (g.winner || '和') + '，' + g.reason + '|' + notations.join(',');
}

async function integration() {
  eval(fs.readFileSync(path.join(ROOT, 'js/mock-ai.js'), 'utf8'));
  eval(fs.readFileSync(path.join(ROOT, 'js/jev-client.js'), 'utf8'));
  for (const gid of ['gomoku', 'cc', 'go']) {
    const summary = await playOut(gid);
    results.push('✓ 集成 ' + summary);
    const again = await playOut(gid);
    BG.util.assert(summary === again, gid + ' 同 seed 复现失败：' + summary + ' ≠ ' + again);
    results.push('✓ 复现 ' + gid + '（seed=42 两次一致）');
  }
}

/* 单元：jev-client 的重试 / 401 / 非法着法回退 / topK 解析回归 */
async function jevClientTests() {
  eval(fs.readFileSync(path.join(ROOT, 'js/jev-client.js'), 'utf8')); // 挂 BG.jev（幂等）
  const e = globalThis.BG.games.gomoku;
  const st = e.newGame();
  const legal = e.getLegalMoves(st);
  const realFetch = globalThis.fetch;
  const mk = (status, obj) => new Response(JSON.stringify(obj), { status });
  const withFetch = async (impl, fn) => {
    globalThis.fetch = impl;
    try { return await fn(); } finally { globalThis.fetch = realFetch; }
  };
  /* 响应里只给非法选项 ZZZ → 命中回退分支 */
  const okBody = { model: 'jev-latest', usage: { input_tokens: 100, output_tokens: 0 },
    answers: { move: { probabilities: { ZZZ: 0.9 } } } };

  /* ① 429 → 200：退避重试一次后成功，且落入合法着法回退（真实 sleep 约 1s，可接受） */
  let calls = 0;
  const d1 = await withFetch(
    async () => (++calls === 1 ? mk(429, { error: 'slow down' }) : mk(200, okBody)),
    () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 3 })
  );
  BG.util.assert(calls === 2, '429 后应重试一次，实际调用 ' + calls + ' 次');
  BG.util.assert(d1.notation === legal[0].notation, '无合法选项应回退到 legal[0]');
  /* 回退分支应原样返回 legal[0] 这个着法；decide() 内部自取 legal，跨边界无法比引用，用深比较 */
  BG.util.assert(JSON.stringify(d1.move) === JSON.stringify(legal[0]), '回退返回的 move 应为 legal[0] 对象本身');
  BG.util.assert(d1.meta.warning === '响应中无合法选项，已回退到首个合法着法', 'warning 文案应为更新后的版本，实际：' + d1.meta.warning);

  /* ② 401：立即抛错，绝不重试 */
  calls = 0;
  let err = null;
  try {
    await withFetch(
      async () => { calls++; return mk(401, { error: 'bad key' }); },
      () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 1 })
    );
  } catch (e2) { err = e2; }
  BG.util.assert(err && /401/.test(err.message), '401 应抛出含 401 的错误，实际：' + (err && err.message));
  BG.util.assert(calls === 1, '401 不应重试，实际调用 ' + calls + ' 次');

  /* ③ topK 端到端回归：topK=2 时第 3、4 名永不被选；topK=1 时恒为最高概率项。
     注意：不能用"临摹表达式的断言"——那测的是测试文件自己，测不到生产代码。 */
  const fourLegal = { H8: 0.5, H9: 0.45, J8: 0.049, J9: 0.001 };
  const pickBody = { model: 'jev-latest', usage: { input_tokens: 100, output_tokens: 0 },
    answers: { move: { probabilities: fourLegal } } };
  const seen2 = {};
  for (let i = 0; i < 200; i++) {
    const d = await withFetch(async () => mk(200, pickBody),
      () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 2 }));
    seen2[d.notation] = (seen2[d.notation] || 0) + 1;
  }
  BG.util.assert(!seen2.J8 && !seen2.J9, 'topK=2 时第 3、4 名不应被选，实际：' + JSON.stringify(seen2));
  BG.util.assert(seen2.H8 && seen2.H9, 'topK=2 应只在前 2 名中抽样，实际：' + JSON.stringify(seen2));
  const argmax = await withFetch(async () => mk(200, pickBody),
    () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(argmax.notation === 'H8', 'topK=1 应恒选最高概率项 H8，实际：' + argmax.notation);

  /* ④ 自定义端点回归：opts.endpoint 覆盖渠道预设；未填 key 时自定义端点放行（自建网关可匿名），
     预设端点不受影响（无 key 仍拒绝、有 key 照发预设地址） */
  let hitUrl = null;
  const spyFetch = async (url) => { hitUrl = String(url); return mk(200, okBody); };
  const d4 = await withFetch(spyFetch, () => BG.jev.decide(e, st, st.turn, {
    channel: 'official', endpoint: 'http://127.0.0.1:9000/custom/systemone', topK: 1,
  }));
  BG.util.assert(hitUrl === 'http://127.0.0.1:9000/custom/systemone', '自定义端点应覆盖预设，实际：' + hitUrl);
  BG.util.assert(d4.notation === legal[0].notation, '自定义端点下非法响应同样应回退 legal[0]');
  err = null;
  try {
    await withFetch(spyFetch, () => BG.jev.decide(e, st, st.turn, { channel: 'official', topK: 1 }));
  } catch (e3) { err = e3; }
  BG.util.assert(err && /API Key/.test(err.message), '预设官方端点无 key 仍应拒绝，实际：' + (err && err.message));
  await withFetch(spyFetch, () => BG.jev.decide(e, st, st.turn, { channel: 'official', apiKey: 'k', topK: 1 }));
  BG.util.assert(hitUrl === 'https://api.typesafe.ai/v1/systemone', '预设端点不受 opts.endpoint 缺省影响，实际：' + hitUrl);
  BG.util.assert(typeof BG.jev.presetEndpoint('openrouter') === 'string' && /openrouter\.ai/.test(BG.jev.presetEndpoint('openrouter')),
    'presetEndpoint 应返回渠道预设地址');

  /* ⑤ probe 连通性探测：ok / auth / http / cors / network / shape 六种判定。
     no-cors GET 段与 cors POST 段都打到同一 mock fetch，按 init.mode 区分。 */
  const probeBody = { model: 'jev-latest', answers: { probe: { noul: 0.5 } } };
  const doProbe = (impl) => withFetch(impl,
    () => BG.jev.probe({ channel: 'official', apiKey: 'k', endpoint: 'https://x.example/v1/systemone' }));
  const reachOK = async () => new Response('ok');
  let probeSent = null;
  let pr = await doProbe(async (url, init) => {
    if (init && init.mode === 'no-cors') return reachOK();
    probeSent = JSON.parse(init.body);
    return mk(200, probeBody);
  });
  BG.util.assert(pr.ok === true && pr.kind === 'ok' && typeof pr.latencyMs === 'number', 'probe 200+answers 应判 ok，实际：' + JSON.stringify(pr));
  BG.util.assert(probeSent.model === 'jev-latest' && probeSent.questions.probe.type === 'noul' && probeSent.state,
    'probe 请求体必须含 state/model/questions（真实端点 422 教训），实际：' + JSON.stringify(probeSent));
  pr = await doProbe(async (url, init) => (init && init.mode === 'no-cors' ? reachOK() : mk(401, { error: 'bad key' })));
  BG.util.assert(!pr.ok && pr.kind === 'auth', 'probe 401 应判 auth，实际：' + pr.kind);
  pr = await doProbe(async (url, init) => (init && init.mode === 'no-cors' ? reachOK() : mk(500, 'boom')));
  BG.util.assert(!pr.ok && pr.kind === 'http' && pr.status === 500, 'probe 500 应判 http，实际：' + pr.kind);
  pr = await doProbe(async (url, init) => {
    if (init && init.mode === 'no-cors') return reachOK();
    throw new TypeError('Failed to fetch');
  });
  BG.util.assert(!pr.ok && pr.kind === 'cors', 'probe「可达但 POST 被 TypeError」应判 cors，实际：' + pr.kind);
  pr = await doProbe(async () => { throw new TypeError('getaddrinfo ENOTFOUND'); });
  BG.util.assert(!pr.ok && pr.kind === 'network', 'probe「no-cors 也失败」应判 network，实际：' + pr.kind);
  pr = await doProbe(async (url, init) => (init && init.mode === 'no-cors' ? reachOK() : mk(200, { openai: true })));
  BG.util.assert(!pr.ok && pr.kind === 'shape', 'probe 200 但缺 answers 应判 shape，实际：' + pr.kind);
  pr = await BG.jev.probe({ channel: 'mock' });
  BG.util.assert(pr.ok === true && pr.kind === 'mock', 'probe mock 应直接返回 mock 判定');
}

/* 单元：Pages Function 的 401 / 422 / 限流 / 正常转发 */
async function pagesFunctionTests() {
  /* package.json 无 type:module，.js 按 CJS 解析，export 语法无法 import()；
     剥掉 export 后用 new Function 加载。hits Map 是模块状态：只加载一次，跨用例共享计数。 */
  const src = fs.readFileSync(path.join(ROOT, 'functions/api/jev.js'), 'utf8')
    .replace(/export\s+async\s+function\s+onRequestPost/, 'async function onRequestPost');
  const onRequestPost = new Function(src + '\nreturn onRequestPost;')();

  const mkReq = (body, headers) => new Request('http://local/api/jev', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body,
  });
  const validBody = JSON.stringify({ state: { game: 'test' }, questions: { move: { type: 'choice' } } });

  /* ① 无 key → 401（IP 9.9.9.1，独立计数） */
  let r = await onRequestPost({ request: mkReq(validBody, { 'CF-Connecting-IP': '9.9.9.1' }), env: {} });
  BG.util.assert(r.status === 401, '无 key 应 401，实际 ' + r.status);

  /* ② 坏 JSON → 422（IP 9.9.9.2） */
  r = await onRequestPost({ request: mkReq('not-json', { 'CF-Connecting-IP': '9.9.9.2', 'X-Api-Key': 'k' }), env: {} });
  BG.util.assert(r.status === 422, '坏 JSON 应 422，实际 ' + r.status);

  /* ③+④ 限流与转发：limit=2，同一 IP 第 3 次 429（IP 9.9.9.3 计数全新） */
  const realFetch = globalThis.fetch;
  let captured = null;
  let fetchCalls = 0;
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const env = { RATE_LIMIT_PER_MIN: '2' };
    const req = () => ({ request: mkReq(validBody, { 'CF-Connecting-IP': '9.9.9.3', 'X-Api-Key': 'k' }), env });
    r = await onRequestPost(req()); BG.util.assert(r.status === 200, '第 1 次应 200，实际 ' + r.status);
    r = await onRequestPost(req()); BG.util.assert(r.status === 200, '第 2 次应 200，实际 ' + r.status);
    r = await onRequestPost(req()); BG.util.assert(r.status === 429, '第 3 次应 429，实际 ' + r.status);
    BG.util.assert(fetchCalls === 2, '429 不应触达上游，实际 fetch ' + fetchCalls + ' 次');
    BG.util.assert(captured && captured.url === 'https://api.typesafe.ai/v1/systemone', '上游 URL 不对：' + (captured && captured.url));
    BG.util.assert(captured.init.headers.Authorization === 'Bearer k', 'Authorization 头不对');
    const sent = JSON.parse(captured.init.body);
    BG.util.assert(sent.model === 'jev-latest' && sent.state && sent.questions, '转发体缺字段');
  } finally {
    globalThis.fetch = realFetch;
  }
}

integration()
  .catch((e) => { failed++; results.push('✗ 集成测试: ' + e.message); })
  .then(() => jevClientTests())
  .catch((e) => { failed++; results.push('✗ jev-client 单元测试: ' + e.message); })
  .then(() => pagesFunctionTests())
  .catch((e) => { failed++; results.push('✗ Pages Function 单元测试: ' + e.message); })
  .finally(() => {
    console.log(results.join('\n'));
    if (failed) {
      console.log('\n' + failed + ' 项失败');
      process.exit(1);
    }
    console.log('\n全部测试通过');
  });
