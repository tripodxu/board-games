/* test/engines/fingerprint.mjs — 战术决策指纹（计划 2026-10-03-tactics-fidelity-and-elo-ladder §5/§6 P2，决策 D6/D7）
 *
 * 目的：把「审计 §3.3 改一处牵多档」从人工审视变成红灯。语料是固定的一小组局面，
 * 每个局面在**全部 15 档**下各记一条：接管层 + 落点 + 战术事实摘要（事实按规范序 sha256
 * 取前 12 位 + 各事实表的点数）。任何一档（或共用代码里的任何一处）行为变了，指纹就变。
 *
 * 三条纪律：
 *   - **只记决策，不记耗时**（D7）：耗时抖动会让测试 flaky，性能另有 `.work` 探针。
 *   - **重写要显式**：只有 `--write` 会覆盖 `test/parity/tactics-fingerprints.json`，
 *     且必须在 commit 说明里写清「为什么这组决策变了」——否则红灯就是红灯。
 *   - **语料写在指纹文件里**：抽样规则只在 `--write` 时生效，测试只按文件里的局面重放；
 *     以后改抽样规则不会悄悄换语料。
 *
 * 跑法：
 *   node test/engines/fingerprint.mjs            # 只打印语料与层覆盖（不写文件）
 *   node test/engines/fingerprint.mjs --write    # 重新生成指纹
 *   node test/engines/fingerprint.mjs --check    # 与现有指纹逐行比对（非零退出码 = 漂移）
 *
 * 为什么不用 `decide()` 跑：`decide()` 里的接管链与这里调的是同一个 `pickTakeover()`，
 * 但 `decide()` 还要拼 prompt、且 `channel:'random'` 的兜底走真随机 ⇒ 「层为空」的行不可比。
 * 这里只做「序列化 → computeTactics → pickTakeover」，一次拿到事实 + 决策，成本是一遍链。
 * 等价性由 `version-freeze.test.mjs` 的「与 decide(random) 同解」用例 + 抽取时的
 * `.work/p2-ab-baseline.mjs`（450 行 0 差异）双向钉住。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getGame } from '../../src/core/registry.ts';
import { computeTactics, emptyTactics, mechOf } from '../../src/core/tactics.ts';
import { VERSIONS, CURRENT } from '../../src/core/tactics-versions.ts';
import { pickTakeover, TAKEOVER_ORDER } from '../../src/core/takeover.ts';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FINGERPRINT_PATH = path.join(ROOT, 'test', 'parity', 'tactics-fingerprints.json');
export const SCHEMA = 1;

/* 语料规模是实测定的（`.work/p2-cost-probe.mjs`、`.work/p2-gap-scan.mjs`）：v12–v14 三档各约
 * 1.2 s/局面，一个局面跑满 15 档约 2–4 s ⇒ 原计划的「N≈120 局面」要 9 分钟，进不了 CI。
 * 归档 10 个局面（早/中/晚）+ 4 个具名夹具 ≈ 30 s；层覆盖见 `coverageOf()`。 */
export const BUCKETS = [
  { name: 'early', min: 6, max: 14, take: 4 },
  { name: 'mid', min: 15, max: 30, take: 4 },
  { name: 'late', min: 31, max: 60, take: 2 },
];
export const PLY_MIN = 6;
export const PLY_MAX = 60;

/* 归档语料之外的**具名夹具**：早段那几层（win/open4/vcfAttack/vctAttack）在归档的中晚盘
 * 局面里天然遇不到（那些局面早被更靠前的层接管或根本没有一步杀），而这几层恰恰是共用
 * 代码（成五点扫描、VCF/VCT 搜索）最该被冻住的地方。夹具取自 `tactics.test.mjs` 的既有
 * 局面，成本低（每档 0.0–1.3 s），层覆盖最广。 */
export const SYNTHETIC_POSITIONS = [
  { name: 'win', seq: ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5'] },            /* 一步致胜 */
  { name: 'open4', seq: ['F8', 'G7', 'G8', 'H7', 'H8', 'I7'] },                      /* 活四点 */
  { name: 'vcf', seq: ['E7', 'D7', 'F7', 'A1', 'G7', 'A2', 'H5', 'A3', 'H6', 'B1'] }, /* 将死链首步 */
  { name: 'vct', seq: ['H8', 'E11', 'G8', 'B14', 'F8', 'E8', 'J8', 'I8', 'I7', 'A15',
    'K9', 'H6', 'J6', 'G9', 'J7', 'J5', 'H7', 'D12', 'C13', 'G7'] },                 /* 连续威胁链首步 */
];

/** 事实表的键序（规范序：指纹要能跨 Node 版本比较）。 */
const FACTS_KEYS = [
  'winning_points_you', 'winning_points_opponent', 'chance_points_you', 'danger_points_opponent',
  'vcf_win_you', 'vcf_win_opponent', 'vct_win_you', 'vct_win_opponent', 'vct_chain_opponent',
  'live3_you', 'live3_opponent', 'live3_deny_points', 'pressure_cut_points',
  'pressure_you', 'pressure_opponent',
];

/** 事实摘要：规范序 JSON 的 sha256 前 12 位（数组顺序参与，因为顺序决定兜底取点）。 */
function digestOf(t) {
  const obj = {};
  for (const k of FACTS_KEYS) obj[k] = t[k];
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

/** 事实点数（给人看的摘要，git diff 里能直接读出「哪个事实表变了」）。 */
function countsOf(t) {
  return {
    win: t.winning_points_you.length, blk: t.winning_points_opponent.length,
    ch: t.chance_points_you.length, dgr: t.danger_points_opponent.length,
    vcfA: t.vcf_win_you.length, vcfD: t.vcf_win_opponent.length,
    vctA: t.vct_win_you.length, vctD: t.vct_win_opponent.length, vctCh: t.vct_chain_opponent.length,
    l3A: t.live3_you.length, l3D: t.live3_opponent.length, l3deny: t.live3_deny_points.length,
    pcut: t.pressure_cut_points.length, pY: t.pressure_you, pO: t.pressure_opponent,
  };
}

/** 归档棋谱里的候选局面（文件序 + ply 升序，确定性）。 */
export function listCandidates() {
  const dir = path.join(ROOT, 'games');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.json')) files.push(p);
    }
  })(dir);
  const out = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (String(j.gid || '') !== 'gomoku' || !Array.isArray(j.moves) || !j.moves.length) continue;
    const e = getGame('gomoku');
    let st = e.newGame();
    const seq = [];
    for (const mv of j.moves) {
      const n = typeof mv === 'string' ? mv : mv && mv.notation;
      if (typeof n !== 'string' || !n) break;
      const m = e.moveFromNotation(st, n);
      if (!m) break;
      st = e.applyMove(st, m);
      seq.push(n);
      if (seq.length >= PLY_MIN && seq.length <= PLY_MAX) {
        out.push({ kind: 'archive', file: path.relative(ROOT, f).replace(/\\/g, '/'), ply: seq.length, seq: seq.slice() });
      }
    }
  }
  return out;
}

/** 按早/中/晚三段等距取语料（每段内按候选序居中取）。 */
export function sampleCorpus(cands) {
  const picked = [];
  for (const b of BUCKETS) {
    const pool = cands.filter((c) => c.ply >= b.min && c.ply <= b.max);
    for (let i = 0; i < b.take && pool.length; i++) {
      const idx = Math.min(pool.length - 1, Math.floor((i + 0.5) * pool.length / b.take));
      picked.push({ ...pool[idx], bucket: b.name });
    }
  }
  return picked;
}

/**
 * 默认语料 = 归档抽样（早/中/晚）+ 具名夹具。
 *
 * 夹具必须算进默认语料：早段那几层（win/open4/vcfAttack/vctAttack）在归档的中晚盘局面里
 * 天然遇不到——要么早被更靠前的层接管，要么棋盘上根本不存在一步杀——而那几层恰恰是
 * 共用代码（成五点扫描、VCF/VCT 搜索）最该被冻住的地方。
 */
export function defaultCorpus() {
  const fixtures = SYNTHETIC_POSITIONS.map((f) => ({
    kind: 'fixture', name: f.name, file: 'synthetic/' + f.name, bucket: 'fixture',
    ply: f.seq.length, seq: f.seq.slice(),
  }));
  return sampleCorpus(listCandidates()).concat(fixtures);
}

/** 摆出局面（返回 {engine, st}）。 */
export function positionOf(entry) {
  const engine = getGame('gomoku');
  let st = engine.newGame();
  for (const n of entry.seq) {
    const m = engine.moveFromNotation(st, n);
    if (!m) throw new Error('夹具记法非法：' + n + '（' + entry.file + ' ply ' + entry.ply + '）');
    st = engine.applyMove(st, m);
  }
  return { engine, st };
}

/**
 * 跑一个局面的一个档位，返回该行的指纹。
 * @returns {{layer: string|null, notation: string|null, digest: string, n: object}}
 */
export function fingerprintOf(engine, st, versionId) {
  const ser = engine.serializeForJev(st, st.turn);
  const q = (ser.questions || {});
  const crit = (q.move && q.move.criteria) || {};
  const cands = Object.keys(crit);
  const legal = engine.getLegalMoves(st);
  let tactics;
  try {
    tactics = computeTactics(engine, st, legal, cands, versionId);
  } catch (_) {
    /* 与 decide() 同一降级策略：任何引擎差异都退成空战术 */
    tactics = emptyTactics();
  }
  /* channel:'random' 语义：全部合法着法概率相同，稳定排序后 pairs 顺序 = legal 顺序 */
  const pairs = legal.map((m) => [m.notation, 1]);
  const tk = pickTakeover({
    engine, st, tactics, mech: mechOf(versionId), criteria: crit, legal, pairs, cands, topK: 1,
  });
  return {
    layer: tk.layer,
    notation: tk.layer ? tk.notation : null, /* 无接管时走概率/随机兜底，不进指纹 */
    digest: digestOf(tactics),
    n: countsOf(tactics),
  };
}

/** 生成指纹（语料 + 15 档逐行）。 */
export async function buildFingerprint(opts) {
  const o = opts || {};
  const picked = o.positions || defaultCorpus();
  if (!picked.length) throw new Error('没有候选局面（games/ 里没有 ply ' + PLY_MIN + '..' + PLY_MAX + ' 的 gomoku 棋谱）');
  const rows = [];
  const positions = [];
  const t0 = Date.now();
  for (const p of picked) {
    const { engine, st } = positionOf(p);
    const ser = engine.serializeForJev(st, st.turn);
    const crit = ((ser.questions || {}).move || {}).criteria || {};
    const candsSent = Object.keys(crit).length;
    const candsLabeled = Object.values(crit).filter((v) => typeof v === 'string' && v.length > 0).length;
    const pos = { file: p.file, ply: p.ply, candsSent, candsLabeled };
    if (p.bucket) pos.bucket = p.bucket;
    if (p.name) pos.name = p.name;
    if (p.seq) pos.seq = p.seq;
    positions.push(pos);
    for (const v of VERSIONS) {
      const f = fingerprintOf(engine, st, v.id);
      rows.push({ file: p.file, ply: p.ply, v: v.id, layer: f.layer, notation: f.notation, digest: f.digest, n: f.n });
    }
    if (!o.quiet) console.log('  … ' + positions.length + '/' + picked.length + ' 局面（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
  }
  const coverage = coverageOf(rows, positions.length);
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    generator: 'test/engines/fingerprint.mjs',
    current: CURRENT,
    versions: VERSIONS.length,
    costMs: Date.now() - t0,
    buckets: BUCKETS,
    coverage,
    positions,
    rows,
  };
}

/** 层覆盖统计（哪些层在这组语料里真的被走到过）。 */
export function coverageOf(rows, positionCount) {
  const layers = {};
  for (const r of rows) if (r.layer) layers[r.layer] = (layers[r.layer] || 0) + 1;
  const missing = TAKEOVER_ORDER.filter((k) => !layers[k]);
  return { positions: positionCount, rows: rows.length, layers, missing, noTakeover: rows.filter((r) => !r.layer).length };
}

/** 读现有指纹。 */
export function loadFingerprint(file) {
  return JSON.parse(fs.readFileSync(file || FINGERPRINT_PATH, 'utf8'));
}

/**
 * 逐行比对（不跑语料，只比两份数据）。
 * @returns {Array<{file:string, ply:number, v:string, field:string, expected:any, actual:any}>}
 */
export function diffFingerprint(expected, actual) {
  const out = [];
  const key = (r) => r.file + '|' + r.ply + '|' + r.v;
  const map = new Map(actual.rows.map((r) => [key(r), r]));
  for (const e of expected.rows) {
    const a = map.get(key(e));
    if (!a) { out.push({ file: e.file, ply: e.ply, v: e.v, field: '（缺行）', expected: e, actual: null }); continue; }
    for (const f of ['layer', 'notation', 'digest']) {
      if (e[f] !== a[f]) out.push({ file: e.file, ply: e.ply, v: e.v, field: f, expected: e[f], actual: a[f] });
    }
    for (const k of Object.keys(e.n)) {
      if (e.n[k] !== a.n[k]) out.push({ file: e.file, ply: e.ply, v: e.v, field: 'n.' + k, expected: e.n[k], actual: a.n[k] });
    }
  }
  for (const a of actual.rows) {
    if (!expected.rows.some((e) => key(e) === key(a))) out.push({ file: a.file, ply: a.ply, v: a.v, field: '（多出行）', expected: null, actual: a });
  }
  return out;
}

/** 打印语料与覆盖（人读用）。 */
export function describe(fp) {
  console.log('语料 ' + fp.positions.length + ' 局面 × ' + fp.versions + ' 档 = ' + fp.rows.length + ' 行；生成耗时 ' + (fp.costMs / 1000).toFixed(1) + 's');
  for (const p of fp.positions) console.log('  ' + p.bucket + '  ply ' + p.ply + '  ' + p.file + '（候选点 ' + p.candsSent + ' / 带标签 ' + p.candsLabeled + '）');
  const c = fp.coverage;
  console.log('接管层覆盖：' + Object.entries(c.layers).map(([k, n]) => k + '×' + n).join(' · ') + ' · 无接管×' + c.noTakeover);
  if (c.missing.length) console.log('未被覆盖的层（这组语料走不到）：' + c.missing.join(', '));
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  if (check) {
    const expected = loadFingerprint();
    const actual = await buildFingerprint({ quiet: true });
    const diffs = diffFingerprint(expected, actual);
    if (diffs.length) {
      console.log('✗ 指纹漂移 ' + diffs.length + ' 处（前 20 条）：');
      for (const d of diffs.slice(0, 20)) console.log('   ' + d.file + ' ply' + d.ply + ' ' + d.v + ' ' + d.field + '：指纹 ' + JSON.stringify(d.expected) + ' → 现在 ' + JSON.stringify(d.actual));
      process.exitCode = 1;
    } else {
      console.log('✓ 指纹一致（' + expected.rows.length + ' 行）');
    }
  } else {
    const fp = await buildFingerprint({});
    describe(fp);
    if (write) {
      fs.writeFileSync(FINGERPRINT_PATH, JSON.stringify(fp, null, 1) + '\n', 'utf8');
      console.log('写出 ' + path.relative(ROOT, FINGERPRINT_PATH));
    }
  }
}
