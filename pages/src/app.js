/* Notify Hub 控制台 · 视图层
   ---------------------------------------------------------------
   结构：常量 → 视图壳（登录 / 主框架）→ 六个视图 → 弹窗 → 启动
   缓存版本号只有 index.html 一处；这里从自身 URL 的查询串派生，再传给子模块，
   所以改版时不需要在多个文件里同步 ?v=。
*/
const V = new URL(import.meta.url).search || '';
const { API_BASE, api, setToken, isLoggedIn } = await import(`./api.js${V}`);
const {
  $, $$, esc, fmtTime, copy, toast, openModal, closeAllModals,
  confirmDialog, skeletonRows, emptyBox, prettyJson,
} = await import(`./ui.js${V}`);

const root = $('#app');
const HISTORY_PAGE_SIZE = 10;
const DOW_OPTS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 触达目标的中文标签见下方「机器人」段落的 BOT_TARGET_LABEL

// 品牌标记：三根递增信号柱，与 index.html 里的 favicon 同一形状
const MARK = `<span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24">
  <rect x="5" y="13.6" width="3.4" height="5.4" rx="1.5"/>
  <rect x="10.3" y="9.6" width="3.4" height="9.4" rx="1.5"/>
  <rect x="15.6" y="5.6" width="3.4" height="13.4" rx="1.5"/>
</svg></span>`;

/* 视图注册表：导航按钮、区块容器与渲染函数一一对应，加页面只需在这里加一行 */
const VIEWS = [
  { id: 'keys', label: 'Key 管理', render: renderKeys },
  { id: 'jobs', label: '定时任务', render: renderJobs },
  { id: 'qqbot', label: '机器人', render: renderBots },
  { id: 'docs', label: '接入文档', render: renderDocs },
  { id: 'acct', label: '账号', render: renderAccount },
];

// 列表项上的「⋯」菜单：点空白处收起。只注册一次，放在模块级，
// 避免每渲染一次列表就叠加一个 document 监听。
document.addEventListener('click', () => {
  closeRowMenus();
});

// 令牌失效（服务端 401）时退出到登录页，而不是留一个点不动的界面
window.addEventListener('nh:unauthorized', () => {
  if (!isLoggedIn()) return;
  setToken(null);
  authView();
  toast('登录已过期，请重新登录', 'err');
});

/* ======================== 通用小件 ======================== */

// 页面标题右侧的统计组：大号 Archivo 数字 + 等宽微标签
function setStat(sel, pairs) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = pairs.map(([label, value, unit]) => `
    <div>
      <span class="n">${esc(String(value))}${unit ? `<span class="unit">${esc(unit)}</span>` : ''}</span>
      <span class="l">${esc(label)}</span>
    </div>`).join('');
}

/* 机器人列表缓存：Key / 任务的编辑弹窗要同步渲染「推送机器人」下拉，
   而弹窗是同步打开的，所以列表在进入主界面时就拉一次并缓存；机器人页会刷新它。
   拉取失败不抛给调用方 —— 拿不到机器人列表时只是不显示这一项，不挡住 key / 任务的编辑。 */
let BOTS = [];
let BOTS_DEFAULT_TPL = '';

async function refreshBots() {
  const d = await api.listBots();
  BOTS = d.bots || [];
  BOTS_DEFAULT_TPL = d.default_msg_template || '';
  return d;
}

// 「推送机器人」下拉：空值 = 跟随账号默认机器人。没有机器人时不渲染整块，
// 免得给用户一个只有「跟随默认」却根本不存在的选项。
function botFieldHtml(selectedId) {
  if (!BOTS.length) return '';
  const def = BOTS.find((b) => b.is_default);
  const opts = [`<option value="" ${selectedId ? '' : 'selected'}>跟随默认机器人${def ? `（${esc(def.name)}）` : ''}</option>`];
  for (const b of BOTS) {
    opts.push(`<option value="${b.id}" ${String(selectedId) === String(b.id) ? 'selected' : ''}>${esc(b.name || '机器人 ' + b.id)}${b.is_default ? '（默认）' : ''}</option>`);
  }
  return `
      <label class="field"><span class="label">推送机器人</span>
        <select name="bot_id">${opts.join('')}</select>
      </label>
      <p class="hint xs">这条通知推给哪个机器人（凭证与推送名单都跟着它走）。不指定 = 跟随账号默认机器人；可到「机器人」页接入多个。</p>`;
}

// 行内操作菜单的统一收起：清掉菜单节点、按钮选中态、以及行的抬层级标记

function closeRowMenus() {
  $$('.key-menu').forEach((m) => m.remove());
  $$('.row-more.active').forEach((b) => { b.classList.remove('active'); b.removeAttribute('aria-expanded'); });
  $$('.row-item.menu-open').forEach((r) => r.classList.remove('menu-open'));
}

// 表格里的紧凑时间：只保留 月/日 时:分，完整时间戳放进 title。
// 历史表五列挤在弹窗里，完整 toLocaleString 会把「2025/9/7 05:36:40」折成两行。
function fmtShort(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function pageHead({ eyebrow, title, sub, statId }) {
  return `
  <div class="page-head">
    <div>
      <span class="eyebrow">${esc(eyebrow)}</span>
      <h1>${esc(title)}</h1>
      ${sub ? `<p class="sub">${sub}</p>` : ''}
    </div>
    ${statId ? `<div class="stat" id="${statId}"></div>` : ''}
  </div>`;
}

/* ======================== 登录 / 注册 ======================== */

function authView() {
  root.innerHTML = `
  <div class="auth">
    <aside class="auth-art">
      <div class="mesh"></div>
      <div class="glow"></div>
      <div class="watermark" aria-hidden="true">HOOK → QQ</div>
      <div class="brand">${MARK}Notify Hub<span class="tag">self hosted</span></div>
      <div>
        <h1>把任意一条 HTTP 请求，<br />变成手机上的一条<em>通知</em>。</h1>
        <ul class="feat">
          <li><span class="n">01</span><span class="t"><b>一个地址就能推。</b>浏览器地址栏、curl、img 标签、CI 脚本，拼上 message 参数即送达。</span></li>
          <li><span class="n">02</span><span class="t"><b>Key 决定渠道。</b>每个 key 是一份独立凭证，通知标题即 key 名称，停用即刻拒绝。</span></li>
          <li><span class="n">03</span><span class="t"><b>定时在服务端。</b>任务由服务端 Cron 执行，关掉浏览器、手机关机都照常触发。</span></li>
          <li><span class="n">04</span><span class="t"><b>机器人来触达。</b>自动捕获群与好友 openid、多目标扇出，推送失败也不丢消息。</span></li>
        </ul>
      </div>
      <div class="foot">Webhook · Key Routing · Server Cron · QQ Bot</div>
    </aside>

    <main class="auth-panel">
      <div class="auth-box">
        <div class="mark-row"><span class="brand">${MARK}Notify Hub</span></div>
        <h2 id="auth-title">欢迎回来</h2>
        <p class="lead">登录后管理 Key、定时任务与机器人触达配置。</p>

        <div class="seg" role="tablist" aria-label="登录或注册">
          <label class="seg-item"><input type="radio" name="authmode" value="login" checked /><span>登录</span></label>
          <label class="seg-item"><input type="radio" name="authmode" value="register" /><span>注册</span></label>
        </div>

        <form id="auth-form">
          <label class="field"><span class="label">用户名</span>
            <input name="username" placeholder="用户名" autocomplete="username" required />
          </label>
          <label class="field"><span class="label">密码</span>
            <input name="password" type="password" placeholder="至少 6 位" autocomplete="current-password" required />
          </label>
          <button type="submit" class="btn primary block" id="auth-submit">登录</button>
          <p class="msg" id="auth-msg"></p>
        </form>

        <p class="auth-note">Web 控制台只做配置与历史查看，通知经 QQ 机器人送达。</p>
      </div>
    </main>
  </div>`;

  const form = $('#auth-form');
  const F = form.elements;   // 不用 form.xxx：与元素 IDL 属性重名时会被表单自身特性遮蔽
  let mode = 'login';

  $$('input[name=authmode]').forEach((r) => {
    r.onchange = () => {
      mode = r.value;
      const reg = mode === 'register';
      $('#auth-title').textContent = reg ? '创建账号' : '欢迎回来';
      $('#auth-submit').textContent = reg ? '注册' : '登录';
      $('#auth-msg').textContent = '';
      F.password.setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    };
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const msg = $('#auth-msg');
    msg.textContent = '';
    const u = F.username.value.trim();
    if (!u) { msg.textContent = '请输入用户名'; return; }
    try {
      const data = mode === 'login'
        ? await api.login(u, F.password.value)
        : await api.register(u, F.password.value);
      setToken(data.token);
      mainView();
    } catch (err) {
      msg.textContent = err.message;
    }
  };
}

/* ======================== 主框架 ======================== */

function mainView() {
  root.innerHTML = `
  <header class="topbar">
    <div class="shell">
      <div class="brand">${MARK}Notify Hub<span class="tag">Console</span></div>
      <nav class="topnav" aria-label="主导航">
        ${VIEWS.map((v) => `<button type="button" data-tab="${v.id}">${esc(v.label)}</button>`).join('')}
      </nav>
      <button type="button" class="nav-exit" id="logout">退出</button>
    </div>
  </header>
  <main class="shell">
    ${VIEWS.map((v) => `<section class="view" id="view-${v.id}"${v.id === 'keys' ? '' : ' hidden'}></section>`).join('')}
  </main>`;

  $$('.topnav button[data-tab]').forEach((b) => { b.onclick = () => show(b.dataset.tab); });
  $('#logout').onclick = () => {
    closeAllModals();
    setToken(null);
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    authView();
  };

  // 机器人列表预取：Key / 任务的编辑弹窗是同步打开的，下拉需要现成的数据。
  // 失败静默 —— 拿不到就只是不显示「推送机器人」这一项，不打扰用户。
  refreshBots().catch(() => {});

  // 刷新后停留在原来的页签：hash 可分享、可回退，且不往历史里堆记录
  const hash = (location.hash || '').replace('#', '');
  show(VIEWS.some((v) => v.id === hash) ? hash : 'keys');
}

function show(id) {
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  $$('.topnav button[data-tab]').forEach((b) => {
    const on = b.dataset.tab === view.id;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  VIEWS.forEach((v) => { const el = $(`#view-${v.id}`); if (el) el.hidden = v.id !== view.id; });
  try { history.replaceState(null, '', `#${view.id}`); } catch {}
  view.render();
}

/* ======================== Key 管理 ======================== */

async function renderKeys() {
  const view = $('#view-keys');
  view.innerHTML = `
    ${pageHead({
      eyebrow: 'Keys · 外部写入凭证',
      title: 'Key 管理',
      sub: '每个 key 是一份独立的写入凭证，把它拼进 <code>/hook/&lt;KEY&gt;</code> 即可推送。<b>通知标题固定为 key 名称</b>，调用方只需传一个 message 参数。站内定时任务不需要 key。',
      statId: 'keys-stat',
    })}
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h2><span class="idx">01</span>我的 Key</h2>
          <button class="btn primary" id="btn-new-key" type="button">＋ 新建 Key</button>
        </div>
        <div id="key-list">${skeletonRows(3)}</div>
      </div>
    </div>`;
  $('#btn-new-key').onclick = openKeyCreate;
  loadKeys();
}

async function loadKeys() {
  const box = $('#key-list');
  if (!box) return;
  try {
    const { keys } = await api.listKeys();
    setStat('#keys-stat', [
      ['总数', keys.length],
      ['启用中', keys.filter((k) => k.active).length],
    ]);
    if (!keys.length) {
      box.innerHTML = emptyBox('还没有 Key', '点击右上角「＋ 新建 Key」创建第一个');
      return;
    }
    box.innerHTML = `<div class="list stack">${keys.map(keyRow).join('')}</div>`;
    bindKeyMenu(keys);
  } catch (err) {
    box.innerHTML = `<p class="msg">加载失败：${esc(err.message)}</p>`;
  }
}

function keyRow(k) {
  const full = k.keyFull || k.key;
  return `
  <div class="row-item ${k.active ? '' : 'off'}" data-key="${k.id}">
    <div class="row-top">
      <span class="row-name">${esc(k.name)}</span>
      <span class="badge ${k.active ? 'on' : 'off'}"><i class="lamp"></i>${k.active ? '启用中' : '已停用'}</span>
      <span class="badge mode">${k.mode === 'custom' ? '自定义模板' : '默认'}</span>
      <span class="row-key" title="${esc(full)}">${esc(full)}</span>
      <button class="row-more" type="button" data-more="${k.id}" aria-label="操作菜单" aria-haspopup="true">⋯</button>
    </div>
    <div class="row-meta">
      <span>推送机器人 <b>${esc(k.bot_name || '默认机器人')}</b></span>
      <span>最近使用 <b>${k.last_used ? fmtTime(k.last_used) : '从未使用'}</b></span>
    </div>
  </div>`;
}

function bindKeyMenu(keys) {
  const box = $('#key-list');
  const find = (id) => keys.find((x) => String(x.id) === id);
  const closeMenus = closeRowMenus;

  box.querySelectorAll('[data-more]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const k = find(btn.dataset.more);
      if (!k) return;
      const wasOpen = btn.classList.contains('active');
      closeMenus();
      if (wasOpen) return;
      btn.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');

      const items = [
        ['复制 Hook 地址', () => copy(`${API_BASE}/hook/${k.keyFull || k.key}`, btn)],
        ['发送历史', () => openHistory({
          title: `「${k.name}」发送历史`,
          subtitle: '外部系统调用该 key 的写入记录',
          keyId: k.id,
          emptyText: '该 key 还没有发送记录。',
        })],
        ['编辑 Key', () => openKeyEdit(k)],
        k.active
          ? ['停用', () => toggleKey(k, false)]
          : ['启用', () => toggleKey(k, true)],
        ['删除', () => openKeyDelete(k)],
      ];

      const menu = document.createElement('div');
      menu.className = 'key-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = items.map(([label], i) =>
        `<button type="button" class="btn mini${label === '停用' || label === '删除' ? ' danger' : ''}" data-i="${i}" role="menuitem">${esc(label)}</button>`
      ).join('');
      menu.querySelectorAll('[data-i]').forEach((b) => {
        b.onclick = (ev) => { ev.stopPropagation(); closeMenus(); items[Number(b.dataset.i)][1](); };
      });

      const row = btn.closest('.row-item');
      row.classList.add('menu-open');   // 抬层级，否则会被后面的行盖住
      row.appendChild(menu);

      // 贴近视口底部时向上翻开，避免最后一行展开后被裁掉
      if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) {
        menu.style.top = 'auto';
        menu.style.bottom = 'calc(100% - 6px)';
      }
    };
  });
}

async function toggleKey(k, active) {
  try {
    await api.updateKey(k.id, { active });
    toast(active ? `已启用「${k.name}」` : `已停用「${k.name}」`, 'ok');
    loadKeys();
  } catch (err) { toast(err.message, 'err'); }
}

// 新建 Key：生成后原地展示 key 与 Hook 地址，可分别复制
function openKeyCreate() {
  openModal(`
    <h2>新建 Key</h2>
    <p class="hint" style="margin:6px 0 14px">每个 key 是一份「外部写入凭证」：填进你的脚本 / CI / 监控的 webhook 地址即可推送通知。站内定时任务不需要 key。</p>
    <div id="create-body">
      <form id="create-form">
        <label class="field"><span class="label">名称（同时是通知标题）</span>
          <input name="name" placeholder="如：服务器告警" required />
        </label>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-cancel>取消</button>
          <button type="submit" class="btn primary">生成</button>
        </div>
        <p class="msg" id="create-msg"></p>
      </form>
    </div>`, (dlg) => {
    dlg.root.querySelector('[data-cancel]').onclick = () => dlg.close();

    const form = dlg.root.querySelector('#create-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      dlg.root.querySelector('#create-msg').textContent = '';
      try {
        const k = await api.createKey(form.elements.name.value.trim() || 'default');
        dlg.root.querySelector('#create-body').innerHTML = `
          <div class="alert ok">
            <b>✅ 已生成</b>（随时可在列表里重新复制）<br/>
            <span class="hint xs">Key</span><br/>
            <code>${esc(k.key)}</code>
            <button class="btn mini" type="button" data-newcopy="${esc(k.key)}">复制</button><br/>
            <span class="hint xs">Hook 地址</span><br/>
            <code>${API_BASE}/hook/${esc(k.key)}</code>
            <button class="btn mini" type="button" data-newcopy="${API_BASE}/hook/${esc(k.key)}">复制</button>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn primary" data-done>完成</button>
          </div>`;
        dlg.root.querySelectorAll('[data-newcopy]').forEach((b) => {
          b.onclick = () => copy(b.dataset.newcopy, b);
        });
        dlg.root.querySelector('[data-done]').onclick = () => { dlg.close(); loadKeys(); };
      } catch (err) {
        dlg.root.querySelector('#create-msg').textContent = err.message;
      }
    };
  });
}

function openKeyEdit(k) {
  openModal(`
    <h2>编辑 Key「${esc(k.name)}」</h2>
    <form id="edit-form">
      <label class="field"><span class="label">名称（同时是通知标题）</span>
        <input name="name" value="${esc(k.name)}" required />
      </label>

      <div class="field">
        <span class="label">推送模式</span>
        <div class="seg">
          <label class="seg-item"><input type="radio" name="mode" value="default" ${k.mode !== 'custom' ? 'checked' : ''}/><span>默认</span></label>
          <label class="seg-item"><input type="radio" name="mode" value="custom" ${k.mode === 'custom' ? 'checked' : ''}/><span>自定义模板</span></label>
        </div>
      </div>
      <p class="hint xs">默认：message 原样作为通知内容。自定义：message 作为模板，<code>$&#123;字段&#125;</code> 占位符用 JSON 数据填充（如 <code>$&#123;name&#125;</code>、<code>$&#123;event.msg&#125;</code>，点分路径、数组用下标）；未传 message 时用下面的 key 模板，两者都没有时整个 JSON 直接作为内容。</p>

      <label class="field" id="tpl-fields" ${k.mode === 'custom' ? '' : 'hidden'}><span class="label">消息模板（可选，调用方未传 message 时生效）</span>
        <input name="template" value="${esc(k.template || '')}" placeholder="如：$&#123;name&#125; 的年龄是 $&#123;age&#125; 岁" />
      </label>

      <label class="check"><input type="checkbox" name="active" ${k.active ? 'checked' : ''}/> 启用此 key（停用后 webhook 调用将被拒绝，且不推送消息）</label>
${botFieldHtml(k.bot_id)}
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-cancel>取消</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
      <p class="msg" id="edit-msg"></p>
    </form>`, (dlg) => {
    const form = dlg.root.querySelector('#edit-form');
    const F = form.elements;   // form.name 会被表单自身特性遮蔽，一律走 elements
    const syncTpl = () => { dlg.root.querySelector('#tpl-fields').hidden = F.mode.value !== 'custom'; };
    form.querySelectorAll('input[name=mode]').forEach((r) => { r.onchange = syncTpl; });
    dlg.root.querySelector('[data-cancel]').onclick = () => dlg.close();

    form.onsubmit = async (e) => {
      e.preventDefault();
      dlg.root.querySelector('#edit-msg').textContent = '';
      try {
        const payload = {
          name: F.name.value.trim(),
          active: F.active.checked,
          mode: F.mode.value,
          template: F.mode.value === 'custom' ? F.template.value : '',
        };
        // 只有渲染出了下拉才带上 bot_id：拿不到机器人列表时为 undefined，
        // 避免把「原本绑着某个机器人」的 key 静默解绑成默认。
        if (F.bot_id) payload.bot_id = F.bot_id.value;
        await api.updateKey(k.id, payload);
        dlg.close();
        toast('已保存', 'ok');
        loadKeys();
      } catch (err) {
        dlg.root.querySelector('#edit-msg').textContent = err.message;
      }
    };
  });
}

async function openKeyDelete(k) {
  const ok = await confirmDialog({
    title: `删除 Key「${k.name}」`,
    bodyHtml: `将<b>彻底删除</b>此 key 与它的 Hook 地址，并同时清除该 key 的<b>全部发送历史</b>，删除后不可恢复。正在使用此 key 的调用方会开始收到 404，请确认已下线。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteKey(k.id);
    toast(`已删除「${k.name}」`, 'ok');
    loadKeys();
  } catch (err) { toast(err.message, 'err'); }
}

/* ======================== 定时任务 ======================== */

// 时区不对用户开放修改：新建任务取浏览器当前 UTC 偏移（如 "+08:00"），
// 编辑已有任务则沿用创建时的时区 —— 否则用户换了时区再随手编辑一次，
// 触发时刻会被静默平移，且很难察觉。
function localTz() {
  const off = -new Date().getTimezoneOffset();
  const a = Math.abs(off);
  return `${off >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

const tzLabel = (tz) => (tz ? `UTC${tz}` : 'UTC');

// schedule 预设串 ⇄ 表单字段
function splitSchedule(s) {
  const v = String(s || '');
  let m;
  if ((m = v.match(/^every:(\d+)(m|h)$/))) return { kind: 'every', n: m[1], u: m[2] };
  if ((m = v.match(/^daily:(\d{2}):(\d{2})$/))) return { kind: 'daily', time: `${m[1]}:${m[2]}` };
  if ((m = v.match(/^weekly:([0-6]),(\d{2}):(\d{2})$/))) return { kind: 'weekly', dow: m[1], time: `${m[2]}:${m[3]}` };
  if ((m = v.match(/^once:(.+)$/))) return { kind: 'once', at: m[1] };
  return { kind: 'every', n: '5', u: 'm' };
}

function joinSchedule(kind, f) {
  if (kind === 'every') return `every:${f.n}${f.u}`;
  if (kind === 'daily') return `daily:${f.time}`;
  if (kind === 'weekly') return `weekly:${f.dow},${f.time}`;
  return `once:${f.at}`;
}

async function renderJobs() {
  const view = $('#view-jobs');
  view.innerHTML = `
    ${pageHead({
      eyebrow: 'Jobs · 服务端 Cron',
      title: '定时任务',
      sub: '任务在<b>服务端</b>执行：关掉浏览器、手机关机都会照常触发，实际触发时刻比设定值晚 0–1 分钟。任务不属于任何外部 key，通知标题就是任务名称。',
      statId: 'jobs-stat',
    })}
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h2><span class="idx">01</span>任务列表</h2>
          <button class="btn primary" id="btn-new-job" type="button">＋ 新建任务</button>
        </div>
        <div id="job-list">${skeletonRows(3)}</div>
      </div>
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
    setStat('#jobs-stat', [
      ['任务总数', jobs.length],
      ['启用中', jobs.filter((j) => j.enabled).length],
      ['累计发送', jobs.reduce((s, j) => s + (j.sent_count || 0), 0), '条'],
    ]);
    if (!jobs.length) {
      box.innerHTML = emptyBox('还没有定时任务', '点击右上角「＋ 新建任务」创建第一个');
      return;
    }
    box.innerHTML = `<div class="list stack">${jobs.map(jobRow).join('')}</div>`;

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
        b.disabled = true;
        try {
          await api.updateJob(j.id, { enabled: !j.enabled });
          toast(j.enabled ? '已停用' : '已启用', 'ok');
          loadJobs();
        } catch (err) { b.disabled = false; toast(err.message, 'err'); }
      };
    });
  } catch (err) {
    box.innerHTML = `<p class="msg">加载失败：${esc(err.message)}</p>`;
  }
}

function jobRow(j) {
  return `
  <div class="row-item ${j.enabled ? '' : 'off'}" data-job="${j.id}">
    <div class="row-top">
      <span class="row-name">${esc(j.name || '未命名任务')}</span>
      <span class="badge ${j.enabled ? 'on' : 'off'}"><i class="lamp"></i>${j.enabled ? '启用中' : '已停用'}</span>
      <span class="badge mode">${esc(j.desc || j.schedule)}</span>
    </div>
    <div class="row-meta">
      <span>通知内容 <b>${esc(j.body || '（与任务名称相同）')}</b></span>
      <span>推送机器人 <b>${esc(j.bot_name || '默认机器人')}</b></span>
    </div>
    <div class="row-meta">
      <span>下次执行 <b>${j.enabled ? fmtTime(j.next_run_at) : '（已停用）'}</b></span>
      <span>上次执行 <b>${fmtTime(j.last_run_at)}</b></span>
      <span>已发送 <b>${j.sent_count || 0}</b> 条</span>
    </div>
    <div class="row-actions">
      <button type="button" class="btn mini" data-log="${j.id}">执行日志</button>
      <button type="button" class="btn mini" data-edit="${j.id}">编辑</button>
      <button type="button" class="btn mini" data-toggle="${j.id}">${j.enabled ? '停用' : '启用'}</button>
      <button type="button" class="btn mini danger" data-del="${j.id}">删除</button>
    </div>
  </div>`;
}

// 新建 / 编辑弹窗（job 为 null 即新建）
function openJobEdit(job) {
  const isNew = !job;
  const sc = splitSchedule(job && job.schedule);
  const tz = (job && job.tz) || localTz();
  const needAdv = !!job && !job.enabled;   // 已停用则直接展开高级设置，免得以为配置丢了

  openModal(`
    <h2>${isNew ? '新建定时任务' : '编辑定时任务'}</h2>
    <form id="job-form">
      <label class="field"><span class="label">任务名称（同时是通知标题）</span>
        <input name="name" value="${esc((job && job.name) || '')}" placeholder="如：每日签到提醒" required />
      </label>

      <label class="field"><span class="label">重复方式</span>
        <select name="kind" id="job-kind">
          <option value="every" ${sc.kind === 'every' ? 'selected' : ''}>固定间隔</option>
          <option value="daily" ${sc.kind === 'daily' ? 'selected' : ''}>每天</option>
          <option value="weekly" ${sc.kind === 'weekly' ? 'selected' : ''}>每周</option>
          <option value="once" ${sc.kind === 'once' ? 'selected' : ''}>仅一次</option>
        </select>
      </label>

      <div class="job-fields" data-f="every" hidden>
        <span class="pre">每</span>
        <input name="n" type="number" min="1" value="${esc(sc.n || '5')}" aria-label="间隔数值" />
        <select name="u" aria-label="间隔单位">
          <option value="m" ${sc.u === 'h' ? '' : 'selected'}>分钟</option>
          <option value="h" ${sc.u === 'h' ? 'selected' : ''}>小时</option>
        </select>
      </div>
      <div class="job-fields" data-f="daily" hidden>
        <span class="pre">每天</span>
        <input name="time" type="time" value="${esc(sc.kind === 'daily' ? sc.time : '09:00')}" aria-label="触发时刻" />
      </div>
      <div class="job-fields" data-f="weekly" hidden>
        <span class="pre">每</span>
        <select name="dow" aria-label="星期">
          ${DOW_OPTS.map((d, i) => `<option value="${i}" ${sc.kind === 'weekly' && String(sc.dow) === String(i) ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
        <input name="time" type="time" value="${esc(sc.kind === 'weekly' ? sc.time : '09:00')}" aria-label="触发时刻" />
      </div>
      <div class="job-fields" data-f="once" hidden>
        <input name="at" type="datetime-local" value="${esc(sc.kind === 'once' ? sc.at : '')}" aria-label="触发时刻" />
      </div>

      <p class="preview" id="job-preview"></p>
      <p class="hint xs" id="job-tz" style="margin-top:6px"></p>

      <label class="field" style="margin-top:14px"><span class="label">通知内容</span>
        <input name="body" value="${esc((job && job.body) || '')}" placeholder="留空则与任务名称相同" />
      </label>
${botFieldHtml(job && job.bot_id)}

      <label class="check"><input type="checkbox" name="skip_holiday" ${job && job.skip_holiday ? 'checked' : ''}/> 跳过节假日（当天为非工作日时不触发，仅周期型任务生效）</label>

      <details class="adv" ${needAdv ? 'open' : ''}>
        <summary>高级设置 · 启停</summary>
        <div class="adv-body">
          <label class="check"><input type="checkbox" name="enabled" ${!job || job.enabled ? 'checked' : ''}/> 启用此任务</label>
        </div>
      </details>

      <div class="modal-actions">
        <button type="button" class="btn ghost" data-cancel>取消</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
      <p class="msg" id="job-msg"></p>
    </form>`, (dlg) => {
    const form = dlg.root.querySelector('#job-form');
    // 不能用 form.name / form.title 取值 —— 这两个名字被元素自身的 IDL 属性占用，
    // 会静默绕过同名 input 并读出空字符串。统一走 form.elements。
    const F = form.elements;
    const timeEl = (k) => form.querySelector(`.job-fields[data-f="${k}"] [name=time]`);

    // 一句话预览，让用户直接确认「它到底什么时候触发」
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

    // 时区不可改，但必须让用户知道 09:00 是按哪个时区算的（间隔型与绝对时刻无关，不显示）
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
      const p = dlg.root.querySelector('#job-preview');
      if (p) p.textContent = preview(k);
      const tzEl = dlg.root.querySelector('#job-tz');
      if (tzEl) {
        const t = tzNote(k);
        tzEl.textContent = t;
        tzEl.hidden = !t;
      }
    };
    F.kind.onchange = syncFields;
    form.addEventListener('input', syncFields);
    syncFields();
    dlg.root.querySelector('[data-cancel]').onclick = () => dlg.close();

    form.onsubmit = async (e) => {
      e.preventDefault();
      const msg = dlg.root.querySelector('#job-msg');
      msg.textContent = '';
      const k = F.kind.value;
      const kTime = timeEl(k);
      if ((k === 'daily' || k === 'weekly') && !/^\d{2}:\d{2}$/.test((kTime && kTime.value) || '')) {
        msg.textContent = '请选择触发时间'; return;
      }
      if (k === 'once' && !F.at.value) { msg.textContent = '请选择触发时间'; return; }
      if (k === 'every' && !(parseInt(F.n.value, 10) >= 1)) { msg.textContent = '间隔必须是大于 0 的整数'; return; }

      const payload = {
        name: F.name.value.trim(),
        body: F.body.value,
        schedule: joinSchedule(k, {
          n: F.n.value, u: F.u.value,
          time: kTime ? kTime.value : '',
          dow: F.dow.value,
          at: F.at.value,
        }),
        tz,
        enabled: F.enabled.checked,
        skip_holiday: F.skip_holiday.checked,
      };
      // 同 key 弹窗：拿不到机器人列表时不带 bot_id，避免静默解绑
      if (F.bot_id) payload.bot_id = F.bot_id.value;
      try {
        const r = isNew ? await api.createJob(payload) : await api.updateJob(job.id, payload);
        dlg.close();
        loadJobs();
        toast(`已保存 · 下次执行 ${fmtTime(r.next_run_at)}`, 'ok');
      } catch (err) { msg.textContent = err.message; }
    };
  });
}

async function openJobDelete(job) {
  const ok = await confirmDialog({
    title: '删除定时任务',
    bodyHtml: `确认删除「${esc(job.name || '未命名任务')}」？删除后不再触发，该任务已产生的 <b>${job.sent_count || 0} 条日志将一并清除</b>，不可恢复。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteJob(job.id);
    toast('已删除', 'ok');
    loadJobs();
  } catch (err) { toast(err.message, 'err'); }
}

/* ======================== 机器人（账号隔离 · 可接多个） ======================== */

const BOT_TARGET_LABEL = { group: 'QQ 群', c2c: 'QQ 私聊', both: '群 + 私聊都发' };

// 名单渲染：有绑定显示 chip（openid + 移除按钮），无绑定显示引导文案
const bindList = (items, kind, emptyText) => (items || []).length
  ? (items || []).map((o) =>
      `<span class="bind-chip">${esc(o)}<button type="button" class="unbind" data-kind="${kind}" data-openid="${esc(o)}" title="从推送名单移除" aria-label="移除 ${esc(o)}">×</button></span>`
    ).join(' ')
  : `<b class="warn">未绑定</b> —— ${emptyText}`;

async function renderBots() {
  const view = $('#view-qqbot');
  view.innerHTML = `
    ${pageHead({
      eyebrow: 'Bot · 触达通道',
      title: '机器人',
      sub: '每个账号可以接<b>多个</b> QQ 官方机器人（其中一个为默认），凭证、推送名单与消息模板都<b>按账号隔离</b>。私聊过它 / 在群里 @过它的对象会自动进入它自己的推送名单，谁都改不动别人的。',
      statId: 'bot-stat',
    })}
    <div id="bot-view" class="stack"><div class="card">${skeletonRows(2)}</div></div>`;
  loadBots();
}

// 单个机器人的卡片：凭证表单 + 推送名单 + 回调地址。各自独立，改动互不影响。
function botCard(b) {
  return `
  <div class="card" data-bot="${b.id}">
    <div class="card-head">
      <h2><span class="idx">02</span>${esc(b.name || '未命名机器人')}
        ${b.is_default ? '<span class="badge on"><i class="lamp"></i>默认</span>' : ''}
        <span class="badge mode">${esc(BOT_TARGET_LABEL[b.target] || b.target || '')}</span>
      </h2>
      <span class="card-tools">
        ${b.is_default ? '' : `<button class="btn mini" type="button" data-mkdefault="${b.id}">设为默认</button>`}
        <button class="btn mini" type="button" data-test="${b.id}">测试连接</button>
        <button class="btn mini danger" type="button" data-del="${b.id}">删除</button>
      </span>
    </div>

    <form data-form="${b.id}">
      <div class="form-grid">
        <label class="field"><span class="label">名称</span>
          <input name="name" value="${esc(b.name || '')}" placeholder="如：私人机器人 / 运维机器人" />
        </label>
        <label class="field"><span class="label">AppID</span>
          <input name="app_id" value="${esc(b.app_id || '')}" placeholder="机器人 AppID" autocomplete="off" />
        </label>
      </div>
      <label class="field" style="margin-top:14px"><span class="label">AppSecret</span>
        <input type="password" name="app_secret" value="" placeholder="${b.has_secret ? `已配置（${esc(b.secret_masked)}），留空保持不变` : '尚未配置'}" autocomplete="new-password" />
      </label>

      <label class="field"><span class="label">触达目标</span>
        <select name="target">
          <option value="c2c" ${b.target === 'c2c' ? 'selected' : ''}>QQ 私聊（加好友后私聊机器人完成绑定）</option>
          <option value="group" ${b.target === 'group' ? 'selected' : ''}>QQ 群（群里 @机器人 完成绑定）</option>
          <option value="both" ${b.target === 'both' ? 'selected' : ''}>群 + 私聊都发</option>
        </select>
      </label>

      <label class="field" style="margin-top:14px"><span class="label">消息模板</span>
        <textarea name="msg_template" rows="5" spellcheck="false" placeholder="${esc(BOTS_DEFAULT_TPL)}">${esc(b.msg_template || '')}</textarea>
      </label>
      <p class="hint xs">占位符：<code>{title}</code> 通知标题（任务名 / key 名）、<code>{body}</code> 正文、<code>{time}</code> 发送时间。<b>清空 = 用默认模板</b>（即输入框里的灰字）。QQ 文本消息仅支持纯文本排版。</p>

      <div class="modal-actions">
        <button type="submit" class="btn primary">保存</button>
      </div>
      <p class="msg" data-msg="${b.id}"></p>
    </form>

    <div class="card-sub">
      <span class="eyebrow">推送名单</span>
      <dl class="kv">
        <dt>QQ 群</dt><dd>${bindList(b.group_openids, 'group', '把机器人拉进群，在群里 @它 说句话')}</dd>
        <dt>QQ 私聊</dt><dd>${bindList(b.user_openids, 'c2c', '加机器人为好友，私聊它发一句话')}</dd>
      </dl>
      <p class="hint xs">谁来 @ / 私聊过这个机器人，谁就进它的名单；推送时逐个发送，不需要接收的点 × 移除。</p>
      <p class="hint xs">开放平台管理端需切到 <b>WebHook 模式</b>，回调地址填：
        <code>${esc(b.callback_url || '')}</code>
        <button class="btn mini" type="button" data-copy="${esc(b.callback_url || '')}">复制</button>
      </p>
    </div>
  </div>`;
}

async function loadBots() {
  const box = $('#bot-view');
  if (!box) return;
  let data;
  try {
    data = await refreshBots();   // 顺便刷新缓存，让 Key / 任务弹窗的下拉同步
  } catch (err) {
    box.innerHTML = `<div class="card"><p class="msg">加载失败：${esc(err.message)}</p></div>`;
    return;
  }

  const bots = data.bots || [];
  const max = data.max || 10;
  const atLimit = bots.length >= max;

  setStat('#bot-stat', [
    ['机器人', bots.length],
    ['绑定目标', bots.reduce((s, b) => s + (b.group_openids || []).length + (b.user_openids || []).length, 0)],
  ]);

  box.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2><span class="idx">01</span>接入了 ${bots.length} 个机器人</h2>
        <button class="btn primary" id="btn-new-bot" type="button" ${atLimit ? 'disabled' : ''}>＋ 新建机器人</button>
      </div>
      <p class="hint">还没有机器人？先去 <a href="https://q.qq.com/qqbot/dashboard/" target="_blank" rel="noopener">QQ 机器人管理端</a> 创建：<b>① 扫码登录 → ② 创建机器人</b>（个人身份证认证即可，龙虾私人机器人也走这里）→ <b>③ 开发设置里拿 AppID / AppSecret</b>（Secret 只显示一次，先复制好）→ ④ 回来点「新建机器人」填入。</p>
      <p class="hint xs">多个机器人的用法：一个账号可以各接一个「私人机器人 / 运维机器人」，再在 <b>Key 管理</b> 与 <b>定时任务</b> 里指定每个 key / 任务用哪个推送（不指定就走<b>默认机器人</b>）。${atLimit ? `<b class="warn">已达上限 ${max} 个</b>` : ''}</p>
    </div>
    ${bots.length
      ? bots.map(botCard).join('')
      : `<div class="card">${emptyBox('还没有接入机器人', '点击右上角「＋ 新建机器人」开始 —— 填入 AppID / AppSecret 后即可推送')}</div>`}`;

  const find = (id) => bots.find((x) => String(x.id) === id);

  const newBtn = $('#btn-new-bot');
  if (newBtn && !atLimit) newBtn.onclick = () => createBot();

  // 名单移除：DELETE /api/bots/:id/targets
  box.querySelectorAll('button.unbind').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.unbindBotTarget(btn.closest('[data-bot]').dataset.bot, btn.dataset.kind, btn.dataset.openid);
        toast('已从推送名单移除', 'ok');
        loadBots();
      } catch (err) { btn.disabled = false; toast('移除失败：' + err.message, 'err'); }
    };
  });

  box.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copy(b.dataset.copy, b); });

  box.querySelectorAll('[data-mkdefault]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await api.updateBot(b.dataset.mkdefault, { is_default: true }); toast('已设为默认机器人', 'ok'); loadBots(); }
      catch (err) { b.disabled = false; toast('设置失败：' + err.message, 'err'); }
    };
  });

  box.querySelectorAll('[data-test]').forEach((b) => {
    b.onclick = async () => {
      const msg = box.querySelector(`[data-msg="${b.dataset.test}"]`);
      if (msg) { msg.textContent = '正在测试（真实换取一次 access_token）…'; msg.classList.remove('ok'); }
      try {
        const r = await api.testBot(b.dataset.test);
        if (msg) {
          msg.textContent = r.ok ? '✓ 连接成功：凭证有效' : `✗ 连接失败：${r.error || '未知错误'}`;
          msg.classList.toggle('ok', !!r.ok);
        }
      } catch (err) { if (msg) msg.textContent = err.message; }
    };
  });

  box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => openBotDelete(find(b.dataset.del)); });

  box.querySelectorAll('[data-form]').forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      // 不用 form.xxx 取值：name 等与表单自身 IDL 属性重名会被静默遮蔽，一律走 elements
      const F = form.elements;
      const id = form.dataset.form;
      const msg = box.querySelector(`[data-msg="${id}"]`);
      if (msg) { msg.textContent = ''; msg.classList.remove('ok'); }
      const payload = {
        name: F.name.value.trim(),
        target: F.target.value,
        msg_template: F.msg_template.value,
        app_id: F.app_id.value.trim(),   // 空串 = 清除（服务端语义）
      };
      if (F.app_secret.value) payload.app_secret = F.app_secret.value;   // 留空 = 保持不变
      try {
        await api.updateBot(id, payload);
        toast('已保存，立即生效', 'ok');
        loadBots();
      } catch (err) { if (msg) msg.textContent = err.message; }
    };
  });
}

// 新建：先建一个占位机器人，再让用户就地填卡片 —— 比弹窗少一层交互，填错了也能直接改
async function createBot() {
  try {
    const r = await api.createBot({ name: '新机器人' });
    await loadBots();
    const card = document.querySelector(`[data-bot="${r.bot.id}"]`);
    const first = card && card.querySelector('input[name=app_id]');
    if (first) { first.focus(); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  } catch (err) { toast('新建失败：' + err.message, 'err'); }
}

async function openBotDelete(bot) {
  if (!bot) return;
  const ok = await confirmDialog({
    title: `删除机器人「${bot.name || '未命名'}」`,
    bodyHtml: `将删除它的凭证与<b>全部推送名单</b>（${(bot.group_openids || []).length} 个群 / ${(bot.user_openids || []).length} 个好友）。绑过它的 key 与定时任务会自动改为「跟随默认机器人」，不会失效。${bot.is_default ? '这是当前的<b>默认机器人</b>，删除后会把剩下的第一个顶上来。' : ''}`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  try { await api.deleteBot(bot.id); toast('已删除机器人', 'ok'); loadBots(); }
  catch (err) { toast(err.message, 'err'); }
}

/* ======================== 接入文档 ======================== */

function renderDocs() {
  const view = $('#view-docs');
  // 代码样例的原文单独保存，供复制按钮按序号取用
  const samples = [
    `${API_BASE}/hook/<KEY>?message=CPU 使用率超过 90%`,
    `curl "${API_BASE}/hook/<KEY>?message=${encodeURIComponent('CPU 使用率超过 90%')}"`,
    `curl -X POST "${API_BASE}/hook/<KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"CPU 使用率超过 90%"}'`,
    `fetch('${API_BASE}/hook/<KEY>', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'CPU 使用率超过 90%' })
});`,
    `import requests

requests.post('${API_BASE}/hook/<KEY>', json={
    'message': 'CPU 使用率超过 90%',
})`,
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
    `{ "ok": true, "id": 71 }                      // 正常入库并推送
{ "ok": true, "id": 72, "empty": true }        // message 为空：只入库不推送（历史显示「空消息」）
{ "ok": true, "deduplicated": true, "id": 70 } // 显式 dedup_key 重复，未重复推送
{ "error": "invalid key" }                     // key 不存在（404）
{ "error": "key is disabled" }                 // key 已停用（403）`,
  ];

  const code = (i) => `<div class="doc-code"><code>${esc(samples[i])}</code><button class="btn mini doc-copy" type="button">复制</button></div>`;

  view.innerHTML = `
    ${pageHead({
      eyebrow: 'Docs · 接入指南',
      title: '接入文档',
      sub: '四种接入姿势：浏览器地址栏、curl、任意语言、以及带模板解析的结构化 JSON。全部只需一个 key。',
    })}
    <div class="stack">
      <div class="card chapter">
        <span class="chapter-num" aria-hidden="true">01</span>
        <div class="card-head"><h2>一键通知 · 30 秒接入</h2></div>
        <p class="hint">在「Key 管理」创建一个 key，把它拼进下面的地址即可。<b>通知标题就是 key 的名称</b>（在 Key 管理里改名即可），所以调用只需一个 message 参数——浏览器地址栏直接回车、img 标签、脚本请求都行，最简单的推送不需要写任何代码。</p>
        ${code(0)}
        <p class="hint">或用 curl：</p>
        ${code(1)}
        <p class="hint">通知经<b>你自己接入的 QQ 机器人</b>推送到它绑定的群 / 好友（在「机器人」页接入，按账号隔离）；网关失败时消息仍入库（历史显示「未送达」），不会丢失。</p>
      </div>

      <div class="card chapter">
        <span class="chapter-num" aria-hidden="true">02</span>
        <div class="card-head"><h2>POST 推送（推荐）</h2></div>
        <p class="hint">POST <code>${API_BASE}/hook/&lt;KEY&gt;</code>，支持三种请求体：<b>JSON</b>、<b>表单</b>（application/x-www-form-urlencoded）、<b>纯文本</b>（直接作为通知内容）。JSON 最常用：</p>
        ${code(2)}
        <p class="hint">浏览器 / Node：</p>
        ${code(3)}
        <p class="hint">Python：</p>
        ${code(4)}
        <div class="table-wrap"><table class="doc-params">
          <thead><tr><th>参数</th><th>说明</th></tr></thead>
          <tbody>
            <tr><td><code>message</code></td><td>通知内容（最长 8000 字符）</td></tr>
            <tr><td><code>dedup_key</code></td><td>可选。显式防重 key：5 分钟窗口内相同 key 只推送一次（用于调用方超时重试场景）。不传则服务端自动生成唯一 key，消息不做内容去重</td></tr>
          </tbody>
        </table></div>
        <p class="hint" style="margin-top:12px"><b>不需要传 title</b>：通知标题固定为 key 的名称，任何模式下都不会被请求参数覆盖。</p>
        <p class="hint">表单模式下参数相同；防重 key 也可放在请求头 <code>X-Dedup-Key</code> 中。GET 与 POST 语义一致，仅 GET 用查询串传参。</p>
      </div>

      <div class="card chapter">
        <span class="chapter-num" aria-hidden="true">03</span>
        <div class="card-head"><h2>自定义模式 · 模板解析</h2></div>
        <p class="hint">在「Key 管理 → ⋯ → 编辑 Key」中把 key 切为「自定义模板」后，message 不再原样发送，而是作为<b>模板</b>：<code>$&#123;字段&#125;</code> 占位符会用 JSON 数据里的对应字段填充。适合监控、CI 等推送结构化 JSON 的场景。</p>
        ${code(5)}
        <p class="hint">路径语法：点分路径、数组用下标（<code>$&#123;event.alerts.0.name&#125;</code>），取不到的字段替换为空串。也可以在「编辑 Key → 自定义模板」的<b>消息模板</b>输入框里给 key 配一个固定模板，调用方不传 message 时自动用它渲染；两者都没有时，整个 JSON 会直接作为通知内容触达，调用方无需任何改造。</p>
      </div>

      <div class="card chapter">
        <span class="chapter-num" aria-hidden="true">04</span>
        <div class="card-head"><h2>响应与防重</h2></div>
        ${code(6)}
        <p class="hint" style="margin-top:8px"><b>防重语义</b>：服务端默认每条消息互不重复（不做内容去重）。只有当调用方显式传了 <code>dedup_key</code> 时才做去重——适合「发送超时后重试」的场景，避免重试导致重复弹通知。</p>
      </div>
    </div>`;

  view.querySelectorAll('.doc-copy').forEach((btn, i) => {
    btn.onclick = () => copy(samples[i], btn);
  });
}

/* ======================== 账号 ======================== */

function renderAccount() {
  const view = $('#view-acct');
  view.innerHTML = `
    ${pageHead({
      eyebrow: 'Account · 安全与配置',
      title: '账号',
      sub: '修改登录密码，并查看当前控制台指向的 API 地址。',
    })}
    <div class="stack">
      <div class="card">
        <div class="card-head"><h2><span class="idx">01</span>修改密码</h2></div>
        <form id="pw-form" style="max-width:420px">
          <label class="field"><span class="label">原密码</span>
            <input name="oldPassword" type="password" placeholder="原密码" autocomplete="current-password" required />
          </label>
          <label class="field"><span class="label">新密码</span>
            <input name="newPassword" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" required />
          </label>
          <button class="btn primary" type="submit">保存</button>
          <p class="msg" id="pw-msg"></p>
        </form>
      </div>

      <div class="card">
        <div class="card-head"><h2><span class="idx">02</span>配置信息</h2></div>
        <dl class="kv">
          <dt>API 地址</dt><dd><code>${esc(API_BASE)}</code></dd>
          <dt>Webhook</dt><dd><code>${esc(API_BASE)}/hook/&lt;KEY&gt;</code></dd>
          <dt>请求方法</dt><dd><code>GET</code> 或 <code>POST</code>（JSON / 表单 / 纯文本均可）</dd>
        </dl>
        <p class="hint xs" style="margin-top:14px">默认调用只需传 message 参数（标题固定为 key 名称）。详见「接入文档」。</p>
      </div>
    </div>`;

  const form = $('#pw-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const F = form.elements;
    const msg = $('#pw-msg');
    msg.textContent = '';
    msg.classList.remove('ok');
    try {
      await api.changePassword(F.oldPassword.value, F.newPassword.value);
      msg.textContent = '密码已更新';
      msg.classList.add('ok');
      toast('密码已更新', 'ok');
      form.reset();
    } catch (err) { msg.textContent = err.message; }
  };
}

/* ======================== 发送历史（弹窗 + 分页 + 清空） ======================== */

// 通用历史弹窗：keyId = 外部 key 的写入记录；jobId = 定时任务的触发记录。
// 两者在数据上互斥（key 通知的 job_id 为空，job 通知的 key_id 为空），所以清空也各清各的。
// onCleared：清空成功后回调，让调用方刷新列表上的「已发送 N 条」。
async function openHistory({ title, subtitle, keyId, jobId, emptyText, onCleared }) {
  const isJob = !!jobId;
  const rawLabel = isJob ? '触发信息' : '原文';
  const rawTitle = isJob ? '触发详情' : '原始请求参数';
  let page = 0;
  let total = 0;

  const dlg = openModal(`
    <div class="card-head">
      <h2>${esc(title)}</h2>
      <span class="row-inline">
        <button class="btn mini danger" id="hist-clear" type="button">清空</button>
        <button class="btn mini" id="hist-close" type="button">关闭</button>
      </span>
    </div>
    <p class="hint xs" style="margin:-6px 0 10px">${esc(subtitle || '')}</p>
    <details class="legend" open>
      <summary>状态说明</summary>
      <p class="hint xs"><b class="ok">已送达</b> = 已成功推送到 QQ；<b class="warn">未送达</b> = 推送失败（凭证未配置 / 网关异常），消息仍在，修复后不会自动重发；<b class="rej">停用拒绝</b> = key 已停用，调用被拒绝且未推送。悬停「${esc(rawLabel)}」列可查看该条通知的完整原始数据。</p>
    </details>
    <div id="hist-body">${skeletonRows(3)}</div>
    <div class="modal-actions between" id="hist-pager">
      <span class="hint xs" id="hist-total"></span>
      <span class="row-inline">
        <button class="btn mini" id="hist-prev" type="button">← 上一页</button>
        <button class="btn mini" id="hist-next" type="button">下一页 →</button>
      </span>
    </div>`);
  dlg.panel.classList.add('modal-w');

  const q = (sel) => dlg.root.querySelector(sel);
  q('#hist-close').onclick = () => dlg.close();

  async function loadPage() {
    const body = q('#hist-body');
    // 清理上一页残留的悬浮原文面板
    $$('.raw-pop').forEach((p) => p.remove());
    body.innerHTML = skeletonRows(3);
    try {
      const resp = await api.listNotifications({
        keyId, jobId, limit: HISTORY_PAGE_SIZE, offset: page * HISTORY_PAGE_SIZE,
      });
      const { notifications } = resp;
      total = resp.total;
      const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
      q('#hist-clear').disabled = total === 0;
      q('#hist-total').textContent = total ? `共 ${total} 条 · 第 ${page + 1} / ${pages} 页` : '暂无记录';

      if (!notifications.length) {
        body.innerHTML = emptyBox(emptyText || '还没有记录。');
        q('#hist-pager').hidden = true;
        return;
      }
      q('#hist-pager').hidden = false;
      body.innerHTML = `
        <div class="table-wrap"><table class="hist-table">
          <thead><tr><th>标题</th><th>内容</th><th>发送时间</th><th>状态</th><th>${esc(rawLabel)}</th></tr></thead>
          <tbody>${notifications.map((n, i) => {
            const empty = !n.body || !String(n.body).trim();
            // 「停用拒绝」优先：这类记录服务端本就没推送，显示成「未送达」会让人以为是漏推了
            const status = n.rejected
              ? '<span class="badge rejected"><i class="lamp"></i>停用拒绝</span>'
              : (empty
                ? '<span class="badge empty-msg">空消息</span>'
                : (n.delivered_at
                  ? `<b class="ok">已送达</b><span class="sub-time">${fmtShort(n.delivered_at)}</span>`
                  : '<b class="warn">未送达</b>'));
            return `
            <tr>
              <td><div class="ellipsis" title="${esc(n.title)}">${esc(n.title)}</div></td>
              <td>${empty
                ? '<span class="hint xs">（无内容）</span>'
                : `<div class="clamp-2">${esc(String(n.body))}</div>`}</td>
              <td class="num" title="${fmtTime(n.created_at)}">${fmtShort(n.created_at)}</td>
              <td>${status}</td>
              <td>${n.payload
                ? `<code class="raw-trigger" data-raw="${i}">查看</code>`
                : '<span class="hint xs">无</span>'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>`;

      q('#hist-prev').disabled = page <= 0;
      q('#hist-next').disabled = page >= pages - 1;

      // 原文悬浮面板：鼠标移到「查看」上时浮现完整未解析 payload
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
            <div class="raw-pop-head">通知 #${n.id} ${esc(rawTitle)} <button class="btn mini doc-copy" type="button">复制</button></div>
            <pre>${esc(pretty)}</pre>`;
          pop.querySelector('.doc-copy').onclick = (e) => { e.stopPropagation(); copy(pretty, e.target); };
          pop.hidden = false;
          // 定位：优先贴在单元格右侧，放不下就翻到左侧，垂直方向夹在视口内
          const r = el.getBoundingClientRect();
          const pw = Math.min(420, window.innerWidth - 24);
          const ph = Math.min(340, window.innerHeight - 24);
          let left = r.right + 10;
          if (left + pw > window.innerWidth - 8) left = Math.max(8, r.left - pw - 10);
          const top = Math.min(Math.max(8, r.top - 12), window.innerHeight - ph - 8);
          pop.style.left = `${left}px`;
          pop.style.top = `${top}px`;
          pop.style.maxWidth = `${pw}px`;
          pop.style.maxHeight = `${ph}px`;
        };
        el.addEventListener('mouseenter', show);
        el.addEventListener('mouseleave', hidePop);
      });
    } catch (err) {
      body.innerHTML = `<p class="msg">加载失败：${esc(err.message)}</p>`;
    }
  }

  q('#hist-prev').onclick = () => { if (page > 0) { page--; loadPage(); } };
  q('#hist-next').onclick = () => { page++; loadPage(); };

  // 清空走服务端 DELETE /api/notifications（带 key_id 或 job_id），不可恢复，必须二次确认
  q('#hist-clear').onclick = async () => {
    if (!total) return;
    const cleared = total;                 // loadPage 会把它重置为 0，先记下来用于提示
    const ok = await confirmDialog({
      title: '清空发送历史',
      bodyHtml: `确定清空「${esc(title)}」的 <b>${cleared} 条</b>记录？清空后不可恢复。`,
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.clearNotifications({ keyId, jobId });
      page = 0;
      await loadPage();
      if (onCleared) onCleared();
      toast(`已清空 ${r.deleted ?? cleared} 条记录`, 'ok');
    } catch (err) {
      toast(`清空失败：${err.message}`, 'err');
    }
  };

  loadPage();
}

/* ======================== 启动 ======================== */

if (isLoggedIn()) mainView(); else authView();
