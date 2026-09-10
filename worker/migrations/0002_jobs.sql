-- 0002：补齐与代码脱节的字段 + 定时任务（jobs）表
-- 执行：wrangler d1 execute notify-hub --file=./migrations/0002_jobs.sql
-- 说明：线上库此前是手工 ALTER 出来的，0001 里并没有这些列，导致新环境无法一键重建。
--       每个迁移只跑一次；重复执行时 ALTER TABLE 会报 duplicate column，属预期。

-- keys：模式与消息模板（keys.js / webhook.js 已在用）
ALTER TABLE keys ADD COLUMN mode TEXT NOT NULL DEFAULT 'default';
ALTER TABLE keys ADD COLUMN template TEXT;

-- notifications：触达回执与防重 key（notifications.js / push.js / webhook.js 已在用）
ALTER TABLE notifications ADD COLUMN delivered_at INTEGER;
ALTER TABLE notifications ADD COLUMN dedup_key TEXT;
CREATE INDEX IF NOT EXISTS idx_notif_dedup ON notifications(user_id, dedup_key, created_at);

-- jobs：服务端定时任务（Cron 每分钟扫描 next_run_at 执行，端侧只做配置）
--   schedule 为预设串，不支持完整 cron：every:5m / every:2h / daily:09:00 / weekly:1,09:00 / once:2026-09-10T09:30
--   tz 为固定 UTC 偏移（+08:00），创建时即换算为 next_run_at 绝对时间戳，执行端与服务器时区无关
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  key_id      INTEGER,                            -- 用哪个 key 的身份产生通知（决定通知标题）
  name        TEXT,
  schedule    TEXT    NOT NULL,
  tz          TEXT    NOT NULL DEFAULT '+08:00',
  title       TEXT,
  body        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,                            -- 预计算的下次触发毫秒时间戳
  last_run_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (key_id) REFERENCES keys(id)
);

-- 扫描必须命中这个索引：WHERE enabled=1 AND next_run_at<=? 只扫到期行，不吃 D1 读配额
CREATE INDEX IF NOT EXISTS idx_jobs_due  ON jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, id);
