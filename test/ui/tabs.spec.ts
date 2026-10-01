/* tabs.spec.ts — 侧栏页签切换的运行时断言
 *
 * 覆盖旧 `activateSidePane()` / `initSideTabs()`（js/app.js:262-311）的行为：
 * 默认页签、点击委托、←/→ 循环、持久化只在用户主动切换时发生、初始化不跑补渲染钩子、
 * 钩子只作用于目标页内「未折叠」的面板、重复 `initSideTabs()` 不重复绑定。
 *
 * 断言方式：渲染后查 DOM（hidden/class/aria-selected）与行为（store 落盘、钩子调用次数），
 * 不做源码字符串匹配。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  SIDETAB_KEY,
  activeSidePane,
  createSideTabStore,
  initSideTabs,
  paneEl,
  paneId,
} from '../../src/ui/panels/tabs.ts';
import type { FoldHooks } from '../../src/ui/panels/collapse.ts';
import { cleanup, click, countingStorage, keydown, memStorage, mount, need } from './helpers.ts';

function fixture(): HTMLElement {
  return mount(`
    <div class="side-tabs" role="tablist">
      <button data-pane="play" aria-selected="false">对局</button>
      <button data-pane="exp" aria-selected="false">实验</button>
      <button data-pane="data" aria-selected="false">数据</button>
    </div>
    <div class="side-pane" id="pane-play">
      <section class="panel collapsible" data-panel="trend"><div class="panel-title">趋势</div></section>
      <section class="panel collapsible folded" data-panel="feed"><div class="panel-title">动态</div></section>
    </div>
    <div class="side-pane" id="pane-exp">
      <section class="panel collapsible" data-panel="duel"><div class="panel-title">驾驶舱</div></section>
    </div>
    <div class="side-pane" id="pane-data"></div>
  `);
}

function tabButton(root: HTMLElement, pane: string): HTMLElement {
  return need(root.querySelector<HTMLElement>('button[data-pane="' + pane + '"]'), 'tab ' + pane);
}

afterEach(cleanup);

describe('paneId / paneEl 契约', () => {
  it('页容器 id 是 pane-<name>，且能按 root 取回', () => {
    const body = fixture();
    expect(paneId('exp')).toBe('pane-exp');
    expect(paneEl('exp', body)).toBe(need(body.querySelector('#pane-exp')));
  });
});

describe('initSideTabs —— 初始页签', () => {
  it('无存储时激活 play，其余页隐藏，且初始化不跑补渲染钩子', () => {
    const body = fixture();
    const calls: string[] = [];
    const hooks: FoldHooks = { trend: () => calls.push('trend'), duel: () => calls.push('duel') };
    initSideTabs({ root: body, hooks, store: createSideTabStore(memStorage()) });

    expect(activeSidePane(body)).toBe('play');
    expect(need(paneEl('play', body)).hidden).toBe(false);
    expect(need(paneEl('exp', body)).hidden).toBe(true);
    expect(need(paneEl('data', body)).hidden).toBe(true);

    const play = tabButton(body, 'play');
    expect(play.classList.contains('active')).toBe(true);
    expect(play.getAttribute('aria-selected')).toBe('true');
    expect(tabButton(body, 'exp').getAttribute('aria-selected')).toBe('false');
    /* 旧注释：初始化时引擎/会话未就绪，必须 runHooks=false（js/app.js:265-268） */
    expect(calls).toEqual([]);
  });

  it('存储里的合法页签名被恢复', () => {
    const body = fixture();
    initSideTabs({ root: body, store: createSideTabStore(memStorage({ [SIDETAB_KEY]: 'exp' })) });
    expect(activeSidePane(body)).toBe('exp');
    expect(need(paneEl('exp', body)).hidden).toBe(false);
    expect(need(paneEl('play', body)).hidden).toBe(true);
  });

  it('存储里是未知页签名时回落到 play', () => {
    const body = fixture();
    initSideTabs({ root: body, store: createSideTabStore(memStorage({ [SIDETAB_KEY]: 'nope' })) });
    expect(activeSidePane(body)).toBe('play');
  });
});

describe('initSideTabs —— 点击切换', () => {
  it('点击切页、落盘，并只对该页内未折叠面板跑钩子', () => {
    const body = fixture();
    const calls: string[] = [];
    const storage = memStorage();
    initSideTabs({
      root: body,
      store: createSideTabStore(storage),
      hooks: { trend: () => calls.push('trend'), feed: () => calls.push('feed'), duel: () => calls.push('duel') },
    });

    click(tabButton(body, 'exp'));
    expect(activeSidePane(body)).toBe('exp');
    expect(need(paneEl('exp', body)).hidden).toBe(false);
    expect(need(paneEl('play', body)).hidden).toBe(true);
    expect(storage.map.get(SIDETAB_KEY)).toBe('exp');
    expect(calls).toEqual(['duel']);

    /* 切回 play：trend 未折叠 → 跑；feed 已折叠 → 跳过 */
    click(tabButton(body, 'play'));
    expect(calls).toEqual(['duel', 'trend']);
    expect(storage.map.get(SIDETAB_KEY)).toBe('play');
  });

  it('重复 initSideTabs() 不重复绑定（一次点击只落盘一次）', () => {
    const body = fixture();
    const { storage, writes } = countingStorage();
    const store = createSideTabStore(storage);
    initSideTabs({ root: body, store });
    initSideTabs({ root: body, store });
    expect(writes).toEqual([]);

    click(tabButton(body, 'exp'));
    expect(writes).toEqual([SIDETAB_KEY]);
  });

  it('点按钮内部的元素也能切页（closest 委托）', () => {
    const body = fixture();
    const btn = tabButton(body, 'data');
    btn.innerHTML = '<i class="glyph">·</i>';
    initSideTabs({ root: body, store: createSideTabStore(memStorage()) });
    click(need(btn.querySelector('.glyph')));
    expect(activeSidePane(body)).toBe('data');
  });
});

describe('initSideTabs —— 方向键', () => {
  it('→ 依次切换并在末项回到首项', () => {
    const body = fixture();
    const storage = memStorage();
    initSideTabs({ root: body, store: createSideTabStore(storage) });
    const bar = need(body.querySelector<HTMLElement>('.side-tabs'));
    const btns = Array.from(body.querySelectorAll<HTMLElement>('button[data-pane]'));

    need(btns[0]).focus();
    expect(document.activeElement).toBe(btns[0]);
    keydown(bar, 'ArrowRight');
    expect(activeSidePane(body)).toBe('exp');
    expect(storage.map.get(SIDETAB_KEY)).toBe('exp');

    need(btns[2]).focus();
    keydown(bar, 'ArrowRight');
    expect(activeSidePane(body)).toBe('play');
    expect(document.activeElement).toBe(btns[0]);
  });

  it('← 从首项回到末项；非方向键不动', () => {
    const body = fixture();
    initSideTabs({ root: body, store: createSideTabStore(memStorage()) });
    const bar = need(body.querySelector<HTMLElement>('.side-tabs'));

    keydown(bar, 'Enter');
    expect(activeSidePane(body)).toBe('play');

    need(body.querySelector<HTMLElement>('button[data-pane="play"]')).focus();
    keydown(bar, 'ArrowLeft');
    expect(activeSidePane(body)).toBe('data');
  });

  it('焦点不在页签按钮上时方向键不切换', () => {
    const body = fixture();
    initSideTabs({ root: body, store: createSideTabStore(memStorage()) });
    const bar = need(body.querySelector<HTMLElement>('.side-tabs'));
    need(body.querySelector<HTMLElement>('#pane-play .panel-title')).focus();
    keydown(bar, 'ArrowRight');
    expect(activeSidePane(body)).toBe('play');
  });
});
