/* clone.ts — JSON 深拷贝（迁移自 js/board.js 的 BG.util.clone）
 *
 * 不变量（ADR-0004）：引擎 state 一律 JSON 可克隆。所以这里刻意不用
 * structuredClone——旧实现走 JSON 往返，任何「JSON 表达不出来」的值
 * （函数、undefined、Date）在旧实现里本来就会丢失或被改写，
 * 换成 structuredClone 会悄悄改变行为。逐字移植优先。
 */

/** JSON 往返深拷贝；入参必须是 JSON 可表达的纯数据。 */
export function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}
