// 极简 API 封装：token 存 localStorage；所有请求自动驱动顶部进度条
// 版本号统一从入口脚本的 ?v= 派生（见 index.html 注释），所以这里不再手写版本串。
const V = new URL(import.meta.url).search || '';
const { API_BASE } = await import(`./config.js${V}`);

const TOKEN_KEY = 'nh_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }
export function isLoggedIn() { return !!getToken(); }

/* ---------- 顶部进度条（计数器，支持并发请求） ----------
   刻意不用全屏遮罩：切换启停这类瞬时请求不该把整个界面盖住，
   耗时较久的列表则由各视图自己的骨架屏承担「正在加载」的表达。 */
let barEl = null, barCount = 0, hideTimer = null;

export function loadingPush() {
  barCount++;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (!barEl) {
    barEl = document.createElement('div');
    barEl.className = 'loadbar';
    barEl.setAttribute('role', 'progressbar');
    barEl.setAttribute('aria-label', '请求进行中');
    barEl.innerHTML = '<i></i>';
    document.body.appendChild(barEl);
  }
  barEl.classList.add('on');
}

export function loadingPop() {
  barCount = Math.max(0, barCount - 1);
  if (barCount > 0 || !barEl) return;
  const el = barEl;
  el.classList.remove('on');
  hideTimer = setTimeout(() => {
    el.remove();
    if (barEl === el) barEl = null;
    hideTimer = null;
  }, 320);
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
  // QQ 机器人配置：secret/openid 服务端只回掩码；app_secret 留空 = 保持不变
  getQQConfig: () => req('/qq/config'),
  updateQQConfig: (body) => req('/qq/config', 'PUT', body),
  unbindQQ: (kind, openid) => req('/qq/config', 'PUT', { unbind_kind: kind, unbind_openid: openid }),
  testQQ: () => req('/qq/test', 'POST', {}),
};

export { API_BASE };
