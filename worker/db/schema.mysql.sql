-- notify-hub MySQL schema —— 把 D1 迁移 0001~0012 合并成终态，本机库的唯一真源。
-- 建库/建表：./scripts/db-init.sh（复用同级 ../mysql-server 容器）
--
-- 表名、列名与 D1 完全一致：src/*.js 的 SQL、接口的 JSON 字段、Web 控制台与已发布安卓端
-- 都按这些名字读，任何改名都是一次跨端协议变更，不在这次「换运行时」的范围内。
--
-- 与 SQLite/D1 的四处必须记录的差异：
--
-- 1) 排序规则统一 utf8mb4_bin。SQLite 的 = 与 UNIQUE 是字节比较（大小写敏感），MySQL 默认的
--    *_ci / *_general_ci 不敏感 —— 那会让 username/key/openid 的比对语义悄悄变松：
--    两个只有大小写不同的 webhook key 会互相命中，等于把别人的通道当成自己的。
--    所以这里不是「随便选个字符集」，bin 才是 D1 的等价物。
--
-- 2) `key` 与 `read` 必须反引号。它们在 MySQL 是保留字（SQLite 不是），
--    src/keys.js、src/webhook.js、src/notifications.js、src/deliver.js 里的语句已同步加上；
--    SQLite 同样接受反引号，所以这批 SQL 在两边的测试里都可执行。
--
-- 3) idx_bots_appid 在 D1 是部分唯一索引：
--      CREATE UNIQUE INDEX idx_bots_appid ON bots(app_id) WHERE app_id <> '';
--    MySQL 没有部分索引。用 virtual 生成列 NULLIF(app_id,'') 复刻同一语义：
--    空串变成 NULL，而 MySQL 的唯一索引允许多行 NULL ——
--    于是「填了 AppID 才全局唯一、未填凭证的占位机器人不占用唯一性」这条规则一字不差地保留。
--    该列由 app_id 推导，不写入、不参与 SELECT（BOT_COLS 里没有它），纯索引载体。
--
-- 4) 外键只留索引、不加 CONSTRAINT。理由是 D1/SQLite 本来就不强制外键（PRAGMA foreign_keys 默认 OFF），
--    引用完整性一直由应用层负责：deleteBot 删名单并把 key/job 的 bot_id 置回 NULL，deleteKey 连带清历史；
--    读路径也按「脏数据退化成 NULL」写（listJobs/listKeys 的 LEFT JOIN 条件带 user_id）。
--    换到 InnoDB 后如果加上约束，有两处坏处：导入历史数据时任何一条越界的旧行都会让整批失败；
--    删除路径里那几句显式清理就从「必需」变成「和外键抢着收尾」，同一件事两个owner，语义反而含混。
--    （导入器 scripts/d1-to-mysql.mjs 会临时 SET FOREIGN_KEY_CHECKS=0 并保持原主键 —— 有无约束它都不受影响。）
--
-- 5) D1 的 INTEGER 时间戳是 epoch 毫秒，可能到 2^53 以下任意值 → BIGINT（不是 INT）。
--    代码里对 created_at/next_run_at 做的都是毫秒整数比较，DATETIME 反而会破坏它。

CREATE TABLE IF NOT EXISTS users (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  username   VARCHAR(255) NOT NULL,
  pass_hash  VARCHAR(255) NOT NULL,
  pass_salt  VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `keys` (
  id             BIGINT NOT NULL AUTO_INCREMENT,
  user_id        BIGINT NOT NULL,
  `key`          VARCHAR(64) NOT NULL,
  -- D1 里这些文本列都可空，代码也按可空处理（row.name || '通知'）。保持可空，
  -- 否则导入历史数据时「老行本来就没写」会被 MySQL 拒绝，白白卡住迁移。
  name           VARCHAR(64) NULL,
  created_at     BIGINT NOT NULL,
  last_used      BIGINT NULL,
  active         TINYINT NOT NULL DEFAULT 1,
  mode           VARCHAR(16) NOT NULL DEFAULT 'default',   -- default / custom（自定义模板解析）
  template       TEXT NULL,
  title_path     VARCHAR(255) NULL,                        -- 0002 遗留列，当前代码不再读写
  body_path      VARCHAR(255) NULL,                        -- 同上
  strong_vibrate TINYINT NOT NULL DEFAULT 0,               -- 0008：安卓端强提醒开关
  bot_id         BIGINT NULL,                              -- 0012：NULL = 账号默认机器人
  PRIMARY KEY (id),
  UNIQUE KEY idx_keys_key (`key`),
  KEY idx_keys_user (user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE IF NOT EXISTS notifications (
  id           BIGINT NOT NULL AUTO_INCREMENT,
  user_id      BIGINT NOT NULL,
  key_id       BIGINT NULL,                                -- 外部 webhook 来源
  job_id       BIGINT NULL,                                -- 定时任务来源；与 key_id 互斥
  dedup_key    VARCHAR(128) NULL,
  title        VARCHAR(512) NULL,
  body         MEDIUMTEXT NULL,
  payload      MEDIUMTEXT NULL,
  rejected     VARCHAR(32) NULL,                           -- 如 key_disabled：只留痕不推送
  created_at   BIGINT NOT NULL,
  `read`       TINYINT NOT NULL DEFAULT 0,
  delivered_at BIGINT NULL,                                -- 非空 = 至少一个目标送达
  PRIMARY KEY (id),
  KEY idx_notif_user (user_id, id),
  KEY idx_notif_dedup (user_id, dedup_key, created_at),
  KEY idx_notif_job (user_id, job_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE IF NOT EXISTS jobs (
  id             BIGINT NOT NULL AUTO_INCREMENT,
  user_id        BIGINT NOT NULL,
  key_id         BIGINT NULL,                              -- 0004 起恒为 NULL（定时任务不挂 key）
  bot_id         BIGINT NULL,                              -- 0012：NULL = 账号默认机器人
  name           VARCHAR(64) NULL,
  schedule       VARCHAR(64) NOT NULL,
  tz             VARCHAR(16) NOT NULL DEFAULT '+08:00',
  title          VARCHAR(512) NULL,                        -- 已废弃：标题一律取 name
  body           MEDIUMTEXT NULL,
  enabled        TINYINT NOT NULL DEFAULT 1,
  strong_vibrate TINYINT NOT NULL DEFAULT 0,
  skip_holiday   TINYINT NOT NULL DEFAULT 0,
  next_run_at    BIGINT NULL,
  last_run_at    BIGINT NULL,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (id),
  -- runDueJobs 每分钟的扫描靠这条：(enabled, next_run_at) 命中后读取行数 = 到期任务数
  KEY idx_jobs_due (enabled, next_run_at),
  KEY idx_jobs_user (user_id, id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(64) NOT NULL,
  v MEDIUMTEXT NOT NULL,
  PRIMARY KEY (k)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE IF NOT EXISTS bots (
  id           BIGINT NOT NULL AUTO_INCREMENT,
  user_id      BIGINT NOT NULL,
  name         VARCHAR(64) NOT NULL DEFAULT '默认机器人',
  app_id       VARCHAR(64) NOT NULL DEFAULT '',
  app_secret   VARCHAR(255) NOT NULL DEFAULT '',
  target       VARCHAR(16) NOT NULL DEFAULT 'group',       -- group / c2c / both
  msg_template TEXT NULL,                                  -- NULL = 内置默认模板
  is_default   TINYINT NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  -- 差异 3：部分唯一索引的等价物，勿删
  app_id_uk    VARCHAR(64)
    GENERATED ALWAYS AS (NULLIF(app_id, '')) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY idx_bots_appid (app_id_uk),
  KEY idx_bots_user (user_id, id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE IF NOT EXISTS bot_targets (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  bot_id     BIGINT NOT NULL,
  kind       VARCHAR(8) NOT NULL,                          -- group / c2c
  openid     VARCHAR(128) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  -- 重复捕获由这条唯一约束兜住（INSERT IGNORE 靠它幂等），不是可选的清理项
  UNIQUE KEY uk_bot_target (bot_id, kind, openid),
  KEY idx_bot_targets_bot (bot_id, kind)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;
