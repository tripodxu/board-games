/* test/engines/rapfi.test.mjs — Rapfi 本地引擎通道回归（协议纯函数 + 加载状态机 + decide）
 *
 * 覆盖旧 test/rapfi-tests.cjs 的全部 16 项，并补上旧套件测不到的两类：
 *   ①「无 document」分支（Node 里可直接验证加载器注入契约）；
 *   ②加载状态机的失败路径（START 无 OK / 脚本加载失败 / 未导出工厂 / 失败后可重试）。
 * 只 stub Emscripten Module，不加载真实 WASM（真实引擎冒烟见 docs/adr/0006）。
 */
import { suite, ok, eq } from './harness.mjs';

import { getGame } from '../../src/core/registry.ts';
import {
  BOARD_N, DEFAULT_THINK_MS,
  notationToXY, xyToNotation, buildBoardCommand, parseMoveLine, isErrorLine,
  ensureLoaded, decide, glueUrl, setGlueUrl, setLoader, onStdout, setModule, reset,
} from '../../src/core/jev/rapfi.ts';

const S = suite();
const gomoku = getGame('gomoku');

/** cells: [[r, c, sideNum]...]，sideNum 1=黑 2=白 */
function mkState(cells, turn) {
  const board = Array.from({ length: BOARD_N }, () => Array(BOARD_N).fill(0));
  for (const [rr, cc, v] of cells) board[rr][cc] = v;
  return { board: board, turn: turn };
}

/** 假 Emscripten Module：sendCommand 同步回放预设 stdout 行（挂在 sent 上可断言命令）。 */
function fakeModule(handlers) {
  const h = handlers || {};
  return {
    sent: [],
    sendCommand(cmd) {
      this.sent.push(cmd);
      let lines = [];
      if (/^BOARD/.test(cmd) && typeof h.onBoard === 'function') lines = h.onBoard(cmd) || [];
      else if (typeof h.onOther === 'function') lines = h.onOther(cmd) || [];
      for (const l of lines) onStdout(l);
    },
  };
}

function play(eng, st, notation) {
  const m = eng.moveFromNotation(st, notation);
  ok(m, '落子失败：' + notation);
  return eng.applyMove(st, m);
}

async function errOf(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/* ---------------- 坐标转换 ---------------- */

S.t('rapfi：notationToXY 基本映射', () => {
  eq(JSON.stringify(notationToXY('H8')), JSON.stringify({ x: 7, y: 7 }), 'H8');
  eq(JSON.stringify(notationToXY('A1')), JSON.stringify({ x: 0, y: 0 }), 'A1');
  eq(JSON.stringify(notationToXY('O15')), JSON.stringify({ x: 14, y: 14 }), 'O15');
  eq(JSON.stringify(notationToXY('h8')), JSON.stringify({ x: 7, y: 7 }), '小写 h8');
});

S.t('rapfi：notationToXY 非法输入返回 null', () => {
  ok(notationToXY('P1') === null, 'P 列越界');
  ok(notationToXY('A16') === null, '16 行越界');
  ok(notationToXY('A0') === null, '0 行非法');
  ok(notationToXY('') === null, '空串');
  ok(notationToXY('H8X') === null, '多余字符');
  ok(notationToXY(null) === null, 'null');
  ok(notationToXY(88) === null, '非字符串');
});

S.t('rapfi：xyToNotation 基本映射与越界', () => {
  eq(xyToNotation(7, 7), 'H8', '7,7');
  eq(xyToNotation(0, 0), 'A1', '0,0');
  eq(xyToNotation(14, 14), 'O15', '14,14');
  ok(xyToNotation(15, 0) === null, 'x=15 越界');
  ok(xyToNotation(0, -1) === null, 'y=-1 越界');
  ok(xyToNotation(7.5, 7) === null, '非整数');
});

S.t('rapfi：坐标往返一致', () => {
  for (const n of ['A1', 'H8', 'O15', 'A15', 'O1', 'K10']) {
    const p = notationToXY(n);
    eq(xyToNotation(p.x, p.y), n, '往返 ' + n);
  }
});

/* ---------------- BOARD 命令构造 ---------------- */

S.t('rapfi：buildBoardCommand 空盘', () => {
  eq(buildBoardCommand(mkState([], 'black'), 'black'), 'BOARD\nDONE', '空盘黑走');
  eq(buildBoardCommand(mkState([], 'white'), 'white'), 'BOARD\nDONE', '空盘白走');
});

S.t('rapfi：buildBoardCommand 黑走，黑子=1(SELF) 白子=2(OPPO)', () => {
  const cmd = buildBoardCommand(mkState([[7, 7, 1], [8, 7, 2]], 'black'), 'black');
  eq(cmd, 'BOARD\n7,7,1\n7,8,2\nDONE', '黑走 BOARD');
});

S.t('rapfi：buildBoardCommand 白走，颜色相对翻转', () => {
  const cmd = buildBoardCommand(mkState([[7, 7, 1], [7, 8, 1], [8, 7, 2]], 'white'), 'white');
  eq(cmd, 'BOARD\n7,8,1\n7,7,2\n8,7,2\nDONE', '白走 BOARD（交替+末尾单 OPPO）');
});

S.t('rapfi：buildBoardCommand 颜色交替、首子为 SELF', () => {
  const st = mkState([[7, 7, 1], [7, 8, 2], [8, 7, 1], [8, 8, 2], [9, 9, 1]], 'black');
  const lines = buildBoardCommand(st, 'black').split('\n');
  eq(lines[0], 'BOARD', '首行');
  eq(lines[lines.length - 1], 'DONE', '末行');
  const colors = lines.slice(1, -1).map((l) => parseInt(l.split(',')[2], 10));
  eq(colors.length, 5, '5 行落子');
  eq(colors[0], 1, '首子为 SELF');
  for (let i = 1; i < colors.length; i++) {
    if (i === colors.length - 1 && colors[i] === 2) continue; /* 允许末尾单个 OPPO */
    ok(colors[i] !== colors[i - 1], '第 ' + i + ' 子未交替：' + colors.join(','));
  }
  eq(colors.filter((c) => c === 1).length, 3, 'SELF 数=黑子数');
  eq(colors.filter((c) => c === 2).length, 2, 'OPPO 数=白子数');
});

/* ---------------- stdout 着法解析 ---------------- */

S.t('rapfi：parseMoveLine 只认严格 x,y', () => {
  eq(JSON.stringify(parseMoveLine('7,7')), JSON.stringify({ x: 7, y: 7 }), '标准');
  eq(JSON.stringify(parseMoveLine(' 12,3 ')), JSON.stringify({ x: 12, y: 3 }), '前后空格');
  ok(parseMoveLine('OK') === null, 'OK 忽略');
  ok(parseMoveLine('MESSAGE Rapfi 1.0') === null, 'MESSAGE 忽略');
  ok(parseMoveLine('ERROR something') === null, 'ERROR 不是着法');
  ok(parseMoveLine('7,7,1') === null, 'BOARD 行不认');
  ok(parseMoveLine('7,15') === null, '越界');
  ok(parseMoveLine('') === null, '空行');
  ok(parseMoveLine('ab,cd') === null, '非数字');
});

S.t('rapfi：isErrorLine 只认 ERROR 行', () => {
  ok(isErrorLine('ERROR timeout') === true, 'ERROR 行');
  ok(isErrorLine('  ERROR x') === true, '前导空格');
  ok(isErrorLine('MESSAGE ERROR') === false, '非行首');
  ok(isErrorLine('OK') === false, 'OK');
  ok(isErrorLine(null) === false, 'null');
});

/* ---------------- decide 主流程（stub Module） ---------------- */

S.t('rapfi：decide 黑方正常走子', async () => {
  let st = gomoku.newGame();
  st = play(gomoku, st, 'H8');
  st = play(gomoku, st, 'H9');
  reset();
  /* 假引擎回 J10(9,9)，前后夹杂 MESSAGE 行 */
  setModule(fakeModule({ onBoard: () => ['MESSAGE search done', '9,9'] }));
  const legal = gomoku.getLegalMoves(st);
  const d = await decide(gomoku, st, 'black', legal, null, {});
  eq(d.notation, 'J10', '记法');
  eq(d.move.r, 9, '行');
  eq(d.move.c, 9, '列');
  eq(d.meta.channel, 'rapfi', 'meta.channel');
  eq(d.meta.engine, 'Rapfi', 'meta.engine');
  eq(d.meta.thinkMs, DEFAULT_THINK_MS, '默认思考时长');
  eq(d.meta.xy, '9,9', 'meta.xy');
  ok(legal.some((m) => m.notation === 'J10'), '返回的是合法着法');
  reset();
});

S.t('rapfi：decide 白走时 BOARD 颜色相对翻转', async () => {
  let st = gomoku.newGame();
  st = play(gomoku, st, 'H8'); /* 黑 */
  st = play(gomoku, st, 'J8'); /* 白 */
  st = play(gomoku, st, 'H9'); /* 黑 */
  eq(st.turn, 'white', '现在轮白走');
  reset();
  let boardCmd = '';
  setModule(fakeModule({ onBoard: (cmd) => { boardCmd = cmd; return ['0,0']; } }));
  const d = await decide(gomoku, st, 'white', gomoku.getLegalMoves(st), null, {});
  eq(d.notation, 'A1', '白方着法');
  ok(boardCmd.indexOf('9,7,1') >= 0, '白子标为 SELF(1)：' + boardCmd);
  ok(boardCmd.indexOf('7,7,2') >= 0, '黑子标为 OPPO(2)：' + boardCmd);
  reset();
});

S.t('rapfi：decide 非五子棋引擎拒绝', async () => {
  reset();
  setModule(fakeModule({ onBoard: () => ['7,7'] }));
  const err = await errOf(() => decide({ id: 'chess' }, { board: [], turn: 'black' }, 'black', [], null, {}));
  ok(err && /仅支持五子棋/.test(err.message), '应抛仅支持五子棋，实际：' + (err && err.message));
  reset();
});

S.t('rapfi：decide 引擎无响应时抛错', async () => {
  const st = gomoku.newGame();
  reset();
  setModule(fakeModule({ onBoard: () => ['MESSAGE thinking...'] })); /* 无着法行 */
  const err = await errOf(() => decide(gomoku, st, 'black', gomoku.getLegalMoves(st), null, {}));
  ok(err && /无响应/.test(err.message), '应抛无响应，实际：' + (err && err.message));
  reset();
});

S.t('rapfi：decide 引擎 ERROR 行随无响应错误一起抛出', async () => {
  const st = gomoku.newGame();
  reset();
  setModule(fakeModule({ onBoard: () => ['ERROR illegal board'] }));
  const err = await errOf(() => decide(gomoku, st, 'black', gomoku.getLegalMoves(st), null, {}));
  ok(err && /无响应/.test(err.message) && /ERROR illegal board/.test(err.message),
    '错误消息应含引擎 ERROR 行，实际：' + (err && err.message));
  reset();
});

S.t('rapfi：decide 引擎返回非法着法时抛错', async () => {
  let st = gomoku.newGame();
  st = play(gomoku, st, 'H8'); /* H8 已被占 */
  reset();
  setModule(fakeModule({ onBoard: () => ['7,7'] })); /* 引擎偏偏回 H8 */
  const err = await errOf(() => decide(gomoku, st, 'black', gomoku.getLegalMoves(st), null, {}));
  ok(err && /非法着法/.test(err.message), '应抛非法着法，实际：' + (err && err.message));
  reset();
});

S.t('rapfi：decide signal 已 abort 时直接抛 aborted', async () => {
  const st = gomoku.newGame();
  reset();
  setModule(fakeModule({ onBoard: () => ['7,7'] }));
  const ctl = new AbortController();
  ctl.abort();
  const err = await errOf(() => decide(gomoku, st, 'black', gomoku.getLegalMoves(st), null, { signal: ctl.signal }));
  eq(err && err.message, 'aborted', 'abort 语义与 app.js 一致');
  reset();
});

S.t('rapfi：decide 取最后一个着法行', async () => {
  const st = gomoku.newGame();
  reset();
  /* 引擎输出两行着法（某些构建会重发），以后者为准 */
  setModule(fakeModule({ onBoard: () => ['1,1', '2,2'] }));
  const d = await decide(gomoku, st, 'black', gomoku.getLegalMoves(st), null, {});
  eq(d.notation, 'C3', '取最后一个');
  reset();
});

S.t('rapfi：decide thinkMs 夹在 500..60000 并下发 INFO timeout_turn', async () => {
  const st = gomoku.newGame();
  for (const [given, want] of [[undefined, DEFAULT_THINK_MS], [100, 500], [999999, 60000], [2500, 2500]]) {
    reset();
    const mod = fakeModule({ onBoard: () => ['7,7'] });
    setModule(mod);
    const d = await decide(gomoku, st, 'black', gomoku.getLegalMoves(st), null, given === undefined ? {} : { thinkMs: given });
    eq(d.meta.thinkMs, want, 'thinkMs ' + given);
    ok(mod.sent.indexOf('INFO timeout_turn ' + want) >= 0, '已下发 INFO timeout_turn ' + want);
  }
  reset();
});

/* ---------------- 加载状态机（旧套件未覆盖） ---------------- */

S.t('rapfi：未注入加载器时按「无 document」拒绝（原话保持一致）', async () => {
  reset();
  setLoader(null);
  const err = await errOf(() => ensureLoaded());
  eq(err && err.message, '当前环境不支持动态加载 Rapfi 脚本（无 document）', '文案与旧实现一致');

  const err2 = await errOf(() => decide(gomoku, gomoku.newGame(), 'black', [], null, {}));
  eq(err2 && err2.message, '当前环境不支持动态加载 Rapfi 脚本（无 document）', 'decide 走同一路径');
  reset();
});

S.t('rapfi：注入加载器后 START 须有 OK，否则报「无 OK 回应」；成功后并发复用同一 Promise', async () => {
  reset();
  const calls = [];
  const started = [];
  setLoader(async (url) => {
    calls.push(url);
    return fakeModule({ onOther: (cmd) => { started.push(cmd); return cmd === 'START 15' ? ['OK'] : []; } });
  });
  const m1 = await ensureLoaded();
  ok(!!m1, '已加载');
  eq(calls.length, 1, '加载器只调用一次');
  eq(started[0], 'START 15', '首条命令 START 15');
  eq(started[1], 'INFO rule 0', '次条命令 INFO rule 0（无禁手）');
  const m2 = await ensureLoaded();
  ok(m1 === m2, '已就绪后直接复用（不再调用加载器）');
  eq(calls.length, 1, '仍未再次调用加载器');

  /* 无 OK 的 START：整个加载失败 */
  reset();
  setLoader(async () => fakeModule({ onOther: () => ['ERROR bad size'] }));
  const err = await errOf(() => ensureLoaded());
  ok(err && /引擎 START 无 OK 回应/.test(err.message), '应抛无 OK 回应，实际：' + (err && err.message));
  reset();
  setLoader(null);
});

S.t('rapfi：加载失败报「脚本加载失败」且失败后可重试', async () => {
  reset();
  let attempt = 0;
  setLoader(async () => {
    attempt++;
    if (attempt === 1) throw new Error('404 Not Found');
    return fakeModule({ onOther: (cmd) => (cmd === 'START 15' ? ['OK'] : []) });
  });
  const err = await errOf(() => ensureLoaded());
  ok(err && /Rapfi 脚本加载失败/.test(err.message) && /404 Not Found/.test(err.message),
    '应抛脚本加载失败并带原因，实际：' + (err && err.message));
  const m = await ensureLoaded(); /* 失败后 _loadPromise 已清零 → 可重试 */
  ok(!!m, '第二次加载成功');
  eq(attempt, 2, '加载器被调用两次');
  reset();
  setLoader(null);
});

S.t('rapfi：加载器返回非工厂时按「未导出工厂函数」报错', async () => {
  reset();
  setLoader(async () => ({}));
  const err = await errOf(() => ensureLoaded());
  ok(err && /未导出工厂函数 Rapfi/.test(err.message), '应抛未导出工厂，实际：' + (err && err.message));
  reset();
  setLoader(null);
});

S.t('rapfi：glueUrl 默认相对路径，可被 UI 层覆盖', () => {
  eq(glueUrl(), 'rapfi/rapfi-single-simd128.js', '默认值即 GLUE_FILE');
  setGlueUrl('/rapfi/rapfi-single-simd128.js');
  eq(glueUrl(), '/rapfi/rapfi-single-simd128.js', 'UI 层可改成 public 路径');
  setGlueUrl('');
  eq(glueUrl(), 'rapfi/rapfi-single-simd128.js', '空值回落到默认');
  ok(BOARD_N === 15, '棋盘 15 路');
});

S.t('rapfi：加载器收到的 url 与 glueUrl() 一致', async () => {
  reset();
  const seen = [];
  setGlueUrl('/rapfi/rapfi-single-simd128.js');
  setLoader(async (url) => {
    seen.push(url);
    return fakeModule({ onOther: (cmd) => (cmd === 'START 15' ? ['OK'] : []) });
  });
  await ensureLoaded();
  eq(seen[0], '/rapfi/rapfi-single-simd128.js', '加载器拿到的是 glueUrl()');
  reset();
  setLoader(null);
  setGlueUrl('');
});

export default S;
