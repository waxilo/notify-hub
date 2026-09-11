// QQ 官方机器人触达通道（主动发消息走官方 OpenAPI，无封号风险、无需网关容器）
//
// 凭证机制（官方文档 bot.qq.com/wiki/develop/api-v2）：
//   POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}
//     → { access_token, expires_in: 7200 }   生命周期 2 小时，过期前自行刷新
//   调用 OpenAPI 时 header 带 `Authorization: QQBot <access_token>`
//
// 发群消息：
//   POST https://api.sgroup.qq.com/v2/groups/{group_openid}/messages
//   body { msg_type: 0, content: "文本" }   不带 msg_id 即为主动消息
//   频控：单群 1000 条/天、Bot 维度 30~60 条/分钟 —— 自用通知场景绰绰有余
//
// group_openid 官方不提供查询接口，只能从群事件里拿：
//   开放平台把回调 URL 配到本服务的 /api/qq/callback，在群里 @机器人 说句话，
//   GROUP_AT_MESSAGE_CREATE 事件里的 group_openid 会被自动存进 settings 表。
//
// 回调安全：QQ 平台对每个事件用 Ed25519 签名（X-Signature-Ed25519，密钥 seed = AppSecret），
// 这里用 tweetnacl 从 seed 派生公钥做验签；URL 验证（op=13）按官方要求回显 AppSecret 明文。
import nacl from 'tweetnacl';
import { json } from './utils.js';

const TOKEN_API = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const GROUP_OPENID_KEY = 'qq_group_openid';

// Worker 同一 isolate 内复用 token；提前 2 分钟刷新，避免用到已过期的值
let tokenCache = { token: '', expireAt: 0 };

export async function getAccessToken(env) {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expireAt) return tokenCache.token;

  const res = await fetch(TOKEN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: env.QQ_APP_ID, clientSecret: env.QQ_APP_SECRET }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`qq_token_failed ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const ttl = Math.max(parseInt(data.expires_in || '7200', 10) - 120, 300);
  tokenCache = { token: data.access_token, expireAt: now + ttl * 1000 };
  return tokenCache.token;
}

/* ---------------- settings 键值存取（0010 迁移的表） ---------------- */

export async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(key).first();
  return row ? row.v : null;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  ).bind(key, value).run();
}

// 群 openid：env 显式配置优先（沙箱/多群场景可固定），否则用回调自动捕获的
export async function getGroupOpenid(env) {
  if (env.QQ_GROUP_OPENID) return env.QQ_GROUP_OPENID;
  return getSetting(env, GROUP_OPENID_KEY);
}

/* ---------------- 发送 ---------------- */

// text：title 与 body 已由调用方拼好。返回 true；任何失败向上抛（由 deliver 隔离）。
export async function sendGroupMessage(env, text) {
  const openid = await getGroupOpenid(env);
  if (!openid) {
    throw new Error('qq_group_openid 未配置：在 QQ 群里 @机器人 发一条消息即可自动绑定');
  }
  const token = await getAccessToken(env);
  const res = await fetch(`${API_BASE}/v2/groups/${encodeURIComponent(openid)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
    body: JSON.stringify({ msg_type: 0, content: String(text || '') }),
  });
  const data = await res.json().catch(() => ({}));
  // 正常回包形如 {"result":0,...}；HTTP 200 但 result 非 0 也是业务失败
  if (!res.ok || (data && typeof data.result === 'number' && data.result !== 0)) {
    throw new Error(`qq_send_failed ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return true;
}

/* ---------------- 回调（/api/qq/callback） ---------------- */

function hexToBytes(hex) {
  if (!hex || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return null;
    out[i] = b;
  }
  return out;
}

// AppSecret 是 Ed25519 私钥的 seed（32 字节）；从中派生公钥用于验签
function verifySignature(secret, sigHex, timestamp, rawBody) {
  const seed = new TextEncoder().encode(String(secret || ''));
  if (seed.length !== 32) return false;
  const sig = hexToBytes(sigHex);
  if (!sig || sig.length !== 64) return false;
  const msg = new TextEncoder().encode(String(timestamp) + String(rawBody));
  try {
    const { publicKey } = nacl.sign.keyPair.fromSeed(seed);
    return nacl.sign.detached.verify(msg, sig, publicKey);
  } catch {
    return false;
  }
}

// QQ 平台回调入口（公开路由，靠 Ed25519 验签保证来源可信）：
//   1) op=13（URL 验证）：官方要求在 5 秒内原样返回 AppSecret 明文（非 JSON）
//   2) GROUP_AT_MESSAGE_CREATE：捕获 group_openid 存库（首次绑定 / 换群自动更新）
//   其余事件：验签后忽略（当前只用它拿 openid）
export async function handleCallback(request, env) {
  if (!env.QQ_APP_ID || !env.QQ_APP_SECRET) {
    return json({ error: 'qq bot not configured (set QQ_APP_ID / QQ_APP_SECRET via wrangler secret)' }, 500);
  }
  const raw = await request.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }

  // URL 验证放行（验签公钥同样来自 secret，官方流程即为回显 secret）
  if (payload.op === 13) {
    return new Response(env.QQ_APP_SECRET, { headers: { 'Content-Type': 'text/html' } });
  }

  const sig = request.headers.get('X-Signature-Ed25519') || '';
  const ts = request.headers.get('X-Signature-Timestamp') || '';
  if (!verifySignature(env.QQ_APP_SECRET, sig, ts, raw)) {
    return json({ error: 'invalid signature' }, 401);
  }

  if (payload.t === 'GROUP_AT_MESSAGE_CREATE' && payload.d && payload.d.group_openid) {
    const prev = await getSetting(env, GROUP_OPENID_KEY);
    if (prev !== payload.d.group_openid) {
      await setSetting(env, GROUP_OPENID_KEY, payload.d.group_openid);
    }
  }
  return json({ ok: true });
}
