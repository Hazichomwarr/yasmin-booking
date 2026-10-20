/**
 * Administrator provisioning CLI (YASMIN-2A). The only supported way to
 * create an admin or set a password; there is no registration route.
 *
 *   pnpm admin:provision --email owner@example.com --confirm-target <host>:<port>/<database>
 *   pnpm admin:provision --email owner@example.com --disable --confirm-target …
 *   pnpm admin:provision --email owner@example.com --enable  --confirm-target …
 *
 * - The target is DATABASE_URL (process environment first, then .env). It
 *   is printed as "<host>:<port>/<database>" only — never credentials — and
 *   the command refuses to connect unless --confirm-target matches it
 *   exactly. Run without --confirm-target to see the target.
 * - The password is read from a hidden prompt (twice), or from stdin with
 *   --password-stdin. It is never accepted as an argument or variable.
 * - Setting a password revokes the admin's existing sessions.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

function loadDotEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function targetOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "5432"}/${parsed.pathname.replace(/^\//, "")}`;
  } catch {
    return null;
  }
}

async function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error("No terminal for a hidden prompt; use --password-stdin.");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); stdout.write("\n");
          return resolve(value);
        }
        if (char === "\u0003") { stdin.setRawMode(false); stdout.write("\n"); return reject(new Error("Cancelled.")); }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      "confirm-target": { type: "string" },
      "password-stdin": { type: "boolean", default: false },
      disable: { type: "boolean", default: false },
      enable: { type: "boolean", default: false },
    },
    strict: true,
  });
  loadDotEnv();
  const target = targetOf(process.env.DATABASE_URL);
  if (!target) throw new Error("DATABASE_URL is not set or not a URL.");
  if (!values.email) throw new Error("--email is required.");
  if (values.disable && values.enable) throw new Error("Use only one of --disable and --enable.");
  console.log(`Target database: ${target}`);
  if (values["confirm-target"] !== target) {
    console.log(`Nothing changed. To proceed, re-run with --confirm-target ${target}`);
    process.exitCode = 2;
    return;
  }

  // Import only after the target is confirmed, so no client connects before.
  const { provisionAdminPassword, setAdminEnabled } = await import("../lib/admin/provision");
  const { prisma } = await import("../lib/prisma");
  try {
    if (values.disable || values.enable) {
      const result = await setAdminEnabled(values.email, values.enable);
      console.log(`${result.disabled ? "Disabled" : "Enabled"} ${result.email}; revoked ${result.revokedSessions} session(s).`);
      return;
    }
    let password: string;
    if (values["password-stdin"]) {
      password = await readStdin();
    } else {
      password = await readHidden("New admin password: ");
      if ((await readHidden("Repeat password: ")) !== password) throw new Error("The passwords do not match.");
    }
    const result = await provisionAdminPassword({ email: values.email, password });
    console.log(`${result.created ? "Created" : "Updated password for"} ${result.email}; revoked ${result.revokedSessions} session(s).${result.disabled ? " This admin is DISABLED; use --enable to allow sign-in." : ""}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Provisioning failed.");
  process.exitCode = 1;
});
