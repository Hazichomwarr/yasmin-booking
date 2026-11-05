import assert from "node:assert/strict";

import { PrismaClient, type Prisma } from "@prisma/client";

import { fingerprintTables, type Fingerprint } from "../../lib/catalog/neon-reset-import";

const TIME_ZONES = ["UTC", "America/New_York", "Asia/Kathmandu"] as const;
const TABLES = ["AdminSession", "AdminUser", "_prisma_migrations"] as const;

async function main() {
  const databaseUrl = process.argv[2];
  if (!databaseUrl) throw new Error("Usage: neon-fingerprint-timezone.rehearsal <disposable-database-url>");
  const url = new URL(databaseUrl);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("The fingerprint rehearsal accepts only a disposable loopback PostgreSQL database.");
  }
  if (!url.pathname.slice(1).startsWith("yasmin_5a9e_")) {
    throw new Error("The fingerprint rehearsal database must use the yasmin_5a9e_ prefix.");
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const byTimeZone = new Map<string, Record<string, Fingerprint>>();
    for (const timeZone of TIME_ZONES) {
      byTimeZone.set(timeZone, await fingerprintAt(prisma, timeZone));
    }
    const canonical = byTimeZone.get("UTC");
    assert.ok(canonical);
    for (const timeZone of TIME_ZONES.slice(1)) {
      assert.deepEqual(byTimeZone.get(timeZone), canonical);
    }

    const changedApplicationTimestamp = await mutateAndFingerprint(prisma, `
      UPDATE "AdminSession"
      SET "createdAt" = "createdAt" + INTERVAL '1 millisecond'
      WHERE id = (SELECT id FROM "AdminSession" ORDER BY id LIMIT 1)
    `, "AdminSession");
    assert.notEqual(changedApplicationTimestamp.sha256, canonical.AdminSession.sha256);

    const changedMigrationTimestamp = await mutateAndFingerprint(prisma, `
      UPDATE "_prisma_migrations"
      SET started_at = started_at + INTERVAL '1 microsecond'
      WHERE id = (SELECT id FROM "_prisma_migrations" ORDER BY id LIMIT 1)
    `, "_prisma_migrations");
    assert.notEqual(changedMigrationTimestamp.sha256, canonical._prisma_migrations.sha256);

    const beforeValueChange = await prisma.$transaction(async (tx) =>
      (await fingerprintTables(tx, ["AdminUser"])).AdminUser,
    );
    const changedApplicationValue = await mutateAndFingerprint(prisma, `
      UPDATE "AdminUser"
      SET email = 'fingerprint-' || email
      WHERE id = (SELECT id FROM "AdminUser" ORDER BY id LIMIT 1)
    `, "AdminUser");
    assert.notEqual(changedApplicationValue.sha256, beforeValueChange.sha256);

    process.stdout.write(`${JSON.stringify({
      timeZones: TIME_ZONES,
      tables: TABLES,
      canonical,
      timestampDriftDetected: true,
      nonTemporalDriftDetected: true,
    }, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

async function fingerprintAt(prisma: PrismaClient, timeZone: typeof TIME_ZONES[number]) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${timeZone}'`);
    const before = await currentTimeZone(tx);
    assert.equal(before, timeZone);
    const fingerprints = await fingerprintTables(tx, TABLES);
    assert.equal(await currentTimeZone(tx), "UTC");
    return fingerprints;
  });
}

async function mutateAndFingerprint(
  prisma: PrismaClient,
  statement: string,
  table: typeof TABLES[number],
) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.$executeRawUnsafe(statement);
    assert.equal(changed, 1);
    return (await fingerprintTables(tx, [table]))[table];
  });
}

async function currentTimeZone(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRawUnsafe<Array<{ timeZone: string }>>(
    `SELECT current_setting('TimeZone') AS "timeZone"`,
  );
  assert.equal(rows.length, 1);
  return rows[0]!.timeZone;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : "Fingerprint rehearsal failed."}\n`);
  process.exitCode = 1;
});
