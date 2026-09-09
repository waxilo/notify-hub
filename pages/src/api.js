// 极简 API 封装：token 存 localStorage
import { API_BASE } from './config.js';

const TOKEN_KEY = 'nh_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }
export function isLoggedIn() { return !!getToken(); }

async function req(path, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  const tk = getToken();
  if (tk) headers.Authorization = `Bearer ${tk}`;
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  register: (username, password) => req('/register', 'POST', { username, password }),
  login: (username, password) => req('/login', 'POST', { username, password }),
  changePassword: (oldPassword, newPassword) => req('/password', 'POST', { oldPassword, newPassword }),
  createKey: (name) => req('/keys', 'POST', { name }),
  listKeys: () => req('/keys'),
  revokeKey: (id) => req(`/keys/${id}`, 'DELETE'),
  listNotifications: (keyId) => req(`/notifications${keyId ? `?key_id=${keyId}` : ''}`),
};
