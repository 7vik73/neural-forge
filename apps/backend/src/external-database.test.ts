import { expect, it } from 'vitest';
import { databaseStatement, checkDatabaseDestination } from './external-database.js';
it.each(['mysql', 'postgres'])('parameterizes %s read filters and bounds results', (kind) => {
  const result = databaseStatement(kind, 'read', 'leads', {
    filter: { email: "x' OR 1=1 --", deleted: null },
  });
  expect(result.sql).not.toContain("x' OR");
  expect(result.sql).toContain('IS NULL');
  expect(result.sql).toContain('LIMIT 1000');
  expect(result.params).toEqual(["x' OR 1=1 --"]);
});
it.each(['mysql', 'postgres'])('rejects unrestricted %s updates and identifiers', (kind) => {
  expect(() => databaseStatement(kind, 'update', 'leads', { values: { name: 'New' } })).toThrow(
    'filter',
  );
  expect(() => databaseStatement(kind, 'read', 'leads;DROP TABLE users', {})).toThrow(
    'simple table',
  );
});
it.each(['mysql', 'postgres'])(
  'keeps %s update values and filters in placeholder order',
  (kind) => {
    const result = databaseStatement(kind, 'update', 'leads', {
      filter: { id: 42 },
      values: { name: 'Changed' },
    });
    expect(result.params).toEqual(['Changed', 42]);
    expect(result.sql).toContain('LIMIT 1000');
    if (kind === 'postgres') expect(result.sql).toContain('"name" = $1');
  },
);
it('rejects installation service destinations before opening a database connection', async () => {
  await expect(
    checkDatabaseDestination({ host: 'host.docker.internal', port: '45432' }),
  ).rejects.toThrow('Installation');
  await expect(checkDatabaseDestination({ host: 'postgres', port: '5432' })).rejects.toThrow(
    'Installation',
  );
  await expect(checkDatabaseDestination({ host: '127.0.0.1', port: '4300' })).rejects.toThrow(
    'Installation',
  );
  await expect(checkDatabaseDestination({ host: '127.0.0.1', port: '46379' })).rejects.toThrow(
    'Installation',
  );
});
