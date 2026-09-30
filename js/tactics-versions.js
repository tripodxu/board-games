/* tactics-versions.js — 战术层版本登记表（复现与对比实验的唯一事实来源）
 *
 * 为什么存在：战术层是 9 次提交逐层累加上线的，没有登记表就无法回答
 * 「这个版本为什么强/弱」，实验也无法按版本归因。机制键与 jev-client 接管链一一对应
 * （优先级从高到低，用户 m00302）：
 *   win > block > open4 > threat > vcfAttack > vcfDefense > parry > parry3 > parry4
 * 附加键：safeSort = 拆杀点并存时 3-ply 试走挑最安全（v5, 87beda6）；
 *         vcfTry   = vcfDefense 链首占不住时逐点试干预（v8, 9cf4a88）；
 *         sound    = vcfWin 伪胜闸门（引擎侧 gomoku.defenderWinsFull，v9, a16fdd9）。
 *
 * 权威来源：git 历史（版本边界只认 commit 时间，git log %ci 为北京时间）× 棋谱数据
 * （棋谱 exported 落库时刻换算北京时间定窗口，moves[].tactics 标签实证机制下限：
 *  parry3 ⇒ ≥v4，parry4 ⇒ ≥v6，vcfAttack/vcfDefense ⇒ ≥v7）。
 * 版本一版都不能少；v0-off 是数据驱动的基线（战术层上线前，暂无归档棋谱）。
 *
 * 纯数据 + 纯函数，无 DOM 依赖；eval 进 window(BG) 或 Node 全局 BG（test/run-tests.js）。
 */
(function () {
  const BG = (typeof window !== 'undefined' && window.BG) || globalThis.BG;
  if (!BG || !BG.util) throw new Error('tactics-versions.js 必须在 board.js 之后加载');

  /* commitAt = git log %ci 实测（北京时间）；games = 归档棋谱局数（合计应等于 games/ 全部 28 局）。 */
  const VERSIONS = [
    { id: 'v0-off', name: '无战术基线', rank: 0, commit: '678b701 之前', commitAt: '2026-09-29 14:21 前',
      date: '2026-09-29', mech: {}, games: 0,
      note: '基线：战术层上线前纯概率走子（92e38e6→1da4d8a 区间）。战术层上线前的对局未归档棋谱，games=0；此档仍须在表内——它是「战术层净贡献」归因的对照组。' },
    { id: 'v1-facts', name: '胜/挡', rank: 1, commit: '678b701', commitAt: '2026-09-29 14:21',
      date: '2026-09-29', mech: { win: true, block: true }, games: 0,
      note: '战术保险初版：自己一步能赢直接赢，对方一步能赢必须挡。无归档棋谱（新版实验设施补测对象）。' },
    { id: 'v2-open4', name: '活四级', rank: 2, commit: '15996b1', commitAt: '2026-09-29 16:08',
      date: '2026-09-29', mech: { win: true, block: true, open4: true }, games: 0,
      note: 'criteria 战术标签契约：引擎代读棋盘打标签，活三/活四识别不再靠模型猜。无归档棋谱。' },
    { id: 'v3-make2', name: '造杀/拆杀', rank: 3, commit: 'e086742', commitAt: '2026-09-29 16:39',
      date: '2026-09-29', mech: { win: true, block: true, open4: true, threat: true, parry: true }, games: 0,
      note: '2-ply 扩展（用户补丁）：threat 造杀点（自己两步胜）+ parry 拆杀点（对方双杀点）。无归档棋谱。' },
    { id: 'v4-parry3', name: '活三预挡', rank: 4, commit: 'd10fd1f', commitAt: '2026-09-29 17:11',
      date: '2026-09-29', mech: { win: true, block: true, open4: true, threat: true, parry: true, parry3: true }, games: 0,
      note: '败局复盘驱动：抢 deny:open4/deny:live3 标签点。与 v5 仅差 safeSort 内部排序，棋谱标签不可分——按落库时间归 v5 窗口（21 局）。' },
    { id: 'v5-safesort', name: '拆杀安全排序', rank: 5, commit: '87beda6', commitAt: '2026-09-29 17:41',
      date: '2026-09-29', mech: { win: true, block: true, open4: true, threat: true, parry: true, parry3: true, safeSort: true }, games: 21,
      note: '层数不变，parry 层内部升级：多 danger 并存时 3-ply 试走挑最安全的。9/29 17:51–19:28 落库 21 局（11 局人机/机机 + 10 局 exp-20260929105234/exp-20260929111222，proxy vs random），parry3 标签实证 ≥v4。' },
    { id: 'v6-parry4', name: '冲四预挡', rank: 6, commit: 'f48d052', commitAt: '2026-09-30 10:42',
      date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, parry: true, parry3: true, safeSort: true, parry4: true }, games: 0,
      note: 'deny:four 冲四预挡（Rapfi 复盘：放任冲四制造点会被连续单杀逼迫）；同期加入禁手模式 gomoku-pro。与 v7 相隔 1 分钟，无归档棋谱。' },
    { id: 'v7-vcf', name: 'VCF 攻防', rank: 7, commit: '57a9508', commitAt: '2026-09-30 10:43',
      date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true }, games: 4,
      note: 'VCF 威胁空间搜索接入：7 ply / 4000 节点，层数 5→9，vcfAttack/vcfDefense 插在 threat 与 parry 之间。exp-20260930025135（proxy vs rapfi，10:53–10:57 落库）4 局，vcfAttack/vcfDefense 标签实证。' },
    { id: 'v8-vcf-try', name: 'VCF 逐点试', rank: 8, commit: '9cf4a88', commitAt: '2026-09-30 11:41',
      date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true }, games: 3,
      note: '层数不变，vcfDefense 补丁：链首占不住时逐点试干预。exp-20260930084500（proxy vs rapfi，16:46–16:54 落库）3 局=线上旧引擎，均无 meta，反证部署版本停滞在此档。' },
    { id: 'v9-vcf-sound', name: '防伪胜（当前）', rank: 9, commit: 'a16fdd9', commitAt: '2026-09-30 16:58',
      date: '2026-09-30', mech: { win: true, block: true, open4: true, threat: true, vcfAttack: true, vcfDefense: true, parry: true, parry3: true, parry4: true, safeSort: true, vcfTry: true, sound: true }, games: 0,
      note: 'vcfWin soundness 修复：引擎层双杀短路前过守方反杀闸门（gomoku.defenderWinsFull）+ 棋谱归因 meta（codeVersion/aiMoveMeta/aiGameMeta）。当前档，待新实验设施补测。' },
  ];
  const CURRENT = 'v9-vcf-sound';
  const BY_ID = {};
  VERSIONS.forEach((v) => { BY_ID[v.id] = v; });

  /** 解析档位：falsy → 当前档；未知 id → 当前档（写错档号静默回退，联名/对局都不能因它崩）。 */
  function resolve(id) {
    if (id == null || id === '') return BY_ID[CURRENT];
    return BY_ID[String(id)] || BY_ID[CURRENT];
  }

  /* ---------- 归档棋谱按版本归位 ----------
   * server.js / Pages Function 的棋谱文件名一律 <gid>-<stamp>.json，stamp 由
   * body.exported 生成（`iso.slice(0,19).replace(/[-:T]/g,'')`，14 位 UTC 数字）。
   * 于是「这局跑的是哪一版战术」可以直接从文件名推出来：stamp 落在
   * [本档 commitAt, 下一档 commitAt) 区间内即归属本档。commitAt 是北京时间
   * （git log %ci），减 8 小时换 UTC 才能和文件名里的 stamp 比。
   * v0-off 没有 commit：它是 v1 之前的全部时间，区间起点取 0。 */
  function stampUtcStart(v) {
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(v.commitAt || '');
    if (!m) return 0;
    /* 北京时间 → UTC：减 8 小时。Date.UTC 再成 14 位，保证和文件名 stamp 同格式可比 */
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 8 * 3600e3;
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return +('' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
      + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()));
  }
  const WINDOWS = VERSIONS.map((v, i) => ({
    id: v.id,
    /* v0-off 是「战术层上线前」的兜底档：窗口起点恒为 0，v1 之前的一切都归它 */
    from: i === 0 ? 0 : stampUtcStart(v),
    to: i + 1 < VERSIONS.length ? stampUtcStart(VERSIONS[i + 1]) : Number.MAX_SAFE_INTEGER,
  }));
  /** 文件名（或纯 stamp）→ 归属档位 id；解析不出 stamp（早期 gid 命名等）→ null。 */
  function versionForFileStamp(nameOrStamp) {
    const m = /(\d{14})/.exec(String(nameOrStamp || ''));
    if (!m) return null;
    const s = +m[1];
    for (const w of WINDOWS) if (s >= w.from && s < w.to) return w.id;
    return null;
  }
  /** 机制闸门：该版本没有的机制必须整条跳过（computeTactics 与接管链共用）。 */
  function allows(version, mech) {
    return !!version && !!version.mech[mech];
  }

  function selfTest() {
    const U = BG.util.assert;
    const MECHS = ['win', 'block', 'open4', 'threat', 'vcfAttack', 'vcfDefense', 'parry', 'parry3', 'parry4', 'safeSort', 'vcfTry', 'sound'];
    U(VERSIONS.length === 10, '应登记 9 个战术版本 + 1 基线，实际 ' + VERSIONS.length);
    U(CURRENT === VERSIONS[VERSIONS.length - 1].id, '当前档必须是最后一档');
    VERSIONS.forEach((v, i) => {
      U(v.rank === i, v.id + ' rank 不连续');
      U(typeof v.commit === 'string' && v.commit.length > 0, v.id + ' 缺引入提交');
      U(typeof v.commitAt === 'string' && v.commitAt.length > 0, v.id + ' 缺引入时间');
      U(typeof v.note === 'string' && v.note.length > 0, v.id + ' 缺实战依据');
      U(Number.isInteger(v.games) && v.games >= 0, v.id + ' games 必须是非负整数');
    });
    for (let i = 1; i < VERSIONS.length; i++)
      for (const k of MECHS)
        if (VERSIONS[i - 1].mech[k]) U(!!VERSIONS[i].mech[k], VERSIONS[i].id + ' 丢了上级机制 ' + k);
    /* 归位窗口：单调不减、v0 从 0 起、末档无上界（写错 commitAt 会让棋谱归错版本） */
    for (let i = 1; i < WINDOWS.length; i++)
      U(WINDOWS[i - 1].to === WINDOWS[i].from, VERSIONS[i].id + ' 窗口与上一档不衔接');
    U(WINDOWS[0].from === 0, 'v0-off 窗口起点应为 0');
    U(WINDOWS[WINDOWS.length - 1].to === Number.MAX_SAFE_INTEGER, '末档窗口应无上界');
  }

  BG.tacticsVersions = {
    VERSIONS, CURRENT,
    MECHS: Object.freeze(['win', 'block', 'open4', 'threat', 'vcfAttack', 'vcfDefense', 'parry', 'parry3', 'parry4', 'safeSort', 'vcfTry', 'sound']),
    resolve, allows, ids: () => VERSIONS.map((v) => v.id), selfTest,
    versionForFileStamp, WINDOWS,
  };
})();
