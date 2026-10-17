import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertBrowserTestDatabaseTarget, BROWSER_TEST_DATABASE } from "@/tests/support/test-database";
import { prepareBrowserTestEnvironment } from "@/tests/support/browser-test-environment";

describe("browser acceptance database target guard", () => {
  it("accepts only the named loopback test database", () => {
    assert.doesNotThrow(() =>
      assertBrowserTestDatabaseTarget(`postgresql://local-user@127.0.0.1:5432/${BROWSER_TEST_DATABASE}`),
    );
  });

  it("rejects development and production Neon URLs without connecting", () => {
    for (const host of [
      "ep-development-pooler.c-7.us-east-2.aws.neon.tech",
      "ep-production.c-7.us-east-2.aws.neon.tech",
    ]) {
      assert.throws(
        () => assertBrowserTestDatabaseTarget(`postgresql://local-user@${host}:5432/neondb`),
        /Neon database hosts are never allowed/,
      );
    }
  });

  it("rejects an unknown host, a missing database name, and a wrong local database", () => {
    assert.throws(
      () => assertBrowserTestDatabaseTarget(`postgresql://local-user@db.internal:5432/${BROWSER_TEST_DATABASE}`),
      /host must be local loopback/,
    );
    assert.throws(
      () => assertBrowserTestDatabaseTarget("postgresql://local-user@127.0.0.1:5432/"),
      /database must be yasmin_booking_test/,
    );
    assert.throws(
      () => assertBrowserTestDatabaseTarget("postgresql://local-user@localhost:5432/yasmin_booking_dev"),
      /database must be yasmin_booking_test/,
    );
  });

  it("refuses missing TEST_DATABASE_URL before it can configure Prisma", () => {
    const previous = process.env.TEST_DATABASE_URL;
    try {
      delete process.env.TEST_DATABASE_URL;
      assert.throws(prepareBrowserTestEnvironment, /TEST_DATABASE_URL is not set/);
    } finally {
      if (previous === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previous;
    }
  });
});
