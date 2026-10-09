#!/usr/bin/env node
/* Notify Hub 控制台 —— 前端验收 / 防回归
   ---------------------------------------------------------------
   为什么要有它：pages/ 是纯静态、无构建、无框架的前端，没有 jest/vitest 可用；
   只靠"读代码判断没问题"曾漏掉过多起真实缺陷（弹出菜单被下一行盖住、
   表格列全折行、`[hidden]` 压不住自带 display 的容器……）。
   本脚本用 CDP 驱动真实 Chrome，在 375/768/1440 三档下逐页截图并断言。

   零依赖：只用 Node 22 自带的 fetch / WebSocket / node:http。

   用法：
     node tools/verify-ui.mjs                 # 默认三档全跑
     node tools/verify-ui.mjs 375             # 只跑某一档（375 | 768 | 1440）
     CHROME=/path/to/chrome node tools/verify-ui.mjs   # 指定浏览器

   退出码：0 = 全部通过；1 = 有断言失败或页面报错。可直接接进 CI。
   截图落在系统临时目录，路径会打印在报告里。
*/
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PAGES = join(ROOT, 'pages');
const OUT = join(tmpdir(), 'notify-hub-ui-verify');
// 端口不写死：本机常年挂着 `python -m http.server 8123` 预览，写死会 EADDRINUSE
let PORT = 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.jsonc': 'application/json',
};

/* ---------------- 静态服务（模块脚本与字体都必须走 HTTP） ---------------- */
async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = join(PAGES, normalize(rel === '/' ? '/index.html' : rel));
      if (!file.startsWith(PAGES)) { res.writeHead(403).end(); return; }
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch { res.writeHead(404).end('not found'); }
  });
  // 从 8123 起挑第一个空闲端口，占用了就 +1
  for (let p = PORT; p < PORT + 50; p++) {
    const ok = await new Promise((r) => {
      const onErr = () => { server.removeListener('listening', onOk); r(false); };
      const onOk = () => { server.removeListener('error', onErr); r(true); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    });
    if (ok) { PORT = p; return server; }
  }
  throw new Error(`端口 ${PORT}~${PORT + 49} 全部被占用`);
}

/* ---------------- 假数据：在页面加载前替换 fetch ---------------- */
const MOCK = `
(() => {
  const T0 = 1757200000000;
  const KEYS = [
    { id: 5, name: '服务器告警', key: 'nh_9f2c', keyFull: 'nh_9f2c4a7b1e8d', active: true,  mode: 'default', last_used: T0 - 3600e3, bot_id: 1, bot_name: '私人机器人' },
    { id: 6, name: 'CI 构建完成', key: 'nh_ab31', keyFull: 'nh_ab31de90c4f5', active: true,  mode: 'custom', last_used: null, bot_id: null, bot_name: null },
    { id: 7, name: '临时调试用', key: 'nh_77aa', keyFull: 'nh_77aa02ff19be', active: false, mode: 'default', last_used: T0 - 86400e3 * 6, bot_id: 2, bot_name: '运维机器人' }
  ];
  const JOBS = [
    { id: 1, name: '每日签到提醒', body: '', schedule: 'daily:09:00', desc: '每天 09:00', enabled: true, tz: '+08:00', next_run_at: T0 + 5400e3, last_run_at: T0 - 81000e3, sent_count: 42, skip_holiday: true, bot_id: 2, bot_name: '运维机器人' },
    { id: 2, name: '服务器巡检', body: '检查磁盘与内存占用，超过阈值立即告警', schedule: 'every:2h', desc: '每 2 小时', enabled: true, tz: '+08:00', next_run_at: T0 + 1800e3, last_run_at: T0 - 5400e3, sent_count: 118, bot_id: null, bot_name: null },
    { id: 3, name: '周报提醒', body: '', schedule: 'weekly:5,18:00', desc: '每周五 18:00', enabled: false, tz: '+08:00', next_run_at: null, last_run_at: T0 - 200000e3, sent_count: 7, bot_id: null, bot_name: null }
  ];
  // 多机器人（账号隔离）：一个默认 + 一个普通，覆盖「设为默认」「测试连接」等分支
  const BOTS = [
    { id: 1, name: '私人机器人', app_id: '102839471', has_secret: true, secret_masked: '••••••a91f',
      target: 'c2c', msg_template: '', is_default: true,
      group_openids: [], user_openids: ['9F3E5D7C1B2A4039281F6E5D4C3B2A10'],
      callback_url: 'https://notify-hub.example.com/api/qq/callback' },
    { id: 2, name: '运维机器人', app_id: '102839599', has_secret: false, secret_masked: '',
      target: 'both', msg_template: '{title}\\n{body}', is_default: false,
      group_openids: ['8A1B2C3D4E5F60718293A4B5C6D7E8F9', 'C7D2E3F4A5B60718293A4B5C6D7E8F90'],
      user_openids: [],
      callback_url: 'https://notify-hub.example.com/api/qq/callback' }
  ];
  const BOTS_RESP = { bots: BOTS, max: 10, default_msg_template: '{title}\\n{body}\\n{time}' };
  const NOTIFS = [1, 2, 3, 4, 5].map((i) => ({
    id: 70 + i, title: i % 2 ? '服务器告警' : 'CI 构建完成',
    body: i === 3 ? '' : (i % 2 ? 'CPU 使用率超过 90%（当前 94.2%），已持续 5 分钟' : 'build #' + (4100 + i) + ' 构建成功，用时 3 分 12 秒'),
    created_at: T0 - i * 5400e3, delivered_at: i === 4 ? null : T0 - i * 5400e3 + 1200,
    rejected: i === 5,
    payload: JSON.stringify({ message: 'CPU 使用率超过 90%', host: 'prod-web-03', value: 94.2 })
  }));
  const ok = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const path = u.includes('/api') ? u.split('/api')[1].split('?')[0] : u;
    const m = (opts.method || 'GET').toUpperCase();
    if (path === '/keys' && m === 'GET') return ok({ keys: KEYS });
    if (path === '/jobs' && m === 'GET') return ok({ jobs: JOBS });
    if (path === '/bots' && m === 'GET') return ok(BOTS_RESP);
    // 机器人的增改删/测试：统一回一个成功壳，够前端走完流程即可
    if (path.startsWith('/bots')) return ok({ ok: true, bot: BOTS[0] });
    if (path === '/notifications') return ok({ notifications: NOTIFS, total: 23 });
    if (m !== 'GET') return ok({ ok: true, id: 99, next_run_at: T0 + 86400e3, deleted: 23 });
    return ok({});
  };
  try { localStorage.setItem('nh_token', 'mock-token'); } catch (e) {}
})();`;

const MOCK_NOAUTH = `
(() => {
  window.fetch = async () => new Response('{}', { status: 200 });
  try { localStorage.removeItem('nh_token'); } catch (e) {}
})();`;

/* 对比度实测：取真实计算色，沿祖先链合成背景，按 WCAG 算比值 */
const CONTRAST_FN = `
window.__nhContrast = () => {
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const bgOf = (el) => { let n = el, acc = null;
    while (n && n !== document.documentElement) { const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { acc = acc ? over(acc, c) : c; if (acc.a >= 0.999) return acc; } n = n.parentElement; }
    return acc || { r: 255, g: 255, b: 255, a: 1 }; };
  const pairs = [
    ['.page-head h1', 'H1'], ['.page-head .eyebrow', 'eyebrow 微标签'], ['.page-head .sub', '标题副文案'],
    ['.stat .l', '统计标签'], ['.card .hint', '卡片说明'], ['.row-item .row-meta', '行内元信息'],
    ['.row-item .row-key', 'key 地址'], ['.badge.on', '徽章·启用中'], ['.badge.off', '徽章·已停用'],
    ['.badge.mode', '徽章·模式'], ['.topnav button.active', '顶栏当前项'],
    ['.topnav button:not(.active)', '顶栏其它项'], ['.btn.primary', '主按钮文字'], ['code', '行内代码'],
  ];
  return Object.fromEntries(pairs.map(([sel, label]) => {
    const el = document.querySelector(sel);
    if (!el) return [label, null];
    const fg = parse(getComputedStyle(el).color), bg = bgOf(el);
    return [label, Math.round(ratio(fg.a < 1 ? over(fg, bg) : fg, bg) * 100) / 100];
  }));
};`;

/* ---------------- 找 Chrome ---------------- */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cands = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) || null;
}

/* ---------------- CDP 客户端 ---------------- */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.warnings = []; }
  static async attach(port) {
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch {}
      await sleep(250);
    }
    if (!target) throw new Error('Chrome CDP 未就绪');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new Cdp(ws);
  }
  init() {
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        const line = m.params.type.toUpperCase() + ': ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
        (m.params.type === 'error' ? this.errors : this.warnings).push(line);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.errors.push('LOG: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 20000);
    });
  }
}

/* ---------------- 单档跑一遍 ---------------- */
async function run(width, height, tag, cdp) {
  const c = cdp;
  const R = {};
  const screens = [];
  const ev = async (expression) => {
    const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };

  await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  // 只设 deviceMetrics.mobile 不会让 (pointer: coarse) 命中，必须显式开触摸仿真
  if (width < 700) await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  else await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // 注入脚本会累积：换身份前必须摘掉旧的，否则上一轮的 token 状态会盖住这一轮
  let stubId = null;
  const setStub = async (auth) => {
    if (stubId) { await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubId }); stubId = null; }
    stubId = (await c.send('Page.addScriptToEvaluateOnNewDocument', { source: auth ? MOCK : MOCK_NOAUTH })).identifier;
  };
  const goto = async (auth, hash = '') => {
    await setStub(auth);
    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${hash}` });
    await sleep(950);
  };
  const settle = async () => { await ev(`document.getAnimations().forEach(a => { try { a.finish(); } catch (e) {} }); true`); await sleep(120); };
  const shoot = async (name) => {
    await settle();
    const { data } = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const f = join(OUT, `${tag}-${name}.png`);
    await writeFile(f, Buffer.from(data, 'base64'));
    screens.push(f);
  };

  /* --- 登录页 --- */
  await goto(false);
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: CONTRAST_FN });
  R['登录页标题'] = await ev(`document.querySelector('.auth-art h1')?.innerText.replace(/\\n/g, ' ')`);
  R['登录表单存在'] = await ev(`!!document.querySelector('#auth-form input[name=username]')`);
  // 设计契约：≤860px 单列并隐藏墨色展示板；>860px 双栏。断言必须随宽度走，
  // 不能笼统要求"单列"——那会把桌面端正确的两栏判成失败。
  const narrow = width <= 860;
  R['登录页栅格'] = await ev(`(() => { const n = getComputedStyle(document.querySelector('.auth')).gridTemplateColumns.split(' ').length;
    const artShown = getComputedStyle(document.querySelector('.auth-art')).display !== 'none';
    return n + '栏/' + (artShown ? '展示板在' : '展示板隐藏'); })()`);
  R[narrow ? '登录页窄屏单列+隐藏展示板' : '登录页宽屏两栏+展示板在'] =
    R['登录页栅格'] === (narrow ? '1栏/展示板隐藏' : '2栏/展示板在');
  R['登录页无横向溢出'] = await ev(`document.documentElement.scrollWidth - window.innerWidth`);
  await shoot('01-login');

  /* --- 六个视图 --- */
  await goto(true);
  for (const [tab, name] of [['keys', '02-keys'], ['jobs', '04-jobs'], ['qqbot', '06-qqbot'], ['docs', '07-docs'], ['acct', '08-account']]) {
    await ev(`document.querySelector('[data-tab=${tab}]').click(); true`);
    await sleep(800);
    await settle();
    R[`${tab} · 卡片数`] = await ev(`document.querySelectorAll('#view-${tab} .card').length`);
    // 排除 .lamp：信号灯是无限脉动动画，opacity<1 是它的正常状态
    R[`${tab} · 入场卡在 opacity<1 的元素`] = await ev(`
      Array.from(document.querySelectorAll('#view-${tab} *')).filter((el) => {
        if (el.classList.contains('lamp')) return false;
        const s = getComputedStyle(el);
        return s.opacity !== '1' && el.offsetParent !== null && !el.hidden;
      }).length`);
    R[`${tab} · 横向溢出 px`] = await ev(`document.documentElement.scrollWidth - window.innerWidth`);
    await shoot(name);
  }

  /* --- 多机器人：卡片、名单芯片、Key/任务行上的「推送机器人」 --- */
  await ev(`document.querySelector('[data-tab=qqbot]').click(); true`);
  await sleep(800);
  R['机器人 · 卡片数'] = await ev(`document.querySelectorAll('#view-qqbot .card').length`);
  R['机器人 · 名单芯片数'] = await ev(`document.querySelectorAll('#view-qqbot .bind-chip').length`);
  R['机器人 · 默认徽章数'] = await ev(`document.querySelectorAll('#view-qqbot .badge.on').length`);
  R['机器人 · 新建按钮可用'] = await ev(`!document.querySelector('#btn-new-bot').disabled`);
  R['机器人 · 回调地址已填'] = await ev(`(document.querySelector('#view-qqbot [data-copy]')?.dataset.copy || '').includes('/api/qq/callback')`);
  await ev(`document.querySelector('[data-tab=keys]').click(); true`);
  await sleep(800);
  R['Key 行 · 显示推送机器人'] = await ev(`document.querySelector('#key-list .row-meta').textContent.replace(/\\s+/g, ' ').trim()`);

  /* --- 行内操作菜单：必须盖在后面的行上 --- */
  await ev(`document.querySelector('[data-tab=keys]').click(); true`);
  await sleep(800);
  await ev(`document.querySelector('[data-more]').click(); true`);
  await sleep(400);
  R['菜单 · 按钮数'] = await ev(`document.querySelector('.key-menu')?.children.length`);
  R['菜单 · 是否被遮挡'] = await ev(`
    (() => { const m = document.querySelector('.key-menu'); const r = m.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return m.contains(hit) ? '否' : '是（命中 ' + hit.className + '）'; })()`);
  R['菜单 · 宿主行 z-index'] = await ev(`getComputedStyle(document.querySelector('.row-item.menu-open')).zIndex`);
  R['菜单 · 按钮在视口内'] = await ev(`
    (() => { const m = document.querySelector('.key-menu'); const r = m.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight; })()`);
  await shoot('03-keys-menu');

  /* --- 弹层叠加 / ESC / 滚动锁 --- */
  await ev(`Array.from(document.querySelectorAll('.key-menu button')).find(b => b.textContent.includes('发送历史')).click(); true`);
  await sleep(900);
  R['弹层 · 历史宽度'] = await ev(`Math.round(document.querySelector('.modal').getBoundingClientRect().width)`);
  R['弹层 · 历史行数'] = await ev(`document.querySelectorAll('#hist-body tbody tr').length`);
  R['弹层 · 标题列未折行'] = await ev(`(() => { const d = document.querySelector('#hist-body tbody td .ellipsis'); return d.scrollWidth <= d.clientWidth + 1; })()`);
  R['弹层 · 时间列未折行'] = await ev(`(() => { const td = document.querySelectorAll('#hist-body tbody tr')[0].children[2];
    return getComputedStyle(td).whiteSpace === 'nowrap' && td.scrollWidth <= td.clientWidth + 1; })()`);
  R['弹层 · 滚动锁'] = await ev(`document.body.style.overflow`);
  await ev(`document.querySelector('#hist-clear').click(); true`);
  await sleep(500);
  R['弹层 · 叠加层级数'] = await ev(`document.querySelectorAll('.modal-mask').length`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(400);
  R['弹层 · ESC 后层级数'] = await ev(`document.querySelectorAll('.modal-mask').length`);
  R['弹层 · ESC 后下层仍在'] = await ev(`!!document.querySelector('#hist-body tbody')`);
  await shoot('09-history');
  await ev(`document.querySelector('#hist-close').click(); true`);
  await sleep(400);
  R['弹层 · 全关后滚动锁释放'] = await ev(`document.body.style.overflow || '(已释放)'`);

  /* --- 表单：取值走 elements、[hidden] 生效、校验分支 --- */
  await ev(`document.querySelector('[data-tab=jobs]').click(); true`);
  await sleep(700);
  await ev(`document.querySelectorAll('[data-edit]')[1].click(); true`);
  await sleep(600);
  R['表单 · elements.name 类型'] = await ev(`document.querySelector('#job-form').elements.name.tagName`);
  R['表单 · 读出现有任务名'] = await ev(`document.querySelector('#job-form').elements.name.value`);
  R['表单 · 编辑态预览'] = await ev(`document.querySelector('#job-preview').textContent`);
  // 第 2 个任务未绑定机器人 → 下拉应默认落在「跟随默认机器人」，共 1 + 2 项
  R['表单 · 任务推送机器人下拉项数'] = await ev(`document.querySelector('#job-form [name=bot_id]')?.options.length`);
  R['表单 · 任务机器人当前值'] = await ev(`JSON.stringify(document.querySelector('#job-form [name=bot_id]')?.value)`);
  R['表单 · 间隔型可见字段数'] = await ev(`Array.from(document.querySelectorAll('#job-form .job-fields')).filter(d => !d.hidden).length`);
  await ev(`(() => { const F = document.querySelector('#job-form').elements; F.kind.value = 'weekly'; F.kind.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(300);
  R['表单 · 切每周可见字段数'] = await ev(`Array.from(document.querySelectorAll('#job-form .job-fields')).filter(d => !d.hidden).length`);
  R['表单 · 切每周预览'] = await ev(`document.querySelector('#job-preview').textContent`);
  // 空间隔才会进 JS 校验分支（填 0 会被 min=1 的原生校验先拦下）
  await ev(`(() => { const F = document.querySelector('#job-form').elements; F.kind.value = 'every';
    F.kind.dispatchEvent(new Event('change')); F.n.value = ''; F.name.value = 'x';
    document.querySelector('#job-form').requestSubmit(); return true; })()`);
  await sleep(400);
  R['表单 · JS 校验文案'] = await ev(`document.querySelector('#job-msg').textContent`);
  await ev(`document.querySelectorAll('.modal-mask [data-cancel]').forEach(b => b.click()); true`);
  await sleep(400);

  await ev(`document.querySelectorAll('[data-more]')[1].click(); true`);
  await sleep(300);
  await ev(`Array.from(document.querySelectorAll('.key-menu button')).find(b => b.textContent.includes('编辑')).click(); true`);
  await sleep(600);
  R['表单 · 自定义模式模板可见'] = await ev(`document.querySelector('#tpl-fields').offsetParent !== null`);
  R['表单 · Key 推送机器人下拉项数'] = await ev(`document.querySelector('#edit-form [name=bot_id]')?.options.length`);
  R['表单 · Key 机器人当前值'] = await ev(`JSON.stringify(document.querySelector('#edit-form [name=bot_id]')?.value)`);
  await ev(`document.querySelector('#edit-form input[value=default]').click(); true`);
  await sleep(300);
  R['表单 · 切默认后模板隐藏'] = await ev(`document.querySelector('#tpl-fields').offsetParent === null`);
  await ev(`document.querySelectorAll('.modal-mask [data-cancel]').forEach(b => b.click()); true`);
  await sleep(400);

  /* --- 字体、命中区、对比度 --- */
  await ev(`document.querySelector('[data-tab=keys]').click(); true`);
  await sleep(800);
  R['字体 · Archivo 已加载'] = await ev(`document.fonts.check('800 24px Archivo')`);
  R['字体 · IBM Plex Sans 已加载'] = await ev(`document.fonts.check('400 14px "IBM Plex Sans"')`);
  R['字体 · IBM Plex Mono 已加载'] = await ev(`document.fonts.check('400 12px "IBM Plex Mono"')`);
  R['命中 · ⋯ 按钮尺寸'] = await ev(`(() => { const r = document.querySelector('.row-more').getBoundingClientRect();
    return Math.round(r.width) + 'x' + Math.round(r.height); })()`);
  R['命中 · 顶栏按钮高'] = await ev(`Math.round(document.querySelector('.topnav button').getBoundingClientRect().height)`);
  R['品牌 · 标记为内联 SVG'] = await ev(`document.querySelector('.brand .mark svg')?.querySelectorAll('rect').length`);
  const contrast = await ev(`window.__nhContrast()`);
  R['对比度 · 最低值'] = Math.min(...Object.values(contrast).filter((v) => typeof v === 'number'));
  R['对比度 · 明细'] = contrast;

  /* --- 降级动效 --- */
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await goto(true);
  await sleep(400);
  R['降级 · 入场元素立即可见'] = await ev(`
    Array.from(document.querySelectorAll('#view-keys .card, #view-keys .row-item, .page-head'))
      .every((el) => getComputedStyle(el).opacity === '1')`);
  await shoot('12-reduced-motion');
  await c.send('Emulation.setEmulatedMedia', { features: [] });

  return { R, screens };
}

/* ---------------- 主流程 ---------------- */
const chrome = findChrome();
if (!chrome) { console.error('找不到 Chrome/Edge，请用 CHROME=/path/to/chrome 指定'); process.exit(1); }

await mkdir(OUT, { recursive: true });
const server = await serve();
const cdpPort = 9333;
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', `--user-data-dir=${join(OUT, 'profile')}`, 'about:blank',
], { stdio: 'ignore' });
const kill = () => { try { execFileSync(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32' ? ['/PID', String(proc.pid), '/T', '/F'] : ['-TERM', String(proc.pid)], { stdio: 'ignore' }); } catch {} };
process.on('exit', kill);

let failed = 0;
try {
  const cdp = await Cdp.attach(cdpPort);
  cdp.init();
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');

  const only = process.argv[2];
  const sizes = [[375, 812, 'mobile'], [768, 1024, 'tablet'], [1440, 1000, 'desktop']]
    .filter(([w, , tag]) => !only || String(w) === only || tag === only);

  for (const [w, h, tag] of sizes) {
    const { R, screens } = await run(w, h, tag, cdp);
    console.log(`\n═══ ${tag} ${w}x${h} ═══`);
    for (const [k, v] of Object.entries(R)) {
      if (k === '对比度 · 明细') continue;
      const bad = v === false || v === null;
      console.log(`  ${bad ? '✗' : '·'} ${k}: ${JSON.stringify(v)}`);
      if (bad) failed++;
    }
    const detail = R['对比度 · 明细'] || {};
    const low = Object.entries(detail).filter(([, v]) => typeof v === 'number' && v < 4.5);
    console.log(`  ${low.length ? '✗' : '·'} 对比度低于 4.5 的项: ${low.length ? JSON.stringify(low) : '无'}`);
    if (low.length) failed++;
    const overflow = Object.entries(R).filter(([k, v]) => /横向溢出/.test(k) && v !== 0);
    if (overflow.length) { console.log(`  ✗ 横向溢出: ${JSON.stringify(overflow)}`); failed++; }
    const stuck = Object.entries(R).filter(([k, v]) => /入场卡在/.test(k) && v !== 0);
    if (stuck.length) { console.log(`  ✗ 入场动效卡住: ${JSON.stringify(stuck)}`); failed++; }
    if (cdp.errors.length) { console.log('  ✗ 控制台报错:\n    ' + cdp.errors.join('\n    ')); failed += cdp.errors.length; }
    console.log(`  截图 ${screens.length} 张 → ${OUT}`);
    cdp.errors.length = 0; cdp.warnings.length = 0;
  }
} catch (e) {
  console.error('验收脚本自身失败:', e.message);
  failed++;
}

kill(); server.close();
console.log(failed ? `\n结果：${failed} 项未通过` : '\n结果：全部通过');
process.exit(failed ? 1 : 0);
