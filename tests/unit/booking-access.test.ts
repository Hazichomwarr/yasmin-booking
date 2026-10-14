import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Prisma } from "@prisma/client";

import {
  BOOKING_ACCESS_TOKEN_BYTES,
  BOOKING_ACCESS_TTL_MS,
  assertBookingAccessUnderLock,
  bookingAccessExpiry,
  generateBookingAccessToken,
  hashBookingAccessToken,
  isBookingAccessGrant,
  isWellFormedBookingAccessToken,
  newBookingAccessCredential,
  type BookingAccessGrant,
} from "@/lib/booking/access";
import { eventDetails } from "@/lib/booking/appointment-events";
import { appointmentSelect } from "@/lib/booking/appointments";
import {
  BookingAccessError,
  BookingError,
  isBookingAccessError,
  isBookingError,
} from "@/lib/booking/errors";

/** Pure tests: nothing here touches a database. */

const ISSUED_AT = new Date("2027-03-01T15:00:00.000Z");

describe("booking-access token generation", () => {
  it("is 32 random bytes as 43-character unpadded base64url", () => {
    const token = generateBookingAccessToken();
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const bytes = Buffer.from(token, "base64url");
    assert.equal(bytes.length, BOOKING_ACCESS_TOKEN_BYTES);
    assert.equal(bytes.toString("base64url"), token);
    assert.ok(isWellFormedBookingAccessToken(token));
  });

  it("never repeats and has balanced bits across many tokens", () => {
    const tokens = Array.from({ length: 10_000 }, generateBookingAccessToken);
    assert.equal(new Set(tokens).size, tokens.length);

    let ones = 0;
    for (const token of tokens) {
      for (const byte of Buffer.from(token, "base64url")) {
        for (let b = byte; b; b >>= 1) ones += b & 1;
      }
    }
    const bits = tokens.length * BOOKING_ACCESS_TOKEN_BYTES * 8;
    // 2.56M fair bits: the ratio lies within ±0.5% with overwhelming probability.
    assert.ok(Math.abs(ones / bits - 0.5) < 0.005, `bit ratio ${ones / bits}`);
  });

  it("recognises only well-formed tokens", () => {
    const token = generateBookingAccessToken();
    for (const bad of [
      undefined,
      null,
      42,
      {},
      "",
      token.slice(1),
      `${token}A`,
      `${token.slice(0, 42)}=`,
      `${token.slice(0, 42)}+`,
      `${token.slice(0, 42)}/`,
      ` ${token.slice(1)}`,
      hashBookingAccessToken(token),
    ]) {
      assert.equal(isWellFormedBookingAccessToken(bad), false, String(bad));
    }
  });
});

describe("booking-access token hashing", () => {
  it("is SHA-256 as lowercase hex", () => {
    assert.equal(
      hashBookingAccessToken("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and distinct per token", () => {
    const a = generateBookingAccessToken();
    const b = generateBookingAccessToken();
    assert.equal(hashBookingAccessToken(a), hashBookingAccessToken(a));
    assert.notEqual(hashBookingAccessToken(a), hashBookingAccessToken(b));
    assert.match(hashBookingAccessToken(a), /^[0-9a-f]{64}$/);
  });
});

describe("booking-access expiry", () => {
  it("is exactly 24 hours after issuance, without mutating the input", () => {
    const issuedAt = new Date(ISSUED_AT);
    assert.equal(BOOKING_ACCESS_TTL_MS, 86_400_000);
    assert.deepEqual(bookingAccessExpiry(issuedAt), new Date("2027-03-02T15:00:00.000Z"));
    assert.deepEqual(issuedAt, ISSUED_AT);
  });
});

describe("booking-access credential", () => {
  it("persists only the hash and instants, never the plaintext token", () => {
    const { token, credential } = newBookingAccessCredential(ISSUED_AT);
    assert.deepEqual(Object.keys(credential).sort(), [
      "accessTokenExpiresAt",
      "accessTokenHash",
      "accessTokenIssuedAt",
    ]);
    assert.equal(credential.accessTokenHash, hashBookingAccessToken(token));
    assert.deepEqual(credential.accessTokenIssuedAt, ISSUED_AT);
    assert.deepEqual(credential.accessTokenExpiresAt, bookingAccessExpiry(ISSUED_AT));
    assert.ok(!JSON.stringify(credential).includes(token));
  });

  it("is never part of the shared appointment read shape", () => {
    assert.deepEqual(
      Object.keys(appointmentSelect).filter((key) => key.startsWith("accessToken")),
      [],
    );
  });
});

describe("booking-access errors", () => {
  it("are typed, generic, and distinct from booking-state errors", () => {
    for (const reason of ["MALFORMED", "UNKNOWN", "EXPIRED", "REVOKED"] as const) {
      const error = new BookingAccessError(reason);
      assert.ok(error instanceof Error);
      assert.equal(error.name, "BookingAccessError");
      assert.equal(error.code, "BOOKING_ACCESS_DENIED");
      assert.equal(error.reason, reason);
      // The public-facing message never varies with the reason.
      assert.equal(error.message, "Booking access denied.");
      assert.ok(isBookingAccessError(error));
      assert.ok(isBookingAccessError(error, reason));
      assert.equal(isBookingError(error), false);
    }
    assert.equal(isBookingAccessError(new BookingAccessError("EXPIRED"), "REVOKED"), false);
    assert.equal(isBookingAccessError(new BookingError("APPOINTMENT_NOT_FOUND", "x")), false);
    assert.equal(isBookingAccessError({ code: "BOOKING_ACCESS_DENIED", reason: "UNKNOWN" }), false);
  });
});

describe("booking-access grants", () => {
  it("cannot be forged from an appointment id", async () => {
    const forged = Object.freeze({ appointmentId: "appointment-b" }) as BookingAccessGrant;
    assert.equal(isBookingAccessGrant(forged), false);
    // Rejected before the transaction is touched.
    const untouchedTx = {} as Prisma.TransactionClient;
    await assert.rejects(
      assertBookingAccessUnderLock(untouchedTx, forged),
      /Not a booking-access grant/,
    );
  });
});

describe("ACCESS_REVOKED event details", () => {
  const facts = {
    reason: "suspected-compromise" as const,
    actorId: "admin_1",
    tokenIssuedAt: ISSUED_AT,
    tokenExpiresAt: bookingAccessExpiry(ISSUED_AT),
    revokedAt: new Date("2027-03-01T16:00:00.000Z"),
  };

  it("records reason, actor and instants, and nothing secret-derived", () => {
    assert.deepEqual(eventDetails.accessRevoked(facts), {
      schemaVersion: 1,
      reason: "suspected-compromise",
      actorId: "admin_1",
      tokenIssuedAt: "2027-03-01T15:00:00.000Z",
      tokenExpiresAt: "2027-03-02T15:00:00.000Z",
      revokedAt: "2027-03-01T16:00:00.000Z",
    });
  });

  it("refuses unknown reasons and blank actors", () => {
    assert.throws(
      () => eventDetails.accessRevoked({ ...facts, reason: "because" as never }),
      /revocation reason/,
    );
    assert.throws(() => eventDetails.accessRevoked({ ...facts, actorId: " " }), /actorId/);
  });
});
