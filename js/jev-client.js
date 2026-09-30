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
    vcf_win_you: [], vcf_win_opponent: [],
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

  /* 3-ply 安全性：sideId 走 p 后，oppId 的逼杀着法数（oppId 走出 q 后有 ≥1 致胜点，
   * 即造四类 forcing move）。多个 danger 点并存时用它选最安全的一个
   * （实战败局：p18 danger=[I9,E9] 走 I9，I9 只是 E9 的其中一个致胜点，走完黑
   * 仍有 E9 单杀逼杀 → 白被迫 D9 → 黑 H12 对角成四 → 输）。数到 10 即停。 */
  function countForcingReplies(engine, st, p, oppId, candNotations) {
    let mv;
    try { mv = engine.moveFromNotation(st, p); } catch (_) { return 999; }
    if (!mv) return 999;
    let s2;
    try { s2 = engine.applyMove(st, mv); } catch (_) { return 999; }
    let cnt = 0;
    for (const n of candNotations) {
      if (n === p) continue;
      let q;
      try { q = engine.moveFromNotation(s2, n); } catch (_) { continue; }
      if (!q) continue;
      let s3;
      try { s3 = engine.applyMove(flipTurn(s2, oppId), q); } catch (_) { continue; }
      if (countWinningPoints(engine, s3, oppId, 1) >= 1) {
        cnt++;
        if (cnt >= 10) break;
      }
    }
    return cnt;
  }

  /* 3-ply 持续攻击检查：白走 p 后，黑若有逼杀 q（走出后恰 1 个致胜点），白被迫堵 w，
   * 再看黑是否还有 danger 点（双杀制造点）。若有，说明 p 给了黑持续攻击的节奏，
   * 返回 true（p 为坏点）。用于多个 danger 点并存时的安全性排序。
   * 限制：只查前 8 个逼杀 q，每个只看白堵后黑的 danger（2-ply），超时风险可控。 */
  function allowsSustainedAttack(engine, st, p, oppId, myId, candNotations) {
    let s2;
    try {
      const mv = engine.moveFromNotation(st, p);
      if (!mv) return false;
      s2 = engine.applyMove(st, mv);
    } catch (_) { return false; }
    let checked = 0;
    for (const q of candNotations) {
      if (q === p || checked >= 8) continue;
      let mq;
      try { mq = engine.moveFromNotation(s2, q); } catch (_) { continue; }
      if (!mq) continue;
      let s3;
      try { s3 = engine.applyMove(flipTurn(s2, oppId), mq); } catch (_) { continue; }
      // 黑走 q 后的致胜点（只关心恰 1 个的情况；≥2 则白已死，p 必坏）
      const wins = [];
      const s3o = flipTurn(s3, oppId);
      let ms;
      try { ms = engine.getLegalMoves(s3o); } catch (_) { continue; }
      for (const m of ms) {
        try {
          const g = engine.getStatus(engine.applyMove(s3o, m));
          if (g.over && g.winner === oppId) {
            wins.push(m.notation);
            if (wins.length >= 2) break;
          }
        } catch (_) {}
      }
      if (wins.length === 0) continue;
      if (wins.length >= 2) return true; // 黑 q 后双杀，白堵不住
      checked++;
      // 白被迫堵唯一的致胜点 w
      let s4;
      try {
        const mw = engine.moveFromNotation(s3, wins[0]);
        if (!mw) continue;
        s4 = engine.applyMove(s3, mw);
      } catch (_) { continue; }
      // 此时黑是否还有 danger 点（双杀制造点）
      const danger = threatMakers(engine, s4, oppId, myId, candNotations, false);
      if (danger.length > 0) return true; // 持续攻击：堵完还有杀
    }
    return false;
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
      vcf_win_you: [], vcf_win_opponent: [],
    };
    /* 2-ply 造杀：仅 1-ply 无战术时跑；引擎需声明 deepTactics（候选点须是无色差的空点集，如 gomoku） */
    if (engine.deepTactics && win.length === 0 && block.length === 0 && oppSide) {
      const candNotations = (cands && cands.length) ? cands : legal.map((m) => m.notation);
      res.chance_points_you = threatMakers(engine, st, side, oppSide.id, candNotations, true);
      res.danger_points_opponent = threatMakers(engine, st, oppSide.id, side, candNotations, false);
    }
    /* VCF 威胁空间搜索：连续冲四将死链。只在 1-ply 无战术时跑；引擎需提供
     * vcfWin（棋盘级高速版）。进攻：我方是否有强制将死链（首步即走法）；
     * 防守：对方是否有将死链（首步为干预点，须是我方当前合法着法）。
     * 有我方将死链时不再算对方的——将死必走，对方链条无从谈起。 */
    const VCF_PLIES = 7;
    if (engine.deepTactics && engine.vcfWin && win.length === 0 && block.length === 0 && oppSide) {
      try {
        const atk = engine.vcfWin(st, side, VCF_PLIES);
        if (atk && atk.win && atk.first) res.vcf_win_you = [atk.first];
      } catch (_) { /* fail-soft：VCF 异常不影响原有战术 */ }
      if (res.vcf_win_you.length === 0) {
        try {
          const def = engine.vcfWin(flipTurn(st, oppSide.id), oppSide.id, VCF_PLIES);
          if (def && def.win && def.first) {
            /* 干预点候选：先试链首，再按链条顺序逐点试。实战（2026-09-30
             * exp-20260930025135 game4 ply18）：只占链首 C13 杀不死将死链
             * （黑转走 E13 线），旧逻辑直接放弃 vcfDefense，白 D13(parry3)
             * 后被黑 E13 双重威胁打死；但链上 E13/F12/E14/C14/E12 均可彻底
             * 破杀。故链首失败不直接放弃，继续试链条上其他点。 */
            const cands = [];
            const seen = new Set();
            const pushCand = (n) => { if (n && !seen.has(n)) { seen.add(n); cands.push(n); } };
            pushCand(def.first);
            for (const n of (def.line || [])) pushCand(n);
            for (const n of cands) {
              const mv = engine.moveFromNotation(st, n);
              if (!mv) continue;
              /* 试走后复搜：对方可能有多条 VCF 根（见 ⑨e：I9/E9 双链），只有干预后
               * 对方彻底无将死链才采用；否则继续试下一点，全部失败则留空，
               * 回落 parry/pickSafestParry 老路。 */
              const stAfter = engine.applyMove(st, mv);
              const recheck = engine.vcfWin(flipTurn(stAfter, oppSide.id), oppSide.id, VCF_PLIES);
              if (!recheck.win) { res.vcf_win_opponent = [n]; break; }
            }
          }
        } catch (_) { /* fail-soft */ }
      }
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
        'If `vcf_win_you` is non-empty, playing that point starts a forced sequence of consecutive fours leading to victory — take it when there is no immediate win, block, or double-threat above. ' +
        'If `vcf_win_opponent` is non-empty, the opponent has such a forced sequence; playing that point disrupts it at its entry — prioritize it over quiet moves. ' +
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

      if (channel === 'rapfi') {
        /* Rapfi 是完整搜索引擎（非 prompt 型），不走 Jev 战术层；
         * 与 mock 一样直接返回，保持「Rapfi vs Jev」实验变量纯净。 */
        return BG.rapfi.decide(engine, st, side, legal, ser);
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

      let answers, usage, costUsd, probs, conf, modelName;
      if (channel === 'random') {
        /* 纯随机基线（对比实验用）：均匀概率、零启发式，照样走完整战术管线。
         * 与 mock 的区别：mock 直接返回不经过战术层；random 刻意走战术层，
         * 这样"随机+战术" vs "Jev+战术"的唯一变量就是概率分布的质量。 */
        answers = {}; usage = {};
        costUsd = 0; modelName = 'random-baseline';
        probs = {};
        legal.forEach((m) => { probs[m.notation] = 1; });
        conf = null;
      } else {
        const data = await callWithRetry(channel, ser, opts);
        answers = data.answers || {};
        usage = data.usage || {};
        costUsd = (usage.input_tokens || 0) * 42 / 1e9; // 输入 $42/十亿token ≈ $42/百万，输出免费
        modelName = data.model;
        const ans = answers.move || {};
        probs = ans.probabilities || {};
        conf = typeof ans.confidence === 'number' ? ans.confidence : null;
      }
      const latencyMs = Date.now() - t0;

      /* 只保留合法着法的概率（响应理论上是选项子集） */
      const pairs = Object.entries(probs).filter(([k]) => byNotation.has(k));
      if (pairs.length === 0) {
        const fallback = legal[0];
        return {
          notation: fallback.notation, move: fallback,
          meta: { channel, model: modelName, latencyMs, usage, costUsd, confidence: 0, top: [],
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
      const tacticName = () => ({ win: '致胜点', block: '必挡点', open4: '活四点', threat: '造杀点', vcfAttack: '连续冲四将死链', vcfDefense: '将死链干预点', parry: '拆杀点', parry3: '活三/活四预挡点', parry4: '冲四预挡点' }[tacticUsed] || '战术点');
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
      /* 拆杀点安全性排序：多个 danger 并存时逐个试走，优先排除给对方持续攻击节奏的
       * 坏点（3-ply：白 p → 黑逼杀 q → 白被迫堵 → 黑仍有 danger），剩余再按逼杀数
       * 排序。单个点或非 deepTactics 引擎时回退到 pickAmong。 */
      const pickSafestParry = (list) => {
        if (list.length <= 1) return pickAmong(list);
        const oppSide = engine.sides && engine.sides.find((s) => s.id !== st.turn);
        if (!oppSide || !engine.deepTactics) return pickAmong(list);
        const candNs = (cands && cands.length) ? cands : legal.map((m) => m.notation);
        try {
          // 第一轮：排除允许持续攻击的坏点
          const good = list.filter((p) => !allowsSustainedAttack(engine, st, p, oppSide.id, st.turn, candNs));
          const pool = good.length ? good : list;
          if (pool.length === 1) return pool[0];
          // 第二轮：按逼杀着法数排序，取最少
          let best = null, bestScore = Infinity;
          for (const p of pool) {
            const score = countForcingReplies(engine, st, p, oppSide.id, candNs);
            if (score < bestScore) { bestScore = score; best = p; }
          }
          if (best) return best;
        } catch (_) { /* 降级 */ }
        return pickAmong(list);
      };
      const open4Points = Object.entries(ser.questions.move.criteria || {})
        .filter(([n, v]) => typeof v === 'string' && /(^|\+)you:open4(\+|$)/.test(v) && byNotation.has(n))
        .map(([n]) => n);
      /* 第四级（3-ply 预挡）：对手的 deny:open4/deny:live3 标签点 = 对方下回合可造活四/活三的
       * 制造点。放任不管会被迫逐手拆杀（实战败局：p20 白走闲着 E6，黑 E7 活三点 → 强制拆 →
       * J8 双杀 → 输）。win/block/open4/threat/parry 都无时抢先占掉，让对手造不成活三。
       * 第五级（Rapfi 实战复盘 2026-09-29 增补）：deny:four = 对方下回合可造冲四（单杀逼迫链
       * 起点）。Rapfi 对局显示：放任冲四制造点会被连续单杀逼迫 → 双杀收尾（4 局 3 次）。
       * 优先级 deny:open4/deny:live3 > deny:four（后者多为单杀，可被 block 层处理，但提前
       * 抢占能打断对方的连续逼杀节奏）。 */
      const parry3Points = Object.entries(ser.questions.move.criteria || {})
        .filter(([n, v]) => typeof v === 'string' && /(^|\+)deny:(open4|live3)(\+|$)/.test(v) && byNotation.has(n))
        .map(([n]) => n);
      const parry4Points = Object.entries(ser.questions.move.criteria || {})
        .filter(([n, v]) => typeof v === 'string' && /(^|\+)deny:four(\+|$)/.test(v) && byNotation.has(n))
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
      } else if (tactics.vcf_win_you.length) {
        /* VCF 进攻：连续冲四将死链的首步。排在 threat 之后（双杀两步胜更快）、
         * parry 之前（将死链是强制胜，比"对方下回合可能造双杀"更紧急）。 */
        notation = pickAmong(tactics.vcf_win_you);
        if (notation) tacticUsed = 'vcfAttack';
      } else if (tactics.vcf_win_opponent.length) {
        /* VCF 防守：对方将死链的干预点（链条入口）。将死是强制输，比 parry 的
         * "潜在双杀"更紧急，故优先。 */
        notation = pickAmong(tactics.vcf_win_opponent);
        if (notation) tacticUsed = 'vcfDefense';
      } else if (tactics.danger_points_opponent.length) {
        notation = pickSafestParry(tactics.danger_points_opponent);
        if (notation) tacticUsed = 'parry';
      } else if (parry3Points.length) {
        notation = pickAmong(parry3Points);
        if (notation) tacticUsed = 'parry3';
      } else if (parry4Points.length) {
        notation = pickAmong(parry4Points);
        if (notation) tacticUsed = 'parry4';
      }

      /* top-k 概率加权随机（随机度） */
      if (!notation) {
        if (channel === 'random') {
          /* 真随机基线：自由手均匀采样，与 topK 无关——否则 topK=1 会把均匀概率
           * 坍缩成"取第一顺位"，退化成顺序走子（已验证过的坑）。战术接管不受影响。 */
          notation = legal[BG.util.rand(legal.length)].notation;
        } else {
          const k = Math.max(1, opts.topK | 0 || 1);
          if (k === 1) {
            notation = pairs[0][0];
          } else {
            const top = pairs.slice(0, k);
            notation = BG.util.weightedPick(top.map((p) => p[0]), top.map((p) => p[1]));
          }
        }
      }

      return {
        notation,
        move: byNotation.get(notation) || engine.moveFromNotation(st, notation),
        meta: {
          channel, model: modelName, latencyMs, usage, costUsd, confidence: conf,
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
