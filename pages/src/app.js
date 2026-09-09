// Web 控制台逻辑（仅配置）
import { API_BASE } from './config.js';
import { api, getToken, setToken, isLoggedIn } from './api.js';

const $ = (sel) => document.querySelector(sel);
const root = $('#app');

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
      <button id="tab-acct">账号设置</button>
      <button id="logout">退出</button>
    </div>
  </header>
  <main>
    <section id="view-keys"></section>
    <section id="view-acct" hidden></section>
  </main>`;
  $('#tab-keys').onclick = () => { $('#tab-keys').classList.add('active'); $('#tab-acct').classList.remove('active'); $('#view-keys').hidden = false; $('#view-acct').hidden = true; };
  $('#tab-acct').onclick = () => { $('#tab-acct').classList.add('active'); $('#tab-keys').classList.remove('active'); $('#view-acct').hidden = true; $('#view-keys').hidden = false; renderAccount(); };
  $('#logout').onclick = () => { setToken(null); authView(); };
  renderKeys();
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
      <thead><tr><th>名称</th><th>Key</th><th>状态</th><th>最近使用</th><th></th></tr></thead>
      <tbody>${keys.map((k) => `
        <tr>
          <td>${escapeHtml(k.name)}</td>
          <td><code>${escapeHtml(k.key)}</code></td>
          <td>${k.active ? '启用' : '已吊销'}</td>
          <td>${k.last_used ? new Date(k.last_used).toLocaleString() : '—'}</td>
          <td>${k.active ? `<button data-revoke="${k.id}">吊销</button>` : ''}</td>
        </tr>`).join('')}</tbody>
    </table>`;
    box.querySelectorAll('[data-revoke]').forEach((b) => {
      b.onclick = async () => { await api.revokeKey(b.dataset.revoke); loadList(); };
    });
  } catch (err) { box.innerHTML = `<p class="msg">${err.message}</p>`; }
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
