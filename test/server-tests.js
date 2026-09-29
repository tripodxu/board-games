'use strict';
/**
 * server-tests.js — server.js（零依赖 Node 后端）的 HTTP 契约自检。
 * 用法：
 *   node test/server-tests.js
 *   node -e "require('./test/server-tests.js').serverTests().then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"
 * 也可被 test/run-tests.js require 后调用 serverTests()。
 *
 * 风格：不用 node:test 模块，自写 assert，每例打印 ✓/✗，全部过完打印一行小结；
 * 失败时 serverTests() reject，便于调用方以非零码退出。
 * 隔离：每个用例在 os.tmpdir() 下建临时目录当 root，用完即删；
 *       限流按 IP 计数，各用例用不同的 X-Forwarded-For 假 IP 互不干扰。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const tests = [];
const failures = [];

/** 注册一个用例（加载时执行，serverTests() 里顺序跑）。 */
function test(name, fn) {
  tests.push({ name, fn });
}

/* ---------- 断言辅助 ---------- */

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function eq(actual, expected, msg) {
  if (!deepEqual(actual, expected)) {
    throw new Error((msg ? msg + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/* ---------- HTTP 辅助 ---------- */

function req(port, method, urlPath, body, headers) {
  const h = Object.assign({}, headers || {});
  let payload = body;
  if (body !== undefined && typeof body !== 'string') {
    payload = JSON.stringify(body);
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
  }
  return fetch('http://127.0.0.1:' + port + urlPath, {
    method,
    headers: h,
    body: payload,
  }).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: r.status, text, json, headers: r.headers };
  });
}

/** 记录 url/init 的假 fetch，返回由 respond(n) 提供的 Response。 */
function stubFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url: String(url), init: init || {} };
    calls.push(call);
    return respond(calls.length, call);
  };
  fn.calls = calls;
  return fn;
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jev-srv-'));
}

function once(server, ev) {
  return new Promise((resolve, reject) => {
    server.once(ev, resolve);
    if (ev === 'listening') server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    server.close(() => finish());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(finish, 3000); // 兜底：绝不因关不干净而挂住整个自检
  });
}

/** 起一台临时服务器（root 为临时目录），跑完关服并删目录。 */
async function withServer(fn, opts) {
  const root = tmpRoot();
  const server = createServer(Object.assign({ root }, opts || {})).listen(0);
  try {
    await once(server, 'listening');
    await fn(server.address().port, root);
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* ---------- 用例 ---------- */

test('/api/health：服务信息、棋谱与实验计数', async () => {
  await withServer(async (port, root) => {
    let r = await req(port, 'GET', '/api/health');
    eq(r.status, 200, 'health 状态码');
    eq(r.json.ok, true, 'ok');
    eq(r.json.service, 'jev-qiguan-server', 'service');
    eq(r.json.version, '1.0.0', 'version');
    eq(r.json.storage, { games: 'games/', experiments: 'data/experiments.json' }, 'storage 说明');
    eq(r.json.games, 0, '空 games/ 计数为 0');
    eq(r.json.experiments, 0, '无 experiments.json 时为 0');
    assert(typeof r.json.uptime === 'number' && r.json.uptime >= 0, 'uptime 应为非负秒数');
    assert(r.headers.get('cache-control') === 'no-store', 'API 响应应 no-store');

    const day = path.join(root, 'games', '2026-09-29');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'a.json'), '{}');
    fs.writeFileSync(path.join(day, 'b.json'), '{}');
    fs.writeFileSync(path.join(day, 'note.txt'), 'x');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'experiments.json'), JSON.stringify([{ tag: 't1' }, { tag: 't2' }]));
    r = await req(port, 'GET', '/api/health');
    eq(r.json.games, 2, '只数 .json，note.txt 不计');
    eq(r.json.experiments, 2, 'experiments.json 条数');
  });
});

test('/api/jev：无 key → 401', async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const root = tmpRoot();
  const stub = stubFetch(() => { throw new Error('无 key 不应触达上游'); });
  const server = createServer({ root, fetchImpl: stub }).listen(0);
  try {
    await once(server, 'listening');
    const port = server.address().port;
    const r = await req(port, 'POST', '/api/jev', { state: { a: 1 }, questions: { move: {} } },
      { 'X-Forwarded-For': '10.1.0.1' });
    eq(r.status, 401, '无 key 状态码');
    assert(r.json.error.indexOf('未提供 API Key') === 0, '401 文案：' + r.text);
    eq(stub.calls.length, 0, '不应触达上游');
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test('/api/jev：有 X-Api-Key → 200 透传且转发 URL/头/体正确', async () => {
  const stub = stubFetch(() => new Response(
    JSON.stringify({ answers: { move: { choice: 'H8' } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await withServer(async (port) => {
    const payload = {
      state: { game: 'gomoku', rules: 'x'.repeat(50) },
      model: 'jev-latest',
      questions: {
        move: { type: 'choice', instructions: 'pick', criteria: { H8: 1 } },
        edge: { type: 'noul', instructions: 'edge' },
        position: { type: 'score', instructions: 'score' },
      },
    };
    const r = await req(port, 'POST', '/api/jev', payload,
      { 'X-Api-Key': 'test-key-123', 'X-Forwarded-For': '10.1.0.2' });
    eq(r.status, 200, '透传状态码');
    eq(r.json.answers.move.choice, 'H8', '上游响应体应原样返回');
    eq(stub.calls.length, 1, '应调用上游一次');
    const call = stub.calls[0];
    eq(call.url, 'https://api.typesafe.ai/v1/systemone', '上游 URL');
    eq(call.init.method, 'POST', '上游方法');
    eq(call.init.headers.Authorization, 'Bearer test-key-123', 'Authorization 头');
    eq(call.init.headers['Content-Type'], 'application/json', 'Content-Type 头');
    const sent = JSON.parse(call.init.body);
    assert(sent.state && sent.questions && sent.model, '转发体应含 state/model/questions');
    eq(sent.state, payload.state, 'state 原样转发');
    eq(sent.questions, payload.questions, '三问一次发出（move/edge/position）');
    eq(sent.model, 'jev-latest', 'model 透传');

    /* 缺 model 时回落 jev-latest */
    const r2 = await req(port, 'POST', '/api/jev', { state: { x: 1 }, questions: {} },
      { 'X-Api-Key': 'k2', 'X-Forwarded-For': '10.1.0.3' });
    eq(r2.status, 200, '第二次应放行');
    eq(JSON.parse(stub.calls[1].init.body).model, 'jev-latest', '缺省 model 为 jev-latest');
  }, { fetchImpl: stub });
});

test('/api/jev：上游网络错误 → 502', async () => {
  const stub = stubFetch(() => { throw new Error('connect ECONNREFUSED 1.2.3.4'); });
  await withServer(async (port) => {
    const r = await req(port, 'POST', '/api/jev', { state: {}, questions: {} },
      { 'X-Api-Key': 'k', 'X-Forwarded-For': '10.2.0.1' });
    eq(r.status, 502, '网络错误应 502');
    assert(r.json.error.indexOf('上游请求失败：') === 0, '502 文案：' + r.text);
    assert(r.json.error.indexOf('ECONNREFUSED') >= 0, '应带上游错误原因');
  }, { fetchImpl: stub });
});

test('/api/jev：上游 401 原样透传', async () => {
  const stub = stubFetch(() => new Response(
    JSON.stringify({ error: 'invalid api key' }), { status: 401 }));
  await withServer(async (port) => {
    const r = await req(port, 'POST', '/api/jev', { state: {}, questions: {} },
      { 'X-Api-Key': 'bad-key', 'X-Forwarded-For': '10.2.0.2' });
    eq(r.status, 401, '上游状态码应原样透传');
    eq(r.json.error, 'invalid api key', '上游错误体应原样透传');
  }, { fetchImpl: stub });
});

test('/api/jev：限流，同 IP 第 61 次 → 429 且不触达上游', async () => {
  const stub = stubFetch(() => new Response('{}', { status: 200 }));
  await withServer(async (port) => {
    const ip = '10.3.0.1';
    let ok = 0;
    let blocked = 0;
    for (let i = 0; i < 61; i++) {
      const r = await req(port, 'POST', '/api/jev', { state: { i }, questions: {} },
        { 'X-Api-Key': 'k', 'X-Forwarded-For': ip });
      if (r.status === 200) ok++;
      else if (r.status === 429) blocked++;
      else assert(false, '第 ' + (i + 1) + ' 次出现意外状态码 ' + r.status);
    }
    eq(ok, 60, '前 60 次应放行');
    assert(blocked >= 1, '第 61 次应被限流');
    eq(stub.calls.length, 60, '429 不应触达上游');
  }, { fetchImpl: stub });
});

test('/api/games：合法棋谱 → 落盘且内容与提交体一致', async () => {
  await withServer(async (port, root) => {
    const body = {
      format: 'jev-qiguan-game/v1',
      exported: '2026-09-29T12:00:00.000Z',
      game: '五子棋',
      gid: 'gomoku-1a2b3c',
      mode: '人机',
      channel: 'official',
      result: '黑方 获胜（五连）',
      notation: 'H8,H9',
      moves: [
        { ply: 1, side: '黑方', notation: 'H8' },
        { ply: 2, side: '白方', notation: 'H9' },
      ],
    };
    const r = await req(port, 'POST', '/api/games', body, { 'X-Forwarded-For': '10.4.0.1' });
    eq(r.status, 200, '状态码');
    eq(r.json.ok, true, 'ok');
    eq(r.json.dedup, false, '首次写入 dedup 为 false');
    assert(/^games\/2026-09-29\/gomoku-1a2b3c-20260929120000\.json$/.test(r.json.path),
      '落盘路径应符合命名规则：' + r.json.path);
    const abs = path.join(root, 'games', '2026-09-29', 'gomoku-1a2b3c-20260929120000.json');
    assert(fs.existsSync(abs), '文件应已落盘');
    const onDisk = JSON.parse(fs.readFileSync(abs, 'utf8'));
    assert(deepEqual(onDisk, body), '落盘内容（解析后）应与提交体一致');
    eq(fs.readFileSync(abs, 'utf8'), JSON.stringify(body, null, 2), '落盘文本应为 2 空格缩进 JSON');
  });
});

test('/api/games：文件名规则——gid 清洗与 exported 解析失败回退当天', async () => {
  await withServer(async (port, root) => {
    const body = {
      format: 'jev-qiguan-game/v1',
      exported: 'not-a-date',
      game: '围棋',
      gid: 'a b/c%d',
      result: '和棋',
      moves: [{ ply: 1, notation: 'A1' }],
    };
    const r = await req(port, 'POST', '/api/games', body, { 'X-Forwarded-For': '10.4.0.2' });
    eq(r.status, 200, '状态码');
    const m = /^games\/(\d{4}-\d{2}-\d{2})\/abcd-(\d{14})\.json$/.exec(r.json.path);
    assert(!!m, 'gid 应被清洗为 abcd、stamp 为 14 位数字：' + r.json.path);
    eq(m[1], new Date().toISOString().slice(0, 10), 'exported 解析失败应回退当前日期');
    assert(fs.existsSync(path.join(root, 'games', m[1], 'abcd-' + m[2] + '.json')), '文件应落盘');
  });
});

test('/api/games：同 payload 重复 POST → 幂等且不改写文件', async () => {
  await withServer(async (port, root) => {
    const body = {
      format: 'jev-qiguan-game/v1',
      exported: '2026-09-28T08:09:10.000Z',
      game: '象棋',
      gid: 'xq-1',
      result: '黑方 获胜',
      moves: [{ ply: 1, notation: 'a0a1' }],
    };
    const h = { 'X-Forwarded-For': '10.5.0.1' };
    const r1 = await req(port, 'POST', '/api/games', body, h);
    eq(r1.json.dedup, false, '首次 dedup false');
    const abs = path.join(root, 'games', '2026-09-28', 'xq-1-20260928080910.json');
    const before = { mtime: fs.statSync(abs).mtimeMs, text: fs.readFileSync(abs, 'utf8') };
    await new Promise((res) => setTimeout(res, 30)); // 若真重写，mtime 会变
    const r2 = await req(port, 'POST', '/api/games', body, h);
    eq(r2.status, 200, '重复提交仍 200');
    eq(r2.json.dedup, true, '重复提交 dedup true');
    eq(r2.json.path, r1.json.path, '路径一致');
    const after = { mtime: fs.statSync(abs).mtimeMs, text: fs.readFileSync(abs, 'utf8') };
    eq(after.text, before.text, '内容不应被改写');
    eq(after.mtime, before.mtime, 'mtime 不应变化');
  });
});

test('/api/games：坏 payload → 422（format / moves / JSON）', async () => {
  await withServer(async (port) => {
    const h = { 'X-Forwarded-For': '10.6.0.1' };
    let r = await req(port, 'POST', '/api/games', { game: 'x', moves: [{ ply: 1 }] }, h);
    eq(r.status, 422, '缺 format');
    eq(r.json.error, 'not a jev-qiguan-game/v1 payload', '422 文案');
    r = await req(port, 'POST', '/api/games', { format: 'jev-qiguan-game/v1', moves: [] }, h);
    eq(r.status, 422, '空 moves');
    r = await req(port, 'POST', '/api/games', { format: 'jev-qiguan-game/v1' }, h);
    eq(r.status, 422, '缺 moves');
    r = await req(port, 'POST', '/api/games', 'not-json{', h);
    eq(r.status, 422, '非法 JSON');
    eq(r.json.error, 'invalid JSON body', '非法 JSON 文案');
  });
});

test('/api/games：请求体超 2MB → 413', async () => {
  await withServer(async (port) => {
    const big = JSON.stringify({
      format: 'jev-qiguan-game/v1',
      moves: [{ ply: 1, notation: 'x'.repeat(3 * 1024 * 1024) }],
    });
    const r = await req(port, 'POST', '/api/games', big, { 'X-Forwarded-For': '10.6.0.2' });
    eq(r.status, 413, '超限应 413');
    eq(r.json.error, '请求体过大', '413 文案');
  });
});

test('GET /api/games：列表字段齐全、排序与 limit', async () => {
  await withServer(async (port, root) => {
    const mk = (day, name) => {
      const d = path.join(root, 'games', day);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, name), '{"a":1}');
    };
    mk('2026-09-27', 'b-1.json');
    mk('2026-09-28', 'a-2.json');
    mk('2026-09-28', 'a-1.json');
    fs.writeFileSync(path.join(root, 'games', 'loose.json'), '{}'); // 不在日期目录内
    const h = { 'X-Forwarded-For': '10.7.0.1' };
    let r = await req(port, 'GET', '/api/games', undefined, h);
    eq(r.status, 200, '状态码');
    eq(r.json.games.length, 3, '只列日期目录内的 3 个文件');
    eq(r.json.games.map((g) => g.path),
      ['games/2026-09-28/a-2.json', 'games/2026-09-28/a-1.json', 'games/2026-09-27/b-1.json'],
      '按 day+name 倒序');
    const g0 = r.json.games[0];
    eq(Object.keys(g0).sort(), ['day', 'mtime', 'name', 'path', 'size'], '字段齐全');
    eq(g0.day, '2026-09-28', 'day');
    eq(g0.name, 'a-2.json', 'name');
    eq(g0.size, 7, 'size');
    assert(typeof g0.mtime === 'number' && g0.mtime > 0, 'mtime 应为毫秒数');

    r = await req(port, 'GET', '/api/games?limit=1', undefined, h);
    eq(r.json.games.length, 1, 'limit=1 生效');
    eq(r.json.games[0].name, 'a-2.json', '取最新一份');
    r = await req(port, 'GET', '/api/games?limit=0', undefined, h);
    eq(r.json.games.length, 1, 'limit=0 夹到 1');
    r = await req(port, 'GET', '/api/games?limit=9999', undefined, h);
    eq(r.json.games.length, 3, 'limit 上限 500');
    r = await req(port, 'GET', '/api/games?limit=abc', undefined, h);
    eq(r.json.games.length, 3, '非法 limit 回落默认 100');
  });
});

test('GET /api/games/<day>/<name>：200 / 404 / 400 与路径穿越', async () => {
  await withServer(async (port, root) => {
    const d = path.join(root, 'games', '2026-09-29');
    fs.mkdirSync(d, { recursive: true });
    const doc = { format: 'jev-qiguan-game/v1', game: '五子棋', moves: [1, 2] };
    fs.writeFileSync(path.join(d, 'g-1.json'), JSON.stringify(doc));
    let r = await req(port, 'GET', '/api/games/2026-09-29/g-1.json');
    eq(r.status, 200, '存在 → 200');
    assert((r.headers.get('content-type') || '').indexOf('application/json') === 0, 'content-type 为 json');
    assert(deepEqual(r.json, doc), '内容正确');
    r = await req(port, 'GET', '/api/games/2026-09-29/nope.json');
    eq(r.status, 404, '不存在 → 404');
    eq(r.json.error, '棋谱不存在', '404 文案');
    r = await req(port, 'GET', '/api/games/2026-9-9/g-1.json');
    eq(r.status, 400, 'day 格式不符 → 400');
    r = await req(port, 'GET', '/api/games/2026-09-29/g-1.txt');
    eq(r.status, 400, 'name 非 .json → 400');
    r = await req(port, 'GET', '/api/games/2026-09-29/a%2Fb.json');
    eq(r.status, 400, 'name 含 / → 400');
    r = await req(port, 'GET', '/api/games/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    assert(r.status === 400 || r.status === 403 || r.status === 404,
      '编码穿越应被拒，实际 ' + r.status);
    assert(r.text.indexOf('root:') < 0, '不得泄露 /etc/passwd 内容');
  });
});

test('/api/experiments：同 tag upsert、倒序、坏 body 422', async () => {
  await withServer(async (port, root) => {
    const h = { 'X-Forwarded-For': '10.8.0.1' };
    const e1 = {
      tag: 'exp-a', date: '2026-09-29T10:00:00.000Z',
      chanA: 'proxy', chanB: 'random', total: 2,
      games: [{ no: 1, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A' }],
      note: '第一轮',
    };
    let r = await req(port, 'POST', '/api/experiments', e1, h);
    eq(r.status, 200, '状态码');
    eq(r.json.ok, true, 'ok');
    eq(r.json.experiments.length, 1, '首次归档 1 条');
    assert(fs.existsSync(path.join(root, 'data', 'experiments.json')), 'data/experiments.json 应被创建');

    const e2 = Object.assign({}, e1, {
      date: '2026-09-29T11:00:00.000Z',
      games: e1.games.concat([{ no: 2, blackChan: 'random', whiteChan: 'proxy', winnerChan: null }]),
      note: '更新',
    });
    r = await req(port, 'POST', '/api/experiments', e2, h);
    eq(r.json.experiments.length, 1, '同 tag upsert 后长度仍为 1');
    eq(r.json.experiments[0].note, '更新', '内容应被更新');
    eq(r.json.experiments[0].games.length, 2, 'games 应被更新');

    r = await req(port, 'POST', '/api/experiments',
      { tag: 'exp-b', date: '2026-09-28T09:00:00.000Z', chanA: 'official', chanB: 'mock', total: 1, games: [] }, h);
    eq(r.json.experiments.length, 2, '第二个 tag');
    eq(r.json.experiments.map((e) => e.tag), ['exp-a', 'exp-b'], '按 date 倒序');

    r = await req(port, 'GET', '/api/experiments');
    eq(r.status, 200, 'GET 状态码');
    eq(r.json.experiments.length, 2, 'GET 条数');
    eq(r.json.experiments[0].tag, 'exp-a', 'GET 顺序同 POST');

    r = await req(port, 'POST', '/api/experiments', { tag: '', games: [] }, h);
    eq(r.status, 422, '空 tag → 422');
    r = await req(port, 'POST', '/api/experiments', { tag: 'x', games: 'no' }, h);
    eq(r.status, 422, 'games 非数组 → 422');
    r = await req(port, 'POST', '/api/experiments', 'nope', h);
    eq(r.status, 422, '非法 JSON → 422');
  });
});

test('GET /api/experiments：无文件 → 空数组不报错', async () => {
  await withServer(async (port) => {
    const r = await req(port, 'GET', '/api/experiments', undefined, { 'X-Forwarded-For': '10.8.0.2' });
    eq(r.status, 200, '状态码');
    eq(r.json.experiments, [], '空数组');
  });
});

test('/api/stats：跨对局聚合（cal.records / mock / 和棋口径）', async () => {
  await withServer(async (port, root) => {
    const d = path.join(root, 'games', '2026-09-29');
    fs.mkdirSync(d, { recursive: true });
    const w = (name, obj) => fs.writeFileSync(path.join(d, name), JSON.stringify(obj));
    w('a.json', {
      gid: 'gomoku-a', notation: 'H8,A1', game: '五子棋',
      result: '黑方 获胜（五连）', mock: false, firstWin: true, cal: [0.7, 0.8],
    });
    w('b.json', {
      gid: 'gomoku-b', notation: 'H9,B2', game: '五子棋',
      result: '白方 获胜（活三）', mock: false, firstWin: false, cal: [0.4],
    });
    w('c.json', {
      gid: 'go-c', notation: 'A1', game: '围棋',
      result: '黑方 获胜（数目）', mock: true, firstWin: true, cal: [0.9],
    });
    w('d.json', {
      gid: 'go-d', notation: 'B2', game: '围棋',
      result: '和棋（下满 225 手）', mock: false, firstWin: null, cal: [0.5],
    });
    fs.writeFileSync(path.join(d, 'broken.json'), '{ 坏 JSON');
    const r = await req(port, 'GET', '/api/stats', undefined, { 'X-Forwarded-For': '10.9.0.1' });
    eq(r.status, 200, '状态码');
    eq(r.json.ok, true, 'ok');
    eq(r.json.totalGames, 4, '坏文件跳过，其余 4 份计入');
    eq(r.json.byGame, { '五子棋': 2, '围棋': 2 }, 'byGame 计数');
    eq(r.json.results, { black: 2, white: 1, draw: 1 }, 'results 计数');
    eq(r.json.experiments, 0, '无 experiments.json 时为 0');
    eq(r.json.cal.games, 2, 'mock 与和棋不计入 cal');
    assert(!('samples' in r.json.cal), '扁平 samples 字段已移除');
    eq(r.json.cal.records.length, 2, 'records 按局一条');
    const byKey = {};
    r.json.cal.records.forEach((rec) => { byKey[rec.key] = rec; });
    eq(byKey['gomoku-a|H8,A1'], { key: 'gomoku-a|H8,A1', firstWin: true, cal: [0.7, 0.8] },
      '记录 key = gid|notation');
    eq(byKey['gomoku-b|H9,B2'], { key: 'gomoku-b|H9,B2', firstWin: false, cal: [0.4] },
      'firstWin=false 的记录');
  });
});

test('静态托管：/、真实 css、.git 403、编码穿越与 404', async () => {
  /* 用仓库真实根目录，验证 index.html 与 css/style.css 的托管 */
  const stub = stubFetch(() => new Response('{}', { status: 200 }));
  const server = createServer({ root: ROOT, fetchImpl: stub }).listen(0);
  try {
    await once(server, 'listening');
    const port = server.address().port;
    let r = await req(port, 'GET', '/');
    eq(r.status, 200, '/ 状态码');
    assert((r.headers.get('content-type') || '').indexOf('text/html') >= 0, 'content-type 含 text/html');
    assert(r.text.indexOf('<!DOCTYPE html>') === 0, '应为 index.html 原文');
    r = await req(port, 'GET', '/css/style.css');
    eq(r.status, 200, '仓库真实 css 应可访问');
    assert((r.headers.get('content-type') || '').indexOf('text/css') >= 0, 'css content-type');
    assert(!r.headers.get('cache-control'), '静态资源不强加 Cache-Control');
    r = await req(port, 'GET', '/.git/config');
    eq(r.status, 403, '.git 应 403');
    r = await req(port, 'GET', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    assert(r.status === 403 || r.status === 404, '编码穿越应 403/404，实际 ' + r.status);
    assert(r.text.indexOf('root:') < 0, '不得泄露 /etc/passwd 内容');
    r = await req(port, 'GET', '/nope-not-exist.txt');
    eq(r.status, 404, '不存在 → 404');
  } finally {
    await closeServer(server);
  }
});

test('未知 /api/* → 404 JSON', async () => {
  await withServer(async (port) => {
    const r = await req(port, 'GET', '/api/xxx', undefined, { 'X-Forwarded-For': '10.10.0.1' });
    eq(r.status, 404, '状态码');
    eq(r.json.error, 'not found', '404 文案');
    assert((r.headers.get('content-type') || '').indexOf('application/json') === 0, '应为 JSON');
  });
});

/* ---------- runner ---------- */

/* log 可注入：run-tests.js 传入收集器，让后端用例与引擎用例按同一节奏输出；
 * 缺省（直接 node test/server-tests.js）仍打印到控制台。 */
async function serverTests(log) {
  const say = typeof log === 'function' ? log : (line) => console.log(line);
  for (const t of tests) {
    try {
      await t.fn();
      say('✓ ' + t.name);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      failures.push(t.name + ': ' + msg);
      say('✗ ' + t.name + ': ' + msg);
    }
  }
  if (failures.length) {
    throw new Error('server-tests：' + failures.length + '/' + tests.length + ' 项失败\n' + failures.join('\n'));
  }
  say('server-tests：全部 ' + tests.length + ' 项通过');
}

module.exports = { serverTests, tests };

if (require.main === module) {
  serverTests().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
