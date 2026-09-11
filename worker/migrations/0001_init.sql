-- notify-hub D1 schema (run once with: wrangler d1 execute notify-hub --file=./migrations/0001_init.sql)
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL UNIQUE,
  pass_hash  TEXT    NOT NULL,
  pass_salt  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  key        TEXT    NOT NULL UNIQUE,
  name       TEXT,
  created_at INTEGER NOT NULL,
  last_used  INTEGER,
  active     INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  key_id     INTEGER,
  title      TEXT,
  body       TEXT,
  payload    TEXT,
  created_at INTEGER NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (key_id) REFERENCES keys(id)
);

CREATE INDEX IF NOT EXISTS idx_keys_key     ON keys(key);
CREATE INDEX IF NOT EXISTS idx_keys_user    ON keys(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_user   ON notifications(user_id, id);
