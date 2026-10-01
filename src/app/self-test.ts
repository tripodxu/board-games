/* self-test.ts — 浏览器内自检（旧 js/app.js:2017-2046 的「自检」段）
 *
 * 触发方式与旧实现一致：`?test=1` 查询串。产物是一整块 HTML 写进 `#testPanel`，
 * 七棋种按 `GAME_ORDER` 顺序逐个 `selfTest()`，再补三块跨模块自检
 * （校准实验室的数学 / 战术登记表 / 对阵联名）。
 *
 * 与旧实现的唯一差别：旧实现用 `innerHTML +=` 一段段拼接（每加一块都重解析整块 HTML），
 * 这里先在文档片段里攒好再一次性写入。产出文案、类名（`ok`/`fail`）、顺序逐字不变。
 */
import { selfTest as calibrationSelfTest } from '../core/view/calibration.ts';
import { selfTest as duelSelfTest } from '../core/view/duel.ts';
import { selfTest as tacticsSelfTest } from '../core/tactics-versions.ts';
import { getGame } from '../core/registry.ts';
import { byId, el, setHidden } from '../ui/dom.ts';
import { GAME_ORDER } from './modes.ts';

/** 旧 `runTests()`（js/app.js:2018-2046）。 */
export function runTests(): void {
  const panel = byId<HTMLElement>('testPanel');
  if (!panel) return;
  /* 旧实现用 `classList.remove('hidden')`（js/app.js:2020），`#testPanel` 在标记里带的就是 class
   * 而不是 `hidden` 属性——这里必须逐字保持，否则 `?test=1` 的面板会被 `.hidden{display:none}` 盖住。 */
  panel.classList.remove('hidden');
  setHidden(panel, false);

  const frag = document.createDocumentFragment();
  frag.appendChild(el('b', { text: '引擎自检' }));
  frag.appendChild(el('br'));

  for (const gid of GAME_ORDER) {
    const e = getGame(gid);
    if (!e) {
      frag.appendChild(el('span', { class: 'fail', text: gid + ' 缺失' }));
      frag.appendChild(el('br'));
      continue;
    }
    try {
      e.selfTest();
      frag.appendChild(el('span', { class: 'ok', text: '✓ ' + e.name }));
    } catch (err) {
      frag.appendChild(el('span', { class: 'fail', text: '✗ ' + e.name + '：' + errMsg(err) }));
    }
    frag.appendChild(el('br'));
  }

  /* 校准实验室的数学也进浏览器自检：纯函数，Node 与浏览器两端都能跑 */
  try {
    calibrationSelfTest();
    frag.appendChild(el('span', { class: 'ok', text: '✓ 校准实验室' }));
  } catch (err) {
    frag.appendChild(el('span', { class: 'fail', text: '✗ 校准实验室：' + errMsg(err) }));
  }
  frag.appendChild(el('br'));

  /* 战术登记表 + 对阵联名：登记表错（漏版本/rank 断档）会让沿革条与棋谱归因同时失效 */
  try {
    tacticsSelfTest();
    frag.appendChild(el('span', { class: 'ok', text: '✓ 战术登记表' }));
    duelSelfTest();
    frag.appendChild(el('span', { class: 'ok', text: '✓ 对阵联名' }));
  } catch (err) {
    frag.appendChild(el('span', { class: 'fail', text: '✗ 战术登记表/联名：' + errMsg(err) }));
  }
  frag.appendChild(el('br'));

  panel.replaceChildren(frag);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
