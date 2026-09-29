/* functions/api/_github.js — Pages Functions 共享的 GitHub API 客户端（BYOK）。
 *
 * token 只从 Pages 项目环境变量 GAMES_GITHUB_TOKEN 取（fine-grained PAT，
 * tripodxu/board-games 的 Contents 读写），永不进请求、永不记日志。
 *
 * 命名约定：下划线前缀的文件不对应任何真实端点——Pages 按 functions/ 下的路径
 * 路由，_github 不是对外 API；即便被直接请求，它也导不出任何 onRequest* 处理器，
 * 行为为 inert。相对 import 在 Pages 的打包（Wrangler）里是标准 ESM 行为。
 */
const REPO = 'tripodxu/board-games';
const BRANCH = 'main';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/** 滑动窗口限流（同 functions/api/games.js 的做法）：每 IP 每分钟，Map 超 1 万条清空。 */
const hits = new Map();
function rateLimited(ip, limit) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  const blocked = arr.length >= limit;
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 10_000) hits.clear();
  return blocked;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(String(b64 || '').replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** GitHub REST 调用；非 2xx 抛错（message 带状态码，由调用方转成对客文案）。 */
async function gh(token, apiPath, method = 'GET', body) {
  const r = await fetch('https://api.github.com' + apiPath, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'jev-qiguan-pages-functions',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error('GitHub API ' + r.status + ': ' + (data.message || 'unknown'));
    e.status = r.status;
    throw e;
  }
  return data;
}

export { REPO, BRANCH, json, rateLimited, b64encode, b64decode, gh };
