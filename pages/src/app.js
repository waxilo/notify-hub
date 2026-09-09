// Web 控制台逻辑（仅配置）
import { API_BASE } from './config.js';
import { api, getToken, setToken, isLoggedIn, loadingPush, loadingPop } from './api.js';

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
      <div class="card-head">
        <h2>我的 Key</h2>
        <button class="btn primary" id="btn-new-key">＋ 新建 Key</button>
      </div>
      <p class="hint" style="margin-top:-6px;margin-bottom:12px;">默认模式识别 title / body / message 字段；自定义模式按 JSON 路径提取，$ 表示 JSON 本身（如 $.msg）。</p>
      <div id="key-list"><p class="hint">加载中…</p></div>
    </div>`;
  $('#btn-new-key').onclick = () => openKeyCreate();
  loadList();
}

// 新建 Key 弹窗：成功后直接在弹窗内展示 key 与 webhook 地址（可复制）
function openKeyCreate() {
  const root_ = $('#modal-root');
  root_.innerHTML = `
  <div class="modal-mask">
    <div class="modal card">
      <h2>新建 Key</h2>
      <p class="hint">每个 key 即一个独立消息通道，可随时编辑名称、启停与推送模式。</p>
      <div id="create-body">
        <form id="create-form">
          <label>名称</label>
          <input name="name" placeholder="如：服务器告警" required />
          <div class="modal-actions">
            <button type="button" class="btn ghost" id="create-cancel">取消</button>
            <button type="submit" class="btn primary">生成</button>
          </div>
          <p class="msg" id="create-msg"></p>
        </form>
      </div>
    </div>
  </div>`;
  $('#create-cancel').onclick = () => { root_.innerHTML = ''; };
  $('#create-form').onsubmit = async (e) => {
    e.preventDefault();
    $('#create-msg').textContent = '';
    try {
      const k = await api.createKey(e.target.name.value.trim() || 'default');
      $('#create-body').innerHTML = `
        <div class="alert">
          <b>✅ 已生成（随时可在下方列表复制）</b><br/>
          <span class="hint">Key</span><br/>
          <code>${escapeHtml(k.key)}</code>
          <button class="btn mini" data-newcopy="${escapeHtml(k.key)}">复制 Key</button><br/>
          <span class="hint">Webhook 地址</span><br/>
          <code>${API_BASE}/hook/${escapeHtml(k.key)}</code>
          <button class="btn mini" data-newcopy="${API_BASE}/hook/${escapeHtml(k.key)}">复制 Hook 地址</button>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn primary" id="create-done">完成</button>
        </div>`;
      $('#create-body').querySelectorAll('[data-newcopy]').forEach((b) => {
        b.onclick = () => copyText(b.dataset.newcopy, b);
      });
      $('#create-done').onclick = () => { root_.innerHTML = ''; loadList(); };
    } catch (err) { $('#create-msg').textContent = err.message; }
  };
}

async function loadList() {
  const box = $('#key-list');
  try {
    const { keys } = await api.listKeys();
    if (!keys.length) { box.innerHTML = '<div class="empty">还没有 key，点击右上角「＋ 新建 Key」创建第一个</div>'; return; }
    box.innerHTML = `<div class="key-list">${keys.map((k) => `
      <div class="key-row ${k.active ? '' : 'off'}" tabindex="0">
        <div class="key-main">
          <span class="key-name">${escapeHtml(k.name)}</span>
          <span class="badge ${k.active ? 'on' : 'off'}">${k.active ? '启用中' : '已停用'}</span>
          <span class="badge mode">${k.mode === 'custom' ? '自定义' : '默认'}</span>
          <code class="key-url">${escapeHtml(k.keyFull || k.key)}</code>
        </div>
        <div class="key-sub">
          <span class="hint">最近使用：${k.last_used ? new Date(k.last_used).toLocaleString() : '从未使用'}</span>
          ${k.mode === 'custom' ? `<span class="hint">title← ${escapeHtml(k.title_path || '(未配置)')}　body← ${escapeHtml(k.body_path || '(未配置)')}</span>` : ''}
        </div>
        <div class="key-actions" aria-label="操作">
          <button class="btn mini" data-copyurl="${k.id}">复制 Hook 地址</button>
          <button class="btn mini" data-test="${k.id}" ${k.active ? '' : 'disabled'}>测试</button>
          <button class="btn mini" data-history="${k.id}">历史</button>
          <button class="btn mini" data-edit="${k.id}">编辑</button>
          ${k.active ? `<button class="btn mini danger" data-revoke="${k.id}">停用</button>` : `<button class="btn mini" data-enable="${k.id}">启用</button>`}
        </div>
      </div>`).join('')}</div>
    <p class="msg" id="test-msg"></p>`;

    const find = (id) => keys.find((x) => String(x.id) === id);
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
      b.onclick = () => { const k = find(b.dataset.history); if (k) openKeyHistory(k); };
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
        loadingPush();
        try {
          const res = await fetch(`${API_BASE}/hook/${encodeURIComponent(k.keyFull)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Notify Hub 测试通知', body: '来自 Web 控制台的测试' }),
          });
          const data = await res.json().catch(() => ({}));
          msg.textContent = res.ok
            ? `✅ 测试已送达「${k.name}」（通知 id: ${data.id}），App 在线将实时弹出通知`
            : `❌ 发送失败（HTTP ${res.status}）：${data.error || '未知错误'}`;
        } catch (err) {
          msg.textContent = `❌ 网络错误：${err.message}`;
        } finally {
          loadingPop();
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
          <input name="title_path" value="${escapeHtml(k.title_path || '')}" placeholder="如：$.event.alerts.0.title" />
          <label>内容提取路径（body_path）</label>
          <input name="body_path" value="${escapeHtml(k.body_path || '')}" placeholder="如：$.event.message" />
          <p class="hint">点分路径，数组用下标（$.a.b.0.c），$ 表示 JSON 本身可省略。提取为空时回退默认字段 title / body / message。</p>
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

/* ---------- 按 key 历史（弹窗 + 分页） ---------- */

const HIST_PAGE_SIZE = 10;

async function openKeyHistory(k) {
  const root_ = $('#modal-root');
  let page = 0;

  root_.innerHTML = `
  <div class="modal-mask">
    <div class="modal card" style="max-width:640px;">
      <div class="card-head">
        <h2>「${escapeHtml(k.name)}」发送历史</h2>
        <button class="btn mini" id="hist-close">关闭</button>
      </div>
      <p class="hint">状态说明：<b class="ok">已触达</b> = App 已弹出系统通知；<b class="warn">未触达</b> = App 离线尚未接收</p>
      <div id="hist-body"><p class="hint">加载中…</p></div>
      <div class="modal-actions" id="hist-pager" style="justify-content:space-between;align-items:center;">
        <span class="hint" id="hist-total"></span>
        <span>
          <button class="btn mini" id="hist-prev">← 上一页</button>
          <button class="btn mini" id="hist-next">下一页 →</button>
        </span>
      </div>
    </div>
  </div>`;
  $('#hist-close').onclick = () => { root_.innerHTML = ''; };

  async function loadPage() {
    const body = $('#hist-body');
    body.innerHTML = '<p class="hint">加载中…</p>';
    try {
      const { notifications, total } = await api.listNotifications(k.id, HIST_PAGE_SIZE, page * HIST_PAGE_SIZE);
      const pages = Math.max(1, Math.ceil(total / HIST_PAGE_SIZE));
      if (!notifications.length) {
        body.innerHTML = '<p class="hint">该 key 还没有发送记录。</p>';
        $('#hist-pager').style.display = 'none';
        return;
      }
      body.innerHTML = `
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
      $('#hist-total').textContent = `共 ${total} 条 · 第 ${page + 1} / ${pages} 页`;
      $('#hist-prev').disabled = page <= 0;
      $('#hist-next').disabled = page >= pages - 1;
    } catch (err) {
      body.innerHTML = `<p class="msg">加载失败：${err.message}</p>`;
    }
  }

  $('#hist-prev').onclick = () => { if (page > 0) { page--; loadPage(); } };
  $('#hist-next').onclick = () => { page++; loadPage(); };
  loadPage();
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
      <p class="hint">默认模式识别 title / body / message / text 字段；自定义模式按 JSON 路径提取，$ 表示 JSON 本身（如 $.msg）。</p>
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
