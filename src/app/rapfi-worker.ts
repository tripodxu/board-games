/* rapfi-worker.ts — 把 Rapfi 的思考搬进 Web Worker（装配层）。
 *
 * 动机（docs/status.md 已知限制 #5 剩下的主体）：Rapfi 的 `sendCommand` 是**同步阻塞**的，
 * 在主线程里一次思考就冻结 UI 一整手（10s 档每手冻约 10 秒：暂停/停止/认输都按不动，
 * 「思考中」指示也不转）。搬到 Worker 后主线程只等消息。
 *
 * 机制（为什么长这样）：
 *  ① Worker 脚本是**手写 classic worker**（`public/rapfi/rapfi-worker.js`，刻意不进打包）：
 *     胶水是普通脚本（`var Rapfi=…`），classic worker 里 `importScripts` 才能把它挂成
 *     worker 全局；Vite 的 `?worker` 在 dev 一律产出 module worker，而 module worker 禁
 *     `importScripts`（见 node_modules/vite/dist/node/chunks/node.js:26121），dev 与线上
 *     行为会不一致，所以不用打包版。
 *  ② **资产字节仍在页面上下文抓取**（fetch 胶水文本 / .wasm / .data，带进度），再 postMessage
 *     交给 Worker：CDP 的 Fetch 拦截**按 target** 生效，两个自动化 harness
 *     （scripts/browser-smoke.mjs、scripts/experiment-run.mjs）靠它把 `/rapfi/*` 改由本地
 *     `public/rapfi/` 供给（本机到线上拉 10 MB 资产曾实测 22 KB/s，整轮实验卡死在第 1 局）。
 *     若让 Worker 自己发请求，那条捷径就失效了。
 *  ③ Worker 不可用或初始化失败时**回退主线程加载器**（rapfi-loader.ts）：界面会重新卡，
 *     但还能下棋。带 `retryable` 的网络类失败**不回退**——让装配层的自动退避原样重试
 *     Worker 路径（否则要白等两遍 11 MB）。
 */
import { GLUE_FILE, sessionFromModule, setSessionFactory } from '../core/jev/rapfi.ts';
import type { ProgressFn, RapfiSession } from '../core/jev/rapfi.ts';
import {
  RAPFI_ASSET_BASE, RAPFI_GLUE_URL, RAPFI_STALL_TIMEOUT_MS, installRapfiLoader, loadRapfiModule,
} from './rapfi-loader.ts';

/** Worker 脚本的部署路径（`public/rapfi/rapfi-worker.js`）。 */
export const RAPFI_WORKER_URL = '/rapfi/rapfi-worker.js';

/* 资产文件名由胶水文件名派生（rapfi-single-simd128.js → .wasm / .data），
   免得两处硬编码漂移；Worker 里的 `locateFile` 仍指同一目录。 */
const GLUE_BASENAME = GLUE_FILE.slice(GLUE_FILE.lastIndexOf('/') + 1).replace(/\.js$/, '');
export const RAPFI_WASM_URL = RAPFI_ASSET_BASE + GLUE_BASENAME + '.wasm';
export const RAPFI_DATA_URL = RAPFI_ASSET_BASE + GLUE_BASENAME + '.data';

/** 交给 Worker 的三份字节（胶水文本 + 两个二进制资产）。 */
export interface RapfiWorkerBundle {
  glueText: string;
  wasm: ArrayBuffer;
  data: ArrayBuffer;
}

/** Worker → 主线程的消息。 */
type WorkerOut =
  | { type: 'ready' }
  | { type: 'init-error'; message: string; retryable?: boolean }
  | { type: 'progress'; stage?: string; detail: string }
  | { type: 'stderr'; line: string }
  | { type: 'lines'; id: number; lines: string[] }
  | { type: 'cmd-error'; id: number; message: string };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 给错误打 `retryable`（网络/资产类失败应触发自动退避，而不是回退主线程再白等一遍 11 MB）。 */
function retryableError(e: unknown): Error & { retryable?: boolean } {
  const err = (e instanceof Error ? e : new Error(String(e))) as Error & { retryable?: boolean };
  err.retryable = true;
  return err;
}

function stallError(): Error & { retryable?: boolean } {
  return retryableError(new Error(
    `Rapfi 资产下载停滞超过 ${Math.round(RAPFI_STALL_TIMEOUT_MS / 1000)} 秒（网络中断或目标不可达）`,
  ));
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

/* ---------------- 资产抓取（页面上下文，保留 harness 的本地供给捷径） ---------------- */

let _bundle: RapfiWorkerBundle | null = null;

/** 丢弃已缓存的资产字节（测试用）。 */
export function resetRapfiWorkerBundle(): void {
  _bundle = null;
}

/** 取一条资产；`beat` 是停滞看门狗的心跳（每个分片都拍一次）。 */
async function fetchAsset(url: string, beat: (received: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw retryableError(new Error(`Rapfi 资产请求失败：${url} → HTTP ${res.status}`));
  const total = Number(res.headers.get('content-length') || 0) || 0;
  const body = res.body;
  const reader = body && typeof body.getReader === 'function' ? body.getReader() : null;
  if (!reader) return await res.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    if (step.value) {
      chunks.push(step.value);
      received += step.value.length;
      beat(received, total);
    }
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

/** 三份资产一次性取回并缓存（同一页面内多种会话复用；HTTP 缓存语义与旧路径一致，
 *  刻意**不给** `cache` 选项，免得绕过 `_headers` 里的 24h 策略）。 */
export async function fetchRapfiBundle(onProgress?: ProgressFn, kick?: () => void): Promise<RapfiWorkerBundle> {
  if (_bundle) return _bundle;
  const beat = (): void => { if (kick) kick(); };
  const res = await fetch(RAPFI_GLUE_URL);
  if (!res.ok) throw retryableError(new Error(`Rapfi 胶水脚本请求失败：${RAPFI_GLUE_URL} → HTTP ${res.status}`));
  const glueText = await res.text();
  beat();
  if (typeof onProgress === 'function') { try { onProgress('wasm'); } catch (_) { /* ignore */ } }
  const wasm = await fetchAsset(RAPFI_WASM_URL, beat);
  beat();
  const data = await fetchAsset(RAPFI_DATA_URL, (received, total) => {
    beat();
    if (typeof onProgress === 'function') {
      try {
        onProgress('download', '下载 Rapfi 引擎资产 ' + mb(received) + '/' + (total ? mb(total) : '?') + ' MB');
      } catch (_) { /* ignore */ }
    }
  });
  _bundle = { glueText, wasm, data };
  return _bundle;
}

/* ---------------- Worker 会话 ---------------- */

/** 起一个 Worker 并把资产交给它，等它回 `ready`。
 *  初始化期间的停滞看门狗与 `rapfi-loader.ts` 同一口径（任何进度/心跳都重置计时）。 */
export function createRapfiWorkerSession(onProgress?: ProgressFn): Promise<RapfiSession> {
  return new Promise<RapfiSession>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = (): void => { if (timer) { clearTimeout(timer); timer = null; } };
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const kick = (): void => {
      if (settled) return;
      clearTimer();
      timer = setTimeout(() => fail(stallError()), RAPFI_STALL_TIMEOUT_MS);
    };
    kick();

    fetchRapfiBundle(onProgress, kick).then((bundle) => {
      if (settled) return;
      let worker: Worker;
      try {
        worker = new Worker(RAPFI_WORKER_URL);
      } catch (e) {
        fail(new Error('Rapfi Worker 创建失败：' + errText(e)));
        return;
      }

      const pending = new Map<number, { resolve: (v: string[]) => void; reject: (e: unknown) => void }>();
      let seq = 0;
      let dead = false;
      /* 会话作废：拒绝所有在途命令。Worker 被 terminate 后 postMessage 不会报错，
         所以必须靠 `dead` 标记把「已经没人在听」显式变成错误，不能挂着等。 */
      const kill = (e: Error): void => {
        dead = true;
        clearTimer();
        for (const p of pending.values()) p.reject(e);
        pending.clear();
      };

      const session: RapfiSession = {
        kind: 'worker',
        send(cmd: string): Promise<string[]> {
          if (dead) return Promise.reject(new Error('Rapfi Worker 会话已释放'));
          const id = ++seq;
          return new Promise<string[]>((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            try {
              worker.postMessage({ type: 'cmd', id, cmd });
            } catch (e) {
              pending.delete(id);
              rej(new Error('Rapfi Worker 通信失败：' + errText(e)));
            }
          });
        },
        dispose(): void {
          if (dead) return;
          kill(new Error('Rapfi Worker 会话已释放'));
          try { worker.postMessage({ type: 'dispose' }); } catch (_) { /* ignore */ }
          try { worker.terminate(); } catch (_) { /* ignore */ }
        },
      };

      worker.onmessage = (ev: MessageEvent): void => {
        const msg = ev.data as WorkerOut | null;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimer();
          resolve(session);
          return;
        }
        if (msg.type === 'init-error') {
          /* 初始化失败**不默认重试**：Worker 侧判定为网络类时才会带 retryable 上来 */
          const e = new Error('Rapfi Worker 初始化失败：' + msg.message) as Error & { retryable?: boolean };
          if (msg.retryable) e.retryable = true;
          try { worker.terminate(); } catch (_) { /* ignore */ }
          fail(e);
          return;
        }
        if (msg.type === 'progress') {
          kick();
          if (typeof onProgress === 'function') {
            try { onProgress('download', String(msg.detail)); } catch (_) { /* ignore */ }
          }
          return;
        }
        if (msg.type === 'stderr') {
          try { if (typeof console !== 'undefined') console.warn('[rapfi:stderr]', msg.line); } catch (_) { /* ignore */ }
          return;
        }
        if (msg.type === 'lines') {
          const p = pending.get(msg.id);
          if (p) { pending.delete(msg.id); p.resolve(msg.lines || []); }
          return;
        }
        if (msg.type === 'cmd-error') {
          const p = pending.get(msg.id);
          if (p) { pending.delete(msg.id); p.reject(new Error(msg.message)); }
        }
      };
      worker.onerror = (ev: ErrorEvent): void => {
        const e = retryableError(new Error('Rapfi Worker 运行错误：' + (ev && (ev.message || ev.type) ? (ev.message || ev.type) : '未知')));
        try { worker.terminate(); } catch (_) { /* ignore */ }
        kill(e);
        fail(e);
      };

      /* 资产字节走 transfer 交给 Worker（零拷贝）；缓存里还是同一份，所以先复制再交出去。 */
      const wasm = bundle.wasm.slice(0);
      const data = bundle.data.slice(0);
      try {
        worker.postMessage({
          type: 'init',
          glueUrl: RAPFI_GLUE_URL,
          assetBase: RAPFI_ASSET_BASE,
          glueText: bundle.glueText,
          wasm: wasm,
          data: data,
        }, [wasm, data]);
      } catch (e) {
        try { worker.terminate(); } catch (_) { /* ignore */ }
        fail(new Error('Rapfi Worker 初始化消息发送失败：' + errText(e)));
      }
    }, fail);
  });
}

/** 把「本局 Rapfi 实际走的哪条路」写到 `<html data-rapfi-session>`。
 *
 *  Worker 化最容易的失败方式是**静默回退主线程**（界面重新卡住、其余一切正常），
 *  只看「对手落子」是分不出来的：冒烟照样全绿，而限制 #5 其实没解决。
 *  装配层是唯一允许碰 DOM 的地方，所以标记在这里打，由
 *  `scripts/browser-smoke.mjs --channel rapfi` 断言真的走了 Worker。 */
export function markRapfiSession(kind: 'worker' | 'main'): void {
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.dataset.rapfiSession = kind;
    }
  } catch (_) { /* ignore */ }
}

/** 会话工厂实现（core 的 `setSessionFactory` 用它）：Worker 优先，失败回退主线程。
 *  `_url` 是 core 传来的胶水地址，这里忽略——资产路径由上面的派生常量决定。 */
export async function createRapfiSession(_url: string, onProgress?: ProgressFn): Promise<RapfiSession> {
  if (typeof Worker !== 'function') {
    markRapfiSession('main');
    return sessionFromModule(await loadRapfiModule(RAPFI_GLUE_URL, onProgress));
  }
  try {
    const session = await createRapfiWorkerSession(onProgress);
    markRapfiSession('worker');
    return session;
  } catch (e) {
    const rt = e as { retryable?: boolean } | null;
    if (rt && rt.retryable) throw e;
    try {
      if (typeof console !== 'undefined')
        console.warn('[rapfi] Worker 初始化失败，回退主线程（思考期间界面会短暂卡住）：', e);
    } catch (_) { /* ignore */ }
    markRapfiSession('main');
    return sessionFromModule(await loadRapfiModule(RAPFI_GLUE_URL, onProgress));
  }
}

/** 装配层入口：装 Worker 会话工厂（同时装好主线程回退路径，幂等）。
 *  返回是否装上了 Worker 路径——`false` 表示这个环境没有 Worker，只有回退路径。 */
export function installRapfiWorker(): boolean {
  installRapfiLoader();
  if (typeof Worker !== 'function') return false;
  setSessionFactory(createRapfiSession);
  return true;
}
