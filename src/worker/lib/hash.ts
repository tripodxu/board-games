/**
 * 路由层的哈希工具。
 *
 * `db/games.ts` 内部有一份等价的 sha1（生成缺省 dedup_key），但它刻意不导出：
 * 路由需要的是「与导入脚本逐字节一致」的那套算法，所以口径写在
 * `shared/record-map.ts` 的 `gameUidSource`/`dedupSource` 里，这里只负责摘要。
 */

/** SHA-1 十六进制小写；输入按 UTF-8 编码（与 `node:crypto` 的 `update(str)` 默认行为一致）。 */
export async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 旧客户端不带 gameUid 时的服务端合成口径（§5.4）：`sha1(exported|notation)` 取前 16 位。 */
export async function synthGameUid(source: string): Promise<string> {
  return (await sha1Hex(source)).slice(0, 16);
}
