import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acquireBookingHold } from "@/lib/booking";
import { getPublicAvailability } from "@/lib/booking/availability";
import { addSalonDays, salonClockTime, salonToday, salonWeekday, type SalonDate } from "@/lib/booking/salon-calendar";
import { BookingError } from "@/lib/booking/errors";
import { createPublicBooking } from "@/lib/booking/public-booking";
import { createPublicBookingApi, defaultPublicBookingApiDeps } from "@/lib/http/public-booking-api";
import { prisma } from "@/lib/prisma";

import { createBookablePublicHairstyle, createCustomer, createLocation, fillSlot, insertAppointment, publicBookingPlace } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";
import { databaseNow } from "../support/payment-fixtures";

/** Monday 2027-03-01 15:00:00Z = 10:00 in New York. */
const NOW = new Date("2027-03-01T15:00:00.000Z");

const isCode = (code: string) => (error: unknown) => error instanceof BookingError && error.code === code;

let contact = 0;
async function input(location: { id: string }, slot: { id: string }, appointmentDate: string) {
  contact += 1;
  const hairstyle = await createBookablePublicHairstyle();
  return { name: `Window Customer ${contact}`, email: `window${contact}@example.test`, phone: `+1 555 030 ${String(contact).padStart(4, "0")}`, locationId: location.id, bookingSlotId: slot.id, appointmentDate, hairstyleId: hairstyle.id };
}

const weekday = (date: SalonDate) => salonWeekday(date) >= 1 && salonWeekday(date) <= 5;

/**
 * Public creation reads the real database clock, so same-day cases need a
 * location whose local "now" is a weekday morning or afternoon. On a UTC
 * weekend no IANA zone qualifies; those cases are then skipped, not faked.
 */
function daytimeWeekdayZone(now: Date): string | null {
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    const hour = Number(salonClockTime(zone, now).slice(0, 2));
    if (hour >= 6 && hour <= 20 && weekday(salonToday(zone, now))) return zone;
  }
  return null;
}
const sameDayZone = daytimeWeekdayZone(new Date());

/** Slot time "HH:mm" at salon-local now + minutes (same day). */
function slotIn(zone: string, now: Date, minutes: number): string {
  const [h, m] = salonClockTime(zone, now).split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

describe("public availability (YASMIN-1G)", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("offers salon-local today through today + 30 days, weekdays only, with the cutoff applied", async () => {
    const { location } = await createLocation({ name: "William Street", slots: [{ time: "05:00" }, { time: "11:00" }, { time: "14:00" }] });
    const availability = await getPublicAvailability({ now: NOW });
    assert.equal(availability.location.id, location.id);
    assert.equal(availability.salonToday, "2027-03-01");
    const dates = availability.dates.map((day) => day.date);
    assert.equal(dates[0], "2027-03-01");
    assert.equal(dates.at(-1), "2027-03-31");
    assert.equal(dates.length, 23);
    assert.ok(dates.every((date) => weekday(date as SalonDate)));
    assert.deepEqual(availability.dates[0].slots.map((slot) => [slot.time, slot.available]), [["05:00", false], ["11:00", true], ["14:00", true]]);
    assert.deepEqual(availability.dates[1].slots.map((slot) => slot.available), [true, true, true]);
    assert.deepEqual(availability.pricing, { totalPriceCents: 20_000, depositAmountCents: 4_000, balanceDueCents: 16_000 });
  });

  it("applies the 59/60/61-minute boundary to same-day slots", async () => {
    await createLocation({ slots: [{ time: "10:59" }, { time: "11:00" }, { time: "11:01" }] });
    const [today] = (await getPublicAvailability({ now: NOW })).dates;
    assert.deepEqual(today.slots.map((slot) => [slot.time, slot.available]), [["10:59", false], ["11:00", true], ["11:01", true]]);
  });

  it("uses the salon's date near midnight, not UTC's", async () => {
    await createLocation({ slots: [{ time: "05:00" }] });
    const availability = await getPublicAvailability({ now: new Date("2027-03-02T04:30:00.000Z") }); // Mon 23:30 in New York
    assert.equal(availability.salonToday, "2027-03-01");
    assert.equal(availability.dates[0].date, "2027-03-01");
    assert.equal(availability.dates[0].slots[0].available, false);
    assert.equal(availability.dates[1].slots[0].available, true);
    assert.equal(availability.dates.at(-1)?.date, "2027-03-31");
  });

  it("buckets capacity without exposing counts and marks a full slot unavailable", async () => {
    const { slots } = await createLocation({ slots: [{ time: "05:00", capacity: 10 }, { time: "11:00", capacity: 3 }, { time: "14:00", capacity: 2 }] });
    await fillSlot(slots[1], "2027-03-02", 1);
    await fillSlot(slots[2], "2027-03-02", 2);
    const customer = await createCustomer();
    // An expired hold releases its place; an active one consumes it.
    await insertAppointment({ slot: slots[0], customerId: customer.id, appointmentDate: "2027-03-02", status: "PENDING_PAYMENT", holdExpiresAt: new Date(NOW.getTime() - 1) });
    const day = (await getPublicAvailability({ now: NOW })).dates.find((item) => item.date === "2027-03-02")!;
    assert.deepEqual(day.slots.map((slot) => [slot.availability, slot.available]), [["available", true], ["limited", true], ["full", false]]);
  });

  it("returns only the allow-listed shape: no customer, appointment, payment or capacity facts", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 4 }] });
    const customer = await prisma.customer.create({ data: { name: "Private Person", email: "private@example.test", phone: "+1 555 999 0000" } });
    const appointment = await insertAppointment({ slot, customerId: customer.id, appointmentDate: "2027-03-02", status: "CONFIRMED" });
    const availability = await getPublicAvailability({ now: NOW });
    const text = JSON.stringify(availability);
    for (const secret of ["Private Person", "private@example.test", "555 999", customer.id, appointment.id]) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(Object.keys(availability).sort(), ["dates", "location", "pricing", "salonToday"]);
    assert.deepEqual(Object.keys(availability.location).sort(), ["address", "id", "name", "timeZone"]);
    assert.equal(availability.location.address, null);
    assert.deepEqual(Object.keys(availability.dates[0]).sort(), ["date", "slots"]);
    assert.deepEqual(Object.keys(availability.dates[0].slots[0]).sort(), ["availability", "available", "id", "time"]);
    for (const word of ["capacity", "consumed", "remaining", "Payment", "customer", "email"]) assert.equal(text.toLowerCase().includes(word.toLowerCase()), false, word);
  });

  it("returns the configured street address separately from the location name", async () => {
    const { location } = await createLocation({ name: "William Street" });
    await prisma.salonLocation.update({ where: { id: location.id }, data: { addressLine1: "524 William St", city: "East Orange", state: "NJ" } });
    const availability = await getPublicAvailability({ now: NOW });
    assert.deepEqual([availability.location.name, availability.location.address], ["William Street", "524 William St, East Orange, NJ"]);
  });

  it("fails closed when no location, or more than one, takes online bookings", async () => {
    await createLocation({ acceptsOnlineBooking: false });
    await assert.rejects(getPublicAvailability({ now: NOW }), isCode("LOCATION_NOT_BOOKABLE"));
    await createLocation({ name: "Online A" });
    await createLocation({ name: "Inactive online", isActive: false });
    assert.equal((await getPublicAvailability({ now: NOW })).location.name, "Online A");
    await createLocation({ name: "Online B" });
    await assert.rejects(getPublicAvailability({ now: NOW }), isCode("LOCATION_NOT_BOOKABLE"));
  });

  it("answers 404 with the public flag off and a fixed 409 for an ambiguous configuration over HTTP", async () => {
    await createLocation({ name: "Online A" });
    await createLocation({ name: "Online B" });
    const api = (env: Record<string, string>) => createPublicBookingApi({ ...defaultPublicBookingApiDeps, env: () => env, log: () => {} });
    const request = () => new Request("https://book.yasmin.example/api/bookings/availability");
    const off = await api({ PUBLIC_BOOKING_ENABLED: "false" }).getAvailability(request());
    assert.equal(off.status, 404);
    const on = await api({ PUBLIC_BOOKING_ENABLED: "true", APP_BASE_URL: "https://book.yasmin.example", RATE_LIMIT_SECRET: "x".repeat(40), TRUSTED_CLIENT_IP_SOURCE: "none" }).getAvailability(request());
    assert.equal(on.status, 409);
    assert.deepEqual((await on.json()).error.code, "BOOKING_OPTION_UNAVAILABLE");
    assert.equal(on.headers.get("cache-control"), "private, no-store");
  });
});

describe("public creation enforces the booking window (YASMIN-1G)", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("accepts the last weekday within the horizon and rejects the first weekday beyond it; internal holds stay broader", async () => {
    const { location, slot } = await publicBookingPlace();
    const today = salonToday(location.timeZone, await databaseNow());
    let inside = addSalonDays(today, 30);
    while (!weekday(inside)) inside = addSalonDays(inside, -1);
    let beyond = addSalonDays(today, 31);
    while (!weekday(beyond)) beyond = addSalonDays(beyond, 1);

    const accepted = await createPublicBooking(await input(location, slot, inside));
    assert.equal(accepted.booking.appointmentDate, inside);
    await assert.rejects(createPublicBooking(await input(location, slot, beyond)), isCode("INVALID_APPOINTMENT_DATE"));
    assert.equal(await prisma.appointment.count({ where: { appointmentDate: new Date(`${beyond}T00:00:00.000Z`) } }), 0);

    const customer = await createCustomer();
    const internal = await acquireBookingHold({ customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: beyond });
    assert.equal(internal.appointmentDate, beyond);
  });

  it("rejects a weekend date inside the horizon", async () => {
    const { location, slot } = await publicBookingPlace();
    let saturday = salonToday(location.timeZone, await databaseNow());
    while (salonWeekday(saturday) !== 6) saturday = addSalonDays(saturday, 1);
    await assert.rejects(createPublicBooking(await input(location, slot, saturday)), isCode("ONLINE_BOOKING_CLOSED_FOR_DAY"));
  });

  it("rejects a same-day slot inside the cutoff although an internal hold may take it", { skip: sameDayZone ? false : "no IANA zone is on a weekday daytime right now (UTC weekend)" }, async () => {
    const now = await databaseNow();
    const { location } = await publicBookingPlace({ timeZone: sameDayZone! });
    const today = salonToday(location.timeZone, now);
    const soon = await prisma.bookingSlot.create({ data: { locationId: location.id, localStartTime: new Date(`1970-01-01T${slotIn(location.timeZone, now, 30)}:00.000Z`), capacity: 10 } });
    const later = await prisma.bookingSlot.create({ data: { locationId: location.id, localStartTime: new Date(`1970-01-01T${slotIn(location.timeZone, now, 75)}:00.000Z`), capacity: 10 } });
    await assert.rejects(createPublicBooking(await input(location, soon, today)), isCode("ONLINE_BOOKING_CLOSED_FOR_DAY"));
    const accepted = await createPublicBooking(await input(location, later, today));
    assert.equal(accepted.booking.appointmentDate, today);
    const customer = await createCustomer();
    const internal = await acquireBookingHold({ customerId: customer.id, locationId: location.id, bookingSlotId: soon.id, appointmentDate: today }, { now });
    assert.equal(internal.appointmentDate, today);
  });

  it("rejects a full slot and leaves no Customer behind", async () => {
    const { location, slot } = await publicBookingPlace({ capacity: 2 });
    const date = salonToday(location.timeZone, addDays(await databaseNow(), 1));
    const day = weekday(date) ? date : nextWeekday(date);
    await fillSlot(slot, day, 2);
    const customersBefore = await prisma.customer.count();
    await assert.rejects(createPublicBooking(await input(location, slot, day)), isCode("CAPACITY_FULL"));
    assert.equal(await prisma.customer.count(), customersBefore);
  });

  it("admits exactly `capacity` of many concurrent public attempts", async () => {
    const { location, slot } = await publicBookingPlace({ capacity: 2 });
    const day = nextWeekday(salonToday(location.timeZone, await databaseNow()));
    const requests = await Promise.all(Array.from({ length: 6 }, () => input(location, slot, day)));
    const results = await Promise.allSettled(requests.map((request) => createPublicBooking(request)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    for (const result of results) if (result.status === "rejected") assert.ok(isCode("CAPACITY_FULL")(result.reason));
    assert.equal(await prisma.appointment.count({ where: { bookingSlotId: slot.id } }), 2);
    assert.equal(await prisma.customer.count(), 2);
  });

  it("refuses public creation when the online location is disabled or ambiguous", async () => {
    const { location, slot } = await publicBookingPlace();
    const day = nextWeekday(salonToday(location.timeZone, await databaseNow()));
    const other = await createLocation({ name: "Second online" });
    await assert.rejects(createPublicBooking(await input(location, slot, day)), isCode("LOCATION_NOT_BOOKABLE"));
    await prisma.salonLocation.update({ where: { id: other.location.id }, data: { acceptsOnlineBooking: false } });
    await createPublicBooking(await input(location, slot, day));
    await prisma.salonLocation.update({ where: { id: location.id }, data: { acceptsOnlineBooking: false } });
    await assert.rejects(createPublicBooking(await input(location, slot, day)), isCode("LOCATION_NOT_BOOKABLE"));
  });
});

function addDays(instant: Date, days: number) {
  return new Date(instant.getTime() + days * 86_400_000);
}

function nextWeekday(date: SalonDate): SalonDate {
  let next = addSalonDays(date, 1);
  while (!weekday(next)) next = addSalonDays(next, 1);
  return next;
}
