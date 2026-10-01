/* fixture.ts — `test/app/**` 的共享夹具（不是测试文件，不被 vitest 收集）
 *
 * 装配层测试必须跑在**真实标记**上：面板/抽屉/页签的 DOM 契约在 `index.html` 里，
 * 手抄一份夹具就会与线上标记漂移（P6a 的教训）。所以这里直接读 `index.html`，
 * 把 `<body>` 内容灌进 happy-dom——标记改了，装配测试立刻跟着变。
 *
 * `#board` 的 canvas 在 happy-dom 里拿不到 2D 上下文，故默认注入一个记账用的假渲染器：
 * 既避免绘制抛异常，又能断言「确实按帧推给了画布」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { BoardRenderer, BoardView } from '../../src/ui/board-render.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/** 把 index.html 的 body 标记装进当前 document（返回前会清空旧内容）。 */
export function mountAppHtml(): void {
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (!m) throw new Error('index.html 里找不到 <body>');
  document.body.innerHTML = m[1].replace(/<script[\s\S]*?<\/script>/gi, '');
  document.documentElement.dataset.codeVersion = '';
}

/** 记账渲染器：记录每次 draw 的 view + resize/destroy 次数。 */
export interface FakeRenderer extends BoardRenderer {
  frames: BoardView[];
  resizes: Array<{ w: number; h: number }>;
  destroyed: number;
}

export function fakeRenderer(): FakeRenderer {
  const frames: BoardView[] = [];
  const resizes: Array<{ w: number; h: number }> = [];
  let destroyed = 0;
  return {
    frames,
    resizes,
    get destroyed(): number {
      return destroyed;
    },
    draw(view: BoardView): void {
      frames.push(view);
    },
    resize(w: number, h: number): void {
      resizes.push({ w, h });
    },
    destroy(): void {
      destroyed++;
    },
  } as FakeRenderer;
}

/** 造一份内存 localStorage（可预置键值）。 */
export function seedStorage(seed: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(seed));
}

/** 把 Map 包成 `StorageLike`。 */
export function storageOf(m: Map<string, string>): {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
} {
  return {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      m.set(k, String(v));
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
  };
}

/** 设置键（与 `src/core/persist.ts` 的 `STORE_KEY` 同值：这里是**对照用的字面量**，
 *  故意不 import core，以便「键名被改错」时测试会失败而不是跟着一起改）。 */
export const STORE_KEY = 'jev_qiguan_settings_v2';

/** 造一份可被 boot 读到的设置串（`channel` 默认 mock：离线演示，测试不发网络请求）。 */
export function settingsJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    channel: 'mock',
    mode: 'human-ai',
    speed: 0,
    topK: 3,
    gameSync: false,
    rapfiThinkMs: 3000,
    tacticsVersion: 'v9-vcf-sound',
    endpoints: {},
    sideConfig: { black: {}, white: {} },
    ...patch,
  });
}

/** 轮询等待条件成立（对局循环里有真实定时器，测试要等它跑完几步）。 */
export async function waitUntil(pred: () => boolean, timeoutMs = 4000, what = '条件'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitUntil 超时：' + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 取元素文本（不存在时抛，避免断言静默跳过）。 */
export function text(id: string): string {
  const node = document.getElementById(id);
  if (!node) throw new Error('缺少 #' + id);
  return node.textContent ?? '';
}

/** 取元素是否存在且可见。 */
export function visible(id: string): boolean {
  const node = document.getElementById(id);
  return !!node && !node.hidden && !node.classList.contains('hidden');
}

/** 启动后应当一律不可见的浮层（`index.html` 里初始就带 `class="hidden"`）。 */
export function modalIds(): string[] {
  return ['promoBox', 'drawerMask', 'settingsDrawer'];
}
