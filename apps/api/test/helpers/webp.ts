/**
 * Hand-built WebP files, for tests.
 *
 * Deliberately not produced by an encoder. An encoder only ever generates the
 * cases that already work; the ones worth testing are a renamed PNG, a
 * truncated upload, and a declared size that disagrees with reality. Building
 * the bytes by hand is also the only way to produce each of the three formats
 * on demand - a browser picks for you, based on whether the crop has
 * transparency.
 *
 * Nothing here needs to be a decodable image. The server reads the header and
 * stores the bytes; it never decodes pixels, which is the whole point of
 * `readWebp`.
 *
 * Format, from the Google container specification:
 *
 *   0..3    "RIFF"          8..11   "WEBP"
 *   4..7    size - 8        12..15  the first chunk's identifier
 */

/** Wrap a chunk in a RIFF/WEBP container with a correct declared size. */
export function container(fourcc: string, payload: Buffer): Buffer {
  const file = Buffer.alloc(20 + payload.byteLength);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(file.byteLength - 8, 4);
  file.write("WEBP", 8, "ascii");
  file.write(fourcc, 12, "ascii");
  file.writeUInt32LE(payload.byteLength, 16);
  payload.copy(file, 20);
  return file;
}

/**
 * Simple lossy: a frame tag, the start code, then 14 bits of each edge.
 *
 * What a browser canvas emits for a crop with no transparency, which is most
 * of them. `extra` pads the payload, for the size-limit tests.
 */
export function lossy(width: number, height: number, extra = 0): Buffer {
  const payload = Buffer.alloc(10 + extra);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return container("VP8 ", payload);
}

/** Lossless: a signature byte, then 14 bits of each edge, minus one. */
export function lossless(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return container("VP8L", payload);
}

/**
 * Extended: 24 bits of each canvas edge, minus one.
 *
 * What a canvas emits the moment the crop has an alpha channel - a logo cut
 * out of a PNG - so not an exotic variant but half the real traffic.
 */
export function extended(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return container("VP8X", payload);
}

/**
 * A distinct valid WebP per call, so two uploads are genuinely two pictures.
 *
 * The padding changes the bytes without changing the dimensions, which is what
 * makes it a different picture as far as content-addressing is concerned.
 */
export function distinctWebp(seed: number): Buffer {
  return lossy(256, 256, seed);
}
