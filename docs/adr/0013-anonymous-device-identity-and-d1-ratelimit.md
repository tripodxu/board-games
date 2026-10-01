# ADR-0013：匿名设备身份（deviceId）与 D1 限流

- 状态：accepted（2026-10-01）
- 背景：两件事需要「谁来写的」与「写了多少」：
  1. **归属**：D1 之前实验历史只存浏览器 localStorage，换设备即丢；棋谱进仓库后
     没有任何归属维度，无法回答「我的对局/我的实验轮」（计划 §2.2 的 P-6）。
  2. **限流**：现有实现是 Worker isolate 内的 `Map` 滑动窗口
     （`functions/api/_github.js:17`、`games.js:12`）——isolate 一换、实例一多就失效，
     等于没有限流，而 `/api/jev` 是会被滥用的第三方付费转发。

## 决定

1. **匿名设备标识 `deviceId`**：前端首次运行生成 `crypto.randomUUID()`，存
   localStorage（`persist.ts`），随写请求以 `X-Device-Id` 头携带；服务端校验格式
   （UUID v4 形状）后 upsert `devices` 表并给 `games`/`experiments` 打 `device_id`。
2. **不做登录、不做会话、不做权限**：读取接口对所有人开放（数据本就公开）；
   `scope=device` 的统计以请求头里的 `deviceId` 为过滤条件。
3. **限流改 D1 固定窗口**（跨 isolate 一致）：
   ```sql
   INSERT INTO rate_limits (bucket, window_start, count) VALUES (?1, ?2, 1)
   ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
   RETURNING count;
   ```
   阈值：`jev` 30/分/IP、写接口 20/分/IP、读接口 120/分/IP；超限 429 + `Retry-After`；
   过期桶由 `ctx.waitUntil` 概率清理（1%）+ 可选每日 cron 兜底。
4. **威胁模型写清楚**：`deviceId` **可伪造**，因此：
   - 它只用于「筛选与展示」，**不构成任何授权**；
   - 不承诺隐私：写入的棋谱、实验战报本就是公开数据（此前直接 commit 进公开仓库）；
   - 不用于计费、不用于配额分配（配额按 IP 限流，不按设备）；
   - 需要强归属（私有棋谱、跨设备登录）时另开 ADR 引入账号体系。

## 后果

- 优点：零登录成本获得「只看我的」；限流真正生效且可观测（`rate_limits` 可查）；
  设备表为后续「换机接力」（导出/导入设备短码）留了位置。
- 缺点：多一个 `devices` 表与一个请求头契约；限流写入会给 D1 增加少量行
  （仅写接口与 `/api/jev` 计数，读接口不计数或采样）。
- 约束：`X-Device-Id` 缺失时写入仍必须成功（记 `device_id = NULL`，
  旧客户端与 curl 调试不被强绑）；前端任何新写接口都必须带该头。

## 考虑过但放弃

- **账号系统（邮箱/魔法链接/OAuth）**：工作量与安全面（注册、会话、找回、限流绕过）
  远超本轮价值；本项目当前是单机对弈工具而非多租户服务。
- **Cloudflare Access**：面向「保护整站」而非「区分写入者」，且会给公开站点加登录墙，
  与「打开即玩」冲突。
- **Cookie 会话**：仍需服务端会话表 + CSRF 考量，收益与 `deviceId` 相同。
- **Workers Rate Limiting binding**：全局近似、按 colo 生效、不落库不可审计；
  本轮选择可查询的 D1 计数。若日后需要严格全局配额，再评估该 binding 或 Durable Object。
- **完全不做归属（公共池）**：统计口径最简单，但直接放弃「实验历史跨设备统一」
  与「我的对局」两个明确的用户诉求。
