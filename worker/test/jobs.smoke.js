// 定时任务端到端冒烟测试（内存 SQLite，不依赖云端）
// 覆盖：到期触发 / next_run_at 推进 / 并发重复执行拦截 / 一次性任务自动停用 / 索引命中
//      / 与外部 key 解耦（通知不带 key、标题取任务名称）
// 运行：cd worker && node test/jobs.smoke.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runDueJobs } from '../src/jobs.js';
import { parseOffset, nextRunAt } from '../src/schedule.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
// 按真实部署顺序跑迁移：0002 补列（内存库是全新的，ALTER 可直接执行）+ 0003 建 jobs 表
// + 0004 清空 jobs.key_id。
// 注意线上已有库不能跑 0002（列已存在会整批回滚），只跑幂等的 0003 / 0004。
db.exec(readFileSync(new URL('../migrations/0002_schema_sync.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0003_jobs.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0004_jobs_detach_key.sql', import.meta.url), 'utf8'));

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

console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
process.exit(bad ? 1 : 0);
