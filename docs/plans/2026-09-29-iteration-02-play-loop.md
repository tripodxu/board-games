# 迭代 02 · 对局循环健壮性与渲染开销（优化轮）

> 状态：✅ **已完成**（2026-09-29）。四步流程：规划（本文件）→ 执行 → 验证 → 反思，
> 结论见 [../memory/MEMORY.md](../memory/MEMORY.md) 置顶条目「2026-09-29 · 悔棋回路修复」。
> 轮次定位：按「优化 → 创意 → 前端」轮换，本次为**优化**轮，只做一件事：
> 把 `js/app.js` 的**对局循环**从「能跑」推到「不出错、不空转、不留残影」。

## Phase 0 · 文档发现（已由本轮全量阅读完成）

约束来源（先读规范，再动代码）：

| 来源 | 关键约束 |
|---|---|
| `AGENTS.md` §2 | 引擎与 UI 解耦；改完必须 `node test/run-tests.js` 全绿；文档随代码更新 |
| `docs/architecture.md` §3 | **`epoch` 计数器是防竞态不变量**；`applyMove/getLegalMoves/getStatus` 必须是纯函数 |
| `docs/engine-interface.md` §2 | `moveFromNotation` 对每个合法着法的 notation 必须非 null（**记法往返是硬契约**） |
| `docs/engine-interface.md` §3 | state 必须 JSON 可克隆；试走要 `BG.util.clone`，不得改原 state |
| `docs/agents/playbooks.md` §4 | 改 UI 保留 `epoch` 防护与 `?test=1`；设置项进 `loadSettings/saveSettings` |
| `docs/status.md` 技术债 | `app.js` 是最大单文件，继续膨胀应先拆「记录/统计」与「对局循环」 |

**可用 API（已逐文件核对，不臆造）**：
`engine.newGame/getLegalMoves/applyMove/getStatus/moveFromNotation`、`BG.util.clone`、
`BG.util.assert`。**不可用**：模块系统、增量编译、任何第三方库。

## Phase 1 · 缺陷复现（先证伪/证实，不改代码）

对 `js/app.js` 做定点代码走查（grep 交叉验证），得到三条**确证**结论：

### 缺陷 A（正确性·高）悔棋后 AI 回合永不续弈

`undo()`（app.js:630-649）末尾只做 `rebuildLedger/renderAnalytics/renderCockpit/renderFeed/redraw`，
**没有任何 `setTimeout(aiStep, ...)`**。而 `playMove()`（:256）与 `startGame()`（:218）都会调度。

- 机机模式：`steps` 恒为 1，悔棋后轮到 Jev，但无人调度 → **对局永久卡死**。
- 界面此时显示 `白方 · 等待 Jev`（`updateTurnBadge` 由 `redraw` 触发），**误导用户**。

### 缺陷 B（正确性·中）悔棋后状态条残留「终局」

`finishGame()`（:225）写 `setStatus('终局 · …', true)`；`undo()` 从不调用 `setStatus`，
也不复位 `retryBtn`、不恢复 `pauseBtn/stepBtn`（`finishGame` 在 :227-228 把它们隐藏了）。
结果：终局后点悔棋，棋盘回到残局、回合正常流转，但**状态条仍写「终局 · 黑方 获胜」**。

### 缺陷 C（性能·中）决策流 O(n²) 重建

`renderFeed()`（:569-611）每手棋都 `feed.innerHTML=''` 后重建最多 `FEED_MAX=40` 张卡，
每张卡含概率条 + 置信度 SVG 仪表。cc 集成对局 138 手 → 约 5.5k 张卡、5 万+ DOM 节点，
绝大多数是重复劳动。真实渠道下每手还要等 0.5–1.5s，DOM 抖动与推理叠加更明显。

### 缺陷 D（内存·中）history 持有每一手的全量 state 快照

`playMove()`（:246）`{ prev: S.st, … }`。cc 的 state 是 17×25=425 格数组，
138 手即常驻约 5.9 万个格值；chess 64、go 81 同理。而 `prev` 全仓库**只有一处读取**
（`undo()` :641），且 `applyMove` 本身是纯函数（返回新对象），快照从不被修改。

**替代方案**：只存 notation，悔棋时用 `moveFromNotation` 从 `newGame()` 重放。
依据 `docs/engine-interface.md` §2「记法往返是硬契约」，六个引擎都已实现，
记忆里「2026-09-27」也确认过记法是稳定键。内存从 O(n·|state|) 降到 O(n·|notation|)，
悔棋代价从 O(|state|) 克隆变成 O(n) 次纯函数调用——n ≤ 400，可忽略。

## Phase 2 · 实施（4 处改动，均在 `js/app.js` + 1 处测试）

| # | 改动 | 位置 | 对应缺陷 |
|---|---|---|---|
| 1 | 新增 `rebuildState(n)`：从 `newGame()` 重放前 n 手记法 | app.js `undo()` 附近 | D |
| 2 | `playMove` 不再存 `prev`；`undo()` 改用 `rebuildState(S.history.length)` | app.js :246 / :641 | D |
| 3 | `undo()` 收尾：复位状态条、隐藏 `retryBtn`、按模式恢复 `pause/step`、必要时调度 `aiStep` | app.js `undo()` | A + B |
| 4 | `renderFeed()` 拆成 `feedCard(h, animate)` + 增量：只前插新卡、超出 `FEED_MAX` 丢最旧 | app.js :569 | C |

**反模式护栏**：
- 不得删/弱化 `epoch` 防护（architecture.md §3 明列为核心不变量）。
- 不得让引擎改入参 state；`rebuildState` 只能通过 `applyMove` 产生新 state。
- 不得新增 `S.history` 的第三个读取点来「顺便」用 `prev`——`prev` 字段直接删除。
- `renderFeed()` 保留「全量重建」入口给 `resetSession/undo` 调用（状态可能被回退）。

## Phase 3 · 验证

1. `node test/run-tests.js` 全绿（含新增断言，见下）。
2. **新增回归断言**（`test/run-tests.js` 的 `playOut`）：整盘对局后**只用记法重放**，
   断言终局 state 与原 state 深度相等 —— 这是缺陷 D 的直接护栏，
   一次覆盖 gomoku / cc / go 三个棋种。
3. `npm run check:docs` 文档校验通过。
4. 浏览器 `index.html?test=1` 自检同源通过。
5. 人工走查：机机模式跑若干手 → 悔棋 → 确认 Jev 续弈、状态条复位、暂停/单步按钮复原。

## Phase 4 · 文档

- `docs/status.md`：技术债条目更新（`app.js` 的 O(n²) 渲染与快照内存已清）。
- `docs/memory/MEMORY.md`：**置顶**一条（缺陷 A/B 的根因与修法、重放方案依据）。
- `CHANGELOG.md`：0.1.1 条目（用户可感知：悔棋后可续弈）。

## 风险与回退

- 重放依赖记法往返；若某引擎记法不可逆，缺陷 D 的断言会立刻红——这是**期望行为**，
  说明该引擎违反了 `engine-interface.md` §2，应改引擎而不是回退本方案。
- 增量 `renderFeed` 只增不改渲染函数签名；若出现卡片错位，回退到全量重建入口即可，
  功能正确性不受影响。
