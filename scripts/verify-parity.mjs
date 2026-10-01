#!/usr/bin/env node
/**
 * scripts/verify-parity.mjs — 新旧统计口径对账（计划 P4.2、附录 B）。
 *
 * 旧实现有两条聚合路径，两条都复刻在这里：
 *   1. `server.cjs` 的 handleStats：本地扫 `games/` 全部文件（STATS_SCAN=400，54 份时等于全量）；
 *   2. `functions/api/stats.js`（线上 Pages）：受 50 子请求预算所限，**只取最近 40 份**
 *      （tree 路径字典序倒序后 slice(0,40)），这正是线上数字偏小的原因。
 *
 * 比较对象（candidate）默认是**本地 D1 库文件**，且跑的是生产代码本身
 * （`src/worker/db/stats.ts` 的 getStats，通过 node:sqlite 适配成 D1Database），
 * 所以「SQL 口径 == 旧 JS 口径」这件事是被真实执行验证的，不是靠人读代码点头。
 * 也可以用 `--candidate <url>` 打真跑起来的 Worker（`npm run dev` / 线上自定义域
 * `https://jevqipan.logicc.top`；本机网络连不上 `*.workers.dev`）。
 *
 * 用法：
 *   node scripts/verify-parity.mjs                     # 本地 D1 库文件 vs 全量基线
 *   node scripts/verify-parity.mjs --candidate http://127.0.0.1:8787
 *   node scripts/verify-parity.mjs --base <旧端快照.json | 旧端 origin | 旧端 /api/stats 地址>
 *                                      # origin 形式会自动补 /api/stats（只传域名会抓到 SPA 的 HTML）
 *   node scripts/verify-parity.mjs --base-local        # 只算基线（离线自检，不碰 D1）
 *   node scripts/verify-parity.mjs --db <sqlite路径>   # 指定 D1 库文件
 *
 * 退出码：0 = 全部一致；1 = 有差异或环境不满足（差异逐项打印）。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// Node 24 直载 TypeScript（erasableSyntaxOnly）：这里刻意复用**生产代码**而非重写一遍口径。
import { dedupSource, gameUidSource, measureBytes } from '../src/shared/record-map.ts';
import { getStats } from '../src/worker/db/stats.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GAMES_DIR = join(ROOT, 'games');
const EXPERIMENTS_FILE = join(ROOT, 'data', 'experiments.json');
/** 线上 `functions/api/stats.js` 的子请求预算决定了只聚合最近 40 份。 */
const ONLINE_MAX_FILES = 40;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const problems = [];
const notes = [];
function fail(message) {
  problems.push(message);
}

/* ---------- 1. 基线：复刻旧实现的口径 ---------- */

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function walkGames(dir) {
  const out = [];
  for (const day of readdirSync(dir, { withFileTypes: true })) {
    if (!day.isDirectory()) continue;
    for (const entry of readdirSync(join(dir, day.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const abs = join(dir, day.name, entry.name);
      out.push({ abs, rel: relative(ROOT, abs).split(sep).join('/'), mtime: statSync(abs).mtimeMs });
    }
  }
  return out;
}

/**
 * 与 `server.cjs:415-458` / `functions/api/stats.js:56-81` 逐字同构的聚合。
 * 两处旧实现的循环体完全一样，唯一区别是喂进来的文件集合。
 */
function legacyAggregate(records) {
  const byGame = {};
  const results = { black: 0, white: 0, draw: 0 };
  const calRecords = [];
  let totalGames = 0;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    totalGames++;
    const g = typeof rec.game === 'string' && rec.game ? rec.game : 'unknown';
    byGame[g] = (byGame[g] || 0) + 1;
    if (typeof rec.result === 'string') {
      if (rec.result.indexOf('黑方') >= 0) results.black++;
      else if (rec.result.indexOf('白方') >= 0) results.white++;
      else if (rec.result.indexOf('和棋') >= 0) results.draw++;
    }
    if (rec.mock !== true && Array.isArray(rec.cal)
      && (rec.firstWin === true || rec.firstWin === false)) {
      calRecords.push({
        key: `${rec.gid == null ? '' : rec.gid}|${typeof rec.notation === 'string' ? rec.notation : ''}`,
        firstWin: rec.firstWin,
        cal: rec.cal,
      });
    }
  }
  return { totalGames, byGame, results, cal: { games: calRecords.length, records: calRecords } };
}

const files = existsSync(GAMES_DIR) ? walkGames(GAMES_DIR) : [];
if (!files.length) {
  console.error(`找不到棋谱：${GAMES_DIR}`);
  process.exit(1);
}

const withPayload = files.map((f) => {
  const raw = readFileSync(f.abs, 'utf8');
  return { ...f, raw, payload: JSON.parse(raw) };
});

/** 线上口径：tree 路径字典序倒序（= 最新在前）后取前 40。 */
const onlinePaths = withPayload.map((f) => f.rel).sort().reverse().slice(0, ONLINE_MAX_FILES);
const onlineSet = new Set(onlinePaths);
const onlineRecords = withPayload.filter((f) => onlineSet.has(f.rel)).map((f) => f.payload);

const baselineFull = legacyAggregate(withPayload.map((f) => f.payload));
const baselineOnline = legacyAggregate(onlineRecords);
const experimentsTotal = existsSync(EXPERIMENTS_FILE)
  ? (JSON.parse(readFileSync(EXPERIMENTS_FILE, 'utf8')) ?? []).length
  : 0;

/* ---------- 2. candidate：本地 D1（跑生产代码）或远端 Worker ---------- */

/** 把 node:sqlite 适配成 D1Database 的子集（prepare/bind/first/all/run/batch）。 */
function d1FromSqlite(sqlite) {
  const statement = (sql, args = []) => {
    const bound = args.map((v) => (v === undefined ? null : v));
    return {
      bind: (...more) => statement(sql, more),
      first: async () => sqlite.prepare(sql).get(...bound) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...bound), success: true, meta: {} }),
      run: async () => {
        const info = sqlite.prepare(sql).run(...bound);
        return { results: [], success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
      },
    };
  };
  return {
    prepare: (sql) => statement(sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function findLocalDb() {
  const explicit = value('--db');
  if (explicit) return explicit;
  const stateDir = join(ROOT, '.wrangler', 'state', 'v3', 'd1');
  if (!existsSync(stateDir)) return null;
  const candidates = [];
  for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(stateDir, entry.name);
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.sqlite')) candidates.push(join(dir, file.name));
    }
  }
  // 多个库文件时取最近修改的那个（就是最近一次 wrangler dev / d1 execute 用的库）。
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

async function loadCandidate() {
  const url = value('--candidate');
  if (url) {
    const base = url.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/stats`);
    if (!res.ok) throw new Error(`GET ${base}/api/stats → ${res.status}`);
    const stats = await res.json();
    let experiments = null;
    try {
      const expRes = await fetch(`${base}/api/experiments`);
      if (expRes.ok) {
        const body = await expRes.json();
        experiments = Array.isArray(body?.experiments) ? body.experiments.length : null;
      }
    } catch { /* 实验归档只是附加对账项，拿不到就跳过 */ }
    return { kind: 'http', label: base, stats, experiments, fidelity: null };
  }

  const dbPath = findLocalDb();
  if (!dbPath) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const sqlite = new DatabaseSync(dbPath);
  try {
    const db = d1FromSqlite(sqlite);
    const stats = await getStats(db);
    const experiments = sqlite.prepare('SELECT COUNT(*) AS n FROM experiments').get().n;

    // 额外强断言（只有直连库文件才做得了）：逐局 payload 字节保真 + 明细行数对得上。
    const rows = sqlite.prepare('SELECT game_uid AS uid, dedup_key AS dk, payload, move_count AS mc FROM games').all();
    const movesByUid = new Map(
      sqlite.prepare(
        'SELECT g.game_uid AS uid, COUNT(m.ply) AS n FROM games g LEFT JOIN game_moves m ON m.game_id = g.id GROUP BY g.id',
      ).all().map((r) => [r.uid, r.n]),
    );
    const fidelity = { rows: rows.length, checked: 0, mismatches: [], movesTotal: 0, orphans: 0 };
    const byUid = new Map(rows.map((r) => [r.uid, r]));
    const fileUids = new Set();
    for (const f of withPayload) {
      const uid = sha1(gameUidSource(f.payload)).slice(0, 16);
      const dk = sha1(dedupSource(f.payload, uid));
      fileUids.add(uid);
      const row = byUid.get(uid);
      if (!row) { fidelity.mismatches.push(`${f.rel}：库里没有 game_uid=${uid}`); continue; }
      if (row.dk !== dk) fidelity.mismatches.push(`${f.rel}：dedup_key 不一致（库 ${row.dk} vs 复算 ${dk}）`);
      if (sha1(row.payload) !== sha1(f.raw)) fidelity.mismatches.push(`${f.rel}：payload 字节与原文件不一致`);
      if (row.payload.length !== f.raw.length) fidelity.mismatches.push(`${f.rel}：payload 长度 ${row.payload.length} vs ${f.raw.length}`);
      if (row.mc !== f.payload.moves.length) fidelity.mismatches.push(`${f.rel}：move_count ${row.mc} vs ${f.payload.moves.length}`);
      if ((movesByUid.get(uid) ?? 0) !== f.payload.moves.length) fidelity.mismatches.push(`${f.rel}：game_moves 行数不符`);
      fidelity.checked++;
      fidelity.movesTotal += row.mc;
    }
    fidelity.orphans = rows.filter((r) => !fileUids.has(r.uid)).length;
    return { kind: 'd1', label: dbPath, stats, experiments, fidelity };
  } finally {
    sqlite.close();
  }
}

/* ---------- 3. 比对 ---------- */

function sortedCal(cal) {
  return [...(cal?.records ?? [])]
    .map((r) => JSON.stringify({ key: r.key, firstWin: r.firstWin, cal: r.cal }))
    .sort();
}

function compare(label, expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail(`${label}：基线 ${JSON.stringify(expected)} ≠ 实际 ${JSON.stringify(actual)}`);
    return false;
  }
  return true;
}

function compareStats(prefix, base, actual) {
  compare(`${prefix} totalGames`, base.totalGames, actual.totalGames);
  compare(`${prefix} byGame`, base.byGame, actual.byGame);
  compare(`${prefix} results`, base.results, actual.results);
  compare(`${prefix} cal.games`, base.cal.games, actual.cal?.games);
  const a = sortedCal(base);
  const b = sortedCal(actual);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const onlyBase = a.filter((x) => !b.includes(x)).slice(0, 3);
    const onlyActual = b.filter((x) => !a.includes(x)).slice(0, 3);
    fail(`${prefix} cal.records 逐项不一致（基线 ${a.length} 条 / 实际 ${b.length} 条）`
      + `\n    仅基线有：${onlyBase.join(' ').slice(0, 300)}`
      + `\n    仅实际有：${onlyActual.join(' ').slice(0, 300)}`);
  }
}

const rows = [];
rows.push(['口径', 'totalGames', 'byGame', 'results(b/w/d)', 'cal.games']);
rows.push([
  `基线·全集 ${files.length} 份`,
  baselineFull.totalGames,
  JSON.stringify(baselineFull.byGame),
  `${baselineFull.results.black}/${baselineFull.results.white}/${baselineFull.results.draw}`,
  baselineFull.cal.games,
]);
rows.push([
  `基线·线上截断 ${ONLINE_MAX_FILES} 份`,
  baselineOnline.totalGames,
  JSON.stringify(baselineOnline.byGame),
  `${baselineOnline.results.black}/${baselineOnline.results.white}/${baselineOnline.results.draw}`,
  baselineOnline.cal.games,
]);

let candidate = null;
if (!flag('--base-local')) {
  try {
    candidate = await loadCandidate();
  } catch (err) {
    fail(`读取 candidate 失败：${err.message}`);
  }
  if (!candidate && !value('--candidate') && !flag('--base-local')) {
    notes.push('没有找到本地 D1 库文件（先跑 npm run db:migrate:local && node scripts/import-archive.mjs --local）');
  }
}
if (candidate) {
  rows.push([
    `实际·${candidate.kind === 'http' ? 'HTTP' : '本地 D1'}`,
    candidate.stats.totalGames,
    JSON.stringify(candidate.stats.byGame),
    `${candidate.stats.results.black}/${candidate.stats.results.white}/${candidate.stats.results.draw}`,
    candidate.stats.cal?.games,
  ]);
  compareStats('实际 vs 基线(全集)', baselineFull, candidate.stats);
  if (candidate.experiments != null) {
    compare('实际 experiments', experimentsTotal, candidate.experiments);
  }
  if (candidate.fidelity) {
    const f = candidate.fidelity;
    if (f.mismatches.length) {
      fail(`payload/明细保真：${f.mismatches.length} 处不一致\n    ${f.mismatches.slice(0, 5).join('\n    ')}`);
    }
    if (f.checked !== files.length) fail(`payload 保真核对只覆盖 ${f.checked}/${files.length} 局`);
    if (f.orphans) fail(`库里有 ${f.orphans} 局不在 games/ 归档里（不是本次导入的产物）`);
    const fileMoves = withPayload.reduce((n, x) => n + (x.payload.moves?.length ?? 0), 0);
    compare('手数合计', fileMoves, f.movesTotal);
  }
}

/**
 * HEAD 版 `data/experiments.json` 的轮数 = 旧端 `/api/stats` 的 `experiments` 字段口径。
 * 不在 git 仓库 / 无此文件 / 解析失败 → null（调用方退回用工作区份数比对）。
 */
function committedExperimentsCount() {
  try {
    const raw = execFileSync('git', ['show', 'HEAD:data/experiments.json'], { cwd: ROOT, encoding: 'utf8' });
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.length : null;
  } catch {
    return null;
  }
}

/* 与旧端快照比对：旧端只会给出 40 份子集，所以拿「基线·线上截断」对齐它。 */
const baseSnapshot = value('--base');
if (baseSnapshot) {
  let snapshot;
  try {
    /* URL 形式：只给 origin 时补 `/api/stats`——旧站是 SPA，`GET /` 会返回 index.html，
     * 直接 `.json()` 只会得到「Unexpected token '<'」这种与真实原因无关的报错。 */
    const target = /^https?:/.test(baseSnapshot)
      ? (/\/api\//.test(baseSnapshot) ? baseSnapshot : `${baseSnapshot.replace(/\/+$/, '')}/api/stats`)
      : baseSnapshot;
    snapshot = /^https?:/.test(target)
      ? await (await fetch(target)).json()
      : JSON.parse(readFileSync(target, 'utf8'));
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.totalGames !== 'number') {
      fail(`--base 响应不像 /api/stats 快照（缺 totalGames）：${target}`);
      snapshot = null;
    }
  } catch (err) {
    fail(`读取 --base 快照失败：${err.message}`);
  }
  if (snapshot) {
    rows.push([
      '旧端快照',
      snapshot.totalGames,
      JSON.stringify(snapshot.byGame),
      `${snapshot.results?.black}/${snapshot.results?.white}/${snapshot.results?.draw}`,
      snapshot.cal?.games,
    ]);
    compareStats('旧端快照 vs 基线(线上截断)', baselineOnline, snapshot);
    /* `experiments` 是旧端从 GitHub API 读**仓库 main 上那份** `data/experiments.json` 的长度
     * （`functions/api/stats.js:83-87`），而基线读的是**工作区文件**。本地跑过实验后工作区通常
     * 比 HEAD 多几轮（未提交），于是这里会假报差异——所以先取 HEAD 的份数来比，再补一条说明。 */
    if (snapshot.experiments != null) {
      const committed = committedExperimentsCount();
      if (committed === null) {
        compare('旧端快照 experiments', experimentsTotal, snapshot.experiments);
      } else {
        compare('旧端快照 experiments vs HEAD:data/experiments.json', committed, snapshot.experiments);
        if (committed !== experimentsTotal) {
          notes.push(`工作区 data/experiments.json 有 ${experimentsTotal - committed} 轮未提交`
            + `（${experimentsTotal} vs HEAD ${committed}）——旧端读到的是仓库里那份，属预期差异。`);
        }
      }
    }
    if (snapshot.truncated === true) {
      notes.push(`旧端自称 truncated=true（样本止于 ${ONLINE_MAX_FILES} 份）——这正是本次迁移要修掉的口径。`);
    }
  }
}

/* ---------- 4. 输出 ---------- */

const width = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
const line = (r) => r.map((cell, i) => String(cell).padEnd(width[i])).join('  ');
console.log(line(rows[0]));
console.log(width.map((w) => '─'.repeat(w)).join('  '));
for (const row of rows.slice(1)) console.log(line(row));
console.log('');

if (candidate?.fidelity) {
  const f = candidate.fidelity;
  console.log(`payload 保真：核对 ${f.checked}/${files.length} 局，明细合计 ${f.movesTotal} 手，`
    + `不一致 ${f.mismatches.length} 处`);
}
console.log(`实验轮次：文件 ${experimentsTotal}${candidate?.experiments != null ? ` / 库 ${candidate.experiments}` : ''}`);
console.log(`基线（全集）总手数：${withPayload.reduce((n, f) => n + (f.payload.moves?.length ?? 0), 0)}`);
console.log('');

const onlineGap = baselineFull.totalGames - baselineOnline.totalGames;
if (onlineGap > 0) {
  notes.push(`旧线上截断口径会比全集少算 ${onlineGap} 局（${baselineOnline.totalGames}/${baselineFull.totalGames}）——`
    + '迁移后 /api/stats 一律是全量，不再有 truncated。');
}

for (const note of notes) console.log(`· ${note}`);
if (problems.length) {
  console.error(`\n✗ 对账未通过，${problems.length} 项差异：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n✓ 对账通过：SQL 口径与旧 JS 口径逐项一致（diff = 0）');
