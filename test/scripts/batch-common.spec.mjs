/**
 * test/scripts/batch-common.spec.mjs — scripts/lib/batch-common.mjs 纯函数单测
 * （vitest 第 4 project「scripts」，见 vitest.config.ts；跑法 npm run test:scripts）
 */
import { describe, it, expect } from 'vitest';
import {
  KNOWN_CHANNELS,
  UPSTREAM_CHANNELS,
  TACTICS_IDS,
  DEFAULT_TACTICS,
  parseSpec,
  formatSpec,
  sanitizeBatchId,
  batchTag,
  sidesForGameSpec,
  deriveSeed,
  identityOf,
  gameRecordName,
  estimateBudget,
} from '../../scripts/lib/batch-common.mjs';

describe('parseSpec', () => {
  it('全字段：official:v13-pressure-gate:1000', () => {
    expect(parseSpec('official:v13-pressure-gate:1000'))
      .toEqual({ channel: 'official', tactics: 'v13-pressure-gate', thinkMs: 1000 });
  });

  it('rapfi 只给渠道和思考：rapfi::1000', () => {
    expect(parseSpec('rapfi::1000')).toEqual({ channel: 'rapfi', tactics: DEFAULT_TACTICS, thinkMs: 1000 });
  });

  it('只给渠道：mock → 当前档 + 0', () => {
    expect(parseSpec('mock')).toEqual({ channel: 'mock', tactics: DEFAULT_TACTICS, thinkMs: 0 });
  });

  it('未知渠道一律 throw（不做静默归一）', () => {
    expect(() => parseSpec('gpt:0')).toThrow(/未知渠道/);
    for (const ch of KNOWN_CHANNELS) {
      expect(() => parseSpec(ch)).not.toThrow();
    }
  });

  it('未知战术档 throw——这是 resolve() 静默回落 CURRENT 的唯一护栏', () => {
    expect(() => parseSpec('official:v99-nope')).toThrow(/未知战术档/);
    expect(TACTICS_IDS).toContain('v13-pressure-gate');
    expect(TACTICS_IDS).toContain('v0-off');
  });

  it('思考时长必须非负整数', () => {
    expect(() => parseSpec('rapfi::-5')).toThrow(/非负整数/);
    expect(() => parseSpec('rapfi:v0-off:abc')).toThrow(/非负整数/);
    expect(() => parseSpec('rapfi:abc')).toThrow(); // 两段时第二段按战术档校验
  });

  it('段数 >3 直接拒', () => {
    expect(() => parseSpec('a:b:c:d')).toThrow(/段数过多/);
    expect(() => parseSpec('   ')).toThrow(/不能为空/);
  });

  it('formatSpec 回环', () => {
    const cfg = parseSpec('proxy:v7-vcf:250');
    expect(formatSpec(cfg)).toBe('proxy:v7-vcf:250');
  });
});

describe('sanitizeBatchId / batchTag', () => {
  it('合法 batchId', () => {
    expect(sanitizeBatchId('ab12-x')).toBe('ab12-x');
  });
  it('非法 batchId（大写/超长/符号）', () => {
    expect(() => sanitizeBatchId('AB')).toThrow();
    expect(() => sanitizeBatchId('a'.repeat(17))).toThrow();
    expect(() => sanitizeBatchId('a b')).toThrow();
    expect(() => sanitizeBatchId('')).toThrow();
  });

  it('tag 格式 exp-YYYYMMDDHHmmss-<batch>-r<i> 且 ≤64 字符', () => {
    const tag = batchTag(new Date('2026-10-03T07:08:09Z'), 'b1', 12);
    expect(tag).toBe('exp-20261003070809-b1-r12');
    expect(tag.length).toBeLessThanOrEqual(64);
  });

  it('roundNo 必须 ≥1', () => {
    expect(() => batchTag(new Date(), 'b1', 0)).toThrow();
  });
});

describe('sidesForGameSpec（与 experiment.ts:128-138 同公式）', () => {
  it('A 奇数局执黑，1..8 与公式逐局一致', () => {
    const a = { channel: 'proxy' }, b = { channel: 'random' };
    for (let n = 1; n <= 8; n++) {
      const s = sidesForGameSpec(a, b, n);
      const aBlack = (n - 1) % 2 === 0; // experiment.ts:132
      expect(s.aBlack).toBe(aBlack);
      expect(s.black).toBe(aBlack ? a : b);
      expect(s.white).toBe(aBlack ? b : a);
    }
  });
  it('gameNo <1 拒', () => {
    expect(() => sidesForGameSpec({}, {}, 0)).toThrow();
  });
});

describe('deriveSeed / identityOf / gameRecordName', () => {
  it('同输入同输出、异局不同值、uint32 内', () => {
    const s1 = deriveSeed(20261003, 1);
    expect(deriveSeed(20261003, 1)).toBe(s1);
    expect(deriveSeed(20261003, 2)).not.toBe(s1);
    for (const n of [1, 5, 12]) {
      const v = deriveSeed(20261003, n);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(2 ** 32);
    }
  });

  it('身份口径 channel|tactics|thinkMs', () => {
    expect(identityOf({ channel: 'rapfi', tactics: 'v0-off', thinkMs: 1000 })).toBe('rapfi|v0-off|1000');
    expect(identityOf({ channel: 'proxy', tactics: DEFAULT_TACTICS, thinkMs: 0 }))
      .toBe(`proxy|${DEFAULT_TACTICS}|0`);
  });

  it('文件名带轮次和局号', () => {
    expect(gameRecordName(3, 7)).toBe('round-3-game-7.json');
  });
});

describe('estimateBudget', () => {
  it('mock/mock 零上游调用', () => {
    const r = estimateBudget(parseSpec('mock'), parseSpec('mock'), 12, 1, 30);
    expect(r.jevCallsPerMin).toBe(0);
    expect(r.jevCallsPerGame).toBe(0);
    expect(r.writesPerDay).toBe((1 + 30) * 12);
  });

  it('双上游臂估出每分钟调用数且写配额 = (1+手数)×局数', () => {
    const r = estimateBudget(parseSpec('official'), parseSpec('official'), 12, 1, 30);
    expect(r.jevCallsPerMin).toBeGreaterThan(0);
    expect(r.jevCallsPerGame).toBe(30); // 30 手/局 ÷ 2 侧 × 2 臂
    expect(r.writesPerDay).toBe(372);
  });

  it('UPSTREAM_CHANNELS 口径', () => {
    expect(UPSTREAM_CHANNELS).toEqual(['official', 'openrouter', 'proxy']);
  });
});
