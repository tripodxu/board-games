'use strict';
/* Node 自检：加载 board.js + 六个引擎，运行各引擎 selfTest()。用法：node test/run-tests.js */
const fs = require('fs');
const path = require('path');

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

integration()
  .catch((e) => { failed++; results.push('✗ 集成测试: ' + e.message); })
  .finally(() => {
    console.log(results.join('\n'));
    if (failed) {
      console.log('\n' + failed + ' 项失败');
      process.exit(1);
    }
    console.log('\n全部测试通过');
  });
