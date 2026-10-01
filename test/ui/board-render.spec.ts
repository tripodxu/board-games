/* board-render.spec.ts — 棋盘 canvas 渲染器的运行时断言（stub canvas / stub ctx）
 *
 * 覆盖 `createBoardRenderer()`（旧 js/app.js:479 的 `S.ctx = BG.gfx.setup($('board'), …)` +
 * js/app.js:497-499 的 `S.engine.draw(S.ctx, S.st, S.ui)`）。
 *
 * 为什么数 `arc` 调用：`src/ui/board-render.ts` 是薄封装（只做 DPR/setup/resize 转发），真正的绘制在
 * 各引擎的 `draw()` 里，而引擎 import 的是 `src/core/gfx.ts` 的**真单例**——所以要在 stub ctx 上数
 * `arc()`：五子棋棋子半径 `CELL*0.44 = 15.84`、星位 `3.2`、最后一手标记 `棋子半径*0.32 ≈ 5.07`。
 * 用「半径 > 8」过滤即得棋子数。
 *
 * 断言方式：注入 stub canvas/ctx 后跑真引擎，查调用序列与 canvas 尺寸；不做源码字符串匹配。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { gfx, type Canvas2D, type CanvasLike, type Gfx } from '../../src/core/gfx.ts';
import { getGame } from '../../src/core/registry.ts';
import { createBoardRenderer } from '../../src/ui/board-render.ts';
import { cleanup, mount, need } from './helpers.ts';

interface Arc {
  x: number;
  y: number;
  r: number;
}

function stubCtx(): { ctx: Canvas2D; arcs: Arc[] } {
  const arcs: Arc[] = [];
  const ctx: Canvas2D = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'top',
    setTransform: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    arc: (x, y, r) => {
      arcs.push({ x, y, r });
    },
    rect: () => {},
    fill: () => {},
    fillText: () => {},
  };
  return { ctx, arcs };
}

/** 真 `#board` 形状的 canvas，`getContext('2d')` 换成桩（happy-dom 不实现 2d 上下文）。 */
function stubCanvas(ctx: Canvas2D): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'getContext', { value: () => ctx, configurable: true });
  return canvas;
}

/** 五子棋 state（15×15，1=黑 2=白），`stones` 个子的坐标由 moves 给定。 */
function gomokuState(moves: [number, number, number][]): Record<string, unknown> {
  const board = Array.from({ length: 15 }, () => Array<number>(15).fill(0));
  for (const [r, c, p] of moves) board[r]![c] = p;
  const last = moves.length ? moves[moves.length - 1]! : null;
  return {
    board,
    turn: moves.length % 2 === 0 ? 'black' : 'white',
    moveNum: moves.length,
    last: last ? { notation: 'R' + last[0] + 'C' + last[1], r: last[0], c: last[1], side: last[2] === 1 ? 'black' : 'white' } : null,
    result: null,
  };
}

const stonesOf = (arcs: Arc[]): Arc[] => arcs.filter((a) => a.r > 8);

afterEach(cleanup);

describe('createBoardRenderer —— 首帧自动确立尺寸', () => {
  it('用 engine.meta 做 setup，并把 draw 转发给真引擎（落子数正确）', () => {
    const host = mount('<canvas id="board"></canvas>');
    const canvas = need(host.querySelector<HTMLCanvasElement>('#board'));
    const { ctx, arcs } = stubCtx();
    Object.defineProperty(canvas, 'getContext', { value: () => ctx, configurable: true });

    const renderer = createBoardRenderer(canvas);
    const engine = need(getGame('gomoku'), 'gomoku engine');
    const state = gomokuState([[7, 7, 1], [7, 8, 2], [8, 8, 1]]);

    expect(() => renderer.draw({ engine, state })).not.toThrow();
    expect(stonesOf(arcs).length).toBe(3);

    /* gfx.setup 的口径：逻辑尺寸 560（MARGIN*2 + 14*CELL），style 宽 = 逻辑宽 */
    expect(engine.meta!.w).toBe(560);
    expect(canvas.style.width).toBe('560px');
    expect(canvas.style.height).toBe('auto');
    expect(canvas.width).toBe(Math.round(560 * (window.devicePixelRatio || 1)));
  });

  it('空盘只画网格/星位，不画棋子；随后落子再画一帧会累积调用', () => {
    const host = mount('<canvas id="board"></canvas>');
    const canvas = need(host.querySelector<HTMLCanvasElement>('#board'));
    const { ctx, arcs } = stubCtx();
    Object.defineProperty(canvas, 'getContext', { value: () => ctx, configurable: true });

    const renderer = createBoardRenderer(canvas);
    const engine = need(getGame('gomoku'), 'gomoku engine');
    renderer.draw({ engine, state: gomokuState([]) });
    expect(stonesOf(arcs).length).toBe(0);
    expect(arcs.filter((a) => a.r === 3.2).length).toBeGreaterThan(0);

    const before = arcs.length;
    renderer.draw({ engine, state: gomokuState([[7, 7, 1]]) });
    expect(arcs.length).toBeGreaterThan(before);
    expect(stonesOf(arcs).length).toBe(1);
  });

  it('最后一手落点补标记（半径约为棋子半径的 0.32）', () => {
    const host = mount('<canvas id="board"></canvas>');
    const canvas = need(host.querySelector<HTMLCanvasElement>('#board'));
    const { ctx, arcs } = stubCtx();
    Object.defineProperty(canvas, 'getContext', { value: () => ctx, configurable: true });

    const renderer = createBoardRenderer(canvas);
    const engine = need(getGame('gomoku'), 'gomoku engine');
    renderer.draw({ engine, state: gomokuState([[7, 7, 1], [7, 8, 2]]) });

    const stone = stonesOf(arcs)[0]!;
    const marker = arcs.filter((a) => a.r > 4 && a.r < 8);
    expect(marker.length).toBe(1);
    expect(marker[0]!.x).toBeCloseTo(need(stonesOf(arcs).at(-1)).x, 5);
    expect(marker[0]!.x).not.toBe(stone.x);
    expect(arcs.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y))).toBe(true);
  });
});

describe('createBoardRenderer —— resize / destroy / 注入', () => {
  it('resize(w, h) 显式设定逻辑尺寸', () => {
    const host = mount('<canvas id="board"></canvas>');
    const canvas = need(host.querySelector<HTMLCanvasElement>('#board'));
    const { ctx, arcs } = stubCtx();
    Object.defineProperty(canvas, 'getContext', { value: () => ctx, configurable: true });

    const renderer = createBoardRenderer(canvas);
    renderer.resize(300, 200);
    expect(canvas.style.width).toBe('300px');
    expect(renderer.draw({ engine: need(getGame('gomoku')), state: gomokuState([[0, 0, 1]]) }) ?? arcs).toBeDefined();
    expect(stonesOf(arcs).length).toBe(1);
  });

  it('destroy() 之后 draw / resize 都是 no-op', () => {
    const host = mount('<canvas id="board"></canvas>');
    const canvas = need(host.querySelector<HTMLCanvasElement>('#board'));
    const { ctx, arcs } = stubCtx();
    Object.defineProperty(canvas, 'getContext', { value: () => ctx, configurable: true });

    const renderer = createBoardRenderer(canvas);
    renderer.draw({ engine: need(getGame('gomoku')), state: gomokuState([[7, 7, 1]]) });
    const drawn = arcs.length;
    renderer.destroy();

    expect(() => renderer.draw({ engine: need(getGame('gomoku')), state: gomokuState([[7, 7, 1], [8, 8, 2]]) })).not.toThrow();
    renderer.resize(999, 999);
    expect(arcs.length).toBe(drawn);
    expect(canvas.style.width).toBe('560px');
  });

  it('opts.gfx 可注入绘制原语（setup 走桩、draw 仍由引擎发起）', () => {
    const canvas = stubCanvas(stubCtx().ctx);
    const { ctx, arcs } = stubCtx();
    const setups: [number, number][] = [];
    const fake: Gfx = {
      ...gfx,
      setup: (_canvas: CanvasLike, w: number, h: number) => {
        setups.push([w, h]);
        return ctx;
      },
    };

    const renderer = createBoardRenderer(canvas, { gfx: fake });
    renderer.draw({ engine: need(getGame('gomoku')), state: gomokuState([[3, 3, 1], [4, 4, 2], [5, 5, 1], [6, 6, 2]]) });
    expect(setups).toEqual([[560, 560]]);
    expect(stonesOf(arcs).length).toBe(4);
  });

  it('引擎没有 meta 时不 setup，也不抛（缺 meta 的边界）', () => {
    const canvas = stubCanvas(stubCtx().ctx);
    const renderer = createBoardRenderer(canvas);
    expect(() =>
      renderer.draw({ engine: { draw: () => {} } as unknown as Parameters<typeof renderer.draw>[0]['engine'], state: {} }),
    ).not.toThrow();
    expect(canvas.style.width).toBe('');
  });
});
