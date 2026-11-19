/**
 * Reading a WebP header, so the server never takes a client's word for it.
 *
 * The picker crops and encodes on the phone, so in the ordinary case what
 * arrives is a small square WebP exactly as intended. This exists for the
 * cases that are not ordinary: a renamed `.exe`, a 20000x20000 canvas that
 * decodes into gigabytes, a truncated upload from a dropped connection, or
 * simply a future version of the app with a bug in it. A phone is not a trust
 * boundary.
 *
 * So the magic bytes are checked, the real dimensions are read out of the file
 * rather than taken from the request, and anything unparseable is refused
 * rather than stored and served back later as a broken square.
 *
 * ## Why parse by hand instead of using a library
 *
 * Because this is the whole job: four byte signatures and three ways of
 * writing two integers. A decoder would pull in native bindings to answer a
 * question that does not need the pixels decoded at all - and decoding
 * untrusted bytes is the thing worth avoiding, not the thing to add a
 * dependency for. Nothing here allocates anything proportional to the image's
 * dimensions; it reads at most 30 bytes.
 *
 * Format, from the Google container specification:
 *
 *   0..3    "RIFF"
 *   4..7    file size minus 8, little-endian
 *   8..11   "WEBP"
 *   12..15  the first chunk's identifier, which says where the size lives:
 *             "VP8 "  simple lossy
 *             "VP8L"  lossless
 *             "VP8X"  extended - alpha, animation; what a canvas emits when
 *                     the crop has transparency in it
 */
import { HttpError } from "./http.js";


/**
 * The most the server will store for one picture.
 *
 * A limit, not a target. The picker aims at a 256px square at a quality that
 * lands around 15KB, which is what makes this number uninteresting in normal
 * use - see `cropImage.ts` for that end of it. It is here so that a client
 * which gets it wrong is refused rather than filling the household's database
 * and, through it, their backups.
 *
 * Hard-coded rather than an environment variable, which matches `bodyLimit` in
 * `app.ts`: it is a safety bound on a shape of request, not a thing a
 * deployment tunes.
 */
export const MAX_IMAGE_BYTES = 48 * 1024;

/**
 * The largest edge the server will accept.
 *
 * The picker sends 256. The margin is for a future change of mind about how
 * sharp these should look on a high-density screen; well below anything that
 * would be slow to decode in a browser.
 */
export const MAX_IMAGE_EDGE = 1024;

/* -------------------------------------------------------------------------- */
/* Pointing something at a picture                                            */
/* -------------------------------------------------------------------------- */

/**
 * Just enough of a Prisma client or transaction for the two checks below.
 *
 * Structural, like `AccountReader` in `accounts.ts`, so this module does not
 * depend on the generated client and the compiler still catches a renamed
 * field.
 */
interface ImageReader {
  readonly image: {
    findFirst(args: {
      where: { id: string; householdId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  readonly account: {
    count(args: { where: { imageId: string } }): Promise<number>;
  };
  readonly template: {
    count(args: { where: { imageId: string } }): Promise<number>;
  };
  readonly budgetLine: {
    count(args: { where: { imageId: string } }): Promise<number>;
  };
}

/**
 * Refuse an `imageId` that is not this household's.
 *
 * `imageId` is a plain foreign key, so the database would accept another
 * household's picture quite happily - the same hole `requireValidRouting`
 * exists to close for accounts, and closed the same way.
 *
 * A 400 rather than a 404, deliberately: a 404 would confirm that the id does
 * not exist, and the client is not entitled to learn anything about rows
 * outside its own household either way.
 *
 * Null is always allowed. It means "no picture", which is what every row
 * started as.
 */
export async function requireOwnImage(
  tx: ImageReader,
  householdId: string,
  imageId: string | null | undefined,
): Promise<void> {
  if (imageId === null || imageId === undefined) return;

  const found = await tx.image.findFirst({
    where: { id: imageId, householdId },
    select: { id: true },
  });

  if (!found) {
    throw new HttpError(400, "invalid_request", "That picture does not exist.");
  }
}

/**
 * Delete a picture once nothing points at it any more.
 *
 * Called with whatever an entity was pointing at BEFORE a change. Without it
 * the table grows by one row every time somebody re-crops - the crop is a new
 * row by design, because the id has to keep meaning the same bytes - and the
 * database is also the backup, so the growth would be paid for twice.
 *
 * All three tables are counted because the same picture can be shared: the
 * household giving one logo to three subscriptions is the expected case, so
 * "nobody is using the one I just replaced" is a question about every table
 * rather than about the row that changed.
 *
 * Runs inside the caller's transaction, after the write, so the counts see the
 * new state. Never throws for being unable to delete: an orphan left behind is
 * some 15KB and a failed PATCH is a figure nobody can correct.
 */
export async function forgetImageIfUnused(
  tx: ImageReader,
  imageId: string | null | undefined,
): Promise<void> {
  if (imageId === null || imageId === undefined) return;

  const [accounts, templates, budgetLines] = await Promise.all([
    tx.account.count({ where: { imageId } }),
    tx.template.count({ where: { imageId } }),
    tx.budgetLine.count({ where: { imageId } }),
  ]);

  if (accounts + templates + budgetLines > 0) return;

  try {
    await tx.image.delete({ where: { id: imageId } });
  } catch {
    // Something grabbed it between the count and the delete, or it was
    // already gone. Either way there is nothing to put right.
  }
}

export type ReadResult =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

function bad(code: string, message: string): ReadResult {
  return { ok: false, code, message };
}

/**
 * The dimensions a WebP declares, or why it cannot be read.
 *
 * Every read is bounds-checked first. A truncated file is the expected failure
 * here - a dropped connection mid-upload produces one - and reading past the
 * end of a Buffer throws, which would be a 500 for what is really a bad
 * request.
 */
export function readWebp(bytes: Buffer): ReadResult {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return bad(
      "image_too_large",
      `That image is ${Math.ceil(bytes.byteLength / 1024)}KB, and the limit is ${MAX_IMAGE_BYTES / 1024}KB.`,
    );
  }

  /*
   * Enough to hold a container and a chunk header, so the reads below this
   * line are in bounds. Each format then checks its own needs - 30 bytes for
   * lossy and extended, 25 for lossless, which a 1x1 lossless image really
   * can be. A single floor of 30 here refused those, and the test for the
   * three formats at their largest is what found it.
   */
  if (bytes.byteLength < 21) return bad("invalid_image", "That file is too short to be an image.");

  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
    return bad(
      "unsupported_image",
      "That is not a WebP image. Pictures are converted before they are sent, so this means something went wrong rather than that the file is wrong.",
    );
  }

  /*
   * The declared length has to match what actually arrived, or the file is
   * truncated - which is what a dropped upload looks like, and which would
   * otherwise be stored and served back as a half-drawn square.
   */
  const declared = bytes.readUInt32LE(4);
  if (declared + 8 !== bytes.byteLength) {
    return bad("invalid_image", "That image arrived incomplete. Please try again.");
  }

  const size = ((): { readonly width: number; readonly height: number } | null => {
    const chunk = bytes.toString("ascii", 12, 16);

    if (chunk === "VP8 ") {
      // 20 is the payload: 3 bytes of frame tag, then the start code.
      if (bytes.byteLength < 30) return null;
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      // 14 bits each; the top 2 are a scaling hint and are not the size.
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }

    if (chunk === "VP8L") {
      // One signature byte, then 14 bits of width-1 and 14 of height-1.
      if (bytes.byteLength < 25 || bytes[20] !== 0x2f) return null;
      const packed = bytes.readUInt32LE(21);
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    }

    if (chunk === "VP8X") {
      // Canvas size, 24 bits each, minus one. This is what a browser canvas
      // produces when the crop has any transparency in it.
      if (bytes.byteLength < 30) return null;
      return {
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      };
    }

    return null;
  })();

  if (size === null) {
    return bad("invalid_image", "That image could not be read. Please try another one.");
  }

  if (size.width < 1 || size.height < 1) {
    return bad("invalid_image", "That image has no size.");
  }

  if (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE) {
    return bad(
      "image_too_large",
      `That image is ${size.width}x${size.height}, and the limit is ${MAX_IMAGE_EDGE} either way.`,
    );
  }

  return { ok: true, width: size.width, height: size.height };
}
