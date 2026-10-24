import { afterEach, expect, it, vi } from 'vitest';
import { Connections } from './connections.js';
import { accessScope } from './scope.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  [{}, 'common'],
  [{ apps: 'outlook' }, 'common'],
  [{ apps: 'excel' }, 'organizations'],
  [{ apps: 'outlook, excel' }, 'organizations'],
  [{ apps: 'outlook', tenant: 'consumers' }, 'consumers'],
  [
    { apps: 'outlook', tenant: '00000000-0000-0000-0000-000000000001' },
    '00000000-0000-0000-0000-000000000001',
  ],
])(
  'uses a compatible Microsoft authority for authorization and token exchange: %j',
  async (settings, authority) => {
    const credentials = { clientId: 'fixture-client', clientSecret: 'fixture-secret', ...settings };
    const connections = new Connections({ accountToken: { create: vi.fn() } } as any);
    vi.spyOn(connections, 'get').mockResolvedValue({ credentials } as any);
    const { url } = await accessScope.run({ userId: 'user', workspaceId: 'workspace' }, () =>
      connections.microsoftAuthorize('connection'),
    );
    const authorization = new URL(url);
    expect(authorization.origin).toBe('https://login.microsoftonline.com');
    expect(authorization.pathname).toBe(`/${authority}/oauth2/v2.0/authorize`);
    expect(authorization.searchParams.has('client_secret')).toBe(false);

    const request = vi.fn().mockResolvedValue(new Response('{"access_token":"fixture"}'));
    vi.stubGlobal('fetch', request);
    await connections.microsoftToken(credentials, {
      grant_type: 'authorization_code',
      code: 'fixture',
    });
    expect(request.mock.calls[0]![0]).toBe(
      `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`,
    );
  },
);

it('rejects invalid Microsoft authorities before sending credentials', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  const connections = new Connections({} as any);
  await expect(connections.microsoftToken({ tenant: '../unexpected' }, {})).rejects.toThrow(
    'valid Microsoft tenant',
  );
  expect(request).not.toHaveBeenCalled();
});
