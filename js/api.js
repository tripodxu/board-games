/* js/api.js — 后端 API 客户端（零依赖，浏览器与 Node 均可加载）
 *
 * 对接两个同源后端（URL 完全一致，行为由部署形态决定）：
 *   - server.js（自托管 Node 后端）：棋谱落盘 games/、实验归档 data/experiments.json、
 *     /api/stats 跨对局聚合；
 *   - CF Pages Functions（线上部署）：/api/games 走 GitHub API commit 进仓库。
 * 静态托管（file:// 双击打开、或无 functions/ 的纯静态站点）下所有请求自然失败，
 * 本模块一律返回 null 不抛异常，调用方据此降级——对局与记录功能不受任何影响。 */
(function () {
  var TIMEOUT_MS = 8000;

  /* file:// 下 fetch('/api/...') 直接 reject——这是静态模式的正常形态，不是错误 */
  async function call(path, opts) {
    if (typeof fetch !== 'function') return null;
    try {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
      var r = await fetch(path, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : null));
      if (timer) clearTimeout(timer);
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    }
  }

  function post(path, body) {
    return call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  BG.api = {
    /* 后端探活：返回 health 对象或 null（无后端） */
    health: () => call('/api/health'),

    /* 棋谱同步：payload 为 buildGameExport() 产出（jev-qiguan-game/v1） */
    saveGame: (payload) => post('/api/games', payload),
    listGames: (limit) => call('/api/games?limit=' + (limit || 100)),
    /* 入参兼容两种形态：列表返回的 path（games/<日>/<名>.json）或 <日>/<名>.json。
     * 前端从列表拿到的就是带 games/ 前缀的 path，这里统一剥掉，少一个调用方踩坑的点。 */
    getGame: (relPath) => call('/api/games/' + String(relPath || '').replace(/^games\//, '')),
    /* 同一份路径的可读 URL：归档面板直接给 <a href>，不抓内容也能打开棋谱 */
    gameUrl: (relPath) => '/api/games/' + String(relPath || '').replace(/^games\//, ''),

    /* 实验归档：entry 为 { tag, date, chanA, chanB, total, games, note } */
    saveExperiment: (entry) => post('/api/experiments', entry),
    listExperiments: () => call('/api/experiments'),

    /* 跨对局聚合（校准实验室的服务端样本来源） */
    stats: () => call('/api/stats'),
  };
})();
