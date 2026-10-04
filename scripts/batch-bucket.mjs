#!/usr/bin/env node
/**
 * scripts/batch-bucket.mjs — 把实验产物传到对象桶（D14）
 *
 * 用法（凭据**只**从环境变量读）：
 *   BUCKET_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
 *   BUCKET_NAME=<桶名> BUCKET_ACCESS_KEY_ID=… BUCKET_SECRET_ACCESS_KEY=… \
 *   node scripts/batch-bucket.mjs push --batch <批量名> [--dir <本地批目录>] [--prefix <前缀>] [--dry-run] [--strict]
 *   node scripts/batch-bucket.mjs pull --batch <批量名> [--out <目录>] [--prefix <前缀>]
 *   node scripts/batch-bucket.mjs ls [--prefix <前缀>] [--max 100]
 *
 * 为什么是纯 Node：box 上既没有 rclone 也没有 aws cli（D14 勘察结论），而 AWS SigV4 用
 * `node:crypto` 就能算完（scripts/lib/s3-put.mjs，向量已对 AWS 官方文档逐字节校过）。
 *
 * 三条纪律：
 *   ① 凭据缺失 **exit 3**，不静默降级成「传了个空桶」；桶里也没有半截凭据。
 *   ② 上传失败**只告警不阻断**（一次网络抖动不该让跑了一整晚的阶梯丢掉本地唯一产物）；
 *      想要硬失败请显式 `--strict`。
 *   ③ 只传白名单里的研究产物（games.jsonl / progress.json / events.jsonl / plan / 汇总 / report / elo），
 *      `.pid`、`logs/*.log`、逐局 JSON 这些要么是过程垃圾要么能由 JSONL 重建。
 *
 * 远端布局（每个批量一个前缀）：
 *   <prefix>/plans/round-<i>.json
 *   <prefix>/round-<i>/{games.jsonl,progress.json,events.jsonl,round-summary.json,report.md}
 *   <prefix>/{games.jsonl,elo.json,report.md,summary.json}
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bucketConfigFromEnv,
  missingBucketVars,
  getObject,
  listPrefix,
  putFile,
} from './lib/s3-put.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // scripts/ → 仓库根

/** 认这些相对路径（`/` 分隔、相对批量目录）。别的文件不进桶。 */
const ARTIFACT_PATTERNS = [
  /^games\.jsonl$/,
  /^elo\.json$/,
  /^summary\.json$/,
  /^report\.md$/,
  /^plans\/round-\d+\.json$/,
  /^round-\d+\/(games\.jsonl|progress\.json|events\.jsonl|round-summary\.json|report\.md)$/,
];

export function isArtifact(rel) {
  return ARTIFACT_PATTERNS.some((re) => re.test(rel));
}

/** 目录里**该进桶的**文件清单（相对路径用 `/`，按字典序）。递归两层，符号链接不跟（`statSync` 只看普通文件）。 */
export function collectArtifacts(batchDir, { readdir = fs.readdirSync, stat = fs.statSync } = {}) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdir(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let st;
      try { st = stat(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs, rel); continue; }
      if (!st.isFile()) continue;
      if (!isArtifact(rel)) continue;
      out.push({ rel, abs, size: st.size });
    }
  };
  walk(batchDir, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** `<前缀>/<相对路径>`；前缀两端的 `/` 归一，空前缀 = 直接放桶根。 */
export function keyFor(prefix, rel) {
  const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
  return p ? `${p}/${rel}` : rel;
}

export function defaultPrefix(batchId) {
  return `ladders/${batchId}`;
}

/** 凭据闸门（纪律①）：缺变量就抛，消息点名缺了哪几个。 */
export function requireBucketCfg(env = process.env, { addressing } = {}) {
  const cfg = bucketConfigFromEnv(env, { addressing });
  if (!cfg) {
    const missing = missingBucketVars(env);
    throw new Error(`缺少桶凭据：${missing.join(' / ')}（D14：凭据只从环境变量读，不落仓库/日志）`);
  }
  return cfg;
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

/** `push` 的纯核心：给定文件清单与注入的传输函数，返回 `{uploaded, failed, bytes}`（不 process.exit）。 */
export async function pushArtifacts(files, { cfg, prefix, fetchImpl, now, quiet = false, write = process.stdout.write.bind(process.stdout) } = {}) {
  const res = { uploaded: 0, failed: 0, bytes: 0, failures: [] };
  for (const f of files) {
    const key = keyFor(prefix, f.rel);
    try {
      await putFile({ cfg, file: f.abs, key, fetchImpl, now });
      res.uploaded += 1;
      res.bytes += f.size;
      if (!quiet) write(`↑ ${f.rel} → ${key}（${f.size} B）\n`);
    } catch (err) {
      res.failed += 1;
      res.failures.push({ rel: f.rel, message: err.message });
      write(`⚠ 上传失败 ${f.rel}：${err.message}\n`);
    }
  }
  return res;
}

function cmdPush(args, env) {
  const batchId = String(args.batch || '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!batchId) throw new Error('push 需要 --batch <批量名>');
  const dir = path.resolve(String(args.dir || path.join(ROOT, '.work/remote', batchId)));
  if (!fs.existsSync(dir)) throw new Error(`本地没有 ${dir}（先 pull 或在本机跑过这一轮）`);
  const prefix = String(args.prefix || defaultPrefix(batchId));
  const files = collectArtifacts(dir);
  const dryRun = !!args['dry-run'];
  process.stdout.write(`push batch=${batchId}\n  本地 ${dir}\n  前缀 ${prefix}｜${files.length} 个文件 / ${files.reduce((s, f) => s + f.size, 0)} B\n`);
  if (files.length === 0) { process.stdout.write('  没有可传的产物（白名单里一个都没有）\n'); return 0; }
  if (dryRun) {
    for (const f of files) process.stdout.write(`  · ${f.rel} → ${keyFor(prefix, f.rel)}\n`);
    process.stdout.write('（--dry-run：没有发任何请求）\n');
    return 0;
  }
  const cfg = requireBucketCfg(env, { addressing: args.addressing });
  return pushArtifacts(files, { cfg, prefix }).then((res) => {
    process.stdout.write(`完成：成功 ${res.uploaded} / 失败 ${res.failed}（${res.bytes} B）\n`);
    if (res.failed && args.strict) {
      process.stderr.write('✗ --strict：有文件没传上去\n');
      return 1;
    }
    if (res.failed) process.stdout.write('注意：有失败项，但按 D14 不阻断（本地产物仍在，可重跑 push）\n');
    return 0;
  });
}

async function cmdPull(args, env) {
  const cfg = requireBucketCfg(env, { addressing: args.addressing });
  const prefix = String(args.prefix || (args.batch ? defaultPrefix(String(args.batch)) : '')).replace(/^\/+|\/+$/g, '');
  if (!prefix) throw new Error('pull 需要 --batch <批量名> 或 --prefix <前缀>');
  const out = path.resolve(String(args.out || path.join(ROOT, '.work/remote', path.basename(prefix))));
  const { keys, truncated } = await listPrefix({ cfg, prefix: `${prefix}/`, maxKeys: args.max ? Number(args.max) : 1000 });
  process.stdout.write(`pull ${prefix} → ${out}（${keys.length} 个对象${truncated ? '，列表被截断（--max 调大）' : ''}）\n`);
  let ok = 0;
  for (const key of keys) {
    const rel = key.slice(prefix.length + 1);
    if (!rel || !isArtifact(rel)) { process.stdout.write(`  · 跳过 ${key}（不在白名单）\n`); continue; }
    const abs = path.join(out, ...rel.split('/'));
    const got = await getObject({ cfg, key });
    if (got.status === 404 || got.body == null) { process.stdout.write(`  · 桶里没有 ${key}\n`); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, got.body);
    ok += 1;
    process.stdout.write(`↓ ${key} → ${abs}（${Buffer.byteLength(got.body)} B）\n`);
  }
  process.stdout.write(`完成：落盘 ${ok} 个\n`);
  return 0;
}

async function cmdLs(args, env) {
  const cfg = requireBucketCfg(env, { addressing: args.addressing });
  const prefix = String(args.prefix || '').replace(/^\/+/, '');
  const { keys, truncated } = await listPrefix({ cfg, prefix, maxKeys: args.max ? Number(args.max) : 100 });
  for (const key of keys) process.stdout.write(`${key}\n`);
  process.stdout.write(`共 ${keys.length} 个对象${truncated ? '（截断，用 --max 放宽）' : ''}\n`);
  return 0;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  try {
    if (cmd === 'push') return await cmdPush(args, env);
    if (cmd === 'pull') return await cmdPull(args, env);
    if (cmd === 'ls') return await cmdLs(args, env);
    process.stdout.write('用法：node scripts/batch-bucket.mjs <push|pull|ls> [选项]\n');
    process.stdout.write('  push --batch <名> [--dir <本地批目录>] [--prefix <前缀>] [--dry-run] [--strict]\n');
    process.stdout.write('  pull --batch <名> [--out <目录>] [--prefix <前缀>] [--max N]\n');
    process.stdout.write('  ls [--prefix <前缀>] [--max N]\n');
    process.stdout.write('  环境变量：BUCKET_ENDPOINT / BUCKET_NAME / BUCKET_ACCESS_KEY_ID / BUCKET_SECRET_ACCESS_KEY\n');
    process.stdout.write('            可选 BUCKET_ADDRESSING=path|virtual（缺省 path）\n');
    return cmd ? 2 : 0;
  } catch (err) {
    /* 凭据缺失是 exit 3（区别于用法错 2）：CI 里能一眼分清「配置没给」和「命令写错」。 */
    const creds = /缺少桶凭据/.test(err.message);
    process.stderr.write(`✗ ${err.message}\n`);
    return creds ? 3 : 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''));
if (invokedDirectly) process.exitCode = await main();
