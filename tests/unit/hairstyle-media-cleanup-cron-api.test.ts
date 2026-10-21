import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as route from "@/app/api/cron/hairstyle-media-cleanup/route";
import { createHairstyleMediaCleanupCronApi } from "@/lib/media/hairstyle-media-cleanup-cron-api";

const SECRET = "m".repeat(48);

describe("hairstyle media cleanup worker endpoint", () => {
  it("is GET-only, is scheduled daily alongside email delivery, and rejects unauthenticated callers", async () => {
    assert.equal(typeof route.GET, "function");
    assert.equal("POST" in route, false);
    assert.equal(route.maxDuration, 60);
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    assert.deepEqual(config.crons, [
      { path: "/api/cron/confirmation-emails", schedule: "0 14 * * *" },
      { path: "/api/cron/hairstyle-media-cleanup", schedule: "20 5 * * *" },
    ]);
    let calls = 0;
    const logs: unknown[] = [];
    const get = createHairstyleMediaCleanupCronApi({
      env: () => ({ CRON_SECRET: SECRET }),
      run: async () => {
        calls += 1;
        return { processed: 0, completed: 0, failed: 0, exhausted: 0, skipped: 0 };
      },
      log: (entry) => logs.push(entry),
    });
    assert.equal((await get(new Request("https://admin.example/cron"))).status, 401);
    assert.equal(calls, 0);
    const allowed = await get(new Request("https://admin.example/cron", { headers: { authorization: `Bearer ${SECRET}` } }));
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { processed: 0, completed: 0, failed: 0, exhausted: 0, skipped: 0 });
    assert.equal(calls, 1);
    assert.deepEqual(logs, [
      { outcome: "unauthorized" },
      { outcome: "ran", summary: { processed: 0, completed: 0, failed: 0, exhausted: 0, skipped: 0 } },
    ]);
  });
});
