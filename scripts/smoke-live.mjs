/**
 * 线上冒烟（`npm run smoke:live`）：对已部署的 Worker 跑一遍真实 HTTP 契约。
 * 默认打自定义域 `https://jevqipan.logicc.top`（本机网络连不上 `*.workers.dev`），
 * 也可 `node scripts/smoke-live.mjs <url>` 打本地 `npm run dev`（http://localhost:8787）。
 *
 * 两条「不写持久数据」的路：POST 一份**已归档**的 payload（应 dedup=true、写 0 手）；
 * 唯一会新建行的是「新房 payload」，用 `X-Device-Id = smoke-<时间戳>`，脚本退出时
 * 会打印清理 SQL —— 跑完请照着执行一次，把脚本自己写的那几行删掉（数据总量会随真实验增长，
 * 因此断言一律相对基线，不写死 54 局 / 6 轮）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'https://jevqipan.logicc.top';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEVICE = `smoke-${Date.now().toString(36)}`;

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function req(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, text };
}

/** 取一份真实归档（含 ai 元数据的那种），用于幂等重传。 */
function firstArchive() {
  const day = readdirSync(join(ROOT, 'games')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()[0];
  const file = readdirSync(join(ROOT, 'games', day)).find((f) => f.endsWith('.json'));
  return JSON.parse(readFileSync(join(ROOT, 'games', day, file), 'utf8'));
}

console.log(`\n== 线上冒烟 ${BASE}（device=${DEVICE}）==\n`);

/* ---------- 1. 读接口 ---------- */
const health = await req('/api/health');
check('GET /api/health 200', health.status === 200, `d1=${health.body?.d1} schema=${health.body?.schema}`);
/* R2 护栏：today 必须存在且结构与口径可信（rows = 当日归档局的 1 + 手数） */
const today = health.body?.today;
check(
  'GET /api/health 带 today 写入护栏',
  !!today && typeof today.games === 'number' && today.rows === today.games + today.moves && today.rowBudget > 0,
  today ? `${today.day} games=${today.games} moves=${today.moves} rows=${today.rows}/${today.rowBudget}` : '缺少 today',
);

const list = await req('/api/games?limit=3');
const item = list.body?.games?.[0];
check('GET /api/games 返回条目', list.status === 200 && !!item, `total=${list.body?.games?.length}`);
check('列表条目不含 payload', item && !('payload' in item));
check('列表条目有 gameUid/day/name', !!item?.gameUid && !!item?.day && !!item?.name, item?.name ?? '');

const byUid = await req(`/api/games/u/${item.gameUid}`);
check('GET /api/games/u/:uid 200', byUid.status === 200);
check('详情与列表同一局', byUid.body?.notation === item.notation, `moves=${byUid.body?.moves?.length}`);
check('详情响应头带 X-Game-Uid', byUid.headers.get('x-game-uid') === item.gameUid);

const legacy = await req(`/api/games/${item.day}/${item.name}`);
check('旧路径 /api/games/:day/:name 200', legacy.status === 200, legacy.status === 200 ? '' : String(legacy.body));
const legacyNoJson = await req(`/api/games/${item.day}/${item.name.replace(/\.json$/, '')}`);
check('旧路径不带 .json 也 200', legacyNoJson.status === 200);

const stats = await req('/api/stats');
check('GET /api/stats 200 且无 truncated 字段', stats.status === 200 && !('truncated' in (stats.body ?? {})), `totalGames=${stats.body?.totalGames}`);
/* byGame 只断言「键是中文棋种名」+「五子棋在册」，不锁死数字：D1 是活的，真实验会往上加。 */
const byGame = stats.body?.byGame ?? {};
const CHINESE_NAMES = ['五子棋', '五子棋·禁手', '围棋', '象棋', '国际象棋', '西洋跳棋', '中国跳棋'];
const badName = Object.keys(byGame).find((k) => !CHINESE_NAMES.includes(k));
check(
  'stats.byGame 用中文名（键合法且五子棋在册）',
  stats.status === 200 && !badName && (byGame['五子棋'] ?? 0) >= 1,
  `${JSON.stringify(byGame)}${badName ? `（非法键：${badName}）` : ''}`,
);
/* 基线：后面的写断言一律算「基线 + 1」，避免每加一批真实数据就把冒烟跑红。 */
const baseGames = stats.body?.totalGames ?? 0;

const exp = await req('/api/experiments');
const rounds = exp.body?.experiments?.length ?? 0;
check(
  'GET /api/experiments 200（轮次 ≥ 6 且每轮有 tag）',
  exp.status === 200 && rounds >= 6 && (exp.body?.experiments ?? []).every((e) => !!e?.tag),
  `${rounds} 轮`,
);

const openings = await req('/api/openings?game=gomoku&limit=5');
check('GET /api/openings 200', openings.status === 200, `status=${openings.status} body=${JSON.stringify(openings.body).slice(0, 120)}`);
const openingsNoGame = await req('/api/openings');
check('GET /api/openings 缺 game → 400', openingsNoGame.status === 400, `status=${openingsNoGame.status}`);
const board = await req('/api/leaderboard');
check('GET /api/leaderboard 200', board.status === 200);

const exportRes = await fetch(`${BASE}/api/export/games?limit=2`);
const jsonl = await exportRes.text();
const firstLine = jsonl.split('\n').find((l) => l.trim());
check('GET /api/export/games JSONL', exportRes.status === 200 && !!firstLine && typeof JSON.parse(firstLine) === 'object');

/* ---------- 2. 拒绝分支 ---------- */
const jev = await req('/api/jev', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel: 'proxy', messages: [] }),
});
check('POST /api/jev 无 key → 401 unauthorized', jev.status === 401 && jev.body?.code === 'unauthorized', `status=${jev.status} code=${jev.body?.code}`);

const meNoHeader = await req('/api/games?device=me');
check('GET /api/games?device=me 缺头 → 400', meNoHeader.status === 400);

const badDay = await req('/api/games?since=2026-02-30');
check('GET /api/games?since=2026-02-30 → 400', badDay.status === 400);

const badDevice = await req('/api/games', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-device-id': 'bad device!' },
  body: JSON.stringify({}),
});
check('X-Device-Id 非法字符 → 400', badDevice.status === 400, `status=${badDevice.status}`);

/* ---------- 3. 幂等重传（不新增行） ---------- */
const archive = firstArchive();
const dedup = await req('/api/games', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(archive),
});
check('重传已归档 payload → dedup=true', dedup.body?.dedup === true, `gameUid=${dedup.body?.gameUid}`);
check('重传写入 0 手', dedup.body?.movesWritten === 0);

/* ---------- 4. 新房写入（跑完由调用方清理） ---------- */
const fresh = {
  format: 'jev-qiguan-game/v1',
  exported: new Date().toISOString(),
  game: '五子棋',
  gid: 'gomoku',
  mode: '人机',
  result: '黑方 获胜（五连）',
  notation: 'H8,H7,I8,H9,I9',
  codeVersion: '0.8.0',
  moves: [
    { side: '黑方', notation: 'H8', x: 7, y: 7 },
    { side: '白方', notation: 'H7', x: 7, y: 6 },
    { side: '黑方', notation: 'I8', x: 8, y: 7 },
    { side: '白方', notation: 'H9', x: 7, y: 8 },
    { side: '黑方', notation: 'I9', x: 8, y: 8 },
  ],
};
const created = await req('/api/games', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-device-id': DEVICE },
  body: JSON.stringify(fresh),
});
check('新房 POST 成功', created.status === 200 && created.body?.ok === true, `status=${created.status} uid=${created.body?.gameUid} moves=${created.body?.movesWritten}`);
const newUid = created.body?.gameUid;
check('新房写入 5 手', created.body?.movesWritten === 5);
check('新房 dedup=false', created.body?.dedup === false);

const back = await req(`/api/games/u/${newUid}`);
check('新房可被详情取回', back.status === 200 && back.body?.notation === fresh.notation);
check(
  '新房 payload 逐字保真（除服务端补的 gameUid）',
  back.status === 200 &&
    back.body?.exported === fresh.exported &&
    back.body?.result === fresh.result &&
    JSON.stringify(back.body?.moves) === JSON.stringify(fresh.moves) &&
    back.body?.gameUid === newUid,
  `uid=${back.body?.gameUid}`,
);

const mine = await req('/api/games?device=me&limit=5', { headers: { 'x-device-id': DEVICE } });
check('GET /api/games?device=me 只回自己的局', mine.status === 200 && mine.body?.games?.length === 1 && mine.body.games[0].gameUid === newUid);

const afterStats = await req('/api/stats');
check(
  '写入后 totalGames 恰好 +1',
  afterStats.body?.totalGames === baseGames + 1,
  `${baseGames} → ${afterStats.body?.totalGames}`,
);

console.log(`\n结果：${pass} 项通过 / ${fails.length} 项失败${fails.length ? ' → ' + fails.join('; ') : ''}`);
console.log(`清理命令：npx wrangler d1 execute jev-qiguan --remote --command "DELETE FROM game_moves WHERE game_id IN (SELECT id FROM games WHERE device_id='${DEVICE}'); DELETE FROM games WHERE device_id='${DEVICE}'; DELETE FROM devices WHERE device_id='${DEVICE}';"\n`);
process.exit(fails.length ? 1 : 0);
