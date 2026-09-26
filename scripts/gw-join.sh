#!/usr/bin/env bash
# 把本项目接到共享公网入口 ../gw（可重复执行）。
#
#   ./scripts/gw-join.sh [公网域名]        # 默认 notify-hub.sloan.dpdns.org
#
# 依次做四件事：
#   1. 确认 ../gw 存在且网关容器在跑
#   2. 确保共享网络 gw_default 存在（本项目 compose 以 external 引用它）
#   3. .env 写 TRUST_PROXY=1
#   4. 调 ../gw/scripts/gw-add-host.sh：生成 nginx vhost + 网关内 reload
#
# 当前公网名是短域名 notify-hub.sloan.dpdns.org（../gw/conf.d/notify-hub.conf）。
# Worker 时代那个 notify-hub-worker.sloan.dpdns.org 在网关上没有 server 块，
# 于是被 fail-closed 的默认 server 回 404 —— 凡是写死旧名的回调地址 / 已发布端，
# 要么改成短域名，要么再跑一次 `./scripts/gw-join.sh notify-hub-worker.sloan.dpdns.org`
# 补一个别名 vhost。DNS 侧两种走法都零操作：隧道带的是 *.sloan.dpdns.org 通配记录。
#
# 前置条件（不在本脚本里做，见 README「切流量」）：Cloudflare 侧不能再有这条
# custom domain 路由。路由在的时候边缘把名字接走，网关收不到流量。
#
# TRUST_PROXY 是必须的：回调地址由请求的 origin 拼出来（src/bots.js 的 callback_url），
# 不信任转发头时容器只能看到 http://127.0.0.1:80，回给 QQ 控制台的地址就是错的。
#
# 撤销公网访问：删掉 ../gw/conf.d/<名字首段>.conf 并在网关内 reload。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PUBLIC_HOSTNAME="${1:-notify-hub.sloan.dpdns.org}"
CONTAINER_TARGET="notify-hub:80"   # 必须是容器名：网关容器里的 127.0.0.1 是它自己
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
