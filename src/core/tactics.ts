/* tactics.ts — 战术事实推算与事实注入（迁移自 js/jev-client.js 的战术层）
 *
 * 战术层回答的问题是：**在概率之上再叠一层确定性事实**。Jev 只给概率分布，
 * 它可能把「一步致胜」判成 0.2；这里把「这一步直接赢」「对方下一步赢」「造双杀」
 * 「连续冲四将死链」这类**可判定事实**在引擎上穷举出来，交给 orchestrator 接管。
 *
 * 九级保险（接管顺序，见 decide）：
 *   win → block → open4 → threat → vcfAttack → vcfDefense → parry → parry3 → parry4
 * 每一级都受**版本闸门**（tactics-versions.mech）约束：老版本没实现的层连算都不算，
 * 否则「v4 的行为」会随新代码漂移，实验就没法按版本归因。
 *
 * 纯逻辑：只依赖 engine 接口 + 版本登记表；无 DOM、无网络。异步仅出现在 callRaw 一侧。
 */
import { weightedPick } from './weighted.ts';
import { resolve } from './tactics-versions.ts';
import type { TacticsVersion } from './tactics-versions.ts';
import type { Engine, JevSerialized, Move } from './types.ts';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 战术事实（字段名与旧实现逐字一致，直接进 state.tactics）。 */
export interface TacticsReport {
  winning_points_you: string[];
  winning_points_opponent: string[];
  chance_points_you: string[];
  danger_points_opponent: string[];
  vcf_win_you: string[];
  vcf_win_opponent: string[];
}

/** 对局经验（跨设备开具体验；由 /api/openings 喂）。 */
export interface Experience {
  [k: string]: unknown;
}

/** decide 的选项（旧实现 opts 的超集，渠道键名保持不变）。 */
export interface DecideOpts {
  channel?: string;
  apiKey?: string;
  endpoint?: string;
  topK?: number;
  signal?: AbortSignal;
  tacticsVersion?: string;
  experience?: Experience;
  onRetry?: (status: number, attempt: number) => void;
  rapfiThinkMs?: number;
  [k: string]: unknown;
}

/** decide 的返回（meta 字段名与旧实现一致，供 meta.ts 归因）。 */
export interface DecideResult {
  notation: string;
  move: Move | null;
  meta: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * 常量与缓存
 * ------------------------------------------------------------------ */

/** 12 个机制键全开的桩版本（引擎没接战术登记表时的兜底）。 */
const ALL_MECH: Record<string, boolean> = {
  win: true, block: true, open4: true, threat: true,
  vcfAttack: true, vcfDefense: true, parry: true,
  parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true,
};

/** VCF 搜索深度（ply）。7 是 gomoku 上「够用且不卡」的实测值。 */
const VCF_PLIES = 7;

/** 战术缓存的降级形态：无 WeakMap 时退化为不缓存。 */
interface TacCache { get(k: object): Map<string, TacticsReport> | undefined; set(k: object, v: Map<string, TacticsReport>): void }
const tacCache: TacCache | null = typeof WeakMap === 'function'
  ? new WeakMap<object, Map<string, TacticsReport>>() as unknown as TacCache
  : null;

/** 空战术（结构与 TacticsReport 一致）。 */
export function emptyTactics(): TacticsReport {
  return {
    winning_points_you: [], winning_points_opponent: [],
    chance_points_you: [], danger_points_opponent: [],
    vcf_win_you: [], vcf_win_opponent: [],
  };
}

/** 换手（不改入参 state：拷贝一层后只改 turn，与 ADR-0004 的纯函数要求一致）。 */
function flipTurn<S>(st: S, sideId: string): S {
  return Object.assign({}, st as object, { turn: sideId }) as S;
}

/** 解析战术版本：无登记表时用全开桩（保证引擎自检不因缺表而崩）。 */
function resolveVersion(versionId?: string | null): { id: string; mech: Record<string, boolean> } {
  try {
    const v: TacticsVersion = resolve(versionId);
    if (v && v.id) return { id: v.id, mech: (v.mech || ALL_MECH) as Record<string, boolean> };
  } catch (_) { /* 登记表不可用时按全开处理 */ }
  return { id: versionId || 'unregistered', mech: ALL_MECH };
}

/* ------------------------------------------------------------------ *
 * 2-ply / 3-ply 事实推算
 * ------------------------------------------------------------------ */

/** 数 st2 中 sideId 的一步致胜点，到 limit 即停（2-ply 内层省时间用）。 */
function countWinningPoints(engine: Engine, st2: unknown, sideId: string, limit: number): number {
  let cnt = 0;
  const s = flipTurn(st2, sideId);
  let legal: Move[];
  try { legal = engine.getLegalMoves(s); } catch (_) { return 0; }
  for (const m of legal) {
    let g;
    try { g = engine.getStatus(engine.applyMove(s, m)); } catch (_) { continue; }
    if (g.over && g.winner === sideId) cnt++;
    if (cnt >= limit) break;
  }
  return cnt;
}

/** 造杀点：走这里之后自己有两个致胜点（对手只能挡一个）。
 *  forSelf=true 时还要求「对手没有一步致胜」，否则那不是造杀而是送死。 */
function threatMakers(engine: Engine, st: unknown, sideId: string, oppId: string | undefined, candNotations: string[], forSelf: boolean): string[] {
  const out: string[] = [];
  for (const n of candNotations) {
    let mv;
    try { mv = engine.moveFromNotation(st, n); } catch (_) { continue; }
    if (!mv) continue;
    let s2;
    try { s2 = engine.applyMove(flipTurn(st, sideId), mv); } catch (_) { continue; }
    if (countWinningPoints(engine, s2, sideId, 2) < 2) continue;
    if (forSelf && oppId && countWinningPoints(engine, s2, oppId, 1) > 0) continue;
    out.push(n);
  }
  return out;
}

/** 数走 p 之后对手还有几个逼杀着法（越小越安全）；失败返回 999（当作最坏情况）。 */
function countForcingReplies(engine: Engine, st: unknown, p: string, oppId: string, candNotations: string[]): number {
  let mv;
  try { mv = engine.moveFromNotation(st, p); } catch (_) { return 999; }
  if (!mv) return 999;
  let s2;
  try { s2 = engine.applyMove(st, mv); } catch (_) { return 999; }
  let cnt = 0;
  for (const n of candNotations) {
    if (n === p) continue;
    let q;
    try { q = engine.moveFromNotation(s2, n); } catch (_) { continue; }
    if (!q) continue;
    let s3;
    try { s3 = engine.applyMove(flipTurn(s2, oppId), q); } catch (_) { continue; }
    if (countWinningPoints(engine, s3, oppId, 1) >= 1) cnt++;
    if (cnt >= 10) break;
  }
  return cnt;
}

/** 3-ply 安全性：走 p 之后对手是否能维持攻击节奏（造出双杀）。true = 这个点不干净。 */
function allowsSustainedAttack(engine: Engine, st: unknown, p: string, oppId: string, myId: string, candNotations: string[]): boolean {
  let mv;
  try { mv = engine.moveFromNotation(st, p); } catch (_) { return false; }
  if (!mv) return false;
  let s2;
  try { s2 = engine.applyMove(st, mv); } catch (_) { return false; }
  let checked = 0;
  for (const q of candNotations) {
    if (q === p || checked >= 8) continue;
    let mq;
    try { mq = engine.moveFromNotation(s2, q); } catch (_) { continue; }
    if (!mq) continue;
    let s3;
    try { s3 = engine.applyMove(flipTurn(s2, oppId), mq); } catch (_) { continue; }
    /* 黑方这一步之后有几个致胜点？≥2 说明攻击节奏还在 */
    const wins: string[] = [];
    let legal3: Move[];
    try { legal3 = engine.getLegalMoves(flipTurn(s3, oppId)); } catch (_) { continue; }
    for (const m of legal3) {
      let g;
      try { g = engine.getStatus(engine.applyMove(flipTurn(s3, oppId), m)); } catch (_) { continue; }
      if (g.over && g.winner === oppId) wins.push(String(m.notation));
      if (wins.length >= 2) break;
    }
    if (wins.length === 0) continue;
    if (wins.length >= 2) return true;
    checked++;
    /* 只有一个致胜点：对手挡住后，攻击方是否还能再造杀？ */
    let mw;
    try { mw = engine.moveFromNotation(s3, wins[0]!); } catch (_) { continue; }
    if (!mw) continue;
    let s4;
    try { s4 = engine.applyMove(s3, mw); } catch (_) { continue; }
    if (threatMakers(engine, s4, oppId, myId, candNotations, false).length > 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 事实推算主入口
 * ------------------------------------------------------------------ */

/** 推算战术事实。legal 是当前合法着法，cands 是候选点记法（2-ply 只扫候选）。
 *  结果按 (state 对象, 版本 id) 缓存：同一局面会被 decide 与 pickSafestParry 反复问。 */
export function computeTactics(engine: Engine, st: unknown, legal: Move[], cands: string[] | null | undefined, versionId?: string | null): TacticsReport {
  const ver = resolveVersion(versionId);
  const M = ver.mech;
  if (tacCache && st && typeof st === 'object') {
    const hit = tacCache.get(st as object)?.get(ver.id);
    if (hit) return hit;
  }
  const sm = st as { moveNum?: number; turn: string };
  /* 开局前 4 手没有战术可言（也避免把 2-ply 花在无意义的空盘上） */
  if (typeof sm.moveNum === 'number' && sm.moveNum < 4) return emptyTactics();

  const side = sm.turn;
  const win: string[] = [];
  if (M.win) {
    for (const m of legal) {
      let g;
      try { g = engine.getStatus(engine.applyMove(st, m)); } catch (_) { continue; }
      if (g.over && g.winner === side) win.push(m.notation);
    }
  }
  /* 必挡点：把 turn 掰到对手那边看他能不能一手赢 */
  const block: string[] = [];
  const oppSide = engine.sides && engine.sides.find((s) => s.id !== side);
  if (oppSide && M.block) {
    const stOpp = flipTurn(st, oppSide.id);
    let legalOpp: Move[];
    try { legalOpp = engine.getLegalMoves(stOpp); } catch (_) { legalOpp = []; }
    for (const m of legalOpp) {
      let g;
      try { g = engine.getStatus(engine.applyMove(stOpp, m)); } catch (_) { continue; }
      if (g.over && g.winner === oppSide.id) block.push(m.notation);
    }
  }
  const res: TacticsReport = {
    winning_points_you: win,
    winning_points_opponent: block,
    chance_points_you: [],
    danger_points_opponent: [],
    vcf_win_you: [],
    vcf_win_opponent: [],
  };

  /* 2-ply 造杀/拆杀：只在「没有一步致胜」时才算（有致胜就不用看了） */
  if (engine.deepTactics && win.length === 0 && block.length === 0 && oppSide && (M.threat || M.parry)) {
    const candNotations = (cands && cands.length) ? cands : legal.map((m) => m.notation);
    res.chance_points_you = threatMakers(engine, st, side, oppSide.id, candNotations, true);
    res.danger_points_opponent = threatMakers(engine, st, oppSide.id, side, candNotations, false);
  }

  /* VCF（连续冲四将死链）：v7 起；v8 起对防守链逐点试干预；v9 起引擎侧有 soundness 闸门 */
  if (engine.deepTactics && typeof engine.vcfWin === 'function' && win.length === 0 && block.length === 0 && oppSide && (M.vcfAttack || M.vcfDefense)) {
    try {
      if (M.vcfAttack) {
        const atk = engine.vcfWin(st, side, VCF_PLIES);
        if (atk && atk.win && atk.first) res.vcf_win_you = [atk.first];
      }
      if (res.vcf_win_you.length === 0 && M.vcfDefense) {
        const def = engine.vcfWin(flipTurn(st, oppSide.id), oppSide.id, VCF_PLIES);
        if (def && def.win && def.first) {
          const cands2: string[] = [def.first];
          const seen = new Set(cands2);
          const pushCand = (n: string): void => { if (n && !seen.has(n)) { seen.add(n); cands2.push(n); } };
          /* v8 补丁：链首占不住时，把整条链上的点逐个试（占住哪一点真的能破链） */
          if (M.vcfTry) def.line.forEach((n) => pushCand(n));
          for (const n of cands2) {
            let mv;
            try { mv = engine.moveFromNotation(st, n); } catch (_) { continue; }
            if (!mv) continue;
            let stAfter;
            try { stAfter = engine.applyMove(st, mv); } catch (_) { continue; }
            const recheck = engine.vcfWin(flipTurn(stAfter, oppSide.id), oppSide.id, VCF_PLIES);
            if (!recheck || !recheck.win) { res.vcf_win_opponent = [n]; break; }
          }
        }
      }
    } catch (_) { /* 引擎差异一律 fail-soft：战术层不能把对局打断 */ }
  }

  if (tacCache && st && typeof st === 'object') {
    let byVer = tacCache.get(st as object);
    if (!byVer) { byVer = new Map<string, TacticsReport>(); tacCache.set(st as object, byVer); }
    byVer.set(ver.id, res);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * 事实注入：把 tactics / experience 塞进 state 并同步指令语义
 * ------------------------------------------------------------------ */

/** 把战术事实写进序列化结果的 state，并在 move 指令里追加一段语义说明。
 *  state 的三种形态（对象/字符串/数组）都要处理——旧契约允许引擎自选形态。 */
export function attachFacts(ser: JevSerialized, tactics: TacticsReport, experience?: Experience): void {
  const facts: Record<string, unknown> = { tactics };
  if (experience) facts.experience = experience;
  if (ser.state && typeof ser.state === 'object' && !Array.isArray(ser.state)) {
    Object.assign(ser.state, facts);
  } else if (typeof ser.state === 'string') {
    try { ser.state = JSON.stringify(Object.assign(JSON.parse(ser.state), facts)); }
    catch (_) { ser.state += '\n' + JSON.stringify(facts); }
  } else if (Array.isArray(ser.state)) {
    ser.state.push(JSON.stringify(facts));
  }
  if (ser.questions && ser.questions.move && typeof ser.questions.move.instructions === 'string') {
    ser.questions.move.instructions +=
      ' The state includes a `tactics` object: if `winning_points_you` is non-empty, playing one of those points wins immediately this turn. ' +
      'If `winning_points_opponent` is non-empty, the opponent would win there next turn unless stopped, so play one of those points unless you can win immediately. ' +
      'If `chance_points_you` is non-empty, playing one creates two winning threats at once (the opponent can block at most one of them), winning within two moves — take it when there is no immediate win or block. ' +
      'If `vcf_win_you` is non-empty, playing that point starts a forced sequence of consecutive fours leading to victory — take it when there is no immediate win, block, or double-threat above. ' +
      'If `vcf_win_opponent` is non-empty, the opponent has such a forced sequence; playing that point disrupts it at its entry — prioritize it over quiet moves. ' +
      'If `danger_points_opponent` is non-empty, the opponent would create such a double threat next turn unless stopped, so block one of those points now (after handling any immediate win or block above). ' +
      (experience ? 'The state also includes `experience`: first_player_win_rate over past games reaching this same opening; weigh it when judging quiet moves. ' : '');
  }
}

/* ------------------------------------------------------------------ *
 * 供 jev/client.ts 复用的内部工具（导出以便测试单点验证）
 * ------------------------------------------------------------------ */

export { countWinningPoints, threatMakers, countForcingReplies, allowsSustainedAttack, flipTurn, resolveVersion, VCF_PLIES, ALL_MECH, weightedPick };
