import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { GET } from "@/app/api/internal/db-health/route";
import { createDbHealthApi, defaultDbHealthDeps } from "@/lib/http/db-health-api";

import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const SECRET = "d".repeat(48);
const request = (authorization?: string) =>
  new Request("https://book.yasmin.example/api/internal/db-health", { headers: authorization ? { authorization } : {} });

describe("temporary db-health route against PostgreSQL", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("answers ok through the application's Prisma client with valid credentials", async () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
    try {
      const ok = await GET(request(`Bearer ${SECRET}`));
      assert.deepEqual([ok.status, await ok.json()], [200, { status: "ok" }]);
      const denied = await GET(request("Bearer wrong"));
      assert.deepEqual([denied.status, await denied.json()], [401, { status: "unauthorized" }]);
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });

  it("answers unavailable, without details, when the database cannot be reached", async () => {
    const unreachable = new PrismaClient({ datasourceUrl: "postgresql://nobody:secret@127.0.0.1:1/unreachable_test?connect_timeout=2" });
    try {
      const get = createDbHealthApi({
        ...defaultDbHealthDeps,
        env: () => ({ CRON_SECRET: SECRET }),
        ping: async () => { await unreachable.$queryRaw`SELECT 1`; },
        log: () => {},
      });
      const response = await get(request(`Bearer ${SECRET}`));
      const text = await response.text();
      assert.deepEqual([response.status, text], [503, '{"status":"unavailable"}']);
    } finally {
      await unreachable.$disconnect();
    }
  });
});
