// App 版本检查与 APK 下载代理（公开接口，无需登录）
//   GET /api/app/latest    → 最新 Release 的版本信息（从 Release body 解析 VERSION_CODE/VERSION_NAME）
//   GET /api/app/download  → 以流方式代理 latest Release 的 APK（私有仓库需 GITHUB_TOKEN）
// 仓库是私有的：GitHub 直链匿名不可访问，必须经 Worker 用 GITHUB_TOKEN 转发。
import { json } from './utils.js';

const GH_REPO = 'waxilo/notify-hub';
const CACHE_MS = 60_000;

let relCache = { at: 0, data: null };

function ghHeaders(env, extra = {}) {
  const h = { 'User-Agent': 'notify-hub-worker', 'Accept': 'application/vnd.github+json', ...extra };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function getLatestRelease(env) {
  if (relCache.data && Date.now() - relCache.at < CACHE_MS) return relCache.data;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`, {
    headers: ghHeaders(env),
  });
  if (!r.ok) return null;
  const rel = await r.json();
  relCache = { at: Date.now(), data: rel };
  return rel;
}

// Release body 里约定格式：
//   VERSION_CODE=12
//   VERSION_NAME=1.0.12
function parseVersion(body, fallbackDate) {
  const code = Number((body || '').match(/VERSION_CODE=(\d+)/)?.[1]) || null;
  const name = (body || '').match(/VERSION_NAME=([\w.\-]+)/)?.[1] || null;
  return { versionCode: code, versionName: name, publishedAt: fallbackDate };
}

export async function appLatest(env) {
  const rel = await getLatestRelease(env);
  if (!rel) return json({ error: 'no release available' }, 404);
  const asset = (rel.assets || []).find((a) => a.name.endsWith('.apk'));
  if (!asset) return json({ error: 'no apk asset in release' }, 404);
  return json({
    ...parseVersion(rel.body, rel.published_at),
    apkSize: asset.size,
    updatedAt: asset.updated_at,
  });
}

export async function appDownload(env) {
  const rel = await getLatestRelease(env);
  if (!rel) return new Response('no release available', { status: 404 });
  const asset = (rel.assets || []).find((a) => a.name.endsWith('.apk'));
  if (!asset) return new Response('no apk asset', { status: 404 });
  // octet-stream Accept 会 302 到预签名直链，fetch 自动跟随
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/assets/${asset.id}`, {
    headers: ghHeaders(env, { Accept: 'application/octet-stream' }),
    redirect: 'follow',
  });
  if (!r.ok) return new Response('download failed', { status: 502 });
  return new Response(r.body, {
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${asset.name}"`,
      'Content-Length': String(asset.size),
    },
  });
}
