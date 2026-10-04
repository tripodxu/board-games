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
├── jev-api.md              ← Jev API 契约、五渠道 + random 基线、错误重试、成本模型
├── memory/
│   └── MEMORY.md           ← 项目记忆，【新条目在最上面】
├── adr/                    ← 架构决策记录（一次一文件，不可改历史）
│   ├── README.md
│   ├── 0001-pure-static-no-build.md
│   ├── 0002-coordinate-notation-state.md
│   ├── 0003-byok-proxy.md
│   ├── 0004-unified-engine-interface.md
│   ├── 0005-zero-dep-node-backend.md
│   ├── 0006-rapfi-wasm-opponent.md
│   ├── 0007-vcf-threat-space-search.md
│   ├── 0008-vcfwin-defender-counterkill-gate.md
│   ├── 0009-tactics-version-registry.md
│   ├── 0010-worker-static-assets-replaces-pages.md
│   ├── 0011-d1-authoritative-persistence.md
│   ├── 0012-vite-typescript-build-chain.md
│   ├── 0013-anonymous-device-identity-and-d1-ratelimit.md
│   ├── 0014-live3-real-lookahead.md
│   ├── 0015-vct-continuous-threats.md
│   ├── 0016-vct-defense.md
│   ├── 0017-pressure-gate.md
│   ├── 0018-live3-fresh-correction.md
│   ├── 0019-remote-batch-experiments.md
│   ├── 0020-tactics-fidelity-freeze.md
│   └── 0021-standalone-experiment-plane.md
├── plans/                  ← 实施计划（完成后保留为历史记录，标注状态）
│   ├── 2026-09-28-board-games-mvp.md            ✅ 已完成
│   ├── 2026-09-29-iteration-02-play-loop.md     ✅ 已完成（优化轮）
│   ├── 2026-09-29-iteration-03-calibration-lab.md ✅ 已完成（创意轮）
│   ├── 2026-09-29-iteration-04-frontend-polish.md ✅ 已完成（前端轮）
│   ├── 2026-09-29-iteration-05-backend-polish.md  ✅ 已完成（后端化 + 全量打磨）
│   ├── 2026-10-01-workers-d1-rebuild.md           ✅ 已完成（2026-10-01；架构轮：Worker + D1 全面重构）
│   ├── 2026-10-02-tactics-v10-live3.md            ✅ 已完成（2026-10-02；战术 v10：活三真推演 + 对照实验）
│   ├── 2026-10-02-tactics-v11-vct.md              ✅ 已完成（2026-10-02；战术 v11：连续威胁搜索 + 三轮实验）
│   ├── 2026-10-02-tactics-v12-vct-def.md          ✅ 已完成（2026-10-02；战术 v12：连续威胁防守 + 三档思考时间对照）
│   ├── 2026-10-02-tactics-v13-pressure-gate.md    ✅ 已完成（2026-10-02；战术 v13：压力闸门 + 回归扫描 + 同口径 A/B）
│   ├── 2026-10-03-tactics-v14-evidence.md         📋 证据评审（2026-10-03；v14 候选的负结论 + 两个对照复算 + §4.4 抬档复核 9-3-8）
│   ├── 2026-10-03-tactics-coupling-audit.md       ✅ 已完成（2026-10-03；战术版本耦合性审计，并行 A/B 安全性）
│   ├── 2026-10-03-remote-batch-experiments.md     ✅ 已完成（2026-10-03；SSH 远端批量对弈实验设施 P0–P5）
│   ├── 2026-10-03-tactics-v14-fresh-live3.md      ✅ 已上线（2026-10-03；v14 活三判据纠偏；`rapfi@1000ms` 9-1-2 / `@2000ms` 9-3-8）
│   ├── 2026-10-03-tactics-fidelity-and-elo-ladder.md 🚧 实施中（P0–P6 ✅：档位冻结/指纹/回放·考古/阶梯地基/离线运行面 + 桶/Elo 升级/阶梯编排/**报告 CLI**；第一晚 L3 跑动中；P7 逃生门起待做）
│   ├── 2026-10-04-tactics-archaeology.md          ✅ 已完成（2026-10-04；14 档历史参数逐档考古 + P3 回放验收）
│   └── 2026-10-03-cands-metric-and-provider-failover.md 🚧 实施中（C0–C3 ✅：候选点三数落库 + 探针 + 上游兜底两运行面同判据 + 归因落库与报表分桶；C4 随下一次实验）
├── superpowers/
│   ├── plans/
│   │   ├── 2026-09-28-board-games-hardening.md   ✅ 已完成（仓库硬化）
│   │   └── 2026-09-30-tactics-lab.md             ✅ 已完成（战术实验室）
│   └── specs/
│       └── 2026-09-30-lab-redesign-design.md     ✅ 已完成（实验室改版设计）
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
   这样从目录名就能看出轮换是否均衡；架构/重构轮用日期直出（如
   `2026-10-01-workers-d1-rebuild.md`），类型记作「架构」。
