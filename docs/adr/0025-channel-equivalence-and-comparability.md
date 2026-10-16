# ADR-0025：渠道等价性与跨轮可比性纪律（zen-o2a ≡ 官方、lfree ≠ 官方；跨轮比分先查腿混合）

- **状态**：accepted
- **日期**：2026-10-14
- **相关**：[ADR-0024](0024-jevrouter-gateway-channel.md)（jevrouter 渠道接入；其表已言「网关按腿归一：zen 腿 `jev-1.13-free`、lfree 腿 `jev-1.13`」——本 ADR 是其行为的实测定量）、[ADR-0019](0019-remote-batch-experiments.md)（远端批量对弈）、[ADR-0021](0021-standalone-experiment-plane.md)（直连运行面）

## 背景

2026-10-08 起挑战轮（ADR-0024）改走 jev-router 网关，网关按优先级把请求轮换到三条腿：
`lfree-1`/`lfree-2`（外部平台，回 `jev-1.13`）与 `zen-o2a`（自建出口池，回 `jev-1.13-free`）。
v15 挑战轮（`v15-vs-r10`）与基准（`vplus-r10s`）的归档 `ai.mdl` 显示两批的腿混合差了两个数量级
（99.0% vs 15.9% lfree），于是「跨轮比分可不可比」从隐含假设变成了必须回答的问题。
同期官方 API（`api.typesafe.ai`，模型 `jev-1.13.0`/别名 `jev-latest`，单上游、无腿路由）
从 box 实测可用且无限速（20/20、≈150 次/分），提供了天然的「真 Jev」参照系。

## 检验方法（可复用，判据先写死后跑）

对同一批 **500 个真实对局局面**（取自已归档实验、模型自选手位、重建完整三问 payload、
逐局 SHA 守卫全匹配）：每腿重复 6 次、官方参照 6 次，另抽 60 局面**同时段重打官方**作噪声地板
（官方 vs 官方自一致 = 95.0%/93.3%——Jev 自身是随机的，一切比较以之为尺）。
指标：众数一致率（Wilson 95% CI）、概率向量 TV 距离（自助 CI）、同时段 McNemar 配对检验。
数据与脚本留存 `docs/experiments/`（官方基准 500×6 + 96×10、检验报告、采样/分析脚本）。

## 结果

| 渠道 | 众数一致率 vs 官方 | TV | 判定 |
|---|---|---|---|
| `zen-o2a`（`jev-1.13-free`） | **95.0%**（= 噪声地板 95.0%，McNemar p=0.16） | 0.027 | **≡ 官方** |
| `lfree-1`（`jev-1.13`） | **61.0%**（z≈29，p<10⁻¹⁵） | 0.236 | **显著偏离** |
| `lfree-2`（`jev-1.13`） | **62.0%** | 0.236 | **显著偏离** |

两 lfree 腿互检 91.2% ⇒ 偏离是**稳定部署差异**，不是随机噪声。约 39% 的单边决策与官方不同。
**命名反直觉：带 `-free` 后缀的腿才是官方忠实克隆，`jev-1.13`（lfree）反而是另一模型。**
附带测得 Jev 自身随机性：官方重复 6 次众数占比 93.2%（约 7% 局面固有歧义）——这是所有
「单次调用对比」的噪声地板，一切分差先与它比。

## 决策（纪律）

1. **跨轮比分只在同一执行模型上可比。** 凡比较两个批次的比分，先统计各自的 `ai.mdl` 腿混合
   （一次性脚本见 MEMORY 2026-10-14 条目）；混合差 >10pt 的批次**不得直接比**，除非锁定 `?leg=zen-o2a&strict=1`
   或走官方。各历史批次的混合表已落在 `docs/experiments/lfree-vs-official-2026-10-14.md` 第七节。
2. **批内头对头不受腿混合影响**（两臂共享同一次运行的路由池）——`vplus2`（v14-plus 晋升依据）
   与 v15 头对头（实验 A）的结论**继续有效**；受影响的是跨轮：实验 B（99% lfree）vs `vplus-r10s`
   的「v15 对外执白弱」读法作废，晋升判据悬置。
3. **官方 API 升格为一等实验渠道**：主实验默认 `official`（`--upstream direct` +
   `--key-file /root/.jev-official-key`），比网关快 ~1.8 倍、无限速、无腿混合、单上游。
   官方重跑 v15/v14-plus vs rapfi 的交接与 checklist 在
   [plans/2026-10-14-official-rerun.md](../plans/2026-10-14-official-rerun.md)（待业主确认开跑）。
4. **调用留存进流程**：官方批次一律带 `--capture`（`calls.jsonl` 含请求原文 + 完整概率分布，
   鉴权头不落盘）——任何一次调用可脱离渠道独立复现，争议时有物证。
5. `docs/experiments/` 的官方基准数据集是**长期参照系**：以后接入任何新渠道/部署，
   在同一 500 局面上跑「众数一致 >85% 且 TV<0.1 ⇒ 等价」即可判别是否真 Jev，不必重造方法。

## 代价与不做什么

- 不改生产路由（生产 `jevrouter` 仍走公网网关默认轮询）——本 ADR 只约束**实验**面纪律。
- 不追溯重跑全部历史批次（成本高）；只重跑悬置的 v15/v14-plus 晋升判据。
- `lfree` ≠ 官方**不等于** lfree 更差——它只是另一个模型；本纪律只关乎「比的是不是同一个东西」，
  不评判谁强。

## 复现

`docs/experiments/README.md` + 两份报告（free/lfree vs official）+ 脚本（`free-vs-official.mjs`、
`analyze-free-vs-official.mjs`）；官方基准数据 `official-baseline-large-500x6.jsonl`。
命令与 key 前提见 `docs/remote-experiments.md` §1.3b 与重跑交接文档。

## 落地结果（2026-10-15/16 回填）

- **§决策 1 的腿成分体检已固化**为可复用命令：[remote-experiments.md](../remote-experiments.md) §2.3a
  （扫 `round-1/games/*.json` 的 `moves[].ai.mdl`，输出 `渠道:模型 手数` 排行）。
  对全部历史批次扫出的**污染地图**见 MEMORY 2026-10-16 条目与
  [status.md](../status.md)「已验证」第二条：`v15-r10-off` / `v14p-r10-off` **lfree 0%**（官方直连干净）、
  v14.1/v14.2 验证轮 official 直连一条没中；**v14.3 的挑战轮是一档两命**——实验 A（`vdef-3v-p`）
  99.8% 官方克隆腿 ⇒ 有效；实验 B（`vdef-3r10`）96.6% lfree ⇒ 其数字**降级为参考**，不得与
  `vplus-r10s` 比；`CURRENT` 保持 `v14-plus` 的否决结论不变（污染不会把否证翻成通过）。
- **§决策 3 的官方重跑已完成**（`plans/2026-10-14-official-rerun.md` 里「待业主确认开跑」已兑现）：
  `v15-r10-off` 与 `v14p-r10-off` 串行各 120 局全 ok —— **v15 vs v14-plus 比分「不可判」**
  （+5.8pt，差值 95% 区间 −6.4 ~ +18.1pt 跨 0，配对符号检验 40:31 p≈0.30）；
  规则 11 底线通过（v15 负局 41 < 48、不败率 65.8% > 60.0%），**`CURRENT` 未改动**（按约定报业主确认）。
  两批均带 `--capture`、`store=local`、零 CF 触碰。
- **§决策 1 的「锁定 `?leg=zen-o2a&strict=1`」已成规程**：[remote-experiments.md](../remote-experiments.md) §1.3c。
  v14.3 实验 B 的干净重跑（批次 `v14p3free120`，同 seed 20261012、120 局、store local、capture 开）
  已按此规程锁腿开跑；2 局探针 25/25 手全 `jev-1.13-free`、零 400。
- **「必须串行」纪律（§3）补了自检**：worker 与看护都起后 `ps` 必须数出**恰好 1 个** worker——
  看护存活检测用**绝对 plan 路径**，手动起相对路径那条会漏判 ⇒ 多拉一份 = 双 worker 并行（已实测踩中并处置）。
