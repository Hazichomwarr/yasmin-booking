import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertSafeLocalDevelopmentEnvironment } from "@/lib/local-development";

const safe = {
  DATABASE_URL: "postgresql://developer@127.0.0.1:5432/yasmin_booking_dev",
  DIRECT_URL: "postgresql://developer@127.0.0.1:5432/yasmin_booking_dev",
  APP_BASE_URL: "http://localhost:3000",
};

describe("local development environment guard", () => {
  it("accepts only the dedicated loopback development database", () => {
    assert.doesNotThrow(() => assertSafeLocalDevelopmentEnvironment(safe));
  });

  it("rejects Neon, integration, missing, and unexpected local targets", () => {
    for (const env of [
      { ...safe, DATABASE_URL: "postgresql://developer@ep-example.neon.tech/neondb" },
      { ...safe, DIRECT_URL: "postgresql://developer@127.0.0.1:5432/yasmin_booking_test" },
      { ...safe, DATABASE_URL: undefined },
      { ...safe, APP_BASE_URL: "http://127.0.0.1:3000" },
    ]) {
      assert.throws(() => assertSafeLocalDevelopmentEnvironment(env));
    }
  });
});
