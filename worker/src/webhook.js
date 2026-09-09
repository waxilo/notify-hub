// 通用 webhook：GET/POST 均可，按 key 路由到对应用户并写入通知
//   GET  /hook/:key?title=...&body=...&message=...
//   POST /hook/:key  (JSON | form | 纯文本)
import { json, readJson, readText } from './utils.js';

export async function handleWebhook(request, env, key) {
  const row = await env.DB.prepare('SELECT id, user_id, active FROM keys WHERE key=?').bind(key).first();
  if (!row || !row.active) return json({ error: 'invalid or inactive key' }, 404);

  let title = '';
  let body = '';
  let payload = null;

  if (request.method === 'POST') {
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    try {
      if (ct.includes('application/json')) {
        const data = await request.json();
        title = String(data.title ?? '');
        body = String(data.body ?? data.message ?? data.text ?? '');
        payload = JSON.stringify(data);
      } else if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
        const form = await request.formData();
        title = String(form.get('title') ?? '');
        body = String(form.get('body') ?? form.get('message') ?? form.get('text') ?? '');
        const obj = {};
        for (const [k, v] of form.entries()) obj[k] = v;
        payload = JSON.stringify(obj);
      } else {
        body = await request.text();
        payload = body;
      }
    } catch {
      body = await readText(request);
      payload = body;
    }
  } else {
    const url = new URL(request.url);
    title = url.searchParams.get('title') || '';
    body = url.searchParams.get('body') || url.searchParams.get('message') || url.searchParams.get('text') || '';
    const obj = {};
    for (const [k, v] of url.searchParams.entries()) obj[k] = v;
    payload = JSON.stringify(obj);
  }

  if (!title && !body) title = 'Webhook 通知';
  if (title.length > 500) title = title.slice(0, 500);
  if (body.length > 8000) body = body.slice(0, 8000);

  await env.DB.prepare('UPDATE keys SET last_used=? WHERE id=?').bind(Date.now(), row.id).run();
  const res = await env.DB.prepare(
    'INSERT INTO notifications (user_id, key_id, title, body, payload, created_at, read) VALUES (?,?,?,?,?,?,0)'
  ).bind(row.user_id, row.id, title, body, payload, Date.now()).run();

  // 实时推送：经 Durable Object 广播给该用户的在线 WebSocket 连接（失败不影响入库结果）
  try {
    const stub = env.PUSH_HUB.get(env.PUSH_HUB.idFromName(String(row.user_id)));
    const msg = JSON.stringify({
      type: 'notification',
      id: res.meta.last_row_id,
      title,
      body,
      created_at: Date.now(),
    });
    await stub.fetch('https://do/notify', { method: 'POST', body: msg });
  } catch {
    // 离线客户端依赖 D1 + 轮询/重连后拉取兜底
  }

  return json({ ok: true, id: res.meta.last_row_id }, 201);
}
