-- 0009: jobs 表增加 skip_holiday 列，支持定时任务跳过非工作日（含周末）
-- 判定依据：节假日 API 返回 data.isHoliday === true（含法定节假日与周末）。
--
-- 非幂等 ALTER：对已经加过该列的库重复执行会报
--   duplicate column name: skip_holiday
-- 仅全新库可放心连跑；已有库若已加过列需先 DROP 该列或跳过本文件。
--
-- 执行（务必带 --remote，否则只作用于本地库，且命令仍显示成功）：
--   npx wrangler d1 execute notify-hub --remote --file=./migrations/0009_skip_holiday.sql
ALTER TABLE jobs ADD COLUMN skip_holiday INTEGER NOT NULL DEFAULT 0;
