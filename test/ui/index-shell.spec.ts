/**
 * 外壳契约：守**真实** `index.html`（不是夹具）。
 *
 * 为什么需要：P6 把 `app.js` 拆进 `src/{core,ui,app}` 后，`test/ui/**` 里的 DOM 断言全部
 * 跑在自造夹具上 —— 装配层与外壳之间**一条护栏都没有**。真实事故有两次：
 *   ① `#duelFirstName` 硬编码「黑方 Jev」（渠道名进了外壳，换渠道就撒谎）；
 *   ② 标题写「六种棋类」而实际有七种（旧台账没人守）。
 * 旧套件 `test/run-tests.cjs` 有 30 组「读 index.html 源码做字符串匹配」的断言，随它一起删了；
 * 本文件是那批断言里**仍然成立的那部分**的正式落点（P8 收尾清单第 840 行）。
 *
 * 守住三件事：
 *   1. 入口唯一：整份外壳只有 1 个 `<script>`，且是 module 指向 `/src/main.ts`；样式来自 `styles/`。
 *   2. 必需控件 id 齐全且不重复：装配层 `src/app/**` 拿 `byId()` 取的都是这些 id，
 *      缺一个就是开机即抛（`byId` 找不到就 throw）。
 *   3. 外壳不指旧路径、不写死渠道名（`dev-proxy.py` / `functions/` / `js/` / `css/` / `server.js`）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

/** 装配层与面板必须能取到的 id（`src/app/**`、`src/ui/panels/**` 的 `byId` 调用点）。 */
const REQUIRED_IDS = [
  // 外壳与页签
  'tabs', 'pane-play', 'pane-exp', 'pane-data',
  // 棋盘与对局控制
  'board', 'boardWrap', 'status', 'turnBadge', 'gameName', 'gameSync',
  'startBtn', 'undoBtn', 'swapBtn', 'resignBtn', 'passBtn', 'retryBtn', 'pauseBtn', 'stepBtn',
  'mode', 'channel', 'channelChip', 'speedRow', 'speed', 'speedVal',
  'engineModel', 'engineStatus', 'engineSeal',
  // 战术档与双方覆盖
  'tacticsVersion', 'tacticsVersionLabel', 'tacticsList', 'tacticsListBody', 'tacticsListTitle',
  'side', 'sideCfgBlack', 'sideCfgWhite',
  'blackChannel', 'whiteChannel', 'blackTactics', 'whiteTactics', 'blackThinkMs', 'whiteThinkMs',
  'foeChannel', 'foeThink', 'foeTactics', 'foeHint', 'foeNote', 'rapfiThinkMs', 'rapfiThinkLabel',
  'promoBox', 'duel', 'duelFirst', 'duelFirstName', 'duelSecond', 'duelSecondName',
  // 实时区
  'latest', 'latestNote', 'latSpark', 'sparkNow', 'trend', 'trendNote',
  'chipWin', 'chipScore', 'chipConf', 'rankCount', 'feed', 'legendFirst', 'legendSecond',
  // 战绩簿与归档
  'records', 'recordStats', 'recordSummary', 'archiveBody', 'archiveNote', 'archiveReload',
  'clearRecords', 'exportGame',
  // 校准 / 实验
  'calBody', 'calCount', 'evalBar', 'evalFill',
  'expChanA', 'expChanB', 'expGames', 'expStatus', 'expStartBtn', 'expStopBtn', 'expResults',
  'expReportNote', 'expSideA', 'expSideB', 'expTacA', 'expTacB', 'expThinkA', 'expThinkB', 'expHistory',
  'ledger', 'emMoves', 'emTokens', 'emCost', 'emFastest',
  // P7c 三块数据面板的挂载点（面板自己覆写 root.className，只能靠 id 定位）
  'replayerPanel', 'leaderboardPanel', 'openingsPanel',
  // 折叠面板正文容器（`data-toggle` 目标）
  'body-archive', 'body-cal', 'body-duel', 'body-expreport', 'body-feed', 'body-foe',
  'body-latest', 'body-leaderboard', 'body-ledger', 'body-openings', 'body-records',
  'body-replayer', 'body-trend',
  // 设置抽屉与自检
  'settingsGear', 'settingsDrawer', 'drawerMask', 'drawerBody', 'drawerClose', 'drawerTitle',
  'probeBtn', 'probeOut', 'probeRow', 'modeHint',
  'apiKey', 'apiKeyLabel', 'orKey', 'orKeyLabel', 'endpoint', 'endpointLabel',
  'testPanel', 'toast',
  // 后端状态区
  'backendBlock', 'backendChip', 'backendMode', 'backendState', 'backendSync',
  'backendGames', 'backendExps', 'backendHint', 'topK', 'costChip',
];

describe('index.html 外壳契约', () => {
  it('入口唯一：1 个 module script，样式来自 styles/', () => {
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts, '外壳只允许 1 个 <script>（其余逻辑都进 src/main.ts 的模块图）').toHaveLength(1);
    expect(scripts[0]).toMatch(/type="module"/);
    expect(scripts[0]).toMatch(/src="\/src\/main\.ts"/);

    const styleLinks = (html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/g) ?? [])
      .filter((tag) => !tag.includes('fonts.googleapis.com'));
    expect(styleLinks, '本站样式表应当只有 1 个（styles/ 下，经 Vite 打包）').toHaveLength(1);
    expect(styleLinks[0]).toContain('/styles/');
  });

  it('必需控件 id 齐全且无重复', () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dup, 'index.html 存在重复 id：' + dup.join(',')).toEqual([]);

    const present = new Set(ids);
    const missing = REQUIRED_IDS.filter((id) => !present.has(id));
    expect(missing, 'index.html 缺控件 #' + missing.join(' #')).toEqual([]);
  });

  it('#board 是 canvas，三块数据面板的挂载点是空容器', () => {
    expect(html).toMatch(/<canvas\b[^>]*id="board"/);
    for (const id of ['replayerPanel', 'leaderboardPanel', 'openingsPanel']) {
      const tag = html.match(new RegExp(`<[a-z]+\\b[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
      expect(tag, `#${id} 应当是空容器（内容全由面板渲染）`).toMatch(/<div\b/);
      expect(tag).not.toMatch(/class="[^"]*\b(rp|lb|op)\b/);
    }
  });

  it('外壳不指旧路径、不写死渠道名与棋种数', () => {
    for (const stale of ['dev-proxy', 'functions/', 'js/', 'css/', 'server.js', 'legacy.html', 'Cloudflare Pages']) {
      expect(html, `外壳不该再出现旧路径「${stale}」`).not.toContain(stale);
    }
    // 旧事故①：两侧联名硬编码渠道名（开机即被 renderSideNames 覆写，且换渠道就撒谎）
    const first = html.match(/id="duelFirstName"[^>]*>([^<]*)</)?.[1]?.trim();
    const second = html.match(/id="duelSecondName"[^>]*>([^<]*)</)?.[1]?.trim();
    expect(first).toBe('黑方');
    expect(second).toBe('白方');
    // 旧事故②：标题/描述里的棋种数必须与注册表一致（七种）
    expect(html).toContain('七种棋类');
    expect(html).not.toContain('六种棋类');
  });
});
