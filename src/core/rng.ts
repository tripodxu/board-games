/* rng.ts — 可种子随机（迁移自 js/board.js 的 BG.rng / BG._rng / BG._seed / setSeed）
 *
 * mulberry32，与 jev-piano/test/rng-shim.mjs 同实现，也必须是同一实现：
 * 金样 test/fixtures/golden/*.json 由 seed=42 的 mock 自对弈生成，
 * 随机流一字节不同就会让 1131 手自对弈全部对不上。
 *
 * 语义要点（逐字保留）：
 *   - 未设种子时 rand/rnd 走 Math.random（真实 Jev 渠道本就真随机）；
 *   - weightedPick 不经过这里（见 weighted.ts），不受 seed 影响；
 *   - seed 只应由 setSeed 写；并行对局不要共享全局 RNG。
 */

/** mulberry32：返回 [0,1) 的确定性随机函数。 */
export function rng(seed: number): () => number {
  let a = (seed ^ 0x9e3779b9) >>> 0; // 异或混淆：避免相邻 seed 产生相邻随机流
  return function (): number {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 当前种子流；null = 未设种子（走 Math.random）。 */
let currentRng: (() => number) | null = null;
/** 当前种子；棋谱导出用它标注可复现性。 */
let currentSeed: number | null = null;

/** 设种子（复现演示 / 自检）。设为 null 表示回到真随机。 */
export function setSeed(seed: number | null): void {
  currentRng = seed === null ? null : rng(seed);
  currentSeed = seed;
}

/** 当前种子值；null = 未设种子。 */
export function getSeed(): number | null {
  return currentSeed;
}

/** 内部用：取当前随机函数（种子流或 Math.random）。 */
function pick(): () => number {
  return currentRng || Math.random;
}

/** [0, n) 的整数。未设种子时走 Math.random。 */
export function rand(n: number): number {
  return Math.floor(pick()() * n);
}

/** [0, 1) 的浮点数。未设种子时走 Math.random。 */
export function rnd(): number {
  return pick()();
}

/** 洗牌：返回新数组（不改入参），Fisher-Yates 用 rand。 */
export function shuffle<T>(a: readonly T[]): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
