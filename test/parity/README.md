# 差分金样（differential golden）安全网

> 计划依据：[docs/plans/2026-10-01-workers-d1-rebuild.md](../../docs/plans/2026-10-01-workers-d1-rebuild.md) §6.2 / §7 P5 第 1 步。
> 接口契约：[ADR-0004](../../docs/adr/0004-unified-engine-interface.md)（引擎四件套 + 纯函数不改入参 state）。

## 1. 这是什么，为什么必须在删旧实现之前生成

`js/*.js` 七个引擎要重写成 `src/core/*.ts`。这类迁移最大的风险是**「重写即重写 bug」**：
新代码看起来一样、常规局面也对，但提子少一颗、禁手漏一条、连跳少一层——
这种错误不会在编译期或代码评审里暴露，只会在线上输几十盘之后才被察觉。

所以在动旧实现之前，先把**旧实现的逐手行为**固化成机器可判定的指纹，落到
`test/fixtures/golden/*.json`。新 TS 实现跑同一批对局，任何一手不一致立刻报错并指出
「哪个引擎、哪一局、第几手、哪个字段」，把「行为漂移」变成一道必须在合并前通过的闸门。

金样的定义域是**行为**，不是代码：它记录「给定局面 → 合法着法 / 走子后状态 / 裁判结论」，
不记录实现细节、不记录耗时、不记录任何时间戳（否则两次生成永远不可能字节一致，
「可复现」这一条也就无从谈起）。

## 2. 产物清单（当前：7 个文件，合计 492148 B）

| 文件 | 字节 | 自对弈 | 历史棋谱 |
|---|---|---|---|
| [test/fixtures/golden/gomoku.json](../fixtures/golden/gomoku.json) | 392361 | 17 手（黑方 五连） | 54 局 / 4379 手 |
| [test/fixtures/golden/gomoku-pro.json](../fixtures/golden/gomoku-pro.json) | 2739 | 15 手（黑方 五连） | — |
| [test/fixtures/golden/chess.json](../fixtures/golden/chess.json) | 15115 | 169 手（和棋 子力不足） | — |
| [test/fixtures/golden/xiangqi.json](../fixtures/golden/xiangqi.json) | 49737 | 600 手（达上限截断） | — |
| [test/fixtures/golden/checkers.json](../fixtures/golden/checkers.json) | 9885 | 103 手（白方 子力被吃光） | — |
| [test/fixtures/golden/cc.json](../fixtures/golden/cc.json) | 13721 | 138 手（上方 全员抵达对面营地） | — |
| [test/fixtures/golden/go.json](../fixtures/golden/go.json) | 8590 | 89 手（白方 数子：黑 31 : 白 43.5） | — |

合计 **5510 手**（自对弈 7 局 1131 手 + 历史棋谱 54 局 4379 手），
上限 2 MiB（2097152 B，硬指标，见生成器 `SIZE_BUDGET`）——超限时生成器**拒绝落盘**并报错，
因为超限只可能说明指纹设计退化成了「存整盘」，正确做法是改设计而不是放宽上限。

`gomoku.json` 占了大头，因为它包含 `games/` 下全部 54 份历史棋谱的重放（4379 手），
这是计划 §6.2 明确要求的覆盖面，不是冗余。

## 3. 如何重新生成

```bash
npm run golden          # 等价于 node test/parity/generate.mjs
```

生成器自己保证可复现，不依赖任何外部约定：

- **固定种子**：每个棋种都 `BG.setSeed(42)` 后从 `newGame()` 起跑（与旧套件
  `test/run-tests.js` 的 `playOut` 同值，便于两边交叉复现；该套件已在 P8 随旧实现删除）；
- **固定环境**：内部强制 `BG_FAST=1`（mock AI 不做模拟延迟），并用与旧套件
  `test/run-tests.js` 相同的方式加载旧实现（`globalThis.window = globalThis` +
  `globalThis.location` 垫片 + 按序 `eval`），因此**记录的就是线上旧行为**；
  旧实现已删除后，生成器由 `legacyImplementationPresent()` 探针拦下，只打印中文说明并 `exit 1`；
- **自己跑两遍**：同进程内把整批数据采集两次并逐字节比对，不一致立即报错退出、
  **且不写任何文件**。这条断言是「金样可信」的前提——只跑一遍证明不了可复现；
- **不写时间戳**：产物头部只记 `commit` + `seed` + `codeVersion`，三者共同确定
  「这份金样出自哪份代码、用哪套随机流」；写入时间只会破坏字节一致性。

产物是**生成物**：不要手工编辑 `test/fixtures/golden/*.json`。手工改动会在下一次
`npm run golden` 时被覆盖，而且会让「金样 = 旧实现行为」这个前提不再成立。
需要改行为预期时走 §7 的例外登记，而不是改文件。

### 两次生成字节一致的验收

```powershell
node test/parity/generate.mjs
Get-ChildItem test/fixtures/golden/*.json | Sort-Object Name |
  ForEach-Object { "$($_.Name) $($_.Length) $((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" } |
  Set-Content $env:TEMP\golden-run1.txt
node test/parity/generate.mjs
# 重算到 golden-run2.txt 后：
Compare-Object (Get-Content $env:TEMP\golden-run1.txt) (Get-Content $env:TEMP\golden-run2.txt)   # 期望：0 行
```

## 3.5 金样已冻结（P8 起）

上面 §3 那套「随时可重新生成」的做法，**从 P8 删除 `js/**` 那一刻起就不复存在**。
这一节说明冻结的含义、封条怎么用、以及「逐手零差异」这条结论的证据链到底长什么样。

### 3.5.1 为什么冻结

生成器的数据源是**旧实现**（`js/*.js`，用 `eval` 按序加载 —— 见 §3 的「固定环境」）。
P8 之后这些文件不存在了，生成器即使保留也**跑不动**。三种处置方式里只有第一种是对的：

| 处置 | 结果 |
|---|---|
| **冻结（本仓库选择）** | 金样原样留下，生成器变成「不可用即明确报错」。金样继续作为**独立于新实现**的历史行为基线 ⭐ |
| 改写成读 `src/core` | 新实现自己验证自己：金样不再是「旧实现的行为」，而是「新实现的行为」，**证据价值归零** |
| 删掉生成器与金样 | 直接丢掉「重写没重写错」的唯一物证 |

因此 P8 后 `test/parity/generate.mjs` 的行为是：开头调用 `legacyImplementationPresent()`
（判据是 `LEGACY_FILES[0]`，即 `js/board.js` 是否存在），旧实现不在就抛 `FROZEN_NOTICE`
并 `process.exit(1)`，打印：

```
✗ 金样生成失败：✗ 旧实现已删除（P8），金样已冻结为历史文物，见 test/parity/README.md。
  要重新生成需回到删除旧实现之前的提交（js/** 与 games/** 必须同时在场）。
  请勿把本生成器改写成读 src/core —— 那样新实现就是在自己验证自己，
  金样作为「重写没写错」独立证据的价值会全部消失。
  金样的当前完整性由 test/parity/frozen.json（sha256 + 字节数）钉住，
  校验发生在 node test/engines/run.mjs 的「差分：金样文件集合与 frozen.json 完全一致」用例。
```

**它绝不静默失败**：静默失败会让下一个人以为「生成成功了」，拿着没更新的旧金样继续判断。
要真正重新生成，只能回到删除旧实现之前的提交（`js/**` 与 `games/**` 同时在场）。

### 3.5.2 封条：`test/parity/frozen.json` 怎么用

金样从此是**只读文物**：它自己没有版本控制以外的保护，改一个数字不会有任何东西察觉。
`frozen.json` 就是补上这一点——记录冻结时刻每个金样的 `sha256` 与字节数：

```jsonc
{
  "schema": "jev-qiguan-golden-freeze/v1",
  "generatedAt": "2026-10-01T09:48:20.869Z",   // 冻结时刻（说明性字段，不参与任何断言）
  "algorithm": "sha256",
  "byteUnit": "bytes",
  "files": {
    "test/fixtures/golden/gomoku.json": { "sha256": "0b588225667b6a19…", "bytes": 392361 },
    // …共 7 个文件
  }
}
```

`node test/engines/run.mjs`（或 `npm run test:engines`）里的三条用例守着它：

| 用例 | 抓什么 |
|---|---|
| 差分：金样文件集合与 frozen.json 完全一致 | **多一个文件 / 少一个文件**都红（只改内容不改集合也能绕过「文件集合」这一层，所以还有下一条） |
| 差分：每个金样的 sha256 与字节数与 frozen.json 逐字相符 | 内容被改：报出文件名 + `期望=… 实际=…`，字节数与哈希分别核对 |
| 差分：封条元数据自洽 | 算法 / 总字节数（492148）/ 冻结前提探针没被悄悄改掉 |

第 4 条守的不是金样内容而是**生成器本身**（「生成器保留 P8 拒绝重生成闸门，且绝不改读 src/core」）：
删掉 `main()` 开头的闸门、或把生成逻辑改写成 `import` `src/core`，都会当场红。

封条本身怎么来的（需要**重新冻结**时照这个做，不需要额外脚本）：

```powershell
# 在还有 js/** 的提交上重新生成金样之后执行
Get-ChildItem test/fixtures/golden/*.json | Sort-Object Name | ForEach-Object {
  "{0} {1} {2}" -f $_.Name, $_.Length, (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
}
```

把输出逐行抄进 `files`（键用仓库相对路径 `test/fixtures/golden/<棋种>.json`，`sha256` 小写 64 位、
`bytes` 十进制），并更新 `generatedAt`。**只有真的重新生成过金样才允许动这个文件**；
`generatedAt` 是给人看的说明性字段，不参与断言。

**红了怎么办**：

1. 先当成**证据被篡改**处理，而不是「测试挂了」——金样是旧行为的唯一记录，改了它
   「新旧零差异」这句话就没有意义了；
2. 用 `git diff -- test/fixtures/golden` 看是谁改的、改了什么；
3. 如果确实需要一份**新的**金样（例如要覆盖新棋种），正确做法是回到还有 `js/**` 的提交
   重新生成、重新冻结（更新 `frozen.json`），并让这件事在提交信息里留痕；
4. **不要**为了让红变绿去放宽 `frozen.json`。封条的唯一价值就是不肯让步。

### 3.5.3 「逐手零差异」的证据链

这句话（以及 `docs/` 里引用的 5510 手）不是结论，是一条可以被任何人重新走一遍的链：

```
① 旧实现（js/*.js，commit b9a261b）
        │  test/parity/generate.mjs 固定种子 42 + BG_FAST=1，同进程跑两遍逐字节自比
        ▼
② test/fixtures/golden/*.json —— 7 个文件 / 5510 手的**逐手指纹**
   （自对弈 7 局 1131 手 + 历史棋谱 54 局 4379 手；
     每手记 notation/legalCount/legalHash/stateHash/over/winner/statusHash 七个字段）
        │  冻结：sha256 + 字节数写入 frozen.json（本文 §3.5.2）
        ▼
③ test/engines/parity.test.mjs —— 用**新实现** src/core 按 notation 重放同一批棋谱
   （不 import 旧实现、不读 js/**；走 registry.ts 的真实引擎实例）
        │  逐手比对七个字段，任何一手不一致即报出「哪个引擎 / 哪一局 / 第几手 / 哪个字段」
        ▼
④ 结论：5510 手全部逐手一致；例外登记 test/parity/exceptions.json 为空数组
   （即迁移过程中一处「刻意行为变更」都没有）
```

链条上任何一环被换掉，结论立即失效：换 ① ② 就是不冻结，换 ③ 就是自证。
反过来，只要 ②③ 都在且 ④ 为空，`git log` 里就能看出新实现是**照着旧行为**长出来的。

维护规则不变（§9）：**不要手工编辑金样**。现在多说一句：手工编辑还会让 `npm run test:engines`
在「封条」两条用例上直接红——这正是它存在的意义。

## 4. 文件结构

每个文件 = 头部元数据 + 两段棋谱记录（`selfPlay` / `archive`）。

### 4.1 头部字段

| 字段 | 含义 |
|---|---|
| `schema` | 金样契约版本，当前 `jev-qiguan-golden/v1`。**行字段含义或指纹算法一变就必须 bump**（见 §8） |
| `engine` / `engineName` / `sides` | 引擎 id、中文名、双方 id 与中文名（`winner` 字段用 id，`reason` 里是中文） |
| `codeVersion` | 旧实现 `BG.codeVersion`（当前 `0.8.0`）。旧实现改行为必须 bump 这个值 |
| `commit` / `workTreeDirty` | 生成时的 `git rev-parse HEAD`；`workTreeDirty=true` 表示工作区有未提交改动，此时 `commit` 不能唯一确定代码 |
| `seed` / `bgFast` | 随机种子（42）与 mock 快速模式标记 |
| `generator` / `regenerate` | 生成器路径与重新生成命令 |
| `rowFields` | 逐手行的字段顺序（见 §4.2），TS 侧按同一顺序读 |
| `fingerprint` | 指纹算法的人类可读说明（权威定义见 §5 与生成器源码） |
| `coverage` | 覆盖计数：自对弈局/手、历史棋谱局/手、合计手数 |

### 4.2 逐手行 `moves[]`

每手一行数组，字段顺序由 `rowFields` 给出：

| # | 字段 | 含义 |
|---|---|---|
| 0 | `notation` | 本手记法（唯一稳定的着法键，也是回放时喂给 `moveFromNotation` 的入参） |
| 1 | `legalCount` | **走这一手之前** `getLegalMoves()` 的着法数 |
| 2 | `legalHash` | **走这一手之前**合法着法的指纹（见 §5） |
| 3 | `stateHash` | **走这一手之后**完整 `state` 的规范串指纹 |
| 4 | `over` | 走这一手之后 `getStatus().over`（0/1） |
| 5 | `winner` | 走这一手之后的胜方 id（未终局或和棋为空串） |
| 6 | `statusHash` | 走这一手之后 `getStatus()` 规范串指纹（**含 `reason` 全文**） |

`legal*` 记录「决策现场」（本手之前），`state*` / `over` / `winner` / `statusHash` 记录
「决策结果」（本手之后）——相邻两行首尾相接，整局状态链没有缺口。

`statusHash` 必须带 `reason` 全文：`数子：黑 31 : 白 43.5（贴 5.5）` 这类串是唯一能证明
贴目、提子计数、禁手判定的证据。新实现若算错提子，数字会先变，指纹只是把它变成红色。

### 4.3 分段

- `selfPlay`：`{ kind:'selfplay', channel:'mock', topK:3, maxPlies:600, plyLimitReached, plies,
  initialStateHash, finalStateHash, finalStatus{over,winner,reason,hash}, moves[] }`。
  走的是应用真实链路 `BG.jev.decide(channel:'mock')` → `BG.mock.decide` → `engine.mockPick`，
  **不是**直接调 `mockPick`：否则会漏掉「每手额外消耗三次随机数」这类影响后续走子的差异。
- `archive[]`：每份历史棋谱一条记录
  `{ kind:'archive', file, exported, archivedResult, archivedWinner, recordedResultMatched,
  plies, initialStateHash, finalStateHash, finalStatus, moves[] }`。
  `file` 是相对仓库根的正斜杠路径（跨平台字节一致）。

## 5. 指纹算法（TS 侧必须逐字复刻）

三个纯函数都在 [test/parity/generate.mjs](generate.mjs) 里导出，可直接 `import` 复用，
不要在新实现里另写一套（两份实现本身就是新的漂移源）：

```js
import { canonical, hash64, legalFingerprint } from './test/parity/generate.mjs';
```

1. **`canonical(v)`** —— 递归按键名排序的 JSON 串（数组保序；`undefined` → `'null'`）。
   为什么不直接 `JSON.stringify(state)`：键顺序是旧实现的构造顺序，新实现完全可能用另一种
   顺序构造同一个局面，那样比对的就不是行为而是写法。排序后「同一局面 → 同一串」。
2. **`hash64(str)`** —— FNV-1a 64 位（offset `0xcbf29ce484222325`、prime `0x100000001b3`），
   按 **UTF-16 码元**逐字符，输出 16 位小写十六进制。
   为什么不用 `crypto`：需要在 Node / 浏览器 / 未来实现里得到同一个值，纯函数最不易漂移。
   为什么按码元而非字节：`reason` 里有中文，UTF-8 与 UTF-16 的字节不同，按字节就会引入
   「两端编码假设不一致」这种与行为无关的红灯。
3. **`legalFingerprint(legal)`** = `hash64(legal.map(m => m.notation).join('\n'))`。
   **顺序是契约的一部分**：`jev-client` 的降级路径固定回退 `legal[0]`，mock 走
   `legal[rand(len)]`；顺序变了，「同一局面走同一步」就不再成立。

## 6. 迁移后 TS 实现如何比对

推荐做法：**按记法回放比对**——金样里已经固化了每一手的 `notation`，所以比对不需要
新实现复刻随机流（不要求 `BG.util.rnd` 的调用次数、顺序与旧实现一致）。步骤：

1. 用新实现 `newGame()` 起局，断言 `initialStateHash` 与金样一致；
2. 对 `moves[]` 逐行：`getLegalMoves(st)` → 断言 `legalCount` 与 `legalHash`；
   `moveFromNotation(st, row[0])` → 必须非 null（记法兼容性）→ `applyMove` →
   断言 `stateHash`、`over`、`winner`、`statusHash`；
3. 结束时断言 `finalStateHash` 与 `finalStatus.hash`。

vitest 侧按计划 §6.2 挂在 `engines-parity` project 下；`archive[]` 的记录同样按此回放
（`moveFromNotation` + `applyMove`，不需要 AI）。

失败时的定位信息必须包含：**引擎 id、来源（`selfPlay` 或 `archive.file`）、第几手
（1-based）、`notation`、字段名、期望值、实际值**。只有「不一致」而没有定位信息的报错，
在 5000+ 手规模下等于没有报错。

需要单点查证某一手时，用同一套函数现场重算：

```bash
node --input-type=module -e "
import { loadLegacyEngines, canonical, hash64 } from './test/parity/generate.mjs';
const BG = loadLegacyEngines(); const e = BG.games.go;
BG.setSeed(42); const st = e.newGame();
console.log(hash64(canonical(st)));           // 与 go.json 的 initialStateHash 对照
"
```

> ⚠️ 自对弈的**重新生成**（而不是回放比对）才要求随机流一致。如果你改了 mock 决策链
> 又想重新生成金样，注意那已经不是「迁移」而是「行为变更」，必须走 §7。

## 7. 例外登记：允许「刻意行为变更」的唯一方式

纪律来自 [ADR-0008](../../docs/adr/0008-vcfwin-defender-counterkill-gate.md)：**先造一个最小合成
局面证明旧行为确实错，再登记例外**；不许以「新实现更合理」为理由静默放宽。
比对失败时默认动作是**修新实现**，例外是例外，不是逃生门。

例外写进 [test/parity/exceptions.json](exceptions.json) 的 `exceptions[]`，每条必须含
（缺一个、或为空串，`npm run golden` 直接报错）：

| 字段 | 约束 | 说明 |
|---|---|---|
| `engine` | 非空 | 引擎 id |
| `scope` | `selfplay` / `archive` | `archive` 必须再给 `path`（`games/...json`）；`selfplay` 必须再给整数 `ply` |
| `field` | 白名单 | 只能是 `notation`/`legalCount`/`legalHash`/`stateHash`/`over`/`winner`/`statusHash`/`finalStatus`/`plies` |
| `oldFingerprint` | 非空、与 `newFingerprint` **不同** | 金样里的旧值 |
| `newFingerprint` | 非空 | 新实现的值 |
| `reason` | **≥ 40 字** | 为什么旧行为是错的、为什么必须现在改 |
| `counterexample` | **≥ 20 字** | 最小合成局面 + 期望值 / 旧实现实际值（ADR-0008 的「合成最小反例」） |
| `adr` | `ADR-NNNN` | 相关决策记录 |
| `approvedBy` / `approvedAt` | 非空 | 人类批准者与日期（agent 不能自我批准） |

生成器会加载并校验这张表，运行时打印条数；空数组表示**迁移必须逐手零差异**。
免于手工比对的部分只有「已登记且指纹与登记值吻合」的那些字段——其余一律阻断。

## 8. 已知差异与边界事实（不是错误，是被记录下来的事实）

1. **认输局**：`games/2026-09-30/jev-v9-vs-jev-v8-20260930153334.json` 归档文案是
   `黑方 获胜（认输）`，而引擎不建模「认输」（那是应用层裁决），因此该记录
   `recordedResultMatched=false`。54 局中 53 局与归档文案一致，这 1 局只记录不阻断。
2. **象棋达上限截断**：mock 对攻下象棋 600 手仍未终局，靠 `MAX_PLIES=600` 截断，
   记录为 `plyLimitReached=true`。这不是缺陷而是事实：新实现必须在**同一上限、同一手数**
   处停下，否则两边没有共同终点，比对无从谈起。
3. **`workTreeDirty=true`**：开发期生成时工作区通常有未提交改动，此时 `commit` 不能唯一
   确定代码。作为权威基线时应在干净工作区（或 CI）重新生成，并把 `workTreeDirty` 当红灯看。
4. **不记录 `meta`**：mock 决策返回的 `meta.latencyMs` 依赖 `Date.now()`，`usage`/`costUsd`
   与行为无关。金样只记录可判定的行为量，不记录噪声。
5. **`gomoku.json` 含 54 局归档**：历史棋谱全是五子棋，因此按 `gid` 全部归到该文件；
   其余 6 个引擎的 `archive` 为空数组（不是漏采）。

## 9. 维护规则

- **什么时候重新生成**：仅在「旧实现行为确实要变」并已登记例外之后；或迁移完成、
  旧实现即将删除前的最后一次固化。迁移期间金样应当是**冻结**的。
- **什么时候 bump `schema`**：改变行字段顺序/含义、改变指纹算法（`canonical`/`hash64`/
  `legalFingerprint`）、改变终局判定口径——即任何让旧金样不再可比的变化。
- **旧实现侧改动**：`js/**` 是冻结的旧实现，改它必须同时 bump `BG.codeVersion`，
  否则 `codeVersion=0.8.0` 的金样与实际代码脱钩。
- **生成器自身**：`test/parity/generate.mjs` 是唯一生成入口，它只读旧实现与 `games/`，
  不改任何既有文件；不要为了让它通过而弱化其中的断言（尤其 §3 的复现断言与 §2 的体积上限）。

## 10. 完整覆盖面明细

- **自对弈（7 局）**：gomoku、gomoku-pro、chess、xiangqi、checkers、cc、go — 每棋种一盘，
  `BG.setSeed(42)` + `channel:'mock'` + `topK:3`，上限 600 手。
- **历史棋谱（54 局 / 4379 手）**：`games/2026-09-29/`（21 份）+ `games/2026-09-30/`（33 份），
  全部只用记法重放（`moveFromNotation` + `applyMove`），覆盖五子棋真实对局分布。
- **生成时完整性参照**（`commit b9a261b`，仅供核对，非契约）：
  `gomoku 0b588225667b6a19…`、`gomoku-pro 2096bcb3bedd88ae…`、
  `chess 7824f94bd6e49997…`、`xiangqi bb0ff63608d92631…`、`checkers e20cd8f8803e7386…`、
  `cc f5a17e7925891b26…`、`go fc38d63bac2605bd…`（完整 SHA-256 见生成器输出）。
