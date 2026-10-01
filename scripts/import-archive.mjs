#!/usr/bin/env node
/**
 * 历史归档导入（计划 §7 P4）：`games/**\/*.json`（54 份）+ `data/experiments.json`（6 轮）
 * → `migrations/import/*.sql` 分片 → 可选地喂给 `wrangler d1 execute`。
 *
 * 为什么走「生成 SQL 文件」而不是自己连 D1：D1 没有本地 socket 接口，wrangler 才是唯一
 * 权威执行入口；生成物还能进仓库，让「重建整个库」这件事可复现、可审计（games/ 已冻结）。
 *
 * 用法：
 *   node scripts/import-archive.mjs                 # 只生成分片 + 断言（默认）
 *   node scripts/import-archive.mjs --dry-run       # 生成到内存，校验后丢弃
 *   node scripts/import-archive.mjs --local         # 生成后 wrangler d1 execute --local
 *   node scripts/import-archive.mjs --remote        # 生成后 wrangler d1 execute --remote
 *
 * 幂等：`games` 按 `dedup_key` DO NOTHING（同 payload 重跑不重复入库），
 * `game_moves` 按 (game_id, ply) DO NOTHING，`experiments` 按 `tag` DO UPDATE（实验轮会改）。
 * 回滚：`DELETE FROM games WHERE source='import';` 后重跑。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAYLOAD_MAX_BYTES, dedupSource, gameUidSource, mapExperimentRecord, mapGameRecord, measureBytes,
} from '../src/shared/record-map.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT_DIR = join(ROOT, 'migrations', 'import');
const DB_NAME = 'jev-qiguan';
/** 分片上限：语句数（计划 §7 P4）与体积（wrangler `--file` 太大易失败）双保险。 */
const MAX_STATEMENTS_PER_SHARD = 500;
const MAX_BYTES_PER_SHARD = 2 * 1024 * 1024;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const DRY_RUN = has('--dry-run');
const APPLY = has('--local') || has('--remote');

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function walkJson(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkJson(abs, out);
    else if (abs.endsWith('.json')) out.push(abs);
  }
  return out;
}

/** SQLite 字符串字面量：单引号翻倍；其余字符（含换行、中文）原样进文件（UTF-8）。 */
function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * `valuesClause` 是**整段值文本、自带行括号**：单行写 `(v1, v2, …)`，
 * 多行写 `(v1, …), (v2, …)`。这里刻意不再包一层括号——多行元组外面多包一层
 * 会被 SQLite 当成一个「行值」表达式（54 手 → 报 `54 values for 13 columns`）。
 * 结尾也不加分号，由渲染阶段统一加（否则会生成 `;;`）。
 */
function insertStatement(table, cols, valuesClause, conflict) {
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${valuesClause}${conflict}`;
}

/** 单行值文本（含行括号）：标量字段 → `(…, …)`。 */
const rowClause = (row, cols) => `(${cols.map((c) => sqlStr(row[c])).join(', ')})`;

const fail = (msg) => {
  console.error(`✗ 导入失败：${msg}`);
  process.exit(1);
};

/* ---------- 1. 读归档并用 record-map 映射 ---------- */

const gamesDir = join(ROOT, 'games');
if (!existsSync(gamesDir)) fail(`找不到归档目录 ${gamesDir}`);
const files = walkJson(gamesDir).sort();
if (!files.length) fail('归档目录里没有棋谱');

const mapped = [];
const warnings = [];
for (const abs of files) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  const raw = readFileSync(abs, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail(`${rel} 不是合法 JSON：${err.message}`);
  }
  const gameUid = sha1(gameUidSource(payload)).slice(0, 16);
  const dedupKey = sha1(dedupSource(payload, gameUid));
  const day = rel.split('/')[1];
  const { row, moves, warnings: w } = mapGameRecord(payload, { gameUid, dedupKey }, {
    rawPayload: raw, fallbackDay: day, source: 'import', deviceId: null,
  });
  for (const x of w) warnings.push(`${rel}: ${x}`);
  mapped.push({ rel, row, moves });
}

const expPath = join(ROOT, 'data', 'experiments.json');
const experiments = existsSync(expPath)
  ? JSON.parse(readFileSync(expPath, 'utf8')).map((e) => mapExperimentRecord(e, { deviceId: null }))
  : [];

/* ---------- 2. 硬断言（不通过就不落盘） ---------- */

const uidSet = new Set(mapped.map((m) => m.row.game_uid));
const dedupSet = new Set(mapped.map((m) => m.row.dedup_key));
if (uidSet.size !== mapped.length) fail(`game_uid 有碰撞：${mapped.length} 局只有 ${uidSet.size} 个唯一值`);
if (dedupSet.size !== mapped.length) fail(`dedup_key 有碰撞：${mapped.length} 局只有 ${dedupSet.size} 个唯一值`);
for (const { rel, row, moves } of mapped) {
  if (row.payload_bytes > PAYLOAD_MAX_BYTES) fail(`${rel} 的 payload ${row.payload_bytes} B 超过上限 ${PAYLOAD_MAX_BYTES} B`);
  if (row.payload_bytes !== measureBytes(row.payload)) fail(`${rel} 的 payload_bytes 与实际字节数不符`);
  if (!row.day) fail(`${rel} 推不出 day`);
  if (!row.move_count || moves.length !== row.move_count) fail(`${rel} 逐手明细数量与 move_count 不符`);
}
const expTags = new Set(experiments.map((e) => e.tag));
if (expTags.size !== experiments.length) fail('experiments 的 tag 有重复（TEXT PRIMARY KEY 会静默覆盖）');
if (warnings.length) fail(`映射产生 ${warnings.length} 条告警，先修干净再导入：\n  - ${warnings.slice(0, 10).join('\n  - ')}`);

/* ---------- 3. 生成分片 ---------- */

const moveCols = ['game_id', 'ply', 'side', 'notation', 'tactics', 'tactics_version', 'channel', 'model', 'confidence', 'prob', 'rank', 'ms', 'cands'];
const gameCols = Object.keys(mapped[0].row);
const expCols = Object.keys(experiments[0] ?? { tag: '', date: '', chan_a: null, chan_b: null, tac_a: null, tac_b: null, think_a: null, think_b: null, total: null, note: null, games_json: '[]', device_id: null });

const statements = [];
let header = (title) => statements.push({ sql: `-- ${title}`, comment: true, bytes: 0 });

header(`games：${mapped.length} 局（source='import'，device_id=NULL，按 dedup_key 幂等）`);
for (const { row } of mapped) {
  statements.push({
    sql: insertStatement('games', gameCols, rowClause(row, gameCols), ' ON CONFLICT(dedup_key) DO NOTHING'),
    bytes: row.payload_bytes,
  });
}

header(`game_moves：${mapped.reduce((n, m) => n + m.moves.length, 0)} 手（game_id 用 dedup_key 反查，避免依赖自增 id）`);
for (const { row, moves } of mapped) {
  const sub = `(SELECT id FROM games WHERE dedup_key = ${sqlStr(row.dedup_key)})`;
  const tuples = moves.map((m) => `(${sub}, ${moveCols.slice(1).map((c) => sqlStr(m[c])).join(', ')})`);
  // 一条语句一局：225 手的局也只是一条 INSERT，省语句数也省往返
  statements.push({
    sql: insertStatement('game_moves', moveCols, tuples.join(', '), ' ON CONFLICT(game_id, ply) DO NOTHING'),
  });
}

if (experiments.length) {
  header(`experiments：${experiments.length} 轮（按 tag upsert，tac_a/tac_b/think_a/think_b 原样保留）`);
  const upd = expCols.filter((c) => c !== 'tag').map((c) => `${c} = excluded.${c}`).join(', ');
  for (const e of experiments) {
    statements.push({ sql: insertStatement('experiments', expCols, rowClause(e, expCols), ` ON CONFLICT(tag) DO UPDATE SET ${upd}`) });
  }
}

const shards = [];
let current = [];
let currentBytes = 0;
const flush = () => {
  if (current.length) shards.push(current);
  current = [];
  currentBytes = 0;
};
for (const st of statements) {
  const size = st.bytes || Buffer.byteLength(st.sql, 'utf8');
  if (current.length && (current.length >= MAX_STATEMENTS_PER_SHARD || currentBytes + size > MAX_BYTES_PER_SHARD)) flush();
  current.push(st);
  currentBytes += size;
}
flush();

const fileOf = (i) => `${String(i + 1).padStart(4, '0')}_${['games', 'moves', 'experiments'][Math.min(i, 2)]}.sql`;
const rendered = shards.map((shard) => {
  const head = [
    '-- 由 scripts/import-archive.mjs 生成，请勿手改。',
    `-- 来源：games/**/*.json（${mapped.length} 局）+ data/experiments.json（${experiments.length} 轮）`,
    '-- 幂等：games 按 dedup_key DO NOTHING；game_moves 按 (game_id, ply) DO NOTHING；experiments 按 tag DO UPDATE。',
    '',
  ].join('\n');
  return head + shard.map((s) => (s.comment ? s.sql : `${s.sql};`)).join('\n') + '\n';
});

/* ---------- 4. 在内存 SQLite 里真跑一遍（DDL + 分片 + 重放幂等） ---------- */

// 为什么必须真跑：`--local/--remote` 走 wrangler，报错信息只有一行（例如
// `54 values for 13 columns: SQLITE_ERROR`），定位成本极高。这里用 node:sqlite
// 先执行 `migrations/0001_init.sql` + 全部分片，任何语法/约束问题当场暴露。
async function verifySql() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    console.warn('⚠ 跳过 SQL 自检：当前 Node 没有 node:sqlite（需要 Node ≥ 22.5）');
    return;
  }
  const db = new DatabaseSync(':memory:');
  const scalar = (q) => db.prepare(q).get().c;
  try {
    db.exec(readFileSync(join(ROOT, 'migrations', '0001_init.sql'), 'utf8'));
    for (let pass = 1; pass <= 2; pass++) {
      for (const text of rendered) db.exec(text);
      const counts = {
        games: scalar('SELECT count(*) c FROM games'),
        moves: scalar('SELECT count(*) c FROM game_moves'),
        experiments: scalar('SELECT count(*) c FROM experiments'),
        orphanMoves: scalar('SELECT count(*) c FROM game_moves gm LEFT JOIN games g ON g.id = gm.game_id WHERE g.id IS NULL'),
      };
      const want = { games: manifest.games, moves: manifest.moves, experiments: manifest.experiments, orphanMoves: 0 };
      for (const k of Object.keys(want)) {
        if (counts[k] !== want[k]) fail(`第 ${pass} 遍执行后 ${k} = ${counts[k]}，期望 ${want[k]}`);
      }
    }
    // 逐手明细与 move_count 对账（分片里的元组不能多也不能少）
    const mismatch = scalar(`SELECT count(*) c FROM games g WHERE (SELECT count(*) FROM game_moves m WHERE m.game_id = g.id) <> g.move_count`);
    if (mismatch) fail(`${mismatch} 局的逐手明细数与 move_count 不一致`);
    const bytes = scalar('SELECT sum(payload_bytes) c FROM games');
    if (bytes !== manifest.payloadBytes) fail(`payload 合计 ${bytes} ≠ 期望 ${manifest.payloadBytes}`);
    console.log(`✓ SQL 自检通过（内存 SQLite：DDL + ${rendered.length} 个分片，连跑两遍计数不变，逐手明细逐局对账）`);
  } catch (err) {
    fail(`分片 SQL 无法在 SQLite 执行：${err.message}`);
  } finally {
    db.close();
  }
}

/* ---------- 5. 落盘 + 清单 ---------- */

const manifest = {
  generatedAt: new Date().toISOString(),
  games: mapped.length,
  moves: mapped.reduce((n, m) => n + m.moves.length, 0),
  experiments: experiments.length,
  payloadBytes: mapped.reduce((n, m) => n + m.row.payload_bytes, 0),
  byGame: mapped.reduce((acc, m) => ((acc[m.row.game_id] = (acc[m.row.game_id] ?? 0) + 1), acc), {}),
  tags: [...expTags].sort(),
  shards: rendered.map((text, i) => ({ file: fileOf(i), statements: shards[i].length, bytes: measureBytes(text), sha256: sha256(text) })),
};

await verifySql();

if (DRY_RUN) {
  console.log(`✓ 校验通过（dry-run，未落盘）：${manifest.games} 局 / ${manifest.moves} 手 / ${manifest.experiments} 轮实验`);
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  // 先清掉旧的 000?_*.sql，避免上一次运行的残留分片被 --local/--remote 一起执行
  for (const f of readdirSync(OUT_DIR)) {
    if (/^\d{4}_.+\.sql$/.test(f)) rmSync(join(OUT_DIR, f));
  }
  rendered.forEach((text, i) => writeFileSync(join(OUT_DIR, fileOf(i)), text, 'utf8'));
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`✓ 已生成 ${rendered.length} 个分片 → migrations/import/`);
  console.log(`  ${manifest.games} 局 / ${manifest.moves} 手 / ${manifest.experiments} 轮实验 / payload 合计 ${manifest.payloadBytes} B`);
  for (const s of manifest.shards) console.log(`  · ${s.file}  ${s.statements} 条语句  ${s.bytes} B  sha256=${s.sha256.slice(0, 16)}`);
}

if (APPLY) {
  const mode = has('--remote') ? '--remote' : '--local';
  if (DRY_RUN) fail('--dry-run 与 --local/--remote 不能同时用');
  for (const s of manifest.shards) {
    console.log(`→ wrangler d1 execute ${DB_NAME} ${mode} --file=migrations/import/${s.file}`);
    // 直接跑 wrangler 的 JS 入口（`node node_modules/wrangler/bin/wrangler.js`）：
    // Windows 上 spawn 一个 .cmd/.ps1 壳子会 EINVAL，而 shell:true 既不转义参数
    // 又触发 DEP0190 警告。用当前 Node 执行 JS 入口三端一致、零转义问题。
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'd1', 'execute', DB_NAME, mode, `--file=migrations/import/${s.file}`],
    { cwd: ROOT, stdio: 'inherit' });
  }
  console.log(`✓ 已应用到 ${mode === '--remote' ? '远端 D1' : '本地 D1'}；核对：npm run verify:parity`);
}
