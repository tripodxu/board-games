# Jev API 契约与接入

> 动 `js/jev-client.js`、`functions/api/jev.js`、`dev-proxy.py` 或任何
> `serializeForJev` 之前读本文。模型背景调研（性能/价格/生态）见仓库根目录之外的
> `../jev_model_memory.md`（父目录 jev_games 的调研记忆，不随本仓库分发）。

## 1. 请求契约（官方 / OpenRouter / 代理同构）

```
POST {endpoint}
Authorization: Bearer <key>          # 代理渠道改用 X-Api-Key 头
Content-Type: application/json

body: {
  state:     <string | JSON | string[]>,   // 局面描述，本项目一律用 JSON + 英文坐标记法
  model:     "jev-latest" | "typesafe/jev-1.13",
  questions: {
    <key>: { type: "choice"|"noul"|"score", instructions, criteria, options? }
  }
}

resp: {
  model:   "...",
  answers: {
    move:     { value: "H8", probabilities: {H8: 0.42, ...}, confidence: 0.81 },
    edge:     { value: true, noul: 0.72 },
    position: { value: 7, score: 6.8 }
  },
  usage: { input_tokens: 812, output_tokens: 0 }
}
```

- 三种原语：**Noul**（是/否概率）、**Choice**（≤255 选项，返回全选项概率分布+置信度）、
  **Score**（有序量表连续分）。本项目固定三问并行：`move`/`edge`/`position`。
- 上下文窗口 32K token：state 超限必须预筛/摘要，不能截断了事。
- 429/529 → 指数退避重试（`jev-client.js` 最多 4 次：1s/2s/4s/8s）；401 → key 无效直接报错；
  30s 无响应判超时；外部 `AbortSignal`（切棋种/重开）立即终止。

## 2. 四个渠道

| channel | endpoint | model | key 放哪 | 说明 |
|---|---|---|---|---|
| `official` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | 浏览器 localStorage | **官方 API 有 CORS 来源白名单（2026-09-29 实测：仅 typesafe.ai 自有域名放行，任意第三方 Origin 一律 400 "Disallowed CORS origin"，文档未开放配置）。浏览器直连不可行，浏览器侧走官方 key 的唯一路径是同源代理** |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` | 浏览器 localStorage | 与官方同构，允许 CORS，唯一可浏览器直连的渠道（需 OpenRouter key，非 TypeSafe key） |
| `proxy` | 同源 `api/jev` | `jev-latest` | 请求头 `X-Api-Key` 透传（BYOK）；服务端 env `TYPESAFE_API_KEY` 仅作站长兜底 | CF Pages Function 或 `dev-proxy.py`；**Pages 侧有每 IP 每分钟滑动窗口限流（默认 30，`RATE_LIMIT_PER_MIN` 可配），超限 429** |
| `mock` | 本地 | — | 无 | `js/mock-ai.js` 离线演示，概率为合成值 |

默认渠道（`app.js` settings）：`proxy`。`effectiveChannel()` 在未填 key 时自动回落 `mock`，
保证无 key 完整体验。

**自定义 Base URL**（2026-09-29 起）：设置面板对每个真实渠道提供「接口地址」输入框，
留空 = 上表预设，填了即覆盖（`decide` 的 `opts.endpoint`，预设值经 `BG.jev.presetEndpoint(ch)` 取）。
语义约定：

- 自定义值按渠道各自存 localStorage（`settings.endpoints`），互不串渠道；`mock` 无此输入框。
- 端点自定义后该渠道视为**明确可用**：`effectiveChannel()` 不再因未填 key 回落 `mock`。
- 自定义端点**不强制 key**（自建网关可匿名）；填了 key 仍照发 `Authorization: Bearer` / `X-Api-Key`。
  预设端点行为不变（official/openrouter 无 key 直接拒绝）。
- model 名仍取渠道预设（`jev-latest` / `typesafe/jev-1.13`），不随端点变化。

### 2.1 连通性探测（probe）

设置面板「测试连接」→ `BG.jev.probe({ channel, apiKey, endpoint })`，开局前定位故障，
**两段式**区分浏览器端无法分辨的错误：

| 段 | 做法 | 区分什么 |
|---|---|---|
| A | `no-cors` GET（响应不可读，只看 resolve/reject） | 网络层可达 vs DNS/服务器不可达 |
| B | 按真实契约发最小 `noul` 请求（10s 超时） | 鉴权 / 端点形状 / HTTP 错误 / CORS |

返回 `{ ok, kind, message, latencyMs, model?, status? }`，`kind` 判定：

| kind | 含义 |
|---|---|
| `ok` | 联通且 key 有效（附 model 名与延迟） |
| `network` | A 段即失败：网络不可达（代理渠道先启动 dev-proxy.py） |
| `cors` | A 可达 + B 被 TypeError：跨域拦截，改用同源代理或服务端加 CORS 头 |
| `auth` | 401/403：key 无效 |
| `http` | 其他 HTTP 错误（422/404…，附前 200 字符）：端点路径可能不对 |
| `shape` | 200 但响应缺 `answers`：地址不是 System One 同构端点 |
| `mock` / `config` | 离线演示无需连接 / 未知渠道 |

实现注意：探测体必须与正式请求同构（`state`+`model`+`questions` 三字段齐全）——
漏 `model` 会被真实端点 422 拒绝（已踩过，单测有用例④钉住）。UI 直读输入框当前值，
不依赖是否已保存；探测期间按钮禁用。

## 3. 两个代理实现（BYOK，服务端不存 key）

- **`functions/api/jev.js`**（Cloudflare Pages Functions）：仅做 CORS 转发，
  key 来自访客请求头；未提供 → 401 中文提示。部署到 CF Pages 后自动获得 `/api/jev`。
- **`dev-proxy.py`**（本地）：静态托管 + `/api/jev` 转发，持久 TLS 连接
  （实测每手省 ~0.45s 握手），标准库零依赖。
  `set TYPESAFE_API_KEY=ts-xxxx`（可选，本机兜底）。

## 4. 成本模型

- 官方定价：**输入 $42/百万 token，输出免费**（OpenRouter `typesafe/jev-1.13` 同价）。
- `jev-client.decide()` 内按 `usage.input_tokens * 42 / 1e9` 累计 `costUsd`。
- 实测单步 state 约 0.5–1.5K token ≈ **$0.00005/步**，一整局 < $0.05。
- 面板显示的 token/成本累计即来自该公式；改公式必须同步本文档与 README「成本参考」。

## 5. decide() 返回的 meta（决策面板消费）

| 字段 | 含义 |
|---|---|
| `channel` / `model` | 实际渠道与模型 |
| `latencyMs` | 端到端耗时（含重试） |
| `usage` / `costUsd` | token 与美元成本 |
| `confidence` | Jev 给出的置信度（null 表示未返回） |
| `top[]` | 概率前 8 名 `{notation, p}`（概率条渲染） |
| `candidates` | 合法候选总数；`restProb` 第 9 名以后概率合计 |
| `noul` / `score` | 局势优劣概率 / 0–10 局势分 |
| `warning` | 非法响应回退等异常提示 |
| `mock: true` | 离线演示标记（面板需显示"演示"角标） |

## 6. 采样（随机度）

`opts.topK`：1 = argmax 最强手；k>1 = 前 k 名概率加权随机（`BG.util.weightedPick`）。
机机对弈必须 k>1，否则同一 seed 每盘完全一样。滑杆在 UI「Jev 设置」里。

**可复现性**：`BG.util.rand/rnd` 支持种子（`?seed=42` 或 Node 侧 `BG.setSeed(42)`），
仅影响 mock/演示与测试链路；真实渠道的 top-k 采样走 `weightedPick`（不经 rand），保持真随机。
