/* rapfi-node-loader.mjs — Node 侧的 Rapfi 胶水脚本加载器（P4）。
 *
 * 浏览器侧（`src/app/rapfi-loader.ts`）靠 `document.createElement('script')` 注入
 * `public/rapfi/rapfi-single-simd128.js`，Emscripten 再经 HTTP 拉 `.wasm`/`.data`。
 * 远端 SSH 主机上没有浏览器，这里换成同等的 Node 实现：
 *
 *  1. 胶水脚本是 UMD（尾部 `module.exports = Rapfi`），但不能直接 require 仓库里的
 *     `.js`：package.json 是 `type: module`，Node 会按 ESM 解析它，UMD 分支失效
 *     （`var Rapfi=...` 只会留在模块作用域里）。复制成 `.cjs` 就能走 CommonJS 分支。
 *  2. Emscripten 在 Node 下用 `__dirname` 定位 `.wasm`/`.data`（`locateFile` 也按
 *     目录解析），所以把 `.cjs` 胶水和两份资产放进同一个临时目录，软链回 public/rapfi
 *     （10MB 的 .data 不复制）。
 *  3. 产物通过 `setLoader` 注入 core（`src/core/jev/rapfi.ts:79`），协议/状态机与
 *     浏览器完全同一条代码路径——这正是 Node vs 浏览器一致率 gate 的前提。
 *
 * 已知差异（gate 要量的东西）：无 `document`（胶水用可选链兼容）、
 * `coord_conversion_mode = "X_flipY"` 等配置随 .data 一起打包与浏览器相同、
 * 单线程 + `INFO timeout_turn` 走墙钟，因此两次运行的节点数可能不同
 * ⇒ gate 判据是「逐手一致率 ≥99%」而不是 100%。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { onStdout, setGlueUrl, setLoader, stderrHandler } from '../../src/core/jev/rapfi.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const RAPFI_DIR = path.resolve(REPO_ROOT, 'public/rapfi');
const GLUE_SRC = path.join(RAPFI_DIR, 'rapfi-single-simd128.js');

let _tmpDir = null;

/** 找齐三件套，缺一个就早失败（错误信息要能直接指导用户去补文件）。 */
function checkAssets() {
  for (const f of ['rapfi-single-simd128.js', 'rapfi-single-simd128.wasm', 'rapfi-single-simd128.data']) {
    const p = path.join(RAPFI_DIR, f);
    if (!fs.existsSync(p)) throw new Error(`public/rapfi/${f} 不存在（Rapfi 资产三件套需完整）`);
  }
  return RAPFI_DIR;
}

/** 把胶水以 CJS 形式加载出来（UMD 尾部会 module.exports = Rapfi）。 */
function requireFactory() {
  checkAssets();
  if (!_tmpDir) {
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapfi-glue-'));
    fs.copyFileSync(GLUE_SRC, path.join(_tmpDir, 'rapfi.cjs'));
    for (const ext of ['wasm', 'data']) {
      const target = path.join(RAPFI_DIR, 'rapfi-single-simd128.' + ext);
      const link = path.join(_tmpDir, 'rapfi-single-simd128.' + ext);
      try {
        fs.symlinkSync(target, link);
      } catch {
        /* Windows 无管理员权限时建不了软链（EPERM）→ 退回复制（10MB，一次性） */
        fs.copyFileSync(target, link);
      }
    }
    /* Node 退出时清理；软链不会误删源文件 */
    const dir = _tmpDir;
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  }
  const req = createRequire(path.join(_tmpDir, 'anchor.cjs'));
  const mod = req(path.join(_tmpDir, 'rapfi.cjs'));
  const factory = mod && mod.default ? mod.default : mod;
  if (typeof factory !== 'function') throw new Error('Rapfi 胶水脚本未导出工厂函数');
  return factory;
}

/** 与浏览器 `loadRapfiModule(url, onProgress)` 同形的 Node 加载器。 */
export async function loadRapfiNode(_url, onProgress) {
  if (typeof onProgress === 'function') { try { onProgress('script'); } catch { /* ignore */ } }
  const factory = requireFactory();
  if (typeof onProgress === 'function') { try { onProgress('wasm'); } catch { /* ignore */ } }
  const mod = await factory({
    locateFile: (p) => path.join(RAPFI_DIR, p),
    onReceiveStdout: (line) => onStdout(line),
    onReceiveStderr: (line) => stderrHandler(line),
  });
  if (!mod || typeof mod.sendCommand !== 'function') {
    throw new Error('Rapfi 引擎实例化失败（Module 无 sendCommand）');
  }
  return mod;
}

/** 一次性装配：此后 core 的 rapfi 渠道在 Node 下也能真走子。 */
export function installRapfiNodeLoader() {
  setGlueUrl(GLUE_SRC);
  setLoader(loadRapfiNode);
}

/** 冒烟：START 15 → OK、INFO rule 0、空盘一手 BOARD → 应有着法行。 */
export async function smokeTest() {
  const factory = requireFactory();
  const mod = await factory({
    locateFile: (p) => path.join(RAPFI_DIR, p),
    onReceiveStdout: () => { /* ignore */ },
    onReceiveStderr: () => { /* ignore */ },
  });
  const seen = [];
  mod.sendCommand('START 15');
  mod.sendCommand('INFO rule 0');
  mod.sendCommand('BOARD\n7,7,1\n7,8,2\nDONE');
  return { seen };
}
