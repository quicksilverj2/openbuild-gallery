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
    where: { slug: 'voucher' },
    update: {},
    create: {
      slug: 'voucher',
      title: 'Voucher',
      summary: 'Single-use voucher redemption. Exactly-once under concurrency, idempotent per (voucher, user).',
      demoPath: '/clones/voucher',
      createdBy: 'seed',
    },
  });
  console.log('seeded clone: voucher');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
