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
import { VERSIONS, resolve } from '../core/tactics-versions.ts';
import { byId, el, setText, clear } from '../ui/dom.ts';
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

/**
 * 旧 `loadGameArchive()`：把后端归档棋谱按战术版本分组。
 * 只有一条数据通路（`GET /api/games`），不需要逐份抓内容。
 */
export async function loadGameArchive(ctx: AppCtx): Promise<void> {
  const box = byId<HTMLElement>('archiveBody');
  if (!box) return;
  box.replaceChildren(el('div', { class: 'hint' }, '读取中…'));

  let list: Awaited<ReturnType<typeof listGames>> = null;
  try {
    list = await listGames({ limit: 100 });
  } catch (_) {
    list = null;
  }

  if (!list || !Array.isArray(list.games)) {
    box.replaceChildren(el('div', { class: 'hint' },
      '棋谱归档需要同源后端（npm run dev 会同时起 Vite + Worker + 本地 D1）。离线时只能看本机「战绩簿」。'));
    setText(byId('archiveNote'), '后端不可用');
    return;
  }

  const groups = new Map<string, ArchiveRow[]>();
  for (const raw of list.games as ArchiveRow[]) {
    if (!raw || typeof raw !== 'object') continue;
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
    const known = key === '__none' ? null : resolve(key);
    const knownId = typeof known?.id === 'string' ? known.id : null;
    const items = (groups.get(key) as ArchiveRow[]).slice().sort((a, b) =>
      String(b.createdAt || b.rowAt || b.name || '').localeCompare(String(a.createdAt || a.rowAt || a.name || '')));
    const head = knownId
      ? knownId + ' · ' + String(known?.name || '') + '（' + String(known?.commitAt || '') + ' 引入）'
      : '未标注战术版本（行里没有 tactics_version）';
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
  clear(box);
  box.appendChild(frag);
  setText(byId('archiveNote'), (list.games as unknown[]).length + ' 份 · 按战术版本分组');
}
