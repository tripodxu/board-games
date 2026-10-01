/* test/engines/engines.test.mjs — 七引擎自检 + rules 契约 + 记法重放护栏 + mock 集成对局
 *
 * 覆盖旧 test/run-tests.cjs 中的：
 *   - 六引擎 selfTest()（gomoku/gomoku-pro/go/xiangqi/chess/checkers/cc）
 *   - serializeForJev(...).state.rules 非空字符串契约
 *   - integration() 的 mock 机机对弈 + 同 seed 复现 + 记法重放护栏
 */
import { suite, ok, eq, deepEq } from './harness.mjs';

import { games, ids, getGame } from '../../src/core/registry.ts';
import { setSeed, getSeed } from '../../src/core/rng.ts';
import { decide } from '../../src/core/jev/index.ts';

const S = suite();

/* ------------------------------------------------------------------ *
 * ① 引擎自检（引擎内部断言；逐个跑，失败能定位到棋种）
 * ------------------------------------------------------------------ */
for (const id of ['gomoku', 'gomoku-pro', 'go', 'xiangqi', 'chess', 'checkers', 'cc']) {
  S.t('selfTest：' + id, () => {
    const e = getGame(id);
    ok(!!e, '未注册棋种 ' + id);
    e.selfTest();
  });
}

/* ------------------------------------------------------------------ *
 * ② state.rules 契约：每条规则全文是「模型唯一的规则来源」，不得为空
 * ------------------------------------------------------------------ */
S.t('rules：七个棋种的 rules 均为长度 ≥40 的字符串', () => {
  for (const id of ids) {
    const e = games[id];
    const ser = e.serializeForJev(e.newGame(), e.sides[0].id);
    const rules = ser.state.rules;
    ok(typeof rules === 'string', id + ' 的 state.rules 应为字符串，实际 ' + typeof rules);
    ok(rules.length >= 40, id + ' 的 state.rules 过短（' + rules.length + ' 字符）');
  }
});

/* ------------------------------------------------------------------ *
 * ③ 接口契约：七引擎统一接口齐备、初始局面合法着法非空、记法可往返
 * ------------------------------------------------------------------ */
S.t('契约：七引擎统一接口齐备且初始局面可下', () => {
  for (const id of ids) {
    const e = games[id];
    for (const m of ['newGame', 'getLegalMoves', 'applyMove', 'getStatus', 'moveFromNotation', 'serializeForJev', 'selfTest']) {
      eq(typeof e[m], 'function', id + ' 缺方法 ' + m);
    }
    const st = e.newGame();
    const legal = e.getLegalMoves(st);
    ok(legal.length > 0, id + ' 初始局面应有合法着法');
    const g = e.getStatus(st);
    eq(!!g.over, false, id + ' 初始局面不应终局');
    eq(g.turn, st.turn, id + ' 非终局状态必须给 turn');
    eq(st.turn, e.sides[0].id, id + ' 初始 turn 应为先手方 ' + e.sides[0].id);
    for (const mv of legal) {
      ok(typeof mv.notation === 'string' && mv.notation.length > 0, id + ' 着法缺 notation');
      const back = e.moveFromNotation(st, mv.notation);
      ok(!!back, id + ' 记法 ' + mv.notation + ' 无法反查（记法往返硬契约）');
      eq(back.notation, mv.notation, id + ' 记法 ' + mv.notation + ' 反查后变了名');
    }
    const next = e.applyMove(st, legal[0]);
    deepEq(st, e.newGame(), id + ' applyMove 不得原地修改传入状态（必须返回新对象）');
    eq(next.turn !== st.turn, true, id + ' applyMove 后应换手');
  }
});

S.t('契约：applyMove 产出与输入状态无共享引用', () => {
  for (const id of ids) {
    const e = games[id];
    const st = e.newGame();
    const before = JSON.stringify(st);
    const next = e.applyMove(st, e.getLegalMoves(st)[0]);
    eq(JSON.stringify(st), before, id + ' applyMove 后原状态被改动');
    ok(next !== st, id + ' applyMove 应返回新对象');
  }
});

S.t('契约：状态可 JSON 克隆（悔棋/归档依赖）', () => {
  for (const id of ids) {
    const e = games[id];
    const st = e.newGame();
    const n = JSON.parse(JSON.stringify(st));
    deepEq(n, st, id + ' 状态 JSON 往返应完全一致');
  }
});

S.t('契约：serializeForJev 三问齐备且 options 覆盖全部合法着法', () => {
  for (const id of ids) {
    const e = games[id];
    const st = e.newGame();
    const ser = e.serializeForJev(st, st.turn);
    ok(ser.questions && ser.questions.move, id + ' 缺 move 问题');
    eq(typeof ser.questions.move.type, 'string', id + ' move.type 应为字符串');
    eq(typeof ser.questions.move.instructions, 'string', id + ' move.instructions 应为字符串');
    ok(ser.questions.edge, id + ' 缺 edge 问题');
    ok(ser.questions.position, id + ' 缺 position 问题');
    /* 旧实现把 options 放在 serializeForJev 的**顶层**（不是 questions.move 里） */
    const opts = ser.options;
    ok(Array.isArray(opts) && opts.length > 0, id + ' options 应为非空数组');
    const legal = e.getLegalMoves(st).map((m) => m.notation);
    /* 候选集是合法着法的**子集**；三类有意的收窄：
       gomoku 走 candidates(st,64)（开局只给天元）、cc 超 255 只留跳吃、chess 把升变折叠成 =Q */
    ok(opts.length <= legal.length, id + ' options 不应超出合法着法数');
    for (const o of opts) ok(legal.indexOf(o) >= 0, id + ' options 含非法着法 ' + o);
    /* 给全量的棋种必须逐条覆盖（漏一手 = 模型永远看不到那手） */
    if (['go', 'xiangqi', 'checkers'].indexOf(id) >= 0) {
      eq(opts.length, legal.length, id + ' options 应覆盖全部合法着法');
    }
  }
});

/* ------------------------------------------------------------------ *
 * ③b board_ascii 契约（旧 test/run-tests.cjs:982-996 的 ⑥b）
 *
 * 为什么单独钉这一组：`board_ascii` 是 Jev 读棋盘的**主要事实来源**，实现已迁到
 * src/core/engines/gomoku.ts:414（裁剪到有子区域外扩 2 格 / 大写 X/O / 小写标末手），
 * 但旧套件的断言随 test/run-tests.cjs 一起消失——是本次清点里唯一
 * 「实现已迁、断言整体丢失」的功能点。所有形状期望值照抄旧文件原文，不重新发明。
 * ------------------------------------------------------------------ */

/** 按记法序列摆出一个局面（与 test/engines/tactics.test.mjs 的 play() 同一写法）。 */
function playSeq(e, seq) {
  let st = e.newGame();
  for (const n of seq) {
    const m = e.moveFromNotation(st, n);
    if (!m) throw new Error('夹具记法非法：' + n);
    st = e.applyMove(st, m);
  }
  return st;
}

S.t('board_ascii：裁剪范围 / 行列数 / 末手小写 / 空盘 5×5 / 指令刚性扫描句', () => {
  const e = games['gomoku'];
  /* 与旧套件同一个局面：黑 H8 I8 J8 K8 四连，白 A1 C2 E3 与**最后一手 G5**。
   * 有子区域列 A–K、行 1–8，外扩 2 格后裁剪为列 A–M × 行 1–10。 */
  const stx = playSeq(e, ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5']);
  const ser = e.serializeForJev(stx, stx.turn);
  const asc = ser.state.board_ascii;
  const lines = asc.split('\n');
  const rowOf = (n) => lines.filter((l) => l.startsWith(' ' + n + ' ') || l.startsWith(n + '  '))[0];
  const cellsOf = (l) => l.slice(4).split(' ');

  /* (1) 行数/列数：1 行列表头 + 10 行棋盘；每行 13 格（A–M），逐行等宽 */
  eq(typeof asc, 'string', 'board_ascii 应为字符串');
  eq(lines.length, 11, 'board_ascii 应为「1 行表头 + 10 行棋盘」，实际 ' + lines.length + ' 行');
  eq(lines[0], '    A B C D E F G H I J K L M', '表头应为裁剪后 A–M 的列字母：' + JSON.stringify(lines[0]));
  for (const l of lines.slice(1)) {
    eq(cellsOf(l).length, 13, '棋盘行应为 13 格（A–M），实际 ' + JSON.stringify(l));
  }

  /* (2) 双方棋子字符不同：黑 X、白 O；且黑四连在行 8（H8/I8/J8/K8）逐格定位 */
  ok(asc.indexOf('X') >= 0 && asc.indexOf('O') >= 0, '棋盘应含黑白子字符 X/O');
  eq(cellsOf(rowOf(8)).slice(7, 11).join(''), 'XXXX', '行 8 的 H–K 四格应为黑 X 四连');
  eq(cellsOf(rowOf(1))[0], 'O', '行 1 的 A 应为白 O（盘面贴边时裁剪不越界到行 0）');

  /* (3) 末手小写：G5 是白方最后一手 → 行 5 的 G 格为 ``o``（非末手白子仍是 ``O``）；
   *     同一行不得出现其它小写（末手标记只能有一个） */
  eq(cellsOf(rowOf(5))[6], 'o', '末手 G5（白）应以小写 o 标记');
  eq(rowOf(5).indexOf('o'), rowOf(5).lastIndexOf('o'), '行 5 只应有一处末手小写标记');
  eq(asc.indexOf('x'), -1, '非末手黑子必须是大写 X，棋盘里不应出现小写 x');
  eq(asc.split('o').length - 1, 1, '整盘只应有一个末手小写 o，实际出现 ' + (asc.split('o').length - 1) + ' 次');

  /* (4) 指令：刚性扫描清单 + 防幻觉核对 + 逐格核对 board_ascii（旧套件同款正则） */
  const ins = ser.questions.move.instructions;
  ok(/scan in order/.test(ins), 'move 指令应含刚性扫描清单（"scan in order"）');
  ok(/cell by cell/.test(ins), 'move 指令应要求逐格核对（"cell by cell"）');
  ok(/board_ascii/.test(ins), 'move 指令应点名 board_ascii');

  /* (5) 空盘：裁剪到天元附近 5×5（1 行表头 + 5 行），行号 6–10、列 F–J */
  const ascEmpty = e.serializeForJev(e.newGame(), 'black').state.board_ascii;
  const emptyLines = ascEmpty.split('\n');
  eq(emptyLines.length, 6, '空盘应为 1 行表头 + 5 行棋盘，实际 ' + emptyLines.length + ' 行');
  eq(emptyLines[0], '    F G H I J', '空盘表头应为天元附近 F–J：' + JSON.stringify(emptyLines[0]));
  eq(emptyLines.slice(1).map((l) => l.slice(0, 2)).join(','), ' 6, 7, 8, 9,10', '空盘行号应为 6–10');
  ok(emptyLines.slice(1).every((l) => cellsOf(l).every((c) => c === '.')), '空盘每格都应是 "."');
});

/* ------------------------------------------------------------------ *
 * ④ mock 机机对弈 + 同 seed 复现 + 记法重放护栏（旧 integration()）
 * ------------------------------------------------------------------ */
async function playOut(gid, maxPlies) {
  setSeed(42); /* 每个棋种从同一 seed 起跑，保证可复现 */
  const e = getGame(gid);
  let st = e.newGame();
  let plies = 0;
  const notations = [];
  const cap = maxPlies || 600;
  while (!e.getStatus(st).over && plies < cap) {
    const d = await decide(e, st, st.turn, { channel: 'mock', topK: 3 });
    if (!d.move || !e.getLegalMoves(st).some((m) => m.notation === d.move.notation)) {
      throw new Error(gid + ' 第 ' + plies + ' 步返回非法着法 ' + d.notation);
    }
    st = e.applyMove(st, d.move);
    notations.push(d.move.notation);
    plies++;
  }
  const g = e.getStatus(st);
  if (!g.over) throw new Error(gid + ' ' + plies + ' 步未终局（疑似死循环）');

  /* 记法重放护栏：悔棋是「history 只存记法 + 从 newGame 重放」，
   * 因此「整盘只用 notation 走一遍」必须得到与逐步 applyMove 完全一致的终局状态。 */
  let replay = e.newGame();
  for (const n of notations) {
    const m = e.moveFromNotation(replay, n);
    if (!m) throw new Error(gid + ' 记法重放失败于 ' + n + '（moveFromNotation 返回 null）');
    replay = e.applyMove(replay, m);
  }
  eq(JSON.stringify(replay), JSON.stringify(st), gid + ' 记法重放后的终局状态与逐步下棋不一致（悔棋还原会出错）');
  eq(JSON.stringify(e.getStatus(replay)), JSON.stringify(g), gid + ' 记法重放后的终局判定与原对局不一致');
  return e.name + '：' + plies + ' 步终局，胜者=' + (g.winner || '和') + '，' + g.reason + '|' + notations.join(',');
}

for (const gid of ['gomoku', 'cc', 'go']) {
  S.t('集成：mock 机机对弈一盘（' + gid + '）', async () => {
    const summary = await playOut(gid);
    ok(summary.indexOf('步终局') > 0, gid + ' 对局摘要异常：' + summary);
    const again = await playOut(gid);
    eq(summary, again, gid + ' 同 seed 复现失败：' + summary + ' ≠ ' + again);
  });
}

S.t('集成：mock 决策链全部落子合法且状态 JSON 可序列化', async () => {
  setSeed(42);
  const e = games['gomoku'];
  let st = e.newGame();
  for (let i = 0; i < 30; i++) {
    const d = await decide(e, st, st.turn, { channel: 'mock', topK: 3 });
    ok(d.move.notation.length > 0, 'mock 决策应给记法');
    const legal = e.getLegalMoves(st).map((m) => m.notation);
    ok(legal.indexOf(d.move.notation) >= 0, 'mock 决策 ' + d.move.notation + ' 不在合法集内');
    st = e.applyMove(st, d.move);
    JSON.stringify(st);
  }
  ok(!!getSeed() === true, '对局后种子应仍在（可归因）');
});

export default S;
