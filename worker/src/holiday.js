// 节假日判断：基于 https://api.apisbo.com/holidays/date/{YYYY-MM-DD}
// 判定「非工作日」用 data.isHoliday（true 表示应跳过，包含法定节假日与周末；
// 其中法定节假日的 data.holiday 有具体名称，周末则为 null —— 两者都算非工作日）。
//
// 已知局限：该接口返回的是中国日历，因此按任务自身 tz 换算出的「本地日期」查询。
// 海外时区的任务会被按中国日历判断，可能不准（notify-hub 用户以 +08:00 为主，可接受）。
const HOLIDAY_API = 'https://api.apisbo.com/holidays/date/';

// 按日期缓存（同一 isolate 内当天只查一次；跨天用日期字符串作 key 自然失效）。
// 频率极低：只在配置了 skip_holiday 且到期的任务触发时才会走到这里，一天最多查几次。
const cache = new Map(); // dateStr -> { isHoliday: boolean }

// 把「绝对毫秒时间戳」按固定 UTC 偏移换算成本地日期 YYYY-MM-DD
export function ymdLocal(ms, offsetMin) {
  const off = (Number(offsetMin) || 0) * 60_000;
  const d = new Date(Number(ms) + off);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 返回 Promise<boolean>：true = 非工作日（任务应跳过），false = 工作日（照常触发）。
// 容错：接口失败 / 超时一律返回 false（不跳过），保证提醒不丢 ——
// 宁可节假日那天多一条提醒，也不能因为外部服务异常让所有任务永久沉默。
export async function isHoliday(dateStr) {
  if (cache.has(dateStr)) return cache.get(dateStr).isHoliday;

  const url = HOLIDAY_API + dateStr;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const isHoliday = !!(json && json.data && json.data.isHoliday);
    cache.set(dateStr, { isHoliday });
    return isHoliday;
  } catch (err) {
    console.warn('holiday_api_failed', dateStr, String(err));
    cache.set(dateStr, { isHoliday: false });
    return false;
  }
}
