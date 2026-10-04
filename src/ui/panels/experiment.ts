/* panels/experiment.ts — 对比实验设置面板（A 方 vs B 方，自动交替执黑白）
 *
 * 来源旧实现与行号：
 *   状态与选项常量        js/app.js:1138-1148（EXP / CHAN_LABEL / sideAttribution）
 *   startExperiment()     js/app.js:1150-1165
 *   runExperimentGame()   js/app.js:1166-1189
 *   stop/finishExperiment js/app.js:1190-1201
 *   expSummary()          js/app.js:1202-1215
 *   renderExpStatus()     js/app.js:1216-1224
 *   renderExpResults()    js/app.js:1225-1238
 *   终局记一局            js/app.js:570-591（winnerAB 的 A/B 归属换算）
 *   模式 UI              js/app.js:1875-1910（applyModeUI / syncModeButtons / #mode / #speed）
 *   DOM 契约             index.html:352-388（#pane-exp 的 .mode-switch / .exp-sides / .exp-foot /
 *                        #expStatus / #expResults）与 index.html:300-318（details.settings 的
 *                        #mode / #side / #speedRow / #speed / #speedVal）
 *
 * 风格：**就地更新**（不重建 `.mode-switch` 按钮组与 `details.settings`，只改属性/文本），
 * 与 side-config.ts 的「重建子树」风格刻意不同——因为 `details.settings` 的 `<details open>`
 * 状态与 `#expGames` 的草稿值都在 DOM 里，重建会吃掉用户输入。事件一律 `onOnce`，重复调用安全。
 *
 * 刻意差异：
 *  1. 旧 `startExperiment()` 把「读 DOM」与「改状态」揉在一起；这里拆成 `readExperimentConfig()`
 *     （纯 DOM 读，返回 ExperimentConfig）与 `beginRun(state, cfg, tag?)`（纯状态写）。
 *  2. 旧实验循环（`runExperimentGame`/`borrowSideCfg`/`startGame`）属于装配层编排，本模块只给
 *     `planGame()` / `expInfoFor()` / `winnerSideOf()` / `pushResult()` 这类纯函数。
 *  3. `#expGames` 只在 props.games 显式给出时才写回 DOM（旧实现从不重画该输入框，避免吃掉草稿）。
 *  4. `renderExpResults()` 里胜方归属多了一层 `winnerChan` 空值防御（旧实现直接拼 `who(r.winnerChan)`）。
 *  5. `EXP.results` 的 `winner` 字段保留旧语义（胜方 side id 字符串 / null），不是布尔。
 *  6. 默认战术档用 `CURRENT`（随 core 常量走，v14 起为 'v14-live3-fresh'）而不是硬编码字符串。
 */
import type { CandsStat } from '../../core/meta.ts';
import type { SideConfig } from '../../core/persist.ts';
import type { SessionExportInfo } from '../../core/session.ts';
import { CURRENT, type TacticsVersion } from '../../core/tactics-versions.ts';
import { expLabel } from '../../core/view/duel.ts';
import { el, onOnce, qs, qsa, replaceChildren, setHidden, setText, toggleClass, type UiRoot, type SelectEl } from '../dom.ts';
import { sideAttribution } from './options.ts';
import { renderExperimentSides, type ExperimentSidesHandlers } from './side-config.ts';

/** `#expGames` 的合法区间（旧 `Math.max(1, Math.min(50, …))`）。 */
export const EXP_GAMES_MIN = 1;
export const EXP_GAMES_MAX = 50;
export const EXP_GAMES_DEFAULT = 4;

/** 速度滑杆的每档毫秒（旧 `(150 + v*150)/1000 + 's'`，js/app.js:1908）。 */
export const SPEED_UNIT_MS = 150;

/** 旧 `EXP` 的配置段。 */
export interface ExperimentConfig {
  chanA: string;
  chanB: string;
  tacA: string;
  tacB: string;
  thinkA: number;
  thinkB: number;
  total: number;
}

/** 旧 `EXP.results[i]`（js/app.js:578-587）。 */
export interface ExpResult {
  no: number;
  blackChan: string;
  whiteChan: string;
  blackTac: string | null;
  whiteTac: string | null;
  blackThink: number;
  whiteThink: number;
  /** 胜方 side id（无胜方为 null）；旧字段名就叫 winner */
  winner: string | null;
  /** 胜方属于实验哪一侧（A/B） */
  winnerChan: 'A' | 'B' | null;
  /** 'human' = 该局由人手认输收场 */
  by: string | null;
  /** 该局黑/白方的**战术层平均耗时**（ms）与样本手数：只统计真过了战术层的手，
   *  Rapfi/mock 侧不过战术层 ⇒ 记 null（不是 0），聚合时自动落进样本外。 */
  blackTacMs?: number | null;
  whiteTacMs?: number | null;
  blackTacN?: number;
  whiteTacN?: number;
  /** 该局黑/白方的**候选点三数**（均值 + 样本手数，C0/m13627）：`sent` = 交给 Jev 决定的点数、
   *  `graded` = 模型给了概率的点数、`labeled` = 其中带战术标签的点数。非 Jev 侧不过候选集 ⇒ null。 */
  blackCands?: CandsStat | null;
  whiteCands?: CandsStat | null;
  /** 该局黑/白方的**逐提供方手数**（C3/C2）：`{primary: 24, backup: 3}`，非 Jev 侧为 null。
   *  上游兜底的手要能在报表里单独数出来（它们不算主口径的样本）。 */
  blackProv?: Record<string, number> | null;
  whiteProv?: Record<string, number> | null;
}

/** 旧 `EXP` 全量（js/app.js:1139）。 */
export interface ExperimentState extends ExperimentConfig {
  running: boolean;
  /** 已完成的局数 = 当前局 0-based 序号 */
  idx: number;
  tag: string | null;
  results: ExpResult[];
}

/** 旧 EXP 初值（tacA/tacB 用 CURRENT，即登记表最后一档）。 */
export function createExperimentState(patch: Partial<ExperimentState> = {}): ExperimentState {
  return {
    running: false,
    idx: 0,
    total: EXP_GAMES_DEFAULT,
    chanA: 'proxy',
    chanB: 'random',
    tacA: CURRENT,
    tacB: CURRENT,
    thinkA: 0,
    thinkB: 0,
    tag: null,
    results: [],
    ...patch,
  };
}

/** 旧 `EXP.total` 的归一（js/app.js:1160）。 */
export function clampGames(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  const safe = Number.isFinite(n) ? n : 0;
  return Math.max(EXP_GAMES_MIN, Math.min(EXP_GAMES_MAX, safe || EXP_GAMES_DEFAULT));
}

/** 旧 `EXP.tag`（js/app.js:1161）：`exp-YYYYMMDDHHmmss`。 */
export function expTag(now: Date = new Date()): string {
  return 'exp-' + now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

/** 旧 `mk(who)`（js/app.js:1170-1174）：取某一侧的生效覆盖。 */
export function mkSide(state: ExperimentState, who: 'A' | 'B'): SideConfig {
  return who === 'A'
    ? { channel: state.chanA, tactics: state.tacA, rapfiThinkMs: state.thinkA }
    : { channel: state.chanB, tactics: state.tacB, rapfiThinkMs: state.thinkB };
}

/** 第 `gameNo` 局（1-based）的黑白归属与配置；A 在奇数局执黑（旧 `aBlack = idx % 2 === 0`）。 */
export function sidesForGame(
  state: ExperimentState,
  gameNo: number,
): { aBlack: boolean; black: SideConfig; white: SideConfig } {
  const aBlack = (gameNo - 1) % 2 === 0;
  return {
    aBlack,
    black: mkSide(state, aBlack ? 'A' : 'B'),
    white: mkSide(state, aBlack ? 'B' : 'A'),
  };
}

/** 旧 `S.expInfo` 的组装（js/app.js:1177-1182）；形状对齐 `src/core/session.ts` 的 SessionExportInfo。 */
export function expInfoFor(state: ExperimentState, gameNo: number): SessionExportInfo {
  const s = sidesForGame(state, gameNo);
  return {
    tag: state.tag ?? '',
    gameNo,
    blackChannel: s.black.channel,
    whiteChannel: s.white.channel,
    blackTactics: s.black.tactics,
    whiteTactics: s.white.tactics,
    blackThink: s.black.rapfiThinkMs,
    whiteThink: s.white.rapfiThinkMs,
  };
}

export interface ExperimentPlan {
  gameNo: number;
  aBlack: boolean;
  /** 执黑/执白的是实验的哪一侧 */
  black: 'A' | 'B';
  white: 'A' | 'B';
  blackCfg: SideConfig;
  whiteCfg: SideConfig;
  expInfo: SessionExportInfo;
}

/** 旧 `runExperimentGame()` 的前半段（js/app.js:1166-1176）：跑下一局要写入的配置；跑完返回 null。 */
export function planGame(state: ExperimentState): ExperimentPlan | null {
  if (!state.running || state.idx >= state.total) return null;
  const gameNo = state.idx + 1;
  const s = sidesForGame(state, gameNo);
  return {
    gameNo,
    aBlack: s.aBlack,
    black: s.aBlack ? 'A' : 'B',
    white: s.aBlack ? 'B' : 'A',
    blackCfg: s.black,
    whiteCfg: s.white,
    expInfo: expInfoFor(state, gameNo),
  };
}

/** 旧 `startExperiment()` 的状态段（js/app.js:1151-1163）。 */
export function beginRun(state: ExperimentState, cfg: ExperimentConfig, tag: string = expTag()): void {
  state.running = true;
  state.idx = 0;
  state.results = [];
  state.chanA = cfg.chanA;
  state.chanB = cfg.chanB;
  state.tacA = cfg.tacA;
  state.tacB = cfg.tacB;
  state.thinkA = cfg.thinkA;
  state.thinkB = cfg.thinkB;
  state.total = clampGames(cfg.total);
  state.tag = tag;
}

/** 旧 `stopExperiment()` / `finishExperiment()` 的状态段（js/app.js:1190-1201）：只停跑，tag 保留给归档。 */
export function endRun(state: ExperimentState): void {
  state.running = false;
}

/** 旧 `winnerAB` 换算（js/app.js:575-577）：胜方是黑是白 + 局号奇偶 → A/B。 */
export function winnerSideOf(
  gameNo: number,
  winnerSideId: string | null | undefined,
  firstSideId: string,
): 'A' | 'B' | null {
  if (!winnerSideId) return null;
  const aIsBlack = (gameNo - 1) % 2 === 0;
  return (winnerSideId === firstSideId) === aIsBlack ? 'A' : 'B';
}

/** 旧 `EXP.results.push({...}); EXP.idx++`（js/app.js:578-588）：就地追加一局结果。 */
export function pushResult(state: ExperimentState, input: Omit<ExpResult, 'no'>): ExpResult {
  const rec: ExpResult = { no: state.idx + 1, ...input };
  state.results.push(rec);
  state.idx++;
  return rec;
}

/** 旧 `expSummary()`（js/app.js:1202-1215）。 */
export function expSummary(state: ExperimentState): string {
  let a = 0;
  let b = 0;
  let d = 0;
  state.results.forEach((r) => {
    if (!r.winner) d++;
    else if (r.winnerChan === 'A') a++;
    else b++;
  });
  return `${expLabel(mkSide(state, 'A'), mkSide(state, 'B'), state.total)} ${a}胜 · ${b}胜 · 和棋 ${d}`;
}

/** 旧 `renderExpStatus()`（js/app.js:1216-1224）。 */
export function renderExpStatus(state: ExperimentState, root?: UiRoot | null): void {
  const r = root ?? document;
  setText(
    qs(r, '#expStatus'),
    state.running ? `进行中 ${state.idx + 1}/${state.total}` : state.results.length ? '已完成' : '待开始',
  );
  setHidden(qs(r, '#expStartBtn'), state.running);
  setHidden(qs(r, '#expStopBtn'), !state.running);
}

/** 旧 `renderExpResults()` 的每行（js/app.js:1233-1236）。 */
export function expResultRows(state: ExperimentState): HTMLElement[] {
  const who = (letter: 'A' | 'B'): string =>
    sideAttribution(
      letter === 'A' ? state.chanA : state.chanB,
      letter === 'A' ? state.tacA : state.tacB,
      letter === 'A' ? state.thinkA : state.thinkB,
    );
  return state.results.map((r) => {
    const win = r.winner && r.winnerChan ? '→ ' + who(r.winnerChan) + '胜' : '→ 和棋';
    return el('div', { class: 'exp-row' }, [
      el('span', { text: '#' + r.no }),
      el('span', { text: sideAttribution(r.blackChan, r.blackTac, r.blackThink) + '(黑)' }),
      el('span', { text: 'vs' }),
      el('span', { text: sideAttribution(r.whiteChan, r.whiteTac, r.whiteThink) + '(白)' }),
      el('b', {}, [win, r.by === 'human' ? el('i', { text: '人判' }) : null]),
    ]);
  });
}

/** 旧 `renderExpResults()`（js/app.js:1225-1238）。 */
export function renderExpResults(state: ExperimentState, root?: UiRoot | null): void {
  const r = root ?? document;
  const box = qs(r, '#expResults');
  if (!box) return;
  if (!state.results.length) {
    replaceChildren(box, []);
    return;
  }
  replaceChildren(box, [el('div', { class: 'exp-head', text: expSummary(state) }), ...expResultRows(state)]);
}

/** 模式按钮组的三档（index.html:352-356 的静态按钮，文案与顺序逐字照搬）。 */
export const MODE_BUTTONS: readonly { mode: string; label: string }[] = [
  { mode: 'human-ai', label: '人 vs 机器' },
  { mode: 'ai-ai', label: '机 vs 机' },
  { mode: 'pvp', label: '人 vs 人' },
];

/** 旧 `syncModeButtons()`（js/app.js:1888-1895）：按钮组只反映 `#mode` 的值，实验跑动中禁用。 */
export function renderModeSwitch(mode: string, locked = false, root?: UiRoot | null): void {
  qsa<HTMLButtonElement>(root ?? document, '.mode-switch button[data-mode]').forEach((b) => {
    const on = b.dataset.mode === mode;
    toggleClass(b, 'active', on);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = locked;
  });
}

/** 旧 `bind()` 里的按钮组点击（js/app.js:1900-1906）：实验跑动中静默忽略。 */
export function bindModeSwitch(
  fn: (mode: string) => void,
  root?: UiRoot | null,
  locked?: () => boolean,
): void {
  qsa<HTMLButtonElement>(root ?? document, '.mode-switch button[data-mode]').forEach((b) => {
    onOnce(b, 'click', () => {
      if (locked?.()) return;
      const mode = b.dataset.mode;
      if (mode) fn(mode);
    });
  });
}

/** 旧 `(150 + v*150)/1000 + 's'`（js/app.js:1908）。 */
export function speedLabel(value: number): string {
  return (150 + value * SPEED_UNIT_MS) / 1000 + 's';
}

export interface MatchSettingsProps {
  mode: string;
  side: string;
  speed: number;
}

export interface MatchSettingsHandlers {
  /** 模式切换（两种入口：`#mode` select 与 `.mode-switch` 按钮组） */
  onModeChange?(mode: string): void;
  onSideChange?(side: string): void;
  onSpeedChange?(speed: number): void;
}

/** `details.settings` 的就地同步（#mode / #side / #speed / #speedVal / #speedRow），不重建子树。 */
export function syncMatchSettings(
  props: MatchSettingsProps & { locked?: boolean },
  root?: UiRoot | null,
): void {
  const r = root ?? document;
  const modeEl = qs<SelectEl>(r, '#mode');
  if (modeEl) modeEl.value = props.mode;
  const sideEl = qs<SelectEl>(r, '#side');
  if (sideEl) sideEl.value = props.side;
  const speedEl = qs<HTMLInputElement>(r, '#speed');
  if (speedEl) speedEl.value = String(props.speed);
  setText(qs(r, '#speedVal'), speedLabel(props.speed));
  setHidden(qs(r, '#speedRow'), props.mode !== 'ai-ai');
  renderModeSwitch(props.mode, !!props.locked, r);
}

/** 绑 `details.settings` 的三个控件（onOnce；`#mode`/`#side` change、`#speed` input）。 */
export function bindMatchSettings(handlers: MatchSettingsHandlers, root?: UiRoot | null): void {
  const r = root ?? document;
  onOnce(qs(r, '#mode'), 'change', () => handlers.onModeChange?.(qs<SelectEl>(r, '#mode')?.value ?? ''));
  onOnce(qs(r, '#side'), 'change', () => handlers.onSideChange?.(qs<SelectEl>(r, '#side')?.value ?? ''));
  onOnce(qs(r, '#speed'), 'input', () => {
    const v = parseInt(qs<HTMLInputElement>(r, '#speed')?.value ?? '', 10) || 0;
    setText(qs(r, '#speedVal'), speedLabel(v));
    handlers.onSpeedChange?.(v);
  });
}

/** 旧 `startExperiment()` 的 DOM 读段（js/app.js:1154-1160）。 */
export function readExperimentConfig(root?: UiRoot | null): ExperimentConfig {
  const r = root ?? document;
  const val = (sel: string): string => qs<SelectEl>(r, sel)?.value ?? '';
  return {
    chanA: val('#expChanA'),
    chanB: val('#expChanB'),
    tacA: val('#expTacA'),
    tacB: val('#expTacB'),
    thinkA: +val('#expThinkA') || 0,
    thinkB: +val('#expThinkB') || 0,
    total: clampGames(qs<HTMLInputElement>(r, '#expGames')?.value),
  };
}

export interface ExperimentPanelProps {
  state: ExperimentState;
  versions: readonly TacticsVersion[];
  /** A/B 两方的当前档位（通常直接来自 settings.sideConfig 的草稿） */
  config: { A: SideConfig; B: SideConfig };
  match: MatchSettingsProps;
  /** 显式给出时才写回 `#expGames`（缺省保留用户草稿） */
  games?: number;
}

/** 实验面板处理器：A/B 档位（`ExperimentSidesHandlers`）+ 对局设置 + 启停。
 *
 *  刻意差异：**不** `extends MatchSettingsHandlers` —— 它的 `onSideChange(side: string)`（index.html 的 `#side`）
 *  与 `ExperimentSidesHandlers.onSideChange(side: 'A'|'B', patch)` 同名不同签名，多继承会触发 TS2320。
 *  这里把对局设置那侧显式重声明为 `onMatchSideChange`；装配时把它转交给 `bindMatchSettings`。 */
export interface ExperimentPanelHandlers extends ExperimentSidesHandlers {
  onModeChange?(mode: string): void;
  onMatchSideChange?(side: string): void;
  onSpeedChange?(speed: number): void;
  onGamesChange?(games: number): void;
  onStart?(): void;
  onStop?(): void;
}

/** 实验面板整体渲染（幂等）：A/B 侧栏 + 对局设置 + 状态 + 已验证结果。 */
export function renderExperimentPanel(
  root: UiRoot,
  props: ExperimentPanelProps,
  handlers: ExperimentPanelHandlers = {},
): void {
  renderExperimentSides(
    root,
    { versions: props.versions, A: props.config.A, B: props.config.B },
    { onSideChange: handlers.onSideChange },
  );
  syncMatchSettings({ ...props.match, locked: props.state.running }, root);
  if (props.games != null) {
    const gamesEl = qs<HTMLInputElement>(root, '#expGames');
    if (gamesEl) gamesEl.value = String(props.games);
  }
  renderExpStatus(props.state, root);
  renderExpResults(props.state, root);
}

/** 绑 `#expStartBtn` / `#expStopBtn` / `#expGames`（onOnce）。 */
export function bindExperimentPanel(handlers: ExperimentPanelHandlers, root?: UiRoot | null): void {
  const r = root ?? document;
  onOnce(qs(r, '#expStartBtn'), 'click', () => handlers.onStart?.());
  onOnce(qs(r, '#expStopBtn'), 'click', () => handlers.onStop?.());
  onOnce(qs(r, '#expGames'), 'change', () =>
    handlers.onGamesChange?.(clampGames(qs<HTMLInputElement>(r, '#expGames')?.value)),
  );
}
