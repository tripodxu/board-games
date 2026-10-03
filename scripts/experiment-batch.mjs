#!/usr/bin/env node
// experiment-batch.mjs — 远程批量实验编排器（本地 CLI）
//
// 子命令：
//   submit  --a 渠道[:战术档[:思考ms]] --b 同左 [--games 12] [--rounds 1]
//           [--pause 2500] [--seed N] [--dry-run] [--force] [--batch 名]
//           [--host IP] [--repo 远端仓根] [--user root]
//     → 本地生成每轮 plan.json → scp 到远端 → nohup 起 worker，后台跑
//   status  [--batch 名]           → scp 回 batch 目录，打印每轮进度/最新日志
//   pull    --batch 名 [--out 目录] → 把远端 batch 目录整体拉回本地
//   elo     <目录...> [--k 16] [--json 文件] → 对拉回来的棋谱算 Elo 排行
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
} from './lib/batch-common.mjs';
import { loadRecords, rankTable, formatRankTable, computeElo, MIN_GAMES } from './lib/batch-elo.mjs';

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

function sh(cmd, args, timeoutMs) {
  try {
    execFileSync(cmd, args, { stdio: 'inherit', timeout: timeoutMs });
    return true;
  } catch (err) {
    if (err.signal === 'SIGTERM') {
      console.log('（本地 ssh 客户端已超时断开；远程 nohup worker 不受影响，用 status --batch 查看）');
      return true;
    }
    return false;
  }
}

function ssh(host, user, remoteCmd, timeoutMs, opts = SSH_OPTS) {
  return sh('ssh', [...opts, `${user}@${host}`, remoteCmd], timeoutMs);
}

function scp(args) {
  return sh('scp', [...SSH_OPTS, ...args]);
}

/* ---------------- submit ---------------- */
function cmdSubmit(args) {
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
  const batchRaw = args.batch ? String(args.batch) : new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const batchId = sanitizeBatchId(batchRaw);
  const host = String(args.host || DEFAULT_HOST);
  const user = String(args.user || DEFAULT_USER);
  const repo = String(args.repo || DEFAULT_REPO);

  // 速率预算：上游臂 × 双方轮流 × 每步墙钟估计
  const budget = estimateBudget(a, b, games, 4, 30);
  if (budget.upstreamSides === 2 && !args.force) {
    die(`两臂都是上游渠道（${formatSpec(a)} / ${formatSpec(b)}）：限流口径下必须串行（concurrency=1）。` +
      `确认要跑就加 --force（预计每分钟上游调用 ≈ ${budget.jevCallsPerMin}）`);
  }
  if (budget.jevCallsPerMin > 40 && !args.force) {
    die(`速率预算 ≈ ${budget.jevCallsPerMin} 次/分 > 40，接近线上限流。确认要跑就加 --force`);
  }

  // 缺 key 预检（只在本机能看时提示；真正校验在远端 worker 开局前）
  if (!dryRun && budget.upstreamSides > 0) {
    for (const side of [a, b]) {
      if (side.channel === 'openrouter' && !process.env.JEV_OR_KEY) {
        die('本机没有 JEV_OR_KEY（openrouter 臂需要）。worker 在远端跑，需要另有办法把 key 送过去（如远端 env 文件）');
      }
      if (side.channel !== 'openrouter' && UPSTREAM_CHANNELS.includes(side.channel) && !process.env.JEV_API_KEY) {
        die('本机没有 JEV_API_KEY（' + side.channel + ' 臂需要）。worker 在远端跑，同样要把 key 配置到远端');
      }
    }
  }

  const plans = [];
  const startedAt = new Date();
  for (let i = 1; i <= rounds; i++) {
    const plan = {
      batchId, round: i, tag: batchTag(startedAt, batchId, i), games,
      a: formatSpec(a), b: formatSpec(b), pauseMs,
      timeoutMin: 180, stallMin: 15, maxPlies: 225, topK: 3, seed,
      dryRun, origin: 'https://jevqipan.logicc.top',
      outDir: `${repo}/.work/remote/${batchId}/round-${i}`,
    };
    plans.push(plan);
  }

  // 本地落 plan
  const localPlans = path.join(ROOT, '.work/remote', batchId, 'plans');
  fs.mkdirSync(localPlans, { recursive: true });
  for (const p of plans) fs.writeFileSync(path.join(localPlans, `round-${p.round}.json`), JSON.stringify(p, null, 2) + '\n');

  console.log(`提交 batch=${batchId} rounds=${rounds} games/轮=${games}`);
  console.log(`  对阵 ${String(args.a)} vs ${String(args.b)}${dryRun ? '（dry-run 不打上游）' : ''}`);
  console.log(`  速率预算：上游臂 ${budget.upstreamSides} 个，估计 ≈ ${budget.jevCallsPerMin} 次/分（按 4s/步），单轮 D1 写 ≈ ${budget.writesPerDay} 行`);
  console.log(`  tag：${plans.map((p) => p.tag).join(' , ')}`);

  // 远端建目录 + 逐个上传 plan
  if (!ssh(host, user, `mkdir -p ${repo}/.work/remote/${batchId}/{plans,logs}`)) die('远端 mkdir 失败（ssh 不通？）');
  for (const p of plans) {
    const rel = path.join('.work/remote', batchId, 'plans', `round-${p.round}.json`);
    if (!scp([rel, `${user}@${host}:${repo}/.work/remote/${batchId}/plans/round-${p.round}.json`])) die(`上传 round-${p.round} plan 失败`);
  }

  // 逐轮起 worker（后台；</dev/null + nohup + pid 落盘，避免 ssh 会话被后台进程拖住）
  for (const p of plans) {
    const planPath = `${repo}/.work/remote/${batchId}/plans/round-${p.round}.json`;
    const logPath = `${repo}/.work/remote/${batchId}/logs/round-${p.round}.log`;
    const pidPath = `${repo}/.work/remote/${batchId}/logs/round-${p.round}.pid`;
    const ok = ssh(host, user,
      `cd ${repo} && exec nohup node scripts/experiment-worker.mjs --plan ${planPath} >> ${logPath} 2>&1 < /dev/null & echo $! > ${pidPath}; echo "started pid=$(cat ${pidPath})"`,
      20000, SSH_LAUNCH_OPTS);
    if (!ok) die(`round-${p.round} worker 启动失败`);
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
  const ok = ssh(host, user,
    `cd ${repo} && exec nohup node scripts/experiment-worker.mjs --plan ${planPath} >> ${logPath} 2>&1 < /dev/null & echo $! > ${pidPath}; echo "started pid=$(cat ${pidPath})"`,
    20000, SSH_LAUNCH_OPTS);
  if (!ok) die(`round-${round} 续跑失败（plan 不存在？ssh 不通？）`);
  console.log(`已续跑 batch=${batchId} round=${round}（已完成的对局会按 checkpoint 跳过）`);
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
  fs.rmSync(localDir, { recursive: true, force: true }); // 每次整体覆盖，保持目录形状稳定
  if (!scp(['-r', `${user}@${host}:${repo}/.work/remote/${batchId}`, outParent + path.sep])) die('scp 拉取失败');
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

/* ---------------- elo ---------------- */
function cmdElo(args) {
  const dirs = args._;
  if (dirs.length === 0) die('elo 需要一个或多个含棋谱 JSON 的目录');
  const k = args.k ? Number(args.k) : 16;
  const records = loadRecords(dirs.map((d) => path.resolve(d)));
  if (records.length === 0) { console.log('没有可统计的棋谱'); return; }
  const rows = rankTable(records, k);
  console.log(`样本：${records.length} 局，K=${k}（和棋 0.5，顺序迭代；<${MIN_GAMES} 局标注样本不足）\n`);
  console.log(formatRankTable(rows));
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
    fs.writeFileSync(out, JSON.stringify({ k, records, rows }, null, 2) + '\n');
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
  else if (cmd === 'status') pullBatch(args, { quiet: false });
  else if (cmd === 'pull') pullBatch(args, { quiet: true });
  else if (cmd === 'elo') cmdElo(args);
  else {
    console.log('用法：node scripts/experiment-batch.mjs <submit|resume|status|pull|elo> [选项]');
    console.log('  submit --a <spec> --b <spec> [--games 12] [--rounds 1] [--pause 2500] [--seed N] [--dry-run]');
    console.log('  resume --batch 名 [--round N]   按 checkpoint 续跑某一轮（kill 后恢复用）');
    console.log('  status [--batch 名]    拉回并显示每轮进度');
    console.log('  pull   --batch 名      拉回远端产物');
    console.log('  elo   <目录...>        本地算 Elo 排行');
    process.exit(cmd ? 2 : 0);
  }
}

main();
