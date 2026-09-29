'use strict';
/* jev-client.js — TypeSafe Jev（系统一模型）调用封装
 *
 * 契约（docs.typesafe.ai/api.md）：
 *   POST {endpoint}   Authorization: Bearer <key>
 *   body: { state, model, questions }   questions: { key: {type, instructions, criteria} }
 *   resp: { model, answers: { key: {...} }, usage: { input_tokens, output_tokens } }
 *   429/529 → 指数退避重试；401 → key 无效
 *
 * 渠道：
 *   official   → https://api.typesafe.ai/v1/systemone     model: jev-latest
 *   openrouter → https://openrouter.ai/api/v1/systemone   model: typesafe/jev-1.13（体格式与官方一致）
 *   proxy      → 同源 api/jev（CF Pages Function / dev-proxy.py），体格式同官方，key 在服务端
 *   mock       → 离线演示（见 mock-ai.js）
 *
 * 自定义 Base URL：decide 的 opts.endpoint 非空时覆盖该渠道预设端点（设置面板可改，
 * 留空 = 预设）。自定义端点不强制 key（自建网关可匿名），有 key 照发鉴权头；
 * 预设端点保持原有 key 校验。BG.jev.presetEndpoint(ch) 供 UI 取预设值。
 *
 * probe(opts)：开局前连通性探测，两段式定位故障——A 段 no-cors GET 只验证「网络可达」；
 * B 段按真实契约发最小 noul 请求。返回 { ok, kind, message, latencyMs, model?, status? }，
 * kind ∈ ok | auth | cors | network | http | shape | config | mock。
 */
(function () {
  const CHANNELS = {
    official:   { endpoint: 'https://api.typesafe.ai/v1/systemone',    model: 'jev-latest',        keyName: 'official' },
    openrouter: { endpoint: 'https://openrouter.ai/api/v1/systemone',  model: 'typesafe/jev-1.13', keyName: 'openrouter' },
    proxy:      { endpoint: 'api/jev',                                 model: 'jev-latest',        keyName: null },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const REQUEST_TIMEOUT_MS = 30000;

  /* 渠道预设端点：UI 占位符与「留空 = 预设」语义的数据源 */
  function presetEndpoint(channel) {
    const cfg = CHANNELS[channel];
    return cfg ? cfg.endpoint : '';
  }

  async function callRaw(channel, body, opts) {
    const cfg = CHANNELS[channel];
    if (!cfg) throw new Error('未知渠道: ' + channel);
    const endpoint = opts.endpoint || cfg.endpoint;
    const custom = !!opts.endpoint; /* 自定义端点：兼容自建网关，不强制 key */
    const headers = { 'Content-Type': 'application/json' };
    if (channel === 'proxy') {
      /* BYOK：代理只做 CORS 转发，key 由用户自己的 localStorage 随头透传 */
      if (opts.apiKey) headers['X-Api-Key'] = opts.apiKey;
    } else if (cfg.keyName) {
      if (!opts.apiKey && !custom) throw new Error('尚未填写该渠道的 API Key（右上「Jev 设置」）');
      if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
      if (channel === 'openrouter') headers['HTTP-Referer'] = location.origin || 'http://localhost';
    }
    const payload = { state: body.state, model: cfg.model, questions: body.questions };
    /* 超时 + 外部中止合并：30s 无响应视为超时（可重试） */
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS);
    const onOuterAbort = () => timeoutCtrl.abort();
    if (opts.signal) {
      if (opts.signal.aborted) timeoutCtrl.abort();
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      return await fetch(endpoint, {
        method: 'POST', headers, signal: timeoutCtrl.signal,
        body: JSON.stringify(payload),
      });
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
    }
  }

  /* 带重试的请求：429/529 与网络/超时错误退避重试；外部中止立即终止 */
  async function callWithRetry(channel, body, opts) {
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (opts.signal && opts.signal.aborted) throw new Error('aborted');
      let resp;
      try {
        resp = await callRaw(channel, body, opts);
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw new Error('aborted');
        lastErr = new Error('网络错误：' + e.message +
          (channel === 'proxy'
            ? '（同源 /api/jev 不可达：本地需运行 python dev-proxy.py，线上需部署到 Cloudflare Pages；双击 file:// 打开时自动走离线演示）'
            : '（浏览器直连受 CORS 限制：官方 API 有来源白名单，仅 typesafe.ai 自有域可用；请改用「同源代理」渠道）'));
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (resp.ok) return resp.json();
      if (resp.status === 429 || resp.status === 529) {
        if (opts.onRetry) opts.onRetry(resp.status, attempt);
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      let detail = '';
      try { detail = (await resp.text()).slice(0, 300); } catch (_) { /* ignore */ }
      if (resp.status === 401) throw new Error('API Key 无效或缺失（401）——若 key 确认无误（「测试连接」通过），可能是服务端瞬时故障，稍后点「重试」即可');
      throw new Error('API 错误 ' + resp.status + '：' + detail);
    }
    throw lastErr || new Error('重试次数用尽');
  }

  const PROBE_TIMEOUT_MS = 10000;

  /* ---------- 战术事实与经验注入（Jev 强度杠杆） ----------
   * Jev 是无状态概率模型，不会学习；把客户端算得清的事实写进 state，
   * 指令同步声明语义（一次并行多问结构不变）。
   * tactics：模拟推算双方「一步致胜点」——走子即胜的点，己方 = 必走，对方 = 必挡。
   * 用引擎自己的 applyMove/getStatus 推演，六棋种通用；go 等无中途终局的棋种自然为空。
   * 2-ply（deepTactics 引擎，如 gomoku）：「造杀点」——走出后己方有 ≥2 个一步致胜点
   * （对方至多堵其一）的着法。己方造杀 = 两步内必胜；对方造杀 = 必须现在就拆，
   * 否则对方下回合双杀无解。只在 1-ply 无战术时跑（一步杀/堵严格更优先），
   * 外层只扫候选点，内层数到 2 即停。
   * 结果按 state 身份缓存（WeakMap），同一局面重复决策不重算。 */

  const tacCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  const emptyTactics = () => ({
    winning_points_you: [], winning_points_opponent: [],
    chance_points_you: [], danger_points_opponent: [],
  });

  const flipTurn = (st, sideId) => Object.assign({}, st, { turn: sideId });

  /* 数 st2 中 sideId 的一步致胜点，到 limit 即停（2-ply 内层省时间用） */
  function countWinningPoints(engine, st2, sideId, limit) {
    const s = flipTurn(st2, sideId);
    let ms;
    try { ms = engine.getLegalMoves(s); } catch (_) { return 0; }
    let cnt = 0;
    for (const m of ms) {
      let g;
      try { g = engine.getStatus(engine.applyMove(s, m)); } catch (_) { continue; }
      if (g.over && g.winner === sideId) {
        cnt++;
        if (cnt >= limit) break;
      }
    }
    return cnt;
  }

  /* 2-ply 造杀点：sideId 的候选着法 p，走出后 sideId 有 ≥2 个致胜点即入选。
   * forSelf 时加护栏：走出后对方不能反手有致胜点（防自杀式造杀）。 */
  function threatMakers(engine, st, sideId, oppId, candNotations, forSelf) {
    const out = [];
    for (const n of candNotations) {
      let mv;
      try { mv = engine.moveFromNotation(st, n); } catch (_) { continue; }
      if (!mv) continue;
      let s2;
      try { s2 = engine.applyMove(flipTurn(st, sideId), mv); } catch (_) { continue; }
      if (countWinningPoints(engine, s2, sideId, 2) < 2) continue;
      if (forSelf && oppId && countWinningPoints(engine, s2, oppId, 1) > 0) continue;
      out.push(n);
    }
    return out;
  }

  function computeTactics(engine, st, legal, cands) {
    if (tacCache) {
      const hit = tacCache.get(st);
      if (hit) return hit;
    }
    /* 开局无战术：moveNum 可用时跳过早期局面，省去无谓模拟 */
    if (typeof st.moveNum === 'number' && st.moveNum < 4) {
      return emptyTactics();
    }
    const side = st.turn;
    const win = [];
    for (const m of legal) {
      try {
        const g = engine.getStatus(engine.applyMove(st, m));
        if (g.over && g.winner === side) win.push(m.notation);
      } catch (_) { /* 模拟着法被引擎拒绝：跳过 */ }
    }
    const block = [];
    const oppSide = engine.sides && engine.sides.find((s) => s.id !== side);
    if (oppSide) {
      const stOpp = flipTurn(st, oppSide.id);
      let oppMoves = [];
      try { oppMoves = engine.getLegalMoves(stOpp); } catch (_) { oppMoves = []; }
      for (const m of oppMoves) {
        try {
          const g = engine.getStatus(engine.applyMove(stOpp, m));
          if (g.over && g.winner === oppSide.id) block.push(m.notation);
        } catch (_) { /* 跳过 */ }
      }
    }
    const res = {
      winning_points_you: win, winning_points_opponent: block,
      chance_points_you: [], danger_points_opponent: [],
    };
    /* 2-ply 造杀：仅 1-ply 无战术时跑；引擎需声明 deepTactics（候选点须是无色差的空点集，如 gomoku） */
    if (engine.deepTactics && win.length === 0 && block.length === 0 && oppSide) {
      const candNotations = (cands && cands.length) ? cands : legal.map((m) => m.notation);
      res.chance_points_you = threatMakers(engine, st, side, oppSide.id, candNotations, true);
      res.danger_points_opponent = threatMakers(engine, st, oppSide.id, side, candNotations, false);
    }
    if (tacCache && st && typeof st === 'object') tacCache.set(st, res);
    return res;
  }

  function attachFacts(ser, tactics, experience) {
    const facts = { tactics };
    if (experience) facts.experience = experience;
    if (ser.state && typeof ser.state === 'object' && !Array.isArray(ser.state)) {
      Object.assign(ser.state, facts);
    } else if (typeof ser.state === 'string') {
      try { ser.state = JSON.stringify(Object.assign(JSON.parse(ser.state), facts)); }
      catch (_) { ser.state += '\n' + JSON.stringify(facts); }
    } else if (Array.isArray(ser.state)) {
      ser.state.push(JSON.stringify(facts));
    }
    if (ser.questions && ser.questions.move && typeof ser.questions.move.instructions === 'string') {
      ser.questions.move.instructions +=
        ' The state includes a `tactics` object: if `winning_points_you` is non-empty, playing one of those points wins immediately this turn. ' +
        'If `winning_points_opponent` is non-empty, the opponent would win there next turn unless stopped, so play one of those points unless you can win immediately. ' +
        'If `chance_points_you` is non-empty, playing one creates two winning threats at once (the opponent can block at most one of them), winning within two moves — take it when there is no immediate win or block. ' +
        'If `danger_points_opponent` is non-empty, the opponent would create such a double threat next turn unless stopped, so block one of those points now (after handling any immediate win or block above). ' +
        (experience ? 'The state also includes `experience`: first_player_win_rate over past games reaching this same opening; weigh it when judging quiet moves. ' : '');
    }
  }

  /* 连通性探测：诊断「要不要开局」之前的事。
   * A 段 no-cors GET：响应不可读但能区分「网络/DNS 不通」（reject）与「服务器可达」（resolve）。
   * B 段最小 noul 请求：CORS 拦截与网络错误在 fetch 层同为 TypeError，用 A 段结果区分两者。
   * 只读诊断，不发走子请求；渠道头逻辑与 callRaw 保持一致。 */
  async function probe(opts) {
    const channel = opts.channel || 'official';
    if (channel === 'mock') return { ok: true, kind: 'mock', message: '离线演示：无需连接。' };
    const cfg = CHANNELS[channel];
    if (!cfg) return { ok: false, kind: 'config', message: '未知渠道：' + channel };
    const endpoint = opts.endpoint || cfg.endpoint;
    const t0 = Date.now();
    let reachable = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try { await fetch(endpoint, { mode: 'no-cors', signal: ctrl.signal }); }
      finally { clearTimeout(timer); }
      reachable = true;
    } catch (_) { /* 网络层就不通 */ }

    const headers = { 'Content-Type': 'application/json' };
    if (channel === 'proxy') {
      if (opts.apiKey) headers['X-Api-Key'] = opts.apiKey;
    } else if (cfg.keyName) {
      if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
      if (channel === 'openrouter') headers['HTTP-Referer'] = location.origin || 'http://localhost';
    }
    const body = JSON.stringify({
      state: { probe: true },
      model: cfg.model,
      questions: { probe: { type: 'noul', instructions: 'Connectivity probe. Answer immediately.' } },
    });
    let resp;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      resp = await fetch(endpoint, { method: 'POST', headers, body, signal: ctrl.signal });
    } catch (e) {
      const latencyMs = Date.now() - t0;
      if (!reachable) {
        return { ok: false, kind: 'network', latencyMs,
          message: '网络不可达：' + e.message + '。检查地址拼写与本机网络（代理渠道需先启动 dev-proxy.py）。' };
      }
      return { ok: false, kind: 'cors', latencyMs,
        message: '服务器可达，但浏览器跨域(CORS)被拦截：端点未返回 CORS 头。改用「同源代理」渠道，或让服务端加 Access-Control-Allow-Origin。' };
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - t0;
    if (resp.ok) {
      let data = null;
      try { data = await resp.json(); } catch (_) { /* 响应不是 JSON，按形状不符处理 */ }
      if (data && data.answers) {
        return { ok: true, kind: 'ok', latencyMs, model: data.model,
          message: '联通正常' + (data.model ? ' · ' + data.model : '') + ' · ' + latencyMs + 'ms，key 有效。' };
      }
      return { ok: false, kind: 'shape', latencyMs,
        message: '端点可达且鉴权通过，但响应不是 System One 结构（缺 answers）。确认地址是 /v1/systemone 同构端点。' };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, kind: 'auth', latencyMs,
        message: '服务器联通，但鉴权失败（' + resp.status + '）：key 无效或未授权，请核对后重填。' };
    }
    let detail = '';
    try { detail = (await resp.text()).slice(0, 200); } catch (_) { /* ignore */ }
    return { ok: false, kind: 'http', status: resp.status, latencyMs,
      message: '服务器联通，但返回 HTTP ' + resp.status + (detail ? '：' + detail : '') + '。确认端点路径是否正确（通常到 /v1/systemone 为止）。' };
  }

  const JevClient = {
    /* 渠道预设端点（设置面板占位符用） */
    presetEndpoint,
    /* 开局前连通性探测（设置面板「测试连接」） */
    probe,
    /* 战术事实推算（导出供测试；decide 内部已自动调用） */
    computeTactics,
    /* 走一步棋：engine.serializeForJev 的产出交给 Jev，返回决策对象
     * opts: { channel, apiKey, endpoint?, topK, signal, onRetry }
     * 返回 { notation, move, meta }
     */
    async decide(engine, st, side, opts) {
      const channel = opts.channel || 'official';
      const ser = engine.serializeForJev(st, side);
      const legal = engine.getLegalMoves(st);
      const byNotation = new Map(legal.map((m) => [m.notation, m]));
      const t0 = Date.now();

      if (channel === 'mock') {
        return BG.mock.decide(engine, st, side, legal, ser);
      }

      /* 战术事实 + 对局经验注入 state，并同步指令语义 */
      let tactics = emptyTactics();
      /* 候选点记法：2-ply 外层只扫候选（省时间），取自序列化 questions.move.criteria 的键 */
      let cands = null;
      try {
        const crit = ser.questions && ser.questions.move && ser.questions.move.criteria;
        if (crit && typeof crit === 'object') cands = Object.keys(crit);
      } catch (_) { /* 降级为全量 */ }
      try { tactics = computeTactics(engine, st, legal, cands); } catch (_) { /* 任何引擎差异都降级为空战术 */ }
      attachFacts(ser, tactics, opts.experience);

      const data = await callWithRetry(channel, ser, opts);
      const latencyMs = Date.now() - t0;
      const answers = data.answers || {};
      const usage = data.usage || {};
      const costUsd = (usage.input_tokens || 0) * 42 / 1e9; // 输入 $42/十亿token ≈ $42/百万，输出免费

      const ans = answers.move || {};
      let probs = ans.probabilities || {};
      let conf = typeof ans.confidence === 'number' ? ans.confidence : null;

      /* 只保留合法着法的概率（响应理论上是选项子集） */
      const pairs = Object.entries(probs).filter(([k]) => byNotation.has(k));
      if (pairs.length === 0) {
        const fallback = legal[0];
        return {
          notation: fallback.notation, move: fallback,
          meta: { channel, model: data.model, latencyMs, usage, costUsd, confidence: 0, top: [],
                  candidates: 0, warning: '响应中无合法选项，已回退到首个合法着法', noul: answers.edge, score: answers.position,
                  tactics: null },
        };
      }
      pairs.sort((a, b) => b[1] - a[1]);

      /* 战术保险：三级接管——致胜点必走、对方致胜必挡、己方活四点必走（活四+对方无先手五
       * = 理论必胜：两处成五点防不胜防）。概率只是偏好，事实优先。
       * 活四点由引擎以 criteria 保留标签 "you:open4" 声明（engine-interface 契约）。 */
      let notation = null;
      let tacticUsed = null;
      let tacticBypassed = false;
      /* 战术点中文名（接管提示用） */
      const tacticName = () => ({ win: '致胜点', block: '必挡点', open4: '活四点', threat: '造杀点', parry: '拆杀点', parry3: '活三/活四预挡点' }[tacticUsed] || '战术点');
      const pickAmong = (list) => {
        const inPairs = pairs.filter(([n]) => list.indexOf(n) >= 0);
        const k2 = Math.max(1, opts.topK | 0 || 1);
        if (inPairs.length) {
          if (k2 > 1 && inPairs.length > 1) {
            return BG.util.weightedPick(inPairs.map((p) => p[0]), inPairs.map((p) => p[1]));
          }
          return inPairs[0][0];
        }
        tacticBypassed = true;
        const mv = engine.moveFromNotation(st, list[0]);
        return mv ? mv.notation : null;
      };
      const open4Points = Object.entries(ser.questions.move.criteria || {})
        .filter(([n, v]) => typeof v === 'string' && /(^|\+)you:open4(\+|$)/.test(v) && byNotation.has(n))
        .map(([n]) => n);
      /* 第四级（3-ply 预挡）：对手的 deny:open4/deny:live3 标签点 = 对方下回合可造活四/活三的
       * 制造点。放任不管会被迫逐手拆杀（实战败局：p20 白走闲着 E6，黑 E7 活三点 → 强制拆 →
       * J8 双杀 → 输）。win/block/open4/threat/parry 都无时抢先占掉，让对手造不成活三。 */
      const parry3Points = Object.entries(ser.questions.move.criteria || {})
        .filter(([n, v]) => typeof v === 'string' && /(^|\+)deny:(open4|live3)(\+|$)/.test(v) && byNotation.has(n))
        .map(([n]) => n);
      if (tactics.winning_points_you.length) {
        notation = pickAmong(tactics.winning_points_you);
        if (notation) tacticUsed = 'win';
      } else if (tactics.winning_points_opponent.length) {
        notation = pickAmong(tactics.winning_points_opponent);
        if (notation) tacticUsed = 'block';
      } else if (open4Points.length) {
        notation = pickAmong(open4Points);
        if (notation) tacticUsed = 'open4';
      } else if (tactics.chance_points_you.length) {
        notation = pickAmong(tactics.chance_points_you);
        if (notation) tacticUsed = 'threat';
      } else if (tactics.danger_points_opponent.length) {
        notation = pickAmong(tactics.danger_points_opponent);
        if (notation) tacticUsed = 'parry';
      } else if (parry3Points.length) {
        notation = pickAmong(parry3Points);
        if (notation) tacticUsed = 'parry3';
      }

      /* top-k 概率加权随机（随机度） */
      if (!notation) {
        const k = Math.max(1, opts.topK | 0 || 1);
        if (k === 1) {
          notation = pairs[0][0];
        } else {
          const top = pairs.slice(0, k);
          notation = BG.util.weightedPick(top.map((p) => p[0]), top.map((p) => p[1]));
        }
      }

      return {
        notation,
        move: byNotation.get(notation) || engine.moveFromNotation(st, notation),
        meta: {
          channel, model: data.model, latencyMs, usage, costUsd, confidence: conf,
          top: pairs.slice(0, 8).map(([n, p]) => ({ notation: n, p })),
          candidates: pairs.length, // 合法候选总数
          restProb: pairs.slice(8).reduce((s, x) => s + x[1], 0), // 第 9 名以后的概率合计
          noul: answers.edge ? answers.edge.noul : undefined,
          score: answers.position ? answers.position.score : undefined,
          tactics: tacticUsed,
          warning: tacticBypassed
            ? '战术保险接管：Jev 概率未覆盖' + tacticName() + '，已直接执行'
            : undefined,
        },
      };
    },
  };

  BG.jev = JevClient;
})();
