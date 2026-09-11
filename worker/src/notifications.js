// 通知：列表（可按 key / 按 job 过滤）/ 详情 / 标记已读 / 标记已触达 / 删除 / 批量清空
//
// 两个来源互不重叠，过滤维度也各自独立：
//   外部系统经 /hook/:key 写入 → notifications.key_id 有值、job_id 为 NULL
//   站内定时任务触发      → notifications.job_id 有值、key_id 为 NULL
import { json } from './utils.js';

export async function listNotifications(request, env, userId) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
  const keyId = parseInt(url.searchParams.get('key_id') || '', 10);
  const jobId = parseInt(url.searchParams.get('job_id') || '', 10);

  const where = ['n.user_id = ?'];
  const binds = [userId];
  if (Number.isFinite(keyId) && keyId > 0) {
    where.push('n.key_id = ?');
    binds.push(keyId);
  }
  if (Number.isFinite(jobId) && jobId > 0) {
    where.push('n.job_id = ?');
    binds.push(jobId);
  }
  const whereSql = where.join(' AND ');

  const rows = await env.DB.prepare(
    `SELECT n.id, n.key_id, n.job_id, k.name AS key_name, n.title, n.body, n.payload,
            n.rejected, n.created_at, n.read, n.delivered_at
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

export async function deleteNotification(request, env, userId, id) {
  await env.DB.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').bind(id, userId).run();
  return json({ ok: true });
}

// 批量清空历史：DELETE /api/notifications?key_id=N 或 ?job_id=N
// 必须显式给出其中一个 —— 刻意不提供「不带参数清空全部」的入口，
// 否则前端一旦漏传参数就会把整个账号的通知清光，且不可恢复。
// 两个都传时以 job_id 为准（正常情况下二者互斥，不会同时有值）。
export async function clearNotifications(request, env, userId) {
  const url = new URL(request.url);
  const keyId = parseInt(url.searchParams.get('key_id') || '', 10);
  const jobId = parseInt(url.searchParams.get('job_id') || '', 10);

  const hasKey = Number.isFinite(keyId) && keyId > 0;
  const hasJob = Number.isFinite(jobId) && jobId > 0;
  if (!hasKey && !hasJob) return json({ error: 'key_id or job_id is required' }, 400);

  const res = hasJob
    ? await env.DB.prepare('DELETE FROM notifications WHERE user_id=? AND job_id=?').bind(userId, jobId).run()
    : await env.DB.prepare('DELETE FROM notifications WHERE user_id=? AND key_id=?').bind(userId, keyId).run();

  return json({ ok: true, deleted: res.meta.changes || 0 });
}
