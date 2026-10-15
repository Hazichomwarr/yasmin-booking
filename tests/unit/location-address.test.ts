import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSalonAddress } from "@/lib/booking/location-address";
import { confirmationMessage } from "@/lib/email/confirmation";

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
      recipientEmail: "customer@example.test",
      appointment: {
        locationNameSnapshot: "William Street", appointmentDate: new Date("2026-10-20T00:00:00.000Z"), slotTimeSnapshot: "11:00", hairstyleNameSnapshot: null,
        totalPriceCents: 20_000, depositAmountCents: 4_000, balanceDueCents: 16_000,
        location: { ...WILLIAM_STREET, phone: null },
      },
    });
    assert.match(message.text, /^William Street · 2026-10-20 at 11:00$/m);
    assert.match(message.text, /^Location: 524 William St, East Orange, NJ$/m);
  });
});
