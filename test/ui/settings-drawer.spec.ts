/* settings-drawer.spec.ts — 「全局设置」抽屉的运行时断言
 *
 * 覆盖 `renderSettings()` / `setDrawerOpen()` / `setProbeOut()` / `renderChannelHint()` /
 * `renderChannelChip()`（旧的 js/app.js:105-176 的 syncChannelUI/runProbe + js/app.js:324-334 的
 * openDrawer/closeDrawer + js/app.js:947-980 的双方覆盖）。
 *
 * 断言方式：渲染后查 DOM（控件值、选项数、hidden 类、文本）与行为（handler 收到的 patch、
 * 重复 render 是否叠节点/叠监听），不做源码字符串匹配。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings, type SideConfig } from '../../src/core/persist.ts';
import { CURRENT, VERSIONS } from '../../src/core/tactics-versions.ts';
import {
  closeSettingsDrawer,
  isDrawerOpen,
  openSettingsDrawer,
  renderChannelChip,
  renderChannelHint,
  renderSettings,
  setProbeOut,
  type SettingsPanelProps,
} from '../../src/ui/panels/settings.ts';
import { DRAWER_CHANNEL_OPTS, tacticsOptions } from '../../src/ui/panels/options.ts';
import { qsa, type SelectEl } from '../../src/ui/dom.ts';
import { cleanup, click, mount, need, select } from './helpers.ts';

const DRAWER_HTML = `
  <div id="drawerMask" class="drawer-mask hidden"></div>
  <aside id="settingsDrawer" class="drawer hidden" aria-hidden="true">
    <div id="drawerHead"><span id="drawerTitle">设置</span><button id="drawerClose" type="button">关闭</button></div>
    <div id="drawerBody"></div>
  </aside>
  <span id="channelChip"></span>
  <div id="modeHint"></div>
`;

const BLACK: SideConfig = { channel: 'rapfi', tactics: CURRENT, rapfiThinkMs: 2000 };
const WHITE: SideConfig = { channel: '', tactics: '', rapfiThinkMs: 0 };

function settingsOf(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function propsOf(patch: Partial<Settings> = {}, extra: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    settings: settingsOf(patch),
    versions: VERSIONS,
    black: BLACK,
    white: WHITE,
    endpointPlaceholder: 'https://your-proxy.example/v1',
    ...extra,
  };
}

interface Seen {
  patches: Partial<Settings>[];
  endpoints: [string, string][];
  probes: number;
  sides: [string, Partial<SideConfig>][];
}

function seen(): Seen {
  return { patches: [], endpoints: [], probes: 0, sides: [] };
}

function handlersOf(log: Seen) {
  return {
    onPatch: (patch: Partial<Settings>) => log.patches.push(patch),
    onEndpointChange: (channel: string, value: string) => log.endpoints.push([channel, value]),
    onProbe: () => {
      log.probes++;
    },
    onSideChange: (side: 'black' | 'white', patch: Partial<SideConfig>) => log.sides.push([side, patch]),
  };
}

afterEach(cleanup);

describe('renderSettings —— 控件回填', () => {
  it('按 settings 回填抽屉控件，并按渠道显示/隐藏对应行', () => {
    const body = mount(DRAWER_HTML);
    renderSettings(document, propsOf({ channel: 'official', apiKey: 'apikey_live', topK: 5, gameSync: false, rapfiThinkMs: 2000 }), handlersOf(seen()));

    const channel = need(body.querySelector<SelectEl>('#channel'), '#channel');
    expect(channel.options.length).toBe(DRAWER_CHANNEL_OPTS.length);
    expect(channel.value).toBe('official');

    const tactics = need(body.querySelector<SelectEl>('#tacticsVersion'));
    expect(tactics.options.length).toBe(tacticsOptions(VERSIONS).length);
    expect(tactics.value).toBe(CURRENT);

    expect(need(body.querySelector<SelectEl>('#rapfiThinkMs')).value).toBe('2000');
    expect(need(body.querySelector<SelectEl>('#topK')).value).toBe('5');
    expect(need(body.querySelector<HTMLInputElement>('#gameSync')).checked).toBe(false);
    expect(need(body.querySelector<HTMLInputElement>('#apiKey')).value).toBe('apikey_live');
    expect(need(body.querySelector<HTMLInputElement>('#endpoint')).placeholder).toBe('https://your-proxy.example/v1');

    /* official：apiKey/endpoint/tactics/probe 显示，orKey 隐藏 */
    expect(need(body.querySelector('#apiKeyLabel')).classList.contains('hidden')).toBe(false);
    expect(need(body.querySelector('#orKeyLabel')).classList.contains('hidden')).toBe(true);
    expect(need(body.querySelector('#endpointLabel')).classList.contains('hidden')).toBe(false);
    expect(need(body.querySelector('#tacticsVersionLabel')).classList.contains('hidden')).toBe(false);
    expect(need(body.querySelector('#probeRow')).classList.contains('hidden')).toBe(false);
  });

  it('mock 渠道隐藏 endpoint/probe/apiKey 行，openrouter 显示 orKey 行', () => {
    const body = mount(DRAWER_HTML);
    renderSettings(document, propsOf({ channel: 'mock' }), handlersOf(seen()));
    expect(need(body.querySelector('#endpointLabel')).classList.contains('hidden')).toBe(true);
    expect(need(body.querySelector('#probeRow')).classList.contains('hidden')).toBe(true);
    expect(need(body.querySelector('#apiKeyLabel')).classList.contains('hidden')).toBe(true);

    renderSettings(document, propsOf({ channel: 'openrouter' }), handlersOf(seen()));
    expect(need(body.querySelector('#orKeyLabel')).classList.contains('hidden')).toBe(false);
    expect(need(body.querySelector('#apiKeyLabel')).classList.contains('hidden')).toBe(true);
  });

  /* jev-router 臂与 openrouter 同形：key 落在 orKey 框（loop.ts 按渠道分派），提示里要点明「必填」。 */
  it('jevrouter 渠道：显示 orKey 行（标注 jv- 必填）+ 战术档行，apiKey 行隐藏', () => {
    const body = mount(DRAWER_HTML);
    renderSettings(document, propsOf({ channel: 'jevrouter' }), handlersOf(seen()));
    expect(need(body.querySelector('#orKeyLabel')).classList.contains('hidden')).toBe(false);
    expect(need(body.querySelector('#apiKeyLabel')).classList.contains('hidden')).toBe(true);
    expect(need(body.querySelector('#tacticsVersionLabel')).classList.contains('hidden')).toBe(false);
    expect(need(body.querySelector('#orKeyLabel')).textContent).toContain('jv-');
    /* #modeHint 由 renderChannelHint 单独写（renderSettings 不碰它），故显式调一次。 */
    renderChannelHint('jevrouter');
    expect(need(body.querySelector('#modeHint')).textContent).toContain('jev-router');
    expect(need(body.querySelector('#modeHint')).textContent).toContain('你');
  });

  it('探测输出与状态类由 props 回填', () => {
    const body = mount(DRAWER_HTML);
    renderSettings(document, propsOf({ channel: 'proxy' }, { probeText: '连接正常 · 812ms', probeState: 'ok' }), handlersOf(seen()));
    const out = need(body.querySelector('#probeOut'));
    expect(out.textContent).toBe('连接正常 · 812ms');
    expect(out.className).toBe('ok');
  });

  it('重复 render 是就地重建（不叠控件、不叠监听）', () => {
    const body = mount(DRAWER_HTML);
    const log = seen();
    const props = propsOf({ channel: 'proxy' });
    renderSettings(document, props, handlersOf(log));
    const first = need(body.querySelector<SelectEl>('#channel'));
    const count = qsa(body, '#drawerBody > *').length;
    renderSettings(document, props, handlersOf(log));

    expect(count).toBeGreaterThan(0);
    expect(qsa(body, '#channel').length).toBe(1);
    expect(qsa(body, '#drawerBody > *').length).toBe(count);
    expect(body.querySelector('#channel')).not.toBe(first);

    select(need(body.querySelector<SelectEl>('#channel')), 'openrouter');
    expect(log.patches).toEqual([{ channel: 'openrouter' }]);
  });
});

describe('renderSettings —— 事件与 patch', () => {
  it('各控件变更发出对应 patch；端点走 onEndpointChange', () => {
    const body = mount(DRAWER_HTML);
    const log = seen();
    renderSettings(document, propsOf({ channel: 'proxy', endpoints: { proxy: '' } }), handlersOf(log));

    select(need(body.querySelector<SelectEl>('#channel')), 'official');
    select(need(body.querySelector<SelectEl>('#topK')), '1');
    select(need(body.querySelector<SelectEl>('#rapfiThinkMs')), '5000');

    const tacticsSel = need(body.querySelector<SelectEl>('#tacticsVersion'));
    select(tacticsSel, tacticsSel.options[0]!.value);

    const endpoint = need(body.querySelector<HTMLInputElement>('#endpoint'));
    endpoint.value = '  https://api.example/v1  ';
    endpoint.dispatchEvent(new Event('change', { bubbles: true }));

    const sync = need(body.querySelector<HTMLInputElement>('#gameSync'));
    sync.checked = true;
    sync.dispatchEvent(new Event('change', { bubbles: true }));

    click(need(body.querySelector('#probeBtn')));

    expect(log.patches).toEqual([
      { channel: 'official' },
      { topK: 1 },
      { rapfiThinkMs: 5000 },
      { tacticsVersion: tacticsSel.options[0]!.value },
      { gameSync: true },
    ]);
    expect(log.endpoints).toEqual([['proxy', 'https://api.example/v1']]);
    expect(log.probes).toBe(1);
  });

  it('双方覆盖三控件回填并回报 side patch', () => {
    const body = mount(DRAWER_HTML);
    const log = seen();
    renderSettings(document, propsOf(), handlersOf(log));

    expect(need(body.querySelector<SelectEl>('#blackChannel')).value).toBe('rapfi');
    expect(need(body.querySelector<SelectEl>('#blackTactics')).value).toBe(CURRENT);
    expect(need(body.querySelector<SelectEl>('#blackThinkMs')).value).toBe('2000');
    expect(need(body.querySelector<SelectEl>('#whiteChannel')).value).toBe('');
    expect(need(body.querySelector<SelectEl>('#whiteThinkMs')).value).toBe('');

    select(need(body.querySelector<SelectEl>('#whiteChannel')), 'mock');
    select(need(body.querySelector<SelectEl>('#blackThinkMs')), '');
    expect(log.sides).toEqual([['white', { channel: 'mock' }], ['black', { rapfiThinkMs: 0 }]]);
  });
});

describe('抽屉开合与就地更新', () => {
  it('openSettingsDrawer/closeSettingsDrawer 只切 #settingsDrawer 与 #drawerMask 的 hidden', () => {
    const body = mount(DRAWER_HTML);
    expect(isDrawerOpen()).toBe(false);

    openSettingsDrawer();
    expect(isDrawerOpen()).toBe(true);
    expect(need(body.querySelector('#drawerMask')).classList.contains('hidden')).toBe(false);

    closeSettingsDrawer();
    expect(isDrawerOpen()).toBe(false);
    expect(need(body.querySelector('#drawerMask')).classList.contains('hidden')).toBe(true);
  });

  it('#drawerClose 与 #drawerMask 的点击关闭抽屉（renderSettings 里 onOnce 绑定）', () => {
    const body = mount(DRAWER_HTML);
    renderSettings(document, propsOf(), handlersOf(seen()));
    openSettingsDrawer();
    click(need(body.querySelector('#drawerClose')));
    expect(isDrawerOpen()).toBe(false);

    openSettingsDrawer();
    click(need(body.querySelector('#drawerMask')));
    expect(isDrawerOpen()).toBe(false);
  });

  it('setProbeOut 就地改文本与状态类（不重建抽屉）', () => {
    const body = mount(DRAWER_HTML);
    renderSettings(document, propsOf(), handlersOf(seen()));
    const before = need(body.querySelector('#probeOut'));

    setProbeOut('探测失败：CORS', 'fail');
    expect(need(body.querySelector('#probeOut'))).toBe(before);
    expect(before.textContent).toBe('探测失败：CORS');
    expect(before.className).toBe('fail');
  });

  it('renderChannelHint / renderChannelChip 写 #modeHint 与 #channelChip', () => {
    const body = mount(DRAWER_HTML);
    renderChannelHint('proxy', body);
    const hint = need(body.querySelector('#modeHint')).textContent ?? '';
    expect(hint).toContain('npm run dev');
    // P8 起旧实现（dev-proxy.py / Cloudflare Pages / functions/）已删除，文案不许再指旧路径
    for (const stale of ['dev-proxy', 'python', 'Pages', 'functions/']) {
      expect(hint).not.toContain(stale);
    }

    renderChannelHint('mock', body);
    expect(need(body.querySelector('#modeHint')).textContent).toContain('离线演示');

    renderChannelChip('proxy', 'proxy', body);
    expect(need(body.querySelector('#channelChip')).textContent).toBe('同源代理');
    renderChannelChip('proxy', 'mock', body);
    expect(need(body.querySelector('#channelChip')).textContent).toBe('同源代理 · 演示');
  });

  it('没有 #drawerBody 时静默跳过（renderSettings 不抛、不建控件）', () => {
    mount('<aside id="settingsDrawer" class="drawer"></aside>');
    expect(() => renderSettings(document, propsOf(), handlersOf(seen()))).not.toThrow();
    expect(document.querySelector('#channel')).toBeNull();
    expect(document.querySelector('#sideCfgBlack')).toBeNull();
  });
});
