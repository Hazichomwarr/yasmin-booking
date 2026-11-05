import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { PrismaClient } from "@prisma/client";

import {
  assertNeonResetExecutionTarget,
  NeonResetImportError,
  runNeonResetImport,
  validateNeonResetManifests,
} from "../lib/catalog/neon-reset-import";
import { adminPasswordProblem, hashAdminPassword } from "../lib/admin/password";

type Arguments = {
  resetManifestPath: string;
  importManifestPath: string;
  databaseUrl: string;
  reportPath?: string;
  apply: boolean;
  authorization?: string;
  approvedResetDigest?: string;
  approvedImportDigest?: string;
  verifiedBackupSha256?: string;
  adminEmail?: string;
  passwordStdin: boolean;
  target:
    | {
        mode: "production";
        projectId?: string;
        branchId?: string;
        endpointId?: string;
      }
    | { mode: "rehearsal"; expectedDatabase?: string };
};

let failureReportPath: string | undefined;

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  let apply = false;
  let rehearsal = false;
  let passwordStdin = false;
  const valueFlags = new Set([
    "--reset-manifest",
    "--import-manifest",
    "--database-url",
    "--report",
    "--authorization",
    "--approved-reset-digest",
    "--approved-import-digest",
    "--verified-backup-sha256",
    "--project-id",
    "--branch-id",
    "--endpoint-id",
    "--expected-database",
    "--admin-email",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--rehearsal") {
      rehearsal = true;
      continue;
    }
    if (argument === "--password-stdin") {
      passwordStdin = true;
      continue;
    }
    if (!valueFlags.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  const resetManifestPath = values.get("--reset-manifest");
  const importManifestPath = values.get("--import-manifest");
  const databaseUrl = values.get("--database-url");
  if (!resetManifestPath || !importManifestPath || !databaseUrl) {
    throw new Error(
      "Usage: neon-catalog-reset-import --reset-manifest <json> --import-manifest <json> --database-url <explicit-url> [--rehearsal --expected-database <disposable-name>] [--report <new-file>] [--apply plus approval flags]",
    );
  }
  return {
    resetManifestPath,
    importManifestPath,
    databaseUrl,
    reportPath: values.get("--report"),
    apply,
    authorization: values.get("--authorization"),
    approvedResetDigest: values.get("--approved-reset-digest"),
    approvedImportDigest: values.get("--approved-import-digest"),
    verifiedBackupSha256: values.get("--verified-backup-sha256"),
    adminEmail: values.get("--admin-email"),
    passwordStdin,
    target: rehearsal
      ? { mode: "rehearsal", expectedDatabase: values.get("--expected-database") }
      : {
          mode: "production",
          projectId: values.get("--project-id"),
          branchId: values.get("--branch-id"),
          endpointId: values.get("--endpoint-id"),
        },
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  failureReportPath = args.reportPath;
  const target = assertNeonResetExecutionTarget(
    args.target.mode === "rehearsal"
      ? {
          mode: "rehearsal",
          databaseUrl: args.databaseUrl,
          expectedDatabase: args.target.expectedDatabase,
        }
      : {
          mode: "production",
          databaseUrl: args.databaseUrl,
          projectId: args.target.projectId,
          branchId: args.target.branchId,
          endpointId: args.target.endpointId,
        },
  );
  const [resetManifest, importManifest] = await Promise.all([
    readJson(args.resetManifestPath),
    readJson(args.importManifestPath),
  ]);
  validateNeonResetManifests({ resetManifest, importManifest });
  let administrator: { email: string; passwordHash: string } | undefined;
  if (args.apply) {
    if (!args.adminEmail) throw new Error("--admin-email is required for apply.");
    const password = args.passwordStdin
      ? await readStdin()
      : await readConfirmedHiddenPassword();
    const email = args.adminEmail.trim().toLowerCase();
    const passwordProblem = adminPasswordProblem(password, email);
    if (passwordProblem) throw new Error(passwordProblem);
    administrator = {
      email,
      passwordHash: await hashAdminPassword(password),
    };
  }
  const prisma = new PrismaClient({ datasourceUrl: args.databaseUrl });
  try {
    const report = await runNeonResetImport({
      prisma,
      target,
      resetManifest,
      importManifest,
      apply: args.apply,
      authorization: args.authorization,
      approvedResetDigest: args.approvedResetDigest,
      approvedImportDigest: args.approvedImportDigest,
      verifiedBackupSha256: args.verifiedBackupSha256,
      administrator,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.reportPath) {
      await writeFile(args.reportPath, serialized, { encoding: "utf8", flag: "wx" });
    }
    process.stdout.write(serialized);
  } finally {
    await prisma.$disconnect();
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readConfirmedHiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("No terminal for a hidden prompt; use --password-stdin.");
  const password = await readHidden("New administrator password: ");
  const repeated = await readHidden("Repeat administrator password: ");
  if (password !== repeated) throw new Error("The passwords do not match.");
  return password;
}

async function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
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

main().catch(async (error: unknown) => {
  const normalized = error instanceof NeonResetImportError
    ? {
        operation: "YASMIN-5A.9C",
        outcome: "failed",
        code: error.code,
        message: error.message,
        transactionRolledBack: error.transactionRolledBack,
        triggerRestored: error.triggerRestored,
      }
    : {
        operation: "YASMIN-5A.9C",
        outcome: "failed",
        code: "UNEXPECTED_ERROR",
        message: error instanceof Error ? error.message : "Reset/import failed.",
        transactionRolledBack: false,
        triggerRestored: false,
      };
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (failureReportPath) {
    try {
      await writeFile(failureReportPath, serialized, { encoding: "utf8", flag: "wx" });
    } catch (reportError) {
      process.stderr.write(`AUDIT_REPORT_WRITE_FAILED: ${reportError instanceof Error ? reportError.message : "unknown error"}\n`);
    }
  }
  process.stderr.write(serialized);
  process.exitCode = 1;
});
