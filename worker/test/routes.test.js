// 路由表回归测试：不依赖云端，直接打 default.fetch，断言「每个路由都已注册」。
//
// 起因（2026-09-10）：`updateKey` 函数一直在 keys.js 里，Web 与 App 也都在调
// `PUT /api/keys/:id`，但 index.js **从未注册过这条路由** —— 线上一直返回 404，
// 表现为「编辑 key 名称不生效」，而且两端都把 404 吞掉/提示得极不明显，藏了很久。
// 所以这里用一张清单把「所有对外承诺的接口」钉住：少一条就红。
//
// 运行：cd worker && node test/routes.test.js
import nacl from 'tweetnacl';
import worker from '../src/index.js';

let bad = 0;
const ck = (name, cond, extra) => {
  if (!cond) { bad++; console.log('FAIL ', name, extra ?? ''); } else console.log('ok   ', name, extra ?? '');
};

// 记录所有绑定调用（openid 捕获落库断言用），其余行为与纯 stub 一致
const dbCalls = [];
const DB = {
  prepare: (sql) => ({
    bind: (...args) => {
      dbCalls.push({ sql, args });
      return { all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: {} }) };
    },
  }),
};

// 只需要 DB 存在（路由匹配后才会用到，未鉴权时先撞 401）
const env = {
  DB,
  JWT_SECRET: 'test',
  QQ_APP_ID: 'TEST_APP_ID',
  QQ_APP_SECRET: 'TEST_APP_SECRET',
};

const hitBody = async (method, path, opts = {}) => {
  const r = await worker.fetch(new Request('https://x' + path, { method, ...opts }), env);
  return { status: r.status, body: await r.text() };
};
const isUnregistered = (r) => r.status === 404 && r.body.includes('"error":"not found"') && !r.body.includes('service');

// [method, path, 说明] —— 与 README 的 API 表一一对应
const ROUTES = [
  ['POST', '/api/register', '注册'],
  ['POST', '/api/login', '登录'],
  ['POST', '/api/password', '修改密码'],
  ['POST', '/api/qq/callback', 'QQ 机器人回调（公开，验签）'],
  ['GET', '/api/qq/config', 'QQ 机器人配置视图'],
  ['PUT', '/api/qq/config', '更新 QQ 机器人配置'],
  ['POST', '/api/qq/test', 'QQ 机器人连接测试'],
  ['POST', '/api/qq/listen', 'QQ openid 监听捕获（WS 客户端）'],
  ['POST', '/api/keys', '新建 key'],
  ['GET', '/api/keys', '列出 key'],
  ['PUT', '/api/keys/1', '编辑 key（改名称/模式/模板/启停）'],
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
for (const path of ['/api/nope', '/api/keys/1/nope', '/api/users', '/api/app/latest', '/api/app/download']) {
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

console.log('\n---- PUT /api/keys/:id 的实际行为（本次修复的主角）----');
const putKey = await hitBody('PUT', '/api/keys/1');
ck('PUT 无 body 未鉴权时返回 401 而非 404', putKey.status === 401, `status=${putKey.status} body=${putKey.body.slice(0, 80)}`);

console.log('\n---- QQ 回调行为 ----');
// url_validation（op=13）：官方要求在 5 秒内原样返回 AppSecret 明文
const uv = await hitBody('POST', '/api/qq/callback', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ op: 13, d: {} }),
});
ck('url_validation 回显 AppSecret 明文', uv.status === 200 && uv.body === 'TEST_APP_SECRET',
  `status=${uv.status} body=${uv.body.slice(0, 40)}`);

// 伪造事件（无有效签名）必须拒绝
const forged = await hitBody('POST', '/api/qq/callback', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'EVIL' } }),
});
ck('无有效签名的事件返回 401', forged.status === 401, `status=${forged.status} body=${forged.body.slice(0, 40)}`);

// 未配置 QQ 凭证时回调返回 500（明确提示，而非静默 404）
const noQQ = await worker.fetch(new Request('https://x/api/qq/callback', {
  method: 'POST', body: JSON.stringify({ op: 13 }),
}), { DB: env.DB, JWT_SECRET: 'test' });
ck('未配置 QQ 凭证返回 500', noQQ.status === 500, 'status=' + noQQ.status);

console.log('\n---- QQ 回调自动捕获 openid（真实 Ed25519 签名）----');
// verifySignature 要求 seed 恰好 32 字节，这里用等长的假 secret 派生真实密钥对
const SECRET32 = 'TEST_APP_SECRET_0123456789abcdef';
const signedEnv = { ...env, QQ_APP_SECRET: SECRET32 };
const { secretKey } = nacl.sign.keyPair.fromSeed(new TextEncoder().encode(SECRET32));
const signedPost = async (payload) => {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = nacl.sign.detached(new TextEncoder().encode(ts + raw), secretKey);
  const sigHex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  const r = await worker.fetch(new Request('https://x/api/qq/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sigHex, 'X-Signature-Timestamp': ts },
    body: raw,
  }), signedEnv);
  return { status: r.status, body: await r.text() };
};

const c2cEv = await signedPost({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { user_openid: 'USER_ABC', content: '绑定', id: 'evt-c2c' } });
ck('C2C 事件验签通过', c2cEv.status === 200, `status=${c2cEv.status} body=${c2cEv.body.slice(0, 60)}`);
const c2cWrite = dbCalls.find((c) => c.sql.includes('INSERT INTO settings') && c.args[0] === 'qq_user_openid');
ck('C2C 事件自动捕获 user_openid 落库', !!c2cWrite && c2cWrite.args[1] === 'USER_ABC', JSON.stringify(c2cWrite && c2cWrite.args));

const grpEv = await signedPost({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'GROUP_ABC', content: '@机器人', id: 'evt-grp' } });
ck('群事件验签通过', grpEv.status === 200, `status=${grpEv.status}`);
const grpWrite = dbCalls.find((c) => c.sql.includes('INSERT INTO settings') && c.args[0] === 'qq_group_openid');
ck('群事件自动捕获 group_openid 落库', !!grpWrite && grpWrite.args[1] === 'GROUP_ABC', JSON.stringify(grpWrite && grpWrite.args));

// 内容被篡改（签名对不上实际 body）必须 401
const tsT = '1700000000';
const rawT = JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { user_openid: 'EVIL' } });
const sigT = nacl.sign.detached(new TextEncoder().encode(tsT + JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { user_openid: 'GOOD' } })), secretKey);
const tamper = await worker.fetch(new Request('https://x/api/qq/callback', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Signature-Ed25519': [...sigT].map((b) => b.toString(16).padStart(2, '0')).join(''),
    'X-Signature-Timestamp': tsT,
  },
  body: rawT,
}), signedEnv);
ck('篡改 body 的事件返回 401', tamper.status === 401, 'status=' + tamper.status);

console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
process.exit(bad ? 1 : 0);
