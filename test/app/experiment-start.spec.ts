/* experiment-start.spec.ts — P0/D2：实验启动前必须核对战术档位白名单
 *
 * 背景：`resolve()` 过去对未知档号**静默回落 CURRENT**（`src/core/tactics-versions.ts`），
 * 于是「DOM 里写着 v12、实际跑 v14」这种单变量破坏谁都看不见——实验报表照旧出数，
 * 结论却归因到了错档位。现在两条静默回退都改成显式失败：
 *   ① `resolve()` 抛 `UnknownTacticsVersion`（边界严格）；
 *   ② 实验启动（本文件的入口③）与 `scripts/experiment-run.mjs`（入口②）在开跑前
 *      就用 `tryResolve()` 把下拉值核一遍，不合格直接拒绝启动并报出最接近的合法档位。
 *
 * 这里断言的是**运行时行为**：真 `index.html` 标记 + `boot()` 装配出的 ctx，
 * 没有一条是读源码做字符串匹配。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/app/boot.ts';
import { startExperiment, stopExperiment } from '../../src/app/experiment.ts';
import { CURRENT } from '../../src/core/tactics-versions.ts';
import {
  STORE_KEY,
  fakeRenderer,
  mountAppHtml,
  seedStorage,
  settingsJson,
  storageOf,
  text,
} from './fixture.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** 把 `#expTacA` 改成登记表外的档号：真 DOM 里 `select.value` 只接受已有 option，
 *  所以先补一个 option 再赋值——这也正是「陈旧 DOM / 历史页面残留值」的样子。 */
function tamperTacA(id: string): void {
  const sel = document.getElementById('expTacA');
  if (!(sel instanceof HTMLSelectElement)) throw new Error('缺少 #expTacA');
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = id;
  sel.appendChild(opt);
  sel.value = id;
  if (sel.value !== id) throw new Error('夹具没把 #expTacA 改成 ' + id);
}

function bootOffline() {
  mountAppHtml();
  const store = seedStorage({ [STORE_KEY]: settingsJson() });
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  return boot({ storage: storageOf(store), renderer: fakeRenderer() });
}

describe('P0/D2：实验启动的档位闸门', () => {
  it('非法档位拒绝启动：不进入 running、toast 报出档号与最接近的合法档位', () => {
    const ctx = bootOffline();
    expect(ctx).not.toBeNull();
    tamperTacA('v12-vct-de');

    startExperiment(ctx!);

    expect(ctx!.exp.running).toBe(false);
    expect(text('toast')).toContain('实验未启动：无法识别的战术档位');
    expect(text('toast')).toContain('A=v12-vct-de');
    expect(text('toast')).toContain('最接近 v12-vct-def');
    const toastEl = document.getElementById('toast');
    expect(toastEl?.classList.contains('err')).toBe(true); // 错误提示（6000ms），不是普通提示
    expect(toastEl?.classList.contains('hidden')).toBe(false);
  });

  it('正对照：档位都在白名单里时照常启动（闸门只挡非法值）', () => {
    const ctx = bootOffline();
    expect(ctx).not.toBeNull();
    const sel = document.getElementById('expTacA');
    if (!(sel instanceof HTMLSelectElement)) throw new Error('缺少 #expTacA');
    sel.value = CURRENT;

    startExperiment(ctx!);

    expect(ctx!.exp.running).toBe(true);
    expect(text('toast')).not.toContain('实验未启动');
    stopExperiment(ctx!);
    expect(ctx!.exp.running).toBe(false);
  });
});
