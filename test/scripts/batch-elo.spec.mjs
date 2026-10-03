// batch-elo.spec.mjs — 身份归一 / Elo 顺序迭代 / 排行标注
import { describe, it, expect } from 'vitest';
import {
  identityOf, gameRecord, loadRecords, computeElo, rankTable, formatRankTable, MIN_GAMES,
} from '../../scripts/lib/batch-elo.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('identityOf', () => {
  it('三元组：渠道|战术档|思考ms（空档留空，与归档/报表桶键同形状；唯一实现在 batch-common）', () => {
    expect(identityOf({ channel: 'proxy', tactics: 'v11-vct', thinkMs: 0 })).toBe('proxy|v11-vct|0');
    expect(identityOf({ channel: 'mock' })).toBe('mock||0');
    expect(identityOf({ channel: 'rapfi', tactics: 'v13-pressure-gate', thinkMs: 500 })).toBe('rapfi|v13-pressure-gate|500');
    expect(identityOf({ channel: 'rapfi', tactics: '', thinkMs: '1000' })).toBe('rapfi||1000');
  });
});

describe('gameRecord', () => {
  const base = {
    exported: '2026-10-03T00:00:00Z', gameUid: 'g1', experiment: 'exp-x-r1',
    blackChannel: 'mock', whiteChannel: 'random', blackTactics: '', whiteTactics: 'v13-pressure-gate',
    blackThink: 0, whiteThink: 0, moves: [{}, {}, {}],
  };
  it('黑胜 → 黑方得分 1，白胜 → 0，和棋 → 0.5', () => {
    expect(gameRecord({ ...base, winner: 'black', result: 'black_win', endReason: '五连' }).blackScore).toBe(1);
    expect(gameRecord({ ...base, winner: 'white', result: 'white_win' }).blackScore).toBe(0);
    expect(gameRecord({ ...base, winner: 'draw', result: 'draw' }).blackScore).toBe(0.5);
  });
  /* 真实导出的和棋形状：result=「和棋（棋盘已满）」而 winner 字段根本没有
     （record-map.ts:255 parseResult() 对和棋给 winner:null；D1 games.winner 也是 NULL）。
     x1 轮两局 225 手满盘和棋曾因此被整局丢掉 ⇒ Elo 只算 22/24 局。 */
  it('和棋按 result 串识别（winner 缺失也计 0.5，铁律 11：胜/和/负同报）', () => {
    expect(gameRecord({ ...base, result: '和棋（棋盘已满）' }).blackScore).toBe(0.5);
    expect(gameRecord({ ...base, result: '和棋' }).blackScore).toBe(0.5);
    expect(gameRecord({ ...base, winner: '', result: '和棋（棋盘已满）' }).reason).toBe('棋盘已满');
  });
  it('未终局（既无 winner、result 也不是和棋）→ 不计入', () => {
    expect(gameRecord({ ...base, result: '黑方 获胜（五连）' })).toBeNull();
  });
  it('winner 缺失 → 不计入', () => {
    expect(gameRecord({ ...base })).toBeNull();
    expect(gameRecord({ ...base, winner: '' })).toBeNull();
    expect(gameRecord({ ...base, winner: 'unknown-thing' })).toBeNull();
  });
  it('身份从 export 的黑白三字段提取', () => {
    const r = gameRecord({ ...base, winner: 'black' });
    expect(r.black).toBe('mock||0');
    expect(r.white).toBe('random|v13-pressure-gate|0');
    expect(r.plies).toBe(3);
  });
});

describe('computeElo / rankTable', () => {
  const rec = (n, blackScore, tag = 'exp-x') => ({
    tag, exported: `2026-10-03T00:00:${String(n).padStart(2, '0')}Z`, gameUid: `g${n}`,
    black: 'a|v1-facts|0', white: 'b|v1-facts|0', blackScore, result: 'x', reason: '', plies: 10,
  });
  it('全胜方 Elo 上升、全败方下降，K=16', () => {
    const { rating } = computeElo([rec(1, 1), rec(2, 1)]);
    expect(rating.get('a|v1-facts|0')).toBeGreaterThan(1500);
    expect(rating.get('b|v1-facts|0')).toBeLessThan(1500);
    expect(rating.get('a|v1-facts|0') + rating.get('b|v1-facts|0')).toBeCloseTo(3000, 6);
  });
  it('和棋双方不变', () => {
    const { rating } = computeElo([rec(1, 0.5)]);
    expect(rating.get('a|v1-facts|0')).toBe(1500);
  });
  it('rankTable 汇总胜和负并标注样本不足', () => {
    const rows = rankTable([rec(1, 1), rec(2, 0.5), rec(3, 0)]);
    const a = rows.find((r) => r.identity === 'a|v1-facts|0');
    const b = rows.find((r) => r.identity === 'b|v1-facts|0');
    expect([a.w, a.d, a.l]).toEqual([1, 1, 1]);
    expect([b.w, b.d, b.l]).toEqual([1, 1, 1]);
    expect(a.enough).toBe(false); // 3 局 < 50
    expect(MIN_GAMES).toBe(50);
  });
  it('formatRankTable 输出表头与每身份一行', () => {
    const text = formatRankTable(rankTable([rec(1, 1)]));
    expect(text).toContain('a|v1-facts|0');
    expect(text).toContain('b|v1-facts|0');
    expect(text).toContain('Elo');
  });
});

describe('loadRecords', () => {
  it('只收 games/ 子目录里的棋谱，跳过坏 JSON 与 summary/elo 等非棋谱文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-'));
    const games = path.join(dir, 'round-1', 'games');
    fs.mkdirSync(games, { recursive: true });
    const g = (winner, exported, uid) => JSON.stringify({
      exported, gameUid: uid, winner, result: winner || '', endReason: '', moves: [],
      blackChannel: 'mock', whiteChannel: 'mock', blackTactics: '', whiteTactics: '',
    });
    fs.writeFileSync(path.join(games, 'a.json'), g('black', '2026-10-03T00:00:02Z', 'u2'));
    fs.writeFileSync(path.join(games, 'b.json'), '{ 坏 json');
    fs.writeFileSync(path.join(games, 'c.json'), g('white', '2026-10-03T00:00:01Z', 'u1'));
    fs.writeFileSync(path.join(games, 'd.json'), g('', '2026-10-03T00:00:03Z', 'u3')); // winner 空 → 未终局，不计入
    // 同目录里的非棋谱 JSON 不应被统计
    fs.writeFileSync(path.join(games, 'round-summary.json'), JSON.stringify({ games: [] }));
    fs.writeFileSync(path.join(games, 'elo.json'), JSON.stringify({ rows: [] }));
    fs.writeFileSync(path.join(dir, 'plans.json'), JSON.stringify({ tag: 'x' }));
    const recs = loadRecords([dir, path.join(dir, '不存在')]);
    expect(recs.map((r) => r.gameUid)).toEqual(['u1', 'u2']);
  });
});
