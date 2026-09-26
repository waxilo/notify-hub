// Worker 入口：路由表 + CORS + Cron 触发
//
// 路由写成一张表（method + 正则 + 处理函数），而不是一长串 if：
//   1) 加一条路由只有一行，不会再出现「处理函数写好了、路由忘了挂」这类只报 404 的隐形故障
//      （2026-09-10 的 PUT /api/keys/:id 就是这么丢的，线上一直 404 谁都没发现）；
//   2) 鉴权在表的外层统一处理（public: true 才放行免登录），不会漏写；
//   3) 处理函数统一收一个 ctx（request/env/ctx/origin/url/正则捕获/uid），签名一致、好读。
import { json } from './utils.js';
import { register, login, changePassword, verifyJWT } from './auth.js';
import { createKey, listKeys, updateKey, deleteKey } from './keys.js';
import { listNotifications, getNotification, markRead, deleteNotification, clearNotifications } from './notifications.js';
import { handleWebhook } from './webhook.js';
import {
  handleCallback,
  listBots, createBot, updateBot, deleteBot, testBot, removeBotTarget,
  legacyGetConfig, legacyUpdateConfig, legacyTestBot,
} from './bots.js';
import { listJobs, createJob, updateJob, deleteJob, runDueJobs } from './jobs.js';

async function getUserId(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const payload = await verifyJWT(auth.slice(7), env.JWT_SECRET);
  return payload ? payload.sub : null;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

// 路由表：按顺序匹配，第一个命中者胜出。
//   handler 收 ctx = { request, env, ctx, url, origin, m（正则捕获）, uid }
//   origin 是回给控制台拼回调地址用的（机器人回调 URL 里含域名，写死会在换域后失效）
const ROUTES = [
  /* ---------------- 公开路由（public: true，不鉴权） ---------------- */
  // 通用 webhook：任意来源推消息的入口，靠 URL 里的 key 自证身份
  { method: 'GET', pattern: /^\/hook\/([\w-]+)$/, public: true, handler: (c) => handleWebhook(c.request, c.env, c.m[1]) },
  { method: 'POST', pattern: /^\/hook\/([\w-]+)$/, public: true, handler: (c) => handleWebhook(c.request, c.env, c.m[1]) },
  // QQ 平台事件回调：公开路由，靠 Ed25519 验签保证来源可信（地址在开放平台管理端配置，必须稳定）
  { method: 'POST', pattern: /^\/api\/qq\/callback$/, public: true, handler: (c) => handleCallback(c.request, c.env, c.ctx, c.origin) },
  { method: 'POST', pattern: /^\/api\/register$/, public: true, handler: (c) => register(c.request, c.env) },
  { method: 'POST', pattern: /^\/api\/login$/, public: true, handler: (c) => login(c.request, c.env) },

  /* ---------------- 账号 ---------------- */
  { method: 'POST', pattern: /^\/api\/password$/, handler: (c) => changePassword(c.request, c.env, c.uid) },

  /* ---------------- 机器人（账号隔离：每账号可接多个，各自绑定 key / 定时任务） ---------------- */
  { method: 'GET', pattern: /^\/api\/bots$/, handler: (c) => listBots(c.request, c.env, c.uid, c.origin) },
  { method: 'POST', pattern: /^\/api\/bots$/, handler: (c) => createBot(c.request, c.env, c.uid, c.origin) },
  // 固定子路径必须排在 /:id 之前（两者不冲突，但读起来顺序一致）
  { method: 'POST', pattern: /^\/api\/bots\/(\d+)\/test$/, handler: (c) => testBot(c.request, c.env, c.uid, c.m[1]) },
  { method: 'DELETE', pattern: /^\/api\/bots\/(\d+)\/targets$/, handler: (c) => removeBotTarget(c.request, c.env, c.uid, c.m[1]) },
  { method: 'PUT', pattern: /^\/api\/bots\/(\d+)$/, handler: (c) => updateBot(c.request, c.env, c.uid, c.m[1], c.origin) },
  { method: 'DELETE', pattern: /^\/api\/bots\/(\d+)$/, handler: (c) => deleteBot(c.request, c.env, c.uid, c.m[1]) },

  // 旧接口兼容：重构前「一个账号一份机器人配置」，现在等价于「账号默认机器人」。
  // 保留是为了已经发布的客户端（安卓端配置页）不直接 404；新代码请用 /api/bots。
  { method: 'GET', pattern: /^\/api\/qq\/config$/, handler: (c) => legacyGetConfig(c.request, c.env, c.uid, c.origin) },
  { method: 'PUT', pattern: /^\/api\/qq\/config$/, handler: (c) => legacyUpdateConfig(c.request, c.env, c.uid, c.origin) },
  { method: 'POST', pattern: /^\/api\/qq\/test$/, handler: (c) => legacyTestBot(c.request, c.env, c.uid) },

  /* ---------------- key 管理 ---------------- */
  { method: 'POST', pattern: /^\/api\/keys$/, handler: (c) => createKey(c.request, c.env, c.uid) },
  { method: 'GET', pattern: /^\/api\/keys$/, handler: (c) => listKeys(c.request, c.env, c.uid) },
  { method: 'PUT', pattern: /^\/api\/keys\/([\w-]+)$/, handler: (c) => updateKey(c.request, c.env, c.uid, c.m[1]) },
  { method: 'DELETE', pattern: /^\/api\/keys\/([\w-]+)$/, handler: (c) => deleteKey(c.request, c.env, c.uid, c.m[1]) },

  /* ---------------- 通知（?key_id= 按外部 key 过滤、?job_id= 按定时任务过滤） ---------------- */
  { method: 'GET', pattern: /^\/api\/notifications$/, handler: (c) => listNotifications(c.request, c.env, c.uid) },
  // 批量清空必须带 ?key_id= 或 ?job_id=（不提供清空全部）
  { method: 'DELETE', pattern: /^\/api\/notifications$/, handler: (c) => clearNotifications(c.request, c.env, c.uid) },
  { method: 'POST', pattern: /^\/api\/notifications\/(\d+)\/read$/, handler: (c) => markRead(c.request, c.env, c.uid, c.m[1]) },
  { method: 'GET', pattern: /^\/api\/notifications\/(\d+)$/, handler: (c) => getNotification(c.request, c.env, c.uid, c.m[1]) },
  { method: 'DELETE', pattern: /^\/api\/notifications\/(\d+)$/, handler: (c) => deleteNotification(c.request, c.env, c.uid, c.m[1]) },

  /* ---------------- 定时任务（配置在服务端，执行由 Cron 完成；端侧零定时器） ---------------- */
  { method: 'GET', pattern: /^\/api\/jobs$/, handler: (c) => listJobs(c.request, c.env, c.uid) },
  { method: 'POST', pattern: /^\/api\/jobs$/, handler: (c) => createJob(c.request, c.env, c.uid) },
  { method: 'PUT', pattern: /^\/api\/jobs\/(\d+)$/, handler: (c) => updateJob(c.request, c.env, c.uid, c.m[1]) },
  { method: 'DELETE', pattern: /^\/api\/jobs\/(\d+)$/, handler: (c) => deleteJob(c.request, c.env, c.uid, c.m[1]) },
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    for (const route of ROUTES) {
      if (route.method !== request.method) continue;
      const m = url.pathname.match(route.pattern);
      if (!m) continue;

      const c = { request, env, ctx, url, origin: url.origin, m, uid: null };
      if (!route.public) {
        c.uid = await getUserId(request, env);
        if (!c.uid) return json({ error: 'unauthorized' }, 401);
      }
      return route.handler(c);
    }

    // /api/* 下的未注册路径只回通用 404；其他路径带上服务名，便于区分「打到别的服务了」
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
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
