import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const williamStreetSlots = [
  { localStartTime: "05:00", capacity: 10 },
  { localStartTime: "11:00", capacity: 10 },
  { localStartTime: "14:00", capacity: 10 },
];

/** Shown to customers as "524 William St, East Orange, NJ" (no postal code configured). */
const williamStreetAddress = {
  addressLine1: "524 William St",
  addressLine2: null,
  city: "East Orange",
  state: "NJ",
  postalCode: null,
};

function timeOfDay(time: string) {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

async function main() {
  const location = await prisma.salonLocation.upsert({
    where: { id: "william-street" },
    update: {
      name: "William Street",
      ...williamStreetAddress,
      acceptsOnlineBooking: true,
      timeZone: "America/New_York",
    },
    create: {
      id: "william-street",
      name: "William Street",
      ...williamStreetAddress,
      acceptsOnlineBooking: true,
      timeZone: "America/New_York",
    },
  });

  for (const slot of williamStreetSlots) {
    await prisma.bookingSlot.upsert({
      where: {
        locationId_localStartTime: {
          locationId: location.id,
          localStartTime: timeOfDay(slot.localStartTime),
        },
      },
      update: {
        capacity: slot.capacity,
        isActive: true,
      },
      create: {
        locationId: location.id,
        localStartTime: timeOfDay(slot.localStartTime),
        capacity: slot.capacity,
      },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
