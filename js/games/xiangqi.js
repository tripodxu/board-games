'use strict';
/* 象棋 9×10。坐标：列 a–i（左→右），行 1–10（上→下），记法 from+to（如 h2e2）。
 * 黑方在上（行 1–5），红方在下（行 6–10）。含将帅照面、将军/绝杀/困毙；长将判负 v1 暂未实现。 */
(function () {
  const COLS = 9, ROWS = 10;
  const CW = 46, CH = 46, MARGIN = 30;
  const W = MARGIN * 2 + (COLS - 1) * CW, H = MARGIN * 2 + (ROWS - 1) * CH;
  const sqName = (r, c) => String.fromCharCode(97 + c) + (r + 1);
  const inb = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
  const own = (p, s) => p && p[0] === s;
  const enemy = (p, s) => p && p[0] !== s;
  const other = (s) => (s === 'r' ? 'b' : 'r');
  const EN = { K: 'General', A: 'Advisor', B: 'Elephant', N: 'Horse', R: 'Chariot', C: 'Cannon', P: 'Pawn' };
  const VAL = { K: 0, R: 9, C: 4.5, N: 4, B: 2, A: 2, P: 1 };

  function newGame() {
    const b = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    const back = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'];
    for (let c = 0; c < COLS; c++) {
      b[0][c] = 'b' + back[c]; b[9][c] = 'r' + back[c];
    }
    b[2][1] = 'bC'; b[2][7] = 'bC'; b[7][1] = 'rC'; b[7][7] = 'rC';
    for (let c = 0; c < COLS; c += 2) { b[3][c] = 'bP'; b[6][c] = 'rP'; }
    return { board: b, turn: 'r', moveNum: 0, last: null, result: null };
  }

  const inPalace = (r, c, s) => c >= 3 && c <= 5 && (s === 'b' ? r <= 2 : r >= 7);
  const crossedRiver = (r, s) => (s === 'b' ? r >= 5 : r <= 4);
  const fwd = (s) => (s === 'b' ? 1 : -1);

  function genPseudo(st, side) {
    const b = st.board, ms = [];
    const add = (fr, fc, tr, tc, extra) => {
      const target = b[tr][tc];
      if (own(target, side)) return;
      const pc = b[fr][fc][1];
      ms.push(Object.assign({
        notation: sqName(fr, fc) + sqName(tr, tc), fr, fc, tr, tc,
        desc: EN[pc] + ' ' + sqName(fr, fc) + '-' + sqName(tr, tc) +
          (target ? ', captures ' + EN[target[1]] : ''),
      }, extra || {}));
    };
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = b[r][c];
        if (!own(p, side)) continue;
        const t = p[1];
        if (t === 'R') {
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            let rr = r + dr, cc = c + dc;
            while (inb(rr, cc)) {
              add(r, c, rr, cc);
              if (b[rr][cc]) break;
              rr += dr; cc += dc;
            }
          }
        } else if (t === 'K') {
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const rr = r + dr, cc = c + dc;
            if (inb(rr, cc) && inPalace(rr, cc, side)) add(r, c, rr, cc);
          }
        } else if (t === 'C') {
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            let rr = r + dr, cc = c + dc, screen = false;
            while (inb(rr, cc)) {
              if (!screen) {
                if (!b[rr][cc]) add(r, c, rr, cc);
                else screen = true;
              } else if (b[rr][cc]) {
                add(r, c, rr, cc); // 隔子打
                break;
              }
              rr += dr; cc += dc;
            }
          }
        } else if (t === 'N') {
          for (const [dr, dc, lr, lc] of [
            [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
            [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
          ]) {
            const rr = r + dr, cc = c + dc;
            if (inb(rr, cc) && !b[r + lr][c + lc]) add(r, c, rr, cc);
          }
        } else if (t === 'B') {
          for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) {
            const rr = r + dr, cc = c + dc;
            if (inb(rr, cc) && crossedRiver(rr, side) === false && !b[r + dr / 2][c + dc / 2]) {
              /* 象不过河：保持在己方半场 */
              if (side === 'b' ? rr <= 4 : rr >= 5) add(r, c, rr, cc);
            }
          }
        } else if (t === 'A') {
          for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
            const rr = r + dr, cc = c + dc;
            if (inb(rr, cc) && inPalace(rr, cc, side)) add(r, c, rr, cc);
          }
        } else if (t === 'P') {
          const rr = r + fwd(side);
          if (inb(rr, c)) add(r, c, rr, c);
          if (crossedRiver(r, side)) {
            if (inb(r, c - 1)) add(r, c, r, c - 1);
            if (inb(r, c + 1)) add(r, c, r, c + 1);
          }
        }
      }
    }
    return ms;
  }

  function kingPos(b, s) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (b[r][c] === s + 'K') return { r, c };
    }
    return null;
  }

  /* 将军检测：包括将帅照面 */
  function isKingAttacked(b, s) {
    const k = kingPos(b, s);
    if (!k) return true;
    const opp = other(s);
    /* 照面 */
    const ko = kingPos(b, opp);
    if (ko && ko.c === k.c) {
      let empty = true;
      for (let r = Math.min(k.r, ko.r) + 1; r < Math.max(k.r, ko.r); r++) {
        if (b[r][k.c]) { empty = false; break; }
      }
      if (empty) return true;
    }
    /* 车 & 炮（同行列扫描） */
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let rr = k.r + dr, cc = k.c + dc, screen = false;
      while (inb(rr, cc)) {
        const p = b[rr][cc];
        if (p) {
          if (!screen) {
            if (p[0] === opp && (p[1] === 'R' || p[1] === 'K')) return true;
            screen = true;
          } else if (p[0] === opp && p[1] === 'C') return true;
          else break;
        }
        rr += dr; cc += dc;
      }
    }
    /* 马（蹩腿相对马而言） */
    for (const [dr, dc, lr, lc] of [
      [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
      [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
    ]) {
      const rr = k.r + dr, cc = k.c + dc;
      if (inb(rr, cc) && b[rr][cc] === opp + 'N' && !b[rr + lr][cc + lc]) return true;
    }
    /* 兵/卒：正前方，过河后侧向 */
    const pf = -fwd(s); // 对方兵相对本方王的前进反方向
    for (const [dr, dc] of [[pf, 0], [0, -1], [0, 1]]) {
      const rr = k.r + dr, cc = k.c + dc;
      if (inb(rr, cc) && b[rr][cc] === opp + 'P') {
        /* 侧向攻击要求该兵已过河（即位于本方半场） */
        if (dc === 0 || crossedRiver(rr, opp)) return true;
      }
    }
    return false;
  }

  function applyMove(st, move) {
    const s = BG.util.clone(st);
    s.board[move.tr][move.tc] = s.board[move.fr][move.fc];
    s.board[move.fr][move.fc] = null;
    s.moveNum++;
    s.turn = other(st.turn);
    s.last = { notation: move.notation, side: st.turn };
    return s;
  }

  function getLegalMoves(st) {
    const side = st.turn;
    return genPseudo(st, side).filter((m) => {
      const ns = applyMove(st, m);
      return !isKingAttacked(ns.board, side);
    });
  }

  function getStatus(st) {
    if (st.result) return st.result;
    const side = st.turn;
    const legal = getLegalMoves(st);
    if (legal.length === 0) {
      return isKingAttacked(st.board, side)
        ? { over: true, winner: other(side), reason: '绝杀' }
        : { over: true, winner: other(side), reason: '困毙' };
    }
    return { over: false, turn: side };
  }

  function moveFromNotation(st, n) {
    return getLegalMoves(st).find((m) => m.notation === n) || null;
  }

  /* ---------- Jev 序列化 ---------- */
  const SCORE_LEVELS = ['0-2 clearly losing', '3-4 slightly worse', '5 roughly even', '6-7 slightly better', '8-10 clearly winning'];

  function pieceMap(b, s) {
    const out = {};
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const p = b[r][c];
      if (p && p[0] === s) (out[p[1]] = out[p[1]] || []).push(sqName(r, c));
    }
    return out;
  }

  function serializeForJev(st, side) {
    const legal = getLegalMoves(st);
    const criteria = {};
    legal.forEach((m) => { criteria[m.notation] = m.desc; });
    const cn = side === 'r' ? 'red' : 'black';
    return {
      state: {
        game: 'xiangqi (Chinese chess), 9 columns a-i x 10 rows 1-10, row 1 is the black (top) side, pieces stand on intersections',
        rules: 'Standard xiangqi: pieces move and capture as their identity dictates, the two generals may never face each other on an open file, and check must be answered; checkmate or having no legal move loses the game, and perpetual check is not judged.',
        you_play: cn,
        move_number: st.moveNum + 1,
        red_pieces: pieceMap(st.board, 'r'),
        black_pieces: pieceMap(st.board, 'b'),
        last_move: st.last ? st.last.side + ' ' + st.last.notation : 'none (opening)',
        legal_moves: legal.map((m) => m.notation),
      },
      questions: {
        move: {
          type: 'choice',
          instructions:
            'You are an expert xiangqi player playing ' + cn + '. A move "h2e2" means the piece on h2 moves to e2; captures are implied when the target square is occupied. ' +
            'Pieces: R chariot (rook), N horse (knight, can be blocked by adjacent pieces), C cannon (captures only by jumping over exactly one screen piece), B elephant (2-point diagonal, cannot cross the river), A advisor, K general, P pawn (moves forward, sideways after crossing the river). ' +
            'The general must not be left in check, and the two generals must not face each other on an open file. ' +
            'Pick the best move from `legal_moves`: threaten or checkmate the enemy general, capture material, keep your general safe. ' +
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
  const CN = { r: { K: '帥', A: '仕', B: '相', N: '馬', R: '車', C: '炮', P: '兵' },
               b: { K: '將', A: '士', B: '象', N: '馬', R: '車', C: '砲', P: '卒' } };

  function draw(ctx, st, ui) {
    BG.gfx.clear(ctx, W, H);
    BG.gfx.intersections(ctx, MARGIN, MARGIN, CW, COLS, ROWS);
    /* 九宫斜线 */
    ctx.strokeStyle = '#3A4048';
    for (const top of [0, 7]) {
      ctx.beginPath(); ctx.moveTo(MARGIN + 3 * CW, MARGIN + top * CH); ctx.lineTo(MARGIN + 5 * CW, MARGIN + (top + 2) * CH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(MARGIN + 5 * CW, MARGIN + top * CH); ctx.lineTo(MARGIN + 3 * CW, MARGIN + (top + 2) * CH); ctx.stroke();
    }
    BG.gfx.text(ctx, '楚 河', MARGIN + 1.5 * CW, MARGIN + 4.5 * CH, { size: 15, color: '#B9C1CA' });
    BG.gfx.text(ctx, '漢 界', MARGIN + 6.5 * CW, MARGIN + 4.5 * CH, { size: 15, color: '#B9C1CA' });
    if (st.last) {
      const fr = parseInt(st.last.notation[1], 10) - 1, fc = st.last.notation.charCodeAt(0) - 97;
      const tr = parseInt(st.last.notation[3], 10) - 1, tc = st.last.notation.charCodeAt(2) - 97;
      BG.gfx.highlight(ctx, MARGIN + fc * CW, MARGIN + fr * CH, 6, 'rgba(31,36,44,.7)');
      BG.gfx.highlight(ctx, MARGIN + tc * CW, MARGIN + tr * CH, 6, 'rgba(194,64,42,.9)');
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = st.board[r][c];
        if (!p) continue;
        const x = MARGIN + c * CW, y = MARGIN + r * CH;
        const isR = p[0] === 'r';
        BG.gfx.disc(ctx, x, y, CW * 0.42, '#FFFFFF', isR ? '#C2402A' : '#22262C',
          CN[p[0]][p[1]], isR ? '#C2402A' : '#22262C');
      }
    }
    for (let c = 0; c < COLS; c++) BG.gfx.text(ctx, String.fromCharCode(97 + c), MARGIN + c * CW, H - 12, { size: 10 });
    for (let r = 0; r < ROWS; r++) BG.gfx.text(ctx, String(r + 1), 12, MARGIN + r * CH, { size: 10 });
  }

  function xyToCell(x, y) {
    const c = Math.round((x - MARGIN) / CW), r = Math.round((y - MARGIN) / CH);
    if (!inb(r, c)) return null;
    if (Math.abs(x - (MARGIN + c * CW)) > CW * 0.47) return null;
    if (Math.abs(y - (MARGIN + r * CH)) > CH * 0.47) return null;
    return { r, c };
  }

  function humanClick(st, ui, x, y) {
    const cell = xyToCell(x, y);
    if (!cell) { ui.sel = null; return null; }
    const p = st.board[cell.r][cell.c];
    if (ui.sel) {
      const mv = getLegalMoves(st).find((m) => m.fr === ui.sel.r && m.fc === ui.sel.c && m.tr === cell.r && m.tc === cell.c);
      if (mv) { ui.sel = null; return mv; }
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
      let sc = BG.util.rnd();
      const cap = st.board[m.tr][m.tc];
      if (cap) sc += VAL[cap[1]] * 10;
      if (isKingAttacked(ns.board, st.turn === 'r' ? 'b' : 'r')) sc += 4;
      if (isKingAttacked(ns.board, st.turn)) sc -= 200;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    return best;
  }

  /* ---------- 自检 ---------- */
  function selfTest() {
    let st = newGame();
    BG.util.assert(getLegalMoves(st).length === 44, '开局着法数 44, got ' + getLegalMoves(st).length);
    /* 兵过河后可横走 */
    st.board[4][4] = 'rP';
    const lateral = getLegalMoves(st).some((m) => m.notation === 'e5d5');
    BG.util.assert(lateral, '过河兵可横走');
    st = newGame();
    /* 照面判定：挪开车后王对王 */
    st.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    st.board[9][4] = 'rK'; st.board[0][4] = 'bK'; st.board[5][4] = 'rR';
    st.turn = 'r'; st.moveNum = 0; st.last = null; st.result = null;
    BG.util.assert(!getLegalMoves(st).some((m) => m.notation === 'f6b6'), '挪车露将对王非法');
    /* 绝杀：双车夹杀 */
    st.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    st.board[9][4] = 'rK'; st.board[0][4] = 'bK';
    st.board[0][0] = 'rR'; st.board[1][4] = 'rR'; st.board[8][4] = 'rR';
    st.turn = 'b'; st.moveNum = 10; st.last = null; st.result = null;
    const g = getStatus(st);
    BG.util.assert(g.over && g.winner === 'r' && g.reason === '绝杀', '双车绝杀判定, got ' + JSON.stringify(g));
  }

  BG.register({
    id: 'xiangqi', name: '象 棋',
    sides: [{ id: 'r', name: '红方', first: true }, { id: 'b', name: '黑方' }],
    meta: { w: W, h: H }, supportsPass: false, supportsResign: true,
    newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
    serializeForJev, draw, humanClick, mockPick, selfTest,
  });
})();
