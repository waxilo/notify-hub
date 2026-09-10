-- 0003：定时任务（jobs）表 —— 幂等，可安全重复执行
--
-- 执行（⚠️ 必须带 --remote，wrangler v4 的 d1 execute 默认只操作本地库）：
--   wrangler d1 execute notify-hub --remote --file=./migrations/0003_jobs.sql
--
-- 独立成文件的原因：0002 里的 ALTER TABLE ADD COLUMN 在「列已存在」的库上会报
-- duplicate column，而 wrangler --file 是整批原子执行 —— 一条失败会全部回滚，
-- 导致同一文件里后面的建表语句也建不上。jobs 与补列因此拆成两个文件。

-- schedule 为预设串，不支持完整 cron：
--   every:5m / every:2h / daily:09:00 / weekly:1,09:00 / once:2026-09-10T09:30
-- tz 为固定 UTC 偏移（+08:00）；创建时即换算为 next_run_at 绝对时间戳，执行端与服务器时区无关。
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
