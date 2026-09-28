// CF Pages Function：POST /api/jev → 转发 TypeSafe 官方 System One API。
// BYOK 设计：服务端不存任何 key。访客在页面设置里填自己的 TypeSafe key，
// 前端经 X-Api-Key 请求头透传到这里，本函数仅代为绕过浏览器 CORS。
export async function onRequestPost(context) {
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
