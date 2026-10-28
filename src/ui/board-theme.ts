/* board-theme.ts — 棋盘配色跟随系统主题（暗色下压一档亮度）
 *
 * 为什么不是给 canvas 挂 CSS `filter`：canvas 上带 filter 时，浏览器无法把位图直接送上屏，
 * 每次 `draw()` 之后都要对整块（560×560×DPR）再跑一遍滤镜管线 —— 等于把棋盘重绘成本
 * 再乘一遍，而且暗色主题下 100% 命中。改成「换一组颜色常量」后绘制指令数不变，开销为零。
 *
 * 取值口径：暗色那组 = 对浅色组做 `brightness(.92) saturate(.95)` 的等价结果
 * （#FAFBFD → #E6E8EA、#3A4048 → #353B42）。刻意**只压亮度不换色系**：
 * 棋子的黑白填充在 gfx.stone 里是固定值，棋盘若改成深色会让黑子糊掉。
 *
 * 本文件是 core 与浏览器之间的桥：core/gfx.ts 保存配色但不读 DOM，
 * 这里读 `prefers-color-scheme` 并在变化时回调（装配层接到回调后重画一帧）。
 */
import { setGfxTheme } from '../core/gfx.ts';
import type { GfxPalette } from '../core/gfx.ts';

/** 浅色：旧实现的逐字口径。 */
const LIGHT: GfxPalette = { board: '#FAFBFD', line: '#3A4048' };
/** 暗色：同色系压亮一档（≈ brightness .92 / saturate .95）。 */
const DARK: GfxPalette = { board: '#E6E8EA', line: '#353B42' };

/** 直接应用一组配色（测试 / 一次性调用）。 */
export function applyBoardTheme(dark: boolean): void {
  setGfxTheme(dark ? DARK : LIGHT);
}

/** 订阅系统主题；返回取消订阅的函数。无 matchMedia（Node/老环境）时按浅色处理。 */
export function watchBoardTheme(onChange?: () => void): () => void {
  if (typeof matchMedia !== 'function') {
    applyBoardTheme(false);
    return () => {};
  }
  const mq = matchMedia('(prefers-color-scheme: dark)');
  applyBoardTheme(mq.matches);
  const handler = (e: MediaQueryListEvent): void => {
    applyBoardTheme(e.matches);
    if (onChange) onChange();
  };
  /* Safari < 14 只有 addListener/removeListener */
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }
  mq.addListener(handler);
  return () => mq.removeListener(handler);
}
