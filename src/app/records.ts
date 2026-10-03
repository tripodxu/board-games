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
 */
import { listGames, gameUrl } from '../core/api/client.ts';
import { getGame } from '../core/registry.ts';
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

/** 一页一页往里加的累积列表 + 服务端给的 keyset 游标。 */
let archiveRows: ArchiveRow[] = [];
let archiveCursor: string | null = null;
let archiveLoading = false;

/**
 * 旧 `loadGameArchive()`：把后端归档棋谱按战术版本分组（**第一页**）。
 * 只有一条数据通路（`GET /api/games`），不需要逐份抓内容。
 * 后续页走 `loadMoreArchive()`（keyset 分页，`?cursor=`）。
 */
export async function loadGameArchive(ctx: AppCtx): Promise<void> {
  const box = byId<HTMLElement>('archiveBody');
  if (!box) return;
  archiveRows = [];
  archiveCursor = null;
  box.replaceChildren(el('div', { class: 'hint' }, '读取中…'));
  await fetchArchivePage(ctx, true);
}

/** 「加载更多」：按上一页给的游标再取一页，追加后重画（分组是重画的，所以新旧局会并到同一组）。 */
export async function loadMoreArchive(ctx: AppCtx): Promise<void> {
  if (archiveLoading || !archiveCursor) return;
  const btn = byId<HTMLElement>('archiveMoreBtn') as (HTMLElement & { disabled?: boolean }) | null;
  if (btn) {
    btn.textContent = '读取中…';
    btn.setAttribute('disabled', '');
  }
  await fetchArchivePage(ctx, false);
}

/** 取一页并入 `archiveRows`。`first` 决定失败时的降级文案（首屏给提示，追加失败只提示不改列表）。 */
async function fetchArchivePage(ctx: AppCtx, first: boolean): Promise<void> {
  const box = byId<HTMLElement>('archiveBody');
  if (!box) return;
  archiveLoading = true;

  let list: Awaited<ReturnType<typeof listGames>> = null;
  try {
    list = await listGames({
      limit: ARCHIVE_PAGE_SIZE,
      ...(archiveCursor ? { cursor: archiveCursor } : {}),
    });
  } catch (_) {
    list = null;
  } finally {
    archiveLoading = false;
  }

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

/** 按战术版本分组重画（第一页与「加载更多」共用）。 */
function renderArchive(ctx: AppCtx, box: HTMLElement): void {
  const groups = new Map<string, ArchiveRow[]>();
  for (const raw of archiveRows) {
    const vid = raw.tacticsVersion ? String(raw.tacticsVersion) : '';
    const key = vid || '__none';
    if (!groups.has(key)) groups.set(key, []);
    (groups.get(key) as ArchiveRow[]).push(raw);
  }

  const order = VERSIONS.map((v) => v.id);
  const keys = Array.from(groups.keys()).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  if (!keys.length) {
    box.replaceChildren(el('div', { class: 'hint' },
      '后端还没有归档棋谱。跑完一局（勾了「棋谱同步」）就会出现在这里。'));
    setText(byId('archiveNote'), '0 份 · 按战术版本分组');
    return;
  }

  const frag = document.createDocumentFragment();
  for (const key of keys) {
    /* 归档行里的 `tacticsVersion` 可能是登记表外的值（改名前的老档、导入的外部棋谱）：
       展示路径用宽容解析（P0/D2），认不出就把原始 id 原样列出来 —— 不许冒充当前档。 */
    const known = key === '__none' ? null : tryResolve(key);
    const knownId = typeof known?.id === 'string' ? known.id : (key === '__none' ? null : key);
    const items = (groups.get(key) as ArchiveRow[]).slice().sort((a, b) =>
      String(b.createdAt || b.rowAt || b.name || '').localeCompare(String(a.createdAt || a.rowAt || a.name || '')));
    const head = known
      ? knownId + ' · ' + String(known.name || '') + '（' + String(known.commitAt || '') + ' 引入）'
      : (key === '__none'
        ? '未标注战术版本（行里没有 tactics_version）'
        : '登记表外的档位：' + key + '（原样显示，未归档到沿革条）');
    frag.appendChild(el('div', { class: 'arc-group' }, [
      el('div', { class: 'arc-head' }, [head, el('span', { class: 'arc-count' }, items.length + ' 局')]),
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
  setText(byId('archiveNote'),
    archiveRows.length + ' 份 · 按战术版本分组' + (archiveCursor ? ' · 还有更多' : ''));
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
