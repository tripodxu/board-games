/* chinese-checkers.ts — 中国跳棋（双人）六角星盘 121 格（迁移自 js/games/chinese-checkers.js）
 *
 * 行 0–16，行宽 1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1；格坐标 (r,x)。
 * 邻接：同行 x±2，邻行 x±1。可走 6 方向一步，或跳过相邻棋子（可连跳），无吃子。
 * 己方 10 子全部进入对面营地获胜；棋子离开本方营地后不得再进入（防止赖着堵门）。
 */
import { assert } from '../assert.ts';
import { clone } from '../clone.ts';
import { rnd } from '../rng.ts';
import { gfx } from '../gfx.ts';
import type { Canvas2D } from '../gfx.ts';
import type { Engine, GameStatus, JevSerialized, Move, PickConfig, UiState } from '../types.ts';

const XU = 22, YU = 26, MARGIN = 30;
const W = MARGIN * 2 + 24 * XU, H = MARGIN * 2 + 16 * YU;

/** 营地内某一行的 x 坐标集合（行内偏移 d）。 */
function campXs(r: number): number[] {
  const d = Math.min(r, 16 - r, 3); // 营地行内偏移
  const base = 12;
  const xs: number[] = [];
  for (let i = 0; i <= d; i++) xs.push(base - d + 2 * i);
  return xs;
}

/** 棋盘某一行的全部 x 坐标（营地行窄、中间行宽）。 */
function rowXs(r: number): number[] {
  if (r <= 3) return campXs(r);
  if (r >= 13) return campXs(r);
  const len = [13, 12, 11, 10, 9, 10, 11, 12, 13][r - 4]!;
  const start = 12 - (len - 1); // 中间行与营地行保持奇偶交错
  const xs: number[] = [];
  for (let i = 0; i < len; i++) xs.push(start + 2 * i);
  return xs;
}

const TOP_CAMP: Cell[] = [], BOT_CAMP: Cell[] = [];
for (let r = 0; r <= 3; r++) for (const x of campXs(r)) TOP_CAMP.push({ r, x });
for (let r = 13; r <= 16; r++) for (const x of campXs(r)) BOT_CAMP.push({ r, x });

/** 一格（r,x）。 */
interface Cell { r: number; x: number }
/** 一个可达落点：jump 标记该落点是否为连跳终点。 */
interface Dest extends Cell { jump: boolean }
/** 格子内容：0 空 / 'top' / 'bottom' / null 盘外。 */
type Val = number | string | null;
/** 一手棋：from → to。 */
interface CcMove extends Move {
  from: Cell;
  to: Dest;
}
interface CcState {
  cells: Val[][];
  turn: string;
  moveNum: number;
  last: { notation: string; side: string } | null;
  result: GameStatus | null;
}

const EXISTS: Record<string, boolean> = {};
for (let r = 0; r <= 16; r++) for (const x of rowXs(r)) EXISTS[r + ',' + x] = true;
const exists = (r: number, x: number): boolean => !!EXISTS[r + ',' + x];
const key = (r: number, x: number): string => r + ',' + x;
const DIRS: number[][] = [[0, -2], [0, 2], [-1, -1], [-1, 1], [1, -1], [1, 1]];
const other = (s: string): string => (s === 'bottom' ? 'top' : 'bottom');
const homeCamp = (s: string): Cell[] => (s === 'top' ? TOP_CAMP : BOT_CAMP);
const targetCamp = (s: string): Cell[] => (s === 'top' ? BOT_CAMP : TOP_CAMP);

function newGame(): CcState {
  const cells: Val[][] = [];
  for (let r = 0; r <= 16; r++) {
    cells.push(Array<Val>(25).fill(null));
    for (const x of rowXs(r)) cells[r]![x] = 0;
  }
  for (const { r, x } of TOP_CAMP) cells[r]![x] = 'top';
  for (const { r, x } of BOT_CAMP) cells[r]![x] = 'bottom';
  return { cells, turn: 'bottom', moveNum: 0, last: null, result: null };
}

function marblesOf(st: CcState, s: string): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r <= 16; r++) for (let x = 0; x <= 24; x++) {
    if (st.cells[r]![x] === s) out.push({ r, x });
  }
  return out;
}

const inOwnCamp = (s: string, r: number, x: number): boolean => homeCamp(s).some((c) => c.r === r && c.x === x);

/* 单颗棋子的全部落点（步 + 连跳终点去重） */
function destsFor(st: CcState, from: Cell): Dest[] {
  const s = st.cells[from.r]![from.x] as string;
  const out: Dest[] = [];
  const seen: Record<string, boolean> = {};
  const tryPush = (r: number, x: number, jump: boolean): void => {
    if (!exists(r, x) || st.cells[r]![x] !== 0) return;
    /* 离开本方营地后不得再进入 */
    if (inOwnCamp(s, r, x) && !inOwnCamp(s, from.r, from.x)) return;
    const k = key(r, x);
    if (seen[k]) return;
    seen[k] = true;
    out.push({ r, x, jump });
  };
  for (const [dr, dx] of DIRS) {
    const r1 = from.r + dr!, x1 = from.x + dx!;
    if (exists(r1, x1) && st.cells[r1]![x1] === 0) tryPush(r1, x1, false);
  }
  /* 连跳 BFS */
  const queue: Cell[] = [from];
  const jumpedFrom: Record<string, boolean> = {};
  jumpedFrom[key(from.r, from.x)] = true;
  while (queue.length) {
    const cur = queue.shift()!;
    for (const [dr, dx] of DIRS) {
      const ro = cur.r + dr!, xo = cur.x + dx!, rl = cur.r + 2 * dr!, xl = cur.x + 2 * dx!;
      if (!exists(ro, xo) || st.cells[ro]![xo] === 0 || st.cells[ro]![xo] === null) continue;
      if (!exists(rl, xl) || st.cells[rl]![xl] !== 0) continue;
      if (inOwnCamp(s, rl, xl) && !inOwnCamp(s, from.r, from.x)) continue;
      const k = key(rl, xl);
      if (jumpedFrom[k]) continue;
      jumpedFrom[k] = true;
      queue.push({ r: rl, x: xl });
      if (!seen[k]) { seen[k] = true; out.push({ r: rl, x: xl, jump: true }); }
    }
  }
  return out;
}

function getLegalMoves(st: CcState): CcMove[] {
  const ms: CcMove[] = [];
  for (const from of marblesOf(st, st.turn)) {
    for (const d of destsFor(st, from)) {
      ms.push({
        notation: 'r' + from.r + 'x' + from.x + '>r' + d.r + 'x' + d.x,
        desc: (d.jump ? 'jump' : 'step') + ' from row ' + from.r + ' x ' + from.x +
          ' to row ' + d.r + ' x ' + d.x,
        from, to: d,
      });
    }
  }
  return ms;
}

function applyMove(st: CcState, move: Move): CcState {
  const mv = move as CcMove;
  const s = clone(st);
  s.cells[mv.from.r]![mv.from.x] = 0;
  s.cells[mv.to.r]![mv.to.x] = st.turn;  s.moveNum++;
  s.turn = other(st.turn);
  s.last = { notation: move.notation, side: st.turn };
  return s;
}

function getStatus(st: CcState): GameStatus {
  if (st.result) return st.result;
  for (const side of ['bottom', 'top']) {
    const ms = marblesOf(st, side);
    if (ms.every((m) => targetCamp(side).some((c) => c.r === m.r && c.x === m.x))) {
      return { over: true, winner: side, reason: '全员抵达对面营地' };
    }
  }
  /* 机机对弈兜底：超长未分胜负判和（中国跳棋无天然和棋规则） */
  if (st.moveNum >= 400) {
    return { over: true, winner: null, reason: '步数上限（判和）' };
  }
  if (getLegalMoves(st).length === 0) {
    return { over: true, winner: other(st.turn), reason: '无着可走' };
  }
  return { over: false, turn: st.turn };
}

function moveFromNotation(st: CcState, n: string): CcMove | null {
  return getLegalMoves(st).find((m) => m.notation === n) || null;
}

/* ---------- Jev 序列化 ---------- */
const SCORE_LEVELS = ['0-2 far behind', '3-4 behind', '5 close race', '6-7 ahead', '8-10 far ahead'];

function serializeForJev(st: CcState, side: string): JevSerialized {
  const legal = getLegalMoves(st);
  const cn = side === 'bottom' ? 'bottom (starts, goal: top camp rows 0-3)' : 'top (goal: bottom camp rows 13-16)';
  const marbles = (s: string): string[] => marblesOf(st, s).map((m) => 'r' + m.r + 'x' + m.x);
  /* 选项过多时优先跳跃类 */
  let opts = legal;
  if (legal.length > 255) {
    opts = legal.filter((m) => m.to.jump).slice(0, 255);
  }
  const crit2: Record<string, string | null | undefined> = {};
  opts.forEach((m) => { crit2[m.notation] = m.desc; });
  return {
    state: {
      game: 'Chinese checkers, 2 players, hex star board with rows 0-16, cell named r{row}x{x}',
      rules: 'A piece steps to one adjacent empty cell or chain-jumps over adjacent pieces of either color (nothing is ever captured); first to move all their pieces into the opposite camp wins; draws are impossible.',
      you_play: cn,
      move_number: st.moveNum + 1,
      your_marbles: marbles(side),
      opponent_marbles: marbles(other(side)),
      goal: 'move ALL your marbles into the opposite camp; jumps chain and are faster than steps; no captures',
      last_move: st.last ? st.last.side + ' ' + st.last.notation : 'none (opening)',
      legal_moves: opts.map((m) => m.notation),
    },
    questions: {
      move: {
        type: 'choice',
        instructions:
          'You are an expert Chinese checkers player playing ' + cn + '. ' +
          'Marbles move one step to an adjacent empty cell (6 directions) or jump over any adjacent marble into the empty cell directly beyond; jumps may chain. No captures. ' +
          'Pick the best move from `legal_moves`: use long jump chains, keep marbles connected to avoid stragglers, do not move backwards without reason. ' +
          'Answer ONLY with the Choice question "move".',
        criteria: crit2,
      },
      edge: {
        type: 'noul',
        instructions: 'After the best move for your side, are you closer to winning than the opponent?',
        criteria: { true: 'ahead in the race', false: 'even or behind' },
      },
      position: {
        type: 'score',
        instructions: 'Rate your progress after the best move, on a 0-10 scale.',
        criteria: SCORE_LEVELS,
      },
    },
    options: opts.map((m) => m.notation),
  };
}

/* ---------- 渲染与交互 ---------- */
function draw(ctx: Canvas2D, st: CcState, ui: UiState): void {
  gfx.clear(ctx, W, H, '#FAFBFD');
  for (let r = 0; r <= 16; r++) {
    for (let x = 0; x <= 24; x++) {
      if (!exists(r, x)) continue;
      const px = MARGIN + x * XU, py = MARGIN + r * YU;
      const inTop = TOP_CAMP.some((c) => c.r === r && c.x === x);
      const inBot = BOT_CAMP.some((c) => c.r === r && c.x === x);
      gfx.disc(ctx, px, py, 8.5,
        inTop ? 'rgba(194,64,42,.10)' : inBot ? 'rgba(31,36,44,.08)' : '#E9EDF2',
        '#C6CDD4');
      const v = st.cells[r]![x];
      if (v === 'top' || v === 'bottom') {
        const isBottom = v === 'bottom';
        gfx.disc(ctx, px, py, 8, isBottom ? '#22262C' : '#C2402A', '#0E111633', '',
          '#fff');
      }
    }
  }
  if (st.last) {
    const m = st.last.notation;
    const parse = (t: string): Cell => { const a = t.replace('r', '').split('x'); return { r: +a[0]!, x: +a[1]! }; };
    const [f, t] = m.split('>').map(parse);
    gfx.highlight(ctx, MARGIN + f!.x * XU, MARGIN + f!.r * YU, 10, 'rgba(31,36,44,.65)');
    gfx.highlight(ctx, MARGIN + t!.x * XU, MARGIN + t!.r * YU, 10, 'rgba(194,64,42,.9)');
  }
  const sel = ui.sel as Cell | null | undefined;
  if (sel) {
    gfx.highlight(ctx, MARGIN + sel.x * XU, MARGIN + sel.r * YU, 11, '#1F242C');
    for (const d of destsFor(st, sel)) {
      gfx.highlight(ctx, MARGIN + d.x * XU, MARGIN + d.r * YU, 6, 'rgba(31,36,44,.45)');
    }
  }
}

function xyToCell(x: number, y: number): Cell | null {
  const cx = Math.round((x - MARGIN) / XU), cy = Math.round((y - MARGIN) / YU);
  if (!exists(cy, cx)) return null;
  if (Math.abs(x - (MARGIN + cx * XU)) > XU * 0.55) return null;
  if (Math.abs(y - (MARGIN + cy * YU)) > YU * 0.55) return null;
  return { r: cy, x: cx };
}

function humanClick(st: CcState, ui: UiState, x: number, y: number): Move | null {
  const cell = xyToCell(x, y);
  if (!cell) return null;
  const v = st.cells[cell.r]![cell.x];
  if (v === st.turn) { ui.sel = cell; return null; }
  const sel = ui.sel as Cell | null | undefined;
  if (sel) {
    const mv = getLegalMoves(st).find((m) => m.from.r === sel.r && m.from.x === sel.x &&
      m.to.r === cell.r && m.to.x === cell.x);
    if (mv) { ui.sel = null; return mv; }
  }
  ui.sel = null;
  return null;
}

/* ---------- mock 启发式 ----------
 * 以前进量（朝对面营地的行进差）为主，连跳加成，落后棋子优先，
 * 轻微向中线聚拢；六角格斜走不改变曼哈顿距离，故不用它。 */
function mockPick(st: CcState, moves: Move[], side?: string, _cfg?: PickConfig): Move | null {
  const fwdSign = side === 'bottom' ? 1 : -1; // bottom 前进 = r 减小，top 前进 = r 增大
  const rearBonus = (m: CcMove): number => (side === 'bottom' ? m.from.r : 16 - m.from.r) * 0.1;
  const inTarget = (c: Cell): boolean => targetCamp(side!).some((t) => t.r === c.r && t.x === c.x);
  let best: Move | null = null, bestScore = -1e9;
  for (const m of moves) {
    const mv = m as CcMove;
    const fwd = (mv.from.r - mv.to.r) * fwdSign;
    /* 已入营的棋子别再倒腾，把路让给营外的落后棋子 */
    const sc = fwd * 10 + (mv.to.jump ? 3 : 0) + (inTarget(mv.to) ? 6 : 0) +
      rearBonus(mv) - Math.abs(mv.to.x - 12) * 0.05 + rnd() -
      (inTarget(mv.from) ? 25 : 0);
    if (sc > bestScore) { bestScore = sc; best = m; }
  }
  return best;
}

/* ---------- 自检 ---------- */
function selfTest(): void {
  const st = newGame();
  assert(marblesOf(st, 'top').length === 10 && marblesOf(st, 'bottom').length === 10, '双方各 10 子');
  const legal = getLegalMoves(st);
  assert(legal.length > 0, '开局有着法');
  assert(legal.every((m) => st.cells[m.to.r]![m.to.x] === 0), '落点全为空');
  /* 连跳链 r8x4 → r6x2 → r4x0 */
  let s2 = newGame();
  for (let r = 0; r <= 16; r++) for (let x = 0; x <= 24; x++) if (s2.cells[r]![x] !== null) s2.cells[r]![x] = 0;
  s2.cells[8]![4] = 'bottom'; s2.cells[7]![3] = 'top'; s2.cells[5]![1] = 'top';
  const chain = getLegalMoves(s2).find((m) => m.notation === 'r8x4>r4x0');
  assert(chain && chain.to.jump, '连跳链 r8x4>r4x0');
  /* 离开营地后不得返回 */
  let s3 = newGame();
  for (let r = 0; r <= 16; r++) for (let x = 0; x <= 24; x++) if (s3.cells[r]![x] !== null) s3.cells[r]![x] = 0;
  s3.cells[12]![10] = 'bottom'; // 营地外
  assert(!getLegalMoves(s3).some((m) => m.from.r === 12 && m.from.x === 10 &&
    inOwnCamp('bottom', m.to.r, m.to.x)), '不得返回本方营地');
  /* 获胜判定 */
  let s4 = newGame();
  for (let r = 0; r <= 16; r++) for (let x = 0; x <= 24; x++) if (s4.cells[r]![x] !== null) s4.cells[r]![x] = 0;
  for (const { r, x } of TOP_CAMP) s4.cells[r]![x] = 'bottom';
  const g = getStatus(s4);
  assert(g.over && g.winner === 'bottom', '全员抵达判胜');
}

/** 中国跳棋引擎（旧 id: 'cc'）。 */
export const chineseCheckers: Engine<CcState> = {
  id: 'cc', name: '中国跳棋',
  sides: [{ id: 'bottom', name: '下方（先手）', first: true }, { id: 'top', name: '上方' }],
  meta: { w: W, h: H }, supportsPass: false, supportsResign: true,
  newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
  serializeForJev, draw, humanClick, mockPick, selfTest,
} as Engine<CcState>;
