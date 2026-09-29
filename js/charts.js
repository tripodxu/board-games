'use strict';
/* charts.js — 零依赖 SVG 数据可视化
 *  - renderTrend : 胜率 / 局势分 / 置信度 随手数变化的趋势图（面积填充 + 悬停十字线 + 键盘巡检）
 *  - gauge       : 置信度环形仪表
 * 遵循：<1000 点用 SVG；当前值始终可见；不以颜色为唯一信息通道；reduced-motion 降级。 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  const MODES = {
    win:   { label: '胜率',   yMin: 0, yMax: 1,   ticks: [0, .25, .5, .75, 1],  fmt: v => (v * 100).toFixed(0) + '%', mid: .5 },
    score: { label: '局势分', yMin: 0, yMax: 10,  ticks: [0, 2.5, 5, 7.5, 10],  fmt: v => v.toFixed(1),              mid: 5 },
    conf:  { label: '置信度', yMin: 0, yMax: 1,   ticks: [0, .25, .5, .75, 1],  fmt: v => (v * 100).toFixed(0) + '%', mid: .5 },
  };

  /* Catmull-Rom → 贝塞尔，让折线带一点克制的圆滑 */
  function smoothPath(pts) {
    if (pts.length < 3) return pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
    let d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += 'C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return d;
  }

  const Charts = {
    MODES,

    /* points: [{ply, notation, sideName, value, detail}] —— value 已归一到 yMin..yMax
     * opts: {mode, firstName, secondName, unit} */
    renderTrend(container, points, opts) {
      const mode = MODES[opts.mode] || MODES.win;
      const W = 470, H = 196, L = 38, R = 14, T = 12, B = 24;
      const iw = W - L - R, ih = H - T - B;
      container.innerHTML = '';
      container.classList.add('trend-root');

      const svg = el('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'trend-svg', role: 'img',
        'aria-label': mode.label + '趋势图，共 ' + points.length + ' 个决策',
        tabindex: '0',
      }, container);

      const yOf = v => T + ih - ((v - mode.yMin) / (mode.yMax - mode.yMin)) * ih;
      const xOf = i => points.length === 1 ? L + iw / 2 : L + (i / (points.length - 1)) * iw;

      /* 网格 + 刻度 */
      for (const t of mode.ticks) {
        const y = yOf(t);
        el('line', { x1: L, y1: y, x2: W - R, y2: y, class: t === mode.mid ? 'grid grid-mid' : 'grid' }, svg);
        el('text', { x: L - 6, y: y + 3, class: 'tick-label', 'text-anchor': 'end' }, svg)
          .textContent = mode.fmt(t);
      }
      if (points.length) {
        el('text', { x: L, y: H - 6, class: 'tick-label' }, svg).textContent = '第1手';
        el('text', { x: W - R, y: H - 6, class: 'tick-label', 'text-anchor': 'end' }, svg)
          .textContent = '第' + points[points.length - 1].ply + '手';
      }

      if (!points.length) {
        const empty = document.createElement('div');
        empty.className = 'chart-empty';
        /* 自绘 SVG，不用 Unicode 字形顶替图标系统（craft-floor 拒绝项）：
         * 直接画出「本该出现的走势」——坐标轴 + 一条虚线。 */
        empty.innerHTML =
          '<svg class="glyph" width="76" height="42" viewBox="0 0 76 42" aria-hidden="true" fill="none">' +
          '<line x1="7" y1="6" x2="7" y2="35" stroke="currentColor" stroke-width="1"/>' +
          '<line x1="7" y1="35" x2="69" y2="35" stroke="currentColor" stroke-width="1"/>' +
          '<path class="g-dash" d="M12 30 L26 21 L38 25 L52 13 L64 17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          '</svg>' +
          '尚无 Jev 决策数据，开始对局后这里将实时绘制判断曲线。';
        container.appendChild(empty);
        return svg;
      }

      const pts = points.map((p, i) => [xOf(i), yOf(Math.min(mode.yMax, Math.max(mode.yMin, p.value)))]);
      const line = smoothPath(pts);

      /* 中线以下 / 以上 分区面积（先手优=上） */
      const midY = yOf(mode.mid);
      const area = line + 'L' + pts[pts.length - 1][0].toFixed(1) + ' ' + midY + 'L' + pts[0][0].toFixed(1) + ' ' + midY + 'Z';
      const defs = el('defs', {}, svg);
      const clipUp = el('clipPath', { id: 'clipUp' }, defs);
      el('rect', { x: 0, y: 0, width: W, height: Math.max(0, midY) }, clipUp);
      const clipDn = el('clipPath', { id: 'clipDn' }, defs);
      el('rect', { x: 0, y: Math.max(0, midY), width: W, height: H - Math.max(0, midY) }, clipDn);
      el('path', { d: area, fill: 'var(--mo)', opacity: .13, 'clip-path': 'url(#clipUp)' }, svg);
      el('path', { d: area, fill: 'var(--zhu)', opacity: .12, 'clip-path': 'url(#clipDn)' }, svg);
      el('path', { d: line, fill: 'none', class: 'trend-line', pathLength: '1' }, svg);

      /* 悬停十字线（初始隐藏） */
      const cross = el('g', { class: 'crosshair', visibility: 'hidden' }, svg);
      const crossLine = el('line', { y1: T, y2: T + ih, class: 'cross-line' }, cross);
      const crossDot = el('circle', { r: 3.5, class: 'cross-dot' }, cross);

      /* 最新点：单发外扩的「落子」环 + 实点（不是无限循环的装饰） */
      const last = pts[pts.length - 1];
      el('circle', { cx: last[0], cy: last[1], r: 7, class: 'land-ring' }, svg);
      el('circle', { cx: last[0], cy: last[1], r: 3, class: 'dot-last' }, svg);

      /* 交互：鼠标 + 键盘巡检 */
      let hoverIdx = -1;
      const tooltip = container.querySelector('.trend-tip') || (() => {
        const t = document.createElement('div');
        t.className = 'trend-tip';
        container.appendChild(t);
        return t;
      })();
      const showAt = (idx, clientX) => {
        hoverIdx = idx;
        const p = points[idx];
        cross.setAttribute('visibility', 'visible');
        const px = pts[idx][0], py = pts[idx][1];
        crossLine.setAttribute('x1', px); crossLine.setAttribute('x2', px);
        crossDot.setAttribute('cx', px); crossDot.setAttribute('cy', py);
        tooltip.style.display = 'block';
        tooltip.innerHTML =
          '<b>第' + p.ply + '手</b> ' + p.sideName + ' ' + p.notation +
          '<br>' + mode.label + ' <b class="mono">' + mode.fmt(p.value) + '</b>' +
          (p.detail ? '<br><span>' + p.detail + '</span>' : '');
        const rect = container.getBoundingClientRect();
        const left = Math.min(Math.max((clientX || px / W * rect.width) - rect.left - 55, 4), rect.width - 150);
        tooltip.style.left = left + 'px';
        tooltip.style.top = Math.max(2, py / H * rect.height - 64) + 'px';
      };
      const hide = () => {
        hoverIdx = -1;
        cross.setAttribute('visibility', 'hidden');
        tooltip.style.display = 'none';
      };
      svg.addEventListener('mousemove', (e) => {
        const rect = svg.getBoundingClientRect();
        const mx = (e.clientX - rect.left) / rect.width * W;
        let idx = points.length === 1 ? 0 : Math.round((mx - L) / iw * (points.length - 1));
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
    },

    /* 可靠性图：横轴「Jev 说」纵轴「实际兑现」，点落在对角线上＝校准良好。
     * 每箱画一条从对角线到落点的竖线，线长即该箱的校准偏差；竖线底色按样本量深浅，
     * 于是「预测分布（锐度）」与「校准偏差」可以一眼同时读到。 */
    reliability(container, bins, opts) {
      opts = opts || {};
      const W = 300, H = 168, L = 36, R = 10, T = 10, B = 26;
      const iw = W - L - R, ih = H - T - B;
      const nBins = bins.length;
      const maxN = Math.max(1, ...bins.map((b) => b.n));
      container.innerHTML = '';
      container.classList.add('rel-root');
      const svg = el('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'rel-svg', role: 'img',
        'aria-label': '可靠性图：横轴为 Jev 预测胜率，纵轴为实际兑现率，' +
          bins.filter((b) => b.n).length + ' 个有样本的分箱',
      }, container);
      const xOf = (v) => L + v * iw;
      const yOf = (v) => T + ih - v * ih;

      /* 网格 + 刻度 */
      for (const t of [0, 0.5, 1]) {
        el('line', { x1: L, y1: yOf(t), x2: W - R, y2: yOf(t), class: t === 0.5 ? 'grid grid-mid' : 'grid' }, svg);
        el('text', { x: L - 5, y: yOf(t) + 3, class: 'tick-label', 'text-anchor': 'end' }, svg)
          .textContent = Math.round(t * 100) + '%';
        el('text', { x: xOf(t), y: H - 8, class: 'tick-label', 'text-anchor': 'middle' }, svg)
          .textContent = Math.round(t * 100) + '%';
      }
      /* 完美校准参考线 */
      el('line', { x1: xOf(0), y1: yOf(0), x2: xOf(1), y2: yOf(1), class: 'rel-diag', pathLength: '1' }, svg);
      el('text', { x: W - R, y: yOf(1) - 4, class: 'tick-label rel-diag-label', 'text-anchor': 'end' }, svg)
        .textContent = '完美校准';

      /* 每箱：竖线（对角线 → 落点），长度＝校准偏差；底色随样本量加深 */
      bins.forEach((b) => {
        if (!b.n) return;
        const cx = xOf(b.conf), cy = yOf(b.acc), d = yOf(b.conf);
        const alpha = 0.14 + 0.5 * (b.n / maxN);
        el('line', { x1: cx, y1: d, x2: cx, y2: cy, class: 'rel-gap', 'stroke-opacity': alpha.toFixed(2) }, svg);
        el('circle', { cx: cx, cy: cy, r: 3.2, class: 'rel-dot' }, svg)
          .appendChild(el('title', {})).textContent =
            '预测 ' + Math.round(b.conf * 100) + '% → 实测 ' + Math.round(b.acc * 100) + '%（' + b.n + ' 个样本）';
      });
      el('text', { x: L, y: H - 8, class: 'tick-label rel-axis' }, svg).textContent = 'Jev 说的胜率';
      return svg;
    },

    /* 置信度仪表：animate=false 时直接呈现（历史卡片不重复播动画） */
    gauge(p, size, animate) {
      size = size || 46;
      const r = size / 2 - 4, c = 2 * Math.PI * r;
      const svg = el('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'gauge', 'aria-label': '置信度 ' + Math.round(p * 100) + '%' });
      el('circle', { cx: size / 2, cy: size / 2, r: r, class: 'gauge-track' }, svg);
      const arc = el('circle', {
        cx: size / 2, cy: size / 2, r: r, class: 'gauge-arc',
        'stroke-dasharray': c.toFixed(1),
        'stroke-dashoffset': (animate === false ? c * (1 - Math.min(1, Math.max(0, p))) : c).toFixed(1),
        transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
      }, svg);
      if (animate !== false) {
        requestAnimationFrame(() => {
          arc.style.strokeDashoffset = (c * (1 - Math.min(1, Math.max(0, p)))).toFixed(1);
        });
      }
      const t = el('text', { x: size / 2, y: size / 2 + 3.5, class: 'gauge-num', 'text-anchor': 'middle' }, svg);
      t.textContent = Math.round(p * 100);
      return svg;
    },

    /* 概率条（top-K 候选）：animate=false 直接呈现终值 */
    bars(top, chosen, animate) {
      const frag = document.createDocumentFragment();
      (top || []).forEach((t) => {
        const s = (Math.max(2, Math.round(t.p * 100)) / 100).toFixed(3);
        const row = document.createElement('div');
        row.className = 'bar-row' + (t.notation === chosen ? ' is-chosen' : '');
        row.innerHTML =
          '<span class="k mono">' + t.notation + '</span>' +
          '<span class="bar"><i style="transform:scaleX(' + (animate === false ? s : 0) + ')"></i></span>' +
          '<span class="p mono">' + (t.p * 100).toFixed(1) + '%</span></div>';
        if (animate !== false) {
          requestAnimationFrame(() => {
            row.querySelector('i').style.transform = 'scaleX(' + s + ')';
          });
        }
        frag.appendChild(row);
      });
      return frag;
    },
  };

  BG.charts = Charts;
})();
