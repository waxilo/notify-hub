// QQ 官方机器人协议层：access_token 换取/缓存、发消息、回调验签。
// **本文件不碰数据库** —— 凭证由调用方传入（bots.js 从 bots 表解析），
// 回调如何定位到账号也归 bots.js。协议与配置分开，两边都不必互相 import。
//
// 官方文档 bot.qq.com/wiki/develop/api-v2：
//   POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}
//     → { access_token, expires_in: 7200 }   生命周期 2 小时，过期前自行刷新
//   调用 OpenAPI 时 header 带 `Authorization: QQBot <access_token>`
//
// 发消息（不带 msg_id 即为主动消息；频控：单群/单好友 1000 条/天 —— 自用通知绰绰有余）：
//   群：  POST https://api.sgroup.qq.com/v2/groups/{group_openid}/messages
//   私聊：POST https://api.sgroup.qq.com/v2/users/{user_openid}/messages
//   （私聊主动消息前提：对方加了机器人为好友，且未关闭「允许主动发送」开关）
//
// 回调安全：QQ 平台对每个事件用 Ed25519 签名（X-Signature-Ed25519，
// seed = AppSecret 重复填充至 32 字节），签名消息 = X-Signature-Timestamp + 原始 body。
// 这里用 tweetnacl 派生公钥验签；URL 验证（op=13）按官方要求返回 {plain_token, signature}。
import nacl from 'tweetnacl';

const TOKEN_API = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

// Worker 同一 isolate 内缓存 access_token，按「appId|secret 指纹」分键 ——
// 多机器人并存时各用各的 token，改凭证后旧 token 自动失效；提前 2 分钟刷新。
const TOKEN_CACHE_MAX = 64;
const tokenCache = new Map();

/* ---------------- access_token ---------------- */

export async function getAccessToken(cfg, force = false) {
  const now = Date.now();
  const key = cfg.appId + '|' + cfg.appSecret;
  const hit = tokenCache.get(key);
  if (!force && hit && now < hit.expireAt) return hit.token;

  const res = await fetch(TOKEN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.appSecret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`qq_token_failed ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const ttl = Math.max(parseInt(data.expires_in || '7200', 10) - 120, 300);
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(key, { token: data.access_token, expireAt: now + ttl * 1000 });
  return data.access_token;
}

/* ---------------- 发消息 ---------------- */

// 向单个 openid 发文本消息（msg_type=0，正文由调用方按模板渲染好）。
// 任何失败向上抛，由 deliver 逐目标隔离（一个群失败不影响其他群）。
export async function sendToOpenid(cfg, kind, openid, text) {
  const token = await getAccessToken(cfg);
  const path = kind === 'group' ? 'groups' : 'users';
  const res = await fetch(`${API_BASE}/v2/${path}/${encodeURIComponent(openid)}/messages`, {
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

/* ---------------- 回调签名 ---------------- */

// 官方 seed 派生（sign.html）：secret 不足 32 字节时 repeat 填充后截取 32 字节
function seedFromSecret(secret) {
  let s = String(secret || '');
  while (s.length < 32) s = s.repeat(2);
  return new TextEncoder().encode(s.slice(0, 32));
}

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

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 事件验签：消息 = timestamp + rawBody。secret 为空直接判否（配置不全的机器人不参与）
export function verifySignature(secret, sigHex, timestamp, rawBody) {
  if (!secret) return false;
  const sig = hexToBytes(sigHex);
  if (!sig || sig.length !== 64) return false;
  const msg = new TextEncoder().encode(String(timestamp) + String(rawBody));
  try {
    const { publicKey } = nacl.sign.keyPair.fromSeed(seedFromSecret(secret));
    return nacl.sign.detached.verify(msg, sig, publicKey);
  } catch {
    return false;
  }
}

// op=13 URL 验证（官方 event-emit.html）：签名消息 = event_ts + plain_token
export function validationResponse(secret, plainToken, eventTs) {
  const msg = new TextEncoder().encode(String(eventTs || '') + String(plainToken || ''));
  const { secretKey } = nacl.sign.keyPair.fromSeed(seedFromSecret(secret));
  return { plain_token: plainToken, signature: bytesToHex(nacl.sign.detached(msg, secretKey)) };
}
