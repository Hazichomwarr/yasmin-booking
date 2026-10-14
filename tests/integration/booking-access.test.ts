import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Prisma } from "@prisma/client";

import { acquireBookingHold, cancelAppointment, isBookingAccessError, isBookingError } from "@/lib/booking";
import {
  assertBookingAccessUnderLock,
  generateBookingAccessToken,
  hashBookingAccessToken,
  issueBookingAccess,
  resolveBookingAccess,
  revokeBookingAccess,
  type BookingAccessClock,
} from "@/lib/booking/access";
import { lockAppointment } from "@/lib/booking/appointments";
import { startBookingDepositCheckout } from "@/lib/booking/checkout";
import type { BookingAccessDenialReason } from "@/lib/booking/errors";
import { prisma } from "@/lib/prisma";
import type { StripeCheckoutAdapter } from "@/lib/stripe/checkout";

import { WEEK, createCustomer, createLocation, insertAppointment, withFailingWrites } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const at = (instant: Date): BookingAccessClock => ({ now: async () => new Date(instant) });
const shifted = (instant: Date, ms: number) => new Date(instant.getTime() + ms);

const denied = (reason: BookingAccessDenialReason) => (error: unknown) => isBookingAccessError(error, reason);

async function hold() {
  const { slot } = await createLocation();
  const customer = await createCustomer();
  return acquireBookingHold({
    customerId: customer.id,
    locationId: slot.locationId,
    bookingSlotId: slot.id,
    appointmentDate: WEEK.tuesday,
  });
}

/** A hold with its booking-access token issued in one transaction. */
async function heldWithAccess() {
  const booking = await hold();
  const access = await prisma.$transaction((tx) => issueBookingAccess(tx, booking.appointmentId));
  return { appointmentId: booking.appointmentId, ...access };
}

async function accessColumns(appointmentId: string) {
  return prisma.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
    select: { accessTokenHash: true, accessTokenIssuedAt: true, accessTokenExpiresAt: true, accessTokenRevokedAt: true },
  });
}

async function history(appointmentId: string) {
  const [appointment, events, payments] = await Promise.all([
    prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } }),
    prisma.appointmentEvent.findMany({ where: { appointmentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.payment.findMany({ where: { appointmentId } }),
  ]);
  return { appointment, events, payments };
}

function underLock(grant: Awaited<ReturnType<typeof resolveBookingAccess>>, clock?: BookingAccessClock) {
  return prisma.$transaction(async (tx) => {
    await lockAppointment(tx, grant.appointmentId);
    await assertBookingAccessUnderLock(tx, grant, clock);
  });
}

function stripeDouble(): StripeCheckoutAdapter {
  return {
    async createDepositCheckout(input) {
      return {
        id: `cs_access_${input.paymentId}`,
        url: `https://checkout.example.test/${input.paymentId}`,
        amountCents: input.amountCents,
        currency: input.currency,
        mode: "payment",
        expiresAt: input.expiresAt,
        metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId },
      };
    },
    async retrieveDepositCheckout() {
      throw new Error("not used by this test double");
    },
  };
}

describe("booking access", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  describe("issuance", () => {
    it("stores only the SHA-256 digest with a 24-hour expiry from the database clock", async () => {
      const booking = await hold();
      const before = new Date();
      const access = await prisma.$transaction((tx) => issueBookingAccess(tx, booking.appointmentId));

      const columns = await accessColumns(booking.appointmentId);
      assert.equal(columns.accessTokenHash, hashBookingAccessToken(access.token));
      assert.deepEqual(columns.accessTokenIssuedAt, access.issuedAt);
      assert.deepEqual(columns.accessTokenExpiresAt, access.expiresAt);
      assert.equal(columns.accessTokenRevokedAt, null);
      assert.equal(access.expiresAt.getTime() - access.issuedAt.getTime(), 24 * 60 * 60 * 1000);
      assert.ok(Math.abs(access.issuedAt.getTime() - before.getTime()) < 60_000);
    });

    it("never persists the plaintext token anywhere", async () => {
      const { appointmentId, token } = await heldWithAccess();
      await revokeBookingAccess({ appointmentId, reason: "administrative", actorId: "admin_1" });

      const { appointment, events, payments } = await history(appointmentId);
      const persisted = JSON.stringify({ appointment, events, payments });
      assert.ok(!persisted.includes(token));
      // The digest lives only in its column, never in history.
      assert.ok(!JSON.stringify(events).includes(hashBookingAccessToken(token)));
    });

    it("issues at most one token per appointment (no silent rotation)", async () => {
      const { appointmentId, token } = await heldWithAccess();
      const before = await accessColumns(appointmentId);

      await assert.rejects(
        prisma.$transaction((tx) => issueBookingAccess(tx, appointmentId)),
        /already has booking access/,
      );
      assert.deepEqual(await accessColumns(appointmentId), before);
      assert.equal((await resolveBookingAccess(token)).appointmentId, appointmentId);
    });

    it("refuses a missing appointment", async () => {
      await assert.rejects(
        prisma.$transaction((tx) => issueBookingAccess(tx, "missing-appointment")),
        (error) => isBookingError(error, "APPOINTMENT_NOT_FOUND"),
      );
    });

    it("rolls back with the caller's transaction", async () => {
      const booking = await hold();
      await assert.rejects(
        prisma.$transaction(async (tx) => {
          await issueBookingAccess(tx, booking.appointmentId);
          throw new Error("caller failed");
        }),
        /caller failed/,
      );
      assert.equal((await accessColumns(booking.appointmentId)).accessTokenHash, null);
    });
  });

  describe("resolution", () => {
    it("resolves a valid token to its own appointment", async () => {
      const a = await heldWithAccess();
      const b = await heldWithAccess();

      assert.equal((await resolveBookingAccess(a.token)).appointmentId, a.appointmentId);
      assert.equal((await resolveBookingAccess(b.token)).appointmentId, b.appointmentId);
    });

    it("rejects an unknown well-formed token", async () => {
      await heldWithAccess();
      await assert.rejects(resolveBookingAccess(generateBookingAccessToken()), denied("UNKNOWN"));
    });

    it("rejects a malformed token, including a digest presented as a token", async () => {
      const { token } = await heldWithAccess();
      for (const bad of ["", "not-a-token", `${token}x`, hashBookingAccessToken(token), undefined]) {
        await assert.rejects(resolveBookingAccess(bad), denied("MALFORMED"));
      }
    });

    it("rejects an expired token at and after the expiry instant", async () => {
      const { token, expiresAt } = await heldWithAccess();

      const grant = await resolveBookingAccess(token, { clock: at(shifted(expiresAt, -1)) });
      assert.ok(grant.appointmentId);
      await assert.rejects(resolveBookingAccess(token, { clock: at(expiresAt) }), denied("EXPIRED"));
      await assert.rejects(resolveBookingAccess(token, { clock: at(shifted(expiresAt, 1)) }), denied("EXPIRED"));
    });

    it("rejects a revoked token even before it expires", async () => {
      const { appointmentId, token, issuedAt } = await heldWithAccess();
      await revokeBookingAccess({ appointmentId, reason: "suspected-compromise", actorId: "admin_1" });

      await assert.rejects(resolveBookingAccess(token), denied("REVOKED"));
      await assert.rejects(resolveBookingAccess(token, { clock: at(issuedAt) }), denied("REVOKED"));
    });

    it("gives an appointment without a token no access, by token or by id", async () => {
      const { slot } = await createLocation();
      const customer = await createCustomer();
      const legacy = await insertAppointment({
        slot,
        customerId: customer.id,
        appointmentDate: WEEK.tuesday,
        status: "PENDING_PAYMENT",
        holdExpiresAt: shifted(new Date(), 15 * 60_000),
      });

      assert.deepEqual(await accessColumns(legacy.id), {
        accessTokenHash: null,
        accessTokenIssuedAt: null,
        accessTokenExpiresAt: null,
        accessTokenRevokedAt: null,
      });
      await assert.rejects(resolveBookingAccess(legacy.id), denied("MALFORMED"));
      await assert.rejects(resolveBookingAccess(generateBookingAccessToken()), denied("UNKNOWN"));
      assert.deepEqual(
        await revokeBookingAccess({ appointmentId: legacy.id, reason: "administrative", actorId: "admin_1" }),
        { outcome: "not-issued" },
      );
      assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: legacy.id } }), 0);
    });

    it("never lets a token for A authorize B", async () => {
      const a = await heldWithAccess();
      const b = await heldWithAccess();
      const grantA = await resolveBookingAccess(a.token);

      assert.equal(grantA.appointmentId, a.appointmentId);
      assert.notEqual(grantA.appointmentId, b.appointmentId);
      // A grant cannot be retargeted…
      assert.throws(() => {
        (grantA as { appointmentId: string }).appointmentId = b.appointmentId;
      }, TypeError);
      // …nor rebuilt for B from A.
      await assert.rejects(
        prisma.$transaction((tx) => assertBookingAccessUnderLock(tx, { ...grantA, appointmentId: b.appointmentId })),
        /Not a booking-access grant/,
      );
      // B's own revocation does not affect A.
      await revokeBookingAccess({ appointmentId: b.appointmentId, reason: "administrative", actorId: "admin_1" });
      await underLock(grantA);
    });
  });

  describe("under-lock revalidation", () => {
    it("accepts a still-valid grant up to one millisecond before expiry", async () => {
      const { token, expiresAt } = await heldWithAccess();
      const grant = await resolveBookingAccess(token);

      await underLock(grant);
      await underLock(grant, at(shifted(expiresAt, -1)));
      await assert.rejects(underLock(grant, at(expiresAt)), denied("EXPIRED"));
    });

    it("catches revocation between resolution and the mutation", async () => {
      const { appointmentId, token } = await heldWithAccess();
      const grant = await resolveBookingAccess(token);
      await revokeBookingAccess({ appointmentId, reason: "suspected-compromise", actorId: "admin_1" });

      await assert.rejects(underLock(grant), denied("REVOKED"));
    });

    it("rejects a grant whose token no longer matches the appointment", async () => {
      const { appointmentId, token } = await heldWithAccess();
      const grant = await resolveBookingAccess(token);
      // Simulates a credential replaced out of band (no rotation API exists).
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { accessTokenHash: hashBookingAccessToken(generateBookingAccessToken()) },
      });

      await assert.rejects(underLock(grant), denied("UNKNOWN"));
    });

    it("serializes with revocation on the appointment row lock", async () => {
      const { appointmentId, token } = await heldWithAccess();
      const grant = await resolveBookingAccess(token);

      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let revocationDone = false;

      const mutation = prisma.$transaction(
        async (tx) => {
          await lockAppointment(tx, appointmentId);
          await assertBookingAccessUnderLock(tx, grant);
          await released;
          // The revocation was blocked behind our lock the whole time.
          assert.equal(revocationDone, false);
        },
        { timeout: 10_000 },
      );
      const revocation = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const pending = revokeBookingAccess({ appointmentId, reason: "administrative", actorId: "admin_1" }).then((r) => {
          revocationDone = true;
          return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        release();
        return pending;
      })();

      await mutation;
      assert.equal((await revocation).outcome, "revoked");
      await assert.rejects(underLock(grant), denied("REVOKED"));
    });
  });

  describe("revocation", () => {
    it("sets revokedAt and appends exactly one ACCESS_REVOKED event, preserving prior history", async () => {
      const { appointmentId, issuedAt, expiresAt } = await heldWithAccess();
      const before = await history(appointmentId);

      const result = await revokeBookingAccess({ appointmentId, reason: "customer-request", actorId: "admin_42" });
      assert.equal(result.outcome, "revoked");

      const after = await history(appointmentId);
      const columns = await accessColumns(appointmentId);
      assert.ok(result.outcome === "revoked");
      assert.deepEqual(columns.accessTokenRevokedAt, result.revokedAt);

      assert.deepEqual(after.events.slice(0, before.events.length), before.events);
      assert.equal(after.events.length, before.events.length + 1);
      const event = after.events.at(-1)!;
      assert.equal(event.type, "ACCESS_REVOKED");
      assert.deepEqual(event.details, {
        schemaVersion: 1,
        reason: "customer-request",
        actorId: "admin_42",
        tokenIssuedAt: issuedAt.toISOString(),
        tokenExpiresAt: expiresAt.toISOString(),
        revokedAt: result.revokedAt.toISOString(),
      });

      // Booking state, money and snapshots are untouched.
      assert.deepEqual(
        { ...after.appointment, updatedAt: null, accessTokenRevokedAt: null },
        { ...before.appointment, updatedAt: null, accessTokenRevokedAt: null },
      );
      assert.deepEqual(after.payments, before.payments);
    });

    it("is idempotent: a repeat writes nothing and reports the original revocation", async () => {
      const { appointmentId } = await heldWithAccess();
      const first = await revokeBookingAccess({ appointmentId, reason: "suspected-compromise", actorId: "admin_1" });
      const snapshot = await history(appointmentId);

      const second = await revokeBookingAccess({ appointmentId, reason: "administrative", actorId: "admin_2" });
      assert.ok(first.outcome === "revoked");
      assert.deepEqual(second, { outcome: "already-revoked", revokedAt: first.revokedAt });
      assert.deepEqual(await history(appointmentId), snapshot);
    });

    it("lets concurrent revocations produce exactly one event", async () => {
      const { appointmentId } = await heldWithAccess();
      const results = await Promise.all(
        [1, 2, 3].map((n) => revokeBookingAccess({ appointmentId, reason: "administrative", actorId: `admin_${n}` })),
      );

      assert.deepEqual(results.map((r) => r.outcome).sort(), ["already-revoked", "already-revoked", "revoked"]);
      assert.equal(
        await prisma.appointmentEvent.count({ where: { appointmentId, type: "ACCESS_REVOKED" } }),
        1,
      );
    });

    it("can revoke an expired token", async () => {
      const { appointmentId } = await heldWithAccess();
      await prisma.$executeRaw`
        UPDATE "Appointment"
        SET "accessTokenIssuedAt" = "accessTokenIssuedAt" - interval '2 days',
            "accessTokenExpiresAt" = "accessTokenExpiresAt" - interval '2 days'
        WHERE "id" = ${appointmentId}
      `;
      assert.equal((await revokeBookingAccess({ appointmentId, reason: "administrative", actorId: "admin_1" })).outcome, "revoked");
    });

    it("rolls back revokedAt when the audit event cannot be written", async () => {
      const { appointmentId, token } = await heldWithAccess();
      const before = await history(appointmentId);

      await withFailingWrites("AppointmentEvent", "INSERT", () =>
        assert.rejects(revokeBookingAccess({ appointmentId, reason: "administrative", actorId: "admin_1" }), /forced test failure/),
      );

      assert.deepEqual(await history(appointmentId), before);
      assert.equal((await resolveBookingAccess(token)).appointmentId, appointmentId);
    });

    it("writes no event when the appointment update fails", async () => {
      const { appointmentId } = await heldWithAccess();
      const before = await history(appointmentId);

      await withFailingWrites("Appointment", "UPDATE", () =>
        assert.rejects(revokeBookingAccess({ appointmentId, reason: "administrative", actorId: "admin_1" }), /forced test failure/),
      );

      assert.deepEqual(await history(appointmentId), before);
    });

    it("refuses invalid event facts without writing anything", async () => {
      const { appointmentId } = await heldWithAccess();
      const before = await history(appointmentId);

      await assert.rejects(revokeBookingAccess({ appointmentId, reason: "administrative", actorId: "" }), /actorId/);
      assert.deepEqual(await history(appointmentId), before);
    });

    it("reports a missing appointment as a booking error", async () => {
      await assert.rejects(
        revokeBookingAccess({ appointmentId: "missing-appointment", reason: "administrative", actorId: "admin_1" }),
        (error) => isBookingError(error, "APPOINTMENT_NOT_FOUND"),
      );
    });
  });

  describe("database constraints", () => {
    it("enforces a unique token hash", async () => {
      const a = await heldWithAccess();
      const b = await hold();

      await assert.rejects(
        prisma.appointment.update({
          where: { id: b.appointmentId },
          data: {
            accessTokenHash: hashBookingAccessToken(a.token),
            accessTokenIssuedAt: a.issuedAt,
            accessTokenExpiresAt: a.expiresAt,
          },
        }),
        (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
      );
    });

    it("rejects partial credentials, revocation without a token, raw tokens and inverted instants", async () => {
      const booking = await hold();
      const id = booking.appointmentId;
      const hash = hashBookingAccessToken(generateBookingAccessToken());
      const issued = new Date("2027-03-01T15:00:00.000Z");
      const expires = new Date("2027-03-02T15:00:00.000Z");

      const cases: [string, Prisma.AppointmentUpdateInput][] = [
        ["Appointment_access_token_complete", { accessTokenHash: hash }],
        ["Appointment_access_token_complete", { accessTokenHash: hash, accessTokenIssuedAt: issued }],
        ["Appointment_access_token_complete", { accessTokenIssuedAt: issued, accessTokenExpiresAt: expires }],
        ["Appointment_access_revoked_has_token", { accessTokenRevokedAt: issued }],
        [
          "Appointment_access_token_hash_sha256",
          { accessTokenHash: generateBookingAccessToken(), accessTokenIssuedAt: issued, accessTokenExpiresAt: expires },
        ],
        [
          "Appointment_access_expires_after_issue",
          { accessTokenHash: hash, accessTokenIssuedAt: issued, accessTokenExpiresAt: issued },
        ],
      ];
      for (const [constraint, data] of cases) {
        await assert.rejects(prisma.appointment.update({ where: { id }, data }), new RegExp(constraint), constraint);
      }
      assert.equal((await accessColumns(id)).accessTokenHash, null);
    });
  });

  describe("existing appointment and payment behavior", () => {
    it("checkout and cancellation behave unchanged and leave the credential intact", async () => {
      const { appointmentId, token } = await heldWithAccess();
      const credential = await accessColumns(appointmentId);

      const checkout = await startBookingDepositCheckout(appointmentId, stripeDouble());
      assert.equal(checkout.kind, "ready");
      assert.equal(await prisma.payment.count({ where: { appointmentId } }), 1);

      const cancelled = await cancelAppointment(appointmentId);
      assert.equal(cancelled.appointment.status, "CANCELLED");
      assert.ok(!("accessTokenHash" in cancelled.appointment));

      assert.deepEqual(await accessColumns(appointmentId), credential);
      // Access still authenticates; what a cancelled booking allows is a booking-state question.
      assert.equal((await resolveBookingAccess(token)).appointmentId, appointmentId);
      const events = await prisma.appointmentEvent.findMany({ where: { appointmentId }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(events.map((e) => e.type), ["CREATED", "HOLD_EXPIRY_CHANGED", "CANCELLED"]);
    });
  });
});
