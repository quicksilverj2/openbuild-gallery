import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.clone.upsert({
    where: { slug: 'poll' },
    update: {},
    create: {
      slug: 'poll',
      title: 'Poll',
      summary: 'Create a question, vote once, watch a live tally. Correct under concurrent load.',
      demoPath: '/clones/poll',
      createdBy: 'seed',
    },
  });
  console.log('seeded clone: poll');

  await prisma.clone.upsert({
    where: { slug: 'wallet' },
    update: {},
    create: {
      slug: 'wallet',
      title: 'Wallet',
      summary: 'Atomic transfers, append-only ledger, integer paise. Never goes negative.',
      demoPath: '/clones/wallet',
      createdBy: 'seed',
    },
  });
  console.log('seeded clone: wallet');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
