#!/usr/bin/env node
// experiment-ladder.mjs — P6 阶梯编排器（本地 CLI）
//
// 用法：
//   node scripts/experiment-ladder.mjs --ladder L3 [--with-5000] [--games 20]
//   node scripts/experiment-ladder.mjs --identities 'rapfi::500,rapfi::1000,official::0'
//     [--batch lad1004-0930] [--openings /root/ladder/openings.json] [--seed N]
//     [--store local|d1] [--upstream direct|worker] [--rate-limit 30] [--key-file /root/.jev-key]
//     [--origin https://…] [--allow-production] [--max-plies 225] [--topk 3] [--pause 2500]
//     [--timeout-min 180] [--stall-min 15] [--cooldown 30] [--max-rounds N] [--allow-odd]
//     [--dry-run] [--force] [--host IP] [--user root] [--repo /root/board-games]
//     [--no-upload] [--prefix ladders/<batch>]
//
// 语义（与 docs/plans/2026-10-03-tactics-fidelity-and-elo-ladder.md §7 对齐）：
//   - 每条对决算一轮，**串行**跑：起一轮 → 等它的 pid 退出 → 拉该轮产物 → 再起下一轮。
//     理由写在 §7：单上游臂串行 + 轮间冷却是成本纪律（并行会撞限流，且共享上游延迟污染对照）。
//   - 每对局数必须是**偶数**（颜色对称 = 同一开局换色双跑，见 lib/ladder.mjs 口径 1）。
//   - 「跑完了」的判据是**远端 `games.jsonl` 行数 ≥ 局数**，本地 `ladder.json` 只是缓存
//     ⇒ 中断后重跑同一条命令即续跑；`--force` 才全部重跑。
//   - 零 CF 触碰：worker 缺省 `--store local` + `--upstream direct`（G3/D11/D12）。
//   - 每轮结束把白名单产物 push 到桶前缀（缺凭据/网络失败只告警，不阻断；`--no-upload` 关掉）。
//
// 远端拓扑（与 experiment-batch.mjs 一致，<remoteRoot>/.work/remote/<ladderId>/）：
//   ladder.json        本轮阶梯状态（本地也留一份；远端那份是给 SSH 看的）
//   lines.txt          「每轮 games.jsonl 行数」快照（本机 ssh 不抓管道 ⇒ 远端写文件再 scp 回来）
//   plans/round-<i>.json
//   round-<i>/         worker 产物（games.jsonl / progress.json / events.jsonl / round-summary.json）
//   logs/round-<i>.log nohup 日志

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  productionGate, sanitizeBatchId,
} from './lib/batch-common.mjs';
import {
  RAPFI_SPECS, pairsForPreset, pairsForAll, parseIdentityList, roundRobin, identityOfSpec,
  buildLadder, newLadderState, applyRoundResult, resumeDecisions, summarizeLadder,
  formatRoundLine, formatLadderProgress, formatLadderTable, ladderDir, stateFile,
  estimateRoundSeconds,
  readLadderState, writeLadderState, writePlans,
} from './lib/ladder.mjs';
import { gameRecord } from './lib/batch-elo.mjs';
import { collectArtifacts, pushArtifacts, requireBucketCfg, defaultPrefix } from './batch-bucket.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // scripts/ → 仓库根
const DEFAULT_HOST = '185.242.234.48';
const DEFAULT_USER = 'root';
const DEFAULT_REPO = '/root/board-games';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
const SSH_LAUNCH_OPTS = ['-n', ...SSH_OPTS]; // 起 worker 用（stdin 走 /dev/null）

const USAGE = `用法：
  node scripts/experiment-ladder.mjs --ladder L1|L2|L3|all [--with-5000] [--games 20]
  node scripts/experiment-ladder.mjs --identities 'rapfi::500,rapfi::1000' [--games 20]
选项：
  --ladder <预设>       L1（5 版两两 10 对）/ L2（5 版 × rapfi 3 档 15 对）/ L3（rapfi 3 档两两）/ all
  --identities <a,b,c>  自定义身份（spec = 渠道[:战术档][:思考ms]），与 --ladder 二选一
  --with-5000           L3/all 追加一条 rapfi@5000 vs @1000
  --games <n>           每对局数（必须偶数；缺省 20）
  --allow-odd           放行奇数局数（最后一局没有换色对手，只用于看个大概）
  --batch <id>          阶梯 id（1-16 位小写字母/数字/中划线；缺省 lad<MMDD>-<HHmm>）
  --openings <远端路径> 配对开局库（scripts/lib/openings.mjs 产物；缺省不用）
  --seed <n>            每轮 worker 的 seed（缺省 20261004）
  --store local|d1      缺省 local（只落远端 games.jsonl，零 CF 写）
  --upstream direct|worker  缺省 direct（box 直连上游，零 CF 触碰）
  --rate-limit <n>      上游请求/分（缺省 30；连续 5 次 429 熔断）
  --key-file <路径>     远端 key 文件（缺省 /root/.jev-key，由远端 shell source）
  --origin <url>        经业主 Worker 时的地址（不给 origin 还要写生产 D1 必须 --allow-production）
  --max-plies/--topk/--pause/--timeout-min/--stall-min   透传给每轮 plan
  --cooldown <秒>       轮间冷却（缺省 30；单上游臂串行的成本纪律）
  --max-rounds <n>      只跑前 n 轮（临时/验收用；不重编号，tag 保持原样）
  --dry-run             只打印计划表与将执行的命令，不落远端
  --force               忽略本地状态，全部重跑
  --host/--user/--repo  远端拓扑（缺省 ${DEFAULT_HOST} / ${DEFAULT_USER} / ${DEFAULT_REPO}）
  --no-upload           不 push 桶
  --prefix <前缀>       桶前缀（缺省 ladders/<batch>）
`;

/** 用法错/闸门拒绝：抛 `{exitCode}`，由入口转成 exit code（可被单测直接断言，不杀测试进程）。 */
function die(msg, code = 2) {
  const err = new Error(msg);
  err.exitCode = code;
  throw err;
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
    if (err.signal === 'SIGTERM' && sigtermOk) {
      console.log('（本地 ssh 客户端已超时断开；远端 nohup worker 不受影响，重跑本命令即可续跑）');
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

/** 缺省阶梯 id：lad<MMDD>-<HHmm>（11 位，合法且一眼看得出是哪天起的）。 */
function defaultLadderId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `lad${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * 一行一局：读 `<dir>/games.jsonl`，算 **A 视角**的 W/D/L。
 * A 是黑是白优先看记录自己的身份（`black`/`white` 身份串与 A 比对）—— 某一局缺行时
 * 「奇数局 A 执黑」的位置推断就会错位；拿不到身份线索时才退回位置推断（idx 偶数 ⇒ A 执黑，
 * 与 worker 的 `sidesForGameSpec()` 同口径）。
 */
export function wdlOfGamesJsonl(dir, aIdentity = null) {
  const file = path.join(dir, 'games.jsonl');
  if (!fs.existsSync(file)) return { w: 0, d: 0, l: 0, lines: 0, counted: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((s) => s.trim());
  const wdl = { w: 0, d: 0, l: 0, lines: lines.length, counted: 0 };
  lines.forEach((line, idx) => {
    let rec = null;
    try { rec = gameRecord(line); } catch { rec = null; }
    if (!rec) return; // 半行/未终局：不计入 W-D-L（和「未终局不进 Elo」同口径）
    // 两侧身份相同（手写棋谱才会出现）⇒ 分不出 A 执哪边，退回位置推断
    const byIdentity = !aIdentity ? null
      : (rec.black === aIdentity && rec.white !== aIdentity) ? true
        : (rec.white === aIdentity && rec.black !== aIdentity) ? false
          : null;
    const aBlack = byIdentity === null ? idx % 2 === 0 : byIdentity;
    const aScore = aBlack ? rec.blackScore : 1 - rec.blackScore;
    if (aScore === 1) wdl.w += 1; else if (aScore === 0.5) wdl.d += 1; else wdl.l += 1;
    wdl.counted += 1;
  });
  return wdl;
}

/** 拉一轮产物（先 staging 再 rename，避免半拉覆盖旧副本）。 */
function pullRound(host, user, remoteRoot, id, round, localBase) {
  const remoteDir = `${remoteRoot}/.work/remote/${id}/round-${round}`;
  const stage = path.join(localBase, `.stage-${round}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  if (!scp(['-r', `${user}@${host}:${remoteDir}`, stage + path.sep])) {
    fs.rmSync(stage, { recursive: true, force: true });
    return false;
  }
  const staged = path.join(stage, `round-${round}`);
  if (!fs.existsSync(staged)) {
    fs.rmSync(stage, { recursive: true, force: true });
    return false;
  }
  const dest = path.join(localBase, `round-${round}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staged, dest);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(localBase, 'logs'), { recursive: true });
  scp([`${user}@${host}:${remoteRoot}/.work/remote/${id}/logs/round-${round}.log`,
    path.join(localBase, 'logs', `round-${round}.log`)]); // 缺日志不算失败
  return true;
}

/**
 * 远端每轮 `games.jsonl` 行数 → `{round: lines}`。
 * 本机不抓 ssh 管道（沙箱/管道 stdio 会 EPERM，见实验面脚本的既有约定）⇒ 远端先写 lines.txt 再 scp 回来。
 */
function remoteLineCounts(host, user, remoteRoot, id, localBase) {
  const remote = `${remoteRoot}/.work/remote/${id}`;
  const cmd = [
    `cd ${remote} 2>/dev/null || exit 0`,
    ': > lines.txt',
    'for d in round-*; do',
    '  [ -d "$d" ] || continue',
    '  n=$(wc -l < "$d/games.jsonl" 2>/dev/null || echo 0)',
    '  echo "${d#round-} $n" >> lines.txt',
    'done',
  ].join('\n');
  if (!ssh(host, user, cmd, 60000)) return {};
  const local = path.join(localBase, 'lines.txt');
  fs.mkdirSync(localBase, { recursive: true });
  if (!scp([`${user}@${host}:${remote}/lines.txt`, local])) return {};
  const out = {};
  for (const line of fs.readFileSync(local, 'utf8').split('\n')) {
    const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (m) out[Number(m[1])] = Number(m[2]);
  }
  return out;
}

/** 每轮结束 push 桶（缺凭据/失败只告警）。 */
async function pushToBucket(localBase, id, args) {
  if (args['no-upload']) { console.log('  （--no-upload：跳过桶上传）'); return; }
  let cfg = null;
  try {
    cfg = requireBucketCfg(process.env, {});
  } catch (err) {
    console.warn(`  ⚠ 桶凭据缺失，跳过上传：${err.message}`);
    return;
  }
  const files = collectArtifacts(localBase);
  if (!files.length) { console.log('  （没有可上传的产物）'); return; }
  const prefix = args.prefix ? String(args.prefix) : defaultPrefix(id);
  try {
    const res = await pushArtifacts(files, { cfg, prefix });
    console.log(`  桶：${prefix}/ 上传 ${res.uploaded}/${files.length} 个（${res.bytes} B）${res.failed ? `，失败 ${res.failed}（不阻断）` : ''}`);
  } catch (err) {
    console.warn(`  ⚠ 桶上传失败（不阻断）：${err.message}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE); return 0; }
  const args = parseArgs(argv);
  const host = args.host ? String(args.host) : DEFAULT_HOST;
  const user = args.user ? String(args.user) : DEFAULT_USER;
  const repo = args.repo ? String(args.repo) : DEFAULT_REPO;

  if (args.ladder && args.identities) die('--ladder 与 --identities 二选一');
  if (!args.ladder && !args.identities) die('要给一条阶梯：--ladder L1|L2|L3|all，或 --identities a,b,c');
  const with5000 = Boolean(args['with-5000']);
  const games = args.games !== undefined ? Number(args.games) : 20;
  const store = args.store !== undefined ? String(args.store) : 'local';
  const upstream = args.upstream !== undefined ? String(args.upstream) : 'direct';
  if (!['local', 'd1'].includes(store)) die(`--store 只认 local|d1：${store}`);
  if (!['direct', 'worker'].includes(upstream)) die(`--upstream 只认 direct|worker：${upstream}`);
  const rateLimit = args['rate-limit'] !== undefined ? Number(args['rate-limit']) : 30;
  if (!Number.isFinite(rateLimit) || rateLimit <= 0) die('--rate-limit 必须是正数（每分钟请求数）');
  const keyFile = args['key-file'] !== undefined ? String(args['key-file']) : '/root/.jev-key';
  const origin = args.origin !== undefined ? String(args.origin) : null;
  const seed = args.seed !== undefined ? Number(args.seed) : 20261004;
  if (!Number.isInteger(seed)) die('--seed 必须是整数');
  const cooldownS = args.cooldown !== undefined ? Number(args.cooldown) : 30;
  if (!Number.isFinite(cooldownS) || cooldownS < 0) die('--cooldown 必须是非负数（秒）');
  const dryRun = Boolean(args['dry-run']);
  const force = Boolean(args.force);

  /* 闸门（P1 口径）：只有真要写生产 D1 时才要 `--allow-production`。
     阶梯缺省 `--store local --upstream direct`（零 CF 触碰），此时 origin 根本用不上，
     不该拿「写生产 D1」的闸门拦一条不碰 CF 的跑动。 */
  if (store === 'd1') {
    const gate = productionGate({ origin, allowProduction: Boolean(args['allow-production']) });
    if (gate) die(gate);
    if (!origin) die('--store d1 需要 --origin（写哪套 D1 要写清楚）');
  } else if (upstream === 'worker' && !origin) {
    die('--upstream worker 需要 --origin（经哪套 Worker 转发要写清楚）；零 CF 触碰请用 --upstream direct');
  }
  // 闸门 2：阶梯必须串行 —— 要并行单批次请用 experiment-batch.mjs submit --parallel（仅双本地臂）。
  if (args.parallel) {
    die('阶梯不并行：串行 + 轮间冷却是成本纪律（§7「单上游臂串行 + 轮次间冷却」）。'
      + '要并行单批次请用 experiment-batch.mjs submit --parallel（那里只放行双本地臂，双 proxy 会被 parallelGate 拒掉）。');
  }
  if (store === 'd1' && !origin) die('--store d1 需要 --origin（写哪套 D1 要写清楚）');

  const now = new Date();
  let ladderId;
  try {
    ladderId = sanitizeBatchId(args.batch ? String(args.batch) : defaultLadderId(now));
  } catch (err) {
    die(err && err.message ? err.message : String(err)); // 非法 --batch 也是用法错（exit 2）
  }
  // 身份/预设/计划里的输入错都是用法错（exit 2），不是运行时故障。
  let title; let pairs; let ladder;
  try {
    ({ title, pairs } = args.identities
      ? { title: '自定义身份', pairs: roundRobin(parseIdentityList(args.identities)) }
      : (String(args.ladder).toLowerCase() === 'all'
        ? pairsForAll({ with5000 })
        : pairsForPreset(String(args.ladder).toUpperCase(), { with5000 })));
    ladder = buildLadder({
      ladderId, pairs, games, now, seed,
      openings: args.openings ? String(args.openings) : null,
      store, upstream, rateLimit, keyFile, origin, remoteRoot: repo,
      pauseMs: args.pause !== undefined ? Number(args.pause) : 2500,
      timeoutMin: args['timeout-min'] !== undefined ? Number(args['timeout-min']) : 180,
      stallMin: args['stall-min'] !== undefined ? Number(args['stall-min']) : 15,
      maxPlies: args['max-plies'] !== undefined ? Number(args['max-plies']) : 225,
      topK: args.topk !== undefined ? Number(args.topk) : 3,
      dryRun, allowOdd: Boolean(args['allow-odd']),
    });
  } catch (err) {
    die(err && err.message ? err.message : String(err));
  }
  if (args['max-rounds'] !== undefined) {
    const n = Number(args['max-rounds']);
    if (!Number.isInteger(n) || n < 1) die('--max-rounds 必须是 ≥1 的整数');
    ladder.rounds = ladder.rounds.slice(0, n);
    ladder.totalGames = ladder.rounds.reduce((s, r) => s + r.games, 0);
  }

  const localBase = ladderDir(ROOT, ladderId);
  fs.mkdirSync(localBase, { recursive: true });
  const statePath = stateFile(ROOT, ladderId);
  let state = readLadderState(statePath) || newLadderState(ladder);

  console.log(`阶梯 ${ladderId}：${title}｜${ladder.rounds.length} 轮｜每对 ${ladder.gamesPerPair} 局｜合计 ${ladder.totalGames} 局`);
  console.log(`  运行面：${upstream === 'direct' ? `直连上游（零 CF 触碰，G3）；自限速 ${rateLimit}/分，key 从远端 ${keyFile} 注入` : `经业主 Worker（${origin}）`}`);
  console.log(`  存储：${store === 'd1' ? '归档进 D1（origin 已给）' : '仅落远端 games.jsonl（零网络写，D11）'}｜开局库：${ladder.openings || '（不用）'}`);
  console.log(`  对称性：每对局数 ${ladder.gamesPerPair}（偶数 ⇒ 同一开局换色双跑）｜轮间冷却 ${cooldownS}s｜串行`);
  console.log(`  远端：${user}@${host}:${repo}/.work/remote/${ladderId}\n`);
  for (const line of formatLadderTable(ladder.rounds, { estimateOf: (r) => estimateRoundSeconds(r) })) console.log('  ' + line);
  {
    const estS = ladder.rounds.reduce((s, r) => s + estimateRoundSeconds(r), 0);
    console.log(`  预计墙钟合计 ≈${(estS / 3600).toFixed(1)}h（粗估：每局 60 手，上游臂 1.1 s/手、rapfi think/2；用来排序跑哪条，不是报表口径）`);
  }
  if (dryRun) {
    console.log('\n--dry-run：不落远端。将要执行的命令（每轮一条）：');
    for (const r of ladder.rounds) {
      console.log(`  scp .work/remote/${ladderId}/plans/round-${r.round}.json → ${repo}/.work/remote/${ladderId}/plans/`);
      console.log(`  ssh ${user}@${host} 'cd ${repo} && set -a; . ${keyFile}; set +a; exec nohup node scripts/experiment-worker.mjs --plan ${repo}/.work/remote/${ladderId}/plans/round-${r.round}.json'`);
    }
    return 0;
  }

  // 本地落 plan + 状态；远端也放一份 ladder.json（SSH 时能直接看进度，不是权威）
  writePlans(ROOT, ladder);
  writeLadderState(statePath, state);
  const remoteBatch = `${repo}/.work/remote/${ladderId}`;
  const pushState = () => {
    scp([statePath, `${user}@${host}:${remoteBatch}/ladder.json`]); // 失败不算错（权威在本地）
  };

  if (!ssh(host, user, `mkdir -p ${remoteBatch}/{plans,logs}`)) die('远端 mkdir 失败（ssh 不通？）');
  for (const r of ladder.rounds) {
    const rel = path.join(ROOT, '.work/remote', ladderId, 'plans', `round-${r.round}.json`);
    if (!scp([rel, `${user}@${host}:${remoteBatch}/plans/round-${r.round}.json`])) {
      die(`上传 round-${r.round} plan 失败`);
    }
  }
  pushState();

  // 续跑判定：本地 ok + 远端行数够才跳过（状态文件坏了也不该重跑已跑完的轮次）
  const remoteLines = remoteLineCounts(host, user, repo, ladderId, localBase);
  const decisions = resumeDecisions(state, { force, remoteLines });
  const skipCount = decisions.filter((d) => d.skip).length;
  console.log(`\n续跑判定：${skipCount} 轮跳过 / ${decisions.length - skipCount} 轮要跑`
    + `${skipCount ? `（远端行数快照：${JSON.stringify(remoteLines)}）` : ''}`);

  let failed = 0;
  for (let i = 0; i < ladder.rounds.length; i++) {
    const r = ladder.rounds[i];
    const d = decisions.find((x) => x.round === r.round) || { skip: false, reason: '' };
    if (d.skip) {
      console.log(`  ⏭️  round-${r.round} 跳过（${d.reason}）`);
      continue;
    }
    const started = Date.now();
    const planPath = `${remoteBatch}/plans/round-${r.round}.json`;
    const logPath = `${remoteBatch}/logs/round-${r.round}.log`;
    const pidPath = `${remoteBatch}/logs/round-${r.round}.pid`;
    console.log(`\n▶ round-${r.round} ${r.label} ${r.games} 局（tag=${r.tag}）`);
    const keyInject = `set -a; [ -f ${keyFile} ] && . ${keyFile}; set +a;`;
    const ok = ssh(host, user,
      `cd ${repo} && ${keyInject} exec nohup node scripts/experiment-worker.mjs --plan ${planPath} >> ${logPath} 2>&1 < /dev/null & echo $! > ${pidPath}; echo "started pid=$(cat ${pidPath})"`,
      20000, SSH_LAUNCH_OPTS, true);
    if (!ok) {
      failed += 1;
      state = applyRoundResult(state, r, { status: 'failed', error: 'worker 启动失败（ssh 不通？）' }, { now: new Date() });
      writeLadderState(statePath, state);
      pushState();
      console.log(formatRoundLine(r, { status: 'failed', error: 'worker 启动失败' }));
      continue;
    }
    // 等这一轮退出（最多 12 h，每 30 s 一次）；本地 ssh 断开不算失败
    ssh(host, user,
      `for i in $(seq 1 1440); do kill -0 "$(cat ${pidPath})" 2>/dev/null || { echo "round ${r.round} 已结束"; exit 0; }; sleep 30; done; echo "round ${r.round} 轮询到 12h 上限"`,
      0);

    const durationMs = Date.now() - started;
    if (!pullRound(host, user, repo, ladderId, r.round, localBase)) {
      failed += 1;
      state = applyRoundResult(state, r, { status: 'failed', error: '拉产物失败（scp）', durationMs }, { now: new Date() });
      writeLadderState(statePath, state);
      pushState();
      console.log(formatRoundLine(r, { status: 'failed', error: '拉产物失败' }));
      continue;
    }
    const wdl = wdlOfGamesJsonl(path.join(localBase, `round-${r.round}`), identityOfSpec(r.a).id);
    const status = wdl.lines >= r.games ? 'ok' : 'failed';
    const error = status === 'ok' ? null : `远端只有 ${wdl.lines}/${r.games} 局产物`;
    if (status === 'failed') failed += 1;
    state = applyRoundResult(state, r, { status, wdl, durationMs, remoteLines: wdl.lines, error }, { now: new Date() });
    writeLadderState(statePath, state);
    pushState();
    console.log('  ' + formatRoundLine(r, { status, wdl, durationMs, error }));
    console.log('  ' + formatLadderProgress(state));
    await pushToBucket(localBase, ladderId, args);
    if (cooldownS > 0 && i < ladder.rounds.length - 1) {
      console.log(`  轮间冷却 ${cooldownS}s…`);
      await new Promise((res) => setTimeout(res, cooldownS * 1000));
    }
  }

  const sum = summarizeLadder(state, { nowMs: Date.now() });
  console.log(`\n阶梯 ${ladderId} 结束：${sum.done}/${sum.total} 轮正常${sum.failed ? `、${sum.failed} 轮失败` : ''}`
    + `｜${sum.gamesDone}/${sum.gamesTotal} 局｜W${sum.wdl.w}-D${sum.wdl.d}-L${sum.wdl.l}`);
  console.log('  产物：' + path.relative(ROOT, localBase).replace(/\\/g, '/'));
  if (!args['no-upload']) console.log(`  桶前缀：${args.prefix ? String(args.prefix) : defaultPrefix(ladderId)}/`);
  console.log(`  算 Elo：node scripts/experiment-batch.mjs elo .work/remote/${ladderId}`);
  console.log(`  看进度：node scripts/experiment-batch.mjs status --watch --batch ${ladderId}`);
  if (sum.failed) { console.log(`  ⚠ 有 ${sum.failed} 轮失败：重跑同一条命令即可续跑（失败的轮会重跑，已 ok 的轮按远端行数跳过）`); process.exitCode = 1; }
  return process.exitCode || 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''));
if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error('✗ ' + (err && err.message ? err.message : String(err)));
    process.exitCode = (err && err.exitCode) || 1;
  }
}

export { main as ladderMain };
