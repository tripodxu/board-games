# 迭代 04 · 前端打磨：精修 + 更有张力（前端轮）

> 状态：✅ **已完成**（2026-09-29）。设计方向由 `impeccable` 技能流程确定：用户选定
> **「精修 + 更有张力」**——保留「月白 Moonlit Silver」体系与全部现有内容/交互，不换视觉世界，
> 但加大表达力度。质量底线依 `impeccable/reference/craft-floor.md`（Verify / Refuse 两节）。
> 实测结论与残留例外见 [../memory/MEMORY.md](../memory/MEMORY.md) 置顶条目「2026-09-29 · 前端打磨」。

## Phase 0 · 先量，再改（本轮的硬规矩）

拒绝「看着有点淡」这种不可复核的判断。本轮所有结论先变成数字：

| 度量 | 现状 | 阈值 | 结论 |
|---|---|---|---|
| `--ink-mute` on `--bg1` | **3.74:1** | ≥4.5:1（小字） | ✗ |
| `--ink-mute` on `--bg2` | **3.57:1** | ≥4.5:1 | ✗ |
| `--ink-mute` on `--bg3` | **3.32:1** | ≥4.5:1 | ✗ |
| `--ink-mute` on `--bg0` | **3.42:1** | ≥4.5:1 | ✗ |
| `--line-strong` 作控件边界 on 白 | **1.51:1** | ≥3:1（WCAG 1.4.11） | ✗ |
| 低于 11px 的字号声明 | **22 处**（9px×3、9.5px×5、10px×3、10.5px×11） | ≥11px | ✗ |

扫描脚本按 WCAG 相对亮度公式逐色计算，非目测。

## Phase 1 · 真实缺陷（与审美无关，必须修）

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| 1 | **`.feed` 规则完全失效** | `index.html:145` 是 `<div id="feed">`，无 `class="feed"`；决策流因此**没有 max-height、没有滚动条**，侧栏随对局无限长 | 给容器补 `class="feed"` |
| 2 | **小字对比度全档不合格** | 上表 4 行 | `--ink-mute` `#7C8590` → `#656E79`（四档底色最低 4.60:1） |
| 3 | **表单控件边界不达标** | 1.51:1。输入框填充与面板同为 `--bg1`，边框是唯一的识别线索 | 新增 `--line-ctl: #828FA3`（3.13:1，取达标集里最浅的一档），只给**功能性控件**；装饰性发丝线保持原样 |
| 4 | **22 处 <11px 字号** | 含 `.tick-label`(9px，图表坐标轴)、`.rs span`(9px)、`.em .k`/`.ct span`(9.5px) | 统一提到 ≥11px |
| 5 | **战绩表窄屏横向溢出** | `.rec-row` 7 列固定 ≈394px+，`.records` 只有 `overflow-y` | ≤640px 隐藏「延迟/花费」两列并重排列数 |
| 6 | **死代码** | `.stats`/`.stat`（HTML 从未使用）、`.engine-panel.live`（`.live` 从未被添加）、`@keyframes seal-breathe` | 删除 |

## Phase 2 · 工艺底线（craft-floor Refuse 清单）

7. **`.cal-hero` 的 `border-left: 3px`** —— 这是**我上一轮自己引入**的，正踩在
   "colored `border-left` above 1px on cards" 的拒绝项上。改为底色 + 数值配色 + 自绘小标记。
8. **用 Unicode 字形当图标** —— `.chart-empty` 的「弈」、`.cal-empty` 的「衡」踩在
   "Unicode glyphs standing in for an icon system" 上。改为**自绘 SVG**（零依赖，仓库禁止第三方）。
   注：`.brand-mark` / `.seal` 的「弈」是既定中国风世界的**印记/落款**，属 logotype 不是图标，保留。

## Phase 3 · 加张力（用户选定方向）

craft-floor 的一句话是 "**when torn between refined and committed, commit**"。本轮的张力来自
**对比度与克制**，不是堆装饰：

- **排版尺度差**：面板标题 16px/字距 2.5px 是当前「松」感的主要来源（ZCOOL XiaoWei 配松字距）。
  收到 17px/1.5px，品牌标题 23px→26px 并收紧——展示字与数据字的落差拉开。
- **色彩更有主张**：`--zhu` 统一承担「评估性结论」（等待/告警/过度自信/负技巧分），形成一致语言。
- **收敛为一个被编排的动效时刻**：现状是 `breathe` / `pulse` / `seal-breathe` / `rise` /
  概率条与仪表过渡共 5 处散落动画，其中 `pulse` 与 `seal-breathe` 是**无限循环的装饰**。
  按 "Do not add animation merely to make polish visible"：删掉无限循环装饰，把唯一保留的
  时刻定为**「落子」**——趋势线/可靠性线一次性描线 + 末点单次脉冲外扩（单发，非循环）。
  减法本身就是张力。

## Phase 4 · 反模式护栏

- 不引入任何框架/CDN/依赖（AGENTS.md §2.1）——自绘 SVG 必须内联且手写。
- 保留 `epoch` 防护与 `?test=1` 入口；本轮不改对局逻辑。
- 动效必须包在既有 `@media (prefers-reduced-motion: reduce)` 内。
- `--line-strong` 只保留装饰用途，**不得**为了省事把所有边框一起加深（那会毁掉发丝线体系）。

## Phase 5 · 验证（实测结果）

| 项 | 结果 |
|---|---|
| 1. 对比度扫描（同 Phase 0 口径） | `--ink-mute` 四档底色 **5.17 / 4.94 / 4.60 / 4.74 :1** 全部达标；`--line-ctl` 3.28 / 3.13 :1；低于 11px 的字号声明 **0 处** |
| 2. `node test/run-tests.js` + `npm run check:docs` | 全绿 |
| 3. `impeccable detect --json` | 见下方「残留项」 |
| 4. 一次性 DOM 台回归 | 21 项全过（含真跑一局离线演示后校准面板仍为空态），`renderFeed` / `prependFeed` / 校准面板均未受本轮改动影响 |
| 5. 有意例外 | 见下方「残留项」，已同步进 `docs/status.md`「设计例外」 |

### 动手后由 detect 新发现并已修的三项

detect 是**改完之后**才跑的（技能要求：跑一次，不在概念阶段跑），因此它报出的问题不在原计划里：

1. **`button.primary` / `.brand-mark` / `.seal` 的白字在渐变上端只有 3.87:1**（`--zhu-hi: #D95840`）。
   改 `#C94C36` → 4.59:1。这是本轮**唯一一个原计划漏掉的真 AA 失败**，因为 Phase 0 只扫了 CSS 里的
   前景/背景**配对**，没扫渐变端点上的文字。
2. **5 处 `transition: width/height`**（`eval-fill` / `spark i` / `conf i` / `bar i` / `rank-row i`）
   造成逐帧重排。全部改为 `transform: scaleX/scaleY` + `transform-origin`，描线进度用
   `pathLength="1"` 归一化（不必猜路径长度）。
3. **「发丝线 + 宽投影」模板化签名 3 处**：`#promoBox`（1px 玄墨边 + 50px 投影）、
   `#testPanel`（1px 发丝线 + 50px）、`#toast`（1px 与底色几乎同色的边 + 40px）。
   按「二选一」处理：`#promoBox` 保留**明确边**、投影收到 28px；`#testPanel` / `#toast`
   **去掉边**、只靠投影。两个浮层因此一个以边为主、一个以投影为主。

### 残留项（有意保留，已入 status.md）

| detect 报出 | 判定 | 理由 |
|---|---|---|
| `#ffffff on #ffffff` 1.0:1 | **误报** | 它解析不了 `linear-gradient()`，退回假设白底。已逐处人工核算：三处白字真实最低对比 **4.59:1**（见验证脚本）。教训是——渐变上的文字自动检查盯不住，端点必须人工核算并写进注释（已在 `--zhu-hi` 处补核算依据）。 |
| `11px / 11.5px` body text | **有意例外** | 侧栏是密集数据面板（战绩簿 7 列表格、指标标签、棋谱 ledger）。提到 14px 需要重排布局并显著降低信息密度。`craft-floor` 的 Refuse 清单并未禁小字，允许「narrow intentional exception」。 |
| `#promoBox` 1px 边 + 28px 投影 | **有意例外** | 这 1px 是 `--mo`（对白底 15.6:1）的**明确边界**，不是发丝线；28px 投影是深度辅助。检测器无法区分「明确边」与「发丝线」。 |

