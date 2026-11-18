/* archive.ts — 棋谱归档面板纯视图（只负责分组列表、分页按钮与空态 DOM 装配） */
import { el, setText } from '../dom.ts';

export interface ArchiveRowView {
  when: string;
  gameName: string;
  href: string;
  gameUid: string | null;
}

export interface ArchiveGroupView {
  head: string;
  items: ArchiveRowView[];
}

export interface ArchivePanelProps {
  root: HTMLElement;
  noteEl: HTMLElement | null;
  groups: ArchiveGroupView[];
  totalRows: number;
  hasMore: boolean;
  emptyText: string;
  noteText: string;
  onLoadMore: () => void;
  onReplay: (gameUid: string) => void;
}

/** 渲染棋谱归档分组列表与「加载更多」按钮。 */
export function renderArchiveView(props: ArchivePanelProps): void {
  const { root, noteEl, groups, hasMore, emptyText, noteText, onLoadMore, onReplay } = props;

  if (!groups.length) {
    root.replaceChildren(el('div', { class: 'hint' }, emptyText));
    setText(noteEl, noteText);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const grp of groups) {
    frag.appendChild(el('div', { class: 'arc-group' }, [
      el('div', { class: 'arc-head' }, [grp.head, el('span', { class: 'arc-count' }, grp.items.length + ' 局')]),
      ...grp.items.map((item) => el('div', { class: 'arc-row' }, [
        el('span', { class: 'arc-when' }, item.when),
        el('span', { class: 'arc-game' }, item.gameName),
        el('a', {
          class: 'arc-open',
          href: item.href,
          target: '_blank',
          rel: 'noreferrer',
        }, '棋谱'),
        item.gameUid
          ? el('button', {
            class: 'arc-replay mini-btn',
            type: 'button',
            title: '载入上方「棋谱回放」面板逐手重放',
            text: '回放',
            onclick: () => onReplay(item.gameUid!),
          })
          : null,
      ])),
    ]));
  }

  if (hasMore) {
    frag.appendChild(el('button', {
      id: 'archiveMoreBtn',
      class: 'arc-more mini-btn',
      type: 'button',
      title: '按游标取下一页（keyset 分页）',
      text: '加载更多',
      onclick: onLoadMore,
    }));
  }

  root.replaceChildren(frag);
  setText(noteEl, noteText);
}
