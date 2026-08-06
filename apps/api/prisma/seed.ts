import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// The gallery ships with one clone: the Poll. Bounty #1 deepens it; later
// bounties add sibling clones (shortlink, paste, wallet, ...).
async function main() {
  await prisma.clone.upsert({
    where: { slug: 'poll' },
    update: {},
    create: {
      slug: 'poll',
      title: 'Poll',
      summary: 'Create a question, vote once, watch a live tally. Correct under concurrent load.',
      demoPath: '/clones/poll',
    },
  });
  console.log('seeded clone: poll');

  await prisma.clone.upsert({
    where: { slug: 'voucher' },
    update: {},
    create: {
      slug: 'voucher',
      title: 'Voucher',
      summary: 'Create and redeem single-use vouchers. Atomic redemption under concurrent load — exactly once, zero 5xx.',
      demoPath: '/clones/voucher',
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
