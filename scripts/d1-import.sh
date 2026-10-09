#!/usr/bin/env bash
# 把线上 D1 的数据搬到本机 MySQL（迁移期「先导入、再切流量、最后下线 Worker」的第一步）。
#
#   ./scripts/d1-import.sh              # 导出 + 干跑：只打印计划与差异，一行都不写
#   ./scripts/d1-import.sh --apply      # 导出 + 正式写入 + 逐行逐字段回读校验
#
# 为什么要这个包装：wrangler 那条命令上有三个本机专属的坑，少一个就白跑一趟 ——
#   1) 直连 api.cloudflare.com 拨不通，必须走本机代理（HTTPS_PROXY）；
#   2) 配置文件必须显式 -c wrangler.toml：桌面上另有一个 ~/Desktop/Code/wrangler.jsonc，
#      wrangler 会往上找到它，报的错还跟真正原因毫无关系；
#   3) 仓库里装的是 wrangler 3，D1 导出要用 4（npx wrangler@4 现取）。
# 真正的搬运与校验逻辑在 scripts/d1-to-mysql.mjs，本脚本只负责把导出文件准备好。
#
# 目标库取自 .env（DB_NAME=notify_hub）；想先拿临时库演练一遍，导出时带 DB_NAME_IMPORT=xxx。
#
# 注意：dump.sql 里有密码哈希和 AppSecret 明文（已 gitignore），搬完确认无误后删掉：
#   rm -f worker/.d1-export/dump.sql
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APPLY=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY="--apply" ;;
    *) echo "未知参数：$arg（只认 --apply）" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "❌ 缺少 .env，先执行 ./scripts/db-init.sh" >&2; exit 1; }
[ -f worker/wrangler.toml ] || { echo "❌ 缺少 worker/wrangler.toml（导出要知道 D1 库的绑定名）" >&2; exit 1; }

# 容器在跑时导入是自找麻烦：它的定时器会往目标库写行（于是「非空闸门」报的错看起来像脚本坏了），
# 更要紧的是云上 Worker 的 Cron Trigger 还活着 —— 两边各读各的库、各自的去重键互不可见，
# 同一个任务会推两遍到真实的群和好友。所以这里硬性要求先停。
if [ "$(docker inspect -f '{{.State.Running}}' notify-hub 2>/dev/null || echo false)" = "true" ]; then
  echo "❌ 容器 notify-hub 正在运行。先 docker compose stop，导完再按 README「切流量」的顺序起回来。" >&2
  exit 1
fi

echo "==> 1/3 导出线上 D1（经代理 ${HTTPS_PROXY:-http://127.0.0.1:7897}）"
mkdir -p worker/.d1-export
(
  cd worker
  HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:7897}" \
    npx --yes wrangler@4 d1 export notify-hub --remote --skip-confirmation \
      -c wrangler.toml --output .d1-export/dump.sql
)
wc -c < worker/.d1-export/dump.sql | xargs printf '    dump.sql %s 字节\n'

# .env 的 DB_HOST 是「容器视角」—— 那个名字只在 compose 网络里存在，宿主机上解析不了
# （报错就是 getaddrinfo ENOTFOUND mysql）。同一个实例在宿主机上是 127.0.0.1:3306，
# 共享容器发布的正是回环地址，所以本脚本默认换成它。要指别处就带着环境变量跑：
#   DB_HOST=10.0.0.5 ./scripts/d1-import.sh
export DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-3306}"

echo "==> 2/3 干跑：核对表与列的差异（不写数据，目标库 ${DB_HOST}:${DB_PORT}）"
node scripts/d1-to-mysql.mjs

if [ -n "$APPLY" ]; then echo "==> 3/3 正式导入并回读校验"; else echo "==> 3/3 未加 --apply，到此为止"; fi
[ -n "$APPLY" ] || { echo "    看过上面的差异，确认无误后再执行：./scripts/d1-import.sh --apply"; exit 0; }
node scripts/d1-to-mysql.mjs --apply

cat <<'EOF'

✅ 数据已在本机库里。下一步按 README「切流量与 Cloudflare 收尾」的编号走，要点是别留双跑的窗口：
  1. 先在 Cloudflare 控制台删掉 Worker 的 Cron Trigger（不要靠重新部署来停 —— 现在仓库里的
     src/ 已是 MySQL 方言，重新部署会把老 Worker 换成跑不了的代码）
  2. JOBS_TICK_DISABLED=1 ./scripts/deploy.sh   # 只验 HTTP，定时器不装
  3. ./scripts/gw-join.sh 并删掉 Worker 的 custom domain 路由（不删，域名一直被边缘接走）
  4. 去掉 JOBS_TICK_DISABLED 起回来，容器定时器成为唯一执行者
  5. 到 q.qq.com 把回调 URL 重新保存验证一次；观察稳定后再下线 Worker 与 Pages
EOF
