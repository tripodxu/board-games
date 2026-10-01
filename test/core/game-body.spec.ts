/**
 * 请求体校验规则的「真实数据回归」（Node project）。
 *
 * 为什么放在 core 而不是 worker project：workerd 里没有 `node:fs`，读不到仓库里的
 * 54 份历史棋谱；而这些棋谱正是「`/api/games` 的校验规则会不会把存量数据挡在门外」的
 * 唯一证据。规则本身（`src/worker/lib/validate.ts`）是纯函数，Node 里直接跑。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notationCount, parseGamePayload } from '../../src/worker/lib/validate.ts';
import { measureBytes } from '../../src/shared/record-map.ts';

const GAMES_DIR = join(process.cwd(), 'games');

function archiveFiles(): string[] {
  const out: string[] = [];
  for (const day of readdirSync(GAMES_DIR, { withFileTypes: true })) {
    if (!day.isDirectory()) continue;
    for (const file of readdirSync(join(GAMES_DIR, day.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.json')) out.push(join(GAMES_DIR, day.name, file.name));
    }
  }
  return out;
}

const files = archiveFiles();

describe('parseGamePayload × 54 份真实归档', () => {
  it('仓库里确实有归档可校验（防止 glob 写错导致空跑）', () => {
    expect(files.length).toBe(54);
  });

  it('每一份历史棋谱都能通过请求体校验', () => {
    const rejected: string[] = [];
    let moves = 0;
    let bytes = 0;
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      bytes += measureBytes(text);
      const parsed = parseGamePayload(JSON.parse(text) as unknown);
      if (!parsed.ok) {
        rejected.push(`${path}: ${parsed.code} ${parsed.message}`);
        continue;
      }
      // 「notation 条目数 == moves 长度」这条规则在真实数据上必须成立，
      // 否则它是条会把存量数据挡住的苛规则（历史上 notation 末尾带逗号）。
      expect(notationCount(parsed.value.notation)).toBe(parsed.value.moves.length);
      moves += parsed.value.moves.length;
    }
    expect(rejected).toEqual([]);
    expect(moves).toBe(4379);
    expect(Math.round(bytes / 1024 / 1024 * 100) / 100).toBe(0.81);
  });
});

describe('parseGamePayload 的拒绝分支', () => {
  const good = () => ({
    format: 'jev-qiguan-game/v1',
    exported: '2026-10-01T00:00:00.000Z',
    notation: 'h8,',
    moves: [{ notation: 'h8' }],
  });

  it('逐条错误各自有明确 code', () => {
    const cases: [unknown, string][] = [
      [null, 'invalid_payload'],
      [[], 'invalid_payload'],
      [{ ...good(), format: 'x' }, 'invalid_payload'],
      [{ ...good(), notation: '' }, 'invalid_payload'],
      [{ ...good(), moves: [] }, 'invalid_payload'],
      [{ ...good(), moves: [{ notation: '' }] }, 'invalid_payload'],
      [{ ...good(), moves: [{ notation: 'h8' }, { notation: 'i9' }] }, 'invalid_payload'],
      [{ ...good(), exported: 'not-a-time' }, 'invalid_payload'],
      [{ ...good(), gameUid: '' }, 'invalid_payload'],
      [{ ...good(), gameUid: 'x'.repeat(65) }, 'invalid_payload'],
    ];
    for (const [input, code] of cases) {
      const parsed = parseGamePayload(input);
      expect(parsed.ok, JSON.stringify(input)).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe(code);
    }
    expect(parseGamePayload(good()).ok).toBe(true);
  });

  it('超过 512KB 的 payload 给 payload_too_large（413 的上游语义）', () => {
    const payload = good();
    const big = {
      ...payload,
      moves: Array.from({ length: 1 }, () => ({ notation: 'h8', pad: 'x'.repeat(600 * 1024) })),
    };
    const parsed = parseGamePayload(big);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('payload_too_large');
  });
});
