import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ONLINE_BOOKING_HORIZON_DAYS,
  SAME_DAY_BOOKING_CUTOFF_MINUTES,
  dateClosedReason,
  publicBookingWindowClosedReason,
} from "@/lib/booking/booking-policy";
import { parsePublicBookingInput, PublicBookingValidationError } from "@/lib/booking/public-booking";
import { publicContactProblems, PUBLIC_PHONE_PATTERN } from "@/lib/booking/public-booking-rules";
import { addSalonDays, parseSalonDate, salonClockTime, salonToday } from "@/lib/booking/salon-calendar";

const NY = { id: "ny", timeZone: "America/New_York" };
const TOKYO = { id: "tokyo", timeZone: "Asia/Tokyo" };
const d = (value: string) => parseSalonDate(value);
const window = (date: string, slot: string, now: string, location = NY) => publicBookingWindowClosedReason(d(date), slot, location, new Date(now));

describe("public booking window: same-day cutoff", () => {
  // Monday 2027-03-01 15:00:00Z = 10:00:00 in New York (EST).
  const now = "2027-03-01T15:00:00.000Z";

  it("is 60 minutes", () => assert.equal(SAME_DAY_BOOKING_CUTOFF_MINUTES, 60));
  it("rejects a slot 59 minutes away", () => assert.equal(window("2027-03-01", "10:59", now), "ONLINE_BOOKING_CLOSED_FOR_DAY"));
  it("accepts a slot exactly 60 minutes away (inclusive boundary)", () => assert.equal(window("2027-03-01", "11:00", now), null));
  it("accepts a slot 61 minutes away", () => assert.equal(window("2027-03-01", "11:01", now), null));
  it("rejects 59:59 at second precision", () => assert.equal(window("2027-03-01", "11:00", "2027-03-01T15:00:01.000Z"), "ONLINE_BOOKING_CLOSED_FOR_DAY"));
  it("rejects a slot that already started", () => assert.equal(window("2027-03-01", "05:00", now), "ONLINE_BOOKING_CLOSED_FOR_DAY"));
  it("never applies to a later date", () => assert.equal(window("2027-03-02", "05:00", "2027-03-02T04:59:59.000Z"), null));
  it("rejects an unparseable slot time", () => assert.equal(window("2027-03-01", "11", now), "SLOT_NOT_BOOKABLE"));
});

describe("public booking window: horizon", () => {
  const now = "2027-03-01T15:00:00.000Z";
  it("is 30 calendar days", () => assert.equal(ONLINE_BOOKING_HORIZON_DAYS, 30));
  it("accepts salon-local today", () => assert.equal(window("2027-03-01", "14:00", now), null));
  it("accepts today + 30 days", () => assert.equal(window("2027-03-31", "05:00", now), null));
  it("rejects today + 31 days", () => assert.equal(window("2027-04-01", "05:00", now), "INVALID_APPOINTMENT_DATE"));
  it("leaves past dates and weekends to the general date policy", () => {
    assert.equal(dateClosedReason(d("2027-02-26"), NY, new Date(now)), "INVALID_APPOINTMENT_DATE");
    assert.equal(dateClosedReason(d("2027-03-06"), NY, new Date(now)), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    assert.equal(dateClosedReason(d("2027-03-07"), NY, new Date(now)), "ONLINE_BOOKING_CLOSED_FOR_DAY");
  });
  it("is not applied by the general date policy (internal flows keep their range)", () => {
    assert.equal(dateClosedReason(d("2027-09-01"), NY, new Date(now)), null);
  });
});

describe("public booking window: DST and salon-local midnight", () => {
  it("spring-forward (2027-03-14): wall clock jumps 02:00→03:00 EDT; cutoff uses salon wall time", () => {
    // 08:30Z = 04:30 EDT (after the jump).
    assert.equal(salonClockTime(NY.timeZone, new Date("2027-03-14T08:30:00.000Z")), "04:30:00");
    assert.equal(window("2027-03-14", "05:00", "2027-03-14T08:30:00.000Z"), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    assert.equal(window("2027-03-14", "05:30", "2027-03-14T08:30:00.000Z"), null);
    assert.equal(window("2027-03-14", "05:29", "2027-03-14T08:30:00.000Z"), "ONLINE_BOOKING_CLOSED_FOR_DAY");
  });

  it("fall-back (2027-11-07): wall clock repeats 01:00–02:00; slots from 05:00 are unaffected", () => {
    // 09:30Z = 04:30 EST (after the repeat).
    assert.equal(salonClockTime(NY.timeZone, new Date("2027-11-07T09:30:00.000Z")), "04:30:00");
    assert.equal(window("2027-11-07", "05:30", "2027-11-07T09:30:00.000Z"), null);
    assert.equal(window("2027-11-07", "05:29", "2027-11-07T09:30:00.000Z"), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    // During the repeated hour (first 01:30 EDT = 05:30Z), 05:00 is 3.5 wall-clock hours away.
    assert.equal(window("2027-11-07", "05:00", "2027-11-07T05:30:00.000Z"), null);
  });

  it("the horizon counts salon calendar days across a DST change", () => {
    assert.equal(addSalonDays(d("2027-03-01"), 30), "2027-03-31");
    assert.equal(addSalonDays(d("2027-10-20"), 30), "2027-11-19");
  });

  it("near midnight, 'today' is the salon's date, not UTC's", () => {
    // 2027-03-02T04:30Z is still Monday 2027-03-01 23:30 in New York, Tuesday 13:30 in Tokyo.
    const instant = "2027-03-02T04:30:00.000Z";
    assert.equal(salonToday(NY.timeZone, new Date(instant)), "2027-03-01");
    assert.equal(window("2027-03-01", "14:00", instant), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    assert.equal(window("2027-03-02", "05:00", instant), null);
    assert.equal(window("2027-03-31", "05:00", instant), null);
    assert.equal(window("2027-04-01", "05:00", instant), "INVALID_APPOINTMENT_DATE");
    assert.equal(salonToday(TOKYO.timeZone, new Date(instant)), "2027-03-02");
    assert.equal(window("2027-03-02", "14:30", instant, TOKYO), null);
    assert.equal(window("2027-03-02", "14:29", instant, TOKYO), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    assert.equal(window("2027-04-01", "05:00", instant, TOKYO), null);
  });
});

describe("shared public contact rules", () => {
  it("accept the server's formats and explain rejections", () => {
    assert.deepEqual(publicContactProblems({ name: "Amina", email: "a@example.test", phone: "(555) 010-0100", preferredStylistName: "" }), {});
    const problems = publicContactProblems({ name: " ", email: "bad", phone: "(555", preferredStylistName: "x".repeat(121) });
    assert.deepEqual(Object.keys(problems).sort(), ["email", "name", "phone", "preferredStylistName"]);
  });

  // Browser (publicContactProblems) and server (parsePublicBookingInput) must agree on every input.
  const accepted = ["(555) 010-0100", "(555)010-0100", "555 010 0100", "555-010-0100", "555.010.0100", "+1 (555) 010-0100", "+1 555 010 0100", "+(44) 20 7946 0958", "  (555) 010-0100  "];
  const rejected = ["", "x", "+", "(", "()555 0100", "((555) 010-0100", "555", "555 010 0100 ext 7", "phone: 5550100", "+-555 010 0100", "5".repeat(41)];

  it("accepts common US formatting, including a leading parenthesis", () => {
    for (const phone of accepted) {
      assert.equal(publicContactProblems({ name: "A", email: "a@example.test", phone, preferredStylistName: "" }).phone, undefined, phone);
      assert.equal(parsePublicBookingInput({ ...base, phone }).phone, phone.trim(), phone);
    }
  });

  it("keeps rejecting unsafe or malformed input on both sides", () => {
    for (const phone of rejected) {
      assert.ok(publicContactProblems({ name: "A", email: "a@example.test", phone, preferredStylistName: "" }).phone, phone);
      assert.throws(() => parsePublicBookingInput({ ...base, phone }), PublicBookingValidationError, phone);
    }
  });

  it("keeps the 40-character limit exactly", () => {
    const forty = `(555) ${"0".repeat(34)}`;
    assert.equal(forty.length, 40);
    assert.equal(parsePublicBookingInput({ ...base, phone: forty }).phone, forty);
    assert.throws(() => parsePublicBookingInput({ ...base, phone: `${forty}0` }), PublicBookingValidationError);
    assert.ok(publicContactProblems({ name: "A", email: "a@example.test", phone: `${forty}0`, preferredStylistName: "" }).phone);
  });

  it("never rewrites the number: no country code, no digit changes, trimming only", () => {
    assert.equal(parsePublicBookingInput({ ...base, phone: " (555) 010-0100 " }).phone, "(555) 010-0100");
    assert.equal(PUBLIC_PHONE_PATTERN.test("(555) 010-0100"), true);
  });
});

const base = { name: "Amina", email: "a@example.test", phone: "", locationId: "loc", bookingSlotId: "slot", appointmentDate: "2027-03-02" };
