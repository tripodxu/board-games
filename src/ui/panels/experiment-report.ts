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
 */
import type { StorageLike } from '../../core/persist.ts';
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
}

/** 旧 `renderExpHistory()` 的累计行口径（js/app.js:1347-1390）。 */
export function expTotals(list: readonly ExperimentEntry[]): ExpTotals {
  let jevWins = 0;
  let otherWins = 0;
  let draws = 0;
  let effective = 0;
  list.forEach((e) => {
    (e.games || []).forEach((g) => {
      if (g.dup) return;
      effective++;
      const wside = g.winnerChan ?? null;
      const wchan = wside ? (wside === 'A' ? e.chanA : e.chanB) : null;
      if (!wside) draws++;
      if (wchan) {
        if (JEV_CHANNELS.includes(wchan)) jevWins++;
        else otherWins++;
      }
    });
  });
  return { jevWins, otherWins, draws, effective };
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
  let a = 0;
  let b = 0;
  let eff = 0;
  const rows = (e.games || []).map((g) => {
    const wside = g.dup ? null : g.winnerChan ?? null;
    const wchan = wside ? (wside === 'A' ? e.chanA : e.chanB) : null;
    if (!g.dup) {
      eff++;
      if (wside === 'A') a++;
      else if (wside === 'B') b++;
    }
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
        el('span', { class: 'mono', text: a + ' : ' + b }),
        ' ' + sideAttribution(sides.b.channel, sides.b.tactics, sides.b.rapfiThinkMs),
      ]),
      el('span', { class: 'dim' }, [
        `${eff} 局有效 · ${fmtExpDate(e.date)}`,
        e.tag ? ' · ' : null,
        e.tag ? el('span', { class: 'mono', text: e.tag }) : null,
      ]),
    ]),
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
  const total = el('div', { class: 'exp-total' }, [
    '累计：Jev 渠道 ',
    el('b', { class: 'mono', text: String(t.jevWins) }),
    ' 胜 · 其他 ',
    el('b', { class: 'mono', text: String(t.otherWins) }),
    ' 胜',
    t.draws ? ' · 和棋 ' : null,
    t.draws ? el('b', { class: 'mono', text: String(t.draws) }) : null,
    `（${t.effective} 局有效对局）`,
  ]);
  replaceChildren(box, [total, ...list.map((e) => expCard(e))]);
  setText(qs(r, '#expReportNote'), `${list.length} 轮实验 · Jev ${t.jevWins}:${t.otherWins}`);
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
