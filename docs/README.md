# docs/ — 文档地图

> 入口在 [../AGENTS.md](../AGENTS.md)。本目录是项目的**持久记忆与规范**，随代码一起进仓库，
> 与任何具体 agent 工具（.workbuddy/.claude/.zcode…）无关。

## 文档地图

```
docs/
├── README.md               ← 本文件：索引
├── status.md               ← 当前状态 / 已验证 / 已知限制 / 设计例外 / 路线图（改行为必更新）
├── architecture.md         ← 架构地图：文件职责、数据流、关键不变量
├── engine-interface.md     ← 棋种引擎统一接口契约 + 新棋种接入指南
├── jev-api.md              ← Jev API 契约、四渠道、错误重试、成本模型
├── memory/
│   └── MEMORY.md           ← 项目记忆，【新条目在最上面】
├── adr/                    ← 架构决策记录（一次一文件，不可改历史）
│   ├── README.md
│   ├── 0001-pure-static-no-build.md
│   ├── 0002-coordinate-notation-state.md
│   ├── 0003-byok-proxy.md
│   └── 0004-unified-engine-interface.md
├── plans/                  ← 实施计划（完成后保留为历史记录，标注状态）
│   ├── 2026-09-28-board-games-mvp.md            ✅ 已完成
│   ├── 2026-09-29-iteration-02-play-loop.md     ✅ 已完成（优化轮）
│   ├── 2026-09-29-iteration-03-calibration-lab.md ✅ 已完成（创意轮）
│   └── 2026-09-29-iteration-04-frontend-polish.md ✅ 已完成（前端轮）
├── superpowers/
│   └── plans/
│       └── 2026-09-28-board-games-hardening.md   ✅ 已完成（仓库硬化）
└── agents/                 ← 多 Agent 协同 / 接力协议
    ├── README.md           ← 协同总览：什么时候单人做、什么时候接力、什么时候并行
    ├── roles.md            ← 角色卡（职责 / 必读 / 可改文件 / 验收）
    ├── reading-paths.md    ← 任务 → 最小阅读矩阵（避免全量阅读）
    ├── handoff.md          ← 接力协议 + handoff 模板
    ├── parallel-work.md    ← 并行协作规则：文件所有权、冲突处理
    └── playbooks.md        ← 常见任务操作手册（新棋种/修 bug/改 prompt/部署）
```

## 什么时候读哪篇

| 我想… | 读 |
|---|---|
| 30 秒了解项目 | [../README.md](../README.md) |
| 知道项目现在到什么程度 | [status.md](status.md) |
| 搞清楚代码怎么组织的 | [architecture.md](architecture.md) |
| 写/改一个棋种引擎 | [engine-interface.md](engine-interface.md) |
| 动 Jev 请求相关 | [jev-api.md](jev-api.md) |
| 改 UI / 样式 / 可访问性 | [status.md](status.md)「设计例外」+ [architecture.md](architecture.md) 文件职责表 |
| 接手一个进行中的任务 | [agents/handoff.md](agents/handoff.md) + [memory/MEMORY.md](memory/MEMORY.md) 最新 3 条 |
| 和别的 agent 并行干活 | [agents/parallel-work.md](agents/parallel-work.md) |
| 回忆「为什么当初这么设计」 | [adr/](adr/README.md) |
| 回忆「某轮迭代做了什么」 | [plans/](plans/)（每篇标了轮次类型与状态） |

## 维护规则

1. **memory 新条目置顶**（`docs/memory/MEMORY.md`），按日期倒序，一条一事。
2. `status.md` 的「当前状态 / 已知限制 / 设计例外」随每次行为变更更新，不写流水账。
3. ADR 只增不改：结论变了就写新 ADR 并在旧篇头部标注「已被 ADR-xxxx 取代」。
4. `plans/` 里的计划完成后把标题状态改为 ✅ 已完成，保留作为决策上下文。
5. **`plans/` 按轮次类型命名**（`iteration-NN-<类型>-<主题>.md`，类型 ∈ 优化/创意/前端），
   这样从目录名就能看出轮换是否均衡。
