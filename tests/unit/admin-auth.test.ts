import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAdminAppointmentFilters } from "@/lib/admin/appointments";
import { adminPaymentView, depositStateOf, type DepositFacts } from "@/lib/admin/deposit-state";
import { adminPasswordProblem, hashAdminPassword, verifyAdminPassword, verifyAgainstDecoy } from "@/lib/admin/password";
import { ADMIN_COOKIE_NAME, adminSessionCookie, clearedAdminSessionCookie, readAdminSessionCookie } from "@/lib/admin/session-cookie";
import { createAdminAuthApi, loadAdminConfig, type AdminAuthLogEntry } from "@/lib/http/admin-auth-api";

const FAST = { N: 2 ** 14, r: 8, p: 1 };

describe("admin password hashing (scrypt)", () => {
  it("stores a self-describing hash, never the password, with a fresh salt each time", async () => {
    const [a, b] = await Promise.all([hashAdminPassword("correct horse battery", FAST), hashAdminPassword("correct horse battery", FAST)]);
    assert.match(a, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
    assert.equal(a.includes("correct"), false);
  });

  it("verifies only the right password", async () => {
    const stored = await hashAdminPassword("correct horse battery", FAST);
    assert.equal(await verifyAdminPassword("correct horse battery", stored), true);
    assert.equal(await verifyAdminPassword("correct horse batterY", stored), false);
    assert.equal(await verifyAdminPassword("", stored), false);
  });

  it("uses the production cost by default", async () => {
    assert.match(await hashAdminPassword("a long enough password!"), /^scrypt\$131072\$8\$1\$/);
  });

  it("rejects malformed and out-of-bounds stored hashes without throwing", async () => {
    const valid = await hashAdminPassword("correct horse battery", FAST);
    const [, , , , salt, key] = valid.split("$");
    for (const stored of [null, "", "plaintext", `scrypt$1024$8$1$${salt}$${key}`, `scrypt$${2 ** 21}$8$1$${salt}$${key}`, `scrypt$20000$8$1$${salt}$${key}`, `scrypt$16384$99$1$${salt}$${key}`, `bcrypt$16384$8$1$${salt}$${key}`]) {
      assert.equal(await verifyAdminPassword("correct horse battery", stored), false, String(stored));
    }
    await assert.rejects(hashAdminPassword("x".repeat(20), { N: 1024, r: 8, p: 1 }));
  });

  it("spends a real verification for unknown accounts and always answers false", async () => {
    assert.equal(await verifyAgainstDecoy("anything at all"), false);
  });

  it("enforces a minimal password policy for provisioning", () => {
    assert.equal(adminPasswordProblem("short", "owner@example.test") !== null, true);
    assert.equal(adminPasswordProblem("aaaaaaaaaaaaaa", "owner@example.test") !== null, true);
    assert.equal(adminPasswordProblem(" padded password ", "owner@example.test") !== null, true);
    assert.equal(adminPasswordProblem("owner-is-my-password", "owner@example.test") !== null, true);
    assert.equal(adminPasswordProblem("Velvet-Comb-2026!", "owner@example.test"), null);
  });
});

describe("admin session cookie", () => {
  it("is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/, with the remaining lifetime", () => {
    const now = new Date("2027-01-01T00:00:00Z");
    const cookie = adminSessionCookie("t".repeat(43), new Date(now.getTime() + 8 * 3_600_000), now);
    assert.match(cookie, new RegExp(`^${ADMIN_COOKIE_NAME}=t{43}; Max-Age=28800; Expires=.+; Path=/; Secure; HttpOnly; SameSite=Strict$`));
    assert.match(clearedAdminSessionCookie(), new RegExp(`^${ADMIN_COOKIE_NAME}=; Max-Age=0;`));
  });

  it("reads exactly one value and refuses ambiguity", () => {
    const headers = (cookie?: string) => new Headers(cookie ? { cookie } : {});
    assert.equal(readAdminSessionCookie(headers()), null);
    assert.equal(readAdminSessionCookie(headers(`a=1; ${ADMIN_COOKIE_NAME}=abc`)), "abc");
    assert.equal(readAdminSessionCookie(headers(`${ADMIN_COOKIE_NAME}=a; ${ADMIN_COOKIE_NAME}=b`)), null);
  });
});

describe("admin configuration", () => {
  const base = { APP_BASE_URL: "https://book.example.test", RATE_LIMIT_SECRET: "s".repeat(40), TRUSTED_CLIENT_IP_SOURCE: "vercel", VERCEL: "1", NODE_ENV: "production" };
  it("accepts a complete production configuration, independent of Stripe and the booking flag", () => {
    assert.deepEqual(loadAdminConfig(base), { appOrigin: "https://book.example.test", rateLimitSecret: "s".repeat(40), clientIpSource: "vercel" });
  });
  it("fails closed on missing or unsafe values", () => {
    for (const patch of [{ APP_BASE_URL: undefined }, { APP_BASE_URL: "http://book.example.test" }, { RATE_LIMIT_SECRET: "short" }, { TRUSTED_CLIENT_IP_SOURCE: "none" }, { VERCEL: undefined }]) {
      assert.equal(loadAdminConfig({ ...base, ...patch }), null, JSON.stringify(patch));
    }
    assert.notEqual(loadAdminConfig({ APP_BASE_URL: "http://localhost:3000", RATE_LIMIT_SECRET: "s".repeat(40), TRUSTED_CLIENT_IP_SOURCE: "none", NODE_ENV: "development" }), null);
  });
});

describe("admin payment interpretation", () => {
  const appointment = { status: "PENDING_PAYMENT" as const, holdExpiresAt: new Date("2027-01-01T00:30:00Z"), totalPriceCents: 20_000, balanceDueCents: 16_000 };
  const now = new Date("2027-01-01T00:00:00Z");
  const payment = (patch: Partial<NonNullable<DepositFacts>>): DepositFacts => ({ status: "PENDING", hasCheckoutSession: true, paidAt: null, allocatedAt: null, refundedAmountCents: 0, reconciliationReason: null, ...patch });

  it("never treats an initiated Checkout as payment", () => {
    for (const facts of [payment({}), payment({ hasCheckoutSession: false })]) {
      const view = adminPaymentView(appointment, facts, false, now);
      assert.equal(view.depositPaid, false);
      assert.equal(view.remainingCents, 20_000);
    }
    assert.equal(depositStateOf(payment({})), "checkout-started");
    assert.equal(depositStateOf(payment({ hasCheckoutSession: false })), "checkout-uncertain");
  });

  it("maps every stored state", () => {
    assert.equal(depositStateOf(null), "not-started");
    assert.equal(depositStateOf(payment({ status: "EXPIRED" })), "checkout-ended");
    assert.equal(depositStateOf(payment({ status: "FAILED" })), "checkout-ended");
    assert.equal(depositStateOf(payment({ status: "PAID", paidAt: now, allocatedAt: now })), "paid");
    assert.equal(depositStateOf(payment({ status: "PAID", paidAt: now, reconciliationReason: "PLACE_UNAVAILABLE" })), "received-unallocated");
    assert.equal(depositStateOf(payment({ status: "REFUNDED", paidAt: now, allocatedAt: now, refundedAmountCents: 4_000 })), "refunded");
  });

  it("collects only the balance after an allocated deposit and flags what needs a person", () => {
    const paid = adminPaymentView({ ...appointment, status: "CONFIRMED" }, payment({ status: "PAID", paidAt: now, allocatedAt: now }), false, now);
    assert.deepEqual([paid.depositPaid, paid.remainingCents, paid.needsAttention, paid.bookingState], [true, 16_000, false, "confirmed"]);
    const unallocated = adminPaymentView({ ...appointment, status: "CANCELLED" }, payment({ status: "PAID", paidAt: now, reconciliationReason: "APPOINTMENT_NOT_PAYABLE" }), false, now);
    assert.deepEqual([unallocated.depositPaid, unallocated.needsAttention, unallocated.reconciliationReason], [false, true, "APPOINTMENT_NOT_PAYABLE"]);
    assert.equal(adminPaymentView(appointment, null, true, now).needsAttention, true);
  });
});

describe("admin appointment filters", () => {
  it("accepts valid values and ignores everything else", () => {
    assert.deepEqual(parseAdminAppointmentFilters({ date: "2027-03-08", status: "CONFIRMED", q: "  Amina ", page: "2" }), { date: "2027-03-08", status: "CONFIRMED", q: "Amina", range: null, page: 2 });
    assert.deepEqual(parseAdminAppointmentFilters({ date: "2027-02-30", status: "PAID", q: "", page: "-1" }), { date: null, status: null, q: null, range: null, page: 1 });
    assert.deepEqual(parseAdminAppointmentFilters({ date: ["2027-03-08"], page: "1e3" }), { date: null, status: null, q: null, range: null, page: 1 });
    assert.equal(parseAdminAppointmentFilters({ range: "upcoming" }).range, "upcoming");
    assert.equal(parseAdminAppointmentFilters({ range: "everything" }).range, null);
    assert.equal(parseAdminAppointmentFilters({ q: "x".repeat(300) }).q?.length, 100);
  });
});

describe("admin login / logout HTTP boundary", () => {
  const ORIGIN = "https://book.example.test";
  const env = { APP_BASE_URL: ORIGIN, RATE_LIMIT_SECRET: "s".repeat(40), TRUSTED_CLIENT_IP_SOURCE: "none", NODE_ENV: "test" };
  function api(options: { allowed?: boolean; signIn?: (email: unknown, password: unknown) => Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false }> } = {}) {
    const logs: AdminAuthLogEntry[] = [];
    const revoked: unknown[] = [];
    const scopes: string[] = [];
    const handlers = createAdminAuthApi({
      env: () => env,
      signIn: options.signIn ?? (async (_email, password) => (password === "right password!!" ? { ok: true, token: "k".repeat(43), expiresAt: new Date(Date.now() + 3_600_000) } : { ok: false })),
      revoke: async (token) => { revoked.push(token); },
      consumeRateLimits: async (checks) => { scopes.push(...checks.map((check) => check.rule.scope)); return options.allowed === false ? { allowed: false, retryAfterSeconds: 60, scope: checks[0].rule.scope } : { allowed: true }; },
      log: (entry) => logs.push(entry),
    });
    const send = (path: "login" | "logout", body: unknown, headers: Record<string, string> = {}) =>
      handlers[path](new Request(`${ORIGIN}/api/admin/${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));
    return { send, logs, revoked, scopes };
  }

  it("signs in with a session cookie and counts IP and email attempts", async () => {
    const h = api();
    const response = await h.send("login", { email: "Owner@Example.test", password: "right password!!" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`^${ADMIN_COOKIE_NAME}=k{43};.*HttpOnly; SameSite=Strict$`));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(h.scopes, ["admin.login.ip.15m", "admin.login.email.15m"]);
  });

  it("answers every credential failure with the same body and no cookie", async () => {
    const h = api();
    const bodies = [];
    for (const credentials of [{ email: "owner@example.test", password: "wrong" }, { email: "nobody@example.test", password: "right password!!x" }]) {
      const response = await h.send("login", credentials);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), null);
      bodies.push(await response.text());
    }
    assert.equal(bodies[0], bodies[1]);
    assert.equal(JSON.parse(bodies[0]).error.code, "INVALID_CREDENTIALS");
    assert.ok(!JSON.stringify(h.logs).includes("owner@") && !JSON.stringify(h.logs).includes("wrong"));
  });

  it("rejects foreign origins, non-JSON, extra fields and oversize bodies before checking credentials", async () => {
    let called = 0;
    const h = api({ signIn: async () => { called += 1; return { ok: false }; } });
    assert.equal((await h.send("login", { email: "a@b.test", password: "x" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await h.send("login", "email=a", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await h.send("login", { email: "a@b.test", password: "x", role: "owner" })).status, 400);
    assert.equal((await h.send("login", { email: "a@b.test", password: "x".repeat(3_000) })).status, 413);
    assert.equal(called, 0);
  });

  it("rate limits with Retry-After before checking credentials", async () => {
    let called = 0;
    const h = api({ allowed: false, signIn: async () => { called += 1; return { ok: false }; } });
    const response = await h.send("login", { email: "a@b.test", password: "x" });
    assert.deepEqual([response.status, response.headers.get("retry-after"), called], [429, "60", 0]);
  });

  it("fails closed when admin configuration is incomplete", async () => {
    const handlers = createAdminAuthApi({ env: () => ({}), signIn: async () => ({ ok: false }), revoke: async () => {}, consumeRateLimits: async () => ({ allowed: true }), log: () => {} });
    const response = await handlers.login(new Request("https://x.test/api/admin/login", { method: "POST", headers: { origin: "https://x.test", "content-type": "application/json" }, body: "{}" }));
    assert.equal(response.status, 503);
  });

  it("logs out by revoking the cookie's session and clearing the cookie, idempotently", async () => {
    const h = api();
    const out = await h.send("logout", {}, { cookie: `${ADMIN_COOKIE_NAME}=${"k".repeat(43)}` });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie") ?? "", new RegExp(`^${ADMIN_COOKIE_NAME}=; Max-Age=0;`));
    assert.deepEqual(h.revoked, ["k".repeat(43)]);
    assert.equal((await h.send("logout", {})).status, 200);
    assert.equal((await h.send("logout", {}, { origin: "https://evil.example" })).status, 403);
  });
});
