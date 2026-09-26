// 前端配置。
//
// API_BASE 不再写死域名：控制台与 API 现在同进程同源（见 worker/src/server.js 的静态分支），
// 取当前 origin 就自动适配 127.0.0.1:7002 / 公网域名 / 换域名后的任何情况。
// 这里保留「绝对地址」而不是空串：接入文档页与 key 卡片会拿它拼出可复制的
// /hook/<KEY> 完整地址，用户直接粘进 crontab / CI，相对路径在那边是不可用的。
export const API_BASE = window.location.origin;
// Web 控制台只做配置，不拉取通知；轮询由安卓端负责
export const WEB_SHOW_NOTIFICATIONS = false;
