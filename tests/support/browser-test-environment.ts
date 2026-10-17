import { resolveBrowserTestDatabase } from "./test-database";

/**
 * Sets the effective Prisma URLs only after the loopback-only target guard
 * accepts TEST_DATABASE_URL. Call this before dynamically importing Prisma.
 */
export function prepareBrowserTestEnvironment(): string {
  const resolution = resolveBrowserTestDatabase();
  if (resolution.status !== "ready") {
    throw new Error(`Refusing browser acceptance: ${resolution.reason}`);
  }

  process.env.DATABASE_URL = resolution.url;
  process.env.DIRECT_URL = resolution.url;
  return resolution.url;
}
