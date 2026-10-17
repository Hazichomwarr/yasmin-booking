import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toAdminHistoryItem } from "@/lib/admin/appointment-history";

describe("admin appointment history", () => {
  it("renders attributed lifecycle and schedule facts without operation identifiers", () => {
    const item = toAdminHistoryItem({
      type: "RESCHEDULED",
      at: new Date("2026-10-17T15:00:00.000Z"),
      actorEmail: "stylist@example.test",
      reason: "Customer requested a later time",
      details: {
        schemaVersion: 1,
        before: { appointmentDate: "2026-10-20", slotTime: "11:00" },
        after: { appointmentDate: "2026-10-21", slotTime: "14:00" },
      },
    });
    assert.equal(item.label, "Appointment rescheduled");
    assert.equal(item.actorEmail, "stylist@example.test");
    assert.equal(item.schedule, "2026-10-20 at 11:00 → 2026-10-21 at 14:00");
    assert.equal(item.transition, null);
  });

  it("gracefully represents older unattributed events with incomplete details", () => {
    const item = toAdminHistoryItem({
      type: "PAYMENT_CONFIRMED",
      at: new Date("2026-10-17T15:00:00.000Z"),
      actorEmail: null,
      reason: null,
      details: null,
    });
    assert.equal(item.label, "Deposit payment confirmed");
    assert.equal(item.automated, true);
    assert.equal(item.reason, null);
    assert.equal(item.transition, null);
  });
});
