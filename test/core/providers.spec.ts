/**
 * `src/core/jev/providers.ts` —— 提供方表与切换策略（C2 / plan 2026-10-03-cands-metric-and-provider-failover）。
 *
 * 这个模块是**两个运行面共用的判据**：浏览器直连面（`client.ts`）与 Worker 面
 * （`src/worker/lib/failover.ts`）。所以这里钉的不是某条链路的细节，而是三件事：
 *  1. **表**：谁是主家、谁是兜底、各自的端点/模型/probeUrl 与 key 来源；
 *  2. **分类**：HTTP 状态码 → 失败类别 → 「该不该切」（401/402/403 立刻、429/529 用尽、
 *     连续 3 次 5xx、其余 4xx 不切、网络错不切）；
 *  3. **状态与选择**：粘滞优先、判死不复活、全死回落主家。
 *
 * 为什么值得单独一份用例：切换错了不会报错，只会让某一局棋悄悄换了个「大脑」，
 * 而实验结论正是按「谁下的」分桶的——那是最贵的一类 bug。
 */
import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  PROVIDER_BACKUP,
  PROVIDER_HINT_HEADER,
  PROVIDER_PRIMARY,
  PROVIDER_SWITCH_HEADER,
  SERVER_FAILURE_LIMIT,
  classifyStatus,
  defaultProvider,
  failureClassLabel,
  formatProviderSwitch,
  isSwitchable,
  liveProviderIds,
  newProviderStates,
  noteFailure,
  noteSuccess,
  otherProviders,
  pickProvider,
  providerByKeySource,
  providerLabel,
  providerOf,
  stateOf,
} from '../../src/core/jev/providers.ts';

describe('提供方表', () => {
  it('主家 = TypeSafe 官方端点 + jev-latest；兜底 = commandcode + typesafe/jev', () => {
    expect(PROVIDERS.length).toBe(2);
    const primary = providerOf(PROVIDER_PRIMARY)!;
    expect(primary).toMatchObject({
      id: 'primary',
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      keySource: 'official',
      kind: 'systemone',
      probeUrl: 'https://api.typesafe.ai/v1/models',
    });
    const backup = providerOf(PROVIDER_BACKUP)!;
    expect(backup).toMatchObject({
      id: 'backup',
      url: 'https://api.commandcode.ai/provider/v1/systemone',
      model: 'typesafe/jev',
      keySource: 'commandcode',
      kind: 'systemone',
      probeUrl: 'https://api.commandcode.ai/provider/v1/models',
    });
    /* 两家必须是**不同**的端点与模型名：共用一个就会把「模型名不匹配 400」当成上游故障 */
    expect(primary.url).not.toBe(backup.url);
    expect(primary.model).not.toBe(backup.model);
  });

  it('每条表项都带标签与探活地址；查找函数按 id / key 来源各就各位', () => {
    for (const p of PROVIDERS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.probeUrl.startsWith('https://')).toBe(true);
      expect(p.kind).toBe('systemone'); /* 'openai-chat' 只留设计位，表里还没有 */
    }
    expect(defaultProvider().id).toBe(PROVIDER_PRIMARY);
    expect(providerByKeySource('commandcode')?.id).toBe(PROVIDER_BACKUP);
    expect(otherProviders(PROVIDER_PRIMARY).map((p) => p.id)).toEqual([PROVIDER_BACKUP]);
    expect(providerOf('nope')).toBeNull();
    expect(providerOf(null)).toBeNull();
    expect(providerLabel(PROVIDER_BACKUP)).toContain('兜底');
    expect(providerLabel('unknown-id')).toBe('unknown-id'); /* 认不出就原样回显，不编标签 */
  });

  it('两个自定义头的名字是契约（客户端与 Worker 各读各的，改名等于断链）', () => {
    expect(PROVIDER_HINT_HEADER).toBe('X-Jev-Provider');
    expect(PROVIDER_SWITCH_HEADER).toBe('X-Jev-Provider-Switch');
  });
});

describe('失败分类：状态码 → 类别 → 切不切', () => {
  it('401/402/403 = auth（key 或额度废了）；429/529 = rate-limit；5xx = server；其余 4xx = client', () => {
    for (const s of [401, 402, 403]) expect(classifyStatus(s)).toBe('auth');
    for (const s of [429, 529]) expect(classifyStatus(s)).toBe('rate-limit');
    for (const s of [500, 502, 503, 504, 599]) expect(classifyStatus(s)).toBe('server');
    for (const s of [400, 404, 422]) expect(classifyStatus(s)).toBe('client');
    for (const s of [200, 201, 204, 301]) expect(classifyStatus(s)).toBeNull();
  });

  it('只有该切的类别才切：client 类与 2xx/3xx 一律不切', () => {
    expect(isSwitchable('auth')).toBe(true);
    expect(isSwitchable('rate-limit')).toBe(true);
    expect(isSwitchable('server')).toBe(true);
    expect(isSwitchable('client')).toBe(false);
    expect(SERVER_FAILURE_LIMIT).toBe(3);
    expect(failureClassLabel('auth')).toContain('鉴权');
    expect(failureClassLabel('rate-limit')).toContain('限流');
  });
});

describe('提供方状态：连续计数、判死、粘滞', () => {
  it('新状态表覆盖表里每一项，且都是「活着、零失败」', () => {
    const st = newProviderStates();
    for (const p of PROVIDERS) expect(stateOf(st, p.id)).toEqual({ consecutive: 0, total: 0, dead: false, lastClass: null, deadReason: null });
    expect(liveProviderIds(st).sort()).toEqual([PROVIDER_BACKUP, PROVIDER_PRIMARY]);
  });

  it('auth 一次就判死并切走；429 只有「用尽」才切（没声明用尽就只是记账）', () => {
    let st = newProviderStates();
    const auth = noteFailure(st, PROVIDER_PRIMARY, 'auth', { status: 401 });
    st = auth.states;
    expect(auth.switchAway).toBe(true);
    expect(auth.reason).toContain('401');
    expect(stateOf(st, PROVIDER_PRIMARY).dead).toBe(true);
    expect(stateOf(st, PROVIDER_PRIMARY).deadReason).toContain('401');

    const partial = noteFailure(newProviderStates(), PROVIDER_PRIMARY, 'rate-limit', { status: 429 });
    expect(partial.switchAway).toBe(false);
    expect(partial.reason).toContain('仍在退避重试');
    expect(stateOf(partial.states, PROVIDER_PRIMARY).dead).toBe(false);

    const done = noteFailure(newProviderStates(), PROVIDER_PRIMARY, 'rate-limit', { status: 429, exhausted: true });
    expect(done.switchAway).toBe(true);
    expect(done.reason).toContain('用尽');
  });

  it('5xx 要连续到阈值才切：前两次只记账，第三次判死', () => {
    let st = newProviderStates();
    const first = noteFailure(st, PROVIDER_PRIMARY, 'server', { status: 503 });
    st = first.states;
    expect(first.switchAway).toBe(false);
    expect(first.reason).toContain('1/3');
    const second = noteFailure(st, PROVIDER_PRIMARY, 'server', { status: 503 });
    st = second.states;
    expect(second.switchAway).toBe(false);
    const third = noteFailure(st, PROVIDER_PRIMARY, 'server', { status: 503 });
    expect(third.switchAway).toBe(true);
    expect(third.reason).toContain(`连续 ${SERVER_FAILURE_LIMIT} 次`);
    expect(stateOf(third.states, PROVIDER_PRIMARY).total).toBe(3);
  });

  it('client 类失败不切（改请求才有用），只累计 total', () => {
    const note = noteFailure(newProviderStates(), PROVIDER_PRIMARY, 'client', { status: 400 });
    expect(note.switchAway).toBe(false);
    expect(note.reason).toContain('不切换');
    expect(stateOf(note.states, PROVIDER_PRIMARY).dead).toBe(false);
    expect(stateOf(note.states, PROVIDER_PRIMARY).total).toBe(1);
  });

  it('成功清零连续计数，但**不复活**已判死的提供方（本局粘滞是终局）', () => {
    const dead = noteFailure(newProviderStates(), PROVIDER_PRIMARY, 'auth', { status: 401 });
    const after = noteSuccess(dead.states, PROVIDER_PRIMARY);
    expect(stateOf(after, PROVIDER_PRIMARY).dead).toBe(true);
    expect(stateOf(after, PROVIDER_PRIMARY).consecutive).toBe(0);

    const five = noteFailure(newProviderStates(), PROVIDER_PRIMARY, 'server', { status: 500 });
    const revived = noteFailure(five.states, PROVIDER_PRIMARY, 'server', { status: 500 });
    const ok = noteSuccess(revived.states, PROVIDER_PRIMARY);
    expect(stateOf(ok, PROVIDER_PRIMARY).consecutive).toBe(0);
  });

  it('选择：粘滞优先（哪怕它已判死）→ 表里第一个活着的 → 全死回落主家', () => {
    let st = newProviderStates();
    expect(pickProvider(st).id).toBe(PROVIDER_PRIMARY);
    expect(pickProvider(st, PROVIDER_BACKUP).id).toBe(PROVIDER_BACKUP);

    st = noteFailure(st, PROVIDER_PRIMARY, 'auth', { status: 401 }).states;
    expect(pickProvider(st).id).toBe(PROVIDER_BACKUP); /* 主家判死 ⇒ 顺位到兜底 */
    expect(liveProviderIds(st)).toEqual([PROVIDER_BACKUP]);
    /* 粘滞：本局已经押在（已判死的）主家上，也照办——否则一局棋会被切成两半 */
    expect(pickProvider(st, PROVIDER_PRIMARY).id).toBe(PROVIDER_PRIMARY);

    st = noteFailure(st, PROVIDER_BACKUP, 'auth', { status: 401 }).states;
    expect(liveProviderIds(st)).toEqual([]);
    expect(pickProvider(st).id).toBe(PROVIDER_PRIMARY); /* 全死：最后一搏回主家 */
  });

  it('切换原因的人话格式固定（进日志 / events.jsonl / 报表都靠它）', () => {
    const line = formatProviderSwitch({ from: PROVIDER_PRIMARY, to: PROVIDER_BACKUP, reason: 'TypeSafe 官方 HTTP 401', probeMs: 210, probeStatus: 200 });
    expect(line).toContain('上游切换');
    expect(line).toContain('primary');
    expect(line).toContain('backup');
    expect(line).toContain('HTTP 401');
    expect(line).toContain('210ms');
  });
});
