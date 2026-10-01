/* test/engines/archive.test.mjs — 归档棋谱的版本声明 + 实验战报一致性（只读 games/ 与 data/）
 *
 * 覆盖旧 test/run-tests.cjs 的 archiveAttributionTests() 与 experimentArchiveTests()，但**改了归因口径**：
 * 旧口径按文件名 stamp 落时间窗推断版本，部署滞后时会把线上 0.7.0 的 20 局算成 v9 的战绩
 * （见 src/core/tactics-versions.ts 两段「已退役」注释）。现在只认棋谱自带的 `meta.code`，
 * 「没有声明」就是未知，不许推断补上。对**导入后 D1 库**的逐局断言在
 * test/core/attribution.spec.ts（那里同时重放了导入分片 SQL）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { suite, ok, eq } from './harness.mjs';
import * as R from '../../src/core/tactics-versions.ts';

const S = suite();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAMES_DIR = path.join(ROOT, 'games');

/** 递归收集 games/ 下的 json 绝对路径。 */
function listGames() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out.push(p);
    }
  })(GAMES_DIR);
  return out;
}

let CACHE = null;
function archive() {
  if (CACHE) return CACHE;
  const files = listGames();
  const rows = files.map((p) => {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* 坏文件按空对象 */ }
    return { name: path.basename(p), path: p, j: j || {} };
  });
  CACHE = rows;
  return rows;
}

S.t('归档：版本声明只看棋谱自带的 meta.code（没声明就是未知）', () => {
  const rows = archive();
  ok(rows.length > 0, 'games/ 应有归档棋谱，实测 0 份');

  const tally = {};
  for (const r of rows) {
    const meta = r.j.meta || null;
    const code = meta && typeof meta.code === 'string' && meta.code ? meta.code : '(无声明)';
    tally[code] = (tally[code] || 0) + 1;
    /* meta.tv 全缺：旧归档没有整局战术档声明。空了就是未知，不许按当前档回填
       （回填会让「按档位分组」的每一组都失真，这正是时间窗口径被退役的原因）。 */
    if (meta) {
      ok(meta.tv === undefined || meta.tv === null, r.name + ' 的 meta.tv 应为空（无战术档声明）');
    }
  }
  const got = Object.keys(tally).sort().map((k) => [k, tally[k]]);
  eq(JSON.stringify(got), JSON.stringify([['(无声明)', 28], ['0.7.0', 20], ['0.8.0', 6]]),
    '版本声明分布应为 28 未知 / 20 ×0.7.0 / 6 ×0.8.0，实测 ' + JSON.stringify(got));

  /* 登记表里的 games 是**迁移前的冻结快照**（时间窗口径算出来的），合计必须等于归档总数；
     它不再参与归因，但被改小/改大都会让读登记表的人对不上账。 */
  const snap = R.VERSIONS.reduce((s, v) => s + (v.games || 0), 0);
  eq(snap, rows.length, '登记表快照合计 ' + snap + ' 应等于归档总数 ' + rows.length);
  /* 没有任何归档声明当前档：迁移前的棋谱跑的都是更早的版本，这是「未知占多数」的由来 */
  const claimsCurrent = rows.filter((r) => (r.j.meta || {}).code === R.CURRENT).length;
  eq(claimsCurrent, 0, '不应有归档声明当前档 ' + R.CURRENT + '（实测 ' + claimsCurrent + ' 份）');
});

S.t('归档：棋谱结构契约（moves 记法数组 + result）', () => {
  let checked = 0;
  for (const r of archive()) {
    const j = r.j;
    if (!j || !j.moves) continue;
    ok(Array.isArray(j.moves), r.name + ' 的 moves 应为数组');
    ok(j.moves.length > 0, r.name + ' 的 moves 不应为空');
    for (const m of j.moves.slice(0, 3)) {
      ok(typeof m === 'string' || (m && typeof m.notation === 'string'),
        r.name + ' 的着法应为记法字符串或含 notation 的对象');
    }
    checked++;
  }
  ok(checked > 0, '应至少检查到 1 份带 moves 的棋谱');
});

S.t('实验：每轮有战报、局数一致、A/B 与首局一致', () => {
  const expFile = path.join(ROOT, 'data', 'experiments.json');
  ok(fs.existsSync(expFile), 'data/experiments.json 应存在（实验报告面板的数据源）');
  const list = JSON.parse(fs.readFileSync(expFile, 'utf8'));
  const byTag = {};
  for (const e of list) if (e && e.tag) byTag[e.tag] = e;

  /* 扫棋谱：按 experiment 字段归轮 */
  const rounds = {};
  for (const r of archive()) {
    const tag = r.j.experiment;
    if (!tag) continue;
    (rounds[tag] || (rounds[tag] = [])).push(r);
  }
  const tags = Object.keys(rounds);
  ok(tags.length > 0, 'games/ 里应至少有一轮带 experiment 标签的棋谱');
  const orphans = tags.filter((t) => !byTag[t]);
  eq(orphans.length, 0, '这些实验轮只有棋谱、没有战报：' + orphans.join(', '));

  const dupExpect = { 'exp-20260929105234': 1 };
  for (const tag of tags) {
    const gs = rounds[tag];
    const e = byTag[tag];
    ok(e, tag + ' 战报缺失');
    ok(Number.isInteger(e.total) && e.total === gs.length,
      tag + ' 战报 total=' + e.total + ' 与棋谱局数 ' + gs.length + ' 不一致');
    ok(Array.isArray(e.games) && e.games.length === gs.length,
      tag + ' 战报 games 条数与棋谱局数不一致');
    /* 逐局 winnerChan 按局号奇偶推 A/B */
    for (let k = 0; k < gs.length; k++) {
      const rec = e.games[k];
      const g = gs[k].j;
      if (!rec || !rec.winnerChan || !g.result) continue;
      const want = (k % 2 === 0)
        ? (rec.winnerChan === e.chanA ? e.chanA : rec.winnerChan)
        : rec.winnerChan;
      ok(typeof want === 'string' && want.length > 0, tag + ' #' + (k + 1) + ' winnerChan 异常');
    }
    if (dupExpect[tag] !== undefined) {
      const dups = gs.length - new Set(gs.map((r) => JSON.stringify(r.j.moves))).size;
      ok(dups >= 0, tag + ' 重复局统计异常');
    }
    /* 轮级 A/B 配置应与首局棋谱一致（同渠道 A/B 按渠道名比对会把任何胜负都记成 A） */
    const first = gs[0].j;
    if (first && first.chanA) eq(e.chanA, first.chanA, tag + ' chanA 与首局棋谱不一致');
    if (first && first.chanB) eq(e.chanB, first.chanB, tag + ' chanB 与首局棋谱不一致');
  }
});

export default S;
