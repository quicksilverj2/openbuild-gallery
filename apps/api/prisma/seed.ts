import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Gallery clones: Poll (seed) + Shortlink (bounty #3). Later bounties add more.
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
    where: { slug: 'shortlink' },
    update: {},
    create: {
      slug: 'shortlink',
      title: 'Shortlink',
      summary:
        'Shorten a URL to a non-enumerable code; concurrent identical shortens resolve to one code.',
      demoPath: '/clones/shortlink',
      createdBy: 'bounty-3',
    },
  });
  console.log('seeded clone: shortlink');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
