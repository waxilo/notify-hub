// 通用 webhook：GET/POST 均可，按 key 路由到对应用户并写入通知
//   GET  /hook/:key?message=...[&dedup_key=...]
//   POST /hook/:key  (JSON | form | 纯文本；防重 key 可用头 X-Dedup-Key 或字段 dedup_key)
// 标题固定为 key 名称（key_name），调用方不需要传 title；通知内容统一取 message
// （兼容旧参数 body / text 作为回退）。自定义模式仍可用 title_path 覆盖标题。
// 防重：仅在调用方显式传入 dedup_key 时做去重（用于调用方超时重试场景），
// 同一 dedup_key 在 5 分钟窗口内只入库/推送一次，重复调用直接返回首条消息 id（deduplicated: true）。
// 每条消息未传 dedup_key 时由服务端生成唯一 key（srv-<uuid>），随 WS 推送下发，供 App 对重推消息判重。
import { json, readJson, readText } from './utils.js';

const DEDUP_WINDOW_MS = 300_000;

// 按点分路径从 JSON 提取值，支持数组下标与 $ 前缀：$.event.alerts.0.title（$ 表示 JSON 本身，可省略）
function extractByPath(obj, path) {
  if (!path) return '';
  let p = String(path).trim();
  if (p === '$') return obj == null ? '' : JSON.stringify(obj);
  if (p.startsWith('$')) p = p.slice(1);
  if (p.startsWith('.')) p = p.slice(1);
  if (!p) return obj == null ? '' : JSON.stringify(obj);
  let cur = obj;
  for (const seg of p.split('.')) {
    if (cur == null) return '';
    if (Array.isArray(cur)) {
      const i = parseInt(seg, 10);
      if (Number.isNaN(i)) return '';
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = cur[seg];
    } else {
      return '';
    }
  }
  if (cur == null) return '';
  return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
}

export async function handleWebhook(request, env, key) {
  const row = await env.DB.prepare('SELECT id, name, user_id, active, mode, title_path, body_path FROM keys WHERE key=?').bind(key).first();
  if (!row) return json({ error: 'invalid key' }, 404);
  // 禁用状态的 key 不接收、不入库、不推送
  if (!row.active) return json({ error: 'key is disabled' }, 403);

  // 标题固定为 key 名称；内容统一取 message（兼容旧参数 body / text）
  let title = row.name || '通知';
  let body = '';
  let payload = null;
  let dedupKey = request.headers.get('x-dedup-key') || '';
  let customData = null;

  if (request.method === 'POST') {
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    try {
      if (ct.includes('application/json')) {
        const data = await request.json();
        customData = data;
        body = String(data.message ?? data.body ?? data.text ?? '');
        dedupKey = dedupKey || String(data.dedup_key ?? '');
        payload = JSON.stringify(data);
      } else if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
        const form = await request.formData();
        body = String(form.get('message') ?? form.get('body') ?? form.get('text') ?? '');
        dedupKey = dedupKey || String(form.get('dedup_key') ?? '');
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
    body = url.searchParams.get('message') || url.searchParams.get('body') || url.searchParams.get('text') || '';
    dedupKey = dedupKey || url.searchParams.get('dedup_key') || '';
    const obj = {};
    for (const [k, v] of url.searchParams.entries()) obj[k] = v;
    payload = JSON.stringify(obj);
  }

  // 自定义模式：按 key 配置的 JSON 路径从请求体提取标题/内容（标题提取为空时回退 key 名称，内容回退 message/body/text）
  if (row.mode === 'custom' && customData && typeof customData === 'object') {
    title = extractByPath(customData, row.title_path) || title;
    body = extractByPath(customData, row.body_path) || body;
  }

  if (!title) title = '通知';
  if (title.length > 500) title = title.slice(0, 500);
  if (body.length > 8000) body = body.slice(0, 8000);
  if (dedupKey.length > 128) dedupKey = dedupKey.slice(0, 128);
  // 每条消息都有防重 key：调用方未传时由服务端生成（UUID），随 WS 推送下发，
  // App 端凭它对超时重推的消息做重复判断
  if (!dedupKey) dedupKey = 'srv-' + crypto.randomUUID();

  await env.DB.prepare('UPDATE keys SET last_used=? WHERE id=?').bind(Date.now(), row.id).run();

  // 防重：仅当调用方显式传了 dedup_key 时，窗口内同一 key 已存在则不重复入库/推送
  if (dedupKey) {
    const dup = await env.DB.prepare(
      'SELECT id FROM notifications WHERE user_id=? AND dedup_key=? AND created_at>? ORDER BY id DESC LIMIT 1'
    ).bind(row.user_id, dedupKey, Date.now() - DEDUP_WINDOW_MS).first();
    if (dup) return json({ ok: true, deduplicated: true, id: dup.id });
  }

  const res = await env.DB.prepare(
    'INSERT INTO notifications (user_id, key_id, dedup_key, title, body, payload, created_at, read) VALUES (?,?,?,?,?,?,?,0)'
  ).bind(row.user_id, row.id, dedupKey, title, body, payload, Date.now()).run();

  // 实时推送：经 Durable Object 广播 + 1 秒无触达回调自动重推（失败不影响入库结果）
  try {
    const stub = env.PUSH_HUB.get(env.PUSH_HUB.idFromName(String(row.user_id)));
    const msg = JSON.stringify({
      type: 'notification',
      id: res.meta.last_row_id,
      dedup_key: dedupKey,
      key_name: row.name || '',
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
