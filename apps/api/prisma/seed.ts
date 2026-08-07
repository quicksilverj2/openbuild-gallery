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
    where: { slug: 'shortlink' },
    update: {},
    create: {
      slug: 'shortlink',
      title: 'Shortlink',
      summary: 'Shorten a URL. Identical URLs dedupe to one code. Codes are non-enumerable.',
      demoPath: '/clones/shortlink',
      createdBy: 'seed',
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
