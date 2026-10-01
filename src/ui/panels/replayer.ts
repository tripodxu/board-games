/* panels/replayer.ts — 棋谱回放器（计划 §7 P7 第 1 条；喂 `GET /api/games/u/:gameUid`）
 *
 * 职责边界（重要）：
 *  1. **不是棋盘绘制器**。棋盘由调用方经 `props.renderBoard` 注入；本模块只给它一个宿主元素
 *     （每次 render 重建，重建后重调一次），并把当前手 `ply` 传过去。
 *  2. **不做网络请求、不读 localStorage、不 import `node:*`**。payload 的取回由装配层
 *     （`src/app/**`）负责：`getGameByUid(gameUid)` → `replayerInfoOf(payload)` → `renderReplayer`。
 *  3. **不 import UI 框架**，只用 `src/ui/dom.ts` 已有工具（不新增 dom 工具）。
 *
 * 幂等策略（与 `record-book.ts` / `cockpit.ts` 一致）：**重建子树**。每次 render 先 `clear(props.root)`
 * 再重建；所有事件用 `on()` 绑在**新建节点**上，旧节点连同监听一起被丢弃，重复 render 不叠加。
 * 因此 root 上的 `keydown` 也是每次 render 重绑——旧 root 的监听随节点一起消失，不会翻倍。
 *
 * DOM 契约：**不自造必须预先存在于 `index.html` 的容器**。所有节点都挂在 `props.root` 里，
 * 容器与 root 的关系由调用方决定（另一个 agent 正在写 index.html / src/app/**）。
 */
import { gameIdToName } from '../../shared/record-map.ts';
import { clamp, clear, el, fmtDateTime, on, type DomChild } from '../dom.ts';

/** 一手棋（`PayloadMove` 的最小投影；`ai` 用 `unknown` 收口，在渲染时才局部收窄）。 */
export interface ReplayerMove {
  ply: number;
  side: string;
  notation: string;
  ai?: {
    ch?: string | null;
    conf?: unknown;
    p?: unknown;
    ms?: unknown;
    tv?: string | null;
    tac?: string | null;
  } | null;
}

/** 回放器头部元信息（全部可空：老棋谱缺字段时显示「未知」）。 */
export interface ReplayerInfo {
  gameUid?: string | null;
  name?: string | null;
  day?: string | null;
  game?: string | null;
  mode?: string | null;
  result?: string | null;
  exported?: string | null;
  moveCount: number;
  codeVersion?: string | null;
  blackChannel?: string | null;
  whiteChannel?: string | null;
}

export interface ReplayerHandlers {
  /** 当前手变化（点着法行 / 键盘 / 控制条 / 滑杆都走这里） */
  onPlyChange?(ply: number): void;
  /** 分享（仅 `info.gameUid` 非空时按钮存在） */
  onShare?(gameUid: string): void;
}

export interface ReplayerProps {
  /** 挂载点：由调用方传入。本模块只往里写，不假设它已在 index.html 里 */
  root: HTMLElement;
  info: ReplayerInfo;
  moves: ReplayerMove[];
  /** 当前手：0 = 初始局面，1..moveCount = 第 N 手之后 */
  ply?: number;
  /** 棋盘渲染注入点：`(host, ply) => void`。每次 render 重建 host 后重调一次 */
  renderBoard?: (host: HTMLElement, ply: number) => void;
  handlers?: ReplayerHandlers;
}

/** 模式显示名（新客户端存英文 id，老棋谱存中文；两边都认）。 */
const MODE_LABELS: Record<string, string> = {
  'human-ai': '人机',
  'ai-ai': '机机',
  pvp: '双人',
};

/** 缺值占位（四类元信息统一用它）。 */
const UNKNOWN = '未知';

/** 02d 补零（着法列表的手数编号）。 */
function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 非空字符串，否则 null（空串/空白/非字符串一律当缺值）。 */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** 值 → 展示串：null/false/undefined/空串 → 占位符。 */
function textOr(v: unknown, fallback = UNKNOWN): string {
  if (v === null || v === undefined || v === false) return fallback;
  const s = String(v);
  return s ? s : fallback;
}

/** 逗号连接的着法串 → 手数（`notation` 是兜底来源，见 `record-map.ts` 顶部口径说明）。 */
function movesOfNotation(notation: unknown): number {
  const s = strOrNull(notation);
  if (!s) return 0;
  return s.split(',').filter((part) => part.trim()).length;
}

/** 任意 payload → 对象视图（非对象/null/数组一律当空对象）。 */
function payloadObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
}

/** 棋种展示名：`game`（中文名）→ `gameId` → 旧字段 `gid`；都没有给 null。 */
function nameOf(p: Record<string, unknown>): string | null {
  const direct = strOrNull(p.game);
  if (direct) return direct;
  const id = strOrNull(p.gameId) ?? strOrNull(p.gid);
  return id ? gameIdToName(id) : null;
}

/** `meta.code`（代码版本）；`meta` 缺失/非对象给 null。 */
function codeVersionOf(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  return strOrNull((meta as Record<string, unknown>).code);
}

/**
 * payload → `ReplayerInfo`（**纯函数**，无 DOM / 无 IO）。
 *
 * 降级口径：
 *  - payload 不是对象 → 全部缺值、`moveCount = 0`；
 *  - `moves` 不是数组 / 为空 → 用 `notation`（逗号连接）兜底算手数；两者都没有 = 0；
 *  - `day` 优先取 payload 的 `day` 字段，否则退回 `exported`（旧棋谱只有导出时间）。
 */
export function replayerInfoOf(payload: unknown, opts?: { gameUid?: string | null }): ReplayerInfo {
  const p = payloadObject(payload);
  const moves = Array.isArray(p.moves) ? p.moves : null;
  const moveCount = moves ? moves.length : movesOfNotation(p.notation);
  return {
    gameUid: strOrNull(opts && opts.gameUid) ?? strOrNull(p.gameUid),
    name: nameOf(p),
    day: strOrNull(p.day) ?? strOrNull(p.exported),
    game: strOrNull(p.gameId) ?? strOrNull(p.gid),
    mode: strOrNull(p.mode),
    result: strOrNull(p.result),
    exported: strOrNull(p.exported),
    moveCount,
    codeVersion: codeVersionOf(p.meta),
    blackChannel: strOrNull(p.blackChannel),
    whiteChannel: strOrNull(p.whiteChannel),
  };
}

/** 模式展示名：认识的 id 转中文，其它原样（老棋谱的「人机」直接透传）。 */
function modeText(mode: string | null | undefined): string {
  const m = strOrNull(mode);
  if (!m) return UNKNOWN;
  return MODE_LABELS[m] ?? m;
}

/** 「N 手 · 黑:xx / 白:xx」这类渠道摘要；两边都缺时给 null（整段省略）。 */
function channelText(info: ReplayerInfo): string | null {
  const b = strOrNull(info.blackChannel);
  const w = strOrNull(info.whiteChannel);
  if (!b && !w) return null;
  return '黑:' + textOr(b, '—') + ' / 白:' + textOr(w, '—');
}

/* ---------- 头部元信息 ---------- */

function metaItem(label: string, value: unknown, mono = false): HTMLElement {
  return el('span', { class: 'rp-meta-item' }, [
    el('i', { class: 'rp-k', text: label }),
    el('b', { class: mono ? 'rp-v mono' : 'rp-v', text: textOr(value) }),
  ]);
}

function headOf(props: ReplayerProps): HTMLElement {
  const info = props.info;
  const dateText = fmtDateTime(info.day) || UNKNOWN;
  const chan = channelText(info);
  const items: DomChild[] = [
    el('span', { class: 'rp-title', text: textOr(info.name) }),
    metaItem('日期', dateText),
    metaItem('模式', modeText(info.mode)),
    metaItem('结果', textOr(info.result)),
    metaItem('手数', info.moveCount, true),
    chan ? el('span', { class: 'rp-meta-item' }, [el('i', { class: 'rp-k', text: '渠道' }), el('b', { class: 'rp-v', text: chan })]) : null,
    info.codeVersion ? metaItem('版本', info.codeVersion, true) : null,
  ];
  return el('div', { class: 'rp-head' }, items);
}

/* ---------- 着法列表 ---------- */

function moveRow(m: ReplayerMove, cur: boolean, onPick: (ply: number) => void): HTMLElement {
  const row = el(
    'button',
    {
      class: 'rp-move' + (cur ? ' is-cur' : ''),
      type: 'button',
      tabindex: '0',
      dataset: { ply: m.ply },
      'aria-current': cur ? 'true' : null,
      onclick: () => onPick(m.ply),
    },
    [
      el('span', { class: 'rp-ply mono', text: p2(m.ply) }),
      el('span', { class: 'rp-side', text: textOr(m.side, '—') }),
      el('span', { class: 'rp-notation mono', text: textOr(m.notation, '—') }),
    ],
  );
  return row;
}

function moveListOf(props: ReplayerProps, ply: number, onPick: (ply: number) => void): HTMLElement {
  let current: HTMLElement | null = null;
  const rows = props.moves.map((m) => {
    const row = moveRow(m, m.ply === ply, onPick);
    if (m.ply === ply) current = row;
    return row;
  });
  const list = el('div', { class: 'rp-moves' }, rows);
  /* 把当前手滚进可视区（happy-dom 下是 no-op，真实浏览器才有滚动效果）。 */
  if (current) {
    const node: HTMLElement = current;
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }
  return list;
}

/* ---------- 控制条 ---------- */

function ctlBtn(label: string, title: string, onPick: () => void, disabled: boolean): HTMLElement {
  return el(
    'button',
    {
      class: 'rp-btn' + (disabled ? ' is-dim' : ''),
      type: 'button',
      title,
      'aria-label': title,
      disabled: disabled,
      onclick: () => onPick(),
    },
    [el('span', { class: 'rp-glyph', text: label })],
  );
}

function controlsOf(moveCount: number, ply: number, onPick: (ply: number) => void): HTMLElement {
  const range = el('input', {
    class: 'rp-range',
    type: 'range',
    min: 0,
    max: moveCount,
    step: 1,
    value: ply,
    'aria-label': '当前手',
    oninput: (ev: Event) => {
      const raw = (ev.target as HTMLInputElement | null)?.value ?? '';
      onPick(clamp(parseInt(raw, 10) || 0, 0, moveCount));
    },
  });
  return el('div', { class: 'rp-controls' }, [
    ctlBtn('⏮', '首手', () => onPick(0), ply <= 0),
    ctlBtn('◀', '上一手', () => onPick(ply - 1), ply <= 0),
    ctlBtn('▶', '下一手', () => onPick(ply + 1), ply >= moveCount),
    ctlBtn('⏭', '末手', () => onPick(moveCount), ply >= moveCount),
    range,
    el('span', { class: 'rp-pos mono', text: ply + '/' + moveCount }),
  ]);
}

/** 键盘监听的登记表：root 每次 render 复用，所以要先摘掉上一轮挂的监听再挂新的
 * （`clear()` 只清子树，摘不掉挂在 root 自身的监听）。用 WeakMap 免得拖住已废弃的挂载点。 */
const KEY_HANDLERS = new WeakMap<HTMLElement, (ev: Event) => void>();

/* ---------- 渲染 ---------- */

/** 棋谱回放器整体渲染（幂等：重复调用只反映最新 props）。 */
export function renderReplayer(props: ReplayerProps): void {
  const root = props.root;
  const moveCount = Math.max(0, Number.isFinite(props.info.moveCount) ? Math.trunc(props.info.moveCount) : 0);
  const ply = clamp(Number.isFinite(props.ply) ? Math.trunc(props.ply as number) : 0, 0, moveCount);
  const handlers = props.handlers ?? {};
  const pick = (next: number): void => {
    const v = clamp(Number.isFinite(next) ? Math.trunc(next) : 0, 0, moveCount);
    if (v === ply) return;
    handlers.onPlyChange?.(v);
  };

  root.setAttribute('tabindex', '0');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '棋谱回放器');
  root.className = 'rp';
  clear(root);

  const boardHost = el('div', { class: 'rp-board' });
  const share = props.info.gameUid
    ? el(
        'button',
        {
          class: 'rp-share',
          type: 'button',
          text: '分享',
          onclick: () => handlers.onShare?.(String(props.info.gameUid)),
        },
      )
    : null;

  const box = el('div', { class: 'rp-panel' }, [
    el('div', { class: 'rp-head-row' }, [headOf(props), share]),
    props.renderBoard ? boardHost : null,
    moveListOf(props, ply, pick),
    controlsOf(moveCount, ply, pick),
  ]);
  root.appendChild(box);

  if (props.renderBoard) props.renderBoard(boardHost, ply);

  /* 键盘：面板根 tabindex=0，←/→ 改手（preventDefault 挡掉页面横向滚动）。
   *
   * 监听挂在 **root** 上（不是重建出来的 box）：
   *  - root 自己拿到焦点时按 ←/→ 直接命中。happy-dom 实测：派发在 root 上的事件**不会**向下
   *    冒泡到 `.rp-panel`，所以监听只挂 box 的话「root 聚焦 + 按键」会静默失效；
   *  - root 内部任意子节点（着法行、控制条按钮）拿到焦点时，事件冒泡上来同样命中。
   *
   * 幂等：`clear(root)` 只清子树，摘不掉挂在 root 自身的监听，所以每轮 render 都先把上一轮
   * 登记的监听摘掉（`KEY_HANDLERS`），再挂新的——重复 render 不会叠加，也不会用上一轮的 `ply`
   * 重复出参。 */
  const prevKey = KEY_HANDLERS.get(root);
  if (prevKey) root.removeEventListener('keydown', prevKey);
  const onKey = (ev: Event): void => {
    const key = (ev as KeyboardEvent).key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    ev.preventDefault();
    pick(key === 'ArrowLeft' ? ply - 1 : ply + 1);
  };
  KEY_HANDLERS.set(root, onKey);
  on(root, 'keydown', onKey);
}
