/* charts.spec.ts — SVG 图表的运行时断言
 *
 * 覆盖 `renderTrendChart()` / `renderCalibrationChart()` / `renderCalibrationChartInto()` /
 * `renderConfidenceGauge()` / `renderProbabilityBars()`（迁移自 js/charts.js 的
 * trend / reliability / gauge / probability bars）。
 *
 * 断言方式：对**返回的真实 SVG 元素**查节点数与属性（`namespaceURI`、`viewBox`、各 class 的节点数、
 * 轴线文案、aria-label），并把容器版函数的「清空 + 挂载」行为一并断言；不做源码字符串匹配。
 * `animate=false` 一律传，避免 rAF 让断言落在中间态。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { reliability } from '../../src/core/view/calibration.ts';
import {
  MODES,
  renderCalibrationChart,
  renderCalibrationChartInto,
  renderConfidenceGauge,
  renderProbabilityBars,
  renderTrendChart,
  type TrendPoint,
} from '../../src/ui/charts.ts';
import { cleanup, mount, need } from './helpers.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

const POINTS: TrendPoint[] = [
  { ply: 1, notation: 'H8', sideName: 'Jev', value: 0.5 },
  { ply: 2, notation: 'I9', sideName: 'Rapfi', value: 0.7 },
  { ply: 3, notation: 'G7', sideName: 'Jev', value: 0.62, detail: '置信度 62% · 812ms' },
];

/** 用 core 的分箱器造真实校准数据（不手搓 Bin）。 */
function bins(nBins = 5) {
  return reliability(
    [
      { p: 0.05, y: 0 }, { p: 0.18, y: 0 }, { p: 0.42, y: 1 },
      { p: 0.55, y: 0 }, { p: 0.72, y: 1 }, { p: 0.93, y: 1 }, { p: 0.97, y: 1 },
    ],
    nBins,
  );
}

afterEach(cleanup);

describe('renderTrendChart', () => {
  it('返回真实 <svg>，挂进容器并加 trend-root；节点数符合口径', () => {
    const host = mount('<div id="trend"></div>');
    const box = need(host.querySelector<HTMLElement>('#trend'));
    const svg = renderTrendChart(box, POINTS, { mode: 'win' });

    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 470 158');
    expect(box.classList.contains('trend-root')).toBe(true);
    expect(box.querySelectorAll('svg').length).toBe(1);
    expect(box.firstElementChild).toBe(svg);

    expect(svg.getAttribute('aria-label')).toBe('胜率趋势图，共 3 个决策');
    expect(svg.querySelector('.trend-line')).not.toBeNull();
    expect(svg.querySelectorAll('path').length).toBe(3);
    expect(svg.querySelectorAll('defs clipPath').length).toBe(2);
    expect(svg.querySelectorAll('line.grid').length).toBe(MODES.win.ticks.length);
    expect(svg.querySelectorAll('text.tick-label').length).toBeGreaterThanOrEqual(MODES.win.ticks.length);
    expect(svg.querySelector('.land-ring')).not.toBeNull();
    expect(svg.querySelector('.crosshair line')).not.toBeNull();
    expect(svg.querySelector('.crosshair circle')).not.toBeNull();
  });

  it('无决策点时不画线，改在容器里补空态提示（仍返回 svg）', () => {
    const host = mount('<div id="trend"></div>');
    const box = need(host.querySelector<HTMLElement>('#trend'));
    const svg = renderTrendChart(box, [], { mode: 'score' });

    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.getAttribute('aria-label')).toBe('局势分趋势图，共 0 个决策');
    expect(svg.querySelectorAll('path').length).toBe(0);
    expect(svg.querySelectorAll('line.grid').length).toBe(MODES.score.ticks.length);
    const empty = need(box.querySelector('.chart-empty'));
    expect(empty.textContent).toContain('尚无 Jev 决策数据');
  });

  it('重复渲染先清空容器（不叠图、不叠空态）', () => {
    const host = mount('<div id="trend"></div>');
    const box = need(host.querySelector<HTMLElement>('#trend'));
    renderTrendChart(box, POINTS);
    renderTrendChart(box, []);
    /* 空态提示自己在 `.chart-empty` 里带一个 svg 图标，所以按「首个子元素是图」来断言 */
    expect(need(box.firstElementChild).tagName.toLowerCase()).toBe('svg');
    expect(box.querySelectorAll('.chart-empty').length).toBe(1);
    renderTrendChart(box, POINTS);
    /* 有数据时容器里是「图 + .trend-tip 浮动提示」，关键是空态节点被清掉 */
    expect(need(box.firstElementChild).tagName.toLowerCase()).toBe('svg');
    expect(box.querySelector('.trend-tip')).not.toBeNull();
    expect(box.querySelectorAll('.chart-empty').length).toBe(0);
  });
});

describe('renderCalibrationChart', () => {
  it('返回真实 <svg>；网格/对角线固定，每个有样本分箱一个点（含 title）', () => {
    const data = bins();
    const used = data.filter((b) => b.n).length;
    expect(used).toBeGreaterThan(0);

    const svg = renderCalibrationChart(data);
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.getAttribute('class')).toBe('rel-svg');
    expect(svg.getAttribute('aria-label')).toContain(`${used} 个有样本的分箱`);

    /* 3 组网格横线 + 1 条完美校准线 + 每箱一条偏差竖线 */
    expect(svg.querySelectorAll('line').length).toBe(4 + used);
    expect(svg.querySelectorAll('line.grid').length).toBe(3);
    expect(svg.querySelector('.rel-diag')).not.toBeNull();
    expect(svg.querySelectorAll('.rel-gap').length).toBe(used);
    expect(svg.querySelectorAll('circle.rel-dot').length).toBe(used);
    expect(svg.querySelectorAll('circle.rel-dot > title').length).toBe(used);
    expect(need(svg.querySelector('.rel-axis')).textContent).toBe('Jev 说的胜率');
  });

  it('无样本分箱不画点；轴标签可由 opts 覆盖', () => {
    const svg = renderCalibrationChart([{ lo: 0, hi: 0.1, n: 0, conf: 0.05, acc: 0 }], { axisLabel: '自定义轴' });
    expect(svg.querySelectorAll('circle').length).toBe(0);
    expect(svg.querySelectorAll('line').length).toBe(4);
    expect(need(svg.querySelector('.rel-axis')).textContent).toBe('自定义轴');
  });

  it('renderCalibrationChartInto 清空容器 + 加 rel-root + 挂图', () => {
    const host = mount('<div id="rel">旧的</div>');
    const box = need(host.querySelector<HTMLElement>('#rel'));
    const svg = renderCalibrationChartInto(box, bins());
    expect(box.classList.contains('rel-root')).toBe(true);
    expect(box.children.length).toBe(1);
    expect(box.firstElementChild).toBe(svg);
    renderCalibrationChartInto(box, bins());
    expect(box.children.length).toBe(1);
  });
});

describe('renderConfidenceGauge / renderProbabilityBars', () => {
  it('仪表盘：2 个圆 + 数值文本，animate=false 时弧线直接落终值', () => {
    const svg = renderConfidenceGauge(0.62, 46, false);
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.getAttribute('class')).toBe('gauge');
    expect(svg.getAttribute('aria-label')).toBe('置信度 62%');
    expect(svg.querySelectorAll('circle').length).toBe(2);
    expect(svg.querySelector('.gauge-track')).not.toBeNull();
    expect(need(svg.querySelector('.gauge-num')).textContent).toBe('62');

    const c = 2 * Math.PI * (46 / 2 - 4);
    expect(need(svg.querySelector('.gauge-arc')).getAttribute('stroke-dashoffset')).toBe((c * (1 - 0.62)).toFixed(1));
  });

  it('概率条：每个候选一行，选中项带 is-chosen，条宽按概率', () => {
    const frag = renderProbabilityBars(
      [{ notation: 'H8', p: 0.42 }, { notation: 'I9', p: 0.19 }],
      'H8',
      false,
    );
    expect(frag.childNodes.length).toBe(2);
    const rows = Array.from(frag.querySelectorAll<HTMLElement>('.bar-row'));
    expect(rows.length).toBe(2);
    expect(rows[0]!.classList.contains('is-chosen')).toBe(true);
    expect(rows[1]!.classList.contains('is-chosen')).toBe(false);
    rows.forEach((r) => expect(r.querySelectorAll('span').length).toBe(3));
    expect(need(rows[0]!.querySelector('.k')).textContent).toBe('H8');
    expect(need(rows[0]!.querySelector('.p')).textContent).toBe('42.0%');
    expect(need(rows[0]!.querySelector('.bar i')).getAttribute('style')).toContain('scaleX(0.420)');
    expect(need(rows[1]!.querySelector('.bar i')).getAttribute('style')).toContain('scaleX(0.190)');
  });

  it('概率条：空/缺省输入给空片段', () => {
    expect(renderProbabilityBars(null).childNodes.length).toBe(0);
    expect(renderProbabilityBars([]).childNodes.length).toBe(0);
    const frag = renderProbabilityBars([{ notation: 'A1', p: 0.5 }], null, false);
    expect(frag.querySelectorAll('.is-chosen').length).toBe(0);
  });
});
