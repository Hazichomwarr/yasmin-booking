import { spawn } from "node:child_process";
import path from "node:path";

import { prepareBrowserTestEnvironment } from "../tests/support/browser-test-environment";

// Set DATABASE_URL/DIRECT_URL only after the loopback-only guard accepts the
// explicitly supplied TEST_DATABASE_URL. This process never reads .env's
// development connection as the browser server's Prisma target.
prepareBrowserTestEnvironment();

const port = process.env.BROWSER_TEST_PORT ?? "3010";
if (!/^\d{2,5}$/.test(port)) throw new Error("BROWSER_TEST_PORT must be a valid port number.");
process.env.APP_BASE_URL = `http://localhost:${port}`;
process.env.TRUSTED_CLIENT_IP_SOURCE = "none";

const nextCli = path.resolve(process.cwd(), "node_modules/next/dist/bin/next");
async function main() {
  const child = spawn(process.execPath, [nextCli, "dev", "-p", port], {
    env: process.env,
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  process.exitCode = code ?? 1;
}

void main();
