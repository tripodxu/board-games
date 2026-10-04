/**
 * test/scripts/tactics-replay.spec.mjs — scripts/lib/tactics-replay.mjs 纯函数单测
 * （vitest 第 4 project「scripts」，见 vitest.config.ts；跑法 npm run test:scripts）
 *
 * 用合成棋谱钉住三件容易写错的事：
 *   ① 记谱方/渠道/档号的解析优先级（老归档写中文「黑方」、局级 channel、逐手 ai.tv）；
 *   ② 重放的三个判据口径（层一致率 / 接管落点一致率 / 会变的手）与 `versionInferred` 记账；
 *   ③ 非法输入必须 throw（未知档号、未知棋种、没有 moves），不静默回落。
 */
import { describe, it, expect } from 'vitest';
import {
  TACTICS_IDS,
  runsTacticsChannel,
  sideIdOf,
  recordedLayerOf,
  recordedVersionOf,
  channelOfPly,
  parseRecord,
  replayGame,
  summarize,
  mergeSummaries,
} from '../../scripts/lib/tactics-replay.mjs';
import { getGame } from '../../src/core/registry.ts';
import { CURRENT } from '../../src/core/tactics-versions.ts';

const gomoku = getGame('gomoku');

/** ⑧ 那局的致胜夹具（test/engines/tactics.test.mjs 同名序列）：第 9 手黑方 G8/L8 成五。 */
const WIN_SEQ = ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5'];

/** 把着法序列折成归档形状（老归档写中文「黑方/白方」；`layers` 按 ply 给层标记）。 */
function mkRecord(opts) {
  const o = opts || {};
  const seq = o.seq || WIN_SEQ;
  const moves = seq.map((notation, i) => {
    const m = { ply: i + 1, side: i % 2 === 0 ? '黑方' : '白方', notation };
    if (o.perMoveV && o.perMoveV[i]) m.ai = { tv: o.perMoveV[i] };
    return m;
  });
  if (o.extraMove) moves.push(o.extraMove);
  if (o.layers) for (const [ply, layer] of Object.entries(o.layers)) {
    const m = moves.find((x) => x.ply === Number(ply));
    if (m && layer) m.tactics = layer;
  }
  const raw = Object.assign({
    format: 1, game: '五子棋', gid: 'test-uid', moves,
  }, o.raw || {});
  return raw;
}

describe('runsTacticsChannel', () => {
  it('mock / rapfi / 空渠道不过战术层', () => {
    expect(runsTacticsChannel('mock')).toBe(false);
    expect(runsTacticsChannel('rapfi')).toBe(false);
    expect(runsTacticsChannel('')).toBe(false);
    expect(runsTacticsChannel(null)).toBe(false);
  });

  it('模型渠道与 random 都要过（random 刻意走战术层）', () => {
    for (const ch of ['proxy', 'official', 'openrouter', 'random']) expect(runsTacticsChannel(ch)).toBe(true);
  });
});

describe('记谱解析', () => {
  it('sideIdOf 认中文、英文与引擎自带 id/name', () => {
    expect(sideIdOf(gomoku, '黑方')).toBe('black');
    expect(sideIdOf(gomoku, '白方')).toBe('white');
    expect(sideIdOf(gomoku, 'black')).toBe('black');
    expect(sideIdOf(gomoku, '白')).toBe(null);
  });

  it('层标记先看 move.tactics 再看 move.ai.tac', () => {
    expect(recordedLayerOf({ tactics: 'win' })).toBe('win');
    expect(recordedLayerOf({ ai: { tac: 'block' } })).toBe('block');
    expect(recordedLayerOf({ tactics: 'win', ai: { tac: 'block' } })).toBe('win');
    expect(recordedLayerOf({})).toBe(null);
    expect(recordedLayerOf(null)).toBe(null);
  });

  it('档号：逐手 ai.tv > 局级 tacticsVersion > null', () => {
    expect(recordedVersionOf({ ai: { tv: 'v10-live3' } }, { tacticsVersion: 'v9-vcf-sound' })).toBe('v10-live3');
    expect(recordedVersionOf({}, { tacticsVersion: 'v9-vcf-sound' })).toBe('v9-vcf-sound');
    expect(recordedVersionOf({}, {})).toBe(null);
  });

  it('渠道：逐手 > 本侧局级 > 局级 channel', () => {
    const rec = { channel: 'mock', blackChannel: 'proxy', whiteChannel: 'official' };
    expect(channelOfPly(rec, { channel: 'rapfi' }, 'black')).toBe('rapfi');
    expect(channelOfPly(rec, {}, 'black')).toBe('proxy');
    expect(channelOfPly(rec, {}, 'white')).toBe('official');
    expect(channelOfPly({ channel: 'mock' }, {}, 'black')).toBe('mock');
  });
});

describe('parseRecord', () => {
  it('老归档的棋种写中文名也能解析', () => {
    const rec = parseRecord(mkRecord(), { file: 'x.json' });
    expect(rec.engine.id).toBe('gomoku');
    expect(rec.uid).toBe('test-uid');
    expect(rec.moves.length).toBe(8);
  });

  it('没有 moves 数组 → throw', () => {
    expect(() => parseRecord({ game: 'gomoku' }, { file: 'x.json' })).toThrow(/没有 moves/);
  });

  it('不认识的棋种 → throw（不静默兜底）', () => {
    expect(() => parseRecord({ game: '飞行棋', moves: [{ ply: 1, notation: 'A1' }] }, { file: 'x.json' }))
      .toThrow(/不认识的棋种/);
  });

  // L2 的 300 局全栽在这条上：实验面归档的 slug 是「对阵描述」不是棋种，
  // 而解析顺序原来把 slug 排在 game 前面 ⇒ 整批被判「不认识的棋种」跳过。
  it('slug 是对阵描述（实验面归档）⇒ 回退到 game 显示名', () => {
    const rec = parseRecord({
      slug: 'jev-v14-vs-rapfi-0-5s', game: '五子棋', gameUid: 'u1',
      moves: [{ ply: 1, side: '黑方', notation: 'H8' }],
    }, { file: 'round-13-game-1.json' });
    expect(rec.engine.id).toBe('gomoku');
  });

  it('slug 不认识且 game 写的是引擎 id ⇒ 也认；显式 gameId 仍然最优先', () => {
    const raw = { slug: 'jev-v14-vs-rapfi-0-5s', game: 'gomoku', moves: [{ ply: 1, notation: 'H8' }] };
    expect(parseRecord(raw, { file: 'x.json' }).engine.id).toBe('gomoku');
    expect(parseRecord({ ...raw, game: '飞行棋' }, { file: 'x.json', gameId: 'gomoku' }).engine.id).toBe('gomoku');
  });

  it('候选里的棋种字段全都认不出 ⇒ 仍然 throw（一个坏 slug 不该判死，但也不能瞎兜底）', () => {
    expect(() => parseRecord({ slug: 'jev-v14-vs-rapfi-0-5s', game: '飞行棋', moves: [{ ply: 1, notation: 'A1' }] },
      { file: 'x.json' })).toThrow(/引擎 id 或显示名/);
  });

  it('一个棋种字段都没写 ⇒ 才用默认 gomoku', () => {
    const rec = parseRecord({ moves: [{ ply: 1, notation: 'H8' }] }, { file: 'x.json' });
    expect(rec.engine.id).toBe('gomoku');
  });
});

describe('replayGame：致胜点接管', () => {
  it('第 9 手致胜点被 win 层接管，落点是两个成五点之一', () => {
    const raw = mkRecord({ extraMove: { ply: 9, side: '黑方', notation: 'G8' } });
    const rec = parseRecord(raw, { file: 'x.json' });
    const { rows, summary } = replayGame(rec, { tactics: 'v14-live3-fresh' });
    expect(rows.length).toBe(9);
    expect(summary.replayed).toBe(9);
    const last = rows[8];
    expect(last.layer).toBe('win');
    expect(['G8', 'L8']).toContain(last.notation);
    expect(last.v).toBe('v14-live3-fresh');
    expect(last.vSource).toBe('forced');
    expect(summary.versionInferred).toBe(0);
  });

  it('未指定档号且归档没记档号 → 用 CURRENT 并计入 versionInferred', () => {
    const raw = mkRecord({ extraMove: { ply: 9, side: '黑方', notation: 'G8' } });
    const rec = parseRecord(raw, { file: 'x.json' });
    const { rows, summary } = replayGame(rec, {});
    expect(rows.every((r) => r.v === CURRENT)).toBe(true);
    expect(summary.versionInferred).toBe(9);
  });

  it('局级 tacticsVersion 优先于 CURRENT，来源记 game', () => {
    const raw = mkRecord({ raw: { tacticsVersion: 'v0-off' } });
    const { rows, summary } = replayGame(parseRecord(raw, { file: 'x.json' }), {});
    expect(rows.every((r) => r.vSource === 'game' && r.v === 'v0-off')).toBe(true);
    expect(summary.versionInferred).toBe(0);
    /* v0-off 没有任何机制 ⇒ 全程不接管 */
    expect(rows.every((r) => r.layer === null)).toBe(true);
    expect(summary.layers).toEqual({ '(不接管)': 8 });
  });

  it('--limit 只是成本闸门：超出的手记 skip，不改变前面的结论', () => {
    const rec = parseRecord(mkRecord(), { file: 'x.json' });
    const { rows, summary } = replayGame(rec, { tactics: 'v0-off', limit: 3 });
    expect(summary.replayed).toBe(3);
    expect(summary.skipped).toBe(5);
    expect(rows[3].ran).toBe(false);
    expect(rows[3].skip).toBe('--limit 3');
  });

  it('--sides 只重放指定一侧，另一侧记 skip', () => {
    const rec = parseRecord(mkRecord({ raw: { blackChannel: 'proxy', whiteChannel: 'proxy' } }), { file: 'x.json' });
    const { rows, summary } = replayGame(rec, { tactics: 'v0-off', sides: 'black' });
    expect(summary.replayed).toBe(4);
    expect(rows.filter((r) => r.side === 'black').every((r) => r.ran)).toBe(true);
    expect(rows.filter((r) => r.side === 'white').every((r) => !r.ran && r.skip === '--sides=black')).toBe(true);
  });

  it('不给渠道（老归档没写 channel）时按「会跑战术层」重放并留 note', () => {
    const rec = parseRecord(mkRecord(), { file: 'x.json' });
    const { summary } = replayGame(rec, { tactics: 'v0-off' });
    expect(summary.replayed).toBe(8);
    expect(summary.notes.some((n) => /没写渠道/.test(n))).toBe(true);
  });

  it('rapfi 渠道整局不过战术层', () => {
    const rec = parseRecord(mkRecord({ raw: { channel: 'rapfi' } }), { file: 'x.json' });
    const { rows, summary } = replayGame(rec, { tactics: 'v14-live3-fresh' });
    expect(summary.replayed).toBe(0);
    expect(summary.costMs).toBe(0);
    expect(rows.every((r) => !r.ran && /不过战术层/.test(r.skip))).toBe(true);
  });

  it('未知档号 / 非法 --sides 一律 throw', () => {
    const rec = parseRecord(mkRecord(), { file: 'x.json' });
    expect(() => replayGame(rec, { tactics: 'v99-nope' })).toThrow(/未知战术档/);
    expect(() => replayGame(rec, { tactics: 'v0-off', sides: 'red' })).toThrow(/--sides/);
    expect(TACTICS_IDS).toContain('v14-live3-fresh');
  });

  it('非法着法停在那手并留 note（不抛）', () => {
    const raw = mkRecord({ extraMove: { ply: 9, side: '黑方', notation: 'ZZ9' } });
    const { rows, notes } = replayGame(parseRecord(raw, { file: 'x.json' }), { tactics: 'v0-off' });
    expect(rows.length).toBe(9);
    expect(notes.some((n) => /非法着法 ZZ9/.test(n))).toBe(true);
  });
});

describe('判据口径：层一致 / 落点一致 / 会变的手', () => {
  it('归档带层标记时：层不同即「会变」，落点不同也算', () => {
    const raw = mkRecord({ extraMove: { ply: 9, side: '黑方', notation: 'G8' }, layers: { 9: 'block' } });
    const { summary } = replayGame(parseRecord(raw, { file: 'x.json' }), { tactics: 'v14-live3-fresh' });
    expect(summary.layerFieldKnown).toBe(true);
    expect(summary.layerCompared).toBe(9);
    expect(summary.changed).toBeGreaterThanOrEqual(1);
    const row = summary.changedRows.find((r) => r.ply === 9);
    expect(row).toMatchObject({ layer: 'win', was: 'block', played: 'G8' });
  });

  it('归档没有层标记时：比不出层一致率，只报「有接管且落点不同」', () => {
    const raw = mkRecord({ extraMove: { ply: 9, side: '黑方', notation: 'G8' } });
    const { rows, summary } = replayGame(parseRecord(raw, { file: 'x.json' }), { tactics: 'v14-live3-fresh' });
    expect(summary.layerFieldKnown).toBe(false);
    expect(summary.layerCompared).toBe(0);
    expect(summary.layerSameRate).toBe(null);
    /* 这条夹具是「重放一路接管」的极端局面：平坦模型下 4–9 手全被接管，且首选点都是 G8
       ⇒ 只有第 9 手（实走也是 G8 的致胜点）算落点一致，前 5 手记成「会变」。 */
    expect(summary.takeoverMoves).toBe(6);
    expect(summary.takeoverMoveSame).toBe(1);
    expect(summary.changed).toBe(5);
    expect(rows.map((r) => r.layer)).toEqual([null, null, null, 'parry3', 'live3Attack', 'vcfDefense', 'open4', 'block', 'win']);
  });

  it('summarize 直接吃合成行：比率口径与除数', () => {
    const rows = [
      { ply: 1, side: 'black', ran: true, v: 'v14-live3-fresh', layer: 'win', notation: 'G8', recordedLayer: 'win', recordedNotation: 'G8' },
      { ply: 2, side: 'white', ran: true, v: 'v14-live3-fresh', layer: 'block', notation: 'A1', recordedLayer: 'win', recordedNotation: 'A2' },
      { ply: 3, side: 'black', ran: false, v: 'v14-live3-fresh', layer: null, notation: null, recordedLayer: null, recordedNotation: 'B1' },
    ];
    const s = summarize(rows, { hasLayerField: true, replayed: 2, costMs: 12 });
    expect(s.moves).toBe(3);
    expect(s.replayed).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.layerSame).toBe(1);
    expect(s.layerSameRate).toBe(50);
    expect(s.takeoverMoves).toBe(2);
    expect(s.takeoverMoveSame).toBe(1);
    expect(s.takeoverMoveSameRate).toBe(50);
    /* 只有 ply2 变（层不同）；ply1 层与落点都对 ⇒ 不算会变 */
    expect(s.changed).toBe(1);
    expect(s.layers).toEqual({ win: 1, block: 1 });
    expect(s.recordedLayers).toEqual({ win: 2 });
  });

  it('mergeSummaries 跨局累计并重算比率', () => {
    const a = summarize([{ ply: 1, ran: true, layer: 'win', notation: 'G8', recordedLayer: 'win', recordedNotation: 'G8' }],
      { hasLayerField: true, replayed: 1, costMs: 5 });
    const b = summarize([{ ply: 1, ran: true, layer: null, notation: null, recordedLayer: 'block', recordedNotation: 'A1' }],
      { hasLayerField: true, replayed: 1, costMs: 7 });
    const m = mergeSummaries([a, b]);
    expect(m.games).toBe(2);
    expect(m.layerCompared).toBe(2);
    expect(m.layerSame).toBe(1);
    expect(m.layerSameRate).toBe(50);
    expect(m.changed).toBe(1);
    expect(m.costMs).toBe(12);
    expect(m.notes).toEqual([]);
  });

  it('mergeSummaries：任一局没有层标记就不报层一致率', () => {
    const a = summarize([{ ply: 1, ran: true, layer: 'win', notation: 'G8', recordedLayer: null, recordedNotation: 'G8' }],
      { hasLayerField: false, replayed: 1 });
    const m = mergeSummaries([a]);
    expect(m.layerFieldKnown).toBe(false);
    expect(m.layerSameRate).toBe(null);
  });
});
