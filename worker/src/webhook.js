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
// 震动：key 上可配 strong_vibrate 作为默认值，调用方可用 ?vibrate=0|1（或请求体同名字段）按次覆盖。
import { json, readJson, readText } from './utils.js';
import { deliver, deliverResponse } from './deliver.js';

// 停用拒绝记录的防灌爆窗口：调用方通常还在按原节奏重试，按 5 分钟时间桶去重，
// 同一 key 每 5 分钟最多留一条「停用拒绝」，既能看到有人在调，又不会把历史刷爆。
const REJECT_DEDUP_MS = 300_000;

// 震动开关解析：识别 '1'/'true'/'yes' 与 '0'/'false'/'no'，无法识别（未传 / 空串）返回 null。
// query、JSON body、form 三种来源通用。返回 null 表示「调用方没有表态」，此时用 key 的默认值。
function parseVibrate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no') return false;
  return null;
}

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
  const row = await env.DB.prepare('SELECT id, name, user_id, active, mode, template, strong_vibrate FROM keys WHERE key=?').bind(key).first();
  if (!row) return json({ error: 'invalid key' }, 404);

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

  // 停用的 key：不推送、不更新 last_used，但仍**留痕** ——
  // 外部系统往往还在按原节奏调用，若直接 403 走人，用户只会看到「对方说发了、
  // 我这边什么都没有」，无从判断是漏推送还是被拒。
  // 记一条 rejected 记录（历史里展示为「停用拒绝」）后返回 403，调用方语义不变。
  // 注意放在参数解析之后：这样留痕里能带上调用方原始参数，方便排查是谁在调。
  if (!row.active) {
    await deliver(env, {
      userId: row.user_id,
      keyId: row.id,
      keyName: row.name || '',
      title,
      body: String(body || '').trim() || '（调用方未提供 message）',
      payload,
      dedupKey: `reject:${row.id}:${Math.floor(Date.now() / REJECT_DEDUP_MS)}`,
      dedup: true,
      rejected: 'key_disabled',
    });
    return json({ error: 'key is disabled' }, 403);
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

  // 震动开关：显式传参 > key 默认值。
  // 显式传参优先取 query（?vibrate=1），其次取请求体字段（JSON / 表单）。
  // 注意：GET 会把全部 query 原样存进 notifications.payload，所以 vibrate 也会出现在 payload 里
  // —— 与 dedup_key 一样，属现有设计，不额外处理。
  const explicitVibrate = parseVibrate(new URL(request.url).searchParams.get('vibrate'))
    ?? parseVibrate(payloadObj && typeof payloadObj === 'object' ? payloadObj.vibrate : null);
  const vibrate = explicitVibrate === null ? !!row.strong_vibrate : explicitVibrate;

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
    vibrate,
  });

  return deliverResponse(r);
}
