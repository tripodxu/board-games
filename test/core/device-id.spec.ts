/* device-id.spec.ts — 匿名设备标识（ADR-0013 的浏览器半边）
 *
 * 三件事各守一段，缺一段都会回到「浏览器没有身份」的老状态：
 *   ① 值域：`src/shared/device-id.ts` 是 Worker 校验与浏览器生成的**同一份**定义，
 *      漂了不会报错，只会静默 400（面板显示「后端不可用」，看起来像网络故障）；
 *   ② 生成 / 读盘：`src/core/device.ts`，存储靠注入（与 `src/core/persist.ts` 同款），
 *      坏值 / 存储不可用都不能崩，也不能把非法串当身份用；
 *   ③ 注入：`src/core/api/client.ts` 必须真的把 `X-Device-Id` 挂上每个 `/api/*` 请求
 *      —— 这一层没接线时，前面两层再正确也没有一行 `device_id` 落库。
 *
 * 为什么断言「没有设备 id 时 headers 为空」这种细节：浏览器缓存的键是完整 URL，
 * 但**服务端** `device=me` 是 no-store、其它读接口是 30s 公共缓存；多带一个恒定的
 * 自定义头对缓存无害，可一旦带上错误的身份就会串数据。形状保持原样比「顺手加个头」安全。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID_HEADER, DEVICE_ID_RE, normalizeDeviceId } from '../../src/shared/device-id.ts';
import { DEVICE_ID_KEY, loadDeviceId, newDeviceId } from '../../src/core/device.ts';
import {
  exportGames,
  getDeviceId,
  listGames,
  saveGame,
  setDeviceId,
} from '../../src/core/api/client.ts';

/** 内存存储桩：可选注入故障（隐私模式 / 配额满）。 */
function fakeStorage(
  seed: Record<string, string> = {},
  opts: { failGet?: boolean; failSet?: boolean } = {},
): { store: Map<string, string>; getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    getItem(k: string): string | null {
      if (opts.failGet) throw new Error('storage disabled');
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string): void {
      if (opts.failSet) throw new Error('quota exceeded');
      store.set(k, String(v));
    },
  };
}

interface Seen {
  url: string;
  init?: RequestInit;
}

/** 桩 fetch：记下每次请求的 URL 与 init，回一个 200。 */
function stubFetch(body: unknown, seen: Seen[]): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

/** 取一次请求实际发出的头（没有 headers 时给空对象）。 */
function headersOf(seen: Seen[], i = 0): Record<string, string> {
  return (seen[i]?.init?.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  /* 模块级状态：本文件内必须还原，否则后面的用例会带着上一个身份跑 */
  setDeviceId(null);
});

describe('设备标识：值域（Worker 与浏览器共用一份定义）', () => {
  it('DEVICE_ID_RE 收下合法串，拒掉太短 / 太长 / 带非法字符的串', () => {
    expect(DEVICE_ID_RE.test('ssh-batch')).toBe(true);            /* 远端批量的设备名（9 字符） */
    expect(DEVICE_ID_RE.test('6b1747c0-7a20-4c8e-91f4-f7513361')).toBe(true); /* randomUUID 去掉末段 */
    expect(DEVICE_ID_RE.test('abc12345')).toBe(true);             /* 下界 8 */
    expect(DEVICE_ID_RE.test('a'.repeat(64))).toBe(true);         /* 上界 64 */
    expect(DEVICE_ID_RE.test('a'.repeat(65))).toBe(false);
    expect(DEVICE_ID_RE.test('abc1234')).toBe(false);
    expect(DEVICE_ID_RE.test('abc 12345')).toBe(false);
    expect(DEVICE_ID_RE.test('设备标识-abc123')).toBe(false);
  });

  it('normalizeDeviceId：空白 / 非串 / 非法一律 null，合法串去掉首尾空白后原样返回', () => {
    expect(normalizeDeviceId('')).toBeNull();
    expect(normalizeDeviceId('   ')).toBeNull();
    expect(normalizeDeviceId(null)).toBeNull();
    expect(normalizeDeviceId(undefined)).toBeNull();
    expect(normalizeDeviceId('short')).toBeNull();
    expect(normalizeDeviceId('  uid-abc12345  ')).toBe('uid-abc12345');
  });

  it('newDeviceId() 的产物一定过值域，且两次调用不同', () => {
    const a = newDeviceId();
    const b = newDeviceId();
    expect(normalizeDeviceId(a)).toBe(a);
    expect(normalizeDeviceId(b)).toBe(b);
    expect(a).not.toBe(b);
  });
});

describe('设备标识：读盘与持久化', () => {
  it('首次访问：生成一个合法 id 并写回存储', () => {
    const s = fakeStorage();
    const id = loadDeviceId(s);
    expect(normalizeDeviceId(id)).toBe(id);
    expect(s.store.get(DEVICE_ID_KEY)).toBe(id);
  });

  it('第二次访问沿用同一个 id（刷新页面不换身份，否则「只看我的」每次都空）', () => {
    const s = fakeStorage();
    const first = loadDeviceId(s);
    expect(loadDeviceId(s)).toBe(first);
  });

  it('存储里是坏值：丢掉并换一个新的（非法串绝不发出去）', () => {
    const s = fakeStorage({ [DEVICE_ID_KEY]: 'bad id!' });
    const id = loadDeviceId(s);
    expect(normalizeDeviceId(id)).toBe(id);
    expect(id).not.toBe('bad id!');
    expect(s.store.get(DEVICE_ID_KEY)).toBe(id);
  });

  it('存储不可用（读抛 / 写抛）：都不崩，仍返回本次可用的合法 id', () => {
    const noRead = fakeStorage({}, { failGet: true });
    expect(normalizeDeviceId(loadDeviceId(noRead))).not.toBeNull();
    const noWrite = fakeStorage({}, { failSet: true });
    const id = loadDeviceId(noWrite);
    expect(normalizeDeviceId(id)).toBe(id);
    expect(noWrite.store.has(DEVICE_ID_KEY)).toBe(false);
  });

  it('键名与设置键分开（清理设置不该换身份）', () => {
    expect(DEVICE_ID_KEY).not.toBe('jev_qiguan_settings_v2');
  });
});

describe('设备标识：请求头注入（每个 /api/* 都带身份）', () => {
  it('GET 带 X-Device-Id，且不因为设备头引入 Content-Type', async () => {
    const seen: Seen[] = [];
    stubFetch({ ok: true, games: [], nextCursor: null }, seen);
    setDeviceId('uid-abc12345');
    expect(getDeviceId()).toBe('uid-abc12345');

    await listGames({ limit: 50 });

    expect(seen[0]?.url).toBe('/api/games?limit=50');
    expect(headersOf(seen)[DEVICE_ID_HEADER]).toBe('uid-abc12345');
    expect(headersOf(seen)['Content-Type']).toBeUndefined();
  });

  it('POST（写棋谱）两个头都在：服务端要 Content-Type 也认设备归属', async () => {
    const seen: Seen[] = [];
    stubFetch({ ok: true, gameUid: 'uid-abc12345' }, seen);
    setDeviceId('uid-abc12345');

    await saveGame({ format: 'jev-qiguan-game/v1' });

    expect(seen[0]?.init?.method).toBe('POST');
    expect(headersOf(seen)[DEVICE_ID_HEADER]).toBe('uid-abc12345');
    expect(headersOf(seen)['Content-Type']).toBe('application/json');
  });

  it('导出（callText 自己发 fetch，不走 call）同样带设备头', async () => {
    const seen: Seen[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return Promise.resolve(new Response('{"a":1}\n', { status: 200 }));
    });
    setDeviceId('uid-abc12345');

    await exportGames({ limit: 1 });

    expect(headersOf(seen)[DEVICE_ID_HEADER]).toBe('uid-abc12345');
  });

  it('非法 id 被丢弃：宁可没有身份，也不要发一个服务端必然 400 的串', async () => {
    const seen: Seen[] = [];
    stubFetch({ ok: true, games: [] }, seen);

    setDeviceId('bad id!');
    expect(getDeviceId()).toBe('');
    await listGames();

    expect(seen[0]?.init?.headers).toBeUndefined();
  });

  it('未设置设备 id 时不发 headers（保持旧的无头 GET 形状）', async () => {
    const seen: Seen[] = [];
    stubFetch({ ok: true, games: [] }, seen);

    setDeviceId(null);
    await listGames();

    expect(seen[0]?.init?.headers).toBeUndefined();
  });
});
