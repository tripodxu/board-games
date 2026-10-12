/* device-id.ts — 匿名设备标识的唯一值域定义（ADR-0013）
 *
 * 为什么放 `src/shared/**`：这套规则有**两个**消费面 —— Worker 侧校验请求头
 * （`src/worker/lib/validate.ts` 的 `parseDeviceId`）与浏览器侧生成 / 读盘
 * （`src/core/device.ts`）。两边各抄一份正则早晚会漂，而漂了的后果不是 400 而是
 * **静默换身份**：浏览器发一个服务端不认的 id → 服务端 400 → 面板显示「后端不可用」，
 * 看上去像网络故障。`src/shared/record-map.ts` 已是「worker 与 core 共用一份」的先例。
 *
 * 值域：长度 8–64 的 URL 安全串。`crypto.randomUUID()` 的 36 字符（含 `-`）正好落在这里；
 * 历史数据里的短随机 id 也在内（远端批量用的 `ssh-batch` 是 9 字符）。
 */

/** 请求头名。HTTP 头大小写不敏感，但全项目只写这一种形态（测试与冒烟按它断言）。 */
export const DEVICE_ID_HEADER = 'X-Device-Id';

/** 长度 8–64 的 URL 安全串（`[A-Za-z0-9_-]`）。 */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 归一化外部来源的设备 id：空白 / 不合法一律 null。
 *
 *  **不抛异常、也不截断**：截断会把一个合法 id 悄悄改成另一个合法 id（等于换身份），
 *  还不如当成「没有身份」——那时服务端的行为是明确的 400 或 NULL 归属。
 */
export function normalizeDeviceId(raw: string | null | undefined): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || !DEVICE_ID_RE.test(v)) return null;
  return v;
}
