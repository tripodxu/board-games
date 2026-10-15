# v15 / v14-plus 对 rapfi@10s 的官方 API 重跑（待业主确认开跑）

> 状态：**已实现、已验证、未启动**。业主指令「先不要开跑，落成文档和使用说明，让我确认是否开跑」。
> 目的：把「v15 vs rapfi@10s」与「v14-plus vs rapfi@10s」两条挑战轮**在官方 API 上重跑**，
> 彻底摆脱 lfree 腿污染（实测 lfree 对官方 ~39% 单边决策差异，见 [lfree-vs-official-2026-10-14.md](../experiments/lfree-vs-official-2026-10-14.md)），
> 并把**每一次官方调用的请求与响应原文全量留存**。

## 一、为什么要重跑（背景一句话）

已落地的四个数彼此不可直接比，因为它们跑在**不同的执行模型**上：

| 批次 | 执行 | lfree 占比 | 与官方关系 |
| --- | --- | --- | --- |
| `vplus-r10s`（v14-plus vs rapfi，61.3%） | 公网网关 | 15.9% | 轻度污染 |
| `v15-vs-r10`（v15 vs rapfi，59.6%） | 内网网关 | 99.0% | **≈整批在 lfree 上跑** |

只有两条都在官方上跑，跨批次比分才干净。

## 二、本次改动（已完成，未提交）

新增 `--capture` 开关：worker 把每次上游调用的**请求原文 + 响应**逐行追加写 `<outDir>/calls.jsonl`，
official / 网关都适用，**鉴权头按前缀抹除、绝不落盘**（AGENTS 规则 7）。

- 新模块 [`scripts/lib/capture.mjs`](../../scripts/lib/capture.mjs)（包 `globalThis.fetch`，与限速同款；写失败不拖垮对局）
- worker 接线 [`scripts/experiment-worker.mjs`](../../scripts/experiment-worker.mjs)：装在限速**之前**（外层），反序卸载各自 guard 命中；`--capture`/`plan.capture` 触发
- submit 透传 [`scripts/experiment-batch.mjs`](../../scripts/experiment-batch.mjs)：`--capture` ⇒ plan 落 `capture: true`
- 单测 [`test/scripts/capture.spec.mjs`](../../test/scripts/capture.spec.mjs)：**9 例**（key 抹除、命中/不命中、抛错上抛、写失败不抛、no-op、uninstall 还原）

验证：`npm test` **59 文件 / 820 例全绿**、`npm run typecheck` 0 错、三脚本 `--check` 通过。

## 三、`calls.jsonl` 每行字段

```
seq, t, method, url, host          调用元信息
headers                            仅非敏感头（Content-Type/User-Agent 等；Authorization 已被抹）
body                               请求原文：{state(完整棋盘/事实), model, questions(三问)}   ← 可脱离渠道独立复现
status, response                   响应原文：{answers.move{choice,probabilities}, model, usage}
ms                                 往返耗时
```

rapfi 臂走本地 WASM、不发网络请求 ⇒ `calls.jsonl` 里**只有 Jev 臂的官方调用**，正是想要的物证。

## 四、⚠️ 开跑前必须知道的三个前提

1. **key 文件必须显式指**。official 臂默认读 `/root/.jev-key`，但 box 上那文件是 `jv-` 网关 key（被形状闸门 exit 2）。
   官方 key 在 `/root/.jev-official-key`（已放好、600 权限）。⇒ 启动命令**必须带** `--key-file /root/.jev-official-key`。
2. **official 走 direct 面是设计内通道**：`api.typesafe.ai` 本就在 direct 白名单，形状闸门正好要 official「非 jv-」，全通。
   从 box（出口 185.242.234.48）实测 20/20 成功、≈150/分、无限速头；我本地开发机直连会 451（区域限制），与 box 无关。
3. **`--allow-production` 是闸门要求，不代表写生产**：本方案 `--store local`，实验数据只落远端 `games.jsonl`，
   生产 D1 零写入（ADR-0019 D11）。

## 五、启动命令（**业主确认后再执行**）

两批都在 box 跑、串行（先 v15、后 v14-plus，避免同时压官方 API），`nohup` 脱离 ssh：

```bash
cd "E:/mimo/temp/ttemp/jev_games/board-games"

# 批次 1：v15 vs rapfi@10s
node scripts/experiment-batch.mjs submit --batch v15-vs-r10-official \
  --a "official:v15:0" --b "rapfi::10000" \
  --games 120 --pause 2500 --seed 20261013 \
  --store local --upstream direct --rate-limit 30 \
  --key-file /root/.jev-official-key \
  --capture \
  --allow-production --host 185.242.234.48 --user root

# 批次 2：v14-plus vs rapfi@10s（同 seed 同配置，只换战术档）
node scripts/experiment-batch.mjs submit --batch v14p-vs-r10-official \
  --a "official:v14-plus:0" --b "rapfi::10000" \
  --games 120 --pause 2500 --seed 20261013 \
  --store local --upstream direct --rate-limit 30 \
  --key-file /root/.jev-official-key \
  --capture \
  --allow-production --host 185.242.234.48 --user root
```

规格已核：`official`+`rapfi` ⇒ 仅 1 个上游臂，不触发 `--force`（并发=1）；`v15`/`v14-plus` 都在战术档白名单。

**耗时估算**：120 局 × 约 40 手 × 每手官方 ~0.5–1s ≈ 每批 1.5–2.5 小时，两批串行约 3–5 小时。

## 六、建议的先验小样（可选，几分钟、真实调用 ~40 次）

正式跑前用 2 局验证「capture 真能落盘 + official 真能通 + key 读对」，跑完即停、不污染：

```bash
node scripts/experiment-batch.mjs submit --batch v15-cap-probe \
  --a "official:v15:0" --b "rapfi::10000" \
  --games 2 --pause 2500 --seed 20261013 \
  --store local --upstream direct \
  --key-file /root/.jev-official-key --capture \
  --allow-production --host 185.242.234.48 --user root

# 跑完检查（应看到若干行、host=api.typesafe.ai、无 Bearer/apikey 字样）
ssh root@185.242.234.48 \
  'f=/root/board-games/.work/remote/v15-cap-probe/round-1/calls.jsonl; \
   echo 行数 $(wc -l < $f); grep -c "api.typesafe.ai" $f; grep -icE "Bearer|apikey|jv-" $f || echo "0（鉴权头未泄漏 ✓）"'
```

（另有零网络自检：`submit ... --dry-run` 只建 plan、不打上游。）

## 七、结果出来后怎么用

1. **比分**：`node scripts/experiment-report.mjs --batch v15-vs-r10-official` 与 `...v14p-vs-r10-official`
   —— 现在两批同走官方，**跨批次可比**，直接给「v15 相对 v14-plus 在真 Jev 上对 rapfi 的胜负/不败率/执色」。
2. **判晋升**：规则 11——负局不增加 + 不败率不下降；两批同条件 ⇒ 这次能下定论（此前受污染的 B 轮结论以此为准）。
3. **审计/复现**：`calls.jsonl` 拉回本地（scp 带重试），每行可脱离渠道重放，作为官方行为的长期物证。

## 八、待业主确认

- [ ] 是否开跑？（默认两批、seed 20261013、各 120 局）
- [ ] 先跑第六节的 2 局探针，还是直接跑正式批次？
- [ ] seed 用 `20261013`（与原 v15 轮一致）还是新值？
- [ ] 实现改动（capture + 单测）是否现在提交？（当前未提交、工作区干净可复跑）

## 九、探针实测记录（2026-15 02:06–02:09 UTC，批次 `v15cap1`，已跑完）

**结论：探针全绿，正式批次可开跑。**

- 对局：2/2 局正常完赛（`worker 完：2/2`），games.jsonl 2 行、逐局文件 2 个——常规产物链路完好。
- 调用留存：`calls.jsonl` 逐次落盘（game-1 时 15 行），全部 `host=api.typesafe.ai`、`status=200`；
  **鉴权泄漏扫描 0 命中**（`bearer|apikey_|jv-|authorization` 全无）。
- 记录结构完整：`seq/t/method/url/host/headers/body/ms/status/response`；
  `headers` 只剩 `Content-Type`（鉴权头被抹 ✓）；`body` = 完整 state（board_ascii/rules/子力/候选）+ 三问（move/edge/position）；
  `response` = `{model: jev-1.13.0, answers:{move:{choice,confidence,probabilities},…}, usage}`——
  **官方模型名 jev-1.13.0 亲证走的就是官方直连**，token 用量也在案（如 input 1690 / output 56，单次 ms≈382）。

## 十、探针暴露的两个坑（正式跑命令已含对策）

1. **Git Bash 会把 `--key-file /root/...` 改写成 `C:/Program Files/Git/root/...`**（MSYS 路径转换），
   plan 落盘后即成死路径。**对策：命令前加 `MSYS_NO_PATHCONV=1`**（已在第五节命令示例采用，此处补记）。
2. `--dry-run` 也会真启动远端 worker（只跳过上臂调用、秒退），并留下半成品批次目录——
   dry-run 之后若要用同批次名，先删远端与本地目录（M4 同名拦截会挡真跑）。
3. 小噪声：`formatSpec` 把 `rapfi::10000` 的空战术段归一为 `rapfi:v14-plus:10000`——rapfi 臂不消费战术段
   （思考 ms 才是它的有效参数），行为无影响，仅 plan 文本有出入。

## 十一、正式开跑 checklist（等业主点头）

```bash
cd "E:/mimo/temp/ttemp/jev_games/board-games"
export MSYS_NO_PATHCONV=1
# 批 1
node scripts/experiment-batch.mjs submit --batch v15-vs-r10-official \
  --a "official:v15:0" --b "rapfi::10000" --games 120 --pause 2500 --seed 20261013 \
  --store local --upstream direct --rate-limit 30 --key-file /root/.jev-official-key --capture \
  --allow-production --host 185.242.234.48 --user root
# 批 1 跑完（games.jsonl ≥ 120 行）再批 2
node scripts/experiment-batch.mjs submit --batch v14p-vs-r10-official \
  --a "official:v14-plus:0" --b "rapfi::10000" --games 120 --pause 2500 --seed 20261013 \
  --store local --upstream direct --rate-limit 30 --key-file /root/.jev-official-key --capture \
  --allow-production --host 185.242.234.48 --user root
```

预估各 1.5–2.5 小时（官方单次 ~0.4–0.8s、每局约 40 手、pause 2.5s）；串行合计 3–5 小时。
