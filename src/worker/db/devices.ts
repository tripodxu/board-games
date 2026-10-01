/**
 * 匿名设备数据访问（devices）。ADR-0013：不做登录，device_id 只用于「这台机器的战绩 /
 * 限流档位」这类自用视角，可伪造、不构成授权。
 *
 * 两条「不能退」的语义都放在 SQL 里：
 * - `first_seen` 只在首次插入时写，之后不动（覆盖它等于篡改设备档案）；
 * - `last_seen` 用 MAX 单调前进——重试的旧请求可能带着更早的时间戳到达，直接把
 *   last_seen 覆盖回去会让「最后活跃」倒退。
 */

/** touch 输入。at 缺省由调用方时刻填充；ua / label 未给出即保留旧值。 */
export interface TouchDeviceInput {
  deviceId: string;
  /** UTC ISO8601；ISO 串按字典序即按时间序比较，MAX() 因此成立。 */
  at?: string;
  ua?: string | null;
  label?: string | null;
}

/** devices 行（SQL 别名后的形状）。 */
export interface DeviceRow {
  deviceId: string;
  firstSeen: string;
  lastSeen: string;
  label: string | null;
  ua: string | null;
}

const DEVICE_COLUMNS = `device_id AS deviceId, first_seen AS firstSeen, last_seen AS lastSeen,
  label, ua`;

/**
 * 记一次设备活跃。`label` / `ua` 用 COALESCE 保护：请求里没带这两项时不能把已有的
 * 名字抹成 NULL（旧 Pages 版按整份对象覆盖写，前端少带 label 就会丢）。
 */
const TOUCH_DEVICE_SQL = `INSERT INTO devices (device_id, first_seen, last_seen, label, ua)
  VALUES (?1, ?2, ?2, ?3, ?4)
  ON CONFLICT(device_id) DO UPDATE SET
    last_seen = MAX(devices.last_seen, excluded.last_seen),
    label = COALESCE(excluded.label, devices.label),
    ua = COALESCE(excluded.ua, devices.ua)
  RETURNING ${DEVICE_COLUMNS}`;

/** 写入并返回设备档案（合并后的完整行）。 */
export async function touchDevice(
  db: D1Database,
  input: TouchDeviceInput,
): Promise<DeviceRow> {
  if (typeof input.deviceId !== 'string' || !input.deviceId) {
    throw new TypeError('deviceId 必须是非空字符串');
  }
  const at = input.at ?? new Date().toISOString();
  const row = await db
    .prepare(TOUCH_DEVICE_SQL)
    .bind(input.deviceId, at, input.label ?? null, input.ua ?? null)
    .first<DeviceRow>();
  if (!row) throw new Error(`touch 设备后读不到行：deviceId=${input.deviceId}`);
  return row;
}

/** 读取设备档案；不存在返回 null（路由据此决定是否 404 或懒创建）。 */
export async function getDevice(
  db: D1Database,
  deviceId: string,
): Promise<DeviceRow | null> {
  return db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE device_id = ? LIMIT 1`)
    .bind(deviceId)
    .first<DeviceRow>();
}
