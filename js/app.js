'use strict';
/* app.js — 对局控制与数据可视化接线
 * 模式：人 vs Jev / Jev vs Jev / 人 vs 人；悔棋、认输、停一手、决策流、趋势图。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const GAME_ORDER = ['gomoku', 'gomoku-pro', 'go', 'xiangqi', 'chess', 'checkers', 'cc'];
  const STORE_KEY = 'jev_qiguan_settings_v2';
  const RECORDS_KEY = 'jev_qiguan_records_v1';
  const FEED_MAX = 40;

  const S = {
    gameId: 'gomoku', engine: null, ctx: null,
    st: null, ui: {}, history: [],
    mode: 'human-ai', humanSide: null,
    epoch: 0, inflight: null, paused: false,
    trendMode: 'win', aborter: null, sessionRecorded: false, sessionId: null,
    settings: { channel: 'proxy', apiKey: '', orKey: '', topK: 3, speed: 6, endpoints: {}, gameSync: true, rapfiThinkMs: 3000 },
  };

  /* ---------- 设置 ---------- */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(S.settings, JSON.parse(raw));
      if (!S.settings.endpoints) S.settings.endpoints = {};
    } catch (_) { /* ignore */ }
    $('channel').value = S.settings.channel;
    $('apiKey').value = S.settings.apiKey || '';
    $('orKey').value = S.settings.orKey || '';
    $('topK').value = String(S.settings.topK);
    $('speed').value = String(S.settings.speed);
    $('rapfiThinkMs').value = String(S.settings.rapfiThinkMs || 3000);
    $('gameSync').checked = S.settings.gameSync !== false;
    syncChannelUI();
  }
  /* 接口地址按渠道归档。必须在改写 S.settings.channel 之前调用：
     渠道切换时输入框里还是旧渠道的值，归到新渠道名下会串渠道。 */
  function stashEndpoint(ch) {
    if (ch === 'mock' || ch === 'rapfi' || !ch) return;
    S.settings.endpoints[ch] = $('endpoint').value.trim();
  }
  function saveSettings() {
    stashEndpoint(S.settings.channel);
    S.settings.channel = $('channel').value;
    S.settings.apiKey = $('apiKey').value.trim();
    S.settings.orKey = $('orKey').value.trim();
    S.settings.topK = parseInt($('topK').value, 10);
    S.settings.speed = parseInt($('speed').value, 10);
    S.settings.rapfiThinkMs = parseInt($('rapfiThinkMs').value, 10) || 3000;
    S.settings.gameSync = $('gameSync').checked;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S.settings)); } catch (_) { /* ignore */ }
    syncChannelUI();
  }
  const CHANNEL_NAMES = {
    official: '官方 API', openrouter: 'OpenRouter', proxy: '同源代理', mock: '离线演示',
    rapfi: 'Rapfi 本地',
  };
  function syncChannelUI() {
    const ch = $('channel').value;
    $('apiKeyLabel').classList.toggle('hidden', ch !== 'official' && ch !== 'proxy');
    $('apiKeyLabel').childNodes[0].textContent =
      ch === 'proxy' ? 'TypeSafe API Key（经代理透传，仅存本机）' : '官方 API Key（仅存本机）';
    $('orKeyLabel').classList.toggle('hidden', ch !== 'openrouter');
    $('endpointLabel').classList.toggle('hidden', ch === 'mock' || ch === 'rapfi');
    $('rapfiThinkLabel').classList.toggle('hidden', ch !== 'rapfi');
    $('endpoint').placeholder = BG.jev.presetEndpoint(ch) || '';
    $('endpoint').value = S.settings.endpoints[ch] || '';
    $('probeRow').classList.toggle('hidden', ch === 'mock');
    $('probeOut').textContent = '';
    $('speedRow').classList.toggle('hidden', $('mode').value !== 'ai-ai');
    const hint = {
      proxy: '推荐。代理只做同源转发（绕开浏览器跨域）：本地运行 python dev-proxy.py，或部署到 Cloudflare Pages（functions/ 已内置，一条命令）。你的 key 经请求头透传，服务端不存。',
      official: '实测官方 API 有来源白名单（仅 typesafe.ai 自有域可用），浏览器直连必被拦。官方 key 请改走「同源代理」：本地跑 dev-proxy.py 或部署站点后填 key，效果等同直连。',
      openrouter: '唯一可浏览器直连的渠道（OpenRouter 允许跨域），但需要的是 OpenRouter key（openrouter.ai 申请），不是 TypeSafe key。',
      mock: '离线演示：内置简单启发式 AI 与合成概率，无需 key。双击 index.html 打开时也走这里。',
      rapfi: '本地引擎：浏览器内运行的 Rapfi（Gomocup 协议），首次使用下载模型（约 10–40MB），之后纯本地走子，无需 key。',
    };
    $('modeHint').textContent = hint[ch] || '';
    updateChannelChip();
  }
  function updateChannelChip() {
    const ch = S.settings.channel;
    const eff = effectiveChannel();
    let name = CHANNEL_NAMES[ch] || ch;
    if (eff === 'mock' && ch !== 'mock') name += ' · 演示';
    $('channelChip').textContent = name;
  }
  function effectiveChannel() {
    const ch = S.settings.channel;
    if (ch === 'mock') return 'mock';
    /* Rapfi 是本地 WASM 引擎，无需 key、无远程探测，直接可用 */
    if (ch === 'rapfi') return 'rapfi';
    /* 双击 file:// 打开时同源代理必然不存在，直接落演示，不再让第一手棋报 Failed to fetch */
    if (ch === 'proxy' && location.protocol === 'file:') return 'mock';
    /* 自定义端点视作用户明确要求走该渠道：不再因未填 key 回落演示模式 */
    if (S.settings.endpoints && S.settings.endpoints[ch]) return ch;
    if (ch === 'proxy') return 'proxy';
    const key = ch === 'openrouter' ? S.settings.orKey : S.settings.apiKey;
    if (!key) return 'mock';
    return ch;
  }
  /* 实验模式下黑白方可走不同渠道；平时与 effectiveChannel() 一致 */
  function effectiveChannelFor(side) {
    if (S.expChannels && S.engine) {
      const ch = side === S.engine.sides[0].id ? S.expChannels.black : S.expChannels.white;
      if (ch) return ch;
    }
    return effectiveChannel();
  }

  /* 连通性探测：直接读输入框当前值（测的就是眼前这套配置，不依赖是否已保存） */
  let probing = false;
  async function runProbe() {
    if (probing) return;
    const ch = $('channel').value;
    /* mock 无需探测；rapfi 是本地引擎，探测改为触发懒加载 */
    if (ch === 'mock') return;
    if (ch === 'rapfi') {
      probing = true;
      const btn = $('probeBtn');
      const out = $('probeOut');
      btn.disabled = true;
      out.className = 'pending';
      out.textContent = '加载 Rapfi 引擎中…（首次约 10–40MB）';
      try {
        await BG.rapfi.ensureLoaded();
        out.textContent = '✓ Rapfi 本地引擎就绪';
        out.className = 'ok';
      } catch (e) {
        out.textContent = '✗ ' + e.message;
        out.className = 'fail';
      } finally {
        btn.disabled = false;
        probing = false;
      }
      return;
    }
    probing = true;
    const btn = $('probeBtn');
    const out = $('probeOut');
    btn.disabled = true;
    out.className = 'pending';
    out.textContent = '探测中…（最长 10 秒）';
    const apiKey = ch === 'openrouter' ? $('orKey').value.trim() : $('apiKey').value.trim();
    let r;
    try {
      r = await BG.jev.probe({ channel: ch, apiKey, endpoint: $('endpoint').value.trim() });
    } finally {
      btn.disabled = false;
      probing = false;
    }
    out.textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
    out.className = r.ok ? 'ok' : 'fail';
  }

  /* ---------- 侧栏折叠（一屏放下：驾驶舱常开，其余面板可收起） ---------- */
  const FOLD_KEY = 'jev_qiguan_panels_v1';
  /* 折叠期间容器 display:none，图表量宽为 0：展开后补一次全量渲染 */
  const FOLD_HOOKS = {
    trend: () => renderAnalytics(),
    duel: () => renderCockpit(),
    latest: () => renderLatest(S.history.length ? S.history[S.history.length - 1] : null),
    feed: () => renderFeed(),
    records: () => renderRecords(),
    cal: () => renderCalibration(),
  };
  function loadFoldOpen() {
    try {
      const raw = localStorage.getItem(FOLD_KEY);
      if (raw === null) return ['trend', 'expreport']; /* 首访默认：驾驶舱 + Jev 判断 + 实验报告展开 */
      return JSON.parse(raw) || [];
    } catch (_) { return ['trend']; }
  }
  function saveFoldOpen(open) {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(open)); } catch (_) { /* ignore */ }
  }
  function applyFolded(pid, folded) {
    const sec = document.querySelector('.panel.collapsible[data-panel="' + pid + '"]');
    if (!sec) return;
    sec.classList.toggle('folded', folded);
    const btn = sec.querySelector('button.fold');
    if (btn) btn.setAttribute('aria-expanded', String(!folded));
  }
  function toggleFold(pid) {
    const sec = document.querySelector('.panel.collapsible[data-panel="' + pid + '"]');
    if (!sec) return;
    const willFold = !sec.classList.contains('folded');
    applyFolded(pid, willFold);
    /* 以 DOM 当前状态为准收集展开清单，避免与存储漂移 */
    const open = [...document.querySelectorAll('.panel.collapsible:not(.folded)')]
      .map((s) => s.dataset.panel);
    if (!willFold) {
      const hook = FOLD_HOOKS[pid];
      if (hook) hook();
    }
    saveFoldOpen(open);
  }
  function initFolds() {
    const open = loadFoldOpen();
    document.querySelectorAll('.panel.collapsible').forEach((sec) => {
      const pid = sec.dataset.panel;
      applyFolded(pid, !open.includes(pid));
      sec.querySelector('.panel-title').addEventListener('click', (e) => {
        /* 标题行内的实体控件（清空/曲线切换等）不触发折叠 */
        if (e.target.closest('button, select, input, a, label')) return;
        toggleFold(pid);
      });
      const btn = sec.querySelector('button.fold');
      if (btn) btn.addEventListener('click', () => toggleFold(pid));
    });
  }

  /* ---------- 侧栏页签（对局 / 数据 / 设置） ---------- */
  const SIDETAB_KEY = 'jev_qiguan_sidetab_v1';
  const SIDETAB_NAMES = ['play', 'data', 'settings'];
  /* runHooks：仅用户主动切换时补渲染。初始化调用必须传 false——
   * 此时 S.engine 尚未就绪（switchGame 在后面才跑），FOLD_HOOKS 里的
   * renderAnalytics → buildSeries 会直接抛 TypeError，把 DOMContentLoaded
   * 整个 handler 中断（bind/switchGame 全都不执行）。 */
  function activateSidePane(name, persist, runHooks) {
    document.querySelectorAll('.side-tabs button[data-pane]').forEach((b) => {
      const on = b.dataset.pane === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.side-pane').forEach((p) => {
      p.hidden = p.id !== 'pane-' + name;
    });
    if (persist) {
      try { localStorage.setItem(SIDETAB_KEY, name); } catch (_) { /* ignore */ }
    }
    if (!runHooks) return;
    /* 隐藏期间容器量宽为 0：切回时对已展开面板补一次全量渲染（与展开折叠同理） */
    const pane = document.getElementById('pane-' + name);
    if (!pane) return;
    pane.querySelectorAll('.panel.collapsible:not(.folded)').forEach((sec) => {
      const hook = FOLD_HOOKS[sec.dataset.panel];
      if (hook) hook();
    });
  }
  function initSideTabs() {
    const bar = document.querySelector('.side-tabs');
    if (!bar) return;
    let saved = null;
    try { saved = localStorage.getItem(SIDETAB_KEY); } catch (_) { /* ignore */ }
    activateSidePane(SIDETAB_NAMES.includes(saved) ? saved : 'play', false, false);
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pane]');
      if (b) activateSidePane(b.dataset.pane, true, true);
    });
    /* ←/→ 在页签间循环移动（WAI-ARIA tabs 惯例） */
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const btns = [...bar.querySelectorAll('button[data-pane]')];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
      n.focus();
      activateSidePane(n.dataset.pane, true, true);
    });
  }

  /* ---------- 通用 ---------- */
  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 6000 : 2600);
  }

  function sideName(id) {
    const s = S.engine.sides.find((x) => x.id === id);
    return s ? s.name : id;
  }

  /* 对局经验：同棋种、真实渠道的历史局里，与当前局面开局前 4 手相同的那部分，
     统计先手胜率注入 state.experience。样本 <2 局不给（噪声），离线演示局从不参与。 */
  function buildExperience(gid) {
    const k = Math.min(4, S.history.length);
    if (!k) return null;
    const prefix = S.history.slice(0, k).map((h) => h.move.notation);
    let n = 0, fw = 0;
    for (const r of loadRecords()) {
      if (r.gid !== gid || r.mock || !Array.isArray(r.notas)) continue;
      if (r.notas.length >= prefix.length && prefix.every((x, i) => r.notas[i] === x)) {
        n++;
        if (r.firstWin === true) fw++;
      }
    }
    if (n < 2) return null;
    return { opening_plies: prefix.length, games: n, first_player_win_rate: Math.round(fw / n * 100) / 100 };
  }

  /* 成本显示：极小值不显示成 $0.00000 */
  function fmtCost(c) {
    if (!c) return '$0';
    if (c < 0.000005) return '<$0.00001';
    return '$' + c.toFixed(5);
  }

  function setStatus(txt, over) {
    $('status').textContent = txt;
    $('status').classList.toggle('over', !!over);
  }

  function updateTurnBadge() {
    if (!S.st) return;
    const badge = $('turnBadge');
    const g = S.engine.getStatus(S.st);
    if (g.over) { badge.textContent = '对局结束'; badge.classList.remove('thinking'); return; }
    const isAI = isAISide(S.st.turn);
    const busy = S.inflight != null;
    badge.textContent = sideName(S.st.turn) +
      (isAI ? (busy ? ' · Jev 思考中' : ' · 等待 Jev') : ' · 请落子');
    badge.classList.toggle('thinking', isAI && busy);
  }

  function isAISide(side) {
    if (S.mode === 'ai-ai') return true;
    if (S.mode === 'pvp') return false;
    return side !== S.humanSide;
  }

  /* ---------- 页签与会话 ---------- */
  function buildTabs() {
    const nav = $('tabs');
    nav.innerHTML = '';
    GAME_ORDER.forEach((gid) => {
      if (!BG.games[gid]) return;
      const b = document.createElement('button');
      b.textContent = BG.games[gid].name;
      b.dataset.gid = gid;
      b.className = gid === S.gameId ? 'active' : '';
      b.setAttribute('aria-pressed', gid === S.gameId);
      b.onclick = () => {
        if (gid === S.gameId) return;
        /* 对局进行中切棋需确认，避免误触丢弃真实对局 */
        if (S.history.length >= 6 &&
            !window.confirm('当前已下 ' + S.history.length + ' 手，切换棋种将丢弃本局，确定？')) return;
        switchGame(gid);
      };
      nav.appendChild(b);
    });
  }

  function switchGame(gid) {
    S.gameId = gid;
    document.querySelectorAll('#tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.gid === gid);
      b.setAttribute('aria-pressed', b.dataset.gid === gid);
    });
    S.engine = BG.games[gid];
    $('gameName').textContent = S.engine.name;
    const sideSel = $('side');
    sideSel.innerHTML = '';
    S.engine.sides.forEach((sd) => {
      const o = document.createElement('option');
      o.value = sd.id; o.textContent = sd.name;
      sideSel.appendChild(o);
    });
    $('legendFirst').textContent = S.engine.sides[0].name;
    $('legendSecond').textContent = S.engine.sides[1].name;
    $('duelFirstName').textContent = S.engine.sides[0].name + ' Jev';
    $('duelSecondName').textContent = S.engine.sides[1].name + ' Jev';
    S.humanSide = S.engine.sides[0].id;
    resetSession();
  }

  function resetSession() {
    S.epoch++;
    if (S.aborter) { S.aborter.abort(); S.aborter = null; }
    S.inflight = null; S.paused = false;
    S.sessionRecorded = false;
    S.st = S.engine.newGame();
    S.ui = {};
    S.history = [];
    S.ctx = BG.gfx.setup($('board'), S.engine.meta.w, S.engine.meta.h);
    $('promoBox').classList.add('hidden');
    $('pauseBtn').textContent = '暂停';
    $('passBtn').classList.toggle('hidden', !S.engine.supportsPass);
    $('resignBtn').classList.toggle('hidden', !S.engine.supportsResign);
    $('retryBtn')?.classList.add('hidden');
    $('pauseBtn').classList.add('hidden');
    $('stepBtn').classList.add('hidden');
    $('ledger').innerHTML = '';
    $('costChip').textContent = '$0.00000';
    setStatus('已就绪：选择模式后点「开始对局」。', false);
    renderAnalytics();
    renderCockpit();
    renderFeed();
    redraw();
  }

  function redraw() {
    if (!S.engine) return;
    S.engine.draw(S.ctx, S.st, S.ui);
    updateTurnBadge();
  }

  /* ---------- 开始 / 结束 ---------- */
  function startGame() {
    saveSettings();
    S.mode = $('mode').value;
    S.humanSide = $('side').value;
    if (!EXP.running) { S.expChannels = null; S.expInfo = null; } // 手动开局不清掉上次实验的渠道
    S.paused = false;
    resetSession();
    const eff = effectiveChannel();
    if (eff === 'mock' && S.settings.channel !== 'mock') {
      toast('自动进入离线演示（未填 key，或本地双击打开时代理不可用）。接真实 Jev：部署站点或运行本地代理后填 key', false);
    }
    if (S.mode === 'ai-ai') {
      $('pauseBtn').classList.remove('hidden');
      $('stepBtn').classList.remove('hidden');
    }
    syncChannelUI();
    setStatus(inGameStatus(), false);
    if (isAISide(S.st.turn)) setTimeout(aiStep, aiDelayMs());
  }

  function finishGame(g) {
    let txt;
    if (g.winner === null) txt = '和棋：' + (g.reason || '');
    else txt = sideName(g.winner) + ' 获胜' + (g.reason ? '（' + g.reason + '）' : '');
    setStatus('终局 · ' + txt, true);
    toast(txt);
    $('pauseBtn').classList.add('hidden');
    $('stepBtn').classList.add('hidden');
    setEngineStatus('idle', '已终局');
    saveGameRecord(g);
    uploadGameRecord(); // 终局自动同步棋谱（可关）
    if (EXP.running) {
      // 实验连跑：记录本局，2.5 秒后自动开下一局（交替黑白）
      const blackChan = S.expChannels.black, whiteChan = S.expChannels.white;
      const winnerChan = !g.winner ? null
        : (g.winner === S.engine.sides[0].id ? blackChan : whiteChan);
      EXP.results.push({
        no: EXP.idx + 1, blackChan, whiteChan, winner: g.winner,
        winnerChan: winnerChan === EXP.chanA ? 'A' : (winnerChan === EXP.chanB ? 'B' : null),
      });
      EXP.idx++;
      renderExpStatus(); renderExpResults();
      setTimeout(() => { if (EXP.running) runExperimentGame(); }, 2500);
    }
  }

  /* 引擎状态灯：thinking / running / idle */
  function setEngineStatus(state, label) {
    const el = $('engineStatus');
    if (!el) return;
    el.className = 'status-light ' + state;
    el.innerHTML = '<i></i>' + (label || '待命');
  }

  /* ---------- 走子 ---------- */
  function playMove(move, meta) {
    if (!move) return false;
    const g0 = S.engine.getStatus(S.st);
    if (g0.over) return false;
    /* history 只留记法与展示用元数据，不再留 prev 的全量 state 快照（见 rebuildState 注释） */
    const h = { move, meta: meta || null, ply: S.history.length + 1, side: S.st.turn };
    S.history.push(h);
    S.st = S.engine.applyMove(S.st, move);
    appendLedgerLine(h);
    redraw();
    renderAnalytics();
    renderCockpit();
    /* 决策流只增不改，这里增量插入；人类走子不产生 AI 决策，无需重画 */
    if (meta && meta.byAI) prependFeed(h);
    const g = S.engine.getStatus(S.st);
    if (g.over) { finishGame(g); return true; }
    if (isAISide(S.st.turn)) setTimeout(aiStep, aiDelayMs());
    return true;
  }

  /* AI 走子入口：统一检查后再调度 */
  function aiStep() {
    if (!S.engine || S.inflight != null) return;
    if (S.engine.getStatus(S.st).over) return;
    if (S.mode === 'ai-ai' && S.paused) return;
    scheduleAI();
  }

  function aiDelayMs() {
    return S.mode === 'ai-ai' ? 150 + S.settings.speed * 150 : 120;
  }

  /* 思考计时器：慢时段让等待透明可见 */
  let thinkTimer = null;
  function startThinkClock(side) {
    stopThinkClock();
    const t0 = Date.now();
    thinkTimer = setInterval(() => {
      $('turnBadge').textContent = sideName(side) + ' · Jev 思考中 ' +
        ((Date.now() - t0) / 1000).toFixed(1) + 's';
    }, 100);
  }
  function stopThinkClock() {
    if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
  }

  async function scheduleAI() {
    if (!S.engine || S.inflight != null) return;
    const g = S.engine.getStatus(S.st);
    if (g.over) return;
    const myEpoch = S.epoch;
    S.inflight = myEpoch;
    S.aborter = new AbortController();
    const side = S.st.turn;
    startThinkClock(side);
    setEngineStatus('thinking', '推理中');
    try {
      const channel = effectiveChannelFor(side);
      const decision = await BG.jev.decide(S.engine, S.st, side, {
        channel,
        apiKey: channel === 'openrouter' ? S.settings.orKey : S.settings.apiKey,
        endpoint: (S.settings.endpoints && S.settings.endpoints[channel]) || '',
        experience: buildExperience(S.gameId),
        topK: S.settings.topK,
        rapfiThinkMs: S.settings.rapfiThinkMs,
        signal: S.aborter.signal,
        onRetry: (code) => toast('限流(' + code + ')，退避重试中…'),
      });
      if (myEpoch !== S.epoch) return; // 期间已重开/悔棋
      decision.meta.byAI = true;
      decision.meta.side = side;
      decision.meta.sideName = sideName(side);
      playMove(decision.move, decision.meta);
      $('retryBtn')?.classList.add('hidden');
    } catch (e) {
      if (myEpoch !== S.epoch) return;
      if (e.message === 'aborted') return;
      setStatus('⚠ AI 出错：' + e.message, true);
      toast('Jev 调用失败：' + e.message, true);
      /* 人机模式下给出重试入口，避免人类被锁死；机机模式暂停后可点继续 */
      $('retryBtn')?.classList.remove('hidden');
      if (S.mode === 'ai-ai') setPaused(true);
    } finally {
      stopThinkClock();
      if (S.inflight === myEpoch) S.inflight = null;
      updateTurnBadge();
      const gNow = S.engine ? S.engine.getStatus(S.st) : null;
      setEngineStatus(gNow && gNow.over ? 'idle' : 'running',
        gNow && gNow.over ? '已终局' : '对局中');
    }
  }

  function setPaused(p) {
    S.paused = p;
    $('pauseBtn').textContent = p ? '继续' : '暂停';
    if (!p && S.mode === 'ai-ai' && isAISide(S.st.turn) && S.inflight == null) {
      setTimeout(aiStep, 250);
    }
  }

  /* ---------- 棋谱导出 ---------- */
  /* 纯函数便于将来复用/测试；exportGame 只负责下载动作 */

  /* 校准样本（先手方视角的逐手胜率预测）：战绩簿与同步 payload 共用一份口径。
   * 离线演示的合成概率与 random 基线（noul 为 null）都不进样本——拿合成数据算校准
   * 等于自欺。firstWin 为 null（和棋）时由消费方（calibration / 后端 stats）剔除。
   * mock 标记按「本局是否没有任何真实渠道着法」判定：对比实验里一方 mock 一方 Jev 时，
   * Jev 那半局的样本仍然有效。 */
  function calSamples(g) {
    const items = aiItems();
    const firstId = S.engine.sides[0].id;
    const cal = items
      .filter((h) => !h.meta.mock && typeof h.meta.noul === 'number')
      .map((h) => {
        const v = h.meta.side === firstId ? h.meta.noul : 1 - h.meta.noul;
        return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
      });
    return {
      cal,
      firstWin: g.winner ? g.winner === firstId : null,
      mock: items.length > 0 && items.every((h) => h.meta.mock),
    };
  }

  function buildGameExport() {
    const g = S.engine.getStatus(S.st);
    const moves = S.history.map((h) => {
      const m = { ply: h.ply, side: sideName(h.side), notation: h.move.notation };
      if (h.meta && h.meta.tactics) m.tactics = h.meta.tactics;
      const ai = BG.util.aiMoveMeta(h.move.notation, h.meta);
      if (ai) m.ai = ai;
      return m;
    });
    const exp = S.expInfo || null;
    const cs = calSamples(g);
    return {
      format: 'jev-qiguan-game/v1',
      exported: new Date().toISOString(),
      game: S.engine.name,
      gid: S.gameId,
      mode: { 'human-ai': '人机', 'ai-ai': '机机', pvp: '双人' }[S.mode] || S.mode,
      channel: effectiveChannel(),
      blackChannel: exp ? exp.blackChannel : undefined,
      whiteChannel: exp ? exp.whiteChannel : undefined,
      experiment: exp ? exp.tag : undefined,
      expGameNo: exp ? exp.gameNo : undefined,
      result: g.over
        ? (g.winner ? sideName(g.winner) + ' 获胜' : '和棋') + '（' + (g.reason || '') + '）'
        : '进行中（已 ' + S.history.length + ' 手）',
      notation: moves.map((m) => m.notation).join(','),
      moves,
      meta: BG.util.aiGameMeta(S.history, { topK: S.settings.topK }),
      cal: cs.cal,
      firstWin: cs.firstWin,
      mock: cs.mock,
    };
  }
  function exportGame() {
    if (!S.engine || !S.history.length) { toast('还没有棋步可导出', true); return; }
    const data = buildGameExport();
    const name = 'jev-' + S.gameId + '-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.json';
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    toast('棋谱已导出 ' + name);
  }

  /* ---------- 棋谱自动同步 ---------- */
  /* 终局后把棋谱 POST 到 /api/games：
   *   - server.js 自托管后端 → 落盘 games/<日期>/（幂等，重传不覆盖）
   *   - CF Pages Functions   → GitHub API commit 进仓库（提交信息 [skip ci]）
   *   - 纯静态 / file://      → 请求自然失败，静默降级（不影响对局）
   * 结果写进「最近同步」一行：同步是增强功能，但用户有权知道它到底通不通。 */
  async function uploadGameRecord() {
    if (S.settings.gameSync === false) return;
    if (!S.engine || !S.history.length) return;
    try {
      const data = buildGameExport();
      const r = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) {
        console.warn('[gameSync] 上传失败:', r.status, await r.text().catch(() => ''));
        BACKEND.lastSync = { ok: false, text: '失败（HTTP ' + r.status + '）' };
      } else {
        const j = await r.json().catch(() => null);
        console.info('[gameSync] 棋谱已同步');
        BACKEND.lastSync = {
          ok: true,
          text: j && j.path ? '成功 · ' + String(j.path).split('/').pop() : '成功',
        };
      }
    } catch (e) {
      console.warn('[gameSync] 上传异常:', e);
      BACKEND.lastSync = { ok: false, text: '失败（无后端或网络异常）' };
    }
    renderBackend();
  }

  /* ---------- 后端探活与数据存储状态 ----------
   * live   = 同源后端在线（server.js：health/games/experiments/stats 全套）；
   * deploy = 没有 /api/health（CF Pages Functions 只有 /api/jev 与 /api/games，
   *          或纯静态托管）——棋谱同步仍会尝试，以「最近同步」一行为准。
   * 两种形态对访客的差异只在「数据存在哪」，对局功能完全一致。 */
  const BACKEND = { mode: 'pending', health: null, stats: null, lastSync: null };

  function setBackendChip(state, text) {
    const chip = $('backendChip'), b = $('backendState');
    if (!chip || !b) return;
    chip.classList.remove('pending', 'live', 'static');
    chip.classList.add(state);
    b.textContent = text;
  }

  function renderBackend() {
    const modeEl = $('backendMode'), gamesEl = $('backendGames'),
      expsEl = $('backendExps'), syncEl = $('backendSync'), hintEl = $('backendHint');
    if (!modeEl) return;
    if (BACKEND.mode === 'pending') {
      setBackendChip('pending', '检测中');
      modeEl.textContent = '检测中…';
      modeEl.className = '';
      if (hintEl) hintEl.textContent = '正在检测同源后端…';
      return;
    }
    if (BACKEND.mode === 'live') {
      const h = BACKEND.health || {};
      const st = BACKEND.stats;
      setBackendChip('live', '已连接');
      modeEl.textContent = (h.service || 'server') + (h.version ? ' v' + h.version : '');
      modeEl.className = 'ok';
      gamesEl.textContent = st ? st.totalGames + (st.truncated ? '+' : '') + ' 份' : (h.games != null ? h.games + ' 份' : '–');
      expsEl.textContent = st ? st.experiments + ' 轮' : '–';
      if (hintEl) {
        hintEl.textContent = h.github === false
          ? '后端在线，但服务端未配置 GAMES_GITHUB_TOKEN：棋谱同步与归档实际不可用（Pages 项目环境变量里配上即恢复）。'
          : '棋谱终局落盘到后端存储，实验战报归档到服务端，校准实验室可聚合全部已同步对局。';
      }
    } else {
      setBackendChip('static', '无本地后端');
      modeEl.textContent = '未检测到同源后端';
      modeEl.className = 'warn';
      gamesEl.textContent = '仅本机';
      expsEl.textContent = '仅本机';
      if (hintEl) hintEl.textContent = '未检测到同源后端（node server.js）。当前是静态托管或 CF Pages：棋谱同步仍会尝试 POST /api/games（Pages 上会提交进仓库），结果以「最近同步」为准；实验归档与跨对局统计只在本地。在仓库根目录运行 node server.js 即获得完整后端。';
    }
    if (syncEl) {
      syncEl.textContent = BACKEND.lastSync ? BACKEND.lastSync.text : '–';
      syncEl.className = BACKEND.lastSync ? (BACKEND.lastSync.ok ? 'ok' : 'warn') : '';
    }
  }

  async function initBackend() {
    const h = await BG.api.health();
    BACKEND.mode = h && h.ok ? 'live' : 'deploy';
    BACKEND.health = h && h.ok ? h : null;
    renderBackend();
    if (BACKEND.mode === 'live') {
      refreshServerExperiments();
      refreshServerStats();
    }
  }

  /* 服务端实验战报并入本地缓存（按 tag 合并：缺失或局数变多则更新），再重绘报告面板 */
  async function refreshServerExperiments() {
    const r = await BG.api.listExperiments();
    if (!r || !Array.isArray(r.experiments)) return;
    const list = loadExpHistory();
    let changed = false;
    r.experiments.forEach((e) => {
      if (!e || !e.tag) return;
      const i = list.findIndex((x) => x.tag === e.tag);
      if (i === -1) { list.push(e); changed = true; }
      else if ((list[i].games || []).length < (e.games || []).length) { list[i] = e; changed = true; }
    });
    if (changed) {
      list.sort((x, y) => String(y.date).localeCompare(String(x.date)));
      saveExpHistory(list);
    }
    renderExpHistory();
  }

  /* 服务端跨对局统计：校准实验室的第二数据源 + 设置面板的归档计数 */
  async function refreshServerStats() {
    const r = await BG.api.stats();
    if (!r || !r.ok) return;
    BACKEND.stats = r;
    renderBackend();
    renderCalibration();
  }

  /* ---------- 对比实验：A渠道 vs B渠道，自动交替执黑白 ---------- */
  const EXP = { running: false, idx: 0, total: 4, chanA: 'proxy', chanB: 'random', tag: null, results: [] };
  const CHAN_LABEL = { proxy: 'Jev(代理)', openrouter: 'Jev(OpenRouter)', official: 'Jev(官方)', random: '纯随机', mock: '离线演示', rapfi: 'Rapfi' };
  const chanLabel = (c) => CHAN_LABEL[c] || c;

  function startExperiment() {
    if (EXP.running) return;
    EXP.running = true; EXP.idx = 0; EXP.results = [];
    EXP.chanA = $('expChanA').value;
    EXP.chanB = $('expChanB').value;
    EXP.total = Math.max(1, Math.min(50, parseInt($('expGames').value, 10) || 4));
    EXP.tag = 'exp-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    $('expResults').innerHTML = '';
    runExperimentGame();
  }
  function runExperimentGame() {
    if (!EXP.running || EXP.idx >= EXP.total) { finishExperiment(); return; }
    const aBlack = EXP.idx % 2 === 0; // 偶数局 A 执黑：双方各执黑白一半
    S.expChannels = {
      black: aBlack ? EXP.chanA : EXP.chanB,
      white: aBlack ? EXP.chanB : EXP.chanA,
    };
    S.expInfo = {
      tag: EXP.tag, gameNo: EXP.idx + 1,
      blackChannel: S.expChannels.black, whiteChannel: S.expChannels.white,
    };
    $('mode').value = 'ai-ai';
    startGame(); // startGame 内非实验时才清 expChannels，此处 EXP.running 为 true 会保留
    setStatus(`实验 ${EXP.idx + 1}/${EXP.total}：${chanLabel(S.expChannels.black)}（黑） vs ${chanLabel(S.expChannels.white)}（白）`, false);
    renderExpStatus();
  }
  function stopExperiment() {
    EXP.running = false;
    S.expChannels = null; S.expInfo = null;
    renderExpStatus();
    toast('实验已停止');
  }
  function finishExperiment() {
    EXP.running = false;
    S.expChannels = null; S.expInfo = null;
    renderExpStatus(); renderExpResults(); recordExperiment();
    toast('实验完成：' + expSummary());
  }
  function expSummary() {
    let a = 0, b = 0, d = 0;
    EXP.results.forEach((r) => {
      if (!r.winner) d++;
      else if (r.winnerChan === 'A') a++;
      else b++;
    });
    return `${chanLabel(EXP.chanA)} ${a}胜 · ${chanLabel(EXP.chanB)} ${b}胜 · 和棋 ${d}`;
  }
  function renderExpStatus() {
    const el = $('expStatus');
    if (!el) return;
    el.textContent = EXP.running
      ? `进行中 ${EXP.idx + 1}/${EXP.total}`
      : (EXP.results.length ? '已完成' : '待开始');
    $('expStartBtn').classList.toggle('hidden', EXP.running);
    $('expStopBtn').classList.toggle('hidden', !EXP.running);
  }
  function renderExpResults() {
    const el = $('expResults');
    if (!el || !EXP.results.length) { if (el) el.innerHTML = ''; return; }
    const rows = EXP.results.map((r) =>
      `<div class="exp-row"><span>#${r.no}</span>` +
      `<span>${chanLabel(r.blackChan)}(黑)</span><span>vs</span><span>${chanLabel(r.whiteChan)}(白)</span>` +
      `<b>${r.winner ? '→ ' + chanLabel(r.winnerChan === 'A' ? EXP.chanA : EXP.chanB) + '胜' : '→ 和棋'}</b></div>`).join('');
    el.innerHTML = `<div class="exp-head">${expSummary()}</div>` + rows;
  }

  /* ---------- 实验历史归档（实验报告面板） ---------- */
  const EXP_HISTORY_KEY = 'jev-exp-history-v1';
  const JEV_CHANS = ['proxy', 'openrouter', 'official'];
  /* 两轮已跑完的真实实验（2026-09-29，棋谱已同步到仓库 games/2026-09-29/） */
  const EXP_SEED = [
    {
      tag: 'exp-20260929111222', date: '2026-09-29T11:12:22.000Z',
      chanA: 'proxy', chanB: 'random', total: 4,
      note: '次轮：random 渠道已修复为真随机采样。#4 下满 225 手和棋——双方 65 次战术触发全是防守，谁也没造出双杀；真随机散子起到了"搅局"作用。基线 4 局进攻性战术触发仍为 0。',
      games: [
        { no: 1, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A' },
        { no: 2, blackChan: 'random', whiteChan: 'proxy', winnerChan: 'A' },
        { no: 3, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A' },
        { no: 4, blackChan: 'random', whiteChan: 'proxy', winnerChan: null },
      ],
    },
    {
      tag: 'exp-20260929105234', date: '2026-09-29T10:52:34.000Z',
      chanA: 'proxy', chanB: 'random', total: 6,
      note: '首轮：基线因 topK=1 退化为顺序走子（A1→B1→C1…）；#1 与 #3 棋谱完全相同，记为重复局。基线 5 局进攻性战术（threat/open4/win）触发 0 次，纯被动防守。',
      games: [
        { no: 1, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A' },
        { no: 2, blackChan: 'random', whiteChan: 'proxy', winnerChan: 'A' },
        { no: 3, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A', dup: true },
        { no: 4, blackChan: 'random', whiteChan: 'proxy', winnerChan: 'A' },
        { no: 5, blackChan: 'proxy', whiteChan: 'random', winnerChan: 'A' },
        { no: 6, blackChan: 'random', whiteChan: 'proxy', winnerChan: 'A' },
      ],
    },
  ];
  function loadExpHistory() {
    /* 用内置种子补齐缺失或过时的条目（例如某局棋谱是部署后才同步到的），
     * 再按日期倒序排，保证新实验在前。 */
    const mergeSeed = (list) => {
      let changed = false;
      EXP_SEED.forEach((seed) => {
        const i = list.findIndex((e) => e.tag === seed.tag);
        if (i === -1) { list.push(seed); changed = true; }
        else if ((list[i].games || []).length < seed.games.length) { list[i] = seed; changed = true; }
      });
      if (changed) {
        list.sort((x, y) => String(y.date).localeCompare(String(x.date)));
        saveExpHistory(list);
      }
      return list;
    };
    try {
      const raw = localStorage.getItem(EXP_HISTORY_KEY);
      if (raw) { const list = JSON.parse(raw); if (Array.isArray(list)) return mergeSeed(list); }
    } catch (_) { /* ignore */ }
    const fresh = EXP_SEED.slice();
    saveExpHistory(fresh);
    return fresh;
  }
  function saveExpHistory(list) {
    try { localStorage.setItem(EXP_HISTORY_KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
  }
  function fmtExpDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function recordExperiment() {
    const entry = {
      tag: EXP.tag, date: new Date().toISOString(),
      chanA: EXP.chanA, chanB: EXP.chanB, total: EXP.total,
      games: EXP.results.map((r) => ({
        no: r.no, blackChan: r.blackChan, whiteChan: r.whiteChan,
        winnerChan: r.winner ? r.winnerChan : null,
      })),
      note: '',
    };
    const list = loadExpHistory();
    if (!list.some((e) => e.tag === entry.tag)) list.unshift(entry);
    saveExpHistory(list);
    renderExpHistory();
    /* 同步到服务端（无后端时 BG.api 自动降级返回 null，不影响本地归档） */
    BG.api.saveExperiment(entry).then((r) => { if (r && r.ok) refreshServerExperiments(); });
  }
  function renderExpHistory() {
    const el = $('expHistory');
    if (!el) return;
    const list = loadExpHistory();
    const noteEl = $('expReportNote');
    if (!list.length) {
      el.innerHTML = '<div class="hint">暂无实验记录——跑完一轮对比实验后，这里会自动归档战报。</div>';
      if (noteEl) noteEl.textContent = '';
      return;
    }
    let jevW = 0, baseW = 0, draws = 0, effGames = 0;
    const cards = list.map((e) => {
      let a = 0, b = 0, d = 0, eff = 0;
      const rows = e.games.map((g) => {
        const dup = !!g.dup;
        const wside = !dup ? g.winnerChan : null; // 'A' | 'B' | null
        const wchan = wside ? (wside === 'A' ? e.chanA : e.chanB) : null;
        if (!dup) {
          eff++;
          if (!wside) { d++; draws++; }
          else if (wside === 'A') { a++; }
          else { b++; }
          if (wchan) { if (JEV_CHANS.includes(wchan)) jevW++; else baseW++; }
        }
        const wl = dup ? '<span class="dim">重复局（与 #1 相同）</span>'
          : !wchan ? '→ 和棋'
          : '→ <b>' + chanLabel(wchan) + '胜</b>';
        return `<div class="exp-row"><span class="mono">#${g.no}</span>` +
          `<span>${chanLabel(g.blackChan)}(黑)</span><span class="dim">vs</span>` +
          `<span>${chanLabel(g.whiteChan)}(白)</span><span>${wl}</span></div>`;
      }).join('');
      effGames += eff;
      return `<div class="exp-card"><div class="exp-card-head">` +
        `<b>${chanLabel(e.chanA)} <span class="mono">${a} : ${b}</span> ${chanLabel(e.chanB)}</b>` +
        `<span class="dim">${eff} 局有效 · ${fmtExpDate(e.date)}</span></div>` +
        `<div class="exp-card-rows">${rows}</div>` +
        (e.note ? `<div class="hint">${e.note}</div>` : '') +
        `</div>`;
    }).join('');
    el.innerHTML =
      `<div class="exp-total">累计：Jev 渠道 <b class="mono">${jevW}</b> 胜 · 其他 <b class="mono">${baseW}</b> 胜` +
      (draws ? ` · 和棋 <b class="mono">${draws}</b>` : '') +
      `（${effGames} 局有效对局）</div>` + cards;
    if (noteEl) noteEl.textContent = `${list.length} 轮实验 · Jev ${jevW}:${baseW}`;
  }

  /* ---------- 数据可视化 ---------- */

  /* 从对局历史构建 Jev 判断序列（先手方视角） */
  function buildSeries() {
    const firstSide = S.engine.sides[0].id;
    return S.history
      /* random 基线着法不是 Jev 的判断，不进趋势图；放宽 noul 强要求，
       * 有任一可用信号即收录（旧棋谱/残缺响应也能画） */
      .filter((h) => h.meta && h.meta.byAI && h.meta.channel !== 'random' &&
        (typeof h.meta.noul === 'number' || typeof h.meta.score === 'number' ||
         typeof h.meta.confidence === 'number' ||
         (h.meta.top && h.meta.top.length && typeof h.meta.top[0].p === 'number')))
      .map((h) => {
        const mover = h.meta.side;
        const toFirst = mover === firstSide ? 1 : 0; // 0: 视角翻转
        const flip = (v, hi) => (toFirst ? v : hi - v);
        const noul = typeof h.meta.noul === 'number' ? h.meta.noul : null;
        const topP = (h.meta.top && h.meta.top.length && typeof h.meta.top[0].p === 'number') ? h.meta.top[0].p : null;
        return {
          ply: h.ply,
          notation: h.move.notation,
          sideName: h.meta.sideName,
          win: noul == null ? null : flip(noul, 1),
          /* 兜底让三个芯片永远有曲线：局势分缺失时用胜率×10（0-10 刻度），
           * 置信度缺失时用首选着法概率 */
          score: typeof h.meta.score === 'number' ? flip(h.meta.score, 10)
            : (noul == null ? null : flip(noul * 10, 10)),
          conf: typeof h.meta.confidence === 'number' ? h.meta.confidence : topP,
          latencyMs: h.meta.latencyMs,
          costUsd: h.meta.costUsd || 0,
          mock: !!h.meta.mock,
          detail: '置信度 ' +
            (typeof h.meta.confidence === 'number' ? (h.meta.confidence * 100).toFixed(0) + '%' : '–') +
            ' · ' + (h.meta.latencyMs || 0) + 'ms',
        };
      });
  }

  function renderAnalytics() {
    const series = buildSeries();
    const mode = S.trendMode;
    const points = series
      .filter((p) => typeof p[mode] === 'number')
      .map((p) => ({ ply: p.ply, notation: p.notation, sideName: p.sideName, value: p[mode], detail: p.detail }));
    BG.charts.renderTrend($('trend'), points, {
      mode,
      firstName: S.engine ? S.engine.sides[0].name : '',
      secondName: S.engine ? S.engine.sides[1].name : '',
    });
    $('trendNote').textContent = points.length
      ? points.length + ' 个决策 · 悬停或 ←/→ 巡检'
      : '悬停或用 ←/→ 巡检';

    /* 局势条：先手方胜率 */
    let pFirst = 0.5;
    for (let i = series.length - 1; i >= 0; i--) {
      if (typeof series[i].win === 'number') { pFirst = series[i].win; break; }
    }
    /* 写 transform 而非 height：避免 0.7s 过渡期间逐帧重排（见 .eval-fill 注释） */
    const fill = Math.min(96, Math.max(4, pFirst * 100)) / 100;
    $('evalFill').style.transform = 'scaleY(' + fill.toFixed(3) + ')';
    $('evalBar').setAttribute('aria-label',
      '实时局势：先手方胜率约 ' + Math.round(pFirst * 100) + '%');
    const cost = aiItems().reduce((s, h) => s + (h.meta.costUsd || 0), 0);
    $('costChip').textContent = fmtCost(cost);
  }

  /* ---------- Jev 驾驶舱：引擎 / 对决 / 最新决策 ---------- */
  function aiItems() {
    return S.history.filter((h) => h.meta && h.meta.byAI);
  }

  function renderCockpit() {
    const items = aiItems();
    const firstId = S.engine.sides[0].id;

    /* 引擎面板 */
    const cost = items.reduce((s, h) => s + (h.meta.costUsd || 0), 0);
    const tokens = items.reduce((s, h) => s + ((h.meta.usage && h.meta.usage.input_tokens) || 0), 0);
    const lats = items.map((h) => h.meta.latencyMs).filter(Boolean);
    $('emCost').textContent = fmtCost(cost);
    $('emTokens').textContent = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens);
    $('emMoves').textContent = String(items.length);
    $('emFastest').textContent = lats.length
      ? Math.round(Math.min(...lats)) + ' / ' + Math.round(Math.max(...lats)) + 'ms' : '–';
    const lastModel = [...items].reverse().find((h) => h.meta.model);
    if (lastModel) $('engineModel').textContent = lastModel.meta.model;
    renderSpark(lats.slice(-20));

    /* 双方对决 */
    renderDuel(items, firstId);

    /* 最新决策候选榜 */
    renderLatest(items.length ? items[items.length - 1] : null);
  }

  function renderSpark(lats) {
    const box = $('latSpark');
    box.innerHTML = '';
    if (!lats.length) {
      box.innerHTML = '<div class="spark-empty">尚无延迟数据</div>';
      $('sparkNow').textContent = '–';
      return;
    }
    const max = Math.max(...lats, 1);
    const frag = document.createDocumentFragment();
    lats.forEach((ms) => {
      const bar = document.createElement('i');
      /* scaleY 而非 height：缩放走合成层 */
      bar.style.transform = 'scaleY(' + (Math.max(6, Math.round(ms / max * 100)) / 100).toFixed(3) + ')';
      bar.title = ms + 'ms';
      bar.className = ms > 5000 ? 'slow' : '';
      frag.appendChild(bar);
    });
    box.appendChild(frag);
    $('sparkNow').textContent = Math.round(lats[lats.length - 1]) + 'ms';
  }

  function renderDuel(items, firstId) {
    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    [firstId, S.engine.sides[1].id].forEach((sideId, idx) => {
      const mine = items.filter((h) => h.meta.side === sideId);
      const el = idx === 0 ? $('duelFirst') : $('duelSecond');
      const rows = el.querySelectorAll('.duel-row b');
      if (!mine.length) {
        rows.forEach((b) => { b.textContent = '–'; });
        rows[2].textContent = '0';
        rows[3].textContent = '$0';
        return;
      }
      const confs = mine.filter((h) => typeof h.meta.confidence === 'number').map((h) => h.meta.confidence);
      /* 第二行的"均优势"按该方视角换算：先手取 noul，后手取 1-noul */
      const edges = mine.filter((h) => typeof h.meta.noul === 'number')
        .map((h) => (sideId === firstId ? h.meta.noul : 1 - h.meta.noul));
      rows[0].textContent = confs.length ? Math.round(sum(confs, (x) => x) / confs.length * 100) + '%' : '–';
      rows[1].textContent = edges.length ? Math.round(sum(edges, (x) => x) / edges.length * 100) + '%' : '–';
      rows[2].textContent = String(mine.length);
      rows[3].textContent = fmtCost(sum(mine, (h) => h.meta.costUsd || 0));
    });
  }

  function renderLatest(h) {
    const box = $('latest');
    const v = BG.latest.boardHTML(h);
    $('latestNote').textContent = v.note;
    $('rankCount').textContent = v.count;
    box.innerHTML = v.html;
  }

  /* ---------- 战绩簿（localStorage 持久化） ---------- */
  function loadRecords() {
    try { return JSON.parse(localStorage.getItem(RECORDS_KEY) || '[]'); }
    catch (_) { return []; }
  }
  function saveGameRecord(g) {
    if (!S.sessionRecorded) S.sessionId = Date.now() + '' + BG.util.rand(1000);
    S.sessionRecorded = true; // 终局后悔棋再终局只保留一条战绩
    const items = aiItems();
    const lats = items.map((h) => h.meta.latencyMs).filter(Boolean);
    /* 校准样本口径与同步 payload 完全一致（calSamples），
     * 这样后端聚合出来的统计和本机战绩簿永远对得上。 */
    const cs = calSamples(g);
    const rec = {
      id: S.sessionId,
      t: Date.now(),
      game: S.engine.name,
      gid: S.gameId,
      mock: cs.mock,
      mode: { 'human-ai': '人机', 'ai-ai': '机机', pvp: '双人' }[S.mode] || S.mode,
      winner: g.winner ? sideName(g.winner) : '和棋',
      firstWin: cs.firstWin,
      reason: g.reason || '',
      notas: S.history.map((h) => h.move.notation), // 棋谱写法：经验注入（开局胜率统计）的数据源
      moves: S.history.length,
      aiMoves: items.length,
      avgLat: lats.length ? Math.round(lats.reduce((s, x) => s + x, 0) / lats.length) : 0,
      cost: items.reduce((s, h) => s + (h.meta.costUsd || 0), 0),
      cal: cs.cal,
    };
    const all = loadRecords();
    const idx = all.findIndex((r) => r.id === rec.id);
    if (idx >= 0) all[idx] = rec; else all.push(rec);
    try { localStorage.setItem(RECORDS_KEY, JSON.stringify(all.slice(-60))); } catch (_) { /* ignore */ }
    renderRecords();
  }
  function renderRecords() {
    const all = loadRecords();
    renderCalibration(); // 与战绩簿同源：校准样本就是这些对局里的预测
    const stats = $('recordStats');
    if (!all.length) {
      stats.innerHTML = '<div class="feed-empty">还没有历史对局，打完一局自动记账。</div>';
      $('records').innerHTML = '';
      $('recordSummary').textContent = '本机历史对局';
      return;
    }
    const totalCost = all.reduce((s, r) => s + (r.cost || 0), 0);
    const decided = all.filter((r) => r.firstWin !== null && r.firstWin !== undefined);
    const firstWins = decided.filter((r) => r.firstWin === true).length;
    const avgLat = all.filter((r) => r.avgLat);
    stats.innerHTML =
      '<div class="rs"><b>' + all.length + '</b><span>总局</span></div>' +
      '<div class="rs"><b>' + decided.length + '</b><span>分胜负</span></div>' +
      '<div class="rs"><b>' + (decided.length ? Math.round(firstWins / decided.length * 100) + '%' : '–') + '</b><span>先手胜率</span></div>' +
      '<div class="rs"><b>$' + totalCost.toFixed(4) + '</b><span>累计花费</span></div>' +
      '<div class="rs"><b>' + (avgLat.length ? Math.round(avgLat.reduce((s, r) => s + r.avgLat, 0) / avgLat.length) + 'ms' : '–') + '</b><span>均延迟</span></div>';
    const rows = all.slice(-12).reverse().map((r) => {
      const d = new Date(r.t);
      const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      return '<div class="rec-row' + (r.winner === '和棋' ? ' draw' : '') + '">' +
        '<span class="rec-time mono">' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + '</span>' +
        '<span class="rec-game">' + r.game.replace(/\s/g, '') + '</span>' +
        '<span class="rec-mode">' + r.mode + '</span>' +
        '<span class="rec-winner">' + r.winner + (r.reason && r.reason !== '认输' ? '<i>' + r.reason.slice(0, 4) + '</i>' : '') + '</span>' +
        '<span class="rec-meta mono">' + r.moves + '手</span>' +
        '<span class="rec-meta mono">' + (r.avgLat ? r.avgLat + 'ms' : '–') + '</span>' +
        '<span class="rec-meta mono">' + (r.cost ? '$' + r.cost.toFixed(5) : '–') + '</span>' +
        '</div>';
    }).join('');
    $('records').innerHTML =
      '<div class="rec-row rec-head"><span>时间</span><span>棋种</span><span>模式</span><span>胜方</span><span>手数</span><span>延迟</span><span>花费</span></div>' + rows;
    $('recordSummary').textContent = '本机最近 ' + all.length + ' 局';
  }

  /* ---------- 校准实验室 ----------
   * 把 Jev 逐手给出的胜率预测，与这些对局的真实胜负放在一起量。
   * 面板刻意同时给「技巧分」与「校准误差」两个数：它们不可互相替代——
   * 恒定猜 0.5 的预测器 ece 也是 0（从不说谎），但技巧分是 0（毫无信息量）。
   * 只看 ece 会得出「这个模型很诚实」的错误结论。两个数的对照见
   * js/calibration.js selfTest 的夹具 A / B。 */
  const PCT = (v, d) => (typeof v === 'number' ? (v * 100).toFixed(d === undefined ? 0 : d) + '%' : '–');
  const SIGNED = (v, d) => (typeof v === 'number' ? (v > 0 ? '+' : '') + (v * 100).toFixed(d === undefined ? 0 : d) : '–');

  /* 校准样本双源合并：本机战绩簿 + 后端 /api/stats 的按局记录。
   * 同一局可能两边都有（本机跑过、终局又同步到了后端），按 gid+着法串去重，
   * 保留本机记录。服务端样本让「换一台机器 / 清一次缓存」不再把校准数据清零——
   * 这是后端化对产品最实质的一处增强。 */
  function mergeCalibration(local, stats) {
    if (!stats || !stats.cal || !Array.isArray(stats.cal.records) || !stats.cal.records.length) return local;
    const seen = new Set();
    loadRecords().forEach((r) => {
      if (r && r.gid && r.notas) seen.add(r.gid + '|' + r.notas.join(','));
    });
    const extra = [];
    let serverGames = 0;
    stats.cal.records.forEach((rec) => {
      if (!rec || seen.has(rec.key)) return;
      seen.add(rec.key);
      if (rec.firstWin !== true && rec.firstWin !== false) return;
      if (!Array.isArray(rec.cal) || !rec.cal.length) return;
      serverGames++;
      const y = rec.firstWin ? 1 : 0;
      rec.cal.forEach((p) => extra.push({ p, y }));
    });
    if (!extra.length) return local;
    const samples = local.samples.concat(extra);
    return {
      samples,
      games: local.games + serverGames,
      draws: local.draws,
      skippedDemo: local.skippedDemo,
      serverGames,
      metrics: BG.calibration.metrics(samples),
    };
  }

  function renderCalibration() {
    const box = $('calBody');
    if (!box) return;
    const agg = mergeCalibration(BG.calibration.fromRecords(loadRecords()), BACKEND.stats);
    const m = agg.metrics;
    $('calCount').textContent = agg.games
      ? agg.games + ' 局 / ' + agg.samples.length + ' 手' + (agg.serverGames ? '（含服务端 ' + agg.serverGames + ' 局）' : '')
      : '';

    if (!m) {
      const why = agg.skippedDemo
        ? '已有 ' + agg.skippedDemo + ' 局离线演示。演示的胜率是本地合成的，拿它量校准没有意义——请接入真实 Jev 渠道后再看。'
        : '还没有真实渠道的对局记录。接入 Jev（官方 / OpenRouter / 同源代理）下几局，这里会把「Jev 说的胜率」和「实际胜负」摆在一起量。';
      /* 自绘 SVG：一条「完美校准」的对角参考线 + 一个偏离它的落点，画的就是「失准」本身 */
      box.innerHTML =
        '<div class="cal-empty">' +
        '<svg class="glyph" width="88" height="52" viewBox="0 0 88 52" aria-hidden="true" fill="none">' +
        '<path class="g-ref" d="M8 44 L80 8" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>' +
        '<circle cx="58" cy="12" r="3.2" fill="currentColor"/>' +
        '<line x1="8" y1="6" x2="8" y2="44" stroke="currentColor" stroke-width="1" opacity=".45"/>' +
        '<line x1="8" y1="44" x2="82" y2="44" stroke="currentColor" stroke-width="1" opacity=".45"/>' +
        '</svg>' + why + '</div>';
      return;
    }

    const skillTxt = m.skill === null ? '–' : (m.skill > 0 ? '+' : '') + (m.skill * 100).toFixed(0);
    const skillNote = m.skill === null ? '基准率退化，无法比较'
      : m.skill > 0.5 ? '明显有信息量'
      : m.skill > 0 ? '略强于「恒猜平均胜率」'
      : m.skill > -0.5 ? '基本没有信息量'
      : '比「恒猜平均胜率」还差';
    const hero =
      '<div class="cal-hero' + (m.skill !== null && m.skill < 0 ? ' bad' : '') + '">' +
      '<div class="cal-hero-v mono">' + skillTxt + '</div>' +
      '<div class="cal-hero-k">技巧分</div>' +
      '<div class="cal-hero-note">' + skillNote + '</div></div>';

    const tiles =
      '<div class="cal-tiles">' +
      '<div class="ct"><b class="mono">' + PCT(m.ece, 1) + '</b><span>校准误差</span></div>' +
      '<div class="ct"><b class="mono">' + m.brier.toFixed(3) + '</b><span>Brier 分</span></div>' +
      '<div class="ct"><b class="mono">' + PCT(m.sharpness) + '</b><span>平均预测</span></div>' +
      '<div class="ct"><b class="mono">' + PCT(m.baseRate) + '</b><span>实际胜率</span></div>' +
      '</div>';

    const over = m.overconfidence;
    const verdict = Math.abs(over) < 0.05
      ? '平均预测与实际胜率基本吻合，Jev 既不狂妄也不怯懦。'
      : over > 0
        ? 'Jev 平均比现实乐观 ' + Math.round(over * 100) + ' 个百分点——说七成的时候常兑现不到七成。'
        : 'Jev 平均比现实保守 ' + Math.round(-over * 100) + ' 个百分点——它比实际更不敢下注。';

    box.innerHTML = hero + tiles +
      '<div id="calChart" class="cal-chart"></div>' +
      '<div class="cal-verdict' + (over > 0.05 ? ' warn' : '') + '">' + verdict + '</div>' +
      '<div class="cal-caveat">样本按「局」强相关：同一局内各手共享同一真实胜负，' +
      '有效样本量更接近 ' + agg.games + ' 局而非 ' + agg.samples.length + ' 手。' +
      (agg.serverGames ? '其中 ' + agg.serverGames + ' 局来自服务端归档，换设备、清缓存都不丢。' : '') +
      (agg.draws ? '另有 ' + agg.draws + ' 局和棋无二元真值，未计入。' : '') + '</div>';

    BG.charts.reliability($('calChart'), BG.calibration.reliability(agg.samples, 10), {});
  }

  function renderFeed() {
    const feed = $('feed');
    const aiMoves = S.history.filter((h) => h.meta && h.meta.byAI);
    if (!aiMoves.length) {
      feed.innerHTML = '<div class="feed-empty">开始对局后，Jev 的每一步判断会流淌在这里。</div>';
      return;
    }
    feed.innerHTML = '';
    const frag = document.createDocumentFragment();
    /* i===0 是最新一张：只有它播入场动画，历史卡片直接呈现终值 */
    aiMoves.slice(-FEED_MAX).reverse().forEach((h, i) => frag.appendChild(feedCard(h, i === 0)));
    feed.appendChild(frag);
  }

  /* 决策流单卡。animate=false 时概率条/仪表直接呈现终值，不重播动画。 */
  function feedCard(h, animate) {
    const m = h.meta;
    const card = document.createElement('div');
    card.className = 'decision';
    card.innerHTML =
      '<span class="who">第' + h.ply + '手 · <b>' + (m.sideName || '') + '</b>' +
      (m.mock ? ' · 演示' : ' · Jev') +
      (m.tactics === 'win' ? ' · 保险·致胜' : m.tactics === 'block' ? ' · 保险·拦截' : m.tactics === 'open4' ? ' · 保险·活四' : m.tactics === 'threat' ? ' · 保险·造杀' : m.tactics === 'parry' ? ' · 保险·拆杀' : m.tactics === 'parry3' ? ' · 保险·预挡' : '') + '</span>' +
      '<span class="mv">' + h.move.notation + '</span>';
    const barsWrap = document.createElement('div');
    barsWrap.style.gridColumn = '1 / 3';
    barsWrap.appendChild(BG.charts.bars(m.top, h.move.notation, animate));
    card.appendChild(barsWrap);
    if (typeof m.confidence === 'number') card.appendChild(BG.charts.gauge(m.confidence, 46, animate));
    const extra = [];
    if (typeof m.noul === 'number') extra.push('优势 ' + (m.noul * 100).toFixed(0) + '%');
    if (typeof m.score === 'number') extra.push('局势 ' + m.score.toFixed(1));
    if (m.latencyMs) extra.push(m.latencyMs + 'ms');
    if (m.usage && m.usage.input_tokens) extra.push(m.usage.input_tokens + ' tok');
    if (m.costUsd) extra.push('$' + m.costUsd.toFixed(5));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = extra.map((x) => '<b>' + x + '</b>').join(' · ') +
      (m.warning ? ' <span class="warn">⚠ ' + m.warning + '</span>' : '');
    card.appendChild(meta);
    return card;
  }

  /* 增量：只把最新一手的卡片插到最前面。
   * 此前每手都 innerHTML='' 后重建最多 40 张卡（每张含概率条 + SVG 仪表），
   * 是 O(n²) 的纯重复劳动：cc 一局 138 手 ≈ 5.5k 张卡 / 5 万+ DOM 节点。
   * 只在历史被回退（resetSession / undo）时才需要整块重画，走 renderFeed。 */
  function prependFeed(h) {
    const feed = $('feed');
    if (feed.querySelector('.feed-empty')) feed.innerHTML = '';
    feed.insertBefore(feedCard(h, true), feed.firstChild);
    while (feed.childElementCount > FEED_MAX) feed.removeChild(feed.lastElementChild);
  }

  function appendLedgerLine(h) {
    const el = $('ledger');
    if (el.querySelector('.feed-empty')) el.innerHTML = '';
    const label = h.meta && h.meta.byAI ? (h.meta.mock ? '演示' : 'Jev') : '玩家';
    const tag = label === '玩家' ? '' : '<span class="tag' + (label === 'Jev' ? ' jev' : '') + '">' + label + '</span>';
    el.insertAdjacentHTML('beforeend',
      '<div><span class="no">' + h.ply + '.</span>' + h.move.notation + tag + '</div>');
    el.scrollTop = el.scrollHeight;
  }

  function rebuildLedger() {
    const el = $('ledger');
    if (!S.history.length) {
      /* 空局也要有话说：空白面板读起来像「坏了」，不像「还没开始」 */
      el.innerHTML = '<div class="ledger-empty">对局开始后，每一手的记法会记在这里。</div>';
      return;
    }
    el.innerHTML = '';
    S.history.forEach(appendLedgerLine);
  }

  /* ---------- 悔棋 ---------- */

  /* 从 newGame() 重放前 n 手记法还原局面。
   * 为什么不用 prev 全量快照（见 docs/plans/2026-09-29-iteration-02-play-loop.md）：
   * applyMove 是纯函数（architecture.md §3 不变量），快照从不被修改，而 prev 字段
   * 全仓库只有悔棋一处读它——留着它等于为 O(n·|state|) 的常驻内存付租金。
   * 还原路径的合法性由「记法往返」保证（engine-interface.md §2 硬契约），
   * test/run-tests.js 的 playOut 会对整盘对局做重放等价断言作为护栏。 */
  function rebuildState(n) {
    let st = S.engine.newGame();
    for (let i = 0; i < n; i++) {
      const m = S.engine.moveFromNotation(st, S.history[i].move.notation);
      if (!m) {
        /* 记法失效＝引擎违反契约：兜底回空盘，绝不把半截局面渲染出去 */
        console.warn('悔棋重放失败于第 ' + (i + 1) + ' 手：' + S.history[i].move.notation);
        return S.engine.newGame();
      }
      st = S.engine.applyMove(st, m);
    }
    return st;
  }

  /* 对局进行中的状态条文案：开始对局、悔棋复位、重试三处共用一份，避免文案漂移 */
  function inGameStatus() {
    if (S.mode === 'ai-ai') return '对局进行中 · Jev vs Jev';
    if (S.mode === 'human-ai') return '对局进行中 · 你执' + sideName(S.humanSide);
    return '对局进行中 · 双人对弈';
  }

  function undo() {
    if (!S.history.length) return;
    S.epoch++;
    if (S.aborter) { S.aborter.abort(); S.aborter = null; }
    S.inflight = null;
    let steps = 1;
    if (S.mode === 'human-ai') {
      const last = S.history[S.history.length - 1];
      if (last.meta && last.meta.byAI) steps = Math.min(2, S.history.length);
    }
    for (let i = 0; i < steps; i++) S.history.pop();
    S.st = rebuildState(S.history.length);
    S.paused = false;
    /* 悔棋会把终局态打破：finishGame 改过状态条、隐藏过暂停/单步/重试，
     * 这里逐项复位——否则棋盘回到残局而状态条仍写着「终局 · … 获胜」。 */
    const aiAi = S.mode === 'ai-ai';
    $('pauseBtn').textContent = '暂停';
    $('pauseBtn').classList.toggle('hidden', !aiAi);
    $('stepBtn').classList.toggle('hidden', !aiAi);
    $('retryBtn')?.classList.add('hidden');
    setStatus(S.history.length ? inGameStatus() : '已就绪：选择模式后点「开始对局」。', false);
    rebuildLedger();
    renderAnalytics();
    renderCockpit();
    renderFeed();
    redraw();
    /* 悔棋常把控制权交回 Jev（机机模式恒定如此）。此前这里不调度，AI 回合永不到来，
     * 界面却显示「等待 Jev」——对局就此卡死。 */
    if (S.history.length && isAISide(S.st.turn)) setTimeout(aiStep, aiDelayMs());
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('startBtn').onclick = startGame;
    $('undoBtn').onclick = undo;
    $('mode').onchange = () => {
      saveSettings();
      const aiAi = $('mode').value === 'ai-ai';
      $('pauseBtn').classList.toggle('hidden', !aiAi);
      $('stepBtn').classList.toggle('hidden', !aiAi);
      $('speedRow').classList.toggle('hidden', !aiAi);
    };
    $('speed').oninput = () => {
      $('speedVal').textContent = (150 + parseInt($('speed').value, 10) * 150) / 1000 + 's';
      saveSettings();
    };
    $('pauseBtn').onclick = () => setPaused(!S.paused);
    const retryBtn = $('retryBtn');
    if (retryBtn) {
      retryBtn.onclick = () => {
        retryBtn.classList.add('hidden');
        S.paused = false; // 出错路径会置暂停，重试前先解除
        $('pauseBtn').textContent = '暂停';
        setStatus(inGameStatus(), false);
        aiStep();
      };
    }
    $('stepBtn').onclick = () => { if (S.paused && isAISide(S.st.turn) && S.inflight == null) scheduleAI(); };
    $('passBtn').onclick = () => {
      if (S.inflight != null || isAISide(S.st.turn)) return;
      const pm = S.engine.passMove && S.engine.passMove(S.st);
      if (pm) playMove(pm, { human: true });
    };
    $('resignBtn').onclick = () => {
      if (!S.st || S.inflight != null || S.engine.getStatus(S.st).over) return;
      const loser = S.st.turn;
      const opp = S.engine.sides.find((s) => s.id !== loser);
      S.st = BG.util.clone(S.st);
      S.st.result = { over: true, winner: opp ? opp.id : null, reason: '认输' };
      finishGame(S.engine.getStatus(S.st));
    };
    $('channel').onchange = saveSettings;
    $('endpoint').onchange = saveSettings;
    $('probeBtn').onclick = runProbe;
    $('exportGame').onclick = exportGame;
    $('expStartBtn').onclick = startExperiment;
    $('expStopBtn').onclick = stopExperiment;
    renderExpStatus(); renderExpHistory();
    $('apiKey').onchange = saveSettings;
    $('orKey').onchange = saveSettings;
    $('topK').onchange = saveSettings;

    const setTrendMode = (mode) => {
      S.trendMode = mode;
      ['chipWin', 'chipScore', 'chipConf'].forEach((id) => id.classList.remove('active'));
      $({ win: 'chipWin', score: 'chipScore', conf: 'chipConf' }[mode]).classList.add('active');
      renderAnalytics();
    };
    $('chipWin').onclick = () => setTrendMode('win');
    $('chipScore').onclick = () => setTrendMode('score');
    $('chipConf').onclick = () => setTrendMode('conf');
    $('clearRecords').onclick = () => {
      try { localStorage.removeItem(RECORDS_KEY); } catch (_) { /* ignore */ }
      renderRecords();
      toast('战绩簿已清空');
    };
    $('duelFirstName').textContent = S.engine ? S.engine.sides[0].name + ' Jev' : '先手 Jev';
    $('duelSecondName').textContent = S.engine ? S.engine.sides[1].name + ' Jev' : '后手 Jev';

    $('board').addEventListener('click', (e) => {
      if (!S.engine || S.inflight != null) return;
      const g = S.engine.getStatus(S.st);
      if (g.over) return;
      if (isAISide(S.st.turn)) return;
      const { x, y } = BG.eventXY($('board'), e);
      const r = S.engine.humanClick(S.st, S.ui, x, y);
      if (!r) return;
      if (r.promoChoice) { showPromo(r.promoChoice); return; }
      playMove(r, { human: true });
    });

    /* 内嵌浏览器/webview 可能在页签隐藏期间丢弃 canvas 表面，
     * 回到可见或窗口尺寸变化时强制重绘，避免棋盘"消失"。 */
    document.addEventListener('visibilitychange', () => { if (!document.hidden) redraw(); });
    window.addEventListener('focus', () => redraw());
    window.addEventListener('resize', () => redraw());
  }

  function showPromo(pc) {
    const box = $('promoBox');
    box.innerHTML = '<div class="t">选择升变的棋子</div>';
    const names = { Q: '后', R: '车', B: '象', N: '马' };
    ['Q', 'R', 'B', 'N'].forEach((p) => {
      const b = document.createElement('button');
      b.textContent = names[p];
      b.onclick = () => {
        box.classList.add('hidden');
        const mv = S.engine.moveFromNotation(S.st, pc.from + pc.to + '=' + p);
        if (mv) playMove(mv, { human: true });
      };
      box.appendChild(b);
    });
    box.classList.remove('hidden');
  }

  /* ---------- 自检 ---------- */
  function runTests() {
    const panel = $('testPanel');
    panel.classList.remove('hidden');
    let html = '<b>引擎自检</b><br>';
    GAME_ORDER.forEach((gid) => {
      const e = BG.games[gid];
      if (!e) { html += '<span class="fail">' + gid + ' 缺失</span><br>'; return; }
      try {
        e.selfTest();
        html += '<span class="ok">✓ ' + e.name + '</span><br>';
      } catch (err) {
        html += '<span class="fail">✗ ' + e.name + '：' + err.message + '</span><br>';
      }
    });
    panel.innerHTML = html;
    /* 校准实验室的数学也进浏览器自检：纯函数，Node 与浏览器两端都能跑 */
    try {
      if (BG.calibration) { BG.calibration.selfTest(); panel.innerHTML += '<span class="ok">✓ 校准实验室</span><br>'; }
    } catch (err) {
      panel.innerHTML += '<span class="fail">✗ 校准实验室：' + err.message + '</span><br>';
    }
  }

  /* ---------- 启动 ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    buildTabs();
    loadSettings();
    initFolds();
    initSideTabs();
    bind();
    switchGame('gomoku');
    renderRecords();
    $('speedVal').textContent = (150 + S.settings.speed * 150) / 1000 + 's';
    initBackend(); // 异步探活：不阻塞首屏，结果写进头部 chip 与设置面板
    if (location.search.indexOf('test=1') >= 0) runTests();
  });
})();
