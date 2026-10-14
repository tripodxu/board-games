/* analyze-free-vs-official.mjs — free 腿 vs 官方：统计学与概率学判定
 *
 * 输入：
 *   .work/free-500x6.jsonl           每局面：存档官方 6 次的选择 officialChoices + free 腿 6 次 freeCalls
 *   .work/official-replay-60x6.jsonl 前 60 局面：存档官方 archivedChoices + 当下重打官方 replayCalls（漂移对照）
 *
 * 输出四个量，逐一说清它回答什么：
 *   1. 众数一致率（free vs 存档官方），及其 **95% 置信区间**（Wilson）——点估计 + 精度
 *   2. 噪声地板：官方 vs 官方(重打) 的众数一致率——用来定义「多大一致算等价」
 *   3. 概率向量 TV 距离均值 + 自助置信区间——不依赖选点、看整个分布
 *   4. **符号检验 + 精确二项 p**：free 众数 ≠ 官方众数的比例是否显著 > 噪声地板下的期望
 *   另：per-label 分层，看是否某档差异更大
 */
import { readFileSync } from 'node:fs';

const load = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const modal = (arr) => { const c = {}; for (const x of arr) c[x] = (c[x] || 0) + 1; let best = null, bn = 0; for (const [k, v] of Object.entries(c)) if (v > bn) { bn = v; best = k; } return best; };
const mean = (calls) => { const keys = new Set(); for (const c of calls) for (const k of Object.keys(c.probs || {})) keys.add(k); const m = {}; const n = calls.length || 1; for (const k of keys) { let t = 0; for (const c of calls) t += (c.probs[k] ?? 0); m[k] = t / n; } return m; };
const tv = (A, B) => { const keys = new Set([...Object.keys(A), ...Object.keys(B)]); let s = 0; for (const k of keys) s += Math.abs((A[k] ?? 0) - (B[k] ?? 0)); return s / 2; };

// Wilson 95% CI（比例）
function wilson(k, n) { if (!n) return [0, 0]; const z = 1.96, p = k / n; const d = 1 + z * z / n; const c = p + z * z / (2 * n); const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - h) / d, (c + h) / d]; }
// 精确二项检验：在「等价」原假设下，不一致率应 ≤ 噪声地板(1-自一致)。用正态近似给 z 与单侧 p。
function oneSidedP(obsDiscard, n, floor) { if (n === 0 || floor >= 1) return { z: 0, p: 1 }; const se = Math.sqrt(floor * (1 - floor) / n); const z = (obsDiscard - floor) / se; // 标准正态上尾
  const p = 0.5 * (1 - erf(z / Math.SQRT2)); return { z, p }; }
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
// 自助 CI（TV 均值）
function bootCI(vals, iters = 4000) { const m = vals.length; if (!m) return [0, 0]; let rng = 987654321; const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; }; const means = []; for (let i = 0; i < iters; i++) { let s = 0; for (let j = 0; j < m; j++) s += vals[(rand() * m) | 0]; means.push(s / m); } means.sort((a, b) => a - b); return [means[(0.025 * iters) | 0], means[(0.975 * iters) | 0]]; }

/* 输入：先跑同目录 free-vs-official.mjs 生成 .work/free-500x6.jsonl 与 .work/official-replay-60x6.jsonl */
const free = load('.work/free-500x6.jsonl');
const replay = load('.work/official-replay-60x6.jsonl');

// 1) free vs 存档官方：众数一致
let agree = 0, n = 0;
for (const r of free) {
  const off = (r.officialChoices || []).filter(Boolean), fr = r.freeCalls.filter((c) => !c.err && c.choice).map((c) => c.choice);
  if (!off.length || !fr.length) continue;
  n++; if (modal(fr) === modal(off)) agree++;
}
// TV：对 free 的实际 probs 求均值，与存档官方 mean 比
const tvs2 = free.map((r) => tv(mean(r.freeCalls.filter((c) => !c.err)), r.officialMean || {})).filter((x) => Number.isFinite(x));

// 2) 噪声地板：官方 vs 官方(重打)
let agreeR = 0, nR = 0;
for (const r of replay) {
  const a = (r.archivedChoices || []).filter(Boolean), b = r.replayCalls.filter((c) => !c.err && c.choice).map((c) => c.choice);
  if (!a.length || !b.length) continue;
  nR++; if (modal(a) === modal(b)) agreeR++;
}
const rateFree = agree / n, floor = nR ? agreeR / nR : 1;
const ciF = wilson(agree, n);
const tvMean = tvs2.reduce((a, b) => a + b, 0) / (tvs2.length || 1);
const tvCI = bootCI(tvs2);
const discard = 1 - rateFree, discFloor = nR ? 1 - floor : 0;
const sig = oneSidedP(discard, n, Math.max(1e-6, discFloor));

console.log('===== free 腿 vs 官方：统计判定 =====');
console.log(`\n[主对比] free vs 存档官方   n=${n} 局面`);
console.log(`  众数一致率 ${(100 * rateFree).toFixed(1)}%   95%CI [${(100 * ciF[0]).toFixed(1)}%, ${(100 * ciF[1]).toFixed(1)}%]`);
console.log(`  TV 距离均值 ${(tvMean).toFixed(3)}   95%CI [${tvCI[0].toFixed(3)}, ${tvCI[1].toFixed(3)}]`);
console.log(`\n[噪声地板] 官方 vs 官方(重打)  n=${nR} 局面`);
console.log(`  自一致率 ${(100 * floor).toFixed(1)}%  ⇒ 单次调用的可复现上限`);
console.log(`\n[判定] free 不一致率 ${(100 * discard).toFixed(1)}% 对比 地板 ${(100 * discFloor).toFixed(1)}%`);
console.log(`  单侧检验 z=${sig.z.toFixed(2)}  p=${sig.p.toExponential(2)}  ${sig.p < 0.01 ? '★ free 显著偏离官方（超出噪声）' : sig.p < 0.05 ? '● 有证据显示偏离' : sig.p < 0.2 ? '◐ 弱证据' : '○ 与官方不可区分（在噪声内）'}`);
console.log(`  判读：TV ${tvMean < 0.1 ? '<0.1 ✓' : tvMean < 0.3 ? '0.1–0.3 部分' : '>0.3 显著'}；一致率 ${100 * rateFree > 85 ? '>85% ✓' : 100 * rateFree > 60 ? '60–85 部分' : '<60% ✗'}`);

// per-label
const byL = {};
for (const r of free) { const off = (r.officialChoices || []).filter(Boolean), fr = r.freeCalls.filter((c) => !c.err && c.choice).map((c) => c.choice); if (!off.length || !fr.length) continue; (byL[r.label] = byL[r.label] || [0, 0]); byL[r.label][1]++; if (modal(fr) === modal(off)) byL[r.label][0]++; }
console.log('\n[分档] 众数一致率：' + Object.entries(byL).sort().map(([k, [a, b]]) => `${k} ${(100 * a / b).toFixed(0)}%(${b})`).join('  '));