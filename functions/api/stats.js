/* functions/api/stats.js — 跨对局聚合（server.js 的 Pages 等价物）。
 *
 * GET /api/stats → { ok, totalGames, byGame, results, experiments, truncated, cal }
 *
 * 数据来源全是「已经在仓库里的东西」，不引任何存储绑定：
 *   1. git trees API（1 次调用）列出 games/ 下全部棋谱路径；
 *   2. raw.githubusercontent.com 逐份拉取（CDN，不计 API 配额）；
 *   3. contents API 读 data/experiments.json 拿实验轮数。
 * 聚合口径与 server.js handleStats 逐字一致（byGame / results / cal.records），
 * 这样本地与线上的校准样本能按同一套 key 合并去重。
 *
 * 子请求预算：Workers 免费版单次调用 50 个子请求，这里 1 + ≤40 + 1 = 42，留余量。
 * 因此线上只聚合最近 40 份（本地 server.js 是 400 份），截断时 truncated: true，
 * 前端显示「40+ 份」而不是冒充全量。 */
import { json, rateLimited, gh, b64decode, REPO, BRANCH } from './_github.js';

const RAW = 'https://raw.githubusercontent.com';
const MAX_FILES = 40;
const RATE = 30; // 聚合不便宜：限严一点
const GAME_PATH_RE = /^games\/\d{4}-\d{2}-\d{2}\/[^/]+\.json$/;

function clientIp(context) {
  return context.request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

export async function onRequestGet(context) {
  const ip = clientIp(context);
  if (rateLimited(ip, RATE)) return json({ error: '请求过于频繁' }, 429);
  const token = context.env.GAMES_GITHUB_TOKEN || '';
  if (!token) return json({ error: '服务端未配置 GAMES_GITHUB_TOKEN' }, 500);

  let tree;
  try {
    tree = await gh(token, `/repos/${REPO}/git/trees/${BRANCH}?recursive=1`);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
  const paths = (tree.tree || [])
    .filter((t) => t && t.type === 'blob' && GAME_PATH_RE.test(t.path || ''))
    .map((t) => t.path)
    .sort()
    .reverse() // 文件名带时间戳，字典序倒序 = 最新在前
    .slice(0, MAX_FILES);

  const files = await Promise.all(paths.map(async (p) => {
    try {
      const r = await fetch(`${RAW}/${REPO}/${BRANCH}/${p.split('/').map(encodeURIComponent).join('/')}`);
      if (!r.ok) return null;
      const rec = await r.json();
      return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null;
    } catch (_) {
      return null; // 单份坏文件跳过，不拖垮整次聚合
    }
  }));

  const byGame = {};
  const results = { black: 0, white: 0, draw: 0 };
  const calRecords = [];
  let totalGames = 0;
  for (const rec of files) {
    if (!rec) continue;
    totalGames++;
    const g = typeof rec.game === 'string' && rec.game ? rec.game : 'unknown';
    byGame[g] = (byGame[g] || 0) + 1;
    if (typeof rec.result === 'string') {
      if (rec.result.indexOf('黑方') >= 0) results.black++;
      else if (rec.result.indexOf('白方') >= 0) results.white++;
      else if (rec.result.indexOf('和棋') >= 0) results.draw++;
    }
    /* 校准样本口径与 server.js / 本机战绩簿三方一致：排除 mock（合成概率），
     * 只收有二元真值的局（和棋 firstWin 为 null）。key = gid|着法串供前端去重。 */
    if (rec.mock !== true && Array.isArray(rec.cal)
      && (rec.firstWin === true || rec.firstWin === false)) {
      calRecords.push({
        key: String(rec.gid == null ? '' : rec.gid) + '|'
          + (typeof rec.notation === 'string' ? rec.notation : ''),
        firstWin: rec.firstWin,
        cal: rec.cal,
      });
    }
  }

  let experiments = 0;
  try {
    const r = await gh(token, `/repos/${REPO}/contents/data/experiments.json?ref=${BRANCH}`);
    const list = JSON.parse(b64decode(r.content));
    if (Array.isArray(list)) experiments = list.length;
  } catch (_) { /* 没有归档文件就是 0 轮，不报错 */ }

  return json({
    ok: true,
    totalGames,
    truncated: paths.length >= MAX_FILES,
    byGame,
    results,
    experiments,
    cal: { games: calRecords.length, records: calRecords },
  });
}
