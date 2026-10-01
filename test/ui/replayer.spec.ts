/* replayer.spec.ts — 棋谱回放器的运行时断言
 *
 * 断言方式：渲染后查真实 DOM、派发真实事件（click/input/keydown），不做源码字符串匹配。
 * 重点覆盖：元信息缺值降级、着法列表与当前手高亮、控制条 disabled 边界、键盘 ←/→、
 * 棋盘注入（宿主重建 + ply 透传）、分享按钮的有无与回调、重复 render 的幂等（不翻倍/不重复触发）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  replayerInfoOf,
  renderReplayer,
  type ReplayerMove,
  type ReplayerProps,
} from '../../src/ui/panels/replayer.ts';
import { cleanup, click, keydown, mount, need } from './helpers.ts';

const MOVES: ReplayerMove[] = [
  { ply: 1, side: 'black', notation: 'H8', ai: { ch: 'proxy', conf: 0.7, ms: 812, tv: 'v3' } },
  { ply: 2, side: 'white', notation: 'I9' },
  { ply: 3, side: 'black', notation: 'G7' },
];

const INFO: ReplayerProps['info'] = {
  gameUid: 'uid-1',
  name: '五子棋',
  day: '2026-09-30T05:07:00',
  game: 'gomoku',
  mode: 'human-ai',
  result: '黑方 获胜（五连）',
  exported: '2026-09-30T05:07:00',
  moveCount: 3,
  codeVersion: 'code-9',
  blackChannel: 'proxy',
  whiteChannel: 'rapfi',
};

/* 挂载点：面板会覆写 root.className，所以用 mount() 自己造宿主 div，并把它的返回值当 root。
 * `HOST` 是本用例的挂载点（`afterEach(cleanup)` 会摘掉它；不传 root 的用例自己 mount）。 */
let HOST: HTMLElement;

function rootOf(): HTMLElement {
  if (!HOST || !HOST.isConnected) HOST = mount('');
  return HOST;
}

function panel(): HTMLElement {
  return need(rootOf().querySelector<HTMLElement>('.rp-panel'));
}

function rows(): HTMLElement[] {
  return Array.from(rootOf().querySelectorAll<HTMLElement>('.rp-move'));
}

function btn(title: string): HTMLButtonElement {
  return need(rootOf().querySelector<HTMLButtonElement>('.rp-btn[title="' + title + '"]'), title);
}

function rangeEl(): HTMLInputElement {
  return need(rootOf().querySelector<HTMLInputElement>('.rp-range'));
}

afterEach(cleanup);

describe('renderReplayer —— 头部元信息', () => {
  it('七个元信息段：棋种/日期/模式/结果/手数/渠道/版本', () => {
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 2 });

    expect(need(panel().querySelector('.rp-title')).textContent).toBe('五子棋');
    const items = Array.from(rootOf().querySelectorAll<HTMLElement>('.rp-meta-item'));
    expect(items.map((n) => need(n.querySelector('i')).textContent)).toEqual([
      '日期', '模式', '结果', '手数', '渠道', '版本',
    ]);
    expect(need(items[0]!.querySelector('b')).textContent).toBe('2026-09-30 05:07');
    expect(need(items[1]!.querySelector('b')).textContent).toBe('人机');
    expect(need(items[3]!.querySelector('b')).textContent).toBe('3');
    expect(need(items[4]!.querySelector('b')).textContent).toBe('黑:proxy / 白:rapfi');
    expect(need(items[5]!.querySelector('b')).textContent).toBe('code-9');
  });

  it('缺值显示「未知」，渠道两边都缺时整段省略', () => {
    renderReplayer({ root: rootOf(), info: { moveCount: 0 }, moves: [] });

    expect(need(panel().querySelector('.rp-title')).textContent).toBe('未知');
    const items = Array.from(rootOf().querySelectorAll<HTMLElement>('.rp-meta-item'));
    expect(items.length).toBe(4);
    expect(items.map((n) => need(n.querySelector('b')).textContent)).toEqual(['未知', '未知', '未知', '0']);
  });
});

describe('renderReplayer —— 着法列表', () => {
  it('每手一行（手数/执子方/着法），当前手带 is-cur', () => {
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 2 });

    const list = rows();
    expect(list.length).toBe(3);
    expect(list.map((r) => need(r.querySelector('.rp-ply')).textContent)).toEqual(['01', '02', '03']);
    expect(list.map((r) => need(r.querySelector('.rp-side')).textContent)).toEqual(['black', 'white', 'black']);
    expect(list.map((r) => need(r.querySelector('.rp-notation')).textContent)).toEqual(['H8', 'I9', 'G7']);
    expect(list.map((r) => r.classList.contains('is-cur'))).toEqual([false, true, false]);
    expect(list[1]!.getAttribute('aria-current')).toBe('true');
  });

  it('点着法行 → onPlyChange(该行手数)', () => {
    const seen: number[] = [];
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 1, handlers: { onPlyChange: (p) => seen.push(p) } });
    click(rows()[2]);
    expect(seen).toEqual([3]);
  });
});

describe('renderReplayer —— 控制条边界', () => {
  it('ply=0：首手/上一手 disabled，下一手/末手可用', () => {
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 0 });
    expect(btn('首手').disabled).toBe(true);
    expect(btn('上一手').disabled).toBe(true);
    expect(btn('下一手').disabled).toBe(false);
    expect(btn('末手').disabled).toBe(false);
    expect(rangeEl().min).toBe('0');
    expect(rangeEl().max).toBe('3');
    expect(rangeEl().value).toBe('0');
    expect(need(rootOf().querySelector('.rp-pos')).textContent).toBe('0/3');
  });

  it('ply=moveCount：下一手/末手 disabled；ply 越界被 clamp 进 [0,moveCount]', () => {
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 3 });
    expect(btn('下一手').disabled).toBe(true);
    expect(btn('末手').disabled).toBe(true);
    expect(btn('上一手').disabled).toBe(false);

    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 99 });
    expect(need(rootOf().querySelector('.rp-pos')).textContent).toBe('3/3');

    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: -5 });
    expect(need(rootOf().querySelector('.rp-pos')).textContent).toBe('0/3');
  });

  it('控制条与滑杆都只经 onPlyChange 出参', () => {
    const seen: number[] = [];
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 2, handlers: { onPlyChange: (p) => seen.push(p) } });
    click(btn('上一手'));
    click(btn('下一手'));
    click(btn('首手'));
    click(btn('末手'));
    expect(seen).toEqual([1, 3, 0, 3]);

    seen.length = 0;
    const range = rangeEl();
    range.value = '1';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(seen).toEqual([1]);
  });

  it('滑杆出参越界时被 clamp', () => {
    const seen: number[] = [];
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 2, handlers: { onPlyChange: (p) => seen.push(p) } });
    const range = rangeEl();
    range.value = '999';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(seen).toEqual([3]);
  });
});

describe('renderReplayer —— 键盘', () => {
  /* 在面板内部真实的可聚焦节点上派发：模拟「焦点在面板里按方向键」。
   * 为什么不用 root：root 的 keydown 监听在 root 自身派发时命中，在内部节点上派发时靠冒泡命中，
   * 两条路径都覆盖（下面两条用例各走一条）。 */
  function pressOn(node: HTMLElement, key: string): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    node.dispatchEvent(ev);
    return ev;
  }

  it('←/→ 改手并 preventDefault；边界方向不出参', () => {
    const seen: number[] = [];
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 1, handlers: { onPlyChange: (p) => seen.push(p) } });
    const focusable = rows()[1]!;

    const right = pressOn(focusable, 'ArrowRight');
    expect(seen).toEqual([2]);
    expect(right.defaultPrevented).toBe(true);

    const left = pressOn(focusable, 'ArrowLeft');
    expect(seen).toEqual([2, 0]);
    expect(left.defaultPrevented).toBe(true);

    /* 其它键不参与，也不 preventDefault */
    const other = pressOn(focusable, 'Enter');
    expect(seen).toEqual([2, 0]);
    expect(other.defaultPrevented).toBe(false);

    /* ply=0 时 ← 不改手（左右方向都不出参） */
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 0, handlers: { onPlyChange: (p) => seen.push(p) } });
    pressOn(rows()[0]!, 'ArrowLeft');
    expect(seen).toEqual([2, 0]);
  });

  it('根节点是 tabindex=0 的可聚焦容器；焦点在根上时键盘也生效', () => {
    const seen: number[] = [];
    const props: ReplayerProps = { root: rootOf(), info: INFO, moves: MOVES, ply: 1, handlers: { onPlyChange: (p) => seen.push(p) } };
    renderReplayer(props);
    const root = rootOf();
    expect(root.getAttribute('tabindex')).toBe('0');
    expect(root.getAttribute('role')).toBe('group');
    root.focus();
    expect(document.activeElement).toBe(root);

    /* 焦点在根上（还没点到面板内部）时按键也要生效 */
    const ev = pressOn(root, 'ArrowRight');
    expect(seen).toEqual([2]);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('renderReplayer —— 棋盘注入与分享', () => {
  it('renderBoard 每次 render 拿到新建的宿主与当前 ply', () => {
    const hosts: HTMLElement[] = [];
    const plies: number[] = [];
    const props: ReplayerProps = {
      root: rootOf(),
      info: INFO,
      moves: MOVES,
      ply: 1,
      renderBoard: (host, ply) => {
        hosts.push(host);
        plies.push(ply);
      },
    };
    renderReplayer(props);
    renderReplayer({ ...props, ply: 2 });

    expect(plies).toEqual([1, 2]);
    expect(hosts.length).toBe(2);
    expect(hosts[0]).not.toBe(hosts[1]);
    expect(hosts[0]!.isConnected).toBe(false);
    expect(need(rootOf().querySelector('.rp-board'))).toBe(hosts[1]);
    expect(hosts[1]!.parentElement).toBe(panel());

    /* 不给 renderBoard 就不是棋盘绘制器，不造空宿主 */
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 1 });
    expect(rootOf().querySelector('.rp-board')).toBeNull();
  });

  it('分享按钮只在 gameUid 非空时出现，回调带 uid', () => {
    const seen: string[] = [];
    renderReplayer({ root: rootOf(), info: INFO, moves: MOVES, ply: 0, handlers: { onShare: (uid) => seen.push(uid) } });
    const share = need(rootOf().querySelector<HTMLButtonElement>('.rp-share'));
    expect(share.textContent).toBe('分享');
    click(share);
    expect(seen).toEqual(['uid-1']);

    renderReplayer({ root: rootOf(), info: { ...INFO, gameUid: null }, moves: MOVES, ply: 0, handlers: { onShare: (uid) => seen.push(uid) } });
    expect(rootOf().querySelector('.rp-share')).toBeNull();
    expect(seen).toEqual(['uid-1']);
  });
});

describe('renderReplayer —— 幂等', () => {
  it('连渲两次：DOM 不翻倍、监听不重复触发', () => {
    const seen: number[] = [];
    const props: ReplayerProps = { root: rootOf(), info: INFO, moves: MOVES, ply: 1, handlers: { onPlyChange: (p) => seen.push(p) } };
    renderReplayer(props);
    renderReplayer(props);

    expect(rootOf().querySelectorAll('.rp-panel').length).toBe(1);
    expect(rootOf().querySelectorAll('.rp-move').length).toBe(3);
    expect(rootOf().querySelectorAll('.rp-btn').length).toBe(4);
    expect(rootOf().querySelectorAll('.rp-range').length).toBe(1);
    expect(rootOf().querySelectorAll('.rp-share').length).toBe(1);
    expect(rootOf().querySelectorAll('.rp-meta-item').length).toBe(6);

    click(btn('下一手'));
    /* 调用方把 ply 更新到 2 后再渲一次：结构不翻倍，新监听用的是新闭包 */
    renderReplayer({ ...props, ply: 2 });
    keydown(rows()[2]!, 'ArrowRight');
    expect(seen).toEqual([2, 3]);
    expect(panel().querySelectorAll('.rp-move').length).toBe(3);
  });
});

describe('replayerInfoOf —— 纯函数降级', () => {
  it('完整 payload：字段逐个映射', () => {
    const info = replayerInfoOf({
      game: '五子棋',
      gameId: 'gomoku',
      gid: 'gomoku',
      mode: 'human-ai',
      result: '黑方 获胜（五连）',
      exported: '2026-09-30T05:07:00',
      day: '2026-09-29',
      gameUid: 'uid-9',
      blackChannel: 'proxy',
      whiteChannel: 'rapfi',
      moves: MOVES,
      meta: { code: 'abc123' },
      notation: 'H8,I9,G7,',
    });
    expect(info).toEqual({
      gameUid: 'uid-9',
      name: '五子棋',
      day: '2026-09-29',
      game: 'gomoku',
      mode: 'human-ai',
      result: '黑方 获胜（五连）',
      exported: '2026-09-30T05:07:00',
      moveCount: 3,
      codeVersion: 'abc123',
      blackChannel: 'proxy',
      whiteChannel: 'rapfi',
    });
  });

  it('moves 非数组：用 notation 兜底算手数', () => {
    expect(replayerInfoOf({ notation: 'H8,I9,G7,' }).moveCount).toBe(3);
    expect(replayerInfoOf({ notation: ' H8 , ,I9 ,' }).moveCount).toBe(2);
    expect(replayerInfoOf({ moves: 'H8,I9,G7', notation: 'H8,I9' }).moveCount).toBe(2);
    expect(replayerInfoOf({ moves: {} }).moveCount).toBe(0);
    expect(replayerInfoOf({ moves: [], notation: 'H8,I9' }).moveCount).toBe(0);
  });

  it('payload 不是对象 / 缺字段：全部降级为 null 或 0，不抛异常', () => {
    for (const bad of [null, undefined, 'oops', 42, [1, 2]]) {
      const info = replayerInfoOf(bad);
      expect(info.moveCount).toBe(0);
      expect(info.gameUid).toBeNull();
      expect(info.name).toBeNull();
      expect(info.day).toBeNull();
      expect(info.mode).toBeNull();
    }
    const empty = replayerInfoOf({});
    expect(empty).toEqual({
      gameUid: null, name: null, day: null, game: null, mode: null, result: null,
      exported: null, moveCount: 0, codeVersion: null, blackChannel: null, whiteChannel: null,
    });
  });

  it('缺 game 时用 gameId/gid 换算中文名；day 缺值退回 exported；opts.gameUid 优先', () => {
    const a = replayerInfoOf({ gameId: 'xiangqi', exported: '2026-10-02T01:02:00' });
    expect(a.name).toBe('象棋');
    expect(a.day).toBe('2026-10-02T01:02:00');
    expect(a.game).toBe('xiangqi');

    const b = replayerInfoOf({ gid: 'gomoku-pro' }, { gameUid: 'from-opts' });
    expect(b.name).toBe('五子棋·禁手');
    expect(b.gameUid).toBe('from-opts');

    const c = replayerInfoOf({ gameId: 'nope' }, { gameUid: 'u2' });
    expect(c.name).toBe('nope');
    expect(replayerInfoOf({ gameUid: 'in-payload' }, { gameUid: null }).gameUid).toBe('in-payload');
  });
});
