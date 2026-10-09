#!/usr/bin/env node
/**
 * scripts/experiment-run.mjs — 用真浏览器跑一轮「对比实验」（CDP，零依赖）。
 *
 * 为什么需要它：`smoke:browser` 验的是「一条链路的活口」（能开局、能落子、对手会走），
 * 而「跑一轮 A/B 实验」是**长任务**——4 局机机对局要几百次模型调用、几分钟到几十分钟，
 * 中间还可能中途停下。用它把这件事变成可复现、可留证据（JSON）的一次运行：
 *   1. 起一个**干净 profile** 的 Chrome（localStorage 全空，不污染你日常浏览器的记录）；
 *   2. 打开站点 → 抽屉里填渠道与 API Key（只从环境变量 `JEV_API_KEY` 读，**绝不打印**）；
 *   3. 切到「实验」页签 → 填 A/B 渠道、战术档、思考时长、局数 → 点「开始实验」；
 *   4. 轮询 `#expStatus` / `#expResults`，打出心跳（局数、已走手数、上游调用次数与**HTTP 状态序列**）；
 *      若页面停在「等人工重试」（`#retryBtn` 可见）则**脚本代点**并计数——机机对局无人可点；
 *   5. 结束后从 localStorage 的 `jev-exp-history-v1` 取本轮 tag（**只认基线之外的新条目**，
 *      没跑满就不认），再回查 `GET /api/games?tag=<tag>`，确认**每一局都真的归档进了 D1**。
 *
 * 2026-10-01 的两次真跑把这份脚本的三个坑都暴露了出来，都已修：
 *   · 计量器只认绝对路径 `/api/jev`，而代理端点写的是相对串 `api/jev` → 始终「0 次调用」；
 *   · 失败时 `history[0]` 是上一轮的 tag → 归档核对会拿旧数据自欺；
 *   · 客户端旧实现 4 次尝试熬不过 60 秒限流窗口 → 整轮停在第 1 局，无人值守无人点重试。
 *
 * 2026-10-02 的第四次真跑又暴露一个坑，也已修：
 *   · Rapfi 那次要在局中首次实例化引擎 → 现抓 10 MB `.data`；本机到 Cloudflare 的链路当时
 *     只有 22 KB/s（448 s），抓失败时 Emscripten 抛 `TypeError: network error` 无人接住 ⇒
 *     整轮卡死在第 1 局（0/12，上游只调了 1 次）。现在缺省用 CDP `Fetch` 域把 `/rapfi/*`
 *     改由本地 `public/rapfi/` 供给（同一份构建产物），`--no-rapfi-local` 可关。
 *
 * 它不碰应用内部 API（除了把 fetch 包一层计数），所以跑的就是产品路径。
 *
 * 用法：
 *   $env:JEV_API_KEY='apikey_…'                     # PowerShell；key 只进环境变量
 *   node scripts/experiment-run.mjs --games 4
 *   node scripts/experiment-run.mjs --games 20 --tacA v9-vcf-sound --tacB v8-vcf-try
 *   node scripts/experiment-run.mjs --chanA proxy --chanB rapfi --games 10
 *   node scripts/experiment-run.mjs --url http://localhost:8787/ --headful --keep
 *   node scripts/experiment-run.mjs --games 12 --stall-min 8 --timeout-min 150   # 12 局机机对局
 *
 * 退出码：0 = 跑完且 N 局全部归档；1 = 有异常/没跑满；2 = 参数或环境不对
 *        （缺 key、局数越界、找不到 Chrome）。结果同时写到 `--out`（默认
 *        `.work/experiment-run.json`），含每局结果、上游调用与 token 消耗。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT, allIds, nearestId } from '../src/core/tactics-versions.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const URL_TARGET = flag('url', 'https://jevqipan.logicc.top/');
const GAMES = Number(flag('games', '4'));
const CHAN_A = flag('chanA', 'proxy');
const CHAN_B = flag('chanB', 'proxy');
/* A 方战术缺省跟随登记表的 CURRENT（Node ≥ 22.18 能直载 src 里的 .ts，见 AGENTS「引擎可被纯 Node 直载」） */
const TAC_A = flag('tacA', CURRENT);
/* B 方战术：旧默认写死 `v9-vcf-sound`，在 Rapfi 臂上会变成一个**惰性档位**（Rapfi 不进战术层），
   归档照抄后报表里冒出 `rapfi|v9-vcf-sound` 幻影身份（2026-10-02 事故）。缺省改为 CURRENT，
   与 A 方同口径；真正不过战术层的渠道由归档侧 `tacticsLabel()` 统一写空。 */
const TAC_B = flag('tacB', CURRENT);
const THINK_A = flag('thinkA', '');
const THINK_B = flag('thinkB', '');
const PORT = Number(flag('port', '9444'));
const HEADFUL = has('headful');
const KEEP = has('keep');
const STALL_MIN = Number(flag('stall-min', '5'));
const TIMEOUT_MIN = Number(flag('timeout-min', '60'));
const OUT = flag('out', join(ROOT, '.work', 'experiment-run.json'));
const PROFILE = join(ROOT, '.work', 'exp-chrome-profile');
const API_KEY = process.env.JEV_API_KEY ?? '';
/* 缺省把 `/rapfi/*` 的资产改由本地 `public/rapfi/` 供给（见 serveRapfiLocal 的注释）；
   `--no-rapfi-local` 关掉，让页面老老实实走网络。 */
const RAPFI_LOCAL = !has('no-rapfi-local');

/* 抽屉里的 key 存在**两个**输入框：`#apiKey`（TypeSafe/proxy 臂）与 `#orKey`（OpenRouter /
 * OpenCode / 自建 jev-router 网关臂）。浏览器实验面把 key 落到哪个框由渠道决定
 * （`src/app/loop.ts` 的 `eff.channel` 分派），所以两臂渠道不同时得分别填对。 */
const KEY_FIELDS = { proxy: 'apiKey', official: 'apiKey', opencode: 'orKey', openrouter: 'orKey', jevrouter: 'orKey' };
const NEEDS_KEY = [CHAN_A, CHAN_B].some((c) => c in KEY_FIELDS);
if (!Number.isFinite(GAMES) || GAMES < 1 || GAMES > 50) {
  console.error(`--games 必须在 1..50（收到 ${flag('games', '4')}）`);
  process.exit(2);
}
if (NEEDS_KEY && !API_KEY) {
  console.error('缺少 JEV_API_KEY：A/B 用到 proxy/official/opencode/openrouter/jevrouter 时必须给 key（只从环境变量读，不写盘）。');
  process.exit(2);
}
/* P0/D2：档位必须在登记表白名单里。过去未知档号会被 `resolve()` 静默换成 CURRENT
   （页面下拉里根本选不中那个值），于是命令行的 `--tacA v12-vct-de` 会「像成功一样」跑成 v14，
   A/B 的单变量假设直接失效。这里显式拒绝，并把最接近的合法档位一起打出来。 */
for (const [name, value] of [['--tacA', TAC_A], ['--tacB', TAC_B]]) {
  if (allIds().includes(value)) continue;
  console.error(`未知战术档位：${name} ${value}\n  最接近的合法档位：${nearestId(value) ?? '（无）'}\n  全部合法档位：${allIds().join(', ')}`);
  process.exit(2);
}

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  console.error('未找到 Chrome/Edge；请用 BROWSER_PATH 指定可执行文件路径。');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

console.log(`浏览器： ${BROWSER}`);
console.log(`目标：   ${URL_TARGET}`);
console.log(`对阵：   A=${CHAN_A}/${TAC_A}${THINK_A ? '/' + THINK_A + 'ms' : ''}  vs  B=${CHAN_B}/${TAC_B}${THINK_B ? '/' + THINK_B + 'ms' : ''}`);
/* 惰性档位提醒：`mock`/`rapfi` 两侧在 client.ts 里直接短路，战术档标签对它们没有意义
   （归档侧会写空；这里打出来免得有人照着日志读成「Rapfi 用了 vN 战术」）。 */
for (const [tag, chan] of [['A', CHAN_A], ['B', CHAN_B]]) {
  if (chan === 'mock' || chan === 'rapfi') {
    console.log(`         · ${tag} 方渠道 ${chan} 不过战术层：战术档标签惰性，归档里写空（tac_ms 也是 NULL）`);
  }
}
console.log(`局数：   ${GAMES}（key：${NEEDS_KEY ? `已提供（长度 ${API_KEY.length}）` : '不需要'}）`);
console.log('');

/* 上次跑留下的临时 profile 可能还被刚退出的 Chrome hold 着（Windows 上很常见）。 */
try {
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 2 });
} catch (err) {
  console.log(`（提示：旧临时 profile 没清掉（${err?.code ?? err}），复用 ${PROFILE}）`);
}
mkdirSync(PROFILE, { recursive: true });

const child = spawn(
  BROWSER,
  [
    HEADFUL ? '--headless=false' : '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ].filter(Boolean),
  { stdio: 'ignore' },
);

let ws = null;
let nextId = 1;
const pending = new Map();
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.exceptionDetails) {
    throw new Error(`页面内异常：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

async function waitFor(expression, { timeout = 20000, every = 250, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await evaluate(expression);
    } catch (err) {
      last = `异常：${err.message}`;
    }
    if (last) return last;
    if (Date.now() > deadline) {
      log(`（等待超时：${label}，最后取值 ${JSON.stringify(last)}）`);
      return last;
    }
    await sleep(every);
  }
}

/**
 * Rapfi 引擎资产（`rapfi-single-simd128.wasm` 1.1 MB + `.data` 10 MB）走生产域要下**几分钟**
 * （2026-10-02 本机实测 22 KB/s，10 MB 用了 448 s），而 Emscripten 抓失败时抛的
 * `TypeError: network error` 在装配层没人接住 ⇒ 整轮实验卡死在第 1 局（AI 只走了一手）。
 *
 * 这里用 CDP 的 `Fetch` 域把页面发出的 `/rapfi/*` 请求**改由本地 `public/rapfi/` 供给**：
 * 文件名、Content-Type、字节内容都与线上一致（同一份构建产物），只是不再走那条慢链路。
 * 被测行为不变（Rapfi 还是同一个 wasm + 同一份权重），变的是「字节从哪来」。
 */
const RAPFI_MIME = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream' };
const rapfiLocal = { served: 0, bytes: 0, missed: [] };

async function serveRapfiLocal(params) {
  const { requestId, request } = params;
  try {
    const url = new URL(request.url);
    const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const file = join(ROOT, 'public', 'rapfi', name);
    if (!RAPFI_LOCAL || !name || !existsSync(file)) {
      if (name && !rapfiLocal.missed.includes(name)) rapfiLocal.missed.push(name);
      await send('Fetch.continueRequest', { requestId });
      return;
    }
    const buf = readFileSync(file);
    const ext = name.slice(name.lastIndexOf('.'));
    rapfiLocal.served += 1;
    rapfiLocal.bytes += buf.length;
    await send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: RAPFI_MIME[ext] ?? 'application/octet-stream' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: buf.toString('base64'),
    });
  } catch (err) {
    pageErrors.push(`本地 Rapfi 资产供给失败：${err instanceof Error ? err.message : String(err)}`);
    try {
      await send('Fetch.continueRequest', { requestId });
    } catch {
      /* 已经放走了 */
    }
  }
}

/**
 * 上游调用计量：只包一层 fetch，数 `/api/jev` 的次数、HTTP 状态与 usage token（不碰应用内部）。
 *
 * 2026-10-01 修：旧版按 `url.indexOf('/api/jev') >= 0` 匹配，而 `CHANNELS.proxy.endpoint` 是
 * **相对串** `'api/jev'`（`src/core/jev/client.ts:29`），于是计量器永远匹配不上——上一轮
 * 全局限流失败时它报的是「上游 0 次（错 0）」，恰恰把唯一的证据藏了起来。现在两边写法都认，
 * 并把状态码记下来（判「是不是被自己的限流挡住」靠它，不靠猜）。
 */
const METER_INSTALL = `(() => {
  if (window.__expMeter) return true;
  window.__expMeter = { calls: 0, inTokens: 0, outTokens: 0, httpErrors: 0, statuses: [], lastStatus: 0 };
  const isJev = (u) => /(^|\\/)api\\/jev(\\?|$)/.test(String(u || ''));
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = orig.apply(this, arguments);
    if (isJev(url)) {
      const m = window.__expMeter;
      m.calls++;
      p.then((r) => {
        m.lastStatus = r.status;
        m.statuses.push(r.status);
        if (m.statuses.length > 60) m.statuses.shift();
        if (!r.ok) m.httpErrors++;
        try {
          r.clone().json().then((j) => {
            const u = j && j.usage;
            if (u) { m.inTokens += u.input_tokens || 0; m.outTokens += u.output_tokens || 0; }
          }).catch(() => {});
        } catch (_e) { /* 非 JSON（SSE 等）忽略 */ }
      }, () => { m.httpErrors++; m.lastStatus = 0; m.statuses.push(0); });
    }
    return p;
  };
  return true;
})()`;

/** 页面侧一次快照：状态、局数、每局结果、上游计量、看板/流水、是否有等待人工的重试按钮。 */
const SNAPSHOT = `(() => {
  const t = (sel) => (document.querySelector(sel)?.textContent ?? '').trim();
  const rows = [...document.querySelectorAll('#expResults .exp-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim());
  const meter = window.__expMeter || { calls: 0, inTokens: 0, outTokens: 0, httpErrors: 0, statuses: [] };
  const status = t('#status');
  const rb = document.querySelector('#retryBtn');
  return {
    expStatus: t('#expStatus'),
    rows: rows.length,
    results: rows,
    feed: document.querySelectorAll('#feed > *').length,
    board: t('#boardInfo') || '',
    status: status,
    warn: /⚠/.test(status),
    retry: !!rb && !rb.classList.contains('hidden') && !rb.hidden,
    meter: {
      calls: meter.calls, inTokens: meter.inTokens, outTokens: meter.outTokens,
      httpErrors: meter.httpErrors, lastStatus: meter.lastStatus || 0,
      statuses: (meter.statuses || []).slice(-12),
    },
  };
})()`;

/** 逐个下拉/输入框地设值（每次重新查元素：改动会触发面板重画，句柄会失效）。 */
async function setControl(selector, value, label) {
  const out = await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return { err: 'missing' };
    e.value = ${JSON.stringify(value)};
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: e.value };
  })()`);
  if (!out || out.err) throw new Error(`设置 ${label} 失败：${out?.err ?? '未知'}`);
  if (out.value !== value) throw new Error(`设置 ${label} 失败：期望 ${value}，实际 ${out.value}（选项不存在？）`);
  return out.value;
}

let report = null;
try {
  // 1) 等调试端口
  let version = null;
  for (let i = 0; i < 120 && !version; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) version = await r.json();
    } catch {
      /* 还没起来 */
    }
    if (!version) await sleep(250);
  }
  if (!version) throw new Error(`浏览器调试端口 ${PORT} 未就绪`);
  log(`浏览器版本：${version.Browser}`);

  // 2) 开标签页并接上 CDP
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(`未捕获异常：${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push(`console.error：${(msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
    }
    if (msg.method === 'Fetch.requestPaused') {
      void serveRapfiLocal(msg.params);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  if (RAPFI_LOCAL) {
    await send('Fetch.enable', { patterns: [{ urlPattern: '*rapfi*', requestStage: 'Request' }] });
    log('Rapfi 资产：改由本地 public/rapfi/ 供给（绕开 10 MB 慢链路；--no-rapfi-local 可关）');
  }
  await send('Page.navigate', { url: URL_TARGET });

  // 3) 应用装配起来了
  const tabsOk = await waitFor(`document.querySelectorAll('#tabs button, #tabs [role=tab]').length > 0`, { label: '#tabs' });
  if (!tabsOk) throw new Error('页面没渲染出页签（站点没起来？）');
  log('页面已加载，装配层已跑起来');
  await evaluate(METER_INSTALL);

  // 4) 抽屉里填渠道 + key（只验证「落盘了」，不回显 key 本身）
  //    **两个输入框都填**：A/B 臂各自选完渠道后，`src/app/loop.ts` 按 `eff.channel` 去对应的框取 key
  //    （apiKey ← proxy/official，orKey ← opencode/openrouter/jevrouter）。只填一个的话，
  //    两臂渠道不同时必有一臂拿到空 key ⇒ 整轮 401，而脚本看不出是哪一臂坏了。
  const settingsState = await evaluate(`(() => {
    document.querySelector('#settingsGear')?.click();
    const ch = document.querySelector('#channel');
    const key = document.querySelector('#apiKey');
    const orKey = document.querySelector('#orKey');
    if (!ch || !key || !orKey) return { err: '抽屉里没有 #channel/#apiKey/#orKey' };
    ch.value = ${JSON.stringify(NEEDS_KEY ? 'proxy' : CHAN_A)};
    ch.dispatchEvent(new Event('change', { bubbles: true }));
    for (const el of [key, orKey]) {
      el.value = ${JSON.stringify(API_KEY)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem('jev_qiguan_settings_v2') || 'null'); } catch (_e) { /* 忽略 */ }
    return {
      channel: parsed && parsed.channel,
      keyLen: parsed && typeof parsed.apiKey === 'string' ? parsed.apiKey.length : 0,
      orKeyLen: parsed && typeof parsed.orKey === 'string' ? parsed.orKey.length : 0,
      needKey: ${NEEDS_KEY},
      wantLen: ${API_KEY.length},
    };
  })()`);
  if (settingsState?.err) throw new Error(settingsState.err);
  if (settingsState.channel !== (NEEDS_KEY ? 'proxy' : CHAN_A)) {
    throw new Error(`渠道没落盘：settings.channel=${settingsState.channel}`);
  }
  if (NEEDS_KEY && (settingsState.keyLen !== settingsState.wantLen || settingsState.orKeyLen !== settingsState.wantLen)) {
    throw new Error(`API Key 没落盘：apiKey 长度 ${settingsState.keyLen} / orKey 长度 ${settingsState.orKeyLen} ≠ ${settingsState.wantLen}`);
  }
  log(`设置已落盘：channel=${settingsState.channel}，apiKey 长度 ${settingsState.keyLen}，orKey 长度 ${settingsState.orKeyLen}`);
  await evaluate(`document.querySelector('#drawerClose')?.click(), true`);

  // 5) 切到「实验」页签并填 A/B
  const tabOk = await evaluate(`(() => {
    const tab = document.querySelector('[data-pane="exp"]');
    if (!tab) return false;
    tab.click();
    return document.querySelector('#expStartBtn') !== null;
  })()`);
  if (!tabOk) throw new Error('切不到「实验」页签（#expStartBtn 不在）');
  await setControl('#expChanA', CHAN_A, 'A 方渠道');
  await setControl('#expTacA', TAC_A, 'A 方战术');
  await setControl('#expThinkA', THINK_A, 'A 方思考时长');
  await setControl('#expChanB', CHAN_B, 'B 方渠道');
  await setControl('#expTacB', TAC_B, 'B 方战术');
  await setControl('#expThinkB', THINK_B, 'B 方思考时长');
  await setControl('#expGames', String(GAMES), '局数');
  const cfg = await evaluate(`(() => ({
    chanA: document.querySelector('#expChanA').value, tacA: document.querySelector('#expTacA').value, thinkA: document.querySelector('#expThinkA').value,
    chanB: document.querySelector('#expChanB').value, tacB: document.querySelector('#expTacB').value, thinkB: document.querySelector('#expThinkB').value,
    games: document.querySelector('#expGames').value,
  }))()`);
  log(`实验配置：A=${cfg.chanA}/${cfg.tacA}  B=${cfg.chanB}/${cfg.tacB}  ${cfg.games} 局`);

  // 6) 开跑
  /* 先记台账基线：本轮失败时 `history[0]` 还是上一次实验的 tag（上一轮就吃过这个亏，
   * 拿着旧 tag 去回查归档，等于自欺）。跑完只认「基线之外的新条目」。 */
  const baselineTags = await evaluate(`(() => {
    try { return JSON.parse(localStorage.getItem('jev-exp-history-v1') || '[]').map((e) => e && e.tag).filter(Boolean); } catch (_e) { return []; }
  })()`);
  const baseline = Array.isArray(baselineTags) ? baselineTags : [];
  log(`台账基线：${baseline.length} 条历史（最新 ${baseline[0] ?? '(空)'}）`);

  const startedAt = Date.now();
  await evaluate(`document.querySelector('#expStartBtn')?.click(), true`);
  const running = await waitFor(
    `(() => { const t = (document.querySelector('#expStatus')?.textContent ?? '').trim(); return /进行中|已完成/.test(t) ? t : ''; })()`,
    { label: '#expStatus 进入进行中', timeout: 20000, every: 200 },
  );
  if (!running) throw new Error('点了「开始实验」但 #expStatus 没进入进行中');
  log(`实验已开始（${running}）`);

  // 7) 轮询到跑满
  const deadline = startedAt + TIMEOUT_MIN * 60_000;
  let last = await evaluate(SNAPSHOT);
  let lastChange = Date.now();
  let lastPrint = 0;
  let done = false;
  let retryClicks = 0;
  while (Date.now() < deadline) {
    if (last.rows === GAMES && /已完成/.test(last.expStatus ?? '')) {
      done = true;
      break;
    }
    await sleep(5000);
    const now = await evaluate(SNAPSHOT);
    /* 兜底：应用自己会给可重试错误自动退避重试三次，但如果三次都没过（比如整轮都被限流），
     * 它就停下来等人工点「重试」。无人值守的脚本必须自己点，否则整轮报废。计数并记日志。 */
    if (now.retry) {
      retryClicks++;
      log(`#${retryClicks} 页面停在「等人工重试」（${now.status.slice(0, 70)}），脚本代点 #retryBtn`);
      await evaluate(`document.querySelector('#retryBtn')?.click(), true`);
    }
    const progressed = now.rows !== last.rows || now.meter.calls !== last.meter.calls || now.feed !== last.feed;
    if (progressed) lastChange = Date.now();
    last = now;
    if (Date.now() - lastPrint > 30_000) {
      lastPrint = Date.now();
      log(`心跳：${last.expStatus} · 已完成 ${last.rows}/${GAMES} 局 · 上游 ${last.meter.calls} 次（状态 ${last.meter.statuses.join(',') || '无'} · in ${last.meter.inTokens} / out ${last.meter.outTokens} tok，错 ${last.meter.httpErrors}）· 流水 ${last.feed} 行${last.warn ? ' · ⚠ 页面有报错状态：' + last.status.slice(0, 80) : ''}`);
    }
    if (Date.now() - lastChange > STALL_MIN * 60_000) {
      log(`⚠ ${STALL_MIN} 分钟没有任何进展（局数/调用数/流水都没动），中止`);
      break;
    }
  }
  const finishedAt = Date.now();
  log(done ? `实验跑满 ${GAMES} 局，用时 ${Math.round((finishedAt - startedAt) / 1000)}s` : `未跑满（${last.expStatus}，已完成 ${last.rows}/${GAMES}）`);

  // 8) 取本轮 tag（装配层把它写进 localStorage 的实验台账；只认基线之外的新条目）
  const history = await evaluate(`(() => {
    try { return JSON.parse(localStorage.getItem('jev-exp-history-v1') || '[]'); } catch (_e) { return []; }
  })()`);
  const list = Array.isArray(history) ? history : [];
  const entry = list.find((e) => e && typeof e.tag === 'string' && !baseline.includes(e.tag)) ?? null;
  const tag = entry ? entry.tag : '';
  if (tag) log(`本轮 tag：${tag}（台账新增第 ${list.indexOf(entry) + 1} 条）`);
  else log(`本轮 tag：取不到（台账没有新增条目——本轮大概率没跑完）`);

  // 9) 回查归档：这一轮的每一局都必须真的进了 D1（没跑满就不查，免得拿旧数据当成功）
  let archived = [];
  if (!done) {
    log('未跑满整轮，跳过归档核对（避免把上一轮的归档当成本轮成绩）');
  } else if (tag) {
    const apiUrl = new URL('/api/games', URL_TARGET);
    apiUrl.searchParams.set('tag', tag);
    apiUrl.searchParams.set('limit', '100');
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const r = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
        if (r.ok) {
          const body = await r.json();
          const list = Array.isArray(body?.games) ? body.games : [];
          if (list.length >= GAMES) {
            archived = list;
            break;
          }
        }
      } catch {
        /* 网络抖动重试 */
      }
      await sleep(5000);
    }
    log(`归档核对：GET /api/games?tag=${tag} → ${archived.length} 局（期望 ${GAMES}）`);
    for (const g of archived) {
      log(`  · #${g.expGameNo ?? '?'} ${g.gameUid} ${g.moveCount} 手 ${g.result ?? ''} ${g.blackChannel}/${g.whiteChannel}`);
    }
  }

  report = {
    url: URL_TARGET,
    config: cfg,
    tag,
    gamesWanted: GAMES,
    gamesFinished: last.rows,
    done,
    retryClicks,
    durationSec: Math.round((finishedAt - startedAt) / 1000),
    results: last.results,
    meter: last.meter,
    status: last.status,
    board: last.board,
    archived: archived.map((g) => ({
      gameUid: g.gameUid,
      expGameNo: g.expGameNo ?? null,
      moves: g.moveCount,
      result: g.result ?? null,
      black: `${g.blackChannel ?? ''}${g.blackTactics ? '/' + g.blackTactics : ''}`,
      white: `${g.whiteChannel ?? ''}${g.whiteTactics ? '/' + g.whiteTactics : ''}`,
    })),
    pageErrors,
    rapfiLocal: { enabled: RAPFI_LOCAL, ...rapfiLocal },
    expEntry: entry,
  };
  mkdirSync(join(ROOT, '.work'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  log(`报告已写入 ${OUT}`);
  if (RAPFI_LOCAL) {
    log(`Rapfi 资产：本地供给 ${rapfiLocal.served} 个文件 / ${(rapfiLocal.bytes / 1048576).toFixed(1)} MB${rapfiLocal.missed.length ? `，仍走网络：${rapfiLocal.missed.join(',')}` : ''}`);
  }
} catch (err) {
  pageErrors.push(`脚本异常：${err instanceof Error ? err.message : String(err)}`);
  log(`✗ ${err instanceof Error ? err.message : String(err)}`);
} finally {
  try {
    ws?.close();
  } catch {
    /* 忽略 */
  }
  if (!KEEP) {
    try {
      child.kill();
    } catch {
      /* 已经退了就算了 */
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(attempt === 0 ? 300 : 400);
      try {
        rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
        break;
      } catch (err) {
        if (attempt === 4) log(`（提示：临时 profile 没删掉（${err?.code ?? err}），可手动删：${PROFILE}）`);
      }
    }
  }
}

console.log('');
if (!report) {
  console.log('实验运行：失败（没有拿到结果）');
  for (const e of pageErrors.slice(0, 3)) console.log(`  ${e}`);
  process.exit(1);
}
const ok = report.done && report.gamesFinished >= GAMES && report.archived.length >= GAMES;
console.log(`实验运行：${report.gamesFinished}/${GAMES} 局完成，归档 ${report.archived.length}/${GAMES} 局，用时 ${report.durationSec}s${report.retryClicks ? `，脚本代点重试 ${report.retryClicks} 次` : ''}`);
console.log(`上游调用 ${report.meter.calls} 次（最后状态 ${report.meter.lastStatus || '无'} · 序列 ${report.meter.statuses.join(',') || '无'} · in ${report.meter.inTokens} / out ${report.meter.outTokens} tok，HTTP 错 ${report.meter.httpErrors}）`);
for (const line of report.results) console.log(`  ${line}`);
if (report.pageErrors.length) {
  console.log(`页面报错 ${report.pageErrors.length} 条：`);
  for (const e of report.pageErrors.slice(0, 5)) console.log(`  ${e}`);
}
process.exit(ok ? 0 : 1);
