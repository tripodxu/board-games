/* gomoku.ts — 五子棋 15×15（迁移自 js/games/gomoku.js）
 *
 * 坐标：列 A–O（左→右），行 1–15（上→下），记法如 H8。
 * 本文件提供两个引擎（同一套逻辑，forbidden 开关区分）：
 *   gomoku      大众模式：无禁手，五连以上即胜（默认，原有行为保持不变）
 *   gomoku-pro  职业模式（连珠规则）：黑方禁手（三三 / 四四 / 长连，落子即负），
 *               黑方仅精确五连获胜；白方无禁手，五连以上获胜
 *
 * 移植说明：`createGomoku(id, name, forbidden)` 工厂原样保留，只是把 `BG.register`
 * 换成调用方按需注册（见 ./registry.ts）；战术层（labelPoint / vcfWin）逐字等价。
 */
import { assert } from '../assert.ts';
import { clone } from '../clone.ts';
import { rnd } from '../rng.ts';
import { gfx } from '../gfx.ts';
import type { Canvas2D } from '../gfx.ts';
import type { Engine, GameStatus, JevSerialized, Live3Deny, Live3Options, Move, PickConfig, PressureCutOptions, PressureCutResult, UiState, VcfOptions, VcfResult, VctDefenseOptions, VctDefenseResult, VctOptions } from '../types.ts';

const N = 15;
const num = (side: string): number => (side === 'black' ? 1 : 2);
const colName = (c: number): string => String.fromCharCode(65 + c);
const notation = (r: number, c: number): string => colName(c) + (r + 1);
const parseN = (n: string): { r: number; c: number } => ({ r: parseInt(n.slice(1), 10) - 1, c: n.charCodeAt(0) - 65 });

const DIRS4: number[][] = [[0, 1], [1, 0], [1, 1], [1, -1]];
const inB = (r: number, c: number): boolean => r >= 0 && r < N && c >= 0 && c < N;
/** 破活三时最多评估几个候选点（每个都要重数一遍对手的 L3，故设上限保证毫秒级）。 */
const LIVE3_DENY_EVAL_MAX = 24;

/* 禁手名称（中文，用于终局 reason） */
const FORBID_NAMES: Record<string, string> = { 'overline': '长连', 'double-four': '四四', 'double-three': '三三' };

/** 棋盘：0 空 / 1 黑 / 2 白。 */
type Board = number[][];
/** 一手棋：总是落在 (r,c)。 */
interface GomokuMove extends Move {
  r: number;
  c: number;
}
interface GomokuState {
  board: Board;
  turn: string;
  moveNum: number;
  last: { notation: string; r: number; c: number; side: string } | null;
  result: GameStatus | null;
}
/** 一个逼迫着法候选及其致胜点。 */
interface Forcing { r: number; c: number; wins: number[][] }

/**
 * 造一个五子棋引擎。`forbidden` 为 true 时启用连珠禁手（仅黑方）。
 * 旧实现注册两个 id：'gomoku'（false）与 'gomoku-pro'（true）。
 */
export function createGomoku(id: string, name: string, forbidden: boolean): Engine<GomokuState> {

  function newGame(): GomokuState {
    return {
      board: Array.from({ length: N }, () => Array<number>(N).fill(0)),
      turn: 'black', moveNum: 0, last: null, result: null,
    };
  }

  function lineLen(st: GomokuState, r: number, c: number, dr: number, dc: number): number {
    const p = st.board[r]![c];
    let n = 1;
    for (let i = 1; i < 5; i++) {
      const rr = r + dr * i, cc = c + dc * i;
      if (rr < 0 || rr >= N || cc < 0 || cc >= N || st.board[rr]![cc] !== p) break;
      n++;
    }
    for (let i = 1; i < 5; i++) {
      const rr = r - dr * i, cc = c - dc * i;
      if (rr < 0 || rr >= N || cc < 0 || cc >= N || st.board[rr]![cc] !== p) break;
      n++;
    }
    return n;
  }

  /* ---------- 禁手判定（仅黑方） ----------
   * forbidKind(board, r, c)：board 上 (r,c) 已落黑子，返回 false | 'overline' | 'double-four' | 'double-three'。
   * 顺序：精确五连 = 胜着（非禁手）→ 长连 → 双四 → 双三。
   * isForbiddenPoint(board, r, c)：(r,c) 为空点，试探黑落子是否禁手（带快筛）。 */
  function exactFiveAt(board: Board, r: number, c: number): boolean {
    for (const [dr, dc] of DIRS4) {
      let len = 1;
      for (let k = 1; k < 6 && inB(r + dr! * k, c + dc! * k) && board[r + dr! * k]![c + dc! * k] === 1; k++) len++;
      for (let k = 1; k < 6 && inB(r - dr! * k, c - dc! * k) && board[r - dr! * k]![c - dc! * k] === 1; k++) len++;
      if (len === 5) return true;
    }
    return false;
  }
  /* 沿 d 方向含 (r,c) 的 5 窗口是否存在 4 黑 + 1 空（黑再落一子即成五） */
  function fourDir(board: Board, r: number, c: number, dr: number, dc: number): boolean {
    for (let s = -4; s <= 0; s++) {
      let stones = 0, empty = 0, ok = true;
      for (let k = 0; k < 5; k++) {
        const rr = r + dr * (s + k), cc = c + dc * (s + k);
        if (!inB(rr, cc)) { ok = false; break; }
        const v = board[rr]![cc];
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
  function fiveCompletionsRaw(board: Board, p: number, cr: number, cc: number): number {
    let n = 0;
    for (const [r, c] of lineEmpties(board, cr, cc)) {
      board[r!]![c!] = p;
      const five = isFiveAt(board, r!, c!, p);
      board[r!]![c!] = 0;
      if (five) { n++; if (n >= 2) break; }
    }
    return n;
  }
  function fiveCompletions(board: Board, p: number, cr: number, cc: number): number {
    if (!forbidden || p !== 1) return fiveCompletionsRaw(board, p, cr, cc);
    let n = 0;
    for (const [r, c] of lineEmpties(board, cr, cc)) {
      if (isForbiddenPoint(board, r!, c!)) continue;
      board[r!]![c!] = p;
      const five = isFiveAt(board, r!, c!, p);
      board[r!]![c!] = 0;
      if (five) { n++; if (n >= 2) break; }
    }
    return n;
  }
  /* 沿 d 方向的"活三"：某空格 E（距 (r,c) ≤4）落黑后成活四（≥2 个成五点）。
   * 操作式定义，覆盖跳活三等非连续形状；用 raw 计数避免递归。 */
  function threeDir(board: Board, r: number, c: number, dr: number, dc: number): boolean {
    for (let k = -4; k <= 4; k++) {
      if (k === 0) continue;
      const er = r + dr * k, ec = c + dc * k;
      if (!inB(er, ec) || board[er]![ec] !== 0) continue;
      board[er]![ec] = 1;
      const open = fiveCompletionsRaw(board, 1, er, ec) >= 2;
      board[er]![ec] = 0;
      if (open) return true;
    }
    return false;
  }
  function forbidKind(board: Board, r: number, c: number): string | false {
    for (const [dr, dc] of DIRS4) {
      let len = 1;
      for (let k = 1; k < 6 && inB(r + dr! * k, c + dc! * k) && board[r + dr! * k]![c + dc! * k] === 1; k++) len++;
      for (let k = 1; k < 6 && inB(r - dr! * k, c - dc! * k) && board[r - dr! * k]![c - dc! * k] === 1; k++) len++;
      if (len === 5) return false; /* 精确五连是胜着，不是禁手 */
      if (len >= 6) return 'overline';
    }
    let fours = 0, threes = 0;
    for (const [dr, dc] of DIRS4) {
      if (fourDir(board, r, c, dr!, dc!)) { fours++; continue; }
      if (threeDir(board, r, c, dr!, dc!)) threes++;
    }
    if (fours >= 2) return 'double-four';
    if (threes >= 2) return 'double-three';
    return false;
  }
  function isForbiddenPoint(board: Board, r: number, c: number): string | false {
    /* 快筛：禁手至少需要落子后某方向已有 ≥2 黑子（3 子才谈得上三/四/五/长连） */
    let possible = false;
    for (const [dr, dc] of DIRS4) {
      let n = 0;
      for (let k = 1; k <= 4; k++) {
        if (inB(r + dr! * k, c + dc! * k) && board[r + dr! * k]![c + dc! * k] === 1) { n++; if (n >= 2) break; }
        if (inB(r - dr! * k, c - dc! * k) && board[r - dr! * k]![c - dc! * k] === 1) { n++; if (n >= 2) break; }
      }
      if (n >= 2) { possible = true; break; }
    }
    if (!possible) return false;
    board[r]![c] = 1;
    const kind = forbidKind(board, r, c);
    board[r]![c] = 0;
    return kind;
  }
  /* 当前局面黑方全部禁手点（Jev 提示用；与走子方无关，只描述黑方视角） */
  function forbiddenPoints(board: Board): string[] {
    const out: string[] = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (board[r]![c] === 0 && isForbiddenPoint(board, r, c)) out.push(notation(r, c));
      }
    }
    return out;
  }

  /* ---------- VCF 威胁空间搜索（棋盘级高速版） ----------
   * 只沿"逼迫招法"展开：攻击方每步须造出 ≥1 个致胜点（冲四/活四），防守方
   * 唯一应对是堵住唯一的致胜点。分支因子极小，可看 6-8 步深。
   * soundness 前提（关键，缺了就会返回"伪胜"）：攻方造四后守方被迫堵的那一手，
   * 可能顺手给守方自己造出四。于是轮到攻方时守方已有即时致胜点，守方下一手
   * 直接成五，攻方后面那些双杀/冲四永远兑现不了，链子是假的。
   * 故每层进入时算出守方即时致胜点 dWins：非空则攻方这一手必须占掉它（一步
   * 只能占一个点，≥2 个时无解），否则该分支不是将死链，直接跳过。
   * 守方的即时致胜点只能由守方自己的新子产生（攻子进不了守方五连），故只需
   * 查经过"本层堵点"的四线；入口没有"最后一手"可依附，做一次全盘扫。
   * vcfWin(st, attackerId, maxPlies, opts)：st.turn 应为 attackerId。
   * opts（P1 冻结层，缺省 = 历史常量，见 src/core/tactics-budget.ts）：
   *   sound=false 关掉上面的 soundness 闸门 → 回到 v7/v8 的旧语义（守方手握即时致胜点时
   *   也照样报「将死链」，即历史上那批不健全的链；只有考古/复现 v7/v8 时才该这么用）；
   *   nodeLimit / movesMax 收放搜索面（只允许收紧，见 AGENTS.md 规则 10）。
   * 返回 { win, first, line }（记法）；无将死链时 { win:false, first:null, line:[] }。
   * 禁手模式：黑方攻击时禁手点不可走；黑方防守时禁手堵点视为堵不住（攻方胜）；
   * 黑方致胜点须为精确五连（长连不算赢，见 winsAfter 内过滤）。 */
  function vcfWin(st: GomokuState, attackerId: string, maxPlies?: number, opts?: VcfOptions): VcfResult {
    const A = attackerId === 'black' ? 1 : 2;
    const D = A === 1 ? 2 : 1;
    const board = st.board.map((row) => row.slice()); /* 试走用拷贝，不碰原状态 */
    let nodes = 0;
    const NODE_LIMIT = 4000;
    const nodeLimit = opts?.nodeLimit && opts.nodeLimit > 0 ? opts.nodeLimit : NODE_LIMIT;
    const movesMax = opts?.movesMax && opts.movesMax > 0 ? opts.movesMax : 12;
    const sound = opts?.sound !== false;
    maxPlies = Math.max(1, Math.min(15, maxPlies! | 0 || 7));

    /* (r,c) 已落 p 子，找 p 的致胜点。只查过 (r,c) 的四线：新增致胜点必用 (r,c)，
     * 否则落子前就已存在——与入口"双方无一步杀"矛盾。 */
    function winsAfter(r: number, c: number, p: number): number[][] {
      const out: number[][] = [];
      const seenKeys = new Set<number>();
      for (const [dr, dc] of DIRS4) {
        for (let s = -4; s <= 0; s++) {
          let stones = 0, er = -1, ec = -1, ok = true;
          for (let k = 0; k < 5; k++) {
            const rr = r + dr! * (s + k), cc = c + dc! * (s + k);
            if (!inB(rr, cc)) { ok = false; break; }
            const v = board[rr]![cc];
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
              board[er]![ec] = 1;
              const exact = exactFiveAt(board, er, ec);
              board[er]![ec] = 0;
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
    function forcingMoves(): Forcing[] {
      const cand = new Set<number>();
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (board[r]![c] !== A) continue;
        for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
          const rr = r + dr, cc = c + dc;
          if (inB(rr, cc) && board[rr]![cc] === 0) cand.add(rr * 15 + cc);
        }
      }
      const out: Forcing[] = [];
      for (const key of cand) {
        if (++nodes > nodeLimit) break;
        const r = (key / 15) | 0, c = key % 15;
        if (forbidden && A === 1 && isForbiddenPoint(board, r, c)) continue;
        board[r]![c] = A;
        const wins = winsAfter(r, c, A);
        board[r]![c] = 0;
        if (wins.length > 0) out.push({ r, c, wins });
      }
      out.sort((a, b) => b.wins.length - a.wins.length);
      return out.slice(0, movesMax);
    }

    /* 守方在全盘的即时致胜点（只有入口用：入口没有"守方最后一手"可依附，只能全扫） */
    function defenderWinsFull(): number[][] {
      const out: number[][] = [];
      const seenKeys = new Set<number>();
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (board[r]![c] !== D) continue;
        for (const w of winsAfter(r, c, D)) {
          const key = w[0]! * 15 + w[1]!;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          out.push(w);
        }
      }
      return out;
    }

    /* dWins = 当前盘面上守方的即时致胜点（轮到攻方走）。sound=false 时不算也不算（旧语义）。 */
    function search(pliesLeft: number, dWins: number[][]): number[][] | null {
      if (pliesLeft <= 0 || nodes > nodeLimit) return null;
      const moves = forcingMoves();
      for (const m of moves) {
        /* soundness 闸门：守方手上有即时致胜点时，攻方这一手必须占掉它，否则守方
         * 下一手直接成五，这条链走不到最后（一步只能占一个点，≥2 个点时无解）。 */
        if (sound && dWins.length && !(dWins.length === 1 && dWins[0]![0] === m.r && dWins[0]![1] === m.c)) continue;
        if (m.wins.length >= 2) return [[m.r, m.c]]; /* 双杀：对方至多堵其一 */
        const wr = m.wins[0]![0]!, wc = m.wins[0]![1]!;
        /* 黑方防守时禁手堵点 = 堵不住，攻方直接胜 */
        if (forbidden && D === 1 && isForbiddenPoint(board, wr, wc)) return [[m.r, m.c]];
        board[m.r]![m.c] = A;
        board[wr]![wc] = D;
        /* 堵点后守方新产生的即时致胜点只能经过 (wr,wc)（攻子进不了守方五连） */
        const sub = search(pliesLeft - 2, sound ? winsAfter(wr, wc, D) : []);
        board[wr]![wc] = 0;
        board[m.r]![m.c] = 0;
        if (sub) return [[m.r, m.c], [wr, wc], ...sub];
      }
      return null;
    }

    const line = search(maxPlies, sound ? defenderWinsFull() : []);
    if (!line) return { win: false, first: null, line: [] };
    const toN = (rc: number[]): string => notation(rc[0]!, rc[1]!);
    return { win: true, first: toN(line[0]!), line: line.map(toN) };
  }

  /* ---------- v10 战术层：活三制造点的真推演（4-ply 威胁） ----------
   * 与 labelPoint 的 liveThreeDir（只认连续 XXX 一种形状）互补：那里认不出的
   * 跳活三 / 斜向组合 / 带空隙的四，这里用与 fiveCompletions 同一把尺推演：
   *   L1 五点      ：落子即五连
   *   L2 活四制造点：落子后 fiveCompletions ≥ 2 —— 两个成五点，对手挡不住（2 手内必胜）
   *   L3 活三制造点：落子后存在 ≥2 个 L2 —— 对手只能挡一个（4 手内必胜）
   * L3 点必与己方子力相邻（落子后要造四，须与己子同线且相邻），故候选集沿用
   * 「距任意棋子切比雪夫 ≤2」的邻域空点。全程在拷贝上落子 / 撤销，不动调用方状态。
   * 禁手模式下黑方的禁手点不算威胁（黑走不得；双三在连珠规则里本来就禁）。 */
  function nearEmpties(board: Board): number[][] {
    const out: number[][] = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (board[r]![c] !== 0) continue;
        let near = false;
        for (let dr = -2; dr <= 2 && !near; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            if (inB(r + dr, c + dc) && board[r + dr]![c + dc] !== 0) { near = true; break; }
          }
        }
        if (near) out.push([r, c]);
      }
    }
    return out;
  }
  /** 落 (r,c)（调用方保证为空）后是否 ≥2 个成五点（＝对手挡不住的四）。 */
  function openFourAfter(board: Board, p: number, r: number, c: number): boolean {
    board[r]![c] = p;
    const n = fiveCompletions(board, p, r, c);
    board[r]![c] = 0;
    return n >= 2;
  }
  /** p 方当前的 L2 点集合（＝落子后 ≥2 个成五点，即活四制造点），键 = r*N+c。v14 纠偏的基线。 */
  function l2Set(board: Board, p: number, cands: number[][]): Set<number> {
    const s = new Set<number>();
    for (const [r, c] of cands) {
      if (board[r]![c] !== 0) continue;
      if (openFourAfter(board, p, r, c)) s.add(r * N + c);
    }
    return s;
  }
  /** 落 (r,c)（调用方保证为空）后是否形成 L3（≥2 个 L2 点）。
   *  给了 before（落子前本方的 L2 集合）就只数**这一手新造**的 L2 点（v14 纠偏口径）；
   *  不给 = 旧口径（只要求「落子后存在 ≥2 个 L2 点」，本方既有活四制造点会把任意闲棋放大成 L3）。 */
  function live3After(board: Board, p: number, r: number, c: number, cands: number[][], before?: Set<number>): boolean {
    board[r]![c] = p;
    let cnt = 0;
    for (const [qr, qc] of cands) {
      if (board[qr]![qc] !== 0) continue;
      if (before && before.has(qr * N + qc)) continue;
      if (openFourAfter(board, p, qr, qc)) { cnt++; if (cnt >= 2) break; }
    }
    board[r]![c] = 0;
    return cnt >= 2;
  }
  /** 数 p 方当前有几个 L3 点；数到 limit 就早退（调用方用返回值的截断语义做比较）。
   *  fresh（v14）＝按「新造」口径数（基线只算一次，摊到每个候选上）。 */
  function live3Count(board: Board, p: number, cands: number[][], limit: number, fresh?: boolean): number {
    const before = fresh ? l2Set(board, p, cands) : undefined;
    let cnt = 0;
    for (const [r, c] of cands) {
      if (board[r]![c] !== 0) continue;
      if (live3After(board, p, r, c, cands, before)) { cnt++; if (cnt >= limit) break; }
    }
    return cnt;
  }
  function live3Makers(st: GomokuState, sideId: string, opts?: Live3Options): string[] {
    const p = num(sideId);
    const board = clone(st.board);
    const cands = nearEmpties(board);
    const before = opts?.fresh ? l2Set(board, p, cands) : undefined;
    const out: string[] = [];
    for (const [r, c] of cands) {
      if (forbidden && p === 1 && isForbiddenPoint(board, r, c)) continue;
      if (live3After(board, p, r, c, cands, before)) out.push(notation(r, c));
    }
    return out;
  }
  /**
   * 破活三：在候选记法里挑让对手 L3 点最少的点；对手的 L3 点本身优先试（占掉最直接）。
   * 返回的 `best` 是并列最优里**最先评估到**的那些（一旦数到 after=0 就收工，不做全量枚举）：
   * 决策只需要一个够好的点，全量枚举并列会多花几倍时间，而收益（让模型在等价点里挑）很小。
   */
  function live3Deny(st: GomokuState, sideId: string, candNotations: string[], opts?: Live3Options): Live3Deny {
    const me = num(sideId), opp = me === 1 ? 2 : 1;
    const board = clone(st.board);
    const cands = nearEmpties(board);
    const fresh = opts?.fresh === true;
    const evalMax = opts?.evalMax && opts.evalMax > 0 ? opts.evalMax : LIVE3_DENY_EVAL_MAX;
    const before = live3Count(board, opp, cands, 999, fresh);
    if (before === 0) return { before: 0, after: 0, best: [] };
    const oppMakers: string[] = [];
    const oppBefore = fresh ? l2Set(board, opp, cands) : undefined;
    for (const [r, c] of cands) if (live3After(board, opp, r, c, cands, oppBefore)) oppMakers.push(notation(r, c));
    const order: string[] = [];
    const seen: Record<string, true> = {};
    for (const n of oppMakers.concat(candNotations)) {
      if (!n || seen[n]) continue;
      seen[n] = true;
      const { r, c } = parseN(n);
      if (!inB(r, c) || board[r]![c] !== 0) continue;
      if (forbidden && me === 1 && isForbiddenPoint(board, r, c)) continue;
      order.push(n);
    }
    /* 每评估一个点都要重数一遍对手的 L3，故用 best+1 截断早退；best===0 直接收工 */
    let best = before;
    let bestPoints: string[] = [];
    for (let i = 0; i < order.length && i < evalMax; i++) {
      const n = order[i]!;
      const { r, c } = parseN(n);
      board[r]![c] = me;
      const cnt = live3Count(board, opp, cands, best + 1, fresh);
      board[r]![c] = 0;
      if (cnt < best) { best = cnt; bestPoints = [n]; }
      else if (cnt === best) bestPoints.push(n);
      if (best === 0) break;
    }
    return { before, after: best, best: bestPoints };
  }

  /* ---------- v11 战术层：VCT（连续威胁搜索：冲四链 + 活三逼迫） ----------
   * v10 的 vcfWin 只搜冲四：遇到「先造活三逼迫、再用冲四收尾」的链就看不见。实测两臂
   * 24 局里，v10 有 20 手（7 局）存在 VCF-7 看不见的必胜链（其中 18 手连 11 ply 纯冲四
   * 也看不见），而当时 v10 走的是启发式的 live3Attack 点。
   *
   * 攻击方着法两类，各自配**精确的**守方应手集合：
   *   ① 冲四：落子后 1 个成五点 → 守方只有唯一点可堵；≥2 个成五点 → 当场必胜。
   *   ② 造活三：落子后**新造出** ≥2 个「落子即成五点」的点（＝下一手活四）。守方必须让
   *      这些点全失效，应手集合由 vctDefusers() 精确枚举（不是「随便堵一个端点」）。
   *      对手自己有冲四可走时这一手不算威胁（他反先一步成五，我们慢一手）。
   * 与 vcfWin 一样：拷贝上落子/撤销、禁手点对黑方跳过、黑方成五点须精确五连。
   * 返回的 `line` 是**攻击方**的着法序列（守方应手不入 line，与 vcfWin 的 line 不同）。
   *
   * **sound（不谎报必胜）的两处关键**：① 守方应手一律**枚举全盘空点**（不只邻域）——
   * 漏掉一个能守住的应手就会把和棋/败局当必胜（`vctDefusers` 的候选集来自 `allEmpties`）；
   * ② 活三逼迫要求「守方当下没有造冲四的着法」（`hasFourMove`），否则时间线是
   * 「我活三 → 他冲四 → 我活四 → 他成五」，他先赢。 */
  /* v11 VCT 搜索预算：由 .work/vct-tune.mjs / vct-tune3.mjs 在 586 个真实 proxy 回合上标定。
     缺省 14/6000/∞ 能看见 55 手必胜链，但平均 607ms / p90 2430ms / 最坏 8837ms；
     10/3000/6 同样 55 手（丢 0、多 0），平均 444ms / p90 1647ms / 最坏 4586ms ⇒ 取这组。
     三个上限都只会让搜索「少看见」，不会让它谎报必胜（sound 方向）。 */
  const VCT_NODE_LIMIT = 3000;
  const VCT_MOVES_MAX = 10;
  const VCT_DEFUSERS_MAX = 6;
  /** 全盘空点（守方应手的候选集：要证「守不住」就不能只看邻域）。 */
  function allEmpties(board: Board): number[][] {
    const out: number[][] = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (board[r]![c] === 0) out.push([r, c]);
    return out;
  }
  /** 落 (r,c)（调用方保证已落 p 子）后 p 的成五点；只查过 (r,c) 的五线，到 cap 早退。 */
  function winPointsAfter(board: Board, p: number, r: number, c: number, cap: number): number[][] {
    const out: number[][] = [];
    const seen: Record<number, true> = {};
    for (const [dr, dc] of DIRS4) {
      for (let s = -4; s <= 0; s++) {
        let stones = 0, er = -1, ec = -1, ok = true;
        for (let k = 0; k < 5; k++) {
          const rr = r + dr! * (s + k), cc = c + dc! * (s + k);
          if (!inB(rr, cc)) { ok = false; break; }
          const v = board[rr]![cc];
          if (v === p) stones++;
          else if (v === 0) {
            if (er >= 0) { ok = false; break; }
            er = rr; ec = cc;
          } else { ok = false; break; }
        }
        if (ok && stones === 4 && er >= 0) {
          const key = er * N + ec;
          if (seen[key]) continue;
          if (forbidden && p === 1) {
            board[er]![ec] = 1;
            const exact = exactFiveAt(board, er, ec);
            board[er]![ec] = 0;
            if (!exact) continue;
          }
          seen[key] = true;
          out.push([er, ec]);
          if (out.length >= cap) return out;
        }
      }
    }
    return out;
  }
  /** p 方是否有一手成五的点（只看邻域空点；成五点必与己子相邻）。 */
  function hasFivePoint(board: Board, p: number): boolean {
    for (const [r, c] of nearEmpties(board)) {
      if (forbidden && p === 1 && isForbiddenPoint(board, r, c)) continue;
      board[r]![c] = p;
      const five = isFiveAt(board, r, c, p);
      board[r]![c] = 0;
      if (five) return true;
    }
    return false;
  }
  /** p 方一手成五的落点（无则 null）。 */
  function fivePointOf(board: Board, p: number): number[] | null {
    for (const [r, c] of nearEmpties(board)) {
      if (forbidden && p === 1 && isForbiddenPoint(board, r, c)) continue;
      board[r]![c] = p;
      const five = isFiveAt(board, r, c, p);
      board[r]![c] = 0;
      if (five) return [r, c];
    }
    return null;
  }
  /** p 方是否有「造冲四」的着法（活三逼迫前必须确认对手没有反先的四）。 */
  function hasFourMove(board: Board, p: number): boolean {
    for (const [r, c] of nearEmpties(board)) {
      if (forbidden && p === 1 && isForbiddenPoint(board, r, c)) continue;
      board[r]![c] = p;
      const wins = winPointsAfter(board, p, r, c, 1);
      board[r]![c] = 0;
      if (wins.length > 0) return true;
    }
    return false;
  }
  /** 沿 (r,c) 四条线 ≤4 格窗口内 p 的「必胜点」（落子即得 ≥2 个成五点）＝落子后的活四制造点。 */
  function l2Window(board: Board, p: number, r: number, c: number): number[] {
    const out: number[] = [];
    const seen: Record<number, true> = {};
    for (const [dr, dc] of DIRS4) {
      for (let k = -4; k <= 4; k++) {
        if (k === 0) continue;
        const qr = r + dr! * k, qc = c + dc! * k;
        if (!inB(qr, qc) || board[qr]![qc] !== 0) continue;
        const key = qr * N + qc;
        if (seen[key]) continue;
        seen[key] = true;
        if (forbidden && p === 1 && isForbiddenPoint(board, qr, qc)) continue;
        board[qr]![qc] = p;
        const n = fiveCompletions(board, p, qr, qc);
        board[qr]![qc] = 0;
        if (n >= 2) out.push(key);
      }
    }
    return out;
  }
  /** 落 (r,c) **新造出**的必胜点（落子后窗口内的 L2 点，减去「落子前就已经是 L2」的那些）。
   *  等价于旧实现的「落子前后窗口差集」，但只对落子后出现的点逐个回验，省掉整趟前集扫描。 */
  function newThreats(board: Board, p: number, r: number, c: number): number[] {
    board[r]![c] = p;
    const post = l2Window(board, p, r, c);
    board[r]![c] = 0;
    const out: number[] = [];
    for (const k of post) {
      const qr = (k / N) | 0, qc = k % N;
      board[qr]![qc] = p;
      const n = fiveCompletions(board, p, qr, qc);   /* 落子前的盘面（(r,c) 已撤） */
      board[qr]![qc] = 0;
      if (n < 2) out.push(k);
    }
    return out;
  }
  interface VctMove { r: number; c: number; wins: number[][]; live: number[] }
  /** 攻击方候选：冲四（wins 非空）与造活三（live = 新造出的必胜点，≥2 个）。四在前。 */
  function vctMoves(board: Board, p: number, movesMax: number): VctMove[] {
    const out: VctMove[] = [];
    for (const [r, c] of nearEmpties(board)) {
      if (forbidden && p === 1 && isForbiddenPoint(board, r, c)) continue;
      board[r]![c] = p;
      const wins = winPointsAfter(board, p, r, c, 2);
      board[r]![c] = 0;
      if (wins.length > 0) out.push({ r, c, wins, live: [] });
      else {
        const live = newThreats(board, p, r, c);
        if (live.length >= 2) out.push({ r, c, wins: [], live });
      }
    }
    out.sort((a, b) => (b.wins.length - a.wins.length) || (b.live.length - a.live.length));
    return out.slice(0, movesMax);
  }
  /**
   * 守方真正能拆掉活三的落点：落此点后 S 里再无「落子即得 ≥2 成五点」的点。
   * `cands` 由调用方给**全盘空点**（`allEmpties`）——漏枚举一个能守住的应手，
   * 就会把和棋/败局误判成必胜（sound 方向要求）。单个候选的判定很便宜
   * （|S| 个点各数一次成五点、n≥2 即早退），所以全盘扫的代价可接受。 */
  function vctDefusers(board: Board, p: number, opp: number, S: number[], cands: number[][]): number[] {
    const out: number[] = [];
    const seen: Record<number, true> = {};
    const tryCell = (qr: number, qc: number): void => {
      const key = qr * N + qc;
      if (seen[key]) return;
      seen[key] = true;
      if (board[qr]![qc] !== 0) return;
      /* 黑方禁手点堵不住（走不得）→ 不算应手，攻方照赢 */
      if (forbidden && opp === 1 && isForbiddenPoint(board, qr, qc)) return;
      board[qr]![qc] = opp;
      let alive = false;
      for (const k of S) {
        const sr = (k / N) | 0, sc = k % N;
        if (board[sr]![sc] !== 0) continue;
        board[sr]![sc] = p;
        const n = fiveCompletions(board, p, sr, sc);
        board[sr]![sc] = 0;
        if (n >= 2) { alive = true; break; }
      }
      board[qr]![qc] = 0;
      if (!alive) out.push(key);
    };
    for (const k of S) tryCell((k / N) | 0, k % N);
    for (const [qr, qc] of cands) tryCell(qr, qc);
    return out;
  }
  function vctWin(st: GomokuState, attackerId: string, maxPlies?: number, opts?: VctOptions): VcfResult {
    const A = attackerId === 'black' ? 1 : 2;
    const D = A === 1 ? 2 : 1;
    const board = clone(st.board);
    const nodeLimit = opts?.nodeLimit && opts.nodeLimit > 0 ? opts.nodeLimit : VCT_NODE_LIMIT;
    const movesMax = opts?.movesMax && opts.movesMax > 0 ? opts.movesMax : VCT_MOVES_MAX;
    const defusersMax = opts?.defusersMax && opts.defusersMax > 0 ? opts.defusersMax : VCT_DEFUSERS_MAX;
    let nodes = 0;
    const plies = Math.max(1, Math.min(15, maxPlies! | 0 || 9));

    function search(pliesLeft: number, precomputed?: VctMove[]): number[][] | null {
      if (pliesLeft <= 0 || nodes > nodeLimit) return null;
      const five = fivePointOf(board, A);
      if (five) return [five];                     /* 己方一手成五 */
      if (hasFivePoint(board, D)) return null;     /* 守方一手成五：这条链赶不上 */
      const moves = precomputed ?? vctMoves(board, A, movesMax);
      for (const m of moves) {
        if (++nodes > nodeLimit) break;
        board[m.r]![m.c] = A;
        let line: number[][] | null = null;
        if (m.wins.length >= 2) line = [];          /* 双四：守方挡不住 */
        else if (m.wins.length === 1) {
          const wr = m.wins[0]![0]!, wc = m.wins[0]![1]!;
          board[wr]![wc] = D;                       /* 冲四：守方唯一应手 */
          const sub = search(pliesLeft - 2);
          board[wr]![wc] = 0;
          if (sub) line = sub;
        } else if (m.live.length >= 2 && !hasFourMove(board, D)) {
          const defs = vctDefusers(board, A, D, m.live, allEmpties(board));
          /* 应手太多时不当作逼迫手（sound：宁可漏判也不谎报必胜），见 vct-tune 标定 */
          if (defusersMax && defs.length > defusersMax) { /* 落空：这一手不算威胁 */ }
          else if (defs.length === 0) line = [];      /* 拆不掉 → 下一手活四 */
          else {
            let ok = true, tail: number[][] | null = [];
            for (const q of defs) {
              const qr = (q / N) | 0, qc = q % N;
              board[qr]![qc] = D;
              const sub = search(pliesLeft - 2);
              board[qr]![qc] = 0;
              if (!sub) { ok = false; break; }
              tail = sub;
            }
            if (ok) line = tail;
          }
        }
        board[m.r]![m.c] = 0;
        if (line) return [[m.r, m.c], ...line];
      }
      return null;
    }

    /* 根节点闸门：连一个逼迫手都没有时，直接判无杀（省掉整趟搜索，见 vct-tune 标定） */
    const rootMoves = vctMoves(board, A, movesMax);
    if (rootMoves.length === 0) return { win: false, first: null, line: [] };
    const line = search(plies, rootMoves);
    if (!line) return { win: false, first: null, line: [] };
    const toN = (rc: number[]): string => notation(rc[0]!, rc[1]!);
    return { win: true, first: toN(line[0]!), line: line.map(toN) };
  }

  /* ---------- v12 战术层：对手连续威胁链的防守（拆链 + 取势排序） ----------
   * 证据（两轮 v11 vs rapfi@500ms、48 个「我方无杀而对手有链」的回合）：实走拆掉 33 个、漏 15 个；
   * 漏的 15 个里只有 2 个存在能拆的点却没走（计时轮 #8 ply24 → K9、首轮 #6 ply52 → K8），其余 13 个
   * 连全盘候选都拆不掉（点无回头路，局面已经输了）。链首直接占掉能拆掉其中 12+19 手（现有
   * `live3Deny`/`vcfDefense` 已在做），K9 / K8 这两手只在「链上各点的车氏 ≤2 邻域」「全部邻近空点」
   * 里找得到 ⇒ 候选集 = 链上各点 → 链点邻域 → 全部邻近空点（按到链距离升序），上限 VCT_DEF_MAX 个。
   * 判据比 vcfDefense 严：落子后对手**既无 VCF(7) 也无 VCT(9)**（vcfDefense 只验纯冲四，对手把纯链
   * 换成混合链它就放行）。拆法不止一种时按 1-ply 取势排序（对手造四点 ×2 + 活三点 更少者优先，
   * 模型候选优先），因为随手拆一个常把主动权交回去（实测有连拆六条链仍被穿透的局）。 */
  const VCT_DEF_MAX = 12;
  const VCT_DEF_KEEP = 3;
  const VCF_DEF_PLIES = 7;
  /** p 方「造冲四」点的数量（落子后 ≥1 个成五点），到 limit 早退。 */
  function fourMakeCount(board: Board, p: number, limit: number): number {
    let cnt = 0;
    for (const [r, c] of nearEmpties(board)) {
      if (forbidden && p === 1 && isForbiddenPoint(board, r, c)) continue;
      board[r]![c] = p;
      const wins = winPointsAfter(board, p, r, c, 1).length;
      board[r]![c] = 0;
      if (wins > 0) { cnt++; if (cnt >= limit) break; }
    }
    return cnt;
  }
  /** p 方当前的压力粗算（造四点 ×2 + 活三制造点，各到 limit 早退）：并列拆法里挑「交回主动权最少」的。 */
  function pressureOf(board: Board, p: number, limit: number): number {
    const cands = nearEmpties(board);
    return fourMakeCount(board, p, limit) * 2 + live3Count(board, p, cands, limit);
  }
  function vctDefense(st: GomokuState, defenderId: string, maxPlies?: number, opts?: VctDefenseOptions): VctDefenseResult {
    const D = num(defenderId), A = D === 1 ? 2 : 1;
    const board = clone(st.board);
    const plies = Math.max(1, Math.min(15, maxPlies! | 0 || 9));
    const oppId = D === 1 ? 'white' : 'black';
    /* P1 预算（缺省 = 历史常量）：复验深度 / 凑够几个点收工 / 并列排序的压力早退阈值 */
    const vcfDefPlies = opts?.vcfPlies && opts.vcfPlies > 0 ? opts.vcfPlies : VCF_DEF_PLIES;
    const keep = opts?.keep && opts.keep > 0 ? opts.keep : VCT_DEF_KEEP;
    const pressureLimit = opts?.pressureLimit && opts.pressureLimit > 0 ? opts.pressureLimit : 3;
    /* 对手现在的链：先纯冲四（便宜），没有再看含活三逼迫的混合链 */
    const vcf = vcfWin(st, oppId, vcfDefPlies);
    let chain: string[] = [];
    let kind: 'vcf' | 'vct' | '' = '';
    if (vcf && vcf.win && vcf.first) { chain = vcf.line.length ? vcf.line : [vcf.first]; kind = 'vcf'; }
    else {
      const vct = vctWin(st, oppId, plies);
      if (vct && vct.win && vct.first) { chain = vct.line.length ? vct.line : [vct.first]; kind = 'vct'; }
    }
    if (chain.length === 0) return { kind: '', chain: [], points: [], tried: 0 };

    const cells = chain.map((n) => parseN(n));
    const distToChain = (r: number, c: number): number => {
      let d = 99;
      for (const p of cells) { const dd = Math.max(Math.abs(r - p.r), Math.abs(c - p.c)); if (dd < d) d = dd; }
      return d;
    };
    const order: number[] = [];
    const seen: Record<number, true> = {};
    const push = (r: number, c: number): void => {
      if (!inB(r, c)) return;
      const key = r * N + c;
      if (seen[key] || board[r]![c] !== 0) return;
      if (forbidden && D === 1 && isForbiddenPoint(board, r, c)) return;   /* 己方禁手点走不得 */
      seen[key] = true;
      order.push(key);
    };
    for (const p of cells) push(p.r, p.c);                                          /* ① 链上各点（链首在内） */
    for (const p of cells) {
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) push(p.r + dr, p.c + dc);   /* ② 链点邻域 */
    }
    for (const [r, c] of nearEmpties(board).sort((a, b) => distToChain(a[0]!, a[1]!) - distToChain(b[0]!, b[1]!))) {
      push(r!, c!);                                                                 /* ③ 其余邻近空点 */
    }

    const modelCands = new Set<string>((opts?.cands ?? []).filter((n) => typeof n === 'string' && !!n));
    const maxTry = opts?.maxTry && opts.maxTry > 0 ? opts.maxTry : VCT_DEF_MAX;
    const hits: Array<{ n: string; pressure: number; model: boolean }> = [];
    let tried = 0;
    for (const key of order) {
      if (tried >= maxTry) break;
      const r = (key / N) | 0, c = key % N;
      tried++;
      board[r]![c] = D;
      /* 落子后对手还赢不赢？——先看他有没有一手成五，再跑 VCF / VCT（两者都只在入口拷一次盘） */
      const probe = { ...st, board, turn: st.turn } as GomokuState;
      let still = hasFivePoint(board, A);
      if (!still) {
        const v = vcfWin(probe, oppId, vcfDefPlies);
        still = !!(v && v.win);
      }
      if (!still) {
        const t = vctWin(probe, oppId, plies);
        still = !!(t && t.win);
      }
      const pressure = still ? 0 : pressureOf(board, A, pressureLimit);
      board[r]![c] = 0;
      if (still) continue;
      const n = notation(r, c);
      hits.push({ n, pressure, model: modelCands.has(n) });
      if (hits.length >= keep) break;
    }
    /* 模型候选优先，其次对手压力小者（取势），最后按发现顺序（链首/链点靠前） */
    hits.sort((a, b) => (a.model === b.model ? 0 : a.model ? -1 : 1) || (a.pressure - b.pressure));
    return { kind, chain, points: hits.map((h) => h.n), tried };
  }

  /* ---------- v13 战术层：压力闸门（对手做四手数压过我们时先削点，不抢活三） ----------
   * 证据（六轮 rapfi 对照 / 1787 个 Jev 回合 / 205 手实走 live3Attack，探针 `.work/v13-pressure-probe.mjs`）：
   * 其中 39 手（19.0%，占全部回合 2.2%）在落子前对手的「做四手数」就已经超过我们，而实走之后
   * 对手仍握有 ≥2 个做四点（双四威胁，2 手胜）的有 37 手；把这 39 手改走「拆对手的活三点」，
   * 37 手能把对手做四手数压得更低（平均 −1.87 个）、0 手更差，双四威胁从 37 手降到 7 手。
   * 语义：活三本身不是杀（ADR-0015 已修正：两个 L2 点互斥，v10 的「4 手内必胜」不成立），
   * 它只是逼手；对手做四点密集时才真正危险。所以「我们落后于对手的造四点能力」时，
   * 先削（1-ply 模拟里挑对手做四手数最小者）比先抢划算——真正的强制胜早已被 vcfAttack /
   * vctAttack 接管，且削点为空时本层不开火，行为与 v12 一致。 */
  /** p 方在 st 局面下的「做四手数」（车氏邻域内落子即成冲四的空点数）。默认不早退：
   * 闸门要精确比较两侧数量，早退会让两侧同时触顶而误判为「不落后」。 */
  function fourPressure(st: GomokuState, sideId: string, limit?: number): number {
    return fourMakeCount(clone(st.board), num(sideId), limit && limit > 0 ? limit : 99);
  }

  const PRESSURE_CUT_MAX = 120;
  const PRESSURE_CUT_KEEP = 3;
  /** 削点搜索：候选顺序 = 模型候选点 → 「对手做四点」的车氏 ≤2 邻域（按距离升序）→ 其余邻近空点，
   *  上限 PRESSURE_CUT_MAX。每个候选做 1-ply 模拟，度量「落子后对手的做四手数」（越小越好），
   *  并列时取自己做四手数更大者（主动权留在自己手上）。
   *  只有严格优于落子前的对手手数才算「削点」；一个都没有就返回空（调用方不动）。
   *  候选顺序很关键：按行序盲试会漏掉有效点（实测 `1be84659` ply24 的 C8 就在第 40 个之后），
   *  而「贴着对手做四点削」既便宜又准（对手的做四点就是他那张网的节点）。 */
  function pressureCut(st: GomokuState, sideId: string, opts?: PressureCutOptions): PressureCutResult {
    const D = num(sideId), A = D === 1 ? 2 : 1;
    const board = clone(st.board);
    const beforeYou = fourMakeCount(board, D, 99);
    const beforeOpponent = fourMakeCount(board, A, 99);
    /* 对手的做四点（一次扫描，供候选排序用） */
    const oppPts: number[][] = [];
    for (const [r, c] of nearEmpties(board)) {
      if (forbidden && A === 1 && isForbiddenPoint(board, r, c)) continue;
      board[r]![c] = A;
      const wins = winPointsAfter(board, A, r!, c!, 1).length;
      board[r]![c] = 0;
      if (wins > 0) oppPts.push([r!, c!]);
    }
    const distToOpp = (r: number, c: number): number => {
      let d = 99;
      for (const p of oppPts) { const dd = Math.max(Math.abs(r - p[0]!), Math.abs(c - p[1]!)); if (dd < d) d = dd; }
      return d;
    };
    const order: number[] = [];
    const seen: Record<number, true> = {};
    const push = (r: number, c: number): void => {
      if (!inB(r, c)) return;
      const key = r * N + c;
      if (seen[key] || board[r]![c] !== 0) return;
      if (forbidden && D === 1 && isForbiddenPoint(board, r, c)) return;   /* 己方禁手点走不得 */
      seen[key] = true;
      order.push(key);
    };
    for (const n of opts?.cands ?? []) {
      if (typeof n !== 'string' || !n) continue;
      const { r, c } = parseN(n);
      push(r, c);
    }
    for (const [r, c] of nearEmpties(board)) {
      if (distToOpp(r!, c!) <= 2) push(r!, c!);
    }
    for (const [r, c] of nearEmpties(board)) push(r!, c!);

    const maxTry = opts?.maxTry && opts.maxTry > 0 ? opts.maxTry : PRESSURE_CUT_MAX;
    const keep = opts?.keep && opts.keep > 0 ? opts.keep : PRESSURE_CUT_KEEP;
    let tried = 0;
    let best = beforeOpponent;
    const first: Array<{ r: number; c: number; opp: number }> = [];
    for (const key of order) {
      if (tried >= maxTry) break;
      const r = (key / N) | 0, c = key % N;
      tried++;
      board[r]![c] = D;
      const opp = fourMakeCount(board, A, 99);
      board[r]![c] = 0;
      if (opp < best) { best = opp; first.length = 0; first.push({ r, c, opp }); }
      else if (opp === best && opp < beforeOpponent) first.push({ r, c, opp });
    }
    if (first.length === 0) {
      return { points: [], before: { you: beforeYou, opponent: beforeOpponent }, after: { you: beforeYou, opponent: beforeOpponent }, tried };
    }
    /* 并列里再比「自己的做四手数」（越多越好）：主动权留在自己手上 */
    let bestYou = -1;
    const hits: Array<{ n: string; opp: number; you: number }> = [];
    for (const h of first) {
      board[h.r]![h.c] = D;
      const you = fourMakeCount(board, D, 99);
      board[h.r]![h.c] = 0;
      const n = notation(h.r, h.c);
      if (you > bestYou) { bestYou = you; hits.length = 0; hits.push({ n, opp: h.opp, you }); }
      else if (you === bestYou) hits.push({ n, opp: h.opp, you });
    }
    return {
      points: hits.slice(0, keep).map((h) => h.n),
      before: { you: beforeYou, opponent: beforeOpponent },
      after: { you: bestYou, opponent: best },
      tried,
    };
  }

  function getLegalMoves(st: GomokuState): GomokuMove[] {
    const ms: GomokuMove[] = [];
    const ban = forbidden && st.turn === 'black';
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (st.board[r]![c] !== 0) continue;
        if (ban && isForbiddenPoint(st.board, r, c)) continue;
        ms.push({ notation: notation(r, c), desc: null, r, c });
      }
    }
    return ms;
  }

  /* Jev 候选：与任意棋子切比雪夫距离 ≤2 的空点（控制 token），无子时取天元附近 */
  function candidates(st: GomokuState, cap?: number): GomokuMove[] {
    cap = cap || 64;
    const empty = getLegalMoves(st);
    if (st.moveNum === 0) return [empty.find((m) => m.r === 7 && m.c === 7)!];
    const near: GomokuMove[] = [];
    for (const m of empty) {
      let ok = false;
      for (let dr = -2; dr <= 2 && !ok; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const rr = m.r + dr, cc = m.c + dc;
          if (rr >= 0 && rr < N && cc >= 0 && cc < N && st.board[rr]![cc] !== 0) { ok = true; break; }
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

  function applyMove(st: GomokuState, move: Move): GomokuState {
    const mv = move as GomokuMove;
    const s = clone(st);
    const p = num(st.turn);
    s.board[mv.r]![mv.c] = p;
    s.moveNum++;
    s.last = { notation: move.notation, r: mv.r, c: mv.c, side: st.turn };
    s.turn = st.turn === 'black' ? 'white' : 'black';
    return s;
  }

  function getStatus(st: GomokuState): GameStatus {
    if (st.result) return st.result;
    if (st.last) {
      const { r, c } = st.last;
      const p = st.board[r]![c]!;
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
          if (lineLen(st, r, c, dr!, dc!) >= 5) {
            return { over: true, winner: p === 1 ? 'black' : 'white', reason: '五连' };
          }
        }
      }
    }
    if (st.moveNum >= N * N) return { over: true, winner: null, reason: '棋盘已满' };
    return { over: false, turn: st.turn };
  }

  function moveFromNotation(st: GomokuState, n: string): GomokuMove | null {
    const { r, c } = parseN(n);
    if (r < 0 || r >= N || c < 0 || c >= N || st.board[r]![c] !== 0) return null;
    if (forbidden && st.turn === 'black' && isForbiddenPoint(st.board, r, c)) return null;
    return { notation: n, desc: null, r, c };
  }

  /* ---------- Jev 序列化 ---------- */
  const SCORE_LEVELS = ['0-2 clearly losing', '3-4 slightly worse', '5 roughly even', '6-7 slightly better', '8-10 clearly winning'];
  const RULES_FREE = 'Free-style gomoku, no forbidden moves: first to align five or more of their own stones horizontally, vertically or diagonally wins; a full board is a draw.';
  const RULES_PRO = 'Renju-style gomoku with forbidden moves for Black: Black (the first player) must NEVER play a point that forms double-three, double-four or overline (six or more stones in a row) — playing such a forbidden point loses the game immediately. Black wins only with EXACTLY five stones in a row (overline does not count as a win). White has no forbidden moves and wins with five or more stones in a row. A full board is a draw.';

  function stonesOf(st: GomokuState, p: number): string[] {
    const out: string[] = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) if (st.board[r]![c] === p) out.push(notation(r, c));
    }
    return out;
  }

  /* 板斧一：ASCII 棋盘，裁剪到有子区域外扩 2 格（盘面贴边时收敛到边界）。
   * 大写 X/O 为常规棋子，小写标记 last_move；空盘时裁剪到天元附近 5×5。 */
  function boardAscii(st: GomokuState): string {
    let r0 = N, r1 = -1, c0 = N, c1 = -1, any = false;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (st.board[r]![c]) {
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
        const p = st.board[r]![c];
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
  function isFiveAt(board: Board, r: number, c: number, p: number): boolean {
    for (const [dr, dc] of DIRS4) {
      let len = 1;
      for (let k = 1; k < 5 && inB(r + dr! * k, c + dc! * k) && board[r + dr! * k]![c + dc! * k] === p; k++) len++;
      for (let k = 1; k < 5 && inB(r - dr! * k, c - dc! * k) && board[r - dr! * k]![c - dc! * k] === p; k++) len++;
      if (len >= 5) return true;
    }
    return false;
  }
  /* 经过 (cr,cc) 的四条线 ±4 内的空格：p 的成五点必在其中（五连同时含 p 与成五格） */
  function lineEmpties(board: Board, cr: number, cc: number): number[][] {
    const out: number[][] = [];
    for (const [dr, dc] of DIRS4) {
      for (let k = 1; k <= 4; k++) {
        for (const s of [1, -1]) {
          const r = cr + dr! * k * s, c = cc + dc! * k * s;
          if (inB(r, c) && !board[r]![c]) out.push([r, c]);
        }
      }
    }
    return out;
  }
  /* 活三判定（沿方向精确）：含 (r,c) 沿 d 的连续三子、两边界空、且某一端延伸后
   * 成活四（另一端空 + 该端外侧也空）。不用窗口扫描——窗口里无关方向的黑活四会误标。 */
  function liveThreeDir(board: Board, r: number, c: number, p: number, dr: number, dc: number): boolean {
    let f = 0; while (inB(r + dr * (f + 1), c + dc * (f + 1)) && board[r + dr * (f + 1)]![c + dc * (f + 1)] === p) f++;
    let b = 0; while (inB(r - dr * (b + 1), c - dc * (b + 1)) && board[r - dr * (b + 1)]![c - dc * (b + 1)] === p) b++;
    if (f + b + 1 !== 3) return false;
    const empty = (q: number[]): boolean => inB(q[0]!, q[1]!) && board[q[0]!]![q[1]!] === 0;
    const a1 = [r + dr * (f + 1), c + dc * (f + 1)], a2 = [r + dr * (f + 2), c + dc * (f + 2)];
    const s1 = [r - dr * (b + 1), c - dc * (b + 1)], s2 = [r - dr * (b + 2), c - dc * (b + 2)];
    if (!empty(a1) || !empty(s1)) return false;
    return empty(a2) || empty(s2);
  }
  function labelPoint(st: GomokuState, r: number, c: number, me: number): string {
    const opp = me === 1 ? 2 : 1;
    const mine = clone(st.board); mine[r]![c] = me;
    const parts: string[] = [];
    const winsNow = (forbidden && me === 1) ? exactFiveAt(mine, r, c) : isFiveAt(mine, r, c, me);
    if (winsNow) return 'win';
    const myComps = fiveCompletions(mine, me, r, c);
    if (myComps >= 2) parts.push('you:open4');
    else if (myComps === 1) parts.push('you:four');
    else if (DIRS4.some(([dr, dc]) => liveThreeDir(mine, r, c, me, dr!, dc!))) parts.push('you:live3');
    const theirs = clone(st.board); theirs[r]![c] = opp;
    if (forbidden && opp === 1) {
      /* 对手是黑：精确五连才需 block；禁手点黑走不得，直接跳过 deny */
      if (exactFiveAt(theirs, r, c)) parts.push('block:five');
      else if (!forbidKind(theirs, r, c)) {
        const opComps = fiveCompletions(theirs, opp, r, c);
        if (opComps >= 2) parts.push('deny:open4');
        else if (opComps === 1) parts.push('deny:four');
        else if (DIRS4.some(([dr, dc]) => liveThreeDir(theirs, r, c, opp, dr!, dc!))) parts.push('deny:live3');
      }
    } else {
      if (isFiveAt(theirs, r, c, opp)) parts.push('block:five');
      else {
        const opComps = fiveCompletions(theirs, opp, r, c);
        if (opComps >= 2) parts.push('deny:open4');
        else if (opComps === 1) parts.push('deny:four');
        else if (DIRS4.some(([dr, dc]) => liveThreeDir(theirs, r, c, opp, dr!, dc!))) parts.push('deny:live3');
      }
    }
    return parts.join('+');
  }

  function serializeForJev(st: GomokuState, side: string): JevSerialized {
    const cand = candidates(st, 64);
    const notations = cand.map((m) => m.notation);
    const me = num(side);
    const criteria: Record<string, string | null | undefined> = {};
    cand.forEach((m) => { criteria[m.notation] = labelPoint(st, m.r, m.c, me) || null; });
    const state: Record<string, unknown> = {
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

  function draw(ctx: Canvas2D, st: GomokuState, _ui: UiState): void {
    gfx.clear(ctx, W, H);
    gfx.intersections(ctx, MARGIN, MARGIN, CELL, N, N);
    /* 星位 */
    [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]].forEach(([r, c]) => {
      gfx.disc(ctx, MARGIN + c! * CELL, MARGIN + r! * CELL, 3.2, '#3A4048');
    });
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const p = st.board[r]![c];
        if (p) {
          gfx.stone(ctx, MARGIN + c * CELL, MARGIN + r * CELL, CELL * 0.44,
            p === 1 ? 'black' : 'white', !!st.last && st.last.r === r && st.last.c === c);
        }
      }
    }
    for (let c = 0; c < N; c++) gfx.text(ctx, colName(c), MARGIN + c * CELL, 12, { size: 10 });
    for (let r = 0; r < N; r++) gfx.text(ctx, String(r + 1), 12, MARGIN + r * CELL, { size: 10 });
  }

  function xyToCell(x: number, y: number): { r: number; c: number } | null {
    const c = Math.round((x - MARGIN) / CELL), r = Math.round((y - MARGIN) / CELL);
    if (r < 0 || r >= N || c < 0 || c >= N) return null;
    if (Math.abs(x - (MARGIN + c * CELL)) > CELL * 0.47) return null;
    if (Math.abs(y - (MARGIN + r * CELL)) > CELL * 0.47) return null;
    return { r, c };
  }

  function humanClick(st: GomokuState, _ui: UiState, x: number, y: number): Move | null {
    const cell = xyToCell(x, y);
    if (!cell || st.board[cell.r]![cell.c] !== 0) return null;
    if (forbidden && st.turn === 'black' && isForbiddenPoint(st.board, cell.r, cell.c)) return null;
    return { notation: notation(cell.r, cell.c), desc: null, r: cell.r, c: cell.c };
  }

  /* ---------- mock 启发式 ---------- */
  function wouldWin(st: GomokuState, m: GomokuMove, side: string): boolean {
    const s = clone(st);
    s.board[m.r]![m.c] = num(side);
    if (forbidden && side === 'black') {
      /* 黑方精确五连才算赢；长连/禁手不算（也不会被走出） */
      return exactFiveAt(s.board, m.r, m.c);
    }
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    return dirs.some(([dr, dc]) => lineLen(s, m.r, m.c, dr!, dc!) >= 5);
  }

  function mockPick(st: GomokuState, moves: Move[], side?: string, _cfg?: PickConfig): Move | null {
    const opp = side === 'black' ? 'white' : 'black';
    let m = moves.find((mv) => wouldWin(st, mv as GomokuMove, side!));
    if (m) return m;
    m = moves.find((mv) => wouldWin(st, mv as GomokuMove, opp));
    if (m) return m;
    const scored = moves.map((mv) => {
      const g = mv as GomokuMove;
      return {
        mv,
        s: -(Math.abs(g.r - 7) + Math.abs(g.c - 7)) + rnd() * 3,
      };
    }).sort((a, b) => b.s - a.s);
    return scored[0]!.mv;
  }

  /* ---------- 自检 ---------- */
  function selfTest(): void {
    let st = newGame();
    assert(getLegalMoves(st).length === 225, '初始 225 个空点（空盘无禁手）');
    const seqBlack = [[7, 6], [7, 7], [7, 8], [7, 9]];
    const seqWhite = [[8, 6], [8, 7], [8, 8], [8, 9]];
    for (let i = 0; i < 4; i++) {
      st = applyMove(st, { notation: notation(seqBlack[i]![0]!, seqBlack[i]![1]!), r: seqBlack[i]![0]!, c: seqBlack[i]![1]! });
      st = applyMove(st, { notation: notation(seqWhite[i]![0]!, seqWhite[i]![1]!), r: seqWhite[i]![0]!, c: seqWhite[i]![1]! });
    }
    assert(getStatus(st).over === false, '四连未结束');
    st = applyMove(st, { notation: 'K8', r: 7, c: 10 });
    const res = getStatus(st);
    assert(res.over && res.winner === 'black', '黑棋五连获胜');
    assert(candidates(st, 64).length <= 64, '候选 ≤64');
    assert(!moveFromNotation(st, 'H8'), '已占点不可再走');
    assert(moveFromNotation(newGame(), 'H8') !== null, 'H8 合法');

    if (!forbidden) return;
    /* 禁手模式专项：三三 / 四四 / 长连 / 精确五连 / 白方豁免 */
    const mk = (): GomokuState => { const s = newGame(); return s; };
    const put = (s: GomokuState, r: number, c: number, p: number): void => { s.board[r]![c] = p; s.moveNum++; };
    // 双三：黑 (6,7),(7,6),(7,8),(8,7)，落 (7,7)=H8 横竖各成活三
    let s2 = mk();
    put(s2, 6, 7, 1); put(s2, 7, 6, 1); put(s2, 7, 8, 1); put(s2, 8, 7, 1);
    put(s2, 0, 0, 2); put(s2, 0, 1, 2);
    s2.turn = 'black';
    assert(isForbiddenPoint(s2.board, 7, 7) === 'double-three', 'H8 应为双三禁手');
    assert(!getLegalMoves(s2).some((m) => m.r === 7 && m.c === 7), '禁手点应从黑方合法着法剔除');
    assert(!moveFromNotation(s2, 'H8'), '禁手记法应解析为 null');
    assert(!humanClick(s2, {}, MARGIN + 7 * CELL, MARGIN + 7 * CELL), '禁手点点击应无着法');
    // 双四：黑 (7,5),(7,6),(7,8) + (5,7),(6,7),(8,7)，落 (7,7) 横竖各成四
    let s3 = mk();
    put(s3, 7, 5, 1); put(s3, 7, 6, 1); put(s3, 7, 8, 1);
    put(s3, 5, 7, 1); put(s3, 6, 7, 1); put(s3, 8, 7, 1);
    s3.turn = 'black';
    assert(isForbiddenPoint(s3.board, 7, 7) === 'double-four', 'H8 应为双四禁手');
    // 长连：黑 (7,4)-(7,8)，落 (7,9)=J8 成六连
    let s4 = mk();
    put(s4, 7, 4, 1); put(s4, 7, 5, 1); put(s4, 7, 6, 1); put(s4, 7, 7, 1); put(s4, 7, 8, 1);
    s4.turn = 'black';
    assert(isForbiddenPoint(s4.board, 7, 9) === 'overline', 'J8 应为长连禁手');
    // 精确五连是胜着非禁手：黑 (7,5)-(7,8)，落 (7,4)=E8
    let s5 = mk();
    put(s5, 7, 5, 1); put(s5, 7, 6, 1); put(s5, 7, 7, 1); put(s5, 7, 8, 1);
    put(s5, 0, 0, 2);
    s5.turn = 'black';
    assert(!isForbiddenPoint(s5.board, 7, 4), 'E8 精确五连不应判禁手');
    const s5b = applyMove(s5, moveFromNotation(s5, 'E8')!);
    const r5 = getStatus(s5b);
    assert(r5.over && r5.winner === 'black' && r5.reason === '五连', '黑方精确五连获胜');
    // 白方无禁手：白摆出双三形状也不禁
    let s6 = mk();
    put(s6, 6, 7, 2); put(s6, 7, 6, 2); put(s6, 7, 8, 2); put(s6, 8, 7, 2);
    s6.turn = 'white';
    assert(getLegalMoves(s6).some((m) => m.r === 7 && m.c === 7), '白方无禁手，H8 应合法');
    assert(moveFromNotation(s6, 'H8') !== null, '白方 H8 记法应合法');
    // 序列化带禁手清单与规则文本
    const ser = serializeForJev(s2, 'black');
    const sst = ser.state as Record<string, unknown>;
    assert(typeof sst.rules === 'string' && /forbidden/i.test(sst.rules), '禁手模式 rules 应描述禁手');
    assert(Array.isArray(sst.forbidden_points_black) && (sst.forbidden_points_black as string[]).indexOf('H8') >= 0, '禁手清单应含 H8');
    assert(/forbidden_points_black/.test(ser.questions.move.instructions), '黑方指令应提及禁手清单');
  }

  return {
    id, name,
    sides: [{ id: 'black', name: '黑方', first: true }, { id: 'white', name: '白方' }],
    meta: { w: W, h: H }, supportsPass: false, supportsResign: true,
    /* 2-ply 造杀扫描：候选点是无色差的空点集，适合通用双杀检测（见 jev-client computeTactics） */
    deepTactics: true,
    /* VCF 威胁空间搜索：连续冲四将死链（见 jev-client vcfAttack/vcfDefense） */
    vcfWin,
    /* v10：活三制造点的真推演（4-ply 威胁，见 jev-client live3Attack/live3Defense） */
    live3Makers, live3Deny,
    /* v11：VCT 连续威胁搜索（冲四链 + 活三逼迫，见 jev-client vctAttack） */
    vctWin,
    /* v12：对手连续威胁链的防守（拆链 + 取势排序，见 jev-client vctDefense） */
    vctDefense,
    /* v13：做四手数 + 削点搜索（压力闸门：对手压过我们时先削点，见 jev-client 的 pressureGate） */
    fourPressure,
    pressureCut,
    newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
    serializeForJev, draw, humanClick, mockPick, selfTest,
  } as Engine<GomokuState>;
}
