// 鉴权：密码哈希(PBKDF2)、JWT 签发/校验，以及 register/login/changePassword 处理器
import { json, readJson } from './utils.js';

const PBKDF2_ITERATIONS = 100000;

// ---------- base64url ----------
export function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- 密码哈希 ----------
export async function hashPassword(password, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64
    ? b64urlDecode(saltB64)
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return {
    salt: saltB64 || b64urlEncode(salt),
    hash: b64urlEncode(bits),
  };
}

export async function verifyPassword(password, salt, expectedHash) {
  const { hash } = await hashPassword(password, salt);
  return hash === expectedHash;
}

// ---------- JWT (HS256) ----------
export async function signJWT(payload, secret) {
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64urlEncode(sig)}`;
}

export async function verifyJWT(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(s), enc.encode(`${h}.${p}`));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- 处理器 ----------
export async function register(request, env) {
  const body = await readJson(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || password.length < 6) {
    return json({ error: '用户名必填，密码至少 6 位' }, 400);
  }
  const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) return json({ error: '用户名已存在' }, 409);

  const { salt, hash } = await hashPassword(password);
  const res = await env.DB.prepare(
    'INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES (?,?,?,?)'
  ).bind(username, hash, salt, Date.now()).run();

  const token = await signJWT({ sub: res.meta.last_row_id, username }, env.JWT_SECRET);
  return json({ token, userId: res.meta.last_row_id }, 201);
}

export async function login(request, env) {
  const body = await readJson(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) return json({ error: '用户名或密码错误' }, 401);

  const ok = await verifyPassword(password, user.pass_salt, user.pass_hash);
  if (!ok) return json({ error: '用户名或密码错误' }, 401);

  const token = await signJWT({ sub: user.id, username: user.username }, env.JWT_SECRET);
  return json({ token, userId: user.id });
}

export async function changePassword(request, env, userId) {
  const body = await readJson(request);
  const oldP = String(body.oldPassword || '');
  const newP = String(body.newPassword || '');
  if (newP.length < 6) return json({ error: '新密码至少 6 位' }, 400);

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!user) return json({ error: '用户不存在' }, 404);
  const ok = await verifyPassword(oldP, user.pass_salt, user.pass_hash);
  if (!ok) return json({ error: '原密码错误' }, 401);

  const { salt, hash } = await hashPassword(newP);
  await env.DB.prepare('UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?').bind(hash, salt, userId).run();
  return json({ ok: true });
}
