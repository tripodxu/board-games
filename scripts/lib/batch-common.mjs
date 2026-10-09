/**
 * scripts/lib/batch-common.mjs — 远程批量实验的纯函数（零依赖，可被 worker/CLI/测试共用）
 *
 * 与浏览器实验路径的关系：
 *   - 黑白交替规则逐字镜像 `src/ui/panels/experiment.ts:128-138` 的 `sidesForGame()`
 *     （A 在奇数局执黑；`sidesForGame` 在 src/ui 层、Node 直载会拽进 DOM 依赖，故在此复刻并注释出处）。
 *   - 渠道集合来自 `src/core/jev/client.ts:26-30`（CHANNELS）+ decide() 的特殊渠道
 *     （mock:287 / rapfi:292 / random:321）。
 *   - 战术档白名单来自 `src/core/tactics-versions.ts` 的 VERSIONS——**必须在此拦截未知档号**：
 *     `resolve()` 对未知 id 静默回落 CURRENT（该文件 95-99 行，测试固化的「特性」），
 *     若不在入口拦住，A/B 实验写错档号会静默变成 v13 且事后不可检出（耦合审计报告 §4 坑 1）。
 */

import { allIds, CURRENT, nearestId } from '../../src/core/tactics-versions.ts';

/** decide() 认得的全部渠道：4 个上游 + mock/random/rapfi 三特判。 */
export const KNOWN_CHANNELS = ['mock', 'random', 'rapfi', 'official', 'openrouter', 'proxy', 'jevrouter'];

/** 需要真实上游 key 的渠道（submit 时据此估算配额与限流）。 */
export const UPSTREAM_CHANNELS = ['official', 'openrouter', 'proxy', 'jevrouter'];

/** 战术档 id 白名单（`allIds()` = 现档号 + 旧档号别名 v15/v16/v17）。
 *  含别名是刻意的：历史计划与历史棋谱的 `ai.tv` 里存的就是 v15/v16/v17 旧字符串
 *  （2026-10-08 改名成 v14.1/v14.2/v14.3），校验必须放行，`resolve()` 再归一。 */
export const TACTICS_IDS = allIds();

/** 当前档（spec 省略战术档时的缺省，与面板 `CURRENT` 默认一致）。 */
export const DEFAULT_TACTICS = CURRENT;

/** 生产域：`--origin` 缺省值（也是 submit 唯一会写生产 D1 的去处）。 */
export const PRODUCTION_ORIGIN = 'https://jevqipan.logicc.top';

/** P0 卫生包①：生产闸门 —— 没给 `--origin` 时必须显式 `--allow-production`。
 *
 *  为什么：`--origin` 缺省就是生产域，等于「默认往生产库写实验局」。默认安全比默认方便重要
 *  （免费额度、站点棋谱与研究数据混在一起）。返回 null = 放行；返回字符串 = 拒绝理由。 */
export function productionGate({ origin, allowProduction } = {}) {
  if (String(origin ?? '').trim()) return null;   // 显式给 origin：写的是别人家的库，放行
  if (allowProduction) return null;               // 明确认了「就写生产库」
  return `未给 --origin：这会写生产 D1（${PRODUCTION_ORIGIN}）。` +
    `确认要写就加 --allow-production；更推荐 --origin 指向独立 Worker + 独立 D1。`;
}

/** P0 卫生包②：`--parallel` 仅双本地臂放行（两侧都不是上游渠道）。
 *
 *  为什么：双上游臂并行必踩限流，且共享上游延迟会污染对照（对照实验里**唯一**要控的变量
 *  就是战术档）；rapfi-vs-rapfi 这类本地臂才是它的合理用途。返回 null = 放行。 */
export function parallelGate({ parallel, a, b } = {}) {
  if (!parallel) return null;
  const up = [a, b].filter((s) => s && UPSTREAM_CHANNELS.includes(s.channel));
  if (!up.length) return null;
  return `--parallel 只允许双本地臂（两侧都不是 ${UPSTREAM_CHANNELS.join('/')}）：` +
    `当前 A=${a?.channel ?? '?'} B=${b?.channel ?? '?'}，其中 ${up.map((s) => s.channel).join('/')} 是上游臂 —— ` +
    `并行会撞限流，且共享上游延迟会污染对照。上游臂请去掉 --parallel 串行跑。`;
}

/** tag 里 batchId 的合法字符（D1 目录/未来文件名安全）。 */
const BATCH_ID_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;

/**
 * 解析一侧配置：`渠道[:战术档][:思考ms]`，如 `official:v13-pressure-gate:1000` / `rapfi::1000` / `mock`。
 *   - 省略战术档 = 当前档（面板同口径）；
 *   - thinkMs 只对 rapfi 有意义（decide 只认 opts.rapfiThinkMs，见 client.ts:297），
 *     其他渠道给 0；非 rapfi 渠道写非 0 只告警不拦（与面板 #expThink* 只服务 rapfi 一致）。
 * 非法输入一律 throw（worker/CLI 转 exit 2），不做任何静默归一。
 */
export function parseSpec(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) throw new Error('spec 不能为空');
  const parts = raw.trim().split(':');
  if (parts.length > 3) throw new Error(`spec 段数过多（至多 渠道[:战术档][:思考ms]）：${raw}`);
  const channel = (parts[0] || '').trim();
  if (!KNOWN_CHANNELS.includes(channel)) {
    throw new Error(`未知渠道 "${channel}"，合法值：${KNOWN_CHANNELS.join(', ')}（spec=${raw}）`);
  }
  let tactics = (parts[1] || '').trim();
  if (tactics && !TACTICS_IDS.includes(tactics)) {
    const near = nearestId(tactics);
    throw new Error(`未知战术档 "${tactics}"，最接近：${near ?? '（无）'}，合法值：${TACTICS_IDS.join(', ')}（spec=${raw}）`);
  }
  if (!tactics) tactics = DEFAULT_TACTICS;
  let thinkMs = 0;
  if (parts.length === 3 && (parts[2] || '').trim() !== '') {
    thinkMs = Number((parts[2] || '').trim());
    if (!Number.isInteger(thinkMs) || thinkMs < 0) {
      throw new Error(`思考时长必须是非负整数（毫秒）：${raw}`);
    }
  }
  return { channel, tactics, thinkMs };
}

/** spec → 可回显字符串（report/checkpoint 里落盘用）。 */
export function formatSpec(cfg) {
  const t = cfg.thinkMs ? String(cfg.thinkMs) : '0';
  return `${cfg.channel}:${cfg.tactics}:${t}`;
}

/** batchId 清洗（D4：tag 里唯一后缀的来源）。 */
export function sanitizeBatchId(s) {
  const v = String(s ?? '').trim();
  if (!BATCH_ID_RE.test(v)) {
    throw new Error(`batchId 需匹配 ${BATCH_ID_RE}（1-16 位小写字母/数字/中划线）：${v}`);
  }
  return v;
}

/**
 * 轮次 tag：`exp-YYYYMMDDHHmmss-<batch>-r<i>`（D4）。
 * 比面板 `expTag()`（experiment.ts:116-118，秒级精度）多 batch+轮次后缀，堵 upsert 撞车。
 */
export function batchTag(now, batchId, roundNo) {
  const bid = sanitizeBatchId(batchId);
  if (!Number.isInteger(roundNo) || roundNo < 1) throw new Error(`roundNo 必须 ≥1：${roundNo}`);
  const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const tag = `exp-${ts}-${bid}-r${roundNo}`;
  if (tag.length > 64) throw new Error(`tag 超 64 字符（D1 列宽）：${tag}`);
  return tag;
}

/**
 * 第 gameNo 局（1-based）的黑白归属：镜像 experiment.ts:128-138（A 奇数局执黑）。
 * 返回 { aBlack, black, white }，black/white 是 {channel,tactics,thinkMs}。
 */
export function sidesForGameSpec(a, b, gameNo) {
  if (!Number.isInteger(gameNo) || gameNo < 1) throw new Error(`gameNo 必须 ≥1：${gameNo}`);
  const aBlack = (gameNo - 1) % 2 === 0;
  return { aBlack, black: aBlack ? a : b, white: aBlack ? b : a };
}

/** 每局 seed 派生（D5：全局 RNG 是唯一进程级污染源，见 rng.ts:25-27；局号派生保证可复现且互不覆盖）。 */
export function deriveSeed(seed, gameNo) {
  return (Math.imul(seed >>> 0, 1000003) + gameNo) >>> 0;
}

/** Elo 身份口径（D8）：与归档/报表的 `渠道|战术|思考` 桶键同形状（空战术档留空：`rapfi||500`），
 *  防幻影身份（同一配置不同写法算两档）。**唯一实现**：`batch-elo.mjs` 从这里复用。 */
export function identityOf(cfg) {
  const c = cfg || {};
  const channel = String(c.channel ?? '').trim();
  const tactics = String(c.tactics ?? '').trim();
  const think = Number.isFinite(Number(c.thinkMs)) ? Math.trunc(Number(c.thinkMs)) : 0;
  return `${channel}|${tactics}|${think}`;
}

/** 局内一步动手数文件名（纯字符串，方便单测）。 */
export function gameRecordName(roundNo, gameNo) {
  return `round-${roundNo}-game-${gameNo}.json`;
}

/**
 * 上游速率与写配额粗估（submit 打印用，D6）：
 *   - jevMovesPerMin = 60 / avgMoveSec（每步一次上游调用，mock/random/rapfi 不计）；
 *   - writesPerDay = 每局 1 + N 手（D1 games 行 + moves 行，worker/db/games.ts）。
 */
export function estimateBudget(a, b, games, avgMoveSec, avgPliesPerGame) {
  const jevMovesPerMin = (ms) => Math.round(60 / Math.max(0.001, ms / 1000));
  const sides = [a, b].filter((c) => UPSTREAM_CHANNELS.includes(c.channel));
  const worstMoveMs = Math.max(402, avgMoveSec * 1000); // playbooks: tactics 均值 402ms
  return {
    upstreamSides: sides.length,
    jevCallsPerMin: sides.length ? jevMovesPerMin(worstMoveMs) * sides.length : 0,
    jevCallsPerGame: sides.length ? Math.ceil(avgPliesPerGame / 2) * sides.length : 0,
    writesPerDay: Math.ceil((1 + avgPliesPerGame) * games),
  };
}
