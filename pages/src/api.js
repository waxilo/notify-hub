// 极简 API 封装：token 存 localStorage；所有请求自动挂全局加载遮罩
import { API_BASE } from './config.js';

const TOKEN_KEY = 'nh_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }
export function isLoggedIn() { return !!getToken(); }

// ---------- 全局加载遮罩（计数器，支持并发请求） ----------
let maskEl = null, maskCount = 0;
export function loadingPush() {
  maskCount++;
  if (!maskEl) {
    maskEl = document.createElement('div');
    maskEl.className = 'loading-mask';
    maskEl.innerHTML = '<div class="loading-box"><div class="spinner"></div><span>加载中…</span></div>';
    document.body.appendChild(maskEl);
  }
}
export function loadingPop() {
  maskCount = Math.max(0, maskCount - 1);
  if (maskCount === 0 && maskEl) { maskEl.remove(); maskEl = null; }
}

async function req(path, method = 'GET', body) {
  loadingPush();
  try {
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
  } finally {
    loadingPop();
  }
}

export const api = {
  register: (username, password) => req('/register', 'POST', { username, password }),
  login: (username, password) => req('/login', 'POST', { username, password }),
  changePassword: (oldPassword, newPassword) => req('/password', 'POST', { oldPassword, newPassword }),
  createKey: (name) => req('/keys', 'POST', { name }),
  listKeys: () => req('/keys'),
  updateKey: (id, body) => req(`/keys/${id}`, 'PUT', body),
  deleteKey: (id) => req(`/keys/${id}`, 'DELETE'),
  // 历史查询：keyId = 外部 key 的写入记录，jobId = 定时任务的触发记录（二者互斥，不会同时有值）
  listNotifications: ({ keyId, jobId, limit = 10, offset = 0 } = {}) => {
    const q = new URLSearchParams({ limit, offset });
    if (keyId) q.set('key_id', keyId);
    if (jobId) q.set('job_id', jobId);
    return req(`/notifications?${q}`);
  },
  // 批量清空历史：服务端要求必须带 key_id 或 job_id（不提供「清空全部」）
  clearNotifications: ({ keyId, jobId }) => {
    const q = new URLSearchParams();
    if (keyId) q.set('key_id', keyId);
    if (jobId) q.set('job_id', jobId);
    return req(`/notifications?${q}`, 'DELETE');
  },
  // 定时任务：只做配置，执行由服务端 Cron 完成，浏览器关掉也不影响
  listJobs: () => req('/jobs'),
  createJob: (body) => req('/jobs', 'POST', body),
  updateJob: (id, body) => req(`/jobs/${id}`, 'PUT', body),
  deleteJob: (id) => req(`/jobs/${id}`, 'DELETE'),
};
