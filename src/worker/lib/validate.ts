/**
 * 请求校验（§5.5）：手写、零依赖、每个拒绝分支都有单测。
 *
 * 为什么不用 zod：只为了五六个字段的检查不值得付出体积与首字节时延；而且这里的
 * 校验规则要**向后兼容**旧客户端（缺 `gameUid`/`winner`/`gameId` 时由服务端推导），
 * 手写比 schema 更好表达「缺了就推导、错了才拒绝」。
 *
 * 约定：所有 `parse*` 返回 `Parsed<T>`，路由用 `fail(c, r)` 直接产出统一错误体，
 * 不抛异常（抛异常会走到 onError 变成 500，把 4xx 语义丢掉）。
 */
import type { Context } from 'hono';
import { measureBytes } from '../../shared/record-map.ts';
import { MAX_PAYLOAD_BYTES } from '../db/index.ts';
import { errorBody, statusFor, type ApiErrorCode } from './http.ts';

export interface Invalid {
  ok: false;
  code: ApiErrorCode;
  message: string;
}
export type Parsed<T> = { ok: true; value: T } | Invalid;

export const invalid = (code: ApiErrorCode, message: string): Invalid => ({ ok: false, code, message });

/** 统一错误响应：错误体形状与 requestId 由中间件写入。 */
export function fail(c: Context, bad: Invalid) {
  return c.json(errorBody(bad.code, bad.message, c.get('requestId' as never) as string), statusFor(bad.code));
}

/* ---------- 匿名设备标识（ADR-0013） ---------- */

/** 长度 8–64 的 URL 安全串：兼容 `crypto.randomUUID()` 与旧的短随机 id。 */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function parseDeviceId(raw: string | null | undefined): Parsed<string | null> {
  const value = raw?.trim();
  if (!value) return { ok: true, value: null };
  if (!DEVICE_ID_RE.test(value)) return invalid('bad_request', 'X-Device-Id 格式不合法');
  return { ok: true, value };
}

/* ---------- 查询参数 ---------- */

export function parseLimitParam(
  raw: string | undefined,
  { max, fallback }: { max: number; fallback: number },
): Parsed<number> {
  if (raw === undefined || raw === '') return { ok: true, value: fallback };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return invalid('bad_request', 'limit 必须是正整数');
  return { ok: true, value: Math.min(n, max) };
}

export function parseCursorParam(raw: string | undefined): Parsed<number | null> {
  if (raw === undefined || raw === '') return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return invalid('bad_request', 'cursor 不合法');
  return { ok: true, value: n };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 日期参数（`day` / `since`）。除形状外还要过一遍真实日历：`2026-13-99` 形状合法
 * 却无意义，放行后会静默退化成「不过滤」，排查时看起来像「筛选没生效」而不是
 * 「参数写错了」。来回 `toISOString` 一趟即可识别 2 月 30 日这类溢出日期。
 */
export function parseDayParam(raw: string | undefined): Parsed<string | null> {
  if (raw === undefined || raw === '') return { ok: true, value: null };
  if (!DAY_RE.test(raw)) return invalid('bad_request', 'since/day 必须是 YYYY-MM-DD');
  const at = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 10) !== raw) {
    return invalid('bad_request', 'since/day 不是真实存在的日期');
  }
  return { ok: true, value: raw };
}

export function parseEnumParam<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): Parsed<T> {
  if (raw === undefined || raw === '') return { ok: true, value: fallback };
  if (!allowed.includes(raw as T)) return invalid('bad_request', `取值必须是 ${allowed.join(' / ')}`);
  return { ok: true, value: raw as T };
}

/* ---------- 请求体 ---------- */

export async function readJsonBody(c: Context): Promise<Parsed<unknown>> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return invalid('bad_request', '读取请求体失败');
  }
  if (!text.trim()) return invalid('bad_request', '请求体不能为空');
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return invalid('bad_request', '请求体不是合法 JSON');
  }
}

export interface GamePayloadCheck {
  payload: Record<string, unknown>;
  /** 归一后的着法串（原样使用 payload 里的 notation，不做重排）。 */
  notation: string;
  moves: unknown[];
  bytes: number;
}

/** 逗号分隔的着法串 → 条目数（容忍旧格式末尾多一个逗号）。 */
export function notationCount(notation: string): number {
  return notation.split(',').filter((part) => part.trim() !== '').length;
}

/**
 * 对局 payload 形状检查（§5.5）。这些字段是**旧的强约束**，保留它们才能保证
 * 落库的行可被回放器与统计消费；新字段（`gameUid`/`winner`/`gameId`…）缺失不报错，
 * 由 `lib/record-input.ts` 推导。
 */
export function parseGamePayload(raw: unknown): Parsed<GamePayloadCheck> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid('invalid_payload', 'payload 必须是对象');
  }
  const payload = raw as Record<string, unknown>;
  if (payload.format !== 'jev-qiguan-game/v1') {
    return invalid('invalid_payload', 'format 必须是 jev-qiguan-game/v1');
  }
  if (typeof payload.notation !== 'string' || payload.notation.trim() === '') {
    return invalid('invalid_payload', 'notation 必须是非空字符串');
  }
  /* `exported` 是 game_uid / dedup_key / day 三者的输入，不可解析就不能入库：
   * 放行会让 `insertGame` 抛 TypeError 变成 500，而这是客户端的错（422）。 */
  if (typeof payload.exported !== 'string' || !Number.isFinite(Date.parse(payload.exported))) {
    return invalid('invalid_payload', 'exported 必须是可解析的时间字符串');
  }
  if (payload.gameUid !== undefined) {
    const uid = payload.gameUid;
    if (typeof uid !== 'string' || uid.trim() === '' || uid.length > 64) {
      return invalid('invalid_payload', 'gameUid 必须是 1–64 字符的字符串');
    }
  }
  if (!Array.isArray(payload.moves) || payload.moves.length === 0) {
    return invalid('invalid_payload', 'moves 必须是非空数组');
  }
  for (const [i, move] of payload.moves.entries()) {
    if (typeof move !== 'object' || move === null) return invalid('invalid_payload', `moves[${i}] 必须是对象`);
    const notation = (move as { notation?: unknown }).notation;
    if (typeof notation !== 'string' || notation.trim() === '') {
      return invalid('invalid_payload', `moves[${i}].notation 必须是非空字符串`);
    }
  }
  if (notationCount(payload.notation) !== payload.moves.length) {
    return invalid('invalid_payload', 'notation 条目数与 moves 长度不一致');
  }
  const bytes = measureBytes(JSON.stringify(payload));
  if (bytes > MAX_PAYLOAD_BYTES) {
    return invalid('payload_too_large', `payload 超出上限：${bytes} > ${MAX_PAYLOAD_BYTES} 字节`);
  }
  return {
    ok: true,
    value: { payload, notation: payload.notation, moves: payload.moves, bytes },
  };
}
