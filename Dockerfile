# 一个镜像装下 API（Node 服务）与 Web 控制台（pages/ 静态文件），同源提供 ——
# 迁出 Cloudflare 之后不再有 Worker/Pages 两个部署面，也就没有 CORS 与两套域名。
#
# 构建上下文 = 仓库根（见 docker-compose.yml），因为 server.js 按
# 「worker/ 与 pages/ 同级」找静态目录（STATIC_DIR 默认 = ../pages）。
#
# 不写 `# syntax=` 指令：这台机器拉不到外部的 dockerfile frontend 镜像，
# 内置 frontend 已支持本文件用到的全部语法。
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# 依赖单独一层：只改源码的重复构建不会重新 npm ci
COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker && npm ci --omit=dev

COPY worker/ ./worker/
COPY pages/ ./pages/

# 不 chown：代码与依赖归 root 只读，进程（node 用户）写不到自己的二进制里去，
# 运行时唯一需要写的地方是 MySQL。writing-assistant 那边 chown 是因为要在 /build 里 npm prune，
# 这里没有那个动作。
USER node
EXPOSE 8787

# 不用 docker --init / tini：server.js 自己装了 SIGTERM 处理（先停接单、再等 waitUntil
# 的尾巴跑完才退），node 作为 PID 1 收到 docker stop 的信号就会走这条路。
CMD ["node", "worker/src/server.js"]
