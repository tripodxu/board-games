/* providers.ts — 上游提供方表与失败切换策略（C2 / plan 2026-10-03-cands-metric-and-provider-failover）
 *
 * 背景：主上游（TypeSafe `api.typesafe.ai`）会以 401/402/403（key 或额度）、429（限流）、
 * 5xx（上游故障）三种方式打死一整局——机机对局里一次失败就是整局停摆。C1 探针（2026-10-03）
 * 实测 commandcode 的 `/provider/v1/systemone` 与**我方协议逐字段同形**（同一个 `state`/`questions`/
 * `options` 请求、同一套 `answers.*.probabilities` 响应），所以兜底**不需要协议适配器**，
 * 切换 = 「base URL + model + key」三元组替换。
 *
 * ── 为什么这一层是纯函数 ────────────────────────────────────────────────
 * 两个运行面（Worker 转发、box/Node 直连）必须用**同一套**切换判据，否则「实验面能兜底、
 * 生产面兜不住」这种差异会直接污染实验结论。纯函数还让 401/429/5xx 三条触发能在单测里
 * 逐条钉住，不必真发请求烧额度（`AGENTS.md` 规则 3：core 不直接 IO，fetch 由调用侧注入）。
 *
 * ── 与计划的对应 ──────────────────────────────────────────────────────
 * D-B1 表 + `pickProvider(failures, stickyId)`；D-B2 三条触发 + 切换前探活 + **局内粘滞**；
 * D-B3 降级要诚实（`probSource`，见 `client.ts`）；D-B5 兜底模型 `typesafe/jev`；
 * D-B6 不改 `channel`，另记逐手 `provider`。
 */

/** 提供方协议种类。`openai-chat` 是**设计位**：将来接一个非 systemone 网关时才需要适配器，
 *  现在不实现（C1 已证明现有两路同形）。 */
export type ProviderKind = 'systemone' | 'openai-chat';

/** key 的来源名：与 `CHANNELS` 的 `keyName` 同词表，便于调用侧把 key 对上提供方。 */
export type ProviderKeySource = 'official' | 'commandcode';

export interface ProviderConfig {
  /** 稳定 id（进归档与日志，只许小写短词） */
  id: string;
  /** 面向用户/报表的中文标签 */
  label: string;
  /** `POST` 端点（systemone 同形端点） */
  url: string;
  /** 该提供方要求的模型名（**不能混用**：主家是 `jev-latest`，兜底是 `typesafe/jev`） */
  model: string;
  keySource: ProviderKeySource;
  kind: ProviderKind;
  /** 切换前探活用 `GET`（D-B2）。不带 body、只判「网关与 key 活着」 */
  probeUrl: string;
}

/** 主提供方 id（TypeSafe 官方端点）。 */
export const PROVIDER_PRIMARY = 'primary';
/** 兜底提供方 id（commandcode 网关，模型 `typesafe/jev`）。 */
export const PROVIDER_BACKUP = 'backup';

/**
 * 提供方表（顺序即优先级）。
 *
 * ⚠️ `probeUrl` 只探「网关 + key 活着」：C1 实测 commandcode 的 `GET /provider/v1/models`
 * **不列 `typesafe/jev`**（85 个模型里没有它），所以清单不能用来判断可用性——探活通过
 * 不等于模型可用，真正的判据仍是那次 `POST` 的结果。
 */
export const PROVIDERS: readonly ProviderConfig[] = [
  {
    id: PROVIDER_PRIMARY,
    label: 'TypeSafe 官方',
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    keySource: 'official',
    kind: 'systemone',
    probeUrl: 'https://api.typesafe.ai/v1/models',
  },
  {
    id: PROVIDER_BACKUP,
    label: 'commandcode 兜底',
    url: 'https://api.commandcode.ai/provider/v1/systemone',
    model: 'typesafe/jev',
    keySource: 'commandcode',
    kind: 'systemone',
    probeUrl: 'https://api.commandcode.ai/provider/v1/models',
  },
];

export function providerOf(id: string | null | undefined): ProviderConfig | null {
  if (typeof id !== 'string' || !id) return null;
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * 同源代理面上的两个自定义头：
 *   - 请求头 `X-Jev-Provider` = 客户端告诉 Worker「本局我已经押在谁身上」（粘滞，可缺省）；
 *   - 响应头 `X-Jev-Provider` = Worker 回报「这一手实际是谁答的」（客户端据此归因）；
 *   - 响应头 `X-Jev-Provider-Switch` = 发生切换时的原因（只给人看，判据在状态码里）。
 *
 * 名字定义在**叶模块**里：Worker 面与浏览器面都要用，谁都不该为了拿两个字符串去 import 对方
 * （Worker 引 `client.ts` 会把整条战术链拉进包里）。
 */
export const PROVIDER_HINT_HEADER = 'X-Jev-Provider';
export const PROVIDER_SWITCH_HEADER = 'X-Jev-Provider-Switch';

/** 缺省提供方（表里第一个）。表永不为空，所以这里一定拿得到。 */
export function defaultProvider(): ProviderConfig {
  return PROVIDERS[0] as ProviderConfig;
}

export function providerByKeySource(source: ProviderKeySource): ProviderConfig | null {
  return PROVIDERS.find((p) => p.keySource === source) ?? null;
}

/** 除 `id` 之外的提供方（切换候选，按表顺序）。 */
export function otherProviders(id: string): ProviderConfig[] {
  return PROVIDERS.filter((p) => p.id !== id);
}

/* ------------------------------------------------------------------ *
 * 失败分类
 * ------------------------------------------------------------------ */

/**
 * 失败类别。刻意与「触发哪条切换」一一对应，而不是照抄 HTTP 状态码：
 *  - `auth`       = 401/402/403：key 无效、无权限、额度用尽 —— **立刻切**（重试没有意义）；
 *  - `rate-limit` = 429/529：**重试用尽后**才切（窗口会过去，先按 `Retry-After` 熬）；
 *  - `server`     = 5xx：**连续 3 次**才切（单次 5xx 常是上游抖动）；
 *  - `client`     = 其余 4xx：**不切**（把请求发坏了，换一家也一样坏）。
 *
 * 网络错误/超时**不进这张表**：它们是传输层抖动，由重试阶梯处理，切换只会放大成本（D-B2）。
 */
export type FailureClass = 'auth' | 'rate-limit' | 'server' | 'client';

/** `null` = 不该被当成「提供方失败」（2xx/3xx）。 */
export function classifyStatus(status: number): FailureClass | null {
  if (!Number.isFinite(status)) return null;
  if (status >= 200 && status < 400) return null;
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 429 || status === 529) return 'rate-limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return null;
}

/** 各类别是否**可能**触发切换（真正切不切还要看备用是否存在、探活是否通过）。 */
export function isSwitchable(cls: FailureClass): boolean {
  return cls === 'auth' || cls === 'rate-limit' || cls === 'server';
}

/** 5xx 连续几次才切（D-B2）。 */
export const SERVER_FAILURE_LIMIT = 3;

export function failureClassLabel(cls: FailureClass): string {
  switch (cls) {
    case 'auth':
      return '鉴权/额度失败（401/402/403）';
    case 'rate-limit':
      return '限流重试用尽（429/529）';
    case 'server':
      return `上游故障（连续 ${SERVER_FAILURE_LIMIT} 次 5xx）`;
    default:
      return '请求本身有问题（其余 4xx）';
  }
}

/* ------------------------------------------------------------------ *
 * 每提供方的失败状态（不可变：每次返回新对象）
 * ------------------------------------------------------------------ */

export interface ProviderState {
  /** 连续失败次数（成功即清零） */
  consecutive: number;
  /** 累计失败次数（只用于报表/日志，不参与判据） */
  total: number;
  /** 已判死：本局不再选它 */
  dead: boolean;
  lastClass: FailureClass | null;
  /** 判死原因（中文，进日志与 `events.jsonl`），未判死为 null */
  deadReason: string | null;
}

export type ProviderStates = Record<string, ProviderState>;

function blankState(): ProviderState {
  return { consecutive: 0, total: 0, dead: false, lastClass: null, deadReason: null };
}

export function newProviderStates(): ProviderStates {
  const states: ProviderStates = {};
  for (const p of PROVIDERS) states[p.id] = blankState();
  return states;
}

export function stateOf(states: ProviderStates, id: string): ProviderState {
  return states[id] ?? blankState();
}

/** 克隆一份状态对象并把 `id` 换成新的一份（纯函数用，调用侧拿到的永远是同一形状）。 */
function withState(states: ProviderStates, id: string, next: ProviderState): ProviderStates {
  return { ...states, [id]: next };
}

/** 成功：清零连续失败（`dead` 不复活——粘滞语义下判死是本局的终局）。 */
export function noteSuccess(states: ProviderStates, id: string): ProviderStates {
  const cur = stateOf(states, id);
  return withState(states, id, { ...cur, consecutive: 0, lastClass: null });
}

export interface FailureNote {
  states: ProviderStates;
  /** 是否该切走（类别可切 + 达到该类别的阈值） */
  switchAway: boolean;
  /** 人话原因（进日志 / `onProviderSwitch` / `events.jsonl`） */
  reason: string;
}

/**
 * 记一次提供方失败。
 *
 * `exhausted`：调用侧的退避/重试阶梯**已经用完**才由调用侧声明。限流类必须显式声明才切
 * ——重试阶梯还在跑就切换，会把「等 3 秒就能过」的窗口变成一次无谓的兜底计费；5xx 同理可传，
 * 因为直连面的 `callWithRetry` 已经在同一家内部连试到阈值才把错抛出来（那时这里的
 * `consecutive` 只记到 1，靠 `exhausted` 才能表达「本家已经连续 3 次 5xx」）。
 */
export function noteFailure(
  states: ProviderStates,
  id: string,
  cls: FailureClass,
  opts: { status?: number; exhausted?: boolean } = {},
): FailureNote {
  const cur = stateOf(states, id);
  const consecutive = cur.consecutive + 1;
  const status = typeof opts.status === 'number' ? `HTTP ${opts.status}` : failureClassLabel(cls);
  let dead = cur.dead;
  let switchAway = false;
  let reason = '';

  if (cls === 'auth') {
    dead = true; switchAway = true;
    reason = `${status}：key 或额度（不重试，直接切）`;
  } else if (cls === 'rate-limit') {
    if (opts.exhausted) {
      dead = true; switchAway = true;
      reason = `${status}：退避重试已用尽`;
    } else {
      reason = `${status}：仍在退避重试`;
    }
  } else if (cls === 'server') {
    if (opts.exhausted) {
      dead = true; switchAway = true;
      reason = `${status}：连续 ${SERVER_FAILURE_LIMIT} 次 5xx（本家重试用尽）`;
    } else if (consecutive >= SERVER_FAILURE_LIMIT) {
      dead = true; switchAway = true;
      reason = `${status}：连续 ${consecutive} 次 5xx`;
    } else {
      reason = `${status}：连续 ${consecutive}/${SERVER_FAILURE_LIMIT} 次 5xx`;
    }
  } else {
    reason = `${status}：请求本身有问题，不切换`;
  }

  const next: ProviderState = {
    consecutive,
    total: cur.total + 1,
    dead: dead || switchAway,
    lastClass: cls,
    deadReason: switchAway ? reason : cur.deadReason,
  };
  return { states: withState(states, id, next), switchAway, reason };
}

/* ------------------------------------------------------------------ *
 * 选择
 * ------------------------------------------------------------------ */

/**
 * 本次该用哪个提供方（D-B1 签名的实现）。
 *
 * 两条规则，顺序不可换：
 *  1. **粘滞优先**：`stickyId` 指定了就照办——「同一局内粘滞，不回切」（D-B2），哪怕主家
 *     已经恢复也不回切：一局棋被切成两半，比分桶本身更难解释。
 *  2. 否则**表顺序里第一个还活着的**；全死了就回落表里第一个（最后一搏，调用侧会拿到
 *     已被标记的 `states`，可以据此如实记账）。
 */
export function pickProvider(states: ProviderStates, stickyId?: string | null): ProviderConfig {
  const sticky = providerOf(stickyId);
  if (sticky) return sticky;
  for (const p of PROVIDERS) {
    if (!stateOf(states, p.id).dead) return p;
  }
  return defaultProvider();
}

/** 还活着的提供方 id（报表/日志用）。 */
export function liveProviderIds(states: ProviderStates): string[] {
  return PROVIDERS.filter((p) => !stateOf(states, p.id).dead).map((p) => p.id);
}

/** 切换事件（`onProviderSwitch` 的载荷；进日志与 `events.jsonl`）。 */
export interface ProviderSwitchInfo {
  from: string;
  to: string;
  /** 中文化原因（`failureClassLabel` 的同类词表） */
  reason: string;
  /** 探活耗时（ms）；未探活为 null */
  probeMs: number | null;
  /** 探活状态码；未探活为 null */
  probeStatus: number | null;
}

/** 一行中文日志（Worker 与 box 用同一句，排障时两边能对上）。 */
export function formatProviderSwitch(info: ProviderSwitchInfo): string {
  const from = providerOf(info.from);
  const to = providerOf(info.to);
  return `上游切换 ${info.from}(${from ? from.label : '?'}) ⇒ ${info.to}(${to ? to.label : '?'})`
    + `｜原因：${info.reason}`
    + (info.probeStatus === null ? '｜未探活' : `｜探活 HTTP ${info.probeStatus}（${info.probeMs ?? '?'}ms）`);
}

/** 逐手 `provider` 的展示名（报表用；未知 id 原样返回）。 */
export function providerLabel(id: string | null | undefined): string {
  const p = providerOf(id);
  return p ? p.label : (typeof id === 'string' && id ? id : '');
}
