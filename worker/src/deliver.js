// 通知投递公共函数：写库 + QQ 官方机器人推送（唯一触达通道）
// webhook（外部触发）与 jobs（定时触发）共用这一份，避免两处逻辑漂移。
//
// 走哪个机器人：key.bot_id / job.bot_id → 为空则账号默认机器人（bots.js resolveBotFor）。
// 机器人是**账号隔离**的 —— 解析永远带 user_id 条件，绝不可能落到别人的机器人上；
// 账号一个机器人都没接入时只入库不推送（历史里显示「未送达」，接好机器人后新消息照常发）。
//
// 失败隔离语义：
//   消息**先入库再推送** —— 机器人没配好 / QQ 网关失败时通知不丢，历史里显示「未送达」；
//   推送成功才写 delivered_at（历史里显示「已送达」）。
import { json } from './utils.js';
import { resolveBotFor, targetKinds, getTargets, renderMessage, botDeliveryConfig } from './bots.js';
import { sendToOpenid } from './qq.js';

const DEDUP_WINDOW_MS = 300_000;   // 5 分钟防重窗口

// opts: { userId, botId, keyId, jobId, keyName, title, body, payload, dedupKey, dedup, rejected }
//   botId：key / job 上显式绑定的机器人；留空 = 用账号默认机器人。
//   jobId：定时任务触发时传入，用于把这条通知归到某个任务名下（可单独查历史 / 清空）。
//          外部 webhook 写入时留空，那类通知记在 keyId 上。
//   rejected：非空表示这次调用被服务端拒绝（如 key 已停用）。只留痕不推送 ——
//            「被拒绝」本身不需要触达，但用户得能在历史里看到，否则就是黑洞。
//   dedup=true 时按 dedupKey 在窗口内去重（job 用；webhook 仅当调用方显式传 key 时用）
// 返回 { id, deduplicated?, empty?, rejected?, qq_sent? }
export async function deliver(env, opts) {
  const {
    userId,
    botId = null,
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
    'INSERT INTO notifications (user_id, key_id, job_id, dedup_key, title, body, payload, rejected, created_at, `read`) VALUES (?,?,?,?,?,?,?,?,?,0)'
  ).bind(userId, keyId, jobId, dk, t, b, payload, rejected, Date.now()).run();
  const id = res.meta.last_row_id;
  if (id == null) return { id: null, error: 'insert failed' };

  // 被拒绝的调用只留痕不推送（历史里展示为「停用拒绝」）
  if (rejected) return { id, rejected: true };

  // 空内容只入库不推送（历史里展示为「空消息」）
  if (!b.trim()) return { id, empty: true };

  let qqSent = false;
  try {
    const bot = await resolveBotFor(env, userId, botId);
    if (!bot) {
      console.error('deliver_no_bot', JSON.stringify({
        id, user_id: userId, bot_id: botId,
        err: '该账号还没有接入 QQ 机器人（控制台「机器人」页新建并填入 AppID/AppSecret）',
      }));
    } else if (!bot.app_id || !bot.app_secret) {
      console.error('deliver_bot_incomplete', JSON.stringify({ id, bot_id: bot.id, app_id: bot.app_id || '' }));
    } else {
      const cfg = botDeliveryConfig(bot);
      const text = renderMessage(cfg.template, { title: t, body: b });
      const targets = await getTargets(env, bot.id);
      // 每类目标按该机器人自己的名单扇出（多个群 / 多个好友都收到）
      for (const kind of targetKinds(cfg.target)) {
        const openids = targets[kind] || [];
        if (!openids.length) {
          console.error('deliver_target_empty', JSON.stringify({
            id, bot_id: bot.id, target: kind,
            err: kind === 'group'
              ? '该机器人还没有绑群：把机器人拉进群并 @它 发一条消息即自动加入名单'
              : '该机器人还没有绑好友：加机器人为好友并私聊它发一条消息即自动加入名单',
          }));
          continue;
        }
        for (const openid of openids) {
          try {
            await sendToOpenid(cfg, kind, openid, text);
            qqSent = true;
          } catch (err) {
            console.error('deliver_qq_error', JSON.stringify({ id, bot_id: bot.id, target: kind, to: openid, err: String(err).slice(0, 300) }));
          }
        }
      }
    }
  } catch (err) {
    console.error('deliver_bot_error', JSON.stringify({ id, bot_id: botId, err: String(err).slice(0, 200) }));
  }
  // 单个目标失败不影响其他目标；至少一个送达即算这条通知已送达
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
