/* device.ts — 匿名设备标识的生成与持久化（ADR-0013 的浏览器半边）
 *
 * ADR-0013 把「零登录成本获得『只看我的』」写成选它的理由，但 P8 之前浏览器侧一直**没有**
 * 这个 id：`src/core/api/client.ts` 不发任何设备头 ⇒ 归档落库 `device_id` 为 NULL、
 * `GET /api/games?device=me` 一律 400（服务端那半边的校验、写入与过滤早就就绪）。
 * 本模块补上缺的那半：开局生成 / 读盘一次，客户端把它挂到每个 `/api/*` 请求上。
 *
 * 与 `src/core/persist.ts` 同款约束：存储靠注入（`StorageLike`），本文件不碰 localStorage、
 * 不碰 DOM、不 import `node:*`，纯 Node 里可直载。
 *
 * 键名与设置键（`jev_qiguan_settings_v2`）**刻意分开**：设置读写是「浅合并 + 损坏回退默认值」，
 * 设备 id 混进那份 JSON 会带来两个后果 —— 清理一次设置就换身份（已有棋谱全留在旧身份下），
 * 以及某个字段损坏时连带把身份一起丢掉。
 */
import type { StorageLike } from './persist.ts';
import { normalizeDeviceId } from '../shared/device-id.ts';

/** 设备 id 的存储键。**不要改**：改一次等于给所有老用户换身份。 */
export const DEVICE_ID_KEY = 'jev_qiguan_device_id';

/** 生成一个新的设备 id。
 *
 *  优先 `crypto.randomUUID()`：36 字符、URL 安全、真随机。老浏览器与非安全上下文
 *  （`file://`、局域网 http）没有它，退到「时间戳 + Math.random」的 36 进制串 ——
 *  不是密码学随机，但这个 id 只用来分桶与限流，不作鉴权（ADR-0013 的前提）。
 */
export function newDeviceId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const uuid = c && typeof c.randomUUID === 'function' ? c.randomUUID() : '';
    const norm = normalizeDeviceId(uuid);
    if (norm) return norm;
  } catch (_) {
    /* 非安全上下文里 randomUUID 可能直接抛：走下面的兜底 */
  }
  return 'dev' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** 读盘取设备 id：合法就沿用，缺失 / 损坏 / 存储不可用 → 生成一个并**尽力**写回。
 *
 *  写盘失败（Safari 隐私模式、配额满）不抛也不报错：这一局照常带 id 发请求，只是下次会换新的。
 *  返回值必定合法 —— 不存在「返回一个服务端会 400 的串」这条路径（这正是上一版浏览器侧
 *  完全没有 id 时没人发现的坑：没有比有错更难查）。
 */
export function loadDeviceId(storage: StorageLike): string {
  let raw: string | null = null;
  try {
    raw = storage.getItem(DEVICE_ID_KEY);
  } catch (_) {
    raw = null;
  }
  const known = normalizeDeviceId(raw);
  if (known) return known;
  const fresh = newDeviceId();
  try {
    storage.setItem(DEVICE_ID_KEY, fresh);
  } catch (_) {
    /* 写不进去也不能崩：身份只在这一局有效 */
  }
  return fresh;
}
