/**
 * Live updates (HANDOFF section 16.2).
 *
 * After each commit the API sends a Postgres `NOTIFY`, and this relays it to
 * every open client over Server-Sent Events. Clients then invalidate the
 * matching query and refetch. So when Carol verifies a bill on her phone,
 * Dax's phone updates without him doing anything.
 *
 * Two deliberate choices:
 *
 *  - The ping carries only `{entity, id, version, by}` - never an amount.
 *    Clients refetch through the authenticated API, so no financial figure
 *    travels in a notification payload, and the server stays the only source
 *    of truth (section 16.1 rule 1).
 *  - `pg_notify` is called inside the writing transaction, so Postgres
 *    delivers it only if that transaction commits. A rolled-back change can
 *    never announce itself.
 */
import type pg from "pg";
import type { Prisma } from "../generated/prisma/client.js";
import { createListener } from "../db.js";
import type { Env } from "../env.js";

export const CHANGE_CHANNEL = "headroom_changed";

export interface ChangePing {
  readonly householdId: string;
  readonly entity: string;
  readonly id: string;
  readonly version: number;
  /** Who made the change, so a client can skip echoing its own edit. */
  readonly by: string;
}

/**
 * Announce a change from inside the transaction that made it.
 *
 * `pg_notify` is transactional: the payload is queued and only delivered on
 * commit, which is exactly the behaviour wanted here.
 */
export async function publishChange(tx: Prisma.TransactionClient, ping: ChangePing): Promise<void> {
  // Postgres caps a notification payload at 8000 bytes; this is tiny.
  await tx.$executeRaw`SELECT pg_notify(${CHANGE_CHANNEL}, ${JSON.stringify(ping)})`;
}

export interface ChangeStreamLogger {
  info: (object: unknown, message?: string) => void;
  warn: (object: unknown, message?: string) => void;
  error: (object: unknown, message?: string) => void;
}

/** Used until a real logger is attached, and by tests that never start it. */
const SILENT_LOGGER: ChangeStreamLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type Subscriber = (ping: ChangePing) => void;

/**
 * Owns the single `LISTEN` connection and fans notifications out to the
 * connected clients.
 *
 * One connection for the whole process, not one per client: a listening
 * connection is pinned for the life of the subscription, and two people with
 * a few tabs each should not hold a pool's worth of them.
 */
export class ChangeStream {
  private client: pg.Client | undefined;
  private readonly subscribers = new Map<string, { householdId: string; send: Subscriber }>();
  private nextId = 1;
  private reconnectDelayMs = 1_000;
  private stopped = false;

  private log: ChangeStreamLogger = SILENT_LOGGER;

  constructor(
    private readonly env: Env,
    log?: ChangeStreamLogger,
  ) {
    if (log) this.log = log;
  }

  /**
   * Attach a logger after construction.
   *
   * The app needs the stream at build time, but Fastify's logger only exists
   * once the app is built, so the server creates the stream first and hands
   * the logger over here.
   */
  setLogger(log: ChangeStreamLogger): void {
    this.log = log;
  }

  async start(): Promise<void> {
    if (this.stopped) return;

    try {
      const client = await createListener(this.env);
      this.client = client;
      this.reconnectDelayMs = 1_000;

      client.on("notification", (message) => {
        if (message.channel !== CHANGE_CHANNEL || !message.payload) return;
        try {
          this.fanOut(JSON.parse(message.payload) as ChangePing);
        } catch (error) {
          this.log.warn({ err: error }, "could not read a change notification");
        }
      });

      client.on("error", (error) => {
        this.log.error({ err: error }, "change listener connection failed");
        void this.reconnect();
      });

      client.on("end", () => {
        if (!this.stopped) void this.reconnect();
      });

      await client.query(`LISTEN ${CHANGE_CHANNEL}`);
      this.log.info({ channel: CHANGE_CHANNEL }, "listening for changes");
    } catch (error) {
      this.log.error({ err: error }, "could not start the change listener");
      void this.reconnect();
    }
  }

  /** Reconnect with backoff; live updates are a convenience, not a guarantee. */
  private async reconnect(): Promise<void> {
    if (this.stopped) return;

    const client = this.client;
    this.client = undefined;
    if (client) {
      // The connection is already broken; closing it is best-effort.
      await client.end().catch(() => undefined);
    }

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, 30_000);
    this.log.warn({ delayMs: delay }, "reconnecting the change listener");

    await new Promise((resolve) => setTimeout(resolve, delay));
    await this.start();
  }

  private fanOut(ping: ChangePing): void {
    for (const subscriber of this.subscribers.values()) {
      // A household only ever hears about its own data.
      if (subscriber.householdId !== ping.householdId) continue;
      try {
        subscriber.send(ping);
      } catch (error) {
        this.log.warn({ err: error }, "could not deliver a change to a client");
      }
    }
  }

  /** Register a client. Returns the function that unregisters it. */
  subscribe(householdId: string, send: Subscriber): () => void {
    const id = String(this.nextId);
    this.nextId += 1;
    this.subscribers.set(id, { householdId, send });
    return () => {
      this.subscribers.delete(id);
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.subscribers.clear();
    const client = this.client;
    this.client = undefined;
    if (client) await client.end().catch(() => undefined);
  }
}
