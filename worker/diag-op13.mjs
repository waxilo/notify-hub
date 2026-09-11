// 临时诊断脚本：用真实 secret 独立复算 op=13 签名，与线上响应对比
import { spawnSync } from 'node:child_process';
import nacl from 'tweetnacl';

const out = spawnSync(
  process.execPath,
  ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'notify-hub', '--remote', '--command', 'SELECT v FROM settings WHERE k = \'qq_app_secret\'', '--json'],
  { encoding: 'utf8' },
);
const jsonStart = out.stdout.indexOf('[');
const secret = JSON.parse(out.stdout.slice(jsonStart))[0].results[0].v;
console.log('secret length:', secret.length, 'ascii-only:', /^[\x20-\x7e]+$/.test(secret));

// 官方算法：seed = secret（不足 32 重复填充），msg = event_ts + plain_token
let seedStr = secret;
while (seedStr.length < 32) seedStr = seedStr.repeat(2);
seedStr = seedStr.slice(0, 32);
const { secretKey } = nacl.sign.keyPair.fromSeed(new TextEncoder().encode(seedStr));

const plainToken = 'probe123';
const eventTs = '1726000000';
const msg = new TextEncoder().encode(eventTs + plainToken);
const expectSig = [...nacl.sign.detached(msg, secretKey)].map((b) => b.toString(16).padStart(2, '0')).join('');

const B = 'https://notify-hub-worker.sloan.dpdns.org/api/qq/callback';
const body = JSON.stringify({ op: 13, d: { plain_token: plainToken, event_ts: eventTs } });

// 普通 UA + QQBot-Callback UA 各打一次（检验 Cloudflare 是否拦截非浏览器 UA）
for (const ua of ['node-probe', 'QQBot-Callback']) {
  const r = await fetch(B, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'X-Bot-Appid': '1905593649' }, body });
  const text = await r.text();
  let sig = '';
  try { sig = JSON.parse(text).signature || ''; } catch { /* non-json */ }
  console.log(`UA=${ua}: status=${r.status} ct=${r.headers.get('content-type')} sigMatch=${sig === expectSig} bodyPrefix=${text.slice(0, 60)}`);
}
