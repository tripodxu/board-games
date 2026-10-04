/**
 * scripts/lib/openings.mjs — 配对开局库（D9：消掉「谁拿到顺手开局」的方差）
 *
 * 为什么需要：同一档位两轮 20 局能差 17.5 pt，比档位之间的差距还大。要让实验能分辨 5 pt，
 * 必须把「开局」这个最大的方差源按住：**同一开局、换色双跑**（奇数局 A 执黑、偶数局 B 执黑，
 * 见 `batch-common.sidesForGameSpec`），于是每两局构成一对，开局完全相同、只有颜色不同。
 *
 * 开局从哪来：不做人工开局树，直接从**归档决胜局**取前 6–8 手（真实对局里出现过的开局）。
 * 同一开局在 8 种二面体变换（4 旋转 × 2 镜像）下等价 ⇒ 先对称归一再去重，否则同一开局会被
 * 记成 8 条，配对时等于随机挑一条。
 *
 * 口径纪律：
 *   - 库文件里**不写时间戳**（生成即确定）：同样的输入必须生成逐字节相同的库，否则「可复现」无从谈起；
 *   - 归一化后存的是**最小表示**（不是原始走法序）⇒ 库与归档顺序无关；
 *   - 开局手数与库长度都在文件里自描述（`plies` / `size`），worker 载入时校验（`validateLibrary`）。
 *
 * 本文件是纯逻辑（零第三方依赖，也不 import `src/core`）：记法口径与
 * `src/core/engines/gomoku.ts:23` 的 `parseN` 一致（列字母 A..O + 行号 1..15），
 * 但只靠自己的 `rcOf`/`notationOf` 实现，因此可以在任何 Node 里直载、可单测。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 库格式版本：形状变了就 +1（worker 遇到不认识的主版本直接拒载）。 */
export const LIB_VERSION = 1;

/** 默认盘面边长（五子棋 15×15）。 */
export const BOARD_SIZE = 15;

/** 二面体群阶（4 旋转 × 2 镜像）。 */
export const SYMMETRIES = 8;

/** 记法 → 坐标（与 `src/core/engines/gomoku.ts:23` 的 `parseN` 同口径：列字母 + 行号-1）。 */
export function rcOf(n) {
  const s = String(n ?? '');
  return { r: parseInt(s.slice(1), 10) - 1, c: s.charCodeAt(0) - 65 };
}

/** 坐标 → 记法。 */
export function notationOf(r, c) {
  return String.fromCharCode(65 + c) + String(r + 1);
}

/** 8 种二面体变换：k∈[0,4) 旋转 k×90°，k∈[4,8) 先左右镜像再旋转 (k-4)×90°。 */
export function transformRC(r, c, k, size = BOARD_SIZE) {
  let rr = r;
  let cc = k >= 4 ? size - 1 - c : c;
  for (let i = 0; i < (k % 4); i++) {
    const nr = cc;
    const nc = size - 1 - rr;
    rr = nr;
    cc = nc;
  }
  return { r: rr, c: cc };
}

/** 变换一步记法（越界返回 null，交给调用方判非法）。 */
export function transformNotation(n, k, size = BOARD_SIZE) {
  const { r, c } = rcOf(n);
  if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
  const t = transformRC(r, c, k, size);
  if (t.r < 0 || t.r >= size || t.c < 0 || t.c >= size) return null;
  return notationOf(t.r, t.c);
}

/** 一步记法是否合法（形状 + 盘内）。 */
export function isValidPoint(n, size = BOARD_SIZE) {
  const s = String(n ?? '');
  if (!/^[A-Z]\d{1,2}$/.test(s)) return false;
  const { r, c } = rcOf(s);
  return r >= 0 && r < size && c >= 0 && c < size;
}

/** 一段开局是否合法：非空、每手形状正确、无重复点。返回 null = 合法，否则给理由。 */
export function openingProblem(seq, size = BOARD_SIZE) {
  if (!Array.isArray(seq) || seq.length === 0) return '开局为空';
  const seen = new Set();
  for (const n of seq) {
    if (!isValidPoint(n, size)) return `非法着法 "${n}"（盘面 ${size}×${size}）`;
    if (seen.has(n)) return `重复点 "${n}"`;
    seen.add(n);
  }
  return null;
}

/**
 * 对称归一：在 8 种变换里取**坐标序最小**的那个表示（先比第 1 手的 r，再比 c，逐手比较）。
 * 返回 `{ key, seq }`：`key` 是空格连接的记法串（去重键），`seq` 是归一后的走法序。
 */
export function canonicalOpening(seq, size = BOARD_SIZE) {
  const problem = openingProblem(seq, size);
  if (problem) throw new Error(`开局不合法：${problem}`);
  let best = null;
  for (let k = 0; k < SYMMETRIES; k++) {
    const t = seq.map((n) => transformNotation(n, k, size));
    if (t.some((n) => n == null)) continue;
    if (best === null || compareSeq(t, best) < 0) best = t;
  }
  if (!best) throw new Error(`开局无法归一（变换后越界）：${seq.join(' ')}`);
  return { key: best.join(' '), seq: best };
}

/** 按坐标逐手比较两个开局序（不比较字符串，避免 "A10" < "A9" 这种字典序陷阱）。 */
export function compareSeq(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const pa = rcOf(a[i]);
    const pb = rcOf(b[i]);
    if (pa.r !== pb.r) return pa.r - pb.r;
    if (pa.c !== pb.c) return pa.c - pb.c;
  }
  return a.length - b.length;
}

/** 从一局棋谱取前 `plies` 手（接受 `['H8',…]` 或 `[{notation},…]`；不足则返回 null）。 */
export function openingOfMoves(moves, plies) {
  if (!Array.isArray(moves) || moves.length < plies) return null;
  const out = [];
  for (let i = 0; i < plies; i++) {
    const m = moves[i];
    const n = typeof m === 'string' ? m : m && m.notation;
    if (!n) return null;
    out.push(String(n));
  }
  return out;
}

/**
 * 决胜方口径：`'black'` / `'white'` / `'draw'` / `null`（未终局）。
 * 两种棋谱形状都认：
 *   - worker / D1 导出：`winner` = `black` | `white` | `draw` | 缺（和棋的 winner 也是 null）；
 *   - **归档导出（browser）**：没有 `winner` 字段，只有中文 `result`
 *     （`"黑方 获胜（五连）"` / `"白方 获胜（认输）"` / `"和棋（棋盘已满）"`）—— 54 个归档局全是这种，
 *     只认 `winner` 的话一局都进不了库（这正是 P4 首次建库得到「库是空的」的原因）。
 */
export function winnerSideOf(rec) {
  const w = String((rec && rec.winner) || '');
  if (w === 'black' || w === '黑方') return 'black';
  if (w === 'white' || w === '白方') return 'white';
  if (w === 'draw') return 'draw';
  const result = String((rec && rec.result) || '');
  if (/和棋/.test(result)) return 'draw';
  if (/黑方\s*获胜/.test(result)) return 'black';
  if (/白方\s*获胜/.test(result)) return 'white';
  return null;
}

/**
 * 生成开局库（纯函数，同样输入 ⇒ 逐字节相同输出）。
 *
 * `records`：`[{ gameUid, winner|result, moves }]`（决胜方口径见 `winnerSideOf`）。
 * 选项：`plies`（取前几手，默认 6）、`size`、`decisiveOnly`（默认 true：只要分出胜负的局）、
 *       `minCount`（至少出现几次才入库，默认 1）、`limit`（最多几本开局）。
 */
export function buildLibrary(records, { plies = 6, size = BOARD_SIZE, decisiveOnly = true, minCount = 1, limit = Infinity } = {}) {
  if (!Number.isInteger(plies) || plies < 2) throw new Error(`plies 必须是 ≥2 的整数：${plies}`);
  const list = Array.isArray(records) ? records : [];
  const byKey = new Map();
  let used = 0;
  let dropped = 0;
  for (const rec of list) {
    if (!rec) continue;
    if (decisiveOnly && winnerSideOf(rec) !== 'black' && winnerSideOf(rec) !== 'white') { dropped++; continue; }
    const raw = openingOfMoves(rec.moves, plies);
    if (!raw) { dropped++; continue; }
    if (openingProblem(raw, size)) { dropped++; continue; }
    const { key, seq } = canonicalOpening(raw, size);
    used++;
    const hit = byKey.get(key);
    if (hit) {
      hit.count++;
      if (rec.gameUid && hit.uids.length < 5) hit.uids.push(rec.gameUid);
    } else {
      byKey.set(key, { key, seq, count: 1, uids: rec.gameUid ? [rec.gameUid] : [] });
    }
  }
  const openings = [...byKey.values()]
    .filter((o) => o.count >= minCount)
    .sort((a, b) => b.count - a.count || compareSeq(a.seq, b.seq));
  return {
    version: LIB_VERSION,
    size,
    plies,
    source: { games: list.length, used, dropped },
    openings: openings.slice(0, limit === Infinity ? openings.length : Math.max(0, limit)),
  };
}

/** 库形状校验：返回问题数组（空数组 = 通过）。worker 载入前必须过这一关。 */
export function libraryProblems(lib) {
  const bad = [];
  if (!lib || typeof lib !== 'object') return ['库不是对象'];
  if (lib.version !== LIB_VERSION) bad.push(`库版本 ${lib.version} ≠ ${LIB_VERSION}`);
  const size = lib.size;
  if (!Number.isInteger(size) || size < 5) bad.push(`size 不合法：${size}`);
  if (!Number.isInteger(lib.plies) || lib.plies < 2) bad.push(`plies 不合法：${lib.plies}`);
  if (!Array.isArray(lib.openings) || lib.openings.length === 0) bad.push('库是空的（openings 为空数组）');
  const keys = new Set();
  (lib.openings || []).forEach((o, i) => {
    const where = `openings[${i}]`;
    if (!o || typeof o !== 'object') { bad.push(`${where} 不是对象`); return; }
    if (!Array.isArray(o.seq) || o.seq.length !== lib.plies) bad.push(`${where}.seq 长度 ≠ plies`);
    const problem = openingProblem(o.seq, size);
    if (problem) bad.push(`${where}.seq ${problem}`);
    if (o.key !== (o.seq || []).join(' ')) bad.push(`${where}.key 与 seq 不一致`);
    if (keys.has(o.key)) bad.push(`${where}.key 重复：${o.key}`);
    keys.add(o.key);
  });
  return bad;
}

/** 读库文件（含形状校验；不合法直接 throw，worker 转 exit 2）。 */
export function readLibrary(file) {
  const lib = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bad = libraryProblems(lib);
  if (bad.length) throw new Error(`开局库不合法（${file}）：${bad.slice(0, 5).join('；')}`);
  return lib;
}

/** 原子写库文件（先 `.tmp` 再 rename；库是产物，半截文件比没有更坏）。 */
export function writeLibrary(file, lib) {
  const bad = libraryProblems(lib);
  if (bad.length) throw new Error(`拒绝写出不合法的开局库：${bad.slice(0, 5).join('；')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 第 `gameNo` 局（1-based）用哪本开局：**连续两局同一本**（换色双跑）。
 * 越界就绕回复用（库只有 K 本时，K 对之后从头再来 —— 配对结构不变，代价是重复）。
 */
export function openingForNo(lib, gameNo) {
  const n = lib && Array.isArray(lib.openings) ? lib.openings.length : 0;
  if (!n) throw new Error('开局库为空');
  if (!Number.isInteger(gameNo) || gameNo < 1) throw new Error(`gameNo 必须 ≥1：${gameNo}`);
  return lib.openings[Math.floor((gameNo - 1) / 2) % n];
}

/** 从棋谱目录抽 `records`（路径上**任何一级目录**叫 `games`，与 batch-elo.loadRecords 同布局）。
 *  两种布局都要认：worker 的 `round-i/games/*.json`，以及归档的 `games/<day>/*.json`
 *  （早先只认「父目录名叫 games」，归档会被全部漏掉 ⇒ 开局库永远建不出来）。 */
export function recordsFromDir(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const inGamesDir = (p) => p.split(path.sep).slice(0, -1).includes('games');
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.json$/i.test(name) || !inGamesDir(p)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        /* 归档局的 uid 在 `gid`（worker 导出在 `gameUid`/`game_uid`）；决胜方见 winnerSideOf */
        out.push({
          gameUid: j.gameUid || j.game_uid || j.gid || null,
          winner: j.winner ?? null,
          result: j.result ?? null,
          moves: j.moves || [],
        });
      } catch { /* 坏文件跳过：开局库不是归档真值的来源 */ }
    }
  };
  walk(dir);
  return out;
}
