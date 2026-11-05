import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  normalizeName,
  normalizeOptionalPriceCents,
  normalizeSlug,
} from "./validation";

export const YASMIN_5A9C_RESET_MANIFEST_DIGEST =
  "312105b0ef57f8fe2ce54b33d1db8290a98a98b836a2d523cd892e3e60b17e5f";
export const YASMIN_5A8_IMPORT_MANIFEST_DIGEST =
  "3c7155dfaae55491f61fb1f5c1a7b430d341663862bf50d74c488771f1d4be13";
export const YASMIN_5A8_SOURCE_PLAN_DIGEST =
  "afc2ad2aa57fa100d851fde7f22989abed01b7fc239c8b701b81af42eb24eacd";
export const YASMIN_5A9C_APPLY_AUTHORIZATION =
  "YASMIN-5A.9C-NEON-FRESH-INITIALIZATION";

const EXPECTED_PRODUCTION_TARGET = {
  projectId: "restless-violet-37068529",
  branchId: "br-damp-thunder-b5qfe9n0",
  endpointId: "ep-dry-brook-b5bm9i7l",
  hostname: "ep-dry-brook-b5bm9i7l.c-7.us-east-2.aws.neon.tech",
  port: 5432,
  database: "neondb",
} as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const REHEARSAL_DATABASE_PREFIX = "yasmin_5a9c_";
const ADMIN_PASSWORD_HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{43,}$/;
const ADMIN_EMAIL_MAX_LENGTH = 254;

export type Fingerprint = { count: number; sha256: string };

const TABLE_SPECS = {
  BookingConfirmationEmail: '"id"',
  AppointmentEvent: '"id"',
  PaymentProcessingException: '"id"',
  Payment: '"id"',
  Appointment: '"id"',
  MarketingConsentEvent: '"id"',
  Customer: '"id"',
  StripeWebhookEvent: '"id"',
  RateLimitCounter: '"scope", "keyHash", "windowStart"',
  HomepageCatalogFeature: '"id"',
  HairstyleMediaCleanupTask: '"id"',
  HairstyleMedia: '"id"',
  HairstyleVariant: '"id"',
  Hairstyle: '"id"',
  HairstyleCategory: '"id"',
  AdminUser: '"id"',
  AdminSession: '"id"',
  SalonLocation: '"id"',
  BookingSlot: '"id"',
  _prisma_migrations: '"id"',
} as const;

export type TableName = keyof typeof TABLE_SPECS;
const DELETE_TABLES = [
  "BookingConfirmationEmail",
  "AppointmentEvent",
  "AdminSession",
  "PaymentProcessingException",
  "Payment",
  "Appointment",
  "MarketingConsentEvent",
  "Customer",
  "StripeWebhookEvent",
  "RateLimitCounter",
  "HomepageCatalogFeature",
  "HairstyleMediaCleanupTask",
  "HairstyleMedia",
  "HairstyleVariant",
  "Hairstyle",
  "HairstyleCategory",
  "BookingSlot",
  "SalonLocation",
  "AdminUser",
] as const satisfies readonly TableName[];
const PRESERVED_TABLES = [
  "_prisma_migrations",
] as const satisfies readonly TableName[];

type JsonRecord = Record<string, unknown>;

export type NeonResetExecutionTarget =
  | {
      mode: "production";
      host: string;
      port: number;
      database: string;
      projectId: string;
      branchId: string;
      endpointId: string;
    }
  | {
      mode: "rehearsal";
      host: string;
      port: number;
      database: string;
    };

export type NeonResetTargetInput =
  | {
      mode: "production";
      databaseUrl: string | undefined;
      projectId: string | undefined;
      branchId: string | undefined;
      endpointId: string | undefined;
    }
  | {
      mode: "rehearsal";
      databaseUrl: string | undefined;
      expectedDatabase: string | undefined;
    };

export type PriceProvenance = {
  source: "YASMIN_SUPPLIED" | "MAMACITA_PROVISIONAL" | "UNRESOLVED";
  interpretation:
    | "exact"
    | "calculated"
    | "conditional"
    | "starting-at"
    | "range"
    | "unresolved";
  sourceEntries: string[];
};

export type CleanSlateCatalogManifest = {
  version: number;
  sourcePlanDigest: string;
  categories: Array<{
    id: string;
    name: string;
    slug: string;
    description: null;
    isActive: false;
    sortOrder: number;
    sourceAction: string;
  }>;
  hairstyles: Array<{
    id: string;
    categorySlug: string;
    name: string;
    slug: string;
    description: null;
    priceCents: number | null;
    requiresVariant: boolean;
    isActive: false;
    sortOrder: number;
    provenance: PriceProvenance;
    sourceAction: string;
  }>;
  variants: Array<{
    id: string;
    hairstyleSlug: string;
    name: string;
    manifestSlug: string;
    description: null;
    priceCents: number | null;
    isActive: false;
    sortOrder: number;
    provenance: PriceProvenance;
    sourceAction: string;
  }>;
  exclusions: {
    categories: unknown[];
    hairstyles: unknown[];
    variants: unknown[];
  };
};

export type ResetManifest = {
  version: number;
  operation: string;
  backup: { filename: string; sha256: string; format: string };
  productionTarget: typeof EXPECTED_PRODUCTION_TARGET;
  trigger: {
    schema: "public";
    table: "MarketingConsentEvent";
    name: "MarketingConsentEvent_append_only";
    functionSchema: "public";
    functionName: "MarketingConsentEvent_append_only";
    enabledState: "O";
    definition: string;
  };
  deleteTables: TableName[];
  baseline: Record<string, Fingerprint>;
  preserved: Record<string, Fingerprint>;
  expectedAfter: Record<string, number>;
  initialization: {
    location: {
      id: "william-street";
      name: "William Street";
      addressLine1: "524 William St";
      addressLine2: null;
      city: "East Orange";
      state: "NJ";
      postalCode: null;
      phone: null;
      timeZone: "America/New_York";
      isActive: true;
      acceptsOnlineBooking: true;
    };
    slots: Array<{ localStartTime: "05:00" | "11:00" | "14:00"; capacity: 10; isActive: true }>;
  };
};

export type NeonResetImportReport = {
  operation: "YASMIN-5A.9C";
  mode: "dry-run" | "apply";
  outcome: "ready" | "applied" | "already-applied";
  target: NeonResetExecutionTarget;
  resetManifestDigest: string;
  importManifestDigest: string;
  sourcePlanDigest: string;
  databaseMutated: boolean;
  transactionRolledBack: false;
  trigger: {
    expectedName: string;
    enabledBefore: boolean;
    enabledAfter: boolean;
  };
  before: Record<string, number>;
  projectedAfter: Record<string, number>;
  after: Record<string, number>;
  preserved: Record<string, Fingerprint>;
  catalog: {
    categories: number;
    hairstyles: number;
    variants: number;
    activeCategories: 0;
    activeHairstyles: 0;
    activeVariants: 0;
    fixedPrices: number;
    unsetPrices: number;
    provenance: Record<string, number>;
  };
  initialization: {
    administratorCount: number;
    administratorEmail: string | null;
    locationCount: number;
    slotCount: number;
  };
  blobObjectsDeleted: 0;
};

export type NeonResetImportDependencies = {
  /** Internal fault-injection seam. The CLI never supplies it. */
  afterStep?: (step: { phase: "reset" | "import"; key: string }) => void | Promise<void>;
};

export class NeonResetImportError extends Error {
  constructor(
    public readonly code:
      | "INVALID_TARGET"
      | "INVALID_MANIFEST"
      | "MANIFEST_DIGEST_MISMATCH"
      | "APPLY_NOT_AUTHORIZED"
      | "DATABASE_DRIFT"
      | "TRIGGER_MISMATCH"
      | "TRIGGER_NOT_RESTORED"
      | "TRANSACTION_FAILED",
    message: string,
    public readonly transactionRolledBack = false,
    public readonly triggerRestored = false,
  ) {
    super(message);
    this.name = "NeonResetImportError";
  }
}

export function computeStableManifestDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function assertNeonResetExecutionTarget(
  input: NeonResetTargetInput,
): NeonResetExecutionTarget {
  if (!input.databaseUrl?.trim()) {
    throw invalidTarget("An explicit database URL is required.");
  }
  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw invalidTarget("The database URL is invalid.");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw invalidTarget("The reset requires PostgreSQL.");
  }
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || "5432");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (input.mode === "rehearsal") {
    if (!LOOPBACK_HOSTS.has(host)) {
      throw invalidTarget("Rehearsal mode accepts only a loopback PostgreSQL host.");
    }
    if (!input.expectedDatabase?.trim() || database !== input.expectedDatabase.trim()) {
      throw invalidTarget("The rehearsal database does not match the explicit expected identity.");
    }
    if (!database.startsWith(REHEARSAL_DATABASE_PREFIX)) {
      throw invalidTarget(`The rehearsal database must begin with ${REHEARSAL_DATABASE_PREFIX}.`);
    }
    if (["yasmin_booking_dev", "yasmin_booking_test", "neondb", "postgres"].includes(database)) {
      throw invalidTarget("Application and production databases are refused in rehearsal mode.");
    }
    return { mode: "rehearsal", host, port, database };
  }

  if (LOOPBACK_HOSTS.has(host)) {
    throw invalidTarget("Production mode refuses local database targets.");
  }
  if (
    host !== EXPECTED_PRODUCTION_TARGET.hostname ||
    port !== EXPECTED_PRODUCTION_TARGET.port ||
    database !== EXPECTED_PRODUCTION_TARGET.database ||
    input.projectId !== EXPECTED_PRODUCTION_TARGET.projectId ||
    input.branchId !== EXPECTED_PRODUCTION_TARGET.branchId ||
    input.endpointId !== EXPECTED_PRODUCTION_TARGET.endpointId
  ) {
    throw invalidTarget("The project, branch, endpoint, host, port, or database differs from the reviewed production identity.");
  }
  const sslMode = url.searchParams.get("sslmode");
  if (!sslMode || ["disable", "allow", "prefer"].includes(sslMode)) {
    throw invalidTarget("Production mode requires an explicit verified TLS database connection.");
  }
  return {
    mode: "production",
    host,
    port,
    database,
    projectId: input.projectId,
    branchId: input.branchId,
    endpointId: input.endpointId,
  };
}

export function validateNeonResetManifests(input: {
  resetManifest: unknown;
  importManifest: unknown;
  expectedResetDigest?: string;
  expectedImportDigest?: string;
}): { reset: ResetManifest; catalog: CleanSlateCatalogManifest } {
  if (!isRecord(input.resetManifest) || !isRecord(input.importManifest)) {
    throw invalidManifest("Both reviewed manifests are required.");
  }
  const expectedResetDigest = input.expectedResetDigest ?? YASMIN_5A9C_RESET_MANIFEST_DIGEST;
  const expectedImportDigest = input.expectedImportDigest ?? YASMIN_5A8_IMPORT_MANIFEST_DIGEST;
  if (computeStableManifestDigest(input.resetManifest) !== expectedResetDigest) {
    throw digestMismatch("The reset manifest digest differs from the reviewed artifact.");
  }
  if (computeStableManifestDigest(input.importManifest) !== expectedImportDigest) {
    throw digestMismatch("The import manifest digest differs from the reviewed artifact.");
  }
  const reset = input.resetManifest as unknown as ResetManifest;
  const catalog = input.importManifest as unknown as CleanSlateCatalogManifest;
  validateResetManifest(reset);
  validateCatalogManifest(catalog);
  return { reset, catalog };
}

export async function runNeonResetImport(input: {
  prisma: PrismaClient;
  target: NeonResetExecutionTarget;
  resetManifest: unknown;
  importManifest: unknown;
  apply?: boolean;
  authorization?: string;
  approvedResetDigest?: string;
  approvedImportDigest?: string;
  verifiedBackupSha256?: string;
  administrator?: { email: string; passwordHash: string };
  dependencies?: NeonResetImportDependencies;
}): Promise<NeonResetImportReport> {
  const { reset, catalog } = validateNeonResetManifests({
    resetManifest: input.resetManifest,
    importManifest: input.importManifest,
  });
  verifyTargetMatchesManifest(input.target, reset);
  if (input.apply) {
    if (
      input.authorization !== YASMIN_5A9C_APPLY_AUTHORIZATION ||
      input.approvedResetDigest !== YASMIN_5A9C_RESET_MANIFEST_DIGEST ||
      input.approvedImportDigest !== YASMIN_5A8_IMPORT_MANIFEST_DIGEST ||
      input.verifiedBackupSha256 !== reset.backup.sha256 ||
      !input.administrator
    ) {
      throw new NeonResetImportError(
        "APPLY_NOT_AUTHORIZED",
        "Apply requires the exact authorization phrase, both reviewed digests, the verified backup digest, and an administrator supplied through the secure bootstrap channel.",
      );
    }
    validateAdministratorBootstrap(input.administrator);
  }

  if (!input.apply) {
    return input.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await verifyConnectedDatabase(tx, input.target);
      await verifyExecutionPrivileges(tx);
      const trigger = await assertExpectedTrigger(tx, reset, "O");
      const state = await inspectDatabaseState(tx, reset, catalog);
      return buildReport({
        mode: "dry-run",
        outcome: state.state === "applied" ? "already-applied" : "ready",
        target: input.target,
        reset,
        catalog,
        before: state.counts,
        after: state.counts,
        databaseMutated: false,
        triggerEnabledBefore: trigger.enabled === "O",
        triggerEnabledAfter: trigger.enabled === "O",
        preserved: state.preserved,
      });
    }, { isolationLevel: "RepeatableRead" });
  }

  let beganFromBaseline = false;
  let triggerWasVerified = false;
  try {
    const report = await input.prisma.$transaction(async (tx) => {
      await verifyConnectedDatabase(tx, input.target);
      await verifyExecutionPrivileges(tx);
      await lockOperationTables(tx);
      const triggerBefore = await assertExpectedTrigger(tx, reset, "O");
      triggerWasVerified = true;
      const state = await inspectDatabaseState(tx, reset, catalog, input.administrator!.email);
      if (state.state === "applied") {
        return buildReport({
          mode: "apply",
          outcome: "already-applied",
          target: input.target,
          reset,
          catalog,
          before: state.counts,
          after: state.counts,
          databaseMutated: false,
          triggerEnabledBefore: true,
          triggerEnabledAfter: true,
          preserved: state.preserved,
          administratorEmail: input.administrator!.email,
        });
      }
      beganFromBaseline = true;

      for (const table of [
        "BookingConfirmationEmail",
        "AppointmentEvent",
        "AdminSession",
        "PaymentProcessingException",
        "Payment",
        "Appointment",
      ] as const) {
        await deleteExpectedRows(tx, table, reset.baseline[table].count);
        await input.dependencies?.afterStep?.({ phase: "reset", key: table });
      }

      await tx.$executeRawUnsafe('ALTER TABLE "MarketingConsentEvent" DISABLE TRIGGER "MarketingConsentEvent_append_only"');
      await assertExpectedTrigger(tx, reset, "D");
      await input.dependencies?.afterStep?.({ phase: "reset", key: "MarketingConsentEvent:trigger-disabled" });
      await deleteExpectedRows(tx, "MarketingConsentEvent", reset.baseline.MarketingConsentEvent.count);
      await tx.$executeRawUnsafe('ALTER TABLE "MarketingConsentEvent" ENABLE TRIGGER "MarketingConsentEvent_append_only"');
      await assertExpectedTrigger(tx, reset, "O");
      await input.dependencies?.afterStep?.({ phase: "reset", key: "MarketingConsentEvent" });

      for (const table of [
        "Customer",
        "StripeWebhookEvent",
        "RateLimitCounter",
        "HomepageCatalogFeature",
        "HairstyleMediaCleanupTask",
        "HairstyleMedia",
        "HairstyleVariant",
        "Hairstyle",
        "HairstyleCategory",
        "BookingSlot",
        "SalonLocation",
        "AdminUser",
      ] as const) {
        await deleteExpectedRows(tx, table, reset.baseline[table].count);
        await input.dependencies?.afterStep?.({ phase: "reset", key: table });
      }

      const location = reset.initialization.location;
      await tx.salonLocation.create({ data: location });
      await input.dependencies?.afterStep?.({ phase: "import", key: "location:william-street" });
      for (const slot of reset.initialization.slots) {
        await tx.bookingSlot.create({
          data: {
            locationId: location.id,
            localStartTime: timeOfDay(slot.localStartTime),
            capacity: slot.capacity,
            isActive: slot.isActive,
          },
        });
        await input.dependencies?.afterStep?.({ phase: "import", key: `slot:${slot.localStartTime}` });
      }
      await tx.adminUser.create({
        data: {
          email: normalizeAdminEmail(input.administrator!.email)!,
          passwordHash: input.administrator!.passwordHash,
          passwordUpdatedAt: new Date(),
        },
      });
      await input.dependencies?.afterStep?.({ phase: "import", key: "administrator" });

      const categoryIdBySlug = new Map<string, string>();
      for (const category of catalog.categories) {
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
        await input.dependencies?.afterStep?.({ phase: "import", key: `category:${category.slug}` });
      }

      const hairstyleIdBySlug = new Map<string, string>();
      for (const hairstyle of catalog.hairstyles) {
        const categoryId = categoryIdBySlug.get(hairstyle.categorySlug);
        if (!categoryId) throw invalidManifest(`Missing category ${hairstyle.categorySlug}.`);
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
        await input.dependencies?.afterStep?.({ phase: "import", key: `hairstyle:${hairstyle.slug}` });
      }

      for (const variant of catalog.variants) {
        const hairstyleId = hairstyleIdBySlug.get(variant.hairstyleSlug);
        if (!hairstyleId) throw invalidManifest(`Missing hairstyle ${variant.hairstyleSlug}.`);
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
        await input.dependencies?.afterStep?.({
          phase: "import",
          key: `variant:${variant.hairstyleSlug}:${variant.manifestSlug}`,
        });
      }

      await assertExpectedTrigger(tx, reset, "O");
      const after = await inspectDatabaseState(tx, reset, catalog, input.administrator!.email);
      if (after.state !== "applied") {
        throw drift("Post-import state does not match the reviewed clean-slate manifest.");
      }
      return buildReport({
        mode: "apply",
        outcome: "applied",
        target: input.target,
        reset,
        catalog,
        before: Object.fromEntries(Object.entries(reset.baseline).map(([table, value]) => [table, value.count])),
        after: after.counts,
        databaseMutated: true,
        triggerEnabledBefore: triggerBefore.enabled === "O",
        triggerEnabledAfter: true,
        preserved: after.preserved,
        administratorEmail: input.administrator!.email,
      });
    }, { isolationLevel: "Serializable", maxWait: 30_000, timeout: 120_000 });

    await assertExpectedTrigger(input.prisma, reset, "O");
    return report;
  } catch (error) {
    let triggerRestored = false;
    try {
      if (triggerWasVerified) {
        await assertExpectedTrigger(input.prisma, reset, "O");
        triggerRestored = true;
      }
      if (beganFromBaseline) {
        const state = await inspectDatabaseState(input.prisma, reset, catalog);
        if (state.state !== "baseline") {
          throw drift("The failed transaction did not restore the reviewed baseline.");
        }
      }
    } catch (verificationError) {
      throw new NeonResetImportError(
        "TRIGGER_NOT_RESTORED",
        verificationError instanceof Error
          ? `Rollback verification failed: ${verificationError.message}`
          : "Rollback verification failed.",
        true,
        false,
      );
    }
    if (error instanceof NeonResetImportError) {
      throw new NeonResetImportError(error.code, error.message, true, triggerRestored);
    }
    throw new NeonResetImportError(
      "TRANSACTION_FAILED",
      error instanceof Error ? `The reset/import transaction failed: ${error.message}` : "The reset/import transaction failed.",
      true,
      triggerRestored,
    );
  }
}

function validateResetManifest(manifest: ResetManifest) {
  if (manifest.version !== 2 || manifest.operation !== "YASMIN-5A.9C") {
    throw invalidManifest("The reset manifest version or operation is invalid.");
  }
  if (stableStringify(manifest.productionTarget) !== stableStringify(EXPECTED_PRODUCTION_TARGET)) {
    throw invalidManifest("The reset manifest production identity is not the reviewed target.");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.backup.sha256)) {
    throw invalidManifest("The reset manifest is missing the verified backup digest.");
  }
  if (stableStringify(manifest.deleteTables) !== stableStringify([...DELETE_TABLES])) {
    throw invalidManifest("The reset table list differs from the 19 reviewed application tables.");
  }
  for (const table of DELETE_TABLES) {
    validateFingerprint(manifest.baseline[table], table);
    if (!Number.isInteger(manifest.expectedAfter[table]) || manifest.expectedAfter[table] < 0) {
      throw invalidManifest(`Invalid expected post-reset count for ${table}.`);
    }
  }
  for (const table of PRESERVED_TABLES) validateFingerprint(manifest.preserved[table], table);
  const expectedInitialization: ResetManifest["initialization"] = {
    location: {
      id: "william-street",
      name: "William Street",
      addressLine1: "524 William St",
      addressLine2: null,
      city: "East Orange",
      state: "NJ",
      postalCode: null,
      phone: null,
      timeZone: "America/New_York",
      isActive: true,
      acceptsOnlineBooking: true,
    },
    slots: [
      { localStartTime: "05:00", capacity: 10, isActive: true },
      { localStartTime: "11:00", capacity: 10, isActive: true },
      { localStartTime: "14:00", capacity: 10, isActive: true },
    ],
  };
  if (stableStringify(manifest.initialization) !== stableStringify(expectedInitialization)) {
    throw invalidManifest("The William Street location or booking-slot initialization differs from the approved configuration.");
  }
  if (
    manifest.trigger.schema !== "public" ||
    manifest.trigger.table !== "MarketingConsentEvent" ||
    manifest.trigger.name !== "MarketingConsentEvent_append_only" ||
    manifest.trigger.functionSchema !== "public" ||
    manifest.trigger.functionName !== "MarketingConsentEvent_append_only" ||
    manifest.trigger.enabledState !== "O"
  ) {
    throw invalidManifest("The append-only trigger identity differs from the reviewed baseline.");
  }
}

function validateCatalogManifest(manifest: CleanSlateCatalogManifest) {
  if (manifest.version !== 1 || manifest.sourcePlanDigest !== YASMIN_5A8_SOURCE_PLAN_DIGEST) {
    throw invalidManifest("The clean-slate catalog does not derive from the reviewed 5A.4 plan.");
  }
  if (manifest.categories.length !== 17 || manifest.hairstyles.length !== 45 || manifest.variants.length !== 63) {
    throw invalidManifest("The clean-slate catalog must contain exactly 17 categories, 45 hairstyles, and 63 variants.");
  }
  const ids = new Set<string>();
  const categorySlugs = new Set<string>();
  for (const category of manifest.categories) {
    validateId(category.id, ids);
    const slug = validateSlugValue(category.slug);
    validateNameValue(category.name);
    if (categorySlugs.has(slug) || category.isActive !== false || category.description !== null) {
      throw invalidManifest(`Invalid or duplicate category ${slug}.`);
    }
    categorySlugs.add(slug);
  }
  const hairstyleSlugs = new Set<string>();
  for (const hairstyle of manifest.hairstyles) {
    validateId(hairstyle.id, ids);
    const slug = validateSlugValue(hairstyle.slug);
    validateNameValue(hairstyle.name);
    if (
      hairstyleSlugs.has(slug) ||
      !categorySlugs.has(hairstyle.categorySlug) ||
      hairstyle.isActive !== false ||
      hairstyle.description !== null
    ) {
      throw invalidManifest(`Invalid or duplicate hairstyle ${slug}.`);
    }
    const price = validateDraftPrice(hairstyle.priceCents, `hairstyle ${slug}`);
    if (hairstyle.requiresVariant && price !== null) {
      throw invalidManifest(`Variant-priced hairstyle ${slug} cannot have a service price.`);
    }
    validateProvenance(hairstyle.provenance, price, `hairstyle ${slug}`);
    hairstyleSlugs.add(slug);
  }
  const variantNames = new Set<string>();
  const variantKeys = new Set<string>();
  const variantParents = new Set(manifest.hairstyles.filter((row) => row.requiresVariant).map((row) => row.slug));
  for (const variant of manifest.variants) {
    validateId(variant.id, ids);
    validateNameValue(variant.name);
    const manifestSlug = validateSlugValue(variant.manifestSlug);
    const key = `${variant.hairstyleSlug}:${manifestSlug}`;
    const nameKey = `${variant.hairstyleSlug}:${variant.name.trim().toLowerCase()}`;
    if (
      !variantParents.has(variant.hairstyleSlug) ||
      variantKeys.has(key) ||
      variantNames.has(nameKey) ||
      variant.isActive !== false ||
      variant.description !== null
    ) {
      throw invalidManifest(`Invalid or duplicate variant ${key}.`);
    }
    const price = validateDraftPrice(variant.priceCents, `variant ${key}`);
    validateProvenance(variant.provenance, price, `variant ${key}`);
    variantKeys.add(key);
    variantNames.add(nameKey);
  }
}

async function inspectDatabaseState(
  db: Prisma.TransactionClient | PrismaClient,
  reset: ResetManifest,
  catalog: CleanSlateCatalogManifest,
  expectedAdministratorEmail?: string,
): Promise<{
  state: "baseline" | "applied";
  counts: Record<string, number>;
  preserved: Record<string, Fingerprint>;
}> {
  const targetFingerprints = await fingerprintTables(db, DELETE_TABLES);
  const preserved = await fingerprintTables(db, PRESERVED_TABLES);
  const preservedMatches = fingerprintsEqual(reset.preserved, preserved, PRESERVED_TABLES);
  if (!preservedMatches) throw drift("The Prisma migration history changed after review.");
  const counts = Object.fromEntries(Object.entries(targetFingerprints).map(([table, value]) => [table, value.count]));
  if (fingerprintsEqual(reset.baseline, targetFingerprints, DELETE_TABLES)) {
    return { state: "baseline", counts, preserved };
  }

  for (const table of DELETE_TABLES) {
    if (counts[table] !== reset.expectedAfter[table]) {
      throw drift(`${table} differs from both the reviewed baseline and expected applied state.`);
    }
  }
  await verifyAppliedCatalog(db, catalog);
  await verifyAppliedInitialization(db, reset, expectedAdministratorEmail);
  return { state: "applied", counts, preserved };
}

async function verifyAppliedInitialization(
  db: Prisma.TransactionClient | PrismaClient,
  reset: ResetManifest,
  expectedAdministratorEmail?: string,
) {
  const [administrators, sessions, locations, slots] = await Promise.all([
    db.adminUser.findMany({
      select: { email: true, passwordHash: true, disabledAt: true },
      orderBy: { email: "asc" },
    }),
    db.adminSession.count(),
    db.salonLocation.findMany({
      select: {
        id: true,
        name: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
        phone: true,
        timeZone: true,
        isActive: true,
        acceptsOnlineBooking: true,
      },
      orderBy: { id: "asc" },
    }),
    db.bookingSlot.findMany({
      select: { locationId: true, localStartTime: true, capacity: true, isActive: true },
      orderBy: { localStartTime: "asc" },
    }),
  ]);
  const expectedEmail = expectedAdministratorEmail
    ? normalizeAdminEmail(expectedAdministratorEmail)
    : null;
  if (
    administrators.length !== 1 ||
    administrators[0]?.disabledAt !== null ||
    !validAdminPasswordHash(administrators[0]?.passwordHash) ||
    (expectedEmail !== null && administrators[0]?.email !== expectedEmail) ||
    sessions !== 0
  ) {
    throw drift("The initialized administrator or zero-session state differs from the approved baseline.");
  }
  if (stableStringify(locations) !== stableStringify([reset.initialization.location])) {
    throw drift("The initialized William Street location differs from the approved configuration.");
  }
  const expectedSlots = reset.initialization.slots.map((slot) => ({
    locationId: reset.initialization.location.id,
    localStartTime: timeOfDay(slot.localStartTime),
    capacity: slot.capacity,
    isActive: slot.isActive,
  }));
  if (stableStringify(slots) !== stableStringify(expectedSlots)) {
    throw drift("The initialized William Street booking slots differ from the approved configuration.");
  }
}

async function verifyAppliedCatalog(
  db: Prisma.TransactionClient | PrismaClient,
  manifest: CleanSlateCatalogManifest,
) {
  const categories = await db.hairstyleCategory.findMany({
    select: { id: true, name: true, slug: true, description: true, isActive: true, sortOrder: true },
    orderBy: { id: "asc" },
  });
  const hairstyles = await db.hairstyle.findMany({
    select: {
      id: true,
      categoryId: true,
      name: true,
      slug: true,
      description: true,
      priceCents: true,
      requiresVariant: true,
      isActive: true,
      sortOrder: true,
    },
    orderBy: { id: "asc" },
  });
  const variants = await db.hairstyleVariant.findMany({
    select: {
      id: true,
      hairstyleId: true,
      name: true,
      description: true,
      priceCents: true,
      isActive: true,
      sortOrder: true,
    },
    orderBy: { id: "asc" },
  });
  const categoryIds = new Map(manifest.categories.map((row) => [row.slug, row.id]));
  const hairstyleIds = new Map(manifest.hairstyles.map((row) => [row.slug, row.id]));
  const expectedCategories = manifest.categories.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: null,
    isActive: false,
    sortOrder: row.sortOrder,
  })).sort(compareId);
  const expectedHairstyles = manifest.hairstyles.map((row) => ({
    id: row.id,
    categoryId: categoryIds.get(row.categorySlug),
    name: row.name,
    slug: row.slug,
    description: null,
    priceCents: row.priceCents,
    requiresVariant: row.requiresVariant,
    isActive: false,
    sortOrder: row.sortOrder,
  })).sort(compareId);
  const expectedVariants = manifest.variants.map((row) => ({
    id: row.id,
    hairstyleId: hairstyleIds.get(row.hairstyleSlug),
    name: row.name,
    description: null,
    priceCents: row.priceCents,
    isActive: false,
    sortOrder: row.sortOrder,
  })).sort(compareId);
  if (
    stableStringify(categories) !== stableStringify(expectedCategories) ||
    stableStringify(hairstyles) !== stableStringify(expectedHairstyles) ||
    stableStringify(variants) !== stableStringify(expectedVariants)
  ) {
    throw drift("The applied catalog differs from the exact reviewed identities, prices, or inactive states.");
  }
}

export async function fingerprintTables(
  db: Prisma.TransactionClient | PrismaClient,
  tables: readonly TableName[],
): Promise<Record<string, Fingerprint>> {
  const output: Record<string, Fingerprint> = {};
  for (const table of tables) {
    // PostgreSQL renders timestamptz values (including values nested in arrays,
    // ranges, and composites) in the session timezone before to_jsonb() turns
    // them into JSON strings. Set UTC inside the same statement so this also
    // works for the rollback verifier, which intentionally uses PrismaClient
    // outside an explicit transaction. MATERIALIZED forces the setting before
    // row serialization; transaction-local scope prevents a persistent pooled-
    // connection setting from leaking into later work.
    const rows = await db.$queryRawUnsafe<Array<{ row: string }>>(
      `WITH canonical_timezone AS MATERIALIZED (
         SELECT set_config('TimeZone', 'UTC', true)
       )
       SELECT to_jsonb(t)::text AS row
       FROM "${table}" t
       CROSS JOIN canonical_timezone
       ORDER BY ${TABLE_SPECS[table]}`,
    );
    output[table] = {
      count: rows.length,
      sha256: createHash("sha256").update(rows.map((item) => item.row).join("\n")).digest("hex"),
    };
  }
  return output;
}

async function verifyConnectedDatabase(
  db: Prisma.TransactionClient,
  target: NeonResetExecutionTarget,
) {
  const rows = await db.$queryRawUnsafe<Array<{ database: string; port: number }>>(
    "SELECT current_database() AS database, inet_server_port() AS port",
  );
  if (rows.length !== 1 || rows[0].database !== target.database || rows[0].port !== target.port) {
    throw invalidTarget("The effective PostgreSQL database or port differs from the guarded target.");
  }
}

async function verifyExecutionPrivileges(db: Prisma.TransactionClient) {
  const deleteChecks = DELETE_TABLES.map((table) =>
    `has_table_privilege(current_user, '"${table}"', 'DELETE')`,
  ).join(" AND ");
  const rows = await db.$queryRawUnsafe<Array<{
    canDelete: boolean;
    canInitialize: boolean;
    ownsConsentTable: boolean;
  }>>(`
    SELECT
      (${deleteChecks}) AS "canDelete",
      has_table_privilege(current_user, '"HairstyleCategory"', 'INSERT')
        AND has_table_privilege(current_user, '"Hairstyle"', 'INSERT')
        AND has_table_privilege(current_user, '"HairstyleVariant"', 'INSERT')
        AND has_table_privilege(current_user, '"SalonLocation"', 'INSERT')
        AND has_table_privilege(current_user, '"BookingSlot"', 'INSERT')
        AND has_table_privilege(current_user, '"AdminUser"', 'INSERT') AS "canInitialize",
      pg_has_role(current_user, c.relowner, 'USAGE') AS "ownsConsentTable"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'MarketingConsentEvent'
  `);
  const row = rows[0];
  if (rows.length !== 1 || !row?.canDelete || !row.canInitialize || !row.ownsConsentTable) {
    throw new NeonResetImportError(
      "INVALID_TARGET",
      "The connected role lacks the reviewed DELETE, initialization INSERT, or exact-trigger ownership capability.",
    );
  }
}

async function assertExpectedTrigger(
  db: Prisma.TransactionClient | PrismaClient,
  reset: ResetManifest,
  expectedState: "O" | "D",
) {
  const rows = await db.$queryRawUnsafe<Array<{
    name: string;
    enabled: string;
    tableSchema: string;
    tableName: string;
    functionSchema: string;
    functionName: string;
    definition: string;
  }>>(`
    SELECT
      t.tgname AS name,
      t.tgenabled AS enabled,
      n.nspname AS "tableSchema",
      c.relname AS "tableName",
      pn.nspname AS "functionSchema",
      p.proname AS "functionName",
      pg_get_triggerdef(t.oid, true) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE NOT t.tgisinternal
      AND n.nspname = 'public'
      AND c.relname = 'MarketingConsentEvent'
  `);
  const expected = reset.trigger;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.name !== expected.name ||
    row.enabled !== expectedState ||
    row.tableSchema !== expected.schema ||
    row.tableName !== expected.table ||
    row.functionSchema !== expected.functionSchema ||
    row.functionName !== expected.functionName ||
    row.definition !== expected.definition
  ) {
    throw new NeonResetImportError(
      "TRIGGER_MISMATCH",
      "The MarketingConsentEvent append-only trigger identity, definition, or enabled state differs from the reviewed baseline.",
    );
  }
  return row;
}

async function lockOperationTables(db: Prisma.TransactionClient) {
  await db.$executeRawUnsafe(
    `LOCK TABLE ${DELETE_TABLES.map((table) => `"${table}"`).join(", ")} IN ACCESS EXCLUSIVE MODE`,
  );
  await db.$executeRawUnsafe(
    `LOCK TABLE ${PRESERVED_TABLES.map((table) => `"${table}"`).join(", ")} IN SHARE MODE`,
  );
}

async function deleteExpectedRows(
  db: Prisma.TransactionClient,
  table: (typeof DELETE_TABLES)[number],
  expectedCount: number,
) {
  const deleted = await db.$executeRawUnsafe(`DELETE FROM "${table}"`);
  if (deleted !== expectedCount) {
    throw drift(`${table} deleted ${deleted} rows; expected ${expectedCount}.`);
  }
}

function buildReport(input: {
  mode: "dry-run" | "apply";
  outcome: NeonResetImportReport["outcome"];
  target: NeonResetExecutionTarget;
  reset: ResetManifest;
  catalog: CleanSlateCatalogManifest;
  before: Record<string, number>;
  after: Record<string, number>;
  databaseMutated: boolean;
  triggerEnabledBefore: boolean;
  triggerEnabledAfter: boolean;
  preserved: Record<string, Fingerprint>;
  administratorEmail?: string;
}): NeonResetImportReport {
  const priceRows = [...input.catalog.hairstyles, ...input.catalog.variants];
  const provenance: Record<string, number> = {};
  for (const row of priceRows) {
    const key = `${row.provenance.source}:${row.provenance.interpretation}:${row.priceCents === null ? "unset" : "fixed"}`;
    provenance[key] = (provenance[key] ?? 0) + 1;
  }
  return {
    operation: "YASMIN-5A.9C",
    mode: input.mode,
    outcome: input.outcome,
    target: input.target,
    resetManifestDigest: YASMIN_5A9C_RESET_MANIFEST_DIGEST,
    importManifestDigest: YASMIN_5A8_IMPORT_MANIFEST_DIGEST,
    sourcePlanDigest: YASMIN_5A8_SOURCE_PLAN_DIGEST,
    databaseMutated: input.databaseMutated,
    transactionRolledBack: false,
    trigger: {
      expectedName: input.reset.trigger.name,
      enabledBefore: input.triggerEnabledBefore,
      enabledAfter: input.triggerEnabledAfter,
    },
    before: input.before,
    projectedAfter: input.reset.expectedAfter,
    after: input.after,
    preserved: input.preserved,
    catalog: {
      categories: input.catalog.categories.length,
      hairstyles: input.catalog.hairstyles.length,
      variants: input.catalog.variants.length,
      activeCategories: 0,
      activeHairstyles: 0,
      activeVariants: 0,
      fixedPrices: priceRows.filter((row) => row.priceCents !== null).length,
      unsetPrices: priceRows.filter((row) => row.priceCents === null).length,
      provenance,
    },
    initialization: {
      administratorCount: input.reset.expectedAfter.AdminUser,
      administratorEmail: input.administratorEmail ? normalizeAdminEmail(input.administratorEmail) : null,
      locationCount: input.reset.expectedAfter.SalonLocation,
      slotCount: input.reset.expectedAfter.BookingSlot,
    },
    blobObjectsDeleted: 0,
  };
}

function verifyTargetMatchesManifest(target: NeonResetExecutionTarget, reset: ResetManifest) {
  if (target.mode === "production" && stableStringify({
    projectId: target.projectId,
    branchId: target.branchId,
    endpointId: target.endpointId,
    hostname: target.host,
    port: target.port,
    database: target.database,
  }) !== stableStringify(reset.productionTarget)) {
    throw invalidTarget("The guarded production target differs from the reset manifest.");
  }
}

function fingerprintsEqual(
  expected: Record<string, Fingerprint>,
  actual: Record<string, Fingerprint>,
  tables: readonly TableName[],
) {
  return tables.every((table) =>
    expected[table]?.count === actual[table]?.count && expected[table]?.sha256 === actual[table]?.sha256,
  );
}

function validateFingerprint(value: Fingerprint | undefined, table: string) {
  if (!value || !Number.isInteger(value.count) || value.count < 0 || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw invalidManifest(`Invalid baseline fingerprint for ${table}.`);
  }
}

function validateId(id: unknown, ids: Set<string>) {
  if (typeof id !== "string" || !/^y5a8_(category|hairstyle|variant)_[a-f0-9]{24}$/.test(id) || ids.has(id)) {
    throw invalidManifest("Catalog IDs must be unique deterministic YASMIN-5A.8 identities.");
  }
  ids.add(id);
}

function validateNameValue(value: unknown) {
  if (typeof value !== "string" || normalizeName(value) !== value) {
    throw invalidManifest("Catalog names must be normalized non-empty values.");
  }
}

function validateSlugValue(value: unknown) {
  if (typeof value !== "string" || normalizeSlug(value) !== value) {
    throw invalidManifest("Catalog slugs must be normalized stable values.");
  }
  return value;
}

function validateDraftPrice(value: unknown, label: string): number | null {
  let normalized: number | null;
  try {
    normalized = normalizeOptionalPriceCents(value);
  } catch (error) {
    throw invalidManifest(error instanceof Error ? error.message : `Invalid price for ${label}.`);
  }
  if (normalized !== null && normalized < 4_000) {
    throw invalidManifest(`${label} price must meet the existing $40 deposit floor.`);
  }
  return normalized;
}

function validateProvenance(provenance: PriceProvenance, price: number | null, label: string) {
  if (
    !isRecord(provenance) ||
    !new Set(["YASMIN_SUPPLIED", "MAMACITA_PROVISIONAL", "UNRESOLVED"]).has(provenance.source) ||
    !new Set(["exact", "calculated", "conditional", "starting-at", "range", "unresolved"]).has(provenance.interpretation) ||
    !Array.isArray(provenance.sourceEntries) ||
    !provenance.sourceEntries.every((entry) => typeof entry === "string" && entry.trim() === entry && entry.length > 0)
  ) {
    throw invalidManifest(`${label} has invalid price provenance.`);
  }
  if (provenance.source === "UNRESOLVED" && price !== null) {
    throw invalidManifest(`${label} cannot store a price with unresolved provenance.`);
  }
  if (provenance.source === "MAMACITA_PROVISIONAL" && provenance.interpretation !== "exact" && price !== null) {
    throw invalidManifest(`${label} cannot turn conditional, starting-at, range, or unresolved provisional evidence into a fixed price.`);
  }
  if (provenance.source === "YASMIN_SUPPLIED" && !new Set(["exact", "calculated"]).has(provenance.interpretation) && price !== null) {
    throw invalidManifest(`${label} has an unsupported Yasmin-supplied price interpretation.`);
  }
}

function validateAdministratorBootstrap(administrator: { email: string; passwordHash: string }) {
  const normalizedEmail = normalizeAdminEmail(administrator.email);
  if (!normalizedEmail || normalizedEmail !== administrator.email.trim().toLowerCase()) {
    throw new NeonResetImportError(
      "APPLY_NOT_AUTHORIZED",
      "The administrator email must be explicitly supplied in normalized form.",
    );
  }
  if (!validAdminPasswordHash(administrator.passwordHash)) {
    throw new NeonResetImportError(
      "APPLY_NOT_AUTHORIZED",
      "The administrator password must be supplied as an existing application scrypt hash.",
    );
  }
}

function validAdminPasswordHash(value: string | null | undefined): boolean {
  const match = typeof value === "string" ? ADMIN_PASSWORD_HASH_PATTERN.exec(value) : null;
  if (!match) return false;
  const [n, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return Number.isInteger(n) && n >= 2 ** 14 && n <= 2 ** 20 && (n & (n - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= 16
    && Number.isInteger(p) && p >= 1 && p <= 4;
}

function normalizeAdminEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= ADMIN_EMAIL_MAX_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}

function timeOfDay(time: "05:00" | "11:00" | "14:00") {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

function compareId<T extends { id: string }>(left: T, right: T) {
  return left.id.localeCompare(right.id);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw invalidManifest("Manifest contains an unsupported undefined value.");
  return serialized;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTarget(message: string) {
  return new NeonResetImportError("INVALID_TARGET", message);
}

function invalidManifest(message: string) {
  return new NeonResetImportError("INVALID_MANIFEST", message);
}

function digestMismatch(message: string) {
  return new NeonResetImportError("MANIFEST_DIGEST_MISMATCH", message);
}

function drift(message: string) {
  return new NeonResetImportError("DATABASE_DRIFT", message);
}
