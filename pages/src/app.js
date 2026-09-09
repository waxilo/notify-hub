// Web 控制台逻辑（仅配置）
import { API_BASE } from './config.js';
import { api, getToken, setToken, isLoggedIn } from './api.js';

const $ = (sel) => document.querySelector(sel);
const root = $('#app');
// APK 固定下载链接（GitHub Release latest，无需登录/token）
const APK_URL = 'https://github.com/waxilo/notify-hub/releases/latest/download/app-debug.apk';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function authView() {
  root.innerHTML = `
  <div class="card auth">
    <h1>Notify Hub 控制台</h1>
    <div class="tabs">
      <button id="tab-login" class="active">登录</button>
      <button id="tab-reg">注册</button>
    </div>
    <form id="auth-form">
      <input name="username" placeholder="用户名" autocomplete="username" required />
      <input name="password" type="password" placeholder="密码（至少 6 位）" autocomplete="current-password" required />
      <button type="submit" class="primary" id="auth-submit">登录</button>
      <p class="msg" id="auth-msg"></p>
    </form>
    <div class="dl-noauth">
      <a class="button primary" href="${APK_URL}">下载安卓 App（无需登录）</a>
    </div>
  </div>`;
  let mode = 'login';
  $('#tab-login').onclick = () => { mode = 'login'; $('#tab-login').classList.add('active'); $('#tab-reg').classList.remove('active'); $('#auth-submit').textContent = '登录'; };
  $('#tab-reg').onclick = () => { mode = 'register'; $('#tab-reg').classList.add('active'); $('#tab-login').classList.remove('active'); $('#auth-submit').textContent = '注册'; };
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#auth-msg').textContent = '';
    try {
      const data = mode === 'login'
        ? await api.login(f.username.value.trim(), f.password.value)
        : await api.register(f.username.value.trim(), f.password.value);
      setToken(data.token);
      mainView();
    } catch (err) {
      $('#auth-msg').textContent = err.message;
    }
  };
}

async function mainView() {
  root.innerHTML = `
  <header class="topbar">
    <strong>Notify Hub</strong>
    <div>
      <button id="tab-keys" class="active">密钥管理</button>
      <button id="tab-app">App 下载</button>
      <button id="tab-acct">账号设置</button>
      <button id="logout">退出</button>
    </div>
  </header>
  <main>
    <section id="view-keys"></section>
    <section id="view-app" hidden></section>
    <section id="view-acct" hidden></section>
  </main>`;
  $('#tab-keys').onclick = () => switchTab('tab-keys', 'view-keys');
  $('#tab-app').onclick = () => { switchTab('tab-app', 'view-app'); renderAppDownload(); };
  $('#tab-acct').onclick = () => { switchTab('tab-acct', 'view-acct'); renderAccount(); };
  $('#logout').onclick = () => { setToken(null); authView(); };
  renderKeys();
}

function switchTab(tabId, viewId) {
  ['tab-keys', 'tab-app', 'tab-acct'].forEach((t) => $('#' + t).classList.remove('active'));
  $('#' + tabId).classList.add('active');
  ['view-keys', 'view-app', 'view-acct'].forEach((v) => { $('#' + v).hidden = v !== viewId; });
}

function renderAppDownload() {
  const view = $('#view-app');
  view.innerHTML = `
    <div class="card">
      <h2>下载安卓 App</h2>
      <p>最新版 APK 由 CI 自动构建并发布：</p>
      <p><a class="button primary" href="${APK_URL}">下载最新 APK（app-debug.apk）</a></p>
      <p class="hint">手机浏览器打开本页点击下载；安装时如提示"未知来源"，允许即可。</p>
      <p>历史版本见 <a href="https://github.com/waxilo/notify-hub/releases" target="_blank" rel="noopener">GitHub Releases</a>。</p>
    </div>`;
}

async function renderKeys() {
  const view = $('#view-keys');
  view.innerHTML = `
    <div class="card">
      <h2>生成 Webhook Key</h2>
      <form id="key-form" class="row">
        <input name="name" placeholder="名称（如：服务器告警）" />
        <button class="primary" type="submit">生成</button>
      </form>
      <p class="msg" id="key-msg"></p>
      <div id="new-key"></div>
    </div>
    <div class="card">
      <h2>我的 Key 列表</h2>
      <div id="key-list"><p>加载中…</p></div>
    </div>`;
  $('#key-form').onsubmit = async (e) => {
    e.preventDefault();
    $('#key-msg').textContent = '';
    try {
      const k = await api.createKey(e.target.name.value.trim() || 'default');
      $('#new-key').innerHTML = `
        <div class="alert">已生成（仅显示一次，请保存）：<br/>
        <code>${escapeHtml(k.key)}</code>
        <button onclick="navigator.clipboard.writeText('${escapeHtml(k.key)}')">复制</button><br/>
        Webhook 地址：<code>${API_BASE}/hook/${escapeHtml(k.key)}</code></div>`;
      loadList();
    } catch (err) { $('#key-msg').textContent = err.message; }
  };
  loadList();
}

async function loadList() {
  const box = $('#key-list');
  try {
    const { keys } = await api.listKeys();
    if (!keys.length) { box.innerHTML = '<p>还没有 key，先生成一个。</p>'; return; }
    box.innerHTML = `<table>
      <thead><tr><th>名称</th><th>Key</th><th>状态</th><th>最近使用</th><th>操作</th></tr></thead>
      <tbody>${keys.map((k) => `
        <tr>
          <td>${escapeHtml(k.name)}</td>
          <td><code>${escapeHtml(k.key)}</code></td>
          <td>${k.active ? '启用' : '已吊销'}</td>
          <td>${k.last_used ? new Date(k.last_used).toLocaleString() : '—'}</td>
          <td>
            ${k.active ? `<button data-test="${k.id}">测试</button>` : ''}
            ${k.active ? `<button data-revoke="${k.id}">吊销</button>` : ''}
            <button data-history="${k.id}">历史</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>
    <p class="msg" id="test-msg"></p>`;
    box.querySelectorAll('[data-revoke]').forEach((b) => {
      b.onclick = async () => { await api.revokeKey(b.dataset.revoke); loadList(); };
    });
    box.querySelectorAll('[data-history]').forEach((b) => {
      b.onclick = () => {
        const k = keys.find((x) => String(x.id) === b.dataset.history);
        if (k) renderKeyHistory(k);
      };
    });
    box.querySelectorAll('[data-test]').forEach((b) => {
      b.onclick = async () => {
        const k = keys.find((x) => String(x.id) === b.dataset.test);
        if (!k) return;
        const msg = $('#test-msg');
        msg.textContent = '';
        b.disabled = true; b.textContent = '发送中…';
        try {
          const res = await fetch(`${API_BASE}/hook/${encodeURIComponent(k.keyFull)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Notify Hub 测试通知', body: `来自 Web 控制台的测试 · key「${k.name}」· ${new Date().toLocaleString()}` }),
          });
          const data = await res.json().catch(() => ({}));
          msg.textContent = res.ok
            ? `✅ 测试已送达「${k.name}」（通知 id: ${data.id}），App 收件箱稍后可见`
            : `❌ 发送失败（HTTP ${res.status}）：${data.error || '未知错误'}`;
          if (res.ok) loadList();
        } catch (err) {
          msg.textContent = `❌ 网络错误：${err.message}`;
        } finally {
          b.disabled = false; b.textContent = '测试';
        }
      };
    });
  } catch (err) { box.innerHTML = `<p class="msg">${err.message}</p>`; }
}

// 按 key 查看发送历史，含触发/触达状态
async function renderKeyHistory(k) {
  const old = $('#key-history');
  if (old) old.remove();
  const view = $('#view-keys');
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'key-history';
  card.innerHTML = `
    <h2>「${escapeHtml(k.name)}」发送历史</h2>
    <p><button id="hist-back">返回 Key 列表</button>
    <span style="color:#7b8794">状态说明：<b style="color:#1f7a3d">已触达</b> = App 已弹出系统通知；<b style="color:#b8860b">未触达</b> = App 离线尚未接收</span></p>
    <div id="hist-body"><p>加载中…</p></div>`;
  view.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth' });
  $('#hist-back').onclick = () => card.remove();
  const body = $('#hist-body');
  try {
    const { notifications, total } = await api.listNotifications(k.id);
    if (!notifications.length) { body.innerHTML = '<p>该 key 还没有发送记录。</p>'; return; }
    body.innerHTML = `
      <p style="color:#7b8794">共 ${total} 条，显示最近 ${notifications.length} 条</p>
      <table>
        <thead><tr><th>标题</th><th>内容</th><th>发送时间</th><th>状态</th></tr></thead>
        <tbody>${notifications.map((n) => `
          <tr>
            <td>${escapeHtml(n.title)}</td>
            <td>${escapeHtml((n.body || '').slice(0, 80))}</td>
            <td>${new Date(n.created_at).toLocaleString()}</td>
            <td>${n.delivered_at
              ? `<b style="color:#1f7a3d">已触达</b><br/><span style="color:#7b8794;font-size:12px">${new Date(n.delivered_at).toLocaleString()}</span>`
              : '<b style="color:#b8860b">未触达</b>'}</td>
          </tr>`).join('')}</tbody>
      </table>`;
  } catch (err) {
    body.innerHTML = `<p class="msg">加载失败：${err.message}</p>`;
  }
}

function renderAccount() {
  const view = $('#view-acct');
  view.hidden = false;
  view.innerHTML = `
    <div class="card">
      <h2>修改密码</h2>
      <form id="pw-form">
        <input name="oldPassword" type="password" placeholder="原密码" required />
        <input name="newPassword" type="password" placeholder="新密码（至少 6 位）" required />
        <button class="primary" type="submit">保存</button>
        <p class="msg" id="pw-msg"></p>
      </form>
    </div>
    <div class="card">
      <h2>配置信息</h2>
      <p>API 地址：<code>${API_BASE}</code></p>
      <p>Webhook 模板：<code>${API_BASE}/hook/&lt;KEY&gt;</code></p>
      <p>调用方式：<code>GET</code> 或 <code>POST</code>（JSON / 表单 / 纯文本均可）</p>
      <p class="hint">通知不在 Web 端展示，由安卓 App 通过轮询拉取。</p>
    </div>`;
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    $('#pw-msg').textContent = '';
    try {
      await api.changePassword(e.target.oldPassword.value, e.target.newPassword.value);
      $('#pw-msg').textContent = '密码已更新';
      e.target.reset();
    } catch (err) { $('#pw-msg').textContent = err.message; }
  };
}

(isLoggedIn() ? mainView : authView)();
