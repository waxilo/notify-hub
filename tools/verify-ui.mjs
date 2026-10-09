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

/* ---------------- 假数据：在页面加载前替换 fetch ----------------
   写操作要真的改动内存里的数组 —— 否则"新建后应选中新条目"这类断言
   会在一个永远查不到新 id 的假服务端上静默走偏。 */
const MOCK = `
(() => {
  const T0 = 1757200000000;
  const KEYS = [
    { id: 5, name: '服务器告警', key: 'nh_9f2c', keyFull: 'nh_9f2c4a7b1e8d', active: true,  mode: 'default', template: '', last_used: T0 - 3600e3, bot_id: 1, bot_name: '私人机器人' },
    { id: 6, name: 'CI 构建完成', key: 'nh_ab31', keyFull: 'nh_ab31de90c4f5', active: true,  mode: 'custom', template: '', last_used: null, bot_id: null, bot_name: null },
    { id: 7, name: '临时调试用', key: 'nh_77aa', keyFull: 'nh_77aa02ff19be', active: false, mode: 'default', template: '', last_used: T0 - 86400e3 * 6, bot_id: 2, bot_name: '运维机器人' }
  ];
  const JOBS = [
    { id: 1, name: '每日签到提醒', body: '', schedule: 'daily:09:00', desc: '每天 09:00', enabled: true, tz: '+08:00', next_run_at: T0 + 5400e3, last_run_at: T0 - 81000e3, sent_count: 42, skip_holiday: true, bot_id: 2, bot_name: '运维机器人' },
    { id: 2, name: '服务器巡检', body: '检查磁盘与内存占用，超过阈值立即告警', schedule: 'every:2h', desc: '每 2 小时', enabled: true, tz: '+08:00', next_run_at: T0 + 1800e3, last_run_at: T0 - 5400e3, sent_count: 118, skip_holiday: false, bot_id: null, bot_name: null },
    { id: 3, name: '周报提醒', body: '', schedule: 'weekly:5,18:00', desc: '每周五 18:00', enabled: false, tz: '+08:00', next_run_at: null, last_run_at: T0 - 200000e3, sent_count: 7, skip_holiday: false, bot_id: null, bot_name: null }
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
    let body = {};
    try { body = opts.body ? JSON.parse(opts.body) : {}; } catch (e) { body = {}; }

    if (path === '/keys' && m === 'GET') return ok({ keys: KEYS });
    if (path === '/keys' && m === 'POST') {
      const k = { id: 9, name: body.name || 'default', key: 'nh_new1', keyFull: 'nh_new1abc23d',
        active: true, mode: 'default', template: '', last_used: null, bot_id: null, bot_name: null };
      KEYS.unshift(k);
      return ok(k);
    }
    if (path === '/jobs' && m === 'GET') return ok({ jobs: JOBS });
    if (path === '/jobs' && m === 'POST') {
      const j = { id: 9, name: body.name || '新任务', body: body.body || '', schedule: body.schedule,
        desc: body.schedule, enabled: body.enabled !== false, tz: body.tz, next_run_at: T0 + 86400e3,
        last_run_at: null, sent_count: 0, skip_holiday: !!body.skip_holiday, bot_id: null, bot_name: null };
      JOBS.push(j);
      return ok(j);
    }
    if (path === '/bots' && m === 'GET') {
      return ok({ bots: BOTS, max: 10, default_msg_template: '{title}\\n{body}\\n{time}' });
    }
    if (path === '/bots' && m === 'POST') {
      const b = { id: 9, name: body.name || '新机器人', app_id: '', has_secret: false, secret_masked: '',
        target: 'c2c', msg_template: '', is_default: false, group_openids: [], user_openids: [],
        callback_url: 'https://notify-hub.example.com/api/qq/callback' };
      BOTS.push(b);
      return ok({ ok: true, bot: b });
    }
    // 机器人的改 / 删 / 测试 / 名单移除：统一回一个成功壳，够前端走完流程即可
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
    ['.stat .l', '统计标签'], ['.hint', '说明文案'], ['.hint.xs', '小号说明'],
    ['.item-meta', '列表项元信息'], ['.item-sub', '列表项次级信息'],
    ['.pane-kicker', '详情栏眉标'], ['.pane-count', '左栏计数'],
    ['.badge.on', '徽章·启用中'], ['.badge.off', '徽章·已停用'], ['.badge.mode', '徽章·模式'],
    ['.topnav button.active', '顶栏当前项'], ['.topnav button:not(.active)', '顶栏其它项'],
    ['.btn.primary', '主按钮文字'], ['.tab.on', '右栏当前页签'], ['code', '行内代码'],
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
  // 分栏断点：>980px 两栏并排，≤980px 单列钻取。凡断言涉及它就必须带宽度分支，
  // 否则会把桌面端正确的两栏判成失败（那是测法错，不是产品缺陷）。
  const twoCol = width > 980;
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
    // 全页截图不用 captureBeyondViewport：页面高于视口时它会把 position:sticky 的左列表
    // 整块漏画（截图上像"左列表空了"，实测几何 rect/offsetParent/opacity 却完全正常 ——
    // 对照组 A/B/C/D 里，只有"把视口临时拉到页高"这一种录得到真实布局）。
    // 截图是给人做视觉审查的，录不到元素就等于审查瞎掉，所以这里宁可多两次 setDeviceMetrics。
    const docH = await ev(`document.documentElement.scrollHeight`);
    const shotH = Math.min(Math.max(docH, height), 4000);
    await c.send('Emulation.setDeviceMetricsOverride', { width, height: shotH, deviceScaleFactor: 1, mobile: width < 700 });
    await sleep(120);
    const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
    const f = join(OUT, `${tag}-${name}.png`);
    await writeFile(f, Buffer.from(data, 'base64'));
    screens.push(f);
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
    await sleep(60);
  };
  const click = async (sel, ms = 500) => { await ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`); await sleep(ms); };
  const tab = async (id, ms = 800) => click(`[data-tab=${id}]`, ms);

  /* --- 登录页 --- */
  await goto(false);
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: CONTRAST_FN });
  R['登录页标题'] = await ev(`document.querySelector('.auth-art h1')?.innerText.replace(/\\n/g, ' ')`);
  R['登录表单存在'] = await ev(`!!document.querySelector('#auth-form input[name=username]')`);
  const narrow = width <= 860;
  R['登录页栅格'] = await ev(`(() => { const n = getComputedStyle(document.querySelector('.auth')).gridTemplateColumns.split(' ').length;
    const artShown = getComputedStyle(document.querySelector('.auth-art')).display !== 'none';
    return n + '栏/' + (artShown ? '展示板在' : '展示板隐藏'); })()`);
  R[narrow ? '登录页窄屏单列+隐藏展示板' : '登录页宽屏两栏+展示板在'] =
    R['登录页栅格'] === (narrow ? '1栏/展示板隐藏' : '2栏/展示板在');
  R['登录页无横向溢出'] = await ev(`document.documentElement.scrollWidth - window.innerWidth`);
  await shoot('01-login');

  /* --- 五个视图：分栏结构 + 无溢出 + 无卡住的入场动效 --- */
  await goto(true);
  for (const [id, name] of [['keys', '02-keys'], ['jobs', '04-jobs'], ['bots', '06-bots'], ['docs', '07-docs'], ['acct', '08-account']]) {
    await tab(id);
    await settle();
    const cols = await ev(`getComputedStyle(document.querySelector('#${id}-split')).gridTemplateColumns.split(' ').length`);
    R[`${id} · 分栏列数`] = cols;
    R[`${id} · ${twoCol ? '两栏并排' : '单列'}`] = cols === (twoCol ? 2 : 1);
    R[`${id} · 左列表条目数`] = await ev(`document.querySelectorAll('#${id}-list .item').length`);
    // 钻取型页面初始未选中 → 右栏是空态（.pane-body 里的 .empty），不是空白容器
    R[`${id} · 右栏已渲染`] = await ev(`!!document.querySelector('#${id}-detail .pane-body')`);
    // 弹窗与行内菜单这一版整体移除：任何页面都不该再出现
    R[`${id} · 弹层/行内菜单残留`] = await ev(`document.querySelectorAll('.modal-mask, .key-menu, .row-more').length`);
    // 排除 .lamp：信号灯是无限脉动动画，opacity<1 是它的正常状态
    R[`${id} · 入场卡在 opacity<1 的元素`] = await ev(`
      Array.from(document.querySelectorAll('#view-${id} *')).filter((el) => {
        if (el.classList.contains('lamp')) return false;
        const s = getComputedStyle(el);
        return s.opacity !== '1' && el.offsetParent !== null && !el.hidden;
      }).length`);
    R[`${id} · 横向溢出 px`] = await ev(`document.documentElement.scrollWidth - window.innerWidth`);
    await shoot(name);
  }

  /* --- Key：左列表 ⇄ 右详情（选中即出表单，不再有「⋯」菜单与弹窗） --- */
  await goto(true);
  R['Key · 初始未选中'] = await ev(`document.querySelectorAll('#keys-list .item.on').length`);
  await ev(`document.querySelectorAll('#keys-list .item')[1].click(); true`);
  await sleep(500);
  R['Key · 选中态唯一'] = await ev(`document.querySelectorAll('#keys-list .item.on').length`);
  R['Key · 详情标题'] = await ev(`document.querySelector('#keys-detail .pane-id b').textContent`);
  R['Key · 表单名回填'] = await ev(`document.querySelector('#key-form').elements.name.value`);
  R['Key · elements.name 类型'] = await ev(`document.querySelector('#key-form').elements.name.tagName`);
  R['Key · Hook 地址行'] = await ev(`document.querySelector('#keys-detail .cred code').textContent.includes('/hook/')`);
  // 第 2 个 key 是自定义模板 → 模板字段应可见
  R['Key · 自定义模式模板可见'] = await ev(`document.querySelector('#tpl-field').offsetParent !== null`);
  R['Key · 机器人下拉项数'] = await ev(`document.querySelector('#key-form [name=bot_id]')?.options.length`);
  R['Key · 机器人当前值'] = await ev(`JSON.stringify(document.querySelector('#key-form [name=bot_id]')?.value)`);
  await shoot('03-key-detail');
  await ev(`document.querySelector('#key-form input[value=default]').click(); true`);
  await sleep(300);
  R['Key · 切默认后模板隐藏'] = await ev(`document.querySelector('#tpl-field').offsetParent === null`);
  // 「发送历史」现在是右栏子页签，不再是弹窗
  await click('[data-ptab=hist]', 900);
  R['历史 · 行数'] = await ev(`document.querySelectorAll('#hist-body tbody tr').length`);
  R['历史 · 在右栏内而非弹层'] = await ev(`!!document.querySelector('#keys-detail #hist-body tbody') && document.querySelectorAll('.modal-mask').length === 0`);
  R['历史 · 标题列未折行'] = await ev(`(() => { const d = document.querySelector('#hist-body tbody td .ellipsis'); return d.scrollWidth <= d.clientWidth + 1; })()`);
  R['历史 · 时间列未折行'] = await ev(`(() => { const td = document.querySelectorAll('#hist-body tbody tr')[0].children[2];
    return getComputedStyle(td).whiteSpace === 'nowrap' && td.scrollWidth <= td.clientWidth + 1; })()`);
  await shoot('09-history');
  // 清空是不可逆操作 → 仍走二次确认弹层，且弹层要能叠在历史内容之上
  await click('#hist-clear', 500);
  R['历史 · 确认弹层层数'] = await ev(`document.querySelectorAll('.modal-mask').length`);
  R['历史 · 弹层出现后下层仍在'] = await ev(`!!document.querySelector('#hist-body tbody')`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(400);
  R['历史 · ESC 后层级数'] = await ev(`document.querySelectorAll('.modal-mask').length`);
  R['历史 · 滚动锁已释放'] = await ev(`document.body.style.overflow || '(已释放)'`);
  await click('[data-ptab=cfg]', 500);
  R['Key · 页签切回配置'] = await ev(`!!document.querySelector('#key-form')`);

  /* --- Key：新建走右栏草稿，生成后自动选中新条目 --- */
  await click('#keys-new', 500);
  R['Key 新建 · 草稿表单'] = await ev(`!!document.querySelector('#key-create-form')`);
  R['Key 新建 · 草稿标题'] = await ev(`document.querySelector('#keys-detail .pane-id b').textContent`);
  await ev(`(() => { const f = document.querySelector('#key-create-form'); f.elements.name.value = '冒烟测试'; f.requestSubmit(); return true; })()`);
  await sleep(900);
  R['Key 新建 · 生成后选中新条目'] = await ev(`document.querySelector('#keys-detail .pane-id b').textContent`);
  R['Key 新建 · 列表已含新条目'] = await ev(`document.querySelectorAll('#keys-list .item').length`);

  /* --- 定时任务：详情表单（取值走 elements、[hidden] 生效、校验分支） --- */
  await tab('jobs');
  await ev(`document.querySelectorAll('#jobs-list .item')[1].click(); true`);
  await sleep(500);
  R['任务 · 表单名回填'] = await ev(`document.querySelector('#job-form').elements.name.value`);
  R['任务 · elements.name 类型'] = await ev(`document.querySelector('#job-form').elements.name.tagName`);
  R['任务 · 编辑态预览'] = await ev(`document.querySelector('#job-preview').textContent`);
  R['任务 · 间隔型可见字段数'] = await ev(`Array.from(document.querySelectorAll('#job-form .job-fields')).filter(d => !d.hidden).length`);
  // 第 2 个任务未绑机器人 → 下拉应默认落在「跟随默认机器人」，共 1 + 2 项
  R['任务 · 机器人下拉项数'] = await ev(`document.querySelector('#job-form [name=bot_id]')?.options.length`);
  R['任务 · 机器人当前值'] = await ev(`JSON.stringify(document.querySelector('#job-form [name=bot_id]')?.value)`);
  await ev(`(() => { const F = document.querySelector('#job-form').elements; F.kind.value = 'weekly'; F.kind.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(300);
  R['任务 · 切每周可见字段数'] = await ev(`Array.from(document.querySelectorAll('#job-form .job-fields')).filter(d => !d.hidden).length`);
  R['任务 · 切每周预览'] = await ev(`document.querySelector('#job-preview').textContent`);
  await shoot('05-job-detail');
  // 空间隔才会进 JS 校验分支（填 0 会被 min=1 的原生校验先拦下）
  await ev(`(() => { const F = document.querySelector('#job-form').elements; F.kind.value = 'every';
    F.kind.dispatchEvent(new Event('change')); F.n.value = ''; F.name.value = 'x';
    document.querySelector('#job-form').requestSubmit(); return true; })()`);
  await sleep(400);
  R['任务 · JS 校验文案'] = await ev(`document.querySelector('#job-msg').textContent`);

  /* --- 机器人：详情表单 + 名单芯片 + 默认徽章随选中项变化 --- */
  await tab('bots');
  R['机器人 · 列表条目数'] = await ev(`document.querySelectorAll('#bots-list .item').length`);
  await ev(`document.querySelectorAll('#bots-list .item')[1].click(); true`);
  await sleep(500);
  R['机器人 · 详情名'] = await ev(`document.querySelector('#bots-detail .pane-id b').textContent`);
  R['机器人 · 名单芯片数'] = await ev(`document.querySelectorAll('#bots-detail .bind-chip').length`);
  R['机器人 · AppID 回填'] = await ev(`document.querySelector('#bot-form').elements.app_id.value`);
  R['机器人 · Secret 占位提示'] = await ev(`document.querySelector('#bot-form').elements.app_secret.placeholder`);
  R['机器人 · 非默认项带「设为默认」'] = await ev(`!!document.querySelector('#bots-detail [data-mkdefault]')`);
  R['机器人 · 回调地址已填'] = await ev(`(document.querySelector('#bots-detail [data-copy]')?.dataset.copy || '').includes('/api/qq/callback')`);
  await shoot('06-bots');
  await ev(`document.querySelectorAll('#bots-list .item')[0].click(); true`);
  await sleep(500);
  R['机器人 · 默认项标记'] = await ev(`document.querySelectorAll('#bots-detail .badge.on').length`);
  R['机器人 · 默认项无「设为默认」'] = await ev(`!document.querySelector('#bots-detail [data-mkdefault]')`);

  /* --- 接入文档：目录式分栏 --- */
  await tab('docs', 600);
  R['文档 · 目录条目数'] = await ev(`document.querySelectorAll('#docs-list .item').length`);
  R['文档 · 默认章节'] = await ev(`document.querySelector('#docs-detail .pane-id b').textContent`);
  await ev(`document.querySelectorAll('#docs-list .item')[2].click(); true`);
  await sleep(400);
  R['文档 · 切换后章节'] = await ev(`document.querySelector('#docs-detail .pane-id b').textContent`);
  R['文档 · 代码块数'] = await ev(`document.querySelectorAll('#docs-detail .doc-code').length`);
  // 复制按钮必须真的带上代码原文（这一章是模板 JSON，不含 /hook/，只校验载荷非空）
  R['文档 · 复制按钮挂着代码原文'] = await ev(`(() => {
    const b = document.querySelector('#docs-detail .doc-copy');
    return !!b && (b.dataset.copy || '').length > 20; })()`);

  /* --- 账号：目录式分栏 --- */
  await tab('acct', 600);
  R['账号 · 目录条目数'] = await ev(`document.querySelectorAll('#acct-list .item').length`);
  R['账号 · 默认条目'] = await ev(`document.querySelector('#acct-detail .pane-id b').textContent`);
  await ev(`document.querySelectorAll('#acct-list .item')[1].click(); true`);
  await sleep(400);
  R['账号 · 切到配置信息'] = await ev(`document.querySelector('#acct-detail .pane-id b').textContent`);
  R['账号 · 显示 API 地址'] = await ev(`document.querySelector('#acct-detail code').textContent`);

  /* --- 窄屏钻取：列表与详情互斥 + 返回键 --- */
  if (!twoCol) {
    await goto(true);
    await tab('keys', 800);
    R['钻取 · 初始只显示列表'] = await ev(`(() => {
      const l = document.querySelector('#keys-list').offsetParent !== null;
      const d = document.querySelector('#keys-detail').offsetParent !== null;
      return l && !d; })()`);
    await shoot('10-drill-list');
    await ev(`document.querySelectorAll('#keys-list .item')[0].click(); true`);
    await sleep(600);
    R['钻取 · 选中后只显示详情'] = await ev(`(() => {
      const l = document.querySelector('#keys-list').offsetParent !== null;
      const d = document.querySelector('#keys-detail').offsetParent !== null;
      return !l && d; })()`);
    R['钻取 · 返回按钮可见'] = await ev(`document.querySelector('#keys-detail .pane-back').offsetParent !== null`);
    await shoot('11-drill-detail');
    await click('#keys-detail .pane-back', 500);
    R['钻取 · 返回回到列表'] = await ev(`document.querySelector('#keys-list').offsetParent !== null && document.querySelector('#keys-detail').offsetParent === null`);
  }

  /* --- 字体、命中区、对比度（在「有详情」的状态下量，才量得到右栏的色） --- */
  await goto(true);
  await tab('keys', 800);
  await ev(`document.querySelectorAll('#keys-list .item')[0].click(); true`);
  await sleep(500);
  // 单一字体家族：展示字与正文共用 Instrument Sans（可变字体），等宽另算
  R['字体 · Instrument Sans 显示重已加载'] = await ev(`document.fonts.check('600 24px "Instrument Sans"')`);
  R['字体 · Instrument Sans 正文重已加载'] = await ev(`document.fonts.check('400 14px "Instrument Sans"')`);
  R['字体 · IBM Plex Mono 已加载'] = await ev(`document.fonts.check('400 12px "IBM Plex Mono"')`);
  R['字体 · 正文家族'] = await ev(`getComputedStyle(document.body).fontFamily`);
  R['命中 · 列表条目高'] = await ev(`Math.round(document.querySelector('.item').getBoundingClientRect().height)`);
  R['命中 · 顶栏按钮高'] = await ev(`Math.round(document.querySelector('.topnav button').getBoundingClientRect().height)`);
  R['品牌 · 标记为内联 SVG'] = await ev(`document.querySelector('.brand .mark svg')?.querySelectorAll('rect').length`);
  const contrast = await ev(`window.__nhContrast()`);
  R['对比度 · 最低值'] = Math.min(...Object.values(contrast).filter((v) => typeof v === 'number'));
  R['对比度 · 明细'] = contrast;

  /* --- 设计方向（极简 · 精密）：防"风格被悄悄改回去"的护栏 --- */
  R['风格 · 顶栏为浅色毛玻璃'] = await ev(`(() => {
    const s = getComputedStyle(document.querySelector('.topbar'));
    const rgb = (s.backgroundColor.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
    const light = rgb.length === 3 && (rgb[0] + rgb[1] + rgb[2]) / 3 > 230;
    return light && (s.backdropFilter || s.webkitBackdropFilter || 'none') !== 'none'; })()`);
  R['风格 · 无噪点/网格纹理层'] = await ev(`getComputedStyle(document.body, '::after').backgroundImage === 'none'`);
  R['风格 · 导航底色'] = await ev(`getComputedStyle(document.querySelector('.topnav')).backgroundColor`);
  R['风格 · 当前项底色'] = await ev(`getComputedStyle(document.querySelector('.topnav button.active')).backgroundColor`);
  // 分段药丸导航只在 >720px 成立；≤720px 主动退回朴素条带（否则药丸轨道会被横向滚出可视区）
  R[width > 720 ? '风格 · 分段药丸导航（灰轨道 + 白当前项）' : '风格 · 窄屏导航退回朴素条带'] =
    width > 720
      ? R['风格 · 导航底色'] !== 'rgba(0, 0, 0, 0)' && R['风格 · 当前项底色'] === 'rgb(255, 255, 255)'
      : R['风格 · 导航底色'] === 'rgba(0, 0, 0, 0)';

  /* --- 降级动效 --- */
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await goto(true);
  await sleep(400);
  R['降级 · 入场元素立即可见'] = await ev(`
    Array.from(document.querySelectorAll('#view-keys .pane, #view-keys .item, .page-head'))
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
      const bad = v === false || v === null || v === undefined;
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
    const leftover = Object.entries(R).filter(([k, v]) => /残留/.test(k) && v !== 0);
    if (leftover.length) { console.log(`  ✗ 弹层/菜单残留: ${JSON.stringify(leftover)}`); failed++; }
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
