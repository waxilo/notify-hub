// Worker 入口：路由 + CORS
import { json } from './utils.js';
import { register, login, changePassword, verifyJWT } from './auth.js';
import { createKey, listKeys, revokeKey } from './keys.js';
import { listNotifications, getNotification, markRead, deleteNotification } from './notifications.js';
import { handleWebhook } from './webhook.js';
import { PushHub } from './push.js';

// Durable Object 类必须从主入口导出
export { PushHub };

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

    // ---- WebSocket 实时推送（JWT 鉴权，token 走 query 或 Authorization）----
    if (pathname === '/ws' && request.method === 'GET') {
      const url = new URL(request.url);
      const auth = request.headers.get('Authorization') || '';
      const token = url.searchParams.get('token')
        || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
      if (!token) return json({ error: 'missing token' }, 401);
      const payload = await verifyJWT(token, env.JWT_SECRET);
      if (!payload) return json({ error: 'unauthorized' }, 401);
      const id = env.PUSH_HUB.idFromName(payload.sub);
      return env.PUSH_HUB.get(id).fetch(new Request('https://do/connect', request));
    }

    if (pathname.startsWith('/api/')) {
      const p = pathname.replace('/api', '');

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
      if (p.startsWith('/keys/') && request.method === 'DELETE') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return revokeKey(request, env, uid, p.split('/')[2]);
      }

      // 通知（供安卓端轮询）
      if (p === '/notifications' && request.method === 'GET') {
        const uid = await getUserId(request, env);
        const e = requireAuth(uid); if (e) return e;
        return listNotifications(request, env, uid);
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

      return json({ error: 'not found' }, 404);
    }

    return json({ error: 'not found', service: 'notify-hub' }, 404);
  },
};
