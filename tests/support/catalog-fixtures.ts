import { prisma } from "@/lib/prisma";

/** Catalog test data. */

/** Creates a historical appointment that references `hairstyleId`. */
export async function createHistoricalAppointment(
  hairstyleId: string,
  hairstyleNameSnapshot: string,
) {
  const location = await prisma.salonLocation.create({
    data: { name: "Test Location", acceptsOnlineBooking: true, timeZone: "America/New_York" },
  });
  const slot = await prisma.bookingSlot.create({
    data: {
      locationId: location.id,
      localStartTime: new Date("1970-01-01T11:00:00.000Z"),
      capacity: 10,
    },
  });
  const customer = await prisma.customer.create({
    data: { name: "Test Customer", email: "customer@example.test", phone: "555-0100" },
  });

  return prisma.appointment.create({
    data: {
      customerId: customer.id,
      locationId: location.id,
      bookingSlotId: slot.id,
      hairstyleId,
      appointmentDate: new Date("2026-09-01T00:00:00.000Z"),
      status: "COMPLETED",
      locationNameSnapshot: location.name,
      slotTimeSnapshot: "11:00",
      hairstyleNameSnapshot,
      totalPriceCents: 20000,
      depositAmountCents: 5000,
      balanceDueCents: 15000,
    },
  });
}
