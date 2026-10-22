import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { signInAdmin } from "@/lib/admin/auth";
import { provisionAdminPassword } from "@/lib/admin/provision";
import { ADMIN_COOKIE_NAME } from "@/lib/admin/session-cookie";
import { createPublicBooking } from "@/lib/booking/public-booking";
import {
  HomepageFeatureError,
  attachHairstyleImage,
  createCategory,
  createHairstyle,
  createHairstyleVariant,
  listPublicHomepageFeatures,
  readHomepageFeatureAdminState,
  replaceHomepageFeatures,
} from "@/lib/catalog";
import { adminHomepageFeaturesPut } from "@/lib/http/admin-homepage-features-api";
import { prisma } from "@/lib/prisma";

import { publicBookingPlace, upcomingPublicBookingDate } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const ORIGIN = "https://homepage-admin.example.test";
const BLOB_ORIGIN = "https://configured-store.public.blob.vercel-storage.com";
const PASSWORD = "Rose-Gallery-2026!";
const previousEnvironment = new Map<string, string | undefined>();
const environmentKeys = ["APP_BASE_URL", "RATE_LIMIT_SECRET", "TRUSTED_CLIENT_IP_SOURCE", "NODE_ENV", "BLOB_PUBLIC_BASE_URL"] as const;

async function signedIn() {
  await provisionAdminPassword({ email: "homepage-owner@example.test", password: PASSWORD }, { hashParams: { N: 2 ** 14, r: 8, p: 1 } });
  const result = await signInAdmin("homepage-owner@example.test", PASSWORD);
  assert.equal(result.ok, true);
  return (result as { token: string }).token;
}

function request(token: string | null, body: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}/api/admin/homepage-features`, {
    method: "PUT",
    headers: {
      origin,
      "content-type": "application/json",
      ...(token ? { cookie: `${ADMIN_COOKIE_NAME}=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("admin-managed homepage catalog features", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  before(() => {
    for (const key of environmentKeys) previousEnvironment.set(key, process.env[key]);
    Object.assign(process.env, {
      APP_BASE_URL: ORIGIN,
      RATE_LIMIT_SECRET: "h".repeat(40),
      TRUSTED_CLIENT_IP_SOURCE: "none",
      NODE_ENV: "test",
      BLOB_PUBLIC_BASE_URL: BLOB_ORIGIN,
    });
  });

  after(() => {
    const mutable = process.env as Record<string, string | undefined>;
    for (const key of environmentKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete mutable[key];
      else mutable[key] = value;
    }
  });

  it("requires an authenticated same-origin admin and leaves rejected writes empty", async () => {
    const state = await readHomepageFeatureAdminState();
    const unauthenticated = await adminHomepageFeaturesPut(request(null, { revision: state.revision, features: [] }));
    assert.equal(unauthenticated.status, 401);

    const token = await signedIn();
    const crossOrigin = await adminHomepageFeaturesPut(request(token, { revision: state.revision, features: [] }, "https://attacker.example.test"));
    assert.equal(crossOrigin.status, 403);
    const accepted = await adminHomepageFeaturesPut(request(token, { revision: state.revision, features: [] }));
    assert.equal(accepted.status, 200);
    assert.equal(await prisma.homepageCatalogFeature.count(), 0);
  });

  it("creates, reorders, updates, and disables one atomic list with duplicate and four-item enforcement", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const styles = await Promise.all(["Bob", "Locs", "Twists", "Silk Press", "Cornrows"].map((name, index) => createHairstyle({
      categoryId: category.id,
      name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      priceCents: 10_000 + index * 1_000,
    })));
    let state = await readHomepageFeatureAdminState();
    await replaceHomepageFeatures([
      { hairstyleId: styles[0].id, hairstyleVariantId: null },
      { hairstyleId: styles[1].id, hairstyleVariantId: null },
    ], state.revision);

    state = await readHomepageFeatureAdminState();
    assert.deepEqual(state.features.map((feature) => feature.hairstyleId), [styles[0].id, styles[1].id]);
    await replaceHomepageFeatures([
      { hairstyleId: styles[1].id, hairstyleVariantId: null },
      { hairstyleId: styles[2].id, hairstyleVariantId: null },
    ], state.revision);
    state = await readHomepageFeatureAdminState();
    assert.deepEqual(state.features.map((feature) => feature.hairstyleId), [styles[1].id, styles[2].id]);
    assert.equal(await prisma.homepageCatalogFeature.count({ where: { isActive: true } }), 2);
    assert.equal(await prisma.homepageCatalogFeature.count({ where: { isActive: false } }), 1);

    await assert.rejects(
      replaceHomepageFeatures(Array.from({ length: 5 }, (_, index) => ({ hairstyleId: styles[index].id, hairstyleVariantId: null })), state.revision),
      (error: unknown) => error instanceof HomepageFeatureError && error.code === "FEATURE_LIMIT_EXCEEDED",
    );
    await assert.rejects(
      replaceHomepageFeatures([
        { hairstyleId: styles[1].id, hairstyleVariantId: null },
        { hairstyleId: styles[1].id, hairstyleVariantId: null },
      ], state.revision),
      (error: unknown) => error instanceof HomepageFeatureError && error.code === "DUPLICATE_FEATURE",
    );

    await replaceHomepageFeatures([], state.revision);
    assert.equal(await prisma.homepageCatalogFeature.count({ where: { isActive: true } }), 0);
  });

  it("enforces variant ownership and rejects a stale concurrent admin writer", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const first = await createHairstyle({ categoryId: category.id, name: "Bob", slug: "bob", requiresVariant: true });
    const second = await createHairstyle({ categoryId: category.id, name: "Twists", slug: "twists", requiresVariant: true });
    const variant = await createHairstyleVariant({ hairstyleId: first.id, name: "Medium", priceCents: 20_000 });
    const initial = await readHomepageFeatureAdminState();

    await assert.rejects(
      replaceHomepageFeatures([{ hairstyleId: second.id, hairstyleVariantId: variant.id }], initial.revision),
      (error: unknown) => error instanceof HomepageFeatureError && error.code === "VARIANT_OWNERSHIP_MISMATCH",
    );

    const outcomes = await Promise.allSettled([
      replaceHomepageFeatures([{ hairstyleId: first.id, hairstyleVariantId: variant.id }], initial.revision),
      replaceHomepageFeatures([{ hairstyleId: second.id, hairstyleVariantId: null }], initial.revision),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.ok(rejected?.reason instanceof HomepageFeatureError);
    assert.equal(rejected.reason.code, "STALE_FEATURE_CONFIGURATION");
    assert.equal(await prisma.homepageCatalogFeature.count({ where: { isActive: true } }), 1);
  });

  it("keeps inactive configuration, restricts target deletion, and exposes eligible portfolio and booking links in feature order", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const portfolio = await createHairstyle({ categoryId: category.id, name: "Editorial Locs", slug: "editorial-locs", priceCents: null });
    const bob = await createHairstyle({ categoryId: category.id, name: "Bob", slug: "bob", requiresVariant: true });
    const medium = await createHairstyleVariant({ hairstyleId: bob.id, name: "Medium", priceCents: 24_000 });
    const serviceImage = await attachHairstyleImage({
      hairstyleId: bob.id,
      storageKey: "hairstyles/bob/service.jpg",
      deliveryUrl: `${BLOB_ORIGIN}/hairstyles/bob/service.jpg`,
    });
    await attachHairstyleImage({
      hairstyleId: bob.id,
      hairstyleVariantId: medium.id,
      storageKey: "hairstyles/bob/variants/medium/invalid.jpg",
      deliveryUrl: "https://other.public.blob.vercel-storage.com/hairstyles/bob/invalid.jpg",
    });
    const variantImage = await attachHairstyleImage({
      hairstyleId: bob.id,
      hairstyleVariantId: medium.id,
      storageKey: "hairstyles/bob/variants/medium/cover.jpg",
      deliveryUrl: `${BLOB_ORIGIN}/hairstyles/bob/variants/medium/cover.jpg`,
    });
    const state = await readHomepageFeatureAdminState();
    await replaceHomepageFeatures([
      { hairstyleId: bob.id, hairstyleVariantId: medium.id },
      { hairstyleId: portfolio.id, hairstyleVariantId: null },
    ], state.revision);

    const publicFeatures = await listPublicHomepageFeatures();
    assert.deepEqual(publicFeatures.map((feature) => feature.name), ["Medium", "Editorial Locs"]);
    assert.equal(publicFeatures[0].coverImage?.id, variantImage.id);
    assert.notEqual(publicFeatures[0].coverImage?.id, serviceImage.id);
    assert.equal(publicFeatures[0].href, `/book?style=bob&variant=${medium.id}`);
    assert.equal(publicFeatures[1].href, "/styles/editorial-locs");
    assert.equal(publicFeatures[1].priceCents, null);
    assert.ok(publicFeatures.every((feature) => !feature.coverImage || !("storageKey" in feature.coverImage)));
    await assert.rejects(prisma.hairstyle.delete({ where: { id: portfolio.id } }));
    assert.equal(await prisma.homepageCatalogFeature.count({ where: { hairstyleId: portfolio.id } }), 1);

    await prisma.hairstyleVariant.update({ where: { id: medium.id }, data: { isActive: false } });
    assert.deepEqual((await listPublicHomepageFeatures()).map((feature) => feature.name), ["Editorial Locs"]);
    assert.equal((await readHomepageFeatureAdminState()).features.length, 2);
    assert.equal(await prisma.homepageCatalogFeature.count({ where: { hairstyleVariantId: medium.id } }), 1);
  });

  it("uses service-gallery fallback for a variant without valid photos and never rewrites booking history", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const style = await createHairstyle({ categoryId: category.id, name: "Gypsy", slug: "gypsy", requiresVariant: true });
    const variant = await createHairstyleVariant({ hairstyleId: style.id, name: "Sleek", priceCents: 24_000 });
    const serviceImage = await attachHairstyleImage({
      hairstyleId: style.id,
      storageKey: "hairstyles/gypsy/service.jpg",
      deliveryUrl: `${BLOB_ORIGIN}/hairstyles/gypsy/service.jpg`,
    });
    const { location, slot } = await publicBookingPlace();
    await createPublicBooking({
      name: "Featured history customer",
      email: "feature-history@example.test",
      phone: "+1 555 010 0194",
      locationId: location.id,
      bookingSlotId: slot.id,
      appointmentDate: upcomingPublicBookingDate(),
      hairstyleId: style.id,
      hairstyleVariantId: variant.id,
      emailMarketingConsent: false,
      smsMarketingConsent: false,
    });
    const state = await readHomepageFeatureAdminState();
    await replaceHomepageFeatures([{ hairstyleId: style.id, hairstyleVariantId: variant.id }], state.revision);
    const [feature] = await listPublicHomepageFeatures();
    assert.equal(feature.coverImage?.id, serviceImage.id);

    const historyBefore = {
      appointments: await prisma.appointment.findMany(),
      payments: await prisma.payment.findMany(),
      events: await prisma.appointmentEvent.findMany(),
    };
    const next = await readHomepageFeatureAdminState();
    await replaceHomepageFeatures([], next.revision);
    assert.deepEqual({
      appointments: await prisma.appointment.findMany(),
      payments: await prisma.payment.findMany(),
      events: await prisma.appointmentEvent.findMany(),
    }, historyBefore);
  });
});
