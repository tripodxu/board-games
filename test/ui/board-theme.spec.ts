/* board-theme.spec.ts — 棋盘主题的配色契约
 *
 * 钉住三件事：
 *  1. 浅色口径 = 旧实现的逐字值（#FAFBFD / #3A4048），迁移不能漂；
 *  2. 暗色只是「同色系压暗一档」，不是换成深色底（深色底会让黑子糊掉）；
 *  3. `gfx.clear` / `gfx.intersections` 真的读这组配色 —— 也就是说暗色压光发生在
 *     **绘制层换颜色**，而不是给 canvas 挂 CSS filter（后者每次重绘多一遍滤镜管线）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { gfx, gfxTheme } from '../../src/core/gfx.ts';
import { applyBoardTheme } from '../../src/ui/board-theme.ts';

/** 只记录被写入的样式的 2D 上下文桩。 */
function stubCtx(): {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  setTransform(): void;
  fillRect(): void;
  strokeRect(): void;
  beginPath(): void;
  moveTo(): void;
  lineTo(): void;
  stroke(): void;
  arc(): void;
  rect(): void;
  fill(): void;
  fillText(): void;
} {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    setTransform(): void {},
    fillRect(): void {},
    strokeRect(): void {},
    beginPath(): void {},
    moveTo(): void {},
    lineTo(): void {},
    stroke(): void {},
    arc(): void {},
    rect(): void {},
    fill(): void {},
    fillText(): void {},
  };
}

afterEach(() => {
  applyBoardTheme(false);   // 模块级配色是共享状态，测完还原
});

describe('棋盘配色（board-theme ↔ gfx）', () => {
  it('浅色 = 旧实现的逐字口径', () => {
    applyBoardTheme(false);
    expect(gfxTheme()).toEqual({ board: '#FAFBFD', line: '#3A4048' });
  });

  it('暗色只是压暗一档，不换色系（棋盘仍是浅底，黑子才不糊）', () => {
    applyBoardTheme(true);
    const dark = gfxTheme();
    applyBoardTheme(false);
    const light = gfxTheme();

    /* 亮度确实降了（≈ brightness .92），但仍是「接近白」的浅底 */
    const lum = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };
    expect(lum(dark.board)).toBeLessThan(lum(light.board));
    expect(lum(dark.board)).toBeGreaterThan(200);   // 仍是浅底，不是深色棋盘
    expect(lum(dark.line)).toBeLessThan(lum(light.line));
  });

  it('clear / intersections 读当前配色（压光在绘制层，不在 CSS filter）', () => {
    const ctx = stubCtx();

    applyBoardTheme(false);
    gfx.clear(ctx, 560, 560);
    const lightFill = ctx.fillStyle as string;
    gfx.intersections(ctx, 20, 20, 36, 15, 15);
    const lightLine = ctx.strokeStyle as string;

    applyBoardTheme(true);
    gfx.clear(ctx, 560, 560);
    const darkFill = ctx.fillStyle as string;
    gfx.intersections(ctx, 20, 20, 36, 15, 15);
    const darkLine = ctx.strokeStyle as string;

    expect(lightFill).toBe('#FAFBFD');
    expect(lightLine).toBe('#3A4048');
    expect(darkFill).toBe('#E6E8EA');
    expect(darkLine).toBe('#353B42');
  });

  it('显式传色时仍以传参为准（引擎可覆盖默认）', () => {
    const ctx = stubCtx();
    applyBoardTheme(true);
    gfx.clear(ctx, 100, 100, '#123456');
    expect(ctx.fillStyle).toBe('#123456');
  });
});
