import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CURRENT_MARKETING_CONSENT_WORDING,
  marketingConsentEvidence,
  withdrawMarketingConsent,
} from "@/lib/customers/marketing-consent";
import { createPublicBooking } from "@/lib/booking/public-booking";
import { prisma } from "@/lib/prisma";

import { createCustomer, publicBookingPlace, upcomingPublicBookingDate, withFailingWrites } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

async function booking(consent: { emailMarketingConsent?: boolean; smsMarketingConsent?: boolean }) {
  const { location, slot } = await publicBookingPlace();
  const created = await createPublicBooking({
    name: "Consent Customer",
    email: "consent@example.test",
    phone: "+1 555 010 0100",
    locationId: location.id,
    bookingSlotId: slot.id,
    appointmentDate: upcomingPublicBookingDate(),
    ...consent,
  });
  const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: created.booking.appointmentId }, select: { customerId: true } });
  return appointment.customerId;
}

const events = (customerId: string) =>
  prisma.marketingConsentEvent.findMany({ where: { customerId }, orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }] });

describe("marketing-consent evidence", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("records nothing when both boxes stay unticked (the default)", async () => {
    const customerId = await booking({});
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    assert.deepEqual([customer.emailMarketingAt, customer.smsMarketingAt], [null, null]);
    assert.deepEqual(await events(customerId), []);
    assert.deepEqual(await marketingConsentEvidence(customerId), {
      EMAIL: { consented: false, withdrawnAt: null },
      SMS: { consented: false, withdrawnAt: null },
    });
  });

  it("records each channel's grant independently with wording version, source and the same instant", async () => {
    const customerId = await booking({ smsMarketingConsent: true });
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const recorded = await events(customerId);

    assert.equal(customer.emailMarketingAt, null);
    assert.ok(customer.smsMarketingAt);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].channel, "SMS");
    assert.equal(recorded[0].action, "GRANTED");
    assert.equal(recorded[0].source, "PUBLIC_BOOKING_FORM");
    assert.equal(recorded[0].wordingVersion, CURRENT_MARKETING_CONSENT_WORDING.SMS.version);
    assert.equal(recorded[0].actorId, null);
    assert.deepEqual(recorded[0].occurredAt, customer.smsMarketingAt);

    assert.deepEqual(await marketingConsentEvidence(customerId), {
      EMAIL: { consented: false, withdrawnAt: null },
      SMS: { consented: true, since: customer.smsMarketingAt, evidence: "recorded", wordingVersion: CURRENT_MARKETING_CONSENT_WORDING.SMS.version },
    });
  });

  it("records both grants when both boxes are ticked", async () => {
    const customerId = await booking({ emailMarketingConsent: true, smsMarketingConsent: true });
    assert.deepEqual((await events(customerId)).map((e) => e.channel).sort(), ["EMAIL", "SMS"]);
  });

  it("rolls consent back with a failed booking", async () => {
    const { location, slot } = await publicBookingPlace();
    await withFailingWrites("AppointmentEvent", "INSERT", () =>
      assert.rejects(
        createPublicBooking({
          name: "Rollback",
          email: "rollback@example.test",
          phone: "+1 555 010 0101",
          locationId: location.id,
          bookingSlotId: slot.id,
          appointmentDate: upcomingPublicBookingDate(),
          emailMarketingConsent: true,
        }),
      ),
    );
    assert.equal(await prisma.marketingConsentEvent.count(), 0);
    assert.equal(await prisma.customer.count(), 0);
  });

  it("withdraws append-only: clears the timestamp, keeps the grant, and is idempotent", async () => {
    const customerId = await booking({ emailMarketingConsent: true });
    const grant = (await events(customerId))[0];

    const first = await withdrawMarketingConsent({ customerId, channel: "EMAIL", actorId: "admin_1" });
    assert.equal(first.outcome, "withdrawn");
    const second = await withdrawMarketingConsent({ customerId, channel: "EMAIL", actorId: "admin_1" });
    assert.deepEqual(second, { outcome: "not-consented" });

    const history = await events(customerId);
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], grant);
    assert.equal(history[1].action, "WITHDRAWN");
    assert.equal(history[1].source, "INTERNAL_OPERATOR");
    assert.equal(history[1].actorId, "admin_1");
    assert.equal(history[1].wordingVersion, null);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).emailMarketingAt, null);
    assert.ok(first.outcome === "withdrawn");
    assert.deepEqual((await marketingConsentEvidence(customerId)).EMAIL, { consented: false, withdrawnAt: first.withdrawnAt });
  });

  it("rolls the withdrawal back atomically", async () => {
    const customerId = await booking({ emailMarketingConsent: true });
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION consent_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'consent test fault'; END; $$
    `);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER consent_test_fault BEFORE INSERT ON "MarketingConsentEvent" FOR EACH ROW EXECUTE FUNCTION consent_test_fault()`);
    try {
      await assert.rejects(withdrawMarketingConsent({ customerId, channel: "EMAIL", actorId: "admin_1" }), /consent test fault/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS consent_test_fault ON "MarketingConsentEvent"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS consent_test_fault()`);
    }
    assert.deepEqual(await prisma.customer.findUniqueOrThrow({ where: { id: customerId } }), before);
    assert.equal((await events(customerId)).length, 1);
  });

  it("represents pre-existing consent as unknown evidence, never fabricating it", async () => {
    const legacy = await createCustomer();
    const since = new Date("2026-01-15T12:00:00.000Z");
    await prisma.customer.update({ where: { id: legacy.id }, data: { emailMarketingAt: since } });

    assert.deepEqual(await marketingConsentEvidence(legacy.id), {
      EMAIL: { consented: true, since, evidence: "unknown" },
      SMS: { consented: false, withdrawnAt: null },
    });
    assert.equal(await prisma.marketingConsentEvent.count({ where: { customerId: legacy.id } }), 0);

    // Withdrawal still works and is recorded; nothing is invented about the grant.
    await withdrawMarketingConsent({ customerId: legacy.id, channel: "EMAIL", actorId: "admin_1" });
    assert.deepEqual((await events(legacy.id)).map((e) => e.action), ["WITHDRAWN"]);
  });

  it("is append-only and enforces evidence invariants in the database", async () => {
    const customerId = await booking({ emailMarketingConsent: true });
    const [grant] = await events(customerId);

    await assert.rejects(prisma.marketingConsentEvent.update({ where: { id: grant.id }, data: { wordingVersion: "other-v1" } }), /append-only/);
    await assert.rejects(prisma.marketingConsentEvent.delete({ where: { id: grant.id } }), /append-only/);

    const base = { customerId, channel: "EMAIL" as const, occurredAt: new Date() };
    const violations: [string, Parameters<typeof prisma.marketingConsentEvent.create>[0]["data"]][] = [
      ["MarketingConsentEvent_wording_iff_granted", { ...base, action: "GRANTED", source: "PUBLIC_BOOKING_FORM" }],
      ["MarketingConsentEvent_wording_iff_granted", { ...base, action: "WITHDRAWN", source: "INTERNAL_OPERATOR", actorId: "a", wordingVersion: "email-v1" }],
      ["MarketingConsentEvent_grant_from_form", { ...base, action: "GRANTED", source: "INTERNAL_OPERATOR", actorId: "a", wordingVersion: "email-v1" }],
      ["MarketingConsentEvent_actor_iff_operator", { ...base, action: "WITHDRAWN", source: "INTERNAL_OPERATOR" }],
      ["MarketingConsentEvent_actor_iff_operator", { ...base, action: "GRANTED", source: "PUBLIC_BOOKING_FORM", wordingVersion: "email-v1", actorId: "a" }],
      ["MarketingConsentEvent_wording_nonblank", { ...base, action: "GRANTED", source: "PUBLIC_BOOKING_FORM", wordingVersion: " " }],
    ];
    for (const [constraint, data] of violations) {
      await assert.rejects(prisma.marketingConsentEvent.create({ data }), new RegExp(constraint), constraint);
    }
  });

  it("rejects a blank operator id before writing", async () => {
    const customerId = await booking({ emailMarketingConsent: true });
    await assert.rejects(withdrawMarketingConsent({ customerId, channel: "EMAIL", actorId: " " }), /actorId/);
    assert.equal((await events(customerId)).length, 1);
  });
});
