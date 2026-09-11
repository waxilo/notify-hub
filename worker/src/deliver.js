// 通知投递公共函数：写库 + QQ 官方机器人推送（唯一触达通道）
// webhook（外部触发）与 jobs（定时触发）共用这一份，避免两处逻辑漂移。
//
// 失败隔离语义：
//   消息**先入库再推送** —— QQ 网关失败/未配置时通知不丢，历史里显示「未送达」；
//   推送成功才写 delivered_at（历史里显示「已送达」）。
import { json } from './utils.js';
import { resolveBotConfig, targetKinds, getOpenids, sendToOpenid, getMessageTemplate, renderMessage } from './qq.js';

const DEDUP_WINDOW_MS = 300_000;   // 5 分钟防重窗口

// opts: { userId, keyId, jobId, keyName, title, body, payload, dedupKey, dedup, rejected }
//   jobId：定时任务触发时传入，用于把这条通知归到某个任务名下（可单独查历史 / 清空）。
//          外部 webhook 写入时留空，那类通知记在 keyId 上。
//   rejected：非空表示这次调用被服务端拒绝（如 key 已停用）。只留痕不推送 ——
//            「被拒绝」本身不需要触达，但用户得能在历史里看到，否则就是黑洞。
//   dedup=true 时按 dedupKey 在窗口内去重（job 用；webhook 仅当调用方显式传 key 时用）
// 返回 { id, deduplicated?, empty?, rejected?, qq_sent? }
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
    rejected = null,
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
    'INSERT INTO notifications (user_id, key_id, job_id, dedup_key, title, body, payload, rejected, created_at, read) VALUES (?,?,?,?,?,?,?,?,?,0)'
  ).bind(userId, keyId, jobId, dk, t, b, payload, rejected, Date.now()).run();
  const id = res.meta.last_row_id;
  if (id == null) return { id: null, error: 'insert failed' };

  // 被拒绝的调用只留痕不推送（历史里展示为「停用拒绝」）
  if (rejected) return { id, rejected: true };

  // 空内容只入库不推送（历史里展示为「空消息」）
  if (!b.trim()) return { id, empty: true };

  // QQ 推送：目标由 QQ_TARGET 决定（group / c2c / both），凭证从 Web 配置/env 解析。
  // 每类目标按 openid 名单扇出（多个群 / 多个好友都收到）；单目标失败只记日志，
  // 至少一个目标送达即写 delivered_at；名单为空视为未绑定（走同一隔离路径）。
  let qqSent = false;
  try {
    const cfg = await resolveBotConfig(env);
    const text = renderMessage(await getMessageTemplate(env), { title: t, body: b });
    for (const kind of targetKinds(cfg.target)) {
      const openids = await getOpenids(env, kind);
      if (!openids.length) {
        console.error('deliver_qq_error', JSON.stringify({
          id, target: kind,
          err: kind === 'group'
            ? 'qq 群未绑定：把机器人拉进群并 @它 发一条消息即自动加入名单'
            : 'qq 私聊未绑定：加机器人为好友并私聊它发一条消息即自动加入名单',
        }));
        continue;
      }
      for (const openid of openids) {
        try {
          await sendToOpenid(env, cfg, kind, openid, text);
          qqSent = true;
        } catch (err) {
          console.error('deliver_qq_error', JSON.stringify({ id, target: kind, to: openid, err: String(err).slice(0, 300) }));
        }
      }
    }
  } catch (err) {
    console.error('deliver_qq_config_error', JSON.stringify({ id, err: String(err).slice(0, 200) }));
  }
  if (qqSent) {
    await env.DB.prepare('UPDATE notifications SET delivered_at=? WHERE id=?').bind(Date.now(), id).run();
  }

  return { id, qq_sent: qqSent };
}

// 供 HTTP 层把 deliver 的结果转成响应（webhook 用）。
// QQ 推送失败仍返回 200：外部调用方按原样重试会造成重复消息，入库成功即视为受理。
export function deliverResponse(r, created = true) {
  if (r.error) return json({ error: r.error }, 500);
  if (r.deduplicated) return json({ ok: true, deduplicated: true, id: r.id });
  if (r.empty) return json({ ok: true, id: r.id, empty: true }, created ? 201 : 200);
  return json({ ok: true, id: r.id, delivered: !!r.qq_sent }, created ? 201 : 200);
}
