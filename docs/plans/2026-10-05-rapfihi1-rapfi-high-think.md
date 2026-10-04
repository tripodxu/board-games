# L4 / `rapfihi1`：把 Rapfi 思考时间补到 UI 上限（`@7000` / `@10000`）

- 状态：🚧 进行中（2026-10-05 02:30 起跑，10 轮 / 200 局；§3–§6 待全部收尾后填）
- 上一份：[vorder1 版本筛查](2026-10-05-vorder1-version-screening.md)；总计划：[战术保真与 Elo 阶梯](2026-10-03-tactics-fidelity-and-elo-ladder.md)；
  L2 底稿：[版本 vs Rapfi](2026-10-04-l2-version-vs-rapfi.md)

## 1 为什么跑

- 业主 2026-10-04 原话「补 500ms，7000ms，到 10000ms」：`@500/@1000/@2000` 已由 `l2n1` 各覆盖 100 局（分母配平），
  所以 L4 **只补 L2 没有的两档**，`@10000` 就是 UI 的上限（`10000 ms`，`AGENTS.md` 规则 10 的「战术层不吃搜索」在 UI 侧同样以这个上限为界）。
- 这条实验同时是 **vorder1 §5 两条疑点的裁决实验**：`v11@2000` 95.0%（19–0–1）与 `v13@2000` 52.5%（10–1–9）区间不重叠、
  却是不同对手集；vorder1 明写「**L4 是第一个能真正回答『新版本在强 Rapfi 面前是否退步』的实验**」。
- 与版本排序的关系：L4 **不排版本名次**（每格 20 局，见 §5），它排的是「Rapfi 抬到 7–10 s 还涨不涨」。

## 2 方法

- 命令（2026-10-05 02:30 起在 box 上跑，由 `.work/chain-l4.ps1` 看门狗接力）：
  `node scripts/experiment-ladder.mjs --ladder L4 --batch rapfihi1 --games 20 --poll 60`。
- 设计：`L4 = cross(5 个版本身份, rapfi@{7000,10000})` ⇒ **10 对 × 20 局 = 200 局**，轮序 v10→v11→v12→v13→v14 各跑两档。
- 运行面：`--store local --upstream direct`（零 CF 触碰），产物留 box（`.work/remote/rapfihi1/`），每轮收尾自动 `scp` 回本机同名目录；
  桶上传按业主决定继续跳过（每轮警告「桶凭据缺失，跳过上传」）。
- **串行**：Rapfi 的思考时间是墙钟，与任何其它阶梯并行都会互相抢 CPU ⇒ 时间档失真，所以 L4 全程独占 box，且与 `vorder1` 串行。
- 报表（一次读三批，合并身份、全局去重）：
  `node scripts/experiment-report.mjs --dir .work/remote/l2n1,.work/remote/vorder1,.work/remote/rapfihi1 --out .work/rapfihi1-report.md --json .work/rapfihi1-report.json`。
  曲线**没有硬编码档位**（`rafiCurve()` 按身份尾段取 ms 升序），两档会自动进表。
- 败局解释（规则 11）：`node scripts/loss-report.mjs --batch rapfihi1 --json .work/rapfihi1-loss.json`。

## 3 结果

<!-- 待填：L4 全部 10 轮收尾后，用 .work/rapfihi1-report.md 填 3.1–3.6 -->

### 3.1 逐对（判强弱只看这张表）

### 3.2 Rapfi「思考时间 → Elo」曲线延伸（`@7000` / `@10000` 与 Δ）

### 3.3 逐档合并口径（5 版 × 20 = 每档 100 局）

### 3.4 成本（m07650 / m08110 必报项：战术层与模型往返分开）

### 3.5 接管层诊断（解释性口径，不参与判强）

### 3.6 败局解释（规则 11）

## 4 与 L2 的交叉读数（五档曲线）

<!-- 待填：@500/@1000/@2000（L2）→ @7000/@10000（本批）合并成一条曲线；跨档只报点估计 + Wilson，不做显著性检验 -->

## 5 不能说什么（读数的硬边界）

- 单版单档 **n=20 ⇒ 半宽 ≈±20 pt**：逐版数字只作方向参考，可引用的是每档合并 100 局（±10 pt）。
- **跨档不是配对比较**：档位不同 ⇒ 对手强度不同、开局集不同，没有配对结构 ⇒ 曲线不做显著性检验（L4 判读规则 ②）。
- 一次 200 局之间的 BT 只能分辨 ~30 Elo（P5 实测），所以「谁更强」仍只写在配对样本上。
- L4 只覆盖 box 上那一个 Rapfi 二进制与固定开局种子；换二进制/换开局集都要重跑。

## 6 对下一步的硬性影响

<!-- 待填：① Rapfi 曲线是否还在涨 ⇒ 要不要继续加档；② 版本排序 A/B 的决策（vorder1 §7）；③ 机制线 v15 的门槛 -->
1. **是否继续抬 Rapfi 时间**：取决于 §3.2 的单调性是否被 Wilson 区间排除。
2. **版本排序 A/B**：仍是 vorder1 §7 那条待批项（A 推荐：接受不可分，把 box 时间投给曲线；B：只堆 `v11 vs v14` 100 局）。
3. **机制线（v15）**：仍暂停，恢复门槛不变 —— 先有能分辨 5 pt 的配对样本。

## 7 产物

| 产物 | 说明 |
| --- | --- |
| `.work/rapfihi1-ladder.txt` | 阶梯全程日志（逐轮进度、轮间冷却、桶告警） |
| `.work/remote/rapfihi1/round-<i>/` | 每轮 `games.jsonl` / `games/*.json` / `round-summary.json` / `events.jsonl`（box 端同步而来） |
| `.work/rapfihi1-report.md` · `.work/rapfihi1-report.json` | 三批合并报表（本批 + `l2n1` + `vorder1`） |
| `.work/rapfihi1-loss.md` · `.work/rapfihi1-loss.json` | 规则 11 败局解释（纯本批） |
