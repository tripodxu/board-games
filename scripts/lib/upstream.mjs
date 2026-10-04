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
/** 直连上游时，这些渠道必须拿得到 key 才能开跑。 */
export const KEY_CHANNELS = ['official', 'openrouter', 'proxy'];
/** 缺 key 时的提示（别只说「缺 key」，要说清楚该把 key 放哪）。 */
export const KEY_HELP = `直连上游需要 key：优先用环境变量 JEV_API_KEY，其次放 ${DEFAULT_KEY_FILE}（chmod 600，内容可以是裸 key 或 JEV_API_KEY=… 一行）`;

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
    const m = /^(?:JEV_API_KEY|JEV_OR_KEY|KEY|TOKEN)\s*=\s*(.+)$/i.exec(line);
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
 * 返回 `{ key, source }`，`source` 为空串表示没找到（调用方按 KEY_HELP 早退）。
 * `channel === 'openrouter'` 只认 `JEV_OR_KEY`（不同上游不同配额，不能互相顶替）。
 */
export function resolveRunKey({ env = process.env, channel = 'official', keyFile = DEFAULT_KEY_FILE, readFile = fs.readFileSync } = {}) {
  const asOfficial = env.JEV_API_KEY || '';
  const asOpenrouter = env.JEV_OR_KEY || '';
  const fromEnv = channel === 'openrouter' ? asOpenrouter : asOfficial;
  if (fromEnv) return { key: fromEnv, source: channel === 'openrouter' ? 'env:JEV_OR_KEY' : 'env:JEV_API_KEY' };
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
