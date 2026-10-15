import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import type { RateLimitRule } from "@/lib/http/config";
import {
  RateLimitStoreError,
  consumeRateLimits,
  purgeExpiredRateLimitCounters,
  rateLimitKey,
} from "@/lib/http/rate-limit";
import { prisma } from "@/lib/prisma";

import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const SECRET = "r".repeat(40);
const TEN_MINUTES = 10 * 60_000;
const rule = (limit: number, scope = "test.ip.10m", windowMs = TEN_MINUTES): RateLimitRule => ({ scope, limit, windowMs });
/** A fixed instant 4 minutes into a 10-minute window. */
const WINDOW_START = Date.UTC(2027, 2, 1, 15, 0, 0);
const NOW = WINDOW_START + 4 * 60_000;

const consume = (checks: Parameters<typeof consumeRateLimits>[0], nowMs = NOW) => consumeRateLimits(checks, { secret: SECRET, nowMs });

describe("shared rate limiting", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("allows exactly N attempts and rejects N+1 with the window's remaining time", async () => {
    const check = [{ rule: rule(5), identity: "203.0.113.7" }];
    for (let i = 1; i <= 5; i++) assert.deepEqual(await consume(check), { allowed: true }, `attempt ${i}`);
    assert.deepEqual(await consume(check), { allowed: false, retryAfterSeconds: 360, scope: "test.ip.10m" });
    // Rejected attempts still count.
    const [row] = await prisma.rateLimitCounter.findMany();
    assert.equal(row.count, 6);
  });

  it("rounds Retry-After up and never below one second", async () => {
    const check = [{ rule: rule(1), identity: "x" }];
    await consume(check, WINDOW_START + TEN_MINUTES - 1500);
    assert.deepEqual(await consume(check, WINDOW_START + TEN_MINUTES - 1500), { allowed: false, retryAfterSeconds: 2, scope: "test.ip.10m" });
    assert.deepEqual(await consume(check, WINDOW_START + TEN_MINUTES - 1), { allowed: false, retryAfterSeconds: 1, scope: "test.ip.10m" });
  });

  it("starts a fresh count in the next window", async () => {
    const check = [{ rule: rule(1), identity: "x" }];
    await consume(check);
    assert.equal((await consume(check)).allowed, false);
    assert.equal((await consume(check, WINDOW_START + TEN_MINUTES)).allowed, true);
  });

  it("keeps identities and scopes independent, and reports the longest exceeded wait", async () => {
    const shortRule = rule(1, "test.ip.10m");
    const dayRule = rule(1, "test.ip.1d", 24 * 3600_000);
    assert.equal((await consume([{ rule: shortRule, identity: "a" }])).allowed, true);
    assert.equal((await consume([{ rule: shortRule, identity: "b" }])).allowed, true);
    assert.equal((await consume([{ rule: dayRule, identity: "a" }])).allowed, true);

    const both = await consume([{ rule: shortRule, identity: "a" }, { rule: dayRule, identity: "a" }]);
    assert.equal(both.allowed, false);
    assert.ok(!both.allowed && both.scope === "test.ip.1d" && both.retryAfterSeconds > 360);
  });

  it("stores only HMAC digests, never the raw identity", async () => {
    const identities = ["203.0.113.7", "customer@example.test", "15550100100", "A".repeat(43)];
    for (const identity of identities) await consume([{ rule: rule(10), identity }]);

    const rows = await prisma.rateLimitCounter.findMany();
    assert.equal(rows.length, identities.length);
    const dump = JSON.stringify(rows);
    for (const identity of identities) {
      assert.ok(!dump.includes(identity), identity);
      assert.ok(rows.some((r) => r.keyHash === rateLimitKey(SECRET, "test.ip.10m", identity)));
    }
    for (const row of rows) {
      assert.match(row.keyHash, /^[0-9a-f]{64}$/);
      assert.deepEqual(row.windowStart, new Date(WINDOW_START));
      assert.deepEqual(row.expiresAt, new Date(WINDOW_START + TEN_MINUTES));
    }
    await assert.rejects(
      prisma.rateLimitCounter.create({ data: { scope: "test.ip.10m", keyHash: "203.0.113.7", windowStart: new Date(0), count: 1, expiresAt: new Date(1) } }),
      /RateLimitCounter_key_hmac_sha256/,
    );
  });

  it("loses no update across 60 simultaneous requests on independent connections", async () => {
    const clients = Array.from({ length: 6 }, () => new PrismaClient());
    try {
      await Promise.all(clients.map((client) => client.$connect()));
      const backends = await Promise.all(clients.map((client) => client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`));
      assert.equal(new Set(backends.map(([row]) => row.pid)).size, clients.length, "distinct connections");

      const check = [{ rule: rule(25), identity: "203.0.113.9" }];
      const decisions = await Promise.all(
        Array.from({ length: 60 }, (_, i) => consumeRateLimits(check, { secret: SECRET, nowMs: NOW, db: clients[i % clients.length] })),
      );
      assert.equal(decisions.filter((d) => d.allowed).length, 25);
      assert.equal(decisions.filter((d) => !d.allowed).length, 35);
      const [row] = await prisma.rateLimitCounter.findMany();
      assert.equal(row.count, 60);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it("does not deadlock when concurrent requests touch the same counters in different orders", async () => {
    const a = rule(1000, "test.a.10m");
    const b = rule(1000, "test.b.10m");
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        consume(i % 2 ? [{ rule: a, identity: "x" }, { rule: b, identity: "x" }] : [{ rule: b, identity: "x" }, { rule: a, identity: "x" }]),
      ),
    );
    assert.deepEqual((await prisma.rateLimitCounter.findMany()).map((r) => r.count), [40, 40]);
  });

  it("purges expired counters on every consumption and via the scheduled purge", async () => {
    const expired = Array.from({ length: 150 }, (_, i) => ({
      scope: "test.old.10m",
      keyHash: rateLimitKey(SECRET, "test.old.10m", `old-${i}`),
      windowStart: new Date(WINDOW_START - 2 * TEN_MINUTES),
      count: 1,
      expiresAt: new Date(WINDOW_START - TEN_MINUTES),
    }));
    await prisma.rateLimitCounter.createMany({ data: expired });

    await consume([{ rule: rule(10), identity: "live" }]);
    assert.equal(await prisma.rateLimitCounter.count({ where: { scope: "test.old.10m" } }), 50, "one batch of 100 purged");
    await consume([{ rule: rule(10), identity: "live" }]);
    assert.equal(await prisma.rateLimitCounter.count({ where: { scope: "test.old.10m" } }), 0);

    // The scheduled purge uses the database clock: rows that expired in the real past go,
    // the counter whose window ends in 2027 stays.
    const longExpired = expired.slice(0, 3).map((row) => ({ ...row, windowStart: new Date("2020-01-01T00:00:00Z"), expiresAt: new Date("2020-01-01T00:10:00Z") }));
    await prisma.rateLimitCounter.createMany({ data: longExpired });
    assert.equal(await purgeExpiredRateLimitCounters(), 3);
    assert.equal(await prisma.rateLimitCounter.count({ where: { scope: "test.ip.10m" } }), 1);
  });

  it("uses the database clock when no instant is injected", async () => {
    const decision = await consumeRateLimits([{ rule: rule(1), identity: "clock" }], { secret: SECRET });
    assert.equal(decision.allowed, true);
    const [row] = await prisma.rateLimitCounter.findMany();
    assert.ok(Math.abs(row.windowStart.getTime() + TEN_MINUTES / 2 - Date.now()) <= TEN_MINUTES);
  });

  it("raises RateLimitStoreError when the store is unreachable", async () => {
    const broken = new PrismaClient({ datasourceUrl: "postgresql://nobody@127.0.0.1:1/rate_limit_test_unreachable" });
    try {
      await assert.rejects(
        consumeRateLimits([{ rule: rule(5), identity: "x" }], { secret: SECRET, db: broken }),
        (error) => error instanceof RateLimitStoreError && !/127\.0\.0\.1|nobody/.test(error.message),
      );
    } finally {
      await broken.$disconnect();
    }
  });
});
