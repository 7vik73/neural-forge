import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNode, catalog } from '@forge/connectors';
const mock = vi.hoisted(() => ({
  fetch: vi.fn(),
  drive: { files: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn() } },
  calendar: { events: { list: vi.fn(), insert: vi.fn(), patch: vi.fn() } },
  database: vi.fn(),
}));
vi.mock('./connections.js', () => ({ providerFetch: mock.fetch }));
vi.mock('googleapis', () => ({
  google: { drive: () => mock.drive, calendar: () => mock.calendar },
}));
vi.mock('./external-database.js', () => ({ externalDatabase: mock.database }));
import { AppExecutors } from './apps-executor.js';
const connection = { get: vi.fn(), google: vi.fn(), microsoft: vi.fn() };
const apps = new AppExecutors(connection as any);
beforeEach(() => {
  vi.resetAllMocks();
  connection.get.mockImplementation(async (id, kind) => ({
    id,
    kind,
    credentials: {
      token: 'synthetic-token',
      webhook: 'https://discord.com/api/webhooks/123456/demo-token',
    },
  }));
  connection.google.mockResolvedValue({});
  connection.microsoft.mockResolvedValue({ id: 'message', value: [{ id: 'row', name: 'Table' }] });
  mock.fetch.mockResolvedValue({
    ok: true,
    id: 'result',
    ts: '123',
    message: { text: 'Demo' },
    content: 'Demo',
    results: [{ id: 'record', type: 'page' }],
  });
  mock.database.mockResolvedValue({ items: [{ id: 1 }], updated: 1 });
  mock.drive.files.list.mockResolvedValue({ data: { files: [{ id: 'file', name: 'demo.txt' }] } });
  mock.drive.files.get.mockImplementation(async (args) =>
    args.alt
      ? { data: 'Public demo text' }
      : { data: { id: 'file', name: 'demo.txt', mimeType: 'text/plain', size: '10' } },
  );
  mock.drive.files.create.mockResolvedValue({ data: { id: 'created', name: 'demo.txt' } });
  mock.drive.files.update.mockResolvedValue({ data: { id: 'updated' } });
  mock.calendar.events.list.mockResolvedValue({ data: { items: [{ id: 'event' }] } });
  mock.calendar.events.insert.mockResolvedValue({
    data: { id: 'event', htmlLink: 'https://example.com/event' },
  });
  mock.calendar.events.patch.mockResolvedValue({ data: { id: 'event' } });
});
afterEach(() => vi.restoreAllMocks());
const cases: [string, any, any][] = [
  ['drive.search', {}, { query: 'trashed=false' }],
  ['drive.read', { fileId: 'file' }, {}],
  ['drive.create', {}, { name: 'demo.txt', text: 'Demo' }],
  ['drive.update', { fileId: 'file' }, { text: 'Demo' }],
  ['calendar.list', { calendarId: 'primary' }, {}],
  [
    'calendar.create',
    { calendarId: 'primary' },
    { title: 'Demo', start: '2026-10-22T10:00:00Z', end: '2026-10-22T11:00:00Z' },
  ],
  [
    'calendar.update',
    { calendarId: 'primary' },
    { eventId: 'event', title: 'Demo', start: '2026-10-22T10:00:00Z', end: '2026-10-22T11:00:00Z' },
  ],
  ['slack.read', { channelId: 'channel' }, {}],
  ['slack.send', { channelId: 'channel' }, { text: 'Demo' }],
  ['discord.send', {}, { text: 'Demo' }],
  ['notion.search', {}, { query: 'Demo' }],
  ['notion.read', { pageId: 'page' }, {}],
  ['notion.create', { parentId: 'parent' }, { title: 'Demo', text: 'Demo' }],
  ['notion.update', { pageId: 'page' }, { text: 'Demo' }],
  ['notion.records', { dataSourceId: 'source' }, {}],
  [
    'notion.record.create',
    { dataSourceId: 'source' },
    { properties: { Name: { title: [{ text: { content: 'Demo' } }] } } },
  ],
  ['notion.record.update', {}, { pageId: 'record', properties: { Done: { checkbox: true } } }],
  ['outlook.search', {}, { query: 'Demo' }],
  ['outlook.read', {}, { id: 'message' }],
  ['outlook.draft', { to: 'demo@example.invalid' }, { subject: 'Demo', text: 'Demo' }],
  ['outlook.send', { to: 'demo@example.invalid' }, { subject: 'Demo', text: 'Demo' }],
  ['excel.read', { workbookId: 'book', tableId: 'table' }, {}],
  ['excel.append', { workbookId: 'book', tableId: 'table' }, { rows: [['Demo']] }],
  ['excel.update', { workbookId: 'book', tableId: 'table' }, { rowIndex: 0, rows: [['Changed']] }],
  ...(['mysql', 'postgres'] as const).flatMap((kind) =>
    (
      [
        ['read', { filter: { id: 1 } }],
        ['insert', { values: { name: 'Demo' } }],
        ['update', { filter: { id: 1 }, values: { name: 'Changed' } }],
      ] as const
    ).map(
      ([action, input]) => [`${kind}.${action}`, { table: 'leads' }, input] as [string, any, any],
    ),
  ),
];
it.each(cases)(
  'executes the registered %s operation through its provider contract',
  async (type, config, input) => {
    const node = createNode(type, 'action');
    node.config = { ...node.config, ...config, connectionId: 'workspace-connection' };
    expect(await apps.execute(node, input)).toBeTypeOf('object');
    expect(catalog.find((n) => n.type === type)).toBeDefined();
    if (type.startsWith('mysql.') || type.startsWith('postgres.'))
      expect(mock.database).toHaveBeenCalledWith(
        type.split('.')[0],
        expect.any(Object),
        type.split('.')[1],
        'leads',
        input,
      );
  },
);
it('sends Discord text without automatic mentions and rejects foreign webhook hosts', async () => {
  const node = createNode('discord.send', 'send');
  node.config.connectionId = 'connection';
  await apps.execute(node, { text: '@everyone Demo' });
  const [, init] = mock.fetch.mock.calls[0]!;
  expect(JSON.parse(init.body).allowed_mentions).toEqual({ parse: [] });
  connection.get.mockResolvedValueOnce({
    credentials: { webhook: 'https://example.com/api/webhooks/123/test' },
  });
  await expect(apps.execute(node, { text: 'Demo' })).rejects.toThrow('valid Discord');
});
it('rejects invalid calendar times and unbounded Excel writes', async () => {
  const calendar = createNode('calendar.create', 'event');
  calendar.config.calendarId = 'primary';
  await expect(apps.execute(calendar, { title: 'Demo', start: 'bad', end: 'bad' })).rejects.toThrow(
    'valid event',
  );
  const excel = createNode('excel.append', 'row');
  await expect(apps.execute(excel, { rows: Array(1001).fill(['x']) })).rejects.toThrow('1,000');
});
it('uses the Notion data source contract for structured records', async () => {
  const node = createNode('notion.record.create', 'record');
  node.config = { connectionId: 'connection', dataSourceId: 'source' };
  await apps.execute(node, { properties: { Name: { title: [] } } });
  const [url, init] = mock.fetch.mock.calls[0]!;
  expect(url).toBe('https://api.notion.com/v1/pages');
  expect(init.headers['Notion-Version']).toBe('2025-09-03');
  expect(JSON.parse(init.body).parent).toEqual({
    type: 'data_source_id',
    data_source_id: 'source',
  });
});
