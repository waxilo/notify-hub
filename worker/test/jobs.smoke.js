// 定时任务端到端冒烟测试（对真实 MySQL 跑，连接参数来自 DB_* 环境变量，见 scripts/db-init.sh）
// 覆盖：到期触发 / next_run_at 推进 / 并发重复执行拦截 / 一次性任务自动停用 / 索引命中
//      / 与外部 key 解耦（通知不带 key、标题取任务名称）
//      / 通知归到 job_id（可查历史、可按 job 或按 key 清空、删任务/删 key 连带清历史）
//      / 停用 key 的调用留痕（rejected=key_disabled，只入库不推送、窗口内不刷屏）
//      / QQ 官方机器人触达（触发即发群/私聊消息，目标由机器人的 target 决定；网关失败不影响入库）
// 运行：cd worker && DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=notify_hub_test node test/jobs.smoke.js
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDueJobs, deleteJob, listJobs, createJob, updateJob } from '../src/jobs.js';
import { nextRunAt } from '../src/schedule.js';
import { clearNotifications } from '../src/notifications.js';
import { deleteKey, updateKey } from '../src/keys.js';
import { handleWebhook } from '../src/webhook.js';
import { createDatabase, databaseConfigFromEnv } from '../src/db.js';

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

/* ---------------- 测试库 ---------------- */

// 连接参数优先取环境变量，其次 .env.test（scripts/db-init.sh 为测试库生成的那份），
// 最后才退回 .env —— 退回后 DB_NAME 是生产库名，会立刻被下面那道 _test 闸门拦下。
// 这样 npm test 不用每条命令前面手写一遍 DB_*，也不可能顺手连上生产库。
if (!process.env.DB_HOST) {
  for (const p of ['../../.env.test', '../../.env', '../.env.test']) {
    try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), p)); break; } catch { /* 换下一个候选路径 */ }
  }
}

// 为什么不再是 node:sqlite 内存库：src/*.js 的 SQL 已是 MySQL 方言（INSERT IGNORE、
// ON DUPLICATE KEY UPDATE、反引号包住的保留字），SQLite 解析不了 ——
// 留在内存库上只会得到「全绿但测的不是生产方言」，那比红更没用。
//
// 每次运行都 DROP 全部表、再按 db/schema.mysql.sql 重建：测的就是那份 schema 本身，
// 改了 src 的 SQL 却没同步 schema 会立刻红，而不是等线上第一个请求发现。
// 只允许跑在 *_test 库上：这里删的是本库所有表，DB_NAME 手滑写成生产库就是一次删库事故。
const cfg = databaseConfigFromEnv(process.env);
if (!/_test$/.test(cfg.database)) {
  console.error(`DB_NAME="${cfg.database}" 不是测试库（必须以 _test 结尾）—— 本测试会 DROP 全部表，拒绝执行`);
  process.exit(1);
}
const db = createDatabase(cfg);
// 机器人凭证 / 触达目标**不从 env 读**（那是全局单份的，会让没配机器人的账号共用同一个机器人）。
// env 里只有 DB 绑定，全部配置走 bots / bot_targets 表 —— 与生产完全同一份 env.DB 适配层。
const env = { DB: db.DB };

// mysql2 关掉了多语句执行（multipleStatements:false，杜绝 ; 拼出第二条语句），
// 所以建表要按语句拆开逐条跑。schema 里的注释行以 -- 开头，先剔掉再拆。
const schemaStatements = () => readFileSync(new URL('../db/schema.mysql.sql', import.meta.url), 'utf8')
  .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  .split(';').map((s) => s.trim()).filter(Boolean);

// 连不上 / 建不起来就硬失败退出，绝不跳过：静默的绿是假的安全感
// （本项目吃过一次教训 —— 路由没注册却返回 404，前端吞掉，藏了好几个月）。
try {
  for (const t of ['bot_targets', 'bots', 'notifications', 'jobs', 'keys', 'settings', 'users']) {
    await db.DB.prepare(`DROP TABLE IF EXISTS \`${t}\``).run();
  }
  for (const stmt of schemaStatements()) await db.DB.prepare(stmt).run();
} catch (err) {
  console.error(`测试库初始化失败（${cfg.host}:${cfg.port}/${cfg.database}）：${err.message}`);
  process.exit(1);
}

// 三个助手就是 env.DB 的薄封装。SQLite 那套同步外观在 MySQL 上不存在，
// 所以每个 DB 调用都必须 await（undefined 绑定抛 D1_TYPE_ERROR 的安全网在生产适配层里，行为不变）。
const q = async (sql, ...p) => (await env.DB.prepare(sql).bind(...p).first()) ?? null;
const qa = async (sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results ?? [];
const qx = async (sql, ...p) => await env.DB.prepare(sql).bind(...p).run();

let bad = 0;
const ck = (name, cond, extra) => {
  if (!cond) { bad++; console.log('FAIL ', name, extra ?? ''); } else console.log('ok   ', name, extra ?? '');
};

const now = Date.UTC(2026, 8, 10, 1, 0, 0);           // 本地(+08:00) 2026-09-10 09:00
await qx('INSERT INTO users (id, username, pass_hash, pass_salt, created_at) VALUES (1,?,?,?,?)', 'u', 'h', 's', now);
await qx('INSERT INTO `keys` (id, user_id, `key`, name, created_at, active, mode) VALUES (1,1,?,?,?,1,?)', 'k1', '告警通道', now, 'default');

// 用户 1 的默认机器人：凭证 + 消息模板（NULL = 内置默认模板）+ 群名单。
// 重构前这些从 env / settings 读，现在是**每个账号自己的** bots / bot_targets 行。
const addBot = async (id, userId, name, appId, secret, target, isDefault = 0) => {
  await qx(`INSERT INTO bots (id, user_id, name, app_id, app_secret, target, msg_template, is_default, created_at, updated_at)
     VALUES (?,?,?,?,?,?,NULL,?,?,?)`, id, userId, name, appId, secret, target, isDefault, now, now);
  return id;
};
const addTarget = async (botId, kind, openid) => qx('INSERT IGNORE INTO bot_targets (bot_id, kind, openid, created_at) VALUES (?,?,?,?)', botId, kind, openid, now);

await addBot(1, 1, '默认机器人', 'TEST_APP_ID', 'TEST_APP_SECRET', 'group', 1);
await addTarget(1, 'group', 'GROUP_OPENID_X');

const insertJob = async (schedule, nextRunAtVal, enabled = 1, name = '任务', body = '') => {
  const r = await qx('INSERT INTO jobs (user_id, key_id, name, schedule, tz, title, body, enabled, next_run_at, created_at, updated_at) VALUES (1,NULL,?,?,?,NULL,?,?,?,?,?)', name, schedule, '+08:00', body, enabled, nextRunAtVal, now, now);
  return Number(r.meta.last_row_id);
};

// 1) 到期 job 触发
const id1 = await insertJob('every:5m', now - 1000);
let r = await runDueJobs(env, now);
ck('tick 触发 1 个', r.scanned === 1 && r.fired === 1, JSON.stringify(r));
let n = await q('SELECT COUNT(*) c FROM notifications');
ck('产生 1 条通知', n.c === 1, 'count=' + n.c);
ck('调用 QQ 群消息接口', qqCalls.length === 1, JSON.stringify(qqCalls[0] || {}));
ck('QQ 消息标题取任务名称（默认模板）',
  qqCalls[0].text.startsWith('📢 任务\n━━━━━━━━━━━━━━\n任务\n\n🕐 '),
  JSON.stringify(qqCalls[0].text));
ck('QQ 消息为文本类型', qqCalls[0].msg_type === 0, JSON.stringify(qqCalls[0].msg_type));
// 推的是「这个账号自己的机器人」的凭证与名单（机器人已按账号隔离，不再有全局 env 兜底）
ck('首次推送用账号默认机器人的凭证',
  qqTokenCalls.length === 1 && qqTokenCalls[0].appId === 'TEST_APP_ID' && qqTokenCalls[0].clientSecret === 'TEST_APP_SECRET',
  JSON.stringify(qqTokenCalls[0] || {}));
ck('推的是该机器人的群名单', qqCalls[0].to === 'GROUP_OPENID_X', JSON.stringify(qqCalls[0] || {}));
ck('通知不挂 key_id', (await q('SELECT key_id FROM notifications')).key_id === null);
// 通知归到任务名下：任务列表能统计「已发送 N 条」，也能按任务查历史
ck('通知归到 job_id', (await q('SELECT job_id FROM notifications')).job_id === id1,
  'job_id=' + (await q('SELECT job_id FROM notifications')).job_id);
ck('QQ 推送成功写入 delivered_at',
  (await q('SELECT delivered_at FROM notifications WHERE job_id=?', id1)).delivered_at !== null);
let j = await q('SELECT * FROM jobs WHERE id=?', id1);
// 间隔基于「计划时刻」递推而非当前时间，避免漂移；且该基准先对齐整分钟（丢弃创建/执行时刻的秒），
// 所以是 floor(now-1000)+5m = 09:04:00，不是 (now-1000)+5m
ck('next_run_at 已推进', j.next_run_at === now + 4 * 60000, String(j.next_run_at - now));
ck('last_run_at 已写入', j.last_run_at === now - 1000, String(j.last_run_at));
ck('dedup_key 带计划时刻', (await q('SELECT dedup_key FROM notifications')).dedup_key === `job:${id1}:${now - 1000}`);

// 2) 未到期的 job 不触发
r = await runDueJobs(env, now + 60000);
ck('未到期不触发', r.scanned === 0, JSON.stringify(r));

// 3) 下一次到期正常触发
r = await runDueJobs(env, now + 5 * 60000);
ck('5 分钟后再次触发', r.fired === 1);
ck('累计 2 条通知', (await q('SELECT COUNT(*) c FROM notifications')).c === 2);

// 4) 并发/重入：把 next_run_at 拨回「已执行过的同一时刻」再跑一次，dedup_key 应拦住重复通知
//    （用上一次真正触发过的计划时刻 now+4m，即 09:04:00，dedup_key 才会命中窗口）
await qx('UPDATE jobs SET next_run_at=? WHERE id=?', now + 4 * 60000, id1);
const before = (await q('SELECT COUNT(*) c FROM notifications')).c;
await runDueJobs(env, now + 5 * 60000);
ck('重复执行被 dedup 拦截', (await q('SELECT COUNT(*) c FROM notifications')).c === before,
  'notif=' + (await q('SELECT COUNT(*) c FROM notifications')).c);

// 后面的用例要求环境干净，先清掉这个每 5 分钟的任务
await qx('DELETE FROM jobs WHERE id=?', id1);

// 5) 一次性任务执行后自动停用；标题/正文按「任务名称 / 通知内容」落库
const id5 = await insertJob('once:2026-09-10T09:00', now - 5000, 1, '只跑一次', '正文来自通知内容');
await runDueJobs(env, now + 10 * 60000);
j = await q('SELECT * FROM jobs WHERE id=?', id5);
ck('一次性任务执行后停用', j.enabled === 0, 'enabled=' + j.enabled);
const cntOnce = async () => (await q('SELECT COUNT(*) c FROM notifications WHERE dedup_key LIKE ?', `job:${id5}:%`)).c;
ck('一次性任务已产生通知', await cntOnce() === 1, 'c=' + await cntOnce());
const onceN = await q('SELECT title, body, key_id FROM notifications WHERE dedup_key LIKE ?', `job:${id5}:%`);
ck('标题取任务名称', onceN.title === '只跑一次', JSON.stringify(onceN.title));
ck('正文取通知内容', onceN.body === '正文来自通知内容', JSON.stringify(onceN.body));
ck('一次性任务通知也不挂 key', onceN.key_id === null);
await runDueJobs(env, now + 20 * 60000);
ck('停用后不再触发', await cntOnce() === 1, 'c=' + await cntOnce());

// 6) 停用的 job 不进入扫描
const id6 = await insertJob('every:1m', now, 0);
r = await runDueJobs(env, now + 30 * 60000);
ck('停用 job 不进入扫描', r.scanned === 0, JSON.stringify(r));
await qx('DELETE FROM jobs WHERE id=?', id6);

// 7) 已解耦：key 全部删掉后，任务照常触发（旧实现会让通知标题变成「(已删除)」）
await qx('DELETE FROM `keys`');
const id7 = await insertJob('every:1m', now - 1, 1, '没有 key 也能跑');
r = await runDueJobs(env, now + 31 * 60000);
ck('无 key 仍能触发', r.fired === 1, JSON.stringify(r));
const n7 = await q('SELECT title FROM notifications WHERE dedup_key LIKE ?', `job:${id7}:%`);
ck('标题不受 key 删除影响', n7 && n7.title === '没有 key 也能跑', JSON.stringify(n7));
await qx('DELETE FROM jobs WHERE id=?', id7);

// 8) 索引命中
// SQLite 的 EXPLAIN QUERY PLAN 无论如何都会写明索引用没用；MySQL 的优化器按行数估算决定，
// 近乎空的表一定选全表扫 —— 那时「命中 idx_jobs_due」这句断言恒真、等于没测。
// 所以先灌一批「十年后才到期」的行（选择性由此变成真的），EXPLAIN 完立刻清掉，不干扰后续计数。
const FAR_FUTURE = now + 10 * 365 * 86_400_000;
const seedFutureJobs = async (n) => {
  const vals = [];
  for (let i = 0; i < n; i++) vals.push('planner-seed', 'every:1m', '+08:00', FAR_FUTURE + i * 60_000, now, now);
  await qx(`INSERT INTO jobs (user_id, key_id, name, schedule, tz, title, body, enabled, next_run_at, created_at, updated_at)
            VALUES ${Array.from({ length: n }, () => '(1,NULL,?,?,?,NULL,NULL,1,?,?,?)').join(',')}`, ...vals);
};
await seedFutureJobs(400);
const plan = await qa('EXPLAIN SELECT * FROM jobs WHERE enabled=1 AND next_run_at<=?', now);
ck('扫描命中 idx_jobs_due', plan.some((r) => r.key === 'idx_jobs_due'), JSON.stringify(plan));
await qx("DELETE FROM jobs WHERE name='planner-seed'");

// 9) 扫描语句里不应再有 keys 连接（防止以后又被加回来；连 `key_name` 一起卡住）
const scanSrc = String(runDueJobs);
const joined = /LEFT\s+JOIN|key_name/i.test(scanSrc);
ck('扫描不再关联 keys', !joined, joined ? 'still-joined' : 'clean');

/* ---------------- 历史归档与清空 ---------------- */

const countAll = async () => (await q('SELECT COUNT(*) c FROM notifications')).c;
const countJob = async (id) => (await q('SELECT COUNT(*) c FROM notifications WHERE job_id=?', id)).c;
const countKey = async (id) => (await q('SELECT COUNT(*) c FROM notifications WHERE key_id=?', id)).c;
const clear = async (qs) => {
  const r = await clearNotifications(new Request('https://x/api/notifications' + qs, { method: 'DELETE' }), env, 1);
  return { status: r.status, body: await r.json() };
};
// 造一条「外部系统经 /hook/:key 写入」的通知，用来验证两个维度互不误伤
await qx('INSERT INTO `keys` (id, user_id, `key`, name, created_at, active, mode) VALUES (2,1,?,?,?,1,?)', 'k2', '外部通道', now, 'default');
const insertWebhookNotif = async () => qx('INSERT INTO notifications (user_id, key_id, job_id, dedup_key, title, body, created_at, `read`) VALUES (1,2,NULL,?,?,?,?,0)', 'srv-' + Math.random().toString(36).slice(2), '外部通道', '来自外部', now);

// 10) 任务列表带「已发送 N 条」
const idA = await insertJob('every:1m', now - 1, 1, '任务A');
await runDueJobs(env, now + 40 * 60000);
ck('任务A 已产生通知', await countJob(idA) === 1, 'c=' + await countJob(idA));
ck('任务通知的 key_id 为空', (await q('SELECT key_id FROM notifications WHERE job_id=?', idA)).key_id === null);
let listResp = await (await listJobs(new Request('https://x/api/jobs'), env, 1)).json();
ck('列表返回 sent_count', listResp.jobs.find((x) => x.id === idA)?.sent_count === 1,
  JSON.stringify(listResp.jobs.map((x) => [x.id, x.sent_count])));
const idC = await insertJob('every:9m', now + 10 * 3600 * 1000, 1, '从未触发');
listResp = await (await listJobs(new Request('https://x/api/jobs'), env, 1)).json();
ck('从未触发的任务 sent_count=0', listResp.jobs.find((x) => x.id === idC)?.sent_count === 0,
  JSON.stringify(listResp.jobs.find((x) => x.id === idC)));

await insertWebhookNotif();
const base = await countAll();

// 11) 清空：必须带 key_id 或 job_id，两个维度互不误伤
let c = await clear('');
ck('无参数清空被拒绝', c.status === 400, JSON.stringify(c));
ck('被拒绝时不删任何数据', await countAll() === base, 'c=' + await countAll());

c = await clear('?key_id=2');
ck('按 key 清空只删该 key 的', c.body.deleted === 1 && await countKey(2) === 0, JSON.stringify(c.body));
ck('按 key 清空不动任务历史', await countJob(idA) === 1, 'job=' + await countJob(idA));
ck('按 key 清空后总数 -1', await countAll() === base - 1, 'c=' + await countAll());

await insertWebhookNotif();
c = await clear('?job_id=' + idA);
ck('按 job 清空只删该任务的', c.body.deleted === 1 && await countJob(idA) === 0, JSON.stringify(c.body));
ck('按 job 清空不动 key 历史', await countKey(2) === 1, 'key=' + await countKey(2));
// 清空后任务仍在、下个周期照常触发
await qx('UPDATE jobs SET enabled=0 WHERE id=?', idA);   // 冻住，避免干扰后续用例的计数

// 12) 删除任务时连带清空它的历史
const idB = await insertJob('every:1m', now - 1, 1, '任务B');
await runDueJobs(env, now + 41 * 60000);
ck('任务B 已产生通知', await countJob(idB) === 1, 'c=' + await countJob(idB));
const beforeB = await countAll();
const d404 = await deleteJob(new Request('https://x/api/jobs/99999', { method: 'DELETE' }), env, 1, 99999);
ck('删除不存在的任务返回 404', d404.status === 404, 'status=' + d404.status);
ck('删除不存在的任务不动历史', await countAll() === beforeB, 'c=' + await countAll());
await deleteJob(new Request('https://x/api/jobs/' + idB, { method: 'DELETE' }), env, 1, idB);
ck('删任务后任务行消失', (await q('SELECT COUNT(*) c FROM jobs WHERE id=?', idB)).c === 0);
ck('删任务连带清空其历史', await countJob(idB) === 0, 'job=' + await countJob(idB));
ck('删任务不误伤其他历史', await countAll() === beforeB - 1, 'c=' + await countAll());

// 13) 删除 key 时连带清空它的历史（原有行为，这里钉住防回归）
await insertWebhookNotif();
const beforeDelKey = await countAll();
const keyNotifs = await countKey(2);          // 该 key 名下已累积的历史条数
ck('删 key 前确实有历史', keyNotifs >= 1, 'c=' + keyNotifs);
await deleteKey(new Request('https://x/api/keys/2', { method: 'DELETE' }), env, 1, 2);
ck('删 key 后 key 行消失', (await q('SELECT COUNT(*) c FROM `keys` WHERE id=2')).c === 0);
ck('删 key 连带清空其历史', await countKey(2) === 0, 'key=' + await countKey(2));
ck('删 key 只删该 key 的历史', await countAll() === beforeDelKey - keyNotifs, 'c=' + await countAll());

// 14) job_id 相关查询命中索引（否则每查一次历史都要全表扫该用户全部通知）
// 同 8) 的理由：先灌一批「不属于任何任务」的历史（job_id 为 NULL），让选择性变成真的
const seedKeyNotifs = async (n) => {
  const vals = [];
  for (let i = 0; i < n; i++) vals.push('planner-seed', now);
  await qx(`INSERT INTO notifications (user_id, key_id, job_id, dedup_key, title, body, created_at, \`read\`)
            VALUES ${Array.from({ length: n }, () => "(1,2,NULL,'planner-seed',?,NULL,?,0)").join(',')}`, ...vals);
};
await seedKeyNotifs(400);
const planJob = await qa('EXPLAIN SELECT COUNT(*) FROM notifications WHERE user_id=1 AND job_id=1');
ck('按 job 查询命中 idx_notif_job', planJob.some((r) => r.key === 'idx_notif_job'), JSON.stringify(planJob));
const planGroup = await qa('EXPLAIN SELECT job_id, COUNT(*) FROM notifications WHERE user_id=1 AND job_id IS NOT NULL GROUP BY job_id');
ck('统计查询命中 idx_notif_job', planGroup.some((r) => r.key === 'idx_notif_job'), JSON.stringify(planGroup));
await qx("DELETE FROM notifications WHERE title='planner-seed'");

/* ---------------- 停用 key 的调用留痕 ---------------- */

// 15) key 停用后外部往往还在按原节奏调用：不能静默 403，要在历史里留一条「停用拒绝」
await qx('INSERT INTO `keys` (id, user_id, `key`, name, created_at, active, mode) VALUES (3,1,?,?,?,0,?)', 'k3', '停用通道', now, 'default');
const qqBefore = qqCalls.length;
const notifBefore = await countAll();
const hook = (qs = '') => handleWebhook(new Request('https://x/hook/k3' + qs, { method: 'GET' }), env, 'k3');

let hr = await hook('?message=' + encodeURIComponent('外部还在发'));
ck('停用 key 调用仍返回 403', hr.status === 403, 'status=' + hr.status);
ck('停用调用被留痕', await countAll() === notifBefore + 1, 'c=' + await countAll());
const rej = await q('SELECT * FROM notifications WHERE key_id=3 ORDER BY id DESC LIMIT 1');
ck('留痕标记 key_disabled', rej && rej.rejected === 'key_disabled', JSON.stringify(rej && rej.rejected));
ck('留痕标题取 key 名', rej && rej.title === '停用通道', JSON.stringify(rej && rej.title));
ck('留痕保留原始内容', rej && rej.body === '外部还在发', JSON.stringify(rej && rej.body));
ck('留痕不挂 job_id', rej && rej.job_id === null);
ck('留痕记在 key_id 上', rej && rej.key_id === 3);
ck('停用调用不推送 QQ', qqCalls.length === qqBefore, 'qq=' + (qqCalls.length - qqBefore));
ck('停用调用不更新 last_used', (await q('SELECT last_used FROM `keys` WHERE id=3')).last_used === null);

// 同一 5 分钟窗口内重复调用不再新增（外部高频重试不会把历史刷爆）
hr = await hook('?message=' + encodeURIComponent('再来一次'));
ck('窗口内重复调用不刷屏', await countAll() === notifBefore + 1 && hr.status === 403, 'c=' + await countAll());

// 重新启用后恢复正常：写入 + QQ 推送，且不受前面的拒绝记录影响
await qx('UPDATE `keys` SET active=1 WHERE id=3');
const qqBefore2 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('恢复后正常'), { method: 'GET' }), env, 'k3');
ck('启用后调用恢复正常', hr.status === 201, 'status=' + hr.status);
ck('启用后正常推送 QQ', qqCalls.length === qqBefore2 + 1, 'qq=' + (qqCalls.length - qqBefore2));
ck('启用后写入的是正常记录', (await q('SELECT rejected FROM notifications WHERE key_id=3 ORDER BY id DESC LIMIT 1')).rejected === null);
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
const failN = await q('SELECT * FROM notifications WHERE body=?', 'QQ挂了也要入库');
ck('QQ 失败时通知仍入库', !!failN, JSON.stringify(failN && failN.id));
ck('QQ 失败时 delivered_at 为空（历史显示未送达）', failN && failN.delivered_at === null);
qqSendFail = false;

// 17) 机器人还没绑群（名单为空）：同样只入库不推送
await qx("DELETE FROM bot_targets WHERE bot_id=1 AND kind='group'");
const qqBefore4 = qqCalls.length;
const notifBefore4 = await countAll();
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('没配群号'), { method: 'GET' }), env, 'k3');
ck('名单为空时仍返回 201', hr.status === 201, 'status=' + hr.status);
ck('名单为空时不调 QQ', qqCalls.length === qqBefore4, 'qq=' + (qqCalls.length - qqBefore4));
ck('名单为空时通知仍入库', await countAll() === notifBefore4 + 1, 'c=' + await countAll());
await addTarget(1, 'group', 'GROUP_OPENID_X');   // 还原

/* ---------------- 触达目标（机器人自己的 target：group / c2c / both） ---------------- */

const lastCall = () => qqCalls[qqCalls.length - 1];
// 第 i 次 token 请求用的 appId —— 用来确认「这次推送用的是哪个机器人的凭证」。
// 注意 token 是按 appId|secret 缓存的，所以只在某个机器人**首次**被使用时才会出现新请求；
// 下面的断言都挑「该机器人第一次推送」的时机来做。
const tokenAppIdAt = (i) => (qqTokenCalls[i] || {}).appId;
const setTarget = async (t, botId = 1) => qx('UPDATE bots SET target=? WHERE id=?', t, botId);
// 模拟「私聊机器人一句话」后的自动捕获结果（记在该机器人名下）
await addTarget(1, 'c2c', 'USER_OPENID_X');

// 17a) target=group：只发群（私聊名单里有人也不发）
await setTarget('group');
let q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('默认发群'), { method: 'GET' }), env, 'k3');
ck('target=group 只发群', hr.status === 201 && qqCalls.length === q0 + 1 && lastCall().kind === 'groups',
  JSON.stringify(lastCall() || {}));

// 17b) target=c2c：只发私聊
await setTarget('c2c');
q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('发私聊'), { method: 'GET' }), env, 'k3');
ck('target=c2c 只发私聊', hr.status === 201 && qqCalls.length === q0 + 1
  && lastCall().kind === 'users' && lastCall().to === 'USER_OPENID_X',
  JSON.stringify(lastCall() || {}));
ck('c2c 推送成功写 delivered_at',
  (await q('SELECT delivered_at FROM notifications WHERE body=?', '发私聊')).delivered_at !== null);

// 17c) target=both：群 + 私聊各一条
await setTarget('both');
q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('都发'), { method: 'GET' }), env, 'k3');
ck('target=both 发两条', hr.status === 201 && qqCalls.length === q0 + 2, 'qq=' + (qqCalls.length - q0));
ck('both 覆盖群与私聊', qqCalls.slice(q0).map((c) => c.kind).sort().join() === 'groups,users',
  JSON.stringify(qqCalls.slice(q0).map((c) => c.kind)));

// 17d) target 非法值回落 group（不发私聊）—— 与重构前 settings/env 时代的兜底一致
await setTarget('nonsense');
q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('非法目标'), { method: 'GET' }), env, 'k3');
ck('非法 target 回落 group', hr.status === 201 && qqCalls.length === q0 + 1 && lastCall().kind === 'groups',
  JSON.stringify(lastCall() || {}));

// 17e) target=c2c 但该机器人还没捕获私聊 openid：只入库不推送
await setTarget('c2c');
await qx("DELETE FROM bot_targets WHERE bot_id=1 AND kind='c2c'");
const notifBeforeE = await countAll();
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('没配私聊'), { method: 'GET' }), env, 'k3');
ck('未捕获私聊 openid 时仍返回 201', hr.status === 201, 'status=' + hr.status);
ck('未捕获私聊 openid 时通知仍入库', await countAll() === notifBeforeE + 1, 'c=' + await countAll());
ck('未捕获私聊 openid 时 delivered_at 为空',
  (await q('SELECT delivered_at FROM notifications WHERE body=?', '没配私聊')).delivered_at === null);
await addTarget(1, 'c2c', 'USER_OPENID_X');

// 17f) 多好友扇出：该机器人的名单里两个 openid 都收到（多个好友加机器人 = 人人都收）
await addTarget(1, 'c2c', 'USER_B');
q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('多好友扇出'), { method: 'GET' }), env, 'k3');
ck('多好友名单逐个扇出', hr.status === 201 && qqCalls.length === q0 + 2
  && qqCalls[q0].kind === 'users' && qqCalls[q0].to === 'USER_OPENID_X'
  && qqCalls[q0 + 1].kind === 'users' && qqCalls[q0 + 1].to === 'USER_B',
  JSON.stringify(qqCalls.slice(q0)));
ck('扇出任一送达即写 delivered_at',
  (await q('SELECT delivered_at FROM notifications WHERE body=?', '多好友扇出')).delivered_at !== null);

/* ---------------- 账号隔离：机器人是每账号各自的（本次重构的核心） ---------------- */

// 用户 2 接入**自己的**机器人（不同 AppID/Secret、不同名单），与用户 1 互不可见
await qx('INSERT INTO users (id, username, pass_hash, pass_salt, created_at) VALUES (2,?,?,?,?)', 'u2', 'h', 's', now);
await qx('INSERT INTO `keys` (id, user_id, `key`, name, created_at, active, mode) VALUES (9,2,?,?,?,1,?)', 'k9', '用户2的通道', now, 'default');
await addBot(2, 2, '用户2的机器人', 'APP_ID_2', 'SECRET_2', 'both', 1);
await addTarget(2, 'c2c', 'USER2_OPENID');
await addTarget(2, 'group', 'GROUP2_OPENID');

q0 = qqCalls.length;
const tok0 = qqTokenCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k9?message=' + encodeURIComponent('用户2的通知'), { method: 'GET' }), env, 'k9');
ck('用户2 的通知用用户2 自己的凭证换 token',
  qqTokenCalls.length === tok0 + 1 && tokenAppIdAt(tok0) === 'APP_ID_2',
  JSON.stringify(qqTokenCalls[tok0] || {}));
const u2calls = qqCalls.slice(q0);
ck('用户2 的通知只发给用户2 的名单',
  u2calls.length === 2 && u2calls.map((c) => c.to).sort().join() === 'GROUP2_OPENID,USER2_OPENID',
  JSON.stringify(u2calls));

// 用户 1 的通知仍然走用户 1 的机器人（互不串台）
q0 = qqCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('用户1的通知'), { method: 'GET' }), env, 'k3');
ck('用户1 的通知仍走用户1 的机器人（凭证 + 名单都没被串）',
  hr.status === 201 && qqCalls.length === q0 + 2
  && qqCalls.slice(q0).map((c) => c.to).sort().join() === 'USER_B,USER_OPENID_X',
  JSON.stringify(qqCalls.slice(q0)));

// 17g) key 绑定到指定机器人：用户 1 再建一个「运维机器人」，把 k3 指过去
await addBot(3, 1, '运维机器人', 'APP_ID_3', 'SECRET_3', 'group');
await addTarget(3, 'group', 'GROUP_OPS');
const bindRes = await updateKey(new Request('https://x/api/keys/3', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot_id: 3 }),
}), env, 1, 3);
ck('key 可以绑定到指定机器人', bindRes.status === 200 && (await q('SELECT bot_id FROM `keys` WHERE id=3')).bot_id === 3,
  'status=' + bindRes.status);
q0 = qqCalls.length;
const tok1 = qqTokenCalls.length;
hr = await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('运维告警'), { method: 'GET' }), env, 'k3');
ck('绑定后走指定机器人的凭证与名单',
  qqCalls.length === q0 + 1 && lastCall().to === 'GROUP_OPS' && tokenAppIdAt(tok1) === 'APP_ID_3',
  JSON.stringify({ call: lastCall(), token: qqTokenCalls[tok1] }));

// 跨账号绑定必须被拒绝：A 账号不能把自己的 key 指向 B 账号的机器人
const crossBind = await updateKey(new Request('https://x/api/keys/3', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot_id: 2 }),
}), env, 1, 3);
ck('跨账号绑定机器人被拒绝（400）', crossBind.status === 400, 'status=' + crossBind.status);
ck('被拒绝后绑定保持不变', (await q('SELECT bot_id FROM `keys` WHERE id=3')).bot_id === 3);

// 解绑（bot_id=null）→ 回落账号默认机器人
await updateKey(new Request('https://x/api/keys/3', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot_id: null }),
}), env, 1, 3);
ck('解绑后 bot_id 归 NULL（回落默认机器人）', (await q('SELECT bot_id FROM `keys` WHERE id=3')).bot_id === null);
await setTarget('group');
q0 = qqCalls.length;
await handleWebhook(new Request('https://x/hook/k3?message=' + encodeURIComponent('解绑后回落'), { method: 'GET' }), env, 'k3');
ck('解绑后确实回到默认机器人的群', lastCall().kind === 'groups' && lastCall().to === 'GROUP_OPENID_X',
  JSON.stringify(lastCall() || {}));

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
  (await q('SELECT skip_holiday FROM jobs WHERE id=?', newJobId)).skip_holiday === 1);

const upRes = await updateJob(new Request('https://x/api/jobs/' + newJobId, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: mkBody({ skip_holiday: false }),
}), env, 1, newJobId);
ck('updateJob 返回 200（原为 500）', upRes.status === 200, 'status=' + upRes.status);
ck('updateJob 写入 skip_holiday=0',
  (await q('SELECT skip_holiday FROM jobs WHERE id=?', newJobId)).skip_holiday === 0);

await updateJob(new Request('https://x/api/jobs/' + newJobId, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '改个名' }),
}), env, 1, newJobId);
ck('updateJob 不传开关时保留原值',
  (await q('SELECT skip_holiday FROM jobs WHERE id=?', newJobId)).skip_holiday === 0);

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
const idSec = await insertJob('every:1m', L(21, 12, 0));
await runDueJobs(env, L(21, 11, 59));
ck('未到计划分钟不提前触发', await countJob(idSec) === 0, 'c=' + await countJob(idSec));
await runDueJobs(env, L(21, 12, 10));
ck('tick 落在分钟后 10 秒仍触发', await countJob(idSec) === 1, 'c=' + await countJob(idSec));
ck('推进后的计划时刻仍是整分钟',
  (await q('SELECT next_run_at FROM jobs WHERE id=?', idSec)).next_run_at === L(21, 13, 0),
  String((await q('SELECT next_run_at FROM jobs WHERE id=?', idSec)).next_run_at - L(21, 13, 0)));
await runDueJobs(env, L(21, 12, 59));
ck('同一分钟内重复扫描不重复触发', await countJob(idSec) === 1, 'c=' + await countJob(idSec));
await qx('DELETE FROM jobs WHERE id=?', idSec);

// 20.2 库里遗留的「带秒 next_run_at」（这次改动之前建的周期任务）在下次触发时自愈，无需数据迁移
const idLegacy = await insertJob('every:1m', L(21, 20, 30));
await runDueJobs(env, L(21, 21, 0));
ck('遗留带秒数据仍能触发', await countJob(idLegacy) === 1, 'c=' + await countJob(idLegacy));
ck('遗留带秒数据自愈为整分钟',
  (await q('SELECT next_run_at FROM jobs WHERE id=?', idLegacy)).next_run_at === L(21, 22, 0),
  String((await q('SELECT next_run_at FROM jobs WHERE id=?', idLegacy)).next_run_at - L(21, 22, 0)));
await qx('DELETE FROM jobs WHERE id=?', idLegacy);

/* ---------------- 跳过节假日（skip_holiday） ---------------- */

// 清空 jobs 表：前面用例遗留的启用任务 next_run_at 都很早（2026-09-10 附近），若不清空，
// 后面用 2026-10 的时间戳调用 runDueJobs 会把它们一并扫到、干扰「只验证本组任务」的断言。
await qx('DELETE FROM jobs');

// 21) 周期任务在节假日当天：只推进 next_run_at，不投递；次日（工作日）正常触发
const holidayTs = Date.UTC(2026, 9, 1, 1, 0, 0);   // 本地(+08:00) 2026-10-01 09:00
const idH = await insertJob('daily:09:00', holidayTs, 1, '节假日跳过');
await qx('UPDATE jobs SET skip_holiday=1 WHERE id=?', idH);
await runDueJobs(env, holidayTs);
ck('节假日当天不投递', await countJob(idH) === 0, 'c=' + await countJob(idH));
ck('节假日跳过后推进到次日',
  (await q('SELECT next_run_at FROM jobs WHERE id=?', idH)).next_run_at === Date.UTC(2026, 9, 2, 1, 0, 0));
// 次日（工作日）应正常触发
await runDueJobs(env, Date.UTC(2026, 9, 2, 1, 0, 0));
ck('次日（工作日）正常触发', await countJob(idH) === 1, 'c=' + await countJob(idH));
await qx('DELETE FROM jobs WHERE id=?', idH);

// 22) 工作日启用跳过开关时照常触发（开关不误伤工作日）
const idW = await insertJob('daily:09:00', Date.UTC(2026, 9, 5, 1, 0, 0), 1, '工作日触发');  // 2026-10-05 周一
await qx('UPDATE jobs SET skip_holiday=1 WHERE id=?', idW);
await runDueJobs(env, Date.UTC(2026, 9, 5, 1, 0, 0));
ck('工作日（跳过开关开）照常触发', await countJob(idW) === 1, 'c=' + await countJob(idW));
await qx('DELETE FROM jobs WHERE id=?', idW);

// 23) once 任务忽略跳过开关：指定日期即便是节假日也会触发并自动停用
const idO = await insertJob('once:2026-10-01T09:00', Date.UTC(2026, 9, 1, 1, 0, 0), 1, '一次性节假日');
await qx('UPDATE jobs SET skip_holiday=1 WHERE id=?', idO);
await runDueJobs(env, Date.UTC(2026, 9, 1, 1, 0, 0));
ck('once 忽略跳过开关仍触发', await countJob(idO) === 1, 'c=' + await countJob(idO));
ck('once 触发后自动停用', (await q('SELECT enabled FROM jobs WHERE id=?', idO)).enabled === 0);
await qx('DELETE FROM jobs WHERE id=?', idO);

console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
await db.close();   // 连接池不关，进程会挂在退出流程上
process.exit(bad ? 1 : 0);
