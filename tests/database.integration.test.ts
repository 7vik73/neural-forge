import { it, expect } from 'vitest';
import { config as dotenv } from 'dotenv';
import { randomBytes } from 'node:crypto';
dotenv({ path: '.env', quiet: true });
it('updates only filtered rows across PostgreSQL partitions', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  if (!process.env.TEST_DATABASE_URL) url.pathname = '/forge_test';
  if (!url.pathname.endsWith('_test'))
    throw new Error('Database regression requires _test suffix.');
  const { PrismaClient } = await import('../apps/backend/node_modules/@prisma/client/default.js');
  const { databaseStatement } = await import('../apps/backend/dist/external-database.js');
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const table = `connector_${randomBytes(6).toString('hex')}`;
  try {
    await db.$executeRawUnsafe(
      `CREATE TABLE "${table}" (region integer, name text) PARTITION BY LIST(region)`,
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE "${table}_a" PARTITION OF "${table}" FOR VALUES IN (1)`,
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE "${table}_b" PARTITION OF "${table}" FOR VALUES IN (2)`,
    );
    await db.$executeRawUnsafe(`INSERT INTO "${table}" VALUES (1,'Sales'),(2,'Marketing')`);
    const query = databaseStatement('postgres', 'update', table, {
      filter: { region: 1 },
      values: { name: 'Changed' },
    });
    expect(await db.$executeRawUnsafe(query.sql, ...query.params)).toBe(1);
    expect(await db.$queryRawUnsafe(`SELECT region,name FROM "${table}" ORDER BY region`)).toEqual([
      { region: 1, name: 'Changed' },
      { region: 2, name: 'Marketing' },
    ]);
  } finally {
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    await db.$disconnect();
  }
});
