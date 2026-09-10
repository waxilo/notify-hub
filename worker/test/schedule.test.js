// 定时表达式解析与 next_run_at 计算的回归测试（时区换算是这套实现里最容易出 bug 的地方）
// 运行：cd worker && npm test
import { parseSchedule, parseOffset, nextRunAt, describeSchedule } from '../src/schedule.js';

const OFF = 480; // +08:00
const p = (n) => String(n).padStart(2, '0');
const f = (ms) => {
  const d = new Date(ms + OFF * 60000);
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
    + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
};

let bad = 0;
const ck = (name, cond, extra) => {
  if (!cond) { bad++; console.log('FAIL ', name, extra || ''); }
  else console.log('ok   ', name, extra || '');
};

ck('parse every:5m', !!parseSchedule('every:5m'));
ck('reject every:0m', parseSchedule('every:0m') === null);
ck('reject every:2000m', parseSchedule('every:2000m') === null);
ck('reject daily:25:00', parseSchedule('daily:25:00') === null);
ck('reject weekly:7,09:00', parseSchedule('weekly:7,09:00') === null);
ck('reject bogus', parseSchedule('* * * * *') === null);
ck('reject once 2026-02-31', parseSchedule('once:2026-02-31T09:00') === null);
ck('parseOffset +08:00', parseOffset('+08:00') === 480);
ck('parseOffset -05:30', parseOffset('-05:30') === -330);
ck('parseOffset UTC', parseOffset('UTC') === 0);
ck('parseOffset bad', parseOffset('Asia/Shanghai') === null);

// 2026-09-10 是周四；base 的本地时间 = 2026-09-10 09:00:00
const base = Date.UTC(2026, 8, 10, 1, 0, 0);
ck('base 本地时刻', f(base) === '2026-09-10 09:00', f(base));

let n = nextRunAt('daily:09:00', OFF, base, null);
ck('daily 09:00 已过 -> 次日', f(n) === '2026-09-11 09:00', f(n));

n = nextRunAt('daily:09:00', OFF, base - 3600000, null);
ck('daily 09:00 未到 -> 当天', f(n) === '2026-09-10 09:00', f(n));

n = nextRunAt('weekly:4,09:00', OFF, base, null);
ck('weekly 周四(当天已过) -> 下周四', f(n) === '2026-09-17 09:00', f(n));

n = nextRunAt('weekly:5,09:00', OFF, base, null);
ck('weekly 周五 -> 次日', f(n) === '2026-09-11 09:00', f(n));

n = nextRunAt('weekly:3,09:00', OFF, base, null);
ck('weekly 周三 -> 下周三', f(n) === '2026-09-16 09:00', f(n));

// prev = 刚被触发的那个槽位，next 必须是「严格晚于 now」的第一个槽位
n = nextRunAt('every:5m', OFF, base, base);
ck('every:5m 正常递推', n === base + 5 * 60000, f(n));
n = nextRunAt('every:5m', OFF, base + 20000, base);
ck('every:5m tick 晚 20s 不漂移', n === base + 5 * 60000, f(n));
n = nextRunAt('every:5m', OFF, base, base - 5 * 60000);
ck('every:5m prev 已过期一档 -> 跳过', n === base + 5 * 60000, f(n));

// 长时间运行不累积漂移：每 tick 晚 0~40 秒，跑 500 次，偏差应始终 < 1 个周期
{
  let prev = base;
  let now = base;
  let maxDrift = 0;
  for (let i = 0; i < 500; i++) {
    now += 5 * 60000 + Math.floor(Math.random() * 40000); // 下次 tick 晚 0~40 秒
    const nx = nextRunAt('every:5m', OFF, now, prev);
    maxDrift = Math.max(maxDrift, nx - now);
    prev = nx;
  }
  ck('every:5m 跑 500 次无累积漂移', maxDrift <= 5 * 60000, 'maxDrift=' + Math.round(maxDrift / 1000) + 's');
}

n = nextRunAt('every:5m', OFF, base + 2 * 3600000, base);
ck('every:5m 停机 2h 不补触发', n > base + 2 * 3600000 && n <= base + 2 * 3600000 + 5 * 60000, f(n));

n = nextRunAt('every:2h', OFF, base + 3600000, base);
ck('every:2h', n === base + 2 * 3600000, f(n));

n = nextRunAt('once:2026-09-10T09:30', OFF, base, null);
ck('once 本地 09:30', f(n) === '2026-09-10 09:30', f(n));

n = nextRunAt('daily:09:00', -300, base, null);
const d5 = new Date(n - 300 * 60000);
ck('tz -05:00 daily 09:00', d5.getUTCHours() === 9, d5.toISOString());

console.log('desc:', describeSchedule('every:5m'), '|', describeSchedule('daily:09:00', '+08:00'),
  '|', describeSchedule('weekly:1,09:00', '+08:00'), '|', describeSchedule('once:2026-09-10T09:30', '+08:00'));
console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
