// ladder.spec.mjs — P6 阶梯编排纯逻辑 + CLI
//
// 测什么：身份口径（rapfi/mock 的战术档留空、思考档只认 rapfi —— 与归档导出口径一致）、
// round-robin/笛卡尔积的**对数**（L1=10 / L2=15 / L3=3(+1)）、偶数局数的颜色对称闸门、
// 计划的字段（tag/outDir/openings 逐项可对齐）、断点状态（本地 ok + 远端行数双条件）、
// ETA 与一行汇总的文本形状、CLI 的四道闸门与 W/D/L 统计口径。
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LADDER_VERSION, PRESETS, VERSION_SPECS, RAPFI_SPECS, RAPFI_5000, RAPFI_HIGH_SPECS, L3_EXTRA_5000,
  identityOfSpec, pairKey, roundRobin, crossPairs, pairsForPreset, pairsForAll,
  parseIdentityList, normalizeGames, buildLadder, roundLabel, formatRoundLine, formatLadderTable,
  newLadderState, applyRoundResult, resumeDecisions, summarizeLadder, formatLadderProgress, stateMatchesLadder, withReusedTags, staleCleanups,
  ladderDir, stateFile, planFile, readLadderState, writeLadderState, writePlans,
  estimateRoundSeconds, parsePollOutput, formatPollTick, retrySync, sleepSync, launchRoundCommand, pollRoundCommand,
} from '../../scripts/lib/ladder.mjs';
import { ETA_SAMPLES } from '../../scripts/lib/progress.mjs';
import { ladderMain, wdlOfGamesJsonl } from '../../scripts/experiment-ladder.mjs';

const NOW = new Date('2026-10-04T12:00:00Z');
const okRound = (round, games, w = { w: 1, d: 0, l: 1 }) => ({
  round, label: `r${round}`, games, tag: `t${round}`, status: 'ok', wdl: w,
  durationMs: 60000, error: null, at: NOW.toISOString(), remoteLines: games,
});

describe('身份口径（与归档导出口径一致）', () => {
  it('rapfi/mock 的战术档写空串、思考档只认 rapfi', () => {
    expect(identityOfSpec('rapfi:v14-live3-fresh:500').id).toBe('rapfi||500');
    expect(identityOfSpec('rapfi:v10-live3:1000').id).toBe('rapfi||1000'); // 战术档只是占位
    expect(identityOfSpec('mock:v14-live3-fresh:0').id).toBe('mock||0');
    expect(identityOfSpec('rapfi:v14-live3-fresh').id).toBe('rapfi||0'); // 没写思考档 = 0
  });
  it('会跑战术层的渠道保留战术档；非 rapfi 的思考档丢弃（不造「0 毫秒档」幻影身份）', () => {
    expect(identityOfSpec('official:v13-pressure-gate:0').id).toBe('official|v13-pressure-gate|0');
    expect(identityOfSpec('official:v13-pressure-gate:2000').id).toBe('official|v13-pressure-gate|0');
    expect(identityOfSpec('proxy:v14-live3-fresh:1000').id).toBe('proxy|v14-live3-fresh|0');
  });
  it('pairKey 无向：A vs B 与 B vs A 同键', () => {
    expect(pairKey('rapfi::500', 'rapfi::1000')).toBe(pairKey('rapfi::1000', 'rapfi::500'));
  });
});

describe('round-robin / 笛卡尔积', () => {
  it('3 个身份 ⇒ 3 对；4 个 ⇒ 6 对；顺序确定', () => {
    const three = roundRobin(['rapfi::500', 'rapfi::1000', 'rapfi::2000']);
    // key 是去重用的规范化串（字典序，故 1000 排在 500 前）；label 与输入顺序一致，给人看。
    expect(three.map((p) => p.key)).toEqual([
      'rapfi||1000 vs rapfi||500', 'rapfi||2000 vs rapfi||500', 'rapfi||1000 vs rapfi||2000',
    ]);
    expect(three.map((p) => roundLabel(p))).toEqual([
      'rapfi||500 vs rapfi||1000', 'rapfi||500 vs rapfi||2000', 'rapfi||1000 vs rapfi||2000',
    ]);
    expect(roundRobin(['rapfi::500', 'rapfi::1000', 'rapfi::2000', 'rapfi::5000']).length).toBe(6);
  });
  it('同一身份不自己打自己，重复身份不重复排', () => {
    expect(roundRobin(['rapfi::500', 'rapfi::500']).length).toBe(0);
    const withDup = roundRobin(['rapfi::500', 'rapfi::1000', 'rapfi::500']);
    expect(withDup.length).toBe(1);
  });
  it('extras 追加且按 pairKey 去重；格式错要抛', () => {
    const pairs = roundRobin(['rapfi::500', 'rapfi::1000'], {
      extras: [['rapfi::500', 'rapfi::5000'], ['rapfi::5000', 'rapfi::500']],
    });
    expect(pairs.length).toBe(2); // 500vs1000 + extras 里的 500vs5000（两条 extras 是同一对）
    expect(pairs.map((p) => p.key)).toContain('rapfi||500 vs rapfi||5000');
    expect(() => roundRobin(['rapfi::500', 'rapfi::1000'], { extras: [['rapfi::500']] })).toThrow(/extras/);
  });
  it('少于两个身份直接抛（阶梯不是单机自测）', () => {
    expect(() => roundRobin(['rapfi::500'])).toThrow(/至少要 2 个身份/);
  });
  it('crossPairs 是笛卡尔积（L2 的形状）', () => {
    const pairs = crossPairs(VERSION_SPECS.slice(0, 2), RAPFI_SPECS);
    expect(pairs.length).toBe(6);
    expect(pairs[0].key).toBe('official|v10-live3|0 vs rapfi||500');
  });
  it('预设对数：L1=10 / L2=15 / L3=3（+1 加档）/ L4=10（高思考档）/ all=38', () => {
    expect(pairsForPreset('L1').pairs.length).toBe(10);
    expect(pairsForPreset('L2').pairs.length).toBe(15);
    expect(pairsForPreset('L3').pairs.length).toBe(3);
    expect(pairsForPreset('L3', { with5000: true }).pairs.length).toBe(4);
    expect(pairsForPreset('L3', { with5000: true }).pairs.at(-1).key)
      .toBe(pairKey(RAPFI_5000, L3_EXTRA_5000[1]));
    expect(pairsForPreset('L4').pairs.length).toBe(10);
    expect(pairsForAll().pairs.length).toBe(10 + 15 + 3 + 10);
    expect(pairsForAll({ with5000: true }).pairs.length).toBe(10 + 15 + 4 + 10);
    expect(() => pairsForPreset('L9')).toThrow(/未知阶梯预设/);
  });
  it('L4 = L2 的形状换高思考档：只列 L2 没有的档（7000/10000），不含版本内战与 rapfi 内战', () => {
    const { pairs, title } = pairsForPreset('L4');
    expect(title).toContain('7000/10000');
    const rungs = new Set();
    const versions = new Set();
    for (const p of pairs) {
      const a = identityOfSpec(p.a);
      const b = identityOfSpec(p.b);
      expect([a.channel, b.channel].sort().join(',')).toBe('official,rapfi'); // 一版一 rapfi，绝不同渠道内战
      expect(a.id).toMatch(/^official\|v/);
      expect(a.tactics).not.toBe(''); // 上游臂带战术档
      expect(b.tactics).toBe(''); // rapfi 不过战术层 ⇒ 战术档留空（口径见文件头）
      const rung = a.channel === 'rapfi' ? a.think : b.think;
      expect(rung).toBeGreaterThanOrEqual(7000);
      versions.add(a.channel === 'official' ? a.id : b.id);
      rungs.add(a.channel === 'rapfi' ? a.id : b.id);
    }
    expect(versions.size).toBe(5); // 5 个版本都上
    // 右臂恰好是两档，且都 ≥7000（L2 已覆盖 500/1000/2000，不重复跑）
    expect([...rungs].sort()).toEqual(['rapfi||10000', 'rapfi||7000']);
    expect(RAPFI_HIGH_SPECS.every((s) => Number(s.split(':')[2]) >= 7000)).toBe(true);
    // 与 L2 的右臂不重叠 ⇒ 合并两批数据时不会出现「同一对同一档跑两遍」
    const l2Rungs = new Set(RAPFI_SPECS.map((s) => identityOfSpec(s).id));
    for (const id of rungs) expect(l2Rungs.has(id)).toBe(false);
  });
  it('L2 不含版本内战、不含 rapfi 内战（它是积，不是 8 个身份的 round-robin）', () => {
    for (const p of pairsForPreset('L2').pairs) {
      const a = identityOfSpec(p.a).channel;
      const b = identityOfSpec(p.b).channel;
      expect([a, b].sort().join('/')).toBe('official/rapfi');
    }
  });
  it('预设常量自洽：5 版 + 3 档', () => {
    expect(VERSION_SPECS.length).toBe(5);
    expect(RAPFI_SPECS.length).toBe(3);
    expect(Object.keys(PRESETS)).toEqual(['L1', 'L2', 'L3', 'L4']);
  });
});

describe('parseIdentityList / normalizeGames', () => {
  it('逗号分隔、去空、去重保序；少于两个抛', () => {
    expect(parseIdentityList(' rapfi::500 , rapfi::1000 ,, rapfi::500 ')).toEqual(['rapfi::500', 'rapfi::1000']);
    expect(() => parseIdentityList('rapfi::500')).toThrow(/至少两个/);
  });
  it('奇数局数必须拒绝（颜色/开局都不再配对）', () => {
    expect(normalizeGames(20)).toBe(20);
    expect(() => normalizeGames(5)).toThrow(/必须是偶数/);
    expect(normalizeGames(5, { allowOdd: true })).toBe(5); // 显式放行的临时跑动
    expect(() => normalizeGames(1)).toThrow(/≥2/);
    expect(() => normalizeGames('abc')).toThrow(/≥2/);
  });
});

describe('buildLadder', () => {
  const build = (over = {}) => buildLadder({
    ladderId: 'lad1', specs: RAPFI_SPECS, games: 4, now: NOW, seed: 7, ...over,
  });

  it('每轮计划逐项可对齐（tag/outDir/开局/运行面/局数）', () => {
    const lad = build({ openings: '/root/ladder/openings.json' });
    expect(lad.version).toBe(LADDER_VERSION);
    expect(lad.rounds.length).toBe(3);
    expect(lad.totalGames).toBe(12);
    const r1 = lad.rounds[0];
    expect(r1.round).toBe(1);
    expect(r1.label).toBe('rapfi||500 vs rapfi||1000');
    expect(r1.plan).toMatchObject({
      batchId: 'lad1', round: 1, games: 4, a: 'rapfi:v14-live3-fresh:500', b: 'rapfi:v14-live3-fresh:1000',
      store: 'local', upstream: 'direct', rateLimit: 30, keyFile: '/root/.jev-key',
      openings: '/root/ladder/openings.json', dryRun: false,
      outDir: '/root/board-games/.work/remote/lad1/round-1',
    });
    expect(r1.plan.tag).toBe('exp-20261004120000-lad1-r1');
    expect(lad.rounds[1].plan.tag).toBe('exp-20261004120000-lad1-r2');
  });
  it('要求显式 now（tag 要可复现）、batchId 要合法、局数要偶数', () => {
    expect(() => buildLadder({ ladderId: 'lad1', specs: RAPFI_SPECS, games: 4, seed: 1 })).toThrow(/显式 now/);
    expect(() => build({ ladderId: 'Bad Id' })).toThrow(/batchId 需匹配/);
    expect(() => build({ games: 3 })).toThrow(/必须是偶数/);
    expect(build({ games: 3, allowOdd: true }).gamesPerPair).toBe(3); // 显式放行的临时跑动
  });
  it('接受预计算的 pairs（预设路径）并保留顺序', () => {
    const { pairs } = pairsForPreset('L3', { with5000: true });
    const lad = build({ pairs });
    expect(lad.rounds.length).toBe(4);
    expect(lad.rounds.at(-1).label).toBe('rapfi||5000 vs rapfi||1000'); // label 按 extras 的书写顺序
  });
  it('身份重复到没有对决 ⇒ 抛', () => {
    expect(() => build({ specs: ['rapfi::500', 'rapfi::500'] })).toThrow(/没有任何对决/);
  });
});

describe('汇总文本', () => {
  it('一行轮次汇总：编号/标记/对阵/局数/W-D-L/时长', () => {
    const round = { round: 2, label: 'a|x|0 vs b|y|0', games: 20 };
    expect(formatRoundLine(round, { status: 'ok', wdl: { w: 8, d: 4, l: 8 }, durationMs: 2520000 }))
      .toBe('[2] ✅ a|x|0 vs b|y|0 20 局 W8-D4-L8 2520s');
    expect(formatRoundLine(round, { status: 'failed', error: 'ssh 断了' })).toContain('❌');
    expect(formatRoundLine(round, { status: 'failed', error: 'ssh 断了' })).toContain('ssh 断了');
  });
  it('dry-run 表格每轮一行，列为 # / 对阵 / 局数 / 开局 / 预计', () => {
    const lad = buildLadder({ ladderId: 'lad1', specs: RAPFI_SPECS, games: 20, now: NOW, seed: 1 });
    const table = formatLadderTable(lad.rounds, { avgGameS: 300 });
    expect(table[0]).toBe('| # | 对阵 | 局数 | 开局 | 预计 |');
    expect(table.length).toBe(2 + 3);
    expect(table[2]).toContain('| 1 | rapfi||500 vs rapfi||1000 | 20 | （不用开局库） | ≈100m |');
  });
  it('预计墙钟：纯 rapfi 轮 ≈ Σthink/2，含上游臂的轮按 1.1 s/手', () => {
    // 纯 rapfi：每手只有执子那一侧思考 ⇒ 每手 ≈ (500+1000)/2 ms。
    expect(estimateRoundSeconds({ a: 'rapfi::500', b: 'rapfi::1000', games: 20 })).toBe(960);
    expect(estimateRoundSeconds({ a: 'rapfi::500', b: 'rapfi::1000', games: 20 }))
      .toBeLessThan(estimateRoundSeconds({ a: 'rapfi::1000', b: 'rapfi::2000', games: 20 }));
    // 上游臂：1.1 s/手 + rapfi 那侧 think/2（60 手/局）。
    expect(estimateRoundSeconds({ a: 'official:v14-live3-fresh:0', b: 'rapfi::1000', games: 20 })).toBe(1980);
    expect(formatLadderTable([{ round: 1, label: 'x', games: 20, openings: null }], { estimateOf: (r) => estimateRoundSeconds(r) })[2])
      .toContain('≈');
  });
  it('本地轮询的一次性回值：alive/done + progress.json 原文（坏 JSON 当没有）', () => {
    expect(parsePollOutput('done\n')).toEqual({ alive: false, done: true, progress: null });
    expect(parsePollOutput('alive')).toEqual({ alive: true, done: false, progress: null });
    expect(parsePollOutput('')).toEqual({ alive: false, done: false, progress: null });
    const p = parsePollOutput('alive\n{"done":7,"total":20,"elapsedS":215,"meanGameS":30,"wdl":{"w":4,"d":0,"l":3}}');
    expect(p.alive).toBe(true);
    expect(p.progress).toMatchObject({ done: 7, total: 20 });
    expect(parsePollOutput('alive\n{半截').progress).toBeNull();
    expect(parsePollOutput('done\nnot json').progress).toBeNull();
  });
  it('逐分钟进度行：有 progress 就打 done/total + 秒 + 近 N 局均时 + W-D-L，没有也说话', () => {
    expect(formatPollTick(2, { done: 7, total: 20, elapsedS: 215, meanGameS: 30, wdl: { w: 4, d: 0, l: 3 } }))
      .toBe('  ⏳ round-2 7/20 局 · 215s · 近5局均 30s/局 · W4-D0-L3');
    /* 标签必须点明窗口：`meanGameS` 只取最近 ETA_SAMPLES 局，读成整轮均时会算出错误的 ETA。 */
    expect(ETA_SAMPLES).toBe(5);
    expect(formatPollTick(2, { done: 1, total: 20 })).toBe('  ⏳ round-2 1/20 局');
    expect(formatPollTick(2, null)).toContain('还没写 progress.json');
    // 本地墙钟优先于远端自报（远端 elapsedS 是它自己的计时，重启会归零）
    expect(formatPollTick(1, { done: 1, total: 2, elapsedS: 5 }, { elapsedS: 65 })).toContain('65s');
  });
});

// L2 那一晚的真实教训：box 的链路会间歇性抽风（scp exit=1 且无 stderr），
// 一次抖动掐死了两次续跑；而 ssh 那几处失败不报错只回退，回退的后果更坏。
describe('retrySync（链路抖动的重试）', () => {
  const spinner = () => {
    const slept = [];
    const tries = [];
    return { slept, tries, sleep: (ms) => slept.push(ms) };
  };

  it('第一次就成功 ⇒ 不睡、只用 1 次', () => {
    const s = spinner();
    const res = retrySync(() => { s.tries.push(1); return true; }, { sleep: s.sleep, attempts: 3, sleepMs: 2000 });
    expect(res).toEqual({ ok: true, attempts: 1 });
    expect(s.tries.length).toBe(1);
    expect(s.slept).toEqual([]);
  });

  it('第三次才成功 ⇒ attempts=3、睡了两次（每次 2s）、onRetry 两次', () => {
    const s = spinner();
    const retried = [];
    const res = retrySync(() => { s.tries.push(1); return s.tries.length >= 3; },
      { sleep: s.sleep, attempts: 3, sleepMs: 2000, onRetry: (i) => retried.push(i) });
    expect(res).toEqual({ ok: true, attempts: 3 });
    expect(s.slept).toEqual([2000, 2000]);
    expect(retried).toEqual([1, 2]);
  });

  it('一直失败 ⇒ ok=false、次数用满、不再多睡', () => {
    const s = spinner();
    const res = retrySync(() => false, { sleep: s.sleep, attempts: 3, sleepMs: 5 });
    expect(res).toEqual({ ok: false, attempts: 3 });
    expect(s.slept).toEqual([5, 5]);
  });

  it('返回 undefined 算成功（回调式「没抛就是成」），抛错算失败', () => {
    const s = spinner();
    expect(retrySync(() => {}, { sleep: s.sleep }).ok).toBe(true);
    let n = 0;
    const res = retrySync(() => { n++; if (n < 2) throw new Error('boom'); return true; }, { sleep: s.sleep, attempts: 2 });
    expect(res).toEqual({ ok: true, attempts: 2 });
  });

  it('attempts=1 ⇒ 只试一次（pollRound 那种「失败就认」的调用可以关掉重试）', () => {
    const s = spinner();
    expect(retrySync(() => false, { attempts: 1, sleep: s.sleep })).toEqual({ ok: false, attempts: 1 });
    expect(s.slept).toEqual([]);
  });

  it('sleepSync 真会阻塞指定的毫秒数（注入用的替身别把这条测掉）', () => {
    const t0 = Date.now();
    sleepSync(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
});

describe('launchRoundCommand（同一轮不许被两个 worker 双写）', () => {
  const cmd = () => launchRoundCommand({
    repo: '/root/board-games',
    keyFile: '/root/.jev-key',
    planPath: '/root/board-games/.work/remote/x1/plans/round-2.json',
    logPath: '/root/board-games/.work/remote/x1/logs/round-2.log',
    pidPath: '/root/board-games/.work/remote/x1/logs/round-2.pid',
  });

  it('pid 还活着就只回一句「已在跑」，不再起第二个 worker', () => {
    const c = cmd();
    expect(c).toMatch(/\[ -f .*round-2\.pid \] && kill -0 "\$\(cat .*round-2\.pid\)"/);
    expect(c).toContain('已在跑，不重复起');
    // 守卫必须在**远端**判断：本地查完再起，中间还隔着一次 ssh 握手，窗口关不掉
    expect(c.indexOf('kill -0')).toBeLessThan(c.indexOf('nohup'));
  });

  it('否则 nohup 起 worker、日志与 pid 都落在远端同一处', () => {
    const c = cmd();
    expect(c).toContain('nohup node scripts/experiment-worker.mjs --plan /root/board-games/.work/remote/x1/plans/round-2.json');
    expect(c).toContain('>> /root/board-games/.work/remote/x1/logs/round-2.log 2>&1 < /dev/null &');
    expect(c).toContain('echo $! > /root/board-games/.work/remote/x1/logs/round-2.pid');
    expect(c).toMatch(/fi$/);
  });

  it('key 仍然是运行时 source 进来的（不进仓库/日志/argv）', () => {
    const c = cmd();
    expect(c).toContain('set -a; [ -f /root/.jev-key ] && . /root/.jev-key; set +a;');
    expect(c).not.toMatch(/JEV_API_KEY=/);
  });
});

describe('pollRoundCommand（本地每分钟一次短 ssh，不是远端守 12 h）', () => {
  const c = pollRoundCommand({
    pidPath: '/root/board-games/.work/remote/x1/logs/round-3.pid',
    progressPath: '/root/board-games/.work/remote/x1/round-3/progress.json',
  });

  it('先报 alive/done（pid 文件不在也算 done），再吐 progress.json 原文', () => {
    expect(c).toContain('pid=$(cat /root/board-games/.work/remote/x1/logs/round-3.pid 2>/dev/null)');
    expect(c).toContain('kill -0 "$pid"');
    expect(c).toContain('then echo alive; else echo done; fi');
    expect(c.trimEnd().endsWith('cat /root/board-games/.work/remote/x1/round-3/progress.json 2>/dev/null')).toBe(true);
  });

  it('没有 for/seq/sleep —— 长命 ssh 继承 stdout 管道就是那次「作业永不结束」的根因', () => {
    expect(c).not.toMatch(/for i in|seq 1|sleep \d/);
  });

  it('输出能被 parsePollOutput 直接解（两个工具共用同一条探针）', () => {
    const out = 'alive\n' + JSON.stringify({ total: 20, done: 4, gameNo: 5, ply: 12, wdl: { a: 3, draw: 0, b: 1 } });
    const p = parsePollOutput(out);
    expect(p.done).toBe(false);
    expect(p.alive).toBe(true);
    expect(p.progress.done).toBe(4);
  });
});

describe('断点状态', () => {
  const lad = buildLadder({ ladderId: 'lad1', specs: RAPFI_SPECS, games: 4, now: NOW, seed: 1 });

  it('初始全 pending；应用结果后按轮号排序、字段保留', () => {
    let st = newLadderState(lad);
    expect(st.rounds.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
    st = applyRoundResult(st, lad.rounds[1], { status: 'ok', wdl: { w: 2, d: 0, l: 2 }, durationMs: 1000, remoteLines: 4 }, { now: NOW });
    const r2 = st.rounds.find((r) => r.round === 2);
    expect(r2.status).toBe('ok');
    expect(r2.wdl).toEqual({ w: 2, d: 0, l: 2 });
    expect(r2.remoteLines).toBe(4);
    expect(st.updatedAt).toBe(NOW.toISOString());
  });
  it('跳过条件以「远端产物行数 ≥ 局数」为准，本地状态只记账', () => {
    let st = newLadderState(lad);
    st = applyRoundResult(st, lad.rounds[0], { status: 'ok', wdl: { w: 1, d: 0, l: 1 }, remoteLines: 4 }, { now: NOW });
    // 远端行数够 ⇒ 跳过
    expect(resumeDecisions(st, { remoteLines: { 1: 4 } })[0]).toMatchObject({ skip: true, reason: 'ok' });
    // 远端只有 2 行 ⇒ 不能跳过（静默丢数据）
    expect(resumeDecisions(st, { remoteLines: { 1: 2 } })[0]).toMatchObject({ skip: false });
    expect(resumeDecisions(st, { remoteLines: { 1: 2 } })[0].reason).toMatch(/远端只有 2\/4 局/);
    // 远端行数未知 ⇒ 保守重跑
    expect(resumeDecisions(st, { remoteLines: {} })[0]).toMatchObject({ skip: false, reason: /行数未知/ });
    // --force 全跑
    expect(resumeDecisions(st, { force: true, remoteLines: { 1: 4 } })[0]).toMatchObject({ skip: false, reason: 'forced' });
    // 本地没记账但远端已经跑完（状态文件丢了/形状换了）⇒ 照样跳过，产物由调用方补拉
    expect(resumeDecisions(st, { remoteLines: { 2: 4 } })[1])
      .toMatchObject({ skip: true, reason: '远端已有 4/4 局' });
    // 本地 pending 且远端也只有一半 ⇒ 跑
    expect(resumeDecisions(st, { remoteLines: { 2: 1 } })[1]).toMatchObject({ skip: false, reason: /远端只有 1\/4 局/ });
  });
  it('续跑沿用旧 tag（checkpoint 按 tag 命中），--force 走新 tag', () => {
    const fresh = buildLadder({ ladderId: 'lad1', pairs: roundRobin(['rapfi::500', 'rapfi::1000']), games: 4, now: NOW });
    // 没有旧状态、也没有远端 plan ⇒ 不变
    expect(withReusedTags(fresh, null, {}).rounds[0].tag).toBe(fresh.rounds[0].tag);
    // 本地状态里有旧 tag ⇒ 沿用，且 plan 里的 tag 一并改掉（worker 读的是 plan）
    const oldState = { rounds: [{ round: 1, tag: 'exp-20261004010000-lad1-r1' }] };
    const reused = withReusedTags(fresh, oldState, {});
    expect(reused.rounds[0].tag).toBe('exp-20261004010000-lad1-r1');
    expect(reused.rounds[0].plan.tag).toBe('exp-20261004010000-lad1-r1');
    expect(reused.rounds[0].plan.outDir).toBe(fresh.rounds[0].plan.outDir); // 别的字段不动
    // 本地状态没了但远端 plan 还在 ⇒ 用远端的
    expect(withReusedTags(fresh, null, { 1: 'exp-20261004020000-lad1-r1' }).rounds[0].tag)
      .toBe('exp-20261004020000-lad1-r1');
  });
  it('tag 变了才把旧产物挪开（staleCleanups），挪开的名字不会被 round-* 扫到', () => {
    const l = buildLadder({ ladderId: 'lad1', pairs: roundRobin(['rapfi::500', 'rapfi::1000']), games: 4, now: NOW });
    const tag = l.rounds[0].tag;
    // 同 tag + 有行数 ⇒ 不动（checkpoint 会命中，动了等于丢数据）
    expect(staleCleanups(l, { 1: tag }, { remoteLines: { 1: 2 } })).toEqual([]);
    // 行数为 0 ⇒ 不动
    expect(staleCleanups(l, { 1: 'exp-old' }, { remoteLines: { 1: 0 } })).toEqual([]);
    // 跳过的轮 ⇒ 不动
    expect(staleCleanups(l, { 1: 'exp-old' }, { remoteLines: { 1: 4 }, skipRounds: [1] })).toEqual([]);
    // 旧 tag 未知 ⇒ 不动（可能是同 tag，只是没记下来）
    expect(staleCleanups(l, {}, { remoteLines: { 1: 4 } })).toEqual([]);
    // 旧 tag 不同 + 有行数 ⇒ 挪开
    const out = staleCleanups(l, { 1: 'exp-20261004020000-lad1-r1' }, { remoteLines: { 1: 4 } });
    expect(out).toEqual([{ round: 1, oldTag: 'exp-20261004020000-lad1-r1', stale: 'stale-round-1-exp-20261004020000-lad1-r1' }]);
    expect(out[0].stale.startsWith('round-')).toBe(false); // 不能被 remoteLineCounts 的 round-* 通配扫到
  });
  it('applyRoundResult 把状态里的 tag 更新成本轮实际用的（--force 换 tag 后不会又「沿用旧 tag」）', () => {
    const l = buildLadder({ ladderId: 'lad1', pairs: roundRobin(['rapfi::500', 'rapfi::1000']), games: 4, now: NOW });
    const st = newLadderState(l);
    const forced = { ...l.rounds[0], tag: 'exp-forced-new' };
    const after = applyRoundResult(st, forced, { status: 'ok', durationMs: 1 }, { now: NOW });
    expect(after.rounds[0].tag).toBe('exp-forced-new');
  });
  it('本地状态与计划形状不符时重建（stateMatchesLadder）', () => {
    const st = newLadderState(lad);
    expect(stateMatchesLadder(st, lad)).toBe(true);
    expect(stateMatchesLadder(null, lad)).toBe(false);
    expect(stateMatchesLadder(st, { rounds: lad.rounds.slice(0, 1) })).toBe(false);
    const reshaped = { ...lad, rounds: lad.rounds.map((r, i) => (i === 0 ? { ...r, games: r.games * 2 } : r)) };
    expect(stateMatchesLadder(st, reshaped)).toBe(false);
    const relabeled = { ...lad, rounds: lad.rounds.map((r, i) => (i === 0 ? { ...r, label: '别的对阵' } : r)) };
    expect(stateMatchesLadder(st, relabeled)).toBe(false);
  });
  it('汇总：done/failed/games/W-D-L/ETA（不足样本给 null）', () => {
    let st = newLadderState(lad);
    expect(summarizeLadder(st, { nowMs: NOW.getTime() }).etaS).toBeNull();
    st = applyRoundResult(st, lad.rounds[0], { status: 'ok', wdl: { w: 2, d: 1, l: 1 }, durationMs: 120000, remoteLines: 4 }, { now: NOW });
    st = applyRoundResult(st, lad.rounds[1], { status: 'failed', error: 'ssh' }, { now: NOW });
    const s = summarizeLadder(st, { nowMs: NOW.getTime() });
    expect(s).toMatchObject({ total: 3, done: 1, failed: 1, pending: 1, gamesDone: 4, gamesTotal: 12 });
    expect(s.wdl).toEqual({ w: 2, d: 1, l: 1 });
    expect(s.meanRoundS).toBe(120);
    expect(s.etaS).toBe(240); // 还剩 2 轮 × 120s
    st = applyRoundResult(st, lad.rounds[2], { status: 'ok', wdl: { w: 0, d: 0, l: 4 }, durationMs: 60000, remoteLines: 4 }, { now: NOW });
    // 还剩 1 轮要跑 —— 失败的那轮也算「还没跑完」（要重跑），故 ETA = 已完成轮均时 90s × 1。
    const done = summarizeLadder(st, { nowMs: NOW.getTime() });
    expect(done).toMatchObject({ done: 2, failed: 1, pending: 0, etaS: 90 });
    // 真正一轮不剩（没有 failed）才给 0。
    let clean = newLadderState(lad);
    clean = applyRoundResult(clean, lad.rounds[0], { status: 'ok', wdl: { w: 2, d: 0, l: 2 }, durationMs: 60000, remoteLines: 4 }, { now: NOW });
    clean = applyRoundResult(clean, lad.rounds[1], { status: 'ok', wdl: { w: 2, d: 0, l: 2 }, durationMs: 60000, remoteLines: 4 }, { now: NOW });
    clean = applyRoundResult(clean, lad.rounds[2], { status: 'ok', wdl: { w: 2, d: 0, l: 2 }, durationMs: 60000, remoteLines: 4 }, { now: NOW });
    expect(summarizeLadder(clean, { nowMs: NOW.getTime() }).etaS).toBe(0);
  });
  it('一行进度文本含轮数/局数/W-D-L/已跑与 ETA', () => {
    let st = newLadderState(lad);
    st = applyRoundResult(st, lad.rounds[0], { status: 'ok', wdl: { w: 2, d: 1, l: 1 }, durationMs: 120000, remoteLines: 4 }, { now: NOW });
    const line = formatLadderProgress(st, { nowMs: NOW.getTime() + 600000 });
    expect(line).toContain('lad1 1/3 轮｜4/12 局｜W2-D1-L1');
    expect(line).toContain('已跑 10m');
    expect(line).toMatch(/ETA \d+m/);
  });
});

describe('文件 IO', () => {
  it('目录/文件命名固定（.work/remote/<ladderId>/…）', () => {
    expect(ladderDir('E:/x', 'lad1')).toBe(path.join('E:/x', '.work/remote/lad1'));
    expect(stateFile('E:/x', 'lad1')).toBe(path.join('E:/x', '.work/remote/lad1/ladder.json'));
    expect(planFile('E:/x', 'lad1', 3)).toBe(path.join('E:/x', '.work/remote/lad1/plans/round-3.json'));
  });
  it('状态原子写 + 读回一致；坏文件读成 null 不抛', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-'));
    const lad = buildLadder({ ladderId: 'lad1', specs: RAPFI_SPECS, games: 4, now: NOW, seed: 1 });
    const file = stateFile(root, 'lad1');
    writeLadderState(file, newLadderState(lad));
    expect(readLadderState(file).rounds.length).toBe(3);
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp'))).toBe(false);
    fs.writeFileSync(file, '{ 坏 JSON');
    expect(readLadderState(file)).toBeNull();
    expect(readLadderState(path.join(root, 'nope.json'))).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('writePlans 落出每轮 plan 文件（内容 = round.plan）', () => {    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-'));
    const lad = buildLadder({ ladderId: 'lad1', specs: RAPFI_SPECS, games: 4, now: NOW, seed: 1 });
    const files = writePlans(root, lad);
    expect(files.length).toBe(3);
    const back = JSON.parse(fs.readFileSync(files[1], 'utf8'));
    expect(back.round).toBe(2);
    expect(back.tag).toBe('exp-20261004120000-lad1-r2');
    expect(back.outDir).toContain('/.work/remote/lad1/round-2');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('CLI：闸门与 W/D/L 口径', () => {
  it('--ladder 与 --identities 二选一、必须给一个（exit 2）', async () => {
    await expect(ladderMain([])).resolves.toBe(0); // 无参数 = 打用法
    await expect(ladderMain(['--ladder', 'L3', '--identities', 'rapfi::500,rapfi::1000']))
      .rejects.toMatchObject({ exitCode: 2 });
    await expect(ladderMain(['--games', '4'])).rejects.toThrow(/--ladder L1\|L2\|L3\|L4\|all/);
  });
  it('未知预设 / 非法局数 / 非法 batchId 都是用法错（exit 2）', async () => {
    const dry = ['--dry-run', '--batch', 'dry1'];
    await expect(ladderMain(['--ladder', 'L9', ...dry])).rejects.toMatchObject({ exitCode: 2 });
    await expect(ladderMain(['--ladder', 'L3', '--games', '3', ...dry])).rejects.toThrow(/必须是偶数/);
    await expect(ladderMain(['--ladder', 'L3', '--dry-run', '--batch', 'Bad Id'])).rejects.toMatchObject({ exitCode: 2 });
    await expect(ladderMain(['--ladder', 'L3', '--store', 'r2', ...dry])).rejects.toThrow(/--store 只认/);
    await expect(ladderMain(['--ladder', 'L3', '--rate-limit', '0', ...dry])).rejects.toThrow(/--rate-limit/);
    await expect(ladderMain(['--ladder', 'L3', '--poll', '0', ...dry])).rejects.toThrow(/--poll/);
    await expect(ladderMain(['--ladder', 'L3', '--cooldown', '-1', ...dry])).rejects.toThrow(/--cooldown/);
  });
  it('写生产 D1 要 --allow-production；零 CF 触碰的缺省跑动不受这条闸门拦', async () => {
    await expect(ladderMain(['--ladder', 'L3', '--store', 'd1', '--dry-run', '--batch', 'dry1']))
      .rejects.toThrow(/--allow-production/);
    // 缺省 store=local + upstream=direct：dry-run 应该正常走完（不打上游、不落远端、不看 origin）
    await expect(ladderMain(['--ladder', 'L3', '--games', '4', '--dry-run', '--batch', 'dry1'])).resolves.toBe(0);
  });
  it('--upstream worker 必须给 --origin；--parallel 一律拒绝（阶梯要串行）', async () => {
    await expect(ladderMain(['--ladder', 'L3', '--upstream', 'worker', '--dry-run', '--batch', 'dry1']))
      .rejects.toThrow(/--upstream worker 需要 --origin/);
    await expect(ladderMain(['--ladder', 'L3', '--parallel', '--dry-run', '--batch', 'dry1']))
      .rejects.toThrow(/阶梯不并行/);
  });
  it('dry-run 印的启动命令与真跑同一条（含 pid 守卫、日志/pid 落点）', async () => {
    const lines = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { lines.push(String(c)); return true; });
    try {
      await expect(ladderMain(['--ladder', 'L3', '--max-rounds', '1', '--dry-run', '--batch', 'dry3'])).resolves.toBe(0);
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
    const out = lines.join('\n');
    expect(out).toContain('与真跑同一条启动命令');
    const sshLine = out.split('\n').find((l) => l.includes('ssh ') && l.includes('round-1.json'));
    expect(sshLine).toContain('kill -0');                                   // 守卫在启动之前
    expect(sshLine).toContain('>> /root/board-games/.work/remote/dry3/logs/round-1.log 2>&1 < /dev/null'); // 日志落点
    expect(sshLine).toContain('echo $! > /root/board-games/.work/remote/dry3/logs/round-1.pid');
    expect(sshLine).not.toContain('exec nohup');                            // 老写法（无守卫、无日志）不该再出现
  });
  it('--max-rounds 是「截断本次编排」，并当场说清楚不是「先跑 N 轮再接着跑」', async () => {
    const lines = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { lines.push(String(c)); return true; });
    try {
      await expect(ladderMain(['--ladder', 'L3', '--max-rounds', '1', '--dry-run', '--batch', 'dry2'])).resolves.toBe(0);
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
    const out = lines.join('\n');
    expect(out).toContain('--max-rounds 1：本次只编排前 1 轮');
    expect(out).toContain('别指望它');
  });
  it('W/D/L 按 A 视角算：和棋算和、未终局与半行不计数但算行数', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-wdl-'));
    const rec = (result, winner, black = 'rapfi', white = 'rapfi') => JSON.stringify({
      result, winner, blackChannel: black, whiteChannel: white, moves: [{}, {}],
    });
    const lines = [
      rec('黑方 获胜（五连）', 'black'), // 局 1：A 执黑 → 胜
      rec('白方 获胜（五连）', 'white'), // 局 2：A 执白 → 胜
      rec('和棋（盘面满）', null), // 局 3：A 执黑 → 和
      rec('', null), // 局 4：未终局 → 不计
      '{"半截', // 局 5：kill -9 留下的半行 → 跳过（但仍占第 5 行的位置）
      rec('白方 获胜（五连）', 'white'), // 局 6：A 执白 → 胜
    ];
    fs.writeFileSync(path.join(dir, 'games.jsonl'), lines.join('\n') + '\n');
    // 身份分不出来（两臂同身份）⇒ 退回位置推断：偶数行（1 基）A 执白。
    expect(wdlOfGamesJsonl(dir)).toEqual({ w: 3, d: 1, l: 0, lines: 6, unique: 4, counted: 4 });
    expect(wdlOfGamesJsonl(dir, 'rapfi||0')).toEqual({ w: 3, d: 1, l: 0, lines: 6, unique: 4, counted: 4 });
    fs.rmSync(dir, { recursive: true, force: true });
    // 没跑过的目录：全 0（不编数字）
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-wdl-'));
    expect(wdlOfGamesJsonl(empty)).toEqual({ w: 0, d: 0, l: 0, lines: 0, unique: 0, counted: 0 });
    fs.rmSync(empty, { recursive: true, force: true });
  });
  it('games.jsonl 里同一局出现两次（整轮重放）时按 gameUid 去重，并自报 dupes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-dup-'));
    const rec = (uid, result, winner) => JSON.stringify({
      gameUid: uid, result, winner, blackChannel: 'rapfi', whiteChannel: 'rapfi', moves: [{}],
    });
    fs.writeFileSync(path.join(dir, 'games.jsonl'), [
      rec('u1', '黑方 获胜（五连）', 'black'), // 局 1
      rec('u2', '白方 获胜（五连）', 'white'), // 局 2
      rec('u1', '黑方 获胜（五连）', 'black'), // 重放出来的重复
      rec('u3', '和棋（盘面满）', null),
    ].join('\n') + '\n');
    const w = wdlOfGamesJsonl(dir);
    expect(w).toMatchObject({ lines: 4, unique: 3, dupes: 1, counted: 3 });
    expect(w.w + w.d + w.l).toBe(3); // 去重后只算三条，不是四条
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('身份能分清时按记录身份算 A 的胜负（不靠行号位置）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-wdl-'));
    // 只有一行，且 A 执白并获胜 —— 位置推断会说「第一行 = A 执黑 = 负」，身份推断说「胜」。
    fs.writeFileSync(path.join(dir, 'games.jsonl'), JSON.stringify({
      result: '白方 获胜（五连）', winner: 'white',
      blackChannel: 'rapfi', whiteChannel: 'official', whiteTactics: 'v14-live3-fresh', moves: [{}],
    }) + '\n');
    const aId = identityOfSpec('official:v14-live3-fresh:0').id;
    expect(aId).toBe('official|v14-live3-fresh|0');
    expect(wdlOfGamesJsonl(dir, aId)).toEqual({ w: 1, d: 0, l: 0, lines: 1, unique: 1, counted: 1 });
    expect(wdlOfGamesJsonl(dir)).toEqual({ w: 0, d: 0, l: 1, lines: 1, unique: 1, counted: 1 }); // 无身份线索时的位置推断
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
