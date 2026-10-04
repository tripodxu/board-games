/* panels/experiment-report.ts — 实验报告面板（#expHistory / #expReportNote）
 *
 * 来源旧实现与行号：
 *   EXP_HISTORY_KEY / JEV_CHANS / EXP_SEED   js/app.js:1240-1272
 *   loadExpHistory() / mergeSeed / saveExpHistory  js/app.js:1273-1299
 *   fmtExpDate()        js/app.js:1300-1305
 *   recordExperiment()  js/app.js:1306-1326（entry 组装 + 去重入档）
 *   roundSides()        js/app.js:1327-1336
 *   renderExpHistory()  js/app.js:1337-1392
 *   DOM 契约            index.html:325-328（#expReportNote / #body-expreport / #expHistory）
 *
 * 风格：**重建子树 + 静态节点 onOnce**（`#expHistory` 每次整段重画；本文件不绑事件）。
 *
 * 刻意差异：
 *  1. **持久化注出**：旧实现直接读写 `localStorage[EXP_HISTORY_KEY]`；这里 `createExpHistoryStore(storage, seed?)`
 *     收 `StorageLike`（`src/core/persist.ts`），种子可替换（默认 EXP_SEED）。本模块不 import localStorage。
 *  2. 旧 `recordExperiment()` 顺手做三件事：入档、重画、上报服务端（`BG.api.saveExperiment`）。这里
 *     只留「入档」（`recordExperiment(store, entry)`），重画与上报由装配层调用。
 *  3. 旧实现用 innerHTML 拼卡片；这里用真实节点，class 结构（`.exp-total` / `.exp-card` /
 *     `.exp-card-head` / `.exp-card-rows` / `.exp-row` / `.dim` / `.hint` / `.mono`）逐字保留。
 *  4. `games[].no` 缺省按 1 处理（旧实现直接 `(g.no - 1)`，缺字段会算出 NaN 分支）；
 *     `winnerChan` 出现在 entry 里但局内无胜方时按和棋处理，与旧实现一致。
 *  5. **对比口径重做**（本次）：旧 `expTotals()` 只分「Jev 渠道 / 其他」，两侧同为 Jev 渠道时
 *     （`jev-v8 vs jev-v9`，实验真正要回答的问题）双方落进同一桶、报出无信息量的合计。
 *     新增 `expSideStats()` 按「渠道 · 战术版本 · 思考时长」分桶出「局/胜/和/胜率」，
 *     `roundScore()` 给单轮 A/B 得分率，面板顶部渲染分桶表（`expAggregate()`）。
 *     `expTotals()` 保留但只再用于「有效局数」这一个数字。
 */
import type { StorageLike } from '../../core/persist.ts';
import { tacticsLabel } from '../../core/view/duel.ts';
import type { CandsStat } from '../../core/meta.ts';
import { el, qs, replaceChildren, setText, type UiRoot } from '../dom.ts';
import { expTag, type ExperimentState } from './experiment.ts';
import { JEV_CHANNELS, sideAttribution } from './options.ts';

/** 实验历史归档的 localStorage 键（旧 `EXP_HISTORY_KEY`，js/app.js:1241）。 */
export const EXP_HISTORY_KEY = 'jev-exp-history-v1';

/** 「Jev 渠道」判定集合（旧 `JEV_CHANS`，js/app.js:1242；权威定义在 options.ts）。 */
export const JEV_CHANS = JEV_CHANNELS;

/** 战报里的一局（旧 `recordExperiment()` 与 `EXP_SEED` 的 games 元素）。 */
export interface ExpHistoryGame {
  no: number;
  blackChan?: string;
  whiteChan?: string;
  blackTac?: string | null;
  whiteTac?: string | null;
  blackThink?: number;
  whiteThink?: number;
  /** 胜方所属实验侧；null = 和棋 */
  winnerChan?: 'A' | 'B' | null;
  /** 'human' = 该局由人手认输收场 */
  by?: string | null;
  /** 与 #1 完全同谱的重复局（首轮归档的人工标注） */
  dup?: boolean;
  /** 该局黑/白方的战术层平均耗时（ms）与样本手数；Rapfi/mock 侧为 null（不过战术层） */
  blackTacMs?: number | null;
  whiteTacMs?: number | null;
  blackTacN?: number;
  whiteTacN?: number;
  /** 该局黑/白方的候选点三数（C0/m13627）；非 Jev 侧不过候选集 ⇒ null（不是 0） */
  blackCands?: CandsStat | null;
  whiteCands?: CandsStat | null;
  /** 该局黑/白方的逐提供方手数（C3/C2）：`{primary: 24, backup: 3}`；非 Jev 侧 ⇒ null。
   *  上游兜底（`backup`）的手不计入主口径，报表要能把它们单独数出来。 */
  blackProv?: Record<string, number> | null;
  whiteProv?: Record<string, number> | null;
}

/** 一轮实验的战报（旧 entry，js/app.js:1307-1319）。 */
export interface ExperimentEntry {
  /** 与 games/ 棋谱的 `experiment` 字段锚点（唯一） */
  tag: string;
  date: string;
  chanA: string;
  chanB: string;
  tacA?: string | null;
  tacB?: string | null;
  thinkA?: number;
  thinkB?: number;
  total: number;
  note?: string;
  games: ExpHistoryGame[];
}

/** 纯离线兜底战报（逐字照搬 js/app.js:1247-1272：次轮 4 局 + 首轮 6 局）。 */
export const EXP_SEED: readonly ExperimentEntry[] = [
  {
    tag: 'exp-20260929111222',
    date: '2026-09-29T11:12:22.000Z',
    chanA: 'proxy',
    chanB: 'random',
    total: 4,
    note: '次轮：random 渠道已修复为真随机采样。#4 下满 225 手和棋——双方 65 次战术触发全是防守，谁也没造出双杀；真随机散子起到了"搅局"作用。基线 4 局进攻性战术触发仍为 0。',
    games: [
      { no: 1, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A' },
      { no: 2, blackChan: 'random', whiteChan: 'proxy', winnerChan: 'A' },
      { no: 3, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A' },
      { no: 4, blackChan: 'random', whiteChan: 'proxy', winnerChan: null },
    ],
  },
  {
    tag: 'exp-20260929105234',
    date: '2026-09-29T10:52:34.000Z',
    chanA: 'proxy',
    chanB: 'random',
    total: 6,
    note: '首轮：基线因 topK=1 退化为顺序走子（A1→B1→C1…）；#1 与 #3 棋谱完全相同，记为重复局。基线 5 局进攻性战术（threat/open4/win）触发 0 次，纯被动防守。',
    games: [
      { no: 1, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A' },
      { no: 2, blackChan: 'random', whiteChan: 'proxy', winnerChan: 'A' },
      { no: 3, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A', dup: true },
      { no: 4, blackChan: 'random', whiteChan: 'proxy', winnerChan: 'A' },
      { no: 5, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A' },
      { no: 6, blackChan: 'random', whiteChan: 'proxy', winnerChan: 'A' },
    ],
  },
];

/** 实验历史读写（`StorageLike` 由装配层注入）。 */
export interface ExpHistoryStore {
  list(): ExperimentEntry[];
  save(list: readonly ExperimentEntry[]): void;
}

/** 旧 `mergeSeed`（js/app.js:1276-1288）：同 tag 且种子局数更多才覆盖；变了就按 date 倒序。 */
export function mergeSeed(
  list: ExperimentEntry[],
  seed: readonly ExperimentEntry[] = EXP_SEED,
): { list: ExperimentEntry[]; changed: boolean } {
  let changed = false;
  seed.forEach((s) => {
    const i = list.findIndex((e) => e.tag === s.tag);
    if (i === -1) {
      list.push(s);
      changed = true;
    } else if ((list[i]?.games || []).length < s.games.length) {
      list[i] = s;
      changed = true;
    }
  });
  if (changed) list.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  return { list, changed };
}

/** 建实验历史 store（旧 `loadExpHistory()` + `saveExpHistory()`，js/app.js:1273-1299）。 */
export function createExpHistoryStore(
  storage: StorageLike,
  seed: readonly ExperimentEntry[] = EXP_SEED,
): ExpHistoryStore {
  const write = (list: readonly ExperimentEntry[]): void => {
    try {
      storage.setItem(EXP_HISTORY_KEY, JSON.stringify(list));
    } catch {
      /* 隐私模式/配额：与旧实现一样静默忽略 */
    }
  };
  return {
    list(): ExperimentEntry[] {
      try {
        const raw = storage.getItem(EXP_HISTORY_KEY);
        if (raw) {
          const v: unknown = JSON.parse(raw);
          if (Array.isArray(v)) {
            const merged = mergeSeed(v as ExperimentEntry[], seed);
            if (merged.changed) write(merged.list);
            return merged.list;
          }
        }
      } catch {
        /* 坏数据当没有 */
      }
      const fresh = seed.slice();
      write(fresh);
      return fresh;
    },
    save(list: readonly ExperimentEntry[]): void {
      write(list);
    },
  };
}

/** 旧 `fmtExpDate()`（js/app.js:1300-1305）：`YYYY-MM-DD HH:mm`，非法日期给空串。 */
export function fmtExpDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一轮的 A/B 双方归因（旧 `roundSides()`，js/app.js:1330-1336）；`tactics` 可能缺省。 */
export interface RoundSide {
  channel: string;
  tactics?: string | null;
  rapfiThinkMs: number;
}

/** 轮级字段缺失时退到第 1 局棋谱（首局 A 执黑）。 */
export function roundSides(e: ExperimentEntry): { a: RoundSide; b: RoundSide } {
  const g0: ExpHistoryGame = (e.games || [])[0] ?? { no: 1 };
  return {
    a: { channel: e.chanA, tactics: e.tacA || g0.blackTac, rapfiThinkMs: e.thinkA || g0.blackThink || 0 },
    b: { channel: e.chanB, tactics: e.tacB || g0.whiteTac, rapfiThinkMs: e.thinkB || g0.whiteThink || 0 },
  };
}

export interface ExpTotals {
  jevWins: number;
  otherWins: number;
  draws: number;
  /** 有效对局（去掉 dup 的重复局） */
  effective: number;
  /** 战术层平均耗时（ms）：只统计真过了战术层的手（Rapfi/mock 侧记 null，不进样本） */
  tacAvgMs: number | null;
  /** 上面那个平均值的样本手数 */
  tacMoves: number;
  /** 候选点三数均值（C0/m13627）：`sent` = 交给 Jev 决定的点数、`graded` = 模型给了概率的点数、
   *  `labeled` = 其中带战术标签的点数。样本 = 真过了 Jev 候选集的手（非 Jev 侧记 null）。 */
  candsSent: number | null;
  candsGraded: number | null;
  candsLabeled: number | null;
  /** 上面三个平均值的样本手数 */
  candsMoves: number;
  /** 逐提供方手数汇总（C3/C2）：`{primary: 240, backup: 12}`；一手都没归因时是空表。
   *  只有真问过模型的手才有提供方（Rapfi/mock/人类侧没有）。 */
  providers: Record<string, number>;
  /** 其中**兜底**（`backup`）手数：这些手换了个网关应答，不算主口径的样本 */
  fallbackMoves: number;
}

/** 上游兜底的提供方 id（与 `core/jev/providers.ts` 的 `PROVIDER_BACKUP` 同值；
 *  这里刻意不 import worker/core 的模块，报表只认字符串口径）。 */
export const FALLBACK_PROVIDER = 'backup';

/** 逐提供方手数合并（C3）：只认正整数值，缺字段的一方按空表处理。 */
function mergeProvs(into: Record<string, number>, p: Record<string, number> | null | undefined): void {
  if (!p) return;
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (typeof v === 'number' && v > 0) into[k] = (into[k] || 0) + v;
  }
}

/** 逐提供方手数 → `primary 24 · backup 3`（报表 tooltip / 说明用；空表返回空串）。 */
export function fmtProvs(p: Record<string, number> | null | undefined): string {
  if (!p) return '';
  return Object.keys(p)
    .sort((a, b) => p[b]! - p[a]!)
    .map((k) => `${k} ${p[k]}`)
    .join(' · ');
}

/** 逐提供方手数合计（兜底手的占比分母用）。 */
export function provMovesOf(p: Record<string, number> | null | undefined): number {
  if (!p) return 0;
  let n = 0;
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (typeof v === 'number' && v > 0) n += v;
  }
  return n;
}

/** 旧 `renderExpHistory()` 的累计行口径（js/app.js:1347-1390）。 */
export function expTotals(list: readonly ExperimentEntry[]): ExpTotals {
  let jevWins = 0;
  let otherWins = 0;
  let draws = 0;
  let effective = 0;
  let tacSum = 0;
  let tacMoves = 0;
  /* 候选点三数（C0/m13627）同款加权：权重取该侧的样本手数 `n`。`graded`/`labeled` 可能与
   * `sent` 的样本不同（历史手只有 graded），按各自非空值累加，不互相冒充。 */
  let csSum = 0, csMoves = 0;
  let cgSum = 0, cgMoves = 0;
  let clSum = 0, clMoves = 0;
  /* 逐提供方手数（C3/C2）：`{primary: 240, backup: 12}`；兜底手由 `fallbackMoves` 单列 */
  const providers: Record<string, number> = {};
  /* 战术层耗时按「手」加权：一局里两边的样本合起来算，权重是该侧的样本手数 */
  const addTac = (avg: number | null | undefined, n: number | undefined) => {
    if (typeof avg !== 'number') return;
    const cnt = typeof n === 'number' && n > 0 ? n : 1;
    tacSum += avg * cnt;
    tacMoves += cnt;
  };
  const addCands = (c: CandsStat | null | undefined) => {
    if (!c || !(c.n > 0)) return;
    if (typeof c.sent === 'number') { csSum += c.sent * c.n; csMoves += c.n; }
    if (typeof c.graded === 'number') { cgSum += c.graded * c.n; cgMoves += c.n; }
    if (typeof c.labeled === 'number') { clSum += c.labeled * c.n; clMoves += c.n; }
  };
  list.forEach((e) => {
    (e.games || []).forEach((g) => {
      if (g.dup) return;
      effective++;
      addTac(g.blackTacMs, g.blackTacN);
      addTac(g.whiteTacMs, g.whiteTacN);
      addCands(g.blackCands);
      addCands(g.whiteCands);
      /* 逐提供方手数（C3/C2）：两侧合并；兜底手单列，主口径按「不含兜底」读 */
      mergeProvs(providers, g.blackProv);
      mergeProvs(providers, g.whiteProv);
      const wside = g.winnerChan ?? null;
      const wchan = wside ? (wside === 'A' ? e.chanA : e.chanB) : null;
      if (!wside) draws++;
      if (wchan) {
        if (JEV_CHANNELS.includes(wchan)) jevWins++;
        else otherWins++;
      }
    });
  });
  return {
    jevWins,
    otherWins,
    draws,
    effective,
    tacAvgMs: tacMoves ? Math.round(tacSum / tacMoves) : null,
    tacMoves,
    candsSent: csMoves ? Math.round((csSum / csMoves) * 10) / 10 : null,
    candsGraded: cgMoves ? Math.round((cgSum / cgMoves) * 10) / 10 : null,
    candsLabeled: clMoves ? Math.round((clSum / clMoves) * 10) / 10 : null,
    candsMoves: csMoves,
    providers,
    fallbackMoves: providers[FALLBACK_PROVIDER] || 0,
  };
}

/* ── 对比口径：按「渠道 · 战术版本」分桶 ────────────────────────────────────
 * 旧 `expTotals()` 只分「Jev 渠道 / 其他」两桶：两侧都是 Jev 时（`jev-v8 vs jev-v9` 这种真正
 * 要比较的场景）双方落进同一桶，报出「Jev 6 胜 · 其他 0 胜」——没有信息量。这里按每一侧的
 * **身份**（渠道 + 战术版本 + 思考时长）分桶，和棋按半分计入得分率，重复局仍不计。
 */

/** 一侧在一局里的身份。 */
export interface SideIdentity {
  channel: string;
  tactics: string | null;
  thinkMs: number;
  /** 聚合键（身份三元组）：`Rapfi(3s)` 与 `Rapfi(5s)` 算两个身份 */
  key: string;
  /** 展示名（与 `sideAttribution()` 同一口径） */
  label: string;
}

/** 取一局里某一侧的归属：局内字段优先，缺了退到轮级字段（旧 `resultCell` 的口径）。
 *
 *  轮级兜底必须按**局号奇偶**取 `tacA/tacB`：A 只在奇数局执黑，缺了局内字段时若一律拿
 *  `tacA` 去填黑方，B 执黑的那些局就会给 B 侧（例如 Rapfi）安上 A 的战术版本，分桶表里
 *  于是冒出 `rapfi|v11-vct|0` 这种并不存在的身份。 */
export function gameSide(e: ExperimentEntry, g: ExpHistoryGame, side: 'black' | 'white'): SideIdentity {
  const aIsBlack = ((g.no || 1) - 1) % 2 === 0;
  const isA = (side === 'black') === aIsBlack;
  const chan = (side === 'black' ? g.blackChan : g.whiteChan) || (isA ? e.chanA : e.chanB) || '';
  const rawTac = (side === 'black' ? g.blackTac : g.whiteTac) || (isA ? e.tacA : e.tacB) || null;
  /* 不过战术层的渠道（rapfi/mock/人类）不认档位：老棋谱里那侧写的是脚本默认值，
     照抄就会在分桶表里造出 `rapfi|v9-vcf-sound` 这种幻影身份（与归档侧的 `tacticsLabel()` 同一条规则）。 */
  const tac = tacticsLabel({ channel: chan, tactics: rawTac ?? undefined }) || null;
  const think = (side === 'black' ? g.blackThink : g.whiteThink) || (isA ? e.thinkA : e.thinkB) || 0;
  return {
    channel: chan,
    tactics: tac,
    thinkMs: think,
    key: chan + '|' + (tac ?? '') + '|' + think,
    label: sideAttribution(chan, tac, think),
  };
}

/** 一个身份在全部实验里的战绩。 */
export interface SideStat extends SideIdentity {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** 得分率 =（胜 + 和 ÷ 2）÷ 局 */
  rate: number;
  /** 战术层耗时合计（ms）与样本手数：只统计真过了战术层的手 */
  tacSum: number;
  tacMoves: number;
  /** 战术层平均耗时（ms）；没有样本（Rapfi/mock 身份）时为 null */
  tacAvgMs: number | null;
  /* 候选点三数（C0/m13627）：三个数各有自己的样本手数（历史手只有 graded） */
  candSentSum: number;
  candSentMoves: number;
  candGradedSum: number;
  candGradedMoves: number;
  candLabeledSum: number;
  candLabeledMoves: number;
  /** 候选点三数均值；非 Jev 身份（Rapfi/mock）没有样本 ⇒ null */
  candsSent: number | null;
  candsGraded: number | null;
  candsLabeled: number | null;
  /** 逐提供方手数（C3/C2）：`{primary: 24, backup: 3}`；该身份不过 Jev（Rapfi/mock）时为空表 */
  providers: Record<string, number>;
  /** 其中兜底（`backup`）手数：这些手换了网关应答，读主口径时应把它们排除 */
  fallbackMoves: number;
}

/** 把一局的战术层耗时（某一侧）并进身份统计；`null` = 该侧没过战术层，不进样本。 */
function addSideTac(s: SideStat, avg: number | null | undefined, n: number | undefined): void {
  if (typeof avg !== 'number') return;
  const cnt = typeof n === 'number' && n > 0 ? n : 1;
  s.tacSum += avg * cnt;
  s.tacMoves += cnt;
}

/** 把一局的候选点三数（某一侧）并进身份统计；`null`/样本为 0 = 该侧不过 Jev 候选集。 */
function addSideCands(s: SideStat, c: CandsStat | null | undefined): void {
  if (!c || !(c.n > 0)) return;
  if (typeof c.sent === 'number') { s.candSentSum += c.sent * c.n; s.candSentMoves += c.n; }
  if (typeof c.graded === 'number') { s.candGradedSum += c.graded * c.n; s.candGradedMoves += c.n; }
  if (typeof c.labeled === 'number') { s.candLabeledSum += c.labeled * c.n; s.candLabeledMoves += c.n; }
}

/** 按身份聚合出战绩表：局数降序 → 得分率降序 → 名称。`dup` 局不计（与 `expTotals()` 一致）。 */
export function expSideStats(list: readonly ExperimentEntry[]): SideStat[] {
  const map = new Map<string, SideStat>();
  const bucket = (id: SideIdentity): SideStat => {
    let s = map.get(id.key);
    if (!s) {
      s = { ...id, games: 0, wins: 0, draws: 0, losses: 0, rate: 0, tacSum: 0, tacMoves: 0, tacAvgMs: null,
            candSentSum: 0, candSentMoves: 0, candGradedSum: 0, candGradedMoves: 0,
            candLabeledSum: 0, candLabeledMoves: 0, candsSent: null, candsGraded: null, candsLabeled: null,
            providers: {}, fallbackMoves: 0 };
      map.set(id.key, s);
    }
    return s;
  };
  list.forEach((e) => {
    (e.games || []).forEach((g) => {
      if (g.dup) return;
      const black = bucket(gameSide(e, g, 'black'));
      const white = bucket(gameSide(e, g, 'white'));
      black.games++;
      white.games++;
      addSideTac(black, g.blackTacMs, g.blackTacN);
      addSideTac(white, g.whiteTacMs, g.whiteTacN);
      addSideCands(black, g.blackCands);
      addSideCands(white, g.whiteCands);
      /* 逐提供方手数（C3/C2）：兜底手单独计数，读主口径时排除 */
      mergeProvs(black.providers, g.blackProv);
      mergeProvs(white.providers, g.whiteProv);
      if (!g.winnerChan) {
        black.draws++;
        white.draws++;
        return;
      }
      /* A/B → 黑白：A 在奇数局执黑（与 resultCell 同一条判据，不按渠道名比对） */
      const aIsBlack = ((g.no || 1) - 1) % 2 === 0;
      const winnerIsBlack = g.winnerChan === 'A' ? aIsBlack : !aIsBlack;
      if (winnerIsBlack) {
        black.wins++;
        white.losses++;
      } else {
        white.wins++;
        black.losses++;
      }
    });
  });
  const rows = [...map.values()];
  rows.forEach((s) => {
    s.rate = s.games ? (s.wins + s.draws / 2) / s.games : 0;
    s.tacAvgMs = s.tacMoves ? Math.round(s.tacSum / s.tacMoves) : null;
    const r1 = (sum: number, moves: number) => (moves ? Math.round((sum / moves) * 10) / 10 : null);
    s.candsSent = r1(s.candSentSum, s.candSentMoves);
    s.candsGraded = r1(s.candGradedSum, s.candGradedMoves);
    s.candsLabeled = r1(s.candLabeledSum, s.candLabeledMoves);
    s.fallbackMoves = s.providers[FALLBACK_PROVIDER] || 0;
  });
  rows.sort((x, y) => y.games - x.games || y.rate - x.rate || x.label.localeCompare(y.label));
  return rows;
}

/** 单轮比分（A/B 各自的胜局与得分率）。 */
export interface RoundScore {
  a: number;
  b: number;
  draws: number;
  effective: number;
  aRate: number;
  bRate: number;
}

/** 一轮里 A/B 的比分：A 的胜局按 `winnerChan === 'A'` 数，和棋对两边各记半分。 */
export function roundScore(e: ExperimentEntry): RoundScore {
  let a = 0;
  let b = 0;
  let draws = 0;
  let effective = 0;
  (e.games || []).forEach((g) => {
    if (g.dup) return;
    effective++;
    if (!g.winnerChan) draws++;
    else if (g.winnerChan === 'A') a++;
    else b++;
  });
  const aRate = effective ? (a + draws / 2) / effective : 0;
  return { a, b, draws, effective, aRate, bRate: effective ? 1 - aRate : 0 };
}

/** `0.5` → `50%`；`0.6667` → `66.7%`。 */
export function pct(rate: number): string {
  const v = Math.round(rate * 1000) / 10;
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + '%';
}

/** 候选点均值 → 单元格文本：`58` / `58.3`，没有样本用 `—`（C0/m13627）。 */
function fmtCands(v: number | null): string {
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 一条轨道 + 填充（与排行榜 `.lb-bar` 同构，类名分开以免互相牵连）。 */
function rateBar(rate: number, label: string, cls: string): HTMLElement {
  return el('span', { class: cls, role: 'img', 'aria-label': label + ' ' + pct(rate) }, [
    el('i', { style: { width: pct(rate) } }),
  ]);
}

/** 面板顶部的「累计 + 按身份战绩表」（旧实现只有一行 `累计：Jev 渠道 …`）。 */
export function expAggregate(list: readonly ExperimentEntry[]): HTMLElement {
  const t = expTotals(list);
  const rows = expSideStats(list);
  const chans = new Set(rows.map((r) => r.channel).filter(Boolean));
  const tacs = new Set(rows.map((r) => r.tactics).filter((x): x is string => !!x));
  const total = el('div', { class: 'exp-total' }, [
    `累计 ${list.length} 轮 · ${t.effective} 局有效对局`,
    t.draws ? ` · 和棋 ${t.draws}` : null,
    ` · 渠道 ${chans.size} 个`,
    tacs.size ? ` · 战术版本 ${tacs.size} 档` : null,
    /* 战术层平均耗时（口径见 expTotals）：上这一行是为了「这层保险值不值」一眼可见 */
    t.tacAvgMs == null ? null : ` · 战术层均值 ${t.tacAvgMs}ms（${t.tacMoves} 手）`,
    /* 候选点三数（C0/m13627）：发 = 交给 Jev 决定、评 = 模型给了概率、标 = 其中带战术标签 */
    t.candsSent == null
      ? null
      : ` · 候选点均值 发 ${t.candsSent} / 评 ${fmtCands(t.candsGraded)} / 标 ${fmtCands(t.candsLabeled)}（${t.candsMoves} 手）`,
    /* 上游兜底（C3/C2）：兜底手换了网关应答，不计入主口径；主口径手数 = 有归因的手 − 兜底手 */
    t.fallbackMoves
      ? ` · 上游兜底 ${t.fallbackMoves} 手（未计入主口径 · 主口径 ${provMovesOf(t.providers) - t.fallbackMoves} 手 · ${fmtProvs(t.providers)}）`
      : null,
  ]);
  const head = el('div', { class: 'exp-agg-head' }, [
    el('span', { text: '渠道 · 战术' }),
    el('span', { text: '局' }),
    el('span', { text: '胜' }),
    el('span', { text: '和' }),
    el('span', { title: '战术层平均耗时（只统计真过了战术层的手）', text: '战术' }),
    el('span', { title: '候选点均值：发（交给 Jev 决定）/ 评（模型给了概率）/ 标（带战术标签）', text: '候选发评标' }),
    el('span', { text: '胜率' }),
  ]);
  const rowEls = rows.map((r) =>
    el('div', { class: 'exp-agg-row', dataset: { key: r.key } }, [
      el('span', { class: 'exp-agg-side', title: r.label, text: r.label }),
      el('span', { class: 'mono exp-agg-num', text: String(r.games) }),
      el('span', { class: 'mono exp-agg-num', text: String(r.wins) }),
      el('span', { class: 'mono exp-agg-num', text: String(r.draws) }),
      el('span', {
        class: 'mono exp-agg-num exp-agg-tac',
        title:
          r.tacAvgMs == null
            ? '该身份没有战术层样本（Rapfi/mock 刻意不过战术层）'
            : '战术层平均耗时 · 样本 ' + r.tacMoves + ' 手',
        text: r.tacAvgMs == null ? '—' : r.tacAvgMs + 'ms',
      }),
      el('span', {
        class: 'mono exp-agg-num exp-agg-cands',
        title:
          /* 上游兜底（C3/C2）与候选点样本是两件事：有没有候选样本都要报兜底手数，
             否则「这批手是备用网关答的」这件事会被前一个条件吞掉。 */
          (r.candsSent == null
            ? '该身份不过 Jev 候选集（Rapfi/mock），没有候选点样本'
            : '候选点均值：发 ' + r.candsSent + '（交给 Jev 决定）· 评 ' + fmtCands(r.candsGraded) +
              '（模型给了概率）· 标 ' + fmtCands(r.candsLabeled) + '（带战术标签）') +
          (r.fallbackMoves ? ' · 上游兜底 ' + r.fallbackMoves + ' 手（占 ' + provMovesOf(r.providers) +
            ' 手 · ' + fmtProvs(r.providers) + '）' : ''),
        text: r.candsSent == null ? '—' : r.candsSent + '/' + fmtCands(r.candsGraded) + '/' + fmtCands(r.candsLabeled),
      }),
      el('span', { class: 'exp-agg-rate' }, [
        rateBar(r.rate, r.label + ' 得分率', 'exp-agg-bar'),
        el('b', { class: 'mono', text: pct(r.rate) }),
      ]),
    ]),
  );
  return el('div', { class: 'exp-agg' }, [
    total,
    head,
    rowEls,
    el('div', { class: 'hint', text: '胜率 =（胜 + 和 ÷ 2）÷ 局；重复局不计。「战术」= 战术层平均耗时，「候选发评标」= 候选点均值（发给 Jev / 模型给了概率 / 带战术标签），Rapfi/mock 刻意不过战术层与候选集故记 —。「上游兜底」= 主家失败后由备用网关应答的手数，这些手不计入主口径（鼠标停在「候选发评标」上看逐身份的兜底手数）。' }),
  ]);
}

/** 局行的结果格（旧 `wl`，js/app.js:1369-1371）。 */
function resultCell(e: ExperimentEntry, g: ExpHistoryGame, wchan: string | null): HTMLElement {
  if (g.dup) return el('span', { class: 'dim', text: '重复局（与 #1 相同）' });
  if (!wchan) return el('span', { text: '→ 和棋' });
  const aIsBlackK = ((g.no || 1) - 1) % 2 === 0;
  const winnerIsBlack = (g.winnerChan ?? null) === 'A' ? aIsBlackK : !aIsBlackK;
  if (winnerIsBlack) {
    return el('span', {}, [
      '→ ',
      el('b', { text: sideAttribution(g.blackChan || e.chanA, g.blackTac, g.blackThink) + '胜' }),
      g.by === 'human' ? el('i', { text: '人判' }) : null,
    ]);
  }
  return el('span', {}, [
    '→ ',
    el('b', { text: sideAttribution(g.whiteChan || e.chanB, g.whiteTac, g.whiteThink) + '胜' }),
    g.by === 'human' ? el('i', { text: '人判' }) : null,
  ]);
}

/** 一张战报卡（旧 `.exp-card`，js/app.js:1372-1385）。 */
export function expCard(e: ExperimentEntry): HTMLElement {
  const s = roundScore(e);
  const rows = (e.games || []).map((g) => {
    const wside = g.dup ? null : g.winnerChan ?? null;
    const wchan = wside ? (wside === 'A' ? e.chanA : e.chanB) : null;
    return el('div', { class: 'exp-row' }, [
      el('span', { class: 'mono', text: '#' + g.no }),
      el('span', { text: sideAttribution(g.blackChan, g.blackTac, g.blackThink) + '(黑)' }),
      el('span', { class: 'dim', text: 'vs' }),
      el('span', { text: sideAttribution(g.whiteChan, g.whiteTac, g.whiteThink) + '(白)' }),
      resultCell(e, g, wchan),
    ]);
  });
  const sides = roundSides(e);
  return el('div', { class: 'exp-card' }, [
    el('div', { class: 'exp-card-head' }, [
      el('b', {}, [
        sideAttribution(sides.a.channel, sides.a.tactics, sides.a.rapfiThinkMs) + ' ',
        el('span', { class: 'mono', text: s.a + ' : ' + s.b }),
        ' ' + sideAttribution(sides.b.channel, sides.b.tactics, sides.b.rapfiThinkMs),
      ]),
      el('span', { class: 'dim' }, [
        `${s.effective} 局有效${s.draws ? ' · 和 ' + s.draws : ''} · ${fmtExpDate(e.date)}`,
        e.tag ? ' · ' : null,
        e.tag ? el('span', { class: 'mono', text: e.tag }) : null,
      ]),
    ]),
    /* 单轮得分率：A 侧一条，B 侧是它的补数（和棋各记半分，所以两边不一定 0/100） */
    s.effective
      ? el('div', { class: 'exp-bar-row' }, [
          el('span', { class: 'mono exp-bar-side', text: 'A ' + pct(s.aRate) }),
          rateBar(s.aRate, 'A 侧得分率', 'exp-bar'),
          el('span', { class: 'mono exp-bar-side', text: 'B ' + pct(s.bRate) }),
        ])
      : null,
    el('div', { class: 'exp-card-rows' }, rows),
    e.note ? el('div', { class: 'hint', text: e.note }) : null,
  ]);
}

/** 旧 `renderExpHistory()`（js/app.js:1337-1392）：累计行 + 每轮卡片 + `#expReportNote`。 */
export function renderExpHistory(list: readonly ExperimentEntry[], root?: UiRoot | null): void {
  const r = root ?? document;
  const box = qs(r, '#expHistory');
  if (!box) return;
  if (!list.length) {
    replaceChildren(box, [
      el('div', { class: 'hint', text: '暂无实验记录——跑完一轮对比实验后，这里会自动归档战报。' }),
    ]);
    setText(qs(r, '#expReportNote'), '');
    return;
  }
  const t = expTotals(list);
  replaceChildren(box, [expAggregate(list), ...list.map((e) => expCard(e))]);
  /* 面板标题栏的注脚：只报规模与有效局数 —— 旧文案「N 轮实验 · Jev X:Y」把两侧同渠道的
     实验（v8 vs v9）都算进「Jev」，是会误导人的口径，已由 .exp-agg 的分桶表取代。 */
  setText(
    qs(r, '#expReportNote'),
    `${list.length} 轮实验 · ${t.effective} 局有效` + (t.tacAvgMs == null ? '' : ` · 战术层均值 ${t.tacAvgMs}ms`)
      /* 候选点均值（C0/m13627）：只报「交给 Jev 几个点」这一个数，明细在分桶表里 */
      + (t.candsSent == null ? '' : ` · 候选点均值 发 ${t.candsSent}`)
      /* 上游兜底（C3/C2）：一行就够 —— 只在这轮真出现过兜底手时才出现 */
      + (t.fallbackMoves ? ` · 上游兜底 ${t.fallbackMoves} 手（未计入主口径）` : ''),
  );
}

/* ── 最新棋谱：归档里最新的对局 ─────────────────────────────────────────────
 * 需求（2026-10-01）：报告里只有 2026-09-29/30 那 6 轮实验卡片，而归档里最新的一批
 * 对局（`jev-v9-vs-jev-v9`、`rapfi vs proxy` 这种机机归档）**有的根本没挂 experiment
 * tag**，永远进不了轮次卡 —— 报告看上去停在早期实验上。这里按 `GET /api/games` 的
 * 返回顺序（服务端按 id 倒序，最新在前）列出最新 N 份，每行给「回放」直达回放器。
 */

/** 一行「最新棋谱」（装配层把 `GET /api/games` 的条目整形到这里）。 */
export interface LatestGameRow {
  gameUid: string;
  /** `MM-DD HH:MM`（行里没有时间戳时给空串） */
  when: string;
  /** 棋种中文名 */
  game: string;
  /** 黑方归因（`sideAttribution()` 口径，如 `Jev(代理) v9-vcf-sound`） */
  black: string;
  white: string;
  moves: number;
  result: string;
  /** 属于某轮实验时给出 tag 与局号（没挂 tag 的机机对局留空） */
  tag?: string;
  no?: number;
}

export interface LatestGamesProps {
  root: HTMLElement;
  /** `null` = 加载中（离线也走这条，与排行榜 / 开局库同一约定） */
  rows: LatestGameRow[] | null;
  handlers?: { onReplay?: (gameUid: string) => void };
}

/** 重画「最新棋谱」块（`root` 由装配层给出，见 `#expLatestGames`）。 */
export function renderLatestGames(props: LatestGamesProps): void {
  const { root, rows } = props;
  const onReplay = props.handlers?.onReplay;
  const head = el('div', { class: 'exp-latest-head' }, [
    el('b', { text: '最新棋谱' }),
    el('span', { class: 'dim', text: '归档里最新的对局（新 → 旧）' }),
  ]);

  if (rows === null || !rows.length) {
    replaceChildren(root, [
      el('div', { class: 'exp-latest' }, [
        head,
        el('div', { class: 'hint', text: rows === null ? '加载中…' : '归档里还没有棋谱。' }),
      ]),
    ]);
    return;
  }

  const rowEls = rows.map((r) =>
    el('div', { class: 'exp-latest-row', dataset: { uid: r.gameUid } }, [
      el('div', { class: 'exp-latest-top' }, [
        el('span', { class: 'mono exp-latest-when', text: r.when }),
        el('span', { class: 'exp-latest-game', text: r.game }),
        el('span', { class: 'mono exp-latest-moves', text: r.moves + ' 手' }),
        r.tag ? el('span', { class: 'mono dim exp-latest-tag', text: r.tag + (r.no ? ' #' + r.no : '') }) : null,
      ]),
      el('div', { class: 'exp-latest-main' }, [
        el('span', { class: 'exp-latest-side', title: r.black, text: r.black + '(黑)' }),
        el('span', { class: 'dim', text: 'vs' }),
        el('span', { class: 'exp-latest-side', title: r.white, text: r.white + '(白)' }),
        el('span', { class: 'exp-latest-result', text: '→ ' + r.result }),
      ]),
      onReplay && r.gameUid
        ? el('button', {
          class: 'exp-latest-open mini-btn',
          type: 'button',
          title: '载入「棋谱回放」面板逐手重放',
          text: '回放',
          onclick: () => onReplay(r.gameUid),
        })
        : null,
    ]),
  );

  replaceChildren(root, [el('div', { class: 'exp-latest' }, [head, ...rowEls])]);
}
/** 旧 `recordExperiment()` 的 entry 组装（js/app.js:1307-1319，note 恒为空串）。 */
export function newEntryFromRun(state: ExperimentState, date: string = new Date().toISOString()): ExperimentEntry {
  return {
    tag: state.tag ?? '',
    date,
    chanA: state.chanA,
    chanB: state.chanB,
    tacA: state.tacA,
    tacB: state.tacB,
    thinkA: state.thinkA,
    thinkB: state.thinkB,
    total: state.total,
    games: state.results.map((g) => ({
      no: g.no,
      blackChan: g.blackChan,
      whiteChan: g.whiteChan,
      blackTac: g.blackTac || null,
      whiteTac: g.whiteTac || null,
      blackThink: g.blackThink || 0,
      whiteThink: g.whiteThink || 0,
      winnerChan: g.winner ? g.winnerChan : null,
      by: g.by || null,
      /* 战术层耗时（m07650 的新口径）：null = 该侧没过战术层，聚合时落进样本外 */
      blackTacMs: typeof g.blackTacMs === 'number' ? g.blackTacMs : null,
      whiteTacMs: typeof g.whiteTacMs === 'number' ? g.whiteTacMs : null,
      blackTacN: g.blackTacN || 0,
      whiteTacN: g.whiteTacN || 0,
      /* 候选点三数（C0/m13627）：非 Jev 侧没有样本 ⇒ null（不是 0） */
      blackCands: g.blackCands ?? null,
      whiteCands: g.whiteCands ?? null,
      /* 逐提供方手数（C3/C2）：一手都没归因 ⇒ null（老棋谱与全 Rapfi 局都是这样） */
      blackProv: g.blackProv ?? null,
      whiteProv: g.whiteProv ?? null,
    })),
    note: '',
  };
}

/** 旧 `recordExperiment()` 的入档段（js/app.js:1320-1323）：同 tag 已存在则不重复插。 */
export function recordExperiment(store: ExpHistoryStore, entry: ExperimentEntry): ExperimentEntry {
  const list = store.list();
  if (!list.some((e) => e.tag === entry.tag)) list.unshift(entry);
  store.save(list);
  return entry;
}

/** tag 缺省时的兜底（装配层若在 `beginRun` 前就归档，用它补一个锚点）。 */
export function ensureTag(state: ExperimentState): string {
  return state.tag ?? expTag();
}
