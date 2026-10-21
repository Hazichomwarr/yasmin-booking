import {
  createCategory,
  createHairstyle,
  createHairstyleVariant,
  deactivateHairstyle,
  deactivateHairstyleVariant,
  getHairstyleDetailForAdmin,
  reorderHairstyleVariants,
  setHairstyleSortOrder,
  updateHairstyle,
  updateHairstyleVariantForHairstyle,
} from "@/lib/catalog";
import { resolveAdminSession } from "@/lib/admin/auth";
import { readAdminSessionCookie } from "@/lib/admin/session-cookie";

import { loadAdminConfig } from "./admin-auth-api";
import { publicJson } from "./public-responses";
import {
  checkMutationOrigin,
  isJsonContentType,
  parseJsonObject,
  readBodyText,
} from "./request-guards";

const MAX_BYTES = 8 * 1024;

function cents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    throw new Error("INVALID_PRICE");
  }
  const [whole, fraction = ""] = value.trim().split(".");
  const result = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(result)) throw new Error("INVALID_PRICE");
  return result;
}

function slug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function hasOnly(input: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(input).every((key) => keys.includes(key));
}

function displayOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("INVALID_ORDER");
  }
  return value;
}

function invalidInput() {
  return publicJson(400, {
    error: { code: "INVALID_INPUT", message: "The request is not valid." },
  });
}

function catalogError(error: unknown) {
  const code = error instanceof Error && error.message === "INVALID_PRICE"
    ? "INVALID_PRICE"
    : "INVALID_CATALOG_INPUT";
  return publicJson(400, {
    error: { code, message: "The catalog change is not valid." },
  });
}

type AuthorizedInput = { input: Record<string, unknown> } | { response: Response };

async function getAuthorizedInput(request: Request): Promise<AuthorizedInput> {
  const config = loadAdminConfig(process.env);
  if (!config) {
    return {
      response: publicJson(503, {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Catalog management is temporarily unavailable.",
        },
      }),
    };
  }
  if (
    checkMutationOrigin(request.headers, new Set([config.appOrigin])) ||
    !isJsonContentType(request.headers.get("content-type"))
  ) {
    return {
      response: publicJson(403, {
        error: { code: "REQUEST_REJECTED", message: "This request was not accepted." },
      }),
    };
  }
  const body = await readBodyText(request, MAX_BYTES);
  if (!body.ok) return { response: invalidInput() };
  const access = await resolveAdminSession(readAdminSessionCookie(request.headers));
  if (!access) {
    return {
      response: publicJson(401, {
        error: {
          code: "SESSION_INVALID",
          message: "Your admin session is no longer valid. Sign in again.",
        },
      }),
    };
  }
  const parsed = parseJsonObject(body.text);
  if (!parsed.ok) return { response: invalidInput() };
  return { input: parsed.value };
}

/** Small authenticated mutation boundary. Catalog services remain the policy authority. */
export async function adminCatalogPost(request: Request): Promise<Response> {
  const authorized = await getAuthorizedInput(request);
  if ("response" in authorized) return authorized.response;
  const input = authorized.input;

  try {
    if (
      input.kind === "category" &&
      hasOnly(input, ["kind", "name", "slug", "description", "isActive"]) &&
      typeof input.name === "string" &&
      (input.slug === undefined || typeof input.slug === "string") &&
      (input.description === undefined || typeof input.description === "string") &&
      (input.isActive === undefined || typeof input.isActive === "boolean")
    ) {
      const category = await createCategory({
        name: input.name,
        slug: typeof input.slug === "string" ? input.slug : slug(input.name),
        description: typeof input.description === "string" ? input.description : null,
        isActive: input.isActive !== false,
      });
      return publicJson(201, { category });
    }
    if (
      input.kind === "service" &&
      hasOnly(input, [
        "kind",
        "name",
        "slug",
        "categoryId",
        "description",
        "pricingMode",
        "price",
        "isActive",
        "displayOrder",
      ]) &&
      typeof input.name === "string" &&
      typeof input.categoryId === "string" &&
      (input.pricingMode === "simple" || input.pricingMode === "variants") &&
      (input.slug === undefined || typeof input.slug === "string") &&
      (input.description === undefined || typeof input.description === "string") &&
      (input.isActive === undefined || typeof input.isActive === "boolean")
    ) {
      const requiresVariant = input.pricingMode === "variants";
      const priceCents = requiresVariant ? null : cents(input.price);
      if (!requiresVariant && input.isActive === true && priceCents === null) throw new Error("INVALID_PRICE");
      // A newly created variant service has no variants yet, so publication is
      // finalized only after the inline editor has saved its rows.
      if (requiresVariant && input.isActive === true) throw new Error("INVALID_PRICE");
      const service = await createHairstyle({
        name: input.name,
        slug: typeof input.slug === "string" ? input.slug : slug(input.name),
        categoryId: input.categoryId,
        description: typeof input.description === "string" ? input.description : null,
        requiresVariant,
        priceCents,
        isActive: input.isActive === true,
      });
      const order = displayOrder(input.displayOrder);
      return publicJson(201, {
        service: order === undefined
          ? service
          : await setHairstyleSortOrder(service.id, order),
      });
    }
    if (
      input.kind === "variant" &&
      hasOnly(input, ["kind", "hairstyleId", "name", "description", "price", "isActive"]) &&
      typeof input.hairstyleId === "string" &&
      typeof input.name === "string" &&
      (input.description === undefined || input.description === null || typeof input.description === "string") &&
      (input.isActive === undefined || typeof input.isActive === "boolean")
    ) {
      const hairstyle = await getHairstyleDetailForAdmin(input.hairstyleId);
      if (!hairstyle.requiresVariant) throw new Error("VARIANT_PRICING_REQUIRED");
      const variant = await createHairstyleVariant({
        hairstyleId: input.hairstyleId,
        name: input.name,
        description: input.description as string | null | undefined,
        priceCents: cents(input.price),
        isActive: input.isActive === true,
      });
      return publicJson(201, { variant });
    }
  } catch (error) {
    return catalogError(error);
  }
  return invalidInput();
}

export async function adminCatalogPatch(request: Request, id: string): Promise<Response> {
  const authorized = await getAuthorizedInput(request);
  if ("response" in authorized) return authorized.response;
  const input = authorized.input;

  try {
    if (
      input.kind === "service" &&
      hasOnly(input, [
        "kind",
        "name",
        "slug",
        "categoryId",
        "description",
        "pricingMode",
        "price",
        "isActive",
        "displayOrder",
      ]) &&
      (input.pricingMode === "simple" || input.pricingMode === "variants") &&
      (input.name === undefined || typeof input.name === "string") &&
      (input.categoryId === undefined || typeof input.categoryId === "string") &&
      (input.slug === undefined || typeof input.slug === "string") &&
      (input.description === undefined || typeof input.description === "string") &&
      (input.isActive === undefined || typeof input.isActive === "boolean")
    ) {
      const requiresVariant = input.pricingMode === "variants";
      const priceCents = requiresVariant ? null : cents(input.price);
      if (!requiresVariant && input.isActive === true && priceCents === null) throw new Error("INVALID_PRICE");
      const service = await updateHairstyle(id, {
        name: typeof input.name === "string" ? input.name : undefined,
        slug: typeof input.slug === "string" ? input.slug : undefined,
        categoryId: typeof input.categoryId === "string" ? input.categoryId : undefined,
        description: typeof input.description === "string" ? input.description : undefined,
        requiresVariant,
        priceCents,
        isActive: input.isActive,
      });
      const order = displayOrder(input.displayOrder);
      const positioned = order === undefined
        ? service
        : await setHairstyleSortOrder(service.id, order);
      return publicJson(200, {
        service: positioned,
      });
    }
    if (
      input.kind === "variant" &&
      hasOnly(input, ["kind", "variantId", "name", "description", "price", "isActive"]) &&
      typeof input.variantId === "string" &&
      (input.name === undefined || typeof input.name === "string") &&
      (input.description === undefined || input.description === null || typeof input.description === "string") &&
      (input.isActive === undefined || typeof input.isActive === "boolean")
    ) {
      const hairstyle = await getHairstyleDetailForAdmin(id);
      if (!hairstyle.requiresVariant) throw new Error("VARIANT_PRICING_REQUIRED");
      return publicJson(200, {
        variant: await updateHairstyleVariantForHairstyle(id, input.variantId, {
          name: typeof input.name === "string" ? input.name : undefined,
          description: input.description as string | null | undefined,
          priceCents: input.price === undefined ? undefined : cents(input.price),
          isActive: input.isActive,
        }),
      });
    }
    if (
      input.kind === "variants-order" &&
      hasOnly(input, ["kind", "orderedVariantIds"]) &&
      Array.isArray(input.orderedVariantIds) &&
      input.orderedVariantIds.every((variantId) => typeof variantId === "string")
    ) {
      const hairstyle = await getHairstyleDetailForAdmin(id);
      if (!hairstyle.requiresVariant) throw new Error("VARIANT_PRICING_REQUIRED");
      return publicJson(200, {
        variants: await reorderHairstyleVariants(id, input.orderedVariantIds),
      });
    }
    if (input.kind === "deactivate-service") {
      return publicJson(200, { service: await deactivateHairstyle(id) });
    }
    if (input.kind === "deactivate-variant") {
      return publicJson(200, { variant: await deactivateHairstyleVariant(id) });
    }
  } catch (error) {
    return catalogError(error);
  }
  return invalidInput();
}
