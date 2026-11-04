import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertCatalogImportTarget,
  CatalogImportError,
  computeCatalogImportPlanDigest,
  validateCatalogImportArtifact,
} from "../../lib/catalog/importer";
import { catalogImportFixture } from "../support/catalog-import-fixture";

describe("guarded catalog importer validation", () => {
  it("accepts only an explicit matching local non-production database", () => {
    assert.deepEqual(
      assertCatalogImportTarget(
        "postgresql://user:secret@127.0.0.1:5432/yasmin_booking_import_test",
        "yasmin_booking_import_test",
      ),
      { host: "127.0.0.1", port: 5432, database: "yasmin_booking_import_test" },
    );
    for (const [url, expected] of [
      [undefined, "yasmin_booking_import_test"],
      ["postgresql://user:secret@127.0.0.1:5432/yasmin_booking_import_test", undefined],
      ["postgresql://user:secret@127.0.0.1:5432/yasmin_booking_dev", "yasmin_booking_import_test"],
      ["postgresql://user:secret@example.neon.tech/neondb", "neondb"],
      ["postgresql://user:secret@db.example.test/yasmin_booking_test", "yasmin_booking_test"],
      ["postgresql://user:secret@127.0.0.1:5432/production", "production"],
    ] as const) {
      assert.throws(
        () => assertCatalogImportTarget(url, expected),
        (error: unknown) => error instanceof CatalogImportError && error.code === "INVALID_TARGET",
      );
    }
  });

  it("rejects a stale or altered digest", () => {
    const fixture = catalogImportFixture();
    fixture.artifact.plan.serviceOperations[0].targetName = "Altered after review";
    assert.throws(
      () => validateCatalogImportArtifact(fixture.artifact, fixture.digest),
      (error: unknown) => error instanceof CatalogImportError && error.code === "PLAN_DIGEST_MISMATCH",
    );
  });

  it("rejects parent mismatches, active creates, and invalid prices", () => {
    for (const mutate of [
      (artifact: ReturnType<typeof catalogImportFixture>["artifact"]) => {
        artifact.plan.serviceOperations[0].proposedCategorySlug = "another-category";
      },
      (artifact: ReturnType<typeof catalogImportFixture>["artifact"]) => {
        artifact.plan.categoryOperations[0].proposedActive = true;
      },
      (artifact: ReturnType<typeof catalogImportFixture>["artifact"]) => {
        artifact.plan.variantOperations[0].proposedPriceCents = 3_999;
      },
      (artifact: ReturnType<typeof catalogImportFixture>["artifact"]) => {
        artifact.plan.variantOperations[0].priceSource = "MAMACITA_PROVISIONAL";
        artifact.plan.variantOperations[0].priceInterpretation = "starting-at";
      },
    ]) {
      const fixture = catalogImportFixture();
      mutate(fixture.artifact);
      fixture.digest = fixture.artifact.summary.planDigestSha256 =
        computeCatalogImportPlanDigest(fixture.artifact.plan);
      assert.throws(
        () => validateCatalogImportArtifact(fixture.artifact, fixture.digest),
        (error: unknown) => error instanceof CatalogImportError && error.code === "INVALID_PLAN",
      );
    }
  });

  it("allows unresolved inactive draft prices to remain null", () => {
    const fixture = catalogImportFixture({ variantPriceCents: null });
    const prepared = validateCatalogImportArtifact(fixture.artifact, fixture.digest);
    assert.equal(prepared.variants[0].priceCents, null);
    assert.equal(prepared.variants[0].provenance.source, "UNRESOLVED");
  });
});
