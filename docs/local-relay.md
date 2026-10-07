# 本地中转脚本 local-relay.mjs — 用你自己的 IP 跑 OpenCode 免费档

## 解决什么

OpenCode Zen 的免费模型 `jev-1.13-free` 有两个硬约束（2026-10-07 实测）：

1. **不发 CORS 头** ⇒ 网页（https）无法直连，请求必须经中转；
2. **免费限流按请求方 IP 计**（key 只做鉴权、不换配额池）⇒ 经云端 Worker 中转时，所有访客共享
   Worker 的出口 IP 池，配额被场外流量耗尽（实测 6/6 全 429）。

本脚本跑在**你自己的电脑**上、只监听 `127.0.0.1`：站点把请求发到你的本机中转，再由你的本机
发往 OpenCode——**请求从你的 IP 发出，限流池你独占**（匿名都稳定；填自己的 key 再加一层私有配额）。

## 三步使用

1. **装 Node ≥ 18**（[nodejs.org](https://nodejs.org)，装过可跳过）；
2. **下载并运行中转**：[scripts/local-relay.mjs](https://github.com/tripodxu/board-games/raw/main/scripts/local-relay.mjs)
   （右键另存为 `local-relay.mjs`），然后在终端跑 `node local-relay.mjs`——看到
   「OpenCode 本地中转已启动」即成功（保持窗口开着，Ctrl+C 停止）；
3. **站点设置**：「Jev 设置」→ 接入渠道选 **「OpenCode · 本地中转（你的 IP · 最稳）」** →
   （可选）把你的 OpenCode Key 填进「OpenCode Key」框 → 点「测试连接」应显示联通 → 开局。

## 兼容性

| 浏览器 | 行为 |
| --- | --- |
| Chrome / Edge | 最佳。首次使用可能弹「允许访问本地网络」授权，允许一次即可 |
| Firefox | 访问 127.0.0.1 时弹本机网络授权，允许即可 |
| Safari | 对公网页面 → 本机的请求限制最严，可能不可用（用 Chrome/Edge） |

技术细节：脚本对预检（OPTIONS）应答 `Access-Control-Allow-Private-Network: true`（Chrome 的
PNA 要求）；`https` 页面 → `http://127.0.0.1` 属「潜在可信源」，不触发混合内容拦截。

## 安全说明

- **固定上游**：只转发到 `https://opencode.ai/zen/v1/systemone`，且只接受
  `model = jev-1.13-free`——不是开放代理，不能被用来转发任意流量；
- **只绑 127.0.0.1**：局域网内其他设备访问不到；
- **不落日志**：key 与对局内容不打印、不写盘；
- **无依赖**：纯 Node 标准库，代码 130 行可通读。

## 已知边界

- 中转窗口开着才能用（关掉 = 渠道不可达，站点会提示「本地中转不可达」并自动退避）；
- 端口占用：`node local-relay.mjs --port 8421` 换端口后，需在站点「接口地址 Base URL」里
  同步填 `http://127.0.0.1:8421/api/jev`；
- 上游错误（如 OpenCode 侧故障）原样透传显示。
