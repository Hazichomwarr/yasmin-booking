import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ADMIN_SESSION_TTL_MS, assertAdminAccess, hashAdminSessionToken, resolveAdminSession, revokeAdminSession, signInAdmin } from "@/lib/admin/auth";
import { AdminProvisioningError, provisionAdminPassword, setAdminEnabled } from "@/lib/admin/provision";
import { ADMIN_COOKIE_NAME } from "@/lib/admin/session-cookie";
import { createAdminAuthApi, defaultAdminAuthApiDeps } from "@/lib/http/admin-auth-api";
import { prisma } from "@/lib/prisma";

import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const FAST = { hashParams: { N: 2 ** 14, r: 8, p: 1 } };
const PASSWORD = "Velvet-Comb-2026!";

async function provision(email = "owner@example.test", password = PASSWORD) {
  return provisionAdminPassword({ email, password }, FAST);
}

async function signedIn(email = "owner@example.test") {
  const result = await signInAdmin(email, PASSWORD);
  assert.equal(result.ok, true);
  return (result as { token: string }).token;
}

describe("admin provisioning", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("creates an admin with a scrypt hash, never the plaintext", async () => {
    const result = await provision("Owner@Example.test");
    assert.deepEqual([result.created, result.email, result.revokedSessions], [true, "owner@example.test", 0]);
    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: result.adminUserId } });
    assert.match(row.passwordHash ?? "", /^scrypt\$/);
    assert.ok(row.passwordUpdatedAt);
    assert.equal(JSON.stringify(row).includes(PASSWORD), false);
  });

  it("keeps an existing AdminUser row (id, email, createdAt) and only sets its password", async () => {
    const existing = await prisma.adminUser.create({ data: { email: "legacy@example.test" } });
    const result = await provision("legacy@example.test");
    const after = await prisma.adminUser.findUniqueOrThrow({ where: { id: existing.id } });
    assert.deepEqual([result.created, result.adminUserId, after.email, after.createdAt], [false, existing.id, existing.email, existing.createdAt]);
    assert.equal(await prisma.adminUser.count(), 1);
  });

  it("a password reset revokes every active session of that admin", async () => {
    await provision();
    const [a, b] = [await signedIn(), await signedIn()];
    const reset = await provision("owner@example.test", "Another-Strong-Pass-9");
    assert.equal(reset.revokedSessions, 2);
    assert.equal(await resolveAdminSession(a), null);
    assert.equal(await resolveAdminSession(b), null);
    assert.equal(await prisma.adminSession.count(), 2, "sessions are revoked, never deleted");
  });

  it("refuses weak passwords and ambiguous emails without writing", async () => {
    await assert.rejects(provision("owner@example.test", "short"), AdminProvisioningError);
    assert.equal(await prisma.adminUser.count(), 0);
    await prisma.adminUser.createMany({ data: [{ email: "dup@example.test" }, { email: "DUP@example.test" }] });
    await assert.rejects(provision("dup@example.test"), /Several AdminUser rows/);
  });

  it("the database rejects a plaintext password even if written directly", async () => {
    await assert.rejects(prisma.adminUser.create({ data: { email: "raw@example.test", passwordHash: "hunter2", passwordUpdatedAt: new Date() } }), /AdminUser_password_hash_scrypt/);
  });

  it("disabling revokes sessions and blocks sign-in; re-provisioning does not re-enable", async () => {
    await provision();
    const token = await signedIn();
    assert.equal((await setAdminEnabled("owner@example.test", false)).revokedSessions, 1);
    assert.equal(await resolveAdminSession(token), null);
    assert.equal((await signInAdmin("owner@example.test", PASSWORD)).ok, false);
    assert.equal((await provision()).disabled, true);
    assert.equal((await signInAdmin("owner@example.test", PASSWORD)).ok, false);
    await setAdminEnabled("owner@example.test", true);
    assert.equal((await signInAdmin("owner@example.test", PASSWORD)).ok, true);
  });

  it("a disabled admin's still-unrevoked session is rejected on every request", async () => {
    await provision();
    const token = await signedIn();
    // Disable without revoking, so only the disabledAt check can block it.
    await prisma.adminUser.update({ where: { email: "owner@example.test" }, data: { disabledAt: new Date() } });
    assert.equal(await prisma.adminSession.count({ where: { revokedAt: null } }), 1);
    assert.equal(await resolveAdminSession(token), null);
  });
});

describe("admin sign-in and sessions", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("signs in case-insensitively and stores only the token's SHA-256 with an 8-hour expiry", async () => {
    await provision();
    const result = await signInAdmin("  OWNER@example.TEST ", PASSWORD);
    assert.equal(result.ok, true);
    const { token, expiresAt } = result as { token: string; expiresAt: Date };
    const session = await prisma.adminSession.findUniqueOrThrow({ where: { tokenHash: hashAdminSessionToken(token) } });
    assert.equal(session.expiresAt.getTime() - session.createdAt.getTime(), ADMIN_SESSION_TTL_MS);
    assert.deepEqual(session.expiresAt, expiresAt);
    assert.equal(JSON.stringify(await prisma.adminSession.findMany()).includes(token), false);
    const access = await resolveAdminSession(token);
    assert.ok(access);
    assertAdminAccess(access);
    assert.equal(access.email, "owner@example.test");
  });

  it("fails identically for unknown emails, wrong passwords, unprovisioned and malformed input, creating no session", async () => {
    await provision();
    await prisma.adminUser.create({ data: { email: "nopassword@example.test" } });
    for (const [email, password] of [["owner@example.test", "wrong-password-123"], ["nobody@example.test", PASSWORD], ["nopassword@example.test", PASSWORD], ["not-an-email", PASSWORD], ["owner@example.test", ""], [42, PASSWORD]] as const) {
      assert.deepEqual(await signInAdmin(email, password), { ok: false }, String(email));
    }
    assert.equal(await prisma.adminSession.count(), 0);
  });

  it("rejects expired, revoked, unknown and malformed session tokens", async () => {
    await provision();
    const expired = await signedIn();
    const past = new Date(Date.now() - 2 * ADMIN_SESSION_TTL_MS);
    await prisma.adminSession.update({ where: { tokenHash: hashAdminSessionToken(expired) }, data: { createdAt: past, expiresAt: new Date(past.getTime() + ADMIN_SESSION_TTL_MS) } });
    assert.equal(await resolveAdminSession(expired), null);

    const revoked = await signedIn();
    await revokeAdminSession(revoked);
    await revokeAdminSession(revoked); // idempotent
    assert.equal(await resolveAdminSession(revoked), null);

    for (const token of ["x".repeat(43), "short", null, 7]) assert.equal(await resolveAdminSession(token), null);
    assert.throws(() => assertAdminAccess({ adminUserId: "x", email: "x", sessionId: "x", expiresAt: new Date() }), /Admin authorization required/);
  });
});

describe("admin login / logout over HTTP with real rate limits", { skip: integrationSkip }, () => {
  useCleanTestDatabase();
  const ORIGIN = "https://book.example.test";
  const api = createAdminAuthApi({ ...defaultAdminAuthApiDeps, env: () => ({ APP_BASE_URL: ORIGIN, RATE_LIMIT_SECRET: "r".repeat(40), TRUSTED_CLIENT_IP_SOURCE: "none", NODE_ENV: "test" }), log: () => {} });
  const post = (path: "login" | "logout", body: unknown, cookie?: string) =>
    api[path](new Request(`${ORIGIN}/api/admin/${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie: `${ADMIN_COOKIE_NAME}=${cookie}` } : {}) }, body: JSON.stringify(body) }));
  const tokenOf = (response: Response) => /^__Host-yasmin_admin=([A-Za-z0-9_-]{43});/.exec(response.headers.get("set-cookie") ?? "")?.[1];

  it("issues a working session cookie, and logout revokes it", async () => {
    await provision();
    const login = await post("login", { email: "owner@example.test", password: PASSWORD });
    assert.equal(login.status, 200);
    const token = tokenOf(login);
    assert.ok(token && await resolveAdminSession(token));
    const logout = await post("logout", {}, token);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(await resolveAdminSession(token!), null);
  });

  it("ends the browser's previous session when it signs in again", async () => {
    await provision();
    const first = tokenOf(await post("login", { email: "owner@example.test", password: PASSWORD }))!;
    const second = tokenOf(await post("login", { email: "owner@example.test", password: PASSWORD }, first))!;
    assert.equal(await resolveAdminSession(first), null);
    assert.ok(await resolveAdminSession(second));
  });

  it("locks an email after 5 attempts in 15 minutes, even with the right password", async () => {
    await provision();
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await post("login", { email: "owner@example.test", password: "wrong-password-123" })).status, 401);
    const blocked = await post("login", { email: "OWNER@example.test", password: PASSWORD });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal(await prisma.adminSession.count(), 0);
  });
});
