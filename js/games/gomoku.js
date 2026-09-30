'use strict';
/* 五子棋 15×15。坐标：列 A–O（左→右），行 1–15（上→下），记法如 H8。
 * 本文件注册两个引擎（同一套逻辑，forbidden 开关区分）：
 *   gomoku      大众模式：无禁手，五连以上即胜（默认，原有行为保持不变）
 *   gomoku-pro  职业模式（连珠规则）：黑方禁手（三三 / 四四 / 长连，落子即负），
 *               黑方仅精确五连获胜；白方无禁手，五连以上获胜 */
(function () {
  const N = 15;
  const num = (side) => (side === 'black' ? 1 : 2);
  const colName = (c) => String.fromCharCode(65 + c);
  const notation = (r, c) => colName(c) + (r + 1);
  const parseN = (n) => ({ r: parseInt(n.slice(1), 10) - 1, c: n.charCodeAt(0) - 65 });

  const DIRS4 = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const inB = (r, c) => r >= 0 && r < N && c >= 0 && c < N;

  /* 禁手名称（中文，用于终局 reason） */
  const FORBID_NAMES = { 'overline': '长连', 'double-four': '四四', 'double-three': '三三' };

  function createGomoku(id, name, forbidden) {

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

    /* ---------- 禁手判定（仅黑方） ----------
     * forbidKind(board, r, c)：board 上 (r,c) 已落黑子，返回 false | 'overline' | 'double-four' | 'double-three'。
     * 顺序：精确五连 = 胜着（非禁手）→ 长连 → 双四 → 双三。
     * isForbiddenPoint(board, r, c)：(r,c) 为空点，试探黑落子是否禁手（带快筛）。 */
    function exactFiveAt(board, r, c) {
      for (const [dr, dc] of DIRS4) {
        let len = 1;
        for (let k = 1; k < 6 && inB(r + dr * k, c + dc * k) && board[r + dr * k][c + dc * k] === 1; k++) len++;
        for (let k = 1; k < 6 && inB(r - dr * k, c - dc * k) && board[r - dr * k][c - dc * k] === 1; k++) len++;
        if (len === 5) return true;
      }
      return false;
    }
    /* 沿 d 方向含 (r,c) 的 5 窗口是否存在 4 黑 + 1 空（黑再落一子即成五） */
    function fourDir(board, r, c, dr, dc) {
      for (let s = -4; s <= 0; s++) {
        let stones = 0, empty = 0, ok = true;
        for (let k = 0; k < 5; k++) {
          const rr = r + dr * (s + k), cc = c + dc * (s + k);
          if (!inB(rr, cc)) { ok = false; break; }
          const v = board[rr][cc];
          if (v === 1) stones++;
          else if (v === 0) empty++;
          else { ok = false; break; }
        }
        if (ok && stones === 4 && empty === 1) return true;
      }
      return false;
    }
    /* p 色再落一子即成五的空格数（只需判 ≥2，命中即早退）。禁手模式下黑方的禁手空格不计入
     * （黑走不得，不是真威胁）。forbidKind 内部用 raw 版，避免与 isForbiddenPoint 互递归。 */
    function fiveCompletionsRaw(board, p, cr, cc) {
      let n = 0;
      for (const [r, c] of lineEmpties(board, cr, cc)) {
        board[r][c] = p;
        const five = isFiveAt(board, r, c, p);
        board[r][c] = 0;
        if (five) { n++; if (n >= 2) break; }
      }
      return n;
    }
    function fiveCompletions(board, p, cr, cc) {
      if (!forbidden || p !== 1) return fiveCompletionsRaw(board, p, cr, cc);
      let n = 0;
      for (const [r, c] of lineEmpties(board, cr, cc)) {
        if (isForbiddenPoint(board, r, c)) continue;
        board[r][c] = p;
        const five = isFiveAt(board, r, c, p);
        board[r][c] = 0;
        if (five) { n++; if (n >= 2) break; }
      }
      return n;
    }
    /* 沿 d 方向的"活三"：某空格 E（距 (r,c) ≤4）落黑后成活四（≥2 个成五点）。
     * 操作式定义，覆盖跳活三等非连续形状；用 raw 计数避免递归。 */
    function threeDir(board, r, c, dr, dc) {
      for (let k = -4; k <= 4; k++) {
        if (k === 0) continue;
        const er = r + dr * k, ec = c + dc * k;
        if (!inB(er, ec) || board[er][ec] !== 0) continue;
        board[er][ec] = 1;
        const open = fiveCompletionsRaw(board, 1, er, ec) >= 2;
        board[er][ec] = 0;
        if (open) return true;
      }
      return false;
    }
    function forbidKind(board, r, c) {
      for (const [dr, dc] of DIRS4) {
        let len = 1;
        for (let k = 1; k < 6 && inB(r + dr * k, c + dc * k) && board[r + dr * k][c + dc * k] === 1; k++) len++;
        for (let k = 1; k < 6 && inB(r - dr * k, c - dc * k) && board[r - dr * k][c - dc * k] === 1; k++) len++;
        if (len === 5) return false; /* 精确五连是胜着，不是禁手 */
        if (len >= 6) return 'overline';
      }
      let fours = 0, threes = 0;
      for (const [dr, dc] of DIRS4) {
        if (fourDir(board, r, c, dr, dc)) { fours++; continue; }
        if (threeDir(board, r, c, dr, dc)) threes++;
      }
      if (fours >= 2) return 'double-four';
      if (threes >= 2) return 'double-three';
      return false;
    }
    function isForbiddenPoint(board, r, c) {
      /* 快筛：禁手至少需要落子后某方向已有 ≥2 黑子（3 子才谈得上三/四/五/长连） */
      let possible = false;
      for (const [dr, dc] of DIRS4) {
        let n = 0;
        for (let k = 1; k <= 4; k++) {
          if (inB(r + dr * k, c + dc * k) && board[r + dr * k][c + dc * k] === 1) { n++; if (n >= 2) break; }
          if (inB(r - dr * k, c - dc * k) && board[r - dr * k][c - dc * k] === 1) { n++; if (n >= 2) break; }
        }
        if (n >= 2) { possible = true; break; }
      }
      if (!possible) return false;
      board[r][c] = 1;
      const kind = forbidKind(board, r, c);
      board[r][c] = 0;
      return kind;
    }
    /* 当前局面黑方全部禁手点（Jev 提示用；与走子方无关，只描述黑方视角） */
    function forbiddenPoints(board) {
      const out = [];
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          if (board[r][c] === 0 && isForbiddenPoint(board, r, c)) out.push(notation(r, c));
        }
      }
      return out;
    }

    /* ---------- VCF 威胁空间搜索（棋盘级高速版） ----------
     * 只沿"逼迫招法"展开：攻击方每步须造出 ≥1 个致胜点（冲四/活四），防守方
     * 唯一应对是堵住唯一的致胜点。分支因子极小，可看 6-8 步深。
     * 理论依据（递归中无需检查防守方反杀）：防守方的即时致胜点不可能因攻击方
     * 落子而新增——五连须同色，攻击子不可能成为防守方五连的一部分；且搜索入口
     * 要求双方开局即无一步杀（调用方保证 win/block 为空），故防守方在链条中
     * 永远没有"不堵反而将死"的选项（唯一的例外是防守反击造杀，属 VCT 范畴，
     * 本搜索不覆盖，已在文档中声明为局限）。
     * vcfWin(st, attackerId, maxPlies)：st.turn 应为 attackerId。
     * 返回 { win, first, line }（记法）；无将死链时 { win:false, first:null, line:[] }。
     * 禁手模式：黑方攻击时禁手点不可走；黑方防守时禁手堵点视为堵不住（攻方胜）；
     * 黑方致胜点须为精确五连（长连不算赢，见 winsAfter 内过滤）。 */
    function vcfWin(st, attackerId, maxPlies) {
      const A = attackerId === 'black' ? 1 : 2;
      const D = A === 1 ? 2 : 1;
      const board = st.board.map((row) => row.slice()); /* 试走用拷贝，不碰原状态 */
      let nodes = 0;
      const NODE_LIMIT = 4000;
      maxPlies = Math.max(1, Math.min(15, maxPlies | 0 || 7));

      /* (r,c) 已落 p 子，找 p 的致胜点。只查过 (r,c) 的四线：新增致胜点必用 (r,c)，
       * 否则落子前就已存在——与入口"双方无一步杀"矛盾。 */
      function winsAfter(r, c, p) {
        const out = [];
        const seenKeys = new Set();
        for (const [dr, dc] of DIRS4) {
          for (let s = -4; s <= 0; s++) {
            let stones = 0, er = -1, ec = -1, ok = true;
            for (let k = 0; k < 5; k++) {
              const rr = r + dr * (s + k), cc = c + dc * (s + k);
              if (!inB(rr, cc)) { ok = false; break; }
              const v = board[rr][cc];
              if (v === p) stones++;
              else if (v === 0) {
                if (er >= 0) { ok = false; break; }
                er = rr; ec = cc;
              } else { ok = false; break; }
            }
            if (ok && stones === 4 && er >= 0) {
              const key = er * 15 + ec;
              if (seenKeys.has(key)) continue;
              if (forbidden && p === 1) {
                /* 黑方精确五连才是真致胜点：长连不算赢（且该点本身禁手） */
                board[er][ec] = 1;
                const exact = exactFiveAt(board, er, ec);
                board[er][ec] = 0;
                if (!exact) continue;
              }
              seenKeys.add(key);
              out.push([er, ec]);
            }
          }
        }
        return out;
      }

      /* A 的逼迫着法：落子后有 ≥1 致胜点的空点。只扫 A 子周围（切比雪夫距离 ≤3；
       * 造四须贴着己子，3 格足够且保守），按致胜点数降序取前 12 个。 */
      function forcingMoves() {
        const cand = new Set();
        for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
          if (board[r][c] !== A) continue;
          for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
            const rr = r + dr, cc = c + dc;
            if (inB(rr, cc) && board[rr][cc] === 0) cand.add(rr * 15 + cc);
          }
        }
        const out = [];
        for (const key of cand) {
          if (++nodes > NODE_LIMIT) break;
          const r = (key / 15) | 0, c = key % 15;
          if (forbidden && A === 1 && isForbiddenPoint(board, r, c)) continue;
          board[r][c] = A;
          const wins = winsAfter(r, c, A);
          board[r][c] = 0;
          if (wins.length > 0) out.push({ r, c, wins });
        }
        out.sort((a, b) => b.wins.length - a.wins.length);
        return out.slice(0, 12);
      }

      function search(pliesLeft) {
        if (pliesLeft <= 0 || nodes > NODE_LIMIT) return null;
        const moves = forcingMoves();
        for (const m of moves) {
          if (m.wins.length >= 2) return [[m.r, m.c]]; /* 双杀：对方至多堵其一 */
          const wr = m.wins[0][0], wc = m.wins[0][1];
          /* 黑方防守时禁手堵点 = 堵不住，攻方直接胜 */
          if (forbidden && D === 1 && isForbiddenPoint(board, wr, wc)) return [[m.r, m.c]];
          board[m.r][m.c] = A;
          board[wr][wc] = D;
          const sub = search(pliesLeft - 2);
          board[wr][wc] = 0;
          board[m.r][m.c] = 0;
          if (sub) return [[m.r, m.c], [wr, wc], ...sub];
        }
        return null;
      }

      const line = search(maxPlies);
      if (!line) return { win: false, first: null, line: [] };
      const toN = (rc) => notation(rc[0], rc[1]);
      return { win: true, first: toN(line[0]), line: line.map(toN) };
    }

    function getLegalMoves(st) {
      const ms = [];
      const ban = forbidden && st.turn === 'black';
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          if (st.board[r][c] !== 0) continue;
          if (ban && isForbiddenPoint(st.board, r, c)) continue;
          ms.push({ notation: notation(r, c), desc: null, r, c });
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
        if (forbidden && p === 1) {
          /* 黑方：精确五连才算赢；长连/双三/双四判负（正常对局走不到，安全网） */
          if (exactFiveAt(st.board, r, c)) {
            return { over: true, winner: 'black', reason: '五连' };
          }
          const fk = forbidKind(st.board, r, c);
          if (fk) {
            return { over: true, winner: 'white', reason: '黑方禁手（' + FORBID_NAMES[fk] + '）' };
          }
        } else {
          const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
          for (const [dr, dc] of dirs) {
            if (lineLen(st, r, c, dr, dc) >= 5) {
              return { over: true, winner: p === 1 ? 'black' : 'white', reason: '五连' };
            }
          }
        }
      }
      if (st.moveNum >= N * N) return { over: true, winner: null, reason: '棋盘已满' };
      return { over: false, turn: st.turn };
    }

    function moveFromNotation(st, n) {
      const { r, c } = parseN(n);
      if (r < 0 || r >= N || c < 0 || c >= N || st.board[r][c] !== 0) return null;
      if (forbidden && st.turn === 'black' && isForbiddenPoint(st.board, r, c)) return null;
      return { notation: n, desc: null, r, c };
    }

    /* ---------- Jev 序列化 ---------- */
    const SCORE_LEVELS = ['0-2 clearly losing', '3-4 slightly worse', '5 roughly even', '6-7 slightly better', '8-10 clearly winning'];
    const RULES_FREE = 'Free-style gomoku, no forbidden moves: first to align five or more of their own stones horizontally, vertically or diagonally wins; a full board is a draw.';
    const RULES_PRO = 'Renju-style gomoku with forbidden moves for Black: Black (the first player) must NEVER play a point that forms double-three, double-four or overline (six or more stones in a row) — playing such a forbidden point loses the game immediately. Black wins only with EXACTLY five stones in a row (overline does not count as a win). White has no forbidden moves and wins with five or more stones in a row. A full board is a draw.';

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
     * 组合如 "you:open4+deny:open4"（双料点）。判定全部走真实推演，非模式匹配。
     * 禁手模式：黑方的禁手空格不成其为"威胁"（走不得），deny 标签跳过黑的禁手点。 */
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
      const winsNow = (forbidden && me === 1) ? exactFiveAt(mine, r, c) : isFiveAt(mine, r, c, me);
      if (winsNow) return 'win';
      const myComps = fiveCompletions(mine, me, r, c);
      if (myComps >= 2) parts.push('you:open4');
      else if (myComps === 1) parts.push('you:four');
      else if (DIRS4.some(([dr, dc]) => liveThreeDir(mine, r, c, me, dr, dc))) parts.push('you:live3');
      const theirs = BG.util.clone(st.board); theirs[r][c] = opp;
      if (forbidden && opp === 1) {
        /* 对手是黑：精确五连才需 block；禁手点黑走不得，直接跳过 deny */
        if (exactFiveAt(theirs, r, c)) parts.push('block:five');
        else if (!forbidKind(theirs, r, c)) {
          const opComps = fiveCompletions(theirs, opp, r, c);
          if (opComps >= 2) parts.push('deny:open4');
          else if (opComps === 1) parts.push('deny:four');
          else if (DIRS4.some(([dr, dc]) => liveThreeDir(theirs, r, c, opp, dr, dc))) parts.push('deny:live3');
        }
      } else {
        if (isFiveAt(theirs, r, c, opp)) parts.push('block:five');
        else {
          const opComps = fiveCompletions(theirs, opp, r, c);
          if (opComps >= 2) parts.push('deny:open4');
          else if (opComps === 1) parts.push('deny:four');
          else if (DIRS4.some(([dr, dc]) => liveThreeDir(theirs, r, c, opp, dr, dc))) parts.push('deny:live3');
        }
      }
      return parts.join('+');
    }

    function serializeForJev(st, side) {
      const cand = candidates(st, 64);
      const notations = cand.map((m) => m.notation);
      const me = num(side);
      const criteria = {};
      cand.forEach((m) => { criteria[m.notation] = labelPoint(st, m.r, m.c, me) || null; });
      const state = {
        game: 'gomoku (five-in-a-row) on 15x15 board, columns A-O left to right, rows 1-15 top to bottom',
        rules: forbidden ? RULES_PRO : RULES_FREE,
        /* 板斧一：模型读二维字符画远比读坐标列表准；裁剪到有子区域外扩 2 格省 token */
        board_ascii: boardAscii(st),
        board_note: 'X = black stones, O = white stones, a lowercase letter marks the last move, "." is empty; the grid is cropped to the active area with a 2-cell margin. Column letters on top, row numbers on the left.',
        you_play: side,
        move_number: st.moveNum + 1,
        black_stones: stonesOf(st, 1),
        white_stones: stonesOf(st, 2),
        last_move: st.last ? st.last.side + ' ' + st.last.notation : 'none (opening)',
        legal_moves: notations,
      };
      let forbidNote = '';
      if (forbidden) {
        /* 黑方禁手点清单：黑白双方都需要知道（黑避开，白可利用） */
        state.forbidden_points_black = forbiddenPoints(st.board);
        if (side === 'black') {
          forbidNote = ' You play BLACK under Renju forbidden-move rules: NEVER choose a point from `forbidden_points_black` — playing it loses the game instantly. You win only with EXACTLY five stones in a row; six or more in a row is forbidden and loses.';
        } else {
          forbidNote = ' Your opponent Black plays under Renju forbidden-move rules and can never play the points listed in `forbidden_points_black` — threats that rely on those points are not real threats for Black.';
        }
      }
      return {
        state,
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
              forbidNote +
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
      if (forbidden && st.turn === 'black' && isForbiddenPoint(st.board, cell.r, cell.c)) return null;
      return { notation: notation(cell.r, cell.c), desc: null, r: cell.r, c: cell.c };
    }

    /* ---------- mock 启发式 ---------- */
    function wouldWin(st, m, side) {
      const s = BG.util.clone(st);
      s.board[m.r][m.c] = num(side);
      if (forbidden && side === 'black') {
        /* 黑方精确五连才算赢；长连/禁手不算（也不会被走出） */
        return exactFiveAt(s.board, m.r, m.c);
      }
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
      BG.util.assert(getLegalMoves(st).length === 225, '初始 225 个空点（空盘无禁手）');
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

      if (!forbidden) return;
      /* 禁手模式专项：三三 / 四四 / 长连 / 精确五连 / 白方豁免 */
      const mk = () => { const s = newGame(); return s; };
      const put = (s, r, c, p) => { s.board[r][c] = p; s.moveNum++; };
      // 双三：黑 (6,7),(7,6),(7,8),(8,7)，落 (7,7)=H8 横竖各成活三
      let s2 = mk();
      put(s2, 6, 7, 1); put(s2, 7, 6, 1); put(s2, 7, 8, 1); put(s2, 8, 7, 1);
      put(s2, 0, 0, 2); put(s2, 0, 1, 2);
      s2.turn = 'black';
      BG.util.assert(isForbiddenPoint(s2.board, 7, 7) === 'double-three', 'H8 应为双三禁手');
      BG.util.assert(!getLegalMoves(s2).some((m) => m.r === 7 && m.c === 7), '禁手点应从黑方合法着法剔除');
      BG.util.assert(!moveFromNotation(s2, 'H8'), '禁手记法应解析为 null');
      BG.util.assert(!humanClick(s2, {}, MARGIN + 7 * CELL, MARGIN + 7 * CELL), '禁手点点击应无着法');
      // 双四：黑 (7,5),(7,6),(7,8) + (5,7),(6,7),(8,7)，落 (7,7) 横竖各成四
      let s3 = mk();
      put(s3, 7, 5, 1); put(s3, 7, 6, 1); put(s3, 7, 8, 1);
      put(s3, 5, 7, 1); put(s3, 6, 7, 1); put(s3, 8, 7, 1);
      s3.turn = 'black';
      BG.util.assert(isForbiddenPoint(s3.board, 7, 7) === 'double-four', 'H8 应为双四禁手');
      // 长连：黑 (7,4)-(7,8)，落 (7,9)=J8 成六连
      let s4 = mk();
      put(s4, 7, 4, 1); put(s4, 7, 5, 1); put(s4, 7, 6, 1); put(s4, 7, 7, 1); put(s4, 7, 8, 1);
      s4.turn = 'black';
      BG.util.assert(isForbiddenPoint(s4.board, 7, 9) === 'overline', 'J8 应为长连禁手');
      // 精确五连是胜着非禁手：黑 (7,5)-(7,8)，落 (7,4)=E8
      let s5 = mk();
      put(s5, 7, 5, 1); put(s5, 7, 6, 1); put(s5, 7, 7, 1); put(s5, 7, 8, 1);
      put(s5, 0, 0, 2);
      s5.turn = 'black';
      BG.util.assert(!isForbiddenPoint(s5.board, 7, 4), 'E8 精确五连不应判禁手');
      const s5b = applyMove(s5, moveFromNotation(s5, 'E8'));
      const r5 = getStatus(s5b);
      BG.util.assert(r5.over && r5.winner === 'black' && r5.reason === '五连', '黑方精确五连获胜');
      // 白方无禁手：白摆出双三形状也不禁
      let s6 = mk();
      put(s6, 6, 7, 2); put(s6, 7, 6, 2); put(s6, 7, 8, 2); put(s6, 8, 7, 2);
      s6.turn = 'white';
      BG.util.assert(getLegalMoves(s6).some((m) => m.r === 7 && m.c === 7), '白方无禁手，H8 应合法');
      BG.util.assert(moveFromNotation(s6, 'H8') !== null, '白方 H8 记法应合法');
      // 序列化带禁手清单与规则文本
      const ser = serializeForJev(s2, 'black');
      BG.util.assert(typeof ser.state.rules === 'string' && /forbidden/i.test(ser.state.rules), '禁手模式 rules 应描述禁手');
      BG.util.assert(Array.isArray(ser.state.forbidden_points_black) && ser.state.forbidden_points_black.indexOf('H8') >= 0, '禁手清单应含 H8');
      BG.util.assert(/forbidden_points_black/.test(ser.questions.move.instructions), '黑方指令应提及禁手清单');
    }

    return {
      id, name,
      sides: [{ id: 'black', name: '黑方', first: true }, { id: 'white', name: '白方' }],
      meta: { w: W, h: H }, supportsPass: false, supportsResign: true,
      /* 2-ply 造杀扫描：候选点是无色差的空点集，适合通用双杀检测（见 jev-client computeTactics） */
      deepTactics: true,
      /* VCF 威胁空间搜索：连续冲四将死链（见 jev-client vcfAttack/vcfDefense） */
      vcfWin,
      newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
      serializeForJev, draw, humanClick, mockPick, selfTest,
    };
  }

  BG.register(createGomoku('gomoku', '五子棋', false));
  BG.register(createGomoku('gomoku-pro', '五子棋·禁手', true));
})();
