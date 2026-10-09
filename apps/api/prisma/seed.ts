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
  await prisma.clone.upsert({
    where: { slug: 'paste' },
    update: {},
    create: {
      slug: 'paste',
      title: 'Paste',
      summary:
        'Share text with a view limit and a TTL. Exactly N reads are served, even under a burst.',
      demoPath: '/clones/paste',
    },
  });
  console.log('seeded clones: poll, paste');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
