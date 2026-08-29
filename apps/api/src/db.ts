import { PrismaClient } from '@prisma/client';

// In test/CI environments without a real DB, we still need to export a client
// so the app can be built and routes registered. The actual connection will
// fail at query time if no DB is available, but route registration succeeds.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
