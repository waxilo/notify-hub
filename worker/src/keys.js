// key 管理：生成 / 列表 / 编辑（名称、状态、模式、强力震动）/ 吊销
import { json, readJson } from './utils.js';

function genKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createKey(request, env, userId) {
  const body = await readJson(request);
  const name = String(body.name || 'default').slice(0, 64);
  const key = genKey();
  // strong_vibrate 默认 0（与迁移默认一致，显式写更清晰）：需要强震的 key 单独在编辑里打开
  const res = await env.DB.prepare(
    'INSERT INTO keys (user_id, key, name, created_at, active, mode, strong_vibrate) VALUES (?,?,?,?,1,?,?)'
  ).bind(
    userId, key, name, Date.now(),
    String(body.mode || 'default') === 'custom' ? 'custom' : 'default',
    body.strong_vibrate ? 1 : 0,
  ).run();
  return json({ id: res.meta.last_row_id, key, name, createdAt: Date.now() }, 201);
}

export async function listKeys(request, env, userId) {
  const rows = await env.DB.prepare(
    'SELECT id, name, key, created_at, last_used, active, mode, template, strong_vibrate FROM keys WHERE user_id = ? ORDER BY id DESC'
  ).bind(userId).all();
  // key 明文返回（自托管场景无需隐藏），Web 端可随时查看/复制
  const keys = (rows.results || []).map((r) => ({ ...r, keyFull: r.key }));
  return json({ keys });
}

// 编辑 key：名称 / 启停 / 模式 / 强力震动（启用中改名为合法字符串即可）
export async function updateKey(request, env, userId, id) {
  const body = await readJson(request);
  const sets = [];
  const vals = [];
  if (typeof body.name === 'string' && body.name.trim()) {
    sets.push('name=?'); vals.push(body.name.trim().slice(0, 64));
  }
  if (typeof body.active === 'boolean') {
    sets.push('active=?'); vals.push(body.active ? 1 : 0);
  }
  if (body.mode !== undefined) {
    sets.push('mode=?'); vals.push(String(body.mode) === 'custom' ? 'custom' : 'default');
  }
  if (typeof body.template === 'string') {
    sets.push('template=?'); vals.push(body.template.slice(0, 2000));
  }
  // 字段不传就不改：旧版 App / 前端的局部更新不会误清这个开关
  if (body.strong_vibrate !== undefined) {
    sets.push('strong_vibrate=?'); vals.push(body.strong_vibrate ? 1 : 0);
  }
  if (!sets.length) return json({ error: 'nothing to update' }, 400);
  vals.push(id, userId);
  const res = await env.DB.prepare(
    `UPDATE keys SET ${sets.join(', ')} WHERE id=? AND user_id=?`
  ).bind(...vals).run();
  if (!res.meta.changes) return json({ error: 'key not found' }, 404);
  return json({ ok: true });
}

// 彻底删除 key：连同该 key 的全部发送历史一并清除（停用请用 updateKey 的 active=false）
export async function deleteKey(request, env, userId, id) {
  await env.DB.prepare('DELETE FROM notifications WHERE user_id=? AND key_id=?').bind(userId, id).run();
  const res = await env.DB.prepare('DELETE FROM keys WHERE id=? AND user_id=?').bind(id, userId).run();
  if (!res.meta.changes) return json({ error: 'key not found' }, 404);
  return json({ ok: true });
}
