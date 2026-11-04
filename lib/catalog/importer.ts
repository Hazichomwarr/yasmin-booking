import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  normalizeName,
  normalizeOptionalPriceCents,
  normalizeSlug,
} from "./validation";

export const YASMIN_5A4_PLAN_DIGEST =
  "afc2ad2aa57fa100d851fde7f22989abed01b7fc239c8b701b81af42eb24eacd";

const IMPORT_SORT_ORDER_BASE = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

type JsonRecord = Record<string, unknown>;

export type CatalogImportTarget = {
  host: string;
  port: number;
  database: string;
};

export type CatalogImportArtifact = {
  summary: {
    planDigestSha256: string;
    currentCatalog: {
      categories: number;
      hairstyles: number;
      variants: number;
    };
  };
  plan: {
    version: number;
    mode: string;
    blockers: unknown[];
    categoryOperations: JsonRecord[];
    serviceOperations: JsonRecord[];
    variantOperations: JsonRecord[];
    retainedExistingServices?: JsonRecord[];
    retainedExistingVariants?: JsonRecord[];
  };
  provisionalDecisions?: JsonRecord[];
};

type PreparedCategory = {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
};

type PriceProvenance = {
  source: "YASMIN_SUPPLIED" | "MAMACITA_PROVISIONAL" | "UNRESOLVED";
  interpretation: "exact" | "calculated" | "conditional" | "starting-at" | "range" | "unresolved";
  sourceEntries: string[];
};

type PreparedHairstyle = {
  id: string;
  categorySlug: string;
  name: string;
  slug: string;
  priceCents: number | null;
  requiresVariant: boolean;
  sortOrder: number;
  provenance: PriceProvenance;
};

type PreparedVariant = {
  id: string;
  hairstyleSlug: string;
  name: string;
  manifestSlug: string;
  priceCents: number | null;
  sortOrder: number;
  provenance: PriceProvenance;
};

export type PreparedCatalogImport = {
  digest: string;
  artifact: CatalogImportArtifact;
  categories: PreparedCategory[];
  hairstyles: PreparedHairstyle[];
  variants: PreparedVariant[];
  skipped: Array<{
    entity: "category" | "hairstyle" | "variant";
    key: string;
    action: string;
    reason: string;
  }>;
};

type CatalogCounts = {
  categories: number;
  hairstyles: number;
  variants: number;
};

type CatalogState = {
  counts: CatalogCounts;
  categories: Array<{
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    sortOrder: number;
  }>;
  hairstyles: Array<{
    id: string;
    categoryId: string;
    categorySlug: string;
    name: string;
    slug: string;
    priceCents: number | null;
    requiresVariant: boolean;
    isActive: boolean;
    sortOrder: number;
    appointmentCount: number;
    mediaCount: number;
  }>;
  variants: Array<{
    id: string;
    hairstyleId: string;
    hairstyleSlug: string;
    name: string;
    priceCents: number | null;
    isActive: boolean;
    sortOrder: number;
    appointmentCount: number;
    mediaCount: number;
  }>;
};

type ImportState = "pristine" | "already-applied";

export type CatalogImportReport = {
  mode: "dry-run" | "apply";
  outcome: "ready" | "applied" | "already-applied";
  planDigestSha256: string;
  target: CatalogImportTarget;
  transactionRolledBack: false;
  before: CatalogCounts;
  after: CatalogCounts;
  operations: Array<{
    entity: "category" | "hairstyle" | "variant";
    action: "would-create" | "created" | "already-present";
    id: string;
    key: string;
    active: false;
    priceCents?: number | null;
    priceSource?: PriceProvenance["source"];
    priceInterpretation?: PriceProvenance["interpretation"];
    sourceEntries?: string[];
  }>;
  skipped: PreparedCatalogImport["skipped"];
};

export type CatalogImportDependencies = {
  /** Internal test seam. The CLI never supplies it. */
  afterOperation?: (operation: { entity: string; id: string; key: string }) => void | Promise<void>;
};

export class CatalogImportError extends Error {
  constructor(
    public readonly code:
      | "INVALID_TARGET"
      | "INVALID_PLAN"
      | "PLAN_DIGEST_MISMATCH"
      | "STALE_PLAN"
      | "CATALOG_COLLISION"
      | "TRANSACTION_FAILED",
    message: string,
    public readonly transactionRolledBack = false,
  ) {
    super(message);
    this.name = "CatalogImportError";
  }
}

export function assertCatalogImportTarget(
  databaseUrl: string | undefined,
  expectedDatabase: string | undefined,
): CatalogImportTarget {
  if (!databaseUrl?.trim()) {
    throw new CatalogImportError("INVALID_TARGET", "An explicit database URL is required.");
  }
  if (!expectedDatabase?.trim()) {
    throw new CatalogImportError("INVALID_TARGET", "An explicit expected database name is required.");
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new CatalogImportError("INVALID_TARGET", "The database URL is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new CatalogImportError("INVALID_TARGET", "The importer requires PostgreSQL.");
  }

  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const expected = expectedDatabase.trim();
  if (host.endsWith(".neon.tech")) {
    throw new CatalogImportError("INVALID_TARGET", "Neon and production hosts are refused by this importer.");
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new CatalogImportError("INVALID_TARGET", "Only a local loopback database is allowed.");
  }
  if (database !== expected) {
    throw new CatalogImportError("INVALID_TARGET", "The resolved database does not match the expected database identity.");
  }
  if (/^(neondb|postgres)$/i.test(database) || /(^|[_-])(prod|production)([_-]|$)/i.test(database)) {
    throw new CatalogImportError("INVALID_TARGET", "Production database identities are refused by default.");
  }

  return { host, port: Number(url.port || "5432"), database };
}

export function computeCatalogImportPlanDigest(plan: unknown): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function validateCatalogImportArtifact(
  value: unknown,
  expectedDigest: string,
): PreparedCatalogImport {
  if (!isRecord(value) || !isRecord(value.summary) || !isRecord(value.plan)) {
    throw invalidPlan("The import artifact must contain summary and plan objects.");
  }
  const artifact = value as unknown as CatalogImportArtifact;
  const computedDigest = computeCatalogImportPlanDigest(artifact.plan);
  if (computedDigest !== expectedDigest || artifact.summary.planDigestSha256 !== expectedDigest) {
    throw new CatalogImportError(
      "PLAN_DIGEST_MISMATCH",
      "The import plan digest does not match the reviewed plan.",
    );
  }
  if (artifact.plan.version !== 1 || artifact.plan.mode !== "DRY_RUN_READ_ONLY") {
    throw invalidPlan("The importer accepts only version 1 read-only preview plans.");
  }
  if (!Array.isArray(artifact.plan.blockers) || artifact.plan.blockers.length > 0) {
    throw invalidPlan("The plan contains global blockers and cannot be imported.");
  }
  if (
    !Array.isArray(artifact.plan.categoryOperations) ||
    !Array.isArray(artifact.plan.serviceOperations) ||
    !Array.isArray(artifact.plan.variantOperations)
  ) {
    throw invalidPlan("The plan operation lists are missing.");
  }
  const counts = artifact.summary.currentCatalog;
  if (!isCounts(counts)) throw invalidPlan("The plan is missing its baseline catalog counts.");

  const allowedCategoryActions = new Set([
    "CREATE_INACTIVE", "REUSE_REVIEW_NAME", "SKIP_POLICY", "REUSE", "MANUAL_AMBIGUOUS", "BLOCK_DUPLICATE_SLUG",
  ]);
  const allowedHairstyleActions = new Set([
    "CREATE_INACTIVE", "BLOCK_ACTIVE_CHANGE", "BLOCK_OWNER_DECISION", "MANUAL_RECONCILE", "REUSE", "UPDATE_INACTIVE", "MANUAL_AMBIGUOUS", "BLOCK_DUPLICATE_SLUG",
  ]);
  const allowedVariantActions = new Set([
    "CREATE_INACTIVE", "BLOCK_PARENT_DECISION", "SKIP_UNRESOLVED_PLACEHOLDER", "REUSE", "UPDATE_INACTIVE", "BLOCK_ACTIVE_PRICE_CHANGE", "BLOCK_AMBIGUOUS_VARIANT", "CREATE_INACTIVE_REVIEW_ACTIVE_PARENT",
  ]);
  assertKnownActions(artifact.plan.categoryOperations, allowedCategoryActions, "category");
  assertKnownActions(artifact.plan.serviceOperations, allowedHairstyleActions, "hairstyle");
  assertKnownActions(artifact.plan.variantOperations, allowedVariantActions, "variant");

  const categoryCreates = artifact.plan.categoryOperations.filter((operation) => operation.action === "CREATE_INACTIVE");
  const hairstyleCreates = artifact.plan.serviceOperations.filter((operation) => operation.action === "CREATE_INACTIVE");
  const variantCreates = artifact.plan.variantOperations.filter((operation) => operation.action === "CREATE_INACTIVE");

  const categories = categoryCreates.map((operation, index) => {
    const name = validateName(operation.targetName, "Category name");
    const slug = validateSlug(operation.targetSlug);
    assertExplicitlyInactive(operation, "category", slug);
    return {
      id: deterministicId(computedDigest, "category", slug),
      name,
      slug,
      sortOrder: IMPORT_SORT_ORDER_BASE + index,
    };
  });
  assertUnique(categories.map((category) => category.slug), "category slug");
  assertUnique(categories.map((category) => category.id), "category deterministic ID");

  const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));
  for (const operation of artifact.plan.categoryOperations) {
    if (operation.action !== "CREATE_INACTIVE" && typeof operation.targetSlug === "string" && typeof operation.existingId === "string") {
      categoryIdBySlug.set(operation.targetSlug, operation.existingId);
    }
  }

  const serviceIndexByCategory = new Map<string, number>();
  const hairstyles = hairstyleCreates.map((operation) => {
    const name = validateName(operation.targetName, "Hairstyle name");
    const slug = validateSlug(operation.targetSlug);
    const categorySlug = validateSlug(operation.proposedCategorySlug);
    if (!categoryIdBySlug.has(categorySlug)) {
      throw invalidPlan(`Hairstyle ${slug} has no reconciled parent category ${categorySlug}.`);
    }
    assertExplicitlyInactive(operation, "hairstyle", slug);
    if (typeof operation.proposedRequiresVariant !== "boolean") {
      throw invalidPlan(`Hairstyle ${slug} is missing its pricing mode.`);
    }
    const priceCents = validateDraftPrice(operation.proposedPriceCents, `hairstyle ${slug}`);
    if (operation.proposedRequiresVariant && priceCents !== null) {
      throw invalidPlan(`Variant-priced hairstyle ${slug} cannot have a service price.`);
    }
    const provenance = deriveServicePriceProvenance(artifact, slug, priceCents);
    const position = serviceIndexByCategory.get(categorySlug) ?? 0;
    serviceIndexByCategory.set(categorySlug, position + 1);
    return {
      id: deterministicId(computedDigest, "hairstyle", slug),
      categorySlug,
      name,
      slug,
      priceCents,
      requiresVariant: operation.proposedRequiresVariant,
      sortOrder: IMPORT_SORT_ORDER_BASE + position,
      provenance,
    };
  });
  assertUnique(hairstyles.map((hairstyle) => hairstyle.slug), "hairstyle slug");
  assertUnique(hairstyles.map((hairstyle) => hairstyle.id), "hairstyle deterministic ID");

  const hairstylesBySlug = new Map(hairstyles.map((hairstyle) => [hairstyle.slug, hairstyle]));
  const variantIndexByHairstyle = new Map<string, number>();
  const variants = variantCreates.map((operation) => {
    const parentSlug = validateSlug(operation.parentTargetSlug);
    const parent = hairstylesBySlug.get(parentSlug);
    if (!parent) throw invalidPlan(`Variant parent ${parentSlug} is not an approved CREATE_INACTIVE hairstyle.`);
    if (!parent.requiresVariant) throw invalidPlan(`Variant parent ${parentSlug} is not variant-priced.`);
    const name = validateName(operation.targetName, "Variant name");
    const manifestSlug = validateSlug(operation.targetSlug);
    assertExplicitlyInactive(operation, "variant", `${parentSlug}:${manifestSlug}`);
    const priceCents = validateDraftPrice(operation.proposedPriceCents, `variant ${parentSlug}:${manifestSlug}`);
    const provenance = validateVariantProvenance(operation, priceCents);
    const position = variantIndexByHairstyle.get(parentSlug) ?? 0;
    variantIndexByHairstyle.set(parentSlug, position + 1);
    return {
      id: deterministicId(computedDigest, "variant", `${parentSlug}:${manifestSlug}`),
      hairstyleSlug: parentSlug,
      name,
      manifestSlug,
      priceCents,
      sortOrder: IMPORT_SORT_ORDER_BASE + position,
      provenance,
    };
  });
  assertUnique(variants.map((variant) => `${variant.hairstyleSlug}:${normalizeIdentity(variant.name)}`), "parent-scoped variant name");
  assertUnique(variants.map((variant) => variant.id), "variant deterministic ID");

  for (const operation of artifact.plan.variantOperations) {
    if (operation.action === "SKIP_UNRESOLVED_PLACEHOLDER" && operation.proposedPriceCents !== null) {
      throw invalidPlan("An unresolved placeholder has a database price.");
    }
  }

  const skipped: PreparedCatalogImport["skipped"] = [];
  for (const [entity, operations] of [
    ["category", artifact.plan.categoryOperations],
    ["hairstyle", artifact.plan.serviceOperations],
    ["variant", artifact.plan.variantOperations],
  ] as const) {
    for (const operation of operations) {
      if (operation.action === "CREATE_INACTIVE") continue;
      skipped.push({
        entity,
        key: operationKey(entity, operation),
        action: String(operation.action),
        reason: typeof operation.reason === "string" ? operation.reason : typeof operation.reviewReason === "string" ? operation.reviewReason : "Not approved for creation.",
      });
    }
  }

  return { digest: computedDigest, artifact, categories, hairstyles, variants, skipped };
}

export async function runCatalogImport(input: {
  prisma: PrismaClient;
  artifact: unknown;
  expectedPlanDigest: string;
  target: CatalogImportTarget;
  apply?: boolean;
  dependencies?: CatalogImportDependencies;
}): Promise<CatalogImportReport> {
  const prepared = validateCatalogImportArtifact(input.artifact, input.expectedPlanDigest);
  if (!input.apply) {
    return input.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await verifyConnectedDatabase(tx, input.target);
      const before = await readCatalogState(tx);
      const state = verifyCatalogState(prepared, before);
      return buildReport(prepared, input.target, "dry-run", state, before.counts, before.counts);
    }, { isolationLevel: "RepeatableRead" });
  }

  try {
    return await input.prisma.$transaction(async (tx) => {
      await verifyConnectedDatabase(tx, input.target);
      await tx.$executeRawUnsafe('LOCK TABLE "HairstyleCategory", "Hairstyle", "HairstyleVariant" IN SHARE ROW EXCLUSIVE MODE');
      const before = await readCatalogState(tx);
      const state = verifyCatalogState(prepared, before);
      if (state === "already-applied") {
        return buildReport(prepared, input.target, "apply", state, before.counts, before.counts);
      }

      const categoryIdBySlug = new Map<string, string>();
      for (const category of prepared.categories) {
        await tx.hairstyleCategory.create({
          data: {
            id: category.id,
            name: category.name,
            slug: category.slug,
            description: null,
            isActive: false,
            sortOrder: category.sortOrder,
          },
        });
        categoryIdBySlug.set(category.slug, category.id);
        await input.dependencies?.afterOperation?.({ entity: "category", id: category.id, key: category.slug });
      }
      for (const operation of prepared.artifact.plan.categoryOperations) {
        if (operation.action !== "CREATE_INACTIVE" && typeof operation.targetSlug === "string" && typeof operation.existingId === "string") {
          categoryIdBySlug.set(operation.targetSlug, operation.existingId);
        }
      }

      const hairstyleIdBySlug = new Map<string, string>();
      for (const hairstyle of prepared.hairstyles) {
        const categoryId = categoryIdBySlug.get(hairstyle.categorySlug);
        if (!categoryId) throw invalidPlan(`Missing category identity for ${hairstyle.categorySlug}.`);
        await tx.hairstyle.create({
          data: {
            id: hairstyle.id,
            categoryId,
            name: hairstyle.name,
            slug: hairstyle.slug,
            description: null,
            priceCents: hairstyle.priceCents,
            requiresVariant: hairstyle.requiresVariant,
            isActive: false,
            sortOrder: hairstyle.sortOrder,
          },
        });
        hairstyleIdBySlug.set(hairstyle.slug, hairstyle.id);
        await input.dependencies?.afterOperation?.({ entity: "hairstyle", id: hairstyle.id, key: hairstyle.slug });
      }

      for (const variant of prepared.variants) {
        const hairstyleId = hairstyleIdBySlug.get(variant.hairstyleSlug);
        if (!hairstyleId) throw invalidPlan(`Missing hairstyle identity for ${variant.hairstyleSlug}.`);
        await tx.hairstyleVariant.create({
          data: {
            id: variant.id,
            hairstyleId,
            name: variant.name,
            description: null,
            priceCents: variant.priceCents,
            isActive: false,
            sortOrder: variant.sortOrder,
          },
        });
        await input.dependencies?.afterOperation?.({ entity: "variant", id: variant.id, key: `${variant.hairstyleSlug}:${variant.manifestSlug}` });
      }

      const after = await readCatalogState(tx);
      const finalState = verifyCatalogState(prepared, after);
      if (finalState !== "already-applied") {
        throw new CatalogImportError("TRANSACTION_FAILED", "Post-import verification did not match the approved plan.", true);
      }
      return buildReport(prepared, input.target, "apply", "pristine", before.counts, after.counts);
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof CatalogImportError && error.transactionRolledBack) throw error;
    if (error instanceof CatalogImportError) {
      throw new CatalogImportError(error.code, error.message, true);
    }
    throw new CatalogImportError(
      "TRANSACTION_FAILED",
      error instanceof Error ? `The catalog transaction failed: ${error.message}` : "The catalog transaction failed.",
      true,
    );
  }
}

async function verifyConnectedDatabase(
  db: Prisma.TransactionClient,
  target: CatalogImportTarget,
) {
  const rows = await db.$queryRawUnsafe<Array<{ database: string }>>(
    "SELECT current_database() AS database",
  );
  if (rows.length !== 1 || rows[0].database !== target.database) {
    throw new CatalogImportError(
      "INVALID_TARGET",
      "The connected database does not match the guarded target identity.",
    );
  }
}

function validateVariantProvenance(operation: JsonRecord, priceCents: number | null): PriceProvenance {
  const source = operation.priceSource;
  const interpretation = operation.priceInterpretation;
  if (!isPriceSource(source) || !isPriceInterpretation(interpretation)) {
    throw invalidPlan(`Variant ${String(operation.targetSlug)} has invalid price provenance.`);
  }
  if (source === "UNRESOLVED" && priceCents !== null) {
    throw invalidPlan("An unresolved variant cannot have a database price.");
  }
  if (source === "MAMACITA_PROVISIONAL" && interpretation !== "exact" && priceCents !== null) {
    throw invalidPlan("A non-exact provisional price cannot become a database price.");
  }
  if (source === "YASMIN_SUPPLIED" && !["exact", "calculated"].includes(interpretation) && priceCents !== null) {
    throw invalidPlan("A Yasmin-supplied database price must be exact or calculated from an approved rule.");
  }
  return {
    source,
    interpretation,
    sourceEntries: splitSourceEntries(operation.sourceEntries),
  };
}

function deriveServicePriceProvenance(
  artifact: CatalogImportArtifact,
  slug: string,
  priceCents: number | null,
): PriceProvenance {
  const decisions = Array.isArray(artifact.provisionalDecisions)
    ? artifact.provisionalDecisions.filter((decision) => decision.consolidationKey === `${slug}:single`)
    : [];
  const eligible = decisions.filter((decision) => decision.disposition === "STORE_INACTIVE_DRAFT_ELIGIBLE");
  const sourceEntries = decisions.map((decision) => String(decision.referenceEntryId ?? "")).filter(Boolean);
  if (priceCents === null) {
    const interpretation = decisions.some((decision) => decision.interpretation === "range")
      ? "range"
      : decisions.some((decision) => decision.interpretation === "starting-at")
        ? "starting-at"
        : decisions.some((decision) => decision.interpretation === "conditional")
          ? "conditional"
          : "unresolved";
    return { source: decisions.length ? "MAMACITA_PROVISIONAL" : "UNRESOLVED", interpretation, sourceEntries };
  }
  if (eligible.length > 0) {
    if (!eligible.every((decision) => decision.preparationPriceCents === priceCents)) {
      throw invalidPlan(`Provisional price evidence for ${slug} does not match the planned draft price.`);
    }
    return { source: "MAMACITA_PROVISIONAL", interpretation: "exact", sourceEntries };
  }
  if (decisions.length > 0) {
    throw invalidPlan(`Reference-only provisional evidence for ${slug} cannot produce a database price.`);
  }
  return { source: "YASMIN_SUPPLIED", interpretation: "exact", sourceEntries: [] };
}

function verifyCatalogState(prepared: PreparedCatalogImport, state: CatalogState): ImportState {
  verifyReferencedExistingRecords(prepared.artifact, state);
  const statuses: Array<"absent" | "applied"> = [];
  const categoryBySlug = new Map(state.categories.map((row) => [row.slug, row]));
  const categoryById = new Map(state.categories.map((row) => [row.id, row]));
  for (const expected of prepared.categories) {
    const byId = categoryById.get(expected.id);
    const bySlug = categoryBySlug.get(expected.slug);
    if (!byId && !bySlug) {
      if (state.categories.some((row) => normalizeIdentity(row.name) === normalizeIdentity(expected.name))) {
        throw collision(`Category name ${expected.name} already exists with another identity.`);
      }
      statuses.push("absent");
      continue;
    }
    if (!byId || bySlug?.id !== expected.id || !sameCategory(byId, expected)) {
      throw collision(`Category ${expected.slug} conflicts with the deterministic import identity.`);
    }
    statuses.push("applied");
  }

  const categoryIds = new Map(prepared.categories.map((row) => [row.slug, row.id]));
  for (const operation of prepared.artifact.plan.categoryOperations) {
    if (operation.action !== "CREATE_INACTIVE" && typeof operation.targetSlug === "string" && typeof operation.existingId === "string") {
      categoryIds.set(operation.targetSlug, operation.existingId);
    }
  }
  const hairstyleBySlug = new Map(state.hairstyles.map((row) => [row.slug, row]));
  const hairstyleById = new Map(state.hairstyles.map((row) => [row.id, row]));
  for (const expected of prepared.hairstyles) {
    const expectedCategoryId = categoryIds.get(expected.categorySlug);
    if (!expectedCategoryId) throw stale(`Parent category ${expected.categorySlug} is unavailable.`);
    const byId = hairstyleById.get(expected.id);
    const bySlug = hairstyleBySlug.get(expected.slug);
    if (!byId && !bySlug) {
      if (state.hairstyles.some((row) => normalizeIdentity(row.name) === normalizeIdentity(expected.name))) {
        throw collision(`Hairstyle name ${expected.name} already exists with another identity.`);
      }
      statuses.push("absent");
      continue;
    }
    if (!byId || bySlug?.id !== expected.id || !sameHairstyle(byId, expected, expectedCategoryId)) {
      throw collision(`Hairstyle ${expected.slug} conflicts with the deterministic import identity.`);
    }
    statuses.push("applied");
  }

  const hairstyleIds = new Map(prepared.hairstyles.map((row) => [row.slug, row.id]));
  const variantById = new Map(state.variants.map((row) => [row.id, row]));
  for (const expected of prepared.variants) {
    const parentId = hairstyleIds.get(expected.hairstyleSlug);
    if (!parentId) throw stale(`Parent hairstyle ${expected.hairstyleSlug} is unavailable.`);
    const byId = variantById.get(expected.id);
    const byName = state.variants.find((row) => row.hairstyleId === parentId && normalizeIdentity(row.name) === normalizeIdentity(expected.name));
    if (!byId && !byName) {
      statuses.push("absent");
      continue;
    }
    if (!byId || byName?.id !== expected.id || !sameVariant(byId, expected, parentId)) {
      throw collision(`Variant ${expected.hairstyleSlug}:${expected.manifestSlug} conflicts with the deterministic import identity.`);
    }
    statuses.push("applied");
  }

  const baseline = prepared.artifact.summary.currentCatalog;
  const expectedApplied = {
    categories: baseline.categories + prepared.categories.length,
    hairstyles: baseline.hairstyles + prepared.hairstyles.length,
    variants: baseline.variants + prepared.variants.length,
  };
  const allAbsent = statuses.every((status) => status === "absent");
  const allApplied = statuses.every((status) => status === "applied");
  if (allAbsent && sameCounts(state.counts, baseline)) return "pristine";
  if (allApplied && sameCounts(state.counts, expectedApplied)) return "already-applied";
  throw stale("The catalog differs from both the reviewed baseline and the fully applied deterministic plan.");
}

function verifyReferencedExistingRecords(artifact: CatalogImportArtifact, state: CatalogState) {
  const categories = new Map(state.categories.map((row) => [row.id, row]));
  for (const operation of artifact.plan.categoryOperations) {
    if (operation.action === "CREATE_INACTIVE" || operation.action === "SKIP_POLICY" || typeof operation.existingId !== "string") continue;
    const row = categories.get(operation.existingId);
    if (!row || row.slug !== operation.targetSlug || (typeof operation.existingActive === "boolean" && row.isActive !== operation.existingActive)) {
      throw stale(`Referenced category ${String(operation.targetSlug)} changed after preview.`);
    }
  }

  const hairstyles = new Map(state.hairstyles.map((row) => [row.id, row]));
  for (const operation of artifact.plan.serviceOperations) {
    if (operation.action === "CREATE_INACTIVE" || typeof operation.existingId !== "string") continue;
    const row = hairstyles.get(operation.existingId);
    if (!row) throw stale(`Referenced hairstyle ${String(operation.targetSlug)} no longer exists.`);
    if (typeof operation.existingSlug === "string" && row.slug !== operation.existingSlug) throw stale(`Referenced hairstyle ${row.id} changed slug.`);
    if (typeof operation.existingName === "string" && row.name !== operation.existingName) throw stale(`Referenced hairstyle ${row.id} changed name.`);
    if (typeof operation.existingCategorySlug === "string" && row.categorySlug !== operation.existingCategorySlug) throw stale(`Referenced hairstyle ${row.id} changed category.`);
    if (typeof operation.existingActive === "boolean" && row.isActive !== operation.existingActive) throw stale(`Referenced hairstyle ${row.id} changed publication state.`);
    if (typeof operation.existingRequiresVariant === "boolean" && row.requiresVariant !== operation.existingRequiresVariant) throw stale(`Referenced hairstyle ${row.id} changed pricing mode.`);
    if ((typeof operation.existingPriceCents === "number" || operation.existingPriceCents === null) && row.priceCents !== operation.existingPriceCents) throw stale(`Referenced hairstyle ${row.id} changed price.`);
    if (typeof operation.appointmentCount === "number" && row.appointmentCount !== operation.appointmentCount) throw stale(`Referenced hairstyle ${row.id} changed appointment references.`);
    if (typeof operation.mediaCount === "number" && row.mediaCount !== operation.mediaCount) throw stale(`Referenced hairstyle ${row.id} changed media references.`);
  }

  const variants = new Map(state.variants.map((row) => [row.id, row]));
  for (const operation of [...artifact.plan.variantOperations, ...(artifact.plan.retainedExistingVariants ?? [])]) {
    if (typeof operation.existingId !== "string" && typeof operation.id !== "string") continue;
    const id = String(operation.existingId ?? operation.id);
    const row = variants.get(id);
    if (!row) throw stale(`Referenced variant ${id} no longer exists.`);
    const expectedName = operation.existingName ?? operation.name;
    const expectedPrice = operation.existingPriceCents ?? operation.priceCents;
    const expectedActive = operation.existingActive ?? operation.isActive;
    if (typeof expectedName === "string" && row.name !== expectedName) throw stale(`Referenced variant ${id} changed name.`);
    if ((typeof expectedPrice === "number" || expectedPrice === null) && row.priceCents !== expectedPrice) throw stale(`Referenced variant ${id} changed price.`);
    if (typeof expectedActive === "boolean" && row.isActive !== expectedActive) throw stale(`Referenced variant ${id} changed publication state.`);
    if (typeof operation.appointmentCount === "number" && row.appointmentCount !== operation.appointmentCount) throw stale(`Referenced variant ${id} changed appointment references.`);
    if (typeof operation.mediaCount === "number" && row.mediaCount !== operation.mediaCount) throw stale(`Referenced variant ${id} changed media references.`);
  }
}

async function readCatalogState(db: Prisma.TransactionClient): Promise<CatalogState> {
  const categories = await db.hairstyleCategory.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      sortOrder: true,
      hairstyles: {
        select: {
          id: true,
          categoryId: true,
          name: true,
          slug: true,
          priceCents: true,
          requiresVariant: true,
          isActive: true,
          sortOrder: true,
          _count: { select: { appointments: true, media: true } },
          variants: {
            select: {
              id: true,
              hairstyleId: true,
              name: true,
              priceCents: true,
              isActive: true,
              sortOrder: true,
              _count: { select: { appointments: true, media: true } },
            },
          },
        },
      },
    },
  });
  const hairstyles = categories.flatMap((category) => category.hairstyles.map((hairstyle) => ({
    id: hairstyle.id,
    categoryId: hairstyle.categoryId,
    categorySlug: category.slug,
    name: hairstyle.name,
    slug: hairstyle.slug,
    priceCents: hairstyle.priceCents,
    requiresVariant: hairstyle.requiresVariant,
    isActive: hairstyle.isActive,
    sortOrder: hairstyle.sortOrder,
    appointmentCount: hairstyle._count.appointments,
    mediaCount: hairstyle._count.media,
  })));
  const variants = categories.flatMap((category) => category.hairstyles.flatMap((hairstyle) => hairstyle.variants.map((variant) => ({
    id: variant.id,
    hairstyleId: variant.hairstyleId,
    hairstyleSlug: hairstyle.slug,
    name: variant.name,
    priceCents: variant.priceCents,
    isActive: variant.isActive,
    sortOrder: variant.sortOrder,
    appointmentCount: variant._count.appointments,
    mediaCount: variant._count.media,
  }))));
  return {
    counts: { categories: categories.length, hairstyles: hairstyles.length, variants: variants.length },
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      isActive: category.isActive,
      sortOrder: category.sortOrder,
    })),
    hairstyles,
    variants,
  };
}

function buildReport(
  prepared: PreparedCatalogImport,
  target: CatalogImportTarget,
  mode: "dry-run" | "apply",
  state: ImportState,
  before: CatalogCounts,
  after: CatalogCounts,
): CatalogImportReport {
  const action: CatalogImportReport["operations"][number]["action"] =
    state === "already-applied"
      ? "already-present"
      : mode === "apply"
        ? "created"
        : "would-create";
  const operations: CatalogImportReport["operations"] = [
    ...prepared.categories.map((row) => ({ entity: "category" as const, action, id: row.id, key: row.slug, active: false as const })),
    ...prepared.hairstyles.map((row) => ({
      entity: "hairstyle" as const,
      action,
      id: row.id,
      key: row.slug,
      active: false as const,
      priceCents: row.priceCents,
      priceSource: row.provenance.source,
      priceInterpretation: row.provenance.interpretation,
      sourceEntries: row.provenance.sourceEntries,
    })),
    ...prepared.variants.map((row) => ({
      entity: "variant" as const,
      action,
      id: row.id,
      key: `${row.hairstyleSlug}:${row.manifestSlug}`,
      active: false as const,
      priceCents: row.priceCents,
      priceSource: row.provenance.source,
      priceInterpretation: row.provenance.interpretation,
      sourceEntries: row.provenance.sourceEntries,
    })),
  ];
  const projected = {
    categories: before.categories + (state === "pristine" ? prepared.categories.length : 0),
    hairstyles: before.hairstyles + (state === "pristine" ? prepared.hairstyles.length : 0),
    variants: before.variants + (state === "pristine" ? prepared.variants.length : 0),
  };
  return {
    mode,
    outcome: state === "already-applied" ? "already-applied" : mode === "apply" ? "applied" : "ready",
    planDigestSha256: prepared.digest,
    target,
    transactionRolledBack: false,
    before,
    after: mode === "dry-run" ? projected : after,
    operations,
    skipped: prepared.skipped,
  };
}

function sameCategory(actual: CatalogState["categories"][number], expected: PreparedCategory) {
  return actual.id === expected.id && actual.name === expected.name && actual.slug === expected.slug && !actual.isActive && actual.sortOrder === expected.sortOrder;
}

function sameHairstyle(actual: CatalogState["hairstyles"][number], expected: PreparedHairstyle, categoryId: string) {
  return actual.id === expected.id && actual.categoryId === categoryId && actual.name === expected.name && actual.slug === expected.slug && actual.priceCents === expected.priceCents && actual.requiresVariant === expected.requiresVariant && !actual.isActive && actual.sortOrder === expected.sortOrder;
}

function sameVariant(actual: CatalogState["variants"][number], expected: PreparedVariant, hairstyleId: string) {
  return actual.id === expected.id && actual.hairstyleId === hairstyleId && actual.name === expected.name && actual.priceCents === expected.priceCents && !actual.isActive && actual.sortOrder === expected.sortOrder;
}

function deterministicId(digest: string, entity: string, key: string) {
  return `imp_${entity.slice(0, 3)}_${createHash("sha256").update(`${digest}:${entity}:${key}`).digest("hex").slice(0, 24)}`;
}

function validateName(value: unknown, label: string) {
  try { return normalizeName(value, label); }
  catch (error) { throw invalidPlan(error instanceof Error ? error.message : `${label} is invalid.`); }
}

function validateSlug(value: unknown) {
  try { return normalizeSlug(value); }
  catch (error) { throw invalidPlan(error instanceof Error ? error.message : "Slug is invalid."); }
}

function validateDraftPrice(value: unknown, label: string) {
  if (value === null || value === undefined) return null;
  try { return normalizeOptionalPriceCents(value); }
  catch (error) { throw invalidPlan(`${label}: ${error instanceof Error ? error.message : "invalid price"}`); }
}

function assertExplicitlyInactive(operation: JsonRecord, entity: string, key: string) {
  if (operation.proposedActive !== false) throw invalidPlan(`${entity} ${key} is not explicitly inactive.`);
}

function assertKnownActions(operations: JsonRecord[], allowed: Set<string>, entity: string) {
  for (const operation of operations) {
    if (typeof operation.action !== "string" || !allowed.has(operation.action)) {
      throw invalidPlan(`Unknown ${entity} operation action.`);
    }
  }
}

function assertUnique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw invalidPlan(`The plan contains a duplicate ${label}.`);
}

function splitSourceEntries(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function operationKey(entity: "category" | "hairstyle" | "variant", operation: JsonRecord) {
  if (entity === "variant") return `${String(operation.parentTargetSlug ?? "unknown")}:${String(operation.targetSlug ?? operation.targetName ?? "unknown")}`;
  return String(operation.targetSlug ?? operation.targetName ?? "unknown");
}

function normalizeIdentity(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCounts(value: unknown): value is CatalogCounts {
  return isRecord(value) && [value.categories, value.hairstyles, value.variants].every((count) => Number.isSafeInteger(count) && Number(count) >= 0);
}

function sameCounts(left: CatalogCounts, right: CatalogCounts) {
  return left.categories === right.categories && left.hairstyles === right.hairstyles && left.variants === right.variants;
}

function isPriceSource(value: unknown): value is PriceProvenance["source"] {
  return ["YASMIN_SUPPLIED", "MAMACITA_PROVISIONAL", "UNRESOLVED"].includes(String(value));
}

function isPriceInterpretation(value: unknown): value is PriceProvenance["interpretation"] {
  return ["exact", "calculated", "conditional", "starting-at", "range", "unresolved"].includes(String(value));
}

function invalidPlan(message: string) {
  return new CatalogImportError("INVALID_PLAN", message);
}

function stale(message: string) {
  return new CatalogImportError("STALE_PLAN", message);
}

function collision(message: string) {
  return new CatalogImportError("CATALOG_COLLISION", message);
}
