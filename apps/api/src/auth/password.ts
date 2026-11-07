/**
 * Password hashing with Argon2id (HANDOFF section 10).
 *
 * Two people, one household, long-lived sessions: logins are rare, so the
 * parameters favour cost over speed. These are the OWASP-recommended Argon2id
 * settings (m=19 MiB, t=2, p=1), which take roughly 50 ms on this class of
 * hardware.
 */
import { hash, verify } from "@node-rs/argon2";

/**
 * `Algorithm.Argon2id` from `@node-rs/argon2` is an ambient `const enum`,
 * which `isolatedModules` forbids importing as a value, so the numeric value
 * is spelled out. It is also the library default; stating it keeps the choice
 * visible and verifiable (see the test asserting the `$argon2id$` prefix).
 */
const ARGON2ID = 2;

const HASH_OPTIONS = {
  algorithm: ARGON2ID,
  /** 19 MiB of memory per hash. */
  memoryCost: 19_456,
  /** Two passes over that memory. */
  timeCost: 2,
  parallelism: 1,
} as const;

/** The shortest password we will store. Deliberately a floor, not a policy. */
export const MIN_PASSWORD_LENGTH = 12;

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeakPasswordError";
  }
}

/** Reject passwords that are too short to be worth hashing. */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters. A passphrase of a few words is easier to type on a phone and harder to guess.`,
    );
  }
}

/** Hash a password for storage. Returns a PHC string carrying its own salt. */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  return hash(password, HASH_OPTIONS);
}

/**
 * Check a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed or truncated hash, so a
 * corrupted row reads as a failed login instead of a 500 that tells an
 * attacker something.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
