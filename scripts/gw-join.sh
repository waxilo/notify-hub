#!/usr/bin/env bash
# 把本项目接到共享公网入口 ../gw（可重复执行）。
#
#   ./scripts/gw-join.sh [公网域名]        # 默认 notify-hub-worker.sloan.dpdns.org
#
# 依次做四件事：
#   1. 确认 ../gw 存在且网关容器在跑
#   2. 确保共享网络 gw_default 存在（本项目 compose 以 external 引用它）
#   3. .env 写 TRUST_PROXY=1
#   4. 调 ../gw/scripts/gw-add-host.sh：生成 nginx vhost + 网关内 reload
#
# 域名沿用 Worker 时代那一个（notify-hub-worker.sloan.dpdns.org），是刻意的：
# QQ 开放平台填的回调地址、以及已经发出去的安卓端里写死的 API 地址都是它 ——
# 换名要动的地方越多，切换当天出错的面越大。DNS 侧零操作：隧道带的是
# *.sloan.dpdns.org 通配记录，网关只是多了一个按 Host 转发的 server 块。
#
# 前置条件（不在本脚本里做，见 README「切流量」）：先把 Worker 的 custom domain
# 路由删掉。那条路由会一直把这个名字抢回 Cloudflare 边缘，网关收不到流量。
#
# TRUST_PROXY 是必须的：回调地址由请求的 origin 拼出来（src/bots.js 的 callback_url），
# 不信任转发头时容器只能看到 http://127.0.0.1:8787，回给 QQ 控制台的地址就是错的。
#
# 撤销公网访问：删掉 ../gw/conf.d/notify-hub-worker.conf 并在网关内 reload。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PUBLIC_HOSTNAME="${1:-notify-hub-worker.sloan.dpdns.org}"
CONTAINER_TARGET="notify-hub:8787"   # 必须是容器名：网关容器里的 127.0.0.1 是它自己
GW_DIR="${GW_DIR:-$ROOT_DIR/../gw}"
NETWORK=gw_default

[ -f "$GW_DIR/scripts/gw-add-host.sh" ] || {
  echo "❌ 找不到共享入口项目 $GW_DIR，先建好并执行 ../gw/scripts/gw-init.sh" >&2
  exit 1
}
[ "$(docker inspect -f '{{.State.Running}}' gw 2>/dev/null || echo false)" = "true" ] || {
  echo "❌ 网关 gw 没在跑：cd $GW_DIR && docker compose up -d" >&2
  exit 1
}

echo "==> 确保共享网络 $NETWORK 存在"
# 正常由 ../gw/scripts/gw-init.sh 创建；这里兜底一次，让 clone 后单独跑本脚本也能成。
docker network create "$NETWORK" >/dev/null 2>&1 && echo "    已创建" || echo "    已存在，跳过"

echo "==> 更新 .env（TRUST_PROXY=1）"
[ -f .env ] || { echo "❌ 缺少 .env，先执行 ./scripts/db-init.sh" >&2; exit 1; }
if grep -q "^TRUST_PROXY=" .env; then
  sed -i '' -E 's|^TRUST_PROXY=.*|TRUST_PROXY=1|' .env
else
  printf 'TRUST_PROXY=1\n' >>.env
fi

echo "==> 让容器挂上 $NETWORK 并按新配置重启"
# 不加 --force-recreate：compose 按配置（含 env_file 内容）哈希自己判断要不要重建，
# .env 刚从 TRUST_PROXY=0 改成 1，这一步必然重建；没变就不该白重启一次。
docker compose up -d

echo "==> 登记域名 $PUBLIC_HOSTNAME → $CONTAINER_TARGET"
( cd "$GW_DIR" && ./scripts/gw-add-host.sh "$PUBLIC_HOSTNAME" "$CONTAINER_TARGET" )

echo ""
echo "✅ 就绪。https://$PUBLIC_HOSTNAME"
echo "   本机验证： curl -s https://$PUBLIC_HOSTNAME/healthz --resolve $PUBLIC_HOSTNAME:443:127.0.0.1"
echo "   网关健康： docker inspect -f '{{.State.Health.Status}}' gw    日志：docker logs gw"
