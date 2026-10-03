/* rapfi-parity-probe.mjs — P4 强度 gate：Node Rapfi vs 浏览器 Rapfi 逐手一致率。
 *
 * 为什么要这个 gate：远端批量实验的 rapfi 臂没有浏览器，胶水换成 Node 实现
 * （scripts/lib/rapfi-node-loader.mjs）。两边走的是同一条 core 协议代码，但
 * Emscripten 运行环境不同（Node 无 document、按 __dirname 定位资产），且
 * INFO timeout_turn 是墙钟驱动的搜索——必须证明 Node 侧不退化，否则实验结论
 * （Rapfi vs Jev）不可信。
 *
 * 做法（用线上归档当浏览器侧的真值）：
 *   1. GET /api/games?tag=<tag> 拉归档局（只读，不需要 key）；
 *   2. 逐局按 notation 重放，走到 rapfi 那一侧时用 Node rapfi 以相同 thinkMs 决策；
 *   3. 比较引擎着法与归档着法，报一致率与不一致手明细。
 *
 * 注意（gate 的口径）：
 *   - 归档的 blackThink/whiteThink 可能为 null（浏览器早期不记 rapfi 思考时长），
 *     所以 thinkMs 由 --think 指定（实验 tag 的强度以计划/ADR 记录为准）；
 *   - 判据是「一致率 ≥ --min（默认 0.99）」，不是 100%：墙钟计时 + 单线程
 *     节点数有天然浮动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getGame } from '../src/core/registry.ts';
import { decide } from '../src/core/jev/index.ts';
import { installRapfiNodeLoader, smokeTest } from './lib/rapfi-node-loader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { tags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag') out.tags.push(String(argv[++i]));
    else if (a === '--think') out.think = Number(argv[++i]);
    else if (a === '--min') out.min = Number(argv[++i]);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--file') out.files = out.files || [], out.files.push(String(argv[++i]));
    else if (a === '--json') out.json = String(argv[++i]);
    else if (a === '--no-smoke') out['no-smoke'] = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function fetchGames(origin, tag, limit) {
  const r = await fetch(`${origin}/api/games?tag=${encodeURIComponent(tag)}&limit=${limit}`);
  if (!r.ok) throw new Error(`GET /api/games?tag=${tag} → HTTP ${r.status}`);
  const j = await r.json();
  return j.games || [];
}

/** 重放一局，返回 { rapfiPlies, agree, diffs }。 */
async function replayGame(engine, game, rapfiSide, thinkMs) {
  let st = engine.newGame();
  const moves = String(game.notation || '').split(',').filter(Boolean);
  const sideOf = (i) => (i % 2 === 0 ? 'black' : 'white');
  let plies = 0, agree = 0;
  const diffs = [];
  for (let i = 0; i < moves.length; i++) {
    const side = sideOf(i);
    const expect = moves[i];
    if (side === rapfiSide) {
      plies++;
      const r = await decide(engine, st, side, { channel: 'rapfi', rapfiThinkMs: thinkMs });
      if (r.notation === expect) agree++;
      else diffs.push({ ply: i + 1, expect, got: r.notation });
    }
    const mv = engine.moveFromNotation(st, expect);
    if (!mv) throw new Error(`归档着法非法：${expect}（${game.gameUid || game.game_uid || '?'} ply ${i + 1}）`);
    st = engine.applyMove(st, mv);
  }
  return { rapfiPlies: plies, agree, diffs };
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help || (!argv.tags.length && !argv.files)) {
    console.log('用法：node scripts/rapfi-parity-probe.mjs --tag <experimentTag> [--think 500] [--min 0.99]');
    console.log('      [--limit 50] [--file <归档 json>] [--json out.json]');
    return;
  }
  const origin = 'https://jevqipan.logicc.top';
  const thinkMs = argv.think || 500;
  const min = argv.min === undefined ? 0.99 : argv.min;

  installRapfiNodeLoader();
  if (!argv['no-smoke']) {
    // 开局冒烟：胶水装不起来就直说，别过几十手才在 diffs 里看到「全都不一致」
    const smoke = await smokeTest();
    console.log(`rapfi 冒烟通过（${smoke.lines.length} 行输出）`);
  }
  const engine = getGame('gomoku');

  let games = [];
  for (const tag of argv.tags) {
    const g = await fetchGames(origin, tag, argv.limit || 50);
    console.log(`tag ${tag}：${g.length} 局`);
    games = games.concat(g.map((x) => ({ ...x, _tag: tag })));
  }
  for (const f of argv.files || []) {
    const list = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
    const arr = Array.isArray(list) ? list : list.games || [];
    games = games.concat(arr.map((x) => ({ ...x, _tag: x.experimentTag || '(file)' })));
  }
  /* 只保留有 rapfi 侧的局 */
  games = games.filter((g) => g.blackChannel === 'rapfi' || g.whiteChannel === 'rapfi');
  console.log(`rapfi 侧局数：${games.length}，thinkMs=${thinkMs}\n`);

  let totalPlies = 0, totalAgree = 0;
  const perGame = [];
  for (const g of games) {
    const side = g.blackChannel === 'rapfi' ? 'black' : 'white';
    const r = await replayGame(engine, g, side, thinkMs);
    totalPlies += r.rapfiPlies;
    totalAgree += r.agree;
    perGame.push({ uid: g.gameUid, side, tag: g._tag, ...r });
    console.log(`  ${g.gameUid} ${side}：${r.agree}/${r.rapfiPlies} 手一致` +
      (r.diffs.length ? ` 差异 ${r.diffs.map((d) => `#${d.ply} 期望${d.expect}/实得${d.got}`).join(' ')}` : ''));
  }
  const rate = totalPlies ? totalAgree / totalPlies : 0;
  console.log(`\n合计：${totalAgree}/${totalPlies} 手一致，一致率 ${(rate * 100).toFixed(2)}%（门槛 ${(min * 100).toFixed(0)}%）`);
  if (argv.json) {
    fs.writeFileSync(path.resolve(argv.json), JSON.stringify({ thinkMs, min, totalPlies, totalAgree, rate, perGame }, null, 2) + '\n');
    console.log('已写 ' + argv.json);
  }
  if (totalPlies === 0 || rate < min) {
    console.log('✗ gate 未过：Node Rapfi 与浏览器归档不一致率超限，需排查模型加载/协议差异后再开 rapfi 臂');
    process.exitCode = 1;
  } else {
    console.log('✓ gate 通过：Node Rapfi 与浏览器行为一致，可开 rapfi 臂');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
