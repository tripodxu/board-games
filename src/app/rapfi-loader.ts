/* rapfi-loader.ts — 浏览器侧的 Rapfi 胶水脚本注入器（P8 补齐 P6 拆层漏掉的一段）。
 *
 * 背景：`src/core/jev/rapfi.ts` 逐字移植了旧 `js/rapfi.js` 的协议与状态机，但把
 * 「动态注入 Emscripten 胶水脚本」那一段**收成了可注入的加载器**（core 里没有 document）。
 * 约定是「P6 的 UI 层负责真正的脚本注入」——装配时没人接这一段，于是浏览器里
 * `_loader` 恒为 `null`，`ensureLoaded()` 一律 reject「当前环境不支持动态加载 Rapfi 脚本
 * （无 document）」，Rapfi 渠道的对手永不走子。
 *
 * 这个缺陷只在真机上现形：mock 渠道不碰 rapfi；纯 Node 测试自己注入假加载器
 * （`test/engines/rapfi.test.mjs`），`tsc` 也看不出来。首次发现是 P8 的浏览器冒烟里
 * 「对手也落了子」这一项在 `--channel rapfi` 下超时（mock 渠道正常）。
 *
 * 这里按旧实现逐字重放那段注入：
 *   createElement('script') → 等 onload → window.Rapfi({ locateFile, onReceiveStdout, onReceiveStderr })
 * 唯一差异是地址：旧实现用 `document.currentScript.src` 反推 `rapfi/` 目录，
 * 新实现直接用 `public/` 的部署路径（`/` + `GLUE_FILE`），dev 与线上同一条路径。
 */
import { GLUE_FILE, onStdout, setGlueUrl, setLoader, stderrHandler } from '../core/jev/rapfi.ts';
import type { ProgressFn, RapfiModule } from '../core/jev/rapfi.ts';

/** 胶水脚本的部署路径（`public/rapfi/**` 由 Vite 原样搬到站点根）。 */
export const RAPFI_GLUE_URL = '/' + GLUE_FILE;
/** `locateFile` 前缀：`.wasm` / `.data` 与脚本同目录。 */
export const RAPFI_ASSET_BASE = RAPFI_GLUE_URL.slice(0, RAPFI_GLUE_URL.lastIndexOf('/') + 1);

/** Emscripten MODULARIZE 工厂（胶水脚本把它挂在 `globalThis.Rapfi` 上）。 */
export type RapfiFactory = (opts: {
  locateFile: (path: string) => string;
  onReceiveStdout: (line: string) => void;
  onReceiveStderr: (line: string) => void;
  /** Emscripten 的状态/下载进度回调（「Downloading data... (a/b)」）；可选，胶水缺省也有实现。 */
  setStatus?: (text: unknown) => void;
}) => Promise<RapfiModule>;

function factoryOf(): RapfiFactory | null {
  const f = (globalThis as { Rapfi?: unknown }).Rapfi;
  return typeof f === 'function' ? (f as RapfiFactory) : null;
}

/** 注入胶水脚本并实例化引擎（旧实现 `ensureLoaded` 闭包里的注入段）。
 *
 * 2026-10-06 加载硬化（已知限制 #5 的应用侧缺口）：胶水的 `.data` 预载失败时
 * run dependency 永不解除 → 工厂 Promise **永不 settle** → 上层 `_loadPromise`
 * 永挂 → inflight 永占 → 整局假死。两层防护：
 *  ① **停滞看门狗**：任何进度事件（脚本 onload / setStatus / 实例化完成）都会重置
 *     计时器；连续 `STALL_TIMEOUT_MS` 无任何进度即 reject——慢链路（有进度）不会被
 *     误杀，断链/死链（无进度）30 秒内必然失败，失败错误可重试。
 *  ② **进度透传**：胶水的 `setStatus`（「Downloading data... (a/b)」）经
 *     `onProgress('download', text)` 交上层展示，替换掉「看着在等 AI」。
 */
export const RAPFI_STALL_TIMEOUT_MS = 30_000;

export function loadRapfiModule(url: string, onProgress?: ProgressFn): Promise<RapfiModule> {
  return new Promise<RapfiModule>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('当前环境不支持动态加载 Rapfi 脚本（无 document）'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const kick = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        settle(() => reject(new Error(
          `Rapfi 资产下载停滞超过 ${Math.round(RAPFI_STALL_TIMEOUT_MS / 1000)} 秒（网络中断或目标不可达）`,
        )));
      }, RAPFI_STALL_TIMEOUT_MS);
    };
    kick();

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      kick();
      const factory = factoryOf();
      if (!factory) {
        settle(() => reject(new Error('Rapfi 胶水脚本未导出工厂函数 Rapfi：' + url)));
        return;
      }
      if (typeof onProgress === 'function') {
        try { onProgress('wasm'); } catch (_) { /* ignore */ }
      }
      factory({
        locateFile: (p: string) => RAPFI_ASSET_BASE + p,
        onReceiveStdout: (line: string) => onStdout(line),
        onReceiveStderr: (line: string) => stderrHandler(line),
        /* Emscripten 的下载进度（含 .data 的「(a/b)」文本）：既当进度展示，也当看门狗心跳。 */
        setStatus: (text: unknown) => {
          kick();
          if (typeof onProgress === 'function' && text) {
            try { onProgress('download', String(text)); } catch (_) { /* ignore */ }
          }
        },
      }).then((mod) => settle(() => resolve(mod)), (e: unknown) => {
        settle(() => reject(new Error('Rapfi 引擎实例化失败：' + (e instanceof Error ? e.message : String(e)))));
      });
    };
    script.onerror = () => { settle(() => reject(new Error('Rapfi 脚本加载失败：' + url))); };
    document.head.appendChild(script);
  });
}

/** 装配层入口：把加载器与胶水脚本地址装进 core（幂等，可重复调用）。 */
export function installRapfiLoader(): void {
  setGlueUrl(RAPFI_GLUE_URL);
  setLoader(loadRapfiModule);
}
