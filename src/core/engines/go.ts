/* go.ts — 围棋 9×9（中国规则数子法，贴目 5.5）（迁移自 js/games/go.js）
 *
 * 坐标：列 A–I（左→右，不跳过 I），行 1–9（上→下），如 E5 为天元。
 * 含提子、禁自杀、简单劫、双停一手终局。19 路等大盘未开放（Choice ≤255 选项限制）。
 */
import { assert } from '../assert.ts';
import { clone } from '../clone.ts';
import { rnd } from '../rng.ts';
import { gfx } from '../gfx.ts';
import type { Canvas2D } from '../gfx.ts';
import type { Engine, GameStatus, JevSerialized, Move, PickConfig, UiState } from '../types.ts';

const N = 9, KOMI = 5.5;
const CELL = 44, MARGIN = 30;
const W = MARGIN * 2 + (N - 1) * CELL, H = W;
const colName = (c: number): string => String.fromCharCode(65 + c);
const notation = (r: number, c: number): string => colName(c) + (r + 1);
const num = (s: string): number => (s === 'black' ? 1 : 2);
const other = (s: string): string => (s === 'black' ? 'white' : 'black');
const inb = (r: number, c: number): boolean => r >= 0 && r < N && c >= 0 && c < N;

/** 棋盘：0 空 / 1 黑 / 2 白。 */
type Board = number[][];
interface Pos { r: number; c: number }
/** 一手棋：pass 或落子。 */
interface GoMove extends Move {
  r?: number;
  c?: number;
  pass?: boolean;
}
interface GoState {
  board: Board;
  turn: string;
  captures: { black: number; white: number };
  ko: Pos | null;
  passes: number;
  moveNum: number;
  last: { notation: string; side: string } | null;
  result: GameStatus | null;
}
interface Group { stones: number[][]; libs: Set<string> }

function newGame(): GoState {
  return {
    board: Array.from({ length: N }, () => Array<number>(N).fill(0)),
    turn: 'black', captures: { black: 0, white: 0 },
    ko: null, passes: 0, moveNum: 0, last: null, result: null,
  };
}

function groupOf(board: Board, r: number, c: number): Group {
  const color = board[r]![c];
  const stones: number[][] = [], libs = new Set<string>(), seen: Record<string, boolean> = {};
  const stack: number[][] = [[r, c]];
  seen[r + ',' + c] = true;
  while (stack.length) {
    const [cr, cc] = stack.pop()!;
    stones.push([cr!, cc!]);
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = cr! + dr!, cc2 = cc! + dc!;
      if (!inb(rr, cc2)) continue;
      const v = board[rr]![cc2];
      if (v === 0) libs.add(rr + ',' + cc2);
      else if (v === color && !seen[rr + ',' + cc2]) {
        seen[rr + ',' + cc2] = true;
        stack.push([rr, cc2]);
      }
    }
  }
  return { stones, libs };
}

/* 试下：返回 captured 列表；自杀返回 null */
function tryPlay(board: Board, r: number, c: number, color: string): { board: Board; captured: Pos[] } | null {
  if (board[r]![c] !== 0) return null;
  const b = clone(board);
  b[r]![c] = num(color);
  const opp = color === 'black' ? 2 : 1;
  const captured: Pos[] = [];
  for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const rr = r + dr!, cc = c + dc!;
    if (inb(rr, cc) && b[rr]![cc] === opp) {
      const g = groupOf(b, rr, cc);
      if (g.libs.size === 0) {
        for (const [sr, sc] of g.stones) { b[sr!]![sc!] = 0; captured.push({ r: sr!, c: sc! }); }
      }
    }
  }
  const mine = groupOf(b, r, c);
  if (mine.libs.size === 0) return null; // 自杀
  return { board: b, captured };
}

/** 停一手（围棋特有；supportsPass 为 true）。 */
function passMove(_st: GoState): GoMove {
  return { pass: true, notation: 'pass', desc: 'pass this turn' };
}

function getLegalMoves(st: GoState): GoMove[] {
  if (st.passes >= 2) return [];
  const ms: GoMove[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (st.board[r]![c] !== 0) continue;
      if (st.ko && st.ko.r === r && st.ko.c === c) continue;
      const res = tryPlay(st.board, r, c, st.turn);
      if (!res) continue;
      ms.push({
        notation: notation(r, c), r, c,
        desc: res.captured.length
          ? 'place at ' + notation(r, c) + ', captures ' + res.captured.length
          : 'place at ' + notation(r, c),
      });
    }
  }
  ms.push(passMove(st));
  return ms;
}

function applyMove(st: GoState, move: Move): GoState {
  const mv = move as GoMove;
  const s = clone(st);
  s.ko = null;
  if (mv.pass) {
    s.passes++;
    s.moveNum++;
    s.turn = other(st.turn);
    s.last = { notation: 'pass', side: st.turn };
    return s;
  }
  const res = tryPlay(st.board, mv.r!, mv.c!, st.turn);
  if (!res) return st; // 不应发生（着法来自合法列表）
  s.board = res.board;
  s.captures[st.turn as 'black' | 'white'] += res.captured.length;
  /* 简单劫判定：提一子、落点成单子单气 */
  if (res.captured.length === 1) {
    const g = groupOf(s.board, mv.r!, mv.c!);
    if (g.stones.length === 1 && g.libs.size === 1) s.ko = res.captured[0]!;
  }
  s.passes = 0;
  s.moveNum++;
  s.turn = other(st.turn);
  s.last = { notation: move.notation, side: st.turn };
  return s;
}

/* 数子法：子 + 空（只围一色的空点），白加贴目 */
function score(st: GoState): { black: number; white: number; territory: { black: number; white: number } } {
  const territory = { black: 0, white: 0 };
  const seen: Record<string, boolean> = {};
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (st.board[r]![c] !== 0 || seen[r + ',' + c]) continue;
      const region: number[][] = [], borders = new Set<number>();
      const stack: number[][] = [[r, c]];
      seen[r + ',' + c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop()!;
        region.push([cr!, cc!]);
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = cr! + dr!, cc2 = cc! + dc!;
          if (!inb(rr, cc2)) continue;
          const v = st.board[rr]![cc2]!;
          if (v === 0) {
            if (!seen[rr + ',' + cc2]) { seen[rr + ',' + cc2] = true; stack.push([rr, cc2]); }
          } else borders.add(v);
        }
      }
      if (borders.size === 1) {
        territory[borders.has(1) ? 'black' : 'white'] += region.length;
      }
    }
  }
  let black = 0, white = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (st.board[r]![c] === 1) black++;
    else if (st.board[r]![c] === 2) white++;
  }
  black += territory.black;
  white += territory.white + KOMI;
  return { black, white, territory };
}

function getStatus(st: GoState): GameStatus {
  if (st.result) return st.result;
  if (st.passes >= 2) {
    const sc = score(st);
    return {
      over: true,
      winner: sc.black > sc.white ? 'black' : 'white',
      reason: '数子：黑 ' + sc.black + ' : 白 ' + sc.white + '（贴 5.5）',
    };
  }
  return { over: false, turn: st.turn };
}

function moveFromNotation(st: GoState, n: string): GoMove | null {
  if (n === 'pass') return passMove(st);
  const c = n.charCodeAt(0) - 65, r = parseInt(n.slice(1), 10) - 1;
  return getLegalMoves(st).find((m) => m.r === r && m.c === c) || null;
}

/* ---------- Jev 序列化 ---------- */
const SCORE_LEVELS = ['0-2 clearly losing', '3-4 slightly worse', '5 roughly even', '6-7 slightly better', '8-10 clearly winning'];

function stonesOf(st: GoState, p: number): string[] {
  const out: string[] = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (st.board[r]![c] === p) out.push(notation(r, c));
  }
  return out;
}

function serializeForJev(st: GoState, side: string): JevSerialized {
  const legal = getLegalMoves(st);
  const criteria: Record<string, string | null | undefined> = {};
  legal.forEach((m) => { criteria[m.notation] = m.desc; });
  return {
    state: {
      game: 'go 9x9, columns A-I left to right, rows 1-9 top to bottom, Chinese area scoring, komi 5.5 for white',
      rules: 'Chinese rules: a group with no empty liberty is captured, suicide is illegal, recreating the immediately previous board position (ko) is illegal. Two consecutive passes end the game; area scoring counts stones plus enclosed territory, and white adds 5.5 komi.',
      you_play: side,
      move_number: st.moveNum + 1,
      black_stones: stonesOf(st, 1),
      white_stones: stonesOf(st, 2),
      prisoners: st.captures,
      ko_point_forbidden: st.ko ? notation(st.ko.r, st.ko.c) : null,
      consecutive_passes: st.passes,
      last_move: st.last ? st.last.side + ' ' + st.last.notation : 'none (opening)',
      legal_moves: legal.map((m) => m.notation),
    },
    questions: {
      move: {
        type: 'choice',
        instructions:
          'You are an expert go player playing ' + side + ' on a 9x9 board. ' +
          'Stones with no adjacent empty point (liberty) are captured; suicide is illegal; the ko point is forbidden this turn; "pass" ends your turn, and two consecutive passes end the game. ' +
          'Pick the best move from `legal_moves`: take corners and edges early, capture weak groups, keep your groups connected with liberties, attack the opponent\'s cutting points, and choose "pass" only when no valuable move remains. ' +
          'Answer ONLY with the Choice question "move".',
        criteria,
      },
      edge: {
        type: 'noul',
        instructions: 'After the best move for ' + side + ', is ' + side + ' winning this game?',
        criteria: { true: side + ' is ahead', false: 'even or behind' },
      },
      position: {
        type: 'score',
        instructions: 'Rate the position for ' + side + ' after the best move, on a 0-10 scale.',
        criteria: SCORE_LEVELS,
      },
    },
    options: legal.map((m) => m.notation),
  };
}

/* ---------- 渲染与交互 ---------- */
function draw(ctx: Canvas2D, st: GoState, ui: UiState): void {
  gfx.clear(ctx, W, H);
  gfx.intersections(ctx, MARGIN, MARGIN, CELL, N, N);
  [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]].forEach(([r, c]) => {
    gfx.disc(ctx, MARGIN + c! * CELL, MARGIN + r! * CELL, 3.4, '#3A4048');
  });
  if (st.ko) {
    ctx.strokeStyle = 'rgba(194,64,42,.6)';
    ctx.beginPath();
    ctx.rect(MARGIN + st.ko.c * CELL - 8, MARGIN + st.ko.r * CELL - 8, 16, 16);
    ctx.stroke();
  }
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = st.board[r]![c];
      if (v) {
        gfx.stone(ctx, MARGIN + c * CELL, MARGIN + r * CELL, CELL * 0.46,
          v === 1 ? 'black' : 'white',
          !!st.last && st.last.notation === notation(r, c));
      }
    }
  }
  for (let c = 0; c < N; c++) gfx.text(ctx, colName(c), MARGIN + c * CELL, 12, { size: 10 });
  for (let r = 0; r < N; r++) gfx.text(ctx, String(r + 1), 12, MARGIN + r * CELL, { size: 10 });
}

function xyToCell(x: number, y: number): Pos | null {
  const c = Math.round((x - MARGIN) / CELL), r = Math.round((y - MARGIN) / CELL);
  if (!inb(r, c)) return null;
  if (Math.abs(x - (MARGIN + c * CELL)) > CELL * 0.47) return null;
  if (Math.abs(y - (MARGIN + r * CELL)) > CELL * 0.47) return null;
  return { r, c };
}

function humanClick(st: GoState, ui: UiState, x: number, y: number): Move | null {
  const cell = xyToCell(x, y);
  if (!cell || st.board[cell.r]![cell.c] !== 0) return null;
  const legal = getLegalMoves(st).find((m) => m.r === cell.r && m.c === cell.c);
  return legal || null; // 自杀/劫点点击无效
}

/* ---------- mock 启发式 ----------
 * 提子与安全度（落子后己群气数）为主，中腹加成；
 * 终盘（80 手后）递增倾向 pass，避免演示模式双方无限提子循环。 */
function mockPick(st: GoState, moves: Move[], _side?: string, _cfg?: PickConfig): Move | null {
  if (st.moveNum > 80 && rnd() < Math.min(0.85, (st.moveNum - 80) * 0.05)) {
    return passMove(st);
  }
  let best: Move | null = null, bestScore = -1e9;
  for (const m of moves) {
    const mv = m as GoMove;
    if (mv.pass) continue;
    const ns = applyMove(st, mv);
    const g = groupOf(ns.board, mv.r!, mv.c!);
    let sc = ((mv.desc || '').indexOf('captures') >= 0 ? 10 : 0) + rnd() * 2;
    sc += g.libs.size >= 2 ? 3 : g.libs.size === 1 ? -8 : -30;
    sc -= (Math.abs(mv.r! - 4) + Math.abs(mv.c! - 4)) * 0.15;
    if (sc > bestScore) { bestScore = sc; best = m; }
  }
  return best || passMove(st);
}

/* ---------- 自检 ---------- */
function selfTest(): void {
  let st = newGame();
  /* 提子 */
  st = applyMove(st, moveFromNotation(st, 'B1')!);
  st = applyMove(st, moveFromNotation(st, 'A1')!);
  st = applyMove(st, moveFromNotation(st, 'A2')!);
  assert(st.board[0]![0] === 0, '白 A1 被提');
  assert(st.captures.black === 1, '黑提一子');
  /* 禁自杀 */
  st = applyMove(st, moveFromNotation(st, 'B2')!);
  st = applyMove(st, moveFromNotation(st, 'pass')!);
  assert(!moveFromNotation(st, 'A1'), 'A1 自杀非法');
  /* 劫：经典劫形
   * 行1: . B W .    行2: B W . W    行3: . B W .   （黑下 C2 提白 B2，成劫） */
  let s4 = newGame();
  const koBoard: Board = Array.from({ length: N }, () => Array<number>(N).fill(0));
  koBoard[0]![1] = 1; koBoard[1]![0] = 1; koBoard[2]![1] = 1;                  // 黑
  koBoard[0]![2] = 2; koBoard[1]![1] = 2; koBoard[1]![3] = 2; koBoard[2]![2] = 2; // 白
  s4.board = koBoard;
  s4.turn = 'black';
  const cap = moveFromNotation(s4, 'C2');
  assert(cap, '劫形黑可下 C2');
  if (cap) {    const s5 = applyMove(s4, cap);
    assert(s5.board[1]![1] === 0, '白 B2 一子被提');
    assert(s5.ko && s5.ko.r === 1 && s5.ko.c === 1, '劫点 = B2');
    assert(!moveFromNotation(s5, 'B2'), '白不能立即回提劫点');
  }
  /* 双 pass 终局 */
  let s6 = newGame();
  s6 = applyMove(s6, moveFromNotation(s6, 'pass')!);
  s6 = applyMove(s6, moveFromNotation(s6, 'pass')!);
  const g6 = getStatus(s6);
  assert(g6.over && g6.winner === 'white', '空盘双 pass 白胜贴目');
}

/** 围棋引擎（旧 id: 'go'）。 */
export const go: Engine<GoState> = {
  id: 'go', name: '围 棋',
  sides: [{ id: 'black', name: '黑方', first: true }, { id: 'white', name: '白方' }],
  meta: { w: W, h: H }, supportsPass: true, supportsResign: true,
  newGame, getLegalMoves, applyMove, getStatus, moveFromNotation, passMove,
  serializeForJev, draw, humanClick, mockPick, selfTest,
} as Engine<GoState>;
