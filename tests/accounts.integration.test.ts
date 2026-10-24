import { createRequire } from 'node:module';
const backendRequire = createRequire(new URL('../apps/backend/package.json', import.meta.url));
backendRequire('reflect-metadata');
import { beforeAll, afterAll, expect, it } from 'vitest';
import { config as dotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { templates, createNode } from '@forge/connectors';
import { constant } from '@forge/contracts';
dotenv({ path: '.env', quiet: true });
const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!process.env.TEST_DATABASE_URL) url.pathname = '/forge_test';
if (!url.pathname.endsWith('_test')) throw new Error('Account tests require a _test database.');
process.env.DATABASE_URL = url.toString();
let app: any, db: any, engine: any, workspaces: any, runtime: any, scope: any, configuration: any;
let storageRoot: string;
let base = '',
  admin: any,
  alice: any,
  bob: any,
  a: any,
  a2: any,
  b: any;
const ids: string[] = [];
const passwords = 'a private fixture password';
const prefix = `suite_${randomUUID().slice(0, 8)}`;
const headers = {
  Origin: 'http://localhost:4300',
  'X-Forge-Request': '1',
  'Content-Type': 'application/json',
};
async function request(cookie: string, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method,
    headers: { ...headers, Cookie: cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  return {
    status: response.status,
    data,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie,
  };
}
const path = (workspace: any, suffix: string) => `workspaces/${workspace.id}/${suffix}`;
async function invite(name: string) {
  const accepted = await request('', 'auth/register', 'POST', {
    username: name,
    password: passwords,
    timezone: 'UTC',
  });
  expect(accepted.status).toBe(201);
  const account = await request(accepted.cookie, 'auth/me');
  ids.push(account.data.id);
  return { ...account.data, cookie: accepted.cookie, token: 'retired-token' };
}
beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'forge-accounts-files-'));
  process.env.WORKSPACE_STORAGE_ROOT = storageRoot;
  const { NestFactory } = backendRequire('@nestjs/core');
  const cookieParser = backendRequire('cookie-parser');
  const { json } = backendRequire('express');
  const { AppModule } = await import('../apps/backend/dist/app.module.js');
  const { Database } = await import('../apps/backend/dist/database.js');
  const { ExecutionEngine } = await import('../apps/backend/dist/engine.js');
  const { Workspaces } = await import('../apps/backend/dist/workspaces.js');
  const { Runtime } = await import('../apps/backend/dist/runtime.js');
  const { passwordHash } = await import('../apps/backend/dist/security.js');
  const { accessScope } = await import('../apps/backend/dist/scope.js');
  scope = accessScope;
  const { Errors } = await import('../apps/backend/dist/controllers.js');
  const { config } = await import('../apps/backend/dist/config.js');
  configuration = config;
  app = await NestFactory.create(AppModule, { logger: false, bodyParser: false });
  app.use((req: any, res: any, next: () => void) => scope.run({}, next));
  app.use(json({ limit: '70mb' }));
  app.use(cookieParser());
  app.useGlobalFilters(new Errors());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  db = app.get(Database);
  engine = app.get(ExecutionEngine);
  workspaces = app.get(Workspaces);
  runtime = app.get(Runtime);
  const user = await db.user.create({
    data: {
      username: `${prefix}_admin`,
      displayName: 'Fixture administrator',
      passwordHash: passwordHash(passwords),
      isAdmin: true,
    },
  });
  ids.push(user.id);
  await db.installation.upsert({
    where: { id: 'owner' },
    create: {
      id: 'owner',
      settings: { timezone: 'UTC', model: 'qwen3:4b', retentionDays: 30, retainAIDetails: false },
    },
    update: {},
  });
  const result = await request('', 'auth/login', 'POST', {
    username: user.username,
    password: passwords,
  });
  expect(result.status).toBe(201);
  admin = { ...user, cookie: result.cookie };
});
afterAll(async () => {
  if (db) {
    const spaces = await db.workspace.findMany({ where: { ownerId: { in: ids } } });
    for (const space of spaces) {
      await db.workspace.delete({ where: { id: space.id } });
      await rm(join(configuration.workspaceStorage, space.storageKey), {
        recursive: true,
        force: true,
      });
    }
    await db.accountToken.deleteMany({
      where: { OR: [{ createdById: { in: ids } }, { username: { startsWith: prefix } }] },
    });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await app?.close();
  await rm(storageRoot, { recursive: true, force: true });
});
it('registers two users and gives each multiple private workspaces', async () => {
  alice = await invite(`${prefix}_alice`);
  bob = await invite(`${prefix}_bob`);
  expect(
    (
      await request('', 'auth/invitation', 'POST', {
        token: alice.token,
        password: passwords,
        displayName: 'Replay',
      })
    ).status,
  ).toBe(410);
  a = (await request(alice.cookie, 'workspaces')).data[0];
  b = (await request(bob.cookie, 'workspaces')).data[0];
  expect(a.name).toBe('Personal');
  expect(b.name).toBe('Personal');
  a2 = (await request(alice.cookie, 'workspaces', 'POST', { name: 'Alice second' })).data;
  await request(bob.cookie, 'workspaces', 'POST', { name: 'Bob second' });
  expect((await request(alice.cookie, 'workspaces')).data).toHaveLength(2);
  expect((await request(bob.cookie, 'workspaces')).data).toHaveLength(2);
  expect((await request(alice.cookie, 'admin/users')).status).toBe(403);
});
it('denies other accounts and administrators workspace content', async () => {
  for (const cookie of [bob.cookie, admin.cookie]) {
    for (const resource of [
      'workflows',
      'notes',
      'connections',
      'runs',
      'files',
      'settings',
      'backup',
    ])
      expect(
        (
          await request(
            cookie,
            path(a, resource),
            resource === 'backup' ? 'POST' : 'GET',
            resource === 'backup' ? { passphrase: passwords } : undefined,
          )
        ).status,
      ).toBe(404);
  }
});
it('isolates known resource IDs even between one owner’s workspaces', async () => {
  const note = (
    await request(alice.cookie, path(a, 'notes'), 'POST', {
      title: 'Private note',
      text: 'Only workspace A',
    })
  ).data;
  expect(
    (
      await request(alice.cookie, path(a2, `notes/${note.id}`), 'PATCH', {
        title: 'No',
        text: 'No',
      })
    ).status,
  ).toBe(404);
  expect((await request(alice.cookie, path(a2, 'notes'))).data).toHaveLength(0);
  const workflow = (
    await request(alice.cookie, path(a, 'workflows'), 'POST', {
      name: 'Private flow',
      definition: templates[0]!.definition,
    })
  ).data;
  expect((await request(alice.cookie, path(a2, `workflows/${workflow.id}`))).status).toBe(404);
  expect(
    (await request(bob.cookie, path(b, `workflows/${workflow.id}/enable`), 'POST', { revision: 0 }))
      .status,
  ).toBe(404);
  expect((await request(admin.cookie, path(a, `workflows/${workflow.id}/export`))).status).toBe(
    404,
  );
});
it('requires a workspace at the database boundary and enforces composite foreign keys', async () => {
  await expect(db.note.findMany()).rejects.toThrow('workspace');
  const workflow = await db.withWorkspace(a.id, () =>
    db.workflow.create({ data: { name: 'Constraint fixture', draft: templates[0]!.definition } }),
  );
  await expect(
    db.system.run.create({ data: { workspaceId: b.id, workflowId: workflow.id, input: {} } }),
  ).rejects.toThrow('Foreign key');
});
it('rejects foreign connections in validation and nested list bodies', async () => {
  const foreign = (
    await request(bob.cookie, path(b, 'connections'), 'POST', {
      name: 'Bob bearer',
      kind: 'http',
      secret: { token: 'a-synthetic-token' },
    })
  ).data;
  const graph = structuredClone(templates.find((t) => t.id === 'csv-classify')!.definition);
  const loop = graph.nodes.find((n) => n.type === 'logic.foreach')!;
  const body: any = loop.config.body;
  const action = createNode('http.request', 'foreign-http');
  action.config = { ...action.config, connectionId: foreign.id };
  action.inputs = { url: constant('https://example.com') };
  body.nodes.push(action);
  body.edges.push({
    id: 'foreign-edge',
    source: body.nodes.at(-2).id,
    target: action.id,
    sourcePort: 'out',
    targetPort: 'in',
  });
  const workflow = (
    await request(alice.cookie, path(a, 'workflows'), 'POST', {
      name: 'Validation fixture',
      definition: graph,
    })
  ).data;
  const result = await request(alice.cookie, path(a, `workflows/${workflow.id}/validate`), 'POST');
  expect(result.data.issues.some((issue: any) => issue.field === 'connectionId')).toBe(true);
});
it('worker jobs reconstruct ownership and refuse forged workspace payloads', async () => {
  const workflow = await db.withWorkspace(a.id, () =>
    db.workflow.create({
      data: {
        name: 'Queue fixture',
        draft: {
          ...templates[0]!.definition,
          nodes: [createNode('trigger.manual', 'start')],
          edges: [],
        },
      },
    }),
  );
  const run = await db.withWorkspace(a.id, () =>
    engine.createRun(workflow.id, { text: 'Fixture' }),
  );
  await expect(runtime.handleJob('advance', { runId: run.id, workspaceId: b.id })).rejects.toThrow(
    'does not match',
  );
  expect(await db.system.nodeExecution.findMany({ where: { runId: run.id } })).toHaveLength(0);
  await runtime.handleJob('advance', { runId: run.id, workspaceId: a.id });
  const task = await db.system.nodeExecution.findFirstOrThrow({ where: { runId: run.id } });
  expect(task.workspaceId).toBe(a.id);
});
it('uses separate managed folders and rejects traversal', async () => {
  const { WorkspaceFiles } = await import('../apps/backend/dist/storage.js');
  const files = new WorkspaceFiles(db);
  await db.withWorkspace(a.id, () => files.write('same.txt', 'Alice file', true));
  await db.withWorkspace(b.id, () => files.write('same.txt', 'Bob file', true));
  expect((await request(alice.cookie, path(a, 'files/read?path=same.txt'))).data.text).toBe(
    'Alice file',
  );
  expect((await request(bob.cookie, path(b, 'files/read?path=same.txt'))).data.text).toBe(
    'Bob file',
  );
  expect((await request(alice.cookie, path(a, 'files/read?path=../same.txt'))).status).toBe(400);
});
it('trash stops automation and restore keeps workflows disabled', async () => {
  const result = await request(alice.cookie, path(a2, 'workflows'), 'POST', {
    name: 'Trash fixture',
    definition: {
      ...templates[0]!.definition,
      nodes: [createNode('trigger.manual', 'start')],
      edges: [],
    },
  });
  expect(
    (
      await request(alice.cookie, path(a2, `workflows/${result.data.id}/enable`), 'POST', {
        revision: 0,
      })
    ).data.ok,
  ).toBe(true);
  expect((await request(alice.cookie, `workspaces/${a2.id}`, 'DELETE')).status).toBe(200);
  expect((await request(alice.cookie, path(a2, 'workflows'))).status).toBe(404);
  expect((await request(alice.cookie, `workspaces/${a2.id}/restore`, 'POST')).status).toBe(201);
  expect((await request(alice.cookie, path(a2, 'workflows'))).data[0].enabled).toBe(false);
});
it('rejects duplicate usernames and retired invitation registration', async () => {
  expect(
    (
      await request('', 'auth/register', 'POST', {
        username: alice.username.toUpperCase(),
        password: passwords,
      })
    ).status,
  ).toBe(409);
  expect((await request('', 'auth/invitation', 'POST', { token: 'legacy' })).status).toBe(410);
  expect(
    (await request(admin.cookie, 'admin/invitations', 'POST', { username: 'no_more_invites' }))
      .status,
  ).toBe(404);
});
it('recovery is single-use and revokes existing sessions', async () => {
  const recovery = (await request(admin.cookie, `admin/users/${bob.id}/recovery`, 'POST')).data;
  const token = new URL(recovery.url).hash.split('=')[1];
  const record = await db.accountToken.findFirstOrThrow({
    where: { purpose: 'reset', userId: bob.id },
  });
  expect(record.id).not.toBe(token);
  expect((await request('', 'auth/recover', 'POST', { token, password: passwords })).status).toBe(
    201,
  );
  expect((await request(bob.cookie, 'auth/me')).status).toBe(401);
  expect((await request('', 'auth/recover', 'POST', { token, password: passwords })).status).toBe(
    410,
  );
  bob.cookie = (
    await request('', 'auth/login', 'POST', { username: bob.username, password: passwords })
  ).cookie;
});
it('protects the last administrator and revokes suspended accounts', async () => {
  expect(
    (await request(admin.cookie, `admin/users/${admin.id}`, 'PATCH', { status: 'suspended' }))
      .status,
  ).toBe(409);
  expect(
    (await request(admin.cookie, `admin/users/${bob.id}`, 'PATCH', { status: 'suspended' })).status,
  ).toBe(200);
  expect((await request(bob.cookie, 'auth/me')).status).toBe(401);
  expect(
    (await request(admin.cookie, `admin/users/${bob.id}`, 'PATCH', { status: 'active' })).status,
  ).toBe(200);
  bob.cookie = (
    await request('', 'auth/login', 'POST', { username: bob.username, password: passwords })
  ).cookie;
});
it('serializes password recovery with an in-flight old-password login', async () => {
  const user = await invite(`${prefix}_race`);
  const recovery = (await request(admin.cookie, `admin/users/${user.id}/recovery`, 'POST')).data;
  const token = new URL(recovery.url).hash.split('=')[1];
  let release!: () => void, locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = db.$transaction(
    async (tx: any) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      locked();
      await barrier;
    },
    { timeout: 15000 },
  );
  await ready;
  const waitForLocks = async (count: number) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] =
        await db.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%User%'`;
      if (row.count >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Concurrent authentication requests did not reach the row lock.');
  };
  let resetting: Promise<any> | undefined, loggingIn: Promise<any> | undefined;
  try {
    resetting = request('', 'auth/recover', 'POST', {
      token,
      password: 'a changed fixture password',
    });
    await waitForLocks(1);
    loggingIn = request('', 'auth/login', 'POST', { username: user.username, password: passwords });
    await waitForLocks(2);
  } finally {
    release();
    await blocker;
  }
  expect((await resetting).status).toBe(201);
  expect((await loggingIn).status).toBe(401);
  expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  expect(
    (
      await request('', 'auth/login', 'POST', {
        username: user.username,
        password: 'a changed fixture password',
      })
    ).status,
  ).toBe(201);
});
it('changes a password atomically, replacing sessions and rejecting the old password', async () => {
  const user = await invite(`${prefix}_password`);
  const changed = await request(user.cookie, 'account/password', 'POST', {
    currentPassword: passwords,
    password: 'another changed fixture password',
  });
  expect(changed.status).toBe(201);
  expect((await request(user.cookie, 'auth/me')).status).toBe(401);
  expect((await request(changed.cookie, 'auth/me')).status).toBe(200);
  expect(
    (await request('', 'auth/login', 'POST', { username: user.username, password: passwords }))
      .status,
  ).toBe(401);
});
it('workspace backup excludes account state and restores with fresh identities', async () => {
  const source = await request(alice.cookie, path(a, 'backup'), 'POST', { passphrase: passwords });
  expect(source.status).toBe(201);
  const { openBackup } = await import('../apps/backend/dist/backups.js');
  const payload = openBackup(source.data, passwords);
  expect(payload.tables.user).toBeUndefined();
  expect(payload.tables.session).toBeUndefined();
  expect(payload.tables.installation).toBeUndefined();
  const restored = await request(alice.cookie, 'workspaces/restore', 'POST', {
    passphrase: passwords,
    backup: source.data,
  });
  expect(restored.status).toBe(201);
  expect(restored.data.workspaceId).not.toBe(a.id);
  expect((await request(bob.cookie, `workspaces/${restored.data.workspaceId}/notes`)).status).toBe(
    404,
  );
});
it('permanent deletion requires a password and removes only managed data', async () => {
  const temporary = (await request(alice.cookie, 'workspaces', 'POST', { name: 'Purge fixture' }))
    .data;
  await request(alice.cookie, `workspaces/${temporary.id}`, 'DELETE');
  expect(
    (await request(alice.cookie, `workspaces/${temporary.id}/purge`, 'POST', { password: 'wrong' }))
      .status,
  ).toBe(401);
  expect(
    (
      await request(alice.cookie, `workspaces/${temporary.id}/purge`, 'POST', {
        password: passwords,
      })
    ).status,
  ).toBe(201);
  expect(await db.workspace.findUnique({ where: { id: temporary.id } })).toBeNull();
});
it('purges expired trash and preserves active workspaces', async () => {
  const temporary = await workspaces.create(alice.id, 'Expired fixture');
  await db.workspace.update({
    where: { id: temporary.id },
    data: { deletedAt: new Date(Date.now() - 31 * 86400_000) },
  });
  await workspaces.maintenance();
  expect(await db.workspace.findUnique({ where: { id: temporary.id } })).toBeNull();
  expect(await db.workspace.findUnique({ where: { id: a.id } })).toBeTruthy();
});

it('reconstructs missing dispatches independently for two workspaces', async () => {
  const { ExecutionEngine } = await import('../apps/backend/dist/engine.js');
  const recovered = new ExecutionEngine(db, {} as any);
  for (const workspace of [a, a2]) {
    await db.withWorkspace(workspace.id, async () => {
      const workflow = await db.workflow.create({
        data: {
          name: 'Recovery in each workspace',
          draft: {
            ...templates[0]!.definition,
            nodes: [createNode('trigger.manual', 'start')],
            edges: [],
          },
        },
      });
      const run = await engine.createRun(workflow.id, {});
      await db.outbox.deleteMany({ where: { payload: { path: ['runId'], equals: run.id } } });
      await recovered.recover();
      expect(
        await db.outbox.count({
          where: { kind: 'advance', payload: { path: ['runId'], equals: run.id } },
        }),
      ).toBeGreaterThan(0);
    });
  }
});
it('account trash revokes access and reactivation leaves workspace restoration explicit', async () => {
  const temporary = await invite(`${prefix}_temporary`);
  const workspace = (await request(temporary.cookie, 'workspaces')).data[0];
  expect(
    (await request(temporary.cookie, 'account', 'DELETE', { password: passwords })).status,
  ).toBe(200);
  expect((await request(temporary.cookie, 'auth/me')).status).toBe(401);
  expect(
    (await request(admin.cookie, `admin/users/${temporary.id}`, 'PATCH', { status: 'active' }))
      .status,
  ).toBe(200);
  const fresh = await request('', 'auth/login', 'POST', {
    username: temporary.username,
    password: passwords,
  });
  expect((await request(fresh.cookie, 'workspaces')).data).toHaveLength(0);
  expect(
    (await request(fresh.cookie, 'workspaces?trash=true')).data.map((w: any) => w.id),
  ).toContain(workspace.id);
  expect((await request(fresh.cookie, `workspaces/${workspace.id}/restore`, 'POST')).status).toBe(
    201,
  );
});
it('closes a live run stream when its session is revoked', async () => {
  const workflow = await db.withWorkspace(a.id, () =>
    db.workflow.create({
      data: {
        name: 'Stream fixture',
        draft: {
          ...templates[0]!.definition,
          nodes: [createNode('trigger.manual', 'start')],
          edges: [],
        },
      },
    }),
  );
  const run = await db.withWorkspace(a.id, () => engine.createRun(workflow.id, {}));
  expect((await request(bob.cookie, path(b, `runs/${run.id}/events`))).status).toBe(404);
  const stream = await fetch(`${base}/api/v1/${path(a, `runs/${run.id}/events`)}`, {
    headers: { ...headers, Cookie: alice.cookie },
    signal: AbortSignal.timeout(5000),
  });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  await reader.read();
  await request(alice.cookie, 'auth/logout', 'POST');
  while (!(await reader.read()).done) {
    /* drains heartbeats until revocation is observed */
  }
});

it('shares only the selected workspace and enforces owner/editor/viewer permissions', async () => {
  alice.cookie = (
    await request('', 'auth/login', 'POST', { username: alice.username, password: passwords })
  ).cookie;
  expect(
    (
      await request(alice.cookie, `workspaces/${a.id}/members`, 'POST', {
        username: bob.username,
        role: 'viewer',
      })
    ).status,
  ).toBe(201);
  expect((await request(bob.cookie, 'workspaces')).data.find((w: any) => w.id === a.id).role).toBe(
    'viewer',
  );
  expect((await request(bob.cookie, path(a, 'notes'))).status).toBe(200);
  expect((await request(bob.cookie, path(a2, 'notes'))).status).toBe(404);
  expect(
    (await request(bob.cookie, path(a, 'notes'), 'POST', { title: 'Forbidden', text: 'test' }))
      .status,
  ).toBe(403);
  expect(
    (
      await request(bob.cookie, path(a, 'ai/generate'), 'POST', {
        description: 'Summarize my input',
      })
    ).status,
  ).toBe(403);
  expect(
    (await request(bob.cookie, path(a, 'backup'), 'POST', { passphrase: passwords })).status,
  ).toBe(403);
  expect((await request(bob.cookie, `workspaces/${a.id}`, 'DELETE')).status).toBe(404);
  expect((await request(bob.cookie, `workspaces/${a.id}/members`)).status).toBe(403);
  await request(alice.cookie, `workspaces/${a.id}/members/${bob.id}`, 'PATCH', { role: 'editor' });
  expect(
    (
      await request(bob.cookie, path(a, 'notes'), 'POST', {
        title: 'Shared editor note',
        text: 'Allowed',
      })
    ).status,
  ).toBe(201);
  const connection = await request(bob.cookie, path(a, 'connections'), 'POST', {
    name: 'Shared credential fixture',
    kind: 'http',
    secret: { token: 'never-return-this-secret' },
  });
  expect(connection.status).toBe(201);
  expect(JSON.stringify((await request(bob.cookie, path(a, 'connections'))).data)).not.toContain(
    'never-return-this-secret',
  );
  expect(
    (await request(bob.cookie, path(a, 'backup'), 'POST', { passphrase: passwords })).status,
  ).toBe(403);
  expect(
    (
      await request(bob.cookie, path(a, 'settings'), 'PATCH', {
        timezone: 'UTC',
        model: 'anything',
        retentionDays: 30,
        retainAIDetails: false,
      })
    ).status,
  ).toBe(403);
  const exported = await request(alice.cookie, path(a, 'backup'), 'POST', {
    passphrase: passwords,
  });
  const restored = await request(alice.cookie, 'workspaces/restore', 'POST', {
    passphrase: passwords,
    backup: exported.data,
  });
  expect(
    await db.workspaceMember.count({ where: { workspaceId: restored.data.workspaceId } }),
  ).toBe(0);
  await request(alice.cookie, `workspaces/${a.id}/members/${bob.id}`, 'DELETE');
  expect((await request(bob.cookie, path(a, 'notes'))).status).toBe(404);
});
it('revalidates memberships during database writes and live streams', async () => {
  await request(alice.cookie, `workspaces/${a.id}/members`, 'POST', {
    username: bob.username,
    role: 'viewer',
  });
  await expect(
    db.withWorkspace(a.id, () => db.note.create({ data: { title: 'Bypass', text: 'No' } }), {
      userId: bob.id,
    }),
  ).rejects.toThrow('editor');
  const workflow = await db.withWorkspace(a.id, () => db.workflow.findFirstOrThrow());
  const run = await db.withWorkspace(a.id, () => engine.createRun(workflow.id, {}, true));
  const response = await fetch(`${base}/api/v1/${path(a, `runs/${run.id}/events`)}`, {
    headers: { ...headers, Cookie: bob.cookie },
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  await reader.read();
  await request(alice.cookie, `workspaces/${a.id}/members/${bob.id}`, 'DELETE');
  const closed = await Promise.race([
    (async () => {
      while (!(await reader.read()).done) {}
      return true;
    })(),
    new Promise((resolve) => setTimeout(() => resolve(false), 4000)),
  ]);
  expect(closed).toBe(true);
});
it('validates private cloud AI and foreign AI connection references before execution', async () => {
  const { encrypt } = await import('../apps/backend/dist/security.js');
  const connection = await db.withWorkspace(a.id, () =>
    db.connection.create({
      data: {
        name: 'Synthetic Gemini',
        kind: 'gemini',
        secret: encrypt({ apiKey: 'synthetic-key' }),
        status: 'connected',
      },
    }),
  );
  const graph = structuredClone(templates[0]!.definition);
  graph.settings.ai = {
    provider: 'gemini',
    connectionId: connection.id,
    model: 'gemini-2.5-flash',
    dataPolicy: 'private',
  } as any;
  expect(
    (await db.withWorkspace(a.id, () => engine.validate(graph))).some((i: any) =>
      i.message.includes('public/demo'),
    ),
  ).toBe(true);
  graph.settings.ai.dataPolicy = 'public-demo';
  expect(await db.withWorkspace(a.id, () => engine.validate(graph))).toEqual([]);
  expect(
    (await db.withWorkspace(b.id, () => engine.validate(graph))).some((i: any) => i.message),
  ).toBe(true);
});
it('never exports installation OAuth secrets through a self-registered workspace', async () => {
  const { encrypt, decrypt } = await import('../apps/backend/dist/security.js');
  const { openBackup } = await import('../apps/backend/dist/backups.js');
  const user = await invite(`${prefix}_oauth`),
    space = (await request(user.cookie, 'workspaces')).data[0];
  const existing = await db.appCredential.findUnique({ where: { provider: 'google' } });
  try {
    await db.appCredential.upsert({
      where: { provider: 'google' },
      create: {
        provider: 'google',
        secret: encrypt({
          clientId: 'installation-client',
          clientSecret: 'installation-secret-never-export',
        }),
      },
      update: {
        secret: encrypt({
          clientId: 'installation-client',
          clientSecret: 'installation-secret-never-export',
        }),
      },
    });
    const connection = await request(user.cookie, path(space, 'connections'), 'POST', {
      name: 'My Google',
      kind: 'google',
      secret: { apps: 'drive' },
    });
    expect(connection.status).toBe(201);
    const stored = await db.system.connection.findUniqueOrThrow({
      where: { id: connection.data.id },
    });
    expect(decrypt(stored.secret)).toEqual({ apps: 'drive', oauthSource: 'installation' });
    const archive = await request(user.cookie, path(space, 'backup'), 'POST', {
      passphrase: passwords,
    });
    expect(archive.status).toBe(201);
    const payload = openBackup(archive.data, passwords);
    expect(JSON.stringify(payload)).not.toContain('installation-secret-never-export');
    expect(payload.tables.connection[0].credentials.oauthSource).toBe('installation');
  } finally {
    if (existing)
      await db.appCredential.update({
        where: { provider: 'google' },
        data: { secret: existing.secret },
      });
    else await db.appCredential.deleteMany({ where: { provider: 'google' } });
  }
});
it('shows app connection status only for authorized app selections', async () => {
  const { encrypt } = await import('../apps/backend/dist/security.js');
  await db.withWorkspace(a.id, () =>
    db.connection.create({
      data: {
        name: 'Drive only fixture',
        kind: 'google',
        status: 'connected',
        secret: encrypt({ apps: 'drive', clientId: 'fixture', clientSecret: 'fixture' }),
      },
    }),
  );
  const result = await request(alice.cookie, path(a, 'apps'));
  expect(result.status).toBe(200);
  expect(result.data.find((app: any) => app.id === 'drive').status).toBe('Connected');
  expect(result.data.find((app: any) => app.id === 'calendar').status).toBe('Not connected');
});
it('keeps schedule timezones independent across workflows', async () => {
  const schedules = [];
  for (const timezone of ['UTC', 'Asia/Kolkata']) {
    const trigger = createNode('trigger.schedule', 'start');
    trigger.config = { cron: '0 8 * * *', timezone };
    const definition = {
      schemaVersion: 1,
      settings: { timezone, maxItems: 1000 },
      nodes: [trigger],
      edges: [],
    };
    const created = await request(alice.cookie, path(a, 'workflows'), 'POST', {
      name: `Schedule ${timezone}`,
      definition,
    });
    expect(created.status).toBe(201);
    const fetched = await request(alice.cookie, path(a, `workflows/${created.data.id}`));
    expect(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        hour12: false,
      }).format(new Date(fetched.data.nextRun)),
    ).toBe('08');
    schedules.push(fetched.data.nextRun);
  }
  expect(schedules[0]).not.toBe(schedules[1]);
});

it('disconnects a single app across nested workflows and workers, preserves other apps, and reconnects without resuming automation', async () => {
  const { encrypt, decrypt } = await import('../apps/backend/dist/security.js');
  const { Connections } = await import('../apps/backend/dist/connections.js');
  const { vi } = await import('vitest');
  const user = await invite(`${prefix}_disconnect`);
  const space = (await request(user.cookie, 'workspaces')).data[0];
  const connection = await db.withWorkspace(space.id, () =>
    db.connection.create({
      data: {
        name: 'Synthetic Google',
        kind: 'google',
        status: 'connected',
        secret: encrypt({
          clientId: 'synthetic-client',
          clientSecret: 'synthetic-secret',
          apps: 'gmail,calendar,sheets,drive',
          tokens: JSON.stringify({ access_token: 'synthetic-token' }),
        }),
      },
    }),
  );
  const makeGraph = (type: string) => {
    const node = createNode(type, 'action');
    if (type === 'gmail.search') {
      node.config.connectionId = connection.id;
      node.inputs.query = constant('synthetic');
    }
    if (type === 'calendar.list') {
      node.config.connectionId = connection.id;
      node.config.calendarId = 'primary';
    }
    if (type === 'data.text') {
      node.config.operation = 'upper';
      node.inputs.text = constant(connection.id);
    }
    return {
      schemaVersion: 1,
      settings: { timezone: 'UTC', maxItems: 1000 },
      nodes: [createNode('trigger.manual', 'start'), node],
      edges: [{ id: 'e', source: 'start', target: 'action', sourcePort: 'out', targetPort: 'in' }],
    };
  };
  const gmail = makeGraph('gmail.search'),
    calendar = makeGraph('calendar.list');
  const nested = makeGraph('data.text');
  nested.nodes[1] = createNode('logic.foreach', 'action');
  nested.nodes[1].inputs.items = constant([{}]);
  nested.nodes[1].config.body = gmail as any;
  const workflows: any[] = [];
  for (const [name, definition] of [
    ['Gmail', gmail],
    ['Calendar', calendar],
    ['Nested Gmail', nested],
    ['Unrelated text', makeGraph('data.text')],
  ] as const) {
    const created = await request(user.cookie, path(space, 'workflows'), 'POST', {
      name,
      definition,
    });
    const enabled = await request(
      user.cookie,
      path(space, `workflows/${created.data.id}/enable`),
      'POST',
      { revision: 0 },
    );
    expect(enabled.data.ok).toBe(true);
    workflows.push(created.data);
  }
  const mailRun = await db.withWorkspace(space.id, () => engine.createRun(workflows[0].id, {}));
  const calendarRun = await db.withWorkspace(space.id, () => engine.createRun(workflows[1].id, {}));
  await request(user.cookie, `workspaces/${space.id}/members`, 'POST', {
    username: bob.username,
    role: 'viewer',
  });
  expect(
    (
      await request(bob.cookie, path(space, `connections/${connection.id}/disconnect`), 'POST', {
        appId: 'gmail',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(alice.cookie, path(space, `connections/${connection.id}/disconnect`), 'POST', {
        appId: 'gmail',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(user.cookie, path(space, `connections/${connection.id}/disconnect`), 'POST', {
        appId: 'outlook',
      })
    ).status,
  ).toBe(400);
  await db.accountToken.create({
    data: {
      id: `pending-${randomUUID()}`,
      purpose: 'google_oauth',
      userId: user.id,
      workspaceId: space.id,
      connectionId: connection.id,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const disconnected = await request(
    user.cookie,
    path(space, `connections/${connection.id}/disconnect`),
    'POST',
    { appId: 'gmail' },
  );
  expect(disconnected.data).toMatchObject({ ok: true, pausedWorkflows: 2, cancelledRuns: 1 });
  const apps = (await request(user.cookie, path(space, 'apps'))).data;
  expect(apps.find((app: any) => app.id === 'gmail').status).toBe('Not connected');
  expect(apps.find((app: any) => app.id === 'calendar').status).toBe('Connected');
  const stored = await db.withWorkspace(space.id, () =>
    db.connection.findUniqueOrThrow({ where: { id: connection.id } }),
  );
  expect(decrypt(stored.secret).tokens).toContain('synthetic-token');
  expect(
    await db.accountToken.count({
      where: { workspaceId: space.id, connectionId: connection.id, consumedAt: null },
    }),
  ).toBe(0);
  const states = (await request(user.cookie, path(space, 'workflows'))).data;
  expect(states.find((w: any) => w.name === 'Gmail').enabled).toBe(false);
  expect(states.find((w: any) => w.name === 'Nested Gmail').enabled).toBe(false);
  expect(states.find((w: any) => w.name === 'Calendar').enabled).toBe(true);
  expect(states.find((w: any) => w.name === 'Unrelated text').enabled).toBe(true);
  expect((await request(user.cookie, path(space, `runs/${mailRun.id}`))).data).toMatchObject({
    status: 'cancelled',
    error: expect.stringContaining('disconnected'),
  });
  expect((await request(user.cookie, path(space, `runs/${calendarRun.id}`))).data.status).toBe(
    'queued',
  );
  expect(
    (
      await request(user.cookie, path(space, `workflows/${workflows[0].id}/enable`), 'POST', {
        revision: 0,
      })
    ).data.ok,
  ).toBe(false);
  const preview = await request(
    user.cookie,
    path(space, `workflows/${workflows[2].id}/runs`),
    'POST',
    { preview: true },
  );
  expect(preview.data.issues.some((issue: any) => issue.message.includes('disconnected'))).toBe(
    true,
  );
  expect(
    (await request(user.cookie, path(space, `connections/${connection.id}/resources?kind=labels`)))
      .status,
  ).toBe(400);
  await db.withWorkspace(space.id, async () => {
    // A persisted/queued graph must still be denied at the worker boundary, even if it bypassed the HTTP validation path.
    const stale = await engine.createRun(workflows[0].id, {});
    for (let step = 0; step < 4; step++) {
      await engine.advance(stale.id);
      for (const task of await db.nodeExecution.findMany({
        where: { runId: stale.id, status: 'pending' },
      }))
        await engine.execute(task.id);
    }
    const rejected = await db.run.findUniqueOrThrow({ where: { id: stale.id } });
    expect(rejected.status).toBe('failed');
    expect(rejected.error).toContain('disconnected');
  });
  const service = app.get(Connections);
  await expect(
    db.withWorkspace(space.id, () => service.google(connection.id, 'gmail')),
  ).rejects.toThrow('disconnected');
  const mock = vi.spyOn(service, 'google').mockResolvedValue({
    getAccessToken: async () => ({ token: 'fixture' }),
    getTokenInfo: async () => ({ scopes: ['https://www.googleapis.com/auth/gmail.modify'] }),
  } as any);
  try {
    const reconnected = await request(
      user.cookie,
      path(space, `connections/${connection.id}/apps/gmail/connect`),
      'POST',
    );
    expect(reconnected.data.ok).toBe(true);
  } finally {
    mock.mockRestore();
  }
  expect(
    (await request(user.cookie, path(space, 'apps'))).data.find((app: any) => app.id === 'gmail')
      .status,
  ).toBe('Connected');
  expect(
    (await request(user.cookie, path(space, `workflows/${workflows[0].id}`))).data.enabled,
  ).toBe(false);
  await request(user.cookie, path(space, `connections/${connection.id}/disconnect`), 'POST', {});
  expect((await request(user.cookie, path(space, 'connections'))).data).toEqual([]);
  expect((await request(user.cookie, path(space, `runs/${calendarRun.id}`))).data.status).toBe(
    'cancelled',
  );
  expect(
    (await request(user.cookie, path(space, `workflows/${workflows[1].id}`))).data.enabled,
  ).toBe(false);
  expect(
    (await request(user.cookie, path(space, `workflows/${workflows[3].id}`))).data.enabled,
  ).toBe(true);
  expect((await request(user.cookie, path(space, 'workflows'))).data).toHaveLength(4);
});
it('pauses inherited AI workflows when their single-provider connection is disconnected from its app card', async () => {
  const { encrypt } = await import('../apps/backend/dist/security.js');
  const user = await invite(`${prefix}_disconnect_ai`),
    space = (await request(user.cookie, 'workspaces')).data[0];
  const connection = await db.withWorkspace(space.id, () =>
    db.connection.create({
      data: {
        name: 'Synthetic Gemini',
        kind: 'gemini',
        status: 'connected',
        secret: encrypt({ apiKey: 'synthetic' }),
      },
    }),
  );
  const graph = structuredClone(templates[0]!.definition);
  graph.settings.ai = {
    provider: 'gemini',
    connectionId: connection.id,
    model: 'gemini-2.5-flash',
    dataPolicy: 'public-demo',
  };
  const workflow = (
    await request(user.cookie, path(space, 'workflows'), 'POST', {
      name: 'AI workflow',
      definition: graph,
    })
  ).data;
  expect(
    (
      await request(user.cookie, path(space, `workflows/${workflow.id}/enable`), 'POST', {
        revision: 0,
      })
    ).data.ok,
  ).toBe(true);
  const run = await db.withWorkspace(space.id, () => engine.createRun(workflow.id, {}));
  const disconnected = await request(
    user.cookie,
    path(space, `connections/${connection.id}/disconnect`),
    'POST',
    { appId: 'gemini' },
  );
  expect(disconnected.data).toMatchObject({ pausedWorkflows: 1, cancelledRuns: 1 });
  expect((await request(user.cookie, path(space, `workflows/${workflow.id}`))).data.enabled).toBe(
    false,
  );
  expect((await request(user.cookie, path(space, `runs/${run.id}`))).data.status).toBe('cancelled');
});
