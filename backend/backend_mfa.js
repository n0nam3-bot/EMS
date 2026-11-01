// backend_mfa.js
// -----------------------------------------------------------------------
// Two-step sign-in with an authenticator app (Google Authenticator, Authy,
// 1Password, Microsoft Authenticator...). Standard TOTP (RFC 6238): a
// 6-digit code that changes every 30 seconds. Built on Node's own crypto so
// there is nothing extra to install or to trust.
//
// Properties that matter:
//  - The secret is stored ENCRYPTED (AES-256-GCM, key derived from
//    SESSION_SECRET). A copy of the database alone can't mint codes.
//  - A code works once: the time-step last used is remembered, so a code
//    someone shoulder-surfed or intercepted can't be replayed.
//  - Eight single-use recovery codes cover a lost phone; they're stored
//    only as hashes. A supervisor (or platform admin) can also reset 2FA.
// -----------------------------------------------------------------------

import crypto from "crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

// Returns the matching time step, or null. Accepts one step either side for
// clock drift, and refuses any step at or before the last one used.
export function verifyTotp(secretB32, code, lastStep = 0, nowMs = Date.now()) {
  const given = String(code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const key = base32Decode(secretB32);
  const now = stepAt(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= Number(lastStep)) continue;
    const want = hotp(key, step);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(given))) return step;
  }
  return null;
}

export function otpauthUrl({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// ---- secret at rest ---------------------------------------------------------
function key() {
  const s = process.env.SESSION_SECRET || "";
  if (s.length < 32) throw new Error("SESSION_SECRET is missing or shorter than 32 characters");
  return Buffer.from(crypto.hkdfSync("sha256", s, "ems-mfa", "totp-secret-v1", 32));
}
export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct].map((p) => (Buffer.isBuffer(p) ? p.toString("base64") : p)).join(":");
}
export function decryptSecret(blob) {
  const [v, iv, tag, ct] = String(blob).split(":");
  if (v !== "v1") throw new Error("unknown secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

// ---- recovery codes ------------------------------------------------------------
const norm = (c) => String(c ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const hashCode = (c) => crypto.createHash("sha256").update(norm(c)).digest("hex");
export function newRecoveryCodes(n = 8) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = Array.from({ length: n }, () => {
    const b = crypto.randomBytes(8);
    const raw = Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}
// Returns the remaining hashes if the code was valid (and so is now used up), else null.
export function consumeRecovery(hashes, code) {
  const h = hashCode(code);
  if (norm(code).length < 6 || !hashes.includes(h)) return null;
  return hashes.filter((x) => x !== h);
}
