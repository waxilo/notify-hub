// 定时任务端到端冒烟测试（内存 SQLite，不依赖云端）
// 覆盖：到期触发 / next_run_at 推进 / 并发重复执行拦截 / 一次性任务自动停用 / 索引命中
//      / 与外部 key 解耦（通知不带 key、标题取任务名称）
//      / 通知归到 job_id（可查历史、可按 job 或按 key 清空、删任务/删 key 连带清历史）
//      / 停用 key 的调用留痕（rejected=key_disabled，只入库不推送、窗口内不刷屏）
// 运行：cd worker && node test/jobs.smoke.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runDueJobs, deleteJob, listJobs } from '../src/jobs.js';
import { clearNotifications } from '../src/notifications.js';
import { deleteKey } from '../src/keys.js';
import { handleWebhook } from '../src/webhook.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
// 按真实部署顺序跑迁移：0002 补列（内存库是全新的，ALTER 可直接执行）+ 0003 建 jobs 表
// + 0004 清空 jobs.key_id + 0005 给 notifications 补 job_id + 0006 建索引 + 0007 补 rejected。
// 注意线上已有库不能跑 0002 / 0005 / 0007（列已存在会整批回滚），只能跑幂等的 0003 / 0004 / 0006。
db.exec(readFileSync(new URL('../migrations/0002_schema_sync.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0003_jobs.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0004_jobs_detach_key.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0005_notifications_job_id.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0006_notifications_job_index.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0007_notifications_rejected.sql', import.meta.url), 'utf8'));

// ---- 极简 D1 适配层 ----
const stmt = (sql) => {
  const s = db.prepare(sql);
  return {
    bind(...args) {
      return {
        async all() { return { results: s.all(...args) }; },
        async first() { return s.get(...args) ?? null; },
        async run() { const r = s.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; },
      };
    },
  };
};
const pushes = [];
const env = {
  DB: { prepare: stmt },
  PUSH_HUB: {
    idFromName: (n) => ({ toString: () => n }),
    get: () => ({ async fetch(url, init) { pushes.push(JSON.parse(init.body)); return new Response('{"ok":true,"delivered":1}'); } }),
  },
};

let bad = 0;
const ck = (name, cond, extra) => {
  if (!cond) { bad++; console.log('FAIL ', name, extra ?? ''); } else console.log('ok   ', name, extra ?? '');
};

const now = Date.UTC(2026, 8, 10, 1, 0, 0);           // 本地(+08:00) 2026-09-10 09:00
db.prepare('INSERT INTO users (id, username, pass_hash, pass_salt, created_at) VALUES (1,?,?,?,?)').run('u', 'h', 's', now);
db.prepare('INSERT INTO keys (id, user_id, key, name, created_at, active, mode) VALUES (1,1,?,?,?,1,?)').run('k1', '告警通道', now, 'default');

const insertJob = (schedule, nextRunAtVal, enabled = 1, name = '任务', body = '') => {
  const r = db.prepare(
    'INSERT INTO jobs (user_id, key_id, name, schedule, tz, title, body, enabled, next_run_at, created_at, updated_at) VALUES (1,NULL,?,?,?,NULL,?,?,?,?,?)'
  ).run(name, schedule, '+08:00', body, enabled, nextRunAtVal, now, now);
  return Number(r.lastInsertRowid);
};

// 1) 到期 job 触发
const id1 = insertJob('every:5m', now - 1000);
let r = await runDueJobs(env, now);
ck('tick 触发 1 个', r.scanned === 1 && r.fired === 1, JSON.stringify(r));
let n = db.prepare('SELECT COUNT(*) c FROM notifications').get();
ck('产生 1 条通知', n.c === 1, 'count=' + n.c);
ck('推送到 DO', pushes.length === 1, JSON.stringify(pushes[0] || {}));
// 定时任务不挂 key：推送里 key_name 为空，标题取任务名称（正文留空时也用任务名，保证非空可推送）
ck('推送不带 key_name', pushes[0].key_name === '', JSON.stringify(pushes[0].key_name));
ck('标题 = 任务名称', pushes[0].title === '任务', JSON.stringify(pushes[0].title));
ck('正文空时回退为任务名', pushes[0].body === '任务', JSON.stringify(pushes[0].body));
ck('通知不挂 key_id', db.prepare('SELECT key_id FROM notifications').get().key_id === null);
// 通知归到任务名下：任务列表能统计「已发送 N 条」，也能按任务查历史
ck('通知归到 job_id', db.prepare('SELECT job_id FROM notifications').get().job_id === id1,
  'job_id=' + db.prepare('SELECT job_id FROM notifications').get().job_id);
let j = db.prepare('SELECT * FROM jobs WHERE id=?').get(id1);
// 间隔基于「计划时刻」递推而非当前时间，所以是 (now-1000)+5m，不是 now+5m（避免漂移）
ck('next_run_at 已推进', j.next_run_at === now - 1000 + 5 * 60000, String(j.next_run_at - now));
ck('last_run_at 已写入', j.last_run_at === now - 1000, String(j.last_run_at));
ck('dedup_key 带计划时刻', db.prepare('SELECT dedup_key FROM notifications').get().dedup_key === `job:${id1}:${now - 1000}`);

// 2) 未到期的 job 不触发
r = await runDueJobs(env, now + 60000);
ck('未到期不触发', r.scanned === 0, JSON.stringify(r));

// 3) 下一次到期正常触发
r = await runDueJobs(env, now + 5 * 60000);
ck('5 分钟后再次触发', r.fired === 1);
ck('累计 2 条通知', db.prepare('SELECT COUNT(*) c FROM notifications').get().c === 2);

// 4) 并发/重入：把 next_run_at 拨回「已执行过的同一时刻」再跑一次，dedup_key 应拦住重复通知
db.prepare('UPDATE jobs SET next_run_at=? WHERE id=?').run(now + 5 * 60000 - 1000, id1);
const before = db.prepare('SELECT COUNT(*) c FROM notifications').get().c;
await runDueJobs(env, now + 5 * 60000);
ck('重复执行被 dedup 拦截', db.prepare('SELECT COUNT(*) c FROM notifications').get().c === before,
  'notif=' + db.prepare('SELECT COUNT(*) c FROM notifications').get().c);

// 后面的用例要求环境干净，先清掉这个每 5 分钟的任务
db.prepare('DELETE FROM jobs WHERE id=?').run(id1);

// 5) 一次性任务执行后自动停用；标题/正文按「任务名称 / 通知内容」落库
const id5 = insertJob('once:2026-09-10T09:00', now - 5000, 1, '只跑一次', '正文来自通知内容');
await runDueJobs(env, now + 10 * 60000);
j = db.prepare('SELECT * FROM jobs WHERE id=?').get(id5);
ck('一次性任务执行后停用', j.enabled === 0, 'enabled=' + j.enabled);
const cntOnce = () => db.prepare('SELECT COUNT(*) c FROM notifications WHERE dedup_key LIKE ?').get(`job:${id5}:%`).c;
ck('一次性任务已产生通知', cntOnce() === 1, 'c=' + cntOnce());
const onceN = db.prepare('SELECT title, body, key_id FROM notifications WHERE dedup_key LIKE ?').get(`job:${id5}:%`);
ck('标题取任务名称', onceN.title === '只跑一次', JSON.stringify(onceN.title));
ck('正文取通知内容', onceN.body === '正文来自通知内容', JSON.stringify(onceN.body));
ck('一次性任务通知也不挂 key', onceN.key_id === null);
await runDueJobs(env, now + 20 * 60000);
ck('停用后不再触发', cntOnce() === 1, 'c=' + cntOnce());

// 6) 停用的 job 不进入扫描
const id6 = insertJob('every:1m', now, 0);
r = await runDueJobs(env, now + 30 * 60000);
ck('停用 job 不进入扫描', r.scanned === 0, JSON.stringify(r));
db.prepare('DELETE FROM jobs WHERE id=?').run(id6);

// 7) 已解耦：key 全部删掉后，任务照常触发（旧实现会让通知标题变成「(已删除)」）
db.prepare('DELETE FROM keys').run();
const id7 = insertJob('every:1m', now - 1, 1, '没有 key 也能跑');
r = await runDueJobs(env, now + 31 * 60000);
ck('无 key 仍能触发', r.fired === 1, JSON.stringify(r));
const n7 = db.prepare('SELECT title FROM notifications WHERE dedup_key LIKE ?').get(`job:${id7}:%`);
ck('标题不受 key 删除影响', n7 && n7.title === '没有 key 也能跑', JSON.stringify(n7));
db.prepare('DELETE FROM jobs WHERE id=?').run(id7);

// 8) 索引命中
const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE enabled=1 AND next_run_at<=?').all(now);
ck('扫描命中 idx_jobs_due', JSON.stringify(plan).includes('idx_jobs_due'), JSON.stringify(plan));

// 9) 扫描语句里不应再有 keys 连接（防止以后又被加回来；连 `key_name` 一起卡住）
const scanSrc = String(runDueJobs);
const joined = /LEFT\s+JOIN|key_name/i.test(scanSrc);
ck('扫描不再关联 keys', !joined, joined ? 'still-joined' : 'clean');

/* ---------------- 历史归档与清空 ---------------- */

const countAll = () => db.prepare('SELECT COUNT(*) c FROM notifications').get().c;
const countJob = (id) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE job_id=?').get(id).c;
const countKey = (id) => db.prepare('SELECT COUNT(*) c FROM notifications WHERE key_id=?').get(id).c;
const clear = async (qs) => {
  const r = await clearNotifications(new Request('https://x/api/notifications' + qs, { method: 'DELETE' }), env, 1);
  return { status: r.status, body: await r.json() };
};
// 造一条「外部系统经 /hook/:key 写入」的通知，用来验证两个维度互不误伤
db.prepare('INSERT INTO keys (id, user_id, key, name, created_at, active, mode) VALUES (2,1,?,?,?,1,?)').run('k2', '外部通道', now, 'default');
const insertWebhookNotif = () => db.prepare(
  'INSERT INTO notifications (user_id, key_id, job_id, dedup_key, title, body, created_at, read) VALUES (1,2,NULL,?,?,?,?,0)'
).run('srv-' + Math.random().toString(36).slice(2), '外部通道', '来自外部', now);

// 10) 任务列表带「已发送 N 条」
const idA = insertJob('every:1m', now - 1, 1, '任务A');
await runDueJobs(env, now + 40 * 60000);
ck('任务A 已产生通知', countJob(idA) === 1, 'c=' + countJob(idA));
ck('任务通知的 key_id 为空', db.prepare('SELECT key_id FROM notifications WHERE job_id=?').get(idA).key_id === null);
let listResp = await (await listJobs(new Request('https://x/api/jobs'), env, 1)).json();
ck('列表返回 sent_count', listResp.jobs.find((x) => x.id === idA)?.sent_count === 1,
  JSON.stringify(listResp.jobs.map((x) => [x.id, x.sent_count])));
const idC = insertJob('every:9m', now + 10 * 3600 * 1000, 1, '从未触发');
listResp = await (await listJobs(new Request('https://x/api/jobs'), env, 1)).json();
ck('从未触发的任务 sent_count=0', listResp.jobs.find((x) => x.id === idC)?.sent_count === 0,
  JSON.stringify(listResp.jobs.find((x) => x.id === idC)));

insertWebhookNotif();
const base = countAll();

// 11) 清空：必须带 key_id 或 job_id，两个维度互不误伤
let c = await clear('');
ck('无参数清空被拒绝', c.status === 400, JSON.stringify(c));
ck('被拒绝时不删任何数据', countAll() === base, 'c=' + countAll());

c = await clear('?key_id=2');
ck('按 key 清空只删该 key 的', c.body.deleted === 1 && countKey(2) === 0, JSON.stringify(c.body));
ck('按 key 清空不动任务历史', countJob(idA) === 1, 'job=' + countJob(idA));
ck('按 key 清空后总数 -1', countAll() === base - 1, 'c=' + countAll());

insertWebhookNotif();
c = await clear('?job_id=' + idA);
ck('按 job 清空只删该任务的', c.body.deleted === 1 && countJob(idA) === 0, JSON.stringify(c.body));
ck('按 job 清空不动 key 历史', countKey(2) === 1, 'key=' + countKey(2));
// 清空后任务仍在、下个周期照常触发
db.prepare('UPDATE jobs SET enabled=0 WHERE id=?').run(idA);   // 冻住，避免干扰后续用例的计数

// 12) 删除任务时连带清空它的历史
const idB = insertJob('every:1m', now - 1, 1, '任务B');
await runDueJobs(env, now + 41 * 60000);
ck('任务B 已产生通知', countJob(idB) === 1, 'c=' + countJob(idB));
const beforeB = countAll();
const d404 = await deleteJob(new Request('https://x/api/jobs/99999', { method: 'DELETE' }), env, 1, 99999);
ck('删除不存在的任务返回 404', d404.status === 404, 'status=' + d404.status);
ck('删除不存在的任务不动历史', countAll() === beforeB, 'c=' + countAll());
await deleteJob(new Request('https://x/api/jobs/' + idB, { method: 'DELETE' }), env, 1, idB);
ck('删任务后任务行消失', db.prepare('SELECT COUNT(*) c FROM jobs WHERE id=?').get(idB).c === 0);
ck('删任务连带清空其历史', countJob(idB) === 0, 'job=' + countJob(idB));
ck('删任务不误伤其他历史', countAll() === beforeB - 1, 'c=' + countAll());

// 13) 删除 key 时连带清空它的历史（原有行为，这里钉住防回归）
insertWebhookNotif();
const beforeDelKey = countAll();
const keyNotifs = countKey(2);          // 该 key 名下已累积的历史条数
ck('删 key 前确实有历史', keyNotifs >= 1, 'c=' + keyNotifs);
await deleteKey(new Request('https://x/api/keys/2', { method: 'DELETE' }), env, 1, 2);
ck('删 key 后 key 行消失', db.prepare('SELECT COUNT(*) c FROM keys WHERE id=2').get().c === 0);
ck('删 key 连带清空其历史', countKey(2) === 0, 'key=' + countKey(2));
ck('删 key 只删该 key 的历史', countAll() === beforeDelKey - keyNotifs, 'c=' + countAll());

// 14) job_id 相关查询命中索引（否则每查一次历史都要全表扫该用户全部通知）
const planJob = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM notifications WHERE user_id=1 AND job_id=1').all();
ck('按 job 查询命中 idx_notif_job', JSON.stringify(planJob).includes('idx_notif_job'), JSON.stringify(planJob));
const planGroup = db.prepare('EXPLAIN QUERY PLAN SELECT job_id, COUNT(*) FROM notifications WHERE user_id=1 AND job_id IS NOT NULL GROUP BY job_id').all();
ck('统计查询命中 idx_notif_job', JSON.stringify(planGroup).includes('idx_notif_job'), JSON.stringify(planGroup));

/* ---------------- 停用 key 的调用留痕 ---------------- */

// 15) key 停用后外部往往还在按原节奏调用：不能静默 403，要在历史里留一条「停用拒绝」
db.prepare('INSERT INTO keys (id, user_id, key, name, created_at, active, mode) VALUES (3,1,?,?,?,0,?)').run('k3', '停用通道', now, 'default');
const pushBefore = pushes.length;
const notifBefore = countAll();
const hook = (qs = '') => handleWebhook(new Request('https://x/hook/k3' + qs, { method: 'GET' }), env, 'k3');

let hr = await hook('?message=' + encodeURIComponent('外部还在发'));
ck('停用 key 调用仍返回 403', hr.status === 403, 'status=' + hr.status);
ck('停用调用被留痕', countAll() === notifBefore + 1, 'c=' + countAll());
const rej = db.prepare('SELECT * FROM notifications WHERE key_id=3 ORDER BY id DESC LIMIT 1').get();
ck('留痕标记 key_disabled', rej && rej.rejected === 'key_disabled', JSON.stringify(rej && rej.rejected));
ck('留痕标题取 key 名', rej && rej.title === '停用通道', JSON.stringify(rej && rej.title));
ck('留痕保留原始内容', rej && rej.body === '外部还在发', JSON.stringify(rej && rej.body));
ck('留痕不挂 job_id', rej && rej.job_id === null);
ck('留痕记在 key_id 上', rej && rej.key_id === 3);
ck('停用调用不推送', pushes.length === pushBefore, 'pushes=' + (pushes.length - pushBefore));
ck('停用调用不更新 last_used', db.prepare('SELECT last_used FROM keys WHERE id=3').get().last_used === null);

// 同一 5 分钟窗口内重复调用不再新增（外部高频重试不会把历史刷爆）
hr = await hook('?message=' + encodeURIComponent('再来一次'));
ck('窗口内重复调用不刷屏', countAll() === notifBefore + 1 && hr.status === 403, 'c=' + countAll());

// 重新启用后恢复正常：写入 + 推送，且不受前面的拒绝记录影响
db.prepare('UPDATE keys SET active=1 WHERE id=3').run();
const pushBefore2 = pushes.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('恢复后正常'), { method: 'GET' }), env, 'k3');
ck('启用后调用恢复正常', hr.status === 201, 'status=' + hr.status);
ck('启用后正常推送', pushes.length === pushBefore2 + 1, 'pushes=' + (pushes.length - pushBefore2));
ck('启用后写入的是正常记录', db.prepare('SELECT rejected FROM notifications WHERE key_id=3 ORDER BY id DESC LIMIT 1').get().rejected === null);

console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
process.exit(bad ? 1 : 0);
