// test/scripts/upstream.spec.mjs — 「打哪个上游、用哪把 key」的纯逻辑（不读真实 key、不联网）
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEY_FILE,
  DEFAULT_ROUTER_KEY_FILE,
  KEY_CHANNELS,
  KEY_HELP,
  ROUTER_KEY_HELP,
  keyShapeProblem,
  parseKeyFile,
  resolveRunKey,
  upstreamGate,
} from '../../scripts/lib/upstream.mjs';

const LONG = 'k'.repeat(40);
const JV = `jv-${'r'.repeat(32)}`;

describe('parseKeyFile', () => {
  it('认裸 key / KEY=value / export / Bearer / 引号，并跳过注释与空行', () => {
    expect(parseKeyFile(LONG)).toBe(LONG);
    expect(parseKeyFile(`# 说明\nJEV_API_KEY=${LONG}\n`)).toBe(LONG);
    expect(parseKeyFile(`export JEV_API_KEY="${LONG}"`)).toBe(LONG);
    expect(parseKeyFile(`export JEV_OR_KEY='${LONG}'`)).toBe(LONG);
    expect(parseKeyFile(`Bearer ${LONG}`)).toBe(LONG);
    expect(parseKeyFile(`\uFEFF\n\n   \n${LONG}\n`)).toBe(LONG);
  });

  it('取不到就返回空串（不抛：由调用方统一报 KEY_HELP）', () => {
    expect(parseKeyFile('')).toBe('');
    expect(parseKeyFile('# 只有注释\n')).toBe('');
    expect(parseKeyFile('short')).toBe('');            // 太短：多半不是 key
    expect(parseKeyFile('说明文字 里 有 空格')).toBe(''); // 含空白：不是 key
    expect(parseKeyFile('JEV_API_KEY=')).toBe('');      // 空值
  });

  it('第一行有效值胜出（文件顶部放 key 的惯例）', () => {
    expect(parseKeyFile(`${LONG}\n${'x'.repeat(50)}`)).toBe(LONG);
  });
});

describe('resolveRunKey', () => {
  it('环境变量优先于文件', () => {
    const r = resolveRunKey({ env: { JEV_API_KEY: 'env-key-env-key-env-key-123456' }, readFile: () => `${LONG}\n` });
    expect(r).toEqual({ key: 'env-key-env-key-env-key-123456', source: 'env:JEV_API_KEY' });
  });

  it('没有环境变量就读 key 文件（默认路径是 box 上的 /root/.jev-key）', () => {
    const r = resolveRunKey({ env: {}, readFile: () => `JEV_API_KEY=${LONG}\n` });
    expect(r).toEqual({ key: LONG, source: `file:${DEFAULT_KEY_FILE}` });
    expect(DEFAULT_KEY_FILE).toBe('/root/.jev-key');
  });

  it('openrouter 只认 JEV_OR_KEY（不同上游不同配额，不能互相顶替）', () => {
    const env = { JEV_API_KEY: 'official-key-official-key-1234567' };
    expect(resolveRunKey({ env, channel: 'openrouter', keyFile: '' })).toEqual({ key: '', source: '' });
    expect(resolveRunKey({ env: { ...env, JEV_OR_KEY: 'or-key-or-key-or-key-1234567890' }, channel: 'openrouter' })).toEqual({
      key: 'or-key-or-key-or-key-1234567890',
      source: 'env:JEV_OR_KEY',
    });
  });

  it('文件不存在 / 读失败 ⇒ 空 key（不抛，让 main 按 KEY_HELP 早退）', () => {
    const boom = () => { throw new Error('ENOENT'); };
    expect(resolveRunKey({ env: {}, readFile: boom })).toEqual({ key: '', source: '' });
    expect(resolveRunKey({ env: {}, keyFile: '', readFile: boom })).toEqual({ key: '', source: '' });
  });

  it('KEY_HELP 要指出环境变量与文件两条路（别只说「缺 key」）', () => {
    expect(KEY_HELP).toContain('JEV_API_KEY');
    expect(KEY_HELP).toContain(DEFAULT_KEY_FILE);
  });

  /* jev-router 臂的 key 是**另一把**：批量机与网关同机，`/root/.jev-key` 装的是 `jv-` 网关 key。
     环境变量与默认文件路径都必须与 TypeSafe 臂区分开，否则整轮 401 且看不出原因。 */
  it('jevrouter 只认 JEV_ROUTER_KEY，默认 key 文件是 /root/.jev-router-key', () => {
    const env = { JEV_API_KEY: LONG };
    expect(resolveRunKey({ env, channel: 'jevrouter', keyFile: '' })).toEqual({ key: '', source: '' });
    expect(resolveRunKey({ env: { ...env, JEV_ROUTER_KEY: JV }, channel: 'jevrouter' })).toEqual({
      key: JV, source: 'env:JEV_ROUTER_KEY',
    });
    expect(resolveRunKey({ env: {}, channel: 'jevrouter', keyFile: null, readFile: () => `${JV}\n` })).toEqual({
      key: JV, source: `file:${DEFAULT_ROUTER_KEY_FILE}`,
    });
    expect(DEFAULT_ROUTER_KEY_FILE).toBe('/root/.jev-router-key');
    expect(DEFAULT_ROUTER_KEY_FILE).not.toBe(DEFAULT_KEY_FILE);
    expect(KEY_CHANNELS).toContain('jevrouter');
  });

  it('ROUTER_KEY_HELP 点名 JEV_ROUTER_KEY 与那个独立路径，并提醒别和 TypeSafe 臂混', () => {
    expect(ROUTER_KEY_HELP).toContain('JEV_ROUTER_KEY');
    expect(ROUTER_KEY_HELP).toContain(DEFAULT_ROUTER_KEY_FILE);
    expect(ROUTER_KEY_HELP).toContain(DEFAULT_KEY_FILE);
  });

  it('keyShapeProblem：两把自家 key 放错文件要在开局前被拦下', () => {
    expect(keyShapeProblem('jevrouter', JV)).toBe('');
    expect(keyShapeProblem('jevrouter', LONG)).toMatch(/jv-/);
    expect(keyShapeProblem('official', LONG)).toBe('');
    expect(keyShapeProblem('official', JV)).toMatch(/jv-/);
    /* 空 key 不是「形状错」（那是缺 key 的另一条分支）；第三方渠道不归我们管，不拦。 */
    expect(keyShapeProblem('jevrouter', '')).toBe('');
    expect(keyShapeProblem('openrouter', 'sk-or-v1-whatever-long-enough')).toBe('');
    expect(keyShapeProblem('rapfi', JV)).toBe('');
  });
});

describe('upstreamGate', () => {
  const base = { upstream: 'direct', store: 'local', originGiven: false, channels: ['official', 'rapfi'] };

  it('默认面（direct + local + 无 proxy）放行', () => {
    expect(upstreamGate(base)).toBeNull();
  });

  it('direct 面里出现 proxy 臂 ⇒ 拒绝，并说清「改成 official」', () => {
    const msg = upstreamGate({ ...base, channels: ['proxy', 'rapfi'] });
    expect(msg).toMatch(/direct 运行面不用 proxy 臂/);
    expect(msg).toMatch(/official/);
    expect(msg).toMatch(/X-Api-Key/);
  });

  it('worker 面必须显式给 origin（否则会悄悄打生产）', () => {
    expect(upstreamGate({ ...base, upstream: 'worker' })).toMatch(/--origin/);
    expect(upstreamGate({ ...base, upstream: 'worker', originGiven: true })).toBeNull();
  });

  it('store=d1 也必须显式给 origin（D11/D12 的逃生门要明写）', () => {
    expect(upstreamGate({ ...base, store: 'd1' })).toMatch(/store d1/);
    expect(upstreamGate({ ...base, store: 'd1', originGiven: true })).toBeNull();
  });

  it('upstream 只认 direct|worker', () => {
    expect(upstreamGate({ ...base, upstream: 'cloud' })).toMatch(/只认 direct\|worker/);
  });

  it('direct + worker 面的 origin 给了也不冲突（逃生门允许显式声明）', () => {
    expect(upstreamGate({ ...base, originGiven: true })).toBeNull();
  });
});
