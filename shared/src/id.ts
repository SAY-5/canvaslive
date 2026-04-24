// Small, dep-free nanoid. 21-char URL-safe ID with ~2^126 entropy.
// Uses the best available RNG for the runtime.

const ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

interface CryptoLike {
  getRandomValues(buf: Uint8Array): Uint8Array;
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(buf);
    return buf;
  }
  // Last-resort fallback. Not cryptographically strong but keeps dev running.
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

export function nanoid(size = 21): string {
  const bytes = randomBytes(size);
  let id = "";
  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i]! & 63];
  }
  return id;
}
