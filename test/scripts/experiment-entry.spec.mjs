/**
 * test/scripts/experiment-entry.spec.mjs — scripts/experiment-worker.mjs 的
 * experiments 归档行构造（experimentEntryFrom）单测。只测纯函数，不打线上。
 *
 * 覆盖点：局级 sidesForGameSpec 黑白交替与臂口径分离、只收 status=ok 的局、
 * winner→winnerChan 映射、tag ≤64、note 标明远端来源。
 */
import { describe, it, expect } from 'vitest';
import { experimentEntryFrom } from '../../scripts/experiment-worker.mjs';
import { parseSpec, batchTag } from '../../scripts/lib/batch-common.mjs';

const plan = {
  batchId: 'ut', round: 1, tag: 'exp-20261003052604-ut-r1', origin: 'https://example.invalid',
};
const a = parseSpec('proxy:v13-pressure-gate:0');
const b = parseSpec('rapfi::500');

function summary(games) {
  return { batchId: plan.batchId, round: 1, tag: plan.tag, games };
}

describe('experimentEntryFrom', () => {
  it('臂口径：chanA/chanB/tacA/tacB/thinkA/thinkB 来自对阵双方', () => {
    const e = experimentEntryFrom(plan, a, b, summary([{ gameNo: 1, status: 'ok', winner: 'black' }]));
    expect(e.chanA).toBe('proxy');
    expect(e.chanB).toBe('rapfi');
    expect(e.tacA).toBe('v13-pressure-gate');
    expect(e.tacB).toBe('v13-pressure-gate'); // parseSpec 缺省填当前档
    expect(e.thinkA).toBe(0);
    expect(e.thinkB).toBe(500);
    expect(e.tag).toBe(plan.tag);
    expect(e.note).toMatch(/SSH 远端批量/);
  });

  it('局口径：奇数局 A 执黑、偶数局镜像（sidesForGameSpec 同源）', () => {
    const e = experimentEntryFrom(plan, a, b, summary([
      { gameNo: 1, status: 'ok', winner: 'black' },
      { gameNo: 2, status: 'ok', winner: 'white' },
    ]));
    expect(e.games[0]).toMatchObject({ no: 1, blackChan: 'proxy', whiteChan: 'rapfi', winnerChan: 'proxy' });
    expect(e.games[1]).toMatchObject({ no: 2, blackChan: 'rapfi', whiteChan: 'proxy', winnerChan: 'proxy' });
    // winner=white 在偶数局是 A 侧（proxy）：镜像下 winnerChan 取该局白方渠道
    expect(e.games[1].winnerChan).toBe('proxy');
  });

  it('和棋 winnerChan 为 null，不计错误侧', () => {
    const e = experimentEntryFrom(plan, a, b, summary([{ gameNo: 1, status: 'ok', winner: null }]));
    expect(e.games[0].winnerChan).toBeNull();
  });

  it('只收 status=ok；dry-run/skipped/error 不进 total 也不进 games', () => {
    const e = experimentEntryFrom(plan, a, b, summary([
      { gameNo: 1, status: 'ok', winner: 'black' },
      { gameNo: 2, status: 'ok-dry', winner: null },
      { gameNo: 3, status: 'skipped', from: 'ok', winner: 'black' },
      { gameNo: 4, status: 'error', error: 'x', winner: null },
    ]));
    expect(e.games).toHaveLength(1);
    expect(e.total).toBe(1);
  });

  it('战术层耗时字段为 null（worker 不统计，落样本外）', () => {
    const e = experimentEntryFrom(plan, a, b, summary([{ gameNo: 1, status: 'ok', winner: 'white' }]));
    expect(e.games[0].blackTacMs).toBeNull();
    expect(e.games[0].whiteTacMs).toBeNull();
    expect(e.games[0].blackTacN).toBe(0);
  });

  it('date 为 ISO 串（fillMissing 用它跳过回填）', () => {
    const e = experimentEntryFrom(plan, a, b, summary([{ gameNo: 1, status: 'ok', winner: 'black' }]));
    expect(Number.isNaN(Date.parse(e.date))).toBe(false);
  });

  it('真实 tag 形状（exp-…-ut-r1）≤64 字符', () => {
    const tag = batchTag(new Date('2026-10-03T05:26:04Z'), 'ut', 1);
    expect(tag).toMatch(/^exp-\d{14}-ut-r1$/);
    expect(tag.length).toBeLessThanOrEqual(64);
  });
});
