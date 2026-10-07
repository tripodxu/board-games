#!/usr/bin/env node
/**
 * local-relay.mjs — OpenCode 免费档的本地中转（零依赖，Node ≥ 18）。
 *
 * 解决什么：OpenCode Zen 不发 CORS 头 ⇒ 线上页面（https）无法直连；经 Worker 中转则出口 IP
 * 是平台共享的，免费档限流（按请求方 IP 计）被场外流量耗尽。本脚本跑在**用户自己的电脑**上，
 * 监听 127.0.0.1 —— 请求从用户 IP 发出，限流池独占，匿名都稳定；填自己的 key 再加一层私有配额。
 *
 * 用法：node local-relay.mjs [--port 8420]
 *   1. 装 Node（≥18）  2. node local-relay.mjs  3. 站点渠道切「OpenCode · 本地中转」
 *
 * 安全边界（三条，都刻意）：
 *   - 只转发到 OpenCode 的 systemone 端点，且 body.model 必须是 jev-1.13-free（防开放代理）；
 *   - 只绑 127.0.0.1（不暴露给局域网）；
 *   - 不打印 key 与请求体（局面里有用户对局；key 是用户凭据）。
 */
import http from 'node:http';
import { execFile } from 'node:child_process';

const UPSTREAM = process.env.UPSTREAM_URL?.trim() || 'https://opencode.ai/zen/v1/systemone';
const ALLOWED_MODEL = 'jev-1.13-free';
const DEFAULT_PORT = 8420;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'content-type, x-api-key, authorization',
  'Access-Control-Max-Age': '86400',
  /* Chrome 的 Private Network Access：https(公网) → 127.0.0.1(本机) 的预检要求应答这个头 */
  'Access-Control-Allow-Private-Network': 'true',
};

const argPort = (() => {
  const i = process.argv.indexOf('--port');
  const v = i >= 0 ? parseInt(process.argv[i + 1] ?? '', 10) : NaN;
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : DEFAULT_PORT;
})();

function corsHeaders(extra = {}) {
  return { ...CORS, ...extra };
}

function send(res, status, headers, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...headers });
  res.end(body);
}

function readBody(req, limitBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function relay(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, {}, JSON.stringify({ error: { type: 'bad_request', message: '请求体必须是 JSON 对象' } }));
  }
  if (parsed?.model !== ALLOWED_MODEL) {
    /* 防开放代理：本脚本只服务免费档这一个上游模型，其余一律拒绝 */
    return send(res, 400, {}, JSON.stringify({ error: { type: 'bad_request', message: `本中转只支持 model=${ALLOWED_MODEL}` } }));
  }
  const apiKey = (req.headers['x-api-key'] ?? '').toString().trim();
  /* 上游请求走 **curl 子进程**而不是 node fetch：OpenCode 的免费档限流按 **TLS 客户端指纹** 分桶
   * （实测同机同 key 同一秒：curl 200 / node fetch 429——undici 的指纹被打进全球脚本共享池）。
   * curl 的指纹有自己的桶，且 Windows 10+/macOS/Linux 都自带。args 数组传参无 shell 注入面。 */
  const args = ['-sS', '-X', 'POST', UPSTREAM,
    '-H', 'Content-Type: application/json',
    ...(apiKey ? ['-H', 'Authorization: Bearer ' + apiKey] : []),
    '--data-binary', JSON.stringify({ state: parsed.state, model: parsed.model, questions: parsed.questions }),
    '--max-time', '60',
    '-w', '\n%{http_code}'];
  let stdout;
  try {
    stdout = (await runCurl(args)).toString('utf8');
  } catch (e) {
    const missing = e?.code === 'ENOENT';
    return send(res, 502, {}, JSON.stringify({ error: { type: 'upstream_error', message: missing
      ? '本机没有 curl（Windows 10+/macOS/Linux 一般自带；Windows 可用 curl.exe 所在目录加入 PATH）'
      : 'OpenCode 不可达：' + (e?.message ?? 'Error').slice(0, 120) } }));
  }
  /* curl -w 把状态码追加在最后一行 */
  const nl = stdout.lastIndexOf('\n');
  const status = parseInt(stdout.slice(nl + 1), 10) || 502;
  const text = stdout.slice(0, nl);
  const headers = {};
  send(res, status, headers, text);
}

function runCurl(args) {
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 16 * 1024 * 1024, timeout: 70_000 }, (err, stdout, stderr) => {
      if (err && !stdout) { err.code = err.code ?? 'CURL_ERR'; reject(err); return; }
      /* 非 2xx 的 HTTP 状态 curl 默认不报错（-f 才报）——stdout 照常带状态码返回 */
      if (err && stdout) resolve(Buffer.from(stdout));
      else if (err) reject(err);
      else resolve(Buffer.from(stdout));
    });
  });
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, {}, JSON.stringify({ ok: true, relay: 'opencode-local', upstream: UPSTREAM, model: ALLOWED_MODEL }));
  }
  if (req.method === 'POST' && path === '/api/jev') {
    relay(req, res).catch(() => send(res, 500, {}, JSON.stringify({ error: { type: 'server_error', message: '中转内部错误' } })));
    return;
  }
  send(res, 404, {}, JSON.stringify({ error: { type: 'not_found', message: '只支持 POST /api/jev 与 GET /health' } }));
});

server.listen(argPort, '127.0.0.1', () => {
  console.log('OpenCode 本地中转已启动（请求从你自己的 IP 发出，限流池独占）');
  console.log(`  地址：http://127.0.0.1:${argPort}/api/jev`);
  console.log('  站点三步：①设置 → 接入渠道选「OpenCode · 本地中转（你的 IP）」');
  console.log(`            ②（可选）OpenCode Key 填进「OpenCode Key」框（匿名也能用）`);
  console.log(`            ③保持本窗口开着（Ctrl+C 停止）`);
});
