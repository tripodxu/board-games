/* records.ts — 棋谱归档面板（旧 js/app.js:1035-1092 的「归档面板」段）
 *
 * **本文件是 P6b 有意改写旧口径的地方之一**（任务书明确要求）：
 *   旧实现按**文件名 stamp** 归版本（`BG.tacticsVersions.versionForFileStamp(name)`），
 *   因为旧后端把棋谱存成 `games/<day>/<gid>-<stamp>.json`，版本只能从文件名推断。
 *   新后端 D1 的 `games` 表有 `tactics_version` 列，`GET /api/games` 的每一行都直接带回来，
 *   所以这里**直接读行里的 `tacticsVersion`**，不再猜。收益：改过名的棋谱、跨天归档、
 *   手工导入的历史棋谱都能正确归版本；代价：早于 P5 的数据若该列为空，会落到
 *   「未标注战术版本」组（不会再被误归到某一版）。
 *
 * 其余文案、DOM 结构、分组顺序（按登记表顺序，未知排 99）与旧实现逐字一致。
 *
 * **2026-10-12（P1②）补齐这条限制点名的两件缺事**：
 *   ① 分组口径可切：默认仍按「战术版本」（旧口径不动），可切到「代码版本」——历史归档里
 *      `tactics_version` 恒 NULL（54/54 无逐手 `ai.tv`），只有 `code_version` 有值
 *      （unknown / 0.7.0 / 0.8.0 / 1.0.0+sha），按战术版本看只会得到一大坨「未标注」。
 *   ② 筛选控件：棋种（`?game=`）/ 实验 tag（`?tag=`）/ 时间窗（`?since=`）三项服务端**早已支持**，
 *      只是面板没控件。改任一项都重置游标重读第一页（游标是上一套条件的位置，留着会串页）。
 *   **渠道筛选刻意没做**：服务端要按 `black_channel = ? OR white_channel = ?` 过滤，这种 OR 写法
 *   走不了任何索引（ADR-0011「查询必须走索引」），要做就得先设计列/索引，不在本轮范围。
 *
 * **2026-10-12（P1③）补「只看我的」**：归档面板加一个勾选框，命中服务端 `?device=me`。
 *   这条过滤靠 `X-Device-Id` 请求头认身份（服务端 :121-125：缺头直接 400），而浏览器侧此前
 *   根本不发这个头 ⇒ ADR-0013 写的「零登录成本获得『只看我的』」一直只是纸面收益。
 *   客户端侧的生成 / 持久化在 `src/core/device.ts`，注入在 `src/core/api/client.ts`。
 *   勾选后若仍是「后端不可用」，说明设备头没发出去（冒烟把这条写成断言，见 7.5c）。
 */
import { listGames, gameUrl, type Query } from '../core/api/client.ts';
import { getGame, ids as gameIds } from '../core/registry.ts';
import { VERSIONS, tryResolve } from '../core/tactics-versions.ts';
import { byId, el, setText, clear } from '../ui/dom.ts';
import { renderLatestGames, type LatestGameRow } from '../ui/panels/experiment-report.ts';
import { sideAttribution } from '../ui/panels/options.ts';
import type { AppCtx } from './ctx.ts';
import { openReplayer } from './panels.ts';

/** 归档行（`GET /api/games` 的 `listItem()`，见 src/worker/routes/games.ts:56-63）。 */
interface ArchiveRow {
  gameUid?: string;
  gameId?: string;
  game?: string;
  name?: string;
  path?: string;
  day?: string;
  createdAt?: string;
  rowAt?: string;
  tacticsVersion?: string | null;
  codeVersion?: string | null;
  blackChannel?: string | null;
  whiteChannel?: string | null;
  blackTactics?: string | null;
  whiteTactics?: string | null;
  blackThink?: number | null;
  whiteThink?: number | null;
  moveCount?: number | null;
  result?: string | null;
  experimentTag?: string | null;
  expGameNo?: number | null;
  [k: string]: unknown;
}

/** 档案馆时间列：`MM-DD HH:MM`（旧实现从文件名 stamp 里切，这里改读行里的时间戳）。 */
function archiveWhen(g: ArchiveRow): string {
  const day = String(g.day || '');
  const iso = String(g.createdAt || g.rowAt || '');
  const d = new Date(iso);
  let hhmm = '';
  if (!Number.isNaN(d.getTime())) {
    const p2 = (n: number) => String(n).padStart(2, '0');
    hhmm = p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  return (day.length >= 10 ? day.slice(5) : day) + (hhmm ? ' ' + hhmm : '');
}

/** 棋种中文名：优先用行里的 `game` 列，缺了再回落到注册表。 */
function archiveGameName(g: ArchiveRow): string {
  if (g.game) return String(g.game);
  const gid = String(g.gameId || '');
  const engine = gid ? getGame(gid) : undefined;
  if (engine) return engine.name;
  return gid || '?';
}

/** 归档面板每页条数（服务端上限 100，这里取 50：首屏够用，且 `54 局` 这种真实数据上就能看到「加载更多」）。 */
export const ARCHIVE_PAGE_SIZE = 50;

/** 分组口径：`tactics` = `tactics_version`（登记表顺序），`code` = `code_version`（组内最新在前）。 */
export type ArchiveGroupMode = 'tactics' | 'code';

/** 归档筛选（面板级状态，**刻意不进设置**：它描述「现在在看哪一段归档」，不是用户偏好）。 */
export interface ArchiveFilters {
  /** 引擎 id（`?game=`），空串 = 全部棋种。 */
  game: string;
  /** 实验 tag（`?tag=`，服务端是精确匹配），空串 = 不过滤。 */
  tag: string;
  /** 时间窗的「天数」原始值（`7`/`30`/`90`），空串 = 全部时间。 */
  since: string;
  /** 只看本机设备归档的棋谱（`?device=me`，身份走 `X-Device-Id` 请求头）。 */
  mine: boolean;
  group: ArchiveGroupMode;
}

/** 默认口径：战术版本 + 无筛选（与旧行为逐字一致，冒烟里的「54 份 · 按战术版本分组」靠它）。 */
export const archiveFilters: ArchiveFilters = { game: '', tag: '', since: '', mine: false, group: 'tactics' };

/** 一页一页往里加的累积列表 + 服务端给的 keyset 游标。 */
let archiveRows: ArchiveRow[] = [];
let archiveCursor: string | null = null;
let archiveLoading = false;
/**
 * 「重读第一页」的代次。换筛选/换分组时两个控件可能连着各发一个 `change`，
 * 于是两次重读并发：都先清空再各推进一页 ⇒ 列表翻倍（冒烟实测 50 → 100 份）。
 * 规则改成：每次重读递增代次，回来的响应代次不是最新就整页丢弃（不并入、不改画、不动 loading）。
 */
let archiveGen = 0;

/** 时间窗（天）→ `since` 的 UTC 日。`day` 列本身就是 `toISOString().slice(0,10)` 派生的，口径必须一致。 */
export function archiveSinceDay(days: string, nowMs: number = Date.now()): string {
  const n = parseInt(days, 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(nowMs - n * 86400000).toISOString().slice(0, 10);
}

/** 当前状态 → 查询参数。**插入序即 `qs()` 的拼串序**（测试按 `?limit=50&game=…` 逐字断言）。 */
function archiveQuery(): Query {
  const q: Query = { limit: ARCHIVE_PAGE_SIZE };
  if (archiveCursor) q.cursor = archiveCursor;
  if (archiveFilters.game) q.game = archiveFilters.game;
  if (archiveFilters.tag) q.tag = archiveFilters.tag;
  const since = archiveSinceDay(archiveFilters.since);
  if (since) q.since = since;
  /* `device=me` 放最后：服务端认的是请求头里的身份，参数只表示「按我过滤」；
     插入序同时是 URL 拼串序（测试逐字断言），排在结尾不影响既有断言的写法。 */
  if (archiveFilters.mine) q.device = 'me';
  return q;
}

/** 人的话描述「现在筛了什么」（空串 = 没筛）。棋种翻译成中文名，与行里的 `game` 列同一套说法。 */
function filterSummary(): string {
  const bits: string[] = [];
  if (archiveFilters.game) {
    const g = getGame(archiveFilters.game);
    bits.push(g ? String(g.name) : archiveFilters.game);
  }
  if (archiveFilters.tag) bits.push('tag=' + archiveFilters.tag);
  if (archiveFilters.since) bits.push('最近 ' + archiveFilters.since + ' 天');
  if (archiveFilters.mine) bits.push('只看我的');
  return bits.join(' / ');
}

/** 分组口径的中文说法（note 与空态文案共用）。 */
function groupLabel(): string {
  return archiveFilters.group === 'code' ? '按代码版本分组' : '按战术版本分组';
}

/** 表单控件的结构类型。
 *  不直接写 `HTMLInputElement | HTMLSelectElement`：happy-dom 的 `HTMLSelectElement` 结构上不满足
 *  `byId<T extends HTMLElement>` 的约束（它的 `remove()` 返回 void，与 lib.dom 冲突，TS2344）。
 *  这里只声明真正用到的成员，且 `extends HTMLElement` 是声明式的，不受那处结构不兼容影响。 */
interface ControlLike extends HTMLElement { value: string }
interface SelectLike extends ControlLike { options: { length: number } }
/** 勾选框：只声明真正用到的 `checked`。 */
interface CheckLike extends HTMLElement { checked: boolean }

/** 读控件当前值（缺控件 / 非文本控件一律空串）。 */
function controlValue(id: string): string {
  const n = byId<ControlLike>(id);
  return n ? String(n.value || '').trim() : '';
}

/** 把控件同步成状态值（缺控件时静默跳过）。 */
function setControlValue(id: string, v: string): void {
  const n = byId<ControlLike>(id);
  if (n) n.value = v;
}

/** 读勾选框（缺控件 = 未勾选）。 */
function controlChecked(id: string): boolean {
  const n = byId<CheckLike>(id);
  return !!(n && n.checked);
}

/** 把勾选框同步成状态值（缺控件时静默跳过）。 */
function setControlChecked(id: string, v: boolean): void {
  const n = byId<CheckLike>(id);
  if (n) n.checked = !!v;
}

/** 读五个控件 → 状态补丁（`#archiveTag` 是文本框、`#archiveMine` 是勾选框，其余是下拉；
 *  读全量再整体套用，省掉逐控件分支）。 */
export function readArchiveControls(): Partial<ArchiveFilters> {
  const group = controlValue('archiveGroup');
  return {
    game: controlValue('archiveGame'),
    tag: controlValue('archiveTag'),
    since: controlValue('archiveSince'),
    mine: controlChecked('archiveMine'),
    /* 只认两个合法口径：控件被改坏时退回旧口径，不把 `undefined` 带进分组逻辑 */
    group: group === 'code' ? 'code' : 'tactics',
  };
}

/**
 * 按引擎注册表填棋种下拉，并把五个控件同步成当前状态（幂等：可重复调用，`bindAll` 会重复调）。
 * 空选项 = 全部棋种；其余选项的值是引擎 id（服务端 `?game=` 认的是 id，不是中文名）。
 */
export function fillArchiveControls(): void {
  const sel = byId<SelectLike>('archiveGame');
  if (sel && sel.options.length <= 1) {
    for (const id of gameIds) {
      const g = getGame(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = g ? String(g.name) : id;
      sel.appendChild(opt);
    }
  }
  setControlValue('archiveGame', archiveFilters.game);
  setControlValue('archiveTag', archiveFilters.tag);
  setControlValue('archiveSince', archiveFilters.since);
  setControlValue('archiveGroup', archiveFilters.group);
  setControlChecked('archiveMine', archiveFilters.mine);
}

/** 改筛选 / 换分组口径：游标作废，从头取第一页（`loadGameArchive` 会清空累积行与游标）。 */
export function applyArchiveFilters(ctx: AppCtx, patch: Partial<ArchiveFilters>): void {
  Object.assign(archiveFilters, patch);
  void loadGameArchive(ctx);
}

/**
 * 旧 `loadGameArchive()`：把后端归档棋谱按战术版本分组（**第一页**）。
 * 只有一条数据通路（`GET /api/games`），不需要逐份抓内容。
 * 后续页走 `loadMoreArchive()`（keyset 分页，`?cursor=`）。
 */
export async function loadGameArchive(ctx: AppCtx): Promise<void> {
  const box = byId<HTMLElement>('archiveBody');
  if (!box) return;
  const gen = ++archiveGen;
  archiveRows = [];
  archiveCursor = null;
  box.replaceChildren(el('div', { class: 'hint' }, '读取中…'));
  await fetchArchivePage(ctx, true, gen);
}

/** 「加载更多」：按上一页给的游标再取一页，追加后重画（分组是重画的，所以新旧局会并到同一组）。 */
export async function loadMoreArchive(ctx: AppCtx): Promise<void> {
  if (archiveLoading || !archiveCursor) return;
  const btn = byId<HTMLElement>('archiveMoreBtn') as (HTMLElement & { disabled?: boolean }) | null;
  if (btn) {
    btn.textContent = '读取中…';
    btn.setAttribute('disabled', '');
  }
  await fetchArchivePage(ctx, false, archiveGen);
}

/** 取一页并入 `archiveRows`。`first` 决定失败时的降级文案（首屏给提示，追加失败只提示不改列表），`gen` 用来丢弃过期响应。 */
async function fetchArchivePage(ctx: AppCtx, first: boolean, gen: number): Promise<void> {
  const box = byId<HTMLElement>('archiveBody');
  if (!box) return;
  archiveLoading = true;

  let list: Awaited<ReturnType<typeof listGames>> = null;
  try {
    list = await listGames(archiveQuery());
  } catch (_) {
    list = null;
  }

  /* 过期响应：新一代重读已经把列表清空重画了，这一份既不许并入也不许改 loading（新的那次还在跑）。 */
  if (gen !== archiveGen) return;
  archiveLoading = false;

  if (!list || !Array.isArray(list.games)) {
    if (first) {
      box.replaceChildren(el('div', { class: 'hint' },
        '棋谱归档需要同源后端（npm run dev 会同时起 Vite + Worker + 本地 D1）。离线时只能看本机「战绩簿」。'));
      setText(byId('archiveNote'), '后端不可用');
    } else {
      setText(byId('archiveNote'), '读取下一页失败，已保留前 ' + archiveRows.length + ' 份');
      /* 失败要能把按钮还回来（否则停在「读取中… disabled」，只能刷新整页重试） */
      const btn = byId<HTMLElement>('archiveMoreBtn');
      if (btn) {
        btn.textContent = '加载更多';
        btn.removeAttribute('disabled');
      }
    }
    return;
  }

  for (const raw of list.games as ArchiveRow[]) {
    if (raw && typeof raw === 'object') archiveRows.push(raw);
  }
  archiveCursor = list.nextCursor ? String(list.nextCursor) : null;
  renderArchive(ctx, box);
}

/** 分组键：按当前口径取行里的版本列，空值统一落到 `__none`（不许拿别的口径顶上）。 */
function groupKeyOf(raw: ArchiveRow): string {
  const v = archiveFilters.group === 'code'
    ? (raw.codeVersion ? String(raw.codeVersion) : '')
    : (raw.tacticsVersion ? String(raw.tacticsVersion) : '');
  return v || '__none';
}

/** 组头文案。战术版本走登记表（认不出原样显示）；代码版本没有登记表，直接写原值。 */
function groupHead(key: string): string {
  if (archiveFilters.group === 'code') {
    if (key === '__none') return '未标注代码版本（行里没有 code_version）';
    return '代码版本 ' + key;
  }
  /* 归档行里的 `tacticsVersion` 可能是登记表外的值（改名前的老档、导入的外部棋谱）：
     展示路径用宽容解析（P0/D2），认不出就把原始 id 原样列出来 —— 不许冒充当前档。 */
  const known = key === '__none' ? null : tryResolve(key);
  if (known) {
    return String(known.id) + ' · ' + String(known.name || '') + '（' + String(known.commitAt || '') + ' 引入）';
  }
  return key === '__none'
    ? '未标注战术版本（行里没有 tactics_version）'
    : '登记表外的档位：' + key + '（原样显示，未归档到沿革条）';
}

/** 组内按时间倒序（`createdAt` 缺了退回 `rowAt`，再缺退回文件名）。 */
function byNewest(a: ArchiveRow, b: ArchiveRow): number {
  const t = (g: ArchiveRow) => String(g.createdAt || g.rowAt || g.name || '');
  return t(b).localeCompare(t(a));
}

/** 按当前口径分组重画（第一页与「加载更多」共用）。 */
function renderArchive(ctx: AppCtx, box: HTMLElement): void {
  const groups = new Map<string, ArchiveRow[]>();
  for (const raw of archiveRows) {
    const key = groupKeyOf(raw);
    if (!groups.has(key)) groups.set(key, []);
    (groups.get(key) as ArchiveRow[]).push(raw);
  }

  const keys = Array.from(groups.keys());
  if (archiveFilters.group === 'code') {
    /* 代码版本不在登记表里，没有「版本新旧」的权威顺序：按组内最新一局排（新版本在前），
       未标注的永远排最后（它代表「不知道」，不是最旧）。 */
    keys.sort((a, b) => {
      if (a === '__none') return 1;
      if (b === '__none') return -1;
      const ta = String(((groups.get(a) as ArchiveRow[]).slice().sort(byNewest)[0] || {}).createdAt || '');
      const tb = String(((groups.get(b) as ArchiveRow[]).slice().sort(byNewest)[0] || {}).createdAt || '');
      return tb.localeCompare(ta);
    });
  } else {
    const order = VERSIONS.map((v) => v.id);
    keys.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }

  const active = filterSummary();
  if (!keys.length) {
    box.replaceChildren(el('div', { class: 'hint' }, active
      ? '当前筛选（' + active + '）下没有棋谱。换个条件或点「刷新」重来。'
      : '后端还没有归档棋谱。跑完一局（勾了「棋谱同步」）就会出现在这里。'));
    setText(byId('archiveNote'), '0 份 · ' + (active ? '筛选：' + active : groupLabel()));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const key of keys) {
    const items = (groups.get(key) as ArchiveRow[]).slice().sort(byNewest);
    frag.appendChild(el('div', { class: 'arc-group' }, [
      el('div', { class: 'arc-head' }, [groupHead(key), el('span', { class: 'arc-count' }, items.length + ' 局')]),
      ...items.map((g) => el('div', { class: 'arc-row' }, [
        el('span', { class: 'arc-when' }, archiveWhen(g)),
        el('span', { class: 'arc-game' }, archiveGameName(g)),
        el('a', {
          class: 'arc-open',
          href: gameUrl(g.path),
          target: '_blank',
          rel: 'noreferrer',
        }, '棋谱'),
        /* 新架构专有：行里有 `game_uid` 时可以直接在「棋谱回放」面板里逐手重放 */
        g.gameUid
          ? el('button', {
            class: 'arc-replay mini-btn',
            type: 'button',
            title: '载入上方「棋谱回放」面板逐手重放',
            text: '回放',
            onclick: () => {
              void openReplayer(ctx, String(g.gameUid));
            },
          })
          : null,
      ])),
    ]));
  }

  /* 还有下一页时给一个「加载更多」（服务端 keyset 游标；返回 null 就没有了） */
  if (archiveCursor) {
    frag.appendChild(el('button', {
      id: 'archiveMoreBtn',
      class: 'arc-more mini-btn',
      type: 'button',
      title: '按游标取下一页（keyset 分页）',
      text: '加载更多',
      onclick: () => {
        void loadMoreArchive(ctx);
      },
    }));
  }

  clear(box);
  box.appendChild(frag);
  /* note 的三段拼法与旧实现逐字一致（`N 份 · 分组口径` + 有无更多），筛选只在生效时插一段 */
  setText(byId('archiveNote'), archiveRows.length + ' 份 · ' + groupLabel()
    + (active ? ' · 筛选：' + active : '')
    + (archiveCursor ? ' · 还有更多' : ''));
}

/* ---------- 「最新棋谱」：实验报告面板顶部的归档最新对局 ----------
 * 报告面板原本只画**实验轮次卡**（`#expHistory`），而归档里最新的一批机机对局有的
 * 根本没挂 `experiment` tag（如 `jev-v9-vs-jev-v9`），永远进不了轮次卡 —— 面板看上去
 * 停在早期实验上。这里单独取一页归档、只留最新 N 份渲染到 `#expLatestGames`。
 */

/** 「最新棋谱」显示条数（归档面板首屏是 50 份，这里只要一眼能看到的最新几局）。 */
export const LATEST_GAMES_LIMIT = 10;

/** 归档行 → 报告里的「最新棋谱」行（缺 `game_uid` 的行直接丢掉：回放需要 uid）。 */
function latestRow(raw: ArchiveRow): LatestGameRow | null {
  const gameUid = raw.gameUid ? String(raw.gameUid) : '';
  if (!gameUid) return null;
  return {
    gameUid,
    when: archiveWhen(raw),
    game: archiveGameName(raw),
    black: sideAttribution(raw.blackChannel, raw.blackTactics, raw.blackThink),
    white: sideAttribution(raw.whiteChannel, raw.whiteTactics, raw.whiteThink),
    moves: Number(raw.moveCount) || 0,
    result: String(raw.result || ''),
    ...(raw.experimentTag
      ? { tag: String(raw.experimentTag), ...(raw.expGameNo == null ? {} : { no: Number(raw.expGameNo) }) }
      : {}),
  };
}

/** 取最新一页归档并重画「最新棋谱」（离线 / 后端不可用时给 `null`，面板显「加载中…」）。 */
export async function loadLatestGames(ctx: AppCtx): Promise<void> {
  const box = byId<HTMLElement>('expLatestGames');
  if (!box) return;
  let list: Awaited<ReturnType<typeof listGames>> = null;
  try {
    list = await listGames({ limit: LATEST_GAMES_LIMIT });
  } catch (_) {
    list = null;
  }
  const raw = list && Array.isArray(list.games) ? (list.games as ArchiveRow[]) : null;
  const rows = raw
    ? raw.map(latestRow).filter((r): r is LatestGameRow => r !== null)
    : null;
  renderLatestGames({
    root: box,
    rows,
    handlers: {
      onReplay: (gameUid) => {
        void openReplayer(ctx, gameUid);
      },
    },
  });
}
