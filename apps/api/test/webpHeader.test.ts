/**
 * Reading a WebP header, and refusing everything that is not one.
 *
 * No database and no harness: this is byte arithmetic, so it is tested as byte
 * arithmetic. That is the lesson from bugs 24 and 25 on the web side - a check
 * that only confirms the code says what the code says is not a test - and it
 * matters more here, because this function is the server's only defence
 * against a client sending something other than what it claims.
 *
 * The builders in `helpers/webp.ts` are hand-written rather than an encoder's
 * output. That is deliberate: an encoder would only ever generate the cases
 * that already work, and the ones worth testing are a renamed PNG, a
 * truncated upload and a declared size that disagrees with reality.
 *
 * Format, from the Google container specification:
 *
 *   0..3    "RIFF"          8..11   "WEBP"
 *   4..7    size - 8        12..15  the first chunk's identifier
 */
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, readWebp } from "../src/lib/images.js";
import { container, extended, lossless, lossy } from "./helpers/webp.js";

describe("a WebP the picker would produce", () => {
  it("reads a simple lossy one", () => {
    // What a canvas emits for a crop with no transparency, which is most of
    // them: a photo, or a logo on a solid background.
    expect(readWebp(lossy(256, 256))).toEqual({ ok: true, width: 256, height: 256 });
  });

  it("reads a lossless one", () => {
    expect(readWebp(lossless(256, 256))).toEqual({ ok: true, width: 256, height: 256 });
  });

  it("reads an extended one, which is what transparency produces", () => {
    /*
     * The case that would have been missed by testing only the simple format.
     * A browser canvas switches to VP8X the moment the image has an alpha
     * channel - a logo cropped from a PNG - so this is not an exotic variant,
     * it is half the real traffic.
     */
    expect(readWebp(extended(256, 256))).toEqual({ ok: true, width: 256, height: 256 });
  });

  it("reads a non-square one, since nothing here requires a square", () => {
    // The picker crops to a square, but the server is not the place to insist
    // on it: that would be a second rule to keep in step with the UI.
    expect(readWebp(lossy(320, 180))).toEqual({ ok: true, width: 320, height: 180 });
  });

  it("reads each format at its largest", () => {
    // 14 bits for the two VP8 formats, 24 for extended. Capped below by
    // MAX_IMAGE_EDGE, so this is about the arithmetic, not the policy.
    expect(readWebp(lossy(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))).toMatchObject({ ok: true });
    expect(readWebp(lossless(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))).toMatchObject({ ok: true });
    expect(readWebp(extended(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))).toMatchObject({ ok: true });
  });
});

describe("what it refuses", () => {
  it("refuses a PNG, whatever the request called it", () => {
    // The point of the whole function. A client says `image/webp`; the bytes
    // say otherwise, and the bytes decide.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]);
    expect(readWebp(png)).toMatchObject({ ok: false, code: "unsupported_image" });
  });

  it("refuses a JPEG", () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    expect(readWebp(jpeg)).toMatchObject({ ok: false, code: "unsupported_image" });
  });

  it("refuses a RIFF that is not a WEBP", () => {
    // A .wav is a RIFF file too, so the first four bytes are not enough.
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0, "ascii");
    wav.writeUInt32LE(56, 4);
    wav.write("WAVE", 8, "ascii");
    expect(readWebp(wav)).toMatchObject({ ok: false, code: "unsupported_image" });
  });

  it("refuses something far too short to be an image", () => {
    // Must not read past the end of the buffer, which would be a 500 for what
    // is really a bad request.
    expect(readWebp(Buffer.from("RIFF", "ascii"))).toMatchObject({ ok: false });
    expect(readWebp(Buffer.alloc(0))).toMatchObject({ ok: false });
    expect(readWebp(Buffer.alloc(29))).toMatchObject({ ok: false });
  });

  it("refuses one that arrived incomplete", () => {
    /*
     * What a dropped connection mid-upload looks like. Without this the
     * truncated bytes would be stored and served back for ever as a
     * half-drawn square, which is worse than refusing the upload: the
     * household would have no idea why one picture looked wrong.
     */
    const truncated = lossy(256, 256).subarray(0, 28);
    expect(readWebp(truncated)).toMatchObject({ ok: false, code: "invalid_image" });
  });

  it("refuses one whose declared size disagrees with its real one", () => {
    const file = lossy(256, 256);
    file.writeUInt32LE(file.byteLength + 500, 4);
    expect(readWebp(file)).toMatchObject({ ok: false, code: "invalid_image" });
  });

  it("refuses a lossy frame with no start code", () => {
    // Says VP8 and is not one. The dimensions would otherwise be read out of
    // whatever happened to be at those offsets.
    const file = lossy(256, 256);
    file[23] = 0x00;
    expect(readWebp(file)).toMatchObject({ ok: false, code: "invalid_image" });
  });

  it("refuses a lossless chunk with no signature byte", () => {
    const file = lossless(256, 256);
    file[20] = 0x00;
    expect(readWebp(file)).toMatchObject({ ok: false, code: "invalid_image" });
  });

  it("refuses a chunk type it does not know", () => {
    expect(readWebp(container("JUNK", Buffer.alloc(16)))).toMatchObject({
      ok: false,
      code: "invalid_image",
    });
  });

  it("refuses an image of no size", () => {
    expect(readWebp(lossy(0, 0))).toMatchObject({ ok: false, code: "invalid_image" });
  });

  it("refuses dimensions big enough to be a decompression bomb", () => {
    /*
     * A few hundred bytes of WebP can declare an enormous canvas, and the
     * cost of that lands on whatever decodes it later - a phone. Refused on
     * the declared size, before anything decodes anything.
     */
    const huge = extended(MAX_IMAGE_EDGE + 1, 10);
    expect(readWebp(huge)).toMatchObject({ ok: false, code: "image_too_large" });
    expect(readWebp(extended(10, MAX_IMAGE_EDGE + 1))).toMatchObject({
      ok: false,
      code: "image_too_large",
    });
  });

  it("refuses more bytes than it will store", () => {
    // Checked before anything else, so an oversized body is cheap to reject.
    const big = lossy(256, 256, MAX_IMAGE_BYTES);
    expect(big.byteLength).toBeGreaterThan(MAX_IMAGE_BYTES);
    expect(readWebp(big)).toMatchObject({ ok: false, code: "image_too_large" });
  });

  it("accepts one right on the size limit", () => {
    // The boundary in the direction that must still work, so the limit is not
    // quietly one byte tighter than it says.
    const exact = lossy(256, 256, MAX_IMAGE_BYTES - 30);
    expect(exact.byteLength).toBe(MAX_IMAGE_BYTES);
    expect(readWebp(exact)).toMatchObject({ ok: true });
  });
});
