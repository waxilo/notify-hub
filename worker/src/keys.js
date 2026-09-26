// key 管理：生成 / 列表 / 编辑（名称、状态、模式、推送机器人）/ 吊销
import { json, readJson } from './utils.js';
import { resolveBotBinding } from './bots.js';

function genKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createKey(request, env, userId) {
  const body = await readJson(request);
  const name = String(body.name || 'default').slice(0, 64);
  const bind = await resolveBotBinding(env, userId, body.bot_id);
  if (!bind.ok) return json({ error: bind.error }, 400);
  const key = genKey();
  const res = await env.DB.prepare(
    'INSERT INTO `keys` (user_id, `key`, name, created_at, active, mode, bot_id) VALUES (?,?,?,?,1,?,?)'
  ).bind(
    userId, key, name, Date.now(),
    String(body.mode || 'default') === 'custom' ? 'custom' : 'default',
    bind.botId,
  ).run();
  return json({ id: res.meta.last_row_id, key, name, createdAt: Date.now() }, 201);
}

export async function listKeys(request, env, userId) {
  // LEFT JOIN bots 把「推送到哪个机器人」一并带回（bot_id 为空 = 跟随账号默认机器人）。
  // 条件带 user_id 是防御性的：机器人被删/被改归属时这里退化成 NULL，而不是暴露别人的名字。
  const rows = await env.DB.prepare(
    `SELECT k.id, k.name, k.\`key\`, k.created_at, k.last_used, k.active, k.mode, k.template, k.bot_id, b.name AS bot_name
       FROM \`keys\` k
       LEFT JOIN bots b ON b.id = k.bot_id AND b.user_id = k.user_id
      WHERE k.user_id = ?
      ORDER BY k.id DESC`
  ).bind(userId).all();
  // key 明文返回（自托管场景无需隐藏），Web 端可随时查看/复制
  const keys = (rows.results || []).map((r) => ({ ...r, keyFull: r.key }));
  return json({ keys });
}

// 编辑 key：名称 / 启停 / 模式（启用中改名为合法字符串即可）
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
  // 推送机器人：传 null / 空串 = 解绑（跟随账号默认机器人），传 id 则必须是本账号的机器人
  if (body.bot_id !== undefined) {
    const bind = await resolveBotBinding(env, userId, body.bot_id);
    if (!bind.ok) return json({ error: bind.error }, 400);
    sets.push('bot_id=?'); vals.push(bind.botId);
  }
  // 废弃字段（如旧客户端传来的 strong_vibrate）直接忽略：只认上面列出的字段，不报错
  if (!sets.length) return json({ error: 'nothing to update' }, 400);
  vals.push(id, userId);
  const res = await env.DB.prepare(
    `UPDATE \`keys\` SET ${sets.join(', ')} WHERE id=? AND user_id=?`
  ).bind(...vals).run();
  if (!res.meta.changes) return json({ error: 'key not found' }, 404);
  return json({ ok: true });
}

// 彻底删除 key：连同该 key 的全部发送历史一并清除（停用请用 updateKey 的 active=false）
export async function deleteKey(request, env, userId, id) {
  await env.DB.prepare('DELETE FROM notifications WHERE user_id=? AND key_id=?').bind(userId, id).run();
  const res = await env.DB.prepare('DELETE FROM `keys` WHERE id=? AND user_id=?').bind(id, userId).run();
  if (!res.meta.changes) return json({ error: 'key not found' }, 404);
  return json({ ok: true });
}
