// CF Pages Function：POST /api/games → 收棋谱并 commit 到仓库 games/ 目录。
// 需要在 Cloudflare Pages 项目设置里加环境变量 GAMES_GITHUB_TOKEN
//（PAT，fine-grained 给 tripodxu/board-games 的 Contents 读写即可）。
// GET /api/games → 列出最近棋谱（供外部拉取）。
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const REPO = 'tripodxu/board-games';
const BRANCH = 'main';

/** 滑动窗口限流（同 jev.js 的做法） */
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

async function gh(token, path, method = 'GET', body) {
  const r = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'jev-qiguan-games-sync',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('GitHub API ' + r.status + ': ' + (data.message || 'unknown'));
  return data;
}

export async function onRequestPost(context) {
  const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (rateLimited(ip, 20)) return json({ error: '请求过于频繁' }, 429);
  const token = context.env.GAMES_GITHUB_TOKEN || '';
  if (!token) return json({ error: '服务端未配置 GAMES_GITHUB_TOKEN' }, 500);

  let body;
  try { body = await context.request.json(); }
  catch (_) { return json({ error: 'invalid JSON body' }, 422); }
  if (!body || body.format !== 'jev-qiguan-game/v1' || !Array.isArray(body.moves)) {
    return json({ error: 'not a jev-qiguan-game/v1 payload' }, 422);
  }
  // 文件名：games/2026-09-29/<gid>-<exported>.json，防重名加随机后缀
  const d = new Date(body.exported || Date.now());
  const ymd = d.toISOString().slice(0, 10);
  const stamp = d.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const gid = String(body.gid || 'nogid').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  const path = `games/${ymd}/${gid}-${stamp}.json`;
  const content = b64encode(JSON.stringify(body, null, 2));

  try {
    await gh(token, `/repos/${REPO}/contents/${path}`, 'PUT', {
      message: `game: ${body.game || '?'} ${gid} ${body.result || ''}`.slice(0, 120),
      content,
      branch: BRANCH,
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
  return json({ ok: true, path });
}

export async function onRequestGet(context) {
  const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (rateLimited(ip, 30)) return json({ error: '请求过于频繁' }, 429);
  const token = context.env.GAMES_GITHUB_TOKEN || '';
  if (!token) return json({ error: '服务端未配置 GAMES_GITHUB_TOKEN' }, 500);
  // 列出 games/ 下最近 7 天的目录，汇总文件列表
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push(d);
  }
  const out = [];
  for (const day of days) {
    try {
      const items = await gh(token, `/repos/${REPO}/contents/games/${day}?ref=${BRANCH}`);
      if (Array.isArray(items)) {
        for (const it of items) {
          if (it.type === 'file' && it.name.endsWith('.json')) {
            out.push({ day, name: it.name, path: it.path, sha: it.sha, size: it.size });
          }
        }
      }
    } catch (_) { /* 当天无目录则跳过 */ }
  }
  out.sort((a, b) => (a.day + a.name < b.day + b.name ? 1 : -1));
  return json({ games: out.slice(0, 100) });
}
