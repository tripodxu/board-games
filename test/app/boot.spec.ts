/* boot.spec.ts — 装配层启动路径（旧 `js/app.js`:2048-2064 的 DOMContentLoaded 段）
 *
 * 这些断言全部是**运行时行为**：把 `index.html` 的真实标记灌进 happy-dom，跑 `boot()`，
 * 再查 DOM 与 ctx。没有一条是读源码做字符串匹配。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/app/boot.ts';
import type { AppCtx } from '../../src/app/ctx.ts';
import { getGame } from '../../src/core/registry.ts';
import type { SelectEl } from '../../src/ui/dom.ts';
import { modalIds } from './fixture.ts';
import {
  STORE_KEY,
  fakeRenderer,
  mountAppHtml,
  seedStorage,
  settingsJson,
  storageOf,
  text,
  visible,
  waitUntil,
} from './fixture.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('P6b 启动装配', () => {
  it('无后端时进入离线降级：状态显示「仅本机」，不抛异常（D8）', async () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    /* 真后端探活走 `core/api/client.ts`：这里把 fetch 打回失败，等价于纯静态托管。 */
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));

    const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
    expect(ctx).not.toBeNull();

    await waitUntil(() => text('backendMode') === '未检测到同源后端', 4000, '后端探活落到 deploy');
    expect(ctx?.backend.mode).toBe('deploy');
    expect(text('backendState')).toBe('无本地后端');
    expect(text('backendGames')).toBe('仅本机');
    expect(text('backendExps')).toBe('仅本机');
    expect(text('backendSync')).toBe('–');
    expect(document.getElementById('backendChip')?.className).toContain('static');
    /* 降级路径下战绩簿照常从本机存储读（D8：无后端也能玩） */
    expect(Array.isArray(ctx?.records)).toBe(true);
    expect(document.getElementById('records')).not.toBeNull();
    expect(document.getElementById('recordStats')).not.toBeNull();
    expect(document.querySelector('.panel[data-panel="records"]')).not.toBeNull();
  });

  it('按旧顺序装配首屏：七页签、棋种名、双方图例、人类侧下拉、速度回填', () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson({ speed: 4 }) });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));

    const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
    expect(ctx).not.toBeNull();
    const engine = getGame('gomoku');
    expect(engine).toBeDefined();

    const gids = Array.from(document.querySelectorAll('#tabs button')).map((b) => b.getAttribute('data-gid'));
    expect(gids).toEqual(['gomoku', 'gomoku-pro', 'go', 'xiangqi', 'chess', 'checkers', 'cc']);
    /* 首屏棋种是 gomoku，且只有它处于 active */
    const active = Array.from(document.querySelectorAll('#tabs button.active')).map((b) => b.getAttribute('data-gid'));
    expect(active).toEqual(['gomoku']);

    expect(text('gameName')).toBe(engine?.name);
    expect(Array.from(document.querySelectorAll('#side option')).map((o) => o.textContent))
      .toEqual(engine?.sides.map((s) => s.name));
    const sideSel = document.getElementById('side') as SelectEl;
    expect(sideSel.value).toBe(ctx?.session.humanSide);
    expect(engine?.sides.map((s) => s.id)).toContain(sideSel.value);

    expect(text('legendFirst')).toBe(engine?.sides[0]?.name);
    expect(text('legendSecond')).toBe(engine?.sides[1]?.name);
    /* 旧启动末尾的 `#speedVal = (150 + speed*150)/1000 + 's'` */
    expect(text('speedVal')).toBe(((150 + 4 * 150) / 1000) + 's');
  });

  it('localStorage 被禁用时退化为内存桩，装配照常完成', () => {
    mountAppHtml();
    vi.stubGlobal('localStorage', {
      getItem(): string | null {
        throw new Error('storage blocked');
      },
      setItem(): void {
        throw new Error('storage blocked');
      },
    });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));

    let ctx: AppCtx | null = null;
    expect(() => {
      ctx = boot({ renderer: fakeRenderer() });
    }).not.toThrow();
    expect(ctx).not.toBeNull();
    expect(text('gameName')).toBeTruthy();
    /* 设置写回也不能炸（saveSettings 静默失败口径） */
    expect(() => {
      if (ctx) ctx.settings.speed = 7;
    }).not.toThrow();
  });

  it('?test=1 等价路径：七棋种与三块跨模块自检全部 ✓', () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));

    boot({ storage: storageOf(store), renderer: fakeRenderer(), selfTest: true });

    expect(visible('testPanel')).toBe(true);
    const panel = document.getElementById('testPanel') as HTMLElement;
    const oks = Array.from(panel.querySelectorAll('.ok')).map((n) => n.textContent);
    const fails = Array.from(panel.querySelectorAll('.fail')).map((n) => n.textContent);
    /* 自检面板必须**零失败**：`src/core/view/calibration.ts` 的 selfTest 夹具曾与期望值自相矛盾
     * （3 条记录却断言 games===2、skippedDemo===0），2026-10-01 已按旧 `js/calibration.js:200-211`
     * 的 5 条夹具改正；这里从「失败项必须是它」收紧为「不许有任何失败项」。 */
    expect(fails, '自检失败项：' + JSON.stringify(fails)).toEqual([]);
    /* 校准实验室那一块出现在 fail 里（缺陷修好后会变成 ok，下面的断言不依赖它落在哪边） */
    const calText = panel.textContent ?? '';
    expect(calText).toContain('校准实验室');
    expect(oks).toContain('✓ 战术登记表');
    expect(oks).toContain('✓ 对阵联名');
    /* 七个棋种全部 ✓（失败集合里没有它们） */
    for (const gid of ['gomoku', 'gomoku-pro', 'go', 'xiangqi', 'chess', 'checkers', 'cc']) {
      const name = getGame(gid)?.name;
      expect(oks).toContain('✓ ' + name);
    }
  });

  it('装配后的 ctx 指向真实注册表引擎，且没有残留 modal 可见', () => {
    mountAppHtml();
    const store = seedStorage({ [STORE_KEY]: settingsJson() });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const ctx = boot({ storage: storageOf(store), renderer: fakeRenderer() });
    expect(ctx?.engine.id).toBe('gomoku');
    expect(ctx?.engine).toBe(getGame('gomoku'));
    /* `switchGame` 末尾走 `resetSession()`：引擎已经开好新局（旧实现的 `S.st = engine.newGame()`） */
    const st = ctx?.session.st as { moveNum?: number; result?: unknown } | null | undefined;
    expect(st).toBeTruthy();
    expect(st?.moveNum).toBe(0);
    expect(st?.result).toBeNull();
    expect(ctx?.session.history).toEqual([]);
    for (const id of modalIds()) expect(visible(id)).toBe(false);
  });
});
