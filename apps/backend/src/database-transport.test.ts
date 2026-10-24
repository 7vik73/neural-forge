import { beforeEach, expect, it, vi } from 'vitest';
import { checkServerIdentity } from 'node:tls';
const mocks = vi.hoisted(() => ({
  mysql: vi.fn(),
  pg: vi.fn(),
  socket: vi.fn(),
  execute: vi.fn(),
  query: vi.fn(),
  certName: 'db.example',
  pgOptions: null as any,
}));
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => [
    { address: host === 'db.example' ? '192.0.2.5' : '127.0.0.1', family: 4 },
  ],
}));
vi.mock('node:net', () => ({
  isIP: (host: string) => (host === '192.0.2.5' ? 4 : 0),
  createConnection: mocks.socket,
}));
vi.mock('mysql2/promise', () => ({ default: { createConnection: mocks.mysql } }));
vi.mock('pg', () => ({
  Client: class {
    constructor(options: any) {
      mocks.pg(options);
      mocks.pgOptions = options;
    }
    async connect() {
      if (mocks.pgOptions.ssl) {
        const error = checkServerIdentity(mocks.pgOptions.ssl.servername, {
          subjectaltname: `DNS:${mocks.certName}`,
        } as any);
        if (error) throw error;
      }
    }
    query = mocks.query;
    async end() {}
  },
}));
import { externalDatabase } from './external-database.js';
const credentials = {
  host: 'db.example',
  port: '5439',
  database: 'test',
  user: 'test',
  password: 'test',
  tls: 'true',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.certName = 'db.example';
  mocks.execute.mockResolvedValue([[{ id: 1 }], {}]);
  mocks.query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
  mocks.mysql.mockImplementation(async (options: any) => {
    if (options.ssl && options.ssl.verifyIdentity) {
      const error = checkServerIdentity(options.host, {
        subjectaltname: `DNS:${mocks.certName}`,
      } as any);
      if (error) throw error;
    }
    return { execute: mocks.execute, end: async () => {} };
  });
});
it('pins MySQL TCP destination while retaining and verifying the TLS hostname', async () => {
  await externalDatabase('mysql', credentials, 'read', 'leads');
  const options = mocks.mysql.mock.calls[0]![0];
  expect(options.host).toBe('db.example');
  expect(options.ssl).toMatchObject({ verifyIdentity: true, rejectUnauthorized: true });
  options.stream();
  expect(mocks.socket).toHaveBeenCalledWith({ host: '192.0.2.5', port: 5439 });
  mocks.certName = 'wrong.example';
  await expect(externalDatabase('mysql', credentials, 'read', 'leads')).rejects.toThrow(
    'database operation failed',
  );
});
it('keeps PostgreSQL TLS identity separate from its pinned IP', async () => {
  await externalDatabase('postgres', credentials, 'read', 'leads');
  expect(mocks.pg.mock.calls[0]![0]).toMatchObject({
    host: '192.0.2.5',
    ssl: { servername: 'db.example', rejectUnauthorized: true },
  });
  mocks.certName = 'wrong.example';
  await expect(externalDatabase('postgres', credentials, 'read', 'leads')).rejects.toThrow(
    'database operation failed',
  );
});
it('classifies MySQL and PostgreSQL timed-out writes as outcome unknown', async () => {
  mocks.execute.mockRejectedValue(
    Object.assign(new Error('Sequence timed out'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }),
  );
  await expect(
    externalDatabase('mysql', credentials, 'insert', 'leads', { values: { name: 'Demo' } }),
  ).rejects.toMatchObject({ outcomeUnknown: true });
  mocks.query.mockRejectedValue(new Error('Query read timeout'));
  await expect(
    externalDatabase('postgres', credentials, 'update', 'leads', {
      filter: { id: 1 },
      values: { name: 'Demo' },
    }),
  ).rejects.toMatchObject({ outcomeUnknown: true });
  await expect(
    externalDatabase('postgres', credentials, 'read', 'leads', {}),
  ).rejects.toMatchObject({ outcomeUnknown: false, transient: true });
});
