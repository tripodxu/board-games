// scripts/lib/s3-put.mjs — 纯 Node `crypto` 的 AWS SigV4 客户端（零依赖，S3 兼容：R2 / S3 / B2 / MinIO）
//
// 为什么自己写：AGENTS.md 铁律 2（不新增运行时依赖）⇒ 不引 `@aws-sdk/*`；box 上也没有 rclone/aws CLI
// （见计划 `docs/plans/2026-10-03-tactics-fidelity-and-elo-ladder.md` D14 与 §8 风险表）。
//
// 口径：
//   - 只实现「上传/下载/列举」三件事（`putObject` / `getObject` / `listPrefix`），够 P4b/P6 用；
//   - 签名集合固定为 `host;x-amz-content-sha256;x-amz-date` + 调用方给的额外头（按名字排序、小写）；
//   - payload 一律先算 sha256（流式上传不做，产物是几 MB 级文件）；
//   - 时区/编码踩坑点：CanonicalURI 逐段编码（**不**把 `/` 编成 `%2F`），CanonicalQuery 按键值排序且
//     键值都要编码，签名头按小写名排序、值去首尾空白并把连续空白压成一个空格（SigV4 规范原文）。
//
// 已知向量见 `test/scripts/s3-put.spec.mjs`（AWS 文档里那两个例子逐字节钉死）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const ALGO = 'AWS4-HMAC-SHA256';

/** sha256 十六进制（字符串按 utf8；Buffer 原样）。 */
export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** 派生签名密钥：kDate → kRegion → kService → kSigning（AWS4 前缀只在第一层）。 */
export function signingKey(secretAccessKey, date, region, service) {
  const kDate = hmac('AWS4' + secretAccessKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** RFC 3986 编码（SigV4 要的那套：`A-Za-z0-9-_.~` 之外全编码）。 */
export function uriEncode(value, encodeSlash = true) {
  let out = '';
  for (const ch of String(value)) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === '/') out += encodeSlash ? '%2F' : '/';
    else out += Buffer.from(ch, 'utf8').toString('hex').replace(/../g, (h) => '%' + h.toUpperCase());
  }
  return out;
}

/** 对象键 → CanonicalURI（逐段编码，保留分隔 `/`；空键表示桶根，规范里要写 `/`）。 */
export function canonicalUri(keyPath) {
  const raw = String(keyPath || '');
  if (!raw || raw === '/') return '/';
  const p = raw.startsWith('/') ? raw : `/${raw}`;
  return p.split('/').map((seg) => uriEncode(seg, false)).join('/');
}

/** 查询串（`a=1&b=2` 或对象）→ CanonicalQueryString（键值编码后按键排序）。 */
export function canonicalQuery(query) {
  const pairs = [];
  if (typeof query === 'string') {
    for (const part of query.replace(/^\?/, '').split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      pairs.push(i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)]);
    }
  } else if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) pairs.push([k, String(v)]);
  }
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** 签名头的值规范化：去首尾空白 + 连续空白压一格（SigV4 规范）。 */
export function canonicalHeaderValue(v) {
  return String(v).trim().replace(/\s+/g, ' ');
}

export function amzDate(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return iso; // YYYYMMDDTHHMMSSZ
}

export function dateStamp(amz) {
  return String(amz).slice(0, 8);
}

/**
 * 算出待签名的头（含 `host`、`x-amz-content-sha256`、`x-amz-date` 与调用方额外头）。
 * `headers` 里给 `host` 会按原样参与签名（不覆盖）；`now` 可注入（测试用固定时间戳）。
 */
export function signedHeadersFor({ method, url, headers = {}, payloadHash = EMPTY_SHA256, now = new Date() }) {
  const u = url instanceof URL ? url : new URL(url);
  // 调用方显式给的 `x-amz-date`（测试注入固定时间戳 / 重放旧请求）必须与凭据作用域里的日期一致，
  // 否则 StringToSign 用 now、头部用旧值，签名对不上（AWS 文档向量①就是这么抓出来的）。
  const providedDate = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-amz-date');
  const amz = providedDate ? canonicalHeaderValue(providedDate[1]) : amzDate(now);
  const merged = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz, ...headers };
  if (!merged.host && !merged.Host) merged.host = u.host;
  const lower = new Map();
  for (const [k, v] of Object.entries(merged)) {
    const name = k.toLowerCase();
    if (name === 'authorization') continue;
    lower.set(name, canonicalHeaderValue(v));
  }
  const names = [...lower.keys()].sort();
  return { amzDate: amz, headers: lower, names, method: String(method).toUpperCase(), url: u };
}

/** 组装 CanonicalRequest + StringToSign（拆出来是为了可单测、也为了日志里能自查）。 */
export function canonicalRequestFor(signed) {
  const { method, url, headers, names } = signed;
  const canonicalHeaders = names.map((n) => `${n}:${headers.get(n)}\n`).join('');
  const canonical = [
    method,
    canonicalUri(decodeURIComponentSafe(url.pathname)),
    canonicalQuery(url.search),
    canonicalHeaders,
    names.join(';'),
    headers.get('x-amz-content-sha256'),
  ].join('\n');
  return { canonicalRequest: canonical, signedHeaderNames: names.join(';'), canonicalHeaders };
}

/** `new URL()` 的 pathname 已是百分号编码；再编码一次会把 `%24` 变成 `%2524`（`test$file` 那个向量就是这么挂的）。 */
function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * SigV4 签名。返回 `{ authorization, headers, canonicalRequest, stringToSign, signature }`，
 * `headers` 是**要真正发出去**的头部（已含 `Authorization`）。
 * `region` 缺省 `auto`（R2 的惯例；S3 要真实 region），`service` 缺省 `s3`。
 */
export function signRequest({ method, url, headers = {}, payloadHash = EMPTY_SHA256, accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date() }) {
  if (!accessKeyId || !secretAccessKey) throw new Error('缺少 accessKeyId / secretAccessKey');
  const signed = signedHeadersFor({ method, url, headers, payloadHash, now });
  const { canonicalRequest, signedHeaderNames, canonicalHeaders } = canonicalRequestFor(signed);
  const scope = `${dateStamp(signed.amzDate)}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGO, signed.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(secretAccessKey, dateStamp(signed.amzDate), region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');
  const authorization = `${ALGO} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;
  const outHeaders = {};
  for (const [k, v] of signed.headers) outHeaders[k] = v;
  outHeaders.authorization = authorization;
  return { authorization, headers: outHeaders, canonicalRequest, canonicalHeaders, stringToSign, signature, scope, amzDate: signed.amzDate };
}

/** 端点解析：`https://<account>.r2.cloudflarestorage.com` / MinIO 的 `http://host:9000` 都认。 */
export function parseEndpoint(endpoint, { region = 'auto' } = {}) {
  const raw = String(endpoint || '').trim();
  if (!raw) throw new Error('缺少 BUCKET_ENDPOINT（形如 https://<account>.r2.cloudflarestorage.com）');
  const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  return { url: u, origin: u.origin, host: u.host, pathPrefix: u.pathname.replace(/\/$/, ''), region, secure: u.protocol === 'https:' };
}

/** 路径式（`endpoint/bucket/key`，MinIO/多数兼容实现）与虚拟主机式（`bucket.endpoint/key`，S3/R2 默认）。 */
export function objectUrl({ endpoint, bucket, key = '', addressing = 'path' }) {
  const ep = parseEndpoint(endpoint);
  const k = String(key || '');
  if (addressing === 'virtual') {
    const host = `${bucket}.${ep.host}`;
    return new URL(`${ep.url.protocol}//${host}${ep.pathPrefix}${canonicalUri(k)}`);
  }
  return new URL(`${ep.origin}${ep.pathPrefix}${canonicalUri(`${bucket}${k ? '/' + k : ''}`)}`);
}

/** 从环境变量取桶配置；缺任何一个都返回 `null`（调用方负责报「未配置桶」并 exit 3，不许静默跳过）。 */
export function bucketConfigFromEnv(env = process.env, { addressing } = {}) {
  const endpoint = env.BUCKET_ENDPOINT || '';
  const bucket = env.BUCKET_NAME || '';
  const accessKeyId = env.BUCKET_ACCESS_KEY_ID || '';
  const secretAccessKey = env.BUCKET_SECRET_ACCESS_KEY || '';
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const region = env.BUCKET_REGION || 'auto';
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
    addressing: addressing || env.BUCKET_ADDRESSING || 'path',
  };
}

export function missingBucketVars(env = process.env) {
  const need = ['BUCKET_ENDPOINT', 'BUCKET_NAME', 'BUCKET_ACCESS_KEY_ID', 'BUCKET_SECRET_ACCESS_KEY'];
  return need.filter((n) => !env[n]);
}

/** 桶配置 → 目标 URL（路径式 / 虚拟主机式两条路都走这里，避免两处口径打架）。 */
export function urlForCfg(cfg, key = '') {
  const ep = parseEndpoint(cfg.endpoint, { region: cfg.region });
  const k = String(key || '');
  if (cfg.addressing === 'virtual') {
    // 端点已经带桶名（`https://bucket.s3.amazonaws.com`）时再前置一次会拼出 `bucket.bucket.host`，
    // 症状是静默 404/403 —— 这种配置错必须在拼 URL 时就炸出来。
    if (ep.host.split('.')[0] === cfg.bucket) {
      throw new Error(`BUCKET_ENDPOINT 已经带桶名（${ep.host}），虚拟主机式会重复；请去掉桶名或用路径式寻址`);
    }
    return new URL(`${ep.url.protocol}//${cfg.bucket}.${ep.host}${ep.pathPrefix}${canonicalUri(k)}`);
  }
  return new URL(`${ep.origin}${ep.pathPrefix}${canonicalUri(`${cfg.bucket}${k ? '/' + k : ''}`)}`);
}

/** 最小请求执行器：算 payload 哈希 → 签名 → fetch（可注入 fetch 做单测）。 */
export async function s3Fetch({ cfg, method, key = '', query, headers = {}, body, payloadHash, fetchImpl = fetch, now }) {
  const target = urlForCfg(cfg, key);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) target.searchParams.set(k, String(v));
  const payload = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const hash = payloadHash || sha256Hex(payload);
  const signed = signRequest({
    method,
    url: target,
    headers,
    payloadHash: hash,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: 's3',
    now: now || new Date(),
  });
  const withBody = method !== 'GET' && method !== 'HEAD';
  const resp = await fetchImpl(target, {
    method,
    headers: signed.headers,
    body: withBody ? payload : undefined,
  });
  return { resp, url: target, signature: signed.signature, headers: signed.headers };
}

export async function putObject({ cfg, key, body, contentType, fetchImpl, now }) {
  const { resp, url } = await s3Fetch({
    cfg,
    method: 'PUT',
    key,
    headers: contentType ? { 'content-type': contentType } : {},
    body,
    fetchImpl,
    now,
  });
  if (!resp.ok) throw new Error(`上传失败 HTTP ${resp.status}：${url.pathname} ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  return { status: resp.status, etag: resp.headers.get('etag') || '', url: url.toString() };
}

export async function getObject({ cfg, key, fetchImpl, now }) {
  const { resp, url } = await s3Fetch({ cfg, method: 'GET', key, fetchImpl, now });
  if (resp.status === 404) return { status: 404, body: null, url: url.toString() };
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}：${url.pathname}`);
  return { status: resp.status, body: Buffer.from(await resp.arrayBuffer()), url: url.toString() };
}

/** ListObjectsV2：只取 `<Key>` 文本（不引 XML 解析库；分页用 ContinuationToken）。 */
export async function listPrefix({ cfg, prefix = '', maxKeys = 1000, fetchImpl, now }) {
  const { resp } = await s3Fetch({
    cfg,
    method: 'GET',
    key: '',
    query: { 'list-type': '2', prefix, 'max-keys': String(maxKeys) },
    fetchImpl,
    now,
  });
  if (!resp.ok) throw new Error(`列举失败 HTTP ${resp.status}`);
  const xml = await resp.text();
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1]);
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { keys, truncated, nextToken: token ? token[1] : null };
}

/** 小文件上传的便捷封装：自动 Content-Type + 大文件只告警（SigV4 单请求上限 5 GiB，够用）。 */
export async function putFile({ cfg, file, key, fetchImpl, now }) {
  const body = fs.readFileSync(file);
  if (body.length > 512 * 1024 * 1024) throw new Error(`文件太大（${body.length} B > 512 MiB），本实现不做分片上传`);
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.json' ? 'application/json' : ext === '.jsonl' ? 'application/x-ndjson' : ext === '.md' ? 'text/markdown' : 'application/octet-stream';
  return putObject({ cfg, key, body, contentType: type, fetchImpl, now });
}
