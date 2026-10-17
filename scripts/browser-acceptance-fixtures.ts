import { prepareBrowserTestEnvironment } from "../tests/support/browser-test-environment";

// This must be the first database-related work in this process. All Prisma
// imports are dynamic below so an unsafe environment fails before a client can
// be constructed.
prepareBrowserTestEnvironment();

const email = process.env.BROWSER_TEST_ADMIN_EMAIL?.trim() || "ui-admin@example.test";
const password = process.env.BROWSER_TEST_ADMIN_PASSWORD;
if (!password) {
  throw new Error("BROWSER_TEST_ADMIN_PASSWORD is required for synthetic browser fixtures.");
}
const adminPassword = password;

function nextWeekday(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const [{ prisma }, { provisionAdminPassword }, { createAppointmentIn, createLocation }] = await Promise.all([
    import("../lib/prisma"),
    import("../lib/admin/provision"),
    import("../tests/support/booking-fixtures"),
  ]);

  try {
    const appointmentDate = nextWeekday();
    await provisionAdminPassword({ email, password: adminPassword });

    const { slots } = await createLocation({
      name: "Browser Acceptance Salon",
      slots: [
        { time: "09:00", capacity: 4 },
        { time: "11:00", capacity: 4 },
        { time: "14:00", capacity: 4 },
      ],
    });

    async function createSyntheticAppointment(
      name: string,
      status: "CONFIRMED" | "PENDING_PAYMENT" | "CANCELLED" | "COMPLETED" | "NO_SHOW",
      slot = slots[0],
    ) {
      const row = await createAppointmentIn({
        slot,
        appointmentDate,
        status,
        holdExpiresAt: status === "PENDING_PAYMENT" ? new Date(Date.now() + 30 * 60_000) : null,
      });
      await prisma.customer.update({ where: { id: row.customerId }, data: { name } });
      return row;
    }

    const confirmed = await createSyntheticAppointment("Browser Confirmed Deposit", "CONFIRMED");
    const pending = await createSyntheticAppointment("Browser Open Checkout", "PENDING_PAYMENT", slots[1]);
    const cancelled = await createSyntheticAppointment("Browser Cancelled", "CANCELLED", slots[2]);
    const completed = await createSyntheticAppointment("Browser Completed", "COMPLETED", slots[0]);
    const noShow = await createSyntheticAppointment("Browser No Show", "NO_SHOW", slots[1]);
    const cancelTarget = await createSyntheticAppointment("Browser Cancel Target", "CONFIRMED", slots[2]);
    const now = new Date();

    await prisma.payment.create({
      data: {
        appointmentId: confirmed.id,
        provider: "STRIPE",
        purpose: "BOOKING_DEPOSIT",
        status: "PAID",
        amountCents: 4_000,
        currency: "usd",
        providerCheckoutSessionId: "cs_test_browser_paid",
        providerPaymentIntentId: "pi_test_browser_paid",
        paidAt: now,
        allocatedAt: now,
      },
    });
    await prisma.payment.create({
      data: {
        appointmentId: pending.id,
        provider: "STRIPE",
        purpose: "BOOKING_DEPOSIT",
        status: "PENDING",
        amountCents: 4_000,
        currency: "usd",
        providerCheckoutSessionId: "cs_test_browser_open",
        providerCheckoutExpiresAt: new Date(now.getTime() + 60 * 60_000),
      },
    });

    console.log(JSON.stringify({
      appointmentDate,
      appointments: {
        confirmed: confirmed.id,
        pending: pending.id,
        cancelled: cancelled.id,
        completed: completed.id,
        noShow: noShow.id,
        cancelTarget: cancelTarget.id,
      },
    }));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
