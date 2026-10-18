import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCategory,
  createHairstyle,
  createHairstyleVariant,
  updateHairstyle,
  updateHairstyleVariant,
} from "@/lib/catalog";
import { isBookingError } from "@/lib/booking/errors";
import { resolveCatalogBookingPrice } from "@/lib/booking/pricing";
import { createPublicBooking } from "@/lib/booking/public-booking";
import { prisma } from "@/lib/prisma";

import { publicBookingPlace, upcomingPublicBookingDate } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

describe("catalog pricing", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  async function catalog() {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    return category;
  }

  it("resolves simple and variant catalog prices with a fixed $40 USD deposit", async () => {
    const category = await catalog();
    const crochet = await createHairstyle({ categoryId: category.id, name: "Crochet", slug: "crochet", priceCents: 16_000 });
    const bob = await createHairstyle({ categoryId: category.id, name: "Bob", slug: "bob", requiresVariant: true });
    const gypsy = await createHairstyleVariant({ hairstyleId: bob.id, name: "Gypsy", priceCents: 26_000 });

    assert.deepEqual(await resolveCatalogBookingPrice(prisma, { hairstyleId: crochet.id }), {
      hairstyleId: crochet.id, hairstyleNameSnapshot: "Crochet", hairstyleVariantId: null, hairstyleVariantNameSnapshot: null,
      totalPriceCents: 16_000, depositAmountCents: 4_000, balanceDueCents: 12_000, currency: "usd",
    });
    assert.deepEqual(await resolveCatalogBookingPrice(prisma, { hairstyleId: bob.id, hairstyleVariantId: gypsy.id }), {
      hairstyleId: bob.id, hairstyleNameSnapshot: "Bob", hairstyleVariantId: gypsy.id, hairstyleVariantNameSnapshot: "Gypsy",
      totalPriceCents: 26_000, depositAmountCents: 4_000, balanceDueCents: 22_000, currency: "usd",
    });
  });

  it("rejects missing, inactive, unrelated, draft, and below-deposit pricing", async () => {
    const category = await catalog();
    const bob = await createHairstyle({ categoryId: category.id, name: "Bob", slug: "bob", requiresVariant: true });
    const draft = await createHairstyle({ categoryId: category.id, name: "Boho", slug: "boho" });
    const crochet = await createHairstyle({ categoryId: category.id, name: "Crochet", slug: "crochet", priceCents: 16_000 });
    const inactive = await createHairstyleVariant({ hairstyleId: bob.id, name: "Gypsy", priceCents: 26_000, isActive: false });
    for (const selection of [
      { hairstyleId: bob.id },
      { hairstyleId: bob.id, hairstyleVariantId: inactive.id },
      { hairstyleId: crochet.id, hairstyleVariantId: inactive.id },
      { hairstyleId: draft.id },
    ]) await assert.rejects(resolveCatalogBookingPrice(prisma, selection), (error: unknown) => isBookingError(error));
    await assert.rejects(Promise.resolve().then(() => createHairstyle({ categoryId: category.id, name: "Too cheap", slug: "too-cheap", priceCents: 3_999 })));
  });

  it("snapshots the catalog selection and price before later catalog edits", async () => {
    const category = await catalog();
    const style = await createHairstyle({ categoryId: category.id, name: "Bob", slug: "bob", requiresVariant: true });
    const variant = await createHairstyleVariant({ hairstyleId: style.id, name: "Medium", priceCents: 20_000 });
    const { location, slot } = await publicBookingPlace();
    const request = { name: "Customer", email: "customer@example.test", phone: "+1 555 010 0100", locationId: location.id, bookingSlotId: slot.id, appointmentDate: upcomingPublicBookingDate(), hairstyleId: style.id, hairstyleVariantId: variant.id };
    await assert.rejects(createPublicBooking({ ...request, totalPriceCents: 1 }), /Unknown public booking field/);
    const created = await createPublicBooking(request);
    await updateHairstyle(style.id, { name: "Renamed Bob" });
    await updateHairstyleVariant(variant.id, { name: "Large", priceCents: 24_000 });
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: created.booking.appointmentId } });
    assert.deepEqual({ style: appointment.hairstyleNameSnapshot, variant: appointment.hairstyleVariantNameSnapshot, total: appointment.totalPriceCents, deposit: appointment.depositAmountCents, balance: appointment.balanceDueCents, currency: appointment.currency }, { style: "Bob", variant: "Medium", total: 20_000, deposit: 4_000, balance: 16_000, currency: "usd" });
  });
});
