import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { ADMIN_SESSION_TTL_MS, hashAdminSessionToken, signInAdmin } from "@/lib/admin/auth";
import { provisionAdminPassword } from "@/lib/admin/provision";
import { ADMIN_COOKIE_NAME } from "@/lib/admin/session-cookie";
import { isBookingError } from "@/lib/booking/errors";
import { resolveCatalogBookingPrice } from "@/lib/booking/pricing";
import { createPublicBooking } from "@/lib/booking/public-booking";
import { listPublicBookableHairstyles } from "@/lib/catalog";
import { adminCatalogPatch, adminCatalogPost } from "@/lib/http/admin-catalog-api";
import { prisma } from "@/lib/prisma";

import { publicBookingPlace, upcomingPublicBookingDate } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const ORIGIN = "https://catalog-admin.example.test";
const PASSWORD = "Velvet-Comb-2026!";
const FAST = { hashParams: { N: 2 ** 14, r: 8, p: 1 } };
const environmentKeys = ["APP_BASE_URL", "RATE_LIMIT_SECRET", "TRUSTED_CLIENT_IP_SOURCE", "NODE_ENV"] as const;
const previousEnvironment = new Map<string, string | undefined>();

type Json = Record<string, unknown>;

function request(body: unknown, options: { token?: string; origin?: string; contentType?: string; raw?: string } = {}) {
  return new Request(`${ORIGIN}/api/admin/services`, {
    method: "POST",
    headers: {
      origin: options.origin ?? ORIGIN,
      ...(options.contentType === undefined ? { "content-type": "application/json" } : { "content-type": options.contentType }),
      ...(options.token ? { cookie: `${ADMIN_COOKIE_NAME}=${options.token}` } : {}),
    },
    body: options.raw ?? JSON.stringify(body),
  });
}

async function patch(serviceId: string, body: unknown, token: string) {
  const request = new Request(`${ORIGIN}/api/admin/services/${serviceId}`, {
    method: "PATCH",
    headers: { origin: ORIGIN, "content-type": "application/json", cookie: `${ADMIN_COOKIE_NAME}=${token}` },
    body: JSON.stringify(body),
  });
  return adminCatalogPatch(request, serviceId);
}

async function signedIn() {
  await provisionAdminPassword({ email: "owner@example.test", password: PASSWORD }, FAST);
  const signedIn = await signInAdmin("owner@example.test", PASSWORD);
  assert.equal(signedIn.ok, true);
  return (signedIn as { token: string }).token;
}

async function responseJson(response: Response): Promise<Json> {
  return response.json() as Promise<Json>;
}

async function createCategory(token: string, name = "Braids") {
  const response = await adminCatalogPost(request({ kind: "category", name }, { token }));
  assert.equal(response.status, 201);
  return (await responseJson(response)).category as { id: string; name: string };
}

async function createService(token: string, input: Record<string, unknown>) {
  const response = await adminCatalogPost(request({ kind: "service", ...input }, { token }));
  const payload = await responseJson(response);
  assert.equal(response.status, 201, JSON.stringify(payload));
  return payload.service as { id: string };
}

describe("admin catalog mutations", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  before(() => {
    for (const key of environmentKeys) previousEnvironment.set(key, process.env[key]);
    Object.assign(process.env, {
      APP_BASE_URL: ORIGIN,
      RATE_LIMIT_SECRET: "c".repeat(40),
      TRUSTED_CLIENT_IP_SOURCE: "none",
      NODE_ENV: "test",
    });
  });

  after(() => {
    const mutableEnvironment = process.env as Record<string, string | undefined>;
    for (const key of environmentKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete mutableEnvironment[key];
      else mutableEnvironment[key] = value;
    }
  });

  it("rejects unauthenticated, expired, malformed, cross-origin, oversized, and unexpected catalog mutations without writes", async () => {
    const token = await signedIn();
    const payload = { kind: "category", name: "Braids" };
    const noSession = await adminCatalogPost(request(payload));
    assert.equal(noSession.status, 401);
    const malformed = await adminCatalogPost(request(payload, { token: "not-a-valid-session" }));
    assert.equal(malformed.status, 401);
    const crossOrigin = await adminCatalogPost(request(payload, { token, origin: "https://elsewhere.example.test" }));
    assert.equal(crossOrigin.status, 403);
    const contentType = await adminCatalogPost(request(payload, { token, contentType: "text/plain" }));
    assert.equal(contentType.status, 403);
    const oversized = await adminCatalogPost(request({}, { token, raw: `{"kind":"category","name":"${"x".repeat(9_000)}"}` }));
    assert.equal(oversized.status, 400);
    const unexpected = await adminCatalogPost(request({ ...payload, priceCents: 1 }, { token }));
    assert.equal(unexpected.status, 400);

    const session = await prisma.adminSession.findUniqueOrThrow({ where: { tokenHash: hashAdminSessionToken(token) } });
    const expiredCreatedAt = new Date(Date.now() - 2 * ADMIN_SESSION_TTL_MS);
    await prisma.adminSession.update({
      where: { id: session.id },
      data: {
        createdAt: expiredCreatedAt,
        expiresAt: new Date(expiredCreatedAt.getTime() + ADMIN_SESSION_TTL_MS),
      },
    });
    const expired = await adminCatalogPost(request(payload, { token }));
    assert.equal(expired.status, 401);
    assert.equal(await prisma.hairstyleCategory.count(), 0);
    assert.equal(await prisma.hairstyle.count(), 0);
  });

  it("creates, edits, orders, moves, and deactivates simple services while retaining booking pricing rules", async () => {
    const token = await signedIn();
    const braids = await createCategory(token, "Braids");
    const locs = await createCategory(token, "Locs");
    const draft = await createService(token, { name: "Draft twists", categoryId: braids.id, pricingMode: "simple", price: "", isActive: false, displayOrder: 0 });
    const active = await createService(token, { name: "Silk press", categoryId: braids.id, description: "Glossy", pricingMode: "simple", price: "200.00", isActive: true, displayOrder: 1 });

    const updated = await patch(active.id, { kind: "service", name: "Signature silk press", categoryId: locs.id, description: "Smooth and glossy", pricingMode: "simple", price: "240.00", isActive: true, displayOrder: 0 }, token);
    assert.equal(updated.status, 200);
    const locsSecond = await createService(token, { name: "Loc maintenance", categoryId: locs.id, pricingMode: "simple", price: "160.00", isActive: true, displayOrder: 1 });
    assert.equal((await patch(active.id, { kind: "service", name: "Signature silk press", categoryId: locs.id, description: "Smooth and glossy", pricingMode: "simple", price: "240.00", isActive: true, displayOrder: 1 }, token)).status, 200);
    assert.deepEqual((await prisma.hairstyle.findMany({ where: { categoryId: locs.id }, orderBy: { sortOrder: "asc" } })).map((style) => style.id), [locsSecond.id, active.id]);
    const activeRow = await prisma.hairstyle.findUniqueOrThrow({ where: { id: active.id } });
    assert.deepEqual({ name: activeRow.name, categoryId: activeRow.categoryId, description: activeRow.description, price: activeRow.priceCents, order: activeRow.sortOrder }, { name: "Signature silk press", categoryId: locs.id, description: "Smooth and glossy", price: 24_000, order: 1 });

    const cheap = await adminCatalogPost(request({ kind: "service", name: "Too cheap", categoryId: braids.id, pricingMode: "simple", price: "39.99", isActive: true }, { token }));
    assert.equal(cheap.status, 400);
    const unpublished = await patch(active.id, { kind: "service", name: activeRow.name, categoryId: locs.id, description: activeRow.description ?? "", pricingMode: "simple", price: "240.00", isActive: false, displayOrder: 0 }, token);
    assert.equal(unpublished.status, 200);
    await assert.rejects(resolveCatalogBookingPrice(prisma, { hairstyleId: active.id }), (error: unknown) => isBookingError(error));
    assert.equal((await prisma.hairstyle.findUniqueOrThrow({ where: { id: draft.id } })).isActive, false);
  });

  it("creates, publishes, updates, orders, and scopes variant services", async () => {
    const token = await signedIn();
    const category = await createCategory(token);
    const service = await createService(token, { name: "Bob", categoryId: category.id, pricingMode: "variants", price: "", isActive: false });
    const mediumResponse = await adminCatalogPost(request({ kind: "variant", hairstyleId: service.id, name: "Medium", description: "  Shoulder length  ", price: "200.00", isActive: true }, { token }));
    assert.equal(mediumResponse.status, 201);
    const medium = (await responseJson(mediumResponse)).variant as { id: string };
    const largeResponse = await adminCatalogPost(request({ kind: "variant", hairstyleId: service.id, name: "Large", price: "260.00", isActive: true }, { token }));
    assert.equal(largeResponse.status, 201);
    const large = (await responseJson(largeResponse)).variant as { id: string };

    const publish = await patch(service.id, { kind: "service", name: "Bob", categoryId: category.id, description: "", pricingMode: "variants", price: "", isActive: true, displayOrder: 0 }, token);
    assert.equal(publish.status, 200);
    const changed = await patch(service.id, { kind: "variant", variantId: medium.id, name: "Medium length", description: "  Sleek and versatile  ", price: "220.00", isActive: true }, token);
    assert.equal(changed.status, 200);
    assert.deepEqual(
      await prisma.hairstyleVariant.findUniqueOrThrow({ where: { id: medium.id }, select: { id: true, description: true } }),
      { id: medium.id, description: "Sleek and versatile" },
    );
    const clearedDescription = await patch(service.id, { kind: "variant", variantId: medium.id, description: "", price: "220.00", isActive: true }, token);
    assert.equal(clearedDescription.status, 200);
    assert.equal((await prisma.hairstyleVariant.findUniqueOrThrow({ where: { id: medium.id } })).description, null);
    const tooLongDescription = await patch(service.id, { kind: "variant", variantId: medium.id, description: "x".repeat(501), price: "220.00", isActive: true }, token);
    assert.equal(tooLongDescription.status, 400);
    const reordered = await patch(service.id, { kind: "variants-order", orderedVariantIds: [large.id, medium.id] }, token);
    assert.equal(reordered.status, 200);
    assert.deepEqual((await prisma.hairstyleVariant.findMany({ where: { hairstyleId: service.id }, orderBy: { sortOrder: "asc" } })).map((variant) => variant.id), [large.id, medium.id]);

    const draftVariant = await adminCatalogPost(request({ kind: "variant", hairstyleId: service.id, name: "Draft", price: "", isActive: false }, { token }));
    assert.equal(draftVariant.status, 201);
    const draftId = ((await responseJson(draftVariant)).variant as { id: string }).id;
    const invalidActivation = await patch(service.id, { kind: "variant", variantId: draftId, name: "Draft", price: "", isActive: true }, token);
    assert.equal(invalidActivation.status, 400);
    const deactivateLarge = await patch(service.id, { kind: "variant", variantId: large.id, name: "Large", price: "260.00", isActive: false }, token);
    assert.equal(deactivateLarge.status, 200);
    const lastActive = await patch(service.id, { kind: "variant", variantId: medium.id, name: "Medium length", price: "220.00", isActive: false }, token);
    assert.equal(lastActive.status, 400);
    const duplicate = await adminCatalogPost(request({ kind: "variant", hairstyleId: service.id, name: "Medium length", price: "220.00", isActive: true }, { token }));
    assert.equal(duplicate.status, 400);

    const foreign = await createService(token, { name: "Other bob", categoryId: category.id, pricingMode: "variants", price: "", isActive: false });
    const crossService = await patch(foreign.id, { kind: "variant", variantId: medium.id, name: "Stolen", price: "220.00", isActive: true }, token);
    assert.equal(crossService.status, 400);
    assert.equal((await prisma.hairstyleVariant.findUniqueOrThrow({ where: { id: medium.id } })).name, "Medium length");
  });

  it("preserves appointment, payment, and event history after catalog mutations", async () => {
    const token = await signedIn();
    const category = await createCategory(token);
    const service = await createService(token, { name: "Bob", categoryId: category.id, pricingMode: "variants", price: "", isActive: false });
    const variantResponse = await adminCatalogPost(request({ kind: "variant", hairstyleId: service.id, name: "Medium", price: "200.00", isActive: true }, { token }));
    const variant = (await responseJson(variantResponse)).variant as { id: string };
    assert.equal((await patch(service.id, { kind: "service", name: "Bob", categoryId: category.id, description: "", pricingMode: "variants", price: "", isActive: true, displayOrder: 0 }, token)).status, 200);

    const { location, slot } = await publicBookingPlace();
    const created = await createPublicBooking({ name: "Snapshot customer", email: "snapshot@example.test", phone: "+1 555 010 0130", locationId: location.id, bookingSlotId: slot.id, appointmentDate: upcomingPublicBookingDate(), hairstyleId: service.id, hairstyleVariantId: variant.id, emailMarketingConsent: false, smsMarketingConsent: false });
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: created.booking.appointmentId }, include: { payments: true, events: true } });

    assert.equal((await patch(service.id, { kind: "service", name: "Renamed bob", categoryId: category.id, description: "", pricingMode: "variants", price: "", isActive: false, displayOrder: 0 }, token)).status, 200);
    assert.equal((await patch(service.id, { kind: "variant", variantId: variant.id, name: "Large", price: "240.00", isActive: false }, token)).status, 200);
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: before.id }, include: { payments: true, events: true } });
    assert.deepEqual({ style: after.hairstyleNameSnapshot, variant: after.hairstyleVariantNameSnapshot, total: after.totalPriceCents, deposit: after.depositAmountCents, balance: after.balanceDueCents, currency: after.currency }, { style: "Bob", variant: "Medium", total: 20_000, deposit: 4_000, balance: 16_000, currency: "usd" });
    assert.deepEqual(after.payments, before.payments);
    assert.deepEqual(after.events, before.events);
  });

  it("stages pricing-mode changes without deleting variants or rewriting booking snapshots", async () => {
    const token = await signedIn();
    const category = await createCategory(token);
    const simple = await createService(token, {
      name: "Convertible style",
      categoryId: category.id,
      pricingMode: "simple",
      price: "200.00",
      isActive: true,
    });

    const invalidDirectSwitch = await patch(simple.id, {
      kind: "service",
      name: "Convertible style",
      categoryId: category.id,
      description: "",
      pricingMode: "variants",
      price: "",
      isActive: true,
      displayOrder: 0,
    }, token);
    assert.equal(invalidDirectSwitch.status, 400);

    const asVariantDraft = await patch(simple.id, {
      kind: "service",
      name: "Convertible style",
      categoryId: category.id,
      description: "",
      pricingMode: "variants",
      price: "",
      isActive: false,
      displayOrder: 0,
    }, token);
    assert.equal(asVariantDraft.status, 200);
    const variantResponse = await adminCatalogPost(request({
      kind: "variant",
      hairstyleId: simple.id,
      name: "Medium",
      price: "240.00",
      isActive: true,
    }, { token }));
    assert.equal(variantResponse.status, 201);
    const variant = (await responseJson(variantResponse)).variant as { id: string };
    assert.equal((await patch(simple.id, {
      kind: "service",
      name: "Convertible style",
      categoryId: category.id,
      description: "",
      pricingMode: "variants",
      price: "",
      isActive: true,
      displayOrder: 0,
    }, token)).status, 200);
    assert.deepEqual((await listPublicBookableHairstyles()).map((style) => ({
      id: style.id,
      requiresVariant: style.requiresVariant,
      price: style.priceCents,
      variants: style.variants.map(({ id, name, priceCents }) => ({ id, name, priceCents })),
    })), [{
      id: simple.id,
      requiresVariant: true,
      price: null,
      variants: [{ id: variant.id, name: "Medium", priceCents: 24_000 }],
    }]);

    const { location, slot } = await publicBookingPlace();
    const created = await createPublicBooking({
      name: "Mode snapshot customer",
      email: "mode-snapshot@example.test",
      phone: "+1 555 010 0199",
      locationId: location.id,
      bookingSlotId: slot.id,
      appointmentDate: upcomingPublicBookingDate(),
      hairstyleId: simple.id,
      hairstyleVariantId: variant.id,
    });
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: created.booking.appointmentId } });

    assert.equal((await patch(simple.id, {
      kind: "service",
      name: "Convertible style",
      categoryId: category.id,
      description: "",
      pricingMode: "variants",
      price: "",
      isActive: false,
      displayOrder: 0,
    }, token)).status, 200);
    assert.equal((await patch(simple.id, {
      kind: "variant",
      variantId: variant.id,
      name: "Medium",
      price: "240.00",
      isActive: false,
    }, token)).status, 200);
    assert.equal((await patch(simple.id, {
      kind: "service",
      name: "Convertible style",
      categoryId: category.id,
      description: "",
      pricingMode: "simple",
      price: "220.00",
      isActive: true,
      displayOrder: 0,
    }, token)).status, 200);

    const retainedVariant = await prisma.hairstyleVariant.findUniqueOrThrow({ where: { id: variant.id } });
    assert.deepEqual({ isActive: retainedVariant.isActive, priceCents: retainedVariant.priceCents }, { isActive: false, priceCents: 24_000 });
    assert.deepEqual(await resolveCatalogBookingPrice(prisma, { hairstyleId: simple.id }), {
      hairstyleId: simple.id,
      hairstyleNameSnapshot: "Convertible style",
      hairstyleVariantId: null,
      hairstyleVariantNameSnapshot: null,
      totalPriceCents: 22_000,
      depositAmountCents: 4_000,
      balanceDueCents: 18_000,
      currency: "usd",
    });
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: before.id } });
    assert.deepEqual(
      [after.hairstyleNameSnapshot, after.hairstyleVariantNameSnapshot, after.totalPriceCents, after.depositAmountCents, after.balanceDueCents, after.currency],
      ["Convertible style", "Medium", 24_000, 4_000, 20_000, "usd"],
    );
  });
});
