/* side-config.spec.ts — 「双方覆盖」与实验 A/B 档位三控件的运行时断言
 *
 * 覆盖 `renderSideConfig()` / `renderExperimentSides()` / `renderSideSlotInto()`（旧的
 * js/app.js:947-980 `renderSideCfg()` 的口径：每侧 渠道 / 战术 / 思考 三个 `<select>`）。
 *
 * 断言方式：渲染后查 DOM（控件个数、选项表、选中值、名称行）与行为（三个控件各自发出的 patch），
 * 不做源码字符串匹配。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SideConfig } from '../../src/core/persist.ts';
import { CURRENT, VERSIONS } from '../../src/core/tactics-versions.ts';
import {
  drawerSlots,
  experimentSlots,
  renderExperimentSides,
  renderSideConfig,
  renderSideSlotInto,
} from '../../src/ui/panels/side-config.ts';
import { EXP_CHANS, SIDE_CHANS, THINK_OPTS } from '../../src/ui/panels/options.ts';
import { qsa, type SelectEl } from '../../src/ui/dom.ts';
import { cleanup, mount, need, select } from './helpers.ts';

const HTML = `
  <div id="sideCfgBlack" class="side-cfg"></div>
  <div id="sideCfgWhite" class="side-cfg"></div>
  <div id="expSideA" class="exp-side"></div>
  <div id="expSideB" class="exp-side"></div>
`;

const BLACK: SideConfig = { channel: 'rapfi', tactics: CURRENT, rapfiThinkMs: 2000 };
const WHITE: SideConfig = { channel: '', tactics: '', rapfiThinkMs: 0 };
const SIDE_A: SideConfig = { channel: 'proxy', tactics: CURRENT, rapfiThinkMs: 0 };
const SIDE_B: SideConfig = { channel: 'random', tactics: 'v0-off', rapfiThinkMs: 1000 };

function ids(root: HTMLElement, prefix: string): string[] {
  return qsa<HTMLElement>(root, 'select').map((s) => s.id).filter((id) => id.startsWith(prefix));
}

afterEach(cleanup);

describe('renderSideConfig —— 抽屉双方覆盖', () => {
  it('每侧三个控件（渠道/战术/思考）回填当前覆盖值', () => {
    const body = mount(HTML);
    renderSideConfig(document, { versions: VERSIONS, black: BLACK, white: WHITE }, {});

    const black = need(body.querySelector<HTMLElement>('#sideCfgBlack'));
    expect(ids(black, 'black')).toEqual(['blackChannel', 'blackTactics', 'blackThinkMs']);
    expect(need(black.querySelector('.side-cfg-name')).textContent).toBe('黑方');
    expect(need(black.querySelector<SelectEl>('#blackChannel')).value).toBe('rapfi');
    expect(need(black.querySelector<SelectEl>('#blackTactics')).value).toBe(CURRENT);
    expect(need(black.querySelector<SelectEl>('#blackThinkMs')).value).toBe('2000');

    const white = need(body.querySelector<HTMLElement>('#sideCfgWhite'));
    expect(ids(white, 'white')).toEqual(['whiteChannel', 'whiteTactics', 'whiteThinkMs']);
    expect(need(white.querySelector('.side-cfg-name')).textContent).toBe('白方');
    expect(need(white.querySelector<SelectEl>('#whiteChannel')).value).toBe('');
    expect(need(white.querySelector<SelectEl>('#whiteThinkMs')).value).toBe('');
  });

  it('渠道表用 SIDE_CHANS（含「跟随全局」空值项），思考表用 THINK_OPTS', () => {
    const body = mount(HTML);
    renderSideConfig(document, { versions: VERSIONS, black: BLACK, white: WHITE }, {});

    const channel = need(body.querySelector<SelectEl>('#blackChannel'));
    expect(channel.options.length).toBe(SIDE_CHANS.length);
    expect(channel.options[0]!.value).toBe('');
    expect(channel.options[0]!.text).toBe('跟随全局');

    const think = need(body.querySelector<SelectEl>('#blackThinkMs'));
    expect(think.options.length).toBe(THINK_OPTS.length);
    expect(think.options[0]!.value).toBe('');
  });

  it('三个控件各自发出对应的 side patch', () => {
    const body = mount(HTML);
    const seen: [string, Partial<SideConfig>][] = [];
    renderSideConfig(document, { versions: VERSIONS, black: BLACK, white: WHITE }, {
      onSideChange: (side, patch) => seen.push([side, patch]),
    });

    select(need(body.querySelector<SelectEl>('#blackChannel')), 'official');
    const tactics = need(body.querySelector<SelectEl>('#blackTactics'));
    select(tactics, tactics.options[0]!.value);
    select(need(body.querySelector<SelectEl>('#blackThinkMs')), '');
    select(need(body.querySelector<SelectEl>('#whiteChannel')), 'mock');

    expect(seen).toEqual([
      ['black', { channel: 'official' }],
      ['black', { tactics: tactics.options[0]!.value }],
      ['black', { rapfiThinkMs: 0 }],
      ['white', { channel: 'mock' }],
    ]);
  });

  it('重复渲染是就地重建（每侧仍只有三个控件）', () => {
    const body = mount(HTML);
    renderSideConfig(document, { versions: VERSIONS, black: BLACK, white: WHITE }, {});
    const count = qsa(body, 'select').length;
    renderSideConfig(document, { versions: VERSIONS, black: BLACK, white: WHITE }, {});
    expect(count).toBe(6);
    expect(qsa(body, 'select').length).toBe(count);
  });

  it('renderSideSlotInto 可把任一槽位画进任意容器', () => {
    const host = mount('<div id="probe-slot"></div>');
    const slot = need(host.querySelector<HTMLElement>('#probe-slot'));
    const patches: Partial<SideConfig>[] = [];
    renderSideSlotInto(slot, drawerSlots(VERSIONS).black, BLACK, (patch) => patches.push(patch));

    expect(slot.classList.contains('side-cfg')).toBe(true);
    expect(ids(slot, 'black')).toEqual(['blackChannel', 'blackTactics', 'blackThinkMs']);
    select(need(slot.querySelector<SelectEl>('#blackChannel')), 'openrouter');
    expect(patches).toEqual([{ channel: 'openrouter' }]);
  });
});

describe('renderExperimentSides —— 实验 A/B 档位', () => {
  it('A/B 两侧三控件回填 config，渠道表用 EXP_CHANS（无「跟随全局」项）', () => {
    const body = mount(HTML);
    renderExperimentSides(document, { versions: VERSIONS, A: SIDE_A, B: SIDE_B }, {});

    const a = need(body.querySelector<HTMLElement>('#expSideA'));
    expect(ids(a, 'exp')).toEqual(['expChanA', 'expTacA', 'expThinkA']);
    expect(need(a.querySelector('.exp-side-name')).textContent).toBe('A 方');
    expect(need(a.querySelector('.dot')).classList.contains('mo')).toBe(true);
    expect(need(a.querySelector<SelectEl>('#expChanA')).value).toBe('proxy');
    expect(need(a.querySelector<SelectEl>('#expTacA')).value).toBe(CURRENT);
    expect(need(a.querySelector<SelectEl>('#expThinkA')).value).toBe('');

    const b = need(body.querySelector<HTMLElement>('#expSideB'));
    expect(need(b.querySelector('.exp-side-name')).textContent).toBe('B 方');
    expect(need(b.querySelector('.dot')).classList.contains('zhu')).toBe(true);
    expect(need(b.querySelector<SelectEl>('#expChanB')).value).toBe('random');
    expect(need(b.querySelector<SelectEl>('#expTacB')).value).toBe('v0-off');
    expect(need(b.querySelector<SelectEl>('#expThinkB')).value).toBe('1000');

    const chanA = need(a.querySelector<SelectEl>('#expChanA'));
    expect(chanA.options.length).toBe(EXP_CHANS.length);
    expect(chanA.options[0]!.value).toBe('proxy');
    expect(a.querySelectorAll('.exp-field').length).toBe(3);
  });

  it('A/B 控件变更回报带侧别标记的 patch', () => {
    const body = mount(HTML);
    const seen: [string, Partial<SideConfig>][] = [];
    renderExperimentSides(document, { versions: VERSIONS, A: SIDE_A, B: SIDE_B }, {
      onSideChange: (side, patch) => seen.push([side, patch]),
    });

    select(need(body.querySelector<SelectEl>('#expChanB')), 'official');
    select(need(body.querySelector<SelectEl>('#expThinkA')), '5000');
    expect(seen).toEqual([
      ['B', { channel: 'official' }],
      ['A', { rapfiThinkMs: 5000 }],
    ]);
  });

  it('槽位描述表与 DOM 契约一致（容器 id 必须已存在于 index.html）', () => {
    const body = mount(HTML);
    const slots = experimentSlots(VERSIONS);
    expect(slots.A.containerId).toBe('expSideA');
    expect(slots.B.containerId).toBe('expSideB');
    expect(slots.A.channelId).toBe('expChanA');
    expect(slots.B.thinkId).toBe('expThinkB');
    expect(drawerSlots(VERSIONS).black.containerId).toBe('sideCfgBlack');

    renderExperimentSides(document, { versions: VERSIONS, A: SIDE_A, B: SIDE_B }, {});
    expect(need(body.querySelector('#expSideA')).classList.contains('exp-side')).toBe(true);
    expect(need(body.querySelector<HTMLElement>('#expSideA')).querySelector('label')!.parentElement).toBe(
      need(body.querySelector('#expSideA')),
    );
  });
});
