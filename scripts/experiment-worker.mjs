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
import { buildGameExport } from '../src/core/record/export.ts';
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
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

/** 一次真上游调用（row 形状与 GET /api/games 的 listItem 对齐，够核对即可）。 */
async function apiListByTag(origin, tag) {
  try {
    const r = await fetch(`${origin}/api/games?tag=${encodeURIComponent(tag)}&limit=100`);
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

async function apiPostGame(origin, payload) {
  const r = await fetch(`${origin}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`POST /api/games → HTTP ${r.status}`);
  return await r.json();
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
    if (g.status !== 'ok') continue;
    const { black, white } = sidesForGameSpec(a, b, g.gameNo);
    const winnerSide = g.winner === 'black' ? black : g.winner === 'white' ? white : null;
    games.push({
      no: g.gameNo,
      blackChan: black.channel,
      whiteChan: white.channel,
      blackTac: black.tactics || null,
      whiteTac: white.tactics || null,
      blackThink: black.thinkMs || 0,
      whiteThink: white.thinkMs || 0,
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
    tacA: a.tactics || null,
    tacB: b.tactics || null,
    thinkA: a.thinkMs || 0,
    thinkB: b.thinkMs || 0,
    total: games.length,
    games,
    note: 'SSH 远端批量（experiment-batch.mjs）',
  };
}

/** 轮末 POST /api/experiments；429 退避两次（写限流 20 次/分，一轮只发一次，大概率不撞）。 */
async function apiPostExperiment(origin, entry) {
  let lastErr = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`${origin}/api/experiments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  const a = parseSpec(plan.a);
  const b = parseSpec(plan.b);
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
  log(`worker 起：batch=${plan.batchId} round=${round} tag=${tag} 对阵 ${a.channel} vs ${b.channel} ×${games} 局 dryRun=${dryRun}`);

  const summary = { batchId: plan.batchId, round, tag, startedAt: new Date().toISOString(), games: [] };
  for (let gameNo = 1; gameNo <= games; gameNo++) {
    const ckptFile = path.join(ckptDir, gameRecordName(round, gameNo));
    if (fs.existsSync(ckptFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(ckptFile, 'utf8'));
        if (prev.status === 'ok' || prev.status === 'ok-dry') {
          log(`game-${gameNo} 已完成（${prev.status}），跳过`);
          summary.games.push({ gameNo, status: 'skipped', from: prev.status });
          continue;
        }
      } catch (_) { /* checkpoint 损坏则重跑该局 */ }
    }
    const one = await playOne(plan, a, b, gameNo, { gamesDir, ckptDir });
    summary.games.push({ gameNo, ...one });
    writeJson(ckptFile, { gameNo, tag, ...one });
    if (gameNo < games) await sleep(pauseMs);
  }
  summary.endedAt = new Date().toISOString();
  writeJson(path.join(outDir, 'round-summary.json'), summary);
  const okCount = summary.games.filter((g) => g.status === 'skipped' || g.status === 'ok' || g.status === 'ok-dry').length;
  /* 轮末补 experiments 行（只写真跑的局）：失败不坏出口码——棋谱才是主产物，
     实验行缺失时 status.md「实验轮」口径已在 ADR-0018 后果里交代。 */
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
    gameUid: randomGameUid(),
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

      /* playMove 三行（loop.ts:225-232）的纯数据复刻：不加 epoch/渲染 */
      const meta = { ...(decision.meta || {}) };
      meta.byAI = true;
      meta.side = side;
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
  /* 思考 ms 不在 export 里（浏览器同款 payload 也没这俩键），但本地 Elo 身份
     （rapfi|500 ≠ rapfi|1000）与 D1 归因都要用：expInfo 现成，补成可选字段
     （record-map.ts:375 的 num() 认得；旧消费方都有 ?? 0 兜底）。 */
  payload.blackThink = s.black.thinkMs || 0;
  payload.whiteThink = s.white.thinkMs || 0;
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
    try {
      const resp = await apiPostGame(origin, payload);
      result.archivedId = resp && (resp.id ?? null);
      /* 归档核对：GET /api/games?tag= 里应能数到本局（uid 优先，退化按局号计数）。
         注意列表项是 camelCase（gameUid/experimentTag），不是 snake_case。 */
      const list = await apiListByTag(origin, tag);
      const rows = (list && Array.isArray(list.games) ? list.games : []);
      const hit = rows.find((r) => r.game_uid === session.gameUid || r.gameUid === session.gameUid);
      const byTag = rows.filter((r) => (r.experimentTag || r.tag) === tag).length;
      result.verified = Boolean(hit) || byTag >= gameNo;
      result.rowsForTag = byTag;
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
