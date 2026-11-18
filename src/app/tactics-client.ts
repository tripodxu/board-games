/* tactics-client.ts — 战术计算后台线程客户端（主线程零阻塞 + 自动回退）。
 *
 * 与 `rapfi-worker.ts` 的差异：战术层是纯 TS 模块，不依赖 `importScripts`，
 * 可直接走标准 Vite module worker（`new Worker(new URL('./tactics-worker.ts', import.meta.url), { type: 'module' })`）。
 * 若运行环境不支持 Worker / module worker（如 Node、happy-dom、旧浏览器），
 * 自动回退到主线程同步计算，保证功能 100% 可用。
 */
import { computeTactics } from '../core/tactics.ts';
import type { TacticsReport } from '../core/tactics.ts';
import { computeTacticHints } from '../core/tactics-hints.ts';
import type { TacticHint } from '../core/tactics-hints.ts';
import type { Engine, Move } from '../core/types.ts';
import type { TacticsWorkerReq, TacticsWorkerRes } from './tactics-worker.ts';

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;

interface PendingJob {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}
const pending = new Map<number, PendingJob>();

function resetWorker(reason: string): void {
  if (worker) {
    try { worker.terminate(); } catch { /* ignore */ }
    worker = null;
  }
  const err = new Error(reason);
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker !== 'function') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./tactics-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<TacticsWorkerRes>): void => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      if (msg.ok) job.resolve(msg.data);
      else job.reject(new Error(msg.error || '战术 Worker 计算失败'));
    };
    w.onerror = (): void => {
      workerBroken = true;
      resetWorker('战术 Worker 运行失败，已回退主线程');
    };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

type TacticsWorkerPayload = TacticsWorkerReq extends infer U ? (U extends TacticsWorkerReq ? Omit<U, 'id'> : never) : never;

function postJob<T>(req: TacticsWorkerPayload): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('no-worker'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    try {
      w.postMessage({ ...req, id } as TacticsWorkerReq);
    } catch (e: unknown) {
      pending.delete(id);
      workerBroken = true;
      resetWorker('战术 Worker 通信失败');
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** 异步跑战术事实（优先 Worker，不支持或失败时透明回退主线程）。 */
export async function runTacticsAsync(
  engine: Engine,
  st: unknown,
  legal: Move[],
  cands: string[] | null | undefined,
  versionId?: string | null,
): Promise<TacticsReport> {
  if (!engine.deepTactics) {
    return computeTactics(engine, st, legal, cands, versionId);
  }
  if (!workerBroken && typeof Worker === 'function') {
    try {
      return await postJob<TacticsReport>({
        kind: 'tactics',
        gameId: engine.id,
        st,
        cands: cands ?? null,
        versionId,
      });
    } catch {
      /* 透明回退主线程，确保对局不中断 */
    }
  }
  return computeTactics(engine, st, legal, cands, versionId);
}

/** 异步算战术分层提示（优先 Worker，不支持或失败时透明回退主线程）。 */
export async function runTacticHintsAsync(
  engine: Engine,
  st: unknown,
  versionId?: string | null,
): Promise<TacticHint> {
  if (!engine.deepTactics) {
    return computeTacticHints(engine, st, versionId);
  }
  if (!workerBroken && typeof Worker === 'function') {
    try {
      return await postJob<TacticHint>({
        kind: 'hints',
        gameId: engine.id,
        st,
        versionId,
      });
    } catch {
      /* 透明回退主线程 */
    }
  }
  return computeTacticHints(engine, st, versionId);
}

/** 测试用：重置 Worker 状态。 */
export function resetTacticsWorkerForTest(): void {
  workerBroken = false;
  resetWorker('reset');
}
