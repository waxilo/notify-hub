// 定时任务端到端冒烟测试（内存 SQLite，不依赖云端）
// 覆盖：到期触发 / next_run_at 推进 / 并发重复执行拦截 / 一次性任务自动停用 / 索引命中
//      / 与外部 key 解耦（通知不带 key、标题取任务名称）
//      / 通知归到 job_id（可查历史、可按 job 或按 key 清空、删任务/删 key 连带清历史）
//      / 停用 key 的调用留痕（rejected=key_disabled，只入库不推送、窗口内不刷屏）
//      / QQ 官方机器人触达（触发即发群/私聊消息，目标由 QQ_TARGET 决定；网关失败不影响入库）
// 运行：cd worker && node test/jobs.smoke.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runDueJobs, deleteJob, listJobs, createJob, updateJob } from '../src/jobs.js';
import { nextRunAt } from '../src/schedule.js';
import { clearNotifications } from '../src/notifications.js';
import { deleteKey, updateKey } from '../src/keys.js';
import { handleWebhook } from '../src/webhook.js';

// 外部依赖全部 mock 掉，避免测试依赖外网：
//   1) 节假日 API：2026-10-01 记为节假日（isHoliday=true），其余日期为工作日
//   2) QQ 机器人 API：getAppAccessToken 发 token；群消息接口记录调用并可注入失败
const _origFetch = global.fetch;
let qqSendFail = false;               // 置 true 时模拟 QQ 群消息接口报错
const qqTokenCalls = [];
const qqCalls = [];                   // [{ to, text, msg_type }]
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('holidays/date/')) {
    const m = u.match(/holidays\/date\/(\d{4}-\d{2}-\d{2})/);
    const d = m ? m[1] : '';
    const isHoliday = d === '2026-10-01';
    return new Response(JSON.stringify({
      code: 0, msg: 'success',
      data: { date: d, isHoliday, isWorkday: !isHoliday, holiday: isHoliday ? { date: d, name: '测试节', type: 'holiday' } : null, dayOfWeek: 0 },
    }), { status: 200 });
  }
  if (u.includes('getAppAccessToken')) {
    qqTokenCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ access_token: 'TEST_TOKEN', expires_in: 7200 }), { status: 200 });
  }
  if (u.includes('api.sgroup.qq.com')) {
    if (qqSendFail) return new Response(JSON.stringify({ result: -1, errmsg: 'mocked failure' }), { status: 200 });
    const body = JSON.parse(init.body);
    const m = u.match(/\/v2\/(groups|users)\/([^/]+)\//);   // 群与私聊共用 api.sgroup.qq.com
    qqCalls.push({ kind: m[1], to: m[2], text: body.content, msg_type: body.msg_type });
    return new Response(JSON.stringify({ result: 0, msg_seq: 1 }), { status: 200 });
  }
  return _origFetch ? _origFetch(url, init) : new Response('{}', { status: 404 });
};

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
// 按真实部署顺序跑迁移：0002 补列（内存库是全新的，ALTER 可直接执行）+ 0003 建 jobs 表
// + 0004 清空 jobs.key_id + 0005 给 notifications 补 job_id + 0006 建索引 + 0007 补 rejected
// + 0008 给 keys/jobs 补 strong_vibrate + 0009 补 skip_holiday + 0010 建 settings。
// 注意线上已有库不能跑 0002 / 0005 / 0007 / 0008（列已存在会整批回滚），只能跑幂等的 0003 / 0004 / 0006 / 0010。
db.exec(readFileSync(new URL('../migrations/0002_schema_sync.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0003_jobs.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0004_jobs_detach_key.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0005_notifications_job_id.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0006_notifications_job_index.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0007_notifications_rejected.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0008_strong_vibrate.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0009_skip_holiday.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0010_settings.sql', import.meta.url), 'utf8'));

// ---- 极简 D1 适配层 ----
const stmt = (sql) => {
  const s = db.prepare(sql);
  return {
    bind(...args) {
      // 真实 D1 对 undefined 会抛 D1_TYPE_ERROR，这里对齐该行为。
      // 否则「SQL 里加了占位符、却忘了定义对应变量」这类错误会被静默吞掉，
      // 直到线上某个接口 500 才暴露（本文件的 createJob/updateJob 就踩过）。
      for (let i = 0; i < args.length; i++) {
        if (args[i] === undefined) {
          throw new TypeError(`D1_TYPE_ERROR: Type 'undefined' not supported for binding (arg #${i})`);
        }
      }
      return {
        async all() { return { results: s.all(...args) }; },
        async first() { return s.get(...args) ?? null; },
        async run() { const r = s.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; },
      };
    },
  };
};
const env = {
  DB: { prepare: stmt },
  QQ_APP_ID: 'TEST_APP_ID',
  QQ_APP_SECRET: 'TEST_APP_SECRET',
  QQ_GROUP_OPENID: 'GROUP_OPENID_X',
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
ck('调用 QQ 群消息接口', qqCalls.length === 1, JSON.stringify(qqCalls[0] || {}));
ck('QQ 消息标题取任务名称（默认模板）',
  qqCalls[0].text.startsWith('📢 任务\n━━━━━━━━━━━━━━\n任务\n\n🕐 '),
  JSON.stringify(qqCalls[0].text));
ck('QQ 消息为文本类型', qqCalls[0].msg_type === 0, JSON.stringify(qqCalls[0].msg_type));
ck('通知不挂 key_id', db.prepare('SELECT key_id FROM notifications').get().key_id === null);
// 通知归到任务名下：任务列表能统计「已发送 N 条」，也能按任务查历史
ck('通知归到 job_id', db.prepare('SELECT job_id FROM notifications').get().job_id === id1,
  'job_id=' + db.prepare('SELECT job_id FROM notifications').get().job_id);
ck('QQ 推送成功写入 delivered_at',
  db.prepare('SELECT delivered_at FROM notifications WHERE job_id=?').get(id1).delivered_at !== null);
let j = db.prepare('SELECT * FROM jobs WHERE id=?').get(id1);
// 间隔基于「计划时刻」递推而非当前时间，避免漂移；且该基准先对齐整分钟（丢弃创建/执行时刻的秒），
// 所以是 floor(now-1000)+5m = 09:04:00，不是 (now-1000)+5m
ck('next_run_at 已推进', j.next_run_at === now + 4 * 60000, String(j.next_run_at - now));
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
//    （用上一次真正触发过的计划时刻 now+4m，即 09:04:00，dedup_key 才会命中窗口）
db.prepare('UPDATE jobs SET next_run_at=? WHERE id=?').run(now + 4 * 60000, id1);
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
const qqBefore = qqCalls.length;
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
ck('停用调用不推送 QQ', qqCalls.length === qqBefore, 'qq=' + (qqCalls.length - qqBefore));
ck('停用调用不更新 last_used', db.prepare('SELECT last_used FROM keys WHERE id=3').get().last_used === null);

// 同一 5 分钟窗口内重复调用不再新增（外部高频重试不会把历史刷爆）
hr = await hook('?message=' + encodeURIComponent('再来一次'));
ck('窗口内重复调用不刷屏', countAll() === notifBefore + 1 && hr.status === 403, 'c=' + countAll());

// 重新启用后恢复正常：写入 + QQ 推送，且不受前面的拒绝记录影响
db.prepare('UPDATE keys SET active=1 WHERE id=3').run();
const qqBefore2 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('恢复后正常'), { method: 'GET' }), env, 'k3');
ck('启用后调用恢复正常', hr.status === 201, 'status=' + hr.status);
ck('启用后正常推送 QQ', qqCalls.length === qqBefore2 + 1, 'qq=' + (qqCalls.length - qqBefore2));
ck('启用后写入的是正常记录', db.prepare('SELECT rejected FROM notifications WHERE key_id=3 ORDER BY id DESC LIMIT 1').get().rejected === null);
const okResp = await hr.json();
ck('webhook 响应带 delivered 标记', okResp.delivered === true, JSON.stringify(okResp));

/* ---------------- QQ 通道的失败隔离 ---------------- */

// 16) 群消息接口报错：通知仍入库（不丢），接口照常返回，delivered_at 留空
qqSendFail = true;
const qqBefore3 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('QQ挂了也要入库'), { method: 'GET' }), env, 'k3');
ck('QQ 失败时 webhook 仍返回 201', hr.status === 201, 'status=' + hr.status);
ck('QQ 失败时响应 delivered=false', (await hr.json()).delivered === false);
ck('QQ 失败时不重试不阻塞', qqCalls.length === qqBefore3);
const failN = db.prepare('SELECT * FROM notifications WHERE body=?').get('QQ挂了也要入库');
ck('QQ 失败时通知仍入库', !!failN, JSON.stringify(failN && failN.id));
ck('QQ 失败时 delivered_at 为空（历史显示未送达）', failN && failN.delivered_at === null);
qqSendFail = false;

// 17) 群 openid 未配置：同样只入库不推送
const envNoGroup = { ...env, QQ_GROUP_OPENID: '' };
db.prepare("DELETE FROM settings WHERE k='qq_group_openid'").run();
const qqBefore4 = qqCalls.length;
const notifBefore4 = countAll();
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('没配群号'), { method: 'GET' }), envNoGroup, 'k3');
ck('未配置群 openid 时仍返回 201', hr.status === 201, 'status=' + hr.status);
ck('未配置群 openid 时不调 QQ', qqCalls.length === qqBefore4, 'qq=' + (qqCalls.length - qqBefore4));
ck('未配置群 openid 时通知仍入库', countAll() === notifBefore4 + 1, 'c=' + countAll());

/* ---------------- 触达目标（QQ_TARGET：group / c2c / both） ---------------- */

const lastCall = () => qqCalls[qqCalls.length - 1];
// 模拟「私聊机器人一句话」后的自动捕获结果
db.prepare("INSERT INTO settings (k, v) VALUES ('qq_user_openid', 'USER_OPENID_X') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();

// 17a) 默认（未设 QQ_TARGET）只发群：私聊 openid 已在库也不发
let q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('默认发群'), { method: 'GET' }), env, 'k3');
ck('默认目标仍是群', hr.status === 201 && qqCalls.length === q0 + 1 && lastCall().kind === 'groups',
  JSON.stringify(lastCall() || {}));

// 17b) QQ_TARGET=c2c：只发私聊
const envC2C = { ...env, QQ_TARGET: 'c2c' };
q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('发私聊'), { method: 'GET' }), envC2C, 'k3');
ck('QQ_TARGET=c2c 只发私聊', hr.status === 201 && qqCalls.length === q0 + 1
  && lastCall().kind === 'users' && lastCall().to === 'USER_OPENID_X',
  JSON.stringify(lastCall() || {}));
ck('c2c 推送成功写 delivered_at',
  db.prepare('SELECT delivered_at FROM notifications WHERE body=?').get('发私聊').delivered_at !== null);

// 17c) QQ_TARGET=both：群 + 私聊各一条
const envBoth = { ...env, QQ_TARGET: 'both' };
q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('都发'), { method: 'GET' }), envBoth, 'k3');
ck('QQ_TARGET=both 发两条', hr.status === 201 && qqCalls.length === q0 + 2, 'qq=' + (qqCalls.length - q0));
ck('both 覆盖群与私聊', qqCalls.slice(q0).map((c) => c.kind).sort().join() === 'groups,users',
  JSON.stringify(qqCalls.slice(q0).map((c) => c.kind)));

// 17d) QQ_TARGET 非法值回落 group（不发私聊）
const envBad = { ...env, QQ_TARGET: 'nonsense' };
q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('非法目标'), { method: 'GET' }), envBad, 'k3');
ck('非法 QQ_TARGET 回落 group', hr.status === 201 && qqCalls.length === q0 + 1 && lastCall().kind === 'groups',
  JSON.stringify(lastCall() || {}));

// 17e) QQ_TARGET=c2c 但私聊 openid 未捕获：只入库不推送（隔离语义与群一致）
const envC2COnly = { ...env, QQ_TARGET: 'c2c', QQ_USER_OPENID: '' };
db.prepare("DELETE FROM settings WHERE k='qq_user_openid'").run();
const notifBeforeE = countAll();
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('没配私聊'), { method: 'GET' }), envC2COnly, 'k3');
ck('未捕获私聊 openid 时仍返回 201', hr.status === 201, 'status=' + hr.status);
ck('未捕获私聊 openid 时通知仍入库', countAll() === notifBeforeE + 1, 'c=' + countAll());
ck('未捕获私聊 openid 时 delivered_at 为空',
  db.prepare('SELECT delivered_at FROM notifications WHERE body=?').get('没配私聊').delivered_at === null);

// 17f) Web 控制台配置的凭证（settings）优先于 env：token 请求应带 settings 里的 appId
db.prepare("INSERT INTO settings (k, v) VALUES ('qq_app_id', 'SETTINGS_APP') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
db.prepare("INSERT INTO settings (k, v) VALUES ('qq_app_secret', 'SETTINGS_SECRET') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
const tokBefore = qqTokenCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('settings凭证'), { method: 'GET' }), env, 'k3');
ck('settings 凭证优先于 env', hr.status === 201 && qqTokenCalls.length === tokBefore + 1
  && qqTokenCalls[qqTokenCalls.length - 1].appId === 'SETTINGS_APP'
  && qqTokenCalls[qqTokenCalls.length - 1].clientSecret === 'SETTINGS_SECRET',
  JSON.stringify(qqTokenCalls[qqTokenCalls.length - 1] || {}));
ck('settings 凭证下消息照常投递', qqCalls[qqCalls.length - 1].kind === 'groups', JSON.stringify(qqCalls[qqCalls.length - 1] || {}));
db.prepare("DELETE FROM settings WHERE k IN ('qq_app_id', 'qq_app_secret')").run();

// 17g) 多好友扇出：名单里两个 openid 都收到（多个用户加好友 = 人人都收通知）
const envC2CFan = { ...env, QQ_TARGET: 'c2c' };
db.prepare("INSERT INTO settings (k, v) VALUES ('qq_user_openids', '[\"USER_A\",\"USER_B\"]') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('多好友扇出'), { method: 'GET' }), envC2CFan, 'k3');
ck('多好友名单逐个扇出', hr.status === 201 && qqCalls.length === q0 + 2
  && qqCalls[q0].kind === 'users' && qqCalls[q0].to === 'USER_A'
  && qqCalls[q0 + 1].kind === 'users' && qqCalls[q0 + 1].to === 'USER_B',
  JSON.stringify(qqCalls.slice(q0)));
ck('扇出任一送达即写 delivered_at',
  db.prepare('SELECT delivered_at FROM notifications WHERE body=?').get('多好友扇出').delivered_at !== null);
db.prepare("DELETE FROM settings WHERE k='qq_user_openids'").run();

/* ---------------- createJob / updateJob 的写入路径 ---------------- */

// 18) 这两条曾经出问题：updateJob 的 SQL 加了占位符却忘了定义对应变量（线上 500），
//     createJob 的 INSERT 则整列都没带（新建任务的开关被静默丢弃）。此处把两条路径一起锁住。
const mkBody = (over = {}) => JSON.stringify({
  name: '打卡提醒', body: '远程签到30元', schedule: 'daily:21:01', tz: '+08:00',
  enabled: true, skip_holiday: true, ...over,
});

const crRes = await createJob(new Request('https://x/api/jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: mkBody(),
}), env, 1);
ck('createJob 返回 201', crRes.status === 201, 'status=' + crRes.status);
const newJobId = (await crRes.json()).id;
ck('createJob 写入 skip_holiday=1',
  db.prepare('SELECT skip_holiday FROM jobs WHERE id=?').get(newJobId).skip_holiday === 1);

const upRes = await updateJob(new Request('https://x/api/jobs/' + newJobId, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: mkBody({ skip_holiday: false }),
}), env, 1, newJobId);
ck('updateJob 返回 200（原为 500）', upRes.status === 200, 'status=' + upRes.status);
ck('updateJob 写入 skip_holiday=0',
  db.prepare('SELECT skip_holiday FROM jobs WHERE id=?').get(newJobId).skip_holiday === 0);

await updateJob(new Request('https://x/api/jobs/' + newJobId, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '改个名' }),
}), env, 1, newJobId);
ck('updateJob 不传开关时保留原值',
  db.prepare('SELECT skip_holiday FROM jobs WHERE id=?').get(newJobId).skip_holiday === 0);

// 19) 旧客户端传来的废弃字段（strong_vibrate）被安全忽略，不报错也不写库
const legacyRes = await createJob(new Request('https://x/api/jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '旧客户端', schedule: 'daily:08:00', tz: '+08:00', strong_vibrate: true }),
}), env, 1);
ck('createJob 忽略废弃字段不报错', legacyRes.status === 201, 'status=' + legacyRes.status);

/* ---------------- 秒对齐（创建时刻与 Cron 到达时刻的秒都不可控） ---------------- */

// 20) 计划的「秒」不参与判定。
//     场景：21:11:30 创建 every:1m，21:12:10 那次 cron tick 必须触发 ——
//     旧实现把创建时刻的 :30 带进 next_run_at(21:12:30)，21:12:10 会被判为未到期，整条提醒晚一分钟。
const L = (h, mi, s = 0) => Date.UTC(2026, 8, 10, h - 8, mi, s);   // 本地(+08:00) 2026-09-10 → UTC 毫秒

ck('间隔型首次计划丢弃创建时刻的秒',
  nextRunAt('every:1m', 480, L(21, 11, 30), L(21, 11, 30)) === L(21, 12, 0),
  new Date(nextRunAt('every:1m', 480, L(21, 11, 30), L(21, 11, 30))).toISOString());

// 20.1 计划时刻 21:12:00：该分钟内任意一秒的 tick 都能命中，前一分钟则不提前触发
const idSec = insertJob('every:1m', L(21, 12, 0));
await runDueJobs(env, L(21, 11, 59));
ck('未到计划分钟不提前触发', countJob(idSec) === 0, 'c=' + countJob(idSec));
await runDueJobs(env, L(21, 12, 10));
ck('tick 落在分钟后 10 秒仍触发', countJob(idSec) === 1, 'c=' + countJob(idSec));
ck('推进后的计划时刻仍是整分钟',
  db.prepare('SELECT next_run_at FROM jobs WHERE id=?').get(idSec).next_run_at === L(21, 13, 0),
  String(db.prepare('SELECT next_run_at FROM jobs WHERE id=?').get(idSec).next_run_at - L(21, 13, 0)));
await runDueJobs(env, L(21, 12, 59));
ck('同一分钟内重复扫描不重复触发', countJob(idSec) === 1, 'c=' + countJob(idSec));
db.prepare('DELETE FROM jobs WHERE id=?').run(idSec);

// 20.2 库里遗留的「带秒 next_run_at」（这次改动之前建的周期任务）在下次触发时自愈，无需数据迁移
const idLegacy = insertJob('every:1m', L(21, 20, 30));
await runDueJobs(env, L(21, 21, 0));
ck('遗留带秒数据仍能触发', countJob(idLegacy) === 1, 'c=' + countJob(idLegacy));
ck('遗留带秒数据自愈为整分钟',
  db.prepare('SELECT next_run_at FROM jobs WHERE id=?').get(idLegacy).next_run_at === L(21, 22, 0),
  String(db.prepare('SELECT next_run_at FROM jobs WHERE id=?').get(idLegacy).next_run_at - L(21, 22, 0)));
db.prepare('DELETE FROM jobs WHERE id=?').run(idLegacy);

/* ---------------- 跳过节假日（skip_holiday） ---------------- */

// 清空 jobs 表：前面用例遗留的启用任务 next_run_at 都很早（2026-09-10 附近），若不清空，
// 后面用 2026-10 的时间戳调用 runDueJobs 会把它们一并扫到、干扰「只验证本组任务」的断言。
db.prepare('DELETE FROM jobs').run();

// 21) 周期任务在节假日当天：只推进 next_run_at，不投递；次日（工作日）正常触发
const holidayTs = Date.UTC(2026, 9, 1, 1, 0, 0);   // 本地(+08:00) 2026-10-01 09:00
const idH = insertJob('daily:09:00', holidayTs, 1, '节假日跳过');
db.prepare('UPDATE jobs SET skip_holiday=1 WHERE id=?').run(idH);
await runDueJobs(env, holidayTs);
ck('节假日当天不投递', countJob(idH) === 0, 'c=' + countJob(idH));
ck('节假日跳过后推进到次日',
  db.prepare('SELECT next_run_at FROM jobs WHERE id=?').get(idH).next_run_at === Date.UTC(2026, 9, 2, 1, 0, 0));
// 次日（工作日）应正常触发
await runDueJobs(env, Date.UTC(2026, 9, 2, 1, 0, 0));
ck('次日（工作日）正常触发', countJob(idH) === 1, 'c=' + countJob(idH));
db.prepare('DELETE FROM jobs WHERE id=?').run(idH);

// 22) 工作日启用跳过开关时照常触发（开关不误伤工作日）
const idW = insertJob('daily:09:00', Date.UTC(2026, 9, 5, 1, 0, 0), 1, '工作日触发');  // 2026-10-05 周一
db.prepare('UPDATE jobs SET skip_holiday=1 WHERE id=?').run(idW);
await runDueJobs(env, Date.UTC(2026, 9, 5, 1, 0, 0));
ck('工作日（跳过开关开）照常触发', countJob(idW) === 1, 'c=' + countJob(idW));
db.prepare('DELETE FROM jobs WHERE id=?').run(idW);

// 23) once 任务忽略跳过开关：指定日期即便是节假日也会触发并自动停用
const idO = insertJob('once:2026-10-01T09:00', Date.UTC(2026, 9, 1, 1, 0, 0), 1, '一次性节假日');
db.prepare('UPDATE jobs SET skip_holiday=1 WHERE id=?').run(idO);
await runDueJobs(env, Date.UTC(2026, 9, 1, 1, 0, 0));
ck('once 忽略跳过开关仍触发', countJob(idO) === 1, 'c=' + countJob(idO));
ck('once 触发后自动停用', db.prepare('SELECT enabled FROM jobs WHERE id=?').get(idO).enabled === 0);
db.prepare('DELETE FROM jobs WHERE id=?').run(idO);

console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
process.exit(bad ? 1 : 0);
