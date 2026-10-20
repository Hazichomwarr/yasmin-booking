import { spawn } from "node:child_process";
import path from "node:path";

import {
  assertCurrentLocalDevelopmentEnvironment,
  loadLocalDevelopmentEnvironment,
  localDevelopmentTarget,
} from "../lib/local-development";

// Load Next's normal development environment precedence before verifying it.
// Do not start Next if a shell variable or an env file would target Neon,
// production, or the integration database.
loadLocalDevelopmentEnvironment();
assertCurrentLocalDevelopmentEnvironment();

const nextCli = path.resolve(process.cwd(), "node_modules/next/dist/bin/next");
const child = spawn(process.execPath, [nextCli, "dev", "-p", "3000"], {
  env: process.env,
  stdio: "inherit",
});

console.info(`Local development database verified: ${localDevelopmentTarget}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
