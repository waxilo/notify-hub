-- 0006：notifications.job_id 检索索引 —— 幂等，可安全重复执行
--
-- 执行（⚠️ 必须带 --remote）：
--   wrangler d1 execute notify-hub --remote --file=./migrations/0006_notifications_job_index.sql
--
-- 覆盖两条查询：
--   1) 某个任务的历史：WHERE user_id=? AND job_id=?（COUNT(*) 走覆盖索引，不回表）
--   2) 任务列表的「已发送 N 条」：WHERE user_id=? AND job_id IS NOT NULL GROUP BY job_id
-- 与 idx_notif_user(user_id, id) 一样是覆盖索引，索引体积只随通知行数增长，读放大可控。
CREATE INDEX IF NOT EXISTS idx_notif_job ON notifications(user_id, job_id);
