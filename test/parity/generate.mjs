#!/usr/bin/env node
'use strict';
/* test/parity/generate.mjs — 差分金样（differential golden）生成器
 *
 * 【为什么存在】计划 docs/plans/2026-10-01-workers-d1-rebuild.md §6.2 要把 js/*.js 七个引擎
 * 重写成 src/core/*.ts。迁移最大的风险是「重写即重写 bug」——规则看起来一样、极端局面下
 * 少一个提子、少一条禁手，线上要输几十盘才被发现。所以在删掉旧实现之前，先把旧实现的
 * 逐手行为固化成可逐位比对的指纹：新实现跑同一批对局/棋谱，任何一手不一致立刻定位到
 * 「哪一局、第几手、合法着法集合变了还是状态变了」。
 *
 * 【为什么用哈希而不是整盘字符串】7 盘自对弈 + 54 份历史棋谱共 5000+ 手，逐手存完整棋盘
 * 会把产物顶到 MB 级；计划要求总产物体积 ≤ 2 MB，因此每手只存 16 位十六进制的稳定指纹
 * （FNV-1a 64 位）。要看具体局面时用同一套 canonical() 现场重算即可（见 README「指纹算法」）。
 *
 * 【为什么生成器自己跑两遍】金样的全部价值在于「可复现」。跑一遍只能证明「这次跑出来了」，
 * 证明不了「下次跑出来一样」。这里在同一进程内把整批数据采集两遍并逐字节比对，不一致直接
 * 报错退出，让「不可复现」在第一次运行时就暴露，而不是等日后比对时才发现金样本身是脏的。
 *
 * 【为什么不写时间戳】产物里任何时间戳都会让「两次生成字节一致」永远不成立。文件头只记
 * commit + seed + 代码版本——三者共同确定「这份金样出自哪份代码、用哪套随机流」。
 *
 * 【P8 起：金样已冻结为只读文物】旧实现 js/** 被删除后，本生成器**不再可用**——
 * 它的全部证据价值来自「用旧实现生成」，改写成读 src/core 就变成自证（新实现自己验自己），
 * 比对结论将一文不值。因此这里保留生成逻辑原样，只在入口做一次「旧实现是否还在」的前置检查：
 * 不在就打印中文说明并 exit(1)，**绝不静默失败、绝不改写数据源**。
 * 金样的完整性与不可篡改性由 test/parity/frozen.json + test/engines/parity.test.mjs 守住。
 *
 * 用法：node test/parity/generate.mjs   （等价于 npm run golden；P8 后必然显式报错）
 * 只读旧实现与 games/**，不修改任何既有文件；产物写入 test/fixtures/golden/。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT_DIR = path.join(ROOT, 'test', 'fixtures', 'golden');
export const ARCHIVE_DIR = path.join(ROOT, 'games');
export const EXCEPTIONS_FILE = path.join(ROOT, 'test', 'parity', 'exceptions.json');

/* 金样契约版本：行字段含义或指纹算法一旦变更（会破坏历史比对），必须 bump 这个串 */
export const SCHEMA = 'jev-qiguan-golden/v1';
/* 自对弈种子：与 test/run-tests.cjs 的 playOut 同值，方便两边交叉复现 */
export const SEED = 42;
/* 手数上限：与 run-tests.cjs 的 600 一致。象棋（xiangqi）在 mock 对攻下 600 手仍未终局，
 * 靠上限截断——这不是缺陷而是被金样记录下来的事实（plyLimitReached 字段），
 * 新实现必须在同一上限、同一手数处停下，否则比对没有共同终点。 */
export const MAX_PLIES = 600;
/* 产物体积上限 2 MB（计划 §6.2 硬指标）。超了就说明指纹设计退化成存整盘，必须改设计而不是放宽上限。 */
export const SIZE_BUDGET = 2 * 1024 * 1024;

/* 逐手行字段（顺序即约定，TS 侧按同一顺序读）：
 *   [0] notation     本手记法（唯一稳定的着法键，也是回放时喂给 moveFromNotation 的入参）
 *   [1] legalCount   走这一手之前，getLegalMoves() 的着法数
 *   [2] legalHash    走这一手之前，合法着法按引擎返回顺序用 \n 连接后的指纹
 *   [3] stateHash    走这一手之后，完整 state 的规范串指纹
 *   [4] over         走这一手之后 getStatus().over（0/1）
 *   [5] winner       走这一手之后的胜方 id（未终局或和棋为空串）
 *   [6] statusHash   走这一手之后 getStatus() 规范串的指纹（含 reason 全文，如「数子：黑 31 : 白 43.5」）
 * legal* 记录的是「决策现场」（本手之前），state/status* 记录的是「决策结果」（本手之后）；
 * 于是相邻两行首尾相接，整局状态链没有缺口。 */
export const ROW_FIELDS = ['notation', 'legalCount', 'legalHash', 'stateHash', 'over', 'winner', 'statusHash'];

/* 与 test/run-tests.cjs 完全同序的加载清单（顺序有意义：tactics-versions 依赖 board，
 * 引擎依赖 board；jev-client 依赖 mock/rapfi 在 decide 里按渠道取用）。 */
const LEGACY_FILES = [
  'js/board.js',
  'js/latest-board.js',
  'js/tactics-versions.js',
  'js/duel.js',
  'js/calibration.js',
  'js/games/gomoku.js',
  'js/games/chess.js',
  'js/games/xiangqi.js',
  'js/games/checkers.js',
  'js/games/chinese-checkers.js',
  'js/games/go.js',
  'js/mock-ai.js',
  'js/jev-client.js',
];

/* 旧实现是否仍在盘上。export 出去供测试与人工核对使用（只读探测，无副作用）。 */
export function legacyImplementationPresent() {
  return fs.existsSync(path.join(ROOT, LEGACY_FILES[0]));
}

/* 冻结说明：P8 删除 js/** 后，这条消息是「金样为什么不能再生成」的唯一出口。
 * 刻意写成「解释 + 出路」而不是一句 throw：后续 agent 看到它就知道该去哪儿读证据链。 */
const FROZEN_NOTICE = [
  '✗ 旧实现已删除（P8），金样已冻结为历史文物，见 test/parity/README.md。',
  '  要重新生成需回到删除旧实现之前的提交（js/** 与 games/** 必须同时在场）。',
  '  请勿把本生成器改写成读 src/core —— 那样新实现就是在自己验证自己，',
  '  金样作为「重写没重写错」独立证据的价值会全部消失。',
  '  金样的当前完整性由 test/parity/frozen.json（sha256 + 字节数）钉住，',
  '  校验发生在 node test/engines/run.mjs 的「差分：金样文件集合与 frozen.json 完全一致」用例。',
].join('\n');

/* ------------------------------------------------------------------ *
 * 旧实现加载垫片（复制自 run-tests.cjs 的最小必要部分，不改那个文件）
 * ------------------------------------------------------------------ */

/* 为什么 eval 而不是 import：旧实现是零构建的 IIFE 脚本，靠 globalThis.BG 相互挂载，
 * 不是 ES 模块。用 eval 复刻浏览器里的加载方式，才能保证「金样记录的正是线上旧行为」。
 *
 * 为什么这里刻意不写 `const BG = globalThis.BG`：sloppy 模式下直接 eval 的代码能看见
 * 本函数的词法作用域，而 `const` 绑定在整个函数体内都处于 TDZ。若本函数声明了 `BG`，
 * 旧实现里那些「读全局 BG」的语句（如 `BG.register({...})`）就会先撞上尚未初始化的
 * 局部 BG，报出极具误导性的 `Cannot access 'BG' before initialization`。
 * 所以这里一律用 ns 这个名字，把 BG 这个名字留给旧实现。 */
export function loadLegacyEngines() {
  process.env.BG_FAST = '1'; // mock AI 跳过模拟延迟；同时保证金样与延迟无关
  globalThis.window = globalThis;
  globalThis.location = { search: '', origin: 'http://localhost' };
  for (const f of LEGACY_FILES) {
    eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
  }
  const ns = globalThis.BG;
  if (!ns || !ns.games || !ns.jev || !ns.mock) {
    throw new Error('旧实现加载失败：BG.games / BG.jev / BG.mock 未全部就位');
  }
  return ns;
}

/* ------------------------------------------------------------------ *
 * 指纹算法（README「指纹算法」一节描述的就是这三个函数；TS 侧必须逐字复刻）
 * ------------------------------------------------------------------ */

/* 规范串：递归按键名排序的 JSON。为什么不直接用 JSON.stringify(state)：
 * 键顺序是旧实现的构造顺序，新实现完全可能用另一种顺序构造同一个局面；
 * 那样比对的就不是行为而是写法。排序后「同一局面 → 同一串」，
 * 这正是不变量「state 一律 JSON 可克隆」（ADR-0004）能给出的最强承诺。 */
export function canonical(v) {
  if (v === undefined) return 'null'; // JSON.stringify(undefined) 返回 undefined，会污染拼接
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/* FNV-1a 64 位。为什么不用 crypto：需要在任意 JS 环境（Node / 浏览器 / 未来的 TS 实现）
 * 得到完全相同的值，纯函数最简单也最不容易漂移。为什么按 UTF-16 码元而不是字节：
 * 中文（如 reason「五连」）在 UTF-8 与 UTF-16 下字节不同，若按字节，两端编码假设不一致
 * 就会得到不同指纹。码元是 JS 语言层面的确定量，没有编码歧义。 */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
export function hash64(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

/* 合法着法指纹：按引擎返回顺序连接。顺序是契约的一部分——jev-client 的降级路径固定回退
 * 到 legal[0]，mock 走 legal[rand(len)]，顺序变了「同一局面走同一步」就不再成立。 */
export function legalFingerprint(legal) {
  return hash64(legal.map((m) => m.notation).join('\n'));
}

/* 一手一行的指纹快照 */
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

/* 终局状态摘要（人可读 + 可判定）。reason 全文照抄：它是「数子：黑 31 : 白 43.5（贴 5.5）」
 * 这类唯一能证明贴目/数子法的证据，一旦新实现算错提子，reason 里的数字会先变。 */
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
 * (a) 确定性自对弈：每棋种一盘，走的是线上同一条 mock 决策链路
 * ------------------------------------------------------------------ */

/* 为什么走 BG.jev.decide(channel:'mock') 而不是直接调 engine.mockPick：
 * decide → BG.mock.decide → mockPick 才是应用真实的调用链（run-tests.cjs playOut 也这么做）。
 * 只调 mockPick 会漏掉「每手额外消耗三次随机数」这类会影响后续走子的行为差异。 */
async function selfPlay(BG, id) {
  const engine = BG.games[id];
  BG.setSeed(SEED); // 每个棋种都从同一颗种子起跑：可复现，且失败时能单独复跑
  const initial = engine.newGame();
  let st = initial;
  const rows = [];
  let truncated = false;

  while (!engine.getStatus(st).over) {
    const legal = engine.getLegalMoves(st);
    if (legal.length === 0) throw new Error(id + ' 第 ' + (rows.length + 1) + ' 手：未终局却无合法着法');
    if (rows.length >= MAX_PLIES) { truncated = true; break; }
    const d = await BG.jev.decide(engine, st, st.turn, { channel: 'mock', topK: 3 });
    if (!d || !d.move || !legal.some((m) => m.notation === d.move.notation)) {
      throw new Error(id + ' 第 ' + (rows.length + 1) + ' 手返回非法着法：' + (d && d.move && d.move.notation));
    }
    const next = engine.applyMove(st, d.move);
    rows.push(plyRow(engine, d.move, legal, next));
    st = next;
  }

  return {
    kind: 'selfplay',
    channel: 'mock',
    topK: 3,
    maxPlies: MAX_PLIES,
    plyLimitReached: truncated,
    plies: rows.length,
    initialStateHash: hash64(canonical(initial)),
    finalStateHash: hash64(canonical(st)),
    finalStatus: statusSummary(engine, st),
    moves: rows,
  };
}

/* ------------------------------------------------------------------ *
 * (b) 历史棋谱回放：games/ 下全部 .json 棋谱只用记法重走一遍
 * ------------------------------------------------------------------ */

/* 统一成正斜杠相对路径：Windows 与 Linux 生成同一份产物，否则「两次运行字节一致」
 * 在跨平台协作（CI 是 Linux、开发机是 Windows）时会莫名其妙地红。 */
function listArchiveFiles() {
  const out = [];
  const walk = (dir) => {
    const ents = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // readdir 顺序不保证，显式排序
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.json')) out.push(p);
    }
  };
  if (fs.existsSync(ARCHIVE_DIR)) walk(ARCHIVE_DIR);
  return out.map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
}

/* 归档棋谱的记法来源有两处：moves[].notation（结构化）与 notation（逗号串）。
 * 两者必须一致——不一致说明归档本身自相矛盾，任何基于它的金样都不可信，所以直接报错。 */
function archiveNotations(j, file) {
  const fromMoves = Array.isArray(j.moves) ? j.moves.map((m) => (m && m.notation) || null) : null;
  const fromString = typeof j.notation === 'string' && j.notation.length
    ? j.notation.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  if (fromMoves && fromMoves.some((n) => n == null)) throw new Error(file + '：moves[] 里有缺 notation 的手');
  if (fromMoves && fromString && fromMoves.join(',') !== fromString.join(',')) {
    throw new Error(file + '：moves[].notation 与 notation 字段不一致（归档自相矛盾）');
  }
  const ns = fromMoves || fromString;
  if (!ns) throw new Error(file + '：既没有 moves[] 也没有 notation，无法回放');
  return ns;
}

/* 归档文案 → 引擎胜方 id。旧文案如「白方 获胜（五连）」「和棋（棋盘已满）」「黑方 获胜（认输）」。
 * 「认输」引擎不建模（是应用层的裁决），因此认输局必然 resultMatched=false——这是事实，不是错误，
 * 记录在案即可（见 README「已知差异」）。 */
function parseArchivedResult(engine, result) {
  const s = String(result || '');
  if (s.indexOf('和棋') === 0) return { expected: null, kind: 'draw' };
  for (const side of engine.sides) {
    if (s.indexOf(side.name + ' 获胜') === 0) {
      return { expected: side.id, kind: s.indexOf('认输') >= 0 ? 'resign' : 'win' };
    }
  }
  return { expected: undefined, kind: 'unknown' };
}

function replayArchive(BG, file) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const id = j.gid;
  const engine = BG.games[id];
  if (!engine) throw new Error(file + '：gid=' + id + ' 不在已注册引擎里，无法回放');
  const notations = archiveNotations(j, file);

  const initial = engine.newGame();
  let st = initial;
  const rows = [];
  for (const n of notations) {
    const legal = engine.getLegalMoves(st);
    const mv = engine.moveFromNotation(st, n);
    if (!mv) throw new Error(file + '：第 ' + (rows.length + 1) + ' 手记法 ' + n + ' 无法从当前局面还原');
    const next = engine.applyMove(st, mv);
    rows.push(plyRow(engine, mv, legal, next));
    st = next;
  }

  const finalStatus = statusSummary(engine, st);
  const archived = parseArchivedResult(engine, j.result);
  return {
    engineId: id,
    record: {
      kind: 'archive',
      file,
      exported: j.exported == null ? null : String(j.exported),
      archivedResult: j.result == null ? null : String(j.result),
      archivedWinner: archived.expected === undefined ? null : archived.expected,
      recordedResultMatched: archived.expected !== undefined
        && (archived.kind === 'draw' ? finalStatus.over && !finalStatus.winner : finalStatus.winner === archived.expected),
      plies: rows.length,
      initialStateHash: hash64(canonical(initial)),
      finalStateHash: hash64(canonical(st)),
      finalStatus,
      moves: rows,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 数据集组装
 * ------------------------------------------------------------------ */

async function collect(BG) {
  const ids = Object.keys(BG.games);
  const per = new Map(ids.map((id) => [id, { id, selfPlay: null, archive: [] }]));

  for (const id of ids) per.get(id).selfPlay = await selfPlay(BG, id);
  for (const file of listArchiveFiles()) {
    const { engineId, record } = replayArchive(BG, file);
    if (!per.has(engineId)) per.set(engineId, { id: engineId, selfPlay: null, archive: [] });
    per.get(engineId).archive.push(record);
  }
  return per;
}

/* git 信息：commit 决定「金样出自哪份代码」，脏工作区必须显式标出来——
 * 否则 commit 相同、代码不同，比对结论就是错的。只跑只读命令。 */
function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (_) { return null; } // 无 git / 非仓库：记 null，不影响生成
  };
  const commit = run(['rev-parse', 'HEAD']);
  const dirty = run(['status', '--porcelain']);
  return { commit: commit || 'unknown', workTreeDirty: dirty === null ? null : dirty.length > 0 };
}

function datasetFor(BG, meta, entry) {
  const engine = BG.games[entry.id];
  const archivePlies = entry.archive.reduce((s, g) => s + g.plies, 0);
  return {
    schema: SCHEMA,
    engine: entry.id,
    engineName: engine.name,
    sides: engine.sides.map((s) => ({ id: s.id, name: s.name })),
    codeVersion: BG.codeVersion,
    commit: meta.commit,
    workTreeDirty: meta.workTreeDirty,
    seed: SEED,
    bgFast: process.env.BG_FAST === '1',
    generator: 'test/parity/generate.mjs',
    regenerate: 'node test/parity/generate.mjs',
    rowFields: ROW_FIELDS,
    fingerprint: {
      canonical: '递归按键名排序的 JSON（数组保序，中文按 UTF-16 码元参与哈希）',
      hash: 'FNV-1a 64 位，16 位小写十六进制',
      legal: 'getLegalMoves() 返回顺序的 notation 用 \\n 连接后哈希（顺序是契约的一部分）',
      state: 'applyMove 之后完整 state 的规范串哈希',
      status: 'getStatus() 规范串哈希（含 reason 全文）',
    },
    coverage: {
      selfPlayGames: entry.selfPlay ? 1 : 0,
      selfPlayPlies: entry.selfPlay ? entry.selfPlay.plies : 0,
      archiveGames: entry.archive.length,
      archivePlies,
      totalPlies: (entry.selfPlay ? entry.selfPlay.plies : 0) + archivePlies,
    },
    selfPlay: entry.selfPlay,
    archive: entry.archive,
  };
}

/* ------------------------------------------------------------------ *
 * 输出：紧凑但可读的 JSON（数组内的原始值一行一个数组，即「一手一行」）
 * ------------------------------------------------------------------ */

function indent(n) { return '  '.repeat(n); }

/* 为什么手写序列化：JSON.stringify(_, null, 2) 会把 [notation, 225, "…"] 拆成 7 行，
 * 5000+ 手就是 3.5 万行、体积翻倍且完全没法肉眼比对手数。这里让「原始值数组」保持单行。 */
function stringifyPretty(v, level = 0) {
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return '[' + v.map((x) => JSON.stringify(x)).join(',') + ']';
    if (v.length === 0) return '[]';
    return '[\n' + v.map((x) => indent(level + 1) + stringifyPretty(x, level + 1)).join(',\n') + '\n' + indent(level) + ']';
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    return '{\n' + keys.map((k) => indent(level + 1) + JSON.stringify(k) + ': ' + stringifyPretty(v[k], level + 1)).join(',\n') + '\n' + indent(level) + '}';
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

/* ------------------------------------------------------------------ *
 * 例外登记表校验（ADR-0008 的纪律：不许静默放宽）
 * ------------------------------------------------------------------ */

const EXCEPTION_FIELDS = ['engine', 'scope', 'field', 'oldFingerprint', 'newFingerprint', 'reason', 'counterexample', 'adr', 'approvedBy', 'approvedAt'];
/* field 白名单：只允许登记金样里真实存在的字段。限定成枚举是为了让「例外」可被机器核对——
 * 写错字段名的例外等于没有例外，而它看起来又像是登记过了，这种假登记比不登记更危险。 */
const EXCEPTION_TARGETS = ['notation', 'legalCount', 'legalHash', 'stateHash', 'over', 'winner', 'statusHash', 'finalStatus', 'plies'];

export function loadExceptions() {
  if (!fs.existsSync(EXCEPTIONS_FILE)) return { exceptions: [], present: false };
  const j = JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, 'utf8'));
  if (!Array.isArray(j.exceptions)) throw new Error('exceptions.json 结构不对：缺 exceptions 数组');
  j.exceptions.forEach((e, i) => {
    const at = 'exceptions.json 第 ' + (i + 1) + ' 条例外';
    for (const f of EXCEPTION_FIELDS) {
      if (typeof e[f] !== 'string' || e[f].trim().length === 0) throw new Error(at + ' 缺字段或为空：' + f);
    }
    if (!/^ADR-\d{4}$/.test(e.adr)) throw new Error(at + ' 的 adr 必须是 ADR-NNNN 形式，实际 ' + e.adr);
    if (!EXCEPTION_TARGETS.includes(e.field)) throw new Error(at + ' 的 field 不在金样字段白名单里：' + e.field);
    if (!['selfplay', 'archive'].includes(e.scope)) throw new Error(at + ' 的 scope 只能是 selfplay/archive，实际 ' + e.scope);
    if (e.scope === 'archive' && (typeof e.path !== 'string' || !e.path.endsWith('.json'))) throw new Error(at + ' scope=archive 必须给 path（games/... 相对路径）');
    if (e.scope === 'selfplay' && !Number.isInteger(e.ply)) throw new Error(at + ' scope=selfplay 必须给整数 ply');
    if (e.reason.trim().length < 40) throw new Error(at + ' 的 reason 至少 40 字（必须写清为什么旧行为要改）');
    if (e.counterexample.trim().length < 20) throw new Error(at + ' 的 counterexample 至少 20 字（必须给合成反例）');
    if (e.oldFingerprint === e.newFingerprint) throw new Error(at + ' 新旧指纹相同——没有差异就不该登记例外');
  });
  return { exceptions: j.exceptions, present: true };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

async function main() {
  /* 前置闸门：金样只能用**旧实现**生成。旧实现不在盘上就明确报错退出——
   * 宁可让 npm run golden 红，也不能悄悄产出一份「新实现的自证」。 */
  if (!legacyImplementationPresent()) {
    throw new Error(FROZEN_NOTICE);
  }

  const BG = loadLegacyEngines();
  const ids = Object.keys(BG.games);
  console.log('✓ 已加载旧实现：' + ids.length + ' 个引擎（' + ids.join(', ') + '）');
  console.log('  codeVersion=' + BG.codeVersion + '  BG_FAST=' + process.env.BG_FAST);

  const exc = loadExceptions();
  console.log('✓ 例外登记表：' + (exc.present ? exc.exceptions.length + ' 条例外' : '未创建（视为 0 条）'));

  const meta = gitInfo();
  console.log('✓ 代码版本：commit=' + meta.commit + '  workTreeDirty=' + meta.workTreeDirty);

  /* 第一次采集 */
  const runA = await collect(BG);
  const textA = new Map();
  for (const [id, entry] of runA) textA.set(id, stringifyPretty(datasetFor(BG, meta, entry)) + '\n');

  /* 第二次采集：同进程、重新设种子，逐字节比对。
   * 这是「同 seed 跑两次结果一致」的机内断言——不通过就直接退出，绝不写产物。 */
  const runB = await collect(BG);
  const diffs = [];
  for (const [id, entry] of runB) {
    const b = stringifyPretty(datasetFor(BG, meta, entry)) + '\n';
    const a = textA.get(id);
    if (a !== b) diffs.push(id + '（首个不同字节位于 ' + firstDiff(a, b) + '）');
  }
  if (diffs.length) {
    throw new Error('同 seed 两次采集结果不一致，金样不可信，已中止且未写任何文件：' + diffs.join('；'));
  }
  console.log('✓ 复现断言：同 seed 采集两遍，' + ids.length + ' 个引擎产物逐字节一致');

  /* 写产物（先算总量再落盘，超预算就不写，避免留下半份金样） */
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const written = [];
  let total = 0;
  for (const id of ids) {
    const content = textA.get(id);
    const buf = Buffer.from(content, 'utf8');
    total += buf.length;
    written.push({ id, file: path.join(OUT_DIR, id + '.json'), bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), content });
  }
  if (total > SIZE_BUDGET) {
    throw new Error('产物体积 ' + total + ' B 超过上限 ' + SIZE_BUDGET + ' B：指纹设计退化了，请改设计而不是放宽上限');
  }
  for (const w of written) fs.writeFileSync(w.file, w.content, 'utf8');

  console.log('\n产物（' + written.length + ' 个文件，合计 ' + total + ' B / 上限 ' + SIZE_BUDGET + ' B）：');
  let spPlies = 0; let arGames = 0; let arPlies = 0;
  for (const w of written) {
    const entry = runA.get(w.id);
    const sp = entry.selfPlay ? entry.selfPlay.plies : 0;
    const ap = entry.archive.reduce((s, g) => s + g.plies, 0);
    spPlies += sp; arGames += entry.archive.length; arPlies += ap;
    console.log('  test/fixtures/golden/' + w.id + '.json  ' + String(w.bytes).padStart(7) + ' B  ' +
      'sha256=' + w.sha256.slice(0, 16) + '…  自对弈 ' + sp + ' 手' + (entry.selfPlay && entry.selfPlay.plyLimitReached ? '(达上限截断)' : '') +
      '，历史棋谱 ' + entry.archive.length + ' 局/' + ap + ' 手');
  }
  console.log('  覆盖：自对弈 ' + written.length + ' 局/' + spPlies + ' 手，历史棋谱 ' + arGames + ' 局/' + arPlies + ' 手，合计 ' + (spPlies + arPlies) + ' 手');

  const mismatched = [];
  for (const [, entry] of runA) {
    for (const g of entry.archive) if (!g.recordedResultMatched) mismatched.push(g.file + '（归档：' + g.archivedResult + '）');
  }
  console.log('✓ 归档终局交叉验证：' + (arGames - mismatched.length) + '/' + arGames + ' 局与归档文案一致');
  for (const m of mismatched) console.log('  · 仅记录不阻断：' + m);

  if (exc.present && exc.exceptions.length) {
    console.log('⚠ 已登记 ' + exc.exceptions.length + ' 条刻意行为变更例外（见 test/parity/exceptions.json）：' +
      exc.exceptions.map((e) => e.engine + '/' + e.field).join(', '));
  }
  console.log('\n金样生成完成。');
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((e) => {
    console.error('\n✗ 金样生成失败：' + (e && e.message ? e.message : e));
    if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  });
}
