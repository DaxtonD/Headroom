/**
 * Configuration validation.
 *
 * The point of these tests is the refusal, not the happy path: Headroom must
 * not start half-configured, because a money app that boots with a placeholder
 * secret is worse than one that will not boot (HANDOFF section 11).
 */
import { describe, expect, it } from "vitest";
import { EnvValidationError, hasWebPush, parseEnv } from "../src/env.js";

/** The minimum that should start, with values shaped like the real ones. */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    APP_ORIGIN: "https://headroom.example.ts.net",
    DATABASE_URL: "postgresql://headroom:secret@db:5432/headroom?schema=public",
    SESSION_SECRET: "a".repeat(64),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("parseEnv", () => {
  it("accepts a complete configuration and applies the documented defaults", () => {
    const env = parseEnv(validEnv());

    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.TZ).toBe("America/Regina");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.SESSION_TTL_DAYS).toBe(90);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.LOGIN_RATE_LIMIT).toBe(10);
    expect(env.IDEMPOTENCY_KEY_TTL_HOURS).toBe(48);
    expect(env.SSE_HEARTBEAT_SECONDS).toBe(25);
  });

  it("refuses to start when a required variable is missing", () => {
    for (const key of ["APP_ORIGIN", "DATABASE_URL", "SESSION_SECRET"]) {
      const env = validEnv({ [key]: undefined });
      expect(() => parseEnv(env), key).toThrow(EnvValidationError);
    }
  });

  it("refuses a value still left as a change-me placeholder", () => {
    expect(() => parseEnv(validEnv({ SESSION_SECRET: "change-me" }))).toThrow(/change-me/i);
    expect(() =>
      parseEnv(validEnv({ DATABASE_URL: "postgresql://headroom:change-me@db:5432/headroom" })),
    ).toThrow(/change-me/i);
    expect(() => parseEnv(validEnv({ APP_ORIGIN: "https://change-me.example" }))).toThrow(
      /change-me/i,
    );
  });

  it("refuses a session secret too short to be worth signing with", () => {
    expect(() => parseEnv(validEnv({ SESSION_SECRET: "tooshort" }))).toThrow(EnvValidationError);
    expect(() => parseEnv(validEnv({ SESSION_SECRET: "a".repeat(32) }))).not.toThrow();
  });

  it("requires a postgresql connection string", () => {
    expect(() => parseEnv(validEnv({ DATABASE_URL: "mysql://localhost/headroom" }))).toThrow(
      /postgresql/,
    );
    expect(() => parseEnv(validEnv({ DATABASE_URL: "not a url" }))).toThrow(EnvValidationError);
  });

  it("requires HTTPS for a public origin, because the PWA and cookies depend on it", () => {
    expect(() => parseEnv(validEnv({ APP_ORIGIN: "http://headroom.example.com" }))).toThrow(
      EnvValidationError,
    );
    expect(() => parseEnv(validEnv({ APP_ORIGIN: "headroom.example.com" }))).toThrow(
      EnvValidationError,
    );
    expect(() => parseEnv(validEnv({ APP_ORIGIN: "ftp://headroom.example.com" }))).toThrow(
      EnvValidationError,
    );
  });

  it("allows plain http on the house network, for testing on a phone", () => {
    // Browsers do not treat these as secure contexts, so the PWA parts will
    // not work, but the app itself is perfectly usable for development.
    for (const origin of [
      "http://192.168.2.105:8484",
      "http://10.0.0.5:8484",
      "http://172.16.4.2:8484",
      "http://172.31.255.1:8484",
      "http://169.254.1.1:8484",
      "http://daxpc.local:8484",
    ]) {
      const env = parseEnv(
        validEnv({ APP_ORIGIN: origin, COOKIE_SECURE: "false", NODE_ENV: "development" }),
      );
      expect(env.APP_ORIGIN, origin).toBe(origin);
    }
  });

  it("does not mistake a public address for a private one", () => {
    for (const origin of [
      // Just outside 172.16.0.0/12 on either side.
      "http://172.15.0.1:8484",
      "http://172.32.0.1:8484",
      // Looks private but is not.
      "http://11.0.0.1:8484",
      "http://192.169.0.1:8484",
      // Not a valid address at all.
      "http://999.1.1.1:8484",
    ]) {
      expect(
        () => parseEnv(validEnv({ APP_ORIGIN: origin, COOKIE_SECURE: "false", NODE_ENV: "development" })),
        origin,
      ).toThrow(EnvValidationError);
    }
  });

  it("refuses plain http in production, however private the address looks", () => {
    // Household finances in clear text is not a trade-off worth offering.
    expect(() =>
      parseEnv(validEnv({ APP_ORIGIN: "http://192.168.2.105:8484", NODE_ENV: "production" })),
    ).toThrow(/must be HTTPS in production/);

    expect(() =>
      parseEnv(validEnv({ APP_ORIGIN: "http://localhost:8484", NODE_ENV: "production" })),
    ).toThrow(/must be HTTPS in production/);
  });

  it("allows plain http on localhost, which browsers treat as secure", () => {
    const env = parseEnv(
      validEnv({
        APP_ORIGIN: "http://localhost:5173",
        COOKIE_SECURE: "false",
        NODE_ENV: "development",
      }),
    );
    expect(env.APP_ORIGIN).toBe("http://localhost:5173");
    expect(env.COOKIE_SECURE).toBe(false);
  });

  it("catches the combination that would silently break every login", () => {
    // A Secure cookie is never sent over plain HTTP, so the app would look
    // broken rather than insecure. Fail at startup instead.
    expect(() =>
      parseEnv(validEnv({ APP_ORIGIN: "http://localhost:3000", COOKIE_SECURE: "true" })),
    ).toThrow(/Secure cookie is never sent over plain HTTP/);
  });

  it("will not let production run with an insecure cookie", () => {
    expect(() =>
      parseEnv(validEnv({ NODE_ENV: "production", COOKIE_SECURE: "false" })),
    ).toThrow(/COOKIE_SECURE must stay true/);
  });

  it("reads the documented boolean spellings", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE"]) {
      expect(parseEnv(validEnv({ COOKIE_SECURE: value })).COOKIE_SECURE, value).toBe(true);
    }
    for (const value of ["false", "0", "no", "off", "FALSE"]) {
      const env = parseEnv(
        validEnv({ COOKIE_SECURE: value, NODE_ENV: "development", APP_ORIGIN: "http://localhost:3000" }),
      );
      expect(env.COOKIE_SECURE, value).toBe(false);
    }
  });

  it("rejects a boolean it cannot interpret rather than guessing", () => {
    expect(() => parseEnv(validEnv({ COOKIE_SECURE: "maybe" }))).toThrow();
  });

  it("rejects numbers that are not whole or are out of range", () => {
    expect(() => parseEnv(validEnv({ PORT: "0" }))).toThrow(EnvValidationError);
    expect(() => parseEnv(validEnv({ PORT: "99999" }))).toThrow(EnvValidationError);
    expect(() => parseEnv(validEnv({ PORT: "3000.5" }))).toThrow(EnvValidationError);
    expect(() => parseEnv(validEnv({ PORT: "abc" }))).toThrow(EnvValidationError);
    expect(() => parseEnv(validEnv({ SESSION_TTL_DAYS: "0" }))).toThrow(EnvValidationError);
  });

  it("treats an empty string as absent, so a blank line in .env uses the default", () => {
    expect(parseEnv(validEnv({ PORT: "" })).PORT).toBe(3000);
    expect(parseEnv(validEnv({ SSE_HEARTBEAT_SECONDS: "" })).SSE_HEARTBEAT_SECONDS).toBe(25);
  });

  it("requires the three Web Push keys together or not at all", () => {
    expect(() => parseEnv(validEnv({ VAPID_PUBLIC_KEY: "key-only" }))).toThrow(/VAPID/);
    expect(() =>
      parseEnv(validEnv({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" })),
    ).toThrow(/VAPID/);

    const complete = parseEnv(
      validEnv({
        VAPID_PUBLIC_KEY: "pub",
        VAPID_PRIVATE_KEY: "priv",
        VAPID_SUBJECT: "mailto:admin@example.com",
      }),
    );
    expect(hasWebPush(complete)).toBe(true);
  });

  it("treats Web Push as off when the keys are absent, which is the default", () => {
    expect(hasWebPush(parseEnv(validEnv()))).toBe(false);
  });

  it("lists every problem at once, so one restart shows all of them", () => {
    try {
      parseEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
      expect.unreachable("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const problems = (error as EnvValidationError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(3);
      expect((error as Error).message).toContain("Copy .env.example to .env");
    }
  });
});
