/* charts.ts — 零依赖 SVG 数据可视化（迁移自 js/charts.js，249 行）
 *
 * 来源与对应关系（逐函数）：
 *   js/charts.js:8-13   `el()` SVG 工厂           → `src/ui/dom.ts` 的 `svgEl()`
 *   js/charts.js:15-19  `MODES`                   → `MODES`（逐字：刻度、mid、fmt）
 *   js/charts.js:22-32  `smoothPath()`            → `smoothPath()`（Catmull-Rom → 贝塞尔，逐字）
 *   js/charts.js:39-156 `renderTrend()`           → `renderTrendChart()`
 *   js/charts.js:161-202`reliability()`           → `renderCalibrationChart()` / `...Into()`
 *   js/charts.js:205-224`gauge()`                 → `renderConfidenceGauge()`
 *   js/charts.js:227-245`bars()`                  → `renderProbabilityBars()`
 *
 * 坐标口径**逐字照搬**（不改布局、不改刻度、不改透明度公式）：
 *   趋势图 viewBox 0 0 470 158，内边距 L38 R14 T12 B24；`xOf(i)` 单点时取 L+iw/2；
 *   面积路径 = 折线 + 末点垂线到中线 + 首点垂线到中线；中线以下 clipDn（--zhu）/ 以上 clipUp（--mo）；
 *   可靠性图 viewBox 0 0 300 168，内边距 L36 R10 T10 B26，刻度 0/0.5/1，偏差线 `stroke-opacity = 0.14 + 0.5*(b.n/maxN)`；
 *   仪表 `r = size/2 - 4`，`transform="rotate(-90 cx cy)"`；概率条 `scaleX((max(2,round(p*100))/100).toFixed(3))`。
 *
 * 刻意差异（相对 js/charts.js，逐条）：
 *  1. **返回真实 SVG DOM 元素**，不再用 innerHTML 拼 HTML 片段（旧 `bars()`/tooltip/空态 glyph
 *     都是拼串）。调用方拿到的节点可直接 append / 断言节点数。
 *  2. `renderTrendChart` 仍需要容器（tooltip 与空态说明挂在容器上，与旧实现一致）；
 *     `renderCalibrationChart(data)` 是无容器的纯构造，返回 `<svg>` 由调用方插入
 *     （旧 `reliability(container, …)` 的容器行为由 `renderCalibrationChartInto()` 保留）。
 *  3. 动画统一走 `requestAnimationFrame`，但**没有 rAF 的环境（SSR / 测试桩）直接落终值**，
 *     不再抛错（旧实现无条件调用）。
 *  4. 固定 id `clipUp` / `clipDn` 照旧（同一页面只挂一张趋势图，CSS 亦按此写）；多图会撞 id。
 *  5. 类型：`TrendMode` 复用 `src/core/session.ts` 的定义，`CalibrationPoint` 复用
 *     `src/core/view/calibration.ts` 的 `Bin`，避免同一形状定义两遍。
 *
 * 本模块不 import node:*，不碰 localStorage / fetch；只依赖 DOM。
 */
import type { Bin } from '../core/view/calibration.ts';
import type { TrendMode } from '../core/session.ts';
import { append, clear, el, svgEl } from './dom.ts';

/** 趋势图数据点（旧 `buildSeries()` 的产出经 mode 归一后的形态）。 */
export interface TrendPoint {
  /** 1 起的手数（横轴标签用） */
  ply: number;
  /** 棋谱记法 */
  notation: string;
  /** 该手走子方的显示名 */
  sideName: string;
  /** **已归一**到该 mode 的 yMin..yMax（旧口径：由调用方换算，本模块不认 win/score/conf 字段） */
  value: number;
  /** tooltip 第三行的补充说明（如「置信度 62% · 812ms」） */
  detail?: string;
}

/** 一种纵轴口径（js/charts.js:15-19 逐字）。 */
export interface ChartMode {
  label: string;
  yMin: number;
  yMax: number;
  ticks: readonly number[];
  fmt: (v: number) => string;
  /** 中线（上下分区的分界） */
  mid: number;
}

/** 纵轴口径表（键与 `src/core/session.ts` 的 `TrendMode` 对齐）。 */
export const MODES: Record<TrendMode, ChartMode> = {
  win: { label: '胜率', yMin: 0, yMax: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v) => (v * 100).toFixed(0) + '%', mid: 0.5 },
  score: { label: '局势分', yMin: 0, yMax: 10, ticks: [0, 2.5, 5, 7.5, 10], fmt: (v) => v.toFixed(1), mid: 5 },
  conf: { label: '置信度', yMin: 0, yMax: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v) => (v * 100).toFixed(0) + '%', mid: 0.5 },
};

/** 趋势图版面常量（js/charts.js:41 逐字）。 */
export const TREND_LAYOUT = { W: 470, H: 158, L: 38, R: 14, T: 12, B: 24 } as const;
/** 可靠性图版面常量（js/charts.js:163 逐字）。 */
export const REL_LAYOUT = { W: 300, H: 168, L: 36, R: 10, T: 10, B: 26 } as const;

export interface TrendOpts {
  mode?: TrendMode;
  /** 兼容旧签名：图例由静态 HTML（#legendFirst/#legendSecond）承担，这里不使用 */
  firstName?: string;
  secondName?: string;
  unit?: string;
}

/** 可靠性图数据点 = 校准分箱（`src/core/view/calibration.ts` 的 `Bin`，不重复定义）。 */
export type CalibrationPoint = Bin;

export interface CalibrationOpts {
  /** 轴标签文案（默认「Jev 说的胜率」，与 js/charts.js:200 一致） */
  axisLabel?: string;
}

/** rAF 存在才播动画；否则直接落终值（无 DOM 计时器的环境不炸）。 */
function raf(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else fn();
}

/** Catmull-Rom → 贝塞尔（js/charts.js:22-32 逐字；<3 点退化成折线）。 */
export function smoothPath(pts: readonly (readonly [number, number])[]): string {
  if (pts.length < 3) {
    return pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  }
  const first = pts[0]!;
  let d = 'M' + first[0] + ' ' + first[1];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += 'C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) +
      ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
  }
  return d;
}

/** 空态：自绘 SVG glyph + 一句说明（旧实现拼 innerHTML，这里建真实节点）。 */
function emptyChartNode(message: string): HTMLElement {
  const glyph = svgEl('svg', {
    class: 'glyph', width: 76, height: 42, viewBox: '0 0 76 42',
    'aria-hidden': 'true', fill: 'none',
  });
  append(glyph, [
    svgEl('line', { x1: 7, y1: 6, x2: 7, y2: 35, stroke: 'currentColor', 'stroke-width': 1 }),
    svgEl('line', { x1: 7, y1: 35, x2: 69, y2: 35, stroke: 'currentColor', 'stroke-width': 1 }),
    svgEl('path', {
      class: 'g-dash', d: 'M12 30 L26 21 L38 25 L52 13 L64 17',
      stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round',
    }),
  ]);
  return el('div', { class: 'chart-empty' }, [glyph, message]);
}

/** 趋势图（js/charts.js:39-156）。挂到 container，返回 `<svg>`。 */
export function renderTrendChart(
  container: HTMLElement,
  points: readonly TrendPoint[],
  opts: TrendOpts = {},
): SVGSVGElement {
  const mode = MODES[opts.mode ?? 'win'] ?? MODES.win;
  const { W, H, L, R, T, B } = TREND_LAYOUT;
  const iw = W - L - R;
  const ih = H - T - B;

  clear(container);
  container.classList.add('trend-root');

  const svg = svgEl('svg', {
    viewBox: '0 0 ' + W + ' ' + H,
    class: 'trend-svg',
    role: 'img',
    'aria-label': mode.label + '趋势图，共 ' + points.length + ' 个决策',
    tabindex: '0',
  });
  container.appendChild(svg);

  const yOf = (v: number) => T + ih - ((v - mode.yMin) / (mode.yMax - mode.yMin)) * ih;
  const xOf = (i: number) => (points.length === 1 ? L + iw / 2 : L + (i / (points.length - 1)) * iw);

  /* 网格 + 刻度 */
  for (const t of mode.ticks) {
    const y = yOf(t);
    append(svg, svgEl('line', { x1: L, y1: y, x2: W - R, y2: y, class: t === mode.mid ? 'grid grid-mid' : 'grid' }));
    append(svg, svgEl('text', { x: L - 6, y: y + 3, class: 'tick-label', 'text-anchor': 'end', text: mode.fmt(t) }));
  }
  if (points.length) {
    const last = points[points.length - 1]!;
    append(svg, svgEl('text', { x: L, y: H - 6, class: 'tick-label', text: '第1手' }));
    append(svg, svgEl('text', { x: W - R, y: H - 6, class: 'tick-label', 'text-anchor': 'end', text: '第' + last.ply + '手' }));
  }

  if (!points.length) {
    container.appendChild(emptyChartNode('尚无 Jev 决策数据，开始对局后这里将实时绘制判断曲线。'));
    return svg;
  }

  const pts: [number, number][] = points.map((p, i) => [
    xOf(i),
    yOf(Math.min(mode.yMax, Math.max(mode.yMin, p.value))),
  ]);
  const line = smoothPath(pts);

  /* 中线以下 / 以上 分区面积（先手优=上） */
  const midY = yOf(mode.mid);
  const lastPt = pts[pts.length - 1]!;
  const firstPt = pts[0]!;
  const area = line + 'L' + lastPt[0].toFixed(1) + ' ' + midY + 'L' + firstPt[0].toFixed(1) + ' ' + midY + 'Z';
  const defs = svgEl('defs', {});
  append(defs, svgEl('clipPath', { id: 'clipUp' }, svgEl('rect', { x: 0, y: 0, width: W, height: Math.max(0, midY) })));
  append(defs, svgEl('clipPath', { id: 'clipDn' }, svgEl('rect', { x: 0, y: Math.max(0, midY), width: W, height: H - Math.max(0, midY) })));
  append(svg, defs);
  append(svg, svgEl('path', { d: area, fill: 'var(--mo)', opacity: 0.13, 'clip-path': 'url(#clipUp)' }));
  append(svg, svgEl('path', { d: area, fill: 'var(--zhu)', opacity: 0.12, 'clip-path': 'url(#clipDn)' }));
  append(svg, svgEl('path', { d: line, fill: 'none', class: 'trend-line', pathLength: '1' }));

  /* 悬停十字线（初始隐藏） */
  const cross = svgEl('g', { class: 'crosshair', visibility: 'hidden' });
  const crossLine = svgEl('line', { y1: T, y2: T + ih, class: 'cross-line' });
  const crossDot = svgEl('circle', { r: 3.5, class: 'cross-dot' });
  append(cross, [crossLine, crossDot]);
  append(svg, cross);

  /* 最新点：单发外扩的「落子」环 + 实点 */
  append(svg, svgEl('circle', { cx: lastPt[0], cy: lastPt[1], r: 7, class: 'land-ring' }));
  append(svg, svgEl('circle', { cx: lastPt[0], cy: lastPt[1], r: 3, class: 'dot-last' }));

  /* 交互：鼠标 + 键盘巡检 */
  let hoverIdx = -1;
  let tooltip = container.querySelector<HTMLElement>('.trend-tip');
  if (!tooltip) {
    tooltip = el('div', { class: 'trend-tip' });
    container.appendChild(tooltip);
  }
  const tip = tooltip;

  const showAt = (idx: number, clientX?: number): void => {
    hoverIdx = idx;
    const p = points[idx]!;
    cross.setAttribute('visibility', 'visible');
    const px = pts[idx]![0];
    const py = pts[idx]![1];
    crossLine.setAttribute('x1', String(px));
    crossLine.setAttribute('x2', String(px));
    crossDot.setAttribute('cx', String(px));
    crossDot.setAttribute('cy', String(py));
    tip.style.display = 'block';
    clear(tip);
    append(tip, [
      el('b', { text: '第' + p.ply + '手' }),
      ' ' + p.sideName + ' ' + p.notation,
      el('br'),
      mode.label + ' ',
      el('b', { class: 'mono', text: mode.fmt(p.value) }),
      p.detail ? [el('br'), el('span', { text: p.detail })] : null,
    ]);
    const rect = container.getBoundingClientRect();
    const left = Math.min(Math.max((clientX || (px / W) * rect.width) - rect.left - 55, 4), rect.width - 150);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(2, (py / H) * rect.height - 64) + 'px';
  };
  const hide = (): void => {
    hoverIdx = -1;
    cross.setAttribute('visibility', 'hidden');
    tip.style.display = 'none';
  };

  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let idx = points.length === 1 ? 0 : Math.round(((mx - L) / iw) * (points.length - 1));
    idx = Math.max(0, Math.min(points.length - 1, idx));
    showAt(idx, e.clientX);
  });
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    if (hoverIdx < 0) hoverIdx = points.length - 1;
    else hoverIdx = Math.max(0, Math.min(points.length - 1, hoverIdx + (e.key === 'ArrowRight' ? 1 : -1)));
    showAt(hoverIdx);
  });
  svg.addEventListener('blur', hide);
  return svg;
}

/** 可靠性图（js/charts.js:161-202）：返回**游离** `<svg>`，由调用方自行插入。 */
export function renderCalibrationChart(
  data: readonly CalibrationPoint[],
  opts: CalibrationOpts = {},
): SVGSVGElement {
  const { W, H, L, R, T, B } = REL_LAYOUT;
  const iw = W - L - R;
  const ih = H - T - B;
  const maxN = Math.max(1, ...data.map((b) => b.n));
  const withSamples = data.filter((b) => b.n).length;

  const svg = svgEl('svg', {
    viewBox: '0 0 ' + W + ' ' + H,
    class: 'rel-svg',
    role: 'img',
    'aria-label': '可靠性图：横轴为 Jev 预测胜率，纵轴为实际兑现率，' + withSamples + ' 个有样本的分箱',
  });
  const xOf = (v: number) => L + v * iw;
  const yOf = (v: number) => T + ih - v * ih;

  /* 网格 + 刻度 */
  for (const t of [0, 0.5, 1]) {
    append(svg, svgEl('line', { x1: L, y1: yOf(t), x2: W - R, y2: yOf(t), class: t === 0.5 ? 'grid grid-mid' : 'grid' }));
    append(svg, svgEl('text', {
      x: L - 5, y: yOf(t) + 3, class: 'tick-label', 'text-anchor': 'end',
      text: Math.round(t * 100) + '%',
    }));
    append(svg, svgEl('text', {
      x: xOf(t), y: H - 8, class: 'tick-label', 'text-anchor': 'middle',
      text: Math.round(t * 100) + '%',
    }));
  }
  /* 完美校准参考线 */
  append(svg, svgEl('line', { x1: xOf(0), y1: yOf(0), x2: xOf(1), y2: yOf(1), class: 'rel-diag', pathLength: '1' }));
  append(svg, svgEl('text', {
    x: W - R, y: yOf(1) - 4, class: 'tick-label rel-diag-label', 'text-anchor': 'end',
    text: '完美校准',
  }));

  /* 每箱：竖线（对角线 → 落点），长度＝校准偏差；底色随样本量加深 */
  for (const b of data) {
    if (!b.n) continue;
    const cx = xOf(b.conf);
    const cy = yOf(b.acc);
    const d = yOf(b.conf);
    const alpha = 0.14 + 0.5 * (b.n / maxN);
    append(svg, svgEl('line', { x1: cx, y1: d, x2: cx, y2: cy, class: 'rel-gap', 'stroke-opacity': alpha.toFixed(2) }));
    const dot = svgEl('circle', { cx: cx, cy: cy, r: 3.2, class: 'rel-dot' });
    append(dot, svgEl('title', {
      text: '预测 ' + Math.round(b.conf * 100) + '% → 实测 ' + Math.round(b.acc * 100) + '%（' + b.n + ' 个样本）',
    }));
    append(svg, dot);
  }
  append(svg, svgEl('text', {
    x: L, y: H - 8, class: 'tick-label rel-axis',
    text: opts.axisLabel ?? 'Jev 说的胜率',
  }));
  return svg;
}

/** 旧 `reliability(container, bins)` 的容器版：清空容器 + `rel-root` 类 + 挂图。 */
export function renderCalibrationChartInto(
  container: HTMLElement,
  data: readonly CalibrationPoint[],
  opts: CalibrationOpts = {},
): SVGSVGElement {
  clear(container);
  container.classList.add('rel-root');
  const svg = renderCalibrationChart(data, opts);
  container.appendChild(svg);
  return svg;
}

/** 置信度仪表（js/charts.js:205-224）。`animate=false` 直接呈现（历史卡片不重播动画）。 */
export function renderConfidenceGauge(p: number, size = 46, animate = true): SVGSVGElement {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, p));
  const svg = svgEl('svg', {
    viewBox: '0 0 ' + size + ' ' + size,
    class: 'gauge',
    'aria-label': '置信度 ' + Math.round(p * 100) + '%',
  });
  append(svg, svgEl('circle', { cx: size / 2, cy: size / 2, r: r, class: 'gauge-track' }));
  const arc = svgEl('circle', {
    cx: size / 2, cy: size / 2, r: r, class: 'gauge-arc',
    'stroke-dasharray': c.toFixed(1),
    'stroke-dashoffset': (animate === false ? c * (1 - clamped) : c).toFixed(1),
    transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
  });
  append(svg, arc);
  if (animate !== false) {
    raf(() => {
      arc.style.strokeDashoffset = (c * (1 - clamped)).toFixed(1);
    });
  }
  append(svg, svgEl('text', {
    x: size / 2, y: size / 2 + 3.5, class: 'gauge-num', 'text-anchor': 'middle',
    text: String(Math.round(p * 100)),
  }));
  return svg;
}

/** 概率条（js/charts.js:227-245）：返回 DocumentFragment（每行 `.bar-row[.is-chosen]`）。 */
export function renderProbabilityBars(
  top: readonly { notation: string; p: number }[] | null | undefined,
  chosen?: string | null,
  animate = true,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const t of top || []) {
    const s = (Math.max(2, Math.round(t.p * 100)) / 100).toFixed(3);
    const bar = el('i', { style: { transform: 'scaleX(' + (animate === false ? s : 0) + ')' } });
    const row = el('div', { class: 'bar-row' + (t.notation === chosen ? ' is-chosen' : '') }, [
      el('span', { class: 'k mono', text: t.notation }),
      el('span', { class: 'bar' }, bar),
      el('span', { class: 'p mono', text: (t.p * 100).toFixed(1) + '%' }),
    ]);
    if (animate !== false) {
      raf(() => {
        bar.style.transform = 'scaleX(' + s + ')';
      });
    }
    frag.appendChild(row);
  }
  return frag;
}
