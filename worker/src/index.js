// Worker 入口：路由 + CORS
import { json } from './utils.js';
import { register, login, changePassword, verifyJWT } from './auth.js';
import { createKey, listKeys, updateKey, deleteKey } from './keys.js';
import { listNotifications, getNotification, markRead, deleteNotification, clearNotifications } from './notifications.js';
import { handleWebhook } from './webhook.js';
import { handleCallback, getBotConfigView, updateBotConfig, testBotConfig, listenOpenids } from './qq.js';
import { listJobs, createJob, updateJob, deleteJob, runDueJobs } from './jobs.js';

async function getUserId(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const payload = await verifyJWT(auth.slice(7), env.JWT_SECRET);
  return payload ? payload.sub : null;
}

function requireAuth(userId) {
  if (!userId) return json({ error: 'unauthorized' }, 401);
  return null;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        },
      });
    }

    // ---- 通用 webhook（无需鉴权）----
    const m = pathname.match(/^\/hook\/([\w-]+)$/);
    if (m && (request.method === 'GET' || request.method === 'POST')) {
      return handleWebhook(request, env, m[1]);
    }

    if (pathname.startsWith('/api/')) {
      const p = pathname.replace('/api', '');

      // QQ 官方机器人回调（公开路由，Ed25519 验签；配置在开放平台管理端）
      if (p === '/qq/callback' && request.method === 'POST') {
        return handleCallback(request, env);
      }

      // QQ 机器人配置（Web 控制台「机器人」页；settings 优先，env/secret 兜底）
      if (p === '/qq/config' && request.method === 'GET') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return getBotConfigView(request, env, uid);
      }
      if (p === '/qq/config' && request.method === 'PUT') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return updateBotConfig(request, env, uid);
      }
      if (p === '/qq/test' && request.method === 'POST') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return testBotConfig(request, env, uid);
      }
      if (p === '/qq/listen' && request.method === 'POST') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return listenOpenids(request, env, uid);
      }

      // 账号
      if (p === '/register' && request.method === 'POST') return register(request, env);
      if (p === '/login' && request.method === 'POST') return login(request, env);
      if (p === '/password' && request.method === 'POST') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return changePassword(request, env, uid);
      }

      // key 管理
      if (p === '/keys' && request.method === 'POST') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return createKey(request, env, uid);
      }
      if (p === '/keys' && request.method === 'GET') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return listKeys(request, env, uid);
      }
      // PUT 必须排在 DELETE 之前（两种方法互不干扰，但保持读起来一致的顺序）
      if (p.startsWith('/keys/') && request.method === 'PUT') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return updateKey(request, env, uid, p.split('/')[2]);
      }
      if (p.startsWith('/keys/') && request.method === 'DELETE') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return deleteKey(request, env, uid, p.split('/')[2]);
      }

      // 通知（支持 ?key_id= 按外部 key 过滤、?job_id= 按定时任务过滤，供历史查询）
      if (p === '/notifications' && request.method === 'GET') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return listNotifications(request, env, uid);
      }
      // 批量清空历史：必须带 ?key_id= 或 ?job_id=（不提供清空全部）
      if (p === '/notifications' && request.method === 'DELETE') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return clearNotifications(request, env, uid);
      }
      if (p.startsWith('/notifications/') && p.endsWith('/read') && request.method === 'POST') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return markRead(request, env, uid, p.split('/')[2]);
      }
      if (p.startsWith('/notifications/') && request.method === 'GET') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return getNotification(request, env, uid, p.split('/')[2]);
      }
      if (p.startsWith('/notifications/') && request.method === 'DELETE') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return deleteNotification(request, env, uid, p.split('/')[2]);
      }

      // 定时任务（配置在服务端，执行由 Cron 完成；端侧只做 CRUD，不需要任何定时器）
      if (p === '/jobs' && request.method === 'GET') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return listJobs(request, env, uid);
      }
      if (p === '/jobs' && request.method === 'POST') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return createJob(request, env, uid);
      }
      if (p.startsWith('/jobs/') && request.method === 'PUT') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return updateJob(request, env, uid, p.split('/')[2]);
      }
      if (p.startsWith('/jobs/') && request.method === 'DELETE') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return deleteJob(request, env, uid, p.split('/')[2]);
      }

      return json({ error: 'not found' }, 404);
    }

    return json({ error: 'not found', service: 'notify-hub' }, 404);
  },

  // Cron Triggers：每分钟一次，扫描 jobs 表执行到期任务（tick-and-scan）
  // 与 fetch 并列，是同一种 Worker 的另一种触发方式，不会有 HTTP 请求进来。
  // 注意点：
  //   1) 用 controller.scheduledTime（计划时刻）而非 Date.now()，避免把本次 tick 的延迟带进 next_run_at 递推
  //   2) 这里直接调函数，不要 fetch 自己的 /hook/:key —— 那是入站请求，会真的再计 1 次 Worker 请求
  //   3) cron 执行失败不会重试也不会告警，靠列表里的「上次执行」自查
  async scheduled(controller, env) {
    const t = controller && controller.scheduledTime ? Number(controller.scheduledTime) : Date.now();
    try {
      const r = await runDueJobs(env, t);
      if (r.scanned || r.errors) console.log('jobs_tick', JSON.stringify(r));
    } catch (err) {
      console.error('jobs_tick_failed', String(err));
    }
  },
};
