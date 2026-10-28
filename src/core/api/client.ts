/* client.ts — 后端 HTTP 客户端（迁移自 js/api.js；新契约见重建计划 §5.1 路由表）
 *
 * 一条铁律贯穿全文：**没有后端时一律返回 null，不抛异常**。
 * 理由：这个前端可以在 `vite preview` 无 Worker、甚至无网络的情况下完整使用——
 * 战绩簿落 localStorage、实验只本地归档、校准只吃本机样本、离线走 mock 渠道。
 * 任何一处改成抛错，这条降级路径就断了（计划 §6.5）。
 *
 * 与旧实现的契约差异（§5.1）：
 *   - `/api/games` 支持 limit(≤100)/cursor(keyset)/game/device/tag/since，不再 7 天窗口；
 *   - `/api/stats` 去掉 `truncated`，新增 scope/game/since；
 *   - 新增 `/api/games/u/:gameUid`、`/api/openings`、`/api/leaderboard`、`/api/export/games`。
 */
import type { Experience } from '../tactics.ts';
import { DEVICE_ID_HEADER, normalizeDeviceId } from '../../shared/device-id.ts';

const TIMEOUT_MS = 8000;
/* 探活（/api/health）单独用更短的超时：它只用来画右上角那枚状态芯片，不该当首屏闸门。
 * 后端不在线时要等满 8s 才降级，会把后面三块面板的取数一起拖住（原来就是串行瀑布）。 */
const PROBE_TIMEOUT_MS = 2000;

/* ---------- 匿名设备标识（ADR-0013 的客户端半边） ----------
 * 模块级一份：装配层开局 `setDeviceId(loadDeviceId(storage))` 灌一次（src/app/boot.ts），
 * 之后所有 `/api/*` 请求自动带上 `X-Device-Id`。
 * 为什么不是每个调用点传参：写下棋谱、实验台账、统计、归档过滤**共用同一个身份**，
 * 哪一处漏传就是一处 NULL 归属（旧行为正是这样：浏览器完全不发这个头，
 * `device_id` 全为 NULL，「只看我的」只有冒烟脚本走得通）。
 *
 * 只影响**我们自己的** Worker（本文件的 fetch）：上游渠道的直连请求走
 * `src/core/jev/client.ts`，那边绝不能带这个头——多一个自定义头会触发跨域预检。 */
let deviceId = '';

/** 设置设备 id：不合法（空、太短、带空格）直接丢弃，退化成「不发这个头」。
 *  宁可没有身份，也不要发一个服务端必然 400 的串（那会把面板打成「后端不可用」）。 */
export function setDeviceId(id: string | null | undefined): void {
  deviceId = normalizeDeviceId(id) ?? '';
}

/** 当前设备 id（空串 = 无身份；测试与调试用）。 */
export function getDeviceId(): string {
  return deviceId;
}

/** 请求头：有 body 才加 `Content-Type`，有设备 id 才加 `X-Device-Id`；
 *  两者都没有时返回 undefined —— 保持旧的无头 GET 形状（测试与缓存行为都按它写的）。 */
function headersFor(opts?: CallOpts): Record<string, string> | undefined {
  const h: Record<string, string> = {};
  if (opts && opts.body !== undefined) h['Content-Type'] = 'application/json';
  if (deviceId) h[DEVICE_ID_HEADER] = deviceId;
  return Object.keys(h).length ? h : undefined;
}

/** 查询参数（只序列化有值的键，顺序稳定：同参数 → 同 URL）。 */
export type Query = Record<string, string | number | boolean | null | undefined>;

/** 单次请求的额外参数（与查询参数区分开，避免 index 签名冲突）。 */
export interface CallOpts {
  query?: Query;
  method?: string;
  body?: unknown;
  /** 单次请求超时（毫秒）；缺省 `TIMEOUT_MS`（8s）。探活这类「只画状态」的请求传 2s。 */
  timeoutMs?: number;
}

/** 单次请求：无 fetch / 超时 / 非 2xx / 非 JSON / 任何异常 → null。 */
export async function call<T = unknown>(path: string, opts?: CallOpts): Promise<T | null> {
  try {
    if (typeof fetch !== 'function') return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || TIMEOUT_MS);
    try {
      const init: RequestInit = { signal: ctrl.signal };
      if (opts && opts.method) init.method = opts.method;
      if (opts && opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
      }
      const headers = headersFor(opts);
      if (headers) init.headers = headers;
      const r = await fetch(path + qs(opts && opts.query), init);
      if (!r.ok) return null;
      return await r.json() as T;
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return null;
  }
}

/** POST JSON（无后端同样返回 null）。 */
export function post<T = unknown>(path: string, body: unknown): Promise<T | null> {
  return call<T>(path, { method: 'POST', body });
}

/** 把查询参数拼成 `?a=1&b=2`（无参数返回空串；null/undefined 跳过）。 */
function qs(params?: Query): string {
  const parts: string[] = [];
  if (params) {
    for (const k of Object.keys(params)) {
      const v = params[k];
      if (v === null || v === undefined || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/** 棋谱相对路径 → API 路径（剥掉历史遗留的 `games/` 前缀）。 */
function relPath(relPath: string | null | undefined): string {
  return String(relPath || '').replace(/^games\//, '');
}

/* ---------- 返回体类型（字段名与 Worker 契约一致，全部可选：老后端可能缺） ---------- */

export interface HealthInfo {
  ok?: boolean;
  service?: string;
  version?: string;
  schema?: string;
  d1?: boolean;
  device?: boolean;
  [k: string]: unknown;
}

export interface SaveGameResult {
  ok?: boolean;
  id?: string | number;
  gameUid?: string;
  path?: string;
  dedup?: boolean;
  [k: string]: unknown;
}

export interface GameListResult {
  ok?: boolean;
  games?: unknown[];
  nextCursor?: string | null;
  [k: string]: unknown;
}

export interface StatsResult {
  ok?: boolean;
  totalGames?: number;
  byGame?: Record<string, number>;
  results?: Record<string, number>;
  cal?: { records?: unknown[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface OpeningRow {
  prefix?: string;
  opening_prefix?: string;
  games?: number;
  black_win_rate?: number;
  [k: string]: unknown;
}

export interface LeaderboardRow {
  channel?: string;
  tactics?: string;
  wins?: number;
  games?: number;
  win_rate?: number;
  [k: string]: unknown;
}

/* ---------- 接口 ---------- */

/** Worker/D1 探活（2s 超时：只决定状态芯片，不挡首屏）。 */
export const health = (): Promise<HealthInfo | null> =>
  call<HealthInfo>('/api/health', { timeoutMs: PROBE_TIMEOUT_MS });

/** 归档一局棋谱（返回 {ok,id,gameUid,dedup}，兼容字段 path）。 */
export const saveGame = (payload: unknown): Promise<SaveGameResult | null> => post<SaveGameResult>('/api/games', payload);

/** 棋谱列表（keyset 分页 + 过滤；limit 上限 100 由服务端兜底）。 */
export const listGames = (query?: Query): Promise<GameListResult | null> => call<GameListResult>('/api/games', { query });

/** 稳定永久链接（回放器与分享用）。 */
export const getGameByUid = (gameUid: string): Promise<unknown | null> =>
  call('/api/games/u/' + encodeURIComponent(String(gameUid || '')));

/** 兼容旧 URL（day + 文件名）。 */
export const getGame = (path: string | null | undefined): Promise<unknown | null> => call('/api/games/' + relPath(path));

/** 棋谱的对外可访问 URL（下载/分享链接，不发请求）。 */
export const gameUrl = (path: string | null | undefined): string => '/api/games/' + relPath(path);

/** 实验轮次归档（按 tag upsert）。 */
export const saveExperiment = (entry: unknown): Promise<unknown | null> => post('/api/experiments', entry);

/** 实验台账（支持 device 过滤）。
 *
 * 响应体是**包装对象** `{experiments:[…]}`（Worker 侧契约，旧 `js/api.js` 的调用方也是按
 * `r.experiments` 读的），这里统一解包成数组，让调用方直接吃数组——P6 装配时误以为
 * 客户端已经解包，写成 `Array.isArray(r)` 判断，导致服务端战报**从来没并进报告面板**。
 * 兼容裸数组（便于测试桩与将来可能的契约变化），其余形状一律 null。 */
export const listExperiments = async (query?: Query): Promise<unknown[] | null> => {
  const r = await call<unknown[] | { experiments?: unknown }>('/api/experiments', { query });
  if (Array.isArray(r)) return r;
  const inner = r && (r as { experiments?: unknown }).experiments;
  return Array.isArray(inner) ? inner : null;
};

/** 统计（scope=global|device、game、since；**无 truncated 字段**）。 */
export const stats = (query?: Query): Promise<StatsResult | null> => call<StatsResult>('/api/stats', { query });

/** 开具体验统计（喂 state.experience，跨设备）。 */
export const openings = (query?: Query): Promise<OpeningRow[] | { openings?: OpeningRow[] } | null> =>
  call('/api/openings', { query });

/** 渠道 × 战术档胜率榜。 */
export const leaderboard = (query?: Query): Promise<LeaderboardRow[] | { rows?: LeaderboardRow[] } | null> =>
  call('/api/leaderboard', { query });

/** JSONL 批量导出（备份与迁移对账）：返回原始文本，失败 null。 */
export const exportGames = (query?: Query): Promise<string | null> => callText('/api/export/games' + qs(query));

/** 取纯文本响应（导出接口用）。 */
export async function callText(path: string): Promise<string | null> {
  try {
    if (typeof fetch !== 'function') return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const headers = headersFor();
      const r = await fetch(path, headers ? { signal: ctrl.signal, headers } : { signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return null;
  }
}

/** 开具体验 → `state.experience` 载荷（`{prefix, games, black_win_rate}` 的行）。 */
export function toExperience(rows: OpeningRow[] | { openings?: OpeningRow[] } | null): Experience | null {
  const list = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.openings) ? rows.openings : null);
  if (!list || !list.length) return null;
  return {
    openings: list.map((r) => ({
      prefix: r.prefix != null ? r.prefix : r.opening_prefix,
      games: r.games,
      black_win_rate: r.black_win_rate,
    })),
  };
}

/** 旧实现的七个方法名保持可用（`BG.api` 等价出口，UI 层与自检都按名字调）。 */
export const api = {
  health, saveGame, listGames, getGame, gameUrl, saveExperiment, listExperiments, stats,
  getGameByUid, openings, leaderboard, exportGames,
};
