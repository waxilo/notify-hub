// 通知：列表 / 详情 / 标记已读 / 删除（供安卓端轮询拉取）
import { json } from './utils.js';

export async function listNotifications(request, env, userId) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
  const rows = await env.DB.prepare(
    'SELECT id, title, body, payload, created_at, read FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).bind(userId, limit, offset).all();
  const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id=?').bind(userId).first();
  return json({ notifications: rows.results || [], total: total ? total.c : 0 });
}

export async function getNotification(request, env, userId, id) {
  const row = await env.DB.prepare('SELECT * FROM notifications WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) return json({ error: 'not found' }, 404);
  return json(row);
}

export async function markRead(request, env, userId, id) {
  await env.DB.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').bind(id, userId).run();
  return json({ ok: true });
}

export async function deleteNotification(request, env, userId, id) {
  await env.DB.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').bind(id, userId).run();
  return json({ ok: true });
}
