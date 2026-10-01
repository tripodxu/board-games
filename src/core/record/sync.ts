/* record/sync.ts — 棋谱自动同步的策略层（排队 / 去重 / 重试）
 * （迁移自 js/app.js:805-837 的 `uploadGameRecord()`）
 *
 * 旧实现：终局后 fire-and-forget 一次 POST，失败就永久放弃，只把结果文案写进
 * `BACKEND.lastSync` 供顶栏显示（没有队列、没有重试）。本模块保留**同一文案口径**
 * （`'成功 · <文件名>'` / `'成功'` / `'失败（HTTP n）'` / `'失败（无后端或网络异常）'`）
 * 与同一触发时机（终局后调一次 `sync()`），另外补齐离线场景：
 *
 *  - **去重**：同一局同一棋谱（键 = `gameUid|notation`）成功过一次就不再重发；
 *    悔棋后重下导致棋谱变化时键随之变化，仍会重新上传（不会被误吞）。
 *  - **队列 + 重试**：失败条目落 `storage`，`flush()` 在下次开局/上线时按指数退避重试，
 *    超过 `maxAttempts` 才丢。
 *
 * 注入式设计：不碰 `fetch`/`localStorage`/定时器。`post` 由调用方提供（浏览器里就是
 * `src/core/api/client.ts` 的 `saveGame`），`storage` 是 `localStorage` 的最小接口，
 * `now()` 可注入以便单测确定性地推进退避。因此本模块可在 Node 里直接单测。
 */
import type { StorageLike } from '../persist.ts';
import type { GameRecord } from './export.ts';

/** 同步去重账本 + 待重试队列的存储键（新键，不与旧设置/战绩簿混用）。 */
export const SYNC_KEY = 'jev_qiguan_sync_v1';

/** 去重账本最多记住多少条（localStorage 有配额，只存键不存棋谱）。 */
export const SYNC_MAX_SENT = 200;

/** 待重试队列最多积压多少条（每条是一份完整棋谱，配额有限，故上限很小）。 */
export const SYNC_MAX_PENDING = 5;

/** 单条记录最多尝试几次（首次 + 2 次重试）。 */
export const SYNC_MAX_ATTEMPTS = 3;

/** 指数退避：第 n 次失败后等 `1000 * 2^(n-1)` 毫秒，封顶 60s。 */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(1, attempts | 0);
  return Math.min(60000, 1000 * Math.pow(2, n - 1));
}

/** 注入的 POST 结果。`ok:false` + `status` 表示 HTTP 层失败（对应旧实现的 `!r.ok`）；
 *  `ok:false` 且无 `status` 视同网络异常。 */
export interface SyncHttpResponse {
  ok: boolean;
  status?: number;
  id?: string;
  gameUid?: string;
  dedup?: boolean;
  path?: string;
}

/** 注入的上传函数；抛异常 = 网络异常（对应旧实现的 `catch`）。 */
export type SyncPost = (record: GameRecord) => Promise<SyncHttpResponse>;

/** 队列里的待重试条目。 */
export interface PendingSync {
  key: string;
  gameUid: string;
  notation: string;
  record: GameRecord;
  attempts: number;
  lastAt: number;
  /** 到点才重试（`lastAt + retryDelayMs(attempts)`） */
  nextAt: number;
  lastStatus?: number;
}

/** 顶栏显示用的同步状态（旧 `BACKEND.lastSync`）。 */
export interface SyncState {
  ok: boolean;
  text: string;
}

/** `sync()` / `flush()` 的单条结果。 */
export interface SyncResult extends SyncState {
  /** 未发起上传（不自动同步 / 空棋谱 / 本地去重命中） */
  skipped?: boolean;
  /** 服务端或本地判定为重复 */
  dedup?: boolean;
  key: string;
  attempts: number;
  /** 本次调用结束后队列里还剩多少条待重试 */
  pending: number;
  checkedAt: number;
}

export interface SyncQueueOpts {
  post: SyncPost;
  storage?: StorageLike | null;
  now?: () => number;
  /** 是否启用自动同步（旧 `S.settings.gameSync !== false`）。默认启用。 */
  enabled?: () => boolean;
  maxAttempts?: number;
  maxPending?: number;
  maxSent?: number;
  key?: string;
}

export interface SyncQueue {
  /** 终局后调一次：先补发到点的积压条目，再上传本局（失败则入队）。 */
  sync(record: GameRecord): Promise<SyncResult>;
  /** 只补发到点的积压条目（下次开局 / 后端探活成功时调）。 */
  flush(): Promise<SyncResult[]>;
  /** 最近一次结果，`null` = 从未同步过（旧 `BACKEND.lastSync` 初值）。 */
  state(): SyncState | null;
  pending(): PendingSync[];
  /** 已成功同步过的去重键（给 UI 显示「已同步 N 局」或单测断言）。 */
  sent(): string[];
  /** 清空账本与队列（P6「清空同步队列」按钮 / 单测隔离）。 */
  reset(): void;
}

interface SyncStore {
  v: number;
  sent: string[];
  pending: PendingSync[];
}

/** 去重键：棋谱内容变了就变（旧实现无此逻辑，见文件头注）。 */
export function syncKey(record: GameRecord): string {
  const uid = record && record.gameUid ? record.gameUid : (record && record.exported) || '';
  const nota = record && typeof record.notation === 'string' ? record.notation : '';
  return uid + '|' + nota;
}

/** 旧实现的成功文案：`'成功 · ' + String(j.path).split('/').pop()`，无 path 时只是 `'成功'`。 */
export function successText(res: SyncHttpResponse | null): string {
  const p = res && res.path ? String(res.path) : '';
  return p ? '成功 · ' + p.split('/').pop() : '成功';
}

function readStore(storage: StorageLike | null, key: string): SyncStore {
  const empty: SyncStore = { v: 1, sent: [], pending: [] };
  if (!storage) return empty;
  try {
    const raw = JSON.parse(storage.getItem(key) || 'null') as Partial<SyncStore> | null;
    if (!raw || typeof raw !== 'object') return empty;
    return {
      v: 1,
      sent: Array.isArray(raw.sent) ? raw.sent.filter((x): x is string => typeof x === 'string') : [],
      pending: Array.isArray(raw.pending) ? raw.pending.filter((x): x is PendingSync => !!x && typeof x === 'object' && typeof x.key === 'string') : [],
    };
  } catch (_) {
    return empty;
  }
}

function writeStore(storage: StorageLike | null, key: string, s: SyncStore): void {
  if (!storage) return;
  try { storage.setItem(key, JSON.stringify({ v: 1, sent: s.sent, pending: s.pending })); } catch (_) { /* ignore */ }
}

/** 建一个同步队列。所有副作用都经过注入的 `post` 与 `storage`。 */
export function createSyncQueue(opts: SyncQueueOpts): SyncQueue {
  const post = opts.post;
  const storage = opts.storage || null;
  const now = opts.now || (() => Date.now());
  const enabled = opts.enabled || (() => true);
  const maxAttempts = opts.maxAttempts || SYNC_MAX_ATTEMPTS;
  const maxPending = opts.maxPending || SYNC_MAX_PENDING;
  const maxSent = opts.maxSent || SYNC_MAX_SENT;
  const skey = opts.key || SYNC_KEY;

  let store = readStore(storage, skey);
  let last: SyncState | null = null;

  function persist(): void { writeStore(storage, skey, store); }

  function remember(key: string): void {
    const i = store.sent.indexOf(key);
    if (i >= 0) store.sent.splice(i, 1);
    store.sent.push(key);
    if (store.sent.length > maxSent) store.sent = store.sent.slice(-maxSent);
  }

  function enqueue(rec: PendingSync): void {
    const i = store.pending.findIndex((p) => p.key === rec.key);
    if (i >= 0) store.pending[i] = rec; else store.pending.push(rec);
    if (store.pending.length > maxPending) store.pending = store.pending.slice(-maxPending);
  }

  /** 尝试上传一条；返回结果并就地维护账本/队列。 */
  async function attempt(record: GameRecord, key: string, attempts: number): Promise<SyncResult> {
    const at = now();
    let res: SyncHttpResponse | null = null;
    let failed = false;
    try {
      res = await post(record);
    } catch (_) {
      failed = true;
    }
    if (!failed && res && res.ok) {
      remember(key);
      store.pending = store.pending.filter((p) => p.key !== key);
      persist();
      last = { ok: true, text: successText(res) };
      return { ...last, key, dedup: !!(res && res.dedup), attempts, pending: store.pending.length, checkedAt: at };
    }
    /* 失败：留队列等退避重试；超过上限才丢 */
    const n = attempts + 1;
    const status = !failed && res && typeof res.status === 'number' ? res.status : undefined;
    if (n < maxAttempts) {
      enqueue({
        key,
        gameUid: record.gameUid || '',
        notation: record.notation || '',
        record,
        attempts: n,
        lastAt: at,
        nextAt: at + retryDelayMs(n),
        lastStatus: status,
      });
    } else {
      store.pending = store.pending.filter((p) => p.key !== key);
    }
    persist();
    last = {
      ok: false,
      text: failed || typeof status !== 'number' ? '失败（无后端或网络异常）' : '失败（HTTP ' + status + '）',
    };
    if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
      console.warn('[gameSync] 上传失败:', status === undefined ? '(网络异常)' : status, '第 ' + n + '/' + maxAttempts + ' 次');
    }
    return { ...last, key, attempts: n, pending: store.pending.length, checkedAt: at };
  }

  async function flush(): Promise<SyncResult[]> {
    const at = now();
    const due = store.pending.filter((p) => p.nextAt <= at);
    const out: SyncResult[] = [];
    for (const p of due) out.push(await attempt(p.record, p.key, p.attempts));
    return out;
  }

  return {
    async sync(record: GameRecord): Promise<SyncResult> {
      const at = now();
      const key = syncKey(record);
      /* 补发到点的积压条目：旧实现在这里什么都不做，属于有意补强 */
      await flush();
      if (!enabled() || !record || !record.notation) {
        return { ok: false, skipped: true, text: '未上传（自动同步关闭或无棋谱）', key, attempts: 0, pending: store.pending.length, checkedAt: at };
      }
      if (store.sent.indexOf(key) >= 0) {
        last = { ok: true, text: '成功 · 已同步过' };
        return { ok: true, skipped: true, dedup: true, text: last.text, key, attempts: 0, pending: store.pending.length, checkedAt: at };
      }
      return attempt(record, key, 0);
    },
    flush,
    state: () => last,
    pending: () => store.pending.slice(),
    sent: () => store.sent.slice(),
    reset(): void {
      store = { v: 1, sent: [], pending: [] };
      last = null;
      persist();
    },
  };
}

/** 把 `src/core/api/client.ts` 的 `saveGame` 适配成注入式 `post`。
 *  注意：`saveGame` 失败时返回 `null` 且丢掉了 HTTP 状态码，因此这条路径只能
 *  复刻「失败（无后端或网络异常）」；要拿到 `失败（HTTP n）` 得直接用 `call()`。 */
export function postViaSaveGame(
  saveGame: (payload: unknown) => Promise<SyncHttpResponse | null>,
): SyncPost {
  return async (record: GameRecord): Promise<SyncHttpResponse> => {
    const r = await saveGame(record);
    if (!r) return { ok: false };
    return r;
  };
}
