// PushHub Durable Object：按用户维度的 WebSocket 推送枢纽
// - 每个 userId 一个 DO 实例（idFromName(userId)）
// - 客户端经 Worker 鉴权后转发 /connect 升级为 WebSocket
// - webhook 收到新消息后 Worker 调 /notify，DO 广播给该用户所有在线连接
// 使用 Hibernation API：连接空闲时不计费、DO 可休眠，消息到达自动唤醒
export class PushHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 客户端连接升级（由 Worker 完成鉴权后转发过来）
    if (url.pathname === '/connect') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket upgrade', { status: 400 });
      }
      const pair = new WebSocketPair();
      // 服务端使用 hibernatable socket
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Worker 内部调用：把一条新通知广播给该用户全部在线连接
    if (url.pathname === '/notify' && request.method === 'POST') {
      const msg = await request.text();
      let delivered = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(msg);
          delivered++;
        } catch {
          // 单个连接发送失败不影响其他连接
        }
      }
      return new Response(JSON.stringify({ ok: true, delivered }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  // 客户端 ping 保活
  async webSocketMessage(ws, message) {
    if (message === 'ping') {
      try { ws.send('pong'); } catch { /* ignore */ }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch { /* ignore */ }
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch { /* ignore */ }
  }
}
