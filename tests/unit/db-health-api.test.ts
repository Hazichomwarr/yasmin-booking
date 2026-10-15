import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GET as routeGET } from "@/app/api/internal/db-health/route";
import { createDbHealthApi, type DbHealthLogEntry } from "@/lib/http/db-health-api";

const SECRET = "h".repeat(48);

function harness(options: { env?: Record<string, string | undefined>; ping?: () => Promise<void>; timeoutMs?: number } = {}) {
  let pings = 0;
  const logs: DbHealthLogEntry[] = [];
  const get = createDbHealthApi({
    env: () => options.env ?? { CRON_SECRET: SECRET },
    ping: async () => { pings += 1; await (options.ping ?? (async () => {}))(); },
    timeoutMs: options.timeoutMs,
    log: (entry) => logs.push(entry),
  });
  const call = async (authorization: string | null = `Bearer ${SECRET}`) => {
    const response = await get(new Request("https://book.yasmin.example/api/internal/db-health", { headers: authorization === null ? {} : { authorization } }));
    return { status: response.status, text: await response.text(), cache: response.headers.get("cache-control") };
  };
  return { call, logs, pings: () => pings };
}

describe("temporary db-health route", () => {
  it("rejects missing, malformed and wrong credentials with 401 without touching the database", async () => {
    const h = harness();
    for (const authorization of [null, "", SECRET, `bearer ${SECRET}`, `Bearer ${SECRET.slice(1)}`, `Bearer ${SECRET}x`, `Bearer ${"x".repeat(48)}`]) {
      const result = await h.call(authorization);
      assert.deepEqual([result.status, result.text], [401, '{"status":"unauthorized"}'], String(authorization));
      assert.equal(result.cache, "no-store, private");
    }
    assert.equal(h.pings(), 0);
  });

  it("fails closed when CRON_SECRET is missing, empty or too short, even for a matching header", async () => {
    for (const env of [{}, { CRON_SECRET: "" }, { CRON_SECRET: "short-secret" }] as Record<string, string | undefined>[]) {
      const h = harness({ env });
      assert.equal((await h.call(`Bearer ${env.CRON_SECRET ?? ""}`)).status, 401);
      assert.equal(h.pings(), 0);
    }
  });

  it("returns exactly {status: ok} after one successful probe", async () => {
    const h = harness();
    assert.deepEqual(await h.call(), { status: 200, text: '{"status":"ok"}', cache: "no-store, private" });
    assert.equal(h.pings(), 1);
  });

  it("returns exactly {status: unavailable} on failure, never the error", async () => {
    const leak = "postgresql://neondb_owner:p4ss@ep-secret-host.neon.tech/neondb P1001 stack";
    const h = harness({ ping: async () => { throw new Error(leak); } });
    const result = await h.call();
    assert.deepEqual([result.status, result.text], [503, '{"status":"unavailable"}']);
    assert.equal(result.cache, "no-store, private");
    assert.ok(!JSON.stringify(h.logs).includes("neon"));
  });

  it("returns unavailable when the probe hangs past the timeout", async () => {
    const h = harness({ ping: () => new Promise(() => {}), timeoutMs: 50 });
    assert.deepEqual([(await h.call()).status, h.logs.at(-1)], [503, { status: 503, outcome: "unavailable" }]);
  });

  it("never logs the secret or the authorization header", async () => {
    const h = harness();
    await h.call(`Bearer ${"w".repeat(48)}`);
    await h.call();
    assert.ok(!JSON.stringify(h.logs).includes(SECRET));
    assert.deepEqual(h.logs.map((entry) => entry.outcome), ["unauthorized", "ok"]);
  });

  it("the real route never loads the Prisma client for an unauthorized request", async () => {
    // lib/prisma.ts registers its client on globalThis when it is evaluated outside production.
    const loaded = () => (globalThis as { prisma?: unknown }).prisma !== undefined;
    assert.equal(loaded(), false);
    const previous = process.env.CRON_SECRET;
    try {
      delete process.env.CRON_SECRET;
      assert.equal((await routeGET(new Request("https://book.yasmin.example/api/internal/db-health"))).status, 401);
      process.env.CRON_SECRET = SECRET;
      assert.equal((await routeGET(new Request("https://book.yasmin.example/api/internal/db-health", { headers: { authorization: "Bearer wrong" } }))).status, 401);
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
    assert.equal(loaded(), false);
  });
});
