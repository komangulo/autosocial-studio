class StudioEventHub {
  constructor() {
    this.clients = new Set();
  }

  publish(event) {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (!client.accountId || client.accountId === event.accountId) client.response.write(frame);
    }
  }

  subscribe(accountId, response) {
    const client = { accountId, response };
    this.clients.add(client);
    response.write(`event: ready\ndata: ${JSON.stringify({ type: "ready" })}\n\n`);
    const timer = setInterval(() => response.write(": keepalive\n\n"), 25000);
    return () => {
      clearInterval(timer);
      this.clients.delete(client);
    };
  }
}

module.exports = { StudioEventHub };
