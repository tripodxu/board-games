import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isArtifact,
  collectArtifacts,
  keyFor,
  defaultPrefix,
  requireBucketCfg,
  pushArtifacts,
  main,
} from '../../scripts/batch-bucket.mjs';
import { sha256Hex } from '../../scripts/lib/s3-put.mjs';

/** 一份完整的桶凭据（测试用假 key，与 s3-put.spec.mjs 同一套文档示例值）。 */
const ENV = {
  BUCKET_ENDPOINT: 'https://s3.amazonaws.com',
  BUCKET_NAME: 'board-games',
  BUCKET_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  BUCKET_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  BUCKET_ADDRESSING: 'path',
};

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-spec-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function mk(rel, body = 'x') {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

describe('batch-bucket 白名单', () => {
  it('收研究产物，不收过程垃圾', () => {
    expect(isArtifact('games.jsonl')).toBe(true);
    expect(isArtifact('elo.json')).toBe(true);
    expect(isArtifact('report.md')).toBe(true);
    expect(isArtifact('plans/round-2.json')).toBe(true);
    expect(isArtifact('round-1/progress.json')).toBe(true);
    expect(isArtifact('round-1/events.jsonl')).toBe(true);
    expect(isArtifact('round-1/round-summary.json')).toBe(true);
    /* 逐局 JSON 能由 games.jsonl 重建；pid/日志/notes 是过程垃圾。 */
    expect(isArtifact('round-1/games/round-1-game-1.json')).toBe(false);
    expect(isArtifact('round-1/checkpoint/round-1-game-1.json')).toBe(false);
    expect(isArtifact('logs/round-1.log')).toBe(false);
    expect(isArtifact('plans/round-1.pid')).toBe(false);
    expect(isArtifact('round-1/notes.txt')).toBe(false);
  });

  it('collectArtifacts：递归收集、白名单过滤、相对路径统一用 /、按字典序', () => {
    mk('games.jsonl');
    mk('elo.json');
    mk('report.md');
    mk('logs/round-1.log');
    mk('plans/round-1.json');
    mk('plans/round-1.pid');
    mk('round-1/games.jsonl');
    mk('round-1/progress.json');
    mk('round-1/events.jsonl');
    mk('round-1/round-summary.json');
    mk('round-1/report.md');
    mk('round-1/notes.txt');
    mk('round-1/games/round-1-game-1.json');
    mk('round-1/checkpoint/round-1-game-1.json');
    const files = collectArtifacts(dir);
    expect(files.map((f) => f.rel)).toEqual([
      'elo.json',
      'games.jsonl',
      'plans/round-1.json',
      'report.md',
      'round-1/events.jsonl',
      'round-1/games.jsonl',
      'round-1/progress.json',
      'round-1/report.md',
      'round-1/round-summary.json',
    ]);
    /* 相对路径一律 `/`：Windows 上 path.join 会给 `\`，拼 key 必须换掉。 */
    for (const f of files) expect(f.rel).not.toContain('\\');
    /* 大小能从 stat 带出来（push 的日志要报字节数）。 */
    const games = files.find((f) => f.rel === 'games.jsonl');
    expect(games.size).toBe(1);
  });

  it('空目录给空清单，不抛', () => {
    expect(collectArtifacts(dir)).toEqual([]);
  });
});

describe('batch-bucket 前缀与凭据', () => {
  it('keyFor 归一前后斜杠；defaultPrefix 按批量名', () => {
    expect(keyFor('ladders/b1', 'games.jsonl')).toBe('ladders/b1/games.jsonl');
    expect(keyFor('/ladders/b1/', 'plans/round-1.json')).toBe('ladders/b1/plans/round-1.json');
    expect(keyFor('', 'elo.json')).toBe('elo.json');
    expect(keyFor(null, 'elo.json')).toBe('elo.json');
    expect(defaultPrefix('exp-1')).toBe('ladders/exp-1');
  });

  it('凭据缺失点名缺失项；齐全时给出 cfg', () => {
    expect(() => requireBucketCfg({})).toThrow(/缺少桶凭据：BUCKET_ENDPOINT \/ BUCKET_NAME \/ BUCKET_ACCESS_KEY_ID \/ BUCKET_SECRET_ACCESS_KEY/);
    expect(() => requireBucketCfg({ ...ENV, BUCKET_NAME: '' })).toThrow(/BUCKET_NAME/);
    const cfg = requireBucketCfg(ENV);
    expect(cfg).toMatchObject({
      endpoint: 'https://s3.amazonaws.com',
      bucket: 'board-games',
      region: 'auto',
      addressing: 'path',
    });
  });

  it('main：缺凭据 exit 3（区别于用法错 2），且不抛', async () => {
    mk('games.jsonl');
    const code = await main(['push', '--batch', 'b1', '--dir', dir], {});
    expect(code).toBe(3);
    expect(await main([], {})).toBe(0);
    expect(await main(['nope'], {})).toBe(2);
  });

  it('main：--dry-run 不发请求（凭据缺失也照样能预览）', async () => {
    mk('games.jsonl');
    expect(await main(['push', '--batch', 'b1', '--dir', dir, '--dry-run'], {})).toBe(0);
  });
});

describe('batch-bucket push', () => {
  /** 注入的 fetch：记下每次请求，403 的键返回失败。
      返回值要像真 Response 一样带 `headers.get`（putObject 会读 etag）。 */
  function fakeFetch(failKeys = []) {
    const calls = [];
    const impl = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
      const bad = failKeys.some((k) => String(url).includes(k));
      return {
        ok: !bad,
        status: bad ? 403 : 200,
        headers: new Headers(bad ? {} : { etag: '"d41d8cd98f00b204e9800998ecf8427e"' }),
        text: async () => (bad ? '<Error>AccessDenied</Error>' : ''),
      };
    };
    return { impl, calls };
  }

  it('逐个上传：URL/方法/签名头/内容哈希都要对', async () => {
    const abs = mk('round-1/games.jsonl', '{"a":1}\n');
    const { impl, calls } = fakeFetch();
    const cfg = requireBucketCfg(ENV);
    const out = [];
    const res = await pushArtifacts(
      [{ rel: 'round-1/games.jsonl', abs, size: 8 }],
      { cfg, prefix: 'ladders/b1', fetchImpl: impl, now: new Date('2026-10-04T00:00:00Z'), write: (s) => out.push(s) },
    );
    expect(res).toMatchObject({ uploaded: 1, failed: 0, bytes: 8 });
    expect(calls[0].url).toBe('https://s3.amazonaws.com/board-games/ladders/b1/round-1/games.jsonl');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261004\/auto\/s3\/aws4_request/);
    /* 内容哈希必须真是文件内容的哈希：桶端的完整性校验靠它。 */
    expect(calls[0].headers['x-amz-content-sha256']).toBe(sha256Hex('{"a":1}\n'));
    expect(out.join('')).toContain('↑ round-1/games.jsonl → ladders/b1/round-1/games.jsonl');
  });

  it('一个文件失败只告警、不阻断其余上传（D14）', async () => {
    const a = mk('games.jsonl', 'ok');
    const b = mk('elo.json', 'bad');
    const c = mk('report.md', 'fine');
    const { impl, calls } = fakeFetch(['elo.json']);
    const cfg = requireBucketCfg(ENV);
    const out = [];
    const res = await pushArtifacts(
      [
        { rel: 'games.jsonl', abs: a, size: 2 },
        { rel: 'elo.json', abs: b, size: 3 },
        { rel: 'report.md', abs: c, size: 4 },
      ],
      { cfg, prefix: 'p', fetchImpl: impl, write: (s) => out.push(s) },
    );
    expect(res.uploaded).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.failures[0].rel).toBe('elo.json');
    expect(res.failures[0].message).toMatch(/HTTP 403/);
    expect(calls).toHaveLength(3); // 失败之后仍然把剩下的传完
    expect(out.join('')).toMatch(/⚠ 上传失败 elo\.json/);
    /* 即便中途失败，也**没有**抛出去 —— 编排器不该因为一次 403 丢掉整晚产物。 */
  });

  it('失败项计入 failures 明细（便于 push 重跑时定位）', async () => {
    const a = mk('games.jsonl', 'x');
    const { impl } = fakeFetch(['games.jsonl']);
    const res = await pushArtifacts(
      [{ rel: 'games.jsonl', abs: a, size: 1 }],
      { cfg: requireBucketCfg(ENV), prefix: 'p', fetchImpl: impl, write: () => {} },
    );
    expect(res.failures).toEqual([{ rel: 'games.jsonl', message: expect.stringContaining('上传失败 HTTP 403') }]);
  });
});
