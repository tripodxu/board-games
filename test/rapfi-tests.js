'use strict';
/* rapfi-tests.js — BG.rapfi（Rapfi WASM 本地引擎通道）的 Node 单元测试。
 * 用法：
 *   node test/rapfi-tests.js
 * 也可被 test/run-tests.js require 后调用 rapfiTests(push)。
 *
 * 风格同 test/server-tests.js：自写 assert，每例打印 ✓/✗；
 * 失败时 rapfiTests() reject。
 * 注意：只 stub Emscripten Module（_setModule/_emitStdout），不加载真实 WASM；
 * 真实引擎冒烟见 docs/adr/0006 的记录。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tests = [];
const failures = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function eq(a, b, msg) {
  assert(a === b, (msg || '不相等') + '：期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
}

/* 按需加载被测模块及其依赖（被 run-tests.js require 时可能已加载，幂等）。 */
function ensureLoaded() {
  if (!globalThis.BG) globalThis.BG = {};
  if (!globalThis.BG.util) eval(fs.readFileSync(path.join(ROOT, 'js/board.js'), 'utf8'));
  if (!globalThis.BG.games || !globalThis.BG.games.gomoku)
    eval(fs.readFileSync(path.join(ROOT, 'js/games/gomoku.js'), 'utf8'));
  eval(fs.readFileSync(path.join(ROOT, 'js/rapfi.js'), 'utf8'));
  assert(globalThis.BG.rapfi, 'BG.rapfi 未挂载');
  return globalThis.BG.rapfi;
}

/* ---------- 坐标转换 ---------- */

test('notationToXY：基本映射', () => {
  const r = ensureLoaded();
  eq(JSON.stringify(r.notationToXY('H8')), JSON.stringify({ x: 7, y: 7 }), 'H8');
  eq(JSON.stringify(r.notationToXY('A1')), JSON.stringify({ x: 0, y: 0 }), 'A1');
  eq(JSON.stringify(r.notationToXY('O15')), JSON.stringify({ x: 14, y: 14 }), 'O15');
  eq(JSON.stringify(r.notationToXY('h8')), JSON.stringify({ x: 7, y: 7 }), '小写 h8');
});

test('notationToXY：非法输入返回 null', () => {
  const r = ensureLoaded();
  assert(r.notationToXY('P1') === null, 'P 列越界');
  assert(r.notationToXY('A16') === null, '16 行越界');
  assert(r.notationToXY('A0') === null, '0 行非法');
  assert(r.notationToXY('') === null, '空串');
  assert(r.notationToXY('H8X') === null, '多余字符');
  assert(r.notationToXY(null) === null, 'null');
});

test('xyToNotation：基本映射与越界', () => {
  const r = ensureLoaded();
  eq(r.xyToNotation(7, 7), 'H8', '7,7');
  eq(r.xyToNotation(0, 0), 'A1', '0,0');
  eq(r.xyToNotation(14, 14), 'O15', '14,14');
  assert(r.xyToNotation(15, 0) === null, 'x=15 越界');
  assert(r.xyToNotation(0, -1) === null, 'y=-1 越界');
  assert(r.xyToNotation(7.5, 7) === null, '非整数');
});

test('坐标往返一致', () => {
  const r = ensureLoaded();
  for (const n of ['A1', 'H8', 'O15', 'A15', 'O1', 'K10']) {
    const p = r.notationToXY(n);
    eq(r.xyToNotation(p.x, p.y), n, '往返 ' + n);
  }
});

/* ---------- BOARD 命令构造 ---------- */

function mkState(cells, turn) {
  // cells: [[r, c, sideNum]...]，sideNum 1=黑 2=白
  const board = Array.from({ length: 15 }, () => Array(15).fill(0));
  for (const [rr, cc, v] of cells) board[rr][cc] = v;
  return { board: board, turn: turn };
}

test('buildBoardCommand：空盘', () => {
  const r = ensureLoaded();
  eq(r.buildBoardCommand(mkState([], 'black'), 'black'), 'BOARD\nDONE', '空盘黑走');
  eq(r.buildBoardCommand(mkState([], 'white'), 'white'), 'BOARD\nDONE', '空盘白走');
});

test('buildBoardCommand：黑走，黑子=1(SELF) 白子=2(OPPO)', () => {
  const r = ensureLoaded();
  // 黑 H8(r=7,c=7)、白 H9(r=8,c=7)，轮黑走
  const cmd = r.buildBoardCommand(mkState([[7, 7, 1], [8, 7, 2]], 'black'), 'black');
  eq(cmd, 'BOARD\n7,7,1\n7,8,2\nDONE', '黑走 BOARD');
});

test('buildBoardCommand：白走，颜色相对翻转', () => {
  const r = ensureLoaded();
  // 黑 H8(7,7)、黑 I8(7,8)、白 H9(8,7)，轮白走：白子为 SELF(1)
  const cmd = r.buildBoardCommand(mkState([[7, 7, 1], [7, 8, 1], [8, 7, 2]], 'white'), 'white');
  eq(cmd, 'BOARD\n7,8,1\n7,7,2\n8,7,2\nDONE', '白走 BOARD（交替+末尾单 OPPO）');
});

test('buildBoardCommand：颜色交替、首子为 SELF', () => {
  const r = ensureLoaded();
  // 构造 5 子对局（黑 3 白 2，轮黑走）
  const st = mkState([[7, 7, 1], [7, 8, 2], [8, 7, 1], [8, 8, 2], [9, 9, 1]], 'black');
  const lines = r.buildBoardCommand(st, 'black').split('\n');
  eq(lines[0], 'BOARD', '首行');
  eq(lines[lines.length - 1], 'DONE', '末行');
  const colors = lines.slice(1, -1).map((l) => parseInt(l.split(',')[2], 10));
  eq(colors.length, 5, '5 行落子');
  eq(colors[0], 1, '首子为 SELF');
  for (let i = 1; i < colors.length; i++) {
    // 允许末尾单个 OPPO（白多一子时），其余必须严格交替
    if (i === colors.length - 1 && colors[i] === 2) continue;
    assert(colors[i] !== colors[i - 1], '第 ' + i + ' 子未交替：' + colors.join(','));
  }
  const selfCount = colors.filter((c) => c === 1).length;
  const oppoCount = colors.filter((c) => c === 2).length;
  eq(selfCount, 3, 'SELF 数=黑子数');
  eq(oppoCount, 2, 'OPPO 数=白子数');
});

/* ---------- stdout 着法解析 ---------- */

test('parseMoveLine：只认严格 x,y', () => {
  const r = ensureLoaded();
  eq(JSON.stringify(r.parseMoveLine('7,7')), JSON.stringify({ x: 7, y: 7 }), '标准');
  eq(JSON.stringify(r.parseMoveLine(' 12,3 ')), JSON.stringify({ x: 12, y: 3 }), '前后空格');
  assert(r.parseMoveLine('OK') === null, 'OK 忽略');
  assert(r.parseMoveLine('MESSAGE Rapfi 1.0') === null, 'MESSAGE 忽略');
  assert(r.parseMoveLine('ERROR something') === null, 'ERROR 不是着法');
  assert(r.parseMoveLine('7,7,1') === null, 'BOARD 行不认');
  assert(r.parseMoveLine('7,15') === null, '越界');
  assert(r.parseMoveLine('') === null, '空行');
  assert(r.parseMoveLine('ab,cd') === null, '非数字');
});

/* ---------- decide 主流程（stub Module） ---------- */

/* 造一个假 Emscripten Module：sendCommand 同步回放预设的 stdout 行。
 * handlers: { onBoard(cmd)->string[] }，返回每次 BOARD 要输出的行。 */
function fakeModule(handlers) {
  handlers = handlers || {};
  return {
    sent: [],
    sendCommand(cmd) {
      this.sent.push(cmd);
      let lines = [];
      if (/^BOARD/.test(cmd) && typeof handlers.onBoard === 'function') {
        lines = handlers.onBoard(cmd) || [];
      } else if (typeof handlers.onOther === 'function') {
        lines = handlers.onOther(cmd) || [];
      }
      for (const l of lines) globalThis.BG.rapfi._emitStdout(l);
    },
  };
}

function play(eng, st, notation) {
  const m = eng.moveFromNotation(st, notation);
  assert(m, '落子失败：' + notation);
  return eng.applyMove(st, m);
}

test('decide：黑方正常走子', async () => {
  const r = ensureLoaded();
  const eng = globalThis.BG.games.gomoku;
  let st = eng.newGame();
  st = play(eng, st, 'H8');
  st = play(eng, st, 'H9');
  r._reset();
  // 假引擎回 J10(9,9)，前后夹杂 MESSAGE 行
  r._setModule(fakeModule({ onBoard: () => ['MESSAGE search done', '9,9'] }));
  const legal = eng.getLegalMoves(st);
  const d = await r.decide(eng, st, 'black', legal, null, {});
  eq(d.notation, 'J10', '记法');
  eq(d.move.r, 9, '行');
  eq(d.move.c, 9, '列');
  eq(d.meta.channel, 'rapfi', 'meta.channel');
  assert(legal.some((m) => m.notation === 'J10'), '返回的是合法着法');
  r._reset();
});

test('decide：白走时 BOARD 颜色相对翻转', async () => {
  const r = ensureLoaded();
  const eng = globalThis.BG.games.gomoku;
  let st = eng.newGame();
  st = play(eng, st, 'H8'); // 黑
  st = play(eng, st, 'J8'); // 白
  // 轮黑走…再走一步让轮白走
  st = play(eng, st, 'H9'); // 黑
  assert(st.turn === 'white', '现在轮白走');
  r._reset();
  let boardCmd = '';
  r._setModule(fakeModule({
    onBoard: (cmd) => { boardCmd = cmd; return ['0,0']; },
  }));
  const d = await r.decide(eng, st, 'white', eng.getLegalMoves(st), null, {});
  eq(d.notation, 'A1', '白方着法');
  // 白子(9,7)=J8 应为 ,1；黑子应为 ,2
  assert(boardCmd.indexOf('9,7,1') >= 0, '白子标为 SELF(1)：' + boardCmd);
  assert(boardCmd.indexOf('7,7,2') >= 0, '黑子标为 OPPO(2)：' + boardCmd);
  r._reset();
});

test('decide：非五子棋引擎拒绝', async () => {
  const r = ensureLoaded();
  r._reset();
  r._setModule(fakeModule({ onBoard: () => ['7,7'] }));
  let err = null;
  try {
    await r.decide({ id: 'chess' }, { board: [], turn: 'black' }, 'black', [], null, {});
  } catch (e) { err = e; }
  assert(err && /仅支持五子棋/.test(err.message), '应抛仅支持五子棋，实际：' + (err && err.message));
  r._reset();
});

test('decide：引擎无响应时抛错', async () => {
  const r = ensureLoaded();
  const eng = globalThis.BG.games.gomoku;
  const st = eng.newGame();
  r._reset();
  r._setModule(fakeModule({ onBoard: () => ['MESSAGE thinking...'] })); // 无着法行
  let err = null;
  try {
    await r.decide(eng, st, 'black', eng.getLegalMoves(st), null, {});
  } catch (e) { err = e; }
  assert(err && /无响应/.test(err.message), '应抛无响应，实际：' + (err && err.message));
  r._reset();
});

test('decide：引擎返回非法着法时抛错', async () => {
  const r = ensureLoaded();
  const eng = globalThis.BG.games.gomoku;
  let st = eng.newGame();
  st = play(eng, st, 'H8'); // H8 已被占
  r._reset();
  r._setModule(fakeModule({ onBoard: () => ['7,7'] })); // 引擎偏偏回 H8
  let err = null;
  try {
    await r.decide(eng, st, 'black', eng.getLegalMoves(st), null, {});
  } catch (e) { err = e; }
  assert(err && /非法着法/.test(err.message), '应抛非法着法，实际：' + (err && err.message));
  r._reset();
});

test('decide：signal 已 abort 时直接抛 aborted', async () => {
  const r = ensureLoaded();
  const eng = globalThis.BG.games.gomoku;
  const st = eng.newGame();
  r._reset();
  r._setModule(fakeModule({ onBoard: () => ['7,7'] }));
  const ctl = new AbortController();
  ctl.abort();
  let err = null;
  try {
    await r.decide(eng, st, 'black', eng.getLegalMoves(st), null, { signal: ctl.signal });
  } catch (e) { err = e; }
  eq(err && err.message, 'aborted', 'abort 语义与 app.js 一致');
  r._reset();
});

test('decide：取最后一个着法行', async () => {
  const r = ensureLoaded();
  const eng = globalThis.BG.games.gomoku;
  const st = eng.newGame();
  r._reset();
  // 引擎输出两行着法（某些构建会重发），以后者为准
  r._setModule(fakeModule({ onBoard: () => ['1,1', '2,2'] }));
  const d = await r.decide(eng, st, 'black', eng.getLegalMoves(st), null, {});
  eq(d.notation, 'C3', '取最后一个');
  r._reset();
});

/* ---------- 运行器 ---------- */

async function rapfiTests(push) {
  push = push || ((line) => console.log(line));
  ensureLoaded();
  for (const t of tests) {
    try {
      await t.fn();
      push('✓ rapfi: ' + t.name);
    } catch (e) {
      failures.push(t.name + ': ' + e.message);
      push('✗ rapfi: ' + t.name + ': ' + e.message);
    }
  }
  if (failures.length) {
    throw new Error(failures.length + ' 项 rapfi 测试失败: ' + failures.join('；'));
  }
  return { passed: tests.length };
}

module.exports = { rapfiTests, tests };

if (require.main === module) {
  rapfiTests()
    .then(({ passed }) => console.log('\nrapfi 全部 ' + passed + ' 项通过'))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
