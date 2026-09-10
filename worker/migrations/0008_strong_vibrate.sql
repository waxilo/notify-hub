-- 0008：强力震动开关 —— keys 与 jobs 各加一列
--
-- 背景：某条推送需要「无声 + 持续震动到用户处理」。是否强震是**发送方的提醒策略**，
-- 因此按 key（外部 webhook）与按 job（站内定时任务）各存一个开关。
-- 列随消息一起下发给 App（WS payload 的 vibrate 字段），App 据此决定是否循环震动。
--
-- ⚠️ 非幂等：SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，只能执行一次
--    （重复执行报 duplicate column name: strong_vibrate）。
--
-- 执行（⚠️ 必须带 --remote，否则只作用于本地库）：
--   npx wrangler d1 execute notify-hub --remote --file=./migrations/0008_strong_vibrate.sql
--
-- 取值：0 = 普通提醒（横幅 + 渠道单次震动）；1 = 强力震动（横幅 + 循环震动，最长 30 秒）。
ALTER TABLE keys ADD COLUMN strong_vibrate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN strong_vibrate INTEGER NOT NULL DEFAULT 0;
