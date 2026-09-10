// 路由表回归测试：不依赖云端，直接打 default.fetch，断言「每个路由都已注册」。
//
// 起因（2026-09-10）：`updateKey` 函数一直在 keys.js 里，Web 与 App 也都在调
// `PUT /api/keys/:id`，但 index.js **从未注册过这条路由** —— 线上一直返回 404，
// 表现为「编辑 key 名称不生效」，而且两端都把 404 吞掉/提示得极不明显，藏了很久。
// 所以这里用一张清单把「所有对外承诺的接口」钉住：少一条就红。
//
// 运行：cd worker && node test/routes.test.js
import worker from '../src/index.js';

let bad = 0;
const ck = (name, cond, extra) => {
  if (!cond) { bad++; console.log('FAIL ', name, extra ?? ''); } else console.log('ok   ', name, extra ?? '');
};

// 只需要 DB/PUSH_HUB 存在（路由匹配后才会用到，未鉴权时先撞 401）
const env = {
  DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: {} }) }) }) },
  PUSH_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response('{}') }) },
  JWT_SECRET: 'test',
};

const hit = async (method, path) => {
  const r = await worker.fetch(new Request('https://x' + path, { method }), env);
  return r.status;
};

// 未鉴权时：已注册 = 401（或 400/403/404 等业务响应），未注册 = 404 + {"error":"not found"}
// 注意 /api/notifications/:id 这类路由自己也可能返回 404，所以额外看响应体：
// 未注册时 body 一定是 {"error":"not found"}，注册后由各自的 handler 决定。
const hitBody = async (method, path) => {
  const r = await worker.fetch(new Request('https://x' + path, { method }), env);
  return { status: r.status, body: await r.text() };
};
const isUnregistered = (r) => r.status === 404 && r.body.includes('"error":"not found"') && !r.body.includes('service');

// [method, path, 说明] —— 与 README 的 API 表一一对应
const ROUTES = [
  ['POST', '/api/register', '注册'],
  ['POST', '/api/login', '登录'],
  ['POST', '/api/password', '修改密码'],
  ['GET', '/api/app/latest', '版本检查（公开）'],
  ['GET', '/api/app/download', 'APK 下载（公开）'],
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
  ['POST', '/api/notifications/1/delivered', '标记已触达'],
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
for (const path of ['/api/nope', '/api/keys/1/nope', '/api/users']) {
  const r = await hitBody('GET', path);
  ck(`未知路径 ${path} 返回 404`, isUnregistered(r), `status=${r.status} body=${r.body.slice(0, 60)}`);
}

console.log('\n---- 清空接口必须拒绝无参数调用 ----');
const noParam = await hitBody('DELETE', '/api/notifications');
ck('DELETE /api/notifications 无参数为 401（鉴权在前）', noParam.status === 401, 'status=' + noParam.status);

console.log('\n---- PUT /api/keys/:id 的实际行为（本次修复的主角）----');
const putKey = await hitBody('PUT', '/api/keys/1');
ck('PUT 无 body 未鉴权时返回 401 而非 404', putKey.status === 401, `status=${putKey.status} body=${putKey.body.slice(0, 80)}`);

console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
process.exit(bad ? 1 : 0);
