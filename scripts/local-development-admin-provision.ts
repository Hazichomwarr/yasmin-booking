import { spawn } from "node:child_process";
import path from "node:path";

import {
  assertCurrentLocalDevelopmentEnvironment,
  loadLocalDevelopmentEnvironment,
  localDevelopmentTarget,
} from "../lib/local-development";

// The normal provisioning script has a deliberate target-confirmation step.
// This wrapper adds a stricter local-development boundary before it can import
// Prisma or prompt for a password.
loadLocalDevelopmentEnvironment();
assertCurrentLocalDevelopmentEnvironment();

const tsxCli = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const provisioningScript = path.resolve(process.cwd(), "scripts/admin-provision.ts");
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const child = spawn(process.execPath, [tsxCli, provisioningScript, ...args], {
  env: process.env,
  stdio: "inherit",
});

console.info(`Local development database verified: ${localDevelopmentTarget}`);

child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
