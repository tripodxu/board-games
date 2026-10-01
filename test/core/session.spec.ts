/**
 * `src/core/session.ts` + `src/core/persist.ts` 的真实校验（W2 第四批任务 ①④）。
 *
 * 这两支是 P6 UI 的依赖面：会话对象取代旧 `js/app.js:11-18` 的闭包 `S`，
 * 设置读写取代旧 `js/app.js:20-73` 的 `loadSettings/saveSettings`。
 * 断言全部对着**旧实现的行为**（浅合并、白名单、回落次序），
 * 并额外钉住「键名逐字兼容」「JSON 可克隆」这两条迁移红线。
 */
import { describe, expect, it } from 'vitest';
import {
  aiMovesOf,
  createSession,
  isAISide,
  randomGameUid,
  resultTextOf,
  sideNameOf,
} from '../../src/core/session.ts';
import type { SessionMove } from '../../src/core/session.ts';
import {
  DEFAULT_SETTINGS,
  STORE_KEY,
  effSide,
  effectiveChannelOf,
  isValidMode,
  loadSettings,
  normalizeSideConfig,
  saveSettings,
  stashEndpoint,
} from '../../src/core/persist.ts';
import type { Settings, StorageLike } from '../../src/core/persist.ts';
import { getGame } from '../../src/core/registry.ts';
import { CURRENT } from '../../src/core/tactics-versions.ts';

/** 内存存储桩：注入式设计的意义就在于 Node 里能这么测。 */
function memStorage(init?: Record<string, string>): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(init || {}));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe('session：显式会话对象（旧闭包 S 的显式化）', () => {
  it('createSession 给出旧 S 的默认值，且不碰存储/不生成身份', () => {
    const s = createSession({ gameId: 'gomoku' });
    expect(s.gameId).toBe('gomoku');
    expect(s.st).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.mode).toBe('human-ai');
    expect(s.humanSide).toBeNull();
    expect(s.epoch).toBe(0);
    expect(s.paused).toBe(false);
    expect(s.trendMode).toBe('win');
    expect(s.sessionRecorded).toBe(false);
    expect(s.sessionId).toBeNull();
    expect(s.expInfo).toBeNull();
    expect(s.gameUid).toBeNull();
    expect(s.startedAt).toBeNull();
    expect(s.endedAt).toBeNull();
    expect(s.result).toBeNull();
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('createSession 深拷贝 settings：改 session 不污染默认常量与调用方', () => {
    const mine: Settings = { ...DEFAULT_SETTINGS, topK: 7, sideConfig: { black: { channel: 'mock', tactics: '', rapfiThinkMs: 0 }, white: { channel: '', tactics: '', rapfiThinkMs: 0 } } };
    const s = createSession({ gameId: 'go', settings: mine });
    s.settings.topK = 99;
    s.settings.endpoints.proxy = 'https://x';
    s.settings.sideConfig.black.channel = 'official';
    expect(mine.topK).toBe(7);
    expect(mine.endpoints.proxy).toBeUndefined();
    expect(mine.sideConfig.black.channel).toBe('mock');
    expect(DEFAULT_SETTINGS.topK).toBe(3);
    expect(DEFAULT_SETTINGS.endpoints).toEqual({});
  });

  it('createSession 接受全部可选项', () => {
    const s = createSession({ gameId: 'chess', gameUid: 'uid-1', mode: 'ai-ai', humanSide: 'w', trendMode: 'conf', epoch: 4, startedAt: 123 });
    expect(s.gameUid).toBe('uid-1');
    expect(s.mode).toBe('ai-ai');
    expect(s.humanSide).toBe('w');
    expect(s.trendMode).toBe('conf');
    expect(s.epoch).toBe(4);
    expect(s.startedAt).toBe(123);
  });

  it('会话对象 JSON 可克隆（归档/同步/战绩簿共用的前提）', () => {
    const s = createSession({ gameId: 'gomoku' });
    const m = { notation: 'H8', desc: 'black H8' };
    s.history.push({ ply: 1, side: 'black', move: m, meta: { byAI: true, side: 'black', sideName: '黑方', confidence: 0.5, top: [{ notation: 'H8', p: 0.5 }] } });
    const back = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(back).toEqual(s);
    expect(Object.keys(back).sort()).toEqual(Object.keys(s).sort());
  });

  it('randomGameUid 是稳定非空串（有 crypto.randomUUID 时即 UUID）', () => {
    const a = randomGameUid(1000);
    const b = randomGameUid(1000);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(8);
    expect(a).not.toBe(b);
  });

  it('isAISide：机机全 AI、双人全人、人机看 humanSide', () => {
    const ai = createSession({ gameId: 'gomoku', mode: 'ai-ai' });
    expect(isAISide(ai, 'black')).toBe(true);
    expect(isAISide(ai, 'white')).toBe(true);
    const pvp = createSession({ gameId: 'gomoku', mode: 'pvp' });
    expect(isAISide(pvp, 'black')).toBe(false);
    expect(isAISide(pvp, 'white')).toBe(false);
    const hai = createSession({ gameId: 'gomoku', mode: 'human-ai', humanSide: 'black' });
    expect(isAISide(hai, 'black')).toBe(false);
    expect(isAISide(hai, 'white')).toBe(true);
  });

  it('aiMovesOf 只取 byAI 的手（旧 aiItems()）', () => {
    const s = createSession({ gameId: 'gomoku' });
    const mk = (ply: number, byAI: boolean): SessionMove => ({ ply, side: 'black', move: { notation: 'A1' }, meta: byAI ? { byAI: true } : null });
    s.history.push(mk(1, false), mk(2, true), mk(3, false), mk(4, true));
    expect(aiMovesOf(s).map((h) => h.ply)).toEqual([2, 4]);
  });

  it('sideNameOf / resultTextOf 与旧实现同口径（换边中断算未终局）', () => {
    const e = getGame('gomoku');
    expect(sideNameOf(e, 'black')).toBe('黑方');
    expect(sideNameOf(e, 'nobody')).toBe('nobody');
    expect(sideNameOf(null, 'black')).toBe('black');
    expect(resultTextOf(e, { winner: 'black' })).toBe('黑方');
    expect(resultTextOf(e, { winner: null, reason: '换边中断' })).toBe('未终局');
    expect(resultTextOf(e, { winner: null, reason: '五连' })).toBe('和棋');
    expect(resultTextOf(e, null)).toBe('和棋');
  });

  it('会话能驱动真实引擎：走一手后 history 结构与旧实现一致', () => {
    const engine = getGame('gomoku');
    if (!engine) throw new Error('gomoku engine missing');
    const s = createSession({ gameId: 'gomoku' });
    s.st = engine.newGame() as unknown;
    const st = s.st as never;
    const mv = engine.moveFromNotation(st, 'H8');
    expect(mv).not.toBeNull();
    if (!mv) return;
    s.history.push({ ply: 1, side: (st as { turn: string }).turn, move: mv, meta: null });
    s.st = engine.applyMove(st, mv) as unknown;
    expect(s.history[0].ply).toBe(1);
    expect(s.history[0].side).toBe('black');
    expect((s.st as { turn: string }).turn).toBe('white');
    expect(engine.getStatus(s.st as never).over).toBe(false);
  });
});

describe('persist：设置读写（旧 loadSettings / saveSettings 的纯逻辑部分）', () => {
  it('键名与旧实现逐字兼容', () => {
    expect(STORE_KEY).toBe('jev_qiguan_settings_v2');
  });

  it('空存储 / 损坏内容 / getItem 抛异常 → 一律默认值', () => {
    expect(loadSettings(memStorage())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memStorage({ [STORE_KEY]: '{oops' }))).toEqual(DEFAULT_SETTINGS);
    const hostile: StorageLike = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('quota'); } };
    expect(loadSettings(hostile)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(hostile, DEFAULT_SETTINGS)).not.toThrow();
  });

  it('浅合并覆盖默认值、endpoints 缺失补 {}、tacticsVersion 缺失补当前档、sideConfig 双方归一', () => {
    const s = loadSettings(memStorage({
      [STORE_KEY]: JSON.stringify({
        channel: 'official',
        apiKey: 'k-1',
        topK: 5,
        tacticsVersion: '',
        sideConfig: { black: { channel: 'rapfi', rapfiThinkMs: '1200' }, white: { tactics: 'v3-make2', rapfiThinkMs: 'abc' } },
      }),
    }));
    expect(s.channel).toBe('official');
    expect(s.apiKey).toBe('k-1');
    expect(s.topK).toBe(5);
    expect(s.speed).toBe(6);              /* 未存 → 默认 */
    expect(s.gameSync).toBe(true);        /* 未存 → 默认 */
    expect(s.endpoints).toEqual({});      /* 缺失 → 补 {} */
    expect(s.tacticsVersion).toBe(CURRENT); /* 空串 → 当前档 */
    expect(s.sideConfig.black).toEqual({ channel: 'rapfi', tactics: '', rapfiThinkMs: 1200 });
    expect(s.sideConfig.white).toEqual({ channel: '', tactics: 'v3-make2', rapfiThinkMs: 0 });
  });

  it('sideConfig 缺字段 / 非对象 → 归一成空值三件套', () => {
    expect(normalizeSideConfig(undefined)).toEqual({ channel: '', tactics: '', rapfiThinkMs: 0 });
    /* 旧 `mk()` 只对 rapfiThinkMs 做 `+` 强转，channel/tactics 是「truthy 直通、falsy 换空串」：
       数字 1 原样留着（旧实现怪癖，逐字保留），null 换 ''，'x' → NaN → 0 */
    expect(normalizeSideConfig({ channel: 1, tactics: null, rapfiThinkMs: 'x' })).toEqual({ channel: 1, tactics: '', rapfiThinkMs: 0 });
  });

  it('saveSettings → loadSettings 往返一致（不丢用户设置）', () => {
    const store = memStorage();
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      channel: 'openrouter',
      orKey: 'or-1',
      topK: 2,
      speed: 9,
      endpoints: { openrouter: 'https://or.example/v1' },
      gameSync: false,
      rapfiThinkMs: 8000,
      mode: 'pvp',
      sideConfig: { black: { channel: 'mock', tactics: 'v9-vcf-sound', rapfiThinkMs: 500 }, white: { channel: '', tactics: '', rapfiThinkMs: 0 } },
    };
    saveSettings(store, s);
    expect(JSON.parse(store.map.get(STORE_KEY) as string)).toEqual(s);
    expect(loadSettings(store)).toEqual(s);
  });

  it('stashEndpoint 必须能跳过 mock/rapfi/空渠道，并 trim', () => {
    const s: Settings = { ...DEFAULT_SETTINGS, endpoints: {} };
    stashEndpoint(s, 'mock', ' https://ignored ');
    stashEndpoint(s, 'rapfi', 'https://ignored');
    stashEndpoint(s, null, 'https://ignored');
    expect(s.endpoints).toEqual({});
    stashEndpoint(s, 'official', '  https://api.example/v1  ');
    expect(s.endpoints.official).toBe('https://api.example/v1');
  });

  it('effectiveChannelOf：回落次序与旧实现一致', () => {
    const base: Settings = { ...DEFAULT_SETTINGS, endpoints: {} };
    expect(effectiveChannelOf(base, 'mock')).toBe('mock');
    expect(effectiveChannelOf(base, 'rapfi')).toBe('rapfi');
    /* file:// 下同源代理不可用 → 演示（旧实现读 location.protocol，这里注入） */
    expect(effectiveChannelOf(base, 'proxy')).toBe('proxy');
    expect(effectiveChannelOf(base, 'proxy', { isFile: true })).toBe('mock');
    expect(effectiveChannelOf(base, 'official')).toBe('mock');   /* 没 key → 演示 */
    expect(effectiveChannelOf(base, 'official', { isFile: true })).toBe('mock');
    expect(effectiveChannelOf({ ...base, apiKey: 'k' }, 'official')).toBe('official');
    expect(effectiveChannelOf({ ...base, apiKey: 'k' }, 'openrouter')).toBe('mock'); /* 只看 orKey */
    expect(effectiveChannelOf({ ...base, orKey: 'o' }, 'openrouter')).toBe('openrouter');
    /* 配了自定义端点即视为可用（即使没有 key） */
    expect(effectiveChannelOf({ ...base, endpoints: { official: 'https://x' } }, 'official')).toBe('official');
    expect(effectiveChannelOf(base, '')).toBe('mock');
  });

  it('effSide：单边覆盖优先、空值回落全局、tactics 未知档归一成当前档', () => {
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      channel: 'official',
      apiKey: 'k',
      tacticsVersion: 'v3-make2',
      rapfiThinkMs: 4000,
      sideConfig: {
        black: { channel: 'mock', tactics: 'v9-vcf-sound', rapfiThinkMs: 1500 },
        white: { channel: '', tactics: '', rapfiThinkMs: 0 },
      },
    };
    expect(effSide(s, 'black')).toEqual({ channel: 'mock', tactics: 'v9-vcf-sound', rapfiThinkMs: 1500 });
    expect(effSide(s, 'white')).toEqual({ channel: 'official', tactics: 'v3-make2', rapfiThinkMs: 4000 });
    /* 未知档与空串都 resolve 到当前档（旧 BG.tacticsVersions.resolve 语义） */
    expect(effSide({ ...s, tacticsVersion: '不存在' }, 'white').tactics).toBe(CURRENT);
    expect(effSide({ ...s, sideConfig: {} }, 'black').channel).toBe('official');
  });

  it('isValidMode：只认 #mode 的三个 option 值', () => {
    expect(isValidMode('human-ai')).toBe(true);
    expect(isValidMode('ai-ai')).toBe(true);
    expect(isValidMode('pvp')).toBe(true);
    expect(isValidMode('AI-AI')).toBe(false);
    expect(isValidMode('')).toBe(false);
    expect(isValidMode(null)).toBe(false);
  });
});
