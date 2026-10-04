/**
 * test/scripts/progress.spec.mjs — scripts/lib/progress.mjs 单测（vitest project「scripts」）
 *
 * 这里守的是三条「读数的人会被骗」的口径：
 *   ① ETA 只用真跑完的局做样本，样本不足给 null（不编数字）；
 *   ② `done` 含 skipped（断点续跑时它算「已处理」），和 wdl 的分母不是一回事；
 *   ③ progress.json 必须原子（`kill -9` 后读侧只会看到完整 JSON 或旧快照，不会看到半截）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';

import {
  ETA_SAMPLES,
  SETTLED,
  progressPath,
  eventsPath,
  newState,
  recordGame,
  outcomeForA,
  snapshot,
  readProgress,
  writeProgress,
  appendEvent,
  formatProgress,
} from '../../scripts/lib/progress.mjs';

const tmpDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-spec-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 4, 0, 0, 0);
const base = (extra = {}) => newState({ batchId: 'p4', round: 1, tag: 'exp-test-r1', total: 4, startedAtMs: T0, ...extra });

describe('newState', () => {
  it('total 必须是 ≥1 的整数', () => {
    expect(() => base({ total: 0 })).toThrow(/total/);
    expect(() => base({ total: 2.5 })).toThrow(/total/);
    expect(base().games).toEqual([]);
  });
});

describe('recordGame', () => {
  it('纯函数：不改入参', () => {
    const s = base();
    const s2 = recordGame(s, { gameNo: 1, status: 'ok', durationMs: 1000, winner: 'black', gameUid: 'u1', plies: 30, aBlack: true });
    expect(s.games).toEqual([]);
    expect(s2.games).toHaveLength(1);
  });

  it('同一 gameNo 覆盖（断点续跑重记不重复累计）', () => {
    let s = recordGame(base(), { gameNo: 1, status: 'error', durationMs: null, winner: null, aBlack: true, error: 'boom' });
    s = recordGame(s, { gameNo: 1, status: 'ok', durationMs: 5000, winner: 'black', gameUid: 'u1', aBlack: true });
    expect(s.games).toHaveLength(1);
    expect(s.games[0].status).toBe('ok');
    expect(s.games[0].error).toBeNull();
  });

  it('按 gameNo 排序', () => {
    let s = recordGame(base(), { gameNo: 3, status: 'ok', durationMs: 1, aBlack: false });
    s = recordGame(s, { gameNo: 1, status: 'ok', durationMs: 1, aBlack: true });
    expect(s.games.map((g) => g.gameNo)).toEqual([1, 3]);
  });

  it('耗时非法记 null（不把 NaN 当样本）', () => {
    const s = recordGame(base(), { gameNo: 1, status: 'ok', durationMs: Number.NaN, aBlack: true });
    expect(s.games[0].durationMs).toBeNull();
  });
});

describe('outcomeForA', () => {
  it('A 执黑：black 胜 = w，white 胜 = l', () => {
    expect(outcomeForA({ status: 'ok', winner: 'black', aBlack: true })).toBe('w');
    expect(outcomeForA({ status: 'ok', winner: 'white', aBlack: true })).toBe('l');
  });

  it('A 执白时反过来', () => {
    expect(outcomeForA({ status: 'ok', winner: 'white', aBlack: false })).toBe('w');
    expect(outcomeForA({ status: 'ok', winner: 'black', aBlack: false })).toBe('l');
  });

  it('和棋 = d；error 不进 wdl（null）', () => {
    expect(outcomeForA({ status: 'ok', winner: null, aBlack: true })).toBe('d');
    expect(outcomeForA({ status: 'error', winner: null, aBlack: true })).toBeNull();
  });

  it('skipped 只有带回 winner 才算，否则 null（没跑 ≠ 和棋）', () => {
    expect(outcomeForA({ status: 'skipped', winner: null, aBlack: true })).toBeNull();
    expect(outcomeForA({ status: 'skipped', winner: 'white', aBlack: false })).toBe('w');
  });

  it('SETTLED 三态与状态字段一致', () => {
    expect(SETTLED).toEqual(['ok', 'ok-dry', 'skipped']);
  });
});

describe('snapshot', () => {
  it('done 含 skipped，wdl 不含 skipped/error', () => {
    let s = recordGame(base(), { gameNo: 1, status: 'ok', durationMs: 10_000, winner: 'black', aBlack: true, gameUid: 'u1' });
    s = recordGame(s, { gameNo: 2, status: 'skipped', durationMs: 0, winner: null, aBlack: false, gameUid: 'u2' });
    s = recordGame(s, { gameNo: 3, status: 'error', durationMs: 9000, winner: null, aBlack: true, gameUid: 'u3', error: 'x' });
    const snap = snapshot(s, { nowMs: T0 + 30_000 });
    expect(snap.done).toBe(2);
    expect(snap.wdl).toEqual({ w: 1, d: 0, l: 0 });
    expect(snap.elapsedS).toBe(30);
    expect(snap.lastGameUid).toBe('u3'); // games 按 gameNo 排序，末位是 3 号
  });

  it('ETA = 最近样本均值 × 剩余局数', () => {
    let s = base({ total: 6 });
    s = recordGame(s, { gameNo: 1, status: 'ok', durationMs: 10_000, winner: 'black', aBlack: true });
    s = recordGame(s, { gameNo: 2, status: 'ok', durationMs: 20_000, winner: 'white', aBlack: false });
    s = recordGame(s, { gameNo: 3, status: 'ok', durationMs: 30_000, winner: null, aBlack: true });
    const snap = snapshot(s, { nowMs: T0 });
    expect(snap.meanGameS).toBe(20);
    expect(snap.etaS).toBe(60); // 3 局剩，均值 20s
    expect(snap.wdl).toEqual({ w: 2, d: 1, l: 0 });
  });

  it('只取最近 ETA_SAMPLES 局做样本', () => {
    let s = base({ total: 8 });
    for (let i = 1; i <= 6; i++) s = recordGame(s, { gameNo: i, status: 'ok', durationMs: 1000 * i, winner: 'black', aBlack: true });
    const snap = snapshot(s, { nowMs: T0 });
    // 最近 5 局 = 2000..6000 ⇒ 均值 4000ms；剩 2 局 ⇒ 8s
    expect(ETA_SAMPLES).toBe(5);
    expect(snap.meanGameS).toBe(4);
    expect(snap.etaS).toBe(8);
  });

  it('没有真跑完的局时 etaS 给 null（不编数字）', () => {
    let s = base();
    s = recordGame(s, { gameNo: 1, status: 'skipped', durationMs: 0, aBlack: true });
    const snap = snapshot(s, { nowMs: T0 });
    expect(snap.etaS).toBeNull();
    expect(snap.meanGameS).toBeNull();
  });

  it('全跑完时 etaS = 0', () => {
    let s = base({ total: 1 });
    s = recordGame(s, { gameNo: 1, status: 'ok', durationMs: 5000, winner: 'black', aBlack: true });
    expect(snapshot(s, { nowMs: T0 }).etaS).toBe(0);
  });

  it('current 覆盖 gameNo/ply（长局中也能看出跑到第几手）', () => {
    let s = base();
    s = recordGame(s, { gameNo: 1, status: 'ok', durationMs: 1, winner: 'black', aBlack: true });
    const snap = snapshot(s, { nowMs: T0, current: { gameNo: 2, ply: 37 } });
    expect(snap.gameNo).toBe(2);
    expect(snap.ply).toBe(37);
  });

  it('空跑动也能出快照（gameNo/ply 为 null）', () => {
    const snap = snapshot(base(), { nowMs: T0 });
    expect(snap).toMatchObject({ done: 0, gameNo: null, ply: null, lastGameUid: null });
    expect(snap.wdl).toEqual({ w: 0, d: 0, l: 0 });
  });
});

describe('IO', () => {
  it('writeProgress/readProgress 往返且不留 .tmp', () => {
    const dir = tmpDir();
    const snap = snapshot(base(), { nowMs: T0 });
    writeProgress(dir, snap);
    expect(fs.readFileSync(progressPath(dir), 'utf8').endsWith('\n')).toBe(true);
    expect(fs.existsSync(`${progressPath(dir)}.tmp`)).toBe(false);
    expect(readProgress(dir)).toEqual(snap);
  });

  it('readProgress 对缺失/坏文件给 null', () => {
    const dir = tmpDir();
    expect(readProgress(dir)).toBeNull();
    fs.writeFileSync(progressPath(dir), '{ 半截');
    expect(readProgress(dir)).toBeNull();
  });

  it('appendEvent 追加 JSONL（每行带 at）', () => {
    const dir = tmpDir();
    expect(appendEvent(dir, { kind: 'round-start', gameNo: 1 })).toBe(true);
    appendEvent(dir, { kind: 'game-done', gameNo: 1, status: 'ok' });
    const lines = fs.readFileSync(eventsPath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe('round-start');
    expect(typeof lines[1].at).toBe('string');
  });

  it('appendEvent 写不进去只告警返回 false（不拖垮跑动）', () => {
    const file = path.join(tmpDir(), 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(appendEvent(path.join(file, 'sub'), { kind: 'x' })).toBe(false);
  });
});

describe('formatProgress', () => {
  it('一行摘要包含轮次/进度/胜负/ETA', () => {
    let s = base();
    s = recordGame(s, { gameNo: 1, status: 'ok', durationMs: 10_000, winner: 'black', aBlack: true });
    const line = formatProgress(snapshot(s, { nowMs: T0, current: { gameNo: 2, ply: 12 } }));
    expect(line).toContain('r1 1/4');
    expect(line).toContain('W1-D0-L0');
    expect(line).toContain('ply=12');
    expect(line).toContain('ETA 30s');
    expect(formatProgress(null)).toContain('无 progress.json');
  });
});
