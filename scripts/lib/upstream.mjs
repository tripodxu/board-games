/**
 * scripts/lib/upstream.mjs — 实验面的「打哪个上游、用哪把 key」的纯逻辑（D12 / G3）
 *
 * 两条运行面：
 *   - `direct`（默认）：box 直连 `https://api.typesafe.ai/v1/systemone`，key 从环境变量或
 *     `/root/.jev-key` 读。**机械保证零 CF 触碰**：不许有 proxy 臂、`store:'d1'` 必须显式给 origin。
 *   - `worker`：老路径，经业主 Worker（proxy 臂 + `--origin`），需要显式声明才启用。
 *
 * 为什么不「顺手把 proxy 当直连用」：`src/core/jev/client.ts:31` 的 proxy 渠道端点是相对路径
 * `api/jev` 且只发 `X-Api-Key`，而直连上游要的是 `Authorization: Bearer`（`:98-106`）。
 * 所以直连用**现成的 official 渠道**（同端点、同 Bearer 协议），身份串也随之诚实写成
 * `official|v14-live3-fresh|0`；与历史 `proxy|…` 轮次协议同构、可比，但不是同一个标签。
 *
 * 纯逻辑：文件读取可注入，单测不碰真实 key、不联网。
 */

import fs from 'node:fs';

/** box 上 key 的落地位置（chmod 600，不进仓库、不进日志）。 */
export const DEFAULT_KEY_FILE = '/root/.jev-key';
/**
 * 自建 jev-router 网关（`https://jev.logicc.top/v1/systemone`）那一臂的 key 落地位置。
 *
 * **刻意不与 DEFAULT_KEY_FILE 共用路径**：批量对弈机（185.242.234.48）正是 jev-router 所在的那台
 * VPS，而那台机器的 `/root/.jev-key` 里装的就是网关的 `jv-` key（2026-10-08 实测首三字符 `jv-`）。
 * 共用路径等于让 `official` 臂把 `jv-` key 当 TypeSafe key 发出去（必 401），且没法在同一台机器上
 * 同时跑两个上游臂。故另开一个文件 + 另一个环境变量。
 */
export const DEFAULT_ROUTER_KEY_FILE = '/root/.jev-router-key';
/**
 * 兜底提供方（commandcode）的 key 文件（C2/D-B4）。与主 key 分开一个文件：两把 key 配额、
 * 归属、失效方式都不同，混在一个文件里会出现「换主 key 顺手把兜底也换了」这种事。
 */
export const DEFAULT_CC_KEY_FILE = '/root/.cc-key';
/** 直连上游时，这些渠道必须拿得到 key 才能开跑。 */
export const KEY_CHANNELS = ['official', 'openrouter', 'proxy', 'jevrouter'];
/** 缺 key 时的提示（别只说「缺 key」，要说清楚该把 key 放哪）。 */
export const KEY_HELP = `直连上游需要 key：优先用环境变量 JEV_API_KEY，其次放 ${DEFAULT_KEY_FILE}（chmod 600，内容可以是裸 key 或 JEV_API_KEY=… 一行）`;
/** jev-router 臂的缺 key 提示（路径与环境变量都跟 TypeSafe 臂不同，写错就 401）。 */
export const ROUTER_KEY_HELP = `jev-router 渠道需要 key：优先用环境变量 JEV_ROUTER_KEY，其次放 ${DEFAULT_ROUTER_KEY_FILE}（chmod 600，内容是 jv- 开头的裸 key；注意别和 TypeSafe 臂的 ${DEFAULT_KEY_FILE} 混了）`;
/** 兜底 key 的提示（没有它 = 不启用切换，老行为；不是错）。 */
export const CC_KEY_HELP = `兜底提供方需要 key：优先用环境变量 COMMANDCODE_API_KEY，其次放 ${DEFAULT_CC_KEY_FILE}（chmod 600，裸 key 一行）`;

const KEY_MIN_LEN = 20;

/**
 * 从 key 文件的文本里取 key。认这几种写法（运维手抖的常见形态都收下，但仍会校验形状）：
 * `export JEV_API_KEY="xxx"` / `JEV_API_KEY=xxx` / `JEV_OR_KEY=xxx` / `Bearer xxx` / 裸 key。
 * 取不到返回 `''`（**不抛**：让调用方决定是不是致命，并给出统一的 KEY_HELP）。
 */
export function parseKeyFile(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^export\s+/, '');
    const m = /^(?:JEV_API_KEY|JEV_ROUTER_KEY|JEV_OR_KEY|KEY|TOKEN)\s*=\s*(.+)$/i.exec(line);
    if (m) line = m[1].trim();
    line = line.replace(/^Bearer\s+/i, '').trim();
    line = line.replace(/^["']|["']$/g, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (/\s/.test(line)) continue; // key 里不该有空白：多半是把注释或说明行当成了 key
    if (line.length < KEY_MIN_LEN) continue;
    return line;
  }
  return '';
}

/**
 * 取本次运行要用的 key。
 * 返回 `{ key, source }`，`source` 为空串表示没找到（调用方按 KEY_HELP / ROUTER_KEY_HELP 早退）。
 * `channel === 'openrouter'` 只认 `JEV_OR_KEY`（不同上游不同配额，不能互相顶替）；
 * `channel === 'jevrouter'` 同理只认 `JEV_ROUTER_KEY`，且默认 key 文件也换成网关那份。
 *
 * `keyFile` 传 `null` 表示「用该渠道的默认文件」，不传（undefined）则沿用调用方的通用默认
 * `/root/.jev-key`——这样既有调用点（experiment-worker 传 plan.keyFile）行为不变，
 * 而只关心渠道的测试可以直接 `resolveRunKey({ channel: 'jevrouter' })`。
 */
export function resolveRunKey({
  env = process.env,
  channel = 'official',
  keyFile = DEFAULT_KEY_FILE,
  readFile = fs.readFileSync,
} = {}) {
  const isRouter = channel === 'jevrouter';
  const envKey = isRouter ? env.JEV_ROUTER_KEY || '' : (channel === 'openrouter' ? env.JEV_OR_KEY || '' : env.JEV_API_KEY || '');
  if (envKey) {
    return { key: envKey, source: isRouter ? 'env:JEV_ROUTER_KEY' : (channel === 'openrouter' ? 'env:JEV_OR_KEY' : 'env:JEV_API_KEY') };
  }
  const file = keyFile === null ? (isRouter ? DEFAULT_ROUTER_KEY_FILE : DEFAULT_KEY_FILE) : keyFile;
  if (!file) return { key: '', source: '' };
  try {
    const key = parseKeyFile(readFile(file, 'utf8'));
    return key ? { key, source: `file:${file}` } : { key: '', source: '' };
  } catch (_) {
    return { key: '', source: '' };
  }
}

/**
 * key 的**形状**自检（纯函数，返回 `''` = 形状对得上，返回字符串 = 拒绝理由）。
 *
 * 为什么需要：批量对弈机与 jev-router 是同一台 VPS，那台机器上既有 TypeSafe 臂的 key 文件、
 * 又有网关的 `jv-` key；放错文件不会立刻报错，而是变成一整轮 401（每局十几分钟才失败一次）。
 * 所以在开局前用前缀形状拦一道——网关 key 必须是 `jv-`，TypeSafe 臂必须不是。
 * 只对这两类**自家**key 生效；OpenRouter / 第三方 key 的前缀不归我们管，不拦。
 */
export function keyShapeProblem(channel, key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (channel === 'jevrouter') {
    return k.startsWith('jv-') ? '' : `jev-router 臂拿到不像网关 key 的东西（应以 jv- 开头）：多半是 TypeSafe 或 OpenRouter 的 key 放错了文件`;
  }
  if (channel === 'official' && k.startsWith('jv-')) {
    return 'official 臂拿到的是 jv- 开头的网关 key（不是 TypeSafe key）：这台机器上两者共存，请改用 jvrouter 臂或换一个 key 文件';
  }
  return '';
}

/**
 * 取兜底的 commandcode key（C2/D-B4）。**取不到不是错**：没有它就是「单提供方、失败照旧抛」
 * 的老行为。所以这里只回 `{ key:'', source:'' }`，不抛、不打印任何 key 片段。
 */
export function resolveBackupKey({ env = process.env, keyFile = DEFAULT_CC_KEY_FILE, readFile = fs.readFileSync } = {}) {
  const fromEnv = env.COMMANDCODE_API_KEY || '';
  if (fromEnv) return { key: fromEnv, source: 'env:COMMANDCODE_API_KEY' };
  if (!keyFile) return { key: '', source: '' };
  try {
    const key = parseKeyFile(readFile(keyFile, 'utf8'));
    return key ? { key, source: `file:${keyFile}` } : { key: '', source: '' };
  } catch (_) {
    return { key: '', source: '' };
  }
}

/**
 * 运行面闸门（纯函数，返回 `null` = 放行，返回字符串 = 拒绝原因）。
 * `originGiven` 指调用方**显式**给了 origin（plan 里有这个字段或 CLI 传了），而不是 DEFAULTS 兜的那个生产地址。
 */
export function upstreamGate({ upstream, store, originGiven, channels = [] }) {
  if (upstream !== 'direct' && upstream !== 'worker') {
    return `--upstream 只认 direct|worker，收到 ${upstream}`;
  }
  if (upstream === 'direct' && channels.includes('proxy')) {
    return 'direct 运行面不用 proxy 臂：proxy 走的是业主 Worker 的相对端点且只发 X-Api-Key；'
      + '直连上游请把它写成 official（同一上游 https://api.typesafe.ai/v1/systemone、同一 Bearer 协议）';
  }
  if (upstream === 'worker' && !originGiven) {
    return '--upstream worker 需要显式 --origin <业主 Worker 地址>（默认直连上游，不替你猜生产地址）';
  }
  if (store === 'd1' && !originGiven) {
    return '--store d1 需要显式 --origin（D11/D12：默认运行面不许碰生产；要归档请明写地址）';
  }
  return null;
}
