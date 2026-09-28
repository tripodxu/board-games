'use strict';
/* 中国跳棋（双人）六角星盘 121 格。
 * 行 0–16，行宽 1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1；格坐标 (r,x)。
 * 邻接：同行 x±2，邻行 x±1。可走 6 方向一步，或跳过相邻棋子（可连跳），无吃子。
 * 己方 10 子全部进入对面营地获胜；棋子离开本方营地后不得再进入（防止赖着堵门）。 */
(function () {
  const XU = 22, YU = 26, MARGIN = 30;
  const W = MARGIN * 2 + 24 * XU, H = MARGIN * 2 + 16 * YU;
  const TOP_CAMP = [], BOT_CAMP = [];
  for (let r = 0; r <= 3; r++) for (const x of campXs(r)) TOP_CAMP.push({ r, x });
  for (let r = 13; r <= 16; r++) for (const x of campXs(r)) BOT_CAMP.push({ r, x });

  function campXs(r) {
    const d = Math.min(r, 16 - r, 3); // 营地行内偏移
    const base = 12;
    const xs = [];
    for (let i = 0; i <= d; i++) xs.push(base - d + 2 * i);
    return xs;
  }

  function rowXs(r) {
    if (r <= 3) return campXs(r);
    if (r >= 13) return campXs(r);
    const len = [13, 12, 11, 10, 9, 10, 11, 12, 13][r - 4];
    const start = 12 - (len - 1); // 中间行与营地行保持奇偶交错
    const xs = [];
    for (let i = 0; i < len; i++) xs.push(start + 2 * i);
    return xs;
  }

  const EXISTS = {};
  for (let r = 0; r <= 16; r++) for (const x of rowXs(r)) EXISTS[r + ',' + x] = true;
  const exists = (r, x) => !!EXISTS[r + ',' + x];
  const key = (r, x) => r + ',' + x;
  const DIRS = [[0, -2], [0, 2], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  const other = (s) => (s === 'bottom' ? 'top' : 'bottom');
  const homeCamp = (s) => (s === 'top' ? TOP_CAMP : BOT_CAMP);
  const targetCamp = (s) => (s === 'top' ? BOT_CAMP : TOP_CAMP);

  function newGame() {
    const cells = [];
    for (let r = 0; r <= 16; r++) {
      cells.push(Array(25).fill(null));
      for (const x of rowXs(r)) cells[r][x] = 0;
    }
    for (const { r, x } of TOP_CAMP) cells[r][x] = 'top';
    for (const { r, x } of BOT_CAMP) cells[r][x] = 'bottom';
    return { cells, turn: 'bottom', moveNum: 0, last: null, result: null };
  }

  function marblesOf(st, s) {
    const out = [];
    for (let r = 0; r <= 16; r++) for (let x = 0; x <= 24; x++) {
      if (st.cells[r][x] === s) out.push({ r, x });
    }
    return out;
  }

  const inOwnCamp = (s, r, x) => homeCamp(s).some((c) => c.r === r && c.x === x);

  /* 单颗棋子的全部落点（步 + 连跳终点去重） */
  function destsFor(st, from) {
    const s = st.cells[from.r][from.x];
    const out = [];
    const seen = {};
    const tryPush = (r, x, jump) => {
      if (!exists(r, x) || st.cells[r][x] !== 0) return;
      /* 离开本方营地后不得再进入 */
      if (inOwnCamp(s, r, x) && !inOwnCamp(s, from.r, from.x)) return;
      const k = key(r, x);
      if (seen[k]) return;
      seen[k] = true;
      out.push({ r, x, jump });
    };
    for (const [dr, dx] of DIRS) {
      const r1 = from.r + dr, x1 = from.x + dx;
      if (exists(r1, x1) && st.cells[r1][x1] === 0) tryPush(r1, x1, false);
    }
    /* 连跳 BFS */
    const queue = [from];
    const jumpedFrom = {};
    jumpedFrom[key(from.r, from.x)] = true;
    while (queue.length) {
      const cur = queue.shift();
      for (const [dr, dx] of DIRS) {
        const ro = cur.r + dr, xo = cur.x + dx, rl = cur.r + 2 * dr, xl = cur.x + 2 * dx;
        if (!exists(ro, xo) || st.cells[ro][xo] === 0 || st.cells[ro][xo] === null) continue;
        if (!exists(rl, xl) || st.cells[rl][xl] !== 0) continue;
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

  function getLegalMoves(st) {
    const ms = [];
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

  function applyMove(st, move) {
    const s = BG.util.clone(st);
    s.cells[move.from.r][move.from.x] = 0;
    s.cells[move.to.r][move.to.x] = st.turn;
    s.moveNum++;
    s.turn = other(st.turn);
    s.last = { notation: move.notation, side: st.turn };
    return s;
  }

  function getStatus(st) {
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

  function moveFromNotation(st, n) {
    return getLegalMoves(st).find((m) => m.notation === n) || null;
  }

  /* ---------- Jev 序列化 ---------- */
  const SCORE_LEVELS = ['0-2 far behind', '3-4 behind', '5 close race', '6-7 ahead', '8-10 far ahead'];

  function serializeForJev(st, side) {
    const legal = getLegalMoves(st);
    const criteria = {};
    legal.forEach((m) => { criteria[m.notation] = m.desc; });
    const cn = side === 'bottom' ? 'bottom (starts, goal: top camp rows 0-3)' : 'top (goal: bottom camp rows 13-16)';
    const marbles = (s) => marblesOf(st, s).map((m) => 'r' + m.r + 'x' + m.x);
    /* 选项过多时优先跳跃类 */
    let opts = legal;
    if (legal.length > 255) {
      opts = legal.filter((m) => m.to.jump).slice(0, 255);
    }
    const crit2 = {};
    opts.forEach((m) => { crit2[m.notation] = m.desc; });
    return {
      state: {
        game: 'Chinese checkers, 2 players, hex star board with rows 0-16, cell named r{row}x{x}',
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
  function draw(ctx, st, ui) {
    BG.gfx.clear(ctx, W, H, '#FAFBFD');
    for (let r = 0; r <= 16; r++) {
      for (let x = 0; x <= 24; x++) {
        if (!exists(r, x)) continue;
        const px = MARGIN + x * XU, py = MARGIN + r * YU;
        const inTop = TOP_CAMP.some((c) => c.r === r && c.x === x);
        const inBot = BOT_CAMP.some((c) => c.r === r && c.x === x);
        BG.gfx.disc(ctx, px, py, 8.5,
          inTop ? 'rgba(194,64,42,.10)' : inBot ? 'rgba(31,36,44,.08)' : '#E9EDF2',
          '#C6CDD4');
        const v = st.cells[r][x];
        if (v === 'top' || v === 'bottom') {
          const isBottom = v === 'bottom';
          BG.gfx.disc(ctx, px, py, 8, isBottom ? '#22262C' : '#C2402A', '#0E111633', '',
            '#fff');
        }
      }
    }
    if (st.last) {
      const m = st.last.notation;
      const parse = (t) => { const a = t.replace('r', '').split('x'); return { r: +a[0], x: +a[1] }; };
      const [f, t] = m.split('>').map(parse);
      BG.gfx.highlight(ctx, MARGIN + f.x * XU, MARGIN + f.r * YU, 10, 'rgba(31,36,44,.65)');
      BG.gfx.highlight(ctx, MARGIN + t.x * XU, MARGIN + t.r * YU, 10, 'rgba(194,64,42,.9)');
    }
    if (ui.sel) {
      BG.gfx.highlight(ctx, MARGIN + ui.sel.x * XU, MARGIN + ui.sel.r * YU, 11, '#1F242C');
      for (const d of destsFor(st, ui.sel)) {
        BG.gfx.highlight(ctx, MARGIN + d.x * XU, MARGIN + d.r * YU, 6, 'rgba(31,36,44,.45)');
      }
    }
  }

  function xyToCell(x, y) {
    const cx = Math.round((x - MARGIN) / XU), cy = Math.round((y - MARGIN) / YU);
    if (!exists(cy, cx)) return null;
    if (Math.abs(x - (MARGIN + cx * XU)) > XU * 0.55) return null;
    if (Math.abs(y - (MARGIN + cy * YU)) > YU * 0.55) return null;
    return { r: cy, x: cx };
  }

  function humanClick(st, ui, x, y) {
    const cell = xyToCell(x, y);
    if (!cell) return null;
    const v = st.cells[cell.r][cell.x];
    if (v === st.turn) { ui.sel = cell; return null; }
    if (ui.sel) {
      const mv = getLegalMoves(st).find((m) => m.from.r === ui.sel.r && m.from.x === ui.sel.x &&
        m.to.r === cell.r && m.to.x === cell.x);
      if (mv) { ui.sel = null; return mv; }
    }
    ui.sel = null;
    return null;
  }

  /* ---------- mock 启发式 ----------
   * 以前进量（朝对面营地的行进差）为主，连跳加成，落后棋子优先，
   * 轻微向中线聚拢；六角格斜走不改变曼哈顿距离，故不用它。 */
  function mockPick(st, moves, side) {
    const fwdSign = side === 'bottom' ? 1 : -1; // bottom 前进 = r 减小，top 前进 = r 增大
    const rearBonus = (m) => (side === 'bottom' ? m.from.r : 16 - m.from.r) * 0.1;
    const inTarget = (m) => targetCamp(side).some((c) => c.r === m.r && c.x === m.x);
    let best = null, bestScore = -1e9;
    for (const m of moves) {
      const fwd = (m.from.r - m.to.r) * fwdSign;
      /* 已入营的棋子别再倒腾，把路让给营外的落后棋子 */
      const sc = fwd * 10 + (m.to.jump ? 3 : 0) + (inTarget(m.to) ? 6 : 0) +
        rearBonus(m) - Math.abs(m.to.x - 12) * 0.05 + BG.util.rnd() -
        (inTarget(m.from) ? 25 : 0);
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    return best;
  }

  /* ---------- 自检 ---------- */
  function selfTest() {
    const st = newGame();
    BG.util.assert(marblesOf(st, 'top').length === 10 && marblesOf(st, 'bottom').length === 10, '双方各 10 子');
    const legal = getLegalMoves(st);
    BG.util.assert(legal.length > 0, '开局有着法');
    BG.util.assert(legal.every((m) => st.cells[m.to.r][m.to.x] === 0), '落点全为空');
    /* 连跳链 r8x4 → r6x2 → r4x0 */
    let s2 = newGame();
    for (let r = 0; r <= 16; r++) for (let x = 0; x <= 24; x++) if (s2.cells[r][x] !== null) s2.cells[r][x] = 0;
    s2.cells[8][4] = 'bottom'; s2.cells[7][3] = 'top'; s2.cells[5][1] = 'top';
    const chain = getLegalMoves(s2).find((m) => m.notation === 'r8x4>r4x0');
    BG.util.assert(chain && chain.to.jump, '连跳链 r8x4>r4x0');
    /* 离开营地后不得返回 */
    let s3 = newGame();
    for (let r = 0; r <= 16; r++) for (let x = 0; x <= 24; x++) if (s3.cells[r][x] !== null) s3.cells[r][x] = 0;
    s3.cells[12][10] = 'bottom'; // 营地外
    BG.util.assert(!getLegalMoves(s3).some((m) => m.from.r === 12 && m.from.x === 10 &&
      inOwnCamp('bottom', m.to.r, m.to.x)), '不得返回本方营地');
    /* 获胜判定 */
    let s4 = newGame();
    for (let r = 0; r <= 16; r++) for (let x = 0; x <= 24; x++) if (s4.cells[r][x] !== null) s4.cells[r][x] = 0;
    for (const { r, x } of TOP_CAMP) s4.cells[r][x] = 'bottom';
    const g = getStatus(s4);
    BG.util.assert(g.over && g.winner === 'bottom', '全员抵达判胜');
  }

  BG.register({
    id: 'cc', name: '中国跳棋',
    sides: [{ id: 'bottom', name: '下方（先手）', first: true }, { id: 'top', name: '上方' }],
    meta: { w: W, h: H }, supportsPass: false, supportsResign: true,
    newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
    serializeForJev, draw, humanClick, mockPick, selfTest,
  });
})();
