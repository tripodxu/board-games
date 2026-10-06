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
import { ETA_SAMPLES } from './progress.mjs';

export const LADDER_VERSION = 1;

/** 阶梯里会用到的身份（§7）：5 个版本臂 + 3 个 Rapfi 时间档。
 * 刻意**不含** v14-plus：L1/L2/L4 预设的形状已被历史批次与单测钉死（加臂 = 篡改预设）；
 * v14-plus 的配对验证轮用显式 `--identities 'official:v14-plus:0,official:v14-live3-fresh:0'`（ADR-0023）。 */
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
 * Rapfi 高思考档（业主 2026-10-04 定：把曲线补到 UI 上限）。
 * 口径：**只列 L2 里没有的档**（500/1000/2000 已有各 100 局），所以这里是 7000 与 10000（= UI 上限）。
 * 合并报表时要把 `l2n1` 的轮次与本档轮次放进同一个目录树（见 L4 的说明）。
 */
export const RAPFI_HIGH_SPECS = [
  'rapfi:v14-live3-fresh:7000',
  'rapfi:v14-live3-fresh:10000',
];

/**
 * 四条预设阶梯（§7 表）。注意 L2 **不是** 8 个身份的 round-robin（那会多出 10 对版本内战 + 3 对
 * Rapfi 内战 = 28 对），而是「5 版 × 3 档」的**笛卡尔积 15 对**。`extras` 是不在配对里的额外对决
 * （L3 的 `rapfi@5000` 只跟 `@1000` 打，不打全部 —— 5000 档每局 ~8 min，全打烧不起）。
 * L4 与 L2 同形，只是右臂换成高思考档（`@7000`/`@10000`）⇒ 10 对 / 200 局。
 */
export const PRESETS = {
  L1: { title: 'L1 版本内侧梯（5 版两两）', mode: 'roundRobin', specs: VERSION_SPECS, extras: [] },
  L2: { title: 'L2 各版对 Rapfi（5 版 × 3 档）', mode: 'cross', left: VERSION_SPECS, right: RAPFI_SPECS },
  L3: { title: 'L3 Rapfi 思考时间曲线', mode: 'roundRobin', specs: RAPFI_SPECS, extras: [] },
  L4: {
    title: 'L4 各版对 Rapfi 高思考档（5 版 × 7000/10000 ms）',
    mode: 'cross',
    left: VERSION_SPECS,
    right: RAPFI_HIGH_SPECS,
  },
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

/** `all` = L1 + L2 + L3 + L4 合并（按 pairKey 去重）。 */
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
  backupKeyFile = '/root/.cc-key', expectBackup = false,
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
        /* C2：兜底 key 文件（可选）+ 「本轮要求兜底可用」。默认 false ⇒ 没有兜底 key 也不算错。 */
        backupKeyFile,
        expectBackup,
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
      // tag 要跟着本轮实际用的走：--force（或状态里没记 tag）会生成新 tag，
      // 状态若还留着旧 tag，下次续跑就会「沿用旧 tag」⇒ 与 checkpoint 的 tag 不符 ⇒ 整轮重放。
      tag: round.tag || r.tag,
      at,
    }
    : r));
  return { ...state, rounds: rows.sort((a, b) => a.round - b.round), updatedAt: at };
}

/**
 * 旧尝试的产物目录名：`--force` 或 tag 变了 ⇒ checkpoint 不再命中 ⇒ 这一轮会从头重下，
 * 旧 attempts 的 `games.jsonl` 若留在 `round-N/` 里，会把 W/D/L 与「这轮跑完没有」算成两次
 * （实测：`p6kil` 4 局的一轮留下 **7 行**，W3-D1-L3）。挪开而不是删掉——证据留着，计数不受影响。
 * 刻意**不以 `round-` 开头**，免得被 `remoteLineCounts` 的 `round-*` 通配扫到。
 */
export function staleDirName(round, oldTag) {
  const t = String(oldTag || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
  return `stale-round-${round}-${t}`;
}

/**
 * 哪些轮「这次要用新 tag 重跑，而远端还留着旧 tag 的产物」⇒ 起跑前把旧目录挪开。
 * 只在**确知旧 tag 与新 tag 不同**时才动（tag 相同 ⇒ checkpoint 会命中，动了就等于丢数据）；
 * 跳过的轮、远端行数为 0 的轮也不动。返回 `[{ round, oldTag, stale }]`。
 */
export function staleCleanups(ladder, oldTags = {}, { skipRounds = [], remoteLines = {} } = {}) {
  const skip = new Set(skipRounds.map(Number));
  return ladder.rounds
    .filter((r) => !skip.has(Number(r.round)) && Number(remoteLines[r.round] || 0) > 0)
    .map((r) => ({ round: r.round, oldTag: oldTags[r.round] || null, stale: staleDirName(r.round, oldTags[r.round]), tag: r.tag }))
    .filter((x) => x.oldTag && x.oldTag !== x.tag)
    .map(({ round, oldTag, stale }) => ({ round, oldTag, stale }));
}

/**
 * 该跳过哪些轮：**以远端产物行数为准**（这一轮到底跑没跑，远端 games.jsonl 说了算），
 * 本地状态只用来记账，不再当闸门 —— 状态文件丢了/形状换了（改过 --games、--max-rounds）
 * 都不该让已经跑完的轮次再烧一遍上游。本地缺产物时由调用方补拉（CLI 的 pullRound）。
 * 远端行数未知（ssh 不通）时不跳过：宁可白跑也不静默丢数据。
 * `--force` 全跑。
 */
export function resumeDecisions(state, { force = false, remoteLines = {} } = {}) {
  return state.rounds.map((r) => {
    if (force) return { round: r.round, skip: false, reason: 'forced' };
    const lines = remoteLines[r.round];
    if (!Number.isFinite(lines)) {
      return { round: r.round, skip: false, reason: r.status === 'ok' ? '远端行数未知（不跳过）' : r.status };
    }
    if (lines < r.games) return { round: r.round, skip: false, reason: `远端只有 ${lines}/${r.games} 局` };
    return { round: r.round, skip: true, reason: r.status === 'ok' ? 'ok' : `远端已有 ${lines}/${r.games} 局` };
  });
}

/** 本地状态与本次计划是否同一个形状（轮数/轮号/对阵/局数）。不同就以本次计划重建。 */
export function stateMatchesLadder(state, ladder) {
  if (!state || !Array.isArray(state.rounds) || !ladder || !Array.isArray(ladder.rounds)) return false;
  if (state.rounds.length !== ladder.rounds.length) return false;
  return state.rounds.every((r, i) => r.round === ladder.rounds[i].round
    && r.label === ladder.rounds[i].label
    && r.games === ladder.rounds[i].games);
}

/**
 * 复用已有轮次的 tag：`experiment-worker.mjs` 的 checkpoint 是**按 tag 命中**的
 * （`ckptAction` 里 `prev.tag !== tag ⇒ tag-mismatch ⇒ 重跑本局`），所以续跑必须沿用原 tag，
 * 否则被中断的那一轮会整轮重放，`games.jsonl` 追加出多于局数的记录。
 * 取值优先级：本地状态里的 tag → 远端 plan 里的 tag → 本次新生成的 tag。
 * `--force` 的真重跑不走这里（CLI 侧跳过），这样才可能真的重下一遍。
 */
export function withReusedTags(ladder, oldState, remoteTags = {}) {
  const rounds = ladder.rounds.map((r) => {
    const prev = oldState && Array.isArray(oldState.rounds)
      ? oldState.rounds.find((x) => x.round === r.round && x.tag) : null;
    const tag = (prev && prev.tag) || remoteTags[r.round] || r.tag;
    if (tag === r.tag) return r;
    return { ...r, tag, plan: { ...r.plan, tag } };
  });
  return { ...ladder, rounds };
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

/**
 * 解析「本地轮询」那条 ssh 的一次性回值（纯函数，便于单测）。
 * 远端一次回两段：第一行 `alive`（worker pid 还在）/ `done`（pid 没了），其后是 `progress.json` 原文。
 *
 * 为什么要本地轮询：早先的写法是让远端跑 `for i in $(seq 1 1440); do … sleep 30; done` 一条 ssh 挂 12h。
 * 那条 ssh 继承了本进程的 stdout 管道 ⇒ 编排进程一旦意外死掉，管道写端还被它握着，外层 `| Tee-Object`
 * 永远等不到 EOF，作业就「running」到天荒地老（真发生过：round-1 早跑完，作业却停在 started 一行）。
 * 改成每分钟一次短 ssh、**捕获而非继承** stdout，最坏也只泄漏一个 ≤60s 的子进程。
 */
export function parsePollOutput(text) {
  const raw = String(text ?? '');
  const nl = raw.indexOf('\n');
  const head = (nl === -1 ? raw : raw.slice(0, nl)).trim();
  const rest = (nl === -1 ? '' : raw.slice(nl + 1)).trim();
  let progress = null;
  if (rest.startsWith('{')) {
    try { progress = JSON.parse(rest); } catch { progress = null; }
  }
  return { alive: head === 'alive', done: head === 'done', progress };
}

/** 一行进度（本地轮询每分钟打一次；没有 progress.json 时也说话，别让日志看起来像卡死）。 */
export function formatPollTick(round, progress, { elapsedS = null } = {}) {
  if (!progress) return `  ⏳ round-${round} 进行中（远端还没写 progress.json）`;
  const done = Number(progress.done || 0);
  const total = Number(progress.total || 0);
  const secs = elapsedS !== null && Number.isFinite(Number(elapsedS))
    ? Number(elapsedS)
    : (progress.elapsedS != null ? Number(progress.elapsedS) : null);
  const bits = [];
  if (secs !== null) bits.push(`${Math.round(secs)}s`);
  if (progress.meanGameS) bits.push(`近${ETA_SAMPLES}局均 ${progress.meanGameS}s/局`);
  if (progress.wdl) bits.push(`W${progress.wdl.w}-D${progress.wdl.d}-L${progress.wdl.l}`);
  return `  ⏳ round-${round} ${done}/${total} 局${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}

/**
 * 轮询一轮的远端探针（阶梯与 batch 共用，一次 ssh 的完整输出）：
 * 第一行 `alive` = 这轮的 worker 还在跑，`done` = pid 没了（或 pid 文件不在）；
 * 后面紧跟 `progress.json` 原文（可能为空），交给 `parsePollOutput()` 解。
 *
 * 为什么要「本地每分钟问一次」而不是「远端一条 ssh 守 12 h」：那条长命 ssh **继承 stdout 管道**，
 * 编排进程一旦意外死掉，外层 `| Tee-Object` 永远等不到 EOF，作业就假装还在跑（L3 第一晚实测踩到，
 * 只能靠 `Get-CimInstance Win32_Process` 才看清它还挂着）。
 */
export function pollRoundCommand({ pidPath, progressPath }) {
  return `pid=$(cat ${pidPath} 2>/dev/null); `
    + 'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo alive; else echo done; fi; '
    + `cat ${progressPath} 2>/dev/null`;
}

/** 同步睡：主线程唯一能用的同步等待（scp/ssh 重试之间用）。 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 远端起一轮 worker 的 shell（阶梯编排与 batch 入口共用）。
 *
 * 为什么要有它：同一个 `round-N/` 目录被**两个 worker 双写**会把 `games.jsonl` 灌成两份
 * （实测：编排自己起了一个，人手又起了一个，两分钟里两条进程同时写同一轮）。
 * 所以「pid 还活着就别再起」这条守卫放在**远端 shell** 里原子判断，而不是本地先查一遍 ——
 * 本地查完再起，中间隔着一次 12–20 s 的 ssh 握手，窗口关不掉。
 *
 * 两个分支都打印 `started pid=<数字>`：本地只当信息转述，不解析，也不靠它判断成功。
 */
export function launchRoundCommand({ repo, keyFile, planPath, logPath, pidPath }) {
  const keyInject = `set -a; [ -f ${keyFile} ] && . ${keyFile}; set +a;`;
  return `cd ${repo} && ${keyInject}`
    + ` if [ -f ${pidPath} ] && kill -0 "$(cat ${pidPath})" 2>/dev/null; then echo "started pid=$(cat ${pidPath})（已在跑，不重复起）";`
    + ` else nohup node scripts/experiment-worker.mjs --plan ${planPath} >> ${logPath} 2>&1 < /dev/null &`
    + ` echo $! > ${pidPath}; sleep 1; echo "started pid=$(cat ${pidPath})"; fi`;
}

/**
 * 同步重试（scp/ssh 用）。
 *
 * 为什么要有它：box 的 22 端口链路会**间歇性抽风** —— 几十次里挂一次，`scp` 直接 `exit=1`
 * 且没有任何 stderr（同一文件、同一命令行手工跑就成功），轮询里也见过
 * `ssh: connect to host … port 22: Connection timed out`。原来只重试一次，
 * L2 那一晚「上传 round-1 plan 失败」把续跑掐死了两次；而 `ssh` 那几处失败**不报错只回退**，
 * 回退的后果更坏（读 tag 失败会换新 tag 把整轮重放，数行数失败会把跑完的轮次再排一遍）。
 *
 * `fn` 返回 `false` 或抛错都算失败；`sleep` 可注入（单测不真睡）。
 * 返回 `{ ok, attempts }`，`attempts` 是实际用掉的次数（成功时为第几次成功）。
 */
export function retrySync(fn, { attempts = 3, sleepMs = 2000, sleep = sleepSync, onRetry } = {}) {
  for (let i = 1; i <= attempts; i++) {
    let ok = false;
    try {
      ok = fn() !== false;
    } catch {
      ok = false;
    }
    if (ok) return { ok: true, attempts: i };
    if (i < attempts) {
      if (onRetry) onRetry(i);
      if (sleep) sleep(sleepMs);
    }
  }
  return { ok: false, attempts };
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
