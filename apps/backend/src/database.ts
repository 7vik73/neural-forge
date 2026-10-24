import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { accessScope, scopedClient } from './scope.js';
export { Prisma };
export type Tx = Prisma.TransactionClient;
@Injectable()
export class Database extends PrismaClient implements OnModuleDestroy, OnModuleInit {
  declare readonly system: PrismaClient;
  constructor(@Optional() options?: Prisma.PrismaClientOptions) {
    super(options);
    return scopedClient(this, this);
  }
  withWorkspace<T>(
    workspaceId: string,
    work: () => T,
    options: { userId?: string; allowInactive?: boolean } = {},
  ) {
    return accessScope.run({ workspaceId, ...options }, work);
  }
  async onModuleInit() {
    const migrations = await this.$queryRaw<
      { migration_name: string }[]
    >`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
    if (
      migrations.map((m) => m.migration_name).join(',') !==
      '202610220001_initial,202610220002_shared_inbox,202610220003_workspaces,202610220004_restored_history,202610220005_shared_apps'
    )
      throw new Error(
        'This database schema is incompatible with this application. Use the matching version and the supported upgrade command.',
      );
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export async function event(tx: Tx, runId: string, type: string, data: unknown = {}) {
  await tx.executionEvent.create({ data: { runId, type, data: json(data) } });
}
export async function dispatch(tx: Tx, kind: string, payload: unknown, notBefore = new Date()) {
  await tx.outbox.create({ data: { kind, payload: json(payload), notBefore } });
}
