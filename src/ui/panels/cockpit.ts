/* panels/cockpit.ts — 驾驶舱 / 趋势 / 决策流 / 棋谱（迁移自 js/app.js:1400-1541、1731-1800、405-425）
 *
 * 覆盖的旧函数与行号：
 *   buildSeries()          js/app.js:1400-1430  → trendSeries()
 *   renderAnalytics()      js/app.js:1432-1459  → renderTrendPanel() / renderEvalBar() / renderCostChip()
 *   renderCockpit()        js/app.js:1462-1488  → renderCockpit() / cockpitMetrics()
 *   renderSpark()          js/app.js:1490-1510  → renderSpark()
 *   renderDuel()           js/app.js:1512-1533  → renderDuelPanel()
 *   renderLatest()         js/app.js:1535-1541  → renderLatestPanel()
 *   setEngineStatus()      js/app.js:594-600    → renderEngineLight()
 *   updateTurnBadge()      js/app.js:405-425    → renderTurnBadge() / turnBadgeText()
 *   sideName/sideLabelText/renderSideNames() js/app.js:336-365 → sideNameOf()/sideLabelTextOf()/renderDuelNames()
 *   renderFeed/feedCard/prependFeed   js/app.js:1731-1783 → renderFeed()/feedCard()/prependFeed()
 *   appendLedgerLine/rebuildLedger    js/app.js:1785-1800 → appendLedgerLine()/rebuildLedger()
 *
 * 风格（与 settings.ts/side-config.ts 一致）：**重建子树 + 静态节点 onOnce**。
 *   - 动态内容（#feed 卡片、#latSpark 柱、#trend svg、#latest）用 `replaceChildren` 整段重建，
 *     每次都是新节点，事件用 `on()` 绑在卡上（不会叠加）。
 *   - 静态节点（#turnBadge、#emXxx、#evalFill、#chipWin…）就地改文本/class/style，事件用 `onOnce()`
 *     只绑一次；重复调用 render* 是幂等的。
 *
 * 数据来源：全部经 props 注入（`moves`/`sides`/`mode`/`humanSide`/`effBySide`），本模块
 * 不 import `src/core/session.ts` 的实例对象、不碰 localStorage / fetch —— 装配阶段由
 * `src/app/**` 把 `GameSession` 切成 props 传进来（对应关系见 src/ui/README.md）。
 *
 * 刻意差异：
 *  1. 旧 `renderLatest` 写 `#latest.innerHTML = v.html`：`boardHTML()`（core/view/board.ts）本身
 *     产出 HTML 串，这里保留同一口径（唯一一处 innerHTML）。
 *  2. 旧 `renderAnalytics` 每次调 `BG.charts.renderTrend()`；本实现调 `renderTrendChart()`，
 *     由它自己 clear 容器（旧实现也是整段重建），行为一致。
 *  3. `renderDuelPanel` 按 `props.sides[i]` 定位双方，而不再依赖 `engine.sides`（旧 `sideIdOf()`）。
 *  4. `appendLedgerLine` 额外识别 `.ledger-empty`（旧实现只查 `.feed-empty`，是旧代码的笔误）。
 */
import type { EffSide } from '../../core/persist.ts';
import type { SessionMeta, SessionMove, SessionMode, TrendMode } from '../../core/session.ts';
import { boardHTML } from '../../core/view/board.ts';
import type { LatestItem } from '../../core/view/board.ts';
import { sideLabel } from '../../core/view/duel.ts';
import { renderConfidenceGauge, renderProbabilityBars, renderTrendChart } from '../charts.ts';
import type { TrendPoint } from '../charts.ts';
import {
  append,
  clear,
  el,
  fmtCost,
  fmtTokens,
  onOnce,
  qs,
  qsa,
  replaceChildren,
  setText,
  toggleClass,
  type UiRoot,
} from '../dom.ts';

/** 一个棋种的两方（`engine.sides` 的最小投影）。 */
export interface SideInfo {
  id: string;
  name: string;
}

/** 驾驶舱/趋势/决策流共用的 props（全部可 JSON 克隆，无实例句柄）。 */
export interface CockpitProps {
  /** `session.history` */
  moves: readonly SessionMove[];
  /** `engine.sides` */
  sides: readonly SideInfo[];
  /** `session.mode` */
  mode: SessionMode;
  /** `session.humanSide` */
  humanSide: string | null;
  /** `session.trendMode` */
  trendMode: TrendMode;
  /** `st.turn`（未开局传 null/undefined） */
  turn?: string | null;
  /** `engine.getStatus(st).over` */
  over?: boolean;
  /** 旧 `S.inflight != null`（有 AI 请求在飞） */
  busy?: boolean;
  /** 每方生效配置（旧 `effSide(sideIdOf(side))`，`src/core/persist.ts` 的 `effSide()` 产物） */
  effBySide?: Readonly<Record<string, EffSide | null | undefined>>;
}

/** 引擎状态灯的三种状态（旧 `setEngineStatus(state)` 的取值）。 */
export type EngineLightState = 'idle' | 'running' | 'thinking';

/** 决策流最多保留的卡片数（旧 `FEED_MAX`，js/app.js:1760 一带）。 */
export const FEED_MAX = 40;

/** 战术保险标记 → 卡片文案（js/app.js:1750-1757 逐字）。 */
const TACTIC_TAGS: Record<string, string> = {
  win: '保险·致胜',
  block: '保险·拦截',
  open4: '保险·活四',
  threat: '保险·造杀',
  parry: '保险·拆杀',
  parry3: '保险·预挡',
};

function scopeOf(root?: UiRoot | null): UiRoot {
  return root ?? document;
}

function metaOf(h: SessionMove): SessionMeta {
  return h.meta ?? {};
}

/** AI 手（旧 `S.history.filter(h => h.meta && h.meta.byAI)`）。 */
export function aiItems(moves: readonly SessionMove[]): SessionMove[] {
  return moves.filter((h) => !!(h.meta && h.meta.byAI));
}

/* ---------- 双方身份 / 状态灯 / 回合徽标 ---------- */

/** 旧 `sideName(id)`（js/app.js:336-339）。 */
export function sideNameOf(sides: readonly SideInfo[], id: string | null | undefined): string {
  const s = sides.find((x) => x.id === id);
  return s ? s.name : (id ?? '');
}

/** 旧 `sideLabelText(sideId)`（js/app.js:344-348）。 */
export function sideLabelTextOf(props: CockpitProps, sideId: string): string {
  if (props.mode === 'pvp') return '玩家';
  if (props.mode === 'human-ai' && sideId === props.humanSide) return '我';
  return sideLabel(props.effBySide?.[sideId] ?? null);
}

/** 旧 `isAISide(side)`（js/app.js:421-425）。 */
export function isAISideOf(props: CockpitProps, sideId: string | null | undefined): boolean {
  if (props.mode === 'ai-ai') return true;
  if (props.mode === 'pvp') return false;
  return sideId !== props.humanSide;
}

/** 旧 `updateTurnBadge()` 的文案拼接（js/app.js:413-417），未开局返回空串。 */
export function turnBadgeText(props: CockpitProps): string {
  if (props.over) return '对局结束';
  if (!props.turn) return '';
  const turn = props.turn;
  const isAI = isAISideOf(props, turn);
  const who = isAI
    ? sideNameOf(props.sides, turn) + ' ' + sideLabel(props.effBySide?.[turn] ?? null)
    : sideNameOf(props.sides, turn);
  return who + (isAI ? (props.busy ? ' · 思考中' : ' · 等待中') : ' · 请落子');
}

/** 写 `#turnBadge`（终局去掉 `thinking`；未开局不动）。 */
export function renderTurnBadge(props: CockpitProps, root?: UiRoot | null): void {
  if (!props.over && !props.turn) return;
  const badge = qs<HTMLElement>(scopeOf(root), '#turnBadge');
  if (!badge) return;
  badge.textContent = turnBadgeText(props);
  const thinking = !props.over && isAISideOf(props, props.turn) && !!props.busy;
  toggleClass(badge, 'thinking', thinking);
}

/** 写 `#duelFirstName` / `#duelSecondName`（旧 `renderSideNames()`，js/app.js:360-367）。 */
export function renderDuelNames(props: CockpitProps, root?: UiRoot | null): void {
  const r = scopeOf(root);
  const ids = ['#duelFirstName', '#duelSecondName'];
  props.sides.slice(0, 2).forEach((sd, i) => {
    setText(qs(r, ids[i]), sd.name + ' ' + sideLabelTextOf(props, sd.id));
  });
}

/** 旧 `setEngineStatus(state, label)`（js/app.js:594-600）：`<i></i>` + 文案。 */
export function renderEngineLight(state: EngineLightState, label?: string, root?: UiRoot | null): void {
  const node = qs<HTMLElement>(scopeOf(root), '#engineStatus');
  if (!node) return;
  node.className = 'status-light ' + state;
  replaceChildren(node, [el('i'), label || '待命']);
}

/* ---------- 引擎指标 + 延迟柱 ---------- */

export interface CockpitMetrics {
  cost: number;
  tokens: number;
  moves: number;
  /** 最快一手（四舍五入后的 ms） */
  fast: number | null;
  /** 最慢一手 */
  slow: number | null;
  /** 最近一次带 model 的手的模型名 */
  model: string | null;
}

/** 旧 `renderCockpit()` 的聚合段（js/app.js:1467-1477）。 */
export function cockpitMetrics(items: readonly SessionMove[]): CockpitMetrics {
  let cost = 0;
  let tokens = 0;
  let fast: number | null = null;
  let slow: number | null = null;
  let model: string | null = null;
  for (const h of items) {
    const m = metaOf(h);
    cost += m.costUsd || 0;
    tokens += (m.usage && m.usage.input_tokens) || 0;
    if (m.latencyMs) {
      const v = Math.round(m.latencyMs);
      fast = fast == null ? v : Math.min(fast, v);
      slow = slow == null ? v : Math.max(slow, v);
    }
    if (typeof m.model === 'string' && m.model) model = m.model;
  }
  return { cost, tokens, moves: items.length, fast, slow, model };
}

/** 旧 `renderSpark(lats)`（js/app.js:1490-1510）：每手一根 `<i>`，`scaleY` 归一。 */
export function renderSpark(lats: readonly number[], root?: UiRoot | null): void {
  const r = scopeOf(root);
  const box = qs<HTMLElement>(r, '#latSpark');
  if (!box) return;
  if (!lats.length) {
    replaceChildren(box, el('div', { class: 'spark-empty', text: '尚无延迟数据' }));
    setText(qs(r, '#sparkNow'), '–');
    return;
  }
  const max = Math.max(...lats, 1);
  replaceChildren(
    box,
    lats.map((ms) => {
      const bar = el('i', { title: ms + 'ms' });
      bar.style.transform = 'scaleY(' + (Math.max(6, Math.round((ms / max) * 100)) / 100).toFixed(3) + ')';
      if (ms > 5000) bar.className = 'slow';
      return bar;
    }),
  );
  setText(qs(r, '#sparkNow'), Math.round(lats[lats.length - 1]) + 'ms');
}

/** 旧 `renderDuel(items, firstId)`（js/app.js:1512-1533）：两侧各 4 行。 */
export function renderDuelPanel(props: CockpitProps, root?: UiRoot | null): void {
  const r = scopeOf(root);
  const items = aiItems(props.moves);
  ['#duelFirst', '#duelSecond'].forEach((sel, i) => {
    const col = qs<HTMLElement>(r, sel);
    if (!col) return;
    const rows = qsa<HTMLElement>(col, '.duel-row b');
    if (!rows.length) return;
    const sideId = props.sides[i]?.id ?? (i === 0 ? 'black' : 'white');
    const mine = items.filter((h) => (metaOf(h).side ?? h.side) === sideId);
    if (!mine.length) {
      rows.forEach((b) => {
        b.textContent = '–';
      });
      setText(rows[2], '0');
      setText(rows[3], '$0');
      return;
    }
    const confs = mine.map((h) => metaOf(h).confidence).filter((v): v is number => typeof v === 'number');
    setText(rows[0], confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) + '%' : '–');
    const advs = mine
      .map((h) => metaOf(h).noul)
      .filter((v): v is number => typeof v === 'number')
      .map((v) => (i === 0 ? v : 1 - v));
    setText(rows[1], advs.length ? Math.round((advs.reduce((a, b) => a + b, 0) / advs.length) * 100) + '%' : '–');
    setText(rows[2], String(mine.length));
    setText(rows[3], fmtCost(mine.reduce((s, h) => s + (metaOf(h).costUsd || 0), 0)));
  });
}

/** 旧 `renderLatest(h)`（js/app.js:1535-1541）：`boardHTML()` 产出 note/count/html。 */
export function renderLatestPanel(item: LatestItem | null, root?: UiRoot | null): void {
  const r = scopeOf(root);
  const v = boardHTML(item);
  setText(qs(r, '#latestNote'), v.note);
  setText(qs(r, '#rankCount'), v.count);
  const box = qs<HTMLElement>(r, '#latest');
  if (box) box.innerHTML = v.html;
}

/* ---------- 趋势（局势曲线 + 局势条 + 芯片） ---------- */

/** 旧 `buildSeries()` 的一个点（js/app.js:1408-1429 的字段逐字）。 */
export interface TrendSeriesPoint {
  ply: number;
  notation: string;
  sideName: string;
  /** 先手视角胜率 0..1（null = 这一手没有 noul） */
  win: number | null;
  /** 先手视角局势分 0..10 */
  score: number | null;
  /** 置信度（confidence 缺失时退到 top[0].p） */
  conf: number | null;
  latencyMs: number;
  costUsd: number;
  mock: boolean;
  detail: string;
}

/** 旧 `buildSeries()`（js/app.js:1400-1430）：滤掉随机/无信号手，翻转到先手视角。 */
export function trendSeries(props: CockpitProps): TrendSeriesPoint[] {
  const firstSide = props.sides[0]?.id ?? null;
  const out: TrendSeriesPoint[] = [];
  for (const h of props.moves) {
    const m = h.meta;
    if (!m || !m.byAI || m.channel === 'random') continue;
    const topP = m.top && m.top.length && typeof m.top[0].p === 'number' ? m.top[0].p : null;
    const hasSignal =
      typeof m.noul === 'number' ||
      typeof m.score === 'number' ||
      typeof m.confidence === 'number' ||
      topP != null;
    if (!hasSignal) continue;
    const toFirst = (m.side ?? h.side) === firstSide;
    const flip = (v: number, hi: number) => (toFirst ? v : hi - v);
    const noul = typeof m.noul === 'number' ? m.noul : null;
    out.push({
      ply: h.ply,
      notation: h.move?.notation ?? '',
      sideName: m.sideName ?? '',
      win: noul == null ? null : flip(noul, 1),
      score: typeof m.score === 'number' ? flip(m.score, 10) : noul == null ? null : flip(noul * 10, 10),
      conf: typeof m.confidence === 'number' ? m.confidence : topP,
      latencyMs: m.latencyMs || 0,
      costUsd: m.costUsd || 0,
      mock: !!m.mock,
      detail:
        '置信度 ' +
        (typeof m.confidence === 'number' ? (m.confidence * 100).toFixed(0) + '%' : '–') +
        ' · ' +
        (m.latencyMs || 0) +
        'ms',
    });
  }
  return out;
}

/** 按纵轴口径取点（旧 `renderAnalytics` 里的 `series.filter(p => typeof p[mode] === 'number')`）。 */
export function trendPoints(series: readonly TrendSeriesPoint[], mode: TrendMode): TrendPoint[] {
  const pts: TrendPoint[] = [];
  for (const p of series) {
    const v = p[mode];
    if (typeof v !== 'number') continue;
    pts.push({ ply: p.ply, notation: p.notation, sideName: p.sideName, value: v, detail: p.detail });
  }
  return pts;
}

/** 三枚纵轴芯片（静态节点 id 与 index.html 一致）。 */
export const TREND_CHIPS: readonly { mode: TrendMode; id: string }[] = [
  { mode: 'win', id: 'chipWin' },
  { mode: 'score', id: 'chipScore' },
  { mode: 'conf', id: 'chipConf' },
];

/** 芯片 active 态（旧 `setTrendMode()` 里逐个 toggle）。 */
export function renderTrendChips(mode: TrendMode, root?: UiRoot | null): void {
  const r = scopeOf(root);
  for (const c of TREND_CHIPS) toggleClass(qs(r, '#' + c.id), 'active', c.mode === mode);
}

/** 芯片点击（静态节点，onOnce 只绑一次；由装配层把 trendMode 写回 session）。 */
export function bindTrendChips(fn: (mode: TrendMode) => void, root?: UiRoot | null): void {
  const r = scopeOf(root);
  for (const c of TREND_CHIPS) onOnce(qs(r, '#' + c.id), 'click', () => fn(c.mode));
}

/** 局势条（旧 `renderAnalytics` 的 `#evalFill` / `#evalBar` 段，js/app.js:1450-1457）。 */
export function renderEvalBar(pFirst: number, root?: UiRoot | null): void {
  const r = scopeOf(root);
  const fill = Math.min(96, Math.max(4, pFirst * 100)) / 100;
  const fillEl = qs<HTMLElement>(r, '#evalFill');
  if (fillEl) fillEl.style.transform = 'scaleY(' + fill.toFixed(3) + ')';
  const bar = qs(r, '#evalBar');
  if (bar) bar.setAttribute('aria-label', '实时局势：先手方胜率约 ' + Math.round(pFirst * 100) + '%');
}

/** 顶栏成本芯片（旧 `$('costChip').textContent = fmtCost(...)`）。 */
export function renderCostChip(cost: number, root?: UiRoot | null): void {
  setText(qs(scopeOf(root), '#costChip'), fmtCost(cost));
}

/** 旧 `renderAnalytics()`（js/app.js:1432-1459）：趋势图 + 备注 + 芯片 + 局势条 + 成本芯片。 */
export function renderTrendPanel(props: CockpitProps, root?: UiRoot | null): void {
  const r = scopeOf(root);
  const series = trendSeries(props);
  const points = trendPoints(series, props.trendMode);
  const trend = qs<HTMLElement>(r, '#trend');
  if (trend) {
    renderTrendChart(trend, points, {
      mode: props.trendMode,
      firstName: props.sides[0]?.name ?? '',
      secondName: props.sides[1]?.name ?? '',
    });
  }
  setText(qs(r, '#trendNote'), points.length ? points.length + ' 个决策 · 悬停或 ←/→ 巡检' : '悬停或用 ←/→ 巡检');
  renderTrendChips(props.trendMode, r);
  let pFirst = 0.5;
  for (let i = series.length - 1; i >= 0; i--) {
    const w = series[i].win;
    if (typeof w === 'number') {
      pFirst = w;
      break;
    }
  }
  renderEvalBar(pFirst, r);
  renderCostChip(
    aiItems(props.moves).reduce((s, h) => s + (metaOf(h).costUsd || 0), 0),
    r,
  );
}

/* ---------- 驾驶舱（引擎面板 + 对决 + 最新决策） ---------- */

/** 旧 `renderCockpit()`（js/app.js:1462-1488）。 */
export function renderCockpit(props: CockpitProps, root?: UiRoot | null): void {
  const r = scopeOf(root);
  const items = aiItems(props.moves);
  const mm = cockpitMetrics(items);
  setText(qs(r, '#emCost'), fmtCost(mm.cost));
  setText(qs(r, '#emTokens'), fmtTokens(mm.tokens));
  setText(qs(r, '#emMoves'), String(mm.moves));
  setText(qs(r, '#emFastest'), mm.fast == null || mm.slow == null ? '–' : mm.fast + ' / ' + mm.slow + 'ms');
  if (mm.model) setText(qs(r, '#engineModel'), mm.model);
  renderSpark(
    items.map((h) => metaOf(h).latencyMs || 0).filter((x) => x > 0).slice(-20),
    r,
  );
  renderDuelPanel(props, r);
  renderLatestPanel(items.length ? (items[items.length - 1] as unknown as LatestItem) : null, r);
}

/* ---------- 决策流 ---------- */

/** 单张决策卡（旧 `feedCard(h, animate)`，js/app.js:1746-1772）。 */
export function feedCard(h: SessionMove, animate: boolean): HTMLElement {
  const m = metaOf(h);
  const card = el('div', { class: 'decision' });
  const who = el('span', { class: 'who' });
  append(who, [
    '第' + h.ply + '手 · ',
    el('b', { text: m.sideName || '' }),
    m.mock ? ' · 演示' : ' · Jev',
    m.tactics && TACTIC_TAGS[m.tactics] ? ' · ' + TACTIC_TAGS[m.tactics] : '',
  ]);
  append(card, [who, el('span', { class: 'mv', text: h.move?.notation ?? '' })]);

  const barsWrap = el('div');
  barsWrap.style.gridColumn = '1 / 3';
  barsWrap.appendChild(renderProbabilityBars(m.top, h.move?.notation, animate));
  card.appendChild(barsWrap);

  if (typeof m.confidence === 'number') card.appendChild(renderConfidenceGauge(m.confidence, 46, animate));

  const extra: string[] = [];
  if (typeof m.noul === 'number') extra.push('优势 ' + (m.noul * 100).toFixed(0) + '%');
  if (typeof m.score === 'number') extra.push('局势 ' + m.score.toFixed(1));
  if (m.latencyMs) extra.push(m.latencyMs + 'ms');
  if (m.usage && m.usage.input_tokens) extra.push(m.usage.input_tokens + ' tok');
  if (m.costUsd) extra.push('$' + m.costUsd.toFixed(5));
  const meta = el('div', { class: 'meta' });
  extra.forEach((x, i) => {
    if (i) append(meta, ' · ');
    append(meta, el('b', { text: x }));
  });
  if (m.warning) append(meta, [' ', el('span', { class: 'warn', text: '⚠ ' + m.warning })]);
  card.appendChild(meta);
  return card;
}

/** 旧 `renderFeed()`（js/app.js:1731-1743）：最近 FEED_MAX 手，最新一张播动画。 */
export function renderFeed(props: CockpitProps, root?: UiRoot | null): void {
  const feed = qs<HTMLElement>(scopeOf(root), '#feed');
  if (!feed) return;
  const items = aiItems(props.moves);
  if (!items.length) {
    replaceChildren(feed, el('div', { class: 'feed-empty', text: '开始对局后，Jev 的每一步判断会流淌在这里。' }));
    return;
  }
  replaceChildren(
    feed,
    items
      .slice(-FEED_MAX)
      .reverse()
      .map((h, i) => feedCard(h, i === 0)),
  );
}

/** 旧 `prependFeed(h)`（js/app.js:1778-1783）：增量插到最前并裁到 FEED_MAX。 */
export function prependFeed(h: SessionMove, root?: UiRoot | null): void {
  const feed = qs<HTMLElement>(scopeOf(root), '#feed');
  if (!feed) return;
  if (feed.querySelector('.feed-empty')) clear(feed);
  feed.insertBefore(feedCard(h, true), feed.firstChild);
  while (feed.childElementCount > FEED_MAX && feed.lastElementChild) feed.removeChild(feed.lastElementChild);
}

/* ---------- 棋谱（逐手记法） ---------- */

/** 旧 `appendLedgerLine(h)`（js/app.js:1785-1793）。 */
export function appendLedgerLine(h: SessionMove, root?: UiRoot | null): void {
  const ledger = qs<HTMLElement>(scopeOf(root), '#ledger');
  if (!ledger) return;
  if (ledger.querySelector('.ledger-empty, .feed-empty')) clear(ledger);
  const m = metaOf(h);
  const label = m.byAI ? (m.mock ? '演示' : 'Jev') : '玩家';
  const row = el('div', null, [el('span', { class: 'no', text: h.ply + '.' }), h.move?.notation ?? '']);
  if (label !== '玩家') {
    row.appendChild(el('span', { class: label === 'Jev' ? 'tag jev' : 'tag', text: label }));
  }
  ledger.appendChild(row);
  ledger.scrollTop = ledger.scrollHeight;
}

/** 旧 `rebuildLedger()`（js/app.js:1795-1800）。 */
export function rebuildLedger(moves: readonly SessionMove[], root?: UiRoot | null): void {
  const ledger = qs<HTMLElement>(scopeOf(root), '#ledger');
  if (!ledger) return;
  clear(ledger);
  if (!moves.length) {
    ledger.appendChild(el('div', { class: 'ledger-empty', text: '对局开始后，每一手的记法会记在这里。' }));
    return;
  }
  for (const h of moves) appendLedgerLine(h, ledger);
}
