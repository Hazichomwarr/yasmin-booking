import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AppointmentStatus } from "@prisma/client";

import { dateClosedReason, locationClosedReason, slotClosedReason } from "@/lib/booking/booking-policy";
import { CAPACITY_CONTRIBUTION, consumesCapacity, remainingCapacity } from "@/lib/booking/capacity";
import { BOOKING_HOLD_MINUTES, holdExpiryFor } from "@/lib/booking/holds";
import { v1BookingPriceSnapshot } from "@/lib/booking/pricing";
import {
  assertValidSalonTimeZone,
  parseSalonDate,
  salonClockTimeFromDatabase,
  salonDateFromDatabase,
  salonDateToDatabase,
  salonToday,
  salonWeekday,
} from "@/lib/booking/salon-calendar";

import { assertBookingError } from "../support/assertions";

const NOW = new Date("2027-03-01T15:00:00.000Z");

describe("salon calendar dates", () => {
  it("parses strict YYYY-MM-DD calendar dates", () => {
    assert.equal(parseSalonDate(" 2027-03-08 "), "2027-03-08");
    assert.equal(parseSalonDate("2028-02-29"), "2028-02-29");
  });

  it("rejects malformed or impossible dates", async () => {
    for (const bad of ["2027-3-8", "2027-02-29", "2027-13-01", "2027-03-08T00:00:00Z", "", null, 20270308]) {
      await assertBookingError(() => parseSalonDate(bad), "INVALID_APPOINTMENT_DATE");
    }
  });

  it("computes weekdays from the calendar date", () => {
    const week = ["2027-03-08", "2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12", "2027-03-13", "2027-03-14"];
    assert.deepEqual(week.map((d) => salonWeekday(parseSalonDate(d))), [1, 2, 3, 4, 5, 6, 0]);
  });
});

describe("salon calendar is independent of the process timezone", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // From UTC−11 to UTC+14: any of these would shift a naive local-time conversion.
  for (const tz of ["Pacific/Pago_Pago", "America/Los_Angeles", "UTC", "Asia/Tokyo", "Pacific/Kiritimati"]) {
    it(`keeps dates, weekdays, and clock times stable in ${tz}`, () => {
      process.env.TZ = tz;
      const monday = parseSalonDate("2027-03-08");

      assert.equal(salonWeekday(monday), 1);
      assert.equal(salonDateFromDatabase(salonDateToDatabase(monday)), "2027-03-08");
      assert.equal(salonClockTimeFromDatabase(new Date("1970-01-01T05:00:00.000Z")), "05:00");
      assert.equal(salonClockTimeFromDatabase(new Date("1970-01-01T14:00:00.000Z")), "14:00");
    });
  }

  it("proves the test is meaningful: naive local getDay() does shift", () => {
    process.env.TZ = "Pacific/Pago_Pago";
    assert.equal(new Date("2027-03-08").getDay(), 0); // Sunday — wrong for a Monday salon date
  });
});

const newYork = { id: "ny-test", timeZone: "America/New_York" };
const tokyo = { id: "tokyo-test", timeZone: "Asia/Tokyo" };
const policy = (date: string, location: { id: string; timeZone: string }, now: Date) =>
  dateClosedReason(parseSalonDate(date), location, now);

describe("salon timezone configuration", () => {
  it("accepts canonical IANA zones", () => {
    assert.equal(assertValidSalonTimeZone("America/New_York", "loc"), "America/New_York");
    assert.equal(assertValidSalonTimeZone("Europe/London", "loc"), "Europe/London");
  });

  it("rejects abbreviations, fixed offsets, UTC, aliases, unknown zones, and non-strings", async () => {
    for (const bad of ["EST", "EDT", "UTC-5", "-05:00", "Etc/GMT+5", "UTC", "US/Eastern", "Mars/Olympus", "", null]) {
      await assertBookingError(() => assertValidSalonTimeZone(bad, "loc"), "LOCATION_TIME_ZONE_INVALID");
    }
  });

  it("the date policy fails explicitly on a misconfigured location instead of falling back", async () => {
    await assertBookingError(
      () => policy("2027-03-08", { id: "bad", timeZone: "EST" }, NOW),
      "LOCATION_TIME_ZONE_INVALID",
    );
  });
});

describe("salon-local today around New York midnight", () => {
  // Winter (EST, UTC−5). 2027-01-13T04:30Z is Tue 2027-01-12 23:30 in New York;
  // UTC has already moved to Wednesday.
  const tuesdayLateNight = new Date("2027-01-13T04:30:00.000Z");
  // 2027-01-13T05:30Z is Wed 2027-01-13 00:30 in New York.
  const wednesdayJustAfterMidnight = new Date("2027-01-13T05:30:00.000Z");

  it("derives today from the location timezone, not UTC", () => {
    assert.equal(tuesdayLateNight.toISOString().slice(0, 10), "2027-01-13");
    assert.equal(salonToday("America/New_York", tuesdayLateNight), "2027-01-12");
    assert.equal(salonToday("America/New_York", wednesdayJustAfterMidnight), "2027-01-13");
  });

  it("rejects yesterday in New York", () => {
    assert.equal(policy("2027-01-11", newYork, tuesdayLateNight), "INVALID_APPOINTMENT_DATE");
    assert.equal(policy("2027-01-12", newYork, wednesdayJustAfterMidnight), "INVALID_APPOINTMENT_DATE");
  });

  it("accepts today in New York (a weekday) even though UTC is already tomorrow", () => {
    assert.equal(policy("2027-01-12", newYork, tuesdayLateNight), null);
  });

  it("accepts a future New York date", () => {
    assert.equal(policy("2027-01-13", newYork, tuesdayLateNight), null);
    assert.equal(policy("2027-02-01", newYork, tuesdayLateNight), null);
  });

  it("the same instant gives a different today for a location in another timezone", () => {
    // 2027-01-13T04:30Z is already Wed 13:30 in Tokyo.
    assert.equal(policy("2027-01-12", tokyo, tuesdayLateNight), "INVALID_APPOINTMENT_DATE");
    assert.equal(policy("2027-01-12", newYork, tuesdayLateNight), null);
  });

  it("follows daylight saving time (EDT, UTC−4) — a fixed −05:00 offset would be wrong here", () => {
    // 2027-07-14T04:30Z is Wed 2027-07-14 00:30 EDT (a fixed UTC−5 would say Tue 23:30).
    const wednesdayEdt = new Date("2027-07-14T04:30:00.000Z");
    assert.equal(salonToday("America/New_York", wednesdayEdt), "2027-07-14");
    assert.equal(policy("2027-07-13", newYork, wednesdayEdt), "INVALID_APPOINTMENT_DATE");
    assert.equal(policy("2027-07-14", newYork, wednesdayEdt), null);

    // 2027-07-14T03:30Z is Tue 2027-07-13 23:30 EDT: Tuesday is still today.
    const tuesdayEdt = new Date("2027-07-14T03:30:00.000Z");
    assert.equal(policy("2027-07-13", newYork, tuesdayEdt), null);
  });

  it("weekend policy still applies independently, including on the salon's today", () => {
    const saturdayNoon = new Date("2027-01-16T17:00:00.000Z"); // Sat 12:00 in New York
    assert.equal(policy("2027-01-16", newYork, saturdayNoon), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    assert.equal(policy("2027-01-17", newYork, saturdayNoon), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    assert.equal(policy("2027-01-18", newYork, saturdayNoon), null);
  });

  describe("process TZ does not change the result", () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    for (const tz of ["UTC", "Pacific/Pago_Pago", "Asia/Tokyo", "Pacific/Kiritimati", "America/Los_Angeles"]) {
      it(`with TZ=${tz}`, () => {
        process.env.TZ = tz;
        assert.equal(salonToday("America/New_York", tuesdayLateNight), "2027-01-12");
        assert.equal(policy("2027-01-11", newYork, tuesdayLateNight), "INVALID_APPOINTMENT_DATE");
        assert.equal(policy("2027-01-12", newYork, tuesdayLateNight), null);
        assert.equal(policy("2027-01-13", newYork, tuesdayLateNight), null);
      });
    }
  });
});

describe("booking date policy", () => {
  it("accepts Monday through Friday", () => {
    for (const d of ["2027-03-08", "2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12"]) {
      assert.equal(policy(d, newYork, NOW), null, d);
    }
  });

  it("rejects Saturday and Sunday (walk-ins only)", () => {
    assert.equal(policy("2027-03-13", newYork, NOW), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    assert.equal(policy("2027-03-14", newYork, NOW), "ONLINE_BOOKING_CLOSED_FOR_DAY");
  });

  it("allows same-day weekday booking regardless of slot clock time", () => {
    // NOW is Monday 2027-03-01 10:00 in New York; there is no same-day cutoff in V1.
    assert.equal(policy("2027-03-01", newYork, NOW), null);
    assert.equal(policy("2027-02-26", newYork, NOW), "INVALID_APPOINTMENT_DATE");
  });

  it("requires an active location that accepts online booking, and an active slot", () => {
    assert.equal(locationClosedReason({ isActive: true, acceptsOnlineBooking: true }), null);
    assert.equal(locationClosedReason({ isActive: false, acceptsOnlineBooking: true }), "LOCATION_NOT_BOOKABLE");
    assert.equal(locationClosedReason({ isActive: true, acceptsOnlineBooking: false }), "LOCATION_NOT_BOOKABLE");
    assert.equal(slotClosedReason({ isActive: true }), null);
    assert.equal(slotClosedReason({ isActive: false }), "SLOT_NOT_BOOKABLE");
  });
});

describe("capacity rule", () => {
  const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

  it("classifies every AppointmentStatus", () => {
    assert.deepEqual(
      Object.keys(CAPACITY_CONTRIBUTION).sort(),
      Object.values(AppointmentStatus).sort(),
    );
  });

  const matrix: [string, AppointmentStatus, Date | null, boolean][] = [
    ["PENDING_PAYMENT, hold 1s in the future", "PENDING_PAYMENT", at(1000), true],
    ["PENDING_PAYMENT, hold expiring exactly now", "PENDING_PAYMENT", at(0), false],
    ["PENDING_PAYMENT, hold expired", "PENDING_PAYMENT", at(-1000), false],
    ["PENDING_PAYMENT, no hold expiry", "PENDING_PAYMENT", null, false],
    ["CONFIRMED", "CONFIRMED", null, true],
    ["COMPLETED", "COMPLETED", null, true],
    ["NO_SHOW", "NO_SHOW", null, true],
    ["CANCELLED", "CANCELLED", null, false],
  ];
  for (const [label, status, holdExpiresAt, expected] of matrix) {
    it(`${label} → ${expected ? "consumes" : "does not consume"}`, () => {
      assert.equal(consumesCapacity({ status, holdExpiresAt }, NOW), expected);
    });
  }

  it("never reports negative remaining capacity", () => {
    assert.equal(remainingCapacity(10, 0), 10);
    assert.equal(remainingCapacity(10, 10), 0);
    assert.equal(remainingCapacity(10, 12), 0);
  });
});

describe("V1 pricing and hold duration", () => {
  it("snapshots $200 total, $40 deposit, $160 balance", () => {
    assert.deepEqual(v1BookingPriceSnapshot(), {
      totalPriceCents: 20000,
      depositAmountCents: 4000,
      balanceDueCents: 16000,
    });
  });

  it("holds last BOOKING_HOLD_MINUTES (15) from the effective time", () => {
    assert.equal(BOOKING_HOLD_MINUTES, 15);
    assert.equal(holdExpiryFor(NOW).toISOString(), "2027-03-01T15:15:00.000Z");
  });
});
