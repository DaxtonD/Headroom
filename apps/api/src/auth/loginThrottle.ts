/**
 * Login throttling.
 *
 * `.env.example` documents LOGIN_RATE_LIMIT as "failed login attempts allowed
 * per IP per 15 minutes", and this counts exactly that: only failures, and a
 * success clears the record.
 *
 * That distinction matters for a household app. A plain request limiter would
 * also count successful sign-ins, so Carol adding the app to a second phone,
 * or signing in on a flaky connection, could lock herself out of her own
 * finances. Counting only failures still stops password guessing, which is the
 * thing worth stopping.
 *
 * State is in memory, which is right for a single-container deployment: a
 * restart forgets the counts, and an attacker cannot force a restart.
 */

export interface LoginThrottleOptions {
  /** How many failures are allowed in the window. */
  readonly maxFailures: number;
  readonly windowMs?: number;
  /** Injectable for tests; defaults to the real clock. */
  readonly now?: () => number;
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: LoginThrottleOptions) {
    if (!Number.isInteger(options.maxFailures) || options.maxFailures < 1) {
      throw new RangeError(
        `maxFailures must be at least 1; received ${String(options.maxFailures)}.`,
      );
    }
    this.maxFailures = options.maxFailures;
    this.windowMs = options.windowMs ?? FIFTEEN_MINUTES_MS;
    this.now = options.now ?? Date.now;
  }

  /** Drop failures that have aged out of the window. */
  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((at) => at > cutoff);

    if (kept.length === 0) {
      this.failures.delete(key);
    } else {
      this.failures.set(key, kept);
    }
    return kept;
  }

  /** True when this address has used up its attempts. */
  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
  }

  /** How many seconds until the oldest failure ages out. */
  retryAfterSeconds(key: string): number {
    const recent = this.recent(key);
    const oldest = recent[0];
    if (oldest === undefined) return 0;
    const remainingMs = oldest + this.windowMs - this.now();
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }

  /** Record a failed attempt. */
  recordFailure(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.failures.set(key, recent);
  }

  /** A correct password clears the record: this was not an attacker. */
  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  /** Test helper, and a way to let Dax clear a lockout if it ever bites. */
  reset(): void {
    this.failures.clear();
  }

  /** Remove aged-out entries entirely, so the map cannot grow without bound. */
  prune(): void {
    for (const key of [...this.failures.keys()]) this.recent(key);
  }
}
