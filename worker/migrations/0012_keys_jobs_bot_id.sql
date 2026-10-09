-- 0012：keys / jobs 绑定机器人 —— 外部 key 与定时任务各自指定「用哪个机器人推送」
--
-- 执行（⚠️ 必须带 --remote，wrangler v4 的 d1 execute 默认只操作本地库）：
--   npx wrangler d1 execute notify-hub --remote --file=./migrations/0012_keys_jobs_bot_id.sql
--
-- ⚠️ 本文件**不幂等**：SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，
--    重复执行会报 duplicate column name: bot_id，而 wrangler --file 是整批原子执行
--    （一条失败全部回滚）。只跑一次。
--
-- 语义：bot_id 为 NULL = 用所属账号的默认机器人（bots.is_default=1）；
--       bot_id 非空 = 固定走这个机器人（多机器人账号可让「服务器告警」走运维机器人、
--       「私事提醒」走私人机器人）。机器人被删除时，引用它的 key / job 会被置回 NULL，
--       自动回落默认机器人，不会有悬空引用。
-- 旧数据一律为 NULL —— 即「跟随默认机器人」，语义与本次重构前的行为一致。
ALTER TABLE keys ADD COLUMN bot_id INTEGER;
ALTER TABLE jobs ADD COLUMN bot_id INTEGER;
