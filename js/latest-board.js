/* 最新决策候选榜：固定槽位渲染（视图模型，纯函数零依赖）
 * 病灶：原实现结构随每步数据变化（候选 1~8 行、指标 0~3 块、「其余候选」
 * 行时有时无、无决策时整句空话）→ 面板高度每步跳动（「最新决策忽大忽小」）。
 * 契约：结构恒定——head 恒 1 行 + 指标恒 3 槽 + 候选恒 SLOTS 槽
 *      + rest 行恒在（无内容用 visibility:hidden 保高度）+ 无决策走同一骨架。
 * 惰性求值友好：只做字符串拼装，不碰 DOM/localStorage。
 */
(function () {
  const BG = (typeof window !== 'undefined' && window.BG) || globalThis.BG;
  if (!BG) throw new Error('latest-board.js 必须在 board.js 之后加载');

  const SLOTS = 8; /* 候选榜固定槽位数（= 原实现最多展示的行数） */

  function pct(x, digits) { return (x * 100).toFixed(digits === undefined ? 1 : digits) + '%'; }

  /* h = 历史项 { move, ply, meta }；null = 尚无决策 */
  function boardHTML(h) {
    const m = (h && h.meta) || {};
    const empty = !h;

    /* 标题行：手数 · 方 · 模型（恒 1 行，长模型名由 CSS 省略号截断） */
    const note = empty ? '尚无决策'
      : '第' + h.ply + '手 · ' + (m.sideName || '') + (m.mock ? ' · 演示' : ' · Jev' + (m.model ? ' ' + m.model : ''));

    /* 指标行：恒 3 槽，缺指标给空槽（–） */
    const big = function (k, v) {
      return v === undefined || v === null || v === ''
        ? '<div class="big is-empty"><span class="k">' + k + '</span><b class="mono">–</b></div>'
        : '<div class="big"><span class="k">' + k + '</span><b class="mono">' + v + '</b></div>';
    };
    const bigs = '<div class="latest-bigs">' +
      big((m.sideName || '') + '优势', typeof m.noul === 'number' ? pct(m.noul, 0) : '') +
      big('局势分', typeof m.score === 'number' ? m.score.toFixed(1) : '') +
      big('延迟', m.latencyMs ? m.latencyMs + 'ms' : '') +
      '</div>';

    /* 候选行：恒 SLOTS 槽，缺候选给空槽（弱化虚线） */
    const top = Array.isArray(m.top) ? m.top : [];
    let rows = '';
    for (let i = 0; i < SLOTS; i++) {
      const t = top[i];
      if (!t) {
        rows += '<div class="rank-row is-empty">' +
          '<span class="no mono">' + (i + 1) + '</span>' +
          '<span class="k mono">–</span><span class="bar"><i></i></span>' +
          '<span class="p mono">–</span></div>';
        continue;
      }
      rows += '<div class="rank-row' + (t.notation === h.move.notation ? ' is-chosen' : '') + '">' +
        '<span class="no mono">' + (i + 1) + '</span>' +
        '<span class="k mono">' + t.notation + '</span>' +
        '<span class="bar"><i style="transform:scaleX(' + (Math.max(2, Math.round((t.p || 0) * 100)) / 100).toFixed(3) + ')"></i></span>' +
        '<span class="p mono">' + pct(t.p || 0) + '</span></div>';
    }

    /* rest 行：恒在；无内容时隐藏文字但保留高度（visibility，不塌陷） */
    const hasRest = !empty && m.candidates > SLOTS;
    const rest = hasRest
      ? '<div class="rank-rest">其余 ' + (m.candidates - SLOTS) + ' 个候选合计 ' + pct(m.restProb || 0) + '</div>'
      : '<div class="rank-rest is-empty">&nbsp;</div>';

    const head = empty
      ? '<div class="latest-head"><span class="mv mono">–</span>' +
        '<span class="conf"><i></i></span><span class="conf-num mono">–</span></div>'
      : '<div class="latest-head"><span class="mv mono">' + h.move.notation + '</span>' +
        '<span class="conf"><i style="transform:scaleX(' +
        (typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)).toFixed(3) : 0) + ')"></i></span>' +
        '<span class="conf-num mono">' + (typeof m.confidence === 'number' ? pct(m.confidence, 0) : '–') + '</span></div>';

    /* 计数徽标：候选数（无数据时给空串，徽标本身不占高度） */
    const count = empty ? '' : (m.candidates ? m.candidates + ' 个候选' : '');
    return { note: note, count: count, html: head + bigs + '<div class="rank-list">' + rows + rest + '</div>' };
  }

  const api = {
    SLOTS: SLOTS,
    boardHTML: function (h) { return boardHTML(h); },
    selfTest: function () {
      const r = boardHTML(null);
      if ((r.html.match(/rank-row/g) || []).length !== SLOTS) throw new Error('latest-board: 空骨架候选槽 != ' + SLOTS);
      if ((r.html.match(/class="big[" ]/g) || []).length !== 3) throw new Error('latest-board: 空骨架指标槽 != 3');
      if (r.html.indexOf('rank-rest is-empty') < 0) throw new Error('latest-board: 空骨架缺 rest 行');
    },
  };
  BG.latest = api;
})();
