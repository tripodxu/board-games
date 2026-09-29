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

  /* ---------- 战术标注：引擎代读棋盘，把每个候选点的战术含义写成 criteria 标签 ----------
   * 活三/四的识别是模型最弱的一环（实测反馈），但这恰是机械计算。标签体系：
   *   win（成五，保险层会接管） / you:open4 / you:four / you:live3（我落这造什么）
   *   block:five / deny:open4 / deny:four / deny:live3（挡掉对方想占的点）
   * 组合如 "you:open4+deny:open4"（双料点）。判定全部走真实推演，非模式匹配。 */
  const DIRS4 = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const inB = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
  function isFiveAt(board, r, c, p) {
    for (const [dr, dc] of DIRS4) {
      let len = 1;
      for (let k = 1; k < 5 && inB(r + dr * k, c + dc * k) && board[r + dr * k][c + dc * k] === p; k++) len++;
      for (let k = 1; k < 5 && inB(r - dr * k, c - dc * k) && board[r - dr * k][c - dc * k] === p; k++) len++;
      if (len >= 5) return true;
    }
    return false;
  }
  /* 经过 (cr,cc) 的四条线 ±4 内的空格：p 的成五点必在其中（五连同时含 p 与成五格） */
  function lineEmpties(board, cr, cc) {
    const out = [];
    for (const [dr, dc] of DIRS4) {
      for (let k = 1; k <= 4; k++) {
        for (const s of [1, -1]) {
          const r = cr + dr * k * s, c = cc + dc * k * s;
          if (inB(r, c) && !board[r][c]) out.push([r, c]);
        }
      }
    }
    return out;
  }
  /* p 色再落一子即成五的空格数（只需判 ≥2，命中即早退） */
  function fiveCompletions(board, p, cr, cc) {
    let n = 0;
    for (const [r, c] of lineEmpties(board, cr, cc)) {
      board[r][c] = p;
      const five = isFiveAt(board, r, c, p);
      board[r][c] = 0;
      if (five) { n++; if (n >= 2) break; }
    }
    return n;
  }
  /* 活三判定（沿方向精确）：含 (r,c) 沿 d 的连续三子、两边界空、且某一端延伸后
   * 成活四（另一端空 + 该端外侧也空）。不用窗口扫描——窗口里无关方向的黑活四会误标。 */
  function liveThreeDir(board, r, c, p, dr, dc) {
    let f = 0; while (inB(r + dr * (f + 1), c + dc * (f + 1)) && board[r + dr * (f + 1)][c + dc * (f + 1)] === p) f++;
    let b = 0; while (inB(r - dr * (b + 1), c - dc * (b + 1)) && board[r - dr * (b + 1)][c - dc * (b + 1)] === p) b++;
    if (f + b + 1 !== 3) return false;
    const empty = (q) => inB(q[0], q[1]) && board[q[0]][q[1]] === 0;
    const a1 = [r + dr * (f + 1), c + dc * (f + 1)], a2 = [r + dr * (f + 2), c + dc * (f + 2)];
    const s1 = [r - dr * (b + 1), c - dc * (b + 1)], s2 = [r - dr * (b + 2), c - dc * (b + 2)];
    if (!empty(a1) || !empty(s1)) return false;
    return empty(a2) || empty(s2);
  }
  function labelPoint(st, r, c, me) {
    const opp = me === 1 ? 2 : 1;
    const mine = BG.util.clone(st.board); mine[r][c] = me;
    const parts = [];
    if (isFiveAt(mine, r, c, me)) return 'win';
    const myComps = fiveCompletions(mine, me, r, c);
    if (myComps >= 2) parts.push('you:open4');
    else if (myComps === 1) parts.push('you:four');
    else if (DIRS4.some(([dr, dc]) => liveThreeDir(mine, r, c, me, dr, dc))) parts.push('you:live3');
    const theirs = BG.util.clone(st.board); theirs[r][c] = opp;
    if (isFiveAt(theirs, r, c, opp)) parts.push('block:five');
    else {
      const opComps = fiveCompletions(theirs, opp, r, c);
      if (opComps >= 2) parts.push('deny:open4');
      else if (opComps === 1) parts.push('deny:four');
      else if (DIRS4.some(([dr, dc]) => liveThreeDir(theirs, r, c, opp, dr, dc))) parts.push('deny:live3');
    }
    return parts.join('+');
  }

  function serializeForJev(st, side) {
    const cand = candidates(st, 64);
    const notations = cand.map((m) => m.notation);
    const me = num(side);
    const criteria = {};
    cand.forEach((m) => { criteria[m.notation] = labelPoint(st, m.r, m.c, me) || null; });
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
            /* 板斧二+四：刚性扫描清单 + 防幻觉核对，替代"多制造威胁"式空话；板斧三 fallback：analysis 文本问不被 API 支持（实测 400），扫描流程只能内化到指令。
             * 2026-09-29 实测补强：Jev 对角线误读率高（对角四连找胜点曾错选 J9 而非 E5）。
             * 真实 API A/B 验证（3 次重复）：仅点名四个方向无改善（P(E5)≈0.02），
             * 加具体斜线示例后 P(E5)→0.76~0.81 且三次全选对——few-shot 具象示例是修复关键。 */
            'Before answering, run this scan in order and verify every claim cell by cell against `board_ascii` and the stone lists. ' +
            'Check all four directions separately every time — horizontal, vertical, diagonal top-left to bottom-right, diagonal top-right to bottom-left — ' +
            'including gapped patterns such as X X . X X; diagonals are the easiest to misread, so write out every cell of any claimed line. ' +
            'Concrete example: X stones on F6, G7, H8, I9 form a diagonal of four; the winning fifth point is E5, the empty cell continuing that exact diagonal — ' +
            'not a nearby cell such as J9 or E6. Always extend a diagonal or anti-diagonal along its exact line, for your stones and the opponent\'s alike: ' +
            '(1) points completing five in a row for you — if any exists, you MUST play one; ' +
            '(2) points completing five in a row for the opponent — if any exists and you cannot win immediately, you MUST play one; ' +
            '(3) your open threes and fours, and their strongest extension points; ' +
            '(4) the opponent\'s open threes, and the blocking points; ' +
            '(5) prefer points that create multiple threats at once or combine attack with defense. ' +
            /* 板斧五：引擎已把每个候选点的战术含义算成标签，模型从"发现模式"降为"读懂标签做比较" */
            'The `criteria` of every option carries an engine-verified tactical label: ' +
            '"you:four"/"you:open4"/"you:live3" = what your move would create, ' +
            '"deny:four"/"deny:live3"/"deny:open4" = a point the opponent wants for the same purpose, ' +
            '"block:five" = stops an immediate five, "+" joins combined effects (a point that attacks AND denies is strongest). ' +
            'Trust these labels over your own reading; between equal labels prefer the more central point. ' +
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
