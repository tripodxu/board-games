/**
 * test/scripts/experiment-entry.spec.mjs — scripts/experiment-worker.mjs 的
 * experiments 归档行构造（experimentEntryFrom）与 checkpoint 命中判定（ckptAction）单测。
 * 只测纯函数，不打线上。
 *
 * 覆盖点：局级 sidesForGameSpec 黑白交替与臂口径分离、ok/skipped 计入而 dry-run/error 不计、
 * 战术档只写会跑战术层的渠道（rapfi/mock 侧留空）、思考档只写 rapfi 侧、
 * 逐手提供方归属（非上游侧不计入）、winner→winnerChan 映射、续跑按 tag 失配重跑、
 * pending 复用 gameUid、tag ≤64、note 标明远端来源。
 */
import { describe, it, expect } from 'vitest';
import { experimentEntryFrom, ckptAction, DEVICE_ID, countProvider, formatProviderCounts } from '../../scripts/experiment-worker.mjs';
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
    // rapfi 侧不跑战术层（client.ts 直接短路）⇒ 档位必须留空，否则是 `rapfi|v13-…` 幻影身份
    expect(e.tacB).toBeNull();
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

  it('局级战术档/思考档按渠道闸门写：proxy 写档、rapfi 留空（思考档反向）', () => {
    const e = experimentEntryFrom(plan, a, b, summary([
      { gameNo: 1, status: 'ok', winner: 'black' },
      { gameNo: 2, status: 'ok', winner: 'white' },
    ]));
    expect(e.games[0]).toMatchObject({
      blackTac: 'v13-pressure-gate', whiteTac: null, blackThink: null, whiteThink: 500,
    });
    expect(e.games[1]).toMatchObject({
      blackTac: null, whiteTac: 'v13-pressure-gate', blackThink: 500, whiteThink: null,
    });
  });

  it('和棋 winnerChan 为 null，不计错误侧', () => {
    const e = experimentEntryFrom(plan, a, b, summary([{ gameNo: 1, status: 'ok', winner: null }]));
    expect(e.games[0].winnerChan).toBeNull();
  });

  it('ok 与 skipped 都计入；dry-run/error 不进 total 也不进 games', () => {
    const e = experimentEntryFrom(plan, a, b, summary([
      { gameNo: 1, status: 'ok', winner: 'black' },
      { gameNo: 2, status: 'ok-dry', winner: null },
      { gameNo: 3, status: 'skipped', from: 'ok', winner: 'white', plies: 42 },
      { gameNo: 4, status: 'error', error: 'x', winner: null },
    ]));
    expect(e.games.map((g) => g.no)).toEqual([1, 3]);
    expect(e.total).toBe(2);
  });

  it('续跑跳过的局仍带胜负：不做只会让实验档案凭空少一局（旧 bug）', () => {
    const e = experimentEntryFrom(plan, a, b, summary([
      { gameNo: 1, status: 'skipped', from: 'ok', winner: 'white', plies: 60 },
    ]));
    expect(e.total).toBe(1);
    // 第 1 局 A(proxy) 执黑、B(rapfi) 执白 ⇒ winner=white 即 rapfi
    expect(e.games[0].winnerChan).toBe('rapfi');
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

  it('远端批量的匿名设备 id 合法（D1 里靠它把这批机器跑的行与浏览器轮分开）', () => {
    // 值域来自 src/worker/lib/validate.ts 的 DEVICE_ID_RE
    expect(DEVICE_ID).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('真实 tag 形状（exp-…-ut-r1）≤64 字符', () => {
    const tag = batchTag(new Date('2026-10-03T05:26:04Z'), 'ut', 1);
    expect(tag).toMatch(/^exp-\d{14}-ut-r1$/);
    expect(tag.length).toBeLessThanOrEqual(64);
  });
});

describe('countProvider / formatProviderCounts（C2 逐手归属）', () => {
  it('只认非空字符串；非上游侧（rapfi/mock/人类、老归档）不计入', () => {
    const c = {};
    countProvider(c, 'primary');
    countProvider(c, 'backup');
    countProvider(c, 'backup');
    countProvider(c, undefined);
    countProvider(c, null);
    countProvider(c, '');
    // box 实测（c2fb）：整行曾混进 `unknown:18`（rapfi 侧的手），报表读不出兜底了几手
    expect(c).toEqual({ primary: 1, backup: 2 });
    expect(Object.keys(c)).not.toContain('unknown');
  });

  it('摘要按手数降序、只列见过的提供方；空表返回空串', () => {
    expect(formatProviderCounts({ backup: 19, primary: 2 })).toBe('backup:19 primary:2');
    expect(formatProviderCounts({})).toBe('');
    expect(formatProviderCounts(null)).toBe('');
  });
});

describe('ckptAction（续跑判定）', () => {
  it('没有 checkpoint / 状态异常 ⇒ 直接跑', () => {
    expect(ckptAction(undefined, plan.tag)).toEqual({ action: 'run' });
    expect(ckptAction({ status: 'error' }, plan.tag)).toEqual({ action: 'run' });
  });

  it('已完成（ok/ok-dry）⇒ 跳过并带回 winner/plies/gameUid', () => {
    expect(ckptAction({ tag: plan.tag, status: 'ok', winner: 'black', plies: 33, gameUid: 'u1' }, plan.tag))
      .toEqual({ action: 'skip', from: 'ok', winner: 'black', plies: 33, gameUid: 'u1' });
    expect(ckptAction({ tag: plan.tag, status: 'ok-dry', winner: null }, plan.tag))
      .toMatchObject({ action: 'skip', from: 'ok-dry', winner: null, plies: null });
  });

  it('tag 失配 ⇒ 重跑（同名 batch 换了轮次，不能一局不跑就 exit 0）', () => {
    expect(ckptAction({ tag: 'exp-20261003000000-ut-r1', status: 'ok', winner: 'black' }, plan.tag))
      .toEqual({ action: 'run', reason: 'tag-mismatch' });
  });

  it('pending（归档中途被杀）⇒ 复用同一 gameUid 重跑，避免 D1 里两份棋谱', () => {
    expect(ckptAction({ tag: plan.tag, status: 'pending', gameUid: 'u9' }, plan.tag))
      .toEqual({ action: 'run', resumeUid: 'u9' });
    // pending 但没记 uid（老 checkpoint）⇒ 只能当新局重跑
    expect(ckptAction({ tag: plan.tag, status: 'pending' }, plan.tag)).toEqual({ action: 'run' });
  });
});
