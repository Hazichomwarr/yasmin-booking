import { PrismaClient } from "@prisma/client";

// Reuse one client across Next.js dev hot reloads instead of opening a new
// connection pool on every module re-evaluation.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
