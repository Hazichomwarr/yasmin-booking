import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as route from "@/app/api/cron/hairstyle-media-cleanup/route";
import { createHairstyleMediaCleanupCronApi } from "@/lib/media/hairstyle-media-cleanup-cron-api";

const SECRET = "m".repeat(48);

describe("hairstyle media cleanup worker endpoint", () => {
  it("is GET-only, not production-scheduled, and rejects unauthenticated callers", async () => {
    assert.equal(typeof route.GET, "function");
    assert.equal("POST" in route, false);
    assert.equal(route.maxDuration, 60);
    let calls = 0;
    const get = createHairstyleMediaCleanupCronApi({
      env: () => ({ CRON_SECRET: SECRET }),
      run: async () => { calls += 1; return { completed: 0, failed: 0, exhausted: 0, skipped: 0 }; },
    });
    assert.equal((await get(new Request("https://admin.example/cron"))).status, 401);
    assert.equal(calls, 0);
    const allowed = await get(new Request("https://admin.example/cron", { headers: { authorization: `Bearer ${SECRET}` } }));
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { completed: 0, failed: 0, exhausted: 0, skipped: 0 });
    assert.equal(calls, 1);
  });
});
