# MEMORY.md — 项目记忆

> **约定：新条目一律追加在最上面（倒序），最新在最顶。** 一条一事，写事实与结论，
> 不写客套；带日期的条目格式 `## YYYY-MM-DD · 标题`。
> 本文件是项目级持久记忆（入库、工具无关）。各 agent 工具自己的记忆/指针
> （如 `.workbuddy/MEMORY.md`）只允许指向本文件，不得成为事实源。
> 沉淀规则见 [README.md](../README.md)「维护规则」。

---

## 2026-09-29 · 部署改为 git 自动集成（推送即部署）

- **jev-qiguan 项目已连 GitHub（tripodxu/board-games）：push 到 main 即自动部署**，
  构建命令留空、构建输出目录 = 仓库根目录 `/`，`functions/` 由 Pages 自动识别，无需任何配置。
  即「改完 → node test/run-tests.js 全绿 → commit → push」就是完整发布流程。
- wrangler 直传流程（更新 `.work/deploy-staging` + `wrangler pages deploy`）降级为备用手段，
  仅在 git 集成失效时救急（见下方「部署上线」条目）。
- 验证部署是否生效：`curl -s https://jev-qiguan.pages.dev/ | grep <新特性标记>`
  （本次用「测试连接」），或 `npx wrangler pages deployment list --project-name=jev-qiguan`。

## 2026-09-29 · 侧栏折叠一屏化（UI 打磨轮）

- 用户痛点：右侧分析栏 9 个面板全展开约 2 屏。方案：**驾驶舱常开 + 7 个面板可折叠 + 状态持久化**
  （`jev_qiguan_panels_v1`），密度同步收紧（side gap 16→10、panel padding 16/18→12/15、
  趋势图 viewBox H 196→158、空态块 34→14px）。1920×1000（≈真实浏览器 chrome 后的 1080p）
  下全部分析面板一屏可见；棋谱/设置两个低频抽屉贴边是有意取舍——再挤破坏间距节奏。
- **默认态要有内容**：首访全折叠（第一版截图验证时抓到）会让首屏没有任何分析内容，改为默认展开
  「Jev 判断」，localStorage 有存储则完全尊重用户。存储区分「从未存过」与「显式清空」靠 raw===null。
- **折叠期间 display:none 的面板，图表量宽为 0**：展开时必须补渲染（FOLD_HOOKS → 各 render* 全量
  重建函数，恰好都是无状态重建，直接调用即可）。iframe wrapper 真实点击折叠钮验证了这条路径。
- 折叠时标题行里指向面板内部的实体控件（曲线切换、清空）一并隐藏；note/计数保留作「瞥视」。
  折叠钮是自绘 SVG chevron（craft-floor 禁 Unicode 字形当图标），展开动效 0.18s transform/opacity
  且尊重 prefers-reduced-motion（不违反「动效收敛为落子」的既定取舍——一次性状态过渡非装饰循环）。
- 验收：截图三视口（1920×1080 / 全展开 3450 / 1366×768）+ impeccable detect **零新增违规**
  （仅存量 4 项：渐变误报、11px 例外×2、promoBox 例外）+ 全量测试/DOM 台/文档检查全绿。

## 2026-09-29 · 部署上线（Jev 接入轮之四）

- **https://jev-qiguan.pages.dev** 已上线（CF Pages 项目 `jev-qiguan`，账户 xd04040212@163.com，
  production branch=main，直传部署非 git 集成）。线上验证三连：静态页 200；`/api/jev` 无 key → 401 中文提示；
  带 key → 真实响应 `jev-1.13.0`（noul 0.73，279 token）。
- **重部署流程**（直传模式下文档即部署脚本）：更新 `.work/deploy-staging/`（只含 index.html、
  package.json、README.md、LICENSE、css/、js/、functions/，排除 .git/.work/docs/test 等）→
  `npx wrangler pages deploy .work/deploy-staging --project-name=jev-qiguan --branch=main --commit-dirty=true`。
  staging 目录在 .work（不入库），改动站点文件后必须重拷再部署。
- 访客「只填 key」已可用（BYOK）；要「打开即玩」需在 CF 控制台给项目设环境变量
  `TYPESAFE_API_KEY`（Pages 项目环境变量仅 dash 可设，wrangler 无对应命令），花费走站长账户。

## 2026-09-29 · CORS 白名单实测定论 + file:// 自动落演示（Jev 接入轮之三）

- 用户诉求「只提交 apikey 就能用，不要自行跑代理」。实测给出硬结论：官方 API 带 **CORS 来源
  白名单**——`OPTIONS` 预检带 `Origin: https://console.typesafe.ai` 放行（回显 ACAO），
  `example.com` 与 `null`（file://）一律 400 "Disallowed CORS origin"；官方文档无配置入口。
  **结论：浏览器只填 key 直连官方在任何第三方站点都不可行，同源转发无法省略**——这不是实现选择，
  是服务端白名单 + 浏览器同源策略的双重约束。
- 体验修顺（代码侧能做的都做了）：`effectiveChannel()` 在 `file://` 下 proxy 渠道自动落演示
  （此前双击打开默认 proxy 渠道，第一手棋必报 Failed to fetch——用户实际撞到的就是这个，不是
  官方 API 的 CORS）；proxy 渠道网络错误提示改为「本地 dev-proxy / 线上部署」双向指引；
  渠道 hint 更新为白名单实测结论；「填 key 即玩」的正解收敛为：**部署一次 CF Pages
  （`npx wrangler pages deploy .`），访客填 key 即玩；设 `TYPESAFE_API_KEY` 环境变量则打开即玩**。
- probe 的 cors 判定文案同步改准确（「官方有来源白名单」而非泛泛的「加 CORS 头」——后者用户做不了）。

## 2026-09-29 · 连通性探测「测试连接」（Jev 接入轮之二）

- 用户实测撞上「Failed to fetch（若为浏览器跨域受限…）」后才开局失败，要求开局前能先探测。
  新增 `BG.jev.probe()`（两段式）：A 段 `no-cors` GET 只判「网络层可达」；B 段按真实契约发最小
  `noul` 请求。fetch 层 CORS 拦截与断网同为 TypeError，靠 A 段结果区分——这是浏览器端唯一能做的分诊。
- **mock 单测抓不到请求体形状，真实端点会**：首版 probe 漏发 `model` 字段，单测全绿，真实端点
  422 拒绝（`body.model required`）。教训：凡「按契约构造请求」的代码，单测必须断言请求体本身
  （已补：state/model/questions 三字段齐全）。probe 体必须与正式请求同构。
- 实测矩阵（用户提供的真 key，env 传入未入库）：官方直连 probe ok（`jev-1.13.0`，~1.9s）——
  **官方端点真实可达**，浏览器直连的 Failed to fetch 就是 CORS；假 key → 401 判 auth；
  dev-proxy 代理渠道 probe ok + 真实 `decide()` 走子 H8（447ms，$0.000024）全链路通；
  不存在域名 → network（~11s，两段各 10s 超时叠加，感知偏慢可接受）。
- probe 的 kind：ok/network/cors/auth/http/shape/mock/config，判定表在 jev-api.md §2.1。

## 2026-09-29 · 自定义 Base URL（Jev 接入开放化）

- 用户痛点：三个真实渠道的 endpoint 全部硬编码在 `jev-client.js`，自建/兼容网关接不进来。
  改为「渠道 = 预设 + 可覆盖」：设置面板每个真实渠道都有「接口地址」输入框，placeholder 即预设，
  留空用预设；自定义值按渠道分别存 localStorage（`settings.endpoints`）。客户端新增
  `BG.jev.presetEndpoint(ch)` 与 `decide` 的 `opts.endpoint`。
- 语义决策：**端点自定义 ⇒ 渠道明确可用**——`effectiveChannel()` 不再因未填 key 回落 mock，
  客户端也不强制 key（自建网关可匿名）；有 key 照发 Bearer / X-Api-Key。预设端点行为一概不变
  （official/openrouter 无 key 仍拒绝），旧用例零改动全过。
- 陷阱：渠道切换时输入框里还是旧渠道的地址。`saveSettings` 若按「select 当前值」归档，会把旧端点
  复制到新渠道名下——归档（`stashEndpoint(prev)`）必须发生在改写 `S.settings.channel` **之前**。
- model 名不随端点走：仍取渠道预设。要换模型是另一个需求，别顺手混进来。
- 新增回归（run-tests.js 用例④）：自定义端点覆盖预设 + 匿名放行 + 预设端点不受影响 + presetEndpoint 出口。

## 2026-09-29 · 前端打磨（迭代 04·前端轮）

- 方向由 `impeccable` 技能流程定：用户选**「精修 + 更有张力」**——保留月白/玄墨/朱砂体系与全部
  内容交互，不换视觉世界，只加大对比与编排。`craft-floor` 的 Verify/Refuse 两节作为底线。
- **Phase 0 先量再改是本轮有效的原因**。全部结论先变成数字：`--ink-mute` 在四档底色上只有
  3.32~3.74:1（全档未达 4.5:1，而它承载 22 处 9~10.5px 小字）；控件边界 1.51:1（未达
  WCAG 1.4.11 的 3:1）；22 处字号 <11px。凭感觉只会写成「看起来有点淡」，无法验收。
- **选择器与 HTML 不匹配的静默失效**：`.feed { max-height; overflow-y }` 整条规则从未生效，
  因为容器是 `<div id="feed">` 而 CSS 写的是 `.feed`。表现是侧栏随对局无限长——**看不出是 bug，
  只会觉得「布局有点怪」**。同类死代码还有 `.stats`/`.stat`、`.engine-panel.live` + `seal-breathe`。
- **自己引入的违规要自己抓**：上一轮（校准实验室）我加了 `.cal-hero { border-left: 3px }`，
  本轮被 craft-floor 拒绝项点名。改为底色 + 数值配色承担层级。
- **detect 必须改完再跑**（技能要求），它因此抓到了计划外的三件事：`--zhu-hi` 上白字仅
  3.87:1（渐变端点上的文字，Phase 0 的前景/背景配对扫描扫不到）；5 处 `transition: width/height`
  逐帧重排；「发丝线 + 宽投影」模板化签名 3 处。
- **教训：渐变上的文字自动检查盯不住**。detect 报 `#ffffff on #ffffff 1.0:1` 是它解析不了
  `linear-gradient()` 的误报，但逐处人工核算后发现**它同时漏报了真问题**（3.87:1 那处）。
  结论：渐变端点要么人工核算并写注释，要么别把文字放在渐变上。
- **减法也是张力**：删掉两处无限循环装饰动画（`pulse` / `seal-breathe`），把唯一保留的编排
  时刻定为「落子」——曲线一次性描线 + 末点单次外扩，两者共用同一 `--ease`，读起来是一个动作。
  描线进度用 `pathLength="1"` 归一化，不必猜路径长度。
- 残留 3 项有意例外（含 detect 的 1 项误报）已写入 `docs/status.md`「设计例外」。
- 详见 [../plans/2026-09-29-iteration-04-frontend-polish.md](../plans/2026-09-29-iteration-04-frontend-polish.md)。

## 2026-09-29 · 校准实验室（迭代 03·创意轮）

- 新增 `js/calibration.js`（纯函数、零 DOM、Node 可加载）：把 Jev 逐手的胜率预测与对局真实
  胜负放同一把尺子上量。指标 `brier` / `skill` / `ece` / `mce` / `overconfidence` + 可靠性分箱图。
- **主动放弃了一个"看起来更权威"的公式**：Murphy 的 `BS = REL − RES + UNC` 三分式。
  推导时用完美预测 `p=y∈{0,1}` 代入即证伪（公式给 0.25、真值 0）——该恒等式在「分箱内预测值
  非常数」时不成立，需要额外的箱内方差修正项才严格。**不发布自己证明不了的分解**，
  改用「定义即真值」的 brier + 技巧分 + ECE。
- 技巧分定义 `1 − brier/(p̄(1−p̄))`：分母是「恒定猜真实基准率」这一参考预报的 brier，
  因此恒定义良好（`p̄∈{0,1}` 退化时返回 `null` 而非 Infinity/NaN，面板显示「—」）。
- **本特性真正的洞察（夹具实测，非文案）**：恒猜 0.5 的预测器 `ece` 也是 0（从不说谎），
  但 `skill` 是 0；校准良好的预测器 `ece` 同为 0 而 `skill` 0.5。**ece 单独使用会骗人**，
  所以面板把技巧分与校准误差并排给出。夹具 A/B 在 `js/calibration.js` selfTest 里。
- 数据取舍：**离线演示的合成概率不写入 `cal`**（`saveGameRecord` 过滤 `meta.mock`），
  拿合成数据算校准等于自欺；**和棋不入样本**（二元事件无真值，记 0.5 会同时污染 brier 与 ece）。
- 诚实性约束写进实现：同一局内各手共享同一真值 `y`，样本按「局」强相关，
  有效样本量接近局数而非手数——面板同时显示「N 局 / M 手」并明写此 caveat。
- 验证：11 个变异（skill 取倒数/ECE 漏乘权重/过度自信反向/真值方向反/和棋未剔除/p=1 越界…）
  **全部被夹具捕获**；一次性 DOM 台端到端 21 项全过，含「真跑一局离线演示后 cal 仍为空」。
- 教训沉淀：写夹具时要**先想「什么变异会逃逸」**——最初夹具全在「单箱或零偏差」情形下，
  `ECE 漏乘 n_k/N` 这个变异能悄悄通过，补了夹具 F（两箱、样本量不等、都错）才杀掉它。
- 详见 [../plans/2026-09-29-iteration-03-calibration-lab.md](../plans/2026-09-29-iteration-03-calibration-lab.md)。

## 2026-09-29 · 悔棋回路修复（迭代 02·优化轮）

- 修掉两个确证缺陷（走查 + 最小 DOM 桩红/绿验证，非猜测）：
  ① **悔棋后 AI 回合永不续弈**——`undo()` 没有任何 `setTimeout(aiStep, …)`；当被作废的那次
    决策恰好在途（epoch++ 后其结果被丢弃）时没有任何新调度，对局永久卡死，而界面仍显示
    「等待 Jev」。② **终局后悔棋状态条残留「终局 · … 获胜」**——`finishGame` 写过状态条并隐藏过
    暂停/单步，`undo()` 从不复位。
- 顺带清掉两处开销：决策流改**增量插入**（此前每手 `innerHTML=''` 重建最多 40 张卡，
  cc 一局 138 手 ≈ 5.5k 张卡 / 5 万+ DOM 节点，O(n²)）；`history` 去掉 `prev` 全量 state 快照，
  改**只存记法、悔棋按记法重放**（`applyMove` 纯函数，快照从不被改；`prev` 全仓库只有悔棋一处读它）。
- 关键决策：还原路径依赖「记法往返」这一既有硬契约（engine-interface.md §2），因此在
  `test/run-tests.js` 的 `playOut` 里加了**整盘记法重放等价断言**——一次覆盖 gomoku/cc/go。
  已用变异实验证明该断言有鉴别力（篡改 `moveFromNotation` → 立刻发散），不是永真断言。
- 反思/遗留：① **`app.js` 的 UI 行为至今无自动化回归护栏**，`run-tests.js` 只覆盖引擎与
  Jev 客户端；本轮靠一次性 DOM 桩验证（不入库）。后续若要长期护栏，值得把它做成正式测试。
  ② 发现一个**未修的既存不一致**（下轮候选）：`effectiveChannel()` 只对 official/openrouter
  在无 key 时回落 mock，**proxy 无 key 仍返回 proxy** → 纯静态托管（无 functions/）且未填 key 时
  会收到 401，而不是 README 承诺的「自动进入离线演示模式」。
- 计划与验证证据：[../plans/2026-09-29-iteration-02-play-loop.md](../plans/2026-09-29-iteration-02-play-loop.md)。

## 2026-09-28 · 仓库硬化完成（已合并 main 并推送，CI 首次全绿）

- 新增：LICENSE(MIT) / .gitattributes / .editorconfig / package.json（零依赖，npm test 即验收）/ CI / CHANGELOG / scripts/check-docs.mjs；gh 仓库元数据（description + 8 topics）。
- 硬化：Pages Function 每 IP 每分钟滑动窗口限流（默认 30，`RATE_LIMIT_PER_MIN` 非法值回退 30——防 'abc'→NaN 静默失效与 ''→0 全量锁死）；jev-client 与 Pages Function 单测（429 重试/401 即抛/非法着法回退/topK 端到端回归/401/422/限流/上游转发）；mock 种子化（?seed=42）。
- 验收：npm test + npm run check:docs 双绿；CI 三步 success（[run 36451454165](https://github.com/tripodxu/board-games/actions/runs/36451454165)）；最终整体审查 Ready to merge: Yes。
- 执行方式：subagent-driven-development——每任务 fresh subagent 实现 + 规范审查 + 质量审查双阶段，共 24 个 commit；三处审查发现的问题（topK 哨兵惰性、限流配置 fail-open、复现断言摘要相撞盲区）均由变异实验实证后修复。
- 已知后续（Minor，不阻塞）：① 限流配置容错的回退路径（'abc'/'0'/'-5'）无直接单测护栏（当前仅测 limit='2'）；② docs/jev-api.md「同一 seed 每盘完全一样」措辞待澄清——mock 不经 weightedPick、真实渠道不经 seed，两者都不受 ?seed 影响。
- 详见 docs/superpowers/plans/2026-09-28-board-games-hardening.md。

## 2026-09-28 · mock 种子化落地

- `BG.setSeed/rng`（mulberry32，逐字抄 jev-piano rng-shim）+ `BG.util.rnd()`；`?seed=42` 复现演示。
- 替换点共 10 处（mock-ai 3 + 六引擎 7）；`weightedPick` 不经 `rand`，真实渠道自动不受影响——这是无需拆代码路径的天然隔离点。
- 集成测试改为同 seed 两次 playOut 断言一致（全棋谱比对，防摘要相撞漏报）；`BG_FAST` 现由 run-tests.js 默认设置（`BG_SLOW=1` 可覆盖）。

## 2026-09-28 · 仓库硬化：限流/CI/种子化（见 docs/superpowers/plans/2026-09-28-board-games-hardening.md）

- Pages Function 加每 IP 每分钟滑动窗口限流（默认 30，范本逐字抄 jev-piano/src/worker.js:6-19）；429 文案用中文与 401 保持一致。
- 更正一个此前的误判：`jev-client.js:127` 的 `opts.topK | 0 || 1` 解析为 `(opts.topK|0)||1`，行为正确（2→2、4→4），**不是 bug**；已加回归测试防止被误改成 `topK|1`（那才会强制奇数）。
- `decide()` 的 warning 文案由「已随机回退」改为「已回退到首个合法着法」——回退目标是 `legal[0]`，确定性。
- mock 链路种子化（?seed=42）：只动 `BG.util.rand` + 10 处 `Math.random`→`BG.util.rnd()`；`weightedPick`（真实渠道 top-k 采样）不经过 rand，自动保持真随机。

## 2026-09-28 · 文档体系重建 + 仓库初始化并推送远端

- 远端：`git@github.com:tripodxu/board-games.git`（SSH，账号 tripodxu，已验证可用）。
- 建立规范：`AGENTS.md`（agent 入口）+ `docs/`（status/architecture/engine-interface/jev-api/
  adr×4/agents×6/plans）+ `docs/memory/MEMORY.md`（本文件，最新在上）。
- `.gitignore` 重点：`__pycache__/`（本机已存在，切勿提交）、`.workbuddy/`、`.claude/`、
  `.zcode/`、`.work/`、密钥类（`.env`/`.dev.vars`，只提交 `.example`）。
- 多 agent 协同设计：六引擎文件互为天然并行边界；`app.js`/`jev-client.js`/`test/run-tests.js`
  是热点公共文件，默认归编排者；接力用 `.work/handoff.md`（不入库）+ memory 置顶沉淀。
- 本地指针文件 `.workbuddy/MEMORY.md`（gitignore）指向本文件，供本机 agent 快速定位。

## 2026-09-28 · MVP 完成度与验收口径

- 六引擎全部完成并通过 selfTest：象棋开局 44 着法 + 照面/绝杀/困毙；国际象棋
  perft(1/2/3) = 20/400/8902 + 易位/吃过路兵/升变；西洋跳棋开局 7 着法、强制连跳、
  升王即停；围棋提子/禁自杀/劫/双停数子（贴 5.5）；中国跳棋连跳链与营地规则；
  五子棋候选预筛 ≤64。
- 集成测试：mock 渠道 gomoku/cc/go 三盘机机完整对局终局（`BG_FAST=1` 跳过模拟延迟）。
- 唯一验收命令：`node test/run-tests.js`；浏览器侧 `index.html?test=1`。

## 2026-09-27 · Jev 接入的关键结论（选型记忆）

- Choice 选项上限 255 → 围棋只做 9 路（13 路需预筛策略，见 status.md 路线图）。
- 官方 API 浏览器直连会被 CORS 拦 → 必须保留同源代理渠道（BYOK 转发，ADR-0003）；
  OpenRouter 直连最稳。
- 中文精度较低 → state/instructions 一律英文坐标记法（ADR-0002）。
- 成本：输入 $42/百万 token，输出免费；单步 0.5–1.5K token ≈ $0.00005，一局 < $0.05。
- Jev 确定性输出会导致机机对弈每盘一样 → top-k 加权采样是机机模式必备。
- 深度调研原文在仓库外：`../jev_model_memory.md`（父目录 jev_games，不随本仓库走）。

## 2026-09-28 · 实现期踩坑记录

- `dev-proxy.py` 用持久 TLS 连接转发，实测每手省 ~0.45s 握手开销。
- `app.js` 用 `epoch` 计数器丢弃过期异步回调（切棋种/重开时旧 Jev 结果必须作废）——
  改 AI 调度逻辑时这是最容易被破坏的不变量。
- 加载顺序是硬编码两份：`index.html` script 标签 + `test/run-tests.js` 清单；
  新增 JS 文件两处都要加，漏一处 = 自检 silently 少测一个引擎。
- `BG.util.clone` 是 JSON 深拷贝 → 引擎 state 里禁止放函数/undefined/DOM 引用。
