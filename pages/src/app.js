// Web 控制台逻辑（仅配置）
import { API_BASE } from './config.js?v=20260911c';
import { api, setToken, isLoggedIn } from './api.js?v=20260911c';


const $ = (sel) => document.querySelector(sel);
const root = $('#app');

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
      <button id="tab-jobs">定时任务</button>
      <button id="tab-docs">接入文档</button>
      <button id="tab-acct">账号</button>
      <button id="logout" class="ghost">退出</button>
    </nav>
  </header>
  <main>
    <section id="view-keys"></section>
    <section id="view-jobs" hidden></section>
    <section id="view-docs" hidden></section>
    <section id="view-acct" hidden></section>
  </main>
  <div id="modal-root"></div>`;
  $('#tab-keys').onclick = () => switchTab('tab-keys', 'view-keys');
  $('#tab-jobs').onclick = () => { switchTab('tab-jobs', 'view-jobs'); renderJobs(); };
  $('#tab-docs').onclick = () => { switchTab('tab-docs', 'view-docs'); renderDocs(); };
  $('#tab-acct').onclick = () => { switchTab('tab-acct', 'view-acct'); renderAccount(); };
  $('#logout').onclick = () => { setToken(null); authView(); };
  renderKeys();
}

function switchTab(tabId, viewId) {
  ['tab-keys', 'tab-jobs', 'tab-docs', 'tab-acct'].forEach((t) => $('#' + t).classList.remove('active'));
  $('#' + tabId).classList.add('active');
  ['view-keys', 'view-jobs', 'view-docs', 'view-acct'].forEach((v) => { $('#' + v).hidden = v !== viewId; });
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
      <p class="hint">通知经 QQ 官方机器人推送到绑定的 QQ 群；网关失败时消息仍入库（历史显示「未送达」），不会丢失。</p>
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
      <p class="hint">路径语法：点分路径、数组用下标（<code>$&#123;event.alerts.0.name&#125;</code>），取不到的字段替换为空串。也可以在「编辑 Key → 自定义模式」的<b>消息模板</b>输入框里给 key 配一个固定模板，调用方不传 message 时自动用它渲染；两者都没有时，整个 JSON 会直接作为通知内容触达，调用方无需任何改造。</p>
    </div>

    <div class="card doc-card">
      <h2><span class="doc-num">4</span>响应与防重</h2>
      <div class="doc-code"><code>${escapeHtml(samples[6])}</code><button class="btn mini doc-copy">复制</button></div>
      <p class="hint"><b>防重语义</b>：服务端默认每条消息互不重复（不做内容去重）。只有当调用方显式传了 <code>dedup_key</code> 时才做去重——适合「发送超时后重试」的场景，避免重试导致重复弹通知。</p>
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
      <p class="hint">每个 key 是一份「外部写入凭证」：把它填进你的脚本 / CI / 监控的 webhook 地址即可推送通知。站内定时任务不需要 key。</p>
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
  const createForm = $('#create-form');
  createForm.onsubmit = async (e) => {
    e.preventDefault();
    $('#create-msg').textContent = '';
    try {
      // e.target 就是 form，e.target.name 同样会被 HTMLFormElement.name 遮蔽，必须走 elements
      const k = await api.createKey(createForm.elements.name.value.trim() || 'default');
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
      </div>`).join('')}</div>`;

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
          ['历史', () => openHistory({
            title: `「${k.name}」发送历史`,
            subtitle: '外部系统调用该 key 的写入记录',
            keyId: k.id,
            emptyText: '该 key 还没有发送记录。',
          })],
          ['编辑', () => openKeyEdit(k)],
          k.active
            ? ['停用', async () => { await api.updateKey(k.id, { active: false }); loadList(); }]
            : ['启用', async () => { await api.updateKey(k.id, { active: true }); loadList(); }],
          ['删除', () => openKeyDelete(k)],
        ];
        menu.innerHTML = items.map(([label], i) => `<button class="btn mini${label === '停用' ? ' danger' : ''}" data-i="${i}">${label}</button>`).join('');
        menu.querySelectorAll('[data-i]').forEach((btn) => {
          btn.onclick = (ev) => { ev.stopPropagation(); closeMenus(); items[Number(btn.dataset.i)][1](); };
        });
        b.closest('.key-row').appendChild(menu);
      };
    });
  } catch (err) { box.innerHTML = `<p class="msg">${err.message}</p>`; }
}

// 删除 key 确认弹窗：彻底删除 key 及其全部发送历史，不可恢复
function openKeyDelete(k) {
  const root_ = $('#modal-root');
  root_.innerHTML = `
  <div class="modal-mask">
    <div class="modal card">
      <h2>删除 Key「${escapeHtml(k.name)}」</h2>
      <p class="hint">将<b>彻底删除</b>此 key 与它的 Hook 地址，同时清除该 key 的全部发送历史，<b>删除后不可恢复</b>。正在使用此 key 的调用方会开始收到 404，请确认已下线。</p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="del-cancel">取消</button>
        <button type="button" class="btn primary danger" id="del-confirm">确认删除</button>
      </div>
      <p class="msg" id="del-msg"></p>
    </div>
  </div>`;
  $('#del-cancel').onclick = () => { root_.innerHTML = ''; };
  $('#del-confirm').onclick = async () => {
    try {
      await api.deleteKey(k.id);
      root_.innerHTML = '';
      loadList();
    } catch (err) { $('#del-msg').textContent = err.message; }
  };
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
        <p class="hint">默认：message 原样作为通知内容。自定义：message 作为模板，<code>$&#123;字段&#125;</code> 占位符用 JSON 数据填充（如 $&#123;name&#125;、$&#123;event.msg&#125;，点分路径、数组用下标）；未传 message 时用下面的 key 模板，两者都没有时整个 JSON 直接作为内容。</p>
        <div id="tpl-fields" ${k.mode === 'custom' ? '' : 'hidden'}>
          <label>消息模板（可选，调用方未传 message 时生效）</label>
          <input name="template" value="${escapeHtml(k.template || '')}" placeholder="如：$&#123;name&#125; 的年龄是 $&#123;age&#125; 岁" />
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
  // 同上：form.name 会被 HTMLFormElement 自身的 name 属性遮蔽，必须走 form.elements
  const F = form.elements;
  const syncTpl = () => { $('#tpl-fields').hidden = F.mode.value !== 'custom'; };
  form.querySelectorAll('input[name=mode]').forEach((r) => { r.onchange = syncTpl; });
  $('#edit-cancel').onclick = () => { root_.innerHTML = ''; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    $('#edit-msg').textContent = '';
    try {
      await api.updateKey(k.id, {
        name: F.name.value.trim(),
        active: F.active.checked,
        mode: F.mode.value,
        template: F.mode.value === 'custom' ? F.template.value : '',
      });
      root_.innerHTML = '';
      loadList();
    } catch (err) { $('#edit-msg').textContent = err.message; }
  };
}

/* ---------- 定时任务（配置在服务端，由 Cron 每分钟扫描执行） ---------- */

const DOW_OPTS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 时区不对用户开放修改：新建任务直接取浏览器当前 UTC 偏移（如 "+08:00"），
// 编辑已有任务则沿用其创建时的时区 —— 否则用户换了时区再随手编辑一次，
// 触发时刻会被静默平移，且很难察觉。
function localTz() {
  const off = -new Date().getTimezoneOffset();
  const a = Math.abs(off);
  return `${off >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// "+08:00" → "UTC+08:00"
function tzLabel(tz) {
  return tz ? `UTC${tz}` : 'UTC';
}

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '—';
}

// schedule 预设串 → 表单字段
function splitSchedule(s) {
  const v = String(s || '');
  let m;
  if ((m = v.match(/^every:(\d+)(m|h)$/))) return { kind: 'every', n: m[1], u: m[2] };
  if ((m = v.match(/^daily:(\d{2}):(\d{2})$/))) return { kind: 'daily', time: `${m[1]}:${m[2]}` };
  if ((m = v.match(/^weekly:([0-6]),(\d{2}):(\d{2})$/))) return { kind: 'weekly', dow: m[1], time: `${m[2]}:${m[3]}` };
  if ((m = v.match(/^once:(.+)$/))) return { kind: 'once', at: m[1] };
  return { kind: 'every', n: '5', u: 'm' };
}

// 表单字段 → schedule 预设串
function joinSchedule(kind, f) {
  if (kind === 'every') return `every:${f.n}${f.u}`;
  if (kind === 'daily') return `daily:${f.time}`;
  if (kind === 'weekly') return `weekly:${f.dow},${f.time}`;
  return `once:${f.at}`;
}

async function renderJobs() {
  const view = $('#view-jobs');
  view.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>定时任务</h2>
        <button class="btn primary" id="btn-new-job">＋ 新建任务</button>
      </div>
      <p class="hint" style="margin-top:-6px;margin-bottom:12px;">
        任务在<b>服务端</b>执行，关掉浏览器、手机关机都会照常触发；实际触发比设定时刻晚 0–1 分钟。
      </p>
      <div id="job-list"><p class="hint">加载中…</p></div>
      <p class="hint" id="job-flash"></p>
    </div>`;
  $('#btn-new-job').onclick = () => openJobEdit(null);
  loadJobs();
}

async function loadJobs() {
  const box = $('#job-list');
  if (!box) return;
  try {
    // 定时任务不挂 key（key 是外部系统调 /hook/:key 用的），所以这里不需要拉 keys
    const { jobs } = await api.listJobs();
    if (!jobs.length) {
      box.innerHTML = '<div class="empty">还没有定时任务，点击右上角「＋ 新建任务」创建第一个</div>';
      return;
    }
    box.innerHTML = `<div class="key-list">${jobs.map((j) => `
      <div class="key-row ${j.enabled ? '' : 'off'}">
        <div class="key-main">
          <span class="key-name">${escapeHtml(j.name || '未命名任务')}</span>
          <span class="badge ${j.enabled ? 'on' : 'off'}">${j.enabled ? '启用中' : '已停用'}</span>
          <span class="badge mode">${escapeHtml(j.desc || j.schedule)}</span>
        </div>
        <div class="key-sub">
          <span class="hint">通知内容：${escapeHtml(j.body || '（与任务名称相同）')}</span>
        </div>
        <div class="key-sub">
          <span class="hint">下次执行：${j.enabled ? fmtTime(j.next_run_at) : '（已停用）'}</span>
          <span class="hint">上次执行：${fmtTime(j.last_run_at)}</span>
        </div>
        <div class="key-sub">
          <span class="hint">已发送 <b>${j.sent_count || 0}</b> 条日志</span>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn mini" data-log="${j.id}">查看日志</button>
          <button class="btn mini" data-edit="${j.id}">编辑</button>
          <button class="btn mini" data-toggle="${j.id}">${j.enabled ? '停用' : '启用'}</button>
          <button class="btn mini danger" data-del="${j.id}">删除</button>
        </div>
      </div>`).join('')}</div>`;

    const find = (id) => jobs.find((x) => String(x.id) === id);
    box.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openJobEdit(find(b.dataset.edit)); });
    box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => openJobDelete(find(b.dataset.del)); });
    box.querySelectorAll('[data-log]').forEach((b) => {
      b.onclick = () => {
        const j = find(b.dataset.log);
        openHistory({
          title: `「${j.name || '未命名任务'}」执行日志`,
          subtitle: '该任务每次触发产生的通知记录',
          jobId: j.id,
          emptyText: '该任务还没有触发记录。',
          onCleared: loadJobs,
        });
      };
    });
    box.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        const j = find(b.dataset.toggle);
        try { await api.updateJob(j.id, { enabled: !j.enabled }); loadJobs(); }
        catch (err) { alert(err.message); }
      };
    });
  } catch (err) { box.innerHTML = `<p class="msg">加载失败：${err.message}</p>`; }
}

// 新建 / 编辑弹窗（job 为空即新建）
// 定时任务不选通道：它不属于任何外部 key，直接发「默认类型」通知 —— 标题固定为任务名称。
function openJobEdit(job) {
  const isNew = !job;
  const sc = splitSchedule(job && job.schedule);
  const tz = (job && job.tz) || localTz();
  const root_ = $('#modal-root');
  // 处于停用状态时直接展开高级设置，避免用户以为配置丢了
  const needAdv = !!job && !job.enabled;

  root_.innerHTML = `
  <div class="modal-mask">
    <div class="modal card">
      <h2>${isNew ? '新建定时任务' : '编辑定时任务'}</h2>
      <form id="job-form">
        <label>任务名称</label>
        <input name="name" value="${escapeHtml((job && job.name) || '')}" placeholder="如：每日签到提醒" required />
        <p class="hint xs" style="margin:6px 0 0">通知标题即任务名称，触发后推送到绑定的 QQ 群。</p>

        <label>重复方式</label>
        <select name="kind" id="job-kind">
          <option value="every" ${sc.kind === 'every' ? 'selected' : ''}>固定间隔</option>
          <option value="daily" ${sc.kind === 'daily' ? 'selected' : ''}>每天</option>
          <option value="weekly" ${sc.kind === 'weekly' ? 'selected' : ''}>每周</option>
          <option value="once" ${sc.kind === 'once' ? 'selected' : ''}>仅一次</option>
        </select>

        <div class="job-fields" data-f="every" hidden>
          <span class="pre">每</span>
          <input name="n" type="number" min="1" value="${escapeHtml(sc.n || '5')}" aria-label="间隔数值" />
          <select name="u" aria-label="间隔单位">
            <option value="m" ${sc.u === 'h' ? '' : 'selected'}>分钟</option>
            <option value="h" ${sc.u === 'h' ? 'selected' : ''}>小时</option>
          </select>
        </div>
        <div class="job-fields" data-f="daily" hidden>
          <span class="pre">每天</span>
          <input name="time" type="time" value="${escapeHtml(sc.kind === 'daily' ? sc.time : '09:00')}" aria-label="触发时刻" />
        </div>
        <div class="job-fields" data-f="weekly" hidden>
          <span class="pre">每</span>
          <select name="dow" aria-label="星期">
            ${DOW_OPTS.map((d, i) => `<option value="${i}" ${sc.kind === 'weekly' && String(sc.dow) === String(i) ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
          <input name="time" type="time" value="${escapeHtml(sc.kind === 'weekly' ? sc.time : '09:00')}" aria-label="触发时刻" />
        </div>
        <div class="job-fields" data-f="once" hidden>
          <input name="at" type="datetime-local" value="${escapeHtml(sc.kind === 'once' ? sc.at : '')}" aria-label="触发时刻" />
        </div>
        <p class="job-preview" id="job-preview"></p>
        <p class="hint xs" id="job-tz"></p>

        <label>通知内容</label>
        <input name="body" value="${escapeHtml((job && job.body) || '')}" placeholder="留空则与任务名称相同" />

        <label class="check-row" style="margin-top:10px"><input type="checkbox" name="skip_holiday" ${job && job.skip_holiday ? 'checked' : ''}/> 跳过节假日（当天为非工作日时不触发，仅周期型任务生效）</label>

        <details class="adv" ${needAdv ? 'open' : ''}>
          <summary>高级设置（启停）</summary>
          <div class="adv-body">
            <label class="check-row"><input type="checkbox" name="enabled" ${!job || job.enabled ? 'checked' : ''}/> 启用此任务</label>
          </div>
        </details>

        <div class="modal-actions">
          <button type="button" class="btn ghost" id="job-cancel">取消</button>
          <button type="submit" class="btn primary">保存</button>
        </div>
        <p class="msg" id="job-msg"></p>
      </form>
    </div>
  </div>`;

  const form = $('#job-form');
  // 注意：不能用 form.name / form.title 取值 —— 这两个名字被 HTMLFormElement / HTMLElement
  // 自身的 IDL 属性占用（返回表单的 name、title 特性，值为空字符串），
  // 会静默绕过同名 input，导致取值 undefined。统一走 form.elements。
  const F = form.elements;
  const timeEl = (k) => form.querySelector(`.job-fields[data-f="${k}"] [name=time]`);

  // 当前配置的一句话预览，让用户直接确认"它到底什么时候触发"
  const preview = (k) => {
    if (k === 'every') {
      const n = parseInt(F.n.value, 10);
      return Number.isFinite(n) && n > 0
        ? `→ 每 ${n} ${F.u.value === 'h' ? '小时' : '分钟'}触发一次`
        : '→ 请填写间隔';
    }
    if (k === 'daily') {
      const t = timeEl('daily');
      return `→ 每天 ${(t && t.value) || '--:--'} 触发`;
    }
    if (k === 'weekly') {
      const t = timeEl('weekly');
      const d = DOW_OPTS[Number(F.dow.value)] || DOW_OPTS[0];
      return `→ 每${d} ${(t && t.value) || '--:--'} 触发`;
    }
    return F.at.value ? `→ 仅在 ${F.at.value.replace('T', ' ')} 触发一次，触发后自动停用` : '→ 请选择触发时间';
  };

  // 时区不可改，但必须让用户知道「09:00」是按哪个时区算的（间隔型与绝对时刻无关，不显示）
  const tzNote = (k) => {
    if (k === 'every') return '';
    const local = localTz();
    return tz === local
      ? `按 ${tzLabel(tz)} 执行（本机时区）`
      : `按 ${tzLabel(tz)} 执行（任务创建时的时区；本机现为 ${tzLabel(local)}）`;
  };

  const syncFields = () => {
    const k = F.kind.value;
    form.querySelectorAll('.job-fields').forEach((d) => { d.hidden = d.dataset.f !== k; });
    const p = $('#job-preview');
    if (p) p.textContent = preview(k);
    const tzEl = $('#job-tz');
    if (tzEl) {
      const t = tzNote(k);
      tzEl.textContent = t;
      tzEl.hidden = !t;
    }
  };
  form.kind.onchange = syncFields;
  form.addEventListener('input', syncFields);
  syncFields();
  $('#job-cancel').onclick = () => { root_.innerHTML = ''; };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const msg = $('#job-msg');
    msg.textContent = '';
    const k = F.kind.value;
    const kTime = timeEl(k);
    const needTime = k === 'daily' || k === 'weekly';
    if (needTime && !/^\d{2}:\d{2}$/.test((kTime && kTime.value) || '')) {
      msg.textContent = '请选择触发时间';
      return;
    }
    if (k === 'once' && !F.at.value) {
      msg.textContent = '请选择触发时间';
      return;
    }
    if (k === 'every' && !(parseInt(F.n.value, 10) >= 1)) {
      msg.textContent = '间隔必须是大于 0 的整数';
      return;
    }
    const schedule = joinSchedule(k, {
      n: F.n.value, u: F.u.value,
      time: kTime ? kTime.value : '',
      dow: F.dow.value,
      at: F.at.value,
    });
    const payload = {
      name: F.name.value.trim(),
      body: F.body.value,
      schedule,
      tz,
      enabled: F.enabled.checked,
      skip_holiday: F.skip_holiday.checked,
    };
    try {
      const r = isNew ? await api.createJob(payload) : await api.updateJob(job.id, payload);
      root_.innerHTML = '';
      loadJobs();
      const flash = $('#job-flash');
      if (flash) flash.textContent = `已保存 · 下次执行 ${fmtTime(r.next_run_at)}`;
    } catch (err) { msg.textContent = err.message; }
  };
}

function openJobDelete(job) {
  const root_ = $('#modal-root');
  root_.innerHTML = `
  <div class="modal-mask">
    <div class="modal card">
      <h2>删除定时任务</h2>
      <p class="hint">确认删除「${escapeHtml(job.name || '未命名任务')}」？删除后不再触发，该任务已产生的 <b>${job.sent_count || 0} 条日志将一并清除</b>，不可恢复。</p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="jdel-cancel">取消</button>
        <button type="button" class="btn primary danger" id="jdel-confirm">确认删除</button>
      </div>
      <p class="msg" id="jdel-msg"></p>
    </div>
  </div>`;
  $('#jdel-cancel').onclick = () => { root_.innerHTML = ''; };
  $('#jdel-confirm').onclick = async () => {
    try { await api.deleteJob(job.id); root_.innerHTML = ''; loadJobs(); }
    catch (err) { $('#jdel-msg').textContent = err.message; }
  };
}

/* ---------- 发送历史（弹窗 + 分页 + 清空） ---------- */

const HIST_PAGE_SIZE = 10;

// 通用历史弹窗：keyId = 外部 key 的写入记录；jobId = 定时任务的触发记录。
// 两者在数据上互斥（key 通知的 job_id 为空，job 通知的 key_id 为空），所以清空也各清各的。
// onCleared：清空成功后回调，让调用方刷新列表上的「已发送 N 条」。
async function openHistory({ title, subtitle, keyId, jobId, emptyText, onCleared }) {
  const root_ = $('#modal-root');
  let page = 0;
  let total = 0;
  const isJob = !!jobId;
  const rawLabel = isJob ? '触发信息' : '原文';
  const rawTitle = isJob ? '触发详情' : '原始请求参数';

  root_.innerHTML = `
  <div class="modal-mask">
    <div class="modal card" style="max-width:640px;">
      <div class="card-head">
        <h2>${escapeHtml(title)}</h2>
        <span>
          <button class="btn mini danger" id="hist-clear">清空</button>
          <button class="btn mini" id="hist-close">关闭</button>
        </span>
      </div>
      <p class="hint xs" style="margin:0 0 8px">${escapeHtml(subtitle || '')}</p>
      <p class="hint">状态说明：<b class="ok">已送达</b> = 已成功推送到 QQ 群；<b class="warn">未送达</b> = 推送失败（QQ 凭证未配置 / 网关异常），消息仍在，修复后不会自动重发；<b class="rej">停用拒绝</b> = key 已停用，调用被拒绝且未推送。点击「${rawLabel}」可查看该条通知的完整原始数据。</p>
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
  const closeModal = () => { document.querySelectorAll('.raw-pop').forEach((p) => p.remove()); root_.innerHTML = ''; };
  $('#hist-close').onclick = closeModal;

  async function loadPage() {
    const body = $('#hist-body');
    // 清理上一页残留的悬浮原文面板
    document.querySelectorAll('.raw-pop').forEach((p) => p.remove());
    body.innerHTML = '<p class="hint">加载中…</p>';
    try {
      const resp = await api.listNotifications({ keyId, jobId, limit: HIST_PAGE_SIZE, offset: page * HIST_PAGE_SIZE });
      const { notifications } = resp;
      total = resp.total;
      const pages = Math.max(1, Math.ceil(total / HIST_PAGE_SIZE));
      $('#hist-clear').disabled = total === 0;
      $('#hist-total').textContent = total ? `共 ${total} 条 · 第 ${page + 1} / ${pages} 页` : '';
      if (!notifications.length) {
        body.innerHTML = `<p class="hint">${escapeHtml(emptyText || '还没有记录。')}</p>`;
        $('#hist-pager').style.display = 'none';
        return;
      }
      $('#hist-pager').style.display = '';
      body.innerHTML = `
        <table>
          <thead><tr><th>标题</th><th>内容</th><th>发送时间</th><th>状态</th><th>${rawLabel}</th></tr></thead>
          <tbody>${notifications.map((n, i) => {
            const empty = !n.body || !String(n.body).trim();
            // 「停用拒绝」优先：这类记录服务端本就没推送，显示成「未送达」会让人以为是漏推了
            const status = n.rejected
              ? '<span class="badge rejected">停用拒绝</span>'
              : (empty
                ? '<span class="badge empty-msg">空消息</span>'
                : (n.delivered_at
                  ? `<b class="ok">已送达</b><br/><span class="hint xs">${new Date(n.delivered_at).toLocaleString()}</span>`
                  : '<b class="warn">未送达</b>'));
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
            <div class="raw-pop-head">通知 #${n.id} ${rawTitle} <button class="btn mini doc-copy">复制</button></div>
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

  // 清空走服务端 DELETE /api/notifications（带 key_id 或 job_id），不可恢复，必须二次确认
  $('#hist-clear').onclick = async () => {
    if (!total) return;
    const cleared = total;                     // loadPage 会把它重置为 0，先记下来用于提示
    if (!confirm(`确定清空「${title}」的 ${cleared} 条记录？\n清空后不可恢复。`)) return;
    try {
      const r = await api.clearNotifications({ keyId, jobId });
      page = 0;
      await loadPage();
      if (onCleared) onCleared();
      if (isJob) {
        const flash = $('#job-flash');
        if (flash) flash.textContent = `已清空 ${r.deleted ?? cleared} 条日志`;
      }
    } catch (err) {
      alert(`清空失败：${err.message}`);
    }
  };

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
