import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const LOCAL_DEVELOPMENT_DATABASE = "yasmin_booking_dev";
const LOCAL_DEVELOPMENT_HOST = "127.0.0.1";
const LOCAL_DEVELOPMENT_PORT = "5432";
const LOCAL_APPLICATION_ORIGIN = "http://localhost:3000";

type LocalDevelopmentEnv = {
  DATABASE_URL?: string;
  DIRECT_URL?: string;
  APP_BASE_URL?: string;
};

function assertLocalDatabaseUrl(value: string | undefined, name: "DATABASE_URL" | "DIRECT_URL"): void {
  if (!value) throw new Error(`${name} must be configured for local development.`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`${name} must use a PostgreSQL URL.`);
  }
  if (url.hostname !== LOCAL_DEVELOPMENT_HOST || (url.port || LOCAL_DEVELOPMENT_PORT) !== LOCAL_DEVELOPMENT_PORT) {
    throw new Error(`${name} must target ${LOCAL_DEVELOPMENT_HOST}:${LOCAL_DEVELOPMENT_PORT}.`);
  }
  if (decodeURIComponent(url.pathname).replace(/^\//, "") !== LOCAL_DEVELOPMENT_DATABASE) {
    throw new Error(`${name} must target ${LOCAL_DEVELOPMENT_DATABASE}.`);
  }
}

/**
 * Fail closed before normal local development can create a Prisma client.
 * This intentionally accepts only the dedicated loopback development database
 * and never a remote or integration-test target.
 */
export function assertSafeLocalDevelopmentEnvironment(env: LocalDevelopmentEnv): void {
  assertLocalDatabaseUrl(env.DATABASE_URL, "DATABASE_URL");
  assertLocalDatabaseUrl(env.DIRECT_URL, "DIRECT_URL");
  if (env.APP_BASE_URL !== LOCAL_APPLICATION_ORIGIN) {
    throw new Error(`APP_BASE_URL must be ${LOCAL_APPLICATION_ORIGIN} for local development.`);
  }
}

export function assertCurrentLocalDevelopmentEnvironment(): void {
  assertSafeLocalDevelopmentEnvironment(process.env as LocalDevelopmentEnv);
}

export const localDevelopmentTarget = `${LOCAL_DEVELOPMENT_HOST}:${LOCAL_DEVELOPMENT_PORT}/${LOCAL_DEVELOPMENT_DATABASE}`;

/**
 * Load Next development's env-file precedence for the Node-only wrappers.
 * Explicit shell values still win, then .env.development.local, .env.local,
 * .env.development, and .env. This prevents the wrappers from relying on
 * Prisma's .env-only loader.
 */
export function loadLocalDevelopmentEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const initial = new Set(Object.keys(env));
  for (const file of [".env", ".env.development", ".env.local", ".env.development.local"]) {
    const filePath = path.resolve(process.cwd(), file);
    if (!existsSync(filePath)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(filePath, "utf8")))) {
      if (!initial.has(key)) env[key] = value;
    }
  }
}
