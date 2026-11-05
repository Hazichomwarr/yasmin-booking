import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { PrismaClient } from "@prisma/client";

import { BookingError } from "../../lib/booking/errors";
import { resolveCatalogBookingPrice } from "../../lib/booking/pricing";
import { hashAdminPassword, verifyAdminPassword } from "../../lib/admin/password";
import {
  assertNeonResetExecutionTarget,
  NeonResetImportError,
  runNeonResetImport,
  YASMIN_5A8_IMPORT_MANIFEST_DIGEST,
  YASMIN_5A9C_APPLY_AUTHORIZATION,
  YASMIN_5A9C_RESET_MANIFEST_DIGEST,
} from "../../lib/catalog/neon-reset-import";

type Arguments = {
  applyDatabaseUrl: string;
  applyDatabase: string;
  rollbackDatabaseUrl: string;
  rollbackDatabase: string;
  resetManifestPath: string;
  importManifestPath: string;
  reportPath: string;
};

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const [resetManifest, importManifest] = await Promise.all([
    readJson(args.resetManifestPath),
    readJson(args.importManifestPath),
  ]);
  const applyTarget = assertNeonResetExecutionTarget({
    mode: "rehearsal",
    databaseUrl: args.applyDatabaseUrl,
    expectedDatabase: args.applyDatabase,
  });
  const rollbackTarget = assertNeonResetExecutionTarget({
    mode: "rehearsal",
    databaseUrl: args.rollbackDatabaseUrl,
    expectedDatabase: args.rollbackDatabase,
  });
  const applyPrisma = new PrismaClient({ datasourceUrl: args.applyDatabaseUrl });
  const rollbackPrisma = new PrismaClient({ datasourceUrl: args.rollbackDatabaseUrl });
  const administrator = {
    email: "owner.rehearsal@example.test",
    passwordHash: await hashAdminPassword("Rehearsal-only secure passphrase 5A.9C!", { N: 2 ** 14, r: 8, p: 1 }),
  };
  try {
    const dryRun = await runNeonResetImport({
      prisma: applyPrisma,
      target: applyTarget,
      resetManifest,
      importManifest,
      administrator,
    });
    assert.equal(dryRun.outcome, "ready");
    assert.equal(dryRun.databaseMutated, false);

    const applied = await applyReviewed({
      prisma: applyPrisma,
      target: applyTarget,
      resetManifest,
      importManifest,
      administrator,
    });
    assert.equal(applied.outcome, "applied");
    assert.deepEqual(
      { categories: applied.catalog.categories, hairstyles: applied.catalog.hairstyles, variants: applied.catalog.variants },
      { categories: 17, hairstyles: 45, variants: 63 },
    );
    assert.equal(applied.catalog.activeCategories, 0);
    assert.equal(applied.catalog.activeHairstyles, 0);
    assert.equal(applied.catalog.activeVariants, 0);
    assert.equal(applied.blobObjectsDeleted, 0);
    const [admins, sessions, locations, slots] = await Promise.all([
      applyPrisma.adminUser.findMany(),
      applyPrisma.adminSession.count(),
      applyPrisma.salonLocation.findMany(),
      applyPrisma.bookingSlot.findMany({ orderBy: { localStartTime: "asc" } }),
    ]);
    assert.equal(admins.length, 1);
    assert.equal(admins[0]?.email, administrator.email);
    assert.equal(await verifyAdminPassword("Rehearsal-only secure passphrase 5A.9C!", admins[0]?.passwordHash), true);
    assert.equal(sessions, 0);
    assert.deepEqual(
      locations.map(({ id, name, timeZone, isActive, acceptsOnlineBooking }) => ({ id, name, timeZone, isActive, acceptsOnlineBooking })),
      [{ id: "william-street", name: "William Street", timeZone: "America/New_York", isActive: true, acceptsOnlineBooking: true }],
    );
    assert.deepEqual(slots.map(({ capacity, isActive }) => ({ capacity, isActive })), [
      { capacity: 10, isActive: true }, { capacity: 10, isActive: true }, { capacity: 10, isActive: true },
    ]);

    const repeated = await applyReviewed({
      prisma: applyPrisma,
      target: applyTarget,
      resetManifest,
      importManifest,
      administrator,
    });
    assert.equal(repeated.outcome, "already-applied");
    assert.equal(repeated.databaseMutated, false);

    const firstStyle = await applyPrisma.hairstyle.findFirstOrThrow({ orderBy: { id: "asc" } });
    await assert.rejects(
      resolveCatalogBookingPrice(applyPrisma, { hairstyleId: firstStyle.id }),
      (error: unknown) => error instanceof BookingError && error.code === "HAIRSTYLE_NOT_AVAILABLE",
    );
    const integrity = await databaseIntegrity(applyPrisma);
    assert.equal(integrity.foreignKeyViolations, 0);
    assert.equal(integrity.activeCategories, 0);
    assert.equal(integrity.activeHairstyles, 0);
    assert.equal(integrity.activeVariants, 0);

    let triggerRollbackError: NeonResetImportError | undefined;
    try {
      await runNeonResetImport({
        prisma: rollbackPrisma,
        target: rollbackTarget,
        resetManifest,
        importManifest,
        administrator,
        apply: true,
        authorization: YASMIN_5A9C_APPLY_AUTHORIZATION,
        approvedResetDigest: YASMIN_5A9C_RESET_MANIFEST_DIGEST,
        approvedImportDigest: YASMIN_5A8_IMPORT_MANIFEST_DIGEST,
        verifiedBackupSha256: "1ec3adbb1e17979ba874fefc66d77c8c4a2e2915e2e4f5587f1e0c2483d66dbf",
        dependencies: {
          afterStep: ({ phase, key }) => {
            if (phase === "reset" && key === "MarketingConsentEvent:trigger-disabled") {
              throw new Error("intentional YASMIN-5A.9C rollback fault");
            }
          },
        },
      });
    } catch (error) {
      if (error instanceof NeonResetImportError) triggerRollbackError = error;
      else throw error;
    }
    assert.ok(triggerRollbackError);
    assert.equal(triggerRollbackError.transactionRolledBack, true);
    assert.equal(triggerRollbackError.triggerRestored, true, triggerRollbackError.message);
    const afterTriggerFault = await runNeonResetImport({
      prisma: rollbackPrisma,
      target: rollbackTarget,
      resetManifest,
      importManifest,
    });
    assert.equal(afterTriggerFault.outcome, "ready");
    assert.equal(afterTriggerFault.trigger.enabledAfter, true);

    let importRollbackError: NeonResetImportError | undefined;
    let importedVariants = 0;
    try {
      await runNeonResetImport({
        prisma: rollbackPrisma,
        target: rollbackTarget,
        resetManifest,
        importManifest,
        administrator,
        apply: true,
        authorization: YASMIN_5A9C_APPLY_AUTHORIZATION,
        approvedResetDigest: YASMIN_5A9C_RESET_MANIFEST_DIGEST,
        approvedImportDigest: YASMIN_5A8_IMPORT_MANIFEST_DIGEST,
        verifiedBackupSha256: "1ec3adbb1e17979ba874fefc66d77c8c4a2e2915e2e4f5587f1e0c2483d66dbf",
        dependencies: {
          afterStep: ({ phase, key }) => {
            if (phase === "import" && key.startsWith("variant:")) {
              importedVariants += 1;
              if (importedVariants === 10) throw new Error("intentional mid-import rollback fault");
            }
          },
        },
      });
    } catch (error) {
      if (error instanceof NeonResetImportError) importRollbackError = error;
      else throw error;
    }
    assert.ok(importRollbackError);
    assert.equal(importRollbackError.transactionRolledBack, true);
    assert.equal(importRollbackError.triggerRestored, true, importRollbackError.message);
    const afterImportFault = await runNeonResetImport({
      prisma: rollbackPrisma,
      target: rollbackTarget,
      resetManifest,
      importManifest,
    });
    assert.equal(afterImportFault.outcome, "ready");
    assert.equal(afterImportFault.trigger.enabledAfter, true);

    const report = {
      operation: "YASMIN-5A.9C isolated PostgreSQL 18 rehearsal",
      applyDatabase: applyTarget,
      rollbackDatabase: rollbackTarget,
      dryRun,
      firstApply: applied,
      secondApply: repeated,
      integrity,
      bookingSafety: "inactive hairstyle rejected with HAIRSTYLE_NOT_AVAILABLE",
      rollback: {
        triggerDisabledFault: {
          code: triggerRollbackError.code,
          transactionRolledBack: triggerRollbackError.transactionRolledBack,
          triggerRestored: triggerRollbackError.triggerRestored,
          postFaultDryRunOutcome: afterTriggerFault.outcome,
        },
        midImportFault: {
          code: importRollbackError.code,
          transactionRolledBack: importRollbackError.transactionRolledBack,
          triggerRestored: importRollbackError.triggerRestored,
          postFaultDryRunOutcome: afterImportFault.outcome,
        },
      },
    };
    await writeFile(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await Promise.all([applyPrisma.$disconnect(), rollbackPrisma.$disconnect()]);
  }
}

async function applyReviewed(input: {
  prisma: PrismaClient;
  target: ReturnType<typeof assertNeonResetExecutionTarget>;
  resetManifest: unknown;
  importManifest: unknown;
  administrator: { email: string; passwordHash: string };
}) {
  return runNeonResetImport({
    ...input,
    apply: true,
    authorization: YASMIN_5A9C_APPLY_AUTHORIZATION,
    approvedResetDigest: YASMIN_5A9C_RESET_MANIFEST_DIGEST,
    approvedImportDigest: YASMIN_5A8_IMPORT_MANIFEST_DIGEST,
    verifiedBackupSha256: "1ec3adbb1e17979ba874fefc66d77c8c4a2e2915e2e4f5587f1e0c2483d66dbf",
  });
}

async function databaseIntegrity(prisma: PrismaClient) {
  const [foreignKeys, unvalidatedForeignKeys, activeCategories, activeHairstyles, activeVariants] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ violations: bigint }>>(`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT h.id FROM "Hairstyle" h LEFT JOIN "HairstyleCategory" c ON c.id = h."categoryId" WHERE c.id IS NULL
        UNION ALL
        SELECT v.id FROM "HairstyleVariant" v LEFT JOIN "Hairstyle" h ON h.id = v."hairstyleId" WHERE h.id IS NULL
      ) orphaned
    `),
    prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT COUNT(*)::bigint AS count
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'f' AND NOT c.convalidated
    `),
    prisma.hairstyleCategory.count({ where: { isActive: true } }),
    prisma.hairstyle.count({ where: { isActive: true } }),
    prisma.hairstyleVariant.count({ where: { isActive: true } }),
  ]);
  return {
    foreignKeyViolations: Number(foreignKeys[0]?.violations ?? 0),
    unvalidatedForeignKeys: Number(unvalidatedForeignKeys[0]?.count ?? 0),
    activeCategories,
    activeHairstyles,
    activeVariants,
  };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error("All rehearsal arguments require explicit values.");
    values.set(flag, value);
  }
  const required = [
    "--apply-database-url",
    "--apply-database",
    "--rollback-database-url",
    "--rollback-database",
    "--reset-manifest",
    "--import-manifest",
    "--report",
  ];
  for (const flag of required) if (!values.has(flag)) throw new Error(`Missing ${flag}.`);
  return {
    applyDatabaseUrl: values.get("--apply-database-url")!,
    applyDatabase: values.get("--apply-database")!,
    rollbackDatabaseUrl: values.get("--rollback-database-url")!,
    rollbackDatabase: values.get("--rollback-database")!,
    resetManifestPath: values.get("--reset-manifest")!,
    importManifestPath: values.get("--import-manifest")!,
    reportPath: values.get("--report")!,
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : "Rehearsal failed."}\n`);
  process.exitCode = 1;
});
