# 多 Agent 协作协议

> 入口规范是 [AGENTS.md](../../AGENTS.md)；本文只讲**多个 agent 同时在一个仓库里干活时怎么不打架**。
> 单人开发时看 §1 的所有权表 + §4 的提交粒度就够了。

## 1. 三种协作形态

| 形态 | 什么时候用 | 读什么 |
|---|---|---|
| **单人直做** | 任务小、只碰一两个文件 | [reading-paths.md](reading-paths.md) 找到入口文件就能开工 |
| **接力** | 一个任务跨多轮会话，或前一班没做完 | 写 [handoff.md](handoff.md)，下一班从 handoff + memory 最新 3 条恢复 |
| **并行** | 两个以上互不依赖的任务同时推进 | [parallel-work.md](parallel-work.md) 划所有权，本文是总纲 |

判断口诀：**任务之间共享文件吗？** 不共享 → 并行；共享 → 要么拆干净，要么接力。

## 2. 五条黄金法则

1. **按阅读路径读，不要全量读**——[reading-paths.md](reading-paths.md) 给的是「这个任务最少要读哪些文件」。
   全量读一个 6000+ 行、上百文件的 `src/**` 是纯浪费，而且会让 agent 抓错重点。
2. **一次只有一个 owner 能写一个文件**——包括你「只是顺手改一下」的文件。所有权表见
   [parallel-work.md](parallel-work.md) §1。
3. **上下文只从 handoff + memory 恢复**——接手时读 [handoff.md](handoff.md) 约定的
   `.work/handoff.md`（不入库）与 [../memory/MEMORY.md](../memory/MEMORY.md) 最新 3 条，不要从零重读代码。
4. **完成 = 验收命令通过 + 文档更新 + memory 置顶一条**。没跑 `npm test` 与 `npm run check:docs`，
   不许说「完成」；改了行为没更新 [../status.md](../status.md)，也不算完成。
   （改动落在引擎/战术层时至少跑 `npm run test:engines`；落在 Worker 层跑 `npm run test:worker`；
   纯 UI 层跑 `npm run test:ui`——其余由 `npm run test:new` 的对应 project 覆盖。）
5. **不知道就停下来问**——不要用「猜一个合理实现」填补不确定的契约。契约类不确定（接口、
   错误码、数据字段）必须找人确认；实现细节类不确定可以先记进 handoff 再问。

## 3. 推荐流程

```
编排者：
  1. 拆任务 → 判断形态（单人 / 接力 / 并行）
  2. 并行时先发所有权表（谁写哪些文件），互相不重叠才允许开工
  3. 每个任务给出「验收命令」与「必读文件」
  4. 收口：合并前自己跑一遍全量验收（npm test + npm run check:docs），再决定是否 push

实现者：
  1. 按 roles.md 认领角色 → 按 reading-paths.md 读最少必要文件
  2. 干活（只碰自己名下的文件）
  3. 跑验收命令 → 更新文档（status.md / memory / 必要时 ADR）
  4. 需要改公共文件时，写进 handoff 交给编排者，不要自己动手
```

**编排者不写业务代码**——这是为了保证「所有权仲裁」这件事有唯一裁决人（[roles.md](roles.md) §编排者）。

## 4. 目录一览

| 文件 | 内容 |
|---|---|
| [roles.md](roles.md) | 五种角色卡：能改什么、必读什么、禁止什么 |
| [reading-paths.md](reading-paths.md) | 任务类型 → 最少必读文件 → 直接下手改哪一行 |
| [handoff.md](handoff.md) | 接力协议：`.work/handoff.md` 该写什么 |
| [parallel-work.md](parallel-work.md) | 并行协议：文件所有权矩阵、热点文件纪律、冲突处理 |
| [playbooks.md](playbooks.md) | 常见任务的固定套路（新增棋种 / 修规则 bug / 改 Jev / 改 UI / 发版） |
