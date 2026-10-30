// backend_passwords.js
// -----------------------------------------------------------------------
// Password hashing with scrypt (built into Node, no extra dependency).
// Stored as  scrypt$N$r$p$salt$hash  so the cost can be raised later
// without invalidating old passwords. Comparison is constant-time, and an
// unknown account still burns the same CPU as a real one so response time
// doesn't reveal which emails exist.
// -----------------------------------------------------------------------

import crypto from "crypto";
import { promisify } from "util";

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

let dummyHash;
export async function verifyPassword(password, stored) {
  if (!stored) {
    dummyHash ??= await hashPassword("not-a-real-password");
    stored = dummyHash;
    await verifyAgainst(password, stored);
    return false;
  }
  return verifyAgainst(password, stored);
}

async function verifyAgainst(password, stored) {
  const [scheme, n, r, p, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}
