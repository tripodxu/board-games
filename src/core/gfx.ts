/* gfx.ts — canvas 绘制辅助（迁移自 js/board.js 的 BG.gfx）
 *
 * 为什么放在 core：这些函数**零 DOM 依赖**（只用传进来的 2d 上下文对象），
 * 旧文件注释也明说「可在 Node 中加载做自检」。P6 的 ui/board-render.ts 会把
 * 浏览器侧的 `canvas.getContext('2d')` 接进来；core 只声明结构类型，不碰全局 DOM。
 * 导入本模块时**不会有任何 DOM 访问**（方法体内的 DOM 取值都在调用时发生）。
 */

/** 绘制用到的 2d 上下文最小结构（不引用 DOM 的 CanvasRenderingContext2D）。 */
export interface Canvas2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  arc(x: number, y: number, r: number, s: number, e: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  fillText(str: string, x: number, y: number): void;
}

/** gfx.setup 接受的 canvas 最小结构（宽高 + 样式 + 取上下文）。 */
export interface CanvasLike {
  width: number;
  height: number;
  style: Record<string, string>;
  _logicalW?: number;
  _logicalH?: number;
  getContext(id: '2d'): Canvas2D;
}

/** gfx.text 的选项。 */
export interface TextOpts {
  size?: number;
  color?: string;
  align?: string;
  baseline?: string;
  bold?: boolean;
}

/** 绘制辅助集合（与旧 BG.gfx 方法一一对应）。 */
export interface Gfx {
  setup(canvas: CanvasLike, w: number, h: number): Canvas2D;
  clear(ctx: Canvas2D, w: number, h: number, color?: string): void;
  intersections(ctx: Canvas2D, x0: number, y0: number, cell: number, cols: number, rows: number, color?: string): void;
  cells(
    ctx: Canvas2D, x0: number, y0: number, size: number, cols: number, rows: number,
    darkFn?: ((r: number, c: number) => boolean) | null, darkColor?: string,
  ): void;
  stone(ctx: Canvas2D, x: number, y: number, r: number, color: string, isLast?: boolean | null): void;
  disc(ctx: Canvas2D, x: number, y: number, r: number, fill: string, stroke?: string, label?: string, labelColor?: string): void;
  text(ctx: Canvas2D, str: string, x: number, y: number, opts?: TextOpts): void;
  highlight(ctx: Canvas2D, x: number, y: number, r: number, color?: string): void;
}

/** HiDPI canvas 初始化，返回 2d ctx（逻辑像素坐标绘制）。 */
function setup(canvas: CanvasLike, w: number, h: number): Canvas2D {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas._logicalW = w;
  canvas._logicalH = h;
  /* 宽度定值 + 高度 auto：窄屏时 max-width 收缩并保持纵横比 */
  canvas.style.width = w + 'px';
  canvas.style.height = 'auto';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function clear(ctx: Canvas2D, w: number, h: number, color?: string): void {
  ctx.fillStyle = color || '#FAFBFD';
  ctx.fillRect(0, 0, w, h);
}

/* 交叉点网格（五子棋/围棋） */
function intersections(
  ctx: Canvas2D, x0: number, y0: number, cell: number, cols: number, rows: number, color?: string,
): void {
  ctx.strokeStyle = color || '#3A4048';
  ctx.lineWidth = 1;
  for (let i = 0; i < cols; i++) {
    const x = x0 + i * cell;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + (rows - 1) * cell); ctx.stroke();
  }
  for (let j = 0; j < rows; j++) {
    const y = y0 + j * cell;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + (cols - 1) * cell, y); ctx.stroke();
  }
}

/* 方格棋盘（国际象棋/象棋/跳棋），可给部分格子填色 */
function cells(
  ctx: Canvas2D, x0: number, y0: number, size: number, cols: number, rows: number,
  darkFn?: ((r: number, c: number) => boolean) | null, darkColor?: string,
): void {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (darkFn && darkFn(r, c)) {
        ctx.fillStyle = darkColor || '#D9DEE5';
        ctx.fillRect(x0 + c * size, y0 + r * size, size, size);
      }
    }
  }
  ctx.strokeStyle = '#3A4048'; ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, cols * size, rows * size);
  for (let i = 1; i < cols; i++) {
    ctx.beginPath(); ctx.moveTo(x0 + i * size, y0); ctx.lineTo(x0 + i * size, y0 + rows * size); ctx.stroke();
  }
  for (let j = 1; j < rows; j++) {
    ctx.beginPath(); ctx.moveTo(x0, y0 + j * size); ctx.lineTo(x0 + cols * size, y0 + j * size); ctx.stroke();
  }
}

function stone(ctx: Canvas2D, x: number, y: number, r: number, color: string, isLast?: boolean | null): void {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color === 'black' ? '#1F242C' : '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = color === 'black' ? '#0E1116' : '#9AA3AD';
  ctx.lineWidth = 1; ctx.stroke();
  if (isLast) {
    ctx.beginPath(); ctx.arc(x, y, r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = color === 'black' ? '#E4E8ED' : '#C2402A';
    ctx.fill();
  }
}

function disc(
  ctx: Canvas2D, x: number, y: number, r: number, fill: string,
  stroke?: string, label?: string, labelColor?: string,
): void {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
  if (label) {
    ctx.fillStyle = labelColor || '#fff';
    ctx.font = 'bold ' + Math.round(r * 1.15) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + r * 0.06);
  }
}

function text(ctx: Canvas2D, str: string, x: number, y: number, opts?: TextOpts): void {
  const o = opts || {};
  ctx.fillStyle = o.color || '#8A939E';
  ctx.font = (o.bold ? 'bold ' : '') + (o.size || 11) + 'px sans-serif';
  ctx.textAlign = o.align || 'center';
  ctx.textBaseline = o.baseline || 'middle';
  ctx.fillText(str, x, y);
}

function highlight(ctx: Canvas2D, x: number, y: number, r: number, color?: string): void {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = color || 'rgba(31,36,44,.85)';
  ctx.lineWidth = 2.5; ctx.stroke();
}

/** 绘制辅助集合（与旧 BG.gfx 逐方法等价）。 */
export const gfx: Gfx = { setup, clear, intersections, cells, stone, disc, text, highlight };
