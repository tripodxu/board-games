/* functions/api/experiments.js — 实验战报归档（server.js 的 Pages 等价物）。
 *
 * GET  /api/experiments → { experiments: [...] }   读仓库 data/experiments.json
 * POST /api/experiments → { ok, experiments: [...] } 按 tag upsert 后写回仓库
 *
 * 持久化选型：直接 commit 进仓库（复用 games.js 的 GitHub 写路径），不引 KV/D1——
 * 数据天然版本化、可复盘、零新增绑定；提交信息带 [skip ci] 不触发 Pages 构建。
 * 与本地 server.js 的差异只在存储位置，JSON 形状完全一致（前端双端合并无感）。 */
import { json, rateLimited, gh, b64encode, b64decode, REPO, BRANCH } from './_github.js';

const FILE = 'data/experiments.json';
const RATE = 60; // 每 IP 每分钟：读多写少，60 足够正常使用

function clientIp(context) {
  return context.request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** 读归档文件：返回 { list, sha }；文件不存在视为空归档（sha 为 null，PUT 即新建）。 */
async function readArchive(token) {
  try {
    const r = await gh(token, `/repos/${REPO}/contents/${FILE}?ref=${BRANCH}`);
    const list = JSON.parse(b64decode(r.content));
    return { list: Array.isArray(list) ? list : [], sha: r.sha };
  } catch (e) {
    if (e && e.status === 404) return { list: [], sha: null };
    throw e;
  }
}

export async function onRequestGet(context) {
  const ip = clientIp(context);
  if (rateLimited(ip, RATE)) return json({ error: '请求过于频繁' }, 429);
  const token = context.env.GAMES_GITHUB_TOKEN || '';
  if (!token) return json({ experiments: [], reason: '服务端未配置 GAMES_GITHUB_TOKEN' });
  try {
    const { list } = await readArchive(token);
    return json({ experiments: list });
  } catch (e) {
    /* 读失败不当成错误抛给前端：本地归档仍然可用，静默降级 */
    return json({ experiments: [], reason: String(e.message || e) });
  }
}

export async function onRequestPost(context) {
  const ip = clientIp(context);
  if (rateLimited(ip, RATE)) return json({ error: '请求过于频繁' }, 429);
  const token = context.env.GAMES_GITHUB_TOKEN || '';
  if (!token) return json({ error: '服务端未配置 GAMES_GITHUB_TOKEN' }, 500);

  let body;
  try { body = await context.request.json(); }
  catch (_) { return json({ error: 'invalid JSON body' }, 422); }
  if (!body || typeof body.tag !== 'string' || !body.tag.trim() || !Array.isArray(body.games)) {
    return json({ error: '实验数据不完整：tag 必须是非空字符串，games 必须为数组' }, 422);
  }

  const entry = {
    tag: body.tag,
    date: typeof body.date === 'string' && body.date ? body.date : new Date().toISOString(),
    chanA: body.chanA,
    chanB: body.chanB,
    total: body.total,
    games: body.games,
    note: typeof body.note === 'string' ? body.note : '',
  };

  try {
    const cur = await readArchive(token);
    const list = cur.list.filter((e) => !e || e.tag !== entry.tag); // 同 tag upsert
    list.push(entry);
    list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))); // date 倒序
    await gh(token, `/repos/${REPO}/contents/${FILE}`, 'PUT', {
      // [skip ci]：实验数据提交不触发 Pages 重新构建（同棋谱同步的理由）
      message: (`exp: ${entry.tag} [skip ci]`).slice(0, 140),
      content: b64encode(JSON.stringify(list, null, 2)),
      branch: BRANCH,
      sha: cur.sha || undefined, // 新建文件时不能带 sha
    });
    return json({ ok: true, experiments: list });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}
