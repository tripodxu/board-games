/**
 * scripts/lib/ladder.mjs — 阶梯编排的纯逻辑（P6，D11/D12/D13/D14）
 *
 * 「阶梯」= 一组身份（`渠道:战术档:思考ms`）两两对阵的 round-robin，每对若干局，
 * **串行**跑在 box 上，产物落 `games.jsonl`，结束后可选推桶。本文件只管「怎么排」：
 * 计划生成、颜色对称的约束、断点状态、一行汇总、dry-run 表格；起进程/ssh/scp 在 CLI 里。
 *
 * 三条口径（写死在代码里，不靠注释提醒）：
 *   1. **颜色对称**：worker 的 `sidesForGameSpec()`（batch-common.mjs:122，镜像 experiment.ts:128-138）
 *      让 A 在奇数局执黑；开局库 `openingForNo()` 又按「连续两局同一开局换色」派开局
 *      （openings.mjs）。⇒ 每对局数必须是**偶数**，否则最后一局既没有换色对手、也没有配对开局，
 *      那一局就变成了「谁抽到顺手开局」的噪声。`normalizeGames()` 直接拒绝奇数。
 *   2. **身份口径 = 归档导出口径**，不是 spec 文本口径：`tacticsLabel()`（src/core/view/duel.ts:78）
 *      规定 rapfi/mock 不过战术层 ⇒ 它们的战术档写空串；`thinkMsOf()`（src/core/record/export.ts:114）
 *      规定只有 rapfi 的思考时长有意义。所以 `rapfi:v14-live3-fresh:500` 的身份是 **`rapfi||500`**，
 *      而 `official:v13-pressure-gate:0` 的身份是 `official|v13-pressure-gate|0`。
 *      阶梯报表、断点状态、与历史轮次对齐全靠这一条（`identityOfSpec()`）。
 *   3. **状态是文件**（D13）：`ladder.json` 原子写，每轮结束落一次；中断后重跑同一命令即续跑。
 *      「跑完了」的判据是**远端产物行数**（`games.jsonl` 行数 ≥ `games`），不是本地状态说 ok ——
 *      状态文件坏了/被删了也不该把已跑完的轮次重跑一遍。
 *
 * 零依赖、纯函数（除 `readLadderState`/`writeLadderState`/`ladderDir` 这三处文件 IO）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { batchTag, formatSpec, identityOf, parseSpec, sanitizeBatchId, UPSTREAM_CHANNELS } from './batch-common.mjs';

export const LADDER_VERSION = 1;

/** 阶梯里会用到的身份（§7）：5 个版本臂 + 3 个 Rapfi 时间档。 */
export const VERSION_SPECS = [
  'official:v10-live3:0',
  'official:v11-vct:0',
  'official:v12-vct-def:0',
  'official:v13-pressure-gate:0',
  'official:v14-live3-fresh:0',
];
export const RAPFI_SPECS = [
  'rapfi:v14-live3-fresh:500',
  'rapfi:v14-live3-fresh:1000',
  'rapfi:v14-live3-fresh:2000',
];
export const RAPFI_5000 = 'rapfi:v14-live3-fresh:5000';

/**
 * 三条预设阶梯（§7 表）。注意 L2 **不是** 8 个身份的 round-robin（那会多出 10 对版本内战 + 3 对
 * Rapfi 内战 = 28 对），而是「5 版 × 3 档」的**笛卡尔积 15 对**。`extras` 是不在配对里的额外对决
 * （L3 的 `rapfi@5000` 只跟 `@1000` 打，不打全部 —— 5000 档每局 ~8 min，全打烧不起）。
 */
export const PRESETS = {
  L1: { title: 'L1 版本内侧梯（5 版两两）', mode: 'roundRobin', specs: VERSION_SPECS, extras: [] },
  L2: { title: 'L2 各版对 Rapfi（5 版 × 3 档）', mode: 'cross', left: VERSION_SPECS, right: RAPFI_SPECS },
  L3: { title: 'L3 Rapfi 思考时间曲线', mode: 'roundRobin', specs: RAPFI_SPECS, extras: [] },
};
/** L3 的可选加档（`--with-5000`）：只加一条 `@5000 vs @1000`。 */
export const L3_EXTRA_5000 = [RAPFI_5000, 'rapfi:v14-live3-fresh:1000'];

/** 导出侧身份（与归档/报表一致）——见文件头口径 2。 */
export function identityOfSpec(spec) {
  const cfg = typeof spec === 'string' ? parseSpec(spec) : spec;
  const channel = String(cfg.channel || '');
  const tactics = channel === 'rapfi' || channel === 'mock' ? '' : String(cfg.tactics || '');
  const think = channel === 'rapfi' && Number.isFinite(Number(cfg.thinkMs)) && Number(cfg.thinkMs) > 0
    ? Math.round(Number(cfg.thinkMs)) : 0;
  const id = identityOf({ channel, tactics, thinkMs: think });
  return { id, channel, tactics, think };
}

/** 无向对键（A vs B 与 B vs A 是同一对；身份口径见上）。 */
export function pairKey(a, b) {
  const x = identityOfSpec(a).id;
  const y = identityOfSpec(b).id;
  return x <= y ? `${x} vs ${y}` : `${y} vs ${x}`;
}

/**
 * round-robin：输入顺序里两两组合，再补 `extras`（每项 `[specA, specB]`）。
 * 去重按 `pairKey`（同一对只跑一次）；同一身份自己打自己不排（那是自对弈校准，不是阶梯）。
 */
export function roundRobin(specs, { extras = [] } = {}) {
  const list = (specs || []).map((s) => (typeof s === 'string' ? s.trim() : s)).filter(Boolean);
  if (list.length < 2) throw new Error(`阶梯至少要 2 个身份，收到 ${list.length} 个`);
  const out = [];
  const seen = new Set();
  const push = (a, b) => {
    const key = pairKey(a, b);
    if (seen.has(key)) return;
    if (identityOfSpec(a).id === identityOfSpec(b).id) return;
    seen.add(key);
    out.push({ a, b, key });
  };
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) push(list[i], list[j]);
  }
  for (const e of extras || []) {
    if (!Array.isArray(e) || e.length !== 2) throw new Error(`extras 每项要 [a, b]：${JSON.stringify(e)}`);
    push(e[0], e[1]);
  }
  return out;
}

/** 逗号分隔的身份列表 → 数组（去空、去重保序）。 */
export function parseIdentityList(text) {
  const list = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (out.length < 2) throw new Error(`--identities 至少两个（逗号分隔）：${text}`);
  return out;
}

/** 笛卡尔积对决（L2：5 版 × 3 档 = 15 对）；同一身份自己打自己不排。 */
export function crossPairs(left, right) {
  const out = [];
  const seen = new Set();
  for (const a of left || []) {
    for (const b of right || []) {
      const key = pairKey(a, b);
      if (seen.has(key) || identityOfSpec(a).id === identityOfSpec(b).id) continue;
      seen.add(key);
      out.push({ a, b, key });
    }
  }
  return out;
}

/**
 * 预设阶梯 → `{title, pairs}`。`--with-5000` 只改 L3（加一条 `@5000 vs @1000`）。
 * 未知预设抛错（CLI 转 exit 2），不做静默回落。
 */
export function pairsForPreset(name, { with5000 = false } = {}) {
  const key = String(name || '').toUpperCase();
  const preset = PRESETS[key];
  if (!preset) throw new Error(`未知阶梯预设 "${name}"，合法值：${Object.keys(PRESETS).join(', ')}（或 all）`);
  if (key === 'L3') {
    return {
      title: preset.title,
      pairs: roundRobin(preset.specs, { extras: with5000 ? [L3_EXTRA_5000] : [] }),
    };
  }
  if (preset.mode === 'cross') return { title: preset.title, pairs: crossPairs(preset.left, preset.right) };
  return { title: preset.title, pairs: roundRobin(preset.specs, { extras: preset.extras || [] }) };
}

/** `all` = L1 + L2 + L3 合并（按 pairKey 去重）。 */
export function pairsForAll({ with5000 = false } = {}) {
  const out = [];
  const seen = new Set();
  const titles = [];
  for (const key of Object.keys(PRESETS)) {
    const { title, pairs } = pairsForPreset(key, { with5000 });
    titles.push(title);
    for (const p of pairs) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      out.push(p);
    }
  }
  return { title: titles.join(' + '), pairs: out };
}
/**
 * 每对局数：≥2 的**偶数**整数。奇数的理由见文件头口径 1（颜色/开局都不再配对）。
 * `allowOdd` 只给「我就想看个大概」的临时跑动留口子，并在返回里标出来让 CLI 打警告。
 */
export function normalizeGames(n, { allowOdd = false } = {}) {
  const games = Number(n);
  if (!Number.isInteger(games) || games < 2) throw new Error(`每对局数必须是 ≥2 的整数：${n}`);
  if (games % 2 === 1 && !allowOdd) {
    throw new Error(`每对局数必须是偶数（收到 ${games}）：奇数会让最后一局既没有换色对手、也没有配对开局，` +
      '那一局就成了「谁抽到顺手开局」的噪声（见 scripts/lib/ladder.mjs 文件头口径 1）。确实要看就用 --allow-odd。');
  }
  return games;
}

/** 一轮的多行文本计划（dry-run 与轮次头都用它，保证「表里写的 = 真跑的」）。 */
export function roundLabel(pair) {
  return `${identityOfSpec(pair.a).id} vs ${identityOfSpec(pair.b).id}`;
}

/** 一行汇总（轮次结束时打印）。`result` = `{status, wdl, durationMs, error}`。 */
export function formatRoundLine(round, result = {}) {
  const mark = result.status === 'ok' ? '✅' : result.status === 'failed' ? '❌' : result.status === 'skipped' ? '⏭️' : '…';
  const wdl = result.wdl || { w: 0, d: 0, l: 0 };
  const secs = Number(result.durationMs) > 0 ? `${Math.round(Number(result.durationMs) / 1000)}s` : '—';
  const err = result.error ? ` ${String(result.error).slice(0, 60)}` : '';
  return `[${round.round}] ${mark} ${round.label} ${round.games} 局 W${wdl.w}-D${wdl.d}-L${wdl.l} ${secs}${err}`;
}

/**
 * 一轮的墙钟粗估（秒）。只用来给「今晚跑哪条」排序，**不写进报表**。
 * 锚点都是实测：
 *   - 每局手数按 60 手（归档 312 局 / 19298 手 ≈ 62；P4b box 验收两局 27 与 80 手）；
 *   - 上游臂每手 ~1.1 s（P4b box 验收：27 手 26 s、80 手 89 s，含模型往返 + 战术层）；
 *   - 本地臂（rapfi）每手 ~think/2（平均一半的着法是它下的）+ 50 ms 落子开销。
 */
export function estimateRoundSeconds(round, { avgPlies = 60 } = {}) {
  const specs = [String(round.a || ''), String(round.b || '')].filter(Boolean).map((s) => s.split(':'));
  const perPly = specs.reduce((acc, [channel, , think]) => {
    if (UPSTREAM_CHANNELS.includes(channel)) return acc + 1.1;
    if (channel === 'rapfi') return acc + (Number(think) || 0) / 2000;
    return acc + 0.05; // mock/random
  }, 0.05);
  return Math.round(round.games * avgPlies * perPly);
}

/** dry-run 表格：`# / 对阵 / 局数 / 开局 / 预计`。 */
export function formatLadderTable(rounds, { avgGameS = null, estimateOf = null } = {}) {
  const rows = rounds.map((r) => {
    const secs = estimateOf ? estimateOf(r) : (avgGameS ? r.games * avgGameS : null);
    const est = Number.isFinite(secs) && secs > 0 ? `≈${Math.round(secs / 60)}m` : '—';
    return `| ${r.round} | ${r.label} | ${r.games} | ${r.openings ? path.basename(r.openings) : '（不用开局库）'} | ${est} |`;
  });
  return [
    '| # | 对阵 | 局数 | 开局 | 预计 |',
    '|---|---|---|---|---|',
    ...rows,
  ];
}

/**
 * 生成整条阶梯：身份 → 对决 → 逐轮计划（每轮 = 一个 worker plan）。
 * `now` 必须显式传入（tag 要可复现；不要读时钟）；局数走 `normalizeGames()` 闸门
 * （奇数要 `allowOdd`，理由见口径 1）。
 */
export function buildLadder({
  ladderId, specs, extras = [], pairs = null, games, openings = null, now, seed,
  store = 'local', upstream = 'direct', rateLimit = 30, keyFile = '/root/.jev-key',
  origin = null, remoteRoot = '/root/board-games', pauseMs = 2500, timeoutMin = 180,
  stallMin = 15, maxPlies = 225, topK = 3, dryRun = false, allowOdd = false,
}) {
  const id = sanitizeBatchId(ladderId);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('buildLadder 需要显式 now（Date）');
  // 局数闸门在这里（不是只在 CLI）：奇数局会让最后一局既没有换色对手、也没有配对开局。
  const perPair = normalizeGames(games, { allowOdd });
  const list = pairs && pairs.length ? pairs : roundRobin(specs, { extras });
  if (!list.length) throw new Error('这条阶梯没有任何对决（身份是否重复了？）');
  const rounds = list.map((pair, i) => {
    const round = i + 1;
    const tag = batchTag(now, id, round);
    return {
      round,
      a: pair.a,
      b: pair.b,
      key: pair.key,
      label: roundLabel(pair),
      games: perPair,
      openings,
      tag,
      outDir: `${remoteRoot}/.work/remote/${id}/round-${round}`,
      plan: {
        batchId: id,
        round,
        tag,
        games: perPair,
        a: formatSpec(parseSpec(pair.a)),
        b: formatSpec(parseSpec(pair.b)),
        pauseMs,
        timeoutMin,
        stallMin,
        maxPlies,
        topK,
        seed,
        dryRun,
        origin,
        store,
        upstream,
        rateLimit,
        keyFile,
        openings,
        outDir: `${remoteRoot}/.work/remote/${id}/round-${round}`,
      },
    };
  });
  return {
    version: LADDER_VERSION,
    ladderId: id,
    createdAt: now.toISOString(),
    gamesPerPair: perPair,
    openings,
    store,
    upstream,
    remoteRoot,
    totalGames: rounds.reduce((s, r) => s + r.games, 0),
    rounds,
  };
}

/* ---------------- 断点状态（D13） ---------------- */

export function ladderDir(root, ladderId) {
  return path.join(root, '.work/remote', sanitizeBatchId(ladderId));
}
export function stateFile(root, ladderId) {
  return path.join(ladderDir(root, ladderId), 'ladder.json');
}
export function planFile(root, ladderId, round) {
  return path.join(ladderDir(root, ladderId), 'plans', `round-${round}.json`);
}

/** 初始状态：全部 pending（`status: 'pending'`）。 */
export function newLadderState(ladder) {
  return {
    version: LADDER_VERSION,
    ladderId: ladder.ladderId,
    createdAt: ladder.createdAt,
    updatedAt: ladder.createdAt,
    rounds: ladder.rounds.map((r) => ({
      round: r.round, label: r.label, games: r.games, tag: r.tag, status: 'pending',
      wdl: null, durationMs: null, error: null, at: null, remoteLines: null,
    })),
  };
}

/** 纯函数：记一轮结果，返回新状态（rounds 按轮号排序）。 */
export function applyRoundResult(state, round, result, { now } = {}) {
  const at = now instanceof Date ? now.toISOString() : new Date().toISOString();
  const rows = state.rounds.map((r) => (r.round === round.round
    ? {
      ...r,
      status: result.status,
      wdl: result.wdl || r.wdl,
      durationMs: result.durationMs ?? r.durationMs,
      error: result.error ?? null,
      remoteLines: result.remoteLines ?? r.remoteLines,
      at,
    }
    : r));
  return { ...state, rounds: rows.sort((a, b) => a.round - b.round), updatedAt: at };
}

/**
 * 该跳过哪些轮：本地状态 `ok` **且** 远端产物行数 ≥ 局数。
 * 只看本地状态会把「状态说 ok、产物被删/没写完」的轮次当成已完成（静默丢数据）；
 * 只看远端行数会把「上一轮 ok 但 games.jsonl 被截断」当成没跑（白烧上游）。
 * 两个都满足才跳过；`--force` 全跑。
 */
export function resumeDecisions(state, { force = false, remoteLines = {} } = {}) {
  return state.rounds.map((r) => {
    if (force) return { round: r.round, skip: false, reason: 'forced' };
    if (r.status !== 'ok') return { round: r.round, skip: false, reason: r.status };
    const lines = remoteLines[r.round];
    if (Number.isFinite(lines) && lines < r.games) {
      return { round: r.round, skip: false, reason: `状态 ok 但远端只有 ${lines}/${r.games} 局` };
    }
    if (!Number.isFinite(lines)) return { round: r.round, skip: false, reason: '远端行数未知（不跳过）' };
    return { round: r.round, skip: true, reason: 'ok' };
  });
}

/** 汇总：进度 + 按轮均时估的 ETA（样本不足给 null，不编数字）。 */
export function summarizeLadder(state, { nowMs = Date.now() } = {}) {
  const rounds = state.rounds;
  const total = rounds.length;
  const done = rounds.filter((r) => r.status === 'ok').length;
  const failed = rounds.filter((r) => r.status === 'failed').length;
  const gamesDone = rounds.filter((r) => r.status === 'ok').reduce((s, r) => s + r.games, 0);
  const gamesTotal = rounds.reduce((s, r) => s + r.games, 0);
  const wdl = { w: 0, d: 0, l: 0 };
  for (const r of rounds) {
    if (r.status !== 'ok' || !r.wdl) continue;
    wdl.w += r.wdl.w || 0; wdl.d += r.wdl.d || 0; wdl.l += r.wdl.l || 0;
  }
  const durations = rounds.filter((r) => r.status === 'ok' && Number(r.durationMs) > 0).map((r) => r.durationMs);
  const meanRoundS = durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length / 1000) : null;
  const remaining = total - done;
  const etaS = meanRoundS === null ? null : (remaining > 0 ? meanRoundS * remaining : 0);
  const startedAtMs = Date.parse(state.createdAt);
  const elapsedS = Number.isFinite(startedAtMs) ? Math.max(0, Math.round((nowMs - startedAtMs) / 1000)) : null;
  return { total, done, failed, pending: total - done - failed, gamesDone, gamesTotal, wdl, meanRoundS, etaS, elapsedS };
}

export function formatLadderProgress(state, { nowMs = Date.now() } = {}) {
  const s = summarizeLadder(state, { nowMs });
  const eta = s.etaS === null ? 'ETA ?' : `ETA ${Math.round(s.etaS / 60)}m`;
  const elapsed = s.elapsedS === null ? '' : `已跑 ${Math.round(s.elapsedS / 60)}m `;
  return `${state.ladderId} ${s.done}/${s.total} 轮｜${s.gamesDone}/${s.gamesTotal} 局｜W${s.wdl.w}-D${s.wdl.d}-L${s.wdl.l}｜${elapsed}${eta}`;
}

export function readLadderState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !Array.isArray(raw.rounds)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 原子写（`.tmp` + rename）：断电/被 kill 也不会留下半截 JSON。 */
export function writeLadderState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** 写出每轮 plan（本地 `.work/remote/<ladderId>/plans/round-<i>.json`）。 */
export function writePlans(root, ladder) {
  const out = [];
  for (const r of ladder.rounds) {
    const file = planFile(root, ladder.ladderId, r.round);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r.plan, null, 2)}\n`);
    out.push(file);
  }
  return out;
}
