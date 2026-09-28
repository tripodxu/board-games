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

/* 集成：mock AI 机机对弈完整一盘（gomoku / cc / go），验证 client→engine 全链路 */
async function integration() {
  eval(fs.readFileSync(path.join(ROOT, 'js/mock-ai.js'), 'utf8'));
  eval(fs.readFileSync(path.join(ROOT, 'js/jev-client.js'), 'utf8'));
  for (const gid of ['gomoku', 'cc', 'go']) {
    const e = globalThis.BG.games[gid];
    let st = e.newGame();
    let plies = 0;
    while (!e.getStatus(st).over && plies < 600) {
      const d = await globalThis.BG.jev.decide(e, st, st.turn, { channel: 'mock', topK: 3 });
      if (!d.move || !e.getLegalMoves(st).some((m) => m.notation === d.move.notation)) {
        throw new Error(gid + ' 第 ' + plies + ' 步返回非法着法 ' + d.notation);
      }
      st = e.applyMove(st, d.move);
      plies++;
    }
    const g = e.getStatus(st);
    if (!g.over) throw new Error(gid + ' ' + plies + ' 步未终局（疑似死循环）');
    results.push('✓ 集成 ' + e.name + '：' + plies + ' 步终局，胜者=' + (g.winner || '和') + '，' + g.reason);
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
}

integration()
  .catch((e) => { failed++; results.push('✗ 集成测试: ' + e.message); })
  .then(() => jevClientTests())
  .catch((e) => { failed++; results.push('✗ jev-client 单元测试: ' + e.message); })
  .finally(() => {
    console.log(results.join('\n'));
    if (failed) {
      console.log('\n' + failed + ' 项失败');
      process.exit(1);
    }
    console.log('\n全部测试通过');
  });
