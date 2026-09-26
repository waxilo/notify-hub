#!/usr/bin/env bash
# 用当前工作树重建镜像并重启容器。部署目标就是这台机器 —— 不再往任何云推。
#
#   ./scripts/deploy.sh                 # 闸门（npm test）→ 构建 → up -d → 探活
#   ./scripts/deploy.sh --skip-checks   # 跳过本地闸门（紧急回滚时用，别当常态）
#   ./scripts/deploy.sh --logs          # 结束后跟踪日志
#
# 为什么把 npm test 放在构建前面：三套测试里有 201 条断言直接跑在真实 MySQL 上
# （含 SQL 方言、索引命中、账号隔离、QQ 回调验签），镜像构建本身不跑测试。
# 少这道闸门，方言里一个 SQLite 残留就是要到第一个线上请求才炸。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_CHECKS=0
SHOW_LOGS=0
for arg in "$@"; do
  case "$arg" in
    --skip-checks) SKIP_CHECKS=1 ;;
    --logs) SHOW_LOGS=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "❌ 缺少 .env，先执行 ./scripts/db-init.sh" >&2; exit 1; }
docker network inspect mysql-server_default >/dev/null 2>&1 || {
  echo "❌ 网络 mysql-server_default 不存在，先启动数据库：../mysql-server/scripts/start.sh" >&2
  exit 1
}
# compose 以 external 引用 gw_default，缺它 `docker compose up` 直接失败 —— 提前说清原因
docker network inspect gw_default >/dev/null 2>&1 || {
  echo "❌ 网络 gw_default 不存在，先启动共享公网入口：../gw（./scripts/gw-join.sh 可一并接好）" >&2
  exit 1
}

if [ "$SKIP_CHECKS" -eq 0 ]; then
  echo "==> 测试（MySQL 方言 + 路由 + 调度）"
  [ -f .env.test ] || echo "   ⚠️  没有 .env.test，测试会退回读 .env 并被「必须是 _test 库」的闸门拦下"
  (cd worker && npm test)
fi

echo "==> 构建镜像"
docker compose build

echo "==> 启动容器"
docker compose up -d

echo "==> 等待健康检查"
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' notify-hub 2>/dev/null || echo starting)
  [ "$status" = healthy ] && break
  sleep 2
done
docker compose ps

bind=$(sed -n 's/^APP_BIND_ADDR=//p' .env | head -1)
port=$(sed -n 's/^APP_PORT=//p' .env | head -1)
echo ""
echo "✅ 部署完成： http://${bind:-127.0.0.1}:${port:-8788}   （健康检查：${status}）"

# 公网入口由共享的 ../gw 提供：网关上有这个域名的 vhost 才算接入。
# 名字逐个探，因为 Worker 时代的 -worker 与现在的短域名可能只存在其中一个。
for host in notify-hub.sloan.dpdns.org notify-hub-worker.sloan.dpdns.org; do
  conf="../gw/conf.d/${host%%.*}.conf"
  [ -f "$conf" ] || continue
  gw_state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' gw 2>/dev/null || echo 未启动)
  # 真探一次上游：必须从网关容器里发，宿主机发布的端口在容器网络里连不通，
  # 而本机 curl 会被 /etc/hosts 的接管行骗过去（照样「通」，但通的是本机网关）。
  if up=$(docker exec gw wget -qO- -T 5 "http://notify-hub:8787/healthz" 2>&1); then
    echo "   公网入口： https://${host}   （网关 gw：${gw_state}，上游：${up}）"
  else
    echo "   ⚠️ vhost 就位（https://${host}）但网关容器连不上 notify-hub:8787：${up}"
    echo "      多半是本项目没加入 gw_default 网络 —— 跑 ./scripts/gw-join.sh"
  fi
done

[ "$SHOW_LOGS" -eq 1 ] && exec docker compose logs -f
