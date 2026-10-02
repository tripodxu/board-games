/* mock.ts — 离线演示渠道（迁移自 js/mock-ai.js）
 *
 * mock 是「不联网也要能下完一盘」的兜底渠道，但它同时是**金样与自检的基准走子器**：
 * test/fixtures/golden/*.json 的 1131 手自对弈全部由它生成。因此这里的每一行都同时是
 * 「用户体验」与「可复现契约」，改它等于改金样。
 *
 * 随机流契约（金样按记法回放，比对不依赖随机流；但**重新生成**金样时依赖它）：
 *   非 FAST 时先 rnd() 一次算模拟延迟 → engine.mockPick（gomoku 内部每候选再 rnd() 一次）
 *   → 若 mockPick 没给答案则 rand(len) 取一个 → rnd() 算 chosenP
 *   → rnd() 两次算 noul / score。
 *   顺序与次数都不能动，否则同种子跑出的棋谱会变。
 */
import { rand, rnd } from '../rng.ts';
import type { Engine, JevSerialized, Move, PickConfig } from '../types.ts';

/** 决策元信息（与旧实现 meta 字段一一对应）。 */
export interface MockMeta {
  channel: string;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number };
  costUsd: number;
  confidence: number;
  top: { notation: string; p: number }[];
  noul: number;
  score: number;
  mock: true;
  [k: string]: unknown;
}

export interface DecideResult {
  notation: string;
  move: Move;
  meta: MockMeta;
}

/** BG_FAST=1 时跳过模拟延迟（自检与金样生成都用它）。 */
const FAST: boolean = typeof process !== 'undefined' && !!process.env && !!process.env.BG_FAST;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* 模拟思考延迟：0.32–0.8s，看着像在算。
 * 注意 rand(480) 只在非 FAST 时消耗随机数——FAST 下随机流少一步，
 * 这正是「自检/金样」与「线上演示」走子不同的原因，两边都不许改。 */
async function thinkDelay(): Promise<void> {
  if (!FAST) await sleep(320 + rand(480));
}

/** 一步 mock 决策。engine/state/side/legal/ser 与旧实现同序同义。 */
export async function decide(engine: Engine, st: unknown, side: string, legal: Move[], ser: JevSerialized): Promise<DecideResult> {
  await thinkDelay();
  let move: Move | null | undefined = null;
  if (typeof engine.mockPick === 'function') move = engine.mockPick(st, legal, side, {} as PickConfig);
  if (!move) move = legal[rand(legal.length)] as Move;
  const chosenP = 0.45 + rnd() * 0.4;
  const rest = Math.max(legal.length - 1, 1);
  const perRest = (1 - chosenP) / rest;
  const top = legal
    .filter((m) => m.notation !== move!.notation)
    .slice(0, 2)
    .map((m) => ({ notation: m.notation, p: perRest }));
  top.unshift({ notation: move.notation!, p: chosenP });
  top.sort((a, b) => b.p - a.p);
  return {
    notation: move.notation,
    move,
    meta: {
      channel: 'mock',
      latencyMs: 0,
      tacticsMs: null, /* mock 直接返回、不过战术层（client.ts 的渠道短路）⇒ 记 null 而不是 0 */
      usage: { input_tokens: JSON.stringify(ser.state).length, output_tokens: 0 },
      costUsd: 0,
      confidence: Math.min(0.97, chosenP + 0.05),
      top,
      noul: +(0.3 + rnd() * 0.5).toFixed(2),
      score: +(rnd() * 10).toFixed(1),
      mock: true,
    },
  };
}
