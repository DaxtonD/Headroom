/**
 * Request parsing for the integrity layer (HANDOFF section 16).
 *
 * Every mutating request must carry two headers, and the rules are enforced
 * here rather than in each route, so no route can forget one:
 *
 *  - `If-Match: "<version>"` - the row version the user was looking at. Its
 *    absence is a 428, not a silent overwrite.
 *  - `Idempotency-Key: <uuid>` - created when the user taps Save and reused on
 *    every retry, so a double tap cannot clear a bill twice.
 */
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** 428 Precondition Required: the client did not say which version it saw. */
export class VersionRequiredError extends HttpError {
  constructor() {
    super(
      428,
      "version_required",
      'This change must say which version it was based on. Send If-Match: "<version>", or baseVersion in the body.',
    );
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The version the client based its change on.
 *
 * Accepts `If-Match: "7"`, `If-Match: 7` and `W/"7"`, and falls back to
 * `baseVersion` in the body, which the brief allows. Throws 428 when neither
 * is present, because applying a change blind is how someone's edit gets
 * silently overwritten.
 */
export function requireBaseVersion(request: FastifyRequest): number {
  const header = request.headers["if-match"];
  const raw = Array.isArray(header) ? header[0] : header;

  if (raw !== undefined && raw !== "") {
    // `If-Match: *` means "any version", which is exactly the blind overwrite
    // this design exists to prevent.
    if (raw.trim() === "*") {
      throw new HttpError(
        428,
        "version_required",
        'If-Match: * is not accepted here. Send the version you were looking at, so nobody\'s change is overwritten unseen.',
      );
    }

    const cleaned = raw.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
    if (!/^\d+$/.test(cleaned)) {
      throw new HttpError(400, "invalid_version", `If-Match must be a whole number; received ${raw}.`);
    }
    const parsed = Number.parseInt(cleaned, 10);
    if (parsed < 1) {
      throw new HttpError(400, "invalid_version", "A row version is always 1 or more.");
    }
    return parsed;
  }

  const body = request.body as { baseVersion?: unknown } | undefined;
  const fromBody = body?.baseVersion;
  if (typeof fromBody === "number" && Number.isInteger(fromBody) && fromBody >= 1) {
    return fromBody;
  }

  throw new VersionRequiredError();
}

/**
 * The idempotency key for this request.
 *
 * Required on every mutation: it is what makes a retry on a flaky phone
 * connection safe (section 16.1 rule 7).
 */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const raw = Array.isArray(header) ? header[0] : header;

  if (raw === undefined || raw.trim() === "") {
    throw new HttpError(
      400,
      "idempotency_key_required",
      "This change must carry an Idempotency-Key header, so retrying it cannot apply it twice.",
    );
  }

  const key = raw.trim();
  if (!UUID_PATTERN.test(key)) {
    throw new HttpError(400, "idempotency_key_invalid", "Idempotency-Key must be a UUID.");
  }

  return key.toLowerCase();
}

/**
 * A stable fingerprint of what this request asked for.
 *
 * Used to tell a genuine retry (same key, same body -> replay the stored
 * response) from a mistake (same key, different body -> 422). Object keys are
 * sorted so that a client reordering its JSON does not look like a new
 * request.
 */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`)
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `baseVersion` is routing information, not part of what the user asked
    // for, so a retry against a newer version is still the same intent.
    .filter(([key, item]) => item !== undefined && key !== "baseVersion")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
