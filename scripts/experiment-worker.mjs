/**
 * scripts/experiment-worker.mjs — box 上的无人值守对弈 worker（纯 Node）
 *
 * 计划：docs/plans/2026-10-03-remote-batch-experiments.md §4（本轮不加浏览器依赖）。
 *       P4（docs/plans/2026-10-03-tactics-fidelity-and-elo-ladder.md §5/§6）：`--store local`、
 *       `--openings <file>`、D13 进度文件、`--device-id`。
 *       P4b：`--upstream direct`（默认，box 直连上游、零 CF 触碰）、`--key-file`、`--rate-limit`
 *       （默认 30/min，滑窗 + 连续 429 熔断）；`--upstream worker` / `--store d1` 必须显式 `--origin`。
 * 用法：node scripts/experiment-worker.mjs --plan .work/remote/<batch>/round-<i>/plan.json
 *       [--store local|d1] [--openings <file>] [--device-id <id>]
 *       [--upstream direct|worker] [--key-file <path>] [--rate-limit <n>] [--origin <url>]
 * 产出：
 *   <plan.outDir>/games/round-<r>-game-<n>.json    与线上归档同构的 payload（POST 原样体）
 *   <plan.outDir>/games.jsonl                      **D11 的本地库**：每局一行同样的 payload（`--store local` 的唯一产物，
 *                                                  也是上传桶的主文件；`loadRecords` 会按 gameUid 与上面的单局 JSON 去重）
 *   <plan.outDir>/progress.json                    D13 进度快照（**原子写**，`ssh cat` 随时可读）
 *   <plan.outDir>/events.jsonl                     D13 事件流（`tail -f` 看流水；只追加）
 *   <plan.outDir>/checkpoint/round-<r>-game-<n>.json 断点/失败隔离（kill -9 后重启跳过已完成局）
 *   <plan.outDir>/round-summary.json              轮次汇总
 * 关键口径（与浏览器实验路径逐字对齐的部份）：
 *   - 走子与归档：会话历史手工复刻 src/app/loop.ts:225-232 的 playMove 三行
 *     （push {ply,side,move,meta} → st = engine.applyMove）；decide 调用口径同 loop.ts:285-295；
 *   - meta.byAI = true（export.ts 的 aiMoveMeta/meta.ts 归因链依赖它）；
 *   - 归属信息 expInfo 字段同 experiment.ts:141-153（tag/gameNo/黑白渠道/战术档/思考）；
 *   - 自动退避 [4000,12000,25000] ms 复刻 loop.ts:66（限流/网络重试，机机无人值守必需）。
 * `--store local`（默认）与 `d1` 的差别：**只有归档这一步不同** —— local 不碰网络（不 POST、
 *   不 GET 核对），产物落 `games.jsonl`；`d1` 保持旧行为（POST + 按 uid 核对 + 轮末实验行）。
 * 运行面（P4b / D12）：默认 `--upstream direct` = 直连 `https://api.typesafe.ai/v1/systemone`，
 *   不连业主 Worker、不写 D1，box 侧自限速 30 req/min（裹全局 fetch ⇒ **每个真实上游请求**都领令牌），
 *   连续 5 次 429 熔断并早失败。直连面**禁止 proxy 臂**（proxy 相对端点 + X-Api-Key，见 lib/upstream.mjs）。
 *   `--upstream worker`（老路径）与 `--store d1` 都必须显式 `--origin`，否则 exit 2。
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
import { formatProviderSwitch } from '../src/core/jev/providers.ts';
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
import {
  newState,
  recordGame,
  snapshot,
  writeProgress,
  appendEvent,
  formatProgress,
} from './lib/progress.mjs';
import { readLibrary, openingForNo } from './lib/openings.mjs';
import {
  DEFAULT_PER_MINUTE,
  DIRECT_UPSTREAM_HOSTS,
  createThrottle,
  formatThrottle,
  installFetchThrottle,
} from './lib/throttle.mjs';
import {
  CC_KEY_HELP,
  DEFAULT_CC_KEY_FILE,
  DEFAULT_KEY_FILE,
  DEFAULT_ROUTER_KEY_FILE,
  KEY_CHANNELS,
  KEY_HELP,
  ROUTER_KEY_HELP,
  keyShapeProblem,
  resolveBackupKey,
  resolveRunKey,
  upstreamGate,
} from './lib/upstream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // scripts/ → 仓库根

/** loop.ts:66 同值：可重试失败（限流/网络）的退避序列。 */
const RETRY_DELAYS_MS = [4000, 12000, 25000];
/** 每手上游调用的看门狗默认值；plan 可覆盖。 */
const DEFAULTS = {
  games: 12, pauseMs: 2500, timeoutMin: 180, stallMin: 15, maxPlies: 225,
  topK: 3, seed: 20261003, dryRun: false, origin: 'https://jevqipan.logicc.top',
  /* D11/D12：默认**不写生产 D1**。老调用方（experiment-batch submit）在 plan 里显式写
     `store: 'd1'` 保持原行为；漏写就是「只落本地」，不会悄悄往业主库里灌三万行。 */
  store: 'local',
  /* D12/G3：默认直连上游（零 CF 触碰）+ box 侧自限速；key 优先环境变量，其次这个文件。 */
  upstream: 'direct',
  rateLimit: DEFAULT_PER_MINUTE,
  keyFile: DEFAULT_KEY_FILE,
  /* jev-router 臂（自建网关）的 key 文件。刻意与 keyFile 分开：这台 box 就是网关所在的 VPS，
     `/root/.jev-key` 里装的是 `jv-` 网关 key，而 `keyFile` 那条路留给 TypeSafe 臂。 */
  routerKeyFile: DEFAULT_ROUTER_KEY_FILE,
  /* C2/D-B4：兜底 key 文件（可选）。`expectBackup` = 本轮要求兜底真的可用（拿不到就退码 2），
     用于切换验收；默认 false ⇒ 没有它只是「不启用切换」。 */
  backupKeyFile: DEFAULT_CC_KEY_FILE,
  expectBackup: false,
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
    格式 `^[A-Za-z0-9_-]{8,64}$`（`src/worker/lib/validate.ts`）。可用 `BATCH_DEVICE_ID` 覆盖，
    CLI/plan 的 `--device-id` 优先级最高（阶梯编排给 `ladder-<batch>`，见计划 §5）。 */
export let DEVICE_ID = process.env.BATCH_DEVICE_ID || 'ssh-batch';

/** 值域与 `src/worker/lib/validate.ts` 的 DEVICE_ID_RE 同源；不合法直接抛（由 main 转 exit 2）。 */
export function setDeviceId(id) {
  if (id == null || id === '') return DEVICE_ID;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(id))) throw new Error(`device-id 形状不合法（^[A-Za-z0-9_-]{8,64}$）：${id}`);
  DEVICE_ID = String(id);
  return DEVICE_ID;
}

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

/** 每侧 decide 入参（apiKey/endpoint 按渠道取；proxy 端点要拼 origin，client.ts:29 的 'api/jev' 是相对路径）。
    `plan.keys`（P4b 直连面在 main 里解析出来的 key）优先于环境变量：key 文件那条路只有它知道。
    **key 本身绝不进日志/产物**，只记录来源（`keySource`）。 */
function decideEnvFor(cfg, plan) {
  const injected = (plan.keys && plan.keys[cfg.channel]) || '';
  /* 每条上游臂只认自己的环境变量：openrouter→JEV_OR_KEY，jev-router 网关→JEV_ROUTER_KEY，
     其余（TypeSafe）→JEV_API_KEY。串了就是「把一把 key 发给不认它的上游」，只会整轮 401。 */
  const apiKey = cfg.channel === 'openrouter'
    ? (process.env.JEV_OR_KEY || injected || '')
    : cfg.channel === 'jevrouter'
      ? (process.env.JEV_ROUTER_KEY || injected || '')
      : (injected || process.env.JEV_API_KEY || '');
  const endpoint = cfg.channel === 'proxy' ? `${plan.origin}/api/jev` : '';
  /* C2/D-B1：兜底 key 只对 official 面有意义（proxy 面的切换在 Worker 里做；openrouter 是另一条渠道）。 */
  const backupApiKey = cfg.channel === 'official' ? ((plan.keys && plan.keys.backup) || process.env.COMMANDCODE_API_KEY || '') : '';
  return { apiKey, endpoint, backupApiKey };
}

/** 逐提供方手数（C2/D-B6）：`{ primary: 24, backup: 3 }`；没见过的提供方也别丢，照实记。
    只认非空字符串：`meta.provider` 是 undefined 的手（rapfi/mock/人类侧、老归档）**不计入**——
    记成 `unknown` 会把「非 Jev 侧手数」混进同一个表，报表就读不出「兜底了几手」。 */
export function countProvider(counts, id) {
  if (typeof id !== 'string' || !id) return counts;
  counts[id] = (counts[id] || 0) + 1;
  return counts;
}

/** 一行摘要（只在真有切换时才花字数）。 */
export function formatProviderCounts(counts) {
  const keys = Object.keys(counts || {});
  if (!keys.length) return '';
  keys.sort((a, b) => counts[b] - counts[a]);
  return keys.map((k) => `${k}:${counts[k]}`).join(' ');
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
    process.stderr.write('用法：node scripts/experiment-worker.mjs --plan <plan.json> [--store local|d1] [--openings <file>] [--device-id <id>] [--upstream direct|worker] [--key-file <path>] [--backup-key-file <path>] [--expect-backup] [--rate-limit <n>] [--origin <url>]\n');
    process.exitCode = 2;
    return;
  }
  const rawPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const plan = { ...DEFAULTS, ...rawPlan };
  const cliStore = argOf(argv, '--store');
  const cliOpenings = argOf(argv, '--openings');
  const cliDevice = argOf(argv, '--device-id');
  const cliUpstream = argOf(argv, '--upstream');
  const cliKeyFile = argOf(argv, '--key-file');
  const cliRouterKeyFile = argOf(argv, '--router-key-file');
  const cliBackupKeyFile = argOf(argv, '--backup-key-file');
  const cliRateLimit = argOf(argv, '--rate-limit');
  const cliOrigin = argOf(argv, '--origin');
  /* 「显式给了 origin」而不是 DEFAULTS 兜的生产地址：两道逃生门（worker 面 / store d1）都要求它。 */
  const originGiven = Object.prototype.hasOwnProperty.call(rawPlan, 'origin') || Boolean(cliOrigin);
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
  /* CLI 覆盖 plan（P4/P4b）：跑手不必改 plan 文件就能换存储、开局库、匿名身份、运行面与限速。 */
  if (cliStore) plan.store = cliStore;
  if (cliOpenings) plan.openings = cliOpenings;
  if (cliDevice) plan.deviceId = cliDevice;
  if (cliUpstream) plan.upstream = cliUpstream;
  if (cliKeyFile) plan.keyFile = cliKeyFile;
  if (cliRouterKeyFile) plan.routerKeyFile = cliRouterKeyFile;
  if (cliBackupKeyFile) plan.backupKeyFile = cliBackupKeyFile;
  if (argv.includes('--expect-backup')) plan.expectBackup = true;
  if (cliOrigin) plan.origin = cliOrigin;
  if (cliRateLimit != null) plan.rateLimit = Number(cliRateLimit);
  const store = plan.store;
  if (store !== 'local' && store !== 'd1') {
    process.stderr.write(`--store 只认 local|d1，收到 ${store}\n`);
    process.exitCode = 2;
    return;
  }
  /* 运行面闸门（D12）：direct 面不许有 proxy 臂，worker 面/store d1 必须显式 origin。 */
  const gateMsg = upstreamGate({ upstream: plan.upstream, store, originGiven, channels: [a.channel, b.channel] });
  if (gateMsg) {
    process.stderr.write(`${gateMsg}\n`);
    process.exitCode = 2;
    return;
  }
  if (!Number.isFinite(plan.rateLimit) || plan.rateLimit <= 0) {
    process.stderr.write(`--rate-limit 必须是正数（每分钟请求数），收到 ${plan.rateLimit}\n`);
    process.exitCode = 2;
    return;
  }
  /* 直连面的 key：环境变量优先，其次 key 文件（默认 box 的 /root/.jev-key）。
     缺 key 必须在开局前退出——不然每局白跑十几分钟才失败。 */
  plan.keys = {};
  const keySources = {};
  if (plan.upstream === 'direct') {
    for (const cfg of [a, b]) {
      /* 显式给了 `--router-key-file` 就用它，否则走该渠道的默认文件。 */
      const keyFile = cfg.channel === 'jevrouter'
        ? (plan.routerKeyFile || plan.keyFile)
        : plan.keyFile;
      const { key, source } = resolveRunKey({ channel: cfg.channel, keyFile });
      if (key) {
        /* 形状闸门：box 与网关同机，放错 key 文件不会立刻报错而是变成整轮 401。开局前拦一道。 */
        const shape = keyShapeProblem(cfg.channel, key);
        if (shape && !dryRun) {
          process.stderr.write(`渠道 ${cfg.channel} 的 key 形状不对（来源 ${source}）：${shape}\n`);
          process.exitCode = 2;
          return;
        }
        plan.keys[cfg.channel] = key;
        keySources[cfg.channel] = source;
      } else if (KEY_CHANNELS.includes(cfg.channel) && !dryRun) {
        process.stderr.write(`渠道 ${cfg.channel} 拿不到 key：${cfg.channel === 'jevrouter' ? ROUTER_KEY_HELP : KEY_HELP}\n`);
        process.exitCode = 2;
        return;
      }
    }
    /* C2/D-B4：兜底 key 是可选的——**没有就是「不启用切换」**，不是配置错误，
       所以这里既不退码也不打印 key 内容，只记来源（`backup←file:/root/.cc-key`）。 */
    if ([a, b].some((cfg) => cfg.channel === 'official')) {
      const backup = resolveBackupKey({ keyFile: plan.backupKeyFile });
      if (backup.key) {
        plan.keys.backup = backup.key;
        keySources.backup = backup.source;
      } else if (plan.expectBackup && !dryRun) {
        process.stderr.write(`本轮要求兜底可用，但拿不到兜底 key：${CC_KEY_HELP}\n`);
        process.exitCode = 2;
        return;
      }
    }
  }
  try {
    setDeviceId(plan.deviceId);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  // outDir 相对 cwd 解析（编排器在仓根启动 worker，plan 里通常给绝对路径）
  const outDir = path.resolve(process.cwd(), plan.outDir || `.work/remote/${plan.batchId}/round-${round}`);
  const gamesDir = path.join(outDir, 'games');
  const ckptDir = path.join(outDir, 'checkpoint');
  const jsonlFile = path.join(outDir, 'games.jsonl');

  /* 配对开局库（D9）：给了就必须能载入。载入失败要在这里退出——不然每局白跑十几分钟才炸
     （与「缺 key 早退」同一条纪律）。 */
  let lib = null;
  if (plan.openings) {
    try {
      lib = readLibrary(path.resolve(process.cwd(), plan.openings));
    } catch (err) {
      process.stderr.write(`开局库载入失败：${err.message}\n`);
      process.exitCode = 2;
      return;
    }
  }

  /* 前置校验：渠道/档位（parseSpec 已拦）、tag 形状、真上游 key 是否在位。
     缺 key 必须在开局前退出——不然每局都白跑十几分钟才失败（AGENTS.md「不在事后日志里备案」）。 */
  batchTag(new Date(), plan.batchId, round); // 形状校验（tag 本身用 plan 里的，时序以 submit 为准）
  /* tag 缺失要早退：实验行的归属全靠它（D1 的 experiment_tag / 归档目录名），
     缺了会写出一行没有标签的实验记录——手写 plan 最常漏这个键。 */
  if (!plan.tag) {
    process.stderr.write('plan 缺 tag（实验行与归档目录名都靠它；由 experiment-batch.mjs submit 生成，手写 plan 也要给，如 "tag": "exp-20261004-p4b-box-r1"）\n');
    process.exitCode = 2;
    return;
  }
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
  /* 直连面的 key 已在上面的运行面闸门里解析（环境变量或 key 文件）；这里只管 worker 面
     （老路径）仍靠进程环境变量，缺 key 一律开局前退出。 */
  for (const cfg of [a, b]) {
    if (UPSTREAM_CHANNELS.includes(cfg.channel) && plan.upstream === 'worker') {
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
  log(`worker 起：batch=${plan.batchId} round=${round} tag=${tag} 对阵 ${a.channel} vs ${b.channel} ×${games} 局 dryRun=${dryRun} store=${store} repoHead=${head} device=${DEVICE_ID}`);
  /* 运行面（P4b / D12）：direct = 直连上游、零 CF 触碰；限速裹在全局 fetch 上 ⇒ **每个真实上游请求**都领令牌。 */
  const plane = plan.upstream === 'direct' ? 'direct（直连上游，零 CF 触碰）' : `worker（经 ${plan.origin}）`;
  log(`运行面：${plane}｜store=${store}${store === 'd1' ? `（归档到 ${plan.origin}）` : '（只落本地，不碰网络写）'}`);
  if (lib) log(`开局库：${plan.openings} 共 ${lib.openings.length} 本 / 前 ${lib.plies} 手（同一开局连续两局，换色双跑）`);

  /* 限速：只在真会打上游的时候装（rapfi/mock 自对弈不该被拖慢），dryRun 也不装。 */
  const needUpstream = plan.upstream === 'direct' && !dryRun
    && [a, b].some((cfg) => UPSTREAM_CHANNELS.includes(cfg.channel));
  const throttle = needUpstream ? createThrottle({ perMinute: plan.rateLimit, sleep }) : null;
  const gate = throttle ? installFetchThrottle(throttle, { hosts: DIRECT_UPSTREAM_HOSTS }) : null;
  if (throttle) {
    const src = Object.entries(keySources).map(([ch, s]) => `${ch}←${s}`).join('、') || '未用到';
    log(`限速：${formatThrottle(throttle.state())}｜key 来源：${src}`);
  }

  /* D13：进度是**文件**不是服务（box 只有 1.3 GiB 内存，且 `ssh cat` 要能随时读到）。
     state 在内存里累计，每局/每手落一次原子快照；events.jsonl 只追加流水。 */
  let state = newState({ batchId: plan.batchId, round, tag, total: games, startedAtMs: Date.now() });
  const flush = (current = null) => writeProgress(outDir, snapshot(state, { current }));
  flush({ gameNo: 1, ply: 0 });
  appendEvent(outDir, {
    kind: 'round-start', batchId: plan.batchId, round, tag, games, store,
    upstream: plan.upstream, rateLimit: throttle ? plan.rateLimit : null,
    keySource: Object.keys(keySources).length ? keySources : null,
    openings: plan.openings || null, repoHead: head, device: DEVICE_ID,
    a: identityOf(a), b: identityOf(b),
  });

  const summary = { batchId: plan.batchId, round, tag, repoHead: head, store, upstream: plan.upstream, startedAt: new Date().toISOString(), games: [] };
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
        state = recordGame(state, {
          gameNo, status: 'skipped', durationMs: null, winner: act.winner ?? null,
          gameUid: act.gameUid ?? null, plies: act.plies ?? null, aBlack: ((gameNo - 1) % 2) === 0,
        });
        flush({ gameNo, ply: null });
        appendEvent(outDir, { kind: 'game-skip', gameNo, from: act.from, winner: act.winner ?? null });
        continue;
      }
      if (act.reason === 'tag-mismatch') log(`game-${gameNo} checkpoint 的 tag 与本轮 ${tag} 不一致，重跑本局`);
      if (act.resumeUid) {
        resumeUid = act.resumeUid;
        log(`game-${gameNo} 上次归档未完成，复用 gameUid=${resumeUid} 重跑`);
      }
    }
    /* 开局：同一本连续两局（换色双跑）⇒ 开局方差被按住（D9）。 */
    const opening = lib ? openingForNo(lib, gameNo) : null;
    flush({ gameNo, ply: 0 });
    appendEvent(outDir, { kind: 'game-start', gameNo, opening: opening ? opening.key : null });
    const one = await playOne(plan, a, b, gameNo, {
      /* outDir 也要传：`playOne` 是顶层函数，切换事件回调得自己写 events.jsonl
         （曾经漏传 ⇒ 每次切换都 `outDir is not defined`，整局变 error）。 */
      gamesDir, ckptDir, outDir, resumeUid, store, opening, jsonlFile, throttle,
      /* 每手回写一次「跑到第几手」：长局里 progress.json 不写就会几分钟不动，看不出是死是活。 */
      onPly: (ply) => flush({ gameNo, ply }),
    });
    summary.games.push({ gameNo, ...one });
    writeJson(ckptFile, { gameNo, tag, head, ...one });
    state = recordGame(state, {
      gameNo, status: one.status, durationMs: one.durationMs ?? null, winner: one.winner ?? null,
      gameUid: one.gameUid ?? null, plies: one.plies ?? null,
      aBlack: ((gameNo - 1) % 2) === 0, error: one.error ?? null,
    });
    flush({ gameNo, ply: one.plies ?? null });
    appendEvent(outDir, {
      kind: 'game-done', gameNo, status: one.status, winner: one.winner ?? null,
      plies: one.plies ?? null, durationMs: one.durationMs ?? null, gameUid: one.gameUid ?? null,
      error: one.error ?? null, wdl: snapshot(state, {}).wdl,
    });
    log(`进度：${formatProgress(snapshot(state, {}))}`);
    if (gameNo < games) await sleep(pauseMs);
  }
  summary.endedAt = new Date().toISOString();
  /* 限速账要跟着轮次走：事后能算出这轮到底等了多久、有没有撞过 429 风暴。 */
  summary.throttle = throttle ? { ...throttle.state(), fetch: gate ? gate.stats() : null } : null;
  if (throttle) log(`限速轮末：${formatThrottle(throttle.state())}${gate ? `｜上游请求 ${gate.stats().gated} 次` : ''}`);
  if (gate) gate.uninstall();
  const okCount = summary.games.filter((g) => g.status === 'skipped' || g.status === 'ok' || g.status === 'ok-dry').length;
  summary.progress = snapshot(state, {});
  /* 轮末补 experiments 行（只写真跑的局）：失败不坏出口码——棋谱才是主产物，
     实验行缺失时 status.md「实验轮」口径已在 ADR-0019 后果里交代。 */
  if (store === 'd1') {
    if (!dryRun && okCount > 0) {
      try {
        const resp = await apiPostExperiment(origin, experimentEntryFrom(plan, a, b, summary));
        log(`experiments 行已归档：tag=${plan.tag} total=${resp && resp.total != null ? resp.total : '?'}`);
      } catch (e) {
        log(`experiments 归档失败（棋谱不受影响）：${e.message || e}`);
      }
    }
  } else {
    /* local：一行都不发。把「本来会 POST 的实验行」留在 summary 里，桶留档（D14）时随 report 一起走。 */
    summary.experimentEntry = experimentEntryFrom(plan, a, b, summary);
    log(`store=local：未触碰业主 Worker（实验行留在 round-summary.json 的 experimentEntry 里）`);
  }
  appendEvent(outDir, { kind: 'round-end', ok: okCount, total: games, progress: summary.progress, throttle: summary.throttle });
  writeJson(path.join(outDir, 'round-summary.json'), summary);
  log(`worker 完：${okCount}/${games} 局正常`);
  log(`产物：${jsonlFile} · ${path.join(outDir, 'progress.json')} · ${path.join(outDir, 'events.jsonl')}`);
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
  /* 配对开局（D9）：把开局库的 seq 当「脚本落子」写进历史。不是 AI 决策 ⇒ byAI:false，
     但仍写 meta.code（归档里能看出这局跑的是哪个提交）。落不下去就整局记 error ——
     开局库与引擎口径不一致必须立刻暴露，不能悄悄少走几手然后当成正常局收下。 */
  if (dirs.opening) {
    for (const n of dirs.opening.seq) {
      const mv = engine.moveFromNotation(session.st, n);
      if (!mv) {
        return {
          status: 'error',
          error: `开局库着法无法落地：${n}（第 ${session.history.length + 1} 手，开局 ${dirs.opening.key}）`,
          durationMs: Date.now() - startedAt,
        };
      }
      const side = session.st.turn === 'white' ? 'white' : 'black';
      session.history.push({
        ply: session.history.length + 1,
        side,
        move: mv,
        meta: { byAI: false, opening: true, side, code: codeOf() },
      });
      session.st = engine.applyMove(session.st, mv);
    }
  }
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
  /* C2：本局谁答的（逐手计数）+ 局内粘滞（切过去就不再回切，D-B2）。 */
  const providerCounts = {};
  let stickyProvider = '';

  try {
    for (;;) {
      const now = Date.now();
      if (now > deadline) throw new Error(`对局超时（timeoutMin=${timeoutMin}）`);
      if (now - lastProgress > stallMs) throw new Error(`对局停滞超时（stallMin=${stallMin} 无新着法）`);
      const g = engine.getStatus(session.st);
      if (g.over || session.history.length >= maxPlies) break;

      const side = g.turn || session.st.turn;
      const cfg = side === 'black' ? s.black : s.white;
      const { apiKey, endpoint, backupApiKey } = decideEnvFor(cfg, plan);

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
          /* C2：主上游打死整局时的兜底。`backupApiKey` 为空 = 不启用（老行为）；粘滞只在
             本局内生效，切换事件写日志 + `events.jsonl`，事后能按手归因「谁答的」。 */
          backupApiKey,
          providerSticky: stickyProvider || undefined,
          onProviderSwitch: (info) => {
            stickyProvider = info.to;
            log(`game-${gameNo} ${formatProviderSwitch(info)}`);
            appendEvent(dirs.outDir, {
              kind: 'provider', gameNo, ply: session.history.length + 1, side,
              from: info.from, to: info.to, reason: info.reason,
              probeStatus: info.probeStatus, probeMs: info.probeMs,
            });
          },
          onRetry: (code, attempt) => {
            /* 429/529 上报给熔断器：连续 N 次就熔断，让整轮早失败而不是拿 429 刷满剩下的局。 */
            if (code === 429 || code === 529) {
              const st = dirs.throttle ? dirs.throttle.note429() : null;
              if (st && st.tripped) log(`game-${gameNo} ${st.tripReason}`);
            }
            log(`game-${gameNo} 限流(${code}) 退避重试 ${attempt}`);
          },
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
      if (dirs.throttle) dirs.throttle.noteOk(); // 一次成功就清零连续 429 计数
      retries = 0; // 退避预算是「每一手」的（与 loop.ts 同口径），不是整局共享

      /* playMove 三行（loop.ts:225-232）的纯数据复刻：不加 epoch/渲染 */
      const meta = { ...(decision.meta || {}) };
      meta.byAI = true;
      meta.side = side;
      /* C2/D-B6：逐手记「这一手是谁答的」（primary/backup）。非上游侧没有 provider ⇒ 由
         countProvider 自己跳过（别记成 unknown，那会把 rapfi 的手混进兜底统计）。 */
      countProvider(providerCounts, meta.provider);
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
      /* D13：每手回写「跑到第几手」（长局里 progress.json 不写就会几分钟不动，看不出死没死）。 */
      if (dirs.onPly) dirs.onPly(session.history.length);
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
  /* D11 本地库：每局一行同样的 payload。单局 JSON 与 JSONL 故意都留（前者方便单局排查，
     后者是「一个文件好上传」的形态）；`loadRecords` 按 gameUid 去重，不会算两次 Elo。 */
  if (dirs.jsonlFile && !dryRun) {
    try {
      ensureDir(path.dirname(dirs.jsonlFile));
      fs.appendFileSync(dirs.jsonlFile, JSON.stringify(payload) + '\n');
    } catch (e) {
      log(`games.jsonl 追加失败（单局 JSON 仍在）：${e.message || e}`);
    }
  }

  const result = {
    status: dryRun && dirs.store === 'd1' ? 'ok-dry' : 'ok',
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
    /* C2/D-B6：这一局的逐手提供方分布（只在真跑过时非空；`{}` 的下游按缺省读）。 */
    providers: Object.keys(providerCounts).length ? providerCounts : null,
  };

  if (dirs.store === 'd1' && !dryRun) {
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
  const provLine = result.providers ? ` provider[${formatProviderCounts(result.providers)}]` : '';
  log(`game-${gameNo} ${result.status} ${result.plies} 手 winner=${result.winner || '和棋'} ${Math.round(result.durationMs / 1000)}s${provLine}`);
  return result;
}

/* 入口守卫：被 import（单测）时不跑 main。node scripts/experiment-worker.mjs 时 argv[1]
   就是本文件路径。process.argv[1] 可能是 file URL 或原生路径，两种都比一次。 */
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''));
if (invokedDirectly) await main();
