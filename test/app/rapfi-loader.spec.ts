/* rapfi-loader.spec.ts — Rapfi 渠道在**浏览器侧**的两处装配（P8 补齐，P6 拆层时漏掉）
 *
 * 这一对缺陷只在真机上现形：mock 渠道不碰 rapfi，纯 Node 层（`test/engines/rapfi.test.mjs`）
 * 又都自己注入假加载器，所以 `tsc` 与全量单测都看不出来。首次发现是 P8 的浏览器冒烟里
 * 「对手也落了子」在 `--channel rapfi` 下超时（mock 渠道通过）：
 *   ① 没人调用 `setLoader`/`setGlueUrl`（约定「P6 的 UI 层负责注入」，实际没有下家），
 *      浏览器里 `_loader` 恒为 null → `ensureLoaded()` 以「无 document」reject；
 *   ② `src/core/jev/index.ts` 没往 `opts` 里塞 rapfi 实现 → client 抛「rapfi 渠道未注入（opts.rapfi）」。
 *
 * 这里用 happy-dom 的真 `document` 走一遍**真实注入路径**（createElement → onload → 工厂），
 * 再跑一次完整的 `decide()`，把两条都钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGame } from '../../src/core/registry.ts';
import { decide } from '../../src/core/jev/index.ts';
import {
  ensureLoaded,
  glueUrl,
  onStdout,
  reset,
  setGlueUrl,
  setLoader,
  setModule,
} from '../../src/core/jev/rapfi.ts';
import type { RapfiModule } from '../../src/core/jev/rapfi.ts';
import {
  RAPFI_ASSET_BASE,
  RAPFI_GLUE_URL,
  installRapfiLoader,
  loadRapfiModule,
} from '../../src/app/rapfi-loader.ts';
import type { RapfiFactory } from '../../src/app/rapfi-loader.ts';

const gomoku = getGame('gomoku');
if (!gomoku) throw new Error('注册表里没有 gomoku，夹具失效');

/** 假 Emscripten Module：`sendCommand` 同步回放预设 stdout 行（命令记在 `sent` 上可断言）。 */
interface FakeModule extends RapfiModule {
  sent: string[];
}

function fakeModule(onOther: (cmd: string) => string[]): FakeModule {
  const mod: FakeModule = {
    sent: [],
    sendCommand(cmd: string): void {
      mod.sent.push(cmd);
      for (const line of onOther(cmd)) onStdout(line);
    },
  };
  return mod;
}

/** 记录工厂收到的东西，并按 Emscripten 约定回一个模块（START 15 必须回 OK）。 */
function fakeFactory(onInit?: (opts: Parameters<RapfiFactory>[0]) => void) {
  const seen: Parameters<RapfiFactory>[0][] = [];
  const factory: RapfiFactory = (opts) => {
    seen.push(opts);
    if (onInit) onInit(opts);
    return Promise.resolve(
      fakeModule((cmd) => {
        if (cmd === 'START 15') { opts.onReceiveStdout('OK'); return []; }
        return [];
      }) as RapfiModule,
    );
  };
  return { factory, seen };
}

/** 装配层注入的脚本：happy-dom 会在 appendChild 时真的去下载脚本（必然失败并抢先 fire onerror），
 *  所以这里把 `document.head.appendChild` 换成只记录的桩——测的是**我们的注入逻辑**
 *  （src / onload / onerror 接线、locateFile、工厂调用），不是 happy-dom 的脚本加载器。 */
const appended: HTMLScriptElement[] = [];
let restoreAppend: (() => void) | null = null;

beforeEach(() => {
  appended.length = 0;
  const head = document.head;
  const orig = head.appendChild.bind(head);
  head.appendChild = ((node: HTMLScriptElement) => {
    appended.push(node);
    return node;
  }) as typeof head.appendChild;
  restoreAppend = () => { head.appendChild = orig; };
});

/** 最近一次注入的脚本（桩不真插 DOM，所以从记录里取）。 */
function injectedScript(): HTMLScriptElement | null {
  const s = appended.length ? appended[appended.length - 1]! : null;
  return s && s.src.endsWith(RAPFI_GLUE_URL) ? s : null;
}

afterEach(() => {
  reset();
  setLoader(null);
  setGlueUrl('');
  vi.unstubAllGlobals();
  if (restoreAppend) { restoreAppend(); restoreAppend = null; }
});

describe('Rapfi 胶水脚本路径', () => {
  it('指向 public/ 的部署路径，.wasm/.data 与脚本同目录', () => {
    expect(RAPFI_GLUE_URL).toBe('/rapfi/rapfi-single-simd128.js');
    expect(RAPFI_ASSET_BASE).toBe('/rapfi/');
    expect(RAPFI_GLUE_URL).toBe('/' + 'rapfi/rapfi-single-simd128.js');
  });

  it('installRapfiLoader() 把加载器与地址装进 core', () => {
    expect(glueUrl()).toBe('rapfi/rapfi-single-simd128.js'); /* core 的默认值 */
    installRapfiLoader();
    expect(glueUrl()).toBe(RAPFI_GLUE_URL);
  });
});

describe('真实注入路径（createElement → onload → 工厂）', () => {
  it('注入 <script>、调 window.Rapfi、把 locateFile 指到 /rapfi/、START 拿到 OK 才算就绪', async () => {
    installRapfiLoader();
    const pending = ensureLoaded();
    const script = injectedScript();
    expect(script, '应在 document.head 注入胶水脚本').not.toBeNull();

    const { factory, seen } = fakeFactory();
    vi.stubGlobal('Rapfi', factory);
    script!.onload!.call(script!, new Event('load'));

    const mod = await pending;
    expect(typeof mod.sendCommand).toBe('function');
    expect(seen).toHaveLength(1);
    /* Emscripten 用 locateFile 找 .wasm/.data：必须落在 /rapfi/ 下，否则线上 404 */
    expect(seen[0]!.locateFile('rapfi-single-simd128.wasm')).toBe('/rapfi/rapfi-single-simd128.wasm');
    expect(seen[0]!.locateFile('rapfi-single-simd128.data')).toBe('/rapfi/rapfi-single-simd128.data');
    /* stdout 必须接回 core 的收集器：START 15 的 OK 就是靠它被看见的 */
    seen[0]!.onReceiveStdout('OK');
    const sent = (mod as unknown as { sent: string[] }).sent;
    expect(sent[0]).toBe('START 15');
    expect(sent[1]).toBe('INFO rule 0');
  });

  it('胶水脚本没有导出工厂时按原话报错', async () => {
    installRapfiLoader();
    const pending = ensureLoaded();
    const script = injectedScript();
    script!.onload!.call(script!, new Event('load'));
    await expect(pending).rejects.toThrow(/未导出工厂函数 Rapfi/);
  });

  it('未注入加载器时就是线上那个症状（无 document）', async () => {
    setLoader(null);
    await expect(ensureLoaded()).rejects.toThrow('当前环境不支持动态加载 Rapfi 脚本（无 document）');
  });

  it('脚本加载失败（404）时把原因带出来', async () => {
    const pending = loadRapfiModule(RAPFI_GLUE_URL);
    const script = injectedScript();
    expect(script, 'loadRapfiModule 也应注入脚本').not.toBeNull();
    /* happy-dom 不会真去下载，手动触发 onerror 模拟 404 */
    script!.onerror!.call(script!, new Event('error'));
    await expect(pending).rejects.toThrow(/Rapfi 脚本加载失败/);
  });
});

describe('decide() 渠道装配', () => {
  it('rapfi 渠道能真的走出一步（不再抛「rapfi 渠道未注入」）', async () => {
    const st = gomoku.newGame();
    reset();
    setModule(fakeModule((cmd) => (/^BOARD/.test(cmd) ? ['7,7'] : [])));
    const d = await decide(gomoku, st, 'black', { channel: 'rapfi', rapfiThinkMs: 1000 });
    expect(d.notation).toBe('H8');
    expect((d.meta as { channel?: string }).channel).toBe('rapfi');
    expect((d.meta as { thinkMs?: number }).thinkMs).toBe(1000);
  });
});
