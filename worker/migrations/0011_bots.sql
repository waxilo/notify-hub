-- 0011：机器人（QQ 官方机器人）表 —— 账号隔离的核心
--
-- 背景：原实现把 QQ 凭证 / 触达目标 / 消息模板 / openid 名单全部塞在全局 settings 表
--       （k 单主键、没有 user_id）——谁在 Web 控制台改一次，所有账号一起变，
--       等于任意账号都能冒用别人的机器人发消息、看见别人绑定的群和好友。
--       这里改成「每账号可接多个机器人，其中一个为默认」：
--
--   bots        凭证 + 触达目标 + 消息模板 + 默认标记，归属 user_id
--   bot_targets 每个机器人各自的推送名单（群 / 私聊 openid）
--               按行存储而不是旧的 JSON 数组：旧写法是整串「读-改-写」，
--               两个群同时 @机器人 时后写者会覆盖先写者（丢绑定）；
--               行存储 + UNIQUE(bot_id, kind, openid) 天然幂等并发安全。
--
-- 回调路由：QQ 开放平台的回调地址是「每个机器人各自配置」的，但都填同一个
--   https://…/api/qq/callback。请求头 X-Bot-Appid 指明是哪个机器人，
--   再不济用 AppSecret 派生的 Ed25519 验签「试」也能唯一定位 —— 所以 app_id 必须全局唯一，
--   否则一个 AppID 挂到两个账号上，回调不知道该把 openid 记给谁（见 idx_bots_appid）。
--   app_id 为空（尚未填凭证的占位机器人）不参与该唯一索引。
--
-- 幂等：可安全重复执行。老数据（全局 settings 里的 QQ 配置）在末尾一次性搬给
--       「最早注册的账号」，搬完即删除旧键 —— 再跑一次是纯粹的 no-op。
--
-- ⚠️ 必须带 --remote（wrangler v4 的 d1 execute 默认只操作本地库）：
--    npx wrangler d1 execute notify-hub --remote --file=./migrations/0011_bots.sql

CREATE TABLE IF NOT EXISTS bots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  name         TEXT    NOT NULL DEFAULT '默认机器人',
  app_id       TEXT    NOT NULL DEFAULT '',        -- QQ 机器人 AppID（全局唯一，回调路由靠它）
  app_secret   TEXT    NOT NULL DEFAULT '',        -- AppSecret（仅服务端使用，接口只回掩码）
  target       TEXT    NOT NULL DEFAULT 'group',   -- 触达目标：group / c2c / both
  msg_template TEXT,                               -- 消息模板；NULL = 用内置默认模板
  is_default   INTEGER NOT NULL DEFAULT 0,         -- 账号默认机器人：每账号至多一个
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id, id);
-- 一个 AppID 只能属于一个账号；空 AppID 的占位机器人不占用唯一性
CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_appid ON bots(app_id) WHERE app_id <> '';

CREATE TABLE IF NOT EXISTS bot_targets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     INTEGER NOT NULL,
  kind       TEXT    NOT NULL,                     -- group=群 / c2c=私聊
  openid     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (bot_id, kind, openid),                   -- 重复捕获由数据库兜底，不产生写放大
  FOREIGN KEY (bot_id) REFERENCES bots(id)
);

CREATE INDEX IF NOT EXISTS idx_bot_targets_bot ON bot_targets(bot_id, kind);

-- ---------- 老数据迁移：全局 settings → 最早注册账号的默认机器人 ----------
-- 只在该账号还没有任何机器人、且旧键确实存在配置时执行；不做任何猜测性赋值。
INSERT INTO bots (user_id, name, app_id, app_secret, target, msg_template, is_default, created_at, updated_at)
SELECT
  (SELECT id FROM users ORDER BY id LIMIT 1),
  '默认机器人',
  COALESCE((SELECT v FROM settings WHERE k='qq_app_id'), ''),
  COALESCE((SELECT v FROM settings WHERE k='qq_app_secret'), ''),
  COALESCE((SELECT v FROM settings WHERE k='qq_target'), 'group'),
  (SELECT v FROM settings WHERE k='qq_msg_template'),
  1,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE (SELECT COUNT(*) FROM bots) = 0
  AND EXISTS (SELECT 1 FROM users)
  AND EXISTS (SELECT 1 FROM settings WHERE k IN ('qq_app_id', 'qq_app_secret'));

-- 群名单（新多值键优先）
INSERT OR IGNORE INTO bot_targets (bot_id, kind, openid, created_at)
SELECT b.id, 'group', t.value, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM bots b
  JOIN json_each(CASE
         WHEN json_valid((SELECT v FROM settings WHERE k='qq_group_openids'))
           THEN (SELECT v FROM settings WHERE k='qq_group_openids')
         ELSE '[]' END) t
 WHERE b.is_default = 1;

-- 群名单（旧单值键兜底）
INSERT OR IGNORE INTO bot_targets (bot_id, kind, openid, created_at)
SELECT b.id, 'group', s.v, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM bots b JOIN settings s ON s.k = 'qq_group_openid'
 WHERE b.is_default = 1 AND s.v <> '';

-- 私聊名单（新多值键优先）
INSERT OR IGNORE INTO bot_targets (bot_id, kind, openid, created_at)
SELECT b.id, 'c2c', t.value, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM bots b
  JOIN json_each(CASE
         WHEN json_valid((SELECT v FROM settings WHERE k='qq_user_openids'))
           THEN (SELECT v FROM settings WHERE k='qq_user_openids')
         ELSE '[]' END) t
 WHERE b.is_default = 1;

-- 私聊名单（旧单值键兜底）
INSERT OR IGNORE INTO bot_targets (bot_id, kind, openid, created_at)
SELECT b.id, 'c2c', s.v, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM bots b JOIN settings s ON s.k = 'qq_user_openid'
 WHERE b.is_default = 1 AND s.v <> '';

-- 搬完即删旧键：让本文件成为真正的幂等脚本（qq_last_callback 是回调排障留痕，保留）
DELETE FROM settings WHERE k IN (
  'qq_app_id', 'qq_app_secret', 'qq_target', 'qq_msg_template',
  'qq_group_openid', 'qq_group_openids', 'qq_user_openid', 'qq_user_openids'
);
