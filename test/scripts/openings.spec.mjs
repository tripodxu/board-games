/**
 * test/scripts/openings.spec.mjs — scripts/lib/openings.mjs 单测（vitest project「scripts」）
 *
 * 重点两条口径：
 *   ① 对称归一必须真的把 8 种变换收敛到同一个 key（不然配对开局等于随机挑一条）；
 *   ② `buildLibrary` 必须**同输入同输出**（库文件里没有时间戳，可复现是 D9 的前提）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';

import {
  LIB_VERSION,
  BOARD_SIZE,
  SYMMETRIES,
  rcOf,
  notationOf,
  transformRC,
  transformNotation,
  isValidPoint,
  openingProblem,
  canonicalOpening,
  compareSeq,
  openingOfMoves,
  buildLibrary,
  libraryProblems,
  readLibrary,
  writeLibrary,
  openingForNo,
  recordsFromDir,
} from '../../scripts/lib/openings.mjs';

const tmpDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'openings-spec-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('坐标与记法', () => {
  it('rcOf/notationOf 往返（与引擎 parseN 同口径：列字母 + 行号-1）', () => {
    expect(rcOf('H8')).toEqual({ r: 7, c: 7 });
    expect(rcOf('A1')).toEqual({ r: 0, c: 0 });
    expect(rcOf('O15')).toEqual({ r: 14, c: 14 });
    expect(notationOf(7, 7)).toBe('H8');
    expect(notationOf(0, 14)).toBe('O1');
  });

  it('SYMMETRIES = 8，BOARD_SIZE = 15', () => {
    expect(SYMMETRIES).toBe(8);
    expect(BOARD_SIZE).toBe(15);
  });

  it('transformRC：k=0 恒等，k=1 是顺时针 90°', () => {
    expect(transformRC(3, 5, 0)).toEqual({ r: 3, c: 5 });
    expect(transformRC(0, 0, 1)).toEqual({ r: 0, c: 14 });
    expect(transformRC(0, 14, 1)).toEqual({ r: 14, c: 14 });
    expect(transformRC(1, 2, 4)).toEqual({ r: 1, c: 12 }); // 先左右镜像
  });

  it('变换四次回到自身（旋转群阶 4）', () => {
    let p = { r: 2, c: 9 };
    for (let i = 0; i < 4; i++) p = transformRC(p.r, p.c, 1);
    expect(p).toEqual({ r: 2, c: 9 });
  });

  it('transformNotation 对非法输入返回 null', () => {
    expect(transformNotation('H8', 0)).toBe('H8');
    expect(transformNotation('??', 0)).toBeNull();
  });

  it('isValidPoint 认形状也认盘内', () => {
    expect(isValidPoint('A1')).toBe(true);
    expect(isValidPoint('O15')).toBe(true);
    expect(isValidPoint('P1')).toBe(false); // 第 16 列
    expect(isValidPoint('A16')).toBe(false); // 第 16 行
    expect(isValidPoint('8H')).toBe(false);
    expect(isValidPoint('')).toBe(false);
  });
});

describe('openingProblem', () => {
  it('空开局、非法点、重复点各给理由', () => {
    expect(openingProblem([])).toBe('开局为空');
    expect(openingProblem(['H8', 'Z9'])).toContain('非法着法');
    expect(openingProblem(['H8', 'H8'])).toContain('重复点');
    expect(openingProblem(['H8', 'I9', 'G7'])).toBeNull();
  });
});

describe('canonicalOpening（对称归一）', () => {
  const seq = ['H8', 'I9', 'H9', 'I8'];

  it('8 种变换归一到同一个 key', () => {
    const base = canonicalOpening(seq).key;
    for (let k = 0; k < SYMMETRIES; k++) {
      const t = seq.map((n) => transformNotation(n, k));
      expect(canonicalOpening(t).key).toBe(base);
    }
  });

  it('取坐标序最小的表示（角落点归一到 A1）', () => {
    expect(canonicalOpening(['O15']).key).toBe('A1');
    expect(canonicalOpening(['H8']).key).toBe('H8');
  });

  it('归一结果自身再归一时不变（幂等）', () => {
    const once = canonicalOpening(seq).seq;
    expect(canonicalOpening(once).seq).toEqual(once);
  });

  it('非法开局直接抛', () => {
    expect(() => canonicalOpening(['H8', 'H8'])).toThrow(/不合法/);
  });
});

describe('compareSeq', () => {
  it('按坐标比，不踩 "A10" < "A9" 的字典序陷阱', () => {
    expect(compareSeq(['A9'], ['A10'])).toBeLessThan(0);
    expect(compareSeq(['A10'], ['A9'])).toBeGreaterThan(0);
  });

  it('同前缀按长度比', () => {
    expect(compareSeq(['A1'], ['A1', 'B1'])).toBeLessThan(0);
    expect(compareSeq(['A1', 'B1'], ['A1'])).toBeGreaterThan(0);
  });
});

describe('openingOfMoves', () => {
  it('接受字符串与 {notation} 两种形状', () => {
    expect(openingOfMoves(['H8', 'I9', 'H9'], 3)).toEqual(['H8', 'I9', 'H9']);
    expect(openingOfMoves([{ notation: 'H8' }, { notation: 'I9' }], 2)).toEqual(['H8', 'I9']);
  });

  it('手数不足或缺 notation 给 null', () => {
    expect(openingOfMoves(['H8'], 6)).toBeNull();
    expect(openingOfMoves([{ notation: 'H8' }, {}], 2)).toBeNull();
    expect(openingOfMoves(null, 2)).toBeNull();
  });
});

describe('buildLibrary', () => {
  const game = (uid, moves, winner = 'black') => ({ gameUid: uid, winner, moves });

  it('同开局的旋转/镜像只算一条（去重靠归一）', () => {
    const lib = buildLibrary([
      game('g1', ['H8', 'I9', 'H9', 'I8', 'G7', 'J6']),
      game('g2', ['H8', 'I9', 'H9', 'I8', 'G7', 'J6'].map((n) => transformNotation(n, 3))),
    ]);
    expect(lib.openings).toHaveLength(1);
    expect(lib.openings[0].count).toBe(2);
    expect(lib.openings[0].uids).toEqual(['g1', 'g2']);
  });

  it('decisiveOnly 默认丢掉和棋；关了就和棋也进库', () => {
    const records = [
      game('g1', ['H8', 'I9', 'H9', 'I8', 'G7', 'J6']),
      game('g2', ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'], null),
    ];
    const strict = buildLibrary(records);
    expect(strict.openings).toHaveLength(1);
    expect(strict.source.dropped).toBe(1);
    const loose = buildLibrary(records, { decisiveOnly: false });
    expect(loose.openings).toHaveLength(2);
  });

  it('手数不足的局记进 dropped（不算入 used）', () => {
    const lib = buildLibrary([
      game('g1', ['H8', 'I9', 'H9']),
      game('g2', ['H8', 'I9', 'H9', 'I8', 'G7', 'J6']),
    ]);
    expect(lib.source).toEqual({ games: 2, used: 1, dropped: 1 });
  });

  it('minCount 过滤低频开局', () => {
    const lib = buildLibrary([
      game('g1', ['H8', 'I9', 'H9', 'I8', 'G7', 'J6']),
      game('g2', ['A1', 'B2', 'C3', 'D4', 'E5', 'F6']),
    ], { minCount: 2 });
    expect(lib.openings).toHaveLength(0);
  });

  it('排序：出现次数多的在前（次数相同按坐标序）', () => {
    const common = ['H8', 'I9', 'H9', 'I8', 'G7', 'J6'];
    const rare = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'];
    const lib = buildLibrary([
      game('g1', common), game('g2', common), game('g3', rare),
    ]);
    expect(lib.openings.map((o) => o.count)).toEqual([2, 1]);
  });

  it('同输入 ⇒ 逐字节同输出（可复现的前提）', () => {
    const records = [
      game('g1', ['H8', 'I9', 'H9', 'I8', 'G7', 'J6']),
      game('g2', ['A1', 'B2', 'C3', 'D4', 'E5', 'F6']),
    ];
    const a = JSON.stringify(buildLibrary(records));
    const b = JSON.stringify(buildLibrary([...records].reverse()));
    expect(a).toBe(b);
  });

  it('plies 太小直接抛', () => {
    expect(() => buildLibrary([], { plies: 1 })).toThrow(/plies/);
  });

  it('库自描述字段齐备', () => {
    const lib = buildLibrary([game('g1', ['H8', 'I9', 'H9', 'I8', 'G7', 'J6'])]);
    expect(lib.version).toBe(LIB_VERSION);
    expect(lib.size).toBe(BOARD_SIZE);
    expect(lib.plies).toBe(6);
    expect(lib.openings[0].key).toBe(lib.openings[0].seq.join(' '));
  });
});

describe('libraryProblems / 读写', () => {
  const good = buildLibrary([
    { gameUid: 'g1', winner: 'black', moves: ['H8', 'I9', 'H9', 'I8', 'G7', 'J6'] },
  ]);

  it('好库无问题', () => {
    expect(libraryProblems(good)).toEqual([]);
  });

  it('版本不符 / 空库 / seq 长度不符 / key 不一致 / key 重复 / 非法点 全部报出来', () => {
    expect(libraryProblems({ ...good, version: 99 })[0]).toContain('库版本');
    expect(libraryProblems({ ...good, openings: [] })[0]).toContain('空');
    expect(libraryProblems({ ...good, openings: [{ ...good.openings[0], seq: ['H8'] }] })[0]).toContain('长度');
    expect(libraryProblems({ ...good, openings: [{ ...good.openings[0], key: 'X' }] })[0]).toContain('key');
    const dup = { ...good, openings: [good.openings[0], { ...good.openings[0] }] };
    expect(libraryProblems(dup).some((p) => p.includes('重复'))).toBe(true);
    const badPoint = { ...good, openings: [{ ...good.openings[0], seq: ['Z9', 'I9', 'H9', 'I8', 'G7', 'J6'], key: 'Z9 I9 H9 I8 G7 J6' }] };
    expect(libraryProblems(badPoint).some((p) => p.includes('非法着法'))).toBe(true);
  });

  it('writeLibrary/readLibrary 往返；非法库拒绝写出', () => {
    const file = path.join(tmpDir(), 'nested', 'openings.json');
    writeLibrary(file, good);
    expect(readLibrary(file)).toEqual(good);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(() => writeLibrary(file, { ...good, openings: [] })).toThrow(/不合法/);
  });

  it('readLibrary 遇到坏文件抛错（不静默）', () => {
    const file = path.join(tmpDir(), 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ version: LIB_VERSION, size: 15, plies: 6, openings: [] }));
    expect(() => readLibrary(file)).toThrow(/开局库不合法/);
  });
});

describe('openingForNo（连续两局同一开局，换色双跑）', () => {
  const lib = buildLibrary([
    { gameUid: 'g1', winner: 'black', moves: ['H8', 'I9', 'H9', 'I8', 'G7', 'J6'] },
    { gameUid: 'g2', winner: 'black', moves: ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'] },
  ]);

  it('奇数局/偶数局成对同开局', () => {
    expect(openingForNo(lib, 1).key).toBe(openingForNo(lib, 2).key);
    expect(openingForNo(lib, 3).key).toBe(openingForNo(lib, 4).key);
    expect(openingForNo(lib, 1).key).not.toBe(openingForNo(lib, 3).key);
  });

  it('库只有 1 本时全部复用同一本', () => {
    const one = buildLibrary([{ gameUid: 'g1', winner: 'black', moves: ['H8', 'I9', 'H9', 'I8', 'G7', 'J6'] }]);
    expect(openingForNo(one, 7).key).toBe(openingForNo(one, 1).key);
  });

  it('越界 gameNo / 空库都要抛', () => {
    expect(() => openingForNo(lib, 0)).toThrow(/gameNo/);
    expect(() => openingForNo({ openings: [] }, 1)).toThrow(/空/);
  });
});

describe('recordsFromDir', () => {
  it('只收 <任意层级>/games/*.json', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'r1', 'games'), { recursive: true });
    fs.writeFileSync(path.join(root, 'r1', 'games', 'round-1-game-1.json'),
      JSON.stringify({ gameUid: 'g1', winner: 'black', moves: [{ notation: 'H8' }] }));
    fs.writeFileSync(path.join(root, 'r1', 'round-summary.json'), JSON.stringify({ nope: true }));
    fs.writeFileSync(path.join(root, 'r1', 'games', 'broken.json'), '{ 不是 JSON');
    const recs = recordsFromDir(root);
    expect(recs).toHaveLength(1);
    expect(recs[0].gameUid).toBe('g1');
  });

  it('归档布局 games/<day>/*.json 也读得到（父目录不叫 games）', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'games', '2026-10-01'), { recursive: true });
    fs.writeFileSync(path.join(root, 'games', '2026-10-01', 'gomoku-20261001120000.json'),
      JSON.stringify({ gameUid: 'a1', winner: '黑方', moves: [{ notation: 'H8' }] }));
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes', 'x.json'), JSON.stringify({ gameUid: 'no', moves: [] }));
    const recs = recordsFromDir(root);
    expect(recs.map((r) => r.gameUid)).toEqual(['a1']);
  });

  it('目录不存在给空数组（不抛）', () => {
    expect(recordsFromDir(path.join(tmpDir(), 'nope'))).toEqual([]);
    expect(recordsFromDir(null)).toEqual([]);
  });
});
