/**
 * test/scripts/tactics-mechanics.spec.mjs — scripts/lib/tactics-mechanics.mjs 纯函数单测
 * （vitest 第 4 project「scripts」，见 vitest.config.ts；跑法 npm run test:scripts）
 *
 * 这个库是 S0 三件套里的 ①（机制层离线读数）与 ②（功效预检门），它的读数会被用来**决定
 * 一个战术档要不要开 120 局批次**——所以最容易写错的几处必须钉死：
 *   ① rank / 接管拆分口径（我方手 = 过战术层渠道 + 有模型记账；接管手 = tactics/ai.tac 非空）；
 *   ② 集中度与重复性三个数（Σp²、期望全一致、实测众数占比）；
 *   ③ **局面重建的保真**：语料的 black_stones/white_stones 列表不保证是时间序，
 *      只能靠覆写 st.last 复现「最后一手」，重排落子序列会把整盘**串色**（踩过一次）；
 *   ④ 档位 quietShape 必须逐档透传（v15 抹 you:four/you:live3）：漏传就会把 v15 读出成 v14；
 *   ⑤ 判决四分支：<2% 行为等价 / 2–5% 无功效 / >5% 可判 / **决策零改变 = 模型输入面**（判不了也不必开批次）。
 *
 * 真实语料只用**切片**（全量 500 行要 ~100s，不适合放进测试）；全量读数见
 * docs/plans/2026-10-16-v14-v15-stall-next-steps.md §三 与 scripts/tactics-mechanics.mjs。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  PRAISE_WORDS,
  gomokuEngine,
  bucketRank,
  concentration,
  expectedUnanimous,
  rankCensus,
  repeatStats,
  rebuildState,
  versionDecision,
  criteriaDiff,
  diffVersions,
  verdictFor,
} from '../../scripts/lib/tactics-mechanics.mjs';

const gomoku = gomokuEngine();
const CORPUS = 'docs/experiments/official-baseline-large-500x6.jsonl';
const corpus = fs.readFileSync(CORPUS, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const praiseOf = (v) => (typeof v === 'string' ? v.split('+').filter((p) => PRAISE_WORDS.includes(p)) : []);

/** 把一个着法序列折成官方语料那样的 `state`：黑白子列表**故意倒序**（模拟「不是时间序」），
 *  只留 last_move 作为权威的最后一手。`you_play` 由手数奇偶决定（黑先）。 */
function corpusState(seq) {
  const blacks = seq.filter((_, i) => i % 2 === 0);
  const whites = seq.filter((_, i) => i % 2 === 1);
  const blackUp = blacks.map((s) => s.toUpperCase());
  const whiteUp = whites.map((s) => s.toUpperCase());
  const last = seq[seq.length - 1];
  return {
    game: 'gomoku',
    you_play: seq.length % 2 === 0 ? 'black' : 'white',
    move_number: seq.length + 1,
    black_stones: blackUp.slice().reverse(),
    white_stones: whiteUp.slice().reverse(),
    last_move: `${seq.length % 2 === 1 ? 'black' : 'white'} ${last.toUpperCase()}`,
  };
}

/** 用引擎自己走一遍，得到「正版」棋盘（用来和重建结果逐字比）。 */
function canonicalBoard(seq) {
  let st = gomoku.newGame();
  for (const n of seq) {
    const mv = gomoku.moveFromNotation(st, n);
    if (!mv) throw new Error(`夹具序列非法：${n}`);
    st = gomoku.applyMove(st, mv);
  }
  const side = st.turn;
  return { st, ascii: gomoku.serializeForJev(st, side, undefined).state.board_ascii };
}

describe('① rank / 接管拆分口径', () => {
  const rec = {
    game: 'gomoku', channel: 'jevrouter', tacticsVersion: 'v14-plus',
    moves: [
      { ply: 1, side: '黑方', notation: 'H8', ai: { p: 0.4, rank: 1, tac: 'block' } },
      { ply: 2, side: '白方', notation: 'I9', ai: { p: 0.2, rank: 2 } },
      { ply: 3, side: '黑方', notation: 'I8', tactics: 'win', ai: { p: 0.3, rank: 3 } },
      { ply: 4, side: '白方', notation: 'J9', ai: { p: 0.1, rank: 4 } },
      { ply: 5, side: '黑方', notation: 'G8' },
      { ply: 6, side: '白方', notation: 'K9', ai: { p: 0.5, rank: 1, channel: 'rapfi' } },
    ],
  };
  const c = rankCensus([rec]);
  it('只数「过战术层渠道 + 有模型记账」的我方手', () => {
    expect(c.plies).toBe(6);
    expect(c.ours).toBe(4);
    expect(c.skippedNoAi).toBe(1);       // 第 5 手没有 ai
    expect(c.skippedChannel).toBe(1);    // 第 6 手逐手渠道是 rapfi
    expect(c.unknownChannel).toBe(0);    // 局级 channel 写了 jevrouter
  });
  it('接管手认 move.tactics 与 ai.tac 两种写法', () => {
    expect(c.takeover).toBe(2);
    expect(c.free).toBe(2);
    expect(c.takeoverShare).toBeCloseTo(0.5, 10);
    expect(c.freeShare).toBeCloseTo(0.5, 10);
    expect(c.layers).toEqual({ block: 1, win: 1 });
  });
  it('rank 分桶与平均 p', () => {
    expect(c.freeRanks).toEqual({ 2: 1, '4+': 1 });
    expect(c.takeoverRanks).toEqual({ 1: 1, 3: 1 });
    expect(c.pMeanFree).toBeCloseTo(0.15, 10);
    expect(c.pMeanTac).toBeCloseTo(0.35, 10);
    expect(c.channels).toEqual({ jevrouter: 4 });
    expect(c.freeBySide).toEqual({ white: 2 });   // 只记出现过的行棋方（黑方两手都是接管手）
  });
  it('bucketRank 的边界：1/2/3 单列、4 以上归 4+、缺失归 null', () => {
    expect([bucketRank(1), bucketRank(2), bucketRank(3), bucketRank(4), bucketRank(99), bucketRank(null), bucketRank(undefined)])
      .toEqual(['1', '2', '3', '4+', '4+', 'null', 'null']);
  });
});

describe('② 集中度与重复性', () => {
  it('各半分布：Σp² 0.5、有效选择数 2、熵 1 bit', () => {
    const c = concentration({ A: 0.5, B: 0.5 });
    expect(c.sumP2).toBeCloseTo(0.5, 10);
    expect(c.effectiveN).toBeCloseTo(2, 10);
    expect(c.entropyBits).toBeCloseTo(1, 10);
    expect(c.n).toBe(2);
  });
  it('期望全一致 = Σp_i^k（各半分布取 3 次 ⇒ 0.25）', () => {
    expect(expectedUnanimous({ A: 0.5, B: 0.5 }, 3)).toBeCloseTo(0.25, 10);
    expect(expectedUnanimous({ A: 1 }, 6)).toBeCloseTo(1, 10);
  });
  it('repeatStats 汇总：实测全一致 / 众数占比 / 候选点个数（含 0 概率键）', () => {
    const rows = [
      { id: 'x', calls: [{ choice: 'A', probs: { A: 0.5, B: 0.5 } }, { choice: 'A', probs: { A: 0.5, B: 0.5 } }], mean: { A: 0.5, B: 0.5 } },
      { id: 'y', calls: [{ choice: 'A', probs: { A: 1, B: 0 } }, { choice: 'B', probs: { A: 0, B: 1 } }], mean: { A: 0.5, B: 0.5 } },
    ];
    const { summary } = repeatStats(rows, { resample: false });
    expect(summary.positions).toBe(2);
    expect(summary.meanCands).toBeCloseTo(2, 10);       // 0 概率的 B 也算候选点
    expect(summary.observedUnanimous).toBeCloseTo(0.5, 10);
    expect(summary.modeShareMean).toBeCloseTo(0.75, 10); // 1.0 与 0.5
    expect(summary.effectiveNAggregate).toBeCloseTo(2, 10);
    expect(summary.determinismGap).toBeCloseTo(0.5 / 0.5, 10);
  });
});

describe('③ 局面重建保真（语料子列表不是时间序）', () => {
  const seq = ['H8', 'I9', 'I8', 'J9', 'G8'];
  it('倒序的黑白子列表也能重出逐字相同的棋盘与最后一手', () => {
    const canon = canonicalBoard(seq);
    const st = rebuildState(gomoku, corpusState(seq));
    const ascii = gomoku.serializeForJev(st, st.turn, undefined).state.board_ascii;
    expect(ascii).toBe(canon.ascii);
    expect(st.last).toEqual({ notation: 'G8', r: 7, c: 6, side: 'black' });
  });
  it('重排落子序列会串色 —— 所以实现里**只覆写 st.last**，落子顺序保持交替', () => {
    /* 反例守卫：如果哪天有人为了「把 last_move 排到末尾」去重排序列，颜色就会错位，
       这里用「棋盘必须与正版逐字相同」把这条钉住。 */
    const canon = canonicalBoard(seq);
    const st = rebuildState(gomoku, corpusState(seq));
    const mine = gomoku.serializeForJev(st, st.turn, undefined).state.board_ascii;
    const colorized = (s) => s.replace(/[Xx]/g, 'B').replace(/[Oo]/g, 'W');
    expect(colorized(mine)).toBe(colorized(canon.ascii));
  });
  it('轮次对不上 / last_move 与棋子颜色对不上 ⇒ 必须 throw（不静默兜底）', () => {
    const bad = corpusState(seq);
    bad.you_play = 'black';                       // 5 手（黑 3 白 2）之后该白走
    expect(() => rebuildState(gomoku, bad)).toThrow(/轮次/);
    const bad2 = corpusState(seq);
    bad2.last_move = `white ${seq[seq.length - 1]}`;  // G8 是黑子
    expect(() => rebuildState(gomoku, bad2)).toThrow(/不是该色棋子/);
    const bad3 = corpusState(seq);
    bad3.last_move = 'black Z9';                  // Z 越界 ⇒ 该点没有棋子
    expect(() => rebuildState(gomoku, bad3)).toThrow(/不是该色棋子/);
    const bad4 = corpusState(seq);
    bad4.last_move = 'last move';                 // 形状不对 ⇒ 解析不出来
    expect(() => rebuildState(gomoku, bad4)).toThrow(/解析不出/);
  });
});

describe('④ 档位 quietShape 透传（v15 抹 praise 词）', () => {
  /* 黑 H8/I8/J8 三连、白 L8 堵一头、白 A1/B1 远子；轮到黑走 ⇒ K8 恰好是「单头冲四」
     （G8 开、L8 是白子）⇒ 原始标签含 you:four，v15 必须把它抹掉。 */
  const seq = ['H8', 'L8', 'I8', 'A1', 'J8', 'B1'];
  const st = rebuildState(gomoku, corpusState(seq));
  const a = versionDecision(gomoku, st, 'black', 'v14-plus');
  const b = versionDecision(gomoku, st, 'black', 'v15');
  it('v14-plus 保留 you:four，v15 抹掉它', () => {
    expect(praiseOf(a.crit.K8)).toEqual(['you:four']);
    expect(praiseOf(b.crit.K8)).toEqual([]);
    expect(criteriaDiff(a.crit, b.crit).length).toBeGreaterThan(0);
  });
  it('两档的候选点集与 instructions 逐字相同（v15 只动 criteria 文本）', () => {
    expect(Object.keys(a.crit)).toEqual(Object.keys(b.crit));
    expect(b.instructions).toBe(a.instructions);
  });
});

describe('⑤ 功效预检门：真实语料切片', () => {
  it('保真自检：v14 行重算出的 board_ascii 与 criteria 逐字等于语料', () => {
    const rows = corpus.filter((r) => r.label === 'v14').slice(0, 3);
    expect(rows.length).toBe(3);
    const d = diffVersions(rows, { a: 'v14', b: 'v14' });
    expect(d.compared).toBe(3);
    expect(d.fidelity.boardOk).toBe(3);
    expect(d.fidelity.criteriaOk).toBe(3);
    expect(d.mismatches).toEqual([]);
    expect(d.totalChanged).toBe(0);
    expect(d.verdict.key).toBe('equivalent');
  });
  it('v15 行的 criteria 是**没过 quietShape** 的原始标签 ⇒ 归「语料口径差」而不是重建错', () => {
    const rows = corpus.filter((r) => r.label === 'v15' && Object.values(r.criteria || {}).some((v) => praiseOf(v).length)).slice(0, 3);
    expect(rows.length).toBe(3);
    const d = diffVersions(rows, { a: 'v14-plus', b: 'v15' });
    expect(d.fidelity.quietShapeArtefacts).toBe(3);
    expect(d.mismatches).toEqual([]);
  });
  it('v14-plus vs v15：决策零改变、只有提示面变 ⇒ 判「模型输入面」（不该开 120 局批次）', () => {
    const rows = corpus.filter((r) => r.label === 'v15' && Object.values(r.criteria || {}).some((v) => praiseOf(v).length)).slice(0, 3);
    const d = diffVersions(rows, { a: 'v14-plus', b: 'v15' });
    expect(d.decisionChanged).toBe(0);
    expect(d.criteriaOnlyChanged).toBe(3);
    expect(d.kindCounts.takeoverToTakeover + d.kindCounts.freeToFree).toBe(3);
    expect(d.verdict.key).toBe('model-side');
  });
});

describe('⑥ 判决四分支', () => {
  it('<2% ⇒ 行为等价（结案，不开批次）', () => {
    expect(verdictFor(0.01, 0.0, 0.01).key).toBe('equivalent');
  });
  it('2–5% ⇒ 120 局无功效', () => {
    expect(verdictFor(0.03, 0.01, 0.02).key).toBe('underpowered');
  });
  it('>5% 且有决策分歧 ⇒ 120 局可判', () => {
    expect(verdictFor(0.17, 0.05, 0.12).key).toBe('judgeable');
  });
  it('决策零改变但提示面变了 ⇒ 模型输入面（离线门判不了，也不必开批次）', () => {
    const v = verdictFor(0.174, 0, 0.174, { changed: 87, positions: 500 });
    expect(v.key).toBe('model-side');
    expect(v.text).toContain('87');
  });
});
