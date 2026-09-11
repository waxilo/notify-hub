-- 0002：补齐 0001 之后靠手工 ALTER 出来的字段（使全新环境可一键重建）
--
-- 执行（⚠️ 必须带 --remote，wrangler v4 的 d1 execute 默认只操作本地库）：
--   wrangler d1 execute notify-hub --remote --file=./migrations/0002_schema_sync.sql
--
-- ⚠️ 本文件不幂等：SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS。
--    在「列已存在」的库（例如已手工 ALTER 过的线上库）上执行会报 duplicate column 并整批回滚。
--    这种库不需要执行本文件，只需执行幂等的 0003_jobs.sql。
--
-- 背景：0001_init.sql 与代码脱节，keys.mode / keys.template / keys.title_path /
--       keys.body_path / notifications.delivered_at / notifications.dedup_key
--       这些列代码都在用，但 0001 里没有定义（线上是手工 ALTER 出来的），
--       导致全新环境按 0001 建库后应用直接 500。

-- keys：模式、模板与字段路径（keys.js / webhook.js 已在用）
ALTER TABLE keys ADD COLUMN mode       TEXT NOT NULL DEFAULT 'default';
ALTER TABLE keys ADD COLUMN template   TEXT;
ALTER TABLE keys ADD COLUMN title_path TEXT;
ALTER TABLE keys ADD COLUMN body_path  TEXT;

-- notifications：触达回执与防重 key（notifications.js / push.js / webhook.js 已在用）
ALTER TABLE notifications ADD COLUMN delivered_at INTEGER;
ALTER TABLE notifications ADD COLUMN dedup_key    TEXT;
CREATE INDEX IF NOT EXISTS idx_notif_dedup ON notifications(user_id, dedup_key, created_at);
