/* functions/api/health.js — GET /api/health：前端探活（server.js 的 Pages 等价物）。
 *
 * 刻意不发任何上游请求：探活要便宜、要快，不能每次开页都烧 GitHub API 配额。
 * 棋谱/实验计数由 /api/stats 提供（它自己也有 40 份的扫描上限）。
 * github 字段告诉前端「token 配没配」——没配时同步/归档实际不可用，
 * 前端据此把提示从「已落盘」改成「未配置」，不误导。 */
import { json } from './_github.js';

export async function onRequestGet(context) {
  const env = (context && context.env) || {};
  return json({
    ok: true,
    service: 'jev-qiguan-pages',
    version: '1.0.0',
    storage: {
      games: 'games/（GitHub 仓库，终局同步 commit）',
      experiments: 'data/experiments.json（GitHub 仓库）',
    },
    github: !!env.GAMES_GITHUB_TOKEN,
    uptime: null, // Pages 无长驻进程，uptime 无意义；字段保留是为与 server.js 同形
  });
}
