/* tactic-legend.spec.ts — 战术模式提示的装配层（图例渲染 + refresh 调度）
 *
 * 测什么：
 *   ① renderTacticLegend：有提示 → 图例 chips（色点/层名×计数/接管徽标）可见；
 *      关闭 / 非五子棋 / 无提示 → 整条隐藏；
 *   ② refreshTacticHints：开关关 → 清空且不调度计算；开 → 异步算出标记写 ctx.ui.tacticMarks
 *      （gomoku 夹具局面）并重画；
 *   ③ 开关写入 settings 并持久化（localStorage）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/app/boot.ts';
import type { AppCtx } from '../../src/app/ctx.ts';
import { renderTacticLegend, refreshTacticHints } from '../../src/app/panels.ts';
import { persistSettings } from '../../src/app/ctx.ts';
import { mountAppHtml, seedStorage, settingsJson, storageOf, STORE_KEY, fakeRenderer } from './fixture.ts';
import { getGame } from '../../src/core/registry.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function bootCtx(store: Map<string, string>): AppCtx {
  const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
  if (!ctx) throw new Error('boot() 返回 null');
  return ctx;
}

describe('renderTacticLegend（图例渲染）', () => {
  it('有提示：chips 可见，含层名×计数、接管徽标与档位标题', () => {
    mountAppHtml();
    const ctx = bootCtx(new Map());
    ctx.settings.hints = true;
    ctx.tacticHint = {
      version: 'v16-softgate',
      marks: [
        { notation: 'H7', layer: 'win', opp: false, fire: true },
        { notation: 'H8', layer: 'parry', opp: true, fire: false },
      ],
      legend: [
        { layer: 'win', label: '致胜点', color: '#e53935', count: 1, fire: true },
        { layer: 'parry', label: '拆杀点', color: '#5c6bc0', count: 1, fire: false },
      ],
    };
    renderTacticLegend(ctx);
    const root = document.getElementById('tacticLegend');
    expect(root?.classList.contains('hidden')).toBe(false);
    const chips = root?.querySelectorAll('.tl-chip');
    expect(chips?.length).toBe(3); /* 标题 + 2 层 */
    expect(root?.textContent).toContain('战术提示 · v16-softgate');
    expect(root?.textContent).toContain('致胜点 ×1');
    expect(root?.querySelector('.is-fire .tl-fire')?.textContent).toBe('接管');
    const dot = root?.querySelector('.tl-chip i') as HTMLElement | null;
    expect(dot?.style.background).toBe('#e53935');
  });

  it('无提示 / 开关关 / 非 gomoku：整条隐藏', () => {
    mountAppHtml();
    const ctx = bootCtx(new Map());
    ctx.settings.hints = true;
    ctx.tacticHint = null;
    renderTacticLegend(ctx);
    expect(document.getElementById('tacticLegend')?.classList.contains('hidden')).toBe(true);

    ctx.settings.hints = false;
    ctx.tacticHint = { version: 'v16-softgate', marks: [], legend: [{ layer: 'win', label: '致胜点', color: '#e53935', count: 1, fire: true }] };
    renderTacticLegend(ctx);
    expect(document.getElementById('tacticLegend')?.classList.contains('hidden')).toBe(true);
  });
});

describe('refreshTacticHints（调度 + 落 marks）', () => {
  it('开关关：清空图例、不动 ui.tacticMarks 之外的状态', async () => {
    mountAppHtml();
    const ctx = bootCtx(new Map([['jev_qiguan_settings_v1', settingsJson()]]));
    ctx.settings.hints = false;
    ctx.tacticHintKey = undefined;
    refreshTacticHints(ctx);
    await vi.waitFor(() => { expect(ctx.tacticHintKey).toBe('off'); });
    expect(ctx.tacticHint ?? null).toBeNull();
    expect(document.getElementById('tacticLegend')?.classList.contains('hidden')).toBe(true);
  });

  it('开关开（gomoku 中盘局面）：异步算出标记 → ctx.ui.tacticMarks + 图例可见 + settings 持久化', async () => {
    mountAppHtml();
    const store = new Map<string, string>([[STORE_KEY, settingsJson()]]);
    const ctx = bootCtx(store);
    /* 摆一个黑四连中盘局面（H8/H9/H10/H11 黑，轮黑）——win 层必有成五点 */
    const gomoku = getGame('gomoku');
    if (!gomoku) throw new Error('注册表里没有 gomoku');
    let st = gomoku.newGame();
    for (const n of ['I9', 'H8', 'J10', 'H9', 'K11', 'H10', 'M13', 'H11']) {
      const mv = gomoku.moveFromNotation(st, n);
      if (!mv) throw new Error('夹具记法非法：' + n);
      st = gomoku.applyMove(st, mv);
    }
    ctx.session.st = st;
    ctx.engine = gomoku;
    ctx.settings.hints = true;
    refreshTacticHints(ctx);
    await vi.waitFor(() => { expect(Array.isArray(ctx.ui.tacticMarks) && ctx.ui.tacticMarks.length > 0).toBe(true); });
    expect(ctx.tacticHint?.marks.some((m) => m.layer === 'win')).toBe(true);
    expect(document.getElementById('tacticLegend')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('tacticLegend')?.textContent).toContain('战术提示 ·');
    /* 开关落盘（真实路径 = onPatch → persistSettings；这里直调同一持久化函数验证序列化含 hints） */
    persistSettings(ctx);
    const saved = JSON.parse(store.get(STORE_KEY) ?? '{}');
    expect(saved.hints).toBe(true);
  });

  it('非五子棋（deepTactics=false）：即使开关开也无标记、图例隐藏', async () => {
    mountAppHtml();
    const ctx = bootCtx(new Map([[STORE_KEY, settingsJson()]]));
    const go = getGame('go');
    if (!go) throw new Error('注册表里没有 go');
    ctx.engine = go;
    ctx.session.st = go.newGame();
    ctx.settings.hints = true;
    refreshTacticHints(ctx);
    await vi.waitFor(() => { expect(ctx.tacticHintKey).toBe('off'); });
    expect(ctx.ui.tacticMarks ?? null).toBeNull();
    expect(document.getElementById('tacticLegend')?.classList.contains('hidden')).toBe(true);
  });
});

describe('hintBtn（棋盘头部一键开关）', () => {
  it('点击翻转 settings.hints、落盘持久化、按钮状态同步、图例联动', async () => {
    mountAppHtml();
    const store = new Map<string, string>([[STORE_KEY, settingsJson()]]);
    const ctx = bootCtx(store);
    const btn = document.getElementById('hintBtn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false); /* gomoku：deepTactics */
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    btn.click();
    expect(ctx.settings.hints).toBe(true);
    await vi.waitFor(() => { expect(btn.getAttribute('aria-pressed')).toBe('true'); });
    expect(btn.classList.contains('is-on')).toBe(true);
    /* 持久化：真实路径（bindings 直调 persistSettings） */
    const saved = JSON.parse(store.get(STORE_KEY) ?? '{}');
    expect(saved.hints).toBe(true);

    btn.click();
    expect(ctx.settings.hints).toBe(false);
    await vi.waitFor(() => { expect(btn.getAttribute('aria-pressed')).toBe('false'); });
    const saved2 = JSON.parse(store.get(STORE_KEY) ?? '{}');
    expect(saved2.hints).toBe(false);
  });

  it('非五子棋：按钮禁用（战术提示仅五子棋可用）', async () => {
    mountAppHtml();
    const ctx = bootCtx(new Map([[STORE_KEY, settingsJson()]]));
    const go = getGame('go');
    if (!go) throw new Error('注册表里没有 go');
    ctx.engine = go;
    /* 触发一次图例渲染同步按钮状态 */
    renderTacticLegend(ctx);
    const btn = document.getElementById('hintBtn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
