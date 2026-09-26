// 路由表回归测试：不依赖云端，直接打 default.fetch，断言「每个路由都已注册」。
//
// 起因（2026-09-10）：`updateKey` 函数一直在 keys.js 里，Web 与 App 也都在调
// `PUT /api/keys/:id`，但 index.js **从未注册过这条路由** —— 线上一直返回 404，
// 表现为「编辑 key 名称不生效」，而且两端都把 404 吞掉/提示得极不明显，藏了很久。
// 所以这里用一张清单把「所有对外承诺的接口」钉住：少一条就红。
// 路由现在改成了表驱动（index.js 的 ROUTES），这张清单就是它的对照面。
//
// 运行：cd worker && node test/routes.test.js
import nacl from 'tweetnacl';
import worker from '../src/index.js';

let bad = 0;
const ck = (name, cond, extra) => {
  if (!cond) { bad++; console.log('FAIL ', name, extra ?? ''); } else console.log('ok   ', name, extra ?? '');
};

// 记录所有绑定调用（openid 捕获落库断言用）。
// settings / bots / bot_targets 用内存结构模拟读写 —— 回调那条链路是「配置决定行为」的入口
// （按 AppID + 验签定位到哪个账号的机器人），必须能离线跑通并且钉死。
const dbCalls = [];
const settingsStore = new Map();
const botRows = [];        // { id, user_id, name, app_id, app_secret, target, msg_template, is_default }
const targetRows = [];     // { bot_id, kind, openid }

// 模拟 D1 的 prepare().bind() 与 prepare().all()（不 bind 直接执行也要支持 ——
// 例如「列出所有已配置的机器人」就是无参数的 all()）
const makeStmt = (sql, args) => {
  const isSettingsRead = /FROM settings/i.test(sql);
  const isSettingsUpsert = /INSERT INTO settings/i.test(sql) && /ON DUPLICATE KEY UPDATE/i.test(sql);
  const isSettingsDelete = /DELETE FROM settings/i.test(sql);
  const isBotByAppId = /FROM bots/i.test(sql) && /app_id\s*=/i.test(sql);
  const isBotsForVerify = /FROM bots/i.test(sql) && /app_secret\s*<>\s*''/i.test(sql);
  const isTargetInsert = /INSERT\s+IGNORE\s+INTO\s+bot_targets/i.test(sql);
  return {
    all: async () => ({ results: isBotsForVerify ? botRows.filter((b) => b.app_secret) : [] }),
    first: async () => {
      if (isSettingsRead) return { v: settingsStore.get(args[0]) ?? null };
      if (isBotByAppId) return botRows.find((b) => b.app_id === args[0]) || null;
      return null;
    },
    run: async () => {
      if (isSettingsUpsert) settingsStore.set(args[0], args[1]);
      else if (isSettingsDelete) settingsStore.delete(args[0]);
      else if (isTargetInsert) {
        const [botId, kind, openid] = args;
        const dup = targetRows.some((t) => t.bot_id === botId && t.kind === kind && t.openid === openid);
        if (!dup) targetRows.push({ bot_id: botId, kind, openid });
      }
      return { meta: {} };
    },
  };
};

const DB = {
  prepare: (sql) => {
    const bare = makeStmt(sql, []);
    return {
      all: bare.all,
      first: bare.first,
      run: bare.run,
      bind: (...args) => {
        dbCalls.push({ sql, args });
        return makeStmt(sql, args);
      },
    };
  },
};

// 账号 1 的机器人：凭证一律存在库里（env 兜底已随本次重构移除）
const SECRET32 = 'TEST_APP_SECRET_0123456789abcdef';   // 恰好 32 字节，验签要求
botRows.push({
  id: 1, user_id: 1, name: '账号1的机器人', app_id: 'TEST_APP_ID', app_secret: SECRET32,
  target: 'c2c', msg_template: null, is_default: 1,
});

const env = { DB, JWT_SECRET: 'test' };

const hitBody = async (method, path, opts = {}, e = env) => {
  const r = await worker.fetch(new Request('https://x' + path, { method, ...opts }), e);
  return { status: r.status, body: await r.text() };
};
const isUnregistered = (r) => r.status === 404 && r.body.includes('"error":"not found"') && !r.body.includes('service');

// [method, path, 说明] —— 与 README 的 API 表一一对应
const ROUTES = [
  ['POST', '/api/register', '注册'],
  ['POST', '/api/login', '登录'],
  ['POST', '/api/password', '修改密码'],
  ['POST', '/api/qq/callback', 'QQ 机器人回调（公开，验签）'],
  ['GET', '/api/bots', '机器人列表（账号隔离）'],
  ['POST', '/api/bots', '新建机器人'],
  ['PUT', '/api/bots/1', '编辑机器人（凭证/目标/模板/默认）'],
  ['DELETE', '/api/bots/1', '删除机器人'],
  ['POST', '/api/bots/1/test', '机器人连接测试'],
  ['DELETE', '/api/bots/1/targets', '从推送名单移除群/好友'],
  ['GET', '/api/qq/config', '旧接口兼容：默认机器人配置视图'],
  ['PUT', '/api/qq/config', '旧接口兼容：更新默认机器人'],
  ['POST', '/api/qq/test', '旧接口兼容：连接测试'],
  ['POST', '/api/keys', '新建 key'],
  ['GET', '/api/keys', '列出 key'],
  ['PUT', '/api/keys/1', '编辑 key（改名称/模式/模板/启停/机器人）'],
  ['DELETE', '/api/keys/1', '删除 key'],
  ['GET', '/api/notifications', '通知列表'],
  ['GET', '/api/notifications?key_id=1', '按 key 过滤'],
  ['GET', '/api/notifications?job_id=1', '按 job 过滤'],
  ['DELETE', '/api/notifications?key_id=1', '按 key 清空'],
  ['DELETE', '/api/notifications?job_id=1', '按 job 清空'],
  ['DELETE', '/api/notifications?key_id=1&job_id=1', '清空（双参数）'],
  ['DELETE', '/api/notifications', '清空（无参数应 400）'],
  ['GET', '/api/notifications/1', '通知详情'],
  ['DELETE', '/api/notifications/1', '删除单条通知'],
  ['POST', '/api/notifications/1/read', '标记已读'],
  ['GET', '/api/jobs', '任务列表'],
  ['POST', '/api/jobs', '新建任务'],
  ['PUT', '/api/jobs/1', '编辑任务'],
  ['DELETE', '/api/jobs/1', '删除任务'],
  ['GET', '/hook/somekey', 'webhook（公开）'],
  ['POST', '/hook/somekey', 'webhook（公开）'],
];

console.log('---- 路由注册检查（全部应已注册）----');
for (const [method, path, label] of ROUTES) {
  const r = await hitBody(method, path);
  ck(`${method} ${path}（${label}）`, !isUnregistered(r), `status=${r.status} body=${r.body.slice(0, 80)}`);
}

console.log('\n---- 反向对照：不存在的路径必须仍是 404 ----');
for (const path of [
  '/api/nope', '/api/keys/1/nope', '/api/users', '/api/app/latest', '/api/app/download',
  '/api/bots/1/nope',            // 机器人子路径只认 /test 与 /targets，多一段就是 404
  '/api/bots/abc',               // id 必须是数字，别被 /:id 的宽松匹配吃掉
]) {
  const r = await hitBody('GET', path);
  ck(`已删/未知路径 ${path} 返回 404`, isUnregistered(r), `status=${r.status} body=${r.body.slice(0, 60)}`);
}
// 已删除的 markDelivered 路由：POST 必须回到 404（GET 会被「通知详情」前缀路由接住，属正常行为）
const delRoute = await hitBody('POST', '/api/notifications/1/delivered');
ck('已删的 POST /notifications/:id/delivered 返回 404', isUnregistered(delRoute),
  `status=${delRoute.status} body=${delRoute.body.slice(0, 60)}`);

console.log('\n---- 清空接口必须拒绝无参数调用 ----');
const noParam = await hitBody('DELETE', '/api/notifications');
ck('DELETE /api/notifications 无参数为 401（鉴权在前）', noParam.status === 401, 'status=' + noParam.status);

console.log('\n---- PUT /api/keys/:id 的实际行为（历史上的主角）----');
const putKey = await hitBody('PUT', '/api/keys/1');
ck('PUT 无 body 未鉴权时返回 401 而非 404', putKey.status === 401, `status=${putKey.status} body=${putKey.body.slice(0, 80)}`);

/* ---------------- QQ 回调：多机器人路由 + 验签 ---------------- */

console.log('\n---- QQ 回调：URL 验证（op=13）----');

const signer = (secret) => {
  let seed = secret;
  while (seed.length < 32) seed = seed.repeat(2);
  const { secretKey } = nacl.sign.keyPair.fromSeed(new TextEncoder().encode(seed.slice(0, 32)));
  return (msg) => [...nacl.sign.detached(new TextEncoder().encode(msg), secretKey)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
};

const TOKEN_V = 'Arq0D5A61EgUu4OxUvOp';
const TS_V = '1725442341';

// 平台会带 X-Bot-Appid 指明是哪个机器人（op=13 的 payload 里没有 AppID），
// 用该机器人的 AppSecret 派生 Ed25519 私钥签 event_ts + plain_token
const uv = await hitBody('POST', '/api/qq/callback', {
  headers: { 'Content-Type': 'application/json', 'X-Bot-Appid': 'TEST_APP_ID' },
  body: JSON.stringify({ op: 13, d: { plain_token: TOKEN_V, event_ts: TS_V } }),
});
let uvBody = null;
try { uvBody = JSON.parse(uv.body); } catch { /* not json */ }
ck('url_validation 返回 {plain_token, signature} 且签名正确',
  uv.status === 200 && uvBody && uvBody.plain_token === TOKEN_V && uvBody.signature === signer(SECRET32)(TS_V + TOKEN_V),
  `status=${uv.status} body=${uv.body.slice(0, 60)}`);

// 只有一个机器人时，即使平台没带 AppID 头也能推断出来（候选唯一）
const uvNoHeader = await hitBody('POST', '/api/qq/callback', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ op: 13, d: { plain_token: TOKEN_V, event_ts: TS_V } }),
});
ck('唯一机器人时缺 AppID 头也能完成 URL 验证', uvNoHeader.status === 200, `status=${uvNoHeader.status}`);

// 认不出来的 AppID：明确报错（而不是签一个错的签名让平台猜）
const uvUnknown = await hitBody('POST', '/api/qq/callback', {
  headers: { 'Content-Type': 'application/json', 'X-Bot-Appid': 'NOT_REGISTERED' },
  body: JSON.stringify({ op: 13, d: { plain_token: TOKEN_V, event_ts: TS_V } }),
});
ck('未知 AppID 的 URL 验证返回 404 并说明原因',
  uvUnknown.status === 404 && uvUnknown.body.includes('NOT_REGISTERED'),
  `status=${uvUnknown.status} body=${uvUnknown.body.slice(0, 80)}`);

// 一个机器人都没接入时：404（而不是 500 —— 这不是服务故障，是没配）
const savedBots = botRows.splice(0, botRows.length);
const noBots = await hitBody('POST', '/api/qq/callback', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ op: 13, d: { plain_token: TOKEN_V, event_ts: TS_V } }),
});
botRows.push(...savedBots);
ck('没有任何机器人接入时回调返回 404', noBots.status === 404, 'status=' + noBots.status);

console.log('\n---- QQ 回调：事件验签与 openid 捕获 ----');

// 伪造事件（无有效签名）必须拒绝
const forged = await hitBody('POST', '/api/qq/callback', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'EVIL' } }),
});
ck('无有效签名的事件返回 401', forged.status === 401, `status=${forged.status} body=${forged.body.slice(0, 40)}`);

const signedPost = async (payload, { secret = SECRET32, appIdHeader = '' } = {}) => {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signer(secret)(ts + raw), 'X-Signature-Timestamp': ts };
  if (appIdHeader) headers['X-Bot-Appid'] = appIdHeader;
  const r = await worker.fetch(new Request('https://x/api/qq/callback', { method: 'POST', headers, body: raw }), env);
  return { status: r.status, body: await r.text() };
};

const c2cEv = await signedPost({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { user_openid: 'USER_ABC', content: '绑定', id: 'evt-c2c' } });
ck('C2C 事件验签通过', c2cEv.status === 200, `status=${c2cEv.status} body=${c2cEv.body.slice(0, 60)}`);
ck('C2C 事件把 user_openid 记进该机器人名下',
  targetRows.some((t) => t.bot_id === 1 && t.kind === 'c2c' && t.openid === 'USER_ABC'),
  JSON.stringify(targetRows));

const grpEv = await signedPost({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'GROUP_ABC', content: '@机器人', id: 'evt-grp' } });
ck('群事件验签通过', grpEv.status === 200, `status=${grpEv.status}`);
ck('群事件把 group_openid 记进该机器人名下',
  targetRows.some((t) => t.bot_id === 1 && t.kind === 'group' && t.openid === 'GROUP_ABC'),
  JSON.stringify(targetRows));

// 多好友扇出：第二个好友触发捕获应追加而非覆盖，名单变两条
const c2cEv2 = await signedPost({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: 'USER_DEF' }, content: '第二个人', id: 'evt-c2c2' } });
ck('第二个好友事件验签通过', c2cEv2.status === 200, `status=${c2cEv2.status}`);
ck('第二个好友追加进名单（不覆盖）',
  targetRows.filter((t) => t.bot_id === 1 && t.kind === 'c2c').map((t) => t.openid).join() === 'USER_ABC,USER_DEF',
  JSON.stringify(targetRows.filter((t) => t.bot_id === 1)));

// 重复捕获同一好友不产生新的写库
const beforeDup = targetRows.length;
await signedPost({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: 'USER_DEF' }, content: '再说一句', id: 'evt-c2c3' } });
ck('重复好友不重复写库', targetRows.length === beforeDup, `before=${beforeDup} after=${targetRows.length}`);

// 内容被篡改（签名对不上实际 body）必须 401
const tsT = '1700000000';
const sigT = signer(SECRET32)(tsT + JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { user_openid: 'GOOD' } }));
const tamper = await worker.fetch(new Request('https://x/api/qq/callback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sigT, 'X-Signature-Timestamp': tsT },
  body: JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { user_openid: 'EVIL' } }),
}), env);
ck('篡改 body 的事件返回 401', tamper.status === 401, 'status=' + tamper.status);

console.log('\n---- QQ 回调：多账号隔离（同一个回调地址，签名即身份）----');

// 账号 2 的机器人：AppID / Secret / 名单都不同
const SECRET_2 = 'SECRET_2';
botRows.push({
  id: 2, user_id: 2, name: '账号2的机器人', app_id: 'APP_ID_2', app_secret: SECRET_2,
  target: 'group', msg_template: null, is_default: 1,
});

// 事件里没有 AppID，两个机器人并存时靠验签区分归属
const ev2 = await signedPost(
  { op: 0, t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: 'USER_OF_2' }, id: 'evt-2' } },
  { secret: SECRET_2 },
);
ck('账号2 机器人的事件验签通过', ev2.status === 200, `status=${ev2.status}`);
ck('事件只记进它自己的账号（不串到账号1）',
  targetRows.some((t) => t.bot_id === 2 && t.openid === 'USER_OF_2')
  && !targetRows.some((t) => t.bot_id === 1 && t.openid === 'USER_OF_2'),
  JSON.stringify(targetRows));

// 带了 AppID 头但签名不属于它 → 401（头只是「路由提示」，签名才是身份，伪造成不了事）
const spoof = await signedPost(
  { op: 0, t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: 'SPOOF' }, id: 'evt-spoof' } },
  { secret: SECRET32, appIdHeader: 'APP_ID_2' },
);
ck('拿别人的 AppID 头配自己的签名 → 401', spoof.status === 401, `status=${spoof.status}`);
ck('被拒绝的事件不落任何名单', !targetRows.some((t) => t.openid === 'SPOOF'), JSON.stringify(targetRows));

console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
process.exit(bad ? 1 : 0);
