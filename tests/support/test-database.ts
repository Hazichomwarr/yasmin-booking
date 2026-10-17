import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Safety gate for database-backed tests.
 *
 * Integration tests TRUNCATE catalog/appointment tables, so they must never
 * run against the development (Neon) database configured in .env.
 *
 * A test database is accepted only when:
 * - TEST_DATABASE_URL is set explicitly,
 * - its database name contains "test", and
 * - it does not point at the same host/port/database as DATABASE_URL or
 *   DIRECT_URL from .env (or the shell environment).
 *
 * URLs are never printed.
 */

export type TestDatabaseResolution =
  | { status: "ready"; url: string }
  | { status: "not-configured"; reason: string };

/** The only database that browser-acceptance helpers may mutate. */
export const BROWSER_TEST_DATABASE = "yasmin_booking_test";

export function resolveTestDatabase(): TestDatabaseResolution {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    return {
      status: "not-configured",
      reason:
        "TEST_DATABASE_URL is not set; database-backed tests are skipped. See tests/README.md.",
    };
  }

  const target = parseDatabaseUrl(url, "TEST_DATABASE_URL");
  if (!target.database.toLowerCase().includes("test")) {
    throw new Error(
      'Refusing to run: the TEST_DATABASE_URL database name must contain "test".',
    );
  }

  for (const [name, configured] of configuredApplicationUrls()) {
    const other = parseDatabaseUrl(configured, name);
    if (
      other.host === target.host &&
      other.port === target.port &&
      other.database === target.database
    ) {
      throw new Error(
        `Refusing to run: TEST_DATABASE_URL points at the same database as ${name}.`,
      );
    }
  }

  return { status: "ready", url };
}

/**
 * A deliberately narrower gate for browser fixtures and the browser dev
 * server. Unlike the general integration suite, browser acceptance has one
 * named, loopback-only target. This runs before those helpers import Prisma.
 */
export function resolveBrowserTestDatabase(): TestDatabaseResolution {
  const resolution = resolveTestDatabase();
  if (resolution.status !== "ready") return resolution;
  assertBrowserTestDatabaseTarget(resolution.url);
  return resolution;
}

/** Pure target check, kept exportable so it can be tested without a database connection. */
export function assertBrowserTestDatabaseTarget(url: string): void {
  const target = parseDatabaseUrl(url, "TEST_DATABASE_URL");
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (target.host.endsWith(".neon.tech")) {
    throw new Error("Refusing browser acceptance: Neon database hosts are never allowed.");
  }
  if (!loopbackHosts.has(target.host)) {
    throw new Error("Refusing browser acceptance: the database host must be local loopback.");
  }
  if (target.database !== BROWSER_TEST_DATABASE) {
    throw new Error(`Refusing browser acceptance: database must be ${BROWSER_TEST_DATABASE}.`);
  }
}

function configuredApplicationUrls(): [string, string][] {
  const envFile = path.resolve(process.cwd(), ".env");
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};

  const urls: [string, string][] = [];
  for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
    for (const value of [fromFile[name], process.env[name]]) {
      if (value) urls.push([name, value]);
    }
  }
  return urls;
}

function parseDatabaseUrl(value: string, name: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid database URL.`);
  }
  return {
    host: url.hostname.toLowerCase(),
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
}
