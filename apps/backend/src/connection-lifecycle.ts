import { Inject, Injectable } from '@nestjs/common';
import { WorkflowSchema, type JsonObject } from '@forge/contracts';
import { Database, json } from './database.js';
import { ExecutionEngine, lockRun } from './engine.js';
import { Connections } from './connections.js';
import { currentWorkspace } from './scope.js';
import { decrypt, encrypt } from './security.js';
import {
  configuredApps,
  disabledApps,
  groupedApps,
  googleAppScopes,
  usesConnection,
} from './connection-policy.js';

@Injectable()
export class ConnectionLifecycle {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ExecutionEngine) private readonly engine: ExecutionEngine,
    @Inject(Connections) private readonly connections: Connections,
  ) {}
  async disconnect(id: string, appId?: string) {
    return this.db.$transaction(
      async (tx) => {
        await lockRun(tx, `connection-lifecycle:${currentWorkspace()}`);
        const record = await tx.connection.findUniqueOrThrow({ where: { id } });
        const targetApp = groupedApps[record.kind] ? appId : undefined;
        const credentials = decrypt(record.secret);
        if (appId && groupedApps[record.kind]) {
          if (!configuredApps(record.kind, credentials).includes(appId))
            throw new Error('This app is not part of this connection.');
          await tx.connection.update({
            where: { id },
            data: {
              secret: encrypt({
                ...credentials,
                disabledApps: [...new Set([...disabledApps(record.kind, credentials), appId])].join(
                  ',',
                ),
              }),
            },
          });
        } else {
          if (appId && appId !== record.kind) throw new Error('Choose a matching app connection.');
          await tx.connection.delete({ where: { id } });
        }
        await tx.accountToken.updateMany({
          where: { workspaceId: currentWorkspace(), connectionId: id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        const reason = `${appId ?? record.name} was disconnected in this workspace. Review connections before enabling this workflow again.`;
        let pausedWorkflows = 0,
          cancelledRuns = 0;
        const workflows = await tx.workflow.findMany({
          where: { enabled: true },
          orderBy: { id: 'asc' },
        });
        for (const workflow of workflows) {
          if (!workflow.publishedId) continue;
          const version = await tx.workflowVersion.findUniqueOrThrow({
            where: { id: workflow.publishedId },
          });
          if (!usesConnection(WorkflowSchema.parse(version.definition), id, targetApp)) continue;
          await lockRun(tx, workflow.id);
          await tx.workflow.update({ where: { id: workflow.id }, data: { enabled: false } });
          const checkpoint = await tx.checkpoint.findUnique({ where: { workflowId: workflow.id } });
          await tx.checkpoint.upsert({
            where: { workflowId: workflow.id },
            create: { workflowId: workflow.id, value: { error: reason } },
            update: {
              value: json({ ...((checkpoint?.value as JsonObject) ?? {}), error: reason }),
            },
          });
          pausedWorkflows++;
        }
        const runs = await tx.run.findMany({
          where: { status: { in: ['queued', 'running', 'waiting'] } },
          include: { scopes: { where: { key: 'root' } } },
          orderBy: { id: 'asc' },
        });
        for (const run of runs) {
          if (
            !run.scopes.some((scope) =>
              usesConnection(WorkflowSchema.parse(scope.definition), id, targetApp),
            )
          )
            continue;
          await this.engine.cancel(run.id, tx, reason);
          cancelledRuns++;
        }
        return { ok: true, pausedWorkflows, cancelledRuns };
      },
      { timeout: 30000 },
    );
  }
  async reconnectApp(id: string, appId: string) {
    const record = await this.connections.get(id);
    if (
      !groupedApps[record.kind]?.includes(appId) ||
      !configuredApps(record.kind, record.credentials).includes(appId)
    )
      throw new Error('Authorize this app through a new connection first.');
    if (record.kind === 'google') {
      const auth = await this.connections.google(id);
      const access = (await auth.getAccessToken()).token;
      if (!access) throw new Error('Reconnect the Google account first.');
      const info = await auth.getTokenInfo(access);
      if (googleAppScopes[appId]!.some((scope) => !info.scopes.includes(scope))) {
        await this.db.connection.updateMany({
          where: { id, secret: record.secret },
          data: { status: 'reconnect' },
        });
        throw new Error(
          'Reconnect the Google account and grant the selected app permissions first.',
        );
      }
    } else {
      // Refresh and validate the shared Microsoft token without using a disabled app operation.
      await this.connections.test(id);
    }
    return this.db.$transaction(async (tx) => {
      await lockRun(tx, `connection-lifecycle:${currentWorkspace()}`);
      const current = await tx.connection.findUniqueOrThrow({ where: { id } });
      if (current.kind !== record.kind)
        throw new Error('This connection changed. Reload before connecting.');
      const credentials = decrypt(current.secret);
      if (!configuredApps(current.kind, credentials).includes(appId))
        throw new Error('This app is no longer authorized.');
      await tx.connection.update({
        where: { id },
        data: {
          secret: encrypt({
            ...credentials,
            disabledApps: disabledApps(current.kind, credentials)
              .filter((app) => app !== appId)
              .join(','),
          }),
          status: 'connected',
        },
      });
      return {
        ok: true,
        message: `${appId} is connected. Review and enable paused workflows when ready.`,
      };
    });
  }
}
