// PushHub Durable Object：按用户维度的 WebSocket 推送枢纽
// - 每个 userId 一个 DO 实例（idFromName(userId)）
// - 客户端经 Worker 鉴权后转发 /connect 升级为 WebSocket
// - webhook 收到新消息后 Worker 调 /notify，DO 广播给该用户所有在线连接
// - 触达重推：广播后 0.3 秒内未收到 /delivered 回调则重推，最多 MAX_ATTEMPTS 次；
//   重推任务持久化在 ctx.storage，DO 休眠也会由 alarm 按时唤醒
// 使用 Hibernation API：连接空闲时不计费、DO 可休眠，消息到达自动唤醒

const MAX_ATTEMPTS = 5;      // 首推 + 重推 4 次，共 5 次
const RETRY_DELAY_MS = 300;  // 每次未收到触达回调后的重推间隔（0.3 秒）

export class PushHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async broadcast(msg) {
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
        delivered++;
      } catch {
        // 单个连接发送失败不影响其他连接
      }
    }
    return delivered;
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

    // Worker 内部调用：广播新通知并登记待触达任务（0.3 秒后 alarm 检查回调）
    if (url.pathname === '/notify' && request.method === 'POST') {
      const msg = await request.text();
      const delivered = await this.broadcast(msg);
      let id = null;
      try { id = JSON.parse(msg).id ?? null; } catch { /* ignore */ }
      if (id != null) {
        await this.ctx.storage.put(`p:${id}`, { id, msg, attempts: 0, at: Date.now() });
        await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
      }
      return new Response(JSON.stringify({ ok: true, delivered }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Worker 内部调用：App 已触达回调，取消该消息的重推
    if (url.pathname === '/delivered' && request.method === 'POST') {
      try {
        const { id } = await request.json();
        if (id != null) await this.ctx.storage.delete(`p:${id}`);
      } catch { /* ignore */ }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  // 重推：0.3 秒一次，直到收到触达回调（D1 delivered_at 已写）或超过次数上限
  async alarm() {
    const pending = await this.ctx.storage.list({ prefix: 'p:' });
    if (!pending.size) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    for (const [key, val] of pending) {
      // 权威状态在 D1：已触达就不再重推（防 /delivered 通知与 alarm 竞态）
      const row = await this.env.DB.prepare('SELECT delivered_at FROM notifications WHERE id=?')
        .bind(val.id).first();
      if (row && row.delivered_at) {
        await this.ctx.storage.delete(key);
        continue;
      }
      if (val.attempts + 1 >= MAX_ATTEMPTS) {
        await this.ctx.storage.delete(key); // 放弃：历史里保持“未触达”，等 App 上线拉取
        continue;
      }
      await this.broadcast(val.msg);
      val.attempts += 1;
      await this.ctx.storage.put(key, val);
    }
    const left = await this.ctx.storage.list({ prefix: 'p:' });
    if (left.size) await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
    else await this.ctx.storage.deleteAlarm();
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
