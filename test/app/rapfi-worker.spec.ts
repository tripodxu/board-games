/* rapfi-worker.spec.ts — Rapfi 思考线程（Worker 路径）的装配层断言（P1① 2026-10-12）
 *
 * 背景：Rapfi 的 `sendCommand` 是同步阻塞的，主线程里一次思考冻结 UI 一整手
 * （docs/status.md 已知限制 #5 剩下的主体）。装配层现在把胶水+WASM 资产抓下来交给一个
 * **手写 classic worker**（`public/rapfi/rapfi-worker.js`）去实例化并思考。
 *
 * 这里测的是**主线程这一侧**（资产抓取 / 会话协议 / 看门狗 / 回退与不回退的判据）：
 * 用一个假 Worker 复刻 `rapfi-worker.js` 的消息协议，所以其中的 `importScripts` +
 * `getPreloadedPackage` + `instantiateWasm` 只在真浏览器里才被走一遍——那一层由
 * `npm run smoke:browser -- --channel rapfi` 守（它真的加载 11 MB 资产并让对手落子）。
 *
 * 同样重要的是**回退语义**：Worker 起不来时必须还能下棋（主线程加载器），但网络类失败
 * （带 `retryable`）刻意不回退——否则一次断网要白等两遍 11 MB。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGame } from '../../src/core/registry.ts';
import { decide } from '../../src/core/jev/index.ts';
import {
  ensureSession,
  glueUrl,
  reset,
  setGlueUrl,
  setLoader,
  setSessionFactory,
} from '../../src/core/jev/rapfi.ts';
import type { ProgressFn } from '../../src/core/jev/rapfi.ts';
import type { RapfiFactory } from '../../src/app/rapfi-loader.ts';
import {
  RAPFI_DATA_URL,
  RAPFI_WASM_URL,
  RAPFI_WORKER_URL,
  createRapfiSession,
  createRapfiWorkerSession,
  fetchRapfiBundle,
  installRapfiWorker,
  resetRapfiWorkerBundle,
} from '../../src/app/rapfi-worker.ts';
import {
  RAPFI_GLUE_URL,
  RAPFI_STALL_TIMEOUT_MS,
} from '../../src/app/rapfi-loader.ts';

const gomoku = getGame('gomoku');
if (!gomoku) throw new Error('注册表里没有 gomoku，夹具失效');

const GLUE_TEXT = 'var Rapfi = function () { return Promise.resolve({}); };';
const WASM_BYTES = 1024;
const DATA_BYTES = 4096;

/* ---------------- 假 Worker：复刻 rapfi-worker.js 的协议 ---------------- */

type OutMsg = {
  type: string;
  id?: number;
  cmd?: string;
  message?: string;
  retryable?: boolean;
  detail?: string;
  lines?: string[];
  glueUrl?: string;
  glueText?: string;
  wasm?: ArrayBuffer;
  data?: ArrayBuffer;
};

class FakeWorker {
  static instances: FakeWorker[] = [];
  /** 每条消息怎么回（默认：init→ready；cmd→OK/7,7）。测试可替换成故障注入。 */
  static responder: ((w: FakeWorker, msg: OutMsg) => void) | null = null;

  url: string;
  terminated = false;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  posted: OutMsg[] = [];
  transfers: (unknown[] | null)[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWorker.instances.push(this);
  }

  postMessage(msg: unknown, transfer?: unknown[]): void {
    const m = msg as OutMsg;
    this.posted.push(m);
    this.transfers.push(transfer ?? null);
    const respond = FakeWorker.responder ?? ((w, mm) => w.defaultRespond(mm));
    /* 真 postMessage 是异步的：这里也用微任务，避免测试掩盖「同步回调」类缺陷 */
    queueMicrotask(() => { if (!this.terminated) respond(this, m); });
  }

  terminate(): void { this.terminated = true; }

  emit(msg: OutMsg): void {
    if (this.onmessage) this.onmessage({ data: msg } as MessageEvent);
  }

  private defaultRespond(msg: OutMsg): void {
    if (msg.type === 'init') { this.emit({ type: 'ready' }); return; }
    if (msg.type === 'cmd') {
      const lines = msg.cmd === 'START 15' ? ['OK'] : (/^BOARD/.test(String(msg.cmd)) ? ['7,7'] : []);
      this.emit({ type: 'lines', id: msg.id, lines });
    }
  }
}

/* ---------------- 假资产响应：走流式分支（fetchAsset 的 reader 路径） ---------------- */

function fakeResponse(bytes: Uint8Array | string, headers: Record<string, string> = {}) {
  const buf = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: buf };
        },
      }),
    },
    text: async () => new TextDecoder().decode(buf),
    arrayBuffer: async () => buf.slice().buffer,
  };
}

/** 把 fetch 换成只服务三份资产的桩，返回被请求过的 URL 序列。 */
function stubAssets(): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (u === RAPFI_GLUE_URL) return fakeResponse(GLUE_TEXT) as unknown as Response;
    if (u === RAPFI_WASM_URL) return fakeResponse(new Uint8Array(WASM_BYTES), { 'content-length': String(WASM_BYTES) }) as unknown as Response;
    if (u === RAPFI_DATA_URL) return fakeResponse(new Uint8Array(DATA_BYTES), { 'content-length': String(DATA_BYTES) }) as unknown as Response;
    throw new Error('不该请求：' + u);
  }));
  return calls;
}

/* ---------------- DOM 注入桩（与 rapfi-loader.spec.ts 同一手法） ---------------- */

const appended: HTMLScriptElement[] = [];
let restoreAppend: (() => void) | null = null;

beforeEach(() => {
  appended.length = 0;
  FakeWorker.instances.length = 0;
  FakeWorker.responder = null;
  const head = document.head;
  const orig = head.appendChild.bind(head);
  head.appendChild = ((node: HTMLScriptElement) => {
    appended.push(node);
    return node;
  }) as typeof head.appendChild;
  restoreAppend = () => { head.appendChild = orig; };
});

afterEach(() => {
  reset();
  setLoader(null);
  setSessionFactory(null);
  setGlueUrl('');
  resetRapfiWorkerBundle();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  FakeWorker.responder = null;
  FakeWorker.instances.length = 0;
  if (restoreAppend) { restoreAppend(); restoreAppend = null; }
});

/** 最近一次注入的胶水脚本（桩不真插 DOM，所以从记录里取）。 */
function injectedScript(): HTMLScriptElement | null {
  const s = appended.length ? appended[appended.length - 1]! : null;
  return s && s.src.endsWith(RAPFI_GLUE_URL) ? s : null;
}

/** 主线程回退路径用的假胶水工厂（START 15 回 OK，拿到 OK 才算就绪）。 */
function fakeGlueFactory() {
  const mods: { sent: string[] }[] = [];
  const factory = (opts: Parameters<RapfiFactory>[0]) => {
    const mod = {
      sent: [] as string[],
      sendCommand(cmd: string): void {
        mod.sent.push(cmd);
        if (cmd === 'START 15') opts.onReceiveStdout('OK');
      },
    };
    mods.push(mod);
    return Promise.resolve(mod);
  };
  return { factory, mods };
}

/* ---------------- 路径派生 ---------------- */

describe('资产路径', () => {
  it('Worker 与两份二进制资产都落在 public/rapfi/ 下，且由胶水文件名派生', () => {
    expect(RAPFI_WORKER_URL).toBe('/rapfi/rapfi-worker.js');
    expect(RAPFI_WASM_URL).toBe('/rapfi/rapfi-single-simd128.wasm');
    expect(RAPFI_DATA_URL).toBe('/rapfi/rapfi-single-simd128.data');
    expect(RAPFI_STALL_TIMEOUT_MS).toBe(30_000);
  });
});

/* ---------------- 资产抓取 ---------------- */

describe('fetchRapfiBundle()', () => {
  it('抓三份资产、把 .wasm 与 .data 的进度播报出来，并在同一页面里缓存', async () => {
    const calls = stubAssets();
    const progress = vi.fn();
    const bundle = await fetchRapfiBundle(progress);

    expect(calls).toEqual([RAPFI_GLUE_URL, RAPFI_WASM_URL, RAPFI_DATA_URL]);
    expect(bundle.glueText).toBe(GLUE_TEXT);
    expect(bundle.wasm.byteLength).toBe(WASM_BYTES);
    expect(bundle.data.byteLength).toBe(DATA_BYTES);
    expect(progress).toHaveBeenCalledWith('wasm');
    expect(progress).toHaveBeenCalledWith('download', expect.stringContaining('下载 Rapfi 引擎资产'));

    /* 同一页面第二次建立会话（换边重开）不该再拉 11 MB */
    await fetchRapfiBundle();
    expect(calls).toHaveLength(3);
  });

  it('资产请求失败带 retryable（接自动退避，不静默）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      body: null,
    }) as unknown as Response));
    const e = (await fetchRapfiBundle().then(() => null, (err: unknown) => err)) as {
      message?: string; retryable?: boolean;
    };
    expect(String(e.message)).toMatch(/Rapfi 胶水脚本请求失败：.*HTTP 404/);
    expect(e.retryable).toBe(true);
  });
});

/* ---------------- 会话建立 ---------------- */

describe('Worker 会话', () => {
  it('init → ready → cmd → lines 全链路，资产用 transfer 交出去', async () => {
    stubAssets();
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);

    const sess = await createRapfiWorkerSession();
    expect(sess.kind).toBe('worker');
    const w = FakeWorker.instances[0]!;
    expect(w.url).toBe(RAPFI_WORKER_URL);

    const init = w.posted[0]!;
    expect(init.type).toBe('init');
    expect(init.glueUrl).toBe(RAPFI_GLUE_URL);
    expect((init as unknown as { glueText: string }).glueText).toBe(GLUE_TEXT);
    expect((init as unknown as { wasm: ArrayBuffer }).wasm.byteLength).toBe(WASM_BYTES);
    expect((init as unknown as { data: ArrayBuffer }).data.byteLength).toBe(DATA_BYTES);
    expect(w.transfers[0]).toHaveLength(2); /* [wasm, data] 零拷贝 */

    await expect(sess.send('BOARD\n7,7,1\nDONE')).resolves.toEqual(['7,7']);
  });

  it('dispose() 终止 Worker、拒绝在途命令、之后的 send 直接失败', async () => {
    stubAssets();
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    const sess = await createRapfiWorkerSession();
    const w = FakeWorker.instances[0]!;

    const inflight = sess.send('INFO timeout_turn 3000');
    sess.dispose?.();
    expect(w.terminated).toBe(true);
    await expect(inflight).rejects.toThrow(/已释放/);
    await expect(sess.send('INFO rule 0')).rejects.toThrow(/已释放/);
  });

  it('Worker 永不回消息时，30 秒停滞看门狗切断（retryable 让自动退避接手）', async () => {
    vi.useFakeTimers();
    stubAssets();
    FakeWorker.responder = () => { /* 假死：正是 .data 卡住时胶水的真实行为 */ };
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);

    const pending = createRapfiWorkerSession();
    const settled: Promise<unknown> = pending.then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RAPFI_STALL_TIMEOUT_MS + 1);
    const e = (await settled) as { message?: string; retryable?: boolean };
    expect(String(e.message)).toMatch(/停滞超过 30 秒/);
    expect(e.retryable).toBe(true);
  });
});

/* ---------------- 回退语义 ---------------- */

describe('回退与不回退', () => {
  it('init-error 带 retryable（网络类）→ 不回退，原样抛给自动退避', async () => {
    stubAssets();
    FakeWorker.responder = (w, msg) => {
      if (msg.type === 'init') w.emit({ type: 'init-error', message: '模拟：资产截断', retryable: true });
    };
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);

    const e = (await createRapfiSession('/x').then(() => null, (err: unknown) => err)) as {
      message?: string; retryable?: boolean;
    };
    expect(String(e.message)).toMatch(/Rapfi Worker 初始化失败/);
    expect(e.retryable).toBe(true);
    expect(appended, '带 retryable 时不该注入胶水脚本（白等两遍 11 MB）').toHaveLength(0);
  });

  it('init-error 不带 retryable（环境类）→ 回退主线程加载器，还能下棋', async () => {
    stubAssets();
    FakeWorker.responder = (w, msg) => {
      if (msg.type === 'init') w.emit({ type: 'init-error', message: '模拟：无法启动思考线程' });
    };
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音 */ });

    expect(installRapfiWorker(), '有 Worker 就装 Worker 路径').toBe(true);
    const pending = ensureSession();
    const script = await vi.waitFor(() => {
      const s = injectedScript();
      if (!s) throw new Error('尚未回退到主线程加载器');
      return s;
    });

    const { factory, mods } = fakeGlueFactory();
    vi.stubGlobal('Rapfi', factory);
    script.onload!.call(script, new Event('load'));

    const sess = await pending;
    expect(sess.kind).toBe('module');
    expect(mods[0]!.sent).toEqual(['START 15', 'INFO rule 0']);
    expect(document.documentElement.dataset.rapfiSession).toBe('main'); /* 回退路径要留痕 */
    expect(warn).toHaveBeenCalled();
  });

  it('环境没有 Worker 时 installRapfiWorker() 返回 false，只装回退路径', async () => {
    vi.stubGlobal('Worker', undefined);
    expect(installRapfiWorker()).toBe(false);
    expect(glueUrl()).toBe(RAPFI_GLUE_URL); /* 回退路径的地址装好了 */

    stubAssets();
    const pending = ensureSession();
    const script = await vi.waitFor(() => {
      const s = injectedScript();
      if (!s) throw new Error('尚未回退到主线程加载器');
      return s;
    });
    const { factory } = fakeGlueFactory();
    vi.stubGlobal('Rapfi', factory);
    script.onload!.call(script, new Event('load'));
    await expect(pending).resolves.toHaveProperty('kind', 'module');
  });
});

/* ---------------- 端到端：装配层 + core 的真实调用链 ---------------- */

describe('decide() 走 Worker（真实调用链）', () => {
  it('install → 资产 → Worker → START/BOARD → 着法；进度阶段与旧路径同名', async () => {
    stubAssets();
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    const progress = vi.fn<ProgressFn>();
    reset();

    expect(installRapfiWorker()).toBe(true);
    const st = gomoku.newGame();
    const d = await decide(gomoku, st, 'black', {
      channel: 'rapfi',
      rapfiThinkMs: 1000,
      rapfiOnProgress: progress,
    });

    expect(d.notation).toBe('H8');
    expect((d.meta as { channel?: string }).channel).toBe('rapfi');
    expect((d.meta as { thinkMs?: number }).thinkMs).toBe(1000);
    /* 冒烟脚本靠这个标记识破「静默回退主线程」（两种路径都能落子，看走子分不出来） */
    expect(document.documentElement.dataset.rapfiSession).toBe('worker');
    /* loop.ts 的状态行映射依赖这三个阶段名（script/wasm/download），改名要同步改 UI */
    expect(progress).toHaveBeenCalledWith('script');
    expect(progress).toHaveBeenCalledWith('wasm');
    expect(progress).toHaveBeenCalledWith('download', expect.stringContaining('下载 Rapfi 引擎资产'));
    const w = FakeWorker.instances[0]!;
    const cmds = w.posted.filter((m) => m.type === 'cmd').map((m) => m.cmd);
    expect(cmds).toContain('START 15');
    expect(cmds).toContain('INFO rule 0');
    expect(cmds.some((c) => /^BOARD/.test(String(c)))).toBe(true);
  });
});
