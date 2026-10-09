#!/usr/bin/env node
// experiment-batch.mjs — 远程批量实验编排器（本地 CLI）
//
// 子命令：
//   submit  --a 渠道[:战术档[:思考ms]] --b 同左 [--games 12] [--rounds 1]
//           [--pause 2500] [--seed N] [--dry-run] [--force] [--batch 名]
//           [--host IP] [--repo 远端仓根] [--user root] [--key-file 路径]
//           [--origin https://…]（不给 origin 时必须 --allow-production 才写生产 D1）
//           [--store d1|local]（缺省 d1；local = worker 只落远端 games.jsonl，零网络写，D11）
//           [--upstream direct|worker]（缺省 direct：box 直连上游、零 CF 触碰，G3/D12）
//           [--rate-limit 30]（上游请求/分；429 连续 5 次熔断）
//           [--parallel]（仅双本地臂）
//     → 本地生成每轮 plan.json → scp 到远端 → nohup 起 worker，后台跑
//       （--key-file 默认 /root/.jev-key：远端 shell source 它把 key 注入 worker 环境）
//   status  [--batch 名]           → scp 回 batch 目录，打印每轮进度/最新日志
//   status  --watch --batch 名 [--interval 30] [--iterations N]
//                                  → 每 N 秒 cat 远端 progress.json 原文（D13：进度是文件，无服务）
//   pull    --batch 名 [--out 目录] → 把远端 batch 目录整体拉回本地
//   elo     <目录...> [--k 16] [--json 文件] [--anchor 身份] [--bootstrap N] [--no-bt]
//           → 对拉回来的棋谱算排行：BT Δ（点估计 + bootstrap 区间，锚点缺省 rapfi||500）+ 顺序 Elo
//
// 传输只用 ssh/scp（继承 stdio，不在 Node 里捕获子进程管道）；所有远端
// 结果都落文件，本地再读——这样在没有 tty 的环境里也能跑。
//
// 远端拓扑（box, /root/board-games）：
//   .work/remote/<batch>/plans/round-<i>.json   每轮计划
//   .work/remote/<batch>/round-<i>/             worker 产物（checkpoints/games/summary）
//   .work/remote/<batch>/logs/round-<i>.log     nohup 日志

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSpec, formatSpec, sanitizeBatchId, batchTag, estimateBudget, UPSTREAM_CHANNELS,
  PRODUCTION_ORIGIN, productionGate, parallelGate,
} from './lib/batch-common.mjs';
import { loadRecords, rankTable, formatRankTable, computeElo, bootstrapBt, DEFAULT_ANCHOR, MIN_GAMES } from './lib/batch-elo.mjs';
import { launchRoundCommand, pollRoundCommand, parsePollOutput, formatPollTick, sleepSync } from './lib/ladder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // scripts/ → 仓库根
const DEFAULT_HOST = '185.242.234.48';
const DEFAULT_USER = 'root';
const DEFAULT_REPO = '/root/board-games';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
// 起 worker 的 ssh 加 -n（stdin 来自 /dev/null，避免本机终端管道把 ssh 挂住）；
// scp 不支持 -n，只给起 worker 的 ssh 用
const SSH_LAUNCH_OPTS = ['-n', ...SSH_OPTS];

function die(msg, code = 2) {
  console.error('✗ ' + msg);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
      out[key] = next; i++;
    } else out._.push(a);
  }
  return out;
}

function sh(cmd, args, timeoutMs, sigtermOk = false) {
  try {
    execFileSync(cmd, args, { stdio: 'inherit', timeout: timeoutMs });
    return true;
  } catch (err) {
    /* 起 worker 的 ssh 被本地超时 SIGTERM 掉是**正常的**（远端 nohup 不受影响）；
       但 scp/查询被 SIGTERM 掉就是真失败，不能当成功（合入审查的中清单项）。 */
    if (err.signal === 'SIGTERM' && sigtermOk) {
      console.log('（本地 ssh 客户端已超时断开；远程 nohup worker 不受影响，用 status --batch 查看）');
      return true;
    }
    return false;
  }
}

function ssh(host, user, remoteCmd, timeoutMs, opts = SSH_OPTS, sigtermOk = false) {
  return sh('ssh', [...opts, `${user}@${host}`, remoteCmd], timeoutMs, sigtermOk);
}

function scp(args) {
  return sh('scp', [...SSH_OPTS, ...args]);
}

/** 捕获式 ssh（要解析远端回话时用；`sh` 走 inherit，抓不到输出）。失败返回 null。 */
function sshCapture(host, user, remoteCmd, timeoutMs = 60000) {
  try {
    return execFileSync('ssh', [...SSH_OPTS, `${user}@${host}`, remoteCmd], { encoding: 'utf8', timeout: timeoutMs });
  } catch {
    return null;
  }
}

/**
 * 本地轮询等一轮跑完（每分钟一次短 ssh），最多 `maxHours`。
 *
 * 为什么不再用「远端一条 ssh 守 12 h」：那条长命 ssh **继承 stdout 管道**，编排进程一旦意外死掉，
 * 外层 `| Tee-Object` 永远等不到 EOF —— 作业假装还在跑（L3 第一晚实测踩到，只能靠
 * `Get-CimInstance Win32_Process` 看清）。返回 false = 到了上限，不当作失败（用 status 复核）。
 */
function waitRoundLocally(host, user, remoteBatchDir, round, { maxHours = 12, pollMs = 60000 } = {}) {
  const cmd = pollRoundCommand({
    pidPath: `${remoteBatchDir}/logs/round-${round}.pid`,
    progressPath: `${remoteBatchDir}/round-${round}/progress.json`,
  });
  const started = Date.now();
  const deadline = started + maxHours * 3600 * 1000;
  let misses = 0;
  for (;;) {
    const out = sshCapture(host, user, cmd);
    if (out === null) {
      misses += 1;
      if (misses % 3 === 0) console.log(`  ⚠ round-${round} 连续 ${misses} 次轮询 ssh 失败（远端是 nohup worker，不受影响）`);
    } else {
      misses = 0;
      const p = parsePollOutput(out);
      if (p.done) return true;
      console.log(formatPollTick(round, p.progress, { elapsedS: (Date.now() - started) / 1000 }));
    }
    if (Date.now() >= deadline) return false;
    sleepSync(pollMs);
  }
}

/* ---------------- submit ---------------- */
async function cmdSubmit(args) {
  if (!args.a || !args.b) die('submit 需要 --a 与 --b（形如 mock / random / proxy:v11-vct / rapfi:v12-vct-def:500）');
  const a = parseSpec(String(args.a));
  const b = parseSpec(String(args.b));
  const games = args.games ? Number(args.games) : 12;
  if (!Number.isInteger(games) || games < 1) die('--games 必须是正整数');
  const rounds = args.rounds ? Number(args.rounds) : 1;
  if (!Number.isInteger(rounds) || rounds < 1) die('--rounds 必须是正整数');
  const pauseMs = args.pause !== undefined ? Number(args.pause) : 2500;
  if (!Number.isInteger(pauseMs) || pauseMs < 0) die('--pause 必须是非负整数（毫秒）');
  const seed = args.seed !== undefined ? Number(args.seed) : Math.floor(Date.now() / 1000);
  if (!Number.isInteger(seed)) die('--seed 必须是整数');
  const dryRun = !!args['dry-run'];
  /* P4 起 worker 的缺省是 `--store local`（D11：不写生产 D1）。本编排器是「旧行为」的持有者，
     所以在这里**显式**写 `d1`；想只落远端 JSONL 就 `--store local`。 */
  const store = String(args.store || 'd1');
  if (store !== 'local' && store !== 'd1') die('--store 只认 local|d1');
  /* batchId 缺省带时分秒：早先只给日期（`YYYYMMDD`）⇒ 同一天第二次 submit 会撞上同一批目录，
     远程 checkpoint 全命中、一局不跑却 POST 一行 total 正常的实验档案（合入审查 M4）。 */
  const batchRaw = args.batch
    ? String(args.batch)
    : new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const batchId = sanitizeBatchId(batchRaw);
  const host = String(args.host || DEFAULT_HOST);
  const user = String(args.user || DEFAULT_USER);
  const repo = String(args.repo || DEFAULT_REPO);
  const keyFile = String(args['key-file'] || '/root/.jev-key');
  /* jev-router 臂的第二个 key 文件：批量机就是网关所在的 VPS，`keyFile`（/root/.jev-key）里装的是
     `jv-` 网关 key，TypeSafe 臂要另给一个路径。两份都 source，谁缺席都不报错。 */
  const routerKeyFile = String(args['router-key-file'] || '/root/.jev-router-key');
  /* P4b/D12：运行面与自限速。缺省 direct = box 直连上游、零 CF 触碰（G3）；限速在 worker 侧
     裹全局 fetch，每个真实上游请求都领令牌。`worker` 是本仓老路径（经业主 Worker 转发）。 */
  const upstream = String(args.upstream || 'direct');
  if (upstream !== 'direct' && upstream !== 'worker') die('--upstream 只认 direct|worker');
  const rateLimit = args['rate-limit'] !== undefined ? Number(args['rate-limit']) : 30;
  if (!Number.isFinite(rateLimit) || rateLimit <= 0) die('--rate-limit 必须是正数（每分钟请求数）');
  /* H1：origin 可换（plan.origin 全程透传给 worker 的 POST/GET）⇒ 想彻底隔离就指向独立
     Worker + 独立 D1，不必再往生产库里写实验局。
     P0 卫生包①：没给 --origin 时**必须**显式 --allow-production —— 缺省 origin 就是生产域，
     默认放行等于默认往生产库写实验局（见 batch-common.mjs productionGate）。 */
  const originGate = productionGate({ origin: args.origin, allowProduction: args['allow-production'] });
  if (originGate) die(originGate);
  const origin = String(args.origin || PRODUCTION_ORIGIN);
  if (args.origin && origin !== PRODUCTION_ORIGIN) {
    console.log(`注意：origin 已改为 ${origin}（不再写生产 D1）`);
  } else if (!args.origin) {
    console.log(`注意：--allow-production 已给 —— 本轮会写生产 D1（${origin}）。`);
  }
  /* P0 卫生包②：--parallel 仅双本地臂（上游臂并行会撞限流、并污染对照） */
  const parGate = parallelGate({ parallel: args.parallel, a, b });
  if (parGate) die(parGate);
  const maxPlies = args['max-plies'] ? Number(args['max-plies']) : 225;
  const topK = args.topk ? Number(args.topk) : 3;
  const timeoutMin = args['timeout-min'] ? Number(args['timeout-min']) : 180;
  const stallMin = args['stall-min'] ? Number(args['stall-min']) : 15;

  // 速率预算：上游臂 × 双方轮流 × 每步墙钟估计
  const budget = estimateBudget(a, b, games, 4, 30);
  if (budget.upstreamSides === 2 && !args.force) {
    die(`两臂都是上游渠道（${formatSpec(a)} / ${formatSpec(b)}）：限流口径下必须串行（concurrency=1）。` +
      `确认要跑就加 --force（预计每分钟上游调用 ≈ ${budget.jevCallsPerMin}）`);
  }
  if (budget.jevCallsPerMin > 40 && !args.force) {
    die(`速率预算 ≈ ${budget.jevCallsPerMin} 次/分 > 40，接近线上限流。确认要跑就加 --force`);
  }

  // key 预检改为提示性：key 放远端（--key-file 默认 /root/.jev-key，远端 shell source），
  // 本机不必有 key；真正校验在远端 worker 开局前（缺 key exit 2）。
  if (!dryRun && budget.upstreamSides > 0) {
    const missing = [];
    /* 每条上游臂只认自己的环境变量：串了就是「把一把 key 发给不认它的上游」，整轮 401。 */
    const sides = [a, b];
    if (sides.some((s) => s.channel === 'openrouter')) missing.push('JEV_OR_KEY');
    if (sides.some((s) => s.channel === 'jevrouter')) missing.push('JEV_ROUTER_KEY');
    if (sides.some((s) => s.channel !== 'openrouter' && s.channel !== 'jevrouter' && UPSTREAM_CHANNELS.includes(s.channel))) missing.push('JEV_API_KEY');
    if (missing.length) {
      const files = sides.some((s) => s.channel === 'jevrouter')
        ? `${keyFile}（TypeSafe 臂） + ${routerKeyFile}（jev-router 臂）`
        : keyFile;
      console.log(`注意：臂走上游，worker 需要 ${missing.join(' / ')}；key 从远端 ${files} 注入（本机无需持有）。`);
      console.log('  若远端缺 key，worker 会在开局前 exit 2，日志可见。');
    }
  }

  const plans = [];
  const startedAt = new Date();
  for (let i = 1; i <= rounds; i++) {
    const plan = {
      batchId, round: i, tag: batchTag(startedAt, batchId, i), games,
      a: formatSpec(a), b: formatSpec(b), pauseMs,
      timeoutMin, stallMin, maxPlies, topK, seed,
      dryRun, origin, store,
      /* P4b：运行面与限速写进 plan（worker 也认 CLI 覆盖，但显式落盘才好复盘）。 */
      upstream, rateLimit, keyFile, routerKeyFile,
      outDir: `${repo}/.work/remote/${batchId}/round-${i}`,
    };
    plans.push(plan);
  }

  /* M4：同名 batch 必须拦住 —— 否则会覆盖本地 plan、远端 checkpoint 全命中，一局不跑还 POST 一行档案。
     缺省 batchId 已带时分秒，这里只防「显式复用同一个 --batch 名」。
     （远端目录若确实存在，worker 侧还有第二道闸：checkpoint 里的 tag 与本轮不一致就重跑该局。） */
  const localBatchDir = path.join(ROOT, '.work/remote', batchId);
  if (fs.existsSync(localBatchDir) && !args.force) {
    die(`本地已存在 .work/remote/${batchId}（会覆盖 plan）。换 --batch 名，或加 --force 明确覆盖。`);
  }

  // 本地落 plan
  const localPlans = path.join(localBatchDir, 'plans');
  fs.mkdirSync(localPlans, { recursive: true });
  for (const p of plans) fs.writeFileSync(path.join(localPlans, `round-${p.round}.json`), JSON.stringify(p, null, 2) + '\n');

  console.log(`提交 batch=${batchId} rounds=${rounds} games/轮=${games}`);
  console.log(`  对阵 ${String(args.a)} vs ${String(args.b)}${dryRun ? '（dry-run 不打上游）' : ''}`);
  console.log(`  速率预算：上游臂 ${budget.upstreamSides} 个，估计 ≈ ${budget.jevCallsPerMin} 次/分（按 4s/步），单轮 D1 写 ≈ ${budget.writesPerDay} 行`);
  console.log(`  tag：${plans.map((p) => p.tag).join(' , ')}`);
  console.log(`  origin：${origin}${maxPlies !== 225 || topK !== 3 ? `（maxPlies=${maxPlies} topK=${topK}）` : ''}`);
  console.log(`  存储：${store === 'd1' ? '归档进 D1 + 按 uid 核对' : '仅落远端 games.jsonl（零网络写，D11）'}`);
  console.log(`  运行面：${upstream === 'direct'
    ? `直连上游（零 CF 触碰，G3）；自限速 ${rateLimit}/分，key 从远端 ${keyFile} 注入`
    : `经业主 Worker 转发（${origin}）；自限速 ${rateLimit}/分`}`);
  if (store === 'local' && upstream === 'direct') {
    console.log(`  （origin ${origin} 本轮不会被触碰；--origin 缺省仍要 --allow-production 是 P1 的闸门，与运行面无关）`);
  }

  // 远端建目录 + 逐个上传 plan
  if (!ssh(host, user, `mkdir -p ${repo}/.work/remote/${batchId}/{plans,logs}`)) die('远端 mkdir 失败（ssh 不通？）');
  for (const p of plans) {
    const rel = path.join('.work/remote', batchId, 'plans', `round-${p.round}.json`);
    if (!scp([rel, `${user}@${host}:${repo}/.work/remote/${batchId}/plans/round-${p.round}.json`])) die(`上传 round-${p.round} plan 失败`);
  }

  /* M2：轮次必须**串行**（起一轮 → 等它退出 → 再起下一轮）。早先 for 循环一口气 nohup 全部轮次，
     与「限流口径下串行」的闸门文案、ADR 与计划互相矛盾，还会把上游速率/D1 写入按轮数翻倍。
     P0 卫生包②：唯一的例外是 `--parallel`，且只对双本地臂放行（上游臂在 cmdSubmit 前段已拒绝）。 */
  const serial = !args.parallel;
  if (!serial) console.log(`双本地臂 + --parallel：${plans.length} 轮一次起（不再逐轮等待）。`);
  const remoteBatchDir = `${repo}/.work/remote/${batchId}`;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    const planPath = `${remoteBatchDir}/plans/round-${p.round}.json`;
    const logPath = `${remoteBatchDir}/logs/round-${p.round}.log`;
    const pidPath = `${remoteBatchDir}/logs/round-${p.round}.pid`;
    /* key 注入：box 上 /root/.jev-key（chmod 600，仓库外）由 shell source 进 worker 环境——
       key 不进仓库/日志/argv（AGENTS.md 铁律 7）；文件不存在时留空，worker 开局前会因缺 key 退出。 */
    const ok = ssh(host, user,
      launchRoundCommand({ repo, keyFile, routerKeyFile, planPath, logPath, pidPath }),
      20000, SSH_LAUNCH_OPTS, true);
    if (!ok) die(`round-${p.round} worker 启动失败`);
    console.log(`  round-${p.round} 已启动（pid 见 ${pidPath}）`);
    if (serial && i < plans.length - 1) {
      console.log(`  等待 round-${p.round} 跑完再起下一轮（串行）…`);
      const done = waitRoundLocally(host, user, remoteBatchDir, p.round);
      console.log(done
        ? `  round-${p.round} 已结束`
        : `  ⚠ round-${p.round} 轮询到 12h 上限 —— 起下一轮前先 status --batch ${batchId}`);
    }
  }

  console.log(`已启动。查看进度：node scripts/experiment-batch.mjs status --batch ${batchId}`);
  console.log(`拉回棋谱：  node scripts/experiment-batch.mjs pull --batch ${batchId}`);
  console.log(`算 Elo：     node scripts/experiment-batch.mjs elo .work/remote/${batchId}`);
}

/* ---------------- resume（断点续跑：worker 自己跳过已 ok 的 checkpoint） ---------------- */
function cmdResume(args) {
  const batchId = sanitizeBatchId(String(args.batch || ''));
  if (!batchId) die('resume 需要 --batch <名>');
  const round = args.round ? Number(args.round) : 1;
  if (!Number.isInteger(round) || round < 1) die('--round 必须是正整数');
  const host = String(args.host || DEFAULT_HOST);
  const user = String(args.user || DEFAULT_USER);
  const repo = String(args.repo || DEFAULT_REPO);
  const planPath = `${repo}/.work/remote/${batchId}/plans/round-${round}.json`;
  const logPath = `${repo}/.work/remote/${batchId}/logs/round-${round}.log`;
  const pidPath = `${repo}/.work/remote/${batchId}/logs/round-${round}.pid`;
  const keyFile = String(args['key-file'] || '/root/.jev-key');
  const routerKeyFile = String(args['router-key-file'] || '/root/.jev-router-key');
  /* M3：resume 必须与 submit 一样注入 key —— 早先漏了这段，走上游的臂续跑必定 exit 2，
     而断点续跑正是这套设施唯一的容错手段（ADR-0019 D3）。 */
  const ok = ssh(host, user,
    launchRoundCommand({ repo, keyFile, routerKeyFile, planPath, logPath, pidPath }),
    20000, SSH_LAUNCH_OPTS, true);
  if (!ok) die(`round-${round} 续跑失败（plan 不存在？ssh 不通？）`);
  console.log(`已续跑 batch=${batchId} round=${round}（已完成的对局会按 checkpoint 跳过并原样计入实验档案）`);
}

/* ---------------- status / pull ---------------- */
function pullBatch(args, { quiet }) {
  const batchId = sanitizeBatchId(String(args.batch || ''));
  if (!batchId) die('需要 --batch <名>');
  const host = String(args.host || DEFAULT_HOST);
  const user = String(args.user || DEFAULT_USER);
  const repo = String(args.repo || DEFAULT_REPO);
  const outParent = path.resolve(String(args.out || path.join(ROOT, '.work/remote')));
  fs.mkdirSync(outParent, { recursive: true });
  const localDir = path.join(outParent, batchId);
  /* 先拉到临时目录再整目录替换：早先是「先 rm -rf 本地再 scp」，scp 一失败就把本地唯一副本删掉了。 */
  const staging = path.join(outParent, `.staging-${batchId}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  if (!scp(['-r', `${user}@${host}:${repo}/.work/remote/${batchId}`, staging + path.sep])) {
    fs.rmSync(staging, { recursive: true, force: true });
    die('scp 拉取失败（本地旧副本保持不动）');
  }
  const staged = path.join(staging, batchId);
  if (!fs.existsSync(staged)) {
    fs.rmSync(staging, { recursive: true, force: true });
    die('拉回后暂存目录里没有 ' + batchId);
  }
  fs.rmSync(localDir, { recursive: true, force: true });
  fs.renameSync(staged, localDir);
  fs.rmSync(staging, { recursive: true, force: true });
  if (!fs.existsSync(localDir)) die('拉回后本地没有 ' + localDir);
  if (!quiet) printStatus(localDir, batchId);
  return localDir;
}

function printStatus(batchDir, batchId) {
  if (!fs.existsSync(batchDir)) { die('本地没有 ' + batchDir); }
  const rounds = fs.readdirSync(batchDir).filter((n) => /^round-\d+$/.test(n)).sort();
  console.log(`batch=${batchId} 本地副本 ${batchDir}`);
  if (rounds.length === 0) console.log('  （还没有产物）');
  for (const r of rounds) {
    const rd = path.join(batchDir, r);
    const sumFile = path.join(rd, 'round-summary.json');
    const gamesDir = path.join(rd, 'games');
    const cps = fs.existsSync(path.join(rd, 'checkpoint')) ? fs.readdirSync(path.join(rd, 'checkpoint')) : [];
    let done = 0;
    if (fs.existsSync(sumFile)) { try { done = JSON.parse(fs.readFileSync(sumFile, 'utf8')).games.length; } catch { /* 半写 */ } }
    const nGames = fs.existsSync(gamesDir) ? fs.readdirSync(gamesDir).filter((f) => f.endsWith('.json')).length : 0;
    console.log(`  ${r}：checkpoints=${cps.length} games=${nGames} 完成=${done}`);
    const logFile = path.join(batchDir, 'logs', r + '.log');
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      console.log('    日志尾：' + (lines[lines.length - 1] || '').slice(0, 160));
    }
  }
}

/* ---------------- status（D13：进度是文件，`--watch` 不拉目录、直接读远端 progress.json） ---------------- */
/** 远端一行 shell：每轮打一份 progress.json 原文。**不用 node** —— 远端非交互 shell 未必有 node 在 PATH，
    而 `cat` 一定在；progress 快照本身就是给人看的（原子写 ⇒ 读到的永远是完整 JSON）。 */
function watchRemoteCmd(batchDir, { intervalS, iterations }) {
  const bound = iterations > 0 ? `i -lt ${iterations}` : '1 -eq 1';
  return [
    `cd ${batchDir} || exit 1`,
    'i=0',
    `while [ ${bound} ]; do`,
    '  i=$((i+1))',
    '  echo "==== $(date -Is) 第 $i 次"',
    '  for d in round-*; do',
    '    [ -d "$d" ] || continue',
    '    if [ -f "$d/progress.json" ]; then echo "--- $d"; cat "$d/progress.json";',
    '    else echo "--- $d（还没有 progress.json）"; fi',
    '  done',
    `  sleep ${intervalS}`,
    'done',
  ].join('\n');
}

function cmdStatusWatch(args, batchId, host, user, repo) {
  const intervalS = args.interval !== undefined ? Number(args.interval) : 30;
  if (!Number.isFinite(intervalS) || intervalS < 5) die('--interval 至少 5 秒（远端 sleep，太小只是白刷）');
  const iterations = args.iterations !== undefined ? Number(args.iterations) : 0;
  if (!Number.isInteger(iterations) || iterations < 0) die('--iterations 必须是非负整数（0 = 一直看）');
  const batchDir = `${repo}/.work/remote/${batchId}`;
  console.log(`观察 batch=${batchId} 的 ${batchDir}（每 ${intervalS}s 一次${iterations > 0 ? `，共 ${iterations} 次` : ''}；Ctrl-C 停止）`);
  console.log('  进度只有文件、没有常驻服务（D13）⇒ cat 到的一定是最后落盘的那份原子快照。\n');
  ssh(host, user, watchRemoteCmd(batchDir, { intervalS, iterations }), 0);
}

/* ---------------- elo ---------------- */
function cmdElo(args) {
  const dirs = args._;
  if (dirs.length === 0) die('elo 需要一个或多个含棋谱 JSON 的目录');
  const k = args.k ? Number(args.k) : 16;
  const records = loadRecords(dirs.map((d) => path.resolve(d)));
  if (records.length === 0) { console.log('没有可统计的棋谱'); return; }
  /* P5：缺省算 BT + bootstrap 区间；--no-bt 退回纯顺序迭代（老报表逐字不变）。
     `--bootstrap 0` 只关区间（点估计仍算）；`--anchor ''` 强制均值居中。 */
  const btOpts = args['no-bt'] ? null : {
    anchor: args.anchor === undefined ? DEFAULT_ANCHOR : String(args.anchor),
    bootstrap: args.bootstrap === undefined ? 400 : Number(args.bootstrap),
    seed: args.seed === undefined ? 20261004 : Number(args.seed),
  };
  if (btOpts && (!Number.isFinite(btOpts.bootstrap) || btOpts.bootstrap < 0)) die('--bootstrap 需要 ≥0 的整数');
  const rows = rankTable(records, k, btOpts ? { bt: btOpts } : {});
  console.log(`样本：${records.length} 局，K=${k}（和棋 0.5，顺序迭代；<${MIN_GAMES} 局标注样本不足）\n`);
  console.log(formatRankTable(rows));
  if (btOpts) {
    const bt = bootstrapBt(records, btOpts);
    console.log(`\nBT：锚点 ${bt.anchor ? bt.anchor + '（Δ=0）' : '均值居中（无锚点：数据里没有 ' + DEFAULT_ANCHOR + '）'}` +
      `｜MM ${bt.point.iterations} 迭代${bt.point.converged ? '收敛' : '**未收敛**（到上限）'}｜ridge 先验 ${bt.point.prior}` +
      `｜bootstrap ${bt.iterations} 次（seed ${bt.seed}）`);
    if (bt.iterations > 0) {
      const wide = rows.filter((r) => r.btWidth != null).sort((a, b) => b.btWidth - a.btWidth)[0];
      const narrow = rows.filter((r) => r.btWidth != null).sort((a, b) => a.btWidth - b.btWidth)[0];
      if (wide && narrow) {
        console.log(`   区间宽度：最宽 ${wide.identity} ±${(wide.btWidth / 2).toFixed(0)} Elo（${wide.btDraws}/${bt.iterations} 次重采样命中）` +
          `｜最窄 ${narrow.identity} ±${(narrow.btWidth / 2).toFixed(0)} Elo —— 判「谁更强」要拿这两个宽度去比差值`);
      }
    }
  }
  const { matrix } = computeElo(records, k);
  if (matrix.size) {
    console.log('\n对阵明细（黑方视角）：');
    for (const m of matrix.values()) {
      console.log(`  ${m.black} vs ${m.white}：${m.w}胜 ${m.d}和 ${m.l}负（${m.games} 局）`);
    }
  }
  if (args.json) {
    const out = path.resolve(String(args.json));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const bt = btOpts ? bootstrapBt(records, btOpts) : null;
    fs.writeFileSync(out, JSON.stringify({
      k, records, rows,
      bt: bt ? { anchor: bt.anchor, iterations: bt.iterations, seed: bt.seed, converged: bt.point.converged, ridge: bt.point.prior } : null,
    }, null, 2) + '\n');
    console.log('\n已写 ' + out);
  }
}

/* ---------------- main ---------------- */
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (cmd === 'submit') cmdSubmit(args);
  else if (cmd === 'resume') cmdResume(args);
  else if (cmd === 'status') {
    if (args.watch) {
      const batchId = sanitizeBatchId(String(args.batch || ''));
      if (!batchId) die('status --watch 需要 --batch <名>');
      cmdStatusWatch(args, batchId,
        String(args.host || DEFAULT_HOST), String(args.user || DEFAULT_USER), String(args.repo || DEFAULT_REPO));
    } else pullBatch(args, { quiet: false });
  }
  else if (cmd === 'pull') pullBatch(args, { quiet: true });
  else if (cmd === 'elo') cmdElo(args);
  else {
    console.log('用法：node scripts/experiment-batch.mjs <submit|resume|status|pull|elo> [选项]');
    console.log('  submit --a <spec> --b <spec> [--games 12] [--rounds 1] [--pause 2500] [--seed N] [--force] [--key-file 路径]');
    console.log('         [--batch 名] [--host IP] [--user 用户] [--repo 远端仓路径]');
    console.log('         [--origin https://…]（换域即不写生产 D1）| 不给 --origin 时必须显式 --allow-production（写生产 D1 的闸门）');
    console.log('         [--max-plies 225] [--topk 3] [--timeout-min 180] [--stall-min 15] [--dry-run]');
    console.log('         [--store d1|local]  缺省 d1（本编排器保持旧行为）；local = worker 只落远端 games.jsonl，不碰业主 Worker（D11）');
    console.log('         [--upstream direct|worker]  缺省 direct：box 直连上游、零 CF 触碰（G3/D12）；worker = 老路径（经业主 Worker）');
    console.log('         [--rate-limit 30]  上游请求/分（worker 侧裹全局 fetch 限速 + 连续 5 次 429 熔断）');
    console.log('         多轮（--rounds>1）**串行**：起一轮 → 等它退出 → 再起下一轮（限流口径要求 concurrency=1）');
    console.log('         [--parallel] 只对**双本地臂**放行（两侧都不是 proxy/official/openrouter）：不再逐轮等待，一次起全部轮次');
    console.log('  resume --batch 名 [--round N] [--key-file 路径]   按 checkpoint 续跑某一轮（kill 后恢复用）');
    console.log('  status [--batch 名]    拉回并显示每轮进度（先拉临时目录再整体替换，失败不动本地旧副本）');
    console.log('  status --watch --batch 名 [--interval 30] [--iterations N]');
    console.log('         → 不拉目录，直接每 N 秒 cat 远端 progress.json 原文（D13：进度是文件，无服务；N≥5，0=一直看）');
    console.log('  pull   --batch 名      拉回远端产物');
    console.log('  elo   <目录...>  [--k 16] [--json 输出路径]   本地算 Elo 排行');
    console.log('         [--anchor 身份]  BT 的 0 点（缺省 rapfi||500；数据里没有就均值居中）');
    console.log('         [--bootstrap 400] [--seed 20261004]  BT 区间的重采样次数与随机种子（0 = 只算点估计）');
    console.log('         [--no-bt]  退回纯顺序迭代报表（老口径，逐字不变）');
    process.exit(cmd ? 2 : 0);
  }
}

main();
