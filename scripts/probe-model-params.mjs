/**
 * 采样参数探针：上游到底认不认 `temperature` / `top_p` / `seed`（计划 §9 第 1 条）。
 *
 * 为什么值得先探：Elo 阶梯现在最贵的一环是**方差**——`official:*` 每手都是模型采样出来的，
 * 同一局面重跑会给出不同着法（L2 里 12 对区间重叠、20 局分辨不出 5 pt）。若上游接受
 * 冻结类参数（`temperature: 0` 或 `seed`），跨轮方差会显著下降，同样的局数能分辨更小的差。
 *
 * 这个脚本**只读**：拿一份真实请求体（默认 `test/fixtures/jev/commandcode-systemone-2026-10-03.json`
 * 里的 `request`，它是 2026-10-03 真跑捕获的）、按变体表重复 POST，比较
 *   ① HTTP 状态：字段是**被接受**还是被拒（400/422）；
 *   ② 答案是否**逐字复现**（同一个 `choice` 出现几次、概率分布摆幅多大）。
 * 不写任何库、不改任何配置、不碰业主的 Worker。
 *
 * 用法（本机与 box 都能跑；box 上 key 在 /root/.jev-key）：
 *   node scripts/probe-model-params.mjs --dry-run                      # 只打印计划，零请求
 *   node scripts/probe-model-params.mjs --key-file .work/jev-key.txt    # 5 变体 × 4 次
 *   node scripts/probe-model-params.mjs --variants baseline,temp0 --repeats 6
 *
 * key 来源：`--key` > `$JEV_API_KEY` > `--key-file`（缺省 /root/.jev-key）。key 永不打印、永不入产物。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_KEY_FILE = '/root/.jev-key';
const DEFAULT_FIXTURE = 'test/fixtures/jev/commandcode-systemone-2026-10-03.json';
const DEFAULT_JSON = '.work/probe-model-params.json';
const DEFAULT_REPEATS = 4;
const DEFAULT_PAUSE_MS = 1500;
const TIMEOUT_MS = 60000;

/**
 * 变体表：**顺序即请求顺序**，`baseline` 永远第一个（后面每条都跟它比）。
 * `params` 会平铺进请求体顶层（和 `model`/`state`/`questions` 同级）。
 */
export const VARIANTS = [
  { id: 'baseline', label: '原样（不带采样字段）', params: {} },
  { id: 'temp0', label: 'temperature: 0', params: { temperature: 0 } },
  { id: 'seed', label: 'seed: 1234', params: { seed: 1234 } },
  { id: 'temp0-seed', label: 'temperature: 0 + seed: 1234', params: { temperature: 0, seed: 1234 } },
  { id: 'topp1', label: 'top_p: 1', params: { top_p: 1 } },
];

/** 取 `answers.<question>`：返回 `{choice, probabilities, confidence}`，缺字段一律 null（不猜）。 */
export function pickAnswer(response, question = 'move') {
  const a = response && typeof response === 'object' ? response.answers : null;
  const one = a && typeof a === 'object' ? a[question] : null;
  if (!one || typeof one !== 'object') return null;
  const choice = typeof one.choice === 'string' ? one.choice : null;
  const confidence = typeof one.confidence === 'number' ? one.confidence : null;
  const probabilities = {};
  if (one.probabilities && typeof one.probabilities === 'object') {
    for (const [k, v] of Object.entries(one.probabilities)) {
      if (typeof v === 'number') probabilities[k] = v;
    }
  }
  return { choice, confidence, probabilities };
}

/**
 * 把同一变体的多次重复压成读数：
 * `distinct` = 出现过几个不同 `choice`（1 ⇒ 逐字复现）；`spread` = 各标签概率的 (max−min) 最大值。
 * 非 200 的重复单独记 `errors`，不混进 `distinct`。
 */
export function summarizeRepeats(rows = []) {
  const ok = rows.filter((r) => r.status === 200 && r.answer && r.answer.choice);
  const errors = rows.filter((r) => r.status !== 200);
  const choices = ok.map((r) => r.answer.choice);
  const distinct = [...new Set(choices)];
  const labels = new Set();
  for (const r of ok) for (const k of Object.keys(r.answer.probabilities)) labels.add(k);
  let maxSpread = 0;
  const spread = {};
  for (const label of [...labels].sort()) {
    const vals = ok.map((r) => (typeof r.answer.probabilities[label] === 'number' ? r.answer.probabilities[label] : 0));
    if (!vals.length) continue;
    const s = Math.max(...vals) - Math.min(...vals);
    spread[label] = Number(s.toFixed(4));
    if (s > maxSpread) maxSpread = s;
  }
  const msList = rows.map((r) => r.ms).filter((n) => Number.isFinite(n));
  return {
    attempts: rows.length,
    okCount: ok.length,
    errorCount: errors.length,
    distinct: distinct.length,
    choices: distinct,
    identical: ok.length > 1 && distinct.length === 1,
    maxSpread: Number(maxSpread.toFixed(4)),
    spread,
    meanMs: msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : null,
  };
}

/** 计划 = 变体 × 次数，拍平成请求序列（测试与 `--dry-run` 都读它）。 */
export function buildPlan({ variants = VARIANTS, repeats = DEFAULT_REPEATS, question = 'move' } = {}) {
  if (!Number.isInteger(repeats) || repeats < 1) throw new RangeError(`repeats 必须是正整数：${repeats}`);
  if (!variants.length) throw new RangeError('至少需要一个变体');
  const plan = [];
  for (const v of variants) {
    for (let i = 1; i <= repeats; i++) plan.push({ variant: v.id, label: v.label, params: v.params, round: i, question });
  }
  return plan;
}

export function variantById(id) {
  const v = VARIANTS.find((x) => x.id === id);
  if (!v) throw new RangeError(`未知变体：${id}（可用：${VARIANTS.map((x) => x.id).join(', ')}）`);
  return v;
}

/**
 * 默认请求体 = 夹具里的真实 `request`，只留客户端真正会发的三个字段（`state`/`questions`/`model`）。
 *
 * 为什么要投影：夹具是 curl 捕获的，当时多带了一个顶层 `options`；**官方端点对多余顶层字段直接
 * 400 `api_usage_error / Invalid request.`**（2026-10-04 实测：连 baseline 都全败，见 `.work/probe-params-run.txt`），
 * 而 `src/core/jev/client.ts:208` 的 `const payload = { state: body.state, model: attempt.provider.model, questions: body.questions };`
 * 只发这三个 —— 探针必须跟客户端逐字一致，否则测的不是同一条路。
 */
export function baseRequestFrom(fixturePath, model = DEFAULT_MODEL) {
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (!raw || typeof raw.request !== 'object' || raw.request === null) {
    throw new Error(`夹具里没有 request：${fixturePath}`);
  }
  const req = raw.request;
  if (!req.state || !req.questions) throw new Error(`夹具的 request 缺 state/questions：${fixturePath}`);
  return { state: req.state, questions: req.questions, model };
}

export function resolveKey({ key, env = process.env, keyFile = DEFAULT_KEY_FILE, readFile = fs.readFileSync } = {}) {
  if (key) return { key, source: '--key' };
  if (env.JEV_API_KEY) return { key: env.JEV_API_KEY, source: 'env:JEV_API_KEY' };
  try {
    const text = String(readFile(keyFile, 'utf8'));
    const found = text.match(/(?:JEV_API_KEY\s*=\s*)?["']?([A-Za-z0-9_\-.]{20,})["']?/);
    if (found) return { key: found[1], source: `file:${keyFile}` };
  } catch {
    /* 落空就是没有 key，交给调用方报错 */
  }
  return { key: '', source: '' };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    keyFile: DEFAULT_KEY_FILE,
    fixture: DEFAULT_FIXTURE,
    json: DEFAULT_JSON,
    repeats: DEFAULT_REPEATS,
    pause: DEFAULT_PAUSE_MS,
    question: 'move',
    variants: VARIANTS.map((v) => v.id),
    dryRun: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new RangeError(`${a} 需要一个值`);
      return v;
    };
    if (a === '--endpoint') out.endpoint = next();
    else if (a === '--model') out.model = next();
    else if (a === '--key') out.key = next();
    else if (a === '--key-file') out.keyFile = next();
    else if (a === '--fixture') out.fixture = next();
    else if (a === '--json') out.json = next();
    else if (a === '--repeats') out.repeats = Number(next());
    else if (a === '--pause') out.pause = Number(next());
    else if (a === '--question') out.question = next();
    else if (a === '--variants') out.variants = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new RangeError(`未知参数：${a}`);
  }
  if (!Number.isInteger(out.repeats) || out.repeats < 1) throw new RangeError(`--repeats 必须是正整数：${out.repeats}`);
  if (!Number.isFinite(out.pause) || out.pause < 0) throw new RangeError(`--pause 不能为负：${out.pause}`);
  for (const id of out.variants) variantById(id);
  return out;
}

export const USAGE = `采样参数探针（只读）—— 上游认不认 temperature / top_p / seed

用法：
  node scripts/probe-model-params.mjs [选项]

选项：
  --dry-run              只打印计划，零请求
  --key <k> / --key-file <p> / $JEV_API_KEY    key 来源（缺省 /root/.jev-key）
  --endpoint <url>       缺省 ${DEFAULT_ENDPOINT}
  --model <m>            缺省 ${DEFAULT_MODEL}
  --fixture <p>          取 request 的夹具，缺省 ${DEFAULT_FIXTURE}
  --variants a,b         只用这些变体（可用：${VARIANTS.map((v) => v.id).join(', ')}）
  --repeats <n>          每变体重复次数，缺省 ${DEFAULT_REPEATS}
  --pause <ms>           请求间隔，缺省 ${DEFAULT_PAUSE_MS}
  --question <q>         读 answers 里的哪个问题，缺省 move
  --json <p>             产物路径，缺省 ${DEFAULT_JSON}
  --quiet                只打结论
  -h, --help             这份说明`;

export function formatReport(results, { question = 'move' } = {}) {
  const lines = [];
  lines.push(`变体${' '.repeat(20)}状态  复现  不同答案  概率最大摆幅  均耗时`);
  for (const r of results) {
    const s = r.summary;
    const status = s.errorCount === 0 ? '200' : s.okCount === 0 ? `全败(${s.errorCount})` : `部分败(${s.errorCount})`;
    const repro = s.okCount > 1 ? (s.identical ? '是' : '否') : '样本不足';
    const pad = (txt, n) => String(txt) + ' '.repeat(Math.max(0, n - String(txt).length));
    lines.push(`${pad(r.label, 22)}${pad(status, 6)}${pad(repro, 6)}${pad(s.distinct, 10)}${pad(s.maxSpread, 14)}${s.meanMs ?? '-'} ms`);
    if (s.choices.length) lines.push(`  ${question} 取值：${s.choices.join(' / ')}${s.choices.length > 1 ? `（${s.attempts} 次里 ${s.distinct} 种）` : ''}`);
    for (const err of r.errors) lines.push(`  ⚠ HTTP ${err.status}：${err.detail}`);
  }
  const base = results.find((r) => r.id === 'baseline');
  const frozen = results.filter((r) => r.id !== 'baseline' && r.summary.okCount > 1 && r.summary.identical);
  if (base) {
    lines.push('');
    lines.push(
      `读数：baseline ${base.summary.identical ? '逐字复现（说明这个局面本来就稳）' : `有 ${base.summary.distinct} 种答案、概率最大摆幅 ${base.summary.maxSpread}`}` +
        `；被接受且复现的变体：${frozen.length ? frozen.map((r) => r.id).join('、') : '无'}`,
    );
  }
  return lines.join('\n');
}

/** 请求序列执行器：`post` 可注入（测试里换成假上游）。pause 只作用于真实调用之间的间隔。 */
export async function runProbe({ plan, post, pause = DEFAULT_PAUSE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRow } = {}) {
  const rows = new Map();
  let first = true;
  for (const step of plan) {
    if (!first && pause > 0) await sleep(pause);
    first = false;
    const started = Date.now();
    let row;
    try {
      const res = await post(step);
      row = { ...step, status: res.status, ms: res.ms ?? Date.now() - started, answer: res.answer, detail: res.detail ?? '' };
    } catch (err) {
      row = { ...step, status: 0, ms: Date.now() - started, answer: null, detail: err && err.message ? err.message : String(err) };
    }
    if (!rows.has(step.variant)) rows.set(step.variant, []);
    rows.get(step.variant).push(row);
    if (onRow) onRow(row);
  }
  const results = [];
  for (const [variant, list] of rows) {
    results.push({
      id: variant,
      label: list[0].label,
      params: list[0].params,
      rows: list,
      errors: list.filter((r) => r.status !== 200).map((r) => ({ status: r.status, detail: r.detail })),
      summary: summarizeRepeats(list),
    });
  }
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  let body;
  try {
    body = baseRequestFrom(args.fixture, args.model);
  } catch (err) {
    console.error(`✗ ${err.message}（--fixture 指一份捕获过 request 的夹具）`);
    return 2;
  }
  const variants = args.variants.map(variantById);
  const plan = buildPlan({ variants, repeats: args.repeats, question: args.question });

  if (args.dryRun) {
    console.log(`探针计划：${variants.length} 变体 × ${args.repeats} 次 = ${plan.length} 个请求 → ${args.endpoint}`);
    for (const v of variants) console.log(`  · ${v.id}（${v.label}）params=${JSON.stringify(v.params)}`);
    console.log(`夹具 ${args.fixture}｜模型 ${args.model}｜间隔 ${args.pause} ms｜（--dry-run：没有发任何请求）`);
    return 0;
  }

  const { key, source } = resolveKey({ key: args.key, keyFile: args.keyFile });
  if (!key) {
    console.error(`✗ 没有 key：--key / $JEV_API_KEY / --key-file（试过 ${args.keyFile}）`);
    return 2;
  }
  if (!args.quiet) console.log(`上游 ${args.endpoint}｜模型 ${args.model}｜key 来源：${source}｜计划 ${plan.length} 个请求`);

  const post = async (step) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetch(args.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, ...step.params }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.status !== 200) {
        return { status: res.status, ms: Date.now() - started, answer: null, detail: text.slice(0, 200) };
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { status: res.status, ms: Date.now() - started, answer: null, detail: `响应不是 JSON：${text.slice(0, 120)}` };
      }
      return { status: 200, ms: Date.now() - started, answer: pickAnswer(parsed, step.question) };
    } finally {
      clearTimeout(timer);
    }
  };

  const results = await runProbe({
    plan,
    post,
    pause: args.pause,
    onRow: args.quiet ? null : (row) => console.log(`  · ${row.variant} #${row.round} → HTTP ${row.status}${row.answer && row.answer.choice ? ' ' + row.answer.choice : ''}（${row.ms} ms）`),
  });

  console.log('');
  console.log(formatReport(results, { question: args.question }));

  const artifact = {
    probedAt: new Date().toISOString(),
    endpoint: args.endpoint,
    model: args.model,
    fixture: args.fixture,
    question: args.question,
    repeats: args.repeats,
    keySource: source,
    variants: results.map((r) => ({ id: r.id, label: r.label, params: r.params, summary: r.summary, errors: r.errors, choices: r.rows.map((x) => x.answer && x.answer.choice) })),
  };
  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify(artifact, null, 2) + '\n');
    if (!args.quiet) console.log(`\n产物：${args.json}`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''));
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`✗ ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}
