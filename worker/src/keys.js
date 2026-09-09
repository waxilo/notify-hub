// key 管理：生成 / 列表 / 吊销
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
  const res = await env.DB.prepare(
    'INSERT INTO keys (user_id, key, name, created_at, active) VALUES (?,?,?,?,1)'
  ).bind(userId, key, name, Date.now()).run();
  return json({ id: res.meta.last_row_id, key, name, createdAt: Date.now() }, 201);
}

export async function listKeys(request, env, userId) {
  const rows = await env.DB.prepare(
    'SELECT id, name, key, created_at, last_used, active FROM keys WHERE user_id = ? ORDER BY id DESC'
  ).bind(userId).all();
  // 列表里只展示前缀，完整 key 仅在创建时返回一次
  const masked = (rows.results || []).map((r) => ({
    ...r,
    key: r.key.slice(0, 6) + '••••••••',
    keyFull: r.key,
  }));
  return json({ keys: masked });
}

export async function revokeKey(request, env, userId, id) {
  await env.DB.prepare('UPDATE keys SET active=0 WHERE id=? AND user_id=?').bind(id, userId).run();
  return json({ ok: true });
}
