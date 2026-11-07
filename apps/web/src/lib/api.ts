/**
 * The HTTP client.
 *
 * Writes always carry the two headers the integrity layer depends on
 * (HANDOFF section 16): `If-Match` with the version the user was looking at,
 * and `Idempotency-Key` generated when they tap Save and reused on retries.
 * They are built into this layer so no call site can forget them.
 */

export interface ApiErrorBody {
  readonly error: string;
  readonly message: string;
  readonly requestId?: string;
}

/** A request that failed. `status` carries the meaning: 401, 409, 428, 422. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Someone else changed the same field first (section 16.3). */
  get isConflict(): boolean {
    return this.status === 409;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** A write was sent without `If-Match`, which the server refuses. */
  get isVersionMissing(): boolean {
    return this.status === 428;
  }
}

/** Thrown when the request never reached the server. */
export class OfflineError extends Error {
  constructor() {
    super("No connection. Headroom shows the last numbers it has, and saving is paused.");
    this.name = "OfflineError";
  }
}

export interface RequestOptions {
  /** The row version the user was looking at. Required for every write. */
  readonly baseVersion?: number;
  /**
   * Reused across retries of the same user action, so a double tap or a flaky
   * connection cannot apply a change twice.
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/** A fresh key for one user action. Reuse it for every retry of that action. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers({ accept: "application/json" });

  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const isWrite = method !== "GET" && method !== "HEAD";
  if (isWrite) {
    headers.set("idempotency-key", options.idempotencyKey ?? newIdempotencyKey());
    if (options.baseVersion !== undefined) {
      headers.set("if-match", `"${options.baseVersion}"`);
    }
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      // The session cookie is httpOnly, so it must ride along explicitly.
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal ?? null,
    });
  } catch (cause) {
    // fetch only rejects for network-level failures, which is exactly the
    // offline case the UI needs to distinguish.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new OfflineError();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const errorBody = parsed as ApiErrorBody | undefined;
    throw new ApiError(
      response.status,
      errorBody?.error ?? `http_${response.status}`,
      errorBody?.message ?? `The server returned ${response.status}.`,
      parsed,
    );
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>("GET", path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>("POST", path, body, options),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>("PATCH", path, body, options),
  put: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>("PUT", path, body, options),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>("DELETE", path, undefined, options),
};
