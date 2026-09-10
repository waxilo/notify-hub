// 定时表达式：预设串解析 + next_run_at 计算（不支持完整 cron，省掉一个解析库，也避免用户写出坑表达式）
//   every:5m                  每 5 分钟（1–1439）
//   every:2h                  每 2 小时（1–167）
//   daily:09:00               每天 09:00
//   weekly:1,09:00            每周一 09:00（0=周日 … 6=周六）
//   once:2026-09-10T09:30     一次性
// 时区用固定 UTC 偏移（+08:00 / -05:30 / UTC），不含夏令时 —— 这是整套实现里最容易出 bug 的地方，
// 固定偏移足够用且没有 IANA 时区库的依赖与歧义。
//
// 关键约定：next_run_at 是「绝对毫秒时间戳」，创建/改计划时按 tz 一次换算完，
// 之后所有比较都是时间戳比大小，执行端与服务器时区无关。
//
// 秒对齐（重要）：所有计划时刻一律对齐到整分钟，秒与毫秒全部丢弃。
//   因为「秒」在两个方向上都是不准的：任务创建时刻带秒（Date.now() 的 21:11:30），
//   Cron 到达时刻也带秒（触发落在分钟内任意一刻，如 21:12:10）。
//   若把创建时刻的秒带进 next_run_at，every:1m 的首个计划会落在 21:12:30，
//   于是 21:12:10 那次 tick 会因「计划时刻还没到」被判为未到期 —— 提醒整整晚一分钟。
//   对齐后计划时刻是 21:12:00，该分钟内的任意 tick（21:12:00 / 21:12:10 / 21:12:59）都能触发。
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 'UTC' / '+08:00' / '-05:30' / 'Z' → 偏移分钟数；无法识别返回 null（由调用方报 400）
export function parseOffset(tz) {
  const s = String(tz ?? '').trim().toUpperCase();
  if (!s || s === 'UTC' || s === 'Z' || s === 'GMT') return 0;
  const m = s.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const h = parseInt(m[2], 10);
  const mi = parseInt(m[3] || '0', 10);
  if (h > 14 || mi > 59) return null;
  return sign * (h * 60 + mi);
}

const pad2 = (n) => String(n).padStart(2, '0');

// 对齐到整分钟：整套实现里「计划时刻」的唯一粒度。
// 既用于生成 next_run_at（丢秒），也用于到期比较（tick 的秒不参与判定），
// 保证「计划 21:12:00 + tick 21:12:10」能命中，而 21:11:59 不会提前触发。
export const floorMinute = (ms) => Math.floor((Number(ms) || 0) / MINUTE) * MINUTE;

// 预设串 → 结构化描述；非法返回 null
export function parseSchedule(s) {
  const raw = String(s ?? '').trim();
  let m;

  m = raw.match(/^every:(\d+)(m|h)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (m[2].toLowerCase() === 'm') {
      if (n < 1 || n > 1439) return null;
      return { kind: 'interval', intervalMs: n * MINUTE, n, unit: 'm' };
    }
    if (n < 1 || n > 167) return null;
    return { kind: 'interval', intervalMs: n * HOUR, n, unit: 'h' };
  }

  m = raw.match(/^daily:(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = parseInt(m[1], 10); const mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) return null;
    return { kind: 'daily', h, mi };
  }

  m = raw.match(/^weekly:([0-6]),(\d{1,2}):(\d{2})$/);
  if (m) {
    const dow = parseInt(m[1], 10);
    const h = parseInt(m[2], 10); const mi = parseInt(m[3], 10);
    if (h > 23 || mi > 59) return null;
    return { kind: 'weekly', dow, h, mi };
  }

  m = raw.match(/^once:(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})$/);
  if (m) {
    const y = parseInt(m[1], 10); const mo = parseInt(m[2], 10); const d = parseInt(m[3], 10);
    const h = parseInt(m[4], 10); const mi = parseInt(m[5], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    // 以「本地时间」的 UTC 毫秒表示保存，换算成真实时间戳时再减偏移
    const localMs = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
    if (!Number.isFinite(localMs)) return null;
    // 校验日期真实存在（Date.UTC 会把 2026-02-31 进位成 3-3）
    const dt = new Date(localMs);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { kind: 'once', localMs, y, mo, d, h, mi };
  }

  return null;
}

// 计算下次触发时刻（毫秒时间戳），返回值恒为整分钟对齐
//   nowMs  当前时间（用 Cron 的 scheduledTime，不是 Date.now()，避免把 tick 延迟带进递推）
//   prevMs 上一次「计划」触发时刻，间隔型基于它递推，防止延迟累积漂移
//          （间隔型会先把它对齐到整分钟，因此传入带秒的旧数据也能自愈）
//   once 类型返回固定时刻（可能已过期，由调用方在执行后禁用）
export function nextRunAt(schedule, offsetMin, nowMs, prevMs) {
  const p = typeof schedule === 'string' ? parseSchedule(schedule) : schedule;
  if (!p) return null;
  const off = (Number(offsetMin) || 0) * MINUTE;
  const now = Number(nowMs) || Date.now();

  if (p.kind === 'once') return p.localMs - off;

  if (p.kind === 'interval') {
    // base 对齐整分钟：一是让首个计划落在整分钟（丢掉创建时刻的秒），
    // 二是让库里遗留的「带秒 next_run_at」在下次触发时自动自愈，无需数据迁移。
    const base = floorMinute(Number(prevMs) || now);
    if (base > now) return base;                       // 计划时刻还在未来，不动
    const k = Math.floor((now - base) / p.intervalMs) + 1;
    return base + k * p.intervalMs;                    // 跳过停机期间错过的次数，不补触发
  }

  // daily / weekly：在本地时间轴上找下一个 HH:MM
  const nowLocal = now + off;
  const dayIndex = Math.floor(nowLocal / DAY);         // 1970-01-01 是周四 → dow = (idx + 4) % 7
  let day = dayIndex;
  if (p.kind === 'weekly') {
    const curDow = (day + 4) % 7;
    day += (p.dow - curDow + 7) % 7;
  }
  const target = p.h * HOUR + p.mi * MINUTE;
  let cand = day * DAY + target;
  if (cand <= nowLocal) cand += (p.kind === 'weekly' ? 7 : 1) * DAY;
  return cand - off;
}

// 人类可读描述（列表展示用）
export function describeSchedule(s, tz) {
  const p = parseSchedule(s);
  if (!p) return s || '—';
  const at = tz ? `（${tz}）` : '';
  if (p.kind === 'interval') return p.unit === 'm' ? `每 ${p.n} 分钟` : `每 ${p.n} 小时`;
  if (p.kind === 'daily') return `每天 ${pad2(p.h)}:${pad2(p.mi)}${at}`;
  if (p.kind === 'weekly') return `每${DOW_CN[p.dow]} ${pad2(p.h)}:${pad2(p.mi)}${at}`;
  return `一次性 ${p.y}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}${at}`;
}
