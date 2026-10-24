import { Database } from '../apps/backend/dist/database.js';
import { randomBytes, createHash } from 'node:crypto';
const username = process.argv[2]?.trim().toLowerCase();
if (!username) throw new Error('Usage: node scripts/manage.mjs reset-admin <username>');
const db = new Database();
try {
  const user = await db.user.findUnique({ where: { username } });
  if (!user?.isAdmin || user.status === 'deleted')
    throw new Error('Choose an existing non-deleted administrator account.');
  const token = randomBytes(32).toString('hex');
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { status: 'active' } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.accountToken.deleteMany({ where: { userId: user.id, purpose: 'reset' } });
    await tx.accountToken.create({
      data: {
        id: createHash('sha256').update(token).digest('hex'),
        purpose: 'reset',
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
  });
  console.log(
    `Private administrator recovery link (expires in 30 minutes): ${process.env.APP_URL ?? 'http://localhost:4300'}/#reset=${token}`,
  );
} finally {
  await db.$disconnect();
}
