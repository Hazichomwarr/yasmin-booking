import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Admin password hashing (YASMIN-2A): scrypt from Node's crypto, a
 * memory-hard KDF, so no native dependency is needed.
 *
 * Stored format (self-describing, base64url, no padding):
 *   scrypt$<N>$<r>$<p>$<salt>$<derived key>
 *
 * Defaults follow OWASP's scrypt guidance (N=2^17, r=8, p=1: ~128 MiB).
 * Verification accepts only parameters inside fixed bounds, so a corrupt or
 * hostile stored value can neither exhaust memory nor downgrade below
 * MIN_COST. The comparison is constant-time.
 */

export const ADMIN_PASSWORD_PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;
const MIN_COST = 2 ** 14;
const MAX_COST = 2 ** 20;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{22,})\$([A-Za-z0-9_-]{43,})$/;

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 256;

type Params = { N: number; r: number; p: number };

function derive(password: string, salt: Buffer, params: Params, length: number): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, length, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/**
 * Hashes a new password. `params` exists for tests (cheaper, still within
 * the accepted bounds); production callers use the defaults.
 */
export async function hashAdminPassword(password: string, params: Params = ADMIN_PASSWORD_PARAMS): Promise<string> {
  if (!validParams(params)) throw new Error("scrypt parameters are outside the accepted bounds.");
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params, KEY_BYTES);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** True only for a well-formed, in-bounds hash of exactly this password. Never throws. */
export async function verifyAdminPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const match = typeof stored === "string" ? HASH_PATTERN.exec(stored) : null;
  if (!match) return false;
  const params = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (!validParams(params)) return false;
  const salt = Buffer.from(match[4], "base64url");
  const expected = Buffer.from(match[5], "base64url");
  if (expected.length !== KEY_BYTES) return false;
  try {
    const actual = await derive(password, salt, params, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let decoy: Promise<string> | null = null;

/**
 * Spends the same work as a real verification, for sign-in attempts with no
 * usable account, so response time does not reveal which emails exist.
 */
export async function verifyAgainstDecoy(password: string): Promise<false> {
  decoy ??= hashAdminPassword(randomBytes(24).toString("base64url"));
  await verifyAdminPassword(password, await decoy);
  return false;
}

/** Password policy for provisioning; null when acceptable. */
export function adminPasswordProblem(password: string, email: string): string | null {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) return `Use at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > ADMIN_PASSWORD_MAX_LENGTH) return `Use at most ${ADMIN_PASSWORD_MAX_LENGTH} characters.`;
  if (password.trim() !== password) return "Do not start or end the password with spaces.";
  if (new Set(password).size < 4) return "Use a less repetitive password.";
  if (password.toLowerCase().includes(email.split("@")[0].toLowerCase())) return "Do not include your email name in the password.";
  return null;
}

function validParams({ N, r, p }: Params): boolean {
  return Number.isInteger(N) && N >= MIN_COST && N <= MAX_COST && (N & (N - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= 16
    && Number.isInteger(p) && p >= 1 && p <= 4;
}
