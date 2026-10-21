import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSalonAddress } from "@/lib/booking/location-address";
import {
  ConfirmationEmailConfigurationError,
  confirmationMessage,
  salonNotificationRecipient,
} from "@/lib/email/confirmation";

const WILLIAM_STREET = { addressLine1: "524 William St", addressLine2: null, city: "East Orange", state: "NJ", postalCode: null };

describe("salon address", () => {
  it("formats the configured William Street address exactly", () => {
    assert.equal(formatSalonAddress(WILLIAM_STREET), "524 William St, East Orange, NJ");
  });

  it("includes a second line and postal code only when configured, and ignores blanks", () => {
    assert.equal(formatSalonAddress({ ...WILLIAM_STREET, addressLine2: "Suite 2", postalCode: "07017" }), "524 William St, Suite 2, East Orange, NJ 07017");
    assert.equal(formatSalonAddress({ ...WILLIAM_STREET, addressLine2: "  ", city: " East Orange " }), "524 William St, East Orange, NJ");
  });

  it("is null when no address is configured", () => {
    assert.equal(formatSalonAddress({ addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null }), null);
  });

  it("is what the confirmation email shows, next to the separate location name", () => {
    const message = confirmationMessage({
      appointmentId: "cmtestbookingref",
      recipientEmail: "customer@example.test",
      appointment: {
        locationNameSnapshot: "William Street", appointmentDate: new Date("2026-10-20T00:00:00.000Z"), slotTimeSnapshot: "11:00", hairstyleNameSnapshot: null, hairstyleVariantNameSnapshot: null,
        totalPriceCents: 20_000, depositAmountCents: 4_000, balanceDueCents: 16_000,
        customer: { name: "Customer", email: "customer@example.test", phone: "+1 555 010 0100" },
        location: { ...WILLIAM_STREET, phone: null },
      },
    });
    assert.match(message.text, /^William Street · 2026-10-20 at 11:00 ET$/m);
    assert.match(message.text, /^Location: 524 William St, East Orange, NJ$/m);
  });

  it("requires an explicitly configured server-side salon notification recipient", () => {
    assert.equal(
      salonNotificationRecipient({ SALON_NOTIFICATION_EMAIL: "  OWNER@YASMIN.EXAMPLE  " }),
      "owner@yasmin.example",
    );
    for (const env of [{}, { SALON_NOTIFICATION_EMAIL: "" }, { SALON_NOTIFICATION_EMAIL: "not-an-email" }]) {
      assert.throws(
        () => salonNotificationRecipient(env),
        (error: unknown) => error instanceof ConfirmationEmailConfigurationError
          && error.code === "owner-recipient-not-configured",
      );
    }
  });

  it("uses booking-time variant and money snapshots in the owner notification", () => {
    const message = confirmationMessage({
      appointmentId: "cmtestbookingref",
      recipientEmail: null,
      kind: "OWNER_NEW_BOOKING",
      appointment: {
        locationNameSnapshot: "William Street",
        appointmentDate: new Date("2026-10-20T00:00:00.000Z"),
        slotTimeSnapshot: "11:00",
        hairstyleNameSnapshot: "Bob",
        hairstyleVariantNameSnapshot: "Sleek Braided",
        totalPriceCents: 24_000,
        depositAmountCents: 4_000,
        balanceDueCents: 20_000,
        customer: { name: "Customer", email: "customer@example.test", phone: "+1 555 010 0100" },
        location: { ...WILLIAM_STREET, phone: null },
      },
    }, { SALON_NOTIFICATION_EMAIL: "yasmin@example.test" });
    assert.equal(message.to, "yasmin@example.test");
    assert.match(message.text, /^Booking reference: YB-OKINGREF$/m);
    assert.match(message.text, /^William Street · 2026-10-20 at 11:00 ET$/m);
    assert.match(message.text, /^Style: Bob — Sleek Braided$/m);
    assert.match(message.text, /^Total: \$240\.00$/m);
    assert.match(message.text, /^Deposit paid: \$40\.00$/m);
    assert.match(message.text, /^Balance due at salon: \$200\.00$/m);
  });
});
