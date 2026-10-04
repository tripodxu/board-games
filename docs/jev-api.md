# Jev API 契约与接入

> 动 `src/core/jev/**`（客户端）、`src/worker/routes/jev.ts`（同源代理）、`src/worker/lib/upstream.ts`
> （上游调用）或任何 `serializeForJev` 之前读本文。
> 模型背景调研（性能/价格/生态）见仓库根目录之外的 `../jev_model_memory.md`
> （父目录 jev_games 的调研记忆，不随本仓库分发）。
>
> §1、§2、§2.1–§2.3、§4 描述的是**上游 Jev 提供方的契约**（与谁调用它无关，跨实现稳定）；
> §3 描述**本仓库的落地实现**（2026-10-01 迁移后：前端自带 key，Worker 只做转发与限流）。

## 1. 请求契约（官方 / OpenRouter / 同源代理同构）

```
POST {endpoint}
Authorization: Bearer <key>          # 同源代理渠道改用 X-Api-Key 头
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
- 429/529 → 指数退避重试（见 §3.1：客户端最多 4 次：1s/2s/4s/8s，**服务端不重试**）；
  401 → key 无效直接报错；30s 无响应判超时；外部 `AbortSignal`（切棋种/重开）立即终止。

## 2. 渠道（五可选 + random 基线）

端点/model 预设的单一事实源是 `src/core/jev/client.ts` 的
`export const CHANNELS: Record<string, ChannelConfig>`（`ChannelConfig = { endpoint, model, keyName }`），
UI 占位符与真实请求共用它（`presetEndpoint(channel)`）。

| channel | endpoint | model | key 放哪 | 说明 |
|---|---|---|---|---|
| `official` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | 浏览器 localStorage | **官方 API 有 CORS 来源白名单（2026-09-29 实测：仅 typesafe.ai 自有域名放行，任意第三方 Origin 一律 400 "Disallowed CORS origin"，文档未开放配置）。浏览器直连不可行，浏览器侧走官方 key 的唯一路径是同源代理** |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` | 浏览器 localStorage | 与官方同构，允许 CORS，唯一可浏览器直连的渠道（需 OpenRouter key，非 TypeSafe key）；额外发 `HTTP-Referer` 头 |
| `proxy` | 同源 `api/jev` | `jev-latest` | 请求头 `X-Api-Key` 透传（BYOK）；服务端 env `TYPESAFE_API_KEY` 仅作站长兜底 | **本仓库的 Cloudflare Worker**（`src/worker/routes/jev.ts`）：只做转发与限流，不落 key，详见 §3 |
| `rapfi` | 本地（浏览器内 WASM） | Rapfi tag 250615 | 无 | **本地搜索引擎对手**（非 prompt 型）：Gomocup 协议，首次选用懒加载约 10–40MB 模型，之后纯本地走子；仅支持 `gomoku`（大众无禁手），`gomoku-pro` 会拒绝；单线程同步搜索期间阻塞 UI 约 3s（ADR-0006）；「测试连接」= 触发懒加载 |
| `mock` | 本地 | — | 无 | `src/core/jev/mock.ts` 离线演示，概率为合成值 |
| `random` | 本地 | `random-baseline` | 无 | **纯随机基线，仅对比实验面板可选**（设置面板渠道下拉不含它）：均匀概率、零启发式、成本 0，但照样走完整战术管线——「随机+战术 vs Jev+战术」的唯一变量是概率分布质量。自由手真随机均匀采样（不经 topK，否则 topK=1 会坍缩成顺序走子） |

默认渠道（`src/core/persist.ts` 的 `loadSettings()`）：`proxy`。渠道可用性回落由
`effectiveChannelOf(settings, channel, opts?)` 决定——未填 key 时自动回落 `mock`，
保证无 key 完整体验；`rapfi` 是本地引擎，直接返回 `rapfi`（无需 key、无远程探测，
「测试连接」改为触发懒加载）。`effectiveChannelOf` 还有一个历史遗留的 `{ isFile: true }` 选项
（跳过代理渠道），但 `file://` 双击即玩已随旧实现退役，Vite 产物必须经 HTTP 提供
（本地用 `npm run dev` / `npm run preview`），见 [status.md](status.md)。

**自定义 Base URL**（2026-09-29 起；实现见 `src/core/persist.ts` 的 `stashEndpoint(channel, value)`
与 `Settings.endpoints`）：设置面板对每个真实渠道提供「接口地址」输入框，
留空 = 上表预设，填了即覆盖（`decide` 的 `opts.endpoint`，预设值经 `presetEndpoint(ch)` 取）。
语义约定：

- 自定义值按渠道各自存 localStorage（`settings.endpoints`），互不串渠道；`mock` 无此输入框。
- 端点自定义后该渠道视为**明确可用**：`effectiveChannelOf()` 不再因未填 key 回落 `mock`。
- 自定义端点**不强制 key**（自建网关可匿名）；填了 key 仍照发 `Authorization: Bearer` / `X-Api-Key`。
  预设端点行为不变（official/openrouter 无 key 直接拒绝）。
- model 名仍取渠道预设（`jev-latest` / `typesafe/jev-1.13`），不随端点变化。

### 2.1 连通性探测（probe）

设置面板「测试连接」→ `probe({ channel, apiKey, endpoint })`
（`src/core/jev/client.ts` 导出，经 `src/core/jev/index.ts` 转发），开局前定位故障，
**两段式**区分浏览器端无法分辨的错误：

| 段 | 做法 | 区分什么 |
|---|---|---|
| A | `no-cors` GET（响应不可读，只看 resolve/reject） | 网络层可达 vs DNS/服务器不可达 |
| B | 按真实契约发最小 `noul` 请求（10s 超时，`PROBE_TIMEOUT_MS`） | 鉴权 / 端点形状 / HTTP 错误 / CORS |

返回 `{ ok, kind, message, latencyMs, model?, status? }`，`kind` 判定：

| kind | 含义 |
|---|---|
| `ok` | 联通且 key 有效（附 model 名与延迟） |
| `network` | A 段即失败：网络不可达 |
| `cors` | A 可达 + B 被 TypeError：跨域拦截。官方渠道无解（上游有 CORS 来源白名单），改用 `proxy` 渠道——同源 `/api/jev` 已带 `Access-Control-Allow-*` 头，不需要再改服务端 |
| `auth` | 401/403：key 无效 |
| `http` | 其他 HTTP 错误（422/404…，附前 200 字符）：端点路径可能不对 |
| `shape` | 200 但响应缺 `answers`：地址不是 System One 同构端点 |
| `mock` / `config` | 离线演示无需连接 / 未知渠道 |

注：`rapfi` 渠道不走 probe 的 HTTP 判定，装配层（`src/app/modes.ts`）把「测试连接」
复用来触发 Rapfi 懒加载（成功/失败即引擎就绪/不可用）。

实现注意：探测体必须与正式请求同构（`state`+`model`+`questions` 三字段齐全）——
漏 `model` 会被真实端点 422 拒绝（已踩过，单测有用例钉住）。UI 直读输入框当前值，
不依赖是否已保存；探测期间按钮禁用。

### 2.2 状态增强与战术保险（Jev 强度杠杆）

Jev 是无状态概率模型，不会学习；强度来自「喂给它的状态质量」。`decide()`
（`src/core/jev/client.ts`）在发请求前统一做两层增强（对 `serializeForJev` 的产出做后处理，
六棋种通用，mock 渠道不受影响）：

1. **`state.tactics`**：用引擎自身的 `applyMove`/`getStatus` 模拟推算双方战术点——1-ply
   `{ winning_points_you: [...], winning_points_opponent: [...] }`（一步致胜点：己方 = 必走，
   对方 = 必挡；go 等无中途终局的棋种自然为空数组）+ 2-ply
   `{ chance_points_you: [...], danger_points_opponent: [...] }`（造杀点：走出后己方有 ≥2 个
   一步致胜点 = 两步必胜；对手的造杀点 = 必须现在拆）+ VCF
   `{ vcf_win_you: [...], vcf_win_opponent: [...] }`（连续冲四将死链：引擎可选提供
   `vcfWin(st, attackerId, maxPlies)` 做威胁空间搜索，7 ply/4000 节点/每层≤12 候选，
   实测 0–22ms；进攻取将死链首步，防守取链条入口干预点且**试走后复搜确认破杀**）。
   指令里同步声明这些字段的语义（英文，追加在 `questions.move.instructions` 尾部）。
   推算实现在 `src/core/tactics.ts`（`computeTactics` / `attachFacts` / `emptyTactics` /
   `countForcingReplies` / `allowsSustainedAttack` / `resolveVersion`）。
2. **`state.experience`**（可选，由 `opts.experience` 传入）：同一棋种、真实渠道的历史局中
   与当前开局前 4 手相同的那部分，统计 `{ opening_plies, games, first_player_win_rate }`。
   样本 <2 局不注入（噪声）；离线演示局从不参与（合成数据不自证）。

**战术保险（客户端十四级接管）**：解析概率后按序执行，`meta.tactics = win | block | open4 |
threat | vcfAttack | vctAttack | vcfDefense | vctDefense | pressureGate | live3Attack | live3Defense | parry | parry3 | parry4 | null`——① `win` 有致胜点必走其一；
② `block` 否则有对方致胜点必挡其一；③ `open4` 否则引擎以 `criteria` 保留标签 `you:open4`
声明的活四点必走（活四 + 对方无先手五 = 理论必胜：两处成五点防不胜防）；④ `threat` 否则抢占
2-ply 造杀点（`chance_points_you`：走出后己方有 ≥2 个一步致胜点，带护栏）；⑤ `vcfAttack`
否则走己方 VCF 将死链首步（连续冲四强制胜，排 threat 后因双杀两步更快、parry 前因将死是强制胜）；
⑥ `vctAttack` 否则走己方 **VCT 连续威胁链**首步（`vct_win_you`：冲四链 + **活三逼迫**的混合强制链，
`VCT_PLIES = 9` = 5 手攻方着法）——与 ⑤ 同级、紧随其后，因为纯冲四看不见的杀正是 v10 的漏法
（v10 臂 12 局复算：7-ply 纯冲四 22 手、11-ply 也只多 2 手，而 VCT 42 手，其中 20 手分布在 7 局）；
⑦ `vcfDefense` 否则占对方将死链入口（干预点经试走复搜确认真破杀；对方多条链并存时不硬挡，
回落 parry）；⑧ `vctDefense` 否则拆对方的**混合链**（`vct_win_opponent`：先算对方的链 ——
有 VCF(7) 用它、否则 VCT(9) —— 再按「链上各点 → 链点车氏 ≤2 邻域 → 全部邻近空点」试走，
判据是**落子后对方既无 VCF(7) 也无 VCT(9)**；上限 12 个候选点）——它排在 ⑦ 之后，因为
`vcfDefense` 一旦找到拆点就不必再花这一层（实测开火率 ≤11%；v12 对 `rapfi@500ms` 那一轮
198 个回合里 42 个防守机会全被既有层拆掉、**这一层 0 次开火**，抬高思考档后两轮各命中 1 次：
1 s 轮给了点但没走、2 s 轮实走就是它且链被拆掉，三轮真救仍为 0）；⑨ `pressureGate` 否则**削对手的做四点**
（`pressure_cut_points`：**只在对手做四手数 > 我方**（`pressure_you` / `pressure_opponent`）且我方没有
2 手杀（`danger_points_opponent` 为空）时才算/才走）——引擎 1-ply 试走，候选序是「模型候选点 →
对手做四点车氏 ≤2 邻域（近者先）→ 其余邻近空点」（上限 120 个），判据是**落子后对手做四手数严格下降**，
并列取己方做四手数更大者；它排在 `vctDefense` 之后、`live3Attack` 之前，因为它要拦的正是「抢活三」
那一步（六轮 1787 个回合里 205 手 `live3Attack`，其中 39 手落子前对手压力已领先，削点让 37/39 更优、
双四威胁 37 → 7）；⑩ `live3Attack` 否则抢己方
**活三制造点**（`live3_you`：走出后己方**新造** ≥2 个
活四制造点，对手只能挡一个；「新造」这一条是 v14 `v14-live3-fresh` 补上的——旧口径只要「盘面上存在 ≥2 个」
就把任何闲棋都算成制造活三，实测 67.9% 是幻影点）；⑪ `live3Defense` 否则走 `live3_deny_points`
（拆掉对方全部活三制造点的那一手，同样按新造口径算）；⑩⑪ 两级都是**真推演**（跳活三、斜线组合、带空隙的四
一律认得出），且**只在对方没有 2 手杀（`danger_points_opponent` 为空）时才动**——对方有更短的剑时
抢剑会输速度，这两级让位给后面的 `parry` / `vcfDefense`；⑫ `parry` 否则拆 2-ply 杀点（`danger_points_opponent`），**多个并存时按 3-ply
安全性排序**——先排除「堵完对手仍有双杀制造点」的坏点（给了对手持续攻击节奏），剩余按对手逼杀
着法数取最少；⑬ `parry3` 否则抢占 `criteria` 里带 `deny:open4/deny:live3` 标签的点
（对手的活三/活四制造点；只认连续 `_XXX_` 形状，跳活三由 ⑩⑪ 的真推演兜住）；⑭ `parry4` 否则抢占带 `deny:four` 标签的点（对手的冲四制造点，
Rapfi 实战复盘增补：放任冲四制造点会被连续单杀逼迫 → 双杀收尾）。战术点在概率榜内按概率加权抽
（尊重 topK），榜外（候选预筛遗漏）直接执行该点并在 `meta.warning` 标注「战术保险接管」。
机制沿革与依据见 [ADR-0014](adr/0014-live3-real-lookahead.md)（活三真推演）、
[ADR-0015](adr/0015-vct-continuous-threats.md)（连续威胁搜索）与
[ADR-0016](adr/0016-vct-defense.md)（连续威胁防守）。
概率只是偏好，事实优先。深度换时间的边界写死在实现里（外层 64 候选、逼杀着法只查前 8 个、
逼杀数数到 10 即停、VCF 7 ply/4000 节点、VCT 9 ply/3000 节点/每层 10 个攻击方着法/守方应手 >6 就不当作逼迫手、VCT 防守最多试 12 个候选点）。
**边界声明**：VCF 只搜「连续冲四」强制链；VCT 在冲四之外只加**活三逼迫**（每层新造 ≥2 个活四
制造点的手），仍不是完整 VCT/估值（不做双威胁层——24 局实测真双威胁 0 次）；
Rapfi 实战 0-4 复盘见 [status.md](status.md)「已知限制」。

**五子棋 criteria 战术标签**（引擎代读棋盘，`labelPoint` 真实推演非模式匹配）：
`you:open4 / you:four / you:live3`（我落这造什么）、`deny:open4 / deny:four / deny:live3`
（挡对方想占的点）、`block:five`、`win`，组合 `+` 连接（如 `you:open4+deny:open4` 双料点）；
静点为 `null` 不耗 token。活三判定沿方向精确扫描（连续三子 + 两边界空 + 延伸成活四），
**不用窗口扫描**——窗口里无关方向的既成活四会误标（已踩过：F5 的对角窗口扫到 8 行的活四点）。

实现细节：推算按 state 身份 WeakMap 缓存；早期局面直接跳过；引擎对模拟着法的任何拒绝都降级为空战术。
**`moveFromNotation(st, n)` 是双参契约**（漏传 st 会在 gomoku 上炸 parseN，已踩过）。

实测：黑四连局面注入 tactics 后，真实 Jev 把 G8/L8 两致胜点概率打到 0.91/0.09（合计≈1.0），
模型确实读懂并使用了注入事实；保险层 `meta.tactics='win'` 确认无接管必要。

### 2.3 五子棋提示词工程（2026-09-29）

四板斧（全部落在 `src/core/engines/gomoku.ts` 的 `serializeForJev`）：

1. **`state.board_ascii`**：裁剪到有子区域外扩 2 格的字符画棋盘（列字母表头 + 行号，X/O=黑白子，
   小写=last_move，空盘裁到天元 5×5）。模型读二维字符画远比读坐标列表准。棋子坐标列表保留作交叉核对
   （成本可忽略）。裁剪/图例/末手标记有契约断言。
2. **刚性扫描清单**：move 指令不再写「多制造威胁」式空话，改为五步机械扫描（己方成五点 → 对方成五点 →
   己方活三活四 → 对方活三 → 多威胁点择优），要求「按顺序执行、逐格核对」。
3. **analysis 文本问不被支持**：实测同 payload 不带 text 问 200、带上 400 `api_usage_error`（单变量
   对照）。API 契约只有 choice/noul/score。**且并行结构下 analysis 也不会反哺 move**（各问独立评估，
   串联推理链被规则禁止）——「先写分析再选题」只能折叠进 move 指令，已按此实现。
4. **防幻觉核对**：凡声称成五/成四必须逐格报出整条线，核对不过即弃用该候选——压「看出不存在的威胁」。

真实 API 验证：四连局面 G8/L8 = 0.87/0.11（保险 win）；中盘局面给出围绕战场的合理概率分布。

另观察：上游会**阵发性误报 401**（key 有效却 authentication_error，成阵持续数十秒到几分钟），
已把 401 文案改为提示「key 无误时可能是瞬时故障，稍后重试」。401 仍不自动重试（避免坏 key 空转）。

## 3. 本仓库的实现（BYOK：Worker 转发，不存访客 key）

**职责分工（2026-10-01 迁移后）**：

| 层 | 文件 | 职责 |
|---|---|---|
| 客户端 | `src/core/jev/client.ts` | 渠道解析、加鉴权头、30s 超时 + 外部 `AbortSignal` 合并、429/529 指数退避（最多 4 次）、战术注入与十四级保险、top-k 采样、成本统计。**key 只在这里从 localStorage 读出来放进请求头，不发给任何本站服务端之外的第三方** |
| 客户端出口 | `src/core/jev/index.ts` | 装配 `decide`（注入 mock 实现）并转发 `probe` / `presetEndpoint` / `CHANNELS` |
| Worker 路由 | `src/worker/routes/jev.ts` | `POST /api/jev`：限流（`jev` 桶 30/分/IP，D1 固定窗口）→ 校验 → 转发 → 原样透传上游响应；另注册 `OPTIONS /` 预检（在限流**之前**，不占桶、不耗上游额度） |
| Worker 上游层 | `src/worker/lib/upstream.ts` | 上游调用细节：请求体白名单（只取 `state`/`model`/`questions`，`model` 缺省 `jev-latest`）、超时、错误映射、`toPassthroughResponse`（不读 body，流式透传） |

Worker 侧的关键事实：

- **key 取值序**：请求头 `X-Api-Key` > `env.TYPESAFE_API_KEY`（站长兜底）> 请求体 `apiKey`，
  三处都 `trim()`（顺手修掉「粘贴带换行导致 401」）。取值来源只记 `keySource`（`'header'|'env'|'body'`）。
- **key 永不入日志、永不入 URL**：成功日志 `[jev] status=… requestId=… keySource=… ms=…`，
  失败日志 `[jev] upstream failed requestId=… kind=… error=… keySource=… ms=…`，
  都不含 key 值也不含请求体（请求体里有局面）。key 只出现在 `Authorization` / `X-Api-Key`
  **请求头**里，从不进 query string，所以拿到访问日志也读不出 key。
- **缺 key → 401**，文案 `未提供 API Key：请在页面「Jev 设置」中填写你自己的 TypeSafe key`，
  错误体统一 `{error, code:'unauthorized', requestId}`。
- **请求体不是合法 JSON → 400 `bad_request`**（旧实现是 422；422 现在专留给「格式对但内容不合法」
  的 `invalid_payload`）。前端只按 `resp.ok` 分流，不受影响。
- **上游非 2xx 原样透传**状态码与响应体（额外转发 `Retry-After`）；上游不可达/超时 → **502**
  `upstream_error`；客户端自己 abort（切棋种/重开）→ 非标准 **499**（用真 `Response` 返回，
  与真 502 区分）。
- **429/529 由客户端退避，服务端不重试**——服务端重试会把一次用户点击变成 N 次上游计费（BYOK）。
- **CORS 只在本路由**：回显 `Origin` + `Vary: Origin`、`Access-Control-Allow-Headers: Content-Type, X-Api-Key, X-Jev-Provider`、
  `Access-Control-Expose-Headers: X-Jev-Provider, X-Jev-Provider-Switch`、`Max-Age: 86400`，
  **不回显 `Access-Control-Allow-Credentials`**（BYOK 不依赖 Cookie，开了只会放大风险面）。
  注意成功响应是路由自己拼的 `Response`（§3.2）：Hono 的 `c.header()` 预备头在「直接返回 `fetch()` 响应」
  这条路径上会被丢掉。
- 错误码与 HTTP 状态的映射集中在 `src/worker/lib/http.ts` 的 `statusFor()`。

**上游响应里没有的东西**：429/529 的重试、退避节奏、超时都在客户端；Worker 不缓存、不排队。

### 3.1 客户端重试与超时（`src/core/jev/client.ts`）

- `REQUEST_TIMEOUT_MS = 30000`（决策请求）、`PROBE_TIMEOUT_MS = 10000`（探测）。
- 网络错误（无 HTTP 状态）：重试，最多 4 次尝试，间隔 `800 * (attempt + 1)` ms；
  提示语按渠道区分（同源代理不可达 / 浏览器直连受 CORS 限制）。
- 429 / 529：指数退避 `1000 * 2^attempt` ms（1s/2s/4s/8s），并回调 `opts.onRetry(status, attempt)`。
- 401：直接抛「API Key 无效或缺失（401）」，不重试。
- 其它状态码：直接抛 `API 错误 <status>：<前 300 字符响应体>`。
- `opts.signal`（切棋种/重开）在每次尝试前与请求期间都检查，abort 即中止。

### 3.2 上游兜底提供方与两个响应头（C2）

BYOK 的 key 失效、额度用尽或官方网关抖动时，上面那条链路会整局停摆。C2 起有一张**提供方表**
（`src/core/jev/providers.ts`，纯叶模块、无 import）：

| id | 端点 | 模型 | key 来源 |
|---|---|---|---|
| `primary` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | 客户端 BYOK / `TYPESAFE_API_KEY` |
| `backup` | `https://api.commandcode.ai/provider/v1/systemone` | `typesafe/jev` | Worker 的 `COMMANDCODE_API_KEY`（实验面是 `/root/.cc-key`） |

两家网关**协议同形**（C1 探针逐字段比对过），所以切换就是「基址 + 模型 + key」三元组直换，没有适配器层。

**失败分类与切换条件**（`classifyStatus`）：401/402/403 ⇒ `auth`（立刻切）；429/529 ⇒ `rate-limit`
（**本家用尽**才切）；5xx ⇒ `server`（连续 3 次才切，`SERVER_FAILURE_LIMIT`）；其它 4xx ⇒ `client`（不切，
换一家只会把同一个错换个文案）；网络错/超时**不切**（连不上不代表对面也连不上，且重试还在手上）。
切换前先对备用的 `/provider/v1/models` 做一次**探活**（`PROBE_TIMEOUT_MS = 10000`，200 才算通过）——
探活不过就**不切**，把主家的原始响应照原样交给调用方。切过去之后**局内粘滞**（同一局不再回切），
避免一局被切碎成两半。

**两个响应头**（只在 `/api/jev` 的 POST 成功响应上，且不改变既有响应体）：

- `X-Jev-Provider: primary|backup` —— 这一次请求**最后是谁答的**（客户端把它写进逐手
  `meta.provider` → 归档 `ai.prov`；`random` 渠道不会出现这个头）。
- `X-Jev-Provider-Switch: <from>-><to>; <urlencoded reason>` —— 只有发生切换时才带。
  **值必须是 latin-1 可编码**，中文原因要 `encodeURIComponent`；客户端 `decodeSwitchReason()` 解得开就用、
  解不开就照原样显示。切换的耗时/探活状态只在 Worker 日志里（`[jev] … provider=… switch=… upstreamCalls=…`）。

**开关口径**：Worker 侧 `vars.JEV_FAILOVER`（默认 `"off"`）+ `wrangler secret put COMMANDCODE_API_KEY`。
**两者缺一就不带兜底**——默认部署与 C2 之前逐字同行为；客户端显式带 `X-Jev-Provider: backup` 时才只用兜底。
`Access-Control-Allow-Headers` 已放行该请求头，`Access-Control-Expose-Headers` 已放行上面两个响应头
（否则跨源调用读不到它们）。浏览器直连面（`official` 渠道）走 `callWithFailover`，判据相同，
差别是它的「用尽」由重试阶梯数出来，而 Worker 面每请求独立 ⇒ 429/529 一次就算用尽。

**降级语义**（D8）：探不到本站后端（例如纯静态托管 `dist/`）时，
`src/core/api/client.ts` 的每个方法返回 `null` 而不抛——对局、悔棋、导出功能不受影响，
只是数据不跨设备（回落 localStorage 战绩簿）。迁移后**不再保证 `file://` 双击即玩**：
Vite 产物是 ES module + 绝对路径，本地预览用 `npm run preview`。

**旧实现（2026-10-01 前）**：三套服务端（`server.js` 零依赖 Node + `functions/api/*.js`
Pages Functions + `dev-proxy.py` 最小代理）共用同一 URL 契约；限流是 Pages Function 的
isolate 内存 Map（多实例各算各的，等于没限）；`/api/stats` 靠 GitHub API 拉 raw 且有
50 子请求预算截断。全部已由 Worker + D1 取代（ADR-0010 / ADR-0013），细节见
[plans/2026-10-01-workers-d1-rebuild.md](plans/2026-10-01-workers-d1-rebuild.md) §2。

## 4. 成本模型

- 官方定价：**输入 $42/百万 token，输出免费**（OpenRouter `typesafe/jev-1.13` 同价）。
- `decide()` 内按 `usage.input_tokens * 42 / 1e9` 累计 `costUsd`
  （`src/core/jev/client.ts` 一行）。
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
| `tacticsVersion` | 本次决策用的战术档 id（`src/core/tactics-versions.ts` 的 `resolveVersion()`） |
| `provider` | 这一手**最后是谁答的**（`primary` / `backup` / `custom` / `random`；见 §3.2）。归档写进逐手 `ai.prov`，局级汇总在 `meta.providers` |
| `probSource` | `exact` = 响应给了逐点概率；`derived` = 没给（例如只回了 `choice`），此时概率是按候选等权推出来的，**不许当模型概率用**。归档写进逐手 `ai.probs`，局级汇总在 `meta.probSources` |
| `warning` | 非法响应回退等异常提示 |
| `mock: true` | 离线演示标记（面板需显示"演示"角标） |

## 6. 采样（随机度）

`opts.topK`：1 = argmax 最强手；k>1 = 前 k 名概率加权随机（`src/core/weighted.ts` 的 `weightedPick`）。
机机对弈必须 k>1，否则同一 seed 每盘完全一样。滑杆在 UI「Jev 设置」里。

**例外——`random` 基线渠道**：自由手均匀采样，与 topK 无关（topK=1 会把均匀概率坍缩成
「取第一顺位」，退化成顺序走子，已踩过）；战术接管不受影响，该堵的杀照堵。

**可复现性**：`src/core/rng.ts` 的 `setSeed(seed)` / `getSeed()` / `rand(n)` / `rnd()`
支持种子（mulberry32），只影响 mock/演示与测试链路；
真实渠道的 top-k 采样走 `weightedPick`（不经 rand），保持真随机。
金样 `test/fixtures/golden/*.json` 由 `seed=42` 的 mock 自对弈生成，随机流一字节不同就会全部对不上。
**注意**：旧的 URL `?seed=42` 入口已随旧实现（`js/**`）删除，浏览器侧现在没有种子入口，
`setSeed()` 只由测试代码调用（见 [AGENTS.md](../AGENTS.md) §5）。
