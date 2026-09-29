'use strict';
/* 西洋跳棋（英式 American checkers）8×8。
 * 白方在下先行，兵只向前斜走/斜跳，跳吃强制且须连跳到底，到底线升王（升王即停）。
 * 记法：路径格名以 '-'（走）或 'x'（跳）相连，如 d4f6h8。 */
(function () {
  const SIZE = 62, MARGIN = 26, W = MARGIN * 2 + 8 * SIZE, H = W;
  const sqName = (r, c) => String.fromCharCode(97 + c) + (8 - r);
  const inb = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const dark = (r, c) => (r + c) % 2 === 1;
  const other = (s) => (s === 'w' ? 'b' : 'w');
  const isMan = (p) => p[1] === 'P';
  const fwdDirs = (s) => (s === 'w' ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]]);
  const allDirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  function newGame() {
    const b = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) if (dark(r, c)) b[r][c] = 'bP';
    for (let r = 5; r < 8; r++) for (let c = 0; c < 8; c++) if (dark(r, c)) b[r][c] = 'wP';
    return { board: b, turn: 'w', moveNum: 0, last: null, result: null };
  }

  /* 从 from 出发的全部连跳序列（含升王即停规则） */
  function captureSeqs(board, from) {
    const results = [];
    const me = board[from.r][from.c];
    const side = me[0];
    const dirsFor = (p) => (isMan(p) ? fwdDirs(p[0]) : allDirs);

    const b0 = BG.util.clone(board);
    b0[from.r][from.c] = null;

    function dfs(b, cur, path, captured, piece) {
      let any = false;
      for (const [dr, dc] of dirsFor(piece)) {
        const or_ = cur.r + dr, oc = cur.c + dc, lr = cur.r + 2 * dr, lc = cur.c + 2 * dc;
        if (!inb(lr, lc) || !dark(lr, lc)) continue;
        const over = b[or_][oc];
        if (!over || over[0] === side || captured.some((s) => s.r === or_ && s.c === oc)) continue;
        if (b[lr][lc]) continue;
        any = true;
        const nb = BG.util.clone(b);
        nb[cur.r][cur.c] = null;
        nb[or_][oc] = null;
        const promoted = isMan(piece) && (side === 'w' ? lr === 0 : lr === 7);
        nb[lr][lc] = promoted ? side + 'K' : piece;
        const newPath = path.concat([{ r: lr, c: lc }]);
        const newCap = captured.concat([{ r: or_, c: oc }]);
        if (promoted) {
          results.push({ path: newPath, captured: newCap });
        } else {
          dfs(nb, { r: lr, c: lc }, newPath, newCap, piece);
        }
      }
      if (!any && path.length > 1) results.push({ path, captured });
    }
    dfs(b0, from, [from], [], me);
    return results;
  }

  function getLegalMoves(st) {
    const b = st.board, side = st.turn;
    const pieces = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (b[r][c] && b[r][c][0] === side) pieces.push({ r, c });
    }
    /* 强制跳吃 */
    const caps = [];
    for (const from of pieces) {
      for (const seq of captureSeqs(b, from)) {
        caps.push({
          notation: seq.path.map((s) => sqName(s.r, s.c)).join('x'),
          desc: 'jump capture: ' + seq.captured.map((s) => sqName(s.r, s.c)).join(', '),
          path: seq.path, captured: seq.captured,
        });
      }
    }
    if (caps.length) return caps;
    const ms = [];
    for (const { r, c } of pieces) {
      const p = b[r][c];
      const dirs = isMan(p) ? fwdDirs(side) : allDirs;
      for (const [dr, dc] of dirs) {
        const rr = r + dr, cc = c + dc;
        if (inb(rr, cc) && dark(rr, cc) && !b[rr][cc]) {
          const promoted = isMan(p) && (side === 'w' ? rr === 0 : rr === 7);
          ms.push({
            notation: sqName(r, c) + '-' + sqName(rr, cc),
            desc: (isMan(p) ? 'man' : 'king') + ' ' + sqName(r, c) + '-' + sqName(rr, cc) + (promoted ? ' promotes to king' : ''),
            path: [{ r, c }, { r: rr, c: cc }], captured: [],
          });
        }
      }
    }
    return ms;
  }

  function applyMove(st, move) {
    const s = BG.util.clone(st);
    const b = s.board;
    const from = move.path[0], to = move.path[move.path.length - 1];
    let p = b[from.r][from.c];
    b[from.r][from.c] = null;
    for (const cap of move.captured) b[cap.r][cap.c] = null;
    if (isMan(p) && (p[0] === 'w' ? to.r === 0 : to.r === 7)) p = p[0] + 'K';
    b[to.r][to.c] = p;
    s.moveNum++;
    s.turn = other(st.turn);
    s.last = { notation: move.notation, side: st.turn };
    return s;
  }

  function getStatus(st) {
    if (st.result) return st.result;
    const side = st.turn;
    const has = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (st.board[r][c] && st.board[r][c][0] === side) has.push(1);
    }
    if (has.length === 0) return { over: true, winner: other(side), reason: '子力被吃光' };
    if (getLegalMoves(st).length === 0) return { over: true, winner: other(side), reason: '无着可走' };
    return { over: false, turn: side };
  }

  function moveFromNotation(st, n) {
    const norm = (x) => x.replace(/-/g, '');
    return getLegalMoves(st).find((m) => m.notation === n || norm(m.notation) === norm(n)) || null;
  }

  /* ---------- Jev 序列化 ---------- */
  const SCORE_LEVELS = ['0-2 clearly losing', '3-4 slightly worse', '5 roughly even', '6-7 slightly better', '8-10 clearly winning'];

  function pieceMap(b, s) {
    const out = {};
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = b[r][c];
      if (p && p[0] === s) out[sqName(r, c)] = p[1] === 'K' ? 'king' : 'man';
    }
    return out;
  }

  function serializeForJev(st, side) {
    const legal = getLegalMoves(st);
    const criteria = {};
    legal.forEach((m) => { criteria[m.notation] = m.desc; });
    const cn = side === 'w' ? 'white' : 'black';
    const must = legal.some((m) => m.captured && m.captured.length > 0);
    return {
      state: {
        game: 'English checkers (draughts), 8x8, squares named like d4 (file letter + rank), only dark squares are used',
        rules: 'English draughts: men move and jump diagonally forward only; jumps are mandatory and a jump chain must be completed; reaching the far rank promotes to king and ends the move; kings move and jump in all directions; a side with no legal move loses.',
        you_play: cn,
        move_number: st.moveNum + 1,
        white_pieces: pieceMap(st.board, 'w'),
        black_pieces: pieceMap(st.board, 'b'),
        capture_is_mandatory_this_turn: must,
        last_move: st.last ? st.last.side + ' ' + st.last.notation : 'none (opening)',
        legal_moves: legal.map((m) => m.notation),
      },
      questions: {
        move: {
          type: 'choice',
          instructions:
            'You are an expert English draughts player playing ' + cn + '. Moves list squares along the path: "b6-d5" is a simple move; "d4xf6xh8" is a multi-jump capture (squares separated by x). ' +
            'Captures are mandatory when available and a jump chain must be completed. Men move/capture forward only and promote to kings on the last rank; kings move/capture in all directions. ' +
            'Pick the best move from `legal_moves`: take free captures, avoid giving away pieces, advance toward promotion. ' +
            'Answer ONLY with the Choice question "move".',
          criteria,
        },
        edge: {
          type: 'noul',
          instructions: 'After the best move for ' + cn + ', is ' + cn + ' better in this position?',
          criteria: { true: cn + ' has the advantage', false: 'equal or opponent better' },
        },
        position: {
          type: 'score',
          instructions: 'Rate the position for ' + cn + ' after the best move, on a 0-10 scale.',
          criteria: SCORE_LEVELS,
        },
      },
      options: legal.map((m) => m.notation),
    };
  }

  /* ---------- 渲染与交互 ---------- */
  const DARK_SQ = '#D9DEE5';

  function draw(ctx, st, ui) {
    BG.gfx.clear(ctx, W, H, '#C9D1D9');
    BG.gfx.cells(ctx, MARGIN, MARGIN, SIZE, 8, 8, dark, DARK_SQ);
    if (st.last) {
      const sqs = st.last.notation.split(/[-x]/);
      sqs.forEach((sq) => {
        const c = sq.charCodeAt(0) - 97, r = 8 - parseInt(sq.slice(1), 10);
        ctx.fillStyle = 'rgba(194,64,42,.25)';
        ctx.fillRect(MARGIN + c * SIZE, MARGIN + r * SIZE, SIZE, SIZE);
      });
    }
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = st.board[r][c];
        if (!p) continue;
        const x = MARGIN + c * SIZE + SIZE / 2, y = MARGIN + r * SIZE + SIZE / 2;
        const isW = p[0] === 'w';
        BG.gfx.disc(ctx, x, y, SIZE * 0.38, isW ? '#FFFFFF' : '#22262C', isW ? '#9AA3AD' : '#0E1116',
          p[1] === 'K' ? '王' : '', isW ? '#2A2F38' : '#E4E8ED');
      }
    }
    if (ui.sel) BG.gfx.highlight(ctx, MARGIN + ui.sel.c * SIZE + SIZE / 2, MARGIN + ui.sel.r * SIZE + SIZE / 2, SIZE * 0.42);
    for (let c = 0; c < 8; c++) BG.gfx.text(ctx, String.fromCharCode(97 + c), MARGIN + c * SIZE + SIZE / 2, H - 10, { size: 11 });
    for (let r = 0; r < 8; r++) BG.gfx.text(ctx, String(8 - r), 12, MARGIN + r * SIZE + SIZE / 2, { size: 11 });
  }

  function xyToCell(x, y) {
    const c = Math.floor((x - MARGIN) / SIZE), r = Math.floor((y - MARGIN) / SIZE);
    return inb(r, c) ? { r, c } : null;
  }

  /* 人类点击：支持连跳逐格点选 */
  function humanClick(st, ui, x, y) {
    const cell = xyToCell(x, y);
    if (!cell) return null;
    const p = st.board[cell.r][cell.c];
    const legal = getLegalMoves(st);
    const mustCapture = legal.length > 0 && legal[0].captured.length > 0;

    /* 连跳进行中：逐格点选 */
    if (ui.chain) {
      const prefix = ui.chain.prefix;
      const samePrefix = (seq) => prefix.every((sq, i) => seq.path[i].r === sq.r && seq.path[i].c === sq.c);
      const extendable = ui.chain.seqs.filter((s) => s.path.length > prefix.length && samePrefix(s));
      const hit = extendable.map((s) => s.path[prefix.length])
        .find((s) => s.r === cell.r && s.c === cell.c);
      if (!hit) { ui.chain = null; return null; }
      prefix.push(cell);
      const canExtend = extendable.some((s) => s.path.length > prefix.length && samePrefix(s));
      if (!canExtend) {
        const fin = extendable.find((s) => s.path.length === prefix.length);
        ui.chain = null;
        if (fin) {
          return {
            notation: fin.path.map((s) => sqName(s.r, s.c)).join('x'), desc: '',
            path: fin.path, captured: fin.captured,
          };
        }
      }
      return null; // 连跳未完，等待下一格
    }

    if (p && p[0] === st.turn) {
      ui.sel = cell;
      if (mustCapture) {
        const seqs = captureSeqs(st.board, cell);
        if (seqs.length) ui.chain = { seqs, prefix: [cell] };
      }
      return null;
    }
    if (ui.sel) {
      const mv = legal.find((m) => !m.captured.length &&
        m.path[0].r === ui.sel.r && m.path[0].c === ui.sel.c &&
        m.path[1].r === cell.r && m.path[1].c === cell.c);
      ui.sel = null;
      if (mv) return mv;
    }
    return null;
  }

  /* ---------- mock 启发式 ---------- */
  function mockPick(st, moves) {
    let best = null, bestScore = -1e9;
    for (const m of moves) {
      const ns = applyMove(st, m);
      let sc = BG.util.rnd() + m.captured.length * 10;
      const to = m.path[m.path.length - 1];
      if (st.board[m.path[0].r][m.path[0].c] === 'wP' && to.r === 0) sc += 8;
      if (st.board[m.path[0].r][m.path[0].c] === 'bP' && to.r === 7) sc += 8;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    return best;
  }

  /* ---------- 自检 ---------- */
  function selfTest() {
    const st = newGame();
    BG.util.assert(getLegalMoves(st).length === 7, '开局 7 步, got ' + getLegalMoves(st).length);
    /* 强制跳吃 + 连跳 + 升王 */
    let s2 = newGame();
    s2.board = Array.from({ length: 8 }, () => Array(8).fill(null));
    s2.board[4][3] = 'wP';                 // d4
    s2.board[3][4] = 'bP';                 // e5
    s2.board[1][6] = 'bP';                 // g7
    s2.turn = 'w';
    const legal = getLegalMoves(s2);
    BG.util.assert(legal.length === 1 && legal[0].notation === 'd4xf6xh8', '连跳 d4xf6xh8, got ' + JSON.stringify(legal.map((m) => m.notation)));
    BG.util.assert(legal[0].captured.length === 2, '跳吃两子');
    const s3 = applyMove(s2, legal[0]);
    BG.util.assert(s3.board[0][7] === 'wK', '到底线升王');
    BG.util.assert(s3.board[3][4] === null && s3.board[1][6] === null, '被跳子移除');
    /* 升王后不能继续跳（本例 h8 已到底） */
    /* 无子可走判负 */
    let s4 = newGame();
    s4.board = Array.from({ length: 8 }, () => Array(8).fill(null));
    s4.board[0][1] = 'bP'; s4.board[1][0] = 'wP'; s4.board[1][2] = 'wP'; s4.board[2][3] = 'wP';
    s4.turn = 'b';
    const g = getStatus(s4);
    BG.util.assert(g.over && g.winner === 'w', '被围困判负');
  }

  BG.register({
    id: 'checkers', name: '西洋跳棋',
    sides: [{ id: 'w', name: '白方', first: true }, { id: 'b', name: '黑方' }],
    meta: { w: W, h: H }, supportsPass: false, supportsResign: true,
    newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
    serializeForJev, draw, humanClick, mockPick, selfTest,
  });
})();
