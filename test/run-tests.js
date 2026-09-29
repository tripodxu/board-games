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

/* 契约：serializeForJev 的 state 必须带非空 rules 摘要（Jev 对齐本项目规则细节的唯一来源） */
try {
  const missing = Object.entries(globalThis.BG.games)
    .filter(([id, eng]) => {
      const ser = eng.serializeForJev(eng.newGame(), eng.sides[0].id);
      return !ser.state || typeof ser.state.rules !== 'string' || ser.state.rules.length < 40;
    })
    .map(([id]) => id);
  BG.util.assert(missing.length === 0, '以下引擎的 state.rules 缺失或过短: ' + missing.join(','));
  results.push('✓ 六引擎 state.rules 摘要契约');
} catch (e) {
  failed++;
  results.push('✗ rules 摘要契约: ' + e.message);
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

  /* ⑥ 战术事实：黑四连且轮黑走 → G8/L8 双成五点；换白方视角 → 同两点为必挡点。 */
  let stx = e.newGame();
  for (const n of ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5']) stx = e.applyMove(stx, e.moveFromNotation(stx, n));
  const tacMe = BG.jev.computeTactics(e, stx, e.getLegalMoves(stx));
  BG.util.assert(tacMe.winning_points_you.indexOf('G8') >= 0 && tacMe.winning_points_you.indexOf('L8') >= 0,
    '黑四连应识别出 G8/L8 致胜点，实际：' + JSON.stringify(tacMe));
  BG.util.assert(tacMe.winning_points_opponent.length === 0, '白只有三子，不应有必挡点');
  const stxW = BG.util.clone(stx);
  stxW.turn = 'white';
  const tacOpp = BG.jev.computeTactics(e, stxW, e.getLegalMoves(stxW));
  BG.util.assert(tacOpp.winning_points_you.length === 0 && tacOpp.winning_points_opponent.indexOf('G8') >= 0,
    '白方视角下黑四连点应为必挡点，实际：' + JSON.stringify(tacOpp));

  /* ⑥b 提示词板斧：board_ascii 裁剪/图例/末手小写 + 指令含刚性扫描清单与防幻觉核对。 */
  const ser9 = e.serializeForJev(stx, stx.turn);
  const asc = ser9.state.board_ascii;
  BG.util.assert(typeof asc === 'string' && asc.split('\n').length >= 5, 'board_ascii 应为多行棋盘');
  BG.util.assert(asc.indexOf('X') >= 0 && asc.indexOf('O') >= 0, '棋盘应含黑白子字符 X/O');
  const row8 = asc.split('\n').find((l) => l.startsWith(' 8'));
  BG.util.assert(row8 && row8.indexOf('X') >= 0 && row8.indexOf('x') < 0, '非末手黑子应为大写 X，实际该行：' + row8);
  const row5 = asc.split('\n').find((l) => l.startsWith(' 5'));
  BG.util.assert(row5 && row5.indexOf('o') >= 0, '末手 G5（白）应以小写 o 标记，实际该行：' + row5);
  BG.util.assert(asc.split('\n').some((l) => l.startsWith(' 1')), '白子 A1 在边缘时应裁剪到行 1（外扩 2 格收敛）');
  const ins = ser9.questions.move.instructions;
  BG.util.assert(/scan in order/.test(ins) && /cell by cell/.test(ins) && /board_ascii/.test(ins),
    'move 指令应含刚性扫描清单与防幻觉核对要求');
  const ascEmpty = e.serializeForJev(e.newGame(), 'black').state.board_ascii;
  BG.util.assert(ascEmpty.split('\n').length === 6 && /H/.test(ascEmpty), '空盘应裁剪为天元附近 5×5');

  /* ⑥c 战术标签：黑活三 F8G8H8 vs 白活三 G7H7I7，黑行棋。
     I8 = 黑成活四（you:open4）；F7/J7 = 白活三的成活四点（deny:open4）；静点无标签。 */
  let stl = e.newGame();
  for (const n of ['F8', 'G7', 'G8', 'H7', 'H8', 'I7']) stl = e.applyMove(stl, e.moveFromNotation(stl, n));
  const crit = e.serializeForJev(stl, stl.turn).questions.move.criteria;
  BG.util.assert(/you:open4/.test(crit['I8']), '黑 I8 应标 you:open4（F8-I8 四、E8/J8 两成五点），实际：' + crit['I8']);
  BG.util.assert(/deny:open4/.test(crit['F7']), 'F7 应标 deny:open4（白占即活四），实际：' + crit['F7']);
  BG.util.assert(/deny:open4/.test(crit['J7']), 'J7 应标 deny:open4，实际：' + crit['J7']);
  const quiet = Object.entries(crit).filter(([k, v]) => v === null);
  BG.util.assert(quiet.length >= 1, '应存在无标签的静点候选');

  /* ⑥d 活四接管：黑有活四点（E8/I8）、双方无一步成五 → 概率偏向 G6 仍必走活四点。 */
  let sentL = null;
  const dL = await withFetch(async (url, init) => {
    sentL = JSON.parse(init.body);
    return mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
      answers: { move: { probabilities: { G6: 0.9 } } } });
  }, () => BG.jev.decide(e, stl, stl.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert((dL.notation === 'E8' || dL.notation === 'I8') && dL.meta.tactics === 'open4',
    '活四点应被第三级接管，实际：' + dL.notation + '/' + dL.meta.tactics);

  /* ⑦ 战术保险接管：概率偏向 G7 仍必须走致胜点；state/指令应含 tactics 语义。 */
  const guardBody = { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { G7: 0.9, G8: 0.05 } } } };
  let sent7 = null;
  const d7 = await withFetch(async (url, init) => { sent7 = JSON.parse(init.body); return mk(200, guardBody); },
    () => BG.jev.decide(e, stx, stx.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(d7.notation === 'G8' && d7.meta.tactics === 'win',
    '致胜点应被保险接管，实际：' + d7.notation + '/' + d7.meta.tactics);
  BG.util.assert(sent7.state.tactics && sent7.state.tactics.winning_points_you.length === 2,
    'state 应注入 tactics，实际：' + JSON.stringify(sent7.state.tactics));
  BG.util.assert(/winning_points_you/.test(sent7.questions.move.instructions), '指令应声明 tactics 语义');
  BG.util.assert(!/experience/.test(sent7.questions.move.instructions), '无经验时指令不应提 experience');

  /* ⑧ 经验注入：opts.experience 写进 state 并在指令中声明。 */
  const st0 = e.newGame();
  let sent8 = null;
  await withFetch(async (url, init) => { sent8 = JSON.parse(init.body); return mk(200, okBody); },
    () => BG.jev.decide(e, st0, st0.turn, { channel: 'proxy', topK: 1,
      experience: { opening_plies: 2, games: 3, first_player_win_rate: 0.67 } }));
  BG.util.assert(sent8.state.experience && sent8.state.experience.games === 3,
    'state 应注入 experience，实际：' + JSON.stringify(sent8.state.experience));
  BG.util.assert(/experience/.test(sent8.questions.move.instructions), '有经验时指令应声明其语义');
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
