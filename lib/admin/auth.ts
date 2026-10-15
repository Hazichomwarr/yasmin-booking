import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { verifyAdminPassword, verifyAgainstDecoy } from "./password";

/**
 * Admin authentication (YASMIN-2A): database-backed sessions.
 *
 * - Sign-in issues 32 random bytes (base64url, 43 chars); only SHA-256 hex is
 *   stored, in AdminSession.tokenHash, with a fixed expiry (no sliding).
 * - A session is valid only while: not revoked, the database clock is before
 *   expiresAt, the admin is not disabled, and the admin's password has not
 *   changed since the session began (a reset invalidates older sessions).
 * - Every sign-in failure has the same outcome, and unknown/disabled accounts
 *   still pay a full scrypt verification (no account enumeration by timing).
 * - Sessions are revoked, never deleted: rows stay as the access history.
 */

export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ADMIN_EMAIL_MAX_LENGTH = 254;

/**
 * Proof that a request carries a valid admin session. Only this module
 * creates it (tracked in a WeakSet), so admin data services can refuse
 * anything else — authorization is enforced at the data source, not only in
 * pages.
 */
export type AdminAccess = Readonly<{ adminUserId: string; email: string; sessionId: string; expiresAt: Date }>;
const grants = new WeakSet<AdminAccess>();

export function assertAdminAccess(value: unknown): asserts value is AdminAccess {
  if (typeof value !== "object" || value === null || !grants.has(value as AdminAccess)) {
    throw new Error("Admin authorization required.");
  }
}

export type SignInResult = { ok: true; token: string; expiresAt: Date } | { ok: false };

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "adminUser" | "adminSession">;

export function hashAdminSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizeAdminEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= ADMIN_EMAIL_MAX_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

async function databaseNow(db: Db = prisma): Promise<Date> {
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return now;
}

/** Finds the one admin with this email (case-insensitively); null if none or ambiguous. */
export async function findAdminByEmail(email: string, db: Db = prisma) {
  const matches = await db.adminUser.findMany({ where: { email: { equals: email, mode: "insensitive" } }, take: 2 });
  return matches.length === 1 ? matches[0] : null;
}

export async function signInAdmin(emailInput: unknown, password: unknown): Promise<SignInResult> {
  const email = normalizeAdminEmail(emailInput);
  const secret = typeof password === "string" && password.length > 0 && password.length <= 256 ? password : null;
  const admin = email && secret ? await findAdminByEmail(email) : null;

  const usable = admin && admin.passwordHash && admin.disabledAt === null;
  const verified = usable ? await verifyAdminPassword(secret!, admin.passwordHash) : await verifyAgainstDecoy(secret ?? "");
  if (!usable || !verified) return { ok: false };

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = await databaseNow();
  const session = await prisma.adminSession.create({
    data: { adminUserId: admin.id, tokenHash: hashAdminSessionToken(token), createdAt: now, expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS) },
  });
  return { ok: true, token, expiresAt: session.expiresAt };
}

/** The admin a token authorizes right now, or null. Read-only. */
export async function resolveAdminSession(token: unknown): Promise<AdminAccess | null> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hashAdminSessionToken(token) },
    include: { adminUser: { select: { id: true, email: true, passwordHash: true, passwordUpdatedAt: true, disabledAt: true } } },
  });
  if (!session || session.revokedAt) return null;
  const now = await databaseNow();
  const { adminUser } = session;
  if (now.getTime() >= session.expiresAt.getTime()) return null;
  if (adminUser.disabledAt || !adminUser.passwordHash || !adminUser.passwordUpdatedAt) return null;
  if (adminUser.passwordUpdatedAt.getTime() > session.createdAt.getTime()) return null;

  const access: AdminAccess = Object.freeze({ adminUserId: adminUser.id, email: adminUser.email, sessionId: session.id, expiresAt: session.expiresAt });
  grants.add(access);
  return access;
}

/** Revokes the token's session if it is still active. Idempotent; never reveals whether it existed. */
export async function revokeAdminSession(token: unknown): Promise<void> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return;
  const now = await databaseNow();
  await prisma.adminSession.updateMany({ where: { tokenHash: hashAdminSessionToken(token), revokedAt: null }, data: { revokedAt: now } });
}

/** Revokes every active session of one admin (password reset, disabling). */
export async function revokeAllAdminSessions(adminUserId: string, db: Db = prisma): Promise<number> {
  const now = await databaseNow(db);
  const { count } = await db.adminSession.updateMany({ where: { adminUserId, revokedAt: null }, data: { revokedAt: now } });
  return count;
}
