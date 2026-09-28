'use strict';
/* calibration.js — Jev 校准实验室：把「Jev 说的胜率」和「实际胜负」放在同一把尺子上量。
 *
 * 动机：决策面板每手都显示「白方优势 72%」，但整条链路从没人验证过这个 72% 是否可信。
 * 一个永远输出 50% 的模型与一个真会算的模型，在当前 UI 上毫无区别。校准问的正是：
 *   Jev 说「70%」的那些时刻，最后真的有 70% 兑现吗？
 *
 * 纯函数、零 DOM、零依赖，可在 Node 中直接加载自检（角色同 board.js）。
 * 只做数学：不碰引擎、不碰 UI、不碰 localStorage。
 *
 * 样本格式 {p, y}：
 *   p —— Jev 预测的胜率，已换算到「先手方」视角，0..1
 *   y —— 实际结果：先手方赢 = 1，输 = 0；**和棋不入样本**（二元事件无真值，
 *        强行记 0.5 会同时污染 brier 与 ece 的解释）
 */
(function () {
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  /* 清洗样本：p 必须是有限数（越界截断），y 必须是 0/1（缺数据与和棋一律剔除） */
  function clean(samples) {
    const out = [];
    for (const s of samples || []) {
      if (!s) continue;
      const p = Number(s.p), y = s.y;
      if (typeof p !== 'number' || !isFinite(p)) continue;
      if (y !== 0 && y !== 1) continue;
      out.push({ p: clamp01(p), y });
    }
    return out;
  }

  /* 可靠性分箱：按预测值 p 等宽分箱。
   * 返回每箱 {lo, hi, n, conf(平均预测), acc(平均实测)}，空箱 n=0、conf=acc=0。
   * p 恰为 1 时归入最后一箱（floor 会越界）。 */
  function reliability(raw, nBins) {
    const s = clean(raw);
    nBins = Math.max(2, nBins | 0 || 10);
    const out = [];
    for (let k = 0; k < nBins; k++) {
      out.push({ lo: k / nBins, hi: (k + 1) / nBins, n: 0, conf: 0, acc: 0 });
    }
    for (const x of s) {
      let k = Math.floor(x.p * nBins);
      if (k < 0) k = 0;
      if (k >= nBins) k = nBins - 1;
      const b = out[k];
      b.n++; b.sumP = (b.sumP || 0) + x.p; b.sumY = (b.sumY || 0) + x.y;
    }
    for (const b of out) {
      if (b.n) { b.conf = b.sumP / b.n; b.acc = b.sumY / b.n; }
      delete b.sumP; delete b.sumY;
    }
    return out;
  }

  /* 汇总指标。样本不足返回 null。
   *
   * 刻意不上 Murphy 的 BS = REL − RES + UNC 三分式：该恒等式在「分箱内预测值非常数」
   * 时并不成立（对完美预测 p=y∈{0,1} 代入即证伪：公式给 0.25，真值 0），
   * 需要额外的箱内方差修正项才严格。这里只发布「定义即真值、无恒等式依赖」的指标。
   *
   *   brier          = mean((p−y)²)                      越低越好；全猜 0.5 时 = 0.25
   *   skill          = 1 − brier / (p̄(1−p̄))             相对「恒定猜真实基准率」的技巧分
   *                                                  0 = 毫无信息量，1 = 完美
   *   ece / mce      = Σ(n_k/N)·|acc_k−conf_k| / 其最大  分箱校准误差（L1 形式）
   *   overconfidence = mean(p) − p̄                       >0 = Jev 平均比现实更乐观
   */
  function metrics(raw) {
    const s = clean(raw);
    const n = s.length;
    if (!n) return null;
    let sq = 0, sumP = 0, sumY = 0;
    for (const x of s) { const d = x.p - x.y; sq += d * d; sumP += x.p; sumY += x.y; }
    const baseRate = sumY / n;          // 实际先手方胜率
    const sharpness = sumP / n;         // Jev 平均给出的胜率
    const brier = sq / n;
    const ref = baseRate * (1 - baseRate); // 参考预报「恒定猜 baseRate」的 brier
    let ece = 0, mce = 0;
    for (const b of reliability(s, 10)) {
      if (!b.n) continue;
      const gap = Math.abs(b.acc - b.conf);
      ece += (b.n / n) * gap;
      if (gap > mce) mce = gap;
    }
    return {
      n,
      brier,
      ref,
      skill: ref > 0 ? 1 - brier / ref : null, // 基准率为 0 或 1 时参考预报无意义
      ece,
      mce,
      baseRate,
      sharpness,
      overconfidence: sharpness - baseRate,
    };
  }

  /* 从战绩簿汇总校准样本。
   * 记录里的 cal 是该局**非演示渠道**的 Jev 逐手给出的先手方胜率；
   * 离线演示的合成概率刻意不写入 cal —— 拿合成数据算校准等于自欺。
   * firstWin 为 null（和棋）时该局没有二元真值，计入 draws 而不计入样本。
   * 另：同一局内所有样本共享同一真值 y，样本按「局」强相关，
   * 有效样本量更接近 games 而非 samples——面板因此同时展示两者。 */
  function fromRecords(records) {
    const samples = [];
    let games = 0, draws = 0, skippedDemo = 0;
    for (const r of records || []) {
      if (!r) continue;
      const cal = r.cal;
      if (!cal || !cal.length) { if (r.mock) skippedDemo++; continue; }
      if (r.firstWin === null || r.firstWin === undefined) { draws++; continue; }
      const y = r.firstWin ? 1 : 0;
      games++;
      for (const p of cal) samples.push({ p, y });
    }
    return { samples, games, draws, skippedDemo, metrics: metrics(samples) };
  }

  /* ---------- 自检：全部用解析可验的夹具（期望值均可手算核对） ---------- */
  function selfTest() {
    const A = BG.util.assert;
    const M = (arr) => metrics(arr);
    const S = (a, p, y) => a.push({ p, y });

    /* 空与脏数据 */
    A(metrics([]) === null, '空样本应返回 null');
    A(metrics([{ p: 0.5, y: 0.5 }]) === null, 'y 非 0/1（和棋）应被剔除');
    A(clean([{ p: 1.5, y: 1 }, { p: NaN, y: 0 }, { p: 0.2, y: 1 }]).length === 2,
      'p 越界截断、p 非有限数剔除');

    /* 夹具 A：校准良好且**有信息量** —— p∈{0,0.5,0.5,1}, y∈{0,0,1,1}
     * brier = (0+0+.25+.25)/4 = .125；p̄=.5 → ref=.25 → skill = 1−.5 = .5 */
    const a = [];
    S(a, 0, 0); S(a, 1, 1); S(a, 0.5, 0); S(a, 0.5, 1);
    const ma = M(a);
    A(near(ma.brier, 0.125), '夹具A brier 应为 0.125，实际 ' + ma.brier);
    A(near(ma.skill, 0.5), '夹具A skill 应为 0.5，实际 ' + ma.skill);
    A(near(ma.ece, 0) && near(ma.mce, 0), '夹具A 完美校准：ece/mce 应为 0');
    A(near(ma.overconfidence, 0), '夹具A 过度自信应为 0，实际 ' + ma.overconfidence);
    A(ma.baseRate === 0.5 && ma.sharpness === 0.5, '夹具A 基准率与锐度都应为 .5');

    /* 夹具 B：恒猜 0.5 ——「从不说谎」但**毫无信息量**
     * brier = 4×.25/4 = .25；skill = 1−1 = 0；ece 同为 0
     * ★ 与夹具 A 的关键对照：A、B 的 ece 完全相同，skill 却 0.5 vs 0。
     *   这证明 ece 单独使用会骗人，面板必须把 skill 与 ece 并排给出。 */
    const b = [];
    S(b, 0.5, 0); S(b, 0.5, 1); S(b, 0.5, 0); S(b, 0.5, 1);
    const mb = M(b);
    A(near(mb.brier, 0.25), '夹具B brier 应为 0.25，实际 ' + mb.brier);
    A(near(mb.skill, 0), '夹具B skill 应为 0（毫无信息量）');
    A(near(mb.ece, ma.ece) && near(mb.ece, 0),
      '夹具A/B 的 ece 应相同且为 0 —— 这正是 ece 不足以单独判优的证据');

    /* 夹具 C：过度自信 —— p≡0.9（10 条，实际只赢 3 条）
     * brier = (3×.01 + 7×.81)/10 = 5.7/10 = .57；p̄=.3 → ref=.21 → skill = 1−.57/.21 ≈ −1.714 */
    const c = [];
    for (let i = 0; i < 10; i++) S(c, 0.9, i < 3 ? 1 : 0);
    const mc = M(c);
    A(near(mc.brier, 0.57), '夹具C brier 应为 0.57，实际 ' + mc.brier);
    A(near(mc.skill, 1 - 0.57 / 0.21), '夹具C skill 应约为 −1.714，实际 ' + mc.skill);
    A(near(mc.overconfidence, 0.6), '夹具C 过度自信应为 +0.6，实际 ' + mc.overconfidence);
    A(near(mc.ece, 0.6) && near(mc.mce, 0.6), '夹具C ece/mce 应为 0.6');

    /* 夹具 D：完美预测 —— skill = 1 */
    const d = [];
    for (let i = 0; i < 4; i++) { S(d, 1, 1); S(d, 0, 0); }
    const md = M(d);
    A(md.brier === 0 && near(md.skill, 1), '夹具D 完美预测：brier=0、skill=1');
    A(near(md.ece, 0) && near(md.overconfidence, 0), '夹具D 完美预测：ece/过度自信均为 0');

    /* 夹具 F：分箱样本量不等且两箱都错 —— 专门用来杀死「ECE 漏乘 n_k/N 权重」这种变异。
     * 1 条 p=.9/y=0（箱9：conf .9 / acc 0，偏差 .9）＋ 9 条 p=.5/y=1（箱5：conf .5 / acc 1，偏差 .5）
     * 加权 ece = (1/10)×.9 + (9/10)×.5 = .54；若漏掉权重会算成 1.4，立刻暴露。 */
    const f = [];
    S(f, 0.9, 0);
    for (let i = 0; i < 9; i++) S(f, 0.5, 1);
    const mf = M(f);
    A(near(mf.ece, 0.54), '夹具F ece 应为 0.54（按样本量加权），实际 ' + mf.ece);
    A(near(mf.mce, 0.9), '夹具F mce 应为最大单箱偏差 0.9，实际 ' + mf.mce);
    A(near(mf.baseRate, 0.9) && near(mf.sharpness, 0.54), '夹具F 实际胜率 .9 / 平均预测 .54');
    A(near(mf.overconfidence, -0.36), '夹具F 应判定为偏保守 −0.36，实际 ' + mf.overconfidence);
    A(near(mf.brier, 0.306) && near(mf.skill, 1 - 0.306 / 0.09), '夹具F brier=.306、skill=−2.4');

    /* 基准率退化：全赢时参考预报无意义（分母 0），skill 必须为 null 而非 Infinity/NaN */
    const e2 = [];
    for (let i = 0; i < 4; i++) S(e2, 0.6, 1);
    const me = M(e2);
    A(me.skill === null, '基准率为 1 时 skill 应为 null（参考预报退化）');
    A(isFinite(me.brier) && isFinite(me.ece), '退化情形下 brier/ece 仍须为有限数');

    /* 分箱：p=1 归入最后一箱而不是越界 */
    const box = reliability([{ p: 1, y: 1 }, { p: 0, y: 0 }], 10);
    A(box.length === 10, '分箱数应为 10');
    A(box[9].n === 1 && box[9].conf === 1 && box[9].acc === 1, 'p=1 应归入第 10 箱');
    A(box[0].n === 1 && box[0].conf === 0 && box[0].acc === 0, 'p=0 应归入第 1 箱');
    A(box[5].n === 0, '空箱 n 应为 0');

    /* fromRecords：和棋整局丢弃、演示局不计入 */
    const agg = fromRecords([
      { firstWin: true, cal: [0.9, 0.8] },
      { firstWin: false, cal: [0.2] },
      { firstWin: null, cal: [0.5, 0.5] },   // 和棋：计 draws，不入样本
      { firstWin: true, mock: true },          // 离线演示：合成概率，不入样本
      null,
    ]);
    A(agg.games === 2, '应汇总 2 局有效对局，实际 ' + agg.games);
    A(agg.draws === 1, '和棋应计 1 局，实际 ' + agg.draws);
    A(agg.samples.length === 3, '应产出 3 条样本，实际 ' + agg.samples.length);
    A(agg.samples.every((x) => x.y === 0 || x.y === 1), '样本 y 必须是 0/1');
    A(agg.metrics.n === 3, 'metrics.n 应为 3');

    /* 真值映射方向：firstWin=true → y=1，firstWin=false → y=0，不得搞反 */
    const dir = fromRecords([
      { firstWin: true, cal: [0.7, 0.8] },
      { firstWin: false, cal: [0.3] },
    ]);
    A(dir.samples.length === 3 &&
      dir.samples[0].y === 1 && dir.samples[1].y === 1 && dir.samples[2].y === 0,
      '真值映射方向错误：先手赢应为 1、应为 0，实际 ' + JSON.stringify(dir.samples));
  }

  BG.calibration = { clean, reliability, metrics, fromRecords, selfTest };
})();
