// 通知：列表（支持按 key 过滤）/ 详情 / 标记已读 / 标记已触达 / 删除
import { json } from './utils.js';

export async function listNotifications(request, env, userId) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
  const keyId = parseInt(url.searchParams.get('key_id') || '', 10);

  const where = ['n.user_id = ?'];
  const binds = [userId];
  if (Number.isFinite(keyId) && keyId > 0) {
    where.push('n.key_id = ?');
    binds.push(keyId);
  }
  const whereSql = where.join(' AND ');

  const rows = await env.DB.prepare(
    `SELECT n.id, n.key_id, k.name AS key_name, n.title, n.body, n.payload,
            n.created_at, n.read, n.delivered_at
     FROM notifications n
     LEFT JOIN keys k ON k.id = n.key_id
     WHERE ${whereSql}
     ORDER BY n.id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM notifications n WHERE ${whereSql}`
  ).bind(...binds).first();

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

// App 收到 WS 推送并成功弹出系统通知后回调，修正触达状态（只记录首次触达）
export async function markDelivered(request, env, userId, id) {
  const res = await env.DB.prepare(
    'UPDATE notifications SET delivered_at=? WHERE id=? AND user_id=? AND delivered_at IS NULL'
  ).bind(Date.now(), id, userId).run();
  return json({ ok: true, updated: res.meta.changes > 0 });
}

export async function deleteNotification(request, env, userId, id) {
  await env.DB.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').bind(id, userId).run();
  return json({ ok: true });
}
