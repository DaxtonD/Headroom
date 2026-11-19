/**
 * The picture beside a name: storing one, and serving it back.
 *
 * Asked for by the household, to make an item easy to pick out of a list:
 * "it'll appear to the left of the name of the account, expense or category."
 * They also asked that it be shared - "the image is published so we both see
 * the same image" - which is the whole reason it is here and not in browser
 * storage on one phone.
 *
 * ## Why this is a resource of its own
 *
 * Every mutation in Headroom is a field-level PATCH carrying `If-Match` and an
 * `Idempotency-Key` (HANDOFF section 16). A picture does not fit that shape -
 * it is bytes, not a field - so it is uploaded here first and then *referenced*
 * by an ordinary PATCH setting `imageId`. Nothing about the mutation rules has
 * to bend, and the thing that makes a figure wrong - a half-applied change -
 * remains impossible.
 *
 * ## Content-addressed, and what that buys
 *
 * The row is insert-only and keyed by a uuid, but it is looked up for dedupe
 * by the SHA-256 of its bytes. So:
 *
 *  - the same picture given to two things is stored once;
 *  - an id never comes to mean different bytes, because a re-crop inserts a
 *    new row rather than changing one. That is what lets the response be
 *    cached for ever by the browser and by the service worker, which is how
 *    these survive offline;
 *  - `Cache-Control` says `private`, because this is one household's data on
 *    an authenticated route. Immutable, but not shared.
 *
 * ## What is NOT trusted
 *
 * The client encodes WebP and sends base64. The server re-reads the bytes, so
 * `width`, `height` and `byteSize` are what the file actually says rather than
 * what the request claimed, the magic bytes have to be WebP whatever the
 * `contentType` field says, and the size cap is enforced here. A client is a
 * phone, and a phone is not a trust boundary.
 *
 * None of this can affect a figure: `packages/core` does not know the table
 * exists.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, hashRequest, requireIdempotencyKey } from "../lib/http.js";
import { runIdempotent } from "../lib/idempotency.js";
import { readWebp, MAX_IMAGE_BYTES } from "../lib/images.js";

/**
 * Base64 of a WebP file, as the picker produces it.
 *
 * Base64 in JSON rather than multipart, which is a deliberate simplification
 * and not laziness. The picker crops and re-encodes on the phone, so what
 * arrives is some 15KB - comfortably inside the 256KB `bodyLimit` the app
 * already sets - and it travels through the same JSON pipeline, the same Zod
 * validation and the same idempotency machinery as every other write. A
 * multipart parser would be a new dependency, a second body path and a second
 * place for a size limit to be forgotten, all to save a third in transfer size
 * on a file this small.
 *
 * The length cap here is the cheap first line: it refuses an oversized body
 * before anything decodes it.
 */
const createBody = z
  .object({
    base64: z
      .string()
      .min(1, "That image is empty.")
      // 4/3 for base64's expansion, plus slack for padding and whitespace.
      .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 256, "That image is too big."),
  })
  .strict();

export async function registerImageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Store a picture, or hand back the one already stored.
   *
   * 201 either way, with the id. Re-uploading the identical crop is not an
   * error and not a second row - it is the same picture, and the household
   * giving the same logo to three subscriptions is the expected case rather
   * than an edge one.
   */
  app.post("/images", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "That image could not be read.",
      );
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(parsed.data.base64, "base64");
    } catch {
      throw new HttpError(400, "invalid_image", "That image could not be decoded.");
    }

    // The real bytes, not what the request said about them.
    const read = readWebp(bytes);
    if (!read.ok) throw new HttpError(400, read.code, read.message);

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = requireIdempotencyKey(request);

    const result = await runIdempotent({
      prisma: app.db.prisma,
      key,
      userId: user.id,
      method: "POST",
      path: "/api/images",
      requestHash: hashRequest("POST", "/api/images", request.body),
      ttlHours: app.env.IDEMPOTENCY_KEY_TTL_HOURS,
      work: async (tx) => {
        const existing = await tx.image.findUnique({
          where: { householdId_sha256: { householdId: user.householdId, sha256 } },
          select: { id: true, width: true, height: true, byteSize: true },
        });
        if (existing) return { statusCode: 201, body: { image: existing } };

        const created = await tx.image.create({
          data: {
            householdId: user.householdId,
            sha256,
            // Prisma's `Bytes` is a Uint8Array; the copy also detaches it
            // from Node's shared buffer pool, which a Buffer from base64 may
            // be a view into.
            bytes: new Uint8Array(bytes),
            contentType: "image/webp",
            width: read.width,
            height: read.height,
            byteSize: bytes.byteLength,
            createdById: user.id,
          },
          select: { id: true, width: true, height: true, byteSize: true },
        });

        /*
         * No activity entry. The log is for changes to the household's money
         * and its arrangements, and an uploaded file is neither until
         * something points at it - which is a PATCH, and that is logged. An
         * entry here would mean two lines in the activity feed for one act.
         */
        return { statusCode: 201, body: { image: created } };
      },
    });

    return reply.status(result.statusCode).send(result.body);
  });

  /**
   * Serve one.
   *
   * Authenticated and household-scoped: these are pictures of a household's
   * own arrangements, and the id being unguessable is not a reason to serve it
   * to anybody who asks.
   */
  app.get<{ Params: { id: string } }>("/images/:id", async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, "not_signed_in", "Sign in to continue.");

    if (!z.string().uuid().safeParse(request.params.id).success) {
      throw new HttpError(404, "not_found", "That image does not exist.");
    }

    const image = await app.db.prisma.image.findFirst({
      where: { id: request.params.id, householdId: user.householdId },
      select: { bytes: true, contentType: true, byteSize: true },
    });
    if (!image) throw new HttpError(404, "not_found", "That image does not exist.");

    return reply
      .header("content-type", image.contentType)
      .header("content-length", String(image.byteSize))
      /*
       * Immutable, because the row is insert-only and the id is never reused
       * for different bytes. `private` because it is one household's data on
       * an authenticated route - a shared cache must not keep it.
       */
      .header("cache-control", "private, max-age=31536000, immutable")
      /*
       * It is a picture, and it is served from the same origin as the app, so
       * a browser that decided to sniff it as something else would be running
       * it inside the app's own origin. Both headers say: do not.
       */
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .send(Buffer.from(image.bytes));
  });
}
