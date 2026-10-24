import { afterEach, expect, it, vi } from 'vitest';
import { OperationError } from '@forge/contracts';
import { providerFetch, sheetId } from './connections.js';
afterEach(() => vi.unstubAllGlobals());
it('treats rate limits as transient and respects Retry-After', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '12' } })),
  );
  await expect(providerFetch('https://example.com/api')).rejects.toMatchObject({
    transient: true,
    outcomeUnknown: false,
    retryAfterMs: 12000,
  });
});
it('does not expose provider response bodies or tokens in errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('secret=must-not-appear', { status: 401 })),
  );
  await expect(providerFetch('https://example.com/api')).rejects.toThrow('HTTP 401');
  try {
    await providerFetch('https://example.com/api');
  } catch (error) {
    expect((error as Error).message).not.toContain('must-not-appear');
  }
});
it('classifies a lost write confirmation as unknown', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET with private token')));
  await expect(providerFetch('https://example.com/api', { method: 'POST' })).rejects.toMatchObject({
    transient: true,
    outcomeUnknown: true,
  });
});
it('keeps failed reads eligible for safe retries', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));
  await expect(providerFetch('https://example.com/api')).rejects.toMatchObject({
    outcomeUnknown: false,
  });
});
it('accepts a spreadsheet URL or a plain ID', () => {
  expect(sheetId('https://docs.google.com/spreadsheets/d/example_123/edit#gid=0')).toBe(
    'example_123',
  );
  expect(sheetId('example_123')).toBe('example_123');
});
it('marks a lost successful write response body as outcome unknown', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw new Error('terminated');
      },
    }),
  );
  const error = await providerFetch('https://example.invalid/write', { method: 'POST' }).catch(
    (e) => e,
  );
  expect(error).toMatchObject({ outcomeUnknown: true, transient: true });
  vi.unstubAllGlobals();
});

it('accepts Microsoft sendMail empty 202 success without Content-Length', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  await expect(
    providerFetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST' }),
  ).resolves.toEqual({});
});
it('tests Sheets authorization without requiring any Drive scopes', async () => {
  const { Connections } = await import('./connections.js');
  const { encrypt } = await import('./security.js');
  const { google } = await import('googleapis');
  const db = {
    connection: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({
          id: 'sheets',
          kind: 'google',
          status: 'untested',
          secret: encrypt({ apps: 'sheets' }),
        }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const connections = new Connections(db as any);
  const drive = vi.spyOn(google, 'drive').mockImplementation(() => {
    throw new Error('Drive must not be called for Sheets-only authorization.');
  });
  vi.spyOn(connections, 'google').mockResolvedValue({
    getAccessToken: async () => ({ token: 'fixture' }),
    getTokenInfo: async () => ({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] }),
  } as any);
  try {
    expect(await connections.test('sheets')).toMatchObject({ ok: true });
    expect(drive).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
