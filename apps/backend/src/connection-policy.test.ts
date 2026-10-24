import { expect, it, vi } from 'vitest';
import { createNode } from '@forge/connectors';
import type { WorkflowDefinition } from '@forge/contracts';
import { activeApps, assertAppEnabled, usesConnection } from './connection-policy.js';
import { Connections } from './connections.js';
import { decrypt, encrypt } from './security.js';
const chain = (...nodes: ReturnType<typeof createNode>[]): WorkflowDefinition => ({
  schemaVersion: 1,
  settings: { timezone: 'UTC', maxItems: 1000 },
  nodes,
  edges: nodes.slice(1).map((n, i) => ({
    id: `e${i}`,
    source: nodes[i]!.id,
    target: n.id,
    sourcePort: 'out',
    targetPort: 'in',
  })),
});
it('disables one app while keeping the other authorized apps usable', () => {
  const credentials = { apps: 'gmail,calendar,sheets,drive', disabledApps: 'gmail' };
  expect(activeApps('google', credentials)).toEqual(['calendar', 'sheets', 'drive']);
  expect(() => assertAppEnabled('google', credentials, 'gmail')).toThrow('disconnected');
  expect(() => assertAppEnabled('google', credentials, 'calendar')).not.toThrow();
  expect(() => assertAppEnabled('microsoft', { apps: 'excel' }, 'outlook')).toThrow('disconnected');
});
it('finds typed nested references without matching arbitrary note text', () => {
  const mail = createNode('gmail.search', 'mail');
  mail.config.connectionId = 'account';
  const loop = createNode('logic.foreach', 'loop');
  loop.config.body = chain(createNode('trigger.manual', 'start'), mail) as any;
  const graph = chain(createNode('trigger.manual', 'start'), loop);
  expect(usesConnection(graph, 'account', 'gmail')).toBe(true);
  expect(usesConnection(graph, 'account', 'calendar')).toBe(false);
  expect(usesConnection(graph, 'other', 'gmail')).toBe(false);
  const text = createNode('data.text', 'text');
  text.inputs.text = { kind: 'constant', value: 'account' };
  expect(usesConnection(chain(text), 'account')).toBe(false);
});
it('finds inherited AI connections inside list bodies', () => {
  const loop = createNode('logic.foreach', 'loop');
  loop.config.body = chain(
    createNode('trigger.manual', 'start'),
    createNode('ai.generate', 'ai'),
  ) as any;
  const graph = chain(createNode('trigger.manual', 'start'), loop);
  graph.settings.ai = { provider: 'gemini', connectionId: 'ai-account', dataPolicy: 'public-demo' };
  expect(usesConnection(graph, 'ai-account')).toBe(true);
  expect(usesConnection(graph, 'ai-account', 'gmail')).toBe(false);
});
it('blocks disabled Google operations and selectors before provider access', async () => {
  const record = {
    id: 'account',
    kind: 'google',
    secret: encrypt({ apps: 'gmail,calendar', disabledApps: 'gmail' }),
  };
  const connections = new Connections({
    connection: { findUniqueOrThrow: async () => record },
  } as any);
  const oauth = vi.spyOn(connections, 'oauth');
  await expect(connections.google('account', 'gmail')).rejects.toThrow('disconnected');
  await expect(connections.resources('account', 'labels')).rejects.toThrow('disconnected');
  expect(oauth).not.toHaveBeenCalled();
});
it('never restores stale app permissions when a token refresh races disconnection', async () => {
  let secret = encrypt({ apps: 'gmail,calendar', tokens: JSON.stringify({ access_token: 'old' }) });
  const db = {
    connection: {
      findUniqueOrThrow: async () => ({ id: 'account', kind: 'google', secret }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.secret !== secret) return { count: 0 };
        secret = data.secret;
        return { count: 1 };
      }),
    },
  };
  const connections = new Connections(db as any);
  vi.spyOn(connections, 'oauth').mockImplementation(
    () =>
      ({
        credentials: { access_token: 'refreshed' },
        setCredentials: () => {},
        getAccessToken: async () => {
          secret = encrypt({
            apps: 'gmail,calendar',
            disabledApps: 'gmail',
            tokens: JSON.stringify({ access_token: 'old' }),
          });
        },
      }) as any,
  );
  await expect(connections.google('account', 'gmail')).rejects.toThrow('connection changed');
  expect(decrypt(secret).disabledApps).toBe('gmail');
});
it('does not let an outstanding OAuth callback restore a disconnected app', async () => {
  const { accessScope } = await import('./scope.js');
  let secret = encrypt({
    clientId: 'synthetic',
    clientSecret: 'synthetic',
    apps: 'gmail,calendar',
  });
  const db = {
    withWorkspace: (_id: string, fn: () => unknown) => fn(),
    accountToken: {
      findFirst: async () => ({
        id: 'state',
        workspaceId: 'space',
        userId: 'user',
        connectionId: 'account',
      }),
      updateMany: async () => ({ count: 1 }),
    },
    connection: {
      findUniqueOrThrow: async () => ({ id: 'account', kind: 'google', secret }),
      updateMany: async ({ where }: any) => ({ count: where.secret === secret ? 1 : 0 }),
    },
  };
  const connections = new Connections(db as any);
  vi.spyOn(connections, 'oauth').mockImplementation(
    () =>
      ({
        getToken: async () => {
          secret = encrypt({
            clientId: 'synthetic',
            clientSecret: 'synthetic',
            apps: 'gmail,calendar',
            disabledApps: 'gmail',
          });
          return { tokens: { access_token: 'synthetic' } };
        },
      }) as any,
  );
  await expect(
    accessScope.run({ workspaceId: 'space', userId: 'user' }, () =>
      connections.callback('synthetic-code', 'state'),
    ),
  ).rejects.toThrow('connection changed');
  expect(decrypt(secret).disabledApps).toBe('gmail');
});
