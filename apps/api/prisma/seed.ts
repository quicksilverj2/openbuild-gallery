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
    
    where: { slug: 'paste' },
    
    update: {},
    
    create: {
      
      slug: 'paste',
      
      title: 'Paste',
      
      summary: 'View-once paste service. Correct under concurrent reads.',
      
      demoPath: '/clones/paste',
      
    },
    
  });
  
  console.log('seeded clone: paste');
  
}



main()

  .catch((e) => {
    
    console.error(e);
    
    process.exit(1);
    
  })

  .finally(() => prisma.$disconnect());




























