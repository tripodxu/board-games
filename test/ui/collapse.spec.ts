/* collapse.spec.ts — 侧栏面板折叠的运行时断言
 *
 * 覆盖旧 `loadFoldOpen/saveFoldOpen/applyFolded/toggleFold/initFolds`（js/app.js:204-260）：
 * 首访默认展开 trend+expreport、点击标题折叠、标题内实体控件不触发折叠、
 * 展开时补渲染钩子、存储损坏兜底、展开清单以 DOM 现状收集。
 *
 * 断言方式：渲染后查 `.folded` / `aria-expanded` 与存储写入内容，不做源码字符串匹配。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  FOLD_DEFAULT_OPEN,
  FOLD_FALLBACK_OPEN,
  FOLD_KEY,
  applyFolded,
  createFoldStore,
  foldSection,
  initFolds,
  isFolded,
  openPanelIds,
  toggleFold,
} from '../../src/ui/panels/collapse.ts';
import { cleanup, click, memStorage, mount, need } from './helpers.ts';

function fixture(): HTMLElement {
  return mount(`
    <section class="panel collapsible" data-panel="trend">
      <div class="panel-title">判断趋势 <button class="clr" id="trendClr">清空</button><button class="fold" id="trendFold"></button></div>
    </section>
    <section class="panel collapsible" data-panel="records">
      <div class="panel-title">战绩簿 <button class="fold" id="recordsFold"></button></div>
    </section>
    <section class="panel collapsible" data-panel="expreport">
      <div class="panel-title">战报 <button class="fold" id="expreportFold"></button></div>
    </section>
    <section class="panel collapsible">
      <div class="panel-title">无 data-panel 的区块</div>
    </section>
  `);
}

function titleOf(root: HTMLElement, pid: string): HTMLElement {
  return need(foldSection(pid, root), 'section ' + pid).querySelector<HTMLElement>('.panel-title')!;
}

afterEach(cleanup);

describe('initFolds —— 应用展开清单', () => {
  it('无存储时按 FOLD_DEFAULT_OPEN 展开，并同步 aria-expanded', () => {
    const body = fixture();
    initFolds({ root: body });

    expect(FOLD_DEFAULT_OPEN).toEqual(['trend', 'expreport']);
    expect(isFolded('trend', body)).toBe(false);
    expect(isFolded('expreport', body)).toBe(false);
    expect(isFolded('records', body)).toBe(true);

    expect(need(body.querySelector('#trendFold')).getAttribute('aria-expanded')).toBe('true');
    expect(need(body.querySelector('#recordsFold')).getAttribute('aria-expanded')).toBe('false');
    expect(openPanelIds(body)).toEqual(['trend', 'expreport']);
  });

  it('按存储里的清单应用（未知 id 只是不展开，不报错）', () => {
    const body = fixture();
    initFolds({ root: body, store: createFoldStore(memStorage({ [FOLD_KEY]: JSON.stringify(['records', 'ghost']) })) });
    expect(isFolded('records', body)).toBe(false);
    expect(isFolded('trend', body)).toBe(true);
    expect(isFolded('expreport', body)).toBe(true);
  });

  it('存储损坏 → FOLD_FALLBACK_OPEN；合法 JSON 但不是数组 → 全部折叠', () => {
    const body = fixture();
    expect(FOLD_FALLBACK_OPEN).toEqual(['trend']);
    initFolds({ root: body, store: createFoldStore(memStorage({ [FOLD_KEY]: '{oops' })) });
    expect(isFolded('trend', body)).toBe(false);
    expect(isFolded('expreport', body)).toBe(true);

    const body2 = mount('<section class="panel collapsible" data-panel="trend"><div class="panel-title">t</div></section>');
    initFolds({ root: body2, store: createFoldStore(memStorage({ [FOLD_KEY]: '{}' })) });
    expect(isFolded('trend', body2)).toBe(true);
  });
});

describe('折叠交互', () => {
  it('点标题折叠并落盘；展开清单以 DOM 现状收集', () => {
    const body = fixture();
    const storage = memStorage();
    initFolds({ root: body, store: createFoldStore(storage) });
    expect(storage.map.has(FOLD_KEY)).toBe(false);

    click(titleOf(body, 'trend'));
    expect(isFolded('trend', body)).toBe(true);
    expect(need(body.querySelector('#trendFold')).getAttribute('aria-expanded')).toBe('false');
    expect(storage.map.get(FOLD_KEY)).toBe(JSON.stringify(['expreport']));

    /* 手工改过 DOM（未经 toggleFold）后，下一次 toggle 的落盘以现状为准 */
    applyFolded('records', false, body);
    click(titleOf(body, 'expreport'));
    expect(openPanelIds(body)).toEqual(['records']);
    expect(storage.map.get(FOLD_KEY)).toBe(JSON.stringify(['records']));
  });

  it('标题内的实体控件不触发折叠，button.fold 触发', () => {
    const body = fixture();
    const storage = memStorage();
    initFolds({ root: body, store: createFoldStore(storage) });

    click(need(body.querySelector('#trendClr')));
    expect(isFolded('trend', body)).toBe(false);
    expect(storage.map.has(FOLD_KEY)).toBe(false);

    click(need(body.querySelector('#trendFold')));
    expect(isFolded('trend', body)).toBe(true);
  });

  it('toggleFold 返回本次是否收起；展开时跑补渲染钩子，折叠时不跑', () => {
    const body = fixture();
    const calls: string[] = [];
    const store = createFoldStore(memStorage({ [FOLD_KEY]: JSON.stringify(['records']) }));
    initFolds({ root: body, store, hooks: { trend: () => calls.push('trend') } });
    expect(isFolded('trend', body)).toBe(true);

    expect(toggleFold('trend', { root: body, store, hooks: { trend: () => calls.push('trend') } })).toBe(false);
    expect(isFolded('trend', body)).toBe(false);
    expect(calls).toEqual(['trend']);

    expect(toggleFold('trend', { root: body, store, hooks: { trend: () => calls.push('trend') } })).toBe(true);
    expect(calls).toEqual(['trend']);
  });

  it('缺少对应区块时 toggleFold 静默返回 false', () => {
    const body = fixture();
    expect(toggleFold('nope', { root: body })).toBe(false);
    expect(toggleFold('nope', { root: body, store: createFoldStore(memStorage()) })).toBe(false);
  });

  it('重复 initFolds() 不重复绑定（一次点击只落盘一次）', () => {
    const body = fixture();
    let writes = 0;
    const storage = memStorage();
    const raw = storage.setItem;
    storage.setItem = (k: string, v: string) => {
      writes++;
      raw(k, v);
    };
    const store = createFoldStore(storage);
    initFolds({ root: body, store });
    initFolds({ root: body, store });
    expect(writes).toBe(0);

    click(titleOf(body, 'records'));
    expect(writes).toBe(1);
  });

  it('没有 data-panel 的区块被跳过（不被折叠、也不污染展开清单）', () => {
    const body = fixture();
    initFolds({ root: body });
    const ghost = body.querySelectorAll('.panel.collapsible')[3]!;
    expect(ghost.classList.contains('folded')).toBe(false);
    expect(openPanelIds(body)).toEqual(['trend', 'expreport']);
    expect(openPanelIds(body).every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });
});
