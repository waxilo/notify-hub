/* Notify Hub 控制台 · 视图层
   ---------------------------------------------------------------
   布局契约：每个页面都是「左列表 / 右详情」两栏（.split.drill）——
   选中条目即在右栏内联出表单，配置不再走弹窗；弹层只留给不可逆操作的二次确认。
   接入文档与账号没有条目操作，用 .split.flow（窄屏顺序堆叠，不做钻取）。

   结构：常量 → 状态与路由 → 视图壳（登录 / 主框架）→ 视图 → 历史 → 启动
   缓存版本号只有 index.html 一处；这里从自身 URL 的查询串派生，再传给子模块，
   所以改版时不需要在多个文件里同步 ?v=。
*/
const V = new URL(import.meta.url).search || '';
const { API_BASE, api, setToken, isLoggedIn } = await import(`./api.js${V}`);
const {
  $, $$, esc, fmtTime, copy, toast, closeAllModals,
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
  { id: 'bots', label: '机器人', render: renderBots },
  { id: 'docs', label: '接入文档', render: renderDocs },
  { id: 'acct', label: '账号', render: renderAccount },
];

/* 状态：data 是服务端数据的本地副本（列表与详情共读一份，避免两处显示不一致）；
   sel 是每页选中的条目（'new' = 新建中的草稿）；tab 是右栏子页签。 */
const S = {
  view: 'keys',
  data: { keys: [], jobs: [], bots: [], botsMax: 10, defaultTpl: '' },
  sel: { keys: null, jobs: null, bots: null, docs: '01', acct: 'pw' },
  tab: { keys: 'cfg', jobs: 'cfg' },
};

/* ======================== 状态与路由 ======================== */

function readHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  const [v, ...rest] = raw.split('/');
  return {
    view: VIEWS.some((x) => x.id === v) ? v : 'keys',
    sel: rest.join('/') || null,
  };
}

// 选中项写进 hash：刷新后仍停在同一条，地址也可直接分享
function writeHash() {
  const sel = S.sel[S.view];
  const h = `#${S.view}${sel ? '/' + sel : ''}`;
  try { if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h); } catch {}
}

// 选中条目：换选中就回到「配置」页签，并同步窄屏的钻取状态
function select(view, sel) {
  S.sel[view] = sel;
  S.tab[view] = 'cfg';
  PAINT[view]();
  syncSplit(view);
  writeHash();
  if (sel != null && window.matchMedia('(max-width: 980px)').matches) window.scrollTo({ top: 0 });
}

function syncSplit(id) {
  const split = $(`#${id}-split`);
  if (!split || !split.classList.contains('drill')) return;
  split.classList.toggle('detail-open', S.sel[id] != null);
}

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

// 表格里的紧凑时间：只保留 月/日 时:分，完整时间戳放进 title
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

// 左列表 / 右详情两栏骨架。drill = 窄屏改成「列表 ⇄ 详情」钻取；否则顺序堆叠。
function splitShell({ id, drill = true, kicker, listTools = '', listCountId = '' }) {
  return `
  <div class="split${drill ? ' drill' : ' flow'}" id="${id}-split">
    <aside class="pane pane-list">
      <div class="pane-head">
        <span class="pane-kicker">${esc(kicker)}</span>
        ${listCountId ? `<span class="pane-count" id="${listCountId}"></span>` : ''}
        ${listTools ? `<span class="pane-tools">${listTools}</span>` : ''}
      </div>
      <div class="pane-body flush" id="${id}-list"></div>
    </aside>
    <div class="pane pane-detail" id="${id}-detail"></div>
  </div>`;
}

// 详情栏头部：左侧「种类 + 条目名 + 状态」，右侧工具组（含窄屏的返回）
function detailHead({ kicker, name, badges = '', tools = '', back = true }) {
  return `
  <div class="pane-head">
    <div class="pane-id">
      <span class="pane-kicker">${esc(kicker)}</span>
      <b>${esc(name)}</b>
      ${badges}
    </div>
    <span class="pane-tools">
      ${back ? '<button class="btn mini pane-back" type="button" data-back>← 列表</button>' : ''}
      ${tools}
    </span>
  </div>`;
}

// 右栏子页签（配置 / 发送历史）
function paneTabs(view, tabs) {
  return `
  <div class="pane-tabs" role="tablist">
    ${tabs.map(([id, label]) => `<button class="tab ${S.tab[view] === id ? 'on' : ''}" type="button" data-ptab="${id}" role="tab">${esc(label)}</button>`).join('')}
  </div>`;
}

function bindPaneTabs(view, box) {
  box.querySelectorAll('[data-ptab]').forEach((b) => {
    b.onclick = () => { S.tab[view] = b.dataset.ptab; PAINT[view](); };
  });
  const back = box.querySelector('[data-back]');
  if (back) back.onclick = () => select(view, null);
}

// 通配绑定：带 data-copy 的按钮一律「点了就复制它的内容」
function bindCopies(box) {
  box.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copy(b.dataset.copy, b); });
}

// 右栏空态（未选中任何条目）
function detailEmpty(text, hint) {
  return `<div class="pane-body">${emptyBox(text, hint)}</div>`;
}

/* 机器人列表缓存：Key / 任务的编辑表单要同步渲染「推送机器人」下拉，
   拉取失败不抛给调用方 —— 拿不到机器人列表时只是不显示这一项，不挡住 key / 任务的保存。 */
async function fetchBots() {
  const d = await api.listBots();
  S.data.bots = d.bots || [];
  S.data.botsMax = d.max || 10;
  S.data.defaultTpl = d.default_msg_template || '';
  return d;
}

// 「推送机器人」下拉：空值 = 跟随账号默认机器人。没有机器人时不渲染整块，
// 免得给用户一个只有「跟随默认」却根本不存在的选项。
function botFieldHtml(selectedId) {
  const BOTS = S.data.bots;
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
      <p class="hint xs" style="margin:-8px 0 14px">这条通知推给哪个机器人（凭证与推送名单都跟着它走）。不指定 = 跟随账号默认机器人；可到「机器人」页接入多个。</p>`;
}

// 保存/失败共用的提示位：把消息写在按钮旁边，失败时输入框不会被滚走
function footHtml(msgId, saveText = '保存', extraHtml = '') {
  return `
    <div class="pane-foot">
      <span class="msg" id="${msgId}"></span>
      <span class="row-inline">${extraHtml}<button type="submit" class="btn primary">${esc(saveText)}</button></span>
    </div>`;
}

function setFoot(msgId, text, ok = false) {
  const el = $(`#${msgId}`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('ok', ok);
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
  const { view: startView, sel } = readHash();
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
    ${VIEWS.map((v) => `<section class="view" id="view-${v.id}"></section>`).join('')}
  </main>`;

  $$('.topnav button[data-tab]').forEach((b) => { b.onclick = () => show(b.dataset.tab); });
  $('#logout').onclick = () => {
    closeAllModals();
    setToken(null);
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    authView();
  };

  // 机器人列表预取：Key / 任务的表单要同步渲染「推送机器人」下拉。
  // 失败静默 —— 拿不到就只是不显示这一项，不打扰用户。
  fetchBots().catch(() => {});

  S.view = startView;
  if (sel) S.sel[startView] = sel;
  show(startView);
}

function show(id) {
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  S.view = view.id;
  syncNav();
  VIEWS.forEach((v) => { const el = $(`#view-${v.id}`); if (el) el.hidden = v.id !== view.id; });
  view.render();
  writeHash();
  window.scrollTo({ top: 0 });
}

function syncNav() {
  $$('.topnav button[data-tab]').forEach((b) => {
    const on = b.dataset.tab === S.view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

/* ======================== Key 管理 ======================== */

async function renderKeys() {
  const view = $('#view-keys');
  view.innerHTML = `
    ${pageHead({
      eyebrow: 'Keys · 外部写入凭证',
      title: 'Key 管理',
      sub: '每个 key 是一份独立的写入凭证，把它拼进 <code>/hook/&lt;KEY&gt;</code> 即可推送。<b>通知标题固定为 key 名称</b>，调用方只需传一个 message 参数。站内定时任务不需要 key。<b>左侧选一条，右侧直接改。</b>',
      statId: 'keys-stat',
    })}
    ${splitShell({
      id: 'keys', kicker: '我的 Key', listCountId: 'keys-count',
      listTools: '<button class="btn mini primary" id="keys-new" type="button">＋ 新建</button>',
    })}`;
  $('#keys-new').onclick = () => select('keys', 'new');
  await loadKeys();
}

async function loadKeys() {
  const box = $('#keys-list');
  if (!box) return;
  try {
    const { keys } = await api.listKeys();
    S.data.keys = keys || [];
    paintKeys();
    syncSplit('keys');
  } catch (err) {
    box.innerHTML = `<p class="msg" style="padding:16px">加载失败：${esc(err.message)}</p>`;
  }
}

function paintKeys() { paintKeyList(); paintKeyDetail(); }

function paintKeyList() {
  const box = $('#keys-list');
  const keys = S.data.keys;
  if (box) {
    box.innerHTML = keys.length
      ? keys.map(keyItem).join('')
      : emptyBox('还没有 Key', '点上方「＋ 新建」创建第一个');
    box.querySelectorAll('[data-sel]').forEach((b) => {
      b.onclick = () => select('keys', b.dataset.sel);
    });
  }
  const c = $('#keys-count');
  if (c) c.textContent = keys.length ? `${keys.length} 个` : '';
  setStat('#keys-stat', [
    ['总数', keys.length],
    ['启用中', keys.filter((k) => k.active).length],
  ]);
}

function keyItem(k) {
  return `
  <button type="button" class="item ${k.active ? '' : 'off'} ${S.sel.keys === String(k.id) ? 'on' : ''}" data-sel="${k.id}">
    <span class="item-top">
      <span class="item-name">${esc(k.name)}</span>
      <span class="badge ${k.active ? 'on' : 'off'}"><i class="lamp"></i>${k.active ? '启用' : '停用'}</span>
    </span>
    <span class="item-meta"><b>${esc(k.bot_name || '默认机器人')}</b> · ${k.last_used ? fmtTime(k.last_used) : '从未使用'}</span>
    <span class="item-sub">${esc(k.keyFull || k.key || '')}</span>
  </button>`;
}

function paintKeyDetail() {
  const box = $('#keys-detail');
  if (!box) return;
  box.innerHTML = '';
  $$('.raw-pop').forEach((p) => p.remove());

  const sel = S.sel.keys;
  if (sel === 'new') { paintKeyCreate(); return; }

  const k = S.data.keys.find((x) => String(x.id) === sel);
  if (!k) {
    box.innerHTML = detailEmpty('未选择 Key', '从左侧点一条开始编辑，或点「＋ 新建」。');
    return;
  }

  const isHist = S.tab.keys === 'hist';
  box.innerHTML = `
    ${detailHead({
      kicker: 'Key', name: k.name,
      badges: `<span class="badge ${k.active ? 'on' : 'off'}"><i class="lamp"></i>${k.active ? '启用中' : '已停用'}</span>`,
      tools: '<button class="btn mini danger" type="button" data-del>删除</button>',
    })}
    ${paneTabs('keys', [['cfg', '配置'], ['hist', '发送历史']])}
    <div class="pane-body">
      ${isHist
        ? '<div id="hist-mount">' + skeletonRows(3) + '</div>'
        : keyFormHtml(k)}
    </div>`;

  bindPaneTabs('keys', box);
  bindCopies(box);
  const del = box.querySelector('[data-del]');
  if (del) del.onclick = () => removeKey(k);

  if (isHist) {
    mountHistory($('#hist-mount'), {
      keyId: k.id,
      title: `「${k.name}」`,
      emptyText: '该 key 还没有发送记录。',
    });
    return;
  }
  bindKeyForm(k);
}

function keyFormHtml(k) {
  const hookUrl = `${API_BASE}/hook/${k.keyFull || k.key || ''}`;
  return `
  <form id="key-form">
    <div class="field">
      <span class="label">Hook 地址（拼进你的脚本 / CI / 监控）</span>
      <div class="cred">
        <code>${esc(hookUrl)}</code>
        <button class="btn mini" type="button" data-copy="${esc(hookUrl)}">复制</button>
      </div>
    </div>

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
    <p class="hint xs" style="margin:-8px 0 14px">默认：message 原样作为通知内容。自定义：message 作为模板，<code>$&#123;字段&#125;</code> 占位符用 JSON 数据填充（如 <code>$&#123;name&#125;</code>、<code>$&#123;event.msg&#125;</code>，点分路径、数组用下标）；未传 message 时用下面的 key 模板，两者都没有时整个 JSON 直接作为内容。</p>

    <label class="field" id="tpl-field" ${k.mode === 'custom' ? '' : 'hidden'}><span class="label">消息模板（可选，调用方未传 message 时生效）</span>
      <input name="template" value="${esc(k.template || '')}" placeholder="如：$&#123;name&#125; 的年龄是 $&#123;age&#125; 岁" />
    </label>
${botFieldHtml(k.bot_id)}
    <label class="check"><input type="checkbox" name="active" ${k.active ? 'checked' : ''}/> 启用此 key（停用后 webhook 调用将被拒绝，且不推送消息）</label>
${footHtml('key-msg')}
  </form>`;
}

function bindKeyForm(k) {
  const box = $('#keys-detail');
  const form = box.querySelector('#key-form');
  if (!form) return;
  const F = form.elements;   // form.name 会被表单自身特性遮蔽，一律走 elements
  const tplField = box.querySelector('#tpl-field');
  const syncTpl = () => { tplField.hidden = F.mode.value !== 'custom'; };
  form.querySelectorAll('input[name=mode]').forEach((r) => { r.onchange = syncTpl; });

  form.onsubmit = async (e) => {
    e.preventDefault();
    setFoot('key-msg', '');
    const payload = {
      name: F.name.value.trim(),
      active: F.active.checked,
      mode: F.mode.value,
      template: F.mode.value === 'custom' ? F.template.value : '',
    };
    // 只有渲染出了下拉才带上 bot_id：拿不到机器人列表时为 undefined，
    // 避免把「原本绑着某个机器人」的 key 静默解绑成默认。
    if (F.bot_id) payload.bot_id = F.bot_id.value;
    try {
      await api.updateKey(k.id, payload);
      toast('已保存', 'ok');
      await loadKeys();
    } catch (err) { setFoot('key-msg', err.message); }
  };
}

function paintKeyCreate() {
  const box = $('#keys-detail');
  box.innerHTML = `
    ${detailHead({ kicker: 'Key', name: '新建 Key', badges: '<span class="badge mode">草稿</span>' })}
    <div class="pane-body">
      <p class="hint" style="margin-bottom:16px">每个 key 是一份「外部写入凭证」：填进你的脚本 / CI / 监控的 webhook 地址即可推送通知。站内定时任务不需要 key。</p>
      <form id="key-create-form">
        <label class="field"><span class="label">名称（同时是通知标题）</span>
          <input name="name" placeholder="如：服务器告警" required />
        </label>
        <div class="pane-foot">
          <span class="msg" id="key-create-msg"></span>
          <span class="row-inline">
            <button type="button" class="btn ghost" data-cancel>取消</button>
            <button type="submit" class="btn primary">生成</button>
          </span>
        </div>
      </form>
    </div>`;

  bindPaneTabs('keys', box);
  box.querySelector('[data-cancel]').onclick = () => select('keys', null);

  const form = box.querySelector('#key-create-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    setFoot('key-create-msg', '');
    try {
      const k = await api.createKey(form.elements.name.value.trim() || 'default');
      await loadKeys();
      const id = k && k.id != null ? String(k.id) : null;
      if (id && S.data.keys.some((x) => String(x.id) === id)) select('keys', id);
      else select('keys', null);
      toast(`已创建「${(k && k.name) || 'default'}」`, 'ok');
    } catch (err) { setFoot('key-create-msg', err.message); }
  };
}

async function removeKey(k) {
  const ok = await confirmDialog({
    title: `删除 Key「${k.name}」`,
    bodyHtml: `将<b>彻底删除</b>此 key 与它的 Hook 地址，并同时清除该 key 的<b>全部发送历史</b>，删除后不可恢复。正在使用此 key 的调用方会开始收到 404，请确认已下线。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteKey(k.id);
    S.sel.keys = null;
    toast(`已删除「${k.name}」`, 'ok');
    await loadKeys();
    syncSplit('keys');
    writeHash();
  } catch (err) { toast(err.message, 'err'); }
}

/* ======================== 定时任务 ======================== */

// 时区不对用户开放修改：新建任务取浏览器当前 UTC 偏移（如 "+08:00"），
// 编辑已有任务则沿用创建时的时区 —— 否则用户换了时区再随手保存一次，
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
      sub: '任务在<b>服务端</b>执行：关掉浏览器、手机关机都会照常触发，实际触发时刻比设定值晚 0–1 分钟。任务不属于任何外部 key，通知标题就是任务名称。<b>左侧选一条，右侧直接改。</b>',
      statId: 'jobs-stat',
    })}
    ${splitShell({
      id: 'jobs', kicker: '任务列表', listCountId: 'jobs-count',
      listTools: '<button class="btn mini primary" id="jobs-new" type="button">＋ 新建</button>',
    })}`;
  $('#jobs-new').onclick = () => select('jobs', 'new');
  await loadJobs();
}

async function loadJobs() {
  const box = $('#jobs-list');
  if (!box) return;
  try {
    // 定时任务不挂 key（key 是外部系统调 /hook/:key 用的），所以这里不需要拉 keys
    const { jobs } = await api.listJobs();
    S.data.jobs = jobs || [];
    paintJobs();
    syncSplit('jobs');
  } catch (err) {
    box.innerHTML = `<p class="msg" style="padding:16px">加载失败：${esc(err.message)}</p>`;
  }
}

function paintJobs() { paintJobList(); paintJobDetail(); }

function paintJobList() {
  const box = $('#jobs-list');
  const jobs = S.data.jobs;
  if (box) {
    box.innerHTML = jobs.length
      ? jobs.map(jobItem).join('')
      : emptyBox('还没有定时任务', '点上方「＋ 新建」创建第一个');
    box.querySelectorAll('[data-sel]').forEach((b) => {
      b.onclick = () => select('jobs', b.dataset.sel);
    });
  }
  const c = $('#jobs-count');
  if (c) c.textContent = jobs.length ? `${jobs.length} 个` : '';
  setStat('#jobs-stat', [
    ['任务总数', jobs.length],
    ['启用中', jobs.filter((j) => j.enabled).length],
    ['累计发送', jobs.reduce((s, j) => s + (j.sent_count || 0), 0), '条'],
  ]);
}

function jobItem(j) {
  return `
  <button type="button" class="item ${j.enabled ? '' : 'off'} ${S.sel.jobs === String(j.id) ? 'on' : ''}" data-sel="${j.id}">
    <span class="item-top">
      <span class="item-name">${esc(j.name || '未命名任务')}</span>
      <span class="badge ${j.enabled ? 'on' : 'off'}"><i class="lamp"></i>${j.enabled ? '启用' : '停用'}</span>
    </span>
    <span class="item-meta">${esc(j.desc || j.schedule)}${j.skip_holiday ? ' · 跳过节假日' : ''}</span>
    <span class="item-sub">${j.enabled ? `下次 ${fmtTime(j.next_run_at)}` : '已停用'} · 已发 ${j.sent_count || 0} 条</span>
  </button>`;
}

function paintJobDetail() {
  const box = $('#jobs-detail');
  if (!box) return;
  box.innerHTML = '';
  $$('.raw-pop').forEach((p) => p.remove());

  const sel = S.sel.jobs;
  if (sel === 'new') { paintJobForm(null); return; }

  const j = S.data.jobs.find((x) => String(x.id) === sel);
  if (!j) {
    box.innerHTML = detailEmpty('未选择任务', '从左侧点一条开始编辑，或点「＋ 新建」。');
    return;
  }
  paintJobForm(j);
}

function paintJobForm(job) {
  const box = $('#jobs-detail');
  const isNew = !job;
  const isHist = !isNew && S.tab.jobs === 'hist';

  box.innerHTML = `
    ${detailHead({
      kicker: '任务', name: isNew ? '新建任务' : (job.name || '未命名任务'),
      badges: isNew
        ? '<span class="badge mode">草稿</span>'
        : `<span class="badge ${job.enabled ? 'on' : 'off'}"><i class="lamp"></i>${job.enabled ? '启用中' : '已停用'}</span>`,
      tools: isNew ? '' : '<button class="btn mini danger" type="button" data-del>删除</button>',
    })}
    ${isNew ? '' : paneTabs('jobs', [['cfg', '配置'], ['hist', '执行日志']])}
    <div class="pane-body">
      ${isHist
        ? '<div id="hist-mount">' + skeletonRows(3) + '</div>'
        : jobFormHtml(job)}
    </div>`;

  bindPaneTabs('jobs', box);
  const del = box.querySelector('[data-del]');
  if (del) del.onclick = () => removeJob(job);

  if (isHist) {
    mountHistory($('#hist-mount'), {
      jobId: job.id,
      title: `「${job.name || '未命名任务'}」`,
      emptyText: '该任务还没有触发记录。',
      onCleared: loadJobs,
    });
    return;
  }
  bindJobForm(job);
}

function jobFormHtml(job) {
  const isNew = !job;
  const sc = splitSchedule(job && job.schedule);
  const tz = (job && job.tz) || localTz();
  const needAdv = !!job && !job.enabled;   // 已停用则直接展开高级设置，免得以为配置丢了

  return `
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
${footHtml('job-msg')}
  </form>`;
}

function bindJobForm(job) {
  const box = $('#jobs-detail');
  const form = box.querySelector('#job-form');
  if (!form) return;
  // 不能用 form.name / form.title 取值 —— 这两个名字被元素自身的 IDL 属性占用，
  // 会静默绕过同名 input 并读出空字符串。统一走 form.elements。
  const F = form.elements;
  const timeEl = (k) => form.querySelector(`.job-fields[data-f="${k}"] [name=time]`);
  const isNew = !job;
  const tz = (job && job.tz) || localTz();

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
    const p = box.querySelector('#job-preview');
    if (p) p.textContent = preview(k);
    const tzEl = box.querySelector('#job-tz');
    if (tzEl) {
      const t = tzNote(k);
      tzEl.textContent = t;
      tzEl.hidden = !t;
    }
  };
  F.kind.onchange = syncFields;
  form.addEventListener('input', syncFields);
  syncFields();

  form.onsubmit = async (e) => {
    e.preventDefault();
    setFoot('job-msg', '');
    const k = F.kind.value;
    const kTime = timeEl(k);
    if ((k === 'daily' || k === 'weekly') && !/^\d{2}:\d{2}$/.test((kTime && kTime.value) || '')) {
      setFoot('job-msg', '请选择触发时间'); return;
    }
    if (k === 'once' && !F.at.value) { setFoot('job-msg', '请选择触发时间'); return; }
    if (k === 'every' && !(parseInt(F.n.value, 10) >= 1)) { setFoot('job-msg', '间隔必须是大于 0 的整数'); return; }

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
    // 同 key 表单：拿不到机器人列表时不带 bot_id，避免静默解绑
    if (F.bot_id) payload.bot_id = F.bot_id.value;
    try {
      const r = isNew ? await api.createJob(payload) : await api.updateJob(job.id, payload);
      toast(`已保存 · 下次执行 ${fmtTime(r.next_run_at)}`, 'ok');
      await loadJobs();
      const id = r && r.id != null ? String(r.id) : null;
      if (isNew && id && S.data.jobs.some((x) => String(x.id) === id)) select('jobs', id);
    } catch (err) { setFoot('job-msg', err.message); }
  };
}

async function removeJob(job) {
  const ok = await confirmDialog({
    title: '删除定时任务',
    bodyHtml: `确认删除「${esc(job.name || '未命名任务')}」？删除后不再触发，该任务已产生的 <b>${job.sent_count || 0} 条日志将一并清除</b>，不可恢复。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteJob(job.id);
    S.sel.jobs = null;
    toast('已删除', 'ok');
    await loadJobs();
    syncSplit('jobs');
    writeHash();
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
  const view = $('#view-bots');
  view.innerHTML = `
    ${pageHead({
      eyebrow: 'Bot · 触达通道',
      title: '机器人',
      sub: '每个账号可以接<b>多个</b> QQ 官方机器人（其中一个为默认），凭证、推送名单与消息模板都<b>按账号隔离</b>。私聊过它 / 在群里 @过它的对象会自动进入它自己的推送名单，谁都改不动别人的。<b>左侧选一个，右侧直接改。</b>',
      statId: 'bot-stat',
    })}
    ${splitShell({
      id: 'bots', kicker: '机器人', listCountId: 'bots-count',
      listTools: '<button class="btn mini primary" id="bots-new" type="button">＋ 新建</button>',
    })}`;
  $('#bots-new').onclick = createBot;
  await loadBots();
}

async function loadBots() {
  const listBox = $('#bots-list');
  if (!listBox) return;
  try {
    await fetchBots();   // 顺便刷新缓存，让 Key / 任务表单的下拉同步
  } catch (err) {
    listBox.innerHTML = `<p class="msg" style="padding:16px">加载失败：${esc(err.message)}</p>`;
    return;
  }
  paintBots();
  syncSplit('bots');
}

function paintBots() { paintBotList(); paintBotDetail(); }

function paintBotList() {
  const box = $('#bots-list');
  const bots = S.data.bots;
  const atLimit = bots.length >= S.data.botsMax;
  if (box) {
    box.innerHTML = bots.length
      ? bots.map(botItem).join('')
      : emptyBox('还没有接入机器人', '点上方「＋ 新建」开始 —— 填入 AppID / AppSecret 后即可推送');
    box.querySelectorAll('[data-sel]').forEach((b) => {
      b.onclick = () => select('bots', b.dataset.sel);
    });
  }
  const c = $('#bots-count');
  if (c) c.textContent = bots.length ? `${bots.length} / ${S.data.botsMax}` : '';
  const nb = $('#bots-new');
  if (nb) { nb.disabled = atLimit; nb.title = atLimit ? `已达上限 ${S.data.botsMax} 个` : ''; }
  setStat('#bot-stat', [
    ['机器人', bots.length],
    ['绑定目标', bots.reduce((s, b) => s + (b.group_openids || []).length + (b.user_openids || []).length, 0)],
  ]);
}

function botItem(b) {
  const n = (b.group_openids || []).length + (b.user_openids || []).length;
  return `
  <button type="button" class="item ${S.sel.bots === String(b.id) ? 'on' : ''}" data-sel="${b.id}">
    <span class="item-top">
      <span class="item-name">${esc(b.name || '未命名机器人')}</span>
      ${b.is_default ? '<span class="badge on"><i class="lamp"></i>默认</span>' : ''}
    </span>
    <span class="item-meta">${esc(BOT_TARGET_LABEL[b.target] || b.target || '—')}</span>
    <span class="item-sub">${n ? `名单 ${n} 个目标` : '名单为空'} · ${b.has_secret ? '凭证已配置' : '未配置凭证'}</span>
  </button>`;
}

function paintBotDetail() {
  const box = $('#bots-detail');
  if (!box) return;
  const b = S.data.bots.find((x) => String(x.id) === S.sel.bots);
  if (!b) {
    box.innerHTML = detailEmpty(
      S.data.bots.length ? '未选择机器人' : '还没有接入机器人',
      S.data.bots.length ? '从左侧点一个开始编辑。' : '点上方「＋ 新建」—— 填入 AppID / AppSecret 后即可推送',
    );
    return;
  }

  // 头部工具随「是否默认」变，单独抽出来便于局部刷新
  const headFor = (bot) => detailHead({
    kicker: '机器人', name: bot.name || '未命名机器人',
    badges: bot.is_default ? '<span class="badge on"><i class="lamp"></i>默认</span>' : '',
    tools: `
      ${bot.is_default ? '' : '<button class="btn mini" type="button" data-mkdefault>设为默认</button>'}
      <button class="btn mini danger" type="button" data-del>删除</button>`,
  });

  box.innerHTML = `
    ${headFor(b)}
    <div class="pane-body">
      <form id="bot-form">
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
          <textarea name="msg_template" rows="5" spellcheck="false" placeholder="${esc(S.data.defaultTpl)}">${esc(b.msg_template || '')}</textarea>
        </label>
        <p class="hint xs" style="margin:-8px 0 14px">占位符：<code>{title}</code> 通知标题（任务名 / key 名）、<code>{body}</code> 正文、<code>{time}</code> 发送时间。<b>清空 = 用默认模板</b>（即输入框里的灰字）。QQ 文本消息仅支持纯文本排版。</p>

        <div class="pane-foot">
          <span class="msg" id="bot-msg"></span>
          <span class="row-inline">
            <button class="btn mini" type="button" data-test>测试连接</button>
            <button type="submit" class="btn primary">保存</button>
          </span>
        </div>
      </form>

      <div class="card-sub">
        <span class="eyebrow">推送名单</span>
        <dl class="kv">
          <dt>QQ 群</dt><dd>${bindList(b.group_openids, 'group', '把机器人拉进群，在群里 @它 说句话')}</dd>
          <dt>QQ 私聊</dt><dd>${bindList(b.user_openids, 'c2c', '加机器人为好友，私聊它发一句话')}</dd>
        </dl>
        <p class="hint xs">谁来 @ / 私聊过这个机器人，谁就进它的名单；推送时逐个发送，不需要接收的点 × 移除。</p>
      </div>

      <div class="card-sub">
        <span class="eyebrow">回调地址</span>
        <p class="hint xs" style="margin-bottom:8px">开放平台管理端需切到 <b>WebHook 模式</b>，回调地址填这个（多个机器人共用同一个地址，靠签名自动分流）：</p>
        <div class="cred">
          <code>${esc(b.callback_url || '')}</code>
          <button class="btn mini" type="button" data-copy="${esc(b.callback_url || '')}">复制</button>
        </div>
      </div>
    </div>`;

  bindPaneTabs('bots', box);
  bindCopies(box);

  const del = box.querySelector('[data-del]');
  if (del) del.onclick = () => removeBot(b);

  // 设为默认：只动徽章与列表，不重画表单 —— 免得把用户没保存的改动冲掉
  const mk = box.querySelector('[data-mkdefault]');
  if (mk) {
    mk.onclick = async () => {
      mk.disabled = true;
      try {
        await api.updateBot(b.id, { is_default: true });
        S.data.bots.forEach((x) => { x.is_default = String(x.id) === String(b.id); });
        paintBotList();
        paintBotDetail();
        toast('已设为默认机器人', 'ok');
      } catch (err) { mk.disabled = false; toast('设置失败：' + err.message, 'err'); }
    };
  }

  // 名单移除：DELETE /api/bots/:id/targets
  box.querySelectorAll('button.unbind').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.unbindBotTarget(b.id, btn.dataset.kind, btn.dataset.openid);
        toast('已从推送名单移除', 'ok');
        await loadBots();
      } catch (err) { btn.disabled = false; toast('移除失败：' + err.message, 'err'); }
    };
  });

  const testBtn = box.querySelector('[data-test]');
  if (testBtn) {
    testBtn.onclick = async () => {
      setFoot('bot-msg', '正在测试（真实换取一次 access_token）…');
      try {
        const r = await api.testBot(b.id);
        setFoot('bot-msg', r.ok ? '✓ 连接成功：凭证有效' : `✗ 连接失败：${r.error || '未知错误'}`, !!r.ok);
      } catch (err) { setFoot('bot-msg', err.message); }
    };
  }

  const form = box.querySelector('#bot-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    // 不用 form.xxx 取值：name 等与表单自身 IDL 属性重名会被静默遮蔽，一律走 elements
    const F = form.elements;
    setFoot('bot-msg', '');
    const payload = {
      name: F.name.value.trim(),
      target: F.target.value,
      msg_template: F.msg_template.value,
      app_id: F.app_id.value.trim(),   // 空串 = 清除（服务端语义）
    };
    if (F.app_secret.value) payload.app_secret = F.app_secret.value;   // 留空 = 保持不变
    try {
      await api.updateBot(b.id, payload);
      toast('已保存，立即生效', 'ok');
      await loadBots();
    } catch (err) { setFoot('bot-msg', err.message); }
  };
}

// 新建：先建一个占位机器人再让它被选中 —— 比弹窗少一层交互，填错了也能直接改
async function createBot() {
  const btn = $('#bots-new');
  if (btn) btn.disabled = true;
  try {
    const r = await api.createBot({ name: '新机器人' });
    await loadBots();
    const id = r && r.bot ? r.bot.id : (r && r.id);
    if (id != null && S.data.bots.some((x) => String(x.id) === String(id))) select('bots', String(id));
    const input = $('#bots-detail input[name=app_id]');
    if (input) input.focus();
    toast('已新建，填入 AppID / AppSecret 后保存', 'ok');
  } catch (err) {
    toast('新建失败：' + err.message, 'err');
  } finally {
    const nb = $('#bots-new');
    if (nb) nb.disabled = S.data.bots.length >= S.data.botsMax;
  }
}

async function removeBot(bot) {
  const ok = await confirmDialog({
    title: `删除机器人「${bot.name || '未命名'}」`,
    bodyHtml: `将删除它的凭证与<b>全部推送名单</b>（${(bot.group_openids || []).length} 个群 / ${(bot.user_openids || []).length} 个好友）。绑过它的 key 与定时任务会自动改为「跟随默认机器人」，不会失效。${bot.is_default ? '这是当前的<b>默认机器人</b>，删除后会把剩下的第一个顶上来。' : ''}`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteBot(bot.id);
    S.sel.bots = null;
    toast('已删除机器人', 'ok');
    await loadBots();
    syncSplit('bots');
    writeHash();
  } catch (err) { toast(err.message, 'err'); }
}

/* ======================== 接入文档（目录式左右分栏） ======================== */

// 代码样例的原文单独保存，供复制按钮按 data-copy 取用
function docSamples() {
  return [
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
}

function docChapters() {
  const s = docSamples();
  // 代码块头栏的标签：写在块里比写在块外更省读者一眼（原来的「或用 curl：」这类小标题已移除）
  const LABELS = [
    'GET · 浏览器地址栏', 'curl · GET', 'curl · POST',
    'fetch · 浏览器 / Node', 'Python · requests', 'JSON · 模板解析', '响应',
  ];
  const code = (i) => `
    <div class="doc-block">
      <div class="doc-bar">
        <span class="doc-label">${esc(LABELS[i])}</span>
        <button class="btn mini doc-copy" type="button" data-copy="${esc(s[i])}">复制</button>
      </div>
      <div class="doc-code"><code>${esc(s[i])}</code></div>
    </div>`;
  return [
    {
      id: '01', label: '一键通知 · 30 秒接入', sub: '一个地址 + message 参数',
      html: `
        <p class="hint">在「Key 管理」创建一个 key，把它拼进下面的地址即可。<b>通知标题就是 key 的名称</b>（在 Key 管理里改名即可），所以调用只需一个 message 参数——浏览器地址栏直接回车、img 标签、脚本请求都行，最简单的推送不需要写任何代码。</p>
        ${code(0)}
        ${code(1)}
        <p class="hint">通知经<b>你自己接入的 QQ 机器人</b>推送到它绑定的群 / 好友（在「机器人」页接入，按账号隔离）；网关失败时消息仍入库（历史显示「未送达」），不会丢失。</p>`,
    },
    {
      id: '02', label: 'POST 推送（推荐）', sub: 'JSON / 表单 / 纯文本三种请求体',
      html: `
        <p class="hint">POST <code>${API_BASE}/hook/&lt;KEY&gt;</code>，支持三种请求体：<b>JSON</b>、<b>表单</b>（application/x-www-form-urlencoded）、<b>纯文本</b>（直接作为通知内容）。JSON 最常用：</p>
        ${code(2)}
        ${code(3)}
        ${code(4)}
        <div class="table-wrap"><table class="doc-params">
          <thead><tr><th>参数</th><th>说明</th></tr></thead>
          <tbody>
            <tr><td><code>message</code></td><td>通知内容（最长 8000 字符）</td></tr>
            <tr><td><code>dedup_key</code></td><td>可选。显式防重 key：5 分钟窗口内相同 key 只推送一次（用于调用方超时重试场景）。不传则服务端自动生成唯一 key，消息不做内容去重</td></tr>
          </tbody>
        </table></div>
        <p class="hint" style="margin-top:12px"><b>不需要传 title</b>：通知标题固定为 key 的名称，任何模式下都不会被请求参数覆盖。</p>
        <p class="hint">表单模式下参数相同；防重 key 也可放在请求头 <code>X-Dedup-Key</code> 中。GET 与 POST 语义一致，仅 GET 用查询串传参。</p>`,
    },
    {
      id: '03', label: '自定义模式 · 模板解析', sub: '把结构化 JSON 渲染成一句话',
      html: `
        <p class="hint">在「Key 管理 → 右栏 → 推送模式」里把 key 切为「自定义模板」后，message 不再原样发送，而是作为<b>模板</b>：<code>$&#123;字段&#125;</code> 占位符会用 JSON 数据里的对应字段填充。适合监控、CI 等推送结构化 JSON 的场景。</p>
        ${code(5)}
        <p class="hint">路径语法：点分路径、数组用下标（<code>$&#123;event.alerts.0.name&#125;</code>），取不到的字段替换为空串。也可以在「Key 管理 → 配置 → 消息模板」里给 key 配一个固定模板，调用方不传 message 时自动用它渲染；两者都没有时，整个 JSON 会直接作为通知内容触达，调用方无需任何改造。</p>`,
    },
    {
      id: '04', label: '响应与防重', sub: '怎么判断调用成功了',
      html: `
        ${code(6)}
        <p class="hint" style="margin-top:8px"><b>防重语义</b>：服务端默认每条消息互不重复（不做内容去重）。只有当调用方显式传了 <code>dedup_key</code> 时才做去重——适合「发送超时后重试」的场景，避免重试导致重复弹通知。</p>`,
    },
  ];
}

function renderDocs() {
  const view = $('#view-docs');
  view.innerHTML = `
    ${pageHead({
      eyebrow: 'Docs · 接入指南',
      title: '接入文档',
      sub: '四种接入姿势：浏览器地址栏、curl、任意语言、以及带模板解析的结构化 JSON。全部只需一个 key。<b>左侧选章节，右侧读全文。</b>',
    })}
    ${splitShell({ id: 'docs', drill: false, kicker: '章节目录' })}`;
  paintDocs();
}

function paintDocs() {
  const list = $('#docs-list');
  const chapters = docChapters();
  if (!chapters.some((c) => c.id === S.sel.docs)) S.sel.docs = chapters[0].id;
  if (list) {
    list.innerHTML = chapters.map((c) => `
      <button type="button" class="item ${S.sel.docs === c.id ? 'on' : ''}" data-sel="${c.id}">
        <span class="item-top">
          <span class="idx">${esc(c.id)}</span>
          <span class="item-name">${esc(c.label)}</span>
        </span>
        <span class="item-sub">${esc(c.sub)}</span>
      </button>`).join('');
    list.querySelectorAll('[data-sel]').forEach((b) => { b.onclick = () => select('docs', b.dataset.sel); });
  }
  paintDocDetail();
}

function paintDocDetail() {
  const box = $('#docs-detail');
  if (!box) return;
  const c = docChapters().find((x) => x.id === S.sel.docs) || docChapters()[0];
  box.innerHTML = `
    ${detailHead({ kicker: `章节 ${c.id}`, name: c.label, back: false })}
    <div class="pane-body">${c.html}</div>`;
  bindCopies(box);
}

/* ======================== 账号（目录式左右分栏） ======================== */

const ACCT_ITEMS = [
  { id: 'pw', label: '修改密码', sub: '更换登录密码' },
  { id: 'conf', label: '配置信息', sub: 'Webhook 地址与调用方式' },
];

function renderAccount() {
  const view = $('#view-acct');
  view.innerHTML = `
    ${pageHead({
      eyebrow: 'Account · 安全与配置',
      title: '账号',
      sub: '修改登录密码，并查看当前控制台指向的 API 地址。<b>左侧选一项，右侧直接看。</b>',
    })}
    ${splitShell({ id: 'acct', drill: false, kicker: '账号设置' })}`;
  paintAcct();
}

function paintAcct() {
  const list = $('#acct-list');
  if (!ACCT_ITEMS.some((x) => x.id === S.sel.acct)) S.sel.acct = ACCT_ITEMS[0].id;
  if (list) {
    list.innerHTML = ACCT_ITEMS.map((x) => `
      <button type="button" class="item ${S.sel.acct === x.id ? 'on' : ''}" data-sel="${x.id}">
        <span class="item-top"><span class="item-name">${esc(x.label)}</span></span>
        <span class="item-sub">${esc(x.sub)}</span>
      </button>`).join('');
    list.querySelectorAll('[data-sel]').forEach((b) => { b.onclick = () => select('acct', b.dataset.sel); });
  }
  paintAcctDetail();
}

function paintAcctDetail() {
  const box = $('#acct-detail');
  if (!box) return;
  const item = ACCT_ITEMS.find((x) => x.id === S.sel.acct) || ACCT_ITEMS[0];

  if (item.id === 'conf') {
    box.innerHTML = `
      ${detailHead({ kicker: '账号', name: item.label, back: false })}
      <div class="pane-body">
        <dl class="kv">
          <dt>API 地址</dt><dd><code>${esc(API_BASE)}</code></dd>
          <dt>Webhook</dt><dd><code>${esc(API_BASE)}/hook/&lt;KEY&gt;</code></dd>
          <dt>请求方法</dt><dd><code>GET</code> 或 <code>POST</code>（JSON / 表单 / 纯文本均可）</dd>
        </dl>
        <p class="hint xs" style="margin-top:14px">默认调用只需传 message 参数（标题固定为 key 名称）。详见「接入文档」。</p>
      </div>`;
    return;
  }

  box.innerHTML = `
    ${detailHead({ kicker: '账号', name: item.label, back: false })}
    <div class="pane-body">
      <form id="pw-form" style="max-width:420px">
        <label class="field"><span class="label">原密码</span>
          <input name="oldPassword" type="password" placeholder="原密码" autocomplete="current-password" required />
        </label>
        <label class="field"><span class="label">新密码</span>
          <input name="newPassword" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" required />
        </label>
        ${footHtml('pw-msg')}
      </form>
    </div>`;

  const form = box.querySelector('#pw-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const F = form.elements;
    setFoot('pw-msg', '');
    try {
      await api.changePassword(F.oldPassword.value, F.newPassword.value);
      setFoot('pw-msg', '密码已更新', true);
      toast('密码已更新', 'ok');
      form.reset();
    } catch (err) { setFoot('pw-msg', err.message); }
  };
}

/* ======================== 发送历史（右栏内联 + 分页 + 清空） ======================== */

// 通用历史面板：keyId = 外部 key 的写入记录；jobId = 定时任务的触发记录。
// 两者在数据上互斥（key 通知的 job_id 为空，job 通知的 key_id 为空），所以清空也各清各的。
// onCleared：清空成功后回调，让调用方刷新列表上的「已发 N 条」。
async function mountHistory(box, { keyId, jobId, title, emptyText, onCleared }) {
  if (!box) return;
  const isJob = !!jobId;
  const rawLabel = isJob ? '触发信息' : '原文';
  const rawTitle = isJob ? '触发详情' : '原始请求参数';
  let page = 0;
  let total = 0;

  box.innerHTML = `
    <details class="legend" open>
      <summary>状态说明</summary>
      <p class="hint xs"><b class="ok">已送达</b> = 已成功推送到 QQ；<b class="warn">未送达</b> = 推送失败（凭证未配置 / 网关异常），消息仍在，修复后不会自动重发；<b class="rej">停用拒绝</b> = key 已停用，调用被拒绝且未推送。悬停「${esc(rawLabel)}」列可查看该条通知的完整原始数据。</p>
    </details>
    <div id="hist-body">${skeletonRows(3)}</div>
    <div class="pane-foot" id="hist-pager">
      <span class="hint xs" id="hist-total"></span>
      <span class="row-inline">
        <button class="btn mini danger" id="hist-clear" type="button">清空</button>
        <button class="btn mini" id="hist-prev" type="button">← 上一页</button>
        <button class="btn mini" id="hist-next" type="button">下一页 →</button>
      </span>
    </div>`;

  const q = (sel) => box.querySelector(sel);

  async function loadPage() {
    const body = q('#hist-body');
    if (!body) return;
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
      bodyHtml: `确定清空 ${title} 的 <b>${cleared} 条</b>记录？清空后不可恢复。`,
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

// 每页的「重画左列表 + 右详情」，供 select() 统一调度
const PAINT = {
  keys: paintKeys,
  jobs: paintJobs,
  bots: paintBots,
  docs: paintDocs,
  acct: paintAcct,
};

// 令牌失效（服务端 401）时退出到登录页，而不是留一个点不动的界面
window.addEventListener('nh:unauthorized', () => {
  if (!isLoggedIn()) return;
  setToken(null);
  authView();
  toast('登录已过期，请重新登录', 'err');
});

if (isLoggedIn()) mainView(); else authView();
