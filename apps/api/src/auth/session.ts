/**
 * Sessions.
 *
 * The cookie carries nothing but a signed, opaque session id; everything else
 * lives in the `session` table. That way a session can be revoked server-side,
 * and the cookie never contains a claim worth forging.
 *
 * Long-lived on purpose (90 days by default): Carol opens the app several
 * times a day and should not meet a login screen each time.
 */
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../env.js";
import type { PrismaClient } from "../generated/prisma/client.js";

export const SESSION_COOKIE = "headroom_session";

export interface SessionUser {
  readonly id: string;
  readonly householdId: string;
  readonly name: string;
  readonly initial: string;
  readonly email: string;
  readonly colorFg: string;
  readonly colorBg: string;
}

/** Cookie attributes. `signed` means the value is HMACed with SESSION_SECRET. */
export function cookieOptions(env: Env) {
  return {
    path: "/",
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    // Lax, not Strict: the app is opened from the home screen and from links,
    // and Strict would drop the cookie on those first navigations.
    sameSite: "lax" as const,
    signed: true,
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60,
  };
}

/** Create a session row and set the cookie on the reply. */
export async function startSession(
  prisma: PrismaClient,
  env: Env,
  reply: FastifyReply,
  userId: string,
  request: FastifyRequest,
): Promise<string> {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      id,
      userId,
      expiresAt,
      userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null,
      ip: request.ip,
    },
  });

  reply.setCookie(SESSION_COOKIE, id, cookieOptions(env));
  return id;
}

/** Delete the session row and clear the cookie. Safe to call when signed out. */
export async function endSession(
  prisma: PrismaClient,
  env: Env,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sessionId = readSessionId(request);
  if (sessionId) {
    await prisma.session.deleteMany({ where: { id: sessionId } });
  }
  reply.clearCookie(SESSION_COOKIE, { ...cookieOptions(env), maxAge: undefined });
}

/** Read and unsign the session id from the cookie, or undefined. */
export function readSessionId(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return undefined;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return undefined;
  return unsigned.value;
}

/**
 * Resolve the signed-in user, or undefined.
 *
 * An expired session is deleted as it is encountered, so the table does not
 * accumulate dead rows for two users who never sign out.
 */
export async function resolveSessionUser(
  prisma: PrismaClient,
  request: FastifyRequest,
): Promise<SessionUser | undefined> {
  const sessionId = readSessionId(request);
  if (!sessionId) return undefined;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });

  if (!session) return undefined;

  // Server clock is authoritative (HANDOFF section 16.1 rule 10).
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.deleteMany({ where: { id: sessionId } });
    return undefined;
  }

  if (session.user.deletedAt !== null) return undefined;

  return {
    id: session.user.id,
    householdId: session.user.householdId,
    name: session.user.name,
    initial: session.user.initial,
    email: session.user.email,
    colorFg: session.user.colorFg,
    colorBg: session.user.colorBg,
  };
}

/** Remove expired sessions. Called on a timer by the server. */
export async function purgeExpiredSessions(prisma: PrismaClient): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return result.count;
}
