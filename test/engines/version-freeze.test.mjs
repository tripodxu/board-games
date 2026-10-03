/* test/engines/version-freeze.test.mjs — 战术档位冻结：决策指纹一致性（计划 §5/§6 P2，决策 D6/D7/D8）
 *
 * 这是「改一处牵多档」的红灯：`test/parity/tactics-fingerprints.json` 里钉着固定语料
 * × 15 档的「接管层 + 落点 + 事实摘要」。任何一档的机制、共用代码（`computeTactics` /
 * `takeover.ts` / 引擎推演）或登记表本身变了，这里就会红。
 *
 * 红了怎么办（按顺序）：
 *   1. 先确认这是**有意**的行为变更（不是回归）；
 *   2. 在 commit 说明里写清「哪一档、哪一类事实、为什么变」——`git diff` 指纹文件即可看见；
 *   3. 用 `node test/engines/fingerprint.mjs --write` 重写指纹，并把新覆盖表贴进说明。
 * 没写理由就重写指纹 = 把回归合法化，所以重写必须显式（只有 `--write` 会写）。
 *
 * 为什么只记决策不记耗时（D7）：耗时抖动会让测试 flaky；性能另有 `.work` 探针与实验报表。
 *
 * 语料 = 归档抽样 10 个局面（早 4 / 中 4 / 晚 2，`BUCKETS`）+ 4 个具名夹具（`SYNTHETIC_POSITIONS`），
 * 覆盖 14 层里的 13 层；`threat` 是结构性走不到的那一层（判据与 `you:open4` 同源，见 ⑭c 注释）。
 */
import { suite, ok, eq } from './harness.mjs';
import { VERSIONS, CURRENT, MECHS } from '../../src/core/tactics-versions.ts';
import { TAKEOVER_ORDER } from '../../src/core/takeover.ts';
import { setSeed } from '../../src/core/rng.ts';
import { decide } from '../../src/core/jev/index.ts';
import { loadFingerprint, fingerprintOf, positionOf, coverageOf } from './fingerprint.mjs';

const S = suite();
const FP = loadFingerprint();

S.t('⑭a 指纹：形状完整（schema/档数/每个局面的行数都与登记表对齐）', () => {
  eq(FP.schema, 1, '指纹 schema 应为 1');
  eq(FP.versions, VERSIONS.length, '指纹里的档数应等于登记表档数（加档必须重写指纹）');
  eq(FP.current, CURRENT, '指纹里的当前档应等于 CURRENT（换档必须重写指纹）');
  ok(FP.positions.length >= 12, '语料至少 12 个局面（归档 10 + 具名夹具 4 = 14；低于 12 说明被削过，层覆盖会退化）');
  ok(FP.positions.some((p) => p.bucket === 'fixture'), '语料必须含具名夹具（win/open4/vcf/vct 四层只有它们能覆盖）');
  ok(FP.rows.length === FP.positions.length * VERSIONS.length,
    '行数应为 局面数 × 档数：' + FP.rows.length + ' vs ' + FP.positions.length + ' × ' + VERSIONS.length);
  const ids = new Set(VERSIONS.map((v) => v.id));
  for (const p of FP.positions) {
    const got = FP.rows.filter((r) => r.file === p.file && r.ply === p.ply).map((r) => r.v);
    eq(got.length, VERSIONS.length, p.file + ' ply' + p.ply + ' 的档数不全');
    for (const id of ids) ok(got.includes(id), p.file + ' ply' + p.ply + ' 缺档 ' + id);
  }
});

S.t('⑭b 指纹：逐行重放，层/落点/事实摘要必须与冻结值一致', () => {
  const byKey = new Map(FP.rows.map((r) => [r.file + '|' + r.ply + '|' + r.v, r]));
  const bad = [];
  for (const p of FP.positions) {
    const { engine, st } = positionOf(p);
    for (const v of VERSIONS) {
      const want = byKey.get(p.file + '|' + p.ply + '|' + v.id);
      const got = fingerprintOf(engine, st, v.id);
      if (want.layer !== got.layer) bad.push(p.file + ' ply' + p.ply + ' ' + v.id + ' 层：冻结 ' + want.layer + ' → 现在 ' + got.layer);
      else if (want.notation !== got.notation) bad.push(p.file + ' ply' + p.ply + ' ' + v.id + ' 落点：冻结 ' + want.notation + ' → 现在 ' + got.notation);
      else if (want.digest !== got.digest) {
        const diffKeys = Object.keys(want.n).filter((k) => want.n[k] !== got.n[k]).map((k) => k + ' ' + want.n[k] + '→' + got.n[k]);
        bad.push(p.file + ' ply' + p.ply + ' ' + v.id + ' 事实变了（' + (diffKeys.length ? diffKeys.join('、') : '点数相同但顺序/取值变了') + '）');
      }
    }
  }
  ok(!bad.length, '决策指纹漂移 ' + bad.length + ' 处（确认是有意变更后用 --write 重写并写清理由）：\n      ' + bad.slice(0, 12).join('\n      '));
});

S.t('⑭c 指纹：层覆盖与冻结时一致（覆盖退化要显式看到）', () => {
  const now = coverageOf(FP.rows, FP.positions.length);
  eq(now.rows, FP.coverage.rows, '行数一致');
  const frozen = Object.keys(FP.coverage.layers).sort().join(',');
  const live = Object.keys(now.layers).sort().join(',');
  eq(live, frozen, '被走到的层集合应与冻结时一致（少一层 = 语料或分支退化）');
  /* 除 `threat` 外**每一层**都必须被这组语料走到——否则那一层的漂移不会被指纹发现。
   * `threat` 是唯一的结构性缺口，不是语料不够：`you:open4` 标签的判据与 `chance_points_you`
   * 的判据同源（走后 ≥2 个成五点：`src/core/engines/gomoku.ts:1063-1064` 对
   * `src/core/tactics.ts:202`），而凡含 `threat` 的档（v3 起）都含 `open4`、链条里 `open4`
   * 在 `threat` 之前 ⇒ 该分支只在「候选集里扫不到 open4 点、却算得出 chance 点」时才可能开火
   * （gomoku + 非空候选集下不会发生）。取证：2225 个归档候选 + 双活三/双四合成局面全部
   * chance=0 或层被 open4 接管（`.work/p2-threat-probe2.mjs`）。 */
  const UNREACHABLE = ['threat'];
  for (const k of TAKEOVER_ORDER) {
    if (UNREACHABLE.indexOf(k) >= 0) continue;
    ok((FP.coverage.layers[k] || 0) > 0, '语料必须覆盖 ' + k + ' 层（否则该层漂移不会被发现）');
  }
  eq(FP.coverage.missing.join(','), UNREACHABLE.join(','), '走不到的层应恰好只有 ' + UNREACHABLE.join('、'));
  eq(now.noTakeover, FP.coverage.noTakeover, '「无接管」行数一致');
});

S.t('⑭d 指纹：与 decide() 全链路同解（语料里取一个局面，15 档逐档对照）', async () => {
  /* 指纹直接调 computeTactics + pickTakeover（一遍链拿到事实 + 决策）。这条用例证明
   * decide() 的接线（serializeForJev → cands/criteria → 同一档机制集）与指纹同解，
   * 否则指纹冻结的就不是真实决策面。 */
  const p = FP.positions.find((x) => x.bucket === 'mid') || FP.positions[0];
  const { engine, st } = positionOf(p);
  for (const v of VERSIONS) {
    const fp = fingerprintOf(engine, st, v.id);
    setSeed(42);
    const r = await decide(engine, st, st.turn, { channel: 'random', tacticsVersion: v.id, topK: 1 });
    const layer = r.meta.tactics || null;
    eq(layer, fp.layer, p.file + ' ply' + p.ply + ' ' + v.id + ' 的层：decide() 与指纹不一致');
    if (layer) eq(r.notation, fp.notation, p.file + ' ply' + p.ply + ' ' + v.id + ' 的落点：decide() 与指纹不一致');
  }
});

S.t('⑭e 指纹：档位冻结字段完整（fidelity 三档齐全、当前档 exact、机制键都登记）', () => {
  const FID = ['exact', 'restored', 'approximate'];
  for (const v of VERSIONS) {
    ok(FID.indexOf(v.fidelity) >= 0, v.id + ' 的 fidelity 必须是 ' + FID.join('/') + ' 之一');
    ok(typeof v.sound === 'boolean', v.id + ' 缺 sound');
    eq(v.openingMin, 4, v.id + ' 的 openingMin 应与冻结值一致（改它要重写指纹）');
    for (const k of Object.keys(v.mech)) ok(MECHS.indexOf(k) >= 0, v.id + ' 的机制键 ' + k + ' 没登记在 MECHS');
  }
  eq(VERSIONS[VERSIONS.length - 1].id, CURRENT, '当前档应是登记表最后一档');
  eq(VERSIONS.find((v) => v.id === CURRENT).fidelity, 'exact', '当前档的 fidelity 应是 exact（活代码 = 精确语义）');
  /* 层顺序单一口径：接管链的分支顺序必须与 TAKEOVER_ORDER 一一对应（14 层） */
  eq(TAKEOVER_ORDER.length, 14, '接管链层数应为 14（十五级 = v0-off + 十四层）');
  const dup = TAKEOVER_ORDER.filter((k, i) => TAKEOVER_ORDER.indexOf(k) !== i);
  eq(dup.length, 0, 'TAKEOVER_ORDER 不应有重复层：' + dup.join(','));
});

export default S;
