import { spawnSync } from "node:child_process";

import { resolveTestDatabase } from "./test-database";

/**
 * Applies the committed Prisma migrations to the TEST database only
 * (`prisma migrate deploy` — never db push, never reset).
 */

const resolution = resolveTestDatabase();
if (resolution.status !== "ready") {
  console.error(resolution.reason);
  process.exit(1);
}

const result = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: resolution.url,
    DIRECT_URL: resolution.url,
  },
});

process.exit(result.status ?? 1);
