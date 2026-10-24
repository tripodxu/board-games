#!/usr/bin/env node
/**
 * scripts/tactics-mechanics.mjs — 机制层读数 + 功效预检门（S0①②）
 *
 * 回答三个**不花对局成本**的问题：
 *   ① 这盘的「自由手」占多少、模型实走 rank 分布是什么？（掷骰子到底影响多少手）
 *   ② 模型自报的概率分布，跟它实际的重复性差多少？（该不该多采样、该不该关骰子）
 *   ③ 这个改动改变了多少局面？（**开批次之前的功效门**：<2% 判行为等价、2–5% 需 ≥400 对、>5% 才 120 局可判）
 *
 * 用法（零依赖，纯 Node ≥22.18 直载 .ts）：
 *   node scripts/tactics-mechanics.mjs rank   --games .work/remote/vplus-r10s        # 批次目录（自动找 round-1/games.jsonl）
 *   node scripts/tactics-mechanics.mjs rank   --games a.jsonl b.jsonl --json out.json
 *   node scripts/tactics-mechanics.mjs repeat --corpus docs/experiments/official-baseline-large-500x6.jsonl
 *   node scripts/tactics-mechanics.mjs diff   --corpus <语料> --a v14-plus --b v15 --show 20
 *
 * 参数：
 *   --games <path...>   一个或多个棋谱 JSONL / JSON / 批次目录（目录会自动补 round-1/games.jsonl）
 *   --corpus <path>     官方基准语料（500 局面 × 6 次调用），`repeat` 与 `diff` 的输入
 *   --a <id> --b <id>   两档档号（`diff`；必须都在 tactics-versions 的合法档里）
 *   --limit <n>         `diff` 最多比较 n 个局面（成本闸门；一局面两档约 0.05–1.5 s）
 *   --show <n>          明细最多打印 n 行（默认 15）
 *   --no-verify         跳过「用该行自己那一档重算、与语料逐字对账」的保真自检（默认开）
 *   --json <path>       把完整读数写成 JSON
 *
 * 口径：与 `scripts/lib/tactics-replay.mjs` 同源——**无模型平坦口径**（`pairs` = 全部合法着法、概率同为 1）、
 * `topK=1` ⇒ 得到的是「该档接管链在平坦模型下的首选点」，不是「模型会怎么选」。
 * quietShape 按档位透传（与 `src/core/jev/client.ts:649` 同源）。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT } from '../src/core/tactics-versions.ts';
import {
  TACTICS_IDS, diffVersions, gomokuEngine, mergeCensus, num2, pct, rankCensus, repeatStats, concentration,
} from './lib/tactics-mechanics.mjs';

function flag(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const has = (name) => process.argv.includes('--' + name);
/** 取 --name 之后的连续非 -- 参数（多值参数用）。 */
function multi(name) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) out.push(process.argv[j]);
  return out;
}

if (has('help') || has('h') || process.argv.length <= 2) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
  process.exit(process.argv.length <= 2 ? 2 : 0);
}

const CMD = process.argv[2];
const JSON_ARG = flag('json', null);
if (JSON_ARG === true) { console.error('--json 需要一个输出路径'); process.exit(2); }
const JSON_OUT = JSON_ARG ? String(JSON_ARG) : null;
const SHOW = Number(flag('show', 15));

/** 读一份 JSONL / JSON：.jsonl 逐行、.json 整体（数组或对象）；目录自动补 round-1/games.jsonl。 */
function readAny(p) {
  let path = String(p);
  if (existsSync(path) && statSync(path).isDirectory()) {
    const cand = ['round-1/games.jsonl', 'games.jsonl', 'games'];
    const hit = cand.map((c) => join(path, c)).find((c) => existsSync(c));
    if (!hit) throw new Error(`目录里找不到 round-1/games.jsonl 或 games.jsonl：${path}`);
    path = hit;
  }
  if (!existsSync(path)) throw new Error(`文件不存在：${path}`);
  const text = readFileSync(path, 'utf8');
  if (/\.jsonl$/i.test(path)) return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : [j];
}

const A = flag('a', null) ? String(flag('a', null)) : null;
const B = flag('b', null) ? String(flag('b', null)) : null;
const CORPUS = flag('corpus', null) ? String(flag('corpus', null)) : null;
const GAMES = multi('games').map(String);
const LIMIT = flag('limit', null) ? Number(flag('limit', null)) : undefined;
const VERIFY = !has('no-verify');

function checkVersion(id, label) {
  if (!id) return;
  if (!TACTICS_IDS.includes(id)) { console.error(`未知战术档 --${label} "${id}"，合法值：${TACTICS_IDS.join(', ')}`); process.exit(2); }
}

const result = { cmd: CMD, at: new Date().toISOString(), current: CURRENT };

/* ────────────────────────────── rank ────────────────────────────── */
if (CMD === 'rank') {
  if (!GAMES.length) { console.error('rank 需要 --games <path...>'); process.exit(2); }
  const censuses = [];
  for (const g of GAMES) {
    const rows = readAny(g);
    const c = rankCensus(rows);
    censuses.push(c);
    if (GAMES.length > 1) console.log(`· ${g}：${c.games} 局 / 我方 ${c.ours} 手（接管 ${pct(c.takeoverShare)}）`);
  }
  const c = censuses.length > 1 ? mergeCensus(censuses) : censuses[0];
  console.log('\n══ 自由手 / 接管手拆分（我方 = 过战术层且有模型记账的手）══');
  console.log(`棋谱 ${c.games} 局 · 总手数 ${c.plies} · 我方 ${c.ours} 手（跳过：非战术层 ${c.skippedChannel} / 无模型记账 ${c.skippedNoAi}；渠道未知 ${c.unknownChannel}）`);
  console.log(`接管手 ${c.takeover}（${pct(c.takeoverShare)}） · 自由手 ${c.free}（${pct(c.freeShare)}）`);
  console.log('\n══ 实走 rank 分布（rank = 模型概率表里的名次）══');
  const rows = [['自由手', c.freeRanks, c.free], ['接管手', c.takeoverRanks, c.takeover]];
  console.log('  ' + ['类别', 'rank1', 'rank2', 'rank3', 'rank>3', '无 rank', '合计', '平均 p'].join('\t'));
  for (const [name, dist, tot] of rows) {
    const cell = (k) => `${dist[k] || 0} (${pct(tot ? (dist[k] || 0) / tot : 0)})`;
    console.log('  ' + [name, cell('1'), cell('2'), cell('3'), cell('4+'), cell('null'), String(tot),
      name === '自由手' ? num2(c.pMeanFree, 3) : num2(c.pMeanTac, 3)].join('\t'));
  }
  console.log('\n接管层分布：' + (Object.entries(c.layers).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'));
  console.log('渠道分布：' + (Object.entries(c.channels).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'));
  result.rank = c;
}

/* ────────────────────────────── repeat ────────────────────────────── */
if (CMD === 'repeat') {
  if (!CORPUS) { console.error('repeat 需要 --corpus <path>'); process.exit(2); }
  const rows = readAny(CORPUS);
  const { summary, rows: det } = repeatStats(rows);
  console.log('══ 自报概率分布 vs 实测重复性（同一局面多次独立调用）══');
  console.log(`局面 ${summary.positions} 个 · 平均候选 ${num2(summary.meanCands)} 个`);
  console.log(`自报：p1 ${pct(summary.p1Mean)} · top3 ${pct(summary.top3Mean)} · Σp² ${num2(summary.sumP2Mean, 4)} · 有效选择数 ${num2(summary.effectiveNAggregate)}（1/Σp² 聚合口径；逐局面 1/Σp² 的均值 ${num2(summary.effectiveNMean)}） · 熵 ${num2(summary.entropyMean)} bit`);
  console.log(`实测：全一致 ${pct(summary.observedUnanimous)} · 众数占比 ${pct(summary.modeShareMean)} · 单次命中众数 ${pct(summary.callAgreementMean)}`);
  console.log(`自报预测的「全一致」= ${pct(summary.expectedUnanimous)} ⇒ 实际确定性是自报的 ${num2(summary.determinismGap, 1)} 倍`);
  if (summary.resample) {
    console.log('\n多采样聚合稳定性（N 次调用概率均值 → argmax，与全部 k 次均值 argmax 的一致率）：');
    console.log('  ' + Object.entries(summary.resample).map(([n, v]) => `N=${n} ${pct(v.agreement)}`).join(' · '));
    const flat = summary.resample[1] ? summary.resample[1].flatTop2 : null;
    if (flat !== null) console.log(`  顶部平坦（p1−p2 < 3pt）的位置占比 ${pct(flat)}`);
  }
  result.repeat = { summary, rows: det.map((r) => ({ ...r, meanProbs: undefined, callProbs: undefined })) };
}

/* ────────────────────────────── diff ────────────────────────────── */
if (CMD === 'diff') {
  if (!CORPUS) { console.error('diff 需要 --corpus <path>'); process.exit(2); }
  checkVersion(A, 'a'); checkVersion(B, 'b');
  if (!A || !B) { console.error('diff 需要 --a <档> --b <档>'); process.exit(2); }
  const rows = readAny(CORPUS);
  const t0 = Date.now();
  const d = diffVersions(rows, { engine: gomokuEngine(), a: A, b: B, limit: LIMIT, verify: VERIFY,
    onProgress: (i, n) => { if (i % 50 === 0) process.stderr.write(`  … ${i}/${n} 局面（${((Date.now() - t0) / 1000).toFixed(0)}s）\r`); } });
  process.stderr.write(' '.repeat(60) + '\r');
  console.log(`══ 功效预检门：${A} vs ${B}（固定局面集，无模型平坦口径 topK=1，无接管层内挑点随机）══`);
  console.log(`比较局面 ${d.compared}/${d.positions} · 战术层耗时 ${(d.ms / 1000).toFixed(1)}s · 墙钟 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (VERIFY) {
    console.log(`保真自检：board_ascii ${d.fidelity.boardOk}/${d.fidelity.checked} 逐字相同 · criteria ${d.fidelity.criteriaOk}/${d.fidelity.checked} 逐字相同` +
      (d.fidelity.quietShapeArtefacts ? ` · 语料口径差 ${d.fidelity.quietShapeArtefacts} 条（v15 行的 criteria 是没过 quietShape 的原始标签，该档真正发出的是抹过 praise 的版本 ⇒ 预期差异，非重建错）` : '') +
      (d.mismatches.length ? ` · ⚠️ 不一致 ${d.mismatches.length} 条（前 3：${d.mismatches.slice(0, 3).map((m) => `#${m.id} ${m.why}`).join('；')}）` : ''));
  }
  console.log('\n── 三类改变 ──');
  console.log(`决策分歧（接管层或落点变）  ${d.decisionChanged}  ${pct(d.decisionRate)}`);
  console.log(`提示面分歧（决策同、criteria/指令变） ${d.criteriaOnlyChanged}  ${pct(d.criteriaOnlyRate)}`);
  console.log(`总改变率                  ${d.totalChanged}  ${pct(d.totalRate)}`);
  console.log(`\n⇒ ${d.verdict.text}`);
  console.log('\n接管层迁移：' + Object.entries(d.kindCounts).map(([k, v]) => `${k} ${v}`).join(' · ') +
    `（仅 A 接管 ${d.takeoverAOnly} · 仅 B 接管 ${d.takeoverBOnly} · 都接管但落点不同 ${d.bothTakeoverDifferent}）`);
  if (d.details.length) {
    console.log(`\n── 会变的局面（前 ${Math.min(SHOW, d.details.length)} / ${d.details.length}）──`);
    for (const x of d.details.slice(0, SHOW)) {
      const parts = [`#${x.id} ply ${x.ply} ${x.side}`];
      if (x.decision) parts.push(`决策 ${x.layerA || '自由'}${x.notaA ? ':' + x.notaA : ''} → ${x.layerB || '自由'}${x.notaB ? ':' + x.notaB : ''}`);
      if (x.critPoints) parts.push(`标签 ${x.critPoints} 点变（如 ${x.critDiff.slice(0, 2).map((c) => `${c.point} ${c.a || '—'}→${c.b || '—'}`).join('，')}）`);
      if (x.instructionChanged) parts.push('指令文本变');
      console.log('  ' + parts.join(' · '));
    }
  }
  result.diff = d;
}

if (!['rank', 'repeat', 'diff'].includes(CMD)) { console.error(`未知子命令 "${CMD}"（rank / repeat / diff）`); process.exit(2); }
if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(result, null, 2)); console.log(`\nJSON 已写入 ${JSON_OUT}`); }
