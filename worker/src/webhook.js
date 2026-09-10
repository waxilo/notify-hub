// 通用 webhook：GET/POST 均可，按 key 路由到对应用户并写入通知
//   GET  /hook/:key?message=...[&dedup_key=...]
//   POST /hook/:key  (JSON | form | 纯文本；防重 key 可用头 X-Dedup-Key 或字段 dedup_key)
// 标题固定为 key 名称（key_name），调用方不需要传 title；通知内容统一取 message。
// 默认模式：message 原样作为内容。
// 自定义模式：message 作为模板，${路径} 占位符用 JSON 数据填充（如 ${name}、${event.msg}）；
//   未传 message 时整个 JSON 直接作为内容触达。
// message 解析为空时只入库不推送（历史中展示为「空消息」）。
// 防重：仅在调用方显式传入 dedup_key 时做去重（用于调用方超时重试场景），
// 同一 dedup_key 在 5 分钟窗口内只入库/推送一次，重复调用直接返回首条消息 id（deduplicated: true）。
// 每条消息未传 dedup_key 时由服务端生成唯一 key（srv-<uuid>），随 WS 推送下发，供 App 对重推消息判重。
import { json, readJson, readText } from './utils.js';
import { deliver, deliverResponse } from './deliver.js';

// 按点分路径从 JSON 提取值，支持数组下标与 $ 前缀：$.event.alerts.0.title（$ 表示 JSON 本身，可省略）
function extractByPath(obj, path) {
  if (!path || obj == null) return '';
  let p = String(path).trim();
  if (p === '$') return JSON.stringify(obj);
  if (p.startsWith('$')) p = p.slice(1);
  if (p.startsWith('.')) p = p.slice(1);
  if (!p) return JSON.stringify(obj);
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
  const row = await env.DB.prepare('SELECT id, name, user_id, active, mode, template FROM keys WHERE key=?').bind(key).first();
  if (!row) return json({ error: 'invalid key' }, 404);
  // 禁用状态的 key 不接收、不入库、不推送
  if (!row.active) return json({ error: 'key is disabled' }, 403);

  // 标题固定为 key 名称；内容统一取 message
  let title = row.name || '通知';
  let body = '';
  let payload = null;
  let payloadObj = null;
  let dedupKey = request.headers.get('x-dedup-key') || '';

  if (request.method === 'POST') {
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    try {
      if (ct.includes('application/json')) {
        payloadObj = await request.json();
        body = String(payloadObj.message ?? '');
        dedupKey = dedupKey || String(payloadObj.dedup_key ?? '');
        payload = JSON.stringify(payloadObj);
      } else if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
        const form = await request.formData();
        const obj = {};
        for (const [k, v] of form.entries()) obj[k] = v;
        payloadObj = obj;
        body = String(form.get('message') ?? '');
        dedupKey = dedupKey || String(form.get('dedup_key') ?? '');
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
    const obj = {};
    for (const [k, v] of url.searchParams.entries()) obj[k] = v;
    payloadObj = obj;
    body = url.searchParams.get('message') || '';
    dedupKey = dedupKey || url.searchParams.get('dedup_key') || '';
    payload = JSON.stringify(obj);
  }

  // 自定义模式（模板解析），优先级：
  //   1) 调用方传了 message → 作为模板，${路径} 占位符用 JSON 数据填充（取不到的字段替换为空串）
  //   2) 未传 message 但 key 上配置了模板（编辑弹窗的「消息模板」输入框）→ 用 key 模板渲染
  //   3) 都没有 → 整个 JSON 直接作为内容触达
  if (row.mode === 'custom' && payloadObj && typeof payloadObj === 'object') {
    const tpl = body || String(row.template || '');
    if (tpl) {
      body = tpl.replace(/\$\{([^}]+)\}/g, (_, p) => extractByPath(payloadObj, p));
    } else {
      body = JSON.stringify(payloadObj);
    }
  }

  if (!title) title = '通知';
  if (title.length > 500) title = title.slice(0, 500);
  if (body.length > 8000) body = body.slice(0, 8000);
  if (dedupKey.length > 128) dedupKey = dedupKey.slice(0, 128);

  await env.DB.prepare('UPDATE keys SET last_used=? WHERE id=?').bind(Date.now(), row.id).run();

  // 入库 + 推送走公共函数（与定时 job 同一条链路）
  // 每条消息都有防重 key：调用方未传时由 deliver 生成唯一 key（UUID），随 WS 推送下发，
  // App 端凭它对超时重推的消息做重复判断；只有显式传了 dedup_key 才做去重。
  const r = await deliver(env, {
    userId: row.user_id,
    keyId: row.id,
    keyName: row.name || '',
    title,
    body,
    payload,
    dedupKey,
    dedup: !!dedupKey,
  });

  return deliverResponse(r);
}
