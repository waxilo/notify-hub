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

// 尝试把 JSON 字符串格式化为缩进形式，失败则原样返回
function prettyJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return String(s ?? ''); }
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
      <button id="tab-docs">接入文档</button>
      <button id="tab-app">App 下载</button>
      <button id="tab-acct">账号</button>
      <button id="logout" class="ghost">退出</button>
    </nav>
  </header>
  <main>
    <section id="view-keys"></section>
    <section id="view-docs" hidden></section>
    <section id="view-app" hidden></section>
    <section id="view-acct" hidden></section>
  </main>
  <div id="modal-root"></div>`;
  $('#tab-keys').onclick = () => switchTab('tab-keys', 'view-keys');
  $('#tab-docs').onclick = () => { switchTab('tab-docs', 'view-docs'); renderDocs(); };
  $('#tab-app').onclick = () => { switchTab('tab-app', 'view-app'); renderAppDownload(); };
  $('#tab-acct').onclick = () => { switchTab('tab-acct', 'view-acct'); renderAccount(); };
  $('#logout').onclick = () => { setToken(null); authView(); };
  renderKeys();
}

function switchTab(tabId, viewId) {
  ['tab-keys', 'tab-docs', 'tab-app', 'tab-acct'].forEach((t) => $('#' + t).classList.remove('active'));
  $('#' + tabId).classList.add('active');
  ['view-keys', 'view-docs', 'view-app', 'view-acct'].forEach((v) => { $('#' + v).hidden = v !== viewId; });
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

/* ---------- 接入文档 ---------- */

function renderDocs() {
  const view = $('#view-docs');
  // 代码样例（raw 文本单独保存，供复制按钮使用）
  const samples = [
    // 0: GET 一键通知
    `${API_BASE}/hook/<KEY>?message=CPU 使用率超过 90%`,
    // 1: curl GET
    `curl "${API_BASE}/hook/<KEY>?message=${encodeURIComponent('CPU 使用率超过 90%')}"`,
    // 2: curl POST JSON
    `curl -X POST "${API_BASE}/hook/<KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"CPU 使用率超过 90%"}'`,
    // 3: JS fetch
    `fetch('${API_BASE}/hook/<KEY>', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'CPU 使用率超过 90%' })
});`,
    // 4: Python requests
    `import requests

requests.post('${API_BASE}/hook/<KEY>', json={
    'message': 'CPU 使用率超过 90%',
})`,
    // 5: 自定义模板
    `// key 设为「自定义（模板解析）」后，POST 这份 JSON：
{
  "message": "\u0024{name} 的年龄是 \u0024{age} 岁",
  "name": "wxl",
  "age": "18"
}
// 手机收到的通知内容：wxl 的年龄是 18 岁
//
// 不传 message 时，整个 JSON 直接作为通知内容：
{ "event": { "name": "CPU 告警", "value": "92%" } }`,
    // 6: 响应
    `{ "ok": true, "id": 71 }                      // 正常入库并推送
{ "ok": true, "id": 72, "empty": true }        // message 为空：只入库不推送（历史显示「空消息」）
{ "ok": true, "deduplicated": true, "id": 70 } // 显式 dedup_key 重复，未重复推送
{ "error": "invalid key" }                     // key 不存在（404）
{ "error": "key is disabled" }                 // key 已停用（403）`,
  ];

  view.innerHTML = `
    <div class="card doc-card">
      <h2><span class="doc-num">1</span>一键通知 · 30 秒接入</h2>
      <p class="hint">在「Key 管理」创建一个 key，把它拼进下面的地址即可。<b>通知标题就是 key 的名称</b>（在 Key 管理里改名即可），所以调用只需一个 message 参数——浏览器地址栏直接回车、img 标签、脚本请求都行，最简单的推送不需要写任何代码。</p>
      <div class="doc-code"><code>${escapeHtml(samples[0])}</code><button class="btn mini doc-copy">复制</button></div>
      <p class="hint">或用 curl：</p>
      <div class="doc-code"><code>${escapeHtml(samples[1])}</code><button class="btn mini doc-copy">复制</button></div>
      <p class="hint">App 在线时通知毫秒级弹出；离线时消息会入库，App 上线后由服务端自动重推（0.3 秒间隔，最多 5 次）。</p>
    </div>

    <div class="card doc-card">
      <h2><span class="doc-num">2</span>POST 推送（推荐）</h2>
      <p class="hint">POST <code>${API_BASE}/hook/&lt;KEY&gt;</code>，支持三种请求体：<b>JSON</b>、<b>表单</b>（application/x-www-form-urlencoded）、<b>纯文本</b>（直接作为通知内容）。JSON 最常用：</p>
      <div class="doc-code"><code>${escapeHtml(samples[2])}</code><button class="btn mini doc-copy">复制</button></div>
      <p class="hint">浏览器 / Node：</p>
      <div class="doc-code"><code>${escapeHtml(samples[3])}</code><button class="btn mini doc-copy">复制</button></div>
      <p class="hint">Python：</p>
      <div class="doc-code"><code>${escapeHtml(samples[4])}</code><button class="btn mini doc-copy">复制</button></div>
      <table class="doc-params">
        <thead><tr><th>参数</th><th>说明</th></tr></thead>
        <tbody>
          <tr><td><code>message</code></td><td>通知内容（最长 8000 字符）</td></tr>
          <tr><td><code>dedup_key</code></td><td>可选。显式防重 key：5 分钟窗口内相同 key 只推送一次（用于调用方超时重试场景）。不传则服务端自动生成唯一 key，消息不做内容去重</td></tr>
        </tbody>
      </table>
      <p class="hint"><b>不需要传 title</b>：通知标题固定为 key 的名称，任何模式下都不会被请求参数覆盖。</p>
      <p class="hint">表单模式下参数相同；防重 key 也可放在请求头 <code>X-Dedup-Key</code> 中。GET 与 POST 语义一致，仅 GET 用查询串传参。</p>
    </div>

    <div class="card doc-card">
      <h2><span class="doc-num">3</span>自定义模式 · 模板解析</h2>
      <p class="hint">在「Key 管理 → ⋯ → 编辑」中把 key 切为「自定义（模板解析）」后，message 不再原样发送，而是作为<b>模板</b>：<code>$&#123;字段&#125;</code> 占位符会用 JSON 数据里的对应字段填充。适合监控、CI 等推送结构化 JSON 的场景。</p>
      <div class="doc-code"><code>${escapeHtml(samples[5])}</code><button class="btn mini doc-copy">复制</button></div>
      <p class="hint">路径语法：点分路径、数组用下标（<code>$&#123;event.alerts.0.name&#125;</code>），取不到的字段替换为空串。<b>未传 message 时</b>，整个 JSON 会直接作为通知内容触达，调用方无需任何改造。</p>
    </div>

    <div class="card doc-card">
      <h2><span class="doc-num">4</span>响应与防重</h2>
      <div class="doc-code"><code>${escapeHtml(samples[6])}</code><button class="btn mini doc-copy">复制</button></div>
      <p class="hint"><b>防重语义</b>：服务端默认每条消息互不重复（不做内容去重）。只有当调用方显式传了 <code>dedup_key</code> 时才做去重——适合「发送超时后重试」的场景，避免重试导致重复弹通知。每条消息都会携带唯一防重 key 下发给 App，用于识别服务端重推。</p>
    </div>`;

  view.querySelectorAll('.doc-copy').forEach((btn, i) => {
    btn.onclick = () => copyText(samples[i], btn);
  });
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
      <p class="hint" style="margin-top:-6px;margin-bottom:12px;">通知标题固定为 key 名称，调用只需传 message 参数。接入方式见「接入文档」。</p>
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
          <button class="key-more" data-more="${k.id}" aria-label="操作菜单">⋯</button>
        </div>
        <div class="key-sub">
          <span class="hint">最近使用：${k.last_used ? new Date(k.last_used).toLocaleString() : '从未使用'}</span>
        </div>
      </div>`).join('')}</div>
    <p class="msg" id="test-msg"></p>`;

    const find = (id) => keys.find((x) => String(x.id) === id);

    // 「⋯」操作菜单：点击展开、点其他区域/再点一次收起（无 hover 时序问题，触屏同样可用）
    const closeMenus = () => {
      box.querySelectorAll('.key-menu').forEach((m) => m.remove());
      box.querySelectorAll('.key-more.active').forEach((b) => b.classList.remove('active'));
    };
    if (!renderDocs._menuBound) {
      document.addEventListener('click', () => {
        document.querySelectorAll('.key-menu').forEach((m) => m.remove());
        document.querySelectorAll('.key-more.active').forEach((b) => b.classList.remove('active'));
      });
      renderDocs._menuBound = true;
    }
    box.querySelectorAll('[data-more]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const k = find(b.dataset.more);
        if (!k) return;
        const wasOpen = b.classList.contains('active');
        closeMenus();
        if (wasOpen) return;
        b.classList.add('active');
        const menu = document.createElement('div');
        menu.className = 'key-menu';
        const items = [
          ['复制 Hook 地址', () => copyText(`${API_BASE}/hook/${k.keyFull || k.key}`, b)],
          ...(k.active ? [['测试', () => testKey(k)]] : []),
          ['历史', () => openKeyHistory(k)],
          ['编辑', () => openKeyEdit(k)],
          k.active
            ? ['停用', async () => { await api.revokeKey(k.id); loadList(); }]
            : ['启用', async () => { await api.updateKey(k.id, { active: true }); loadList(); }],
        ];
        menu.innerHTML = items.map(([label], i) => `<button class="btn mini${label === '停用' ? ' danger' : ''}" data-i="${i}">${label}</button>`).join('');
        menu.querySelectorAll('[data-i]').forEach((btn) => {
          btn.onclick = (ev) => { ev.stopPropagation(); closeMenus(); items[Number(btn.dataset.i)][1](); };
        });
        b.closest('.key-row').appendChild(menu);
      };
    });

    // 测试发送（菜单项调用）
    async function testKey(k) {
      const msg = $('#test-msg');
      msg.textContent = '';
      loadingPush();
      try {
        const res = await fetch(`${API_BASE}/hook/${encodeURIComponent(k.keyFull)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '来自 Web 控制台的测试' }),
        });
        const data = await res.json().catch(() => ({}));
        msg.textContent = res.ok
          ? `✅ 测试已送达「${k.name}」（通知 id: ${data.id}），App 在线将实时弹出通知`
          : `❌ 发送失败（HTTP ${res.status}）：${data.error || '未知错误'}`;
      } catch (err) {
        msg.textContent = `❌ 网络错误：${err.message}`;
      } finally {
        loadingPop();
      }
    }
  } catch (err) { box.innerHTML = `<p class="msg">${err.message}</p>`; }
}

// key 编辑弹窗：名称 / 启停
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
          <label class="seg-item"><input type="radio" name="mode" value="custom" ${k.mode === 'custom' ? 'checked' : ''}/><span>自定义（模板解析）</span></label>
        </div>
        <p class="hint">默认：message 原样作为通知内容。自定义：message 作为模板，<code>$&#123;字段&#125;</code> 占位符用 JSON 数据填充（如 $&#123;name&#125;、$&#123;event.msg&#125;，点分路径、数组用下标）；未传 message 时整个 JSON 直接作为内容。</p>
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
  $('#edit-cancel').onclick = () => { root_.innerHTML = ''; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    $('#edit-msg').textContent = '';
    try {
      await api.updateKey(k.id, {
        name: form.name.value.trim(),
        active: form.active.checked,
        mode: form.mode.value,
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
      <p class="hint">状态说明：<b class="ok">已触达</b> = App 已弹出系统通知；<b class="warn">未触达</b> = App 离线尚未接收。点击「原文」可查看调用方发送的完整未解析参数。</p>
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
  $('#hist-close').onclick = () => { document.querySelectorAll('.raw-pop').forEach((p) => p.remove()); root_.innerHTML = ''; };

  async function loadPage() {
    const body = $('#hist-body');
    // 清理上一页残留的悬浮原文面板
    document.querySelectorAll('.raw-pop').forEach((p) => p.remove());
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
          <thead><tr><th>标题</th><th>内容</th><th>发送时间</th><th>状态</th><th>原文</th></tr></thead>
          <tbody>${notifications.map((n, i) => {
            const empty = !n.body || !String(n.body).trim();
            const status = empty
              ? '<span class="badge empty-msg">空消息</span>'
              : (n.delivered_at
                ? `<b class="ok">已触达</b><br/><span class="hint xs">${new Date(n.delivered_at).toLocaleString()}</span>`
                : '<b class="warn">未触达</b>');
            return `
            <tr>
              <td>${escapeHtml(n.title)}</td>
              <td>${empty ? '<span class="hint xs">（无内容）</span>' : escapeHtml(String(n.body).slice(0, 80))}</td>
              <td>${new Date(n.created_at).toLocaleString()}</td>
              <td>${status}</td>
              <td class="raw-cell">${n.payload
                ? `<code class="raw-trigger" data-raw="${i}">查看</code>`
                : '<span class="hint xs">无</span>'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`;
      $('#hist-total').textContent = `共 ${total} 条 · 第 ${page + 1} / ${pages} 页`;
      $('#hist-prev').disabled = page <= 0;
      $('#hist-next').disabled = page >= pages - 1;
      // 「原文」悬浮展示：鼠标悬停在查看上，右侧自动浮现完整未解析 payload
      const pop = document.createElement('div');
      pop.className = 'raw-pop';
      pop.hidden = true;
      document.body.appendChild(pop);
      const hidePop = () => { pop.hidden = true; };
      body.querySelectorAll('[data-raw]').forEach((el) => {
        const show = () => {
          const n = notifications[Number(el.dataset.raw)];
          if (!n || !n.payload) return;
          const pretty = prettyJson(n.payload);
          pop.innerHTML = `
            <div class="raw-pop-head">通知 #${n.id} 原始请求参数 <button class="btn mini doc-copy">复制</button></div>
            <pre>${escapeHtml(pretty)}</pre>`;
          pop.querySelector('.doc-copy').onclick = (e) => { e.stopPropagation(); copyText(pretty, e.target); };
          pop.hidden = false;
          // 定位：优先展示在单元格右侧，放不下则放左侧，垂直方向跟随并限制在视口内
          const r = el.getBoundingClientRect();
          const pw = Math.min(420, window.innerWidth - 24);
          const ph = Math.min(340, window.innerHeight - 24);
          let left = r.right + 10;
          if (left + pw > window.innerWidth - 8) left = Math.max(8, r.left - pw - 10);
          let top = Math.min(Math.max(8, r.top - 12), window.innerHeight - ph - 8);
          pop.style.left = left + 'px';
          pop.style.top = top + 'px';
          pop.style.maxWidth = pw + 'px';
          pop.style.maxHeight = ph + 'px';
        };
        el.addEventListener('mouseenter', show);
        el.addEventListener('mouseleave', hidePop);
      });
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
      <p class="hint">默认调用只需传 message 参数（标题固定为 key 名称）。详见「接入文档」。</p>
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
