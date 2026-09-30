# MEMORY.md — 项目记忆

> **约定：新条目一律追加在最上面（倒序），最新在最顶。** 一条一事，写事实与结论，
> 不写客套；带日期的条目格式 `## YYYY-MM-DD · 标题`。
> 本文件是项目级持久记忆（入库、工具无关）。各 agent 工具自己的记忆/指针

---

---

## 2026-09-30 · Rapfi 思考时长（强度）可调

- 用户问 Rapfi 能否调强度：可以，唯一旋钮是 Gomocup `INFO timeout_turn`（每步思考时长），
  时间越长搜索越深越强；Rapfi 无等级档位。
- 新增设置面板「Rapfi 思考时长」下拉（仅渠道=rapfi 时显示）：0.5/1/2/3（默认）/5/10 秒；
  存 localStorage（`rapfiThinkMs`），经 `BG.jev.decide` opts → `BG.rapfi.decide({thinkMs})` 穿透，
  机机/实验走同一条 decide 路径，同效。rapfi.js 内部仍钳制 500–60000ms。
- 10 秒档注意：WASM 单线程同步搜索，UI 会冻结约 10 秒（ADR-0006 已知局限）。

## 2026-09-30 · vcfDefense 多点干预重试（exp-20260930025135 复盘补丁）

- 实验 exp-20260930025135：Jev(proxy) vs Rapfi 4 局，Rapfi 4:0 全胜（黑白各两盘）。
  4 盘共 10 次"vcfDefense 发现对方 VCF 但放弃"（game4 ply18 / game2 ply42 / game1 ply69 等）。
- 根因（game4 ply18 白方已验证）：旧逻辑只试"占住将死链首步"，复搜发现对方还有链
  就直接放弃。但链上其他点可破杀——game4 的 7 步链 C13,A15,E13,F12,E14,C14,E12 中，
  E13/F12/E14/C14/E12 占任一点都能彻底杀死黑方 VCF。旧逻辑试 C13 失败就放弃，白走
  D13(parry3)，黑 E13 双重威胁（即时五连 F12 + 活四 E12）打死，白 25 手落败。
- 补丁（js/jev-client.js）：vcfDefense 改为先链首、再链条顺序逐点试干预，每点试走后
  复搜，首个"对方彻底无将死链"的点采用；全部失败才回落 parry。链首成功时行为与旧版一致。
- 回归 ⑫h：game4 前 17 手局面，白方 vcf_win_opponent 非空（旧代码为空）；mock 偏向
  D13 也被纠正到破杀点，tactics=vcfDefense。
- game3 的败因是另一回事：黑 vcfAttack 链本身成立，但白方防守反击造杀（VCT 范畴，
  vcfWin 注释已声明为局限），不在本补丁范围，不硬造。

## 2026-09-30 · VCF 威胁空间搜索上线（Jev 战术保险第六/七层）

- 新增 `vcfWin(st, attackerId, maxPlies)`（js/games/gomoku.js，gomoku/pro 共用）：
  连续冲四将死链搜索。只走逼迫着法（落子出致胜点），2+ 致胜点即双杀判胜，
  唯一则假定守方被迫堵后递归。默认 7 ply / 节点 4000 / 每层 ≤12 候选 /
  只扫攻击子距离 ≤3 空点；禁手模式黑攻禁走、黑堵禁手视为堵不住、黑致胜点须
  精确五连。**守方反击造杀属 VCT 范畴，不覆盖**。
- jev-client.js 新增 vcfAttack / vcfDefense 层，优先级
  win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4；
  仅 1-ply 为空时跑，异常 fail-soft；meta.tactics 与 Jev instructions 同步语义。
- 防守核心规则「试走后复搜」：对方可能多条 VCF 根并存（⑨e：占 I9 后黑 E9
  照样杀），干预点试走后对方仍有 VCF 则弃用、回落 parry/pickSafestParry。
- 验证：回归 ⑫a–⑫g 全绿；rapfi-base1 四盘复盘——12 个触发点中 3 处
  （g3p41/g4p34/g4p36）实战着法没破杀、VCF 干预点经复搜确认破杀；
  终局前 3-5 手双方都破不掉的 3 处属棋已输，非 VCF 能救。
- 性能：最稠密实战中盘双向搜索 0–22ms。⑨d 复盘被 VCF 修正：
  黑真链入口是 E6（E6→D5→D6→F6→E7 双杀 C4+H10），vcfDefense=E6 取代
  原 parry3→E7 结论，后续黑 E7 时继续 vcfDefense=D6。
- 定位：VCF ≠ 完整 VCT ≠ 估值引擎；Rapfi 渠道保持独立对照。
- ADR-0007。

## 2026-09-29 · Jev vs Rapfi 实战 0-4 与 parry4 增补、gomoku-pro 禁手模式

- 4 局基线（tag rapfi-base1，原生 Rapfi 250615，2 线程/每手 5s，topK=3）：Jev+战术 0-4。
  g1 黑 26 手负（白 B6：双杀 B6/G6）；g2 白 37 手负（黑 L6-L10 列五：32 手 parry3 选 K10
  未挡 L8）；g3 黑 56 手负（白 J10-N14 斜五）；g4 白 43 手负（黑 G14-K14 横五）。
  统一模式：Rapfi 造双杀 → Jev 堵一 → Rapfi 从另一点击杀。
- 根因：2-ply 保险处理单双杀无虞，但看不见 3-4 步连续单杀逼迫链（VCF）与"双双杀"
  （两个独立双杀点并存，堵一必漏一）。parry3 只覆盖 deny:open4/deny:live3，
  漏掉 deny:four 制造点（g2 的 L8、smoke 局的 E10）。
- 增补 parry4（第五级，deny:four 预挡，优先级低于 parry3）：安静局面提前抢占对方
  冲四制造点，打断连续逼杀节奏。验证：g2 第 31 手复盘确认 parry4 逻辑生效，
  但因 K10 的 deny:live3 优先级更高仍选 K10——属启发式固有局限，非 bug。
  全量测试全绿。定位诚实化：Jev+战术对弱/中对手强（此前 8-0-1），对冠军级
  搜索引擎仍下风，深算差距非启发式补丁可弥合。
- gomoku-pro（五子棋·禁手）：与 gomoku 同文件工厂 createGomoku(forbidden 开关)，
  黑方三三/四四/长连禁手（落子即负）、黑仅精确五连胜、白无禁手；禁手点剔除出
  合法着法，Jev 序列化带 forbidden_points_black；已入 GAME_ORDER，大众模式不变。
  当前为连珠式禁手原型，未做 Swap2/RIF 开局协议，不可称完整赛事规则。
> （如 `.workbuddy/MEMORY.md`）只允许指向本文件，不得成为事实源。
> 沉淀规则见 [README.md](../README.md)「维护规则」。

---

## 2026-09-29 · Rapfi WASM 本地引擎接入（rapfi 渠道）

- 构建：Emscripten 6.0.10，Rapfi tag 250615，`NO_MULTI_THREADING=ON` + `NO_COMMAND_MODULES=ON`
  （Emscripten 强制）+ `USE_WASM_SIMD=ON`；产物 `rapfi/rapfi-single-simd128.{js,wasm,data}`。
- 两个构建坑：① `Networks/wasm_preloads.txt` 是 CRLF，CMake 的 `file(READ)` 会留下 `\r`
  污染虚拟 FS 路径，构建前转 LF；② tag 250615 单线程构建有编译错误
  （`searchthread.cpp` 的 `ThreadPool::waitForIdle` 用了多线程才有的 `th->thread` 成员），
  本地加 `#ifdef MULTI_THREADING` 守卫（单线程下该函数本就是空操作）。
- 数据包精简：只预加载 `config.toml` + freestyle 权重，`.data` 从 40MB 降到 9.6MB；
  权重缺失抛的是 `runtime_error`（不是 `UnsupportedEvaluatorError`），会残废整个 evaluator，
  但 freestyle 权重排第一且存在，实测无影响。
- 协议细节（源码级，非猜测）：`INFO rule 0`=无禁手；`BOARD` 颜色相对引擎（1=SELF 轮走方，
  2=OPPO），落子必须按 SELF/OPPO 交替且首子 SELF，否则引擎插 PASS 对齐会打乱轮走方；
  `config.toml` 的 `coord_conversion_mode=X_flipY` 输入输出同构，往返一致，取协议惯例
  x=列(0左) y=行(0顶) 与项目记法对齐。
- `js/rapfi.js`（`BG.rapfi`）：懒加载胶水脚本，`START 15`→`INFO rule 0`，每手
  `INFO timeout_turn`+整盘 `BOARD`；解析只认严格 `x,y` 行（引擎搜索日志走 `MESSAGE`，
  必须过滤）；无着法/非法着法抛错走现有错误路径；仅 `engine.id==='gomoku'`。
- 单线程 `sendCommand` 同步阻塞，思考期间 UI 冻结约 thinkMs（默认 3s）；后续应迁 Web Worker。
- 许可：引擎 GPLv3、权重 CC0，`rapfi/NOTICE` + `rapfi/COPYING.txt`；`js/rapfi.js` 自研 MIT。
- 冒烟（真实 WASM，Node）：START→OK、空盘 H8、四连 2ms 内走出制胜 H7、白方视角正常。

## 2026-09-29 · 侧栏页签化：右栏不再把页面撑长

- 痛点：右栏 8 个可折叠面板 + 驾驶舱 + 设置全堆在一列，页面总高被侧栏决定，观感差。
- 方案：面板按「对局（判断/对决/最新决策/决策流）/ 数据（实验报告/战绩簿/校准/棋谱）/
  设置」分三页签；`.side` 改 `position: sticky` + `max-height: 100vh` + 栏内独立滚动，
  页面总高回归由棋盘列决定。页签栏在栏内滚动时 sticky 吸顶，←/→ 可循环切换（ARIA tabs）。
- 关键复用：页签隐藏也是 `display:none`，图表零宽问题与折叠同理——`activateSidePane`
  切回时对已展开面板直接复用 `FOLD_HOOKS` 补一次全量渲染，没有引入第二套机制。
- 页签选择持久化在 `jev_qiguan_sidetab_v1`；折叠持久化键不变，老用户状态不受影响。
- ≤1080px 单列布局下 `.side` 回归 `position: static`（吸附在窄屏反而碍事）。
- 修正（同日）：初版把整列 `.side` 设为滚动容器，多面板展开时驾驶舱被挤出视口、
  且 flex 子项默认 `flex-shrink:1` 会压缩固定区。改为「驾驶舱 + 页签栏固定
  （`flex:0 0 auto`）、仅 `.side-pane` 滚动（`flex:1 1 auto; min-height:0`）」。
  教训：sticky 栏内做滚动时，滚动范围要限定在内容区，固定区必须显式禁 shrink。

## 2026-09-29 · CF Pages 补齐三端点：线上也获得完整后端（方案 1 落地）

- 用户问「可以部署到 cf 上吗」「是不是可以改成 worker」。结论：Pages Functions **就是**
  Worker（同运行时同 API），server.js 的 node:http/fs 在 Workers 里不存在（nodejs_compat
  也不放行），不可能小改迁移；但把三个独有端点移植成 Pages Functions 即可让线上获得
  与本地一致的完整体验。选定方案 1（保留 git 自动部署，不引入 wrangler/npm）。
- 新增 `functions/api/health.js`（零上游请求的探活，`github` 字段报 token 配置态）、
  `experiments.js`（读写仓库 `data/experiments.json`，按 tag upsert，`exp: <tag> [skip ci]`）、
  `stats.js`（聚合）。持久化全部走 GitHub（复用 games.js 的写路径），**零新增绑定**：
  不引 KV/D1/R2，数据天然版本化。三文件共用 `functions/api/_github.js`（下划线前缀
  不对应路由的共享模块，Pages/Wrangler 的 ESM import 是标准行为）。
- **免费版 50 子请求/次 是 stats 的硬约束**（已查证）：设计成 1 次 trees + ≤40 份 raw
  （raw.githubusercontent.com 走 CDN 不计 API 配额）+ 1 次 contents = 42，测试里直接断言
  ≤42。截断时 `truncated: true`，前端显示「40+ 份」不冒充全量（本地 server.js 仍是 400 份）。
- **Pages 的 SPA 兜底坑**：未匹配的 `/api/*` 返回 index.html + 200（线上实测）。前端
  `BG.api` 靠 JSON 解析抛错被 catch 成 null 来降级——行为正确但是隐式的，已在 jev-api.md 写明。
- 测试：`pagesApiTests` 用「剥 import/export + 源码拼接」加载模块（_github.js 定义内联进
  同一作用域，模拟 Wrangler 打包），stub fetch 按 URL 路由模拟 GitHub。踩了两个自己的坑：
  withStub 多行 route 少写一个 `]`（第二个参数被吃进路由数组，SyntaxError 定位到几十行外）；
  以及断言本身写错（3 份里只有 1 份既非 mock 又有二元真值，cal.games 应为 1）。
- 聚合口径与 server.js handleStats 逐字一致（byGame/results/cal.records），前端按
  gid|着法串去重合并，本地与线上样本可互换。

## 2026-09-29 · 后端化（ADR-0005）：server.js 零依赖 Node 后端 + 前端全量打磨

- 用户要求「重构成具有后端的项目」，但不能违背 ADR-0001（零框架/零构建/零依赖）。
  解法：`server.js` 只用 node:http/fs/path，`node server.js`（默认 8788）一个命令得到
  静态托管 + `/api/jev` 代理 + `/api/games` 落盘 + `/api/experiments` 归档 +
  `/api/stats` 聚合 + `/api/health`。棋谱文件名规则与 CF 端逐字对齐（gid 清洗截断 24、
  `games/<exported 日期>/<gid>-<stamp>.json`），`flag:'wx'` 原子写实现幂等。
- **降级路径即原路径**：`js/api.js`（BG.api）全部方法失败返回 null 不抛；`app.js` 启动
  `initBackend()` 探活，live（server.js）才做服务端合并，deploy（file:///纯静态/Pages）
  行为与后端化之前逐字节一致。头部「后端」chip + 设置面板「数据存储」块显示三态读数
  （jev-qiguan-server v1.0.0 / 棋谱份数 / 最近同步结果）。
- 后端对产品最实质的增强：**校准实验室双源合并**。`buildGameExport()` 补 `cal/firstWin/mock`
  字段（与 saveGameRecord 同口径，抽出 `calSamples()` 单一事实源），`/api/stats` 按局返回
  `cal.records`（key = gid|着法串），前端与本机战绩簿按 key 去重合并——换设备、清缓存
  不再把校准数据清零。mock 标记口径改为「本局无任何真实渠道着法」：对比实验一方 mock
  一方 Jev 时，Jev 半局的样本仍然有效。
- 测试：`test/server-tests.js` 18 项 HTTP 契约（临时目录 + listen(0)，不碰仓库数据），
  由 run-tests.js require 进唯一验收命令；`serverTests(log)` 的 log 注入让输出顺序与
  引擎用例一致（否则后端用例会插到最前面）。
- 前端打磨（impeccable polish 模式，保留月白/玄墨/朱砂体系）：修了一个真 bug——
  **`.mono` 数据字工具类没有基类规则**（app.js 挂 21 处，字体从未换成等宽），「等宽数据字」
  这个体系组成实际是死的；补基类 + `font-variant-numeric: tabular-nums`。
  另：caret-color 主题化、`#tabs` 纳入主题滚动条、`＋/－` 与 `⚗`  Unicode 字形换成自绘 SVG
  （craft-floor 拒绝项）、棋谱面板空态、probe 加载态、窄屏头部 chip 裁切修复
  （420px 实测品牌副标题 255px 宽，芯片行改确定性换行）、engine-metrics 窄屏两列。
  impeccable detect 复跑：零新增违规（仅存量 4 项文档化例外）。
- 实测（CDP 驱动真实点击，非仅静态截图）：mock 渠道自动打完 19 手终局 → 0.5s 内棋谱
  落盘 → 设置块显示 `jev-qiguan-server v1.0.0 · 22 份`、「最近同步 · 成功」；
  file:// 回落「无本地后端」，对局/导出/记录不受影响。
- 坑：本机有多个历史遗留 dev-proxy.py 实例占着 8788（Windows SO_REUSEADDR 允许多监听
  共存，新连接落点不确定），验证时换 PORT=8790；server.js 的 EADDRINUSE 文案已指向换端口。

## 2026-09-29 · 对比实验面板 + random 纯随机基线渠道（Jev vs 随机，8:0:1）

- 动机：要回答「Jev+战术到底比纯随机强多少」，需要可重复的机机 A/B 连跑。实现（`app.js`）：
  实验面板选 A/B 渠道 + 局数（1–20），`startExperiment()` 起跑，**自动交替执黑白**（偶数局 A 执黑），
  终局 2.5s 自动开下一局；`effectiveChannelFor(side)` 让同局黑白走不同渠道（平时回落 `effectiveChannel()`）；
  手动开局不清 `expChannels`（`startGame` 里 `EXP.running` 守卫）。
- **random 基线渠道**（`jev-client.js`）：均匀概率、零启发式、`model='random-baseline'`、成本 0，
  但**刻意走完整战术管线**——这样「随机+战术 vs Jev+战术」的唯一变量就是概率分布质量。
  两个坑：① 自由手原先被 topK=1 坍缩成「取第一顺位」，退化成顺序走子（A1→B1→C1…，实测两盘
  棋谱完全相同）——改为 `legal[BG.util.rand(len)]` 真随机均匀采样，与 topK 无关；战术接管不受影响。
  ② mock 渠道不走战术层，random 走，两者语义不同别再混。
- **实验报告面板**：`localStorage`（`jev-exp-history-v1`）归档每轮战报 + 内置两轮真实实验种子
  （`EXP_SEED`），`loadExpHistory` 按 tag 合并：缺失或局数偏少（某局棋谱是部署后才同步到的）自动补齐，
  再按日期倒序。重复局标 `dup` 不计入有效统计。
- 结论（有效 9 局）：Jev(代理)+战术 **8 胜 0 负 1 和**；基线 9 局进攻性战术（threat/open4/win）
  **触发 0 次**，65+ 次战术触发全是防守——纯随机只会被堵，造不出双杀。次轮 #4 下满 225 手和棋：
  双方都是纯防守节奏。样本仍小（同棋种同配置），结论方向可用、数值别当统计显著性。
- 趋势图兜底（同批）：random 着法不再进 Jev 判断序列（`meta.channel !== 'random'`）；
  三芯片永不为空——局势分缺失用胜率×10、置信度缺失用首选概率。

## 2026-09-29 · 棋谱自动同步进仓库 games/（对比实验的数据底座）

- 动机：复盘分析需要真实对局数据，手动导出上传太慢。链路：终局 `uploadGameRecord()` POST
  `/api/games` → CF Pages Function（`functions/api/games.js`）用 GitHub API commit 进仓库
  `games/<YYYY-MM-DD>/<gid>-<stamp>.json`。GET `/api/games` 列出最近 7 天棋谱。
- 关键决策：**提交信息带 `[skip ci]`**——Pages 的 git 集成会把任何 push 当部署触发，
  棋谱数据提交不触发构建，否则对局一多就把构建队列淹了（加之前 Pages 白构建了 20+ 次）。
- 密钥：CF Pages 环境变量 `GAMES_GITHUB_TOKEN`（fine-grained PAT，只给本仓库 Contents 读写）。
  **未配置时 500 + 客户端静默失败**（只 console 记录）——同步是增强不是对局依赖，这条降级路径必须有。
  限流同 jev.js 做法（POST 20 次/分/IP）；payload 校验 `format === 'jev-qiguan-game/v1'`。
- 开关：设置面板「终局自动同步棋谱」（`settings.gameSync`，默认开），存 localStorage。
- 教训：`exportGame` 的 payload 构造抽成了 `buildGameExport()` 复用；实验局额外带
  `blackChannel/whiteChannel/experiment/expGameNo` 字段，否则归档后分不清哪局是谁走的。

## 2026-09-29 · 拆杀点安全性排序：3-ply 排除持续攻击（parry 第二判）

- 用户实战败局复盘（白 Jev 负，`jev-gomoku-202609290924.json`）第 18 手：danger=[I9,E9] 两个双杀
  制造点并存，实战走 I9（Jev 偏好）→ 黑 E9 单杀逼杀 → 白被迫 D9 → 黑 H12 对角成四 → 白只堵一端
  → 黑 D8 获胜。根因：**I9 只是 E9 的其中一个致胜点，堵它不解决问题**。
- 修复（`jev-client.js`，`deepTactics` 引擎生效）：多个 danger 并存时 `pickSafestParry` 两轮排序——
  ① `allowsSustainedAttack`：白走 p 后黑有逼杀 q（走出后恰 1 个致胜点）→ 白被迫堵 → 黑**仍有
  danger 点** ⇒ p 给了黑持续攻击节奏，排除；② 剩余点按 `countForcingReplies`（p 走后黑的逼杀
  着法数）取最少。单点或非 deepTactics 引擎回退 `pickAmong`。外层 64 候选、逼杀 q 只看前 8 个、
  逼杀数数到 10 即停——深度换时间的边界写死在代码里。
- 回归用例 ⑨e：钉住本局 p18（mock 概率偏向 I9 0.9 仍被接管到 E9，`meta.tactics='parry'`）；
  用例 ⑩/⑪ 同批钉住 random 渠道（一步杀必堵、自由手真随机）。
- 认知沉淀：**「堵哪个点」和「挡不挡」是两个问题**——2-ply 只回答后者；多个独立制造点并存时，
  点的选择要看 3-ply（堵完对手还有没有杀）。保险层到此为止，更深仍靠模型。

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
