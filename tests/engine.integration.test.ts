import { afterAll, beforeAll, describe, expect, it as originalIt, vi } from 'vitest';
import { config as dotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFiles } from '../packages/connectors/src/files.js';
import { constant, ref, type WorkflowDefinition, type WorkflowNode } from '@forge/contracts';
import { catalog, createNode } from '../packages/connectors/src/catalog.js';

dotenv({ path: '.env', quiet: true });
const testDatabase = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!process.env.TEST_DATABASE_URL) testDatabase.pathname = '/forge_test';
if (!testDatabase.pathname.endsWith('_test'))
  throw new Error('Integration tests require a database ending in _test.');
process.env.DATABASE_URL = testDatabase.toString();
let db: any;
let workspace: any;
let storageRoot: string;
let testUserId: string;
const wrap: any = (name: any, fn: any, options?: any) =>
  originalIt(name, () => db.withWorkspace(workspace.id, fn), options);
wrap.skipIf = (condition: boolean) => (condition ? originalIt.skip : wrap);
wrap.each = (cases: any[]) => (name: string, fn: (...args: any[]) => any, options?: any) =>
  originalIt.each(cases)(
    name,
    (...args: any[]) => db.withWorkspace(workspace.id, () => fn(...args)),
    options,
  );
const it: typeof originalIt = wrap;
let engine: any;
let operations: any;
let ai: any;
let ConnectionsClass: any;
const workflows: string[] = [];
const step = (
  type: string,
  id: string,
  config: Record<string, any> = {},
  inputs: Record<string, any> = {},
): WorkflowNode => ({
  ...createNode(type, id),
  config: { ...createNode(type, id).config, ...config },
  inputs,
});
function chain(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
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
  };
}
async function create(graph: WorkflowDefinition) {
  const workflow = await db.workflow.create({
    data: { name: `Integration ${randomUUID()}`, draft: graph },
  });
  workflows.push(workflow.id);
  return workflow;
}
async function drain(runId: string, iterations = 100) {
  for (let i = 0; i < iterations; i++) {
    await engine.advance(runId);
    const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
    if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(run.status)) return run;
    const pending = await db.nodeExecution.findMany({ where: { runId, status: 'pending' } });
    if (!pending.length) {
      const blocked = await db.nodeExecution.count({
        where: { runId, status: 'waiting', reason: { in: ['approval', 'delay', 'retry'] } },
      });
      if (blocked) return run;
      continue;
    }
    await Promise.all(pending.map((t: any) => engine.execute(t.id)));
  }
  throw new Error('Run did not settle.');
}
beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'forge-engine-files-'));
  process.env.WORKSPACE_STORAGE_ROOT = storageRoot;
  const { Database } = await import('../apps/backend/dist/database.js');
  const { Connections } = await import('../apps/backend/dist/connections.js');
  const { LocalAI } = await import('../apps/backend/dist/ai.js');
  const { Operations } = await import('../apps/backend/dist/operations.js');
  const { ExecutionEngine } = await import('../apps/backend/dist/engine.js');
  db = new Database();
  await db.$connect();
  const { passwordHash } = await import('../apps/backend/dist/security.js');
  const user = await db.user.create({
    data: {
      username: `engine_${randomUUID().slice(0, 8)}`,
      displayName: 'Engine fixture',
      passwordHash: passwordHash('engine fixture password'),
    },
  });
  testUserId = user.id;
  workspace = await db.workspace.create({
    data: {
      ownerId: user.id,
      name: 'Engine fixtures',
      settings: { timezone: 'UTC', model: 'qwen3:4b', retentionDays: 30, retainAIDetails: false },
    },
  });
  const { config } = await import('../apps/backend/dist/config.js');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(config.workspaceStorage, workspace.storageKey, 'files'), { recursive: true });
  ConnectionsClass = Connections;
  ai = new LocalAI(db);
  operations = new Operations(db, new Connections(db), {
    process: async () => ({
      text: 'A deterministic local test summary.',
      model: 'fixture',
      durationMs: 0,
    }),
  } as any);
  engine = new ExecutionEngine(db, operations);
});
afterAll(async () => {
  if (db) {
    if (workspace) await db.workspace.delete({ where: { id: workspace.id } });
    if (testUserId) await db.user.delete({ where: { id: testUserId } });
    await ai?.onModuleDestroy();
    await db.$disconnect();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

describe('durable PostgreSQL execution', () => {
  it('runs a complete workflow and duplicate delivery does not create another note', async () => {
    const workflow = await create(
      chain([
        step('trigger.manual', 'start'),
        step('ai.summarize', 'summary', {}, { text: ref('$input', 'text') }),
        step(
          'notes.create',
          'save',
          {},
          { title: constant('Integration summary'), text: ref('summary', 'text') },
        ),
      ]),
    );
    const run = await engine.createRun(workflow.id, { text: 'Example' });
    expect((await drain(run.id)).status).toBe('succeeded');
    const task = await db.nodeExecution.findUniqueOrThrow({
      where: { runId_scope_nodeId: { runId: run.id, scope: 'root', nodeId: 'save' } },
    });
    await Promise.all([engine.execute(task.id), engine.execute(task.id)]);
    expect(await db.note.count({ where: { effectKey: task.id } })).toBe(1);
  });
  it('executes independent branches and joins their outputs', async () => {
    const g = chain([
      step('trigger.manual', 'start'),
      step('data.text', 'upper', { operation: 'upper' }, { text: ref('$input', 'text') }),
      step('data.text', 'lower', { operation: 'lower' }, { text: ref('$input', 'text') }),
      step('logic.join', 'join'),
    ]);
    g.edges = [
      { id: 'a', source: 'start', target: 'upper', sourcePort: 'out', targetPort: 'in' },
      { id: 'b', source: 'start', target: 'lower', sourcePort: 'out', targetPort: 'in' },
      { id: 'c', source: 'upper', target: 'join', sourcePort: 'out', targetPort: 'in' },
      { id: 'd', source: 'lower', target: 'join', sourcePort: 'out', targetPort: 'in' },
    ];
    const w = await create(g);
    const r = await engine.createRun(w.id, { text: 'Mixed' });
    expect((await drain(r.id)).status).toBe('succeeded');
    const task = await db.nodeExecution.findFirst({ where: { runId: r.id, nodeId: 'join' } });
    expect(task.output.items).toEqual([{ text: 'MIXED' }, { text: 'mixed' }]);
  });
  it('persists an approval and continues with a new engine instance', async () => {
    const w = await create(
      chain([
        step('trigger.manual', 'start'),
        step('logic.approval', 'approve', { message: 'Continue?' }),
        step('data.text', 'finish', { operation: 'upper' }, { text: constant('approved') }),
      ]),
    );
    const r = await engine.createRun(w.id, {});
    expect((await drain(r.id)).status).toBe('waiting');
    const task = await db.nodeExecution.findFirst({ where: { runId: r.id, nodeId: 'approve' } });
    const { ExecutionEngine } = await import('../apps/backend/dist/engine.js');
    const restarted = new ExecutionEngine(db, operations);
    await restarted.approve(r.id, task.id, true);
    expect((await drain(r.id)).status).toBe('succeeded');
  });
  it('persists delays and cancellation prevents subsequent effects', async () => {
    const w = await create(
      chain([
        step('trigger.manual', 'start'),
        step('logic.delay', 'wait', { seconds: 100 }),
        step(
          'notes.create',
          'save',
          {},
          { title: constant('Never created'), text: constant('Cancelled') },
        ),
      ]),
    );
    const r = await engine.createRun(w.id, {});
    expect((await drain(r.id)).status).toBe('waiting');
    await engine.cancel(r.id);
    await engine.recover();
    await engine.advance(r.id);
    expect((await db.run.findUnique({ where: { id: r.id } })).status).toBe('cancelled');
    expect(await db.nodeExecution.count({ where: { runId: r.id, nodeId: 'save' } })).toBe(0);
  });
  it('resumes a persisted delay after its wake time', async () => {
    const w = await create(
      chain([
        step('trigger.manual', 'start'),
        step('logic.delay', 'wait', { seconds: 0 }),
        step('data.text', 'finish', { operation: 'upper' }, { text: constant('done') }),
      ]),
    );
    const r = await engine.createRun(w.id, {});
    await drain(r.id);
    await engine.recover();
    expect((await drain(r.id)).status).toBe('succeeded');
  });
  it.each([{ items: [] }, { items: ['a', 'b', 'c'] }])(
    'processes bounded lists in stable item order: $items',
    async ({ items }) => {
      const body = chain([
        step('trigger.manual', 'item'),
        step('data.text', 'format', { operation: 'upper' }, { text: ref('$input', 'item') }),
      ]);
      const w = await create(
        chain([
          step('trigger.manual', 'start'),
          step('logic.foreach', 'each', { body }, { items: constant(items) }),
        ]),
      );
      const r = await engine.createRun(w.id, {});
      expect((await drain(r.id)).status).toBe('succeeded');
      const task = await db.nodeExecution.findFirst({
        where: { runId: r.id, nodeId: 'each', scope: 'root' },
      });
      expect(task.output.items).toEqual(items.map((text) => ({ text: text.toUpperCase() })));
    },
  );
  it('marks interrupted unsafe effects unknown instead of re-sending', async () => {
    const w = await create(
      chain([
        step('trigger.manual', 'start'),
        step(
          'telegram.send',
          'send',
          { connectionId: 'fixture', chatId: 'fixture' },
          { text: constant('Hello') },
        ),
      ]),
    );
    const r = await engine.createRun(w.id, {});
    await engine.advance(r.id);
    const trigger = await db.nodeExecution.findFirst({ where: { runId: r.id, nodeId: 'start' } });
    await engine.execute(trigger.id);
    await engine.advance(r.id);
    const task = await db.nodeExecution.findFirst({ where: { runId: r.id, nodeId: 'send' } });
    await db.nodeExecution.update({
      where: { id: task.id },
      data: { status: 'running', attempt: 1, leaseUntil: new Date(0) },
    });
    await db.nodeAttempt.create({ data: { taskId: task.id, number: 1, status: 'running' } });
    await engine.recover();
    expect((await drain(r.id)).status).toBe('unknown');
    await expect(engine.retry(r.id, task.id, false)).rejects.toThrow('Confirm');
  });
  it('reconstructs missing dispatches from PostgreSQL after queue loss', async () => {
    const w = await create(chain([step('trigger.manual', 'start')]));
    const r = await engine.createRun(w.id, {});
    await db.outbox.updateMany({
      where: { payload: { path: ['runId'], equals: r.id } },
      data: { sentAt: new Date() },
    });
    const { ExecutionEngine } = await import('../apps/backend/dist/engine.js');
    const restarted = new ExecutionEngine(db, operations);
    await restarted.recover();
    expect(
      await db.outbox.count({
        where: { kind: 'advance', sentAt: null, payload: { path: ['runId'], equals: r.id } },
      }),
    ).toBeGreaterThan(0);
    await engine.advance(r.id);
    const pending = await db.nodeExecution.findFirst({ where: { runId: r.id } });
    const another = new ExecutionEngine(db, operations);
    await another.recover();
    expect(
      await db.outbox.count({
        where: { kind: 'execute', sentAt: null, payload: { path: ['taskId'], equals: pending.id } },
      }),
    ).toBeGreaterThan(0);
  });
  it('rejects stale scheduled versions atomically', async () => {
    const w = await create(
      chain([step('trigger.schedule', 'start', { cron: '0 20 * * *', timezone: 'UTC' })]),
    );
    const published = await engine.publish(w.id, 0);
    expect(published.ok).toBe(true);
    const nextVersion = await db.workflowVersion.create({
      data: { workflowId: w.id, number: 2, definition: w.draft },
    });
    await db.workflow.update({
      where: { id: w.id },
      data: { publishedId: nextVersion.id, enabled: true },
    });
    expect(
      await engine.scheduledRun(w.id, published.versionId, `stale-${randomUUID()}`),
    ).toBeNull();
    expect(await db.run.count({ where: { workflowId: w.id } })).toBe(0);
  });
  it('simulates a write in Preview without creating a local note', async () => {
    const w = await create(
      chain([
        step('trigger.manual', 'start'),
        step(
          'notes.create',
          'save',
          {},
          { title: constant('Preview only'), text: constant('No writes') },
        ),
      ]),
    );
    const r = await engine.createRun(w.id, {}, true);
    expect((await drain(r.id)).status).toBe('succeeded');
    const task = await db.nodeExecution.findFirst({ where: { runId: r.id, nodeId: 'save' } });
    expect(task.output.simulated).toBe(true);
    expect(await db.note.count({ where: { effectKey: task.id } })).toBe(0);
  });
});

it.skipIf(process.env.RUN_OLLAMA_TESTS !== '1')(
  'uses real native Ollama for summarization and workflow generation',
  async () => {
    const summary = await ai.process(
      'summarize',
      'The meeting is Monday. Priya will prepare the budget.',
      {},
    );
    expect(summary.text.toLowerCase()).toContain('monday');
    const generated = await ai.generate(
      'Summarize the input text with local AI and save it as a new note titled My summary.',
    );
    expect(generated.definition).not.toBeNull();
    expect(generated.definition.nodes.some((n: any) => n.type === 'notes.create')).toBe(true);
  },
  600_000,
);

it('polls a shared Telegram inbox once and fans new messages out atomically', async () => {
  const { Polling } = await import('../apps/backend/dist/polling.js');
  const { encrypt } = await import('../apps/backend/dist/security.js');
  const connectionId = `telegram-fixture-${randomUUID()}`;
  const connection = await db.connection.create({
    data: {
      id: connectionId,
      name: 'Synthetic Telegram inbox',
      kind: 'telegram',
      status: 'connected',
      secret: encrypt({ token: 'synthetic-token' }),
    },
  });
  const a = await create(chain([step('trigger.telegram', 'start', { connectionId })]));
  const b = await create(chain([step('trigger.telegram', 'start', { connectionId })]));
  await engine.publish(a.id, 0);
  await engine.publish(b.id, 0);
  let calls = 0;
  const connections = {
    telegramSnapshot: async (_id: string, _method: string, input: Record<string, any>) => {
      calls++;
      if (calls === 1) {
        expect(input.offset).toBe(-1);
        return {
          identity: connection.secret,
          result: [{ update_id: 10, message: { text: 'Old', chat: { id: 1 } } }],
        };
      }
      expect(input.offset).toBe(11);
      return {
        identity: connection.secret,
        result: [{ update_id: 11, message: { text: 'New shared message', chat: { id: 1 } } }],
      };
    },
  };
  const polling = new Polling(db, connections as any, operations, engine);
  try {
    await polling.tick();
    expect(await db.run.count({ where: { workflowId: { in: [a.id, b.id] } } })).toBe(0);
    await polling.tick();
    expect(calls).toBe(2);
    const events = await db.run.findMany({ where: { workflowId: { in: [a.id, b.id] } } });
    expect(events).toHaveLength(2);
    expect(events.every((r: any) => r.input.text === 'New shared message')).toBe(true);
  } finally {
    await db.workflow.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { enabled: false } });
    await db.sourceCheckpoint.deleteMany({ where: { id: `telegram-${connectionId}` } });
    await db.connection.delete({ where: { id: connectionId } });
  }
});

it('rejects competing Telegram connections and discards in-flight results after token replacement', async () => {
  const { Polling } = await import('../apps/backend/dist/polling.js');
  const connections = new ConnectionsClass(db);
  const token = `fixture-${randomUUID()}`;
  const connection = await connections.save('Token replacement fixture', 'telegram', { token });
  await db.connection.update({ where: { id: connection.id }, data: { status: 'connected' } });
  const sourceId = `telegram-${connection.id}`;
  const workflow = await create(
    chain([step('trigger.telegram', 'start', { connectionId: connection.id })]),
  );
  await engine.publish(workflow.id, 0);
  try {
    await expect(connections.save('Duplicate bot', 'telegram', { token })).rejects.toThrow(
      'already saved',
    );
    await db.sourceCheckpoint.create({ data: { id: sourceId, value: { offset: 900 } } });
    await db.checkpoint.upsert({
      where: { workflowId: workflow.id },
      create: { workflowId: workflow.id, value: { initialized: true } },
      update: { value: { initialized: true } },
    });
    const old = await connections.get(connection.id);
    const polling = new Polling(
      db,
      {
        telegramSnapshot: async () => {
          await connections.save(
            'Replacement bot',
            'telegram',
            { token: `${token}-replacement` },
            connection.id,
          );
          return {
            identity: old.secret,
            result: [
              { update_id: 901, message: { text: 'Stale old bot message', chat: { id: 1 } } },
            ],
          };
        },
      } as any,
      operations,
      engine,
    );
    await polling.tick();
    expect(await db.sourceCheckpoint.findUnique({ where: { id: sourceId } })).toBeNull();
    expect(await db.run.count({ where: { workflowId: workflow.id } })).toBe(0);
  } finally {
    await db.workflow.update({ where: { id: workflow.id }, data: { enabled: false } });
    await db.sourceCheckpoint.deleteMany({ where: { id: sourceId } });
    await db.connection.delete({ where: { id: connection.id } });
  }
});

it('prevents note workflows from triggering themselves by default', async () => {
  const { Polling } = await import('../apps/backend/dist/polling.js');
  const w = await create(chain([step('trigger.note', 'start')]));
  await engine.publish(w.id, 0);
  const polling = new Polling(db, {} as any, operations, engine);
  const ids: string[] = [];
  try {
    await polling.tick();
    const manual = await db.note.create({
      data: { title: 'Manual change fixture', text: 'User input' },
    });
    ids.push(manual.id);
    const automated = await db.note.create({
      data: { title: 'Automated fixture', text: 'Workflow result', lastRunId: 'synthetic-origin' },
    });
    ids.push(automated.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await polling.tick();
    const events = await db.run.findMany({ where: { workflowId: w.id } });
    expect(events).toHaveLength(1);
    expect(events[0].input.id).toBe(manual.id);
  } finally {
    await db.workflow.update({ where: { id: w.id }, data: { enabled: false } });
    await db.note.deleteMany({ where: { id: { in: ids } } });
  }
});

it('round-trips an encrypted backup into a new private workspace', async () => {
  const { WorkspaceBackups } = await import('../apps/backend/dist/backups.js');
  const { Workspaces } = await import('../apps/backend/dist/workspaces.js');
  const { WorkspaceFiles } = await import('../apps/backend/dist/storage.js');
  const { encrypt, decrypt } = await import('../apps/backend/dist/security.js');
  const service = new Workspaces(db, engine);
  const backups = new WorkspaceBackups(db, service);
  const files = new WorkspaceFiles(db);
  await files.write('example.md', 'A backed-up note.', true);
  await db.connection.create({
    data: {
      name: 'Backup fixture',
      kind: 'http',
      secret: encrypt({ token: 'synthetic-backup-token' }),
    },
  });
  const backup = await backups.backup({ passphrase: 'a long backup passphrase' });
  expect(backup.data).not.toContain('A backed-up note');
  await expect(
    backups.restore(testUserId, { passphrase: 'the wrong backup password', backup }),
  ).rejects.toThrow('decrypted');
  const restored = await backups.restore(testUserId, {
    passphrase: 'a long backup passphrase',
    backup,
  });
  try {
    await db.withWorkspace(restored.workspaceId, async () => {
      const connection = await db.connection.findFirstOrThrow({
        where: { name: 'Backup fixture' },
      });
      expect(decrypt(connection.secret)).toEqual({ token: 'synthetic-backup-token' });
      expect((await files.read('example.md')).text).toBe('A backed-up note.');
      expect(await db.workflow.count({ where: { enabled: true } })).toBe(0);
      expect(
        await db.run.count({ where: { status: { in: ['queued', 'running', 'waiting'] } } }),
      ).toBe(0);
      expect(await db.outbox.count()).toBe(0);
      const historical = await db.nodeExecution.findFirstOrThrow({
        where: { status: { in: ['failed', 'unknown'] } },
      });
      const historicalRun = await db.run.findUniqueOrThrow({ where: { id: historical.runId } });
      expect(historicalRun.restoredAt).toBeTruthy();
      await expect(engine.retry(historical.runId, historical.id, true)).rejects.toThrow(
        'history only',
      );
      const freshWorkflow = await create(chain([step('trigger.manual', 'start')]));
      const fresh = await engine.createRun(freshWorkflow.id, {});
      await engine.advance(fresh.id);
      expect((await db.run.findUniqueOrThrow({ where: { id: fresh.id } })).restoredAt).toBeNull();
    });
  } finally {
    await db.workspace.delete({ where: { id: restored.workspaceId } });
  }
}, 60_000);

it('runs Gemini with unreachable Ollama and keeps provider selection in nested execution', async () => {
  const { config } = await import('../apps/backend/dist/config.js');
  const { encrypt } = await import('../apps/backend/dist/security.js');
  const { Operations } = await import('../apps/backend/dist/operations.js');
  const { ExecutionEngine } = await import('../apps/backend/dist/engine.js');
  const oldURL = config.ollamaUrl,
    original = engine;
  config.ollamaUrl = 'http://127.0.0.1:1';
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    if (String(url).includes('generativelanguage.googleapis.com'))
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Public demo summary.' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
      });
    throw new Error('Ollama is absent in this test.');
  });
  try {
    const connection = await db.connection.create({
      data: {
        name: 'Synthetic Gemini fixture',
        kind: 'gemini',
        status: 'connected',
        secret: encrypt({ apiKey: 'synthetic-fixture' }),
      },
    });
    const body = chain([
      step('trigger.manual', 'item'),
      step('ai.summarize', 'summary', {}, { text: ref('$input', 'item') }),
    ]);
    const graph = chain([
      step('trigger.manual', 'start'),
      step(
        'logic.foreach',
        'loop',
        { body },
        { items: constant(['Public first item', 'Public second item']) },
      ),
    ]);
    graph.settings.ai = {
      provider: 'gemini',
      connectionId: connection.id,
      model: 'gemini-2.5-flash',
      dataPolicy: 'public-demo',
    } as any;
    const ops = new Operations(db, new ConnectionsClass(db), ai);
    engine = new ExecutionEngine(db, ops);
    expect(await engine.validate(graph)).toEqual([]);
    const workflow = await create(graph),
      run = await engine.createRun(workflow.id, {});
    expect((await drain(run.id)).status).toBe('succeeded');
    const tasks = await db.nodeExecution.findMany({ where: { runId: run.id, nodeId: 'summary' } });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task: any) => task.output.provider === 'gemini')).toBe(true);
    expect(
      await db.aIUsage.count({ where: { provider: 'gemini', outcome: 'succeeded' } }),
    ).toBeGreaterThanOrEqual(2);
    expect(
      fetch.mock.calls.every(([url]) => String(url).includes('generativelanguage.googleapis.com')),
    ).toBe(true);
  } finally {
    config.ollamaUrl = oldURL;
    engine = original;
    fetch.mockRestore();
  }
});
