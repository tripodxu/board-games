/* jev/index.ts — Jev 渠道装配（旧实现里 `BG.jev` 的等价出口）
 *
 * 为什么需要这一层：client.ts 刻意不认识 mock 实现（避免模块循环），
 * 这里把 mock 注入进去，对外只暴露一个 `decide`——调用方不再需要知道谁是谁。
 */
import { decide as decideClient, setMock, probe, presetEndpoint, CHANNELS } from './client.ts';
import { decide as decideMock } from './mock.ts';
import { decide as decideRapfi } from './rapfi.ts';
import type { DecideOpts, DecideResult } from '../tactics.ts';
import type { Engine } from '../types.ts';

setMock(decideMock as never);

/** 走一步棋（含 mock / rapfi 渠道）。
 *
 * rapfi 与 mock 的注入方式不同：client.ts 把 rapfi 设计成**每次调用**注入（`opts.rapfi`，
 * 见 client.ts:43 的说明），漏注入时该渠道会以「rapfi 渠道未注入（opts.rapfi）」直接失败。
 * 这里补齐——调用方（`src/app/loop.ts`）不必知道 rapfi 的存在；显式传入的 `opts.rapfi`
 * 仍然优先，测试可以替换。 */
export function decide(engine: Engine, st: unknown, side: string, opts: DecideOpts): Promise<DecideResult> {
  const withRapfi: DecideOpts = opts && opts.rapfi ? opts : { ...opts, rapfi: decideRapfi };
  return decideClient(engine, st, side, withRapfi);
}

export { decideMock, probe, presetEndpoint, CHANNELS };
export type { DecideOpts, DecideResult };
