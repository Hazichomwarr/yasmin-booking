import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { PrismaClient } from "@prisma/client";

import {
  assertCatalogImportTarget,
  CatalogImportError,
  runCatalogImport,
  YASMIN_5A4_PLAN_DIGEST,
} from "../lib/catalog/importer";

type Arguments = {
  planPath: string;
  databaseUrl: string;
  expectedDatabase: string;
  reportPath?: string;
  apply: boolean;
};

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (!["--plan", "--database-url", "--expected-database", "--report"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }

  const planPath = values.get("--plan");
  const databaseUrl = values.get("--database-url");
  const expectedDatabase = values.get("--expected-database");
  if (!planPath || !databaseUrl || !expectedDatabase) {
    throw new Error(
      "Usage: catalog:import --plan <reviewed.json> --database-url <local-url> --expected-database <name> [--report <path>] [--apply]",
    );
  }
  return {
    planPath,
    databaseUrl,
    expectedDatabase,
    reportPath: values.get("--report"),
    apply,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const target = assertCatalogImportTarget(args.databaseUrl, args.expectedDatabase);
  const artifact = JSON.parse(await readFile(args.planPath, "utf8")) as unknown;
  const prisma = new PrismaClient({ datasourceUrl: args.databaseUrl });
  try {
    const report = await runCatalogImport({
      prisma,
      artifact,
      expectedPlanDigest: YASMIN_5A4_PLAN_DIGEST,
      target,
      apply: args.apply,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.reportPath) await writeFile(args.reportPath, serialized, { encoding: "utf8", flag: "wx" });
    process.stdout.write(serialized);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Catalog import failed.";
  const code = error instanceof CatalogImportError ? error.code : "UNEXPECTED_ERROR";
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
});
