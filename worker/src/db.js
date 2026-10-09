// MySQL 驱动，对外暴露与 Cloudflare D1 完全同形的 env.DB
// （prepare(sql).bind(...).all()/first()/run() + meta.last_row_id / meta.changes），
// 因此 src/*.js 里的 SQL 与业务逻辑不需要知道底下换了引擎。
//
// 只实现本项目真正用到的那一面：没有 batch()/事务 —— D1 代码里从来没用过，
// 加上就是无人调用的死代码（并发保护另有机制：jobs 的乐观锁 WHERE id=? AND next_run_at=?）。
//
// 三处必须存在的参数，都是 D1 语义与 MySQL 默认行为对不上导致的：
//   * flags: ['FOUND_ROWS'] —— UPDATE 默认上报「实际改变值的行数」，而 D1/SQLite 上报
//     「匹配到的行数」。keys.js:72 与 jobs.js:233 用 meta.changes 判 404：
//     不开这个标志，「把 key 改成它本来的名字」这种零变化更新会被判成 key not found。
//   * decimalNumbers: true —— COUNT()/SUM() 在 MySQL 回 DECIMAL/BIGINT，
//     不转换会让 listJobs 的 sent_count、/api/notifications 的 total 变成字符串。
//   * 刻意不开 supportBigNumbers：它会把超过 2^53 的 BIGINT 转成字符串，
//     从而让 id/created_at 在响应 JSON 里从数字变字符串。这里的毫秒时间戳与自增 id
//     远小于 2^53，不需要那个精度保护，宁可保持类型不变。
//
// 也没有照抄 writing-assistant 的两处：
//   * 它按连接 SET time_zone='+00:00'：notify-hub 全部时间都是 epoch 毫秒 BIGINT，
//     没有任何 DATETIME 列，那条设置在这里没有作用对象。
//   * 它把 undefined 绑定归一成 NULL：D1 对 undefined 绑定是抛 D1_TYPE_ERROR，
//     这个抛错是有意的安全网（见 test/jobs.smoke.js 的适配层注释 —— 「SQL 加了占位符、
//     变量却忘了定义」会被静默吞掉，直到某个接口 500）。这里保留抛错。
import mysql from 'mysql2/promise';

const lastOf = (s) => String(s).split('/').pop();

function normalize(sql, params) {
  for (let i = 0; i < params.length; i++) {
    if (params[i] === undefined) {
      throw new TypeError(`D1_TYPE_ERROR: Type 'undefined' not supported for binding (arg #${i}) [${lastOf(sql).slice(0, 60)}]`);
    }
  }
}

function metaOf(result) {
  if (Array.isArray(result)) return { changes: result.length, last_row_id: 0 };
  return { changes: result?.affectedRows ?? 0, last_row_id: result?.insertId ?? 0 };
}

function createStatement(exec, sql, params) {
  const bound = (...more) => {
    const next = [...params, ...more];
    normalize(sql, next);
    return createStatement(exec, sql, next);
  };
  return {
    bind: bound,
    async all() {
      const [rows] = await exec(sql, params);
      return { results: Array.isArray(rows) ? rows : [], success: true, meta: metaOf(rows) };
    },
    async first() {
      const [rows] = await exec(sql, params);
      return Array.isArray(rows) ? (rows[0] ?? null) : null;
    },
    async run() {
      const [result] = await exec(sql, params);
      return { success: true, meta: metaOf(result) };
    },
  };
}

/**
 * @returns {{ DB: { prepare(sql: string): object }, close(): Promise<void> }}
 */
export function createDatabase(cfg) {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit ?? 10,
    queueLimit: 0,
    flags: ['FOUND_ROWS'],
    decimalNumbers: true,
    // 一条语句一次往返，杜绝 ; 拼接出第二条语句执行
    multipleStatements: false,
    charset: 'utf8mb4_bin',
  });

  const exec = (sql, params) => pool.execute(sql, params);

  return {
    DB: { prepare: (sql) => createStatement(exec, sql, []) },
    close: () => pool.end(),
  };
}

/** 从环境变量读连接参数（缺失即启动失败，不留到第一个请求才 500）。 */
export function databaseConfigFromEnv(env) {
  const missing = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  };
}
