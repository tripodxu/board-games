/* tactics-worker.ts — 战术计算后台线程（Vite module worker）。
 *
 * 动机（docs/performance.md P1-5）：五子棋战术层（VCF / VCT 攻防 / 活三 / 压力闸门）
 * 单步在主线程同步跑 200ms–4.6s，会冻结 UI 交互与思考计时器。
 * 搬进 Worker 后与 `rapfi-worker.ts` 同口径：主线程保持流畅，Node / 无 Worker 环境
 * 由 `tactics-client.ts` 自动回退主线程。
 */
import { getGame } from '../core/registry.ts';
import { computeTactics, emptyTactics } from '../core/tactics.ts';
import { computeTacticHints } from '../core/tactics-hints.ts';

export type TacticsWorkerReq =
  | {
      id: number;
      kind: 'tactics';
      gameId: string;
      st: unknown;
      cands: string[] | null;
      versionId?: string | null;
    }
  | {
      id: number;
      kind: 'hints';
      gameId: string;
      st: unknown;
      versionId?: string | null;
    };

export type TacticsWorkerRes =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string };

const ctx = globalThis as unknown as {
  onmessage: ((ev: MessageEvent<TacticsWorkerReq>) => void) | null;
  postMessage: (msg: TacticsWorkerRes) => void;
};

if (typeof ctx.postMessage === 'function') {
  ctx.onmessage = (ev: MessageEvent<TacticsWorkerReq>): void => {
    const req = ev.data;
    if (!req || typeof req !== 'object') return;
    try {
      const engine = getGame(req.gameId);
      if (!engine) {
        ctx.postMessage({ id: req.id, ok: true, data: req.kind === 'tactics' ? emptyTactics() : { version: req.versionId || '', marks: [], legend: [] } });
        return;
      }
      if (req.kind === 'tactics') {
        const legal = engine.getLegalMoves(req.st);
        const report = computeTactics(engine, req.st, legal, req.cands, req.versionId);
        ctx.postMessage({ id: req.id, ok: true, data: report });
      } else {
        const hint = computeTacticHints(engine, req.st, req.versionId);
        ctx.postMessage({ id: req.id, ok: true, data: hint });
      }
    } catch (e: unknown) {
      ctx.postMessage({
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
}
