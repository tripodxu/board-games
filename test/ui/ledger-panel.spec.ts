/* ledger-panel.spec.ts — 棋谱面板（#ledger）的全量重建契约
 *
 * 2026-10-28 收口修的一个真 bug：`rebuildLedger()` 曾把 `#ledger` 自己当查询根传给
 * `appendLedgerLine()` ⇒ `qs(ledger, '#ledger')` 查的是后代、恒为 null ⇒ **清空后一行也填不回来**。
 * 触发面很宽：每局第一手（`loop.playMove` 的 `history.length === 1` 走全量重建）、
 * 悔棋、换局、换禁手规则（`loop.ts` 的 `renderLedgerPanel`）。
 *
 * 这里不需要真跑对局：直接喂 `SessionMove[]`，断言「重建之后行还在」。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMove } from '../../src/core/session.ts';
import { appendLedgerLine, rebuildLedger } from '../../src/ui/panels/cockpit.ts';
import { cleanup, mount, need } from './helpers.ts';

const LEDGER_HTML = '<div class="panel"><div id="ledger">对局开始后，每一手的记法会记在这里。</div></div>';

function mv(ply: number, notation: string, byAI = false): SessionMove {
  return {
    ply,
    side: ply % 2 ? 'black' : 'white',
    move: { notation, desc: notation } as SessionMove['move'],
    meta: byAI ? ({ byAI: true } as SessionMove['meta']) : null,
  };
}

afterEach(cleanup);

describe('棋谱面板 #ledger', () => {
  it('全量重建 3 手：清掉空态并真的把每一行填回来（含首手）', () => {
    const host = mount(LEDGER_HTML);
    const ledger = need(host.querySelector<HTMLElement>('#ledger'), '#ledger');

    rebuildLedger([mv(1, 'H8'), mv(2, 'I9'), mv(3, 'H9', true)]);

    const rows = ledger.querySelectorAll('div');
    expect(rows.length).toBe(3);
    expect(ledger.textContent).not.toContain('对局开始后');
    expect(ledger.textContent).toContain('1.');
    expect(ledger.textContent).toContain('H8');
    expect(ledger.textContent).toContain('Jev');
  });

  it('空历史 → 只留空态占位，不留残行', () => {
    const host = mount(LEDGER_HTML);
    const ledger = need(host.querySelector<HTMLElement>('#ledger'), '#ledger');
    rebuildLedger([mv(1, 'H8')]);

    rebuildLedger([]);

    expect(ledger.childElementCount).toBe(1);
    expect(need(ledger.firstElementChild, 'empty state').className).toBe('ledger-empty');
  });

  it('重建是幂等的：同一份历史连调两次不会翻倍', () => {
    mount(LEDGER_HTML);
    const moves = [mv(1, 'H8'), mv(2, 'I9')];

    rebuildLedger(moves);
    rebuildLedger(moves);

    const ledger = need(document.querySelector<HTMLElement>('#ledger'), '#ledger');
    expect(ledger.querySelectorAll('div').length).toBe(2);
  });

  it('增量追加仍然工作：先重建 1 手，再追加第 2 手', () => {
    mount(LEDGER_HTML);
    rebuildLedger([mv(1, 'H8')]);
    appendLedgerLine(mv(2, 'I9'));

    const ledger = need(document.querySelector<HTMLElement>('#ledger'), '#ledger');
    expect(ledger.querySelectorAll('div').length).toBe(2);
    expect(ledger.textContent).toContain('I9');
  });
});
