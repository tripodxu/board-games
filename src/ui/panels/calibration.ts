/* calibration.ts — 校准实验室面板纯视图（零 innerHTML，由 app/panels.ts 供数） */
import { calibration, type Metrics, type Sample } from '../../core/view/calibration.ts';
import { renderCalibrationChartInto } from '../charts.ts';
import { el, setText, svgEl } from '../dom.ts';

function pctText(v: number | null | undefined, digits = 0): string {
  return typeof v === 'number' ? (v * 100).toFixed(digits) + '%' : '–';
}

export interface CalibrationViewProps {
  root: HTMLElement;
  countEl: HTMLElement | null;
  games: number;
  serverGames: number;
  draws: number;
  skippedDemo: number;
  samples: Sample[];
  metrics: Metrics | null;
}

/** 渲染校准实验室（空态用自绘 SVG 对角线，有样本时画技巧分 + 四指标 + 可靠性曲线 + 结语）。 */
export function renderCalibrationView(props: CalibrationViewProps): void {
  const { root, countEl, games, serverGames, draws, skippedDemo, samples, metrics: m } = props;
  setText(
    countEl,
    games
      ? games + ' 局 / ' + samples.length + ' 手' + (serverGames ? '（含服务端 ' + serverGames + ' 局）' : '')
      : '',
  );

  if (!m) {
    const why = skippedDemo
      ? '已有 ' + skippedDemo + ' 局离线演示。演示的胜率是本地合成的，拿它量校准没有意义——请接入真实 Jev 渠道后再看。'
      : '还没有真实渠道的对局记录。接入 Jev（官方 / OpenRouter / 同源代理）下几局，这里会把「Jev 说的胜率」和「实际胜负」摆在一起量。';
    const glyph = svgEl('svg', {
      class: 'glyph',
      width: 88,
      height: 52,
      viewBox: '0 0 88 52',
      'aria-hidden': 'true',
      fill: 'none',
    }, [
      svgEl('path', {
        class: 'g-ref',
        d: 'M8 44 L80 8',
        stroke: 'currentColor',
        'stroke-width': 1,
        'stroke-linecap': 'round',
      }),
      svgEl('circle', { cx: 58, cy: 12, r: 3.2, fill: 'currentColor' }),
      svgEl('line', { x1: 8, y1: 6, x2: 8, y2: 44, stroke: 'currentColor', 'stroke-width': 1, opacity: '.45' }),
      svgEl('line', { x1: 8, y1: 44, x2: 82, y2: 44, stroke: 'currentColor', 'stroke-width': 1, opacity: '.45' }),
    ]);
    root.replaceChildren(el('div', { class: 'cal-empty' }, [glyph, why]));
    return;
  }

  const skill = m.skill;
  const skillTxt = skill === null ? '–' : (skill > 0 ? '+' : '') + (skill * 100).toFixed(0);
  const skillNote =
    skill === null ? '基准率退化，无法比较'
      : skill > 0.5 ? '明显有信息量'
        : skill > 0 ? '略强于「恒猜平均胜率」'
          : skill > -0.5 ? '基本没有信息量'
            : '比「恒猜平均胜率」还差';

  const hero = el('div', { class: 'cal-hero' + (skill !== null && skill < 0 ? ' bad' : '') }, [
    el('div', { class: 'cal-hero-v mono' }, skillTxt),
    el('div', { class: 'cal-hero-k' }, '技巧分'),
    el('div', { class: 'cal-hero-note' }, skillNote),
  ]);

  const tile = (val: string, label: string) =>
    el('div', { class: 'ct' }, [el('b', { class: 'mono' }, val), el('span', null, label)]);
  const tiles = el('div', { class: 'cal-tiles' }, [
    tile(pctText(m.ece, 1), '校准误差'),
    tile(m.brier.toFixed(3), 'Brier 分'),
    tile(pctText(m.sharpness), '平均预测'),
    tile(pctText(m.baseRate), '实际胜率'),
  ]);

  const chart = el('div', { id: 'calChart', class: 'cal-chart' });

  const over = m.overconfidence;
  const verdictText = Math.abs(over) < 0.05
    ? '平均预测与实际胜率基本吻合，Jev 既不狂妄也不怯懦。'
    : over > 0
      ? 'Jev 平均比现实乐观 ' + Math.round(over * 100) + ' 个百分点——说七成的时候常兑现不到七成。'
      : 'Jev 平均比现实保守 ' + Math.round(-over * 100) + ' 个百分点——它比实际更不敢下注。';

  const verdict = el('div', { class: 'cal-verdict' + (over > 0.05 ? ' warn' : '') }, verdictText);
  const caveat = el('div', { class: 'cal-caveat' },
    '样本按「局」强相关：同一局内各手共享同一真实胜负，' +
    '有效样本量更接近 ' + games + ' 局而非 ' + samples.length + ' 手。' +
    (serverGames ? '其中 ' + serverGames + ' 局来自服务端归档，换设备、清缓存都不丢。' : '') +
    (draws ? '另有 ' + draws + ' 局和棋无二元真值，未计入。' : ''));

  root.replaceChildren(hero, tiles, chart, verdict, caveat);
  renderCalibrationChartInto(chart, calibration.reliability(samples, 10), {});
}
