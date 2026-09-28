# 多 Agent 协同总览

> 目标：**任何 agent 不必全量阅读项目**就能正确干活；多个 agent 可以并行或接力
> 推进同一项目而不互相踩踏。本目录是协议，入口规范在 [../../AGENTS.md](../../AGENTS.md)。

## 三种协作形态（先选形态，再动手）

| 形态 | 什么时候用 | 协议 |
|---|---|---|
| **单人直做** | 任务能在一个 agent 的一轮里完成（≤ 半天工作量、文件范围清晰） | 无额外协议；按 AGENTS.md 阅读路径 + 验收命令 |
| **接力（relay）** | 任务跨多轮/多会话（实现 → 审查 → 修复 → 部署），或一个 agent 的上下文快满了 | [handoff.md](handoff.md) |
| **并行（fan-out）** | 多个互不依赖的子任务（如同时修两个引擎的 bug、同时写文档与代码） | [parallel-work.md](parallel-work.md) |

判断口诀：**任务之间没有共享文件 → 并行；有先后依赖 → 接力；都不满足 → 单人。**

## 五条黄金法则

1. **按阅读路径读，不全量读。** 每个 agent 只读 [reading-paths.md](reading-paths.md) 里
   自己任务对应的文档 + 指名的文件。读完还不懂，先问编排者，不要顺手通读代码库。
2. **一次只有一个 owner 能写一个文件。** 并行前先认领文件（见 parallel-work.md 的所有权矩阵）。
3. **上下文只从 handoff + memory 恢复。** 接手任务时读 `.work/handoff.md` 与
   [../memory/MEMORY.md](../memory/MEMORY.md) 最新 3 条，**禁止**从头读全部源码。
4. **完成 = 验收命令通过 + 文档更新 + memory 置顶一条。** 三者缺一不可，
   没跑 `node test/run-tests.js` 不许说"完成"。
5. **不知道就停下来问。** 需求模糊/发现设计冲突时，把问题写进 handoff 的「未解决」节，
   交回编排者，不要自行假设。

## 推荐流程

```
编排者（不写代码）
  ├─ 拆任务 → 每个任务写清：目标 / 必读文档 / 可改文件 / 验收标准
  ├─ 判定形态：单人 / 接力 / 并行
  ├─ 并行时发「文件所有权表」；接力时要求上一个 agent 写 handoff
  └─ 收口：跑验收命令、合并进 main、确认 memory/status 更新

实现者 / 审查者 / 测试者（按 roles.md 角色卡干活）
  └─ 只改自己名下的文件；结束时写 handoff（接力）或直接汇报（单人）
```

## 目录

| 文档 | 内容 |
|---|---|
| [roles.md](roles.md) | 五种角色卡：编排者/引擎实现者/Jev 集成者/UI 开发者/审查者 |
| [reading-paths.md](reading-paths.md) | 任务 → 最小阅读矩阵（避免全量阅读的核心） |
| [handoff.md](handoff.md) | 接力协议：handoff 文件位置、模板、恢复步骤 |
| [parallel-work.md](parallel-work.md) | 并行规则：文件所有权矩阵、提交粒度、冲突处理 |
| [playbooks.md](playbooks.md) | 常见任务操作手册：新棋种/修 bug/改 prompt/部署 |
