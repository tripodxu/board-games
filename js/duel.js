/* duel.js — 战绩簿显示名、实验联名、棋谱文件名 slug（纯函数）
 *
 * 一套命名三处共用：战绩簿列（app.renderRecords）、实验报告（BG.jev-lab 结果），
 * 以及落库文件名（server.js / functions/api/games.js 的 slug 字段）。
 * 人看到的联名与文件名可互相推导，才可能事后归因某一盘棋是谁的什么版本。
 *
 * 依赖 js/tactics-versions.js（取版本短号）。无 DOM 依赖。
 */
(function () {
  const BG = (typeof window !== 'undefined' && window.BG) || globalThis.BG;
  if (!BG || !BG.tacticsVersions) throw new Error('duel.js 必须先加载 js/tactics-versions.js');

  /* 渠道 → 中文短名。Jev 三渠道（proxy/openrouter/official）同一个模型，联名一律 Jev。 */
  const CH_SHORT = { proxy: 'Jev', openrouter: 'Jev', official: 'Jev', mock: '演示', rapfi: 'Rapfi', random: '随机' };
  /* 渠道 → 英文短名（slug 专用：中文在文件名里折叠成 - 会丢失语义） */
  const CH_EN = { proxy: 'jev', openrouter: 'jev', official: 'jev', mock: 'mock', rapfi: 'rapfi', random: 'ran' };

  /** 版本短号：v9-vcf-sound → v9；未知档位 resolve 回退当前档（恶意/写错 id 也造不出路径）。 */
  function versionTag(id) {
    const v = BG.tacticsVersions.resolve(id);
    const m = /^v(\d+)/.exec(v.id);
    return m ? 'v' + m[1] : v.id;
  }

  /** 单边配置 → 展示名。cfg = { channel, tactics?, rapfiThinkMs?, human? }
   *  - human → 我；mock → 演示（不经过战术层，标版本无意义）
   *  - Jev/random → 带战术版本短号（实验室可读性就在这一位）
   *  - rapfi → 带思考时长秒数（WASM 单线程，时长是它的关键参数） */
  function sideLabel(cfg) {
    const c = cfg || {};
    if (c.human) return '我';
    const ch = c.channel || 'mock';
    if (ch === 'rapfi') return 'Rapfi(' + (Math.round((c.rapfiThinkMs || 3000) / 100) / 10) + 's)';
    if (ch === 'mock') return '演示';
    if (ch === 'random') return '随机·' + versionTag(c.tactics);
    return (CH_SHORT[ch] || ch) + '·' + versionTag(c.tactics);
  }

  /** 单边配置 → slug 段（英文）。e.g. {channel:'random',tactics:'v3-make2'} → ran-v3 */
  function sideSlug(cfg) {
    const c = cfg || {};
    if (c.human) return 'me';
    const ch = c.channel || 'mock';
    const en = CH_EN[ch] || String(ch).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (ch === 'mock') return en;
    if (ch === 'rapfi') return 'rapfi-' + (Math.round((c.rapfiThinkMs || 3000) / 100) / 10) + 's';
    return en + '-' + versionTag(c.tactics);
  }

  /** 联名：黑 Jev·v9 vs 白 Rapfi(3s) */
  function duelLabel(blackCfg, whiteCfg) {
    return '黑 ' + sideLabel(blackCfg) + ' vs 白 ' + sideLabel(whiteCfg);
  }

  /** 战绩簿一行名：五子棋 · 人机 · 黑 我 vs 白 Jev·v9 */
  function gameLabel(gameName, mode, blackCfg, whiteCfg) {
    const modeTxt = mode === 'ai-ai' ? '机机' : mode === 'pvp' ? '双人' : '人机';
    return gameName + ' · ' + modeTxt + ' · ' + duelLabel(blackCfg, whiteCfg);
  }

  /** 实验标签：Jev·v9 vs 随机·v3 ×4局（交换先后各 2 局） */
  function expLabel(blackCfg, whiteCfg, games) {
    return sideLabel(blackCfg) + ' vs ' + sideLabel(whiteCfg) + ' ×' + (games || 4) + '局';
  }

  /** 棋谱文件名 slug：小写、非 [a-z0-9] 折叠成 -、去首尾 -、截 24（与 server.sanitizeGid 对齐）。
   *  e.g. 黑 随机·v3 vs 白 Jev·v9 → ran-v3-vs-jev-v9 */
  function slug(blackCfg, whiteCfg) {
    const raw = (sideSlug(blackCfg) + '-vs-' + sideSlug(whiteCfg)).toLowerCase();
    const s = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (s || 'nogid').slice(0, 24);
  }

  function selfTest() {
    const U = BG.util.assert;
    U(sideLabel({ human: true }) === '我', 'human → 我');
    U(sideLabel({ channel: 'mock' }) === '演示', 'mock → 演示');
    U(sideLabel({ channel: 'rapfi', rapfiThinkMs: 3000 }) === 'Rapfi(3s)', 'rapfi 3s');
    U(sideLabel({ channel: 'rapfi', rapfiThinkMs: 500 }) === 'Rapfi(0.5s)', 'rapfi 0.5s');
    U(sideLabel({ channel: 'proxy' }) === 'Jev·v9', 'Jev 默认档');
    U(sideLabel({ channel: 'random', tactics: 'v4-parry3' }) === '随机·v4', 'random 带版本');
    U(slug({ channel: 'random', tactics: 'v3-make2' }, { channel: 'proxy' }) === 'ran-v3-vs-jev-v9', 'slug 形状');
    const inj = slug({ channel: 'proxy', tactics: '../../etc/pa' }, { channel: 'mock' });
    U(inj.indexOf('/') < 0 && inj.indexOf('.') < 0, 'slug 必须清掉路径字符：' + inj);
    U(slug({}, {}).length > 0, '空配置兜底 slug');
  }

  BG.duel = { CH_SHORT, CH_EN, sideLabel, sideSlug, duelLabel, gameLabel, expLabel, slug, selfTest };
})();
