'use strict';
/* 五子棋 15×15。坐标：列 A–O（左→右），行 1–15（上→下），记法如 H8。 */
(function () {
  const N = 15;
  const num = (side) => (side === 'black' ? 1 : 2);
  const colName = (c) => String.fromCharCode(65 + c);
  const notation = (r, c) => colName(c) + (r + 1);
  const parseN = (n) => ({ r: parseInt(n.slice(1), 10) - 1, c: n.charCodeAt(0) - 65 });

  function newGame() {
    return {
      board: Array.from({ length: N }, () => Array(N).fill(0)),
      turn: 'black', moveNum: 0, last: null, result: null,
    };
  }

  function lineLen(st, r, c, dr, dc) {
    const p = st.board[r][c];
    let n = 1;
    for (let i = 1; i < 5; i++) {
      const rr = r + dr * i, cc = c + dc * i;
      if (rr < 0 || rr >= N || cc < 0 || cc >= N || st.board[rr][cc] !== p) break;
      n++;
    }
    for (let i = 1; i < 5; i++) {
      const rr = r - dr * i, cc = c - dc * i;
      if (rr < 0 || rr >= N || cc < 0 || cc >= N || st.board[rr][cc] !== p) break;
      n++;
    }
    return n;
  }

  function getLegalMoves(st) {
    const ms = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (st.board[r][c] === 0) ms.push({ notation: notation(r, c), desc: null, r, c });
      }
    }
    return ms;
  }

  /* Jev 候选：与任意棋子切比雪夫距离 ≤2 的空点（控制 token），无子时取天元附近 */
  function candidates(st, cap) {
    cap = cap || 64;
    const empty = getLegalMoves(st);
    if (st.moveNum === 0) return [empty.find((m) => m.r === 7 && m.c === 7)];
    const near = [];
    for (const m of empty) {
      let ok = false;
      for (let dr = -2; dr <= 2 && !ok; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const rr = m.r + dr, cc = m.c + dc;
          if (rr >= 0 && rr < N && cc >= 0 && cc < N && st.board[rr][cc] !== 0) { ok = true; break; }
        }
      }
      if (ok) near.push(m);
    }
    if (near.length > cap) {
      near.sort((a, b) =>
        (Math.abs(a.r - 7) + Math.abs(a.c - 7)) - (Math.abs(b.r - 7) + Math.abs(b.c - 7)));
      near.length = cap;
    }
    return near;
  }

  function applyMove(st, move) {
    const s = BG.util.clone(st);
    const p = num(st.turn);
    s.board[move.r][move.c] = p;
    s.moveNum++;
    s.last = { notation: move.notation, r: move.r, c: move.c, side: st.turn };
    s.turn = st.turn === 'black' ? 'white' : 'black';
    return s;
  }

  function getStatus(st) {
    if (st.result) return st.result;
    if (st.last) {
      const { r, c } = st.last;
      const p = st.board[r][c];
      const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
      for (const [dr, dc] of dirs) {
        if (lineLen(st, r, c, dr, dc) >= 5) {
          return { over: true, winner: p === 1 ? 'black' : 'white', reason: '五连' };
        }
      }
    }
    if (st.moveNum >= N * N) return { over: true, winner: null, reason: '棋盘已满' };
    return { over: false, turn: st.turn };
  }

  function moveFromNotation(st, n) {
    const { r, c } = parseN(n);
    if (r < 0 || r >= N || c < 0 || c >= N || st.board[r][c] !== 0) return null;
    return { notation: n, desc: null, r, c };
  }

  /* ---------- Jev 序列化 ---------- */
  const SCORE_LEVELS = ['0-2 clearly losing', '3-4 slightly worse', '5 roughly even', '6-7 slightly better', '8-10 clearly winning'];

  function stonesOf(st, p) {
    const out = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) if (st.board[r][c] === p) out.push(notation(r, c));
    }
    return out;
  }

  /* 板斧一：ASCII 棋盘，裁剪到有子区域外扩 2 格（盘面贴边时收敛到边界）。
   * 大写 X/O 为常规棋子，小写标记 last_move；空盘时裁剪到天元附近 5×5。 */
  function boardAscii(st) {
    let r0 = N, r1 = -1, c0 = N, c1 = -1, any = false;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (st.board[r][c]) {
        any = true;
        if (r < r0) r0 = r; if (r > r1) r1 = r;
        if (c < c0) c0 = c; if (c > c1) c1 = c;
      }
    }
    if (!any) { r0 = r1 = 7; c0 = c1 = 7; }
    r0 = Math.max(0, r0 - 2); r1 = Math.min(N - 1, r1 + 2);
    c0 = Math.max(0, c0 - 2); c1 = Math.min(N - 1, c1 + 2);
    const lines = ['    ' + Array.from({ length: c1 - c0 + 1 }, (_, i) => String.fromCharCode(65 + c0 + i)).join(' ')];
    for (let r = r0; r <= r1; r++) {
      let line = String(r + 1).padStart(2) + '  ';
      for (let c = c0; c <= c1; c++) {
        const p = st.board[r][c];
        let ch = p === 1 ? 'X' : p === 2 ? 'O' : '.';
        if (st.last && st.last.r === r && st.last.c === c) ch = ch.toLowerCase();
        line += ch + (c < c1 ? ' ' : '');
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  function serializeForJev(st, side) {
    const cand = candidates(st, 64);
    const notations = cand.map((m) => m.notation);
    const criteria = {};
    notations.forEach((n) => { criteria[n] = null; });
    return {
      state: {
        game: 'gomoku (five-in-a-row) on 15x15 board, columns A-O left to right, rows 1-15 top to bottom',
        rules: 'Free-style gomoku, no forbidden moves: first to align five or more of their own stones horizontally, vertically or diagonally wins; a full board is a draw.',
        /* 板斧一：模型读二维字符画远比读坐标列表准；裁剪到有子区域外扩 2 格省 token */
        board_ascii: boardAscii(st),
        board_note: 'X = black stones, O = white stones, a lowercase letter marks the last move, "." is empty; the grid is cropped to the active area with a 2-cell margin. Column letters on top, row numbers on the left.',
        you_play: side,
        move_number: st.moveNum + 1,
        black_stones: stonesOf(st, 1),
        white_stones: stonesOf(st, 2),
        last_move: st.last ? st.last.side + ' ' + st.last.notation : 'none (opening)',
        legal_moves: notations,
      },
      questions: {
        move: {
          type: 'choice',
          instructions:
            'You are an expert gomoku player playing ' + side + '. Points are named like H8 (column letter + row number). ' +
            'Read `board_ascii` as the actual board (X = black, O = white, lowercase = last move). ' +
            /* 板斧二+四：刚性扫描清单 + 防幻觉核对，替代"多制造威胁"式空话；板斧三 fallback：analysis 文本问不被 API 支持（实测 400），扫描流程只能内化到指令 */
            'Before answering, run this scan in order and verify every claim cell by cell against `board_ascii` and the stone lists: ' +
            '(1) points completing five in a row for you — if any exists, you MUST play one; ' +
            '(2) points completing five in a row for the opponent — if any exists and you cannot win immediately, you MUST play one; ' +
            '(3) your open threes and fours, and their strongest extension points; ' +
            '(4) the opponent\'s open threes, and the blocking points; ' +
            '(5) prefer points that create multiple threats at once or combine attack with defense. ' +
            'Never claim a line you cannot name every cell of; discard any candidate that does not survive verification. ' +
            'Pick the best point from `legal_moves`. ' +
            'Answer ONLY with the Choice question "move".',
          criteria,
        },
        edge: {
          type: 'noul',
          instructions: 'After the best move for ' + side + ', is ' + side + ' better than the opponent in this position?',
          criteria: { true: side + ' has the advantage', false: 'equal or opponent better' },
        },
        position: {
          type: 'score',
          instructions: 'Rate the position for ' + side + ' after the best move, on a 0-10 scale.',
          criteria: SCORE_LEVELS,
        },
      },
      options: notations,
    };
  }

  /* ---------- 渲染与交互 ---------- */
  const CELL = 36, MARGIN = 28, W = MARGIN * 2 + (N - 1) * CELL, H = W;

  function draw(ctx, st, ui) {
    BG.gfx.clear(ctx, W, H);
    BG.gfx.intersections(ctx, MARGIN, MARGIN, CELL, N, N);
    /* 星位 */
    [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]].forEach(([r, c]) => {
      BG.gfx.disc(ctx, MARGIN + c * CELL, MARGIN + r * CELL, 3.2, '#3A4048');
    });
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const p = st.board[r][c];
        if (p) {
          BG.gfx.stone(ctx, MARGIN + c * CELL, MARGIN + r * CELL, CELL * 0.44,
            p === 1 ? 'black' : 'white', st.last && st.last.r === r && st.last.c === c);
        }
      }
    }
    for (let c = 0; c < N; c++) BG.gfx.text(ctx, colName(c), MARGIN + c * CELL, 12, { size: 10 });
    for (let r = 0; r < N; r++) BG.gfx.text(ctx, String(r + 1), 12, MARGIN + r * CELL, { size: 10 });
  }

  function xyToCell(x, y) {
    const c = Math.round((x - MARGIN) / CELL), r = Math.round((y - MARGIN) / CELL);
    if (r < 0 || r >= N || c < 0 || c >= N) return null;
    if (Math.abs(x - (MARGIN + c * CELL)) > CELL * 0.47) return null;
    if (Math.abs(y - (MARGIN + r * CELL)) > CELL * 0.47) return null;
    return { r, c };
  }

  function humanClick(st, ui, x, y) {
    const cell = xyToCell(x, y);
    if (!cell || st.board[cell.r][cell.c] !== 0) return null;
    return { notation: notation(cell.r, cell.c), desc: null, r: cell.r, c: cell.c };
  }

  /* ---------- mock 启发式 ---------- */
  function wouldWin(st, m, side) {
    const s = BG.util.clone(st);
    s.board[m.r][m.c] = num(side);
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    return dirs.some(([dr, dc]) => lineLen(s, m.r, m.c, dr, dc) >= 5);
  }

  function mockPick(st, moves, side) {
    const opp = side === 'black' ? 'white' : 'black';
    let m = moves.find((mv) => wouldWin(st, mv, side));
    if (m) return m;
    m = moves.find((mv) => wouldWin(st, mv, opp));
    if (m) return m;
    const scored = moves.map((mv) => ({
      mv,
      s: -(Math.abs(mv.r - 7) + Math.abs(mv.c - 7)) + BG.util.rnd() * 3,
    })).sort((a, b) => b.s - a.s);
    return scored[0].mv;
  }

  /* ---------- 自检 ---------- */
  function selfTest() {
    let st = newGame();
    BG.util.assert(getLegalMoves(st).length === 225, '初始 225 个空点');
    const seqBlack = [[7, 6], [7, 7], [7, 8], [7, 9]];
    const seqWhite = [[8, 6], [8, 7], [8, 8], [8, 9]];
    for (let i = 0; i < 4; i++) {
      st = applyMove(st, { notation: notation(...seqBlack[i]), r: seqBlack[i][0], c: seqBlack[i][1] });
      st = applyMove(st, { notation: notation(...seqWhite[i]), r: seqWhite[i][0], c: seqWhite[i][1] });
    }
    BG.util.assert(getStatus(st).over === false, '四连未结束');
    st = applyMove(st, { notation: 'K8', r: 7, c: 10 });
    const res = getStatus(st);
    BG.util.assert(res.over && res.winner === 'black', '黑棋五连获胜');
    BG.util.assert(candidates(st, 64).length <= 64, '候选 ≤64');
    BG.util.assert(!moveFromNotation(st, 'H8'), '已占点不可再走');
    BG.util.assert(moveFromNotation(newGame(), 'H8') !== null, 'H8 合法');
  }

  BG.register({
    id: 'gomoku', name: '五子棋',
    sides: [{ id: 'black', name: '黑方', first: true }, { id: 'white', name: '白方' }],
    meta: { w: W, h: H }, supportsPass: false, supportsResign: true,
    newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
    serializeForJev, draw, humanClick, mockPick, selfTest,
  });
})();
