/**
 * The activity log: who did what, newest first.
 *
 * Everything here was already being recorded. `activity` is append-only and
 * has been written on every mutation since M2, because the conflict detection
 * needs it - two people editing the same bill is answered by asking what
 * happened since the version the client saw. It was simply never readable by
 * anyone.
 *
 * ## Structured, not a sentence
 *
 * The rows go out as fields and the client words them with
 * `@headroom/core`'s `activitySentence`. The same function words the push
 * notification on the server. One function, so the log and the notification
 * cannot tell the household two different stories about one event - which
 * they would, the first time either was edited on its own.
 *
 * ## Paging by time, not by offset
 *
 * `before` is the timestamp of the oldest row already held. An offset would
 * skip rows as new activity arrives at the top, which with two people editing
 * at once is not a rare case but the normal one.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/http.js";

const query = z.object({
  /** ISO timestamp of the oldest entry already shown. */
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/activity", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = query.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", "That is not a page of the log.");
    }
    const { before, limit } = parsed.data;

    /*
     * One more than asked for, so "is there another page" is answered by the
     * same query rather than by a count that would be wrong by the time it
     * was read.
     */
    const rows = await app.db.prisma.activity.findMany({
      where: {
        householdId: user.householdId,
        ...(before === undefined ? {} : { at: { lt: new Date(before) } }),
      },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        at: true,
        action: true,
        entity: true,
        entityId: true,
        label: true,
        labelKind: true,
        fields: true,
        afterJson: true,
        user: { select: { id: true, name: true, initial: true, colorFg: true, colorBg: true } },
      },
    });

    const page = rows.slice(0, limit);
    const more = rows.length > limit;

    return reply.send({
      entries: page.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        label: row.label,
        labelKind: row.labelKind,
        fields: row.fields,
        /*
         * Only the changed fields, which is what the wording turns on - was
         * this bill switched off or back on. It carries amounts for a change
         * of amount, which is fine: this is behind the sign-in, unlike the
         * notification that shares its wording.
         */
        after: row.afterJson ?? null,
        by: {
          id: row.user.id,
          name: row.user.name,
          initial: row.user.initial,
          colorFg: row.user.colorFg,
          colorBg: row.user.colorBg,
        },
      })),
      // Null rather than absent, so the client never has to tell "no more
      // pages" apart from "this field was renamed".
      nextBefore: more ? (page.at(-1)?.at.toISOString() ?? null) : null,
    });
  });
}
