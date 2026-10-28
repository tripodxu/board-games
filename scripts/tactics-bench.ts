/* tactics-bench.ts — 战术层耗时基准（零依赖，Node 直跑）
 *
 *   npm run bench:tactics
 *   （等价：node --experimental-strip-types scripts/tactics-bench.ts）
 *
 * 为什么有这个文件：`computeTactics` 是「每手一次」的主线程同步热点（见 docs/performance.md）。
 * 改战术层 / 引擎数据结构前后各跑一次，用数字判断「快了多少」，而不是凭手感。
 *
 * 口径（重要）：用「随机对局 N 手」构造中局盘面。随机盘面比真实对局更乱（威胁点更多），
 * 所以这里的数字**偏悲观**，用来看量级与尾部；真实体验的参照是引擎里那份真语料标定
 * （src/core/engines/gomoku.ts 头部注释：VCT 平均 444ms / p90 1647ms / 最坏 4586ms）。
 */
import { gomoku, gomokuPro } from '../src/core/registry.ts';
import { computeTactics } from '../src/core/tactics.ts';

const rnd = (n: number): number => Math.floor(Math.random() * n);

/** 随机走 ply 手造一个中局盘面（不走终局判定：要的就是「没结束的乱局」）。 */
function randomPosition(engine: any, ply: number): unknown {
  let st = engine.newGame();
  for (let i = 0; i < ply; i++) {
    const legal = engine.getLegalMoves(st);
    if (!legal || !legal.length) break;
    st = engine.applyMove(st, legal[rnd(legal.length)]);
  }
  return st;
}

function sample(label: string, engine: any, ply: number, runs: number): void {
  const costs: number[] = [];
  let serCost = 0;
  let legalCount = 0;

  for (let k = 0; k < runs; k++) {
    const st: any = randomPosition(engine, ply);
    const legal = engine.getLegalMoves(st);
    legalCount += (legal && legal.length) || 0;

    let t0 = performance.now();
    const ser = engine.serializeForJev(st, {} as any);
    serCost += performance.now() - t0;

    t0 = performance.now();
    computeTactics(engine, st, legal, (ser?.candidates ?? legal.slice(0, 64)) as any, 'v15');
    costs.push(performance.now() - t0);
  }

  costs.sort((a, b) => a - b);
  const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
  console.log(
    label.padEnd(24),
    '中位', costs[Math.floor(costs.length / 2)].toFixed(0).padStart(6), 'ms ｜ 平均',
    avg.toFixed(0).padStart(7), 'ms ｜ 最坏', costs[costs.length - 1].toFixed(0).padStart(7),
    'ms ｜ serializeForJev 均值', (serCost / runs).toFixed(1), 'ms',
    '｜ 平均合法手', Math.round(legalCount / runs),
  );
}

const PLY = Number(process.env.BENCH_PLY || 40);
const RUNS = Number(process.env.BENCH_RUNS || 9);
console.log(`随机中局 ${PLY} 手 × ${RUNS} 个样本（BENCH_PLY / BENCH_RUNS 可改）`);
sample('gomoku 大众模式', gomoku as any, PLY, RUNS);
sample('gomoku-pro 禁手', gomokuPro as any, PLY, RUNS);
