# CHANGELOG

本项目可感知的变更历史。版本语义：1.0.0 起遵循语义化版本（minor 加功能、patch 修缺陷）；
0.x 期间 minor 反映功能交付，patch 反映修复。
日常记录另见 [docs/memory/MEMORY.md](docs/memory/MEMORY.md)（新条目置顶）。

## [Unreleased]

### 新增

- **归档面板分页**：首屏一页 50 份，底部「加载更多」按服务端 keyset 游标（`GET /api/games?cursor=…`）追加下一页，
  两页合并重画（新旧局并进同一个战术版本组）；翻完自动收掉按钮，取下一页失败时保留已载入的行并让按钮恢复可点。
- **实验报告的分桶对比**：累计区从「Jev 渠道 / 其他」两个桶改成按「渠道 · 战术版本 · 思考深度」分身份统计
  （局 / 胜 / 和 / 得分率 + 胜率条），**两侧同渠道时不再并成一桶**；得分率按和棋半分计算（`(胜 + 和 ÷ 2) ÷ 局`），
  重复局不计；每轮卡片另给一条 A/B 单轮得分率条。`#expReportNote` 的口径同步改为「N 轮实验 · M 局有效」。
- `npm run smoke:browser` 断言扩到 **13 项**：新增「对手也落了子（AI 走子链路）」「归档分页游标追加」
  「实验报告分桶表」「服务端战报并入」（`--offline` 下后两项让位给 2 项降级断言，同样 13 项）。

### 修复

- **服务端实验战报从来没并进报告面板**：Worker 的 `GET /api/experiments` 返回包装体 `{experiments:[…]}`，
  而装配层按「客户端已解包」判断 → 静默丢弃，生产 D1 里 6 轮实验在面板上永远只显示本机种子的 2 轮。
  现在 `src/core/api/client.ts` 的 `listExperiments()` 统一解包（兼容裸数组），`test/app/experiments-merge.spec.ts` 3 例 +
  浏览器冒烟第 12 项钉住它。
- `scripts/browser-smoke.mjs` 收尾清理临时 Chrome profile 在 Windows 上偶发 `EPERM`，
  会把一次绿跑变成「无报告的崩溃 + exit 1」；现在起手清理与收尾删除都带重试，失败只提示、不影响检查结果。

## [1.0.0] — 2026-10-01

### Worker + D1 全面重构（架构轮，ADR-0010 ～ ADR-0013）

一次性把「原生 HTML/JS + 三套后端 + GitHub 当数据库」换成
**一个 Cloudflare Worker（Static Assets + Hono API）+ D1**。计划与逐阶段执行记录见
[docs/plans/2026-10-01-workers-d1-rebuild.md](docs/plans/2026-10-01-workers-d1-rebuild.md)。

- **后端合并**：`server.js`、`functions/api/*.js`、`dev-proxy.py` 三套实现退役，统一为
  `src/worker/**`（8 条路由：health / games / stats / experiments / openings / leaderboard /
  jev / export）。本地开发只剩 `npm run dev`（Vite + Worker 插件，D1 走本地 SQLite）。
  线上入口 `https://jevqipan.logicc.top`（自定义域；`workers.dev` 未开）。
- **持久化迁 D1**：`games` / `game_moves` / `experiments` / `devices` / `rate_limits` /
  `stats_cache` 六张表 + `d1_migrations`。仓库里 54 份历史棋谱（4379 手、0.81 MB）
  经 `npm run import:archive` 一次性导入，`payload` 逐字节保真（`verify:parity` 逐局 sha1 对账
  diff = 0），此后 D1 是唯一权威，`games/` 冻结只读。
  `games.gid` 历来是**棋种 id**（54 份全是 `gomoku`），新模型引入 `game_uid` 作对局身份，
  `dedup_key = sha1(exported|gameUid|notation)` 保证重传幂等。
- **统计口径修好**：旧 `/api/stats` 受 Pages 50 子请求限制只聚合最近 40 份并返回
  `truncated`；现在全部在 SQL 侧聚合，**全量且无截断**（对账：40 份截断口径 16/16/8 vs
  全量 18/27/9）。列棋谱不再硬编码最近 7 天（keyset 游标 + `since`/`day`/`game`/`device`/`tag` 过滤）。
- **身份与限流**：匿名 `X-Device-Id`（无登录）落 `devices` 表，写路由先 `touchDevice` 满足外键；
  限流从「isolate 内存 Map」（跨实例必然失效）改为 D1 固定窗口（jev 30 / 写 20 / 读 120 每分钟）。
  每局从「一次 git commit」变成一次 `INSERT`。
- **前端迁 Vite + TypeScript**（无 UI 框架）：`src/core`（引擎/战术/会话/持久化/归档，纯逻辑）、
  `src/ui`（棋盘渲染、图表、13 个面板）、`src/app`（装配层：对局循环、渠道、实验编排）、
  `src/worker`。版本号构建期注入（`package.json` version + `git rev-parse --short HEAD`），
  归因不再靠文件名时间窗猜（那套口径会给 28 局凭空造出档位，已退役）。
- **新增能力**：棋谱回放器（`/api/games/u/<gameUid>` 永久链接 + 分享）、排行榜
  （`/api/leaderboard`）、开具体验（`/api/openings`）、JSONL 全量导出（`/api/export/games`）、
  每日维护 Cron（`17 3 * * *`：清限流表 + 写 `stats_cache` 当日汇总）、
  `/api/health` 的当日写入护栏（`today.rows` / `rowBudget`）。
- **运维**：`.github/workflows/backup.yml` 每日 `23 4 * * *` 导出 D1 快照为 artifact（保留 30 天）
  并用 `verify:backup` 校验可重建；`.github/workflows/test.yml` 跑 typecheck + build + 三层测试。
  `docs/status.md`、`docs/architecture.md` 等文档全量重写。
- **验收工具**（都可重复跑）：`npm run verify:parity`（新旧口径逐项对账）、
  `npm run smoke:live`（线上 HTTP 30 项）、`npm run smoke:browser`（真 Chrome + CDP 9 项，
  `--offline` 时 11 项，验无后端降级）、`npm test`（引擎自检 + 金样逐手差分 + 旧契约 + vitest）。
- **已知行为差异**：引擎不建模「认输」，1 局归档记「黑方获胜（认输）」而引擎判 `null`（预期，
  见 `test/parity/exceptions.json` 与 `test/engines/run.mjs` 输出）。

### 实验报告面板（战报补齐 + 同渠道 A/B 归属修正）

- **补齐实验战报归档**：`games/` 里带 `experiment` 标签的 6 轮实验，`data/experiments.json`
  只归档了 2 轮——其余 4 轮只有棋谱（其中 2 轮仅靠 `app.js` 里写死的 `EXP_SEED` 才在
  「实验报告」面板露面，另 2 轮完全不显示）。由棋谱回溯补齐 4 轮，归档 2 轮 → **6 轮**；
  `EXP_SEED` 的两条复盘 note 一并搬进归档，`EXP_SEED` 退回纯离线兜底。
  回溯时按「着法串与更早一局完全相同」自动标 `dup`（`exp-20260929105234` 的 #1=#3）。
- **修复：同渠道 A/B 的胜负全被记成 A**。`finishGame` 原来按渠道名比对判定 A/B
  （`winnerChan === EXP.chanA`），而 `Jev·v8 vs Jev·v9` 这类对照两边都是 `proxy`，
  于是任何胜负都落入 A。改为按「胜方是黑是白」+ 局号奇偶判定（`expGameNo=1` 时 A 执黑）。
- **报告卡片可读性**：显示轮级 A/B 档位联名与 **tag**（tag 是与 `games/` 棋谱互查的唯一锚，
  此前不显示）；老战报缺 `tacA/tacB` 时退到首局棋谱的档位；胜方标签取「该局胜方所执那一侧」
  的配置，同渠道 A/B 才读得出 `Jev·v9 胜` 而不是读不出胜负的 `Jev(代理)胜`。
- **修复：服务端归档丢掉档位字段**。`server.js` 与 `functions/api/experiments.js` 的 POST
  归一化只保留 `tag/date/chanA/chanB/total/games/note`，把客户端发的 `tacA/tacB/thinkA/thinkB`
  丢了 → 归档后的战报读不出跑的是哪一版。现已保留（`undefined` 省略，旧客户端形状不变）。
- **新增自检组 `experimentArchiveTests`**：每个 `experiment` 标签都必须有战报、局数一致、
  逐局 A/B 归属与棋谱结果一致、轮级 A/B 配置等于首局棋谱、`dup` 必须标出。

### 实验归因（pull 后全量盘点修正，ADR-0009 修订）

- **修复：人机/双人局被写成机机镜像局**。`duel.sideLabel/sideSlug` 一直支持 `human`
  标记（输出「我 / me」），但棋谱导出与战绩簿直接取 `effSide()`（纯渠道配置），
  于是 `mode=人机` 的局落成 `jev-v0-vs-jev-v0` / `黑 Jev·v0 vs 白 Jev·v0`，
  而这批 slug 正是「按战术版本归因」的输入。实测 3 份真棋谱受污染。
  新增 `exportSideCfg(sideId)`（按 `isAISide` 判定，人类侧补 `human:true`），
  导出与战绩簿共用；人机局现落 `me-vs-jev-v0`，双人局落 `me-vs-me`，真机机局不变。
- **新增：`gamesVerified` 与窗口局数 `games` 双口径**。版本归组只看文件名 stamp 时间窗，
  线上部署滞后时会说谎——20 份 `meta.code=0.7.0` 的棋谱（实为 v7 档）stamp 落在 v9 窗口，
  导致 `v9.games=20` 被当成「v9 战绩」。现拆为 `games`（窗口归属）+
  `gamesVerified`（每手 `ai.tv`/`meta.code` 实证）：v7 是 4/20、v9 是 26/4。
  战术沿革条两个数恒同时显示（`窗口 26 · 实证 4`），不做「相等就合并」的化简——
  v8 的窗口 3 局与实证 3 局数量相同却是两批棋。
- **新增：`DEPLOY_LAG` 台账 + `auditCode()` 归因红线**。纯函数审计「窗口归属 vs 实际
  code」，按 stamp 分流历史债与回归；`archiveAttributionTests` 对真实 `games/` 断言
  「0 条未登记错配 + 台账条数相符」。此前当前档只断言 `games >= 登记数`，这类污染抓不到
  （已验证：注入一份伪造滞后棋谱 → 自检红）。
- **新增：`endBy` 终局裁决来源**。「认输」唯一入口是人点按钮，机机实验里这属于人判；
  棋谱现落 `endBy:'human'`，战绩簿与实验报告标「人判」，不再混进引擎版本胜率。
- 修正 `js/tactics-versions.js` 过期注释（「合计应等于 games/ 全部 28 局」；实为 54）。

### Jev 强度

- **vcfWin 伪胜（soundness）修复**：攻方造四后守方被迫堵的那一手可能顺手给守方自己造出四，
  守方下一手直接成五——此时攻方后面的双杀永远兑现不了，旧引擎却判攻方必胜
  （`search()` 在双杀处直接返回胜，从不检查守方状态）。搜索新增守方反杀闸门：
  守方有即时致胜点时攻方这一手必须占掉它（活四两端 = 2 个反杀点则一步占不完，无解）。
  4 局棋谱 190 个决策点回放：伪胜 2→0，7 条有效链全部保留，耗时零增长。
  **同时撤回 ADR-0007 的「守方反击造杀属 VCT 范畴，不覆盖」论断**（ADR-0008）。
  这修正了此前把 `20260930025550` 局失利记为「VCT 范畴」的错误归因——那是 A 类实现 bug。

- **parry3 预挡层（实战败局驱动）**：导出败局复盘定位败着（第 20 手自由手未抢 E7 活三点），
  战术保险加第四级——无即时战术时抢占对手的活三/活四制造点（deny:open4/live3 标签），
  「对手造不成活三」成为机械保证；回归用例 ⑨d 钉住本局。
- **战术保险扩展到 2-ply（造杀/拆杀）**：引擎声明 `deepTactics` 后，1-ply 无战术时扫描
  「走出后己方有 ≥2 个一步致胜点」的造杀点（chance_points_you，护栏：对方不能反手成五）与
  对方造杀点（danger_points_opponent，必须现在拆）；保险优先级 win > block > open4 > threat > parry，
  决策卡片标「保险·造杀/拆杀」。源自用户实战复盘：开放三连不拆、双杀成形即败。
- **五子棋 criteria 战术标签 + 第三级接管**：引擎真实推演给每个候选点打战术标签（you:open4/four/live3、
  deny:*、block:five，组合 + 连接），模型从「发现模式」降为「比较标签」；活四点 + 对方无先手五
  = 理论必胜，战术保险扩为三级接管（决策流标「保险·活四」）。真实 API 实测走出必胜的 I8。
- **五子棋提示词四板斧**：`state.board_ascii` 裁剪字符棋盘（模型读字符画远比坐标列表准）、
  move 指令改为五步刚性扫描清单、防幻觉逐格核对；analysis 文本问实测不被 API 支持（400），
  按 fallback 折叠进指令。真实 API 验证：四连局面致胜点概率 0.87/0.11。
- **规则摘要进 state**：六引擎 `state.rules` 每手携带 2 句英文规则摘要（胜负条件 + 本项目口径的
  特殊规则/参数），契约测试断言必填。
- **战术事实注入 + 战术保险**：客户端推算双方「一步致胜点」注入局面（`state.tactics`），
  指令同步声明语义；解析概率后致胜必走、对方致胜必挡（决策流标注「保险·致胜/拦截」）。
  真实 API 实测：注入后模型把致胜点概率打到 0.91/0.09。
- **对局经验累计**：真实渠道对局的棋谱写入战绩簿，相同开局前 4 手的历史先手胜率注入后续对局
  （`state.experience`）；样本 <2 局不注入，离线演示局从不参与。

### 前端

- **棋谱一键导出**：棋谱面板「导出」按钮下载当前对局 JSON（`jev-qiguan-game/v1`：记法序列 +
  双方每手含战术保险标记 + 结果/渠道等元数据），为后续导入回放预留格式；悔棋自动跟随，空局拦截。
  **附归因 meta**：顶层记代码版本 / topK / 种子 / AI 手数 / 成本 / token / 延迟 / 平均置信度 /
  战术保险使用直方图；每个 AI 着法记 `{ch, mdl, conf, p, rank, cands, ms}`，
  `rank` 是实走这手在模型 top-8 里的名次（1 = 模型首选）——据此可区分「模型真这么想的」
  与「被采样/战术保险改写的」。这让「把这盘输归因到哪一版代码、哪一手」成为可能。
- **侧栏折叠一屏化**：7 个分析面板可折叠收起（Jev 驾驶舱常开，首访默认展开「Jev 判断」），
  折叠状态持久化；面板密度收紧、趋势图收薄。桌面端（含浏览器 chrome）一屏放下全部分析内容；
  展开时自动补渲染，图表不会因折叠期间量宽为零而破图。

### Jev 接入

- **各渠道可自定义 Base URL**：设置面板每个真实渠道新增「接口地址」输入框，预填该渠道预设值，
  留空用预设。自定义端点不强制 key（自建网关可匿名），且不再因未填 key 回落离线演示；
  预设端点行为不变。地址按渠道分别记忆（`settings.endpoints`）。
- **「测试连接」连通性探测**：开局前一键分诊——网络不通 / 跨域(CORS)拦截 / key 无效 /
  端点不兼容六种判定直接给出原因与建议（两段式探测，`BG.jev.probe`）。
- **直连结论实测定案**：官方 API 带 CORS 来源白名单（实测仅 typesafe.ai 自有域名），
  浏览器直连不可行，「填 key 即玩」的正解是部署一次 CF Pages（自带同源代理）。
  双击 `file://` 打开时自动落离线演示，不再第一手报错；渠道提示与错误指引同步更新。

## [0.3.0] - 2026-09-29

### 前端打磨（可访问性与工艺底线）

先量再改——全部结论先变成数字，再动手：

- **修复 `--ink-mute` 小字对比度**：原 `#7C8590` 在四档底色上只有 3.32~3.74:1（未达 WCAG AA 的
  4.5:1），而它承载 22 处 9~10.5px 小字。改 `#656E79` → 最低 4.60:1。
- **修复控件边界对比度**：新增 `--line-ctl: #828FA3`（≥3:1，WCAG 1.4.11）。输入框/下拉的填充
  与面板同为白色，边框是唯一识别线索，原先只有 1.51:1。装饰性发丝线刻意保持低对比不变。
- **22 处字号低于 11px 全部提到 11px**（最低原为 9px，含图表坐标轴）。
- **修复 `.feed` 规则整条失效**：CSS 写 `.feed` 而 HTML 容器是 `<div id="feed">`，导致决策流
  没有高度上限也没有滚动条，侧栏随对局无限长。容器补上 class。
- **5 处 `transition: width/height` 改为 `transform: scaleX/scaleY`**，避免逐帧重排；
  曲线描线进度用 `pathLength="1"` 归一化，不必猜路径长度。
- **焦点环、滚动条统一主题化**（`:where()` 保持零特异度；WebKit 伪元素 + Firefox 标准属性）。
- 清理死代码：`.stats` / `.stat`、`.engine-panel.live` + `seal-breathe`（从未被触发）。

### 视觉张力（用户选定「精修 + 更有张力」）

- 收敛为一个被编排的动效时刻「**落子**」：曲线一次性描线 + 末点单次外扩，共用同一条 `--ease`。
  删掉两处无限循环装饰动画（`pulse` / `seal-breathe`）。
- 拉开排版尺度差：品牌标题 23px→27px 并收紧字距，面板标题 16px→17.5px、字距 2.5px→1.2px。
- 移除 craft-floor 拒绝项：`.cal-hero` 的 3px 彩色左边条（上一轮自己引入的）、
  用 Unicode 字形「弈」「衡」顶替图标系统（改为自绘 SVG，画的是「本该出现的曲线」与「失准」本身）。
- 两个浮层按「二选一」处理「发丝线 + 宽投影」签名：`#promoBox` 保留明确边、`#testPanel` / `#toast` 只靠投影。

### Fixed

- **`button.primary` / `.brand-mark` / `.seal` 的白字在渐变上端只有 3.87:1**（`--zhu-hi: #D95840`），
  未达 AA。改 `#C94C36` → 4.59:1。此项由 `impeccable detect` 在改动完成后抓出，原计划未覆盖：
  渐变端点上的文字无法被前景/背景配对扫描发现。

### Notes

- 三项**有意保留的例外**（含 1 项检测器误报）记录在 `docs/status.md`「设计例外」：
  装饰性发丝线刻意低对比、侧栏 11px 密集数据正文、`#promoBox` 的明确边 + 中等投影。
  改样式前先读那节，不要为了「统一」把它们一起改掉。
- `impeccable detect` 报的 `#ffffff on #ffffff 1.0:1` 是它解析不了 `linear-gradient()` 的误报；
  三处白字已逐处人工核算，真实最低对比 4.59:1。

## [0.2.0] - 2026-09-29

### Added
- **校准实验室**：把 Jev 逐手给出的胜率预测与对局真实胜负放在一起量。
  输出 Brier 分、技巧分（相对「恒猜平均胜率」的参考预报）、校准误差、最大箱偏差、
  过度自信度（平均预测 − 实际胜率），并绘制可靠性图（横轴「Jev 说的胜率」、
  纵轴「实际兑现」，落点贴对角线＝校准良好）。
- `js/calibration.js` 纯数学模块（零 DOM、可在 Node 与浏览器两端自检）；
  `index.html?test=1` 现在也会跑它的自检。
- 迭代计划文档 `docs/plans/2026-09-29-iteration-03-calibration-lab.md`

### Notes
- 校准数据只统计**真实渠道**的对局：离线演示的胜率是本地合成的，不参与统计；
  和棋局无二元真值，也不计入。样本按「局」强相关，面板同时显示局数与手数。
- 校准误差（ECE）单独看会骗人——恒猜 50% 的预测器 ECE 也是 0。
  因此面板把「技巧分」与「校准误差」并排给出。

## [0.1.1] - 2026-09-29

### Fixed
- 悔棋后 Jev 回合不再卡死：此前在 Jev 思考途中悔棋会让对局永久停摆（界面却显示「等待 Jev」）
- 终局后点悔棋，状态条不再残留「终局 · … 获胜」，暂停/单步/重试按钮同步复位

### Changed
- 决策流改为增量插入新卡片（此前每手重建最多 40 张卡，长对局下是 O(n²) 的重复渲染）
- 对局历史只保留记法而非每手全量局面快照，悔棋时按记法重放还原

### Added
- 集成对局新增「整盘记法重放等价」断言，为悔棋还原路径提供回归护栏
- 迭代计划文档 `docs/plans/2026-09-29-iteration-02-play-loop.md`

## [0.1.0] - 2026-09-28

### Added
- 六个棋种引擎：五子棋（15×15）、围棋（9×9，中国规则贴 5.5）、象棋、国际象棋、西洋跳棋、中国跳棋；统一接口 + selfTest
- 三种对弈模式：人机（可选执子）、机机（速度滑杆/暂停/单步）、人人
- Jev 接入四渠道：官方 API / OpenRouter / 同源代理 / 离线演示；429/529 指数退避；top-k 概率加权采样
- Jev 决策面板：top-3 概率条、置信度、局势判断（Noul/Score）、延迟、token 与成本累计
- CF Pages Functions BYOK 代理（functions/api/jev.js）与本地 dev-proxy.py
- 自检体系：node test/run-tests.js 与 index.html?test=1
- 文档体系：AGENTS.md、docs/（架构/引擎接口/Jev API/ADR/计划/多 agent 协同/记忆）
