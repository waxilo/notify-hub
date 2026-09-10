// 定时任务：CRUD + Cron 扫描执行
// 执行完全在服务端：Cron Triggers 每分钟唤醒一次 → 扫 jobs 表 → 到期的写通知并推送。
// App / Web 只负责配置，端侧不需要任何定时器代码（也就没有 Doze、进程被杀、多端重复执行的问题）。
//
// 定时任务不挂 key：key 是给外部系统调 /hook/:key 用的凭证，与站内定时提醒是两条独立来源。
// 定时任务直接产生「默认类型」通知 —— 标题 = 任务名称，正文 = 通知内容（留空则同任务名），
// 不带模板渲染、不占用任何 key，通知的 key_id 为 NULL（也就不会出现在某个 key 的发送历史里）。
import { json, readJson } from './utils.js';
import { parseSchedule, parseOffset, nextRunAt, describeSchedule } from './schedule.js';
import { deliver } from './deliver.js';

const MAX_PER_TICK = 100;        // 单 tick 最多执行的 job 数，超出顺延到下一分钟
const MAX_JOBS_PER_USER = 50;

/* ---------------- Cron 扫描执行 ---------------- */

// nowMs 用 controller.scheduledTime（计划触发时刻），不用 Date.now()，避免把 tick 延迟带进递推
export async function runDueJobs(env, nowMs) {
  const now = Number(nowMs) || Date.now();
  if (!env || !env.DB) return { scanned: 0, fired: 0, errors: 0, skipped: true };

  // 命中 idx_jobs_due：扫到的行数 = 到期 job 数，没有到期时读取行数接近 0
  // 不要在这里 JOIN keys —— 会让扫描退化成带连接的查询，白白多读 keys 表
  const rows = await env.DB.prepare(
    `SELECT * FROM jobs
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at
      LIMIT ?`
  ).bind(now, MAX_PER_TICK).all();

  const list = rows.results || [];
  let fired = 0;
  let errors = 0;
  for (const job of list) {
    try {
      await fireJob(env, job, now);
      fired++;
    } catch (err) {
      errors++;
      console.error('job_fire_failed', JSON.stringify({ id: job.id, err: String(err) }));
    }
  }
  return { scanned: list.length, fired, errors, at: now };
}

async function fireJob(env, job, now) {
  const offset = parseOffset(job.tz) ?? 0;
  const firedAt = Number(job.next_run_at);

  // 默认类型通知：标题固定取任务名称（jobs.title 已废弃不再读取），正文取通知内容。
  // 正文不能为空 —— deliver 对空正文只入库不推送，会让任务看着像没触发。
  const name = String(job.name || '').trim() || '定时提醒';

  // 1) 先投递。dedup_key 带「计划触发时刻」，配合 5 分钟窗口实现幂等：
  //    并发执行或推进 job 失败后重试，都不会产生重复通知。
  //    keyId=null + keyName='' ：这条通知不属于任何外部 key。
  await deliver(env, {
    userId: job.user_id,
    keyId: null,
    keyName: '',
    title: name,
    body: (job.body && String(job.body).trim()) ? job.body : name,
    payload: JSON.stringify({ source: 'job', job_id: job.id, scheduled_at: firedAt }),
    dedupKey: `job:${job.id}:${firedAt}`,
    dedup: true,
  });

  // 2) 再推进 job。顺序不能反：先推进再投递的话，投递失败这条触发就永久丢了。
  //    乐观锁条件带旧 next_run_at，被其他实例抢走时影响行数为 0，直接跳过。
  const next = nextRunAt(job.schedule, offset, now, firedAt);
  const ts = Date.now();
  if (String(job.schedule).startsWith('once:') || next == null) {
    // 一次性任务或计划已失效：执行后自动停用
    await env.DB.prepare(
      'UPDATE jobs SET enabled=0, last_run_at=?, next_run_at=?, updated_at=? WHERE id=? AND next_run_at=?'
    ).bind(firedAt, next, ts, job.id, firedAt).run();
  } else {
    await env.DB.prepare(
      'UPDATE jobs SET next_run_at=?, last_run_at=?, updated_at=? WHERE id=? AND next_run_at=?'
    ).bind(next, firedAt, ts, job.id, firedAt).run();
  }
}

/* ---------------- CRUD ---------------- */

export async function listJobs(request, env, userId) {
  const rows = await env.DB.prepare(
    `SELECT * FROM jobs WHERE user_id = ? ORDER BY enabled DESC, next_run_at`
  ).bind(userId).all();
  const jobs = (rows.results || []).map((j) => ({
    ...j,
    // 标题固定为任务名称，端侧无需再拼接
    title: j.name || '',
    desc: describeSchedule(j.schedule, j.tz),
  }));
  return json({ jobs });
}

export async function createJob(request, env, userId) {
  const b = await readJson(request);

  const schedule = String(b.schedule || '').trim();
  if (!parseSchedule(schedule)) return json({ error: 'invalid schedule' }, 400);
  const tz = String(b.tz || '+08:00').trim();
  const offset = parseOffset(tz);
  if (offset === null) return json({ error: 'invalid tz' }, 400);

  const name = String(b.name || '').trim().slice(0, 64);
  if (!name) return json({ error: 'name is required' }, 400);

  const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM jobs WHERE user_id=?').bind(userId).first();
  if (cnt && cnt.c >= MAX_JOBS_PER_USER) {
    return json({ error: `每个账号最多 ${MAX_JOBS_PER_USER} 个定时任务` }, 400);
  }

  const now = Date.now();
  const next = nextRunAt(schedule, offset, now, now);
  // key_id 恒为 NULL：定时任务不挂外部 key。旧版客户端仍会传 key_id，这里直接忽略（不报错）。
  // title 列已废弃（标题一律取任务名称），保留列不写值。
  const res = await env.DB.prepare(
    `INSERT INTO jobs (user_id, key_id, name, schedule, tz, title, body, enabled, next_run_at, created_at, updated_at)
     VALUES (?,NULL,?,?,?,NULL,?,?,?,?,?)`
  ).bind(
    userId,
    name,
    schedule, tz,
    String(b.body || '').slice(0, 8000),
    b.enabled === false ? 0 : 1,
    next, now, now,
  ).run();

  return json({ id: res.meta.last_row_id, next_run_at: next, desc: describeSchedule(schedule, tz) }, 201);
}

export async function updateJob(request, env, userId, id) {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!job) return json({ error: 'job not found' }, 404);
  const b = await readJson(request);

  const schedule = b.schedule !== undefined ? String(b.schedule).trim() : job.schedule;
  if (!parseSchedule(schedule)) return json({ error: 'invalid schedule' }, 400);
  const tz = b.tz !== undefined ? String(b.tz).trim() : job.tz;
  const offset = parseOffset(tz);
  if (offset === null) return json({ error: 'invalid tz' }, 400);

  const name = b.name !== undefined ? String(b.name).trim().slice(0, 64) : job.name;
  if (!name) return json({ error: 'name is required' }, 400);
  const body = b.body !== undefined ? String(b.body).slice(0, 8000) : job.body;
  const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : job.enabled;

  const now = Date.now();
  // 计划变更、或把停用的任务重新启用时，重算下次触发时刻（否则残留的旧时刻会让它立刻补跑一次）
  const reschedule = b.schedule !== undefined || b.tz !== undefined || (enabled === 1 && !job.enabled);
  const next = reschedule ? nextRunAt(schedule, offset, now, now) : job.next_run_at;

  // key_id 不参与更新（恒为 NULL）；title 列已废弃，不再写入
  await env.DB.prepare(
    `UPDATE jobs SET name=?, schedule=?, tz=?, body=?, enabled=?, next_run_at=?, updated_at=?
      WHERE id=? AND user_id=?`
  ).bind(name, schedule, tz, body, enabled, next, now, id, userId).run();

  return json({ ok: true, next_run_at: next, desc: describeSchedule(schedule, tz) });
}

export async function deleteJob(request, env, userId, id) {
  const res = await env.DB.prepare('DELETE FROM jobs WHERE id=? AND user_id=?').bind(id, userId).run();
  if (!res.meta.changes) return json({ error: 'job not found' }, 404);
  return json({ ok: true });
}
