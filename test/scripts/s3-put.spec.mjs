// test/scripts/s3-put.spec.mjs — SigV4 用 **AWS 文档里的已知向量** 逐字节钉死（不是自己跟自己对答案）
//
// 三个向量的出处（AWS 官方文档的 SigV4 示例，数值是文档里印出来的原值）：
//   ① GET Object：examplebucket.s3.amazonaws.com/test.txt + Range: bytes=0-9
//   ② PUT Object：examplebucket.s3.amazonaws.com/test$file.text + x-amz-storage-class
//   ③ 派生签名密钥：20120215 / us-east-1 / iam
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_SHA256,
  amzDate,
  bucketConfigFromEnv,
  canonicalQuery,
  canonicalUri,
  getObject,
  hmac,
  listPrefix,
  missingBucketVars,
  parseEndpoint,
  putFile,
  putObject,
  sha256Hex,
  signRequest,
  signingKey,
  uriEncode,
  urlForCfg,
} from '../../scripts/lib/s3-put.mjs';

const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const CFG = {
  endpoint: 'https://s3.amazonaws.com',
  bucket: 'examplebucket',
  accessKeyId: KEY_ID,
  secretAccessKey: SECRET,
  region: 'us-east-1',
  addressing: 'virtual',
};

describe('SigV4 已知向量', () => {
  it('① GET Object：CanonicalRequest / StringToSign / Signature 三个都等于文档值', () => {
    const r = signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { range: 'bytes=0-9', 'x-amz-date': '20130524T000000Z' },
      payloadHash: EMPTY_SHA256,
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      region: 'us-east-1',
    });
    expect(r.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY_SHA256}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    );
    expect(r.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20130524T000000Z',
        '20130524/us-east-1/s3/aws4_request',
        '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
      ].join('\n'),
    );
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(r.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('② PUT Object：键里的 `$` 只编码一次（`decodeURIComponent` 那步漏了就会变成 %2524）', () => {
    const body = 'Welcome to Amazon S3.';
    const r = signRequest({
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: sha256Hex(body),
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      region: 'us-east-1',
    });
    expect(sha256Hex(body)).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    expect(r.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(r.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('③ 派生签名密钥：与 ① 的作用域一致（推导链被 ①② 的签名传递钉死）', () => {
    // 这里不引「20120215/iam」那组孤立的十六进制常量：它出自 S3 API 参考的旧页面，
    // 现在该页已 404 跳首页，常量无法再核对 ⇒ 宁可不写，也不写一个背下来但核不了的值。
    // 派生链本身不是没测：①② 的 signature 只有在 signingKey 完全正确时才可能对上。
    // 这条只钉「日期/区域/服务三段顺序」这个最容易写错的参数位置。
    const k = signingKey(SECRET, '20130524', 'us-east-1', 's3');
    expect(k).toHaveLength(32);
    expect(k.toString('hex')).not.toBe(signingKey(SECRET, '20130524', 'us-east-1', 'iam').toString('hex'));
    expect(k.toString('hex')).not.toBe(signingKey(SECRET, '20130525', 'us-east-1', 's3').toString('hex'));
    expect(k.toString('hex')).not.toBe(signingKey(SECRET, '20130524', 'us-west-2', 's3').toString('hex'));
  });

  it('③b HMAC 包装的参数顺序：RFC 4231 用例 1（key=0x0b×20, data="Hi There"）', () => {
    expect(hmac(Buffer.alloc(20, 0x0b), 'Hi There').toString('hex')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });
});

describe('编码与规范化', () => {
  it('uriEncode 只留 A-Za-z0-9-_.~（空格是 %20，不是 +）', () => {
    expect(uriEncode('a b')).toBe('a%20b');
    expect(uriEncode('~-_.')).toBe('~-_.');
    expect(uriEncode('中文')).toBe('%E4%B8%AD%E6%96%87');
    expect(uriEncode('a/b')).toBe('a%2Fb');
    expect(uriEncode('a/b', false)).toBe('a/b');
  });

  it('canonicalUri 逐段编码、保留分隔符；空键是 `/`', () => {
    expect(canonicalUri('')).toBe('/');
    expect(canonicalUri('ladders/b1/games.jsonl')).toBe('/ladders/b1/games.jsonl');
    expect(canonicalUri('dir/a b.txt')).toBe('/dir/a%20b.txt');
  });

  it('canonicalQuery 按键值编码后排序（对象与字符串两种入参同解）', () => {
    expect(canonicalQuery({ 'max-keys': 1000, prefix: 'ladders/b', 'list-type': 2 })).toBe('list-type=2&max-keys=1000&prefix=ladders%2Fb');
    expect(canonicalQuery('?b=2&a=1')).toBe('a=1&b=2');
    expect(canonicalQuery('')).toBe('');
  });

  it('amzDate 是 YYYYMMDDTHHMMSSZ（没有毫秒、没有短横线）', () => {
    expect(amzDate(new Date('2013-05-24T00:00:00.123Z'))).toBe('20130524T000000Z');
  });
});

describe('端点与桶配置', () => {
  it('parseEndpoint 补 https、去尾斜杠', () => {
    expect(parseEndpoint('account.r2.cloudflarestorage.com/').host).toBe('account.r2.cloudflarestorage.com');
    expect(parseEndpoint('account.r2.cloudflarestorage.com/').pathPrefix).toBe('');
    expect(parseEndpoint('http://127.0.0.1:9000/').secure).toBe(false);
    expect(() => parseEndpoint('')).toThrow(/BUCKET_ENDPOINT/);
  });

  it('路径式 / 虚拟主机式两种寻址都给出正确 URL', () => {
    expect(urlForCfg({ ...CFG, endpoint: 'https://examplebucket.s3.amazonaws.com', addressing: 'path' }, 'ladders/b/games.jsonl').toString()).toBe(
      'https://examplebucket.s3.amazonaws.com/examplebucket/ladders/b/games.jsonl',
    );
    expect(urlForCfg({ ...CFG, addressing: 'path' }, 'ladders/b/games.jsonl').toString()).toBe(
      'https://s3.amazonaws.com/examplebucket/ladders/b/games.jsonl',
    );
    // 虚拟主机式：endpoint 必须是**不带桶名**的（带了就抛，见下一条）
    expect(urlForCfg({ ...CFG, addressing: 'virtual' }, 'ladders/b/games.jsonl').toString()).toBe(
      'https://examplebucket.s3.amazonaws.com/ladders/b/games.jsonl',
    );
  });

  it('虚拟主机式 + endpoint 已含桶名 ⇒ 直接抛（否则会拼出 bucket.bucket.host 这种静默 404）', () => {
    expect(() => urlForCfg({ ...CFG, endpoint: 'https://examplebucket.s3.amazonaws.com', addressing: 'virtual' }, 'a.json')).toThrow(/已经带桶名/);
  });

  it('凭据只读环境变量：缺一个就 null（不静默），并点名缺哪个', () => {
    const env = { BUCKET_ENDPOINT: 'https://e', BUCKET_NAME: 'b' };
    expect(bucketConfigFromEnv(env)).toBeNull();
    expect(missingBucketVars(env)).toEqual(['BUCKET_ACCESS_KEY_ID', 'BUCKET_SECRET_ACCESS_KEY']);
    const full = { BUCKET_ENDPOINT: 'https://e', BUCKET_NAME: 'b', BUCKET_ACCESS_KEY_ID: 'k', BUCKET_SECRET_ACCESS_KEY: 's' };
    expect(bucketConfigFromEnv(full)).toEqual({
      endpoint: 'https://e',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
      region: 'auto',
      addressing: 'path',
    });
    expect(bucketConfigFromEnv({ ...full, BUCKET_ADDRESSING: 'virtual', BUCKET_REGION: 'wnam' }).addressing).toBe('virtual');
  });
});

describe('三个动作（注入 fetch，不联网）', () => {
  const okResp = (body = '', headers = {}) => ({
    ok: true,
    status: 200,
    headers: { get: (n) => headers[n.toLowerCase()] || null },
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  });

  it('putObject：PUT 到对键、带上 Authorization 与 x-amz-content-sha256', async () => {
    const calls = [];
    const fake = async (url, init) => {
      calls.push({ url: url.toString(), init });
      return okResp('', { etag: '"abc"' });
    };
    const r = await putObject({ cfg: { ...CFG, addressing: 'path' }, key: 'ladders/b1/games.jsonl', body: '{"a":1}\n', contentType: 'application/x-ndjson', fetchImpl: fake });
    expect(r.status).toBe(200);
    expect(r.etag).toBe('"abc"');
    expect(calls[0].url).toBe('https://s3.amazonaws.com/examplebucket/ladders/b1/games.jsonl');
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
    expect(calls[0].init.headers['x-amz-content-sha256']).toBe(sha256Hex('{"a":1}\n'));
    expect(calls[0].init.headers['content-type']).toBe('application/x-ndjson');
    expect(Buffer.from(calls[0].init.body).toString()).toBe('{"a":1}\n');
  });

  it('putObject：403 直接抛，消息里带状态与路径（断桶要能一眼看出是权限问题）', async () => {
    const fake = async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => '<Error>AccessDenied</Error>' });
    await expect(putObject({ cfg: CFG, key: 'x.json', body: '{}', fetchImpl: fake })).rejects.toThrow(/HTTP 403.*AccessDenied/s);
  });

  it('getObject：404 返回 {status:404, body:null} 而不是抛', async () => {
    const fake = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '' });
    expect(await getObject({ cfg: CFG, key: 'nope.json', fetchImpl: fake })).toMatchObject({ status: 404, body: null });
  });

  it('listPrefix：解析出 Key 列表与截断标记；GET 不带 body', async () => {
    const calls = [];
    const xml = '<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a/1.json</Key></Contents><Contents><Key>a/2.json</Key></Contents><NextContinuationToken>tok</NextContinuationToken></ListBucketResult>';
    const fake = async (url, init) => {
      calls.push({ url: url.toString(), init });
      return okResp(xml);
    };
    const r = await listPrefix({ cfg: { ...CFG, addressing: 'path' }, prefix: 'a/', fetchImpl: fake });
    expect(r.keys).toEqual(['a/1.json', 'a/2.json']);
    expect(r.truncated).toBe(true);
    expect(r.nextToken).toBe('tok');
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].url).toContain('list-type=2');
    expect(calls[0].url).toContain('prefix=a%2F');
  });

  it('putFile：按扩展名给 Content-Type', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3put-'));
    const f1 = path.join(dir, 'a.json');
    const f2 = path.join(dir, 'b.jsonl');
    fs.writeFileSync(f1, '{}');
    fs.writeFileSync(f2, '{}\n');
    const seen = [];
    const fake = async (url, init) => {
      seen.push(init.headers['content-type']);
      return okResp();
    };
    await putFile({ cfg: CFG, file: f1, key: 'a.json', fetchImpl: fake });
    await putFile({ cfg: CFG, file: f2, key: 'b.jsonl', fetchImpl: fake });
    expect(seen).toEqual(['application/json', 'application/x-ndjson']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
