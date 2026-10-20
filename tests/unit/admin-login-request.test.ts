import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { requestAdminLogin } from "@/components/admin/login-request";

describe("admin login request", () => {
  it("recognizes a successful authenticated response", async () => {
    const result = await requestAdminLogin(
      { email: "owner@example.test", password: "Velvet-Comb-2026!" },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    assert.deepEqual(result, { ok: true });
  });

  it("returns a usable error for server and network failures", async () => {
    const rejected = await requestAdminLogin(
      { email: "owner@example.test", password: "wrong" },
      async () => new Response(JSON.stringify({ error: { message: "The email or password is incorrect." } }), { status: 401 }),
    );
    assert.deepEqual(rejected, { ok: false, message: "The email or password is incorrect." });

    const unavailable = await requestAdminLogin(
      { email: "owner@example.test", password: "wrong" },
      async () => { throw new Error("offline"); },
    );
    assert.deepEqual(unavailable, { ok: false, message: "We could not reach the server. Check your connection and try again." });
  });
});
