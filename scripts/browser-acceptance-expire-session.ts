import { prepareBrowserTestEnvironment } from "../tests/support/browser-test-environment";

// Keep this test-only mutation behind the same database guard as fixtures.
prepareBrowserTestEnvironment();

const email = process.env.BROWSER_TEST_ADMIN_EMAIL?.trim() || "ui-admin@example.test";

async function main() {
  const { prisma } = await import("../lib/prisma");
  try {
    const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const result = await prisma.adminSession.updateMany({
      where: { adminUser: { email } },
      // This is after the fixture session's creation timestamp, so it honors
      // the session table's invariant while being expired at the next request.
      data: { expiresAt: now },
    });
    console.log(`Expired ${result.count} synthetic browser-test session(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
