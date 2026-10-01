/**
 * 前端入口（P6b 装配版）。
 *
 * 只做三件事：写版本号 → 起应用 → 兜住启动期的未捕获异常（D8：无后端/存储不可用时
 * 降级，绝不白屏）。真正的装配在 `src/app/boot.ts`，对局循环/面板/实验编排在 `src/app/**`。
 */
import { CODE_VERSION } from './shared/version.ts';
import { boot } from './app/boot.ts';

function start(): void {
  document.documentElement.dataset.codeVersion = CODE_VERSION;
  try {
    boot();
  } catch (e) {
    /* 启动期异常必须留下痕迹再降级：顶栏写明失败，控制台留栈。 */
    console.error('[jev-qiguan] 启动失败', e);
    const chip = document.getElementById('backendState');
    if (chip) chip.textContent = '启动失败（详见控制台）';
    const root = document.documentElement;
    root.dataset.backend = 'failed';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
