// CF Pages Function：POST /api/jev → 转发 TypeSafe 官方 System One API。
// BYOK 设计：服务端不存任何 key。访客在页面设置里填自己的 TypeSafe key，
// 前端经 X-Api-Key 请求头透传到这里，本函数仅代为绕过浏览器 CORS。
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/** 滑动窗口限流。Pages isolate 内存计数：单实例精确，多实例为尽力而为的下限保护。 */
const hits = new Map();
function rateLimited(ip, limit) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  const blocked = arr.length >= limit;
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 10_000) hits.clear(); // 内存护栏：清空后重新累计，误伤可接受
  return blocked;
}

export async function onRequestPost(context) {
  const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const limit = Number(context.env.RATE_LIMIT_PER_MIN ?? 30);
  if (rateLimited(ip, limit)) {
    return json({ error: '请求过于频繁，请稍后再试（每 IP 每分钟 ' + limit + ' 次）' }, 429);
  }
  const KEY = context.request.headers.get('X-Api-Key')
    || context.env.TYPESAFE_API_KEY || ''; // env 仅作站长自用的可选兜底
  if (!KEY) {
    return new Response(JSON.stringify({
      error: '未提供 API Key：请在页面「Jev 设置」中填写你自己的 TypeSafe key',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  let body;
  try {
    body = await context.request.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const upstream = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      state: body.state,
      model: body.model || 'jev-latest',
      questions: body.questions,
    }),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
