import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  USAGE,
  VARIANTS,
  baseRequestFrom,
  buildPlan,
  formatReport,
  pickAnswer,
  resolveKey,
  runProbe,
  summarizeRepeats,
  variantById,
} from '../../scripts/probe-model-params.mjs';

const FIXTURE = 'test/fixtures/jev/commandcode-systemone-2026-10-03.json';

describe('probe-model-params：变体表与计划', () => {
  it('baseline 永远排第一，id 唯一且都有中文标签', () => {
    expect(VARIANTS[0].id).toBe('baseline');
    expect(VARIANTS[0].params).toEqual({});
    const ids = VARIANTS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of VARIANTS) expect(v.label.length).toBeGreaterThan(0);
  });

  it('buildPlan 是「变体 × 次数」的拍平序列，轮次从 1 数起', () => {
    const plan = buildPlan({ variants: VARIANTS.slice(0, 2), repeats: 3 });
    expect(plan).toHaveLength(6);
    expect(plan.map((s) => `${s.variant}#${s.round}`)).toEqual([
      'baseline#1',
      'baseline#2',
      'baseline#3',
      'temp0#1',
      'temp0#2',
      'temp0#3',
    ]);
    expect(plan[0].params).toEqual({});
    expect(plan[3].params).toEqual({ temperature: 0 });
  });

  it('buildPlan 拒绝非法次数与空变体', () => {
    expect(() => buildPlan({ repeats: 0 })).toThrow(/正整数/);
    expect(() => buildPlan({ repeats: 1.5 })).toThrow(/正整数/);
    expect(() => buildPlan({ variants: [] })).toThrow(/至少需要一个变体/);
  });

  it('variantById 对未知 id 报出可用清单', () => {
    expect(variantById('temp0').params).toEqual({ temperature: 0 });
    expect(() => variantById('nope')).toThrow(/未知变体：nope（可用：baseline/);
  });
});

describe('probe-model-params：读数', () => {
  it('pickAnswer 取 choice/confidence/probabilities，缺字段一律 null', () => {
    const got = pickAnswer({ answers: { move: { choice: 'H8', confidence: 0.38, probabilities: { H8: 0.48, bad: 'x' } } } });
    expect(got).toEqual({ choice: 'H8', confidence: 0.38, probabilities: { H8: 0.48 } });
    expect(pickAnswer({ answers: {} })).toBeNull();
    expect(pickAnswer({ answers: { move: { type: 'choice' } } })).toEqual({ choice: null, confidence: null, probabilities: {} });
    expect(pickAnswer(null)).toBeNull();
  });

  it('summarizeRepeats：全同 ⇒ 复现；不同 ⇒ 报出取值与概率摆幅', () => {
    const same = summarizeRepeats([
      { status: 200, ms: 1000, answer: { choice: 'H8', probabilities: { H8: 0.4, E5: 0.2 } } },
      { status: 200, ms: 1200, answer: { choice: 'H8', probabilities: { H8: 0.42, E5: 0.18 } } },
    ]);
    expect(same).toMatchObject({ attempts: 2, okCount: 2, errorCount: 0, distinct: 1, identical: true, meanMs: 1100 });
    expect(same.choices).toEqual(['H8']);
    expect(same.maxSpread).toBeCloseTo(0.02, 6);

    const mixed = summarizeRepeats([
      { status: 200, ms: 900, answer: { choice: 'H8', probabilities: { H8: 0.5 } } },
      { status: 200, ms: 900, answer: { choice: 'E5', probabilities: { H8: 0.1 } } },
    ]);
    expect(mixed.distinct).toBe(2);
    expect(mixed.identical).toBe(false);
    expect(mixed.choices.sort()).toEqual(['E5', 'H8']);
    expect(mixed.maxSpread).toBeCloseTo(0.4, 6);
  });

  it('非 200 的重复不计入复现，但计入 errorCount', () => {
    const rows = summarizeRepeats([
      { status: 200, ms: 1000, answer: { choice: 'H8', probabilities: {} } },
      { status: 422, ms: 300, answer: null },
    ]);
    expect(rows).toMatchObject({ attempts: 2, okCount: 1, errorCount: 1, identical: false });
    expect(rows.choices).toEqual(['H8']);
  });

  it('只有一条成功样本时不下「复现」结论（identical=false）', () => {
    const one = summarizeRepeats([{ status: 200, ms: 1000, answer: { choice: 'H8', probabilities: {} } }]);
    expect(one.identical).toBe(false);
  });
});

describe('probe-model-params：请求体与 key 来源', () => {
  it('baseRequestFrom 用夹具里的真实 request，只发客户端会发的那三个字段', () => {
    const body = baseRequestFrom(FIXTURE, 'jev-latest');
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body.model).toBe('jev-latest');
    expect(typeof body.state).toBe('object');
    expect(body.state.legal_moves.length).toBeGreaterThan(0);
    expect(typeof body.questions).toBe('object');
    // 夹具是 curl 捕获的，多带了一个顶层 options —— 官方端点对多余字段直接 400，投影时必须丢掉
    expect(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).request.options).toBeTruthy();
    expect(body.options).toBeUndefined();
  });

  it('夹具缺 state/questions 也报错', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')), 'thin.json');
    fs.writeFileSync(tmp, JSON.stringify({ request: { model: 'x' } }));
    expect(() => baseRequestFrom(tmp)).toThrow(/缺 state\/questions/);
  });

  it('夹具里没有 request 就报错，不编一个假请求体', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')), 'no-request.json');
    fs.writeFileSync(tmp, JSON.stringify({ capturedAt: 'x' }));
    expect(() => baseRequestFrom(tmp)).toThrow(/夹具里没有 request/);
  });

  it('resolveKey 的优先级：--key > env > 文件', () => {
    expect(resolveKey({ key: 'k-arg', env: { JEV_API_KEY: 'k-env' }, readFile: () => 'k-file' })).toEqual({ key: 'k-arg', source: '--key' });
    expect(resolveKey({ env: { JEV_API_KEY: 'k-env' }, readFile: () => 'k-file' })).toEqual({ key: 'k-env', source: 'env:JEV_API_KEY' });
    const file = resolveKey({ env: {}, keyFile: '/tmp/k', readFile: () => 'export JEV_API_KEY="abcdefghijklmnopqrstuvwxyz123"\n' });
    expect(file.source).toBe('file:/tmp/k');
    expect(file.key).toBe('abcdefghijklmnopqrstuvwxyz123');
    expect(resolveKey({ env: {}, keyFile: '/tmp/missing', readFile: () => { throw new Error('ENOENT'); } })).toEqual({ key: '', source: '' });
  });
});

describe('probe-model-params：执行器', () => {
  it('runProbe 按计划顺序发请求、按变体归组，间隔只加在请求之间', async () => {
    const slept = [];
    const calls = [];
    const plan = buildPlan({ variants: VARIANTS.slice(0, 2), repeats: 2 });
    const results = await runProbe({
      plan,
      pause: 50,
      sleep: async (ms) => slept.push(ms),
      post: async (step) => {
        calls.push(`${step.variant}#${step.round}`);
        return { status: 200, ms: 10, answer: { choice: 'H8', probabilities: { H8: 0.4 } } };
      },
    });
    expect(calls).toEqual(['baseline#1', 'baseline#2', 'temp0#1', 'temp0#2']);
    expect(slept).toEqual([50, 50, 50]); // 3 个间隔，4 个请求
    expect(results.map((r) => r.id)).toEqual(['baseline', 'temp0']);
    expect(results[0].summary.identical).toBe(true);
  });

  it('post 抛错记成 status 0 并把错误留在 detail 里，不炸整轮', async () => {
    const plan = buildPlan({ variants: VARIANTS.slice(0, 1), repeats: 1 });
    const rows = [];
    const results = await runProbe({
      plan,
      pause: 0,
      post: async () => {
        throw new Error('ETIMEDOUT');
      },
      onRow: (r) => rows.push(r),
    });
    expect(rows[0]).toMatchObject({ status: 0, detail: 'ETIMEDOUT' });
    expect(results[0].summary).toMatchObject({ okCount: 0, errorCount: 1 });
    expect(results[0].errors[0]).toEqual({ status: 0, detail: 'ETIMEDOUT' });
  });

  it('formatReport 印出复现结论与失败行', () => {
    const results = [
      { id: 'baseline', label: '原样', params: {}, rows: [], errors: [], summary: { attempts: 2, okCount: 2, errorCount: 0, distinct: 2, identical: false, maxSpread: 0.3, choices: ['H8', 'E5'], meanMs: 900 } },
      { id: 'temp0', label: 'temperature: 0', params: { temperature: 0 }, rows: [], errors: [{ status: 422, detail: 'unknown field' }], summary: { attempts: 1, okCount: 0, errorCount: 1, distinct: 0, identical: false, maxSpread: 0, choices: [], meanMs: 200 } },
    ];
    const text = formatReport(results);
    expect(text).toContain('baseline'.padEnd(22).trim());
    expect(text).toContain('全败(1)');
    expect(text).toContain('HTTP 422：unknown field');
    expect(text).toContain('被接受且复现的变体：无');
  });
});

describe('probe-model-params：CLI', () => {
  const mod = async () => await import('../../scripts/probe-model-params.mjs');

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('--dry-run 只打印计划、零请求、退出码 0', async () => {
    const spy = vi.fn(() => {
      throw new Error('dry-run 不该发请求');
    });
    vi.stubGlobal('fetch', spy);
    const logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    const { parseArgs } = await mod();
    const args = parseArgs(['--dry-run', '--variants', 'baseline,temp0', '--repeats', '3']);
    expect(args.dryRun).toBe(true);
    expect(args.variants).toEqual(['baseline', 'temp0']);
    expect(args.repeats).toBe(3);
    expect(spy).not.toHaveBeenCalled();
    expect(USAGE).toContain('--dry-run');
  });

  it('参数校验：未知变体、未知开关、非法 repeats 都被挡下', async () => {
    const { parseArgs } = await mod();
    expect(() => parseArgs(['--variants', 'baseline,nope'])).toThrow(/未知变体：nope/);
    expect(() => parseArgs(['--bogus'])).toThrow(/未知参数：--bogus/);
    expect(() => parseArgs(['--repeats', '0'])).toThrow(/正整数/);
    expect(() => parseArgs(['--repeats'])).toThrow(/需要一个值/);
    expect(() => parseArgs(['--pause', '-1'])).toThrow(/不能为负/);
  });

  it('走完整轮：main 打印读数、写产物，产物里不含 key', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-run-'));
    const jsonPath = path.join(tmp, 'out.json');
    const fetchSpy = vi.fn(async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({ answers: { move: { choice: 'H8', confidence: 0.4, probabilities: { H8: 0.4, E5: 0.2 } } } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push('ERR ' + a.join(' ')));
    const { main } = await mod();
    const code = await main([
      '--key',
      'SUPERSECRETKEY1234567890',
      '--variants',
      'baseline,temp0',
      '--repeats',
      '2',
      '--pause',
      '0',
      '--json',
      jsonPath,
    ]);
    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(4); // 2 变体 × 2 次
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sent.model).toBe('jev-latest');
    expect(sent.state).toBeTruthy();
    expect(sent.temperature).toBeUndefined();
    expect(JSON.parse(fetchSpy.mock.calls[2][1].body).temperature).toBe(0); // 第 3 次起是 temp0
    const text = logs.join('\n');
    expect(text).toContain('复现');
    expect(text).toContain('产物：');
    const artifact = fs.readFileSync(jsonPath, 'utf8');
    expect(artifact).not.toContain('SUPERSECRETKEY1234567890');
    expect(JSON.parse(artifact).variants.map((v) => v.id)).toEqual(['baseline', 'temp0']);
    expect(JSON.parse(artifact).variants[0].summary.identical).toBe(true);
  });

  it('main 拦下没有 key、坏夹具、坏参数（退出码 2，且不发请求）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
    const { main } = await mod();
    expect(await main(['--key', '', '--key-file', '/tmp/definitely-missing-key'])).toBe(2);
    expect(errors.join('\n')).toContain('没有 key');
    expect(await main(['--key', 'k', '--fixture', '/tmp/definitely-missing-fixture.json'])).toBe(2);
    expect(await main(['--key', 'k', '--variants', 'baseline,nope'])).toBe(2);
    expect(errors.join('\n')).toContain('未知变体：nope');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
