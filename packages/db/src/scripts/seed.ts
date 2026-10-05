import { eq } from 'drizzle-orm';
import { createDb } from '../client';
import { users } from '../schema';
import { createUser } from '../services/auth';
import { seedConfig } from '../services/config';

const url = process.env.DATABASE_URL;
const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
if (!url || !email || !password) {
  throw new Error('DATABASE_URL, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set');
}

const { db, close } = createDb(url, { max: 1 });
try {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()));
  if (existing) {
    console.log(`admin ${email} already exists`);
  } else {
    await createUser(db, { email, name: 'Admin', role: 'admin', password });
    console.log(`created admin ${email}`);
  }
  const seeded = await seedConfig(db);
  console.log(seeded.length ? `seeded config: ${seeded.join(', ')}` : 'config already present');
} finally {
  await close();
}
