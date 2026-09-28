# ADR-0003：代理只做 CORS 转发的 BYOK 设计

- 状态：accepted（2026-09-28）
- 背景：TypeSafe 官方 API 不允许浏览器跨域直连（实测 CORS 拦截）；需要同源代理兜底。
  同时站长不想替访客的 token 账单买单，也不想承担存 key 的责任。

## 决定

`functions/api/jev.js`（CF Pages Function）与 `dev-proxy.py`（本地）都只做**纯转发**：
访客 key 从请求头 `X-Api-Key` 透传，服务端**不存储、不缓存**任何 key。
服务端环境变量 `TYPESAFE_API_KEY` 仅作站长自用的可选兜底（不设置则完全 BYOK）。
未提供 key → 401 + 中文提示，引导访客在页面「Jev 设置」里填自己的 key（只存其浏览器 localStorage）。

## 后果

- 优点：站长零密钥管理责任、零账单风险；部署无需配置任何环境变量；
  访客花费走自己的账户，额度可控。
- 缺点：每位访客需自备 key（未填 key 只能体验离线演示 mock 渠道）；
  代理是开放转发形态，理论上可被白嫖带宽（规模极小，暂不接受册）。
- 约束：代理实现**不得**把 key 写日志/落盘；不得接受请求体里的 key/baseUrl
  （只认请求头），防止被改成开放中继。

## 考虑过但放弃

- 站长统一配 key 服务端：账单与滥用风险归站长，且 key 有泄露面。
- 删除代理只留 OpenRouter 直连：OpenRouter 允许 CORS 确实可行，但官方渠道用户
  （已有 console.typesafe.ai key）就被排除在外；保留代理成本只有一个 37 行文件。
