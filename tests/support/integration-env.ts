import { resolveTestDatabase } from "./test-database";

/**
 * Preloaded (via --import) before every integration test file, BEFORE the
 * Prisma client is created, so lib/prisma.ts connects to the test database.
 *
 * When no test database is configured, DATABASE_URL is replaced with an
 * unroutable sentinel: if any query slipped past the skip it fails instead of
 * reaching the development database from .env.
 */

const UNREACHABLE_DATABASE_URL =
  "postgresql://catalog-tests-disabled@127.0.0.1:1/catalog_tests_disabled";

const resolution = resolveTestDatabase();

if (resolution.status === "ready") {
  process.env.DATABASE_URL = resolution.url;
  process.env.DIRECT_URL = resolution.url;
  delete process.env.CATALOG_INTEGRATION_SKIP_REASON;
} else {
  process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
  process.env.DIRECT_URL = UNREACHABLE_DATABASE_URL;
  process.env.CATALOG_INTEGRATION_SKIP_REASON = resolution.reason;
}
