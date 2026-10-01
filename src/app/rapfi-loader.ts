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
}) => Promise<RapfiModule>;

function factoryOf(): RapfiFactory | null {
  const f = (globalThis as { Rapfi?: unknown }).Rapfi;
  return typeof f === 'function' ? (f as RapfiFactory) : null;
}

/** 注入胶水脚本并实例化引擎（旧实现 `ensureLoaded` 闭包里的注入段）。 */
export function loadRapfiModule(url: string, onProgress?: ProgressFn): Promise<RapfiModule> {
  return new Promise<RapfiModule>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('当前环境不支持动态加载 Rapfi 脚本（无 document）'));
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      const factory = factoryOf();
      if (!factory) {
        reject(new Error('Rapfi 胶水脚本未导出工厂函数 Rapfi：' + url));
        return;
      }
      if (typeof onProgress === 'function') {
        try { onProgress('wasm'); } catch (_) { /* ignore */ }
      }
      factory({
        locateFile: (p: string) => RAPFI_ASSET_BASE + p,
        onReceiveStdout: (line: string) => onStdout(line),
        onReceiveStderr: (line: string) => stderrHandler(line),
      }).then(resolve, (e: unknown) => {
        reject(new Error('Rapfi 引擎实例化失败：' + (e instanceof Error ? e.message : String(e))));
      });
    };
    script.onerror = () => { reject(new Error('Rapfi 脚本加载失败：' + url)); };
    document.head.appendChild(script);
  });
}

/** 装配层入口：把加载器与胶水脚本地址装进 core（幂等，可重复调用）。 */
export function installRapfiLoader(): void {
  setGlueUrl(RAPFI_GLUE_URL);
  setLoader(loadRapfiModule);
}
