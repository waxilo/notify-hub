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

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const t = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = t; }, 1200);
  });
}

/* ---------- 登录 / 注册 ---------- */

function authView() {
  root.innerHTML = `
  <div class="auth-wrap">
    <div class="card auth">
      <div class="brand"><span class="brand-dot"></span>Notify Hub</div>
      <p class="hint center">一站式消息推送中转 · Webhook 到手机</p>
      <div class="tabs">
        <button id="tab-login" class="active">登录</button>
        <button id="tab-reg">注册</button>
      </div>
      <form id="auth-form">
        <label>用户名</label>
        <input name="username" placeholder="用户名" autocomplete="username" required />
        <label>密码</label>
        <input name="password" type="password" placeholder="密码（至少 6 位）" autocomplete="current-password" required />
        <button type="submit" class="btn primary block" id="auth-submit">登录</button>
        <p class="msg" id="auth-msg"></p>
      </form>
      <div class="dl-noauth">
        <a class="btn primary block" href="${APK_URL}">下载安卓 App（无需登录）</a>
      </div>
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

/* ---------- 主框架 ---------- */

async function mainView() {
  root.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-dot"></span>Notify Hub</div>
    <nav class="topnav">
      <button id="tab-keys" class="active">Key 管理</button>
      <button id="tab-app">App 下载</button>
      <button id="tab-acct">账号</button>
      <button id="logout" class="ghost">退出</button>
    </nav>
  </header>
  <main>
    <section id="view-keys"></section>
    <section id="view-app" hidden></section>
    <section id="view-acct" hidden></section>
  </main>
  <div id="modal-root"></div>`;
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
      <p><a class="btn primary" href="${APK_URL}">下载最新 APK（app-debug.apk）</a></p>
      <p class="hint">手机浏览器打开本页点击下载；安装时如提示"未知来源"，允许即可。</p>
      <p class="hint">历史版本见 <a href="https://github.com/waxilo/notify-hub/releases" target="_blank" rel="noopener">GitHub Releases</a>。</p>
    </div>`;
}

/* ---------- Key 管理 ---------- */

async function renderKeys() {
  const view = $('#view-keys');
  view.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>生成 Webhook Key</h2></div>
      <form id="key-form" class="row">
        <input name="name" placeholder="名称（如：服务器告警）" />
        <button class="btn primary" type="submit">生成</button>
      </form>
      <p class="msg" id="key-msg"></p>
      <div id="new-key"></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>我的 Key</h2>
        <span class="hint">默认模式：title / body / message 字段；自定义模式：按 JSON 路径提取</span>
      </div>
      <div id="key-list"><p class="hint">加载中…</p></div>
    </div>`;
  $('#key-form').onsubmit = async (e) => {
    e.preventDefault();
    $('#key-msg').textContent = '';
    try {
      const k = await api.createKey(e.target.name.value.trim() || 'default');
      $('#new-key').innerHTML = `
        <div class="alert">
          <b>已生成（随时可在下方列表复制）</b><br/>
          <code>${escapeHtml(k.key)}</code>
          <button class="btn mini" data-newcopy="${escapeHtml(k.key)}">复制 Key</button><br/>
          Webhook 地址：<code>${API_BASE}/hook/${escapeHtml(k.key)}</code>
          <button class="btn mini" data-newcopy="${API_BASE}/hook/${escapeHtml(k.key)}">复制地址</button>
        </div>`;
      $('#new-key').querySelectorAll('[data-newcopy]').forEach((b) => {
        b.onclick = () => copyText(b.dataset.newcopy, b);
      });
      e.target.reset();
      loadList();
    } catch (err) { $('#key-msg').textContent = err.message; }
  };
  loadList();
}

async function loadList() {
  const box = $('#key-list');
  try {
    const { keys } = await api.listKeys();
    if (!keys.length) { box.innerHTML = '<p class="hint">还没有 key，先生成一个。</p>'; return; }
    box.innerHTML = `<div class="key-grid">${keys.map((k) => `
      <div class="key-card ${k.active ? '' : 'off'}">
        <div class="key-head">
          <span class="key-name">${escapeHtml(k.name)}</span>
          <span class="badge ${k.active ? 'on' : 'off'}">${k.active ? '启用中' : '已停用'}</span>
          <span class="badge mode">${k.mode === 'custom' ? '自定义' : '默认'}</span>
        </div>
        <div class="key-url"><code>${API_BASE}/hook/${escapeHtml(k.key)}</code></div>
        <div class="key-meta">
          <span class="hint">最近使用：${k.last_used ? new Date(k.last_used).toLocaleString() : '从未使用'}</span>
          ${k.mode === 'custom' ? `<span class="hint">title← ${escapeHtml(k.title_path || '(未配置)')}　body← ${escapeHtml(k.body_path || '(未配置)')}</span>` : ''}
        </div>
        <div class="key-actions">
          <button class="btn mini" data-copykey="${k.id}">复制 Key</button>
          <button class="btn mini" data-copyurl="${k.id}">复制地址</button>
          <button class="btn mini" data-test="${k.id}" ${k.active ? '' : 'disabled'}>测试</button>
          <button class="btn mini" data-history="${k.id}">历史</button>
          <button class="btn mini" data-edit="${k.id}">编辑</button>
          ${k.active ? `<button class="btn mini danger" data-revoke="${k.id}">停用</button>` : `<button class="btn mini" data-enable="${k.id}">启用</button>`}
        </div>
      </div>`).join('')}</div>
    <p class="msg" id="test-msg"></p>`;

    const find = (id) => keys.find((x) => String(x.id) === id);
    box.querySelectorAll('[data-copykey]').forEach((b) => {
      b.onclick = () => { const k = find(b.dataset.copykey); if (k) copyText(k.keyFull || k.key, b); };
    });
    box.querySelectorAll('[data-copyurl]').forEach((b) => {
      b.onclick = () => { const k = find(b.dataset.copyurl); if (k) copyText(`${API_BASE}/hook/${k.keyFull || k.key}`, b); };
    });
    box.querySelectorAll('[data-revoke]').forEach((b) => {
      b.onclick = async () => { await api.revokeKey(b.dataset.revoke); loadList(); };
    });
    box.querySelectorAll('[data-enable]').forEach((b) => {
      b.onclick = async () => { await api.updateKey(b.dataset.enable, { active: true }); loadList(); };
    });
    box.querySelectorAll('[data-history]').forEach((b) => {
      b.onclick = () => { const k = find(b.dataset.history); if (k) renderKeyHistory(k); };
    });
    box.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => { const k = find(b.dataset.edit); if (k) openKeyEdit(k); };
    });
    box.querySelectorAll('[data-test]').forEach((b) => {
      b.onclick = async () => {
        const k = find(b.dataset.test);
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
        } catch (err) {
          msg.textContent = `❌ 网络错误：${err.message}`;
        } finally {
          b.disabled = false; b.textContent = '测试';
        }
      };
    });
  } catch (err) { box.innerHTML = `<p class="msg">${err.message}</p>`; }
}

// key 编辑弹窗：名称 / 启停 / 默认-自定义模式（JSON 路径）
function openKeyEdit(k) {
  const root_ = $('#modal-root');
  root_.innerHTML = `
  <div class="modal-mask">
    <div class="modal card">
      <h2>编辑 Key「${escapeHtml(k.name)}」</h2>
      <form id="edit-form">
        <label>名称</label>
        <input name="name" value="${escapeHtml(k.name)}" required />
        <label>推送模式</label>
        <div class="seg">
          <label class="seg-item"><input type="radio" name="mode" value="default" ${k.mode !== 'custom' ? 'checked' : ''}/><span>默认</span></label>
          <label class="seg-item"><input type="radio" name="mode" value="custom" ${k.mode === 'custom' ? 'checked' : ''}/><span>自定义（JSON 路径提取）</span></label>
        </div>
        <div id="custom-fields" ${k.mode === 'custom' ? '' : 'hidden'}>
          <label>标题提取路径（title_path）</label>
          <input name="title_path" value="${escapeHtml(k.title_path || '')}" placeholder="如：event.alerts.0.title" />
          <label>内容提取路径（body_path）</label>
          <input name="body_path" value="${escapeHtml(k.body_path || '')}" placeholder="如：event.message" />
          <p class="hint">点分路径，数组用下标（a.b.0.c）。提取为空时回退默认字段 title / body / message。</p>
        </div>
        <label class="check-row"><input type="checkbox" name="active" ${k.active ? 'checked' : ''}/> 启用此 key（停用后 webhook 调用将被拒绝，不推送消息）</label>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="edit-cancel">取消</button>
          <button type="submit" class="btn primary">保存</button>
        </div>
        <p class="msg" id="edit-msg"></p>
      </form>
    </div>
  </div>`;
  const form = $('#edit-form');
  const syncCustom = () => { $('#custom-fields').hidden = form.mode.value !== 'custom'; };
  form.querySelectorAll('input[name=mode]').forEach((r) => { r.onchange = syncCustom; });
  $('#edit-cancel').onclick = () => { root_.innerHTML = ''; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    $('#edit-msg').textContent = '';
    try {
      await api.updateKey(k.id, {
        name: form.name.value.trim(),
        active: form.active.checked,
        mode: form.mode.value,
        title_path: form.title_path.value.trim(),
        body_path: form.body_path.value.trim(),
      });
      root_.innerHTML = '';
      loadList();
    } catch (err) { $('#edit-msg').textContent = err.message; }
  };
}

/* ---------- 按 key 历史 ---------- */

async function renderKeyHistory(k) {
  const old = $('#key-history');
  if (old) old.remove();
  const view = $('#view-keys');
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'key-history';
  card.innerHTML = `
    <div class="card-head">
      <h2>「${escapeHtml(k.name)}」发送历史</h2>
      <button class="btn mini" id="hist-back">返回</button>
    </div>
    <p class="hint">状态说明：<b class="ok">已触达</b> = App 已弹出系统通知；<b class="warn">未触达</b> = App 离线尚未接收</p>
    <div id="hist-body"><p class="hint">加载中…</p></div>`;
  view.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth' });
  $('#hist-back').onclick = () => card.remove();
  const body = $('#hist-body');
  try {
    const { notifications, total } = await api.listNotifications(k.id);
    if (!notifications.length) { body.innerHTML = '<p class="hint">该 key 还没有发送记录。</p>'; return; }
    body.innerHTML = `
      <p class="hint">共 ${total} 条，显示最近 ${notifications.length} 条</p>
      <table>
        <thead><tr><th>标题</th><th>内容</th><th>发送时间</th><th>状态</th></tr></thead>
        <tbody>${notifications.map((n) => `
          <tr>
            <td>${escapeHtml(n.title)}</td>
            <td>${escapeHtml((n.body || '').slice(0, 80))}</td>
            <td>${new Date(n.created_at).toLocaleString()}</td>
            <td>${n.delivered_at
              ? `<b class="ok">已触达</b><br/><span class="hint xs">${new Date(n.delivered_at).toLocaleString()}</span>`
              : '<b class="warn">未触达</b>'}</td>
          </tr>`).join('')}</tbody>
      </table>`;
  } catch (err) {
    body.innerHTML = `<p class="msg">加载失败：${err.message}</p>`;
  }
}

/* ---------- 账号 ---------- */

function renderAccount() {
  const view = $('#view-acct');
  view.hidden = false;
  view.innerHTML = `
    <div class="card">
      <h2>修改密码</h2>
      <form id="pw-form">
        <label>原密码</label>
        <input name="oldPassword" type="password" placeholder="原密码" required />
        <label>新密码</label>
        <input name="newPassword" type="password" placeholder="新密码（至少 6 位）" required />
        <button class="btn primary" type="submit">保存</button>
        <p class="msg" id="pw-msg"></p>
      </form>
    </div>
    <div class="card">
      <h2>配置信息</h2>
      <p>API 地址：<code>${API_BASE}</code></p>
      <p>Webhook 模板：<code>${API_BASE}/hook/&lt;KEY&gt;</code></p>
      <p>调用方式：<code>GET</code> 或 <code>POST</code>（JSON / 表单 / 纯文本均可）</p>
      <p class="hint">默认模式识别 title / body / message / text 字段；自定义模式在 Key 编辑里按 JSON 路径配置提取。</p>
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
