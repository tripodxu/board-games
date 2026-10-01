/* board-render.ts — 棋盘 canvas 渲染器（迁移自 js/board.js 的 gfx 用法 + js/app.js 的 redraw 调用点）
 *
 * 旧实现的绘制路径只有两处（js/app.js:479 与 js/app.js:497-499）：
 *   `S.ctx = BG.gfx.setup($('board'), engine.meta.w, engine.meta.h)`   ← 尺寸/DPR/变换
 *   `S.engine.draw(S.ctx, S.st, S.ui)`                                  ← 全部棋盘绘制
 * 也就是说：**网格、棋子、最后一手标记、走子高亮、选中格都由各引擎自己的
 * `draw(ctx, st, ui)` 用 `BG.gfx.*` 画**（如 src/core/engines/gomoku.ts:604 的
 * `gfx.stone(..., !!st.last && …)`，src/core/engines/xiangqi.ts:301-302 的 `gfx.highlight`），
 * 常量口径在 `src/core/gfx.ts`（只读，逐字保留）。因此本模块是**薄封装**：
 *   - 只管 canvas 生命周期：DPR 缩放、逻辑坐标、resize、销毁；
 *   - 只转发 `engine.draw()`，绝不新增绘制层，也绝不重算坐标。
 *
 * 刻意差异（与旧实现不一致的地方，逐条）：
 *  1. 旧实现里「棋盘交互态」`S.ui` 是会话对象的一个字段（js/app.js:13）；
 *     按 P6 约定（`src/core/session.ts` 头注第 2 条）`ui` **归 ui 层**，这里由调用方
 *     每次 `draw({engine, state, ui})` 传入，渲染器不持有它。
 *  2. 尺寸不再由调用方在 resetSession 里显式 setup：`draw()` 第一次拿到引擎元数据
 *     （`engine.meta.w/h`）时自动 `resize()`，复刻旧 `resetSession()` 的效果；显式
 *     `resize(w, h)` 仍然可用（换棋盘尺寸/窗口变化/复盘墙）。
 *  3. **没有「胜线高亮」这一层**：旧实现里没有任何地方画胜线（grep `js/` 与
 *     `src/core/engines/*` 均无胜线绘制），终局只改 `#turnBadge` 文案。若后续要加，
 *     应在引擎 `draw()` 内加（保持「一个棋种一处绘制」），不要塞进本模块。
 *  4. 引擎实例与 `draw()` 由注入参数给出：本模块不 import 任何具体引擎，也不碰注册表，
 *     便于 `src/app/**` 用 `registry.getGame(gameId)` 取回实例后装配。
 *
 * 本模块不 import node:*，不碰 localStorage / fetch；只依赖 DOM + `src/core/gfx.ts`。
 */
import { gfx } from '../core/gfx.ts';
import type { Canvas2D, CanvasLike, Gfx } from '../core/gfx.ts';
import type { Engine, UiState } from '../core/types.ts';

/** 一次绘制所需的一切（引擎实例 + 引擎 state + 棋盘交互态）。 */
export interface BoardView {
  /** 引擎实例（`registry.getGame(gameId)` 的返回值） */
  engine: Engine;
  /** 引擎 state（旧 `S.st`）；纯 JSON 数据 */
  state: unknown;
  /** 棋盘交互态（旧 `S.ui`：选中格 / 连跳前缀等）；缺省给空对象 */
  ui?: UiState;
}

export interface RendererOptions {
  /** 注入绘制原语（测试桩 / 离屏渲染）；默认 `src/core/gfx.ts` 的单例。 */
  gfx?: Gfx;
}

/** 渲染器句柄（任务书约定的三方法形状，不再扩张）。 */
export interface BoardRenderer {
  /** 画一帧；首帧会用 `engine.meta` 自动确立尺寸 */
  draw(view: BoardView): void;
  /** 显式设定逻辑尺寸（DPR 由 gfx.setup 处理） */
  resize(w: number, h: number): void;
  /** 解绑：之后 draw/resize 均为 no-op（旧实现换了棋种就重建 ctx） */
  destroy(): void;
}

/** 建一个棋盘渲染器。canvas 必须是 `index.html` 里那个 `#board`。 */
export function createBoardRenderer(canvas: HTMLCanvasElement, opts: RendererOptions = {}): BoardRenderer {
  const g = opts.gfx ?? gfx;
  const target = canvas as unknown as CanvasLike;
  let ctx: Canvas2D | null = null;
  let destroyed = false;

  return {
    resize(w: number, h: number): void {
      if (destroyed) return;
      ctx = g.setup(target, w, h);
    },

    draw(view: BoardView): void {
      if (destroyed) return;
      if (!ctx) {
        const meta = view.engine && view.engine.meta;
        if (meta && meta.w > 0 && meta.h > 0) ctx = g.setup(target, meta.w, meta.h);
      }
      if (!ctx) return;
      const paint = view.engine && view.engine.draw;
      if (typeof paint !== 'function') return;
      paint.call(view.engine, ctx, view.state, view.ui ?? {});
    },

    destroy(): void {
      destroyed = true;
      ctx = null;
    },
  };
}
