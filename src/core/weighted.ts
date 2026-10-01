/* weighted.ts — 按权重随机抽取（迁移自 js/board.js 的 BG.util.weightedPick）
 *
 * 刻意**不**经过 rng.ts 的 rand/rnd：真实 Jev 渠道的 top-k 采样保持真随机，
 * 不受 BG.setSeed 影响（见 docs/jev-api.md §6）。移植时这一点最容易「顺手改对」，
 * 改了就会让 setSeed 后的真实渠道行为与旧实现分叉。
 *
 * 逐字保留的细节：
 *   - 权重下限 1e-9（0 权项仍可能被抽到，只要它在 total 内）；
 *   - 循环减到 <= 0 立即返回；
 *   - 全部没命中时兜底返回最后一项（浮点残差）。
 */

/** 按权重随机挑一个（items 与 weights 等长）。 */
export function weightedPick<T>(items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((s, w) => s + Math.max(w, 1e-9), 0);
  let t = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    t -= Math.max(weights[i] as number, 1e-9);
    if (t <= 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}
