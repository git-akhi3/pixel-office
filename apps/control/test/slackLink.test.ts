import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FIRST_RETRY_MS, MAX_RETRY_MS, SlackLink, untilConnected } from '../server/src/slackLink.js';

/** A socket-mode client stand-in: start() succeeds (emitting connected) or fails, as scripted. */
class FakeSocket extends EventEmitter {
  starts = 0;
  outcomes: Array<'ok' | 'fail' | 'hang'> = [];
  private pending: Array<() => void> = [];
  async start(): Promise<void> {
    this.starts++;
    const outcome = this.outcomes.shift() ?? 'ok';
    if (outcome === 'fail') throw new Error('fetch failed');
    if (outcome === 'hang') return new Promise((resolve) => this.pending.push(() => (this.emit('connected'), resolve())));
    this.emit('connected');
  }
  finishHanging(): void {
    this.pending.shift()?.();
  }
}

/** Timers you fire by hand, in order. */
function manualTimers() {
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let next = 0;
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, id: next++ };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id: unknown) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    async fire() {
      const t = timers.shift();
      t?.fn();
      await new Promise((r) => setImmediate(r));
      return t?.ms;
    },
  };
}

function setup() {
  const socket = new FakeSocket();
  const clock = manualTimers();
  const logs: string[] = [];
  const link = new SlackLink(socket, { setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: (m) => logs.push(m) });
  socket.emit('connected'); // the office's own first start
  link.arm();
  return { socket, clock, logs, link };
}

describe('SlackLink', () => {
  it('reconnects after a drop', async () => {
    const { socket, clock, link } = setup();
    socket.emit('disconnected');
    expect(link.connected).toBe(false);
    expect(clock.timers.map((t) => t.ms)).toEqual([FIRST_RETRY_MS]);
    await clock.fire();
    expect(socket.starts).toBe(1);
    expect(link.connected).toBe(true);
    expect(clock.timers).toEqual([]);
  });

  it('keeps trying through a long outage, waiting longer each time, and never gives up', async () => {
    const { socket, clock, logs, link } = setup();
    socket.outcomes = Array(8).fill('fail');
    socket.emit('disconnected');
    const waits: Array<number | undefined> = [];
    for (let i = 0; i < 9; i++) waits.push(await clock.fire());
    const doubling = [1, 2, 4, 8, 16, 32, 64].map((n) => n * FIRST_RETRY_MS);
    expect(waits).toEqual([...doubling, MAX_RETRY_MS, MAX_RETRY_MS]);
    expect(link.connected).toBe(true);
    expect(socket.starts).toBe(9);
    // A long outage logs a few lines, not one per attempt.
    expect(logs.filter((l) => l.includes('still offline')).length).toBeLessThan(8);
    expect(logs.at(-1)).toMatch(/connected again/);
  });

  it('never runs two connects at once, so the office never holds two sockets', async () => {
    const { socket, clock } = setup();
    socket.outcomes = ['hang'];
    socket.emit('disconnected');
    await clock.fire(); // the first attempt is still connecting…
    socket.emit('disconnected'); // …and the old socket reports closing again
    expect(clock.timers).toEqual([]);
    socket.finishHanging();
    await new Promise((r) => setImmediate(r));
    expect(socket.starts).toBe(1);
  });

  it('starts over at a short wait after a successful reconnect', async () => {
    const { socket, clock } = setup();
    socket.outcomes = ['fail', 'fail'];
    socket.emit('disconnected');
    await clock.fire();
    await clock.fire();
    await clock.fire(); // connected
    socket.emit('disconnected');
    expect(clock.timers.map((t) => t.ms)).toEqual([FIRST_RETRY_MS]);
  });

  it('does nothing before it is armed, then picks up a drop that happened meanwhile', async () => {
    const socket = new FakeSocket();
    const clock = manualTimers();
    const link = new SlackLink(socket, { setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {} });
    socket.emit('connected');
    socket.emit('disconnected'); // during startup: the caller is still in charge
    expect(clock.timers).toEqual([]);
    link.arm();
    expect(clock.timers.map((t) => t.ms)).toEqual([FIRST_RETRY_MS]);
    await clock.fire();
    expect(link.connected).toBe(true);
  });

  it('stops retrying once the office shuts down', async () => {
    const { socket, clock, link } = setup();
    socket.emit('disconnected');
    link.stop();
    expect(clock.timers).toEqual([]);
    socket.emit('disconnected');
    expect(clock.timers).toEqual([]);
    expect(socket.starts).toBe(0);
  });
});

describe('untilConnected', () => {
  it('retries the first connection until the network is up', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await untilConnected(
      async () => {
        if (++calls < 4) throw new Error('getaddrinfo ENOTFOUND slack.com');
        return 'connected';
      },
      { sleep: async (ms) => void waits.push(ms), log: () => {} },
    );
    expect(result).toBe('connected');
    expect(waits).toEqual([FIRST_RETRY_MS, 2 * FIRST_RETRY_MS, 4 * FIRST_RETRY_MS]);
  });

  it("gives up at once on settings that retrying won't fix", async () => {
    const logs: string[] = [];
    let calls = 0;
    const result = await untilConnected(
      async () => {
        calls++;
        throw new Error('An API error occurred: invalid_auth');
      },
      { sleep: async () => {}, fatal: (e) => String(e).includes('invalid_auth'), log: (m) => logs.push(m) },
    );
    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(logs).toEqual(['Slack is off: An API error occurred: invalid_auth']);
  });

  it('gives up when the office is shutting down', async () => {
    let stop = false;
    const result = await untilConnected(
      async () => {
        stop = true;
        throw new Error('offline');
      },
      { sleep: async () => {}, stopped: () => stop, log: () => {} },
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------- with the real socket-mode client

describe('SlackLink with the real socket-mode client', () => {
  /** A free local port: nothing listens on it until fakeSlack(port) starts. */
  async function freePort(): Promise<number> {
    const { createServer } = await import('node:net');
    const probe = createServer();
    const port = await new Promise<number>((resolve) => probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port)));
    await new Promise((r) => probe.close(r));
    return port;
  }

  /** A stand-in Slack on `port`: apps.connections.open over HTTP, then a socket that says hello. */
  async function fakeSlack(port: number) {
    const { createServer } = await import('node:http');
    const { WebSocketServer } = await import('ws');
    const sockets: import('ws').WebSocket[] = [];
    let connections = 0;
    const http = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/socket` }));
    });
    const wss = new WebSocketServer({ server: http });
    wss.on('connection', (ws) => {
      sockets.push(ws);
      connections++;
      ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
    });
    await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', () => resolve()));
    return {
      open: () => sockets.filter((s) => s.readyState === s.OPEN).length,
      connections: () => connections,
      dropAll: () => sockets.forEach((s) => s.terminate()),
      sendAll: (text: string) => sockets.filter((s) => s.readyState === s.OPEN).forEach((s) => s.send(text)),
      close: () => new Promise<void>((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(), http.close(() => r()))),
    };
  }

  const waitFor = async (check: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('reconnects after Slack drops the socket, and after the network was down at first', async () => {
    const { SocketModeClient, LogLevel } = await import('@slack/socket-mode');
    const port = await freePort();
    const client = new SocketModeClient({
      appToken: 'xapp-test',
      autoReconnectEnabled: false,
      logLevel: LogLevel.ERROR,
      clientOptions: { slackApiUrl: `http://127.0.0.1:${port}/api/`, retryConfig: { retries: 0 } },
    });
    // First, "no network": nothing answers, so the first start fails outright.
    await expect(client.start()).rejects.toThrow();

    // The link takes over (fast retries for the test) and connects once "the network is back".
    const link = new SlackLink(client, { log: () => {}, setTimer: (fn) => setTimeout(fn, 10) });
    link.arm();
    await new Promise((r) => setTimeout(r, 50)); // a few failed attempts
    expect(link.connected).toBe(false);
    const slack = await fakeSlack(port);
    await waitFor(() => link.connected);
    expect(slack.open()).toBe(1);

    // Slack closes the socket (it does every few hours, or the Wi-Fi drops): the link reconnects, with one socket.
    slack.dropAll();
    await waitFor(() => slack.connections() === 2 && link.connected);
    expect(slack.open()).toBe(1);

    // Slack's own "disconnect" message (it recycles sockets every few hours): the same, about a second later.
    await waitFor(() => slack.open() === 1);
    slack.sendAll(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }));
    await waitFor(() => slack.connections() === 3 && link.connected);
    expect(slack.open()).toBe(1);

    link.stop();
    await client.disconnect();
    await slack.close();
  });
});
