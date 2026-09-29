'use strict';
/**
 * server.js — 零依赖 Node 后端：静态托管 + Jev 代理 + 棋谱/实验本地持久化。
 *
 * 定位：functions/api/*.js（Cloudflare Pages Function）的本地等价物，
 * 让「重构成有后端的项目」在不引入任何第三方依赖的前提下跑起来：
 *   node server.js            → http://localhost:8788
 *   PORT=9000 node server.js  → 换端口
 *
 * 契约与 Pages Function 保持一致（前端无感切换）：
 *   GET  /api/health                     服务信息与棋谱计数
 *   POST /api/jev                        TypeSafe System One 代理（BYOK，key 不落盘）
 *   POST /api/games                      棋谱同步，落盘 games/<日期>/<gid>-<stamp>.json
 *   GET  /api/games?limit=               列出最近棋谱
 *   GET  /api/games/<day>/<name>.json    读取单份棋谱
 *   POST /api/experiments                实验归档（按 tag upsert）
 *   GET  /api/experiments                读取实验归档
 *   GET  /api/stats                      跨对局聚合（供校准实验室等服务端样本）
 *
 * 可测试性：createServer(opts) 返回未监听的 http.Server，
 * opts: { root, gamesDir, experimentsFile, fetchImpl, now }，
 * 测试里用 .listen(0) 拿真实端口打 HTTP，fetchImpl 可注入 stub。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- 常量 ---------- */
const VERSION = '1.0.0';
const SERVICE = 'jev-qiguan-server';
const UPSTREAM_URL = 'https://api.typesafe.ai/v1/systemone';
const UPSTREAM_TIMEOUT_MS = 30_000;
const RATE_WINDOW_MS = 60_000; // 滑动窗口：60 秒
const RATE_MAP_LIMIT = 10_000; // 限流表内存护栏：超限清空（与 functions/api/games.js 同模式）
const JEV_RATE_PER_MIN = 60; // POST /api/jev 每 IP 每分钟
const GAMES_RATE_PER_MIN = 120; // POST /api/games、GET /api/games 等每 IP 每分钟
const MAX_BODY_JE_V = 256 * 1024; // /api/jev 请求体上限
const MAX_BODY_GAMES = 2 * 1024 * 1024; // /api/games、/api/experiments 请求体上限
const BODY_HARD_CAP = 4; // 超过上限 4 倍直接掐断，防慢速客户端耗尽内存
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/; // 日期目录名
const NAME_RE = /^[A-Za-z0-9_.-]+\.json$/; // 棋谱文件名
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const STATS_SCAN = 400; // /api/stats 只扫最近 400 份棋谱

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/* ---------- 纯函数（导出供测试） ---------- */

/** 取客户端 IP：优先 X-Forwarded-For 首段（本地/反代后的常见形态），否则 socket 地址。 */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * 滑动窗口限流器工厂（同 functions/api/*.js 的做法）。
 * 每 IP 一个时间戳数组，只保留 60s 内的；超限即拦。Map 超 10000 条清空。
 * nowFn 可注入，便于测试操控时间。
 */
function createRateLimiter(nowFn) {
  const hits = new Map();
  return function rateLimited(ip, limit) {
    const now = nowFn();
    const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    const blocked = arr.length >= Math.max(1, limit);
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > RATE_MAP_LIMIT) hits.clear();
    return blocked;
  };
}

/** 模块级默认限流器（供直接调用 rateLimited 的使用方）。 */
const rateLimited = createRateLimiter(() => Date.now());

/**
 * 安全拼路径：segments 为已解码的路径段。
 * 任一段为空 / '.' / '..' / 以 '.' 开头（.git、.env、.work…）→ 返回 null；
 * resolve 后必须仍在 root 内，否则 null。
 */
function safeJoin(root, segments) {
  if (!Array.isArray(segments)) return null;
  const base = path.resolve(root);
  const parts = [];
  for (const seg of segments) {
    if (typeof seg !== 'string' || seg === '' || seg === '.' || seg === '..') return null;
    if (seg.charAt(0) === '.') return null; // 隐藏文件/目录一律拒服
    parts.push(seg);
  }
  const abs = path.resolve(base, parts.join(path.sep));
  if (abs !== base && abs.indexOf(base + path.sep) !== 0) return null;
  return abs;
}

/** gid 净化：只留 [a-zA-Z0-9_-]，截断 24 字符（与 functions/api/games.js 一致，保证两端文件名兼容）。 */
function sanitizeGid(gid) {
  const s = String(gid == null ? '' : gid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  return s || 'nogid';
}

/** 由 exported 推 (日期目录, 时间戳文件名片段)；解析失败回退当前时间。 */
function dayAndStamp(exported, nowFn) {
  const fallback = typeof nowFn === 'function' ? nowFn() : Date.now();
  let d;
  if (exported == null || exported === '') d = new Date(fallback);
  else d = new Date(exported);
  if (isNaN(d.getTime())) d = new Date(fallback);
  const iso = d.toISOString();
  return { day: iso.slice(0, 10), stamp: iso.slice(0, 19).replace(/[-:T]/g, '') };
}

/** 解析 limit 查询参数：1..500，默认 100。 */
function parseLimit(raw) {
  let n = parseInt(raw == null ? '' : String(raw), 10);
  if (!isFinite(n)) n = DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/**
 * 读请求体（utf8 文本），超出 limit → reject 一个 statusCode 413 的错误。
 * 超限后继续排空（不立刻 destroy），客户端才能收到 413；
 * 超过上限 4 倍才掐断，防慢速客户端耗尽内存。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0; // 丢弃，内存不随体积增长
        if (size > limit * BODY_HARD_CAP) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const e = new Error('请求体过大');
        e.statusCode = 413;
        reject(e);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
    req.on('aborted', () => {
      const e = new Error('请求被中断');
      e.statusCode = 400;
      reject(e);
    });
  });
}

/** 带状态码的错误：顶层统一转成 JSON 错误响应，保证进程不崩。 */
function httpError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  e.expose = message;
  return e;
}

/** 递归收集 dir 下 .json 文件（maxDepth 层目录），返回 { abs, dir, name, size, mtime }。 */
function walkJsonFiles(dir, maxDepth, out) {
  out = out || [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink()) {
      try { isDir = fs.statSync(abs).isDirectory(); } catch (_) { continue; }
    }
    if (isDir) {
      if (maxDepth > 0) walkJsonFiles(abs, maxDepth - 1, out);
    } else if (ent.name.slice(-5).toLowerCase() === '.json') {
      try {
        const st = fs.statSync(abs);
        out.push({ abs, dir, name: ent.name, size: st.size, mtime: st.mtimeMs });
      } catch (_) { /* 读取中途被删/无权限：跳过 */ }
    }
  }
  return out;
}

/* ---------- 服务器 ---------- */

function createServer(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || __dirname);
  const gamesDir = opts.gamesDir ? path.resolve(opts.gamesDir) : path.join(root, 'games');
  const experimentsFile = opts.experimentsFile
    ? path.resolve(opts.experimentsFile)
    : path.join(root, 'data', 'experiments.json');
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const isRateLimited = createRateLimiter(nowFn);
  const startedAt = nowFn();

  /* ---------- 响应辅助 ---------- */

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', // API 一律不缓存
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function sendRaw(res, status, text, contentType) {
    res.writeHead(status, {
      'Content-Type': contentType || 'application/json',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text || ''),
    });
    res.end(text || '');
  }

  function sendPlain(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  /** 读 JSON 请求体；非法 JSON → 422 invalid JSON body。 */
  function readJsonBody(req, limit) {
    return readBody(req, limit).then((text) => {
      let body;
      try { body = JSON.parse(text); } catch (_) {
        throw httpError(422, 'invalid JSON body');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw httpError(422, 'invalid JSON body'); // JSON 标量/数组当作非法请求体
      }
      return body;
    });
  }

  function readExperiments() {
    try {
      const arr = JSON.parse(fs.readFileSync(experimentsFile, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return []; // 文件不存在或损坏：不报错，按空处理
    }
  }

  /* ---------- API 处理器 ---------- */

  function handleHealth(req, res) {
    sendJson(res, 200, {
      ok: true,
      service: SERVICE,
      version: VERSION,
      storage: { games: 'games/', experiments: 'data/experiments.json' },
      games: walkJsonFiles(gamesDir, 3, []).length,
      experiments: readExperiments().length,
      uptime: Math.max(0, Math.round((nowFn() - startedAt) / 1000)),
    });
  }

  async function handleJev(req, res) {
    if (isRateLimited(clientIp(req), JEV_RATE_PER_MIN)) throw httpError(429, '请求过于频繁');
    /* BYOK：请求头优先，服务端环境变量仅作站长自用的可选兜底；key 不落盘、不记日志 */
    const key = String(req.headers['x-api-key'] || '').trim()
      || String(process.env.TYPESAFE_API_KEY || '').trim();
    if (!key) {
      throw httpError(401, '未提供 API Key：请求头 X-Api-Key 或服务端环境变量 TYPESAFE_API_KEY');
    }
    const body = await readJsonBody(req, MAX_BODY_JE_V);
    const payload = {
      state: body.state,
      model: body.model || 'jev-latest',
      questions: body.questions,
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    let up;
    try {
      up = await fetchImpl(UPSTREAM_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } catch (e) {
      const reason = (e && e.name === 'AbortError')
        ? '请求超时（' + UPSTREAM_TIMEOUT_MS / 1000 + 's）'
        : String((e && e.message) || e);
      throw httpError(502, '上游请求失败：' + reason);
    } finally {
      clearTimeout(timer);
    }
    const text = await up.text().catch(() => '');
    const ct = (up.headers && typeof up.headers.get === 'function' && up.headers.get('content-type'))
      || 'application/json';
    sendRaw(res, up.status, text, ct); // 上游状态码与响应体原样透传
  }

  async function handleGamesPost(req, res) {
    if (isRateLimited(clientIp(req), GAMES_RATE_PER_MIN)) throw httpError(429, '请求过于频繁');
    const body = await readJsonBody(req, MAX_BODY_GAMES);
    if (body.format !== 'jev-qiguan-game/v1' || !Array.isArray(body.moves) || body.moves.length === 0) {
      throw httpError(422, 'not a jev-qiguan-game/v1 payload');
    }
    const { day, stamp } = dayAndStamp(body.exported, nowFn);
    const gid = sanitizeGid(body.gid);
    const fileName = gid + '-' + stamp + '.json';
    const rel = 'games/' + day + '/' + fileName; // POSIX 分隔符：跨端文件名兼容
    const abs = path.join(gamesDir, day, fileName);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      /* flag 'wx'：仅当文件不存在才创建——天然幂等，并发重复提交也不会互相覆盖 */
      fs.writeFileSync(abs, JSON.stringify(body, null, 2), { flag: 'wx' });
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        return sendJson(res, 200, { ok: true, path: rel, dedup: true }); // 幂等：不重写
      }
      throw httpError(500, '棋谱写入失败：' + String((e && e.message) || e));
    }
    sendJson(res, 200, { ok: true, path: rel, dedup: false });
  }

  function handleGamesList(req, res, u) {
    if (isRateLimited(clientIp(req), GAMES_RATE_PER_MIN)) throw httpError(429, '请求过于频繁');
    const limit = parseLimit(u.searchParams.get('limit'));
    const out = [];
    for (const f of walkJsonFiles(gamesDir, 1, [])) {
      const day = path.basename(f.dir);
      if (!DAY_RE.test(day)) continue; // 只收 games/<日期>/ 下的文件
      out.push({
        day,
        name: f.name,
        path: 'games/' + day + '/' + f.name,
        size: f.size,
        mtime: Math.round(f.mtime),
      });
    }
    out.sort((a, b) => (a.day + a.name < b.day + b.name ? 1 : -1)); // day+name 倒序
    sendJson(res, 200, { games: out.slice(0, limit) });
  }

  function handleGameGet(res, day, name) {
    if (!DAY_RE.test(day) || !NAME_RE.test(name)) throw httpError(400, '非法棋谱路径');
    const abs = path.join(gamesDir, day, name);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { throw httpError(404, '棋谱不存在'); }
    sendRaw(res, 200, text, 'application/json; charset=utf-8');
  }

  async function handleExperimentsPost(req, res) {
    if (isRateLimited(clientIp(req), GAMES_RATE_PER_MIN)) throw httpError(429, '请求过于频繁');
    const body = await readJsonBody(req, MAX_BODY_GAMES);
    if (typeof body.tag !== 'string' || !body.tag.trim() || !Array.isArray(body.games)) {
      throw httpError(422, '实验数据不完整：tag 必须是非空字符串，games 必须为数组');
    }
    const entry = {
      tag: body.tag,
      date: typeof body.date === 'string' && body.date ? body.date : new Date(nowFn()).toISOString(),
      chanA: body.chanA,
      chanB: body.chanB,
      total: body.total,
      games: body.games,
      note: typeof body.note === 'string' ? body.note : '',
    };
    const list = readExperiments().filter((e) => !e || e.tag !== entry.tag); // 同 tag upsert
    list.push(entry);
    list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))); // date 倒序
    try {
      fs.mkdirSync(path.dirname(experimentsFile), { recursive: true });
      fs.writeFileSync(experimentsFile, JSON.stringify(list, null, 2));
    } catch (e) {
      throw httpError(500, '实验归档写入失败：' + String((e && e.message) || e));
    }
    sendJson(res, 200, { ok: true, experiments: list });
  }

  function handleExperimentsGet(req, res) {
    if (isRateLimited(clientIp(req), GAMES_RATE_PER_MIN)) throw httpError(429, '请求过于频繁');
    sendJson(res, 200, { experiments: readExperiments() });
  }

  function handleStats(req, res) {
    if (isRateLimited(clientIp(req), GAMES_RATE_PER_MIN)) throw httpError(429, '请求过于频繁');
    const files = walkJsonFiles(gamesDir, 3, [])
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, STATS_SCAN);
    const byGame = {};
    const results = { black: 0, white: 0, draw: 0 };
    const calRecords = [];
    let totalGames = 0;
    for (const f of files) {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(f.abs, 'utf8')); } catch (_) { continue; } // 单份坏文件跳过
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
      totalGames++;
      const g = typeof rec.game === 'string' && rec.game ? rec.game : 'unknown';
      byGame[g] = (byGame[g] || 0) + 1;
      if (typeof rec.result === 'string') {
        if (rec.result.indexOf('黑方') >= 0) results.black++;
        else if (rec.result.indexOf('白方') >= 0) results.white++;
        else if (rec.result.indexOf('和棋') >= 0) results.draw++;
      }
      /* 校准样本只收真实渠道（mock 的概率是合成的）与有二元真值的对局（和棋 firstWin 为 null）。
       * records 按局给出，key = gid|notation，供前端与本机记录合并去重。 */
      if (rec.mock !== true && Array.isArray(rec.cal)
        && (rec.firstWin === true || rec.firstWin === false)) {
        /* key 与本机战绩簿同构：gid + 着法串（前端本机记录是 gid + notas 数组），
         * 因此这里用原始 gid，不做文件名式的清洗，保证两端 key 能对上。 */
        calRecords.push({
          key: String(rec.gid == null ? '' : rec.gid) + '|'
            + (typeof rec.notation === 'string' ? rec.notation : ''),
          firstWin: rec.firstWin,
          cal: rec.cal,
        });
      }
    }
    sendJson(res, 200, {
      ok: true,
      totalGames,
      byGame,
      results,
      experiments: readExperiments().length,
      cal: { games: calRecords.length, records: calRecords },
    });
  }

  /* ---------- 静态托管 ---------- */

  function serveStatic(res, segments) {
    const parts = segments.filter((s) => s !== '');
    if (parts.length === 0) parts.push('index.html'); // / → index.html
    const abs = safeJoin(root, parts);
    if (!abs) return sendPlain(res, 403, '403 forbidden'); // 越界或隐藏路径
    let st;
    try { st = fs.statSync(abs); } catch (_) { return sendPlain(res, 404, '404 not found'); }
    if (!st.isFile()) return sendPlain(res, 404, '404 not found');
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
    const stream = fs.createReadStream(abs);
    stream.on('error', () => { try { res.destroy(); } catch (_) { /* 连接已断 */ } });
    stream.pipe(res);
  }

  /* ---------- 路由 ---------- */

  function routeApi(req, res, parts, u) {
    const method = req.method || 'GET';
    if (parts.length === 1) {
      if (parts[0] === 'health') {
        if (method !== 'GET') return methodNotAllowed(res);
        return handleHealth(req, res);
      }
      if (parts[0] === 'jev') {
        if (method !== 'POST') return methodNotAllowed(res);
        return handleJev(req, res);
      }
      if (parts[0] === 'games') {
        if (method === 'GET') return handleGamesList(req, res, u);
        if (method === 'POST') return handleGamesPost(req, res);
        return methodNotAllowed(res);
      }
      if (parts[0] === 'experiments') {
        if (method === 'GET') return handleExperimentsGet(req, res);
        if (method === 'POST') return handleExperimentsPost(req, res);
        return methodNotAllowed(res);
      }
      if (parts[0] === 'stats') {
        if (method !== 'GET') return methodNotAllowed(res);
        return handleStats(req, res);
      }
    } else if (parts.length === 3 && parts[0] === 'games' && method === 'GET') {
      return handleGameGet(res, parts[1], parts[2]);
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  function methodNotAllowed(res) {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  async function route(req, res) {
    let u;
    try { u = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost')); }
    catch (_) { return sendJson(res, 400, { error: '非法请求路径' }); }
    /* 先按 / 切段再逐段解码：%2F 不会伪装成路径分隔符，%2e%2e 也不会被 URL 规范化吞掉 */
    const raw = u.pathname.split('/');
    const segs = raw.map((s) => {
      try { return decodeURIComponent(s); } catch (_) { return null; }
    });
    if (segs.indexOf(null) >= 0) return sendJson(res, 400, { error: '非法 URL 编码' });
    const parts = segs.filter((s) => s !== '');
    if (parts[0] === 'api') return routeApi(req, res, parts.slice(1), u);
    return serveStatic(res, parts);
  }

  async function onRequest(req, res) {
    try {
      await route(req, res);
    } catch (e) {
      /* 兜底：任何处理异常都转成 JSON 错误响应，绝不让进程崩掉 */
      if (res.headersSent) {
        try { res.end(); } catch (_) { /* 连接已断 */ }
        return;
      }
      const status = e && e.statusCode ? e.statusCode : 500;
      /* 带 statusCode 的错误都是有意抛出的（限流/413/422…），文案可直接暴露 */
      const msg = e && e.expose ? e.expose
        : (e && e.statusCode ? String(e.message)
          : ('服务器内部错误：' + String((e && e.message) || e)));
      sendJson(res, status, { error: msg });
    }
  }

  return http.createServer(onRequest);
}

/* ---------- 启动 ---------- */

function start() {
  const port = Number(process.env.PORT) || 8788;
  const server = createServer({ root: __dirname });
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('端口 ' + port + ' 已被占用：换一个端口再试，例如 PORT=8790 node server.js');
    } else {
      console.error('服务器错误：' + String((e && e.message) || e));
    }
    process.exit(1);
  });
  server.listen(port, () => {
    const gamesDir = path.join(__dirname, 'games');
    const experimentsFile = path.join(__dirname, 'data', 'experiments.json');
    console.log([
      '======================================================',
      '  Jev 棋馆 · 本地后端  v' + VERSION,
      '  地址       http://localhost:' + port,
      '  静态根     ' + __dirname,
      '  棋谱目录   ' + gamesDir + path.sep + '   （POST /api/games 落盘处）',
      '  实验归档   ' + experimentsFile,
      '  Jev 渠道   POST /api/jev → ' + UPSTREAM_URL,
      '             key 优先级：请求头 X-Api-Key（BYOK，推荐）> 环境变量 TYPESAFE_API_KEY',
      '  API        GET  /api/health | GET /api/stats',
      '             POST /api/jev',
      '             POST /api/games | GET /api/games?limit=',
      '             GET  /api/games/<day>/<name>.json',
      '             POST /api/experiments | GET /api/experiments',
      '  停止       Ctrl+C',
      '======================================================',
    ].join('\n'));
  });
  return server;
}

if (require.main === module) start();

module.exports = {
  createServer,
  start,
  MIME,
  safeJoin,
  rateLimited,
  createRateLimiter,
  sanitizeGid,
  dayAndStamp,
  parseLimit,
  clientIp,
  readBody,
  walkJsonFiles,
  VERSION,
  SERVICE,
  UPSTREAM_URL,
};
