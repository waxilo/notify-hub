// 机器人（QQ 官方机器人）配置：**账号隔离** —— 每账号可接多个，其中一个为默认。
//
// 数据模型（见 db/schema.mysql.sql 的 bots / bot_targets；历史 D1 迁移在 migrations/ 归档）：
//   bots         凭证 / 触达目标 / 消息模板 / 默认标记，归属 user_id
//   bot_targets  每个机器人各自的推送名单（group / c2c 的 openid，行存储）
//   keys.bot_id / jobs.bot_id  指定用哪个机器人推送；NULL = 跟随账号默认机器人
//
// 为什么不沿用全局 settings 表：那是单主键（k）表、没有 user_id，所有账号共用一份配置 ——
// 谁在控制台改一次全体生效，等于账号之间完全没隔离（还能冒用别人的机器人发消息）。
//
// 回调（/api/qq/callback，所有机器人都填同一个地址）如何定位到账号：
//   1) 请求头 X-Bot-Appid（平台会带）→ 按 app_id 精确找到唯一机器人（app_id 全局唯一，见唯一索引）；
//   2) 头缺失 —— 遍历已配置机器人，用各自 AppSecret 派生的 Ed25519 公钥**试签名**，
//      验签通过的那个就是归属账号。签名本身就是身份，不必额外相信请求头。
//   URL 验证（op=13）必须**先**知道是哪个机器人才能用它的 secret 签名，而 payload 里没有 appid，
//   所以那一步只认 X-Bot-Appid；认不出来时返回明确错误（而不是签一个错的签名让平台猜）。
import { json, readJson } from './utils.js';
import { getAccessToken, sendToOpenid, verifySignature, validationResponse } from './qq.js';

export const VALID_TARGETS = ['group', 'c2c', 'both'];
export const MAX_BOTS_PER_USER = 10;
const MAX_TEMPLATE_LEN = 1000;

// QQ 文本消息（msg_type=0）只支持纯文本，靠排版字符做视觉分层；
// markdown / ark 模板消息需平台白名单权限，普通机器人不可用
export const DEFAULT_MSG_TEMPLATE =
  '📢 {title}\n' +
  '━━━━━━━━━━━━━━\n' +
  '{body}\n' +
  '\n' +
  '🕐 {time}';

const BOT_COLS = 'id, user_id, name, app_id, app_secret, target, msg_template, is_default, created_at, updated_at';
const mask = (s) => (!s ? '' : s.length <= 8 ? '****' : s.slice(0, 4) + '****' + s.slice(-4));
const now = () => Date.now();

// 非法值一律回落 group —— 与重构前 settings/env 时代的兜底行为一致（不静默改投递习惯）
function normalizeTarget(t) {
  const s = String(t || '').trim().toLowerCase();
  return VALID_TARGETS.includes(s) ? s : 'group';
}

// 触达目标列表：group=只发群 / c2c=只发私聊 / both=都发
export function targetKinds(target) {
  const t = normalizeTarget(target);
  return t === 'both' ? ['group', 'c2c'] : [t];
}

/* ---------------- 查询 ---------------- */

// 解析本次投递该用哪个机器人：
//   botId 非空 → 优先用它（key / job 显式绑定），但必须属于该账号；
//   否则（或绑定的机器人已被删除）→ 账号默认机器人；
//   账号一个机器人都没有 → null（调用方按「未配置」处理，只入库不推送）。
export async function resolveBotFor(env, userId, botId = null) {
  if (botId) {
    const bound = await env.DB.prepare(
      `SELECT ${BOT_COLS} FROM bots WHERE id=? AND user_id=?`
    ).bind(botId, userId).first();
    if (bound) return bound;
  }
  return await env.DB.prepare(
    `SELECT ${BOT_COLS} FROM bots WHERE user_id=? ORDER BY is_default DESC, id LIMIT 1`
  ).bind(userId).first();
}

// key / job 绑定机器人时的归属校验（写入路径用）。
// 语义：不传 / 空 → null = 跟随账号默认机器人；传了就必须是本账号的机器人，
// 否则报错 —— 否则 A 账号能把自己的 key 指向 B 账号的机器人。
export async function resolveBotBinding(env, userId, value) {
  if (value === undefined || value === null || value === '') return { ok: true, botId: null };
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'bot_id 非法' };
  const row = await env.DB.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) return { ok: false, error: 'bot_id 不存在或不属于当前账号' };
  return { ok: true, botId: id };
}

// 回调 URL 验证用：按 AppID 精确定位（AppID 全局唯一）
export async function botByAppId(env, appId) {
  if (!appId) return null;
  return await env.DB.prepare(
    `SELECT ${BOT_COLS} FROM bots WHERE app_id=? LIMIT 1`
  ).bind(String(appId)).first();
}

// 事件验签用：所有「填过 secret」的机器人。数量受 MAX_BOTS_PER_USER × 账号数约束，
// 单个 isolate 内的验签循环开销可接受（Ed25519 验签 ~0.1ms 级）。
export async function botsForVerify(env) {
  const rows = await env.DB.prepare(
    `SELECT ${BOT_COLS} FROM bots WHERE app_secret <> '' ORDER BY id LIMIT 500`
  ).all();
  return rows.results || [];
}

// 投递时取某个机器人的推送名单（group / c2c 两个数组）
export async function getTargets(env, botId) {
  const rows = await env.DB.prepare(
    'SELECT kind, openid FROM bot_targets WHERE bot_id=? ORDER BY id'
  ).bind(botId).all();
  const out = { group: [], c2c: [] };
  for (const r of rows.results || []) if (out[r.kind]) out[r.kind].push(r.openid);
  return out;
}

// 一次查询取回该账号全部机器人的名单（列表页渲染用，避免 N 个机器人打 N 次查询）
async function targetsByBot(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT t.bot_id, t.kind, t.openid FROM bot_targets t
       JOIN bots b ON b.id = t.bot_id
      WHERE b.user_id=? ORDER BY t.id`
  ).bind(userId).all();
  const map = new Map();
  for (const r of rows.results || []) {
    if (!map.has(Number(r.bot_id))) map.set(Number(r.bot_id), { group: [], c2c: [] });
    const bucket = map.get(Number(r.bot_id));
    if (bucket[r.kind]) bucket[r.kind].push(r.openid);
  }
  return map;
}

/* ---------------- 名单写入 ---------------- */

// 捕获到群/好友 openid 归到**触发它的那个机器人**名下。
// INSERT IGNORE + UNIQUE(bot_id, kind, openid)：重复绑定天然幂等，
// 也不会像旧的 JSON 整串读改写那样在并发捕获时丢绑定。
export async function addTarget(env, botId, kind, openid) {
  const oid = String(openid || '').trim();
  if (!oid || !botId) return;
  await env.DB.prepare(
    'INSERT IGNORE INTO bot_targets (bot_id, kind, openid, created_at) VALUES (?,?,?,?)'
  ).bind(botId, kind, oid, now()).run();
}

async function removeTarget(env, botId, kind, openid) {
  await env.DB.prepare(
    'DELETE FROM bot_targets WHERE bot_id=? AND kind=? AND openid=?'
  ).bind(botId, kind, String(openid)).run();
}

/* ---------------- 消息模板 ---------------- */

// {time} 按中国时区（UTC+8）渲染：Worker 无本地时区，QQ 触达场景默认国内用户
function formatTime() {
  const d = new Date(Date.now() + 8 * 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 占位符替换 + 排版清理：去行尾空白、压缩 3+ 连续空行、去首尾空行
export function renderMessage(tpl, { title, body }) {
  const s = String(tpl || DEFAULT_MSG_TEMPLATE)
    .replaceAll('{title}', String(title ?? ''))
    .replaceAll('{body}', String(body ?? ''))
    .replaceAll('{time}', formatTime());
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 投递用配置：DB 行是 snake_case、协议层（qq.js）要 camelCase，转换只在这里做一次。
// 曾经把整行原样传进协议层，appId/appSecret 全成了 undefined，而 QQ 那边仍返回成功 ——
// 这种「静默用错凭证」最难查，所以映射收敛成一个函数，调用方不再各自拼字段。
export function botDeliveryConfig(bot) {
  return {
    appId: bot.app_id || '',
    appSecret: bot.app_secret || '',
    target: normalizeTarget(bot.target),
    template: bot.msg_template || '',
  };
}

/* ---------------- 视图 ---------------- */

function botView(bot, targets, origin) {
  return {
    id: Number(bot.id),
    name: bot.name || '',
    app_id: bot.app_id || '',
    has_secret: !!bot.app_secret,
    secret_masked: mask(bot.app_secret),
    target: normalizeTarget(bot.target),
    msg_template: bot.msg_template || '',
    is_default: !!bot.is_default,
    group_openids: (targets && targets.group) || [],
    user_openids: (targets && targets.c2c) || [],
    callback_url: `${origin}/api/qq/callback`,
  };
}

/* ---------------- 回调（/api/qq/callback） ---------------- */

// 平台要求 3 秒内响应，留痕写入移出响应路径；只保留最近一次，供排障
function logProbe(env, ctx, request, payload, raw, extra) {
  if (!ctx || !ctx.waitUntil) return;
  ctx.waitUntil(env.DB.prepare(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)'
  ).bind('qq_last_callback', JSON.stringify({
    ts: new Date().toISOString(),
    ua: request.headers.get('User-Agent') || '',
    bot_appid: request.headers.get('X-Bot-Appid') || '',
    op: payload.op,
    t: payload.t || '',
    raw: raw.slice(0, 2000),
    ...extra,
  })).run().catch(() => {}));
}

// 1) op=13 URL 验证：定位机器人 → 用它的 secret 签 event_ts+plain_token
// 2) 事件（GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE）：验签即定位账号，
//    把 openid 记到该机器人名下（每个群 / 每个好友各一条，推送时逐个扇出）
// 3) 其余事件：验签后忽略（当前只用它拿 openid），按官方要求回 opcode=12 表示已收到
export async function handleCallback(request, env, ctx, origin) {
  const raw = await request.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }

  const headerAppId = request.headers.get('X-Bot-Appid') || '';
  // 头里带 AppID 时一次查询精确定位；否则拉回全部候选逐个验签（成本更低的那条路优先）
  const candidates = headerAppId
    ? [await botByAppId(env, headerAppId)].filter(Boolean)
    : await botsForVerify(env);

  if (payload.op === 13) {
    const d = payload.d || {};
    if (!d.plain_token) return json({ error: 'missing plain_token' }, 400);
    // op=13 只能用 X-Bot-Appid 定位（payload 里没有 AppID）。认不出来时明确报错 ——
    // 报错的原因会写进平台的回调验证结果，比返回一个错误签名好排查得多。
    const bot = candidates[0] || null;
    if (!bot) {
      logProbe(env, ctx, request, payload, raw, { err: 'unknown bot for url_validation' });
      return json({
        error: headerAppId
          ? `unknown AppID: ${headerAppId}（请先在控制台「机器人」页把它接入你的账号）`
          : 'cannot identify bot: missing X-Bot-Appid header',
      }, 404);
    }
    const resp = validationResponse(bot.app_secret, d.plain_token, d.event_ts);
    logProbe(env, ctx, request, payload, raw, { sig_ok: true, bot_id: bot.id, resp_sig: resp.signature.slice(0, 32) });
    return json(resp);
  }

  // 事件：逐个候选验签，第一个通过的即身份（同时完成鉴权与路由）
  const sig = request.headers.get('X-Signature-Ed25519') || '';
  const ts = request.headers.get('X-Signature-Timestamp') || '';
  const bot = candidates.find((b) => verifySignature(b.app_secret, sig, ts, raw)) || null;
  if (!bot) {
    logProbe(env, ctx, request, payload, raw, { sig_ok: false, sig: sig.slice(0, 32), ts, candidates: candidates.length });
    return json({ error: 'invalid signature' }, 401);
  }
  logProbe(env, ctx, request, payload, raw, { sig_ok: true, bot_id: bot.id });

  if (payload.t === 'GROUP_AT_MESSAGE_CREATE' && payload.d && payload.d.group_openid) {
    await addTarget(env, bot.id, 'group', payload.d.group_openid);
  }
  if (payload.t === 'C2C_MESSAGE_CREATE' && payload.d) {
    // 实测事件里 openid 在 d.author.user_openid（d.user_openid 不存在，两种路径都兼容）
    const oid = (payload.d.author && payload.d.author.user_openid) || payload.d.user_openid;
    if (oid) await addTarget(env, bot.id, 'c2c', oid);
  }
  return json({ opcode: 12 });
}

/* ---------------- Web 控制台接口（均需登录，路由挂 /api/bots） ---------------- */

// GET /api/bots —— 本账号的全部机器人（secret 只回掩码）
export async function listBots(request, env, userId, origin) {
  const [rows, targets] = await Promise.all([
    env.DB.prepare(`SELECT ${BOT_COLS} FROM bots WHERE user_id=? ORDER BY is_default DESC, id`).bind(userId).all(),
    targetsByBot(env, userId),
  ]);
  const bots = (rows.results || []).map((b) => botView(b, targets.get(Number(b.id)) || { group: [], c2c: [] }, origin));
  // default_msg_template 一并回给控制台：模板输入框拿它当 placeholder，用户不必去翻代码
  return json({ bots, max: MAX_BOTS_PER_USER, default_msg_template: DEFAULT_MSG_TEMPLATE });
}

// POST /api/bots —— 新建机器人（首个机器人自动成为默认）
export async function createBot(request, env, userId, origin) {
  const b = await readJson(request);
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM bots WHERE user_id=?').bind(userId).first();
  const total = Number(cnt && cnt.c) || 0;
  if (total >= MAX_BOTS_PER_USER) return json({ error: `每个账号最多 ${MAX_BOTS_PER_USER} 个机器人` }, 400);

  const appId = String(b.app_id || '').trim().slice(0, 64);
  if (appId) {
    const dup = await botByAppId(env, appId);
    if (dup) {
      return json({ error: Number(dup.user_id) === Number(userId) ? '这个 AppID 已经在本账号下接入过了' : '这个 AppID 已被其他账号接入' }, 409);
    }
  }

  const ts = now();
  const name = String(b.name || '').trim().slice(0, 32) || '新机器人';
  const isFirst = total === 0;
  const res = await env.DB.prepare(
    `INSERT INTO bots (user_id, name, app_id, app_secret, target, msg_template, is_default, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    userId, name, appId, String(b.app_secret || '').trim(),
    normalizeTarget(b.target),
    String(b.msg_template || '').trim() ? String(b.msg_template).slice(0, MAX_TEMPLATE_LEN) : null,
    isFirst ? 1 : 0, ts, ts,
  ).run();

  const bot = await env.DB.prepare(`SELECT ${BOT_COLS} FROM bots WHERE id=?`).bind(res.meta.last_row_id).first();
  return json({ ok: true, bot: botView(bot, { group: [], c2c: [] }, origin) }, 201);
}

// 切换默认机器人：先清旧默认再置新默认（保证「至多一个」）
async function makeDefault(env, userId, botId) {
  const ts = now();
  await env.DB.prepare('UPDATE bots SET is_default=0, updated_at=? WHERE user_id=? AND is_default=1 AND id<>?')
    .bind(ts, userId, botId).run();
  await env.DB.prepare('UPDATE bots SET is_default=1, updated_at=? WHERE id=? AND user_id=?')
    .bind(ts, botId, userId).run();
}

// PUT /api/bots/:id —— 更新（字段不传不改）：
//   name / target / msg_template（空串 = 恢复默认模板）/ is_default（true 即切换默认）
//   app_id：传空串清除；app_secret：空串 = 保持不变（表单留空语义），传值即覆盖；clear_secret=true 清除
//   unbind_kind + unbind_openid：从推送名单移除某个群 / 好友
export async function updateBot(request, env, userId, id, origin) {
  const bot = await env.DB.prepare(`SELECT ${BOT_COLS} FROM bots WHERE id=? AND user_id=?`).bind(id, userId).first();
  if (!bot) return json({ error: 'bot not found' }, 404);
  const b = await readJson(request);

  const sets = [];
  const vals = [];
  if (typeof b.name === 'string' && b.name.trim()) { sets.push('name=?'); vals.push(b.name.trim().slice(0, 32)); }
  if (b.app_id !== undefined) {
    const v = String(b.app_id).trim().slice(0, 64);
    if (v) {
      const dup = await botByAppId(env, v);
      if (dup && Number(dup.id) !== Number(bot.id)) {
        return json({ error: Number(dup.user_id) === Number(userId) ? '这个 AppID 已经在本账号下接入过了' : '这个 AppID 已被其他账号接入' }, 409);
      }
    }
    sets.push('app_id=?'); vals.push(v);
  }
  if (b.app_secret !== undefined && String(b.app_secret).trim() !== '') {
    sets.push('app_secret=?'); vals.push(String(b.app_secret).trim());
  }
  if (b.clear_secret) { sets.push('app_secret=?'); vals.push(''); }
  if (b.target !== undefined) {
    if (!VALID_TARGETS.includes(String(b.target).trim().toLowerCase())) {
      return json({ error: 'target 必须是 group / c2c / both' }, 400);
    }
    sets.push('target=?'); vals.push(normalizeTarget(b.target));
  }
  if (b.msg_template !== undefined) {
    const v = String(b.msg_template);
    sets.push('msg_template=?'); vals.push(v.trim() ? v.slice(0, MAX_TEMPLATE_LEN) : null);
  }
  if (sets.length) {
    sets.push('updated_at=?'); vals.push(now());
    vals.push(id, userId);
    await env.DB.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id=? AND user_id=?`).bind(...vals).run();
  }

  if (b.is_default) await makeDefault(env, userId, id);

  if (b.unbind_kind !== undefined && b.unbind_openid !== undefined) {
    const kind = String(b.unbind_kind);
    if (kind !== 'group' && kind !== 'c2c') return json({ error: 'unbind_kind 必须是 group / c2c' }, 400);
    await removeTarget(env, id, kind, b.unbind_openid);
  }

  const [fresh, targets] = await Promise.all([
    env.DB.prepare(`SELECT ${BOT_COLS} FROM bots WHERE id=?`).bind(id).first(),
    getTargets(env, id),
  ]);
  return json({ ok: true, bot: botView(fresh, targets, origin) });
}

// DELETE /api/bots/:id —— 删除机器人，并收拾干净它的引用：
//   名单随机器人一起删；绑过它的 key / job 置回 NULL（回落默认机器人，不留悬空引用）；
//   删的是默认机器人时，把剩下的第一个顶上来当默认。
export async function deleteBot(request, env, userId, id) {
  const bot = await env.DB.prepare(`SELECT ${BOT_COLS} FROM bots WHERE id=? AND user_id=?`).bind(id, userId).first();
  if (!bot) return json({ error: 'bot not found' }, 404);

  await env.DB.prepare('DELETE FROM bot_targets WHERE bot_id=?').bind(id).run();
  await env.DB.prepare('UPDATE `keys` SET bot_id=NULL WHERE user_id=? AND bot_id=?').bind(userId, id).run();
  await env.DB.prepare('UPDATE jobs SET bot_id=NULL WHERE user_id=? AND bot_id=?').bind(userId, id).run();
  await env.DB.prepare('DELETE FROM bots WHERE id=? AND user_id=?').bind(id, userId).run();

  if (bot.is_default) {
    const next = await env.DB.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY id LIMIT 1').bind(userId).first();
    if (next) await makeDefault(env, userId, next.id);
  }
  return json({ ok: true });
}

// DELETE /api/bots/:id/targets —— 从名单移除某个群 / 好友（body: {kind, openid}）
export async function removeBotTarget(request, env, userId, id) {
  const bot = await env.DB.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!bot) return json({ error: 'bot not found' }, 404);
  const b = await readJson(request);
  const kind = String(b.kind || '');
  const openid = String(b.openid || '');
  if (kind !== 'group' && kind !== 'c2c') return json({ error: 'kind 必须是 group / c2c' }, 400);
  if (!openid) return json({ error: 'openid is required' }, 400);
  await removeTarget(env, id, kind, openid);
  return json({ ok: true });
}

// POST /api/bots/:id/test —— 用该机器人的凭证真实换取一次 access_token（不发任何消息）
export async function testBot(request, env, userId, id) {
  const bot = await env.DB.prepare(`SELECT ${BOT_COLS} FROM bots WHERE id=? AND user_id=?`).bind(id, userId).first();
  if (!bot) return json({ error: 'bot not found' }, 404);
  if (!bot.app_id || !bot.app_secret) return json({ ok: false, error: '尚未配置 AppID / AppSecret' });
  try {
    await getAccessToken({ appId: bot.app_id, appSecret: bot.app_secret }, true);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err).slice(0, 300) });
  }
}

/* ---------------- 旧接口兼容（/api/qq/config、/api/qq/test） ---------------- */

// 重构前「一个账号一份机器人配置」，对应到新模型就是「账号默认机器人」。
// 保留这三个入口作为默认机器人的别名，避免已经发布的客户端（安卓端配置页）直接 404。
export async function legacyGetConfig(request, env, userId, origin) {
  const bot = await resolveBotFor(env, userId, null);
  if (!bot) {
    return json({
      app_id: '', has_secret: false, secret_masked: '', target: 'c2c', msg_template: '',
      group_openids: [], user_openids: [], is_default: true, bot_id: null,
      callback_url: `${origin}/api/qq/callback`,
      hint: '还没有接入机器人：在控制台「机器人」页新建一个并填入 AppID / AppSecret',
    });
  }
  return json({ ...botView(bot, await getTargets(env, bot.id), origin), bot_id: Number(bot.id) });
}

// 旧入口的写路径：没有机器人就顺手建一个，再按新模型的字段语义更新
export async function legacyUpdateConfig(request, env, userId, origin) {
  const b = await readJson(request);
  let bot = await resolveBotFor(env, userId, null);
  if (!bot) {
    const created = await createBot(
      new Request('https://x/api/bots', { method: 'POST', body: JSON.stringify(b) }), env, userId, origin,
    );
    if (created.status >= 400) return created;
    bot = await resolveBotFor(env, userId, null);
    // 建完已经把凭证写进去了，剩 target/msg_template/unbind 交给下面的更新路径处理
  }
  const forwarded = { ...b };
  delete forwarded.app_id;
  delete forwarded.app_secret;
  return updateBot(
    new Request('https://x/api/bots/' + bot.id, { method: 'PUT', body: JSON.stringify(forwarded) }), env, userId, bot.id, origin,
  );
}

// 旧入口的连接测试：测的是账号默认机器人（新接口请用 POST /api/bots/:id/test）
export async function legacyTestBot(request, env, userId) {
  const bot = await resolveBotFor(env, userId, null);
  if (!bot) return json({ ok: false, error: '还没有接入机器人（控制台「机器人」页新建并填入 AppID / AppSecret）' });
  if (!bot.app_id || !bot.app_secret) return json({ ok: false, error: '尚未配置 AppID / AppSecret' });
  try {
    await getAccessToken({ appId: bot.app_id, appSecret: bot.app_secret }, true);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err).slice(0, 300) });
  }
}
