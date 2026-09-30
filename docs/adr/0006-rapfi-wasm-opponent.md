# ADR-0006：Rapfi WASM 本地引擎对手（Gomocup 协议），新增 rapfi 渠道

- 状态：accepted（2026-09-29）
- 背景：对比实验需要除 Jev（prompt 型）之外的强对手基线。Rapfi 是
  Gomocup 协议的传统五子棋引擎（dhbloo/rapfi），有官方 WASM 构建先例
  （gomoku-calculator），适合以「本地引擎」渠道接入：无需 key、不依赖
  网络（首次下载模型除外），且与 Jev 形成"搜索型 vs 提示词型"的对照。

## 决定

1. **构建**：Emscripten 6.0.10，tag 250615（构建时上游最新 tag），
   `NO_MULTI_THREADING=ON`（单线程）、`NO_COMMAND_MODULES=ON`（Emscripten
   强制）、`USE_WASM_SIMD=ON`（SIMD128 加速 NNUE）。产物
   `rapfi/rapfi-single-simd128.{js,wasm,data}`（.data 精简后 9.6MB，
   .wasm 1.1MB，.js 37KB，合计约 10.8MB）。
2. **协议客户端** `js/rapfi.js`（`BG.rapfi`，IIFE，零依赖）：
   - 懒加载：首次选用 rapfi 渠道（或点「测试连接」）时动态注入胶水脚本，
     `locateFile` 指向 `rapfi/` 目录；`Module.onReceiveStdout` 按行收集。
   - 初始化：`START 15`（验 `OK`）→ `INFO rule 0`（无禁手）；
     每手先 `INFO timeout_turn <ms>`（默认 3000ms）再发整盘 `BOARD`。
   - `BOARD` 颜色是**相对引擎**的：1=SELF（轮走方），2=OPPO；落子按
     SELF/OPPO 交替、首子为 SELF 排列，避免引擎用 PASS 对齐时打乱轮走方。
   - 着法解析只认严格 `x,y` 行，`OK`/`MESSAGE`/`ERROR` 一律忽略；
     无着法行或着法非法时抛错，走 app.js 现有错误路径（重试/暂停）。
   - 仅允许 `engine.id === 'gomoku'`；`meta.channel='rapfi'`。
3. **接入**：`BG.jev.decide` 遇 `channel==='rapfi'` 直接委托（**不走 Jev
   战术层**，与 mock 同理，保持"Rapfi vs Jev"实验变量纯净）；
   `app.js` 的渠道名/免 key 直通/endpoint 隐藏/`runProbe` 改为触发懒加载；
   `index.html` 三处下拉框（`#channel`/`#expChanA`/`#expChanB`）加选项；
   实验报告的 `CHAN_LABEL` 加 `rapfi: 'Rapfi'`。
4. **许可**：引擎 GPLv3、权重 CC0，见 `rapfi/NOTICE` + `rapfi/COPYING.txt`；
   `js/rapfi.js` 为自研协议客户端（MIT，与仓库一致）。

## 协议细节（以 Rapfi 250615 源码为准，非猜测）

- `INFO rule 0` = FREESTYLE 无禁手（`command/gomocup.cpp` switch）；
  `INFO game_type` 被引擎忽略（读后丢弃），按 Gomocup 惯例仍可发。
- `BOARD x,y,color`：`SELF=1, OPPO=2`（`getPosition` 的 `SideFlag` 枚举）；
  首个非墙子决定引擎颜色（SELF 首子→引擎执黑）；落子按顺序重放，
  同色连排时引擎插 `PASS` 对齐——故发送侧必须交替排列。
- 坐标：`config.toml` 设 `coord_conversion_mode="X_flipY"`，
  但输入输出同构，往返一致；取协议惯例 `x`=列（0 最左）、`y`=行（0 最顶），
  与项目记法 `A1=(0,0)` 对齐（`String.fromCharCode(65+x)+(y+1)`）。
- 单线程构建的 `sendCommand` 是**同步阻塞**的：一次调用跑完一整手搜索，
  时长由 `timeout_turn` 限定；`decide` 在调用前让出事件循环一拍，
  使「思考中」指示先 paint。

## 构建中的坑（已解决）

- `Networks/wasm_preloads.txt` 是 CRLF 换行：CMake 的 `file(READ)` +
  `REGEX REPLACE "\n"` 会留下 `\r`，污染虚拟文件系统目标路径；
  构建前转 LF（仅构建工作区，不影响仓库）。
- tag 250615 单线程构建有编译错误：
  `searchthread.cpp` 的 `ThreadPool::waitForIdle()` 用了只在
  `MULTI_THREADING` 下存在的 `th->thread` 成员；本地加 `#ifdef` 守卫
  （单线程下 `waitForIdle` 本就是空操作）。详见 `rapfi/NOTICE`。
- 预加载清单精简为 freestyle 所需两项（`config.toml` +
  `mix9svqfreestyle_bsmix.bin.lz4`），`.data` 从 40MB 降到 9.6MB；
  权重缺失时引擎对**缺失项**抛 `runtime_error` 会导致整个 evaluator 残废，
  但 freestyle 权重排第一且存在，实测无影响（冒烟：空盘 H8、中盘合法着法、
  四连局面 2ms 内走出制胜 H7、白方视角正常）。

## 后果

- 优点：零依赖守住（无 npm、无打包器、无 CDN；WASM 是预编译产物，
  非构建步骤）；新渠道开箱即用，实验框架直接可用作强基线。
- 缺点/已知局限：
  ① 单线程同步搜索会冻结 UI 约 `thinkMs`（默认 3s）——机机实验可接受，
  人机对弈时每手卡 3s；**后续应迁到 Web Worker**（本轮为控制复杂度未做）。
  ② `file://` 双击打开时 `.data` 的 fetch 可能被浏览器拦截，需 HTTP 托管
  （`node server.js` / `dev-proxy.py` / Pages 均可）。
  ③ 引擎搜索日志走 `MESSAGE` 行，已在解析层过滤；`timeout_turn` 是引擎侧
  强制时限，JS 侧无法中途 abort（`signal` 仅在思考前后检查）。
- 约束：`rapfi/` 二进制只增不改（升级上游版本时重新走构建流程并更新
  NOTICE）；`js/rapfi.js` 的协议假设若上游改动，需同步更新本 ADR。

## 考虑过但放弃

- **多线程 WASM**：需 COOP/COEP 响应头，与纯静态托管定位冲突，
  且单线程 + 3s 时限对实验基线已够用。
- **完整 40MB 数据包**：standard/renju 权重本项目用不到（只走 rule 0），
  精简后 9.6MB 且冒烟验证通过。
- **把战术保险套在 Rapfi 外层**：会覆盖引擎着法，污染实验对照；Rapfi
  自带完整搜索，不需要 prompt 型 AI 的保险层。
