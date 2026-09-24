// Server-Sent Events hub for the dashboard (/api/stream).
export class SseHub {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => this.comment('ping'), 25000);
    this.heartbeat.unref?.();
  }

  /** Attach an HTTP response as an SSE client. `initial` = [[event, data], ...] sent right away. */
  add(req, res, initial = []) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('error', drop);
    for (const [event, data] of initial) this.sendTo(res, event, data);
  }

  sendTo(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }

  broadcast(event, data) {
    if (!this.clients.size) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(msg);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  comment(text) {
    for (const res of this.clients) {
      try {
        res.write(`: ${text}\n\n`);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
