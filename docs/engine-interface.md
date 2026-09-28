# 引擎统一接口契约

> 写新引擎、改旧引擎前必读。目标：**任何一个 agent 只靠本文档 + 一个样板引擎
> （`js/games/gomoku.js`）就能正确产出/修改引擎**，不需要读其它五个引擎。

## 1. 注册

```js
// js/games/<id>.js，IIFE，挂到 BG
(function () {
  /* ...内部函数... */
  BG.register({
    id: 'mygame',                 // 唯一 id，同时是 app.js GAME_ORDER 的值、commit scope 名
    name: '我的棋',                // UI 显示名
    sides: [                      // 双方，first:true 的为先手
      { id: 'black', name: '黑方', first: true },
      { id: 'white', name: '白方' },
    ],
    /* 必需方法 ↓ */
    newGame, getLegalMoves, applyMove, getStatus, moveFromNotation,
    serializeForJev, draw, humanClick, selfTest,
    /* 可选方法 ↓ */
    // passMove, mockPick
  });
})();
```

注册后还要做两件事（缺一不可）：

1. `js/app.js` 顶部 `GAME_ORDER = [...]` 加入 id（决定 tab 顺序）；
2. `test/run-tests.js` 的加载清单加入 `js/games/<id>.js`（在 `board.js` 之后）。

## 2. 方法契约

| 方法 | 签名 | 返回 | 约束 |
|---|---|---|---|
| `newGame()` | `() => st` | 初始 state | JSON 可克隆；不放函数/DOM |
| `getLegalMoves(st)` | `st => move[]` | 全部合法着法 | 可重复调用；**顺序稳定**（`legal[0]` 是回退项，别放随机） |
| `applyMove(st, move)` | `(st, move) => st` | **新** state | 纯函数，禁止改入参 |
| `getStatus(st)` | `st => {over, turn, winner?, reason?}` | 终局判定 | `over:false` 时至少给 `turn` |
| `moveFromNotation(st, n)` | `(st, n) => move \| null` | 解析记法 | 非法/已占用返回 `null`（自检依赖此行为） |
| `serializeForJev(st, side)` | `(st, side) => {state, questions, options}` | Jev 请求体 | 见 §4 |
| `draw(ctx, st, ui)` | 渲染 | — | 只用 `BG.gfx.*`；逻辑像素坐标 |
| `humanClick(st, ui, x, y)` | `(st, ui, x, y) => move \| null` | 点击→着法 | 多步着法（连跳）用 `ui` 存中间态 |
| `selfTest()` | `() => void` | 抛异常即失败 | 见 §5 |
| `passMove(st)`（可选） | 停一手 | move | 仅围棋类需要 |
| `mockPick(st, moves, side)`（可选） | 启发式选点 | move | 给离线演示用 |

### move 对象

```js
{ notation: 'H8', desc: '可选，人类可读描述', /* 引擎私有字段：r/c/from/to/captured... */ }
```

- `notation` 是 Jev Choice 选项的键：**全局唯一、稳定、短**（建议 ≤6 字符，累计局面对 token 敏感）。
- `desc` 用于走子记录展示，没有就 `null`。

## 3. 纯函数与克隆

- state 里出现的每个值都必须能被 `BG.util.clone`（JSON 深拷贝）复制。
- 需要"试走"（如 mockPick 判断能否赢）时：`const s = BG.util.clone(st); ...`，**不要改原 state**。

## 4. serializeForJev 契约

```js
{
  state: {
    game: 'gomoku (five-in-a-row) on 15x15 board, columns A-O left to right, rows 1-15 top to bottom',
    you_play: side,
    move_number: st.moveNum + 1,
    /* 局面本体：坐标记法数组 / 字符串 */
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
   （参照 `gomoku.js` 的 `candidates(st, 64)`；当前实现为确定性截断，无随机补齐）。
3. 三问（choice/noul/score）必须**同一次请求全部发出**——并行评估是 Jev 的核心用法，
   不要拆多次调用（ADR-0001 之外的成本/延迟考量见 docs/jev-api.md）。
4. `criteria` 写得越具体概率越可信；`move` 的 instructions 里写清"只回答 Choice 问题 move"。
5. `state` 要能让一个不懂本项目的人/模型复盘：包含盘面说明、轮次、上一手。

## 5. selfTest 约定

用 `BG.util.assert(cond, msg)` 写断言，覆盖：

- [ ] `newGame()` 后 `getLegalMoves` 非空且全部 `applyMove` 后 `getStatus` 不抛；
- [ ] 记法往返：`moveFromNotation(st, n)` 对每个 `getLegalMoves(st)` 的 notation 都非 null；
- [ ] 已占点/非法输入返回 `null`；
- [ ] 该棋种的标志性规则各至少一条（如国际象棋易位/吃过路兵/升变；围棋提子/劫/禁自杀）；
- [ ] 终局可达：构造一个简短杀局/和局序列，断言 `getStatus().over`；
- [ ] （重引擎）move generator 计数已知值：国际象棋 perft(1/2/3) = 20/400/8902。

跑：`node test/run-tests.js`（Node）或 `index.html?test=1`（浏览器）。

## 6. 新增棋种完整清单

见 [agents/playbooks.md §1](agents/playbooks.md)。最小清单：
新建引擎文件 → 注册 → `GAME_ORDER` → 测试清单 → `selfTest` → README 目录结构/玩法 →
status.md（已验证+已知限制）→ memory 置顶条目 → commit。
