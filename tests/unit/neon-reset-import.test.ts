import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertNeonResetExecutionTarget,
  computeStableManifestDigest,
  NeonResetImportError,
  validateNeonResetManifests,
  YASMIN_5A8_SOURCE_PLAN_DIGEST,
} from "../../lib/catalog/neon-reset-import";

describe("Neon reset/import safety validation", () => {
  it("accepts only the exact production identity or an explicitly named disposable rehearsal database", () => {
    assert.deepEqual(
      assertNeonResetExecutionTarget({
        mode: "rehearsal",
        databaseUrl: "postgresql://local@127.0.0.1:55438/yasmin_5a9c_rehearsal",
        expectedDatabase: "yasmin_5a9c_rehearsal",
      }),
      { mode: "rehearsal", host: "127.0.0.1", port: 55438, database: "yasmin_5a9c_rehearsal" },
    );
    assert.deepEqual(
      assertNeonResetExecutionTarget({
        mode: "production",
        databaseUrl: "postgresql://user@ep-dry-brook-b5bm9i7l.c-7.us-east-2.aws.neon.tech:5432/neondb?sslmode=require",
        projectId: "restless-violet-37068529",
        branchId: "br-damp-thunder-b5qfe9n0",
        endpointId: "ep-dry-brook-b5bm9i7l",
      }),
      {
        mode: "production",
        host: "ep-dry-brook-b5bm9i7l.c-7.us-east-2.aws.neon.tech",
        port: 5432,
        database: "neondb",
        projectId: "restless-violet-37068529",
        branchId: "br-damp-thunder-b5qfe9n0",
        endpointId: "ep-dry-brook-b5bm9i7l",
      },
    );

    for (const input of [
      {
        mode: "rehearsal" as const,
        databaseUrl: "postgresql://local@127.0.0.1:5432/yasmin_booking_dev",
        expectedDatabase: "yasmin_booking_dev",
      },
      {
        mode: "rehearsal" as const,
        databaseUrl: "postgresql://local@example.test/yasmin_5a9c_rehearsal",
        expectedDatabase: "yasmin_5a9c_rehearsal",
      },
      {
        mode: "production" as const,
        databaseUrl: "postgresql://user@ep-dry-brook-b5bm9i7l.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require",
        projectId: "wrong-project",
        branchId: "br-damp-thunder-b5qfe9n0",
        endpointId: "ep-dry-brook-b5bm9i7l",
      },
      {
        mode: "production" as const,
        databaseUrl: "postgresql://user@ep-dry-brook-b5bm9i7l.c-7.us-east-2.aws.neon.tech/neondb?sslmode=disable",
        projectId: "restless-violet-37068529",
        branchId: "br-damp-thunder-b5qfe9n0",
        endpointId: "ep-dry-brook-b5bm9i7l",
      },
    ]) {
      assert.throws(
        () => assertNeonResetExecutionTarget(input),
        (error: unknown) => error instanceof NeonResetImportError && error.code === "INVALID_TARGET",
      );
    }
  });

  it("validates an exact all-inactive 17/45/63 manifest and rejects tampering", () => {
    const fixture = manifestFixture();
    const validated = validateNeonResetManifests({
      resetManifest: fixture.reset,
      importManifest: fixture.catalog,
      expectedResetDigest: computeStableManifestDigest(fixture.reset),
      expectedImportDigest: computeStableManifestDigest(fixture.catalog),
    });
    assert.equal(validated.catalog.categories.length, 17);
    assert.equal(validated.catalog.hairstyles.length, 45);
    assert.equal(validated.catalog.variants.length, 63);
    assert.ok(validated.catalog.categories.every((row) => !row.isActive));
    assert.ok(validated.catalog.hairstyles.every((row) => !row.isActive));
    assert.ok(validated.catalog.variants.every((row) => !row.isActive));

    const alteredVariant = fixture.catalog.variants[0] as {
      priceCents: number | null;
      provenance: {
        source: "YASMIN_SUPPLIED" | "MAMACITA_PROVISIONAL" | "UNRESOLVED";
        interpretation: "exact" | "calculated" | "conditional" | "starting-at" | "range" | "unresolved";
        sourceEntries: string[];
      };
    };
    alteredVariant.priceCents = 5_000;
    alteredVariant.provenance = {
      source: "MAMACITA_PROVISIONAL",
      interpretation: "conditional",
      sourceEntries: ["REF-001"],
    };
    assert.throws(
      () => validateNeonResetManifests({
        resetManifest: fixture.reset,
        importManifest: fixture.catalog,
        expectedResetDigest: computeStableManifestDigest(fixture.reset),
        expectedImportDigest: computeStableManifestDigest(fixture.catalog),
      }),
      (error: unknown) => error instanceof NeonResetImportError && error.code === "INVALID_MANIFEST",
    );
  });

  it("fails closed before validation when a reviewed manifest digest changes", () => {
    const fixture = manifestFixture();
    const resetDigest = computeStableManifestDigest(fixture.reset);
    const importDigest = computeStableManifestDigest(fixture.catalog);
    fixture.reset.baseline.Payment.count += 1;
    assert.throws(
      () => validateNeonResetManifests({
        resetManifest: fixture.reset,
        importManifest: fixture.catalog,
        expectedResetDigest: resetDigest,
        expectedImportDigest: importDigest,
      }),
      (error: unknown) => error instanceof NeonResetImportError && error.code === "MANIFEST_DIGEST_MISMATCH",
    );
  });
});

function manifestFixture() {
  const empty = { count: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
  const deleteTables = [
    "BookingConfirmationEmail", "AppointmentEvent", "AdminSession", "PaymentProcessingException", "Payment", "Appointment",
    "MarketingConsentEvent", "Customer", "StripeWebhookEvent", "RateLimitCounter", "HomepageCatalogFeature",
    "HairstyleMediaCleanupTask", "HairstyleMedia", "HairstyleVariant", "Hairstyle", "HairstyleCategory",
    "BookingSlot", "SalonLocation", "AdminUser",
  ];
  const reset = {
    version: 2,
    operation: "YASMIN-5A.9C",
    backup: { filename: "fixture.dump", sha256: "a".repeat(64), format: "PostgreSQL 18 custom" },
    productionTarget: {
      projectId: "restless-violet-37068529",
      branchId: "br-damp-thunder-b5qfe9n0",
      endpointId: "ep-dry-brook-b5bm9i7l",
      hostname: "ep-dry-brook-b5bm9i7l.c-7.us-east-2.aws.neon.tech",
      port: 5432,
      database: "neondb",
    },
    trigger: {
      schema: "public",
      table: "MarketingConsentEvent",
      name: "MarketingConsentEvent_append_only",
      functionSchema: "public",
      functionName: "MarketingConsentEvent_append_only",
      enabledState: "O",
      definition: 'CREATE TRIGGER "MarketingConsentEvent_append_only" BEFORE DELETE OR UPDATE ON "MarketingConsentEvent" FOR EACH ROW EXECUTE FUNCTION "MarketingConsentEvent_append_only"()',
    },
    deleteTables,
    baseline: Object.fromEntries(deleteTables.map((table) => [table, empty])),
    preserved: { _prisma_migrations: empty },
    expectedAfter: Object.fromEntries(deleteTables.map((table) => [table,
      table === "HairstyleCategory" ? 17
        : table === "Hairstyle" ? 45
          : table === "HairstyleVariant" ? 63
            : table === "AdminUser" || table === "SalonLocation" ? 1
              : table === "BookingSlot" ? 3 : 0,
    ])),
    initialization: {
      location: {
        id: "william-street", name: "William Street", addressLine1: "524 William St", addressLine2: null,
        city: "East Orange", state: "NJ", postalCode: null, phone: null, timeZone: "America/New_York",
        isActive: true, acceptsOnlineBooking: true,
      },
      slots: [
        { localStartTime: "05:00", capacity: 10, isActive: true },
        { localStartTime: "11:00", capacity: 10, isActive: true },
        { localStartTime: "14:00", capacity: 10, isActive: true },
      ],
    },
  };
  const categories = Array.from({ length: 17 }, (_, index) => ({
    id: deterministicFixtureId("category", index),
    name: `Category ${index}`,
    slug: `category-${index}`,
    description: null,
    isActive: false as const,
    sortOrder: index,
    sourceAction: "CREATE_INACTIVE",
  }));
  const hairstyles = Array.from({ length: 45 }, (_, index) => ({
    id: deterministicFixtureId("hairstyle", index),
    categorySlug: `category-${index % 17}`,
    name: `Hairstyle ${index}`,
    slug: `hairstyle-${index}`,
    description: null,
    priceCents: index === 0 ? null : 4_000,
    requiresVariant: index === 0,
    isActive: false as const,
    sortOrder: index,
    provenance: index === 0
      ? { source: "UNRESOLVED" as const, interpretation: "unresolved" as const, sourceEntries: [] }
      : { source: "YASMIN_SUPPLIED" as const, interpretation: "exact" as const, sourceEntries: [`YAS-${index}`] },
    sourceAction: "CREATE_INACTIVE",
  }));
  const variants = Array.from({ length: 63 }, (_, index) => ({
    id: deterministicFixtureId("variant", index),
    hairstyleSlug: "hairstyle-0",
    name: `Variant ${index}`,
    manifestSlug: `variant-${index}`,
    description: null,
    priceCents: null,
    isActive: false as const,
    sortOrder: index,
    provenance: { source: "UNRESOLVED" as const, interpretation: "unresolved" as const, sourceEntries: [] },
    sourceAction: "CREATE_INACTIVE",
  }));
  return {
    reset,
    catalog: {
      version: 1,
      sourcePlanDigest: YASMIN_5A8_SOURCE_PLAN_DIGEST,
      categories,
      hairstyles,
      variants,
      exclusions: { categories: [], hairstyles: [], variants: [] },
    },
  };
}

function deterministicFixtureId(entity: "category" | "hairstyle" | "variant", index: number) {
  return `y5a8_${entity}_${index.toString(16).padStart(24, "0")}`;
}
