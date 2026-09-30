'use strict';
/* board.js — 全局命名空间 + 工具 + canvas 绘制辅助（无 DOM 依赖，可在 Node 中加载做自检） */
(function () {
  const BG = (globalThis.BG = globalThis.BG || {});
  BG.games = BG.games || {};
  BG.register = function (def) { BG.games[def.id] = def; };

  /* 可种子随机（mulberry32，与 jev-piano/test/rng-shim.mjs 同实现）。
     BG.setSeed(n) 后 BG.util.rand/rnd 变为确定性；未设置时仍走 Math.random。
     注意 BG.util.weightedPick 不经过 rand——真实 Jev 渠道的 top-k 采样
     保持真随机，不受 seed 影响（见 docs/jev-api.md §6）。 */
  BG.rng = function (seed) {
    let a = (seed ^ 0x9e3779b9) >>> 0; // 异或混淆：避免相邻 seed 产生相邻随机流
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  BG._rng = null;
  BG._seed = null; // 当前种子（未设 = null）。棋谱导出用它标注可复现性。
  BG.setSeed = function (seed) { BG._rng = BG.rng(seed); BG._seed = seed; }; // _rng 只应由 setSeed 写；并行对局勿共享全局 RNG

  /* 代码版本标记。零构建、无 git 注入，只能手工维护：
   * 改动会改变对局行为（引擎规则、战术层、Jev prompt、导出格式）时必须同步 bump，
   * 否则历史棋谱无法归因到具体代码。格式 v0.7 起写入棋谱 meta。 */
  BG.codeVersion = '0.7.0';

  BG.util = {
    clone: (o) => JSON.parse(JSON.stringify(o)),
    rand: (n) => Math.floor((BG._rng || Math.random)() * n),
    rnd: () => (BG._rng || Math.random)(),
    shuffle(a) {
      a = a.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = BG.util.rand(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /* 按权重随机挑一个（items 与 weights 等长） */
    weightedPick(items, weights) {
      const total = weights.reduce((s, w) => s + Math.max(w, 1e-9), 0);
      let t = Math.random() * total;
      for (let i = 0; i < items.length; i++) {
        t -= Math.max(weights[i], 1e-9);
        if (t <= 0) return items[i];
      }
      return items[items.length - 1];
    },
    assert(cond, msg) {
      if (!cond) throw new Error('assert failed: ' + msg);
    },

    /* 棋谱导出：单手 AI 决策的归因信息（纯函数，放在这里以便 Node 自检覆盖——app.js 是 DOM 闭包，
     * 测试里不加载）。字段名压到最短：一局可达两百手，导出体积分页有 2MB 上限。
     * 回答的问题：实走这手模型给了多少概率、排第几、是否被战术保险顶掉、代价多少。 */
    aiMoveMeta(notation, m) {
      if (!m || !m.byAI) return null;
      const top = m.top || [];
      const i = top.findIndex((t) => t && t.notation === notation);
      const p = i >= 0 ? top[i].p : null;
      return {
        ch: m.channel,
        mdl: m.model,
        conf: typeof m.confidence === 'number' ? m.confidence : null,
        p: typeof p === 'number' ? p : null, // 实走这手在候选里的概率
        rank: i >= 0 ? i + 1 : null, // 1 = 模型首选；null = 不在前 8 名（未进榜）
        cands: m.candidates || null, // 合法候选总数
        ms: typeof m.latencyMs === 'number' ? m.latencyMs : null,
      };
    },
    /* 棋谱导出：全局 meta（代码版本 + 采样参数 + 成本/延迟汇总 + 战术保险使用分布）。
     * 入参传整局 history 即可，非 AI 着法在函数内过滤（aiMoves 必须是「AI 手数」）。
     * tactics 分布是败因分桶的前置信号：先看哪一级保险被触发多少次，再逐局归因。 */
    aiGameMeta(history, opts) {
      const o = opts || {};
      const items = history.filter((h) => h.meta && h.meta.byAI);
      let cost = 0;
      let tokens = 0;
      let msSum = 0;
      let msMax = 0;
      let msN = 0;
      let confSum = 0;
      let confN = 0;
      const tac = {};
      items.forEach((h) => {
        const m = h.meta;
        if (m.costUsd) cost += m.costUsd;
        if (m.usage && m.usage.input_tokens) tokens += m.usage.input_tokens;
        if (typeof m.latencyMs === 'number') {
          msSum += m.latencyMs;
          msMax = Math.max(msMax, m.latencyMs);
          msN++;
        }
        if (typeof m.confidence === 'number') { confSum += m.confidence; confN++; }
        if (m.tactics) tac[m.tactics] = (tac[m.tactics] || 0) + 1;
      });
      return {
        code: BG.codeVersion || null,
        topK: typeof o.topK === 'number' ? o.topK : null,
        seed: typeof BG._seed === 'number' ? BG._seed : null, // null = 未设种子（真实渠道本就真随机）
        aiMoves: items.length,
        costUsd: Math.round(cost * 1e6) / 1e6,
        tokens,
        latencyMs: msN ? { avg: Math.round(msSum / msN), max: msMax } : null,
        conf: confN ? Math.round((confSum / confN) * 1000) / 1000 : null,
        tactics: tac, // 空对象 = 本局没有一次战术保险接管
      };
    },
  };

  BG.gfx = {
    /* HiDPI canvas 初始化，返回 2d ctx（逻辑像素坐标绘制） */
    setup(canvas, w, h) {
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas._logicalW = w;
      canvas._logicalH = h;
      /* 宽度定值 + 高度 auto：窄屏时 max-width 收缩并保持纵横比 */
      canvas.style.width = w + 'px';
      canvas.style.height = 'auto';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return ctx;
    },
    clear(ctx, w, h, color) {
      ctx.fillStyle = color || '#FAFBFD';
      ctx.fillRect(0, 0, w, h);
    },
    /* 交叉点网格（五子棋/围棋） */
    intersections(ctx, x0, y0, cell, cols, rows, color) {
      ctx.strokeStyle = color || '#3A4048';
      ctx.lineWidth = 1;
      for (let i = 0; i < cols; i++) {
        const x = x0 + i * cell;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + (rows - 1) * cell); ctx.stroke();
      }
      for (let j = 0; j < rows; j++) {
        const y = y0 + j * cell;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + (cols - 1) * cell, y); ctx.stroke();
      }
    },
    /* 方格棋盘（国际象棋/象棋/跳棋），可给部分格子填色 */
    cells(ctx, x0, y0, size, cols, rows, darkFn, darkColor) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (darkFn && darkFn(r, c)) {
            ctx.fillStyle = darkColor || '#D9DEE5';
            ctx.fillRect(x0 + c * size, y0 + r * size, size, size);
          }
        }
      }
      ctx.strokeStyle = '#3A4048'; ctx.lineWidth = 1;
      ctx.strokeRect(x0, y0, cols * size, rows * size);
      for (let i = 1; i < cols; i++) {
        ctx.beginPath(); ctx.moveTo(x0 + i * size, y0); ctx.lineTo(x0 + i * size, y0 + rows * size); ctx.stroke();
      }
      for (let j = 1; j < rows; j++) {
        ctx.beginPath(); ctx.moveTo(x0, y0 + j * size); ctx.lineTo(x0 + cols * size, y0 + j * size); ctx.stroke();
      }
    },
    stone(ctx, x, y, r, color, isLast) {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color === 'black' ? '#1F242C' : '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = color === 'black' ? '#0E1116' : '#9AA3AD';
      ctx.lineWidth = 1; ctx.stroke();
      if (isLast) {
        ctx.beginPath(); ctx.arc(x, y, r * 0.32, 0, Math.PI * 2);
        ctx.fillStyle = color === 'black' ? '#E4E8ED' : '#C2402A';
        ctx.fill();
      }
    },
    disc(ctx, x, y, r, fill, stroke, label, labelColor) {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
      if (label) {
        ctx.fillStyle = labelColor || '#fff';
        ctx.font = 'bold ' + Math.round(r * 1.15) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + r * 0.06);
      }
    },
    text(ctx, str, x, y, opts) {
      opts = opts || {};
      ctx.fillStyle = opts.color || '#8A939E';
      ctx.font = (opts.bold ? 'bold ' : '') + (opts.size || 11) + 'px sans-serif';
      ctx.textAlign = opts.align || 'center';
      ctx.textBaseline = opts.baseline || 'middle';
      ctx.fillText(str, x, y);
    },
    highlight(ctx, x, y, r, color) {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = color || 'rgba(31,36,44,.85)';
      ctx.lineWidth = 2.5; ctx.stroke();
    },
  };

  /* ?seed=42：复现演示。Node 侧由测试显式 BG.setSeed()，不依赖这里。 */
  if (typeof location !== 'undefined' && location.search) {
    const seedMatch = /[?&]seed=(\d+)/.exec(location.search);
    if (seedMatch) BG.setSeed(parseInt(seedMatch[1], 10));
  }

  /* 浏览器事件 → 逻辑坐标 */
  BG.eventXY = function (canvas, e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas._logicalW / rect.width),
      y: (e.clientY - rect.top) * (canvas._logicalH / rect.height),
    };
  };
})();
