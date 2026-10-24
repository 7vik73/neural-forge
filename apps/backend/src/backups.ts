import { Body, Controller, Inject, Injectable, Post, UseGuards } from '@nestjs/common';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { WorkflowSchema } from '@forge/contracts';
import { Database, json, Prisma } from './database.js';
import { AuthGuard, WorkspaceGuard, WorkspacePermission } from './auth.js';
import { config } from './config.js';
import { decrypt, encrypt } from './security.js';
import { accessScope, currentWorkspace, requireWorkspaceRole } from './scope.js';
import { Workspaces } from './workspaces.js';
import { WorkspaceFiles, storagePath } from './storage.js';

const envelope = z.object({
  format: z.literal('neural-forge-workspace'),
  version: z.literal(2),
  salt: z.string().max(100),
  iv: z.string().max(100),
  tag: z.string().max(100),
  data: z.string().max(90_000_000),
});
const backupInput = z.object({ passphrase: z.string().min(12).max(200) });
const names = [
  'workflow',
  'workflowVersion',
  'connection',
  'note',
  'run',
  'runScope',
  'nodeExecution',
  'nodeAttempt',
  'executionEvent',
  'artifact',
  'aIUsage',
] as const;
export function sealWorkspaceBackup(payload: object, passphrase: string) {
  const text = JSON.stringify(payload, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  if (Buffer.byteLength(text) > 50_000_000)
    throw new Error(
      'This workspace exceeds the 50 MB browser backup limit. Ask the local operator for a full installation backup.',
    );
  const salt = randomBytes(16),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return {
    format: 'neural-forge-workspace',
    version: 2,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}
export function openBackup(backup: any, passphrase: string) {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      scryptSync(passphrase, Buffer.from(backup.salt, 'base64'), 32),
      Buffer.from(backup.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(backup.tag, 'base64'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(backup.data, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    );
  } catch {
    throw new Error('This backup could not be decrypted. Check the passphrase and file.');
  }
}
function rewriteGraph(value: any, maps: Record<string, Map<string, string>>) {
  const graph = WorkflowSchema.parse(value);
  if (graph.settings.ai?.connectionId)
    graph.settings.ai.connectionId = maps.connection!.get(graph.settings.ai.connectionId) ?? '';
  for (const node of graph.nodes) {
    if (typeof node.config.connectionId === 'string')
      node.config.connectionId = maps.connection!.get(node.config.connectionId) ?? '';
    if (
      ['notes.read', 'notes.update'].includes(node.type) &&
      node.inputs.id?.kind === 'constant' &&
      typeof node.inputs.id.value === 'string'
    )
      node.inputs.id.value = maps.note!.get(node.inputs.id.value) ?? '';
    if (node.type === 'logic.foreach')
      node.config.body = rewriteGraph(node.config.body, maps) as any;
  }
  return graph;
}
@Injectable()
export class WorkspaceBackups {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Workspaces) private readonly workspaces: Workspaces,
  ) {}
  async backup(body: unknown) {
    await requireWorkspaceRole(this.db, 'owner');
    const { passphrase } = backupInput.parse(body);
    const workspace = await this.db.workspace.findUniqueOrThrow({
      where: { id: currentWorkspace() },
    });
    const tables = await this.db.$transaction(
      async (tx) => {
        const result: Record<string, any[]> = {};
        for (const name of names) {
          result[name] = (await (tx as any)[name].findMany()).map(
            ({ workspaceId, ...record }: any) => record,
          );
        }
        result.connection = result.connection!.map(({ secret, ...connection }) => ({
          ...connection,
          credentials: decrypt(secret),
        }));
        return result;
      },
      { isolationLevel: 'RepeatableRead', timeout: 30_000 },
    );
    const files: { path: string; text: string }[] = [];
    const root = await storagePath(this.db),
      local = new WorkspaceFiles(this.db);
    const visit = async (folder: string) => {
      for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = [folder, entry.name].filter(Boolean).join('/');
        if (entry.isDirectory()) await visit(path);
        else if (/\.(txt|md|csv|json)$/i.test(entry.name)) files.push(await local.read(path));
      }
    };
    await visit('');
    return sealWorkspaceBackup(
      {
        schemaVersion: config.schemaVersion,
        name: workspace.name,
        settings: workspace.settings,
        tables,
        files,
      },
      passphrase,
    );
  }
  async restore(ownerId: string, body: unknown) {
    const { passphrase, backup } = backupInput.extend({ backup: envelope }).parse(body);
    const payload = openBackup(backup, passphrase);
    const parsed = z
      .object({
        schemaVersion: z.union([z.literal(3), z.literal(4)]),
        name: z.string().min(1).max(80),
        settings: z.object({
          timezone: z.string(),
          model: z.string().max(100),
          retentionDays: z.number().int().min(1).max(3650),
          retainAIDetails: z.boolean(),
        }),
        tables: z.record(z.string(), z.array(z.record(z.string(), z.any())).max(100_000)),
        files: z.array(z.object({ path: z.string().max(1000), text: z.string().max(20_000_000) })),
      })
      .parse(payload);
    new Intl.DateTimeFormat('en', { timeZone: parsed.settings.timezone });
    parsed.tables.aIUsage ??= [];
    for (const name of names)
      if (!Array.isArray(parsed.tables[name]))
        throw new Error('This workspace backup is incomplete.');
    const workspace = await this.workspaces.create(
      ownerId,
      `${parsed.name.slice(0, 69)} (restored)`,
      parsed.settings,
    );
    const maps: Record<string, Map<string, string>> = Object.fromEntries(
      names.map((name) => [
        name,
        new Map(parsed.tables[name]!.map((row) => [String(row.id), randomUUID()])),
      ]),
    );
    // Artifacts used for internal idempotency share their task identity.
    for (const row of parsed.tables.artifact!)
      if (maps.nodeExecution!.has(row.id))
        maps.artifact!.set(row.id, maps.nodeExecution!.get(row.id)!);
    const mapped = (table: string, id: string | null | undefined) =>
      id == null ? null : (maps[table]!.get(id) ?? null);
    const scopeKey = (key: string) => {
      for (const [oldId, newId] of maps.nodeExecution!)
        if (key.startsWith(`${oldId}-`)) return `${newId}${key.slice(oldId.length)}`;
      return key;
    };
    try {
      await this.db.withWorkspace(
        workspace.id,
        async () => {
          const root = await storagePath(this.db),
            local = new WorkspaceFiles(this.db);
          for (const file of parsed.files) {
            // Validate the full relative path before making any directories.
            if (
              file.path.startsWith('/') ||
              file.path.includes('\\') ||
              file.path.split('/').some((p) => p === '..' || p === '.' || !p)
            )
              throw new Error('A backup file path is outside the workspace.');
            await mkdir(join(root, dirname(file.path)), { recursive: true });
            await local.write(file.path, file.text, true);
          }
          await this.db.$transaction(
            async (tx) => {
              const fields = (name: string, row: any) => {
                const model = Prisma.dmmf.datamodel.models.find(
                  (m) => m.name === name[0]!.toUpperCase() + name.slice(1),
                )!;
                const allowed = new Set(
                  model.fields.filter((f) => f.kind !== 'object').map((f) => f.name),
                );
                return Object.fromEntries(
                  Object.entries(row).filter(
                    ([key]) => allowed.has(key) && !['id', 'workspaceId'].includes(key),
                  ),
                );
              };
              for (const row of parsed.tables.workflow!)
                await tx.workflow.create({
                  data: {
                    ...fields('workflow', row),
                    id: mapped('workflow', row.id)!,
                    name: row.name,
                    draft: json(rewriteGraph(row.draft, maps)),
                    publishedId: null,
                    enabled: false,
                    webhookHash: null,
                  } as any,
                });
              for (const row of parsed.tables.workflowVersion!)
                await tx.workflowVersion.create({
                  data: {
                    ...fields('workflowVersion', row),
                    id: mapped('workflowVersion', row.id)!,
                    workflowId: mapped('workflow', row.workflowId)!,
                    definition: json(rewriteGraph(row.definition, maps)),
                  } as any,
                });
              for (const row of parsed.tables.workflow!)
                if (row.publishedId)
                  await tx.workflow.update({
                    where: { id: mapped('workflow', row.id)! },
                    data: { publishedId: mapped('workflowVersion', row.publishedId) },
                  });
              for (const row of parsed.tables.connection!)
                await tx.connection.create({
                  data: {
                    ...fields('connection', row),
                    id: mapped('connection', row.id)!,
                    name: row.name,
                    kind: row.kind,
                    secret: encrypt(z.record(z.string(), z.string()).parse(row.credentials)),
                    status: 'untested',
                  } as any,
                });
              for (const row of parsed.tables.run!)
                await tx.run.create({
                  data: {
                    ...fields('run', row),
                    id: mapped('run', row.id)!,
                    workflowId: mapped('workflow', row.workflowId)!,
                    versionId: mapped('workflowVersion', row.versionId),
                    triggerKey: null,
                    restoredAt: new Date(),
                    status: ['queued', 'running', 'waiting'].includes(row.status)
                      ? 'cancelled'
                      : row.status,
                    input: json(row.input),
                    error: ['queued', 'running', 'waiting'].includes(row.status)
                      ? 'Interrupted by restore'
                      : row.error,
                  } as any,
                });
              for (const row of parsed.tables.runScope!)
                await tx.runScope.create({
                  data: {
                    ...fields('runScope', row),
                    id: mapped('runScope', row.id)!,
                    runId: mapped('run', row.runId)!,
                    key: scopeKey(row.key),
                    parentTaskId: mapped('nodeExecution', row.parentTaskId),
                    definition: json(rewriteGraph(row.definition, maps)),
                    input: json(row.input),
                    output: row.output === null ? Prisma.DbNull : json(row.output),
                    status: row.status === 'running' ? 'cancelled' : row.status,
                  } as any,
                });
              for (const row of parsed.tables.nodeExecution!)
                await tx.nodeExecution.create({
                  data: {
                    ...fields('nodeExecution', row),
                    id: mapped('nodeExecution', row.id)!,
                    runId: mapped('run', row.runId)!,
                    scope: scopeKey(row.scope),
                    input: row.input === null ? Prisma.DbNull : json(row.input),
                    output: row.output === null ? Prisma.DbNull : json(row.output),
                    status: ['pending', 'running', 'waiting'].includes(row.status)
                      ? 'cancelled'
                      : row.status,
                    leaseUntil: null,
                    wakeAt: null,
                  } as any,
                });
              for (const row of parsed.tables.nodeAttempt!)
                await tx.nodeAttempt.create({
                  data: {
                    ...fields('nodeAttempt', row),
                    id: mapped('nodeAttempt', row.id)!,
                    taskId: mapped('nodeExecution', row.taskId)!,
                    status: ['running', 'waiting'].includes(row.status) ? 'cancelled' : row.status,
                  } as any,
                });
              for (const row of parsed.tables.note!)
                await tx.note.create({
                  data: {
                    ...fields('note', row),
                    id: mapped('note', row.id)!,
                    title: row.title,
                    text: row.text,
                    effectKey: mapped('nodeExecution', row.effectKey),
                    lastRunId: mapped('run', row.lastRunId),
                  } as any,
                });
              for (const row of parsed.tables.executionEvent!)
                await tx.executionEvent.create({
                  data: {
                    ...fields('executionEvent', row),
                    runId: mapped('run', row.runId)!,
                    type: row.type,
                    data: json(row.data),
                  } as any,
                });
              for (const row of parsed.tables.aIUsage!)
                await tx.aIUsage.create({
                  data: { ...fields('aIUsage', row), id: mapped('aIUsage', row.id)! } as any,
                });
              for (const row of parsed.tables.artifact!)
                await tx.artifact.create({
                  data: {
                    ...fields('artifact', row),
                    id: mapped('artifact', row.id)!,
                    runId: mapped('run', row.runId)!,
                    nodeId: row.nodeId,
                    kind: row.kind,
                    metadata: json(row.metadata),
                  } as any,
                });
            },
            { timeout: 60_000 },
          );
        },
        { userId: ownerId },
      );
      return {
        ok: true,
        workspaceId: workspace.id,
        notice:
          'Restored into a new private workspace. Test connections and review workflows before enabling them.',
      };
    } catch (error) {
      await this.db.workspace.delete({ where: { id: workspace.id } });
      await rm(join(config.workspaceStorage, workspace.storageKey), {
        recursive: true,
        force: true,
      });
      throw error;
    }
  }
}
@Controller('api/v1/workspaces/:workspaceId')
@UseGuards(WorkspaceGuard)
export class BackupsController {
  constructor(@Inject(WorkspaceBackups) private readonly backups: WorkspaceBackups) {}
  @Post('backup') backup(@Body() body: unknown) {
    return this.backups.backup(body);
  }
}
@Controller('api/v1/workspaces')
@UseGuards(AuthGuard)
export class WorkspaceRestoreController {
  constructor(@Inject(WorkspaceBackups) private readonly backups: WorkspaceBackups) {}
  @Post('restore') restore(@Body() body: unknown) {
    return this.backups.restore(accessScope.getStore()!.userId!, body);
  }
}
