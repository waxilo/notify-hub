// 通知投递公共函数：写库 + 经 Durable Object 广播
// webhook（外部触发）与 jobs（定时触发）共用这一份，避免两处逻辑漂移 ——
// 以后加重试、加 Web Push 只改这里。
import { json } from './utils.js';

const DEDUP_WINDOW_MS = 300_000;   // 5 分钟防重窗口

// opts: { userId, keyId, jobId, keyName, title, body, payload, dedupKey, dedup }
//   jobId：定时任务触发时传入，用于把这条通知归到某个任务名下（可单独查历史 / 清空）。
//          外部 webhook 写入时留空，那类通知记在 keyId 上。
//   dedup=true 时按 dedupKey 在窗口内去重（job 用；webhook 仅当调用方显式传 key 时用）
// 返回 { id, deduplicated?, empty? }
export async function deliver(env, opts) {
  const {
    userId,
    keyId = null,
    jobId = null,
    keyName = '',
    title = '',
    body = '',
    payload = null,
    dedupKey = '',
    dedup = false,
  } = opts;

  const dk = dedupKey ? String(dedupKey).slice(0, 128) : 'srv-' + crypto.randomUUID();
  const t = String(title ?? '通知').slice(0, 500) || '通知';
  const b = String(body ?? '').slice(0, 8000);

  if (dedup) {
    const dup = await env.DB.prepare(
      'SELECT id FROM notifications WHERE user_id=? AND dedup_key=? AND created_at>? ORDER BY id DESC LIMIT 1'
    ).bind(userId, dk, Date.now() - DEDUP_WINDOW_MS).first();
    if (dup) return { id: dup.id, deduplicated: true };
  }

  const res = await env.DB.prepare(
    'INSERT INTO notifications (user_id, key_id, job_id, dedup_key, title, body, payload, created_at, read) VALUES (?,?,?,?,?,?,?,?,0)'
  ).bind(userId, keyId, jobId, dk, t, b, payload, Date.now()).run();
  const id = res.meta.last_row_id;
  if (id == null) return { id: null, error: 'insert failed' };

  // 空内容只入库不推送（历史里展示为「空消息」）
  if (!b.trim()) return { id, empty: true };

  // 实时推送：经 DO 广播 + 未收到触达回调自动重推（失败不影响入库结果）
  try {
    const stub = env.PUSH_HUB.get(env.PUSH_HUB.idFromName(String(userId)));
    await stub.fetch('https://do/notify', {
      method: 'POST',
      body: JSON.stringify({
        type: 'notification',
        id,
        dedup_key: dk,
        key_name: keyName || '',
        title: t,
        body: b,
        created_at: Date.now(),
      }),
    });
  } catch {
    // 离线客户端依赖 D1 + 重新上线后拉取兜底
  }

  return { id };
}

// 供 HTTP 层把 deliver 的结果转成响应（webhook 用）
export function deliverResponse(r, created = true) {
  if (r.error) return json({ error: r.error }, 500);
  if (r.deduplicated) return json({ ok: true, deduplicated: true, id: r.id });
  if (r.empty) return json({ ok: true, id: r.id, empty: true }, created ? 201 : 200);
  return json({ ok: true, id: r.id }, created ? 201 : 200);
}
