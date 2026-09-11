// QQ 官方机器人触达通道（主动发消息走官方 OpenAPI，无封号风险、无需网关容器）
//
// 凭证机制（官方文档 bot.qq.com/wiki/develop/api-v2）：
//   POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}
//     → { access_token, expires_in: 7200 }   生命周期 2 小时，过期前自行刷新
//   调用 OpenAPI 时 header 带 `Authorization: QQBot <access_token>`
//
// 发消息（不带 msg_id 即为主动消息；频控：单群/单好友 1000 条/天 —— 自用通知绰绰有余）：
//   群：  POST https://api.sgroup.qq.com/v2/groups/{group_openid}/messages
//   私聊：POST https://api.sgroup.qq.com/v2/users/{user_openid}/messages
//   （私聊主动消息前提：对方加了机器人为好友，且未关闭「允许主动发送」开关）
//
// 配置来源（Web 控制台可改，保存即生效、无需重新部署）：
//   AppID/AppSecret/触达目标 → settings 表（qq_app_id / qq_app_secret / qq_target）优先，
//   env（QQ_APP_ID / QQ_APP_SECRET / QQ_TARGET，wrangler secret/vars）兜底。
//   openid 相反：env 显式钉死优先（沙箱/多群场景），否则用回调自动捕获的存库值。
//
// openid 官方不提供查询接口，只能从事件里拿（回调 URL 配到本服务的 /api/qq/callback）：
//   群绑定：在群里 @机器人 说一句话 → GROUP_AT_MESSAGE_CREATE 自动存 qq_group_openid
//   私聊绑定：私聊机器人发一句话     → C2C_MESSAGE_CREATE 自动存 qq_user_openid
//
// 回调安全：QQ 平台对每个事件用 Ed25519 签名（X-Signature-Ed25519，seed = AppSecret 重复填充至 32 字节），
// 这里用 tweetnacl 派生公钥验签；URL 验证（op=13）按官方要求返回 {plain_token, signature}。
import nacl from 'tweetnacl';
import { json } from './utils.js';

const TOKEN_API = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const GROUP_OPENID_KEY = 'qq_group_openid';
const USER_OPENID_KEY = 'qq_user_openid';
const VALID_TARGETS = ['group', 'c2c', 'both'];

// Worker 同一 isolate 内复用 token；key 含凭证指纹 —— Web 改配置后旧 token 自动失效；
// 提前 2 分钟刷新，避免用到已过期的值
let tokenCache = { key: '', token: '', expireAt: 0 };

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

export async function delSetting(env, key) {
  await env.DB.prepare('DELETE FROM settings WHERE k=?').bind(key).run();
}

/* ---------------- 配置解析 ---------------- */

function normalizeTarget(t) {
  const s = String(t || '').trim().toLowerCase();
  return VALID_TARGETS.includes(s) ? s : 'group';
}

// 凭证与触达目标：settings 优先（Web 配置的值覆盖 env），env/secret 兜底
export async function resolveBotConfig(env) {
  const [appId, appSecret, target] = await Promise.all([
    getSetting(env, 'qq_app_id'),
    getSetting(env, 'qq_app_secret'),
    getSetting(env, 'qq_target'),
  ]);
  return {
    appId: appId || env.QQ_APP_ID || '',
    appSecret: appSecret || env.QQ_APP_SECRET || '',
    target: normalizeTarget(target || env.QQ_TARGET),
  };
}

// 触达目标列表：group=只发群 / c2c=只发私聊 / both=都发
export function targetKinds(target) {
  if (target === 'both') return ['group', 'c2c'];
  if (target === 'c2c') return ['c2c'];
  return ['group'];
}

// openid：env 显式配置优先（沙箱/多群/固定好友场景可钉死），否则用回调自动捕获的
export async function getOpenid(env, kind) {
  const envKey = kind === 'group' ? 'QQ_GROUP_OPENID' : 'QQ_USER_OPENID';
  if (env[envKey]) return env[envKey];
  return getSetting(env, kind === 'group' ? GROUP_OPENID_KEY : USER_OPENID_KEY);
}

/* ---------------- 发送 ---------------- */

export async function getAccessToken(env, cfg, force = false) {
  const now = Date.now();
  const key = cfg.appId + '|' + cfg.appSecret;
  if (!force && tokenCache.token && tokenCache.key === key && now < tokenCache.expireAt) {
    return tokenCache.token;
  }

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
  tokenCache = { key, token: data.access_token, expireAt: now + ttl * 1000 };
  return tokenCache.token;
}

// text：title 与 body 已由调用方拼好。返回 true；任何失败向上抛（由 deliver 隔离）。
async function postMessage(env, cfg, kind, openid, text) {
  const token = await getAccessToken(env, cfg);
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

export async function sendGroupMessage(env, cfg, text) {
  const openid = await getOpenid(env, 'group');
  if (!openid) {
    throw new Error('qq_group_openid 未配置：在 QQ 群里 @机器人 发一条消息即可自动绑定');
  }
  return postMessage(env, cfg, 'group', openid, text);
}

export async function sendC2CMessage(env, cfg, text) {
  const openid = await getOpenid(env, 'c2c');
  if (!openid) {
    throw new Error('qq_user_openid 未配置：先加机器人为好友，再私聊它发一条消息即可自动绑定');
  }
  return postMessage(env, cfg, 'c2c', openid, text);
}

/* ---------------- 回调（/api/qq/callback） ---------------- */

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

// AppSecret 派生 Ed25519 私钥（官方算法：seed = secret 重复填充至 32 字节）；
// 事件验签的消息 = timestamp + body（官方 sign.html）
function verifySignature(secret, sigHex, timestamp, rawBody) {
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

// op=13 URL 验证（官方 event-emit.html）：签名消息 = event_ts + plain_token，
// 用 seed=secret 的 Ed25519 私钥签名，返回 {plain_token, signature}（hex）
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function validationResponse(secret, plainToken, eventTs) {
  const msg = new TextEncoder().encode(String(eventTs || '') + String(plainToken || ''));
  const { secretKey } = nacl.sign.keyPair.fromSeed(seedFromSecret(secret));
  return { plain_token: plainToken, signature: bytesToHex(nacl.sign.detached(msg, secretKey)) };
}

// QQ 平台回调入口（公开路由，靠 Ed25519 验签保证来源可信）：
//   1) op=13（URL 验证）：签 event_ts+plain_token 返回 {plain_token, signature}
//   2) GROUP_AT_MESSAGE_CREATE：捕获 group_openid 存库（首次绑定 / 换群自动更新）
//   3) C2C_MESSAGE_CREATE：捕获 user_openid 存库（私聊绑定 / 好友换号自动更新）
//   其余事件：验签后忽略（当前只用它拿 openid）
export async function handleCallback(request, env) {
  const cfg = await resolveBotConfig(env);
  if (!cfg.appId || !cfg.appSecret) {
    return json({ error: 'qq bot not configured (set in web console, or QQ_APP_ID / QQ_APP_SECRET via wrangler secret)' }, 500);
  }
  const raw = await request.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }

  // 请求留痕（排查回调配置问题用；只保留最近一次）
  try {
    await setSetting(env, 'qq_last_callback', JSON.stringify({
      ts: new Date().toISOString(),
      ua: request.headers.get('User-Agent') || '',
      bot_appid: request.headers.get('X-Bot-Appid') || '',
      op: payload.op,
      d_keys: payload.d ? Object.keys(payload.d).join(',') : '',
      raw: raw.slice(0, 2000),
    }));
  } catch { /* 留痕失败不影响主流程 */ }

  // URL 验证（op=13）：按官方要求用 secret 派生私钥签 event_ts+plain_token 并回显 JSON
  if (payload.op === 13) {
    const d = payload.d || {};
    if (!d.plain_token) return json({ error: 'missing plain_token' }, 400);
    return json(validationResponse(cfg.appSecret, d.plain_token, d.event_ts));
  }

  const sig = request.headers.get('X-Signature-Ed25519') || '';
  const ts = request.headers.get('X-Signature-Timestamp') || '';
  if (!verifySignature(cfg.appSecret, sig, ts, raw)) {
    return json({ error: 'invalid signature' }, 401);
  }

  if (payload.t === 'GROUP_AT_MESSAGE_CREATE' && payload.d && payload.d.group_openid) {
    const prev = await getSetting(env, GROUP_OPENID_KEY);
    if (prev !== payload.d.group_openid) {
      await setSetting(env, GROUP_OPENID_KEY, payload.d.group_openid);
    }
  }
  if (payload.t === 'C2C_MESSAGE_CREATE' && payload.d && payload.d.user_openid) {
    const prev = await getSetting(env, USER_OPENID_KEY);
    if (prev !== payload.d.user_openid) {
      await setSetting(env, USER_OPENID_KEY, payload.d.user_openid);
    }
  }
  return json({ ok: true });
}

/* ---------------- Web 控制台配置接口（需登录，路由挂 /api/qq/*） ---------------- */

const mask = (s) => (!s ? '' : s.length <= 8 ? '****' : s.slice(0, 4) + '****' + s.slice(-4));

// GET /api/qq/config —— 当前配置视图（secret/openid 只回掩码，不回明文）
export async function getBotConfigView(request, env, userId) {
  const cfg = await resolveBotConfig(env);
  const [groupOpenid, userOpenid] = await Promise.all([getOpenid(env, 'group'), getOpenid(env, 'c2c')]);
  return json({
    app_id: cfg.appId,
    has_secret: !!cfg.appSecret,
    secret_masked: mask(cfg.appSecret),
    target: cfg.target,
    group_openid: groupOpenid || '',
    user_openid: userOpenid || '',
  });
}

// PUT /api/qq/config —— 更新配置（字段不传不改）：
//   app_id：传空串清除（回落 env）；app_secret：空串 = 保持不变（表单留空语义），传值即覆盖；
//   clear_secret=true 删除 Web 存的 secret（回落 env）；target ∈ group/c2c/both。
export async function updateBotConfig(request, env, userId) {
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') return json({ error: 'bad json' }, 400);
  if (b.app_id !== undefined) {
    const v = String(b.app_id).trim();
    if (v) await setSetting(env, 'qq_app_id', v);
    else await delSetting(env, 'qq_app_id');
  }
  if (b.app_secret !== undefined && String(b.app_secret) !== '') {
    await setSetting(env, 'qq_app_secret', String(b.app_secret));
  }
  if (b.clear_secret) await delSetting(env, 'qq_app_secret');
  if (b.target !== undefined) {
    if (!VALID_TARGETS.includes(String(b.target).trim().toLowerCase())) {
      return json({ error: 'target 必须是 group / c2c / both' }, 400);
    }
    await setSetting(env, 'qq_target', normalizeTarget(b.target));
  }
  return json({ ok: true });
}

// POST /api/qq/test —— 用当前配置真实换取一次 access_token，验证凭证有效性（不发任何消息）
export async function testBotConfig(request, env, userId) {
  const cfg = await resolveBotConfig(env);
  if (!cfg.appId || !cfg.appSecret) {
    return json({ ok: false, error: '尚未配置 AppID/AppSecret' });
  }
  try {
    await getAccessToken(env, cfg, true);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err).slice(0, 300) });
  }
}
