#!/usr/bin/env node
/**
 * Are these two VAPID keys actually a pair?
 *
 * Written on 2026-11-22, after notifications stopped and the push service
 * answered for a freshly created subscription as though it had never existed.
 * That answer has one common cause: the key the server signs with is not the
 * key the browsers subscribed with. Nothing in the app could tell - a
 * mismatched pair looks exactly like a working one from the outside, right up
 * until every send is rejected and every subscription is dropped.
 *
 * A VAPID private key is a P-256 scalar, and a P-256 scalar has exactly one
 * public key. So the pair can be checked arithmetically, offline, with no
 * push service and no network: derive the public key from the private one and
 * see whether it is the public key you were given.
 *
 * ## It never prints a key
 *
 * Not the private one, and not the public one either. It prints a verdict and
 * the fingerprints, which are short hashes - enough to tell two keys apart in
 * a chat message or a log, useless for signing anything. The private key
 * exists in this process and nowhere else.
 *
 * ## Usage
 *
 *   VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... node scripts/check_vapid.mjs
 *   node scripts/check_vapid.mjs path/to/.env
 *
 * Exits 0 when they are a pair, 1 when they are not, 2 when it could not
 * tell - which is its own answer and not the same as "fine".
 */
import { createECDH, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** A short, non-reversible label, so two keys can be compared out loud. */
function fingerprint(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * Read one variable out of a .env file.
 *
 * Deliberately small: enough for `NAME=value`, with optional quotes and
 * `export`, and nothing else. A full dotenv parser here would be a second
 * implementation of something the app already does properly.
 */
function fromEnvFile(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== name) continue;
    return match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return undefined;
}

function decode(value, name, expectedBytes) {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== expectedBytes) {
    console.error(
      `${name} decodes to ${String(bytes.length)} bytes; a VAPID ${name.includes("PRIVATE") ? "private" : "public"} key is ${String(expectedBytes)}.`,
    );
    console.error(
      "  A key copied with a trailing newline, a space, or standard base64 rather than base64url lands here.",
    );
    return null;
  }
  return bytes;
}

const file = process.argv[2];
let publicValue = process.env["VAPID_PUBLIC_KEY"];
let privateValue = process.env["VAPID_PRIVATE_KEY"];

if (file !== undefined) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`Could not read ${file}.`);
    process.exit(2);
  }
  publicValue = fromEnvFile(text, "VAPID_PUBLIC_KEY") ?? publicValue;
  privateValue = fromEnvFile(text, "VAPID_PRIVATE_KEY") ?? privateValue;
}

if (!publicValue || !privateValue) {
  console.error("Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or pass a .env file to read.");
  console.error("");
  console.error("  VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... node scripts/check_vapid.mjs");
  console.error("  node scripts/check_vapid.mjs .env");
  process.exit(2);
}

// 65 bytes: an uncompressed P-256 point, 0x04 followed by X and Y.
const publicKey = decode(publicValue, "VAPID_PUBLIC_KEY", 65);
// 32 bytes: the scalar.
const privateKey = decode(privateValue, "VAPID_PRIVATE_KEY", 32);
if (!publicKey || !privateKey) process.exit(2);

if (publicKey[0] !== 0x04) {
  console.error("VAPID_PUBLIC_KEY is not an uncompressed P-256 point (it should begin 0x04).");
  process.exit(2);
}

let derived;
try {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  derived = ecdh.getPublicKey();
} catch {
  console.error("VAPID_PRIVATE_KEY is not a valid P-256 private key.");
  process.exit(2);
}

if (derived.equals(publicKey)) {
  console.log("These are a matching pair.");
  console.log(`  public key fingerprint: ${fingerprint(publicKey)}`);
  console.log("");
  console.log("So a push service rejecting a brand-new subscription is not this.");
  process.exit(0);
}

console.log("These are NOT a pair.");
console.log(`  VAPID_PUBLIC_KEY  fingerprint: ${fingerprint(publicKey)}`);
console.log(`  derived from private key:      ${fingerprint(derived)}`);
console.log("");
console.log("Every browser subscribed with the public key, and the server signs with the");
console.log("private one, so the push service sees a signature that does not belong to the");
console.log("subscription and rejects it. Turning notifications off and on again cannot help:");
console.log("the new subscription is refused exactly like the old one.");
console.log("");
console.log("Fix: generate one pair with `npx web-push generate-vapid-keys`, set BOTH values");
console.log("from that single output, restart, and sign each device up again.");
process.exit(1);
