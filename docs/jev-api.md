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

## 2. 渠道（五可选 + random 基线）

| channel | endpoint | model | key 放哪 | 说明 |
|---|---|---|---|---|
| `official` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | 浏览器 localStorage | **官方 API 有 CORS 来源白名单（2026-09-29 实测：仅 typesafe.ai 自有域名放行，任意第三方 Origin 一律 400 "Disallowed CORS origin"，文档未开放配置）。浏览器直连不可行，浏览器侧走官方 key 的唯一路径是同源代理** |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` | 浏览器 localStorage | 与官方同构，允许 CORS，唯一可浏览器直连的渠道（需 OpenRouter key，非 TypeSafe key） |
| `proxy` | 同源 `api/jev` | `jev-latest` | 请求头 `X-Api-Key` 透传（BYOK）；服务端 env `TYPESAFE_API_KEY` 仅作站长兜底 | CF Pages Function 或 `dev-proxy.py`；**Pages 侧有每 IP 每分钟滑动窗口限流（默认 30，`RATE_LIMIT_PER_MIN` 可配），超限 429** |
| `rapfi` | 本地（浏览器内 WASM） | Rapfi tag 250615 | 无 | **本地搜索引擎对手**（非 prompt 型）：Gomocup 协议，首次选用懒加载约 10–40MB 模型，之后纯本地走子；仅支持 `gomoku`（大众无禁手），`gomoku-pro` 会拒绝；单线程同步搜索期间阻塞 UI 约 3s（ADR-0006）；「测试连接」= 触发懒加载 |
| `mock` | 本地 | — | 无 | `js/mock-ai.js` 离线演示，概率为合成值 |
| `random` | 本地 | `random-baseline` | 无 | **纯随机基线，仅对比实验面板可选**（设置面板渠道下拉不含它）：均匀概率、零启发式、成本 0，但照样走完整战术管线——「随机+战术 vs Jev+战术」的唯一变量是概率分布质量。自由手真随机均匀采样（不经 topK，否则 topK=1 会坍缩成顺序走子） |

默认渠道（`app.js` settings）：`proxy`。`effectiveChannel()` 在未填 key 时自动回落 `mock`，
保证无 key 完整体验；`rapfi` 是本地引擎，直接返回 `rapfi`（无需 key、无远程探测，
「测试连接」改为触发懒加载）。

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

注：`rapfi` 渠道不走 probe 的 HTTP 判定，`app.js` 把「测试连接」复用来触发
`BG.rapfi.ensureLoaded()` 懒加载（成功/失败即引擎就绪/不可用）。

实现注意：探测体必须与正式请求同构（`state`+`model`+`questions` 三字段齐全）——
漏 `model` 会被真实端点 422 拒绝（已踩过，单测有用例④钉住）。UI 直读输入框当前值，
不依赖是否已保存；探测期间按钮禁用。

### 2.2 状态增强与战术保险（Jev 强度杠杆）

Jev 是无状态概率模型，不会学习；强度来自「喂给它的状态质量」。`decide()` 在发请求前
统一做两层增强（对 `serializeForJev` 的产出做后处理，六棋种通用，mock 渠道不受影响）：

1. **`state.tactics`**：用引擎自身的 `applyMove`/`getStatus` 模拟推算双方战术点——1-ply
   `{ winning_points_you: [...], winning_points_opponent: [...] }`（一步致胜点：己方 = 必走，
   对方 = 必挡；go 等无中途终局的棋种自然为空数组）+ 2-ply
   `{ chance_points_you: [...], danger_points_opponent: [...] }`（造杀点：走出后己方有 ≥2 个
   一步致胜点 = 两步必胜；对手的造杀点 = 必须现在拆）+ VCF
   `{ vcf_win_you: [...], vcf_win_opponent: [...] }`（连续冲四将死链：引擎可选提供
   `vcfWin(st, attackerId, maxPlies)` 做威胁空间搜索，7 ply/4000 节点/每层≤12 候选，
   实测 0–22ms；进攻取将死链首步，防守取链条入口干预点且**试走后复搜确认破杀**）。
   指令里同步声明这些字段的语义（英文，追加在 `questions.move.instructions` 尾部）。
2. **`state.experience`**（可选，由 `opts.experience` 传入）：同一棋种、真实渠道的历史局中
   与当前开局前 4 手相同的那部分，统计 `{ opening_plies, games, first_player_win_rate }`。
   样本 <2 局不注入（噪声）；离线演示局从不参与（合成数据不自证）。

**战术保险（客户端九级接管）**：解析概率后按序执行，`meta.tactics = win | block | open4 |
threat | vcfAttack | vcfDefense | parry | parry3 | parry4 | null`——① `win` 有致胜点必走其一；
② `block` 否则有对方致胜点必挡其一；③ `open4` 否则引擎以 `criteria` 保留标签 `you:open4`
声明的活四点必走（活四 + 对方无先手五 = 理论必胜：两处成五点防不胜防）；④ `threat` 否则抢占
2-ply 造杀点（`chance_points_you`：走出后己方有 ≥2 个一步致胜点，带护栏）；⑤ `vcfAttack`
否则走己方 VCF 将死链首步（连续冲四强制胜，排 threat 后因双杀两步更快、parry 前因将死是强制胜）；
⑥ `vcfDefense` 否则占对方将死链入口（干预点经试走复搜确认真破杀；对方多条链并存时不硬挡，
回落 parry）；⑦ `parry` 否则拆 2-ply 杀点（`danger_points_opponent`），**多个并存时按 3-ply
安全性排序**——先排除「堵完对手仍有双杀制造点」的坏点（给了对手持续攻击节奏），剩余按对手逼杀
着法数取最少；⑧ `parry3` 否则抢占 `criteria` 里带 `deny:open4/deny:live3` 标签的点
（对手的活三/活四制造点）；⑨ `parry4` 否则抢占带 `deny:four` 标签的点（对手的冲四制造点，
Rapfi 实战复盘增补：放任冲四制造点会被连续单杀逼迫 → 双杀收尾）。战术点在概率榜内按概率加权抽
（尊重 topK），榜外（候选预筛遗漏）直接执行该点并在 `meta.warning` 标注「战术保险接管」。
概率只是偏好，事实优先。深度换时间的边界写死在实现里（外层 64 候选、逼杀着法只查前 8 个、
逼杀数数到 10 即停、VCF 7 ply/4000 节点）。
**边界声明**：VCF 只搜「连续冲四」强制链，不是完整 VCT/估值；Rapfi 实战 0-4 复盘见
status.md「已知限制」第 1 条。

**五子棋 criteria 战术标签**（引擎代读棋盘，`labelPoint` 真实推演非模式匹配）：
`you:open4 / you:four / you:live3`（我落这造什么）、`deny:open4 / deny:four / deny:live3`
（挡对方想占的点）、`block:five`、`win`，组合 `+` 连接（如 `you:open4+deny:open4` 双料点）；
静点为 `null` 不耗 token。活三判定沿方向精确扫描（连续三子 + 两边界空 + 延伸成活四），
**不用窗口扫描**——窗口里无关方向的既成活四会误标（已踩过：F5 的对角窗口扫到 8 行的活四点）。

实现细节：推算按 state 身份 WeakMap 缓存；`moveNum < 4` 的早期局面直接跳过；
引擎对模拟着法的任何拒绝都降级为空战术。**`moveFromNotation(st, n)` 是双参契约**
（漏传 st 会在 gomoku 上炸 parseN，已踩过）。

实测：黑四连局面注入 tactics 后，真实 Jev 把 G8/L8 两致胜点概率打到 0.91/0.09（合计≈1.0），
模型确实读懂并使用了注入事实；保险层 `meta.tactics='win'` 确认无接管必要。

### 2.3 五子棋提示词工程（2026-09-29）

四板斧（全部落在 `gomoku.js` 的 `serializeForJev`）：

1. **`state.board_ascii`**：裁剪到有子区域外扩 2 格的字符画棋盘（列字母表头 + 行号，X/O=黑白子，
   小写=last_move，空盘裁到天元 5×5）。模型读二维字符画远比读坐标列表准。棋子坐标列表保留作交叉核对
   （成本可忽略）。裁剪/图例/末手标记有契约断言。
2. **刚性扫描清单**：move 指令不再写「多制造威胁」式空话，改为五步机械扫描（己方成五点 → 对方成五点 →
   己方活三活四 → 对方活三 → 多威胁点择优），要求「按顺序执行、逐格核对」。
3. **analysis 文本问不被支持**：实测同 payload 不带 text 问 200、带上 400 `api_usage_error`（单变量
   对照）。API 契约只有 choice/noul/score。**且并行结构下 analysis 也不会反哺 move**（各问独立评估，
   串联推理链被 ADR/规则 6 禁止）——「先写分析再选题」只能折叠进 move 指令，已按此实现。
4. **防幻觉核对**：凡声称成五/成四必须逐格报出整条线，核对不过即弃用该候选——压「看出不存在的威胁」。

真实 API 验证：四连局面 G8/L8 = 0.87/0.11（保险 win）；中盘局面给出围绕战场的合理概率分布。

另观察：上游会**阵发性误报 401**（key 有效却 authentication_error，成阵持续数十秒到几分钟），
已把 401 文案改为提示「key 无误时可能是瞬时故障，稍后重试」。401 仍不自动重试（避免坏 key 空转）。

## 3. 服务端实现（BYOK，服务端不存访客 key）

三套实现共用同一套 URL 契约，前端无感切换（详见 ADR-0005）：

- **`server.js`**（零依赖 Node，`node server.js`，默认 8788）：本地/自托管的完整后端。
  静态托管 + `POST /api/jev`（TypeSafe 代理，30s 超时）+ `POST/GET /api/games`
  （棋谱落盘 `games/<日期>/`，`flag:'wx'` 原子写幂等，文件名规则与 Pages 端一致）+
  `POST/GET /api/experiments`（归档 `data/experiments.json`，按 tag upsert）+
  `GET /api/stats`（跨对局聚合，`cal.records` 按局给 key=gid|着法串）+
  `GET /api/health`。限流：jev 60 次/分、其余 120 次/分（每 IP 滑动窗口）。
  契约测试见 `test/server-tests.js`（18 项，随 `node test/run-tests.js` 全量跑）。
- **`functions/api/jev.js`**（Cloudflare Pages Functions）：仅做 CORS 转发，
  key 来自访客请求头；未提供 → 401 中文提示。部署到 CF Pages 后自动获得 `/api/jev`。
- **`functions/api/health.js` / `experiments.js` / `stats.js`**（2026-09-29 补齐，
  与 server.js 契约对齐的三端点）：`/api/health` 探活（不发上游请求，`github`
  字段表示 token 配没配）；`/api/experiments` 实验战报归档（读写仓库
  `data/experiments.json`，按 tag upsert，提交信息 `exp: <tag> [skip ci]`）；
  `/api/stats` 跨对局聚合（1 次 git trees + ≤40 份 raw 拉取 + 1 次 contents，
  合计 ≤42 个子请求，守免费版 50 上限；截断时 `truncated: true`）。
  三者共用 `functions/api/_github.js`（下划线前缀不对应路由的共享模块）。
- **`functions/api/games.js`**（Cloudflare Pages Functions）：终局棋谱同步。
  POST 收 `jev-qiguan-game/v1` payload → 用 `GAMES_GITHUB_TOKEN`（fine-grained PAT，
  仓库 Contents 读写）经 GitHub API commit 进 `games/<日期>/`，提交信息带 `[skip ci]`
  （不触发 Pages 构建）；GET 列最近 7 天棋谱。未配置 token → 500，客户端静默失败。
- **`dev-proxy.py`**（本地，最小备用）：静态托管 + `/api/jev` 转发，持久 TLS 连接
  （实测每手省 ~0.45s 握手），标准库零依赖。
  `set TYPESAFE_API_KEY=ts-xxxx`（可选，本机兜底）。

**降级语义**：`/api/health` 不存在时（file:// 双击打开、纯静态托管），
前端 `BG.api` 全部方法返回 null，`app.js` 回落到 localStorage 与本机记录——
对局、悔棋、导出功能不受任何影响，只是数据不跨设备。
注意 CF Pages 的 SPA 兜底：未匹配的 `/api/*` 会返回 index.html + 200，
`BG.api` 的 JSON 解析因此抛错并被 catch 成 null，降级行为不变（已实测）。

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
| `tactics` | 战术保险标记：`win`（走致胜点）/ `block`（挡对方致胜）/ `open4`（走己方活四点）/ `threat`（抢占造杀点）/ `vcfAttack`（走己方将死链首步）/ `vcfDefense`（破对方将死链）/ `parry`（拆对手造杀点，含 3-ply 安全排序）/ `parry3`（预挡对手活三/活四制造点）/ `parry4`（预挡对手冲四制造点）/ `null` |
| `warning` | 非法响应回退等异常提示 |
| `mock: true` | 离线演示标记（面板需显示"演示"角标） |

## 6. 采样（随机度）

`opts.topK`：1 = argmax 最强手；k>1 = 前 k 名概率加权随机（`BG.util.weightedPick`）。
机机对弈必须 k>1，否则同一 seed 每盘完全一样。滑杆在 UI「Jev 设置」里。

**例外——`random` 基线渠道**：自由手均匀采样，与 topK 无关（topK=1 会把均匀概率坍缩成
「取第一顺位」，退化成顺序走子，已踩过）；战术接管不受影响，该堵的杀照堵。

**可复现性**：`BG.util.rand/rnd` 支持种子（`?seed=42` 或 Node 侧 `BG.setSeed(42)`），
仅影响 mock/演示与测试链路；真实渠道的 top-k 采样走 `weightedPick`（不经 rand），保持真随机。
