'use strict';
/* 国际象棋 8×8。坐标：列 a–h（左→右），行 8–1（上→下），记法 from+to（如 e2e4），
 * 升变 e7e8=Q，王车易位记作 e1g1 / e8c8。含易位、吃过路兵、升变、将杀/逼和/50回合/子力不足判和。 */
(function () {
  const SIZE = 62, MARGIN = 26, W = MARGIN * 2 + 8 * SIZE, H = W;
  const sqName = (r, c) => String.fromCharCode(97 + c) + (8 - r);
  const val = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
  const NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
  const KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const other = (s) => (s === 'w' ? 'b' : 'w');

  function newGame() {
    const b = Array.from({ length: 8 }, () => Array(8).fill(null));
    const back = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    for (let c = 0; c < 8; c++) {
      b[0][c] = 'b' + back[c]; b[1][c] = 'bP';
      b[6][c] = 'wP'; b[7][c] = 'w' + back[c];
    }
    return {
      board: b, turn: 'w',
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      ep: null, halfmove: 0, fullmove: 1, last: null, result: null,
    };
  }

  const inb = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const own = (p, s) => p && p[0] === s;
  const enemy = (p, s) => p && p[0] !== s;

  function isAttacked(board, r, c, by) {
    const pd = by === 'w' ? 1 : -1; // 白兵在 (r+1,c±1) 攻击 (r,c)
    for (const dc of [-1, 1]) {
      if (inb(r + pd, c + dc) && board[r + pd][c + dc] === by + 'P') return true;
    }
    for (const [dr, dc] of KN) {
      if (inb(r + dr, c + dc) && board[r + dr][c + dc] === by + 'N') return true;
    }
    for (const [dr, dc] of DIAG.concat(ORTH)) {
      if (inb(r + dr, c + dc) && board[r + dr][c + dc] === by + 'K') return true;
    }
    for (const [dr, dc] of ORTH) {
      let rr = r + dr, cc = c + dc;
      while (inb(rr, cc)) {
        const p = board[rr][cc];
        if (p) { if (p === by + 'R' || p === by + 'Q') return true; break; }
        rr += dr; cc += dc;
      }
    }
    for (const [dr, dc] of DIAG) {
      let rr = r + dr, cc = c + dc;
      while (inb(rr, cc)) {
        const p = board[rr][cc];
        if (p) { if (p === by + 'B' || p === by + 'Q') return true; break; }
        rr += dr; cc += dc;
      }
    }
    return false;
  }

  function kingPos(board, s) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (board[r][c] === s + 'K') return { r, c };
    }
    return null;
  }

  function inCheck(st, s) {
    const k = kingPos(st.board, s);
    return k ? isAttacked(st.board, k.r, k.c, other(s)) : false;
  }

  function genPseudo(st, side) {
    const b = st.board, ms = [];
    const push = (fr, fc, tr, tc, extra) => {
      const target = b[tr][tc];
      const isPromo = b[fr][fc][1] === 'P' && (tr === 0 || tr === 7);
      if (isPromo) {
        for (const p of ['Q', 'R', 'B', 'N']) {
          ms.push(Object.assign({
            notation: sqName(fr, fc) + sqName(tr, tc) + '=' + p, promo: p,
            fr, fc, tr, tc,
            desc: NAMES.P + ' ' + sqName(fr, fc) + '-' + sqName(tr, tc) +
              ' promotes to ' + NAMES[p] + (target ? ', captures ' + NAMES[target[1]] : ''),
          }, extra));
        }
      } else {
        const pc = b[fr][fc][1];
        ms.push(Object.assign({
          notation: sqName(fr, fc) + sqName(tr, tc), fr, fc, tr, tc,
          desc: NAMES[pc] + ' ' + sqName(fr, fc) + '-' + sqName(tr, tc) +
            (target ? ', captures ' + NAMES[target[1]] : ''),
        }, extra));
      }
    };

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = b[r][c];
        if (!own(p, side)) continue;
        const t = p[1];
        if (t === 'P') {
          const dir = side === 'w' ? -1 : 1;
          const start = side === 'w' ? 6 : 1;
          if (inb(r + dir, c) && !b[r + dir][c]) {
            push(r, c, r + dir, c);
            if (r === start && !b[r + 2 * dir][c]) {
              ms[ms.length - 1] && push(r, c, r + 2 * dir, c, { double: true });
            }
          }
          for (const dc of [-1, 1]) {
            const rr = r + dir, cc = c + dc;
            if (inb(rr, cc) && enemy(b[rr][cc], side)) push(r, c, rr, cc);
            if (inb(rr, cc) && st.ep && st.ep.r === rr && st.ep.c === cc) {
              push(r, c, rr, cc, { ep: true, desc: 'pawn ' + sqName(r, c) + '-' + sqName(rr, cc) + ' en passant' });
            }
          }
        } else if (t === 'N') {
          for (const [dr, dc] of KN) {
            const rr = r + dr, cc = c + dc;
            if (inb(rr, cc) && !own(b[rr][cc], side)) push(r, c, rr, cc);
          }
        } else if (t === 'K') {
          for (const [dr, dc] of DIAG.concat(ORTH)) {
            const rr = r + dr, cc = c + dc;
            if (inb(rr, cc) && !own(b[rr][cc], side)) push(r, c, rr, cc);
          }
          /* 王车易位 */
          const home = side === 'w' ? 7 : 0;
          if (r === home && c === 4) {
            const opp = other(side);
            const kOk = st.castling[side + 'K'] && !b[home][5] && !b[home][6] && b[home][7] === side + 'R' &&
              !isAttacked(b, home, 4, opp) && !isAttacked(b, home, 5, opp) && !isAttacked(b, home, 6, opp);
            if (kOk) {
              ms.push({ notation: sqName(home, 4) + sqName(home, 6), fr: home, fc: 4, tr: home, tc: 6, castle: 'K', desc: 'castle kingside' });
            }
            const qOk = st.castling[side + 'Q'] && !b[home][3] && !b[home][2] && !b[home][1] && b[home][0] === side + 'R' &&
              !isAttacked(b, home, 4, opp) && !isAttacked(b, home, 3, opp) && !isAttacked(b, home, 2, opp);
            if (qOk) {
              ms.push({ notation: sqName(home, 4) + sqName(home, 2), fr: home, fc: 4, tr: home, tc: 2, castle: 'Q', desc: 'castle queenside' });
            }
          }
        } else {
          const dirs = t === 'B' ? DIAG : t === 'R' ? ORTH : DIAG.concat(ORTH);
          for (const [dr, dc] of dirs) {
            let rr = r + dr, cc = c + dc;
            while (inb(rr, cc)) {
              if (own(b[rr][cc], side)) break;
              push(r, c, rr, cc);
              if (b[rr][cc]) break;
              rr += dr; cc += dc;
            }
          }
        }
      }
    }
    return ms;
  }

  function applyMove(st, move) {
    const s = BG.util.clone(st);
    const b = s.board;
    const side = st.turn;
    const piece = b[move.fr][move.fc];
    const isPawn = piece[1] === 'P';
    b[move.fr][move.fc] = null;
    if (move.ep) b[move.fr][move.tc] = null; // 吃过路兵
    b[move.tr][move.tc] = move.promo ? side + move.promo : piece;
    if (move.castle) {
      const home = side === 'w' ? 7 : 0;
      if (move.castle === 'K') { b[home][5] = b[home][7]; b[home][7] = null; }
      else { b[home][3] = b[home][0]; b[home][0] = null; }
    }
    /* 易位权更新 */
    if (piece[1] === 'K') { s.castling[side + 'K'] = false; s.castling[side + 'Q'] = false; }
    const corners = { '7,0': 'wQ', '7,7': 'wK', '0,0': 'bQ', '0,7': 'bK' };
    const ck1 = corners[move.fr + ',' + move.fc], ck2 = corners[move.tr + ',' + move.tc];
    if (ck1) s.castling[ck1] = false;
    if (ck2) s.castling[ck2] = false;
    /* 过路兵目标格 */
    s.ep = move.double ? { r: (move.fr + move.tr) / 2, c: move.fc } : null;
    s.halfmove = isPawn || st.board[move.tr][move.tc] ? 0 : st.halfmove + 1;
    if (side === 'b') s.fullmove++;
    s.turn = other(side);
    s.last = { notation: move.notation, side };
    return s;
  }

  function getLegalMoves(st) {
    const side = st.turn;
    return genPseudo(st, side).filter((m) => {
      const ns = applyMove(st, m);
      return !inCheck(ns, side);
    });
  }

  function getStatus(st) {
    if (st.result) return st.result;
    const side = st.turn;
    const legal = getLegalMoves(st);
    const checked = inCheck(st, side);
    if (legal.length === 0) {
      return checked
        ? { over: true, winner: other(side), reason: '将杀' }
        : { over: true, winner: null, reason: '逼和' };
    }
    if (st.halfmove >= 100) return { over: true, winner: null, reason: '50 回合规则' };
    /* 子力不足 */
    const rest = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = st.board[r][c];
      if (p && p[1] !== 'K') rest.push(p[1]);
    }
    if (rest.length === 0 || (rest.length === 1 && (rest[0] === 'N' || rest[0] === 'B'))) {
      return { over: true, winner: null, reason: '子力不足' };
    }
    return { over: false, turn: side, check: checked };
  }

  function moveFromNotation(st, n) {
    return getLegalMoves(st).find((m) => m.notation === n) || null;
  }

  /* ---------- Jev 序列化 ---------- */
  const SCORE_LEVELS = ['0-2 clearly losing', '3-4 slightly worse', '5 roughly even', '6-7 slightly better', '8-10 clearly winning'];

  function pieceMap(board, side) {
    const out = {};
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p[0] === side) (out[p[1]] = out[p[1]] || []).push(sqName(r, c));
      }
    }
    return out;
  }

  function serializeForJev(st, side) {
    const legal = getLegalMoves(st);
    /* 升变只保留 =Q，控制选项数 */
    const seen = new Set();
    const opts = [];
    for (const m of legal) {
      const key = m.promo && m.promo !== 'Q' ? m.notation.split('=')[0] + '=Q' : m.notation;
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({ notation: key, desc: m.desc });
    }
    const criteria = {};
    opts.forEach((o) => { criteria[o.notation] = o.desc; });
    const colorName = side === 'w' ? 'white' : 'black';
    const cast = ['K', 'Q'].map((x) => st.castling['w' + x] ? x : '').join('') +
      ['K', 'Q'].map((x) => st.castling['b' + x] ? x.toLowerCase() : '').join('');
    return {
      state: {
        game: 'chess, standard algebraic from-to notation (e2e4), board columns a-h, ranks 1-8',
        you_play: colorName,
        move_number: st.fullmove,
        turn: st.turn === 'w' ? 'white' : 'black',
        white_pieces: pieceMap(st.board, 'w'),
        black_pieces: pieceMap(st.board, 'b'),
        castling_rights: cast || 'none',
        en_passant_target: st.ep ? sqName(st.ep.r, st.ep.c) : null,
        halfmove_clock: st.halfmove,
        last_move: st.last ? st.last.side + ' ' + st.last.notation : 'none (opening)',
        legal_moves: opts.map((o) => o.notation),
      },
      questions: {
        move: {
          type: 'choice',
          instructions:
            'You are an expert chess player playing ' + colorName + '. A move "e2e4" means moving the piece from e2 to e4; ' +
            '"e7e8=Q" promotes a pawn to queen; "e1g1" is kingside castling. Captures are implied when the target square is occupied. ' +
            'Pick the best move from `legal_moves`: capture material, look for checkmate and forced tactics, ' +
            'develop pieces, control the center, keep your king safe, do not hang pieces. ' +
            'Answer ONLY with the Choice question "move".',
          criteria,
        },
        edge: {
          type: 'noul',
          instructions: 'After the best move for ' + colorName + ', is ' + colorName + ' better in this position?',
          criteria: { true: colorName + ' has the advantage', false: 'equal or opponent better' },
        },
        position: {
          type: 'score',
          instructions: 'Rate the position for ' + colorName + ' after the best move, on a 0-10 scale.',
          criteria: SCORE_LEVELS,
        },
      },
      options: opts.map((o) => o.notation),
    };
  }

  /* ---------- 渲染与交互 ---------- */
  const LIGHT = '#F2F4F7', DARK = '#D9DEE5';

  function draw(ctx, st, ui) {
    BG.gfx.clear(ctx, W, H, '#C9D1D9');
    BG.gfx.cells(ctx, MARGIN, MARGIN, SIZE, 8, 8, (r, c) => (r + c) % 2 === 1, DARK);
    /* 最后一步与选中高亮 */
    const hl = (r, c, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(MARGIN + c * SIZE, MARGIN + r * SIZE, SIZE, SIZE);
    };
    if (st.last) {
      const fr = 8 - parseInt(st.last.notation[1], 10), fc = st.last.notation.charCodeAt(0) - 97;
      const tr = 8 - parseInt(st.last.notation[3], 10), tc = st.last.notation.charCodeAt(2) - 97;
      hl(fr, fc, 'rgba(194,64,42,.20)'); hl(tr, tc, 'rgba(194,64,42,.30)');
    }
    if (ui.sel) hl(ui.sel.r, ui.sel.c, 'rgba(31,36,44,.30)');
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = st.board[r][c];
        if (!p) continue;
        const x = MARGIN + c * SIZE + SIZE / 2, y = MARGIN + r * SIZE + SIZE / 2;
        const isW = p[0] === 'w';
        BG.gfx.disc(ctx, x, y, SIZE * 0.4,
          isW ? '#FFFFFF' : '#22262C', isW ? '#9AA3AD' : '#0E1116', p[1],
          isW ? '#2A2F38' : '#F2F4F7');
      }
    }
    for (let c = 0; c < 8; c++) BG.gfx.text(ctx, String.fromCharCode(97 + c), MARGIN + c * SIZE + SIZE / 2, H - 10, { size: 11 });
    for (let r = 0; r < 8; r++) BG.gfx.text(ctx, String(8 - r), 12, MARGIN + r * SIZE + SIZE / 2, { size: 11 });
  }

  function xyToCell(x, y) {
    const c = Math.floor((x - MARGIN) / SIZE), r = Math.floor((y - MARGIN) / SIZE);
    return inb(r, c) ? { r, c } : null;
  }

  function humanClick(st, ui, x, y) {
    const cell = xyToCell(x, y);
    if (!cell) { ui.sel = null; return null; }
    const p = st.board[cell.r][cell.c];
    if (ui.sel) {
      const candidates = getLegalMoves(st).filter((m) => m.fr === ui.sel.r && m.fc === ui.sel.c && m.tr === cell.r && m.tc === cell.c);
      if (candidates.length > 0) {
        ui.sel = null;
        if (candidates[0].promo) return { promoChoice: { from: sqName(candidates[0].fr, candidates[0].fc), to: sqName(cell.r, cell.c) } };
        return candidates[0];
      }
    }
    if (own(p, st.turn)) { ui.sel = cell; return null; }
    ui.sel = null;
    return null;
  }

  /* ---------- mock 启发式 ---------- */
  function mockPick(st, moves) {
    let best = null, bestScore = -1e9;
    for (const m of moves) {
      const ns = applyMove(st, m);
      let sc = Math.random();
      if (st.board[m.tr][m.tc]) sc += val[st.board[m.tr][m.tc][1]] * 10;
      if (m.promo === 'Q') sc += 80;
      if (inCheck(ns, st.turn === 'w' ? 'b' : 'w')) sc += 5;
      if (inCheck(ns, st.turn)) sc -= 100;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    return best;
  }

  /* ---------- 自检 ---------- */
  function perft(st, depth) {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of getLegalMoves(st)) n += perft(applyMove(st, m), depth - 1);
    return n;
  }

  function selfTest() {
    let st = newGame();
    BG.util.assert(perft(st, 1) === 20, '初始 perft(1)=20, got ' + perft(st, 1));
    BG.util.assert(perft(st, 2) === 400, '初始 perft(2)=400, got ' + perft(st, 2));
    BG.util.assert(perft(st, 3) === 8902, '初始 perft(3)=8902, got ' + perft(st, 3));
    /* 易位 */
    const seq = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'];
    for (const n of seq) {
      const m = moveFromNotation(st, n);
      BG.util.assert(m, '易位序列着法合法 ' + n);
      st = applyMove(st, m);
    }
    BG.util.assert(moveFromNotation(st, 'e1g1'), '白方王翼易位合法');
    st = applyMove(st, moveFromNotation(st, 'e1g1'));
    BG.util.assert(st.board[7][5] === 'wR' && st.board[7][6] === 'wK', '易位后车王就位');
    /* 过路兵 */
    let s2 = newGame();
    for (const n of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) {
      const m = moveFromNotation(s2, n);
      BG.util.assert(m, '过路兵序列 ' + n);
      s2 = applyMove(s2, m);
    }
    const ep = moveFromNotation(s2, 'e5d6');
    BG.util.assert(ep && ep.ep, '吃过路兵合法');
    s2 = applyMove(s2, ep);
    BG.util.assert(s2.board[3][3] === null, '被吃兵消失');
    /* 升变 */
    let s3 = newGame();
    s3.board = Array.from({ length: 8 }, () => Array(8).fill(null));
    s3.board[1][4] = 'wP'; s3.board[7][4] = 'wK'; s3.board[0][3] = 'bK';
    s3.turn = 'w'; s3.castling = { wK: false, wQ: false, bK: false, bQ: false };
    const pm = moveFromNotation(s3, 'e7e8=Q');
    BG.util.assert(pm, '升变着法存在');
    s3 = applyMove(s3, pm);
    BG.util.assert(s3.board[0][4] === 'wQ', '升变为后');
    /* 愚人杀 */
    let s4 = newGame();
    for (const n of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
      s4 = applyMove(s4, moveFromNotation(s4, n));
    }
    const g4 = getStatus(s4);
    BG.util.assert(g4.over && g4.winner === 'b' && g4.reason === '将杀', '愚人杀将杀判定');
    /* 逼和 */
    let s5 = newGame();
    s5.board = Array.from({ length: 8 }, () => Array(8).fill(null));
    s5.board[0][0] = 'bK'; s5.board[1][2] = 'wK'; s5.board[2][1] = 'wQ';
    s5.turn = 'b'; s5.castling = { wK: false, wQ: false, bK: false, bQ: false };
    const g5 = getStatus(s5);
    BG.util.assert(g5.over && g5.winner === null && g5.reason === '逼和', '逼和判定');
  }

  BG.register({
    id: 'chess', name: '国际象棋',
    sides: [{ id: 'w', name: '白方', first: true }, { id: 'b', name: '黑方' }],
    meta: { w: W, h: H }, supportsPass: false, supportsResign: true,
    newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
    serializeForJev, draw, humanClick, mockPick, selfTest,
  });
})();
