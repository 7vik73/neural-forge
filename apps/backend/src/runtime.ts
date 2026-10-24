import { Inject, Injectable } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { CronExpressionParser } from 'cron-parser';
import { WorkflowSchema, type JsonObject } from '@forge/contracts';
import { Database } from './database.js';
import { ExecutionEngine } from './engine.js';
import { Polling } from './polling.js';
import { Workspaces } from './workspaces.js';
import { config } from './config.js';
import { redact } from './security.js';

export function redisOptions() {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: Number(url.pathname.slice(1) || 0),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    maxRetriesPerRequest: null,
  };
}
@Injectable()
export class Runtime {
  private readonly heartbeatRedis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  private queue?: Queue;
  private worker?: Worker;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastPoll = 0;
  private lastMaintenance = 0;
  private startedAt = Date.now();
  private pollingJob: Promise<void> | null = null;
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ExecutionEngine) private readonly engine: ExecutionEngine,
    @Inject(Polling) private readonly polling: Polling,
    @Inject(Workspaces) private readonly workspaces: Workspaces,
  ) {}

  // Only persisted records determine the execution's workspace; payload ownership is checked, never trusted.
  async handleJob(name: string, payload: Record<string, any>, jobId?: string) {
    const record =
      name === 'execute'
        ? await this.db.system.nodeExecution.findUnique({ where: { id: String(payload.taskId) } })
        : name === 'schedule'
          ? await this.db.system.workflow.findUnique({ where: { id: String(payload.workflowId) } })
          : await this.db.system.run.findUnique({ where: { id: String(payload.runId) } });
    if (!record) return;
    if (payload.workspaceId && payload.workspaceId !== record.workspaceId)
      throw new Error('Queue workspace does not match the persisted execution.');
    const workspace = await this.db.workspace.findFirst({
      where: { id: record.workspaceId, deletedAt: null, owner: { status: 'active' } },
    });
    if (!workspace) return;
    return this.db.withWorkspace(workspace.id, async () => {
      if (name === 'execute') await this.engine.execute(String(payload.taskId));
      else if (name === 'advance') await this.engine.advance(String(payload.runId));
      else if (name === 'schedule') {
        const due = Number(jobId?.split(':').at(-1));
        if (Number.isFinite(due) && due < this.startedAt - 1000) return;
        await this.engine.scheduledRun(
          String(payload.workflowId),
          String(payload.versionId),
          `schedule-${jobId}`,
        );
      }
    });
  }
  async start() {
    this.queue = new Queue('forge-execution', {
      connection: redisOptions(),
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 86400, count: 5000 },
      },
    });
    await this.queue.setGlobalConcurrency(4);
    this.worker = new Worker(
      'forge-execution',
      (job) => this.handleJob(job.name, job.data, job.id),
      { connection: redisOptions(), concurrency: 4, lockDuration: 60_000 },
    );
    this.worker.on('error', (error) => console.error('Worker:', redact(error.message)));
    this.worker.on('failed', (job, error) =>
      console.error('Job failed:', job?.name, redact(error.message)),
    );
    await this.reconcile();
    this.timer = setInterval(() => void this.tick(), 1000);
    await this.tick();
  }
  private async tick() {
    if (this.busy || !this.queue) return;
    this.busy = true;
    try {
      await this.heartbeatRedis.set('forge:worker-heartbeat', String(Date.now()), 'PX', 15_000);
      const active = await this.db.workspace.findMany({
        where: { deletedAt: null, owner: { status: 'active' } },
      });
      const records = await this.db.system.outbox.findMany({
        where: {
          sentAt: null,
          notBefore: { lte: new Date() },
          workspaceId: { in: active.map((w) => w.id) },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      for (const record of records) {
        await this.queue.add(
          record.kind,
          { ...(record.payload as JsonObject), workspaceId: record.workspaceId },
          { jobId: record.id, attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
        );
        await this.db.system.outbox.update({
          where: { id: record.id },
          data: { sentAt: new Date() },
        });
      }
      for (const workspace of active)
        await this.db.withWorkspace(workspace.id, () => this.engine.recover());
      if (Date.now() - this.lastPoll > 30_000) {
        this.lastPoll = Date.now();
        await this.reconcile();
        if (!this.pollingJob)
          this.pollingJob = (async () => {
            for (const workspace of active)
              await this.db
                .withWorkspace(workspace.id, () => this.polling.tick())
                .catch((error) => console.error('Polling:', redact(error.message)));
          })().finally(() => {
            this.pollingJob = null;
          });
      }
      if (Date.now() - this.lastMaintenance > 3_600_000) {
        this.lastMaintenance = Date.now();
        await this.workspaces.maintenance();
        for (const workspace of active)
          await this.db
            .withWorkspace(workspace.id, async () => {
              const retention = Number((workspace.settings as JsonObject).retentionDays ?? 30);
              const expired = await this.db.run.findMany({
                where: {
                  status: { in: ['succeeded', 'failed', 'cancelled'] },
                  finishedAt: { lt: new Date(Date.now() - retention * 86400_000) },
                },
                select: { id: true },
                take: 1000,
              });
              const ids = expired.map((r) => r.id);
              if (ids.length)
                await this.db.$transaction(async (tx) => {
                  await tx.artifact.deleteMany({ where: { runId: { in: ids } } });
                  await tx.run.deleteMany({ where: { id: { in: ids } } });
                });
              await this.db.aIUsage.deleteMany({
                where: { createdAt: { lt: new Date(Date.now() - retention * 86400_000) } },
              });
              await this.db.outbox.deleteMany({
                where: { sentAt: { lt: new Date(Date.now() - 86400_000) } },
              });
            })
            .catch((error) => console.error('Retention:', redact(error.message)));
        await this.db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      }
    } catch (error) {
      console.error('Runtime:', redact((error as Error).message));
    } finally {
      this.busy = false;
    }
  }
  async reconcile() {
    if (!this.queue) return;
    const workflows = await this.db.system.workflow.findMany({
      where: {
        enabled: true,
        publishedId: { not: null },
        workspace: { deletedAt: null, owner: { status: 'active' } },
      },
    });
    const active = new Set<string>();
    for (const workflow of workflows) {
      const version = await this.db.system.workflowVersion.findFirst({
        where: {
          id: workflow.publishedId!,
          workspaceId: workflow.workspaceId,
          workflowId: workflow.id,
        },
      });
      if (!version) continue;
      const graph = WorkflowSchema.parse(version.definition),
        trigger = graph.nodes.find((n) => n.type.startsWith('trigger.'))!;
      if (trigger.type !== 'trigger.schedule') continue;
      const id = `workflow-${workflow.id}-${version.id}`;
      active.add(id);
      const tz = String(trigger.config.timezone ?? graph.settings.timezone),
        pattern = String(trigger.config.cron);
      const next = CronExpressionParser.parse(pattern, { tz }).next().getTime();
      await this.queue.upsertJobScheduler(
        id,
        { pattern, tz, startDate: next },
        {
          name: 'schedule',
          data: {
            workflowId: workflow.id,
            versionId: version.id,
            workspaceId: workflow.workspaceId,
          },
        },
      );
    }
    for (const scheduler of await this.queue.getJobSchedulers())
      if (!active.has(scheduler.key)) await this.queue.removeJobScheduler(scheduler.key);
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
    this.heartbeatRedis.disconnect();
  }
}
