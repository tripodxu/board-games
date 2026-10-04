/**
 * `src/shared/record-map.ts` 的真实数据校验（计划 §4.2 / P2 验收）。
 *
 * fixture 一律用**仓库里的真文件**（`games/**\/*.json` 54 份 + `data/experiments.json` 6 轮），
 * 不造假数据：映射逻辑的价值就在于对上真实的脏字段（缺失 meta、中文 result、数字数组 cal…）。
 * 断言里的常量都是 2026-10-01 实测值，改动它们等于改口径，必须同步计划与 ADR。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAYLOAD_MAX_BYTES,
  dedupSource,
  gameIdToName,
  gameNameToId,
  gameUidSource,
  mapExperimentRecord,
  mapGameRecord,
  measureBytes,
  parseMode,
  parseResult,
} from '../../src/shared/record-map.ts';
import type { ExperimentPayload, GamePayload } from '../../src/shared/record-map.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

function walkJson(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkJson(p, out);
    else if (p.endsWith('.json')) out.push(p);
  }
  return out;
}

const gameFiles = walkJson(join(ROOT, 'games')).sort();
const archives = gameFiles.map((abs) => {
  const raw = readFileSync(abs, 'utf8');
  const payload = JSON.parse(raw) as GamePayload;
  const gameUid = sha1(gameUidSource(payload)).slice(0, 16);
  const dedupKey = sha1(dedupSource(payload, gameUid));
  const day = abs.slice(ROOT.length).split(/[\\/]/)[1];
  return { abs, raw, payload, mapped: mapGameRecord(payload, { gameUid, dedupKey }, { rawPayload: raw, fallbackDay: day, source: 'import' }) };
});

describe('record-map：54 份真实棋谱', () => {
  it('全量映射零告警，且身份键互不相同', () => {
    expect(archives).toHaveLength(54);
    expect(archives.flatMap((a) => a.mapped.warnings)).toEqual([]);
    expect(new Set(archives.map((a) => a.mapped.row.game_uid)).size).toBe(54);
    expect(new Set(archives.map((a) => a.mapped.row.dedup_key)).size).toBe(54);
  });

  it('每行的 NOT NULL 列都有值，且 day 来自目录/导出时间', () => {
    for (const { mapped, abs } of archives) {
      const row = mapped.row;
      for (const key of ['game_uid', 'dedup_key', 'created_at', 'day', 'game', 'game_id', 'notation', 'payload', 'source'] as const) {
        expect(row[key], `${abs} 的 ${key}`).toBeTruthy();
      }
      expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.payload).not.toBe('');
      expect(row.payload_bytes).toBe(measureBytes(row.payload));
      expect(row.payload_bytes).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
    }
  });

  it('逐手明细：4379 手、ply 连续、每手都有阵营与记法', () => {
    const total = archives.reduce((n, a) => n + a.mapped.moves.length, 0);
    expect(total).toBe(4379);
    for (const { mapped, abs } of archives) {
      expect(mapped.moves).toHaveLength(mapped.row.move_count);
      mapped.moves.forEach((m, i) => {
        expect(m.ply, `${abs} 第 ${i} 手 ply`).toBe(i + 1);
        expect(['black', 'white']).toContain(m.side);
        expect(m.notation).toBeTruthy();
      });
      expect(mapped.row.opening_prefix).toBe(mapped.moves.slice(0, 4).map((m) => m.notation).join(','));
    }
  });

  it('派生字段与实测口径一致：全部 gomoku、cal 33、firstWin 26、meta 26、mock 0', () => {
    const rows = archives.map((a) => a.mapped.row);
    expect(new Set(rows.map((r) => r.game_id))).toEqual(new Set(['gomoku']));
    expect(rows.filter((r) => r.cal_json !== null)).toHaveLength(33);
    expect(rows.filter((r) => r.first_win !== null)).toHaveLength(26);
    expect(rows.filter((r) => r.code_version !== null)).toHaveLength(26);
    expect(rows.filter((r) => r.mock === 1)).toHaveLength(0);
    expect(rows.filter((r) => r.device_id === null)).toHaveLength(54);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['import']));
    expect(rows.reduce((n, r) => n + r.payload_bytes, 0)).toBe(845_578);
  });

  it('中文 result 全部解析出结构化 winner/endReason', () => {
    const counts: Record<string, number> = {};
    for (const { mapped } of archives) {
      const row = mapped.row;
      expect(row.end_reason, row.result ?? '').toBeTruthy();
      counts[`${row.winner}/${row.end_reason}`] = (counts[`${row.winner}/${row.end_reason}`] ?? 0) + 1;
    }
    expect(counts).toEqual({ 'white/五连': 27, 'black/五连': 17, 'null/棋盘已满': 9, 'black/认输': 1 });
  });

  it('实验标签一一对应 6 轮，且 meta 直方图落在 tactics_hist', () => {
    const rows = archives.map((a) => a.mapped.row);
    expect([...new Set(rows.map((r) => r.experiment_tag).filter(Boolean))].sort()).toEqual([
      'exp-20260929105234', 'exp-20260929111222', 'exp-20260930025135',
      'exp-20260930084500', 'exp-20260930090336', 'exp-20260930143522',
    ]);
    const hist = rows.map((r) => r.tactics_hist).filter((v): v is string => v !== null);
    expect(hist.length).toBeGreaterThan(0);
    for (const h of hist) expect(typeof JSON.parse(h)).toBe('object');
  });
});

describe('record-map：6 轮实验', () => {
  const entries = JSON.parse(readFileSync(join(ROOT, 'data/experiments.json'), 'utf8')) as ExperimentPayload[];

  it('按 tag 映射，tacA/tacB 原样保留（同渠道 A/B 的唯一可分辨依据）', () => {
    expect(entries).toHaveLength(6);
    const rows = entries.map((e) => mapExperimentRecord(e, { now: '2026-10-01T00:00:00.000Z' }));
    expect(rows.map((r) => r.tag)).toEqual(entries.map((e) => e.tag));
    expect(rows.map((r) => [r.tac_a, r.tac_b])).toEqual(entries.map((e) => [e.tacA ?? null, e.tacB ?? null]));
    expect(rows[0].tac_a).toBe('v9-vcf-sound');
    expect(rows[0].tac_b).toBe('v8-vcf-try');
    expect(rows[0].device_id).toBeNull();
  });

  it('games_json 往返无损；total 缺省时回落到局数', () => {
    for (const e of entries) {
      const row = mapExperimentRecord(e);
      expect(JSON.parse(row.games_json)).toEqual(e.games ?? []);
      expect(row.total).toBe(e.total ?? (e.games ?? []).length);
      expect(row.date).toBeTruthy();
    }
  });
});

describe('record-map：解析与边界', () => {
  it('parseResult 覆盖四种真实串 + 无法解析的返回 null', () => {
    expect(parseResult('黑方 获胜（五连）')).toEqual({ winner: 'black', endReason: '五连' });
    expect(parseResult('白方 获胜（五连）')).toEqual({ winner: 'white', endReason: '五连' });
    expect(parseResult('黑方 获胜（认输）')).toEqual({ winner: 'black', endReason: '认输' });
    expect(parseResult('和棋（棋盘已满）')).toEqual({ winner: null, endReason: '棋盘已满' });
    expect(parseResult('黑方 获胜')).toEqual({ winner: 'black', endReason: null });
    expect(parseResult('???')).toEqual({ winner: null, endReason: null });
    expect(parseResult(null)).toEqual({ winner: null, endReason: null });
  });

  it('棋种名归一：围棋/象棋带排版空格也能查表', () => {
    expect(gameNameToId('五子棋')).toBe('gomoku');
    expect(gameNameToId('围 棋')).toBe('go');
    expect(gameNameToId('象 棋')).toBe('xiangqi');
    expect(gameNameToId('五子棋·禁手')).toBe('gomoku-pro');
    expect(gameNameToId('国际象棋')).toBe('chess');
    expect(gameNameToId('西洋跳棋')).toBe('checkers');
    expect(gameNameToId('中国跳棋')).toBe('cc');
    expect(gameNameToId('飞行棋')).toBe('unknown');
    expect(gameIdToName('gomoku')).toBe('五子棋');
    expect(gameIdToName('cc')).toBe('中国跳棋');
  });

  it('mode 中英双向：中文旧值映射、英文新值透传、未知为 null', () => {
    expect(parseMode('人机')).toBe('human-ai');
    expect(parseMode('机机')).toBe('ai-ai');
    expect(parseMode('双人')).toBe('pvp');
    expect(parseMode('human-ai')).toBe('human-ai');
    expect(parseMode('观战')).toBeNull();
    expect(parseMode(undefined)).toBeNull();
  });

  it('measureBytes 按 UTF-8 计字节，不是字符数', () => {
    expect(measureBytes('五子棋')).toBe(9);
    expect(measureBytes('abc')).toBe(3);
    expect(measureBytes('')).toBe(0);
  });

  it('新客户端字段优先：gameUid/winner/endReason/gameId 直接采信', () => {
    const payload: GamePayload = {
      format: 'jev-qiguan-game/v1',
      exported: '2026-10-01T00:00:00.000Z',
      gameUid: 'uid-1',
      gameId: 'chess',
      mode: 'human-ai',
      result: '黑方 获胜（五连）',
      winner: 'white',
      endReason: '将杀',
      endBy: 'human',
      notation: 'e2e4,e7e5,',
      mock: true,
      deviceId: 'dev-1',
      moves: [
        { ply: 1, side: '白方', notation: 'e2e4', ai: { ch: 'proxy', mdl: 'm', conf: 0.5, p: 0.25, rank: 1, cands: 8, candsSent: 12, candsLabeled: 3, prov: 'backup', probs: 'derived', ms: 900, tv: 'v9-vcf-sound', tac: 'block' } },
        /* 老归档形状（0003/0004 之前）：没有四个新键 ⇒ 必须映射成 null，不许冒 0 或 'primary' */
        { ply: 2, side: '黑方', notation: 'e7e5', ai: { ch: 'proxy', mdl: 'm', conf: 0.4, p: 0.2, rank: 1, cands: 6, ms: 800, tv: 'v9-vcf-sound' } },
      ],
    };
    const { row, moves, warnings } = mapGameRecord(payload, { gameUid: 'uid-1', dedupKey: 'dk' }, { deviceId: 'dev-1' });
    expect(warnings).toEqual([]);
    expect(row.winner).toBe('white'); // 显式字段盖过中文 result
    expect(row.end_reason).toBe('将杀');
    expect(row.end_by).toBe('human');
    expect(row.game_id).toBe('chess');
    expect(row.game).toBe('国际象棋'); // 缺 game 中文名时按 id 补
    expect(row.mode).toBe('human-ai');
    expect(row.mock).toBe(1);
    expect(row.device_id).toBe('dev-1');
    expect(row.opening_prefix).toBe('e2e4,e7e5');
    expect(moves[0]).toMatchObject({ side: 'white', channel: 'proxy', model: 'm', confidence: 0.5, prob: 0.25, rank: 1, cands: 8, ms: 900, tactics_version: 'v9-vcf-sound', tactics: 'block' });
    /* 候选点三数（C0/m13627）：新键透出，老归档形状落 null */
    expect(moves[0]).toMatchObject({ cands_sent: 12, cands_labeled: 3 });
    expect(moves[1]).toMatchObject({ cands: 6, cands_sent: null, cands_labeled: null });
    /* 上游提供方归因（C3/C2）：`ai.prov`/`ai.probs` 透出，老归档形状落 null（缺失 ≠ primary/exact） */
    expect(moves[0]).toMatchObject({ provider: 'backup', prob_source: 'derived' });
    expect(moves[1]).toMatchObject({ provider: null, prob_source: null });
  });

  it('脏输入只记 warning 不抛：无 moves / 未知棋种 / 未知 mode / 超限 payload', () => {
    const base: GamePayload = { exported: '2026-10-01T00:00:00.000Z', notation: 'x', moves: [] };
    const noMoves = mapGameRecord(base, { gameUid: 'u', dedupKey: 'd' });
    expect(noMoves.warnings.join()).toContain('moves 为空');
    expect(noMoves.warnings.join()).toContain('未知棋种');
    expect(noMoves.row.opening_prefix).toBeNull();

    const weird = mapGameRecord({ ...base, game: '飞行棋', mode: '观战', result: '???', firstWin: null }, { gameUid: 'u', dedupKey: 'd' });
    expect(weird.row.game_id).toBe('unknown');
    expect(weird.row.mode).toBeNull();
    expect(weird.row.winner).toBeNull();
    expect(weird.row.end_reason).toBeNull();
    expect(weird.row.first_win).toBeNull();
    expect(weird.warnings).toHaveLength(4);

    const huge = mapGameRecord({ ...base, moves: [], note: '中'.repeat(PAYLOAD_MAX_BYTES / 3 + 100) }, { gameUid: 'u', dedupKey: 'd' });
    expect(huge.row.payload_bytes).toBeGreaterThan(PAYLOAD_MAX_BYTES);
    expect(huge.warnings.join()).toContain('超过上限');
  });

  it('无 exported 时 day 回落到目录日期', () => {
    const { row } = mapGameRecord({ notation: 'x' }, { gameUid: 'u', dedupKey: 'd' }, { fallbackDay: '2026-09-30' });
    expect(row.day).toBe('2026-09-30');
    expect(row.created_at).toBe('');
  });
});
