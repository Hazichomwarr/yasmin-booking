import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertCatalogImportTarget,
  CatalogImportError,
  runCatalogImport,
} from "../../lib/catalog/importer";
import { prisma } from "../../lib/prisma";
import { createCustomer, createLocation } from "../support/booking-fixtures";
import { catalogImportFixture } from "../support/catalog-import-fixture";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

describe("guarded catalog importer", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  function target() {
    return assertCatalogImportTarget(process.env.DATABASE_URL, "yasmin_booking_test");
  }

  it("dry-runs an empty catalog without writing and reports deterministic operations", async () => {
    const fixture = catalogImportFixture();
    const report = await runCatalogImport({
      prisma,
      artifact: fixture.artifact,
      expectedPlanDigest: fixture.digest,
      target: target(),
    });
    const repeated = await runCatalogImport({
      prisma,
      artifact: fixture.artifact,
      expectedPlanDigest: fixture.digest,
      target: target(),
    });

    assert.equal(report.mode, "dry-run");
    assert.equal(report.outcome, "ready");
    assert.deepEqual(report.before, { categories: 0, hairstyles: 0, variants: 0 });
    assert.deepEqual(report.after, { categories: 1, hairstyles: 1, variants: 1 });
    assert.ok(report.operations.every((operation) => operation.action === "would-create"));
    assert.deepEqual(repeated, report);
    assert.deepEqual(await catalogCounts(), { categories: 0, hairstyles: 0, variants: 0 });
  });

  it("creates only inactive drafts and a repeated execution is idempotent", async () => {
    const fixture = catalogImportFixture();
    const first = await runCatalogImport({
      prisma,
      artifact: fixture.artifact,
      expectedPlanDigest: fixture.digest,
      target: target(),
      apply: true,
    });
    const second = await runCatalogImport({
      prisma,
      artifact: fixture.artifact,
      expectedPlanDigest: fixture.digest,
      target: target(),
      apply: true,
    });

    assert.equal(first.outcome, "applied");
    assert.equal(second.outcome, "already-applied");
    assert.deepEqual(await catalogCounts(), { categories: 1, hairstyles: 1, variants: 1 });
    assert.equal(await prisma.hairstyleCategory.count({ where: { isActive: true } }), 0);
    assert.equal(await prisma.hairstyle.count({ where: { isActive: true } }), 0);
    assert.equal(await prisma.hairstyleVariant.count({ where: { isActive: true } }), 0);
  });

  it("fails closed on active or inactive slug collisions and catalog drift", async () => {
    for (const isActive of [true, false]) {
      const fixture = catalogImportFixture();
      await prisma.hairstyleCategory.create({
        data: { name: `Collision ${isActive}`, slug: "new-braids", isActive },
      });
      await assert.rejects(
        runCatalogImport({
          prisma,
          artifact: fixture.artifact,
          expectedPlanDigest: fixture.digest,
          target: target(),
          apply: true,
        }),
        (error: unknown) =>
          error instanceof CatalogImportError &&
          error.code === "CATALOG_COLLISION" &&
          error.transactionRolledBack,
      );
      await prisma.hairstyleCategory.deleteMany();
    }

    for (const isActive of [true, false]) {
      const category = await prisma.hairstyleCategory.create({
        data: { name: `Existing parent ${isActive}`, slug: `existing-parent-${isActive}` },
      });
      await prisma.hairstyle.create({
        data: {
          categoryId: category.id,
          name: `Existing style ${isActive}`,
          slug: "new-bob",
          priceCents: 20_000,
          isActive,
        },
      });
      const fixture = catalogImportFixture({ counts: { categories: 1, hairstyles: 1, variants: 0 } });
      await assert.rejects(
        runCatalogImport({
          prisma,
          artifact: fixture.artifact,
          expectedPlanDigest: fixture.digest,
          target: target(),
        }),
        (error: unknown) =>
          error instanceof CatalogImportError && error.code === "CATALOG_COLLISION",
      );
      await prisma.hairstyle.deleteMany();
      await prisma.hairstyleCategory.deleteMany();
    }

    const fixture = catalogImportFixture({ counts: { categories: 1, hairstyles: 0, variants: 0 } });
    await assert.rejects(
      runCatalogImport({
        prisma,
        artifact: fixture.artifact,
        expectedPlanDigest: fixture.digest,
        target: target(),
      }),
      (error: unknown) => error instanceof CatalogImportError && error.code === "STALE_PLAN",
    );
  });

  it("verifies the effective connected database before catalog work", async () => {
    const fixture = catalogImportFixture();
    await assert.rejects(
      runCatalogImport({
        prisma,
        artifact: fixture.artifact,
        expectedPlanDigest: fixture.digest,
        target: { ...target(), database: "another_local_database" },
      }),
      (error: unknown) => error instanceof CatalogImportError && error.code === "INVALID_TARGET",
    );
    assert.deepEqual(await catalogCounts(), { categories: 0, hairstyles: 0, variants: 0 });
  });

  it("rolls back the entire transaction after a partial-operation fault", async () => {
    const fixture = catalogImportFixture();
    await assert.rejects(
      runCatalogImport({
        prisma,
        artifact: fixture.artifact,
        expectedPlanDigest: fixture.digest,
        target: target(),
        apply: true,
        dependencies: {
          afterOperation: () => {
            throw new Error("intentional importer fault");
          },
        },
      }),
      (error: unknown) =>
        error instanceof CatalogImportError &&
        error.code === "TRANSACTION_FAILED" &&
        error.transactionRolledBack,
    );
    assert.deepEqual(await catalogCounts(), { categories: 0, hairstyles: 0, variants: 0 });
  });

  it("preserves existing appointment and payment history while adding drafts", async () => {
    const category = await prisma.hairstyleCategory.create({
      data: { name: "Existing", slug: "existing" },
    });
    const hairstyle = await prisma.hairstyle.create({
      data: {
        categoryId: category.id,
        name: "Existing Style",
        slug: "existing-style",
        requiresVariant: true,
      },
    });
    const variant = await prisma.hairstyleVariant.create({
      data: { hairstyleId: hairstyle.id, name: "Original", priceCents: 20_000 },
    });
    const { location, slot } = await createLocation();
    const customer = await createCustomer();
    const appointment = await prisma.appointment.create({
      data: {
        customerId: customer.id,
        locationId: location.id,
        bookingSlotId: slot.id,
        hairstyleId: hairstyle.id,
        hairstyleVariantId: variant.id,
        appointmentDate: new Date("2027-03-08T00:00:00.000Z"),
        locationNameSnapshot: location.name,
        slotTimeSnapshot: "11:00",
        hairstyleNameSnapshot: "Existing Style",
        hairstyleVariantNameSnapshot: "Original",
        totalPriceCents: 20_000,
        depositAmountCents: 4_000,
        balanceDueCents: 16_000,
        currency: "usd",
      },
    });
    const payment = await prisma.payment.create({
      data: {
        appointmentId: appointment.id,
        provider: "STRIPE",
        purpose: "BOOKING_DEPOSIT",
        amountCents: 4_000,
      },
    });
    const before = await historySnapshot(appointment.id, payment.id);
    const fixture = catalogImportFixture({ counts: { categories: 1, hairstyles: 1, variants: 1 } });

    await runCatalogImport({
      prisma,
      artifact: fixture.artifact,
      expectedPlanDigest: fixture.digest,
      target: target(),
      apply: true,
    });

    assert.deepEqual(await historySnapshot(appointment.id, payment.id), before);
    assert.deepEqual(await catalogCounts(), { categories: 2, hairstyles: 2, variants: 2 });
  });
});

async function catalogCounts() {
  const [categories, hairstyles, variants] = await Promise.all([
    prisma.hairstyleCategory.count(),
    prisma.hairstyle.count(),
    prisma.hairstyleVariant.count(),
  ]);
  return { categories, hairstyles, variants };
}

async function historySnapshot(appointmentId: string, paymentId: string) {
  const [appointment, payment] = await Promise.all([
    prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } }),
    prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
  ]);
  return {
    appointment: {
      id: appointment.id,
      hairstyleId: appointment.hairstyleId,
      hairstyleVariantId: appointment.hairstyleVariantId,
      hairstyleNameSnapshot: appointment.hairstyleNameSnapshot,
      hairstyleVariantNameSnapshot: appointment.hairstyleVariantNameSnapshot,
      totalPriceCents: appointment.totalPriceCents,
      depositAmountCents: appointment.depositAmountCents,
      balanceDueCents: appointment.balanceDueCents,
      currency: appointment.currency,
      updatedAt: appointment.updatedAt,
    },
    payment: {
      id: payment.id,
      appointmentId: payment.appointmentId,
      amountCents: payment.amountCents,
      status: payment.status,
      updatedAt: payment.updatedAt,
    },
  };
}
