/* panels/record-book.ts — 战绩簿（迁移自 js/app.js:1543-1624 与 1626 一带的统计口径）
 *
 * 覆盖的旧函数与行号：
 *   loadRecords() / saveGameRecord()  js/app.js:1544-1583 → createRecordStore() / upsert 口径
 *   renderRecords()                   js/app.js:1584-1624 → renderRecords() / renderRecordStats() / recordRow()
 *   清空按钮 #clearRecords            index.html:334     → bindClearRecords()
 *
 * 风格（与 settings.ts/cockpit.ts 一致）：**重建子树 + 静态节点 onOnce**。每次都通读 props.records
 * 重画 `#recordStats` 与 `#records` 两个容器；`#clearRecords` 是静态按钮，`onOnce` 只绑一次。
 *
 * 刻意差异：
 *  1. **持久化注出**：旧实现直接读写 `localStorage[RECORDS_KEY]`；这里给 `createRecordStore(storage)`
 *     收一个 `StorageLike`（`src/core/persist.ts` 的同名接口），装配层传 `localStorage` 或内存假件。
 *     本模块自身不 import localStorage。
 *  2. 旧 `renderRecords()` 开头会调 `renderCalibration()`（校准面板）；校准面板不在本次交付清单里
 *     （见 src/ui/README.md 的 TODO(calibration)），装配层需自行保证调用顺序。
 *  3. 旧实现用 innerHTML 拼行；这里用真实节点（`.rec-row` 的结构与 class 逐字保留）。
 *  4. 旧 `saveGameRecord()` 兼管「本局 sessionId 生成 + 终局只记一条」；本模块只做 `store.save(rec)`
 *     （同 id 覆盖 + 保留最后 60 条），sessionId 由装配层的 `GameSession` 负责。
 */
import type { StorageLike } from '../../core/persist.ts';
import { append, clear, el, onOnce, qs, replaceChildren, setText, type UiRoot } from '../dom.ts';

/** 战绩簿的 localStorage 键（旧 `RECORDS_KEY`，js/app.js:1545 一带）。 */
export const RECORDS_KEY = 'jev_qiguan_records_v1';

/** 落盘时保留的最近条数（旧 `all.slice(-60)`）。 */
export const RECORDS_MAX = 60;

/** 表格里展示的最近条数（旧 `all.slice(-12).reverse()`）。 */
export const RECORDS_ROWS = 12;

/** 模式显示名（旧 `mode` 映射，js/app.js:1566）。 */
export const MODE_LABELS: Record<string, string> = {
  'human-ai': '人机',
  'ai-ai': '机机',
  pvp: '双人',
};

/** 一条战绩（旧 `saveGameRecord()` 的 `rec` 字段，全可选以兼容老记录）。 */
export interface GameRecord {
  id: string;
  /** 时间戳（ms） */
  t: number;
  /** 棋种显示名（`engine.name`） */
  game: string;
  gid?: string;
  slug?: string;
  /** 联名（`duel.duelLabel()`） */
  duel?: string;
  mock?: boolean;
  /** 已本地化的模式名（人机/机机/双人） */
  mode?: string;
  /** 胜方文案（`resultText()`，含「和棋」） */
  winner?: string;
  firstWin?: boolean | null;
  reason?: string;
  /** 'human' = 人手认输（统计时单独看） */
  endBy?: string;
  notas?: string[];
  moves?: number;
  aiMoves?: number;
  avgLat?: number;
  cost?: number;
  cal?: number[] | null;
}

/** 战绩簿读写（`StorageLike` 由装配层注入）。 */
export interface RecordStore {
  all(): GameRecord[];
  /** 同 id 覆盖，否则追加；返回落盘后的列表（已截到 RECORDS_MAX）。 */
  save(rec: GameRecord): GameRecord[];
  clear(): void;
}

function parseRecords(raw: string | null): GameRecord[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as GameRecord[]) : [];
  } catch {
    return [];
  }
}

/** 建一个战绩簿 store（旧 `loadRecords()` + `saveGameRecord()` 的持久化部分）。 */
export function createRecordStore(storage: StorageLike): RecordStore {
  const read = (): GameRecord[] => parseRecords(storage.getItem(RECORDS_KEY));
  const write = (list: GameRecord[]): GameRecord[] => {
    const kept = list.slice(-RECORDS_MAX);
    try {
      storage.setItem(RECORDS_KEY, JSON.stringify(kept));
    } catch {
      /* 配额满/隐私模式：与旧实现一样静默忽略 */
    }
    return kept;
  };
  return {
    all: read,
    save(rec: GameRecord): GameRecord[] {
      const list = read();
      const idx = list.findIndex((r) => r.id === rec.id);
      if (idx >= 0) list[idx] = rec;
      else list.push(rec);
      return write(list);
    },
    clear(): void {
      try {
        if (storage.removeItem) storage.removeItem(RECORDS_KEY);
        else storage.setItem(RECORDS_KEY, '[]');
      } catch {
        /* ignore */
      }
    },
  };
}

export interface RecordStats {
  /** 总局 */
  total: number;
  /** 分胜负（`firstWin` 非 null/undefined） */
  decided: number;
  /** 先手胜率 0..1（无分胜负局时为 null） */
  firstWinRate: number | null;
  /** 累计花费 */
  cost: number;
  /** 均延迟（无数据为 null） */
  avgLat: number | null;
}

/** 旧 `renderRecords()` 的统计段（js/app.js:1594-1597、1599-1603）。 */
export function computeStats(records: readonly GameRecord[]): RecordStats {
  const decided = records.filter((r) => r.firstWin !== null && r.firstWin !== undefined);
  const firstWins = decided.filter((r) => r.firstWin === true).length;
  const lat = records.filter((r) => !!r.avgLat);
  return {
    total: records.length,
    decided: decided.length,
    firstWinRate: decided.length ? firstWins / decided.length : null,
    cost: records.reduce((s, r) => s + (r.cost || 0), 0),
    avgLat: lat.length ? lat.reduce((s, r) => s + (r.avgLat || 0), 0) / lat.length : null,
  };
}

function statTile(value: string, label: string): HTMLElement {
  return el('div', { class: 'rs' }, [el('b', { text: value }), el('span', { text: label })]);
}

/** 写 `#recordStats` 的 5 个 `.rs`（旧口径：先手胜率/均延迟无值时给 `–`）。 */
export function renderRecordStats(records: readonly GameRecord[], root?: UiRoot | null): void {
  const stats = computeStats(records);
  replaceChildren(qs(root ?? document, '#recordStats'), [
    statTile(String(stats.total), '总局'),
    statTile(String(stats.decided), '分胜负'),
    statTile(stats.firstWinRate == null ? '–' : Math.round(stats.firstWinRate * 100) + '%', '先手胜率'),
    statTile('$' + stats.cost.toFixed(4), '累计花费'),
    statTile(stats.avgLat == null ? '–' : Math.round(stats.avgLat) + 'ms', '均延迟'),
  ]);
}

/** 胜方单元格的补注（旧口径：认输不标，其余标前 4 字；人手认输标「人判」）。 */
function winnerNote(r: GameRecord): HTMLElement | null {
  if (r.reason && r.reason !== '认输') return el('i', { text: r.reason.slice(0, 4) });
  if (r.endBy === 'human') return el('i', { text: '人判' });
  return null;
}

/** 一行战绩（旧 `.rec-row` 的七个 `<span>`，js/app.js:1604-1619）。 */
export function recordRow(r: GameRecord): HTMLElement {
  const d = new Date(r.t);
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const row = el('div', { class: 'rec-row' + (r.winner === '和棋' ? ' draw' : '') });
  append(row, [
    el('span', { class: 'rec-time mono', text: d.getMonth() + 1 + '/' + d.getDate() + ' ' + hh }),
    el('span', { class: 'rec-game' }, [
      (r.game || '').replace(/\s/g, ''),
      r.duel ? el('i', { title: r.duel, text: r.duel }) : null,
    ]),
    el('span', { class: 'rec-mode', text: r.mode ?? '' }),
    el('span', { class: 'rec-winner' }, [r.winner ?? '', winnerNote(r)]),
    el('span', { class: 'rec-meta mono', text: (r.moves || 0) + '手' }),
    el('span', { class: 'rec-meta mono', text: r.avgLat ? r.avgLat + 'ms' : '–' }),
    el('span', { class: 'rec-meta mono', text: r.cost ? '$' + r.cost.toFixed(5) : '–' }),
  ]);
  return row;
}

export interface RecordBookProps {
  records: readonly GameRecord[];
}

export interface RecordBookHandlers {
  /** `#clearRecords` 点击（装配层负责清 store + 重画 + toast） */
  onClear?(): void;
}

/** 表头（旧 `<div class="rec-row rec-head">` 的七列）。 */
export function recordHeader(): HTMLElement {
  return el(
    'div',
    { class: 'rec-row rec-head' },
    ['时间', '棋种', '模式', '胜方', '手数', '延迟', '花费'].map((t) => el('span', { text: t })),
  );
}

/** 旧 `renderRecords()`（js/app.js:1584-1624）：统计 + 最近 12 局倒序 + 摘要。 */
export function renderRecords(props: RecordBookProps, root?: UiRoot | null): void {
  const r = root ?? document;
  const all = props.records;
  if (!all.length) {
    replaceChildren(
      qs(r, '#recordStats'),
      el('div', { class: 'feed-empty', text: '还没有历史对局，打完一局自动记账。' }),
    );
    clear(qs(r, '#records'));
    setText(qs(r, '#recordSummary'), '本机历史对局');
    return;
  }
  renderRecordStats(all, r);
  replaceChildren(qs(r, '#records'), [
    recordHeader(),
    ...all
      .slice(-RECORDS_ROWS)
      .reverse()
      .map((rec) => recordRow(rec)),
  ]);
  setText(qs(r, '#recordSummary'), '本机最近 ' + all.length + ' 局');
}

/** 绑 `#clearRecords`（静态按钮，onOnce 只绑一次）。 */
export function bindClearRecords(fn: () => void, root?: UiRoot | null): void {
  onOnce(qs(root ?? document, '#clearRecords'), 'click', () => fn());
}
