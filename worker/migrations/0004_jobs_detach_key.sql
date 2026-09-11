-- 0004：定时任务与外部 key 解耦 —— 幂等，可安全重复执行
--
-- 执行（⚠️ 必须带 --remote，wrangler 的 d1 execute 默认只操作本地库）：
--   wrangler d1 execute notify-hub --remote --file=./migrations/0004_jobs_detach_key.sql
--
-- 背景：key 是「外部系统调 /hook/:key 写通知」的凭证，定时任务是站内自己产生的提醒，
-- 两者来源不同。原先任务必须挂一个 key，导致用户得先造一个用不上的通道；
-- key 被删掉后任务还会显示「通道：(已删除)」，语义混乱。
--
-- 现在：定时任务直接发「默认类型」通知 —— 标题 = 任务名称，正文 = 通知内容（留空则同任务名），
-- 通知的 key_id 为 NULL，不占用、也不出现在任何 key 的发送历史里。
-- createJob 已改为写入 NULL，这个迁移负责把历史行的旧值一并清空，让 key_id 恒为 NULL。
--
-- 只清列、不删列：SQLite 的 DROP COLUMN 有限制（被索引/视图引用时直接失败），
-- 而留一个恒为 NULL 的列没有任何代价。jobs.title 同样已废弃（标题一律取任务名称），
-- 这里不动它，保留历史值以免不可逆。
--
-- 注意：线上历史通知（notifications.key_id 指向旧通道）不受影响 —— 那是已经发出去的事实记录。

UPDATE jobs SET key_id = NULL;
