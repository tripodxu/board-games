/**
 * 备份可重建性验证（`npm run verify:backup`，需先 `npm run db:export`）：
 * 把 `wrangler d1 export` 出来的 SQL 灌进内存 SQLite（`node:sqlite`），再与
 * `games/**` 源归档逐项对账 —— 证明这份备份真能重建整库，而不是「文件生成成功」。
 *
 * 校验：games 54 / game_moves 4379 / experiments 6 / devices 0 / distinct game_uid 54 /
 * sum(payload_bytes) 845578 / 孤儿明细 0，外加「每局 payload 逐字节等于源归档里的某个文件」
 * 与「每局 game_moves 行数 == games.move_count」。
 *
 * 两种模式：
 *   `node scripts/verify-backup.mjs [sql 路径]`              默认（严格）：绝对计数必须等于迁移基线，
 *                                                            每一局都必须能在 `games/<day>/` 找到源文件。
 *   `node scripts/verify-backup.mjs [sql 路径] --structural`  结构模式：**不比对绝对计数**，只验证
 *                                                            「内部自洽 + 冻结期内的局逐字节可对回源文件、
 *                                                            冻结期后的新局只记数不判失败」。定时备份任务
 *                                                            （.github/workflows/backup.yml）用这一档：
 *                                                            线上棋谱会随时间增长，拿迁移当天的 54 局
 *                                                            卡 CI 只会得到「永远红」。
 *
 * 无论哪种模式，以下三类永远判失败：孤儿明细行、`game_moves` 行数与 `games.move_count` 不一致、
 * 冻结期内（`games/<day>/` 目录存在）的局 payload 对不回源文件。退出码非 0 即备份不可信。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const structural = args.includes('--structural');
const sqlPath = args.find((a) => !a.startsWith('--')) || join('backups', 'export.sql');
const sql = readFileSync(join(ROOT, sqlPath), 'utf8');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = OFF');
db.exec(sql);

const one = (q) => db.prepare(q).get();
const totals = one(`SELECT (SELECT count(*) FROM games) games,
                           (SELECT count(*) FROM game_moves) moves,
                           (SELECT count(*) FROM experiments) exp,
                           (SELECT count(*) FROM devices) devices,
                           (SELECT count(DISTINCT game_uid) FROM games) uids,
                           (SELECT coalesce(sum(payload_bytes),0) FROM games) bytes,
                           (SELECT count(*) FROM game_moves m LEFT JOIN games g ON g.id = m.game_id WHERE g.id IS NULL) orphans`);

const expected = { games: 54, moves: 4379, exp: 6, devices: 0, uids: 54, bytes: 845578, orphans: 0 };
let bad = 0;
/* 孤儿明细行在任何模式下都是硬失败：它意味着备份里有一半的关系丢了 */
if (Number(totals.orphans) !== expected.orphans) {
  bad++;
  console.log(`  ✗ orphans: ${totals.orphans}（期望 ${expected.orphans}）`);
} else {
  console.log(`  ✓ orphans: ${totals.orphans}`);
}
for (const [k, v] of Object.entries(expected)) {
  if (k === 'orphans') continue;
  const ok = Number(totals[k]) === v;
  if (!ok && !structural) bad++;
  const mark = ok ? '✓' : structural ? '·' : '✗';
  const note = ok || !structural ? '' : `（结构模式：不判失败，迁移基线为 ${v}）`;
  console.log(`  ${mark} ${k}: ${totals[k]}（迁移基线 ${v}）${note}`);
}

/* payload 保真：导出里的 payload 逐字节对回原归档文件 */
const rows = db.prepare('SELECT day, game, game_uid, dedup_key, payload, payload_bytes, move_count FROM games').all();
let checked = 0;
let mismatch = 0;
let postFreeze = 0;
let hollowDays = 0;
for (const r of rows) {
  const sha = createHash('sha1').update(r.payload).digest('hex');
  const dayDir = join(ROOT, 'games', r.day);
  const dayExists = existsSync(dayDir);
  const files = dayExists ? readdirSync(dayDir) : [];
  let hit = false;
  for (const f of files) {
    const buf = readFileSync(join(dayDir, f));
    if (createHash('sha1').update(buf).digest('hex') === sha) {
      hit = true;
      break;
    }
  }
  checked++;
  if (!hit) {
    if (dayExists) {
      /* 冻结期内的日期目录存在却没有对应源文件：这是真问题（payload 被改过或导入错位） */
      mismatch++;
      console.log(`  ✗ payload 对不上源文件 game_uid=${r.game_uid}`);
    } else {
      /* 该日期目录根本不存在：冻结之后新入库的局，没有源文件可比 */
      postFreeze++;
      hollowDays++;
    }
  }
  const moveRows = db.prepare('SELECT count(*) n FROM game_moves WHERE game_id = ?').get(
    db.prepare('SELECT id FROM games WHERE dedup_key = ?').get(r.dedup_key).id,
  );
  if (Number(moveRows.n) !== Number(r.move_count)) {
    mismatch++;
    console.log(`  ✗ 手数不一致 game_uid=${r.game_uid}: 明细 ${moveRows.n} vs move_count ${r.move_count}`);
  }
}
console.log(`  ${mismatch ? '✗' : '✓'} 导出内 payload 与源归档逐字节一致 / 手数自洽：${checked} 局，不一致 ${mismatch} 处`);
if (postFreeze) {
  console.log(
    `  · 其中 ${postFreeze} 局属于冻结期后的新数据（源目录不存在${structural ? '' : '；严格模式下这也算失败'}）；涉及 ${hollowDays} 个日期目录不存在`,
  );
  if (!structural) {
    mismatch += postFreeze;
    bad++;
  }
}
if (mismatch) bad++;

/* payload ↔ 派生列一致性：列是查询用的索引面，payload 是权威原文；两者漂移说明备份被人工改过
   （例如直接 UPDATE 了 game 列）或导入期映射有 bug。任何模式下都判失败。 */
let drift = 0;
for (const r of rows) {
  let p;
  try {
    p = JSON.parse(r.payload);
  } catch (err) {
    drift++;
    console.log(`  ✗ payload 不是合法 JSON game_uid=${r.game_uid}: ${err.message}`);
    continue;
  }
  const dayOfPayload = typeof p.exported === 'string' ? p.exported.slice(0, 10) : null;
  const checks = [
    ['game', p.game, r.game],
    ['move_count', Array.isArray(p.moves) ? p.moves.length : null, r.move_count],
    ['day', dayOfPayload, r.day],
  ];
  for (const [name, want, got] of checks) {
    if (want === null || want === undefined) continue;
    if (String(want) !== String(got)) {
      drift++;
      console.log(`  ✗ ${name} 漂移 game_uid=${r.game_uid}: 列 ${JSON.stringify(got)} vs payload ${JSON.stringify(want)}`);
    }
  }
}
console.log(`  ${drift ? '✗' : '✓'} payload 与派生列（game / move_count / day）无漂移：${rows.length} 局，漂移 ${drift} 处`);
if (drift) bad++;

const tail = `games ${totals.games} 局 / game_moves ${totals.moves} 手 / experiments ${totals.exp} 轮 / payload ${totals.bytes} B`;
console.log(
  bad
    ? `\n✗ 备份不可信：${bad} 项不通过（${tail}）`
    : `\n✓ 备份可完整重建${structural ? '（结构自洽，计数见上）' : '整库'}（${tail}${mismatch ? '' : '，payload 逐字节一致'}）`,
);
process.exit(bad ? 1 : 0);
