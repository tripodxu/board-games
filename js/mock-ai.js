'use strict';
/* mock-ai.js — 离线演示 AI：无 API key 时也能完整体验三种模式。
 * 优先使用引擎提供的 mockPick 启发式（能赢就赢、能挡就挡），否则加权随机。
 * 概率分布为合成数据，仅用于演示决策面板。 */
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /* Node 集成测试用 BG_FAST=1 跳过模拟延迟 */
  const FAST = typeof process !== 'undefined' && process.env && process.env.BG_FAST;

  BG.mock = {
    async decide(engine, st, side, legal, ser) {
      const t0 = Date.now();
      if (!FAST) await sleep(320 + BG.util.rand(480)); // 模拟网络与决策延迟
      const latencyMs = Date.now() - t0;

      let pick = null;
      if (engine.mockPick) pick = engine.mockPick(st, legal, side);
      if (!pick) pick = legal[BG.util.rand(legal.length)];

      /* 合成概率：chosen 0.45~0.85，其余平分 */
      const chosenP = 0.45 + BG.util.rnd() * 0.4;
      const rest = Math.max(legal.length - 1, 1);
      const probs = {};
      legal.forEach((m) => { probs[m.notation] = 0; });
      probs[pick.notation] = chosenP;
      const perRest = (1 - chosenP) / rest;
      legal.forEach((m) => { if (m.notation !== pick.notation) probs[m.notation] = perRest; });

      const top = legal
        .slice()
        .sort((a, b) => probs[b.notation] - probs[a.notation])
        .slice(0, 3)
        .map((m) => ({ notation: m.notation, p: probs[m.notation] }));

      return {
        notation: pick.notation,
        move: pick,
        meta: {
          channel: 'mock', latencyMs,
          usage: { input_tokens: JSON.stringify(ser.state).length, output_tokens: 0 },
          costUsd: 0,
          confidence: Math.min(0.97, chosenP + 0.05),
          top,
          noul: +(0.3 + BG.util.rnd() * 0.5).toFixed(2),
          score: +(BG.util.rnd() * 10).toFixed(1),
          mock: true,
        },
      };
    },
  };
})();
