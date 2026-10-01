/* experiment.spec.ts — 对比实验面板的运行时断言
 *
 * 覆盖 `renderExperimentPanel()` / `bindExperimentPanel()` / `renderExpStatus()` / `renderExpResults()` /
 * `syncMatchSettings()` / `renderModeSwitch()`（旧 js/app.js:1139-1238 的 EXP 面板 + js/app.js:1875-1910
 * 的对局设置：`#mode`/`#side`/`#speed`/`#speedVal`/`#speedRow`/`#expGames`/`#expStatus`/`#expResults`）。
 *
 * 断言方式：渲染后查 DOM（控件值、选项、hidden 属性、结果行结构与文案）与行为（handler 收到的参数、
 * 重复 render 是否叠行），不做源码字符串匹配。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SideConfig } from '../../src/core/persist.ts';
import { CURRENT, VERSIONS } from '../../src/core/tactics-versions.ts';
import {
  bindExperimentPanel,
  bindMatchSettings,
  clampGames,
  createExperimentState,
  expResultRows,
  expSummary,
  expTag,
  mkSide,
  planGame,
  pushResult,
  readExperimentConfig,
  renderExperimentPanel,
  renderExpResults,
  renderExpStatus,
  sidesForGame,
  speedLabel,
  syncMatchSettings,
  winnerSideOf,
  type ExperimentPanelProps,
} from '../../src/ui/panels/experiment.ts';
import { qsa, type SelectEl } from '../../src/ui/dom.ts';
import { cleanup, click, input, mount, need, select } from './helpers.ts';

const HTML = `
  <div class="mode-switch">
    <button data-mode="human-ai" aria-pressed="false">人 vs 机器</button>
    <button data-mode="ai-ai" aria-pressed="false">机 vs 机</button>
    <button data-mode="pvp" aria-pressed="false">人 vs 人</button>
  </div>
  <select id="mode">
    <option value="human-ai">人 vs 机器</option>
    <option value="ai-ai">机 vs 机</option>
    <option value="pvp">人 vs 人</option>
  </select>
  <select id="side"><option value="black">黑</option><option value="white">白</option></select>
  <input id="speed" type="range" min="1" max="10" value="6">
  <span id="speedVal"></span>
  <div id="speedRow"></div>
  <input id="expGames" type="number" value="4">
  <div id="expStatus"></div>
  <button id="expStartBtn" type="button">开始</button>
  <button id="expStopBtn" type="button" class="hidden">停止</button>
  <div id="expResults"></div>
  <div id="expSideA" class="exp-side"></div>
  <div id="expSideB" class="exp-side"></div>
`;

const CFG_A: SideConfig = { channel: 'proxy', tactics: CURRENT, rapfiThinkMs: 0 };
const CFG_B: SideConfig = { channel: 'random', tactics: 'v0-off', rapfiThinkMs: 1000 };

function propsOf(patch: Partial<ExperimentPanelProps> = {}): ExperimentPanelProps {
  return {
    state: createExperimentState({ total: 4 }),
    versions: VERSIONS,
    config: { A: CFG_A, B: CFG_B },
    match: { mode: 'human-ai', side: 'black', speed: 6 },
    games: 8,
    ...patch,
  };
}

afterEach(cleanup);

describe('实验档位与对局设置回填', () => {
  it('A/B 三控件按 config 回填，局数写入 #expGames', () => {
    const body = mount(HTML);
    renderExperimentPanel(body, propsOf(), {});

    expect(need(body.querySelector<SelectEl>('#expChanA')).value).toBe('proxy');
    expect(need(body.querySelector<SelectEl>('#expTacA')).value).toBe(CURRENT);
    expect(need(body.querySelector<SelectEl>('#expChanB')).value).toBe('random');
    expect(need(body.querySelector<SelectEl>('#expTacB')).value).toBe('v0-off');
    expect(need(body.querySelector<SelectEl>('#expThinkB')).value).toBe('1000');
    expect(need(body.querySelector<HTMLInputElement>('#expGames')).value).toBe('8');
  });

  it('缺省 games 时不覆盖 #expGames 里的用户草稿', () => {
    const body = mount(HTML);
    const props = propsOf();
    delete props.games;
    renderExperimentPanel(body, props, {});
    expect(need(body.querySelector<HTMLInputElement>('#expGames')).value).toBe('4');
  });

  it('speedLabel 口径 (150 + v*150)/1000 + s，写进 #speedVal；非机机模式隐藏 #speedRow', () => {
    const body = mount(HTML);
    expect(speedLabel(6)).toBe('1.05s');
    renderExperimentPanel(body, propsOf(), {});
    expect(need(body.querySelector('#speedVal')).textContent).toBe('1.05s');
    expect(need(body.querySelector('#speedRow')).hasAttribute('hidden')).toBe(true);
    /* class 与属性必须同步切：index.html 里 `#speedRow` 初始就是 `class="speed-row hidden"`，
       只切属性会让「思考时长」这一行永远不显示。 */
    expect(need(body.querySelector('#speedRow')).classList.contains('hidden')).toBe(true);
    expect(need(body.querySelector<SelectEl>('#mode')).value).toBe('human-ai');

    renderExperimentPanel(body, propsOf({ match: { mode: 'ai-ai', side: 'white', speed: 2 } }), {});
    expect(need(body.querySelector('#speedVal')).textContent).toBe('0.45s');
    expect(need(body.querySelector('#speedRow')).hasAttribute('hidden')).toBe(false);
    expect(need(body.querySelector('#speedRow')).classList.contains('hidden')).toBe(false);
    expect(need(body.querySelector<SelectEl>('#side')).value).toBe('white');
  });

  it('模式按钮组反映 #mode，实验跑动中禁用', () => {
    const body = mount(HTML);
    renderExperimentPanel(body, propsOf({ match: { mode: 'ai-ai', side: 'black', speed: 6 } }), {});
    const aiAi = need(body.querySelector<HTMLButtonElement>('.mode-switch button[data-mode="ai-ai"]'));
    expect(aiAi.classList.contains('active')).toBe(true);
    expect(aiAi.getAttribute('aria-pressed')).toBe('true');
    expect(aiAi.disabled).toBe(false);
    expect(need(body.querySelector('.mode-switch button[data-mode="human-ai"]')).classList.contains('active')).toBe(false);

    renderExperimentPanel(
      body,
      propsOf({ state: createExperimentState({ running: true, total: 4 }), match: { mode: 'ai-ai', side: 'black', speed: 6 } }),
      {},
    );
    expect(qsa<HTMLButtonElement>(body, '.mode-switch button').every((b) => b.disabled)).toBe(true);
  });
});

describe('实验状态与结果', () => {
  it('#expStatus 三态 + 启停按钮显隐', () => {
    const body = mount(HTML);
    renderExpStatus(createExperimentState(), body);
    expect(need(body.querySelector('#expStatus')).textContent).toBe('待开始');
    expect(need(body.querySelector('#expStartBtn')).hasAttribute('hidden')).toBe(false);
    expect(need(body.querySelector('#expStopBtn')).hasAttribute('hidden')).toBe(true);
    expect(need(body.querySelector('#expStopBtn')).classList.contains('hidden')).toBe(true);

    const running = createExperimentState({ running: true, idx: 1, total: 4 });
    renderExpStatus(running, body);
    expect(need(body.querySelector('#expStatus')).textContent).toBe('进行中 2/4');
    expect(need(body.querySelector('#expStartBtn')).hasAttribute('hidden')).toBe(true);
    expect(need(body.querySelector('#expStopBtn')).hasAttribute('hidden')).toBe(false);
    /* 夹具里 `#expStopBtn` 初始带 `class="hidden"`——只切 `hidden` 属性它不会出现。 */
    expect(need(body.querySelector('#expStopBtn')).classList.contains('hidden')).toBe(false);

    const done = createExperimentState({ idx: 2, total: 4 });
    pushResult(done, {
      blackChan: 'proxy', whiteChan: 'random', blackTac: CURRENT, whiteTac: null,
      blackThink: 0, whiteThink: 0, winner: 'black', winnerChan: 'A', by: null,
    });
    renderExpStatus(done, body);
    expect(need(body.querySelector('#expStatus')).textContent).toBe('已完成');
  });

  it('#expResults 写出汇总头与每局一行（含人判标记），重复 render 不叠行', () => {
    const body = mount(HTML);
    const state = createExperimentState({ total: 4 });
    pushResult(state, {
      blackChan: 'proxy', whiteChan: 'random', blackTac: CURRENT, whiteTac: null,
      blackThink: 0, whiteThink: 2000, winner: 'black', winnerChan: 'A', by: null,
    });
    pushResult(state, {
      blackChan: 'random', whiteChan: 'proxy', blackTac: CURRENT, whiteTac: null,
      blackThink: 0, whiteThink: 0, winner: null, winnerChan: null, by: 'human',
    });

    renderExpResults(state, body);
    const head = need(body.querySelector('#expResults .exp-head'));
    expect(head.textContent).toBe(expSummary(state));
    expect(head.textContent).toContain('1胜');
    expect(head.textContent).toContain('和棋 1');

    const rows = expResultRows(state);
    expect(rows.length).toBe(2);
    expect(qsa(body, '#expResults .exp-row').length).toBe(2);
    expect(rows[0]!.children.length).toBe(5);
    expect(rows[0]!.querySelector('b')!.textContent).toContain('胜');
    expect(rows[1]!.querySelector('b')!.textContent).toContain('和棋');
    expect(rows[1]!.querySelector('i')!.textContent).toBe('人判');
    expect(rows[1]!.textContent).toContain('(黑)');

    renderExpResults(state, body);
    expect(qsa(body, '#expResults .exp-row').length).toBe(2);
    expect(qsa(body, '#expResults .exp-head').length).toBe(1);

    renderExpResults(createExperimentState(), body);
    expect(qsa(body, '#expResults .exp-row').length).toBe(0);
    expect(body.querySelector('#expResults .exp-head')).toBeNull();
  });
});

describe('实验事件绑定与纯函数口径', () => {
  it('bindExperimentPanel 绑启停与局数（越界归一 1..50）', () => {
    const body = mount(HTML);
    const calls: string[] = [];
    bindExperimentPanel(
      {
        onStart: () => calls.push('start'),
        onStop: () => calls.push('stop'),
        onGamesChange: (games) => calls.push('games:' + games),
      },
      body,
    );

    click(need(body.querySelector('#expStartBtn')));
    click(need(body.querySelector('#expStopBtn')));
    input(need(body.querySelector<HTMLInputElement>('#expGames')), '99', 'change');
    input(need(body.querySelector<HTMLInputElement>('#expGames')), '0', 'change');
    /* 旧口径 `parseInt(v,10) || 4`：0 → 落回默认 4，而不是夹到下限 1 */
    expect(calls).toEqual(['start', 'stop', 'games:50', 'games:4']);

    expect(clampGames(undefined)).toBe(4);
    expect(clampGames('7')).toBe(7);
  });

  it('bindMatchSettings 绑 #mode change 与 #speed input（就地更新 #speedVal）', () => {
    const body = mount(HTML);
    const modes: string[] = [];
    const speeds: number[] = [];
    syncMatchSettings({ mode: 'human-ai', side: 'black', speed: 6 }, body);
    expect(need(body.querySelector('#speedRow')).hasAttribute('hidden')).toBe(true);
    bindMatchSettings({ onModeChange: (m) => modes.push(m), onSpeedChange: (v) => speeds.push(v) }, body);

    select(need(body.querySelector<SelectEl>('#mode')), 'ai-ai');
    input(need(body.querySelector<HTMLInputElement>('#speed')), '10');
    expect(modes).toEqual(['ai-ai']);
    expect(speeds).toEqual([10]);
    expect(need(body.querySelector('#speedVal')).textContent).toBe(speedLabel(10));
    /* 显隐归 syncMatchSettings；bindMatchSettings 只发事件 */
    expect(need(body.querySelector('#speedRow')).hasAttribute('hidden')).toBe(true);
  });

  it('readExperimentConfig 读回 6 个控件 + #expGames', () => {
    const body = mount(HTML);
    renderExperimentPanel(body, propsOf({ config: { A: { ...CFG_A, rapfiThinkMs: 3000 }, B: CFG_B } }), {});
    input(need(body.querySelector<HTMLInputElement>('#expGames')), '12', 'change');
    expect(readExperimentConfig(body)).toEqual({
      chanA: 'proxy', chanB: 'random', tacA: CURRENT, tacB: 'v0-off',
      thinkA: 3000, thinkB: 1000, total: 12,
    });
  });

  it('syncMatchSettings 就地同步（不重建子树）', () => {
    const body = mount(HTML);
    const node = need(body.querySelector<SelectEl>('#mode'));
    syncMatchSettings({ mode: 'pvp', side: 'white', speed: 4 }, body);
    expect(need(body.querySelector<SelectEl>('#mode'))).toBe(node);
    expect(node.value).toBe('pvp');
    expect(need(body.querySelector('#speedVal')).textContent).toBe(speedLabel(4));
  });

  it('纯函数口径：expTag / mkSide / sidesForGame / winnerSideOf / planGame / expSummary', () => {
    expect(expTag(new Date('2026-09-29T11:12:22.000Z'))).toBe('exp-20260929111222');

    const state = createExperimentState({ chanA: 'proxy', chanB: 'random', thinkB: 1000 });
    expect(mkSide(state, 'B')).toEqual({ channel: 'random', tactics: CURRENT, rapfiThinkMs: 1000 });

    const g1 = sidesForGame(state, 1);
    expect(g1.aBlack).toBe(true);
    expect(g1.black.channel).toBe('proxy');
    expect(sidesForGame(state, 2).black.channel).toBe('random');

    expect(winnerSideOf(1, 'black', 'black')).toBe('A');
    expect(winnerSideOf(2, 'black', 'black')).toBe('B');
    expect(winnerSideOf(1, null, 'black')).toBeNull();

    expect(planGame(createExperimentState())).toBeNull();
    const plan = planGame(createExperimentState({ running: true, total: 4 }));
    expect(plan!.gameNo).toBe(1);
    expect(plan!.expInfo.blackChannel).toBe('proxy');
    expect(plan!.expInfo.tag).toBe('');

    expect(expSummary(createExperimentState())).toContain('0胜 · 0胜 · 和棋 0');
  });
});
