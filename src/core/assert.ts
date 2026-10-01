/* assert.ts — 自检断言（迁移自 js/board.js 的 BG.util.assert）
 *
 * 语义逐字保留：失败时抛 `Error('assert failed: ' + msg)`。
 * 旧实现里所有 selfTest() 都依赖这条前缀做失败定位，不能改。
 */

/** 断言条件成立，否则抛出带统一前缀的错误。 */
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('assert failed: ' + msg);
}
