/* tactics-worker.spec.ts — 战术计算 Web Worker 通道与自动回退断言 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGame } from '../../src/core/registry.ts';
import { computeTactics } from '../../src/core/tactics.ts';
import { computeTacticHints } from '../../src/core/tactics-hints.ts';
import {
  resetTacticsWorkerForTest,
  runTacticHintsAsync,
  runTacticsAsync,
} from '../../src/app/tactics-client.ts';
import type { TacticsWorkerReq, TacticsWorkerRes } from '../../src/app/tactics-worker.ts';

const gomoku = getGame('gomoku')!;

function midgameState() {
  let st = gomoku.newGame();
  for (const n of ['I9', 'H8', 'J10', 'H9', 'K11', 'H10', 'M13', 'H11']) {
    const mv = gomoku.moveFromNotation(st, n)!;
    st = gomoku.applyMove(st, mv);
  }
  return st;
}

class FakeTacticsWorker {
  static instances: FakeTacticsWorker[] = [];
  static failNext = false;
  onmessage: ((ev: MessageEvent<TacticsWorkerRes>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  posted: TacticsWorkerReq[] = [];

  constructor(_url: URL, _opts?: WorkerOptions) {
    FakeTacticsWorker.instances.push(this);
  }

  postMessage(req: TacticsWorkerReq): void {
    this.posted.push(req);
    queueMicrotask(() => {
      if (this.terminated) return;
      if (FakeTacticsWorker.failNext) {
        FakeTacticsWorker.failNext = false;
        this.onerror?.();
        return;
      }
      if (req.kind === 'tactics') {
        const legal = gomoku.getLegalMoves(req.st);
        const data = computeTactics(gomoku, req.st, legal, req.cands, req.versionId);
        this.onmessage?.({ data: { id: req.id, ok: true, data } } as MessageEvent<TacticsWorkerRes>);
      } else {
        const data = computeTacticHints(gomoku, req.st, req.versionId);
        this.onmessage?.({ data: { id: req.id, ok: true, data } } as MessageEvent<TacticsWorkerRes>);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  resetTacticsWorkerForTest();
  FakeTacticsWorker.instances = [];
  FakeTacticsWorker.failNext = false;
  vi.unstubAllGlobals();
});

describe('tactics-client：Web Worker 通道与回退', () => {
  it('支持 Worker 时在后台线程完成 runTacticsAsync 与 runTacticHintsAsync', async () => {
    vi.stubGlobal('Worker', FakeTacticsWorker as unknown as typeof Worker);
    const st = midgameState();
    const legal = gomoku.getLegalMoves(st);
    const report = await runTacticsAsync(gomoku, st, legal, null, 'v14-live3-fresh');
    const hint = await runTacticHintsAsync(gomoku, st, 'v14-live3-fresh');

    expect(FakeTacticsWorker.instances.length).toBe(1);
    expect(FakeTacticsWorker.instances[0]!.posted.map((p) => p.kind)).toEqual(['tactics', 'hints']);
    expect(report.winning_points_you).toContain('L12');
    expect(hint.marks.some((m) => m.layer === 'win' && m.notation === 'L12')).toBe(true);
  });

  it('Worker 运行出错时透明回退主线程，不影响结果', async () => {
    vi.stubGlobal('Worker', FakeTacticsWorker as unknown as typeof Worker);
    FakeTacticsWorker.failNext = true;
    const st = midgameState();
    const legal = gomoku.getLegalMoves(st);

    const report = await runTacticsAsync(gomoku, st, legal, null, 'v14-live3-fresh');
    expect(report.winning_points_you).toContain('L12');
    expect(FakeTacticsWorker.instances[0]!.terminated).toBe(true);
  });

  it('无 Worker 环境直接主线程计算，不抛异常', async () => {
    vi.stubGlobal('Worker', undefined);
    const st = midgameState();
    const hint = await runTacticHintsAsync(gomoku, st, 'v14-live3-fresh');
    expect(hint.marks.some((m) => m.layer === 'win')).toBe(true);
  });
});
