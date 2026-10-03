/**
 * scripts/experiment-worker.mjs — box 上的无人值守对弈 worker（纯 Node）
 *
 * 计划：docs/plans/2026-10-03-remote-batch-experiments.md §4（本轮不加浏览器依赖）。
 * 用法：node scripts/experiment-worker.mjs --plan .work/remote/<batch>/round-<i>/plan.json
 * 产出：
 *   <plan.outDir>/games/round-<r>-game-<n>.json    与线上归档同构的 payload（POST 原样体）
 *   <plan.outDir>/checkpoint/round-<r>-game-<n>.json 断点/失败隔离（kill -9 后重启跳过已完成局）
 *   <plan.outDir>/round-summary.json              轮次汇总
 * 关键口径（与浏览器实验路径逐字对齐的部份）：
 *   - 走子与归档：会话历史手工复刻 src/app/loop.ts:225-232 的 playMove 三行
 *     （push {ply,side,move,meta} → st = engine.applyMove）；decide 调用口径同 loop.ts:285-295；
 *   - meta.byAI = true（export.ts 的 aiMoveMeta/meta.ts 归因链依赖它）；
 *   - 归属信息 expInfo 字段同 experiment.ts:141-153（tag/gameNo/黑白渠道/战术档/思考）；
 *   - 自动退避 [4000,12000,25000] ms 复刻 loop.ts:66（限流/网络重试，机机无人值守必需）。
 * 与浏览器路径的已知偏差（记录在案，P3 前评估）：
 *   - experience 不喂（浏览器从 localStorage 战绩簿经 /api/openings 构建；Node 无战绩簿）；
 *   - 限流监听走 decide 自带 onRetry + 我们自己的退避，没有面板的状态机。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getGame } from '../src/core/registry.ts';
import { setSeed } from '../src/core/rng.ts';
import { createSession, randomGameUid } from '../src/core/session.ts';
import { buildGameExport, thinkMsOf } from '../src/core/record/export.ts';
import { tacticsLabel } from '../src/core/view/duel.ts';
import { decide } from '../src/core/jev/index.ts';
import {
  KNOWN_CHANNELS,
  UPSTREAM_CHANNELS,
  parseSpec,
  batchTag,
  sidesForGameSpec,
  deriveSeed,
  gameRecordName,
  identityOf,
} from './lib/batch-common.mjs';
import { installRapfiNodeLoader } from './lib/rapfi-node-loader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // scripts/ → 仓库根

/** loop.ts:66 同值：可重试失败（限流/网络）的退避序列。 */
const RETRY_DELAYS_MS = [4000, 12000, 25000];
/** 每手上游调用的看门狗默认值；plan 可覆盖。 */
const DEFAULTS = {
  games: 12, pauseMs: 2500, timeoutMin: 180, stallMin: 15, maxPlies: 225,
  topK: 3, seed: 20261003, dryRun: false, origin: 'https://jevqipan.logicc.top',
};

const log = (msg) => {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 小工具 ---------- */

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  // 原子写：先写 .tmp 再 rename——`kill -9` 只可能留下 .tmp，不会留半截 JSON
  // （半截 JSON 会被 playOne/loadRecords 静默跳过，等于悄悄少一局）。
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** 本轮跑的是哪个提交（Node 直载没有构建注入，`code_version` 恒为 dev+nogit ⇒ 只能自报）。
    纯 fs 读 `.git`，不 spawn 子进程。 */
function repoHead() {
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git/HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 12);
    const ref = head.slice(5);
    try { return fs.readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim().slice(0, 12); } catch (_) { /* packed-refs */ }
    const packed = fs.readFileSync(path.join(ROOT, '.git/packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.trim().endsWith(' ' + ref));
    return line ? line.trim().slice(0, 12) : 'ref-missing';
  } catch (_) { return 'nogit'; }
}

/** 远端批量不是浏览器设备，但带一个稳定的匿名身份：D1 里才能把这批机器跑出来的行
    与其它写入者（浏览器轮、历史导入）分开。ADR-0013 的 `X-Device-Id` 是可选的匿名身份，
    格式 `^[A-Za-z0-9_-]{8,64}$`（`src/worker/lib/validate.ts`）。可用 `BATCH_DEVICE_ID` 覆盖。 */
export const DEVICE_ID = process.env.BATCH_DEVICE_ID || 'ssh-batch';

let cachedCode = null;
/** 远端跑的提交自报（H2）：Node 直载没有构建注入，`games.code_version` 否则恒为 `dev+nogit`，
    D1 里就分不清「哪一版跑的」。形状与浏览器轮一致（`<版本>+<sha>`），缓存一次即可。 */
function codeOf() {
  if (cachedCode === null) cachedCode = `dev+nogit+${repoHead()}`;
  return cachedCode;
}

/** 一次真上游调用（row 形状与 GET /api/games 的 listItem 对齐，够核对即可）。 */
async function apiListByTag(origin, tag) {
  try {
    const r = await fetch(`${origin}/api/games?tag=${encodeURIComponent(tag)}&limit=100`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

/** 列表里是否已有这一局（uid 优先）。列表项是 camelCase（`gameUid`）。 */
async function alreadyArchived(origin, tag, gameUid) {
  const list = await apiListByTag(origin, tag);
  const rows = list && Array.isArray(list.games) ? list.games : [];
  return rows.some((r) => r.gameUid === gameUid || r.game_uid === gameUid);
}

/**
 * POST 一局棋谱：30 s 超时 + 3 次退避；4xx（除 429）判为不可重试直接抛出
 * （无重试/无超时的版本会在归档阶段挂住整轮，见合入审查 M5）。
 */
async function apiPostGame(origin, payload, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${origin}/api/games`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return await r.json();
      const err = new Error(`POST /api/games → HTTP ${r.status}`);
      if (r.status !== 429 && r.status < 500) err.fatal = true;
      throw err;
    } catch (e) {
      lastErr = e;
      if (e && e.fatal) throw e;
      if (i < attempts - 1) await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * 轮末补一行 `/api/experiments`（计划 §9 未闭环第 1 条：远端轮次只在棋谱里、没实验行）。
 *
 * 形状对齐浏览器 `newEntryFromRun()`（src/ui/panels/experiment-report.ts:613-642）：
 * `chanA/tacA/thinkA` 是「臂」口径（对阵双方），`games[]` 是「局」口径（黑白按局交替，
 * 每局的 sidesForGameSpec 与 playOne 同源）。`X-Device-Id` 不带：deviceMiddleware
 * 对缺失是 value:null 放行（src/worker/lib/validate.ts:35-40），不带即匿名。
 * 战术层耗时字段填 null——worker 不统计 per-side tac_ms，mapExperimentRecord 的
 * num() 会把 null 落进样本外（与「该侧没过战术层」同义）。
 */
export function experimentEntryFrom(plan, a, b, summary) {
  const games = [];
  for (const g of summary.games) {
    /* `ok` 与 `skipped`（续跑时按 checkpoint 跳过的局）都必须计入 —— 早先只收 ok 的写法会让续跑轮
       POST 出一行 total=0 的实验档案，同时把 skipped 算进 okCount ⇒ 出口码 0 的假绿。
       `ok-dry`（dry-run）与 `error` 不是真落库的局，照旧不计。 */
    if (g.status !== 'ok' && g.status !== 'skipped') continue;
    const { black, white } = sidesForGameSpec(a, b, g.gameNo);
    const winnerSide = g.winner === 'black' ? black : g.winner === 'white' ? white : null;
    games.push({
      no: g.gameNo,
      blackChan: black.channel,
      whiteChan: white.channel,
      // 与浏览器 `newEntryFromRun()` 同规则：档位只对会跑战术层的渠道有意义（rapfi/random 侧留空），
      // 思考档只对 rapfi 侧写（否则会造出 `rapfi|v13-pressure-gate` /「0 毫秒档」这类幻影身份）。
      blackTac: tacticsLabel({ channel: black.channel, tactics: black.tactics || undefined }) || null,
      whiteTac: tacticsLabel({ channel: white.channel, tactics: white.tactics || undefined }) || null,
      blackThink: thinkMsOf(black.channel, black.thinkMs) ?? null,
      whiteThink: thinkMsOf(white.channel, white.thinkMs) ?? null,
      winnerChan: winnerSide ? winnerSide.channel : null,
      by: null,
      blackTacMs: null,
      whiteTacMs: null,
      blackTacN: 0,
      whiteTacN: 0,
    });
  }
  return {
    tag: plan.tag,
    date: new Date().toISOString(),
    chanA: a.channel,
    chanB: b.channel,
    tacA: tacticsLabel({ channel: a.channel, tactics: a.tactics || undefined }) || null,
    tacB: tacticsLabel({ channel: b.channel, tactics: b.tactics || undefined }) || null,
    thinkA: thinkMsOf(a.channel, a.thinkMs) ?? 0,
    thinkB: thinkMsOf(b.channel, b.thinkMs) ?? 0,
    total: games.length,
    games,
    /* H2：Node 直载没有构建注入 ⇒ 每局 `code_version` 恒为 `dev+nogit`，远端跑的是哪个提交
       只能在档案里自报（summary/checkpoint 里也有 repoHead 字段）。 */
    note: `SSH 远端批量（experiment-batch.mjs）${summary.repoHead ? ` repo ${summary.repoHead}` : ''}`,
  };
}

/** 轮末 POST /api/experiments；429 退避两次（写限流 20 次/分，一轮只发一次，大概率不撞）。 */
async function apiPostExperiment(origin, entry) {
  let lastErr = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`${origin}/api/experiments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
        body: JSON.stringify(entry),
      });
      if (r.status === 429) throw new Error('HTTP 429 限流');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** 每侧 decide 入参（apiKey/endpoint 按渠道取；proxy 端点要拼 origin，client.ts:29 的 'api/jev' 是相对路径）。 */
function decideEnvFor(cfg, plan) {
  const apiKey = cfg.channel === 'openrouter'
    ? (process.env.JEV_OR_KEY || '')
    : (process.env.JEV_API_KEY || '');
  const endpoint = cfg.channel === 'proxy' ? `${plan.origin}/api/jev` : '';
  return { apiKey, endpoint };
}

/* ---------- 主流程 ---------- */

/**
 * checkpoint 命中时该怎么走（纯函数，便于单测）：
 * - `skip`：该局上次已跑完 ⇒ 直接计入 summary（**带上 winner/plies/gameUid**，否则实验档案里这局会凭空消失）；
 * - `run` + `resumeUid`：上次归档中途被杀 ⇒ 复用同一 gameUid 重跑（dedup_key 不变，D1 不会出现两份棋谱）；
 * - `run` + `reason: 'tag-mismatch'`：checkpoint 属于别的 tag（同名 batch 换了轮次）⇒ 必须重跑。
 * 早先只比 `status` 不比 `tag`，同日第二次 submit 会「一局不跑、exit 0、还 POST 一行实验档案」。
 */
export function ckptAction(prev, tag) {
  if (!prev || typeof prev !== 'object') return { action: 'run' };
  if (prev.tag && tag && prev.tag !== tag) return { action: 'run', reason: 'tag-mismatch' };
  if (prev.status === 'ok' || prev.status === 'ok-dry') {
    return {
      action: 'skip', from: prev.status,
      winner: prev.winner ?? null, plies: prev.plies ?? null, gameUid: prev.gameUid ?? null,
    };
  }
  if (prev.status === 'pending' && prev.gameUid) return { action: 'run', resumeUid: prev.gameUid };
  return { action: 'run' };
}

async function main() {
  const argv = process.argv.slice(2);
  const planPath = argOf(argv, '--plan');
  if (!planPath) {
    process.stderr.write('用法：node scripts/experiment-worker.mjs --plan <plan.json>\n');
    process.exitCode = 2;
    return;
  }
  const plan = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(planPath, 'utf8')) };
  const { round, tag, games, pauseMs, timeoutMin, stallMin, maxPlies, topK, seed, dryRun, origin } = plan;
  let a;
  let b;
  try {
    a = parseSpec(plan.a);
    b = parseSpec(plan.b);
  } catch (err) {
    process.stderr.write(`plan 里的臂不合法（a=${plan.a} / b=${plan.b}）：${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  // outDir 相对 cwd 解析（编排器在仓根启动 worker，plan 里通常给绝对路径）
  const outDir = path.resolve(process.cwd(), plan.outDir || `.work/remote/${plan.batchId}/round-${round}`);
  const gamesDir = path.join(outDir, 'games');
  const ckptDir = path.join(outDir, 'checkpoint');

  /* 前置校验：渠道/档位（parseSpec 已拦）、tag 形状、真上游 key 是否在位。
     缺 key 必须在开局前退出——不然每局都白跑十几分钟才失败（AGENTS.md「不在事后日志里备案」）。 */
  batchTag(new Date(), plan.batchId, round); // 形状校验（tag 本身用 plan 里的，时序以 submit 为准）
  /* rapfi 臂：装配 Node 侧胶水加载器（与浏览器同一条 core 协议路径，见
     scripts/lib/rapfi-node-loader.mjs 头部说明；缺资产会在这里早失败）。 */
  if (a.channel === 'rapfi' || b.channel === 'rapfi') {
    try {
      installRapfiNodeLoader();
    } catch (err) {
      process.stderr.write(`rapfi 臂加载失败：${err.message}\n`);
      process.exitCode = 2;
      return;
    }
  }
  for (const cfg of [a, b]) {
    if (UPSTREAM_CHANNELS.includes(cfg.channel)) {
      const need = cfg.channel === 'openrouter' ? process.env.JEV_OR_KEY : process.env.JEV_API_KEY;
      if (!need) {
        process.stderr.write(`渠道 ${cfg.channel} 需要 key（worker 启动环境变量，--dry-run 可绕开）\n`);
        if (!dryRun) { process.exitCode = 2; return; }
      }
    }
  }
  if (!KNOWN_CHANNELS.includes(a.channel) || !KNOWN_CHANNELS.includes(b.channel)) {
    process.stderr.write(`渠道不合法：${a.channel}/${b.channel}\n`);
    process.exitCode = 2;
    return;
  }

  ensureDir(gamesDir); ensureDir(ckptDir);
  const head = repoHead();
  log(`worker 起：batch=${plan.batchId} round=${round} tag=${tag} 对阵 ${a.channel} vs ${b.channel} ×${games} 局 dryRun=${dryRun} repoHead=${head} device=${DEVICE_ID}`);

  const summary = { batchId: plan.batchId, round, tag, repoHead: head, startedAt: new Date().toISOString(), games: [] };
  for (let gameNo = 1; gameNo <= games; gameNo++) {
    const ckptFile = path.join(ckptDir, gameRecordName(round, gameNo));
    let resumeUid = null;
    if (fs.existsSync(ckptFile)) {
      let act = { action: 'run' };
      try {
        act = ckptAction(JSON.parse(fs.readFileSync(ckptFile, 'utf8')), tag);
      } catch (_) { /* checkpoint 损坏则重跑该局 */ }
      if (act.action === 'skip') {
        log(`game-${gameNo} 已完成（${act.from}），跳过`);
        /* 续跑也必须把胜负带回 summary：早先只带 status 会让实验档案里这局凭空消失，
           同时再把 skipped 计入正常局数 ⇒ 出口码 0 的假绿。 */
        summary.games.push({ gameNo, status: 'skipped', from: act.from, winner: act.winner, plies: act.plies, gameUid: act.gameUid });
        continue;
      }
      if (act.reason === 'tag-mismatch') log(`game-${gameNo} checkpoint 的 tag 与本轮 ${tag} 不一致，重跑本局`);
      if (act.resumeUid) {
        resumeUid = act.resumeUid;
        log(`game-${gameNo} 上次归档未完成，复用 gameUid=${resumeUid} 重跑`);
      }
    }
    const one = await playOne(plan, a, b, gameNo, { gamesDir, ckptDir, resumeUid });
    summary.games.push({ gameNo, ...one });
    writeJson(ckptFile, { gameNo, tag, head, ...one });
    if (gameNo < games) await sleep(pauseMs);
  }
  summary.endedAt = new Date().toISOString();
  writeJson(path.join(outDir, 'round-summary.json'), summary);
  const okCount = summary.games.filter((g) => g.status === 'skipped' || g.status === 'ok' || g.status === 'ok-dry').length;
  /* 轮末补 experiments 行（只写真跑的局）：失败不坏出口码——棋谱才是主产物，
     实验行缺失时 status.md「实验轮」口径已在 ADR-0019 后果里交代。 */
  if (!dryRun && okCount > 0) {
    try {
      const resp = await apiPostExperiment(origin, experimentEntryFrom(plan, a, b, summary));
      log(`experiments 行已归档：tag=${plan.tag} total=${resp && resp.total != null ? resp.total : '?'}`);
    } catch (e) {
      log(`experiments 归档失败（棋谱不受影响）：${e.message || e}`);
    }
  }
  log(`worker 完：${okCount}/${games} 局正常`);
  /* rapfi 胶水的 Node 分支在程序退出时会 exit(1) 置位 process.exitCode
     （public/rapfi/rapfi-single-simd128.js:10 的 ha=(a,b)=>{process.exitCode=a;throw b}，
     stdin EOF/引擎 teardown 触发），纯噪声。这里按 summary 显式定出口码，把噪声与真实失败分开。 */
  process.exitCode = okCount === games ? 0 : 1;
}

/** 跑一局；返回写进 checkpoint 的结果对象（不出异常，失败也返回）。 */
async function playOne(plan, a, b, gameNo, dirs) {
  const { round, tag, timeoutMin, stallMin, maxPlies, topK, seed, dryRun, origin } = plan;
  const startedAt = Date.now();
  const t0 = new Date();
  const gameSeed = deriveSeed(seed, gameNo);
  setSeed(gameSeed); // D5：局号派生，互不覆盖、可复现

  const engine = getGame('gomoku');
  if (!engine) return { status: 'error', error: 'registry 无 gomoku' };

  const s = sidesForGameSpec(a, b, gameNo);
  const session = createSession({
    gameId: 'gomoku',
    // 续跑复用上次的 uid（见 main 的 pending 分支）：归档幂等的锚点
    gameUid: dirs.resumeUid || randomGameUid(),
    mode: 'ai-ai',
    startedAt,
  });
  session.expInfo = {
    tag,
    gameNo,
    blackChannel: s.black.channel,
    whiteChannel: s.white.channel,
    blackTactics: s.black.tactics,
    whiteTactics: s.white.tactics,
    blackThink: s.black.thinkMs,
    whiteThink: s.white.thinkMs,
  };
  /* st 初值：引擎新局（createSession 只给空壳，浏览器由 resetSession 填，见 src/app/ctx.ts）。 */
  session.st = engine.newGame();
  /* sideConfig 两槽填实，buildGameExport 的 slug/duelLabel/渠道兜底才与浏览器同口径
     （export.ts:33 只按 'black'/'white' 两槽查）。 */
  session.settings.sideConfig = {
    black: { channel: s.black.channel, tactics: s.black.tactics, rapfiThinkMs: s.black.thinkMs },
    white: { channel: s.white.channel, tactics: s.white.tactics, rapfiThinkMs: s.white.thinkMs },
  };
  /* effSide（persist.ts:176-187）对非 mock/rapfi/proxy 的渠道要 settings.apiKey 才认：
     没 key 时把 random 兜底成 mock，导出 slug/duel 就会把「随机」显示成「演示」
     （浏览器里用户配了 key 所以不触发；实测 rapfi1 批 slug=mock-vs-rapfi-0-5s）。
     这里把本局 key 透传进 settings，与浏览器同口径；export 不带 settings，不泄密。 */
  const gameApiKey = decideEnvFor(a, plan).apiKey || decideEnvFor(b, plan).apiKey;
  if (gameApiKey) session.settings.apiKey = gameApiKey;

  const deadline = startedAt + timeoutMin * 60000;
  const stallMs = stallMin * 60000;
  let retries = 0;
  let lastProgress = Date.now();

  try {
    for (;;) {
      const now = Date.now();
      if (now > deadline) throw new Error(`对局超时（timeoutMin=${timeoutMin}）`);
      if (now - lastProgress > stallMs) throw new Error(`对局停滞超时（stallMin=${stallMin} 无新着法）`);
      const g = engine.getStatus(session.st);
      if (g.over || session.history.length >= maxPlies) break;

      const side = g.turn || session.st.turn;
      const cfg = side === 'black' ? s.black : s.white;
      const { apiKey, endpoint } = decideEnvFor(cfg, plan);

      /* 看门狗：单步 decide 超过 stallMin 就 abort（decide 内置 30s HTTP 超时兜不住
         「连上了但一直不返回」；loop.ts:285 的同款 signal 用法）。 */
      const ac = new AbortController();
      const watchdog = setTimeout(() => ac.abort(new Error(`单步停滞 ${stallMin} 分钟`)), stallMs);
      let decision;
      try {
        decision = await decide(engine, session.st, side, {
          channel: cfg.channel,
          apiKey,
          endpoint,
          topK,
          rapfiThinkMs: cfg.thinkMs,
          tacticsVersion: cfg.tactics,
          signal: ac.signal,
          onRetry: (code, attempt) => log(`game-${gameNo} 限流(${code}) 退避重试 ${attempt}`),
        });
      } catch (e) {
        const retryable = Boolean(e && (e.retryable || String(e.message || e).includes('abort')));
        if (retryable && retries < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[retries++];
          log(`game-${gameNo} 第 ${retries} 次退避 ${delay}ms（${e.message || e}）`);
          await sleep(delay);
          continue;
        }
        throw e;
      } finally {
        clearTimeout(watchdog);
      }
      if (!decision || !decision.move) throw new Error('AI 未返回可走着法');
      retries = 0; // 退避预算是「每一手」的（与 loop.ts 同口径），不是整局共享

      /* playMove 三行（loop.ts:225-232）的纯数据复刻：不加 epoch/渲染 */
      const meta = { ...(decision.meta || {}) };
      meta.byAI = true;
      meta.side = side;
      /* 自报版本：`games.code_version` 读的是 `meta.code`（src/shared/record-map.ts:379），
         不写就恒为 `dev+nogit`，D1 里认不出是哪一版跑的。 */
      meta.code = codeOf();
      session.history.push({
        ply: session.history.length + 1,
        side,
        move: decision.move,
        meta,
      });
      session.st = engine.applyMove(session.st, decision.move);
      lastProgress = Date.now();
    }
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e), durationMs: Date.now() - startedAt };
  }

  session.endedAt = Date.now();
  const g = engine.getStatus(session.st);
  const payload = buildGameExport(session, engine);
  /* 固定思考档只认 `rapfi` 侧（`thinkMsOf` 与 src/core/record/export.ts 同一条值域闸门）：
     proxy 的「思考时间」是模型往返、不是配置，写 0 会被报表读成「0 毫秒档」这种不存在的身份。 */
  const bThink = thinkMsOf(s.black.channel, s.black.thinkMs);
  if (bThink !== undefined) payload.blackThink = bThink;
  const wThink = thinkMsOf(s.white.channel, s.white.thinkMs);
  if (wThink !== undefined) payload.whiteThink = wThink;
  const gameFile = path.join(dirs.gamesDir, gameRecordName(round, gameNo));
  writeJson(gameFile, payload);

  const result = {
    status: dryRun ? 'ok-dry' : 'ok',
    gameUid: session.gameUid,
    plies: session.history.length,
    seed: gameSeed,
    seedSnapshot: seed,
    winner: g.winner || null,
    reason: g.reason || null,
    black: identityOf(s.black),
    white: identityOf(s.white),
    durationMs: Date.now() - startedAt,
    startedAt: t0.toISOString(),
  };

  if (!dryRun) {
    /* 归档前先落一次 pending（带 gameUid）：kill -9 落在归档中途时，续跑能复用同一 uid，
       dedup_key 不变 ⇒ D1 里不会出现「同一轮同一局号两份棋谱且都算数」。 */
    writeJson(path.join(dirs.ckptDir, gameRecordName(round, gameNo)), {
      gameNo, tag, status: 'pending', gameUid: session.gameUid,
    });
    try {
      if (await alreadyArchived(origin, tag, session.gameUid)) {
        result.archivedId = null;
        result.verified = true;
        result.alreadyArchived = true; // 上次其实已经写进去了，不必再 POST
      } else {
        const resp = await apiPostGame(origin, payload);
        result.archivedId = resp && (resp.id ?? null);
        /* 归档核对：GET /api/games?tag= 里应能按 uid 找到本局（列表项是 camelCase）。
           列表读只是核对手段，可能比写入慢一拍 ⇒ 退避重查 3 次再判失败。 */
        result.verified = false;
        for (let i = 0; i < 3 && !result.verified; i++) {
          if (i) await sleep(3000);
          result.verified = await alreadyArchived(origin, tag, session.gameUid);
        }
        const list = await apiListByTag(origin, tag);
        result.rowsForTag = list && Array.isArray(list.games) ? list.games.length : null;
        if (!result.verified) throw new Error('归档后按 uid 核对不到本局');
      }
    } catch (e) {
      result.status = 'error';
      result.error = `归档失败：${e.message || e}`;
    }
  }
  log(`game-${gameNo} ${result.status} ${result.plies} 手 winner=${result.winner || '和棋'} ${Math.round(result.durationMs / 1000)}s`);
  return result;
}

/* 入口守卫：被 import（单测）时不跑 main。node scripts/experiment-worker.mjs 时 argv[1]
   就是本文件路径。process.argv[1] 可能是 file URL 或原生路径，两种都比一次。 */
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''));
if (invokedDirectly) await main();
