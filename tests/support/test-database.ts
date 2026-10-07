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
