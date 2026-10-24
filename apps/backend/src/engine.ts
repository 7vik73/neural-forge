import { currentWorkspace } from './scope.js';
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { catalog } from '@forge/connectors';
import { frontier, resolveInputs, validateWorkflow } from '@forge/workflow';
import {
  Limits,
  OperationError,
  WorkflowSchema,
  type JsonObject,
  type ExecutionState,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@forge/contracts';
import { CronExpressionParser } from 'cron-parser';
import { Database, dispatch, event, json, Prisma, type Tx } from './database.js';
import { Operations } from './operations.js';
import { digest, redact, decrypt } from './security.js';
import { activeApps, groupedApps, nodeApp } from './connection-policy.js';

type ControlWork = {
  run: { id: string; preview: boolean };
  task: { id: string };
  node: WorkflowNode;
  input: JsonObject;
  attempt: number;
  graph: WorkflowDefinition;
};
const finished = ['succeeded', 'failed', 'unknown', 'cancelled'];
export const retrySafe = (node: WorkflowNode) =>
  node.type === 'http.request'
    ? node.config.method === 'GET'
    : ['files.create', 'files.update'].includes(node.type)
      ? false
      : !!catalog.find((d) => d.type === node.type)?.retrySafe;
export async function lockRun(tx: Tx, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
}

@Injectable()
export class ExecutionEngine {
  private lastReconcile = new Map<string, number>();
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Operations) private readonly operations: Operations,
  ) {}
  async validate(definition: unknown, preview = false) {
    const issues = this.definitionIssues(definition, preview);
    if (issues.length) return issues;
    const graph = WorkflowSchema.parse(definition);
    const walk = async (g: WorkflowDefinition) => {
      for (const node of g.nodes) {
        const meta = catalog.find((n) => n.type === node.type)!;
        if (node.type.startsWith('ai.')) {
          try {
            await this.operations.validateAI(g.settings.ai, node.config);
          } catch (error) {
            issues.push({ nodeId: node.id, message: (error as Error).message });
          }
        }
        if (meta.connectionKind && node.config.connectionId && true) {
          const connection = await this.db.connection.findUnique({
            where: { id: String(node.config.connectionId) },
            select: { kind: true, status: true, secret: true },
          });
          if (!connection || connection.kind !== meta.connectionKind)
            issues.push({
              nodeId: node.id,
              field: 'connectionId',
              message: 'Choose a matching connected account.',
            });
          else if (!preview && !['connected', 'configured'].includes(connection.status))
            issues.push({
              nodeId: node.id,
              field: 'connectionId',
              message: 'Test or reconnect this account in Connections.',
            });
          else if (
            groupedApps[connection.kind] &&
            !activeApps(connection.kind, decrypt(connection.secret)).includes(nodeApp(node))
          )
            issues.push({
              nodeId: node.id,
              field: 'connectionId',
              message: `${nodeApp(node)} is disconnected in this workspace. Connect it in Apps & connections.`,
            });
        }
        if (node.type === 'trigger.schedule')
          try {
            CronExpressionParser.parse(String(node.config.cron), {
              tz: String(node.config.timezone ?? g.settings.timezone),
            }).next();
          } catch {
            issues.push({ nodeId: node.id, message: 'Choose a valid schedule and timezone.' });
          }
        if (
          ['notes.read', 'notes.update'].includes(node.type) &&
          node.inputs.id?.kind === 'constant' &&
          typeof node.inputs.id.value === 'string' &&
          node.inputs.id.value
        ) {
          if (
            !(await this.db.note.findUnique({
              where: { id: node.inputs.id.value },
              select: { id: true },
            }))
          )
            issues.push({
              nodeId: node.id,
              field: 'id',
              message: 'Choose an available note in this workspace.',
            });
        }
        if (node.type === 'logic.foreach') {
          const body = WorkflowSchema.parse(node.config.body);
          if (!body.settings.ai) body.settings.ai = g.settings.ai;
          await walk(body);
        }
      }
    };
    await walk(graph);
    return issues;
  }
  private definitionIssues(value: unknown, preview: boolean) {
    const issues = validateWorkflow(value, catalog);
    if (!preview) return issues;
    const parsed = WorkflowSchema.safeParse(value);
    if (!parsed.success) return issues;
    return issues.filter((issue) => {
      const node = parsed.data.nodes.find((n) => n.id === issue.nodeId);
      const definition = catalog.find((d) => d.type === node?.type);
      return !(
        issue.message.startsWith('Set “') &&
        issue.field &&
        node &&
        (node.type.startsWith('trigger.') || definition?.effect === 'write') &&
        definition?.fields.find((f) => f.key === issue.field)?.target === 'config'
      );
    });
  }
  async publish(id: string, revision: number) {
    const workflow = await this.db.workflow.findUniqueOrThrow({ where: { id } });
    if (workflow.revision !== revision)
      throw new Error('This workflow changed in another tab. Reload before enabling it.');
    const issues = await this.validate(workflow.draft);
    if (issues.length) return { ok: false, issues };
    return this.db.$transaction(async (tx) => {
      await lockRun(tx, `connection-lifecycle:${currentWorkspace()}`);
      await lockRun(tx, id);
      const current = await tx.workflow.findUniqueOrThrow({ where: { id } });
      if (current.revision !== revision)
        throw new Error('This workflow changed. Reload before enabling it.');
      const currentIssues = await this.validate(current.draft);
      if (currentIssues.length) return { ok: false, issues: currentIssues };
      const number = await tx.workflowVersion.count({ where: { workflowId: id } });
      const version = await tx.workflowVersion.create({
        data: { workflowId: id, number: number + 1, definition: json(current.draft) },
      });
      const token = randomBytes(32).toString('hex');
      await tx.workflow.update({
        where: { id },
        data: { enabled: true, publishedId: version.id, webhookHash: digest(token) },
      });
      await tx.checkpoint.deleteMany({ where: { workflowId: id } });
      return { ok: true, versionId: version.id, webhookToken: token };
    });
  }
  async createRun(
    workflowId: string,
    input: JsonObject,
    preview = false,
    published = false,
    triggerKey?: string,
    txArg?: Tx,
  ) {
    const create = async (tx: Tx) => {
      const workflow = await tx.workflow.findUniqueOrThrow({ where: { id: workflowId } });
      if (published && (!workflow.enabled || !workflow.publishedId))
        throw new Error('This workflow is not enabled.');
      const version = published
        ? await tx.workflowVersion.findUniqueOrThrow({ where: { id: workflow.publishedId! } })
        : null;
      const definition = WorkflowSchema.parse(version?.definition ?? workflow.draft);
      const issues = this.definitionIssues(definition, preview);
      if (issues.length) throw new Error(issues.map((i) => i.message).join(' '));
      if (triggerKey) {
        const existing = await tx.run.findUnique({ where: { triggerKey } });
        if (existing) return existing;
      }
      const run = await tx.run.create({
        data: { workflowId, versionId: version?.id, preview, triggerKey, input: json(input) },
      });
      await tx.runScope.create({
        data: { runId: run.id, key: 'root', definition: json(definition), input: json(input) },
      });
      await dispatch(tx, 'advance', { runId: run.id });
      await event(tx, run.id, 'run.queued', { preview });
      return run;
    };
    return txArg ? create(txArg) : this.db.$transaction(create);
  }
  async scheduledRun(workflowId: string, versionId: string, triggerKey: string) {
    return this.db.$transaction(async (tx) => {
      await lockRun(tx, workflowId);
      const workflow = await tx.workflow.findUnique({ where: { id: workflowId } });
      if (!workflow?.enabled || workflow.publishedId !== versionId) return null;
      const version = await tx.workflowVersion.findUniqueOrThrow({ where: { id: versionId } });
      if (
        !WorkflowSchema.parse(version.definition).nodes.some((n) => n.type === 'trigger.schedule')
      )
        return null;
      return this.createRun(
        workflowId,
        { scheduledAt: new Date().toISOString() },
        false,
        true,
        triggerKey,
        tx,
      );
    });
  }
  async advance(runId: string) {
    await this.db.$transaction(
      async (tx) => {
        await lockRun(tx, runId);
        const run = await tx.run.findUnique({ where: { id: runId } });
        if (!run || finished.includes(run.status)) return;
        if (run.status === 'queued')
          await tx.run.update({ where: { id: runId }, data: { status: 'running' } });
        const scopes = await tx.runScope.findMany({
          where: { runId },
          orderBy: { itemIndex: 'asc' },
        });
        for (const scope of scopes.filter((s) => s.status === 'running')) {
          const graph = WorkflowSchema.parse(scope.definition);
          const tasks = await tx.nodeExecution.findMany({ where: { runId, scope: scope.key } });
          for (const task of tasks.filter((t) => t.status === 'waiting' && t.reason === 'loop')) {
            const children = scopes.filter((s) => s.parentTaskId === task.id);
            if (children.length && children.every((s) => s.status === 'succeeded')) {
              const output = {
                items: children
                  .sort((a, b) => a.itemIndex - b.itemIndex)
                  .map((s) => s.output ?? {}),
              };
              await tx.nodeExecution.update({
                where: { id: task.id },
                data: {
                  status: 'succeeded',
                  output: json(output),
                  finishedAt: new Date(),
                  reason: null,
                },
              });
              await tx.nodeAttempt.updateMany({
                where: { taskId: task.id, status: 'waiting' },
                data: { status: 'succeeded', finishedAt: new Date() },
              });
              task.status = 'succeeded';
              task.output = output;
              await event(tx, runId, 'node.succeeded', { nodeId: task.nodeId, scope: scope.key });
            }
          }
          const failures = tasks.find((t) => ['failed', 'unknown'].includes(t.status));
          if (failures) {
            await tx.run.update({
              where: { id: runId },
              data: { status: failures.status, error: failures.error, finishedAt: new Date() },
            });
            const interrupted = await tx.nodeExecution.findMany({
              where: { runId, status: { in: ['pending', 'running'] } },
            });
            for (const task of interrupted) {
              const graph = WorkflowSchema.parse(
                scopes.find((s) => s.key === task.scope)!.definition,
              );
              const node = graph.nodes.find((n) => n.id === task.nodeId)!;
              const unknown = task.status === 'running' && !run.preview && !retrySafe(node);
              await tx.nodeExecution.update({
                where: { id: task.id },
                data: {
                  status: unknown ? 'unknown' : 'cancelled',
                  error: unknown
                    ? 'Another branch failed while this external operation was in flight. Inspect the destination before retrying.'
                    : null,
                  leaseUntil: null,
                  finishedAt: new Date(),
                },
              });
              await tx.nodeAttempt.updateMany({
                where: { taskId: task.id, status: 'running' },
                data: { status: unknown ? 'unknown' : 'cancelled', finishedAt: new Date() },
              });
            }
            await this.purgeAIDetails(tx, runId);
            await event(tx, runId, `run.${failures.status}`, { message: failures.error });
            return;
          }
          if (
            tasks.length === graph.nodes.length &&
            tasks.every((t) => ['succeeded', 'skipped'].includes(t.status))
          ) {
            const leaves = graph.nodes.filter((n) => !graph.edges.some((e) => e.source === n.id));
            const results = leaves
              .map((n) => tasks.find((t) => t.nodeId === n.id))
              .filter((t) => t?.status === 'succeeded')
              .map((t) => t!.output);
            await tx.runScope.update({
              where: { id: scope.id },
              data: {
                status: 'succeeded',
                output: json(results.length === 1 ? results[0] : { items: results }),
              },
            });
            if (scope.key === 'root') {
              await tx.run.update({
                where: { id: runId },
                data: { status: 'succeeded', finishedAt: new Date() },
              });
              await this.purgeAIDetails(tx, runId);
              await event(tx, runId, 'run.succeeded');
            } else await dispatch(tx, 'advance', { runId });
            continue;
          }
          const next = frontier(graph, tasks as ExecutionState[]);
          for (const nodeId of next.skipped) {
            await tx.nodeExecution.create({
              data: { runId, scope: scope.key, nodeId, status: 'skipped', finishedAt: new Date() },
            });
            await event(tx, runId, 'node.skipped', { nodeId, scope: scope.key });
          }
          for (const nodeId of next.ready) {
            const task = await tx.nodeExecution.create({
              data: { runId, scope: scope.key, nodeId },
            });
            await dispatch(tx, 'execute', { taskId: task.id });
          }
          if (next.skipped.length) await dispatch(tx, 'advance', { runId });
        }
        const root = await tx.runScope.findUnique({ where: { runId_key: { runId, key: 'root' } } });
        if (root?.status === 'running') {
          const active = await tx.nodeExecution.count({
            where: { runId, status: { in: ['pending', 'running'] } },
          });
          await tx.run.update({
            where: { id: runId },
            data: { status: active ? 'running' : 'waiting' },
          });
        }
      },
      { timeout: 20_000 },
    );
  }
  async execute(taskId: string) {
    const initial = await this.db.nodeExecution.findUnique({ where: { id: taskId } });
    if (!initial) return;
    const work = await this.db.$transaction(
      async (tx) => {
        await lockRun(tx, initial.runId);
        const run = await tx.run.findUniqueOrThrow({ where: { id: initial.runId } });
        const task = await tx.nodeExecution.findUniqueOrThrow({ where: { id: taskId } });
        if (finished.includes(run.status) || task.status !== 'pending') return null;
        const scope = await tx.runScope.findUniqueOrThrow({
          where: { runId_key: { runId: run.id, key: task.scope } },
        });
        const graph = WorkflowSchema.parse(scope.definition);
        const node = graph.nodes.find((n) => n.id === task.nodeId)!;
        const prior = await tx.nodeExecution.findMany({
          where: { runId: run.id, scope: task.scope, status: 'succeeded' },
        });
        const outputs = Object.fromEntries(prior.map((t) => [t.nodeId, t.output as JsonObject]));
        let input: JsonObject;
        try {
          input = node.type.startsWith('trigger.')
            ? (scope.input as JsonObject)
            : resolveInputs(node, scope.input as JsonObject, outputs);
        } catch (error) {
          const message = redact((error as Error).message);
          await tx.nodeExecution.update({
            where: { id: taskId },
            data: { status: 'failed', error: message },
          });
          await dispatch(tx, 'advance', { runId: run.id });
          return null;
        }
        const attempt = task.attempt + 1;
        await tx.nodeExecution.update({
          where: { id: taskId },
          data: {
            status: 'running',
            attempt,
            input: json(input),
            startedAt: new Date(),
            leaseUntil: new Date(Date.now() + 60_000),
            reason: null,
          },
        });
        await tx.nodeAttempt.create({ data: { taskId, number: attempt, status: 'running' } });
        await event(tx, run.id, 'node.running', { nodeId: node.id, scope: task.scope, attempt });
        const predecessors = graph.edges
          .filter((e) => {
            if (e.target !== node.id) return false;
            const state = prior.find((t) => t.nodeId === e.source);
            return (
              state &&
              (e.sourcePort === 'out' || (state.output as JsonObject)?._branch === e.sourcePort)
            );
          })
          .map((e) => prior.find((t) => t.nodeId === e.source)!.output as JsonObject);
        return { run, task, node, input, graph, attempt, predecessors };
      },
      { timeout: 20_000 },
    );
    if (!work) return;
    const { run, task, node, input, graph, attempt, predecessors } = work;
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.db.run
        .findUnique({ where: { id: run.id }, select: { status: true } })
        .then(async (current) => {
          if (!current || finished.includes(current.status)) controller.abort();
          else
            await this.db.nodeExecution.updateMany({
              where: { id: taskId, status: 'running', attempt },
              data: { leaseUntil: new Date(Date.now() + 60_000) },
            });
        })
        .catch(() => controller.abort());
    }, 10_000);
    try {
      if (
        node.type === 'logic.delay' ||
        node.type === 'logic.approval' ||
        node.type === 'logic.foreach'
      ) {
        await this.control(work);
        return;
      }
      const output = await this.operations.execute(node, input, {
        workspaceId: currentWorkspace(),
        key: taskId,
        runId: run.id,
        preview: run.preview,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(node.type.startsWith('ai.') ? 650_000 : 120_000),
        ]),
        timezone: graph.settings.timezone,
        ai: graph.settings.ai,
        predecessors,
      });
      if (Buffer.byteLength(JSON.stringify(output)) > Limits.fileBytes)
        throw new Error('Step output is larger than 20 MB. Split the input into smaller pieces.');
      await this.complete(taskId, run.id, node.id, attempt, output);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('The step failed.');
      const transient =
        err instanceof OperationError
          ? err.transient
          : /timeout|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(err.message);
      const unknown =
        !retrySafe(node) && (err instanceof OperationError ? err.outcomeUnknown : transient);
      const retry = transient && retrySafe(node) && attempt < 3;
      const message = redact(
        unknown
          ? 'Outcome unknown. Inspect the destination before deciding whether to try again.'
          : err.message,
      );
      await this.db.$transaction(async (tx) => {
        await lockRun(tx, run.id);
        const current = await tx.run.findUniqueOrThrow({ where: { id: run.id } });
        if (finished.includes(current.status)) return;
        const updated = await tx.nodeExecution.updateMany({
          where: { id: taskId, status: 'running', attempt },
          data: {
            status: unknown ? 'unknown' : retry ? 'waiting' : 'failed',
            reason: retry ? 'retry' : null,
            error: message,
            leaseUntil: null,
            wakeAt: retry
              ? new Date(
                  Date.now() +
                    Math.max(1000 * 2 ** (attempt - 1), (err as OperationError).retryAfterMs ?? 0),
                )
              : null,
            finishedAt: retry ? null : new Date(),
          },
        });
        if (!updated.count) return;
        await tx.nodeAttempt.update({
          where: { taskId_number: { taskId, number: attempt } },
          data: { status: unknown ? 'unknown' : 'failed', error: message, finishedAt: new Date() },
        });
        await event(
          tx,
          run.id,
          retry ? 'node.retrying' : unknown ? 'node.unknown' : 'node.failed',
          { nodeId: node.id, message },
        );
        await dispatch(tx, 'advance', { runId: run.id });
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async complete(
    taskId: string,
    runId: string,
    nodeId: string,
    attempt: number,
    output: JsonObject,
  ) {
    await this.db.$transaction(async (tx) => {
      await lockRun(tx, runId);
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
      if (finished.includes(run.status)) return;
      const updated = await tx.nodeExecution.updateMany({
        where: { id: taskId, status: 'running', attempt },
        data: {
          status: 'succeeded',
          output: json(output),
          error: null,
          leaseUntil: null,
          finishedAt: new Date(),
        },
      });
      if (!updated.count) return;
      const scope = await tx.runScope.findFirstOrThrow({
        where: {
          runId,
          key: (await tx.nodeExecution.findUniqueOrThrow({ where: { id: taskId } })).scope,
        },
      });
      const node = WorkflowSchema.parse(scope.definition).nodes.find((n) => n.id === nodeId);
      const settings = (await tx.workspace.findUnique({ where: { id: currentWorkspace() } }))
        ?.settings as JsonObject | undefined;
      if (node?.type.startsWith('ai.') && settings?.retainAIDetails !== true)
        await tx.nodeExecution.update({ where: { id: taskId }, data: { input: Prisma.DbNull } });
      await tx.nodeAttempt.update({
        where: { taskId_number: { taskId, number: attempt } },
        data: { status: 'succeeded', finishedAt: new Date() },
      });
      await event(tx, runId, 'node.succeeded', { nodeId });
      await dispatch(tx, 'advance', { runId });
    });
  }
  private async control(work: ControlWork) {
    const { run, task, node, input, attempt, graph } = work;
    if (run.preview && node.type !== 'logic.foreach')
      return this.complete(task.id, run.id, node.id, attempt, {
        simulated: true,
        ...(node.type === 'logic.approval'
          ? { approved: true }
          : { resumedAt: new Date().toISOString() }),
      });
    await this.db.$transaction(
      async (tx) => {
        await lockRun(tx, run.id);
        const current = await tx.run.findUniqueOrThrow({ where: { id: run.id } });
        if (finished.includes(current.status)) return;
        if (node.type === 'logic.foreach') {
          if (!Array.isArray(input.items) || input.items.length > graph.settings.maxItems)
            throw new Error(`Choose a list with at most ${graph.settings.maxItems} items.`);
          const body = WorkflowSchema.parse(node.config.body);
          if (!body.settings.ai && graph.settings.ai) body.settings.ai = graph.settings.ai;
          if (!input.items.length) {
            await tx.nodeExecution.update({
              where: { id: task.id },
              data: {
                status: 'succeeded',
                output: { items: [] },
                leaseUntil: null,
                finishedAt: new Date(),
              },
            });
          } else {
            for (const [index, item] of input.items.entries())
              await tx.runScope.upsert({
                where: { runId_key: { runId: run.id, key: `${task.id}-${index}` } },
                create: {
                  runId: run.id,
                  key: `${task.id}-${index}`,
                  definition: json(body),
                  input: json({ item, index }),
                  parentTaskId: task.id,
                  itemIndex: index,
                },
                update: {},
              });
            await tx.nodeExecution.update({
              where: { id: task.id },
              data: { status: 'waiting', reason: 'loop', leaseUntil: null },
            });
          }
        } else
          await tx.nodeExecution.update({
            where: { id: task.id },
            data: {
              status: 'waiting',
              reason: node.type === 'logic.delay' ? 'delay' : 'approval',
              wakeAt:
                node.type === 'logic.delay'
                  ? new Date(Date.now() + Number(node.config.seconds) * 1000)
                  : null,
              leaseUntil: null,
            },
          });
        const emptyList =
          node.type === 'logic.foreach' && Array.isArray(input.items) && !input.items.length;
        await tx.nodeAttempt.update({
          where: { taskId_number: { taskId: task.id, number: attempt } },
          data: { status: emptyList ? 'succeeded' : 'waiting', finishedAt: new Date() },
        });
        await event(tx, run.id, emptyList ? 'node.succeeded' : 'node.waiting', {
          nodeId: node.id,
          reason: node.type.slice(6),
          message: node.config.message ?? '',
        });
        await dispatch(tx, 'advance', { runId: run.id });
      },
      { timeout: 20_000 },
    );
  }
  async approve(runId: string, taskId: string, approve: boolean) {
    await this.db.$transaction(async (tx) => {
      await lockRun(tx, runId);
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
      if (finished.includes(run.status)) throw new Error('This run has already ended.');
      const task = await tx.nodeExecution.findUniqueOrThrow({ where: { id: taskId } });
      if (task.runId !== runId || task.status !== 'waiting' || task.reason !== 'approval')
        throw new Error('This step is not waiting for approval.');
      await tx.nodeExecution.update({
        where: { id: taskId },
        data: {
          status: approve ? 'succeeded' : 'failed',
          output: { approved: approve },
          error: approve ? null : 'Approval declined.',
          reason: null,
          finishedAt: new Date(),
        },
      });
      await tx.nodeAttempt.updateMany({
        where: { taskId, status: 'waiting' },
        data: { status: approve ? 'succeeded' : 'failed', finishedAt: new Date() },
      });
      await event(tx, runId, approve ? 'node.approved' : 'node.rejected', { nodeId: task.nodeId });
      await dispatch(tx, 'advance', { runId });
    });
  }
  async cancel(runId: string, txArg?: Tx, reason?: string) {
    const cancel = async (tx: Tx) => {
      await lockRun(tx, runId);
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
      if (finished.includes(run.status)) return;
      await tx.run.update({
        where: { id: runId },
        data: { status: 'cancelled', finishedAt: new Date(), ...(reason ? { error: reason } : {}) },
      });
      await tx.nodeExecution.updateMany({
        where: { runId, status: { in: ['pending', 'running', 'waiting'] } },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      await tx.nodeAttempt.updateMany({
        where: { task: { runId }, status: { in: ['running', 'waiting'] } },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      await this.purgeAIDetails(tx, runId);
      await event(tx, runId, 'run.cancelled', reason ? { reason } : {});
    };
    return txArg ? cancel(txArg) : this.db.$transaction(cancel);
  }
  private async purgeAIDetails(tx: Tx, runId: string) {
    const settings = (await tx.workspace.findUnique({ where: { id: currentWorkspace() } }))
      ?.settings as JsonObject | undefined;
    if (settings?.retainAIDetails === true) return;
    for (const scope of await tx.runScope.findMany({ where: { runId } })) {
      const ids = WorkflowSchema.parse(scope.definition)
        .nodes.filter((n) => n.type.startsWith('ai.'))
        .map((n) => n.id);
      if (ids.length)
        await tx.nodeExecution.updateMany({
          where: { runId, scope: scope.key, nodeId: { in: ids } },
          data: { input: Prisma.DbNull },
        });
    }
  }
  async retry(runId: string, taskId: string, confirmed: boolean) {
    await this.db.$transaction(async (tx) => {
      await lockRun(tx, runId);
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
      const task = await tx.nodeExecution.findUniqueOrThrow({ where: { id: taskId } });
      if (run.restoredAt)
        throw new Error('Restored runs are history only. Start a new run from the workflow.');
      if (
        task.runId !== runId ||
        !['failed', 'unknown'].includes(task.status) ||
        !['failed', 'unknown'].includes(run.status)
      )
        throw new Error('This step is not eligible for retry.');
      if (task.status === 'unknown' && !confirmed)
        throw new Error(
          'Confirm that you inspected the destination before retrying this operation.',
        );
      const cancelled = await tx.nodeExecution.findMany({ where: { runId, status: 'cancelled' } });
      for (const node of cancelled) {
        await tx.nodeExecution.update({
          where: { id: node.id },
          data: { status: 'pending', error: null, finishedAt: null },
        });
        await dispatch(tx, 'execute', { taskId: node.id });
      }
      await tx.nodeExecution.update({
        where: { id: taskId },
        data: { status: 'pending', error: null, finishedAt: null },
      });
      await tx.run.update({
        where: { id: runId },
        data: { status: 'running', error: null, finishedAt: null },
      });
      await dispatch(tx, 'execute', { taskId });
      await event(tx, runId, 'node.retried', { nodeId: task.nodeId });
    });
  }
  async recover() {
    if (Date.now() - (this.lastReconcile.get(currentWorkspace()) ?? 0) > 30_000) {
      this.lastReconcile.set(currentWorkspace(), Date.now());
      const epoch = Math.floor(Date.now() / 30_000);
      const runs = await this.db.run.findMany({
        where: { status: { in: ['queued', 'running', 'waiting'] } },
        select: { id: true },
        take: 1000,
      });
      for (const run of runs)
        await this.db.outbox.upsert({
          where: { id: `reconcile-run-${run.id}-${epoch}` },
          create: {
            id: `reconcile-run-${run.id}-${epoch}`,
            kind: 'advance',
            payload: { runId: run.id },
          },
          update: {},
        });
      const tasks = await this.db.nodeExecution.findMany({
        where: { status: 'pending', run: { status: { in: ['queued', 'running', 'waiting'] } } },
        select: { id: true },
        take: 1000,
      });
      for (const task of tasks)
        await this.db.outbox.upsert({
          where: { id: `reconcile-task-${task.id}-${epoch}` },
          create: {
            id: `reconcile-task-${task.id}-${epoch}`,
            kind: 'execute',
            payload: { taskId: task.id },
          },
          update: {},
        });
    }
    const due = await this.db.nodeExecution.findMany({
      where: {
        OR: [
          { status: 'waiting', reason: { in: ['delay', 'retry'] }, wakeAt: { lte: new Date() } },
          { status: 'running', leaseUntil: { lt: new Date() } },
        ],
      },
      take: 100,
    });
    for (const task of due)
      await this.db.$transaction(async (tx) => {
        await lockRun(tx, task.runId);
        const run = await tx.run.findUniqueOrThrow({ where: { id: task.runId } });
        if (finished.includes(run.status)) return;
        const current = await tx.nodeExecution.findUniqueOrThrow({ where: { id: task.id } });
        if (
          current.status !== task.status ||
          (current.leaseUntil && current.leaseUntil > new Date())
        )
          return;
        if (task.status === 'running') {
          const scope = await tx.runScope.findUniqueOrThrow({
            where: { runId_key: { runId: task.runId, key: task.scope } },
          });
          const node = WorkflowSchema.parse(scope.definition).nodes.find(
            (n) => n.id === task.nodeId,
          )!;
          const safe = retrySafe(node) || run.preview;
          await tx.nodeExecution.update({
            where: { id: task.id },
            data: {
              status: safe ? 'pending' : 'unknown',
              error: safe
                ? null
                : 'Outcome unknown after worker interruption. Inspect the destination before retrying.',
              leaseUntil: null,
            },
          });
          await tx.nodeAttempt.updateMany({
            where: { taskId: task.id, status: 'running' },
            data: { status: 'interrupted', finishedAt: new Date() },
          });
          if (safe) await dispatch(tx, 'execute', { taskId: task.id });
        } else if (task.reason === 'delay') {
          await tx.nodeExecution.update({
            where: { id: task.id },
            data: {
              status: 'succeeded',
              output: { resumedAt: new Date().toISOString() },
              reason: null,
              wakeAt: null,
              finishedAt: new Date(),
            },
          });
          await tx.nodeAttempt.updateMany({
            where: { taskId: task.id, status: 'waiting' },
            data: { status: 'succeeded', finishedAt: new Date() },
          });
        } else {
          await tx.nodeExecution.update({
            where: { id: task.id },
            data: { status: 'pending', reason: null, wakeAt: null },
          });
          await dispatch(tx, 'execute', { taskId: task.id });
        }
        await dispatch(tx, 'advance', { runId: task.runId });
      });
  }
}
