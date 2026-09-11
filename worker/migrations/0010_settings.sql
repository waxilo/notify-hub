-- settings 键值表：运行期自动生成的配置（如 QQ 群 openid、后续的开关类配置）
-- 幂等，可重复执行
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
