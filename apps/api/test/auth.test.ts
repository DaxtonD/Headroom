/**
 * Login, sessions and the health check, against a real Postgres.
 *
 * The M0 acceptance criterion is "login for two users" plus a health check;
 * these tests are what makes that checkable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  migrateTestDatabase,
  seedHousehold,
  signIn,
  type Harness,
} from "./helpers/harness.js";

let harness: Harness;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
});

describe("GET /api/health", () => {
  it("reports ok and reaches the database", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.database).toBe("up");
    expect(body.timezone).toBe("America/Regina");
    expect(typeof body.serverTime).toBe("string");
  });

  it("needs no session, so a probe can call it", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
  });

  it("gives away nothing about the household", async () => {
    await seedHousehold(harness);
    const body = await harness.app.inject({ method: "GET", url: "/api/health" }).then((r) => r.body);

    expect(body).not.toContain("Carol");
    expect(body).not.toContain("example.test");
    expect(body).not.toContain("Chequing");
  });
});

describe("POST /api/auth/login", () => {
  it("signs in each of the two users and sets a session cookie", async () => {
    const { carol, dax, password } = await seedHousehold(harness);

    for (const user of [carol, dax]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: user.email, password },
      });

      expect(response.statusCode, user.name).toBe(200);
      expect(response.json().user.name).toBe(user.name);

      const setCookie = String(response.headers["set-cookie"]);
      expect(setCookie).toContain("headroom_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      // 90 days by default, because the app is opened many times a day.
      expect(setCookie).toMatch(/Max-Age=7776000/);
    }
  });

  it("never returns the password hash", async () => {
    const { carol, password } = await seedHousehold(harness);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: carol.email, password },
    });

    expect(response.body).not.toContain("argon2");
    expect(response.json().user).not.toHaveProperty("passwordHash");
  });

  it("accepts the email in any case, with surrounding spaces", async () => {
    const { password } = await seedHousehold(harness);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "  CAROL@Example.TEST  ", password },
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects a wrong password", async () => {
    const { carol } = await seedHousehold(harness);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: carol.email, password: "not-the-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("invalid_credentials");
  });

  it("answers an unknown email exactly as it answers a wrong password", async () => {
    const { carol } = await seedHousehold(harness);

    const unknown = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.test", password: "whatever-password" },
    });
    const wrongPassword = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: carol.email, password: "wrong-password" },
    });

    // Same status and same message: nothing reveals which account exists.
    expect(unknown.statusCode).toBe(wrongPassword.statusCode);
    expect(unknown.json()).toEqual(wrongPassword.json());
  });

  it("will not sign in a removed user", async () => {
    const { carol, password } = await seedHousehold(harness);
    await harness.db.prisma.user.update({
      where: { id: carol.id },
      data: { deletedAt: new Date() },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: carol.email, password },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed request", async () => {
    await seedHousehold(harness);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "", password: "" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/me", () => {
  it("refuses without a session", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("not_signed_in");
  });

  it("returns the user, the household settings and both members", async () => {
    const { password } = await seedHousehold(harness);
    const cookie = await signIn(harness, "carol@example.test", password);

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.user.name).toBe("Carol");
    expect(body.user.initial).toBe("C");
    expect(body.household.timezone).toBe("America/Regina");
    expect(body.household.currency).toBe("CAD");
    // Cents cross the wire as strings, because JSON has no bigint.
    expect(body.household.cushionCents).toBe("0");
    expect(body.household.weekendWithdrawalRule).toBe("as_scheduled");
    // Home shows both people's initials, so /api/me has to carry both.
    expect(body.members.map((member: { initial: string }) => member.initial).sort()).toEqual(["C", "D"]);
  });

  it("stops working once the session is deleted server-side", async () => {
    const { password } = await seedHousehold(harness);
    const cookie = await signIn(harness, "carol@example.test", password);

    await harness.db.prisma.session.deleteMany({});

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it("treats an expired session as signed out and tidies it away", async () => {
    const { password } = await seedHousehold(harness);
    const cookie = await signIn(harness, "carol@example.test", password);

    // Age the whole row, not just its expiry: a CHECK constraint keeps
    // expiresAt after createdAt, so a session that expired before it was
    // created cannot exist. The server clock decides, not the client's.
    await harness.db.pool.query(
      `UPDATE "session" SET "createdAt" = now() - interval '2 days', "expiresAt" = now() - interval '1 day'`,
    );

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(401);
    expect(await harness.db.prisma.session.count()).toBe(0);
  });

  it("ignores a forged cookie that was not signed with the secret", async () => {
    await seedHousehold(harness);
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: "headroom_session=00000000-0000-4000-8000-000000000000" },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("removes the session and clears the cookie", async () => {
    const { password } = await seedHousehold(harness);
    const cookie = await signIn(harness, "carol@example.test", password);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(await harness.db.prisma.session.count()).toBe(0);

    const after = await harness.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("is harmless when nobody is signed in", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(response.statusCode).toBe(200);
  });
});

describe("login throttling", () => {
  const ATTACKER_IP = "203.0.113.9";

  const wrongPassword = (ip: string) =>
    harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.test", password: "wrong-password" },
      remoteAddress: ip,
    });

  it("stops a password guessing run from one address", async () => {
    await seedHousehold(harness);

    const limit = harness.env.LOGIN_RATE_LIMIT;
    for (let i = 0; i < limit; i += 1) {
      expect((await wrongPassword(ATTACKER_IP)).statusCode, `attempt ${i + 1}`).toBe(401);
    }

    const blocked = await wrongPassword(ATTACKER_IP);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("too_many_attempts");
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("blocks only the offending address", async () => {
    const { password } = await seedHousehold(harness);

    for (let i = 0; i < harness.env.LOGIN_RATE_LIMIT; i += 1) {
      await wrongPassword(ATTACKER_IP);
    }
    expect((await wrongPassword(ATTACKER_IP)).statusCode).toBe(429);

    // Carol, at home on a different address, is unaffected.
    const fromHome = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.test", password },
      remoteAddress: "198.51.100.4",
    });
    expect(fromHome.statusCode).toBe(200);
  });

  it("counts only failures, so signing in repeatedly never locks anyone out", async () => {
    const { password } = await seedHousehold(harness);

    // Comfortably more sign-ins than the limit allows as failures.
    for (let i = 0; i < harness.env.LOGIN_RATE_LIMIT + 5; i += 1) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "carol@example.test", password },
        remoteAddress: "198.51.100.7",
      });
      expect(response.statusCode, `sign-in ${i + 1}`).toBe(200);
    }
  });

  it("forgives earlier failures once the right password is used", async () => {
    const { password } = await seedHousehold(harness);
    const ip = "198.51.100.9";

    // One short of the limit, then a success, which clears the record.
    for (let i = 0; i < harness.env.LOGIN_RATE_LIMIT - 1; i += 1) {
      await wrongPassword(ip);
    }

    const success = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.test", password },
      remoteAddress: ip,
    });
    expect(success.statusCode).toBe(200);

    // The slate is clean: a fresh run of failures is allowed again.
    for (let i = 0; i < harness.env.LOGIN_RATE_LIMIT; i += 1) {
      expect((await wrongPassword(ip)).statusCode, `after reset ${i + 1}`).toBe(401);
    }
    expect((await wrongPassword(ip)).statusCode).toBe(429);
  });
});
