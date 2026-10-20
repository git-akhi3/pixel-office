// Keeps the office's Slack connection up through Wi-Fi drops, the Mac waking from sleep, and a start
// before the network is up.
//
// Slack reaches the office over one socket (Socket Mode). The socket-mode client's own reconnect gives
// up for good when a reconnect attempt hits a network error (it counts that as unrecoverable), so the
// office turns that off and owns reconnecting: whenever the socket is down it starts it again, waiting
// a second, then twice as long each time up to 2 minutes, until Slack says hello. Slack also closes the
// socket every few hours on purpose; the short first wait makes that gap barely noticeable. Only one
// attempt runs at a time, so the office never holds two sockets (an old one's handlers would still
// pick up events).

/** The slice of @slack/socket-mode's client the link uses. */
export interface SlackSocket {
  on(event: 'connected' | 'disconnected', listener: () => void): unknown;
  start(): Promise<unknown>;
}

export interface SlackLinkOptions {
  log?: (message: string) => void;
  /** Injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 120_000;

export class SlackLink {
  private up = false;
  private armed = false;
  private stopped = false;
  private connecting = false;
  private failures = 0;
  private timer: unknown = null;
  private downSince: number | null = null;

  constructor(
    private socket: SlackSocket,
    private opts: SlackLinkOptions = {},
  ) {
    socket.on('connected', () => {
      if (this.downSince !== null) this.log(`Slack: connected again after ${Math.round((Date.now() - this.downSince) / 1000)}s.`);
      this.up = true;
      this.failures = 0;
      this.downSince = null;
    });
    socket.on('disconnected', () => {
      this.up = false;
      this.downSince ??= Date.now();
      this.retryLater();
    });
  }

  /** Whether the socket is connected right now. */
  get connected(): boolean {
    return this.up;
  }

  /**
   * Starts reconnecting when the socket is down. Until then the link only follows the socket's state:
   * call this once the caller's own first start has succeeded, because reconnecting while the caller
   * is still trying would open a second socket. A drop that happened in between is picked up now.
   */
  arm(): void {
    this.armed = true;
    if (!this.up) this.retryLater();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.timer);
    this.timer = null;
  }

  private log(message: string): void {
    (this.opts.log ?? console.warn)(message);
  }

  private retryLater(): void {
    if (!this.armed || this.stopped || this.connecting || this.timer !== null) return;
    const ms = Math.min(FIRST_RETRY_MS * 2 ** this.failures, MAX_RETRY_MS);
    this.timer = (this.opts.setTimer ?? setTimeout)(() => {
      this.timer = null;
      void this.reconnect();
    }, ms);
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.up || this.connecting) return;
    this.connecting = true;
    try {
      await this.socket.start();
    } catch (e) {
      this.failures++;
      // Every attempt while it's brief, then every fifth, so a long outage doesn't flood the log.
      if (this.failures <= 3 || this.failures % 5 === 0) this.log(`Slack: still offline (attempt ${this.failures}): ${(e as Error).message}`);
    } finally {
      this.connecting = false;
    }
    if (!this.up) this.retryLater();
  }
}

/**
 * Runs `connect` until it succeeds, waiting longer after each failure (1 s, doubling up to 2 min). For the
 * office's first Slack connection, which fails when the office starts before the network is up.
 * Resolves with connect's result, or null once `stopped()` says to give up or `fatal(e)` calls an error
 * one that retrying won't fix. Never rejects.
 */
export async function untilConnected<T>(
  connect: () => Promise<T>,
  opts: { log?: (message: string) => void; sleep?: (ms: number) => Promise<void>; stopped?: () => boolean; fatal?: (e: unknown) => boolean } = {},
): Promise<T | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let failures = 0; ; failures++) {
    if (opts.stopped?.()) return null;
    try {
      return await connect();
    } catch (e) {
      // A wrong token or ID won't fix itself: say so once instead of retrying forever.
      if (opts.fatal?.(e)) {
        (opts.log ?? console.warn)(`Slack is off: ${(e as Error).message}`);
        return null;
      }
      if (failures < 3 || failures % 5 === 4) (opts.log ?? console.warn)(`Slack: can't connect yet (attempt ${failures + 1}): ${(e as Error).message}`);
      await sleep(Math.min(FIRST_RETRY_MS * 2 ** failures, MAX_RETRY_MS));
    }
  }
}
