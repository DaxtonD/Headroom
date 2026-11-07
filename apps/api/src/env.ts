/**
 * Configuration comes only from environment variables, and is validated here
 * before anything else starts (HANDOFF section 11).
 *
 * The server refuses to boot when a required variable is missing, malformed,
 * or still carrying a `change-me` placeholder from `.env.example`. Failing at
 * startup is the point: a half-configured app that handles money is worse than
 * one that will not start.
 *
 * Every variable added here must be added to `.env.example` with a comment in
 * the same commit (CLAUDE.md).
 */
import { z } from "zod";

/** Values copied from `.env.example` and never filled in. */
const PLACEHOLDER = /change-me/i;

const notPlaceholder = (label: string) =>
  z.string().refine((value) => !PLACEHOLDER.test(value), {
    message: `${label} is still set to a "change-me" placeholder. Fill it in in .env.`,
  });

/** `true`/`false`/`1`/`0`/`yes`/`no`, case-insensitive. */
const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === "") return defaultValue;
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
      throw new Error(`expected a boolean, received "${value}"`);
    });

const intInRange = (min: number, max: number, defaultValue?: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === "") {
        if (defaultValue === undefined) {
          ctx.addIssue({ code: "custom", message: "is required" });
          return z.NEVER;
        }
        return defaultValue;
      }
      if (!/^\d+$/.test(value.trim())) {
        ctx.addIssue({ code: "custom", message: `expected a whole number, received "${value}"` });
        return z.NEVER;
      }
      const parsed = Number.parseInt(value.trim(), 10);
      if (parsed < min || parsed > max) {
        ctx.addIssue({ code: "custom", message: `must be between ${min} and ${max}, received ${parsed}` });
        return z.NEVER;
      }
      return parsed;
    });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),

  /**
   * The exact address the app is opened at. Cookies, CORS and the PWA all
   * depend on it, so it must be the real origin, not a guess.
   */
  APP_ORIGIN: notPlaceholder("APP_ORIGIN").pipe(
    z.string().refine(
      (value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
        } catch {
          return false;
        }
      },
      {
        message:
          "must be a full URL, and HTTPS unless it is localhost (service workers and install prompts require HTTPS).",
      },
    ),
  ),

  /** Port inside the container. The host mapping lives in docker-compose.yml. */
  PORT: intInRange(1, 65535, 3000),
  /** Inside a container the app must listen on all interfaces. */
  HOST: z.string().default("0.0.0.0"),

  /** Saskatchewan time, which has no daylight saving. */
  TZ: z.string().default("America/Regina"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: notPlaceholder("DATABASE_URL").pipe(
    z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: "must be a postgresql:// connection string.",
    }),
  ),
  /** Only needed for `prisma migrate dev` on a restricted database user. */
  SHADOW_DATABASE_URL: z.string().optional(),

  /** 64 hex chars: `openssl rand -hex 32`. Signs the session cookie. */
  SESSION_SECRET: notPlaceholder("SESSION_SECRET").pipe(
    z.string().min(32, "must be at least 32 characters; generate with: openssl rand -hex 32"),
  ),
  /** Long-lived, because Carol opens the app many times a day. */
  SESSION_TTL_DAYS: intInRange(1, 400, 90),
  /** Must stay true in production: the cookie may only travel over HTTPS. */
  COOKIE_SECURE: boolish(true),
  LOGIN_RATE_LIMIT: intInRange(1, 1000, 10),

  IDEMPOTENCY_KEY_TTL_HOURS: intInRange(1, 24 * 90, 48),
  SSE_HEARTBEAT_SECONDS: intInRange(1, 600, 25),

  /** Optional Web Push (M5). Either all three are set, or none are. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  /**
   * Where the built web app lives. The single app image serves it from the
   * API, so this is set in the Dockerfile; in development Vite serves it.
   */
  WEB_DIST_DIR: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      [
        "Headroom cannot start: the environment is not configured.",
        "",
        ...problems.map((problem) => `  - ${problem}`),
        "",
        "Copy .env.example to .env and fill in the marked values.",
      ].join("\n"),
    );
    this.name = "EnvValidationError";
  }
}

/**
 * Validate an environment. Pure, so tests can check the rules without
 * touching `process.env`.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(problems);
  }

  const env = result.data;
  const extraProblems: string[] = [];

  // A Secure cookie over plain http never reaches the browser, so the app
  // would look broken rather than insecure. Catch it at startup instead.
  if (env.COOKIE_SECURE && env.APP_ORIGIN.startsWith("http://")) {
    extraProblems.push(
      "COOKIE_SECURE is true but APP_ORIGIN is http://. A Secure cookie is never sent over plain HTTP. Use HTTPS, or set COOKIE_SECURE=false for local development only.",
    );
  }
  if (!env.COOKIE_SECURE && env.NODE_ENV === "production") {
    extraProblems.push(
      "COOKIE_SECURE must stay true when NODE_ENV=production: the session cookie would otherwise travel in the clear.",
    );
  }

  const vapid = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter(
    (value) => value !== undefined && value.trim() !== "",
  );
  if (vapid.length > 0 && vapid.length < 3) {
    extraProblems.push(
      "Web Push needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together, or none of them. Generate with: npx web-push generate-vapid-keys",
    );
  }

  if (extraProblems.length > 0) throw new EnvValidationError(extraProblems);

  return env;
}

let cached: Env | undefined;

/** The validated environment, parsed once per process. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test helper: forget the cached environment. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** True when Web Push is fully configured. */
export function hasWebPush(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}
