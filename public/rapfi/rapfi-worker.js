/* rapfi-worker.js — Rapfi 思考线程（classic worker，刻意手写、不进打包）。
 *
 * 协议（主线程侧实现见 src/app/rapfi-worker.ts）：
 *   ← { type:'init', glueUrl, assetBase, glueText, wasm, data }   资产字节由页面抓好后交进来
 *   → { type:'progress', stage:'download', detail } | { type:'stderr', line }
 *   → { type:'ready' } | { type:'init-error', message, retryable }
 *   ← { type:'cmd', id, cmd }  →  { type:'lines', id, lines } | { type:'cmd-error', id, message }
 *   ← { type:'dispose' }
 *
 * 为什么是 classic worker：胶水是普通脚本（顶层 `var Rapfi=…`），只有 classic worker 的
 * `importScripts` 能把它挂成 worker 全局；module worker 禁 `importScripts`（Vite 的 `?worker`
 * 在 dev 一律产出 module worker，故不走打包）。
 * 为什么资产由页面交进来：CDP 的 Fetch 拦截**按 target** 生效，两个 harness 靠它把 `/rapfi/*`
 * 改由本地 `public/rapfi/` 供给；Worker 自己发请求就绕过那条捷径（详见 src/app/rapfi-worker.ts）。
 */
'use strict';

(function () {
  var mod = null;
  var stdout = [];
  var ready = false;

  function post(msg) {
    self.postMessage(msg);
  }

  function initError(e, retryable) {
    ready = false;
    post({
      type: 'init-error',
      message: (e && e.message) ? e.message : String(e),
      retryable: retryable !== false,
    });
  }

  function boot(msg) {
    var glueUrl = String(msg.glueUrl || '');
    var assetBase = String(msg.assetBase || '');
    var wasmBytes = msg.wasm;
    var dataBytes = msg.data;
    var blobUrl = null;
    try {
      blobUrl = self.URL.createObjectURL(new Blob([String(msg.glueText || '')], { type: 'text/javascript' }));
      self.importScripts(blobUrl);
    } catch (e) {
      initError(e);
      return;
    } finally {
      if (blobUrl) { try { self.URL.revokeObjectURL(blobUrl); } catch (_) { /* ignore */ } }
    }

    var factory = self.Rapfi;
    if (typeof factory !== 'function') {
      initError(new Error('Rapfi 胶水脚本未导出工厂函数 Rapfi：' + glueUrl), false);
      return;
    }

    var p;
    try {
      p = factory({
        locateFile: function (path) { return assetBase + path; },
        onReceiveStdout: function (line) { stdout.push(String(line)); },
        onReceiveStderr: function (line) { post({ type: 'stderr', line: String(line) }); },
        /* Emscripten 的下载进度（本路径下 .data/.wasm 已由页面交进来，这里只作状态透传）。 */
        setStatus: function (text) {
          if (text) post({ type: 'progress', stage: 'download', detail: String(text) });
        },
        /* 两个预载钩子：直接用页面交来的字节，Worker 不发任何网络请求。 */
        instantiateWasm: function (imports, successCallback) {
          WebAssembly.instantiate(wasmBytes, imports).then(function (result) {
            successCallback(result.instance);
          }, function (e) { initError(e); });
          return {};
        },
        getPreloadedPackage: function () { return dataBytes; },
      });
    } catch (e) {
      initError(e);
      return;
    }

    Promise.resolve(p).then(function (m) {
      if (!m || typeof m.sendCommand !== 'function') {
        initError(new Error('Rapfi 引擎实例化失败（Module 无 sendCommand）'));
        return;
      }
      mod = m;
      ready = true;
      post({ type: 'ready' });
    }, function (e) { initError(e); });
  }

  self.onmessage = function (ev) {
    var msg = ev && ev.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'init') {
      if (ready || mod) return; /* 只认第一次初始化 */
      boot(msg);
      return;
    }

    if (msg.type === 'cmd') {
      var id = msg.id;
      var mark = stdout.length;
      try {
        if (!mod || typeof mod.sendCommand !== 'function') throw new Error('Rapfi 引擎尚未就绪');
        mod.sendCommand(String(msg.cmd));
        post({ type: 'lines', id: id, lines: stdout.slice(mark) });
      } catch (e) {
        post({ type: 'cmd-error', id: id, message: (e && e.message) ? e.message : String(e) });
      }
      return;
    }

    if (msg.type === 'dispose') {
      ready = false;
      try { if (mod && typeof mod.terminate === 'function') mod.terminate(); } catch (_) { /* ignore */ }
      mod = null;
      stdout = [];
    }
  };
})();
