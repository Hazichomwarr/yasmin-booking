import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  attachHairstyleImage,
  attachHairstyleImageIdempotently,
  createCategory,
  createHairstyle,
  createHairstyleVariant,
  deactivateHairstyle,
  deactivateHairstyleVariant,
  listHairstyleMedia,
  reorderHairstyleMedia,
  updateHairstyleVariant,
} from "@/lib/catalog";
import { createPublicBooking } from "@/lib/booking/public-booking";
import { prisma } from "@/lib/prisma";

import { assertCatalogError } from "../support/assertions";
import { publicBookingPlace, upcomingPublicBookingDate } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

describe("variant media galleries", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  async function styleWithVariant(name = "Gypsy") {
    const slug = name.toLowerCase().replaceAll(" ", "-");
    const category = await createCategory({ name: `${name} category`, slug: `${slug}-category` });
    const hairstyle = await createHairstyle({
      categoryId: category.id,
      name,
      slug,
      requiresVariant: true,
    });
    const variant = await createHairstyleVariant({
      hairstyleId: hairstyle.id,
      name: "Sleek Braided",
      priceCents: 24_000,
    });
    return { hairstyle, variant };
  }

  it("keeps the existing service gallery separate from a variant gallery", async () => {
    const { hairstyle, variant } = await styleWithVariant();
    const serviceImage = await attachHairstyleImage({ hairstyleId: hairstyle.id, storageKey: "service/one.jpg" });
    const variantImage = await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      hairstyleVariantId: variant.id,
      storageKey: "variant/one.jpg",
    });

    assert.deepEqual((await listHairstyleMedia(hairstyle.id)).map((media) => media.id), [serviceImage.id]);
    assert.deepEqual((await listHairstyleMedia(hairstyle.id, variant.id)).map((media) => media.id), [variantImage.id]);
    assert.equal((await prisma.hairstyleMedia.findUniqueOrThrow({ where: { id: serviceImage.id } })).hairstyleVariantId, null);
  });

  it("rejects cross-service variant ownership in the domain and database", async () => {
    const first = await styleWithVariant("Gypsy");
    const second = await styleWithVariant("Boho");

    await assertCatalogError(
      attachHairstyleImage({
        hairstyleId: second.hairstyle.id,
        hairstyleVariantId: first.variant.id,
        storageKey: "cross/domain.jpg",
      }),
      "VARIANT_NOT_FOUND",
    );
    await assert.rejects(
      prisma.hairstyleMedia.create({
        data: {
          hairstyleId: second.hairstyle.id,
          hairstyleVariantId: first.variant.id,
          type: "IMAGE",
          storageKey: "cross/database.jpg",
        },
      }),
    );
  });

  it("enforces the eight-image limit independently for service and variant galleries", async () => {
    const { hairstyle, variant } = await styleWithVariant();
    for (let index = 0; index < 8; index += 1) {
      await attachHairstyleImage({ hairstyleId: hairstyle.id, storageKey: `service/${index}.jpg` });
      await attachHairstyleImage({ hairstyleId: hairstyle.id, hairstyleVariantId: variant.id, storageKey: `variant/${index}.jpg` });
    }

    await assertCatalogError(attachHairstyleImage({ hairstyleId: hairstyle.id, storageKey: "service/overflow.jpg" }), "MEDIA_LIMIT_REACHED");
    await assertCatalogError(attachHairstyleImage({ hairstyleId: hairstyle.id, hairstyleVariantId: variant.id, storageKey: "variant/overflow.jpg" }), "MEDIA_LIMIT_REACHED");
    assert.equal((await listHairstyleMedia(hairstyle.id)).length, 8);
    assert.equal((await listHairstyleMedia(hairstyle.id, variant.id)).length, 8);
  });

  it("reorders each gallery independently", async () => {
    const { hairstyle, variant } = await styleWithVariant();
    const serviceA = await attachHairstyleImage({ hairstyleId: hairstyle.id, storageKey: "service/a.jpg" });
    const serviceB = await attachHairstyleImage({ hairstyleId: hairstyle.id, storageKey: "service/b.jpg" });
    const variantA = await attachHairstyleImage({ hairstyleId: hairstyle.id, hairstyleVariantId: variant.id, storageKey: "variant/a.jpg" });
    const variantB = await attachHairstyleImage({ hairstyleId: hairstyle.id, hairstyleVariantId: variant.id, storageKey: "variant/b.jpg" });

    await reorderHairstyleMedia(hairstyle.id, [variantB.id, variantA.id], variant.id);
    assert.deepEqual((await listHairstyleMedia(hairstyle.id)).map((media) => media.id), [serviceA.id, serviceB.id]);
    assert.deepEqual((await listHairstyleMedia(hairstyle.id, variant.id)).map((media) => media.id), [variantB.id, variantA.id]);
  });

  it("is retry-safe within a gallery and rejects storage paths reused by another gallery", async () => {
    const { hairstyle, variant } = await styleWithVariant();
    const input = { hairstyleId: hairstyle.id, hairstyleVariantId: variant.id, storageKey: "variant/retry.jpg" };
    const first = await attachHairstyleImageIdempotently(input);
    const retry = await attachHairstyleImageIdempotently(input);

    assert.equal(first.created, true);
    assert.deepEqual(retry, { media: first.media, created: false });
    await assertCatalogError(
      attachHairstyleImageIdempotently({ hairstyleId: hairstyle.id, storageKey: input.storageKey }),
      "STORAGE_KEY_ALREADY_EXISTS",
    );
  });

  it("retains inactive variants and their media without altering booking snapshots", async () => {
    const { hairstyle, variant } = await styleWithVariant();
    const image = await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      hairstyleVariantId: variant.id,
      storageKey: "variant/historical.jpg",
    });
    const { location, slot } = await publicBookingPlace();
    const booking = await createPublicBooking({
      name: "Variant customer",
      email: "variant@example.test",
      phone: "+1 555 010 0160",
      locationId: location.id,
      bookingSlotId: slot.id,
      appointmentDate: upcomingPublicBookingDate(),
      hairstyleId: hairstyle.id,
      hairstyleVariantId: variant.id,
    });
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: booking.booking.appointmentId } });

    await updateHairstyleVariant(variant.id, { description: "  A polished braided finish.  " });
    // The established catalog rule keeps a published variant-based service
    // bookable until its parent is made a draft. Deactivate the parent first;
    // this test concerns retention, not publication validation.
    await deactivateHairstyle(hairstyle.id);
    await deactivateHairstyleVariant(variant.id);

    assert.deepEqual((await listHairstyleMedia(hairstyle.id, variant.id)).map((media) => media.id), [image.id]);
    assert.equal((await prisma.hairstyleVariant.findUniqueOrThrow({ where: { id: variant.id } })).description, "A polished braided finish.");
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: booking.booking.appointmentId } });
    assert.deepEqual(
      {
        hairstyle: after.hairstyleNameSnapshot,
        variant: after.hairstyleVariantNameSnapshot,
        total: after.totalPriceCents,
        deposit: after.depositAmountCents,
        balance: after.balanceDueCents,
        currency: after.currency,
      },
      {
        hairstyle: before.hairstyleNameSnapshot,
        variant: before.hairstyleVariantNameSnapshot,
        total: before.totalPriceCents,
        deposit: before.depositAmountCents,
        balance: before.balanceDueCents,
        currency: before.currency,
      },
    );
  });

  it("normalizes optional descriptions and rejects values over 500 characters", async () => {
    const { variant } = await styleWithVariant();
    const cleared = await updateHairstyleVariant(variant.id, { description: "   " });
    assert.equal(cleared.description, null);
    await assertCatalogError(updateHairstyleVariant(variant.id, { description: "x".repeat(501) }), "INVALID_NAME");
  });
});
