// scripts/lib/loss-report.mjs 的单测：败局归纳 + 必败后缀 + markdown 渲染。
// 纯函数层不碰引擎、不碰磁盘 —— 必败标记由用例直接构造（引擎探针在 CLI 侧）。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/loss-report.mjs';
import { SHORT_LOSS_PLIES, fatalSuffix, formatLossMarkdown, lossShape } from '../../scripts/lib/loss-report.mjs';

/** 造一局归一化后的对局行（形状与 scripts/loss-report.mjs 产出一致）。 */
function game(over = {}) {
  return {
    identity: 'official|v11-vct|0',
    opponent: 'rapfi||500',
    result: 'win',
    plies: 30,
    endReason: '五连',
    lastLayer: null,
    suffix: null,
    ...over,
  };
}
const lossWith = (count, plies = []) => game({ result: 'loss', plies: 60, lastLayer: 'block', suffix: { count, plies } });

describe('fatalSuffix', () => {
  it('取最长必败后缀，`at` 指向该后缀第一手', () => {
    expect(fatalSuffix([false, false, true, true, true])).toEqual({ start: 2, count: 3, at: 2 });
  });

  it('全部为真 ⇒ 整段都是后缀（早就必败）', () => {
    expect(fatalSuffix([true, true, true, true])).toEqual({ start: 0, count: 4, at: 0 });
  });

  it('尾手才必败 ⇒ count = 1（突然崩）', () => {
    expect(fatalSuffix([false, false, false, true])).toEqual({ start: 3, count: 1, at: 3 });
  });

  it('没有必败标记 ⇒ count = 0、start = null', () => {
    expect(fatalSuffix([false, false])).toEqual({ start: null, count: 0, at: 2 });
    expect(fatalSuffix([])).toEqual({ start: null, count: 0, at: 0 });
  });

  it('中间断开的必杀不算后缀（「VCF 出现又被堵掉」的局）', () => {
    expect(fatalSuffix([true, false, true])).toEqual({ start: 2, count: 1, at: 2 });
  });

  it('非数组输入按空处理', () => {
    expect(fatalSuffix(undefined)).toEqual({ start: null, count: 0, at: 0 });
  });
});

describe('lossShape', () => {
  const rows = [
    game({ result: 'win', plies: 25 }),
    game({ result: 'win', plies: 35 }),
    game({ result: 'draw', plies: 225, endReason: '棋盘已满' }),
    lossWith(1, [{ ply: 57, layer: 'parry' }]),
    lossWith(3, [{ ply: 51, layer: 'block' }, { ply: 53, layer: 'block' }, { ply: 55, layer: 'block' }]),
    lossWith(0),
  ];
  const s = lossShape(rows);

  it('盘点与不败率', () => {
    expect([s.games, s.w, s.d, s.l]).toEqual([6, 2, 1, 3]);
    expect(s.unbeatenRate).toBeCloseTo(3 / 6, 6);
  });

  it('手数三形态分开统计', () => {
    expect(s.win.plies.mean).toBe(30);
    expect(s.draw.plies.median).toBe(225);
    expect(s.loss.plies.mean).toBe(60);
  });

  it('短败计数用 SHORT_LOSS_PLIES 阈值', () => {
    const short = lossShape([game({ result: 'loss', plies: 20 }), game({ result: 'loss', plies: SHORT_LOSS_PLIES })]);
    expect(short.loss.short).toBe(2);
    expect(short.loss.shortPlies).toBe(SHORT_LOSS_PLIES);
    const notShort = lossShape([game({ result: 'loss', plies: SHORT_LOSS_PLIES + 1 })]);
    expect(notShort.loss.short).toBe(0);
  });

  it('败局最后一手与终局方式各自成表（按次数降序）', () => {
    expect(s.lossLastLayers).toEqual([['block', 3]]);
    expect(s.lossEndReasons).toEqual([['五连', 3]]);
    expect(s.draw.endReasons).toEqual([['棋盘已满', 1]]);
  });

  it('必败后缀分桶：1/2/3/4+ 与查不到', () => {
    const buckets = lossShape([
      lossWith(1), lossWith(2), lossWith(3), lossWith(4), lossWith(9), lossWith(0),
    ]);
    expect(buckets.suffix.buckets).toEqual({ 1: 1, 2: 1, 3: 1, '4+': 2 });
    expect(buckets.suffix.none).toBe(1);
    expect(buckets.suffix.known).toBe(6);
  });

  it('不可逆点只从「后缀第一手」取，并统计那一刻的层', () => {
    const x = lossShape([lossWith(3, [{ ply: 51, layer: 'block' }, { ply: 53, layer: 'block' }, { ply: 55, layer: 'block' }])]);
    expect(x.lostFrom.found).toBe(1);
    expect(x.lostFrom.plies.min).toBe(51);
    expect(x.lostFrom.plies.max).toBe(51);
    expect(x.lostFrom.layers).toEqual([['block', 1]]);
  });

  it('没跑引擎（suffix = null）时不计入后缀统计，也不崩', () => {
    const x = lossShape([game({ result: 'loss', plies: 44 })]);
    expect(x.suffix.known).toBe(0);
    expect(x.lostFrom.found).toBe(0);
    expect(x.loss.n).toBe(1);
  });

  it('按身份再切一刀（升序、每身份自带不败率与后缀）', () => {
    const x = lossShape([
      game({ identity: 'official|v13-pressure-gate|0', result: 'loss', lastLayer: 'block', suffix: { count: 1, plies: [] } }),
      game({ identity: 'official|v11-vct|0', result: 'win' }),
      game({ identity: 'official|v11-vct|0', result: 'draw', endReason: '棋盘已满' }),
    ]);
    expect(x.byIdentity.map((r) => r.identity)).toEqual(['official|v11-vct|0', 'official|v13-pressure-gate|0']);
    expect(x.byIdentity[0]).toMatchObject({ games: 2, w: 1, d: 1, l: 0 });
    expect(x.byIdentity[0].unbeatenRate).toBe(1);
    expect(x.byIdentity[1].lossSuffix).toMatchObject({ known: 1, 1: 1, none: 0 });
  });

  it('空输入不崩、不败率为 null', () => {
    const x = lossShape([]);
    expect([x.games, x.l, x.unbeatenRate]).toEqual([0, 0, null]);
  });
});

describe('formatLossMarkdown', () => {
  const md = formatLossMarkdown(lossShape([
    game({ result: 'win', plies: 25 }),
    game({ result: 'draw', plies: 225, endReason: '棋盘已满' }),
    game({
      identity: 'official|v11-vct|0',
      result: 'loss',
      plies: 60,
      lastLayer: 'block',
      endReason: '五连',
      suffix: { count: 2, plies: [{ ply: 57, layer: 'block' }, { ply: 59, layer: 'block' }] },
    }),
  ]), { label: 'L2', plies: 9 });

  it('印形态/追因/不可逆点三块数字', () => {
    expect(md).toContain('### 败局解释（规则 11）L2：');
    expect(md).toContain('3 局 = 1 胜 / 1 和 / 1 负');
    expect(md).toContain('最后一手走的层 block 1');
    expect(md).toContain('隔 2 手 1 局');
    expect(md).toContain('1/1 局能定位');
    expect(md).toContain('那一刻我方走的层 block 1');
  });

  it('边界句一定印（VCF 只解释 x/y，查不到 ≠ 没输在更早）', () => {
    expect(md).toContain('VCF 只解释 1/1 局');
    expect(md).toContain('不能读成「没输在更早的地方」');
  });

  it('短败按阈值提示，和棋终局方式单独一行', () => {
    expect(md).toContain('短败 0 局');
    expect(md).toContain('**和棋形态**：终局方式 棋盘已满 1');
  });

  it('多身份时出逐身份表；单身份不出表', () => {
    const one = formatLossMarkdown(lossShape([game({ result: 'win' })]), {});
    expect(one).not.toContain('| 身份 |');
    const two = formatLossMarkdown(lossShape([
      game({ result: 'loss' }),
      game({ identity: 'official|v13-pressure-gate|0', result: 'loss' }),
    ]), {});
    expect(two).toContain('| 身份 | 局 | 胜–和–负 |');
    expect(two).toContain('`official|v13-pressure-gate|0`');
  });

  it('--no-vcf 形态（suffix.known = 0）不印追因与不可逆点两行', () => {
    const md2 = formatLossMarkdown(lossShape([game({ result: 'loss' })]), {});
    expect(md2).not.toContain('追因（逐手问对手');
    expect(md2).not.toContain('不可逆点');
    expect(md2).toContain('VCF 只解释 0/1 局');
  });

  it('自定义边界补充句会追加在边界行', () => {
    const md3 = formatLossMarkdown(lossShape([game({ result: 'loss' })]), { note: '同门对局另算。' });
    expect(md3).toContain('同门对局另算。');
  });
});

// CLI 层：只测口径与闸门（`--no-vcf` ⇒ 不跑引擎，夹具是最小归档形状）。
describe('scripts/loss-report.mjs（CLI）', () => {
  /** 最小归档：黑 official 对白 official（同门）或对白 rapfi；winner 写 'black'|'white'。 */
  function archive({ black = 'official', white = 'official', winner = 'black', moves = 4, layer = 'block' } = {}) {
    return {
      blackChannel: black, whiteChannel: white,
      blackTactics: black === 'official' ? 'v11-vct' : null,
      whiteTactics: white === 'official' ? 'v11-vct' : null,
      blackThink: 0, whiteThink: white === 'rapfi' ? 500 : 0,
      winner, endReason: '五连',
      moves: Array.from({ length: moves }, (_, i) => ({
        ply: i + 1, side: i % 2 === 0 ? '黑方' : '白方', notation: 'H8', tactics: layer,
      })),
    };
  }
  function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loss-report-'));
    for (const [name, obj] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
    return dir;
  }
  async function run(argv) {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      return { code: await main(argv), out: lines.join('\n') };
    } finally { console.log = orig; }
  }

  /** `main()` 是同步函数：抛错在调用点，用 try/catch 抓（`rejects` 只适用于异步）。 */
  function caught(argv) {
    try { main(argv); return null; } catch (err) { return err; }
  }

  it('无参数 ⇒ 用法错误（exitCode 2）', () => {
    const err = caught([]);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/要么给 --dir/);
    expect(err.exitCode).toBe(2);
  });

  it('目录不存在 / 裸 --json / 坏 --plies 都是 exitCode 2', () => {
    const missing = caught(['--dir', path.join(os.tmpdir(), 'loss-report-missing-xyz')]);
    expect(missing.message).toMatch(/目录不存在/);
    expect(missing.exitCode).toBe(2);
    const bareJson = caught(['--dir', '.', '--json']);
    expect(bareJson.message).toMatch(/--json 需要一个输出路径/);
    expect(bareJson.exitCode).toBe(2);
    const badPlies = caught(['--dir', '.', '--plies', '0']);
    expect(badPlies.message).toMatch(/--plies 必须是正整数/);
    expect(badPlies.exitCode).toBe(2);
  });

  it('--help 打文档头并返回 0', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('败局解释（AGENTS.md 规则 11）');
  });

  it('默认跳过同门对局（skipped.mirror），只收 official vs rapfi 那一局', async () => {
    const dir = fixture({
      'same.json': archive({ winner: 'black' }),
      'mixed.json': archive({ white: 'rapfi', winner: 'white' }),
    });
    const r = await run(['--dir', dir, '--no-vcf', '--quiet']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 局 = 0 胜 / 0 和 / 1 负');
    expect(r.out).toContain('"mirror":1');
    expect(r.out).toContain('不可逆点 0 局');
  });

  it('--mirror 让同门对局两侧各出一个视角（棋谱 2 局 ⇒ 3 个视角）', async () => {
    const dir = fixture({
      'same.json': archive({ winner: 'black' }),
      'mixed.json': archive({ white: 'rapfi', winner: 'white' }),
    });
    const r = await run(['--dir', dir, '--mirror', '--no-vcf', '--quiet']);
    expect(r.out).toContain('3 局 = 1 胜 / 0 和 / 2 负');
    expect(r.out).toContain('"mirror":0');
    expect(r.out).toContain('"noOurs":0');
  });

  it('--max-games 截断读取（按文件名排序）', async () => {
    const dir = fixture({
      'a.json': archive({ white: 'rapfi', winner: 'white' }),
      'b.json': archive({ white: 'rapfi', winner: 'black' }),
    });
    const r = await run(['--dir', dir, '--no-vcf', '--quiet', '--max-games', '1']);
    expect(r.out).toContain('1 局 = 0 胜 / 0 和 / 1 负');
  });

  it('markdown 正文默认打印，含追因边界句（--no-vcf 时 known = 0）', async () => {
    const dir = fixture({ 'mixed.json': archive({ white: 'rapfi', winner: 'white' }) });
    const r = await run(['--dir', dir, '--no-vcf']);
    expect(r.out).toContain('### 败局解释（规则 11）');
    expect(r.out).toContain('VCF 只解释 0/1 局');
  });
});
