/* tactics-strip.ts — 战术沿革条纯视图（零 insertAdjacentHTML，由 app/panels.ts 供数） */
import { el } from '../dom.ts';

export interface TacticVersionItem {
  id: string;
  name: string;
  commit: string;
  commitAt: string;
  note: string;
  games?: number;
  gamesVerified?: number;
}

export interface TacticsStripProps {
  root: HTMLElement;
  versions: readonly TacticVersionItem[];
  currentVersion: string;
  latestId: string;
  inUseIds: readonly string[];
  onPick: (id: string) => void;
}

function gamesText(v: { games?: number; gamesVerified?: number }): string {
  if (!v.games && !v.gamesVerified) return '—';
  return '窗口 ' + v.games + ' · 实证 ' + v.gamesVerified;
}

/** 渲染战术版本沿革条（纯 DOM 装配，点击回调由编排层写入 settings）。 */
export function renderTacticsStripView(props: TacticsStripProps): void {
  const { root, versions, currentVersion, latestId, inUseIds, onPick } = props;
  const rows = versions.map((v) => {
    const cur = currentVersion === v.id;
    const used = inUseIds.indexOf(v.id) >= 0;
    const idLabel = v.id.replace(/^v(\d+).*/, (_m, n: string) => 'v' + n)
      + (v.id === latestId ? '·今' : '');
    const metaLabel = gamesText(v) + (cur ? ' · 当前' : (used ? ' · 在用' : ''));
    const title = v.name + '（' + v.commit + '，' + v.commitAt + '）'
      + (v.games || v.gamesVerified ? '归档 窗口 ' + v.games + ' 局 / 实证 ' + v.gamesVerified + ' 局' : '暂无归档棋谱')
      + '\n' + v.note;

    return el('button', {
      type: 'button',
      class: 'tv-row' + (cur ? ' cur' : '') + (used ? ' used' : ''),
      dataset: { ver: v.id },
      title,
      onclick: () => onPick(v.id),
    }, [
      el('span', { class: 'tv-id' }, idLabel),
      el('span', { class: 'tv-name' }, v.name),
      el('span', { class: 'tv-meta' }, metaLabel),
    ]);
  });
  root.replaceChildren(...rows);
}
