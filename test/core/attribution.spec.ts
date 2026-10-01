/**
 * 版本归因（P7）：对**导入后的库**断言，而不是对文件名时间窗断言。
 *
 * 为什么要有这个文件：旧口径按棋谱文件名的 14 位 stamp 落时间窗来推「这一局跑的是哪一版战术」，
 * 于是把**落库时间**当成了**代码版本** —— 2026-09-30 线上仍跑 0.7.0 时落库的 20 局，
 * 窗口算成 v9、实际声明是 0.7.0。P7 删掉了时间窗口径与滞后台账（见
 * `src/core/tactics-versions.ts` 里两段「已退役」注释），归因改为只看数据自带的声明：
 * `games.code_version` / `games.tactics_version`（P4 导入时逐字取自棋谱 `meta.code` / `meta.tv`）。
 *
 * 这个文件把三件事钉在真数据上：
 *  1. 库里的版本声明与 payload 自带的声明**逐局相等**（行不会说谎）；
 *  2. 没有声明的局就是「未知」，数量必须等于没写 meta 的局数（不许被推断补上）；
 *  3. 那 20 局 0.7.0 的历史事实与归档面板要用的归因 SQL 口径。
 *
 * 实现方式：用 `node:sqlite` 在内存里重放 `migrations/0001_init.sql` + 全部分片 SQL。
 * 这等于在 CI 里**真跑一遍导入脚本的产物**（不需要 wrangler、不需要网络）；
 * 旧 Node 没带 `node:sqlite` 时整个文件跳过并打印原因，不伪装成通过。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync as SqliteDb } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CODE_VERSION } from '../../src/shared/version.ts';

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'migrations');
const IMPORT_DIR = join(MIGRATIONS, 'import');

/** 分片按文件名排序应用（0001_…、0002_…，与 import-archive.mjs 的生成顺序一致）。 */
function shardFiles(): string[] {
  return readdirSync(IMPORT_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(IMPORT_DIR, f));
}

/**
 * CI 必须真跑这些断言（`REQUIRE_SQLITE=1`，见 .github/workflows/test.yml）。
 *
 * 本机没有 `node:sqlite` 时静默 `describe.skip` 是合理的（不想让本地开发被环境卡住），
 * 但同一条路径在 CI 上意味着「整个文件的断言一条没跑，流水线却是绿的」——
 * 54 局 / 4379 手的导入库校验是归档数据唯一的守卫，不能靠「没装 SQLite」蒙过去。
 * 所以 CI 上把这条软跳过升级成硬失败。
 */
const REQUIRE_SQLITE = process.env.REQUIRE_SQLITE === '1';

async function openImportedDb(): Promise<SqliteDb | null> {
  try {
    const mod = (await import('node:sqlite')) as typeof import('node:sqlite');
    const db = new mod.DatabaseSync(':memory:');
    db.exec(readFileSync(join(MIGRATIONS, '0001_init.sql'), 'utf8'));
    for (const f of shardFiles()) db.exec(readFileSync(f, 'utf8'));
    return db;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (REQUIRE_SQLITE) {
      throw new Error(
        '[attribution] REQUIRE_SQLITE=1，但本机 node:sqlite 不可用或分片 SQL 无法执行：' + reason +
        '\nCI 上不允许静默跳过——跳过等于「导入库断言一条没跑而流水线全绿」。' +
        '请让 CI 的 Node ≥ 22.18（node:sqlite 自带、无需 --experimental 标志）后重跑。',
      );
    }
    console.warn('[attribution] 跳过：本机 node:sqlite 不可用或分片 SQL 无法执行', err);
    return null;
  }
}

const db = await openImportedDb();

/** 一行计数：`SELECT COUNT(*) AS n …`。 */
function count(sql: string): number {
  const row = db!.prepare(sql).get() as { n: number } | undefined;
  return row ? Number(row.n) : -1;
}

/** 两列分组计数，返回 [key, n] 数组（key 已 COALESCE 成 '(null)' 之类）。 */
function groupCount(sql: string): Array<[string, number]> {
  return (db!.prepare(sql).all() as Array<{ k: string; n: number }>).map((r) => [r.k, Number(r.n)]);
}

/* 本机缺 node:sqlite → 软跳过（REQUIRE_SQLITE 未设时）；CI 上 openImportedDb 已经硬失败，
 * 走不到这里。 */
const d = db ? describe : describe.skip;

d('导入后的库：版本声明逐局可信', () => {
  it('重放 DDL + 分片后行数正确（54 局 / 4379 手 / 6 轮实验）', () => {
    expect(count('SELECT COUNT(*) AS n FROM games')).toBe(54);
    expect(count('SELECT COUNT(*) AS n FROM game_moves')).toBe(4379);
    expect(count('SELECT COUNT(*) AS n FROM experiments')).toBe(6);
    // 每局手数与明细行数一致 —— 归因看的是整局，明细缺行说明导入丢数据
    expect(count(`SELECT COUNT(*) AS n FROM games g
      WHERE g.move_count <> (SELECT COUNT(*) FROM game_moves m WHERE m.game_id = g.id)`)).toBe(0);
  });

  it('code_version 分布 = payload 自带的 meta.code 分布（28 未知 / 20 ×0.7.0 / 6 ×0.8.0）', () => {
    expect(groupCount(
      "SELECT COALESCE(code_version, '(null)') AS k, COUNT(*) AS n FROM games GROUP BY k ORDER BY n DESC",
    )).toEqual([['(null)', 28], ['0.7.0', 20], ['0.8.0', 6]]);
  });

  it('逐局：code_version 必须等于该局 payload 里的 meta.code（行不说谎）', () => {
    const rows = db!
      .prepare('SELECT game_uid, code_version, payload FROM games')
      .all() as Array<{ game_uid: string; code_version: string | null; payload: string }>;
    expect(rows).toHaveLength(54);

    const mismatched: string[] = [];
    const unknown: string[] = [];
    for (const r of rows) {
      const payload = JSON.parse(r.payload) as { meta?: { code?: unknown } };
      const declared = payload.meta && typeof payload.meta.code === 'string' ? payload.meta.code : null;
      if (r.code_version !== declared) {
        mismatched.push(`${r.game_uid}: 列=${String(r.code_version)} payload=${String(declared)}`);
      }
      if (declared === null) unknown.push(r.game_uid);
    }
    expect(mismatched).toEqual([]);
    // 「未知」是数据事实（没写 meta 的 28 局），不是可以被时间窗补上的空位
    expect(unknown).toHaveLength(28);
    expect(count('SELECT COUNT(*) AS n FROM games WHERE code_version IS NULL')).toBe(28);
    expect(new Set(unknown).size).toBe(28);
  });

  it('tactics_version 全为 NULL：旧归档没有 meta.tv，不许按当前档回填', () => {
    expect(count('SELECT COUNT(*) AS n FROM games WHERE tactics_version IS NOT NULL')).toBe(0);
    // 当前档的 id 不能凭空出现在历史行里（回填会让「按档位分组」全部失真）
    expect(count("SELECT COUNT(*) AS n FROM games WHERE tactics_version IS NOT NULL OR code_version = 'v9-vcf-sound'")).toBe(0);
  });

  it('迁移批次的自带版本号与当前代码版本不同（迁移前后可区分）', () => {
    expect(count(`SELECT COUNT(*) AS n FROM games WHERE code_version = '${CODE_VERSION}'`)).toBe(0);
  });

  it('归档面板的归因 SQL 口径：按声明分组，合计等于全量', () => {
    const rows = db!
      .prepare(`SELECT COALESCE(code_version, 'unknown') AS code, COUNT(*) AS games, SUM(move_count) AS moves
                FROM games GROUP BY code ORDER BY games DESC, code ASC`)
      .all() as Array<{ code: string; games: number; moves: number }>;
    expect(rows.map((r) => [r.code, Number(r.games)])).toEqual([
      ['unknown', 28], ['0.7.0', 20], ['0.8.0', 6],
    ]);
    expect(rows.reduce((s, r) => s + Number(r.games), 0)).toBe(54);
    expect(rows.reduce((s, r) => s + Number(r.moves), 0)).toBe(4379);
  });

  it('那 20 局 0.7.0 就是部署滞后那批：全部落在 2026-09-30，且是回放要看的那一段', () => {
    expect(groupCount(
      `SELECT day AS k, COUNT(*) AS n FROM games WHERE code_version = '0.7.0' GROUP BY day`,
    )).toEqual([['2026-09-30', 20]]);
    expect(groupCount(
      `SELECT day AS k, COUNT(*) AS n FROM games WHERE code_version = '0.8.0' GROUP BY day`,
    )).toEqual([['2026-09-30', 6]]);
    // 迁移前的运版本号：0.7.0 比 0.8.0 早，20 局是「线上没重新部署」的证据
    expect(count("SELECT COUNT(*) AS n FROM games WHERE code_version = '0.7.0' AND day = '2026-09-29'")).toBe(0);
  });

  it('payload 逐字节保真：payload_bytes 列与实际字节数一致，合计 845578', () => {
    expect(count('SELECT COUNT(*) AS n FROM games WHERE payload_bytes <> length(CAST(payload AS BLOB))')).toBe(0);
    expect(count('SELECT SUM(payload_bytes) AS n FROM games')).toBe(845578);
  });
});
