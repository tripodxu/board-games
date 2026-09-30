'use strict';
/* Node 自检：加载 board.js + 六个引擎，运行各引擎 selfTest()。用法：node test/run-tests.js */
const fs = require('fs');
const path = require('path');

/* mock AI 的模拟延迟对自检无意义：默认跳过（BG_SLOW=1 可覆盖为真实延迟） */
if (!process.env.BG_SLOW) process.env.BG_FAST = '1';

globalThis.window = globalThis;
globalThis.location = { search: '', origin: 'http://localhost' };

const ROOT = path.join(__dirname, '..');
[
  'js/board.js',
  'js/latest-board.js',
  'js/tactics-versions.js',
  'js/duel.js',
  'js/calibration.js',
  'js/games/gomoku.js',
  'js/games/chess.js',
  'js/games/xiangqi.js',
  'js/games/checkers.js',
  'js/games/chinese-checkers.js',
  'js/games/go.js',
].forEach((f) => {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  eval(code);
});

let failed = 0;
const results = [];
for (const [id, eng] of Object.entries(globalThis.BG.games)) {
  try {
    eng.selfTest();
    results.push('✓ ' + eng.name + ' (' + id + ')');
  } catch (e) {
    failed++;
    results.push('✗ ' + eng.name + ' (' + id + '): ' + e.message);
  }
}

/* 契约：serializeForJev 的 state 必须带非空 rules 摘要（Jev 对齐本项目规则细节的唯一来源） */
try {
  const missing = Object.entries(globalThis.BG.games)
    .filter(([id, eng]) => {
      const ser = eng.serializeForJev(eng.newGame(), eng.sides[0].id);
      return !ser.state || typeof ser.state.rules !== 'string' || ser.state.rules.length < 40;
    })
    .map(([id]) => id);
  BG.util.assert(missing.length === 0, '以下引擎的 state.rules 缺失或过短: ' + missing.join(','));
  results.push('✓ 六引擎 state.rules 摘要契约');
} catch (e) {
  failed++;
  results.push('✗ rules 摘要契约: ' + e.message);
}

/* 单元：校准实验室的数学（解析夹具，见 js/calibration.js selfTest 注释） */
try {
  globalThis.BG.calibration.selfTest();
  results.push('✓ 校准实验室（brier/skill/ece/过度自信）');
} catch (e) {
  failed++;
  results.push('✗ 校准实验室: ' + e.message);
}

/* 单手 meta 的测试夹具（文件级：sync 元数据块与 async jevClientTests ⑬g 都要用，
 * 放在 try 里做 const 会跨不了作用域——「aiM is not defined」就是这么来的） */
function aiM(notation, extra) {
  return Object.assign({
    byAI: true, channel: 'proxy', model: 'jev-latest', confidence: 0.6,
    candidates: 12, latencyMs: 800, costUsd: 0.00005, usage: { input_tokens: 1200 },
    top: [{ notation: 'H8', p: 0.4 }, { notation: 'G8', p: 0.25 }, { notation: 'H7', p: 0.1 }],
  }, extra);
}

/* 单元：棋谱导出的 meta 构造（BG.util.aiMoveMeta / aiGameMeta）
 * 放在 board.js 而非 app.js：app.js 是 DOM 闭包，Node 自检不加载它，
 * meta 又是「把败局归因到具体代码」的唯一凭据，必须有回归覆盖。 */
try {
  const A = BG.util.assert;
  A(BG.codeVersion, 'BG.codeVersion 未设置（棋谱 meta 无代码版本，归因失效）');

  /* 非 AI 着法（人走）不该产出 meta */
  A(BG.util.aiMoveMeta('H8', { human: true }) === null, '人走的手不该有 aiMoveMeta');
  A(BG.util.aiMoveMeta('H8', null) === null, 'meta 缺失时 aiMoveMeta 应为 null');

  /* 实走首选：rank=1，概率取 top[0] */
  const m1 = BG.util.aiMoveMeta('H8', aiM('H8'));
  A(m1.rank === 1 && m1.p === 0.4 && m1.cands === 12 && m1.ms === 800,
    '首选手归因字段不对：' + JSON.stringify(m1));
  A(m1.ch === 'proxy' && m1.mdl === 'jev-latest' && m1.conf === 0.6, '渠道/模型/置信度应透出');

  /* 实走第 2 名：rank=2（被 top-k 采样或战术保险改写过的典型形态） */
  const m2 = BG.util.aiMoveMeta('G8', aiM('G8'));
  A(m2.rank === 2 && m2.p === 0.25, '第 2 名归因不对：' + JSON.stringify(m2));

  /* 不在前 8 名：rank/p 为 null，不能填 0（0 会被误读成"模型给了 0 概率"） */
  const m3 = BG.util.aiMoveMeta('A1', aiM('A1'));
  A(m3.rank === null && m3.p === null, '未进榜手的 rank/p 应为 null：' + JSON.stringify(m3));

  /* 缺字段的老/降级响应不得抛错，缺失一律 null（无 top 列表时名次无从定位 → null） */
  const m4 = BG.util.aiMoveMeta('H8', { byAI: true, channel: 'mock' });
  A(m4.conf === null && m4.ms === null && m4.cands === null && m4.rank === null && m4.p === null,
    '残缺 meta 应降级为 null 字段：' + JSON.stringify(m4));

  /* 全局 meta：汇总 + 战术分布 */
  const items = [
    { meta: aiM('H8', { tactics: 'vcfAttack', latencyMs: 900, costUsd: 0.00005 }) },
    { meta: aiM('G8', { tactics: 'vcfAttack', latencyMs: 500, costUsd: 0.00005 }) },
    { meta: aiM('H7', { tactics: 'win', latencyMs: 700, costUsd: 0.00004, confidence: 0.8 }) },
    { meta: { human: true } }, // 人走的手不参与汇总
  ];
  const gm = BG.util.aiGameMeta(items, { topK: 3 });
  A(gm.code === BG.codeVersion, 'meta.code 应等于代码版本');
  A(gm.topK === 3 && gm.seed === null, 'topK/seed 不对：' + JSON.stringify(gm));
  A(gm.aiMoves === 3, 'aiMoves 只数 AI 手：' + gm.aiMoves);
  A(gm.latencyMs.avg === 700 && gm.latencyMs.max === 900, '延迟汇总不对：' + JSON.stringify(gm.latencyMs));
  A(gm.conf === 0.667, '平均置信度应保留 3 位小数：' + gm.conf);
  A(gm.tokens === 3600, 'token 合计不对：' + gm.tokens);
  A(gm.tactics.vcfAttack === 2 && gm.tactics.win === 1, '战术分布不对：' + JSON.stringify(gm.tactics));
  A(gm.costUsd > 0 && gm.costUsd < 0.001, '成本量级不对：' + gm.costUsd);

  /* 无 AI 手 / 全无延迟：不得出现 NaN 或 max=0 的假数字 */
  const g0 = BG.util.aiGameMeta([], { topK: 1 });
  A(g0.aiMoves === 0 && g0.latencyMs === null && g0.conf === null, '空局 meta 不应有汇总值：' + JSON.stringify(g0));
  A(Object.keys(g0.tactics).length === 0, '空局 tactics 应为空对象');

  /* 种子可归因：设了 ?seed=42 的对局必须能看出来 */
  BG.setSeed(42);
  A(BG.util.aiGameMeta([], {}).seed === 42, '已设种子时 meta.seed 应为该值');
  BG.setSeed(7);
  A(BG.util.aiGameMeta([], {}).seed === 7, '换种子后 meta.seed 应跟随');
  results.push('✓ 棋谱导出 meta（单手归因 / 全局汇总 / 种子）');
} catch (e) {
  failed++;
  results.push('✗ 棋谱导出 meta: ' + e.message);
}

/* 单元：最新决策候选榜的固定槽位契约（R7「最新决策忽大忽小」的唯一回归）
 * 面板高度必须与候选数无关：恒 1 行标题 + 3 个指标槽 + 8 个候选槽 + 1 行「其余候选」。 */
function latestBoardTests() {
  const A = BG.util.assert;
  A(typeof BG.latest === 'object' && BG.latest, 'BG.latest 应存在（js/latest-board.js 未加载）');
  const m = (over) => Object.assign({
    notation: 'H8', sideName: '黑', noul: 0.612, score: 3.4, latencyMs: 820,
    candidates: 12, restProb: 0.18, confidence: 0.66, model: 'jev-latest',
    top: [
      { notation: 'H8', p: 0.18 }, { notation: 'H7', p: 0.12 }, { notation: 'I8', p: 0.08 },
      { notation: 'J8', p: 0.05 }, { notation: 'G8', p: 0.04 }, { notation: 'G7', p: 0.03 },
      { notation: 'I9', p: 0.02 }, { notation: 'J9', p: 0.01 },
    ],
  }, over);
  const h = (over) => ({ move: { notation: m(over).notation }, ply: 42, meta: m(over) });

  /* 无决策（开局前）：同一骨架，空槽填满 */
  const none = BG.latest.boardHTML(null);
  A(none.note.indexOf('尚无决策') === 0, '空状态标题应为「尚无决策」：' + none.note);
  A(none.count === '', '空状态候选数徽标应为空串，实际 ' + JSON.stringify(none.count));

  /* 三种样本下槽位数必须恒定 */
  const cases = [none, BG.latest.boardHTML(h()), BG.latest.boardHTML(h({ candidates: 3, top: [{ notation: 'H7', p: 0.5 }] }))];
  for (const c of cases) {
    A((c.html.match(/rank-row/g) || []).length === 8, '候选槽应恒 8 个，实际 ' + (c.html.match(/rank-row/g) || []).length);
    A((c.html.match(/class="big[" ]/g) || []).length === 3, '指标槽应恒 3 个，实际 ' + (c.html.match(/class="big[" ]/g) || []).length);
    A((c.html.match(/rank-rest/g) || []).length === 1, '「其余候选」行应恒在，实际 ' + (c.html.match(/rank-rest/g) || []).length);
    A((c.html.match(/latest-head/g) || []).length === 1, '标题行应恒 1 个');
  }

  /* 空槽计数：满样本 0；3 候选（榜上 1 行）7 候选+1 rest=8；无决策 8+3+1=12 */
  const empt = (s) => (s.match(/is-empty/g) || []).length;
  A(empt(BG.latest.boardHTML(h()).html) === 0, '满候选+全指标时不应有空槽，实际 ' + empt(BG.latest.boardHTML(h()).html));
  A(empt(none.html) === 12, '空状态空槽应 12 个（8 候选+3 指标+1 rest），实际 ' + empt(none.html));
  const three = BG.latest.boardHTML(h({ candidates: 3, top: [{ notation: 'H7', p: 0.5 }] }));
  A(empt(three.html) === 8, '3 候选（榜上 1 行）空槽应为 7+1=8，实际 ' + empt(three.html));

  /* 满候选时「其余候选」有字；候选少时为隐藏空槽（保留高度） */
  const full = BG.latest.boardHTML(h());
  A(full.count === '12 个候选', '候选数徽标不对：' + full.count);
  A(full.html.indexOf('其余 4 个候选合计 18.0%') >= 0, '12 候选的超额部分应显示「其余 4 个候选合计 18.0%」');
  A(three.html.indexOf('其余') < 0, '候选不足 8 时 rest 行不得出现文字');
  A(three.html.indexOf('rank-rest is-empty') >= 0, '无超额候选时 rest 应为空槽');

  /* 实走着高亮：第 1 名恰好是实走时打 is-chosen */
  A(full.html.indexOf('is-chosen') >= 0, '实走着的行应有 is-chosen 高亮');
  const miss = BG.latest.boardHTML(h({ notation: 'A1' }));
  A(miss.html.indexOf('is-chosen') < 0, '实走不在榜上时不应有 is-chosen');

  /* 指标缺失 → 空槽 –，且不抛错（降级响应 meta） */
  const bare = BG.latest.boardHTML({ move: { notation: 'H8' }, ply: 7, meta: { notation: 'H8', top: [] } });
  A(bare.html.indexOf('–') >= 0, '缺指标应显示占位 –');
  A(bare.note.indexOf('第7手') >= 0, '标题缺字段时应降级为「第N手」：' + bare.note);

  BG.latest.selfTest();
}

try {
  latestBoardTests();
  results.push('✓ 最新决策固定槽位渲染（恒 8/3/1）');
} catch (e) {
  failed++;
  results.push('✗ 最新决策固定槽位: ' + e.message);
}

/* 单元：UI 布局稳定化契约（R7 横轴版）
 * 病灶：main 第一列 auto=剩余空间，侧栏 minmax(380px,490px) 随页签内容宽度变化
 * → 切页签棋盘被 #board{max-width:100%} 重新缩放（宽度忽大忽小）。
 * 契约：侧栏列只随视口变化 + 根元素预留滚动条槽。 */
function layoutContractTests() {
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  const main = css.match(/main\s*\{[^}]*\}/);
  BG.util.assert(main, '应能抽到 main 规则块');
  BG.util.assert(
    /grid-template-columns:\s*minmax\(430px,\s*1fr\)\s+clamp\(380px,\s*31vw,\s*430px\)/.test(main[0]),
    'main 应为「内容无关棋盘列 + 视口相关定宽侧栏」，实际：' + main[0].replace(/\s+/g, ' ')
  );
  BG.util.assert(/scrollbar-gutter:\s*stable/.test(css),
    'html 应预留滚动条槽（滚动条出现/消失不得引起棋盘宽度跳变）');
}

try {
  layoutContractTests();
  results.push('✓ 布局稳定化契约（侧栏定宽 + scrollbar-gutter）');
} catch (e) {
  failed++;
  results.push('✗ 布局稳定化契约: ' + e.message);
}

/* 单元：战术版本登记表（git 历史 × 棋谱数据双锚定：9 个战术版本 + 1 数据驱动基线） */
function tacticsRegistryTests() {
  const R = globalThis.BG.tacticsVersions;
  BG.util.assert(R, 'BG.tacticsVersions 应存在（需先加载 js/tactics-versions.js）');
  BG.util.assert(R.CURRENT === 'v9-vcf-sound', '当前档应为 v9-vcf-sound（a16fdd9），实际 ' + R.CURRENT);
  const ANCHORED = ['v1-facts', 'v2-open4', 'v3-make2', 'v4-parry3', 'v5-safesort',
    'v6-parry4', 'v7-vcf', 'v8-vcf-try', 'v9-vcf-sound'];
  for (const id of ANCHORED)
    BG.util.assert(R.VERSIONS.some((v) => v.id === id), '登记表漏版本 ' + id + '（git 历史每一版都必须有）');
  BG.util.assert(R.VERSIONS.length === 10, '应为 9 战术版本 + 1 基线，实际 ' + R.VERSIONS.length);
  BG.util.assert(R.VERSIONS[0].id === 'v0-off', 'rank 0 应为无战术基线（战术层上线前）');
  /* rank 从 0 连续 */
  R.VERSIONS.forEach((v, i) => BG.util.assert(v.rank === i, v.id + ' rank 应为 ' + i));
  /* 机制集合沿梯级单调不减（老版本的机制不能被新版本丢掉） */
  const MECHS = R.MECHS; // 12 个机制键，见 js/tactics-versions.js
  for (let i = 1; i < R.VERSIONS.length; i++) {
    const prev = R.VERSIONS[i - 1].mech, cur = R.VERSIONS[i].mech;
    for (const k of MECHS)
      if (prev[k]) BG.util.assert(cur[k], R.VERSIONS[i].id + ' 丢了上级机制 ' + k);
  }
  /* 层数对照用户 m00348 权威表：2/3/5/6/6/7/9/9/9（基线 0） */
  const LAYERS = { 'v0-off': 0, 'v1-facts': 2, 'v2-open4': 3, 'v3-make2': 5, 'v4-parry3': 6,
    'v5-safesort': 6, 'v6-parry4': 7, 'v7-vcf': 9, 'v8-vcf-try': 9, 'v9-vcf-sound': 9 };
  const TIER = ['win', 'block', 'open4', 'threat', 'vcfAttack', 'vcfDefense', 'parry', 'parry3', 'parry4'];
  for (const v of R.VERSIONS)
    BG.util.assert(TIER.filter((k) => v.mech[k]).length === LAYERS[v.id],
      v.id + ' 接管层数应为 ' + LAYERS[v.id] + '，实际 ' + TIER.filter((k) => v.mech[k]).length);
  /* 棋谱归属（棋谱 exported 落库时刻换算北京时间 + moves[].tactics 标签实证；防改错） */
  BG.util.assert(R.resolve('v0-off').games === 0 && R.resolve('v1-facts').games === 0, 'v0/v1 应无归档棋谱');
  BG.util.assert(R.resolve('v5-safesort').games === 21, 'v5 窗口应归档 21 局（9/29 17:51–19:28，parry3 标签实证）');
  BG.util.assert(R.resolve('v7-vcf').games === 4, 'v7 应归档 4 局（exp-20260930025135，vcf 标签实证）');
  BG.util.assert(R.resolve('v8-vcf-try').games === 3, 'v8 应归档 3 局（线上旧引擎）');
  BG.util.assert(R.resolve('v9-vcf-sound').games === 0, 'v9 刚修完应无归档棋谱');
  BG.util.assert(R.VERSIONS.reduce((a, v) => a + v.games, 0) === 28, 'games 字段合计应等于 games/ 现有 28 局');
  /* 解析：空→当前档；未知 id→当前档（写错档号静默回退，不抛错） */
  BG.util.assert(R.resolve(null).id === R.CURRENT && R.resolve('').id === R.CURRENT, '空 id 应回退当前档');
  BG.util.assert(R.resolve('v10-nope').id === R.CURRENT, '未知 id 应回退当前档，实际 ' + R.resolve('v10-nope').id);
  BG.util.assert(R.resolve('v3-make2').id === 'v3-make2', '已知 id 应原样返回');
  /* 闸门 */
  BG.util.assert(R.allows(R.resolve('v1-facts'), 'win') === true, 'v1 应有 win');
  BG.util.assert(R.allows(R.resolve('v1-facts'), 'open4') === false, 'v1 不应有 open4');
  BG.util.assert(R.allows(R.resolve('v0-off'), 'win') === false, 'v0 无任何机制');
  BG.util.assert(R.allows(R.resolve('v7-vcf'), 'vcfDefense') === true, 'v7 应有 vcfDefense');
  BG.util.assert(R.allows(R.resolve('v7-vcf'), 'vcfTry') === false && R.allows(R.resolve('v8-vcf-try'), 'vcfTry') === true,
    'vcfTry（逐点试干预）应是 v8 才有');
  BG.util.assert(R.allows(R.resolve('v8-vcf-try'), 'sound') === false && R.allows(R.resolve('v9-vcf-sound'), 'sound') === true,
    'sound（引擎伪胜闸门）应是 v9 才有');
  const V0 = R.resolve('v0-off');
  BG.util.assert(!MECHS.some((k) => V0.mech[k]), 'v0-off 必须全 false（纯概率基线）');
  /* selfTest 自带登记表自检（页面内「战术沿革条」渲染失败时会在控制台报） */
  R.selfTest();
}

try {
  tacticsRegistryTests();
  results.push('✓ 战术版本登记表（9 档机制阶梯 + 基线）');
} catch (e) {
  failed++;
  results.push('✗ 战术版本登记表: ' + e.message);
}

/* 单元：对阵联名与棋谱 slug（战绩簿 / 实验报告 / 服务端文件名共用同一套命名） */
function duelTests() {
  const D = globalThis.BG.duel;
  BG.util.assert(D, 'BG.duel 应存在（需先加载 js/duel.js）');
  /* 单边展示名 */
  BG.util.assert(D.sideLabel({ human: true }) === '我', '人类侧应显示「我」');
  BG.util.assert(D.sideLabel({ channel: 'mock' }) === '演示', 'mock 应显示「演示」');
  BG.util.assert(D.sideLabel({ channel: 'proxy' }) === 'Jev·v9', 'Jev 渠道应带战术版本短号，实际 ' + D.sideLabel({ channel: 'proxy' }));
  BG.util.assert(D.sideLabel({ channel: 'random', tactics: 'v4-parry3' }) === '随机·v4', '随机渠道也应带版本，实际 ' + D.sideLabel({ channel: 'random', tactics: 'v4-parry3' }));
  BG.util.assert(D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 3000 }) === 'Rapfi(3s)', 'Rapfi 应带思考时长，实际 ' + D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 3000 }));
  BG.util.assert(D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 500 }) === 'Rapfi(0.5s)', '0.5s 档应显示 0.5s，实际 ' + D.sideLabel({ channel: 'rapfi', rapfiThinkMs: 500 }));
  /* 联名 / 战绩簿 / 实验标签 */
  BG.util.assert(D.duelLabel({ channel: 'proxy' }, { channel: 'rapfi', rapfiThinkMs: 5000 }) === '黑 Jev·v9 vs 白 Rapfi(5s)',
    '联名格式不对：' + D.duelLabel({ channel: 'proxy' }, { channel: 'rapfi', rapfiThinkMs: 5000 }));
  BG.util.assert(D.gameLabel('五子棋', 'human', { human: true }, { channel: 'proxy' }) === '五子棋 · 人机 · 黑 我 vs 白 Jev·v9',
    '战绩簿名不对：' + D.gameLabel('五子棋', 'human', { human: true }, { channel: 'proxy' }));
  BG.util.assert(D.expLabel({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' }, 4) === 'Jev·v9 vs 随机·v3 ×4局',
    '实验标签不对：' + D.expLabel({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' }, 4));
  /* slug：小写、只留 [a-z0-9-]、压连续分隔符、注入字符必须被清掉、≤24 */
  const s = D.slug({ channel: 'random', tactics: 'v3-make2' }, { channel: 'proxy' });
  BG.util.assert(s === 'ran-v3-vs-jev-v9', 'slug 不对：' + s);
  BG.util.assert(!/[^a-z0-9_-]/.test(s) && s.length <= 24, 'slug 必须只含安全字符且 ≤24：' + s);
  const inject = D.slug({ channel: 'proxy', tactics: '../../etc/pa' }, { channel: 'mock' });
  BG.util.assert(inject.indexOf('/') < 0 && inject.indexOf('.') < 0, '路径注入必须被清掉：' + inject);
  /* 空配置不得产出空 slug */
  BG.util.assert(D.slug({}, {}).length > 0, '空配置也应有兜底 slug');
  D.selfTest();
}

try {
  duelTests();
  results.push('✓ 对阵联名与棋谱 slug');
} catch (e) {
  failed++;
  results.push('✗ 对阵联名与棋谱 slug: ' + e.message);
}

/* 单元：战术档位在应用层的贯通（设置抽屉 → decide → 实验两侧 → 棋谱导出）
 * 这些断言全是静态文本：app.js 是 DOM 闭包，测试里不加载，只能锁源码结构。 */
function tacticsUiTests() {
  const A = BG.util.assert;
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  const R = globalThis.BG.tacticsVersions;
  A(R && R.VERSIONS, 'BG.tacticsVersions 应存在（需先加载 js/tactics-versions.js）');
  /* 控件本体：缺一个就等于该层归因断链 */
  A(html.indexOf('id="tacticsVersion"') >= 0, 'index.html 应有战术档下拉 #tacticsVersion');
  A(html.indexOf('id="expTacA"') >= 0 && html.indexOf('id="expTacB"') >= 0,
    '实验面板应有 A/B 战术档下拉 #expTacA/#expTacB');
  /* 十个档位一个不能少：漏档 = 该层实验做不了（档位清单归 tactics-versions.js 管，
     应用层只负责原样落到 index.html 的 value 上） */
  R.VERSIONS.forEach((v) => {
    A(html.indexOf('value="' + v.id + '"') >= 0, '战术档位 ' + v.id + ' 未出现在 index.html');
  });
  /* 应用层不做档位白名单，但必须经 resolve 归一：localStorage 里的脏 id 不得流进 decide */
  A(/tacticsVersions\.resolve\(/.test(src), 'load/save 战术档应经 BG.tacticsVersions.resolve 归一');
  /* 设置抽屉：默认值 + 读 + 写 + 显隐规则（mock/rapfi 不读战术层，必须藏） */
  A(/tacticsVersion:\s*'v9-vcf-sound'/.test(src), 'S.settings 应带 tacticsVersion 默认当前档');
  A(/\$\('tacticsVersion'\)\.value\s*=[\s\S]{0,80}\.resolve\(/.test(src), 'loadSettings 应回填战术档');
  A(/S\.settings\.tacticsVersion\s*=[\s\S]{0,80}\.resolve\(/.test(src), 'saveSettings 应保存战术档');
  A(/tacticsVersionLabel'\)\.classList\.toggle\('hidden'/.test(src), 'syncChannelUI 应控制战术档显隐');
  /* decide 透传 + 实验两侧记录 + 棋谱导出带版本 */
  A(/tacticsVersion:\s*eff\.tactics/.test(src), 'decide opts 应透传本手战术档（effSide 归一后）');
  A(/S\.settings\.sideConfig\s*=\s*\{\s*black:/.test(src), '实验应按执子侧写 sideConfig（A/B 交替先后）');
  A(/blackTactics/.test(src) && /whiteTactics/.test(src), '棋谱导出应记双方战术档');
}
try {
  tacticsUiTests();
  results.push('✓ 战术档位应用层贯通（设置/实验/棋谱）');
} catch (e) {
  failed++;
  results.push('✗ 战术档位应用层贯通: ' + e.message);
}

/* 单元：全局设置抽屉 + 侧栏三页签「对局/实验/数据」的 DOM 契约
 * R3/R5/R6 的控件若被误删/改名，应用层会在浏览器里静默失灵（Node 测不到 DOM），
 * 所以在这里锁 index.html 结构；#tacticsStrip / #swapBtn 由 Task 5.1 / 4.2 各自补断言。 */
function domContractTests() {
  const A = BG.util.assert;
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  /* id 唯一：重复 id 会让 $() 只取到第一个，另一处控件静默失效 */
  const ids = [];
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.push(m[1]);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  A(dup.length === 0, 'index.html 存在重复 id：' + dup.join(','));
  /* 抽屉四件套 + 齿轮 */
  for (const id of ['settingsGear', 'settingsDrawer', 'drawerMask', 'drawerClose', 'drawerBody'])
    A(html.indexOf('id="' + id + '"') >= 0, 'index.html 缺控件 #' + id);
  /* 三页签契约：对局/实验/数据（实验必须独立成栏，不复刻设置嵌套） */
  for (const p of ['play', 'exp', 'data'])
    A(html.indexOf('data-pane="' + p + '"') >= 0, '侧栏应含页签 ' + p);
  A(html.indexOf('id="pane-exp"') >= 0, '应有独立 pane-exp');
  A(html.indexOf('id="pane-settings"') < 0, 'pane-settings 应改名为 pane-exp（设置已搬迁）');
  /* Rapfi 时长控件常驻抽屉：不得再被 hidden 条件隐藏 */
  const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  const label = html.indexOf('id="rapfiThinkLabel"');
  A(label >= 0, 'Rapfi 思考时长控件应存在');
  A(!/rapfiThinkLabel'\)\.classList\.toggle\('hidden'/.test(app),
    'rapfiThinkLabel 不应再按渠道隐藏（抽屉内常显）');
  A(!/class="hidden"\s*>\s*Rapfi 思考时长/.test(html), 'rapfiThinkLabel 不应再带初始 hidden');
}
try {
  domContractTests();
  results.push('✓ DOM 契约（设置抽屉 / 三页签 / Rapfi 时长常显）');
} catch (e) {
  failed++;
  results.push('✗ DOM 契约: ' + e.message);
}

/* 单元：双方配置归一化（sideConfig）+ 联名端到端
 * app.js 依赖 DOM，Node 侧进不去；这里把它 effSide 的语义复刻成纯函数钉死契约，
 * 再用静态断言确认 js/app.js 里的 effSide/联名字段真的接上了同一套解析。 */
function sideConfigTests() {
  const A = BG.util.assert;
  const R = globalThis.BG.tacticsVersions, D = globalThis.BG.duel;
  /* 缺省继承：空覆盖 → 全局值（与 js/app.js effSide 逐字同义） */
  const eff = (side, settings, sideConfig) => {
    const c = (sideConfig && sideConfig[side]) || {};
    return {
      channel: c.channel || settings.channel,
      tactics: R.resolve(c.tactics || settings.tacticsVersion).id,
      rapfiThinkMs: c.rapfiThinkMs || settings.rapfiThinkMs,
    };
  };
  const base = { channel: 'proxy', tacticsVersion: 'v9-vcf-sound', rapfiThinkMs: 3000 };
  const inherit = eff('black', base, { black: {}, white: {} });
  A(inherit.channel === 'proxy' && inherit.tactics === 'v9-vcf-sound' && inherit.rapfiThinkMs === 3000,
    '空覆盖应继承全局，实际：' + JSON.stringify(inherit));
  const over = eff('white', base, { white: { channel: 'rapfi', tactics: 'v3-make2', rapfiThinkMs: 500 } });
  A(over.channel === 'rapfi' && over.tactics === 'v3-make2' && over.rapfiThinkMs === 500,
    '覆盖应生效，实际：' + JSON.stringify(over));
  A(eff('black', base, { white: { channel: 'rapfi' } }).channel === 'proxy', '不得串到另一边');
  A(eff('black', base, { black: { tactics: 'v77' } }).tactics === 'v9-vcf-sound', '错档号应回退当前档');
  /* 联名端到端：人机（我 vs Jev·v9）与实验（Jev·v9 vs 随机·v3） */
  const humanDuel = D.gameLabel('五子棋', 'human-ai', { human: true, channel: 'proxy' }, { channel: 'proxy' });
  A(humanDuel === '五子棋 · 人机 · 黑 我 vs 白 Jev·v9', '人机联名不对：' + humanDuel);
  const expDuel = D.expLabel({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' }, 4);
  A(expDuel === 'Jev·v9 vs 随机·v3 ×4局', '实验联名不对：' + expDuel);
  const s = D.slug({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' });
  A(s === 'jev-v9-vs-ran-v3', '实验 slug 不对：' + s);
  /* 静态接线：app.js 必须真的有 sideConfig/effSide，且 decide/导出/战绩簿消费它 */
  const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  A(/sideConfig:\s*\{\s*black:\s*\{\},\s*white:\s*\{\}\s*\}/.test(app), 'settings 默认应有 sideConfig');
  A(/function effectiveChannelOf\(/.test(app), '应有 effectiveChannelOf(ch)');
  A(/function effSide\(/.test(app), '应有 effSide(side)');
  A(/function sideIdOf\(/.test(app), '应有 sideIdOf(side)');
  A(/const eff = effSide\(sideIdOf\(side\)\)/.test(app), 'scheduleAI 应按执子侧取 effSide');
  A(/tacticsVersion: eff\.tactics/.test(app), 'decide 应传 eff.tactics');
  A(/rapfiThinkMs: eff\.rapfiThinkMs/.test(app), 'decide 应传 eff.rapfiThinkMs');
  A(/slug:\s*BG\.duel\.slug\(/.test(app), '导出应带 duel.slug');
  A(/duel:\s*BG\.duel\.duelLabel\(/.test(app), '导出应带 duel 联名');
  A(/const duel = r\.duel\s*\?/.test(app), '战绩簿应显示联名列（旧数据有兜底）');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const id of ['sideCfgBlack', 'sideCfgWhite'])
    A(html.indexOf('id="' + id + '"') >= 0, 'index.html 缺双方覆盖区 #' + id);
  for (const id of ['blackChannel', 'blackTactics', 'blackThinkMs', 'whiteChannel', 'whiteTactics', 'whiteThinkMs'])
    A(html.indexOf('id="' + id + '"') >= 0, 'index.html 缺双方覆盖控件 #' + id);
  for (const id of ['expTacA', 'expTacB', 'expThinkA', 'expThinkB'])
    A(html.indexOf('id="' + id + '"') >= 0, 'index.html 缺实验 A/B 档位控件 #' + id);
}
try {
  sideConfigTests();
  results.push('✓ 双方配置与联名（sideConfig / effSide / 联名归档）');
} catch (e) {
  failed++;
  results.push('✗ 双方配置与联名: ' + e.message);
}

/* 单元：换边中断的终局语义（winner:null + reason:'换边中断' = 未终局，不是和棋）
 * 与 app.finishGame/resTxt/calSamples 的判定保持一致；三处判定任何一处漂移，
 * 战绩簿就会把「未终局」错记成和棋、先手胜率被未终局污染。 */
function swapRestartTests() {
  const A = BG.util.assert;
  const resOf = (winner, reason) => ({
    winner, reason,
    text: winner ? (winner === 'black' ? '黑胜' : '白胜') : (reason === '换边中断' ? '未终局' : '和棋'),
    isDraw: !winner && reason !== '换边中断',
  });
  const r = resOf(null, '换边中断');
  A(r.text === '未终局' && r.isDraw === false, '换边中断应记未终局，实际：' + r.text);
  A(resOf(null, '棋盘已满').text === '和棋' && resOf(null, '棋盘已满').isDraw === true, '真和棋不得被误判为未终局');
  A(resOf('black', '五连').text === '黑胜', '正常胜负文案');
  /* 校准：未终局不得进入先手胜率统计 */
  const firstWin = (games) => {
    const done = games.filter((g) => g.result && g.result.winner);
    const w = done.filter((g) => g.result.winner === g.sides[0]).length; // 简化：先手指纹由调用方给
    return done.length ? w / done.length : null;
  };
  const mkG = (winner, reason) => ({ result: { winner, reason }, sides: ['black', 'white'] });
  A(firstWin([mkG(null, '换边中断')]) === null, '未终局不得计入校准');
  A(firstWin([mkG('black'), mkG(null, '换边中断')]) === 1, '未终局应被剔除');
  /* 接线：按钮只有人机模式且已落子才出现；swapSidesAndRestart 非人机直接 return */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  A(html.indexOf('id="swapBtn"') >= 0, 'index.html 缺换边重开按钮 #swapBtn');
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  A(/function swapSidesAndRestart\(\)/.test(app), 'app.js 应有 swapSidesAndRestart');
  A(/if \(S\.mode !== 'human-ai'\) return;/.test(app), '换边重开只对人机生效');
  A(/finishGame\(\{ winner: null, reason: '换边中断' \}\)/.test(app), '原局应按未终局记账');
  A(/reason === '换边中断'\)?\s*\?\s*'未终局'/.test(app), '终局文案应区分未终局与和棋');
  A(/swapBtn/.test(app) && /addEventListener\('click', swapSidesAndRestart\)|\.onclick = swapSidesAndRestart/.test(app), '应绑定换边重开按钮');
}
try {
  swapRestartTests();
  results.push('✓ 换边重开契约（未终局语义 + 显隐 + 绑定）');
} catch (e) {
  failed++;
  results.push('✗ 换边重开契约: ' + e.message);
}

/* 单元：战术沿革条的渲染数据（当前档唯一高亮、在用档标出、点击只改全局默认档）
 * app.js 闭包内不可直接调用 renderTacticsStrip，这里复刻它的纯函数部分钉契约；
 * 另外静态锁 index.html 容器与「点沿革条不得改 sideConfig」的调用顺序。 */
function tacticsStripTests() {
  const A = BG.util.assert;
  const R = globalThis.BG.tacticsVersions;
  const render = (settings, inUse) => R.VERSIONS.map((v) => ({
    id: v.id, cur: settings.tacticsVersion === v.id, used: inUse.indexOf(v.id) >= 0,
  }));
  const chips = render({ tacticsVersion: 'v4-parry3' }, ['v9-vcf-sound', 'v4-parry3']);
  A(chips.length === 10, '应渲染 10 枚（9 档战术版本 + 无战术基线），实际 ' + chips.length);
  A(chips.filter((c) => c.cur).length === 1 && chips.find((c) => c.cur).id === 'v4-parry3', '当前档应唯一高亮');
  A(chips.filter((c) => c.used).length === 2, '在用档应被标出');
  /* 点击只改全局默认档，不得顺手改动双方覆盖 */
  const next = (s, id) => Object.assign({}, s, { tacticsVersion: id });
  const after = next({ tacticsVersion: 'v4-parry3', sideConfig: { black: { tactics: 'v1-facts' } } }, 'v6-parry4');
  A(after.tacticsVersion === 'v6-parry4' && after.sideConfig.black.tactics === 'v1-facts', '点沿革条不得改覆盖配置');
  /* 接线：容器存在、渲染函数存在、点击写的是 S.settings.tacticsVersion */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  A(html.indexOf('id="tacticsStrip"') >= 0, 'index.html 缺战术沿革条容器 #tacticsStrip');
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  A(/function renderTacticsStrip\(\)/.test(app), 'app.js 应有 renderTacticsStrip');
  A(/S\.settings\.tacticsVersion = v\.id;/.test(app), '点沿革条应改全局默认档');
  A(/renderTacticsStrip\(\)/.test(app) && (app.match(/renderTacticsStrip\(\)/g) || []).length >= 2, '点击后与开局后都应刷新沿革条');
}
try {
  tacticsStripTests();
  results.push('✓ 战术沿革条契约（10 枚 / 当前档唯一 / 只改默认档）');
} catch (e) {
  failed++;
  results.push('✗ 战术沿革条契约: ' + e.message);
}

/* 集成：mock AI 机机对弈完整一盘；同 seed 两次结果必须完全一致 */
async function playOut(gid) {
  BG.setSeed(42); // 每个棋种从同一 seed 起跑，保证可复现
  const e = globalThis.BG.games[gid];
  let st = e.newGame();
  let plies = 0;
  const notations = [];
  while (!e.getStatus(st).over && plies < 600) {
    const d = await globalThis.BG.jev.decide(e, st, st.turn, { channel: 'mock', topK: 3 });
    if (!d.move || !e.getLegalMoves(st).some((m) => m.notation === d.move.notation)) {
      throw new Error(gid + ' 第 ' + plies + ' 步返回非法着法 ' + d.notation);
    }
    st = e.applyMove(st, d.move);
    notations.push(d.move.notation);
    plies++;
  }
  const g = e.getStatus(st);
  if (!g.over) throw new Error(gid + ' ' + plies + ' 步未终局（疑似死循环）');

  /* 记法重放护栏：app.js 的悔棋已改为「history 只存记法 + 从 newGame 重放」，
   * 因此「整盘只用 notation 走一遍」必须得到与逐步 applyMove 完全一致的终局状态。
   * 这是该改动唯一但关键的正确性前提（依据：docs/engine-interface.md §2 记法往返硬契约）。
   * 任何引擎的 notation 不可逆，这里会立刻红——那说明引擎违约，应改引擎而非回退方案。 */
  let replay = e.newGame();
  for (const n of notations) {
    const m = e.moveFromNotation(replay, n);
    if (!m) throw new Error(gid + ' 记法重放失败于 ' + n + '（moveFromNotation 返回 null）');
    replay = e.applyMove(replay, m);
  }
  BG.util.assert(
    JSON.stringify(replay) === JSON.stringify(st),
    gid + ' 记法重放后的终局状态与逐步下棋不一致（悔棋还原会出错）');
  BG.util.assert(
    JSON.stringify(e.getStatus(replay)) === JSON.stringify(g),
    gid + ' 记法重放后的终局判定与原对局不一致');

  return e.name + '：' + plies + ' 步终局，胜者=' + (g.winner || '和') + '，' + g.reason + '|' + notations.join(',');
}

async function integration() {
  eval(fs.readFileSync(path.join(ROOT, 'js/mock-ai.js'), 'utf8'));
  eval(fs.readFileSync(path.join(ROOT, 'js/jev-client.js'), 'utf8'));
  eval(fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8'));
  /* api.js 契约：挂载 BG.api 且七个方法齐全。
   * 降级路径（file:// 下 fetch 失败返回 null）只在浏览器端发生，Node 侧验形状。 */
  ['health', 'saveGame', 'listGames', 'getGame', 'saveExperiment', 'listExperiments', 'stats']
    .forEach((m) => BG.util.assert(typeof BG.api[m] === 'function', 'BG.api.' + m + ' 缺失'));
  for (const gid of ['gomoku', 'cc', 'go']) {
    const summary = await playOut(gid);
    results.push('✓ 集成 ' + summary);
    const again = await playOut(gid);
    BG.util.assert(summary === again, gid + ' 同 seed 复现失败：' + summary + ' ≠ ' + again);
    results.push('✓ 复现 ' + gid + '（seed=42 两次一致）');
  }
}

/* 单元：jev-client 的重试 / 401 / 非法着法回退 / topK 解析回归 */
async function jevClientTests() {
  eval(fs.readFileSync(path.join(ROOT, 'js/jev-client.js'), 'utf8')); // 挂 BG.jev（幂等）
  const e = globalThis.BG.games.gomoku;
  const st = e.newGame();
  const legal = e.getLegalMoves(st);
  const realFetch = globalThis.fetch;
  const mk = (status, obj) => new Response(JSON.stringify(obj), { status });
  const withFetch = async (impl, fn) => {
    globalThis.fetch = impl;
    try { return await fn(); } finally { globalThis.fetch = realFetch; }
  };
  /* 响应里只给非法选项 ZZZ → 命中回退分支 */
  const okBody = { model: 'jev-latest', usage: { input_tokens: 100, output_tokens: 0 },
    answers: { move: { probabilities: { ZZZ: 0.9 } } } };

  /* ① 429 → 200：退避重试一次后成功，且落入合法着法回退（真实 sleep 约 1s，可接受） */
  let calls = 0;
  const d1 = await withFetch(
    async () => (++calls === 1 ? mk(429, { error: 'slow down' }) : mk(200, okBody)),
    () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 3 })
  );
  BG.util.assert(calls === 2, '429 后应重试一次，实际调用 ' + calls + ' 次');
  BG.util.assert(d1.notation === legal[0].notation, '无合法选项应回退到 legal[0]');
  /* 回退分支应原样返回 legal[0] 这个着法；decide() 内部自取 legal，跨边界无法比引用，用深比较 */
  BG.util.assert(JSON.stringify(d1.move) === JSON.stringify(legal[0]), '回退返回的 move 应为 legal[0] 对象本身');
  BG.util.assert(d1.meta.warning === '响应中无合法选项，已回退到首个合法着法', 'warning 文案应为更新后的版本，实际：' + d1.meta.warning);

  /* ② 401：立即抛错，绝不重试 */
  calls = 0;
  let err = null;
  try {
    await withFetch(
      async () => { calls++; return mk(401, { error: 'bad key' }); },
      () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 1 })
    );
  } catch (e2) { err = e2; }
  BG.util.assert(err && /401/.test(err.message), '401 应抛出含 401 的错误，实际：' + (err && err.message));
  BG.util.assert(calls === 1, '401 不应重试，实际调用 ' + calls + ' 次');

  /* ③ topK 端到端回归：topK=2 时第 3、4 名永不被选；topK=1 时恒为最高概率项。
     注意：不能用"临摹表达式的断言"——那测的是测试文件自己，测不到生产代码。 */
  const fourLegal = { H8: 0.5, H9: 0.45, J8: 0.049, J9: 0.001 };
  const pickBody = { model: 'jev-latest', usage: { input_tokens: 100, output_tokens: 0 },
    answers: { move: { probabilities: fourLegal } } };
  const seen2 = {};
  for (let i = 0; i < 200; i++) {
    const d = await withFetch(async () => mk(200, pickBody),
      () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 2 }));
    seen2[d.notation] = (seen2[d.notation] || 0) + 1;
  }
  BG.util.assert(!seen2.J8 && !seen2.J9, 'topK=2 时第 3、4 名不应被选，实际：' + JSON.stringify(seen2));
  BG.util.assert(seen2.H8 && seen2.H9, 'topK=2 应只在前 2 名中抽样，实际：' + JSON.stringify(seen2));
  const argmax = await withFetch(async () => mk(200, pickBody),
    () => BG.jev.decide(e, st, st.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(argmax.notation === 'H8', 'topK=1 应恒选最高概率项 H8，实际：' + argmax.notation);

  /* ④ 自定义端点回归：opts.endpoint 覆盖渠道预设；未填 key 时自定义端点放行（自建网关可匿名），
     预设端点不受影响（无 key 仍拒绝、有 key 照发预设地址） */
  let hitUrl = null;
  const spyFetch = async (url) => { hitUrl = String(url); return mk(200, okBody); };
  const d4 = await withFetch(spyFetch, () => BG.jev.decide(e, st, st.turn, {
    channel: 'official', endpoint: 'http://127.0.0.1:9000/custom/systemone', topK: 1,
  }));
  BG.util.assert(hitUrl === 'http://127.0.0.1:9000/custom/systemone', '自定义端点应覆盖预设，实际：' + hitUrl);
  BG.util.assert(d4.notation === legal[0].notation, '自定义端点下非法响应同样应回退 legal[0]');
  err = null;
  try {
    await withFetch(spyFetch, () => BG.jev.decide(e, st, st.turn, { channel: 'official', topK: 1 }));
  } catch (e3) { err = e3; }
  BG.util.assert(err && /API Key/.test(err.message), '预设官方端点无 key 仍应拒绝，实际：' + (err && err.message));
  await withFetch(spyFetch, () => BG.jev.decide(e, st, st.turn, { channel: 'official', apiKey: 'k', topK: 1 }));
  BG.util.assert(hitUrl === 'https://api.typesafe.ai/v1/systemone', '预设端点不受 opts.endpoint 缺省影响，实际：' + hitUrl);
  BG.util.assert(typeof BG.jev.presetEndpoint('openrouter') === 'string' && /openrouter\.ai/.test(BG.jev.presetEndpoint('openrouter')),
    'presetEndpoint 应返回渠道预设地址');

  /* ⑤ probe 连通性探测：ok / auth / http / cors / network / shape 六种判定。
     no-cors GET 段与 cors POST 段都打到同一 mock fetch，按 init.mode 区分。 */
  const probeBody = { model: 'jev-latest', answers: { probe: { noul: 0.5 } } };
  const doProbe = (impl) => withFetch(impl,
    () => BG.jev.probe({ channel: 'official', apiKey: 'k', endpoint: 'https://x.example/v1/systemone' }));
  const reachOK = async () => new Response('ok');
  let probeSent = null;
  let pr = await doProbe(async (url, init) => {
    if (init && init.mode === 'no-cors') return reachOK();
    probeSent = JSON.parse(init.body);
    return mk(200, probeBody);
  });
  BG.util.assert(pr.ok === true && pr.kind === 'ok' && typeof pr.latencyMs === 'number', 'probe 200+answers 应判 ok，实际：' + JSON.stringify(pr));
  BG.util.assert(probeSent.model === 'jev-latest' && probeSent.questions.probe.type === 'noul' && probeSent.state,
    'probe 请求体必须含 state/model/questions（真实端点 422 教训），实际：' + JSON.stringify(probeSent));
  pr = await doProbe(async (url, init) => (init && init.mode === 'no-cors' ? reachOK() : mk(401, { error: 'bad key' })));
  BG.util.assert(!pr.ok && pr.kind === 'auth', 'probe 401 应判 auth，实际：' + pr.kind);
  pr = await doProbe(async (url, init) => (init && init.mode === 'no-cors' ? reachOK() : mk(500, 'boom')));
  BG.util.assert(!pr.ok && pr.kind === 'http' && pr.status === 500, 'probe 500 应判 http，实际：' + pr.kind);
  pr = await doProbe(async (url, init) => {
    if (init && init.mode === 'no-cors') return reachOK();
    throw new TypeError('Failed to fetch');
  });
  BG.util.assert(!pr.ok && pr.kind === 'cors', 'probe「可达但 POST 被 TypeError」应判 cors，实际：' + pr.kind);
  pr = await doProbe(async () => { throw new TypeError('getaddrinfo ENOTFOUND'); });
  BG.util.assert(!pr.ok && pr.kind === 'network', 'probe「no-cors 也失败」应判 network，实际：' + pr.kind);
  pr = await doProbe(async (url, init) => (init && init.mode === 'no-cors' ? reachOK() : mk(200, { openai: true })));
  BG.util.assert(!pr.ok && pr.kind === 'shape', 'probe 200 但缺 answers 应判 shape，实际：' + pr.kind);
  pr = await BG.jev.probe({ channel: 'mock' });
  BG.util.assert(pr.ok === true && pr.kind === 'mock', 'probe mock 应直接返回 mock 判定');

  /* ⑥ 战术事实：黑四连且轮黑走 → G8/L8 双成五点；换白方视角 → 同两点为必挡点。 */
  let stx = e.newGame();
  for (const n of ['H8', 'A1', 'I8', 'C2', 'J8', 'E3', 'K8', 'G5']) stx = e.applyMove(stx, e.moveFromNotation(stx, n));
  const tacMe = BG.jev.computeTactics(e, stx, e.getLegalMoves(stx));
  BG.util.assert(tacMe.winning_points_you.indexOf('G8') >= 0 && tacMe.winning_points_you.indexOf('L8') >= 0,
    '黑四连应识别出 G8/L8 致胜点，实际：' + JSON.stringify(tacMe));
  BG.util.assert(tacMe.winning_points_opponent.length === 0, '白只有三子，不应有必挡点');
  const stxW = BG.util.clone(stx);
  stxW.turn = 'white';
  const tacOpp = BG.jev.computeTactics(e, stxW, e.getLegalMoves(stxW));
  BG.util.assert(tacOpp.winning_points_you.length === 0 && tacOpp.winning_points_opponent.indexOf('G8') >= 0,
    '白方视角下黑四连点应为必挡点，实际：' + JSON.stringify(tacOpp));

  /* ⑥b 提示词板斧：board_ascii 裁剪/图例/末手小写 + 指令含刚性扫描清单与防幻觉核对。 */
  const ser9 = e.serializeForJev(stx, stx.turn);
  const asc = ser9.state.board_ascii;
  BG.util.assert(typeof asc === 'string' && asc.split('\n').length >= 5, 'board_ascii 应为多行棋盘');
  BG.util.assert(asc.indexOf('X') >= 0 && asc.indexOf('O') >= 0, '棋盘应含黑白子字符 X/O');
  const row8 = asc.split('\n').find((l) => l.startsWith(' 8'));
  BG.util.assert(row8 && row8.indexOf('X') >= 0 && row8.indexOf('x') < 0, '非末手黑子应为大写 X，实际该行：' + row8);
  const row5 = asc.split('\n').find((l) => l.startsWith(' 5'));
  BG.util.assert(row5 && row5.indexOf('o') >= 0, '末手 G5（白）应以小写 o 标记，实际该行：' + row5);
  BG.util.assert(asc.split('\n').some((l) => l.startsWith(' 1')), '白子 A1 在边缘时应裁剪到行 1（外扩 2 格收敛）');
  const ins = ser9.questions.move.instructions;
  BG.util.assert(/scan in order/.test(ins) && /cell by cell/.test(ins) && /board_ascii/.test(ins),
    'move 指令应含刚性扫描清单与防幻觉核对要求');
  const ascEmpty = e.serializeForJev(e.newGame(), 'black').state.board_ascii;
  BG.util.assert(ascEmpty.split('\n').length === 6 && /H/.test(ascEmpty), '空盘应裁剪为天元附近 5×5');

  /* ⑥c 战术标签：黑活三 F8G8H8 vs 白活三 G7H7I7，黑行棋。
     I8 = 黑成活四（you:open4）；F7/J7 = 白活三的成活四点（deny:open4）；静点无标签。 */
  let stl = e.newGame();
  for (const n of ['F8', 'G7', 'G8', 'H7', 'H8', 'I7']) stl = e.applyMove(stl, e.moveFromNotation(stl, n));
  const crit = e.serializeForJev(stl, stl.turn).questions.move.criteria;
  BG.util.assert(/you:open4/.test(crit['I8']), '黑 I8 应标 you:open4（F8-I8 四、E8/J8 两成五点），实际：' + crit['I8']);
  BG.util.assert(/deny:open4/.test(crit['F7']), 'F7 应标 deny:open4（白占即活四），实际：' + crit['F7']);
  BG.util.assert(/deny:open4/.test(crit['J7']), 'J7 应标 deny:open4，实际：' + crit['J7']);
  const quiet = Object.entries(crit).filter(([k, v]) => v === null);
  BG.util.assert(quiet.length >= 1, '应存在无标签的静点候选');

  /* ⑥d 活四接管：黑有活四点（E8/I8）、双方无一步成五 → 概率偏向 G6 仍必走活四点。 */
  let sentL = null;
  const dL = await withFetch(async (url, init) => {
    sentL = JSON.parse(init.body);
    return mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
      answers: { move: { probabilities: { G6: 0.9 } } } });
  }, () => BG.jev.decide(e, stl, stl.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert((dL.notation === 'E8' || dL.notation === 'I8') && dL.meta.tactics === 'open4',
    '活四点应被第三级接管，实际：' + dL.notation + '/' + dL.meta.tactics);

  /* ⑦ 战术保险接管：概率偏向 G7 仍必须走致胜点；state/指令应含 tactics 语义。 */
  const guardBody = { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { G7: 0.9, G8: 0.05 } } } };
  let sent7 = null;
  const d7 = await withFetch(async (url, init) => { sent7 = JSON.parse(init.body); return mk(200, guardBody); },
    () => BG.jev.decide(e, stx, stx.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(d7.notation === 'G8' && d7.meta.tactics === 'win',
    '致胜点应被保险接管，实际：' + d7.notation + '/' + d7.meta.tactics);
  BG.util.assert(sent7.state.tactics && sent7.state.tactics.winning_points_you.length === 2,
    'state 应注入 tactics，实际：' + JSON.stringify(sent7.state.tactics));
  BG.util.assert(/winning_points_you/.test(sent7.questions.move.instructions), '指令应声明 tactics 语义');
  BG.util.assert(!/experience/.test(sent7.questions.move.instructions), '无经验时指令不应提 experience');

  /* ⑧ 经验注入：opts.experience 写进 state 并在指令中声明。 */
  const st0 = e.newGame();
  let sent8 = null;
  await withFetch(async (url, init) => { sent8 = JSON.parse(init.body); return mk(200, okBody); },
    () => BG.jev.decide(e, st0, st0.turn, { channel: 'proxy', topK: 1,
      experience: { opening_plies: 2, games: 3, first_player_win_rate: 0.67 } }));
  BG.util.assert(sent8.state.experience && sent8.state.experience.games === 3,
    'state 应注入 experience，实际：' + JSON.stringify(sent8.state.experience));
  BG.util.assert(/experience/.test(sent8.questions.move.instructions), '有经验时指令应声明其语义');

  /* ⑨ 2-ply 拆杀：黑 F7,F8,F9 单一开放三连、轮白走。
   * 1-ply 双方无致胜点（旧保险不触发）；danger_points_opponent 应为 F6/F10；
   * 概率偏向它着时仍须保险接管走拆杀点。 */
  let st9 = e.newGame();
  for (const n of ['F7','A1','F8','A2','F9']) st9 = e.applyMove(st9, e.moveFromNotation(st9, n));
  BG.util.assert(st9.turn === 'white', '应轮白走，实际：' + st9.turn);
  const cands9 = Object.keys(e.serializeForJev(st9, 'white').questions.move.criteria);
  const tac9 = BG.jev.computeTactics(e, st9, e.getLegalMoves(st9), cands9);
  BG.util.assert(tac9.winning_points_you.length === 0 && tac9.winning_points_opponent.length === 0,
    '该局面 1-ply 应无战术，实际：' + JSON.stringify(tac9));
  BG.util.assert(tac9.danger_points_opponent.indexOf('F6') >= 0 && tac9.danger_points_opponent.indexOf('F10') >= 0,
    '黑开放三连的拆杀点应含 F6/F10，实际：' + JSON.stringify(tac9.danger_points_opponent));
  const parryBody = { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { H8: 0.85, F6: 0.05 } } } };
  let sent9 = null;
  const d9 = await withFetch(async (url, init) => { sent9 = JSON.parse(init.body); return mk(200, parryBody); },
    () => BG.jev.decide(e, st9, st9.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert((d9.notation === 'F6' || d9.notation === 'F10') &&
    (d9.meta.tactics === 'parry' || d9.meta.tactics === 'vcfDefense'),
    '开放三连必须被保险拆杀（VCF 将一步活四识别为强制将死链时标签为 vcfDefense，优先级更高），实际：' +
    d9.notation + '/' + d9.meta.tactics);
  BG.util.assert(sent9.state.tactics.danger_points_opponent.length >= 2,
    'state.tactics 应含拆杀点，实际：' + JSON.stringify(sent9.state.tactics));
  BG.util.assert(/danger_points_opponent/.test(sent9.questions.move.instructions), '指令应声明拆杀语义');

  /* ⑨b 己方造杀：黑 F7,F8,F9 开放三连、轮黑走，F6/F10 任走其一即成开放四连双杀。 */
  let st9b = e.newGame();
  for (const n of ['F7','A1','F8','B2','F9','C3']) st9b = e.applyMove(st9b, e.moveFromNotation(st9b, n));
  BG.util.assert(st9b.turn === 'black', '应轮黑走，实际：' + st9b.turn);
  const cands9b = Object.keys(e.serializeForJev(st9b, 'black').questions.move.criteria);
  const tac9b = BG.jev.computeTactics(e, st9b, e.getLegalMoves(st9b), cands9b);
  BG.util.assert(tac9b.chance_points_you.indexOf('F6') >= 0 && tac9b.chance_points_you.indexOf('F10') >= 0,
    '己方开放三连的造杀点应含 F6/F10，实际：' + JSON.stringify(tac9b.chance_points_you));

  /* ⑨c 用户实战残局（第 24 手前）：黑除 F 三连外，E8 还藏着双杀
   * （E8,F9,G10,H11 对角四连 → D7/D8/I12 三个致胜点），故 danger 应含 E8/F6/F10/I12。
   * 注：该局面白已输定（两个独立杀招只能堵其一），保险能看清全部威胁但救不回已输的棋；
   * 2-ply 的价值在于更早的单一威胁局面。 */
  let st9c = e.newGame();
  for (const n of ['H8','H7','G8','I8','G9','G7','I7','J6','H9','I9','I10','H10','F7','E6','G10','J11','G11','G12','H11','E11','F9','E9','F8'])
    st9c = e.applyMove(st9c, e.moveFromNotation(st9c, n));
  const cands9c = Object.keys(e.serializeForJev(st9c, 'white').questions.move.criteria);
  const tac9c = BG.jev.computeTactics(e, st9c, e.getLegalMoves(st9c), cands9c);
  for (const n of ['E8','F6','F10','I12'])
    BG.util.assert(tac9c.danger_points_opponent.indexOf(n) >= 0,
      '实战残局拆杀点应含 ' + n + '，实际：' + JSON.stringify(tac9c.danger_points_opponent));

  /* ⑨d 用户实战败局（jev-gomoku-202609290843.json）第 20 手回归：danger 为空的自由手，
   * 此前走闲着 E6，被黑 E7 活三点 → 强制拆 → J8 双杀 → 输。parry3 层应抢先占
   * deny:open4/live3 点（E7/H10），不给黑造活三的先手。
   * 2026-09-30 VCF 上线后修正：VCF 发现黑有一条以 E6 为入口的真将死链
   * （E6→D5→D6→F6→E7，双杀 C4+H10），占住 E6 即破杀；且后续黑若走 E7，
   * 新层会继续 vcfDefense=D6 连贯防守。故 vcfDefense 优先于 parry3，接管到 E6。 */
  let st9d = e.newGame();
  for (const n of ['H8','H7','G8','I8','G6','G7','I7','I6','H6','G5','F7','H5','G9','J6','H9','I10','I9','F9','F8'])
    st9d = e.applyMove(st9d, e.moveFromNotation(st9d, n));
  BG.util.assert(st9d.turn === 'white', '应轮白走，实际：' + st9d.turn);
  const tac9d = BG.jev.computeTactics(e, st9d, e.getLegalMoves(st9d),
    Object.keys(e.serializeForJev(st9d, 'white').questions.move.criteria));
  BG.util.assert(tac9d.danger_points_opponent.length === 0,
    'p20 的 2-ply danger 应为空（败因是 3-ply 深度），实际：' + JSON.stringify(tac9d.danger_points_opponent));
  BG.util.assert(tac9d.vcf_win_opponent.indexOf('E6') >= 0,
    'p20 黑方 VCF 入口应为 E6，实际：' + JSON.stringify(tac9d.vcf_win_opponent));
  const d9d = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { E6: 0.9 } } } }),
    () => BG.jev.decide(e, st9d, st9d.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(d9d.notation === 'E6' && d9d.meta.tactics === 'vcfDefense',
    'p20 自由手应被 vcfDefense 预占 E6（破黑将死链入口），实际：' + d9d.notation + '/' + d9d.meta.tactics);

  /* ⑨e 用户实战败局（jev-gomoku-202609290924.json）第 18 手回归：danger=[I9,E9]
   * 两个双杀制造点并存，实战走 I9（Jev 偏好）→ 黑 E9 单杀逼杀 → 白被迫 D9 →
   * 黑 H12 对角成四 → 白 I13 只堵一端 → 黑 D8 获胜。安全排序应选 E9：
   * 白走 I9 后黑 E9 逼杀、白堵 D9 后黑仍有 H12 danger（持续攻击）；白走 E9 则无。 */
  let st9e = e.newGame();
  for (const n of ['H8','H7','G8','I8','H9','F7','G9','G7','I7','J6','F10','E11','G10','H10','G11','G12','F9'])
    st9e = e.applyMove(st9e, e.moveFromNotation(st9e, n));
  BG.util.assert(st9e.turn === 'white', '应轮白走，实际：' + st9e.turn);
  const tac9e = BG.jev.computeTactics(e, st9e, e.getLegalMoves(st9e),
    Object.keys(e.serializeForJev(st9e, 'white').questions.move.criteria));
  BG.util.assert(tac9e.danger_points_opponent.indexOf('I9') >= 0 && tac9e.danger_points_opponent.indexOf('E9') >= 0,
    'p18 danger 应含 I9,E9，实际：' + JSON.stringify(tac9e.danger_points_opponent));
  const d9e = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { I9: 0.9, E9: 0.1 } } } }),
    () => BG.jev.decide(e, st9e, st9e.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(d9e.notation === 'E9' && d9e.meta.tactics === 'parry',
    'p18 双 danger 并存应安全排序选 E9（Jev 偏向 I9 也应纠正），实际：' + d9e.notation + '/' + d9e.meta.tactics);

  /* ⑩ random 渠道回归：纯随机（均匀概率、零启发式）必须走完整战术管线——
   * 对方有一步杀时不能随机漏挡。黑 E5/F5/G5/H5 四连，白走必须堵 D5 或 I5。 */
  let stR = e.newGame();
  for (const n of ['E5','E6','F5','F6','G5','G6','H5'])
    stR = e.applyMove(stR, e.moveFromNotation(stR, n));
  BG.util.assert(stR.turn === 'white', '应轮白走，实际：' + stR.turn);
  const tacR = BG.jev.computeTactics(e, stR, e.getLegalMoves(stR),
    Object.keys(e.serializeForJev(stR, 'white').questions.move.criteria));
  BG.util.assert(tacR.winning_points_opponent.indexOf('D5') >= 0 && tacR.winning_points_opponent.indexOf('I5') >= 0,
    '对方一步杀点应含 D5,I5，实际：' + JSON.stringify(tacR.winning_points_opponent));
  const dR = await BG.jev.decide(e, stR, stR.turn, { channel: 'random', topK: 1 });
  BG.util.assert((dR.notation === 'D5' || dR.notation === 'I5') && dR.meta.tactics === 'block' && dR.meta.channel === 'random',
    'random 渠道面对一步杀必须战术接管堵杀，实际：' + dR.notation + '/' + dR.meta.tactics);

  /* ⑪ random 渠道真随机回归：空棋盘自由手，topK=1 也必须均匀采样——
   * 连续 20 次里至少出现 3 种不同着法（顺序走子只会永远走第一顺位） */
  const stEmpty = e.newGame();
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const d = await BG.jev.decide(e, stEmpty, stEmpty.turn, { channel: 'random', topK: 1 });
    BG.util.assert(!d.meta.tactics, '空棋盘不应有战术接管，实际：' + d.meta.tactics);
    seen.add(d.notation);
  }
  BG.util.assert(seen.size >= 3, 'random 渠道自由手应真随机（20 次≥3 种），实际只见：' + [...seen].join(','));

  /* ⑫ VCF 威胁空间搜索回归（连续冲四将死链）
   * 基准局面：黑 E7 F7 G7 H5 H6，白 D7 A1 A2 A3 B1，黑走。
   * 黑 H7 冲四（唯一致胜点 I7）→ 白被迫 I7 → 黑 H4 活四（H3/H8 双杀点）→ 将死。 */
  const vcfSeq = ['E7', 'D7', 'F7', 'A1', 'G7', 'A2', 'H5', 'A3', 'H6', 'B1']; // 10 手，轮黑走
  let st12a = e.newGame();
  for (const n of vcfSeq) st12a = e.applyMove(st12a, e.moveFromNotation(st12a, n));
  BG.util.assert(st12a.turn === 'black', '应轮黑走，实际：' + st12a.turn);

  /* ⑫a 棋盘级 vcfWin：黑有将死链，首步 H7 */
  const vcfA = e.vcfWin(st12a, 'black', 7);
  BG.util.assert(vcfA.win && vcfA.first === 'H7',
    '黑应有 VCF 将死链（首步 H7），实际：' + JSON.stringify(vcfA));

  /* ⑫b 进攻接入：tactics 给出 vcf_win_you；Jev 概率偏向别处也被接管 */
  const tac12b = BG.jev.computeTactics(e, st12a, e.getLegalMoves(st12a),
    Object.keys(e.serializeForJev(st12a, 'black').questions.move.criteria));
  BG.util.assert(tac12b.vcf_win_you.indexOf('H7') >= 0,
    'vcf_win_you 应含 H7，实际：' + JSON.stringify(tac12b.vcf_win_you));
  const d12b = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { E8: 0.9, H7: 0.05 } } } }),
    () => BG.jev.decide(e, st12a, st12a.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(d12b.notation === 'H7' && d12b.meta.tactics === 'vcfAttack',
    'Jev 偏向 E8 也应被 vcfAttack 接管到 H7，实际：' + d12b.notation + '/' + d12b.meta.tactics);

  /* ⑫c 防守：远端加一子把行棋方翻成白（不碰杀链区域），vcf_win_opponent 给出干预点 H7 */
  let st12c = e.newGame();
  for (const n of vcfSeq.concat(['O1'])) st12c = e.applyMove(st12c, e.moveFromNotation(st12c, n));
  BG.util.assert(st12c.turn === 'white', '应轮白走，实际：' + st12c.turn);
  const tac12c = BG.jev.computeTactics(e, st12c, e.getLegalMoves(st12c),
    Object.keys(e.serializeForJev(st12c, 'white').questions.move.criteria));
  BG.util.assert(tac12c.vcf_win_opponent.indexOf('H7') >= 0,
    'vcf_win_opponent 应含 H7 干预点，实际：' + JSON.stringify(tac12c.vcf_win_opponent));
  const d12c = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { A4: 0.9 } } } }),
    () => BG.jev.decide(e, st12c, st12c.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(d12c.notation === 'H7' && d12c.meta.tactics === 'vcfDefense',
    '白方面对黑 VCF 应提前抢占 H7，实际：' + d12c.notation + '/' + d12c.meta.tactics);

  /* ⑫d 无将死链的开局面不误接管 */
  let st12d = e.newGame();
  for (const n of ['H8', 'H7', 'J8']) st12d = e.applyMove(st12d, e.moveFromNotation(st12d, n));
  const tac12d = BG.jev.computeTactics(e, st12d, e.getLegalMoves(st12d),
    Object.keys(e.serializeForJev(st12d, st12d.turn).questions.move.criteria));
  BG.util.assert(tac12d.vcf_win_you.length === 0 && tac12d.vcf_win_opponent.length === 0,
    '开局无 VCF 时两字段应为空，实际：' + JSON.stringify([tac12d.vcf_win_you, tac12d.vcf_win_opponent]));

  /* ⑫e rapfi-base1 g4 第 34 手（白走）实战回归：实战 E12[parry3] 没破掉黑的将死链，
   * VCF 干预点 I14 能破杀；Jev 偏向 E12 也应被纠正到 I14。 */
  let st12e = e.newGame();
  for (const n of ['H8', 'G7', 'H7', 'H6', 'F8', 'G8', 'G6', 'I8', 'F7', 'H5', 'F9', 'F6', 'G5', 'G9', 'G10',
    'E8', 'H11', 'H10', 'I12', 'J13', 'F11', 'F10', 'G12', 'G11', 'H13', 'E10', 'G14', 'J11', 'E9', 'I10',
    'I9', 'H12', 'J14'])
    st12e = e.applyMove(st12e, e.moveFromNotation(st12e, n));
  BG.util.assert(st12e.turn === 'white', '应轮白走，实际：' + st12e.turn);
  const tac12e = BG.jev.computeTactics(e, st12e, e.getLegalMoves(st12e),
    Object.keys(e.serializeForJev(st12e, 'white').questions.move.criteria));
  BG.util.assert(tac12e.vcf_win_opponent.indexOf('I14') >= 0,
    'vcf_win_opponent 应含 I14，实际：' + JSON.stringify(tac12e.vcf_win_opponent));
  const d12e = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { E12: 0.9, I14: 0.05 } } } }),
    () => BG.jev.decide(e, st12e, st12e.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(d12e.notation === 'I14' && d12e.meta.tactics === 'vcfDefense',
    'p34 实战 E12 没破杀，应被 vcfDefense 纠正到 I14，实际：' + d12e.notation + '/' + d12e.meta.tactics);

  /* ⑫f 深度不足不虚报：同 ⑫a 局面，maxPlies=1 走不完 H7→I7→H4 三步链，应判无将死 */
  const vcfF = e.vcfWin(st12a, 'black', 1);
  BG.util.assert(!vcfF.win, 'maxPlies=1 不应虚报将死，实际：' + JSON.stringify(vcfF));

  /* ⑫g gomoku-pro（禁手模式）同局面：H7 不是禁手，真将死链不应被禁手逻辑误杀 */
  const epro = BG.games['gomoku-pro'];
  BG.util.assert(epro && typeof epro.vcfWin === 'function', 'gomoku-pro 应暴露 vcfWin');
  let st12g = epro.newGame();
  for (const n of vcfSeq) st12g = epro.applyMove(st12g, epro.moveFromNotation(st12g, n));
  const vcfG = epro.vcfWin(st12g, 'black', 7);
  BG.util.assert(vcfG.win && vcfG.first === 'H7',
    'pro 模式黑也应有 VCF 将死链（首步 H7），实际：' + JSON.stringify(vcfG));

  /* ⑫h 实战回归（exp-20260930025135 game4 第 18 手，白走）：黑方有 VCF 将死链，
   * 但只占链首 C13 杀不死（黑转走 E13 线），旧逻辑直接放弃 vcfDefense，白走
   * D13(parry3) 后被黑 E13 双重威胁打死。补丁后应逐点试干预，E13 可彻底破杀。 */
  let st12h = e.newGame();
  for (const n of ['H8', 'H7', 'E11', 'H9', 'B14', 'H10', 'A14', 'H11', 'C15', 'H12',
    'H13', 'I13', 'G11', 'I11', 'D12', 'F10', 'D14'])
    st12h = e.applyMove(st12h, e.moveFromNotation(st12h, n));
  BG.util.assert(st12h.turn === 'white', '应轮白走，实际：' + st12h.turn);
  const tac12h = BG.jev.computeTactics(e, st12h, e.getLegalMoves(st12h),
    Object.keys(e.serializeForJev(st12h, 'white').questions.move.criteria));
  BG.util.assert(tac12h.vcf_win_opponent.length > 0,
    'vcf_win_opponent 不应为空（链上多点可破杀），实际：' + JSON.stringify(tac12h.vcf_win_opponent));
  const d12h = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { D13: 0.9, E13: 0.05 } } } }),
    () => BG.jev.decide(e, st12h, st12h.turn, { channel: 'proxy', topK: 1 }));
  BG.util.assert(d12h.meta.tactics === 'vcfDefense' && tac12h.vcf_win_opponent.indexOf(d12h.notation) >= 0,
    '白方偏向 D13 也应被 vcfDefense 纠正到破杀点，实际：' + d12h.notation + '/' + d12h.meta.tactics);

  /* ⑬ 战术版本闸门（Phase 2）：同一局面按战术版本给出不同的战术事实与接管行为。
     版本缺失/未知时按当前档（v9）跑，保证老调用方零感知。 */
  /* 13a v0-off：win/block 层全关 → computeTactics 必须全空（纯 Jev 概率基线）。
     注：stx 已被当前档缓存过，顺带验证缓存按版本分键。 */
  const tacV0 = BG.jev.computeTactics(e, stx, e.getLegalMoves(stx),
    Object.keys(e.serializeForJev(stx, stx.turn).questions.move.criteria), 'v0-off');
  BG.util.assert(Object.keys(tacV0).every((k) => Array.isArray(tacV0[k]) && tacV0[k].length === 0),
    'v0-off 应无任何战术（含 win/block），实际：' + JSON.stringify(tacV0));
  /* 13b 2-ply 闸门：⑨b 局面黑活三，v2 无造杀点、v3 有（缓存同样按版本分键） */
  const crit9b = Object.keys(e.serializeForJev(st9b, st9b.turn).questions.move.criteria);
  const tacV2b = BG.jev.computeTactics(e, st9b, e.getLegalMoves(st9b), crit9b, 'v2-open4');
  BG.util.assert(tacV2b.chance_points_you.length === 0 && tacV2b.danger_points_opponent.length === 0,
    'v2-open4 未实现 2-ply，造杀/拆杀必须为空，实际：' + JSON.stringify(tacV2b));
  const tacV3b = BG.jev.computeTactics(e, st9b, e.getLegalMoves(st9b), crit9b, 'v3-make2');
  BG.util.assert(tacV3b.chance_points_you.indexOf('F6') >= 0 && tacV3b.chance_points_you.indexOf('F10') >= 0,
    'v3-make2 应认出黑活三的造杀点 F6/F10，实际：' + JSON.stringify(tacV3b.chance_points_you));
  /* 13c 引擎标签闸门：v1 无 open4 层 → 不接管；v2 有 → 概率偏向 G6 也被纠到活四点 */
  const d13v1 = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { G6: 0.9 } } } }),
    () => BG.jev.decide(e, stl, stl.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v1-facts' }));
  BG.util.assert(d13v1.meta.tactics !== 'open4' && d13v1.meta.tacticsVersion === 'v1-facts',
    'v1-facts 无 open4 层，不应接管到活四点，实际：' + d13v1.notation + '/' + d13v1.meta.tactics);
  const d13v2 = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { G6: 0.9 } } } }),
    () => BG.jev.decide(e, stl, stl.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v2-open4' }));
  BG.util.assert(d13v2.meta.tactics === 'open4' && (d13v2.notation === 'E8' || d13v2.notation === 'I8'),
    'v2-open4 应接管到活四点，实际：' + d13v2.notation + '/' + d13v2.meta.tactics);
  /* 13d vcfTry 边界（⑫h 局面）：v7 只试链首→仍被杀→放弃 vcfDefense；v8 逐点试→找到破杀点 */
  const crit12h = Object.keys(e.serializeForJev(st12h, st12h.turn).questions.move.criteria);
  const legal12h = e.getLegalMoves(st12h);
  const tacV7h = BG.jev.computeTactics(e, st12h, legal12h, crit12h, 'v7-vcf');
  BG.util.assert(tacV7h.vcf_win_opponent.length === 0,
    'v7-vcf 只试链首仍被杀时应放弃 vcfDefense，实际：' + JSON.stringify(tacV7h.vcf_win_opponent));
  const tacV8h = BG.jev.computeTactics(e, st12h, legal12h, crit12h, 'v8-vcf-try');
  BG.util.assert(tacV8h.vcf_win_opponent.length === 1,
    'v8-vcf-try 逐点试应恰好采用一个破杀点，实际：' + JSON.stringify(tacV8h.vcf_win_opponent));
  /* 13e 决策级：v8 下 vcfDefense 接管且 meta 记版本；v7 下不得以 vcfDefense 接管 */
  const d13v8 = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { D13: 0.9, E13: 0.05 } } } }),
    () => BG.jev.decide(e, st12h, st12h.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v8-vcf-try' }));
  BG.util.assert(d13v8.meta.tactics === 'vcfDefense' && d13v8.meta.tacticsVersion === 'v8-vcf-try',
    'v8 下应接管 vcfDefense 且 meta.tacticsVersion 记录版本，实际：' +
    d13v8.meta.tactics + '/' + d13v8.meta.tacticsVersion);
  const d13v7 = await withFetch(async () => mk(200, { model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 0 },
    answers: { move: { probabilities: { D13: 0.9, E13: 0.05 } } } }),
    () => BG.jev.decide(e, st12h, st12h.turn, { channel: 'proxy', topK: 1, tacticsVersion: 'v7-vcf' }));
  BG.util.assert(d13v7.meta.tactics !== 'vcfDefense' && d13v7.meta.tacticsVersion === 'v7-vcf',
    'v7 下 vcfDefense 为空不得接管（可回落其它层），实际：' +
    d13v7.meta.tactics + '/' + d13v7.meta.tacticsVersion);
  /* 13f 缺省/未知 id 都收敛到当前档（老调用方零感知，二级缓存不互染） */
  const curId = globalThis.BG.tacticsVersions.CURRENT;
  const critX2 = Object.keys(e.serializeForJev(stx, stx.turn).questions.move.criteria);
  const xLegal = e.getLegalMoves(stx);
  const tacDef = BG.jev.computeTactics(e, stx, xLegal, critX2);
  const tacCur = BG.jev.computeTactics(e, stx, xLegal, critX2, curId);
  const tacBogus = BG.jev.computeTactics(e, stx, xLegal, critX2, 'v99-nope');
  BG.util.assert(JSON.stringify(tacDef) === JSON.stringify(tacCur) && JSON.stringify(tacBogus) === JSON.stringify(tacCur),
    '缺省/未知 tacticsVersion 必须都按当前档跑，实际当前档：' + curId);
  /* 13g 着记透出版本：aiMoveMeta 把 decide 的 tacticsVersion 压成 tv 字段（每手可归源） */
  const aiMTv = BG.util.aiMoveMeta('G8', aiM('G8', { tacticsVersion: 'v3-make2' }));
  BG.util.assert(aiMTv !== null && aiMTv.tv === 'v3-make2',
    'aiMoveMeta 应透出 tv=v3-make2，实际：' + JSON.stringify(aiMTv));
  const aiMNoTv = BG.util.aiMoveMeta('G8', aiM('G8'));
  BG.util.assert(aiMNoTv !== null && aiMNoTv.tv === null,
    '无 tacticsVersion 时 tv 应为 null：' + JSON.stringify(aiMNoTv));

  /* ⑫i 伪胜回归（soundness）：守方被迫堵点的那一手若顺手给守方自己造出四，
   * 守方下一手直接成五，攻方后面所有双杀都兑现不了 → 这条链是假的。
   * 合成局面（黑 F2,F3,F4,G5,H5,G6；白 F1,C6,D6,E6，轮到黑走，入口双方无一步杀）：
   *   旧版给黑判胜 line=F5,F6,E5 —— 黑 F5 成四 → 白被迫堵 F6 → 白 F6 与 C6,D6,E6
   *   接成四（另一端 G6 被黑占，唯一成五点 B6）→ 黑 E5 双杀（引擎见 wins≥2 直接判胜）
   *   但真实时序里白下一手 B6 就成五了，攻方双杀永远轮不到。
   * 修复后每层校验"攻方这一手是否占掉了守方的即时致胜点"，占不掉就丢弃该分支。 */
  const syn2 = e.newGame();
  [[1, 5, 1], [2, 5, 1], [3, 5, 1], [4, 6, 1], [4, 7, 1], [5, 6, 1],
    [0, 5, 2], [5, 2, 2], [5, 3, 2], [5, 4, 2]].forEach(([r, c, p]) => { syn2.board[r][c] = p; });
  syn2.moveNum = 12;
  const vcf2 = e.vcfWin(syn2, 'black', 7);
  BG.util.assert(!vcf2.win && vcf2.first === null,
    '守方堵点造四反杀时不应判攻方胜（伪胜回归），实际：' + JSON.stringify(vcf2));
  /* soundness 的另一半：真链不能被误杀。
   * ① 同一局面里白攻 B6 是根节点双四（A6/F6 皆空，轮白走），这步本身就该判胜；
   * ② ⑫a 基准局面（7 ply 真链 H7→I7→H4）仍应判胜。 */
  const vcf2w = e.vcfWin(Object.assign({}, syn2, { turn: 'white' }), 'white', 7);
  BG.util.assert(vcf2w.win && vcf2w.first === 'B6',
    '白 B6 是根节点双四，应判真胜（soundness 闸门不得误杀），实际：' + JSON.stringify(vcf2w));
  BG.util.assert(vcfA.win, '真将死链不应被 soundness 闸门误杀，实际：' + JSON.stringify(vcfA));

  /* ⑫j 守方有 2 个即时致胜点时必无解（攻方一步只能占一个点）。
   * 合成局面 = ⑫i 拿掉黑 G6：黑 F2,F3,F4 + G5,H5；白 F1 + C6,D6,E6，轮到黑走，入口双方无一步杀。
   *   旧版给黑判胜 line=F5,F6,E5 —— 黑 F5 成四 → 白被迫堵 F6 → 白第 5 行 C6..F6
   *   成活四（两端 B6/G6 皆空，2 个成五点）→ 黑 E5 双杀（引擎见 wins≥2 直接判胜）
   *   但真实时序里白任一手 B6/G6 就成五了，攻方双杀永远轮不到。 */
  const syn3 = e.newGame();
  [[1, 5, 1], [2, 5, 1], [3, 5, 1],                   /* 黑 F2,F3,F4 */
    [4, 6, 1], [4, 7, 1],                              /* 黑 G5,H5 */
    [0, 5, 2],                                          /* 白 F1 */
    [5, 2, 2], [5, 3, 2], [5, 4, 2]                    /* 白 C6,D6,E6 */
  ].forEach(([r, c, p]) => { syn3.board[r][c] = p; });
  syn3.moveNum = 12;
  const vcf3 = e.vcfWin(syn3, 'black', 7);
  BG.util.assert(!vcf3.win && vcf3.first === null,
    '守方堵点成活四（2 个成五点）时应判无解，实际：' + JSON.stringify(vcf3));
}

/* 单元：Pages Function 的 401 / 422 / 限流 / 正常转发 */
async function pagesFunctionTests() {
  /* package.json 无 type:module，.js 按 CJS 解析，export 语法无法 import()；
     剥掉 export 后用 new Function 加载。hits Map 是模块状态：只加载一次，跨用例共享计数。 */
  const src = fs.readFileSync(path.join(ROOT, 'functions/api/jev.js'), 'utf8')
    .replace(/export\s+async\s+function\s+onRequestPost/, 'async function onRequestPost');
  const onRequestPost = new Function(src + '\nreturn onRequestPost;')();

  const mkReq = (body, headers) => new Request('http://local/api/jev', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body,
  });
  const validBody = JSON.stringify({ state: { game: 'test' }, questions: { move: { type: 'choice' } } });

  /* ① 无 key → 401（IP 9.9.9.1，独立计数） */
  let r = await onRequestPost({ request: mkReq(validBody, { 'CF-Connecting-IP': '9.9.9.1' }), env: {} });
  BG.util.assert(r.status === 401, '无 key 应 401，实际 ' + r.status);

  /* ② 坏 JSON → 422（IP 9.9.9.2） */
  r = await onRequestPost({ request: mkReq('not-json', { 'CF-Connecting-IP': '9.9.9.2', 'X-Api-Key': 'k' }), env: {} });
  BG.util.assert(r.status === 422, '坏 JSON 应 422，实际 ' + r.status);

  /* ③+④ 限流与转发：limit=2，同一 IP 第 3 次 429（IP 9.9.9.3 计数全新） */
  const realFetch = globalThis.fetch;
  let captured = null;
  let fetchCalls = 0;
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const env = { RATE_LIMIT_PER_MIN: '2' };
    const req = () => ({ request: mkReq(validBody, { 'CF-Connecting-IP': '9.9.9.3', 'X-Api-Key': 'k' }), env });
    r = await onRequestPost(req()); BG.util.assert(r.status === 200, '第 1 次应 200，实际 ' + r.status);
    r = await onRequestPost(req()); BG.util.assert(r.status === 200, '第 2 次应 200，实际 ' + r.status);
    r = await onRequestPost(req()); BG.util.assert(r.status === 429, '第 3 次应 429，实际 ' + r.status);
    BG.util.assert(fetchCalls === 2, '429 不应触达上游，实际 fetch ' + fetchCalls + ' 次');
    BG.util.assert(captured && captured.url === 'https://api.typesafe.ai/v1/systemone', '上游 URL 不对：' + (captured && captured.url));
    BG.util.assert(captured.init.headers.Authorization === 'Bearer k', 'Authorization 头不对');
    const sent = JSON.parse(captured.init.body);
    BG.util.assert(sent.model === 'jev-latest' && sent.state && sent.questions, '转发体缺字段');
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* 单元：新增 Pages Functions（health / experiments / stats）——方案 1 的 CF 侧后端。
 * 加载方式同 jev.js：剥掉 import/export 后用 new Function 跑；
 * _github.js 的定义内联进同一作用域，模拟 Wrangler 线上的打包结果。 */
function loadPagesModule(file, names) {
  const gh = fs.readFileSync(path.join(ROOT, 'functions/api/_github.js'), 'utf8')
    .replace(/export\s*\{[^}]*\};?/g, '');
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/export\s+async\s+function/g, 'async function');
  return new Function(gh + '\n' + src + '\nreturn { ' + names.join(',') + ' };')();
}

async function pagesApiTests() {
  const A = BG.util.assert;
  const realFetch = globalThis.fetch;
  const mkReq = (body, headers) => new Request('http://local/api/x', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.8.7.6' }, headers),
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const ctx = (req, env) => ({ request: req, env: env || { GAMES_GITHUB_TOKEN: 'tok' } });
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

  /* GitHub API stub：按 URL 片段路由；调用计数供子请求预算断言 */
  let ghCalls = 0;
  let rawCalls = 0;
  const withStub = async (routes, fn) => {
    ghCalls = 0; rawCalls = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.indexOf('https://api.github.com') === 0) ghCalls++;
      if (u.indexOf('https://raw.githubusercontent.com') === 0) rawCalls++;
      for (const [pat, handler] of routes) {
        if (u.indexOf(pat) >= 0) return handler(u, init);
      }
      throw new Error('未打桩的 fetch: ' + u);
    };
    try { return await fn(); } finally { globalThis.fetch = realFetch; }
  };

  /* ---------- health ---------- */
  {
    const { onRequestGet } = loadPagesModule('functions/api/health.js', ['onRequestGet']);
    const r1 = await onRequestGet(ctx(mkReq(), { GAMES_GITHUB_TOKEN: 'tok' }));
    const j1 = await r1.json();
    A(r1.status === 200, 'health 应 200，实际 ' + r1.status);
    A(j1.ok === true && j1.service === 'jev-qiguan-pages' && j1.version, 'health 字段不齐：' + JSON.stringify(j1));
    A(j1.github === true, '配了 token 时 github 应为 true');
    const r2 = await onRequestGet(ctx(mkReq(), {}));
    const j2 = await r2.json();
    A(j2.github === false, '无 token 时 github 应为 false（前端据此提示未配置）');
  }

  /* ---------- experiments ---------- */
  {
    const { onRequestGet, onRequestPost } = loadPagesModule('functions/api/experiments.js', ['onRequestGet', 'onRequestPost']);

    /* GET：归档文件不存在 → 空数组不报错 */
    await withStub([['/contents/data/experiments.json', async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })]],
      async () => {
        const r = await onRequestGet(ctx(mkReq()));
        const j = await r.json();
        A(r.status === 200 && Array.isArray(j.experiments) && j.experiments.length === 0, '无归档应返回空数组');
      });

    /* GET：有文件 → 解析出列表（base64 带换行也要能解） */
    await withStub([['/contents/data/experiments.json', async () => new Response(JSON.stringify({
      content: b64([{ tag: 'exp-a', games: [] }]).replace(/(.{10})/g, '$1\n'), sha: 'sha1',
    }), { status: 200 })]],
      async () => {
        const r = await onRequestGet(ctx(mkReq()));
        const j = await r.json();
        A(j.experiments.length === 1 && j.experiments[0].tag === 'exp-a', '归档解析不对：' + JSON.stringify(j));
      });

    /* GET：GitHub 抽风 → 静默降级（本地归档仍可用） */
    await withStub([['/contents/data/experiments.json', async () => new Response('{}', { status: 500 })]],
      async () => {
        const r = await onRequestGet(ctx(mkReq()));
        const j = await r.json();
        A(r.status === 200 && j.experiments.length === 0 && j.reason, '读失败应降级为空 + reason');
      });

    /* POST：坏 body → 422 */
    const bad = await onRequestPost(ctx(mkReq({ tag: '', games: [] })));
    A(bad.status === 422, '空 tag 应 422，实际 ' + bad.status);
    const bad2 = await onRequestPost(ctx(mkReq({ tag: 'x' })));
    A(bad2.status === 422, '缺 games 应 422，实际 ' + bad2.status);

    /* POST：新建（无既有文件）→ PUT 不带 sha，提交信息带 [skip ci] */
    let putBody = null;
    await withStub([
      ['/contents/data/experiments.json?ref=', async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })],
      ['/contents/data/experiments.json', async (u, init) => {
        putBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ commit: { sha: 'c1' } }), { status: 200 });
      },
    ]], async () => {
      const entry = { tag: 'exp-20260929120000', date: '2026-09-29T12:00:00.000Z', chanA: 'proxy', chanB: 'random', total: 2, games: [{ no: 1 }] };
      const r = await onRequestPost(ctx(mkReq(entry)));
      const j = await r.json();
      A(r.status === 200 && j.ok === true, '新建应 200 ok');
      A(j.experiments.length === 1 && j.experiments[0].tag === entry.tag, '响应应含新归档');
      A(putBody && putBody.sha === undefined, '新建文件不能带 sha');
      A(putBody && putBody.message.indexOf('[skip ci]') >= 0 && putBody.message.indexOf('exp: exp-20260929120000') === 0,
        '提交信息应带 [skip ci] 与 tag，实际：' + (putBody && putBody.message));
      A(putBody && putBody.branch === 'main', 'branch 应为 main');
      A(putBody && typeof putBody.content === 'string' && putBody.content.length > 0, 'content 不能空');
    });

    /* POST：upsert（同 tag 已存在且带 sha）→ 内容替换不新增，date 倒序 */
    let putBody2 = null;
    await withStub([
      ['/contents/data/experiments.json?ref=', async () => new Response(JSON.stringify({
        content: b64([
          { tag: 'exp-old', date: '2026-09-28T00:00:00.000Z', games: [{ no: 1 }, { no: 2 }] },
          { tag: 'exp-20260929120000', date: '2026-09-29T12:00:00.000Z', games: [{ no: 1 }] },
        ]), sha: 'shaX',
      }), { status: 200 })],
      ['/contents/data/experiments.json', async (u, init) => {
        putBody2 = JSON.parse(init.body);
        return new Response(JSON.stringify({ commit: { sha: 'c2' } }), { status: 200 });
      },
    ]], async () => {
      const r = await onRequestPost(ctx(mkReq({ tag: 'exp-20260929120000', date: '2026-09-29T12:00:00.000Z', chanA: 'proxy', chanB: 'random', total: 3, games: [{ no: 1 }, { no: 2 }, { no: 3 }] })));
      const j = await r.json();
      A(j.experiments.length === 2, '同 tag 应 upsert 不新增，实际 ' + j.experiments.length);
      const upserted = j.experiments.find((e) => e.tag === 'exp-20260929120000');
      A(upserted.games.length === 3, 'upsert 应替换 games，实际 ' + upserted.games.length);
      A(j.experiments[0].date >= j.experiments[1].date, '应按 date 倒序');
      A(putBody2 && putBody2.sha === 'shaX', '更新必须带原文件 sha，实际 ' + (putBody2 && putBody2.sha));
    });

    /* POST：无 token → 500（与 games.js 一致，前端「最近同步」显示失败原因） */
    const noTok = await onRequestPost(ctx(mkReq({ tag: 't', games: [] }), {}));
    A(noTok.status === 500, '无 token 应 500，实际 ' + noTok.status);

    /* 限流：第 61 次 → 429（IP 独立计数） */
    const { onRequestGet: get2 } = loadPagesModule('functions/api/experiments.js', ['onRequestGet']);
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const r = await withStub([['/contents/data/experiments.json', async () => new Response('{"message":"Not Found"}', { status: 404 })]],
        () => get2({ request: mkReq(undefined, { 'CF-Connecting-IP': '6.6.6.6' }), env: { GAMES_GITHUB_TOKEN: 'tok' } }));
      last = r.status;
    }
    A(last === 429, '第 61 次应 429，实际 ' + last);
  }

  /* ---------- stats ---------- */
  {
    const { onRequestGet } = loadPagesModule('functions/api/stats.js', ['onRequestGet']);
    const gameFile = (gid, notation, extra) => Object.assign({
      format: 'jev-qiguan-game/v1', game: '五子棋', gid, notation,
      result: '黑方 获胜（五连）', moves: [], mock: false, firstWin: true, cal: [0.7, 0.8],
    }, extra);

    /* 三份棋谱（一份 mock、一份和棋）+ 干扰路径；raw 拉取聚合 */
    const tree = { tree: [
      { type: 'blob', path: 'js/app.js' },
      { type: 'blob', path: 'games/not-a-day/x.json' },
      { type: 'blob', path: 'games/2026-09-29/gomoku-20260929110000.json' },
      { type: 'blob', path: 'games/2026-09-29/gomoku-20260929120000.json' },
      { type: 'blob', path: 'games/2026-09-29/gomoku-20260929130000.json' },
    ] };
    const rawFiles = {
      'games/2026-09-29/gomoku-20260929110000.json': gameFile('gomoku', 'H8,H7'),
      'games/2026-09-29/gomoku-20260929120000.json': gameFile('gomoku', 'A1,A2', { mock: true }),
      'games/2026-09-29/gomoku-20260929130000.json': gameFile('gomoku', 'B1,B2', { firstWin: null, result: '和棋（棋盘已满）' }),
    };
    let subrequests = 0;
    const r = await withStub([
      ['/git/trees/', async () => new Response(JSON.stringify(tree), { status: 200 })],
      ['/contents/data/experiments.json', async () => new Response(JSON.stringify({ content: b64([{ tag: 'e1' }, { tag: 'e2' }]) }), { status: 200 })],
      ['raw.githubusercontent.com', async (u) => {
        const p = u.replace('https://raw.githubusercontent.com/tripodxu/board-games/main/', '');
        const f = rawFiles[p];
        return f ? new Response(JSON.stringify(f), { status: 200 }) : new Response('{}', { status: 404 });
      },
    ]], () => onRequestGet(ctx(mkReq())));
    const j = await r.json();
    A(r.status === 200 && j.ok === true, 'stats 应 200 ok，实际 ' + r.status);
    A(j.totalGames === 3, '应聚合 3 份（干扰路径排除），实际 ' + j.totalGames);
    A(j.byGame['五子棋'] === 3, 'byGame 应对：' + JSON.stringify(j.byGame));
    A(j.results.black === 2 && j.results.draw === 1 && j.results.white === 0, 'results 应对：' + JSON.stringify(j.results));
    A(j.experiments === 2, 'experiments 应为 2 轮，实际 ' + j.experiments);
    A(j.cal.games === 1, 'mock 与和棋应剔除，只留 1 局，实际 ' + j.cal.games);
    A(j.cal.records[0].key === 'gomoku|H8,H7' && j.cal.records[0].cal.length === 2, 'cal.records 形状不对：' + JSON.stringify(j.cal.records[0]));
    A(j.truncated === false, '3 份不应截断');
    subrequests = ghCalls + rawCalls;
    A(subrequests <= 42, '子请求应 ≤42（免费版 50 上限留余量），实际 ' + subrequests);

    /* 单份 raw 拉取失败 → 跳过不拖垮聚合 */
    const r2 = await withStub([
      ['/git/trees/', async () => new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'games/2026-09-29/gomoku-20260929110000.json' }] }), { status: 200 })],
      ['/contents/data/experiments.json', async () => new Response('{"message":"Not Found"}', { status: 404 })],
      ['raw.githubusercontent.com', async () => new Response('{}', { status: 500 })],
    ], () => onRequestGet(ctx(mkReq())));
    const j2 = await r2.json();
    A(r2.status === 200 && j2.totalGames === 0 && j2.experiments === 0, 'raw 全败应降级为 0 而非报错');

    /* 超过 40 份 → 截断且只拉 40 份（守免费版 50 子请求） */
    const many = [];
    for (let i = 0; i < 45; i++) many.push({ type: 'blob', path: 'games/2026-09-29/gomoku-2026092910' + String(1000 + i) + '.json' });
    const r3 = await withStub([
      ['/git/trees/', async () => new Response(JSON.stringify({ tree: many }), { status: 200 })],
      ['/contents/data/experiments.json', async () => new Response('{"message":"Not Found"}', { status: 404 })],
      ['raw.githubusercontent.com', async () => new Response(JSON.stringify(gameFile('gomoku', 'H8')), { status: 200 })],
    ], () => onRequestGet(ctx(mkReq())));
    const j3 = await r3.json();
    A(j3.truncated === true && j3.totalGames === 40, '超 40 份应截断为 40，实际 ' + j3.totalGames + '/' + j3.truncated);
    A(ghCalls + rawCalls <= 42, '截断场景子请求仍应 ≤42，实际 ' + (ghCalls + rawCalls));

    /* 无 token → 500；trees 失败 → 502 */
    const noTok = await onRequestGet(ctx(mkReq(), {}));
    A(noTok.status === 500, '无 token 应 500，实际 ' + noTok.status);
    const treeFail = await withStub([['/git/trees/', async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })]],
      () => onRequestGet(ctx(mkReq())));
    A(treeFail.status === 502, 'trees 失败应 502，实际 ' + treeFail.status);
  }
}

integration()
  .catch((e) => { failed++; results.push('✗ 集成测试: ' + e.message); })
  .then(() => jevClientTests())
  .catch((e) => { failed++; results.push('✗ jev-client 单元测试: ' + e.message); })
  .then(() => {
    /* Rapfi 本地引擎通道：stub Module，不加载真实 WASM（见 test/rapfi-tests.js） */
    const { rapfiTests } = require('./rapfi-tests.js');
    return rapfiTests((line) => results.push(line));
  })
  .catch((e) => { failed++; results.push('✗ rapfi 单元测试: ' + e.message); })
  .then(() => pagesFunctionTests())
  .catch((e) => { failed++; results.push('✗ Pages Function 单元测试: ' + e.message); })
  .then(() => pagesApiTests())
  .catch((e) => { failed++; results.push('✗ Pages API Functions 单元测试: ' + e.message); })
  .then(() => {
    /* 后端（server.js）HTTP 契约测试：临时目录 + ephemeral port，不碰仓库真实数据。
     * 传入收集器：后端用例与引擎用例按同一节奏进 results，输出顺序不变。 */
    const { serverTests } = require('./server-tests.js');
    return serverTests((line) => results.push(line));
  })
  .catch((e) => { failed++; results.push('✗ 后端单元测试: ' + e.message); })
  .finally(() => {
    console.log(results.join('\n'));
    if (failed) {
      console.log('\n' + failed + ' 项失败');
      process.exit(1);
    }
    console.log('\n全部测试通过');
  });
