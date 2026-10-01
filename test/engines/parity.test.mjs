/* test/engines/parity.test.mjs — 金样逐手差分回放（新旧实现零差异的唯一硬证据）
 *
 * 比对口径（test/parity/README.md §6）：
 *   ① newGame() 的 canonical 指纹 == golden.initialStateHash
 *   ② 每一手：走前 legalCount / legalHash → moveFromNotation 非 null → applyMove →
 *      走后 stateHash / over / winner / statusHash
 *   ③ 收尾：finalStateHash / finalStatus.hash / finalStatus.reason
 * 失败定位必须含：引擎 id、来源（selfPlay 或 archive.file）、第几手(1-based)、notation、
 * 字段名、期望值、实际值。
 *
 * 复用 test/parity/generate.mjs 的 canonical/hash64/legalFingerprint —— 不许另写一套，
 * 否则「哈希口径不同」会被误判成「行为不同」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { suite, ok, eq } from './harness.mjs';
import {
  canonical, hash64, legalFingerprint, ROW_FIELDS, SCHEMA, OUT_DIR,
  /* P8 封条：旧实现删除后金样不能再生成，改由 genTime 记录的「冻结时旧实现是否仍在盘上」+ frozen.json 守完整性 */
  legacyImplementationPresent,
} from '../parity/generate.mjs';
import { games, ids } from '../../src/core/registry.ts';

const S = suite();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* 金样封条（P8 起）：frozen.json 冻结 test/fixtures/golden/ 的文件集合 + 每个文件的 sha256 与字节数。
 * 为什么用 sha256 而不是「再跑一次生成器比对」：生成器依赖的旧实现已被删除，跑不动了；
 * 而且「能跑」本身就意味着数据源还能被改写，那就等于没有封条。
 * 为什么必须连文件集合一起钉：往目录里悄悄塞一个新金样（或删掉一个）不会改变任何既有文件的哈希，
 * 却会让「金样 = 旧实现全量行为」这个前提失真。 */
const FROZEN_FILE = path.join(ROOT, 'test', 'parity', 'frozen.json');

/* ------------------------------------------------------------------ *
 * 与 generate.mjs:142-165 逐字等价的两行指纹（该文件未导出这两个私有函数）
 * ------------------------------------------------------------------ */
function plyRow(engine, move, legalBefore, stAfter) {
  const status = engine.getStatus(stAfter);
  return [
    move.notation,
    legalBefore.length,
    legalFingerprint(legalBefore),
    hash64(canonical(stAfter)),
    status.over ? 1 : 0,
    status.over && status.winner ? String(status.winner) : '',
    hash64(canonical(status)),
  ];
}

function statusSummary(engine, st) {
  const g = engine.getStatus(st);
  return {
    over: !!g.over,
    winner: g.over && g.winner ? String(g.winner) : null,
    reason: g.reason == null ? null : String(g.reason),
    hash: hash64(canonical(g)),
  };
}

/* ------------------------------------------------------------------ *
 * 差异报告
 * ------------------------------------------------------------------ */
function diffMsg(golden, seg, ply, notation, field, expected, actual) {
  return [
    '引擎 ' + golden.engine + '（' + golden.engineName + '）差分',
    '  来源: ' + seg,
    '  第 ' + ply + ' 手' + (notation ? '（' + notation + '）' : ''),
    '  字段: ' + field,
    '  期望: ' + JSON.stringify(expected),
    '  实际: ' + JSON.stringify(actual),
  ].join('\n');
}

/** 逐手回放一个 moves 段并与金样逐字段比对。 */
function replaySegment(engine, golden, segName, seg) {
  const moves = seg.moves || [];
  let st = engine.newGame();
  const initial = hash64(canonical(st));
  eq(initial, seg.initialStateHash, diffMsg(golden, segName, 0, '', 'initialStateHash', seg.initialStateHash, initial));

  for (let i = 0; i < moves.length; i++) {
    const row = moves[i];
    const ply = i + 1;
    const notation = row[0];

    /* 走前：合法着法集指纹（1-ply 战术层的输入，是「候选集变了」这类回归的唯一探针） */
    const legalBefore = engine.getLegalMoves(st);
    eq(legalBefore.length, row[1], diffMsg(golden, segName, ply, notation, 'legalCount', row[1], legalBefore.length));
    const lh = legalFingerprint(legalBefore);
    eq(lh, row[2], diffMsg(golden, segName, ply, notation, 'legalHash', row[2], lh));

    /* 记法往返：悔棋「只存记法 + 重放」的正确性前提 */
    const move = engine.moveFromNotation(st, notation);
    ok(!!move, diffMsg(golden, segName, ply, notation, 'moveFromNotation', '非 null', 'null'));

    /* 走后：状态指纹 + 终局判定 + 状态摘要指纹 */
    const after = engine.applyMove(st, move);
    const got = plyRow(engine, move, legalBefore, after);
    for (let k = 0; k < ROW_FIELDS.length; k++) {
      eq(got[k], row[k], diffMsg(golden, segName, ply, notation, ROW_FIELDS[k], row[k], got[k]));
    }
    st = after;
  }

  /* 收尾：终局状态与判定摘要（reason 全文照抄，是贴目/数子法算错的唯一证据） */
  const finalHash = hash64(canonical(st));
  eq(finalHash, seg.finalStateHash, diffMsg(golden, segName, moves.length, '', 'finalStateHash', seg.finalStateHash, finalHash));
  const sum = statusSummary(engine, st);
  const want = seg.finalStatus || {};
  eq(sum.over, !!want.over, diffMsg(golden, segName, moves.length, '', 'finalStatus.over', !!want.over, sum.over));
  eq(sum.winner, want.winner == null ? null : String(want.winner), diffMsg(golden, segName, moves.length, '', 'finalStatus.winner', want.winner, sum.winner));
  eq(sum.reason, want.reason == null ? null : String(want.reason), diffMsg(golden, segName, moves.length, '', 'finalStatus.reason', want.reason, sum.reason));
  eq(sum.hash, want.hash, diffMsg(golden, segName, moves.length, '', 'finalStatus.hash', want.hash, sum.hash));

  eq(moves.length, seg.plies, diffMsg(golden, segName, 0, '', 'plies', seg.plies, moves.length));
  return moves.length;
}

/* ------------------------------------------------------------------ *
 * 金样装载
 * ------------------------------------------------------------------ */
function loadGoldens() {
  const out = [];
  for (const id of ids) {
    const file = path.join(OUT_DIR, id + '.json');
    if (!fs.existsSync(file)) continue;
    out.push(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return out;
}
const GOLDENS = loadGoldens();

/* ------------------------------------------------------------------ *
 * 金样封条装载（frozen.json）
 * ------------------------------------------------------------------ */
function loadFrozen() {
  ok(fs.existsSync(FROZEN_FILE), '缺 test/parity/frozen.json：金样封条丢失，任何人都可以静默改写金样');
  return JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
}

/** 目录里实际存在的金样文件（相对仓库根的正斜杠路径，排序后返回）。 */
function listGoldenDir() {
  return fs.readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => 'test/fixtures/golden/' + f);
}

/** 相对仓库根的路径 → 绝对路径（封条里的键一律是仓库相对路径，跨平台可用）。 */
function absOf(rel) {
  return path.join(ROOT, rel.split('/').join(path.sep));
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */
S.t('差分：金样文件齐备且口径一致（schema/rowFields/engine）', () => {
  eq(GOLDENS.length, ids.length, '金样文件数应等于注册表棋种数（' + ids.length + '）');
  for (const g of GOLDENS) {
    eq(g.schema, SCHEMA, g.engine + ' 金样 schema 不符：' + g.schema);
    eq(JSON.stringify(g.rowFields), JSON.stringify(ROW_FIELDS), g.engine + ' 金样 rowFields 与生成器不一致');
    ok(!!games[g.engine], '金样 ' + g.engine + ' 在注册表中不存在');
    ok(g.selfPlay && Array.isArray(g.selfPlay.moves) && g.selfPlay.moves.length > 0,
      g.engine + ' 金样缺 selfPlay.moves');
  }
});

S.t('差分：七个棋种 selfPlay 逐手零差异', () => {
  let total = 0;
  const report = [];
  for (const g of GOLDENS) {
    const n = replaySegment(games[g.engine], g, 'selfPlay', g.selfPlay);
    total += n;
    report.push(g.engine + '=' + n + '手');
  }
  ok(total > 0, 'selfPlay 总手数应大于 0');
  console.log('    · selfPlay 逐手一致：' + report.join(', ') + '（合计 ' + total + ' 手）');
});

/* ------------------------------------------------------------------ *
 * 金样封条：任何人（或未来的 agent）静默改写金样都必须在这里变红
 * ------------------------------------------------------------------ */
S.t('差分：金样文件集合与 frozen.json 完全一致（多一个/少一个都红）', () => {
  const frozen = loadFrozen();
  eq(frozen.schema, 'jev-qiguan-golden-freeze/v1', 'frozen.json schema 不符：' + frozen.schema);
  ok(typeof frozen.generatedAt === 'string' && frozen.generatedAt.length > 0, 'frozen.json 缺 generatedAt');
  ok(typeof frozen.note === 'string' && frozen.note.length >= 40, 'frozen.json 的 note 必须写清为什么冻结');

  const declared = Object.keys(frozen.files || {}).sort();
  const actual = listGoldenDir();

  const extra = actual.filter((f) => declared.indexOf(f) < 0);
  const missing = declared.filter((f) => actual.indexOf(f) < 0);
  ok(extra.length === 0,
    '金样目录里出现了 frozen.json 未登记的文件（金样被塞了新内容，不是只读文物了）：' + extra.join('、'));
  ok(missing.length === 0,
    'frozen.json 登记的金样文件在盘上不存在（金样被删除或改名）：' + missing.join('、'));
  eq(JSON.stringify(actual), JSON.stringify(declared), '金样文件集合与 frozen.json 必须逐项相同');

  /* 被封条覆盖的金样必须就是回放用到的那批：封条漏登记 = 有一个金样可以随便改 */
  for (const g of GOLDENS) {
    ok(declared.indexOf('test/fixtures/golden/' + g.engine + '.json') >= 0,
      '回放使用的金样 ' + g.engine + '.json 未被 frozen.json 封条覆盖');
  }
  eq(declared.length, ids.length, '封条登记数应等于注册表棋种数（' + ids.length + '）');
});

S.t('差分：每个金样的 sha256 与字节数与 frozen.json 逐字相符（封条）', () => {
  const frozen = loadFrozen();
  const drifted = [];
  for (const rel of Object.keys(frozen.files || {}).sort()) {
    const rec = frozen.files[rel];
    const abs = absOf(rel);
    ok(fs.existsSync(abs), '金样缺失，无法校验封条：' + rel);
    const buf = fs.readFileSync(abs);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (buf.length !== rec.bytes) drifted.push(rel + ' 字节数 期望=' + rec.bytes + ' 实际=' + buf.length);
    if (sha !== rec.sha256) drifted.push(rel + ' sha256 期望=' + rec.sha256 + ' 实际=' + sha);
  }
  ok(drifted.length === 0,
    '金样内容被改动（它已冻结为只读文物，改金样等于篡改「新旧零差异」的证据）：\n      ' + drifted.join('\n      '));
});

S.t('差分：封条元数据自洽（算法 / 总字节数 / 冻结前提探针可用）', () => {
  const frozen = loadFrozen();
  eq(frozen.algorithm, 'sha256', '封条算法应为 sha256，实际 ' + frozen.algorithm);
  const total = Object.values(frozen.files || {}).reduce((s, r) => s + r.bytes, 0);
  eq(total, 492148, '封条登记的字节数合计应为 492148，实际 ' + total);
  /* 冻结的前提探针：旧实现还在盘上时返回 true（金样理论上仍可重生成，封条是「当前快照」）；
   * 旧实现被 P8 删掉后返回 false（金样是唯一证据，frozen.json 必须继续守住）。
   * 两种情况都要能问出真相，所以这里只钉「探针本身可用」，不钉它的当前取值。 */
  ok(typeof legacyImplementationPresent() === 'boolean',
    'legacyImplementationPresent() 应返回布尔值（它是「旧实现是否还在盘上」的唯一判据）');
});

/* 上面三条守的是**金样内容**；这一条守的是**生成器本身**。
 * 只守内容不守生成器会留下两个后门：
 *   ① 删掉 main() 开头的闸门 → 金样又可以被静默重生成，封条沦为摆设；
 *   ② 把生成逻辑改写成读 src/core → 新实现自己验证自己，「重写没写错」的证据价值归零。
 * 两条都只能靠读源码发现（真跑生成器要 git + 旧实现，P8 后跑不动），所以做结构断言。 */
S.t('差分：生成器保留 P8 拒绝重生成闸门，且绝不改读 src/core（结构断言）', () => {
  const genFile = path.join(ROOT, 'test', 'parity', 'generate.mjs');
  const src = fs.readFileSync(genFile, 'utf8');

  ok(/if \(!legacyImplementationPresent\(\)\)/.test(src),
    'generate.mjs 开头「旧实现不在就拒绝生成」的闸门没了：金样可以被静默重生成，封条随之失效');
  ok(src.indexOf('旧实现已删除（P8）') >= 0 && src.indexOf('金样已冻结') >= 0,
    'generate.mjs 的冻结说明（「旧实现已删除（P8）…金样已冻结」）被删了：失败不再是自解释的');
  ok(src.indexOf('改写成读 src/core') >= 0,
    'generate.mjs 里「请勿改写成读 src/core」的警告被删了（它是自证禁令的书面依据）');
  ok(/LEGACY_FILES/.test(src),
    'generate.mjs 不再指向旧实现文件清单（LEGACY_FILES）：它已经不知道自己在读什么了');

  /* 自证禁令的机器可判定形式：不许有任何 import / require 指向 core */
  const coreImports = src.split('\n').filter((l) => /^\s*(import|const .*require\()/.test(l) && /core/.test(l));
  eq(coreImports.length, 0,
    'generate.mjs 不得 import src/core —— 那样新实现就是在自己验证自己：' + coreImports.join(' | '));
});

S.t('差分：归档棋谱逐手零差异（recordedResultMatched=false 只记录不阻断）', () => {
  let total = 0;
  const files = [];
  const recordedMismatch = [];
  for (const g of GOLDENS) {
    const eng = games[g.engine];
    for (const seg of g.archive || []) {
      const n = replaySegment(eng, g, 'archive ' + seg.file, seg);
      total += n;
      files.push(seg.file);
      if (seg.recordedResultMatched === false) {
        recordedMismatch.push(seg.file + '（归档记「' + seg.archivedResult + '」，引擎判 ' + (seg.finalStatus && seg.finalStatus.winner) + '）');
      }
    }
  }
  console.log('    · 归档逐手一致：' + files.length + ' 局 / ' + total + ' 手');
  if (recordedMismatch.length) {
    console.log('    · 归档结果与引擎判定不一致（已知：引擎不建模认输，只记录不阻断）：');
    for (const s of recordedMismatch) console.log('        - ' + s);
  }
});

S.t('差分：金样总手数覆盖（selfPlay + archive = 5510 手）', () => {
  let selfplay = 0, archived = 0;
  for (const g of GOLDENS) {
    selfplay += (g.selfPlay.moves || []).length;
    for (const seg of g.archive || []) archived += (seg.moves || []).length;
  }
  eq(selfplay, 1131, '金样 selfPlay 手数应为 1131，实际 ' + selfplay);
  eq(archived, 4379, '金样归档手数应为 4379，实际 ' + archived);
  eq(selfplay + archived, 5510, '金样总手数应为 5510，实际 ' + (selfplay + archived));
  const cov = GOLDENS.reduce((a, g) => a + ((g.coverage && g.coverage.plies) || 0), 0);
  if (cov) eq(cov, 5510, 'coverage.plies 合计应为 5510，实际 ' + cov);
});

S.t('差分：金样自对弈每盘的终点与上限自洽（xiangqi 600 手上限）', () => {
  for (const g of GOLDENS) {
    const sp = g.selfPlay;
    const n = (sp.moves || []).length;
    if (sp.plyLimitReached) {
      eq(n, sp.maxPlies, g.engine + ' 触顶对局的手数应等于 maxPlies');
      ok(n >= 600, g.engine + ' 触顶对局手数应 ≥600，实际 ' + n);
    } else {
      ok(sp.finalStatus && sp.finalStatus.over, g.engine + ' 未触顶的对局应已终局');
    }
    eq(sp.maxPlies, 600, g.engine + ' 金样 maxPlies 应为 600（新实现必须同上限）');
    eq(sp.channel, 'mock', g.engine + ' 金样自对弈应走 mock 渠道');
    eq(sp.topK, 3, g.engine + ' 金样自对弈 topK 应为 3');
  }
});

export default S;
