/* tactics.ts — 战术事实推算与事实注入（迁移自 js/jev-client.js 的战术层）
 *
 * 战术层回答的问题是：**在概率之上再叠一层确定性事实**。Jev 只给概率分布，
 * 它可能把「一步致胜」判成 0.2；这里把「这一步直接赢」「对方下一步赢」「造双杀」
 * 「连续冲四将死链」这类**可判定事实**在引擎上穷举出来，交给 orchestrator 接管。
 *
 * 十三级保险（接管顺序，见 decide）：
 *   win → block → open4 → threat → vcfAttack → vctAttack → vcfDefense → vctDefense →
 *   live3Attack → live3Defense → parry → parry3 → parry4
 * 每一级都受**版本闸门**（tactics-versions.mech）约束：老版本没实现的层连算都不算，
 * 否则「v4 的行为」会随新代码漂移，实验就没法按版本归因。
 *
 * v13 的压力闸门（`pressureGate`）在 live3Attack **之前**插一层：对手的做四手数
 * （pressure_opponent）压过我们（pressure_you）时先走 `pressure_cut_points`（1-ply 模拟里
 * 让对手做四手数最小的点，削掉他的网），没有削点时才照旧抢活三——理由见 gomoku.ts 的
 * v13 注释与 ADR-0017。
 *
 * v14（`live3Fresh`）不动层数，只**纠偏** live3 两层的判据：制造点必须由这一手新造
 * （见 types.ts 的 Live3Options 与 docs/plans/2026-10-03-tactics-v14-fresh-live3.md）。
 *
 * 纯逻辑：只依赖 engine 接口 + 版本登记表；无 DOM、无网络。异步仅出现在 callRaw 一侧。
 */
import { weightedPick } from './weighted.ts';
import { ids, resolve } from './tactics-versions.ts';
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
  /** v11：VCT（冲四链 + 活三逼迫，5 手攻击）算出的必胜首步（VCF 看不见时的更强搜索）。 */
  vct_win_you: string[];
  /** v12：对手的连续威胁链拆点（与 vcf_win_opponent 同语义：对手有链时我们该走的点）。 */
  vct_win_opponent: string[];
  /** v12：对手那条链本身（链首在前，供面板/取证；我们拆得掉时才可能非空）。 */
  vct_chain_opponent: string[];
  /** v10：己方活三制造点（4 手内必胜威胁，覆盖跳活三 / 斜向组合）。 */
  live3_you: string[];
  /** v10：对手的活三制造点。 */
  live3_opponent: string[];
  /** v10：破活三的落点（并列最优里最先评估到的，可能为空数组）。 */
  live3_deny_points: string[];
  /** v13：己方做四手数（邻域内落子即成冲四的空点数）——2 手的取势指标，不是必胜事实。 */
  pressure_you: number;
  /** v13：对手做四手数；大于 pressure_you 时压力闸门开火（先削点，不抢活三）。 */
  pressure_opponent: number;
  /** v13：削点（落子后对手做四手数最小的点，并列里自己做四手数更大者优先）。空 = 没得削。 */
  pressure_cut_points: string[];
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

/** 18 个机制键全开的桩版本（引擎没接战术登记表时的兜底）。 */
const ALL_MECH: Record<string, boolean> = {
  win: true, block: true, open4: true, threat: true,
  vcfAttack: true, vcfDefense: true, vctAttack: true, vctDefense: true, pressureGate: true,
  live3Attack: true, live3Defense: true, live3Fresh: true,
  parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true,
};

/** VCF 搜索深度（ply）。7 是 gomoku 上「够用且不卡」的实测值。 */
const VCF_PLIES = 7;

/** VCT 搜索深度（ply）：9 = 攻方 5 手，够覆盖实测里 2–5 手的「活三逼迫 + 冲四收尾」链。 */
const VCT_PLIES = 9;

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
    vct_win_you: [], vct_win_opponent: [], vct_chain_opponent: [],
    live3_you: [], live3_opponent: [], live3_deny_points: [],
    pressure_you: 0, pressure_opponent: 0, pressure_cut_points: [],
  };
}

/** 换手（不改入参 state：拷贝一层后只改 turn，与 ADR-0004 的纯函数要求一致）。 */
function flipTurn<S>(st: S, sideId: string): S {
  return Object.assign({}, st as object, { turn: sideId }) as S;
}

/** 解析战术版本（P0/D2）：未知档号回落 **`v0-off`（空机制集）**，绝不回落「全开」。
 *
 *  过去 catch 后返回 `ALL_MECH`：一个写错的档号会让这一手跑满全部机制 —— 标签还写着
 *  那个错档号，既不是它、也不是当前档，实验数据直接失真。现在只允许「什么都不做」：
 *  宁可战术层空转（可观测、可解释），也不许悄悄变成别的档位。登记表本身不可用时同理。
 */
function resolveVersion(versionId?: string | null): { id: string; mech: Record<string, boolean> } {
  try {
    const v: TacticsVersion = resolve(versionId);
    if (v && v.id) return { id: v.id, mech: (v.mech || {}) as Record<string, boolean> };
  } catch (_) { /* 未知档号 / 登记表不可用：按空机制集处理（见上） */ }
  return { id: ids()[0] || 'v0-off', mech: {} };
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
    vct_win_you: [],
    vct_win_opponent: [],
    vct_chain_opponent: [],
    live3_you: [],
    live3_opponent: [],
    live3_deny_points: [],
    pressure_you: 0,
    pressure_opponent: 0,
    pressure_cut_points: [],
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

  /* VCT（连续威胁搜索）：v11 起。VCF 只搜冲四，实测两臂 24 局里 v10 有 20 手存在
     「先造活三逼迫、再用冲四收尾」的必胜链（连 11 ply 纯冲四也看不见），当时走的却是启发式
     活三点。这里在 VCF 无解时再跑一遍含活三的连续威胁搜索（攻方 5 手，见引擎 vctWin）。 */
  if (engine.deepTactics && typeof engine.vctWin === 'function' && win.length === 0 && block.length === 0
      && oppSide && M.vctAttack && res.vcf_win_you.length === 0) {
    try {
      const vct = engine.vctWin(st, side, VCT_PLIES);
      if (vct && vct.win && vct.first) res.vct_win_you = [vct.first];
    } catch (_) { /* 同上：引擎差异 fail-soft */ }
  }

  /* 连续威胁链的防守（v12）：v11 起只把对手的**纯冲四**链逐点试过（vcfDefense），对手把链换成
     「活三逼迫 + 冲四收尾」就放行了。实测两轮 v11 vs rapfi@500ms 共 48 个「我方无杀而对手有链」
     的回合：实走拆掉 33 个、漏 15 个，其中 2 个存在能拆的点却没走（计时轮 #8 ply24 → K9、
     首轮 #6 ply52 → K8）。这里在 VCF 守没找到点时再算一遍含活三的链，并对「链上各点 → 链点邻域
     → 全部邻近空点」逐一验「落子后对手既无 VCF 也无 VCT」（见引擎 vctDefense）。 */
  if (engine.deepTactics && typeof engine.vctDefense === 'function' && win.length === 0 && block.length === 0
      && oppSide && M.vctDefense && res.vcf_win_you.length === 0 && res.vct_win_you.length === 0
      && res.vcf_win_opponent.length === 0) {
    try {
      const candNotations = (cands && cands.length) ? cands : legal.map((m) => m.notation);
      const def = engine.vctDefense(st, side, VCT_PLIES, { cands: candNotations });
      if (def) {
        if (def.chain.length) res.vct_chain_opponent = def.chain;
        if (def.points.length) res.vct_win_opponent = def.points;
      }
    } catch (_) { /* 同上：引擎差异 fail-soft */ }
  }

  /* 压力（v13）：两侧的「做四手数」。不是必胜事实，而是取势对照——对手做四点比我们多时，
     我们先抢活三大概率只是送一个逼手，下一步就被他的网罩住（六轮 39 个这样的回合里，
     实走之后对手仍握双四威胁的有 37 个；改走削点，双四威胁降到 7 个）。闸门开火时才算削点：
     1-ply 模拟里挑「对手做四手数最小」的点，一个都削不动就返回空数组（client 侧不开火）。 */
  if (engine.deepTactics && typeof engine.fourPressure === 'function' && win.length === 0 && block.length === 0
      && oppSide && M.pressureGate) {
    try {
      res.pressure_you = engine.fourPressure(st, side);
      res.pressure_opponent = engine.fourPressure(st, oppSide.id);
      if (res.pressure_opponent > res.pressure_you && typeof engine.pressureCut === 'function') {
        /* 只把**模型候选**当前置优先序；不能像别处那样退回「全部合法着法」——那等于按行序盲试，
         * 会把真正有效的削点挤出候选上限（实测 `1be84659` ply24 的 C8 就在第 40 个之后）。 */
        const cut = engine.pressureCut(st, side, { cands: (cands && cands.length) ? cands : [] });
        if (cut && cut.points.length) res.pressure_cut_points = cut.points;
      }
    } catch (_) { /* 同上：引擎差异 fail-soft */ }
  }

  /* 4-ply 活三（v10）：v9 之前只有「活四制造点」（2-ply），跳活三/斜向组合全靠模型自己看，
     实测正是输给搜索算法的口子。这里用引擎的 live3Makers / live3Deny 真推演（4 手内必胜）。
     v14 起 `live3Fresh` 把判据纠偏成「制造点必须由这一手新造」：注入模型的事实与接管点不再
     被本方既有的活四制造点放大（实测虚报率 67.9%，见 Live3Options 与 v14 计划文档）。 */
  if (engine.deepTactics && typeof engine.live3Makers === 'function' && win.length === 0 && block.length === 0
      && oppSide && (M.live3Attack || M.live3Defense)) {
    try {
      const candNotations = (cands && cands.length) ? cands : legal.map((m) => m.notation);
      const l3opts = { fresh: M.live3Fresh === true };
      if (M.live3Defense) {
        res.live3_opponent = engine.live3Makers(st, oppSide.id, l3opts);
        if (res.live3_opponent.length && typeof engine.live3Deny === 'function') {
          const deny = engine.live3Deny(st, side, candNotations, l3opts);
          if (deny && deny.best && deny.best.length) res.live3_deny_points = deny.best;
        }
      }
      /* 抢攻层留到最后算：对手已有活三时我们的活三通常来不及（守卫逻辑在 client 侧判） */
      if (M.live3Attack) res.live3_you = engine.live3Makers(st, side, l3opts);
    } catch (_) { /* 同上：引擎差异 fail-soft */ }
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
      'If `vct_win_you` is non-empty, playing that point starts a forced threat sequence that mixes consecutive fours with forcing open threes and wins within five of your moves — take it when there is no immediate win, block, or double-threat above. ' +
      'If `vct_win_opponent` is non-empty, the opponent has such a mixed forced sequence; playing that point breaks the whole chain (it leaves the opponent with neither a four-chain nor a mixed one), so prefer it over your own open-three attacks. ' +
      'If `danger_points_opponent` is non-empty, the opponent would create such a double threat next turn unless stopped, so block one of those points now (after handling any immediate win or block above). ' +
      'If `live3_opponent` is non-empty, the opponent has points that would create two open-four threats at once (winning within four moves even if you block one); `live3_deny_points` lists the moves that remove that threat — play one of them unless a more urgent item above applies. ' +
      'If `live3_you` is non-empty and the opponent has no equal or faster threat, playing one of those points creates a double open-four threat of your own, winning within four moves. ' +
      (tactics.pressure_you || tactics.pressure_opponent
        ? '`pressure_you` and `pressure_opponent` count how many points would immediately create a four for each side; when `pressure_opponent` is greater than `pressure_you`, the opponent is already weaving a net of fours while your own open-three attack would only be a forcing move — play `pressure_cut_points` instead (the point that leaves the opponent with the fewest four-making points), not `live3_you`. '
        : '') +
      (experience ? 'The state also includes `experience`: first_player_win_rate over past games reaching this same opening; weigh it when judging quiet moves. ' : '');
  }
}

/* ------------------------------------------------------------------ *
 * 供 jev/client.ts 复用的内部工具（导出以便测试单点验证）
 * ------------------------------------------------------------------ */

export { countWinningPoints, threatMakers, countForcingReplies, allowsSustainedAttack, flipTurn, resolveVersion, VCF_PLIES, VCT_PLIES, ALL_MECH, weightedPick };
