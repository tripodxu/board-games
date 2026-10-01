/* backend.ts — 后端探活与数据存储状态（旧 js/app.js:839-929 的「后端状态」段）
 *
 * 旧实现的三种形态（live / deploy / pending）在新架构里语义不变，只有**判据**换了：
 *   - 旧 `h.github === false`（服务端没配 GAMES_GITHUB_TOKEN）= CF Pages 时代「后端在线但写不进去」；
 *     新后端是 Worker + D1，等价的判据是 `h.d1 === false`（D1 绑定缺失，写入必失败）。
 *   - 旧 `st.truncated`（服务端 7 天窗口截断）已在 P5 去掉：`/api/stats` 现在永远返回全量，
 *     所以「N+ 份」的加号没有了。
 *   - 旧 `st.experiments` 也不再返回（`/api/stats` 只有 `{ok,totalGames,byGame,results,cal}`），
 *     所以实验轮数在 live 形态下显示 `–`（本机归档仍照常显示在实验报告面板）。
 *   - 旧 deploy 分支的提示语教用户「运行 node server.js」（该后端已在 P8 随 `server.cjs` 删除）；
 *     这里改指新栈的本地入口 `npm run dev`（Vite + Worker + 本地 D1 一体）。
 *     语义（「同步仍会尝试、结果以『最近同步』为准、实验与统计只在本地」）逐字保留。
 *
 * 数据面：所有请求走 `src/core/api/client.ts`（失败一律 null），本文件只做状态机与渲染。
 */
import { health, listExperiments, stats as fetchStats } from '../core/api/client.ts';
import { createExpHistoryStore, renderExpHistory } from '../ui/panels/experiment-report.ts';
import { byId } from '../ui/dom.ts';
import type { AppCtx } from './ctx.ts';
import { renderCalibrationPanel } from './panels.ts';

/** `#backendChip` 的三态类名（旧 `setBackendChip(state, text)`）。 */
function setBackendChip(state: 'pending' | 'live' | 'static', text: string): void {
  const chip = byId<HTMLElement>('backendChip');
  const label = byId<HTMLElement>('backendState');
  if (!chip || !label) return;
  chip.classList.remove('pending', 'live', 'static');
  chip.classList.add(state);
  label.textContent = text;
}

/** 旧 `renderBackend()`（js/app.js:854-890）。 */
export function renderBackend(ctx: AppCtx): void {
  const modeEl = byId<HTMLElement>('backendMode');
  const gamesEl = byId<HTMLElement>('backendGames');
  const expsEl = byId<HTMLElement>('backendExps');
  const syncEl = byId<HTMLElement>('backendSync');
  const hintEl = byId<HTMLElement>('backendHint');
  const backend = ctx.backend;
  if (!modeEl) return;

  if (backend.mode === 'pending') {
    setBackendChip('pending', '检测中');
    modeEl.textContent = '检测中…';
    modeEl.className = '';
    if (hintEl) hintEl.textContent = '正在检测同源后端…';
    return;
  }

  if (backend.mode === 'live') {
    const h = backend.health || {};
    const st = backend.stats;
    setBackendChip('live', '已连接');
    modeEl.textContent = String(h.service || 'server') + (h.version ? ' v' + h.version : '');
    modeEl.className = 'ok';
    if (gamesEl) {
      gamesEl.textContent = st
        ? String(st.totalGames || 0) + ' 份'
        : (typeof h.games === 'number' ? h.games + ' 份' : '–');
    }
    if (expsEl) expsEl.textContent = st && typeof st.experiments === 'number' ? st.experiments + ' 轮' : '–';
    if (hintEl) {
      hintEl.textContent = h.d1 === false
        ? '后端在线，但服务端未绑定 D1：棋谱同步与归档实际不可用（检查 wrangler.jsonc 的 d1_databases 绑定与迁移是否已应用）。'
        : '棋谱终局落盘到后端存储，实验战报归档到服务端，校准实验室可聚合全部已同步对局。';
    }
  } else {
    setBackendChip('static', '无本地后端');
    modeEl.textContent = '未检测到同源后端';
    modeEl.className = 'warn';
    if (gamesEl) gamesEl.textContent = '仅本机';
    if (expsEl) expsEl.textContent = '仅本机';
    if (hintEl) {
      hintEl.textContent = '未检测到同源后端（npm run dev 会同时起 Vite + Worker + 本地 D1）。'
        + '当前是纯静态托管：棋谱同步仍会尝试 POST /api/games，结果以「最近同步」为准；'
        + '实验归档与跨对局统计只在本地。在仓库根目录运行 npm run dev 即获得完整后端。';
    }
  }

  if (syncEl) {
    const last = backend.lastSync;
    syncEl.textContent = last ? last.text : '–';
    syncEl.className = last ? (last.ok ? 'ok' : 'warn') : '';
  }
}

/** 旧 `initBackend()`（js/app.js:892-901）：不阻塞首屏，live 时再并行补两路数据。 */
export async function initBackend(ctx: AppCtx): Promise<void> {
  const h = await health();
  ctx.backend.mode = h && h.ok ? 'live' : 'deploy';
  ctx.backend.health = h && h.ok ? h : null;
  renderBackend(ctx);
  if (ctx.backend.mode === 'live') {
    await Promise.allSettled([refreshServerExperiments(ctx), refreshServerStats(ctx)]);
  }
}

interface ExpEntryLike {
  tag?: string;
  date?: string;
  games?: unknown[];
  [k: string]: unknown;
}

/**
 * 旧 `refreshServerExperiments()`（js/app.js:904-920）：服务端战报并入本地缓存
 * （按 tag 合并：缺失或局数变多则更新），再重画报告面板。
 *
 * 注意 `api.listExperiments()` 这里返回的是**解包后的数组**（Worker 响应体是
 * `{experiments:[…]}`，`core/api/client.ts` 的 `listExperiments()` 负责拆包装；旧
 * `BG.api.listExperiments()` 把包装体原样交给调用方，是装配层自己读的 `r.experiments`）。
 * 2026-10-01 修：此前这里按「客户端已解包」写成 `Array.isArray(r)`，而当时客户端并没有解包，
 * 于是服务端战报静默丢失（生产 6 轮实验在面板里永远看不到）——现在两端口径一致，且
 * `test/app/experiments-merge.spec.ts` 钉住「服务端轮次真的并进了本机归档」。
 */
export async function refreshServerExperiments(ctx: AppCtx): Promise<void> {
  const r = await listExperiments();
  if (!r || !Array.isArray(r)) return;
  const store = createExpHistoryStore(ctx.storage);
  const list = store.list();
  let changed = false;
  for (const e of r as ExpEntryLike[]) {
    if (!e || !e.tag) continue;
    const i = list.findIndex((x) => x.tag === e.tag);
    if (i === -1) {
      list.push(e as unknown as (typeof list)[number]);
      changed = true;
    } else if ((list[i].games || []).length < (e.games || []).length) {
      list[i] = e as unknown as (typeof list)[number];
      changed = true;
    }
  }
  if (changed) {
    list.sort((x, y) => String(y.date).localeCompare(String(x.date)));
    store.save(list);
  }
  renderExpHistory(store.list());
}

/** 旧 `refreshServerStats()`（js/app.js:923-929）：校准实验室的第二数据源 + 归档计数。 */
export async function refreshServerStats(ctx: AppCtx): Promise<void> {
  const r = await fetchStats();
  if (!r || !r.ok) return;
  ctx.backend.stats = r;
  renderBackend(ctx);
  renderCalibrationPanel(ctx);
}
