#!/usr/bin/env node
// 一次性数据迁移：Cloudflare D1 → 本机 MySQL（notify-hub 自托管切换用）
//
//   1) 导出线上 D1（需要走本机代理，直连 api.cloudflare.com 拨不通）：
//        cd worker && HTTPS_PROXY=http://127.0.0.1:7897 \
//          npx wrangler@4 d1 export notify-hub --remote --skip-confirmation \
//          -c wrangler.toml --output .d1-export/dump.sql
//      -> worker/.d1-export/dump.sql   （含密码哈希与 AppSecret，已 gitignore，勿提交）
//
//   2) 干跑，只看计划与差异，不写任何数据：
//        node scripts/d1-to-mysql.mjs
//   3) 正式导入并逐行回读校验：
//        node scripts/d1-to-mysql.mjs --apply
//
// 为什么要先把 dump 灌进一个真的 SQLite，而不是直接解析文本：
// D1 的导出用 SQLite 表达式编码值（每个换行都写成 replace('a\nb','\n',char(10))，
// 引号/反斜杠按 quote() 的规则来）。自己用正则还原会静默改坏正文——通知正文里有换行是常态，
// 坏在那儿看不出来。让 SQLite 自己求值，取回来的就是最终字符串。
//
// 保真规则：
//   * 主键 id 原样搬运（notifications/keys/jobs/bots 的 id 被安卓端、外部脚本和控制台引用，
//     重新编号等于把这些引用全打断），导入后把 AUTO_INCREMENT 重排到 max(id)+1；
//   * 只搬两边都有的列，D1 里存在而 MySQL 表没有的列会逐条报出来（宁可显式漏，不静默丢）；
//   * sqlite_sequence / _D1_MIGRATIONS 是 D1 内部表，跳过；
//   * 时间列本来就是 epoch 毫秒整数，不做任何时区换算（MySQL 侧同样是 BIGINT）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DUMP = join(ROOT, 'worker', '.d1-export', 'dump.sql');
const OUT_SQL = join(ROOT, 'worker', '.d1-export', 'mysql-import.sql');
const APPLY = process.argv.includes('--apply');

// 依赖装在 worker/ 下，这个脚本只是临时工具，不为它单独开一份 package.json
const require = createRequire(join(ROOT, 'worker', 'package.json'));
const mysql = require('mysql2/promise');

const SKIP_TABLES = new Set(['sqlite_sequence', '_D1_MIGRATIONS', 'd1_migrations']);
// 顺序即依赖方向：被引用表先落库，后面按 id 回读校验时不会有中间态
const TABLES = ['users', 'bots', 'bot_targets', 'keys', 'jobs', 'notifications', 'settings'];

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

const env = { ...readEnvFile(join(ROOT, '.env')), ...process.env };
const dbConfig = {
  host: env.DB_HOST || '127.0.0.1',
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  // DB_NAME_TEST 只在本机拿临时库演练这次迁移时用
  database: env.DB_NAME_IMPORT || env.DB_NAME,
};
if (!dbConfig.user || !dbConfig.password || !dbConfig.database) {
  console.error('缺少 DB_USER / DB_PASSWORD / DB_NAME：先跑 ./scripts/db-init.sh 生成 .env');
  process.exit(1);
}
if (!existsSync(DUMP)) {
  console.error(`找不到 D1 导出文件：${DUMP}\n按本文件顶部注释的第 1 步先导出。`);
  process.exit(1);
}

/* ---------------- 读侧：让 SQLite 自己求值 dump ---------------- */

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(DUMP, 'utf8'));

const q = (name) => String(name).replace(/[`"\\]/g, '');

function readTable(name) {
  const cols = sqlite.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name);
  if (!cols.length) return { cols: [], rows: [] };
  const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all();
  return { cols, rows };
}

/* ---------------- 写侧 ---------------- */

function valuesOf(row, cols) {
  return cols.map((c) => {
    const v = row[c];
    if (v === undefined || v === null) return null;
    if (typeof v === 'bigint') return Number(v);
    return v;
  });
}

function insertStatement(table, cols) {
  const list = cols.map((c) => `\`${q(c)}\``).join(', ');
  return `INSERT INTO \`${q(table)}\` (${list}) VALUES (${cols.map(() => '?').join(', ')})`;
}

async function main() {
  const plan = [];
  const missing = [];

  // dump 里出现「本脚本没列出的表」直接失败：加了新表却忘了搬，是最安静的一类数据丢失
  const dumpTables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name);
  const unknown = dumpTables.filter((t) => !TABLES.includes(t) && !SKIP_TABLES.has(t));
  if (unknown.length) {
    console.error(`❌ D1 里有脚本未登记的表：${unknown.join(', ')}\n   确认要不要搬，加进本文件的 TABLES 后重跑。`);
    process.exit(1);
  }

  for (const table of TABLES) {
    const { cols, rows } = readTable(table);
    if (!cols.length) { plan.push({ table, cols: [], rows: 0, skipped: 'D1 里没有这张表' }); continue; }
    plan.push({ table, cols, rows: rows.length });
  }

  // 列差异检查：MySQL 侧缺列 = 这次迁移会丢数据，必须先补 schema 再导
  const conn = await mysql.createConnection(dbConfig);
  for (const item of plan) {
    if (!item.cols.length) continue;
    const [rs] = await conn.execute(
      'SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema=? AND table_name=?',
      [dbConfig.database, item.table],
    );
    const have = new Set(rs.map((r) => r.c));
    const absent = item.cols.filter((c) => !have.has(c));
    if (absent.length) missing.push({ table: item.table, columns: absent });
    item.mysqlCols = item.cols.filter((c) => have.has(c));
  }

  console.log(`目标库：${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
  console.log('\n表                D1 行数   写入列数');
  for (const item of plan) {
    const name = item.table.padEnd(14);
    console.log(`${name}  ${String(item.rows).padStart(6)}   ${(item.mysqlCols || item.cols).length}${item.skipped ? '   （' + item.skipped + '）' : ''}`);
  }
  if (missing.length) {
    console.error('\n❌ MySQL 侧缺列，导入会丢数据。先给 db/schema.mysql.sql 补上这些列再重跑：');
    for (const m of missing) console.error(`   ${m.table}: ${m.columns.join(', ')}`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\n干跑结束（未写入任何数据）。确认无误后：node scripts/d1-to-mysql.mjs --apply');
    sqlite.close(); await conn.end();
    return;
  }

  mkdirSync(dirname(OUT_SQL), { recursive: true });

  // 目标库必须为空才允许写入：id 是原样搬运的，残留一行就可能直接撞主键；
  // 更要紧的是后面的逐行回读校验按「MySQL 行数 == D1 行数」判定 —— 库里多一条来路不明的行，
  // 要么把这次导入判成失败，要么在对齐总数时把 D1 的真实行漏掉，两种假象都比报错危险。
  const dirty = [];
  for (const table of TABLES) {
    const [rs] = await conn.execute(`SELECT COUNT(*) AS c FROM \`${table}\``);
    if (Number(rs[0].c) > 0) dirty.push(`${table}=${rs[0].c}`);
  }
  if (dirty.length) {
    console.error(`❌ 目标库 ${dbConfig.database} 非空：${dirty.join('  ')}`);
    console.error('   先查清这些行的来源（比如本机验证时注册的账号）。确属残留再清空：');
    console.error(`   docker exec mysql-server mysql -uroot -p<pw> ${dbConfig.database} \\`);
    console.error(`     -e "SET FOREIGN_KEY_CHECKS=0; TRUNCATE ${TABLES.join('; TRUNCATE ')}; SET FOREIGN_KEY_CHECKS=1"`);
    await conn.end();
    process.exit(1);
  }

  const audit = ['-- 本次导入实际执行的语句（值已参数化，这里只留结构，便于事后核对）'];

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  const report = [];
  for (const table of TABLES) {
    const { cols, rows } = readTable(table);
    if (!rows.length) { report.push({ table, wrote: 0 }); continue; }
    const use = cols.filter((c) => (plan.find((p) => p.table === table).mysqlCols).includes(c));
    const sql = insertStatement(table, use);
    audit.push(`-- ${table}: ${rows.length} 行，列 ${use.join(', ')}`);
    for (const row of rows) {
      await conn.execute(sql, valuesOf(row, use));
    }
    const [cnt] = await conn.execute(`SELECT COUNT(*) AS c FROM \`${table}\``);
    report.push({ table, wrote: Number(cnt[0].c), expect: rows.length, use });
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // 逐行回读校验：不是「条数对得上」就算完，而是每个字段都比对一次。
  // 通知正文里一个字符错了没人看得出来，而这次迁移跑完线上就要下线，没有第二次机会。
  let mismatch = 0;
  for (const table of TABLES) {
    const { cols, rows } = readTable(table);
    if (!rows.length) continue;
    const use = plan.find((p) => p.table === table).mysqlCols;
    // settings 的主键是 k（文本），其余表是自增 id —— 回读按各自主键排序与配对
    const pk = cols.includes('id') ? 'id' : cols[0];
    const keyOf = (r) => (pk === 'id' ? String(Number(r.id)) : String(r[pk]));
    const [mine] = await conn.execute(`SELECT * FROM \`${table}\` ORDER BY \`${pk}\``);
    const src = new Map(rows.map((r) => [keyOf(r), r]));
    if (mine.length !== rows.length) {
      console.error(`❌ ${table} 行数不符：MySQL ${mine.length} vs D1 ${rows.length}`);
      mismatch++;
      continue;
    }
    for (const row of mine) {
      const want = src.get(keyOf(row));
      if (!want) { console.error(`❌ ${table} 出现 D1 里没有的 ${pk}=${keyOf(row)}`); mismatch++; continue; }
      for (const col of use) {
        const a = want[col], b = row[col];
        const same = a === b
          || (a === null && b === null)
          || (typeof a === 'number' && typeof b === 'number' && a === b)
          || (a !== null && b !== null && String(a) === String(b));
        if (!same) {
          console.error(`❌ ${table}#${keyOf(row)}.${col}: D1=${JSON.stringify(a)} MySQL=${JSON.stringify(b)}`);
          mismatch++;
        }
      }
    }
  }

  // 重排自增起点：显式 id 插入后 InnoDB 自己会推进，但这里按 D1 的 max(id)+1 显式设定一次，
  // 让「下一条记录的 id」可预测 —— 否则万一某张表的计数停在旧值，第一条新记录就会撞上历史主键。
  for (const table of TABLES) {
    const { cols, rows } = readTable(table);
    if (!rows.length || !cols.includes('id')) continue;   // settings 的 PK 是 k，没有自增列
    const next = Math.max(...rows.map((r) => Number(r.id))) + 1;
    await conn.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${next}`);
  }

  console.log('\n导入结果');
  for (const r of report) console.log(`  ${r.table.padEnd(14)} ${String(r.wrote).padStart(6)} 行${r.expect != null && r.wrote !== r.expect ? '  ⚠️ 与 D1 不符' : ''}`);
  writeFileSync(OUT_SQL, audit.join('\n') + '\n');
  console.log(`\n结构留档：${OUT_SQL.replace(ROOT + '/', '')}（不含任何字段值）`);
  if (mismatch) {
    console.error(`\n❌ 回读校验发现 ${mismatch} 处不一致，数据不要直接用：修脚本或补 schema 后重建目标库再导一次。`);
    process.exit(1);
  }
  console.log('\n✅ 全部行逐字段回读一致。');
  await conn.end();
  sqlite.close();
}

main().catch((err) => { console.error('迁移失败：', err && err.message ? err.message : err); process.exit(1); });
