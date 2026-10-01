#!/usr/bin/env node
/**
 * scripts/browser-smoke.mjs — 无依赖的浏览器端到端冒烟（CDP）。
 *
 * 为什么需要它：P8 的验收项里有一条「浏览器全流程回归」，而仓库不引任何浏览器自动化
 * 依赖（ADR-0012 只允许 vite/typescript/hono 这类必要依赖）。这里用系统自带的
 * Chrome / Edge 以 `--headless=new --remote-debugging-port` 起一个实例，通过 Node 内置的
 * 全局 `WebSocket`（Node ≥ 22）直接说 CDP 协议，因此**零 npm 依赖**。
 *
 * 它验证的是「真浏览器里装配层真的跑起来了」——正好补上 happy-dom 单测（没有布局、
 * 没有 canvas 绘制、没有真实事件循环）与 HTTP 冒烟（没有 UI）之间的空隙：
 *   1. 页面能加载、模块脚本无异常；
 *   2. 页签/面板由 JS 渲染出来（说明 src/app 装配到了 src/ui）；
 *   3. 开始一局「离线演示」对局后状态栏与棋盘的**像素**都发生变化（说明落子循环在跑）；
 *   4. 设置抽屉、趋势曲线切换等交互不抛异常；
 *   5. 全程页面无未捕获异常 / console.error。
 *
 * 用法：
 *   node scripts/browser-smoke.mjs                          # 默认打本地 dev/preview 地址
 *   node scripts/browser-smoke.mjs --url https://jevqipan.logicc.top
 *   node scripts/browser-smoke.mjs --channel rapfi          # 走 Rapfi 渠道（首次要下 10MB）
 *   node scripts/browser-smoke.mjs --offline                # 用 CDP 掐掉所有 /api/ 请求，验「无后端降级」
 *   node scripts/browser-smoke.mjs --headful --keep         # 看得见窗口、跑完不关
 *
 * `--offline` 验的是计划 D8 的硬要求：后端不可用时必须是「离线演示 + localStorage 战绩簿」，
 * 而不是白屏或抛异常。它靠 CDP 的 Fetch 域在**请求发出前**把 `/api/` 开头的请求全部 fail 掉
 * （不依赖应用内部有没有 try/catch，也不依赖网络环境），所以是可复现的降级测试。
 *
 * 退出码：0 = 全过；1 = 有失败项（逐条打印）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const URL_TARGET = flag('url', 'http://localhost:8787/');
const CHANNEL = flag('channel', 'mock'); // 默认离线演示：不花 key、不依赖网络
const PORT = Number(flag('port', '9333'));
const HEADFUL = has('headful');
const KEEP = has('keep');
const OFFLINE = has('offline');
const PROFILE = join(ROOT, '.work', 'chrome-profile');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!BROWSER) {
  console.error('未找到 Chrome/Edge；请用 BROWSER_PATH 指定可执行文件路径。');
  process.exit(1);
}
console.log(`浏览器：${BROWSER}`);
console.log(`目标：  ${URL_TARGET}（渠道 ${CHANNEL}${OFFLINE ? '，离线模式：所有 /api/* 请求会被掐断' : ''}）`);

rmSync(PROFILE, { recursive: true, force: true });
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
    '--window-size=1440,960',
    'about:blank',
  ].filter(Boolean),
  { stdio: 'ignore' },
);

let ws = null;
let nextId = 1;
const pending = new Map();
const pageErrors = [];
let blockedApi = 0;

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`页面内异常：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

/** 轮询页面里的条件，直到为真或超时。返回最后一次的值。 */
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
      console.log(`  （等待超时：${label}，最后取值 ${JSON.stringify(last)}）`);
      return last;
    }
    await sleep(every);
  }
}

/** 棋盘画布上的「墨迹」指纹：非透明像素的数量与全校验和，用来判断真的画了东西。 */
const INK = `(() => {
  const c = document.querySelector('#board');
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  let n = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 8) n++;
    /* 校验和必须把 RGB 也拌进去：只累加 alpha 的版本在「整块不透明棋盘」上是常量，
       落一颗子完全不改它 —— 那种校验和会把「没落子」误判成「落了子」。 */
    sum = (sum * 31 + d[i] + 3 * d[i + 1] + 7 * d[i + 2] + d[i + 3]) % 2147483647;
  }
  return { w, h, n, sum };
})()`;

/** 一次采样：画布指纹 + 走子流水区状态。两者任一变化都算「真落了一手」。 */
const SIGNAL = `(() => {
  const c = document.querySelector('#board');
  if (!c) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum = (sum * 31 + d[i] + 3 * d[i + 1] + 7 * d[i + 2] + d[i + 3]) % 2147483647;
  const feed = document.querySelector('#feed');
  return { sum, feedEmpty: feed ? feed.querySelector('.feed-empty') !== null : true,
    feedKids: feed ? feed.children.length : -1 };
})()`;

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
  console.log(`浏览器版本：${version.Browser}`);

  // 2) 开一个标签页并接上 CDP
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
    if (msg.method === 'Fetch.requestPaused') {
      /* 离线模式：请求在发出前被掐断（等价于后端不可达），应用必须自己降级。
       *
       * 这里**必须按 pathname 判定**，不能见请求就掐：开发服务器把源码按原路径提供，
       * 应用自己的模块里有 `src/core/api/client.ts`，它同样命中 `*api*` 形状的模式 ——
       * 早期版本见请求就掐，结果掐掉了应用自己的 ES 模块，页面根本起不来（看起来
       * 像「离线降级坏了」，其实是冒烟脚本把前端源码拦了）。 */
      const reqId = msg.params.requestId;
      let path = '';
      try {
        path = new URL(msg.params.request.url).pathname;
      } catch (_e) {
        path = '';
      }
      if (path.startsWith('/api/')) {
        blockedApi++;
        send('Fetch.failRequest', { requestId: reqId, errorReason: 'Failed' }).catch(() => {});
      } else {
        send('Fetch.continueRequest', { requestId: reqId }).catch(() => {});
      }
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(`未捕获异常：${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      // 资源 404（例如未部署的 rapfi 资产）也算失败信号，但要看清是哪一条
      pageErrors.push(`console.error：${text}`);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  /* 固定视口：否则窗口尺寸受机器影响，棋盘大小/元素是否在首屏都会漂。 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (OFFLINE) {
    /* 模式尽量写窄（要求 pathname 以 /api/ 开头的那种 URL 才会暂停）；即便如此仍可能
       误伤 `src/core/api/client.ts` 这类源码路径，所以真正的判定在 requestPaused 里。 */
    await send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/*' }] });
  }
  await send('Page.navigate', { url: URL_TARGET });

  // 3) 装配层真的跑起来了：页签是 JS 渲染的，`#tabs` 空着就说明 main.ts 没接上
  const tabsOk = await waitFor(`document.querySelectorAll('#tabs button, #tabs [role=tab]').length > 0`, {
    label: '#tabs 里有页签',
  });
  check('页签由 JS 渲染（src/app 装配成功）', tabsOk);

  const title = await evaluate('document.title');
  check('页面标题非空', typeof title === 'string' && title.length > 0, title);

  // 4) 初始棋盘已绘制（不是一张空白 canvas）
  const ink0 = await waitFor(INK, { label: '棋盘初始绘制' });
  check('棋盘有初始绘制（canvas 非空白）', ink0 && ink0.n > 0, ink0 ? `${ink0.w}×${ink0.h}，${ink0.n} 像素上墨` : '拿不到画布');

  /* 真下一手：人机模式下人类执黑，「开始对局」本身不会自动落子 —— 必须在棋盘上真点一个
   * 交叉点。用 CDP 的 Input 域在画布上按下/抬起（不碰应用内部 API）；画布几何中心是 15 路
   * 棋盘的天元，一定合法，万一被拒（比如该点已有子）再试几个候选点。 */
  const playOneMove = async () => {
    /* 先滚动再**另起一次**求 rect：同一次 evaluate 里 scrollIntoView 之后立刻 getBoundingClientRect
     * 拿到的是滚动前的坐标，点击会落到别的元素上（第一版就是这么点的，五个候选点全不中）。 */
    await evaluate(`(() => { const c = document.querySelector('#board'); if (c) c.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(250);
    const rect = await evaluate(`(() => {
      const c = document.querySelector('#board');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    if (!rect || !rect.w || !rect.h) return { ok: false, detail: '拿不到画布尺寸' };
    /* 装事件计数器：失败时能立刻区分「事件没送到画布」和「送到了但应用没落子」 */
    await evaluate(`(() => { window.__smokeHits = 0;
      const c = document.querySelector('#board');
      if (c) for (const t of ['pointerdown', 'mousedown', 'click']) c.addEventListener(t, () => { window.__smokeHits++; }, true);
      return true; })()`);
    const before = await evaluate(SIGNAL);
    const candidates = [[0.5, 0.5], [0.45, 0.55], [0.55, 0.45], [0.4, 0.6], [0.6, 0.4]];
    for (const [fx, fy] of candidates) {
      const x = rect.x + rect.w * fx;
      const y = rect.y + rect.h * fy;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      const moved = await waitFor(
        `(() => { const s = ${SIGNAL}; if (!s || !${JSON.stringify(before)}) return '';
          const b = ${JSON.stringify(before)};
          const bits = [];
          if (s.sum !== b.sum) bits.push('画布指纹 ' + b.sum + '→' + s.sum);
          if (s.feedEmpty !== b.feedEmpty || s.feedKids !== b.feedKids) bits.push('流水区 ' + b.feedKids + '→' + s.feedKids);
          return bits.join('，'); })()`,
        { label: '棋盘出现落子', timeout: 8000, every: 150 },
      );
      if (moved) return { ok: true, detail: `${moved}（候选点 ${fx}/${fy}）` };
    }
    /* 保留现场：失败原因通常是「点在别的东西上」「事件没到画布」「应用拒了这手」三者之一 */
    const diag = await evaluate(`(() => {
      const c = document.querySelector('#board');
      const r = c.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { hits: window.__smokeHits ?? 0, top: top ? top.tagName + '#' + top.id : 'null',
        status: (document.querySelector('#status')?.textContent ?? '').trim().slice(0, 60) };
    })()`);
    return { ok: false, detail: `画布只收到 ${diag.hits} 次事件；该点最顶层 ${diag.top}；状态「${diag.status}」` };
  };

  // 5) 切到目标渠道（默认离线演示），确认设置真的落盘
  const channelSet = await evaluate(`(() => {
    const sel = document.querySelector('#channel');
    if (!sel) return 'no-select';
    sel.value = ${JSON.stringify(CHANNEL)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);
  check(`渠道切到 ${CHANNEL}`, channelSet === CHANNEL, String(channelSet));

  // 6) 开始一局：状态栏要变、棋盘要有新墨迹
  const statusBefore = await evaluate(`(document.querySelector('#status')?.textContent ?? '').trim()`);
  await evaluate(`document.querySelector('#startBtn')?.click(), true`);
  const statusAfter = await waitFor(
    `(() => { const t = (document.querySelector('#status')?.textContent ?? '').trim();
      return t && t !== ${JSON.stringify(statusBefore)} ? t : ''; })()`,
    { label: '#status 变化', timeout: 30000 },
  );
  check('点「开始对局」后状态栏变化', Boolean(statusAfter), statusAfter || `仍是「${statusBefore}」`);

  /* 注意：`playOneMove()` 返回的是对象，对象恒为真 —— 必须判 `.ok`，否则这一项永远绿。 */
  const inkMove = await playOneMove();
  check('棋盘像素变化（真的落子了）', inkMove.ok, inkMove.detail);

  /* 人机对局的另一半：人类落子后轮到对手，对手（演示启发式 / Rapfi WASM / Jev）也得真落一子。
   * 这条同时是 Rapfi 资产迁移（`public/rapfi/*` → Static Assets）的端到端证据：Rapfi 首次走子
   * 才懒加载 10.7MB 的 .wasm/.data，所以给它更长的等待窗口；任何 404 都会在下面的报错检查里现形。 */
  if (inkMove.ok) {
    const afterHuman = await evaluate(SIGNAL);
    const aiTimeout = CHANNEL === 'rapfi' ? 90000 : 20000;
    const aiMoved = await waitFor(
      `(() => { const s = ${SIGNAL}; const b = ${JSON.stringify(afterHuman)};
        if (!s || !b) return '';
        const bits = [];
        if (s.sum !== b.sum) bits.push('画布指纹 ' + b.sum + '→' + s.sum);
        if (s.feedKids !== b.feedKids) bits.push('流水区 ' + b.feedKids + '→' + s.feedKids);
        return bits.join('，'); })()`,
      { label: '对手落子', timeout: aiTimeout, every: 250 },
    );
    check('「对手」也落了子（AI 走子链路）', Boolean(aiMoved), aiMoved || `等待 ${aiTimeout}ms 后棋盘与流水区都没再变化`);
  }

  // 7) 面板交互：趋势曲线切换 + 设置抽屉开合
  const chipState = await evaluate(`(() => {
    const win = document.querySelector('#chipWin');
    const score = document.querySelector('#chipScore');
    if (!win || !score) return { err: win ? 'no-chipScore' : 'no-chipWin' };
    score.click();
    return { win: win.classList.contains('active'), score: score.classList.contains('active') };
  })()`);
  check(
    '趋势曲线切换按钮可用',
    Boolean(chipState) && !chipState.err && chipState.score === true && chipState.win === false,
    chipState?.err ? String(chipState.err) : `点击后 chipScore.active=${chipState?.score}、chipWin.active=${chipState?.win}`,
  );

  const drawerState = await evaluate(`(() => {
    const gear = document.querySelector('#settingsGear');
    const drawer = document.querySelector('#settingsDrawer');
    const body = document.querySelector('#drawerBody');
    if (!gear || !drawer) return { err: gear ? 'no-settingsDrawer' : 'no-settingsGear' };
    const wasHidden = drawer.classList.contains('hidden');
    gear.click();
    const nowHidden = drawer.classList.contains('hidden');
    const bodyChildren = body ? body.children.length : -1;
    /* 复位：开着就点关闭，免得影响后续检查 */
    if (!nowHidden) document.querySelector('#drawerClose')?.click();
    return { wasHidden, nowHidden, bodyChildren, closedAgain: drawer.classList.contains('hidden') };
  })()`);
  check(
    '设置抽屉可开',
    Boolean(drawerState) && !drawerState.err && drawerState.nowHidden === false && drawerState.bodyChildren > 0,
    drawerState?.err
      ? String(drawerState.err)
      : `hidden：${drawerState?.wasHidden} → ${drawerState?.nowHidden}，抽屉正文 ${drawerState?.bodyChildren} 个子节点，关闭后 hidden=${drawerState?.closedAgain}`,
  );

  // 8) 全程无页面级报错
  await sleep(500);
  /* 离线模式下被掐断的请求本身会产生 `net::ERR_FAILED` 之类噪音，那不是应用缺陷；
     但**未捕获异常**仍然是缺陷，所以只过滤掉「明确指出被掐断」的那几行。 */
  const offlineNoise = /net::ERR_FAILED|ERR_FAILED|Failed to fetch|NetworkError when attempting to fetch/i;
  const realErrors = OFFLINE ? pageErrors.filter((e) => !offlineNoise.test(e)) : pageErrors;
  check(
    '无未捕获异常 / console.error',
    realErrors.length === 0,
    realErrors.slice(0, 3).join(' | ') ||
      (OFFLINE && pageErrors.length ? `已忽略 ${pageErrors.length} 条被掐断请求的噪音` : ''),
  );
  if (OFFLINE) {
    check('离线模式：/api/* 请求确实被掐断', blockedApi > 0, `掐断 ${blockedApi} 次`);
    check(
      '离线模式：功能不残（页签 + 棋盘 + 开局都在）',
      Boolean(tabsOk && ink0 && ink0.n > 0 && inkMove.ok),
      `页签 ${tabsOk ? '有' : '无'}，棋盘上墨 ${ink0?.n ?? 0}，落子 ${inkMove.ok ? '成功' : inkMove.detail}`,
    );
  }
} catch (err) {
  check('冒烟脚本自身执行', false, err instanceof Error ? err.message : String(err));
} finally {
  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log(`浏览器冒烟：${checks.length - failed.length}/${checks.length} 项通过`);
  if (failed.length) console.log(`失败项：${failed.map((c) => c.name).join('、')}`);
  try {
    ws?.close();
  } catch {
    /* 忽略 */
  }
  if (!KEEP) {
    child.kill();
    await sleep(300);
    rmSync(PROFILE, { recursive: true, force: true });
  }
  process.exit(failed.length ? 1 : 0);
}
