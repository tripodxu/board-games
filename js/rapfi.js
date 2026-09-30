'use strict';
/* rapfi.js — Rapfi WASM 本地引擎通道（Gomocup 协议）。
 *
 * 零第三方依赖：首次使用时动态注入 rapfi/rapfi-single-simd128.js
 *（Emscripten MODULARIZE 胶水），通过 Module.sendCommand 走标准输入与
 * 引擎对话，Module.onReceiveStdout 按行收引擎输出。
 *
 * 协议要点（以 Rapfi 250615 源码为准，见 docs/adr/0006）：
 *  - 初始化：START 15（回 OK）、INFO rule 0（无禁手）、INFO timeout_turn <ms>
 *  - 每手：BOARD + 多行 "x,y,color" + DONE；color=1 是轮走方（SELF），
 *    color=2 是对方（OPPO）；引擎回一行 "x,y" 即着法。
 *  - 坐标：x=列（0 最左），y=行（0 最顶），与项目记法 A1=(0,0) 一致。
 *  - 单线程构建下 sendCommand 是同步阻塞的：一次调用即走完一整手思考，
 *    时长由 INFO timeout_turn 限定；UI 会在思考期间冻结（见 ADR 已知局限）。
 */
(function () {
  var BOARD_N = 15;
  var GLUE_FILE = 'rapfi/rapfi-single-simd128.js';
  var DEFAULT_THINK_MS = 3000;

  /* 本脚本自身的 URL（解析期 document.currentScript 可用），用于稳健地
   * 定位 rapfi/ 目录；取不到时退化为相对页面路径。 */
  var THIS_URL = (function () {
    try {
      if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src)
        return document.currentScript.src;
    } catch (_) { /* ignore */ }
    return '';
  })();

  function glueUrl() {
    if (THIS_URL) {
      var jsDir = THIS_URL.slice(0, THIS_URL.lastIndexOf('/') + 1); // .../js/
      var root = jsDir.slice(0, jsDir.slice(0, -1).lastIndexOf('/') + 1); // .../
      return root + GLUE_FILE;
    }
    return GLUE_FILE;
  }

  function globalObj() {
    if (typeof window !== 'undefined') return window;
    if (typeof globalThis !== 'undefined') return globalThis;
    return {};
  }

  /* ---------------- 纯函数（无 DOM、无引擎，可单测） ---------------- */

  /* 记法 "H8" -> { x: 7, y: 7 }；非法返回 null */
  function notationToXY(notation) {
    if (typeof notation !== 'string') return null;
    var m = /^([A-Oa-o])([1-9]|1[0-5])$/.exec(notation.trim());
    if (!m) return null;
    return { x: m[1].toUpperCase().charCodeAt(0) - 65, y: parseInt(m[2], 10) - 1 };
  }

  /* { x, y } -> 记法 "H8"；越界返回 null */
  function xyToNotation(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (x < 0 || x >= BOARD_N || y < 0 || y >= BOARD_N) return null;
    return String.fromCharCode(65 + x) + (y + 1);
  }

  /* 从 st.board 重建 BOARD 命令块（单字符串，多行以 \n 连接）。
   * 颜色是相对引擎的：1=SELF（轮走方 side 的子），2=OPPO。
   * 落子按 SELF/OPPO 交替排列且首子为 SELF：Rapfi 按顺序重放落子并用
   * PASS 对齐轮走方；若同色连排，插入的 PASS 会打乱最终轮走方。
   * 交替排列时：黑走 B==W 恰好用完；白走黑多一子，末尾单 OPPO 子恰好
   * 对上期望轮走方，全程不触发 PASS，终局轮走方恒正确。 */
  function buildBoardCommand(st, side) {
    var selfVal = side === 'black' ? 1 : 2;
    var selfStones = [];
    var oppoStones = [];
    var board = st.board;
    for (var r = 0; r < BOARD_N; r++) {
      for (var c = 0; c < BOARD_N; c++) {
        var v = board[r] && board[r][c];
        if (v === selfVal) selfStones.push(c + ',' + r + ',1');
        else if (v === 1 || v === 2) oppoStones.push(c + ',' + r + ',2');
      }
    }
    var lines = ['BOARD'];
    var i = 0, j = 0, selfTurn = true;
    while (i < selfStones.length || j < oppoStones.length) {
      if (selfTurn) {
        if (i < selfStones.length) lines.push(selfStones[i++]);
        else lines.push(oppoStones[j++]);
      } else {
        if (j < oppoStones.length) lines.push(oppoStones[j++]);
        else lines.push(selfStones[i++]);
      }
      selfTurn = !selfTurn;
    }
    lines.push('DONE');
    return lines.join('\n');
  }

  /* 解析引擎输出行：只认严格的 "x,y"，OK/MESSAGE/ERROR/INFO 等一律忽略。
   * 返回 { x, y } 或 null。 */
  function parseMoveLine(line) {
    if (typeof line !== 'string') return null;
    var m = /^\s*(\d{1,2})\s*,\s*(\d{1,2})\s*$/.exec(line);
    if (!m) return null;
    var x = parseInt(m[1], 10), y = parseInt(m[2], 10);
    if (x < 0 || x >= BOARD_N || y < 0 || y >= BOARD_N) return null;
    return { x: x, y: y };
  }

  function isErrorLine(line) {
    return typeof line === 'string' && /^\s*ERROR\b/.test(line);
  }

  /* ---------------- 引擎实例管理 ---------------- */

  var _module = null;      // 就绪的 Emscripten Module
  var _loadPromise = null; // 进行中的加载 Promise（并发复用）
  var _stdoutLines = [];   // 引擎全部 stdout 行（含 OK/MESSAGE 等）

  function _onStdout(line) { _stdoutLines.push(String(line)); }
  function _onStderr(line) {
    try { if (typeof console !== 'undefined') console.warn('[rapfi:stderr]', line); } catch (_) { /* ignore */ }
  }

  /* 向引擎发一条完整协议命令（单行或 BOARD 多行块），返回本次新增的 stdout 行 */
  function _send(cmd) {
    if (!_module || typeof _module.sendCommand !== 'function')
      throw new Error('Rapfi 引擎尚未就绪');
    var mark = _stdoutLines.length;
    _module.sendCommand(cmd);
    return _stdoutLines.slice(mark);
  }

  /* 动态注入 Emscripten 胶水脚本并实例化。onProgress 可选回调('script'|'wasm')。
   * 并发调用复用同一 Promise；加载失败后自动清零以允许重试。 */
  function ensureLoaded(onProgress) {
    if (_module) return Promise.resolve(_module);
    if (_loadPromise) return _loadPromise;
    _loadPromise = new Promise(function (resolve, reject) {
      var g = globalObj();
      var doc = typeof document !== 'undefined' ? document : null;
      if (!doc) {
        reject(new Error('当前环境不支持动态加载 Rapfi 脚本（无 document）'));
        return;
      }
      var url = glueUrl();
      if (typeof onProgress === 'function') { try { onProgress('script'); } catch (_) { /* ignore */ } }
      var script = doc.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = function () {
        try {
          var factory = g.Rapfi;
          if (typeof factory !== 'function')
            throw new Error('Rapfi 胶水脚本未导出工厂函数 Rapfi：' + url);
          var base = url.slice(0, url.lastIndexOf('/') + 1);
          if (typeof onProgress === 'function') { try { onProgress('wasm'); } catch (_) { /* ignore */ } }
          factory({
            locateFile: function (p) { return base + p; },
            onReceiveStdout: _onStdout,
            onReceiveStderr: _onStderr,
          }).then(function (mod) {
            _module = mod;
            try {
              var initOut = _send('START 15');
              var ok = initOut.some(function (l) { return /^\s*OK\s*$/.test(l); });
              if (!ok) throw new Error('引擎 START 无 OK 回应：' + initOut.join('|'));
              _send('INFO rule 0'); // 无禁手自由五子棋
              resolve(mod);
            } catch (e) { reject(e); }
          }, function (e) {
            reject(new Error('Rapfi WASM 实例化失败：' + (e && e.message || e)));
          });
        } catch (e) { reject(e); }
      };
      script.onerror = function () {
        reject(new Error('Rapfi 脚本加载失败：' + url + '（需 HTTP 服务，直接双击 file:// 可能因 .data 跨域被拦）'));
      };
      doc.head.appendChild(script);
    });
    _loadPromise.then(null, function () { _loadPromise = null; });
    return _loadPromise;
  }

  /* ---------------- 决策 ---------------- */

  /* 走一步棋。opts: { thinkMs?, signal? }。
   * 返回 { notation, move, meta }；meta.channel 恒为 'rapfi'。
   * 引擎无响应（未返回着法行）时抛错，由调用方按现有错误路径处理。 */
  async function decide(engine, st, side, legal, ser, opts) {
    if (!engine || engine.id !== 'gomoku')
      throw new Error('rapfi 渠道仅支持五子棋引擎');
    opts = opts || {};
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');
    var thinkMs = Math.max(500, Math.min(60000, opts.thinkMs || DEFAULT_THINK_MS));

    var mod = await ensureLoaded(opts.onProgress);
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');
    void mod; // _send 内部使用 _module

    /* 让出事件循环一拍，使「思考中」指示先 paint（sendCommand 是同步阻塞的） */
    await new Promise(function (r) { setTimeout(r, 0); });
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');

    var boardCmd = buildBoardCommand(st, side);
    var fresh;
    try {
      _send('INFO timeout_turn ' + thinkMs);
      fresh = _send(boardCmd);
    } catch (e) {
      throw new Error('Rapfi 引擎调用失败：' + (e && e.message || e));
    }

    var moveXY = null;
    var errLines = [];
    for (var i = 0; i < fresh.length; i++) {
      var p = parseMoveLine(fresh[i]);
      if (p) moveXY = p; // 取最后一个着法行
      else if (isErrorLine(fresh[i])) errLines.push(fresh[i]);
    }
    if (!moveXY) {
      throw new Error('Rapfi 引擎无响应（未返回着法）' +
        (errLines.length ? '：' + errLines.join(' | ') : ''));
    }

    var notation = xyToNotation(moveXY.x, moveXY.y);
    var byNotation = new Map((legal || []).map(function (m) { return [m.notation, m]; }));
    var move = notation && byNotation.get(notation);
    if (!move) {
      throw new Error('Rapfi 返回非法着法：' + (notation || moveXY.x + ',' + moveXY.y));
    }
    return {
      notation: notation,
      move: move,
      meta: {
        channel: 'rapfi',
        engine: 'Rapfi',
        thinkMs: thinkMs,
        xy: moveXY.x + ',' + moveXY.y,
      },
    };
  }

  BG.rapfi = {
    ensureLoaded: ensureLoaded,
    decide: decide,
    /* 以下供测试与调试 */
    notationToXY: notationToXY,
    xyToNotation: xyToNotation,
    buildBoardCommand: buildBoardCommand,
    parseMoveLine: parseMoveLine,
    _emitStdout: _onStdout,       // 测试：模拟引擎输出行
    _setModule: function (m) { _module = m; }, // 测试：注入假 Module
    _reset: function () { _module = null; _loadPromise = null; _stdoutLines = []; },
  };
})();
