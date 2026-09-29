# MEMORY.md — 项目记忆

> **约定：新条目一律追加在最上面（倒序），最新在最顶。** 一条一事，写事实与结论，
> 不写客套；带日期的条目格式 `## YYYY-MM-DD · 标题`。
> 本文件是项目级持久记忆（入库、工具无关）。各 agent 工具自己的记忆/指针
> （如 `.workbuddy/MEMORY.md`）只允许指向本文件，不得成为事实源。
> 沉淀规则见 [README.md](../README.md)「维护规则」。

---

## 2026-09-29 · 实战败局复盘（jev-gomoku-202609290843.json）：parry3 预挡层

- 用户导出的真实败局（白 Jev 负，黑 H6-I7-J8-K9-L10 对角五连）。逐点复盘确认：保险层全程正常
  （p14/16/18/22/24 五次 parry、p26 block 全部正确），败因是**第 20 手 danger 为空的自由手走了
  闲着 E6**——黑 F8 已埋 E7 活三点（win-in-3），白 H10 后 E7 升级为开放四点被强制拆，黑 J8 枢纽
  成双杀（p24 danger = K7,K9,G11 三个独立造杀点）→ 数学上已死。
- 关键认知：**2-ply 保险保证 win-in-2 以内不犯错；这局输在 win-in-3（对手活三制造点）的先手权**。
  E7 在 p20 只是 deny:live3 标签（引擎早算出来了），但保险层没有对应动作，模型也没优先选它。
- 修复：第四级接管 parry3——win/block/open4/threat/parry 全无时，抢占 criteria 里带
  deny:open4/deny:live3 标签的点（对手的活三/活四制造点），让「对手造不成活三」成为机械保证。
  代价：Jev 会偏防守（进攻层优先级都在前面，有 2 步杀仍先走杀）；回归用例 ⑨d 钉住本局 p20
  （mock 偏向 E6 仍被接管到 E7/H10）。
- 复盘方法沉淀：导出 JSON → replay 逐点打印各级战术列表（本次发现 p24 danger 有 3 个独立点
  = 已死的机械标志；p20 danger 空 = 自由手才是败因）。「danger 列表 ≥2 个独立点」可作为
  已死判定，后续可做成局面评估的一部分。

## 2026-09-29 · 战术保险扩展到 2-ply：造杀/拆杀点（threat/parry）

- 用户实战复盘（白 Jev 输）：第 24 手前黑已有 F7,F8,F9 开放三连，1-ply 双方无致胜点（旧保险不触发），
  Jev 走 E8 未堵 F6/F10；黑 F10 成四后白 F6 只堵一端，黑 F11 获胜。
- 复盘发现第 24 手白已输定：黑有两个独立杀招——F 三连，与 E8 暗藏的双杀
  （黑走 E8 → 对角四连 E8,F9,G10,H11 + 横四 D8,E8,F8,G8,H8，致胜点 D7/D8/I12 三个），白只能堵其一。
  教训：单一威胁局面必须当场拆掉，不能等威胁成双。
- 实现（jev-client.js，引擎通用；gomoku 声明 `deepTactics: true` 开启）：
  `threatMakers` 找"走出后己方有 ≥2 个一步致胜点"的候选着法——己方造杀点（chance_points_you，
  两步必胜，带护栏：走出后对方不能反手有致胜点）、对方造杀点（danger_points_opponent，必须现在拆）。
  只在 1-ply 无战术时跑，外层只扫 64 候选点，内层数到 2 即停；中盘约 0.6s（node）。
- 保险优先级：win > block > open4 > threat > parry（open4 为后合入的活四层，语义是 threat 的
  精确子集，排在前因判定最严格、meta 更具体）；meta.tactics 新增 threat/parry，UI 决策卡片显示
  「保险·造杀/拆杀」；state.tactics 与 move 指令同步声明新字段语义。
- 回归测试⑨/⑨b/⑨c：干净单三连拆杀（白必走 F6/F10，mock 概率偏向 H8 仍被接管）、己方造杀、
  用户实战残局 danger 完备性（含隐蔽的 E8/I12，注释写明该局面已输定、保险救不回）。
- 局限：多重独立威胁的已输局面保险也救不回；2-ply 只看一层双杀，更深的杀法仍靠模型。
  后续价值：收集真实错局做分层回归，而不是只测一步题。

## 2026-09-29 · 五子棋提示词：斜线 few-shot 具象示例修复对角误读

- 真实 API A/B 验证（jev-1.13.0，黑对角四连 F6,G7,H8,I9、白 J10 封一端，胜点 E5，每组 3 次重复，
  纯 prompt 对比、不带 tactics 注入以隔离指令效果）：
  旧指令 P(E5)≈0.02~0.03、恒错选 H9；仅在清单里"点名四个方向"无改善（≈0.02）；
  加具体斜线示例（"F6,G7,H8,I9 对角四连→胜点是延续该斜线的 E5，不是附近的 J9/E6"）后
  P(E5)→0.76~0.81，三次全选对。
- 结论：Jev 的斜线盲不是"不知道要查斜线"，而是模式识别失败——抽象指令无效，具象 few-shot 示例有效。
  已写入 `gomoku.js` move 指令（含"双方棋子同样适用"泛化句），注释留了验证数据。
- 泛化抽查：白方 O 子对角四连 D4,E5,F6,G7（胜点 C3/H8），三次全选对 H8（P≈0.27~0.30）。
- 兜底关系不变：一步成五/被成五仍由战术保险（computeTactics）确定性接管；示例修的是模型自身读盘能力。
- `node test/run-tests.js` 全绿（含提示词断言：scan in order / cell by cell / board_ascii 关键词保留）。

## 2026-09-29 · 活三识别：criteria 战术标签 + 第三级接管

- 用户实测反馈「活三无法识别」——字符画+清单仍不够：活三/活四是**模式识别**，恰是模型最弱环。
  解法沿用已验证的路子再推一层：引擎代读棋盘，`labelPoint` 用真实推演给每个候选点打战术标签
  写进 `criteria`（API 本就为选项提供说明字段）：you:open4/four/live3、deny:*、block:five、
  组合 `+` 连接，静点 null 不耗 token。模型从「发现模式」降为「比较标签」——它擅长的。
- **第三级接管**：活四点（you:open4）+ 对方无先手五 = 理论必胜（两处成五点防不胜防），保险
  扩为三级 win → block → open4，`meta.tactics='open4'`、决策流标「保险·活四」。真实 API 实测：
  黑活三 vs 白活三局面，Jev 拿到标签后概率质量全落在 8 个战术点上，接管后走出必胜的 I8。
- **窗口扫描的坑**：活三判定最初用「窗口内是否存在延伸成活四的点」，F5 的对角窗口恰扫到 8 行
  的黑活四点（与 F5 无关）导致大面积误标 you:live3。修正为沿方向精确判定（连续三子+两边界空
  +延伸成活四）。教训：模式判定的搜索窗口必须与「该点参与该线」绑定。
- 跳三（X.XX 型）暂不识别（连续 run 判定的已知边界），笔记留待后续；冲四/跳四经
  fiveCompletions 精确覆盖不受影响。

## 2026-09-29 · 五子棋提示词四板斧（ASCII 棋盘/刚性清单/防幻觉）

- 用户给的四板斧打法全部落地在 `gomoku.js` serializeForJev：① `board_ascii` 裁剪字符棋盘
  （有子区域外扩 2 格，X/O/小写末手，空盘裁天元 5×5）——模型读字符画远比坐标列表准；
  ② move 指令改为五步刚性扫描清单（成五点→挡成五→活三活四→挡活三→多威胁择优），替代空话；
  ③ **analysis 文本问实测不被 API 支持**（同 payload 不带 200/带上 400 api_usage_error 单变量对照，
  且 API 契约只有 choice/noul/score）——且并行结构下 analysis 也不会反哺 move（串联链被规则 6 禁），
  「先分析后作答」只能折叠进 move 指令，已照做；④ 防幻觉：凡声称成五/成四必须逐格报整条线，
  核对不过即弃。
- 真实验证：四连局面 G8/L8 = 0.87/0.11（保险 win），中盘给出围绕战场的合理分布。
- **上游 401 会阵发性误报**：key 有效却连续 401 数十秒到几分钟（当天实测两轮），probe/choice
  「形状相关」是撞窗口假象——同一个 payload 十分钟后全 200。401 保持不重试，但文案改为提示
  「key 无误时可能是瞬时故障」。
- 教训：写测试断言前先看清自己造的局面——我断言「末手 K8 小写 k」，实际棋序末手是白 G5，
  棋盘输出是对的、断言是错的。

## 2026-09-29 · 规则摘要进 state（六引擎 rules 字段）

- 追查「Jev 拿到什么」时确认：对手落点一直在（双方棋子坐标 + last_move），但**规则只有 game 字段
  一行简介**，细节全靠模型预训练——而贴 5.5、强制跳吃、升王即停这类本项目口径与教科书未必一致。
- 修复：六引擎 `serializeForJev` 各加 `state.rules`（2 句英文：胜负条件 + 特殊规则/参数），
  每手随局面重发。写作纪律：**与引擎实现严格一致**，不是照搬教科书（如 chess 的 50 回合/子力不足
  判和、checkers 的升王即停都按本项目实现写）。engine-interface.md §4 硬约束新增第 6 条，
  run-tests 加契约断言（缺失或 <40 字符即红），新引擎作者躲得掉这个坑。
- 用户决策：只补规则摘要，**没加** move_history（行棋顺序）——局面完全决定状态的棋种里它是冗余信息，
  token 成本却随局数线性涨；等校准实验室有数据再评估。

## 2026-09-29 · Jev 强度：战术事实注入 + 战术保险 + 经验累计

- 用户反馈「Jev 很蠢」。根因：state 只给裸坐标，模型要从坐标列表自己算五连——空间推理正是它最弱的。
  修复不是改 prompt 措辞（概念性指令它本来就读得懂），而是**把算得清的事实算好喂进去**：
  `decide()` 统一给 `serializeForJev` 产出做后处理（六棋种通用，mock 不动）：
  ① `state.tactics`：用引擎自身 applyMove/getStatus 模拟推双方一步致胜点（翻 st.turn 扫对方着法）；
  ② `state.experience`：真实渠道历史局相同开局前 4 手的先手胜率（战绩簿新增 `notas` 字段做数据源）。
- **战术保险**：解析概率后致胜点必走/对方致胜必挡（榜内按概率加权、榜外直接执行并标 warning），
  `meta.tactics = win|block|null` 透出到决策流卡片（「保险·致胜/拦截」）。概率是偏好，事实优先。
- 实测（真实 API + 黑四连局面）：注入后 Jev 把 G8/L8 两致胜点概率打到 0.91/0.09——**模型确实
  读懂并使用了注入事实**；保险层确认 win、无接管。
- 两个坑：① `moveFromNotation(st, n)` 是双参契约，漏传 st 在 gomoku 炸 parseN（测试红了一遍才抓到）；
  ② 测试棋序要留意交替手数奇偶——7 手后轮白，黑四连要凑 8 手且白子散开不造威胁。
- 经验注入的诚实边界：样本 <2 局不给、离线演示局从不参与、和棋不计入胜率分子。变强没有走
  「改概率/改 topK」的捷径——那是伪装，注入事实 + 兜底接管才是模型能力边界内的合法手段。

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
