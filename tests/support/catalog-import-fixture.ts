import { computeCatalogImportPlanDigest } from "../../lib/catalog/importer";

type FixtureOptions = {
  counts?: { categories: number; hairstyles: number; variants: number };
  categorySlug?: string;
  hairstyleSlug?: string;
  priceCents?: number | null;
  requiresVariant?: boolean;
  variantPriceCents?: number | null;
};

export function catalogImportFixture(options: FixtureOptions = {}) {
  const categorySlug = options.categorySlug ?? "new-braids";
  const hairstyleSlug = options.hairstyleSlug ?? "new-bob";
  const requiresVariant = options.requiresVariant ?? true;
  const priceCents = options.priceCents ?? null;
  const variantPriceCents = options.variantPriceCents === undefined ? 24_000 : options.variantPriceCents;
  const plan = {
    version: 1,
    mode: "DRY_RUN_READ_ONLY",
    blockers: [],
    target: { source: "fixture" },
    safety: { createsInactiveOnly: true },
    categoryOperations: [
      {
        entity: "category",
        targetSlug: categorySlug,
        targetName: "New Braids",
        action: "CREATE_INACTIVE",
        proposedActive: false,
        reason: "Fixture create",
      },
    ],
    serviceOperations: [
      {
        entity: "hairstyle",
        targetSlug: hairstyleSlug,
        targetName: "New Bob",
        action: "CREATE_INACTIVE",
        proposedCategorySlug: categorySlug,
        proposedRequiresVariant: requiresVariant,
        proposedPriceCents: priceCents,
        proposedActive: false,
        reason: "Fixture create",
      },
    ],
    variantOperations: requiresVariant
      ? [
          {
            entity: "variant",
            parentTargetSlug: hairstyleSlug,
            targetSlug: "medium",
            targetName: "Medium",
            action: "CREATE_INACTIVE",
            proposedPriceCents: variantPriceCents,
            proposedActive: false,
            priceSource: variantPriceCents === null ? "UNRESOLVED" : "YASMIN_SUPPLIED",
            priceInterpretation: variantPriceCents === null ? "unresolved" : "exact",
            sourceEntries: variantPriceCents === null ? "" : "YAS-TEST",
            reason: "Fixture create",
          },
        ]
      : [],
    retainedExistingServices: [],
    retainedExistingVariants: [],
  };
  const digest = computeCatalogImportPlanDigest(plan);
  return {
    digest,
    artifact: {
      summary: {
        planDigestSha256: digest,
        currentCatalog: options.counts ?? { categories: 0, hairstyles: 0, variants: 0 },
      },
      plan,
      provisionalDecisions: [],
    },
  };
}
