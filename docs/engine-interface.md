# 引擎统一接口契约

> 写新引擎、改旧引擎前必读。目标：**任何一个 agent 只靠本文档 + 一个样板引擎
> （[../src/core/engines/gomoku.ts](../src/core/engines/gomoku.ts)）就能正确产出/修改引擎**，
> 不需要读其它五个引擎。
>
> 本文描述的是 **2026-10-01 迁移之后**的 TypeScript 实现（ADR-0012）。类型定义在
> [../src/core/types.ts](../src/core/types.ts)，注册表在 [../src/core/registry.ts](../src/core/registry.ts)——
> 两者与本文不一致时，**以磁盘代码为准**。
>
> 旧实现（2026-10-01 前）：`js/games/*.js`，IIFE 挂 `BG` 命名空间、`BG.register()` 自注册、
> 靠 `index.html` 的 script 标签顺序加载。那段历史只在本节保留一句，下文全部按新实现写。

## 1. 注册

引擎文件放在 `src/core/engines/<id>.ts`，导出**工厂函数**或**引擎常量**，再由注册表汇总：

```ts
// src/core/engines/mygame.ts
import type { Engine } from '../types.ts';

export const mygame: Engine = {
  id: 'mygame',                  // 唯一 id，同时是 record-map 的 game_id 与 commit scope 名
  name: '我的棋',                 // UI 显示名，也是 D1 `games.game` 列的值
  sides: [                       // 双方，first: true 的为先手
    { id: 'black', name: '黑方', first: true },
    { id: 'white', name: '白方' },
  ],
  meta: { w: 480, h: 480 },      // 画布逻辑尺寸（board-render 用它做 DPR setup）
  supportsPass: false,           // 可选能力声明
  supportsResign: true,
  // deepTactics: true,          // 候选点是无色差空点集时声明（见下）

  newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
  serializeForJev, selfTest,     // 必需方法
  draw, humanClick,              // 渲染与交互（可选，但 UI 需要）
  // passMove, mockPick, vcfWin  // 其它可选能力
};
```

```ts
// src/core/registry.ts —— 注册表（新增棋种的唯一注册点）
export const games: Record<string, Engine> = {
  'gomoku': gomoku, 'gomoku-pro': gomokuPro, 'go': go, 'xiangqi': xiangqi,
  'chess': chess, 'checkers': checkers, 'cc': chineseCheckers,
};
export const ids: string[] = Object.keys(games);   // 注册顺序 = UI tab 顺序
export function getGame(id: string): Engine | undefined;
```

**一个文件注册多个引擎**（同一套逻辑、开关区分）：用工厂函数产出两份实例。
样板见 [../src/core/engines/gomoku.ts](../src/core/engines/gomoku.ts) 的
`export function createGomoku(id: string, name: string, forbidden: boolean): Engine<GomokuState>`，
它在 [../src/core/registry.ts](../src/core/registry.ts) 被调用两次，产出 `gomoku` 与 `gomoku-pro`。
注意：两份引擎的 `selfTest()` 都要覆盖各自的规则分支。

`deepTactics: true` 的含义：候选点是无色差空点集（如五子棋落子点）时声明，
[../src/core/jev/client.ts](../src/core/jev/client.ts) 会在 1-ply 无战术时跑 2-ply 造杀扫描，
并由战术保险按 `win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4`
接管（详见 [jev-api.md §2.2](jev-api.md)）。

## 2. 方法契约

类型签名见 [../src/core/types.ts](../src/core/types.ts) 的 `interface Engine<S = any>`。

| 方法 | 签名 | 返回 | 约束 |
|---|---|---|---|
| `newGame()` | `() => S` | 初始 state | JSON 可克隆；不放函数/DOM |
| `getLegalMoves(st)` | `(st: S) => Move[]` | 全部合法着法 | 可重复调用；**顺序稳定**（`legal[0]` 是回退项，别放随机） |
| `applyMove(st, move)` | `(st: S, move: Move) => S` | **新** state | 纯函数，禁止改入参（ADR-0004） |
| `getStatus(st)` | `(st: S) => GameStatus` | 终局判定 | `over:false` 时至少给 `turn` |
| `moveFromNotation(st, n)` | `(st: S, n: string) => Move \| null` | 解析记法 | **双参契约**，漏传 `st` 会炸（已踩过）；非法/已占用返回 `null`（自检依赖此行为） |
| `serializeForJev(st, side)` | `(st: S, side: string) => JevSerialized` | Jev 请求体 | 见 §4 |
| `selfTest()` | `() => void` | 抛异常即失败 | 见 §5 |
| `draw(ctx, st, ui)`（可选） | `(ctx: Canvas2D, st: S, ui: UiState) => void` | — | 只用 `src/core/gfx.ts` 的绘图原语；逻辑像素坐标 |
| `humanClick(st, ui, x, y)`（可选） | `(st: S, ui: UiState, x: number, y: number) => Move \| null` | 点击→着法 | 多步着法（连跳）用 `ui` 存中间态 |
| `passMove(st)`（可选） | `(st: S) => Move \| { notation: string }` | 停一手 | 仅围棋类需要（`supportsPass: true`） |
| `mockPick(st, moves, side, cfg?)`（可选） | `(st, moves: Move[], side: string, cfg?: PickConfig) => Move \| null \| undefined` | 启发式选点 | 给离线演示用 |
| `vcfWin(st, attackerId, maxPlies)`（可选） | `(st, attackerId: string, maxPlies: number) => VcfResult` | `{win, first, line}` | 配 `deepTactics` 的引擎提供；`st.turn` 须为 `attackerId`；`first` 为首步记法（进攻=走法，防守=干预点）；无链返回 `{win:false, first:null, line:[]}`；禁手等规则自行内化 |

接口还有索引签名 `[k: string]: unknown`，引擎可以带私有字段与私有方法（如五子棋的
`candidates`）——`serializeForJev` 注入的 `tactics`/`experience` 也走同一个对象。

三个刻意的宽松点（写新引擎时别当成"可以乱来"）：`turn` 是 `string` 而不是联合类型；
有索引签名；可选方法用 `?`，因为六个引擎并非都实现 `passMove`/`mockPick`/`vcfWin`。

### move 对象

```ts
{ notation: 'H8', desc: '可选，人类可读描述', /* 引擎私有字段：r/c/from/to/captured... */ }
```

- `notation` 是 Jev Choice 选项的键：**全局唯一、稳定、短**（建议 ≤6 字符，累计局面对 token 敏感）。
- `desc` 用于走子记录展示，没有就 `null`。

## 3. 纯函数与克隆

- state 里出现的每个值都必须能被 [../src/core/clone.ts](../src/core/clone.ts) 的 `clone(o)`
  复制——它刻意走 **JSON 往返**而不是 `structuredClone`：旧实现就是 JSON 往返，
  任何「JSON 表达不出来」的值（函数/`undefined`/`Date`）在旧实现里本来就会丢失，
  换成 `structuredClone` 会悄悄改变行为。
- 需要"试走"（如 `mockPick` 判断能否赢、战术推算）时：`const s = clone(st); ...`，
  **不要改原 state**。
- 断言用 [../src/core/assert.ts](../src/core/assert.ts) 的 `assert(cond, msg)`：
  失败抛 `Error('assert failed: ' + msg)`，这条前缀是自检失败定位的约定，不能改。

## 4. serializeForJev 契约

```ts
{
  state: {
    game: 'gomoku (five-in-a-row) on 15x15 board, columns A-O left to right, rows 1-15 top to bottom',
    rules: 'Free-style gomoku, no forbidden moves: first to align five or more of their own stones ... wins; ...',
    you_play: side,
    move_number: st.moveNum + 1,
    board_ascii: '...',                // 五子棋：裁剪字符画棋盘（见 §4.1）
    legal_moves: ['H8', ...],          // 与 options 完全一致
  },
  questions: {
    move:     { type: 'choice', instructions: '...', criteria: {...}, options },
    edge:     { type: 'noul',   instructions: '...', criteria: { true: '...', false: '...' } },
    position: { type: 'score',  instructions: '...', criteria: [0-10 各档描述] },
  },
  options,                              // choice 选项数组 = legal_moves
}
```

硬约束：

1. **`state` 与 `instructions` 一律英文**（中文精度较低，ADR-0002）。
2. **Choice 选项 ≤ 255**（Jev 上限）。超出必须预筛：邻近已有棋子 + 星位/关键点 + 按价值排序截断
   （参照 `gomoku.ts` 的 `candidates(st, 64)`；当前实现为确定性截断，无随机补齐）。
3. 三问（choice/noul/score）必须**同一次请求全部发出**——并行评估是 Jev 的核心用法，
   不要拆多次调用（成本/延迟考量见 [jev-api.md](jev-api.md)）。
4. `criteria` 写得越具体概率越可信；`move` 的 instructions 里写清"只回答 Choice 问题 move"。
5. `state` 要能让一个不懂本项目的人/模型复盘：包含盘面说明、轮次、上一手。
6. **`state.rules` 必填**（2026-09-29 起，契约测试有断言）：2 句左右的英文规则摘要，写
   「胜负条件 + 本项目采用的特殊规则/参数」（如贴目、强制跳吃、无禁手），与引擎实现严格一致。
   模型的预训练规则知识可能与本项目口径不一致，规则细节必须随局面每手重发。
7. **`criteria` 保留标签**（2026-09-29 起）：棋类引擎可为选项标注引擎验证过的战术含义，
   `decide()` 据此做战术保险——保留标签 `you:open4`（己方活四点，对方无先手五时必胜）
   会触发 open4 级接管；预挡类标签 `deny:open4`/`deny:live3`（parry3）与 `deny:four`（parry4）
   触发对应预挡级接管。标签用 `+` 连接组合效果。文本值 `null` = 无战术含义的静点。
8. **禁手变体**（2026-09-30 起）：`gomoku-pro` 示范——禁手点从 `getLegalMoves` 剔除、
   序列化里以 `state.forbidden_points_black` 声明（黑方视角），`state.rules` 写清禁手规则。
   与大众版共用工厂时，`selfTest` 必须各覆盖一份。

### 4.1 五子棋的 `board_ascii`（唯一使用字符画的引擎）

`gomoku.ts` 在 `state.board_ascii` 里放**裁剪到有子区域外扩 2 格**的字符画（列字母表头 +
行号，`X`/`O` = 黑白子，小写 = 最后一手；空盘裁到天元 5×5），并在 `questions.move.instructions`
里要求模型「以 `board_ascii` 为真实棋盘」并「逐格核对」。裁剪/图例/末手标记有契约断言。

全仓只有 `gomoku.ts` 用这个名字：**拼写是 `board_ascii`（snake_case），不存在 `asciiBoard`**。

## 5. selfTest 约定

用 `assert(cond, msg)` 写断言，覆盖：

- [ ] `newGame()` 后 `getLegalMoves` 非空且全部 `applyMove` 后 `getStatus` 不抛；
- [ ] 记法往返：`moveFromNotation(st, n)` 对每个 `getLegalMoves(st)` 的 notation 都非 null；
- [ ] 已占点/非法输入返回 `null`；
- [ ] 该棋种的标志性规则各至少一条（如国际象棋易位/吃过路兵/升变；围棋提子/劫/禁自杀）；
- [ ] 终局可达：构造一个简短杀局/和局序列，断言 `getStatus().over`；
- [ ] （重引擎）move generator 计数已知值：国际象棋 perft(1/2/3) = 20/400/8902。

跑：`npm run test:engines`（Node 直载，`node test/engines/run.mjs`）或页面右上角自检入口。

## 6. 新增棋种完整清单

见 [agents/playbooks.md §1](agents/playbooks.md)。按新实现落到文件：

1. 新建 `src/core/engines/<id>.ts`（样板：[../src/core/engines/gomoku.ts](../src/core/engines/gomoku.ts)），
   实现全部必需方法 + `selfTest()`；
2. 在 [../src/core/registry.ts](../src/core/registry.ts) 注册 id（顺序即 tab 顺序）；
3. 在 [../src/shared/record-map.ts](../src/shared/record-map.ts) 的 `GAME_NAME_TO_ID` 加
   中文名 ↔ id（D1 `games.game` 存中文名，`game_id` 由它反查）；
4. 在 [../src/ui/panels/openings.ts](../src/ui/panels/openings.ts) 的棋种筛选里加 id（与 `GAME_IDS` 同序）；
5. 给 `test/engines/` 加该引擎的自检覆盖（`test/engines/engines.test.mjs` 会自动跑 `ids` 全体）；
6. 若要进金样差分：`npm run golden` 重生成 `test/fixtures/golden/*.json`，
   并在 [../test/parity/README.md](../test/parity/README.md) 登记；
7. 收口文档：README「目录结构/玩法说明」、[status.md](status.md)（已验证 + 已知限制）、
   [memory/MEMORY.md](memory/MEMORY.md) 置顶一条、commit。
