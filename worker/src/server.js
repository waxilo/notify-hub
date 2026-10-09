// 容器进程入口：把 node:http 适配成 Worker 的 fetch/scheduled 两个触发口。
//
// index.js 的路由表与 default.scheduled 一行不改 —— 它只用了 Web 标准 API
// （Request / Response / crypto.subtle / fetch），Node 24 全部原生具备。
// Cloudflare 在这份代码里只借了三样东西，这里各自补上对应物：
//   1) D1 绑定          → src/db.js 的 env.DB（同形接口）
//   2) Cron Triggers    → 下面的 startTicker（进程内定时器，见注释）
//   3) Pages 静态托管   → 下面的静态文件分支（同源，因此不再有跨域配置问题）
//
// 请求分流刻意用「前缀」而不是「先试 API、404 了再回落静态」：
// 后者会让 /api/keys 拼错时返回 index.html（200 + 一段 HTML），
// 前端 res.json() 抛错、日志里只留一个看不懂的 SyntaxError —— 排查成本全砸在人身上。
//   /api/*、/hook/*  → Worker 路由表
//   /healthz         → 探活（compose 用；不进路由表，避免污染对外接口面与路由回归测试）
//   其余            → 静态控制台
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './index.js';
import { createDatabase, databaseConfigFromEnv } from './db.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = resolve(process.env.STATIC_DIR || join(ROOT, '..', 'pages'));
// 只有这张表里的扩展名会被当作文件读出来；不在表里的一律走 index.html 或 404。
// 白名单而不是黑名单：pages/ 同级有 wrangler.toml / wrangler.jsonc / 仓库里的 .md，
// 少写一条规则就可能把配置或源码当文本发给浏览器。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
const MAX_BODY_BYTES = 1_000_000;   // 通知正文上限 8000 字符，1MB 已远超任何合法请求
const API_PREFIXES = ['/api/', '/hook/'];

const env = {
  ...process.env,
  JWT_SECRET: process.env.JWT_SECRET || '',
};

/** 回给 index.js 的 origin：外部看到的是 https，容器里收到的是 http，必须以转发头为准。 */
function requestUrl(req) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  // gw 网关（cloudflared → nginx）在转发时带 X-Forwarded-Proto: https；
  // 不接公网的裸容器没有这个头，就按 http 处理。
  const proto = process.env.TRUST_PROXY === '1'
    ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'
    : 'http';
  return `${proto}://${host}${req.url || '/'}`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('payload too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function toWebRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
  }
  const method = req.method || 'GET';
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    const body = await readBody(req);
    if (body.length) init.body = body;
  }
  return new Request(requestUrl(req), init);
}

// Cloudflare 在响应返回后才执行 waitUntil 里的事；这里同样「不阻塞响应」，
// 但必须把 promise 记下来，否则优雅退出时会被进程直接掐掉（bots.js 用它写回调留痕）。
function createContext() {
  const pending = new Set();
  return {
    waitUntil(promise) {
      const p = Promise.resolve(promise).catch((err) => {
        console.error('waitUntil_failed', String(err && err.message ? err.message : err));
      });
      pending.add(p);
      p.finally(() => pending.delete(p));
    },
    drain: () => Promise.all([...pending]),
  };
}

async function handleApi(req, res, ctx) {
  const request = await toWebRequest(req);
  const response = await worker.fetch(request, env, ctx);
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (request.method === 'HEAD' || response.status === 204 || response.headers.get('content-length') === '0') {
    return res.end();
  }
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

async function handleStatic(req, res, pathname) {
  // 控制台是单页（tab 在 app.js 内部切换，不用路由），所以无扩展名的未知路径回 index.html；
  // 带扩展名却不在 MIME 白名单里的（.toml/.jsonc/.map/.md）一律 404，不读盘。
  const ext = extname(pathname).toLowerCase();
  if (ext && !MIME[ext]) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const file = join(STATIC_DIR, ext ? pathname : 'index.html');
  if (!file.startsWith(STATIC_DIR + sep)) {   // 拦 ../ 穿越（join 已规范化，剩下的是越界）
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || MIME['.html'],
      // 纯静态、无构建、无 hash 文件名，所以 html/js/css 必须 no-cache：
      // 否则改完代码刷新页面还会拿到旧的 app.js，而「界面行为诡异」是最难查的一类反馈。
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

async function handleHealth(res) {
  let dbOk = false;
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    dbOk = true;
  } catch (err) {
    console.error('health_db_failed', String(err && err.message ? err.message : err));
  }
  res.writeHead(dbOk ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ status: dbOk ? 'ok' : 'error', database: dbOk }));
}

/* ---------------- Cron Triggers 的替代物 ---------------- */

// Cloudflare 的 crons = ["* * * * *"] 由平台在每分钟开头唤醒一次 isolate。
// 容器里改成进程内定时器：同一个容器既是 API 也是执行器，不引入第二个服务
// （多容器 cron sidecar 要靠 HTTP 回调自己，等于把「入站请求计数」和跨容器鉴权都请回来）。
//
// 精度不变：runDueJobs 按整分钟 floor 比较，和平台 tick 的语义一致；
// 落在分钟边界后 2 秒触发，保证「这一分钟该跑的行」已经写完，不会读空。
//
// 两种异常各有明确处理，都不靠重试：
//   * 上一次 tick 还没跑完又到点 → 跳过本次并记日志，不排队堆积（一次 tick 最多 100 个 job，
//     连续跳说明有 job 卡在网络调用上，堆积只会放大延迟）。
//   * 容器停机期间到期的 job → 不补跑历史，但下一次 tick 会按 next_run_at<=now 扫到并执行，
//     再往后的计划由 nextRunAt 从「计划触发时刻」递推 —— 与 Cloudflare 当时漏跑一个 tick 的行为相同。
//     重复触发另有 dedup_key 与乐观锁两道兜底。
function startTicker() {
  // 迁移验证期的闸门：云上 Worker 的 Cron Trigger 还活着时，两边各自的库互不可见，
  // 任务级 dedup_key 拦不住跨库重复 —— 同一个定时任务会被推两次到真实的群/好友。
  // 所以「只想验 HTTP」时用 JOBS_TICK_DISABLED=1 起容器，定时器一行都不装。
  if (process.env.JOBS_TICK_DISABLED === '1') {
    console.warn('jobs_tick_disabled', JSON.stringify({ reason: 'JOBS_TICK_DISABLED=1' }));
    return { stop: () => {} };
  }
  let running = false;
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (running) {
      console.warn('jobs_tick_skipped', JSON.stringify({ reason: 'previous tick still running' }));
      return;
    }
    running = true;
    try {
      await worker.scheduled({ scheduledTime: Date.now() }, env);
    } catch (err) {
      console.error('jobs_tick_failed', String(err));
    } finally {
      running = false;
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const d = new Date();
    const delay = (59 - d.getSeconds()) * 1000 + (1000 - d.getMilliseconds()) + 2000;
    timer = setTimeout(() => { tick().finally(scheduleNext); }, Math.max(delay, 1000));
  };

  scheduleNext();
  console.log('jobs_tick_armed', JSON.stringify({ mode: 'every-minute', staticDir: STATIC_DIR }));
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

/* ---------------- 启动 ---------------- */

function assertConfig() {
  const problems = [];
  if (env.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET 缺失或短于 32 字符（登录 token 的签名密钥，配错会让所有端同时 401）');
  }
  try {
    databaseConfigFromEnv(env);
  } catch (err) {
    problems.push(String(err.message));
  }
  if (problems.length) {
    console.error('startup_misconfigured', JSON.stringify({ problems }));
    process.exit(1);
  }
}

assertConfig();
const { DB, close: closeDb } = createDatabase(databaseConfigFromEnv(env));
env.DB = DB;

const ctx = createContext();
const server = createServer((req, res) => {
  const pathname = (() => {
    try { return new URL(requestUrl(req)).pathname; } catch { return '/'; }
  })();
  const route = (async () => {
    if (pathname === '/healthz') return handleHealth(res);
    if (API_PREFIXES.some((p) => pathname.startsWith(p))) return handleApi(req, res, ctx);
    if (req.method !== 'GET' && req.method !== 'HEAD') return handleApi(req, res, ctx);
    return handleStatic(req, res, pathname);
  })();
  route.catch((err) => {
    const status = err && err.statusCode === 413 ? 413 : 500;
    console.error('request_failed', JSON.stringify({ method: req.method, path: pathname, status, err: String(err) }));
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: status === 413 ? 'payload too large' : 'internal error' }));
  });
});

const ticker = startTicker();

server.listen(PORT, HOST, () => {
  console.log('notify-hub listening', JSON.stringify({ port: PORT, host: HOST, staticDir: STATIC_DIR }));
});

// Docker stop 发 SIGTERM：先把在途的 waitUntil 写完、把当前 tick 让出来，再关连接池。
// 不处理 SIGTERM 的话这 10 秒会被 SIGKILL 截断，回调留痕与 job 推进可能停在半路。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('shutdown', JSON.stringify({ signal: sig }));
    ticker.stop();
    server.close(() => {
      ctx.drain().finally(() => closeDb().catch(() => {})).then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
