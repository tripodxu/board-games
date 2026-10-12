/* rapfi.ts — Rapfi WASM 本地引擎通道（Gomocup 协议）的纯逻辑层。
 *
 * 逐字移植 js/rapfi.js（254 行），唯一的结构改动：**动态注入 Emscripten 胶水脚本**那一段
 * 依赖 `document.createElement('script')`，属 DOM 职责，按硬约束不得进 core。
 * 这里把它收成一个可注入的加载器（`setLoader`）：core 只管协议与状态机，P6 的 UI 层
 * 负责真正的脚本注入，并可通过 `setGlueUrl` 告知胶水脚本的真实地址。
 * 未注入加载器时（Node / 非浏览器环境）抛出与旧实现同一句话的错误，行为等价。
 *
 * 协议要点（以 Rapfi 250615 源码为准，见 docs/adr/0006）：
 *  - 初始化：START 15（回 OK）、INFO rule 0（无禁手）、INFO timeout_turn <ms>
 *  - 每手：BOARD + 多行 "x,y,color" + DONE；color=1 是轮走方（SELF），
 *    color=2 是对方（OPPO）；引擎回一行 "x,y" 即着法。
 *  - 坐标：x=列（0 最左），y=行（0 最顶），与项目记法 A1=(0,0) 一致。
 *  - 单线程构建下 sendCommand 是同步阻塞的：一次调用即走完一整手思考，
 *    时长由 INFO timeout_turn 限定。主线程实现会在这期间冻结 UI，所以装配层默认
 *    注入 **Worker 会话工厂**（`setSessionFactory`，见 src/app/rapfi-worker.ts）：
 *    思考在 Worker 里跑，Worker 不可用或初始化失败才回退主线程加载器。
 */
import type { Engine, Move } from '../types.ts';

export const BOARD_N = 15;
export const GLUE_FILE = 'rapfi/rapfi-single-simd128.js';
export const DEFAULT_THINK_MS = 3000;

/** 引擎坐标（x=列 0 起，y=行 0 起）。 */
export interface XY {
  x: number;
  y: number;
}

/** Emscripten Module 里我们用到的唯一接口。 */
export interface RapfiModule {
  sendCommand(cmd: string): void;
}

/**
 * 加载进度回调。'script' = 注入胶水脚本，'wasm' = 工厂实例化开始，'download' =
 * 胶水自报的资产下载进度文本（Emscripten `setStatus`，形如「Downloading data... (a/b)」）。
 * detail 是给人看的文本，监听方原样展示即可。
 */
export type ProgressFn = (stage: 'script' | 'wasm' | 'download', detail?: string) => void;

/** 胶水脚本加载器：由 UI 层注入（core 里没有 document）。 */
export type RapfiLoader = (url: string, onProgress?: ProgressFn) => Promise<RapfiModule>;

/** 已就绪的引擎会话：发一条协议命令，取回**本次新增**的 stdout 行。
 *  同步实现（主线程 Module，`sendCommand` 同步阻塞）与异步实现（Worker，postMessage）
 *  都行——core 一律 await，于是「思考搬进 Worker」对协议层完全透明。
 *  `kind` 只供诊断与测试断言，不参与决策；`dispose` 用来释放底层资源（Worker 会 terminate）。 */
export interface RapfiSession {
  send(cmd: string): string[] | Promise<string[]>;
  kind?: 'module' | 'worker' | 'main';
  dispose?(): void;
}

/** 会话工厂：装配层实现（Worker 版 Rapfi）。返回的会话**尚未** START——
 *  初始化（START 15 / INFO rule 0）由 core 统一做，两条来源的行为才不会漂。 */
export type RapfiSessionFactory = (url: string, onProgress?: ProgressFn) => Promise<RapfiSession>;

export interface RapfiOpts {
  thinkMs?: number;
  signal?: { aborted: boolean };
  onProgress?: ProgressFn;
}

export interface RapfiDecision {
  notation: string;
  move: Move;
  meta: {
    channel: 'rapfi';
    engine: 'Rapfi';
    thinkMs: number;
    /** 恒 null：Rapfi 是完整搜索引擎，刻意不过 Jev 战术层（保证「Rapfi vs Jev」变量纯净）。
     *  记 null 而不是 0，统计战术层平均耗时时才能自动把它排除在样本外。 */
    tacticsMs: null;
    xy: string;
  };
}

/* 胶水脚本地址：旧实现用 document.currentScript.src 反推 rapfi/ 目录；
   core 不能碰 DOM，改由 UI 层显式告知（默认相对页面路径，与原实现退化分支一致）。 */
let _glueUrl = GLUE_FILE;

/** 由 UI 层设置胶水脚本地址（旧 glueUrl() 的等价物）。 */
export function setGlueUrl(url: string): void {
  _glueUrl = url || GLUE_FILE;
}

/** 当前胶水脚本地址。 */
export function glueUrl(): string {
  return _glueUrl;
}

/* ---------------- 加载器 / 会话注入 ---------------- */

let _loader: RapfiLoader | null = null;
let _sessionFactory: RapfiSessionFactory | null = null;

/** 注入胶水脚本加载器（UI 层实现 document 注入；Node 下不注入）。 */
export function setLoader(fn: RapfiLoader | null): void {
  _loader = fn;
  _sessionPromise = null; /* 换加载器等于换引擎来源，丢弃进行中的加载 */
}

/** 注入会话工厂（装配层把 Worker 版 Rapfi 接进来的入口，见 src/app/rapfi-worker.ts）。
 *  工厂优先于 `_loader`；工厂自己负责在 Worker 不可用时回退到主线程加载器。 */
export function setSessionFactory(fn: RapfiSessionFactory | null): void {
  _sessionFactory = fn;
  _sessionPromise = null;
}

/* ---------------- 纯函数（无 DOM、无引擎，可单测） ---------------- */

/** 记法 "H8" -> { x: 7, y: 7 }；非法返回 null。 */
export function notationToXY(notation: unknown): XY | null {
  if (typeof notation !== 'string') return null;
  const m = /^([A-Oa-o])([1-9]|1[0-5])$/.exec(notation.trim());
  if (!m) return null;
  return { x: m[1]!.toUpperCase().charCodeAt(0) - 65, y: parseInt(m[2]!, 10) - 1 };
}

/** { x, y } -> 记法 "H8"；越界返回 null。 */
export function xyToNotation(x: unknown, y: unknown): string | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if ((x as number) < 0 || (x as number) >= BOARD_N || (y as number) < 0 || (y as number) >= BOARD_N) return null;
  return String.fromCharCode(65 + (x as number)) + ((y as number) + 1);
}

/** 从 st.board 重建 BOARD 命令块（单字符串，多行以 \n 连接）。
 * 颜色是相对引擎的：1=SELF（轮走方 side 的子），2=OPPO。
 * 落子按 SELF/OPPO 交替排列且首子为 SELF：Rapfi 按顺序重放落子并用
 * PASS 对齐轮走方；若同色连排，插入的 PASS 会打乱最终轮走方。
 * 交替排列时：黑走 B==W 恰好用完；白走黑多一子，末尾单 OPPO 子恰好
 * 对上期望轮走方，全程不触发 PASS，终局轮走方恒正确。 */
export function buildBoardCommand(st: { board: number[][] }, side: string): string {
  const selfVal = side === 'black' ? 1 : 2;
  const selfStones: string[] = [];
  const oppoStones: string[] = [];
  const board = st.board;
  for (let r = 0; r < BOARD_N; r++) {
    for (let c = 0; c < BOARD_N; c++) {
      const v = board[r] && board[r]![c];
      if (v === selfVal) selfStones.push(c + ',' + r + ',1');
      else if (v === 1 || v === 2) oppoStones.push(c + ',' + r + ',2');
    }
  }
  const lines = ['BOARD'];
  let i = 0, j = 0, selfTurn = true;
  while (i < selfStones.length || j < oppoStones.length) {
    if (selfTurn) {
      if (i < selfStones.length) lines.push(selfStones[i++]!);
      else lines.push(oppoStones[j++]!);
    } else {
      if (j < oppoStones.length) lines.push(oppoStones[j++]!);
      else lines.push(selfStones[i++]!);
    }
    selfTurn = !selfTurn;
  }
  lines.push('DONE');
  return lines.join('\n');
}

/** 解析引擎输出行：只认严格的 "x,y"，OK/MESSAGE/ERROR/INFO 等一律忽略。
 * 返回 { x, y } 或 null。 */
export function parseMoveLine(line: unknown): XY | null {
  if (typeof line !== 'string') return null;
  const m = /^\s*(\d{1,2})\s*,\s*(\d{1,2})\s*$/.exec(line);
  if (!m) return null;
  const x = parseInt(m[1]!, 10), y = parseInt(m[2]!, 10);
  if (x < 0 || x >= BOARD_N || y < 0 || y >= BOARD_N) return null;
  return { x: x, y: y };
}

/** 是否为引擎错误行（ERROR 开头）。 */
export function isErrorLine(line: unknown): boolean {
  return typeof line === 'string' && /^\s*ERROR\b/.test(line);
}

/* ---------------- 引擎实例管理 ---------------- */

let _module: RapfiModule | null = null;      // 就绪的 Emscripten Module（注入的或 loader 产出的）
let _session: RapfiSession | null = null;    // 就绪的会话（Module 会话或 Worker 会话）
let _sessionPromise: Promise<RapfiSession> | null = null; // 进行中的会话建立 Promise（并发复用）
let _stdoutLines: string[] = [];             // 主线程 Module 的全部 stdout 行（含 OK/MESSAGE 等）

/** 引擎输出行入口（loader 把它接到 Module 的 onReceiveStdout 上）。 */
export function onStdout(line: unknown): void {
  _stdoutLines.push(String(line));
}

function _onStderr(line: unknown): void {
  try { if (typeof console !== 'undefined') console.warn('[rapfi:stderr]', line); } catch (_) { /* ignore */ }
}

/** 供 UI 层把 loader 接到 Module 的回调上（旧实现闭包内的私有函数）。 */
export const stderrHandler = _onStderr;

/** 把已就绪的 Emscripten Module 包成会话。语义与旧 `_send` 完全一致：
 *  `sendCommand` 同步阻塞，返回「本次调用新增的 stdout 行」。
 *  主线程 loader 路径与装配层回退路径共用这一份实现。 */
export function sessionFromModule(m: RapfiModule): RapfiSession {
  return {
    kind: 'module',
    send(cmd: string): string[] {
      if (!m || typeof m.sendCommand !== 'function')
        throw new Error('Rapfi 引擎尚未就绪');
      const mark = _stdoutLines.length;
      m.sendCommand(cmd);
      return _stdoutLines.slice(mark);
    },
  };
}

/** 给错误打 `retryable`（网络/资产类失败应触发装配层的自动退避）。 */
function retryableError(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  (err as Error & { retryable?: boolean }).retryable = true;
  return err;
}

/** 建立并初始化引擎会话。onProgress 可选回调('script'|'wasm'|'download', detail?)。
 *
 *  来源优先级：注入的 `_module`（测试快速路径，**不发 START**，注入者视为已就绪）
 *  → 注入的会话工厂（Worker 版）→ 胶水加载器（主线程回退）。
 *  并发调用复用同一 Promise；失败后清零以允许重试（网络类错误带 `retryable`，
 *  装配层的自动退避会接住——2026-10-06 前 load 路径的错误从不打这个标）。 */
export function ensureSession(onProgress?: ProgressFn): Promise<RapfiSession> {
  if (_session) return Promise.resolve(_session);
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = new Promise<RapfiSession>((resolve, reject) => {
    if (_module) { resolve(sessionFromModule(_module)); return; }
    const url = glueUrl();
    if (typeof onProgress === 'function') { try { onProgress('script'); } catch (_) { /* ignore */ } }

    /* 两条来源拿到会话后走同一段初始化；初始化失败视为引擎不可用（不可重试）。 */
    const boot = (p: Promise<RapfiSession>): void => {
      p.then((sess) => {
        Promise.resolve()
          .then(() => sess.send('START 15'))
          .then((initOut) => {
            if (!initOut.some((l) => /^\s*OK\s*$/.test(l)))
              throw new Error('引擎 START 无 OK 回应：' + initOut.join('|'));
            return sess.send('INFO rule 0'); // 无禁手自由五子棋
          })
          .then(() => { _session = sess; resolve(sess); },
                (e: unknown) => {
                  try { if (sess.dispose) sess.dispose(); } catch (_) { /* ignore */ }
                  _module = null;
                  reject(e);
                });
      }, reject);
    };

    if (_sessionFactory) { boot(_sessionFactory(url, onProgress)); return; }
    if (!_loader) {
      reject(new Error('当前环境不支持动态加载 Rapfi 脚本（无 document）'));
      return;
    }
    boot(_loader(url, onProgress).then((mod) => {
      if (!mod || typeof mod.sendCommand !== 'function')
        throw new Error('Rapfi 胶水脚本未导出工厂函数 Rapfi：' + url);
      _module = mod;
      return sessionFromModule(mod);
    }, (e: unknown) => {
      throw retryableError(new Error('Rapfi 脚本加载失败：' + url + '（需经 HTTP 提供，且 .data/.wasm 与脚本同源可访问）'
        + (e && (e as Error).message ? '：' + (e as Error).message : '')));
    }));
  });
  _sessionPromise.then(null, () => { _sessionPromise = null; });
  return _sessionPromise;
}

/** 旧名（返回类型已从 Module 改为会话）：保留给既有装配层调用点与旧测试。
 *  新代码请直接用 `ensureSession`。 */
export const ensureLoaded = ensureSession;

/* ---------------- 决策 ---------------- */

/** 走一步棋。opts: { thinkMs?, signal? }。
 * 返回 { notation, move, meta }；meta.channel 恒为 'rapfi'。
 * 引擎无响应（未返回着法行）时抛错，由调用方按现有错误路径处理。 */
export async function decide(
  engine: Engine | null | undefined,
  st: { board: number[][]; turn?: string },
  side: string,
  legal: Move[] | null,
  _ser: unknown,
  opts?: RapfiOpts | null,
): Promise<RapfiDecision> {
  if (!engine || engine.id !== 'gomoku')
    throw new Error('rapfi 渠道仅支持五子棋引擎');
  const o = opts || {};
  if (o.signal && o.signal.aborted) throw new Error('aborted');
  const thinkMs = Math.max(500, Math.min(60000, o.thinkMs || DEFAULT_THINK_MS));

  const sess = await ensureSession(o.onProgress);
  if (o.signal && o.signal.aborted) throw new Error('aborted');

  /* 让出事件循环一拍，使「思考中」指示先 paint（主线程会话的 sendCommand 是同步阻塞的；
     Worker 会话本来就异步，这一拍无害） */
  await new Promise<void>((r) => { setTimeout(r, 0); });
  if (o.signal && o.signal.aborted) throw new Error('aborted');

  const boardCmd = buildBoardCommand(st, side);
  let fresh: string[];
  try {
    await sess.send('INFO timeout_turn ' + thinkMs);
    fresh = await sess.send(boardCmd);
  } catch (e) {
    throw new Error('Rapfi 引擎调用失败：' + (e && (e as Error).message || e));
  }

  let moveXY: XY | null = null;
  const errLines: string[] = [];
  for (let i = 0; i < fresh.length; i++) {
    const p = parseMoveLine(fresh[i]);
    if (p) moveXY = p; // 取最后一个着法行
    else if (isErrorLine(fresh[i])) errLines.push(fresh[i]!);
  }
  if (!moveXY) {
    throw new Error('Rapfi 引擎无响应（未返回着法）' +
      (errLines.length ? '：' + errLines.join(' | ') : ''));
  }

  const notation = xyToNotation(moveXY.x, moveXY.y);
  const byNotation = new Map<string, Move>((legal || []).map((m) => [m.notation, m]));
  const move = notation && byNotation.get(notation);
  if (!move) {
    throw new Error('Rapfi 返回非法着法：' + (notation || moveXY.x + ',' + moveXY.y));
  }
  return {
    notation: notation as string,
    move: move,
    meta: {
      channel: 'rapfi',
      engine: 'Rapfi',
      thinkMs: thinkMs,
      tacticsMs: null,
      xy: moveXY.x + ',' + moveXY.y,
    },
  };
}

/* ---------------- 测试钩子（旧实现挂在 BG.rapfi 上的同名出口） ---------------- */

/** 测试：模拟引擎输出行。 */
export const emitStdout = onStdout;

/** 测试：注入假 Module（跳过加载器）。 */
export function setModule(m: RapfiModule | null): void {
  _disposeSession();
  _session = null;
  _sessionPromise = null;
  _module = m;
}

/** 测试：清空引擎状态。 */
export function reset(): void {
  _disposeSession();
  _session = null;
  _sessionPromise = null;
  _module = null;
  _stdoutLines = [];
}

/** 释放当前会话（Worker 会话会 terminate）。 */
function _disposeSession(): void {
  const s = _session;
  if (s && s.dispose) { try { s.dispose(); } catch (_) { /* ignore */ } }
}

/** 汇总出口，对应旧实现的 `BG.rapfi` 命名空间。 */
export const rapfi = {
  ensureLoaded,
  ensureSession,
  sessionFromModule,
  decide,
  notationToXY,
  xyToNotation,
  buildBoardCommand,
  parseMoveLine,
  isErrorLine,
  glueUrl,
  setGlueUrl,
  setLoader,
  setSessionFactory,
  stderrHandler,
  emitStdout,
  setModule,
  reset,
};
