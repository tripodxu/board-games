/* clock.ts — 思考计时器与 AI 走子调度（旧 js/app.js:571-592、618-620、660-700 的计时相关段）
 *
 * 旧实现在 `S` 上挂了三个隐式计时状态：`S.thinkTimer`（100ms interval）、
 * `S.paused`、以及裸 `setTimeout(aiStep, …)`。裸 setTimeout 的问题在换局/悔棋时最明显：
 * 旧代码靠 `S.epoch` 在 `aiStep()` 里兜底判断，但定时器本身仍在跑（换棋种后还会
 * 触发一次 `aiStep`，只是被 epoch 挡掉）。这里显式持有句柄并在 `resetSession`/`undo`
 * 里 `clearTimeout`，把「不该跑的回调」直接取消而不是让它空转。
 *
 * 本文件不 import node:*；`setInterval`/`setTimeout` 用 DOM 版本（返回 number）。
 */
import { sideLabel } from '../core/view/duel.ts';
import { byId } from '../ui/dom.ts';
import { effFor, sideNameOf } from './ctx.ts';
import type { AppCtx } from './ctx.ts';

/** 旧 `startThinkClock(side)`：每 100ms 把 `#turnBadge` 改写成带秒数的思考中提示。 */
export function startThinkClock(ctx: AppCtx, sideId: string): void {
  stopThinkClock(ctx);
  ctx.thinkStart = Date.now();
  const badge = byId<HTMLElement>('turnBadge');
  if (!badge) return;
  const head = sideNameOf(ctx, sideId) + ' ' + sideLabel(effFor(ctx, sideId));
  const tick = (): void => {
    badge.textContent = head + ' · 思考中 ' + ((Date.now() - ctx.thinkStart) / 1000).toFixed(1) + 's';
  };
  tick();
  ctx.thinkTimer = setInterval(tick, 100);
}

/** 旧 `stopThinkClock()`。 */
export function stopThinkClock(ctx: AppCtx): void {
  if (ctx.thinkTimer != null) {
    clearInterval(ctx.thinkTimer);
    ctx.thinkTimer = null;
  }
}

/** 旧 `aiDelayMs()`（js/app.js:618-620）：机机看速度滑杆，人机固定 120ms。 */
export function aiDelayMs(ctx: AppCtx): number {
  return ctx.session.mode === 'ai-ai' ? 150 + ctx.settings.speed * 150 : 120;
}

/** 取消尚未触发的 AI 走子调度（换局/悔棋/终局时用）。 */
export function cancelAIStep(ctx: AppCtx): void {
  if (ctx.aiTimer != null) {
    clearTimeout(ctx.aiTimer);
    ctx.aiTimer = null;
  }
}

/** 旧 `setTimeout(aiStep, aiDelayMs())` 的受管版本：同一时刻只留一个待触发回调。 */
export function scheduleAIStep(ctx: AppCtx, fn: () => void, delayMs: number): void {
  cancelAIStep(ctx);
  ctx.aiTimer = setTimeout(() => {
    ctx.aiTimer = null;
    fn();
  }, delayMs);
}
