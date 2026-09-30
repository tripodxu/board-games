# 项目状态

> **每次行为变更后更新本节**（不写流水账）。最后更新：2026-09-30。

## 当前状态

**v0.8**：七个棋种引擎（五子棋 / 五子棋·禁手 / 围棋 9 路 / 象棋 / 国际象棋 / 西洋跳棋 / 中国跳棋）+ 三种对弈模式 + Jev 决策面板 + 校准实验室 + 前端打磨（可访问性与工艺底线）+ 侧栏折叠一屏化 + 棋谱自动同步归档 + 对比实验（A/B 渠道连跑 + 实验报告面板）+ 零依赖 Node 后端（server.js）+ Rapfi WASM 本地引擎渠道 + VCF 将死链（九级战术保险，**已修复伪胜 soundness 缺陷**）+ 棋谱导出 meta（代码版本/采样参数/单手归因）+ **战术版本实验室（十档战术梯可复现：版本闸门 + 归因 meta + 战术沿革竖列 + 双方自由配置 + A/B 战术实验 + 联名 slug 归档 + 换边重开 + 对局页「机器对手」直达面板 + 按版本分组的「棋谱归档」面板，见 ADR-0009）**。

| 模块 | 状态 | 说明 |
|---|---|---|
| 五子棋 gomoku | ✅ | 15×15 无禁手，候选预筛 ≤64，五连判定；criteria 战术标签、deepTactics、vcfWin（与禁手版同文件工厂，见「五子棋·禁手」行）|
| 围棋 go | ✅ | 9×9，提子/禁自杀/劫/双停数子（贴 5.5，中国规则） |
| 象棋 xiangqi | ✅ | 9×10 全走子规则、照面、将军/绝杀/困毙 |
| 国际象棋 chess | ✅ | 易位/吃过路兵/升变/将杀逼和，perft(1/2/3)=20/400/8902 |
| 西洋跳棋 checkers | ✅ | 英式 8×8，强制跳吃、连跳、升王即停 |
| 中国跳棋 cc | ✅ | 六角星 121 格，连跳递归、先抵对营 |
| 对弈模式 | ✅ | 人机（选执子）/ 机机（速度滑杆、暂停、单步）/ 人人 |
| Jev 接入 | ✅ | 五渠道（official/openrouter/proxy/rapfi/mock）+ random 基线（仅实验面板）+ 各渠道可自定义 Base URL（留空用预设）+ 「测试连接」连通性探测（网络/CORS/key/端点形状六种判定；rapfi 改为触发懒加载）+ 429/529 退避 + top-k 采样 |
| Rapfi 本地引擎 | ✅ | 新增第五渠道 `rapfi`：浏览器内 WASM 运行 Rapfi（tag 250615，单线程 SIMD128，Gomocup 协议，无禁手）；`rapfi/` 预编译产物约 10.8MB（.data 9.6MB 精简版），首次选用时懒加载，无需 key；`BG.rapfi` 协议客户端（`js/rapfi.js`，16 项单测），`decide` 不走 Jev 战术层；**设置面板「Rapfi 思考时长」可调 0.5–10 秒（默认 3 秒，Gomocup `INFO timeout_turn`，存 localStorage，机机/实验同效）**；引擎 GPLv3、权重 CC0（`rapfi/NOTICE`）；已知局限：单线程同步搜索冻结 UI 约 N 秒（N=思考时长，ADR-0006） |
| Jev 强度 | ✅ | 战术事实注入（state.tactics：1-ply 一步致胜点 + 2-ply 造杀/拆杀点 + **VCF 将死链**）+ 战术保险（meta.tactics = win/block/open4/threat/vcfAttack/vcfDefense/parry/parry3/parry4 透出，优先级 win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4；**vcfAttack/vcfDefense = 连续冲四将死链的攻守**：引擎 `vcfWin()` 威胁空间搜索（7 ply/4000 节点/每层≤12 候选，实测 0–22ms），进攻找己方将死链首步、防守在对方将死链上逐点试干预（先链首、再链条顺序），**试走后复搜确认彻底破杀**（单点占不住就试下一点；全部失败才回落 parry）；**soundness 闸门（v0.7 修复，见 ADR-0008）**：攻方造四后守方被迫堵的那一手可能顺手给守方自己造出四 → 守方下一手直接成五，攻方后面的双杀永远兑现不了。搜索在双杀短路前检查「守方即时致胜点」，攻方这一手必须占掉它（守方活四两端 = 2 个反杀点时一步占不完，该分支直接无解）。回放 4 局 190 个决策点：伪胜 2→0，7 条有效链全部保留，耗时零增长（perCall 仍 0.38ms）；parry = 拆对手双杀制造点且多个并存时按 3-ply 安全性排序（排除给对方持续攻击节奏的点），parry3 = 抢占对手活三/活四制造点（deny:open4/deny:live3），parry4 = 抢占对手冲四制造点（deny:four，Rapfi 实战复盘增补）；**VCF 是连续冲四搜索，不是完整 VCT/估值**）+ 对局经验累计（state.experience）+ 五子棋提示词板斧（board_ascii 字符棋盘/刚性扫描清单/防幻觉核对/斜线 few-shot 具象示例）+ 五子棋 criteria 战术标签（活三/活四引擎代读，you:/deny:/block: 体系）|
| 五子棋·禁手 | ✅ | 新增 `gomoku-pro` 引擎（与 `gomoku` 同文件工厂 `createGomoku`，`forbidden` 开关区分）：黑方三三/四四/长连禁手（落子即负），黑方仅精确五连获胜，白方无禁手、五连以上获胜；禁手点从合法着法剔除，Jev 序列化带 `forbidden_points_black`；大众无禁手模式保留不变 |
| 决策面板 | ✅ | top-3 概率条、置信度、局势判断、延迟、token/成本累计 |
| 校准实验室 | ✅ | Jev 胜率预测 vs 真实胜负：Brier/技巧分/ECE/过度自信 + 可靠性图（真实渠道才有数据） |
| 可访问性 | ✅ | 见下方「设计例外」；对比度按 WCAG AA 核算，焦点环/滚动条已主题化 |
| 侧栏一屏化 | ✅ | 面板按「对局 / 实验 / 数据」三页签分组 + 8 个分析面板可折叠（驾驶舱常开），侧栏吸附视口内、仅当前页签内容区滚动（驾驶舱与页签栏为固定区，多面板展开不挤占），页面不再被面板撑长；折叠与页签状态均持久化，切换/展开时补渲染防零宽图表；≤1080px 单列布局回归文档流 |
| 棋谱导出 | ✅ | 棋谱面板「导出」一键下载当前对局 JSON（`jev-qiguan-game/v1`：记法序列 + 双方每手含保险标记 + 对局信息）；悔棋自动跟随，空局拦截。**v0.7 起附归因 meta**：顶层 `meta` = 代码版本 `BG.codeVersion` / topK / 种子 / AI 手数 / 成本 / token / 延迟 avg·max / 平均置信度 / 战术保险使用直方图；每个 AI 着法带 `ai = {ch, mdl, conf, p, rank, cands, ms}`（`rank` = 实走这手在模型 top-8 里的名次，1 = 模型首选，可据此区分「模型这么想的」与「保险改写的」）|
| 棋谱自动同步 | ✅ | 终局自动 POST `/api/games` → CF Pages Function 用 GitHub API 把棋谱 commit 进仓库 `games/<日期>/`（提交信息带 `[skip ci]`，不触发 Pages 构建）；设置面板「终局自动同步棋谱」开关可关；需 Pages 环境变量 `GAMES_GITHUB_TOKEN`（PAT，仓库 Contents 读写），未配置则静默失败不影响对局 |
| 对比实验 | ✅ | 机机面板内 A/B 渠道连跑（1–50 局）：自动交替执黑白、终局 2.5s 自动开下一局、每局棋谱照常同步；含 `random` 纯随机基线渠道（均匀概率、零启发式，但走完整战术管线，自由手真随机采样）；跑完归档到「实验报告」面板（localStorage + 内置两轮真实实验种子，缺失/过时自动合并；有后端时同步归档到服务端）。**A/B 双方可各自指定战术档与 Rapfi 思考时长**（`#expTacA/#expTacB`、`#expThinkA/#expThinkB`），跑的是哪一版战术直接写进结果联名；**面板为 A/B 并排双卡**（每方一张：渠道/战术/思考三行，`.exp-sides`；局数+开始/停止挪底部通栏 `.exp-foot`，状态独立一行），**面板顶部对局模式按钮组**（人 vs 机器 / 机器 vs 机器 / 人 vs 人，与折叠「对局设置」里的 `#mode` 同步并随全局设置持久化，实验运行中锁定为机机） |
| 后端 | ✅ | **`server.js` 零依赖 Node 后端**（`node server.js`，默认 8788）：静态托管 + `/api/jev` 代理（BYOK，key 不落盘）+ `/api/games` 棋谱落盘（幂等原子写，文件名与 CF 端一致）+ `/api/experiments` 实验归档（`data/`，gitignore）+ `/api/stats` 跨对局聚合 + `/api/health`；19 项 HTTP 契约测试随全量自检跑。**CF Pages 侧契约对齐**（health/experiments/stats 三端点，持久化走 GitHub，≤42 子请求守免费版限额）。前端 `js/api.js` 探活：有后端则服务端样本并入校准实验室、实验双端归档；无后端（file:///纯静态）自动降级，功能不变（ADR-0005） |
| 部署 | ✅ | **已上线 https://jev-qiguan.pages.dev**（CF Pages 项目 `jev-qiguan`，已连 GitHub：**push main 即自动部署**，构建留空/输出目录 `/`；wrangler 直传仅作备用）+ **`node server.js` 自托管**（本地/内网完整后端，棋谱落盘不依赖 GitHub token）+ dev-proxy.py 最小备用 |
| 自检 | ✅ | `node test/run-tests.js`：七引擎 selfTest（含禁手分支）+ 校准数学自检 + jev-client 单元回归（重试/回退/topK/自定义端点/**vcfWin soundness：合成伪胜反例 ⑫i/⑫j + 真链不误杀** + **⑬ 战术版本闸门：v0-off 全空 / v2·v3 逐层解锁 / v7·v8 VCF 边界 / 缺省与未知 id 收敛当前档**）+ 战术登记表单测（十档 ANCHORED / MECHS 单调 / games 归属 / resolve·allows 闸门）+ 对阵联名与 slug 单测 + **战术档位应用层贯通单测（档位控件十档齐全 + 设置/显隐/decide 透传/实验两侧/棋谱导出版本）** + **棋谱归档归位实测（走 `games/` 真目录：每份 stamp 落进的版本窗必须与登记表登记的局数一致，边界 v1 前→v0-off / 末档后→当前档 / 无 stamp→归不到）+ DOM 契约（设置抽屉四件套 / 三页签 / Rapfi 时长常显 / 趋势芯片按 id 取值 / 沿革竖列容器 / 机器对手三控件 / 归档面板）** + 棋谱导出 meta 单测（单手归因/全局汇总/种子）+ gomoku/cc/go mock 集成对局 + Pages Function 单测（jev + health/experiments/stats）+ server.js 19 项 HTTP 契约测试 + Rapfi 协议层 16 项单测 |
| 战术版本实验室 | ✅ | 十档战术梯 v0-off→v9-vcf-sound（`js/tactics-versions.js` 登记表：rank/机制键/commitAt/实战局数，git × 棋谱双锚定，见 ADR-0009）：`decide({tacticsVersion})` 按档开/关每层保险（`js/jev-client.js` 的 `resolveVersion` + `computeTactics` 五参签名 + `tacCache` 按 st×versionId 二级缓存，老战绩不受影响）；UI 入口——设置抽屉「战术版本」（仅 Jev 三渠道与 random 露出，mock/rapfi 不读战术层故隐藏）、**「机器对手」面板**（对局页直接改机器方：渠道 Jev 三渠道/Rapfi/随机+战术/演示、战术档、思考时长；与抽屉「双方覆盖 · 白方」同一份 `S.settings.sideConfig.white`，未改过时显示「跟随全局」并把**当前生效配置**写进 hint，选「跟随全局」即写空串清除覆盖；人 vs 人 模式下三项禁用而非隐藏）、**棋盘下方「战术沿革」竖列**（10 档普通行：当前档淡朱底、在用档 id 着朱、行内 `v5 · 拆杀安全排序 · 21 局 · 当前`，hover 看 commit/日期/机制依据，点击只改全局默认档）、**抽屉「双方覆盖」**（`S.settings.sideConfig`：黑白各自覆盖 渠道/战术/思考时长，空=继承全局；人机与实验共用一套，实验开跑借走、手动开局归还）、实验面板「A 战术/B 战术」+ A/B 思考时长；实验报告与战绩簿按渠道·档位联名（`sideAttribution`，老记录无档位自动退化为纯渠道名）；**「棋谱归档」面板**（数据页，按战术版本分组的归档棋谱列表：`versionForFileStamp` 按文件名 stamp 落进版本时间窗归组，只 `listGames(100)` 一次拉列表、不逐份抓内容；离线/无后端时给一句人话降级到本机战绩簿）；**棋谱导出带 `tacticsVersion`（单边）/`blackTactics`+`whiteTactics`+`blackThink`/`whiteThink`（实验）+ `slug`/`duel` 联名，每手 `ai.tv` 记接手档位**；服务端棋谱文件名改用 slug（`jev-v9-vs-ran-v3-<stamp>.json`，无 slug 回退 gid，脏字符消毒，旧文件名仍可 GET）——「旧代码 vs 新代码」从此有可复现凭据，不再靠嘴说 |
| 换边重开 | ✅ | R6 语义（spec §4.3.1）：人机模式下「换边重开」按钮把原局按 `winner:null + reason:'换边中断'` 记「未终局」（照常记账/导出/同步），随后交换我方执子重开；不写 localStorage、不伪造终局；未终局的 `firstWin` 置 null，分胜负统计与校准取样一律剔除（不污染先手胜率） |

## 已验证（验收证据）

`node test/run-tests.js` 全绿；浏览器 `index.html?test=1` 同源自检通过（含校准数学）；
`file://` 双击直开与 `python dev-proxy.py` 两种方式均验证过。
前端打磨轮另跑了对比度扫描（WCAG 相对亮度公式逐色核算）与 `impeccable detect` 机械体检。
2026-09-29 接入轮：probe 六种判定单测过；真实 key 实测——官方端点直连可达（probe ok），
经 dev-proxy 代理 probe 与真实 `decide()` 全链路通（jev-1.13.0，单步 ~0.5–2s，成本符合成本模型）。
2026-09-29 同步/实验轮：棋谱自动同步全链路通（22 份真实对局入库 `games/2026-09-29/`）；
两轮对比实验（Jev 代理+战术 vs 纯随机+战术）已归档实验报告面板——有效 9 局 Jev 8 胜 1 和 0 负，
且基线 9 局进攻性战术（threat/open4/win）触发 0 次（纯被动防守）；次轮第 4 局 225 手和棋
（双方 65 次战术触发全是防守）。
2026-09-29 后端化轮（v0.5）：`node server.js` 实测全链路——CDP 驱动真实点击打完一局
（mock 渠道，19 手终局），终局 0.5s 内棋谱落盘、设置面板「数据存储」显示
`jev-qiguan-server v1.0.0 · 22 份`、「最近同步」显示落盘文件名；头部 chip「后端 已连接」。
file:// 静态打开实测回落「无本地后端」，对局/导出/记录不受影响（降级路径即原路径）。
CF Pages 三端点上线后实测（push main 自动部署，约 1 分钟生效）：`/api/health` 返回
`jev-qiguan-pages v1.0.0` 且 `github:true`；`/api/stats` 聚合 21 份与本地 server.js
逐字一致（`cal.games:0`——现存棋谱早于 cal 字段，新对局开始累积）；`/api/experiments`
空归档正常返回。三端点的单测（pagesApiTests）随全量自检跑。
2026-09-29 Rapfi 接入轮：真实 WASM Node 冒烟（`rapfi-single-simd128.js/wasm/data`，
单线程 SIMD128，精简数据包 9.6MB）：`START 15`→`OK`；空盘走 H8；四连局面 2ms 内走出制胜 H7；
白方视角返回合法着法；中盘 Eval 非零（NNUE 权重加载确认：`mix9svq nnue: load weight from
mix9svqfreestyle_bsmix.bin.lz4`）。`js/rapfi.js` 协议层 16 项单测（stub Module）全绿，
跑在 `node test/run-tests.js` 全量内。注意：Rapfi 懒加载与 UI 阻塞仅在真实浏览器验证，
本轮仅 `node` 冒烟 + 单测（缺口见已知限制）。
2026-09-30 vcfWin soundness 轮（v0.7，ADR-0008）：合成反例证伪 ADR-0007 的
「守方反击造杀不覆盖」论断（黑 F5→白堵 F6→白自造四、唯一成五点 B6→黑 E5 双杀是假的）；
`games/2026-09-30/gomoku-20260930025550.json` 第 36/38 手 black L14、I11 带
`tactics=vcfAttack`，即那两条伪胜链——**此前记为「属 VCT 范畴」的归因作废**。
修复后 4 局 190 点回放 `win=7 valid=7 FALSE=0`（原 `win=9 valid=7 FALSE=2`），
`025710` p18 `vcfDefense=E13`、`025550` p58 `vcfDefense=D9` 未退化，perCall 0.38ms 无增长。
反向验证：把 HEAD 版引擎覆盖回工作区重跑，新用例如期红。全量自检全绿。
2026-09-30 战术版本实验室收尾轮（v0.8）：`games/` 下 28 份归档棋谱按文件名 stamp
逐份归版实测——`v5-safesort` 21 局、`v7-vcf` 4 局、`v8-vcf-try` 3 局，与
`js/tactics-versions.js` 登记表的 `games` 字段逐档吻合；相邻档时间窗首尾相接、v0 兜底、
末档开到 infinity 三项窗口断言进 selfTest（写错 commitAt 会让棋谱归错版本，测试直接红）。

## 设计例外（有意保留，不是遗漏）

三项刻意不达标，改之前先读这段：

1. **装饰性发丝线保持低对比**（`--line` / `--line-strong` 用于面板描边、分隔线）。
   这是「月白」视觉世界的组成部分。功能性控件边界另用 `--line-ctl`（≥3:1，WCAG 1.4.11）。
   **不要为了「统一」把装饰线一起加深**，那会毁掉体系。
2. **侧栏存在 11px / 11.5px 正文**（战绩簿 7 列表格、指标标签、棋谱流水）。
   侧栏是密集数据面板，提到 14px 需要重排并显著降低信息密度。高于 11px 已全部达标。
3. **`#promoBox` 用「明确边 + 中等投影」**：1px `--mo` 边（对白底 15.6:1，是明确边界不是
   发丝线）+ 28px 投影。检测器会把任何 1px 边 + 宽投影都报成「发丝线 + 宽阴影」签名，
   但它无法区分「明确边」与「发丝线」。

## 已知限制（按优先级）

1. **Jev+战术 vs Rapfi 实战 0-4（2026-09-29，原生 Rapfi 250615，2 线程/5s）**：
   四局皆为 Rapfi 造双杀、Jev 堵一漏一。复盘结论：2-ply 保险能处理单双杀与
   部分三层危险，但看不见冠军引擎 3-4 步的连续逼杀链（VCF）与"双双杀"局面；
   parry4（deny:four 预挡）为针对性增补，但属安静局面的防守加强，非深算替代。
   当前定位：Jev+战术对弱/中对手优势明显（此前 8-0-1），对强搜索引擎仍处下风。
2. **官方 API 的浏览器直连不可行（平台侧约束，非本项目缺陷）**：2026-09-29 实测官方 API 带
   CORS 来源白名单，仅放行 typesafe.ai 自有域名，任意第三方 Origin（含 localhost / file://）一律
   400 "Disallowed CORS origin"，官方文档未开放配置。浏览器侧走官方 key 的唯一路径是同源代理
   （本地 dev-proxy.py / 线上 CF Pages Function）；双击 file:// 打开时自动落离线演示。
2. **象棋长将/长捉判负未实现**（v1 明确暂略）。
3. **围棋仅 9 路**：13 路需要候选预筛策略（Choice ≤255，9 路不需要）；19 路不做。
4. **国际象棋三次重复局面判和未实现**。
5. 中国跳棋未禁止"永堵对方营地门"的变体规则；机机僵持时用悔棋/重开兜底。
6. Jev 概率判断可能出错（「零幻觉」仅指输出结构体），胜负以棋盘为准；官方性能数字为厂商口径。
7. 移动端触控未做专门优化（canvas 点击可用，但面板布局为桌面优先）。
8. 棋谱同步 / 实验归档 / 跨对局统计在 CF Pages 上都依赖环境变量 `GAMES_GITHUB_TOKEN`：未配置
   （或本地 `file://`/无 `functions/` 的静态托管）时同步静默失败（前端「数据存储」块会显示
   token 未配置的提示），实验历史只存浏览器 localStorage，换设备看不到。**自托管
   `node server.js` 不受此限**（棋谱落盘、实验归档均在本地，校准样本跨设备可聚合）。
   Pages 侧 `/api/stats` 另受免费版 50 子请求/次限制，只聚合最近 40 份（`truncated` 明示）。
9. `server.js` 与 `dev-proxy.py` 默认同为 8788 端口：同时跑会 EADDRINUSE（server.js
   会给出换端口提示），两者是替代关系不是互补关系；持久化是 JSON 文件不是数据库，
   规模到「每天几十份」无感，再上层需换存储（届时是新 ADR）。
10. 本机历史遗留：曾有多個 dev-proxy.py 实例残留占用 8788（Windows SO_REUSEADDR 允许多个
    监听共存，新连接落点不确定）。遇到端口行为异常先 `netstat -ano | findstr 8788`。
11. **Rapfi 渠道为单线程同步搜索**：思考期间（默认 3s）主线程被 WASM 搜索阻塞，UI 会冻结
    约 3s；后续应迁 Web Worker。另注意：Rapfi 仅支持 `gomoku`（大众模式，无禁手），
    `gomoku-pro`（禁手）会拒绝（Rapfi 是 Gomocup freestyle 引擎）；本轮 Rapfi 的懒加载与
    UI 阻塞仅在 `node` 冒烟 + 单测覆盖，**真实浏览器尚未验证**（后续待补）。
12. **`BG.codeVersion` 是手工维护的常量**（`'0.8.0'`）：零构建、无 git 注入，浏览器拿不到
    commit sha。**改动对局行为（引擎 / jev-client / 提示词）时必须手动 bump**，否则新旧
    棋谱混在一起，事后按代码版本归因就失效了——这正是 v0.7 修的那个缺陷的教训。
    建议每次此类提交顺手改 `js/board.js` 这一行。
    **v0.8 起归因维度升级**：`codeVersion` 之外多了 `tacticsVersion`（十档战术梯），
    同一份代码跑不同战术档就能做逐层对照实验，两者组合才是完整的可复现凭据。
13. **soundness 闸门可能漏判真胜（有意取舍）**：守方有即时致胜点时，攻方这一手被强制
    要求占掉它；若攻方另有一条不占该点也能成杀的真链，会被一并剪掉。生产路径上代价为零
    （`js/jev-client.js` 入口门控保证进 VCF 前双方无一步杀，闸门只在递归层起作用），
    详见 ADR-0008「代价与不做什么」。宁可少报一条链，不可错报一条。
14. **战术版本闸门只影响 Jev 渠道与 random 渠道**：`mock` 与 `rapfi` 在 `decide()` 内
    早退，不经过战术层（mock 是给自检/离线演示用的、rapfi 引擎自带战术）——选这两档时
    抽屉里的「战术版本」与沿革竖列都是无意义状态，实验面板里给 mock/rapfi 配战术档
    不会生效（联名上会退化为渠道名，不谎称版本）；「机器对手」面板选这两档时 hint
    仍会给出当前生效渠道与档位，但战术档不起作用。
15. **`sideConfig` 是单值不是按局持久**：刷新页面即回全局默认（走 localStorage 的
    settings 通道，但不进战绩）。想留一次实验配置就 Import/导出棋谱里的
    `blackTactics/whiteTactics/slug` 字段；实验中改抽屉覆盖，下一局生效、当局不回溯。
16. **沿革竖列与抽屉改的都是「全局默认档」**：实验中改它们不影响**已开局**双方的覆盖
    （覆盖在开局时已解析进 `effSide`），也不影响手动开局前显式指定的那一侧。
    沿革竖列的「在用」读的是当前 `effSide` 两侧，不是历史对局用过哪些档。
17. **棋谱归档按文件名 stamp 归版，不读文件内容**：老棋谱没有 `meta.tactics`（早于
    v0.7），只能靠 `body.exported` 生成的文件名时间戳落进版本窗口归组；因此
    ① 名字人工改过/不带 stamp 的棋谱归不到版本（单列「未能归版本」）；② 一局棋若
    跨版本时间窗保存，归档归到**保存那一刻**的版本，不是每手各自的版本（每手版本
    仍看棋谱内 `ai.tv`）；③ 需要同源后端（`node server.js` 或 CF Pages）才能列目录，
    `file://`/纯静态打开时面板降级为本机战绩簿。

## 路线图（候选，未承诺）

- [ ] 象棋长将/长捉判负（规则补全）
- [ ] 围棋 13 路（含候选预筛策略）
- [ ] 国际象棋三次重复判和
- [ ] 棋谱导入（导出与自动同步已上线：`jev-qiguan-game/v1` JSON 进 `games/<日期>/`；剩余：导入回放 + PGN/中文记法转换）
- [ ] 实验报告云端化（当前：localStorage + 服务端 `data/experiments.json` 双归档 + 内置种子；剩余：多设备统一视图）
- [ ] 棋谱回放器（后端已能按局读取 `games/<日期>/<文件>`，前端差一个逐手重放面板）
- [ ] 移动端响应式布局
- [ ] Jev vs Jev 批量赛程（ overnight 挂机跑 N 盘统计胜率）

## 技术债 / 注意点

- `js/app.js` 是最大的单文件（~1450 行），承担全部 UI 编排（对局循环 + 实验连跑 + 棋谱同步/导出 + 后端探活 + 实验报告归档 + 校准双源合并）；继续膨胀时应先拆
  「记录/统计/实验/后端」与「对局循环」两个模块，拆时保持 `index.html` 加载顺序同步。
- `test/run-tests.js` 与 `index.html` 的加载清单是两份硬编码，新增 JS 文件别忘了两处
  （本轮 `js/api.js` 已两处同步；`server.js`/`test/server-tests.js` 是 Node 侧，由
  run-tests.js `require`，不进浏览器加载清单）。
- mock 与引擎启发式已全部经 `BG.util.rnd()`（可种子）；`Math.random` 仅剩 `board.js` 兜底与 `weightedPick`（真实渠道采样）两处，属预期。
- ~~对局循环的 O(n²) 渲染与 history 全量快照~~ **已于 2026-09-29 清除**：决策流改为增量插入，
  history 只存记法、悔棋按记法重放。悔棋回路的两处缺陷（AI 回合不续弈、终局状态残留）同批修复。
- **UI 行为无自动化回归护栏**：`app.js` 的对局循环（悔棋/续弈/终局复位）只有 `node test/run-tests.js`
  覆盖不到——该命令只跑引擎与 Jev 客户端。改动 `app.js` 调度逻辑时需浏览器手工回归，
  或临时搭最小 DOM 桩（本轮用过一次性验证台，见 memory 对应条目）。
  **对策（v0.7 起）**：凡是要长期维护的纯计算（哪怕逻辑上属于 UI），就放进
  `js/board.js` 的 `BG.util` / 引擎文件，`app.js` 只留调用——棋谱导出 meta
  （`BG.util.aiMoveMeta` / `aiGameMeta`）就是这么做的，现在有单测钉着。
  **v0.8 补丁**：`app.js` 是 DOM 闭包、测试里加载不了，战术档位这一层的接线改用
  **静态源码断言**（`tacticsUiTests`：控件 id、十档 value、`resolve` 归一、decide 透传、
  实验两侧、棋谱导出版本字段——全是文本匹配）。这条路子保不住运行时行为，但能钉死
  「接线断了」这类最常见的回归；运行时仍靠浏览器手工回归。
- ~~`--ink-mute` 小字对比度全档未达 AA、22 处字号 <11px、5 处 `transition: width/height` 逐帧重排~~
  **已于 2026-09-29 清除**（前端打磨轮）。残留见「设计例外」。
- ~~`.feed` 规则因选择器与 HTML 不匹配而整条失效（决策流无高度上限、无滚动条）~~
  **已于 2026-09-29 修复**：容器补上 `class="feed"`。
